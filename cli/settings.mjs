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
  extraAllow = [],
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
    ...extraAllow,
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
const REMOVED = Symbol('removed');
const isEmpty = (v) => (Array.isArray(v) ? v.length === 0 : isObject(v) && Object.keys(v).length === 0);

// `existing` minus what stones generated last time (`previous`): array items
// and scalars that still equal what stones wrote are taken out, anything the
// user added or changed stays. Containers emptied this way are dropped.
export function subtractGenerated(existing, previous) {
  if (Array.isArray(existing) && Array.isArray(previous)) {
    const ours = new Set(previous.map((v) => JSON.stringify(v)));
    return existing.filter((v) => !ours.has(JSON.stringify(v)));
  }
  if (isObject(existing) && isObject(previous)) {
    const out = {};
    for (const [key, value] of Object.entries(existing)) {
      if (!(key in previous)) {
        out[key] = value;
        continue;
      }
      const rest = subtractGenerated(value, previous[key]);
      if (rest === REMOVED || (isEmpty(rest) && !isEmpty(value))) continue;
      out[key] = rest;
    }
    return out;
  }
  return JSON.stringify(existing) === JSON.stringify(previous) ? REMOVED : existing;
}

const HOOK_FILE = /\.claude\/hooks\/([\w.-]+\.(?:mjs|js|sh|py))/;

// Settings written before stones recorded what it generated: every hook
// entry that runs one of stones' own hook files is treated as stones'.
function withoutStonesHooks(settings, root) {
  if (!isObject(settings?.hooks)) return settings;
  const ours = new Set(hookCatalog(root).map((h) => h.file));
  const hooks = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups;
      continue;
    }
    const kept = groups
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((h) => !ours.has(HOOK_FILE.exec(h.command ?? '')?.[1])) }))
      .filter((group) => group.hooks.length);
    if (kept.length) hooks[event] = kept;
  }
  const out = { ...settings, hooks };
  if (!Object.keys(hooks).length) delete out.hooks;
  return out;
}

function union(existing, generated) {
  if (Array.isArray(existing) && Array.isArray(generated)) {
    const seen = new Set(existing.map((v) => JSON.stringify(v)));
    return [...existing, ...generated.filter((v) => !seen.has(JSON.stringify(v)))];
  }
  if (isObject(existing) && isObject(generated)) {
    const out = { ...existing };
    for (const [key, value] of Object.entries(generated)) {
      out[key] = key in existing ? union(existing[key], value) : value;
    }
    return out;
  }
  return existing === undefined ? generated : existing;
}

// Merges generated settings into a user's existing ones without losing their
// own keys: objects merge, arrays are unioned, the user's scalars win. What
// stones generated on the previous run (`previous`) is taken out first, so
// deselected hooks, declined options and changed hook definitions do not
// linger or duplicate. Without a previous snapshot, stones' hook entries are
// recognised by the hook file they run.
export function mergeSettings(existing, generated, previous, root = PACKAGE_ROOT) {
  const base = previous === undefined ? withoutStonesHooks(existing, root) : subtractGenerated(existing, previous);
  return union(base === REMOVED ? undefined : base, generated);
}
