#!/usr/bin/env node
// Repository checks that need no dependencies, run by CI (`npm run check`):
//
//   syntax     every tracked .mjs parses (node --check)
//   json       every tracked .json parses
//   license    LICENSE is MIT, names the package author, matches package.json;
//              every vendored plugin ships its own LICENSE and declares it
//   secrets    no tokens or private keys in tracked files
//   paths      no machine-specific absolute paths in shipped files
//
// Exits 1 and lists every finding when any check fails.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const read = (path) => readFileSync(join(root, path), 'utf8');
const findings = [];
const fail = (check, message) => findings.push(`${check}: ${message}`);

function checkSyntax() {
  for (const file of tracked.filter((f) => f.endsWith('.mjs'))) {
    const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) fail('syntax', `${file}\n${result.stderr.trim()}`);
  }
}

function checkJson() {
  for (const file of tracked.filter((f) => f.endsWith('.json'))) {
    try {
      // devcontainer.json is JSON with comments; drop whole-line // comments.
      const text = file.endsWith('devcontainer.json') ? read(file).replace(/^\s*\/\/.*$/gm, '') : read(file);
      JSON.parse(text);
    } catch (error) {
      fail('json', `${file}: ${error.message}`);
    }
  }
}

function checkLicense() {
  const pkg = JSON.parse(read('package.json'));
  if (pkg.license !== 'MIT') fail('license', `package.json license is "${pkg.license}", expected "MIT"`);
  if (!existsSync(join(root, 'LICENSE'))) return fail('license', 'LICENSE is missing');
  const text = read('LICENSE');
  if (!text.startsWith('MIT License')) fail('license', 'LICENSE does not start with "MIT License"');
  const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
  if (!new RegExp(`^Copyright \\(c\\) \\d{4}(-\\d{4})? ${author}$`, 'm').test(text)) {
    fail('license', `LICENSE has no "Copyright (c) <year> ${author}" line`);
  }
  if (!text.includes('THE SOFTWARE IS PROVIDED "AS IS"')) fail('license', 'LICENSE is missing the MIT warranty disclaimer');

  for (const plugin of readdirSync(join(root, 'plugins'))) {
    const dir = `plugins/${plugin}`;
    if (!tracked.includes(`${dir}/LICENSE`)) fail('license', `${dir} has no LICENSE (vendored code must keep its notice)`);
    const manifest = JSON.parse(read(`${dir}/.claude-plugin/plugin.json`));
    if (!manifest.license) fail('license', `${dir}/.claude-plugin/plugin.json declares no license`);
  }
}

const SECRETS = [
  [/npm_[A-Za-z0-9]{36}/, 'npm token'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}/, 'GitHub token'],
  [/github_pat_[A-Za-z0-9_]{60,}/, 'GitHub fine-grained token'],
  [/_authToken=(?!\$\{|<)\S+/, 'registry auth token (use ${NODE_AUTH_TOKEN})'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic API key'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, 'private key'],
];

// Machine-specific paths leak a developer's home or temp folders.
// (/home/<user> is left out: container files legitimately use /home/node.)
const LOCAL_PATH = /(?:\/Users\/[a-z0-9._-]+\/|private\/tmp\/claude-)/i;

// Test fixtures may hold fake secrets on purpose; design notes may quote paths.
const SECRET_EXEMPT = /(\.test\.mjs$|^scripts\/check-repo\.mjs$)/;
const PATH_EXEMPT = /(\.test\.mjs$|^docs\/superpowers\/)/;

function checkSecretsAndPaths() {
  for (const file of tracked) {
    let text;
    try {
      text = read(file);
    } catch {
      continue;
    }
    if (text.includes('\0')) continue; // binary
    text.split('\n').forEach((line, i) => {
      if (!SECRET_EXEMPT.test(file)) {
        for (const [pattern, label] of SECRETS) if (pattern.test(line)) fail('secrets', `${file}:${i + 1} looks like a ${label}`);
      }
      if (!PATH_EXEMPT.test(file) && LOCAL_PATH.test(line)) fail('paths', `${file}:${i + 1} has a machine-specific path`);
    });
  }
}

checkSyntax();
checkJson();
checkLicense();
checkSecretsAndPaths();

if (findings.length) {
  console.error(`${findings.length} problem(s):\n${findings.map((f) => `  - ${f}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`check-repo: ${tracked.length} tracked files OK (syntax, json, license, secrets, paths)`);
}
