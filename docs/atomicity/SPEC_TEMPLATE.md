# Danger-zone spec

Save a filled copy as `.claude/danger/<branch with / as -->.md` (for `db/add-orders-index`: `.claude/danger/db--add-orders-index.md`) and commit it on the branch. The hook requires all six sections, non-empty, with no bracketed prompts or TODO/TBD left in.

## Zone

[describe the zone: exactly one of db, packages or network, matching the branch prefix]

## What changes

[describe the exact change: files, tables, packages and versions, hosts or endpoints]

## Why

[describe the reason this change is needed now and what depends on it]

## Blast radius

[describe what can break and for whom: services, data, users, deploys]

## Rollback

[describe how to undo it. db: is the migration reversible and what happens to existing data. packages: how to pin back. network: how to turn the call or endpoint off]

## Verification

[describe how it was proven to work: commands run, results, what was checked by hand]
