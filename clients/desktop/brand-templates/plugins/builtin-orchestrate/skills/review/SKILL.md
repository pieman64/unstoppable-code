---
name: review
description: >-
  Run {{BRAND_DISPLAY_NAME}}'s bundled Code Review (Multi-Provider) pipeline from a chat — dispatch, result verification, and posting discipline. Use when a scored multi-track review of a worktree's changes is needed, before posting any AI review to GitHub, or when a handoff brief or posting-by-design workflow calls for a review round
---

# Review — the bundled multi-provider pipeline

Runs the bundled `Code Review (Multi-Provider)` pipeline on the current worktree: parallel review
tracks (repo-compliance, methodical, security) synthesized into one scored report with a `verdict`
and `riskScore` (10 = clean).

Runs from any chat with `dispatch_action` (brand-prefixed tool names on the Codex engine).
In a worktree chat the pipeline runs at true worktree scope — never provide project/worktree ids
yourself. The bundled review pipelines are also directory-scoped, so a cowork (folder) chat can
run them at its root — useful for reviewing a folder, but PR-context jobs want the worktree; for
PR work, run from the worktree chat. (Other bundled pipelines — planning, autopilot — remain
worktree-only.)

## Hook boundary

Local/non-posting reviews are hook-neutral: do not pause or resume hooks. If an outer workflow
already owns the PR hooks, do not pause or resume them; the caller retains ownership.

Only a standalone posting review in a worktree chat owns hooks. Before a
`post_pr_comment: 'true'` run, use `worktree.get_settings`. From its `hooks`, select entries whose
`triggerName` starts `pr:`, exclude each exact `hookKey` present in `pausedHookKeys`, then pause each
remaining `hookKey` with `{type: 'hook.pause', hookKey: '<key>'}`. Track the exact keys this review
successfully paused. On every terminal path, resume exactly the keys this review paused with
`{type: 'hook.resume', hookKey: '<key>'}`. Never use bulk hook pause or resume.

## Run

1. `dispatch_action {type: 'pipeline.list'}` → find the bundled `Code Review (Multi-Provider)` id.
2. `dispatch_action {type: 'pipeline.run', pipelineId: <id>,
inputs: {post_pr_comment: 'false', base_branch: '<base>', include_uncommitted: 'false'}}`
   - **ALWAYS pass `base_branch`.** CLI-created handoff worktrees have a tracked base, but an
     explicit base keeps stacked reviews correct even if worktree settings later change.
   - **ALWAYS pass `include_uncommitted: 'false'`** (the pipeline defaults it to true): commit
     first, then review, so the reviewed tree is exactly the committed HEAD you will push.
   - `post_pr_comment: 'true'` only when posting is authorized (below).
3. Yield after dispatch; rely on {{BRAND_DISPLAY_NAME}}'s global watcher behavior for the wake.
4. After a pause or terminal wake, make a one-shot `pipeline.execution_get` inspection of the
   returned execution id. For a pause, continue the same execution with `pipeline.execution_resume`
   and the exact `statusReasonIds` or checkpoint `pauseResponses`; never retry completed tracks.
5. Results: `{{BRAND_CLI_NAME}} pipelines executions summary <id>` prints per-job outcomes and
   the report outputs (the pipeline's output key is `review_report_file`). The aggregate JSON
   next to it carries `riskScore`, `riskLevel`, `verdict`, and `findings[]`; the markdown report
   is the readable version.

## Verify the run before trusting it (mandatory)

A partially-degraded run still emits a polished, plausible report. Before reading findings:

- **Context jobs succeeded.** In the summary, every context-gathering job (workspace details,
  PR context, Linear context, change summary) must be `success`, not `skipped`. A blind run's
  tell-tale: review tracks finish in seconds and report "no issues", inflating the consensus
  toward a clean pass. If context jobs skipped, the report is void — fix the run, don't report
  its findings.
- **`Changed files: 0` means you forgot to commit.** With `include_uncommitted: 'false'` the
  pipeline diffs committed HEAD against the base, so an uncommitted tree yields an empty diff
  and a meaningless clean score while every job succeeds. Commit first; always check the report
  header's changed-file count > 0. (Without that input, the default reviews uncommitted and
  untracked changes too — state you will never push.)
- **The `merge_base` matches your base tip.** On stacked branches, a stale or rewritten
  `origin/<base>` silently reviews the whole stack and emits phantom findings ("scope creep",
  "undisclosed changes"). Fetch the base with an explicit refspec first; if the ref is
  unreliable, pass an immutable SHA as `base_branch`.
- **The report's `Branch:` header is your branch.** Cheap insurance that the execution you are
  reading is the one you launched — executions from other chats and sessions share one list.
- In a correct non-posting run, the posting jobs read `skipped`. Seeing them `success` means
  either posting was requested or you are reading the wrong execution.

## Posting rules

- Default to a **local, non-posting** run (`post_pr_comment: 'false'`).
- Post only when the user explicitly authorized it, or the run is inside a posting-by-design flow
  — e.g. a babysit-style workflow skill or a handoff brief that pre-authorizes posting. A PR URL
  or number alone never authorizes posting.
- **A posting run re-reviews from scratch.** It does not publish the local report you just
  vetted — it runs a fresh review and posts that, so the posted score is an independent (often
  lower) sample. Read the actually-posted score every time
  (`gh pr view <n> --json reviews`); never assume the local score carried.
- Where repo tooling gates on the AI review, it typically reads only the LATEST posted review — a
  low posted score is recovered by sweeping the findings in a follow-up commit and posting again,
  not by stopping.
- Confirm each post landed (`gh pr view <n> --json reviews`); the pipeline reporting success is
  not proof the review appeared.

## PR-open auto-trigger

Opening a PR can auto-fire a review execution. After `gh pr create`, list executions on your
branch and inspect any you didn't launch: if its base matches the PR base, ADOPT it as the posted
review (post yourself only if it is absent or low-scoring — a redundant post replaces a better
review as "latest"). If its base is wrong (default branch on a stacked PR) or it would post when
it shouldn't, cancel it via `pipeline.execution_cancel`.

## Concurrency

All executions run inside the single app process, and model-backed tracks draw from one app-global
worker pool (the worker concurrency preference). A worker that can't get a slot queues with no
deadline while its job shows `running` — pool starvation looks like a silent hang, not an error.
Each review holds a few concurrent model tracks, so keep simultaneous reviews ≈ pool limit / 3.
If runs stall (fast tracks done, model tracks stuck), check for competing executions
(`{{BRAND_CLI_NAME}} pipelines executions list`) and cancel the newest to unblock; a retry on a
clear queue completes normally.

## Handoff reports

When reviewing for an orchestrator, finish with a clear report in the implementer chat and keep
the PR body current. The orchestrator watches `project_task_chat_completion`, reads reports with
`projects.get_last_agent_response` / `projects.read_history`, and sends follow-ups through
`projects.send_message`. The completion wake is not a substitute for verifying the review.

## Ticket context

App-run pipelines receive the environment configured in the app's Environments settings. For
Linear-aware review context, set `{{BRAND_ENV_PREFIX}}_LINEAR_API_KEY` there once; on the first
run, verify the Linear context job reports a valid token. Without it the review judges intent from
the diff alone and every referenced ticket is treated as unvalidated. Other integrations
(`gh`, the model CLIs) use their own bundled credential stores — no extra keys needed.
