#!/usr/bin/env node
// Lists the packages a project already declares, so Claude reuses one before
// adding another. Reads every manifest under the project root (monorepo
// packages included) without installing or running anything:
//
//   package.json                          dependencies, dev, peer, optional
//   pyproject.toml                        PEP 621, dependency-groups, Poetry
//   requirements*.txt                     one requirement per line
//   go.mod                                require (direct and // indirect)
//   Cargo.toml                            dependencies, dev, build
//
//   node .claude/tools/list-packages.mjs [dir] [--json] [--prod] [--grep <text>]
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'vendor', 'dist', 'build', 'out', 'target', 'coverage',
  '.venv', 'venv', 'env', '__pycache__', '.tox', '.next', '.nuxt', '.turbo', '.cache',
]);
const MAX_DEPTH = 6;

const USAGE = `list-packages: the packages this project already declares

Usage
  node .claude/tools/list-packages.mjs [dir] [options]

Options
  --json          Print JSON instead of a table
  --prod          Only runtime dependencies (no dev, test, build or optional)
  --grep <text>   Only packages whose name contains <text>
  -h, --help      Show this help`;

const readText = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

export function projectRoot(cwd = process.cwd()) {
  if (process.env.CLAUDE_PROJECT_DIR) return resolve(process.env.CLAUDE_PROJECT_DIR);
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : resolve(cwd);
}

// ---------------------------------------------------------------- parsers

const NPM_KINDS = { dependencies: 'prod', devDependencies: 'dev', peerDependencies: 'peer', optionalDependencies: 'optional' };

export function parsePackageJson(text) {
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    return [];
  }
  return Object.entries(NPM_KINDS).flatMap(([field, kind]) =>
    Object.entries(pkg?.[field] ?? {}).map(([name, version]) => ({ name, version: String(version), kind })));
}

// "requests[socks]>=2.31; python_version>'3.8'" -> { name: requests, version: >=2.31 }
export function parseRequirement(spec) {
  const clean = spec.replace(/\s+#.*$/, '').trim();
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([^;]*)/.exec(clean);
  return m ? { name: m[1], version: m[2].trim() || '*' } : null;
}

export function parseRequirements(text, kind = 'prod') {
  return text.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('-'))
    .map(parseRequirement)
    .filter(Boolean)
    .map((r) => ({ ...r, kind }));
}

// Minimal TOML reading: section headers, `key = "string"`, `key = { version = ".." }`
// and (multi-line) arrays of strings. Enough for dependency tables.
const unquoted = (s) => s.replace(/"[^"]*"|'[^']*'/g, '');

function tomlSections(text) {
  const sections = new Map();
  let current = '';
  let pending = null;
  sections.set(current, []);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (pending) {
      pending.value += ` ${line}`;
      if (unquoted(line).includes(']')) {
        sections.get(current).push(pending);
        pending = null;
      }
      continue;
    }
    if (!line) continue;
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) {
      current = header[1].trim();
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    const kv = /^("?[^"=]+"?)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const entry = { key: kv[1].replace(/"/g, '').trim(), value: kv[2].trim() };
    if (entry.value.startsWith('[') && !unquoted(entry.value).includes(']')) pending = entry;
    else sections.get(current).push(entry);
  }
  return sections;
}

const tomlStrings = (value) => [...value.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);

