#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, chmod, copyFile, cp, mkdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const root = process.cwd();
const chromePath =
  process.env.CHROME_PATH ||
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "");
const buildDir = path.join(root, "build");
const unpacked = path.join(buildDir, "unpacked");
const packSrc = path.join(buildDir, "pack-src");
const crxOut = path.join(buildDir, "plugin.crx");
const keyDir = process.env.DIETSURF_KEY_DIR || path.join(homedir(), ".dietsurf");
const pemOut = process.env.DIETSURF_PLUGIN_KEY || path.join(keyDir, "plugin.pem");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

if (!chromePath) throw new Error("set CHROME_PATH");

await run("npm", ["run", "build"]);
await mkdir(keyDir, { recursive: true });
await rm(packSrc, { recursive: true, force: true });
await mkdir(path.dirname(packSrc), { recursive: true });
await cp(unpacked, packSrc, { recursive: true });

const args = [`--pack-extension=${packSrc}`];
if (await exists(pemOut)) args.push(`--pack-extension-key=${pemOut}`);
await run(chromePath, args);

const packedCrx = `${packSrc}.crx`;
const packedPem = `${packSrc}.pem`;
await copyFile(packedCrx, crxOut);
if (!(await exists(pemOut)) && await exists(packedPem)) await copyFile(packedPem, pemOut);
if (await exists(pemOut)) await chmod(pemOut, 0o600);
await rm(packSrc, { recursive: true, force: true });
await rm(packedCrx, { force: true });
await rm(packedPem, { force: true });

const { size } = await stat(crxOut);

console.log(`built ${path.relative(root, crxOut)} (${Math.round(size / 1024)} KiB)`);
console.log(`load unpacked from ${path.relative(root, unpacked)}`);
if (await exists(pemOut)) console.log(`using signing key ${pemOut}`);
