import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { approveQuiz, parseQuiz, quizProblems, quizStatus, run } from './spec-quiz.mjs';

const SPEC = 'docs/design/2026-11-25-limits-design.md';
const PLAN = 'docs/design/plans/2026-11-25-limits.md';
const QUIZ = 'docs/design/approvals/2026-11-25-limits.md';

function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stones-quiz-')));
  write(root, SPEC, '# Login limits\n\nThe 6th attempt gets a 429.\n\n## Assumptions\n\n- A1: Limits are per account and IP. Status: confirmed\n');
  write(root, PLAN, '# Plan\n\n1. Add the limiter.\n');
  return root;
}

function write(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

const question = (n, answer, resolution = '') => `## What happens in case ${n}?

- A. The account is locked
- B. The request gets a 429
- C. Nothing

Expected: B
Answer: ${answer}
${resolution ? `Resolution: ${resolution}\n` : ''}`;
const quiz = (...answers) => `# Spec check: Login limits\n\nSpec: ${SPEC}\nPlan: ${PLAN}\nApproved: TODO\n\n${answers.map((a, i) => question(i + 1, ...[].concat(a))).join('\n')}`;

const cli = (root, ...argv) => {
  const out = [];
  const code = run(argv, { root, log: (l) => out.push(l), error: (l) => out.push(l) });
  return { code, out: out.join('\n') };
};

describe('spec quiz', () => {
  it('parses questions, options, expected answers and resolutions', () => {
    const q = parseQuiz(quiz('B', ['A', 'spec updated: no lockout']));
    assert.equal(q.spec, SPEC);
    assert.equal(q.plan, PLAN);
    assert.equal(q.questions.length, 2);
    assert.deepEqual(q.questions[0].options.map((o) => o.key), ['A', 'B', 'C']);
    assert.equal(q.questions[1].answerKey, 'A');
    assert.equal(q.questions[1].resolution, 'spec updated: no lockout');
  });

  it('names every problem that blocks approval', () => {
    const problems = quizProblems(parseQuiz(quiz('B', 'A', 'TODO')));
    assert.ok(problems.some((p) => /Q2: the answer differs/.test(p)));
    assert.ok(problems.some((p) => /Q3: record the user's Answer/.test(p)));
    assert.ok(quizProblems(parseQuiz(quiz('B'))).some((p) => /at least 3 questions/.test(p)));
    assert.ok(quizProblems(parseQuiz(quiz('B', 'B', 'D'))).some((p) => /Q3: Answer D is not an option/.test(p)));
    assert.ok(quizProblems(parseQuiz(quiz('B', 'B', 'Other: only log it'))).some((p) => /Q3: the answer differs/.test(p)), 'free text needs a resolution');
    assert.deepEqual(quizProblems(parseQuiz(quiz('B', 'B', ['A', 'clarified: lockout is not part of it']))), []);
  });

  it('refuses approval until every answer is recorded and every mismatch resolved', () => {
    const root = project();
    write(root, QUIZ, quiz('B', 'A', 'B'));
    assert.equal(cli(root, 'approve', QUIZ).code, 1);
    assert.match(cli(root, 'status', QUIZ).out, /NOT APPROVED/);
    write(root, QUIZ, quiz('B', ['A', 'spec updated: accounts are never locked'], 'B'));
    const r = cli(root, 'approve', QUIZ);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^Approved: \d{4}-\d{2}-\d{2} · 2\/3 matched the spec, 1 resolved · sha256:[0-9a-f]{16}$/);
    assert.match(readFileSync(join(root, QUIZ), 'utf8'), /^Approved: .*sha256:/m);
    assert.equal(cli(root, 'status', QUIZ).code, 0);
  });

  it('refuses approval while a spec assumption is open, and reports them', () => {
    const root = project();
    write(root, SPEC, '# Login limits\n\n## Assumptions\n\n- A1: Per IP. Status: confirmed\n- A2: Lock accounts. Status: open\n');
    write(root, QUIZ, quiz('B', 'B', 'B'));
    const r = cli(root, 'approve', QUIZ);
    assert.equal(r.code, 1);
    assert.match(r.out, /A2 is still open/);
    const check = cli(root, 'assumptions', SPEC);
    assert.equal(check.code, 1);
    assert.match(check.out, /^A1 CONFIRMED +Per IP\.$/m);
    assert.match(check.out, /NOT READY TO PLAN/);
    write(root, SPEC, '# Login limits\n\n## Assumptions\n\n- A1: Per IP. Status: confirmed\n- A2: Lock accounts. Status: denied: never lock; return 429\n');
    assert.match(cli(root, 'assumptions', SPEC).out, /A2 DENIED +Lock accounts\. → never lock; return 429\nREADY TO PLAN: 2 assumptions/);
    assert.equal(cli(root, 'approve', QUIZ).code, 0);
  });

  it('goes stale when the spec or plan changes after approval', () => {
    for (const doc of [SPEC, PLAN]) {
      const root = project();
      write(root, QUIZ, quiz('B', 'B', 'B'));
      approveQuiz(root, QUIZ);
      assert.ok(quizStatus(root, QUIZ).approved);
      write(root, doc, `${readFileSync(join(root, doc), 'utf8')}\nOne more decision.\n`);
      const s = quizStatus(root, QUIZ);
      assert.equal(s.approved, false);
      assert.equal(s.stale, true, doc);
      assert.match(cli(root, 'status', QUIZ).out, /^STALE/);
      approveQuiz(root, QUIZ);
      assert.ok(quizStatus(root, QUIZ).approved, 'approving again records the new text');
    }
  });

  it('writes a quiz skeleton that cannot be approved as is', () => {
    const root = project();
    const r = cli(root, 'new', SPEC, '--plan', PLAN);
    assert.equal(r.code, 0, r.out);
    const text = readFileSync(join(root, QUIZ), 'utf8');
    assert.match(text, /^# Spec check: Login limits$/m);
    assert.match(text, new RegExp(`^Plan: ${PLAN}$`, 'm'));
    assert.equal(parseQuiz(text).questions.length, 3);
    assert.equal(cli(root, 'approve', QUIZ).code, 1);
    assert.equal(cli(root, 'new', SPEC).code, 1, 'never overwrites a quiz');
    assert.equal(cli(root, 'new', '../outside.md').code, 1);
  });
});
