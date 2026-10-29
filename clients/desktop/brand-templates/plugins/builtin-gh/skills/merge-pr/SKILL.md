---
name: merge-pr
description: >-
  {% if claude %}/builtin-gh:merge-pr{% else %}$builtin-gh:merge-pr{% endif %} only.
  Merge a pull request the way its base branch requires. Without a merge queue it merges directly,
  or arms auto-merge while checks run. With a merge queue it enqueues the PR and watches it until it
  lands. When a merge-group check fails, it dequeues early once eviction is certain. On an eviction
  it diagnoses the failure, fixes and pushes, then re-arms auto-merge so GitHub requeues the PR. A
  PR queued behind one it conflicts with waits for that PR: resolve and requeue if it merged,
  requeue unchanged if it failed. Use when the user explicitly asks to merge, land, ship, or queue a
  PR, or to watch a queued PR through to merge. Never use the merge as a step of another workflow
  unless the user asked for it, and never bypass the queue with admin privileges.
---

# Merge PR

Bundled from agent-plugins revision `a2beacb3b0a541dc92adb607bbb283b8c4b04bdc`;
the shell scripts are byte-identical to that revision.

Merge a pull request and do not stop until it is merged or genuinely blocked. Merge queues evict a
PR when its merge-group checks fail. Those checks run on the PR combined with the latest base and
any PRs ahead of it in the queue, so they can fail even when the PR's own checks passed. This skill
watches for that, fixes the failure, and puts the PR back in the queue so nobody has to remember to.

## Arguments

Parse the user request:

- **PR** (optional): `123`, `owner/repo#123`, or a PR URL. Defaults to the PR for the current branch.
- **--max-fixes=N**: Cap on fix-and-requeue cycles (default `3`, minimum `1`).
- **--squash / --merge / --rebase**: Merge method for a direct merge. Ignored when the base branch
  uses a merge queue, because the queue's own configuration decides the method.
- **--no-monitor**: Merge or enqueue, report, and stop without waiting for the queue.
- **--no-confirm**: Do not stop to confirm critical fixes (see Step 6). Still stops when blocked.
  (Unrelated to `gh pr merge --auto`, which arms GitHub auto-merge.)

## Rules

- Merge only because the user asked for this PR to be merged. Never pass `--admin`, never use
  `gh pr merge --admin`, and never dequeue someone else's PR. Dequeue this PR only when its eviction
  is certain (Step 5).
- Never force-push. Fixes land as new commits on the PR branch.
- Always pass `--match-head-commit <headOid>` so GitHub never merges or enqueues a head you did not
  inspect.
- Never read a queue eviction as success. The PR is done only when the probe reports `MERGED`.
- When a human removes the PR from the queue, stop and report. Do not requeue over a deliberate
  dequeue. GitHub records a dequeue _and_ a push to a queued PR as `reason: manual`, with the
  pusher as `actor`. This skill runs under the user's own token, so `byViewer` cannot tell the skill
  from the user. Never compare against a local clock. Instead, record ownership by observation.
  Just before this skill dequeues the PR, or pushes while it is queued, save the probe's
  `lastRemoval.at` (or `""` if none) as `SNAP`. Right after, wait with
  `--until-new-removal "$SNAP" --wait 60 --interval 5`, and add the new `lastRemoval.at` to
  `OWN_REMOVALS`. A `manual` removal is this skill's own only when its `at` exactly matches an
  entry in `OWN_REMOVALS`. Every other `manual` removal is a human's, including later removals by
  the same user.
- Prefer auto-merge when the repository allows it (`autoMergeAllowed`). Once armed, GitHub merges
  or requeues the PR as soon as its checks pass, even if this session ends. An eviction clears
  auto-merge, so re-arm it after every push.

## Tool preflight

Before any status probe, verify working `bash` and `jq` in the shell used by this session.
In Bash or another POSIX shell:

```bash
command -v bash && bash --version
command -v jq && jq --version
```

In PowerShell, discover both commands first, then check their versions:

```powershell
Get-Command bash -ErrorAction Stop
Get-Command jq -ErrorAction Stop
bash --version
jq --version
```

