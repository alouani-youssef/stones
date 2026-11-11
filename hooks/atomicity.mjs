import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { tokenize } from './lib/shell.mjs';

export const DEFAULTS = {
  enabled: true,
  exempt: [],
  defaultBranch: 'main',
  specDir: '.claude/danger',
  prefixes: { db: 'db/', packages: 'deps/', network: 'net/' },
  zones: {
    db: {
      paths: [
        '**/schema.prisma',
        '**/drizzle/**',
        '**/models.py',
        '**/models/**/*.py',
        '**/*.entity.ts',
        'app/models/**',
        '**/migrations/**',
        '**/alembic/versions/**',
        '**/db/migrate/**',
        '**/*.sql',
        '**/db/schema.rb',
        '**/structure.sql',
        '**/seeds/**',
        '**/seed.*',
      ],
      extraPaths: [],
    },
    packages: {
      paths: [
        '**/package.json',
        '**/package-lock.json',
        '**/pnpm-lock.yaml',
        '**/yarn.lock',
        '**/bun.lockb',
        '**/requirements*.txt',
        '**/pyproject.toml',
        '**/poetry.lock',
        '**/uv.lock',
        '**/Pipfile*',
        '**/go.mod',
        '**/go.sum',
        '**/Cargo.toml',
        '**/Cargo.lock',
        '**/Gemfile*',
        '**/composer.*',
        '**/pom.xml',
        '**/build.gradle*',
      ],
      extraPaths: [],
    },
    network: {
      paths: [
        '**/.mcp.json',
        '.claude/settings*.json',
        '**/.env.example',
        '**/nginx.conf',
        '**/nginx/**',
        '**/proxy*.conf',
        '**/ingress*.y*ml',
      ],
      patterns: [
        String.raw`(?:process\.env\.|os\.environ(?:\.get)?\(?\[?["']|os\.Getenv\(")[A-Z0-9_]*_(?:URL|HOST|ENDPOINT|API_KEY)\b`,
        String.raw`\bnew\s+(?:WebSocket|XMLHttpRequest|EventSource)\b`,
        String.raw`\b(?:import|from|require)\b.*['"](?:stripe|ws|socket\.io-client|openai|@anthropic-ai/sdk|twilio|nodemailer|firebase(?:/[^'"]*)?|amqplib|kafkajs|@grpc/[^'"]+|@sendgrid/[^'"]+|@aws-sdk/[^'"]+|@slack/[^'"]+)['"]`,
        String.raw`^\s*(?:import|from)\s+(?:boto3|stripe|openai|anthropic|twilio|smtplib|websockets?|pika|confluent_kafka|grpc|firebase_admin)\b`,
        String.raw`\b(?:net\.(?:connect|createConnection|Dial)|tls\.connect|dgram\.createSocket|net\.Dial)\(|\brequire\(['"](?:node:)?dgram['"]\)|\bfrom\s+['"](?:node:)?dgram['"]`,
      ],
      incomingPatterns: [
        String.raw`\b(?:app|router|server|fastify)\.(?:get|post|put|patch|delete|all)\(\s*['"\`]/`,
        String.raw`^\s*@(?:app|router|bp|blueprint)\.(?:route|get|post|put|patch|delete)\(`,
        String.raw`^\s*@(?:Get|Post|Put|Patch|Delete|Controller)\(`,
        String.raw`\bhttp\.HandleFunc\(`,
      ],
      incomingPaths: [
        'config/routes.rb',
        '**/app/**/route.ts',
        '**/app/**/route.js',
        '**/app/**/route.tsx',
        '**/app/**/route.jsx',
        '**/pages/api/**',
      ],
      extraPatterns: [],
      allowHosts: [],
      ignore: [],
      incoming: false,
    },
  },
  migrations: { dirs: [], generate: '', allowEdits: false },
};

const NEUTRAL_PATHS = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/test_*.py',
  '**/__tests__/**',
  '**/tests/**',
  '**/__mocks__/**',
  '**/fixtures/**',
  '**/*.md',
];

const MANIFESTS = new Set(['package.json', 'pyproject.toml', 'Cargo.toml']);
const SETTINGS_RE = /^\.claude\/settings[^/]*\.json$/;
const ENV_EXAMPLE = '.env.example';
const baseName = (rel) => rel.split('/').pop();
const isSettings = (rel) => SETTINGS_RE.test(rel);
const isEnvExample = (rel) => baseName(rel) === ENV_EXAMPLE;
const normalize = (file) => file.replaceAll('\\', '/').replace(/^\.\//, '');

const escapeChar = (c) => c.replace(/[.+^${}()|[\]\\]/g, '\\$&');

const globCache = new Map();

export function globToRegExp(glob) {
  if (globCache.has(glob)) return globCache.get(glob);
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += escapeChar(c);
  }
  const re = new RegExp(`^${out}$`);
  globCache.set(glob, re);
  return re;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function merge(base, override) {
  if (!isObject(base) || !isObject(override)) return override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) out[key] = key in base ? merge(base[key], value) : value;
  return out;
}

