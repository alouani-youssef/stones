import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { inspectSpec } from '../hooks/atomicity.mjs';
import { parseDockerfile, renderDevcontainer } from '../hooks/devcontainer.mjs';
import { renderAgentDoc } from './agent-doc.mjs';
import { hookCatalog, LEGACY_SKILL_IDS, PACKAGE_ROOT, pluginCatalog, skillCatalog, skillFrontmatter, suggestedPlugins } from './catalog.mjs';
import { detect } from './detect.mjs';
import { DEVCONTAINER_STACKS, devcontainerStack } from './devcontainer.mjs';
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

  it('enables selected plugins and declares their marketplace', () => {
    const s = composeSettings({ plugins: ['superpowers', 'prisma', 'not-a-plugin'] });
    assert.deepEqual(s.enabledPlugins, {
      'superpowers@claude-plugins-official': true,
      'prisma@claude-plugins-official': true,
    });
    assert.deepEqual(s.extraKnownMarketplaces, {
      'claude-plugins-official': { source: { source: 'github', repo: 'anthropics/claude-plugins-official' } },
    });
    const mixed = composeSettings({ plugins: ['superpowers', 'flask-best-practices'] });
    assert.equal(mixed.enabledPlugins['flask-best-practices@stones'], true);
    assert.deepEqual(mixed.extraKnownMarketplaces.stones, { source: { source: 'github', repo: 'alouani-youssef/stones' } });
    const none = composeSettings({});
    assert.equal(none.enabledPlugins, undefined);
    assert.equal(none.extraKnownMarketplaces, undefined);
  });

  it('suggests core plugins everywhere and stack plugins only where they fit', () => {
    const core = pluginCatalog().filter((p) => p.default).map((p) => p.id);
    assert.ok(core.includes('superpowers'));
    const node = suggestedPlugins(detect(project({
      'package.json': { dependencies: { next: '15', '@supabase/supabase-js': '2', mongoose: '8' }, devDependencies: { prisma: '5' } },
      'tsconfig.json': '{}',
    })));
    for (const id of [...core, 'typescript-lsp', 'frontend-design', 'prisma', 'supabase', 'mongodb']) assert.ok(node.includes(id), id);
    assert.ok(!node.includes('pyright-lsp'));
    const py = suggestedPlugins(detect(project({ 'requirements.txt': 'fastapi\nredis\n' })));
    for (const id of ['pyright-lsp', 'redis-development']) assert.ok(py.includes(id), id);
    assert.ok(!py.includes('typescript-lsp') && !py.includes('prisma'));
  });

  it('suggests the stones framework plugins for NestJS, Gin and Flask', () => {
    const nest = suggestedPlugins(detect(project({ 'package.json': { dependencies: { '@nestjs/core': '11' } } })));
    assert.ok(nest.includes('nestjs-best-practices'));
    const gin = detect(project({ 'go.mod': 'module example.com/api\n\ngo 1.24\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.10.0\n)\n' }));
    assert.ok(gin.frameworks.includes('Gin'));
    assert.ok(suggestedPlugins(gin).includes('gin-best-practices'));
    const flask = suggestedPlugins(detect(project({ 'requirements.txt': 'flask==3.1\n' })));
    assert.ok(flask.includes('flask-best-practices'));
    for (const id of ['nestjs-best-practices', 'gin-best-practices', 'flask-best-practices']) {
      assert.ok(!suggestedPlugins(detect(project({ 'requirements.txt': 'fastapi\n' }))).includes(id), id);
    }
  });

  it('lists every stones-marketplace plugin in .claude-plugin/marketplace.json', () => {
    const market = JSON.parse(readFileSync(join(PACKAGE_ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
    assert.equal(market.name, 'stones');
    const listed = market.plugins.map((p) => p.name);
    const ours = pluginCatalog().filter((p) => p.marketplace === 'stones').map((p) => p.id);
    assert.ok(ours.length);
    assert.deepEqual([...ours].sort(), [...listed].sort());
    for (const p of market.plugins) {
      const dir = join(PACKAGE_ROOT, p.source);
      const manifest = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
      assert.equal(manifest.name, p.name, `${p.name} manifest name matches its entry`);
      assert.match(readFileSync(join(dir, 'UPSTREAM.md'), 'utf8'), /[0-9a-f]{40}/, `${p.name} records its upstream commit`);
    }
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
    assert.deepEqual(suggestedPatterns(base), ['modular-design', 'reusing-code', 'managing-complexity']);
    const nest = suggestedPatterns({ frameworks: ['NestJS', 'Prisma'], ecosystems: ['node'] });
    for (const p of ['repository-pattern', 'dependency-injection', 'summary-details-responses']) assert.ok(nest.includes(p), p);
    const patternIds = skillCatalog().filter((s) => s.pattern).map((s) => s.id);
    for (const p of nest) assert.ok(patternIds.includes(p), `${p} is a pattern skill`);
  });
});

describe('skills', () => {
  const skills = skillCatalog();

  it('ships every guide and pattern as a skill', () => {
    for (const id of [...Object.values(LEGACY_SKILL_IDS), 'creating-branches', 'opening-pull-requests', 'four-d-engineering']) {
      assert.ok(skills.some((s) => s.id === id), id);
    }
  });

  it('gives every skill valid frontmatter that says when to use it', () => {
    for (const skill of skills) {
      const text = readFileSync(new URL(`../skills/${skill.main}`, import.meta.url), 'utf8');
      const fm = skillFrontmatter(text);
      assert.equal(fm.name, skill.id, `${skill.id}: name matches folder`);
      assert.match(fm.name, /^[a-z0-9-]+$/, `${skill.id}: name`);
      assert.match(fm.description, /^Use when /, `${skill.id}: description starts with "Use when"`);
      assert.ok(/^---\n([\s\S]*?)\n---/.exec(text)[1].length <= 1024, `${skill.id}: frontmatter under 1024 chars`);
      assert.ok(fm.metadata.title && fm.metadata.summary, `${skill.id}: title and summary`);
    }
  });

  it('links only to files that exist in the same skill', () => {
    for (const skill of skills) {
      for (const rel of skill.files.filter((f) => f.endsWith('.md'))) {
        const text = readFileSync(new URL(`../skills/${rel}`, import.meta.url), 'utf8');
        for (const [, target] of text.matchAll(/\]\(([^)#\s]+\.md)\)/g)) {
          const resolved = join(dirname(rel), target);
          assert.ok(skill.files.includes(resolved), `${rel} -> ${target}`);
        }
      }
    }
  });

  it('installs selected skills into .claude/skills with their reference files', async () => {
    const root = nextApp();
    await runInit(root, { 'install.skills': ['writing-tests'], patterns: ['repository-pattern'] });
    assert.ok(existsSync(join(root, '.claude/skills/writing-tests/SKILL.md')));
    assert.ok(existsSync(join(root, '.claude/skills/writing-tests/unit.md')));
    assert.ok(existsSync(join(root, '.claude/skills/repository-pattern/SKILL.md')));
    assert.ok(!existsSync(join(root, '.claude/skills/atomic-changes')));
    assert.ok(!existsSync(join(root, '.claude/docs')));
  });

  it('maps guide ids saved before guides became skills', async () => {
    const root = nextApp();
    await runInit(root);
    const manifest = loadManifest(root);
    delete manifest.answers.install.skills;
    manifest.answers.install.docs = ['tdd', 'naming'];
    manifest.answers.patterns = ['patterns/repository'];
    writeFileSync(join(root, '.claude/stones.json'), JSON.stringify(manifest));
    const { answers } = await runInit(root);
    assert.ok(answers.install.skills.includes('test-first-development'));
    assert.ok(answers.install.skills.includes('naming-files'));
    assert.ok(answers.install.skills.includes('four-d-engineering'), 'skills added since are offered');
    assert.ok(!answers.install.skills.includes('writing-tests'), 'deselected guides stay deselected');
    assert.deepEqual(answers.patterns, ['repository-pattern']);
  });
});

describe('AGENT.md', () => {
  it('fills every template section from the answers', async () => {
    const root = nextApp();
    const stack = detect(root);
    const answers = await interview(createScriptedPrompter({
      'architecture.notes': 'Next.js app router + Postgres',
      'stack.layout.src': 'application code',
      patterns: ['repository-pattern'],
    }), stack);
    const doc = renderAgentDoc(answers, stack);
    for (const heading of ['PROJECT', 'What This Is', 'Stack And Layout', 'Architecture', 'Design Pattern',
      'Access And Security', 'Conventions', 'Workflow', 'Guardrails', 'Roadmap']) {
      assert.match(doc, new RegExp(`^## ${heading}$`, 'm'), heading);
    }
    assert.doesNotMatch(doc, /_TODO_/);
    assert.match(doc, /\*\*shop\*\*/);
    assert.match(doc, /`src\/` — application code/);
    assert.match(doc, /\[Repository Pattern\]\(\.claude\/skills\/repository-pattern\/SKILL\.md\)/);
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
    assert.equal(settings.enabledPlugins['superpowers@claude-plugins-official'], true);
    assert.equal(settings.enabledPlugins['typescript-lsp@claude-plugins-official'], true);
    assert.ok(settings.extraKnownMarketplaces['claude-plugins-official']);
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

  it('installs the testing hook with the task board, or the legacy note without it', async () => {
    const withBoard = nextApp();
    execFileSync('git', ['init', '-q'], { cwd: withBoard });
    await runInit(withBoard, { 'install.hooks': ['testing'] });
    const settings = JSON.parse(read(withBoard, '.claude/settings.json'));
    assert.ok(read(withBoard, '.claude/hooks/testing.mjs').length > 0);
    assert.match(JSON.stringify(settings.hooks.PreToolUse), /testing\.mjs/);
    for (const state of ['current', 'next', 'blocked', 'done']) assert.ok(existsSync(join(withBoard, `context/tasks/state/${state}.md`)), state);
    assert.ok(existsSync(join(withBoard, 'context/tasks/list/.gitkeep')));
    assert.ok(read(withBoard, '.claude/tools/tasks.mjs').length > 0);
    assert.ok(read(withBoard, '.claude/tools/review.mjs').length > 0);
    assert.ok(read(withBoard, '.claude/skills/tracking-tasks/SKILL.md').length > 0);
    assert.ok(settings.permissions.allow.includes('Bash(node .claude/tools/tasks.mjs:*)'));
    assert.match(read(withBoard, '.gitignore'), /^\.claude\/reviews\/$/m);
    assert.equal(existsSync(join(withBoard, 'context/tasks/active.md')), false);

    // The installed tool runs from .claude/tools and reaches the installed hooks.
    const out = execFileSync('node', ['.claude/tools/tasks.mjs', 'add', 'First task'], { cwd: withBoard, encoding: 'utf8' });
    assert.match(out, /context\/tasks\/list\/0001-first-task\.md/);

    const legacy = nextApp();
    await runInit(legacy, { 'install.hooks': ['testing'], 'install.skills': ['writing-tests'] });
    assert.match(read(legacy, 'context/tasks/active.md'), /^## Expected behavior$/m);
    assert.ok(loadManifest(legacy).files['context/tasks/active.md']);
    assert.equal(existsSync(join(legacy, '.claude/tools/tasks.mjs')), false);

    const withoutTesting = nextApp();
    await runInit(withoutTesting, { 'install.hooks': ['access_guard'], 'install.skills': ['writing-tests'] });
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

  it('links the atomicity skill from AGENT.md when hook and skill are installed', async () => {
    const root = prismaApp();
    await runInit(root, { 'install.hooks': ['atomicity'], 'install.skills': ['atomic-changes'] });
    assert.match(read(root, 'AGENT.md'), /\.claude\/skills\/atomic-changes\/SKILL\.md/);
  });

  it('ships the atomicity skill with an unfilled-spec-failing template', () => {
    const skill = skillCatalog().find((s) => s.id === 'atomic-changes');
    assert.ok(skill);
    assert.equal(skill.main, 'atomic-changes/SKILL.md');
    assert.deepEqual(skill.files, ['atomic-changes/SKILL.md', 'atomic-changes/hook-reference.md', 'atomic-changes/spec-template.md']);
    assert.match(skill.lead, /atomic/i);
    const template = readFileSync(new URL('../skills/atomic-changes/spec-template.md', import.meta.url), 'utf8');
    assert.equal(inspectSpec(template, 'db').valid, false);
  });
});

describe('devcontainers', () => {
  const pkgFile = (...parts) => readFileSync(join(PACKAGE_ROOT, 'devcontainer', ...parts), 'utf8');

  it('shipped devcontainer.json files match their Dockerfiles', () => {
    for (const id of DEVCONTAINER_STACKS) {
      assert.equal(pkgFile(id, 'devcontainer.json'), renderDevcontainer(pkgFile(id, 'Dockerfile'), { name: id }), id);
    }
  });

  it('every image has what stones and the Claude sandbox need', () => {
    for (const id of DEVCONTAINER_STACKS) {
      const dockerfile = pkgFile(id, 'Dockerfile');
      for (const re of [/bubblewrap/, /socat/, /\bjq\b/, /\bgit\b/, /claude-code/]) assert.match(dockerfile, re, `${id} ${re}`);
      const user = parseDockerfile(dockerfile).user;
      assert.ok(user && user !== 'root' && user !== '0', `${id} runs as ${user}`);
      if (id !== 'node-pnpm') assert.match(dockerfile, /node/i, id);
    }
  });

  it('picks the stack', () => {
    const pick = (files) => devcontainerStack(detect(project(files)));
    assert.equal(pick({ 'package.json': { name: 'a' }, 'pnpm-lock.yaml': '', 'pyproject.toml': '[project]\nname = "a"\n' }), 'node-pnpm');
    assert.equal(pick({ 'package.json': { name: 'a' }, 'package-lock.json': '{}' }), null);
    assert.equal(pick({ 'pyproject.toml': '[project]\nname = "a"\n' }), 'python');
    assert.equal(pick({ 'go.mod': 'module a\n\ngo 1.25\n' }), 'go');
    assert.equal(pick({ 'Cargo.toml': '[package]\nname = "a"\n' }), null);
  });
});

describe('devcontainer install', () => {
  const DC = '.devcontainer/Dockerfile';
  const DC_JSON = '.devcontainer/devcontainer.json';
  const shipped = readFileSync(join(PACKAGE_ROOT, 'devcontainer', 'node-pnpm', 'Dockerfile'), 'utf8');

  it('installs the node-pnpm dev container by default', async () => {
    const root = nextApp();
    const { ops, answers } = await runInit(root);
    assert.equal(answers.install.devcontainer, 'node-pnpm');
    assert.equal(actions(ops)[DC], 'create');
    assert.equal(actions(ops)[DC_JSON], 'create');
    assert.equal(read(root, DC_JSON), renderDevcontainer(shipped, { name: basename(root) }));
  });

  it('does not offer a dev container for unsupported stacks', async () => {
    const root = project({ 'package.json': { name: 'a' }, 'package-lock.json': '{}' });
    const { ops, answers } = await runInit(root);
    assert.equal(answers.install.devcontainer, null);
    assert.equal(ops.some((o) => o.path.startsWith('.devcontainer/')), false);
  });

  it('skips the dev container when declined', async () => {
    const root = nextApp();
    const { ops, answers } = await runInit(root, { 'install.devcontainer': false });
    assert.equal(answers.install.devcontainer, null);
    assert.equal(ops.some((o) => o.path.startsWith('.devcontainer/')), false);
  });

  it("regenerates json from the project's edited Dockerfile on re-run", async () => {
    const root = nextApp();
    await runInit(root);
    writeFileSync(join(root, DC), `${read(root, DC)}ENV X=1\n`);
    const { ops } = await runInit(root);
    assert.equal(actions(ops)[DC], 'keep');
    assert.equal(actions(ops)[DC_JSON], 'update');
    assert.equal(JSON.parse(read(root, DC_JSON).replace(/^\/\/.*\n/, '')).containerEnv.X, '1');
  });

  it('leaves an existing unmanaged .devcontainer alone', async () => {
    const root = nextApp();
    mkdirSync(join(root, '.devcontainer'));
    writeFileSync(join(root, DC), 'FROM mine\n');
    const { ops } = await runInit(root);
    const conflicts = ops.filter((o) => o.path.startsWith('.devcontainer/'));
    assert.deepEqual(conflicts.map((o) => o.action), ['conflict', 'conflict']);
    assert.ok(conflicts.every((o) => o.reason === 'existing .devcontainer not installed by stones'));
    assert.equal(read(root, DC), 'FROM mine\n');
    assert.equal(existsSync(join(root, DC_JSON)), false);

    const forced = await runInit(root, {}, { force: true });
    assert.equal(actions(forced.ops)[DC], 'keep');
    assert.equal(actions(forced.ops)[DC_JSON], 'create');
    assert.equal(read(root, DC), 'FROM mine\n');
  });

  it('reports malformed metadata as a conflict without writing', async () => {
    const root = nextApp();
    await runInit(root);
    writeFileSync(join(root, DC), `FROM x\nLABEL devcontainer.metadata='{bad'\n`);
    const before = read(root, DC_JSON);
    const { ops } = await runInit(root);
    const op = ops.find((o) => o.path === DC_JSON);
    assert.equal(op.action, 'conflict');
    assert.match(op.reason, /devcontainer\.metadata/);
    assert.equal(read(root, DC_JSON), before);
  });

  it('AGENT.md mentions the dev container', async () => {
    const root = nextApp();
    await runInit(root);
    assert.match(read(root, 'AGENT.md'), /Dev container: \.devcontainer\/ \(`node-pnpm`\)\. Edit \.devcontainer\/Dockerfile only/);
  });
});

describe('stones sync', () => {
  const BIN = join(PACKAGE_ROOT, 'bin', 'stones.mjs');
  const DC_JSON = '.devcontainer/devcontainer.json';
  const sync = (root, ...flags) => spawnSync('node', [BIN, 'sync', root, ...flags], { encoding: 'utf8' });
  const withDockerfile = (extra = {}) => project({ '.devcontainer/Dockerfile': 'FROM node:22\nUSER node\n', ...extra });

  it('sync writes devcontainer.json', () => {
    const root = withDockerfile();
    assert.equal(sync(root).status, 0);
    assert.ok(existsSync(join(root, DC_JSON)));
  });

  it('sync --check fails on drift without writing', () => {
    const root = withDockerfile({ [DC_JSON]: '{}' });
    assert.equal(sync(root, '--check').status, 1);
    assert.equal(read(root, DC_JSON), '{}');
  });

  it('sync --check passes when in sync', () => {
    const root = withDockerfile();
    sync(root);
    assert.equal(sync(root, '--check').status, 0);
  });

  it('sync without a Dockerfile is a no-op', () => {
    const root = project({});
    const result = sync(root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /no \.devcontainer\/Dockerfile/);
  });

  it('sync reports bad metadata', () => {
    const root = project({ '.devcontainer/Dockerfile': `FROM x\nLABEL devcontainer.metadata='{bad'\n`, [DC_JSON]: 'X' });
    const result = sync(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /devcontainer\.metadata/);
    assert.equal(read(root, DC_JSON), 'X');
  });
});
