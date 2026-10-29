---
name: handle-dependabot
description: >-
  {% if claude %}/builtin-gh:handle-dependabot{% else %}$builtin-gh:handle-dependabot{% endif %} only. Triage, fix CI, merge, and clean up alerts for open Dependabot PRs
---

# Handle Dependabot

The user wants to process open Dependabot pull requests for one or more repositories (assess safety, fix CI, obtain review approval, merge) and clean up stale Dependabot security alerts.

Parse the arguments from "the user request" to check for:

- **`[repository...]`** (optional, repeatable): One or more GitHub repositories in `owner/repo` format (e.g., `owner/repo-a`) or bare repo names. Bare repo names are resolved relative to the current repository owner when that owner can be detected. Multiple repositories can be specified separated by spaces. If omitted, detect the current repository automatically.
- **--dry-run**: Assess and report on all Dependabot PRs without making any changes (no CI triggers, no merges, no PR closures)
- **--limit N**: Only process the first N Dependabot PRs per repository (default: all)

Examples:

- `{% if claude %}/builtin-gh:handle-dependabot{% else %}$builtin-gh:handle-dependabot{% endif %}` — detect current repo
- `{% if claude %}/builtin-gh:handle-dependabot{% else %}$builtin-gh:handle-dependabot{% endif %} repo-a` — single repo under the current owner
- `{% if claude %}/builtin-gh:handle-dependabot{% else %}$builtin-gh:handle-dependabot{% endif %} repo-a repo-b repo-c` — multiple repos under the current owner
- `{% if claude %}/builtin-gh:handle-dependabot{% else %}$builtin-gh:handle-dependabot{% endif %} owner/repo1 owner/repo2 --dry-run --limit 5` — multiple repos with flags

## Instructions

### Step 0: Resolve Target Repositories

Parse `the user request` to build a list of target repositories. Any positional argument that is not a flag (`--dry-run`, `--limit`) and not the value consumed by `--limit` is treated as a repository identifier. Note that `--limit` consumes the next token as its numeric value — e.g., in `--limit 5 repo1`, `5` is the limit value (not a repository) and `repo1` is a repository.

For each repository identifier:

1. If it contains a `/` (e.g., `owner/repo-a`), use it as-is
2. If it's just a repo name (e.g., `repo-a`), detect the current repository owner with `gh repo view --json owner --jq '.owner.login'` and prefix it with that owner. If the owner cannot be detected, ask the user for the owner.

If **no repository arguments** were provided:

1. Detect from the git remote:
   ```bash
   gh repo view --json nameWithOwner --jq '.nameWithOwner'
   ```
2. If not inside a git repository, ask the user which repository/repositories to target.

Store the resolved list of `owner/repo` values.

### Step 0b: Output Arguments Summary

Display the provided arguments and summarize how they will be handled:

**Arguments received**: `the user request`

- **Repositories**: List all resolved repositories
- **If `--dry-run` is provided**: PRs will be assessed and a safety report generated, but no actions will be taken
- **If `--limit N` is provided**: Only the first N PRs per repository will be processed
- **If no flags are provided**: All open Dependabot PRs will be fully processed (CI fix, review, merge)

Example output:

> **Arguments**: `repo-a repo-b repo-c --limit 5`
>
> - Repositories: `owner/repo-a`, `owner/repo-b`, `owner/repo-c`
> - Dry run: No
> - Limit: 5 PRs per repository
> - Will process up to 5 open Dependabot PRs per repository end-to-end

### Step 0c: Per-Repository Processing — Two Phases

Processing is split into two phases to collect user input upfront, then maximize concurrency during the slow CI/merge work.

#### Phase 1: Triage (sequential, per repository)

For each repository **sequentially**, run all steps that require user interaction. This phase must be done one repo at a time so prompts don't interleave.

When starting each repository, display a clear header:

> ---
>
> ## Repository: `<repo>` (M of N)
>
> ---

Per repository, run:

1. **Steps 1–4**: Fetch PRs, assess safety, present report, get user feedback on which PRs to process/skip/close
2. **Step 8a** (fetch alerts), then **categorize only** using the logic from Steps 8b, 8c, and 8e-i — identify which alerts are dev-only transitive, which match closed PRs, which are runtime transitive, and which are other unmatched. **Do not call any dismiss API endpoints yet** — only build the categorized lists.
3. **Step 8d user confirmation (plan only)**: Present alerts matched to historically-closed PRs and get user confirmation on which alerts **should be dismissed later**. Record these decisions in the alert dismissal plan; **do not perform any dismiss API calls yet**.
4. **Step 8e-ii + 8e-iii (plan only)**: Present the runtime transitive alert triage table and get the user's intended dismiss/keep decisions. Record these decisions in the alert dismissal plan; **do not perform any dismiss API calls yet**.

