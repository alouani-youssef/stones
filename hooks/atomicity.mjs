import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
      patterns: [],
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
  const rel = file.replaceAll('\\', '/').replace(/^\.\//, '');
  const zones = config.zones ?? {};
  if (matchesAny(zonePaths(zones.db), rel)) return 'db';
  if (matchesAny(zonePaths(zones.packages), rel)) return MANIFESTS.has(rel.split('/').pop()) ? 'manifest' : 'packages';
  if (matchesAny(zonePaths(zones.network), rel)) return 'network';
  const specDir = (config.specDir ?? '').replace(/\/+$/, '');
  if (specDir && matchesAny([`${specDir}/**`], rel)) return 'neutral';
  if (matchesAny(NEUTRAL_PATHS, rel)) return 'neutral';
  return 'code';
}
