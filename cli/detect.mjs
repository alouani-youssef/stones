// Detects a project's stack from the files it already has, so the setup
// questions start with sensible defaults and the generated config only
// contains what the project actually uses.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';

const read = (root, file) => {
  try {
    return readFileSync(join(root, file), 'utf8');
  } catch {
    return '';
  }
};

const readJson = (root, file) => {
  try {
    return JSON.parse(read(root, file));
  } catch {
    return undefined;
  }
};

const has = (root, ...files) => files.some((f) => existsSync(join(root, f)));

export function onPath(name) {
  return (process.env.PATH ?? '')
    .split(delimiter)
    .some((dir) => dir && existsSync(join(dir, name)));
}

function git(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

const NODE_FRAMEWORKS = {
  next: 'Next.js', react: 'React', vue: 'Vue', nuxt: 'Nuxt', svelte: 'Svelte',
  '@sveltejs/kit': 'SvelteKit', '@angular/core': 'Angular', '@nestjs/core': 'NestJS',
  express: 'Express', fastify: 'Fastify', hono: 'Hono', '@remix-run/react': 'Remix',
  astro: 'Astro', electron: 'Electron', 'react-native': 'React Native',
  prisma: 'Prisma', 'drizzle-orm': 'Drizzle', vitest: 'Vitest', jest: 'Jest',
  '@playwright/test': 'Playwright', cypress: 'Cypress', tailwindcss: 'Tailwind CSS',
};

const PY_FRAMEWORKS = {
  django: 'Django', fastapi: 'FastAPI', flask: 'Flask', sqlalchemy: 'SQLAlchemy',
  pydantic: 'Pydantic', pytest: 'pytest', celery: 'Celery',
};

function nodeStack(root, stack) {
  const pkg = readJson(root, 'package.json');
  if (!pkg) return;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  stack.languages.push(has(root, 'tsconfig.json') || deps.typescript ? 'TypeScript' : 'JavaScript');
  stack.name ||= pkg.name;
  stack.description ||= pkg.description ?? '';
  for (const [dep, label] of Object.entries(NODE_FRAMEWORKS)) if (dep in deps) stack.frameworks.push(label);

  const pm = has(root, 'pnpm-lock.yaml') ? 'pnpm'
    : has(root, 'yarn.lock') ? 'yarn'
      : has(root, 'bun.lockb', 'bun.lock') ? 'bun' : 'npm';
  stack.packageManagers.push(pm);
  stack.ecosystems.push('node');

  const scripts = pkg.scripts ?? {};
  for (const task of ['test', 'lint', 'typecheck', 'build', 'format', 'dev']) {
    const name = [task, `${task}:all`, task === 'typecheck' ? 'type-check' : null]
      .find((n) => n && n in scripts);
    if (name) stack.commands[task] ??= `${pm} run ${name}`;
  }
  if (deps.prettier || has(root, '.prettierrc', '.prettierrc.json', 'prettier.config.js', 'prettier.config.mjs')) {
    stack.formatters.push('prettier');
  }
  if (deps.eslint || deps['@biomejs/biome']) stack.linters.push(deps.eslint ? 'eslint' : 'biome');
  if (has(root, 'nx.json')) stack.monorepo = 'nx';
  else if (has(root, 'turbo.json')) stack.monorepo = 'turborepo';
  else if (has(root, 'pnpm-workspace.yaml') || pkg.workspaces) stack.monorepo = 'workspaces';
}

function pythonStack(root, stack) {
  if (!has(root, 'pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile')) return;
  const text = `${read(root, 'pyproject.toml')}\n${read(root, 'requirements.txt')}\n${read(root, 'Pipfile')}`.toLowerCase();
  stack.languages.push('Python');
  stack.ecosystems.push('python');
  stack.name ||= /^\s*name\s*=\s*["']([^"']+)["']/m.exec(read(root, 'pyproject.toml'))?.[1];
  for (const [dep, label] of Object.entries(PY_FRAMEWORKS)) {
    if (new RegExp(`(^|[\\s"'\\[,])${dep}\\b`, 'm').test(text)) stack.frameworks.push(label);
  }
  const pm = has(root, 'uv.lock') ? 'uv' : has(root, 'poetry.lock') ? 'poetry' : 'pip';
  stack.packageManagers.push(pm);
  const run = pm === 'pip' ? '' : `${pm} run `;
  if (/\bpytest\b/.test(text) || has(root, 'tests', 'pytest.ini', 'conftest.py')) stack.commands.test ??= `${run}pytest`;
  if (/\bruff\b/.test(text)) {
    stack.commands.lint ??= `${run}ruff check .`;
    stack.formatters.push('ruff');
  } else if (/\bblack\b/.test(text)) stack.formatters.push('black');
  if (/\bmypy\b/.test(text)) stack.commands.typecheck ??= `${run}mypy .`;
  else if (/\bpyright\b/.test(text)) stack.commands.typecheck ??= `${run}pyright`;
}

function otherStacks(root, stack) {
  if (has(root, 'go.mod')) {
    stack.languages.push('Go');
    stack.ecosystems.push('go');
    stack.packageManagers.push('go modules');
    stack.formatters.push('gofmt');
    stack.name ||= basename(/^module\s+(\S+)/m.exec(read(root, 'go.mod'))?.[1] ?? '');
    stack.commands.test ??= 'go test ./...';
    stack.commands.lint ??= 'go vet ./...';
    stack.commands.build ??= 'go build ./...';
  }
  if (has(root, 'Cargo.toml')) {
    stack.languages.push('Rust');
    stack.ecosystems.push('rust');
    stack.packageManagers.push('cargo');
    stack.name ||= /^\s*name\s*=\s*"([^"]+)"/m.exec(read(root, 'Cargo.toml'))?.[1];
    stack.commands.test ??= 'cargo test';
    stack.commands.lint ??= 'cargo clippy';
    stack.commands.build ??= 'cargo build';
  }
  if (has(root, 'pom.xml')) {
    stack.languages.push('Java');
    stack.ecosystems.push('jvm');
    stack.packageManagers.push('maven');
    stack.commands.test ??= 'mvn test';
    stack.commands.build ??= 'mvn package';
  } else if (has(root, 'build.gradle', 'build.gradle.kts')) {
    stack.languages.push(has(root, 'build.gradle.kts') ? 'Kotlin' : 'Java');
    stack.ecosystems.push('jvm');
    stack.packageManagers.push('gradle');
    stack.commands.test ??= './gradlew test';
    stack.commands.build ??= './gradlew build';
  }
  if (has(root, 'Gemfile')) {
    stack.languages.push('Ruby');
    stack.ecosystems.push('ruby');
    stack.packageManagers.push('bundler');
    if (/\brails\b/.test(read(root, 'Gemfile'))) stack.frameworks.push('Rails');
  }
  if (has(root, 'composer.json')) {
    stack.languages.push('PHP');
    stack.ecosystems.push('php');
    stack.packageManagers.push('composer');
  }
  const makefile = read(root, 'Makefile');
  for (const task of ['test', 'lint', 'build']) {
    if (new RegExp(`^${task}:`, 'm').test(makefile)) stack.commands[task] ??= `make ${task}`;
  }
  if (has(root, 'Dockerfile', 'docker-compose.yml', 'compose.yaml')) stack.tools.push('Docker');
  if (has(root, '.github/workflows')) stack.tools.push('GitHub Actions');
  if (has(root, 'openspec')) stack.tools.push('OpenSpec');
}

