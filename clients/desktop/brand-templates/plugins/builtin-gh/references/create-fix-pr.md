# Create Fix PR

Standard workflow for creating a new PR with fixes that targets an existing feature branch.

Use this workflow when the `--new-pr` flag is provided to commands like `handle-pr-comments` or `handle-pr-checks`.

## Prerequisites

Before starting, gather:

- **Current branch name** - will be the base branch for the new PR
- **Current PR number and URL** - for reference in the new PR description
- **Fix type** - e.g., "review-fixes", "ci-fixes" (used in branch naming)
- **Commit message** - describing the changes made

## Steps

### Step 1: Detect Worktree Usage

Check if the current directory is a git worktree:

```bash
git rev-parse --git-common-dir
```

If the output differs from `.git`, you're in a worktree.

### Step 2: Create New Branch

**Branch naming**: `<current-branch>-<fix-type>-<short-hash>`

- `<short-hash>` is the first 7 characters of a timestamp or random identifier
- **Important**: If the original branch contains a ticketing-system ticket (for example, a Linear-style `tirish/api-1234-something`), preserve the ticket in the new branch name (e.g., `tirish/api-1234-something-ci-fixes-a1b2c3d`)

#### If using worktrees:

1. Construct the branch name as described above
2. Derive worktree path in a sibling `worktrees` directory:
   - Example: `<repo-root>/../worktrees/<sanitized-branch-name>`
3. **Sanitize the branch name** by replacing `/` with `-` (e.g., `feature/foo` → `feature-foo`)
4. Create the worktree and branch:
   ```bash
   git worktree add -b <new-branch-name> <worktree-path> HEAD
   ```

#### If NOT using worktrees:

Create and checkout a new branch:

```bash
git checkout -b <current-branch>-<fix-type>-<short-hash>
```

### Step 3: Stage and Commit

```bash
git add -A
git commit -m "<commit-message>"
```

### Step 4: Push New Branch

```bash
git push -u origin <new-branch-name>
```

### Step 5: Create PR

Follow the [PR Diff Operations](./pr-diff-operations.md) to fetch the latest base branch before creating the PR.

Then create the PR targeting the original branch:

1. **Extract ticket number** from the original PR title if present (e.g., `[API-1234]` from `[API-1234] feat: Add feature`)
2. **Follow the [pr-template skill](../skills/pr-template/SKILL.md)** for PR body formatting
3. **Title format**: `[TICKET] fix: <description>` (use `[no-ticket]` if no ticket in original)
4. **Include reference** to the original PR in the body (e.g., "Addresses review comments in #123")

```bash
gh pr create --base <original-branch> --title "<title>" --body "<body>"
```

### Step 6: Output Result

Return the new PR URL so the user can review and merge it.

## Example Branch Names

| Original Branch               | Fix Type     | Result                                         |
| ----------------------------- | ------------ | ---------------------------------------------- |
| `feature/add-auth`            | review-fixes | `feature/add-auth-review-fixes-a1b2c3d`        |
| `tirish/api-updates`          | ci-fixes     | `tirish/api-updates-ci-fixes-f8e9d0c`          |
| `tirish/api-1234-add-feature` | ci-fixes     | `tirish/api-1234-add-feature-ci-fixes-b3c4d5e` |
