// Shell command tokenizer shared by the hooks that read Bash commands
// (access_guard, atomicity), so they agree on what a command contains.
// Installed next to them as .claude/hooks/lib/shell.mjs.
//
// parseShell(command) -> { commands, unclosed }
//   commands  one array of words per simple command. `;`, `&`, `&&`, `|`,
//             `||`, newlines, `(`, `)`, backticks and `$(` end a command.
//             Quotes are removed, backslashes escape the next character,
//             `#` at a word start begins a comment, heredoc bodies are
//             skipped. Redirections become their own words (`>`, `>>`,
//             `>&`, `<`) and a file descriptor before them (`2>`) is dropped.
//   unclosed  true when a quote is still open at the end, so callers can
//             fail closed.
//
// It is a best-effort reading for guardrails, not a full shell parser.

function readHeredocTag(command, i) {
  const m = /^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z0-9_.-]+))/.exec(command.slice(i));
  return m ? { length: m[0].length, tag: m[2] ?? m[3] ?? m[4], strip: m[1] === '-' } : null;
}

function skipHeredocBody(command, from, heredocs) {
  let i = from;
  for (const { tag, strip } of heredocs) {
    while (i < command.length) {
      let end = command.indexOf('\n', i);
      if (end === -1) end = command.length;
      const line = command.slice(i, end);
      i = Math.min(end + 1, command.length);
      if ((strip ? line.replace(/^\t+/, '') : line) === tag) break;
    }
  }
  return i;
}

export function parseShell(command) {
  const commands = [];
  let words = [];
  let word = '';
  let has = false;
  let unclosed = false;
  const heredocs = [];
  const endWord = () => {
    if (has) words.push(word);
    word = '';
    has = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) unclosed = true;
      const stop = end === -1 ? command.length : end;
      word += command.slice(i + 1, stop);
      has = true;
      i = stop + 1;
    } else if (c === '"') {
      i += 1;
      has = true;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < command.length && '"\\$`\n'.includes(command[i + 1])) i += 1;
        if (!(command[i] === '\n' && command[i - 1] === '\\')) word += command[i];
        i += 1;
      }
      if (i >= command.length) unclosed = true;
      i += 1;
    } else if (c === '\\') {
      if (command[i + 1] === '\n') {
        i += 2;
      } else {
        word += command[i + 1] ?? '';
        has = true;
        i += 2;
      }
    } else if (c === '#' && !has) {
      while (i < command.length && command[i] !== '\n') i += 1;
    } else if (c === '<' && command.startsWith('<<<', i)) {
      endWord();
      i += 3;
    } else if (c === '<' && command[i + 1] === '<') {
      endWord();
      const h = readHeredocTag(command, i);
      if (h) {
        heredocs.push(h);
        i += h.length;
      } else {
        i += 2;
      }
    } else if (c === '\n') {
      endCommand();
      i += 1;
      if (heredocs.length) {
        i = skipHeredocBody(command, i, heredocs);
        heredocs.length = 0;
      }
    } else if (c === ';' || c === '|' || c === '&') {
      if (c === '&' && (command[i - 1] === '>' || command[i - 1] === '<')) {
        word += c;
        has = true;
        i += 1;
        continue;
      }
      endCommand();
      i += command[i + 1] === c || (c === '|' && command[i + 1] === '&') ? 2 : 1;
    } else if (c === '$' && command[i + 1] === '(') {
      endCommand();
      i += 2;
    } else if (c === '(' || c === ')' || c === '`') {
      endCommand();
      i += 1;
    } else if (c === '>' || c === '<') {
      if (/^\d+$/.test(word)) {
        word = '';
        has = false;
      }
      endWord();
      const op = c === '>' && command[i + 1] === '>' ? '>>' : c;
      i += op.length;
      if (c === '>' && command[i] === '&') {
        words.push('>&');
        i += 1;
      } else {
        words.push(op);
      }
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i += 1;
    } else {
      word += c;
      has = true;
      i += 1;
    }
  }
  endCommand();
  return { commands, unclosed };
}

export const tokenize = (command) => parseShell(command).commands;

// Redirection operators parseShell emits as words of their own.
export const REDIRECTS = new Set(['>', '>>', '>&', '<']);