If either discovery or version check fails, stop before merging or enqueueing. On macOS,
install jq with `brew install jq`; on Windows, use `winget install jqlang.jq`. For missing
or nonworking bash on Windows, install Git for Windows and add its bash directory to PATH,
then restart the shell and repeat the checks. On Linux, install bash/jq with the distribution's
package manager. Invoke the bundled scripts through bash with the entire script path quoted,
including when the installed skill path contains spaces. In PowerShell use `$LASTEXITCODE`
to read the scripts' exit codes.

## Status probe

`<skill-root>` is the installed directory containing this `SKILL.md`. Never resolve it from the
user's repository checkout. Every state check goes through the bundled probe:

```bash
bash "<skill-root>/scripts/merge-status.sh" --repo OWNER/NAME --pr N [--since ISO8601] [--wait SECONDS] [--interval SECONDS] [--delay SECONDS] [--until-unqueued] [--ignore-queue-failures] [--until-new-removal ISO8601]
```

It prints one JSON line and exits `0` when the PR needs action or reached a final state, `1` when it
is still waiting on GitHub, and `2` on a usage or API error. `--since` takes a GitHub timestamp, not
the local clock. Pass the `lastRemoval.at` from just before you last enqueued (`""` if there was
none), so only removals strictly after it count as an eviction. An eviction older than the PR
head's latest push (`headPushedAt`) never counts, because someone already pushed past it.
`--delay N` sleeps N seconds before probing, for "check again after a pause". `--until-new-removal`
waits for a removal newer than the given `lastRemoval.at` (see **Rules**). `queueAhead` lists the queue entries
ahead of the PR (`pr`, `headOid`, `position`, `state`). While the PR is queued, that means entries
with a lower position. Otherwise it means every entry, because a requeue goes to the back.
`--until-unqueued` treats only `QUEUED` and `QUEUE_FAILING` as waiting. Use it to wait for _another_
PR to leave the queue, whether it merged or was evicted.

While the PR is queued, `queueGroup` describes its merge group: `oid` (the group commit), `failing`
(failed checks with `name`, `required`, `url`), `requiredFailed`, and `pendingRequired` (required
checks that have not finished or have not been created yet). `requiredCheckNames` comes from the
base branch's rulesets and branch protection. Cancelled or stale group runs, which are common
when GitHub rebuilds groups, never count as failing; they are listed in `queueGroup.cancelled`.
`--ignore-queue-failures` treats `QUEUE_FAILING` as waiting. Use it after deciding to let the queue
run its course.

Required check names come from rulesets, classic branch protection (through REST when GraphQL hides
it from a non-admin token), and `isRequired`. If classic protection is unreadable,
`requiredNamesUnknown` is true, and a `BLOCKED` PR with checks still running reports
`CHECKS_PENDING`. On the PR head, a required check that has not been created yet counts as pending
while GitHub reports the PR blocked. It is listed in `pendingRequiredChecks`. Anything that needs action
(`CONFLICTS`, `CHECKS_FAILED`, `BEHIND`, `BLOCKED`) takes precedence over an armed auto-merge. If
`checksTruncated` is true, a commit has more than 100 checks and some were not read. Confirm with
`gh pr checks N --repo OWNER/NAME --required`, or `gh run list --commit <oid>` for a merge group,
before acting on a check status.

A second helper tests whether two commits merge cleanly without touching the checkout. Run it
inside the repository after fetching both commits:

```bash
git fetch --no-tags <remote> "refs/pull/<N>/head" "refs/pull/<M>/head"
bash "<skill-root>/scripts/conflict-check.sh" <headOid of N> <headOid of M>
```

It prints `{"conflict": bool, "files": [...]}` and exits `0` when the merge is clean, `1` on
conflicts, and `2` on error. `<remote>` is the remote resolved in **Local checkout**.

## Local checkout

Every local git operation (conflict checks, reproducing a failure, resolving conflicts, fixing,
pushing) runs only after these checks pass. Run them once, before the first such operation:

