import { PROJECT_FILES, createRuntime, toErrorText } from "./kernel.js";

const STORE = "dietsurf.files";

async function allFiles() {
  const data = await chrome.storage.local.get(STORE);
  return data[STORE] || {};
}

async function saveFiles(files) {
  await chrome.storage.local.set({ [STORE]: files });
}

async function readFile(path) {
  const files = await allFiles();
  if (!(path in files)) throw new Error(`no such file: ${path}`);
  return files[path];
}

async function writeFile(path, text) {
  const files = await allFiles();
  files[path] = String(text);
  await saveFiles(files);
}

async function listFiles(path = "/") {
  const files = await allFiles();
  const prefix = path === "/" ? "/" : `${path.replace(/\/$/, "")}/`;
  return Object.keys(files).filter((file) => file === path || file.startsWith(prefix));
}

async function removeFile(path) {
  const files = await allFiles();
  delete files[path];
  await saveFiles(files);
}

async function seedFiles() {
  const files = await allFiles();
  if (files["/src/agent.js"]) return;
  for (const path of PROJECT_FILES) {
    const url = chrome.runtime.getURL(path.slice(1));
    const response = await fetch(url);
    files[path] = response.ok ? await response.text() : "";
  }
  await saveFiles(files);
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
          func: async (source, values) => (0, eval)(`(${source})`)(...(values || [])),
          args: [String(func), args]
        });
      }
    }
  };
}

let runtimePromise;
async function runtime() {
  await seedFiles();
  if (!runtimePromise) {
    runtimePromise = Promise.resolve(createRuntime({
      chrome: chromeFacade(),
      readFile,
      writeFile,
      listFiles,
      removeFile,
      log: (...args) => console.log(...args)
    }));
  }
  return runtimePromise;
}

async function appendHistory(record) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
  const prior = await readFile("/var/log/history.jsonl").catch(() => "");
  await writeFile("/var/log/history.jsonl", prior + line);
}

chrome.runtime.onInstalled.addListener(() => {
  seedFiles().catch((error) => console.error(error));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    const rt = await runtime();
    if (message.type === "shell") {
      const result = await rt.shell(message.command);
      await appendHistory({ command: message.command, result });
      return { ok: true, result };
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
