---
name: handle-merge-conflicts
description: >-
  {% if claude %}/builtin-gh:handle-merge-conflicts{% else %}$builtin-gh:handle-merge-conflicts{% endif %} only. Resolve merge conflicts with the base branch
---

# Handle Merge Conflicts

The user wants to resolve merge conflicts with the base branch.

Parse the arguments from "the user request" to check for:

- **--push**: After resolving all conflicts, commit and push the changes

## Instructions

### Step 1: Output Arguments Summary

Display the provided arguments and summarize how they will be handled:

**Arguments received**: `the user request`

- **If `--push` is provided**: After resolving conflicts, changes will be committed and pushed
- **If no arguments are provided**: Conflicts will be resolved but not committed or pushed

### Step 2: Check for Merge in Progress

Check if there is already a merge in progress:

```bash
git rev-parse -q --verify MERGE_HEAD
```

#### If merge is in progress:

1. **Determine the base branch** (needed for prompts and summaries):
   - Check for an open PR: `gh pr view --json baseRefName --jq '.baseRefName'`
   - If no PR exists, use the default branch: `gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'`
   - Alternatively, inspect `MERGE_HEAD` to identify the incoming branch
2. List files with unresolved conflicts:
   ```bash
   git diff --name-only --diff-filter=U
   ```
3. Skip to **Step 4: Resolve Conflicts**

#### If no merge is in progress:

Continue to **Step 3: Determine Base Branch and Merge**

### Step 3: Determine Base Branch and Merge

1. **Get the current branch name**:

   ```bash
   git branch --show-current
   ```

2. **Check for an open PR** to determine the base branch:

   ```bash
   gh pr view --json baseRefName --jq '.baseRefName'
   ```

3. **Determine the base branch**:
   - **If an open PR exists**: Use the PR's base branch (e.g., `main`, `develop`)
   - **If no open PR exists**: Use the repository's default branch and inform the user:
     ```bash
     gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'
     ```
     > **Note**: No open PR found for this branch. Using the default branch `<default-branch>` as the base.

4. **Fetch the latest changes** from the base branch:

   ```bash
   git fetch origin <base-branch>
   ```

5. **Merge the base branch** into the current branch:

   ```bash
   git merge origin/<base-branch>
   ```

6. **Check for conflicts**:
   - If the merge completes without conflicts:

     > **No conflicts detected.** The branch is now up to date with `<base-branch>`.

     Then proceed to **Step 7: Finalize Merge** to honor `--push` if provided.

   - If conflicts are detected, continue to **Step 4: Resolve Conflicts**

### Step 4: Resolve Conflicts

1. **List all files with conflicts**:

   ```bash
   git diff --name-only --diff-filter=U
   ```