1. **Right repository and remote.** Find the remote whose fetch URL points at `OWNER/NAME`
   (`git remote -v`, matching `github.com[:/]OWNER/NAME(.git)?`), and use it as `<remote>` in every
   command. A fork-style clone often has the base repository under `upstream`, not `origin`. If no
   remote matches, the checkout is a different repository: stop and report instead of running git
   commands here.
2. **Right branch.** Steps that change files (resolving conflicts, Step 5 reproduction, Step 6) need
   the PR branch checked out. If the current branch is not the PR's `head`:
   - **Cannot push** (`canPushHead: false`): stop and report, because a fix cannot be pushed. The
     probe sets `canPushHead` from this token's permission on the head repository
     (`headRepository`), or from maintainer edits on a cross-repository PR when it can also
     write to the base repository.
   - **Dirty working tree**: stop and ask rather than disturb the user's uncommitted work.
   - **Otherwise**: run `gh pr checkout N --repo OWNER/NAME`.
3. **Right commit and upstream.** Confirm local `HEAD` equals `headOid` (or, within the same cycle,
   that its first parent is `headOid` because Step 5.5 merged the base for reproduction), and that
   the branch's
   upstream (`git rev-parse --abbrev-ref @{upstream}`) is the PR's head branch. For a
   cross-repository PR, that upstream is the fork remote `gh pr checkout` set up, not `<remote>`. If
   the upstream is missing or wrong, stop and report rather than push somewhere else.

| `status`             | Exit | Meaning                                                                                                   | Next step                                                                     |
| -------------------- | ---- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `MERGED`             | 0    | Merged (`mergeCommit` holds the SHA)                                                                      | Step 7                                                                        |
| `CLOSED`             | 0    | Closed without merging                                                                                    | Stop and report                                                               |
| `QUEUED`             | 1    | In the merge queue (`queueEntry` has state, position, ETA)                                                | Wait                                                                          |
| `QUEUE_FAILING`      | 0    | Still queued, but a merge-group check already failed (`queueGroup`)                                       | Step 5                                                                        |
| `AUTO_MERGE_PENDING` | 1    | Auto-merge or auto-queue is armed and waiting for required checks                                         | Wait                                                                          |
| `CHECKS_PENDING`     | 1    | Required checks are running on the PR head                                                                | Wait                                                                          |
| `UNKNOWN`            | 1    | GitHub is still computing mergeability                                                                    | Wait                                                                          |
| `EVICTED`            | 0    | The queue removed the PR after `--since` and since the last push (`lastRemoval.reason`)                   | Step 5                                                                        |
| `READY`              | 0    | Required checks pass and nothing blocks merging                                                           | Step 3 or 4                                                                   |
| `CHECKS_FAILED`      | 0    | A required check failed on the PR head (`failingChecks`)                                                  | Step 6 (PR head)                                                              |
| `CONFLICTS`          | 0    | Merge conflicts with the base branch                                                                      | **Local checkout**, then **Resolve conflicts** (Step 6), then Step 2          |
| `BEHIND`             | 0    | The branch must be up to date with the base before merging                                                | `gh pr update-branch N --repo OWNER/NAME`, then wait                          |
| `BLOCKED`            | 0    | Checks pass, but something else blocks the merge (usually a missing approval), even with auto-merge armed | Disarm auto-merge you armed (`gh pr merge N --disable-auto`), stop and report |
| `DRAFT`              | 0    | The PR is a draft                                                                                         | Stop and ask before marking it ready                                          |

## Waiting

Every wait runs the probe until it exits non-`1`. Do not write a polling loop of your own.

- **{{BRAND_DISPLAY_NAME}} worktree chat**: when the `{% if claude %}{{BRAND_WATCH_COMMAND_CLAUDE_TOOL}}{% else %}{{BRAND_WATCH_COMMAND_CODEX_TOOL}}{% endif %}` tool is available, register
  the probe, with the flags the current step calls for but without `--wait`
  (`intervalSeconds: 60`, `maxAttempts: 100`), using the absolute
  `<skill-root>` path. Put the repo, PR, `SINCE`, `OWN_REMOVALS`, the requeue counts, and the
  remaining fix budget in `followUpInstruction`, then end the turn. The next turn may run in a
  compacted or fresh context, so that state must travel with the watcher. The watcher resumes this chat with the probe's output.
  If the watcher's attempts run out while the PR is still queued, register it again. If the
  watcher fires a failure with `status: ERROR` (an API error), probe once by hand. If that probe
  succeeds, register the watcher again; if it fails the same way, stop and report the error. With
  `--wait`, the probe itself rides out up to 3 consecutive API errors.
