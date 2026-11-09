import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { currentTask, evaluate as testingGuard } from '../hooks/testing.mjs';
import { coverage, globMatcher } from './review.mjs';
import { addTask, boardEntries, currentTaskOf, findTask, main } from './tasks.mjs';

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'stones-tasks-'));
  const run = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 't@example.com');
  run('config', 'user.name', 'T');
  write(root, '.claude/complexity.json', '{"enabled": false}');
  write(root, 'README.md', 'x\n');
  run('add', '.');
  run('commit', '-qm', 'init');
  return { root, run };
}

function write(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

const read = (root, path) => readFileSync(join(root, path), 'utf8');

async function cli(root, ...argv) {
  const out = [];
  const code = await main(argv, { root, log: (l) => out.push(l) });
  return { code, out: out.join('\n') };
}

function fillTask(root, task, { scope = 'src/**, test/**' } = {}) {
  const text = read(root, task.path)
    .replace(/^Scope:.*$/m, `Scope: ${scope}`)
    .replace(/TODO: Describe the behavior[^\n]*/, 'Logins are rate limited per IP.')
    .replace(/- Scenario: TODO[^\n]*/, '- Scenario: sixth login attempt within a minute. Expected: rate limited response with retry header.');
  write(root, task.path, text);
}

describe('task board', () => {
  it('adds tasks to list/ and queues them in next.md', async () => {
    const { root } = repo();
    const { code, out } = await cli(root, 'add', 'Add login rate limit', '--scope', 'src/**');
    assert.equal(code, 0);
    assert.match(out, /context\/tasks\/list\/0001-add-login-rate-limit\.md/);
    const task = findTask(root, '1');
    assert.equal(task.status, 'next');
    assert.equal(task.scope, 'src/**');
    assert.equal(boardEntries(root, 'next').length, 1);
    for (const s of ['current', 'blocked', 'done']) assert.equal(boardEntries(root, s).length, 0);
    assert.equal(addTask(root, 'Second').id, '0002');
  });

  it('starts one task at a time and points the testing hook at it', async () => {
    const { root } = repo();
    const a = addTask(root, 'First');
    addTask(root, 'Second');
    assert.equal((await cli(root, 'start', '1')).code, 0);
    assert.equal(currentTaskOf(root).id, a.id);
    assert.equal(boardEntries(root, 'next').length, 1);
    assert.match(findTask(root, '1').base, /^[0-9a-f]{40}$/);
    assert.equal(findTask(root, '1').branch, 'main');
    await assert.rejects(cli(root, 'start', '2'), /0001 is in progress/);

    assert.equal(currentTask(root).path, a.path);
    // The template still has TODOs, so the testing hook blocks test runs.
    assert.equal(testingGuard({ tool_name: 'Bash', tool_input: { command: 'npm test' } }, { projectDir: root }).block, true);
    fillTask(root, a);
    assert.equal(testingGuard({ tool_name: 'Bash', tool_input: { command: 'npm test' } }, { projectDir: root }).block, false);
  });

  it('blocks the test guard when no task is in progress', async () => {
    const { root } = repo();
    await cli(root, 'list');
    const r = testingGuard({ tool_name: 'Bash', tool_input: { command: 'npm test' } }, { projectDir: root });
    assert.equal(r.block, true);
    assert.match(r.reason, /No task is in progress/);
  });

  it('moves a task to blocked with its reason and resumes it with the same base', async () => {
    const { root, run } = repo();
    addTask(root, 'First');
    await cli(root, 'start', '1');
    const base = findTask(root, '1').base;
    await cli(root, 'block', '1', 'waiting', 'for', 'API', 'keys');
    assert.equal(currentTaskOf(root), null);
    assert.match(boardEntries(root, 'blocked')[0], /· waiting for API keys$/);
    write(root, 'src/a.js', 'x\n');
    run('add', '.');
    run('commit', '-qm', 'more');
    await cli(root, 'start', '1');
    assert.equal(findTask(root, '1').base, base);
    assert.equal(boardEntries(root, 'blocked').length, 0);
  });

  it('marks a task done only when its tests pass', async () => {
    const { root } = repo();
    addTask(root, 'First');
    await cli(root, 'start', '1');
    const failed = await cli(root, 'done', '1', '--', 'node', '-e', '"process.exit(3)"');
    assert.equal(failed.code, 3);
    assert.match(failed.out, /NOT done/);
    assert.equal(currentTaskOf(root).id, '0001');

    const passed = await cli(root, 'done', '--', 'node', '-e', '"console.log(\'5 passing\')"');
    assert.equal(passed.code, 0);
    assert.equal(currentTaskOf(root), null);
    assert.match(boardEntries(root, 'done')[0], /commits [0-9a-f]{7}\.\.[0-9a-f]{7} · tests: node -e .* → 5 passing/);
    assert.equal(findTask(root, '1').status, 'done');
  });
});

describe('task review', () => {
  it('is ready when the task is complete, in scope, tested and passing', async () => {
    const { root, run } = repo();
    const task = addTask(root, 'Add login rate limit');
    await cli(root, 'start', '1');
    fillTask(root, task);
    write(root, 'src/rate.js', 'export const limit = 5;\n');
    write(root, 'test/rate.test.js', "it('returns a rate limited response with a retry header on the sixth login attempt', () => {});\n");
    run('add', '.');
    run('commit', '-qm', 'rate limit');
    const r = await cli(root, 'review', '--run-tests', '--', 'node', '-e', '0');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^READY/);
    const pkg = read(root, '.claude/reviews/0001.md');
    assert.match(pkg, /- \[x\] Scenario: sixth login attempt/);
    assert.match(pkg, /test\/rate\.test\.js \(test\)/);
    assert.match(pkg, /```diff[\s\S]*export const limit = 5/);
  });

  it('reports failing tests, missing tests, scope creep and mixed change kinds', async () => {
    const { root, run } = repo();
    const task = addTask(root, 'Add login rate limit');
    await cli(root, 'start', '1');
    fillTask(root, task);
    write(root, 'src/rate.js', 'export const limit = 5;\n');
    write(root, 'package.json', '{"dependencies": {"left-pad": "1"}}\n');
    run('add', '.');
    run('commit', '-qm', 'rate limit');
    write(root, 'src/wip.js', 'x\n');
    const r = await cli(root, 'review', '--run-tests', '--', 'node', '-e', '"process.exit(1)"');
    assert.equal(r.code, 1);
    assert.match(r.out, /^NOT READY/);
    assert.match(r.out, /tests fail/);
    assert.match(r.out, /no test files changed/);
    assert.match(r.out, /outside the task's scope \(src\/\*\*, test\/\*\*\): package\.json/);
    assert.match(r.out, /uncommitted changes .*src\/wip\.js/);
    assert.match(r.out, /mixes code \+ packages/);
  });

  it('flags commits made after the recorded test run', async () => {
    const { root, run } = repo();
    const task = addTask(root, 'Feature');
    await cli(root, 'start', '1');
    fillTask(root, task);
    write(root, 'src/a.js', 'a\n');
    write(root, 'test/a.test.js', "it('sixth login attempt rate limited response retry header', () => {});\n");
    run('add', '.');
    run('commit', '-qm', 'a');
    await cli(root, 'done', '--', 'node', '-e', '0');
    write(root, 'src/b.js', 'b\n');
    run('add', '.');
    run('commit', '-qm', 'b');
    const r = await cli(root, 'review', '1');
    assert.match(r.out, /commits were added after the tests passed/);
  });

  it('matches scenarios to test changes by keywords and scopes by globs', () => {
    const [hit, miss] = coverage(
      ['Scenario: empty cart checkout. Expected: validation error', 'Scenario: coupon expired. Expected: price unchanged'],
      ["it('rejects an empty cart at checkout with a validation error')"],
    );
    assert.equal(hit.covered, true);
    assert.equal(miss.covered, false);
    const inScope = globMatcher(['src/**', 'docs/*.md']);
    assert.ok(inScope('src/a/b.ts') && inScope('docs/x.md'));
    assert.ok(!inScope('docs/a/x.md') && !inScope('package.json'));
  });
});
