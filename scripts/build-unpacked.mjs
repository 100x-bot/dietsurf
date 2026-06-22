#!/usr/bin/env node
import "dotenv/config";
import { spawn } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const unpacked = path.join(root, "build", "unpacked");
const runtimeDir = path.join(unpacked, "runtime");
const esbuild = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "esbuild.cmd" : "esbuild");
const packagedFiles = ["manifest.json", "sidepanel.html", "etc/llm.json"];

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

async function copyIntoUnpacked(relative) {
  const to = path.join(unpacked, relative);
  await mkdir(path.dirname(to), { recursive: true });
  await copyFile(path.join(root, relative), to);
}

async function injectLocalLlmKey() {
  if (!process.env.LILAC_API_KEY) return false;
  await writeFile(path.join(unpacked, "etc", "llm.json"), JSON.stringify({
    baseUrl: "https://api.getlilac.com/v1",
    apiKey: process.env.LILAC_API_KEY,
    apiKeyEnv: "LILAC_API_KEY",
    model: "minimaxai/minimax-m2.7"
  }, null, 2));
  return true;
}

await rm(unpacked, { recursive: true, force: true });
await mkdir(runtimeDir, { recursive: true });
for (const file of packagedFiles) await copyIntoUnpacked(file);
const injectedKey = await injectLocalLlmKey();

await run(esbuild, [
  "worker.js",
  "sidepanel.js",
  "--bundle",
  "--format=esm",
  "--target=chrome120",
  `--outdir=${runtimeDir}`
]);

console.log(`built ${path.relative(root, unpacked)}`);
if (injectedKey) console.log("injected LILAC_API_KEY into ignored build artifacts");
