import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const TASK_NOTE = 'context/tasks/active.md';
const isPlaceholder = (text) =>
  /\b(?:TODO|TBD|replace me)\b|\[(?:describe|write|add|replace|reason|expected|condition)\b[^\]]*\]/i.test(text);
const TEST_COMMANDS = [
  /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:(?:--workspace|--filter|--scope)(?:=|\s+)[^\s]+\s+|workspace\s+[^\s]+\s+)*(?:run\s+)?(?:tests?(?:[:.-][\w.-]+)?|unit:tests?|specs?|e2e)(?=\s|$)/i,
  /(?:^|\s)(?:node|npx|bunx|npm\s+exec|pnpm\s+exec|yarn\s+dlx)\s+[^;&|\n]*(?:--test\b|\b(?:jest|vitest|mocha|playwright|cypress|pytest)\b)/i,
  /(?:^|\s)(?:(?:npx|bunx|npm\s+exec|pnpm\s+exec)\s+)?nx\s+(?:run\s+)?(?:test\b|[^\s:]+:test\b)/i,
  /(?:^|\s)turbo\s+(?:run\s+)?test\b/i,
  /(?:^|\s)(?:pytest|tox|nosetests|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|gradle\s+test|swift\s+test|phpunit|rspec|bun\s+test)(?=\s|$)/i,
  /(?:^|\s)(?:jest|vitest|mocha|playwright|cypress)\b/i,
];

const section = (text, heading) => {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  return lines.slice(start + 1, end < 0 ? lines.length : end)
    .join('\n')
    .replace(/<!--([\s\S]*?)-->/g, '')
    .trim();
};

function readTaskNote(project) {
  const file = resolve(project, TASK_NOTE);
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function inspectTaskNote(text) {
  if (typeof text !== 'string') return { valid: false, reason: `Create ${TASK_NOTE} before running tests or editing test/spec files.` };

  const behavior = section(text, 'Expected behavior');
  if (!behavior || isPlaceholder(behavior)) {
    return { valid: false, reason: `Add the expected behavior to the ## Expected behavior section in ${TASK_NOTE}.` };
  }

  const scenarios = section(text, 'Scenarios');
  const hasScenario = scenarios.split('\n').some((line) =>
    /^\s*[-*]\s+.+?\bExpected:\s*\S.+$/i.test(line) && !isPlaceholder(line));
  if (!hasScenario) {
    return { valid: false, reason: `Add at least one scenario bullet with an expected outcome (for example, "- Scenario: ... Expected: ...") in ${TASK_NOTE}.` };
  }

  const contractChange = section(text, 'Contract change');
  const unchanged = /^(?:none|no|unchanged|no contract change)\.?$/i.test(contractChange);
  const changed = /^behavior changed:\s*\S.{7,}$/i.test(contractChange) && !isPlaceholder(contractChange);
  if (!unchanged && !changed) {
    return { valid: false, reason: `Set ## Contract change to "none" or "behavior changed: <reason>" in ${TASK_NOTE}.` };
  }
  return { valid: true, changed };
}

function isTestCommand(command) {
  return command.split(/&&|\|\||[;|\n]/).some((part) => TEST_COMMANDS.some((pattern) => pattern.test(part.trim())));
}

function shellWriteTargets(command) {
  const targets = [];
  const capture = (match) => match[1] ?? match[2] ?? match[3];
  for (const match of command.matchAll(/(?:^|\s)\d*>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g)) {
    targets.push(capture(match));
  }
  for (const match of command.matchAll(/(?:^|\s)(?:tee|touch)\s+(?:-a\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g)) {
    targets.push(capture(match));
  }
  return targets;
}

function isTestOrSpecFile(file) {
  const normalized = file.split(sep).join('/');
  const parts = normalized.split('/');
  const basename = parts.at(-1) ?? '';
  if (/\.(?:feature|snap)$/i.test(basename)) return true;
  if (parts.some((part) => /^(?:__tests__|__snapshots__|tests?|specs?|features)$/i.test(part))) return true;
  if (/(?:^|\/)openspec\/(?:specs|changes\/[^/]+\/specs)\//i.test(normalized)) return true;
  if (/(?:^|\/)context\/specs?\//i.test(normalized)) return true;
  return /(?:^|[._-])(?:test|tests|spec|specs|e2e)(?:[._-]|$)/i.test(basename) ||
    /(?:^|\/)test_[^/]+\.py$/i.test(normalized) ||
    /_test\.go$/i.test(basename);
}

const blocked = (reason) => ({ block: true, reason: `Testing guard: ${reason}` });
const allow = () => ({ block: false });

function isInsideProject(project, file) {
  const rel = relative(project, file);
  return rel && !rel.startsWith('..') && !isAbsolute(rel);
}

function guardTestFile(project, rel) {
  const status = inspectTaskNote(readTaskNote(project));
  if (!status.valid) return blocked(status.reason);
  if (!status.changed) {
    return blocked(`do not edit ${rel} to make a failing check pass. Fix the source; if expected behavior is changing, record the change and rationale in ## Contract change in ${TASK_NOTE}.`);
  }
  return null; // no block
}

function evaluateBash(command, project) {
  if (isTestCommand(command)) {
    const status = inspectTaskNote(readTaskNote(project));
    if (!status.valid) return blocked(status.reason);
  }
  for (const target of shellWriteTargets(command)) {
    const file = resolve(project, target);
    const rel = relative(project, file);
    if (isInsideProject(project, file) && isTestOrSpecFile(rel)) {
      const block = guardTestFile(project, rel);
      if (block) return block;
    }
  }
  return allow();
}

function evaluateFileEdit(filePath, project) {
  const file = resolve(project, filePath);
  const rel = relative(project, file);
  if (!isInsideProject(project, file) || !isTestOrSpecFile(rel)) return allow();
  return guardTestFile(project, rel) ?? allow();
}

export function evaluate(event, { projectDir } = {}) {
  const { tool_name, tool_input = {} } = event ?? {};
  const project = resolve(projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());

  if (tool_name === 'Bash') return evaluateBash(tool_input.command ?? '', project);

  if (['Edit', 'MultiEdit', 'Write'].includes(tool_name) && typeof tool_input.file_path === 'string') {
    return evaluateFileEdit(tool_input.file_path, project);
  }

  return allow();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  try {
    const result = evaluate(JSON.parse(input));
    if (result.block) {
      console.error(result.reason);
      process.exit(2);
    }
  } catch {
    // A malformed hook event must not interrupt the user's work.
  }
}
