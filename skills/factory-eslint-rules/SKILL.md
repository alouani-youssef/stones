---
name: factory-eslint-rules
description: Use when setting up or extending ESLint in a TypeScript project, adding custom lint rules that steer coding agents (file organization, naming, tests next to code, structured logging, route middleware), adopting @factory/eslint-plugin, or when an agent keeps repeating a convention mistake that review catches but lint does not.
metadata:
  title: Factory ESLint rules
  frameworks: TypeScript
  summary: Turn conventions into lint rules agents can follow: adapt the Factory-AI rule set as local rules (upstream's advice) or install the pinned @factory/eslint-plugin, enable one rule at a time, and make every message say how to fix the code.
---

# Factory ESLint rules

[Factory-AI/eslint-plugin](https://github.com/Factory-AI/eslint-plugin) is the
set of lint rules Factory uses to keep coding agents on its conventions. An
agent reads lint output on every run. A rule whose message says exactly what to
do fixes the same mistake every time, with no extra prompt text. This skill
helps you pick rules from that set and bring them into the project.

Upstream's own advice is **not to import the package as is**: take the rules
that match your conventions and write your own. The package is also
unmaintained, and it ships only legacy `.eslintrc` configs built on Airbnb.
Each rule's full specification is in `rules/<rule>/README.md` next to this
file, written so an agent can reimplement it.

## Choose an approach

| Situation | Do |
| --- | --- |
| The project has its own layout, naming or logging conventions | **Adapt.** Write local rules from the READMEs below, renamed to the project's conventions (default) |
| An ESLint 8 project that already uses (or accepts) Airbnb style and Jest | **Install** `@factory/eslint-plugin@0.1.0` pinned, and extend one config |
| Biome, oxlint or no linter | Do not add ESLint just for this. Bring the idea up with the user first |
| A rule conflicts with a convention in `AGENT.md` or the `naming-files` skill | The project convention wins. Change the rule or skip it |

## Adapt (recommended)

1. Read `AGENT.md` and the existing ESLint config. List the conventions agents
   actually break. Review comments and repeated fixes are the best source.
2. Pick the matching rules from the catalog below and read their READMEs.
3. Write each as a local rule, for example in `eslint-rules/<rule>.ts` (or
   `.js`), loaded as a local plugin in `eslint.config.*`:

   ```js
   // eslint.config.js (flat config, ESLint 9)
   import local from './eslint-rules/index.js';

   export default [
     // ...existing config
     { plugins: { local }, rules: { 'local/types-file-organization': 'error' } },
   ];
   ```

4. Test each rule with `RuleTester` (valid and invalid cases taken from its
   README) using the project's test command. Write the test first.
5. Turn rules on one at a time. Run the lint command, then fix the existing
   violations or scope the rule with `files` / `ignores` before you enable the
   next one. Never commit a rule that leaves the lint command red.

## Install (pinned package)

```sh
npm install --save-dev --save-exact @factory/eslint-plugin@0.1.0 eslint typescript
```

Use the project's package manager. The configs are legacy-style:

- **ESLint 8 / `.eslintrc.*`:** `extends: ['plugin:@factory/recommended']`
  (`base`, `recommended`, `frontend` for React/Vite, `backend` for servers),
  with `parserOptions.project: './tsconfig.json'`.
- **ESLint 9 flat config:** wrap the config with `FlatCompat` from
  `@eslint/eslintrc`, or register only the rules:
  `plugins: { '@factory': factory }`, then name the rules you want. Prefer
  that second form: it avoids pulling in the whole Airbnb rule set.

`recommended` enables most file-organization and testing rules at `error`.
Expect many violations in an existing codebase, so start from `base` plus
named rules.

## Rule catalog

**File organization:** where each kind of declaration lives.

- [enum-file-organization](rules/enum-file-organization/README.md): enums only in `enums.ts`
- [types-file-organization](rules/types-file-organization/README.md): exported types and interfaces only in `types.ts`
- [constants-file-organization](rules/constants-file-organization/README.md): exported constants only in `constants.ts`
- [errors-file-organization](rules/errors-file-organization/README.md): custom `Error` classes only in `errors.ts`
- [test-utils-organization](rules/test-utils-organization/README.md): mocks and fixtures under `test-utils/`
- [test-file-location](rules/test-file-location/README.md): tests colocated with their source

**Naming and exports**

- [filename-match-export](rules/filename-match-export/README.md): file name matches its exported component or function
- [no-exported-function-expressions](rules/no-exported-function-expressions/README.md): exported functions are declarations
- [no-exported-string-union-types](rules/no-exported-string-union-types/README.md): enums instead of exported string unions

**Testing**

- [require-test-files](rules/require-test-files/README.md): every `.ts` file has a test
- [require-tsx-test-stories-files](rules/require-tsx-test-stories-files/README.md): every `.tsx` file has a test and a story
- [jest-mock-absolute-paths](rules/jest-mock-absolute-paths/README.md): `jest.mock()` uses absolute paths
- [jest-mock-require-actual](rules/jest-mock-require-actual/README.md): `jest.mock()` keeps unmocked exports via `jest.requireActual()`
- [no-unstable-mock-module](rules/no-unstable-mock-module/README.md): `jest.mock()`, not `unstable_mockModule`

**Logging**

- [structured-logging](rules/structured-logging/README.md): static log and error messages, dynamic values in a metadata object
- [no-log-exception-with-throw](rules/no-log-exception-with-throw/README.md): do not log an exception in the same block that throws it

**API routes** (Next.js; these assume Factory's own middleware names, so rename them when you adapt)

- [require-route-middleware](rules/require-route-middleware/README.md): route handlers call middleware first
- [require-v0-route-handle-middleware](rules/require-v0-route-handle-middleware/README.md): versioned routes use a shared handler
- [require-v0-strict-schemas](rules/require-v0-strict-schemas/README.md): Zod request schemas use `.strict()`

**React**

- [no-dynamic-styled-components](rules/no-dynamic-styled-components/README.md): no styled-components created inside functions
- [no-plain-html-text-elements](rules/no-plain-html-text-elements/README.md): text goes through design-system components
- [no-use-effect-in-hooks](rules/no-use-effect-in-hooks/README.md): no effects inside custom hooks
- [restrict-tsx-components](rules/restrict-tsx-components/README.md): components only in `.page`, `.module`, `.layout`, `.view` or `.provider` `.tsx` files

## Writing messages agents act on

- Say what to do, not only what is wrong: "Move `User` to `./types.ts`",
  not "Invalid type location".
- Name the exact file, symbol or API to use instead.
- Add an autofix (`fixer`) only when the fix is unambiguous.
- Keep each rule to one convention, so a failure points to one fix.

## Common mistakes

- Enabling all of `recommended` at once on an existing codebase, which buries
  real problems under thousands of violations.
- Copying the Factory-specific names (`handleV0RouteMiddleware`, `SafeLink`,
  `logException`) into a project that has no such API.
- Adding `require-test-files` without exemptions for barrel files, generated
  code and type-only files.
- Silencing a rule with `eslint-disable` instead of fixing the code or
  narrowing the rule's scope.

## References

Check these when a detail here disagrees with the installed ESLint version.

- [Factory-AI/eslint-plugin](https://github.com/Factory-AI/eslint-plugin): source of the rules and configs (licensing and the pinned commit are in `UPSTREAM.md`)
- [Using linters to direct agents](https://factory.ai/news/using-linters-to-direct-agents): why these rules exist
- [Custom rules](https://eslint.org/docs/latest/extend/custom-rules): rule structure, `context.report`, fixers
- [RuleTester](https://eslint.org/docs/latest/integrate/nodejs-api#ruletester): testing a rule with valid and invalid cases
- [Configuration migration guide](https://eslint.org/docs/latest/use/configure/migration-guide): `FlatCompat` and moving `.eslintrc` configs to flat config
- [typescript-eslint custom rules](https://typescript-eslint.io/developers/custom-rules): typed rules and `RuleCreator`
