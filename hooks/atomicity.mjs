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