function tomlVersion(value) {
  if (/^["']/.test(value)) return tomlStrings(value)[0] ?? '*';
  const version = /version\s*=\s*["']([^"']+)["']/.exec(value)?.[1];
  if (version) return version;
  const source = /\b(git|path|url)\s*=\s*["']([^"']+)["']/.exec(value);
  return source ? `${source[1]}:${source[2]}` : '*';
}

export function parsePyproject(text) {
  const sections = tomlSections(text);
  const out = [];
  const fromArray = (value, kind) => {
    for (const spec of tomlStrings(value)) {
      const r = parseRequirement(spec);
      if (r) out.push({ ...r, kind });
    }
  };
  for (const { key, value } of sections.get('project') ?? []) if (key === 'dependencies') fromArray(value, 'prod');
  for (const { value } of sections.get('project.optional-dependencies') ?? []) fromArray(value, 'optional');
  for (const { key, value } of sections.get('dependency-groups') ?? []) fromArray(value, key === 'dev' ? 'dev' : key);
  for (const [name, entries] of sections) {
    const poetry = /^tool\.poetry\.(?:(dependencies|dev-dependencies)|group\.([^.]+)\.dependencies)$/.exec(name);
    if (!poetry) continue;
    const kind = poetry[1] === 'dependencies' ? 'prod' : poetry[2] && poetry[2] !== 'dev' ? poetry[2] : 'dev';
    for (const { key, value } of entries) {
      if (key.toLowerCase() !== 'python') out.push({ name: key, version: tomlVersion(value), kind });
    }
  }
  return out;
}

export function parseGoMod(text) {
  const out = [];
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^require\s*\($/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ')') {
      inBlock = false;
      continue;
    }
    const body = inBlock ? line : /^require\s+(.+)$/.exec(line)?.[1];
    const m = body && /^(\S+)\s+(\S+)(.*)$/.exec(body);
    if (m) out.push({ name: m[1], version: m[2], kind: /\/\/\s*indirect/.test(m[3]) ? 'indirect' : 'prod' });
  }
  return out;
}

const CARGO_KINDS = { dependencies: 'prod', 'dev-dependencies': 'dev', 'build-dependencies': 'build', 'workspace.dependencies': 'workspace' };

export function parseCargo(text) {
  const out = [];
  for (const [name, entries] of tomlSections(text)) {
    // [target.'cfg(unix)'.dependencies] counts as [dependencies].
    const table = name.startsWith('target.') ? name.replace(/^.*\.((?:dev-|build-)?dependencies)$/, '$1') : name;
    const kind = CARGO_KINDS[table];
    if (!kind) continue;
    for (const { key, value } of entries) out.push({ name: key, version: tomlVersion(value), kind });
  }
  return out;
}

const MANIFESTS = [
  { test: (f) => f === 'package.json', ecosystem: 'npm', parse: (t) => parsePackageJson(t) },
  { test: (f) => f === 'pyproject.toml', ecosystem: 'python', parse: (t) => parsePyproject(t) },
  { test: (f) => /^requirements([-_.][\w.-]+)?\.txt$/.test(f), ecosystem: 'python', parse: (t, f) => parseRequirements(t, /dev|test|lint|doc/i.test(f) ? 'dev' : 'prod') },
  { test: (f) => f === 'go.mod', ecosystem: 'go', parse: (t) => parseGoMod(t) },
  { test: (f) => f === 'Cargo.toml', ecosystem: 'cargo', parse: (t) => parseCargo(t) },
];

// ---------------------------------------------------------------- listing

function findManifests(root, dir = root, depth = 0, found = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) findManifests(root, join(dir, e.name), depth + 1, found);
      continue;
    }
    const manifest = e.isFile() && MANIFESTS.find((m) => m.test(e.name));
    if (manifest) found.push({ file: relative(root, join(dir, e.name)) || e.name, manifest });
  }
  return found;
}

export function listPackages(root, { prod = false, grep = '' } = {}) {
  const runtime = new Set(['prod', 'peer']);
  const needle = grep.toLowerCase();
  return findManifests(root)
    .map(({ file, manifest }) => ({
      file,
      ecosystem: manifest.ecosystem,
      packages: manifest.parse(readText(join(root, file)), file.split('/').pop())
        .filter((p) => !prod || runtime.has(p.kind))
        .filter((p) => !needle || p.name.toLowerCase().includes(needle)),
    }))
    .filter((m) => m.packages.length);
}

export function formatTable(manifests) {
  if (!manifests.length) return 'No declared packages found.';
  return manifests.map(({ file, ecosystem, packages }) => {
    const width = Math.max(...packages.map((p) => p.name.length));
    const vwidth = Math.max(...packages.map((p) => p.version.length));
    const rows = packages.map((p) => `  ${p.name.padEnd(width)}  ${p.version.padEnd(vwidth)}  ${p.kind}`);
    return `${file} (${ecosystem}, ${packages.length})\n${rows.join('\n')}`;
  }).join('\n\n');
}

export function main(argv, { log = console.log, cwd = process.cwd() } = {}) {
  const opts = { json: false, prod: false, grep: '' };
  let dir;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--prod') opts.prod = true;
    else if (a === '--grep') opts.grep = argv[++i] ?? '';
    else if (a === '-h' || a === '--help') {
      log(USAGE);
      return 0;
    } else if (a.startsWith('-')) {
      log(`list-packages: unknown option ${a}\n\n${USAGE}`);
      return 2;
    } else dir = a;
  }
  const root = dir ? resolve(cwd, dir) : projectRoot(cwd);
  const manifests = listPackages(root, opts);
  log(opts.json ? JSON.stringify(manifests, null, 2) : formatTable(manifests));
  return 0;
}

// Node resolves symlinks in import.meta.url but not in argv[1]; compare real
// paths so this still runs when the project path goes through a symlink.
const entryPath = () => {
  try {
    return realpathSync(process.argv[1]);
  } catch {
    return process.argv[1] ?? '';
  }
};

if (import.meta.url === pathToFileURL(entryPath()).href) process.exitCode = main(process.argv.slice(2));
