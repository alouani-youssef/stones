// PreToolUse hook: before Claude creates a new file with Write, check that its
// name (and any new directories on its path) follow the project's naming
// convention. Blocks with exit 2 and a suggested name when it does not.
//
// The convention for a file is resolved in this order:
//   1. `.claude/naming.json` in the project (explicit override)
//   2. the dominant style of sibling files with the same extension
//   3. the dominant style of same-extension files across the project
//   4. the language / framework default (PEP 8, Go, Java, React, ...)
//
// The file's role is kept apart from its name: `user.service.ts` is the name
// `user` with the role `service`, and roles must be lowercase. Languages
// that cannot have dots in module names (Python, Go, Rust...) are told how
// to express the role instead (`test_user.py`, `user_test.go`).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------- styles

const STYLE_TESTS = {
  kebab: (s) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s),
  snake: (s) => /^[a-z0-9]+(_[a-z0-9]+)*$/.test(s),
  camel: (s) => /^[a-z][a-zA-Z0-9]*$/.test(s),
  pascal: (s) => /^[A-Z][a-zA-Z0-9]*$/.test(s) && /[a-z]/.test(s),
  screaming: (s) => /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/.test(s),
  flat: (s) => /^[a-z][a-z0-9]*$/.test(s),
};

const STYLE_LABELS = {
  kebab: 'kebab-case',
  snake: 'snake_case',
  camel: 'camelCase',
  pascal: 'PascalCase',
  screaming: 'SCREAMING_SNAKE_CASE',
  flat: 'lowercase',
};

export const stylesOf = (name) =>
  Object.keys(STYLE_TESTS).filter((style) => STYLE_TESTS[style](name));

export function words(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s\-_.]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);

export function format(name, style) {
  const w = words(name);
  if (w.length === 0) return name;
  switch (style) {
    case 'kebab': return w.join('-');
    case 'snake': return w.join('_');
    case 'camel': return w[0] + w.slice(1).map(cap).join('');
    case 'pascal': return w.map(cap).join('');
    case 'screaming': return w.join('_').toUpperCase();
    case 'flat': return w.join('');
    default: return name;
  }
}

// ------------------------------------------------------------- languages

// Default file-name styles per extension; the first entry is the one used
// for suggestions. `dots: false` means the language cannot carry a role
// suffix such as `.service` in the file name.
const LANGUAGES = {
  py: { styles: ['snake'], dirs: ['snake'], dots: false, test: 'prefix' },
  pyi: { styles: ['snake'], dirs: ['snake'], dots: false },
  go: { styles: ['snake'], dirs: ['flat', 'snake'], dots: false, test: 'suffix' },
  rs: { styles: ['snake'], dirs: ['snake'], dots: false, test: 'suffix' },
  rb: { styles: ['snake'], dirs: ['snake'], dots: false, test: 'suffix', testWord: 'spec' },
  ex: { styles: ['snake'], dirs: ['snake'], dots: false, test: 'suffix' },
  exs: { styles: ['snake'], dirs: ['snake'], dots: false, test: 'suffix' },
  dart: { styles: ['snake'], dirs: ['snake'], dots: false, test: 'suffix' },
  c: { styles: ['snake'], dirs: ['snake', 'kebab'], dots: false },
  h: { styles: ['snake'], dirs: ['snake', 'kebab'], dots: false },
  cpp: { styles: ['snake'], dirs: ['snake', 'kebab'], dots: false },
  hpp: { styles: ['snake'], dirs: ['snake', 'kebab'], dots: false },
  lua: { styles: ['snake'], dirs: ['snake', 'kebab'], dots: false },
  java: { styles: ['pascal'], dirs: ['flat'], dots: false, test: 'suffix', testWord: 'Test' },
  kt: { styles: ['pascal'], dirs: ['flat'], dots: false, test: 'suffix', testWord: 'Test' },
  scala: { styles: ['pascal'], dirs: ['flat'], dots: false, test: 'suffix', testWord: 'Spec' },
  cs: { styles: ['pascal'], dirs: ['pascal'], dots: false, test: 'suffix', testWord: 'Tests' },
  swift: { styles: ['pascal'], dirs: ['pascal'], dots: false, test: 'suffix', testWord: 'Tests' },
  php: { styles: ['pascal'], dirs: ['pascal'], dots: false, test: 'suffix', testWord: 'Test' },
  vue: { styles: ['pascal'], dirs: ['kebab'] },
  svelte: { styles: ['pascal'], dirs: ['kebab'] },
  jsx: { styles: ['pascal'], dirs: ['kebab'] },
  tsx: { styles: ['pascal'], dirs: ['kebab'] },
  js: { styles: ['kebab'], dirs: ['kebab'] },
  mjs: { styles: ['kebab'], dirs: ['kebab'] },
  cjs: { styles: ['kebab'], dirs: ['kebab'] },
  ts: { styles: ['kebab'], dirs: ['kebab'] },
  mts: { styles: ['kebab'], dirs: ['kebab'] },
  cts: { styles: ['kebab'], dirs: ['kebab'] },
  css: { styles: ['kebab'], dirs: ['kebab'] },
  scss: { styles: ['kebab'], dirs: ['kebab'] },
  sass: { styles: ['kebab'], dirs: ['kebab'] },
  less: { styles: ['kebab'], dirs: ['kebab'] },
  html: { styles: ['kebab'], dirs: ['kebab'] },
  sh: { styles: ['kebab', 'snake'], dirs: ['kebab'] },
  bash: { styles: ['kebab', 'snake'], dirs: ['kebab'] },
  sql: { styles: ['snake', 'kebab'], dirs: ['kebab', 'snake'] },
  json: { styles: ['kebab'], dirs: ['kebab'] },
  yml: { styles: ['kebab'], dirs: ['kebab'] },
  yaml: { styles: ['kebab'], dirs: ['kebab'] },
  toml: { styles: ['kebab'], dirs: ['kebab'] },
  toon: { styles: ['kebab'], dirs: ['kebab'] },
  md: { styles: ['kebab', 'screaming'], dirs: ['kebab'] },
  mdx: { styles: ['kebab'], dirs: ['kebab'] },
};

