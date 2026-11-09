// PostToolUse hook: keeps .devcontainer/devcontainer.json generated from .devcontainer/Dockerfile.
//
// The Dockerfile is the single source of truth. The last build stage's
// USER, ENV, EXPOSE and WORKDIR become remoteUser, containerEnv,
// forwardPorts and workspaceFolder. Everything else comes from a
// `LABEL devcontainer.metadata='{...}'` (the dev container spec's own label),
// whose fields win over derived ones.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const HEADER = '// Generated from Dockerfile by stones — edit the Dockerfile, not this file.\n';
const METADATA_LABEL = 'devcontainer.metadata';
// Dev container tools read the label from the built image and run lifecycle
// commands from both the label and devcontainer.json, so copying them would
// run each twice. They stay in the label only.
const LIFECYCLE = ['onCreateCommand', 'updateContentCommand', 'postCreateCommand', 'postStartCommand', 'postAttachCommand'];

// Dockerfile instructions, one per entry, with comments dropped and line
// continuations joined.
function instructions(text) {
  const out = [];
  let current = '';
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*#/.test(raw)) continue;
    const continued = /\\\s*$/.test(raw);
    current += `${continued ? raw.replace(/\\\s*$/, '') : raw} `;
    if (continued) continue;
    const line = current.trim();
    current = '';
    if (!line) continue;
    const [, keyword, rest = ''] = /^(\S+)\s*(.*)$/.exec(line);
    out.push({ keyword: keyword.toUpperCase(), rest: rest.trim() });
  }
  if (current.trim()) {
    const [, keyword, rest = ''] = /^(\S+)\s*(.*)$/.exec(current.trim());
    out.push({ keyword: keyword.toUpperCase(), rest: rest.trim() });
  }
  return out;
}

// Shell-like words: quotes group and are removed, backslash escapes outside
// single quotes. Each word also records whether it held a `$` outside single
// quotes (a variable reference).
function words(text) {
  const out = [];
  let word = null;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!quote && /\s/.test(ch)) {
      if (word) out.push(word);
      word = null;
      continue;
    }
    word ??= { value: '', dynamic: false };
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word.value += ch;
    } else if (ch === '\\' && i + 1 < text.length) {
      word.value += text[++i];
    } else if (ch === quote) {
      quote = null;
    } else if (!quote && (ch === '"' || ch === "'")) {
      quote = ch;
    } else {
      if (ch === '$') word.dynamic = true;
      word.value += ch;
    }
  }
  if (word) out.push(word);
  return out;
}

const pairs = (rest) =>
  words(rest)
    .map((w) => {
      const eq = w.value.indexOf('=');
      return eq > 0 ? { key: w.value.slice(0, eq), value: w.value.slice(eq + 1), dynamic: w.dynamic } : null;
    })
    .filter(Boolean);

// What the last build stage of a Dockerfile declares.
export function parseDockerfile(text) {
  const empty = () => ({ from: null, user: null, workdir: null, env: {}, expose: [], metadata: {} });
  let stage = empty();
  for (const { keyword, rest } of instructions(text)) {
    if (keyword === 'FROM') {
      stage = empty();
      stage.from = words(rest).map((w) => w.value).find((w) => !w.startsWith('--')) ?? null;
    } else if (keyword === 'USER') {
      stage.user = rest.split(/\s+/)[0] || null;
    } else if (keyword === 'WORKDIR') {
      stage.workdir = words(rest)[0]?.value ?? null;
    } else if (keyword === 'EXPOSE') {
      for (const w of words(rest)) {
        const port = Number.parseInt(w.value, 10);
        if (Number.isInteger(port)) stage.expose.push(port);
      }
    } else if (keyword === 'ENV') {
      const first = words(rest)[0];
      if (first && !first.value.includes('=')) {
        // Legacy form: `ENV KEY value with spaces`.
        const value = rest.slice(rest.indexOf(first.value) + first.value.length).trim();
        if (!value.includes('$')) stage.env[first.value] = value;
      } else {
        for (const { key, value, dynamic } of pairs(rest)) if (!dynamic) stage.env[key] = value;
      }
    } else if (keyword === 'LABEL') {
      for (const { key, value } of pairs(rest)) {
        if (key !== METADATA_LABEL) continue;
        let meta;
        try {
          meta = JSON.parse(value);
        } catch (error) {
          throw new Error(`${METADATA_LABEL} label is not valid JSON: ${error.message}`);
        }
        for (const entry of Array.isArray(meta) ? meta : [meta]) Object.assign(stage.metadata, entry);
      }
    }
  }
  return stage;
}

// The full devcontainer.json content for a Dockerfile.
export function renderDevcontainer(text, { name }) {
  const p = parseDockerfile(text);
  const config = { name, build: { dockerfile: 'Dockerfile', context: '.' } };
  if (p.user) config.remoteUser = p.user;
  if (Object.keys(p.env).length) config.containerEnv = p.env;
  if (p.expose.length) config.forwardPorts = p.expose;
  if (p.workdir) {
    config.workspaceFolder = p.workdir;
    config.workspaceMount = `source=\${localWorkspaceFolder},target=${p.workdir},type=bind`;
  }
  for (const [key, value] of Object.entries(p.metadata)) if (!LIFECYCLE.includes(key)) config[key] = value;
  return `${HEADER}${JSON.stringify(config, null, 2)}\n`;
}

// Regenerates `<dir>/devcontainer.json` from `<dir>/Dockerfile`. With
// `check`, nothing is written and a stale file reports 'drift'. Throws on a
// malformed metadata label, before anything is written.
export function syncDevcontainer(dir, { check = false, name = basename(dirname(resolve(dir))) } = {}) {
  const dockerfile = join(dir, 'Dockerfile');
  if (!existsSync(dockerfile)) return { status: 'missing' };
  const target = join(dir, 'devcontainer.json');
  const next = renderDevcontainer(readFileSync(dockerfile, 'utf8'), { name });
  const current = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
  if (current === next) return { status: 'same' };
  if (check) return { status: 'drift' };
  writeFileSync(target, next);
  return { status: 'written' };
}

const WATCHED = {
  [join('.devcontainer', 'Dockerfile')]: 'dockerfile',
  [join('.devcontainer', 'devcontainer.json')]: 'json',
};

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  let given;
  try {
    given = JSON.parse(input)?.tool_input?.file_path;
  } catch {
    return 0;
  }
  if (typeof given !== 'string') return 0;
  const project = resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  const kind = WATCHED[relative(project, resolve(project, given))];
  if (!kind) return 0;
  let result;
  try {
    result = syncDevcontainer(join(project, '.devcontainer'), { name: basename(project) });
  } catch (error) {
    process.stderr.write(`.devcontainer/Dockerfile: ${error.message}. devcontainer.json was left unchanged; fix the label.\n`);
    return 2;
  }
  if (kind === 'json' && result.status === 'written') {
    process.stderr.write('devcontainer.json is generated and was regenerated, undoing that edit: edit .devcontainer/Dockerfile instead (use LABEL devcontainer.metadata for settings with no Dockerfile instruction).\n');
    return 2;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(await main());
}