export function loadConfig(project) {
  try {
    const user = JSON.parse(readFileSync(join(project, '.claude/atomicity.json'), 'utf8'));
    return isObject(user) ? merge(DEFAULTS, user) : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

const matchesAny = (globs, file) => globs.some((g) => globToRegExp(g).test(file));
const zonePaths = (zone) => [...(zone?.paths ?? []), ...(zone?.extraPaths ?? [])];

export function pathClass(file, config) {
  const rel = normalize(file);
  const zones = config.zones ?? {};
  if (matchesAny(zonePaths(zones.db), rel)) return 'db';
  if (matchesAny(zonePaths(zones.packages), rel)) return MANIFESTS.has(baseName(rel)) ? 'manifest' : 'packages';
  if (matchesAny(zonePaths(zones.network), rel)) return isSettings(rel) || isEnvExample(rel) ? 'manifest' : 'network';
  const specDir = (config.specDir ?? '').replace(/\/+$/, '');
  if (specDir && matchesAny([`${specDir}/**`], rel)) return 'neutral';
  if (matchesAny(NEUTRAL_PATHS, rel)) return 'neutral';
  return 'code';
}

// Local hosts, documentation hosts, and XML-namespace / JSON-schema hosts (identifiers, not traffic).
const SKIPPED_HOST = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|.+\.local|(?:.+\.)?example\.(?:com|org|net)|(?:.+\.)?w3\.org|(?:.+\.)?json-schema\.org|(?:.+\.)?schemastore\.org)$/i;
const URL_RE = /\b(?:https?|wss?):\/\/([^/'"\s:?#`)>]+)/g;
// A line that is only a comment: //, #, /* … */, * (block-comment body) or <!-- … -->.
const COMMENT_LINE = /^\s*(?:\/\/|#(?=\s|!|$)|\/\*|\*|<!--)/;
// JSON keys whose URL values identify a schema or describe the package; they are never called.
const SCHEMA_KEY = /^\s*"\$(?:schema|id)"\s*:/;
const PACKAGE_META_KEY = /^\s*"(?:homepage|repository|bugs|url|funding|author|contributors|license|email|web)"\s*:/;

const hostGlob = (glob) => new RegExp(`^${String(glob).toLowerCase().split('*').map((p) => p.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('.*')}$`);

function hasExternalUrl(line, allowHosts) {
  for (const m of line.matchAll(URL_RE)) {
    const host = m[1].toLowerCase();
    if (!SKIPPED_HOST.test(host) && !allowHosts.some((re) => re.test(host))) return true;
  }
  return false;
}

function compilePatterns(sources) {
  const out = [];
  for (const src of sources) {
    try {
      out.push(new RegExp(src));
    } catch {
      // invalid user pattern: skip
    }
  }
  return out;
}

/** The first added line that talks to another host, or null. `file` (optional) enables package.json metadata skipping. */
export function networkHit(addedLines, config, file = '') {
  const net = config.zones?.network ?? {};
  const sources = [...(net.patterns ?? []), ...(net.extraPatterns ?? []), ...(net.incoming ? (net.incomingPatterns ?? DEFAULTS.zones.network.incomingPatterns) : [])];
  const patterns = compilePatterns(sources);
  const allowHosts = (Array.isArray(net.allowHosts) ? net.allowHosts : []).map(hostGlob);
  const isPackageJson = baseName(normalize(file)) === 'package.json';
  for (const line of addedLines ?? []) {
    if (COMMENT_LINE.test(line)) continue;
    const urlChecked = !SCHEMA_KEY.test(line) && !(isPackageJson && PACKAGE_META_KEY.test(line));
    if ((urlChecked && hasExternalUrl(line, allowHosts)) || patterns.some((re) => re.test(line))) return line;
  }
  return null;
}

const DEP_KEYS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

function tomlSections(text) {
  const sections = [];
  let current = { name: '', lines: [] };
  sections.push(current);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[{1,2}\s*([^\]]+?)\s*\]{1,2}$/.exec(line);
    if (header) {
      current = { name: header[1], lines: [] };
      sections.push(current);
    } else if (line && !line.startsWith('#')) current.lines.push(line);
  }
  return sections;
}

function projectDependencyLines(lines) {
  const out = [];
  let depth = 0;
  let inside = false;
  for (const line of lines) {
    if (!inside && /^(?:dependencies)\s*=/.test(line)) inside = true;
    if (!inside) continue;
    out.push(line);
    depth += (line.match(/\[/g) ?? []).length - (line.match(/\]/g) ?? []).length;
    if (depth <= 0) inside = false;
  }
  return out;
}

const PYPROJECT_SECTION = /^(?:project\.optional-dependencies|dependency-groups|tool\.poetry\.(?:.+\.)?(?:dev-)?dependencies(?:\..+)?)$/;
const CARGO_SECTION = /^(?:workspace\.dependencies|(?:target\..+\.)?(?:dev-|build-)?dependencies)(?:\..+)?$/;

function dependencyText(file, text) {
  const sections = tomlSections(text);
  const keep = [];
  for (const { name, lines } of sections) {
    if (file === 'pyproject.toml') {
      if (name === 'project') keep.push(`[project]`, ...projectDependencyLines(lines));
      else if (PYPROJECT_SECTION.test(name)) keep.push(`[${name}]`, ...lines);
    } else if (CARGO_SECTION.test(name)) keep.push(`[${name}]`, ...lines);
  }
  return keep.join('\n');
}

/** Dependency sections only; a missing section and an empty one compare equal. */
function packageDeps(text) {
  if (!text.trim()) return {};
  const json = JSON.parse(text);
  const isEmpty = (v) => v === undefined || v === null || (isObject(v) && !Object.keys(v).length);
  return Object.fromEntries(DEP_KEYS.filter((k) => !isEmpty(json?.[k])).map((k) => [k, json[k]]));
}

export function dependencyChanged(file, before, after) {
  try {
    const name = baseName(normalize(file));
    const [b, a] = [before ?? '', after ?? ''];
    if (name === 'package.json') return !isDeepStrictEqual(packageDeps(b), packageDeps(a));
    if (name === 'pyproject.toml' || name === 'Cargo.toml') return dependencyText(name, b) !== dependencyText(name, a);
    return true;
  } catch {
    return true;
  }
}

const parseJson = (text) => (text && text.trim() ? JSON.parse(text) : {});

function settingsNetworkChanged(before, after) {
  try {
    return !isDeepStrictEqual(parseJson(before)?.sandbox?.network, parseJson(after)?.sandbox?.network);
  } catch {
    return true;
  }
}

const ENV_KEY_RE = /^\s*(?:export\s+)?[A-Za-z0-9_]*(?:_URL|_HOST|_ENDPOINT|_API_KEY)\s*=/;

export const classify = (change, config) => classifyDetail(change, config).cls;

/** { cls, line }: line is the added line that made a file network by content (for block messages). */
export function classifyDetail(change, config) {
  const rel = normalize(change.file);
  const base = pathClass(rel, config);
  const ignored = matchesAny(config.zones?.network?.ignore ?? [], rel);
  if (base === 'manifest') {
    if (isSettings(rel)) return { cls: !ignored && settingsNetworkChanged(change.before, change.after) ? 'network' : 'code' };
    if (isEnvExample(rel)) {
      const line = ignored ? undefined : (change.added ?? []).find((l) => ENV_KEY_RE.test(l));
      return line === undefined ? { cls: 'code' } : { cls: 'network', line };
    }
    if (dependencyChanged(rel, change.before, change.after)) return { cls: 'packages' };
    return contentClass(change, config, ignored);
  }
  if (base === 'network') return { cls: 'network' };
  if (base === 'code') return incomingPath(rel, config) ? { cls: 'network' } : contentClass(change, config, ignored);
  return { cls: base };
}

function incomingPath(rel, config) {
  const net = config.zones?.network ?? {};
  return Boolean(net.incoming) && matchesAny(net.incomingPaths ?? DEFAULTS.zones.network.incomingPaths, rel);
}

function contentClass(change, config, ignored) {
  const line = ignored ? null : networkHit(change.added ?? [], config, change.file);
  return line === null ? { cls: 'code' } : { cls: 'network', line };
}

// ---------------------------------------------------------------------------
// Bash command parsing
// ---------------------------------------------------------------------------

// Tokenizing lives in ./lib/shell.mjs, shared with access_guard.
export { tokenize };

const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
const COMMIT_VALUE_FLAGS = new Set([
  '-m', '--message', '-F', '--file', '--author', '-C', '--reuse-message', '-c', '--reedit-message',
  '--date', '-t', '--template', '--cleanup', '--fixup', '--squash', '-S', '--gpg-sign', '--pathspec-from-file',
  '--trailer', '-u', '--untracked-files',
]);
const COMMIT_SHORT_VALUE = new Set(['m', 'F', 'C', 'c', 't']);

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ENV_VALUE_FLAGS = new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']);

/** Drop leading `NAME=value` assignments and `env` / `command` wrappers: `HUSKY=0 env -u X command git …` → `git …`. */
export function stripWrappers(words) {
  let i = 0;
  while (i < words.length) {
    if (ENV_ASSIGN.test(words[i])) i += 1;
    else if (words[i] === 'env') {
      i += 1;
      while (i < words.length && (words[i].startsWith('-') || ENV_ASSIGN.test(words[i]))) i += ENV_VALUE_FLAGS.has(words[i]) ? 2 : 1;
    } else if (words[i] === 'command') {
      i += 1;
      while (i < words.length && /^-[pvV]+$/.test(words[i])) i += 1;
    } else break;
  }
  return words.slice(i);
}

const isProgram = (word, name) => word === name || (word ?? '').endsWith(`/${name}`);

function gitSubcommand(words) {
  let i = isProgram(words[0], 'git') ? 1 : -1;
  if (i < 0) return null;
  while (i < words.length && words[i].startsWith('-')) {
    i += GIT_GLOBAL_WITH_VALUE.has(words[i]) ? 2 : 1;
  }
  return i < words.length ? { name: words[i], args: words.slice(i + 1) } : null;
}

function parseCommit(args) {
  let all = false;
  const paths = [];
  let afterDashes = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (afterDashes || !a.startsWith('-') || a === '-') {
      paths.push(a);
    } else if (a === '--') {
      afterDashes = true;
    } else if (a.startsWith('--')) {
      if (a === '--all') all = true;
      else if (!a.includes('=') && COMMIT_VALUE_FLAGS.has(a)) i += 1;
    } else {
      for (let j = 1; j < a.length; j += 1) {
        if (a[j] === 'a') all = true;
        if (COMMIT_SHORT_VALUE.has(a[j])) {
          if (j === a.length - 1) i += 1;
          break;
        }
      }
    }
  }
  return { all, paths };
}

function parseAdd(args) {
  const paths = [];
  let all = false;
  let tracked = false;
  let afterDashes = false;
  for (const a of args) {
    if (afterDashes || !a.startsWith('-') || a === '-') {
      if (a === '.') all = true;
      else paths.push(a);
    } else if (a === '--') {
      afterDashes = true;
    } else if (a.startsWith('--')) {
      if (a === '--all') all = true;
      else if (a === '--update') tracked = true;
    } else {
      if (a.includes('A')) all = true;
      if (a.includes('u')) tracked = true;
    }
  }
  return { all, tracked, paths };
}

const SWITCH_CREATE = new Set(['-c', '-C', '--create', '--force-create']);
const CHECKOUT_CREATE = new Set(['-b', '-B']);

/** `git switch -c X` / `git checkout -b X` with no start point → { create: X }; anything else → { other: true }. */
function parseSwitch(name, args) {
  if (name === 'checkout' && args.includes('--')) return null; // file restore, not a branch switch
  const creates = name === 'switch' ? SWITCH_CREATE : CHECKOUT_CREATE;
  const rest = [];
  let create = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (creates.has(a)) {
      create = args[i + 1] ?? null;
      i += 1;
    } else if (/^--(?:create|force-create)=/.test(a)) create = a.slice(a.indexOf('=') + 1);
    else if (!a.startsWith('-')) rest.push(a);
  }
  return create && !rest.length ? { create } : { other: true };
}

