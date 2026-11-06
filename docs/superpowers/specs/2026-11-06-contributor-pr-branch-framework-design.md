# Contributor PR and branch framework

## Intent

Give contributors to `claude-stones` a small, predictable way to name work branches and prepare pull requests. Keep the guidance easy to follow for this focused CLI repository.

## Goals

- Document branch naming and the expected branch base at a practical level.
- Explain what a useful pull request description should contain, how to validate a change, and what reviewers need to assess it.
- Link the guides from the repository README so contributors can find them.

## Non-goals

- Enforcing branch names or PR policy through CI or hooks.
- Introducing a mandatory commit-message format, approval count, merge strategy, or release process that the project has not adopted.
- Changing the existing uncommitted code and documentation changes.

## Approaches

- **Lightweight guidance (selected):** short `frameworks/BRANCHES.md` and `frameworks/PR.md` documents, linked from README. This fits the repository's current scale and leaves project decisions that are not established to maintainer judgment.
- **Full contribution policy:** define lifecycle, commit format, review count, merge strategy, and release rules. This is more explicit but would impose conventions unsupported by existing project policy.

## Constraints and calls

- Treat the guides as policy for contributors to this repository, not templates installed into generated projects.
- The repository currently has a `main` branch and no visible contribution policy in README. Avoid prescribing a protected-branch configuration or an unverified CI command.
- Existing local changes are user work; the implementation should preserve them and make only focused edits to the two framework files and README.

## Builder choices

The builder may choose concise branch prefixes and checklist wording that suit the repository. Any command listed for validation must be supported by `package.json` or the existing README.