// Names that are valid regardless of the inferred style.
const RESERVED = new Set([
  'index', 'main', 'mod', 'lib', 'build', 'app', 'App', 'setup', 'conftest',
  'manage', 'wsgi', 'asgi', 'env', 'global', 'globals', 'types', 'vite-env',
  'next-env', 'README', 'LICENSE', 'CHANGELOG', 'CONTRIBUTING', 'CLAUDE',
  'AGENTS', 'AGENT', 'SECURITY', 'CODE_OF_CONDUCT', 'tsconfig', 'jsconfig',
  'package', 'package-lock', 'docker-compose', 'compose',
]);

// Framework-reserved route and entry files, keyed by detected framework.
const FRAMEWORK_RESERVED = {
  next: [
    'page', 'layout', 'template', 'loading', 'error', 'global-error',
    'not-found', 'route', 'default', 'middleware', 'instrumentation',
    'opengraph-image', 'twitter-image', 'icon', 'apple-icon', 'sitemap',
    'robots', 'manifest', 'proxy',
  ],
  nuxt: ['app', 'error', 'nuxt.config'],
  remix: ['root', 'entry.client', 'entry.server'],
};

// File roles that keep their meaning in any language.
const TEST_ROLES = new Set(['test', 'spec', 'e2e', 'tests']);

