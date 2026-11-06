import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DB_PATH, lastReply, openDb, recordPrompt, recordReply } from './history.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'history.mjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'history-'));
const jsonl = (...entries) => entries.map((e) => JSON.stringify(e)).join('\n');

async function rows(project, sql = 'SELECT * FROM exchanges ORDER BY id') {
  const db = await openDb(project);
  try {
    return db.prepare(sql).all().map((r) => ({ ...r }));
  } finally {
    db.close();
  }
}

describe('history hook', () => {
  it('stores a prompt with its session and 4D labels', async () => {
    const project = tmp();
    assert.ok(await recordPrompt({ session_id: 's1', prompt: 'fix the failing test in hooks/naming.test.mjs' }, { projectDir: project }));
    const [row] = await rows(project);
    assert.equal(row.session_id, 's1');
    assert.equal(row.prompt, 'fix the failing test in hooks/naming.test.mjs');
    assert.equal(row.category, 'debugging');
    assert.ok(row.risk);
    assert.equal(row.reply, null);
    const [session] = await rows(project, 'SELECT * FROM sessions');
    assert.equal(session.project, project);
  });

  it('attaches the reply to the latest prompt of the same session', async () => {
    const project = tmp();
    await recordPrompt({ session_id: 'a', prompt: 'first' }, { projectDir: project });
    await recordPrompt({ session_id: 'b', prompt: 'other session' }, { projectDir: project });
    await recordPrompt({ session_id: 'a', prompt: 'second' }, { projectDir: project });
    await recordReply({ session_id: 'a', last_assistant_message: 'answer to second' }, { projectDir: project });

    const all = await rows(project);
    assert.deepEqual(all.map((r) => [r.session_id, r.prompt, r.reply]), [
      ['a', 'first', null],
      ['b', 'other session', null],
      ['a', 'second', 'answer to second'],
    ]);
    assert.ok(all[2].replied_at);
  });

  it('reads the reply from the transcript when the event does not carry it', async () => {
    const project = tmp();
    const transcript = join(project, 't.jsonl');
    writeFileSync(transcript, jsonl(
      { type: 'user', message: { role: 'user', content: 'old prompt' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'old reply' }] } },
      { type: 'user', message: { role: 'user', content: 'new prompt' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Read' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'file body' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
    ));
    await recordPrompt({ session_id: 's', prompt: 'new prompt' }, { projectDir: project });
    await recordReply({ session_id: 's', transcript_path: transcript }, { projectDir: project });
    assert.equal((await rows(project))[0].reply, 'Looking.\n\nDone.');
  });

  it('ignores empty prompts and replies without a prompt', async () => {
    const project = tmp();
    assert.equal(await recordPrompt({ session_id: 's', prompt: '  ' }, { projectDir: project }), false);
    assert.equal(await recordReply({ session_id: 's', last_assistant_message: 'hi' }, { projectDir: project }), false);
    assert.equal(lastReply('not json\n'), '');
  });

  it('runs as a hook end to end and always exits 0', () => {
    const project = tmp();
    const env = { ...process.env, CLAUDE_PROJECT_DIR: project };
    const run = (mode, event) =>
      execFileSync('node', ['--no-warnings', HOOK, mode], { input: JSON.stringify(event), env, encoding: 'utf8' });
    assert.equal(run('prompt', { session_id: 'x', prompt: 'hello there friend' }), '');
    run('reply', { session_id: 'x', last_assistant_message: 'hi!' });
    assert.ok(existsSync(join(project, DB_PATH)));
    execFileSync('node', ['--no-warnings', HOOK, 'prompt'], { input: 'garbage', env }); // no throw
  });
});
