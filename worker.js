import git from "isomorphic-git";
import LightningFS from "@isomorphic-git/lightning-fs";
import { Buffer } from "buffer";
import { createTwoFilesPatch } from "diff";
import { PROJECT_FILES, absPath, createRuntime, loadModule, toErrorText } from "./kernel.js";

const FS_NAME = "dietsurf-git";
const MAIN_DIR = "/main";
const STAGING_DIR = "/staging";
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

function notifyFileChanged(path) {
  chrome.runtime.sendMessage({ type: "fileChanged", path })
    .catch(() => undefined);
}

function workspaceOf(value) {
  return value === "main" ? "main" : "staging";
}

function rootForWorkspace(workspace) {
  return workspaceOf(workspace) === "main" ? MAIN_DIR : STAGING_DIR;
}

function notFound(error) {
  return error?.code === "ENOENT" || error?.name === "NotFoundError" || /not found|no such/i.test(String(error?.message || error));
}

function cleanPath(path, cwd = "/") {
  return absPath(String(path || "/"), cwd);
}

function pathRepo(path) {
  const clean = cleanPath(path);
  if (clean === MAIN_DIR || clean.startsWith(`${MAIN_DIR}/`)) {
    return { root: MAIN_DIR, branch: "main", locked: true };
  }
  if (clean === STAGING_DIR || clean.startsWith(`${STAGING_DIR}/`)) {
    return { root: STAGING_DIR, branch: "staging", locked: false };
  }
  return null;
}

function repoRel(path, root) {
  const clean = cleanPath(path);
  if (clean === root) return "";
  if (!clean.startsWith(`${root}/`)) throw new Error(`${clean} is outside ${root}`);
  return clean.slice(root.length + 1);
}

async function mkdirp(dir) {
  const clean = cleanPath(dir);
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
  const clean = cleanPath(path);
  const slash = clean.lastIndexOf("/");
  await mkdirp(slash <= 0 ? "/" : clean.slice(0, slash));
}

function decode(value) {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
  return String(value ?? "");
}

async function readRawFile(path) {
  const clean = cleanPath(path);
  try {
    return decode(await pfs.readFile(clean, "utf8"));
  } catch (error) {
    if (notFound(error)) throw new Error(`no such file: ${clean}`);
    throw error;
  }
}

async function writeRawFile(path, text) {
  const clean = cleanPath(path);
  await ensureParent(clean);
  await pfs.writeFile(clean, String(text), "utf8");
}

