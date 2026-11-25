#!/usr/bin/env node
// Spec quiz: before implementation starts, the user answers a short multiple-
// choice quiz (QCM) about the spec and plan, so a misunderstanding surfaces
// while it is still a sentence to change instead of code to rewrite.
//
//   node .claude/tools/spec-quiz.mjs new <spec.md> [--plan <plan.md>]   write the quiz file to fill in
//   node .claude/tools/spec-quiz.mjs approve <quiz.md>                 check the answers, record approval
//   node .claude/tools/spec-quiz.mjs status <quiz.md> [--json]         approved and still matching the docs?
//
// Claude writes the questions (see the confirming-specs skill), asks them,
// and records each answer. `approve` only succeeds when every question is
// answered and every answer that differs from the spec has a Resolution. The
// approval stores a hash of the spec and plan, so editing either one makes it
// stale until the changed points are quizzed and approved again.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const QUIZ_DIR = 'docs/superpowers/approvals';
export const MIN_QUESTIONS = 3;
const PLACEHOLDER = /\b(?:TODO|TBD)\b/;

class QuizError extends Error {}
const fail = (message) => {
  throw new QuizError(message);
};

const field = (text, name) => new RegExp(`^${name}:[ \\t]*(.*)$`, 'mi').exec(text)?.[1].trim() ?? '';
const normalize = (text) => text.replace(/\r\n/g, '\n');

function inside(root, path) {
  if (!path || isAbsolute(path)) return false;
  const rel = relative(realpathSync(root), resolve(realpathSync(root), path));
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

function readDoc(root, path, label) {
  if (!inside(root, path)) fail(`${label} path must be relative and inside the project: ${path || '(missing)'}`);
  const file = join(root, path);
  if (!existsSync(file)) fail(`${label} ${path} does not exist`);
  return normalize(readFileSync(file, 'utf8'));
}

// The hash covers the spec and plan as approved; any edit to either makes it stale.
export function docsHash(root, spec, plan) {
  const h = createHash('sha256').update(`spec:${spec}\n`).update(readDoc(root, spec, 'Spec'));
  if (plan) h.update(`\0plan:${plan}\n`).update(readDoc(root, plan, 'Plan'));
  return h.digest('hex').slice(0, 16);
}

export function parseQuiz(text) {
  const body = normalize(text);
  const blocks = body.split(/^## /m).slice(1);
  const questions = blocks.map((block) => {
    const [heading, ...rest] = block.split('\n');
    const content = rest.join('\n');
    const options = [...content.matchAll(/^\s*[-*]\s+([A-Z])[.)]\s+(.+)$/gm)].map((m) => ({ key: m[1], text: m[2].trim() }));
    const answer = field(content, 'Answer');
    return {
      heading: heading.trim(),
      options,
      expected: field(content, 'Expected').toUpperCase(),
      answer,
      answerKey: /^[A-Z]$/i.test(answer) ? answer.toUpperCase() : null,
      resolution: field(content, 'Resolution'),
    };
  });
  return { spec: field(body, 'Spec'), plan: field(body, 'Plan'), approved: field(body, 'Approved'), questions };
}

// Every problem that blocks approval, in question order.
export function quizProblems(quiz) {
  const problems = [];
  if (quiz.questions.length < MIN_QUESTIONS) problems.push(`write at least ${MIN_QUESTIONS} questions (found ${quiz.questions.length})`);
  quiz.questions.forEach((q, i) => {
    const name = `Q${i + 1}`;
    if (!q.heading || PLACEHOLDER.test(q.heading)) problems.push(`${name}: write the question`);
    if (q.options.length < 2 || q.options.length > 4) problems.push(`${name}: give 2 to 4 options (A. … D.)`);
    if (q.options.some((o) => PLACEHOLDER.test(o.text))) problems.push(`${name}: replace the TODO options`);
    if (!q.options.some((o) => o.key === q.expected)) problems.push(`${name}: Expected must be one of the option letters`);
    if (!q.answer || PLACEHOLDER.test(q.answer)) problems.push(`${name}: record the user's Answer`);
    else if (q.answerKey && !q.options.some((o) => o.key === q.answerKey)) problems.push(`${name}: Answer ${q.answerKey} is not an option`);
    else if (q.answerKey !== q.expected && (!q.resolution || PLACEHOLDER.test(q.resolution))) {
      problems.push(`${name}: the answer differs from the spec; add a Resolution (spec updated: … / clarified: …)`);
    }
  });
  return problems;
}

// The spec's `## Assumptions`: every decision the agent made that the user did
// not state, each confirmed or denied by the user before a plan is written.
//   - A1: Limits apply per account and IP. Status: confirmed
//   - A2: Accounts lock after 5 failures. Status: denied: never lock; return 429 instead
//   - A3: Existing sessions stay valid. Status: open
export function parseAssumptions(text) {
  const lines = normalize(text).split('\n');
  const start = lines.findIndex((l) => /^##\s+Assumptions\s*$/i.test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  return lines.slice(start + 1, end < 0 ? lines.length : end).flatMap((line) => {
    const m = /^\s*[-*]\s+(A\d+)[:.]\s*(.+)$/.exec(line);
    if (!m) return [];
    const status = /\bStatus:\s*(confirmed|denied|open)\b[:.\s—-]*(.*)$/i.exec(m[2]);
    return [{
      id: m[1],
      text: m[2].replace(/\s*\bStatus:.*$/i, '').trim(),
      status: status ? status[1].toLowerCase() : 'open',
      note: status ? status[2].trim() : '',
    }];
  });
}

