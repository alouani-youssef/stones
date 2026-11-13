// UserPromptSubmit hook: classifies the prompt with the 4D framework and injects matching engineering guardrails.
//
// The hook is a lightweight policy engine between the developer and the
// agent. It does not run the framework itself; it only tells the agent which
// parts of it apply to this prompt:
//
//   1. Classifier   — task category (debugging, code_generation, ...) and an
//                     independent risk level (low, medium, high, critical).
//   2. Resolver     — picks the Delegation / Description / Discernment /
//                     Diligence rules for that category, adds risk overlays
//                     and flags context the prompt is missing.
//   3. Injector     — returns a compact `additionalContext` payload.
//
// Classification is deterministic (keyword rules): no extra model call, no
// added latency. A prompt that matches no category gets no context at all.
// A prompt hook cannot prove the resulting code works, so Diligence here is
// an expectation the agent is held to, not a verification.
//
// Optional project overrides live in `.claude/four-d.json`:
//   {
//     "enabled": true,
//     "skip": ["explanation"],                 // categories to stay silent on
//     "commands": { "test": "make test" },     // verification commands
//     "rules": { "*": ["..."], "debugging": ["..."] }, // extra Diligence lines
//     "show": true,                            // also display each block to the user
//     "log": true,                             // append each block to .claude/four-d.log
//     "context": {                             // project context (false turns it all off)
//       "tasks": true, "roadmap": true,        //   current/next tasks, ROADMAP.md Now
//       "decisions": 5, "history": 3           //   how many decisions / earlier prompts
//     }
//   }
//
// Project context is read from the files the stones tools write, each
// optional: context/tasks/state/*.md (tasks.mjs), ROADMAP.md (roadmap.mjs,
// /roadmap), context/decisions/*.md, and .claude/history.db (history hook).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ------------------------------------------------------------ classifier

