#!/usr/bin/env node
// Lists the project's GitHub Actions workflows and runs them locally with act
// (https://nektosact.com) after confirmation. A passing run is recorded for
// the exact code state (HEAD plus uncommitted changes), and the workflows hook
// requires that record before a merge or a publish.
//
//   node .claude/tools/workflows.mjs list
//   node .claude/tools/workflows.mjs run [--workflow <file>]... [--job <id>] [--event <name>] [--yes]
//   node .claude/tools/workflows.mjs status
//
// `run` never starts containers without confirmation: in a terminal it asks
// y/N; otherwise it prints the plan and exits 3 until called with --yes, so
// Claude must show the plan and ask the user first.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

export const WORKFLOW_DIR = '.github/workflows';
export const RUN_FILE = '.claude/workflows-run.json';
// Used when the project has no .actrc, so act never stops to ask for an image.
const DEFAULT_IMAGE = 'ubuntu-latest=catthehacker/ubuntu:act-latest';
// Events that gate a merge, in order of preference, when no --event is given.
const GATE_EVENTS = ['pull_request', 'push'];

const USAGE = `workflows: list and run GitHub Actions workflows locally with act

Usage
  node .claude/tools/workflows.mjs list              Workflows, jobs and the events that trigger them
  node .claude/tools/workflows.mjs run [options]     Show the plan, confirm, then run it with act
  node .claude/tools/workflows.mjs status            Whether the current code has a passing local run

Run options
  --workflow <file>   Workflow file to run (repeatable). Default: every workflow
                      triggered by pull_request or push
  --job <id>          Run only this job
  --event <name>      Event to simulate (default: pull_request, else push)
  --secret <NAME[=value]>  Secret for the jobs (repeatable); NAME alone takes it from the environment
  --secret-file <file>     Secrets in dotenv format (act reads .secrets by default)
  --yes               Confirmation already given (required when not in a terminal)
  -h, --help          Show this help

Needs act (brew install act, or gh extension install nektos/gh-act) and a running Docker engine.
Merges and publishes are blocked by the workflows hook until a run passes for the current code.`;

export class WorkflowError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

const sh = (cmd, args, cwd, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { ok: r.status === 0 && !r.error, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim(), status: r.status, error: r.error };
};

export function projectRoot(cwd = process.cwd()) {
  const top = sh('git', ['rev-parse', '--show-toplevel'], cwd);
  return top.ok && top.out ? top.out : cwd;
}

export const hasWorkflows = (root) => {
  try {
    return readdirSync(join(root, WORKFLOW_DIR)).some((f) => /\.ya?ml$/.test(f));
  } catch {
    return false;
  }
};

/**
 * The code state a run covers: HEAD plus every uncommitted change, so editing
 * a file after a passing run makes that run stale.
 */
export function fingerprint(root) {
  const head = sh('git', ['rev-parse', 'HEAD'], root);
  if (!head.ok) return null;
  const diff = sh('git', ['diff', 'HEAD', '--binary'], root).out;
  const untracked = sh('git', ['ls-files', '--others', '--exclude-standard', '-z'], root).out
    .split('\0').filter(Boolean).filter((f) => f !== RUN_FILE).sort();
  const hash = createHash('sha256').update(head.out).update('\0').update(diff);
  for (const file of untracked) {
    hash.update('\0').update(file).update('\0');
    try {
      hash.update(readFileSync(join(root, file)));
    } catch {
      // unreadable or vanished: the name alone still counts
    }
  }
  return { head: head.out, state: hash.digest('hex') };
}

/**
 * Parses `act -l`: a table whose header names the columns. Columns are found
 * by the header's offsets because job names contain single spaces.
 */
export function parseActList(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^Stage\s+Job ID\s+Job name/.test(l));
  if (at === -1) return [];
  const header = lines[at];
  const names = ['Stage', 'Job ID', 'Job name', 'Workflow name', 'Workflow file', 'Events'];
  const starts = names.map((n) => header.indexOf(n));
  if (starts.some((s) => s < 0)) return [];
  const cell = (line, i) => line.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : undefined).trim();
  return lines.slice(at + 1).filter((l) => l.trim()).map((l) => ({
    stage: Number(cell(l, 0)),
    job: cell(l, 1),
    name: cell(l, 2),
    workflow: cell(l, 3),
    file: cell(l, 4),
    events: cell(l, 5).split(',').map((e) => e.trim()).filter(Boolean),
  }));
}

