function send(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response || !response.ok) {
      const error = (response?.error || "worker error").split("\n")[0].replace(/^Error:\s*/, "");
      throw new Error(error);
    }
    return response.result;
  });
}

function toErrorText(error) {
  return error && error.stack ? error.stack : String(error);
}

function setStyle() {
  let style = document.getElementById("dietsurf-style");
  if (style) return;
  style = document.createElement("style");
  style.id = "dietsurf-style";
  style.textContent = `
    :root {
      color-scheme: dark;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      background: #080808;
      color: #e7e7e7;
    }

    html,
    body,
    #app {
      height: 100%;
      margin: 0;
      overflow: hidden;
      background: #080808;
    }

    #dietsurf {
      display: grid;
      grid-template-rows: 32px minmax(0, 1fr) 26px auto;
      height: 100vh;
      height: 100dvh;
      min-height: 0;
      background: #080808;
    }

    #dietsurf-header {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      border-bottom: 1px solid #232323;
      padding: 0 10px;
      background: #0d0d0d;
      color: #a9a9a9;
      font-size: 11px;
      line-height: 32px;
    }

    #dietsurf-header-spacer {
      flex: 1;
    }

    #dietsurf-title {
      color: #35f06b;
      font-weight: 800;
    }

    #dietsurf-options-button {
      box-sizing: border-box;
      min-height: 22px;
      border: 1px solid #2f2f2f;
      border-radius: 6px;
      padding: 2px 8px;
      background: #121212;
      color: #d7d7d7;
      font: inherit;
      font-size: 11px;
      line-height: 16px;
      cursor: pointer;
    }

    #dietsurf-options-button:hover {
      border-color: #35f06b;
      color: #35f06b;
    }

    #dietsurf-context {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #dietsurf-log {
      box-sizing: border-box;
      min-height: 0;
      margin: 0;
      padding: 12px 10px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.45;
    }

    #dietsurf-status {
      box-sizing: border-box;
      border-top: 1px solid #1f1f1f;
      padding: 5px 10px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      background: #0c0c0c;
      color: #9a9a9a;
      font-size: 11px;
      line-height: 16px;
    }

    #dietsurf-status[data-state="running"] { color: #35f06b; }
    #dietsurf-status[data-state="error"] { color: #ff6b5a; }
    #dietsurf-status[data-state="complete"],
    #dietsurf-status[data-state="aborted"] { color: #d0d0d0; }

    #dietsurf-prompt {
      box-sizing: border-box;
      width: 100%;
      min-height: 42px;
      max-height: 180px;
      border: 0;
      border-top: 1px solid #2a2a2a;
      padding: 10px;
      outline: none;
      resize: none;
      background: #101010;
      color: #e7e7e7;
      caret-color: #35f06b;
      font: inherit;
      font-size: 12px;
      line-height: 1.45;
    }

    #dietsurf-prompt:focus { border-top-color: #35f06b; }
  `;
  document.head.append(style);
}

function appendBlock(output, value = "") {
  output.textContent += String(value) + "\n";
  output.scrollTop = output.scrollHeight;
}

async function runSlashCommand(text, output) {
  if (text === "/help") {
    appendBlock(output, "/help        show commands");
    appendBlock(output, "/hard-reset  reset DietSurf state and reload");
    return;
  }

  if (text === "/hard-reset") {
    const result = await send({ type: "command", command: "hard-reset" });
    appendBlock(output, result || "resetting");
    return;
  }

  appendBlock(output, `unknown command: ${text.split(/\s+/, 1)[0]}`);
}

function render() {
  setStyle();
  const app = document.getElementById("app");
  app.innerHTML = "";

  const root = document.createElement("div");
  root.id = "dietsurf";

  const header = document.createElement("div");
  header.id = "dietsurf-header";

  const title = document.createElement("span");
  title.id = "dietsurf-title";
  title.textContent = "DietSurf";

  const context = document.createElement("span");
  context.id = "dietsurf-context";
  context.textContent = "service context";

  const spacer = document.createElement("span");
  spacer.id = "dietsurf-header-spacer";

  const options = document.createElement("button");
  options.id = "dietsurf-options-button";
  options.type = "button";
  options.textContent = "Config";
  options.title = "Open options";

  const output = document.createElement("pre");
  output.id = "dietsurf-log";

  const status = document.createElement("div");
  status.id = "dietsurf-status";
  status.dataset.state = "idle";
  status.textContent = "idle";

  const input = document.createElement("textarea");
  input.id = "dietsurf-prompt";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.rows = 1;
  input.placeholder = "goal";

  header.append(title, context, spacer, options);
  root.append(header, output, status, input);
  app.append(root);

  let running = false;
  let interrupting = false;
  let statusTimer;

  const setStatus = (state, text) => {
    status.dataset.state = state;
    status.textContent = text;
  };

  const startStatus = (goal) => {
    const started = Date.now();
    const label = goal.replace(/\s+/g, " ").slice(0, 96);
    clearInterval(statusTimer);
    const tick = () => setStatus("running", `running ${Math.floor((Date.now() - started) / 1000)}s  ${label}`);
    tick();
    statusTimer = setInterval(tick, 1000);
  };

  const stopStatus = (state) => {
    clearInterval(statusTimer);
    setStatus(state, state);
  };

  const interruptRun = async () => {
    if (!running || interrupting) return;
    interrupting = true;
    appendBlock(output, "^C");
    setStatus("running", "interrupting");
    try {
      await send({ type: "interrupt" });
    } catch (error) {
      appendBlock(output, error && error.message ? error.message : String(error));
    }
  };

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "workerLog" || !running) return false;
    appendBlock(output, message.text);
    return false;
  });

  options.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
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
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();

    const goal = input.value.trim();
    if (!goal) return;
    if (running) return;

    input.value = "";
    input.style.height = "auto";
    appendBlock(output, `> ${goal}`);

    if (goal.startsWith("/")) {
      try {
        await runSlashCommand(goal, output);
        stopStatus("complete");
      } catch (error) {
        stopStatus("error");
        appendBlock(output, error && error.message ? error.message : String(error));
      }
      return;
    }

    running = true;
    interrupting = false;
    startStatus(goal);

    try {
      const result = await send({ type: "runGoal", goal });
      if (result) appendBlock(output, result);
      stopStatus("complete");
    } catch (error) {
      const text = error && error.message ? error.message : String(error);
      if (text === "aborted" || text === "Error: aborted") {
        stopStatus("aborted");
      } else {
        stopStatus("error");
        appendBlock(output, text);
      }
    } finally {
      running = false;
      interrupting = false;
    }
  });

  appendBlock(output, "DietSurf service context");
  input.focus();
}

try {
  render();
} catch (error) {
  const app = document.getElementById("app");
  app.innerHTML = "";
  const pre = document.createElement("pre");
  pre.textContent = toErrorText(error);
  app.append(pre);
}
