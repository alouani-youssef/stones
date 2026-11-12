// PostToolUse hook: measures cognitive complexity (SonarQube rule S3776) of edited Python, JS/TS and Go files and asks Claude to refactor functions it pushed over the limit.
//
// Analyzers implement SonarSource's Cognitive Complexity definition and run
// locally in well under a second, so every edit can be checked without a
// SonarQube server:
//   - JavaScript / TypeScript: eslint-plugin-sonarjs (SonarSource's own rule)
//   - Python: complexipy (also provides measured refactor plans)
//   - Go: gocognit
// Each analyzer is used when installed in the project or on PATH; otherwise
// the hook falls back to the analyzer container from
// `.claude/analyzers/compose.yaml` (`docker compose up -d`), installed with this hook. Nothing is installed or
// downloaded. When neither is available, Claude is told once per session.
//
// Clean as you code: the edited file is compared with its version at git
// HEAD, and only functions that are new and over the limit, or that this
// change made more complex, are reported. Legacy complexity is left alone.
// Reports exit 2 so Claude sees the findings and refactors.
//
// Optional `.claude/complexity.json`:
//   {
//     "enabled": true,
//     "threshold": 15,                         // SonarQube default
//     "ignore": ["migrations/**", "**/*.gen.go"],
//     "tools": { "complexipy": "/path", "gocognit": "/path" },
//     "backend": "auto",                       // auto | local | docker
//     "container": "claude-analyzers"
//   }
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_THRESHOLD = 15;
export const DEFAULT_CONTAINER = 'claude-analyzers';

const LANGUAGES = {
  py: 'python',
  pyi: 'python',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'javascript',
  tsx: 'javascript',
  mts: 'javascript',
  cts: 'javascript',
  go: 'go',
};

const DEFAULT_IGNORE = ['node_modules/**', 'dist/**', 'build/**', 'vendor/**', '.venv/**', 'venv/**'];

const INSTALL = {
  python: 'pip install complexipy',
  javascript: 'npm install --save-dev eslint eslint-plugin-sonarjs typescript-eslint',
  go: 'go install github.com/uudashr/gocognit/cmd/gocognit@latest',
};
const COMPOSE_HINT = 'or start the analyzer container: docker compose -f .claude/analyzers/compose.yaml up -d --build';

