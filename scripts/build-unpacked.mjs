#!/usr/bin/env node
import { spawn } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_FILES } from "../src/kernel/project.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const unpacked = path.join(root, "build", "unpacked");
const runtimeDir = path.join(unpacked, "runtime");
const esbuild = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "esbuild.cmd" : "esbuild");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

async function copyIntoUnpacked(file) {
  const relative = file.replace(/^\/+/, "");
  const from = path.join(root, relative);
  const to = path.join(unpacked, relative);
  await mkdir(path.dirname(to), { recursive: true });
  await copyFile(from, to);
}

await rm(unpacked, { recursive: true, force: true });
await mkdir(runtimeDir, { recursive: true });
for (const file of PROJECT_FILES) await copyIntoUnpacked(file);

await run(esbuild, [
  "worker.js",
  "sidepanel.js",
  "--bundle",
  "--format=esm",
  "--target=chrome120",
  `--outdir=${runtimeDir}`
]);

console.log(`built ${path.relative(root, unpacked)}`);