- **Waiting on another PR** (Step 5, `merge_conflict`): the same mechanisms, but probe that PR with
  `--until-unqueued` and no `--since`. Name both PRs in `followUpInstruction`.
  {% if claude %}
- **Otherwise**: run the probe with `--wait 10800` through Bash with `run_in_background: true` and
  end the turn. You are re-invoked when it exits. If it exits `1` (the wait budget ran out), check
  `queueEntry` for progress and start another wait.
  {% endif %}
  {% if codex %}
- **Otherwise**: run the probe in the foreground with `--wait 540` so each call stays under the
  shell timeout. Repeat until it exits non-`1`. Report queue position between calls.
  {% endif %}

## Instructions

### Step 1: Resolve the PR

1. Resolve `OWNER/NAME` and the PR number from the argument, or from `gh pr view --json number,url`
   for the current branch. Stop with a usage message if neither resolves.
2. Run the probe once (no `--since`). Stop on `MERGED` or `CLOSED` and report it. An `EVICTED` here
   is an eviction nobody has pushed past yet, so diagnose it (Step 5). An eviction older than the
   latest push is ignored, and the PR simply shows its current state.
3. Note `mergeQueue`: when `true`, the base branch uses a merge queue (Step 4). Otherwise use the
   direct path (Step 3).
4. If the current branch is the PR branch, make sure the working tree is clean and that local
   `HEAD` equals `headOid`. Do not merge a PR whose local branch holds unpushed or uncommitted
   work. Stop and ask the user whether to push it first.

Display:

```
Merge PR #<N> (<OWNER>/<NAME>)
- Base:        <base> (merge queue: yes/no)
- Head:        <headOid:0:7>
- Status:      <status> (<mergeStateStatus>, review: <reviewDecision>)
- Fix budget:  <max-fixes>
```

### Step 2: Get to READY

Act on the probe status per the table until it is `READY`, or until it is `AUTO_MERGE_PENDING` or
`QUEUED`. When `autoMergeAllowed` is true, `CHECKS_PENDING` is also good enough: go straight to
Step 3 or 4 and let auto-merge wait for the checks. Do this only when `reviewDecision` is
`APPROVED` or null (no review required). With `REVIEW_REQUIRED` or `CHANGES_REQUESTED`, the PR will
end up `BLOCKED`, so stop and report now instead of arming auto-merge. Otherwise wait. Stop on `BLOCKED`, `DRAFT`, or
`CLOSED`. A `CHECKS_FAILED` here is a PR-head failure: handle it with Step 6, then come back. If a
wait ends with `CHECKS_PENDING` and the same `pendingRequiredChecks` that no run is producing (for
example, a path-filtered workflow that never triggers), stop and report those check names. Do not
keep waiting.

### Step 3: Direct merge (no merge queue)

1. Choose the method: the flag the user passed; otherwise the repository's
   `viewerDefaultMergeMethod`, as long as the repository allows it. Map `MERGE`, `SQUASH`, and
   `REBASE` to `--merge`, `--squash`, and `--rebase`:
   ```bash
   gh api graphql -f query='query($o:String!,$n:String!){repository(owner:$o,name:$n){viewerDefaultMergeMethod mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed}}' -f o=OWNER -f n=NAME
   ```
2. Merge. If `autoMergeAllowed` is true, pass `gh pr merge --auto`: it merges now when everything passes, or
   arms auto-merge while checks are still running:
   ```bash
   gh pr merge N --repo OWNER/NAME --<method> [--auto] --match-head-commit <headOid>
   ```
   Without auto-merge, run this only at `READY`. Do not pass `--delete-branch`. It also deletes and
   switches the local branch, which fails inside worktrees. The repository's auto-delete setting
   handles the remote branch.
