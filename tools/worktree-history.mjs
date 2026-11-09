#!/usr/bin/env node
// The history of a git worktree, to pick work back up where it stopped:
// its branch, the commit it started from, the commits made since (with their
// git-comments), uncommitted changes and the recent moves of its HEAD.
//
//   node .claude/tools/worktree-history.mjs list
//   node .claude/tools/worktree-history.mjs show [path|branch] [--base <ref>] [--limit <n>] [--json]
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CommentError, git, NOTES_REF, projectRoot } from './git-comments.mjs';

const USAGE = `worktree-history: what happened in a git worktree

Usage
  node .claude/tools/worktree-history.mjs list                     Every worktree, with branch, commits ahead and changes
  node .claude/tools/worktree-history.mjs show [path|branch]       History of one worktree (default: this one)

Options
  --base <ref>    Compare against <ref> instead of the default branch
  --limit <n>     Commits and reflog entries to show (default 30)
  --json          JSON output
  -h, --help      Show this help`;

class HistoryError extends Error {}
const fail = (message) => {
  throw new HistoryError(message);
};

// `git worktree list --porcelain`: blocks of `key value` lines, blank-separated.
export function parseWorktrees(porcelain) {
  return porcelain.split(/\n\s*\n/).filter((b) => b.trim()).map((block) => {
    const wt = { path: '', head: '', branch: null, detached: false, bare: false, locked: null, prunable: null };
    for (const line of block.split('\n')) {
      const [key, ...value] = line.split(' ');
      const v = value.join(' ');
      if (key === 'worktree') wt.path = v;
      else if (key === 'HEAD') wt.head = v;
      else if (key === 'branch') wt.branch = v.replace(/^refs\/heads\//, '');
      else if (key === 'detached') wt.detached = true;
      else if (key === 'bare') wt.bare = true;
      else if (key === 'locked') wt.locked = v || 'locked';
      else if (key === 'prunable') wt.prunable = v || 'prunable';
    }
    return wt;
  });
}

export function listWorktrees(root) {
  const r = git(root, ['worktree', 'list', '--porcelain']);
  return r.ok ? parseWorktrees(r.out) : fail(r.err || 'git worktree list failed');
}

// origin/HEAD when a remote says so, else a local main/master/trunk/develop.
export function defaultBranch(root) {
  const remote = git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (remote.ok && remote.out) return remote.out;
  for (const name of ['main', 'master', 'trunk', 'develop']) {
    if (git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).ok) return name;
  }
  return null;
}

