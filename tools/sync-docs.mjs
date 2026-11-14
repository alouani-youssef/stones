#!/usr/bin/env node
// Finds where the project's Markdown no longer matches the repository, so
// docs are fixed in the same change as the code they describe:
//
//   - relative links to files that do not exist
//   - `npm|pnpm|yarn|bun run <script>` for scripts package.json does not have
//   - AGENT.md commands that differ from .claude/stones.json (re-run init)
//   - CLAUDE.md that no longer imports AGENT.md (fixed with --fix)
//
//   node .claude/tools/sync-docs.mjs [--fix] [--json]
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { git, projectRoot } from './git-comments.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'out', 'target', 'coverage', '.venv', 'venv', '.claude']);

const USAGE = `sync-docs: find docs that no longer match the repository

Usage
  node .claude/tools/sync-docs.mjs [--fix] [--json]

Checks every Markdown file (git-tracked or not ignored; .claude/ excluded) for
relative links to missing files and \`<pm> run <script>\` with no such script,
compares AGENT.md commands with .claude/stones.json, and checks that CLAUDE.md
imports AGENT.md. --fix restores the CLAUDE.md import; the rest needs a person.`;

const readText = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};

function walk(root, dir = root, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(root, join(dir, e.name), out);
    } else if (e.isFile() && e.name.endsWith('.md')) out.push(relative(root, join(dir, e.name)));
  }
  return out;
}

export function markdownFiles(root) {
  const listed = git(root, ['ls-files', '-co', '--exclude-standard', '--', '*.md']);
  const files = listed.ok ? listed.out.split('\n').filter(Boolean) : walk(root);
  return files.filter((f) => !f.split('/').some((part) => SKIP_DIRS.has(part)) && existsSync(join(root, f))).sort();
}

// Lines outside fenced code blocks, with their 1-based numbers.
function proseLines(text) {
  const out = [];
  let fence = null;
  text.split(/\r?\n/).forEach((line, i) => {
    const marker = /^\s*(```+|~~~+)/.exec(line)?.[1];
    if (marker && (!fence || marker[0] === fence[0])) fence = fence ? null : marker;
    else if (!fence) out.push({ line: line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length)), n: i + 1 });
  });
  return out;
}

export function brokenLinks(root, file, text) {
  const problems = [];
  for (const { line, n } of proseLines(text)) {
    for (const m of line.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      const target = m[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) continue;
      const path = decodeURI(target.split(/[?#]/)[0]);
      if (!path) continue;
      const resolved = path.startsWith('/') ? normalize(join(root, path)) : normalize(join(root, dirname(file), path));
      if (!resolved.startsWith(normalize(root))) continue;
      if (!existsSync(resolved)) problems.push({ file, line: n, kind: 'link', message: `link to missing ${relative(root, resolved) || path}` });
    }
  }
  return problems;
}

export function missingScripts(file, text, scripts) {
  if (!scripts) return [];
  const problems = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(/\b(npm|pnpm|yarn|bun)\s+run\s+([\w:.-]+)/g)) {
      if (!(m[2] in scripts)) problems.push({ file, line: i + 1, kind: 'script', message: `\`${m[1]} run ${m[2]}\` but package.json has no "${m[2]}" script` });
    }
  });
  return problems;
}

// AGENT.md lists `- <task>: \`<command>\`` under Commands; init writes them from stones.json.
export function agentDrift(agentText, manifest) {
  const recorded = manifest?.answers?.workflow?.commands;
  if (!agentText || !recorded) return [];
  const documented = Object.fromEntries([...agentText.matchAll(/^- ([\w-]+): `([^`]+)`\s*$/gm)].map((m) => [m[1], m[2]]));
  const problems = [];
  for (const [task, command] of Object.entries(recorded)) {
    if (!command) continue;
    if (!(task in documented)) problems.push({ file: 'AGENT.md', kind: 'agent', message: `does not list the ${task} command \`${command}\`; re-run \`npx ai-stones init\`` });
    else if (documented[task] !== command) problems.push({ file: 'AGENT.md', kind: 'agent', message: `${task} is \`${documented[task]}\` but .claude/stones.json has \`${command}\`; re-run \`npx ai-stones init\`` });
  }
  return problems;
}

export function syncDocs(root, { fix = false } = {}) {
  const scripts = readJson(join(root, 'package.json'))?.scripts;
  const problems = [];
  for (const file of markdownFiles(root)) {
    const text = readText(join(root, file));
    problems.push(...brokenLinks(root, file, text), ...missingScripts(file, text, scripts));
  }
  const manifest = readJson(join(root, '.claude', 'stones.json'));
  const agent = readText(join(root, 'AGENT.md'));
  problems.push(...agentDrift(agent, manifest));
  for (const [task, command] of Object.entries(manifest?.answers?.workflow?.commands ?? {})) {
    for (const p of missingScripts('.claude/stones.json', command ?? '', scripts)) problems.push({ ...p, line: undefined, message: `${task}: ${p.message}` });
  }

  const fixed = [];
  if (agent) {
    const claudeFile = join(root, 'CLAUDE.md');
    const claude = readText(claudeFile);
    if (!/^@AGENT\.md\s*$/m.test(claude)) {
      if (fix) {
        writeFileSync(claudeFile, claude ? `${claude.replace(/\s*$/, '\n')}\n@AGENT.md\n` : '@AGENT.md\n');
        fixed.push(`CLAUDE.md: ${claude ? 'added the @AGENT.md import' : 'created with the @AGENT.md import'}`);
      } else problems.push({ file: 'CLAUDE.md', kind: 'import', message: `${claude ? 'does not import' : 'is missing, so nothing imports'} @AGENT.md and Claude never reads it (--fix adds it)` });
    }
  }
  return { ok: !problems.length, problems, fixed };
}

export function formatResult(result) {
  const lines = [...result.fixed.map((f) => `fixed  ${f}`)];
  for (const p of result.problems) lines.push(`${p.file}${p.line ? `:${p.line}` : ''}  ${p.message}`);
  lines.push(result.ok ? 'Docs match the repository.' : `${result.problems.length} problem(s).`);
  return lines.join('\n');
}

export function main(argv, { log = console.log, cwd = process.cwd() } = {}) {
  if (argv.includes('-h') || argv.includes('--help')) {
    log(USAGE);
    return 0;
  }
  const unknown = argv.find((a) => !['--fix', '--json'].includes(a));
  if (unknown) {
    log(`sync-docs: unknown argument ${unknown}\n\n${USAGE}`);
    return 2;
  }
  const root = projectRoot(cwd);
  if (!statSync(root).isDirectory()) return 2;
  const result = syncDocs(root, { fix: argv.includes('--fix') });
  log(argv.includes('--json') ? JSON.stringify(result, null, 2) : formatResult(result));
  return result.ok ? 0 : 1;
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

if (import.meta.url === pathToFileURL(entryPath()).href) process.exitCode = main(process.argv.slice(2));
