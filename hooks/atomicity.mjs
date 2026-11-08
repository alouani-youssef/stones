import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

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

export function globToRegExp(glob) {
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
  return new RegExp(`^${out}$`);
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

const SKIPPED_HOST = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|.+\.local|example\.com|.+\.example\.com)$/i;
const URL_RE = /\b(?:https?|wss?):\/\/([^/'"\s:]+)/g;

function hasExternalUrl(line) {
  for (const m of line.matchAll(URL_RE)) if (!SKIPPED_HOST.test(m[1])) return true;
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

export function networkHit(addedLines, config) {
  const net = config.zones?.network ?? {};
  const sources = [...(net.patterns ?? []), ...(net.extraPatterns ?? []), ...(net.incoming ? (net.incomingPatterns ?? DEFAULTS.zones.network.incomingPatterns) : [])];
  const patterns = compilePatterns(sources);
  for (const line of addedLines ?? []) {
    if (hasExternalUrl(line) || patterns.some((re) => re.test(line))) return line;
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

function packageDeps(text) {
  if (!text.trim()) return {};
  const json = JSON.parse(text);
  return Object.fromEntries(DEP_KEYS.map((k) => [k, json?.[k] ?? null]));
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
const envNetworkChanged = (added) => (added ?? []).some((l) => ENV_KEY_RE.test(l));

export function classify(change, config) {
  const rel = normalize(change.file);
  const base = pathClass(rel, config);
  const ignored = matchesAny(config.zones?.network?.ignore ?? [], rel);
  if (base === 'manifest') {
    if (isSettings(rel)) return !ignored && settingsNetworkChanged(change.before, change.after) ? 'network' : 'code';
    if (isEnvExample(rel)) return !ignored && envNetworkChanged(change.added) ? 'network' : 'code';
    if (dependencyChanged(rel, change.before, change.after)) return 'packages';
    return contentClass(change, config, ignored);
  }
  if (base === 'network') return 'network';
  if (base === 'code') return incomingPath(rel, config) ? 'network' : contentClass(change, config, ignored);
  return base;
}

function incomingPath(rel, config) {
  const net = config.zones?.network ?? {};
  return Boolean(net.incoming) && matchesAny(net.incomingPaths ?? DEFAULTS.zones.network.incomingPaths, rel);
}

function contentClass(change, config, ignored) {
  return !ignored && networkHit(change.added ?? [], config) ? 'network' : 'code';
}

// ---------------------------------------------------------------------------
// Bash command parsing
// ---------------------------------------------------------------------------

function readHeredocTag(command, i) {
  const m = /^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z0-9_]+))/.exec(command.slice(i));
  return m ? { length: m[0].length, tag: m[2] ?? m[3] ?? m[4], strip: m[1] === '-' } : null;
}

function skipHeredocBody(command, from, heredocs) {
  let i = from;
  for (const { tag, strip } of heredocs) {
    while (i < command.length) {
      let end = command.indexOf('\n', i);
      if (end === -1) end = command.length;
      const line = command.slice(i, end);
      i = Math.min(end + 1, command.length);
      if ((strip ? line.replace(/^\t+/, '') : line) === tag) break;
    }
  }
  return i;
}

export function tokenize(command) {
  const commands = [];
  let words = [];
  let word = '';
  let has = false;
  const heredocs = [];
  const endWord = () => {
    if (has) words.push(word);
    word = '';
    has = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end === -1 ? command.length : end;
      word += command.slice(i + 1, stop);
      has = true;
      i = stop + 1;
    } else if (c === '"') {
      i += 1;
      has = true;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < command.length && '"\\$`\n'.includes(command[i + 1])) i += 1;
        if (!(command[i] === '\n' && command[i - 1] === '\\')) word += command[i];
        i += 1;
      }
      i += 1;
    } else if (c === '\\') {
      if (command[i + 1] === '\n') {
        i += 2;
      } else {
        word += command[i + 1] ?? '';
        has = true;
        i += 2;
      }
    } else if (c === '#' && !has) {
      while (i < command.length && command[i] !== '\n') i += 1;
    } else if (c === '<' && command.startsWith('<<<', i)) {
      endWord();
      i += 3;
    } else if (c === '<' && command[i + 1] === '<') {
      const h = readHeredocTag(command, i);
      if (h) {
        heredocs.push(h);
        i += h.length;
      } else {
        i += 2;
      }
    } else if (c === '\n') {
      endCommand();
      i += 1;
      if (heredocs.length) {
        i = skipHeredocBody(command, i, heredocs);
        heredocs.length = 0;
      }
    } else if (c === ';' || c === '|' || c === '&') {
      if (c === '&' && (command[i - 1] === '>' || command[i - 1] === '<')) {
        word += c;
        has = true;
        i += 1;
        continue;
      }
      endCommand();
      i += command[i + 1] === c || (c === '|' && command[i + 1] === '&') ? 2 : 1;
    } else if (c === '>') {
      if (/^\d+$/.test(word)) {
        word = '';
        has = false;
      }
      endWord();
      const op = command[i + 1] === '>' ? '>>' : '>';
      i += op.length;
      if (command[i] === '&') {
        words.push('>&');
        i += 1;
      } else {
        words.push(op);
      }
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i += 1;
    } else {
      word += c;
      has = true;
      i += 1;
    }
  }
  endCommand();
  return commands;
}

