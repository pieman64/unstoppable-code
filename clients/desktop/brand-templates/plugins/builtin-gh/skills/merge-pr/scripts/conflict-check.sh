#!/usr/bin/env bash
# Test whether two commits merge cleanly, without touching the current checkout.
# Run inside the repository. Both commits must already be fetched.
#
# Usage:
#   conflict-check.sh OURS THEIRS
#
# Prints one JSON line: {"conflict": bool, "files": [...], "method": "merge-tree"|"worktree"}
#
# Exit codes:
#   0  Merges cleanly
#   1  Conflicts (files lists the conflicting paths)
#   2  Usage or git error
set -uo pipefail

if [ $# -ne 2 ]; then
  echo '{"error":"usage: conflict-check.sh OURS THEIRS"}'
  exit 2
fi

ours=$(git rev-parse --verify --quiet --end-of-options "$1^{commit}") || { jq -cn --arg r "$1" '{error: ("unknown commit: " + $r)}'; exit 2; }
theirs=$(git rev-parse --verify --quiet --end-of-options "$2^{commit}") || { jq -cn --arg r "$2" '{error: ("unknown commit: " + $r)}'; exit 2; }

report() { # method, newline-separated files
  jq -cn --arg m "$1" --arg f "$2" \
    '{conflict: ($f != ""), files: ($f | split("\n") | map(select(. != "")) | unique), method: $m}'
  [ -n "$2" ] && exit 1 || exit 0
}

# git 2.38+ can merge without a working tree. `-h` exits 129, so capture before matching.
help=$(git merge-tree -h 2>&1)
if printf '%s' "$help" | grep -q -- '--write-tree'; then
  errfile=$(mktemp "${TMPDIR:-/tmp}/merge-pr-merge-tree.XXXXXX")
  out=$(git merge-tree --write-tree --name-only --no-messages "$ours" "$theirs" 2>"$errfile")
  rc=$?
  err=$(cat "$errfile")
  rm -f "$errfile"
  case $rc in
    0) report merge-tree "" ;;
    1) report merge-tree "$(printf '%s\n' "$out" | tail -n +2)" ;;
    *) jq -cn --arg e "${err:-$out}" '{error: ("git merge-tree failed: " + $e)}'; exit 2 ;;
  esac
fi

# Older git: try the merge in a throwaway detached worktree. Repository hooks (post-checkout, husky)
# and the Git LFS smudge filter are disabled so the probe stays fast and side-effect free.
export GIT_LFS_SKIP_SMUDGE=1
tmp=$(mktemp -d "${TMPDIR:-/tmp}/merge-pr-conflict.XXXXXX")
cleanup() {
  git worktree remove --force "$tmp" >/dev/null 2>&1
  rm -rf "$tmp"
  git worktree prune >/dev/null 2>&1
}
trap cleanup EXIT

if ! err=$(git -c core.hooksPath=/dev/null worktree add --quiet --detach "$tmp" "$ours" 2>&1); then
  jq -cn --arg e "$err" '{error: ("git worktree add failed: " + $e)}'
  exit 2
fi
err=$(git -C "$tmp" -c core.hooksPath=/dev/null -c user.name=merge-pr -c user.email=merge-pr@localhost \
  merge --no-commit --no-ff --quiet "$theirs" 2>&1)
rc=$?
files=$(git -C "$tmp" diff --name-only --diff-filter=U)
git -C "$tmp" merge --abort >/dev/null 2>&1
if [ "$rc" -ne 0 ] && [ -z "$files" ]; then
  jq -cn --arg e "$err" '{error: ("git merge failed: " + $e)}'
  exit 2
fi
report worktree "$files"
