#!/usr/bin/env node
// Task board for Claude Code projects.
//
//   context/tasks/list/NNNN-slug.md   one file per task: goal, scenarios, scope,
//                                     and its state (Status, Blocked, Result)
//   context/tasks/state/current.md    the board, written from the notes:
//   context/tasks/state/next.md         the task in progress, the queue (in
//   context/tasks/state/blocked.md      order; reorder it by moving lines),
//   context/tasks/state/done.md         blocked tasks, finished tasks
//
// The notes are the source of truth and are committed: every command changes
// the note of the task it acts on, then rewrites the state files from the
// notes, so they never disagree. The state files are a local view, kept out
// of git (.gitignore), so branches that work on different tasks never
// conflict over them; after a checkout or merge any command, or `sync`,
// rebuilds them from the notes. Only `done`
// sets Status: done, and only when the tests pass; it then starts the next
// ready task in the queue.
// `review` builds one file a reviewer reads to judge the task against what
// it promised.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { EvaluationError, loadRegistry } from './evaluation-registry.mjs';
import { checkPlan, scoreTarget } from './evaluation.mjs';
import { reviewTask } from './review.mjs';
import { quizStatus } from './spec-quiz.mjs';

export const TASKS_DIR = 'context/tasks';
export const LIST_DIR = `${TASKS_DIR}/list`;
export const STATE_DIR = `${TASKS_DIR}/state`;
export const REVIEWS_DIR = '.claude/reviews';
export const STATES = ['current', 'next', 'blocked', 'done'];
// The state files are rebuilt from the notes, so each checkout keeps its own copy out of git.
export const STATE_GITIGNORE = `${STATE_DIR}/`;

const GENERATED = 'Written by `node .claude/tools/tasks.mjs` from the Status lines in ../list/ (git-ignored; the notes are what is committed); do not edit by hand.';
export const STATE_HEADERS = {
  current: `# Current\n\nThe task in progress. ${GENERATED}\n`,
  next: `# Next\n\nQueued tasks, in the order \`done\` starts them. ${GENERATED.replace('do not edit by hand', 'reorder by moving lines, nothing else')}\n`,
  blocked: `# Blocked\n\nTasks waiting on something, with the reason. ${GENERATED}\n`,
  done: `# Done\n\nFinished tasks: their tests passed when they were closed. ${GENERATED}\n`,
};

export const TASK_TEMPLATE = `# {{id}} {{title}}

Status: next
Branch:
Base:
Scope: {{scope}}
Category: {{category}}

## Expected behavior

TODO: Describe the behavior the source should provide.

## Scenarios

- Scenario: TODO: describe an input or condition. Expected: TODO: describe the observable result.

## Contract change

none

## Test Strategy

TODO: Describe the test levels and checks that give confidence for this task.

## Test Cases

- Case: TODO: describe an input or condition. Expected: TODO: describe the observable result.

## Spec and plan

Spec: TODO: the spec written with superpowers:brainstorming (docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md)
Plan: TODO: the plan written with superpowers:writing-plans (docs/superpowers/plans/YYYY-MM-DD-<feature>.md)
Approval: TODO: the spec quiz the user answered (docs/superpowers/approvals/<topic>.md; see the confirming-specs skill)

## Notes
`;

// Blocked: the reason a blocked task waits; Result: the commits and test run a done task closed with.
const META = ['Status', 'Branch', 'Base', 'Scope', 'Category', 'Blocked', 'Result'];

const readText = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

export function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trimEnd(), err: (r.stderr ?? '').trim() };
}

export function projectRoot(cwd = process.cwd()) {
  if (process.env.CLAUDE_PROJECT_DIR) return resolve(process.env.CLAUDE_PROJECT_DIR);
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  return top.ok ? top.out : resolve(cwd);
}

class TaskError extends Error {}
const fail = (message) => {
  throw new TaskError(message);
};

// ------------------------------------------------------------------ files

export function ensureBoard(root) {
  mkdirSync(join(root, LIST_DIR), { recursive: true });
  migrateBoard(root);
  return syncBoard(root);
}

// `- [0001 Title](../list/0001-slug.md) · extra` lines of one state file.
function stateFileEntries(root, state) {
  return (readText(join(root, STATE_DIR, `${state}.md`)) ?? '').split('\n').flatMap((line) => {
    const file = /^- \[\d+ .*?\]\(\.\.\/list\/([^)]+)\)/.exec(line)?.[1];
    return file ? [{ file, extra: line.split(' · ').slice(1).join(' · ').trim() }] : [];
  });
}

