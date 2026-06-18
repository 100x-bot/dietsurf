import git from "isomorphic-git";
import LightningFS from "@isomorphic-git/lightning-fs";
import { Buffer } from "buffer";
import { createTwoFilesPatch } from "diff";
import { PROJECT_FILES, absPath, createRuntime, loadModule, toErrorText } from "./kernel.js";

const FS_NAME = "dietsurf-git";
const REPO_DIR = "/repo";
const WORKSPACES = ["main", "staging"];
const AUTHOR = { name: "DietSurf", email: "agent@dietsurf.local" };

const fs = new LightningFS(FS_NAME);
const pfs = fs.promises;
const activeRuns = new Map();
const runtimePromises = new Map();
let repoPromise;

if (!globalThis.Buffer) globalThis.Buffer = Buffer;

function enableActionSidePanel() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  Promise.resolve(chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }))
    .catch((error) => console.error(error));
}

function formatLogArg(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  return JSON.stringify(value);
}

function logToPanel(workspace, ...args) {
  console.log(...args);
  chrome.runtime.sendMessage({ type: "workerLog", workspace, text: args.map(formatLogArg).join(" ") })
    .catch(() => undefined);
}

function notifyFileChanged(path, workspace) {
  chrome.runtime.sendMessage({ type: "fileChanged", path, workspace })
    .catch(() => undefined);
}

function workspaceOf(value) {
  return WORKSPACES.includes(value) ? value : "staging";
}

function notFound(error) {
  return error?.code === "ENOENT" || error?.name === "NotFoundError" || /not found|no such/i.test(String(error?.message || error));
}

function cleanPath(path) {
  const clean = absPath(String(path || "/"), "/");
  if (clean === "/.git" || clean.startsWith("/.git/")) throw new Error(".git is internal");
  return clean;
}