3. Probe the PR. On `MERGED`, go to Step 7. On `AUTO_MERGE_PENDING`, report the armed auto-merge
   and stop if `--no-monitor` was given; otherwise wait (see **Waiting**). If a
   PR-head check fails while auto-merge is armed (`CHECKS_FAILED`), fix it with Step 6. Step 6
   re-arms auto-merge, so the PR merges once the fix passes.

### Step 4: Enqueue (merge queue)

1. Set `SINCE` to the probe's current `lastRemoval.at`, or `""` if there is none, **before**
   enqueueing. Any later removal is newer than that.
2. Enqueue without a merge method. Pass `gh pr merge --auto` when `autoMergeAllowed` is true:
   ```bash
   gh pr merge N --repo OWNER/NAME [--auto] --match-head-commit <headOid>
   ```
   If required checks already pass, the PR joins the queue immediately. If they are still running,
   auto-merge is armed, and GitHub queues the PR when they pass, without this session having to be
   alive. Without auto-merge, run this only at `READY`. If `gh pr merge` fails with no clear
   reason, fall back to the GraphQL mutation:
   ```bash
   PR_ID=$(gh pr view N --repo OWNER/NAME --json id --jq .id)
   gh api graphql -f query='mutation($id:ID!,$oid:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$oid}){mergeQueueEntry{position state}}}' -f id="$PR_ID" -f oid=<headOid>
   ```
3. Confirm the probe (with `--since SINCE`) reports `QUEUED` or `AUTO_MERGE_PENDING`. Display the
   queue position and `estimatedTimeToMerge`.
4. **Predict conflicts in the queue.** After **Local checkout** step 1 (only the remote is needed
   here), fetch each `queueAhead` entry's head and run the conflict check against this PR's head. For each conflict, report it:
   `#<M> (position <p>) conflicts with this PR in <files>. Expect a merge_conflict eviction if it merges; it will be resolved then.`
   Do not dequeue. Staying in the queue keeps the PR's position if `#<M>` fails, and GitHub holds
   the PR until `#<M>` resolves either way.
5. With `--no-monitor`, report the queue state and stop. Otherwise wait (see **Waiting**) and act on
   the result:
   - `MERGED` → Step 7.
   - `QUEUE_FAILING` → Step 5 (still queued).
   - `EVICTED` → Step 5.
   - `CHECKS_FAILED` (auto-merge was armed and a PR-head check failed) → Step 6 for the PR head.
   - `CONFLICTS` / `BEHIND` → handle as in the table, then Step 4 again.
   - Anything else → handle per the table.

### Step 5: Diagnose a queue failure or eviction

#### Failing while still queued (`QUEUE_FAILING`)

A merge-group job can fail well before the queue evicts the PR. Repositories commonly make a single
aggregate gate job (for example "CI Gate") the only required check. It runs last, so the eviction
can lag the real failure by 20 minutes or more. Use that time, but dequeue only when the eviction
is certain.

1. **Is eviction certain?** It is certain when `queueGroup.requiredFailed` is true. It is also
   certain when a failed job feeds a required check that is still in `pendingRequired`, which you
   confirm from the workflow file. The required job must `needs:` the failed job, directly or
   transitively, and must still run and fail after an upstream failure (`if: always()` or
   `!cancelled()` plus a check of `needs.*.result`). A required job with no such `if` is _skipped_
   when an upstream job fails. GitHub counts a skipped required check as passing, so that failure
   does not evict. Anything else is not certain: a failed check that no required check depends on,
   or a dependency you cannot confirm.
