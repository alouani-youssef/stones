import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { evaluate } from './access_guard.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'access-guard-')));
// The project itself lives in tmp here, so use a project dir outside tmp for
// the "outside the root" cases.
const project = join(homedir(), 'stones-access-guard-project');

const bash = (command, projectDir = project) =>
  evaluate({ tool_name: 'Bash', tool_input: { command }, cwd: projectDir }, { projectDir });
const tool = (tool_name, tool_input, projectDir = project) =>
  evaluate({ tool_name, tool_input, cwd: projectDir }, { projectDir });

describe('access guard', () => {
  it('allows device files and temp dirs in shell redirections and arguments', () => {
    for (const command of [
      'ls 2>/dev/null',
      'npm test > /dev/null 2>&1',
      'git log | head -5 > /tmp/log.txt',
      `cat ${join(tmpdir(), 'scratch.txt')}`,
      'echo hi >/dev/stderr',
      'diff <(sort a) /dev/fd/63',
    ]) {
      assert.equal(bash(command).block, false, command);
    }
  });

  it('allows tools to read and write temp files', () => {
    assert.equal(tool('Write', { file_path: join(tmpdir(), 'notes.md') }).block, false);
    assert.equal(tool('Read', { file_path: '/tmp/out.log' }).block, false);
  });

  it('still blocks paths outside the project root', () => {
    assert.match(bash('cat ~/.ssh/id_rsa').reason, /outside the project root/);
    assert.match(bash('cat "$HOME/.ssh/id_rsa"').reason, /outside the project root/);
    assert.match(bash('cat ${HOME}/.aws/credentials').reason, /outside the project root/);
    assert.match(bash('cat /etc/passwd').reason, /outside the project root/);
    assert.match(bash('cat ../other/file').reason, /outside the project root/);
    assert.match(tool('Read', { file_path: '/etc/hosts' }).reason, /outside the project root/);
  });

  it('blocks secrets, in any case, but not .env.example', () => {
    assert.match(bash('cat .env', root).reason, /secret or private/);
    assert.match(bash('cat .ENV.local', root).reason, /secret or private/);
    assert.match(tool('Read', { file_path: join(root, '.Env') }, root).reason, /secret or private/);
    assert.equal(bash('cat .env.example', root).block, false);
    assert.match(bash('cat /tmp/.env').reason, /secret or private/, 'temp files are still checked for secrets');
  });

  it('finds secrets and outside paths however the shell spells them', () => {
    const secret = (command) => bash(command, root).reason ?? '';
    for (const command of [
      'cat .env',
      'cat ./.env',
      "cat '.env'",
      'cat "src/.env.local"',
      'cat .env*',
      'cat < .env',
      'cat <.env',
      'echo x && cat .env',
      'ls; cat .env',
      'true | cat .env',
      '(cat .env)',
      'echo `cat .env`',
      'echo $(cat .env)',
      'bash -c "cat .env"',
      'sh -c \'cat .env\'',
      'eval cat .env',
      'FOO=.env node x.js',
      'cat private/keys.txt',
      'cat "unterminated .env',
    ]) {
      assert.match(secret(command), /secret or private/, command);
    }
    for (const command of ['cat </etc/passwd', '(cat /etc/passwd)', 'echo $(cat /etc/shadow)', 'sudo cat /etc/passwd', 'timeout 5 cat /etc/passwd']) {
      assert.match(bash(command).reason ?? '', /outside the project root/, command);
    }
  });

  it('ignores secrets mentioned only in comments and heredoc bodies', () => {
    assert.equal(bash('ls # not .env', root).block, false);
    assert.equal(bash("cat > notes.md <<'EOF'\nnever read .env\nEOF\nls", root).block, false);
    assert.equal(bash('echo "a\\"b" src/app.js', root).block, false);
  });

  it('blocks git push in its different spellings', () => {
    for (const command of ['git push', 'git -C . push origin main', 'bash -c "git push"', 'FOO=1 git push']) {
      assert.equal(bash(command).block, true, command);
    }
    assert.equal(bash('git status').block, false);
  });
});
