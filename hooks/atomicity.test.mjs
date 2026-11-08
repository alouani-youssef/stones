import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULTS, classify, dependencyChanged, globToRegExp, loadConfig, networkHit, pathClass, tokenize, gitIntents, shellWriteTargets, git, isRepo, currentBranch, defaultBranch, stagedChanges, branchBase, branchChanges, readAtRef, specPath, inspectSpec, evaluate } from './atomicity.mjs';

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

describe('evaluate', () => {
  const GEN = 'npx prisma migrate dev --name <name>';
  const spec = (zone, over = {}) => {
    const s = { Zone: zone, 'What changes': 'adds a column', Why: 'needed for billing', 'Blast radius': 'orders table', Rollback: 'drop the column', Verification: 'run migrations', ...over };
    return Object.entries(s).map(([k, v]) => `## ${k}\n${v}\n`).join('\n');
  };
  const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
  const write = (file_path) => ({ tool_name: 'Write', tool_input: { file_path, content: 'x' } });
  const run = (p, event) => evaluate(event, { projectDir: p });
  const project = (config = { migrations: { generate: GEN } }) => {
    const p = repo();
    put(p, '.claude/atomicity.json', JSON.stringify(config));
    put(p, 'src/index.ts', 'export const a = 1;\n');
    put(p, 'src/a.ts', 'export const b = 1;\n');
    commitAll(p, 'init');
    return p;
  };
  const blocked = (r, rule) => {
    assert.equal(r.block, true, JSON.stringify(r));
    assert.ok(r.reason.startsWith(`Atomicity guard (${rule}):`), r.reason);
  };
  const allowed = (r) => assert.equal(r.block, false, JSON.stringify(r));
  const stageMigration = (p) => {
    put(p, 'prisma/migrations/1/m.sql', 'CREATE TABLE o (id int);\n');
    sh(p, 'add', 'prisma/migrations/1/m.sql');
  };

  describe('R4 and config protection', () => {
    it('blocks writes into a migration dir with the generate command', () => {
      const p = project();
      for (const event of [write('prisma/migrations/1/m.sql'), write(join(p, 'prisma/migrations/1/m.sql')), { tool_name: 'Edit', tool_input: { file_path: 'db/migrate/001_x.rb' } }, bash('echo x > prisma/migrations/1/m.sql')]) {
        const r = run(p, event);
        blocked(r, 'R4');
        assert.ok(r.reason.includes(GEN), r.reason);
      }
    });
    it('falls back to generic generator text', () => {
      const r = run(project({}), write('alembic/versions/a1.py'));
      blocked(r, 'R4');
      assert.match(r.reason, /run your ORM's migration generator/);
    });
    it('allows model files, configured dirs and allowEdits', () => {
      allowed(run(project(), write('prisma/schema.prisma')));
      allowed(run(project(), write('app/models.py')));
      const custom = project({ migrations: { dirs: ['sql/changes'] } });
      blocked(run(custom, write('sql/changes/1.sql')), 'R4');
      allowed(run(custom, write('prisma/migrations/1/m.sql')));
      allowed(run(project({ migrations: { allowEdits: true } }), write('prisma/migrations/1/m.sql')));
    });
    it('blocks agent writes to .claude/atomicity.json', () => {
      const p = project();
      for (const event of [write('.claude/atomicity.json'), bash('echo {} > .claude/atomicity.json')]) {
        const r = run(p, event);
        blocked(r, 'R4');
        assert.match(r.reason, /only a human edits this file/);
      }
    });
    it('enabled: false allows everything', () => {
      const p = project({ enabled: false });
      allowed(run(p, write('prisma/migrations/1/m.sql')));
      sh(p, 'switch', '-c', 'feat/x');
      stageMigration(p);
      allowed(run(p, bash('git commit -m x')));
    });
  });

  describe('R1', () => {
    it('blocks a mixed staged set and lists both files', () => {
      const p = project();
      sh(p, 'switch', '-c', 'db/orders');
      stageMigration(p);
      put(p, 'src/index.ts', 'export const a = 2;\n');
      sh(p, 'add', 'src/index.ts');
      const r = run(p, bash('git commit -m x'));
      blocked(r, 'R1');
      assert.ok(r.reason.includes('prisma/migrations/1/m.sql'), r.reason);
      assert.ok(r.reason.includes('src/index.ts'), r.reason);
      assert.match(r.reason, /git restore --staged src\/index\.ts/);
    });
    it('counts what `git add -A` in the same command would stage', () => {
      const p = project();
      sh(p, 'switch', '-c', 'feat/x');
      put(p, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
      put(p, 'src/a.ts', 'export const b = 2;\n');
      const r = run(p, bash('git add -A && git commit -m x'));
      blocked(r, 'R1');
      assert.ok(r.reason.includes('pnpm-lock.yaml') && r.reason.includes('src/a.ts'), r.reason);
    });
    it('counts `git commit -a` and directory pathspecs in `git add`', () => {
      const p = project();
      sh(p, 'switch', '-c', 'deps/x');
      put(p, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
      sh(p, 'add', 'pnpm-lock.yaml');
      put(p, 'src/a.ts', 'export const b = 2;\n');
      blocked(run(p, bash('git commit -am x')), 'R1');
      blocked(run(p, bash('git add src && git commit -m x')), 'R1');
    });
    it('lets neutral files ride along', () => {
      const p = project();
      sh(p, 'switch', '-c', 'feat/x');
      put(p, 'src/a.ts', 'export const b = 2;\n');
      put(p, 'src/a.test.ts', 'fetch("https://api.stripe.com")\n');
      sh(p, 'add', '-A');
      allowed(run(p, bash('git commit -m x')));
    });
  });

  describe('R2 / R3 on commit', () => {
    it('blocks a db commit on the default branch', () => {
      const p = project();
      stageMigration(p);
      const r = run(p, bash('git commit -m x'));
      blocked(r, 'R2');
      assert.match(r.reason, /git switch -c db\//);
      assert.ok(r.reason.includes('prisma/migrations/1/m.sql'));
    });
    it('blocks a db commit on a branch without the db/ prefix', () => {
      const p = project();
      sh(p, 'switch', '-c', 'feat/x');
      stageMigration(p);
      const r = run(p, bash('git commit -m x'));
      blocked(r, 'R2');
      assert.match(r.reason, /db\//);
    });
    it('blocks a db commit without a spec', () => {
      const p = project();
      sh(p, 'switch', '-c', 'db/orders');
      stageMigration(p);
      const r = run(p, bash('git commit -m x'));
      blocked(r, 'R3');
      assert.ok(r.reason.includes('.claude/danger/db--orders.md'), r.reason);
      assert.match(r.reason, /spec file is missing/);
    });
    it('accepts a valid spec staged in the same commit', () => {
      const p = project();
      sh(p, 'switch', '-c', 'db/orders');
      stageMigration(p);
      put(p, '.claude/danger/db--orders.md', spec('db'));
      sh(p, 'add', '.claude/danger/db--orders.md');
      allowed(run(p, bash('git commit -m x')));
    });
    it('accepts a spec added by the same command, and checks the index version otherwise', () => {
      const p = project();
      sh(p, 'switch', '-c', 'db/orders');
      stageMigration(p);
      put(p, '.claude/danger/db--orders.md', spec('db'));
      allowed(run(p, bash('git add .claude/danger/db--orders.md && git commit -m x')));
      blocked(run(p, bash('git commit -m x')), 'R3');
    });
    it('allows a code-only commit on a feature branch and on main', () => {
      const p = project();
      put(p, 'src/a.ts', 'export const b = 2;\n');
      sh(p, 'add', 'src/a.ts');
      allowed(run(p, bash('git commit -m x')));
      sh(p, 'switch', '-c', 'feat/x');
      allowed(run(p, bash('git commit -m x')));
    });
  });

  describe('branch-wide checks', () => {
    const dbBranch = () => {
      const p = project();
      sh(p, 'switch', '-c', 'db/orders');
      put(p, 'prisma/migrations/1/m.sql', 'CREATE TABLE o (id int);\n');
      put(p, '.claude/danger/db--orders.md', spec('db'));
      commitAll(p, 'migration');
      put(p, 'src/a.ts', 'export const b = 2;\n');
      sh(p, 'add', 'src/a.ts');
      return p;
    };
    it('blocks a code commit on a branch already holding a migration', () => {
      const r = run(dbBranch(), bash('git commit -m x'));
      blocked(r, 'R2');
      assert.ok(r.reason.includes('prisma/migrations/1/m.sql') && r.reason.includes('src/a.ts'), r.reason);
    });
    it('exempt branches skip R1-R3', () => {
      const p = dbBranch();
      put(p, '.claude/atomicity.json', JSON.stringify({ exempt: ['db/orders'] }));
      allowed(run(p, bash('git commit -m x')));
    });
    it('blocks gh pr create when the HEAD spec has a placeholder', () => {
      const p = project();
      sh(p, 'switch', '-c', 'net/stripe');
      put(p, '.mcp.json', '{"mcpServers":{}}');
      put(p, '.claude/danger/net--stripe.md', spec('network', { Rollback: 'TBD' }));
      commitAll(p, 'net');
      const r = run(p, bash('gh pr create --fill'));
      blocked(r, 'R3');
      assert.match(r.reason, /Rollback/);
      assert.ok(r.reason.includes('.claude/danger/net--stripe.md'));
      put(p, '.claude/danger/net--stripe.md', spec('network'));
      commitAll(p, 'fix spec');
      allowed(run(p, bash('gh pr create --fill')));
      allowed(run(p, bash('git push -u origin net/stripe')));
    });
    it('commit chained with push reads the spec being committed', () => {
      const p = project();
      sh(p, 'switch', '-c', 'db/orders');
      stageMigration(p);
      put(p, '.claude/danger/db--orders.md', spec('db'));
      allowed(run(p, bash('git add -A && git commit -m x && git push')));
      blocked(run(p, bash('git commit -m x && git push')), 'R3');
    });
    it('blocks pushing a danger change from a branch without the prefix', () => {
      const p = project();
      sh(p, 'switch', '-c', 'feat/x');
      put(p, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
      commitAll(p, 'deps');
      blocked(run(p, bash('git push')), 'R2');
    });
    it('a branch stacked on a danger branch is judged on its own commits (once it has one)', () => {
      const p = dbBranch();
      sh(p, 'reset', '-q', 'HEAD', 'src/a.ts');
      sh(p, 'switch', '-c', 'feat/after-orders');
      sh(p, 'add', 'src/a.ts');
      // First commit: db/orders tip == HEAD is allowed as the base for a commit...
      allowed(run(p, bash('git commit -m x')));
      // ...but not for push / pr (decoy defence), so a push before the branch has its own commit is judged against main.
      blocked(run(p, bash('git commit -m x && git push')), 'R2');
      sh(p, 'reset', '-q', 'HEAD', 'src/a.ts');
      put(p, 'docs/notes.md', 'stacked\n');
      sh(p, 'add', 'docs/notes.md');
      sh(p, 'commit', '-q', '-m', 'docs');
      sh(p, 'add', 'src/a.ts');
      allowed(run(p, bash('git commit -m x')));
      allowed(run(p, bash('git push')));
    });
    it('first src-only commit on a branch freshly cut from an unmerged deps branch is allowed', () => {
      const p = project();
      sh(p, 'switch', '-c', 'deps/zod');
      put(p, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
      put(p, '.claude/danger/deps--zod.md', spec('packages'));
      commitAll(p, 'add zod');
      sh(p, 'switch', '-c', 'feat/use-zod');
      put(p, 'src/a.ts', 'export const b = 2;\n');
      sh(p, 'add', 'src/a.ts');
      allowed(run(p, bash('git commit -m x')));
      assert.equal(branchBase(p, DEFAULTS, null, { allowAtHead: true }), 'deps/zod');
      assert.equal(branchBase(p, DEFAULTS, null), 'main');
    });
    it('a decoy danger branch at HEAD does not hide the branch history', () => {
      const p = project();
      sh(p, 'switch', '-c', 'feat/x');
      put(p, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
      commitAll(p, 'deps');
      put(p, 'src/a.ts', 'export const b = 2;\n');
      commitAll(p, 'code');
      sh(p, 'branch', 'deps/tmp');
      blocked(run(p, bash('git push')), 'R2');
      blocked(run(p, bash('gh pr create --fill')), 'R2');
    });
    it('gh pr create without --base is judged against the default branch', () => {
      const p = project();
      sh(p, 'switch', '-c', 'deps/lock');
      put(p, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
      put(p, '.claude/danger/deps--lock.md', spec('packages'));
      commitAll(p, 'deps');
      sh(p, 'switch', '-c', 'feat/on-deps');
      put(p, 'src/a.ts', 'export const b = 2;\n');
      commitAll(p, 'code');
      const r = run(p, bash('gh pr create --fill'));
      blocked(r, 'R2');
      assert.match(r.reason, /compared with main/);
      allowed(run(p, bash('gh pr create --base deps/lock --fill')));
    });
  });

  describe('git add -u and chained branch switches', () => {
    it('git add -u stages tracked changes (also -Av / -vA clusters)', () => {
      const p = project();
      put(p, 'prisma/migrations/1/m.sql', 'CREATE TABLE o (id int);\n');
      commitAll(p, 'seed migration');
      sh(p, 'switch', '-c', 'feat/x');
      put(p, 'src/a.ts', 'export const b = 2;\n');
      put(p, 'prisma/migrations/1/m.sql', 'CREATE TABLE o (id bigint);\n');
      for (const cmd of ['git add -u && git commit -m x', 'git add --update && git commit -m x', 'git add -Av && git commit -m x', 'git add -vA && git commit -m x', 'git add -uv && git commit -m x'])
        blocked(run(p, bash(cmd)), 'R1');
      assert.equal(gitIntents('git add -u').addsTracked, true);
      assert.equal(gitIntents('git add -vA').adds, 'all');
    });
    it('git switch -c before the commit evaluates the commit on the new branch', () => {
      const p = project();
      put(p, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
      const r = run(p, bash('git switch -c deps/x && git add -A && git commit -m x'));
      blocked(r, 'R3');
      assert.ok(r.reason.includes('.claude/danger/deps--x.md'), r.reason);
      blocked(run(p, bash('git checkout -b deps/x && git add -A && git commit -m x')), 'R3');
      put(p, '.claude/danger/deps--x.md', spec('packages'));
      allowed(run(p, bash('git switch -c deps/x && git add -A && git commit -m x')));
      allowed(run(p, bash('git checkout -B deps/x && git add -A && git commit -m x')));
      blocked(run(p, bash('git switch -c feat/x && git add -A && git commit -m x')), 'R2');
    });
    it('any other branch switch before a commit is blocked', () => {
      const p = project();
      sh(p, 'switch', '-c', 'feat/x');
      put(p, 'src/a.ts', 'export const b = 2;\n');
      sh(p, 'add', 'src/a.ts');
      for (const cmd of ['git switch main && git commit -m x', 'git checkout main && git commit -m x', 'git switch -c db/y main && git commit -m x']) {
        const r = run(p, bash(cmd));
        blocked(r, 'R2');
        assert.equal(r.reason, 'Atomicity guard (R2): run the branch switch as its own command, then commit.');
      }
      allowed(run(p, bash('git checkout -- src/index.ts && git commit -m x')));
      allowed(run(p, bash('git commit -m x && git switch main')));
    });
  });

  describe('cannot decide', () => {
    it('non-repo allows with a note; non-git bash allows', () => {
      const r = run(mkdtempSync(join(tmpdir(), 'plain-')), bash('git commit -m x'));
      allowed(r);
      assert.equal(r.note, 'atomicity: not a git repo, skipped');
      allowed(run(project(), bash('echo "git commit" && ls')));
    });
    it('no default branch skips branch checks with a note but keeps R1', () => {
      const p = repo('trunk');
      put(p, 'src/index.ts', 'x\n');
      commitAll(p, 'init');
      stageMigration(p);
      const r = run(p, bash('git commit -m x'));
      allowed(r);
      assert.match(r.note, /no default branch/);
      put(p, 'src/index.ts', 'y\n');
      sh(p, 'add', 'src/index.ts');
      blocked(run(p, bash('git commit -m x')), 'R1');
    });
    it('internal errors allow with a note', () => {
      const p = project({ exempt: 5 });
      stageMigration(p);
      const r = run(p, bash('git commit -m x'));
      allowed(r);
      assert.match(r.note, /^atomicity: internal error, skipped: /);
    });
  });

  describe('final review fixes', () => {
    it('#5 env prefixes, env/command wrappers and absolute git paths are recognised', () => {
      for (const cmd of ['GIT_AUTHOR_NAME=x git commit -m y', 'HUSKY=0 git commit -m y', 'command git commit -m y', 'env git commit -m y', 'env -u FOO A=1 git commit -m y', '/usr/bin/git commit -m y', 'A=1 B=2 command -p git commit -m y'])
        assert.deepEqual(gitIntents(cmd).commit, { all: false, paths: [] }, cmd);
      assert.equal(gitIntents('HUSKY=0 git push').push, true);
      assert.deepEqual(gitIntents('GH_TOKEN=x gh pr create --base deps/a').pr, { base: 'deps/a' });
      assert.equal(gitIntents('mygit commit -m x').commit, null);
      const p = project();
      stageMigration(p);
      blocked(run(p, bash('HUSKY=0 git commit -m x')), 'R2');
    });

    it('#7 specPath tolerates trailing slashes on specDir', () => {
      assert.equal(specPath({ ...DEFAULTS, specDir: '.claude/danger//' }, 'db/x'), '.claude/danger/db--x.md');
    });

    it('#11 a new package.json without dependency sections is not packages', () => {
      assert.equal(dependencyChanged('package.json', '', '{"name":"a","scripts":{}}'), false);
      assert.equal(dependencyChanged('package.json', '', '{"name":"a","dependencies":{}}'), false);
      assert.equal(dependencyChanged('package.json', '{"name":"a"}', '{"name":"a","devDependencies":{"x":"1"}}'), true);
    });

    it('#3 namespace/schema hosts, comment lines and package metadata are not network', () => {
      for (const l of ['<svg xmlns="http://www.w3.org/2000/svg">', '  "$schema": "https://json-schema.org/draft-07/schema#",', '"$schema": "https://json.schemastore.org/tsconfig"',
        '// see https://github.com/acme/x/issues/1', '# docs: https://docs.python.org/3/', '/* https://api.stripe.com */', ' * @see https://developer.mozilla.org/x', '<!-- https://cdn.acme.io -->'])
        assert.equal(networkHit([l], DEFAULTS), null, l);
      assert.ok(networkHit(["fetch('https://api.stripe.com') // https://github.com"], DEFAULTS));
      const pkg = { file: 'package.json', added: ['  "homepage": "https://github.com/acme/x#readme",', '    "url": "git+https://github.com/acme/x.git"'], before: '{}', after: '{}' };
      assert.equal(classify(pkg, DEFAULTS), 'code');
      assert.equal(classify({ file: 'src/c.json', added: ['"url": "https://api.acme.io"'] }, DEFAULTS), 'network');
    });

    it('#3 zones.network.allowHosts tunes the URL check', () => {
      assert.deepEqual(DEFAULTS.zones.network.allowHosts, []);
      const c = loadConfig(withConfig({ zones: { network: { allowHosts: ['*.acme.io', 'github.com'] } } }));
      assert.equal(networkHit(["fetch('https://api.acme.io/x')", "'https://github.com/a'"], c), null);
      assert.ok(networkHit(["fetch('https://api.stripe.com')"], c));
      assert.ok(networkHit(["'https://github.com.evil.io'"], c));
    });
  });

  describe('CLI', () => {
    const cli = (input, cwd) => spawnSync('node', [join(import.meta.dirname, 'atomicity.mjs')], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: cwd } });
    it('exits 2 with the reason on a block', () => {
      const p = project();
      const r = cli(JSON.stringify(write('prisma/migrations/1/m.sql')), p);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /Atomicity guard/);
    });
    it('exits 0 on garbage and prints notes to stdout', () => {
      const p = project();
      assert.equal(cli('garbage', p).status, 0);
      const plain = mkdtempSync(join(tmpdir(), 'plain-'));
      const r = cli(JSON.stringify(bash('git commit -m x')), plain);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /not a git repo/);
    });
  });
});
