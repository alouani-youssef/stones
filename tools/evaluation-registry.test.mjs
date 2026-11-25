import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { activeDimensions, loadRegistry, registryProblems, resolveCategory } from './evaluation-registry.mjs';

const DIMENSIONS = () => [
  {
    id: 'correctness', title: 'Correctness', definition: 'Outputs match expected values.', question: 'Is the output right?',
    evidence: 'measured', units: ['diffs'], details: ['tool', 'run_at'], verifier: 'agent', order: 10, since: 1, status: 'active',
  },
  {
    id: 'review', title: 'Review', definition: 'A person judges the output.', question: 'Does a person accept it?',
    evidence: 'signed', verifier: 'human', order: 20, since: 1, status: 'active',
  },
];

const CATEGORIES = () => ({
  cache: {
    title: 'Cache',
    match: ['cache', 'redis', 'ttl'],
    defaults: { load: '50 rps' },
    dimensions: {
      correctness: {
        kpis: [{
          id: 'cache.diffs', metric: 'rows that differ from the source', threshold: { op: '==', value: 0, unit: 'diffs' },
          method: 'compare reads with the source', verifier: 'agent',
          case: 'Case: every key is read after a cold start. Expected: == {{value}} {{unit}} against the source.',
        }],
      },
      review: {
        kpis: [{
          id: 'cache.signoff', metric: 'the person accepts the cache behaviour', threshold: { op: 'signed' },
          method: 'demo the cache', case: 'Case: the cache is demoed to the reviewer. Expected: the reviewer accepts it.',
        }],
      },
    },
  },
});

function fixture({ version = 1, dimensions = DIMENSIONS(), categories = CATEGORIES(), project } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stones-registry-'));
  writeFileSync(join(dir, 'dimensions.json'), JSON.stringify({ version, dimensions }));
  writeFileSync(join(dir, 'categories.json'), JSON.stringify({ version, categories }));
  let root;
  if (project) {
    root = mkdtempSync(join(tmpdir(), 'stones-project-'));
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude/evaluation.json'), JSON.stringify(project));
  }
  return loadRegistry({ dir, root });
}

const has = (problems, pattern) => assert.ok(problems.some((p) => pattern.test(p)), `expected ${pattern} in:\n${problems.join('\n')}`);