// Boards from versions that kept the blocked reason and test result only in
// the state files: copy them into the notes that lack them. The notes' Status
// lines were always kept, so they stay as they are.
export function migrateBoard(root) {
  const moved = [];
  for (const [state, key] of [['blocked', 'Blocked'], ['done', 'Result']]) {
    for (const { file, extra } of stateFileEntries(root, state)) {
      if (!extra || !existsSync(join(root, LIST_DIR, file))) continue;
      const task = readTask(root, file);
      if (task.status !== state || task[key.toLowerCase()]) continue;
      writeMeta(root, task, { [key]: extra });
      moved.push(file);
    }
  }
  return moved;
}

const entryLine = (task) => `- [${task.id} ${task.title}](../list/${task.file})${task.extra ? ` · ${task.extra}` : ''}`;

// Boards installed before the state files were git-ignored still have them committed.
export function trackedStateHint(root) {
  const tracked = git(root, ['ls-files', '--', STATE_DIR]);
  if (!tracked.ok || !tracked.out) return '';
  return `note: ${STATE_DIR}/ is committed; it is rebuilt from the notes and causes merge conflicts.`
    + ` Stop tracking it: add \`${STATE_GITIGNORE}\` to .gitignore, then \`git rm -r --cached ${STATE_DIR}\` and commit.`;
}

// Rewrites the state files from the notes; a file is written only when it changes.
export function syncBoard(root) {
  mkdirSync(join(root, STATE_DIR), { recursive: true });
  const written = [];
  for (const state of STATES) {
    const path = join(root, STATE_DIR, `${state}.md`);
    const tasks = tasksIn(root, state);
    const text = `${STATE_HEADERS[state]}\n${tasks.map(entryLine).join('\n')}${tasks.length ? '\n' : ''}`;
    if (readText(path) !== text) {
      writeFileSync(path, text);
      written.push(`${STATE_DIR}/${state}.md`);
    }
  }
  return written;
}

const slugify = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'task';

export function listTasks(root) {
  const dir = join(root, LIST_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d+-.*\.md$/.test(f))
    .sort()
    .map((file) => readTask(root, file));
}

export function readTask(root, file) {
  const path = `${LIST_DIR}/${file}`;
  const text = readFileSync(join(root, path), 'utf8');
  const id = /^(\d+)/.exec(file)[1];
  const title = /^#\s+\d+\s+(.*)$/m.exec(text)?.[1]?.trim() ?? file;
  const meta = {};
  for (const key of META) meta[key.toLowerCase()] = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(text)?.[1]?.trim() ?? '';
  return { id, file, path, title, text, ...meta };
}

export function findTask(root, ref) {
  const tasks = listTasks(root);
  const wanted = String(ref ?? '').replace(/^#/, '');
  const task = tasks.find((t) => t.id === wanted.padStart(t.id.length, '0') || t.file === wanted || t.file === `${wanted}.md`);
  return task ?? fail(`no task ${ref} in ${LIST_DIR}/`);
}

// Sets meta lines in the task's note, then rewrites the state files.
function setMeta(root, task, values) {
  const updated = writeMeta(root, task, values);
  syncBoard(root);
  return updated;
}

// Sets meta lines in the task's note; a null value removes the line. A new
// line goes after the existing meta lines, so the header stays together.
function writeMeta(root, task, values) {
  let text = readFileSync(join(root, task.path), 'utf8');
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`^${key}:.*(?:\\r?\\n|$)`, 'm');
    if (value === null) {
      text = text.replace(re, '');
      continue;
    }
    const line = `${key}: ${value}`.trimEnd();
    if (re.test(text)) {
      text = text.replace(new RegExp(`^${key}:.*$`, 'm'), line);
      continue;
    }
    const lines = text.split('\n');
    const lastMeta = lines.findLastIndex((l) => new RegExp(`^(?:${META.join('|')}):`).test(l));
    if (lastMeta >= 0) lines.splice(lastMeta + 1, 0, line);
    else lines.splice(1, 0, '', line);
    text = lines.join('\n');
  }
  writeFileSync(join(root, task.path), text);
  return readTask(root, task.file);
}

// A note without a known Status is queued.
const stateOfTask = (task) => (STATES.includes(task.status) ? task.status : 'next');

// What a task's board line shows after its title.
const extraOf = (task) => ({
  current: task.branch ? `branch ${task.branch}` : '',
  next: '',
  blocked: task.blocked,
  done: task.result,
})[stateOfTask(task)] ?? '';

