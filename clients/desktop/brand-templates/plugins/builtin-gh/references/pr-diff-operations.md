# PR Diff Operations

Standard operations for comparing branch changes against the base branch.

## Fetching and Comparing

Before comparing your branch to the base branch, always fetch the latest to ensure accurate diffs.

### Step 1: Get the Default Branch

```bash
gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'
```

### Step 2: Fetch Latest Base Branch

```bash
git fetch origin <default-branch>
```

This ensures your local reference to the base branch is up-to-date, which is critical for accurate diff comparisons.

### Step 3: Get Commit History

```bash
git log origin/<default-branch>..HEAD --oneline
```

### Step 4: Get Diff Summary

```bash
git diff origin/<default-branch>...HEAD --stat
```

### Step 5: Get Full Diff (when needed)

```bash
git diff origin/<default-branch>...HEAD
```

## Important Notes

- Always use `origin/<default-branch>` (not just `<default-branch>`) after fetching to compare against the remote state
- The three-dot syntax (`...`) shows changes since the branches diverged
- Fetching ensures you're comparing against what will actually be merged into, not a potentially stale local copy
