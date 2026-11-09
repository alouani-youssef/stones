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
  access_guard: 'blocks paths outside the project root, secrets (.env*, private/) and git push',
  'block-rm': 'blocks rm commands',
  naming: 'enforces the project naming convention on new files',
  graph: 'gives Claude file summaries from OpenSpec and keeps the code graph',
  format: 'formats files after edits with the project formatter',
  complexity: 'flags functions an edit pushed over SonarQube\'s cognitive-complexity limit (Python, JS/TS, Go)',
  testing: 'requires clear test scenarios and guards spec/test edits unless expected behavior changes',
  atomicity: 'blocks mixed commits/branches and requires dedicated, specced branches for db, packages and network changes',
  'four-d': 'injects 4D engineering guardrails matched to each prompt\'s task and risk',
  devcontainer: 'regenerates .devcontainer/devcontainer.json whenever its Dockerfile is edited',
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

// SKILL.md frontmatter: top-level `key: value` pairs and one nested
// `metadata:` map (title, summary, kind), which is all the skills here use.
export function skillFrontmatter(text) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const out = { metadata: {} };
  if (!block) return out;
  let inMetadata = false;
  for (const line of block.split(/\r?\n/)) {
    const m = /^(\s*)([\w-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, indent, key, raw] = m;
    const value = raw.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!indent) {
      inMetadata = key === 'metadata' && !value;
      if (!inMetadata) out[key] = value;
    } else if (inMetadata) {
      out.metadata[key] = value;
    }
  }
  return out;
}

const filesUnder = (dir, rel = '') => readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
  const path = rel ? `${rel}/${e.name}` : e.name;
  if (e.isDirectory()) return filesUnder(dir, path);
  return e.isFile() && nonEmpty(join(dir, path)) ? [path] : [];
});

// Every `skills/<name>/SKILL.md`, installed as a Claude Code project skill in
// `.claude/skills/<name>/`. Folders without a SKILL.md are drafts and skipped.
// `metadata.kind: pattern` marks design-pattern skills, offered per stack.
export function skillCatalog(root = PACKAGE_ROOT) {
  const skillsRoot = join(root, 'skills');
  if (!existsSync(skillsRoot)) return [];
  const skills = [];
  for (const d of readdirSync(skillsRoot, { withFileTypes: true })) {
    const main = join(skillsRoot, d.name, 'SKILL.md');
    if (!d.isDirectory() || !nonEmpty(main)) continue;
    const fm = skillFrontmatter(readFileSync(main, 'utf8'));
    skills.push({
      id: d.name,
      title: fm.metadata.title || fm.name || d.name,
      lead: fm.metadata.summary || fm.description || '',
      description: fm.description || '',
      main: `${d.name}/SKILL.md`,
      files: filesUnder(join(skillsRoot, d.name)).sort().map((f) => `${d.name}/${f}`),
      pattern: fm.metadata.kind === 'pattern',
    });
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

// Guide ids from before guides became skills, so saved answers keep working.
export const LEGACY_SKILL_IDS = {
  atomicity: 'atomic-changes',
  creation: 'creating-files-and-modules',
  naming: 'naming-files',
  tdd: 'test-first-development',
  testings: 'writing-tests',
  types: 'defining-types',
  'patterns/complexity': 'managing-complexity',
  'patterns/dependency-injection': 'dependency-injection',
  'patterns/modularity': 'modular-design',
  'patterns/repository': 'repository-pattern',
  'patterns/reusability': 'reusing-code',
  'patterns/summary-details': 'summary-details-responses',
};

export const currentSkillIds = (ids) =>
  Array.isArray(ids) ? [...new Set(ids.map((id) => LEGACY_SKILL_IDS[id] ?? id))] : ids;

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