// The tasks in one state, with the text their board line shows. Queued tasks
// keep the order of next.md (moving lines there reorders the queue); tasks
// not listed there yet follow, in id order. The other states are in id order.
export function tasksIn(root, state) {
  const tasks = listTasks(root).filter((t) => stateOfTask(t) === state).map((t) => ({ ...t, extra: extraOf(t) }));
  if (state !== 'next') return tasks;
  const order = new Map();
  for (const { file } of stateFileEntries(root, 'next')) if (!order.has(file)) order.set(file, order.size);
  const rank = (t) => order.get(t.file) ?? Number.MAX_SAFE_INTEGER;
  return tasks.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------- commands

export function addTask(root, title, { scope = '', category = 'none' } = {}) {
  if (!title.trim()) fail('usage: tasks add <title> [--scope "src/a/**,tests/a/**"]');
  ensureBoard(root);
  const last = listTasks(root).reduce((max, t) => Math.max(max, Number(t.id)), 0);
  const id = String(last + 1).padStart(4, '0');
  const file = `${id}-${slugify(title)}.md`;
  const text = TASK_TEMPLATE.replace('{{id}}', id).replace('{{title}}', title.trim()).replace('{{scope}}', scope).replace('{{category}}', category || 'none').replace(/^Scope: $/m, 'Scope:');
  writeFileSync(join(root, LIST_DIR, file), text);
  syncBoard(root);
  return readTask(root, file);
}

export function currentTaskOf(root) {
  return tasksIn(root, 'current')[0] ?? null;
}

function markdownSection(text, heading) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  return lines.slice(start + 1, end < 0 ? lines.length : end).join('\n').trim();
}

const PLACEHOLDER = /\b(?:TODO|TBD|replace me)\b|\[(?:describe|write|add|replace|reason|expected|condition)\b[^\]]*\]/i;

function hasExpectedCase(section) {
  return section.split(/\r?\n/).some((line) => {
    const match = /^\s*[-*]\s+(?:Case|Test case):\s*(.+?)\s+Expected:\s*(.+)$/i.exec(line);
    return match && match[1].trim().length >= 8 && match[2].trim().length >= 8 && !PLACEHOLDER.test(line);
  });
}

function validateTestSections(text, label, task) {
  const strategy = markdownSection(text, 'Test Strategy');
  if (!strategy || strategy.trim().length < 20 || PLACEHOLDER.test(strategy)) {
    fail(`${task.id} is not ready to start: add a meaningful ## Test Strategy section to the ${label}; describe which checks and test levels cover the task's risks.`);
  }
  const cases = markdownSection(text, 'Test Cases');
  if (!hasExpectedCase(cases)) {
    fail(`${task.id} is not ready to start: add at least one concrete Case with an Expected outcome under ## Test Cases in the ${label}.`);
  }
}

function linkedDocument(root, task, label, folder, skill) {
  const links = markdownSection(task.text, 'Spec and plan');
  const path = new RegExp(`^${label}:[ \\t]*(.*)$`, 'm').exec(links)?.[1].trim() ?? '';
  if (!path || PLACEHOLDER.test(path)) {
    fail(`${task.id} is not ready to start: create the ${label.toLowerCase()} with ${skill} and link it under ## Spec and plan in ${task.path}.`);
  }
  const rootPath = realpathSync(root);
  const target = resolve(rootPath, path);
  const relativePath = relative(rootPath, target);
  if (isAbsolute(path) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    fail(`${task.id} is not ready to start: the ${label.toLowerCase()} path must stay inside the project.`);
  }
  if (!path.startsWith(folder) || !path.endsWith('.md')) {
    fail(`${task.id} is not ready to start: link the ${label.toLowerCase()} under ${folder} as a Markdown file.`);
  }
  if (!existsSync(target)) {
    fail(`${task.id} is not ready to start: ${path} does not exist; create the ${label.toLowerCase()} with ${skill}.`);
  }
  const realTarget = realpathSync(target);
  const realRelative = relative(rootPath, realTarget);
  if (realRelative === '..' || realRelative.startsWith(`..${sep}`)) {
    fail(`${task.id} is not ready to start: the ${label.toLowerCase()} must resolve inside the project.`);
  }
  if (!statSync(realTarget).isFile()) {
    fail(`${task.id} is not ready to start: ${path} must link to a Markdown file.`);
  }
  const content = readFileSync(realTarget, 'utf8');
  validateTestSections(content, label === 'Spec' ? 'spec' : 'plan', task);
}