2. **Certain → dequeue now**, before diagnosing. The PRs behind this one have merge groups that
   include it and will fail too. Dequeuing lets GitHub rebuild them without it right away instead
   of when the gate times out. First confirm that the failure belongs to the current group: probe
   once more with `--delay 30`. Dequeue only if the status is still `QUEUE_FAILING` with the same
   `queueGroup.oid` and the same failing check. If the group commit changed, GitHub rebuilt the
   group, so go back to waiting. Then save `SNAP`, dequeue, and record the removal in
   `OWN_REMOVALS` (see **Rules**):
   ```bash
   PR_ID=$(gh pr view N --repo OWNER/NAME --json id --jq .id)
   gh api graphql -f query='mutation($id:ID!){dequeuePullRequest(input:{id:$id}){clientMutationId}}' -f id="$PR_ID"
   ```
   If the mutation fails because the PR is no longer queued, GitHub evicted it first. Continue
   either way. Diagnose with **Failed checks eviction** below, using `queueGroup.oid` as the group
   commit (`gh run list --repo OWNER/NAME --commit <oid>` finds its runs). Then fix with Step 6, or
   requeue unchanged if the failure is flaky.
3. **Not certain → stay queued.** Read the failing job's logs now, so a fix is ready if the PR is
   evicted, but do not push: a push removes the PR from the queue. Wait with
   `--ignore-queue-failures` until `MERGED` or `EVICTED`. If the PR merges, mention the
   non-blocking failure in the report.

#### Evicted

Read `lastRemoval.reason` from the probe:

- `manual`: if this skill caused it (see **Rules**), continue where you left off. Otherwise someone
  dequeued the PR (`lastRemoval.actor`). Stop and report. Do not requeue.
- `merge_conflict`: see **Merge conflict eviction** below.
- `failed_checks`: see **Failed checks eviction** below.
- Any other reason (for example a timeout): report it and requeue once. If the same reason recurs,
  stop and report.

#### Merge conflict eviction

The PR cannot be merged on top of the base plus the PRs ahead of it. GitHub builds no merge group
for this (`lastRemoval.beforeCommit` is null), so there are no CI runs to read. GitHub usually keeps
the PR in the queue until the conflicting PR merges, then evicts it in the same second. It can also
evict while the conflicting PR is still queued, and that PR may still fail. In both cases, resolve
once against the final outcome. Do not resolve against a PR that may never merge.

1. **Find conflicting PRs still in the queue.** Probe this PR. After **Local checkout** step 1, fetch
   each `queueAhead` entry's head and run the conflict check against this PR's `headOid`. A PR that exits `1` is a
   conflicting PR. If none conflicts on its own but `mergeStateStatus` is not `DIRTY`, the conflict
   comes from a combination of the PRs ahead. Treat the first three `queueAhead` entries (lowest
   positions, the ones that merge next) as conflicting. If `queueAheadTruncated` is true, the queue
   has more than 100 entries and `queueAhead` is incomplete, so a conflict may come from an entry
   that wasn't read. If the PR is evicted for `merge_conflict`
   again, repeat this analysis instead of waiting on the whole queue.
2. **Wait for each conflicting PR to leave the queue.** Report
   `Waiting on #<M> (position <p>): conflicts in <files>`, then wait with `--until-unqueued` (see
   **Waiting**). Wait even when this PR is already `DIRTY` (a conflicting PR already merged), so
   that every conflict is resolved in one pass. Once a PR leaves the queue without merging, do not
   wait for its author to requeue it.
3. **Act on the outcome.** Probe this PR again with `--since SINCE --wait 120 --interval 10`. Right
   after a merge GitHub reports `mergeStateStatus: UNKNOWN` for a while, and the probe treats that
   as waiting, so the result reflects the new base. If the wait ends without a decision (exit `1`):
   with `QUEUED` or `AUTO_MERGE_PENDING`, someone already requeued the PR, so go back to the Step 4
   wait. With `UNKNOWN`, wait once more, and stop and report if it is still unknown. With
   `status: EVICTED`, read `mergeStateStatus`:
   - **`DIRTY`**: a conflicting PR merged into `<base>`. Run **Local checkout**, then **Resolve
     conflicts** (Step 6). That push counts against `--max-fixes`. After the push, repeat step 1,
     since new PRs may have joined the queue. Then requeue (Step 4).
   - **Anything else**: every conflicting PR left the queue without merging, so the base does not
     conflict. Requeue unchanged (Step 4). This does not count against `--max-fixes`, but requeue
     unchanged at most once per conflicting PR. If `queueAhead` was empty and the PR was not
     `DIRTY` (nothing to wait on and nothing to resolve), requeue unchanged once. If it is evicted
     for `merge_conflict` again, stop and report.

