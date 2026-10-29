---
name: git-push-pr-sync
description: >-
  Post-push PR synchronization. Apply after successfully pushing commits to a branch.
  Checks for an existing PR and delegates to sync-pr-details to update title/description.
user-invocable: false
---

# Post-Push PR Sync

Apply these steps after successfully pushing commits to a remote branch.

## Steps

### Step 1: Check for Open PR

```bash
gh pr view --json url,number
```

If this fails with "no pull requests found", stop here—no PR exists for this branch.

### Step 2: Sync PR Details

If a PR exists, apply the [sync-pr-details skill](../sync-pr-details/SKILL.md) to ensure the PR title and description accurately reflect the current branch state.
