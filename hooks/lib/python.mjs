// Python stack detection shared by `ai-stones detect` (cli/detect.mjs) and
// the four-d hook, so both agree on a Python project's quality gates.
// Installed next to the hook as .claude/hooks/lib/python.mjs.
//
// detectPython(root) -> null when the root is not a Python project, else
//   { packageManager, text, commands, formatters, linters }
//   packageManager  uv, poetry, pdm, pipenv or pip
//   text            the lowercased manifests, for callers matching frameworks
//   commands        test, lint, typecheck and format, run through the package
//                   manager (`uv run ruff check .`) so they use the project's
//                   environment rather than whatever is on PATH
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (root, file) => {
  try {
    return readFileSync(join(root, file), 'utf8');
  } catch {
    return '';
  }
};

const has = (root, ...files) => files.some((f) => existsSync(join(root, f)));

const MANIFESTS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'];
// Dependency lists and tool configs that name the quality tools.
const SOURCES = ['pyproject.toml', 'setup.cfg', 'tox.ini', 'Pipfile', 'requirements.txt'];
// requirements-dev.txt, requirements_test.txt, dev-requirements.txt, ...
const EXTRA_REQUIREMENTS = /^(?:requirements[-_.][\w.-]+|[\w-]+[-_]requirements)\.txt$/;

const RUNNERS = { uv: 'uv run ', poetry: 'poetry run ', pdm: 'pdm run ', pipenv: 'pipenv run ', pip: '' };

function packageManager(root, pyproject) {
  if (has(root, 'uv.lock') || /^\[tool\.uv[\].]/m.test(pyproject)) return 'uv';
  if (has(root, 'poetry.lock') || /^\[tool\.poetry[\].]/m.test(pyproject)) return 'poetry';
  if (has(root, 'pdm.lock') || /^\[tool\.pdm[\].]/m.test(pyproject)) return 'pdm';
  if (has(root, 'Pipfile', 'Pipfile.lock')) return 'pipenv';
  return 'pip';
}

function manifestText(root) {
  let extra = [];
  try {
    extra = readdirSync(root).filter((f) => EXTRA_REQUIREMENTS.test(f)).sort();
  } catch {
    // unreadable root
  }
  return [...SOURCES, ...extra].map((f) => read(root, f)).join('\n').toLowerCase();
}

export function detectPython(root) {
  if (!has(root, ...MANIFESTS)) return null;
  const pyproject = read(root, 'pyproject.toml');
  const pm = packageManager(root, pyproject);
  const run = RUNNERS[pm];
  const text = manifestText(root);
  const uses = (tool, ...configs) => new RegExp(`\\b${tool}\\b`).test(text) || has(root, ...configs);

  const commands = {};
  const formatters = [];
  const linters = [];
  if (uses('pytest', 'pytest.ini', 'conftest.py', 'tests')) commands.test = `${run}pytest`;
  if (uses('ruff', 'ruff.toml', '.ruff.toml')) {
    linters.push('ruff');
    formatters.push('ruff');
    commands.lint = `${run}ruff check .`;
    commands.format = `${run}ruff format .`;
  } else if (uses('flake8', '.flake8')) {
    linters.push('flake8');
    commands.lint = `${run}flake8 .`;
  }
  if (!formatters.length && uses('black')) {
    formatters.push('black');
    commands.format = `${run}black .`;
  }
  if (uses('mypy', 'mypy.ini', '.mypy.ini')) commands.typecheck = `${run}mypy .`;
  else if (uses('pyright', 'pyrightconfig.json')) commands.typecheck = `${run}pyright`;

  return { packageManager: pm, text, commands, formatters, linters };
}