Report each cycle in one line, for example:
`Cycle 1/3: evicted (merge_conflict) → waited on #4695 → merged → resolved src/app.ts in d4e5f6a → requeued`.

#### Failed checks eviction

1. **Find the merge-group run.** Merge-group checks run on a temporary branch named
   `gh-readonly-queue/<base>/pr-<N>-<parent-sha>` and do not appear in `gh pr checks`. The group
   commit is `lastRemoval.beforeCommit` after an eviction, or `queueGroup.oid` while still queued.
   Find its runs by commit:
   ```bash
   gh run list --repo OWNER/NAME --commit <group-sha> \
     --json databaseId,headBranch,conclusion,status,workflowName,url
   ```
   If the group commit is unknown, filter `gh run list --event merge_group` by a `headBranch`
   starting with `gh-readonly-queue/<base>/pr-<N>-`, created after `SINCE`. The `<parent-sha>`
   suffix of `headBranch` is the commit the group was built on: the base tip plus any PRs ahead of
   this one.
2. **Find the real failure.** List failed jobs with `gh run view <id> --repo OWNER/NAME --json jobs`
   and read logs with `gh run view <id> --repo OWNER/NAME --log-failed`. Many repositories end with
   an aggregate gate job (for example "CI Gate") that fails whenever any upstream job fails. Read
   its summary to find the upstream job, then diagnose that job, not the gate.
3. **See what else was in the group.**
   ```bash
   gh api repos/OWNER/NAME/compare/<parent-sha>...<group-sha> --jq '.commits[] | "\(.sha[0:8]) \(.commit.message | split("\n")[0])"'
   gh api repos/OWNER/NAME/compare/<base>...<parent-sha> --jq '.commits[] | "\(.sha[0:8]) \(.commit.message | split("\n")[0])"'
   ```
   The first command lists this PR's commits. The second lists PRs ahead of it in the queue that
   have not merged into `<base>` yet.
4. **Classify** the failure (use the categories from `{% if claude %}/builtin-gh:handle-pr-checks{% else %}$builtin-gh:handle-pr-checks{% endif %}` Step 4):
   - **Base drift**: the PR breaks against changes already merged into `<base>` (a renamed API, a
     moved file, a generated artifact or lockfile drift, a new lint rule). Actionable on this
     branch.
   - **Queue interaction**: the PR breaks against a PR ahead of it that has not merged yet. As with
     a merge conflict, act on that PR's final outcome. If it is still queued, wait for it with
     `--until-unqueued`. If it merged, the failure is now base drift: fix it here. If it left the
     queue without merging, requeue unchanged.
   - **Pre-existing on base**: the same job fails on `<base>` itself (`gh run list --branch <base>`)
     or in other PRs' merge groups at the same time. Not this PR's fault. Stop and report it as a
     broken base. Do not paper over it.
   - **Flaky or infrastructure**: timeouts, runner loss, network or registry errors, or a test that
     passes on rerun with no relevant change. Requeue once without changes. If the same job fails
     the same way twice, treat it as real.
5. **Reproduce locally** before fixing anything actionable:
   ```bash
   git fetch <remote> "+refs/heads/<base>:refs/remotes/<remote>/<base>"
   git merge <remote>/<base>
   ```
   Run **Local checkout** first, so this merge lands on the PR branch. Then run the failing job's
   command from the workflow file (for example `.github/workflows/*.yml` for that job). To reproduce
   the exact group, try `git fetch <remote> <group-sha>` and check it out detached. If the cycle
   ends without a pushed fix (flaky, requeued unchanged, or not reproducible), discard the local
   base merge with `git reset --hard <headOid>`. That is safe because **Local checkout** confirmed a
   clean tree at `headOid` before the merge. A later **Local checkout** then still finds
   `HEAD == headOid`. If GitHub will not serve that unreferenced commit, the base merge above plus any PRs
   ahead is the closest substitute. If the failure does not reproduce and does not classify as
   flaky, show the evidence and stop. Do not guess-fix.