export function assumptionProblems(text) {
  const items = parseAssumptions(text);
  const how = 'list every decision you made that the user did not state as "- A1: <assumption>. Status: open", then ask the user to confirm or deny each one';
  if (items === null) return [`add a ## Assumptions section: ${how}`];
  if (!items.length) return [`## Assumptions is empty: ${how}`];
  const problems = [];
  const seen = new Set();
  for (const a of items) {
    if (seen.has(a.id)) problems.push(`${a.id} is listed twice; number assumptions uniquely`);
    seen.add(a.id);
    if (a.status === 'open') problems.push(`${a.id} is still open: ask the user to confirm or deny "${a.text}"`);
    if (a.status === 'denied' && (a.note.length < 3 || PLACEHOLDER.test(a.note))) {
      problems.push(`${a.id} was denied: record what the user decided instead (Status: denied: <decision>) and update the spec`);
    }
  }
  return problems;
}

const mismatches = (quiz) => quiz.questions.filter((q) => q.answerKey !== q.expected);

export function quizStatus(root, quizPath) {
  const quiz = parseQuiz(readFileSync(join(root, quizPath), 'utf8'));
  const hash = /sha256:([0-9a-f]{16})/.exec(quiz.approved)?.[1];
  const result = { quiz: quizPath, spec: quiz.spec, plan: quiz.plan || null, questions: quiz.questions.length, approved: false, stale: false, reason: '' };
  if (!hash) return { ...result, reason: `${quizPath} is not approved yet; ask the questions, then run approve` };
  const current = docsHash(root, quiz.spec, quiz.plan || null);
  if (current !== hash) return { ...result, stale: true, reason: `the spec or plan changed after ${quizPath} was approved; quiz the changed points and approve again` };
  return { ...result, approved: true, reason: quiz.approved };
}

export function newQuiz(root, spec, plan, out) {
  readDoc(root, spec, 'Spec');
  if (plan) readDoc(root, plan, 'Plan');
  const path = out ?? `${QUIZ_DIR}/${basename(spec).replace(/(-design)?\.md$/, '')}.md`;
  if (!inside(root, path)) fail(`quiz path must be inside the project: ${path}`);
  if (existsSync(join(root, path))) fail(`${path} already exists; edit it, or pass --out for a new one`);
  const title = /^#\s+(.+)$/m.exec(readDoc(root, spec, 'Spec'))?.[1].trim() ?? basename(spec, '.md');
  const question = (n) => `## TODO: question ${n} about a decision in the spec

- A. TODO
- B. TODO
- C. TODO

Expected: TODO
Answer: TODO
`;
  const text = `# Spec check: ${title}

Spec: ${spec}
${plan ? `Plan: ${plan}\n` : ''}Approved: TODO: run \`node .claude/tools/spec-quiz.mjs approve ${path}\` after the user answers

${[1, 2, 3].map(question).join('\n')}`;
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
  return path;
}

