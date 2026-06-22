# DietSurf Plan

DietSurf is a small Chrome side-panel browser agent. The runtime should stay
honest: it is an LLM loop plus JavaScript execution in a Chrome extension
service-worker context.

## Core Loop

```text
user goal -> LLM -> optional fenced JavaScript -> service worker execution
          -> observation -> LLM -> final answer without JavaScript
```

Rules:

- If the assistant response has a fenced `js` or `javascript` block, execute the
  first block and continue.
- If the assistant response has no JavaScript block, return that text and stop.
- There is no special stop API. No `done(...)`.
- There is no bash, shell parser, Linux command vocabulary, filesystem shim,
  Git command layer, Node runtime, `require`, `process`, or `Buffer`.

## Execution Context

JavaScript blocks run in the extension service context with ordinary web and
Chrome extension APIs:

```js
const tabs = await chrome.tabs.query({})
console.log(tabs)
```

The intended globals are `chrome`, `fetch`, `console`, `crypto`, `caches`,
`indexedDB`, `URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`,
`setTimeout`, and `clearTimeout`.

## UI

The side panel is a transcript:

- The input accepts a user goal.
- Worker logs stream into the transcript.
- Escape or Ctrl+C requests interruption.
- There are no main/staging panes, terminal prompts, command routing rules,
  rescue shells, settings pages, or hidden workspace transforms.

## Configuration

LLM configuration is loaded from packaged `etc/llm.json` plus optional
`chrome.storage.local.llmConfig` overrides. Host-side builds may inject
`LILAC_API_KEY` into ignored `build/unpacked` artifacts for local testing.

## Verification

Use:

```sh
npm test
npm run build
```
