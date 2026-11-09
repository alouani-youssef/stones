import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { listPackages, main, parseCargo, parseGoMod, parsePyproject, parseRequirements } from './list-packages.mjs';

function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'stones-packages-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

const names = (packages) => packages.map((p) => `${p.name}@${p.version}:${p.kind}`);

describe('list-packages', () => {
  it('lists npm packages per manifest, monorepo packages included, skipping node_modules', () => {
    const root = project({
      'package.json': { dependencies: { express: '^4.19.0' }, devDependencies: { vitest: '2.0.0' } },
      'packages/web/package.json': { dependencies: { react: '18.3.1' }, peerDependencies: { 'react-dom': '*' } },
      'node_modules/express/package.json': { dependencies: { debug: '2' } },
    });
    const result = listPackages(root);
    assert.deepEqual(result.map((m) => m.file), ['package.json', 'packages/web/package.json']);
    assert.deepEqual(names(result[0].packages), ['express@^4.19.0:prod', 'vitest@2.0.0:dev']);
    assert.deepEqual(names(result[1].packages), ['react@18.3.1:prod', 'react-dom@*:peer']);
  });

  it('reads PEP 621, dependency groups and Poetry tables from pyproject.toml', () => {
    const pkgs = parsePyproject(`
[project]
name = "api"
dependencies = [
  "fastapi>=0.115",  # web
  "uvicorn[standard]==0.30.0",
  "httpx; python_version >= '3.10'",
]

[project.optional-dependencies]
redis = ["redis>=5"]

[dependency-groups]
dev = ["pytest>=8", "ruff"]

[tool.poetry.dependencies]
python = "^3.12"
flask = "^3.1"
mylib = { git = "https://example.com/mylib.git" }

[tool.poetry.group.test.dependencies]
coverage = { version = "^7.0", extras = ["toml"] }
`);
    assert.deepEqual(names(pkgs), [
      'fastapi@>=0.115:prod', 'uvicorn@==0.30.0:prod', 'httpx@*:prod',
      'redis@>=5:optional', 'pytest@>=8:dev', 'ruff@*:dev',
      'flask@^3.1:prod', 'mylib@git:https://example.com/mylib.git:prod', 'coverage@^7.0:test',
    ]);
  });

  it('reads requirements files, treating dev/test files as dev', () => {
    assert.deepEqual(names(parseRequirements('# web\nflask==3.1.0\n-r base.txt\n\ngunicorn  # server\n')), ['flask@==3.1.0:prod', 'gunicorn@*:prod']);
    const root = project({ 'requirements.txt': 'flask\n', 'requirements-dev.txt': 'pytest\n' });
    const kinds = Object.fromEntries(listPackages(root).map((m) => [m.file, m.packages[0].kind]));
    assert.deepEqual(kinds, { 'requirements.txt': 'prod', 'requirements-dev.txt': 'dev' });
  });

  it('reads go.mod require lines and marks indirect ones', () => {
    const pkgs = parseGoMod('module example.com/api\n\ngo 1.24\n\nrequire github.com/google/uuid v1.6.0\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.10.0\n\tgolang.org/x/net v0.30.0 // indirect\n)\n');
    assert.deepEqual(names(pkgs), ['github.com/google/uuid@v1.6.0:prod', 'github.com/gin-gonic/gin@v1.10.0:prod', 'golang.org/x/net@v0.30.0:indirect']);
  });

  it('reads Cargo.toml dependency tables, target-specific ones included', () => {
    const pkgs = parseCargo(`
[package]
name = "cli"
version = "0.1.0"

[dependencies]
serde = { version = "1.0", features = ["derive"] }
anyhow = "1"
local = { path = "../local" }

[dev-dependencies]
insta = "1.40"

[target.'cfg(unix)'.dependencies]
nix = "0.29"
`);
    assert.deepEqual(names(pkgs), ['serde@1.0:prod', 'anyhow@1:prod', 'local@path:../local:prod', 'insta@1.40:dev', 'nix@0.29:prod']);
  });

  it('filters to runtime packages with --prod and by name with --grep', () => {
    const root = project({ 'package.json': { dependencies: { express: '4', 'express-session': '1' }, devDependencies: { 'express-mock': '1', vitest: '2' } } });
    assert.deepEqual(names(listPackages(root, { prod: true })[0].packages), ['express@4:prod', 'express-session@1:prod']);
    assert.deepEqual(names(listPackages(root, { grep: 'SESSION' })[0].packages), ['express-session@1:prod']);
    assert.deepEqual(listPackages(root, { grep: 'nothing' }), []);
  });

  it('prints a table, JSON, or a clear message when nothing is declared', () => {
    const root = project({ 'go.mod': 'module m\n\nrequire github.com/gin-gonic/gin v1.10.0\n' });
    const out = [];
    assert.equal(main([root], { log: (l) => out.push(l) }), 0);
    assert.match(out[0], /^go\.mod \(go, 1\)\n {2}github\.com\/gin-gonic\/gin {2}v1\.10\.0 {2}prod$/);
    out.length = 0;
    main([root, '--json'], { log: (l) => out.push(l) });
    assert.equal(JSON.parse(out[0])[0].packages[0].name, 'github.com/gin-gonic/gin');
    out.length = 0;
    main([project({ 'README.md': 'x' })], { log: (l) => out.push(l) });
    assert.equal(out[0], 'No declared packages found.');
    assert.equal(main(['--nope'], { log: () => {} }), 2);
  });

  it('runs as a standalone script', () => {
    const root = project({ 'package.json': { dependencies: { hono: '4' } } });
    const script = join(dirname(fileURLToPath(import.meta.url)), 'list-packages.mjs');
    const out = execFileSync('node', [script, '--json'], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
    assert.equal(JSON.parse(out)[0].packages[0].name, 'hono');
  });
});