export function approveQuiz(root, quizPath, today = new Date().toISOString().slice(0, 10)) {
  const file = join(root, quizPath);
  if (!existsSync(file)) fail(`${quizPath} does not exist`);
  const text = readFileSync(file, 'utf8');
  const quiz = parseQuiz(text);
  if (!quiz.spec) fail(`${quizPath}: add a Spec: line`);
  const open = assumptionProblems(readDoc(root, quiz.spec, 'Spec'));
  if (open.length) fail(`${quiz.spec} has assumptions the user has not confirmed or denied:\n  - ${open.join('\n  - ')}`);
  const problems = quizProblems(quiz);
  if (problems.length) fail(`${quizPath} is not ready to approve:\n  - ${problems.join('\n  - ')}`);
  const hash = docsHash(root, quiz.spec, quiz.plan || null);
  const missed = mismatches(quiz).length;
  const line = `Approved: ${today} · ${quiz.questions.length - missed}/${quiz.questions.length} matched the spec` +
    `${missed ? `, ${missed} resolved` : ''} · sha256:${hash}`;
  writeFileSync(file, /^Approved:.*$/m.test(text) ? text.replace(/^Approved:.*$/m, line) : text.replace(/^(Spec:.*)$/m, `$1\n${line}`));
  return { line, missed, questions: quiz.questions.length };
}

const USAGE = `spec-quiz: confirm the user understands and approves a spec before implementation

Usage
  node .claude/tools/spec-quiz.mjs new <spec.md> [--plan <plan.md>] [--out <quiz.md>]
  node .claude/tools/spec-quiz.mjs approve <quiz.md>
  node .claude/tools/spec-quiz.mjs status <quiz.md> [--json]
  node .claude/tools/spec-quiz.mjs assumptions <spec.md>          every assumption confirmed or denied?

Quiz files live in ${QUIZ_DIR}/ by default. Link one from a task note as
"Approval: <path>" and \`tasks.mjs start\` requires it to be approved and current.`;

function spliceFlag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
}

function statusLabel(s) {
  if (s.approved) return 'APPROVED';
  if (s.stale) return 'STALE';
  return 'NOT APPROVED';
}

function dispatch(command, target, { root, log, json, plan, out }) {
  if (!command || command === '-h' || command === '--help') {
    log(USAGE);
    return command ? 0 : 1;
  }
  if (!target) fail(`${command} needs a file; see --help`);
  if (command === 'new') {
    const path = newQuiz(root, target, plan, out);
    log(`wrote ${path}; replace the TODO questions, ask them, record each Answer, then approve`);
    return 0;
  }
  if (command === 'approve') {
    const r = approveQuiz(root, target);
    log(r.line);
    return 0;
  }
  if (command === 'assumptions') {
    const problems = assumptionProblems(readDoc(root, target, 'Spec'));
    const items = parseAssumptions(readDoc(root, target, 'Spec')) ?? [];
    for (const a of items) log(`${a.id} ${a.status.toUpperCase().padEnd(9)} ${a.text}${a.note ? ` → ${a.note}` : ''}`);
    log(problems.length ? `NOT READY TO PLAN:\n  - ${problems.join('\n  - ')}` : `READY TO PLAN: ${items.length} assumptions confirmed or denied`);
    return problems.length ? 1 : 0;
  }
  if (command === 'status') {
    const s = quizStatus(root, target);
    log(json ? JSON.stringify(s, null, 2) : `${statusLabel(s)}: ${s.reason}`);
    return s.approved ? 0 : 1;
  }
  fail(`unknown command ${command}; see --help`);
}

export function run(argv, { root = process.cwd(), log = console.log, error = console.error } = {}) {
  const args = [...argv];
  const json = args.includes('--json') ? Boolean(args.splice(args.indexOf('--json'), 1)) : false;
  const plan = spliceFlag(args, '--plan');
  const out = spliceFlag(args, '--out');
  const [command, target] = args;
  try {
    return dispatch(command, target, { root, log, json, plan, out });
  } catch (e) {
    if (!(e instanceof QuizError)) throw e;
    error(`spec-quiz: ${e.message}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { projectRoot } = await import('./git-comments.mjs');
  process.exitCode = run(process.argv.slice(2), { root: projectRoot() });
}
