import assert from "node:assert/strict";
import { createRuntime, runSource } from "../kernel.js";

function createMemoryRuntime(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set(["/"]);
  for (const path of files.keys()) {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts.slice(0, -1)) {
      current += `/${part}`;
      dirs.add(current);
    }
  }
  const mkdirp = (path) => {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      dirs.add(current);
    }
  };
  return {
    files,
    runtime: createRuntime({
      readFile: async (path) => {
        if (!files.has(path)) throw new Error(`no such file: ${path}`);
        return files.get(path);
      },
      readFileSync: (path) => {
        if (!files.has(path)) throw new Error(`no such file: ${path}`);
        return files.get(path);
      },
      writeFile: async (path, text) => {
        files.set(path, String(text));
      },
      listFiles: async (path = "/") => {
        const prefix = path === "/" ? "/" : `${path.replace(/\/$/, "")}/`;
        return [...new Set([...dirs, ...files.keys()])].filter((file) => file === path || file.startsWith(prefix));
      },
      removeFile: async (path) => {
        files.delete(path);
      },
      mkdir: async (path, options = {}) => {
        if (options.recursive) {
          mkdirp(path);
          return;
        }
        const parent = path.slice(0, path.lastIndexOf("/")) || "/";
        if (!dirs.has(parent)) throw new Error(`no such directory: ${parent}`);
        dirs.add(path);
      },
      env: {},
      log: () => undefined
    })
  };
}

const { runtime, files } = createMemoryRuntime({
  "/src/ui.css": ":root {\n  color-scheme: dark;\n  background: #080808;\n}\n"
});

await runtime.shell("cat > /tmp/a << 'EOF'\nhello\nEOF");
assert.equal(files.get("/tmp/a"), "hello");

await runtime.shell("cat >/tmp/b<<'EOF'\nhello\nEOF");
assert.equal(files.get("/tmp/b"), "hello");

await runtime.shell("cat <<'EOF' > /tmp/c\nhello\nEOF");
assert.equal(files.get("/tmp/c"), "hello");

assert.equal(await runtime.shell('printf "%s\\n" hello'), "hello\n");
assert.equal(await runtime.shell('node -p "1 + 1"'), "2");

await runtime.shell("sed -i 's/#080808/#ffffff/g; s/dark/light/g' /src/ui.css");
assert.equal(files.get("/src/ui.css"), ":root {\n  color-scheme: light;\n  background: #ffffff;\n}\n");

await runtime.shell("mkdir -p /tmp/a/b");
assert.ok((await runtime.listFiles("/tmp")).includes("/tmp/a/b"));

await runtime.shell("cat > /tmp/sed.txt <<'EOF'\none\ntwo\nthree\nfour\nEOF");
assert.equal(await runtime.shell("sed -n '2,3p' /tmp/sed.txt"), "two\nthree");
assert.equal(await runtime.shell("sed '/two/,/three/d' /tmp/sed.txt"), "one\nfour");
assert.equal(await runtime.shell("sed '2s/two/TWO/' /tmp/sed.txt"), "one\nTWO\nthree\nfour");
await assert.rejects(runtime.shell("for x in a b; do echo $x; done"), /shell loops are not supported/);
await assert.rejects(runtime.shell("echo hi &"), /background jobs/);

await runtime.shell('node -e \'await fs.promises.writeFile("/tmp/d","ok"); console.log("Done")\'');
assert.equal(files.get("/tmp/d"), "ok");

await assert.rejects(
  runtime.shell('node -e \'fs.writeFileSync("/tmp/e","bad")\''),
  /writeFileSync/
);

const storage = new Map();
runtime.document = { documentElement: { dataset: {} } };
runtime.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value))
};
runtime.matchMedia = (query) => ({ media: query, matches: query.includes("dark") });
runtime.window = {
  localStorage: runtime.localStorage,
  matchMedia: runtime.matchMedia
};

await runSource(runtime, `
  const stored = localStorage.getItem("dietsurf-theme");
  const theme = stored || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
  window.localStorage.setItem("dietsurf-theme", theme);
`, "/tmp/ui-globals-smoke.js");

assert.equal(runtime.document.documentElement.dataset.theme, "dark");
assert.equal(storage.get("dietsurf-theme"), "dark");

console.log("kernel smoke passed");
