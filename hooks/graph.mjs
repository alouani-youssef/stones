// Code graph hook: the summary layer of the summary-details pattern, applied
// to the codebase. The graph (`.claude/graph/project.json`) holds a compact
// node per source file; the file itself is the detail.
//
//   node graph.mjs read     PostToolUse Read: inject the file's summary,
//                           capability, imports and dependents as context
//   node graph.mjs update   PostToolUse Write|Edit|MultiEdit: re-index the
//                           file and nudge Claude when its summary is
//                           missing or its exports/imports changed since
//                           the summary was written
//   node graph.mjs build    full rebuild of the graph
//   node graph.mjs mermaid  print the capability graph as a Mermaid diagram
//
// Summaries live in OpenSpec docs: `openspec/specs/<capability>/files.md`,
// next to that capability's `spec.md`, one line per file or directory:
//
//   - `src/auth/session.ts` — Creates and validates user sessions.
//   - `src/auth/` — Everything for login, sessions and tokens.
//
// Facts (imports, exports, header comment) are extracted mechanically; the
// prose summary is written by Claude. Hooks always exit 0.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const JS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const PY_EXTS = ['.py'];
const OTHER_EXTS = ['.go', '.rs', '.java', '.kt', '.cs', '.swift', '.rb', '.php', '.vue', '.svelte'];
const CODE_EXTS = new Set([...JS_EXTS, ...PY_EXTS, ...OTHER_EXTS]);
const IGNORED = /(^|\/)(node_modules|dist|build|vendor|\.git|\.next|coverage|__pycache__|\.venv|venv)\//;
const MAX_FILES = 20000;
const AUTO_BUILD_LIMIT = 3000;
const LIST_LIMIT = 8;

const toPosix = (p) => p.split(sep).join('/');
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

// ------------------------------------------------------------- extraction