function repoRel(path) {
  return cleanPath(path).replace(/^\//, "");
}

function diskPath(path) {
  const clean = cleanPath(path);
  return clean === "/" ? REPO_DIR : `${REPO_DIR}${clean}`;
}

async function mkdirp(dir) {
  const clean = absPath(dir || "/", "/");
  if (clean === "/") return;
  let current = "";
  for (const part of clean.split("/").filter(Boolean)) {
    current += `/${part}`;
    try {
      await pfs.mkdir(current);
    } catch (error) {
      if (!notFound(error) && error?.code !== "EEXIST" && !/exists/i.test(String(error?.message || error))) throw error;
    }
  }
}

async function ensureParent(path) {
  const clean = absPath(path, "/");
  const slash = clean.lastIndexOf("/");
  await mkdirp(slash <= 0 ? "/" : clean.slice(0, slash));
}

function decode(value) {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
  return String(value ?? "");
}

async function packagedSourceFiles() {
  const files = [];
  for (const path of PROJECT_FILES) {
    const url = chrome.runtime.getURL(path.slice(1));
    const response = await fetch(url);
    files.push({ path, text: response.ok ? await response.text() : "" });
  }
  return files;
}

async function worktreeRelFiles(root = "") {
  const relRoot = root.replace(/^\/+/, "").replace(/\/+$/, "");
  const start = relRoot ? `${REPO_DIR}/${relRoot}` : REPO_DIR;
  const out = [];

  async function walk(fullPath, rel) {
    let stat;
    try {
      stat = await pfs.stat(fullPath);
    } catch (error) {
      if (notFound(error)) return;
      throw error;
    }
    if (stat.isFile()) {
      out.push(rel);
      return;
    }
    if (!stat.isDirectory()) return;
    const names = await pfs.readdir(fullPath);
    for (const name of names.sort()) {
      if (!rel && name === ".git") continue;
      const nextRel = rel ? `${rel}/${name}` : name;
      await walk(`${fullPath}/${name}`, nextRel);
    }
  }

  await walk(start, relRoot);
  return out.filter(Boolean).sort();
}

async function readWorktreeFile(path) {
  try {
    return decode(await pfs.readFile(diskPath(path), "utf8"));
  } catch (error) {
    if (notFound(error)) throw new Error(`no such file: ${cleanPath(path)}`);
    throw error;
  }
}

async function writeWorktreeFile(path, text) {
  const target = diskPath(path);
  await ensureParent(target);
  await pfs.writeFile(target, String(text), "utf8");
}

async function removeWorktreeFile(path) {
  try {
    await pfs.unlink(diskPath(path));
  } catch (error) {
    if (notFound(error)) throw new Error(`no such file: ${cleanPath(path)}`);
    throw error;
  }
}

async function readBranchFile(ref, path) {
  const filepath = repoRel(path);
  if (!filepath) throw new Error(`not a file: ${cleanPath(path)}`);
  try {
    const oid = await git.resolveRef({ fs, dir: REPO_DIR, ref });
    const { blob } = await git.readBlob({ fs, dir: REPO_DIR, oid, filepath });
    return decode(blob);
  } catch (error) {
    if (notFound(error)) throw new Error(`no such file: ${cleanPath(path)}`);
    throw error;
  }
}

async function readBranchMap(ref) {
  const paths = await git.listFiles({ fs, dir: REPO_DIR, ref });
  const out = new Map();
  for (const filepath of paths.sort()) out.set(filepath, await readBranchFile(ref, `/${filepath}`));
  return out;
}

async function readWorktreeMap() {
  const out = new Map();
  for (const filepath of await worktreeRelFiles()) out.set(filepath, await readWorktreeFile(`/${filepath}`));
  return out;
}

async function hasRepo() {
  try {
    await git.resolveRef({ fs, dir: REPO_DIR, ref: "refs/heads/staging" });
    return true;
  } catch {
    return false;
  }
}

async function seedFreshRepo({ wipe = false } = {}) {
  if (wipe || !(await hasRepo())) {
    await fs.init(FS_NAME, { wipe: true });
    await mkdirp(REPO_DIR);
    await git.init({ fs, dir: REPO_DIR, defaultBranch: "main" });

    for (const file of await packagedSourceFiles()) await writeWorktreeFile(file.path, file.text);
    for (const filepath of await worktreeRelFiles()) await git.add({ fs, dir: REPO_DIR, filepath });
    await git.commit({ fs, dir: REPO_DIR, author: AUTHOR, committer: AUTHOR, message: "Seed packaged project" });
    await git.branch({ fs, dir: REPO_DIR, ref: "staging", checkout: true });
    return;
  }

  const current = await git.currentBranch({ fs, dir: REPO_DIR, fullname: false }).catch(() => "");
  if (current !== "staging") await git.checkout({ fs, dir: REPO_DIR, ref: "staging" });
}

async function ensureRepo() {
  if (!repoPromise) {
    repoPromise = seedFreshRepo().catch((error) => {
      repoPromise = undefined;
      throw error;
    });
  }
  return repoPromise;
}

async function resetProject() {
  repoPromise = seedFreshRepo({ wipe: true });
  await repoPromise;
  runtimePromises.clear();
  notifyFileChanged("/");
}

async function seedFiles() {
  await ensureRepo();
}

async function readFile(path, workspace = "staging") {
  await ensureRepo();
  return workspaceOf(workspace) === "main" ? readBranchFile("main", path) : readWorktreeFile(path);
}

async function writeFile(path, text, workspace = "staging") {
  await ensureRepo();
  if (workspaceOf(workspace) === "main") throw new Error("main branch is locked; edit staging and promote it");
  await writeWorktreeFile(path, text);
  notifyFileChanged(cleanPath(path), "staging");
}

async function listFiles(path = "/", workspace = "staging") {
  await ensureRepo();
  const clean = cleanPath(path);
  if (workspaceOf(workspace) === "main") {
    const rel = repoRel(clean);
    const prefix = rel ? `${rel}/` : "";
    return (await git.listFiles({ fs, dir: REPO_DIR, ref: "main" }))
      .filter((file) => file === rel || file.startsWith(prefix))
      .map((file) => `/${file}`)
      .sort();
  }
  const rels = await worktreeRelFiles(repoRel(clean));
  return rels.map((file) => `/${file}`).sort();
}

async function removeFile(path, workspace = "staging") {
  await ensureRepo();
  if (workspaceOf(workspace) === "main") throw new Error("main branch is locked; edit staging and promote it");
  await removeWorktreeFile(path);
  notifyFileChanged(cleanPath(path), "staging");
}

function chromeFacade() {
  return {
    tabs: chrome.tabs,
    scripting: {
      executeScript(details) {
        if (!details || typeof details.func !== "function") return chrome.scripting.executeScript(details);
        const { func, args = [], ...rest } = details;
        return chrome.scripting.executeScript({
          ...rest,
          world: rest.world || "MAIN",
          func: async (source, values) => {
            const argv = values || [];
            const args = argv;
            const runtime = { argv, args };
            const log = (...items) => console.log(...items);
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const done = (value = "") => {
              throw { __dietsurfDone: true, value };
            };
            const unavailable = (name) => async () => {
              throw new Error(`${name} is not available inside chrome.scripting.executeScript`);
            };
            const shell = unavailable("shell");
            const llm = unavailable("llm");
            const node = unavailable("node");
            const readFile = unavailable("readFile");
            const writeFile = unavailable("writeFile");
            const listFiles = unavailable("listFiles");
            const bindings = { argv, args, runtime, log, sleep, done, shell, llm, node, readFile, writeFile, listFiles };
            const prior = {};
            for (const [key, value] of Object.entries(bindings)) {
              prior[key] = { exists: key in globalThis, value: globalThis[key] };
              globalThis[key] = value;
            }
            try {
              return await (0, eval)(`(${source})`)(...argv);
            } catch (error) {
              if (error && error.__dietsurfDone) return error.value;
              throw error;
            } finally {
              for (const [key, state] of Object.entries(prior)) {
                if (state.exists) globalThis[key] = state.value;
                else delete globalThis[key];
              }
            }
          },
          args: [String(func), args]
        });
      }
    }
  };
}

function isCleanStatusRow([, head, workdir, stage]) {
  return head === 1 && workdir === 1 && stage === 1;
}

async function statusRows() {
  return (await git.statusMatrix({ fs, dir: REPO_DIR }))
    .filter((row) => !isCleanStatusRow(row))
    .sort((a, b) => a[0].localeCompare(b[0]));
}

function statusCode([, head, workdir, stage]) {
  if (head === 0 && workdir !== 0) return stage === 0 ? "??" : "A ";
  if (head !== 0 && workdir === 0) return stage === 0 ? "D " : " D";
  const staged = head !== stage;
  const unstaged = workdir !== stage;
  if (staged || unstaged) return `${staged ? "M" : " "}${unstaged ? "M" : " "}`;
  return "??";
}

function formatStatus(rows) {
  if (!rows.length) return "On branch staging\nnothing to commit, working tree clean";
  return [
    "On branch staging",
    "Changes:",
    ...rows.map((row) => `${statusCode(row)} ${row[0]}`)
  ].join("\n");
}

async function stageFilepath(filepath) {
  try {
    await pfs.stat(`${REPO_DIR}/${filepath}`);
    await git.add({ fs, dir: REPO_DIR, filepath });
  } catch (error) {
    if (!notFound(error)) throw error;
    await git.remove({ fs, dir: REPO_DIR, filepath });
  }
}

async function gitAdd(args, cwd) {
  if (!args.length) throw new Error("git add requires a path");
  const matrix = await git.statusMatrix({ fs, dir: REPO_DIR });
  const staged = new Set();

  for (const arg of args) {
    const target = repoRel(absPath(arg, cwd || "/"));
    const matches = !target
      ? matrix
      : matrix.filter(([filepath]) => filepath === target || filepath.startsWith(`${target}/`));
    if (!matches.length && target) matches.push([target]);
    for (const [filepath] of matches) {
      if (!filepath || staged.has(filepath)) continue;
      await stageFilepath(filepath);
      staged.add(filepath);
    }
  }

  return staged.size ? `staged ${staged.size} path${staged.size === 1 ? "" : "s"}` : "nothing to stage";
}

function parseCommitMessage(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-m") return args[i + 1] || "";
    if (args[i].startsWith("-m") && args[i].length > 2) return args[i].slice(2);
  }
  return "";
}

