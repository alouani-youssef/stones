import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { currentTask, evaluate as testingGuard } from '../hooks/testing.mjs';
import { coverage, globMatcher } from './review.mjs';
import { EventEmitter } from 'node:events';

import { approveQuiz } from './spec-quiz.mjs';
import { loadRegistry } from './evaluation-registry.mjs';
import { parseEvaluation, recordKpi, writePlanEvaluation } from './evaluation.mjs';
import { addTask, currentTaskOf, findTask, main, migrateBoard, tasksIn, taskPrompt } from './tasks.mjs';
import { dispatchText, installedAgents } from './subagents.mjs';

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

const SPEC = 'docs/design/2026-11-16-login-rate-limit-design.md';
const PLAN = 'docs/design/plans/2026-11-16-login-rate-limit.md';

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
  write(root, SPEC, '# Login rate limit design\n\n## Assumptions\n\n- A1: Limits are per account and IP. Status: confirmed\n\n## Test Strategy\n\nUse unit tests for the limit rule and an integration test for the endpoint.\n\n## Test Cases\n\n- Case: sixth attempt in one minute. Expected: request is rate limited.\n');
  write(root, PLAN, '# Login rate limit plan\n\n## Test Strategy\n\nRun focused unit and integration tests.\n\n## Test Cases\n\n- Case: sixth attempt in one minute. Expected: focused test fails before implementation and passes after.\n');
  write(root, QUIZ, quizText());
  approveQuiz(root, QUIZ);
  write(root, task.path, read(root, task.path).replace(/^Approval: .*$/m, `Approval: ${QUIZ}`));
}

const QUIZ = 'docs/design/approvals/2026-11-16-login-rate-limit.md';
const question = (n, answer = 'B', resolution = '') => `## Question ${n} about the rate limit decision?

- A. The account is locked
- B. The request gets a 429
- C. Nothing happens

Expected: B
Answer: ${answer}
${resolution}`;
const quizText = (answers = ['B', 'B', 'B']) =>
  `# Spec check: Login rate limit\n\nSpec: ${SPEC}\nPlan: ${PLAN}\nApproved: TODO\n\n${answers.map((a, i) => question(i + 1, a)).join('\n')}`;

