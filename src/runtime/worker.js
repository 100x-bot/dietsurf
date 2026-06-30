import { runAgent } from "../agent.js";
import { runServiceCode } from "../kernel/jslike.js";
import { createLlmApi } from "../llm/api.js";

const activeRuns = new Map();

function toErrorText(error) {
  return error && error.stack ? error.stack : String(error);
}

function enableActionSidePanel() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  Promise.resolve(chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }))
    .catch((error) => console.error(error));
}

function formatLogArg(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sendLog(...args) {
  const text = args.map(formatLogArg).join(" ");
  console.log(...args);
  chrome.runtime.sendMessage({ type: "workerLog", text }).catch(() => undefined);
}

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

async function readPackagedLlmConfig() {
  const response = await fetch(chrome.runtime.getURL("etc/llm.json"));
  if (!response.ok) throw new Error(`cannot read etc/llm.json: ${response.status}`);
  return response.json();
}

async function readStoredLlmConfig() {
  const data = await chrome.storage.local.get("llmConfig").catch(() => ({}));
  return data?.llmConfig && typeof data.llmConfig === "object" ? data.llmConfig : {};
}

async function loadLlmConfig() {
  return {
    ...(await readPackagedLlmConfig()),
    ...(await readStoredLlmConfig())
  };
}

async function openOptionsForMissingKey() {
  await Promise.resolve(chrome.runtime.openOptionsPage()).catch(() => undefined);
}

function serviceContext(signal) {
  return {
    chrome,
    llm: async (input) => {
      checkAbort(signal);
      const api = createLlmApi({
        loadConfig: loadLlmConfig,
        abortSignal: signal,
        onMissingKey: openOptionsForMissingKey
      });
      return api.llm(input);
    },
    fetch: globalThis.fetch?.bind(globalThis),
    console,
    crypto: globalThis.crypto,
    caches: globalThis.caches,
    indexedDB: globalThis.indexedDB,
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout
  };
}

async function executeJavaScript(code, signal) {
  checkAbort(signal);
  const result = await runServiceCode(code, serviceContext(signal), {
    onConsole: (...args) => sendLog(...args)
  });
  checkAbort(signal);
  return result;
}

async function runGoal(goal, signal) {
  const llm = createLlmApi({
    loadConfig: loadLlmConfig,
    abortSignal: signal,
    onMissingKey: openOptionsForMissingKey
  });

  return runAgent({
    goal,
    query: llm.query,
    execute: (code) => executeJavaScript(code, signal),
    log: (...args) => sendLog(...args),
    checkAbort: () => checkAbort(signal)
  });
}

async function withRun(kind, fn) {
  if (activeRuns.has(kind)) throw new Error("DietSurf is already running");
  const controller = new AbortController();
  activeRuns.set(kind, controller);
  try {
    return await fn(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw abortError();
    throw error;
  } finally {
    if (activeRuns.get(kind) === controller) activeRuns.delete(kind);
  }
}

enableActionSidePanel();

async function handleMessage(message) {
  if (message?.type === "interrupt") {
    for (const controller of activeRuns.values()) controller.abort();
    return { ok: true, result: activeRuns.size ? "aborting" : "idle" };
  }

  if (message?.type === "runGoal") {
    return {
      ok: true,
      result: await withRun("goal", (signal) => runGoal(String(message.goal || ""), signal))
    };
  }

  if (message?.type === "getLlmConfig") {
    return { ok: true, result: await loadLlmConfig() };
  }

  throw new Error(`unknown message: ${message?.type}`);
}

({
  handleInstalled: enableActionSidePanel,
  handleMessage,
  toErrorText
});
