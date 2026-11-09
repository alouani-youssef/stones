// Turns the answers into a plan of file operations, then applies it.
//
// Files the package owns (hooks, skills, AGENT.md...) are tracked by hash in
// `.claude/stones.json`. On a re-run a file is updated only if it is still
// exactly what was installed; a file the user edited is left alone and
// reported, unless `--force`. JSON config the user may share with other
// tools (settings.json, .mcp.json) is merged instead of replaced.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { renderDevcontainer } from '../hooks/devcontainer.mjs';
import { renderAgentDoc } from './agent-doc.mjs';
import { commandCatalog, hookCatalog, mcpCatalog, PACKAGE_ROOT, skillCatalog } from './catalog.mjs';
import { shippedDockerfile } from './devcontainer.mjs';
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

// The template merged with what detection found, so the hook starts configured.
function atomicitySeed(template, stack) {
  const config = JSON.parse(template);
  config.defaultBranch = stack.defaultBranch ?? config.defaultBranch;
  const migrations = stack.migrations;
  if (migrations) {
    config.migrations = { ...config.migrations, dirs: migrations.dirs, generate: migrations.generate };
    config.zones = { ...config.zones, db: { ...config.zones.db, extraPaths: migrations.models } };
  }
  return config;
}

// Desired content for every file this run manages.
const DC_DOCKERFILE = '.devcontainer/Dockerfile';
const DC_JSON = '.devcontainer/devcontainer.json';

// The dev container: the Dockerfile is seeded once and then belongs to the
// project; devcontainer.json is always generated from the project's copy.
function devcontainerFiles({ answers, target, root }) {
  const id = answers.install.devcontainer;
  if (!id) return [];
  const seed = shippedDockerfile(id, root);
  const source = readText(join(target, DC_DOCKERFILE)) ?? seed;
  const json = { path: DC_JSON, kind: 'generated' };
  try {
    json.content = renderDevcontainer(source, { name: basename(target) });
  } catch (error) {
    json.error = error.message;
  }
  return [{ path: DC_DOCKERFILE, content: seed, kind: 'seed', tracked: true }, json];
}

function desiredFiles({ answers, stack, root, target }) {
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
  if (answers.install.hooks.includes('atomicity')) {
    files.push({ path: '.claude/atomicity.json', content: json(atomicitySeed(pkg('settings/atomicity.json'), stack)), kind: 'seed' });
    files.push({ path: '.claude/danger/.gitkeep', content: '', kind: 'seed' });
  }
  const skillIds = new Set([...answers.install.skills, ...answers.patterns]);
  for (const skill of skillCatalog(root).filter((s) => skillIds.has(s.id))) {
    for (const rel of skill.files) files.push({ path: `.claude/skills/${rel}`, content: pkg(`skills/${rel}`), kind: 'managed' });
  }
  for (const command of commandCatalog(root)) {
    files.push({ path: `.claude/commands/${command.file}`, content: pkg(`commands/${command.file}`), kind: 'managed' });
  }

  const settings = composeSettings({
    hooks: answers.install.hooks,
    plugins: answers.install.plugins ?? [],
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

  files.push(...devcontainerFiles({ answers, target, root }));

  files.push({ path: 'AGENT.md', content: renderAgentDoc(answers, stack, root), kind: 'managed' });
  files.push({ path: 'CLAUDE.md', line: '@AGENT.md', content: '@AGENT.md\n', kind: 'line' });
  if (stack.git) {
    const ignored = [...GITIGNORE_LINES, ...(answers.install.hooks.includes('history') ? HISTORY_GITIGNORE : [])];
    for (const line of ignored) files.push({ path: '.gitignore', line, content: `${line}\n`, kind: 'line' });
  }
  return files;
}

function recordPendingLine(pending, file, current) {
  const base = pending.get(file.path) ?? current ?? '';
  if (base.split('\n').some((l) => l.trim() === file.line)) return;
  const separator = base && !base.endsWith('\n') ? '\n' : '';
  pending.set(file.path, `${base}${separator}${file.line}\n`);
}

function planGenerated(file, current) {
  if (file.error) {
    return { ...file, action: 'conflict', reason: file.error };
  }
  if (current === undefined) {
    return { ...file, action: 'create' };
  }
  return { ...file, action: current === file.content ? 'same' : 'update' };
}

function planJson(file, current) {
  let existing;
  try {
    existing = JSON.parse(current);
  } catch {
    return { ...file, action: 'conflict', reason: 'existing file is not valid JSON' };
  }
  const merged = json(mergeSettings(existing, file.value));
  return { ...file, content: merged, action: merged === current ? 'same' : 'merge' };
}

function planFileOp(file, current, manifest, force) {
  if (file.kind === 'generated') {
    return planGenerated(file, current);
  }
  if (current === undefined) {
    return { ...file, action: 'create' };
  }
  if (current === file.content) {
    return { ...file, action: 'same' };
  }
  if (file.kind === 'seed') {
    return { ...file, action: 'keep' };
  }
  const pristine = manifest.files?.[file.path] === sha(current);
  if (force || pristine) {
    return { ...file, action: 'update' };
  }
  if (file.kind === 'json') {
    return planJson(file, current);
  }
  return { ...file, action: 'conflict', reason: 'edited since it was installed' };
}

function planPendingLines(target, pending) {
  return Array.from(pending, ([path, content]) => ({
    path,
    content,
    kind: 'line',
    action: existsSync(join(target, path)) ? 'append' : 'create',
  }));
}

// Decides, per file, what to do: create, update, merge, append, skip or conflict.
export function plan({ target, answers, stack, force = false, root = PACKAGE_ROOT }) {
  const manifest = loadManifest(target);
  const ops = [];
  const pending = new Map(); // appended lines per file, so one op per file

  // A .devcontainer/ the project already had is theirs, not ours.
  const foreignDevcontainer = existsSync(join(target, '.devcontainer')) && !manifest.files?.[DC_DOCKERFILE];

  for (const file of desiredFiles({ answers, stack, root, target })) {
    if (!force && foreignDevcontainer && file.path.startsWith('.devcontainer/')) {
      ops.push({ ...file, action: 'conflict', reason: 'existing .devcontainer not installed by stones' });
      continue;
    }

    const current = readText(join(target, file.path));

    if (file.kind === 'line') {
      recordPendingLine(pending, file, current);
      continue;
    }

    ops.push(planFileOp(file, current, manifest, force));
  }

  ops.push(...planPendingLines(target, pending));
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
    if (['managed', 'generated'].includes(op.kind) && ['create', 'update', 'same'].includes(op.action)) files[op.path] = sha(op.content);
    // A tracked seed records that stones installed it, so later runs treat it as ours.
    if (op.tracked && op.action === 'create') files[op.path] = sha(op.content);
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
