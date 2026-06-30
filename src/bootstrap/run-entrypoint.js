import { createEnvironment, execute } from "jslike";
import { createModuleResolver, createSourceFs } from "./source-fs.js";

function define(env, name, value) {
  if (value !== undefined) env.define(name, value);
}

function createBootstrapEnv(globals = {}) {
  const env = createEnvironment();
  for (const [name, value] of Object.entries(globals)) define(env, name, value);
  return env;
}

export async function runEntrypoint({
  entrypoint,
  defaultsUrl,
  globals,
  nativeModules
}) {
  const sourceFs = await createSourceFs(defaultsUrl);
  const source = await sourceFs.readFile(entrypoint);
  if (source === null) throw new Error(`missing source file: ${entrypoint}`);

  return execute(source, createBootstrapEnv(globals), {
    sourcePath: entrypoint,
    moduleResolver: createModuleResolver(sourceFs, nativeModules)
  });
}
