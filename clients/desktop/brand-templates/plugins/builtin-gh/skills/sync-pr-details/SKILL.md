---
name: sync-pr-details
description: >-
  Sync PR title and description with current branch changes. Apply when updating
  an existing PR, after pushing new commits to a PR branch, when PR description
  becomes stale or inaccurate, or when explicitly asked to update PR details.
---

# Sync PR Details

Ensures the PR title and description accurately reflect the current state of the branch.

## When to Use

Apply this skill when:

- Pushing additional commits to an existing PR branch
- The PR description no longer reflects the current changes
- Asked to update or sync PR details
- Creating follow-up changes after initial PR creation

## Prerequisites

- A PR must already exist for the current branch
- If unsure, check with: `gh pr view --json url,number`

## Steps

### Step 1: Gather Current Branch State

Follow the [PR Diff Operations](../../references/pr-diff-operations.md) to fetch the latest base branch and gather:

- Commit history since diverging from default
- Diff summary of all changes

### Step 2: Get Current PR Content

Retrieve the existing PR title and body:

```bash
gh pr view --json title,body,number
```

### Step 3: Compare and Decide

Determine if the PR needs updating:

**IMPORTANT**: Only consider changes that are part of the PR diff (from Step 1) when generating the summary. Do not include information from the conversation history, previous PRs, or other context that is not reflected in the actual code changes. The PR description must accurately represent what the diff contains—nothing more, nothing less.

1. **Generate expected content**: Use the [pr-template skill](../pr-template/SKILL.md) to determine what the title and body _should_ be based on the current branch state (don't edit the PR yet). Base this strictly on the diff and commit history from Step 1.

2. **Compare title**: If the generated title differs meaningfully from the current PR title, mark as "needs update"

3. **Compare body**: If the generated body differs meaningfully from the current PR body (e.g., missing recent changes, outdated summary), mark as "needs update"

**Decision**: If either title or body needs update, proceed to Step 4. Otherwise, stop here—the PR is already accurate.

### Step 4: Update PR

Apply the updated title and body using the [pr-template skill](../pr-template/SKILL.md) for formatting:

```bash
gh pr edit <pr-number> --title "<new-title>" --body "<new-body>"
```

Inform the user what was updated (title, body, or both).