async function gitCommit(args) {
  const message = parseCommitMessage(args).trim();
  if (!message) throw new Error('git commit requires -m "message"');
  const rows = await git.statusMatrix({ fs, dir: REPO_DIR });
  if (!rows.some(([, head, , stage]) => head !== stage)) return "nothing staged for commit";
  const oid = await git.commit({ fs, dir: REPO_DIR, author: AUTHOR, committer: AUTHOR, message });
  notifyFileChanged("/", "staging");
  return `[staging ${oid.slice(0, 7)}] ${message}`;
}

async function gitLog(args, workspace) {
  const oneline = args.includes("--oneline");
  const ref = workspaceOf(workspace) === "main" ? "main" : "staging";
  const commits = await git.log({ fs, dir: REPO_DIR, ref, depth: 24 });
  if (oneline) return commits.map(({ oid, commit }) => `${oid.slice(0, 7)} ${commit.message.split("\n")[0]}`).join("\n");
  return commits.map(({ oid, commit }) => [
    `commit ${oid}`,
    `Author: ${commit.author.name} <${commit.author.email}>`,
    "",
    `    ${commit.message.replace(/\n/g, "\n    ")}`
  ].join("\n")).join("\n\n");
}

async function gitShow(args, workspace) {
  const ref = args.find((arg) => !arg.startsWith("-")) || (workspaceOf(workspace) === "main" ? "main" : "staging");
  const [entry] = await git.log({ fs, dir: REPO_DIR, ref, depth: 1 });
  if (!entry) throw new Error(`unknown ref: ${ref}`);
  return [
    `commit ${entry.oid}`,
    `Author: ${entry.commit.author.name} <${entry.commit.author.email}>`,
    "",
    `    ${entry.commit.message.replace(/\n/g, "\n    ")}`
  ].join("\n");
}

