// The evaluation registry: the dimensions every task output is judged on
// (dimensions.json) and, per task category, the KPIs that measure them
// (categories.json), both in the evaluating-outputs skill. A project can add
// dimensions and categories and change thresholds in .claude/evaluation.json.
//
// Nothing here names a dimension: adding one is a registry entry, coverage in
// every category, and a section in dimensions.md.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export class EvaluationError extends Error {}

// skills/evaluating-outputs in the package; .claude/skills/evaluating-outputs
// when this file is installed in .claude/tools.
export const REGISTRY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'evaluating-outputs');
export const PROJECT_FILE = '.claude/evaluation.json';

const EVIDENCE = ['measured', 'signed', 'any'];
const VERIFIERS = ['agent', 'human', 'both'];
const STATUSES = ['active', 'deprecated'];
const NUMERIC_OPS = ['<=', '>=', '=='];
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PLACEHOLDER = /\{\{(\w+)\}\}/g;
const CASE = /^Case: .{8,} Expected: .{8,}$/;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new EvaluationError(`${file.split('/').pop()}: ${error.message}`);
  }
}

export function loadRegistry({ dir = REGISTRY_DIR, root } = {}) {
  if (!existsSync(join(dir, 'dimensions.json'))) {
    throw new EvaluationError('install the evaluating-outputs skill (npx ai-stones init)');
  }
  const dims = readJson(join(dir, 'dimensions.json'));
  const cats = existsSync(join(dir, 'categories.json')) ? readJson(join(dir, 'categories.json')) : { categories: {} };
  const projectPath = root ? join(root, PROJECT_FILE) : null;
  const project = projectPath && existsSync(projectPath) ? readJson(projectPath) : null;
  const problems = [];
  const dimensions = [...(dims.dimensions ?? [])];
  const builtIn = new Set(dimensions.map((d) => d.id));
  for (const d of project?.dimensions ?? []) {
    if (builtIn.has(d.id)) problems.push(`project dimension '${d.id}' clashes with the registry`);
    else dimensions.push({ ...d, project: true });
  }
  const categories = { ...(cats.categories ?? {}) };
  for (const [id, c] of Object.entries(project?.categories ?? {})) {
    if (categories[id]) problems.push(`project category '${id}' clashes with the registry`);
    else categories[id] = { ...c, project: true };
  }
  return { version: dims.version, dimensions, categories, project, loadProblems: problems };
}

export function activeDimensions(registry) {
  return registry.dimensions.filter((d) => d.status === 'active').sort((a, b) => a.order - b.order);
}

const dimensionOf = (registry, id) => registry.dimensions.find((d) => d.id === id);
const kpiEvidence = (dimension, kpi) => (dimension.evidence === 'any' ? kpi.evidence : dimension.evidence);
export const formatThreshold = (t) => (t.op === 'signed' ? 'signed' : `${t.op} ${t.value} ${t.unit}`);

function dimensionProblems(registry) {
  const problems = [];
  const ids = new Set();
  const orders = new Map();
  for (const d of registry.dimensions) {
    const name = d.id ?? '(no id)';
    if (!d.id || !ID.test(d.id)) problems.push(`${name}: id must be kebab-case`);
    if (ids.has(d.id)) problems.push(`duplicate dimension id '${d.id}'`);
    ids.add(d.id);
    for (const field of ['title', 'definition', 'question']) if (!d[field]) problems.push(`${name}: ${field} is required`);
    if (!EVIDENCE.includes(d.evidence)) problems.push(`${name}: evidence must be one of ${EVIDENCE.join(', ')}`);
    if (!VERIFIERS.includes(d.verifier)) problems.push(`${name}: verifier must be one of ${VERIFIERS.join(', ')}`);
    if (!STATUSES.includes(d.status)) problems.push(`${name}: status must be one of ${STATUSES.join(', ')}`);
    if (!Number.isInteger(d.order)) problems.push(`${name}: order must be an integer`);
    else if (orders.has(d.order)) problems.push(`${name}: order ${d.order} is already used by ${orders.get(d.order)}`);
    else orders.set(d.order, name);
    if (!Number.isInteger(d.since)) problems.push(`${name}: since must be an integer`);
    else if (d.since > registry.version) problems.push(`${name}: since ${d.since} is newer than registry version ${registry.version}`);
    if (d.evidence === 'measured') {
      if (!Array.isArray(d.units) || d.units.length === 0) problems.push(`${name}: a measured dimension needs units`);
      if (!Array.isArray(d.details)) problems.push(`${name}: a measured dimension needs a details list`);
    }
  }
  return problems;
}

