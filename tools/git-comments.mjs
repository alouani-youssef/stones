#!/usr/bin/env node
// Comments on commits, kept as git notes under their own ref so commits (and
// their hashes) never change. Use them to leave context for the next session:
// why a commit exists, what was verified, what is left to do.
//
//   node .claude/tools/git-comments.mjs set <rev> <text>     replace the comment
//   node .claude/tools/git-comments.mjs append <rev> <text>  add a paragraph
//   node .claude/tools/git-comments.mjs get [rev]            print it (default HEAD)
//   node .claude/tools/git-comments.mjs list [range]         commits that have one
//   node .claude/tools/git-comments.mjs remove <rev>         delete it
//
// Notes are local until shared: `git push origin refs/notes/comments` and
// `git fetch origin refs/notes/comments:refs/notes/comments`.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const NOTES_REF = 'refs/notes/comments';

const USAGE = `git-comments: comments on commits, stored as git notes (${NOTES_REF})

Usage
  node .claude/tools/git-comments.mjs set <rev> <text>      Replace the comment on <rev>
  node .claude/tools/git-comments.mjs append <rev> <text>   Add a paragraph to it
  node .claude/tools/git-comments.mjs get [rev]             Print it (default HEAD)
  node .claude/tools/git-comments.mjs list [range]          Commits with a comment (default: all)
  node .claude/tools/git-comments.mjs remove <rev>          Delete it

Options
  --json          JSON output for get and list
  -h, --help      Show this help

Text may also come from stdin: echo "..." | git-comments.mjs set HEAD -`;

export class CommentError extends Error {}
const fail = (message) => {
  throw new CommentError(message);
};

export function git(root, args, input) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trimEnd(), err: (r.stderr ?? '').trim() };
}

export function projectRoot(cwd = process.cwd()) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.ok) return top.out;
  if (process.env.CLAUDE_PROJECT_DIR) return resolve(process.env.CLAUDE_PROJECT_DIR);
  return resolve(cwd);
}

export function resolveCommit(root, rev = 'HEAD') {
  const r = git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return r.ok ? r.out : fail(`not a commit: ${rev}`);
}

const subjectOf = (root, sha) => git(root, ['log', '-1', '--format=%s', sha]).out;

export function getComment(root, rev = 'HEAD') {
  const sha = resolveCommit(root, rev);
  const r = git(root, ['notes', `--ref=${NOTES_REF}`, 'show', sha]);
  return { sha, subject: subjectOf(root, sha), comment: r.ok ? r.out : '' };
}

export function setComment(root, rev, text) {
  if (!text?.trim()) fail('comment text is empty');
  const sha = resolveCommit(root, rev);
  const r = git(root, ['notes', `--ref=${NOTES_REF}`, 'add', '-f', '-F', '-', sha], `${text.trim()}\n`);
  return r.ok ? getComment(root, sha) : fail(r.err || 'git notes add failed');
}

export function appendComment(root, rev, text) {
  if (!text?.trim()) fail('comment text is empty');
  const sha = resolveCommit(root, rev);
  const r = git(root, ['notes', `--ref=${NOTES_REF}`, 'append', '-F', '-', sha], `${text.trim()}\n`);
  return r.ok ? getComment(root, sha) : fail(r.err || 'git notes append failed');
}

export function removeComment(root, rev) {
  const sha = resolveCommit(root, rev);
  const r = git(root, ['notes', `--ref=${NOTES_REF}`, 'remove', '--ignore-missing', sha]);
  return r.ok ? { sha } : fail(r.err || 'git notes remove failed');
}

// Commits with a comment, newest first. `range` limits it (e.g. main..HEAD).
export function listComments(root, range) {
  const noted = git(root, ['notes', `--ref=${NOTES_REF}`, 'list']);
  if (!noted.ok || !noted.out) return [];
  const commits = new Set(noted.out.split('\n').map((l) => l.split(' ')[1]));
  const args = ['log', '--format=%H', ...(range ? [range] : ['--all'])];
  const order = git(root, args);
  if (!order.ok) fail(order.err || `bad range: ${range}`);
  return order.out.split('\n').filter((sha) => commits.has(sha)).map((sha) => getComment(root, sha));
}

const short = (sha) => sha.slice(0, 10);
const indent = (text) => text.split('\n').map((l) => `    ${l}`).join('\n');

function readText(rest) {
  const text = rest.join(' ');
  if (text !== '-') return text;
  return spawnSync('cat', [], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] }).stdout ?? '';
}

export function main(argv, { log = console.log, cwd = process.cwd() } = {}) {
  const json = argv.includes('--json');
  const args = argv.filter((a) => a !== '--json');
  const [command, ...rest] = args;
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    log(USAGE);
    return 0;
  }
  const root = projectRoot(cwd);
  if (!git(root, ['rev-parse', '--git-dir']).ok) fail('not inside a git repository');
  switch (command) {
    case 'set':
    case 'append': {
      const [rev, ...text] = rest;
      if (!rev || !text.length) fail(`usage: git-comments ${command} <rev> <text>`);
      const result = (command === 'set' ? setComment : appendComment)(root, rev, readText(text));
      log(`${command === 'set' ? 'set' : 'appended'} comment on ${short(result.sha)} ${result.subject}`);
      return 0;
    }
    case 'get': {
      const result = getComment(root, rest[0] ?? 'HEAD');
      if (json) log(JSON.stringify(result, null, 2));
      else log(result.comment ? `${short(result.sha)} ${result.subject}\n\n${result.comment}` : `${short(result.sha)} ${result.subject}\n\n(no comment)`);
      return 0;
    }
    case 'list': {
      const results = listComments(root, rest[0]);
      if (json) log(JSON.stringify(results, null, 2));
      else log(results.length ? results.map((r) => `${short(r.sha)} ${r.subject}\n${indent(r.comment)}`).join('\n\n') : 'No commented commits.');
      return 0;
    }
    case 'remove': {
      if (!rest[0]) fail('usage: git-comments remove <rev>');
      log(`removed comment from ${short(removeComment(root, rest[0]).sha)}`);
      return 0;
    }
    default:
      log(`git-comments: unknown command ${command}\n\n${USAGE}`);
      return 2;
  }
}

export function run(argv, options) {
  try {
    return main(argv, options);
  } catch (error) {
    if (!(error instanceof CommentError)) throw error;
    (options?.error ?? console.error)(`git-comments: ${error.message}`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = run(process.argv.slice(2));
