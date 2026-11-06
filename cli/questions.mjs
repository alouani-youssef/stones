// The setup interview. Defaults come from the previous run's answers first,
// then from stack detection, so re-running `init` is mostly pressing Enter.
import { docCatalog, hookCatalog, mcpCatalog } from './catalog.mjs';

const ARCHITECTURES = [
  { value: 'monolith', label: 'Monolith', hint: 'one deployable application' },
  { value: 'modular-monolith', label: 'Modular monolith', hint: 'one deployable, strict module boundaries' },
  { value: 'microservices', label: 'Microservices', hint: 'several independently deployed services' },
  { value: 'serverless', label: 'Serverless', hint: 'functions and managed services' },
  { value: 'frontend', label: 'Frontend app', hint: 'SPA / SSR app talking to APIs' },
  { value: 'library', label: 'Library / package', hint: 'consumed by other code' },
  { value: 'cli', label: 'CLI / tooling', hint: 'command-line tool or scripts' },
];

const BRANCHING = [
  { value: 'trunk', label: 'Trunk-based', hint: 'short-lived branches merged to the default branch' },
  { value: 'feature', label: 'Feature branches + PRs', hint: 'one branch and PR per change' },
  { value: 'gitflow', label: 'Git flow', hint: 'develop / release / hotfix branches' },
];

const list = (items) => items.join(', ');

const ORMS = ['Prisma', 'Drizzle', 'SQLAlchemy', 'Django', 'Rails'];
const DI_FRAMEWORKS = ['NestJS', 'Angular'];
const API_FRAMEWORKS = ['Next.js', 'Express', 'Fastify', 'Hono', 'NestJS', 'FastAPI', 'Django', 'Flask', 'Rails', 'Remix'];

// Pattern guides worth linking for this stack; the rest stay one keypress away.
export function suggestedPatterns(stack) {
  const uses = (names) => stack.frameworks.some((f) => names.includes(f));
  return [
    'patterns/modularity',
    'patterns/reusability',
    'patterns/complexity',
    uses(ORMS) && 'patterns/repository',
    (uses(DI_FRAMEWORKS) || stack.ecosystems.includes('jvm')) && 'patterns/dependency-injection',
    uses(API_FRAMEWORKS) && 'patterns/summary-details',
  ].filter(Boolean);
}
const split = (text) => (Array.isArray(text) ? text : String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean));

