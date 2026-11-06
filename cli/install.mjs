// Turns the answers into a plan of file operations, then applies it.
//
// Files the package owns (hooks, docs, AGENT.md...) are tracked by hash in
// `.claude/stones.json`. On a re-run a file is updated only if it is still
// exactly what was installed; a file the user edited is left alone and
// reported, unless `--force`. JSON config the user may share with other
// tools (settings.json, .mcp.json) is merged instead of replaced.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { renderAgentDoc } from './agent-doc.mjs';
import { commandCatalog, docCatalog, hookCatalog, mcpCatalog, PACKAGE_ROOT } from './catalog.mjs';
import { composeSettings, mergeSettings } from './settings.mjs';

export const MANIFEST = '.claude/stones.json';
const GITIGNORE_LINES = ['.claude/graph/project.json', '.claude/settings.local.json'];
const HISTORY_GITIGNORE = ['.claude/history.db*'];

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const readText = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function loadManifest(target) {
  try {
    return JSON.parse(readFileSync(join(target, MANIFEST), 'utf8'));
  } catch {
    return { files: {} };
  }
}

// Desired content for every file this run manages.
function desiredFiles({ answers, stack, root }) {
  const files = [];
  const pkg = (rel) => readFileSync(join(root, rel), 'utf8');
  const hooks = hookCatalog(root).filter((h) => answers.install.hooks.includes(h.id));
  for (const hook of hooks) {
    files.push({ path: `.claude/hooks/${hook.file}`, content: pkg(`hooks/${hook.file}`), kind: 'managed', executable: hook.file.endsWith('.sh') });
  }
  if (answers.install.hooks.includes('graph')) {
    files.push({ path: '.claude/graph/README.md', content: pkg('graph/README.md'), kind: 'managed' });
    files.push({ path: '.claude/graph/project.json', content: pkg('graph/project.json'), kind: 'seed' });
  }
  if (answers.install.hooks.includes('testing')) {
    files.push({ path: 'context/tasks/active.md', content: pkg('context/tasks/active.md'), kind: 'managed' });
  }
  const docIds = new Set([...answers.install.docs, ...answers.patterns]);
  for (const doc of docCatalog(root).filter((d) => docIds.has(d.id))) {
    for (const rel of doc.files) files.push({ path: `.claude/docs/${rel}`, content: pkg(`docs/${rel}`), kind: 'managed' });
  }
  for (const command of commandCatalog(root)) {
    files.push({ path: `.claude/commands/${command.file}`, content: pkg(`commands/${command.file}`), kind: 'managed' });
  }

  const settings = composeSettings({
    hooks: answers.install.hooks,
    ecosystems: stack.ecosystems,
    packageManagers: stack.packageManagers,
    monorepo: stack.monorepo,
    commands: answers.workflow.commands,
    sandbox: answers.install.sandbox,
    jq: stack.tooling.jq,
    root,
  });
  files.push({ path: '.claude/settings.json', content: json(settings), kind: 'json', value: settings });

  const servers = mcpCatalog(root).filter((m) => answers.install.mcp.includes(m.id));
  if (servers.length) {
    const value = { mcpServers: Object.fromEntries(servers.map((m) => [m.id, m.config])) };
    files.push({ path: '.mcp.json', content: json(value), kind: 'json', value });
  }

  files.push({ path: 'AGENT.md', content: renderAgentDoc(answers, stack, root), kind: 'managed' });
  files.push({ path: 'CLAUDE.md', line: '@AGENT.md', content: '@AGENT.md\n', kind: 'line' });
  if (stack.git) {
    const ignored = [...GITIGNORE_LINES, ...(answers.install.hooks.includes('history') ? HISTORY_GITIGNORE : [])];
    for (const line of ignored) files.push({ path: '.gitignore', line, content: `${line}\n`, kind: 'line' });
  }
  return files;
}

// Decides, per file, what to do: create, update, merge, append, skip or conflict.
export function plan({ target, answers, stack, force = false, root = PACKAGE_ROOT }) {
  const manifest = loadManifest(target);
  const ops = [];
  const pending = new Map(); // appended lines per file, so one op per file

  for (const file of desiredFiles({ answers, stack, root })) {
    const abs = join(target, file.path);
    const current = readText(abs);
    const installed = manifest.files?.[file.path];
    const pristine = current !== undefined && installed === sha(current);

    if (file.kind === 'line') {
      const base = pending.get(file.path) ?? current ?? '';
      if (base.split('\n').some((l) => l.trim() === file.line)) continue;
      const next = `${base}${base && !base.endsWith('\n') ? '\n' : ''}${file.line}\n`;
      pending.set(file.path, next);
      continue;
    }
    if (current === undefined) {
      ops.push({ ...file, action: 'create' });
    } else if (current === file.content) {
      ops.push({ ...file, action: 'same' });
    } else if (file.kind === 'seed') {
      ops.push({ ...file, action: 'keep' });
    } else if (force || pristine) {
      ops.push({ ...file, action: 'update' });
    } else if (file.kind === 'json') {
      let existing;
      try {
        existing = JSON.parse(current);
      } catch {
        ops.push({ ...file, action: 'conflict', reason: 'existing file is not valid JSON' });
        continue;
      }
      const merged = json(mergeSettings(existing, file.value));
      ops.push({ ...file, content: merged, action: merged === current ? 'same' : 'merge' });
    } else {
      ops.push({ ...file, action: 'conflict', reason: 'edited since it was installed' });
    }
  }
  for (const [path, content] of pending) {
    ops.push({ path, content, kind: 'line', action: existsSync(join(target, path)) ? 'append' : 'create' });
  }
  return ops;
}

export function apply({ target, ops, answers, stack }) {
  const manifest = loadManifest(target);
  const files = { ...manifest.files };
  for (const op of ops) {
    const abs = join(target, op.path);
    if (['create', 'update', 'merge', 'append'].includes(op.action)) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, op.content);
      if (op.executable) chmodSync(abs, 0o755);
    }
    // Track what we own and wrote; merged/appended files stay the user's.
    if (op.kind === 'managed' && ['create', 'update', 'same'].includes(op.action)) files[op.path] = sha(op.content);
    if (op.kind === 'json' && ['create', 'update'].includes(op.action)) files[op.path] = sha(op.content);
  }
  const next = {
    $comment: 'Written by claude-stones: your setup answers and the files it installed. Re-run `npx claude-stones init` to update.',
    version: 1,
    generatedAt: new Date().toISOString(),
    stack: {
      languages: stack.languages, frameworks: stack.frameworks, packageManagers: stack.packageManagers,
      ecosystems: stack.ecosystems, monorepo: stack.monorepo,
    },
    answers,
    files,
  };
  mkdirSync(join(target, '.claude'), { recursive: true });
  writeFileSync(join(target, MANIFEST), json(next));
  return next;
}

const SYMBOLS = {
  create: '+', update: '~', merge: '⇄', append: '»', same: '=', keep: '=', conflict: '!',
};

export function describePlan(ops) {
  const order = ['create', 'update', 'merge', 'append', 'conflict', 'keep', 'same'];
  return [...ops]
    .sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action) || a.path.localeCompare(b.path))
    .filter((op) => op.action !== 'same')
    .map((op) => `  ${SYMBOLS[op.action]} ${op.action.padEnd(8)} ${op.path}${op.reason ? `  (${op.reason}; use --force to overwrite)` : ''}`)
    .join('\n');
}