// Each category is scored by how many of its patterns match. Ties go to the
// category listed first, so specific operations win over generic ones
// ("write tests" is testing, not code_generation).
const CATEGORIES = {
  debugging: [
    /\b(bugs?|debug(ging)?|broken|crash(es|ed|ing)?|regression|flaky|segfault|hangs?)\b/,
    /\b(fix(es|ed|ing)?|resolve|troubleshoot)\b/,
    /\b(errors?|exceptions?|stack ?traces?|traceback|panic(ked)?|throws?|thrown)\b/,
    /\b(fail(s|ed|ing|ure)?|not working|doesn'?t work|isn'?t working|stopped working|wrong (result|output|value))\b/,
  ],
  testing: [
    /\b(unit|integration|e2e|end[- ]to[- ]end|regression|snapshot|property[- ]based) tests?\b/,
    /\b(tests?|specs?|test suite|test cases?|coverage|tdd)\b/,
    /\b(jest|vitest|pytest|mocha|playwright|cypress|junit|rspec|node:test)\b/,
    /\b(assert(ions?)?|fixtures?|mocks?|stubs?)\b/,
  ],
  refactoring: [
    /\b(refactor(ing)?|restructure|reorgani[sz]e|clean ?up|tidy)\b/,
    /\b(simplify|deduplicate|dedupe|dry up|decouple|modulari[sz]e)\b/,
    /\b(extract|inline|rename|split|move) (this |the |a |that )?(function|method|class|component|module|file|logic|code|hook|variable)/,
    /\b(technical debt|tech debt|code smell|readability|maintainability)\b/,
  ],
  code_review: [
    /\breview\b/,
    /\b(audit|critique|look over|sanity[- ]check)\b/,
    /\b(pull request|\bpr\b|diff|changes|commit)\b.*\b(look|check|review|ok|good|safe)\b/,
    /\b(feedback on|what'?s wrong with|anything wrong)\b/,
  ],
  architecture: [
    /\b(architect(ure)?|system design|design (a|the|our)? ?(system|service|schema|api|data model))\b/,
    /\b(trade-?offs?|pros and cons|compare|comparison|versus|vs\.?)\b/,
    /\b(should (we|i) (use|go with|choose|pick)|which (library|framework|database|db|approach|pattern))\b/,
    /\b(scalab(le|ility)|data model|adr|microservices?|monolith|event[- ]driven)\b/,
  ],
  operations: [
    /\b(deploy|release|ship|roll ?out|roll ?back|rollback|provision|publish)\b/,
    /\b(drop|truncate|wipe|purge|restore|backfill|seed) (the |a |all )?(\w+ )?(table|database|db|schema|data|records|rows|bucket)s?\b/,
    /\b(run|apply|execute) (the )?(migrations?|terraform|helm|kubectl|script on prod)/,
    /\b(rotate|revoke) (the )?(keys?|secrets?|credentials?|tokens?)\b/,
  ],
  code_generation: [
    /\b(implement|build|create|add|write|generate|scaffold|develop|make)\b/,
    /\b(new )?(feature|endpoint|component|page|route|function|module|cli|command|service|handler|api|script|hook)\b/,
    /\b(support for|integrate|integration with|hook up|wire up)\b/,
  ],
  explanation: [
    /\b(explain|walk me through|help me understand|tell me about|describe)\b/,
    /^(what|how|why|where|when|which|who|does|is|are|can|could)\b/,
    /\b(what (is|are|does)|how (does|do|is|are)|why (does|do|is|are))\b/,
    /\?\s*$/,
  ],
};

// Risk is classified independently of the category, so a task can be
// code_generation + high rather than one mutually exclusive label.
const RISKS = {
  critical: [
    ['production', /\b(prod(uction)?)\b/],
    ['deployment', /\b(deploy(ment|ing)?|release to|roll ?out|rollback)\b/],
    ['destructive data operation', /\b((drop|delete|remove) (the |a |all )?(\w+ )?(tables?|databases?|columns?|schemas?|buckets?|volumes?)|truncate|delete (all|every)|wipe|purge|rm -rf|force[- ]push|reset --hard)\b/],
    ['secrets', /\b(secrets?|credentials?|api[ _-]?keys?|private keys?|\.env\b|passwords? (file|vault))\b/],
    ['infrastructure', /\b(terraform|pulumi|cloudformation|kubernetes|k8s|helm|iam|dns|infrastructure|infra|vpc|firewall)\b/],
  ],
  high: [
    ['authentication', /\b(auth(entication)?|log ?in|sign ?in|sso|oauth|jwt|sessions?|passwords?|mfa|2fa)\b/],
    ['authorization', /\b(authori[sz]ation|permissions?|rbac|acl|roles?|access control)\b/],
    ['payments', /\b(payments?|billing|invoices?|stripe|checkout|refunds?|subscriptions?|charges?)\b/],
    ['migrations', /\b(migrations?|migrate|schema changes?|alter table|backfill)\b/],
    ['tenant isolation', /\b(tenant\w*|multi[- ]tenan(t|cy))\b/],
    ['concurrency', /\b(concurren(t|cy)|race conditions?|deadlocks?|locks?|locking|mutex|transactions?|idempoten(t|cy)|parallel)\b/],
    ['sensitive data', /\b(pii|gdpr|hipaa|encrypt(ion)?|crypto(graphy)?|personal data)\b/],
  ],
  low: [
    ['documentation', /\b(docs?|documentation|readme|changelog|comments?|typos?|docstrings?|jsdoc)\b/],
  ],
};

const LEVELS = ['low', 'medium', 'high', 'critical'];

// Categories that do not change code: domain keywords raise their risk only
// so far, because there is nothing to deploy or migrate.
const READ_ONLY = new Set(['explanation']);

const BASE_RISK = {
  explanation: 'low',
  architecture: 'medium',
  code_review: 'medium',
  code_generation: 'medium',
  debugging: 'medium',
  testing: 'medium',
  refactoring: 'medium',
  operations: 'high',
};

export function classifyTask(prompt) {
  const text = prompt.toLowerCase();
  const scores = Object.entries(CATEGORIES)
    .map(([category, patterns]) => [category, patterns.filter((p) => p.test(text)).length])
    .filter(([, score]) => score > 0);
  if (scores.length === 0) return { category: undefined, secondary: [] };
  const best = Math.max(...scores.map(([, s]) => s));
  const ranked = scores.filter(([, s]) => s === best).map(([c]) => c)
    .concat(scores.filter(([, s]) => s < best).sort((a, b) => b[1] - a[1]).map(([c]) => c));
  return { category: ranked[0], secondary: ranked.slice(1) };
}

export function classifyRisk(prompt, category) {
  const text = prompt.toLowerCase();
  const hits = (level) => RISKS[level].filter(([, p]) => p.test(text)).map(([label]) => label);
  const critical = hits('critical');
  const high = hits('high');
  let level = BASE_RISK[category] ?? 'medium';
  let reasons = [];
  if (critical.length) [level, reasons] = ['critical', critical];
  else if (high.length) [level, reasons] = ['high', high];
  else if (level === 'medium' && hits('low').length) [level, reasons] = ['low', hits('low')];
  if (READ_ONLY.has(category) && LEVELS.indexOf(level) > LEVELS.indexOf('medium')) level = 'medium';
  return { level, reasons, signals: [...critical, ...high] };
}

// ------------------------------------------------- description gap checks

const HAS = {
  evidence: /(```|\b\w*(error|exception)\b\s*:|traceback|stack ?trace|\bat \S+ \(|\bline \d+|exit code|status \d{3}|\b[45]\d\d\b|expected .* (but )?(got|received|was))/i,
  location: /(`[^`]+`|\b[\w./-]+\.[a-z]{1,5}\b|\b(src|lib|app|hooks|cli|tests?|packages)\/|\b(function|class|method|component|module|endpoint|route|table) [`'"]?\w+)/i,
  criteria: /\b(should|must|expect(ed)?|so that|acceptance|criteria|returns?|when .+ then|given .+ then|requirements?|done when)\b/i,
  constraints: /\b(constraints?|must|budget|latency|throughput|scale|users|requests per|team|deadline|compatible|existing|currently)\b/i,
  diffTarget: /(\b(pr|pull request|diff|commit|branch|changes|staged)\b|#\d+|`[^`]+`|\b[\w./-]+\.[a-z]{1,5}\b)/i,
};

const GAPS = {
  debugging: [
    ['evidence', 'no error output, logs, or reproduction steps were given — reproduce the failure first and ask for the exact error if you cannot; do not guess at a fix'],
  ],
  code_generation: [
    ['criteria', 'no acceptance criteria were given — state the interface, assumptions, and how "done" will be checked before writing code; ask if a wrong assumption would be costly'],
    ['location', 'no target files or modules were named — locate where this belongs and follow the existing patterns there'],
  ],
  testing: [
    ['location', 'the code under test was not named — identify the exact behavior and module before writing tests'],
  ],
  refactoring: [
    ['location', 'the refactoring scope was not named — confirm the target files and keep the change bounded to them'],
  ],
  code_review: [
    ['diffTarget', 'no review target was given — default to the current uncommitted diff (git diff) and say so'],
  ],
  architecture: [
    ['constraints', 'no constraints were stated — list the assumed requirements (scale, latency, team, compatibility) before recommending'],
  ],
  explanation: [],
  operations: [
    ['location', 'the target environment or resource was not named — confirm exactly what will be affected before running anything'],
  ],
};

export function findGaps(prompt, category) {
  return (GAPS[category] ?? []).filter(([check]) => !HAS[check].test(prompt)).map(([, text]) => text);
}

// ------------------------------------------------------- policy resolver

const POLICIES = {
  code_generation: {
    delegation: 'Scope the implementation to what was asked; list anything out of scope instead of building it.',
    description: 'Pin down inputs, outputs, interfaces, and constraints before coding.',
    discernment: 'Read the surrounding code first and match its architecture, naming, and error handling; prefer the simplest design that meets the requirements.',
    diligence: 'Add or update tests for the new behavior; run tests, type checks, and lint.',
  },
  debugging: {
    delegation: 'Investigate before changing code: reproduce, then isolate.',
    description: 'Work from the actual error, logs, and reproduction steps.',
    discernment: 'Find and state the root cause with evidence; do not patch the symptom or suppress the error.',
    diligence: 'Add a regression test that fails before the fix and passes after; rerun the related suite.',
  },
  testing: {
    delegation: 'Identify the behavior under test, not the implementation details.',
    description: 'Derive expected outcomes from requirements, not from what the current code happens to return.',
    discernment: 'Cover normal, boundary, and failure cases; avoid tautological tests and over-mocking.',
    diligence: 'Execute the tests and report real results; confirm a new test can fail (break the code or assertion once).',
  },
  refactoring: {
    delegation: 'Define the invariants first: observable behavior and public interfaces must not change.',
    description: 'Establish current behavior (existing tests, or characterization tests) before moving code.',
    discernment: 'Justify the change in design and complexity terms; keep it behavior-preserving and separate from feature work.',
    diligence: 'Run the full relevant regression suite before and after; the diff must contain no functional changes.',
  },
  code_review: {
    delegation: 'Review only the stated scope; do not rewrite the code under review.',
    description: 'Check the diff against its stated requirements and intent.',
    discernment: 'Prioritize correctness, security, and data integrity over style; rank findings by severity.',
    diligence: 'Every finding must cite file:line and a concrete failure scenario; label uncertain findings as such.',
  },
  architecture: {
    delegation: 'Frame the decision to be made; the human owns the final decision.',
    description: 'Make requirements and constraints explicit, and ground them in the existing system.',
    discernment: 'Compare at least two viable alternatives with their trade-offs; recommend one and say why.',
    diligence: 'Name the assumptions the recommendation depends on and how to validate them (spike, benchmark, prototype).',
  },
  operations: {
    delegation: 'The human approves and owns this operation; prepare it, do not execute it unprompted.',
    description: 'Name the exact environment, resources, and blast radius before acting.',
    discernment: 'Check current state first (what exists, what depends on it) and prefer reversible steps.',
    diligence: 'Have a verified backup or rollback path, run a dry run first, and confirm the end state after.',
  },
  explanation: {
    delegation: 'Answer the specific question asked.',
    description: 'Gather the relevant code before answering.',
    discernment: 'Be technically precise; separate what the code does from what you infer.',
    diligence: 'Cite code evidence (file:line); say when something is not verified.',
  },
};

// Overlay lines per risk level. A line with `when` applies only if one of
// those risk signals fired, so an auth task is not told about migrations.
const RISK_OVERLAYS = {
  high: [
    { text: 'Treat security, authorization, tenant isolation, and data integrity as invariants: name the trust boundaries touched.' },
    { text: 'Add negative tests (unauthenticated, unauthorized, invalid input) alongside the happy path.', when: ['authentication', 'authorization', 'payments', 'tenant isolation'] },
    { text: 'Every query must be scoped to the current tenant; test cross-tenant access is denied.', when: ['tenant isolation'] },
    { text: 'Payment operations must be idempotent and amounts exact (no floats); test retries and partial failures.', when: ['payments'] },
    { text: 'Migrations must be reversible and backward compatible with running code; validate them on a copy before applying.', when: ['migrations'] },
    { text: 'Test concurrent access explicitly (parallel requests, retries); state the locking or transaction strategy.', when: ['concurrency'] },
    { text: 'Never log sensitive data; state where it is stored and how it is protected.', when: ['sensitive data'] },
    { text: 'Flag this change for human review in your summary.' },
  ],
  critical: [
    { text: 'Do not run deploy, destructive database, infrastructure-apply, or force-push commands without explicit confirmation from the user in this conversation.' },
    { text: 'Present the plan and a rollback path first; prefer dry runs (terraform plan, --dry-run, transactions you roll back).' },
    { text: 'Never print, log, or commit secret values.', when: ['secrets'] },
  ],
};

export function riskOverlay(risk) {
  // Critical prompts often carry high-risk signals too; apply both tiers.
  const tiers = risk.level === 'critical' ? ['critical', 'high'] : [risk.level];
  const fired = new Set(risk.reasons.concat(risk.signals ?? []));
  return tiers
    .flatMap((tier) => RISK_OVERLAYS[tier] ?? [])
    .filter((line) => !line.when || line.when.some((r) => fired.has(r)))
    .map((line) => line.text);
}

const ALWAYS = 'Report only checks you actually ran, with their results; say explicitly what was not verified.';

const SCRIPT_CANDIDATES = {
  test: ['test', 'test:all'],
  typecheck: ['typecheck', 'typecheck:all', 'type-check'],
  lint: ['lint', 'lint:all'],
};

function readProjectFile(project, file) {
  try {
    return readFileSync(join(project, file), 'utf8');
  } catch {
    return '';
  }
}

function hasProjectFile(project, ...files) {
  return files.some((f) => existsSync(join(project, f)));
}

function detectPackageManager(project) {
  if (hasProjectFile(project, 'pnpm-lock.yaml')) return 'pnpm';
  if (hasProjectFile(project, 'yarn.lock')) return 'yarn';
  if (hasProjectFile(project, 'bun.lockb', 'bun.lock')) return 'bun';
  return 'npm';
}

function detectNodeCommands(project) {
  const pkgText = readProjectFile(project, 'package.json');
  if (!pkgText) return {};

  let scripts = {};
  try {
    scripts = JSON.parse(pkgText).scripts ?? {};
  } catch {
    // malformed package.json
  }

  const pm = detectPackageManager(project);
  const commands = {};
  for (const [task, candidates] of Object.entries(SCRIPT_CANDIDATES)) {
    const name = candidates.find((n) => n in scripts);
    if (name) commands[task] = `${pm} run ${name}`;
  }

  if (!commands.typecheck && hasProjectFile(project, 'tsconfig.json')) {
    commands.typecheck = 'npx tsc --noEmit';
  }
  return commands;
}

function detectPythonCommands(project) {
  const py = readProjectFile(project, 'pyproject.toml') +
    readProjectFile(project, 'requirements.txt') +
    readProjectFile(project, 'setup.cfg');
  if (!py && !hasProjectFile(project, 'setup.py')) return {};

  const commands = {};
  if (/\bpytest\b/.test(py) || hasProjectFile(project, 'pytest.ini', 'conftest.py', 'tests')) {
    commands.test = 'pytest';
  }
  if (/\bruff\b/.test(py)) commands.lint = 'ruff check .';
  if (/\bmypy\b/.test(py)) commands.typecheck = 'mypy .';
  return commands;
}

function detectMakefileCommands(project) {
  const makefile = readProjectFile(project, 'Makefile');
  if (!makefile) return {};

  const commands = {};
  for (const task of ['test', 'lint', 'typecheck']) {
    if (new RegExp(`^${task}:`, 'm').test(makefile)) commands[task] = `make ${task}`;
  }
  return commands;
}

function applyDefaults(target, source) {
  for (const [key, value] of Object.entries(source)) {
    target[key] ??= value;
  }
}

// Verification commands for the project, mirroring cli/detect.mjs but kept
// standalone so the hook works once copied into a project's .claude/hooks.
export function detectCommands(project) {
  const commands = detectNodeCommands(project);

  applyDefaults(commands, detectPythonCommands(project));

  if (hasProjectFile(project, 'go.mod')) {
    commands.test ??= 'go test ./...';
    commands.lint ??= 'go vet ./...';
  }

  if (hasProjectFile(project, 'Cargo.toml')) {
    commands.test ??= 'cargo test';
    commands.lint ??= 'cargo clippy';
  }

  applyDefaults(commands, detectMakefileCommands(project));

  return commands;
}

function loadConfig(project) {
  try {
    return JSON.parse(readFileSync(join(project, '.claude', 'four-d.json'), 'utf8'));
  } catch {
    return {};
  }
}

const CHANGES_CODE = new Set(['code_generation', 'debugging', 'testing', 'refactoring']);

export function resolvePolicy({ category, risk, gaps, commands, extraRules = [] }) {
  const policy = POLICIES[category];
  const verify = Object.values(commands).filter(Boolean);
  const diligence = [policy.diligence];
  if (CHANGES_CODE.has(category) && verify.length) diligence.push(`Verify with: ${verify.join(', ')}.`);
  diligence.push(...extraRules, ALWAYS);
  return {
    delegation: policy.delegation,
    description: [policy.description, ...gaps.map((g) => `Missing: ${g}.`)].join(' '),
    discernment: policy.discernment,
    diligence: diligence.join(' '),
    risk: riskOverlay(risk),
  };
}

// ------------------------------------------------------ project context
//
// Parsers for the formats tools/tasks.mjs and tools/roadmap.mjs write. They
// are duplicated here, not imported, so the hook keeps working on its own.

const readFile = (project, path) => {
  try {
    return readFileSync(join(project, path), 'utf8');
  } catch {
    return '';
  }
};
const oneLine = (text) => text.replace(/\s+/g, ' ').trim();
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

// `- [0001 Title](../list/0001-slug.md) · branch x` lines of a board state file.
function boardTasks(project, state) {
  return readFile(project, `context/tasks/state/${state}.md`).split('\n').flatMap((line) => {
    const m = /^- \[(\d+) (.+?)\]\(\.\.\/list\/([^)]+)\)/.exec(line);
    return m ? [{ id: m[1], title: m[2], file: m[3] }] : [];
  });
}

function taskLines(project) {
  const lines = [];
  const [current] = boardTasks(project, 'current');
  if (current) {
    const text = readFile(project, `context/tasks/list/${current.file}`);
    const scope = /^Scope:[ \t]*(.*)$/m.exec(text)?.[1]?.trim();
    const expected = /^## Expected behavior\s*\n([\s\S]*?)(?=\n## |$)/m.exec(text)?.[1]?.trim() ?? '';
    const behavior = expected && !expected.startsWith('TODO') ? `: ${clip(oneLine(expected), 240)}` : '';
    lines.push(`Task — ${current.id} ${current.title}${scope ? ` (scope: ${scope})` : ''}${behavior}`);
  }
  const next = boardTasks(project, 'next').slice(0, 3);
  if (next.length) {
    const tail = current ? ' Keep this work inside the current task; list follow-ups instead of doing them.' : '';
    lines.push(`Next tasks: ${next.map((t) => `${t.id} ${t.title}`).join('; ')}.${tail}`);
  }
  return lines;
}

function roadmapSections(text) {
  const sections = {};
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) sections[current = h2[1]] = [];
    else if (current) sections[current].push(line);
  }
  return sections;
}

function roadmapLine(sections) {
  const parts = [];
  let milestone = null;
  for (const line of sections.Now ?? []) {
    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h3) {
      if (milestone) break;
      milestone = { name: h3[1], fields: {} };
    }
    const field = milestone && /^\s*[-*]\s+\*\*(.+?):\*\*\s*(.*)$/.exec(line);
    if (field) milestone.fields[field[1].toLowerCase()] = field[2].trim();
  }
  if (milestone) {
    const fields = ['goal', 'done when'].filter((f) => milestone.fields[f]).map((f) => `${f}: ${milestone.fields[f]}`);
    parts.push(`Now: ${milestone.name}${fields.length ? ` — ${fields.join('; ')}` : ''}.`);
  }
  const out = (sections['Out of scope'] ?? [])
    .map((l) => /^\s*[-*]\s+(?:\*\*(.+?)\*\*|(.+))/.exec(l))
    .filter(Boolean)
    .map((m) => (m[1] ?? m[2]).trim());
  if (out.length) parts.push(`Out of scope: ${out.join(', ')}.`);
  return parts.length ? [`Roadmap — ${clip(parts.join(' '), 400)}`] : [];
}

