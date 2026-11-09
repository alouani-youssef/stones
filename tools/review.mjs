// Builds the review package for one task: what the task promised (expected
// behavior, scenarios, scope) next to what was done (commits, files, diff),
// with the checks a reviewer would otherwise do by hand. Each failed check is
// a finding; a task with no findings is ready.
//
// The checks reuse the project's hooks when they are installed next to this
// tool (../hooks/): the testing hook's task-note rules, the atomicity hook's
// change classes, and the complexity hook's analyzers. A missing hook skips
// its check and says so.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks');
const BOOKKEEPING = [/^context\/tasks\//, /^\.claude\/reviews\//];
const DANGER = ['db', 'packages', 'network'];
const STOPWORDS = new Set(['scenario', 'expected', 'should', 'when', 'then', 'with', 'that', 'this', 'from', 'into', 'returns', 'return', 'given', 'there', 'their', 'which', 'without', 'after', 'before', 'about', 'being', 'have', 'does']);

async function hook(name) {
  const file = join(HOOKS, `${name}.mjs`);
  if (!existsSync(file)) return null;
  try {
    return await import(pathToFileURL(file).href);
  } catch {
    return null;
  }
}

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? (r.stdout ?? '').trimEnd() : null;
}

const lines = (text) => (text ? text.split('\n').filter(Boolean) : []);

function section(text, heading) {
  const all = text.split(/\r?\n/);
  const start = all.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return '';
  const end = all.findIndex((l, i) => i > start && /^##\s/.test(l));
  return all.slice(start + 1, end < 0 ? all.length : end).join('\n').replace(/<!--([\s\S]*?)-->/g, '').trim();
}

// `+` lines per file from a unified diff.
export function addedLines(diff) {
  const out = new Map();
  let file = null;
  for (const line of (diff ?? '').split('\n')) {
    const header = /^\+\+\+ (?:b\/)?(.*)$/.exec(line);
    if (header) {
      file = header[1] === '/dev/null' ? null : header[1];
      if (file && !out.has(file)) out.set(file, []);
    } else if (file && line.startsWith('+')) {
      out.get(file).push(line.slice(1));
    }
  }
  return out;
}

const fallbackIsTest = (file) =>
  /(?:^|\/)(?:__tests__|tests?|specs?)\//i.test(file) || /(?:[._-](?:test|spec)\.[^/]+|_test\.go|(?:^|\/)test_[^/]+\.py)$/i.test(file);

export function scenarioKeywords(scenario) {
  return [...new Set(scenario.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? [])].filter((w) => !STOPWORDS.has(w));
}

// A scenario counts as covered when a changed test file's added lines mention
// at least half of its keywords (at least one). A heuristic: it points the
// reviewer at gaps, it does not prove coverage.
export function coverage(scenarios, testAdded) {
  const haystack = testAdded.join('\n').toLowerCase();
  return scenarios.map((scenario) => {
    const words = scenarioKeywords(scenario);
    const hits = words.filter((w) => haystack.includes(w));
    const covered = words.length > 0 && hits.length >= Math.max(1, Math.ceil(words.length / 2));
    return { scenario, covered, hits };
  });
}

export function globMatcher(globs) {
  const res = globs.map((glob) => {
    let out = '';
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === '*' && glob[i + 1] === '*') {
        out += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += glob[i + 2] === '/' ? 2 : 1;
      } else if (c === '*') out += '[^/]*';
      else if (c === '?') out += '[^/]';
      else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${out}$`);
  });
  return (file) => res.some((re) => re.test(file));
}

async function checkTaskNote(task, findings) {
  const testing = await hook('testing');
  if (!testing?.inspectTaskNote) return;
  const status = testing.inspectTaskNote(task.text, task.path);
  if (!status.valid) findings.push(`task note incomplete: ${status.reason}`);
}

function checkTests({ tests, doneLine, head }, findings) {
  if (tests) {
    if (!tests.ok) findings.push(`tests fail: \`${tests.command}\` exited ${tests.status} (see ${tests.log})`);
    return tests.ok ? `passed now: \`${tests.command}\` → ${tests.last}` : `failed now: \`${tests.command}\``;
  }
  if (!doneLine) {
    findings.push('no passing test run recorded: close the task with `tasks done` or review with `--run-tests`');
    return 'not run';
  }
  const recordedHead = /commits [0-9a-f]+\.\.([0-9a-f]+)/.exec(doneLine)?.[1];
  if (recordedHead && head && !head.startsWith(recordedHead)) {
    findings.push(`commits were added after the tests passed (recorded at ${recordedHead}, HEAD is ${head.slice(0, 7)}): rerun with --run-tests`);
  }
  return `recorded: ${doneLine.split(' · ').slice(1).join(' · ')}`;
}

async function checkAtomicity(root, base, findings, notes) {
  const atomicity = await hook('atomicity');
  if (!atomicity?.branchChanges) {
    notes.push('atomicity hook not installed: change classes not checked');
    return new Map();
  }
  const config = atomicity.loadConfig(root);
  const classes = new Map();
  for (const change of atomicity.branchChanges(root, config, base)) classes.set(change.file, atomicity.classify(change, config));
  // `neutral` files (tests, docs) go with any kind of change.
  const kinds = new Set([...classes.values()].filter((k) => k !== 'neutral'));
  const danger = DANGER.filter((k) => kinds.has(k));
  if (danger.length > 1 || (danger.length === 1 && [...kinds].some((k) => !DANGER.includes(k)))) {
    findings.push(`mixes ${[...kinds].sort().join(' + ')} changes: ${danger.join('/')} changes belong on their own branch`);
  }
  return classes;
}