After Phase 1 completes for all repositories, you have a fully confirmed action plan for every repo — both PR processing and alert dismissal decisions.

#### Phase 2: Execute (concurrent, all repositories)

Once all repositories have been triaged and the user has confirmed each action plan, process **all repositories concurrently** through the execution steps. Use the Agent tool to launch one subagent per repository so CI waits across repos overlap.

Each subagent receives:

- The repository's `owner/repo` identifier
- The confirmed list of PRs to process (with safety classifications and user overrides)
- The confirmed alert dismissal plan (which alerts to dismiss, with what reasons; which to leave open)
- The `--dry-run` and `--limit` flags

Each subagent executes:

- **Unsafe PR closure**: Close PRs that Phase 1 and Step 4 have already marked as unsafe (no additional user interaction)
- **Steps 4b–7**: Branch protection check, CI/review/merge pipeline for PRs confirmed as safe/processable
- **Steps 8b, 8d, 8e-iv**: Execute the pre-approved alert dismissals (dev-only transitive auto-dismiss, matched-to-PR dismissals, user-approved runtime transitive dismissals)

No subagent should prompt the user — all decisions were collected in Phase 1.

Track results from each subagent for the final cross-repository report in Step 9.

**Single-repository optimization**: When only one repository is being processed, skip the two-phase split — run Steps 1–8 inline without subagents.

### Step 1: Fetch Open Dependabot PRs

List all open PRs authored by Dependabot:

```bash
gh pr list --repo <repo> --author "app/dependabot" --state open --json number,title,url,headRefName,baseRefName,createdAt --limit 100
```

If no PRs are found, report that and skip ahead to Step 8 (alert cleanup) — there may still be stale alerts from previously closed Dependabot PRs that need dismissal. The `--dry-run` flag is respected in Step 8 as well.

If `--limit N` was provided, take only the first N results.

### Step 2: Assess Safety of Each Update

For each Dependabot PR, determine whether the dependency update is safe to merge:

1. **Read the PR description** to identify the dependency name, version change (from → to), and changelog/release notes:

   ```bash
   gh pr view <number> --repo <repo> --json body,title
   ```

2. **Evaluate safety** based on these criteria:
   - **Safe** — Patch or minor version bumps of well-known, actively maintained packages with no breaking changes noted
   - **Needs review** — Major version bumps, packages with known breaking change history, or security-related updates that may change behavior
   - **Unsafe** — Updates to deprecated packages, packages with known compatibility issues with the project, or changes that clearly conflict with the project's dependency constraints

3. **Record the safety assessment** for each PR. Do NOT close any PRs yet — the user will review the assessments first in Step 4.

### Step 3: Present Safety Report

Display a summary table of all Dependabot PRs:

| PR   | Dependency     | Version Change    | Safety          | Action                    |
| ---- | -------------- | ----------------- | --------------- | ------------------------- |
| #123 | lodash         | 4.17.20 → 4.17.21 | ✅ Safe         | Will process              |
| #124 | webpack        | 4.x → 5.x         | ⚠️ Needs review | Will process with caution |
| #125 | deprecated-pkg | 1.0 → 2.0         | ❌ Unsafe       | Will close with comment   |

Sort the table by safety: ✅ Safe first, then ⚠️ Needs review, then ❌ Unsafe, so the user can quickly scan the riskiest items at the bottom.

If `--dry-run` is enabled, stop here after presenting the report.

### Step 4: Wait for User Feedback

After presenting the safety report, **pause and wait for the user to confirm** before taking any action.

**Note**: "Needs review" PRs are processed through the same CI/review/merge pipeline as "Safe" PRs unless the user says otherwise. The distinction exists so the user can make informed decisions here — they may choose to skip, reclassify, or approve these PRs with full awareness of the risk.

The user may:

- **Approve all** — proceed with the planned actions as-is
- **Skip specific PRs** — the user can list PR numbers to skip (e.g., "skip #124 and #125"). Mark those PRs as skipped and exclude them from all subsequent steps
- **Override safety assessments** — the user can reclassify a PR (e.g., "actually #124 is safe, go ahead" or "close #123 too, we don't want that update")
- **Adjust scope** — the user may ask to process only a subset (e.g., "just do the patch updates for now")