// ---------------------------------------------------------------- project

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export function detectStack(project) {
  const pkg = readJson(join(project, 'package.json')) ?? {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  const has = (name) => Object.hasOwn(deps, name);
  return {
    next: has('next'),
    nuxt: has('nuxt'),
    remix: has('@remix-run/react') || has('@react-router/dev'),
    react: has('react') || has('preact'),
    angular: has('@angular/core'),
    nest: has('@nestjs/core'),
    sveltekit: has('@sveltejs/kit'),
  };
}

function loadConfig(project) {
  return readJson(join(project, '.claude', 'naming.json')) ?? {};
}

const globToRegex = (glob) =>
  new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\/?/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\u0000/g, '.*')}$`,
  );

// ------------------------------------------------------------- file parts

// `_vars.scss` -> prefix `_`, `user.service.spec.ts` -> name `user`,
// roles [`service`, `spec`], ext `ts`.
export function splitFile(file) {
  const m = /^([_]*)(.*)$/.exec(file);
  const prefix = m[1];
  const parts = m[2].split('.');
  const ext = parts.length > 1 ? parts.pop().toLowerCase() : '';
  const [name = '', ...roles] = parts;
  return { prefix, name, roles, ext };
}

// Names we never judge: dotfiles, extensionless files (Dockerfile, Makefile),
// dynamic route segments ([id], (group), @slot), SvelteKit `+page`, and
// Python dunder modules.
const isExempt = (file) =>
  file.startsWith('.') ||
  !file.includes('.') ||
  /^[[(@+]/.test(file) ||
  /^__\w+__\./.test(file);

const isExemptDir = (dir) => /^[[(@+._]/.test(dir) || /^__\w+__$/.test(dir);

// ------------------------------------------------------------- inference

function dominantStyle(names, minSamples) {
  const counts = {};
  let total = 0;
  for (const name of names) {
    const styles = stylesOf(name).filter((s) => s !== 'flat');
    // A single lowercase word fits kebab, snake and camel at once: no signal.
    if (styles.length !== 1) continue;
    counts[styles[0]] = (counts[styles[0]] ?? 0) + 1;
    total++;
  }
  if (total < minSamples) return undefined;
  const [style, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return count / total >= 0.6 ? { style, count } : undefined;
}

const sampleName = (file) => {
  if (isExempt(file)) return undefined;
  const { name } = splitFile(file);
  return RESERVED.has(name) ? undefined : name;
};

function siblingNames(dir, ext) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && splitFile(d.name).ext === ext)
      .map((d) => sampleName(d.name))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function projectNames(project, ext) {
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '--', `*.${ext}`],
      { cwd: project, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out
      .split('\n')
      .filter(Boolean)
      .slice(0, 5000)
      .map((p) => sampleName(basename(p)))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function subdirNames(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !isExemptDir(d.name) && d.name !== 'node_modules')
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// --------------------------------------------------------------- rules

function fileRule({ project, dir, ext, name, config, stack }) {
  const lang = LANGUAGES[ext];
  const configured = config.extensions?.[ext];
  if (configured) {
    return { ...lang, styles: [configured].flat(), source: '.claude/naming.json' };
  }
  if (!lang) return undefined;

  const local = dominantStyle(siblingNames(dir, ext), 2);
  if (local) {
    return {
      ...lang,
      styles: [local.style],
      source: `${local.count} sibling .${ext} files in ${relative(project, dir) || '.'}`,
    };
  }
  const wide = dominantStyle(projectNames(project, ext), 3);
  if (wide) {
    return { ...lang, styles: [wide.style], source: `${wide.count} .${ext} files in the project` };
  }

  // React-style hooks (`useAuth`) are camelCase by convention.
  if (stack.react && /^use[A-Z-]/.test(name) && ['js', 'jsx', 'ts', 'tsx'].includes(ext)) {
    return { ...lang, styles: ['camel'], source: 'the React hook convention' };
  }
  // Next.js / Remix / shadcn projects commonly use kebab-case components.
  if ((stack.next || stack.remix) && ['jsx', 'tsx'].includes(ext)) {
    return { ...lang, styles: ['pascal', 'kebab'], source: 'the Next.js convention' };
  }
  return { ...lang, source: `the .${ext} language default` };
}

function dirRule({ project, parent, ext, config }) {
  if (config.directories) {
    return { styles: [config.directories].flat(), source: '.claude/naming.json' };
  }
  const local = dominantStyle(subdirNames(parent), 2);
  if (local) {
    return { styles: [local.style], source: `${local.count} sibling directories` };
  }
  const lang = LANGUAGES[ext];
  return { styles: lang?.dirs ?? ['kebab', 'snake'], source: `the .${ext} language default` };
}

const describe = (styles) => styles.map((s) => STYLE_LABELS[s] ?? s).join(' or ');

// ------------------------------------------------------------- checking

function suggestFile({ prefix, name, roles, ext }, rule) {
  const style = rule.styles[0];
  const testRoles = roles.filter((r) => TEST_ROLES.has(r.toLowerCase()));
  const otherRoles = roles.filter((r) => !TEST_ROLES.has(r.toLowerCase()));

  if (rule.dots === false) {
    // Fold roles into the name the way the language expects.
    let w = [...words(name), ...otherRoles.flatMap(words)].join(' ');
    if (testRoles.length && rule.test) {
      const testWord = rule.testWord ?? 'test';
      w = rule.test === 'prefix' ? `${testWord} ${w}` : `${w} ${testWord}`;
    }
    return `${prefix}${format(w, style)}.${ext}`;
  }
  const fixedRoles = roles.map((r) => format(r, 'kebab'));
  return [`${prefix}${format(name, style)}`, ...fixedRoles, ext].join('.');
}

function checkFile({ file, dir, project, config, stack }) {
  if (isExempt(file)) return undefined;
  const parts = splitFile(file);
  const { name, roles, ext } = parts;

  if (/\s/.test(file)) {
    const rule = fileRule({ project, dir, ext, name, config, stack }) ?? { styles: ['kebab'] };
    return {
      reason: `"${file}" contains whitespace`,
      suggestion: suggestFile(splitFile(file.replace(/\s+/g, '-')), rule),
    };
  }

  const reserved = new Set([
    ...RESERVED,
    ...Object.entries(FRAMEWORK_RESERVED).flatMap(([fw, names]) => (stack[fw] ? names : [])),
    ...(config.allow ?? []),
  ]);
  if (reserved.has(name) || reserved.has(file) || reserved.has([name, ...roles].join('.'))) {
    return undefined;
  }

  const rule = fileRule({ project, dir, ext, name, config, stack });
  if (!rule) return undefined;

  if (rule.dots === false && roles.length) {
    return {
      reason: `.${ext} module names cannot contain dots, so the "${roles.join('.')}" role must be part of the name`,
      suggestion: suggestFile(parts, rule),
    };
  }
  const badRole = roles.find((r) => !STYLE_TESTS.kebab(r));
  if (badRole) {
    return {
      reason: `the role suffix ".${badRole}" must be lowercase kebab-case (e.g. ".service", ".spec")`,
      suggestion: suggestFile(parts, rule),
    };
  }
  const nameStyles = stylesOf(name);
  if (!rule.styles.some((s) => nameStyles.includes(s))) {
    return {
      reason: `"${name}" is not ${describe(rule.styles)}, which this project uses for .${ext} files (from ${rule.source})`,
      suggestion: suggestFile(parts, rule),
    };
  }
  return undefined;
}

// New directories on the path, from the outermost existing ancestor down.
function checkDirs({ file, project, ext, config }) {
  const segments = relative(project, dirname(file)).split(sep).filter(Boolean);
  let parent = project;
  const fixed = [];
  let problem;
  for (const segment of segments) {
    const current = join(parent, segment);
    if (existsSync(current) || isExemptDir(segment) || problem) {
      fixed.push(segment);
    } else {
      const rule = dirRule({ project, parent, ext, config });
      if (rule.styles.some((s) => stylesOf(segment).includes(s))) {
        fixed.push(segment);
      } else {
        const suggestion = format(segment, rule.styles[0]);
        fixed.push(suggestion);
        problem = `the new directory "${segment}" is not ${describe(rule.styles)} (from ${rule.source}); use "${suggestion}"`;
      }
    }
    parent = current;
  }
  return problem ? { reason: problem, path: fixed.join('/') } : undefined;
}

// ------------------------------------------------------------- entrypoint

export function evaluate(event, { projectDir } = {}) {
  const { tool_name, tool_input = {} } = event ?? {};
  if (tool_name !== 'Write') return { block: false };
  const given = tool_input.file_path;
  if (typeof given !== 'string' || given === '') return { block: false };

  const project = resolve(projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  const file = resolve(project, given);
  const rel = relative(project, file);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return { block: false };

  // Only new files: editing or overwriting an existing file keeps its name.
  if (existsSync(file)) return { block: false };

  const config = loadConfig(project);
  if (config.enabled === false) return { block: false };
  const relPosix = rel.split(sep).join('/');
  const ignore = ['node_modules/**', 'dist/**', 'build/**', 'vendor/**', ...(config.ignore ?? [])];
  if (ignore.some((g) => globToRegex(g).test(relPosix))) return { block: false };

  const stack = detectStack(project);
  const name = basename(file);
  const dir = dirname(file);
  const ext = splitFile(name).ext;

  const dirProblem = checkDirs({ file, project, ext, config });
  const fileProblem = checkFile({ file: name, dir, project, config, stack });
  if (!dirProblem && !fileProblem) return { block: false };

  const finalDir = dirProblem?.path ?? relative(project, dir).split(sep).join('/');
  const finalName = fileProblem?.suggestion ?? name;
  const suggested = finalDir ? `${finalDir}/${finalName}` : finalName;
  const reasons = [dirProblem?.reason, fileProblem?.reason].filter(Boolean).join('; ');

  return {
    block: true,
    suggestion: suggested,
    reason:
      `Naming convention: ${relPosix} — ${reasons}. ` +
      `Create "${suggested}" instead. ` +
      'If this name is intentional (framework-reserved, generated, third-party), ' +
      'add it to "allow" or "ignore" in .claude/naming.json.',
  };
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
  let result = { block: false };
  try {
    result = evaluate(JSON.parse(input));
  } catch {
    // Never break file creation because the hook itself failed.
    process.exit(0);
  }
  if (result.block) {
    console.error(result.reason);
    process.exit(2);
  }
}