2. **For each conflicted file**, read the file and analyze the conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`).

3. **Evaluate each conflict** and determine the best resolution:

   **Favor the current branch (HEAD) when:**
   - The changes in the current branch clearly replace or update the conflicted content
   - The current branch contains new features or intentional modifications to the specific code section

   **Favor the base branch when:**
   - The base branch changes appear to be bug fixes or updates unrelated to the current branch's purpose
   - The current branch didn't intentionally modify this section

   **Blend changes together when:**
   - Both branches made independent, non-overlapping changes to the same area
   - The changes can coexist (e.g., different imports, different function additions)

   **Ask the user when:**
   - The intent of either change is unclear
   - Both branches made conflicting changes to the same logic
   - The resolution could significantly impact functionality

4. **For ambiguous conflicts**, use `AskUserQuestion` to provide options:

   Example:

   ```
   Question: "How should we resolve the conflict in `src/utils/helper.ts` (lines 45-60)?"
   Options:
   - "Keep current branch changes (your feature updates)"
   - "Keep base branch changes (upstream bug fix)"
   - "Blend both changes together"
   - "Skip - I'll resolve this manually"
   ```

5. **Track resolutions**:
   - Keep a list of files resolved automatically
   - Keep a list of files the user chose to handle manually
   - Keep a list of files where changes were blended

### Step 5: Apply Resolutions

For each conflict that was resolved (not skipped):

1. **Edit the file** to remove conflict markers and apply the chosen resolution
2. **Stage the resolved file**:
   ```bash
   git add <file>
   ```

### Step 6: Verify Resolved Files

After applying resolutions, run relevant checks on the affected files:

1. **Discover project configuration**:
   - Check CLAUDE.md and README.md for documented lint/test/build commands
   - Check for project configuration files (`package.json`, `pyproject.toml`, `Makefile`, etc.)
   - Identify available lint, type-check, and test scripts defined by the project

2. **Run linting** on resolved files using the project's configured linter:
   - Use the project's lint script if available
   - Target only the resolved files when possible

3. **Run language-specific compile/transpile checks**:
   - TypeScript: Run type checking (e.g., `tsc --noEmit` or project's typecheck script)
   - Go: Run `go build` or `go vet`
   - Rust: Run `cargo check`
   - Other compiled languages: Run the appropriate compile/check command
   - Skip if the project doesn't use a compiled/transpiled language

4. **Run tests** related to the resolved files:
   - Look for test files that correspond to the modified files
   - Use the project's test script, targeting specific files when supported
   - If targeted tests aren't feasible, run the full test suite

5. **If any checks fail**:
   - Attempt to fix linting and type errors automatically if possible
   - For test failures, analyze the failure and fix the resolved code
   - If fixes require significant changes, ask the user how to proceed

6. **Re-stage any additional fixes**:
   ```bash
   git add <fixed-files>
   ```

### Step 7: Finalize Merge

After all conflicts have been addressed:

1. **Check if any files were skipped** (user chose to handle manually)

#### If files were skipped:

Inform the user and do NOT proceed with commit/push, even if `--push` was provided:

> **Some conflicts require manual resolution:**
>
> - `<file1>`
> - `<file2>`
>
> After resolving these files manually, complete the merge with `git commit --no-edit` and then push, or re-run `{% if claude %}/builtin-gh:handle-merge-conflicts{% else %}$builtin-gh:handle-merge-conflicts{% endif %} --push` to verify and commit.

#### If all conflicts were resolved:

1. **Complete the merge commit**:

   ```bash
   git commit --no-edit
   ```

   This uses the auto-generated merge commit message.

2. **If `--push` was provided**, push the changes:

   Follow the same approach as `{% if claude %}/builtin-gh:push-branch{% else %}$builtin-gh:push-branch{% endif %}`:
   1. Push to remote (handle missing upstream):

      ```bash
      git push -u origin HEAD
      ```

   2. Check if there is an open PR for this branch using explicit, supported `gh pr view` JSON fields:
      ```bash
      gh pr view --json url,title,body --jq '{url: .url, title: .title, body: .body}'
      ```
      Do not include `repository` in the `--json` field list. This GitHub CLI version does not expose a bare `repository` field for `gh pr view`. If a PR exists, review whether the title and description accurately reflect the current state of the branch. If either is outdated, update them using `gh pr edit`.

3. **Provide a summary**:

   > **Merge completed successfully.**
   >
   > **Resolved conflicts:**
   >
   > - `<file1>` - Kept current branch changes
   > - `<file2>` - Kept base branch changes
   > - `<file3>` - Blended changes from both branches
   >
   > **Status**: Committed and pushed to remote (or "Ready to push - run `{% if claude %}/builtin-gh:push-branch{% else %}$builtin-gh:push-branch{% endif %}` when ready")

## Notes

- Use `git diff --name-only --diff-filter=U` to list files with unresolved conflicts
- Conflict markers follow the format:
  ```
  <<<<<<< HEAD
  (current branch changes)
  =======
  (incoming branch changes)
  >>>>>>> origin/<base-branch>
  ```
- When blending changes, ensure the resulting code is syntactically valid
- Always preserve the intent of both branches when possible
- If a file has multiple conflict sections, resolve each section independently
- Use `git merge --abort` if you need to cancel a merge in progress