Incorporate the user's feedback into the action plan. Then re-display the updated table reflecting any changes before proceeding:

| PR   | Dependency     | Version Change    | Safety          | Action                  |
| ---- | -------------- | ----------------- | --------------- | ----------------------- |
| #123 | lodash         | 4.17.20 → 4.17.21 | ✅ Safe         | Will process            |
| #124 | webpack        | 4.x → 5.x         | ⚠️ Needs review | **Skipped by user**     |
| #125 | deprecated-pkg | 1.0 → 2.0         | ❌ Unsafe       | Will close with comment |

Only after the user confirms the updated plan should you proceed.

After confirmation, **close PRs marked as unsafe** with a comment explaining why:

```bash
gh pr close <number> --repo <repo> --comment "Closing: <reason why this update is not safe>"
```

Then continue to CI processing for the remaining PRs.

### Step 4b: Check Branch Protection Rules

Before processing PRs, determine whether the repository requires branches to be up to date with the base branch before merging.

Use the `baseRefName` from the Dependabot PRs fetched in Step 1 as `<base-branch>` (typically `main` or `master` — Dependabot PRs in a repository usually all target the same base branch):

```bash
gh api repos/<repo>/branches/<base-branch>/protection/required_status_checks --jq '.strict'
```

- If the command succeeds and `strict` is `true`, set `requires-up-to-date-branch = true`
- If the command succeeds and `strict` is `false`, set `requires-up-to-date-branch = false`
- If the API returns a `404 Not Found` (no branch protection configured), set `requires-up-to-date-branch = false`
- If the API returns any other error (e.g., authentication or network failures), surface the error to the user before proceeding

This flag is used in Step 6 to avoid unnecessary branch updates.

### Step 5: Process PRs Through CI, Review, and Merge

Steps 5–7 describe the per-PR pipeline. Since most time is spent waiting for CI and reviews, **process up to 5 PRs concurrently** to maximize throughput.

#### Concurrency model — sliding window

Maintain a **sliding window** of up to 5 in-flight PRs at all times:

1. **Initialize**: Start the first 5 (or fewer) queued PRs through the pipeline (Steps 5a–5b)
2. **Poll loop**: Continuously rotate through all in-flight PRs, checking status and advancing each one to its next stage
3. **Backfill immediately**: As soon as any PR completes (merged, skipped, or closed), dequeue the next pending PR and start it — do **not** wait for the other in-flight PRs to finish
4. **Track stages**: Each PR tracks its current stage (CI triggered + review requested → CI waiting / review waiting → branch update → merge) so you can resume where you left off
5. **Polling interval**: ~60 seconds between checks on the same PR
6. **Goal**: Keep close to 5 PRs in flight at all times until the queue is empty

**Important**: This is NOT batch processing. Do not wait for all 5 to finish before starting the next batch. The moment one slot frees up, fill it.

#### 5a: Check current CI status

For each PR:

```bash
gh pr checks <number> --repo <repo> --json name,state
```

#### 5b: Trigger CI

Dependabot PRs fail CI out of the box because the Dependabot bot does not have access to repository secrets. You need to trigger CI under the user's account.

Try updating from the base branch first:

```bash
gh pr update-branch <number> --repo <repo>
```

**If the update fails due to merge conflicts** (commonly in lock files like `yarn.lock`, `package-lock.json`, or `pnpm-lock.yaml`):

1. Check out the branch and merge the base branch manually:
   ```bash
   git fetch origin
   git checkout <head-ref-name>
   git merge origin/<base-ref-name>
   ```
2. For **lock file conflicts**, resolve by accepting one side and regenerating:
   ```bash
   git checkout --theirs <lock-file-name>
   ```
   Then regenerate the lock file with the appropriate package manager:
   - **yarn**: `yarn install` to regenerate `yarn.lock`
   - **npm**: `npm install` to regenerate `package-lock.json`
   - **pnpm**: `pnpm install` to regenerate `pnpm-lock.yaml`
3. If merge conflicts occur in **non-lock files** (e.g., `package.json` or configuration files), resolve them with project-specific knowledge. If the conflicts are too complex to resolve automatically, close the PR with a comment and move on.
4. Stage, commit, and push:
   ```bash
   git add .
   git commit -m "chore: resolve merge conflicts with <base-ref-name>"
   git push origin <head-ref-name>
   git checkout -
   ```