async function removeRawFile(path) {
  const clean = cleanPath(path);
  try {
    await pfs.unlink(clean);
  } catch (error) {
    if (notFound(error)) throw new Error(`no such file: ${clean}`);
    throw error;
  }
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

function shouldSkipListing(path, root) {
  if (root === "/main/.git" || root.startsWith("/main/.git/")) return false;
  if (root === "/staging/.git" || root.startsWith("/staging/.git/")) return false;
  return path === "/main/.git" || path.startsWith("/main/.git/") || path === "/staging/.git" || path.startsWith("/staging/.git/");
}

async function visibleFiles(root = "/") {
  const cleanRoot = cleanPath(root);
  const out = [];

  async function walk(path) {
    if (shouldSkipListing(path, cleanRoot)) return;
    let stat;
    try {
      stat = await pfs.stat(path);
    } catch (error) {
      if (notFound(error)) return;
      throw error;
    }
    if (stat.isFile()) {
      out.push(path);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const name of (await pfs.readdir(path)).sort()) {
      const next = path === "/" ? `/${name}` : `${path}/${name}`;
      await walk(next);
    }
  }

  await walk(cleanRoot);
  return out.sort();
}

async function worktreeRelFiles(root) {
  const out = [];
  async function walk(path, rel) {
    if (path === `${root}/.git` || path.startsWith(`${root}/.git/`)) return;
    let stat;
    try {
      stat = await pfs.stat(path);
    } catch (error) {
      if (notFound(error)) return;
      throw error;
    }
    if (stat.isFile()) {
      out.push(rel);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const name of (await pfs.readdir(path)).sort()) {
      await walk(`${path}/${name}`, rel ? `${rel}/${name}` : name);
    }
  }
  await walk(root, "");
  return out.filter(Boolean).sort();
}

async function readBranchFile(root, ref, filepath) {
  try {
    const oid = await git.resolveRef({ fs, dir: root, ref });
    const { blob } = await git.readBlob({ fs, dir: root, oid, filepath });
    return decode(blob);
  } catch (error) {
    if (notFound(error)) throw new Error(`no such file in ${ref}: ${filepath}`);
    throw error;
  }
}

async function readBranchMap(root, ref) {
  const paths = await git.listFiles({ fs, dir: root, ref });
  const out = new Map();
  for (const filepath of paths.sort()) out.set(filepath, await readBranchFile(root, ref, filepath));
  return out;
}

async function readWorktreeMap(root) {
  const out = new Map();
  for (const filepath of await worktreeRelFiles(root)) out.set(filepath, await readRawFile(`${root}/${filepath}`));
  return out;
}

async function hasRepo(root, ref) {
  try {
    await git.resolveRef({ fs, dir: root, ref: `refs/heads/${ref}` });
    return true;
  } catch {
    return false;
  }
}

async function stageFilepath(root, filepath) {
  try {
    await pfs.stat(`${root}/${filepath}`);
    await git.add({ fs, dir: root, filepath });
  } catch (error) {
    if (!notFound(error)) throw error;
    await git.remove({ fs, dir: root, filepath });
  }
}

async function stageAll(root) {
  const matrix = await git.statusMatrix({ fs, dir: root });
  const staged = new Set();
  for (const [filepath] of matrix) {
    if (!filepath || staged.has(filepath)) continue;
    await stageFilepath(root, filepath);
    staged.add(filepath);
  }
  return staged.size;
}

async function seedRepo(root, branch, files) {
  await mkdirp(root);
  await git.init({ fs, dir: root, defaultBranch: branch });
  for (const file of files) await writeRawFile(`${root}${file.path}`, file.text);
  await stageAll(root);
  const oid = await git.commit({ fs, dir: root, author: AUTHOR, committer: AUTHOR, message: "Seed packaged project" });
  return oid;
}

async function seedFreshRepos({ wipe = false } = {}) {
  if (!wipe && await hasRepo(MAIN_DIR, "main") && await hasRepo(STAGING_DIR, "staging")) return;
  await fs.init(FS_NAME, { wipe: true });
  const files = await packagedSourceFiles();
  await seedRepo(MAIN_DIR, "main", files);
  const stagingOid = await seedRepo(STAGING_DIR, "staging", files);
  await git.writeRef({ fs, dir: STAGING_DIR, ref: "refs/heads/main", value: stagingOid, force: true });
}

async function ensureRepo() {
  if (!repoPromise) {
    repoPromise = seedFreshRepos().catch((error) => {
      repoPromise = undefined;
      throw error;
    });
  }
  return repoPromise;
}

async function resetProject() {
  repoPromise = seedFreshRepos({ wipe: true });
  await repoPromise;
  runtimePromises.clear();
  notifyFileChanged("/");
}

async function seedFiles() {
  await ensureRepo();
}

async function readFile(path) {
  await ensureRepo();
  return readRawFile(path);
}

async function writeFile(path, text) {
  await ensureRepo();
  const clean = cleanPath(path);
  const repo = pathRepo(clean);
  if (repo?.locked) throw new Error("/main is locked; write under /staging and promote it");
  await writeRawFile(clean, text);
  notifyFileChanged(clean);
}

async function listFiles(path = "/") {
  await ensureRepo();
  return visibleFiles(path);
}

async function removeFile(path) {
  await ensureRepo();
  const clean = cleanPath(path);
  const repo = pathRepo(clean);
  if (repo?.locked) throw new Error("/main is locked; remove files under /staging and promote it");
  await removeRawFile(clean);
  notifyFileChanged(clean);
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

async function statusRows(root) {
  return (await git.statusMatrix({ fs, dir: root }))
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

async function currentBranch(root) {
  return git.currentBranch({ fs, dir: root, fullname: false }).catch(() => "");
}

async function formatStatus(repo) {
  const branch = await currentBranch(repo.root);
  const rows = await statusRows(repo.root);
  const lines = [`On branch ${branch || repo.branch}`];
  if (repo.locked) lines.push("/main is locked");
  if (!rows.length) {
    lines.push("nothing to commit, working tree clean");
    return lines.join("\n");
  }
  lines.push("Changes:");
  lines.push(...rows.map((row) => `${statusCode(row)} ${row[0]}`));
  return lines.join("\n");
}

function repoForGit(cwd) {
  const repo = pathRepo(cwd);
  if (!repo) throw new Error("not a git repository; cd /main or /staging");
  return repo;
}

function argRelPath(arg, cwd, repo) {
  const absolute = cleanPath(arg || ".", cwd);
  if (absolute === repo.root) return "";
  if (!absolute.startsWith(`${repo.root}/`)) throw new Error(`${absolute} is outside ${repo.root}`);
  return absolute.slice(repo.root.length + 1);
}

async function gitAdd(args, cwd, repo) {
  if (repo.locked) throw new Error("/main is locked; add files under /staging");
  if (!args.length) throw new Error("git add requires a path");
  const matrix = await git.statusMatrix({ fs, dir: repo.root });
  const staged = new Set();

  for (const arg of args) {
    const target = argRelPath(arg, cwd, repo);
    const matches = !target
      ? matrix
      : matrix.filter(([filepath]) => filepath === target || filepath.startsWith(`${target}/`));
    if (!matches.length && target) matches.push([target]);
    for (const [filepath] of matches) {
      if (!filepath || staged.has(filepath)) continue;
      await stageFilepath(repo.root, filepath);
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

async function gitCommit(args, repo) {
  if (repo.locked) throw new Error("/main is locked; commit under /staging");
  const message = parseCommitMessage(args).trim();
  if (!message) throw new Error('git commit requires -m "message"');
  const rows = await git.statusMatrix({ fs, dir: repo.root });
  if (!rows.some(([, head, , stage]) => head !== stage)) return "nothing staged for commit";
  const oid = await git.commit({ fs, dir: repo.root, author: AUTHOR, committer: AUTHOR, message });
  return `[${repo.branch} ${oid.slice(0, 7)}] ${message}`;
}

async function gitLog(args, repo) {
  const oneline = args.includes("--oneline");
  const ref = args.find((arg) => !arg.startsWith("-")) || (await currentBranch(repo.root)) || repo.branch;
  const commits = await git.log({ fs, dir: repo.root, ref, depth: 24 });
  if (oneline) return commits.map(({ oid, commit }) => `${oid.slice(0, 7)} ${commit.message.split("\n")[0]}`).join("\n");
  return commits.map(({ oid, commit }) => [
    `commit ${oid}`,
    `Author: ${commit.author.name} <${commit.author.email}>`,
    "",
    `    ${commit.message.replace(/\n/g, "\n    ")}`
  ].join("\n")).join("\n\n");
}

async function gitShow(args, repo) {
  const spec = args.find((arg) => !arg.startsWith("-")) || (await currentBranch(repo.root)) || repo.branch;
  if (spec.includes(":")) {
    const colon = spec.indexOf(":");
    const ref = spec.slice(0, colon) || "HEAD";
    const filepath = spec.slice(colon + 1).replace(/^\/+/, "");
    if (!filepath) throw new Error(`missing path in ${spec}`);
    return readBranchFile(repo.root, ref, filepath);
  }
  const [entry] = await git.log({ fs, dir: repo.root, ref: spec, depth: 1 });
  if (!entry) throw new Error(`unknown ref: ${spec}`);
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

async function gitDiff(args, repo) {
  const range = args.find((arg) => !arg.startsWith("-"));
  if (range) {
    const [from, to] = range.split("..");
    if (!from || !to) throw new Error(`unsupported git diff range: ${range}`);
    return diffMaps(await readBranchMap(repo.root, from), await readBranchMap(repo.root, to), from, to) || "";
  }
  const branch = await currentBranch(repo.root) || repo.branch;
  return diffMaps(await readBranchMap(repo.root, branch), await readWorktreeMap(repo.root), branch, "worktree") || "";
}

async function validateStagingAgent() {
  const validationRuntime = {
    workspace: "staging",
    agentPath: "/staging/src/agent.js",
    entryPath: "/staging/src/agent.js",
    readFile,
    listFiles,
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined
    },
    log: () => undefined
  };
  const mod = await loadModule(validationRuntime, "/staging/src/agent.js");
  if (!mod || typeof mod.main !== "function" || typeof mod.render !== "function") {
    throw new Error("/staging/src/agent.js must export main(runtime, argv) and render(runtime)");
  }
}

async function promoteStaging() {
  const rows = await statusRows(STAGING_DIR);
  if (rows.length) throw new Error("/staging has uncommitted changes; git add and git commit first");
  await validateStagingAgent();
  const sourceFiles = await worktreeRelFiles(STAGING_DIR);
  const targetFiles = await worktreeRelFiles(MAIN_DIR);
  const sourceSet = new Set(sourceFiles);

  for (const filepath of targetFiles) {
    if (!sourceSet.has(filepath)) await removeRawFile(`${MAIN_DIR}/${filepath}`);
  }
  for (const filepath of sourceFiles) {
    await writeRawFile(`${MAIN_DIR}/${filepath}`, await readRawFile(`${STAGING_DIR}/${filepath}`));
  }

  await stageAll(MAIN_DIR);
  const mainRows = await git.statusMatrix({ fs, dir: MAIN_DIR });
  let mainOid = await git.resolveRef({ fs, dir: MAIN_DIR, ref: "refs/heads/main" });
  if (mainRows.some(([, head, , stage]) => head !== stage)) {
    const stagingOid = await git.resolveRef({ fs, dir: STAGING_DIR, ref: "refs/heads/staging" });
    mainOid = await git.commit({
      fs,
      dir: MAIN_DIR,
      author: AUTHOR,
      committer: AUTHOR,
      message: `Promote staging ${stagingOid.slice(0, 7)}`
    });
  }

  const stagingOid = await git.resolveRef({ fs, dir: STAGING_DIR, ref: "refs/heads/staging" });
  await git.writeRef({ fs, dir: STAGING_DIR, ref: "refs/heads/main", value: stagingOid, force: true });
  notifyFileChanged("/main");
  return `promoted /staging ${stagingOid.slice(0, 7)} to /main ${mainOid.slice(0, 7)}`;
}

async function gitCommand(argv, { cwd = "/" } = {}) {
  await ensureRepo();
  const repo = repoForGit(cwd);
  const command = argv[0] || "status";
  const args = argv.slice(1);

  if (command === "status") return formatStatus(repo);
  if (command === "branch") {
    const current = await currentBranch(repo.root);
    const branches = await git.listBranches({ fs, dir: repo.root });
    return branches.sort().map((branch) => `${branch === current ? "*" : " "} ${branch}${branch === "main" && repo.root === MAIN_DIR ? " (locked)" : ""}`).join("\n");
  }
  if (command === "checkout") {
    const ref = args[0];
    if (!ref) throw new Error("git checkout requires a branch");
    if (repo.root === MAIN_DIR) throw new Error("/main is locked; use cd /staging to edit staging");
    if (ref !== "staging") throw new Error("/staging stays on the staging branch; inspect /main for main");
    return "already on staging";
  }
  if (command === "diff") return gitDiff(args, repo);
  if (command === "log") return gitLog(args, repo);
  if (command === "show") return gitShow(args, repo);
  if (command === "ls-files") return (await git.listFiles({ fs, dir: repo.root, ref: await currentBranch(repo.root) || repo.branch })).join("\n");
  if (command === "stash" && args[0] === "list") return "";
  if (command === "add") return gitAdd(args, cwd, repo);
  if (command === "commit") return gitCommit(args, repo);
  if (command === "promote") {
    if (args[0] !== "staging") throw new Error("usage: git promote staging");
    if (repo.root !== STAGING_DIR) throw new Error("run git promote staging from /staging");
    return promoteStaging();
  }
  throw new Error(`unknown git command: ${command}`);
}

async function runtime(workspace) {
  await ensureRepo();
  const key = workspaceOf(workspace);
  const root = rootForWorkspace(key);
  if (!runtimePromises.has(key)) {
    runtimePromises.set(key, Promise.resolve(createRuntime({
      workspace: key,
      cwd: root,
      llmConfigPath: `${root}/etc/llm.json`,
      chrome: chromeFacade(),
      readFile,
      writeFile,
      listFiles,
      removeFile,
      resetProject,
      clearHistory: () => undefined,
      git: (argv, options = {}) => gitCommand(argv, { cwd: options.cwd || root }),
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
    if (message.type === "readFile") return { ok: true, result: await readFile(message.path) };
    if (message.type === "writeFile") {
      await writeFile(message.path, message.text);
      return { ok: true, result: "" };
    }
    if (message.type === "listFiles") return { ok: true, result: await listFiles(message.path || "/") };
    throw new Error(`unknown message: ${message.type}`);
  })().then(
    (response) => sendResponse(response),
    (error) => sendResponse({ ok: false, error: toErrorText(error) })
  );
  return true;
});
