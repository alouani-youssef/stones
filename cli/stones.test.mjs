import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { inspectSpec } from '../hooks/atomicity.mjs';
import { renderAgentDoc } from './agent-doc.mjs';
import { docCatalog, hookCatalog } from './catalog.mjs';
import { detect } from './detect.mjs';
import { apply, loadManifest, plan } from './install.mjs';
import { createPrompter, createScriptedPrompter } from './prompt.mjs';
import { interview, suggestedPatterns } from './questions.mjs';
import { roadmapPrompt } from './roadmap.mjs';
import { commandRule, composeSettings, mergeSettings } from './settings.mjs';
import { PassThrough } from 'node:stream';

function project(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'stones-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

const nextApp = () =>
  project({
    'package.json': {
      name: 'shop',
      description: 'An online shop.',
      scripts: { test: 'vitest', lint: 'eslint .', typecheck: 'tsc --noEmit', build: 'next build' },
      dependencies: { next: '15', react: '19' },
      devDependencies: { typescript: '5', prettier: '3', vitest: '2', eslint: '9' },
    },
    'pnpm-lock.yaml': '',
    'tsconfig.json': '{}',
    'src/app/page.tsx': '',
  });

async function runInit(root, answers = {}, options = {}) {
  const stack = detect(root);
  const previous = loadManifest(root).answers ?? {};
  const result = await interview(createScriptedPrompter(answers), stack, previous);
  const ops = plan({ target: root, answers: result, stack, ...options });
  apply({ target: root, ops, answers: result, stack });
  return { stack, answers: result, ops };
}

const read = (root, path) => readFileSync(join(root, path), 'utf8');
const actions = (ops) => Object.fromEntries(ops.map((o) => [o.path, o.action]));

describe('detect', () => {
  it('detects the migration tool, dirs and generator', () => {
    const prisma = detect(project({ 'package.json': { devDependencies: { prisma: '5' } }, 'pnpm-lock.yaml': '' }));
    assert.equal(prisma.migrations.tool, 'Prisma');
    assert.deepEqual(prisma.migrations.dirs, ['prisma/migrations']);
    assert.equal(prisma.migrations.generate, 'pnpm exec prisma migrate dev --name <name>');
    const django = detect(project({ 'manage.py': '', 'requirements.txt': 'Django==5\n' }));
    assert.equal(django.migrations.tool, 'Django');
    assert.equal(django.migrations.generate, 'python manage.py makemigrations');
    assert.deepEqual(django.migrations.dirs, ['**/migrations']);
    assert.deepEqual(django.migrations.models, ['**/models.py', '**/models/**']);
    const drizzle = detect(project({
      'package.json': { devDependencies: { 'drizzle-kit': '1' } },
      'drizzle.config.ts': "export default { out: './db/migrations' }",
    }));
    assert.deepEqual(drizzle.migrations.dirs, ['db/migrations']);
    assert.equal(drizzle.migrations.generate, 'npx drizzle-kit generate');
    const alembic = detect(project({ 'alembic.ini': '[alembic]\nscript_location = db/alembic\n' }));
    assert.deepEqual(alembic.migrations.dirs, ['db/alembic/versions']);
    const rails = detect(project({ Gemfile: "gem 'rails'\n" }));
    assert.equal(rails.migrations.generate, 'bin/rails generate migration <Name>');
    assert.equal(detect(project()).migrations, null);
  });

  it('reads a Next.js + pnpm project', () => {
    const s = detect(nextApp());
    assert.equal(s.name, 'shop');
    assert.deepEqual(s.languages, ['TypeScript']);
    assert.ok(s.frameworks.includes('Next.js') && s.frameworks.includes('React'));
    assert.deepEqual(s.packageManagers, ['pnpm']);
    assert.equal(s.commands.test, 'pnpm run test');
    assert.deepEqual(s.formatters, ['prettier']);
    assert.deepEqual(s.directories, ['src']);
  });

  it('reads Python with uv, Go and Rust', () => {
    const py = detect(project({ 'pyproject.toml': 'name = "api"\ndependencies = ["fastapi", "pytest", "ruff"]\n', 'uv.lock': '' }));
    assert.deepEqual([py.name, py.packageManagers[0], py.commands.test, py.commands.lint], ['api', 'uv', 'uv run pytest', 'uv run ruff check .']);
    assert.ok(py.frameworks.includes('FastAPI'));
    assert.equal(detect(project({ 'go.mod': 'module github.com/me/tool\n' })).name, 'tool');
    assert.equal(detect(project({ 'Cargo.toml': '[package]\nname = "crab"\n' })).commands.test, 'cargo test');
  });
});

describe('settings', () => {
  it('turns commands into permission rules', () => {
    assert.equal(commandRule('pnpm run test'), 'Bash(pnpm run test:*)');
    assert.equal(commandRule('go test ./...'), 'Bash(go test:*)');
    assert.equal(commandRule('uv run ruff check .'), 'Bash(uv run ruff check:*)');
  });

  it('keeps only selected hooks and the project ecosystems', () => {
    const s = composeSettings({ hooks: ['access_guard'], ecosystems: ['python'], commands: { test: 'pytest' } });
    const commands = JSON.stringify(s.hooks);
    assert.match(commands, /access_guard\.mjs/);
    assert.doesNotMatch(commands, /naming|graph|format|block-rm/);
    assert.ok(s.permissions.allow.includes('Bash(pytest:*)'));
    assert.ok(!s.permissions.allow.some((p) => p.includes('nx')));
    assert.deepEqual(s.sandbox.network.allowedDomains, ['pypi.org', 'files.pythonhosted.org']);
  });

  it('adds nx permissions only in nx monorepos and drops the jq status line without jq', () => {
    const s = composeSettings({ monorepo: 'nx', jq: false, sandbox: false });
    assert.ok(s.permissions.allow.includes('Bash(npx nx test:*)'));
    assert.equal(s.statusLine, undefined);
    assert.equal(s.sandbox, undefined);
  });

  it('merges without losing user settings', () => {
    const merged = mergeSettings(
      { model: 'opus', permissions: { allow: ['Bash(make:*)'] } },
      { model: 'sonnet', permissions: { allow: ['Bash(git status:*)'], deny: ['Read(./.env)'] } },
    );
    assert.deepEqual(merged, {
      model: 'opus',
      permissions: { allow: ['Bash(make:*)', 'Bash(git status:*)'], deny: ['Read(./.env)'] },
    });
  });
});

describe('pattern defaults', () => {
  it('suggests patterns that fit the stack', () => {
    const base = { frameworks: [], ecosystems: [] };
    assert.deepEqual(suggestedPatterns(base), ['patterns/modularity', 'patterns/reusability', 'patterns/complexity']);
    const nest = suggestedPatterns({ frameworks: ['NestJS', 'Prisma'], ecosystems: ['node'] });
    for (const p of ['patterns/repository', 'patterns/dependency-injection', 'patterns/summary-details']) assert.ok(nest.includes(p), p);
  });
});

describe('AGENT.md', () => {
  it('fills every template section from the answers', async () => {
    const root = nextApp();
    const stack = detect(root);
    const answers = await interview(createScriptedPrompter({
      'architecture.notes': 'Next.js app router + Postgres',
      'stack.layout.src': 'application code',
      patterns: ['patterns/repository'],
    }), stack);
    const doc = renderAgentDoc(answers, stack);
    for (const heading of ['PROJECT', 'What This Is', 'Stack And Layout', 'Architecture', 'Design Pattern',
      'Access And Security', 'Conventions', 'Workflow', 'Guardrails', 'Roadmap']) {
      assert.match(doc, new RegExp(`^## ${heading}$`, 'm'), heading);
    }
    assert.doesNotMatch(doc, /_TODO_/);
    assert.match(doc, /\*\*shop\*\*/);
    assert.match(doc, /`src\/` — application code/);
    assert.match(doc, /\[Repository Pattern\]\(\.claude\/docs\/patterns\/repository\/README\.md\)/);
    assert.match(doc, /- test: `pnpm run test`/);
    assert.match(doc, /Conventional Commits/);
    assert.match(doc, /prettier/);
  });
});

describe('init', () => {
  it('generates .claude, AGENT.md and CLAUDE.md for a fresh project', async () => {
    const root = nextApp();
    execFileSync('git', ['init', '-q'], { cwd: root });
    const { ops } = await runInit(root, { 'install.mcp': ['context7'] });
    assert.ok(ops.every((o) => o.action === 'create'), JSON.stringify(actions(ops)));

    const settings = JSON.parse(read(root, '.claude/settings.json'));
    assert.ok(settings.permissions.allow.includes('Bash(pnpm run test:*)'));
    assert.match(JSON.stringify(settings.hooks), /format\.mjs/); // prettier detected
    assert.equal(read(root, 'CLAUDE.md'), '@AGENT.md\n');
    assert.match(read(root, 'AGENT.md'), /^## Workflow$/m);
    assert.match(read(root, '.gitignore'), /\.claude\/graph\/project\.json/);
    assert.equal(JSON.parse(read(root, '.mcp.json')).mcpServers.context7.command, 'npx');
    assert.ok(read(root, '.claude/hooks/access_guard.mjs').length > 0);
    assert.ok(read(root, '.claude/commands/roadmap.md').includes('ROADMAP.md'));
    assert.ok(statSync(join(root, '.claude/hooks/block-rm.sh')).mode & 0o100);
    assert.ok(loadManifest(root).files['AGENT.md']);
  });

  it('installs the testing hook and active scenario note only when selected', async () => {
    const withTesting = nextApp();
    await runInit(withTesting, { 'install.hooks': ['testing'] });
    const settings = JSON.parse(read(withTesting, '.claude/settings.json'));
    assert.ok(read(withTesting, '.claude/hooks/testing.mjs').length > 0);
    assert.match(read(withTesting, 'context/tasks/active.md'), /^## Expected behavior$/m);
    assert.match(JSON.stringify(settings.hooks.PreToolUse), /testing\.mjs/);
    assert.ok(loadManifest(withTesting).files['context/tasks/active.md']);

    const withoutTesting = nextApp();
    await runInit(withoutTesting, { 'install.hooks': ['access_guard'] });
    assert.equal(existsSync(join(withoutTesting, 'context/tasks/active.md')), false);
  });

  it('is idempotent and keeps user edits on re-run', async () => {
    const root = nextApp();
    await runInit(root);
    writeFileSync(join(root, 'AGENT.md'), `${read(root, 'AGENT.md')}\nMy own notes.\n`);
    writeFileSync(join(root, 'CLAUDE.md'), '@AGENT.md\n\nLocal rules.\n');

    const { ops } = await runInit(root, { 'project.description': 'A different shop.' });
    const a = actions(ops);
    assert.equal(a['AGENT.md'], 'conflict');
    assert.match(read(root, 'AGENT.md'), /My own notes\./);
    assert.equal(a['.claude/hooks/access_guard.mjs'], 'same');
    assert.equal(a['CLAUDE.md'], undefined);
    assert.equal(read(root, 'CLAUDE.md'), '@AGENT.md\n\nLocal rules.\n');

    await runInit(root, {}, { force: true });
    assert.doesNotMatch(read(root, 'AGENT.md'), /My own notes\./);
  });

  it('updates untouched files when answers change', async () => {
    const root = nextApp();
    await runInit(root);
    const { ops } = await runInit(root, { 'project.description': 'A different shop.' });
    assert.equal(actions(ops)['AGENT.md'], 'update');
    assert.match(read(root, 'AGENT.md'), /A different shop\./);
  });

  it('git-ignores the history database only when the history hook is installed', async () => {
    const withHistory = nextApp();
    execFileSync('git', ['init', '-q'], { cwd: withHistory });
    await runInit(withHistory, { 'install.hooks': ['history'] });
    assert.match(read(withHistory, '.gitignore'), /^\.claude\/history\.db\*$/m);
    assert.match(JSON.stringify(JSON.parse(read(withHistory, '.claude/settings.json')).hooks.Stop), /history\.mjs\\" reply/);

    const without = nextApp();
    execFileSync('git', ['init', '-q'], { cwd: without });
    await runInit(without, { 'install.hooks': ['access_guard'] });
    assert.doesNotMatch(read(without, '.gitignore'), /history\.db/);
  });

  it('remembers previous answers', async () => {
    const root = nextApp();
    await runInit(root, { 'architecture.style': 'microservices', 'install.hooks': ['access_guard'] });
    const { answers } = await runInit(root);
    assert.equal(answers.architecture.style, 'microservices');
    assert.deepEqual(answers.install.hooks, ['access_guard']);
  });

  it('merges into an existing settings.json and appends to CLAUDE.md', async () => {
    const root = nextApp();
    writeFileSync(join(root, 'CLAUDE.md'), '# House rules\n');
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude/settings.json'), JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(make:*)'] } }));
    const { ops } = await runInit(root);
    assert.equal(actions(ops)['.claude/settings.json'], 'merge');
    const settings = JSON.parse(read(root, '.claude/settings.json'));
    assert.equal(settings.model, 'opus');
    assert.equal(settings.permissions.allow[0], 'Bash(make:*)');
    assert.ok(settings.hooks);
    assert.equal(read(root, 'CLAUDE.md'), '# House rules\n@AGENT.md\n');
  });
});