function diffMaps(oldMap, newMap, oldLabel, newLabel) {
  const paths = [...new Set([...oldMap.keys(), ...newMap.keys()])].sort();
  const patches = [];
  for (const filepath of paths) {
    const oldText = oldMap.get(filepath) ?? "";
    const newText = newMap.get(filepath) ?? "";
    if (oldText === newText) continue;
    patches.push(createTwoFilesPatch(
      oldMap.has(filepath) ? `${oldLabel}/${filepath}` : "/dev/null",
      newMap.has(filepath) ? `${newLabel}/${filepath}` : "/dev/null",
      oldText,
      newText,
      "",
      ""
    ).trimEnd());
  }
  return patches.join("\n");
}

async function gitDiff(args) {
  const range = args.find((arg) => !arg.startsWith("-"));
  if (range === "main..staging") {
    return diffMaps(await readBranchMap("main"), await readBranchMap("staging"), "main", "staging") || "";
  }
  if (range === "staging..main") {
    return diffMaps(await readBranchMap("staging"), await readBranchMap("main"), "staging", "main") || "";
  }
  if (range) throw new Error(`unsupported git diff range: ${range}`);
  return diffMaps(await readBranchMap("staging"), await readWorktreeMap(), "staging", "worktree") || "";
}

async function validateStagingAgent() {
  const validationRuntime = {
    workspace: "staging",
    agentPath: "/src/agent.js",
    entryPath: "/src/agent.js",
    readFile: (path) => readFile(path, "staging"),
    listFiles: (path = "/") => listFiles(path, "staging"),
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined
    },
    log: () => undefined
  };
  const mod = await loadModule(validationRuntime, "/src/agent.js");
  if (!mod || typeof mod.main !== "function" || typeof mod.render !== "function") {
    throw new Error("/src/agent.js must export main(runtime, argv) and render(runtime)");
  }
}

async function gitPromote(args) {
  if (args[0] !== "staging") throw new Error("usage: git promote staging");
  const rows = await statusRows();
  if (rows.length) throw new Error("staging has uncommitted changes; git add and git commit first");
  await validateStagingAgent();
  const oid = await git.resolveRef({ fs, dir: REPO_DIR, ref: "refs/heads/staging" });
  await git.writeRef({ fs, dir: REPO_DIR, ref: "refs/heads/main", value: oid, force: true });
  notifyFileChanged("/", "main");
  return `promoted staging ${oid.slice(0, 7)} to main`;
}

