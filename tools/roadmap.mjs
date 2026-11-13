#!/usr/bin/env node
// Reads ROADMAP.md (the structure the /roadmap command writes) so a session
// knows what matters now without reading the whole file, checks it against
// the roadmap rules, and records decisions.
//
//   node .claude/tools/roadmap.mjs show [--json]       outcome, Now milestone, Next, age
//   node .claude/tools/roadmap.mjs check [--max-age <days>]  rule violations; exit 1 if any
//   node .claude/tools/roadmap.mjs decide "<decision>" "<why>"  add a row to Decisions
//
// Changing milestones is a conversation: run /roadmap (or `npx @alouani-youssef/harness-stones roadmap`).
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { projectRoot } from './git-comments.mjs';

export const ROADMAP = 'ROADMAP.md';
const REQUIRED = ['Outcome', 'Now', 'Next', 'Later', 'Out of scope', 'Decisions'];
const DEFAULT_MAX_AGE = 90;

const USAGE = `roadmap: read and check ROADMAP.md

Usage
  node .claude/tools/roadmap.mjs show [--json]                 Outcome, the Now milestone, Next, Later
  node .claude/tools/roadmap.mjs check [--max-age <days>]      Report rule violations (exit 1 if any)
  node .claude/tools/roadmap.mjs decide "<decision>" "<why>"   Record a decision with today's date

To change milestones, run /roadmap in Claude Code or \`npx @alouani-youssef/harness-stones roadmap\`.`;

class RoadmapError extends Error {}
const fail = (message) => {
  throw new RoadmapError(message);
};

// Splits Markdown into `## ` sections; `### ` headings inside a section become milestones.
export function parseRoadmap(text) {
  const sections = {};
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2 && !line.startsWith('###')) {
      current = h2[1];
      sections[current] = [];
    } else if (current) sections[current].push(line);
  }
  const body = (name) => (sections[name] ?? []).join('\n').trim();
  const items = (name) => (sections[name] ?? [])
    .map((l) => /^\s*[-*]\s+(?:\*\*(.+?)\*\*\s*(?:[—–-]\s*)?)?(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ name: (m[1] ?? m[2]).trim(), note: m[1] ? m[2].trim() : '' }));

  const now = [];
  let milestone = null;
  for (const line of sections.Now ?? []) {
    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h3) now.push(milestone = { name: h3[1], fields: {} });
    const field = milestone && /^\s*[-*]\s+\*\*(.+?):\*\*\s*(.*)$/.exec(line);
    if (field) milestone.fields[field[1].toLowerCase()] = field[2].trim();
  }
  // Table rows; a `\|` inside a cell is a literal pipe.
  const decisions = (sections.Decisions ?? [])
    .filter((l) => /^\s*\|.*\|\s*$/.test(l))
    .map((l) => l.trim().slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|')))
    .filter(([date = '', decision]) => decision !== undefined && !/^:?-+:?$/.test(date) && date.toLowerCase() !== 'date')
    .map(([date, decision, why = '']) => ({ date, decision, why }));

  return {
    revised: /_Last revised:\s*(\d{4}-\d{2}-\d{2})_/.exec(text)?.[1] ?? null,
    sections: Object.keys(sections),
    outcome: body('Outcome'),
    now,
    next: items('Next'),
    later: items('Later'),
    outOfScope: items('Out of scope'),
    decisions,
  };
}

const daysSince = (date, today) => Math.floor((Date.parse(today) - Date.parse(date)) / 86_400_000);
const today = () => new Date().toISOString().slice(0, 10);

export function checkRoadmap(roadmap, { maxAge = DEFAULT_MAX_AGE, on = today() } = {}) {
  if (!roadmap.sections.length && !roadmap.revised) return ['ROADMAP.md is empty or has no "## " sections; run /roadmap to write it'];
  const problems = [];
  for (const name of REQUIRED) if (!roadmap.sections.includes(name)) problems.push(`missing section "## ${name}"`);
  if (!roadmap.revised) problems.push('missing "_Last revised: YYYY-MM-DD_" line');
  else if (daysSince(roadmap.revised, on) > maxAge) problems.push(`last revised ${daysSince(roadmap.revised, on)} days ago (more than ${maxAge}); run /roadmap to review progress`);
  if (roadmap.now.length !== 1) problems.push(`"Now" must have exactly one milestone, found ${roadmap.now.length}`);
  for (const m of roadmap.now) {
    for (const field of ['goal', 'scope', 'done when']) if (!m.fields[field]) problems.push(`Now milestone "${m.name}" has no **${field[0].toUpperCase()}${field.slice(1)}:**`);
  }
  if (roadmap.sections.includes('Next') && (roadmap.next.length < 2 || roadmap.next.length > 4)) problems.push(`"Next" should list 2 to 4 milestones, found ${roadmap.next.length}`);
  if (!roadmap.outcome && roadmap.sections.includes('Outcome')) problems.push('"Outcome" is empty');
  return problems;
}

