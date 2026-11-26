#!/usr/bin/env node
// Validates docs/specs with the OpenSpec CLI. OpenSpec only reads an
// `openspec/` folder (the name is fixed in the CLI), so the specs are staged
// into a temporary OpenSpec root and `openspec validate` runs there:
//
//   docs/specs/<capability>/spec.md   ->  openspec/specs/<capability>/spec.md
//   docs/specs/changes/<change>/...   ->  openspec/changes/<change>/...
//
// Paths in OpenSpec's output are mapped back to docs/specs, and its exit code
// is passed through. files.md (code graph summaries) is staged too; OpenSpec
// only reads spec.md.
//
//   node .claude/tools/validate-specs.mjs [item] [--all|--specs|--changes] [--json] [--no-strict]
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { projectRoot } from './git-comments.mjs';

export const SPECS_DIR = 'docs/specs';
export const CHANGES_DIR = `${SPECS_DIR}/changes`;
// The release this tool was checked against; OPENSPEC_BIN overrides it.
export const OPENSPEC_PACKAGE = '@fission-ai/openspec@2.2.0';

const USAGE = `validate-specs: run \`openspec validate\` on docs/specs

Usage
  node .claude/tools/validate-specs.mjs [item] [options]

Options
  --all          Validate every spec and change (default without an item)
  --specs        Validate only the specs
  --changes      Validate only the changes (docs/specs/changes/)
  --json         Print OpenSpec's JSON report
  --no-strict    Drop OpenSpec's strict mode
  -h, --help     Show this help

Uses \`openspec\` from node_modules/.bin or PATH, else \`npx ${OPENSPEC_PACKAGE}\`;
set OPENSPEC_BIN to choose the command.`;

class SpecsError extends Error {}

// The command that runs OpenSpec, as [file, ...args].
export function openspecCommand(root, env = process.env) {
  if (env.OPENSPEC_BIN) return [env.OPENSPEC_BIN];
  const local = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'openspec.cmd' : 'openspec');
  if (existsSync(local)) return [local];
  const onPath = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['openspec'], { encoding: 'utf8' });
  if (onPath.status === 0 && onPath.stdout.trim()) return ['openspec'];
  return ['npx', '--yes', OPENSPEC_PACKAGE];
}

// Copies docs/specs into <stage>/openspec/{specs,changes}.
export function stageSpecs(root, stage) {
  const specs = join(root, SPECS_DIR);
  const changes = join(root, CHANGES_DIR);
  const target = join(stage, 'openspec');
  mkdirSync(join(target, 'specs'), { recursive: true });
  cpSync(specs, join(target, 'specs'), {
    recursive: true,
    filter: (src) => src !== changes && !src.startsWith(`${changes}/`),
  });
  if (existsSync(changes)) cpSync(changes, join(target, 'changes'), { recursive: true });
  else mkdirSync(join(target, 'changes'), { recursive: true });
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// OpenSpec reports paths inside the stage; point them back at docs/specs.
export function mapPaths(text, stages) {
  let out = text;
  for (const stage of stages) {
    out = out.replace(new RegExp(`${escape(stage)}/openspec/changes`, 'g'), CHANGES_DIR);
    out = out.replace(new RegExp(`${escape(stage)}/openspec/specs`, 'g'), SPECS_DIR);
    out = out.replace(new RegExp(`${escape(stage)}/openspec`, 'g'), SPECS_DIR);
  }
  return out
    .replace(/(^|[\s"'`(])openspec\/changes\//gm, `$1${CHANGES_DIR}/`)
    .replace(/(^|[\s"'`(])openspec\/specs\//gm, `$1${SPECS_DIR}/`);
}

export function parseArgs(argv) {
  const opts = { item: undefined, scope: '--all', json: false, strict: true, help: false };
  for (const a of argv) {
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--all' || a === '--specs' || a === '--changes') opts.scope = a;
    else if (a === '--json') opts.json = true;
    else if (a === '--no-strict') opts.strict = false;
    else if (a.startsWith('-')) throw new SpecsError(`unknown option ${a}`);
    else if (opts.item) throw new SpecsError('give at most one item');
    else opts.item = a;
  }
  return opts;
}

export function validateSpecs(root, opts, env = process.env) {
  if (!existsSync(join(root, SPECS_DIR))) return { status: 0, stdout: `No ${SPECS_DIR}/; nothing to validate.\n`, stderr: '' };
  const stage = mkdtempSync(join(tmpdir(), 'stones-openspec-'));
  try {
    stageSpecs(root, stage);
    const [file, ...pre] = openspecCommand(root, env);
    const args = [...pre, 'validate', ...(opts.item ? [opts.item] : [opts.scope]), '--no-interactive'];
    if (opts.strict) args.push('--strict');
    if (opts.json) args.push('--json');
    const r = spawnSync(file, args, {
      cwd: stage,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...env, OPENSPEC_TELEMETRY: '0', OPENSPEC_NO_UPDATE_CHECK: '1', OPENSPEC_NO_ANIMATION: '1', NO_COLOR: '1' },
    });
    if (r.error) throw new SpecsError(`could not run ${[file, ...pre].join(' ')}: ${r.error.message}`);
    const stages = [stage, realpathSync(stage)];
    return { status: r.status ?? 1, stdout: mapPaths(r.stdout ?? '', stages), stderr: mapPaths(r.stderr ?? '', stages) };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export function main(argv, { out = process.stdout, err = process.stderr, cwd = process.cwd(), env = process.env } = {}) {
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      out.write(`${USAGE}\n`);
      return 0;
    }
    const r = validateSpecs(projectRoot(cwd), opts, env);
    out.write(r.stdout);
    err.write(r.stderr);
    return r.status;
  } catch (error) {
    if (!(error instanceof SpecsError)) throw error;
    err.write(`validate-specs: ${error.message}\n`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
