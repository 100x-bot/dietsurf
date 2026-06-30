# DietSurf

DietSurf is a minimal Chrome side-panel browser agent. Chrome loads tiny native
bootstraps, then the app source is read from an IndexedDB-backed source store
and executed by `jslike`.

It runs a simple SWE-style loop in the extension service worker:

1. Send the user goal to the LLM.
2. If the response contains one fenced JavaScript block, run that block in the
   service-worker context.
3. Append the execution result as an observation.
4. Continue until the LLM answers without a JavaScript block.

A response from LLM without a JavaScript block is the only stop signal.

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

## Bootstrap Source Store

The extension stores interpreted source files in IndexedDB:

- Database: `dietsurf-source-fs`
- Object store: `files`
- Record key: `path`
- Record shape: `{ path, source, updatedAt }`

On startup, the bootstrap seeds only missing files from packaged defaults in
`runtime/sources.json`. Existing IndexedDB source files are preserved. Runtime
entrypoints use their source paths, for example `/src/runtime/worker.js`.

## LLM Options

The extension options page configures the OpenAI-compatible LLM endpoint used by
the worker. It is also loaded through the native bootstrap plus `jslike`, so its
source is available in the same IndexedDB source store.

Settings are stored in `chrome.storage.local.llmConfig` and override packaged
defaults from `etc/llm.json`. The options page supports provider presets, base
URL, model, API key, optional packaged key name, temperature, top P, max output
tokens, presence penalty, and frequency penalty. Packaged defaults do not
include API keys. If an LLM call is attempted without a usable key, the worker
opens the options page.

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

Packaged defaults live in `etc/llm.json` and do not include API keys. Add keys
from the extension options page after loading the extension.

## Useful Commands

```sh
npm test
npm run build
npm run build:plugin
```

## Project Shape

```text
manifest.json              Chrome extension manifest
src/bootstrap/worker-bootstrap.js    native service-worker loader for jslike
src/bootstrap/sidepanel-bootstrap.js native side-panel loader for jslike
src/bootstrap/options-bootstrap.js   native options-page loader for jslike
src/runtime/worker.js                interpreted service-worker loop and JS execution owner
src/runtime/sidepanel.js             interpreted side-panel transcript UI
src/runtime/sidepanel.html           side-panel document copied to extension root
src/runtime/options.js               interpreted LLM settings UI
src/runtime/options.html             options document copied to extension root
src/agent.js               interpreted fenced-JS SWE loop
src/kernel/jslike.js       interpreted JS interpreter bridge
src/llm/api.js             interpreted LLM provider adapter
scripts/build-unpacked.mjs builds the loadable unpacked extension
```
