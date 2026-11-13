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
import { LIST_DIR, STATE_DIR, STATE_HEADERS, STATES } from '../tools/tasks.mjs';

export const MANIFEST = '.claude/stones.json';
const GITIGNORE_LINES = ['.claude/graph/project.json', '.claude/settings.local.json', '.claude/quality/', '.claude/pr.md'];
const HISTORY_GITIGNORE = ['.claude/history.db*'];
const FOUR_D_GITIGNORE = ['.claude/four-d.log'];
const TASKS_GITIGNORE = ['.claude/reviews/'];
export const TASK_TOOLS = ['tasks.mjs', 'review.mjs'];
// Installed in every project. All but create-pr are allowed in settings.json;
// create-pr opens a pull request on GitHub, so Claude asks before running it.
export const PROJECT_TOOLS = [
  'list-packages.mjs', 'git-comments.mjs', 'worktree-history.mjs',
  'quality-check.mjs', 'roadmap.mjs', 'sync-docs.mjs', 'create-pr.mjs',
];
const ASK_FIRST_TOOLS = new Set(['create-pr.mjs']);
// The single task note for projects without the task board.
const LEGACY_TASK_NOTE = `# Active task

Fill this note before running tests. Keep it scoped to the current task.

## Expected behavior

TODO: Describe the behavior the source should provide.

## Scenarios

- Scenario: TODO: describe an input or condition. Expected: TODO: describe the observable result.

## Contract change

none
`;
const usesTaskBoard = (answers) => answers.install.skills.includes('tracking-tasks');

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

function hookFiles(answers, root, pkg) {
  const files = [];
  const hooks = answers.install.hooks;
  for (const hook of hookCatalog(root).filter((h) => hooks.includes(h.id))) {
    files.push({
      path: `.claude/hooks/${hook.file}`,
      content: pkg(`hooks/${hook.file}`),
      kind: 'managed',
      executable: hook.file.endsWith('.sh'),
    });
  }
  if (hooks.includes('graph')) {
    files.push({ path: '.claude/graph/README.md', content: pkg('graph/README.md'), kind: 'managed' });
    files.push({ path: '.claude/graph/project.json', content: pkg('graph/project.json'), kind: 'seed' });
  }
  return files;
}

function toolFiles(answers, pkg) {
  const files = PROJECT_TOOLS.map((tool) => ({
    path: `.claude/tools/${tool}`,
    content: pkg(`tools/${tool}`),
    kind: 'managed',
  }));
  if (usesTaskBoard(answers)) {
    for (const tool of TASK_TOOLS) files.push({ path: `.claude/tools/${tool}`, content: pkg(`tools/${tool}`), kind: 'managed' });
    for (const state of STATES) files.push({ path: `${STATE_DIR}/${state}.md`, content: `${STATE_HEADERS[state]}\n`, kind: 'seed' });
    files.push({ path: `${LIST_DIR}/.gitkeep`, content: '', kind: 'seed' });
  } else if (answers.install.hooks.includes('testing')) {
    files.push({ path: 'context/tasks/active.md', content: LEGACY_TASK_NOTE, kind: 'managed' });
  }
  return files;
}

function atomicityFiles(answers, stack, pkg) {
  if (!answers.install.hooks.includes('atomicity')) return [];
  return [
    { path: '.claude/atomicity.json', content: json(atomicitySeed(pkg('settings/atomicity.json'), stack)), kind: 'seed' },
    { path: '.claude/danger/.gitkeep', content: '', kind: 'seed' },
  ];
}

function skillFiles(answers, root, pkg) {
  const skillIds = new Set([...answers.install.skills, ...answers.patterns]);
  const files = [];
  for (const skill of skillCatalog(root).filter((s) => skillIds.has(s.id))) {
    for (const rel of skill.files) {
      files.push({ path: `.claude/skills/${rel}`, content: pkg(`skills/${rel}`), kind: 'managed' });
    }
  }
  return files;
}

function settingsFile(answers, stack, root) {
  const extraAllow = [
    ...PROJECT_TOOLS.filter((tool) => !ASK_FIRST_TOOLS.has(tool)).map((tool) => `Bash(node .claude/tools/${tool}:*)`),
    ...(usesTaskBoard(answers) ? ['Bash(node .claude/tools/tasks.mjs:*)'] : []),
  ];
  const settings = composeSettings({
    hooks: answers.install.hooks,
    plugins: answers.install.plugins ?? [],
    ecosystems: stack.ecosystems,
    packageManagers: stack.packageManagers,
    monorepo: stack.monorepo,
    commands: answers.workflow.commands,
    sandbox: answers.install.sandbox,
    jq: stack.tooling.jq,
    extraAllow,
    root,
  });
  return { path: '.claude/settings.json', content: json(settings), kind: 'json', value: settings };
}

function mcpFiles(answers, root) {
  const servers = mcpCatalog(root).filter((m) => answers.install.mcp.includes(m.id));
  if (!servers.length) return [];
  const value = { mcpServers: Object.fromEntries(servers.map((m) => [m.id, m.config])) };
  return [{ path: '.mcp.json', content: json(value), kind: 'json', value }];
}

function gitignoreFiles(answers, stack) {
  if (!stack.git) return [];
  const hooks = answers.install.hooks;
  const ignored = [
    ...GITIGNORE_LINES,
    ...(hooks.includes('history') ? HISTORY_GITIGNORE : []),
    ...(hooks.includes('four-d') ? FOUR_D_GITIGNORE : []),
    ...(usesTaskBoard(answers) ? TASKS_GITIGNORE : []),
  ];
  return ignored.map((line) => ({ path: '.gitignore', line, content: `${line}\n`, kind: 'line' }));
}

function desiredFiles({ answers, stack, root, target }) {
  const pkg = (rel) => readFileSync(join(root, rel), 'utf8');
  return [
    ...hookFiles(answers, root, pkg),
    ...toolFiles(answers, pkg),
    ...atomicityFiles(answers, stack, pkg),
    ...skillFiles(answers, root, pkg),
    ...commandCatalog(root).map((cmd) => ({
      path: `.claude/commands/${cmd.file}`,
      content: pkg(`commands/${cmd.file}`),
      kind: 'managed',
    })),
    settingsFile(answers, stack, root),
    ...mcpFiles(answers, root),
    ...devcontainerFiles({ answers, target, root }),
    { path: 'AGENT.md', content: renderAgentDoc(answers, stack, root), kind: 'managed' },
    { path: 'CLAUDE.md', line: '@AGENT.md', content: '@AGENT.md\n', kind: 'line' },
    ...gitignoreFiles(answers, stack),
  ];
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
