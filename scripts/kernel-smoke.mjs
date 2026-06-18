import assert from "node:assert/strict";
import { createRuntime } from "../kernel.js";

function createMemoryRuntime(initial = {}) {
  const files = new Map(Object.entries(initial));
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
        return [...files.keys()].filter((file) => file === path || file.startsWith(prefix));
      },
      removeFile: async (path) => {
        files.delete(path);
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

await runtime.shell('node -e \'await fs.promises.writeFile("/tmp/d","ok"); console.log("Done")\'');
assert.equal(files.get("/tmp/d"), "ok");

await assert.rejects(
  runtime.shell('node -e \'fs.writeFileSync("/tmp/e","bad")\''),
  /writeFileSync/
);

console.log("kernel smoke passed");
