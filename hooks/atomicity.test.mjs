import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULTS, globToRegExp, loadConfig, pathClass } from './atomicity.mjs';

const withConfig = (json) => {
  const root = mkdtempSync(join(tmpdir(), 'atomicity-'));
  if (json !== undefined) {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude/atomicity.json'), typeof json === 'string' ? json : JSON.stringify(json));
  }
  return root;
};

describe('globToRegExp', () => {
  it('supports **, * and ?', () => {
    assert.ok(globToRegExp('**/migrations/**').test('migrations/001.sql'));
    assert.ok(globToRegExp('**/migrations/**').test('a/b/migrations/c/001.sql'));
    assert.ok(globToRegExp('*.sql').test('a.sql'));
    assert.ok(!globToRegExp('*.sql').test('d/a.sql'));
    assert.ok(globToRegExp('a?.ts').test('ab.ts'));
    assert.ok(!globToRegExp('a?.ts').test('a/.ts'));
  });
});

describe('loadConfig', () => {
  it('returns defaults without a file or with invalid JSON', () => {
    assert.deepEqual(loadConfig(withConfig()), DEFAULTS);
    assert.deepEqual(loadConfig(withConfig('{nope')), DEFAULTS);
  });

  it('deep-merges user values over defaults and keeps unknown keys', () => {
    const c = loadConfig(withConfig({ defaultBranch: 'trunk', custom: 1, prefixes: { db: 'database/' } }));
    assert.equal(c.defaultBranch, 'trunk');
    assert.equal(c.custom, 1);
    assert.equal(c.prefixes.db, 'database/');
    assert.equal(c.prefixes.packages, 'deps/');
    assert.equal(c.zones.network.incoming, false);
    assert.equal(c.migrations.allowEdits, false);
  });
});

describe('pathClass', () => {
  const cls = (f, c = DEFAULTS) => pathClass(f, c);

  it('classifies db paths', () => {
    for (const f of ['prisma/migrations/2024_x/migration.sql', 'alembic/versions/a1.py', 'app/models.py', 'src/order.entity.ts', 'db/schema.rb'])
      assert.equal(cls(f), 'db', f);
  });

  it('classifies packages and manifests', () => {
    for (const f of ['pnpm-lock.yaml', 'go.sum', 'requirements-dev.txt']) assert.equal(cls(f), 'packages', f);
    assert.equal(cls('package.json'), 'manifest');
  });

  it('classifies network, neutral and code', () => {
    assert.equal(cls('.mcp.json'), 'network');
    for (const f of ['src/api.test.ts', 'tests/x.py', '__mocks__/s.ts', '.claude/danger/db--x.md', 'README.md'])
      assert.equal(cls(f), 'neutral', f);
    assert.equal(cls('src/index.ts'), 'code');
  });

  it('applies precedence', () => {
    assert.equal(cls('tests/migrations/001.sql'), 'db');
  });

  it('honours config extraPaths and paths', () => {
    const extra = loadConfig(withConfig({ zones: { db: { extraPaths: ['sql/**'] } } }));
    assert.equal(cls('sql/a.sql', extra), 'db');
    const only = loadConfig(withConfig({ zones: { db: { paths: ['only/**'] } } }));
    assert.equal(cls('prisma/migrations/x.sql', only), 'code');
    assert.equal(cls('only/x.txt', only), 'db');
  });
});
