// Regenerates settings/settings.json: the settings this template produces for
// its own repository, with every available hook enabled. Target projects get
// a tailored version from `npx claude-stones init`.
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hookCatalog } from '../cli/catalog.mjs';
import { detect } from '../cli/detect.mjs';
import { composeSettings } from '../cli/settings.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const stack = detect(join(directory, '..'));

const settings = composeSettings({
  hooks: hookCatalog().map((h) => h.id),
  ecosystems: stack.ecosystems,
  packageManagers: stack.packageManagers,
  monorepo: stack.monorepo,
  commands: stack.commands,
});

await writeFile(join(directory, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
