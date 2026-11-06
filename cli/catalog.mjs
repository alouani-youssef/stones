// What this package can install, read from the package's own folders so a
// new hook, doc or MCP server is offered as soon as it is added there.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

const nonEmpty = (file) => {
  try {
    return statSync(file).size > 0;
  } catch {
    return false;
  }
};

// Short descriptions for hooks whose files do not open with a comment.
const HOOK_HINTS = {
  guard: 'blocks reading secrets (.env*, private/) and git push',
  'block-rm': 'blocks rm commands',
  naming: 'enforces the project naming convention on new files',
  graph: 'gives Claude file summaries from OpenSpec and keeps the code graph',
  format: 'formats files after edits with the project formatter',
  complexity: 'flags functions an edit pushed over SonarQube\'s cognitive-complexity limit (Python, JS/TS, Go)',
  testing: 'requires clear test scenarios and guards spec/test edits unless expected behavior changes',
  'four-d': 'injects 4D engineering guardrails matched to each prompt\'s task and risk',
  history: 'logs prompts and replies per session to a local, git-ignored SQLite db (.claude/history.db)',
};

const HOOK_REQUIRES = { 'block-rm': ['jq'] };

function firstComment(file) {
  const text = readFileSync(file, 'utf8');
  const m = /^(?:#!.*\n)?\s*(?:\/\/|#)\s*(.+)/.exec(text);
  return m && !m[1].startsWith('!') ? m[1].trim() : undefined;
}

// Hooks registered in settings/hooks.json whose script exists and is not empty.
export function hookCatalog(root = PACKAGE_ROOT) {
  const config = readJson(join(root, 'settings', 'hooks.json'), {});
  const hooks = new Map();
  for (const [event, groups] of Object.entries(config)) {
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        const file = /hooks\/([\w.-]+\.(?:mjs|js|sh|py))/.exec(hook.command ?? '')?.[1];
        if (!file || !nonEmpty(join(root, 'hooks', file))) continue;
        const id = file.replace(/\.\w+$/, '');
        const entry = hooks.get(id) ?? {
          id,
          file,
          hint: HOOK_HINTS[id] ?? firstComment(join(root, 'hooks', file)) ?? '',
          requires: HOOK_REQUIRES[id] ?? [],
          events: [],
        };
        entry.events.push(`${event}:${group.matcher ?? '*'}`);
        hooks.set(id, entry);
      }
    }
  }
  return [...hooks.values()];
}

function docTitle(file) {
  const text = readFileSync(file, 'utf8');
  return /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
}

// First sentence after the title: used as the doc's one-line summary.
export function docLead(file) {
  const text = readFileSync(file, 'utf8').replace(/^#.*$/m, '');
  const para = text.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith('#'));
  return para ? /^[^.!?]*[.!?]/.exec(para.replace(/\s+/g, ' '))?.[0] ?? para : '';
}

// Every Markdown file under docs/, grouped by topic folder. Pattern docs are
// one topic each (`patterns/repository`); internal planning folders are left out.
export function docCatalog(root = PACKAGE_ROOT) {
  const docsRoot = join(root, 'docs');
  const topics = [];
  const visit = (rel) => {
    const abs = join(docsRoot, rel);
    const entries = readdirSync(abs, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile() && e.name.endsWith('.md') && nonEmpty(join(abs, e.name)));
    const dirs = entries.filter((e) => e.isDirectory());
    if (files.length) {
      const main = files.find((f) => /^(README|REAMDE)\.md$/i.test(f.name)) ?? files[0];
      topics.push({
        id: rel,
        title: docTitle(join(abs, main.name)) ?? rel,
        lead: docLead(join(abs, main.name)),
        main: `${rel}/${main.name}`,
        files: files.map((f) => `${rel}/${f.name}`),
        pattern: rel.startsWith('patterns/'),
      });
    }
    for (const d of dirs) visit(rel ? `${rel}/${d.name}` : d.name);
  };
  if (!existsSync(docsRoot)) return topics;
  for (const d of readdirSync(docsRoot, { withFileTypes: true })) {
    if (d.isDirectory() && d.name !== 'superpowers') visit(d.name);
  }
  return topics.sort((a, b) => a.id.localeCompare(b.id));
}

export function mcpCatalog(root = PACKAGE_ROOT) {
  const servers = readJson(join(root, 'mcps', 'mcp.json'), {}).mcpServers ?? {};
  return Object.entries(servers).map(([id, config]) => ({
    id,
    config: config.url && !config.type ? { type: 'http', ...config } : config,
    hint: config.url ?? [config.command, ...(config.args ?? [])].join(' '),
  }));
}

export function commandCatalog(root = PACKAGE_ROOT) {
  const dir = join(root, 'commands');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && nonEmpty(join(dir, f)))
    .map((f) => ({ id: f.replace(/\.md$/, ''), file: f }));
}

export const settingsSource = (name, root = PACKAGE_ROOT) =>
  readJson(join(root, 'settings', `${name}.json`), {});
