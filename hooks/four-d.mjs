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
//     "rules": { "*": ["..."], "debugging": ["..."] }  // extra Diligence lines
//   }
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

// Verification commands for the project, mirroring cli/detect.mjs but kept
// standalone so the hook works once copied into a project's .claude/hooks.
export function detectCommands(project) {
  const has = (...files) => files.some((f) => existsSync(join(project, f)));
  const read = (file) => {
    try { return readFileSync(join(project, file), 'utf8'); } catch { return ''; }
  };
  const commands = {};
  const pkgText = read('package.json');
  if (pkgText) {
    let scripts = {};
    try { scripts = JSON.parse(pkgText).scripts ?? {}; } catch { /* malformed */ }
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb', 'bun.lock') ? 'bun' : 'npm';
    for (const task of ['test', 'typecheck', 'lint']) {
      const name = [task, `${task}:all`, task === 'typecheck' ? 'type-check' : null].find((n) => n && n in scripts);
      if (name) commands[task] = `${pm} run ${name}`;
    }
    if (!commands.typecheck && has('tsconfig.json')) commands.typecheck = 'npx tsc --noEmit';
  }
  const py = read('pyproject.toml') + read('requirements.txt') + read('setup.cfg');
  if (py || has('setup.py')) {
    if (/\bpytest\b/.test(py) || has('pytest.ini', 'conftest.py', 'tests')) commands.test ??= 'pytest';
    if (/\bruff\b/.test(py)) commands.lint ??= 'ruff check .';
    if (/\bmypy\b/.test(py)) commands.typecheck ??= 'mypy .';
  }
  if (has('go.mod')) {
    commands.test ??= 'go test ./...';
    commands.lint ??= 'go vet ./...';
  }
  if (has('Cargo.toml')) {
    commands.test ??= 'cargo test';
    commands.lint ??= 'cargo clippy';
  }
  const makefile = read('Makefile');
  for (const task of ['test', 'lint', 'typecheck']) {
    if (new RegExp(`^${task}:`, 'm').test(makefile)) commands[task] ??= `make ${task}`;
  }
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

// ------------------------------------------------------- context injector

export function render({ category, secondary, risk, policy }) {
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

  return { category, risk, context: render({ category, secondary, risk, policy }) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  try {
    const { context } = evaluate(JSON.parse(input));
    if (context) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
      }));
    }
  } catch {
    // Never block a prompt because the hook itself failed.
  }
  process.exit(0);
}
