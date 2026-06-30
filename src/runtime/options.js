const PROVIDERS = {
  lilac: {
    label: "Lilac",
    baseUrl: "https://api.getlilac.com/v1",
    model: "minimaxai/minimax-m2.7"
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini"
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4.1-mini"
  },
  custom: {
    label: "Custom",
    baseUrl: "",
    model: ""
  }
};

const NUMERIC_FIELDS = [
  "temperature",
  "topP",
  "maxOutputTokens",
  "presencePenalty",
  "frequencyPenalty"
];

const DEFAULT_PARAMS = {
  provider: "lilac",
  baseUrl: PROVIDERS.lilac.baseUrl,
  apiKey: "",
  apiKeyEnv: "",
  model: PROVIDERS.lilac.model,
  temperature: 0,
  topP: "",
  maxOutputTokens: "",
  presencePenalty: "",
  frequencyPenalty: ""
};

function qs(root, selector) {
  return root.querySelector(selector);
}

function cleanNumber(value) {
  const text = String(value || "").trim();
  if (!text) return undefined;
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
}

function numberText(value) {
  return Number.isFinite(value) ? String(value) : "";
}

function normalizeConfig(config) {
  const merged = { ...DEFAULT_PARAMS, ...(config || {}) };
  for (const field of NUMERIC_FIELDS) merged[field] = numberText(merged[field]);
  return merged;
}

async function loadStoredConfig() {
  const data = await chrome.storage.local.get("llmConfig").catch(() => ({}));
  return normalizeConfig(data.llmConfig);
}

async function saveConfig(config) {
  await chrome.storage.local.set({ llmConfig: config });
}

async function resetConfig() {
  await chrome.storage.local.remove("llmConfig");
}

function setStyle() {
  let style = document.getElementById("dietsurf-options-style");
  if (style) return;
  style = document.createElement("style");
  style.id = "dietsurf-options-style";
  style.textContent = `
    :root {
      color-scheme: dark;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #080808;
      color: #ededed;
    }

    html,
    body,
    #app {
      min-height: 100%;
      margin: 0;
      background: #080808;
    }

    body {
      overflow-y: auto;
    }

    #dietsurf-options {
      box-sizing: border-box;
      width: min(920px, 100%);
      margin: 0 auto;
      padding: 28px 18px 36px;
    }

    .topbar {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 18px;
      margin-bottom: 22px;
    }

    h1 {
      margin: 0 0 4px;
      color: #35f06b;
      font-size: 20px;
      line-height: 1.2;
      letter-spacing: 0;
    }

    .lede {
      max-width: 68ch;
      margin: 0;
      color: #b6b6b6;
      font-size: 13px;
      line-height: 1.5;
    }

    .status {
      min-width: 150px;
      color: #9d9d9d;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      line-height: 1.4;
      text-align: right;
    }

    .status[data-state="saved"] { color: #35f06b; }
    .status[data-state="error"] { color: #ff6b5a; }

    form {
      display: grid;
      gap: 18px;
    }

    section {
      border: 1px solid #242424;
      border-radius: 8px;
      background: #0d0d0d;
      overflow: hidden;
    }

    .section-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      border-bottom: 1px solid #222;
      padding: 11px 12px;
      background: #101010;
    }

    h2 {
      margin: 0;
      color: #efefef;
      font-size: 13px;
      line-height: 1.3;
    }

    .hint {
      margin: 0;
      color: #a3a3a3;
      font-size: 12px;
      line-height: 1.45;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      padding: 12px;
    }

    .field {
      display: grid;
      gap: 6px;
      min-width: 0;
    }

    .field.full {
      grid-column: 1 / -1;
    }

    label {
      color: #d2d2d2;
      font-size: 12px;
      line-height: 1.3;
    }

    input,
    select {
      box-sizing: border-box;
      width: 100%;
      min-height: 34px;
      border: 1px solid #303030;
      border-radius: 6px;
      padding: 7px 9px;
      outline: none;
      background: #080808;
      color: #eeeeee;
      font: inherit;
      font-size: 13px;
      line-height: 1.35;
    }

    input::placeholder {
      color: #9b9b9b;
    }

    input:focus,
    select:focus {
      border-color: #35f06b;
      box-shadow: 0 0 0 2px rgba(53, 240, 107, 0.16);
    }

    .actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      padding: 0 0 4px;
    }

    button {
      min-height: 34px;
      border: 1px solid #383838;
      border-radius: 6px;
      padding: 7px 12px;
      background: #121212;
      color: #ededed;
      font: inherit;
      font-size: 13px;
      line-height: 1.2;
      cursor: pointer;
    }

    button:hover {
      border-color: #555;
      background: #181818;
    }

    button:focus {
      outline: 2px solid rgba(53, 240, 107, 0.45);
      outline-offset: 2px;
    }

    button.primary {
      border-color: #35f06b;
      background: #35f06b;
      color: #041207;
      font-weight: 700;
    }

    button.primary:hover {
      background: #6af58f;
    }

    @media (max-width: 680px) {
      .topbar {
        display: grid;
      }

      .status {
        text-align: left;
      }

      .grid {
        grid-template-columns: 1fr;
      }

      .actions {
        justify-content: stretch;
      }

      button {
        flex: 1;
      }
    }
  `;
  document.head.append(style);
}

