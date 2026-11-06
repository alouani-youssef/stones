#!/usr/bin/env node
// claude-stones: generate a tailored `.claude/` setup, AGENT.md and ROADMAP.md.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { PACKAGE_ROOT } from '../cli/catalog.mjs';
import { detect } from '../cli/detect.mjs';
import { apply, describePlan, loadManifest, plan } from '../cli/install.mjs';
import { createPrompter, createScriptedPrompter } from '../cli/prompt.mjs';
import { interview } from '../cli/questions.mjs';
import { roadmapPrompt, startRoadmapSession } from '../cli/roadmap.mjs';

const HELP = `claude-stones — Claude Code setup tailored to your project

Usage
  npx claude-stones init [dir]      Answer questions, generate AGENT.md and .claude/
  npx claude-stones roadmap [dir]   Start a Claude session that writes ROADMAP.md
  npx claude-stones detect [dir]    Print the detected stack as JSON

Options
  -y, --yes          Accept detected defaults and previous answers, no questions
  --dry-run          Show what init would change, write nothing
  --force            Overwrite files edited since they were installed
  --no-roadmap       Do not offer a roadmap session after init
  --focus <text>     Roadmap focus, e.g. "plan the next milestone"
  --print-prompt     Print the roadmap prompt instead of starting Claude
  -h, --help         Show this help
  -v, --version      Show the version
`;

function parseArgs(argv) {
  const args = { _: [], yes: false, dryRun: false, force: false, roadmap: true, focus: '', printPrompt: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-y' || a === '--yes') args.yes = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force') args.force = true;
    else if (a === '--no-roadmap') args.roadmap = false;
    else if (a === '--print-prompt') args.printPrompt = true;
    else if (a === '--focus') args.focus = argv[++i] ?? '';
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a === '-v' || a === '--version') args.version = true;
    else if (a.startsWith('-')) throw new Error(`Unknown option ${a}`);
    else args._.push(a);
  }
  return args;
}

async function init(target, args) {
  if (!existsSync(target)) throw new Error(`No such directory: ${target}`);
  const stack = detect(target);
  const previous = loadManifest(target).answers ?? {};
  const out = process.stdout;
  const interactive = !args.yes;
  const ask = interactive ? createPrompter() : createScriptedPrompter({}, { output: undefined });

  out.write(`claude-stones: setting up ${target}\n`);
  out.write(`Detected: ${[...stack.languages, ...stack.frameworks].join(', ') || 'no known stack'}`
    + `${stack.packageManagers.length ? ` (${stack.packageManagers.join(', ')})` : ''}\n`);
  if (Object.keys(previous).length) out.write('Using your previous answers as defaults.\n');

  try {
    const answers = await interview(ask, stack, previous);
    const ops = plan({ target, answers, stack, force: args.force });
    const summary = describePlan(ops);
    out.write(`\n${args.dryRun ? 'Would change' : 'Changes'}:\n${summary || '  nothing to change'}\n`);
    if (args.dryRun) return;

    apply({ target, ops, answers, stack });
    const conflicts = ops.filter((o) => o.action === 'conflict');
    out.write(`\nDone. Answers saved to .claude/stones.json; re-run init any time to update.\n`);
    if (conflicts.length) out.write(`${conflicts.length} edited file(s) were left untouched (see "!" above).\n`);

    const hasRoadmap = existsSync(join(target, 'ROADMAP.md')) && readFileSync(join(target, 'ROADMAP.md'), 'utf8').trim();
    if (args.roadmap && interactive && !hasRoadmap && stack.tooling.claude) {
      const start = await ask.confirm('roadmap.start', '\nStart a Claude session now to write ROADMAP.md?', true);
      ask.close();
      if (start) {
        const result = await startRoadmapSession(target);
        if (!result.started) out.write(`${result.message}\n`);
        return;
      }
    }
    out.write(hasRoadmap ? '' : 'Next: run `npx claude-stones roadmap` (or /roadmap in Claude Code) to write ROADMAP.md.\n');
  } finally {
    ask.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) {
    console.log(JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version);
    return;
  }
  const [command = 'init', dir = '.'] = args._;
  if (args.help || command === 'help') {
    console.log(HELP);
    return;
  }
  const target = resolve(dir);
  if (command === 'init') return init(target, args);
  if (command === 'detect') {
    console.log(JSON.stringify(detect(target), null, 2));
    return;
  }
  if (command === 'roadmap') {
    if (args.printPrompt) {
      console.log(roadmapPrompt(target, args.focus));
      return;
    }
    const result = await startRoadmapSession(target, { focus: args.focus });
    if (!result.started) {
      console.error(result.message);
      process.exitCode = 1;
    } else process.exitCode = result.code ?? 0;
    return;
  }
  throw new Error(`Unknown command "${command}". Run with --help.`);
}

main().catch((error) => {
  console.error(`claude-stones: ${error.message}`);
  process.exitCode = 1;
});