5. Do **not** skip a PR just because of a lock file merge conflict — these are always resolvable by regenerating the lock file.

If the branch is already up to date (no update needed, no conflicts), push an empty commit instead:

```bash
git fetch origin <head-ref-name>
git checkout <head-ref-name>
git commit --allow-empty -m "chore: trigger CI"
git push origin <head-ref-name>
git checkout -
```

**Repository-specific CI triggers**: If the repository documents a manual CI trigger comment or workflow dispatch command, use that documented trigger when normal branch update and close/reopen approaches do not start CI. Do not assume a repository-specific trigger unless it is documented in the repository or PR.

After triggering CI, immediately approve the PR (Step 5c) so both run in parallel.

#### 5c: Approve PR (in parallel with CI)

Since dependabot PRs are opened by the bot (not by you), you are a legitimate non-author approver. Approve the PR directly.

> **Note:** This uses direct `gh pr review --approve` instead of the AI review flow. This is intentional — Dependabot PRs are automated dependency updates with a well-defined scope (version bumps). The human operator has already triaged the alert, verified CI passes, and reviewed the changelog. Running a full AI code review adds cost without meaningful signal for these changes.

```bash
gh pr review <number> --repo <repo> --approve --body "Approved: dependency update reviewed by human operator."
```

#### 5d: Wait for CI to complete

**CI status:**

```bash
gh pr checks <number> --repo <repo> --json name,state
```

CI runs can take 10+ minutes (sometimes 20–30 minutes) — be patient and do not give up. While waiting for one PR, check on other in-flight PRs and advance any that are ready.

A PR is ready to advance to Step 6 (branch update) when CI passes.

#### 5e: Handle CI failures

If CI fails, first determine the **type** of failure:

1. **Fetch the failure logs**:

   ```bash
   gh pr checks <number> --repo <repo> --json name,state,link
   ```

2. **Classify the failure**:
   - **Breaking changes from the dependency** — Build errors, TypeScript compilation failures, incompatible API changes, or other errors directly caused by the updated package's new version (e.g., removed exports, changed type signatures, renamed APIs)
   - **Transient / CI infrastructure issues** — Flaky tests, secret access errors, network timeouts, runner failures, or other issues unrelated to the dependency update itself

3. **If breaking changes from the dependency**:
   - Close the PR with a comment explaining the issue:
     ```bash
     gh pr close <number> --repo <repo> --comment "Closing: this dependency update introduces breaking changes that cannot be automatically resolved. <describe the specific build/type errors>. Manual intervention is required to upgrade this package."
     ```
   - Note it in the final report and move on immediately — do not retry

4. **If transient / CI infrastructure issues**:
   - Analyze the failure and attempt to fix it:
     - Check out the branch, make the fix, commit, and push
     - Wait for CI to re-run
   - If the failure cannot be resolved after 5 attempts, skip this PR and note it in the final report

When a PR passes CI, advance it to Step 5f (if review requested changes) or Step 6 (if both CI and review are green).

#### 5f: Handle AI review feedback

If the AI review requests changes (while CI may still be running or already passed):

1. Read **both inline code comments and general PR comments** (reviews may leave feedback in either form):
   ```bash
   # Inline code comments (attached to specific lines)
   gh api repos/<repo>/pulls/<number>/comments --jq '.[] | {id, body, path, line, user: .user.login}'
   # General PR comments (not attached to code)
   gh pr view <number> --repo <repo> --json comments --jq '.comments[] | {body, author: .author.login}'
   ```
2. Address each comment by making the necessary code changes
3. **Important**: Dependabot PRs typically only touch `package.json` and lock files. If the AI review requests changes to application code beyond the package manifests (e.g., updating import paths or fixing type errors from a breaking API change), close the PR with a comment explaining the issue and note it in the final report:
   ```bash
   gh pr close <number> --repo <repo> --comment "Closing: this dependency update requires application code changes beyond package manifests (e.g., <describe the specific issues>). Manual intervention is required."
   ```
4. Commit and push the fixes
5. Re-run the repository's configured review workflow if one is documented
6. Wait for the new review (and CI re-run if the push triggered one) — repeat until approved (up to 3 iterations)
7. If not approved after 3 iterations, skip this PR and note it in the final report

When **both** CI is green and the AI review is approved, advance to Step 6.

### Step 6: Ensure Branch Is Up to Date (conditional)

