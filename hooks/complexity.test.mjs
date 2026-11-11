import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluate, jsFunction, languageOf, pythonLine, regressions, report } from './complexity.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'complexity.mjs');

// End-to-end tests need real analyzers. Point COMPLEXITY_TOOLS at a folder
// with js/node_modules (eslint, eslint-plugin-sonarjs, typescript-eslint),
// py/bin/complexipy and go/gocognit; they are skipped otherwise.
const TOOLS = process.env.COMPLEXITY_TOOLS;
const tool = {
  js: TOOLS && join(TOOLS, 'js', 'node_modules'),
  py: TOOLS && join(TOOLS, 'py', 'bin', 'complexipy'),
  go: TOOLS && join(TOOLS, 'go', 'gocognit'),
};
const skip = (path) => (path && existsSync(path) ? false : 'set COMPLEXITY_TOOLS to run with real analyzers');

const git = (root, ...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });

function project(files = {}, { commit = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'complexity-'));
  const put = (entries) => {
    for (const [path, content] of Object.entries(entries)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
  };
  git(root, 'init', '-q');
  put(commit);
  if (Object.keys(commit).length) {
    git(root, 'add', '-A');
    git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  }
  put(files);
  if (tool.js && existsSync(tool.js)) symlinkSync(tool.js, join(root, 'node_modules'));
  put({ '.claude/complexity.json': JSON.stringify({ backend: 'local', tools: { complexipy: tool.py, gocognit: tool.go } }) });
  return root;
}

const edit = (root, file_path) => evaluate({ tool_name: 'Edit', tool_input: { file_path } }, { projectDir: root });

// A function with cognitive complexity well above 15 in each language.
const COMPLEX = {
  py: `def messy(items, flag, mode):
    out = []
    for i in items:
        if i > 0:
            if flag and mode == 1:
                for j in range(i):
                    if j % 2 == 0:
                        out.append(j)
                    elif j % 3 == 0 or j % 5 == 0:
                        while j > 0:
                            j -= 1
            else:
                try:
                    out.append(1 / i)
                except ZeroDivisionError:
                    if mode:
                        out.append(0)
    return out
`,
  ts: `export function messy(items: number[], flag: boolean, mode: number): number[] {
  const out: number[] = [];
  for (const i of items) {
    if (i > 0) {
      if (flag && mode === 1) {
        for (let j = 0; j < i; j++) {
          if (j % 2 === 0) { out.push(j); }
          else if (j % 3 === 0 || j % 5 === 0) { while (j > 0) { j--; } }
        }
      } else {
        try { out.push(1 / i); } catch (e) { if (mode) { out.push(0); } }
      }
    }
  }
  return out;
}
`,
  go: `package sample

func Messy(items []int, flag bool, mode int) []int {
	out := []int{}
	for _, i := range items {
		if i > 0 {
			if flag && mode == 1 {
				for j := 0; j < i; j++ {
					if j%2 == 0 {
						out = append(out, j)
					} else if j%3 == 0 || j%5 == 0 {
						for j > 0 {
							j--
						}
					}
				}
			} else if mode > 2 {
				out = append(out, 0)
			}
		}
	}
	return out
}
`,
};

describe('helpers', () => {
  it('maps extensions to analyzers', () => {
    assert.equal(languageOf('a/b.py'), 'python');
    assert.equal(languageOf('x.tsx'), 'javascript');
    assert.equal(languageOf('main.go'), 'go');
    assert.equal(languageOf('README.md'), undefined);
  });

  it('locates Python functions and methods', () => {
    const lines = ['def run():', '    pass', 'class A:', '    def run(self):', '        pass'];
    assert.equal(pythonLine(lines, 'run'), 1);
    assert.equal(pythonLine(lines, 'A::run'), 4);
  });

  it('names JS functions from the reported token or assignment', () => {
    const lines = ['export function messy(a) {', 'const handler = async (e) => {', 'items.map((x) => {'];
    assert.deepEqual(jsFunction(lines, { line: 1, column: 17, endLine: 1, endColumn: 22 }), { name: 'messy', key: 'messy' });
    assert.equal(jsFunction(lines, { line: 2, column: 30, endLine: 2, endColumn: 32 }).name, 'handler');
    assert.deepEqual(jsFunction(lines, { line: 3, column: 15, endLine: 3, endColumn: 17 }), {
      name: 'anonymous function', key: 'anonymous:items.map((x) => {',
    });
  });
});

describe('regressions', () => {
  const fn = (key, complexity) => ({ name: key, key, line: 1, complexity, plans: [] });

  it('reports new functions over the threshold', () => {
    assert.deepEqual(regressions([fn('a', 20), fn('b', 10)], [], 15).map((f) => f.key), ['a']);
  });

  it('ignores legacy complexity that did not grow', () => {
    assert.deepEqual(regressions([fn('a', 20)], [fn('a', 20)], 15), []);
    assert.deepEqual(regressions([fn('a', 18)], [fn('a', 25)], 15), []);
  });

  it('reports functions this change made more complex', () => {
    const [found] = regressions([fn('a', 22)], [fn('a', 16)], 15);
    assert.equal(found.previous, 16);
  });

  it('builds a report with the score, plans and refactoring patterns', () => {
    const found = [{ ...fn('messy', 34), line: 4, plans: [{ title: 'Flatten loop body', description: 'Use continue guards', lines: [6, 20], reduction: 6 }] }];
    const text = report({ rel: 'src/a.py', language: 'python', threshold: 15, found });
    assert.match(text, /S3776, limit 15/);
    assert.match(text, /messy \(line 4\): 34 \(new\) — reduce by at least 19/);
    assert.match(text, /Flatten loop body \(lines 6-20, about -6\)/);
    assert.match(text, /Guard clauses/);
    assert.match(text, /dict of callables/);
  });
});

