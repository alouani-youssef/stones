import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { loadRegistry } from './evaluation-registry.mjs';
import { checkPlan, parseEvaluation, recordKpi, resolveTarget, run, scoreTarget, signKpi, suggestCategory, writePlanEvaluation } from './evaluation.mjs';

const PLAN = 'docs/superpowers/plans/2026-11-25-cache.md';

const DIMENSIONS = [
  {
    id: 'correctness', title: 'Correctness', definition: 'Outputs match expected values.', question: 'Is it right?',
    evidence: 'measured', units: ['diffs'], details: ['tool', 'run_at'], verifier: 'agent', order: 10, since: 1, status: 'active',
  },
  {
    id: 'latency', title: 'Latency', definition: 'Time to result.', question: 'How fast?',
    evidence: 'measured', units: ['ms'], details: ['tool', 'run_at', 'p95', 'count'], verifier: 'agent', order: 20, since: 1, status: 'active',
  },
  {
    id: 'memory', title: 'Memory', definition: 'Peak memory.', question: 'How much memory?',
    evidence: 'measured', units: ['MB'], details: ['tool'], verifier: 'agent', order: 30, since: 1, status: 'active',
  },
  {
    id: 'review', title: 'Review', definition: 'A person judges the output.', question: 'Accepted?',
    evidence: 'signed', verifier: 'human', order: 40, since: 1, status: 'active',
  },
];

const CATEGORIES = {
  cache: {
    title: 'Cache',
    match: ['cache', 'redis', 'ttl'],
    defaults: { load: '50 rps' },
    dimensions: {
      correctness: { kpis: [{ id: 'cache.diffs', metric: 'rows that differ from the source', threshold: { op: '==', value: 0, unit: 'diffs' }, method: 'compare reads', case: 'Case: every key is read after a cold start. Expected: {{op}} {{value}} {{unit}} against the source.' }] },
      latency: { kpis: [{ id: 'cache.p95', metric: 'p95 latency of a cache hit', threshold: { op: '<=', value: 5, unit: 'ms' }, verifier: 'both', method: 'load test', case: 'Case: a warm key is read under {{load}}. Expected: p95 {{op}} {{value}} {{unit}}.' }] },
      memory: { na: 'the cache is an external Redis' },
      review: { kpis: [{ id: 'cache.signoff', metric: 'the reviewer accepts the behaviour', threshold: { op: 'signed' }, method: 'demo', case: 'Case: the cache is demoed to the reviewer. Expected: the reviewer accepts it.' }] },
    },
  },
  api: {
    title: 'API',
    match: ['endpoint', 'route', 'http'],
    dimensions: {
      correctness: { kpis: [{ id: 'api.contract', metric: 'contract mismatches', threshold: { op: '==', value: 0, unit: 'diffs' }, method: 'contract test', case: 'Case: every route is called with valid input. Expected: zero contract mismatches.' }] },
      latency: { na: 'not measured' },
      memory: { na: 'not measured' },
      review: { na: 'not reviewed' },
    },
  },
};

function writeFile(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function registryDir({ version = 1, dimensions = DIMENSIONS, categories = CATEGORIES } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stones-eval-registry-'));
  writeFileSync(join(dir, 'dimensions.json'), JSON.stringify({ version, dimensions }));
  writeFileSync(join(dir, 'categories.json'), JSON.stringify({ version, categories }));
  return dir;
}

function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stones-eval-')));
  writeFile(root, PLAN, '# Cache plan\n\n## Test Strategy\n\nUnit tests for the cache wrapper.\n\n## Test Cases\n\n- Case: a key is read twice. Expected: the second read hits the cache.\n');
  const dir = registryDir();
  return { root, dir, registry: loadRegistry({ dir, root }) };
}