function requireAct(root) {
  const act = sh('act', ['--version'], root);
  if (!act.ok) {
    throw new WorkflowError('act is not installed. Install it with `brew install act` (or `gh extension install nektos/gh-act`); see https://nektosact.com/installation/');
  }
  const docker = sh('docker', ['info', '--format', '{{.ServerVersion}}'], root);
  if (!docker.ok) throw new WorkflowError('Docker is not running. act runs each job in a container: start Docker Desktop (or another engine) and retry.');
}

const imageArgs = (root) => (existsSync(join(root, '.actrc')) ? [] : ['-P', DEFAULT_IMAGE]);

export function listJobs(root) {
  requireAct(root);
  const r = sh('act', ['-l', ...imageArgs(root)], root);
  if (!r.ok) throw new WorkflowError(`act -l failed:\n${r.err || r.out}`);
  return parseActList(r.out);
}

export function formatList(jobs) {
  if (!jobs.length) return 'No workflows found in .github/workflows.';
  const byFile = new Map();
  for (const job of jobs) {
    if (!byFile.has(job.file)) byFile.set(job.file, { workflow: job.workflow, events: new Set(), jobs: [] });
    const entry = byFile.get(job.file);
    job.events.forEach((e) => entry.events.add(e));
    entry.jobs.push(job);
  }
  const out = [];
  for (const [file, { workflow, events, jobs: list }] of byFile) {
    out.push(`${file}  (${workflow})  on: ${[...events].join(', ')}`);
    for (const job of list) out.push(`  - ${job.job}  ${job.name}  [stage ${job.stage}]`);
  }
  return out.join('\n');
}

