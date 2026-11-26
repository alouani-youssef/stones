#!/usr/bin/env node
// Drafts a pull request in the shape the opening-pull-requests skill asks for
// (Summary, Zone, Spec link, Risk, Rollback, Verification) from what the
// branch already records: its commits and their git-comments, the danger-zone
// prefix and spec, the last quality-check run, and the board task the branch
// carries (docs/tasks/list/: its title, expected behavior, scenarios,
// contract change, test result and review verdict). Then opens it with gh.
//
//   node .claude/tools/create-pr.mjs draft [--base <ref>] [--task <id>] [--write]
//       print the draft, or with --write save it to .claude/pr.md and print the
//       commands that open the PR (commit the task bookkeeping, push, create)
//   node .claude/tools/create-pr.mjs create --body-file .claude/pr.md [--title ..] [--base ..] [--draft]
//
// `tasks done` writes the draft and prints those commands for the task it closes.
// It never pushes or opens a PR on its own: the printed commands do that.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { git, NOTES_REF, projectRoot } from './git-comments.mjs';

const ZONES = { 'db/': 'db', 'deps/': 'packages', 'net/': 'network' };
const SEP = '\x1f';
export const PR_FILE = '.claude/pr.md';
const TASK_LIST = 'docs/tasks/list';
// Files the task board writes; a commit touching only these does not make a test run stale.
const BOOKKEEPING = /^docs\/tasks\//;

const USAGE = `create-pr: draft and open a pull request for the current branch

Usage
  node .claude/tools/create-pr.mjs draft [--base <ref>] [--write]     Print title and body (Markdown)
  node .claude/tools/create-pr.mjs create --body-file <file> [opts]   Open it with gh

Options
  --base <ref>        Branch the PR targets (default: the default branch). Stacked PRs pass their parent
  --task <id>         Board task the PR delivers (default: the task whose Branch is this branch)
  --write             Save the draft to ${PR_FILE} and print the commands that open the PR
  --title <text>      PR title (default: the draft's title)
  --body-file <file>  Body to use; it must not contain TODO
  --draft             Open as a draft PR
  -h, --help          Show this help

The branch must be pushed first: git push -u origin HEAD`;

class PrError extends Error {}
const fail = (message) => {
  throw new PrError(message);
};

const run = (root, args) => {
  const r = git(root, args);
  return r.ok ? r.out : fail(r.err || `git ${args.join(' ')} failed`);
};

export function defaultBranch(root) {
  const remote = git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (remote.ok && remote.out) return remote.out.replace(/^origin\//, '');
  for (const name of ['main', 'master', 'trunk', 'develop']) {
    if (git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).ok) return name;
  }
  return fail('no default branch found; pass --base <ref>');
}

export const zoneOf = (branch) => Object.entries(ZONES).find(([prefix]) => branch.startsWith(prefix))?.[1] ?? 'none';
export const specPath = (branch) => `.claude/danger/${branch.replaceAll('/', '-')}.md`;

function commits(root, base) {
  const ref = git(root, ['rev-parse', '--verify', '--quiet', `origin/${base}`]).ok ? `origin/${base}` : base;
  const from = run(root, ['merge-base', ref, 'HEAD']);
  const out = git(root, ['log', `--notes=${NOTES_REF}`, `--format=%H${SEP}%s${SEP}%b${SEP}%N%x1e`, `${from}..HEAD`]).out;
  return out.split('\x1e').map((c) => c.replace(/^\n/, '')).filter(Boolean).map((c) => {
    const [sha, subject, body = '', comment = ''] = c.split(SEP);
    return { sha, subject, body: body.trim(), comment: comment.trim() };
  }).reverse();
}

// ------------------------------------------------------------ board task
//
// A small reader for the notes tools/tasks.mjs writes, so this tool also
// works where the task board is not installed.

const readText = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

const meta = (text, key) => new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(text)?.[1]?.trim() ?? '';

export function section(text, heading) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  return lines.slice(start + 1, end < 0 ? lines.length : end).join('\n').replace(/<!--([\s\S]*?)-->/g, '').trim();
}