// Oldest first: context/decisions/*.md by file name, then the ROADMAP.md table.
function readDecisions(project, sections) {
  const decisions = [];
  let files = [];
  try {
    files = readdirSync(join(project, 'context', 'decisions')).filter((f) => f.endsWith('.md')).sort();
  } catch { /* no decision records */ }
  for (const file of files) {
    const text = readFile(project, `context/decisions/${file}`);
    const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
    if (!title) continue;
    const summary = text.split(/\n\s*\n/).map((p) => p.trim())
      .find((p) => p && !p.startsWith('#') && !/^[A-Z][\w ]*:\s/.test(p)) ?? '';
    decisions.push({ date: '', decision: title, why: oneLine(summary) });
  }
  for (const line of sections.Decisions ?? []) {
    if (!/^\s*\|.*\|\s*$/.test(line)) continue;
    const [date = '', decision, why = ''] = line.trim().slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
    if (decision === undefined || /^:?-+:?$/.test(date) || date.toLowerCase() === 'date') continue;
    decisions.push({ date, decision, why });
  }
  return decisions;
}

const STOP = new Set(['this', 'that', 'with', 'from', 'when', 'what', 'into', 'have', 'should', 'there', 'their', 'make', 'need', 'please', 'they', 'them', 'then', 'than', 'were', 'will', 'just', 'like', 'some']);
const words = (text) => new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) ?? [])
  .map((w) => w.replace(/s$/, '')).filter((w) => !STOP.has(w)));