const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
const COMMIT_VALUE_FLAGS = new Set([
  '-m', '--message', '-F', '--file', '--author', '-C', '--reuse-message', '-c', '--reedit-message',
  '--date', '-t', '--template', '--cleanup', '--fixup', '--squash', '-S', '--gpg-sign', '--pathspec-from-file',
  '--trailer', '-u', '--untracked-files',
]);
const COMMIT_SHORT_VALUE = new Set(['m', 'F', 'C', 'c', 't']);

function gitSubcommand(words) {
  let i = words[0] === 'git' ? 1 : -1;
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
  let afterDashes = false;
  for (const a of args) {
    if (afterDashes || !a.startsWith('-')) {
      if (a === '.') all = true;
      else paths.push(a);
    } else if (a === '--') {
      afterDashes = true;
    } else if (a === '-A' || a === '--all') {
      all = true;
    }
  }
  return { all, paths };
}

function ghPrBase(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--base' || args[i] === '-B') return args[i + 1] ?? null;
    if (args[i].startsWith('--base=')) return args[i].slice(7);
  }
  return null;
}

export function gitIntents(command) {
  const out = { adds: null, commit: null, push: false, pr: null };
  for (const words of tokenize(command)) {
    if (words[0] === 'gh' && words[1] === 'pr' && words[2] === 'create') {
      out.pr = { base: ghPrBase(words.slice(3)) };
      continue;
    }
    const sub = gitSubcommand(words);
    if (!sub) continue;
    if (sub.name === 'add') {
      const { all, paths } = parseAdd(sub.args);
      if (all || out.adds === 'all') out.adds = 'all';
      else out.adds = [...(out.adds ?? []), ...paths];
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

export function defaultBranch(project, config) {
  const configured = config?.defaultBranch;
  if (configured && refExists(project, configured)) return configured;
  const head = git(project, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']);
  if (head.ok && head.out.trim()) return head.out.trim();
  return ['main', 'master'].find((b) => refExists(project, b)) ?? null;
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

function addedLines(project, args, file) {
  const out = git(project, ['--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', '--no-renames', '-U0', ...args, '--', file]).out;
  const lines = out.split('\n');
  const first = lines.findIndex((l) => l.startsWith('@@'));
  if (first === -1) return [];
  return lines
    .slice(first)
    .filter((l) => l.startsWith('+'))
    .map((l) => l.slice(1));
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

export function stagedChanges(project, config, extra = {}) {
  const hasHead = refExists(project, 'HEAD');
  const base = hasHead ? 'HEAD' : EMPTY_TREE;
  const staged = nameStatus(project, ['--cached', base]);
  const work = new Set();
  if (extra.all || extra.paths === 'all') for (const f of gitNul(project, ['diff', '--name-only', '-z'])) work.add(f);
  if (extra.paths === 'all') for (const f of gitNul(project, ['ls-files', '--others', '--exclude-standard', '-z'])) work.add(f);
  else if (Array.isArray(extra.paths)) for (const f of extra.paths) work.add(f);
  const tracked = new Set(gitNul(project, ['ls-files', '-z']));

  const changes = [];
  for (const file of new Set([...staged, ...work])) {
    const inWork = work.has(file);
    const isTracked = tracked.has(file);
    let added;
    if (inWork && !isTracked) added = untrackedAdded(project, file);
    else added = addedLines(project, inWork ? [base] : ['--cached', base], file);
    const change = { file, added };
    if (pathClass(file, config) === 'manifest') {
      change.before = hasHead ? (readAtRef(project, 'HEAD', file) ?? '') : '';
      change.after = inWork ? workTreeText(project, file) : (readAtRef(project, null, file) ?? '');
    }
    changes.push(change);
  }
  return changes;
}

export function branchBase(project, config, prBase) {
  if (prBase) return prBase;
  const current = currentBranch(project);
  const prefixes = Object.values(config?.prefixes ?? {});
  const candidates = [];
  const def = defaultBranch(project, config);
  if (def && def !== current) candidates.push(def);
  for (const b of gitLines(project, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])) {
    if (b !== current && !candidates.includes(b) && prefixes.some((p) => b.startsWith(p))) candidates.push(b);
  }
  let best = null;
  let bestCount = Infinity;
  for (const cand of candidates) {
    const mb = git(project, ['merge-base', cand, 'HEAD']);
    if (!mb.ok) continue;
    const count = Number(git(project, ['rev-list', '--count', `${mb.out.trim()}..HEAD`]).out.trim());
    if (Number.isFinite(count) && count < bestCount) {
      best = cand;
      bestCount = count;
    }
  }
  return best;
}

export function branchChanges(project, config, base) {
  const mbRes = base ? git(project, ['merge-base', base, 'HEAD']) : { ok: false, out: '' };
  if (!mbRes.ok) return [];
  const mb = mbRes.out.trim();
  const range = `${mb}..HEAD`;
  return nameStatus(project, [range]).map((file) => {
    const change = { file, added: addedLines(project, [range], file) };
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

export const specPath = (config, branch) => `${config.specDir}/${branch.replaceAll('/', '--')}.md`;

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
