import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { loadRegistry } from './evaluation-registry.mjs';
import { checkPlan, parseEvaluation, run, suggestCategory, writePlanEvaluation } from './evaluation.mjs';

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