**Only perform this step if `requires-up-to-date-branch` is `true`** (determined in Step 4b). If `false`, skip directly to Step 7.

Some repositories require the PR branch to be up to date with the base branch before merging is allowed. When required, ensure the branch is current before merging:

1. **Update the branch**:
   ```bash
   gh pr update-branch <number> --repo <repo>
   ```
2. **If the branch was updated**, CI will re-run. Wait for CI to pass again (same patience as Step 5 — this can take 10+ minutes).
3. **If the branch was already up to date**, proceed immediately.

### Step 7: Merge Approved PRs

Once a PR has passing CI and an approved review, choose the merge command for the repository. Do not hard-code a merge method: repositories differ, and a base branch that requires a merge queue rejects direct merges.

1. **Check for a merge queue** on the PR's base branch:

   ```bash
   gh api graphql \
     -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){isMergeQueueEnabled isInMergeQueue}}}' \
     -F o=<owner> -F r=<name> -F n=<number> \
     --jq '.data.repository.pullRequest'
   ```

   - If `isInMergeQueue` is `true`, the PR is already queued. Treat it as merged for this run and move on; GitHub merges it when the queue's checks pass.
   - If `isMergeQueueEnabled` is `true`, add the PR to the queue without a merge method flag. The queue's configuration decides how it lands:

     ```bash
     gh pr merge <number> --repo <repo>
     ```

     When the required checks have passed, `gh` adds the PR to the merge queue. When they are still running, `gh` enables auto-merge and GitHub queues the PR once they pass. Both are success. Do not pass `--admin`, which bypasses the queue.

2. **Otherwise, pick the repository's allowed method** in the order squash, merge, rebase:

   ```bash
   gh repo view <repo> --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed
   ```

   Use the first allowed method:

   ```bash
   gh pr merge <number> --repo <repo> --squash --auto   # squashMergeAllowed
   gh pr merge <number> --repo <repo> --merge --auto    # else mergeCommitAllowed
   gh pr merge <number> --repo <repo> --rebase --auto   # else rebaseMergeAllowed
   ```

An "already in the merge queue" or "already queued" response is success, not a failure. If the merge fails for another reason (e.g., branch not up to date, merge conflicts), attempt to resolve:

1. Update the branch from base:
   ```bash
   gh pr update-branch <number> --repo <repo>
   ```
2. If the update fails due to merge conflicts, resolve them using the same approach as Step 5b (check out branch, merge base, regenerate lock files if needed, push)
3. Wait for CI to pass again after the update (this can take 10+ minutes — be patient)
4. Retry the merge once CI is green
5. If conflicts persist or the merge still fails, close the PR with a comment explaining the issue and note it in the final report

### Step 8: Dismiss Dependabot Alerts

Whether all targeted Dependabot PRs have been processed or no open PRs were found (Step 1 skip), dismiss open Dependabot security alerts that have no path to resolution. This includes dev-only transitive dependencies, alerts matched to closed PRs from this run, alerts from previously closed Dependabot PRs, and runtime transitive dependencies with no available Dependabot fix. This cleans up stale alerts that would otherwise linger on the repository's Security tab indefinitely.

**Dry-run behavior**: If `--dry-run` is enabled, perform Steps 8a–8e (fetch alerts, categorize, match to PRs, triage unmatched transitive alerts) but **do not dismiss any alerts**. Instead, present the same report tables from Step 9 showing what _would_ be dismissed and why, then stop.

**Audit requirement**: Every alert dismissal **must** include a `dismissed_comment` explaining why the alert was dismissed. Anyone reviewing dismissed alerts on the Security tab should understand the rationale without needing additional context.

#### 8a: Fetch all open Dependabot alerts

Use `--paginate` to retrieve **all** open alerts (the API returns at most 100 per page, so repositories with many alerts require pagination):

```bash
gh api "/repos/<repo>/dependabot/alerts?state=open&per_page=100" --paginate \
  --jq '.[] | {number, package: .dependency.package.name, manifest: .dependency.manifest_path, severity: .security_vulnerability.severity, scope: .dependency.scope, relationship: .dependency.relationship, advisory_summary: .security_advisory.summary, html_url}'
```

If there are no open alerts, skip the rest of this step.

#### 8b: Auto-dismiss dev-only transitive alerts

Before matching alerts to PRs, filter out alerts that are **development-scoped transitive dependencies** (`scope: development` + `relationship: transitive`). These are sub-dependencies of dev toolchain packages (linters, test runners, build tools) that are never deployed to production and have no user-facing attack surface. Dependabot cannot create PRs for transitive dependencies, so these alerts would otherwise persist indefinitely.

