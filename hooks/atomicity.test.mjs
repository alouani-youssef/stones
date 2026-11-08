import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULTS, classify, dependencyChanged, globToRegExp, loadConfig, networkHit, pathClass, tokenize, gitIntents, shellWriteTargets, git, isRepo, currentBranch, defaultBranch, stagedChanges, branchBase, branchChanges, readAtRef, specPath, inspectSpec } from './atomicity.mjs';

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
    assert.equal(cls('.claude/settings.json'), 'manifest');
    assert.equal(cls('.env.example'), 'manifest');
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

describe('networkHit', () => {
  const hit = (l, c = DEFAULTS) => networkHit([l], c);

  it('flags external URLs and SDKs', () => {
    assert.ok(hit("const r = await fetch('https://api.stripe.com/v1')"));
    for (const l of ["import Stripe from 'stripe'", 'import boto3', 'const ws = new WebSocket(u)', 'process.env.PAYMENTS_URL', 'os.environ["MAIL_HOST"]'])
      assert.ok(hit(l), l);
  });

  it('ignores local, relative and example hosts', () => {
    for (const l of ["fetch('/api/orders')", 'fetch(url)', "'http://localhost:3000'", "'https://example.com'", "'https://a.example.com/x'", "'http://box.local/x'"])
      assert.equal(hit(l), null, l);
  });

  it('returns the first matching line', () => {
    assert.equal(networkHit(['const a = 1', 'import boto3', 'import twilio'], DEFAULTS), 'import boto3');
  });

  it('flags transports and extra SDK families', () => {
    for (const l of ["net.connect(80, h)", 'conn, _ := net.Dial("tcp", a)', "tls.connect(443)", "import dgram from 'node:dgram'", "const s = dgram.createSocket('udp4')",
      "import firebase from 'firebase/app'", "import amqp from 'amqplib'", "import { Kafka } from 'kafkajs'", "import * as g from '@grpc/grpc-js'", "import sg from '@sendgrid/mail'", "import x from '@sendgrid/client'",
      'import pika', 'from confluent_kafka import Producer', 'import grpc', 'import firebase_admin'])
      assert.ok(hit(l), l);
  });

  it('does not flag plain HTTP client libraries', () => {
    for (const l of ["import axios from 'axios'", 'import requests', 'import httpx', "import got from 'got'"]) assert.equal(hit(l), null, l);
  });

  it('flags http.HandleFunc only when incoming', () => {
    assert.equal(hit('http.HandleFunc("/x", h)'), null);
    assert.ok(hit('http.HandleFunc("/x", h)', loadConfig(withConfig({ zones: { network: { incoming: true } } }))));
  });

  it('incoming routes are opt-in', () => {
    assert.equal(hit("app.post('/orders', h)"), null);
    const c = loadConfig(withConfig({ zones: { network: { incoming: true } } }));
    assert.ok(hit("app.post('/orders', h)", c));
  });

  it('honours extraPatterns', () => {
    const c = loadConfig(withConfig({ zones: { network: { extraPatterns: ['\\bmyHttp\\('] } } }));
    assert.ok(hit('myHttp(x)', c));
    assert.equal(hit('myHttp(x)'), null);
  });
});

describe('dependencyChanged', () => {
  it('compares package.json dependency sections only', () => {
    assert.equal(dependencyChanged('package.json', '{"scripts":{"a":"x"}}', '{"scripts":{"a":"y"}}'), false);
    assert.equal(dependencyChanged('package.json', '{"scripts":{}}', '{"scripts":{},"dependencies":{"zod":"^3"}}'), true);
    assert.equal(dependencyChanged('package.json', '{}', 'not json'), true);
  });

  it('compares pyproject.toml dependency sections', () => {
    const a = '[project]\nname = "a"\ndependencies = [\n  "x",\n]\n';
    assert.equal(dependencyChanged('pyproject.toml', a, a.replace('name = "a"', 'name = "b"')), false);
    assert.equal(dependencyChanged('pyproject.toml', a, a.replace('"x",', '"x", "y",')), true);
    const p = '[tool.poetry.dependencies]\nrequests = "1"\n';
    assert.equal(dependencyChanged('pyproject.toml', p, p.replace('"1"', '"2"')), true);
  });

  it('counts dotted dependency sub-tables', () => {
    const a = '[dependencies.serde]\nversion = "1"\n';
    assert.equal(dependencyChanged('Cargo.toml', a, a.replace('"1"', '"2"')), true);
    const p = '[tool.poetry.dependencies.x]\nversion = "1"\n';
    assert.equal(dependencyChanged('pyproject.toml', p, p.replace('"1"', '"2"')), true);
  });

  it('compares Cargo.toml dependency sections', () => {
    const a = '[package]\nversion = "1"\n[dependencies]\nserde = "1"\n';
    assert.equal(dependencyChanged('Cargo.toml', a, a.replace('version = "1"', 'version = "2"')), false);
    assert.equal(dependencyChanged('Cargo.toml', a, a.replace('serde = "1"', 'serde = "2"')), true);
  });
});

