# DietSurf Plan

DietSurf is a minimal Chrome browser agent.

The goal is the browser-agent version of a Mini-SWE-style loop: one terminal,
one filesystem, one small agent file, and one LLM call path. The browser should
not become a separate workflow language or a pile of special UI controls.

## Core Shape

The whole runtime should reduce to this:

```text
human -> sidepanel terminal -> shell -> filesystem
agent -> bash tool -> same shell -> same filesystem
browser -> /browser mount
plugin source -> /src files
settings -> /etc files
logs -> /var files
```

The shell is the access interface. The agent and the user both inspect and
change the same tree with ordinary commands:

```sh
ls -R /
cat /src/agent.js
cat /etc/llm.json
cat /browser/tabs.json
cat /browser/active/title
```

No public `readFile` or `writeFile` workflow should be exposed to the model or
the UI. Internally the kernel can use file operations, but the usage model is
shell commands over files.

## Usage Lifecycle

### 1. Load

The user loads the unpacked MV3 extension. The service worker is only the
kernel. It seeds the virtual project into IndexedDB on first run:

```text
/manifest.json
/package.json
/bin/dietsurf-node.js
/etc/profile
/etc/llm.json
/etc/browser.json
/src/agent.js
/src/ui.css
/src/kernel/...
/src/runtime/chrome-puppeteer.js
/home/user/notes.md
/var/log/history.jsonl
```

After first run, stored files are the live source of truth. Packaged files are
only defaults and reset material.

### 2. Open

Clicking the extension icon opens the side panel directly. The side panel is a
terminal, not a dashboard:

```text
DietSurf
$
```

The input stays fixed at the bottom. History scrolls above it. The status line
shows only the current state, for example:

```text
idle
running 7s  cat /browser/active/text.txt
interrupting
done
error
```

### 3. Configure

Settings are files. There is no settings page and no buttons.

```sh
cat /etc/llm.json
cat > /etc/llm.json <<'EOF'
{
  "baseUrl": "https://api.getlilac.com/v1",
  "apiKey": "",
  "apiKeyEnv": "LILAC_API_KEY",
  "model": "minimaxai/minimax-m2.7"
}
EOF
```

In extension mode, local environment variables are not available, so the key
must be stored in `/etc/llm.json` or injected by a dev helper. In real Node
mode, `bin/dietsurf-node.js` may load `.env` and use `apiKeyEnv`.

Browser driver settings stay in `/etc/browser.json` for the Node/Puppeteer
runner. The extension mode uses the real Chrome extension APIs.

### 4. Manual Shell Use

The user can run direct commands at any time:

```sh
pwd
ls -R /
cat /src/agent.js
cat /browser/tabs.json
cat /browser/active/text.txt | head -40
```

This must keep working even if the agent file has been edited, because the
kernel shell is the recovery surface.

### 5. Goal Use

If an input line is a known shell command, run it as shell. If it is not a
known shell command, treat it as a goal:

```text
summarize this page
```

The UI translates that into:

```sh
node /src/agent.js "summarize this page"
```

The agent may answer directly. It should not be forced to call bash for
conversation. If it needs state, files, browser data, or code execution, it uses
the one optional tool: `bash`.

### 6. Agent Loop

`/src/agent.js` owns the loop. The worker does not own browser-agent behavior.

The loop should be:

1. Read `/etc/profile` for environment instructions.
2. Read the initial tree with `ls -R /`.
3. Send structured messages to the LLM.
4. Expose one optional tool named `bash`.
5. If the model returns text and no tool call, print the text and stop.
6. If the model calls `bash`, run exactly one shell command.
7. Append a tool result message.
8. Repeat until direct answer, `done(...)`, cancel, or step limit.

Do not collapse the whole prompt, history, and observations into one giant user
string. Preserve proper `system`, `user`, `assistant`, and `tool` messages.

## Browser As Files

The browser should be a dynamic mounted filesystem at `/browser`.

Files under `/browser` expose browser state. They do not hide arbitrary code
execution behind filenames.

Target tree:

