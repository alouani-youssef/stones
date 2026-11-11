import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseShell, REDIRECTS } from './lib/shell.mjs';

const segments = (p) => p.split('/');
// Case-insensitive: on macOS and Windows `.ENV` is the same file as `.env`.
const isSecret = (s) => {
  const name = s.toLowerCase();
  return name === '.env' || (name.startsWith('.env.') && name !== '.env.example');
};
const isPrivate = (s) => s === 'private';
const isEnvLike = (s) => s.toLowerCase().startsWith('.env') && s.toLowerCase() !== '.env.example';

const pathHit = (p) => segments(p).some((s) => isSecret(s) || isPrivate(s));
// Globs can match a secret through a wildcard such as `.env*`.
const globHit = (p) =>
  segments(p).some(isEnvLike) ||
  segments(p).some(isPrivate);

// Bash expands wildcards itself, so `.env*` must count as a secret too.
const bashHit = (t) =>
  pathHit(t) ||
  segments(t).some((s) => isEnvLike(s) && /[*?[{]/.test(s));

const PATH_KEYS = ['file_path', 'notebook_path'];
const ROOT_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Grep', 'Glob']);
const CHECKS = {
  Grep: [
    [['path'], pathHit],
    [['glob'], globHit],
  ],
  Glob: [
    [['path'], pathHit],
    [['pattern'], globHit],
  ],
};

const blockPath = (p) => ({
  block: true,
  reason: `Blocked: ${p} is a secret or private file (see CLAUDE.md).`,
});

function realpathWithMissingTail(path) {
  let current = resolve(path);
  const tail = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  try {
    return resolve(realpathSync(current), ...tail);
  } catch {
    return resolve(path);
  }
}

const within = (dir, target) => {
  const rel = relative(dir, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

// Device files and temp dirs are not project files but are not private either:
// `2>/dev/null` and scratch files in /tmp are everyday shell use.
const DEVICES = ['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/zero', '/dev/random', '/dev/urandom'];
const TEMP_DIRS = [...new Set(
  [tmpdir(), process.env.TMPDIR, '/tmp', '/private/tmp', '/var/tmp']
    .filter(Boolean)
    .map((dir) => realpathWithMissingTail(dir)),
)];
const allowedOutside = (target) =>
  DEVICES.includes(target) || target.startsWith('/dev/fd/') || TEMP_DIRS.some((dir) => within(dir, target));

function outsideRoot(path, root, cwd) {
  if (!root || typeof path !== 'string' || !path) return false;
  const raw = isAbsolute(path) ? path : resolve(cwd, path);
  if (allowedOutside(resolve(raw))) return false;
  const target = realpathWithMissingTail(raw);
  if (allowedOutside(target)) return false;
  return !within(realpathWithMissingTail(root), target);
}

const blockOutside = (path) => ({
  block: true,
  reason: `Blocked: ${path} is outside the project root.`,
});

// `~/x`, `$HOME/x` and `${HOME}/x` all point into the home directory.
const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;
const expandHome = (token) => token.replace(HOME_PREFIX, process.env.HOME ?? homedir());
const pathLike = (token) => isAbsolute(token) || /^(?:\.\.?)(?:\/|$)/.test(token) || HOME_PREFIX.test(token);

function findOutsideToken(command, root, cwd) {
  const { segments } = parse(command);
  for (const tokens of segments) {
    const start = commandIndex(tokens);
    for (const token of tokens.slice(start + 1)) {
      if (pathLike(token) && outsideRoot(expandHome(token), root, cwd)) return token;
    }
  }
}

// Segments of tokens from the shared tokenizer, with a leading `./` dropped
// so `./.env` reads as `.env`. Redirection operators are words of their own.
function parse(command) {
  const { commands, unclosed } = parseShell(command);
  const segments = commands.map((words) => words.filter((w) => !REDIRECTS.has(w)).map((w) => w.replace(/^\.\//, '')));
  return { segments, unclosed };
}

const WRAPPERS = ['sudo', 'env', 'time', 'command', 'nice', 'exec', 'xargs'];
// Shell keywords and wrappers that precede the real command word.
const KEYWORDS = [
  'then',
  'do',
  'else',
  'elif',
  'if',
  'while',
  'until',
  '!',
  '{',
];
const SHELLS = ['bash', 'sh', 'zsh'];

// Index of the command word, after grouping, VAR=value and wrapper commands.
function commandIndex(tokens) {
  let i = 0;
  for (; ;) {
    const t = tokens[i];
    if (KEYWORDS.includes(t) || t === 'nohup' || /^\w+=/.test(t ?? '')) i++;
    else if (t === 'timeout') {
      i++;
      while (tokens[i]?.startsWith('-')) {
        i += tokens[i] === '-k' || tokens[i] === '-s' ? 2 : 1;
      }
      i++; // the duration
    } else if (WRAPPERS.includes(t)) {
      i++;
      // wrapper flags; `-n` (nice) and `-u` (env) take a value
      while (tokens[i]?.startsWith('-') || /^\w+=/.test(tokens[i] ?? '')) {
        i += tokens[i] === '-n' || tokens[i] === '-u' ? 2 : 1;
      }
    } else return i;
  }
}

// The command string run by `bash -c "..."`, `sh -c`, `zsh -c` or `eval`.
function nestedCommand(tokens, i) {
  if (SHELLS.includes(tokens[i])) {
    const c = tokens.findIndex((t, j) => j > i && /^-\w*c$/.test(t));
    return c >= 0 ? tokens[c + 1] : undefined;
  }
  if (tokens[i] === 'eval') return tokens.slice(i + 1).join(' ');
}

// Fallback for commands we could not tokenize (an unterminated quote).
const rawTokens = (command) =>
  command.split(/[\s;&|()`'"<>=]+/).map((t) => t.replace(/^\.\//, ''));

function isGitPush(command) {
  const { segments, unclosed } = parse(command);
  if (unclosed && /\bgit\b[^\n;&|]*\bpush\b/.test(command)) return true;
  for (const tokens of segments) {
    let i = commandIndex(tokens);
    const nested = nestedCommand(tokens, i);
    if (nested && isGitPush(nested)) return true;
    if (tokens[i++] !== 'git') continue;
    while (tokens[i]?.startsWith('-')) {
      i += tokens[i] === '-C' || tokens[i] === '-c' ? 2 : 1;
    }
    if (tokens[i] === 'push') return true;
  }
  return false;
}

// Returns the first secret or private token, looking inside nested shells.
function findBlockedToken(command) {
  const { segments, unclosed } = parse(command);
  if (unclosed) {
    const raw = rawTokens(command).find(bashHit);
    if (raw) return raw;
  }
  for (const tokens of segments) {
    const nested = nestedCommand(tokens, commandIndex(tokens));
    const hit = nested && findBlockedToken(nested);
    if (hit) return hit;
    for (const token of tokens) {
      if (bashHit(token) || bashHit(token.slice(token.indexOf('=') + 1))) {
        return token;
      }
    }
  }
}

export function evaluate({ tool_name, tool_input = {}, cwd }, { projectDir } = {}) {
  const root = resolve(projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? cwd ?? process.cwd());
  const workingDirectory = resolve(root, cwd ?? '.');
  if (tool_name === 'Bash') {
    const command = tool_input.command ?? '';
    const outside = findOutsideToken(command, root, workingDirectory);
    if (outside) return blockOutside(outside);
    if (isGitPush(command)) {
      return {
        block: true,
        reason:
          'git push is blocked for Claude in this repo — push it yourself.',
      };
    }
    const hit = findBlockedToken(command);
    if (hit) return blockPath(hit);
    return { block: false };
  }

  if (ROOT_TOOLS.has(tool_name)) {
    for (const key of PATH_KEYS) {
      const value = tool_input[key];
      if (typeof value === 'string' && outsideRoot(value, root, workingDirectory)) return blockOutside(value);
    }
    for (const key of ['path', ...(tool_name === 'Glob' ? ['pattern'] : [])]) {
      const value = tool_input[key];
      if (typeof value === 'string' && outsideRoot(value, root, workingDirectory)) return blockOutside(value);
    }
  }

  const checks = [...(CHECKS[tool_name] ?? []), [PATH_KEYS, pathHit]];
  for (const [keys, hit] of checks) {
    for (const key of keys) {
      const value = tool_input[key];
      if (typeof value === 'string' && hit(value)) return blockPath(value);
    }
  }
  return { block: false };
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
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    process.exit(0);
  }
  const result = evaluate(event ?? {});
  if (result.block) {
    console.error(result.reason);
    process.exit(2);
  }
}
