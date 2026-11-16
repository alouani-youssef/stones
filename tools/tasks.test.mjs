import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { currentTask, evaluate as testingGuard } from '../hooks/testing.mjs';
import { coverage, globMatcher } from './review.mjs';
import { EventEmitter } from 'node:events';

import { addTask, boardEntries, currentTaskOf, findTask, main, taskPrompt } from './tasks.mjs';

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
  const code = await main(argv, { root, log: (l) => out.push(l), session: false });
  return { code, out: out.join('\n') };
}

// A stand-in for `claude`: records the call and exits with `code` (or fails with `error`).
function fakeClaude({ code = 0, error } = {}) {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    setImmediate(() => (error ? child.emit('error', error) : child.emit('exit', code)));
    return child;
  };
  return { calls, run };
}

const SPEC = 'docs/superpowers/specs/2026-11-16-login-rate-limit-design.md';
const PLAN = 'docs/superpowers/plans/2026-11-16-login-rate-limit.md';

function fillTask(root, task, { scope = 'src/**, test/**' } = {}) {
  const text = read(root, task.path)
    .replace(/^Scope:.*$/m, `Scope: ${scope}`)
    .replace(/TODO: Describe the behavior[^\n]*/, 'Logins are rate limited per IP.')
    .replace(/- Scenario: TODO[^\n]*/, '- Scenario: sixth login attempt within a minute. Expected: rate limited response with retry header.')
    .replace(/^Spec: .*$/m, `Spec: ${SPEC}`)
    .replace(/^Plan: .*$/m, `Plan: ${PLAN}`)
    .replace(/^TODO: Describe the test levels[^\n]*/m, 'Use focused unit tests for the rate-limit rule and an integration test for the login endpoint response.')
    .replace(/- Case: TODO[^\n]*/m, '- Case: sixth login attempt within a minute. Expected: rate limited response with retry header.')
    .replace(/- Scenario: TODO[^\n]*/, '- Scenario: sixth login attempt within a minute. Expected: rate limited response with retry header.');
  write(root, task.path, text);
  write(root, SPEC, '# Login rate limit design\n\n## Test Strategy\n\nUse unit tests for the limit rule and an integration test for the endpoint.\n\n## Test Cases\n\n- Case: sixth attempt in one minute. Expected: request is rate limited.\n');
  write(root, PLAN, '# Login rate limit plan\n\n## Test Strategy\n\nRun focused unit and integration tests.\n\n## Test Cases\n\n- Case: sixth attempt in one minute. Expected: focused test fails before implementation and passes after.\n');
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
    assert.match(task.text, /## Spec and plan\n\nSpec: TODO: [^\n]*superpowers:brainstorming[^\n]*\nPlan: TODO: [^\n]*superpowers:writing-plans/);
    assert.match(task.text, /## Test Strategy/);
    assert.match(task.text, /## Test Cases/);
    assert.equal(boardEntries(root, 'next').length, 1);
    for (const s of ['current', 'blocked', 'done']) assert.equal(boardEntries(root, s).length, 0);
    assert.equal(addTask(root, 'Second').id, '0002');
  });

  it('refuses to start an incomplete task without changing board state', async () => {
    const { root } = repo();
    const task = addTask(root, 'First');
    const before = read(root, task.path);
    await assert.rejects(cli(root, 'start', '1'), /Expected behavior/i);
    assert.equal(currentTaskOf(root), null);
    assert.equal(findTask(root, '1').status, 'next');
    assert.equal(findTask(root, '1').branch, '');
    assert.equal(findTask(root, '1').base, '');
    assert.equal(read(root, task.path), before);
    assert.equal(boardEntries(root, 'next').length, 1);
  });

  it('requires a test strategy and expected test cases in the note, spec, and plan', async () => {
    const failures = [
      (text) => text.replace(/## Test Strategy[\s\S]*?(?=\n## )/, ''),
      (text) => text.replace(/(## Test Strategy\n\n)[^\n]*/, '$1unit tests'),
      (text) => text.replace(/## Test Cases[\s\S]*/, ''),
      (text) => text.replace(/(- Case:[^\n]*Expected:) [^\n]*/, '$1 TODO'),
      (text) => text.replace(/(- Case:)[^\n]*Expected:[^\n]*/, '$1 x. Expected: y.'),
    ];
    for (const [failureIndex, mutate] of failures.entries()) {
      for (const artifact of ['note', 'spec', 'plan']) {
        const { root } = repo();
        const task = addTask(root, 'First');
        fillTask(root, task);
        const path = artifact === 'note' ? task.path : artifact === 'spec' ? SPEC : PLAN;
        write(root, path, mutate(read(root, path)));
        await assert.rejects(cli(root, 'start', '1'), /test strategy|test case/i, `${artifact} failure ${failureIndex} should fail readiness`);
        assert.equal(currentTaskOf(root), null);
      }
    }
  });

  it('requires existing spec and plan links before task start', async () => {
    for (const label of ['Spec', 'Plan']) {
      const { root } = repo();
      const task = addTask(root, 'First');
      fillTask(root, task);
      write(root, task.path, read(root, task.path).replace(new RegExp(`^${label}: .*`, 'm'), `${label}: TODO`));
      await assert.rejects(cli(root, 'start', '1'), new RegExp(`create the ${label.toLowerCase()}`));
      assert.equal(currentTaskOf(root), null);
    }
    const { root } = repo();
    const task = addTask(root, 'First');
    fillTask(root, task);
    write(root, PLAN, '# Plan file missing\n');
    await assert.rejects(cli(root, 'start', '1'), /Test Strategy.*plan/i);
    assert.equal(currentTaskOf(root), null);
  });

  it('rejects linked design documents outside the project', async () => {
    const { root } = repo();
    const task = addTask(root, 'First');
    fillTask(root, task);
    write(root, task.path, read(root, task.path).replace(SPEC, '../../outside.md'));
    await assert.rejects(cli(root, 'start', '1'), /inside the project/i);
    assert.equal(currentTaskOf(root), null);
  });

  it('rejects a design-document symlink that resolves outside the project', async () => {
    const { root } = repo();
    const task = addTask(root, 'First');
    fillTask(root, task);
    const linkedSpec = 'docs/superpowers/specs/linked.md';
    const outside = join(root, '..', `stones-outside-${process.pid}.md`);
    writeFileSync(outside, read(root, SPEC));
    rmSync(join(root, SPEC));
    symlinkSync(outside, join(root, linkedSpec));
    write(root, task.path, read(root, task.path).replace(SPEC, linkedSpec));
    try {
      await assert.rejects(cli(root, 'start', '1'), /resolve inside the project/i);
      assert.equal(currentTaskOf(root), null);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('starts one task at a time and points the testing hook at it', async () => {
    const { root } = repo();
    const a = addTask(root, 'First');
    addTask(root, 'Second');
    fillTask(root, a);
    assert.equal((await cli(root, 'start', '1')).code, 0);
    assert.equal(currentTaskOf(root).id, a.id);
    assert.equal(boardEntries(root, 'next').length, 1);
    assert.match(findTask(root, '1').base, /^[0-9a-f]{40}$/);
    assert.equal(findTask(root, '1').branch, 'main');
    await assert.rejects(cli(root, 'start', '2'), /0001 is in progress/);

    assert.equal(currentTask(root).path, a.path);
    assert.equal(testingGuard({ tool_name: 'Bash', tool_input: { command: 'npm test' } }, { projectDir: root }).block, false);
  });

  it('opens a Claude Code session loaded with the started task', async () => {
    const { root } = repo();
    const task = addTask(root, 'Add login rate limit');
    fillTask(root, task);
    const fake = fakeClaude({ code: 4 });
    const out = [];
    const code = await main(['start', '1'], { root, log: (l) => out.push(l), session: true, claude: 'claude-x', run: fake.run });
    assert.equal(code, 4);
    assert.equal(fake.calls.length, 1);
    const [{ cmd, args, opts }] = fake.calls;
    assert.equal(cmd, 'claude-x');
    assert.equal(opts.cwd, root);
    assert.equal(opts.stdio, 'inherit');
    assert.match(args[0], /Work on task 0001 "Add login rate limit"\. It is now the current task on the board \(branch main, base [0-9a-f]{7}\)/);
    assert.ok(args[0].includes(read(root, task.path).trim()));
    assert.doesNotMatch(args[0], /still has TODOs/);
    assert.match(args[0], /superpowers:subagent-driven-development[\s\S]*superpowers:test-driven-development[\s\S]*superpowers:verification-before-completion/);
    assert.match(args[0], /tasks\.mjs done 0001/);
    assert.equal(currentTaskOf(root).id, '0001');
  });

  it('skips the session with --no-session or when one cannot open, and forces it with --session', async () => {
    const { root } = repo();
    const task = addTask(root, 'First');
    fillTask(root, task);
    const fake = fakeClaude();
    assert.equal(await main(['start', '1', '--no-session'], { root, log: () => {}, session: true, run: fake.run }), 0);
    assert.equal(await main(['start', '1'], { root, log: () => {}, session: false, run: fake.run }), 0);
    assert.equal(fake.calls.length, 0);
    assert.equal(await main(['start', '--session', '1'], { root, log: () => {}, session: false, run: fake.run }), 0);
    assert.equal(fake.calls.length, 1);
  });

  it('keeps the task started when claude is missing', async () => {
    const { root } = repo();
    const task = addTask(root, 'First');
    fillTask(root, task);
    const out = [];
    const fake = fakeClaude({ error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) });
    assert.equal(await main(['start', '1'], { root, log: (l) => out.push(l), session: true, run: fake.run }), 0);
    assert.match(out.join('\n'), /no session: claude is not on PATH/);
    assert.equal(currentTaskOf(root).id, '0001');
  });

  it('tells a resumed session why the task was blocked', async () => {
    const { root } = repo();
    const task = addTask(root, 'First');
    fillTask(root, task);
    await cli(root, 'start', '1');
    await cli(root, 'block', '1', 'waiting for API keys');
    const fake = fakeClaude();
    await main(['start', '1'], { root, log: () => {}, session: true, run: fake.run });
    assert.match(fake.calls[0].args[0], /It was blocked before: waiting for API keys\./);
    assert.doesNotMatch(taskPrompt(findTask(root, '1')), /blocked before/);
  });

  it('views one state at a time without passing ids', async () => {
    const { root } = repo();
    addTask(root, 'First', { scope: 'src/a/**' });
    addTask(root, 'Second');
    addTask(root, 'Third');
    assert.match((await cli(root, 'current')).out, /^no task is in progress[\s\S]*next \(3\)/);

    fillTask(root, findTask(root, '1'), { scope: 'src/a/**' });
    await cli(root, 'start', '1');
    await cli(root, 'block', '3', 'waiting for API keys');
    const current = (await cli(root, 'current')).out;
    assert.match(current, /^current: 0001 First · branch main\nfile: context\/tasks\/list\/0001-first\.md\n\n# 0001 First/);
    assert.match(current, /## Scenarios/);

    const next = await cli(root, 'next');
    assert.equal(next.code, 0);
    assert.match(next.out, /^next \(1\)\n  1\. 0002 Second\n     note has TODOs$/);
    assert.match((await cli(root, 'blocked')).out, /^blocked \(1\)\n  0003 Third\n     waiting for API keys · note has TODOs$/);
    assert.match((await cli(root, 'list', 'current')).out, /0001 First\n     scope src\/a\/\*\* · branch main/);
    assert.equal((await cli(root, 'list', 'done')).out, 'done: none');
    await assert.rejects(cli(root, 'list', 'later'), /unknown state later/);
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
    const task = addTask(root, 'First');
    fillTask(root, task);
    await cli(root, 'start', '1');
    const base = findTask(root, '1').base;
    await cli(root, 'block', '1', 'waiting', 'for', 'API', 'keys');
    assert.equal(currentTaskOf(root), null);
    assert.match(boardEntries(root, 'blocked')[0], /· waiting for API keys$/);
    write(root, PLAN, '# Incomplete plan\n');
    await assert.rejects(cli(root, 'start', '1'), /Test Strategy.*plan/i);
    assert.equal(currentTaskOf(root), null);
    assert.equal(findTask(root, '1').status, 'blocked');
    assert.equal(findTask(root, '1').base, base);
    fillTask(root, findTask(root, '1'));
    write(root, 'src/a.js', 'x\n');
    run('add', '.');
    run('commit', '-qm', 'more');
    await cli(root, 'start', '1');
    assert.equal(findTask(root, '1').base, base);
    assert.equal(boardEntries(root, 'blocked').length, 0);
  });

  it('marks a task done only when its tests pass', async () => {
    const { root } = repo();
    const task = addTask(root, 'First');
    fillTask(root, task);
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
    fillTask(root, task);
    await cli(root, 'start', '1');
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
    fillTask(root, task);
    await cli(root, 'start', '1');
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
    fillTask(root, task);
    await cli(root, 'start', '1');
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
