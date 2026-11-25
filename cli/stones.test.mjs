import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { inspectSpec } from '../hooks/atomicity.mjs';
import { parseDockerfile, renderDevcontainer } from '../hooks/devcontainer.mjs';
import { renderAgentDoc } from './agent-doc.mjs';
import { hookCatalog, LEGACY_SKILL_IDS, mcpCatalog, PACKAGE_ROOT, pluginCatalog, skillCatalog, skillFrontmatter, suggestedPlugins } from './catalog.mjs';
import { detect } from './detect.mjs';
import { DEVCONTAINER_STACKS, devcontainerStack } from './devcontainer.mjs';
import { apply, loadManifest, plan } from './install.mjs';
import { createPrompter, createScriptedPrompter } from './prompt.mjs';
import { interview, suggestedPatterns } from './questions.mjs';
import { roadmapPrompt } from './roadmap.mjs';
import { commandRule, composeSettings, mergeSettings } from './settings.mjs';
import { PassThrough } from 'node:stream';
import { complexityIndex, computeMetrics, dependencyEntropy, edgesFromGraph, report } from '../skills/measuring-complexity/complexity-score.mjs';

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
    const llm = detect(project({ 'requirements.txt': 'langchain-anthropic\nlanggraph\nanthropic\n' }));
    for (const f of ['LangChain', 'LangGraph', 'Anthropic SDK']) assert.ok(llm.frameworks.includes(f), f);
    assert.ok(!llm.frameworks.includes('OpenAI SDK'));
    const js = detect(project({ 'package.json': JSON.stringify({ dependencies: { '@langchain/langgraph': '1', openai: '5' } }) }));
    for (const f of ['LangGraph', 'OpenAI SDK']) assert.ok(js.frameworks.includes(f), f);
    const evals = detect(project({ 'pyproject.toml': 'name = "agent"\ndependencies = ["langgraph"]\n[dependency-groups]\ndev = ["deepeval>=3", "giskard-checks"]\n' }));
    for (const f of ['DeepEval', 'Giskard']) assert.ok(evals.frameworks.includes(f), f);
    assert.ok(!llm.frameworks.includes('DeepEval') && !llm.frameworks.includes('Giskard'));
    assert.equal(detect(project({ 'go.mod': 'module github.com/me/tool\n' })).name, 'tool');
    assert.equal(detect(project({ 'Cargo.toml': '[package]\nname = "crab"\n' })).commands.test, 'cargo test');
  });

  it('finds Python quality gates in dev requirements and tool configs', () => {
    const pip = detect(project({
      'requirements.txt': 'flask\n', 'requirements-dev.txt': 'pytest\n', 'ruff.toml': '', 'mypy.ini': '',
    }));
    assert.deepEqual(pip.commands, { test: 'pytest', lint: 'ruff check .', format: 'ruff format .', typecheck: 'mypy .' });
    assert.deepEqual([pip.linters, pip.formatters], [['ruff'], ['ruff']]);

    const legacy = detect(project({ 'setup.cfg': '[flake8]\nmax-line-length = 100\n', 'requirements.txt': 'black\n', 'pyrightconfig.json': '{}' }));
    assert.deepEqual(legacy.commands, { lint: 'flake8 .', format: 'black .', typecheck: 'pyright' });
  });

  it('runs Python gates through the project package manager', () => {
    const cases = [
      [{ 'pyproject.toml': '[tool.poetry]\nname = "p"\n[tool.poetry.group.dev.dependencies]\nruff = "*"\n' }, 'poetry'],
      [{ 'pyproject.toml': '[project]\nname = "p"\n[dependency-groups]\ndev = ["ruff"]\n', 'pdm.lock': '' }, 'pdm'],
      [{ Pipfile: '[dev-packages]\nruff = "*"\n', 'Pipfile.lock': '{}' }, 'pipenv'],
    ];
    for (const [files, pm] of cases) {
      const py = detect(project(files));
      assert.deepEqual([py.packageManagers[0], py.commands.lint], [pm, `${pm} run ruff check .`]);
    }
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
    const evidence = composeSettings({ plugins: ['show-me-the-work'] });
    assert.equal(evidence.enabledPlugins['show-me-the-work@show-me-the-work'], true);
    assert.deepEqual(evidence.extraKnownMarketplaces, {
      'show-me-the-work': { source: { source: 'github', repo: 'pinetreeB/show-me-the-work', ref: 'v2.8.2' } },
    });
    assert.ok(!pluginCatalog().find((p) => p.id === 'show-me-the-work').default, 'its Stop gate stays opt-in');
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

describe('framework skills', () => {
  it('selects a framework skill by default only when the project uses that framework', async () => {
    const fastapi = skillCatalog().find((s) => s.id === 'fastapi');
    assert.deepEqual(fastapi?.frameworks, ['FastAPI']);
    const defaults = async (frameworks) => (await interview(createScriptedPrompter({}), { ...detect(nextApp()), frameworks })).install.skills;
    assert.ok(!(await defaults(['Next.js'])).includes('fastapi'));
    const api = await defaults(['FastAPI', 'Pydantic']);
    assert.ok(api.includes('fastapi'));
    assert.ok(api.includes('writing-tests'), 'skills without frameworks stay selected');
    for (const s of ['prompts', 'golden-set', 'langchain', 'langgraph', 'testing-llm-agents', 'generating-golden-sets', 'deepeval', 'giskard']) assert.ok(!api.includes(s), s);
    assert.ok(api.includes('system-prompts'), 'system-prompt guidance applies across frameworks');

    const agent = await defaults(['LangGraph']);
    for (const s of ['prompts', 'golden-set', 'langgraph', 'testing-llm-agents', 'generating-golden-sets']) assert.ok(agent.includes(s), s);
    for (const s of ['deepeval', 'giskard']) assert.ok(!agent.includes(s), `${s} waits until the project uses it`);
    assert.ok(agent.includes('system-prompts'));
    assert.ok(!agent.includes('langchain'), 'a LangGraph-only project gets no LangChain skill');
    assert.ok((await defaults(['Anthropic SDK'])).includes('prompts'));
    const evals = await defaults(['LangChain', 'DeepEval', 'Giskard']);
    for (const s of ['langchain', 'testing-llm-agents', 'deepeval', 'giskard', 'golden-set']) assert.ok(evals.includes(s), s);
  });

  it('matches skills against detected tools as well as frameworks', async () => {
    const base = detect(nextApp());
    const pick = async (tools) => (await interview(createScriptedPrompter({}), { ...base, tools })).install.skills;
    const withActions = await pick(['GitHub Actions']);
    assert.ok(withActions.includes('github-actions'));
    assert.ok(withActions.includes('ci-cd'));
    const without = await pick([]);
    assert.ok(without.includes('github-actions'), 'github-actions is a core skill');
    const actions = skillCatalog().find((s) => s.id === 'github-actions');
    assert.ok(actions.core);
    for (const f of ['templates/workflows/security.yml', 'templates/pull_request_template.md']) assert.ok(actions.files.includes(`github-actions/${f}`), f);
    assert.ok(without.includes('ci-cd'), 'CI/CD practices apply to every project');
  });

  it('offers the Factory ESLint rules only to TypeScript projects', async () => {
    assert.deepEqual(skillCatalog().find((s) => s.id === 'factory-eslint-rules')?.frameworks, ['TypeScript']);
    const pick = async (files) => (await interview(createScriptedPrompter({}), detect(project(files)))).install.skills;
    assert.ok((await pick({ 'package.json': { devDependencies: { typescript: '5' } }, 'tsconfig.json': '{}' })).includes('factory-eslint-rules'));
    assert.ok(!(await pick({ 'package.json': { dependencies: { express: '5' } } })).includes('factory-eslint-rules'), 'plain JavaScript');
    assert.ok(!(await pick({ 'requirements.txt': 'fastapi\n' })).includes('factory-eslint-rules'));
  });

  it('offers the PostHog skills and plugins only to projects that use PostHog or Sentry', async () => {
    const posthogSkills = ['posthog', 'posthog-experiments', 'posthog-session-replay'];
    const stack = (files) => detect(project(files));
    const ui = stack({ 'package.json': { dependencies: { next: '15', 'posthog-js': '1', '@sentry/nextjs': '9' } } });
    assert.ok(ui.frameworks.includes('PostHog') && ui.frameworks.includes('Sentry'));
    assert.ok(stack({ 'requirements.txt': 'posthog\nsentry-sdk\n' }).frameworks.includes('Sentry'));
    const skills = (await interview(createScriptedPrompter({}), ui)).install.skills;
    for (const s of posthogSkills) assert.ok(skills.includes(s), s);
    const plain = (await interview(createScriptedPrompter({}), stack({ 'package.json': { dependencies: { next: '15' } } }))).install.skills;
    for (const s of posthogSkills) assert.ok(!plain.includes(s), `${s} waits until the project uses PostHog`);
    assert.deepEqual(suggestedPlugins(ui).filter((p) => ['posthog', 'sentry-mcp'].includes(p)).sort(), ['posthog', 'sentry-mcp']);
  });

  it('offers the PostHog and Sentry MCP servers over HTTP', () => {
    const servers = Object.fromEntries(mcpCatalog().map((m) => [m.id, m.config]));
    assert.deepEqual(servers.posthog, { type: 'http', url: 'https://mcp.posthog.com/mcp' });
    assert.deepEqual(servers.sentry, { type: 'http', url: 'https://mcp.sentry.dev/mcp' });
  });

  it('gives every framework skill a references section with links', () => {
    for (const s of skillCatalog().filter((sk) => sk.frameworks.length)) {
      const text = readFileSync(join(PACKAGE_ROOT, 'skills', s.main), 'utf8');
      assert.match(text, /^## References\n[\s\S]*\]\(https:\/\//m, s.id);
    }
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

  it('links local references only to files that exist in the same skill', () => {
    for (const skill of skills) {
      for (const rel of skill.files.filter((f) => f.endsWith('.md'))) {
        const text = readFileSync(new URL(`../skills/${rel}`, import.meta.url), 'utf8');
        for (const [, target] of text.matchAll(/\]\(([^)#\s]+\.md)\)/g)) {
          if (/^https?:\/\//i.test(target)) continue;
          const resolved = join(dirname(rel), target);
          assert.ok(skill.files.includes(resolved), `${rel} -> ${target}`);
        }
      }
    }
  });

  it('links the task workflow to each upstream Superpowers skill it invokes', () => {
    const text = readFileSync(new URL('../skills/tracking-tasks/SKILL.md', import.meta.url), 'utf8');
    for (const skill of ['brainstorming', 'writing-plans', 'subagent-driven-development', 'executing-plans', 'test-driven-development', 'verification-before-completion']) {
      assert.match(text, new RegExp(`github\\.com/obra/superpowers/blob/main/skills/${skill}/SKILL\\.md`), skill);
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

  it('installs the anti-slop core skill in every setup and links it from AGENT.md', async () => {
    assert.ok(skills.find((s) => s.id === 'anti-slop')?.core, 'anti-slop is a core skill');
    const root = nextApp();
    const { answers } = await runInit(root, { 'install.skills': ['writing-tests'] });
    assert.ok(answers.install.skills.includes('anti-slop'), 'kept when the user picks other skills');
    assert.ok(existsSync(join(root, '.claude/skills/anti-slop/SKILL.md')));
    assert.match(read(root, 'AGENT.md'), /No slop: .*\(\.claude\/skills\/anti-slop\/SKILL\.md\)/);

    const manifest = loadManifest(root);
    manifest.answers.install.skills = ['writing-tests'];
    writeFileSync(join(root, '.claude/stones.json'), JSON.stringify(manifest));
    const rerun = await runInit(root);
    assert.ok(rerun.answers.install.skills.includes('anti-slop'), 'added to answers saved before it existed');
  });

  it('ships git-hooks as a core skill with templates', () => {
    const skill = skills.find((s) => s.id === 'git-hooks');
    assert.ok(skill?.core, 'git-hooks is a core skill');
    for (const f of ['templates/githooks/pre-commit', 'templates/githooks/pre-push', 'templates/githooks/commit-msg', 'templates/lefthook/node.yml', 'templates/lefthook/python.yml', 'templates/lefthook/go.yml']) {
      assert.ok(skill.files.includes(`git-hooks/${f}`), f);
    }
  });

  it('runs the hook templates: staged files formatted and re-staged, commit messages checked', () => {
    const templates = join(PACKAGE_ROOT, 'skills/git-hooks/templates/githooks');
    const root = project({ 'a.txt': 'x\n' });
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    const hook = readFileSync(join(templates, 'pre-commit'), 'utf8').replace('FORMAT_CMD=""', 'FORMAT_CMD="sed -i.bak s/x/y/"');
    writeFileSync(join(root, 'pre-commit'), hook);
    const run = spawnSync('bash', ['pre-commit'], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(execFileSync('git', ['show', ':a.txt'], { cwd: root, encoding: 'utf8' }), 'y\n', 'formatted file re-staged');

    const msg = (text) => {
      writeFileSync(join(root, 'MSG'), text);
      return spawnSync('bash', [join(templates, 'commit-msg'), 'MSG'], { cwd: root, encoding: 'utf8' }).status;
    };
    assert.equal(msg('feat(cli): add github setup\n'), 0);
    assert.equal(msg('fix!: drop node 20\n'), 0);
    assert.equal(msg('Merge branch main\n'), 0);
    assert.notEqual(msg('added stuff\n'), 0);
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
    assert.match(read(withBoard, '.gitignore'), /^context\/tasks\/state\/$/m);
    assert.ok(existsSync(join(withBoard, 'context/tasks/list/.gitkeep')));
    assert.ok(read(withBoard, '.claude/tools/tasks.mjs').length > 0);
    assert.ok(read(withBoard, '.claude/tools/review.mjs').length > 0);
    assert.ok(read(withBoard, '.claude/skills/tracking-tasks/SKILL.md').length > 0);
    assert.ok(settings.permissions.allow.includes('Bash(node .claude/tools/tasks.mjs:*)'));
    assert.match(read(withBoard, '.gitignore'), /^\.claude\/reviews\/$/m);
    assert.match(read(withBoard, '.gitignore'), /^\.claude\/quality\/$/m);
    assert.match(read(withBoard, '.gitignore'), /^\.claude\/pr\.md$/m);
    assert.equal(existsSync(join(withBoard, 'context/tasks/active.md')), false);

    // The installed tool runs from .claude/tools and reaches the installed hooks.
    const out = execFileSync('node', ['.claude/tools/tasks.mjs', 'add', 'First task'], { cwd: withBoard, encoding: 'utf8' });
    assert.match(out, /context\/tasks\/list\/0001-first-task\.md/);
    assert.match(read(withBoard, 'context/tasks/state/next.md'), /0001 First task/);

    const legacy = nextApp();
    await runInit(legacy, { 'install.hooks': ['testing'], 'install.skills': ['writing-tests'] });
    assert.match(read(legacy, 'context/tasks/active.md'), /^## Expected behavior$/m);
    assert.ok(loadManifest(legacy).files['context/tasks/active.md']);
    assert.equal(existsSync(join(legacy, '.claude/tools/tasks.mjs')), false);

    // The package lister is installed everywhere, allowed, and runs in place.
    assert.ok(JSON.parse(read(legacy, '.claude/settings.json')).permissions.allow.includes('Bash(node .claude/tools/list-packages.mjs:*)'));
    assert.match(read(legacy, 'AGENT.md'), /list-packages\.mjs/);
    const listed = JSON.parse(execFileSync('node', ['.claude/tools/list-packages.mjs', '--json'], { cwd: legacy, encoding: 'utf8' }));
    assert.ok(listed.some((m) => m.file === 'package.json' && m.packages.length), 'lists the app packages');
    assert.ok(read(legacy, '.claude/tools/create-pr.mjs').length > 0);
    assert.ok(!JSON.parse(read(legacy, '.claude/settings.json')).permissions.allow.some((p) => p.includes('create-pr')), 'opening a PR is not pre-approved');
    for (const tool of ['git-comments.mjs', 'worktree-history.mjs', 'quality-check.mjs', 'roadmap.mjs', 'sync-docs.mjs']) {
      assert.ok(JSON.parse(read(legacy, '.claude/settings.json')).permissions.allow.includes(`Bash(node .claude/tools/${tool}:*)`), tool);
    }
    // worktree-history imports git-comments from next to it in .claude/tools.
    execFileSync('git', ['init', '-q'], { cwd: legacy });
    assert.match(execFileSync('node', ['.claude/tools/worktree-history.mjs', 'list'], { cwd: legacy, encoding: 'utf8' }), /^\./);

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

  it('drops deselected hooks and declined sandbox from an edited settings.json, keeping user keys', async () => {
    const root = nextApp();
    await runInit(root, { 'install.hooks': ['access_guard', 'naming', 'atomicity'], 'install.sandbox': true });
    const edited = JSON.parse(read(root, '.claude/settings.json'));
    edited.model = 'opus';
    edited.permissions.allow.push('Bash(make:*)');
    edited.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook.sh' }] });
    writeFileSync(join(root, '.claude/settings.json'), JSON.stringify(edited, null, 2));

    const { ops } = await runInit(root, { 'install.hooks': ['access_guard'], 'install.sandbox': false });
    assert.equal(actions(ops)['.claude/settings.json'], 'merge');
    const settings = JSON.parse(read(root, '.claude/settings.json'));
    const commands = settings.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
    assert.ok(commands.some((c) => c.includes('access_guard.mjs')));
    assert.ok(!commands.some((c) => c.includes('naming.mjs') || c.includes('atomicity.mjs')), 'deselected hooks are unregistered');
    assert.ok(commands.includes('my-own-hook.sh'), 'user hooks are kept');
    assert.equal(settings.model, 'opus');
    assert.ok(settings.permissions.allow.includes('Bash(make:*)'));
    assert.equal(settings.sandbox, undefined, 'a declined sandbox is removed');
  });

  it('does not duplicate a hook whose definition changed upstream', () => {
    const before = composeSettings({ hooks: ['access_guard'] });
    const after = structuredClone(before);
    after.hooks.PreToolUse[0].hooks[0].timeout = 30;
    const existing = { ...structuredClone(before), model: 'opus' };
    const merged = mergeSettings(existing, after, before);
    assert.equal(merged.hooks.PreToolUse.length, 1);
    assert.equal(merged.hooks.PreToolUse[0].hooks[0].timeout, 30);
    assert.equal(merged.model, 'opus');
  });

  it('cleans stones hooks from settings installed before snapshots were recorded', () => {
    const old = composeSettings({ hooks: ['access_guard', 'naming'] });
    const merged = mergeSettings(old, composeSettings({ hooks: ['access_guard'] }));
    const commands = merged.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
    assert.deepEqual(commands.filter((c) => c.includes('.claude/hooks/')).length, 1);
  });

  it('removes files of deselected hooks and skills unless they were edited', async () => {
    const root = nextApp();
    await runInit(root, { 'install.hooks': ['access_guard', 'naming', 'format'], 'install.skills': ['writing-tests', 'naming-files'] });
    writeFileSync(join(root, '.claude/hooks/format.mjs'), '// my tweaks\n');
    const { ops } = await runInit(root, { 'install.hooks': ['access_guard'], 'install.skills': ['writing-tests'] });
    assert.equal(actions(ops)['.claude/hooks/naming.mjs'], 'remove');
    assert.equal(existsSync(join(root, '.claude/hooks/naming.mjs')), false);
    assert.equal(existsSync(join(root, '.claude/skills/naming-files/SKILL.md')), false);
    assert.equal(actions(ops)['.claude/hooks/format.mjs'], 'conflict', 'an edited file is left in place');
    assert.equal(existsSync(join(root, '.claude/hooks/format.mjs')), true);
    assert.equal(loadManifest(root).files['.claude/hooks/naming.mjs'], undefined);
    assert.ok(existsSync(join(root, '.claude/skills/writing-tests/SKILL.md')));
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

  it('installs atomicity artifacts by default', async () => {
    const root = prismaApp();
    const { answers } = await runInit(root);
    assert.ok(answers.install.hooks.includes('atomicity'));
    assert.ok(existsSync(join(root, '.claude/hooks/atomicity.mjs')));
    assert.ok(existsSync(join(root, '.claude/atomicity.json')));
    assert.ok(existsSync(join(root, '.claude/danger/.gitkeep')));
  });

  it('ships system-prompts as a discoverable referenced skill', () => {
    const skill = skillCatalog().find((s) => s.id === 'system-prompts');
    assert.ok(skill);
    assert.equal(skill.main, 'system-prompts/SKILL.md');
    const content = readFileSync(new URL('../skills/system-prompts/SKILL.md', import.meta.url), 'utf8');
    assert.match(content, /https:\/\//);
    const prompts = readFileSync(new URL('../skills/prompts/SKILL.md', import.meta.url), 'utf8');
    assert.match(prompts, /system-prompts/);
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

describe('package', () => {
  it('is published under the name the README tells people to run with npx', () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    const readme = readFileSync(join(PACKAGE_ROOT, 'README.md'), 'utf8');
    const names = new Set([...readme.matchAll(/npx ([@\w/.-]+)/g)].map((m) => m[1]));
    assert.deepEqual([...names], [pkg.name]);
  });
});

describe('complexity hook install', () => {
  it('installs the analyzer compose file the hook points Claude to', async () => {
    const root = nextApp();
    await runInit(root, { 'install.hooks': ['complexity'] });
    const hint = /docker compose -f (\S+)/.exec(read(root, '.claude/hooks/complexity.mjs'))[1];
    assert.ok(existsSync(join(root, hint)), `${hint} is installed`);
    assert.ok(existsSync(join(root, '.claude/analyzers/analyzers.Dockerfile')));
    const dockerfile = /dockerfile: (\S+)/.exec(read(root, hint))[1];
    assert.ok(existsSync(join(root, '.claude', dockerfile)), 'the build context .claude/ holds the Dockerfile');
  });
});

describe('defaults', () => {
  it('selects core guardrails and atomicity by default; other gates and logging are opt-in', async () => {
    const { answers } = await runInit(nextApp());
    for (const id of ['access_guard', 'naming', 'format', 'atomicity']) assert.ok(answers.install.hooks.includes(id), id);
    for (const id of ['history', 'testing', 'four-d', 'complexity', 'graph']) {
      assert.ok(!answers.install.hooks.includes(id), `${id} is opt-in`);
    }
  });

  it('marks opt-in hooks in the catalog so the interview can say so', () => {
    const byId = Object.fromEntries(hookCatalog().map((h) => [h.id, h]));
    assert.equal(byId.access_guard.default, true);
    assert.equal(byId.atomicity.default, true);
    assert.equal(byId.history.default, false);
  });

  it('keeps personal preferences out of the shared project settings', () => {
    const s = composeSettings({ hooks: ['access_guard'] });
    for (const key of ['language', 'alwaysThinkingEnabled', 'attribution', 'cleanupPeriodDays']) {
      assert.equal(key in s, false, key);
    }
  });
});

describe('hook libraries', () => {
  it('installs the shared shell tokenizer with the hooks that import it, and they run', async () => {
    const root = nextApp();
    await runInit(root, { 'install.hooks': ['access_guard'] });
    assert.ok(existsSync(join(root, '.claude/hooks/lib/shell.mjs')));
    const run = spawnSync(process.execPath, [join(root, '.claude/hooks/access_guard.mjs')], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'cat .env' }, cwd: root }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(run.status, 2, String(run.stderr));

    await runInit(root, { 'install.hooks': ['naming'] });
    assert.equal(existsSync(join(root, '.claude/hooks/lib/shell.mjs')), false, 'removed when no hook needs it');
  });

  it('installs the shared Python detector with four-d, and the hook runs', async () => {
    const root = nextApp();
    await runInit(root, { 'install.hooks': ['four-d'] });
    assert.ok(existsSync(join(root, '.claude/hooks/lib/python.mjs')));
    const run = spawnSync(process.execPath, [join(root, '.claude/hooks/four-d.mjs')], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the failing test', cwd: root }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(run.status, 0, String(run.stderr));
  });

  it('runs installed hooks when the project path goes through a symlink', async () => {
    const real = nextApp();
    await runInit(real, { 'install.hooks': ['access_guard'] });
    const link = join(mkdtempSync(join(tmpdir(), 'stones-link-')), 'project');
    symlinkSync(real, link);
    const run = spawnSync(process.execPath, [join(link, '.claude/hooks/access_guard.mjs')], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'cat .env' }, cwd: link }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: link },
    });
    assert.equal(run.status, 2, String(run.stderr));
  });

  it('every relative import in a hook resolves to a file the installer ships with it', () => {
    for (const hook of hookCatalog()) {
      const source = readFileSync(join(PACKAGE_ROOT, 'hooks', hook.file), 'utf8');
      for (const [, rel] of source.matchAll(/from '\.\/(lib\/[\w.-]+)'/g)) {
        assert.ok(existsSync(join(PACKAGE_ROOT, 'hooks', rel)), `${hook.file} -> ${rel}`);
      }
    }
  });
});

describe('complexity score', () => {
  it('computes normalized dependency entropy from internal import edges', () => {
    const g = dependencyEntropy([['a', 'core'], ['b', 'core'], ['c', 'core'], ['c', 'b'], ['c', 'b'], ['a', 'a']]);
    assert.equal(g.edges, 4, 'duplicates and self-imports are dropped');
    assert.equal(g.nodes, 4);
    assert.ok(Math.abs(g.entropy - 0.8113) < 1e-3);
    assert.ok(Math.abs(g.normalized - 0.4056) < 1e-3);
    assert.equal(dependencyEntropy([]).normalized, 0);
    assert.deepEqual(edgesFromGraph({ files: { 'a.ts': { imports: ['b.ts'] }, 'b.ts': { imports: [] } } }), [['a.ts', 'b.ts']]);
  });

  it('derives the metric set from per-function data', () => {
    const { metrics, violations } = computeMetrics({
      functions: [{ name: 'f', cc: 2, nesting: 1, loc: 10 }, { name: 'g', cc: 12, nesting: 2, loc: 20 }, { name: 'h', cc: 1, nesting: 5, loc: 5 }, { name: 'k', cc: 1, nesting: 0, loc: 5 }],
      symbols: 5,
    });
    assert.equal(metrics.cc_mean, 4);
    assert.equal(metrics.cc_max, 12);
    assert.equal(metrics.max_nesting_depth, 5);
    assert.equal(metrics.lines_per_symbol, 8);
    assert.equal(metrics.violation_pct, 50, 'g breaks cc, h breaks nesting');
    assert.deepEqual(violations.map((v) => v.name), ['g', 'h']);
    assert.equal(metrics.graph_dependency_entropy, null, 'no edges, not measured');
  });

  it('scores only measured metrics and grades the index', () => {
    const clean = complexityIndex({ cc_mean: 2, max_nesting_depth: 2, lines_per_symbol: 10, graph_dependency_entropy: 0.3, violation_pct: 0 });
    assert.equal(clean.index, 0);
    assert.equal(clean.grade, 'A');
    const worst = complexityIndex({ cc_mean: 30, violation_pct: 90 });
    assert.equal(worst.index, 100);
    assert.equal(worst.grade, 'E');
    assert.ok(Math.abs(worst.coverage - 0.55) < 1e-9);
    assert.equal(complexityIndex({ cc_mean: 7 }).index, 50, 'halfway between good and limit');
    assert.equal(complexityIndex({}).index, null);
  });

  it('reports deltas against a baseline', () => {
    const r = report({ metrics: { cc_mean: 5, violation_pct: 10 } }, { index: 40, metrics: { cc_mean: 6, violation_pct: 10 } });
    assert.equal(r.delta.cc_mean, -1);
    assert.equal(r.delta.violation_pct, 0);
    assert.ok(Number.isFinite(r.delta.index));
  });
});
