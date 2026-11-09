import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HEADER, parseDockerfile, renderDevcontainer, syncDevcontainer } from './devcontainer.mjs';

const parsed = (text) => JSON.parse(renderDevcontainer(text, { name: 'node-pnpm' }).slice(HEADER.length));

describe('devcontainer generator', () => {
  it('joins line continuations and ignores comments', () => {
    const p = parseDockerfile('FROM debian\nRUN a \\\n  b\n# USER root\n');
    assert.equal(p.user, null);
    assert.equal(p.from, 'debian');
  });

  it('uses only the last stage', () => {
    const p = parseDockerfile('FROM golang AS build\nUSER builder\nWORKDIR /src\nEXPOSE 9000\nFROM debian\nUSER dev\n');
    assert.equal(p.from, 'debian');
    assert.equal(p.user, 'dev');
    assert.equal(p.workdir, null);
    assert.deepEqual(p.expose, []);
  });

  it('parses ENV in both forms and skips $ references', () => {
    const p = parseDockerfile('FROM x\nENV A=1 B="x y"\nENV C 3\nENV PATH=/x:$PATH\n');
    assert.deepEqual(p.env, { A: '1', B: 'x y', C: '3' });
  });

  it('parses EXPOSE with protocols', () => {
    assert.deepEqual(parseDockerfile('FROM x\nEXPOSE 3000/tcp 5432\n').expose, [3000, 5432]);
  });

  it('maps instructions to devcontainer fields', () => {
    const out = parsed('FROM node:22\nUSER node\nWORKDIR /workspace\nENV A=1\nEXPOSE 3000\n');
    assert.equal(out.name, 'node-pnpm');
    assert.deepEqual(out.build, { dockerfile: 'Dockerfile', context: '.' });
    assert.equal(out.remoteUser, 'node');
    assert.deepEqual(out.containerEnv, { A: '1' });
    assert.deepEqual(out.forwardPorts, [3000]);
    assert.equal(out.workspaceFolder, '/workspace');
    assert.equal(out.workspaceMount, 'source=${localWorkspaceFolder},target=/workspace,type=bind');
  });

  it('omits fields with no source', () => {
    const out = parsed('FROM node:22\n');
    for (const key of ['remoteUser', 'containerEnv', 'forwardPorts', 'workspaceFolder', 'workspaceMount']) {
      assert.equal(key in out, false, key);
    }
  });

  it('metadata label wins over derived fields', () => {
    const out = parsed(`FROM node:22\nUSER node\nLABEL devcontainer.metadata='{"name":"custom","remoteUser":"x","postCreateCommand":"pnpm i"}'\n`);
    assert.equal(out.name, 'custom');
    assert.equal(out.remoteUser, 'x');
  });

  it('leaves lifecycle commands to the image label so they run once', () => {
    const out = parsed(`FROM node:22\nLABEL devcontainer.metadata='{"postCreateCommand":"pnpm i","postStartCommand":"x","customizations":{"vscode":{}}}'\n`);
    assert.equal('postCreateCommand' in out, false);
    assert.equal('postStartCommand' in out, false);
    assert.deepEqual(out.customizations, { vscode: {} });
  });

  it('output is deterministic and headed', () => {
    const text = 'FROM node:22\nUSER node\nENV B=2 A=1\n';
    const a = renderDevcontainer(text, { name: 'n' });
    assert.equal(a, renderDevcontainer(text, { name: 'n' }));
    assert.ok(a.startsWith(HEADER));
    assert.ok(a.endsWith('}\n'));
  });

  it('rejects malformed metadata', () => {
    assert.throws(() => renderDevcontainer(`FROM x\nLABEL devcontainer.metadata='{bad'\n`, { name: 'n' }), /devcontainer\.metadata/);
  });
});

const HOOK = fileURLToPath(new URL('./devcontainer.mjs', import.meta.url));
const DOCKERFILE = 'FROM node:22\nUSER node\nENV A=1\n';

function projectWith(files) {
  const root = mkdtempSync(join(tmpdir(), 'stones-dc-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function runHook(root, filePath) {
  const result = spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_input: { file_path: join(root, filePath) } }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: 'utf8',
  });
  return { code: result.status, stderr: result.stderr };
}

const JSON_PATH = '.devcontainer/devcontainer.json';
const read = (root, path) => readFileSync(join(root, path), 'utf8');

describe('devcontainer sync hook', () => {
  it('regenerates after a Dockerfile edit', () => {
    const root = projectWith({ '.devcontainer/Dockerfile': DOCKERFILE });
    const { code } = runHook(root, '.devcontainer/Dockerfile');
    assert.equal(code, 0);
    assert.equal(read(root, JSON_PATH), renderDevcontainer(DOCKERFILE, { name: basename(root) }));
  });

  it('reverts a hand edit to devcontainer.json and tells the agent', () => {
    const root = projectWith({ '.devcontainer/Dockerfile': DOCKERFILE, [JSON_PATH]: '{}' });
    const { code, stderr } = runHook(root, JSON_PATH);
    assert.equal(code, 2);
    assert.match(stderr, /edit \.devcontainer\/Dockerfile/);
    assert.equal(read(root, JSON_PATH), renderDevcontainer(DOCKERFILE, { name: basename(root) }));
  });

  it('ignores other paths', () => {
    const root = projectWith({ '.devcontainer/Dockerfile': DOCKERFILE, 'src/index.ts': '' });
    assert.equal(runHook(root, 'src/index.ts').code, 0);
    assert.equal(existsSync(join(root, JSON_PATH)), false);
  });

  it('ignores a project without a Dockerfile', () => {
    const root = projectWith({ 'src/index.ts': '' });
    assert.equal(runHook(root, JSON_PATH).code, 0);
    assert.equal(existsSync(join(root, JSON_PATH)), false);
  });

  it('leaves the json alone on malformed metadata', () => {
    const root = projectWith({ '.devcontainer/Dockerfile': `FROM x\nLABEL devcontainer.metadata='{bad'\n`, [JSON_PATH]: 'X' });
    const { code, stderr } = runHook(root, '.devcontainer/Dockerfile');
    assert.equal(code, 2);
    assert.match(stderr, /devcontainer\.metadata/);
    assert.equal(read(root, JSON_PATH), 'X');
  });

  it('syncDevcontainer check mode reports drift without writing', () => {
    const root = projectWith({ '.devcontainer/Dockerfile': DOCKERFILE, [JSON_PATH]: '{}' });
    assert.deepEqual(syncDevcontainer(join(root, '.devcontainer'), { check: true, name: 'x' }), { status: 'drift' });
    assert.equal(read(root, JSON_PATH), '{}');
  });

  it('syncDevcontainer reports a missing Dockerfile', () => {
    const root = projectWith({});
    assert.deepEqual(syncDevcontainer(join(root, '.devcontainer'), { name: 'x' }), { status: 'missing' });
  });
});
