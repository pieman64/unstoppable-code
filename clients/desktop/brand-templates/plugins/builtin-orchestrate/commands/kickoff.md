---
name: kickoff
description: >-
  {% if claude %}/builtin-orchestrate:kickoff only. {% endif %}Create a workspace worktree (branch + checkout) for ticket work, base-branch-aware — no agent is started
argument-hint: '<workspace> <ticket-or-slug> [base-branch]'
---

# Kickoff — create a workspace worktree

Create a worktree (with branch) in a single-repo workspace so implementation can start there —
from any terminal or chat. The running app adopts the worktree into the sidebar automatically (the
worktree index has a live watcher); no UI interaction needed.

If the goal is a worktree **plus a working agent already briefed in it**, use
{% if claude %}`/builtin-orchestrate:handoff`{% else %}`$builtin-orchestrate:handoff`{% endif %} instead — this command
only creates the checkout. Assume the CLI is available as a global `{{BRAND_CLI_NAME}}`
executable.

## Procedure

```bash
WS=<workspace-id>            # usually the repo name; verify: {{BRAND_CLI_NAME}} workspace list
SLUG=<ticket-or-slug>        # e.g. abc-1234-fix-thing; keep the ticket ID in the slug
BASE=<base-branch>           # OPTIONAL — leave unset to auto-detect the remote default below
REPO_PATH=$({{BRAND_CLI_NAME}} workspace list | awk -F'\t' -v ws="$WS" '$1==ws {print $4}')

# 1) Freshen the base — the LOCAL ref named $BASE must move: a bare --base-branch
#    resolves locally as the git start-point. `git pull` integrates into the CURRENT
#    branch, so only pull when the root checkout is actually on $BASE; otherwise
#    update the ref without a checkout.
BASE="${BASE:-$(git -C "$REPO_PATH" remote show origin | sed -n 's/.*HEAD branch: //p')}"
# Explicit refspec: managed worktree clones can carry a narrow fetch refspec,
# where a bare `fetch origin <branch>` does NOT update refs/remotes/origin/<branch>.
git -C "$REPO_PATH" fetch origin "+refs/heads/$BASE:refs/remotes/origin/$BASE"
# Ahead-only local base: --ff-only reports "up to date" instead of failing, and the
# create below starts from the LOCAL ref — so the worktree would silently inherit
# unpushed base commits. Same rejection the handoff flow performs.
[ "$(git -C "$REPO_PATH" rev-list --count "origin/$BASE..$BASE" 2>/dev/null || echo 0)" -eq 0 ] \
  || { echo "STOP: local $BASE has unpushed commits — push the base leg first"; false; }
if [ "$(git -C "$REPO_PATH" rev-parse --abbrev-ref HEAD)" = "$BASE" ]; then
  # ff-only: the root checkout must never grow merge commits; a fast-forward is
  # all that should happen here, and ff-only fails loudly if it wouldn't be.
  git -C "$REPO_PATH" pull --ff-only origin "$BASE"
else
  # fails if $BASE is checked out in another worktree — free it first
  git -C "$REPO_PATH" fetch origin "$BASE:$BASE"
fi

# 2) Reuse if a worktree for this slug already exists
{{BRAND_CLI_NAME}} workspace worktrees "$WS" list

# 3) Create — --base-branch feeds BOTH the git start-point AND the worktree's
#    tracked base branch (drives diff stats and Changed Files). A bare name
#    resolves against LOCAL refs (which is why step 1 freshens them); an
#    "origin/x" value starts from the remote-tracking ref and tracks "x".
#    Either works; a nonexistent ref fails the create loudly.
{{BRAND_CLI_NAME}} workspace worktrees "$WS" create \
  --branch "<branch-per-team-convention>/$SLUG" --base-branch "$BASE"
```

The create prints JSON; `path` is the checkout under the app's managed worktree layout for that
workspace.

## Non-default (stacked) bases

Freshen the feature branch's local ref first — `git -C "$REPO_PATH" fetch origin
"$FEATURE:$FEATURE"` (works while it isn't checked out anywhere) — then pass
`--base-branch "$FEATURE"`. This is what makes the worktree's diff stats and Changed Files compare
against the feature branch instead of the default. See
[platform-mechanics.md]({% if claude %}../references/platform-mechanics.md{% else %}../../references/platform-mechanics.md{% endif %}) for the full stacked-PR rules
(push-base-first, SHA in briefs, squatter preflight).

## Rules

- Keep the ticket ID in the slug — it should end up in the PR title.
- `create --branch` always creates a NEW branch (`git worktree add -b`) and fails if the name
  already exists. For an existing branch: reuse the worktree that already holds it (step 2), open
  it through the app's existing-branch worktree UI, or pick a new branch name. If a create fails
  with "already checked out at <path>", a worktree somewhere in the shared clone owns that
  branch. Reuse that checkout or ask the user to resolve the conflict; do not delete it to retry.
- After checkout: activate the repo's toolchain version (check `.nvmrc` or equivalent) and read
  the repo's `CLAUDE.md` / `AGENTS.md` before running anything.

For a running implementer, handoff next finds the adopted task with `projects.list_tasks`,
creates an empty chat with `projects.create_task_chat`, then delivers the brief through
`projects.send_message` with an inline completion watcher. Kickoff itself starts no chat or turn.