export function formatRoadmap(r, on = today()) {
  const lines = [];
  lines.push(`ROADMAP.md${r.revised ? `, revised ${r.revised} (${daysSince(r.revised, on)} days ago)` : ''}`);
  if (r.outcome) lines.push('', `Outcome: ${r.outcome.replace(/\s+/g, ' ')}`);
  for (const m of r.now) {
    lines.push('', `Now: ${m.name}`);
    for (const [k, v] of Object.entries(m.fields)) lines.push(`  ${k}: ${v}`);
  }
  if (!r.now.length) lines.push('', 'Now: (no milestone)');
  if (r.next.length) lines.push('', 'Next:', ...r.next.map((n) => `  - ${n.name}${n.note ? ` — ${n.note}` : ''}`));
  if (r.later.length) lines.push('', `Later: ${r.later.map((n) => n.name).join(', ')}`);
  if (r.decisions.length) lines.push('', `Decisions: ${r.decisions.length}, latest ${r.decisions.at(-1).date}: ${r.decisions.at(-1).decision}`);
  return lines.join('\n');
}

const cell = (s) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export function addDecision(text, decision, why, date = today()) {
  if (!decision?.trim() || !why?.trim()) fail('usage: roadmap decide "<decision>" "<why>"');
  const row = `| ${date} | ${cell(decision)} | ${cell(why)} |`;
  const lines = text.replace(/\s+$/, '').split('\n');
  const start = lines.findIndex((l) => /^##\s+Decisions\s*$/.test(l));
  if (start === -1) return `${lines.join('\n')}\n\n## Decisions\n\n| Date | Decision | Why |\n| ---- | -------- | --- |\n${row}\n`;
  let end = start + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) end++;
  let lastRow = -1;
  for (let i = start + 1; i < end; i++) if (/^\|/.test(lines[i])) lastRow = i;
  if (lastRow === -1) lines.splice(start + 1, 0, '', '| Date | Decision | Why |', '| ---- | -------- | --- |', row);
  else lines.splice(lastRow + 1, 0, row);
  return `${lines.join('\n')}\n`;
}

export function main(argv, { log = console.log, cwd = process.cwd() } = {}) {
  const json = argv.includes('--json');
  let maxAge = DEFAULT_MAX_AGE;
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') continue;
    if (a === '--max-age') {
      maxAge = Number(argv[++i]);
      if (!Number.isInteger(maxAge) || maxAge < 0) fail('--max-age needs a number of days');
    } else if (a === '-h' || a === '--help') {
      log(USAGE);
      return 0;
    } else args.push(a);
  }
  const [command = 'show', ...rest] = args;
  const file = join(projectRoot(cwd), ROADMAP);
  if (!existsSync(file)) fail('no ROADMAP.md yet; run /roadmap in Claude Code or `npx @alouani-youssef/harness-stones roadmap`');
  const text = readFileSync(file, 'utf8');
  switch (command) {
    case 'show': {
      const roadmap = parseRoadmap(text);
      log(json ? JSON.stringify(roadmap, null, 2) : formatRoadmap(roadmap));
      return 0;
    }
    case 'check': {
      const problems = checkRoadmap(parseRoadmap(text), { maxAge });
      log(json ? JSON.stringify({ ok: !problems.length, problems }, null, 2) : problems.length ? problems.map((p) => `- ${p}`).join('\n') : 'ROADMAP.md follows the roadmap rules.');
      return problems.length ? 1 : 0;
    }
    case 'decide': {
      writeFileSync(file, addDecision(text, rest[0], rest[1]));
      log(`recorded decision in ${ROADMAP}`);
      return 0;
    }
    default:
      log(`roadmap: unknown command ${command}\n\n${USAGE}`);
      return 2;
  }
}

export function run(argv, options) {
  try {
    return main(argv, options);
  } catch (error) {
    if (!(error instanceof RoadmapError)) throw error;
    (options?.error ?? console.error)(`roadmap: ${error.message}`);
    return 2;
  }
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

if (import.meta.url === pathToFileURL(entryPath()).href) process.exitCode = run(process.argv.slice(2));