function kpiProblems(registry, category, dimension, kpi, seen) {
  const problems = [];
  const name = kpi.id ?? `${category.id}.(no id)`;
  if (!kpi.id || !kpi.id.startsWith(`${category.id}.`)) problems.push(`${name}: kpi id must start with '${category.id}.'`);
  if (seen.has(kpi.id)) problems.push(`duplicate kpi id '${kpi.id}'`);
  seen.add(kpi.id);
  if (!kpi.metric) problems.push(`${name}: metric is required`);
  if (!kpi.method) problems.push(`${name}: method is required`);
  if (kpi.verifier && !VERIFIERS.includes(kpi.verifier)) problems.push(`${name}: verifier must be one of ${VERIFIERS.join(', ')}`);
  const evidence = kpiEvidence(dimension, kpi);
  if (dimension.evidence === 'any' && !['measured', 'signed'].includes(kpi.evidence)) {
    problems.push(`${name}: set evidence to measured or signed (dimension '${dimension.id}' takes either)`);
  }
  const t = kpi.threshold ?? {};
  if (t.op === 'signed') {
    if (evidence !== 'signed') problems.push(`${name}: op 'signed' not allowed for measured dimension '${dimension.id}'`);
  } else if (NUMERIC_OPS.includes(t.op)) {
    if (evidence === 'signed') problems.push(`${name}: op '${t.op}' not allowed for signed evidence`);
    if (typeof t.value !== 'number') problems.push(`${name}: threshold value must be a number`);
    if (Array.isArray(dimension.units) && !dimension.units.includes(t.unit)) {
      problems.push(`${name}: unit '${t.unit}' not in ${dimension.id} units (${dimension.units.join(', ')})`);
    } else if (!t.unit) problems.push(`${name}: threshold unit is required`);
  } else {
    problems.push(`${name}: threshold op must be one of ${[...NUMERIC_OPS, 'signed'].join(', ')}`);
  }
  const vars = placeholderValues(category, kpi);
  for (const [, key] of String(kpi.case ?? '').matchAll(PLACEHOLDER)) {
    if (!(key in vars)) problems.push(`${name}: unknown placeholder {{${key}}}`);
  }
  if (!CASE.test(fillCase(category, kpi))) problems.push(`${name}: case must read "Case: <condition>. Expected: <outcome>."`);
  return problems;
}

export function registryProblems(registry) {
  const problems = [...registry.loadProblems, ...dimensionProblems(registry)];
  const active = activeDimensions(registry);
  const seen = new Set();
  for (const [id, raw] of Object.entries(registry.categories)) {
    const category = { ...raw, id };
    if (!category.title) problems.push(`${id}: title is required`);
    const covered = category.dimensions ?? {};
    for (const key of Object.keys(covered)) {
      if (!dimensionOf(registry, key)) problems.push(`${id}: unknown dimension '${key}'`);
    }
    for (const d of active) {
      const entry = covered[d.id];
      if (!entry || !((entry.kpis?.length ?? 0) > 0 || (typeof entry.na === 'string' && entry.na.trim()))) {
        problems.push(`${id}: dimension '${d.id}' needs kpis or na`);
        continue;
      }
      for (const kpi of entry.kpis ?? []) problems.push(...kpiProblems(registry, category, d, kpi, seen));
    }
  }
  return problems;
}

function placeholderValues(category, kpi) {
  const t = kpi.threshold ?? {};
  return { ...(category.defaults ?? {}), ...(t.op === 'signed' ? {} : { value: t.value, unit: t.unit, op: t.op }) };
}

function fillCase(category, kpi, threshold = kpi.threshold) {
  const vars = placeholderValues(category, { ...kpi, threshold });
  return String(kpi.case ?? '').replace(PLACEHOLDER, (m, key) => (key in vars ? String(vars[key]) : m));
}

// The KPIs one category asks of a task, with project then task overrides
// applied and every change listed, in dimension order.
export function resolveCategory(registry, categoryId, { overrides = [], na = [] } = {}) {
  const raw = registry.categories[categoryId];
  if (!raw) {
    throw new EvaluationError(`unknown category '${categoryId}'; available: ${Object.keys(registry.categories).sort().join(', ')}`);
  }
  const category = { ...raw, id: categoryId };
  const projectThresholds = registry.project?.thresholds ?? {};
  const projectNa = registry.project?.na ?? {};
  const taskOverrides = new Map(overrides.map((o) => [o.id, o]));
  const taskNa = new Map(na.map((n) => [n.id, n.reason]));
  const kpis = [];
  const naList = [];
  const applied = [];
  for (const d of activeDimensions(registry)) {
    const entry = category.dimensions?.[d.id];
    if (!entry) continue;
    if (!entry.kpis?.length) {
      naList.push({ dimension: d.id, reason: entry.na });
      continue;
    }
    for (const kpi of entry.kpis) {
      if (projectNa[kpi.id] || taskNa.has(kpi.id)) {
        const source = taskNa.has(kpi.id) ? 'task' : 'project';
        naList.push({ dimension: d.id, id: kpi.id, source, reason: taskNa.get(kpi.id) ?? projectNa[kpi.id] });
        continue;
      }
      let threshold = kpi.threshold;
      for (const [source, next, reason] of [
        ['project', projectThresholds[kpi.id], 'project .claude/evaluation.json'],
        ['task', taskOverrides.get(kpi.id), taskOverrides.get(kpi.id)?.reason],
      ]) {
        if (!next) continue;
        const to = { op: next.op, value: next.value, unit: next.unit ?? threshold.unit };
        applied.push({ id: kpi.id, source, from: formatThreshold(threshold), to: formatThreshold(to), reason });
        threshold = to;
      }
      kpis.push({
        id: kpi.id,
        dimension: d.id,
        metric: kpi.metric,
        op: threshold.op,
        value: threshold.op === 'signed' ? null : threshold.value,
        unit: threshold.op === 'signed' ? null : threshold.unit,
        verifier: kpi.verifier ?? d.verifier,
        evidence: kpiEvidence(d, kpi),
        method: kpi.method,
        case: fillCase(category, kpi, threshold),
      });
    }
  }
  return { category: categoryId, title: category.title, version: registry.version, kpis, na: naList, applied };
}
