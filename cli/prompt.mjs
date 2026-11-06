// Question helpers. Every question has an id, so answers can be replayed
// from a previous run (`.claude/stones.json`), scripted in tests, or taken
// from defaults with `--yes`.
import { createInterface } from 'node:readline';

const show = (value) => (Array.isArray(value) ? value.join(', ') : value);

// Interactive prompter on a stream. Lines are queued as they arrive so
// piped input is never lost between questions.
export function createPrompter({ input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, terminal: false });
  const queue = [];
  const waiting = [];
  let closed = false;
  rl.on('line', (line) => (waiting.length ? waiting.shift()(line) : queue.push(line)));
  rl.on('close', () => {
    closed = true;
    while (waiting.length) waiting.shift()(undefined);
  });

  const line = (label) => {
    output.write(label);
    if (queue.length) return Promise.resolve(queue.shift());
    if (closed) return Promise.resolve(undefined);
    return new Promise((done) => waiting.push(done));
  };

  const prompter = {
    note(text) {
      output.write(`${text}\n`);
    },
    async text(_id, label, fallback = '') {
      const answer = (await line(`${label}${fallback ? ` [${fallback}]` : ''}: `))?.trim();
      return answer || fallback;
    },
    async confirm(_id, label, fallback = true) {
      const answer = (await line(`${label} ${fallback ? '[Y/n]' : '[y/N]'}: `))?.trim().toLowerCase();
      if (!answer) return fallback;
      return answer.startsWith('y');
    },
    async select(_id, label, options, fallback) {
      output.write(`${label}\n`);
      options.forEach((o, i) => output.write(`  ${i + 1}. ${o.label}${o.hint ? ` — ${o.hint}` : ''}\n`));
      const def = Math.max(0, options.findIndex((o) => o.value === fallback));
      for (;;) {
        const answer = (await line(`Choose 1-${options.length} [${def + 1}]: `))?.trim();
        if (!answer) return options[def].value;
        const n = Number(answer);
        if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value;
        const byName = options.find((o) => o.value === answer || o.label === answer);
        if (byName) return byName.value;
      }
    },
    async multi(_id, label, options, fallback = []) {
      output.write(`${label}\n`);
      options.forEach((o, i) => {
        const on = fallback.includes(o.value) ? 'x' : ' ';
        output.write(`  [${on}] ${i + 1}. ${o.label}${o.hint ? ` — ${o.hint}` : ''}\n`);
      });
      const answer = (await line('Numbers separated by commas, "none", or Enter to keep: '))?.trim();
      if (!answer) return fallback;
      if (answer === 'none') return [];
      return answer
        .split(/[\s,]+/)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= options.length)
        .map((n) => options[n - 1].value);
    },
    close() {
      rl.close();
    },
  };
  return prompter;
}

// Non-interactive prompter: answers from `answers[id]`, else the default.
export function createScriptedPrompter(answers = {}, { output } = {}) {
  const pick = (id, fallback) => (id in answers ? answers[id] : fallback);
  const log = (label, value) => output?.write(`${label}: ${show(value)}\n`);
  return {
    note(text) {
      output?.write(`${text}\n`);
    },
    async text(id, label, fallback = '') {
      const v = pick(id, fallback);
      log(label, v);
      return v;
    },
    async confirm(id, label, fallback = true) {
      const v = pick(id, fallback);
      log(label, v ? 'yes' : 'no');
      return v;
    },
    async select(id, label, _options, fallback) {
      const v = pick(id, fallback);
      log(label, v);
      return v;
    },
    async multi(id, label, _options, fallback = []) {
      const v = pick(id, fallback);
      log(label, v);
      return v;
    },
    close() {},
  };
}