describe('prompts', () => {
  it('reads piped answers line by line', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const ask = createPrompter({ input, output });
    input.end('my-app\n\n2\n1,3\n');
    assert.equal(await ask.text('a', 'Name', 'x'), 'my-app');
    assert.equal(await ask.confirm('b', 'Ok?', true), true);
    const opts = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }];
    assert.equal(await ask.select('c', 'Pick', opts, 'a'), 'b');
    assert.deepEqual(await ask.multi('d', 'Pick', opts, []), ['a', 'c']);
    assert.equal(await ask.text('e', 'After end', 'fallback'), 'fallback');
    ask.close();
  });
});

describe('roadmap', () => {
  it('builds the session prompt from the /roadmap command', () => {
    const prompt = roadmapPrompt(project(), '');
    assert.doesNotMatch(prompt, /^---/);
    assert.match(prompt, /Focus for this session: create the first roadmap/);
    assert.match(roadmapPrompt(project({ 'ROADMAP.md': '# Roadmap' }), ''), /review progress/);
    assert.match(roadmapPrompt(project(), 'plan Q3'), /Focus for this session: plan Q3/);
  });
});

describe('atomicity hook install', () => {
  const prismaApp = () => project({
    'package.json': { name: 'api', devDependencies: { prisma: '5' } },
    'pnpm-lock.yaml': '',
  });

  it('is in the hook catalog', () => {
    const hook = hookCatalog().find((h) => h.id === 'atomicity');
    assert.deepEqual(hook?.events, ['PreToolUse:Bash|Edit|MultiEdit|Write']);
  });

  it('ships the hook, a detected seed config and the danger dir', async () => {
    const root = prismaApp();
    const { ops, stack } = await runInit(root, { 'install.hooks': ['atomicity'] });
    const paths = actions(ops);
    assert.equal(paths['.claude/hooks/atomicity.mjs'], 'create');
    assert.equal(paths['.claude/atomicity.json'], 'create');
    assert.equal(paths['.claude/danger/.gitkeep'], 'create');
    const config = JSON.parse(read(root, '.claude/atomicity.json'));
    assert.equal(config.migrations.generate, 'pnpm exec prisma migrate dev --name <name>');
    assert.deepEqual(config.migrations.dirs, ['prisma/migrations']);
    assert.equal(config.defaultBranch, stack.defaultBranch);
    assert.equal(config.enabled, true);
  });

  it('mentions danger zones in AGENT.md with the detected generator', async () => {
    const root = prismaApp();
    await runInit(root, { 'install.hooks': ['atomicity'] });
    const doc = read(root, 'AGENT.md');
    assert.match(doc, /Danger zones/);
    assert.match(doc, /pnpm exec prisma migrate dev --name <name>/);
  });

  it('links the atomicity doc from AGENT.md when hook and doc are installed', async () => {
    const root = prismaApp();
    await runInit(root, { 'install.hooks': ['atomicity'], 'install.docs': ['atomicity'] });
    assert.match(read(root, 'AGENT.md'), /\.claude\/docs\/atomicity\/README\.md/);
  });

  it('ships the atomicity docs with an unfilled-spec-failing template', () => {
    const topic = docCatalog().find((t) => t.id === 'atomicity');
    assert.ok(topic);
    assert.equal(topic.main, 'atomicity/README.md');
    assert.equal(topic.files.length, 4);
    assert.match(topic.lead, /atomic/i);
    const template = readFileSync(new URL('../docs/atomicity/SPEC_TEMPLATE.md', import.meta.url), 'utf8');
    assert.equal(inspectSpec(template, 'db').valid, false);
  });
});
