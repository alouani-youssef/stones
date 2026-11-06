import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';

function executable(project, name) {
  const localCandidates = [
    join(project, 'node_modules', '.bin', name),
    join(project, '.venv', 'bin', name),
    join(project, 'venv', 'bin', name),
  ];
  const local = localCandidates.find((candidate) => existsSync(candidate));
  if (local) return local;

  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function run(project, name, args, file) {
  const command = executable(project, name);
  if (command) {
    execFileSync(command, [...args, file], { cwd: project, stdio: 'ignore' });
    return true;
  }
  return false;
}

function formatToon(project, file) {
  const projectRequire = createRequire(resolve(project, 'package.json'));
  const toonEntry = projectRequire.resolve('@toon-format/toon');
  return import(toonEntry).then(({ decode, encode }) => {
    const formatted = encode(decode(readFileSync(file, 'utf8')));
    writeFileSync(file, formatted);
  });
}

// Format supported source and data files when their formatter is available.
// Always exits 0 so formatting failures never fail the edit; only files
// inside the project are touched. No formatter is installed or downloaded.
try {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  const given = JSON.parse(input)?.tool_input?.file_path;
  const project = resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  if (typeof given === 'string') {
    const file = resolve(project, given);
    const rel = relative(project, file);
    const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    if (inside && existsSync(file)) {
      const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();

      if (['js', 'jsx', 'ts', 'tsx', 'json'].includes(ext)) {
        run(project, 'prettier', [
          '--write', '--ignore-unknown', '--log-level=silent',
        ], file);
      } else if (ext === 'py') {
        if (executable(project, 'ruff')) {
          run(project, 'ruff', ['check', '--fix'], file);
          run(project, 'ruff', ['format'], file);
        } else {
          run(project, 'black', ['--quiet'], file);
        }
      } else if (ext === 'go') {
        run(project, 'gofmt', ['-w'], file);
        run(project, 'goimports', ['-w'], file);
      } else if (ext === 'toon') {
        await formatToon(project, file);
      }
    }
  }
} catch {
  // ignore
}
process.exit(0);
