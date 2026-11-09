// Composes `.claude/settings.json` from the modular sources in settings/,
// keeping only what the project uses: the selected hooks, permissions for
// the project's own commands, and sandbox domains for its ecosystems.
import { hookCatalog, PACKAGE_ROOT, pluginCatalog, settingsSource } from './catalog.mjs';

const unique = (items) => [...new Set(items)];

// `npm run test` -> `Bash(npm run test:*)`, `go test ./...` -> `Bash(go test:*)`:
// keep the words up to the first path or flag argument.
export function commandRule(command) {
  const words = command.trim().split(/\s+/);
  const stop = words.findIndex((w, i) => i > 0 && /^[-.\/]/.test(w));
  const head = (stop > 0 ? words.slice(0, stop) : words).join(' ');
  return head ? `Bash(${head}:*)` : undefined;
}

export function composeSettings({
  hooks = [],
  plugins = [],
  ecosystems = [],
  packageManagers = [],
  monorepo = null,
  commands = {},
  sandbox = true,
  jq = true,
  root = PACKAGE_ROOT,
} = {}) {
  const global = settingsSource('global', root);
  const permissions = settingsSource('permissions', root);
  const hookSource = settingsSource('hooks', root);
  const sandboxSource = settingsSource('sandbox', root);
  const stacks = settingsSource('stacks', root);

  const stackKeys = unique([...ecosystems, ...packageManagers, monorepo].filter(Boolean));
  const fromStacks = (key) => stackKeys.flatMap((k) => stacks[k]?.[key] ?? []);

  const allow = unique([
    ...(permissions.allow ?? []),
    ...fromStacks('permissions'),
    ...Object.values(commands).filter(Boolean).map(commandRule).filter(Boolean),
  ]);

  const selected = new Set(hooks);
  const files = new Map(hookCatalog(root).map((h) => [h.file, h.id]));
  const hookConfig = {};
  for (const [event, groups] of Object.entries(hookSource)) {
    const kept = groups
      .map((group) => ({
        ...group,
        hooks: (group.hooks ?? []).filter((h) => {
          const file = /hooks\/([\w.-]+\.(?:mjs|js|sh|py))/.exec(h.command ?? '')?.[1];
          return file && selected.has(files.get(file));
        }),
      }))
      .filter((group) => group.hooks.length);
    if (kept.length) hookConfig[event] = kept;
  }

  const settings = { $schema: 'https://json.schemastore.org/claude-code-settings.json', ...global };
  // The status line is a jq one-liner; drop it where jq is missing.
  if (!jq && /\bjq\b/.test(settings.statusLine?.command ?? '')) delete settings.statusLine;
  settings.permissions = { ...permissions, allow };
  if (Object.keys(hookConfig).length) settings.hooks = hookConfig;
  const enabled = pluginCatalog(root).filter((p) => plugins.includes(p.id));
  if (enabled.length) {
    settings.enabledPlugins = Object.fromEntries(enabled.map((p) => [p.key, true]));
    const markets = enabled.filter((p) => p.marketplaceSource).map((p) => [p.marketplace, { source: p.marketplaceSource }]);
    if (markets.length) settings.extraKnownMarketplaces = Object.fromEntries(markets);
  }
  if (sandbox) {
    settings.sandbox = {
      ...sandboxSource,
      enabled: true,
      network: {
        ...sandboxSource.network,
        allowedDomains: unique([...(sandboxSource.network?.allowedDomains ?? []), ...fromStacks('domains')]),
      },
    };
  }
  return settings;
}

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Merges generated settings into a user's existing ones without losing
// anything: objects merge, arrays are unioned, existing scalars win.
export function mergeSettings(existing, generated) {
  if (Array.isArray(existing) && Array.isArray(generated)) {
    const seen = new Set(existing.map((v) => JSON.stringify(v)));
    return [...existing, ...generated.filter((v) => !seen.has(JSON.stringify(v)))];
  }
  if (isObject(existing) && isObject(generated)) {
    const out = { ...existing };
    for (const [key, value] of Object.entries(generated)) {
      out[key] = key in existing ? mergeSettings(existing[key], value) : value;
    }
    return out;
  }
  return existing === undefined ? generated : existing;
}