/** Which workflows run, for which event, from the listed jobs and the options. */
export function planRun(jobs, { workflows = [], job, event } = {}) {
  const files = workflows.map((w) => w.replace(/^.*\//, ''));
  const known = new Set(jobs.map((j) => j.file));
  const unknown = files.filter((f) => !known.has(f));
  if (unknown.length) throw new WorkflowError(`Unknown workflow: ${unknown.join(', ')}. Run \`workflows.mjs list\` to see them.`);
  // The merge gate is what runs on a pull request; push-only workflows (often
  // releases that publish) are left out unless no workflow runs on pull requests.
  const triggeredBy = (e) => [...known].filter((f) => jobs.some((j) => j.file === f && j.events.includes(e)));
  const chosen = files.length
    ? files
    : (triggeredBy('pull_request').length ? triggeredBy('pull_request') : triggeredBy('push'));
  if (!chosen.length) throw new WorkflowError('No workflow is triggered by pull_request or push; pass --workflow <file>.');
  const plan = [];
  for (const file of chosen) {
    const inFile = jobs.filter((j) => j.file === file);
    const events = [...new Set(inFile.flatMap((j) => j.events))];
    const ev = event ?? GATE_EVENTS.find((e) => events.includes(e)) ?? events.find((e) => e !== 'workflow_call');
    if (!ev) throw new WorkflowError(`${file} has no event act can trigger; pass --event.`);
    const selected = job ? inFile.filter((j) => j.job === job) : inFile;
    if (job && !selected.length) continue;
    plan.push({ file, event: ev, jobs: selected.map((j) => j.job) });
  }
  if (!plan.length) throw new WorkflowError(`No job "${job}" in ${chosen.join(', ')}.`);
  return plan;
}

export const formatPlan = (plan) =>
  plan.map((p) => `  ${WORKFLOW_DIR}/${p.file}  event=${p.event}  jobs: ${p.jobs.join(', ')}`).join('\n');

export function actArgs(root, step, job, { secrets = [], secretFile } = {}) {
  return [step.event, '-W', `${WORKFLOW_DIR}/${step.file}`, ...(job ? ['-j', job] : []),
    ...secrets.flatMap((s) => ['-s', s]), ...(secretFile ? ['--secret-file', secretFile] : []),
    ...imageArgs(root), '--artifact-server-path', join(root, '.act', 'artifacts')];
}

export function readRun(root) {
  try {
    return JSON.parse(readFileSync(join(root, RUN_FILE), 'utf8'));
  } catch {
    return null;
  }
}

function writeRun(root, record) {
  const file = join(root, RUN_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

/** Whether the current code has a passing local run: { ok, reason }. */
export function runStatus(root) {
  const run = readRun(root);
  if (!run) return { ok: false, reason: 'no local workflow run recorded' };
  if (!run.passed) return { ok: false, reason: `the last local run failed (${run.at})` };
  const now = fingerprint(root);
  if (!now || now.state !== run.state) return { ok: false, reason: `the code changed since the last passing run (${run.at})` };
  return { ok: true, reason: `passed ${run.at}: ${run.workflows.join(', ')}` };
}

async function confirm(plan, yes) {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    throw new WorkflowError(`Plan:\n${formatPlan(plan)}\n\nNot started: confirm this plan with the user, then rerun with --yes.`, 3);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Run these workflows locally with act?\n${formatPlan(plan)}\n[y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export async function runWorkflows(root, options, { spawn = spawnSync } = {}) {
  const jobs = listJobs(root);
  const plan = planRun(jobs, options);
  const gate = planRun(jobs, {}).map((p) => p.file);
  if (!(await confirm(plan, options.yes))) {
    console.log('Cancelled; nothing ran.');
    return 1;
  }
  const before = fingerprint(root);
  const results = [];
  for (const step of plan) {
    console.log(`\n▶ act ${step.event} -W ${WORKFLOW_DIR}/${step.file}${options.job ? ` -j ${options.job}` : ''}`);
    const r = spawn('act', actArgs(root, step, options.job, options), { cwd: root, stdio: 'inherit' });
    results.push({ file: step.file, event: step.event, passed: r.status === 0 });
  }
  const passed = results.every((r) => r.passed);
  // A single job, or a selection that skipped a pull-request workflow, is a partial run: recorded, never a pass.
  const complete = !options.job && gate.every((f) => plan.some((p) => p.file === f));
  writeRun(root, {
    at: new Date().toISOString(),
    head: before?.head,
    state: before?.state,
    passed: passed && complete,
    partial: !complete,
    workflows: results.map((r) => `${r.file}(${r.event}): ${r.passed ? 'passed' : 'failed'}`),
  });
  console.log(`\n${results.map((r) => `${r.passed ? '✔' : '✘'} ${r.file} (${r.event})`).join('\n')}`);
  if (passed && !complete) console.log('Partial run: merges and publishes still need a full `workflows.mjs run`.');
  return passed ? 0 : 1;
}

export function parseArgs(argv) {
  const opts = { workflows: [], secrets: [] };
  const [command, ...rest] = argv;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const value = () => rest[++i] ?? (() => { throw new WorkflowError(`${a} needs a value`); })();
    if (a === '--workflow' || a === '-W') opts.workflows.push(value());
    else if (a === '--job' || a === '-j') opts.job = value();
    else if (a === '--event' || a === '-e') opts.event = value();
    else if (a === '--secret' || a === '-s') opts.secrets.push(value());
    else if (a === '--secret-file') opts.secretFile = value();
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '-h' || a === '--help') return { command: 'help', opts };
    else throw new WorkflowError(`Unknown option ${a}\n\n${USAGE}`);
  }
  return { command: command ?? 'help', opts };
}

export async function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  try {
    const { command, opts } = parseArgs(argv);
    const root = projectRoot(cwd);
    if (command === 'help' || command === '-h' || command === '--help') {
      console.log(USAGE);
      return 0;
    }
    if (!['list', 'run', 'status'].includes(command)) throw new WorkflowError(`Unknown command ${command}\n\n${USAGE}`);
    if (!hasWorkflows(root)) {
      console.log(`No workflows in ${WORKFLOW_DIR}; nothing to run.`);
      return 0;
    }
    if (command === 'status') {
      const s = runStatus(root);
      console.log(s.ok ? `✔ ${s.reason}` : `✘ ${s.reason}`);
      return s.ok ? 0 : 1;
    }
    if (command === 'list') {
      console.log(formatList(listJobs(root)));
      return 0;
    }
    return await runWorkflows(root, opts);
  } catch (error) {
    if (!(error instanceof WorkflowError)) throw error;
    console.error(error.message);
    return error.code;
  }
}

const entryPath = () => {
  try {
    return realpathSync(process.argv[1]);
  } catch {
    return process.argv[1] ?? '';
  }
};

if (import.meta.url === pathToFileURL(entryPath()).href) {
  process.exitCode = await main();
}
