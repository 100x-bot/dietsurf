import { loadModule, toErrorText } from "./kernel.js";

const logListeners = new Set();
let busy = 0;
let pendingReload = false;
let reloadTimer = 0;

function reloadsUi(path) {
  return path === "/" || path === "/src/agent.js" || path === "/src/ui.css";
}

function scheduleReload() {
  pendingReload = false;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => main().catch((error) => fallback(toErrorText(error))), 50);
}

async function run(fn) {
  busy++;
  try {
    return await fn();
  } finally {
    busy--;
    if (!busy && pendingReload) scheduleReload();
  }
}

function requestReload() {
  if (busy) {
    pendingReload = true;
    return;
  }
  scheduleReload();
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message) return false;
  if (message.type === "workerLog") {
    for (const listener of logListeners) listener(message.text);
  } else if (message.type === "fileChanged" && reloadsUi(message.path)) {
    requestReload();
  }
  return false;
});

function send(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response || !response.ok) {
      const error = (response?.error || "worker error").split("\n")[0].replace(/^Error:\s*/, "");
      throw new Error(error);
    }
    return response.result;
  });
}

function ensureRescueStyle() {
  let style = document.getElementById("dietsurf-rescue-style");
  if (style) return;
  style = document.createElement("style");
  style.id = "dietsurf-rescue-style";
  style.textContent = `
    #dietsurf[data-rescue="true"] {
      display: grid;
      grid-template-rows: minmax(0, 1fr) auto auto;
      height: 100vh;
      height: 100dvh;
      min-height: 0;
      background: #080808;
      color: #e5e5e5;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    #dietsurf[data-rescue="true"] #dietsurf-log {
      box-sizing: border-box;
      min-height: 0;
      margin: 0;
      padding: 10px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.45;
    }
    #dietsurf[data-rescue="true"] #dietsurf-status {
      box-sizing: border-box;
      min-height: 24px;
      border-top: 1px solid #1f1f1f;
      padding: 4px 10px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      background: #0c0c0c;
      color: #9a9a9a;
      font-size: 11px;
      line-height: 16px;
    }
    #dietsurf[data-rescue="true"] #dietsurf-status[data-state="running"] { color: #35f06b; }
    #dietsurf[data-rescue="true"] #dietsurf-status[data-state="error"] { color: #ff6b5a; }
    #dietsurf[data-rescue="true"] #dietsurf-status[data-state="aborted"] { color: #d0d0d0; }
    #dietsurf[data-rescue="true"] #dietsurf-prompt {
      box-sizing: border-box;
      width: 100%;
      min-height: 38px;
      max-height: 180px;
      border: 0;
      border-top: 1px solid #2a2a2a;
      padding: 10px;
      outline: none;
      resize: none;
      background: #101010;
      color: #e5e5e5;
      caret-color: #35f06b;
      font: inherit;
      line-height: 1.45;
    }
    #dietsurf[data-rescue="true"] #dietsurf-prompt:focus { border-top-color: #35f06b; }
  `;
  document.head.append(style);
}

function complete(script) {
  const lines = script.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/<<['"]?([A-Za-z0-9_.-]+)['"]?\s*$/);
    if (match && !lines.slice(i + 1).some((line) => line === match[1])) return false;
  }
  return true;
}

function fallback(message) {
  logListeners.clear();
  ensureRescueStyle();
  const app = document.getElementById("app");
  app.innerHTML = "";

  const root = document.createElement("div");
  root.id = "dietsurf";
  root.dataset.rescue = "true";

  const output = document.createElement("pre");
  output.id = "dietsurf-log";

  const status = document.createElement("div");
  status.id = "dietsurf-status";
  status.textContent = "rescue";

  const input = document.createElement("textarea");
  input.id = "dietsurf-prompt";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.rows = 1;
  input.placeholder = "rescue shell: cat /src/agent.js, reset";

  root.append(output, status, input);
  app.append(root);

  let running = false;
  let interrupting = false;

  const write = (value = "") => {
    output.textContent += String(value) + "\n";
    output.scrollTop = output.scrollHeight;
  };

  const setStatus = (state, text) => {
    status.dataset.state = state;
    status.textContent = text;
  };

  const interruptRun = async () => {
    if (!running || interrupting) return;
    interrupting = true;
    write("^C");
    setStatus("running", "interrupting");
    try {
      await send({ type: "interrupt" });
    } catch (error) {
      write(error && error.message ? error.message : String(error));
    }
  };

  logListeners.add((text) => {
    if (running) write(text);
  });

  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = input.scrollHeight + "px";
  });

  input.addEventListener("keydown", async (event) => {
    if (running && (event.key === "Escape" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c"))) {
      event.preventDefault();
      await interruptRun();
      return;
    }
    if (event.key !== "Enter") return;
    if (event.shiftKey || !complete(input.value)) return;
    event.preventDefault();
    const command = input.value.trim();
    if (!command) return;
    if (running) {
      if (["kill", "cancel", "abort", "^c"].includes(command.toLowerCase())) {
        input.value = "";
        input.style.height = "auto";
        await interruptRun();
      }
      return;
    }
    input.value = "";
    input.style.height = "auto";
    write("$ " + command);
    running = true;
    setStatus("running", command.replace(/\s+/g, " ").slice(0, 96));
    try {
      const result = await run(() => send({ type: "shell", command }));
      if (result) write(result);
      if (command === "reset") {
        setStatus("running", "reloading");
        scheduleReload();
      } else {
        setStatus("done", "done");
      }
    } catch (error) {
      const text = error && error.message ? error.message : String(error);
      if (text === "aborted" || text === "Error: aborted") setStatus("aborted", "aborted");
      else {
        setStatus("error", "error");
        write(text);
      }
    } finally {
      running = false;
      interrupting = false;
    }
  });

  write("DietSurf rescue");
  write(message);
  write("");
  write("Use `cat /src/agent.js` to inspect, `cat > /src/agent.js <<'EOF'` to repair, or `reset` to restore packaged defaults.");
  input.focus();
}

async function main() {
  logListeners.clear();
  document.getElementById("dietsurf-rescue-style")?.remove();

  let style = document.getElementById("dietsurf-style");
  if (!style) {
    style = document.createElement("style");
    style.id = "dietsurf-style";
    document.head.append(style);
  }
  style.textContent = await send({ type: "readFile", path: "/src/ui.css" }).catch(() => "");

  const uiRuntime = {
    document,
    window,
    localStorage: window.localStorage,
    matchMedia: window.matchMedia.bind(window),
    readFile: (path) => send({ type: "readFile", path }),
    writeFile: (path, text) => run(() => send({ type: "writeFile", path, text })),
    listFiles: (path = "/") => send({ type: "listFiles", path }),
    shell: (command) => run(() => send({ type: "shell", command })),
    interrupt: () => send({ type: "interrupt" }),
    onLog(listener) {
      logListeners.add(listener);
      return () => logListeners.delete(listener);
    },
    log: () => undefined
  };

  const mod = await loadModule(uiRuntime, "/src/agent.js");
  if (!mod || typeof mod.render !== "function") throw new Error("/src/agent.js must export render(runtime)");
  await mod.render(uiRuntime);
}

main().catch((error) => fallback(toErrorText(error)));