describe('classify', () => {
  const stripe = ["import Stripe from 'stripe'"];

  it('uses path class, then content', () => {
    assert.equal(classify({ file: 'src/a.ts', added: stripe }, DEFAULTS), 'network');
    assert.equal(classify({ file: 'src/a.ts', added: ['const a = 1'] }, DEFAULTS), 'code');
    assert.equal(classify({ file: 'db/migrations/1.sql', added: stripe }, DEFAULTS), 'db');
    assert.equal(classify({ file: 'src/a.test.ts', added: ["fetch('https://x.io')"] }, DEFAULTS), 'neutral');
  });

  it('splits manifests into packages or code', () => {
    const base = { file: 'package.json', added: [] };
    assert.equal(classify({ ...base, before: '{"name":"a"}', after: '{"name":"b"}' }, DEFAULTS), 'code');
    assert.equal(classify({ ...base, before: '{}', after: '{"dependencies":{"zod":"1"}}' }, DEFAULTS), 'packages');
  });

  it('honours network.ignore', () => {
    const c = loadConfig(withConfig({ zones: { network: { ignore: ['src/legacy/**'] } } }));
    assert.equal(classify({ file: 'src/legacy/a.ts', added: stripe }, c), 'code');
    assert.equal(classify({ file: 'src/new/a.ts', added: stripe }, c), 'network');
  });

  it('network.ignore does not downgrade path-based network files', () => {
    const c = loadConfig(withConfig({ zones: { network: { ignore: ['**/.mcp.json'] } } }));
    assert.equal(classify({ file: '.mcp.json', added: [] }, c), 'network');
  });

  it('incoming route files are network only when incoming is on', () => {
    const on = loadConfig(withConfig({ zones: { network: { incoming: true } } }));
    for (const f of ['config/routes.rb', 'src/app/api/x/route.ts', 'pages/api/hello.ts']) {
      assert.equal(classify({ file: f, added: [] }, on), 'network', f);
      assert.equal(classify({ file: f, added: [] }, DEFAULTS), 'code', f);
    }
  });

  it('classifies binaries by path without throwing', () => {
    assert.equal(classify({ file: 'logo.png', added: [] }, DEFAULTS), 'code');
  });

  it('treats .claude/settings.json as network only when sandbox.network changes', () => {
    const f = '.claude/settings.json';
    const s = (o) => JSON.stringify(o);
    assert.equal(classify({ file: f, added: [], before: s({ model: 'a' }), after: s({ model: 'b' }) }, DEFAULTS), 'code');
    assert.equal(
      classify({ file: f, added: [], before: s({ sandbox: { network: { allowedDomains: [] } } }), after: s({ sandbox: { network: { allowedDomains: ['x.io'] } } }) }, DEFAULTS),
      'network',
    );
    assert.equal(classify({ file: f, added: [], before: '{}', after: '{oops' }, DEFAULTS), 'network');
  });

  it('treats .env.example as network only for URL/host keys', () => {
    const f = '.env.example';
    assert.equal(classify({ file: f, added: ['DEBUG=1'] }, DEFAULTS), 'code');
    for (const l of ['PAYMENTS_URL=', 'MAIL_HOST=x', 'S3_ENDPOINT=', 'STRIPE_API_KEY=sk'])
      assert.equal(classify({ file: f, added: [l] }, DEFAULTS), 'network', l);
  });

  it('keeps .mcp.json network by path', () => {
    assert.equal(classify({ file: '.mcp.json', added: [] }, DEFAULTS), 'network');
  });
});