describe('evaluation registry', () => {
  it('loads a valid registry with no problems', () => {
    assert.deepEqual(registryProblems(fixture()), []);
  });

  it('names each category that does not cover an active dimension', () => {
    const categories = CATEGORIES();
    delete categories.cache.dimensions.review;
    has(registryProblems(fixture({ categories })), /cache: dimension 'review' needs kpis or na/);
  });

  it('rejects a dimension key that is not in the registry', () => {
    const categories = CATEGORIES();
    categories.cache.dimensions.speed = { na: 'not measured' };
    has(registryProblems(fixture({ categories })), /cache: unknown dimension 'speed'/);
  });

  it('rejects a threshold op or unit that does not fit the dimension', () => {
    const signed = CATEGORIES();
    signed.cache.dimensions.correctness.kpis[0].threshold = { op: 'signed' };
    has(registryProblems(fixture({ categories: signed })), /cache.diffs: op 'signed' not allowed for measured dimension 'correctness'/);
    const unit = CATEGORIES();
    unit.cache.dimensions.correctness.kpis[0].threshold.unit = 'ms';
    has(registryProblems(fixture({ categories: unit })), /cache.diffs: unit 'ms' not in correctness units \(diffs\)/);
  });

  it('rejects duplicate dimension ids, duplicate orders, duplicate kpi ids and since > version', () => {
    const dupId = DIMENSIONS();
    dupId.push({ ...dupId[0], order: 30 });
    has(registryProblems(fixture({ dimensions: dupId })), /duplicate dimension id 'correctness'/);
    const dupOrder = DIMENSIONS();
    dupOrder[1].order = 10;
    has(registryProblems(fixture({ dimensions: dupOrder })), /review: order 10 is already used by correctness/);
    const dupKpi = CATEGORIES();
    dupKpi.cache.dimensions.review.kpis[0].id = 'cache.diffs';
    has(registryProblems(fixture({ categories: dupKpi })), /duplicate kpi id 'cache.diffs'/);
    const future = DIMENSIONS();
    future[1].since = 3;
    has(registryProblems(fixture({ dimensions: future })), /review: since 3 is newer than registry version 1/);
  });

  it('rejects a project dimension that reuses a registry id', () => {
    const registry = fixture({ project: { dimensions: [{ ...DIMENSIONS()[0] }] } });
    has(registryProblems(registry), /project dimension 'correctness' clashes with the registry/);
  });

  it('accepts a new dimension without code changes', () => {
    const dimensions = DIMENSIONS();
    dimensions.push({
      id: 'security', title: 'Security', definition: 'No known vulnerability is introduced.', question: 'Is it safe?',
      evidence: 'measured', units: ['findings'], details: ['tool'], verifier: 'agent', order: 15, since: 2, status: 'active',
    });
    const categories = CATEGORIES();
    categories.cache.dimensions.security = { na: 'the cache stores no user data' };
    const registry = fixture({ version: 2, dimensions, categories });
    assert.deepEqual(registryProblems(registry), []);
    assert.deepEqual(activeDimensions(registry).map((d) => d.id), ['correctness', 'security', 'review']);
    assert.deepEqual(resolveCategory(registry, 'cache').na, [{ dimension: 'security', reason: 'the cache stores no user data' }]);
  });

  it('drops deprecated dimensions from resolution but keeps them loadable', () => {
    const dimensions = DIMENSIONS();
    dimensions[1].status = 'deprecated';
    const categories = CATEGORIES();
    delete categories.cache.dimensions.review;
    const registry = fixture({ dimensions, categories });
    assert.deepEqual(registryProblems(registry), []);
    assert.ok(registry.dimensions.some((d) => d.id === 'review'));
    assert.ok(!resolveCategory(registry, 'cache').kpis.some((k) => k.dimension === 'review'));
  });

  it('applies project then task overrides and records each one', () => {
    const registry = fixture({ project: { thresholds: { 'cache.diffs': { op: '==', value: 1, unit: 'diffs' } } } });
    const resolved = resolveCategory(registry, 'cache', {
      overrides: [{ id: 'cache.diffs', op: '==', value: 0, unit: 'diffs', reason: 'source of truth must match' }],
    });
    const kpi = resolved.kpis.find((k) => k.id === 'cache.diffs');
    assert.equal(kpi.value, 0);
    assert.deepEqual(resolved.applied.map((a) => a.source), ['project', 'task']);
    assert.equal(resolved.applied[0].from, '== 0 diffs');
    assert.equal(resolved.applied[0].to, '== 1 diffs');
  });

  it('removes a KPI marked n/a by the task and lists it', () => {
    const resolved = resolveCategory(fixture(), 'cache', { na: [{ id: 'cache.signoff', reason: 'internal tool' }] });
    assert.ok(!resolved.kpis.some((k) => k.id === 'cache.signoff'));
    assert.deepEqual(resolved.na, [{ dimension: 'review', id: 'cache.signoff', source: 'task', reason: 'internal tool' }]);
  });

  it('fills {{...}} placeholders in cases from the kpi and category defaults', () => {
    const categories = CATEGORIES();
    categories.cache.dimensions.correctness.kpis[0].case = 'Case: keys are read under {{load}}. Expected: <= {{value}}{{unit}} under {{load}}.';
    const kpi = resolveCategory(fixture({ categories }), 'cache').kpis[0];
    assert.equal(kpi.case, 'Case: keys are read under 50 rps. Expected: <= 0diffs under 50 rps.');
    const unknown = CATEGORIES();
    unknown.cache.dimensions.correctness.kpis[0].case = 'Case: keys are read under {{nope}}. Expected: nothing differs at all.';
    has(registryProblems(fixture({ categories: unknown })), /cache.diffs: unknown placeholder \{\{nope\}\}/);
  });

  it('resolves KPIs in dimension order with their verifier and evidence', () => {
    const [a, b] = resolveCategory(fixture(), 'cache').kpis;
    assert.deepEqual([a.id, a.dimension, a.op, a.value, a.unit, a.verifier, a.evidence], ['cache.diffs', 'correctness', '==', 0, 'diffs', 'agent', 'measured']);
    assert.deepEqual([b.id, b.op, b.verifier, b.evidence], ['cache.signoff', 'signed', 'human', 'signed']);
  });

  it('throws a clear error for an unknown category', () => {
    assert.throws(() => resolveCategory(fixture(), 'api'), /unknown category 'api'; available: cache/);
  });

  it('throws a clear error when the skill is not installed or a file is not JSON', () => {
    const empty = mkdtempSync(join(tmpdir(), 'stones-registry-'));
    assert.throws(() => loadRegistry({ dir: empty }), /install the evaluating-outputs skill/);
    writeFileSync(join(empty, 'dimensions.json'), '{ nope');
    writeFileSync(join(empty, 'categories.json'), '{}');
    assert.throws(() => loadRegistry({ dir: empty }), /dimensions.json: /);
  });
});

describe('evaluation registry review fixes', () => {
  it('rejects a signed KPI that only the agent would check', () => {
    const categories = CATEGORIES();
    categories.cache.dimensions.review.kpis[0].verifier = 'agent';
    has(registryProblems(fixture({ categories })), /cache\.signoff: a signed KPI needs verifier human or both/);
  });
});
