import { pathToFileURL } from 'node:url';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const segments = (p) => p.split('/');
const isSecret = (s) =>
  s === '.env' || (s.startsWith('.env.') && s !== '.env.example');
const isPrivate = (s) => s === 'private';

const pathHit = (p) => segments(p).some((s) => isSecret(s) || isPrivate(s));
// Globs can match a secret through a wildcard such as `.env*`.
const globHit = (p) =>
  segments(p).some((s) => s.startsWith('.env') && s !== '.env.example') ||
  segments(p).some(isPrivate);

// Bash expands wildcards itself, so `.env*` must count as a secret too.
const bashHit = (t) =>
  pathHit(t) ||
  segments(t).some((s) => s.startsWith('.env') && /[*?[{]/.test(s));

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

function outsideRoot(path, root, cwd) {
  if (!root || typeof path !== 'string' || !path) return false;
  const target = realpathWithMissingTail(isAbsolute(path) ? path : resolve(cwd, path));
  const realRoot = realpathWithMissingTail(root);
  const rel = relative(realRoot, target);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

const blockOutside = (path) => ({
  block: true,
  reason: `Blocked: ${path} is outside the project root.`,
});

const pathLike = (token) => isAbsolute(token) || /^(?:\.\.?)(?:\/|$)|^~\//.test(token);

function findOutsideToken(command, root, cwd) {
  const { segments } = parse(command);
  for (const tokens of segments) {
    const start = commandIndex(tokens);
    for (const token of tokens.slice(start + 1)) {
      if (pathLike(token) && outsideRoot(token.startsWith('~/') ? resolve(process.env.HOME ?? '', token.slice(2)) : token, root, cwd)) {
        return token;
      }
    }
  }
}

function skipComment(command, i) {
  let next = i;
  while (next + 1 < command.length && command[next + 1] !== '\n') next++;
  return next;
}

function skipHeredocBodies(command, startIndex, heredocs) {
  let i = startIndex;
  for (const { word, strip } of heredocs.splice(0)) {
    while (i + 1 < command.length) {
      const end = command.indexOf('\n', i + 1);
      const lineEnd = end < 0 ? command.length : end;
      const line = command.slice(i + 1, lineEnd);
      i = lineEnd;
      if ((strip ? line.trim() : line) === word) break;
    }
  }
  return i;
}

function processHeredocHeader(command, i, heredocs) {
  const m = /^<<(-?)\s*(['"]?)([\w.-]+)\2/.exec(command.slice(i));
  if (m) {
    heredocs.push({ word: m[3], strip: m[1] === '-' });
    return i + m[0].length - 1;
  }
  return i + 1;
}

function processQuoted(command, i, state) {
  const ch = command[i];
  if (ch === state.quote) {
    state.quote = null;
    return i;
  }
  if (ch === '\\' && state.quote === '"' && i + 1 < command.length) {
    state.token += command[i + 1];
    return i + 1;
  }
  state.token += ch;
  return i;
}

function handleQuoteStart(ch, _command, i, state, _endToken) {
  state.quote = ch;
  return i;
}

function handleBackslash(_ch, command, i, state, endToken) {
  if (command[i + 1] === '\n') endToken();
  else state.token += command[i + 1] ?? '';
  return i + 1;
}

function handleComment(_ch, command, i, _state, _endToken) {
  return skipComment(command, i);
}

function handleHeredoc(_ch, command, i, state, endToken) {
  const nextI = processHeredocHeader(command, i, state.heredocs);
  endToken();
  return nextI;
}

function handleNewline(_ch, command, i, state, endToken) {
  endToken();
  state.segments.push([]);
  return skipHeredocBodies(command, i, state.heredocs);
}

function handleSegmentBreak(_ch, _command, i, state, endToken) {
  endToken();
  state.segments.push([]);
  return i;
}

function handleWhitespace(_ch, _command, i, _state, endToken) {
  endToken();
  return i;
}

function classifyUnquoted(ch, command, i, state) {
  if (ch === '"' || ch === "'") return handleQuoteStart;
  if (ch === '\\') return handleBackslash;
  if (ch === '#' && !state.token) return handleComment;
  if (ch === '<' && /^<<(?!<)/.test(command.slice(i))) return handleHeredoc;
  if (ch === '\n') return handleNewline;
  if (/[;&|()`]/.test(ch)) return handleSegmentBreak;
  if (/[\s<>]/.test(ch)) return handleWhitespace;
  return null;
}

function processUnquoted(command, i, state, endToken) {
  const ch = command[i];
  const handler = classifyUnquoted(ch, command, i, state);
  if (handler) return handler(ch, command, i, state, endToken);
  state.token += ch;
  return i;
}

// Splits a command into segments of tokens. Unquoted shell operators and
// grouping characters end a token; `;`, `&`, `|`, newlines, parentheses and
// backticks also end the segment. Quote characters are removed, backslashes
// escape the next character (outside quotes and inside "..."), `#` starts a
// comment and heredoc bodies are skipped. `unclosed` is true when a quote is
// still open at the end, so the caller can fail closed.
function parse(command) {
  const state = {
    segments: [[]],
    heredocs: [],
    token: '',
    quote: null,
  };

  const endToken = () => {
    if (state.token) state.segments.at(-1).push(state.token.replace(/^\.\//, ''));
    state.token = '';
  };

  for (let i = 0; i < command.length; i++) {
    if (state.quote) {
      i = processQuoted(command, i, state);
    } else {
      i = processUnquoted(command, i, state, endToken);
    }
  }

  endToken();
  return { segments: state.segments, unclosed: state.quote !== null };
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
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