async function gitCommand(argv, { workspace = "staging", cwd = "/" } = {}) {
  await ensureRepo();
  const command = argv[0] || "status";
  const args = argv.slice(1);
  const key = workspaceOf(workspace);

  if (command === "status") {
    if (key === "main") return "On branch main\nmain is locked\nnothing to commit, working tree clean";
    return formatStatus(await statusRows());
  }
  if (command === "branch") {
    const branches = await git.listBranches({ fs, dir: REPO_DIR });
    return branches.sort().map((branch) => {
      const active = key === branch ? "*" : " ";
      const suffix = branch === "main" ? " (locked)" : "";
      return `${active} ${branch}${suffix}`;
    }).join("\n");
  }
  if (command === "checkout") {
    const ref = args[0];
    if (ref === "staging") return "already using staging worktree";
    if (ref === "main") throw new Error("main is locked; inspect it in the Main pane or promote staging");
    throw new Error("only staging can be checked out");
  }
  if (command === "diff") return gitDiff(args);
  if (command === "log") return gitLog(args, key);
  if (command === "show") return gitShow(args, key);
  if (key === "main") throw new Error("main branch is locked; edit staging and promote it");
  if (command === "add") return gitAdd(args, cwd);
  if (command === "commit") return gitCommit(args);
  if (command === "promote") return gitPromote(args);
  throw new Error(`unknown git command: ${command}`);
}

async function runtime(workspace) {
  await ensureRepo();
  const key = workspaceOf(workspace);
  if (!runtimePromises.has(key)) {
    runtimePromises.set(key, Promise.resolve(createRuntime({
      workspace: key,
      llmConfigPath: "/etc/llm.json",
      chrome: chromeFacade(),
      readFile: (path) => readFile(path, key),
      writeFile: (path, text) => writeFile(path, text, key),
      listFiles: (path = "/") => listFiles(path, key),
      removeFile: (path) => removeFile(path, key),
      resetProject,
      clearHistory: () => undefined,
      git: (argv, options = {}) => gitCommand(argv, { workspace: key, cwd: options.cwd || "/" }),
      log: (...args) => logToPanel(key, ...args)
    })));
  }
  return runtimePromises.get(key);
}

async function appendHistory(workspace, record) {
  void workspace;
  void record;
}

chrome.runtime.onInstalled.addListener(() => {
  enableActionSidePanel();
  seedFiles().catch((error) => console.error(error));
});

enableActionSidePanel();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    const workspace = workspaceOf(message.workspace);
    if (message.type === "interrupt") {
      const activeRun = activeRuns.get(workspace);
      if (activeRun) {
        activeRun.controller.abort();
        return { ok: true, result: "aborting" };
      }
      return { ok: true, result: "idle" };
    }
    const rt = await runtime(workspace);
    if (message.type === "shell") {
      if (activeRuns.has(workspace)) throw new Error(`${workspace} shell is already running`);
      const controller = new AbortController();
      activeRuns.set(workspace, { controller });
      rt.abortSignal = controller.signal;
      try {
        const result = await rt.shell(message.command);
        if (!["clear", "reset"].includes(message.command.trim())) {
          await appendHistory(workspace, { command: message.command, result });
        }
        return { ok: true, result };
      } catch (error) {
        if (controller.signal.aborted) throw new Error("aborted");
        throw error;
      } finally {
        if (activeRuns.get(workspace)?.controller === controller) activeRuns.delete(workspace);
        if (rt.abortSignal === controller.signal) rt.abortSignal = undefined;
      }
    }
    if (message.type === "readFile") return { ok: true, result: await readFile(message.path, workspace) };
    if (message.type === "writeFile") {
      await writeFile(message.path, message.text, workspace);
      return { ok: true, result: "" };
    }
    if (message.type === "listFiles") return { ok: true, result: await listFiles(message.path || "/", workspace) };
    throw new Error(`unknown message: ${message.type}`);
  })().then(
    (response) => sendResponse(response),
    (error) => sendResponse({ ok: false, error: toErrorText(error) })
  );
  return true;
});
