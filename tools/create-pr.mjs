#!/usr/bin/env node
// Drafts a pull request in the shape the opening-pull-requests skill asks for
// (Summary, Zone, Spec link, Risk, Rollback, Verification) from what the
// branch already records: its commits and their git-comments, the danger-zone
// prefix and spec, and the last quality-check run. Then opens it with gh.
//
//   node .claude/tools/create-pr.mjs draft [--base <ref>] > .claude/pr.md   edit the TODOs
//   node .claude/tools/create-pr.mjs create --body-file .claude/pr.md [--title ..] [--base ..] [--draft]
//
// It never pushes: push the branch yourself first (`git push -u origin HEAD`).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { git, NOTES_REF, projectRoot } from './git-comments.mjs';

const ZONES = { 'db/': 'db', 'deps/': 'packages', 'net/': 'network' };
const SEP = '\x1f';

const USAGE = `create-pr: draft and open a pull request for the current branch

Usage
  node .claude/tools/create-pr.mjs draft [--base <ref>]               Print title and body (Markdown)
  node .claude/tools/create-pr.mjs create --body-file <file> [opts]   Open it with gh

Options
  --base <ref>        Branch the PR targets (default: the default branch). Stacked PRs pass their parent
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

function verification(root) {
  let last;
  try {
    last = JSON.parse(readFileSync(join(root, '.claude', 'quality', 'last.json'), 'utf8'));
  } catch {
    return 'TODO: run `node .claude/tools/quality-check.mjs` and list what ran.';
  }
  const head = git(root, ['rev-parse', 'HEAD']).out;
  const stale = last.commit !== head ? ` (ran on ${String(last.commit).slice(0, 10)}, not on HEAD ${head.slice(0, 10)}: TODO re-run)` : last.dirty ? ' (ran with uncommitted changes)' : '';
  const lines = last.steps.map((s) => `- \`${s.command}\`: ${s.passed ? 'passed' : `FAILED (exit ${s.status})`}`);
  return `quality-check${stale}:\n${lines.join('\n')}`;
}

const humanize = (branch) => branch.replace(/^[\w-]+\//, '').replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function draftPr(root, { base } = {}) {
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
  const title = list.length === 1 ? list[0].subject : humanize(branch);

  const summary = [
    'TODO: what changes and why, in two or three sentences.',
    '',
    'Commits:',
    ...list.map((c) => `- ${c.subject} (${c.sha.slice(0, 7)})`),
    ...(notes.length ? ['', 'Notes left on commits:', ...notes.map((c) => `- ${c.sha.slice(0, 7)}: ${c.comment.replace(/\n+/g, ' ')}`)] : []),
  ].join('\n');
  const danger = zone !== 'none';
  const body = [
    '## Summary', summary,
    '## Zone', zone,
    '## Spec link', danger ? (hasSpec ? spec : `TODO: ${spec} is missing; danger-zone PRs need their spec committed`) : 'n/a',
    '## Risk', danger && hasSpec ? `TODO: repeat the risk from ${spec}.` : 'TODO: what can break and for whom.',
    '## Rollback', danger && hasSpec ? `TODO: repeat the rollback from ${spec}.` : 'TODO: how to undo it.',
    '## Verification', verification(root),
  ].join('\n\n').replace(/(## [^\n]+)\n\n/g, '$1\n');
  return { branch, base: target, title, zone, body: `${body}\n`, commits: list };
}

function pushedState(root, branch) {
  const upstream = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!upstream.ok) return `${branch} has no upstream; push it first: git push -u origin ${branch}`;
  const ahead = git(root, ['rev-list', '--count', '@{u}..HEAD']).out;
  return ahead !== '0' ? `${ahead} commit(s) are not pushed; push first: git push` : null;
}

export function createPr(root, { base, title, bodyFile, draft = false, gh = 'gh' } = {}) {
  if (!bodyFile) fail('create needs --body-file (write one with `create-pr.mjs draft > .claude/pr.md`)');
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
    log(`<!-- title: ${pr.title} | base: ${pr.base} | zone: ${pr.zone} -->\n\n${pr.body}`);
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = runCli(process.argv.slice(2));
