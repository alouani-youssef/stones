import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluate } from './testing.mjs';

const note = ({
  behavior = 'Invalid tokens return an authentication error.',
  scenario = '- Scenario: an expired token is submitted. Expected: the API returns 401.',
  contractChange = 'none',
} = {}) => `## Expected behavior\n${behavior}\n\n## Scenarios\n${scenario}\n\n## Contract change\n${contractChange}\n`;

function project(activeNote) {
  const root = mkdtempSync(join(tmpdir(), 'testing-hook-'));
  if (activeNote !== undefined) {
    const file = join(root, 'context/tasks/active.md');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, activeNote);
  }
  return root;
}

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const edit = (file_path) => ({ tool_name: 'Edit', tool_input: { file_path } });

describe('testing hook', () => {
  it('blocks a test run when the active task note is missing', () => {
    const result = evaluate(bash('npm test'), { projectDir: project() });
    assert.equal(result.block, true);
    assert.match(result.reason, /context\/tasks\/active\.md/);
  });

  it('blocks a test run when a scenario has no expected outcome', () => {
    const result = evaluate(bash('pnpm test'), {
      projectDir: project(note({ scenario: '- Scenario: token is expired.' })),
    });
    assert.equal(result.block, true);
    assert.match(result.reason, /scenario.*expected/i);
  });

  it('blocks the starter template until its placeholders are replaced', () => {
    const template = note({
      behavior: 'TODO: describe expected behavior',
      scenario: '- Scenario: TODO. Expected: TODO.',
    });
    const result = evaluate(bash('npm test'), { projectDir: project(template) });
    assert.equal(result.block, true);
  });

  it('allows test runs with expected behavior, a concrete scenario, and an explicit contract status', () => {
    const result = evaluate(bash('node --test hooks/testing.test.mjs'), {
      projectDir: project(note()),
    });
    assert.deepEqual(result, { block: false });
  });

  it('detects test commands inside a compound shell command', () => {
    const result = evaluate(bash('git status && npm run test:hooks'), {
      projectDir: project(),
    });
    assert.equal(result.block, true);
  });

  it('detects common runner and monorepo test commands', () => {
    const root = project();
    for (const command of [
      'npx jest',
      'pnpm exec vitest run',
      'npx nx test api',
      'turbo run test',
      'npm --workspace api test',
      'pnpm --filter api test',
      'yarn workspace api test',
    ]) {
      const result = evaluate(bash(command), { projectDir: root });
      assert.equal(result.block, true, command);
    }
  });

  it('blocks spec and test edits without a contract-change rationale', () => {
    const root = project(note());
    for (const file of [
      'src/auth/auth.spec.ts',
      'tests/authentication.test.ts',
      'openspec/specs/authentication/spec.md',
      'openspec/changes/auth-expiry/specs/authentication/spec.md',
      'src/components/__snapshots__/button.test.tsx.snap',
      'src/components/button.snap',
    ]) {
      const result = evaluate(edit(file), { projectDir: root });
      assert.equal(result.block, true, file);
      assert.match(result.reason, /contract change/i, file);
    }
  });

  it('blocks shell redirection that would modify a test file', () => {
    const result = evaluate(bash('cat > tests/authentication.test.ts'), {
      projectDir: project(note()),
    });
    assert.equal(result.block, true);
    assert.match(result.reason, /do not edit/i);
  });

  it('allows spec and test edits when an expected behavior change is explained', () => {
    const root = project(note({ contractChange: 'behavior changed: expired tokens must now return 403.' }));
    assert.deepEqual(evaluate(edit('tests/authentication.test.ts'), { projectDir: root }), { block: false });
    assert.deepEqual(evaluate(edit('openspec/specs/authentication/spec.md'), { projectDir: root }), { block: false });
  });

  it('does not block ordinary source edits or unrelated shell commands', () => {
    const root = project();
    assert.deepEqual(evaluate(edit('src/auth/session.ts'), { projectDir: root }), { block: false });
    assert.deepEqual(evaluate(bash('git status --short'), { projectDir: root }), { block: false });
    assert.deepEqual(evaluate(bash('test -f src/auth/session.ts'), { projectDir: root }), { block: false });
  });

  it('exits with a clear block reason when invoked as a Claude Code hook', () => {
    const root = project();
    const script = fileURLToPath(new URL('./testing.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script], {
      input: JSON.stringify(bash('npm test')),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Create context\/tasks\/active\.md/);
  });
});
