import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifyRisk, classifyTask, detectCommands, evaluate, findGaps } from './four-d.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'four-d.mjs');

function project(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'four-d-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const run = (prompt, files) => evaluate({ prompt }, { projectDir: project(files) });

describe('task classifier', () => {
  const cases = {
    'fix the failing test in hooks/naming.test.mjs': 'debugging',
    'the app crashes with TypeError: cannot read properties of undefined': 'debugging',
    'write unit tests for the guard hook': 'testing',
    'refactor the settings composer to extract the hook filter function': 'refactoring',
    'review my changes before I commit': 'code_review',
    'should we use postgres or mongodb for the event store? compare trade-offs': 'architecture',
    'add a dark mode toggle to the settings page': 'code_generation',
    'explain how graph.mjs builds the code graph': 'explanation',
    'how does the naming hook resolve conventions?': 'explanation',
    'deploy the api to production': 'operations',
    'drop the users table and recreate it': 'operations',
  };
  for (const [prompt, expected] of Object.entries(cases)) {
    it(`${expected}: ${prompt}`, () => assert.equal(classifyTask(prompt).category, expected));
  }

  it('returns no category for conversational prompts', () => {
    assert.equal(classifyTask('thanks, looks good').category, undefined);
  });
});

describe('risk classifier', () => {
  it('is independent of the task category', () => {
    const prompt = 'implement stripe checkout for subscriptions';
    assert.equal(classifyTask(prompt).category, 'code_generation');
    assert.deepEqual(classifyRisk(prompt, 'code_generation'), {
      level: 'high', reasons: ['payments'], signals: ['payments'],
    });
  });

  it('detects every high-risk signal', () => {
    const risk = classifyRisk('create a migration adding a tenant_id column', 'code_generation');
    assert.equal(risk.level, 'high');
    assert.deepEqual(risk.reasons, ['migrations', 'tenant isolation']);
  });

  it('escalates destructive and production work to critical', () => {
    assert.equal(classifyRisk('drop the users table', 'operations').level, 'critical');
    assert.equal(classifyRisk('deploy to prod', 'operations').level, 'critical');
    assert.equal(classifyRisk('add the stripe api key to the config', 'code_generation').level, 'critical');
  });

  it('lowers documentation work and caps read-only questions', () => {
    assert.equal(classifyRisk('update the README for the new hook', 'code_generation').level, 'low');
    assert.equal(classifyRisk('explain how oauth login works here', 'explanation').level, 'medium');
  });
});

describe('description gaps', () => {
  it('asks for evidence when a bug report has none', () => {
    assert.equal(findGaps('fix the login bug', 'debugging').length, 1);
    assert.deepEqual(findGaps('fix this: Error: ECONNREFUSED at db.connect', 'debugging'), []);
  });

  it('asks for acceptance criteria and location on generation', () => {
    assert.equal(findGaps('add dark mode', 'code_generation').length, 2);
    assert.deepEqual(
      findGaps('add dark mode to `src/theme.ts`; it should follow the OS setting', 'code_generation'),
      [],
    );
  });
});

describe('verification commands', () => {
  it('reads package.json scripts with the right package manager', () => {
    const root = project({
      'package.json': JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .' } }),
      'pnpm-lock.yaml': '',
      'tsconfig.json': '{}',
    });
    assert.deepEqual(detectCommands(root), {
      test: 'pnpm run test', lint: 'pnpm run lint', typecheck: 'npx tsc --noEmit',
    });
  });

  it('detects Go and Python projects', () => {
    assert.equal(detectCommands(project({ 'go.mod': 'module x' })).test, 'go test ./...');
    assert.equal(detectCommands(project({ 'pyproject.toml': '[tool.pytest]\n[tool.ruff]' })).lint, 'ruff check .');
  });
});

describe('evaluate', () => {
  it('injects all four dimensions with verification commands', () => {
    const { context } = run('fix the failing test in hooks/naming.test.mjs', {
      'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
    });
    assert.match(context, /^\[4D guardrails\] task: debugging/);
    for (const d of ['Delegation', 'Description', 'Discernment', 'Diligence']) {
      assert.match(context, new RegExp(`^${d} — `, 'm'));
    }
    assert.match(context, /Verify with: npm run test\./);
    assert.match(context, /regression test/);
    assert.match(context, /Missing: no error output/);
  });

  it('adds only the overlay lines whose risk signals fired', () => {
    const { context } = run('add a login endpoint with JWT sessions');
    assert.match(context, /risk: high \(authentication\)/);
    assert.match(context, /negative tests/);
    assert.doesNotMatch(context, /Migrations must be reversible/);
  });

  it('requires confirmation for critical operations', () => {
    const { context } = run('drop the users table on production');
    assert.match(context, /without explicit confirmation/);
  });

  it('does not suggest test commands for read-only tasks', () => {
    const { context } = run('explain how graph.mjs builds the code graph', {
      'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
    });
    assert.doesNotMatch(context, /Verify with/);
    assert.match(context, /Cite code evidence/);
  });

  it('stays silent on slash commands, short and unclassified prompts', () => {
    assert.deepEqual(run('/code-review high'), {});
    assert.deepEqual(run('yes do it'), {});
    assert.deepEqual(run('thanks, looks good'), {});
    assert.deepEqual(run(''), {});
  });

  it('honours .claude/four-d.json', () => {
    const config = (c) => ({ '.claude/four-d.json': JSON.stringify(c) });
    assert.deepEqual(run('fix the login bug please', config({ enabled: false })), {});
    assert.deepEqual(run('explain how graph.mjs works', config({ skip: ['explanation'] })), {});
    const { context } = run('fix the failing parser test', config({
      commands: { test: 'make check' },
      rules: { '*': ['Update CHANGELOG.md.'], debugging: ['Attach the failing input.'] },
    }));
    assert.match(context, /Verify with: make check\./);
    assert.match(context, /Update CHANGELOG\.md\. Attach the failing input\./);
  });
});

describe('hook process', () => {
  const exec = (input) => execFileSync('node', [HOOK], { input, encoding: 'utf8' });

  it('prints UserPromptSubmit additionalContext JSON', () => {
    const out = JSON.parse(exec(JSON.stringify({ prompt: 'write unit tests for the parser', cwd: project() })));
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(out.hookSpecificOutput.additionalContext, /task: testing/);
  });

  it('prints nothing and exits 0 on bad input', () => {
    assert.equal(exec('not json'), '');
  });

  it('does not show or log the block unless configured', () => {
    const cwd = project();
    const out = JSON.parse(exec(JSON.stringify({ prompt: 'write unit tests for the parser', cwd })));
    assert.equal(out.systemMessage, undefined);
    assert.equal(existsSync(join(cwd, '.claude', 'four-d.log')), false);
  });

  it('shows the injected block to the user with "show": true', () => {
    const cwd = project({ '.claude/four-d.json': JSON.stringify({ show: true }) });
    const out = JSON.parse(exec(JSON.stringify({ prompt: 'write unit tests for the parser', cwd })));
    assert.equal(out.systemMessage, out.hookSpecificOutput.additionalContext);
  });

  it('appends each injected block to .claude/four-d.log with "log": true', () => {
    const cwd = project({ '.claude/four-d.json': JSON.stringify({ log: true }) });
    exec(JSON.stringify({ prompt: 'write unit tests for the parser', cwd, session_id: 's1' }));
    exec(JSON.stringify({ prompt: 'fix the login bug please', cwd, session_id: 's1' }));
    exec(JSON.stringify({ prompt: 'yes', cwd, session_id: 's1' }));
    const log = readFileSync(join(cwd, '.claude', 'four-d.log'), 'utf8');
    assert.equal(log.match(/^=== /gm).length, 2, 'one entry per injection, none for silent prompts');
    assert.match(log, /^=== \d{4}-\d\d-\d\dT[^ ]+ · session s1\nprompt: write unit tests for the parser\n\[4D guardrails\] task: testing/m);
    assert.match(log, /prompt: fix the login bug please\n\[4D guardrails\] task: debugging/);
  });
});