export function validateTaskReadiness(root, task) {
  const behavior = markdownSection(task.text, 'Expected behavior');
  if (!behavior || PLACEHOLDER.test(behavior)) {
    fail(`${task.id} is not ready to start: complete ## Expected behavior in ${task.path}.`);
  }
  const scenarios = markdownSection(task.text, 'Scenarios');
  if (!scenarios.split(/\r?\n/).some((line) =>
    /^\s*[-*]\s+.+?\bExpected:\s*\S.+$/i.test(line) && !PLACEHOLDER.test(line))) {
    fail(`${task.id} is not ready to start: add a Scenario with an Expected outcome in ${task.path}.`);
  }
  const contract = markdownSection(task.text, 'Contract change');
  const unchanged = /^(?:none|no|unchanged|no contract change)\.?$/i.test(contract);
  const changed = /^behavior changed:\s*\S.{7,}$/i.test(contract) && !PLACEHOLDER.test(contract);
  if (!unchanged && !changed) {
    fail(`${task.id} is not ready to start: set ## Contract change to "none" or "behavior changed: <reason>" in ${task.path}.`);
  }
  validateTestSections(task.text, 'task note', task);
  linkedDocument(root, task, 'Spec', 'docs/superpowers/specs/', 'superpowers:brainstorming');
  linkedDocument(root, task, 'Plan', 'docs/superpowers/plans/', 'superpowers:writing-plans');
  validateApproval(root, task);
  validateEvaluation(root, task);
}

// A task with a Category (evaluating-outputs skill) needs its plan to carry the
// generated ## Evaluation section for that category. No Category line, or
// Category: none, is not gated.
export const isCategorised = (task) => Boolean(task.category) && task.category !== 'none';
const planOf = (task) => /^Plan:[ \t]*(\S+)/m.exec(markdownSection(task.text, 'Spec and plan'))?.[1];

function validateEvaluation(root, task) {
  if (!isCategorised(task)) return;
  const notReady = (message) => fail(`${task.id} is not ready to start: ${message}`);
  let registry;
  try {
    registry = loadRegistry({ root });
  } catch (error) {
    if (error instanceof EvaluationError) notReady(error.message);
    throw error;
  }
  if (!registry.categories[task.category]) {
    notReady(`unknown category '${task.category}'; available: ${Object.keys(registry.categories).sort().join(', ')}`);
  }
  const { problems } = checkPlan(root, planOf(task), { category: task.category, registry });
  if (problems.length) notReady(problems[0]);
}

// Scores a categorised task's output (null for any other task). The verdict
// gates `done`; human sign-offs on the scorecard are advisory.
export function evaluateTask(root, task) {
  if (!isCategorised(task)) return null;
  try {
    return scoreTarget(root, task.id);
  } catch (error) {
    if (error instanceof EvaluationError) fail(`${task.id}: ${error.message}`);
    throw error;
  }
}

// Notes with an Approval: line (every note `add` writes) need the user to have
// answered the spec quiz for the linked spec and plan, and neither to have
// changed since. Older notes without the line are not gated.
function validateApproval(root, task) {
  const links = markdownSection(task.text, 'Spec and plan');
  const line = /^Approval:[ \t]*(.*)$/m.exec(links);
  if (!line) return;
  const path = line[1].trim();
  const how = 'ask the user the spec quiz (confirming-specs skill) and run `node .claude/tools/spec-quiz.mjs approve <quiz>`';
  if (!path || PLACEHOLDER.test(path)) fail(`${task.id} is not ready to start: ${how}, then link it as Approval: in ${task.path}.`);
  const rel = relative(realpathSync(root), resolve(realpathSync(root), path));
  if (isAbsolute(path) || rel === '..' || rel.startsWith(`..${sep}`) || !existsSync(join(root, path))) {
    fail(`${task.id} is not ready to start: ${path} does not exist inside the project; ${how}.`);
  }
  let status;
  try {
    status = quizStatus(root, path);
  } catch (e) {
    fail(`${task.id} is not ready to start: ${e.message}`);
  }
  const linked = (label) => new RegExp(`^${label}:[ \\t]*(.*)$`, 'm').exec(links)?.[1].trim();
  if (status.spec !== linked('Spec') || (status.plan ?? undefined) !== linked('Plan')) {
    fail(`${task.id} is not ready to start: ${path} approves a different spec or plan than ${task.path} links.`);
  }
  if (!status.approved) fail(`${task.id} is not ready to start: ${status.reason}.`);
}