For each matching alert, dismiss it immediately:

```bash
gh api --method PATCH "/repos/<repo>/dependabot/alerts/<alert_number>" \
  -f state=dismissed \
  -f dismissed_reason=not_used \
  -f dismissed_comment="Auto-dismissed: dev-only transitive dependency (<package>@<vulnerable_range> via <manifest>). Not reachable in production — only used in the development toolchain."
```

Remove dismissed alerts from the working set before proceeding to PR matching.

#### 8c: Match alerts to closed Dependabot PRs

For each open alert, determine whether a Dependabot PR for the same package exists and was **closed without merging** (i.e., the vulnerability was intentionally not fixed via that PR). Check both PRs closed during this run and historically closed PRs:

1. **PRs closed during this run** — you already have the dependency name and close reason for these. Match by package name against the alert's `.dependency.package.name`.

2. **Previously closed Dependabot PRs** — fetch closed Dependabot PRs and match any remaining unmatched alerts:
   ```bash
   gh pr list --repo <repo> --author "app/dependabot" --state closed --json number,title,mergedAt --limit 500
   ```
   Filter to PRs where `mergedAt` is empty (closed without merging — merged PRs should have already resolved the alert). Extract the package name from the title (`Bump <package> from ...`) and match against remaining open alerts. If the repository has more than 500 closed Dependabot PRs, paginate to fetch all of them.

#### 8d: Dismiss matched alerts

For each alert matched to a closed (unmerged) Dependabot PR, dismiss it:

```bash
gh api --method PATCH "/repos/<repo>/dependabot/alerts/<alert_number>" \
  -f state=dismissed \
  -f dismissed_reason=<reason> \
  -f dismissed_comment="Dismissed via automated Dependabot PR triage. Associated PR #<number> was closed without merging: <reason>"
```

**Choosing the dismiss reason:**

For PRs closed during this run, use the reason from the triage:

- **`tolerable_risk`** — PR was assessed as unsafe or the user chose to skip it
- **`fix_started`** — PR requires manual intervention (breaking changes, app code changes needed) and will be handled separately
- **`not_used`** — the vulnerable code is not actually used (e.g., dev-only transitive dependency)

For previously closed PRs where you don't have the original reason:

1. **Present these alerts to the user for confirmation** before dismissing. Show a table of alerts matched to historically-closed PRs with the PR number, title, and close date so the user can verify these were intentionally closed.
2. Once the user confirms, dismiss with **`tolerable_risk`** and a comment noting it was from a prior closure:

```bash
gh api --method PATCH "/repos/<repo>/dependabot/alerts/<alert_number>" \
  -f state=dismissed \
  -f dismissed_reason=tolerable_risk \
  -f dismissed_comment="Dismissed via automated Dependabot PR triage. Associated PR #<number> was previously closed without merging."
```

3. If the user declines to dismiss specific alerts, leave them open and note them in the final report.

#### 8e: Triage unmatched alerts (runtime transitive dependencies)

After Steps 8b–8d, any remaining open alerts have no associated Dependabot PR (open or closed). Sub-categorize these into two groups:

- **Runtime transitive alerts**: alerts where `relationship` is `transitive` AND `scope` is `runtime` (or `scope` is `null`/empty). Dependabot cannot create PRs for transitive dependencies, so these alerts have no automated fix path and will persist indefinitely unless manually addressed or dismissed.
- **Other unmatched alerts**: direct dependencies (`relationship: direct`) or other combinations where Dependabot _should_ have been able to create a PR but did not. These are unusual and should be surfaced for manual investigation in Step 9.

If there are no runtime transitive alerts, skip to reporting the "other unmatched" alerts in Step 9 and proceed.

##### 8e-i: Group runtime transitive alerts by package

Group the runtime transitive alerts by package name. For each package group, record:

- **Package name**
- **Highest severity** across all alerts in the group (Critical > High > Medium > Low)
- **Alert count** (number of individual alerts)
- **Advisory summary** (from any alert in the group — they typically share the same advisory)
- **Affected manifests** (deduplicated list of manifest paths)
- **Alert numbers** (list of all alert numbers, for use during dismissal)

##### 8e-ii: Present triage table to the user

Display the grouped runtime transitive alerts:

