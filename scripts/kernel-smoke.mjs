import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extractJavaScriptBlock, runAgent } from "../src/agent.js";
import { runServiceCode } from "../src/kernel/jslike.js";
import { createEnvironment, execute } from "jslike";
import { createLlmApi } from "../src/llm/api.js";
import { DB_NAME, deleteSourceFs } from "../src/bootstrap/source-fs.js";

assert.equal(
  extractJavaScriptBlock("```js\nconsole.log('x')\n```"),
  "console.log('x')"
);
assert.equal(
  extractJavaScriptBlock("final answer"),
  ""
);
assert.equal(DB_NAME, "dietsurf-source-fs");
assert.equal(typeof deleteSourceFs, "function");

const logs = [];
const execution = await runServiceCode("console.log('hello', 42)\n1 + 2", {
  console: { log: (...items) => logs.push(items.join(" ")) },
  fetch,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  setTimeout,
  clearTimeout
});
assert.deepEqual(execution, { ok: true, stdout: "hello 42", result: 3 });
assert.deepEqual(logs, ["hello 42"]);

const llmExecution = await runServiceCode("await llm('ping')", {
  console: { log: () => undefined },
  llm: async (input) => `pong:${input}`
});
assert.deepEqual(llmExecution, { ok: true, stdout: "", result: "pong:ping" });

await assert.rejects(
  runServiceCode("fs", { console: { log: () => undefined } }),
  /Variable "fs" is not defined/
);
await assert.rejects(
  runServiceCode("process", { console: { log: () => undefined } }),
  /Variable "process" is not defined/
);
await assert.rejects(
  runServiceCode("Buffer", { console: { log: () => undefined } }),
  /Variable "Buffer" is not defined/
);
await assert.rejects(
  runServiceCode("done", { console: { log: () => undefined } }),
  /Variable "done" is not defined/
);

const responses = [
  "```js\nconsole.log('step');\n({ value: 7 });\n```",
  "final"
];
const observations = [];
const answer = await runAgent({
  goal: "test",
  query: async () => ({ text: responses.shift() }),
  execute: async (code) => {
    const result = await runServiceCode(code, { console: { log: () => undefined } });
    observations.push(result);
    return result;
  }
});
assert.equal(answer, "final");
assert.deepEqual(observations, [{ ok: true, stdout: "step", result: { value: 7 } }]);

let missingKeyOpened = false;
const llm = createLlmApi({
  config: {
    baseUrl: "https://example.invalid/v1",
    apiKey: "",
    apiKeyEnv: "TEST_API_KEY",
    model: "test"
  },
  env: {},
  onMissingKey: async () => {
    missingKeyOpened = true;
  }
});
await assert.rejects(llm.llm("hello"), /missing LLM apiKey/);
assert.equal(missingKeyOpened, true);

const files = new Map(await Promise.all([
  "src/kernel/jslike.js"
].map(async (file) => [`/${file}`, await readFile(file, "utf8")])));
const sourceEnv = createEnvironment();
sourceEnv.define("console", { log: () => undefined });
const sourceModuleResult = await execute(`
  import { runServiceCode as run } from "./src/kernel/jslike.js";
  const execution = await run("console.log('seeded'); 20 + 22", { console });
  execution.result;
`, sourceEnv, {
  sourcePath: "/smoke.js",
  moduleResolver: {
    async resolve(modulePath, fromPath) {
      if (modulePath === "jslike") return { exports: { createEnvironment, execute } };
      const base = new URL(".", `file://${fromPath}`).pathname;
      const path = new URL(modulePath, `file://${base}`).pathname;
      const code = files.get(path);
      return code ? { path, code } : null;
    }
  }
});
assert.equal(sourceModuleResult, 42);

console.log("kernel smoke passed");
