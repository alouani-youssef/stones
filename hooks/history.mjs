// Logs every prompt and Claude's reply to a local SQLite database, grouped by session.
//
// Registered on two events:
//   UserPromptSubmit  — `history.mjs prompt`: stores the prompt with its
//                       session id, timestamp and 4D category / risk.
//   Stop              — `history.mjs reply`: reads Claude's last reply from
//                       the session transcript and attaches it to that prompt.
//
// The database lives at `.claude/history.db` in each project and is
// git-ignored by the installer. Tables:
//   sessions(id, project, first_seen, last_seen)
//   exchanges(id, session_id, prompt, reply, category, risk, prompted_at, replied_at)
//
// The hook never blocks or alters a prompt: any failure exits 0 silently.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DB_PATH = '.claude/history.db';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    project    TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS exchanges (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id),
    prompt      TEXT NOT NULL,
    reply       TEXT,
    category    TEXT,
    risk        TEXT,
    prompted_at TEXT NOT NULL,
    replied_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS exchanges_session ON exchanges(session_id, id);
`;

export async function openDb(project) {
  const { DatabaseSync } = await import('node:sqlite');
  const file = join(project, DB_PATH);
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 3000; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

// 4D labels when the four-d hook is installed next to this one; otherwise none.
async function classify(prompt) {
  try {
    const { classifyTask, classifyRisk } = await import(new URL('./four-d.mjs', import.meta.url));
    const { category } = classifyTask(prompt);
    return { category: category ?? null, risk: classifyRisk(prompt, category).level ?? null };
  } catch {
    return { category: null, risk: null };
  }
}

const projectOf = (event, projectDir) =>
  resolve(projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? event.cwd ?? process.cwd());

export async function recordPrompt(event, { projectDir, now = new Date() } = {}) {
  const prompt = typeof event?.prompt === 'string' ? event.prompt : '';
  if (!event?.session_id || !prompt.trim()) return false;
  const project = projectOf(event, projectDir);
  const at = now.toISOString();
  const { category, risk } = await classify(prompt);
  const db = await openDb(project);
  try {
    db.prepare(`INSERT INTO sessions (id, project, first_seen, last_seen) VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`)
      .run(event.session_id, project, at, at);
    db.prepare(`INSERT INTO exchanges (session_id, prompt, category, risk, prompted_at) VALUES (?, ?, ?, ?, ?)`)
      .run(event.session_id, prompt, category, risk, at);
  } finally {
    db.close();
  }
  return true;
}

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((b) => b?.type === 'text' && b.text).map((b) => b.text).join('\n')
      : '';

// A user entry that is a real prompt, not a tool result fed back to Claude.
const isPrompt = (entry) =>
  entry?.type === 'user' &&
  !entry.isMeta &&
  (typeof entry.message?.content === 'string' ||
    (Array.isArray(entry.message?.content) && entry.message.content.some((b) => b?.type === 'text')));

// Claude's text after the last real prompt in a transcript (JSONL).
export function lastReply(transcript) {
  const entries = transcript.split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isPrompt(entries[i])) {
      start = i + 1;
      break;
    }
  }
  return entries.slice(start)
    .filter((e) => e?.type === 'assistant')
    .map((e) => textOf(e.message?.content))
    .filter((t) => t.trim())
    .join('\n\n');
}

export async function recordReply(event, { projectDir, now = new Date() } = {}) {
  if (!event?.session_id) return false;
  let reply = typeof event.last_assistant_message === 'string' ? event.last_assistant_message : '';
  if (!reply && event.transcript_path) {
    try {
      reply = lastReply(readFileSync(event.transcript_path, 'utf8'));
    } catch {
      reply = '';
    }
  }
  if (!reply.trim()) return false;
  const at = now.toISOString();
  const db = await openDb(projectOf(event, projectDir));
  try {
    const row = db.prepare('SELECT id FROM exchanges WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(event.session_id);
    if (!row) return false;
    db.prepare('UPDATE exchanges SET reply = ?, replied_at = ? WHERE id = ?').run(reply, at, row.id);
    db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').run(at, event.session_id);
  } finally {
    db.close();
  }
  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  try {
    const event = JSON.parse(input);
    const mode = process.argv[2] ?? (event.hook_event_name === 'Stop' ? 'reply' : 'prompt');
    await (mode === 'reply' ? recordReply(event) : recordPrompt(event));
  } catch {
    // Logging must never block a prompt or a reply.
  }
  process.exit(0);
}
