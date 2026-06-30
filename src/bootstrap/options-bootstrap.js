import { createEnvironment, execute } from "jslike";
import { runEntrypoint } from "./run-entrypoint.js";

runEntrypoint({
  entrypoint: "/src/runtime/options.js",
  defaultsUrl: chrome.runtime.getURL("runtime/sources.json"),
  globals: {
    globalThis,
    window,
    document,
    chrome,
    fetch: globalThis.fetch?.bind(globalThis),
    console,
    indexedDB: globalThis.indexedDB,
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    clearTimeout: globalThis.clearTimeout,
    clearInterval: globalThis.clearInterval
  },
  nativeModules: {
    jslike: { createEnvironment, execute }
  }
}).catch((error) => {
  console.error(error);
  const app = document.getElementById("app");
  if (!app) return;
  app.textContent = "";
  const pre = document.createElement("pre");
  pre.textContent = error && error.stack ? error.stack : String(error);
  app.append(pre);
});
