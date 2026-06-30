import { createEnvironment, execute } from "jslike";
import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { runEntrypoint } from "./run-entrypoint.js";
import { deleteSourceFs } from "./source-fs.js";

function toErrorText(error) {
  return error && error.stack ? error.stack : String(error);
}

const workerReady = runEntrypoint({
  entrypoint: "/src/runtime/worker.js",
  defaultsUrl: chrome.runtime.getURL("runtime/sources.json"),
  globals: {
    globalThis,
    chrome,
    fetch: globalThis.fetch?.bind(globalThis),
    console,
    crypto: globalThis.crypto,
    caches: globalThis.caches,
    indexedDB: globalThis.indexedDB,
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    AbortController: globalThis.AbortController,
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    clearTimeout: globalThis.clearTimeout,
    clearInterval: globalThis.clearInterval
  },
  nativeModules: {
    jslike: { createEnvironment, execute },
    ai: { generateText },
    "@ai-sdk/openai-compatible": { createOpenAICompatible }
  }
}).catch((error) => {
  console.error(error);
  throw error;
});

async function hardReset() {
  await chrome.storage.local.clear();
  await deleteSourceFs();
  setTimeout(() => chrome.runtime.reload(), 0);
  return { ok: true, result: "resetting" };
}

chrome.runtime.onInstalled.addListener(() => {
  workerReady
    .then((worker) => worker?.handleInstalled?.())
    .catch((error) => console.error(error));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "command" && message.command === "hard-reset") {
    hardReset().then(
      (response) => sendResponse(response),
      (error) => sendResponse({ ok: false, error: toErrorText(error) })
    );
    return true;
  }

  workerReady
    .then((worker) => worker.handleMessage(message, sender))
    .then(
      (response) => sendResponse(response),
      (error) => sendResponse({ ok: false, error: toErrorText(error) })
    );
  return true;
});
