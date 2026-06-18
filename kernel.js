import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createEnvironment, execute } from "jslike";
import { split } from "shlex";

export const PROJECT_FILES = [
  "/package.json",
  "/manifest.json",
  "/bin/dietsurf-node.js",
  "/etc/llm.json",
  "/etc/browser.json",
  "/etc/profile",
  "/src/agent.js",
  "/src/runtime/chrome-puppeteer.js",
  "/src/ui.css",
  "/var/log/history.jsonl",
  "/home/user/notes.md"
];

export function toErrorText(error) {
  return error && error.stack ? error.stack : String(error);
}

export function absPath(path, cwd = "/") {
  if (!path || path === ".") return cwd || "/";
  const raw = path.startsWith("/") ? path : `${cwd.replace(/\/$/, "")}/${path}`;
  const parts = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function dirOf(path) {
  const clean = absPath(path);
  const idx = clean.lastIndexOf("/");
  return idx <= 0 ? "/" : clean.slice(0, idx);
}

function makeEnv(runtime) {
  const env = createEnvironment();
  const globals = {
    runtime,
    argv: runtime.argv || [],
    chrome: runtime.chrome,
    llm: runtime.llm,
    shell: runtime.shell,
    node: runtime.node,
    readFile: runtime.readFile,
    writeFile: runtime.writeFile,
    listFiles: runtime.listFiles,
    sleep: runtime.sleep,
    log: runtime.log,
    done: runtime.done
  };
  for (const [key, value] of Object.entries(globals)) {
    if (value !== undefined) env.define(key, value);
  }
  return env;
}

function resolverFor(runtime) {
  return {
    async resolve(modulePath, fromPath = "/src/agent.js") {
      if (!modulePath.startsWith(".") && !modulePath.startsWith("/")) return null;
      const base = modulePath.startsWith("/") ? "/" : dirOf(fromPath);
      let path = absPath(modulePath, base);
      if (!/\.[cm]?[jt]sx?$/.test(path)) path += ".js";
      return { path, code: await runtime.readFile(path) };
    }
  };
}

export async function runSource(runtime, source, sourcePath = "/tmp/stdin.js") {
  return execute(source, makeEnv(runtime), {
    sourcePath,
    moduleResolver: resolverFor(runtime)
  });
}

export async function loadModule(runtime, path) {
  const source = await runtime.readFile(path);
  return runSource(runtime, source, path);
}

export async function runFile(runtime, path, argv = []) {
  const nextRuntime = { ...runtime, argv };
  const mod = await loadModule(nextRuntime, path);
  if (mod && typeof mod.main === "function") return mod.main(nextRuntime, argv);
  return mod;
}

function isDone(error) {
  return error && error.__dietsurfDone;
}

function heredoc(lines, start) {
  const line = lines[start];
  const match = line.match(/^(.*?)<<['"]?([A-Za-z0-9_.-]+)['"]?\s*$/);
  if (!match) return null;
  const body = [];
  let i = start + 1;
  for (; i < lines.length; i++) {
    if (lines[i] === match[2]) break;
    body.push(lines[i]);
  }
  if (i >= lines.length) throw new Error(`unterminated heredoc ${match[2]}`);
  return { head: match[1].trim(), body: body.join("\n"), next: i + 1 };
}

function formatLs(paths, dir, recursive) {
  const prefix = dir === "/" ? "/" : `${dir.replace(/\/$/, "")}/`;
  const out = new Set();
  for (const path of paths.sort()) {
    if (path === dir) continue;
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (!rest) continue;
    if (recursive) out.add(path);
    else out.add(rest.split("/")[0] + (rest.includes("/") ? "/" : ""));
  }
  return [...out].join("\n");
}

export function createShell(runtime) {
  let cwd = "/";

  async function execArgv(argv) {
    const cmd = argv[0];
    if (!cmd) return "";
    if (cmd === "pwd") return cwd;
    if (cmd === "cd") {
      cwd = absPath(argv[1] || "/", cwd);
      return "";
    }
    if (cmd === "cat") return runtime.readFile(absPath(argv[1], cwd));
    if (cmd === "ls") {
      const recursive = argv.includes("-R");
      const target = argv.find((arg, i) => i > 0 && arg !== "-R") || ".";
      return formatLs(await runtime.listFiles(absPath(target, cwd)), absPath(target, cwd), recursive);
    }
    if (cmd === "touch") {
      await runtime.writeFile(absPath(argv[1], cwd), "");
      return "";
    }
    if (cmd === "rm") {
      await runtime.removeFile(absPath(argv[1], cwd));
      return "";
    }
    if (cmd === "mkdir") return "";
    if (cmd === "cp") {
      await runtime.writeFile(absPath(argv[2], cwd), await runtime.readFile(absPath(argv[1], cwd)));
      return "";
    }
    if (cmd === "mv") {
      const from = absPath(argv[1], cwd);
      const to = absPath(argv[2], cwd);
      await runtime.writeFile(to, await runtime.readFile(from));
      await runtime.removeFile(from);
      return "";
    }
    if (cmd === "echo") return argv.slice(1).join(" ");
    if (cmd === "node") return runFile(runtime, absPath(argv[1], cwd), argv.slice(2));
    if (cmd === "jobs") return "";
    if (cmd === "kill") return "";
    throw new Error(`unknown command: ${cmd}`);
  }

  return async function shell(script) {
    const lines = String(script).replace(/\r\n/g, "\n").split("\n");
    const output = [];
    for (let i = 0; i < lines.length;) {
      const line = lines[i].trim();
      if (!line || line.startsWith("#")) {
        i++;
        continue;
      }
      const doc = heredoc(lines, i);
      if (doc) {
        const argv = split(doc.head);
        if (argv[0] === "cat" && (argv[1] === ">" || argv[1] === ">>")) {
          const path = absPath(argv[2], cwd);
          const prior = argv[1] === ">>" ? await runtime.readFile(path).catch(() => "") : "";
          await runtime.writeFile(path, prior + doc.body);
        } else if (argv[0] === "node") {
          const result = await runSource(runtime, doc.body, "/tmp/stdin.js");
          if (result !== undefined) output.push(String(result));
        } else {
          throw new Error(`unsupported heredoc command: ${doc.head}`);
        }
        i = doc.next;
        continue;
      }
      const result = await execArgv(split(line));
      if (result !== undefined && result !== "") output.push(String(result));
      i++;
    }
    return output.join("\n");
  };
}

export function createRuntime(base) {
  const runtime = {
    argv: [],
    chrome: base.chrome,
    readFile: base.readFile,
    writeFile: base.writeFile,
    listFiles: base.listFiles,
    removeFile: base.removeFile,
    env: base.env || {},
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: base.log || console.log
  };
  runtime.llm = async function llm(input) {
    const { baseUrl, apiKey, apiKeyEnv, model } = JSON.parse(await runtime.readFile("/etc/llm.json"));
    const key = apiKey || runtime.env[apiKeyEnv];
    if (!key) throw new Error(`missing /etc/llm.json apiKey${apiKeyEnv ? ` or ${apiKeyEnv}` : ""}`);
    const provider = createOpenAICompatible({ name: "byok", apiKey: key, baseURL: baseUrl });
    const messages = Array.isArray(input) ? input : [{ role: "user", content: String(input) }];
    const { text } = await generateText({ model: provider(model), messages, temperature: 0 });
    return text.trim();
  };
  runtime.done = (value = "") => {
    const error = new Error("done");
    error.__dietsurfDone = true;
    error.value = value;
    throw error;
  };
  runtime.node = (code, argv = []) => runSource({ ...runtime, argv }, code, "/tmp/stdin.js");
  runtime.shell = createShell(runtime);
  runtime.runFile = async (path, argv = []) => {
    try {
      return await runFile({ ...runtime, argv }, path, argv);
    } catch (error) {
      if (isDone(error)) return error.value;
      throw error;
    }
  };
  return runtime;
}