function ghPrBase(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--base' || args[i] === '-B') return args[i + 1] ?? null;
    if (args[i].startsWith('--base=')) return args[i].slice(7);
  }
  return null;
}

/**
 * adds: paths from `git add`, or 'all' for `-A`/`.`; addsTracked: `git add -u` (all tracked files, like `commit -a`).
 * newBranch: `git switch -c X` / `git checkout -b X` run before the commit/push/pr in the same command.
 * otherSwitch: any other `git switch` / `git checkout <branch>` run before the commit/push/pr.
 */
export function gitIntents(command) {
  const out = { adds: null, addsTracked: false, commit: null, push: false, pr: null, newBranch: null, otherSwitch: false };
  const beforeGit = () => !out.commit && !out.push && !out.pr;
  for (const raw of tokenize(command)) {
    const words = stripWrappers(raw);
    if (isProgram(words[0], 'gh') && words[1] === 'pr' && words[2] === 'create') {
      out.pr = { base: ghPrBase(words.slice(3)) };
      continue;
    }
    const sub = gitSubcommand(words);
    if (!sub) continue;
    if (sub.name === 'add') {
      const { all, tracked, paths } = parseAdd(sub.args);
      if (tracked) out.addsTracked = true;
      if (all || out.adds === 'all') out.adds = 'all';
      else out.adds = [...(out.adds ?? []), ...paths];
    } else if ((sub.name === 'switch' || sub.name === 'checkout') && beforeGit()) {
      const sw = parseSwitch(sub.name, sub.args);
      if (sw?.create) out.newBranch = sw.create;
      else if (sw?.other) out.otherSwitch = true;
    } else if (sub.name === 'commit') {
      out.commit = parseCommit(sub.args);
    } else if (sub.name === 'push') {
      out.push = true;
    }
  }
  return out;
}