const read = (root, path = PLAN) => readFileSync(join(root, path), 'utf8');
const cli = (root, dir, ...argv) => {
  const out = [];
  const code = run(argv, { root, log: (l) => out.push(l), error: (l) => out.push(l), registryDir: dir });
  return { code, out: out.join('\n') };
};
const has = (list, pattern) => assert.ok(list.some((p) => pattern.test(p)), `expected ${pattern} in:\n${list.join('\n')}`);

describe('evaluation plan section', () => {
  it('writes the Evaluation section and one tagged case per KPI', () => {
    const { root, registry } = project();
    writePlanEvaluation(root, PLAN, ['cache'], { registry });
    const text = read(root);
    assert.match(text, /^## Evaluation$/m);
    assert.match(text, /^Category: cache$/m);
    assert.match(text, /^Dimensions: v1 \(sha [0-9a-f]{16}\)$/m);
    assert.match(text, /^\| latency \| cache\.p95 \| p95 latency of a cache hit \| <= 5 ms \| both \| measured \|$/m);
    assert.match(text, /^\| review \| cache\.signoff \| .* \| signed \| human \| signed \|$/m);
    assert.match(text, /^- memory: n\/a — the cache is an external Redis$/m);
    assert.equal(text.match(/\[eval:/g).length, 3);
    assert.match(text, /^- Case: a warm key is read under 50 rps\. Expected: p95 <= 5 ms\. \[eval:cache\.p95\]$/m);
    assert.match(text, /^- Case: a key is read twice\. Expected: the second read hits the cache\.$/m);
    assert.ok(text.indexOf('## Evaluation') < text.indexOf('## Test Strategy'), 'inserted before the test strategy');
    const parsed = parseEvaluation(text);
    assert.equal(parsed.category, 'cache');
    assert.equal(parsed.edited, false);
    assert.deepEqual(parsed.kpis.map((k) => k.id), ['cache.diffs', 'cache.p95', 'cache.signoff']);
    assert.deepEqual(parsed.kpis[1], { dimension: 'latency', id: 'cache.p95', metric: 'p95 latency of a cache hit', op: '<=', value: 5, unit: 'ms', verifier: 'both', evidence: 'measured' });
  });

  it('is byte-identical when run twice', () => {
    const { root, registry } = project();
    writePlanEvaluation(root, PLAN, ['cache'], { registry });
    const first = read(root);
    writePlanEvaluation(root, PLAN, ['cache'], { registry });
    assert.equal(read(root), first);
  });

  it('keeps Override: and NA: lines and applies them', () => {
    const { root, registry } = project();
    writePlanEvaluation(root, PLAN, ['cache'], { registry });
    const withLines = read(root).replace('## Evaluation\n', '## Evaluation\n\nOverride: cache.diffs == 1 diffs — legacy rows differ by design\nNA: cache.signoff — internal tool, nobody to demo to\n');
    writeFile(root, PLAN, withLines);
    writePlanEvaluation(root, PLAN, ['cache'], { registry });
    const text = read(root);
    assert.match(text, /^Override: cache\.diffs == 1 diffs — legacy rows differ by design$/m);
    assert.match(text, /^\| correctness \| cache\.diffs \| .* \| == 1 diffs \| agent \| measured \|$/m);
    assert.match(text, /^Applied: cache\.diffs == 0 diffs → == 1 diffs \(task: legacy rows differ by design\)$/m);
    assert.doesNotMatch(text, /\| cache\.signoff \|/);
    assert.doesNotMatch(text, /\[eval:cache\.signoff\]/);
    assert.match(text, /^- review \/ cache\.signoff: n\/a \(task\) — internal tool, nobody to demo to$/m);
    assert.deepEqual(checkPlan(root, PLAN, { registry }).problems, []);
  });

  it('refuses more than one category', () => {
    const { root, dir } = project();
    const result = cli(root, dir, 'plan', PLAN, '--category', 'cache', '--category', 'api');
    assert.equal(result.code, 1);
    assert.match(result.out, /a task is atomic: split it into one task per category/);
    assert.doesNotMatch(read(root), /## Evaluation/);
  });

  it('writes through the CLI and reports READY from check', () => {
    const { root, dir } = project();
    assert.equal(cli(root, dir, 'plan', PLAN, '--category', 'cache').code, 0);
    const check = cli(root, dir, 'check', PLAN, '--category', 'cache');
    assert.equal(check.code, 0, check.out);
    assert.match(check.out, /READY/);
  });

  it('check passes on a generated plan and names each problem otherwise', () => {
    const { root, registry } = project();
    has(checkPlan(root, PLAN, { registry }).problems, /no ## Evaluation section; run .* plan/);
    writePlanEvaluation(root, PLAN, ['cache'], { registry });
    assert.deepEqual(checkPlan(root, PLAN, { registry, category: 'cache' }).problems, []);
    has(checkPlan(root, PLAN, { registry, category: 'api' }).problems, /Category: cache in the plan, but the task says api/);
    const generated = read(root);

    writeFile(root, PLAN, generated.replace(/^- .*\[eval:cache\.diffs\]\n/m, ''));
    has(checkPlan(root, PLAN, { registry }).problems, /cache\.diffs has no \[eval:cache\.diffs\] case under ## Test Cases/);

    writeFile(root, PLAN, generated.replace('## Evaluation\n', '## Evaluation\n\nNA: cache.nope — not needed here\n'));
    has(checkPlan(root, PLAN, { registry }).problems, /NA: cache\.nope is not a KPI of cache/);

    writeFile(root, PLAN, generated.replace('## Evaluation\n', '## Evaluation\n\nOverride: cache.diffs == 1 diffs\n'));
    has(checkPlan(root, PLAN, { registry }).problems, /Override: cache\.diffs needs a reason after —/);

    writeFile(root, PLAN, generated.replace('## Evaluation\n', '## Evaluation\n\nOverride: cache.diffs == 1 diffs — legacy rows\n'));
    has(checkPlan(root, PLAN, { registry }).problems, /Override:\/NA: lines changed since the section was generated; rerun `evaluation\.mjs plan`/);
  });

  it('check fails when the generated section was edited by hand', () => {
    const { root, registry } = project();
    writePlanEvaluation(root, PLAN, ['cache'], { registry });
    writeFile(root, PLAN, read(root).replace('| == 0 diffs |', '| == 5 diffs |'));
    assert.equal(parseEvaluation(read(root)).edited, true);
    has(checkPlan(root, PLAN, { registry }).problems, /edited by hand; rerun `evaluation\.mjs plan`/);
  });

  it('check holds a plan to its recorded registry version', () => {
    const { root, registry } = project();
    writePlanEvaluation(root, PLAN, ['cache'], { registry });
    const categories = structuredClone(CATEGORIES);
    for (const c of Object.values(categories)) c.dimensions.security = { na: 'no user data' };
    const dimensions = [...DIMENSIONS, { ...DIMENSIONS[0], id: 'security', title: 'Security', order: 50, since: 2, units: ['findings'] }];
    const v2 = loadRegistry({ dir: registryDir({ version: 2, dimensions, categories }), root });
    const result = checkPlan(root, PLAN, { registry: v2 });
    assert.deepEqual(result.problems, []);
    has(result.notes, /registry v2 is newer than the plan's v1; rerun plan and re-approve to include it/);
  });

  it('check notes thresholds that differ from the current registry or project file', () => {
    const { root, dir, registry } = project();
    writePlanEvaluation(root, PLAN, ['cache'], { registry });
    writeFile(root, '.claude/evaluation.json', JSON.stringify({ thresholds: { 'cache.p95': { op: '<=', value: 3, unit: 'ms' } } }));
    const result = checkPlan(root, PLAN, { registry: loadRegistry({ dir, root }) });
    assert.deepEqual(result.problems, []);
    has(result.notes, /thresholds differ from the current registry or \.claude\/evaluation\.json/);
  });

  it('ignores headings inside code fences', () => {
    const { root, registry } = project();
    writeFile(root, PLAN, read(root).replace('## Test Strategy', '```markdown\n## Evaluation\n```\n\n## Test Strategy'));
    writePlanEvaluation(root, PLAN, ['cache'], { registry });
    const text = read(root);
    assert.match(text, /```markdown\n## Evaluation\n```/);
    assert.equal(text.match(/^Category: cache$/gm).length, 1);
    assert.deepEqual(checkPlan(root, PLAN, { registry }).problems, []);
  });

  it('suggests the category whose keywords the spec mentions most', () => {
    const { registry } = project();
    assert.equal(suggestCategory('Put a Redis cache with a TTL in front of the endpoint.', registry)[0].category, 'cache');
    assert.deepEqual(suggestCategory('Rename a variable.', registry), [{ category: 'general', hits: 0 }]);
  });

  it('prints a plain error when the plan does not exist', () => {
    const { root, dir } = project();
    const result = cli(root, dir, 'check', 'docs/nope.md');
    assert.equal(result.code, 1);
    assert.match(result.out, /docs\/nope\.md does not exist/);
    assert.ok(!existsSync(join(root, 'docs/nope.md')));
  });
});

const P95 = { tool: 'autocannon', tool_version: '7.15.0', run_at: '2026-11-25T10:00:00Z', p50: 2.1, p95: 3.8, p99: 4.6, count: 5000, environment: 'm2 / node 22', samples: [3.1, 3.8, 4.6] };
const STORE = 'docs/superpowers/plans/2026-11-25-cache.eval.json';

function planned() {
  const p = project();
  writePlanEvaluation(p.root, PLAN, ['cache'], { registry: p.registry });
  writeFile(p.root, 'results/p95.json', JSON.stringify(P95));
  writeFile(p.root, 'results/diffs.json', JSON.stringify({ tool: 'compare.mjs', run_at: '2026-11-25T10:00:00Z' }));
  return p;
}
const diffs = (p, value = '0') => recordKpi(p.root, PLAN, 'cache.diffs', value, { evidence: 'node compare.mjs', details: 'results/diffs.json', registry: p.registry });
const p95 = (p, value = '3.8') => recordKpi(p.root, PLAN, 'cache.p95', value, { evidence: 'npx autocannon -c 50 http://localhost:3000/p/1', details: 'results/p95.json', registry: p.registry });

describe('evaluation records and scoring', () => {
  it('refuses a record without evidence, without details, or with a non-number', () => {
    const p = planned();
    assert.throws(() => recordKpi(p.root, PLAN, 'cache.p95', '3.8', { evidence: '', details: 'results/p95.json', registry: p.registry }), /--evidence is required/);
    assert.throws(() => recordKpi(p.root, PLAN, 'cache.p95', '3.8', { evidence: 'autocannon', registry: p.registry }), /cache\.p95 is measured: pass --details/);
    for (const bad of ['3.8ms', '', 'NaN']) {
      assert.throws(() => p95(p, bad), /value must be a number in ms/);
    }
    assert.ok(!existsSync(join(p.root, STORE)));
  });

  it('refuses details files that are missing, not JSON, or lack the dimension fields', () => {
    const p = planned();
    const rec = (details) => recordKpi(p.root, PLAN, 'cache.p95', '3.8', { evidence: 'autocannon', details, registry: p.registry });
    assert.throws(() => rec('results/none.json'), /results\/none\.json does not exist/);
    writeFile(p.root, 'results/bad.json', '{ nope');
    assert.throws(() => rec('results/bad.json'), /results\/bad\.json is not JSON/);
    writeFile(p.root, 'results/thin.json', JSON.stringify({ tool: 'autocannon', run_at: 'now' }));
    assert.throws(() => rec('results/thin.json'), /cache\.p95: details missing p95, count/);
    assert.ok(!existsSync(join(p.root, STORE)));
  });

  it('refuses unknown KPI ids and lists the valid ones', () => {
    const p = planned();
    const result = cli(p.root, p.dir, 'record', PLAN, 'cache.nope', '1', '--evidence', 'x');
    assert.equal(result.code, 1);
    assert.match(result.out, /unknown KPI 'cache\.nope'; the plan's KPIs: cache\.diffs, cache\.p95, cache\.signoff/);
  });

  it('refuses to record a signed KPI and to sign an agent-only KPI', () => {
    const p = planned();
    assert.throws(() => recordKpi(p.root, PLAN, 'cache.signoff', '1', { evidence: 'x', registry: p.registry }), /cache\.signoff is signed: use `sign`/);
    assert.throws(() => signKpi(p.root, PLAN, 'cache.diffs', 'pass'), /cache\.diffs is checked by the agent: use `record`/);
    assert.throws(() => signKpi(p.root, PLAN, 'cache.signoff', 'ok'), /verdict must be pass or fail/);
  });

  it('stores the value with its full details', () => {
    const p = planned();
    p95(p);
    const store = JSON.parse(read(p.root, STORE));
    assert.equal(store.entries['cache.p95'].record.value, 3.8);
    assert.equal(store.entries['cache.p95'].record.unit, 'ms');
    assert.equal(store.entries['cache.p95'].record.details.count, 5000);
    const { markdown } = scoreTarget(p.root, PLAN, { registry: p.registry });
    assert.match(markdown, /^- p95: 3\.8$/m);
    assert.match(markdown, /^- tool: autocannon$/m);
    assert.match(markdown, /^- samples: \[3 values\]$/m);
    assert.match(markdown, /npx autocannon -c 50/);
  });

  it('is PENDING while an agent KPI has no record, and names it', () => {
    const p = planned();
    diffs(p);
    const result = scoreTarget(p.root, PLAN, { registry: p.registry });
    assert.equal(result.verdict, 'PENDING');
    assert.equal(result.rows.find((r) => r.id === 'cache.p95').status, 'waiting');
    assert.match(result.markdown, /\| cache\.p95 \| <= 5 ms \| — \| agent \| waiting \|/);
    assert.equal(cli(p.root, p.dir, 'score', PLAN).code, 1);
  });

  it('is PASS with human checks unsigned or failed, and lists them as advisory', () => {
    const p = planned();
    diffs(p);
    p95(p);
    signKpi(p.root, PLAN, 'cache.signoff', 'fail', { note: 'wants a TTL per tenant' });
    const result = scoreTarget(p.root, PLAN, { registry: p.registry });
    assert.equal(result.verdict, 'PASS');
    assert.match(result.markdown, /## Human review \(advisory\)/);
    assert.match(result.markdown, /\| cache\.p95 \| both \| waiting \|/);
    assert.match(result.markdown, /\| cache\.signoff \| human \| fail \| wants a TTL per tenant \|/);
    assert.match(result.markdown, /Verdict: \*\*PASS\*\* · human review \(advisory\): 1 waiting, 1 failed/);
    assert.equal(cli(p.root, p.dir, 'score', PLAN).code, 0);
    assert.ok(existsSync(join(p.root, 'docs/superpowers/plans/2026-11-25-cache.eval.md')));
  });

  it('is FAIL when a value breaks its threshold, with threshold and value', () => {
    const p = planned();
    diffs(p);
    p95(p, '7.2');
    const result = scoreTarget(p.root, PLAN, { registry: p.registry });
    assert.equal(result.verdict, 'FAIL');
    assert.match(result.markdown, /\| cache\.p95 \| <= 5 ms \| 7\.2 ms \| agent \| fail \|/);
    assert.match(result.markdown, /Verdict: \*\*FAIL\*\* — 1 KPI failing/);
  });

  it('treats entries recorded against an older plan as stale', () => {
    const p = planned();
    diffs(p);
    p95(p);
    writeFile(p.root, PLAN, read(p.root).replace('Unit tests for the cache wrapper.', 'Unit and load tests for the cache wrapper.'));
    const result = scoreTarget(p.root, PLAN, { registry: p.registry });
    assert.deepEqual(result.rows.filter((r) => r.status !== 'n/a').map((r) => r.status), ['stale', 'stale']);
    assert.equal(result.verdict, 'PENDING');
  });

  it('fails the verdict when the plan itself does not pass check', () => {
    const p = planned();
    diffs(p);
    p95(p);
    writeFile(p.root, PLAN, read(p.root).replace('| == 0 diffs |', '| == 9 diffs |'));
    const result = scoreTarget(p.root, PLAN, { registry: p.registry });
    assert.equal(result.verdict, 'FAIL');
    has(result.problems, /edited by hand/);
  });

  it('scores a deprecated dimension still present in an old plan', () => {
    const p = planned();
    diffs(p);
    p95(p);
    const dimensions = DIMENSIONS.map((d) => (d.id === 'latency' ? { ...d, status: 'deprecated' } : d));
    const categories = structuredClone(CATEGORIES);
    const registry = loadRegistry({ dir: registryDir({ dimensions, categories }), root: p.root });
    const result = scoreTarget(p.root, PLAN, { registry });
    assert.equal(result.rows.find((r) => r.id === 'cache.p95').status, 'pass');
  });

  it('resolves a task id to its plan, category and evaluation files', () => {
    const p = planned();
    writeFile(p.root, 'context/tasks/list/0007-cache.md', `# 0007 Cache product lookups\n\nStatus: current\nCategory: cache\n\n## Spec and plan\n\nPlan: ${PLAN}\n`);
    const target = resolveTarget(p.root, '7');
    assert.deepEqual(target, {
      plan: PLAN, category: 'cache', taskId: '0007', title: '0007 Cache product lookups',
      store: 'context/tasks/evaluations/0007.json', scorecard: 'context/tasks/evaluations/0007.md',
    });
    recordKpi(p.root, '7', 'cache.diffs', '0', { evidence: 'node compare.mjs', details: 'results/diffs.json', registry: p.registry });
    assert.ok(existsSync(join(p.root, 'context/tasks/evaluations/0007.json')));
    assert.match(scoreTarget(p.root, '7', { registry: p.registry }).markdown, /^# Evaluation: 0007 Cache product lookups$/m);
    assert.throws(() => resolveTarget(p.root, '9'), /task 0009 is not in context\/tasks\/list/);
  });

  it('records and signs through the CLI', () => {
    const p = planned();
    const rec = cli(p.root, p.dir, 'record', PLAN, 'cache.p95', '3.8', '--evidence', 'autocannon', '--details', 'results/p95.json');
    assert.equal(rec.code, 0, rec.out);
    assert.match(rec.out, /recorded cache\.p95 = 3\.8 ms \(pass\)/);
    const sign = cli(p.root, p.dir, 'sign', PLAN, 'cache.signoff', 'pass', '--note', 'looks right');
    assert.equal(sign.code, 0, sign.out);
    assert.equal(JSON.parse(read(p.root, STORE)).entries['cache.signoff'].sign.note, 'looks right');
  });
});

describe('evaluation review fixes', () => {
  it('reads and regenerates plans with CRLF line endings', () => {
    const { root, registry } = project();
    writePlanEvaluation(root, PLAN, ['cache'], { registry });
    writeFile(root, PLAN, read(root).replace(/\n/g, '\r\n'));
    assert.deepEqual(checkPlan(root, PLAN, { registry }).problems, []);
    writePlanEvaluation(root, PLAN, ['cache'], { registry });
    assert.equal(read(root).match(/evaluation:begin/g).length, 1);
    assert.doesNotMatch(read(root), /\r/);
  });

  it('refuses overrides whose unit, op or value does not fit the KPI', () => {
    const { root, registry } = project();
    writePlanEvaluation(root, PLAN, ['cache'], { registry });
    const generated = read(root);
    const withLine = (line) => writeFile(root, PLAN, generated.replace('## Evaluation\n', `## Evaluation\n\n${line}\n`));
    withLine('Override: cache.p95 <= 10 banana — slower is fine');
    assert.throws(() => writePlanEvaluation(root, PLAN, ['cache'], { registry }), /Override: cache\.p95: unit 'banana' not in latency units \(ms\)/);
    has(checkPlan(root, PLAN, { registry }).problems, /Override: cache\.p95: unit 'banana' not in latency units/);
    withLine('Override: cache.p95 >= 3 ms — flipped');
    assert.throws(() => writePlanEvaluation(root, PLAN, ['cache'], { registry }), /Override: cache\.p95: op '>=' differs from the KPI's '<='/);
    withLine('Override: cache.signoff <= 3 ms — not measurable');
    assert.throws(() => writePlanEvaluation(root, PLAN, ['cache'], { registry }), /Override: cache\.signoff is signed: it has no threshold to change/);
  });

  it('validates the project file in check and plan', () => {
    const { root, dir } = project();
    writePlanEvaluation(root, PLAN, ['cache'], { registry: loadRegistry({ dir, root }) });
    writeFile(root, '.claude/evaluation.json', JSON.stringify({ dimensions: [{ ...DIMENSIONS[1] }] }));
    has(checkPlan(root, PLAN, { registry: loadRegistry({ dir, root }) }).problems, /project dimension 'latency' clashes with the registry/);
    writeFile(root, '.claude/evaluation.json', JSON.stringify({ thresholds: { 'cache.p95': { op: '<=', value: 'lots', unit: 'ms' } } }));
    has(checkPlan(root, PLAN, { registry: loadRegistry({ dir, root }) }).problems, /project threshold cache\.p95: value must be a number/);
    assert.throws(() => writePlanEvaluation(root, PLAN, ['cache'], { registry: loadRegistry({ dir, root }) }), /project threshold cache\.p95/);
    writeFile(root, '.claude/evaluation.json', JSON.stringify({ na: { 'cache.nope': 'gone' } }));
    has(checkPlan(root, PLAN, { registry: loadRegistry({ dir, root }) }).problems, /project na cache\.nope is not a KPI/);
  });

  it('requires a project dimension to be covered by the category in use, and lets the project cover it', () => {
    const { root, dir } = project();
    const security = { ...DIMENSIONS[0], id: 'security', title: 'Security', order: 50, units: ['findings'] };
    writeFile(root, '.claude/evaluation.json', JSON.stringify({ dimensions: [security] }));
    assert.throws(() => writePlanEvaluation(root, PLAN, ['cache'], { registry: loadRegistry({ dir, root }) }), /cache: project dimension 'security' needs kpis or na/);
    writeFile(root, '.claude/evaluation.json', JSON.stringify({
      dimensions: [security],
      categories: { cache: { dimensions: { security: { kpis: [{ id: 'cache.findings', metric: 'scanner findings', threshold: { op: '==', value: 0, unit: 'findings' }, method: 'scan', case: 'Case: the scanner runs on the cache code. Expected: zero findings reported.' }] } } } },
    }));
    const parsed = writePlanEvaluation(root, PLAN, ['cache'], { registry: loadRegistry({ dir, root }) });
    assert.ok(parsed.kpis.some((k) => k.id === 'cache.findings'));
    writeFile(root, '.claude/evaluation.json', JSON.stringify({ categories: { cache: { dimensions: { latency: { na: 'not needed' } } } } }));
    has(checkPlan(root, PLAN, { registry: loadRegistry({ dir, root }) }).problems, /project cannot redefine cache\.latency/);
  });
});