describe('task board', () => {
  it('adds tasks to list/ with Status: next and lists them in next.md', async () => {
    const { root } = repo();
    const { code, out } = await cli(root, 'add', 'Add login rate limit', '--scope', 'src/**');
    assert.equal(code, 0);
    assert.match(out, /docs\/tasks\/list\/0001-add-login-rate-limit\.md/);
    const task = findTask(root, '1');
    assert.equal(task.status, 'next');
    assert.equal(task.scope, 'src/**');
    assert.match(task.text, /## Spec and plan\n\nSpec: TODO: [^\n]*superpowers:brainstorming[^\n]*\nPlan: TODO: [^\n]*superpowers:writing-plans[^\n]*\nApproval: TODO: [^\n]*confirming-specs/);
    assert.match(task.text, /## Test Strategy/);
    assert.match(task.text, /## Test Cases/);
    assert.equal(tasksIn(root, 'next').length, 1);
    for (const s of ['current', 'blocked', 'done']) assert.equal(tasksIn(root, s).length, 0);
    assert.match(read(root, 'docs/tasks/state/next.md'), /^- \[0001 Add login rate limit\]\(\.\.\/list\/0001-add-login-rate-limit\.md\)$/m);
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
    assert.equal(tasksIn(root, 'next').length, 1);
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

  it('requires an approved spec quiz that still matches the spec and plan', async () => {
    const start = async (mutate) => {
      const { root } = repo();
      const task = addTask(root, 'First');
      fillTask(root, task);
      mutate(root, task);
      return cli(root, 'start', '1').then(() => ({ ok: true, root }), (e) => ({ ok: false, message: e.message, root }));
    };
    const unapproved = await start((root, task) => write(root, task.path, read(root, task.path).replace(/^Approval: .*$/m, 'Approval: TODO')));
    assert.match(unapproved.message, /spec quiz/);
    assert.equal(currentTaskOf(unapproved.root), null);
    const stale = await start((root) => write(root, SPEC, `${read(root, SPEC)}\nAccounts are locked after 5 failures.\n`));
    assert.match(stale.message, /changed after/);
    const other = await start((root) => write(root, QUIZ, read(root, QUIZ).replace(/^Plan: .*$/m, 'Plan: docs/design/plans/other.md')));
    assert.match(other.message, /different spec or plan|does not exist/);
    const legacy = await start((root, task) => write(root, task.path, read(root, task.path).replace(/^Approval: .*\n/m, '')));
    assert.ok(legacy.ok, 'notes written before approvals existed are not gated');
    assert.ok((await start(() => {})).ok);
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

  it('rejects a plan linked as the spec', async () => {
    const { root } = repo();
    const task = addTask(root, 'First');
    fillTask(root, task);
    write(root, task.path, read(root, task.path).replace(`Spec: ${SPEC}`, `Spec: ${PLAN}`));
    await assert.rejects(cli(root, 'start', '1'), /link the spec directly under docs\/design\//);
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
    const linkedSpec = 'docs/design/linked.md';
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
    assert.equal(tasksIn(root, 'next').length, 1);
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
    assert.match(current, /^current: 0001 First · branch main\nfile: docs\/tasks\/list\/0001-first\.md\n\n# 0001 First/);
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
    assert.equal(tasksIn(root, 'blocked')[0].extra, 'waiting for API keys');
    assert.match(read(root, task.path), /^Blocked: waiting for API keys$/m);
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
    assert.equal(tasksIn(root, 'blocked').length, 0);
    assert.doesNotMatch(read(root, task.path), /^Blocked:/m);
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
    assert.match(findTask(root, '1').result, /^commits [0-9a-f]{7}\.\.[0-9a-f]{7} · tests: node -e .* → 5 passing$/);
    assert.match((await cli(root, 'list')).out, /done \(1\)\n  \[0001 First\] · commits/);
    assert.equal(findTask(root, '1').status, 'done');
  });
});

describe('task state in the notes', () => {
  const PASS = ['--', 'node', '-e', '0'];

  it('starts the next ready task when one is done, skipping tasks that are not ready', async () => {
    const { root } = repo();
    fillTask(root, addTask(root, 'First'));
    addTask(root, 'Draft');
    fillTask(root, addTask(root, 'Third'));
    await cli(root, 'start', '1');
    const r = await cli(root, 'done', ...PASS);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /done 0001 First/);
    assert.match(r.out, /skipped 0002 Draft: complete ## Expected behavior/);
    assert.match(r.out, /started 0003 Third/);
    assert.equal(findTask(root, '1').status, 'done');
    assert.equal(findTask(root, '2').status, 'next');
    assert.equal(currentTaskOf(root).id, '0003');
    assert.match(findTask(root, '3').base, /^[0-9a-f]{40}$/);
    assert.equal(currentTask(root).path, findTask(root, '3').path);
  });

  it('stops after closing the task with --no-advance, or when nothing is queued or ready', async () => {
    const { root } = repo();
    fillTask(root, addTask(root, 'First'));
    fillTask(root, addTask(root, 'Second'));
    addTask(root, 'Draft');
    await cli(root, 'start', '1');
    const kept = await cli(root, 'done', '1', '--no-advance', ...PASS);
    assert.equal(kept.code, 0);
    assert.doesNotMatch(kept.out, /started/);
    assert.equal(currentTaskOf(root), null);

    await cli(root, 'start', '2');
    const none = await cli(root, 'done', ...PASS);
    assert.match(none.out, /skipped 0003 Draft[\s\S]*no queued task is ready to start/);
    assert.equal(currentTaskOf(root), null);

    const { root: empty } = repo();
    fillTask(empty, addTask(empty, 'Only'));
    await cli(empty, 'start', '1');
    assert.match((await cli(empty, 'done', ...PASS)).out, /no queued tasks left/);
  });

  it('does not advance when tests fail', async () => {
    const { root } = repo();
    fillTask(root, addTask(root, 'First'));
    fillTask(root, addTask(root, 'Second'));
    await cli(root, 'start', '1');
    const r = await cli(root, 'done', '--', 'node', '-e', '"process.exit(2)"');
    assert.equal(r.code, 2);
    assert.equal(currentTaskOf(root).id, '0001');
    assert.equal(findTask(root, '2').status, 'next');
  });

  it('opens the next task\'s session from a terminal', async () => {
    const { root } = repo();
    fillTask(root, addTask(root, 'First'));
    fillTask(root, addTask(root, 'Second'));
    await cli(root, 'start', '1');
    const fake = fakeClaude();
    const code = await main(['done', ...PASS], { root, log: () => {}, session: true, run: fake.run });
    assert.equal(code, 0);
    assert.equal(fake.calls.length, 1);
    assert.match(fake.calls[0].args[0], /Work on task 0002 "Second"/);
  });

  it('merges branches that finish different tasks without conflicts', async () => {
    const { root, run } = repo();
    write(root, '.gitignore', 'docs/tasks/state/\n.claude/\n');
    fillTask(root, addTask(root, 'First'));
    fillTask(root, addTask(root, 'Second'));
    run('add', '.');
    run('commit', '-qm', 'tasks');
    for (const [branch, id] of [['a', '1'], ['b', '2']]) {
      run('checkout', '-q', '-b', branch, 'main');
      await cli(root, 'start', id);
      write(root, `src/${branch}.js`, `${branch}\n`);
      run('add', '.');
      run('commit', '-qm', branch);
      assert.equal((await cli(root, 'done', id, '--no-advance', '--no-pr', ...PASS)).code, 0);
      run('add', '.');
      run('commit', '-qm', `close ${id}`);
    }
    run('checkout', '-q', 'main');
    run('merge', '-q', '--no-edit', 'a');
    run('merge', '-q', '--no-edit', 'b');
    assert.deepEqual(tasksIn(root, 'done').map((t) => t.id), ['0001', '0002']);
    assert.equal(currentTaskOf(root), null);
    // The state files were never committed; sync rebuilds this checkout's copy from the merged notes.
    assert.equal(execFileSync('git', ['ls-files', 'docs/tasks/state'], { cwd: root, encoding: 'utf8' }), '');
    assert.match((await cli(root, 'sync')).out, /rewrote (?:\S+, )*docs\/tasks\/state\/done\.md/);
    assert.equal(read(root, 'docs/tasks/state/next.md').match(/^- \[/gm), null);
    assert.equal(read(root, 'docs/tasks/state/done.md').match(/^- \[/gm).length, 2);
    assert.match((await cli(root, 'sync')).out, /already matches the notes/);
  });

  it('copies blocked reasons and test results that only old state files kept into the notes', async () => {
    const { root } = repo();
    const a = addTask(root, 'First');
    const b = addTask(root, 'Second');
    const c = addTask(root, 'Third');
    for (const [t, status] of [[a, 'current'], [b, 'blocked'], [c, 'done']]) {
      write(root, t.path, read(root, t.path).replace(/^Status: next$/m, `Status: ${status}`));
    }
    const line = (t, extra) => `- [${t.id} ${t.title}](../list/${t.file})${extra ? ` · ${extra}` : ''}`;
    write(root, 'docs/tasks/state/blocked.md', `# Blocked\n\n${line(b, 'waiting for keys')}\n`);
    write(root, 'docs/tasks/state/done.md', `# Done\n\n${line(c, 'commits abc1234..def5678 · tests: npm test → ok')}\n`);
    assert.equal(currentTask(root).path, a.path);

    const out = (await cli(root, 'list')).out;
    assert.equal(findTask(root, '2').blocked, 'waiting for keys');
    assert.equal(findTask(root, '3').result, 'commits abc1234..def5678 · tests: npm test → ok');
    assert.match(out, /current \(1\)\n  \[0001 First\]/);
    assert.match(out, /blocked \(1\)\n  \[0002 Second\] · waiting for keys/);
    assert.match(read(root, 'docs/tasks/state/current.md'), /^- \[0001 First\]\(\.\.\/list\/0001-first\.md\)$/m);
    assert.match(read(root, 'docs/tasks/state/done.md'), /· commits abc1234\.\.def5678 · tests: npm test → ok$/m);
    assert.deepEqual(migrateBoard(root), []);
  });

  it('keeps the state files in step with the notes, even after a hand edit', async () => {
    const { root } = repo();
    fillTask(root, addTask(root, 'First'));
    await cli(root, 'start', '1');
    assert.match(read(root, 'docs/tasks/state/current.md'), /^- \[0001 First\]\(\.\.\/list\/0001-first\.md\) · branch main$/m);
    write(root, 'docs/tasks/state/current.md', '# Current\n');
    assert.equal(currentTaskOf(root).id, '0001', 'the note decides');
    await cli(root, 'list');
    assert.match(read(root, 'docs/tasks/state/current.md'), /0001 First/);
    await cli(root, 'block', '1', 'waiting');
    assert.equal(read(root, 'docs/tasks/state/current.md').match(/^- \[/gm), null);
    assert.match(read(root, 'docs/tasks/state/blocked.md'), /0001 First\]\(\.\.\/list\/0001-first\.md\) · waiting$/m);
  });

  it('starts queued tasks in the order of next.md', async () => {
    const { root } = repo();
    fillTask(root, addTask(root, 'First'));
    fillTask(root, addTask(root, 'Second'));
    fillTask(root, addTask(root, 'Third'));
    const next = read(root, 'docs/tasks/state/next.md').split('\n');
    const [one, two, three] = next.filter((l) => l.startsWith('- ['));
    write(root, 'docs/tasks/state/next.md', next.map((l) => (l === one ? three : l === three ? one : l)).join('\n'));
    assert.deepEqual(tasksIn(root, 'next').map((t) => t.id), ['0003', '0002', '0001']);
    await cli(root, 'start', '2');
    assert.match((await cli(root, 'done', '--no-pr', ...PASS)).out, /started 0003 Third/);
    assert.match((await cli(root, 'next')).out, /1\. 0001 First/);
    assert.ok(two);
  });

  it('keeps the meta lines together at the top of the note', async () => {
    const { root } = repo();
    const task = addTask(root, 'First', { scope: 'src/**' });
    await cli(root, 'block', '1', 'waiting');
    assert.match(read(root, task.path), /^# 0001 First\n\nStatus: blocked\nBranch:\nBase:\nScope: src\/\*\*\nCategory: none\nBlocked: waiting\n\n## Expected behavior/);
  });

  it('writes a complete PR draft for the finished task and prints the commands that open it', async () => {
    const { root, run } = repo();
    const remote = mkdtempSync(join(tmpdir(), 'stones-remote-'));
    execFileSync('git', ['init', '-q', '--bare', remote]);
    run('remote', 'add', 'origin', remote);
    run('push', '-q', 'origin', 'main');
    run('checkout', '-q', '-b', 'feat/login-rate-limit');
    fillTask(root, addTask(root, 'Add login rate limit'));
    await cli(root, 'start', '1');
    write(root, 'src/rate.js', 'export const limit = 5;\n');
    run('add', '.');
    run('commit', '-qm', 'feat: rate limit logins');

    const r = await cli(root, 'done', ...PASS);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /PR draft: \.claude\/pr\.md \(complete\)\nopen the PR with:\n  git add docs\/tasks && git commit -m 'chore\(tasks\): close 0001 Add login rate limit'\n  git push -u origin feat\/login-rate-limit\n  node \.claude\/tools\/create-pr\.mjs create --body-file \.claude\/pr\.md --base main$/m);
    const draft = read(root, '.claude/pr.md');
    assert.match(draft, /^<!-- title: feat: rate limit logins \| base: main \| zone: none -->/);
    assert.match(draft, /^## Summary\nAdd login rate limit: Logins are rate limited per IP\.\n\nTask: \[0001 Add login rate limit\]\(docs\/tasks\/list\/0001-add-login-rate-limit\.md\)/m);
    assert.match(draft, /Scenarios:\n- Scenario: sixth login attempt within a minute\./);
    assert.match(draft, /^## Risk\nNo contract change: .*\(src\/\*\*, test\/\*\*\)\.$/m);
    assert.match(draft, /^## Rollback\nRevert this PR/m);
    assert.match(draft, /^## Verification\n- task 0001 tests: commits [0-9a-f]{7}\.\.[0-9a-f]{7} · tests: node -e 0/m);
    assert.doesNotMatch(draft, /TODO/);
  });

  it('skips the PR draft on the default branch or with --no-pr', async () => {
    const { root } = repo();
    fillTask(root, addTask(root, 'First'));
    fillTask(root, addTask(root, 'Second'));
    await cli(root, 'start', '1');
    assert.match((await cli(root, 'done', ...PASS)).out, /no PR draft: you are on main/);
    const r = await cli(root, 'done', '--no-pr', ...PASS);
    assert.doesNotMatch(r.out, /PR draft/);
    assert.equal(existsSync(join(root, '.claude/pr.md')), false);
  });

  it('tells boards that still commit state/ how to stop tracking it', async () => {
    const { root, run } = repo();
    addTask(root, 'First');
    run('add', '.');
    run('commit', '-qm', 'board');
    assert.match((await cli(root, 'list')).out, /docs\/tasks\/state\/ is committed[\s\S]*git rm -r --cached docs\/tasks\/state/);
    run('rm', '-r', '-q', '--cached', 'docs/tasks/state');
    write(root, '.gitignore', 'docs/tasks/state/\n');
    run('add', '.');
    run('commit', '-qm', 'untrack');
    assert.doesNotMatch((await cli(root, 'list')).out, /is committed/);
  });

  it('warns when a merge leaves two current tasks', async () => {
    const { root } = repo();
    for (const t of [addTask(root, 'First'), addTask(root, 'Second')]) {
      write(root, t.path, read(root, t.path).replace(/^Status: next$/m, 'Status: current'));
    }
    assert.match((await cli(root, 'list')).out, /warning: 2 tasks have Status: current \(0001, 0002\)/);
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
    const pkg = read(root, 'docs/logs/reviews/0001.md');
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

function fillEvaluatedTask(root, task, category = 'caching') {
  fillTask(root, task);
  write(root, task.path, read(root, task.path).replace(/^Category: .*$/m, `Category: ${category}`));
  writePlanEvaluation(root, PLAN, [category]);
  approveQuiz(root, QUIZ);
}

// Records a passing value with complete details for every KPI the agent measures.
function recordAllAgentKpis(root, id) {
  const registry = loadRegistry({ root });
  const { kpis } = parseEvaluation(read(root, PLAN));
  for (const k of kpis.filter((x) => x.evidence === 'measured' && x.verifier !== 'human')) {
    const fields = registry.dimensions.find((d) => d.id === k.dimension).details ?? [];
    const file = `results/${k.id}.json`;
    write(root, file, JSON.stringify(Object.fromEntries(fields.map((f) => [f, 1]))));
    recordKpi(root, id, k.id, String(k.value), { evidence: `measured ${k.id}`, details: file, registry });
  }
}

describe('subagent dispatch', () => {
  const agent = (root, name) => write(root, `.claude/agents/${name}.md`, `---\nname: ${name}\ndescription: Use to test.\ntools: Read\nmodel: inherit\n---\n\nPrompt.\n`);

  it('names only the installed agents for each step', () => {
    const { root } = repo();
    agent(root, 'developer');
    agent(root, 'critic');
    write(root, '.claude/agents/notes.txt', 'not an agent');
    assert.deepEqual(installedAgents(root), ['critic', 'developer']);
    const build = dispatchText(installedAgents(root), 'build');
    assert.match(build, /`developer`/);
    assert.doesNotMatch(build, /`tester`|`critic`/);
    assert.equal(dispatchText([], 'build'), '');
    assert.deepEqual(installedAgents(repo().root), []);
  });

  it('puts the build and review agents in the task session prompt', async () => {
    const { root } = repo();
    for (const name of ['developer', 'tester', 'critic', 'functional']) agent(root, name);
    const task = addTask(root, 'First');
    fillTask(root, task);
    const fake = fakeClaude();
    await main(['start', '1'], { root, log: () => {}, session: true, run: fake.run });
    const prompt = fake.calls[0].args[0];
    assert.match(prompt, /subagent_type: "developer"/);
    assert.match(prompt, /`tester`/);
    assert.match(prompt, /`critic`[^\n]*docs\/logs\/reviews\/0001\.md/);
    assert.doesNotMatch(prompt, /`hacker`|`summarizer`/);
    assert.doesNotMatch(taskPrompt(findTask(root, '1')), /subagent_type/, 'no agents passed, no dispatch');
  });

  it('hands the review package to the review agents', async () => {
    const { root, run } = repo();
    for (const name of ['critic', 'hacker']) agent(root, name);
    const task = addTask(root, 'Add login rate limit');
    fillTask(root, task);
    await cli(root, 'start', '1');
    write(root, 'src/rate.js', 'export const limit = 5;\n');
    run('add', '.');
    run('commit', '-qm', 'rate limit');
    const r = await cli(root, 'review', '1');
    assert.match(r.out, /`critic`: [^\n]*docs\/logs\/reviews\/0001\.md/);
    assert.match(r.out, /`hacker`: /);
    assert.doesNotMatch(r.out, /`functional`/);
  });

  it('hands the PR summary to the summarizer when a task is done', async () => {
    const { root } = repo();
    agent(root, 'summarizer');
    const task = addTask(root, 'First');
    fillTask(root, task);
    await cli(root, 'start', '1');
    const r = await cli(root, 'done', '1', '--no-advance', '--', 'node', '-e', '0');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /`summarizer`: [^\n]*docs\/logs\/reviews\/0001\.md[^\n]*\.claude\/pr\.md/);
    const quiet = await cli(root, 'done', '1', '--no-advance', '--no-pr', '--', 'node', '-e', '0');
    assert.doesNotMatch(quiet.out, /`summarizer`/, 'no PR draft, no summary to write');
  });

  it('adds no dispatch to the review output without installed agents', async () => {
    const { root } = repo();
    const task = addTask(root, 'First');
    fillTask(root, task);
    await cli(root, 'start', '1');
    const r = await cli(root, 'review', '1');
    assert.doesNotMatch(r.out, /subagent/i);
  });
});

describe('task evaluation', () => {
  it('writes Category: none in new notes and sets it with --category', async () => {
    const { root } = repo();
    assert.equal(addTask(root, 'Plain').category, 'none');
    await cli(root, 'add', 'Cache lookups', '--category', 'caching');
    assert.match(read(root, findTask(root, '2').path), /^Scope:.*\nCategory: caching$/m);
  });

  it('leaves tasks with no category line unchanged', async () => {
    const { root } = repo();
    const task = addTask(root, 'Old style');
    fillTask(root, task);
    write(root, task.path, read(root, task.path).replace(/^Category: .*\n/m, ''));
    assert.equal((await cli(root, 'start', '1')).code, 0);
    const done = await cli(root, 'done', '1', '--', 'node', '-e', '0');
    assert.equal(done.code, 0, done.out);
    assert.doesNotMatch(done.out, /evaluation/);
    assert.equal(findTask(root, '1').status, 'done');
  });

  it('refuses to start a categorised task whose plan has no Evaluation section', async () => {
    const { root } = repo();
    const task = addTask(root, 'Cache lookups');
    fillTask(root, task);
    write(root, task.path, read(root, task.path).replace(/^Category: .*$/m, 'Category: caching'));
    await assert.rejects(cli(root, 'start', '1'), /0001 is not ready to start: no ## Evaluation section/);
    const after = findTask(root, '1');
    assert.equal(after.status, 'next');
    assert.equal(after.branch, '');
    assert.equal(after.base, '');
  });

  it('refuses an unknown category and lists the available ones', async () => {
    const { root } = repo();
    const task = addTask(root, 'Mystery');
    fillTask(root, task);
    write(root, task.path, read(root, task.path).replace(/^Category: .*$/m, 'Category: nope'));
    await assert.rejects(cli(root, 'start', '1'), /unknown category 'nope'; available: .*caching/);
    assert.equal(findTask(root, '1').status, 'next');
  });

  it('refuses to start when the plan names a different category than the note', async () => {
    const { root } = repo();
    const task = addTask(root, 'Cache lookups');
    fillEvaluatedTask(root, task);
    write(root, task.path, read(root, task.path).replace(/^Category: .*$/m, 'Category: api'));
    await assert.rejects(cli(root, 'start', '1'), /Category: caching in the plan, but the task says api/);
  });

  it('starts a categorised task whose plan passes check', async () => {
    const { root } = repo();
    fillEvaluatedTask(root, addTask(root, 'Cache lookups'));
    const r = await cli(root, 'start', '1');
    assert.equal(r.code, 0, r.out);
    assert.equal(currentTaskOf(root).id, '0001');
  });

  it('refuses done while the scorecard is PENDING and lists what waits', async () => {
    const { root } = repo();
    fillEvaluatedTask(root, addTask(root, 'Cache lookups'));
    await cli(root, 'start', '1');
    const r = await cli(root, 'done', '1', '--', 'node', '-e', '0');
    assert.equal(r.code, 1);
    assert.match(r.out, /evaluation PENDING: 0001 NOT done — docs\/tasks\/evaluations\/0001\.md/);
    assert.match(r.out, /^- caching\.hit-ratio: waiting/m);
    assert.equal(currentTaskOf(root).id, '0001');
    assert.ok(existsSync(join(root, 'docs/tasks/evaluations/0001.md')));
  });

  it('finishes with human checks waiting, and lists them', async () => {
    const { root } = repo();
    fillEvaluatedTask(root, addTask(root, 'Cache lookups'));
    await cli(root, 'start', '1');
    recordAllAgentKpis(root, '1');
    const r = await cli(root, 'done', '1', '--no-pr', '--', 'node', '-e', '0');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /evaluation PASS: docs\/tasks\/evaluations\/0001\.md/);
    assert.match(r.out, /human review \(advisory\): caching\.lookup-scaling waiting, caching\.scenarios-failing waiting$/m);
    assert.equal(findTask(root, '1').status, 'done');
  });

  it('reports a non-PASS evaluation as a review finding', async () => {
    const { root } = repo();
    fillEvaluatedTask(root, addTask(root, 'Cache lookups'));
    await cli(root, 'start', '1');
    const r = await cli(root, 'review', '1');
    assert.equal(r.code, 1);
    assert.match(r.out, /^- evaluation PENDING: 0 KPIs failing, 13 waiting \(docs\/tasks\/evaluations\/0001\.md\)$/m);
    assert.match(read(root, 'docs/logs/reviews/0001.md'), /^## Evaluation$/m);
  });

  it('makes the approval stale when a threshold in the plan changes', async () => {
    const { root } = repo();
    fillEvaluatedTask(root, addTask(root, 'Cache lookups'));
    write(root, PLAN, read(root, PLAN).replace('## Evaluation\n', '## Evaluation\n\nOverride: caching.hit-ratio >= 0.95 ratio — checkout traffic is read-heavy\n'));
    writePlanEvaluation(root, PLAN, ['caching']);
    await assert.rejects(cli(root, 'start', '1'), /changed after .* was approved/);
  });
});
