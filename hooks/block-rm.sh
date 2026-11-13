#!/bin/bash
# Blocks rm (and find -delete) anywhere in a command: at the start, after
# ; && || | ( or $(, behind sudo/xargs/env, or by path such as /bin/rm.
# rmdir, `git rm` and words that merely contain "rm" are allowed. A guardrail
# against accidents, not a security boundary: the sandbox is that.
input=$(cat)
command=$(jq -r '.tool_input.command // ""' <<<"$input")
start='(^|[;&|(`]|\$\()[[:space:]]*'
wrappers='((sudo|command|exec|xargs|env|nice|nohup|time)[[:space:]]+(-[^[:space:]]+[[:space:]]+)*)*'
if grep -Eq "${start}${wrappers}([^[:space:]]*/)?rm([[:space:]]|$)" <<<"$command" ||
  grep -Eq '(^|[[:space:]])find[[:space:]].*[[:space:]]-delete([[:space:]]|$)' <<<"$command"; then
  echo "Blocked: rm commands are not allowed" >&2
  exit 2
fi
exit 0