export async function interview(ask, stack, previous = {}) {
  const p = (path, fallback) => path.split('.').reduce((o, k) => o?.[k], previous) ?? fallback;
  const hooks = hookCatalog();
  const docs = docCatalog();
  const mcps = mcpCatalog();

  ask.note('\n— Project');
  const name = await ask.text('project.name', 'Project name', p('project.name', stack.name));
  const description = await ask.text(
    'project.description',
    'What is it, in one or two sentences (who uses it, what problem it solves)',
    p('project.description', stack.description),
  );

  ask.note('\n— Stack and layout');
  const detected = [...stack.languages, ...stack.frameworks].join(', ');
  const technologies = split(await ask.text('stack.technologies', 'Languages and frameworks', p('stack.technologies', [detected]).join(', ')));
  const layout = {};
  for (const dir of stack.directories.slice(0, 12)) {
    layout[dir] = await ask.text(`stack.layout.${dir}`, `  What lives in ${dir}/ (Enter to skip)`, p(`stack.layout.${dir}`, ''));
  }

  ask.note('\n— Architecture and design');
  const architecture = await ask.select('architecture.style', 'Architecture', ARCHITECTURES, p('architecture.style', 'monolith'));
  const architectureNotes = await ask.text(
    'architecture.notes',
    'Main components and how they talk (e.g. "REST API + Postgres + React SPA")',
    p('architecture.notes', ''),
  );
  const patternDocs = docs.filter((d) => d.pattern);
  const patterns = await ask.multi(
    'patterns',
    'Design patterns the code follows (their guides are installed and linked)',
    patternDocs.map((d) => ({ value: d.id, label: d.title, hint: d.lead })),
    p('patterns', suggestedPatterns(stack).filter((id) => patternDocs.some((d) => d.id === id))),
  );

  ask.note('\n— Access and security');
  const secrets = await ask.text('security.secrets', 'Where secrets live (e.g. ".env, never committed", "Vault")', p('security.secrets', '.env files, never committed'));
  const auth = await ask.text('security.auth', 'How users and services authenticate (Enter to skip)', p('security.auth', ''));
  const securityNotes = await ask.text('security.notes', 'Anything Claude must never touch or do (Enter to skip)', p('security.notes', ''));

  ask.note('\n— Conventions and workflow');
  const commits = await ask.select('conventions.commits', 'Commit messages', [
    { value: 'conventional', label: 'Conventional Commits', hint: 'feat: …, fix: …, docs: …' },
    { value: 'free', label: 'Free-form', hint: 'short imperative summary' },
  ], p('conventions.commits', stack.conventionalCommits === false ? 'free' : 'conventional'));
  const branching = await ask.select('workflow.branching', 'Branching', BRANCHING, p('workflow.branching', 'feature'));
  const commands = {};
  for (const task of ['test', 'lint', 'typecheck', 'build']) {
    commands[task] = await ask.text(`workflow.commands.${task}`, `  ${task} command (Enter to skip)`, p(`workflow.commands.${task}`, stack.commands[task] ?? ''));
  }
  const tdd = await ask.confirm('workflow.tdd', 'Work test-first (TDD)?', p('workflow.tdd', true));
  const conventionNotes = await ask.text('conventions.notes', 'Other conventions (Enter to skip)', p('conventions.notes', ''));

  ask.note('\n— Claude Code configuration');
  const missing = (h) => h.requires.filter((tool) => !stack.tooling[tool]);
  const defaultHooks = hooks
    .filter((h) => missing(h).length === 0)
    .filter((h) => h.id !== 'format' || stack.formatters.length > 0)
    .map((h) => h.id);
  const selectedHooks = await ask.multi(
    'install.hooks',
    'Hooks to install',
    hooks.map((h) => ({
      value: h.id,
      label: h.id,
      hint: `${h.hint}${missing(h).length ? ` (needs ${list(missing(h))})` : ''}`,
    })),
    p('install.hooks', defaultHooks),
  );
  const guideDocs = docs.filter((d) => !d.pattern);
  const selectedDocs = await ask.multi(
    'install.docs',
    'Guides to install in .claude/docs (read by Claude on demand, not loaded every session)',
    guideDocs.map((d) => ({ value: d.id, label: d.title, hint: d.lead })),
    p('install.docs', guideDocs.map((d) => d.id)),
  );
  const selectedMcps = mcps.length
    ? await ask.multi(
      'install.mcp',
      'MCP servers for .mcp.json',
      mcps.map((m) => ({ value: m.id, label: m.id, hint: m.hint })),
      p('install.mcp', []),
    )
    : [];
  const sandbox = await ask.confirm('install.sandbox', 'Enable the sandbox (network limited to your package registries)?', p('install.sandbox', true));
  const guardrailNotes = await ask.text('guardrails.notes', 'Extra guardrails for Claude (Enter to skip)', p('guardrails.notes', ''));

  return {
    project: { name, description },
    stack: { technologies, layout },
    architecture: { style: architecture, notes: architectureNotes },
    patterns,
    security: { secrets, auth, notes: securityNotes },
    conventions: { commits, notes: conventionNotes },
    workflow: { branching, commands, tdd },
    guardrails: { notes: guardrailNotes },
    install: { hooks: selectedHooks, docs: selectedDocs, mcp: selectedMcps, sandbox },
  };
}

export const LABELS = {
  architecture: Object.fromEntries(ARCHITECTURES.map((a) => [a.value, a])),
  branching: Object.fromEntries(BRANCHING.map((b) => [b.value, b])),
};