function field({ id, label, type = "text", placeholder = "", full = false, autocomplete = "off" }) {
  const wrap = document.createElement("div");
  wrap.className = full ? "field full" : "field";

  const labelEl = document.createElement("label");
  labelEl.htmlFor = id;
  labelEl.textContent = label;

  const input = document.createElement("input");
  input.id = id;
  input.name = id;
  input.type = type;
  input.placeholder = placeholder;
  input.autocomplete = autocomplete;

  wrap.append(labelEl, input);
  return wrap;
}

function section(title, hint, children) {
  const box = document.createElement("section");
  const head = document.createElement("div");
  head.className = "section-head";

  const h = document.createElement("h2");
  h.textContent = title;
  const p = document.createElement("p");
  p.className = "hint";
  p.textContent = hint;
  head.append(h, p);

  const grid = document.createElement("div");
  grid.className = "grid";
  grid.append(...children);
  box.append(head, grid);
  return box;
}

function readForm(form) {
  const data = new FormData(form);
  const config = {
    provider: String(data.get("provider") || "custom"),
    baseUrl: String(data.get("baseUrl") || "").trim(),
    apiKey: String(data.get("apiKey") || "").trim(),
    apiKeyEnv: String(data.get("apiKeyEnv") || "").trim(),
    model: String(data.get("model") || "").trim()
  };
  for (const field of NUMERIC_FIELDS) {
    const value = cleanNumber(data.get(field));
    if (value !== undefined) config[field] = value;
  }
  return config;
}

function writeForm(form, config) {
  for (const [name, value] of Object.entries(normalizeConfig(config))) {
    const input = form.elements[name];
    if (input) input.value = value;
  }
}

function render() {
  setStyle();
  const app = document.getElementById("app");
  app.innerHTML = "";

  const root = document.createElement("main");
  root.id = "dietsurf-options";

  const topbar = document.createElement("div");
  topbar.className = "topbar";
  const intro = document.createElement("div");
  const title = document.createElement("h1");
  title.textContent = "DietSurf Options";
  const lede = document.createElement("p");
  lede.className = "lede";
  lede.textContent = "Configure the OpenAI-compatible provider used by the browser agent. Values save to chrome.storage.local and override packaged defaults.";
  intro.append(title, lede);

  const status = document.createElement("div");
  status.className = "status";
  status.dataset.state = "idle";
  status.textContent = "loading";
  topbar.append(intro, status);

  const form = document.createElement("form");
  form.autocomplete = "off";

  const providerWrap = document.createElement("div");
  providerWrap.className = "field";
  const providerLabel = document.createElement("label");
  providerLabel.htmlFor = "provider";
  providerLabel.textContent = "Provider preset";
  const provider = document.createElement("select");
  provider.id = "provider";
  provider.name = "provider";
  for (const [value, preset] of Object.entries(PROVIDERS)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = preset.label;
    provider.append(option);
  }
  providerWrap.append(providerLabel, provider);

  form.append(
    section("Provider", "Preset values are editable after selection.", [
      providerWrap,
      field({ id: "baseUrl", label: "Base URL", placeholder: "https://api.example.com/v1", full: true }),
      field({ id: "model", label: "Model", placeholder: "provider/model-name", full: true })
    ]),
    section("Credentials", "The browser can only use values stored in extension storage or packaged defaults.", [
      field({ id: "apiKey", label: "API key", type: "password", placeholder: "Stored locally in Chrome", full: true }),
      field({ id: "apiKeyEnv", label: "Packaged env key name", placeholder: "Optional", full: true })
    ]),
    section("Generation", "Blank numeric fields are omitted from requests.", [
      field({ id: "temperature", label: "Temperature", type: "number", placeholder: "0" }),
      field({ id: "topP", label: "Top P", type: "number", placeholder: "optional" }),
      field({ id: "maxOutputTokens", label: "Max output tokens", type: "number", placeholder: "optional" }),
      field({ id: "presencePenalty", label: "Presence penalty", type: "number", placeholder: "optional" }),
      field({ id: "frequencyPenalty", label: "Frequency penalty", type: "number", placeholder: "optional" })
    ])
  );

  for (const input of form.querySelectorAll('input[type="number"]')) {
    input.step = "any";
  }

  const actions = document.createElement("div");
  actions.className = "actions";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "Reset";
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "primary";
  save.textContent = "Save";
  actions.append(reset, save);

  form.append(actions);
  root.append(topbar, form);
  app.append(root);

  const setStatus = (state, text) => {
    status.dataset.state = state;
    status.textContent = text;
  };

  loadStoredConfig().then(
    (config) => {
      writeForm(form, config);
      setStatus("idle", "ready");
    },
    (error) => setStatus("error", error && error.message ? error.message : String(error))
  );

  provider.addEventListener("change", () => {
    const preset = PROVIDERS[provider.value];
    if (!preset || provider.value === "custom") return;
    qs(form, "#baseUrl").value = preset.baseUrl;
    qs(form, "#model").value = preset.model;
  });

  reset.addEventListener("click", async () => {
    try {
      await resetConfig();
      writeForm(form, DEFAULT_PARAMS);
      setStatus("saved", "reset");
    } catch (error) {
      setStatus("error", error && error.message ? error.message : String(error));
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const config = readForm(form);
      if (!config.baseUrl) throw new Error("Base URL is required");
      if (!config.model) throw new Error("Model is required");
      await saveConfig(config);
      setStatus("saved", "saved");
    } catch (error) {
      setStatus("error", error && error.message ? error.message : String(error));
    }
  });
}

try {
  render();
} catch (error) {
  const app = document.getElementById("app");
  app.innerHTML = "";
  const pre = document.createElement("pre");
  pre.textContent = error && error.stack ? error.stack : String(error);
  app.append(pre);
}
