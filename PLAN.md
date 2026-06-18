# DietSurf Plan

DietSurf is a minimal Chrome browser agent.

The whole idea is:

```text
service worker loads /src/agent.js -> agent asks LLM for shell commands -> shell runs them -> repeat
```

This is closer to Mini-SWE than to a browser automation framework. Mini-SWE gives the model a shell. DietSurf gives the agent a JS-like runtime inside a Chrome extension service worker.

The static extension is only a bootloader, host API, tiny virtual shell, and virtual UI renderer. The real plugin project lives in editable files stored in extension storage.

This is inversion of control: `worker.js` does not decide the agent loop. It loads `/src/agent.js`, and `/src/agent.js` decides what to ask the LLM, what command to execute, when to edit itself, and when to stop. The side panel loads the same `/src/agent.js` and calls its UI export.

## Minimal Code Shape

Keep the physical kernel to these files:

```text
manifest.json
worker.js
sidepanel.html
sidepanel.js
```

Package these as the default real/virtual project:

```text
package.json
manifest.json
bin/dietsurf-node.js
etc/llm.json
etc/browser.json
etc/profile
src/agent.js
src/runtime/chrome-puppeteer.js
src/ui.css
var/log/history.jsonl
home/user/notes.md
tmp/
```

Support files like `package.json` and a tiny build script are allowed only to bundle dependencies such as the LLM SDK and JS-like interpreter.

Add more files only when one of these becomes hard to read.

The physical extension files are the kernel. The virtual project files are the plugin.

Dev-only harnesses may live outside the virtual tree. For example, `scripts/extension-logger.mjs` can launch Chrome, load the unpacked extension, attach CDP logging to the service worker and side panel, and write logs under `logs/`. It is not seeded into the virtual filesystem and is not part of the agent's self-editable source.

The same project layout must exist on disk. The extension seeds its virtual filesystem from those files, and the Node runner executes those files directly from the real filesystem.

## Bootloader

`worker.js` should not own the browser-agent logic. It only loads and runs the editable agent source:

```js
const source = await readFile("/src/agent.js")
const mod = await runJslikeModule(source)
const result = await mod.main(host, argv)
```

On first install, copy the packaged virtual project into the virtual filesystem. After that, the side panel edits the stored copies.

Treat stored `/src/agent.js` as the plugin's real source code. The JavaScript bundle is just the kernel required to run it.

Use normal `.js` filenames for editable virtual files. They must be real JavaScript-shaped source files that can also run from real Node with the same runtime contract.

No transpiled agent source. No generated wrapper source. No extension-only syntax. `/src/agent.js` must be valid JavaScript accepted by both real Node and the JS-like runtime we choose.

The host object should be tiny:

```js
{
  argv,
  chrome,
  llm,
  shell,
  node,
  readFile,
  writeFile,
  listFiles,
  sleep,
  log,
  done
}
```

The agent can call Chrome extension APIs directly through that host object.

`runtime.chrome` exists in both modes:

- in the extension, it is the real Chrome extension API
- in real bash, it is a Puppeteer-backed Chrome facade

Use `puppeteer-core` for real-bash mode. Do not use full `puppeteer` in v0; browser installation is not the core idea.

Do not rely on magic globals in `/src/agent.js`. The script should receive a runtime object so the same file can run under:

- the extension kernel using JS-like execution
- real Node.js from a normal shell

Shape:

```js
export async function main(runtime, argv) {
  const { shell, llm, chrome, log, done } = runtime
  // agent code
}

export async function render(runtime) {
  const { document, shell, log } = runtime
  // side panel UI code
}
```

The extension loads `/src/agent.js`, evaluates it through the JS-like runtime, and calls `main(host, argv)`.

The side panel loads `/src/agent.js`, evaluates it through the JS-like runtime, and calls `render(uiRuntime)`.

A real Node runner must load the same file and call `main(nodeRuntime, process.argv.slice(2))`.

The repo on disk should have the same layout as the virtual filesystem. The extension seeds the virtual filesystem from those real files. The Node runner uses the real filesystem; the extension kernel uses the storage-backed virtual filesystem. Paths stay the same.

`bin/dietsurf-node.js` builds `runtime.chrome` by importing `/src/runtime/chrome-puppeteer.js`.

From real bash:

```bash
node bin/dietsurf-node.js "find the current page title"
```

No alternate agent file, no generated wrapper source, no extension-only agent semantics.

`node(code)` runs a JS-like snippet with the same host.

`node <file> [args...]` reads a virtual file and runs it with `argv`.

`shell(command)` is the Mini-SWE-style command executor. It should feel like a tiny shell with a tiny virtual filesystem plus `node`.

V0 shell commands:

```text
cat <file>
cat > <file> <<'EOF'
...
EOF
cat >> <file> <<'EOF'
...
EOF
ls [-R] [dir]
pwd
cd <dir>
touch <file>
rm <file>
mkdir <dir>
cp <from> <to>
mv <from> <to>
echo ...
node <<'EOF'
...
EOF
node <file> [args...]
jobs
kill <job>
```

Do not ship a full bash parser in v0. The shell is intentionally tiny:

- parse scripts line by line
- consume heredoc blocks for `cat >`, `cat >>`, and `node`
- use a small shell lexer for ordinary argv commands
- reject pipes, redirects other than the supported heredoc forms, variable expansion, globbing, subshells, and background jobs

Use `shlex` for ordinary command argument parsing. It is a small POSIX shell-like lexer, which is enough for `cat "/some file"` and similar argv cases. Heredocs and the supported redirections should be handled by the shell executor because they are command-level multi-line forms, not just argv tokenization.

The virtual filesystem lives in extension storage and should look like a normal plugin source tree:

```text
/package.json
/manifest.json
/bin/dietsurf-node.js
/etc/llm.json
/etc/browser.json
/etc/profile
/src/agent.js
/src/runtime/chrome-puppeteer.js
/src/ui.css
/var/log/history.jsonl
/home/user/notes.md
/tmp/
```

This tree is what the LLM sees. It can `ls`, `cat`, and edit files the same way it would inspect a tiny repo.

Settings are files. BYOK config lives at `/etc/llm.json`.

Browser runtime config lives at `/etc/browser.json`.

`/bin/dietsurf-node.js` is the real Node launcher for the same project tree. It builds a Node runtime object, loads `/src/agent.js`, and calls `main(runtime, argv)`.

`/src/runtime/chrome-puppeteer.js` provides the Chrome-shaped runtime for real bash. It should expose the smallest useful subset first:

```js
chrome.tabs.query(...)
chrome.scripting.executeScript(...)
```

Back those with Puppeteer pages. Add more Chrome-shaped APIs only when `/src/agent.js` actually needs them.

`cat /src/agent.js` reads the current agent source.

`cat > /src/agent.js <<'EOF' ... EOF` replaces the current agent source.

`cat >> /home/user/notes.md <<'EOF' ... EOF` appends to notes.

`node <<'EOF' ... EOF` runs JS-like code with the host object:

```bash
node <<'EOF'
log("hello from jslike")
EOF
```

The LLM is told it can execute a tiny bash-like shell. Basic file commands help it inspect and rewrite itself. `node` is the programmable command.

Runtime capabilities are explicit. In the extension runtime, `runtime.chrome` is the real extension API. In real Node, `runtime.chrome` is the Puppeteer-backed facade from `/src/runtime/chrome-puppeteer.js`. `/src/agent.js` should still avoid hidden globals and use only `runtime`.

`readFile(path)`, `writeFile(path, source)`, and `listFiles(path)` let the agent inspect and update the stored virtual project.

Example `agent.js` code:

```js
export async function main(runtime, argv) {
  const { chrome, log } = runtime

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })

  const [{ result: text }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => document.body.innerText
  })

  log(text.slice(0, 2000))
}
```

The default `/src/agent.js` implements the Mini-SWE-style loop itself:

```js
export async function main(runtime, argv) {
  const { shell, llm } = runtime
  const goal = argv.join(" ")
  const history = []

  for (let step = 0; step < 20; step++) {
    const command = await llm(
      "You are in a tiny bash-like shell.\n" +
      "Available commands: cat, ls, pwd, cd, touch, rm, mkdir, cp, mv, echo, node, jobs, kill.\n" +
      "Use cat > file <<'EOF' ... EOF to write files.\n" +
      "Use node <<'EOF' ... EOF to run JavaScript-like code.\n" +
      "This is your project tree:\n" + await shell("ls -R /") + "\n" +
      "Goal: " + goal + "\n" +
      "History: " + JSON.stringify(history)
    )

    const result = await shell(command)
    history.push({ command, result })
  }
}
```

## Minimal UI

Use the side panel as a tiny editable project view, not an app framework.

The physical `sidepanel.html` is only the kernel's mount point:

```html
<div id="app"></div>
<script src="sidepanel.js"></script>
```

`sidepanel.js` loads `/src/ui.css`, then loads `/src/agent.js` and calls `render(uiRuntime)` through the JS-like interpreter. The side panel UI is created with the DOM exposed in `uiRuntime`, not by the service worker touching DOM directly:

```js
{
  document,
  readFile,
  writeFile,
  listFiles,
  shell,
  interrupt,
  log
}
```

The default virtual UI should be tiny:

```html
<pre id="log"></pre>
<textarea id="prompt"></textarea>
```