export function findWorktree(root, ref, cwd = root) {
  const worktrees = listWorktrees(root);
  const here = projectRoot(cwd);
  if (!ref) return worktrees.find((w) => resolve(w.path) === resolve(here)) ?? worktrees[0];
  const asPath = isAbsolute(ref) ? ref : resolve(cwd, ref);
  return worktrees.find((w) => resolve(w.path) === asPath)
    ?? worktrees.find((w) => w.branch === ref.replace(/^refs\/heads\//, ''))
    ?? worktrees.find((w) => w.path.endsWith(`/${ref}`))
    ?? fail(`no worktree matches ${ref}; run \`worktree-history list\``);
}

const SEP = '\x1f';

function commitsSince(path, from, limit) {
  const range = from ? [`${from}..HEAD`] : ['HEAD'];
  const r = git(path, ['log', `-n${limit}`, `--notes=${NOTES_REF}`, `--format=%H${SEP}%aI${SEP}%an${SEP}%s${SEP}%N%x1e`, ...range]);
  if (!r.ok || !r.out) return [];
  return r.out.split('\x1e').map((c) => c.replace(/^\n/, '')).filter(Boolean).map((c) => {
    const [sha, date, author, subject, comment = ''] = c.split(SEP);
    return { sha, date, author, subject, comment: comment.trim() };
  });
}

function uncommitted(path) {
  const r = git(path, ['status', '--porcelain=v1', '--untracked-files=all']);
  return r.ok && r.out ? r.out.split('\n').map((l) => ({ status: l.slice(0, 2).trim() || '?', file: l.slice(3) })) : [];
}

function reflog(path, limit) {
  const r = git(path, ['reflog', `-n${limit}`, '--date=iso-strict', `--format=%h${SEP}%gd${SEP}%gs`]);
  if (!r.ok || !r.out) return [];
  return r.out.split('\n').map((l) => {
    const [sha, selector, action] = l.split(SEP);
    return { sha, date: /\{(.+)\}/.exec(selector)?.[1] ?? '', action };
  });
}

export function worktreeHistory(root, ref, { base, limit = 30, cwd = root } = {}) {
  const wt = findWorktree(root, ref, cwd);
  if (wt.bare) fail(`${wt.path} is a bare repository; it has no working tree`);
  if (wt.prunable) fail(`${wt.path} is gone (${wt.prunable}); run \`git worktree prune\``);
  const baseRef = base ?? defaultBranch(root);
  if (base && !git(wt.path, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).ok) fail(`not a commit: ${base}`);
  const mergeBase = baseRef ? git(wt.path, ['merge-base', baseRef, 'HEAD']) : { ok: false };
  const from = mergeBase.ok ? mergeBase.out : null;
  // On the base branch itself there is nothing "since"; show recent history instead.
  const sameAsBase = from && from === wt.head;
  const ahead = from ? Number(git(wt.path, ['rev-list', '--count', `${from}..HEAD`]).out || 0) : null;
  const behind = from && baseRef ? Number(git(wt.path, ['rev-list', '--count', `HEAD..${baseRef}`]).out || 0) : null;
  return {
    path: wt.path,
    branch: wt.branch,
    detached: wt.detached,
    locked: wt.locked,
    head: wt.head,
    base: baseRef ? { ref: baseRef, commit: from, ahead, behind } : null,
    commits: commitsSince(wt.path, sameAsBase ? null : from, limit),
    recent: Boolean(sameAsBase || !from),
    uncommitted: uncommitted(wt.path),
    reflog: reflog(wt.path, Math.min(limit, 15)),
  };
}

const short = (sha) => (sha ?? '').slice(0, 10);

export function formatList(root, worktrees) {
  if (!worktrees.length) return 'No worktrees.';
  const base = defaultBranch(root);
  return worktrees.map((w) => {
    const label = w.bare ? '(bare)' : w.detached ? `(detached ${short(w.head)})` : w.branch;
    const flags = [w.locked && `locked: ${w.locked}`, w.prunable && `prunable: ${w.prunable}`].filter(Boolean);
    if (!w.bare && !w.prunable) {
      const mb = base ? git(w.path, ['merge-base', base, 'HEAD']) : { ok: false };
      if (mb.ok && mb.out !== w.head) flags.push(`${git(w.path, ['rev-list', '--count', `${mb.out}..HEAD`]).out} ahead of ${base}`);
      const changes = uncommitted(w.path).length;
      if (changes) flags.push(`${changes} uncommitted`);
    }
    const where = relative(root, w.path) || '.';
    return `${where}  ${label}${flags.length ? `  [${flags.join(', ')}]` : ''}`;
  }).join('\n');
}

export function formatHistory(h) {
  const lines = [`Worktree ${h.path}`];
  lines.push(`Branch   ${h.branch ?? `(detached at ${short(h.head)})`}${h.locked ? `  [locked: ${h.locked}]` : ''}`);
  if (h.base?.commit) lines.push(`Base     ${h.base.ref} at ${short(h.base.commit)} (${h.base.ahead} ahead, ${h.base.behind} behind)`);
  else lines.push('Base     none found (pass --base <ref>)');
  lines.push('', h.recent ? `Recent commits (${h.commits.length})` : `Commits since base (${h.commits.length})`);
  if (!h.commits.length) lines.push('  none');
  for (const c of h.commits) {
    lines.push(`  ${short(c.sha)} ${c.date.slice(0, 10)} ${c.subject} (${c.author})`);
    if (c.comment) lines.push(...c.comment.split('\n').map((l) => `      # ${l}`));
  }
  lines.push('', `Uncommitted (${h.uncommitted.length})`);
  if (!h.uncommitted.length) lines.push('  clean');
  for (const u of h.uncommitted) lines.push(`  ${u.status.padEnd(2)} ${u.file}`);
  if (h.reflog.length) {
    lines.push('', 'HEAD moves');
    for (const r of h.reflog) lines.push(`  ${r.sha} ${r.date.slice(0, 16).replace('T', ' ')} ${r.action}`);
  }
  return lines.join('\n');
}

export function main(argv, { log = console.log, cwd = process.cwd() } = {}) {
  const opts = { json: false, base: undefined, limit: 30 };
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--base') opts.base = argv[++i] ?? fail('--base needs a ref');
    else if (a === '--limit') {
      opts.limit = Number(argv[++i]);
      if (!Number.isInteger(opts.limit) || opts.limit < 1) fail('--limit needs a positive number');
    } else if (a === '-h' || a === '--help') {
      log(USAGE);
      return 0;
    } else if (a.startsWith('-')) fail(`unknown option ${a}`);
    else args.push(a);
  }
  const root = projectRoot(cwd);
  if (!git(root, ['rev-parse', '--git-dir']).ok) fail('not inside a git repository');
  const [command = 'show', ref] = args;
  switch (command) {
    case 'list': {
      const worktrees = listWorktrees(root);
      log(opts.json ? JSON.stringify(worktrees, null, 2) : formatList(root, worktrees));
      return 0;
    }
    case 'show': {
      const history = worktreeHistory(root, ref, { base: opts.base, limit: opts.limit, cwd });
      log(opts.json ? JSON.stringify(history, null, 2) : formatHistory(history));
      return 0;
    }
    default:
      log(`worktree-history: unknown command ${command}\n\n${USAGE}`);
      return 2;
  }
}

export function run(argv, options) {
  try {
    return main(argv, options);
  } catch (error) {
    if (!(error instanceof HistoryError || error instanceof CommentError)) throw error;
    (options?.error ?? console.error)(`worktree-history: ${error.message}`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = run(process.argv.slice(2));
