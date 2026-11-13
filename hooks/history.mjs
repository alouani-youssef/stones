// Logs every prompt and Claude's reply to a local SQLite database, grouped by session.
//
// Registered on two events:
//   UserPromptSubmit  — `history.mjs prompt`: stores the prompt with its
//                       session id, timestamp and 4D category / risk, both
//                       as typed (naive_prompt) and as Claude receives it
//                       with the four-d guardrails appended (enhanced_prompt).
//   Stop              — `history.mjs reply`: reads Claude's last reply from
//                       the session transcript and attaches it to that prompt.
//
// The database lives at `.claude/history.db` in each project and is
// git-ignored by the installer. Tables:
//   sessions(id, project, first_seen, last_seen)
//   exchanges(id, session_id, prompt, naive_prompt, enhanced_prompt, reply,
//             category, risk, prompted_at, replied_at)
//
// enhanced_prompt equals naive_prompt when four-d injected nothing, and is
// NULL on rows recorded before the column existed.
//
// The hook never blocks or alters a prompt: any failure exits 0 silently.
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
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
    naive_prompt    TEXT,
    enhanced_prompt TEXT,
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
  migrate(db);
  return db;
}

// Databases created before a column existed get it added in place.
function migrate(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(exchanges)').all().map((c) => c.name));
  if (!columns.has('naive_prompt')) {
    db.exec('ALTER TABLE exchanges ADD COLUMN naive_prompt TEXT; UPDATE exchanges SET naive_prompt = prompt;');
  }
  if (!columns.has('enhanced_prompt')) db.exec('ALTER TABLE exchanges ADD COLUMN enhanced_prompt TEXT');
}

// 4D labels and the guardrail block four-d injects for this prompt, when the
// four-d hook is installed next to this one; otherwise none.
async function classify(event, project) {
  try {
    const { classifyTask, classifyRisk, evaluate } = await import(new URL('./four-d.mjs', import.meta.url));
    const { category } = classifyTask(event.prompt);
    const { context } = evaluate(event, { projectDir: project });
    return { category: category ?? null, risk: classifyRisk(event.prompt, category).level ?? null, context };
  } catch {
    return { category: null, risk: null };
  }
}

// What Claude receives: the prompt, then the hook's additionalContext.
export const enhance = (prompt, context) => (context ? `${prompt}\n\n${context}` : prompt);

const projectOf = (event, projectDir) =>
  resolve(projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? event.cwd ?? process.cwd());

export async function recordPrompt(event, { projectDir, now = new Date() } = {}) {
  const prompt = typeof event?.prompt === 'string' ? event.prompt : '';
  if (!event?.session_id || !prompt.trim()) return false;
  const project = projectOf(event, projectDir);
  const at = now.toISOString();
  const { category, risk, context } = await classify(event, project);
  const db = await openDb(project);
  try {
    db.prepare(`INSERT INTO sessions (id, project, first_seen, last_seen) VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`)
      .run(event.session_id, project, at, at);
    db.prepare(`INSERT INTO exchanges (session_id, prompt, naive_prompt, enhanced_prompt, category, risk, prompted_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(event.session_id, prompt, prompt, enhance(prompt, context), category, risk, at);
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
  try {
    const event = JSON.parse(input);
    const mode = process.argv[2] ?? (event.hook_event_name === 'Stop' ? 'reply' : 'prompt');
    await (mode === 'reply' ? recordReply(event) : recordPrompt(event));
  } catch {
    // Logging must never block a prompt or a reply.
  }
  process.exit(0);
}