No buttons. This is one terminal prompt, not a separate code editor. It uses a textarea only so bash heredocs can be entered directly.

Default commands:

```text
ls -R /
cat /src/agent.js
cat /etc/llm.json
cat > /etc/llm.json <<'EOF'
{
  "baseUrl": "https://api.getlilac.com/v1",
  "apiKey": "",
  "apiKeyEnv": "LILAC_API_KEY",
  "model": "minimaxai/minimax-m2.7"
}
EOF
cat > /src/agent.js <<'EOF'
...
EOF
node /src/agent.js "find the current page title"
jobs
kill 1
```

The important part is that every meaningful plugin file is editable from inside the extension. The user and the agent edit `/src/agent.js`, `/src/ui.css`, notes, prompts, or any later virtual file through shell commands. Writes persist immediately because the virtual filesystem is the source of truth.

This means the extension is also its own tiny agent shell.

Do not build a real terminal emulator or IDE. Use one shell prompt and a `<pre>`.

Do not try to rewrite the packaged extension files in v0. Chrome extension bundles are not a good self-editing target. The editable virtual project is the actual plugin code path.

## What V0 Must Do

1. Load as an unpacked MV3 Chrome extension.
2. Show a tiny side panel with a log and one shell input.
3. Let the user set OpenAI-compatible API settings by editing `/etc/llm.json`.
4. Let the user set browser runtime settings by editing `/etc/browser.json`.
5. Store `/etc/llm.json` and `/etc/browser.json` locally in the virtual filesystem.
6. Store the editable virtual project locally in the virtual filesystem.
7. Run `/src/agent.js` inside the service worker interpreter.
8. Run the same `/src/agent.js` from real bash through `node bin/dietsurf-node.js`.
9. Let the agent call explicit runtime APIs like `llm(...)`, `shell(...)`, `node(...)`, `readFile(...)`, `writeFile(...)`, `listFiles(...)`, and `chrome.*`.
10. Append output and errors to the log.
11. Stop when the agent calls `done(...)`, the user sends an interrupt, or the user kills the running job.

## BYOK LLM Call

DietSurf is BYOK: bring your own key.

Settings are a file, not fields or special commands:

```text
cat > /etc/llm.json <<'EOF'
{
  "baseUrl": "https://api.getlilac.com/v1",
  "apiKey": "",
  "apiKeyEnv": "LILAC_API_KEY",
  "model": "minimaxai/minimax-m2.7"
}
EOF
```

In real-bash mode, `bin/dietsurf-node.js` loads `.env` with dotenv, so `apiKeyEnv` can point at `LILAC_API_KEY`. In extension mode, Chrome cannot read local env vars; put the key in the virtual `/etc/llm.json` stored in `chrome.storage.local`. The dev logger does this automatically from `LILAC_API_KEY` when present.

Browser settings are also a file:

```text
cat > /etc/browser.json <<'EOF'
{
  "driver": "puppeteer-core",
  "headless": false,
  "executablePath": "",
  "userDataDir": "./tmp/chrome"
}
EOF
```

Default `baseUrl`:

```text
https://api.getlilac.com/v1
```

The virtual filesystem stores `/etc/llm.json` in `chrome.storage.local`:

```js
await writeFile("/etc/llm.json", JSON.stringify({ baseUrl, apiKey, apiKeyEnv, model }, null, 2))
```

Use a maintained SDK for the LLM call. Do not write an HTTP client by hand.

Use Vercel AI SDK with `@ai-sdk/openai-compatible`:

```js
import { generateText } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"

const { baseUrl, apiKey, apiKeyEnv, model } = JSON.parse(await readFile("/etc/llm.json"))
const key = apiKey || env[apiKeyEnv]

const provider = createOpenAICompatible({
  name: "byok",
  apiKey: key,
  baseURL: baseUrl
})

const { text } = await generateText({
  model: provider(model),
  messages,
  temperature: 0
})

const code = text
```

For v0, expect `llm(...)` to return shell text as plain text. The default `/src/agent.js` prompt should prefer `node <<'EOF' ... EOF` for programmable work.

This is still minimal: one provider constructor and one `generateText` call. No hosted proxy. No bundled API key. No account system.

## What V0 Must Not Do

- No custom browser DSL.
- No workflow engine.
- No planner.
- No multi-agent system.
- No debugger attach.
- No content-script framework.
- No backend.
- No database.
- No separate persistent memory system beyond the tiny virtual filesystem.
- No heavy UI.

## Minimal Code Implementation

Use these dependencies:

```json
{
  "dependencies": {
    "@ai-sdk/openai-compatible": "2.0.51",
    "ai": "6.0.208",
    "jslike": "1.8.11",
    "puppeteer-core": "25.1.0",
    "shlex": "3.0.0"
  },
  "devDependencies": {
    "esbuild": "0.28.1"
  }
}
```

