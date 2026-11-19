import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { evaluate, gatedAction } from '../hooks/workflows.mjs';
import { actArgs, fingerprint, formatPlan, main, parseActList, parseArgs, planRun, RUN_FILE, runStatus } from './workflows.mjs';

const ACT_LIST = `Stage  Job ID     Job name                     Workflow name   Workflow file      Events
0      checks     Repository checks            CI              ci.yml             push,pull_request,workflow_dispatch
0      test       Tests (\${{ matrix.os }})     CI              ci.yml             push,pull_request,workflow_dispatch
1      ci-ok      CI passed                    CI              ci.yml             push,pull_request,workflow_dispatch
0      ci         ci                           Release         release.yml        push
1      publish    Publish to npm               Release         release.yml        push
`;

function repo({ workflows = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stones-workflows-')));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  if (workflows) {
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    writeFileSync(join(root, '.github/workflows/ci.yml'), 'on: pull_request\n');
  }
  writeFileSync(join(root, '.gitignore'), '.claude/workflows-run.json\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return { root, git };
}

const record = (root, extra) => {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, RUN_FILE), JSON.stringify({ at: 'now', passed: true, workflows: ['ci.yml'], ...extra }));
};

describe('workflows tool', () => {
  it('parses act -l, keeping job names that contain spaces', () => {
    const jobs = parseActList(`level=info msg="noise"\n${ACT_LIST}`);
    assert.equal(jobs.length, 5);
    assert.deepEqual(jobs[1], { stage: 0, job: 'test', name: 'Tests (${{ matrix.os }})', workflow: 'CI', file: 'ci.yml', events: ['push', 'pull_request', 'workflow_dispatch'] });
  });

  it('plans the pull-request workflows by default and leaves push-only releases out', () => {
    const plan = planRun(parseActList(ACT_LIST));
    assert.deepEqual(plan, [{ file: 'ci.yml', event: 'pull_request', jobs: ['checks', 'test', 'ci-ok'] }]);
    assert.match(formatPlan(plan), /\.github\/workflows\/ci\.yml {2}event=pull_request/);
  });

  it('runs a named workflow or job only when asked, and rejects unknown ones', () => {
    const jobs = parseActList(ACT_LIST);
    assert.deepEqual(planRun(jobs, { workflows: ['.github/workflows/release.yml'] }), [{ file: 'release.yml', event: 'push', jobs: ['ci', 'publish'] }]);
    assert.deepEqual(planRun(jobs, { job: 'checks' }), [{ file: 'ci.yml', event: 'pull_request', jobs: ['checks'] }]);
    assert.throws(() => planRun(jobs, { workflows: ['nope.yml'] }), /Unknown workflow: nope\.yml/);
    assert.throws(() => planRun(jobs, { job: 'nope' }), /No job "nope"/);
  });

  it('passes secrets to act without echoing them in the plan', () => {
    const { opts } = parseArgs(['run', '--secret', 'GITHUB_TOKEN', '-s', 'NPM_TOKEN=x', '--secret-file', '.secrets.local']);
    const args = actArgs('/repo', { event: 'pull_request', file: 'ci.yml' }, undefined, opts);
    assert.deepEqual(args.slice(0, 9), ['pull_request', '-W', '.github/workflows/ci.yml', '-s', 'GITHUB_TOKEN', '-s', 'NPM_TOKEN=x', '--secret-file', '.secrets.local']);
    assert.doesNotMatch(formatPlan([{ file: 'ci.yml', event: 'pull_request', jobs: ['t'] }]), /NPM_TOKEN/);
  });

  it('counts a run only for the exact code state it covered', () => {
    const { root } = repo();
    assert.match(runStatus(root).reason, /no local workflow run/);
    record(root, fingerprint(root));
    assert.equal(runStatus(root).ok, true);
    writeFileSync(join(root, 'new.txt'), 'change\n');
    assert.match(runStatus(root).reason, /code changed/);
  });

  it('never treats a failed or partial run as a pass', () => {
    const { root } = repo();
    record(root, { ...fingerprint(root), passed: false });
    assert.match(runStatus(root).reason, /last local run failed/);
  });

  it('does nothing in a project without workflows', async () => {
    const { root } = repo({ workflows: false });
    assert.equal(await main(['run', '--yes'], root), 0);
  });
});

describe('workflows hook', () => {
  it('recognises merges and publishes', () => {
    for (const command of [
      ['gh', 'pr', 'merge', '12'],
      ['npm', 'publish'],
      ['FOO=1', 'pnpm', 'publish'],
      ['yarn', 'npm', 'publish'],
      ['cargo', 'publish'],
      ['twine', 'upload', 'dist/*'],
      ['gh', 'release', 'create', 'v1.0.0'],
      ['git', 'push', '--follow-tags'],
      ['git', 'push', 'origin', 'v1.2.3'],
    ]) {
      assert.ok(gatedAction(command), command.join(' '));
    }
    assert.equal(gatedAction(['git', 'merge', 'main'], { branch: 'feature/x' }), null, 'merging main into a branch is fine');
    assert.match(gatedAction(['git', '-C', '.', 'merge', 'feature/x'], { branch: 'main' }), /merge into main/);
    assert.equal(gatedAction(['git', 'merge', '--abort'], { branch: 'main' }), null);
    for (const command of [['git', 'push'], ['npm', 'test'], ['gh', 'pr', 'view']]) assert.equal(gatedAction(command), null);
  });

  it('blocks a merge until the workflows pass locally, then allows it', () => {
    const { root } = repo();
    const merge = { tool_name: 'Bash', tool_input: { command: 'git status && gh pr merge 3 --squash' }, cwd: root };
    const blocked = evaluate(merge, { projectDir: root });
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /workflows\.mjs list/);
    assert.match(blocked.reason, /confirm.*run --yes/s);
    record(root, fingerprint(root));
    assert.equal(evaluate(merge, { projectDir: root }).block, false);
  });

  it('never gates projects without workflows, or other tools', () => {
    const { root } = repo({ workflows: false });
    assert.equal(evaluate({ tool_name: 'Bash', tool_input: { command: 'npm publish' }, cwd: root }, { projectDir: root }).block, false);
    assert.equal(evaluate({ tool_name: 'Write', tool_input: { file_path: 'x' }, cwd: root }, { projectDir: root }).block, false);
  });
});