### Step 6: Fix, push, requeue

Use this for an eviction diagnosed as actionable in Step 5, for a `CHECKS_FAILED` on the PR head,
and for conflicts with the base.

0. **Local checkout.** Run the **Local checkout** checks. Every git command below runs on the PR
   branch, against `<remote>`.

**PR-head failure.** Use the `{% if claude %}/builtin-gh:handle-pr-checks{% else %}$builtin-gh:handle-pr-checks{% endif %}` skill's Steps 2–5 for diagnosis only,
then apply fixes through this skill's Steps 2–6 below. Do not invoke that skill's Steps 6–8
as a remediation workflow: its commit/push behavior would bypass this skill's gates,
`OWN_REMOVALS` bookkeeping, and re-arm. The separate Step 6 reference below is for
verification instructions only; do not continue into that skill's commit/push steps.

**Resolve conflicts.** Merge the base and resolve the conflicts:

```bash
git fetch <remote> "+refs/heads/<base>:refs/remotes/<remote>/<base>"
git merge <remote>/<base>
```

Resolve the conflicted files and verify them as described in `{% if claude %}/builtin-gh:handle-merge-conflicts{% else %}$builtin-gh:handle-merge-conflicts{% endif %}`
(Steps 4–6). Do not call that command directly, because it assumes `origin` and the checked-out
branch. If any conflict is ambiguous, stop and ask. Then continue with steps 5 and 6.

1. **Budget.** Each fix pushed counts against `--max-fixes`. Each requeue without changes (flaky,
   queue interaction) is allowed once per distinct failure. When the budget runs out, or the same
   job fails with the same error after a fix, stop and report.
2. **Gate critical fixes.** Unless `--no-confirm` is set, stop and confirm with the user before a fix
   that changes a database schema or migration, adds or upgrades a runtime dependency, deletes or
   skips a test, changes a public API contract, or restructures auth. Fix everything else without
   asking.
3. **Fix** the root cause on the PR branch. Never weaken, skip, or delete a check to get green.
4. **Verify locally**: re-run the failing command, plus the lint, type-check, and related tests per
   `{% if claude %}/builtin-gh:handle-pr-checks{% else %}$builtin-gh:handle-pr-checks{% endif %}` Step 6.
5. **Commit and push.** If Step 5 merged `<base>`, commit that merge as well. Follow
   `{% if claude %}/builtin-git:commit-messages{% else %}$builtin-git:commit-messages{% endif %}`. Do not force-push.
   ```bash
   git push   # to the upstream verified in Local checkout step 3
   ```
   A push to a PR that is still queued removes it from the queue. If the PR was queued, save `SNAP`
   before the push, and record the new removal in `OWN_REMOVALS` right after it (see **Rules**).
6. **Re-arm and requeue immediately.** Right after the push, go back to Step 4 with the new head
   (`git rev-parse HEAD`). Do not wait for the PR's own checks first. With `autoMergeAllowed`, the
   `gh pr merge --auto` enqueue arms auto-merge, and GitHub requeues the PR as soon as the PR-head checks pass.
   Without it, wait for `READY`, then enqueue. On a branch without a queue, return to Step 3 and
   re-arm auto-merge only if the probe shows `autoMerge` is null.

Report each cycle in one line, for example:
`Cycle 2/3: evicted (failed_checks: lint) → base drift in generated types → fixed in a1b2c3d → requeued`.

### Step 7: Report

End with a short summary:

```
PR #<N> merged into <base> as <mergeCommit:0:7>
- Path:       merge queue | direct (<method>)
- Evictions:  <count> (<reasons>; early dequeues marked)
- Conflicts:  <PRs waited on and their outcome, files resolved, or "none">
- Fixes:      <commit sha + one-line description per fix, or "none">
- Requeues:   <count>
- Time:       <first enqueue → merged>
```

When stopping without a merge, use the same shape with **Status: blocked**, the reason, the evidence
(run URL and failing job), and the exact next step for the user. The local branch is left as is.
Clean it up with the user's usual workflow.
