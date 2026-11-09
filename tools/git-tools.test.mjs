import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { appendComment, getComment, listComments, NOTES_REF, removeComment, run as comments, setComment } from './git-comments.mjs';
import { parseWorktrees, run as history, worktreeHistory } from './worktree-history.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stones-git-')));
  const run = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 't@example.com');
  run('config', 'user.name', 'T');
  const commit = (file, message, cwd = root) => {
    writeFileSync(join(cwd, file), `${message}\n`);
    execFileSync('git', ['add', file], { cwd });
    execFileSync('git', ['commit', '-qm', message], { cwd });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  };
  return { root, run, commit };
}

const capture = (fn, argv, cwd) => {
  const out = [];
  const err = [];
  const code = fn(argv, { cwd, log: (l) => out.push(l), error: (l) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

describe('git-comments', () => {
  it('sets, appends, reads and removes a comment without changing the commit', () => {
    const { root, run, commit } = repo();
    const sha = commit('a.txt', 'first');
    assert.equal(getComment(root).comment, '');
    setComment(root, 'HEAD', 'Verified with npm test.');
    assert.equal(getComment(root, sha).comment, 'Verified with npm test.');
    setComment(root, 'HEAD', 'Replaced.');
    appendComment(root, 'HEAD', 'Left to do: docs.');
    assert.equal(getComment(root).comment, 'Replaced.\n\nLeft to do: docs.');
    assert.equal(run('rev-parse', 'HEAD'), sha, 'the commit hash is unchanged');
    assert.match(run('notes', `--ref=${NOTES_REF}`, 'show', sha), /Replaced/);
    removeComment(root, 'HEAD');
    assert.equal(getComment(root).comment, '');
    removeComment(root, 'HEAD'); // removing twice is fine
  });

  it('lists commented commits newest first, limited by a range', () => {
    const { root, commit } = repo();
    const a = commit('a.txt', 'a');
    commit('b.txt', 'b');
    const c = commit('c.txt', 'c');
    setComment(root, a, 'on a');
    setComment(root, c, 'on c');
    assert.deepEqual(listComments(root).map((x) => x.comment), ['on c', 'on a']);
    assert.deepEqual(listComments(root, `${a}..HEAD`).map((x) => x.subject), ['c']);
  });

  it('works from the CLI and reports bad input', () => {
    const { root, commit } = repo();
    commit('a.txt', 'first');
    assert.match(capture(comments, ['set', 'HEAD', 'why', 'this', 'exists'], root).out, /set comment on \w{10} first/);
    assert.match(capture(comments, ['get'], root).out, /why this exists/);
    assert.equal(JSON.parse(capture(comments, ['list', '--json'], root).out)[0].comment, 'why this exists');
    const bad = capture(comments, ['get', 'nope'], root);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /not a commit: nope/);
    assert.equal(capture(comments, ['set', 'HEAD'], root).code, 2);
    assert.equal(capture(comments, ['frob'], root).code, 2);
    const outside = capture(comments, ['get'], realpathSync(mkdtempSync(join(tmpdir(), 'stones-nogit-'))));
    assert.match(outside.err, /not inside a git repository/);
  });

  it('reads the comment text from stdin with -', () => {
    const { root, commit } = repo();
    commit('a.txt', 'first');
    execFileSync('node', [join(HERE, 'git-comments.mjs'), 'set', 'HEAD', '-'], { cwd: root, input: 'from stdin\n' });
    assert.equal(getComment(root).comment, 'from stdin');
  });
});

describe('worktree-history', () => {
  it('parses porcelain worktree output', () => {
    const wts = parseWorktrees('worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /r/wt\nHEAD def\ndetached\nlocked moving disks\n\nworktree /gone\nHEAD 123\nbranch refs/heads/x\nprunable gitdir file points to non-existent location\n');
    assert.deepEqual(wts.map((w) => [w.path, w.branch, w.detached, w.locked, Boolean(w.prunable)]), [
      ['/r', 'main', false, null, false],
      ['/r/wt', null, true, 'moving disks', false],
      ['/gone', 'x', false, null, true],
    ]);
  });

  it('shows a worktree branch history since its base, with comments and uncommitted changes', () => {
    const { root, run, commit } = repo();
    commit('a.txt', 'base');
    const wt = join(root, '..', `${root.split('/').pop()}-feature`);
    run('worktree', 'add', '-q', '-b', 'feature/login', wt);
    commit('login.txt', 'add login', wt);
    const second = commit('login2.txt', 'add logout', wt);
    setComment(root, second, 'Logout still needs a test.');
    writeFileSync(join(wt, 'wip.txt'), 'wip\n');
    commit('main-only.txt', 'main moves on');

    const h = worktreeHistory(root, 'feature/login');
    assert.equal(h.path, wt);
    assert.equal(h.branch, 'feature/login');
    assert.equal(h.base.ref, 'main');
    assert.deepEqual([h.base.ahead, h.base.behind], [2, 1]);
    assert.equal(h.recent, false);
    assert.deepEqual(h.commits.map((c) => c.subject), ['add logout', 'add login']);
    assert.equal(h.commits[0].comment, 'Logout still needs a test.');
    assert.deepEqual(h.uncommitted, [{ status: '??', file: 'wip.txt' }]);
    assert.ok(h.reflog.length >= 2);

    // Found by path too, and the default is the worktree you are in.
    assert.equal(worktreeHistory(root, wt).branch, 'feature/login');
    assert.equal(worktreeHistory(root, undefined, { cwd: wt }).branch, 'feature/login');

    const text = capture(history, ['show', 'feature/login'], root).out;
    assert.match(text, /Base {5}main at \w{10} \(2 ahead, 1 behind\)/);
    assert.match(text, /# Logout still needs a test\./);
    assert.match(text, /\?\? wip\.txt/);
    const list = capture(history, ['list'], root).out;
    assert.match(list, /^\. {2}main$/m);
    assert.match(list, /feature\/login {2}\[2 ahead of main, 1 uncommitted\]/);
  });

  it('shows recent commits on the base branch and honours --base and --limit', () => {
    const { root, commit } = repo();
    commit('a.txt', 'one');
    commit('b.txt', 'two');
    commit('c.txt', 'three');
    const onMain = worktreeHistory(root, 'main', { limit: 2 });
    assert.equal(onMain.recent, true);
    assert.deepEqual(onMain.commits.map((c) => c.subject), ['three', 'two']);
    const sinceFirst = worktreeHistory(root, undefined, { base: 'HEAD~2' });
    assert.deepEqual(sinceFirst.commits.map((c) => c.subject), ['three', 'two']);
    assert.equal(capture(history, ['show', '--base', 'nope'], root).code, 2);
    assert.match(capture(history, ['show', 'no-such-branch'], root).err, /no worktree matches no-such-branch/);
    assert.equal(capture(history, ['--limit', '0'], root).code, 2);
  });
});
