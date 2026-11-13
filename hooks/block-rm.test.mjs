import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'block-rm.sh');
const hasJq = spawnSync('jq', ['--version']).status === 0;
const blocked = (command) =>
  spawnSync('bash', [HOOK], { input: JSON.stringify({ tool_input: { command } }) }).status === 2;

describe('block-rm hook', { skip: hasJq ? false : 'needs jq' }, () => {
  it('blocks rm wherever it runs in the command', () => {
    for (const command of [
      'rm -rf build',
      '  rm file',
      'cd sub && rm -rf x',
      'make; rm out',
      'ls | xargs rm',
      'sudo rm -rf /var/x',
      '/bin/rm file',
      'echo $(rm a)',
      'find . -name "*.log" -delete',
    ]) {
      assert.equal(blocked(command), true, command);
    }
  });

  it('allows commands that only look like rm', () => {
    for (const command of ['rmdir empty', 'git rm --cached file', 'npm run rm-cache', 'echo "rm is blocked"', 'ls -la']) {
      assert.equal(blocked(command), false, command);
    }
  });
});
