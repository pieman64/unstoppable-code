---
name: handle-pr-checks
description: >-
  {% if claude %}/builtin-gh:handle-pr-checks{% else %}$builtin-gh:handle-pr-checks{% endif %} only. Examine and address failing CI checks on current PR
---

# Handle PR Checks

The user wants to examine and address CI check failures on the pull request for the current branch.

Parse the arguments from "the user request" to check for:

- **--auto**: Autonomous mode - skip fix summary confirmation and proceed directly to applying fixes. Still stops for genuinely undiagnosable or catastrophic failures. Intended for orchestration by other automation commands.

## Instructions

### Step 1: Output Arguments Summary

Display the provided arguments and summarize how they will be handled:

**Arguments received**: `the user request`

- **If `--auto` is provided**: Fix summary confirmation will be skipped and actionable fixes will be applied immediately. Ambiguous failures will be handled with best judgment. Stops only for genuinely undiagnosable or catastrophic failures.
- **If no arguments are provided**: All failing checks will be analyzed and actionable fixes will be implemented and committed to the current branch

Example output:

> **Arguments**: `--auto`
>
> - Auto mode: Yes
> - Will analyze failing CI checks on the current PR and apply actionable fixes immediately

### Step 2: Get PR Information and Check Status

1. Get the current branch name
2. Fetch the PR for this branch using `gh pr view --json number,headRefName,url`
3. Fetch all check runs for the PR using:
   ```bash
   gh pr checks --json name,state,description,link,workflow
   ```

### Step 3: Summarize Check Status

Present a summary table of all checks:

| Check        | Status          | Description         |
| ------------ | --------------- | ------------------- |
| _Check name_ | _icon + status_ | _Brief description_ |

**Status icons:**

- **Passed**: :white_check_mark: `success`
- **Failed**: :x: `failure`
- **Running**: :hourglass: `pending` or `in_progress`
- **Neutral/Skipped**: :white_circle: `neutral`, `skipped`, or `cancelled`

**Example output:**

| Check     | Status                     | Description                      |
| --------- | -------------------------- | -------------------------------- |
| lint      | :white_check_mark: success | ESLint checks passed             |
| test      | :x: failure                | 3 tests failed                   |
| build     | :hourglass: pending        | Build in progress                |
| typecheck | :white_check_mark: success | TypeScript compilation succeeded |

> **Summary**: 2 passed, 1 failed, 1 running

### Step 4: Analyze Failed Checks

For each failed check:

1. **Fetch detailed logs** using the check's details URL or via GitHub API:

   ```bash
   gh api repos/{owner}/{repo}/actions/runs/{run_id}/jobs
   ```

2. **For checks with distinct steps** (e.g., GitHub Actions workflows, cloud builds):
   - List each step with its status and duration
   - Identify the specific step(s) that failed

   **Example step breakdown:**

   | Step                 | Status                 | Duration |
   | -------------------- | ---------------------- | -------- |
   | Checkout             | :white_check_mark:     | 2s       |
   | Install dependencies | :white_check_mark:     | 45s      |
   | Run linter           | :white_check_mark:     | 12s      |
   | Run tests            | :x:                    | 38s      |
   | Upload coverage      | :white_circle: skipped | -        |

3. **Examine log output** for the failed step(s):

   ```bash
   gh api repos/{owner}/{repo}/actions/jobs/{job_id}/logs
   ```

   Or use the run logs endpoint:

   ```bash
   gh run view {run_id} --log-failed
   ```

4. **Categorize the failure**:
   - **Linting errors**: ESLint, Prettier, or other code style issues
   - **Test failures**: Unit tests, integration tests, or e2e tests failing
   - **Type errors**: TypeScript compilation errors
   - **Build errors**: Compilation or bundling failures
   - **Syntax errors**: Parse errors in code
   - **Environment issues**: Missing dependencies, configuration problems
   - **Flaky/Infrastructure**: Timeouts, network issues, resource constraints (not actionable in code)

### Step 5: Present Analysis and Proposed Fixes

For each failed check, present:

| Failure             | Type       | Actionable | Proposed Fix     |
| ------------------- | ---------- | ---------- | ---------------- |
| _Brief description_ | _Category_ | _Yes/No_   | _Summary of fix_ |

**Guidelines:**

- **Actionable** means the fix can be made in the codebase (code changes, config updates)
- **Non-actionable** failures include: flaky tests due to infrastructure, rate limits, timeouts, external service issues
- For non-actionable failures, suggest potential workarounds or recommend re-running the check

**Example output:**

