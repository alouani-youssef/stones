import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));

async function readConfig(name) {
  return JSON.parse(await readFile(join(directory, name), "utf8"));
}

const [global, permissions, hooks, sandbox] = await Promise.all([
  readConfig("global.json"),
  readConfig("permissions.json"),
  readConfig("hooks.json"),
  readConfig("sandbox.json"),
]);

const settings = {
  $schema: "https://json.schemastore.org/claude-code-settings.json",
  ...global,
  permissions,
  hooks,
  sandbox,
};

await writeFile(
  join(directory, "settings.json"),
  `${JSON.stringify(settings, null, 2)}\n`,
);
