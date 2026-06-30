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

## Requirements

- Node.js 20 or newer
- npm
- Google Chrome for loading or packing the extension

## Runtime Context

JavaScript blocks run with ordinary service-worker values:

```js
console.log("hello")
const tabs = await chrome.tabs.query({})
console.log(tabs.map((tab) => tab.title).join("\n"))
```

Available globals are service-context APIs such as `chrome`, `fetch`, `console`,
`crypto`, `caches`, `indexedDB`, `URL`, `TextEncoder`, `TextDecoder`,
`setTimeout`, and `clearTimeout`. Agent code also gets an `llm(input)` helper
that sends a prompt or message list through the configured LLM provider.

## Bootstrap Source Store

The extension stores interpreted source files in IndexedDB:

- Database: `dietsurf-source-fs`
- Object store: `files`
- Record key: `path`
- Record shape: `{ path, source, updatedAt }`

On startup, the bootstrap seeds only missing files from packaged defaults in
`runtime/sources.json`. Existing IndexedDB source files are preserved. Runtime
entrypoints use their source paths, for example `/src/runtime/worker.js`.

The packaged source defaults are:

- `/src/runtime/worker.js`
- `/src/runtime/sidepanel.js`
- `/src/runtime/options.js`
- `/src/agent.js`
- `/src/kernel/jslike.js`
- `/src/llm/api.js`

Use `/hard-reset` in the side panel to clear `chrome.storage.local`, delete the
source-store IndexedDB database, and reload the extension runtime. This restores
the packaged defaults from the current build.

## LLM Options

The extension options page configures the OpenAI-compatible LLM endpoint used by
the worker. It is also loaded through the native bootstrap plus `jslike`, so its
source is available in the same IndexedDB source store.

Settings are stored in `chrome.storage.local.llmConfig` and override packaged
defaults from `etc/llm.json`. Config precedence is:

1. Packaged defaults in `etc/llm.json`
2. Saved options in `chrome.storage.local.llmConfig`

The options page supports provider presets, base URL, model, API key, optional
packaged key name, temperature, top P, max output tokens, presence penalty, and
frequency penalty. Packaged defaults do not include API keys. If an LLM call is
attempted without a usable key, the worker opens the options page.

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

In Chrome, open `chrome://extensions`, enable Developer mode, choose Load
unpacked, and select `build/unpacked`.

Packaged defaults live in `etc/llm.json` and do not include API keys. Add a key
from the extension options page after loading the extension.

## Side Panel

Click the DietSurf extension action to open the side panel. Enter a goal and
press Enter to run it. Press Ctrl-C or Cmd-C while a run is active to interrupt
it.

Slash commands:

```text
/help        show available commands
/hard-reset  clear local state, delete the source store, and reload
```

## Useful Commands

```sh
npm test
npm run build
npm run build:plugin
```

`npm test` runs the kernel smoke test. `npm run build` creates
`build/unpacked`, the loadable Chrome extension.

`npm run build:plugin` first runs `npm run build`, then asks Chrome to pack the
extension into `build/plugin.crx`. It uses `CHROME_PATH` from the environment,
or `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` on macOS.
Signing-key paths can be overridden with:

```sh
DIETSURF_KEY_DIR=/path/to/key-dir
DIETSURF_PLUGIN_KEY=/path/to/plugin.pem
```

`.env.example` documents the macOS `CHROME_PATH` value, but scripts read
environment variables directly.

## Build Output

`npm run build` generates this extension shape:

```text
build/unpacked/
  manifest.json
  sidepanel.html
  options.html
  etc/llm.json
  runtime/sources.json
  runtime/worker-bootstrap.js
  runtime/sidepanel-bootstrap.js
  runtime/options-bootstrap.js
```

The HTML files are copied from `src/runtime`. The bootstrap files are bundled
from `src/bootstrap`. Interpreted runtime source is embedded into
`runtime/sources.json`.

## Project Shape

```text
manifest.json                         Chrome extension manifest
etc/llm.json                          packaged LLM defaults, without API keys
.env.example                          example Chrome path for plugin packing
PLAN.md                               project notes
package.json                          npm scripts and dependencies
package-lock.json                     locked dependency tree
scripts/build-unpacked.mjs            builds the loadable unpacked extension
scripts/build-plugin.mjs              packs build/unpacked into build/plugin.crx
scripts/kernel-smoke.mjs              smoke test for agent, jslike, LLM config, and source loading
src/agent.js                          interpreted fenced-JS SWE loop
src/kernel/jslike.js                  interpreted JS interpreter bridge
src/llm/api.js                        interpreted OpenAI-compatible provider adapter
src/bootstrap/run-entrypoint.js       shared native loader for interpreted entrypoints
src/bootstrap/source-fs.js            IndexedDB source-store and module resolver
src/bootstrap/worker-bootstrap.js     native service-worker loader for jslike
src/bootstrap/sidepanel-bootstrap.js  native side-panel loader for jslike
src/bootstrap/options-bootstrap.js    native options-page loader for jslike
src/runtime/worker.js                 interpreted service-worker loop and JS execution owner
src/runtime/sidepanel.js              interpreted side-panel transcript UI
src/runtime/sidepanel.html            side-panel document copied to extension root
src/runtime/options.js                interpreted LLM settings UI
src/runtime/options.html              options document copied to extension root
```
