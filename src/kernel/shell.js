import { split } from "shlex";
import { absPath, baseName, wildcardRegex } from "./path.js";
import { runFile, runSource } from "./jslike.js";

function findHeredoc(line) {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === quote && line[i - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char !== "<" || line[i + 1] !== "<") continue;

    let j = i + 2;
    while (/\s/.test(line[j] || "")) j++;
    if (!line[j]) throw new Error("missing heredoc delimiter");

    let delimiter = "";
    if (line[j] === "'" || line[j] === '"') {
      const delimQuote = line[j++];
      const start = j;
      while (j < line.length && !(line[j] === delimQuote && line[j - 1] !== "\\")) j++;
      if (j >= line.length) throw new Error("unterminated heredoc delimiter");
      delimiter = line.slice(start, j);
      j++;
    } else {
      const start = j;
      while (j < line.length && !/\s/.test(line[j])) j++;
      delimiter = line.slice(start, j);
    }
    if (!delimiter) throw new Error("missing heredoc delimiter");

    const before = line.slice(0, i).trim();
    const after = line.slice(j).trim();
    return {
      head: [before, after].filter(Boolean).join(" "),
      delimiter
    };
  }
  return null;
}

function heredoc(lines, start) {
  const line = lines[start];
  const match = findHeredoc(line);
  if (!match) return null;
  const body = [];
  let i = start + 1;
  for (; i < lines.length; i++) {
    if (lines[i] === match.delimiter) break;
    body.push(lines[i]);
  }
  if (i >= lines.length) throw new Error(`unterminated heredoc ${match.delimiter}`);
  return { head: match.head, body: body.join("\n"), next: i + 1 };
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

const BUILTIN_COMMANDS = new Set([
  "cat", "ls", "pwd", "cd", "touch", "rm", "mkdir", "cp", "mv", "echo",
  "printf", "sed", "node", "clear", "reset", "jobs", "kill", "which", "grep",
  "head", "find", "env", "printenv", "uname", "git"
]);

function splitOperator(line, operator) {
  const out = [];
  let quote = "";
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === quote && line[i - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (operator === "|" && line[i] === "|" && line[i + 1] === "|") {
      i++;
      continue;
    }
    if (line.slice(i, i + operator.length) === operator) {
      out.push(line.slice(start, i).trim());
      i += operator.length - 1;
      start = i + 1;
    }
  }
  out.push(line.slice(start).trim());
  return out.filter(Boolean);
}

function parseRedirects(argv) {
  const clean = [];
  let stdout = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "2>/dev/null" || arg === "2>&1") continue;
    if (arg === "2>" && argv[i + 1] === "/dev/null") {
      i++;
      continue;
    }
    if (arg === ">" || arg === ">>") {
      stdout = { append: arg === ">>", path: argv[++i] };
      continue;
    }
    if (arg.startsWith(">>")) {
      stdout = { append: true, path: arg.slice(2) };
      continue;
    }
    if (arg.startsWith(">")) {
      stdout = { append: false, path: arg.slice(1) };
      continue;
    }
    clean.push(arg);
  }
  return { argv: clean, stdout };
}

function expandEnv(arg, env) {
  return String(arg).replace(/\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, bare, braced) => {
    const key = bare || braced;
    return env[key] ?? "";
  });
}

function decodePrintf(value) {
  return String(value).replace(/\\([nrtbfv\\])/g, (_match, char) => ({
    n: "\n",
    r: "\r",
    t: "\t",
    b: "\b",
    f: "\f",
    v: "\v",
    "\\": "\\"
  })[char]);
}