export const languageOf = (file) => LANGUAGES[file.slice(file.lastIndexOf('.') + 1).toLowerCase()];

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function executable(project, name, override) {
  if (override) return existsSync(override) ? override : null;
  const gopath = process.env.GOPATH ?? join(homedir(), 'go');
  const candidates = [
    join(project, 'node_modules', '.bin', name),
    join(project, '.venv', 'bin', name),
    join(project, 'venv', 'bin', name),
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map((d) => join(d, name)),
    ...(process.env.GOBIN ? [join(process.env.GOBIN, name)] : []),
    join(gopath, 'bin', name),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

// Runs `fn` with `source` written to a temporary file named like the
// original, so analyzers see the right language and file name.
function withTempCopy(file, source, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'complexity-'));
  try {
    const copy = join(dir, basename(file));
    writeFileSync(copy, source);
    return fn(copy, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------- analyzers
// Each returns [{ name, key, line, complexity, plans }] or null when the
// analyzer is not installed. `key` identifies the function across versions.

// Finds the line of a complexipy function name: `Class::method` or `func`.
export function pythonLine(lines, qualified) {
  const parts = qualified.split('::');
  let from = 0;
  parts.forEach((part, i) => {
    const kind = i === parts.length - 1 ? '(?:async\\s+)?def' : '(?:class|(?:async\\s+)?def)';
    const re = new RegExp(`^\\s*${kind}\\s+${part.replace(/[^\w]/g, '')}\\b`);
    const at = lines.findIndex((l, n) => n >= from && re.test(l));
    if (at >= 0) from = at;
  });
  return from + 1;
}

function analyzePython({ project, file, source, tools }) {
  const bin = executable(project, 'complexipy', tools.complexipy);
  if (!bin) return null;
  return withTempCopy(file, source, (copy, dir) => {
    const out = join(dir, 'result.json');
    try {
      execFileSync(bin, [copy, '--output-format', 'json', '--output', out, '--suggest-refactors', '-q'], {
        cwd: dir, stdio: 'ignore', timeout: 20000,
      });
    } catch {
      // complexipy exits 1 when a function exceeds its own limit.
    }
    if (!existsSync(out)) return [];
    const lines = source.split('\n');
    return JSON.parse(readFileSync(out, 'utf8')).map((f) => ({
      name: f.function_name,
      key: f.function_name,
      line: pythonLine(lines, f.function_name),
      complexity: f.complexity,
      plans: (f.refactor_plans ?? []).map((p) => ({
        title: p.title,
        description: p.description,
        lines: [p.line_start, p.line_end],
        reduction: p.estimated_reduction,
      })),
    }));
  });
}

function analyzeGo({ project, file, source, tools }) {
  const bin = executable(project, 'gocognit', tools.gocognit);
  if (!bin) return null;
  return withTempCopy(file, source, (copy, dir) => {
    const json = execFileSync(bin, ['-json', copy], { cwd: dir, encoding: 'utf8', timeout: 20000 });
    return (JSON.parse(json || '[]') ?? []).map((f) => ({
      name: f.FuncName,
      key: f.FuncName,
      line: f.Pos.Line,
      complexity: f.Complexity,
      plans: [],
    }));
  });
}

// Names the function a sonarjs message points at; anonymous functions are
// keyed by their (trimmed) source line so they still match across versions.
export function jsFunction(lines, message) {
  const text = lines[message.line - 1] ?? '';
  const token = message.endLine === message.line ? text.slice(message.column - 1, message.endColumn - 1) : '';
  if (/^[A-Za-z_$][\w$]*$/.test(token) && token !== 'function') return { name: token, key: token };
  const assigned = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=|([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:function|\()/.exec(text);
  const name = assigned?.[1] ?? assigned?.[2];
  return name ? { name, key: name } : { name: 'anonymous function', key: `anonymous:${text.trim()}` };
}

async function analyzeJavaScript({ project, file, source }) {
  const req = createRequire(join(project, 'package.json'));
  let ESLint;
  let sonarjs;
  try {
    ({ ESLint } = await import(pathToFileURL(req.resolve('eslint')).href));
    sonarjs = (await import(pathToFileURL(req.resolve('eslint-plugin-sonarjs')).href)).default;
  } catch {
    return null;
  }
  let parser;
  if (/\.[mc]?tsx?$/.test(file)) {
    for (const id of ['typescript-eslint', '@typescript-eslint/parser']) {
      try {
        const mod = (await import(pathToFileURL(req.resolve(id)).href)).default;
        parser = mod.parser ?? mod;
        break;
      } catch { /* try the next parser */ }
    }
    if (!parser) return null;
  }
  const eslint = new ESLint({
    cwd: project,
    overrideConfigFile: true,
    overrideConfig: [{
      files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
      plugins: { sonarjs },
      languageOptions: {
        ...(parser ? { parser } : {}),
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      // Threshold 0 reports every function that has any complexity, so the
      // hook can compare against the HEAD version itself.
      rules: { 'sonarjs/cognitive-complexity': ['error', 0] },
    }],
  });
  const [result] = await eslint.lintText(source, { filePath: file });
  const lines = source.split('\n');
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === 'sonarjs/cognitive-complexity')
    .map((m) => ({
      ...jsFunction(lines, m),
      line: m.line,
      complexity: Number(/from (\d+)/.exec(m.message)?.[1] ?? 0),
      plans: [],
    }));
}

const ANALYZERS = { python: analyzePython, javascript: analyzeJavaScript, go: analyzeGo };

// Runs the analyzer inside the compose container: the source goes in on
// stdin, so no project mount or matching paths are needed. Returns null when
// the container is not running.
export function analyzeInDocker({ language, file, source, container }) {
  try {
    const out = execFileSync(
      'docker',
      ['exec', '-i', container, 'node', '/opt/analyzers/complexity.mjs', '--analyze', language, basename(file)],
      { input: source, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
    );
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// Local analyzer first, then the container, unless `backend` pins one.
async function analyzeWith(config, { language, project, file, source }) {
  const backend = config.backend ?? 'auto';
  if (backend !== 'docker') {
    const local = await ANALYZERS[language]({ project, file, source, tools: config.tools ?? {} });
    if (local !== null || backend === 'local') return local;
  }
  return analyzeInDocker({ language, file, source, container: config.container ?? DEFAULT_CONTAINER });
}

// --------------------------------------------------------------- ratchet

// Functions over the threshold that are new, or more complex than at HEAD.
export function regressions(current, baseline, threshold) {
  const before = new Map();
  for (const f of baseline ?? []) before.set(f.key, Math.max(before.get(f.key) ?? 0, f.complexity));
  return current
    .filter((f) => f.complexity > threshold)
    .filter((f) => !before.has(f.key) || f.complexity > before.get(f.key))
    .map((f) => ({ ...f, previous: before.get(f.key) }))
    .sort((a, b) => b.complexity - a.complexity);
}

function headVersion(project, rel, ref = 'HEAD') {
  try {
    return execFileSync('git', ['show', `${ref}:${rel.split(sep).join('/')}`], {
      cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null; // new, untracked, or not a git repository
  }
}

// ------------------------------------------------------------ suggestions

const HOW_IT_COUNTS =
  'Cognitive complexity adds +1 for each if/else if/else, loop, catch, switch, ternary, ' +
  'boolean-operator sequence, jump (break/continue to label, goto) and recursion, plus +1 per level of nesting ' +
  'for each nested structure — so nesting is usually the biggest cost.';

const PATTERNS = {
  common: [
    'Guard clauses: handle invalid/edge cases first and return early instead of wrapping the main path in if/else.',
    'Extract the most deeply nested block into a well-named helper; each extraction resets nesting to zero.',
    'Name compound conditions: move `a && (b || c)` into a predicate such as `isEligible(user)`.',
    'Replace long if/else-if or switch chains on a value with a lookup table or a map of handlers.',
  ],
  python: [
    'Use `continue` guards at the top of loops, and comprehensions or any()/all() instead of loop + if + append.',
    'Dispatch with a dict of callables instead of if/elif on a mode or type.',
  ],
  javascript: [
    'Use optional chaining (?.) and nullish coalescing (??) instead of nested null checks.',
    'Replace nested loops with array methods (filter/map/some/find) when they express the intent directly.',
  ],
  go: [
    'Return on `err != nil` immediately; keep the happy path unindented.',
    'Move per-item loop bodies into functions, and replace type/value switches with a map or interface method.',
  ],
};

export function report({ rel, language, threshold, found }) {
  const lines = [
    `Cognitive complexity (SonarQube rule S3776, limit ${threshold}): ${rel} has ${found.length} function(s) this change pushed over the limit.`,
  ];
  for (const f of found) {
    const was = f.previous === undefined ? 'new' : `was ${f.previous}`;
    lines.push(`- ${f.name} (line ${f.line}): ${f.complexity} (${was}) — reduce by at least ${f.complexity - threshold}.`);
    for (const p of f.plans.slice(0, 3)) {
      const reduction = p.reduction ? `, about -${p.reduction}` : '';
      lines.push(`    • ${p.title} (lines ${p.lines[0]}-${p.lines[1]}${reduction}): ${p.description}`);
    }
  }
  lines.push('', HOW_IT_COUNTS, 'Suggested refactorings:');
  for (const tip of [...PATTERNS.common, ...PATTERNS[language]]) lines.push(`- ${tip}`);
  lines.push(
    '',
    'Refactor these functions now, preserving behavior: keep the public signature, then rerun the related tests. ' +
    'If the complexity is essential (e.g. a parser or state machine), explain why to the user instead of hiding it.',
  );
  return lines.join('\n');
}

// --------------------------------------------------------------- evaluate

function loadConfig(project) {
  try {
    return JSON.parse(readFileSync(join(project, '.claude', 'complexity.json'), 'utf8'));
  } catch {
    return {};
  }
}

// Returns { block, reason } for regressions, { missing } when the language's
// analyzer is not installed, or {} when there is nothing to say.
// `baseRef` compares against another commit than HEAD (a task review uses
// the commit the task started from).
export async function evaluate(event, { projectDir, baseRef = 'HEAD' } = {}) {
  const given = event?.tool_input?.file_path;
  if (typeof given !== 'string' || given === '') return {};
  const project = resolve(projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? event.cwd ?? process.cwd());
  const file = resolve(project, given);
  const rel = relative(project, file);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || !existsSync(file)) return {};

  const language = languageOf(file);
  if (!language) return {};
  const config = loadConfig(project);
  if (config.enabled === false) return {};
  const relPosix = rel.split(sep).join('/');
  if ([...DEFAULT_IGNORE, ...(config.ignore ?? [])].some((g) => globToRegex(g).test(relPosix))) return {};

  const threshold = Number.isInteger(config.threshold) ? config.threshold : DEFAULT_THRESHOLD;
  const analyze = (source) => analyzeWith(config, { language, project, file, source });

  const current = await analyze(readFileSync(file, 'utf8'));
  if (current === null) return { missing: language };
  if (!current.some((f) => f.complexity > threshold)) return {};

  const head = headVersion(project, rel, baseRef);
  const baseline = head === null ? [] : await analyze(head);
  const found = regressions(current, baseline, threshold);
  if (found.length === 0) return {};
  return { block: true, found, reason: report({ rel: relPosix, language, threshold, found }) };
}

// Tells Claude about a missing analyzer once per session and language.
function missingNotice(event, language) {
  const marker = join(tmpdir(), `claude-complexity-${String(event.session_id ?? 'none').replace(/\W/g, '')}-${language}`);
  if (existsSync(marker)) return null;
  writeFileSync(marker, '');
  return (
    `Complexity check skipped: no ${language} cognitive-complexity analyzer is installed, so edits are not checked ` +
    `against SonarQube rule S3776. Tell the user they can enable it with: ${INSTALL[language]}, ${COMPOSE_HINT}. ` +
    'Do not install it yourself unless the user asks.'
  );
}

// Container mode: `complexity.mjs --analyze <language> <file name>` reads
// the source on stdin and prints the functions as JSON. Analyzers resolve
// from the folder this script sits in (/opt/analyzers in the image).
async function serveAnalysis(language, name, source) {
  const home = dirname(fileURLToPath(import.meta.url));
  const analyzer = ANALYZERS[language];
  const result = analyzer ? await analyzer({ project: home, file: join(home, basename(name)), source, tools: {} }) : null;
  process.stdout.write(JSON.stringify(result));
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
  if (process.argv[2] === '--analyze') {
    await serveAnalysis(process.argv[3], process.argv[4] ?? 'source', input);
    process.exit(0);
  }
  try {
    const event = JSON.parse(input);
    const result = await evaluate(event);
    if (result.block) {
      process.stderr.write(result.reason);
      process.exit(2);
    }
    const notice = result.missing && missingNotice(event, result.missing);
    if (notice) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: notice },
      }));
    }
  } catch {
    // Never fail an edit because the hook itself failed.
  }
  process.exit(0);
}
