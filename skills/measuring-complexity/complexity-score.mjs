#!/usr/bin/env node
// Turns raw per-function measurements and an import graph into the complexity
// metric set and one 0-100 complexity index. No dependencies; the analyzers
// that produce the input are listed in SKILL.md.
//
//   node complexity-score.mjs metrics.json            score a measurement file
//   node complexity-score.mjs metrics.json --graph docs/graph/project.json
//   node complexity-score.mjs metrics.json --baseline last.json --json
//
// Input (every field optional; precomputed metrics win over raw data):
//   {
//     "functions":  [{ "name": "f", "file": "a.py", "cc": 4, "nesting": 2, "loc": 12 }],
//     "loc": 1840,              // non-blank, non-comment lines of the scope
//     "symbols": 96,            // declared functions, methods, classes, types, exported consts
//     "edges": [["a.py", "b.py"]],
//     "metrics": { "cc_mean": 3.2 }
//   }
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// good: no penalty at or below; limit: full penalty at or above.
export const THRESHOLDS = {
  cc_mean: { good: 4, limit: 10, weight: 0.2 },
  max_nesting_depth: { good: 3, limit: 6, weight: 0.15 },
  lines_per_symbol: { good: 20, limit: 50, weight: 0.15 },
  graph_dependency_entropy: { good: 0.6, limit: 0.9, weight: 0.15 },
  violation_pct: { good: 5, limit: 25, weight: 0.35 },
};
// A function violates when any of these is exceeded.
export const FUNCTION_LIMITS = { cc: 10, nesting: 4, loc: 60 };
export const GRADES = [[20, 'A'], [40, 'B'], [60, 'C'], [80, 'D'], [Infinity, 'E']];

const round = (n, d = 3) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null);

// Normalized Shannon entropy of where internal imports point:
// H = -Σ p_i log2 p_i with p_i = in-degree(i) / |E|, divided by log2 |V|.
// 0 = every import targets one module; 1 = imports spread evenly over all modules.
export function dependencyEntropy(edges) {
  const unique = [...new Set(edges.filter(([a, b]) => a !== b).map(([a, b]) => `${a}\0${b}`))].map((e) => e.split('\0'));
  const nodes = new Set(unique.flat());
  if (unique.length === 0 || nodes.size < 2) return { entropy: 0, normalized: 0, nodes: nodes.size, edges: unique.length };
  const inDegree = new Map();
  for (const [, to] of unique) inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
  let h = 0;
  for (const d of inDegree.values()) {
    const p = d / unique.length;
    h -= p * Math.log2(p);
  }
  return { entropy: h, normalized: h / Math.log2(nodes.size), nodes: nodes.size, edges: unique.length };
}

export function edgesFromGraph(graph) {
  return Object.entries(graph.files ?? {}).flatMap(([file, node]) => (node.imports ?? []).map((dep) => [file, dep]));
}

export function computeMetrics(input) {
  const fns = input.functions ?? [];
  const cc = fns.map((f) => f.cc).filter(Number.isFinite).sort((a, b) => a - b);
  const violating = fns.filter((f) => Object.entries(FUNCTION_LIMITS).some(([k, max]) => Number.isFinite(f[k]) && f[k] > max));
  const loc = input.loc ?? fns.reduce((s, f) => s + (f.loc ?? 0), 0);
  const symbols = input.symbols ?? fns.length;
  const graph = dependencyEntropy(input.edges ?? []);
  const derived = {
    cc_mean: cc.length ? cc.reduce((s, v) => s + v, 0) / cc.length : null,
    cc_p90: percentile(cc, 0.9),
    cc_max: cc.at(-1) ?? null,
    max_nesting_depth: fns.length ? Math.max(...fns.map((f) => f.nesting ?? 0)) : null,
    lines_per_symbol: symbols ? loc / symbols : null,
    graph_dependency_entropy: input.edges ? graph.normalized : null,
    violation_pct: fns.length ? (100 * violating.length) / fns.length : null,
    functions: fns.length,
  };
  return {
    metrics: { ...derived, ...input.metrics },
    graph,
    violations: violating.map((f) => ({ name: f.name, file: f.file, cc: f.cc, nesting: f.nesting, loc: f.loc })),
  };
}