```text
/browser/tabs.json
/browser/active.json
/browser/active/id
/browser/active/url
/browser/active/title
/browser/active/status
/browser/active/text.txt
/browser/active/html.html
/browser/tabs/<tabId>.json
/browser/tabs/<tabId>/url
/browser/tabs/<tabId>/title
/browser/tabs/<tabId>/status
/browser/tabs/<tabId>/text.txt
/browser/tabs/<tabId>/html.html
```

`/browser/active/*` resolves the active tab at operation time. For multi-step
work, the agent should read `/browser/tabs.json` and use
`/browser/tabs/<tabId>/*`.

### Browser Read Semantics

`cat /browser/tabs.json` calls `chrome.tabs.query({})` and returns compact JSON:

```json
[
  {
    "id": 123,
    "windowId": 1,
    "index": 0,
    "active": true,
    "title": "Example",
    "url": "https://example.com/",
    "status": "complete",
    "pinned": false,
    "audible": false,
    "discarded": false,
    "incognito": false
  }
]
```

`cat /browser/active/title`, `url`, `id`, and `status` read tab metadata. These
should not inject page code.

`cat /browser/active/text.txt` uses `chrome.scripting.executeScript` with fixed
kernel code to return `document.body.innerText || ""`.

`cat /browser/active/html.html` uses fixed kernel code to return
`document.documentElement.outerHTML || ""`.

Restricted pages are expected. Metadata can still work; text/html reads may
return clear shell errors when Chrome rejects injection.

### Browser Write Semantics

Only state-like browser files are writable in v0.

```sh
echo "https://example.com" > /browser/active/url
```

Writing `url` calls `chrome.tabs.update(tabId, { url })`. The write means the
navigation was requested. The agent can poll `cat /browser/active/status` or
`cat /browser/active.json` if it needs load completion.

These paths are readonly:

```text
/browser/tabs.json
/browser/active.json
/browser/active/id
/browser/active/title
/browser/active/status
/browser/active/text.txt
/browser/active/html.html
```

`rm /browser/...` is unsupported.

### No Eval Files

Do not add:

```text
/browser/active/eval.js
/browser/active/eval.json
```

That would be a disguised `execute_script` tool. File writes should not secretly
mean "run arbitrary code in the page".

Arbitrary JavaScript execution remains explicit through the `node` command and
real Chrome APIs:

```sh
node <<'EOF'
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
const [{ result }] = await chrome.scripting.executeScript({
  target: { tabId: tab.id },
  func: () => document.querySelector("h1")?.innerText
})
console.log(result)
EOF
```

The rule is:

```text
/browser files = browser state
node command = explicit JavaScript execution
shell = only access interface
```

## Implementation Plan

### 1. Add Browser File Mount

Create:

```text
/src/runtime/browser-files.js
```

It should export:

```js
export function createBrowserFiles({ chrome }) {
  return {
    handles(path),
    readFile(path),
    writeFile(path, text),
    listFiles(path),
    removeFile(path),
    readFileSync(path)
  }
}
```

`handles(path)` returns true for `/browser` and descendants.

`readFileSync(path)` should throw for `/browser` paths:

```text
browser files are async-only; use cat or fs.promises.readFile
```

Chrome APIs are async, so sync reads would either lie or return stale data.

### 2. Route Worker VFS Through Mounts

In `worker.js`, wrap the existing Dexie-backed VFS:

```js
if (browserFiles.handles(path)) return browserFiles.readFile(path)
```

Apply that to:

```text
readFile
writeFile
listFiles
removeFile
readFileSync
```

`listFiles("/")` should merge persisted project files with dynamic mount roots.
`/browser` must not be seeded into IndexedDB and must not be listed in
`PROJECT_FILES`.

### 3. Keep Shell Generic

`src/kernel/shell.js` should not learn browser concepts. It already has the
right role:

```text
cat -> runtime.readFile
echo > -> runtime.writeFile
ls -> runtime.listFiles
rm -> runtime.removeFile
node -> run JS with runtime.chrome available
```

If browser files are implemented behind the runtime file methods, every shell
feature automatically works:

