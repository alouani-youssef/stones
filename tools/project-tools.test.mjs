import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { createPr, draftPr, runCli as prCli, specPath, zoneOf } from './create-pr.mjs';
import { setComment } from './git-comments.mjs';
import { planSteps, qualityCheck, run as qualityCli } from './quality-check.mjs';
import { addDecision, checkRoadmap, parseRoadmap, run as roadmapCli } from './roadmap.mjs';
import { agentDrift, main as syncCli, syncDocs } from './sync-docs.mjs';

function repo(files = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stones-tools-')));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  write(root, files);
  git('add', '-A');
  git('commit', '-qm', 'init', '--allow-empty');
  const commit = (file, message) => {
    write(root, { [file]: `${message}\n` });
    git('add', file);
    git('commit', '-qm', message);
  };
  return { root, git, commit };
}

function write(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
}

const capture = (fn, argv, cwd, extra = {}) => {
  const out = [];
  const err = [];
  const code = fn(argv, { cwd, log: (l) => out.push(l), error: (l) => err.push(l), ...extra });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

const manifest = (commands) => ({ '.claude/stones.json': { answers: { workflow: { commands } } } });

describe('quality-check', () => {
  it('plans configured steps in order, leaving format out unless asked', () => {
    const commands = { test: 't', format: 'f', lint: 'l', e2e: 'e' };
    assert.deepEqual(planSteps(commands).map((s) => s.name), ['lint', 'test', 'e2e']);
    assert.deepEqual(planSteps(commands, { only: ['format'] }).map((s) => s.name), ['format']);
    assert.deepEqual(planSteps(commands, { skip: ['test', 'e2e'] }).map((s) => s.name), ['lint']);
  });

  it('runs every step, reports failures with their output, and records the run', () => {
    const { root, git } = repo(manifest({ lint: 'echo lint ok', test: 'echo "1 failing" && exit 3', build: 'echo built' }));
    const r = qualityCheck(root);
    assert.equal(r.passed, false);
    assert.deepEqual(r.results.map((s) => [s.name, s.passed]), [['lint', true], ['test', false], ['build', true]]);
    assert.match(r.results[1].tail, /1 failing/);
    const last = JSON.parse(readFileSync(join(root, '.claude/quality/last.json'), 'utf8'));
    assert.equal(last.commit, git('rev-parse', 'HEAD'));
    assert.match(readFileSync(join(root, '.claude/quality/test.log'), 'utf8'), /^\$ echo "1 failing"/);

    const fast = qualityCheck(root, { failFast: true });
    assert.deepEqual(fast.results.map((s) => s.name), ['lint', 'test']);
    assert.deepEqual(fast.skipped, ['build']);

    const cli = capture(qualityCli, ['--only', 'lint,test'], root);
    assert.equal(cli.code, 1);
    assert.match(cli.out, /^PASS {2}lint/m);
    assert.match(cli.out, /^FAIL {2}test/m);
    assert.match(cli.out, /Checks failed\./);
  });

  it('accepts --cmd overrides and says when there is nothing to run', () => {
    const { root } = repo();
    assert.equal(capture(qualityCli, ['--cmd', 'test=exit 0'], root).code, 0);
    const none = capture(qualityCli, [], root);
    assert.equal(none.code, 2);
    assert.match(none.err, /no commands to run/);
  });
});

describe('create-pr', () => {
  it('derives the zone and spec path from the branch name', () => {
    assert.equal(zoneOf('deps/add-zod'), 'packages');
    assert.equal(zoneOf('db/users-email'), 'db');
    assert.equal(zoneOf('net/stripe'), 'network');
    assert.equal(zoneOf('feat/login'), 'none');
    assert.equal(specPath('deps/add-zod'), '.claude/danger/deps-add-zod.md');
  });

  it('drafts the skill sections from commits, comments, spec and the last quality run', () => {
    const { root, git, commit } = repo(manifest({ test: 'echo ok' }));
    git('checkout', '-qb', 'deps/add-zod');
    write(root, { '.claude/danger/deps-add-zod.md': '# spec\n' });
    commit('package.json', 'chore(deps): add zod');
    setComment(root, 'HEAD', 'Pinned to 3.23 for Node 18.');
    commit('lock.txt', 'chore(deps): lockfile');
    qualityCheck(root);

    const pr = draftPr(root);
    assert.equal(pr.base, 'main');
    assert.equal(pr.zone, 'packages');
    assert.equal(pr.title, 'Add zod');
    assert.deepEqual(pr.commits.map((c) => c.subject), ['chore(deps): add zod', 'chore(deps): lockfile']);
    for (const h of ['Summary', 'Zone', 'Spec link', 'Risk', 'Rollback', 'Verification']) assert.match(pr.body, new RegExp(`^## ${h}$`, 'm'), h);
    assert.match(pr.body, /^## Zone\npackages$/m);
    assert.match(pr.body, /^## Spec link\n\.claude\/danger\/deps-add-zod\.md$/m);
    assert.match(pr.body, /Pinned to 3\.23 for Node 18\./);
    assert.match(pr.body, /- `echo ok`: passed/);

    commit('more.txt', 'chore(deps): one more');
    assert.match(draftPr(root).body, /not on HEAD .*TODO re-run/);
  });

  it('refuses on the base branch, without commits, or for a danger branch without its spec', () => {
    const { root, git, commit } = repo();
    assert.match(capture(prCli, ['draft'], root).err, /you are on main/);
    git('checkout', '-qb', 'feat/x');
    assert.match(capture(prCli, ['draft'], root).err, /no commits on feat\/x since main/);
    git('checkout', '-qb', 'db/users');
    commit('m.sql', 'add users table');
    assert.match(draftPr(root).body, /TODO: \.claude\/danger\/db-users\.md is missing/);
  });

  it('opens the PR with gh only when the body is complete and the branch is pushed', () => {
    const { root, git, commit } = repo();
    const remote = realpathSync(mkdtempSync(join(tmpdir(), 'stones-remote-')));
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git('remote', 'add', 'origin', remote);
    git('push', '-q', 'origin', 'main');
    git('checkout', '-qb', 'feat/login');
    commit('login.txt', 'feat: add login');

    const calls = join(root, 'gh-calls.json');
    const gh = join(root, 'fake-gh.mjs');
    writeFileSync(gh, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)));\nconsole.log('https://github.com/o/r/pull/7');\n`.replace("require('fs')", "(await import('node:fs'))"));
    chmodSync(gh, 0o755);

    const draft = capture(prCli, ['draft'], root).out;
    write(root, { '.claude/pr.md': draft });
    assert.match(capture(prCli, ['create', '--body-file', '.claude/pr.md'], root, { gh }).err, /still has TODOs/);

    write(root, { '.claude/pr.md': draft.replace(/TODO[^\n]*/g, 'Filled in.') });
    assert.match(capture(prCli, ['create', '--body-file', '.claude/pr.md'], root, { gh }).err, /no upstream; push it first: git push -u origin feat\/login/);
    assert.equal(existsSync(calls), false, 'gh is not called before the branch is pushed');

    git('push', '-q', '-u', 'origin', 'feat/login');
    const result = createPr(root, { bodyFile: '.claude/pr.md', draft: true, gh });
    assert.equal(result.url, 'https://github.com/o/r/pull/7');
    const args = JSON.parse(readFileSync(calls, 'utf8'));
    assert.deepEqual(args.slice(0, 8), ['pr', 'create', '--base', 'main', '--head', 'feat/login', '--title', 'feat: add login']);
    assert.ok(args.includes('--draft'));
    const body = args[args.indexOf('--body') + 1];
    assert.match(body, /^## Summary\nFilled in\./);
    assert.doesNotMatch(body, /<!--/, 'the title comment is not part of the body');
  });
});

const ROADMAP = `# Roadmap

_Last revised: 2026-11-01_

## Outcome

Teams ship a configured Claude setup in one command.

## Now

### Users can install framework plugins

- **Goal:** detected stacks get their best-practice plugin.
- **Scope:** marketplace, detection, tests.
- **Done when:** init enables the plugin in a NestJS repo.
- **Risks:** upstream skills change.

## Next

- **Task board** — tasks with scenarios and reviews.
- **Docs sync** — docs never drift.

## Later

- **Web UI** — not needed yet.

## Out of scope

- Hosting plugins.

## Decisions

| Date | Decision | Why |
| ---- | -------- | --- |
| 2026-10-01 | Vendor skills | Pinned and reviewable |
`;

describe('roadmap', () => {
  it('reads the Now milestone, Next, Later and decisions', () => {
    const r = parseRoadmap(ROADMAP);
    assert.equal(r.revised, '2026-11-01');
    assert.equal(r.now[0].name, 'Users can install framework plugins');
    assert.equal(r.now[0].fields['done when'], 'init enables the plugin in a NestJS repo.');
    assert.deepEqual(r.next.map((n) => n.name), ['Task board', 'Docs sync']);
    assert.equal(r.next[0].note, 'tasks with scenarios and reviews.');
    assert.deepEqual(r.later.map((n) => n.name), ['Web UI']);
    assert.deepEqual(r.decisions, [{ date: '2026-10-01', decision: 'Vendor skills', why: 'Pinned and reviewable' }]);
    assert.deepEqual(checkRoadmap(r, { on: '2026-11-09' }), []);
  });

  it('reports rule violations and staleness', () => {
    const broken = ROADMAP.replace('### Users', '### First\n\n### Users').replace(/- \*\*Docs sync\*\*.*\n/, '').replace('## Later', '## Someday');
    const problems = checkRoadmap(parseRoadmap(broken), { on: '2027-06-01', maxAge: 90 });
    assert.ok(problems.some((p) => /exactly one milestone, found 2/.test(p)));
    assert.ok(problems.some((p) => /"Next" should list 2 to 4 milestones, found 1/.test(p)));
    assert.ok(problems.some((p) => /missing section "## Later"/.test(p)));
    assert.ok(problems.some((p) => /Now milestone "First" has no \*\*Goal:\*\*/.test(p)));
    assert.ok(problems.some((p) => /last revised 212 days ago/.test(p)));
    assert.deepEqual(checkRoadmap(parseRoadmap('')), ['ROADMAP.md is empty or has no "## " sections; run /roadmap to write it']);
  });

  it('adds decisions to the table, or creates it', () => {
    const added = addDecision(ROADMAP, 'Use git notes | for comments', 'Commits stay unchanged', '2026-11-09');
    assert.match(added, /\| 2026-10-01 \| Vendor skills \| Pinned and reviewable \|\n\| 2026-11-09 \| Use git notes \\\| for comments \| Commits stay unchanged \|\n$/);
    assert.equal(parseRoadmap(added).decisions.length, 2);
    const created = addDecision('# Roadmap\n\n## Now\n', 'A', 'B', '2026-11-09');
    assert.deepEqual(parseRoadmap(created).decisions, [{ date: '2026-11-09', decision: 'A', why: 'B' }]);
  });

  it('works from the CLI', () => {
    const { root } = repo({ 'ROADMAP.md': ROADMAP });
    assert.match(capture(roadmapCli, ['show'], root).out, /^Now: Users can install framework plugins$/m);
    assert.equal(capture(roadmapCli, ['check', '--max-age', '100000'], root).code, 0);
    assert.equal(capture(roadmapCli, ['decide', 'Ship it', 'Ready'], root).code, 0);
    assert.match(readFileSync(join(root, 'ROADMAP.md'), 'utf8'), /\| Ship it \| Ready \|/);
    assert.match(capture(roadmapCli, ['show'], repo().root).err, /no ROADMAP\.md yet/);
  });
});

describe('sync-docs', () => {
  it('finds broken relative links and missing package scripts, ignoring code blocks and URLs', () => {
    const { root } = repo({
      'package.json': { scripts: { test: 'vitest', build: 'tsc' } },
      'README.md': [
        'See [guide](docs/guide.md), [api](docs/api.md#auth), [site](https://x.dev) and [top](#intro).',
        'Run `pnpm run test` then `npm run lint`.',
        '```md',
        '[template](docs/not-checked.md)',
        '```',
        'Inline `[code](nope.md)` is not a link.',
      ].join('\n'),
      'docs/guide.md': 'Back to [readme](../README.md) and [missing](./gone.md).\n',
      'node_modules/pkg/README.md': '[x](nowhere.md)\n',
    });
    const result = syncDocs(root);
    const found = result.problems.map((p) => `${p.file}:${p.line} ${p.kind}`);
    assert.deepEqual(found.sort(), ['README.md:1 link', 'README.md:2 script', 'docs/guide.md:1 link'].sort());
    assert.match(result.problems.find((p) => p.kind === 'script').message, /npm run lint/);
  });

  it('flags AGENT.md commands that drifted from stones.json and a missing CLAUDE.md import', () => {
    const agent = 'Commands:\n\n- test: `pnpm run test`\n- lint: `pnpm run lint`\n';
    assert.deepEqual(agentDrift(agent, { answers: { workflow: { commands: { test: 'pnpm run test', lint: 'pnpm run lint' } } } }), []);
    const drift = agentDrift(agent, { answers: { workflow: { commands: { test: 'pnpm vitest run', build: 'pnpm run build' } } } });
    assert.deepEqual(drift.map((p) => p.message.split(';')[0]), [
      'test is `pnpm run test` but .claude/stones.json has `pnpm vitest run`',
      'does not list the build command `pnpm run build`',
    ]);

    const { root } = repo({ 'AGENT.md': agent, 'CLAUDE.md': '# Notes\n', 'package.json': { scripts: { test: 'x' } }, ...manifest({ test: 'pnpm run test', lint: 'pnpm run lint' }) });
    const before = syncDocs(root);
    assert.ok(before.problems.some((p) => p.file === 'CLAUDE.md' && /does not import @AGENT\.md/.test(p.message)));
    assert.ok(before.problems.some((p) => p.file === '.claude/stones.json' && /lint: `pnpm run lint` but package.json has no "lint"/.test(p.message)));

    const cli = capture(syncCli, ['--fix'], root);
    assert.match(cli.out, /fixed {2}CLAUDE\.md: added the @AGENT\.md import/);
    assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), '# Notes\n\n@AGENT.md\n');
    assert.equal(syncDocs(root).problems.some((p) => p.file === 'CLAUDE.md'), false);
  });

  it('passes on a clean project', () => {
    const { root } = repo({ 'README.md': 'See [docs](docs/a.md).\n', 'docs/a.md': '# A\n' });
    const cli = capture(syncCli, [], root);
    assert.equal(cli.code, 0);
    assert.match(cli.out, /Docs match the repository\./);
  });
});
