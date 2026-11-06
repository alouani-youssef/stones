import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { build, indexFile, mermaid, onRead, onUpdate, readSpecs } from './graph.mjs';

function project(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'graph-'));
  put(root, files);
  return root;
}

function put(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

const AUTH_SPEC = '# auth Specification\n\n## Purpose\nLets users sign in and stay signed in.\n\n## Requirements\n';

const app = () =>
  project({
    'src/auth/session.ts':
      "// Session lifecycle.\nimport { db } from '../db/client.js';\nimport { SignJWT } from 'jose';\n" +
      'export function createSession() {}\nexport const validateSession = () => {};\n',
    'src/db/client.ts': 'export const db = {};\n',
    'src/api/login.ts': "import { createSession } from '../auth/session';\n",
    'src/auth/token.ts': 'export type Token = string;\n',
    'openspec/specs/auth/spec.md': AUTH_SPEC,
    'openspec/specs/auth/files.md':
      '# Files\n\n- `src/auth/session.ts` — Creates and validates user sessions.\n- `src/auth/` — Login, sessions and tokens.\n',
  });

describe('indexing', () => {
  it('extracts imports, packages, exports and header from TypeScript', () => {
    const node = indexFile(app(), 'src/auth/session.ts');
    assert.deepEqual(node.imports, ['src/db/client.ts']);
    assert.deepEqual(node.packages, ['jose']);
    assert.deepEqual(node.exports, ['createSession', 'validateSession']);
    assert.equal(node.header, 'Session lifecycle.');
  });

  it('extracts relative and absolute imports from Python', () => {
    const root = project({
      'pkg/__init__.py': '',
      'pkg/models.py': 'class User: ...\n',
      'pkg/service.py': '"""User service."""\nfrom .models import User\nimport requests\n\ndef get_user(): ...\ndef _private(): ...\n',
    });
    const node = indexFile(root, 'pkg/service.py');
    assert.deepEqual(node.imports, ['pkg/models.py']);
    assert.deepEqual(node.packages, ['requests']);
    assert.deepEqual(node.exports, ['get_user']);
    assert.equal(node.header, 'User service.');
  });

  it('reads capabilities and file summaries from OpenSpec', () => {
    const specs = readSpecs(app());
    assert.equal(specs.capabilities.auth.purpose, 'Lets users sign in and stay signed in.');
    assert.equal(specs.entries.length, 2);
  });
});

describe('on Read', () => {
  it('injects summary, capability, imports and dependents', () => {
    const context = onRead(app(), 'src/auth/session.ts');
    assert.match(context, /Capability: auth \(openspec\/specs\/auth\/spec\.md\) — Lets users sign in/);
    assert.match(context, /Summary: Creates and validates user sessions\./);
    assert.match(context, /Imports: src\/db\/client\.ts/);
    assert.match(context, /Used by: src\/api\/login\.ts/);
    assert.doesNotMatch(context, /No summary yet/);
  });

  it('falls back to a directory summary', () => {
    assert.match(onRead(app(), 'src/auth/token.ts'), /Summary \(of src\/auth\/\): Login/);
  });

  it('asks for a summary in the nearest capability when unmapped', () => {
    const root = app();
    put(root, { 'openspec/specs/billing/spec.md': '# billing\n', 'openspec/specs/billing/files.md': '- `src/billing/` — Billing.\n' });
    assert.match(onRead(root, 'src/db/client.ts'), /No summary yet: .* openspec\/specs\/<capability>\/files\.md \(capabilities: auth, billing\)/);
    put(root, { 'src/billing/invoice.ts': 'export const total = 0;\n' });
    assert.match(onRead(root, 'src/billing/invoice.ts'), /Summary \(of src\/billing\/\): Billing\./);
    put(root, { 'src/auth/mfa/totp.ts': 'export const verify = 0;\n' });
    assert.match(onRead(root, 'src/auth/mfa/totp.ts'), /Login, sessions and tokens/);
  });

  it('builds the graph on first read', () => {
    const root = app();
    onRead(root, 'src/db/client.ts');
    const graph = JSON.parse(readFileSync(join(root, '.claude/graph/project.json'), 'utf8'));
    assert.equal(graph.complete, true);
    assert.equal(Object.keys(graph.files).length, 4);
  });

  it('ignores non-code files', () => {
    assert.equal(onRead(app(), 'openspec/specs/auth/spec.md'), undefined);
  });
});

describe('on Write/Edit', () => {
  it('flags a summary as stale when exports change, until it is reworded', () => {
    const root = app();
    build(root);
    put(root, { 'src/auth/session.ts': 'export function createSession() {}\nexport function revoke() {}\n' });
    assert.match(onUpdate(root, 'src/auth/session.ts'), /changed its exports\/imports/);
    assert.match(onRead(root, 'src/auth/session.ts'), /Summary may be stale/);

    put(root, {
      'openspec/specs/auth/files.md': '- `src/auth/session.ts` — Creates and revokes sessions.\n',
    });
    onUpdate(root, 'openspec/specs/auth/files.md');
    assert.equal(onUpdate(root, 'src/auth/session.ts'), undefined);
  });

  it('does not nag about edits that keep the signature', () => {
    const root = app();
    build(root);
    put(root, { 'src/auth/session.ts': readFileSync(join(root, 'src/auth/session.ts'), 'utf8') + '\n// tweak\n' });
    assert.equal(onUpdate(root, 'src/auth/session.ts'), undefined);
  });

  it('nudges for a summary on a new unmapped file', () => {
    const root = app();
    put(root, { 'src/auth/mfa.ts': 'export const verify = () => {};\n' });
    assert.match(onUpdate(root, 'src/auth/mfa.ts'), /add "- `src\/auth\/mfa\.ts` — .*" to openspec\/specs\/auth\/files\.md/);
  });
});

describe('mermaid', () => {
  it('draws capability edges', () => {
    const root = app();
    build(root);
    const diagram = mermaid(root);
    assert.match(diagram, /^graph LR/);
    assert.match(diagram, /auth -->\|1\| unmapped/);
    assert.match(diagram, /unmapped -->\|1\| auth/);
  });
});
