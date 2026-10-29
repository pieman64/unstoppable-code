---
name: open-pr
description: >-
  {% if claude %}/builtin-gh:open-pr{% else %}$builtin-gh:open-pr{% endif %} only. Create a pull request for the current branch
---

# Create Pull Request

Create a pull request for the current branch targeting the default branch.

**Arguments received**: `the user request`

## Instructions

### Step 0: Push Changes (if --push flag is present)

If `the user request` contains `--push`, perform the following workflow before proceeding to Step 1:

1. **Check git status**: Run `git status` to see all untracked and modified files
2. **Check git diff**: Run `git diff` to see unstaged changes (these will be staged in the next step)
3. **Stage all changes**: Run `git add -A` to stage all changes
4. **Create commit**: Generate a commit message following the {% if claude %}/builtin-git:commit-messages{% else %}$builtin-git:commit-messages{% endif %} skill, then commit
5. **Push to remote**: Push the changes to the remote branch (use `git push -u origin HEAD` if no upstream is set)
6. If there are no changes to commit, skip this step and proceed to Step 1

### Step 1: Check for Existing PR

Run `gh pr view --json url --jq '.url'` to check if there's already an open PR for the current branch. If a PR exists, display the PR URL to the user and stop—do not proceed with any other steps.

### Step 2: Gather Branch Context

Follow the [PR Diff Operations](../../references/pr-diff-operations.md) to:

1. Get the default branch name
2. Fetch the latest base branch
3. Gather commit history and diff summary

### Step 3: Create PR

Use the `gh` CLI tool to create the pull request. If `gh` is not available or not authenticated, inform the user and provide the URL to create the PR manually: `https://github.com/{owner}/{repo}/compare/<default-branch>...{branch}`

- If `the user request` contains `--draft`, pass the `--draft` flag to `gh pr create` to create the PR as a draft
- **Do NOT include any attribution text** such as "Generated with Claude Code", "Generated with Codex", or similar AI-generated markers in the PR title or body

### Step 4: Follow the PR Template

Follow the [pr-template skill](../pr-template/SKILL.md).

### Step 5: Assign the PR to the Author

This step only applies if the PR was created via `gh pr create` in Step 3. If Step 3 used the manual browser URL fallback because `gh` was unavailable or not authenticated, skip this step.

Immediately after the PR is created via `gh`, assign it to the author so it shows up in their dashboard. Run:

```bash
gh pr edit <pr-number> --add-assignee @me || \
  gh pr edit <pr-number> --add-assignee "$(gh api user --jq '.login')" || \
  echo "Warning: failed to assign PR to author; continuing."
```

Resolve `<pr-number>` from the `gh pr create` output (the URL ends with the PR number) or from `gh pr view --json number --jq '.number'`. The command first tries GitHub CLI's `@me` alias, then falls back to the authenticated user's login. If both assignment attempts fail, log the warning and continue because assignment is a convenience step and should not block PR creation.

### Step 6: Return the PR URL

Return the PR URL to the user when complete.