```sh
cat /browser/active/text.txt | grep checkout | head -5
cat /browser/tabs.json > /home/user/tabs.json
```

### 4. Keep Chrome APIs Explicit In Node

The `node` command should keep receiving:

```text
chrome
shell
llm/query
fs
path
process
Buffer
crypto
console/log
done
```

For browser work that is more than state reads/writes, the model should write
explicit JS using `chrome.tabs.*` and `chrome.scripting.executeScript(...)`.

### 5. Put Environment Truth In `/etc/profile`

`/etc/profile` should describe the shell and mounted browser briefly:

```text
DietSurf is a tiny shell over a virtual project.
Use cat, ls, grep, head, find, pipes, redirects, heredocs, and node.
Browser state is mounted at /browser.
Use cat /browser/tabs.json to inspect tabs.
Use cat /browser/active/text.txt to read page text.
Use echo URL > /browser/active/url to navigate.
Use node <<'EOF' ... EOF for explicit JavaScript and chrome.* APIs.
```

Then `/src/agent.js` should include `/etc/profile` in its system context. This
keeps the agent's operating manual editable as a file instead of hardcoding a
large prompt in source.

### 6. Preserve Cancellation

Cancellation remains a kernel concern:

```text
Ctrl+C
Escape
kill
cancel
abort
```

It should abort:

```text
active LLM request
active shell command
active sleep
active browser file read/write when possible
```

After cancellation, the terminal must accept a new command without refreshing
the side panel.

### 7. Preserve Self-Editing

The extension's live agent source is still editable:

```sh
cat /src/agent.js
cat > /src/agent.js <<'EOF'
...
EOF
node /src/agent.js "try the new behavior"
```

`/src/ui.css` is editable too. UI changes can apply on side panel refresh in
v0. Avoid a complicated hot-reload system until the basic model is solid.

### 8. Preserve Real Node Mode

The same `/src/agent.js` should run from real bash:

```sh
npm run node -- "summarize this page"
```

In extension mode, `/browser` is backed by Chrome extension APIs. In real Node
mode, `/browser` can later be backed by Puppeteer through
`/src/runtime/chrome-puppeteer.js`. The contract should stay the same:

```text
shell commands and /browser files, not a second browser API surface
```

Node/Puppeteer parity can be incremental. Extension `/browser` is the first
target because this is a Chrome plugin.

## Validation Plan

Manual shell smoke:

```sh
ls /browser
cat /browser/tabs.json
cat /browser/active/title
cat /browser/active/url
cat /browser/active/text.txt | head -20
```

Navigation smoke:

```sh
echo "https://example.com" > /browser/active/url
cat /browser/active/status
cat /browser/active/title
cat /browser/active/text.txt | grep "Example Domain"
```

Explicit JS smoke:

```sh
node <<'EOF'
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
const [{ result }] = await chrome.scripting.executeScript({
  target: { tabId: tab.id },
  func: () => document.title
})
console.log(result)
EOF
```

Agent smoke:

```text
what page am i on?
summarize this page
find the main heading on this page
```

Recovery smoke:

```sh
clear
cat /src/agent.js
reset
```

Cancellation smoke:

```text
start a page summary
press Ctrl+C
run: cat /browser/active/title
```

Build smoke:

```sh
npm run build
npm run build:plugin
```

Real-user smoke should use the dev logger to capture side panel and service
worker logs, then verify that browser-file commands and agent goals behave as a
user would experience them.

## Non-Goals

No browser DSL.

No hidden eval files.

No `execute_script` LLM tool.

No debugger attach in v0.

No content-script framework in v0.

No workflow engine.

No planner layer.

No multi-agent system.

No separate settings UI.

No full terminal emulator or IDE.

No Vite unless the current esbuild setup stops being enough. The source layout
should remain directly understandable and executable by the JS-like runtime.

## Decision Summary

DietSurf should feel like a tiny Unix-like machine whose filesystem happens to
include the current browser. The browser mount exposes state. The `node` command
executes code explicitly. The LLM gets one optional tool, `bash`, because the
shell is the stable interface that works for source, settings, logs, and browser
state alike.
