---
name: branch-naming
description: >-
  Branch naming conventions for git operations. Apply when creating branches
  (git checkout -b, git branch, git switch -c), renaming branches (git branch -m),
  or suggesting branch names. Uses configured Git preferences first, then falls
  back to ticket-based and date-based formats.
user-invocable: false
---

# Branch Naming Conventions

Apply these conventions when creating or renaming git branches.

## Git Preferences

Before choosing a branch name, call the `GetGitPreferences` tool with:

```json
{ "type": "branch-name" }
```

If the tool returns precise branch naming preferences, follow them first. If the
result says `Prefix the branch with <value>/`, use that exact prefix, including
the trailing slash, and apply the fallback format rules only to the rest of the
branch name. If the tool is unavailable, returns no precise branch naming
preferences, or only returns general guidance that does not decide the format,
fall back to the decision algorithm below.

## Decision Algorithm

1. **Did `GetGitPreferences` provide a precise format?** → Use it
2. **Did `GetGitPreferences` provide only a precise prefix?** → Use that prefix and continue with the remaining steps
3. **Is there a ticket from the user's ticketing system (for example, Linear)?** → Use ticket format
4. **Otherwise** → Use date format

## With Ticket (Preferred)

If a ticket from the user's ticketing system (for example, Linear) is associated
with the work, use this format:

```
<user>/<ticket>-<description>
```

- `<user>` is the current GitHub username (from `gh api user --jq '.login'`)
- `<ticket>` is the ticket identifier (lowercase, preserving the ticketing
  system's key style)
- `<description>` is a brief, hyphenated description of the work

### Examples

- `tirish/api-1234-new-admin-routes`
- `anhan-blip/ecw-4567-cart-ui-fixes`
- `sudoryan/reg-890-fix-blockchain-action`

## Without Ticket

Use the date-based format:

```
<user>/YYYY-MM-DD-<description>
```

- `<user>` is the current GitHub username (from `gh api user --jq '.login'`)
- `YYYY-MM-DD` is today's date
- `<description>` is a brief, hyphenated description of the work

### Description Rules

1. Convert to lowercase
2. Replace spaces, underscores, dots, and special characters with hyphens
3. Remove consecutive hyphens
4. Remove leading/trailing hyphens
5. If the description exceeds 50 characters, summarize or truncate it intelligently to stay under 50 chars

### Examples

- Input: `Add user authentication feature` → `tirish/2026-01-26-add-user-auth`
- Input: `fix bug` → `tirish/2026-01-26-fix-bug`
- Input: `Update the branch naming skill` → `tirish/2026-01-26-branch-naming`