describe('evaluate', () => {
  it('ignores unsupported, outside and ignored files', async () => {
    const root = project({ 'README.md': '# x', 'vendor/x/a.js': 'x', 'gen/a.py': 'x = 1' });
    writeFileSync(join(root, '.claude/complexity.json'), JSON.stringify({ ignore: ['gen/**'] }));
    assert.deepEqual(await edit(root, 'README.md'), {});
    assert.deepEqual(await edit(root, 'vendor/x/a.js'), {});
    assert.deepEqual(await edit(root, 'gen/a.py'), {});
    assert.deepEqual(await edit(root, '/etc/hosts'), {});
  });

  it('reports a missing analyzer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'complexity-'));
    writeFileSync(join(root, 'a.js'), 'export const a = 1;\n');
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude/complexity.json'), JSON.stringify({ backend: 'local', tools: { gocognit: '/nonexistent' } }));
    writeFileSync(join(root, 'a.go'), 'package a\n');
    assert.deepEqual(await edit(root, 'a.js'), { missing: 'javascript' });
    assert.deepEqual(await edit(root, 'a.go'), { missing: 'go' });
  });

  for (const [ext, path] of [['py', tool.py], ['ts', tool.js], ['go', tool.go]]) {
    it(`blocks a new complex function (${ext})`, { skip: skip(path) }, async () => {
      const root = project({ [`src/messy.${ext}`]: COMPLEX[ext] });
      const result = await edit(root, `src/messy.${ext}`);
      assert.equal(result.block, true);
      assert.match(result.reason, /messy.*\(new\)/i);
    });

    it(`leaves unchanged legacy complexity alone (${ext})`, { skip: skip(path) }, async () => {
      const root = project({}, { commit: { [`src/messy.${ext}`]: COMPLEX[ext] } });
      assert.deepEqual(await edit(root, `src/messy.${ext}`), {});
    });

    it(`honours the configured threshold (${ext})`, { skip: skip(path) }, async () => {
      const root = project({ [`src/messy.${ext}`]: COMPLEX[ext] });
      writeFileSync(join(root, '.claude/complexity.json'), JSON.stringify({
        threshold: 100, backend: 'local', tools: { complexipy: tool.py, gocognit: tool.go },
      }));
      assert.deepEqual(await edit(root, `src/messy.${ext}`), {});
    });
  }

  it('includes complexipy refactor plans for Python', { skip: skip(tool.py) }, async () => {
    const root = project({ 'messy.py': COMPLEX.py });
    const result = await edit(root, 'messy.py');
    assert.match(result.reason, /continue guards/i);
  });
});

// Runs when `docker compose -f analyzers/compose.yaml up -d` is running.
const containerUp = (() => {
  try {
    return execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', 'claude-analyzers'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true';
  } catch {
    return false;
  }
})();

describe('docker backend', { skip: containerUp ? false : 'start analyzers/compose.yaml to run' }, () => {
  for (const ext of ['py', 'ts', 'go']) {
    it(`analyzes ${ext} in the container`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'complexity-'));
      mkdirSync(join(root, '.claude'));
      writeFileSync(join(root, '.claude/complexity.json'), JSON.stringify({ backend: 'docker' }));
      writeFileSync(join(root, `messy.${ext}`), COMPLEX[ext]);
      const result = await edit(root, `messy.${ext}`);
      assert.equal(result.block, true);
      assert.match(result.reason, /messy.*\(new\)/i);
    });
  }

  it('reports missing when the container is not running', async () => {
    const root = mkdtempSync(join(tmpdir(), 'complexity-'));
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude/complexity.json'), JSON.stringify({ backend: 'docker', container: 'no-such-container' }));
    writeFileSync(join(root, 'a.py'), 'x = 1\n');
    assert.deepEqual(await edit(root, 'a.py'), { missing: 'python' });
  });
});

describe('hook process', () => {
  const exec = (event, root) => {
    const options = { input: JSON.stringify(event), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } };
    try {
      return { code: 0, stdout: execFileSync('node', [HOOK], options) };
    } catch (error) {
      return { code: error.status, stderr: error.stderr };
    }
  };

  it('tells Claude once per session when an analyzer is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'complexity-'));
    writeFileSync(join(root, 'a.js'), 'export const a = 1;\n');
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude/complexity.json'), JSON.stringify({ container: 'no-such-container' }));
    const event = { session_id: `t${Date.now()}`, cwd: root, tool_input: { file_path: join(root, 'a.js') } };
    const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
    const first = execFileSync('node', [HOOK], { input: JSON.stringify(event), encoding: 'utf8', env });
    assert.match(JSON.parse(first).hookSpecificOutput.additionalContext, /eslint-plugin-sonarjs/);
    assert.equal(execFileSync('node', [HOOK], { input: JSON.stringify(event), encoding: 'utf8', env }), '');
  });

  it('exits 2 with the report on stderr', { skip: skip(tool.py) }, () => {
    const root = project({ 'messy.py': COMPLEX.py });
    const result = exec({ tool_input: { file_path: join(root, 'messy.py') } }, root);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /messy \(line 1\): \d+ \(new\)/);
  });

  it('exits 0 on bad input', () => {
    assert.equal(execFileSync('node', [HOOK], { input: 'nope', encoding: 'utf8' }), '');
  });
});