describe('bash parsing', () => {
  it('tokenize splits, quotes, comments, heredocs', () => {
    assert.deepEqual(tokenize('a "b c" && d; e | f # no\ng'), [['a', 'b c'], ['d'], ['e'], ['f'], ['g']]);
    assert.deepEqual(tokenize("cat <<'EOF' > x\ngit commit\nEOF\nls"), [['cat', '>', 'x'], ['ls']]);
  });
  it('here-string is not a heredoc', () => {
    assert.deepEqual(tokenize('cat <<< x'), [['cat', 'x']]);
    const cmd = 'cat <<< "x"\ngit commit -am y';
    assert.equal(tokenize(cmd).length, 2);
    assert.deepEqual(gitIntents(cmd).commit, { all: true, paths: [] });
  });
  it('gitIntents commit', () => {
    assert.deepEqual(gitIntents('git commit -am "x"').commit, { all: true, paths: [] });
    assert.deepEqual(gitIntents('git -C repo commit -m x -- src/a.ts').commit.paths, ['src/a.ts']);
    assert.deepEqual(gitIntents('git -c a=b --no-pager commit -m msg src/b.ts').commit, { all: false, paths: ['src/b.ts'] });
    assert.equal(gitIntents('echo "git commit"').commit, null);
  });
  it('gitIntents add/push/pr', () => {
    assert.equal(gitIntents('git add -A && git commit -m x').adds, 'all');
    assert.equal(gitIntents('git add .').adds, 'all');
    assert.deepEqual(gitIntents('git add a b && git add c').adds, ['a', 'b', 'c']);
    assert.equal(gitIntents('git add a && git add -A').adds, 'all');
    assert.equal(gitIntents('ls').adds, null);
    assert.deepEqual(gitIntents('gh pr create --base deps/zod --title t').pr, { base: 'deps/zod' });
    assert.equal(gitIntents('git push origin HEAD').push, true);
  });
  it('shellWriteTargets', () => {
    assert.ok(shellWriteTargets('echo x > prisma/migrations/1/m.sql').includes('prisma/migrations/1/m.sql'));
    assert.ok(shellWriteTargets('cp a.sql db/migrate/1.rb').includes('db/migrate/1.rb'));
    assert.deepEqual(shellWriteTargets('mv -f a b && echo hi | tee -a c >> d 2>&1'), ['b', 'd', 'c']);
    assert.deepEqual(shellWriteTargets('touch x y'), ['x', 'y']);
  });
});

const sh = (dir, ...args) => {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const repo = (branch = 'main') => {
  const dir = mkdtempSync(join(tmpdir(), 'atomicity-git-'));
  sh(dir, 'init', '-b', branch);
  return dir;
};
const put = (dir, file, content) => {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), content);
};
const commitAll = (dir, msg = 'c') => {
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-m', msg);
};