// Each metric becomes a 0-1 penalty between its good and limit values; the
// index is the weighted mean of the penalties that could be measured, × 100.
export function complexityIndex(metrics, thresholds = THRESHOLDS) {
  let total = 0;
  let weights = 0;
  const penalties = {};
  for (const [key, { good, limit, weight }] of Object.entries(thresholds)) {
    const v = metrics[key];
    if (!Number.isFinite(v)) continue;
    penalties[key] = Math.min(1, Math.max(0, (v - good) / (limit - good)));
    total += weight * penalties[key];
    weights += weight;
  }
  const index = weights ? (100 * total) / weights : null;
  return { index, grade: index === null ? null : GRADES.find(([max]) => index < max)[1], penalties, coverage: weights };
}

export function report(input, baseline) {
  const { metrics, graph, violations } = computeMetrics(input);
  const score = complexityIndex(metrics);
  const out = {
    metrics: Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, round(v)])),
    index: round(score.index, 1),
    grade: score.grade,
    penalties: Object.fromEntries(Object.entries(score.penalties).map(([k, v]) => [k, round(v)])),
    measured_weight: round(score.coverage, 2),
    graph: { nodes: graph.nodes, edges: graph.edges, entropy_bits: round(graph.entropy) },
    worst: violations.sort((a, b) => (b.cc ?? 0) - (a.cc ?? 0)).slice(0, 10),
  };
  if (baseline) {
    out.delta = Object.fromEntries(
      Object.keys(THRESHOLDS).concat('index').filter((k) => Number.isFinite(baseline[k] ?? baseline.metrics?.[k]))
        .map((k) => [k, round((k === 'index' ? out.index : out.metrics[k]) - (k === 'index' ? baseline.index : baseline.metrics[k]))]),
    );
  }
  return out;
}

function formatDelta(d) {
  if (!Number.isFinite(d)) return '';
  return `   Δ ${d > 0 ? '+' : ''}${d}`;
}

function formatThresholdLine(key, r) {
  const { good, limit } = THRESHOLDS[key];
  const value = String(r.metrics[key] ?? 'n/a').padStart(8);
  const penalty = r.penalties[key] ?? '-';
  const delta = formatDelta(r.delta?.[key]);
  return `  ${key.padEnd(26)} ${value}   good ≤ ${good}, limit ${limit}   penalty ${penalty}${delta}`;
}

function formatViolation(f) {
  return `  ! ${f.file ?? '?'}:${f.name ?? '?'} cc=${f.cc ?? '-'} nesting=${f.nesting ?? '-'} loc=${f.loc ?? '-'}`;
}

function format(r) {
  const lines = [`Complexity index: ${r.index ?? 'n/a'} (${r.grade ?? 'n/a'}), measured weight ${r.measured_weight}`];
  for (const key of Object.keys(THRESHOLDS)) {
    lines.push(formatThresholdLine(key, r));
  }
  lines.push(`  cc p90 / max               ${r.metrics.cc_p90 ?? 'n/a'} / ${r.metrics.cc_max ?? 'n/a'} over ${r.metrics.functions} functions`);
  for (const f of r.worst) lines.push(formatViolation(f));
  return lines.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const json = args.includes('--json') && args.splice(args.indexOf('--json'), 1);
  const graphPath = opt('--graph');
  const baselinePath = opt('--baseline');
  const input = args[0] ? JSON.parse(readFileSync(args[0], 'utf8')) : {};
  if (graphPath) input.edges = edgesFromGraph(JSON.parse(readFileSync(graphPath, 'utf8')));
  const r = report(input, baselinePath && JSON.parse(readFileSync(baselinePath, 'utf8')));
  console.log(json ? JSON.stringify(r, null, 2) : format(r));
}