> **Runtime transitive alerts with no Dependabot fix available** (X alerts across Y packages):
>
> These are vulnerabilities in transitive (indirect) dependencies. Dependabot cannot create PRs for transitive dependencies, so the only resolution paths are: (a) waiting for the parent package to update its dependency tree, (b) overriding the transitive dependency version in your lock file, or (c) dismissing the alert as tolerable risk.

| #   | Package | Severity | Alerts | Advisory                                    | Affected Manifests                                                    |
| --- | ------- | -------- | ------ | ------------------------------------------- | --------------------------------------------------------------------- |
| 1   | ip      | High     | 12     | ip SSRF improper categorization in isPublic | `yarn.lock`, `examples/spa/yarn.lock`, `examples/web3modal/yarn.lock` |
| 2   | semver  | Medium   | 4      | semver vulnerable to ReDoS                  | `package-lock.json`, `examples/spa/yarn.lock`                         |

Sort the table by severity (Critical first, then High, Medium, Low), then by alert count descending within each severity tier.

##### 8e-iii: User decision

Ask the user how to proceed with the runtime transitive alerts:

> **How would you like to handle these runtime transitive alerts?**
>
> 1. **Dismiss all** — dismiss all N alerts as `tolerable_risk`
> 2. **Select packages to dismiss** — choose specific packages from the table (by number or name)
> 3. **Leave all open** — skip dismissal; all alerts will remain open and be noted in the final report

If the user selects option 2, ask them to specify which packages to dismiss (e.g., "dismiss 1 and 3" or "dismiss ip and tough-cookie"). Confirm their selection before proceeding.

**In dry-run mode**: Present the table but do not prompt for a decision. Instead, note: "In dry-run mode — no alerts will be dismissed. Re-run without `--dry-run` to interactively triage these alerts."

##### 8e-iv: Dismiss selected alerts

For each alert in the user-selected package groups, dismiss it:

```bash
gh api --method PATCH "/repos/<repo>/dependabot/alerts/<alert_number>" \
  -f state=dismissed \
  -f dismissed_reason=tolerable_risk \
  -f dismissed_comment="Dismissed: runtime transitive dependency with no automated Dependabot fix available. <package> is an indirect dependency appearing in <manifest_list>. Transitive dependency alerts can only be resolved by the parent package updating its dependency tree. Dismissed as tolerable risk per maintainer review during automated Dependabot triage."
```

The `dismissed_comment` must include:

- That it is a transitive dependency with no Dependabot fix available
- The package name and which manifests are affected
- That the dismissal was a deliberate maintainer decision

Track which alerts were dismissed and which the user chose to leave open, for inclusion in the Step 9 report.

#### 8f: Skip silently when appropriate

- If no matching alert is found for a closed PR, move on silently
- If an alert matches a **merged** PR, do not dismiss it — it should resolve on its own once the fix is deployed
- Report all dismissed alerts in the final report (Step 9)

### Step 9: Final Report (Cross-Repository)

After all repositories have been processed (the per-repository loop from Step 0c is complete), present a **single unified report** covering all repositories. This step runs **once**, outside the per-repository loop.

When only one repository was processed, present the report without repository grouping (same as the original single-repo format). When multiple repositories were processed, group results by repository.

**Per-repository PR summary** (repeat for each repository):

> #### `owner/repo-a`

| PR   | Dependency               | Outcome           | Alert Dismissed            | Notes                                   |
| ---- | ------------------------ | ----------------- | -------------------------- | --------------------------------------- |
| #123 | lodash 4.17.20 → 4.17.21 | Merged            | —                          | CI passed, review approved              |
| #124 | webpack 4.x → 5.x        | Closed (breaking) | Alert #45 (fix_started)    | Build errors: removed export in new API |
| #125 | deprecated-pkg 1.0 → 2.0 | Closed (unsafe)   | Alert #32 (tolerable_risk) | Package is deprecated                   |

> #### `owner/repo-b`

| PR   | Dependency            | Outcome | Alert Dismissed | Notes                                               |
| ---- | --------------------- | ------- | --------------- | --------------------------------------------------- |
| #456 | react 18.2.0 → 18.3.0 | Merged  | —               | Fixed test failures, review approved on 2nd attempt |
| #457 | eslint 8.x → 9.x      | Skipped | —               | CI failure after 5 retries                          |

**Per-repository alert summary** (repeat for each repository):

> #### `owner/repo-a` — Alerts

**Dev-only transitive alerts auto-dismissed** (not reachable in production):

