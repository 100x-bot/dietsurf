import { Buffer } from "buffer";
import pathShim from "path-browserify";
import processShim from "process/browser.js";
import { createFs } from "./fs.js";
import { createShell } from "./shell.js";
import { runFile, runSource } from "./jslike.js";

function isDone(error) {
  return error && error.__dietsurfDone;
}

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function createProcess(runtime, base) {
  return {
    ...processShim,
    ...base.process,
    env: runtime.env,
    argv: runtime.argv,
    browser: !globalThis.process?.versions?.node,
    version: globalThis.process?.version || processShim.version || "",
    versions: { ...(processShim.versions || {}), ...(globalThis.process?.versions || {}) },
    platform: globalThis.process?.platform || "browser",
    cwd: () => runtime.cwd || "/",
    nextTick: processShim.nextTick || ((fn, ...args) => Promise.resolve().then(() => fn(...args)))
  };
}

function createRequire(runtime) {
  return function require(name) {
    const key = String(name).replace(/^node:/, "");
    if (key in runtime.modules) return runtime.modules[key];
    throw new Error(`cannot find module: ${name}`);
  };
}

export function createRuntime(base) {
  const runtime = {
    argv: [],
    cwd: base.cwd || "/",
    chrome: base.chrome,
    readFile: base.readFile,
    readFileSync: base.readFileSync,
    writeFile: base.writeFile,
    listFiles: base.listFiles,
    removeFile: base.removeFile,
    mkdir: base.mkdir,
    resetProject: base.resetProject,
    clearHistory: base.clearHistory,
    git: base.git,
    abortSignal: base.abortSignal,
    workspace: base.workspace,
    llmConfigPath: base.llmConfigPath || "/etc/llm.json",
    env: base.env || {},
    log: base.log || console.log
  };
  runtime.throwIfAborted = () => {
    if (runtime.abortSignal?.aborted) throw abortError();
  };
  runtime.sleep = (ms) => new Promise((resolve, reject) => {
    runtime.throwIfAborted();
    const timer = setTimeout(resolve, ms);
    runtime.abortSignal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
  runtime.console = base.console || {
    log: (...args) => runtime.log(...args),
    warn: (...args) => runtime.log(...args),
    error: (...args) => runtime.log(...args)
  };
  runtime.fetch = base.fetch || (globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined);
  runtime.Buffer = Buffer;
  runtime.path = pathShim.posix || pathShim;
  runtime.crypto = base.crypto || globalThis.crypto;
  runtime.fs = createFs(runtime);
  runtime.process = createProcess(runtime, base);
  runtime.modules = {
    fs: runtime.fs,
    "fs/promises": runtime.fs.promises,
    path: runtime.path,
    buffer: { Buffer },
    process: runtime.process,
    crypto: runtime.crypto
  };
  runtime.require = createRequire(runtime);
  runtime.global = {
    runtime,
    argv: runtime.argv,
    process: runtime.process,
    Buffer,
    fs: runtime.fs,
    path: runtime.path,
    crypto: runtime.crypto,
    require: runtime.require
  };
  if (base.createLlmApi) {
    Object.assign(runtime, base.createLlmApi(runtime));
  } else {
    runtime.query = async () => {
      throw new Error("llm api is not available");
    };
    runtime.llm = async () => {
      throw new Error("llm api is not available");
    };
  }
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
