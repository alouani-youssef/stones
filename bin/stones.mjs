#!/usr/bin/env node
// ai-stones: generate a tailored `.claude/` setup, AGENT.md and ROADMAP.md.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { syncDevcontainer } from '../hooks/devcontainer.mjs';

import { PACKAGE_ROOT } from '../cli/catalog.mjs';
import { detect } from '../cli/detect.mjs';
import { apply, describePlan, loadManifest, plan } from '../cli/install.mjs';
import { createPrompter, createScriptedPrompter } from '../cli/prompt.mjs';
import { interview } from '../cli/questions.mjs';
import { roadmapPrompt, startRoadmapSession } from '../cli/roadmap.mjs';

const HELP = `ai-stones — Claude Code setup tailored to your project

Usage
  npx ai-stones init [dir]      Answer questions, generate AGENT.md and .claude/
  npx ai-stones roadmap [dir]   Start a Claude session that writes ROADMAP.md
  npx ai-stones detect [dir]    Print the detected stack as JSON
  npx ai-stones sync [dir]      Regenerate .devcontainer/devcontainer.json from its Dockerfile

Options
  -y, --yes          Accept detected defaults and previous answers, no questions
  --dry-run          Show what init would change, write nothing
  --force            Overwrite files edited since they were installed
  --no-roadmap       Do not offer a roadmap session after init
  --focus <text>     Roadmap focus, e.g. "plan the next milestone"
  --print-prompt     Print the roadmap prompt instead of starting Claude
  --check            With sync: fail if devcontainer.json is out of date, write nothing
  -h, --help         Show this help
  -v, --version      Show the version
`;

function parseArgs(argv) {
  const args = { _: [], yes: false, dryRun: false, force: false, roadmap: true, focus: '', printPrompt: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-y' || a === '--yes') args.yes = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force') args.force = true;
    else if (a === '--no-roadmap') args.roadmap = false;
    else if (a === '--print-prompt') args.printPrompt = true;
    else if (a === '--check') args.check = true;
    else if (a === '--focus') args.focus = argv[++i] ?? '';
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a === '-v' || a === '--version') args.version = true;
    else if (a.startsWith('-')) throw new Error(`Unknown option ${a}`);
    else args._.push(a);
  }
  return args;
}

async function maybeStartRoadmap(target, args, ask, stack, out) {
  const roadmapPath = join(target, 'ROADMAP.md');
  const hasRoadmap = existsSync(roadmapPath) && readFileSync(roadmapPath, 'utf8').trim();
  if (hasRoadmap) return;

  const interactive = !args.yes;
  const shouldOffer = args.roadmap && interactive && stack.tooling.claude;
  if (!shouldOffer) {
    out.write('Next: run `npx ai-stones roadmap` (or /roadmap in Claude Code) to write ROADMAP.md.\n');
    return;
  }

  const start = await ask.confirm('roadmap.start', '\nStart a Claude session now to write ROADMAP.md?', true);
  ask.close();
  if (!start) {
    out.write('Next: run `npx ai-stones roadmap` (or /roadmap in Claude Code) to write ROADMAP.md.\n');
    return;
  }

  const result = await startRoadmapSession(target);
  if (!result.started) out.write(`${result.message}\n`);
}

async function init(target, args) {
  if (!existsSync(target)) throw new Error(`No such directory: ${target}`);
  const stack = detect(target);
  const previous = loadManifest(target).answers ?? {};
  const out = process.stdout;
  const interactive = !args.yes;
  const ask = interactive ? createPrompter() : createScriptedPrompter({}, { output: undefined });

  out.write(`ai-stones: setting up ${target}\n`);
  const detected = [...stack.languages, ...stack.frameworks].join(', ') || 'no known stack';
  const pms = stack.packageManagers.length ? ` (${stack.packageManagers.join(', ')})` : '';
  out.write(`Detected: ${detected}${pms}\n`);
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

    await maybeStartRoadmap(target, args, ask, stack, out);
  } finally {
    ask.close();
  }
}

function handleSync(target, args) {
  const { status } = syncDevcontainer(join(target, '.devcontainer'), { check: args.check, name: basename(target) });
  if (status === 'missing') {
    console.log('no .devcontainer/Dockerfile, nothing to sync');
    return;
  }
  if (status === 'drift') {
    console.error('devcontainer.json is out of date: run `npx ai-stones sync`');
    process.exitCode = 1;
    return;
  }
  console.log(`devcontainer.json ${status}`);
}

async function handleRoadmap(target, args) {
  if (args.printPrompt) {
    console.log(roadmapPrompt(target, args.focus));
    return;
  }
  const result = await startRoadmapSession(target, { focus: args.focus });
  if (!result.started) {
    console.error(result.message);
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.code ?? 0;
}

function handleDetect(target) {
  console.log(JSON.stringify(detect(target), null, 2));
}

// Each command takes the resolved target directory and the parsed args.
const COMMANDS = new Map([
  ['init', init],
  ['detect', handleDetect],
  ['sync', handleSync],
  ['roadmap', handleRoadmap],
]);

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
  const run = COMMANDS.get(command);
  if (!run) throw new Error(`Unknown command "${command}". Run with --help.`);
  return run(resolve(dir), args);
}

main().catch((error) => {
  console.error(`ai-stones: ${error.message}`);
  process.exitCode = 1;
});