| Alert | Package   | Severity | Manifest          | Vulnerable Range  |
| ----- | --------- | -------- | ----------------- | ----------------- |
| #10   | minimatch | High     | package-lock.json | < 3.1.3           |
| #9    | minimatch | High     | package-lock.json | >= 9.0.0, < 9.0.6 |

**Alerts dismissed** (matched to closed PRs — from this run and previously closed):

| Alert | Package        | Severity | Associated PR           | Dismiss Reason |
| ----- | -------------- | -------- | ----------------------- | -------------- |
| #45   | webpack        | High     | #124 (closed this run)  | fix_started    |
| #32   | deprecated-pkg | Critical | #125 (closed this run)  | tolerable_risk |
| #19   | old-lib        | Medium   | #98 (previously closed) | tolerable_risk |

**Runtime transitive alerts — dismissed** (user approved as tolerable risk):

| Package | Severity | Alerts Dismissed | Affected Manifests                    |
| ------- | -------- | ---------------- | ------------------------------------- |
| ip      | High     | #610, #518       | `yarn.lock`                           |
| semver  | Medium   | #401, #1238      | `yarn.lock`, `examples/spa/yarn.lock` |

**Runtime transitive alerts — intentionally left open** (user chose not to dismiss):

| Package      | Severity | Alert Count | Affected Manifests |
| ------------ | -------- | ----------- | ------------------ |
| tough-cookie | Medium   | 2           | `yarn.lock`        |

**Other unmatched alerts** (not transitive — may need manual investigation):

| Alert | Package    | Severity | Relationship | Scope   | Notes                                                                |
| ----- | ---------- | -------- | ------------ | ------- | -------------------------------------------------------------------- |
| #51   | direct-dep | High     | direct       | runtime | Dependabot should have created a PR — investigate why one is missing |

**Aggregate summary counts** (across all repositories):

> **Repositories processed**: N
>
> **Results**: X merged, Y skipped, Z closed (unsafe), W closed (breaking changes)
>
> **Alerts**: A dismissed total (B dev-only transitive auto-dismissed, C matched to closed PRs, D runtime transitive user-dismissed), E intentionally left open, F other unmatched
>
> **Skipped PRs** (require manual attention):
>
> - `owner/repo-a` #127: eslint 9.x — CI failures after 5 retries
>
> **Per-repository breakdown**:
> | Repository | Merged | Skipped | Closed | Alerts Dismissed |
> |-----------|--------|---------|--------|-----------------|
> | `owner/repo-a` | 3 | 0 | 2 | 8 |
> | `owner/repo-b` | 1 | 1 | 0 | 3 |

## Notes

- Dependabot PRs require manual CI triggering because the bot lacks repository secret access
- Use `gh pr checks --watch` when available for efficient CI polling; fall back to manual polling with 60-second intervals
- Dependabot PRs are approved directly by the caller (who is not the PR author) rather than via AI review
- Some CI runs can take 10+ minutes — be patient and continue polling
- Always return to the original branch after checking out a Dependabot branch for fixes
- PRs are processed as a sliding window (up to 5 in flight) — backfill immediately when one finishes, do not wait for the full batch
- Branch updates before merge (Step 6) are only performed when the repo's branch protection requires it — check once in Step 4b and reuse the result
- If a dependency update causes build/TypeScript errors that stem from breaking API changes in the package itself, close the PR with a comment rather than retrying or skipping
- Lock file merge conflicts (yarn.lock, package-lock.json, pnpm-lock.yaml) are **always resolvable** — regenerate the lock file by running the package manager's install command. Never skip a PR solely because of a lock file conflict
- **Close with comment vs. skip**: When a PR cannot be merged due to breaking changes or code incompatibilities, always **close it with an explanatory comment** so the maintainer has context. Reserve "skipped" only for transient issues that may resolve on retry (e.g., CI flakiness after max retries)
- Step 8 dismisses Dependabot security alerts in four tiers: (1) dev-only transitive dependencies are auto-dismissed as `not_used` since they have no production attack surface, (2) alerts matched to closed PRs are dismissed with the appropriate reason, (3) runtime transitive dependencies with no Dependabot fix are presented to the user for interactive triage and optional batch dismissal as `tolerable_risk`, (4) remaining unmatched alerts (typically direct dependencies missing a PR) are reported for manual investigation
- Every alert dismissal must include a `dismissed_comment` for audit purposes — this is enforced in Step 8 so dismissed alerts on the Security tab are self-documenting
