# DietSurf

DietSurf is a minimal Chrome side-panel browser agent. It runs a simple
SWE-style loop in the extension service worker:

1. Send the user goal to the LLM.
2. If the response contains one fenced JavaScript block, run that block in the
   service-worker context.
3. Append the execution result as an observation.
4. Continue until the LLM answers without a JavaScript block.

There is no bash layer, Linux command surface, virtual filesystem, in-browser
Git, Node runtime, `done(...)`, or tool schema. A normal answer without a
JavaScript block is the only stop signal.

## Runtime Context

JavaScript blocks run with ordinary service-worker values:

```js
console.log("hello")
const tabs = await chrome.tabs.query({})
console.log(tabs.map((tab) => tab.title).join("\n"))
```

Available globals are service-context APIs such as `chrome`, `fetch`, `console`,
`crypto`, `caches`, `indexedDB`, `URL`, `TextEncoder`, `TextDecoder`,
`setTimeout`, and `clearTimeout`.

## Quick Start

Install dependencies:

```sh
npm install
```

Build the unpacked extension:

```sh
npm run build
```

Load this directory in Chrome:

```text
build/unpacked
```

For local builds, `.env` can provide `LILAC_API_KEY`; the build script writes it
into ignored unpacked extension artifacts. The packaged default config lives in
`etc/llm.json`.

## Useful Commands

```sh
npm test
npm run build
npm run build:plugin
```

## Project Shape

```text
manifest.json              Chrome extension manifest
worker.js                  service-worker loop and JS execution owner
sidepanel.js               side-panel transcript UI
src/agent.js               fenced-JS SWE loop
src/kernel/jslike.js       JS interpreter bridge for MV3-safe execution
src/llm/api.js             LLM provider adapter
scripts/build-unpacked.mjs builds the loadable unpacked extension
```
