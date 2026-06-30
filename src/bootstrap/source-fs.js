export const DB_NAME = "dietsurf-source-fs";
const DB_VERSION = 1;
const STORE_NAME = "files";
let activeDb;

function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txAsPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  });
}

function normalizePath(path) {
  const text = String(path || "");
  return text.startsWith("/") ? text : `/${text}`;
}

function resolvePath(modulePath, fromPath) {
  if (!modulePath.startsWith(".") && !modulePath.startsWith("/")) return modulePath;
  if (modulePath.startsWith("/")) return normalizePath(modulePath);

  const base = new URL(".", `file://${normalizePath(fromPath)}`).pathname;
  return new URL(modulePath, `file://${base}`).pathname;
}

async function readJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`cannot read ${url}: ${response.status}`);
  return response.json();
}

async function openDatabase() {
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      db.createObjectStore(STORE_NAME, { keyPath: "path" });
    }
  };
  const db = await requestAsPromise(request);
  activeDb = db;
  db.onclose = () => {
    if (activeDb === db) activeDb = undefined;
  };
  return db;
}

function storeOf(db, mode = "readonly") {
  const tx = db.transaction(STORE_NAME, mode);
  return { tx, store: tx.objectStore(STORE_NAME) };
}

export async function createSourceFs(defaultsUrl) {
  const [db, defaults] = await Promise.all([
    openDatabase(),
    readJson(defaultsUrl)
  ]);

  const files = Array.isArray(defaults?.files) ? defaults.files : [];
  const { tx, store } = storeOf(db, "readwrite");
  const now = Date.now();
  for (const file of files) {
    const path = normalizePath(file.path);
    const existing = await requestAsPromise(store.get(path));
    if (!existing) {
      store.put({
        path,
        source: String(file.source || ""),
        updatedAt: now
      });
    }
  }
  await txAsPromise(tx);

  async function readFile(path) {
    const { store } = storeOf(db);
    const file = await requestAsPromise(store.get(normalizePath(path)));
    return file ? String(file.source || "") : null;
  }

  async function resolve(modulePath, fromPath = "/") {
    const path = resolvePath(modulePath, fromPath);
    const source = await readFile(path);
    if (source === null) return null;
    return { path, code: source };
  }

  async function listFiles() {
    const { store } = storeOf(db);
    const all = await requestAsPromise(store.getAll());
    return all.map((file) => file.path).sort();
  }

  return {
    readFile,
    resolve,
    listFiles
  };
}

export function createModuleResolver(sourceFs, nativeModules = {}) {
  return {
    async resolve(modulePath, fromPath) {
      if (Object.prototype.hasOwnProperty.call(nativeModules, modulePath)) {
        return { exports: nativeModules[modulePath] };
      }
      return sourceFs.resolve(modulePath, fromPath);
    }
  };
}

export async function deleteSourceFs() {
  activeDb?.close();
  activeDb = undefined;
  await requestAsPromise(indexedDB.deleteDatabase(DB_NAME));
}