// Most relevant to the prompt first, newest first among equals.
export function rankDecisions(decisions, prompt, limit) {
  const asked = words(prompt);
  return decisions
    .map((d, index) => ({ d, index, score: [...words(`${d.decision} ${d.why}`)].filter((w) => asked.has(w)).length }))
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, limit)
    .map(({ d }) => d);
}

function decisionLine(project, sections, prompt, limit) {
  if (!(limit > 0)) return [];
  const chosen = rankDecisions(readDecisions(project, sections), prompt, limit);
  if (!chosen.length) return [];
  const items = chosen.map((d) => clip(`${d.date ? `${d.date} ` : ''}${d.decision}${d.why ? ` (${d.why})` : ''}`, 160));
  return [`Decisions — ${items.join('; ')}. Follow these, and if the work must contradict one, say so and ask first.`];
}

// Recent prompts from other sessions; the current session is already in context.
function historyLine(project, sessionId, limit) {
  if (!(limit > 0) || !existsSync(join(project, '.claude', 'history.db'))) return [];
  let db;
  try {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    db = new DatabaseSync(join(project, '.claude', 'history.db'), { readOnly: true });
    const rows = db.prepare('SELECT prompt, category FROM exchanges WHERE session_id IS NOT ? ORDER BY id DESC LIMIT ?')
      .all(sessionId ?? null, limit);
    if (!rows.length) return [];
    const items = rows.map((r) => `"${clip(oneLine(r.prompt), 120)}"${r.category ? ` (${r.category})` : ''}`);
    return [`History — earlier sessions: ${items.join('; ')}.`];
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

export function projectContext(project, { prompt, sessionId, config = {} }) {
  if (config === false) return [];
  const want = (key, fallback) => config[key] ?? fallback;
  const sections = roadmapSections(readFile(project, 'ROADMAP.md'));
  return [
    ...(want('tasks', true) ? taskLines(project) : []),
    ...(want('roadmap', true) ? roadmapLine(sections) : []),
    ...decisionLine(project, sections, prompt, Number(want('decisions', 5))),
    ...historyLine(project, sessionId, Number(want('history', 3))),
  ];
}

// ------------------------------------------------------- context injector

export function render({ category, secondary, risk, policy, project = [] }) {
  const also = secondary.length ? ` (also: ${secondary.slice(0, 2).join(', ')})` : '';
  const why = risk.reasons.length ? ` (${risk.reasons.join(', ')})` : '';
  const lines = [
    `[4D guardrails] task: ${category}${also} · risk: ${risk.level}${why}`,
    `Delegation — ${policy.delegation}`,
    `Description — ${policy.description}`,
    `Discernment — ${policy.discernment}`,
    `Diligence — ${policy.diligence}`,
  ];
  if (policy.risk.length) lines.push(`Risk (${risk.level}) — ${policy.risk.join(' ')}`);
  lines.push(...project);
  return lines.join('\n');
}

// Returns { context } to inject, or {} to stay silent.
export function evaluate(event, { projectDir } = {}) {
  const prompt = typeof event?.prompt === 'string' ? event.prompt.trim() : '';
  // Slash commands carry their own instructions; very short prompts are
  // conversational ("yes", "go on") and continue an already-guided task.
  if (!prompt || prompt.startsWith('/') || prompt.split(/\s+/).length < 3) return {};

  const project = resolve(projectDir ?? event.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  const config = loadConfig(project);
  if (config.enabled === false) return {};

  const { category, secondary } = classifyTask(prompt);
  if (!category || (config.skip ?? []).includes(category)) return {};

  const risk = classifyRisk(prompt, category);
  const gaps = findGaps(prompt, category);
  const commands = { ...detectCommands(project), ...(config.commands ?? {}) };
  const extraRules = [...(config.rules?.['*'] ?? []), ...(config.rules?.[category] ?? [])];
  const policy = resolvePolicy({ category, risk, gaps, commands, extraRules });
  const context = projectContext(project, { prompt, sessionId: event.session_id, config: config.context ?? {} });

  return { category, risk, config, project, context: render({ category, secondary, risk, policy, project: context }) };
}

export const LOG_PATH = '.claude/four-d.log';

// One plain-text entry per injection, readable with `tail -f .claude/four-d.log`.
export function logInjection(project, { prompt, sessionId, context, now = new Date() }) {
  const file = join(project, LOG_PATH);
  mkdirSync(dirname(file), { recursive: true });
  const session = sessionId ? ` · session ${sessionId}` : '';
  appendFileSync(file, `=== ${now.toISOString()}${session}\nprompt: ${prompt.trim()}\n${context}\n\n`);
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
  try {
    const event = JSON.parse(input);
    const { context, config, project } = evaluate(event);
    if (context) {
      const output = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } };
      if (config.show === true) output.systemMessage = context;
      if (config.log === true) {
        try {
          logInjection(project, { prompt: event.prompt, sessionId: event.session_id, context });
        } catch {
          // A failed log write must not drop the injection.
        }
      }
      process.stdout.write(JSON.stringify(output));
    }
  } catch {
    // Never block a prompt because the hook itself failed.
  }
  process.exit(0);
}