Keep implementation files small and boring:

```text
worker.js                 extension kernel
sidepanel.html            physical mount point
sidepanel.js              physical side-panel kernel
bin/dietsurf-node.js      real bash runner
src/agent.js              actual agent
src/ui.css                virtual UI style
src/runtime/chrome-puppeteer.js
etc/llm.json
etc/browser.json
```

Implementation passes:

1. **Physical Extension Shell**
   - `manifest.json` declares MV3 service worker, side panel, storage, tabs, and scripting.
   - `sidepanel.html` is only:

```html
<div id="app"></div>
<script src="sidepanel.js"></script>
```

2. **Real Project Tree**
   - Create the on-disk project tree exactly like the virtual tree.
   - `src/agent.js` exports `main(runtime, argv)` and `render(runtime)`.
   - `bin/dietsurf-node.js` imports `src/agent.js` and calls `main(runtime, argv)`.

3. **Virtual Filesystem**
   - Store files in one `chrome.storage.local` object keyed by absolute path.
   - Implement only:

```js
readFile(path)
writeFile(path, text)
listFiles(path)
removeFile(path)
copyFile(from, to)
moveFile(from, to)
```

   - On first install, seed storage from packaged real project files.

4. **Tiny Shell**
   - Use `shlex.split(...)` for normal argv.
   - Support only:

```text
cat, ls, pwd, cd, touch, rm, mkdir, cp, mv, echo, node, jobs, kill
```

   - Support only these multiline forms:

```bash
cat > file <<'EOF'
...
EOF

cat >> file <<'EOF'
...
EOF

node <<'EOF'
...
EOF
```

5. **JS Runtime**
   - `node <file> [args...]` reads a file and executes it through `jslike`.
   - `node <<'EOF' ... EOF` executes the heredoc through `jslike`.
   - The executed module receives the explicit runtime object. No globals.

6. **LLM Runtime**
   - `llm(...)` reads `/etc/llm.json`.
   - It calls Vercel AI SDK with `@ai-sdk/openai-compatible`.
   - It returns plain text.

7. **Chrome Runtime**
   - Extension mode uses real `chrome`.
   - Real-bash mode uses `src/runtime/chrome-puppeteer.js`.
   - Implement only:

```js
chrome.tabs.query(...)
chrome.scripting.executeScript(...)
```

8. **Side Panel Kernel**
   - Load `/src/ui.css`.
   - Load `/src/agent.js` and call `render(uiRuntime)`.
   - Send the input line to `shell(command)`.
   - Append command/result records to `/var/log/history.jsonl`.

9. **Verification**
   - Extension:

```bash
node /src/agent.js "read current page title"
```

   - Real bash:

```bash
node bin/dietsurf-node.js "read current page title"
```

Both paths must execute the same `src/agent.js` source.

## First Implementation Order

1. Create MV3 `manifest.json` with `background.service_worker`, `side_panel`, `storage`, `tabs`, and `scripting`.
2. Create the real project files: `/package.json`, `/manifest.json`, `/bin/dietsurf-node.js`, `/etc/llm.json`, `/etc/browser.json`, `/etc/profile`, `/src/agent.js`, `/src/runtime/chrome-puppeteer.js`, `/src/ui.css`, `/var/log/history.jsonl`, `/home/user/notes.md`, and `/tmp/`.
3. Create `sidepanel.html` as a minimal mount point.
4. Route the side-panel input through the same `shell(command)` executor used by the agent.
5. Support `node <file> [args...]`, `jobs`, and `kill` plus filesystem commands. Do not add special settings commands.
6. Save editable project files, including `/etc/llm.json`, to the virtual filesystem.
7. Implement message passing from side panel to `worker.js`.
8. Add Vercel AI SDK plus `@ai-sdk/openai-compatible` and expose it as `llm(...)`.
9. Add `puppeteer-core` and implement `/src/runtime/chrome-puppeteer.js`.
10. Wire the JS-like interpreter into `worker.js`.
11. Expose the tiny host object.
12. Implement the tiny virtual filesystem in `chrome.storage.local`.
13. Implement the tiny `shell(command)` executor for `cat`, `ls`, `pwd`, `cd`, `touch`, `rm`, `mkdir`, `cp`, `mv`, `echo`, `node`, `jobs`, and `kill`, using `shlex` for argv and heredoc/redirection support for `cat >`, `cat >>`, and `node`.
14. Run `/src/agent.js` from the virtual filesystem.
15. Run the same agent from real bash with `node bin/dietsurf-node.js "..."`.
16. Test both extension mode and real-bash mode by reading a page title/body text.

## North Star

Keep the root readable in one sitting.

If a feature requires a new subsystem, it probably does not belong in v0.