function formatPrintf(format, args) {
  let index = 0;
  let out = "";
  const source = decodePrintf(format || "");
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "%" || i === source.length - 1) {
      out += source[i];
      continue;
    }
    const spec = source[++i];
    if (spec === "%") {
      out += "%";
      continue;
    }
    const value = args[index++] ?? "";
    if (spec === "s") out += String(value);
    else if (spec === "d" || spec === "i") out += String(Number.parseInt(value, 10) || 0);
    else if (spec === "f") out += String(Number.parseFloat(value) || 0);
    else if (spec === "j") out += JSON.stringify(value);
    else out += `%${spec}`;
  }
  return out;
}

function splitSedCommands(script) {
  const commands = [];
  let current = "";
  let escaped = false;
  for (const char of String(script)) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === ";") {
      if (current.trim()) commands.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) commands.push(current.trim());
  return commands;
}

function readSedPart(command, start, delimiter) {
  let out = "";
  let i = start;
  for (; i < command.length; i++) {
    const char = command[i];
    if (char === "\\" && command[i + 1] === delimiter) {
      out += delimiter;
      i++;
      continue;
    }
    if (char === delimiter) break;
    out += char;
  }
  if (i >= command.length) throw new Error(`invalid sed substitution: ${command}`);
  return { value: out, next: i + 1 };
}

function applySed(text, script) {
  let out = String(text);
  for (const command of splitSedCommands(script)) {
    if (!command.startsWith("s") || command.length < 3) throw new Error(`unsupported sed command: ${command}`);
    const delimiter = command[1];
    const pattern = readSedPart(command, 2, delimiter);
    const replacement = readSedPart(command, pattern.next, delimiter);
    const flags = command.slice(replacement.next);
    const regexFlags = `${flags.includes("g") ? "g" : ""}${flags.includes("i") ? "i" : ""}`;
    const regex = new RegExp(pattern.value, regexFlags);
    out = out.replace(regex, () => replacement.value);
  }
  return out;
}

function splitConditionals(line) {
  const out = [];
  let quote = "";
  let start = 0;
  let op = "";
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === quote && line[i - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    const next = line.slice(i, i + 2);
    if (next === "&&" || next === "||") {
      out.push({ op, line: line.slice(start, i).trim() });
      op = next;
      i++;
      start = i + 1;
    }
  }
  out.push({ op, line: line.slice(start).trim() });
  return out.filter((part) => part.line);
}