export function shellWriteTargets(command) {
  const targets = [];
  for (const words of tokenize(command)) {
    const args = [];
    for (let i = 0; i < words.length; i += 1) {
      if (words[i] === '>' || words[i] === '>>') {
        if (words[i + 1] !== undefined) targets.push(words[i + 1]);
        i += 1;
      } else if (words[i] === '>&') {
        i += 1;
      } else {
        args.push(words[i]);
      }
    }
    const [cmd, ...rest] = args;
    const operands = rest.filter((a) => !a.startsWith('-'));
    if (cmd === 'tee' || cmd === 'touch') targets.push(...operands);
    else if ((cmd === 'cp' || cmd === 'mv') && operands.length) targets.push(operands.at(-1));
  }
  return targets.filter((t) => t && !t.startsWith('/dev/'));
}

// ---------------------------------------------------------------------------
// Git layer
// ---------------------------------------------------------------------------

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function git(project, args) {
  try {
    const r = spawnSync('git', ['-C', project, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return { ok: r.status === 0, out: r.stdout ?? '' };
  } catch {
    return { ok: false, out: '' };
  }
}

const gitLines = (project, args) => git(project, args).out.split('\n').filter(Boolean);
const gitNul = (project, args) => git(project, args).out.split('\0').filter(Boolean);
const refExists = (project, ref) => git(project, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).ok;

export const isRepo = (project) => git(project, ['rev-parse', '--git-dir']).ok;

export function currentBranch(project) {
  const r = git(project, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return r.ok && r.out.trim() ? r.out.trim() : null;
}

/** [{ ref, upstream }] for refs/heads/<name> and refs/remotes/origin/<name> that exist, in one call. */
const localAndOrigin = (project, name) =>
  gitLines(project, ['for-each-ref', '--format=%(refname:short)%09%(upstream:short)', `refs/heads/${name}`, `refs/remotes/origin/${name}`]).map((l) => {
    const [ref, upstream] = l.split('\t');
    return { ref, upstream };
  });
const localOrRemote = (project, name) => localAndOrigin(project, name).length > 0;

/** The default branch's name (never `origin/…`): configured if it exists locally or on origin, else origin/HEAD, else main/master. */
export function defaultBranch(project, config) {
  const configured = config?.defaultBranch;
  if (configured && localOrRemote(project, configured)) return configured;
  const head = git(project, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']).out.trim();
  if (head) return head.replace(/^origin\//, '');
  return ['main', 'master'].find((b) => localOrRemote(project, b)) ?? null;
}

/** Refs that stand for a branch: the local branch, origin/<name> and its configured upstream (whichever exist). */
export function branchRefs(project, name) {
  if (!name) return [];
  const found = localAndOrigin(project, name);
  const refs = found.map((r) => r.ref);
  const up = found.find((r) => r.ref === name)?.upstream;
  if (up && !refs.includes(up) && refExists(project, up)) refs.push(up);
  return refs;
}

/** The ref with the fewest commits between its merge-base with HEAD and HEAD; `skip(ref, mergeBase)` drops candidates. */
function nearestRef(project, refs, skip = () => false) {
  let best = null;
  let bestCount = Infinity;
  for (const ref of refs) {
    const mb = git(project, ['merge-base', ref, 'HEAD']);
    if (!mb.ok || skip(ref, mb.out.trim())) continue;
    const count = Number(git(project, ['rev-list', '--count', `${mb.out.trim()}..HEAD`]).out.trim());
    if (Number.isFinite(count) && count < bestCount) {
      best = ref;
      bestCount = count;
    }
  }
  return best;
}

/** `gh pr create --base X` (or the default): the nearest of X and origin/X, so a stale local X does not count others' commits. */
export function prBaseRef(project, base) {
  if (!base) return null;
  return nearestRef(project, branchRefs(project, base)) ?? base;
}

export function readAtRef(project, ref, file) {
  const r = git(project, ['show', `${ref ?? ''}:${file}`]);
  return r.ok ? r.out : null;
}

function nameStatus(project, args) {
  const tokens = gitNul(project, ['diff', '--name-status', '-z', ...args]);
  const files = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i];
    if (/^[RC]/.test(status)) {
      files.push(tokens[i + 2]);
      i += 3;
    } else {
      files.push(tokens[i + 1]);
      i += 2;
    }
  }
  return files.filter((f) => f !== undefined);
}

const DIFF_ARGS = ['-c', 'core.quotePath=false', '--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', '--no-renames', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '-U0'];
const C_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** A path from a `---` / `+++` header: strip the a/ b/ prefix, the trailing tab git adds after paths with spaces, and C quoting. */
function headerPath(raw) {
  let p = raw.replace(/\t$/, '');
  if (p.startsWith('"') && p.endsWith('"')) {
    const bytes = [];
    for (let i = 1; i < p.length - 1; i += 1) {
      if (p[i] !== '\\') {
        bytes.push(...Buffer.from(p[i], 'utf8'));
      } else if (/[0-7]{3}/.test(p.slice(i + 1, i + 4))) {
        bytes.push(parseInt(p.slice(i + 1, i + 4), 8));
        i += 3;
      } else {
        bytes.push(C_ESCAPES[p[i + 1]] ?? p.charCodeAt(i + 1));
        i += 1;
      }
    }
    p = Buffer.from(bytes).toString('utf8');
  }
  return p === '/dev/null' ? null : p.replace(/^[ab]\//, '');
}

/** Binary and mode-only diffs have no ---/+++ lines: read `diff --git a/P b/P` (with --no-renames both sides match). */
function gitLinePath(line) {
  const rest = line.slice('diff --git '.length);
  const quoted = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(rest);
  if (quoted) return headerPath(quoted[2]);
  const half = (rest.length - 1) / 2;
  const [a, b] = [rest.slice(0, half), rest.slice(half + 1)];
  return Number.isInteger(half) && a.startsWith('a/') && b === `b/${a.slice(2)}` ? a.slice(2) : null;
}

function parseDiffChunk(chunk, out) {
  const lines = chunk.split('\n');
  const first = lines.findIndex((l) => l.startsWith('@@'));
  const header = first === -1 ? lines : lines.slice(0, first);
  const plus = header.find((l) => l.startsWith('+++ '));
  const minus = header.find((l) => l.startsWith('--- '));
  const file = (plus && headerPath(plus.slice(4))) ?? (minus && headerPath(minus.slice(4))) ?? gitLinePath(lines[0]);
  if (!file) return;
  const added = first === -1 ? [] : lines.slice(first).filter((l) => l.startsWith('+')).map((l) => l.slice(1));
  out.set(file, [...(out.get(file) ?? []), ...added]);
}

/** Added lines per file for a whole diff range, in one `git diff -U0` call. */
function addedByFile(project, args) {
  const out = new Map();
  const text = git(project, [...DIFF_ARGS, ...args]).out;
  for (const chunk of text.split(/^(?=diff --git )/m)) if (chunk.startsWith('diff --git ')) parseDiffChunk(chunk, out);
  return out;
}

/** Added lines for `files`: one diff for the range; a file the batch parse missed falls back to its own diff. */
function addedLinesFor(project, args, files) {
  const batch = files.length ? addedByFile(project, args) : new Map();
  const result = new Map();
  for (const file of files) {
    if (batch.has(file)) result.set(file, batch.get(file));
    else result.set(file, addedByFile(project, [...args, '--', file]).values().next().value ?? []);
  }
  return result;
}

function workTreeText(project, file) {
  try {
    return readFileSync(join(project, file), 'utf8');
  } catch {
    return '';
  }
}

function untrackedAdded(project, file) {
  const text = workTreeText(project, file);
  if (text.includes('\0')) return [];
  return text.split('\n').filter((l, i, a) => i < a.length - 1 || l !== '');
}

/**
 * What the commit will hold: the index plus what `extra` (commit -a, pathspecs, a chained git add) stages.
 * Each change carries staged (already in the index) and viaCommand (staged only by this command's add / -a / pathspecs).
 */
export function stagedChanges(project, config, extra = {}) {
  const hasHead = refExists(project, 'HEAD');
  const base = hasHead ? 'HEAD' : EMPTY_TREE;
  const staged = nameStatus(project, ['--cached', base]);
  const stagedSet = new Set(staged);
  const work = new Set();
  if (extra.all || extra.paths === 'all') for (const f of gitNul(project, ['diff', '--name-only', '-z'])) work.add(f);
  if (extra.paths === 'all') for (const f of gitNul(project, ['ls-files', '--others', '--exclude-standard', '-z'])) work.add(f);
  else if (Array.isArray(extra.paths)) for (const f of extra.paths) work.add(f);
  const tracked = new Set(gitNul(project, ['ls-files', '-z']));

  const files = [...new Set([...staged, ...work])];
  const workTracked = files.filter((f) => work.has(f) && tracked.has(f));
  const indexOnly = files.filter((f) => !work.has(f));
  const fromWork = addedLinesFor(project, [base], workTracked);
  const fromIndex = addedLinesFor(project, ['--cached', base], indexOnly);

  const changes = [];
  for (const file of files) {
    const inWork = work.has(file);
    const added = fromWork.get(file) ?? fromIndex.get(file) ?? untrackedAdded(project, file);
    const change = { file, added, staged: stagedSet.has(file), viaCommand: inWork };
    if (pathClass(file, config) === 'manifest') {
      change.before = hasHead ? (readAtRef(project, 'HEAD', file) ?? '') : '';
      change.after = inWork ? workTreeText(project, file) : (readAtRef(project, null, file) ?? '');
    }
    changes.push(change);
  }
  return changes;
}

/**
 * allowAtHead: keep non-default candidates whose tip is at HEAD (used for `git commit`, so the first commit on a
 * branch freshly cut from an unmerged danger branch is judged on its own). push / pr leave it false: such a
 * candidate could be a decoy (`git branch deps/tmp`) hiding the branch's history.
 */
export function branchBase(project, config, prBase, { allowAtHead = false, current = currentBranch(project), def = defaultBranch(project, config) } = {}) {
  if (prBase) return prBase;
  const prefixes = Object.values(config?.prefixes ?? {});
  // The default branch counts as local, origin/<def> and its upstream: a stale local copy must not add others' commits.
  const defRefs = branchRefs(project, def).filter((r) => r !== current);
  const candidates = [...defRefs];
  for (const b of gitLines(project, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])) {
    if (b !== current && !candidates.includes(b) && prefixes.some((p) => b.startsWith(p))) candidates.push(b);
  }
  const head = git(project, ['rev-parse', 'HEAD']).out.trim();
  // A non-default branch whose tip is at or ahead of HEAD would hide this branch's own commits.
  return nearestRef(project, candidates, (ref, mb) => !allowAtHead && !defRefs.includes(ref) && mb === head);
}

export function branchChanges(project, config, base) {
  const mbRes = base ? git(project, ['merge-base', base, 'HEAD']) : { ok: false, out: '' };
  if (!mbRes.ok) return [];
  const mb = mbRes.out.trim();
  const range = `${mb}..HEAD`;
  const files = nameStatus(project, [range]);
  const added = addedLinesFor(project, [range], files);
  return files.map((file) => {
    const change = { file, added: added.get(file) ?? [] };
    if (pathClass(file, config) === 'manifest') {
      change.before = readAtRef(project, mb, file) ?? '';
      change.after = readAtRef(project, 'HEAD', file) ?? '';
    }
    return change;
  });
}

const SPEC_SECTIONS = ['Zone', 'What changes', 'Why', 'Blast radius', 'Rollback', 'Verification'];

const specSection = (text, heading) => {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  return lines.slice(start + 1, end < 0 ? lines.length : end)
    .join('\n')
    .replace(/<!--([\s\S]*?)-->/g, '')
    .trim();
};

const isSpecPlaceholder = (text) =>
  /\b(?:TODO|TBD|replace me)\b|\[(?:describe|write|add|replace|reason|expected|condition)\b[^\]]*\]/i.test(text);

export const specPath = (config, branch) => `${(config.specDir ?? DEFAULTS.specDir).replace(/\/+$/, '')}/${branch.replaceAll('/', '--')}.md`;

export function inspectSpec(text, zone) {
  if (text === null || text === undefined) return { valid: false, reason: 'spec file is missing' };
  for (const heading of SPEC_SECTIONS) {
    const body = specSection(text, heading);
    if (!body) return { valid: false, reason: `spec section "## ${heading}" is missing or empty` };
    if (isSpecPlaceholder(body)) return { valid: false, reason: `spec section "## ${heading}" still contains placeholder text` };
  }
  const declared = specSection(text, 'Zone').toLowerCase();
  if (declared !== zone) return { valid: false, reason: `spec section "## Zone" is "${declared}" but this branch is in zone "${zone}"` };
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const DANGER = ['db', 'packages', 'network'];
const CLASS_ORDER = ['db', 'packages', 'network', 'code'];
const MIGRATION_DIRS = ['**/migrations/**', '**/db/migrate/**', '**/alembic/versions/**', '**/drizzle/**'];
const CONFIG_FILE = '.claude/atomicity.json';
const NO_GENERATOR =
  'no migration generator is configured — set migrations.generate, or set migrations.allowEdits: true for tools whose migrations are hand-written (golang-migrate, Flyway, dbmate, goose)';

const allow = (note) => (note ? { block: false, note } : { block: false });
const block = (rule, text) => ({ block: true, reason: `Atomicity guard (${rule}): ${text}` });
const quote = (f) => (/^[\w./@%+=:,-]+$/.test(f) ? f : `'${f.replaceAll("'", `'\\''`)}'`);
const fileList = (files) => files.map(quote).join(' ');
const slug = (branch) => (branch ?? 'change').replace(/^[^/]*\//, '').replace(/[^\w.-]+/g, '-') || 'change';

/** `file` relative to `root`, comparing real paths (symlinked temp dirs, worktrees); null when outside. */
function relInside(root, file) {
  const rel = relative(realish(root), realish(file)).replaceAll('\\', '/');
  return !rel || rel.startsWith('..') || isAbsolute(rel) ? null : rel;
}

/** realpath of the longest existing ancestor, with the missing tail re-appended (the file may not exist yet). */
function realish(path) {
  const tail = [];
  let head = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(path);
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

function inMigrationDir(rel, config) {
  const dirs = (config.migrations?.dirs ?? []).map((d) => normalize(d).replace(/\/+$/, '')).filter(Boolean);
  const globs = dirs.length ? dirs.flatMap((d) => [d, `${d}/**`]) : MIGRATION_DIRS;
  return matchesAny(globs, rel);
}

/** R4. Relative paths resolve against the tool's cwd; the migration check is relative to the repo holding the file. */
function guardWrite(ctx, file, config) {
  const abs = resolve(ctx.cwd, file);
  const repoRel = relInside(ctx.repo, abs);
  const projectRel = relInside(ctx.project, abs);
  if (repoRel === CONFIG_FILE || projectRel === CONFIG_FILE) {
    return block('R4', `${CONFIG_FILE} configures this hook; only a human edits this file. Ask the user to make the change themselves.`);
  }
  const rel = repoRel ?? projectRel;
  if (rel && inMigrationDir(rel, config) && !config.migrations?.allowEdits) {
    const generate = config.migrations?.generate;
    const next = generate
      ? `Edit the schema/model source instead, then run: ${generate}. (A human can allow hand edits with "migrations": { "allowEdits": true } in ${CONFIG_FILE}.)`
      : `Edit the schema/model source instead and generate the migration with your tool. Note: ${NO_GENERATOR} in ${CONFIG_FILE} (a human edits that file).`;
    return block('R4', `${rel} is inside a migration directory; migrations are generated, not hand-written. ${next}`);
  }
  return null;
}

/** Expand `git add` / commit pathspecs (relative to the shell's cwd) to the concrete repo-relative files they would stage. */
function expandPaths(cwd, paths) {
  if (!paths.length) return [];
  const files = gitNul(cwd, ['ls-files', '-z', '--full-name', '--modified', '--others', '--exclude-standard', '--', ...paths]);
  return [...new Set(files)];
}

function commitPlan(ctx, intents) {
  const { adds, commit } = intents;
  const raw = [...(Array.isArray(adds) ? adds : []), ...(commit.paths ?? [])];
  const paths = adds === 'all' ? 'all' : expandPaths(ctx.cwd, raw);
  return { all: commit.all || intents.addsTracked, paths };
}

function willStage(repo, plan, file) {
  if (plan.paths === 'all') return true;
  if (plan.paths.includes(file)) return true;
  return plan.all && gitNul(repo, ['ls-files', '-z', '--', file]).includes(file);
}

/** { groups: class → files, evidence: file → the line that made it network, unstage / drop: files for the R1 hint }. */
function groupByClass(changes, config) {
  const out = { groups: {}, evidence: new Map(), staged: new Set(), viaCommand: new Set() };
  for (const change of changes) {
    const { cls, line } = classifyDetail(change, config);
    if (cls === 'neutral') continue;
    (out.groups[cls] ??= []).push(change.file);
    if (line !== undefined) out.evidence.set(change.file, line);
    if (change.staged) out.staged.add(change.file);
    if (change.viaCommand) out.viaCommand.add(change.file);
  }
  for (const files of Object.values(out.groups)) files.sort();
  return out;
}

const EMPTY_GROUPED = { groups: {}, evidence: new Map(), staged: new Set(), viaCommand: new Set() };
const orderedClasses = (groups) => CLASS_ORDER.filter((c) => groups[c]?.length);
const snippet = (line) => {
  const t = line.trim();
  return t.length > 160 ? `${t.slice(0, 157)}...` : t;
};
const evidenceLines = (files, evidence) => files.filter((f) => evidence.has(f)).map((f) => `    ${f}: ${snippet(evidence.get(f))}`);

function describeGroups({ groups, evidence }) {
  return orderedClasses(groups)
    .flatMap((c) => [`  ${c}: ${groups[c].join(', ')}`, ...evidenceLines(groups[c], evidence)])
    .join('\n');
}

function largestDanger(groups) {
  const danger = DANGER.filter((c) => groups[c]?.length);
  return danger.reduce((best, c) => (groups[c].length > groups[best].length ? c : best), danger[0]);
}

function mergeGroups(a, b) {
  const groups = {};
  for (const g of [a.groups, b.groups]) for (const [cls, files] of Object.entries(g)) groups[cls] = [...new Set([...(groups[cls] ?? []), ...files])].sort();
  return { groups, evidence: new Map([...a.evidence, ...b.evidence]), staged: new Set(), viaCommand: new Set() };
}

function checkSpec(config, branch, zone, text) {
  const path = specPath(config, branch);
  const result = inspectSpec(text, zone);
  if (result.valid) return null;
  return block(
    'R3',
    `${path}: ${result.reason}. A ${zone} branch must carry a spec with non-empty "## Zone" (${zone}), "## What changes", "## Why", ` +
      `"## Blast radius", "## Rollback" and "## Verification" sections. Write ${path}, then: git add ${quote(path)}`,
  );
}

function prefixBlock(config, zone, branch, files, onDefault, evidence) {
  const prefix = config.prefixes[zone];
  const where = onDefault ? `the default branch "${branch}"` : `branch "${branch}", which lacks the "${prefix}" prefix`;
  const lines = evidenceLines(files, evidence);
  return block(
    'R2',
    `${zone} changes (${files.join(', ')}) are on ${where}.${lines.length ? `\n${lines.join('\n')}\n` : ' '}Danger-zone changes live on a dedicated branch: ` +
      `git switch -c ${prefix}${slug(onDefault ? null : branch)}`,
  );
}

function r1Hint(grouped, rest, hasHead) {
  const unstage = rest.filter((f) => grouped.staged.has(f));
  const drop = rest.filter((f) => grouped.viaCommand.has(f));
  const unstageCmd = hasHead ? 'git restore --staged' : 'git rm --cached -q';
  const lines = [];
  if (unstage.length) lines.push(`unstage the rest: ${unstageCmd} ${fileList(unstage)}`);
  if (drop.length) lines.push(`${unstage.length ? 'and ' : ''}these are staged only by this command; drop them from the git add (or the -a / commit pathspec): ${fileList(drop)}`);
  return lines.join('\n');
}

function evaluateCommit(ctx, config, intents, branch, def) {
  const { repo } = ctx;
  const plan = commitPlan(ctx, intents);
  const grouped = groupByClass(stagedChanges(repo, config, plan), config);
  const { groups } = grouped;
  const classes = orderedClasses(groups);
  if (classes.length > 1) {
    const keep = largestDanger(groups);
    const rest = classes.filter((c) => c !== keep).flatMap((c) => groups[c]);
    return {
      grouped,
      plan,
      result: block(
        'R1',
        `this commit mixes ${classes.join(' + ')}; a commit may hold one zone (tests, docs and specs may ride along).\n${describeGroups(grouped)}\n` +
          `Keep the ${keep} files and ${r1Hint(grouped, rest, refExists(repo, 'HEAD'))}\n` +
          `Then commit them separately (${keep} on a ${config.prefixes[keep]}… branch, the rest on its own branch).`,
      ),
    };
  }
  const zone = classes[0];
  if (!DANGER.includes(zone) || !branch || !def) return { grouped, plan, result: null };
  if (branch === def || !branch.startsWith(config.prefixes[zone])) {
    return { grouped, plan, result: prefixBlock(config, zone, branch, groups[zone], branch === def, grouped.evidence) };
  }
  return { grouped, plan, result: checkSpec(config, branch, zone, commitSpecText(repo, config, branch, plan)) };
}

function commitSpecText(repo, config, branch, plan) {
  const path = specPath(config, branch);
  if (willStage(repo, plan, path)) {
    try {
      return readFileSync(join(repo, path), 'utf8');
    } catch {
      // not in the work tree: fall back to the index
    }
  }
  return readAtRef(repo, null, path);
}

/** A merge, cherry-pick or revert is being concluded: its staged set is someone else's already-reviewed commits. */
function sequencerInProgress(repo) {
  const paths = gitLines(repo, ['rev-parse', '--git-path', 'MERGE_HEAD', '--git-path', 'CHERRY_PICK_HEAD', '--git-path', 'REVERT_HEAD']);
  return paths.some((p) => existsSync(resolve(repo, p)));
}

function evaluateBranch(ctx, config, intents, branch, commit, def) {
  const { repo } = ctx;
  // gh pr create targets the default branch unless --base says otherwise (nearest of local and origin/).
  // A branch created in this command starts at HEAD: a commit on it is judged alone, a push carries the pre-switch history.
  let base;
  if (intents.pr) base = prBaseRef(repo, intents.pr.base ?? def);
  else if (intents.newBranch && !intents.push) base = 'HEAD';
  else base = branchBase(repo, config, null, { allowAtHead: Boolean(commit) && !intents.push, current: branch, def });
  if (!base) return allow('atomicity: no default branch, branch checks skipped');
  const grouped = mergeGroups(groupByClass(branchChanges(repo, config, base), config), commit?.grouped ?? EMPTY_GROUPED);
  const { groups } = grouped;
  const classes = orderedClasses(groups);
  if (classes.length > 1) {
    const keep = largestDanger(groups);
    const parent = intents.pr && !intents.pr.base ? stackedParent(repo, config, branch, def) : null;
    const stacked = parent ? `\nIf this PR stacks on ${parent}, target it instead: gh pr create --base ${parent}` : '';
    return block(
      'R2',
      `branch "${branch}" (compared with ${base}) mixes ${classes.join(' + ')}; a branch may hold one zone.\n${describeGroups(grouped)}\n` +
        `Move the ${keep} changes to their own branch (git switch -c ${config.prefixes[keep]}${slug(branch)} ${base}, then cherry-pick or re-apply them) ` +
        `and keep "${branch}" to the other zone.${stacked}`,
    );
  }
  const zone = classes[0];
  if (!DANGER.includes(zone)) return allow();
  if (!branch.startsWith(config.prefixes[zone])) return prefixBlock(config, zone, branch, groups[zone], false, grouped.evidence);
  // R3 on push / gh pr create: the spec as committed (or as about to be committed, when chained with a commit).
  if (!intents.push && !intents.pr) return allow();
  const text = commit ? commitSpecText(repo, config, branch, commit.plan) : readAtRef(repo, 'HEAD', specPath(config, branch));
  return checkSpec(config, branch, zone, text) ?? allow();
}

/** The nearest danger-prefixed ancestor branch, when it is nearer than the default branch (a stacked PR's parent). */
function stackedParent(repo, config, branch, def) {
  const parent = branchBase(repo, config, null, { current: branch, def });
  return parent && !branchRefs(repo, def).includes(parent) ? parent : null;
}

function evaluateRules(event, ctx) {
  const { project, repo } = ctx;
  const config = loadConfig(project);
  if (config.enabled === false) return allow();
  const { tool_name, tool_input = {} } = event ?? {};

  if (['Edit', 'MultiEdit', 'Write'].includes(tool_name)) {
    return (typeof tool_input.file_path === 'string' && guardWrite(ctx, tool_input.file_path, config)) || allow();
  }
  if (tool_name !== 'Bash' || typeof tool_input.command !== 'string') return allow();
  const command = tool_input.command;
  for (const target of shellWriteTargets(command)) {
    const hit = guardWrite(ctx, target, config);
    if (hit) return hit;
  }

  const intents = gitIntents(command);
  if (!intents.commit && !intents.push && !intents.pr) return allow();
  if (!ctx.isRepo) return allow('atomicity: not a git repo, skipped');

  if (intents.otherSwitch) {
    const next = intents.commit ? 'commit' : intents.push ? 'push' : 'gh pr create';
    return block('R2', `run the branch switch as its own command, then ${next}.`);
  }
  const branch = intents.newBranch ?? currentBranch(repo);
  if (branch && config.exempt.includes(branch)) return allow();
  const def = defaultBranch(repo, config);
  const skipNote = !branch ? 'atomicity: detached HEAD, branch checks skipped' : !def ? 'atomicity: no default branch, branch checks skipped' : null;

  let commit = null;
  if (intents.commit) {
    // Concluding a merge / cherry-pick / revert: skip R1 (and the staged set) and judge the branch's own history only.
    if (sequencerInProgress(repo)) commit = { grouped: EMPTY_GROUPED, plan: commitPlan(ctx, intents) };
    else {
      commit = evaluateCommit(ctx, config, intents, branch, def);
      if (commit.result) return commit.result;
    }
  }
  if (skipNote) return allow(skipNote);
  if (branch === def) return allow();
  return evaluateBranch(ctx, config, intents, branch, commit, def);
}

/** Top of the repository the tool runs in (event.cwd, e.g. a worktree), else the project's; else the project dir. */
function repoRoot(cwd, project) {
  for (const dir of new Set([cwd, project])) {
    const top = git(dir, ['rev-parse', '--show-toplevel']);
    if (top.ok && top.out.trim()) return { repo: top.out.trim(), isRepo: true };
  }
  return { repo: project, isRepo: false };
}

/** Config comes from the project dir; git and R4 paths follow the tool's cwd (worktrees, subdirectories). */
export function evaluate(event, { projectDir } = {}) {
  try {
    const project = resolve(projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
    const cwd = typeof event?.cwd === 'string' && event.cwd ? resolve(project, event.cwd) : project;
    return evaluateRules(event, { project, cwd, ...repoRoot(cwd, project) });
  } catch (error) {
    return allow(`atomicity: internal error, skipped: ${error?.message ?? error}`);
  }
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

if (import.meta.url === pathToFileURL(entryPath()).href) {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    process.exit(0);
  }
  const result = evaluate(event ?? {});
  if (result.block) {
    console.error(result.reason);
    process.exit(2);
  }
  if (result.note) console.log(result.note);
}