async function checkComplexity(root, base, files, findings, notes) {
  const complexity = await hook('complexity');
  if (!complexity?.evaluate) {
    notes.push('complexity hook not installed: complexity not checked');
    return;
  }
  const missing = new Set();
  for (const file of files) {
    if (!existsSync(join(root, file))) continue;
    const result = await complexity.evaluate({ tool_input: { file_path: file } }, { projectDir: root, baseRef: base });
    if (result.missing) missing.add(result.missing);
    for (const f of result.found ?? []) {
      findings.push(`complexity: ${file} ${f.name} (line ${f.line}) is ${f.complexity}${f.previous === undefined ? ', new' : `, was ${f.previous}`}`);
    }
  }
  if (missing.size) notes.push(`no complexity analyzer for ${[...missing].join(', ')}`);
}

export async function reviewTask(root, task, { tests = null, doneLine } = {}) {
  const findings = [];
  const notes = [];
  const head = git(root, ['rev-parse', 'HEAD']);
  const base = task.base && git(root, ['rev-parse', '--verify', '--quiet', `${task.base}^{commit}`]) ? task.base : null;
  if (!base) findings.push('no base commit recorded: start the task with `tasks start` so its changes can be found');

  await checkTaskNote(task, findings);

  const range = base ? `${base}..HEAD` : null;
  const commits = range ? lines(git(root, ['log', '--oneline', '--no-decorate', range])) : [];
  const files = range ? lines(git(root, ['diff', '--name-only', range])).filter((f) => !BOOKKEEPING.some((re) => re.test(f))) : [];
  const dirty = lines(git(root, ['status', '--porcelain'])).map((l) => l.slice(3)).filter((f) => !BOOKKEEPING.some((re) => re.test(f)));
  if (base && commits.length === 0) findings.push('no commits since the task started');
  if (dirty.length) findings.push(`uncommitted changes are not part of the review: ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}`);

  const testsLine = checkTests({ tests, doneLine, head }, findings);

  const scopeGlobs = task.scope ? task.scope.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (scopeGlobs.length) {
    const inScope = globMatcher(scopeGlobs);
    const outside = files.filter((f) => !inScope(f));
    if (outside.length) findings.push(`changes outside the task's scope (${scopeGlobs.join(', ')}): ${outside.join(', ')}`);
  } else {
    notes.push('no Scope set in the task: scope not checked');
  }

  const testing = await hook('testing');
  const isTest = testing?.isTestOrSpecFile ?? fallbackIsTest;
  const added = range ? addedLines(git(root, ['diff', '-U0', range])) : new Map();
  const testFiles = files.filter((f) => isTest(f));
  const scenarios = section(task.text, 'Scenarios').split('\n').filter((l) => /^\s*[-*]\s+/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, ''));
  const cover = coverage(scenarios, testFiles.flatMap((f) => added.get(f) ?? []));
  const uncovered = cover.filter((c) => !c.covered);
  if (files.length && testFiles.length === 0) findings.push('no test files changed');
  else if (uncovered.length) findings.push(`${uncovered.length} of ${scenarios.length} scenario(s) have no matching test changes`);

  const classes = base ? await checkAtomicity(root, base, findings, notes) : new Map();
  if (base) await checkComplexity(root, base, files, findings, notes);

  const ready = findings.length === 0;
  const md = [
    `# Review: ${task.id} ${task.title}`,
    '',
    `Verdict: **${ready ? 'READY' : 'NOT READY'}**`,
    `Task: ${task.path} · base ${base ? base.slice(0, 7) : '—'} · HEAD ${head ? head.slice(0, 7) : '—'} · branch ${task.branch || '—'}`,
    `Tests: ${testsLine}`,
    '',
    '## Findings',
    '',
    ...(findings.length ? findings.map((f) => `- ${f}`) : ['- none']),
    ...(notes.length ? ['', '## Not checked', '', ...notes.map((n) => `- ${n}`)] : []),
    '',
    '## What the task promised',
    '',
    '### Expected behavior',
    '',
    section(task.text, 'Expected behavior') || '_missing_',
    '',
    '### Scenarios and test coverage',
    '',
    ...(cover.length
      ? cover.map((c) => `- [${c.covered ? 'x' : ' '}] ${c.scenario}${c.hits.length ? ` _(matched: ${c.hits.join(', ')})_` : ''}`)
      : ['_none_']),
    '',
    '### Contract change',
    '',
    section(task.text, 'Contract change') || '_missing_',
    '',
    '## Commits',
    '',
    ...(commits.length ? commits.map((c) => `- ${c}`) : ['_none_']),
    '',
    '## Files changed',
    '',
    ...(files.length
      ? files.map((f) => `- ${f}${DANGER.includes(classes.get(f)) ? ` (${classes.get(f)})` : ''}${isTest(f) ? ' (test)' : ''}`)
      : ['_none_']),
    '',
    '## Diff',
    '',
    '```diff',
    range ? (git(root, ['diff', '-U10', range, '--', ...(files.length ? files : ['.'])]) ?? '') : '',
    '```',
    '',
  ].join('\n');

  return { ready, findings, notes, markdown: md };
}
