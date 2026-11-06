# Naming Conventions

Choose names that tell readers what a file, directory, type, or function is responsible for. Follow the conventions already used by nearby code, and use a language’s standard style when a project has no established pattern.

## File and directory names

When a new file is created with the `Write` tool, the naming hook checks its path before creation. It applies only to new files inside the project; editing or overwriting an existing file does not trigger a naming block. Existing directories are left as they are.

For a file, the hook chooses a style in this order:

1. An explicit extension rule in `.claude/naming.json`.
2. A clear majority among sibling files with the same extension (at least two samples).
3. A clear majority among same-extension files in the project (at least three samples).
4. The language or framework default.

A style must account for at least 60% of the usable samples to be considered a majority. A directory is checked against the style used by its sibling directories, when enough examples exist, or against the default for the file’s language. Defaults are defined in `hooks/naming.mjs` and include:

| Language or file kind | Typical file style | Typical directory style |
| --- | --- | --- |
| Python, Go, Rust, Ruby | `snake_case` | `snake_case` (Go also allows lowercase) |
| Java, Kotlin | `PascalCase` | lowercase |
| JavaScript, TypeScript, CSS, HTML | `kebab-case` | `kebab-case` |
| React component files (`.jsx`, `.tsx`) | `PascalCase` | `kebab-case` |
| JSON, YAML, TOML, TOON | `kebab-case` | `kebab-case` |
| Markdown | `kebab-case` (or `SCREAMING_SNAKE_CASE`) | `kebab-case` |

The hook recognizes `index`, `main`, `README`, common configuration and license files, language dunder modules, dotfiles, extensionless files, dynamic route segments, and framework-reserved names as special cases. Some framework names are exempt only when the matching framework is detected in `package.json`.

## File roles and test names

Keep a file’s subject and role clear. In languages whose module names allow dots, a role can be a lowercase kebab-case suffix: `user.service.ts`, `user.spec.ts`. In Python, Go, Rust, and other languages where dotted module names are not appropriate, express the role in the module name: `user_service.py`, `user_test.go`. The hook recognizes `test`, `spec`, `e2e`, and `tests` as test roles; language defaults determine whether a test marker is a prefix or suffix.

Use conventional entry-point names when required by the language or framework, even when they differ from the general style. The hook maintains a list of reserved names for this purpose.

## Project overrides

Add `.claude/naming.json` to customize behavior for a project:

```json
{
  "enabled": true,
  "extensions": {
    "ts": "kebab",
    "py": "snake"
  },
  "directories": "kebab",
  "allow": ["legacyName.ts"],
  "ignore": ["generated/**"]
}
```

Supported style values are `kebab`, `snake`, `camel`, `pascal`, `screaming`, and `flat`. `extensions` maps a file extension without a leading dot to a style; `directories` sets the style for new directories. `allow` exempts intentional file names, and `ignore` accepts project-relative glob patterns. Set `enabled` to `false` to disable the check for the project. The hook also ignores `node_modules/**`, `dist/**`, `build/**`, and `vendor/**` by default.

When a new name does not fit, the hook blocks creation and suggests a compliant path. Use that suggestion when it preserves the intended meaning; add an intentional exception to `allow` or `ignore` when the name is required by a framework, generator, or external convention.

For the broader workflow for adding a file or module, see [Creation Guidelines](../creation/README.md).
