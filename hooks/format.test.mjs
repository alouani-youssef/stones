import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'format.mjs');

// A project with fake formatters on PATH that log how they were called.
function project(tools) {
  const root = mkdtempSync(join(tmpdir(), 'format-hook-'));
  const bin = join(root, 'fake-bin');
  mkdirSync(bin);
  for (const tool of tools) {
    const file = join(bin, tool);
    writeFileSync(file, `#!/bin/sh\necho "${tool} $*" >> "${join(root, 'calls.log')}"\n`);
    chmodSync(file, 0o755);
  }
  return { root, bin };
}

function edit({ root, bin }, file) {
  writeFileSync(join(root, file), 'x = 1\n');
  spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: join(root, file) } }),
    env: { ...process.env, PATH: bin, CLAUDE_PROJECT_DIR: root },
  });
  const log = join(root, 'calls.log');
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
}

describe('format hook', () => {
  it('formats Python with ruff format only, never ruff check --fix', () => {
    const calls = edit(project(['ruff']), 'app.py');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^ruff format /);
  });

  it('formats Go with gofmt, without goimports dropping imports between edits', () => {
    const calls = edit(project(['gofmt', 'goimports']), 'main.go');
    assert.deepEqual(calls.map((c) => c.split(' ')[0]), ['gofmt']);
  });

  it('falls back to black when ruff is missing', () => {
    const calls = edit(project(['black']), 'app.py');
    assert.match(calls[0], /^black --quiet /);
  });
});