export function startTask(root, ref) {
  const task = findTask(root, ref);
  const current = currentTaskOf(root);
  if (current && current.id !== task.id) {
    fail(`${current.id} is in progress: finish it (done) or block it before starting ${task.id}`);
  }
  if (task.status === 'done') fail(`${task.id} is already done`);
  validateTaskReadiness(root, task);
  const head = git(root, ['rev-parse', 'HEAD']);
  const branch = git(root, ['branch', '--show-current']).out;
  // Resuming a blocked task keeps its original base, so the review covers all of it.
  return setMeta(root, task, {
    Status: 'current',
    Branch: branch || task.branch,
    Base: task.base || (head.ok ? head.out : ''),
    Blocked: null,
  });
}

// Starts the first queued task that passes the readiness gate. Queued tasks
// that are not ready are skipped and returned with the reason.
export function advance(root) {
  const skipped = [];
  for (const task of tasksIn(root, 'next')) {
    try {
      validateTaskReadiness(root, task);
    } catch (error) {
      if (!(error instanceof TaskError)) throw error;
      skipped.push({ task, reason: error.message });
      continue;
    }
    return { started: startTask(root, task.id), skipped };
  }
  return { started: null, skipped };
}

// After readiness validation, Superpowers guides implementation and verification.
export const SUPERPOWERS_WORKFLOW = [
  'The board has already checked that the task note, spec, and plan are complete before this task was started. Read the linked spec and plan first; keep their behavior, scenarios, test strategy, and test cases aligned with the task note.',
  'Build: carry out the plan with superpowers:subagent-driven-development (or superpowers:executing-plans when working inline), test first with superpowers:test-driven-development.',
  'Finish: use superpowers:verification-before-completion before claiming it works.',
].join('\n');

// The opening prompt of a task's session: the task note plus how to work it.
export function taskPrompt(task, { blockedReason = '' } = {}) {
  const todo = /TODO:/.test(task.text);
  const where = [task.branch && `branch ${task.branch}`, task.base && `base ${task.base.slice(0, 7)}`].filter(Boolean).join(', ');
  return [
    `Work on task ${task.id} "${task.title}". It is now the current task on the board${where ? ` (${where})` : ''}.`,
    blockedReason ? `It was blocked before: ${blockedReason}. Check that this is resolved before continuing.` : '',
    `The task note, ${task.path}:`,
    '<task>',
    task.text.trim(),
    '</task>',
    todo
      ? 'The note still has TODOs: fill them in before writing code, asking me when the expected behavior is unclear. Task start and the testing hook both enforce the required task details.'
      : '',
    SUPERPOWERS_WORKFLOW,
    `Only change files inside its Scope. Commit the work, check it with \`node .claude/tools/tasks.mjs review ${task.id} --run-tests\`,`
      + ` then finish with \`node .claude/tools/tasks.mjs done ${task.id}\`; it marks the task done, writes the PR draft to .claude/pr.md with the commands that open it, and starts the next ready task on the board.`
      + ` If it cannot be finished, \`node .claude/tools/tasks.mjs block ${task.id} "<reason>"\`.`,
    'Start by summarizing the task, then follow the steps above in order.',
  ].filter(Boolean).join('\n\n');
}

// Inside Claude Code, or without a terminal, an interactive session cannot run.
export const canOpenSession = (env = process.env) => !env.CLAUDECODE && Boolean(process.stdin.isTTY && process.stdout.isTTY);

// Opens an interactive Claude Code session in `root` with the task's prompt.
export function startSession(root, task, { claude = process.env.STONES_CLAUDE || 'claude', blockedReason = '', run = spawn } = {}) {
  const prompt = taskPrompt(task, { blockedReason });
  return new Promise((done) => {
    const child = run(claude, [prompt], { cwd: root, stdio: 'inherit' });
    child.on('exit', (code) => done({ started: true, code: code ?? 1 }));
    child.on('error', (error) =>
      done({
        started: false,
        message: error.code === 'ENOENT'
          ? `${claude} is not on PATH; install Claude Code (https://claude.com/claude-code) or open it here and run \`tasks show\``
          : error.message,
      }));
  });
}

export function blockTask(root, ref, reason) {
  if (!reason.trim()) fail('usage: tasks block <id> <reason>');
  return setMeta(root, findTask(root, ref), { Status: 'blocked', Blocked: reason.trim().replace(/\s+/g, ' ') });
}