function headerComment(source, ext) {
  const text = source.replace(/^#!.*\n/, '').trimStart();
  let m;
  if (PY_EXTS.includes(ext) && (m = /^(?:"""|''')([\s\S]*?)(?:"""|''')/.exec(text))) return m[1];
  if ((m = /^\/\*\*?([\s\S]*?)\*\//.exec(text))) return m[1].replace(/^\s*\* ?/gm, '');
  const marker = PY_EXTS.includes(ext) || ext === '.rb' ? '#' : '//';
  const lines = [];
  for (const line of text.split('\n')) {
    if (!line.trimStart().startsWith(marker)) break;
    lines.push(line.trimStart().slice(marker.length).replace(/^[/!]?\s?/, ''));
  }
  return lines.join('\n');
}

const clip = (s, n = 280) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

function jsFacts(source) {
  const specifiers = new Set();
  const patterns = [
    /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) specifiers.add(m[1]);

  const exports = new Set();
  const decl = /\bexport\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of source.matchAll(decl)) exports.add(m[1]);
  for (const m of source.matchAll(/\bexport\s*(?:type\s*)?\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) exports.add(name);
    }
  }
  if (/\bexport\s+default\b/.test(source) && exports.size === 0) exports.add('default');
  if (/\bmodule\.exports\b/.test(source)) exports.add('module.exports');
  return { specifiers: [...specifiers], exports: [...exports] };
}

function pyFacts(source) {
  const specifiers = new Set();
  for (const m of source.matchAll(/^\s*from\s+(\.*[\w.]*)\s+import\b/gm)) specifiers.add(m[1]);
  for (const m of source.matchAll(/^\s*import\s+([\w., ]+)$/gm)) {
    for (const part of m[1].split(',')) specifiers.add(part.trim().split(/\s+as\s+/)[0]);
  }
  const all = /^__all__\s*=\s*[[(]([^\])]*)[\])]/m.exec(source);
  const exports = all
    ? [...all[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1])
    : [...source.matchAll(/^(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)/gm)].map((m) => m[1]);
  return { specifiers: [...specifiers].filter(Boolean), exports };
}

function resolveJs(project, fromRel, spec) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return undefined;
  const base = normalize(join(dirname(fromRel), spec));
  const stem = base.replace(/\.(m|c)?js$/, '');
  const candidates = [
    base,
    ...JS_EXTS.map((e) => stem + e),
    ...JS_EXTS.map((e) => join(base, `index${e}`)),
  ];
  return candidates.map(toPosix).find((c) => isFile(join(project, c)));
}

function resolvePy(project, fromRel, spec) {
  const dots = /^\.*/.exec(spec)[0].length;
  const modPath = spec.slice(dots).split('.').filter(Boolean).join('/');
  const roots = dots
    ? [join(dirname(fromRel), ...Array(dots - 1).fill('..'))]
    : ['.', 'src'];
  for (const root of roots) {
    const base = join(root, modPath);
    for (const c of [`${base}.py`, join(base, '__init__.py')]) {
      if (isFile(join(project, c))) return toPosix(normalize(c));
    }
  }
  return undefined;
}

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const packageName = (spec) =>
  spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];

export function indexFile(project, rel) {
  const abs = join(project, rel);
  let source;
  try {
    source = readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
  const ext = extname(rel).toLowerCase();
  const node = { hash: hash(source), header: clip(headerComment(source, ext)), imports: [], packages: [], exports: [] };

  let facts;
  let resolver;
  if (JS_EXTS.includes(ext) || ext === '.vue' || ext === '.svelte') {
    facts = jsFacts(source);
    resolver = resolveJs;
  } else if (PY_EXTS.includes(ext)) {
    facts = pyFacts(source);
    resolver = resolvePy;
  }
  if (facts) {
    const imports = new Set();
    const packages = new Set();
    for (const spec of facts.specifiers) {
      const local = resolver(project, rel, spec);
      if (local) imports.add(local);
      else if (resolver === resolveJs && !spec.startsWith('.')) packages.add(packageName(spec));
      else if (resolver === resolvePy && !spec.startsWith('.')) packages.add(spec.split('.')[0]);
    }
    node.imports = [...imports].sort();
    node.packages = [...packages].sort();
    node.exports = [...new Set(facts.exports)].sort();
  }
  node.signature = hash(JSON.stringify([node.exports, node.imports]));
  return node;
}

// ------------------------------------------------------------- openspec

// Reads every capability under openspec/specs: its purpose from spec.md and
// its file summaries from files.md.
export function readSpecs(project) {
  const root = join(project, 'openspec', 'specs');
  const capabilities = {};
  const entries = [];
  let dirs = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return { capabilities, entries };
  }
  for (const { name } of dirs) {
    const specPath = toPosix(join('openspec', 'specs', name, 'spec.md'));
    const filesPath = toPosix(join('openspec', 'specs', name, 'files.md'));
    let purpose = '';
    try {
      const spec = readFileSync(join(project, specPath), 'utf8');
      purpose = clip(/^##\s+Purpose\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(spec)?.[1] ?? '', 200);
    } catch {
      // capability without spec.md
    }
    capabilities[name] = { spec: specPath, files: filesPath, purpose };
    let files = '';
    try {
      files = readFileSync(join(project, filesPath), 'utf8');
    } catch {
      continue;
    }
    for (const m of files.matchAll(/^\s*[-*]\s+`([^`]+)`\s*(?:—|–|-|:)\s*(.+)$/gm)) {
      entries.push({ path: m[1].replace(/^\.\//, ''), summary: m[2].trim(), capability: name });
    }
  }
  return { capabilities, entries };
}

// Exact file entry wins; otherwise the deepest directory entry covering it.
function specEntryFor(entries, rel) {
  const exact = entries.find((e) => e.path === rel);
  if (exact) return { ...exact, scope: 'file' };
  const dir = entries
    .filter((e) => e.path.endsWith('/') && rel.startsWith(e.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return dir && { ...dir, scope: 'directory' };
}

// Unmapped file: suggest the capability whose mapped directory (or mapped
// file's directory) contains it, preferring the deepest one. Sharing only a
// top-level folder such as `src/` is not evidence.
function guessCapability(entries, rel) {
  let best;
  let bestLen = 0;
  for (const e of entries) {
    const dir = e.path.endsWith('/') ? e.path.slice(0, -1) : dirname(e.path);
    if (dir === '.' || !rel.startsWith(`${dir}/`)) continue;
    if (dir.length > bestLen) [best, bestLen] = [e.capability, dir.length];
  }
  return best;
}

// --------------------------------------------------------------- graph

const graphFile = (project) => join(project, '.claude', 'graph', 'project.json');

function loadGraph(project) {
  try {
    const g = JSON.parse(readFileSync(graphFile(project), 'utf8'));
    if (g?.version === 1 && g.files) return g;
  } catch {
    // missing or corrupt: start over
  }
  return { version: 1, complete: false, capabilities: {}, files: {}, summaries: {} };
}

function saveGraph(project, graph) {
  const file = graphFile(project);
  mkdirSync(dirname(file), { recursive: true });
  graph.updatedAt = new Date().toISOString();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(graph, null, 2)}\n`);
  renameSync(tmp, file);
}

// Records each file summary together with the file's signature at the time
// the summary was first seen, so later export/import changes mark it stale.
function syncSummaries(graph, specs) {
  graph.capabilities = specs.capabilities;
  const seen = new Set();
  for (const e of specs.entries) {
    if (e.path.endsWith('/')) continue;
    seen.add(e.path);
    const node = graph.files[e.path];
    const known = graph.summaries[e.path];
    if (!known || known.text !== e.summary) {
      graph.summaries[e.path] = { text: e.summary, signature: node?.signature ?? null };
    } else if (known.signature === null && node) {
      known.signature = node.signature;
    }
  }
  for (const path of Object.keys(graph.summaries)) if (!seen.has(path)) delete graph.summaries[path];
}

function listSource(project) {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: project, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\n').filter((p) => p && isIndexable(p) && existsSync(join(project, p)));
  } catch {
    const found = [];
    const walk = (dir) => {
      if (found.length >= MAX_FILES) return;
      for (const d of readdirSync(join(project, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${d.name}` : d.name;
        if (d.isDirectory() && !d.name.startsWith('.') && !IGNORED.test(`${rel}/`)) walk(rel);
        else if (d.isFile() && isIndexable(rel)) found.push(rel);
      }
    };
    walk('');
    return found;
  }
}

const isIndexable = (rel) => CODE_EXTS.has(extname(rel).toLowerCase()) && !IGNORED.test(rel);

export function build(project) {
  const graph = loadGraph(project);
  const files = listSource(project).slice(0, MAX_FILES);
  graph.files = {};
  for (const rel of files) {
    const node = indexFile(project, rel);
    if (node) graph.files[rel] = node;
  }
  graph.complete = files.length < MAX_FILES;
  syncSummaries(graph, readSpecs(project));
  saveGraph(project, graph);
  return graph;
}

const dependentsOf = (graph, rel) =>
  Object.entries(graph.files).filter(([, n]) => n.imports.includes(rel)).map(([p]) => p).sort();

const list = (items) =>
  items.length > LIST_LIMIT
    ? `${items.slice(0, LIST_LIMIT).join(', ')} (+${items.length - LIST_LIMIT} more)`
    : items.join(', ');

// ------------------------------------------------------------- handlers

function projectPath(project, given) {
  if (typeof given !== 'string' || given === '') return undefined;
  const rel = relative(project, resolve(project, given));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return toPosix(rel);
}

const isSpecDoc = (rel) => /^openspec\/specs\/[^/]+\/(spec|files)\.md$/.test(rel);

function isSummaryStale(entry, known, node) {
  return entry.scope === 'file' && known?.signature && known.signature !== node.signature;
}

function buildReadLines(rel, entry, specs, graph, node) {
  const lines = [`[graph] ${rel}`];

  if (entry) {
    const cap = specs.capabilities[entry.capability];
    lines.push(`Capability: ${entry.capability} (${cap.spec})${cap.purpose ? ` — ${cap.purpose}` : ''}`);
    lines.push(`Summary${entry.scope === 'directory' ? ` (of ${entry.path})` : ''}: ${entry.summary}`);
    if (isSummaryStale(entry, graph.summaries[rel], node)) {
      lines.push(`Summary may be stale: exports/imports changed since it was written — update it in ${cap.files}.`);
    }
  } else if (node.header) {
    lines.push(`Header: ${node.header}`);
  }

  if (node.exports.length) lines.push(`Exports: ${list(node.exports)}`);
  if (node.imports.length) lines.push(`Imports: ${list(node.imports)}`);
  if (node.packages.length) lines.push(`Packages: ${list(node.packages)}`);

  const dependents = dependentsOf(graph, rel);
  if (dependents.length) lines.push(`Used by: ${list(dependents)}`);
  else if (!graph.complete) lines.push('Used by: unknown — run `node .claude/hooks/graph.mjs build` for dependents.');

  if (!entry) lines.push(missingSummaryHint(specs, rel));
  return lines;
}

function missingSummaryHint(specs, rel) {
  const guess = guessCapability(specs.entries, rel);
  const names = Object.keys(specs.capabilities);
  if (guess) {
    return `No summary yet: add "- \`${rel}\` — <one sentence on what it does>" to ${specs.capabilities[guess].files}.`;
  }
  if (names.length) {
    return `No summary yet: add "- \`${rel}\` — <one sentence>" to openspec/specs/<capability>/files.md (capabilities: ${list(names)}).`;
  }
  return `No summary yet and no OpenSpec capabilities exist: create openspec/specs/<capability>/spec.md and add "- \`${rel}\` — <one sentence>" to files.md beside it.`;
}

export function onRead(project, rel) {
  if (!isIndexable(rel)) return undefined;
  let graph = loadGraph(project);
  let dirty = false;

  // Bootstrap the full graph once on small projects so "used by" is real.
  if (!graph.complete && Object.keys(graph.files).length === 0) {
    const count = listSource(project).length;
    if (count <= AUTO_BUILD_LIMIT) graph = build(project);
  }
  const node = indexFile(project, rel);
  if (!node) return undefined;
  if (graph.files[rel]?.hash !== node.hash) {
    graph.files[rel] = node;
    dirty = true;
  }
  const specs = readSpecs(project);
  const before = JSON.stringify(graph.summaries);
  syncSummaries(graph, specs);
  if (dirty || before !== JSON.stringify(graph.summaries)) saveGraph(project, graph);

  const entry = specEntryFor(specs.entries, rel);
  return buildReadLines(rel, entry, specs, graph, node).join('\n');
}

export function onUpdate(project, rel) {
  if (isSpecDoc(rel)) {
    const graph = loadGraph(project);
    syncSummaries(graph, readSpecs(project));
    saveGraph(project, graph);
    return undefined;
  }
  if (!isIndexable(rel)) return undefined;
  const graph = loadGraph(project);
  const node = indexFile(project, rel);
  if (!node) return undefined;
  graph.files[rel] = node;
  const specs = readSpecs(project);
  syncSummaries(graph, specs);
  saveGraph(project, graph);

  const entry = specEntryFor(specs.entries, rel);
  if (!entry || entry.scope === 'directory') return `[graph] ${missingSummaryHint(specs, rel)}`;
  const known = graph.summaries[rel];
  if (known?.signature && known.signature !== node.signature) {
    return `[graph] ${rel} changed its exports/imports since its summary was written. ` +
      `Check the summary in ${specs.capabilities[entry.capability].files} still holds: "${entry.summary}". ` +
      'Rewording it marks it current again.';
  }
  return undefined;
}

export function mermaid(project) {
  const graph = loadGraph(project);
  const specs = readSpecs(project);
  const capOf = (rel) => specEntryFor(specs.entries, rel)?.capability ?? 'unmapped';
  const edges = new Map();
  for (const [rel, node] of Object.entries(graph.files)) {
    const from = capOf(rel);
    for (const dep of node.imports) {
      const to = capOf(dep);
      if (from !== to) edges.set(`${from}|${to}`, (edges.get(`${from}|${to}`) ?? 0) + 1);
    }
  }
  const id = (s) => s.replace(/[^\w]/g, '_');
  const lines = ['graph LR'];
  for (const name of new Set([...Object.keys(specs.capabilities), 'unmapped'])) {
    lines.push(`  ${id(name)}["${name}"]`);
  }
  for (const [key, count] of edges) {
    const [from, to] = key.split('|');
    lines.push(`  ${id(from)} -->|${count}| ${id(to)}`);
  }
  return lines.join('\n');
}

// ------------------------------------------------------------- entrypoint

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const mode = process.argv[2];
  const project = resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  try {
    if (mode === 'build') {
      const g = build(project);
      console.log(`Indexed ${Object.keys(g.files).length} files, ${Object.keys(g.capabilities).length} capabilities -> ${toPosix(relative(project, graphFile(project)))}`);
    } else if (mode === 'mermaid') {
      console.log(mermaid(project));
    } else if (mode === 'read' || mode === 'update') {
      let input = '';
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) input += chunk;
      const event = JSON.parse(input);
      const rel = projectPath(project, event?.tool_input?.file_path);
      const context = rel && (mode === 'read' ? onRead(project, rel) : onUpdate(project, rel));
      if (context) {
        console.log(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context },
        }));
      }
    }
  } catch {
    // The graph is advisory: never fail the tool call.
  }
  process.exit(0);
}