| Failure                                             | Type         | Actionable | Proposed Fix                               |
| --------------------------------------------------- | ------------ | ---------- | ------------------------------------------ |
| `'user' is defined but never used`                  | Lint error   | Yes        | Remove unused variable on line 42          |
| `Expected 3 but received 2` in `test/utils.test.ts` | Test failure | Yes        | Fix off-by-one error in `calculateTotal()` |
| `Cannot find module '@/types'`                      | Build error  | Yes        | Update import path to use relative path    |
| `ETIMEDOUT connecting to npm registry`              | Environment  | No         | Re-run workflow - network issue            |

**Detailed analysis for each actionable failure:**

For each actionable failure, provide:

1. **File and location**: The specific file(s) and line number(s) affected
2. **Error message**: The exact error from the logs
3. **Root cause**: What's causing the failure
4. **Proposed solution**: Specific code changes to fix the issue

### Step 6: Handle Failures

For each actionable failure:

1. **Make the necessary code changes** to fix the issue
2. **Track the changes** for the commit message

After fixing all actionable failures, **verify the changes**:

1. **Discover project configuration**:
   - Check CLAUDE.md and README.md for documented lint/test/build commands
   - Check for project configuration files (`package.json`, `pyproject.toml`, `Makefile`, etc.)
   - Identify available lint, type-check, and test scripts defined by the project

2. **Run linting** on modified files using the project's configured linter:
   - Use the project's lint script if available
   - Target only the modified files when possible

3. **Run language-specific compile/transpile checks**:
   - TypeScript: Run type checking (e.g., `tsc --noEmit` or project's typecheck script)
   - Go: Run `go build` or `go vet`
   - Rust: Run `cargo check`
   - Other compiled languages: Run the appropriate compile/check command
   - Skip if the project doesn't use a compiled/transpiled language

4. **Run tests** related to the modified files:
   - Look for test files that correspond to the modified files
   - Use the project's test script, targeting specific files when supported
   - If targeted tests aren't feasible, run the full test suite

5. **If any checks fail**:
   - Attempt to fix linting and type errors automatically if possible
   - For test failures, analyze the failure and fix the code
   - **If `--auto` is NOT enabled**: If fixes require significant changes, ask the user how to proceed
   - **If `--auto` IS enabled**: Proceed with the most reasonable fix. Stop only if the failure is genuinely undiagnosable (e.g., no clear error message, infrastructure-level issue with no code fix).

**For ambiguous failures:**

- **If `--auto` is NOT enabled**: Present the failure details to the user, ask for clarification on how to proceed, and wait for user input before making changes
- **If `--auto` IS enabled**: Use best judgment to determine the most likely fix. If the failure is genuinely undiagnosable (no clear error message, infrastructure-level issue with no code fix), treat it as `blocked` and escalate — stop execution and report the failure so the caller can decide how to proceed.

**For non-actionable failures (flaky/infrastructure):**

- **If `--auto` is NOT enabled**: Skip and note in the summary that these require manual intervention or re-running.
- **If `--auto` IS enabled**: Treat as `blocked` and escalate — infrastructure failures cannot be resolved in code, so stop and report rather than silently skipping. The orchestrating command will decide whether to retry or ask the user.

### Step 7: Commit and Push

After fixing all actionable failures:

1. Stage all changes: `git add -A`
2. Create a commit with a descriptive message:
   - Subject line (max 83 chars): `fix: Address CI check failures`
   - Body: List each fix made
3. Push to the remote branch

**Example commit message:**

```
fix: Address CI check failures

- Remove unused variable in src/handlers/auth.ts
- Fix test assertion in test/utils.test.ts
- Update import path in src/index.ts
```

If no changes were made, skip this step and inform the user.

### Step 8: Verify and Report

After handling the checks:

1. **Check if workflows will re-run** automatically, when changes were pushed
2. **Provide a summary** of actions taken

**Example:**

> **Summary:**
>
> - Fixed 3 issues across 3 files
> - Committed and pushed changes
> - CI checks will re-run automatically
>
> **Non-actionable failures** (require manual attention):
>
> - Network timeout in `deploy` job - recommend re-running workflow

## Notes

- Use `gh pr checks` to get the current check status for a PR
- Use `gh run view {run_id}` to see details of a specific workflow run
- Use `gh run view {run_id} --log-failed` to see logs for failed steps only
- Use `gh api repos/{owner}/{repo}/actions/runs/{run_id}/jobs` to get job details
- Check annotations via `gh api repos/{owner}/{repo}/check-runs/{check_run_id}/annotations` for inline error locations
- Some checks may be from external CI systems (CircleCI, Jenkins, etc.) - these may require fetching logs differently
- Always preserve the original intent of the code when making fixes
