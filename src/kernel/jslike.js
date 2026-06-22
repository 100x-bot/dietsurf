import { createEnvironment, execute } from "jslike";

function define(env, name, value) {
  if (value !== undefined) env.define(name, value);
}

function formatValue(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function safeResult(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function makeConsole(baseConsole, stdout, onConsole) {
  const write = (method) => (...items) => {
    const line = items.map(formatValue).join(" ");
    stdout.push(line);
    onConsole?.(...items);
    baseConsole?.[method]?.(...items);
  };
  return {
    log: write("log"),
    info: write("info"),
    warn: write("warn"),
    error: write("error")
  };
}

function makeEnv(context, console) {
  const env = createEnvironment();
  define(env, "chrome", context.chrome);
  define(env, "llm", context.llm);
  define(env, "fetch", context.fetch);
  define(env, "console", console);
  define(env, "crypto", context.crypto);
  define(env, "caches", context.caches);
  define(env, "indexedDB", context.indexedDB);
  define(env, "URL", context.URL);
  define(env, "URLSearchParams", context.URLSearchParams);
  define(env, "TextEncoder", context.TextEncoder);
  define(env, "TextDecoder", context.TextDecoder);
  define(env, "setTimeout", context.setTimeout);
  define(env, "clearTimeout", context.clearTimeout);
  return env;
}

export async function runServiceCode(source, context = {}, options = {}) {
  const stdout = [];
  const console = makeConsole(context.console, stdout, options.onConsole);
  const result = await execute(String(source || ""), makeEnv(context, console), {
    sourcePath: options.sourcePath || "service-context.js"
  });
  return {
    ok: true,
    stdout: stdout.join("\n"),
    result: safeResult(result)
  };
}