const CONVENTIONAL = /^(feat|fix|docs|chore|refactor|test|style|perf|build|ci|revert)(\([^)]*\))?!?:\s/;

function gitFacts(root, stack) {
  const subjects = git(root, ['log', '-30', '--format=%s']).split('\n').filter(Boolean);
  stack.git = subjects.length > 0 || has(root, '.git');
  if (subjects.length >= 3) {
    stack.conventionalCommits = subjects.filter((s) => CONVENTIONAL.test(s)).length / subjects.length >= 0.6;
  }
  stack.defaultBranch = git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim().replace(/^origin\//, '')
    || git(root, ['branch', '--show-current']).trim() || 'main';
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor', 'target', '__pycache__', 'venv']);

export function detect(root) {
  const stack = {
    name: '', description: '', languages: [], frameworks: [], packageManagers: [],
    ecosystems: [], formatters: [], linters: [], tools: [], commands: {},
    monorepo: null, git: false, conventionalCommits: null, defaultBranch: 'main',
    directories: [], tooling: {},
  };
  nodeStack(root, stack);
  pythonStack(root, stack);
  otherStacks(root, stack);
  gitFacts(root, stack);
  stack.name ||= basename(root);
  try {
    stack.directories = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP_DIRS.has(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    // unreadable root
  }
  stack.tooling = { jq: onPath('jq'), claude: onPath('claude'), node: true };
  for (const key of ['languages', 'frameworks', 'packageManagers', 'ecosystems', 'formatters', 'linters', 'tools']) {
    stack[key] = [...new Set(stack[key])];
  }
  return stack;
}
