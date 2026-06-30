#!/usr/bin/env node
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const unpacked = path.join(root, "build", "unpacked");
const runtimeDir = path.join(unpacked, "runtime");
const esbuild = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "esbuild.cmd" : "esbuild");
const packagedFiles = [
  { from: "manifest.json", to: "manifest.json" },
  { from: "src/runtime/sidepanel.html", to: "sidepanel.html" },
  { from: "src/runtime/options.html", to: "options.html" },
  { from: "etc/llm.json", to: "etc/llm.json" }
];
const sourceFiles = [
  { path: "/src/runtime/worker.js", file: "src/runtime/worker.js" },
  { path: "/src/runtime/sidepanel.js", file: "src/runtime/sidepanel.js" },
  { path: "/src/runtime/options.js", file: "src/runtime/options.js" },
  { path: "/src/agent.js", file: "src/agent.js" },
  { path: "/src/kernel/jslike.js", file: "src/kernel/jslike.js" },
  { path: "/src/llm/api.js", file: "src/llm/api.js" }
];

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

async function copyIntoUnpacked({ from, to }) {
  const target = path.join(unpacked, to);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(root, from), target);
}

async function writeSourceDefaults() {
  const files = await Promise.all(sourceFiles.map(async ({ path: sourcePath, file }) => ({
    path: sourcePath,
    source: await readFile(path.join(root, file), "utf8")
  })));
  await writeFile(path.join(runtimeDir, "sources.json"), JSON.stringify({ files }, null, 2));
}

await rm(unpacked, { recursive: true, force: true });
await mkdir(runtimeDir, { recursive: true });
for (const file of packagedFiles) await copyIntoUnpacked(file);
await writeSourceDefaults();

await run(esbuild, [
  "src/bootstrap/worker-bootstrap.js",
  "src/bootstrap/sidepanel-bootstrap.js",
  "src/bootstrap/options-bootstrap.js",
  "--bundle",
  "--format=esm",
  "--target=chrome120",
  `--outdir=${runtimeDir}`
]);

console.log(`built ${path.relative(root, unpacked)}`);
