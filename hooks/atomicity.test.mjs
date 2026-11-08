import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULTS, classify, dependencyChanged, globToRegExp, loadConfig, networkHit, pathClass, tokenize, gitIntents, shellWriteTargets } from './atomicity.mjs';

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
