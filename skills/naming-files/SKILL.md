---
name: naming-files
description: Use when choosing a name or path for a new file or directory, when the naming hook blocks a Write with a suggested path, or when configuring .claude/naming.json.
metadata:
  title: Naming Conventions
  summary: How new file and directory names are chosen and checked against the project's existing style per language.
---

# Naming Conventions

Names tell readers what a file, directory, type or function is responsible for. Follow nearby code; use the language's standard style when the project has none.

## How the naming hook decides

The hook checks the path of a **new** file created with `Write`. Editing or overwriting an existing file is never blocked, and existing directories are left as they are.

Style for a file, first match wins:

1. An explicit extension rule in `.claude/naming.json`.
2. A clear majority among sibling files with the same extension (at least two samples).
3. A clear majority among same-extension files in the project (at least three samples).
4. The language or framework default.

A majority means at least 60% of usable samples. A directory follows its sibling directories when there are enough, else the language default.

| Language or file kind | File style | Directory style |
| --- | --- | --- |
| Python, Go, Rust, Ruby | `snake_case` | `snake_case` (Go also lowercase) |
| Java, Kotlin | `PascalCase` | lowercase |
| JavaScript, TypeScript, CSS, HTML | `kebab-case` | `kebab-case` |
| React components (`.jsx`, `.tsx`) | `PascalCase` | `kebab-case` |
| JSON, YAML, TOML, TOON | `kebab-case` | `kebab-case` |
| Markdown | `kebab-case` (or `SCREAMING_SNAKE_CASE`) | `kebab-case` |

Special cases are recognized: `index`, `main`, `README`, common config and license files, dunder modules, dotfiles, extensionless files, dynamic route segments and framework-reserved names (some only when the framework is in `package.json`).

## Roles and test names

Keep subject and role clear. Where module names allow dots, the role is a lowercase kebab suffix: `user.service.ts`, `user.spec.ts`. In Python, Go, Rust and similar, put the role in the name: `user_service.py`, `user_test.go`. Test roles: `test`, `spec`, `e2e`, `tests`; the language decides prefix vs suffix. Use required entry-point names even when they break the general style.

## When the hook blocks

The block suggests a compliant path. Use it when it keeps the intended meaning. When a framework, generator or external convention requires the name, add it to `allow` or `ignore` in `.claude/naming.json` instead of renaming.

```json
{
  "enabled": true,
  "extensions": { "ts": "kebab", "py": "snake" },
  "directories": "kebab",
  "allow": ["legacyName.ts"],
  "ignore": ["generated/**"]
}
```

Styles: `kebab`, `snake`, `camel`, `pascal`, `screaming`, `flat`. `extensions` maps an extension (no dot) to a style; `directories` sets the style for new directories; `ignore` takes project-relative globs; `enabled: false` disables the check. `node_modules/**`, `dist/**`, `build/**`, `vendor/**` are always ignored.

For the broader workflow of adding a file, see the `creating-files-and-modules` skill.
