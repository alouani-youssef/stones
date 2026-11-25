import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluate, specFor } from './assumptions.mjs';

const SPEC = 'docs/superpowers/specs/2026-11-25-limits-design.md';
const PLAN = 'docs/superpowers/plans/2026-11-25-limits.md';
const spec = (...lines) => `# Login limits\n\n## Assumptions\n\n${lines.join('\n')}\n\n## Test Strategy\n\nUnit tests.\n`;

function project(files = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stones-assume-')));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const writePlan = (root, content = `# Plan\n\nSpec: ${SPEC}\n`, file = PLAN) =>
  evaluate({ tool_name: 'Write', tool_input: { file_path: join(root, file), content } }, { projectDir: root });

describe('assumptions hook', () => {
  it('blocks a plan while an assumption is open or a denial has no decision', () => {
    const open = writePlan(project({ [SPEC]: spec('- A1: Per IP. Status: confirmed', '- A2: Lock accounts after 5 failures. Status: open') }));
    assert.equal(open.block, true);
    assert.match(open.reason, /A2 is still open: ask the user to confirm or deny "Lock accounts after 5 failures\."/);
    assert.match(open.reason, /AskUserQuestion/);
    const unstated = writePlan(project({ [SPEC]: spec('- A1: Lock accounts after 5 failures.') }));
    assert.match(unstated.reason, /A1 is still open/, 'no Status means open');
    const denied = writePlan(project({ [SPEC]: spec('- A1: Lock accounts. Status: denied') }));
    assert.match(denied.reason, /A1 was denied: record what the user decided instead/);
  });

  it('blocks a plan whose spec has no assumptions section, or no spec at all', () => {
    assert.match(writePlan(project({ [SPEC]: '# Login limits\n\nNo section.\n' })).reason, /add a ## Assumptions section/);
    assert.match(writePlan(project({ [SPEC]: spec() })).reason, /## Assumptions is empty/);
    assert.match(writePlan(project(), '# Plan\n').reason, /Write the spec under docs\/superpowers\/specs\/ before the plan/);
  });

  it('allows the plan once every assumption is confirmed or denied with a decision', () => {
    const root = project({ [SPEC]: spec('- A1: Per IP. Status: confirmed', '- A2: Lock accounts. Status: denied: never lock; return 429') });
    assert.equal(writePlan(root).block, false);
    assert.equal(evaluate({ tool_name: 'Edit', tool_input: { file_path: join(root, PLAN), new_string: 'step' } }, { projectDir: root }).block, false);
  });

  it('only guards Markdown plans under docs/superpowers/plans', () => {
    const root = project({ [SPEC]: spec('- A1: Lock. Status: open') });
    assert.equal(writePlan(root, 'x', 'src/plan.md').block, false);
    assert.equal(writePlan(root, 'x', 'docs/superpowers/specs/other.md').block, false);
    assert.equal(writePlan(root, 'x', 'docs/superpowers/plans/notes.txt').block, false);
    assert.equal(evaluate({ tool_name: 'Read', tool_input: { file_path: join(root, PLAN) } }, { projectDir: root }).block, false);
  });

  it('finds the spec from the plan link, then the current task, then the newest spec', () => {
    const older = 'docs/superpowers/specs/2026-11-01-old-design.md';
    const root = project({ [SPEC]: spec('- A1: x. Status: confirmed'), [older]: spec('- A1: y. Status: open') });
    utimesSync(join(root, older), new Date(2000, 0, 1), new Date(2000, 0, 1));
    assert.equal(specFor(root, `see ${older}`), older);
    assert.equal(specFor(root, '# Plan'), SPEC, 'newest spec');
    mkdirSync(join(root, 'context/tasks/list'), { recursive: true });
    writeFileSync(join(root, 'context/tasks/list/0001-a.md'), `# A\n\nStatus: current\n\n## Spec and plan\n\nSpec: ${older}\n`);
    assert.equal(specFor(root, '# Plan'), older, 'current task spec');
    assert.equal(writePlan(root, '# Plan\n').block, true);
  });

  it('exits 2 with the reason from the hook process', () => {
    const root = project({ [SPEC]: spec('- A1: Lock. Status: open') });
    const hook = fileURLToPath(new URL('./assumptions.mjs', import.meta.url));
    const event = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(root, PLAN), content: SPEC } });
    const r = spawnSync('node', [hook], { input: event, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Not ready to plan/);
    assert.equal(spawnSync('node', [hook], { input: 'not json', encoding: 'utf8' }).status, 0);
  });
});