describe('git layer', () => {
  it('basic helpers', () => {
    const p = repo();
    assert.equal(isRepo(p), true);
    assert.equal(isRepo(mkdtempSync(join(tmpdir(), 'plain-'))), false);
    assert.equal(git(p, ['nope-cmd']).ok, false);
    put(p, 'a.txt', 'x');
    commitAll(p);
    assert.equal(currentBranch(p), 'main');
    assert.equal(readAtRef(p, 'HEAD', 'a.txt'), 'x');
    assert.equal(readAtRef(p, 'HEAD', 'missing'), null);
  });

  it('first commit with a space in the path (no HEAD)', () => {
    const p = repo();
    put(p, 'src/my file.ts', 'const a = 1;\n');
    put(p, 'package.json', '{"dependencies":{"a":"1"}}');
    sh(p, 'add', '-A');
    const changes = stagedChanges(p, DEFAULTS, { all: false, paths: [] });
    const f = changes.find((c) => c.file === 'src/my file.ts');
    assert.deepEqual(f.added, ['const a = 1;']);
    const m = changes.find((c) => c.file === 'package.json');
    assert.equal(m.before, '');
    assert.equal(m.after, '{"dependencies":{"a":"1"}}');
    assert.equal(classify(m, DEFAULTS), 'packages');
  });

  it('rename classifies the new path', () => {
    const p = repo();
    put(p, 'a.ts', 'one\ntwo\nthree\nfour\n');
    commitAll(p);
    sh(p, 'mv', 'a.ts', 'b.ts');
    const changes = stagedChanges(p, DEFAULTS, { all: false, paths: [] });
    assert.deepEqual(changes.map((c) => c.file), ['b.ts']);
  });

  it('manifest before/after filled; deletions have empty after', () => {
    const p = repo();
    put(p, 'package.json', '{"dependencies":{}}');
    put(p, '.env.example', 'A=1');
    commitAll(p);
    put(p, 'package.json', '{"dependencies":{"z":"1"}}');
    sh(p, 'rm', '-q', '.env.example');
    sh(p, 'add', '-A');
    const changes = stagedChanges(p, DEFAULTS, { all: false, paths: [] });
    const pk = changes.find((c) => c.file === 'package.json');
    assert.equal(pk.before, '{"dependencies":{}}');
    assert.equal(pk.after, '{"dependencies":{"z":"1"}}');
    const env = changes.find((c) => c.file === '.env.example');
    assert.equal(env.before, 'A=1');
    assert.equal(env.after, '');
  });

  it('extra.all and extra.paths include unstaged work', () => {
    const p = repo();
    put(p, 'm.ts', 'a\n');
    put(p, 'package.json', '{}');
    commitAll(p);
    put(p, 'm.ts', 'a\nb\n');
    put(p, 'package.json', '{"dependencies":{"q":"1"}}');
    put(p, 'new.ts', 'fresh\n');
    const all = stagedChanges(p, DEFAULTS, { all: true, paths: [] });
    assert.deepEqual(all.find((c) => c.file === 'm.ts').added, ['b']);
    assert.equal(all.find((c) => c.file === 'package.json').after, '{"dependencies":{"q":"1"}}');
    assert.ok(!all.some((c) => c.file === 'new.ts'));
    const paths = stagedChanges(p, DEFAULTS, { all: false, paths: ['new.ts'] });
    assert.deepEqual(paths.find((c) => c.file === 'new.ts').added, ['fresh']);
    const every = stagedChanges(p, DEFAULTS, { all: false, paths: 'all' });
    assert.ok(every.some((c) => c.file === 'new.ts') && every.some((c) => c.file === 'm.ts'));
  });

  it('binary files have no added lines', () => {
    const p = repo();
    writeFileSync(join(p, 'x.bin'), Buffer.from([0, 1, 2, 0, 255]));
    sh(p, 'add', '-A');
    const [c] = stagedChanges(p, DEFAULTS, { all: false, paths: [] });
    assert.deepEqual(c.added, []);
  });

  it('stacked branches: base is nearest dangerous branch', () => {
    const p = repo();
    put(p, 'README.md', 'r');
    commitAll(p);
    sh(p, 'checkout', '-b', 'deps/zod');
    put(p, 'package.json', '{"dependencies":{"zod":"1"}}');
    commitAll(p);
    sh(p, 'checkout', '-b', 'feat/use-zod');
    put(p, 'src/use.ts', 'import z from "zod";\n');
    commitAll(p);
    assert.equal(branchBase(p, DEFAULTS, null), 'deps/zod');
    assert.equal(branchBase(p, DEFAULTS, 'main'), 'main');
    const changes = branchChanges(p, DEFAULTS, 'deps/zod');
    assert.deepEqual(changes.map((c) => c.file), ['src/use.ts']);
    const all = branchChanges(p, DEFAULTS, 'main');
    const pk = all.find((c) => c.file === 'package.json');
    assert.equal(pk.before, '');
    assert.equal(pk.after, '{"dependencies":{"zod":"1"}}');
  });

  it('defaultBranch', () => {
    const p = repo('master');
    put(p, 'a', 'a');
    commitAll(p);
    assert.equal(defaultBranch(p, DEFAULTS), 'master');
    const q = repo('trunk');
    put(q, 'a', 'a');
    commitAll(q);
    assert.equal(defaultBranch(q, DEFAULTS), null);
  });

  it('keeps added lines starting with ++ and treats [] in paths literally', () => {
    const p = repo();
    put(p, 'src/i.ts', 'old\n');
    commitAll(p);
    put(p, 'src/[id].ts', '++x\nmine\n');
    sh(p, 'add', '-A');
    const changes = stagedChanges(p, DEFAULTS, { all: false, paths: [] });
    assert.deepEqual(changes.map((c) => c.file), ['src/[id].ts']);
    assert.deepEqual(changes[0].added, ['++x', 'mine']);
  });
});

describe('spec checker', () => {
  const full = (zone = 'db', over = {}) => {
    const s = { Zone: zone, 'What changes': 'adds a column', Why: 'needed for billing', 'Blast radius': 'orders table', Rollback: 'drop the column', Verification: 'run migrations', ...over };
    return Object.entries(s).filter(([, v]) => v !== null).map(([k, v]) => `## ${k}\n${v}\n`).join('\n');
  };

  it('builds the spec path', () => {
    assert.equal(specPath(DEFAULTS, 'db/add-col'), '.claude/danger/db--add-col.md');
  });
  it('rejects a missing spec', () => {
    const r = inspectSpec(null, 'db');
    assert.equal(r.valid, false);
    assert.match(r.reason, /spec file is missing/);
  });
  it('names a missing section', () => {
    const r = inspectSpec(full('db', { Rollback: null }), 'db');
    assert.equal(r.valid, false);
    assert.match(r.reason, /Rollback/);
  });
  it('rejects placeholders', () => {
    const r = inspectSpec(full('db', { Why: 'TBD' }), 'db');
    assert.equal(r.valid, false);
    assert.match(r.reason, /Why/);
  });
  it('rejects a zone mismatch', () => {
    const r = inspectSpec(full('network'), 'db');
    assert.equal(r.valid, false);
    assert.match(r.reason, /Zone/);
  });
  it('accepts a complete spec', () => {
    assert.deepEqual(inspectSpec(full('db'), 'db'), { valid: true });
  });
});