// The project's test command: what `init` recorded, else the package.json script.
export function defaultTestCommand(root) {
  const manifest = readText(join(root, '.claude/stones.json'));
  try {
    const cmd = JSON.parse(manifest).answers?.workflow?.commands?.test;
    if (cmd) return cmd;
  } catch {
    // no manifest
  }
  try {
    if (JSON.parse(readText(join(root, 'package.json'))).scripts?.test) return 'npm test';
  } catch {
    // no package.json
  }
  return null;
}

export function runTests(root, task, command) {
  const cmd = command || defaultTestCommand(root) || fail('no test command: pass one after --, e.g. tasks done 7 -- npm test');
  mkdirSync(join(root, REVIEWS_DIR), { recursive: true });
  const log = `${REVIEWS_DIR}/${task.id}-tests.log`;
  // A hung test run must not hang the tool: STONES_COMMAND_TIMEOUT seconds, 30 minutes by default.
  const timeout = (Number(process.env.STONES_COMMAND_TIMEOUT) || 1800) * 1000;
  const r = spawnSync(cmd, { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}${timedOut ? `\ntimed out after ${timeout / 1000}s (STONES_COMMAND_TIMEOUT)\n` : ''}`;
  writeFileSync(join(root, log), output);
  const last = output.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '(no output)';
  return { ok: r.status === 0, status: r.status, command: cmd, log, last, tail: output.split('\n').slice(-6).join('\n') };
}

const short = (root, sha) => (sha ? git(root, ['rev-parse', '--short=7', sha]).out : '');

export function finishTask(root, ref, command) {
  const task = findTask(root, ref);
  const tests = runTests(root, task, command);
  if (!tests.ok) return { task, tests, finished: false };
  const evaluation = evaluateTask(root, task);
  if (evaluation && evaluation.verdict !== 'PASS') return { task, tests, finished: false, evaluation };
  const head = git(root, ['rev-parse', 'HEAD']);
  const range = task.base && head.ok ? `commits ${short(root, task.base)}..${short(root, head.out)}` : 'no commits recorded';
  const result = `${range} · tests: ${tests.command} → ${tests.last}`.replace(/\s+/g, ' ');
  const updated = setMeta(root, task, { Status: 'done', Blocked: null, Result: result });
  return { task: updated, tests, finished: true, evaluation };
}

const DRAFT = /TODO:/;

// One state as text: each task's id, title, scope, what its board line says,
// and whether its note still has TODOs.
export function stateText(root, state) {
  const tasks = tasksIn(root, state);
  if (!tasks.length) return `${state}: none`;
  const rows = tasks.map((t, i) => {
    const order = state === 'next' ? `${i + 1}. ` : '';
    const details = [t.scope && `scope ${t.scope}`, t.extra, state !== 'done' && DRAFT.test(t.text) && 'note has TODOs'].filter(Boolean);
    return `  ${order}${t.id} ${t.title}${details.length ? `\n     ${details.join(' · ')}` : ''}`;
  });
  return [`${state} (${tasks.length})`, ...rows].join('\n');
}

export function boardText(root) {
  const out = [];
  for (const state of STATES) {
    const tasks = tasksIn(root, state);
    out.push(`${state} (${tasks.length})`);
    for (const t of state === 'done' ? tasks.slice(-5) : tasks) out.push(`  [${t.id} ${t.title}]${t.extra ? ` · ${t.extra}` : ''}`);
  }
  // Merging branches that each started a task can leave two current tasks.
  const current = tasksIn(root, 'current');
  if (current.length > 1) {
    out.push(`warning: ${current.length} tasks have Status: current (${current.map((t) => t.id).join(', ')}); block or finish all but one`);
  }
  return out.join('\n');
}

// --------------------------------------------------------------------- cli

const USAGE = `usage: tasks <command>
  add <title> [--scope "glob,glob"] [--category <id>]
                                      create a task in list/ and queue it in next.md;
                                      a category (evaluating-outputs skill) gates start
                                      on the plan's ## Evaluation and done on its scorecard
  list [current|next|blocked|done]    show the board, or one state of it
  current                             print the task in progress (its note and board line)
  next                                the queued tasks, in order
  blocked                             the blocked tasks, with their reasons
  show [id]                           print a task (default: the current one)
  start <id> [--no-session]           validate the note, spec and plan, then make it current
                                      and open its Claude Code session
  block <id> <reason>                 set it blocked, with the reason
  done [id] [--no-advance] [--no-pr] [-- test command]
                                      run the tests; on success set it done, write the
                                      PR draft to .claude/pr.md and print the commands
                                      that open it, then start the next ready queued task
  review [id] [--run-tests]           write the review package to ${REVIEWS_DIR}/<id>.md; exit 1 if not ready

  sync                                rebuild ${STATE_DIR}/*.md from the notes (after a checkout or merge)

Each task's state lives in its own note (Status, Blocked, Result lines), which
is committed; every command rebuilds the git-ignored ${STATE_DIR}/*.md from the
notes. Reorder your local queue by moving lines in next.md.`;

function option(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const [, value] = args.splice(i, 2);
  return value ?? '';
}

async function handleStart(root, rest, { log, session, claude, run }) {
  const noSession = rest.includes('--no-session');
  const forceSession = rest.includes('--session');
  const ref = rest.find((a) => !a.startsWith('--')) ?? fail('usage: tasks start <id> [--no-session]');
  const before = findTask(root, ref);
  const blockedReason = before.status === 'blocked' ? before.blocked : '';
  const task = startTask(root, ref);
  log(`started ${task.id} ${task.title}\nbase: ${task.base}\nbranch: ${task.branch}\nfile: ${task.path}`);
  if (noSession || !(session || forceSession)) return 0;
  return openSession(root, task, { log, blockedReason, claude, run });
}

async function openSession(root, task, { log, blockedReason = '', claude, run }) {
  log(`opening a Claude Code session for ${task.id}`);
  const result = await startSession(root, task, { blockedReason, ...(claude && { claude }), ...(run && { run }) });
  if (!result.started) log(`no session: ${result.message}`);
  return result.started ? result.code : 0;
}

async function handleDone(root, rest, after, { log, refOrCurrent, session, claude, run }) {
  const noAdvance = rest.includes('--no-advance');
  const ref = refOrCurrent(rest.find((a) => !a.startsWith('--')));
  const { task, tests, finished, evaluation } = finishTask(root, ref, after);
  log(tests.tail);
  const advisory = evaluation?.rows.filter((r) => r.human && r.human !== 'pass') ?? [];
  if (!finished && evaluation) {
    log(`evaluation ${evaluation.verdict}: ${task.id} NOT done — ${evaluation.scorecard}`);
    for (const r of evaluation.rows.filter((x) => x.status !== 'pass' && x.status !== 'n/a')) log(`- ${r.id}: ${r.status} (${r.threshold}, value ${r.value})`);
    for (const p of evaluation.problems) log(`- ${p}`);
    log('record each measurement with `node .claude/tools/evaluation.mjs record`, then run done again');
    return 1;
  }
  if (evaluation) {
    log(`evaluation PASS: ${evaluation.scorecard}`);
    if (advisory.length) log(`human review (advisory): ${advisory.map((r) => `${r.id} ${r.human}`).join(', ')}`);
  }
  if (!finished) {
    log(`tests failed (exit ${tests.status}); ${task.id} NOT done. Full output: ${tests.log}`);
    return tests.status || 1;
  }
  log(`done ${task.id} ${task.title}`);
  if (!rest.includes('--no-pr')) log(await draftPullRequest(root, task));
  if (noAdvance) return 0;
  // Another task may already be current (e.g. `done` on a task that was not the current one).
  const current = currentTaskOf(root);
  if (current) {
    log(`${current.id} ${current.title} is still in progress; not starting another task`);
    return 0;
  }
  const { started, skipped } = advance(root);
  for (const s of skipped) log(`skipped ${s.task.id} ${s.task.title}: ${s.reason.replace(/^\d+ is not ready to start: /, '')}`);
  if (!started) {
    log(skipped.length ? 'no queued task is ready to start; complete one, then `tasks start <id>`' : 'no queued tasks left');
    return 0;
  }
  log(`started ${started.id} ${started.title}\nbase: ${started.base}\nbranch: ${started.branch}\nfile: ${started.path}`);
  if (!session) {
    log(`read it with \`node .claude/tools/tasks.mjs current\` and continue with that task`);
    return 0;
  }
  return openSession(root, started, { log, claude, run });
}

// Writes the PR draft for a finished task with the create-pr tool installed
// next to this one, and returns what to tell the user: where the draft is and
// the commands that open the PR. It never pushes or opens anything itself.
export async function draftPullRequest(root, task) {
  const tool = join(dirname(fileURLToPath(import.meta.url)), 'create-pr.mjs');
  if (!existsSync(tool)) return 'no PR draft: create-pr.mjs is not installed next to tasks.mjs';
  const pr = await import(pathToFileURL(tool).href);
  try {
    return pr.draftReport(pr.writeDraft(root, pr.draftPr(root, { task: pr.taskFor(root, { ref: task.id }) })));
  } catch (error) {
    return `no PR draft: ${error.message}`;
  }
}

async function handleReview(root, rest, after, { log, refOrCurrent }) {
  const runTestsFlag = rest.includes('--run-tests');
  const ref = refOrCurrent(rest.find((a) => !a.startsWith('--')));
  const task = findTask(root, ref);
  const tests = runTestsFlag ? runTests(root, task, after) : null;
  const result = await reviewTask(root, task, { tests, recorded: task.status === 'done' ? task.result : '' });
  mkdirSync(join(root, REVIEWS_DIR), { recursive: true });
  const out = `${REVIEWS_DIR}/${task.id}.md`;
  writeFileSync(join(root, out), result.markdown);
  log(`${result.ready ? 'READY' : 'NOT READY'}: ${task.id} ${task.title}`);
  for (const f of result.findings) log(`- ${f}`);
  log(`review package: ${out}`);
  return result.ready ? 0 : 1;
}

function parseArgv(argv) {
  const sep = argv.indexOf('--');
  const args = sep < 0 ? [...argv] : argv.slice(0, sep);
  const after = sep < 0 ? '' : argv.slice(sep + 1).join(' ');
  const [command, ...rest] = args;
  return { command, rest, after };
}

function handleAdd(root, rest, log) {
  const scope = option(rest, '--scope') ?? '';
  const category = option(rest, '--category') ?? 'none';
  const task = addTask(root, rest.join(' '), { scope, category });
  log(`added ${task.path} (Status: next); complete the behavior, scenarios, test strategy and cases, create the spec and plan, then start it`);
  return 0;
}

function handleBoard(root, rest, log) {
  const state = rest[0];
  if (state && !STATES.includes(state)) fail(`unknown state ${state}: use ${STATES.join(', ')}`);
  log(state ? stateText(root, state) : boardText(root));
  const hint = trackedStateHint(root);
  if (hint) log(hint);
  return 0;
}

function handleCurrent(root, log) {
  const [task] = tasksIn(root, 'current');
  if (!task) {
    log(`no task is in progress; start one with \`tasks start <id>\`\n\n${stateText(root, 'next')}`);
    return 0;
  }
  const extra = task.extra ? ` · ${task.extra}` : '';
  log(`current: ${task.id} ${task.title}${extra}\nfile: ${task.path}\n\n${task.text.trim()}`);
  return 0;
}

function handleSync(root, synced, log) {
  log(synced.length ? `rewrote ${synced.join(', ')} from the notes` : `${STATE_DIR}/ already matches the notes`);
  const hint = trackedStateHint(root);
  if (hint) log(hint);
  return 0;
}

function handleBlock(root, rest, log) {
  const task = blockTask(root, rest[0] ?? fail('usage: tasks block <id> <reason>'), rest.slice(1).join(' '));
  log(`blocked ${task.id}`);
  return 0;
}

export async function main(argv, { root = projectRoot(), log = console.log, session = canOpenSession(), claude, run } = {}) {
  const { command, rest, after } = parseArgv(argv);
  const refOrCurrent = (ref) => ref ?? currentTaskOf(root)?.id ?? fail('no task is in progress; pass an id');
  const synced = command && command !== 'help' ? ensureBoard(root) : [];

  switch (command) {
    case 'add':       return handleAdd(root, rest, log);
    case 'list':
    case 'board':     return handleBoard(root, rest, log);
    case 'current':   return handleCurrent(root, log);
    case 'sync':      return handleSync(root, synced, log);
    case 'next':
    case 'blocked':   log(stateText(root, command)); return 0;
    case 'show':      log(findTask(root, refOrCurrent(rest[0])).text); return 0;
    case 'start':     return handleStart(root, rest, { log, session, claude, run });
    case 'block':     return handleBlock(root, rest, log);
    case 'done':      return handleDone(root, rest, after, { log, refOrCurrent, session, claude, run });
    case 'review':    return handleReview(root, rest, after, { log, refOrCurrent });
    default:
      log(USAGE);
      return command && command !== 'help' ? 2 : 0;
  }
}

// Node resolves symlinks in import.meta.url but not in argv[1]; compare real
// paths so this still runs when the project path goes through a symlink.
const entryPath = () => {
  try {
    return realpathSync(process.argv[1]);
  } catch {
    return process.argv[1] ?? '';
  }
};

if (import.meta.url === pathToFileURL(entryPath()).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof TaskError)) throw error;
    console.error(`tasks: ${error.message}`);
    process.exitCode = 2;
  }
}
