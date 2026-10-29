---
name: push-branch
description: >-
  {% if claude %}/builtin-gh:push-branch{% else %}$builtin-gh:push-branch{% endif %} only. Commit and push all changes with auto-generated message
---

# Push Changes

The user wants to commit and push all their changes.

Perform the following workflow:

1. **Check git status**: Run `git status` to see all untracked and modified files
2. **Check git diff**: Run `git diff` to see unstaged changes (these will be staged in the next step)
3. **Stage all changes**: Run `git add -A` to stage all changes
4. **Create commit**: Generate a commit message following the {% if claude %}/builtin-git:commit-messages{% else %}$builtin-git:commit-messages{% endif %} skill, then commit
5. **Push to remote**: Push the changes to the remote branch (use `git push -u origin HEAD` if no upstream is set)
6. **Sync PR**: Follow the [git-push-pr-sync skill](../git-push-pr-sync/SKILL.md) to check for and update any existing PR
