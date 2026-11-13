#!/usr/bin/env node
// End-to-end smoke test of the claude-stones CLI on throwaway projects, one
// per supported stack. CI runs it against the packed tarball so a file
// missing from package.json "files" fails here, not for users.
//
//   node scripts/smoke.mjs                       use bin/stones.mjs from this checkout
//   node scripts/smoke.mjs --bin <stones.mjs>    use another copy (e.g. an unpacked tarball)
//
// For each fixture: --help, detect, init --dry-run (writes nothing),
// init --yes three times (the last run must change nothing), the generated
// files, sync --check, and one installed tool.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const argBin = process.argv.indexOf('--bin');
const BIN = resolve(argBin > 0 ? process.argv[argBin + 1] : new URL('../bin/stones.mjs', import.meta.url).pathname);

const FIXTURES = {
  'node-pnpm': {
    expect: { language: 'TypeScript', devcontainer: true },
    files: {
      'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'node --test', build: 'tsc' }, devDependencies: { typescript: '5.6.0' } }),
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'tsconfig.json': '{}',
      'src/index.ts': 'export const one = 1;\n',
    },
  },
  python: {
    expect: { language: 'Python', devcontainer: true },
    files: {
      'pyproject.toml': '[project]\nname = "demo"\nversion = "0.1.0"\ndependencies = ["flask>=3"]\n\n[tool.pytest.ini_options]\n',
      'demo/__init__.py': 'ONE = 1\n',
    },
  },
  go: {
    expect: { language: 'Go', devcontainer: true },
    files: {
      'go.mod': 'module example.com/demo\n\ngo 1.23\n',
      'main.go': 'package main\n\nfunc main() {}\n',
    },
  },
  empty: { expect: { language: null, devcontainer: false }, files: { 'README.md': '# demo\n' } },
};

function run(cwd, args, { ok = true } = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, CI: '1' } });
  if (ok && result.status !== 0) {
    throw new Error(`stones ${args.join(' ')} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === '.git') return [];
    const path = join(dir, e.name);
    return e.isDirectory() ? listFiles(path, base) : [path.slice(base.length + 1)];
  });
}

function fixture(name, files) {
  const root = mkdtempSync(join(tmpdir(), `stones-smoke-${name}-`));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  return root;
}

function smoke(name, { files, expect }) {
  const root = fixture(name, files);
  try {
    assert.match(run(root, ['--help']).stdout, /Usage/);

    const stack = JSON.parse(run(root, ['detect']).stdout);
    if (expect.language) assert.ok(stack.languages.includes(expect.language), `detect: expected ${expect.language}, got ${stack.languages}`);

    const before = listFiles(root);
    run(root, ['init', '--yes', '--dry-run', '--no-roadmap']);
    assert.deepEqual(listFiles(root), before, 'init --dry-run wrote files');

    run(root, ['init', '--yes', '--no-roadmap']);
    run(root, ['init', '--yes', '--no-roadmap']);
    const third = run(root, ['init', '--yes', '--no-roadmap']).stdout;
    assert.match(third, /nothing to change/, `re-running init is not stable:\n${third}`);

    for (const path of ['AGENT.md', 'CLAUDE.md', '.claude/settings.json', '.claude/stones.json', '.claude/commands/roadmap.md']) {
      assert.ok(existsSync(join(root, path)), `missing ${path}`);
    }
    assert.match(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), /@AGENT\.md/);
    const settings = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));
    assert.ok(settings.hooks && Object.keys(settings.hooks).length, 'settings.json has no hooks');
    for (const group of Object.values(settings.hooks).flat()) {
      for (const hook of group.hooks) {
        const script = hook.command.match(/\.claude\/hooks\/[\w.-]+/)?.[0];
        if (script) assert.ok(existsSync(join(root, script)), `hook ${script} is registered but not installed`);
      }
    }

    assert.equal(existsSync(join(root, '.devcontainer/Dockerfile')), expect.devcontainer, 'dev container presence');
    if (expect.devcontainer) run(root, ['sync', '--check']); // exits 1 on drift

    const packages = execFileSync(process.execPath, ['.claude/tools/list-packages.mjs', '--json'], { cwd: root, encoding: 'utf8' });
    JSON.parse(packages);

    console.log(`ok   ${name}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

let failed = 0;
for (const [name, spec] of Object.entries(FIXTURES)) {
  try {
    smoke(name, spec);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}\n${error.message}\n`);
  }
}
console.log(`smoke: ${Object.keys(FIXTURES).length - failed}/${Object.keys(FIXTURES).length} fixtures passed (${BIN})`);
if (failed) process.exitCode = 1;
