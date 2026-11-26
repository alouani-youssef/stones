import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { configuredCommands, SPECS_COMMAND } from './quality-check.mjs';
import { main, mapPaths, openspecCommand, parseArgs } from './validate-specs.mjs';

function project(files = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stones-specs-')));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

// Stands in for the OpenSpec CLI: prints its args and the staged tree, names
// a staged file the way OpenSpec does, and fails when a spec says BAD.
function fakeOpenspec() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'stones-fake-openspec-')));
  const bin = join(dir, 'openspec');
  writeFileSync(bin, `#!/usr/bin/env node
const { readdirSync, readFileSync, statSync } = require('node:fs');
const { join, relative } = require('node:path');
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const files = walk(join(process.cwd(), 'openspec')).map((f) => relative(process.cwd(), f)).sort();
console.log('args: ' + process.argv.slice(2).join(' '));
console.log('telemetry: ' + process.env.OPENSPEC_TELEMETRY);
for (const f of files) console.log('staged=' + f);
const bad = files.filter((f) => f.endsWith('spec.md') && readFileSync(f, 'utf8').includes('BAD'));
for (const f of bad) console.log('✗ ' + join(process.cwd(), f) + ' — run openspec validate x --type spec');
process.exit(bad.length ? 1 : 0);
`);
  chmodSync(bin, 0o755);
  return bin;
}

const SPECS = {
  'docs/specs/auth/spec.md': '# auth\n',
  'docs/specs/auth/files.md': '- `src/auth/` — Login.\n',
  'docs/specs/changes/add-mfa/proposal.md': '## Why\n',
  'docs/specs/changes/add-mfa/specs/auth/spec.md': '## ADDED Requirements\n',
};

function run(root, argv, env = {}) {
  const out = [];
  const err = [];
  const code = main(argv, {
    cwd: root,
    out: { write: (s) => out.push(s) },
    err: { write: (s) => err.push(s) },
    env: { ...process.env, ...env },
  });
  return { code, out: out.join(''), err: err.join('') };
}

describe('validate-specs', () => {
  it('stages docs/specs as an OpenSpec root, keeping changes out of the specs', () => {
    const root = project(SPECS);
    const r = run(root, [], { OPENSPEC_BIN: fakeOpenspec() });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^args: validate --all --no-interactive --strict$/m);
    assert.match(r.out, /^telemetry: 0$/m);
    const staged = r.out.split('\n').filter((l) => l.startsWith('staged=')).map((l) => l.slice(7));
    assert.deepEqual(staged, [
      'openspec/changes/add-mfa/proposal.md',
      'openspec/changes/add-mfa/specs/auth/spec.md',
      'openspec/specs/auth/files.md',
      'openspec/specs/auth/spec.md',
    ]);
  });

  it('passes the failure through with paths and hints pointing at docs/specs', () => {
    const root = project({ ...SPECS, 'docs/specs/billing/spec.md': 'BAD\n' });
    const r = run(root, ['billing', '--type', 'spec', '--json'], { OPENSPEC_BIN: fakeOpenspec() });
    assert.equal(r.code, 1);
    assert.match(r.out, /^args: validate billing --no-interactive --type spec --strict --json$/m);
    assert.match(r.out, /^✗ docs\/specs\/billing\/spec\.md — run node \.claude\/tools\/validate-specs\.mjs x --type spec$/m);
    assert.doesNotMatch(r.out, /stones-openspec-/);
  });

  it('removes the staged copy and leaves the project as it was', () => {
    const root = project(SPECS);
    run(root, [], { OPENSPEC_BIN: fakeOpenspec() });
    assert.equal(existsSync(join(root, 'openspec')), false);
    assert.deepEqual(readdirSync(join(root, 'docs/specs')).sort(), ['auth', 'changes']);
  });

  it('has nothing to validate without docs/specs', () => {
    const r = run(project(), [], { OPENSPEC_BIN: '/nonexistent/openspec' });
    assert.equal(r.code, 0);
    assert.match(r.out, /nothing to validate/);
  });

  it('rejects unknown options and types', () => {
    const root = project(SPECS);
    assert.equal(run(root, ['--nope']).code, 2);
    assert.match(run(root, ['auth', '--type', 'x']).err, /--type needs spec or change/);
    assert.deepEqual(parseArgs(['--changes', '--no-strict']), { item: undefined, type: undefined, scope: '--changes', json: false, strict: false, help: false });
  });

  it('prefers OPENSPEC_BIN, then node_modules/.bin, then a pinned npx', () => {
    const root = project({ 'node_modules/.bin/openspec': '' });
    assert.deepEqual(openspecCommand(root, { OPENSPEC_BIN: '/x/openspec' }), ['/x/openspec']);
    assert.deepEqual(openspecCommand(root, {}), [join(root, 'node_modules/.bin/openspec')]);
  });

  it('maps relative openspec paths too', () => {
    assert.equal(mapPaths('see openspec/specs/a/spec.md and openspec/changes/b/', []), 'see docs/specs/a/spec.md and docs/specs/changes/b/');
  });
});

describe('quality-check specs step', () => {
  it('validates docs/specs when the project has specs and the tool', () => {
    const root = project({ 'docs/specs/auth/spec.md': '# auth\n', '.claude/tools/validate-specs.mjs': '' });
    assert.equal(configuredCommands(root).specs, SPECS_COMMAND);
    assert.equal(configuredCommands(project({ '.claude/tools/validate-specs.mjs': '' })).specs, undefined);
    const custom = project({
      'docs/specs/auth/spec.md': '',
      '.claude/tools/validate-specs.mjs': '',
      '.claude/stones.json': JSON.stringify({ answers: { workflow: { commands: { specs: 'make specs' } } } }),
    });
    assert.equal(configuredCommands(custom).specs, 'make specs');
  });
});