export function createShell(runtime) {
  let cwd = "/";

  function checkAbort() {
    runtime.throwIfAborted?.();
  }

  async function allPaths() {
    return runtime.listFiles("/");
  }

  async function expandPaths(pattern) {
    checkAbort();
    const target = absPath(pattern, cwd);
    if (!target.includes("*") && !target.includes("?")) return [target];
    const match = wildcardRegex(target);
    return (await allPaths()).filter((path) => match.test(path)).sort();
  }

  async function readInputs(args, input) {
    checkAbort();
    if (args.length === 0) return input ?? "";
    const out = [];
    for (const arg of args) {
      checkAbort();
      for (const path of await expandPaths(arg)) out.push(await runtime.readFile(path));
    }
    return out.join("\n");
  }

  function filterLines(input, pattern, ignoreCase) {
    const needle = ignoreCase ? pattern.toLowerCase() : pattern;
    return String(input || "").split("\n").filter((line) => {
      const haystack = ignoreCase ? line.toLowerCase() : line;
      return haystack.includes(needle);
    }).join("\n");
  }

  function formatLogItem(value) {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.message;
    return JSON.stringify(value);
  }

  async function runInline(source, argv = []) {
    checkAbort();
    const output = [];
    const log = (...items) => output.push(items.map(formatLogItem).join(" "));
    const nextRuntime = {
      ...runtime,
      argv,
      log,
      console: { log, warn: log, error: log },
      throwIfAborted: checkAbort
    };
    try {
      await runSource(nextRuntime, source, "/tmp/stdin.js");
      checkAbort();
    } catch (error) {
      if (error && error.__dietsurfDone) output.push(String(error.value ?? ""));
      else throw error;
    }
    return output.filter((line) => line !== "").join("\n");
  }

  async function execArgv(argv, input) {
    checkAbort();
    const cmd = argv[0];
    if (!cmd) return "";
    if (cmd === "git") {
      if (!runtime.git) throw new Error("git is not available");
      return runtime.git(argv.slice(1), { cwd });
    }
    if (cmd === "pwd") return cwd;
    if (cmd === "cd") {
      cwd = absPath(argv[1] || "/", cwd);
      return "";
    }
    if (cmd === "cat") return readInputs(argv.slice(1), input);
    if (cmd === "ls") {
      const flags = argv.filter((arg, i) => i > 0 && arg.startsWith("-")).join("");
      const recursive = flags.includes("R");
      const targets = argv.filter((arg, i) => i > 0 && !arg.startsWith("-"));
      const target = targets[0] || ".";
      const paths = await expandPaths(target);
      if (target.includes("*") || target.includes("?")) return paths.join("\n");
      return formatLs(await runtime.listFiles(paths[0]), paths[0], recursive);
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
    if (cmd === "printf") {
      const format = argv[1] || "";
      const args = argv.slice(2);
      if (!args.length) return decodePrintf(format);
      return formatPrintf(format, args);
    }
    if (cmd === "sed") {
      let inPlace = false;
      const rest = [];
      for (const arg of argv.slice(1)) {
        if (arg === "-i") inPlace = true;
        else if (arg.startsWith("-i") && arg.length > 2) inPlace = true;
        else if (arg.startsWith("-")) throw new Error(`unsupported sed option: ${arg}`);
        else rest.push(arg);
      }
      const script = rest.shift();
      if (!script) throw new Error("missing sed script");
      if (inPlace) {
        if (!rest.length) throw new Error("sed -i requires a file");
        for (const target of rest) {
          for (const path of await expandPaths(target)) {
            await runtime.writeFile(path, applySed(await runtime.readFile(path), script));
          }
        }
        return "";
      }
      return applySed(await readInputs(rest, input), script);
    }
    if (cmd === "env") {
      return Object.entries(runtime.env || {}).map(([key, value]) => `${key}=${value}`).sort().join("\n");
    }
    if (cmd === "printenv") {
      if (argv[1]) return runtime.env?.[argv[1]] || "";
      return Object.entries(runtime.env || {}).map(([key, value]) => `${key}=${value}`).sort().join("\n");
    }
    if (cmd === "uname") {
      if (argv.includes("-s")) {
        if (runtime.process.platform === "darwin") return "Darwin";
        if (runtime.process.platform === "win32") return "Windows";
        return "Linux";
      }
      return runtime.process.platform || "";
    }
    if (cmd === "node") {
      if (argv[1] === "--version" || argv[1] === "-v") {
        return runtime.process.version || (runtime.process.versions?.node ? `v${runtime.process.versions.node}` : "");
      }
      if (argv[1] === "-e" || argv[1] === "--eval") return runInline(argv[2] || "", argv.slice(3));
      if (argv[1] === "-p" || argv[1] === "--print") return runInline(`console.log(${argv[2] || ""})`, argv.slice(3));
      return runFile(runtime, absPath(argv[1], cwd), argv.slice(2));
    }
    if (cmd === "which") {
      const found = argv.slice(1).filter((name) => BUILTIN_COMMANDS.has(name)).map((name) => `/bin/${name}`);
      if (!found.length) throw new Error(`not found: ${argv.slice(1).join(" ")}`);
      return found.join("\n");
    }
    if (cmd === "grep") {
      let ignoreCase = false;
      const rest = [];
      for (const arg of argv.slice(1)) {
        if (arg === "-i") ignoreCase = true;
        else rest.push(arg);
      }
      const pattern = rest.shift() || "";
      return filterLines(await readInputs(rest, input), pattern, ignoreCase);
    }
    if (cmd === "head") {
      let count = 10;
      const rest = [];
      for (let i = 1; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "-n") count = Number(argv[++i] || count);
        else if (/^-\d+$/.test(arg)) count = Number(arg.slice(1));
        else rest.push(arg);
      }
      return (await readInputs(rest, input)).split("\n").slice(0, count).join("\n");
    }
    if (cmd === "find") {
      const root = argv[1] && !argv[1].startsWith("-") ? argv[1] : ".";
      const nameIndex = argv.indexOf("-name");
      const pattern = nameIndex >= 0 ? argv[nameIndex + 1] : "";
      const paths = await runtime.listFiles(absPath(root, cwd));
      if (!pattern) return paths.join("\n");
      const match = wildcardRegex(pattern);
      return paths.filter((path) => match.test(baseName(path))).sort().join("\n");
    }
    if (cmd === "clear") {
      await runtime.clearHistory?.();
      return "";
    }
    if (cmd === "reset") {
      if (!runtime.resetProject) throw new Error("reset is not available");
      await runtime.resetProject();
      return "reset virtual project";
    }
    if (cmd === "jobs") return "";
    if (cmd === "kill") return "";
    throw new Error(`unknown command: ${cmd}`);
  }

  async function executePipeline(line) {
    checkAbort();
    let input;
    let redirect = null;
    for (const part of splitOperator(line, "|")) {
      checkAbort();
      const parsed = parseRedirects(split(part).map((arg) => expandEnv(arg, runtime.env || {})));
      redirect = parsed.stdout || redirect;
      input = await execArgv(parsed.argv, input);
    }
    if (redirect?.path) {
      const path = absPath(redirect.path, cwd);
      const prior = redirect.append ? await runtime.readFile(path).catch(() => "") : "";
      await runtime.writeFile(path, prior + (input || ""));
      return "";
    }
    return input;
  }

  async function executeLine(line) {
    checkAbort();
    const groups = splitConditionals(line);
    const output = [];
    let lastOk = true;
    let lastError;
    for (const group of groups) {
      checkAbort();
      if (group.op === "&&" && !lastOk) continue;
      if (group.op === "||" && lastOk) continue;
      try {
        const result = await executePipeline(group.line);
        lastOk = true;
        lastError = undefined;
        if (result !== undefined && result !== "") output.push(String(result));
      } catch (error) {
        lastOk = false;
        lastError = error;
      }
    }
    if (!lastOk) throw lastError;
    return output.join("\n");
  }

  return async function shell(script) {
    const lines = String(script).replace(/\r\n/g, "\n").split("\n");
    const output = [];
    for (let i = 0; i < lines.length;) {
      checkAbort();
      const line = lines[i].trim();
      if (!line || line.startsWith("#")) {
        i++;
        continue;
      }
      const doc = heredoc(lines, i);
      if (doc) {
        const parsed = parseRedirects(split(doc.head).map((arg) => expandEnv(arg, runtime.env || {})));
        if (parsed.argv[0] === "cat") {
          if (parsed.stdout?.path) {
            const path = absPath(parsed.stdout.path, cwd);
            const prior = parsed.stdout.append ? await runtime.readFile(path).catch(() => "") : "";
            await runtime.writeFile(path, prior + doc.body);
          } else {
            output.push(doc.body);
          }
        } else if (parsed.argv[0] === "node") {
          const result = await runInline(doc.body, parsed.argv.slice(1));
          if (parsed.stdout?.path) {
            const path = absPath(parsed.stdout.path, cwd);
            const prior = parsed.stdout.append ? await runtime.readFile(path).catch(() => "") : "";
            await runtime.writeFile(path, prior + (result || ""));
          } else if (result !== undefined) output.push(String(result));
        } else {
          throw new Error(`unsupported heredoc command: ${doc.head}`);
        }
        i = doc.next;
        continue;
      }
      const result = await executeLine(line);
      if (result !== undefined && result !== "") output.push(String(result));
      i++;
    }
    return output.join("\n");
  };
}