function readTaskNote(root, file) {
  const path = `${TASK_LIST}/${file}`;
  const text = readText(join(root, path));
  if (text === undefined) return null;
  return {
    id: /^(\d+)/.exec(file)[1],
    path,
    text,
    title: /^#\s+\d+\s+(.*)$/m.exec(text)?.[1]?.trim() ?? file,
    status: meta(text, 'Status'),
    branch: meta(text, 'Branch'),
    scope: meta(text, 'Scope'),
    result: meta(text, 'Result'),
  };
}

const taskFiles = (root) => {
  try {
    return readdirSync(join(root, TASK_LIST)).filter((f) => /^\d+-.*\.md$/.test(f)).sort();
  } catch {
    return [];
  }
};

// The task `ref` names, or else the task recorded on `branch`: the current
// one if it is there, otherwise the last one done there.
export function taskFor(root, { ref, branch } = {}) {
  const tasks = taskFiles(root).map((f) => readTaskNote(root, f)).filter(Boolean);
  if (ref !== undefined) {
    const wanted = String(ref).replace(/^#/, '');
    return tasks.find((t) => t.id === wanted.padStart(t.id.length, '0')) ?? fail(`no task ${ref} in ${TASK_LIST}/`);
  }
  const mine = tasks.filter((t) => branch && t.branch === branch);
  return mine.find((t) => t.status === 'current') ?? mine.filter((t) => t.status === 'done').at(-1) ?? null;
}

const oneLine = (text) => text.replace(/\s+/g, ' ').trim();
const isPlaceholder = (text) => /\bTODO\b|\bTBD\b/.test(text);

function reviewVerdict(root, task) {
  const pkg = readText(join(root, 'docs', 'logs', 'reviews', `${task.id}.md`));
  return pkg && /^Verdict: \*\*(READY|NOT READY)\*\*/m.exec(pkg)?.[1];
}

// --------------------------------------------------------------- sections

// Whether files other than the board's bookkeeping changed between two commits.
function changedSince(root, from, to) {
  const diff = git(root, ['diff', '--name-only', from, to]);
  if (!diff.ok) return true;
  return diff.out.split('\n').filter(Boolean).some((f) => !BOOKKEEPING.test(f));
}

function verification(root, task) {
  const taskLines = [];
  if (task?.result) taskLines.push(`- task ${task.id} tests: ${task.result}`);
  const verdict = task && reviewVerdict(root, task);
  if (verdict) taskLines.push(`- task review (\`tasks review ${task.id}\`): ${verdict}${verdict === 'READY' ? '' : ' (TODO: fix the findings)'}`);
  let last;
  try {
    last = JSON.parse(readFileSync(join(root, 'docs', 'logs', 'quality', 'last.json'), 'utf8'));
  } catch {
    return taskLines.length ? taskLines.join('\n') : 'TODO: run `node .claude/tools/quality-check.mjs` and list what ran.';
  }
  const head = git(root, ['rev-parse', 'HEAD']).out;
  const stale = last.commit !== head && changedSince(root, last.commit, head)
    ? ` (ran on ${String(last.commit).slice(0, 10)}, not on HEAD ${head.slice(0, 10)}: TODO re-run)`
    : last.dirty ? ' (ran with uncommitted changes)' : '';
  const lines = last.steps.map((s) => `- \`${s.command}\`: ${s.passed ? 'passed' : `FAILED (exit ${s.status})`}`);
  return [`quality-check${stale}:`, ...lines, ...taskLines].join('\n');
}

// Summary, risk and rollback from the task note, where it says them.
function taskSections(task) {
  const behavior = section(task.text, 'Expected behavior');
  const scenarios = section(task.text, 'Scenarios').split('\n').filter((l) => /^\s*[-*]\s+/.test(l) && !isPlaceholder(l));
  const contract = section(task.text, 'Contract change');
  const unchanged = !contract || /^(?:none|no|unchanged|no contract change)\.?$/i.test(contract);
  const scope = task.scope ? ` Changes stay within its scope (${task.scope}).` : '';
  const ownRisk = section(task.text, 'Risk');
  const ownRollback = section(task.text, 'Rollback');
  return {
    lead: behavior && !isPlaceholder(behavior) ? `${task.title}: ${oneLine(behavior)}` : null,
    extra: [
      '',
      `Task: [${task.id} ${task.title}](${task.path})`,
      ...(scenarios.length ? ['', 'Scenarios:', ...scenarios.map((l) => l.trim())] : []),
    ],
    risk: ownRisk && !isPlaceholder(ownRisk)
      ? ownRisk
      : unchanged
        ? `No contract change: existing callers keep the behavior they rely on.${scope}`
        : `${oneLine(contract)}: callers that rely on the old behavior are affected.${scope}`,
    rollback: ownRollback && !isPlaceholder(ownRollback) ? ownRollback : 'Revert this PR; it carries no data, package or network changes.',
  };
}

const humanize = (branch) => branch.replace(/^[\w-]+\//, '').replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function draftPr(root, { base, task: taskRef } = {}) {
  const branch = run(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'HEAD') fail('HEAD is detached; check out a branch first');
  const target = base ?? defaultBranch(root);
  if (branch === target) fail(`you are on ${target}; create a branch for the change first`);
  const list = commits(root, target);
  if (!list.length) fail(`no commits on ${branch} since ${target}`);
  const zone = zoneOf(branch);
  const spec = specPath(branch);
  const hasSpec = existsSync(join(root, spec));
  const notes = list.filter((c) => c.comment);
  const task = taskRef && typeof taskRef === 'object' ? taskRef : taskFor(root, { ref: taskRef, branch });
  const fromTask = task ? taskSections(task) : null;
  const danger = zone !== 'none';
  const title = list.length === 1 ? list[0].subject : task ? task.title : humanize(branch);

  const summary = [
    fromTask?.lead ?? 'TODO: what changes and why, in two or three sentences.',
    ...(fromTask?.extra ?? []),
    '',
    'Commits:',
    ...list.map((c) => `- ${c.subject} (${c.sha.slice(0, 7)})`),
    ...(notes.length ? ['', 'Notes left on commits:', ...notes.map((c) => `- ${c.sha.slice(0, 7)}: ${c.comment.replace(/\n+/g, ' ')}`)] : []),
  ].join('\n');
  const body = [
    '## Summary', summary,
    '## Zone', zone,
    '## Spec link', danger ? (hasSpec ? spec : `TODO: ${spec} is missing; danger-zone PRs need their spec committed`) : 'n/a',
    '## Risk', danger ? (hasSpec ? `TODO: repeat the risk from ${spec}.` : 'TODO: what can break and for whom.') : fromTask?.risk ?? 'TODO: what can break and for whom.',
    '## Rollback', danger ? (hasSpec ? `TODO: repeat the rollback from ${spec}.` : 'TODO: how to undo it.') : fromTask?.rollback ?? 'TODO: how to undo it.',
    '## Verification', verification(root, task),
  ].join('\n\n').replace(/(## [^\n]+)\n\n/g, '$1\n');
  return { branch, base: target, title, zone, task, body: `${body}\n`, commits: list };
}

// The draft as a file: its title, base and zone in a comment `create` reads back.
export const renderDraft = (pr) => `<!-- title: ${pr.title} | base: ${pr.base} | zone: ${pr.zone} -->\n\n${pr.body}`;

const shellQuote = (text) => (/^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`);

// The commands that take a saved draft to an open PR, in order: commit the
// board's bookkeeping for the task, push the branch, fill any TODOs, create.
export function prCommands(root, pr, file = PR_FILE) {
  const commands = [];
  const bookkeeping = git(root, ['status', '--porcelain', '--', 'docs/tasks']).out;
  if (bookkeeping) {
    const subject = pr.task ? `chore(tasks): close ${pr.task.id} ${pr.task.title}` : 'chore(tasks): update the task board';
    commands.push(`git add docs/tasks && git commit -m ${shellQuote(subject)}`);
  }
  const upstream = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!upstream.ok) commands.push(`git push -u origin ${shellQuote(pr.branch)}`);
  else if (bookkeeping || git(root, ['rev-list', '--count', '@{u}..HEAD']).out !== '0') commands.push('git push');
  const todos = (pr.body.match(/\bTODO\b/g) ?? []).length;
  const create = `node .claude/tools/create-pr.mjs create --body-file ${shellQuote(file)} --base ${shellQuote(pr.base)}`;
  return { commands: [...commands, create], todos };
}

export function writeDraft(root, pr, file = PR_FILE) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), renderDraft(pr));
  return { file, ...prCommands(root, pr, file) };
}

export function draftReport({ file, commands, todos }) {
  return [
    `PR draft: ${file}${todos ? ` (${todos} TODO${todos > 1 ? 's' : ''} to fill in before create)` : ' (complete)'}`,
    'open the PR with:',
    ...commands.map((c) => `  ${c}`),
  ].join('\n');
}

function pushedState(root, branch) {
  const upstream = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!upstream.ok) return `${branch} has no upstream; push it first: git push -u origin ${branch}`;
  const ahead = git(root, ['rev-list', '--count', '@{u}..HEAD']).out;
  return ahead !== '0' ? `${ahead} commit(s) are not pushed; push first: git push` : null;
}

export function createPr(root, { base, title, bodyFile, draft = false, gh = 'gh' } = {}) {
  if (!bodyFile) fail('create needs --body-file (write one with `create-pr.mjs draft --write`)');
  const text = readFileSync(join(root, bodyFile), 'utf8');
  // The draft's first line carries its title as a comment; it is not part of the body.
  const header = /^<!--\s*title:\s*(.*?)\s*\|[^\n]*-->\n+/.exec(text);
  const body = header ? text.slice(header[0].length) : text;
  if (/\bTODO\b/.test(body)) fail(`${bodyFile} still has TODOs; fill them in first`);
  const pr = draftPr(root, { base });
  const unpushed = pushedState(root, pr.branch);
  if (unpushed) fail(unpushed);
  const args = ['pr', 'create', '--base', pr.base, '--head', pr.branch, '--title', title ?? header?.[1] ?? pr.title, '--body', body.trim(), ...(draft ? ['--draft'] : [])];
  const r = spawnSync(gh, args, { cwd: root, encoding: 'utf8' });
  if (r.error) fail(`${gh} is not available: ${r.error.message}`);
  if (r.status !== 0) fail((r.stderr || r.stdout || 'gh pr create failed').trim());
  return { url: r.stdout.trim(), base: pr.base, branch: pr.branch };
}

export function main(argv, { log = console.log, cwd = process.cwd(), gh } = {}) {
  const opts = {};
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') opts.base = argv[++i] ?? fail('--base needs a ref');
    else if (a === '--title') opts.title = argv[++i] ?? fail('--title needs text');
    else if (a === '--body-file') opts.bodyFile = argv[++i] ?? fail('--body-file needs a path');
    else if (a === '--draft') opts.draft = true;
    else if (a === '--task') opts.task = argv[++i] ?? fail('--task needs an id');
    else if (a === '--write') opts.write = true;
    else if (a === '-h' || a === '--help') {
      log(USAGE);
      return 0;
    } else if (a.startsWith('-')) fail(`unknown option ${a}`);
    else args.push(a);
  }
  const root = projectRoot(cwd);
  const [command = 'draft'] = args;
  if (command === 'draft') {
    const pr = draftPr(root, opts);
    log(opts.write ? draftReport(writeDraft(root, pr)) : renderDraft(pr));
    return 0;
  }
  if (command === 'create') {
    const pr = createPr(root, { ...opts, gh: gh ?? 'gh' });
    log(`opened ${pr.url} (${pr.branch} -> ${pr.base})`);
    return 0;
  }
  log(`create-pr: unknown command ${command}\n\n${USAGE}`);
  return 2;
}

export function runCli(argv, options) {
  try {
    return main(argv, options);
  } catch (error) {
    if (!(error instanceof PrError)) throw error;
    (options?.error ?? console.error)(`create-pr: ${error.message}`);
    return 2;
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

if (import.meta.url === pathToFileURL(entryPath()).href) process.exitCode = runCli(process.argv.slice(2));
