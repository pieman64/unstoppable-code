/**
 * CAN-5271 source-metadata snapshot (2026-10-27), not a user's private inventory.
 * Names/descriptions copied from real SKILL.md/command frontmatter. No bodies,
 * generated filler, runtime discovery, network, clocks or filesystem reads.
 * Source paths are provenance, not test-time dependencies.
 * UD revision: a8ffbef7f90c976cf3e70bf4f398738a741c6716.
 * PostHog revision: 8c0f825c43583f6351883a99c3f1b9d6a21dbff1.
 * Official/slack/superpowers: installed source snapshot; no revision retained.
 * Builtins: rendered Canopy/Claude brand-templates at
 * a6cad0c0e98a5154fcb350e22c5835b9b318ced9.
 * Disabled and non-user-invocable members are intentionally absent.
 */
interface SourceMember {
  readonly id: string;
  readonly plugin: string;
  readonly kind: 'skill' | 'command';
  readonly name: string;
  readonly description: string;
  readonly source: string;
}

export const SOURCE_MEMBERS: readonly SourceMember[] = [
  {
    id: 'ud-alert-triage:alert-triage',
    plugin: 'ud-alert-triage',
    kind: 'skill',
    name: 'alert-triage',
    description:
      'Use when triaging a GCP Monitoring alert — an alert JSON payload arrives as the user message, or someone asks to investigate, triage, or look at an alert policy or service for an Unstoppable Domains service.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-alert-triage/skills/alert-triage/SKILL.md',
  },
  {
    id: 'ud-alert-triage:log-trends',
    plugin: 'ud-alert-triage',
    kind: 'skill',
    name: 'log-trends',
    description:
      'Use when asked to scan GCP logs for trends, find what has been erroring, identify recurring errors or log anomalies, or run proactive recurring-error detection for the services owned by the current repo or an explicitly targeted one.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-alert-triage/skills/log-trends/SKILL.md',
  },
  {
    id: 'ud-code-review:code-reviewer',
    plugin: 'ud-code-review',
    kind: 'skill',
    name: 'code-reviewer',
    description:
      'UD-focused code review specialist with GitHub PR automation for quality, security, performance, and plan-alignment reviews, and bot comment resolution.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-code-review/skills/code-reviewer/SKILL.md',
  },
  {
    id: 'ud-code-review:docs-triage',
    plugin: 'ud-code-review',
    kind: 'command',
    name: 'docs-triage',
    description: '',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-code-review/commands/docs-triage.md',
  },
  {
    id: 'ud-code-review:make-pr-green',
    plugin: 'ud-code-review',
    kind: 'command',
    name: 'make-pr-green',
    description:
      'Drive a PR end-to-end to a clean, approved state — waits for Copilot, resolves merge conflicts, classifies every comment, only gates the biggest critical changes (schema, deps, test deletion, public API, auth restructures) with the developer and auto-fixes everything else, and iterates review + fix to score ≥ 8',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-code-review/commands/make-pr-green.md',
  },
  {
    id: 'ud-code-review:review-loop',
    plugin: 'ud-code-review',
    kind: 'command',
    name: 'review-loop',
    description:
      'Iterate review-multi and handle-pr-comments until the AI review gate approves, then sweep and close all actionable threads',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-code-review/commands/review-loop.md',
  },
  {
    id: 'ud-code-review:review-multi',
    plugin: 'ud-code-review',
    kind: 'command',
    name: 'review-multi',
    description: '',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-code-review/commands/review-multi.md',
  },
  {
    id: 'ud-code-review:review',
    plugin: 'ud-code-review',
    kind: 'command',
    name: 'review',
    description: '',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-code-review/commands/review.md',
  },
  {
    id: 'ud-codex:codex',
    plugin: 'ud-codex',
    kind: 'skill',
    name: 'codex',
    description:
      "Invoke the OpenAI Codex CLI (gpt-5.6-sol) non-interactively for delegated implementation, code review, adversarial review, investigation, or computer/browser use. Trigger on 'use codex', 'ask codex', 'have codex/gpt review this', '/codex ...', when the model-selection rubric routes work to gpt/codex, or when computer use would help complete or verify work. Defaults to read-only; write mode only for explicit implementation handoffs.",
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-codex/skills/codex/SKILL.md',
  },
  {
    id: 'ud-docs:docs-updater',
    plugin: 'ud-docs',
    kind: 'skill',
    name: 'docs-updater',
    description:
      'Analyze code changes and map them to engineering docs pages. Activates when reviewing PRs or making significant code changes that may need documentation updates.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-docs/skills/docs-updater/SKILL.md',
  },
  {
    id: 'ud-docs:update-from-pr',
    plugin: 'ud-docs',
    kind: 'command',
    name: 'update-from-pr',
    description: '',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-docs/commands/update-from-pr.md',
  },
  {
    id: 'ud-ecom-debugger:ecom-debugger',
    plugin: 'ud-ecom-debugger',
    kind: 'skill',
    name: 'ecom-debugger',
    description:
      "Investigate support tickets for domain/order issues. Use when the user says 'investigate', mentions a Linear ticket (ECW-*), domain name, order ID, or asks about transfer-in, registration, or payment problems.",
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-ecom-debugger/skills/ecom-debugger/SKILL.md',
  },
  {
    id: 'ud-ecom-debugger:investigate',
    plugin: 'ud-ecom-debugger',
    kind: 'command',
    name: 'investigate',
    description: 'Investigate a support ticket or domain/order issue',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-ecom-debugger/commands/investigate.md',
  },
  {
    id: 'ud-git:merge-pr',
    plugin: 'ud-git',
    kind: 'skill',
    name: 'merge-pr',
    description:
      'Merge a pull request the way its base branch requires. Without a merge queue it merges directly, or arms auto-merge while checks run. With a merge queue it enqueues the PR and watches it until it lands. When a merge-group check fails, it dequeues early once eviction is certain. On an eviction it diagnoses the failure, fixes and pushes, then re-arms auto-merge so GitHub requeues the PR. A PR queued behind one it conflicts with waits for that PR: resolve and requeue if it merged, requeue unchanged if it failed. Use when the user explicitly asks to merge, land, ship, or queue a PR, or to watch a queued PR through to merge. Never use the merge as a step of another workflow unless the user asked for it, and never bypass the queue with admin privileges.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-git/skills/merge-pr/SKILL.md',
  },
  {
    id: 'ud-git:sync-pr-details',
    plugin: 'ud-git',
    kind: 'skill',
    name: 'sync-pr-details',
    description:
      'Sync PR title and description with current branch changes. Apply when updating an existing PR, after pushing new commits to a PR branch, when PR description becomes stale or inaccurate, or when explicitly asked to update PR details.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-git/skills/sync-pr-details/SKILL.md',
  },
  {
    id: 'ud-git:announce-merged-prs',
    plugin: 'ud-git',
    kind: 'command',
    name: 'announce-merged-prs',
    description:
      'Post a Slack thread for each recently merged PR that matches a subject area (e.g. UX changes)',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-git/commands/announce-merged-prs.md',
  },
  {
    id: 'ud-git:handle-dependabot',
    plugin: 'ud-git',
    kind: 'command',
    name: 'handle-dependabot',
    description:
      'Triage, fix CI, merge, and clean up alerts for open Dependabot PRs',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-git/commands/handle-dependabot.md',
  },
  {
    id: 'ud-git:handle-merge-conflicts',
    plugin: 'ud-git',
    kind: 'command',
    name: 'handle-merge-conflicts',
    description: 'Resolve merge conflicts with the base branch',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-git/commands/handle-merge-conflicts.md',
  },
  {
    id: 'ud-git:handle-pr-checks',
    plugin: 'ud-git',
    kind: 'command',
    name: 'handle-pr-checks',
    description: 'Examine and address failing CI checks on current PR',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-git/commands/handle-pr-checks.md',
  },
  {
    id: 'ud-git:handle-pr-comments',
    plugin: 'ud-git',
    kind: 'command',
    name: 'handle-pr-comments',
    description: 'Review and address PR comments',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-git/commands/handle-pr-comments.md',
  },
  {
    id: 'ud-git:new-branch',
    plugin: 'ud-git',
    kind: 'command',
    name: 'new-branch',
    description: 'Create a new branch from the default branch',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-git/commands/new-branch.md',
  },
  {
    id: 'ud-git:new-worktree',
    plugin: 'ud-git',
    kind: 'command',
    name: 'new-worktree',
    description: 'Create a new worktree from the default branch',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-git/commands/new-worktree.md',
  },
  {
    id: 'ud-git:open-pr',
    plugin: 'ud-git',
    kind: 'command',
    name: 'open-pr',
    description: 'Create a pull request for the current branch',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-git/commands/open-pr.md',
  },
  {
    id: 'ud-git:push-branch',
    plugin: 'ud-git',
    kind: 'command',
    name: 'push-branch',
    description: 'Commit and push all changes with auto-generated message',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-git/commands/push-branch.md',
  },
  {
    id: 'ud-git:switch-branch',
    plugin: 'ud-git',
    kind: 'command',
    name: 'switch-branch',
    description: 'Switch to an existing branch',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-git/commands/switch-branch.md',
  },
  {
    id: 'ud-gke:gke-app-deploy',
    plugin: 'ud-gke',
    kind: 'skill',
    name: 'gke-app-deploy',
    description:
      'Use when building the application-repo side of deploying a UD service to the shared GKE (Autopilot) cluster — the app-owned cloudbuild.yaml (build/push/helm over the cloud-build-pool-gke pool), Helm chart shape, immutable SHA image tags, release-gating DB migrations, Spot pods + topology spread, internal LoadBalancer wiring, dark-deploy validation, cost labels, and the Cloud Run→GKE migration-period playbook (parallel run, deploy gating). For wiring secrets/env specifically, defer to the gke-secrets-and-env skill.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-gke/skills/gke-app-deploy/SKILL.md',
  },
  {
    id: 'ud-gke:gke-secrets-and-env',
    plugin: 'ud-gke',
    kind: 'skill',
    name: 'gke-secrets-and-env',
    description:
      'Use when adding, changing, or wiring secrets and environment variables for a UD service on GKE — mapping Google Secret Manager secret IDs to application config keys through the Secret Store CSI driver (secretStoreCsi.items) and setting non-secret env vars in a Helm chart. Keeps config-key / secret-id / IAM-grant naming consistent.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-gke/skills/gke-secrets-and-env/SKILL.md',
  },
  {
    id: 'ud-linear:linear-agent-implement',
    plugin: 'ud-linear',
    kind: 'skill',
    name: 'linear-agent-implement',
    description:
      'Selects fresh, human-authorized agent-ready Linear tickets, claims them, and dispatches each through a tracked plan and plan-ready implementation pipeline. Use when asked to implement a bounded set of tickets already scored ready; use linear-agent-sweep to score or refresh tickets and linear-agent-score to inspect one ticket. Owns no rubric, performs no scoring, and ships no runtime adapter or server.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-linear/skills/linear-agent-implement/SKILL.md',
  },
  {
    id: 'ud-linear:linear-agent-score',
    plugin: 'ud-linear',
    kind: 'skill',
    name: 'linear-agent-score',
    description:
      "Score ONE Linear ticket, named by its identifier, 0-10 on whether an AI agent could implement it with no human intervention, then record the result as one standardized Linear comment, one `Agent readiness` label, a t-shirt size in the ticket's `estimate` field, and additive `blockedBy` / `blocks` relations for the dependencies it finds. Use when asked to score, grade, or assess a specific ticket for agent readiness, to mark it agent-ready or human-required, or to size it. For many tickets matching a team, label, project, or query, use `ud-linear:linear-agent-sweep` instead. Runs unattended — never asks questions, never edits the ticket's description, status, priority, or assignee, never overwrites an estimate a human set, and never removes or alters an existing relation.",
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-linear/skills/linear-agent-score/SKILL.md',
  },
  {
    id: 'ud-linear:linear-agent-sweep',
    plugin: 'ud-linear',
    kind: 'skill',
    name: 'linear-agent-sweep',
    description:
      'Score many Linear tickets for agent readiness in one run. Select tickets by team, label, project, state, assignee, cycle, query string, or updated-since window, then dispatch `ud-linear:linear-agent-score` per ticket with bounded concurrency. Use when asked to score, grade, or sweep a backlog, a team, a project, or a set of tickets — anything plural. Workers also size each ticket and formalize the dependencies they find as `blockedBy` / `blocks` relations, so the report shows the t-shirt size distribution, dependency chains in pickup order, and priority inversions alongside the readiness bands. `--text-changed` re-scores tickets whose text changed since their last score. For a single ticket by id, use `ud-linear:linear-agent-score` directly. Runs unattended and makes no Linear writes of its own beyond the one-time label bootstrap.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-linear/skills/linear-agent-sweep/SKILL.md',
  },
  {
    id: 'ud-linear:linear-agent-unblock',
    plugin: 'ud-linear',
    kind: 'skill',
    name: 'linear-agent-unblock',
    description:
      "Interactively close the agent-readiness gaps on ONE Linear ticket named by its identifier. Reads the ticket's readiness scorecard, researches the gaps an agent may establish on its own, interviews you about the ones only a human can answer, and records your answers as your own Linear comment so the next score run lands higher. Use when asked to unblock, fix, or raise the agent-readiness score of a specific ticket, or to act on what a sweep flagged. Requires a human in the loop. To grade a ticket instead, use `ud-linear:linear-agent-score`; to grade many, use `ud-linear:linear-agent-sweep`.",
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-linear/skills/linear-agent-unblock/SKILL.md',
  },
  {
    id: 'ud-linear:linear-workflow',
    plugin: 'ud-linear',
    kind: 'skill',
    name: 'linear-workflow',
    description:
      "Primary skill for creating tickets and managing Linear structure in this workspace. Use before other Linear or planning skills for ticket creation, project and milestone organization, hierarchy, assignments, and cleanup. Create and edit work in the Unstoppable Domains Linear workspace: projects, milestones, issues, moves, and cleanup. Knows the workspace's teams, product naming, prioritized queue, desktop bug context, and Slack announcement rules. Automatically announces newly created Canopy tickets and Brady-requested assignments or reassignments in #proj-canopy whenever the ticket's final saved status is Prioritized. Scores every new issue created at Brady's request for agent readiness after saving it and reports the review in the same chat.",
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-linear/skills/linear-workflow/SKILL.md',
  },
  {
    id: 'ud-linear:eng-dashboard',
    plugin: 'ud-linear',
    kind: 'command',
    name: 'eng-dashboard',
    description:
      'Generate an engineering team performance dashboard across Velocity, Quality, and Collaboration with AI-powered insights',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-linear/commands/eng-dashboard.md',
  },
  {
    id: 'ud-linear:linear-automation',
    plugin: 'ud-linear',
    kind: 'command',
    name: 'linear-automation',
    description:
      'End-to-end development lifecycle for a Linear ticket or GitHub PR - from triage through merge',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-linear/commands/linear-automation.md',
  },
  {
    id: 'ud-linear:linear-branch',
    plugin: 'ud-linear',
    kind: 'command',
    name: 'linear-branch',
    description: 'Create a branch for a Linear ticket and start implementation',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-linear/commands/linear-branch.md',
  },
  {
    id: 'ud-linear:linear-worktree',
    plugin: 'ud-linear',
    kind: 'command',
    name: 'linear-worktree',
    description:
      'Create a worktree for a Linear ticket and start implementation',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-linear/commands/linear-worktree.md',
  },
  {
    id: 'ud-linear:weekly-update',
    plugin: 'ud-linear',
    kind: 'command',
    name: 'weekly-update',
    description:
      'Generate a weekly status update from Linear tickets and GitHub PRs',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-linear/commands/weekly-update.md',
  },
  {
    id: 'ud-orchard:canopy-babysit',
    plugin: 'ud-orchard',
    kind: 'skill',
    name: 'canopy-babysit',
    description:
      'Mechanics reference for the Boost Coder in a Canopy worktree: per-key hook restoration, required-CI waits, fetched-base checks, review deduplication/adoption, and review-pause escalation. Not a standalone PR workflow. Never merges',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-orchard/skills/canopy-babysit/SKILL.md',
  },
  {
    id: 'ud-orchard:onboard',
    plugin: 'ud-orchard',
    kind: 'command',
    name: 'onboard',
    description:
      'Make a repo available to the UD Boost process — register it as a workspace if needed, explore it to build the per-repo notes file, and ask the user about anything unclear',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-orchard/commands/onboard.md',
  },
  {
    id: 'ud-orchard:setup',
    plugin: 'ud-orchard',
    kind: 'command',
    name: 'setup',
    description:
      'Scaffold and register a UD home workspace and repo notes, and identify the external Boost prerequisite',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-orchard/commands/setup.md',
  },
  {
    id: 'ud-perf:react-memory-patterns',
    plugin: 'ud-perf',
    kind: 'skill',
    name: 'react-memory-patterns',
    description:
      'Proactive guidance on React memory leak anti-patterns. Auto-applies when writing or reviewing React components that use timers, polling, effects, or memoization.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-perf/skills/react-memory-patterns/SKILL.md',
  },
  {
    id: 'ud-perf:memory-audit',
    plugin: 'ud-perf',
    kind: 'command',
    name: 'memory-audit',
    description: '',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-perf/commands/memory-audit.md',
  },
  {
    id: 'ud-planning:interactive-plan',
    plugin: 'ud-planning',
    kind: 'skill',
    name: 'interactive-plan',
    description:
      'Use when the user invokes /interactive-plan. Guides implementation planning through structured codebase exploration followed by sequential one-by-one clarifying questions before writing the final plan.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-planning/skills/interactive-plan/SKILL.md',
  },
  {
    id: 'ud-planning:linear-triage',
    plugin: 'ud-planning',
    kind: 'skill',
    name: 'linear-triage',
    description:
      'Analyze existing Linear tickets for system context, current behavior, and scope. Supporting skill: load ud-linear:linear-workflow first and follow it for all ticket writing and Linear structure changes.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-planning/skills/linear-triage/SKILL.md',
  },
  {
    id: 'ud-rigor-pack:adversarial-verify',
    plugin: 'ud-rigor-pack',
    kind: 'skill',
    name: 'adversarial-verify',
    description:
      'Use after completing any substantive piece of work (code change, analysis, document, configuration, answer to a hard question) and BEFORE presenting it as done. Switches you from author to attacker - you try to refute your own work and only present it if it survives. Do not skip because the work "looks clean"; plausible-but-wrong is the exact failure this kills.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rigor-pack/skills/adversarial-verify/SKILL.md',
  },
  {
    id: 'ud-rigor-pack:live-state-truth',
    plugin: 'ud-rigor-pack',
    kind: 'skill',
    name: 'live-state-truth',
    description:
      "Use whenever you are about to assert or act on a fact about a system - what a function does, what a config is set to, what is deployed, what a table contains, what a dependency's version is. Forces verification against the LIVE system before the assertion. Docs, comments, READMEs, and your own memory are treated as stale by default.",
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rigor-pack/skills/live-state-truth/SKILL.md',
  },
  {
    id: 'ud-rigor-pack:memory-hygiene',
    plugin: 'ud-rigor-pack',
    kind: 'skill',
    name: 'memory-hygiene',
    description:
      'Use when writing to or reading from any persistent memory an agent keeps across sessions - CLAUDE.md, memory files, notes, project docs meant for future sessions. Governs WHAT deserves persisting, HOW to write it so it survives time, and the recall rule: verify remembered facts against live state before acting on them. Use it also when a session starts by loading old memory.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rigor-pack/skills/memory-hygiene/SKILL.md',
  },
  {
    id: 'ud-rigor-pack:plan-gate',
    plugin: 'ud-rigor-pack',
    kind: 'skill',
    name: 'plan-gate',
    description:
      'Use before starting ANY task that involves more than one edit, file, or step - coding, refactoring, writing, configuration, migrations. Forces a short written plan (goal, unknowns, success criteria, step order) BEFORE the first change. Do not use for single-line fixes or pure questions.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rigor-pack/skills/plan-gate/SKILL.md',
  },
  {
    id: 'ud-rigor-pack:ruthless-editor',
    plugin: 'ud-rigor-pack',
    kind: 'skill',
    name: 'ruthless-editor',
    description:
      'Use whenever you produce prose a human will read - documentation, READMEs, reports, summaries, commit messages, emails, blog drafts, PR descriptions. Runs a cutting pass where every sentence must earn its place. Target: 30 percent shorter with zero information loss. Do not use on code or on text the user asked you to preserve verbatim.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rigor-pack/skills/ruthless-editor/SKILL.md',
  },
  {
    id: 'ud-rigor-pack:scope-fence',
    plugin: 'ud-rigor-pack',
    kind: 'skill',
    name: 'scope-fence',
    description:
      'Use on every task where you will modify existing work - code, documents, configs. Fences your changes to exactly what was asked. Adjacent problems get FLAGGED, never silently fixed. Keeps diffs minimal and reviewable. Do not use it to refuse legitimate follow-through the task actually requires.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rigor-pack/skills/scope-fence/SKILL.md',
  },
  {
    id: 'ud-rigor-pack:use-rigor-pack',
    plugin: 'ud-rigor-pack',
    kind: 'skill',
    name: 'use-rigor-pack',
    description:
      'Use as the overall Rigor Pack operating framework for substantial agent work, especially multi-step coding, analysis, writing, configuration, review, or state-changing tasks. Coordinates when and how to apply plan-gate, scope-fence, live-state-truth, adversarial-verify, ruthless-editor, and memory-hygiene across the task lifecycle so rigor is applied where it helps without loading every skill unnecessarily.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rigor-pack/skills/use-rigor-pack/SKILL.md',
  },
  {
    id: 'ud-rust:async-rust',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'async-rust',
    description:
      'Write correct async Rust — runtime choice, Send and Sync bounds, cancellation safety, blocking work inside async contexts, and shared state across tasks. Use when writing or reviewing async code, when a future is held across an await point, when the user hits a Send bound error on a spawned task, when a runtime stalls or deadlocks, or when the user asks about tokio, select!, or spawn_blocking.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/async-rust/SKILL.md',
  },
  {
    id: 'ud-rust:idiomatic-rust',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'idiomatic-rust',
    description:
      'Write Rust that reads like Rust — iterator pipelines over index loops, From/Into over ad-hoc converters, derives over hand-written impls, newtypes over bare primitives. Use when writing new Rust, when reviewing Rust that reads like a translation from another language, or when the user asks how to make Rust code more idiomatic or less repetitive.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/idiomatic-rust/SKILL.md',
  },
  {
    id: 'ud-rust:ownership-not-clone',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'ownership-not-clone',
    description:
      'Use ownership and borrowing instead of reaching for clone, Rc, RefCell, or Arc<Mutex<_>> to silence the borrow checker. Every clone must be explainable. Use when code clones to make an error go away, when a borrow-checker fight is being resolved by copying data, when reviewing Rust dense with .clone() or Rc<RefCell<_>>, or when the user asks whether a clone is necessary.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/ownership-not-clone/SKILL.md',
  },
  {
    id: 'ud-rust:port-from-c',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'port-from-c',
    description:
      'Port C into Rust — recovering the ownership, lifetime, nullability, and length that C never recorded, mapping pointers to references and slices, tag-plus-union to enums, return codes and errno to Result, and linking Rust into the existing build with bindgen and cbindgen. Use when porting, rewriting, or migrating C, a C library, firmware, or a C application into Rust, when replacing C modules one at a time behind the existing build, or when the user asks how a C construct such as malloc, a char pointer, a union, or a preprocessor macro translates to Rust.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/port-from-c/SKILL.md',
  },
  {
    id: 'ud-rust:port-from-cpp',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'port-from-cpp',
    description:
      'Port C++ into Rust — RAII and smart pointers onto ownership, templates onto generics and traits, exceptions onto Result, the STL onto Rust collections, and the traps (move semantics, implicit conversions, undefined behaviour, iterator invalidation). Use when porting, rewriting, or migrating C++, a C++ library, or a C++ application into Rust, when replacing a C++ module with Rust behind the existing build, or when the user asks how a C++ construct such as unique_ptr, shared_ptr, a template, or an STL container translates to Rust.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/port-from-cpp/SKILL.md',
  },
  {
    id: 'ud-rust:port-from-go',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'port-from-go',
    description:
      'Port Go into Rust — goroutines and channels onto tasks and async, interfaces onto traits, error values onto Result, and the value-semantics traps (zero values, integer wraparound, slice aliasing, nil). Use when porting, rewriting, or migrating Go, Golang, a Go service, or a Go CLI into Rust, when replacing a Go component with a Rust one behind the same interface, or when the user asks how a Go construct translates to Rust.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/port-from-go/SKILL.md',
  },
  {
    id: 'ud-rust:port-from-java',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'port-from-java',
    description:
      'Port Java into Rust — class hierarchies onto enums and composition, exceptions onto Result, collections and streams onto Rust equivalents, and the traps (UTF-16 strings, silent integer wraparound, null, equals/hashCode contracts). Use when porting, rewriting, or migrating Java, a JVM service, a Spring or Jakarta application, or a Java library into Rust, when replacing a JVM component with a Rust one behind the same interface, or when the user asks how a Java construct translates to Rust.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/port-from-java/SKILL.md',
  },
  {
    id: 'ud-rust:port-from-python',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'port-from-python',
    description:
      'Port Python into Rust — construct mapping, the semantic traps (integer width, floor division, str versus bytes, exceptions to Result), and the seam, which is a process boundary for a standalone replacement and PyO3 when Python keeps calling the code. Use when porting, rewriting, or migrating Python, CPython, Django, Flask, FastAPI, NumPy, or a Python CLI into Rust, when replacing a Python tool with a Rust binary or a hot Python module with a native extension, or when the user asks how a Python construct translates to Rust.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/port-from-python/SKILL.md',
  },
  {
    id: 'ud-rust:port-from-typescript',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'port-from-typescript',
    description:
      'Port TypeScript or JavaScript into Rust — construct mapping against runtime semantics, the traps (every number is an f64, two kinds of absent, structural typing, regex feature gaps), and the napi-rs and wasm-bindgen boundaries. Use when porting, rewriting, or migrating TypeScript, JavaScript, Node, Deno, Bun, Express, or a JS CLI or library into Rust, when replacing a hot JS module with a native addon or WebAssembly, or when the user asks how a TypeScript or JavaScript construct translates to Rust.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/port-from-typescript/SKILL.md',
  },
  {
    id: 'ud-rust:port-to-rust',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'port-to-rust',
    description:
      'Run a port into Rust without losing behaviour — define the parity contract, sequence the phases, migrate incrementally behind a stable boundary, and prove parity differentially. Use when moving, porting, rewriting, or migrating an existing codebase into Rust from any language, when deciding how to sequence or scope a rewrite, when a port needs to prove it matches its source, or when a partially-ported system needs both implementations running side by side.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/port-to-rust/SKILL.md',
  },
  {
    id: 'ud-rust:rust-api-design',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'rust-api-design',
    description:
      'Design a Rust public API — trait design, generics versus dyn, sealed traits, what is exported, and which changes break semver. Use when designing or reviewing a crate public surface, when choosing between a generic parameter and a trait object, when adding a trait method or enum variant to a released crate, or when the user asks whether a change is a breaking change.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/rust-api-design/SKILL.md',
  },
  {
    id: 'ud-rust:rust-code-review',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'rust-code-review',
    description:
      'Review Rust changes on two axes at once — standards (idioms, ownership, errors, API surface, unsafe) and spec (does the change do what was asked) — with a Rust smell baseline layered on the repo lint configuration. Use when reviewing a Rust diff, pull request, or branch, when asked whether a change is ready to merge, or when a review needs to cover more than what clippy already reports.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/rust-code-review/SKILL.md',
  },
  {
    id: 'ud-rust:rust-concurrency',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'rust-concurrency',
    description:
      'Pick the concurrency model from the workload shape — rayon for data parallelism, scoped threads for borrowed stack data, channels for handoff, shared state last — and use the weakest correct atomic ordering. Use when writing or reviewing threaded Rust, when Mutex, RwLock, atomics, or manual Send/Sync appear, when a deadlock or data race is suspected, or when the user asks how to parallelize Rust code.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/rust-concurrency/SKILL.md',
  },
  {
    id: 'ud-rust:rust-docs',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'rust-docs',
    description:
      'Doc comments as API contract — a one-line first sentence, module-level docs, Examples, Errors, Panics and Safety sections, doctests that actually run, and intra-doc links. Use when writing or reviewing rustdoc comments, when a public item is undocumented, when doctests are marked ignore or fail, when magic values appear undocumented, or when the user asks how to document a Rust crate.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/rust-docs/SKILL.md',
  },
  {
    id: 'ud-rust:rust-errors',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'rust-errors',
    description:
      'Design Rust error types and panic policy — Result over unwrap, thiserror for libraries, anyhow for binaries, context that survives the call stack. Use when code calls unwrap or expect outside tests, when designing or refactoring an error enum, when choosing between thiserror and anyhow, or when the user asks how errors should be handled or propagated.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/rust-errors/SKILL.md',
  },
  {
    id: 'ud-rust:rust-ffi',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'rust-ffi',
    description:
      'Design an FFI boundary meant to last — a thin translation layer with the logic in core crates, no panic across the boundary, explicit ownership on every pointer, repr(transparent) newtypes, and unsafe extern in edition 2024. Use when designing or reviewing a Rust FFI surface, when exposing a Rust library to another language, when a DLL or shared library keeps state, or when the user asks how to shape an extern function.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/rust-ffi/SKILL.md',
  },
  {
    id: 'ud-rust:rust-macros',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'rust-macros',
    description:
      'Write a macro only when a function, a trait, or a generic cannot do the job — then by-example before proc-macro, with hygiene, a `_private` helper module, and spanned compile errors instead of panics. Use when writing or reviewing macro_rules! or a proc macro, when a derive or attribute macro is being added, when macro hygiene or `$crate` comes up, or when the user asks whether something should be a macro.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/rust-macros/SKILL.md',
  },
  {
    id: 'ud-rust:rust-observability',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'rust-observability',
    description:
      'Logs are structured events with named fields, not formatted strings — tracing over log over println!, spans for async context, error chains logged once, and never a secret in a field. Use when adding or reviewing logging, tracing, or metrics in Rust, when println! or string-interpolated log messages appear, when a library installs a subscriber, or when the user asks how to instrument Rust code.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/rust-observability/SKILL.md',
  },
  {
    id: 'ud-rust:rust-performance',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'rust-performance',
    description:
      'Profile before optimizing, cut allocation out of hot paths, and treat LTO, codegen-units, PGO and target-cpu as the last five percent. Use when Rust code is too slow, when a benchmark regresses, when reviewing code that allocates or formats inside a loop, when release-profile or codegen flags come up, or when the user asks how to make Rust faster.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/rust-performance/SKILL.md',
  },
  {
    id: 'ud-rust:rust-serde',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'rust-serde',
    description:
      'Serde as the boundary where untrusted input becomes a domain type — rename_all, default, skip_serializing_if, flatten, the four enum representations, deny_unknown_fields, and try_from validation. Use when deriving Serialize or Deserialize, when choosing an enum wire representation, when a JSON or YAML shape does not match the Rust type, or when the user asks how to validate deserialized data.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/rust-serde/SKILL.md',
  },
  {
    id: 'ud-rust:rust-skills-map',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'rust-skills-map',
    description:
      'The router for this skill set — which Rust skill covers which decision, how they relate, and which one to reach for from where you are.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/rust-skills-map/SKILL.md',
  },
  {
    id: 'ud-rust:rust-supply-chain',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'rust-supply-chain',
    description:
      'Audit a Rust dependency tree — advisories, licences, banned and duplicate crates, and unmaintained dependencies — and turn each finding into a decision. Use when checking whether dependencies are safe to ship, when cargo audit or cargo deny reports something, when adding a dependency to a project with a licence policy, when a build pulls in two versions of the same crate, or when the user asks about supply chain risk in Rust.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/rust-supply-chain/SKILL.md',
  },
  {
    id: 'ud-rust:rust-testing',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'rust-testing',
    description:
      'Design Rust tests that catch real regressions — unit, integration, doc, property, snapshot, and golden tests, and differential tests that prove a port matches its source. Use when writing or reviewing Rust tests, when a change lands without tests, when deciding what form a test should take, when a port needs parity evidence, or when the user asks about proptest, insta, rstest, or test coverage.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/rust-testing/SKILL.md',
  },
  {
    id: 'ud-rust:setup-rust-ci',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'setup-rust-ci',
    description:
      'Write a GitHub Actions workflow for a Rust repo — format, clippy at the configured level, tests, and an MSRV job, derived from the posture the repo already recorded.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/setup-rust-ci/SKILL.md',
  },
  {
    id: 'ud-rust:setup-rust-pre-commit',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'setup-rust-pre-commit',
    description:
      'Set up fast pre-commit hooks for a Rust repo — format and lint the staged changes only, with CI left as the real gate.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/setup-rust-pre-commit/SKILL.md',
  },
  {
    id: 'ud-rust:setup-rust-skills',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'setup-rust-skills',
    description:
      'Configure a Rust repo for this skill set — lint and format configuration, and a recorded project posture (edition, MSRV, async runtime, no_std, unsafe policy) at docs/agents/rust.md.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/setup-rust-skills/SKILL.md',
  },
  {
    id: 'ud-rust:type-driven-design',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'type-driven-design',
    description:
      'Make illegal states unrepresentable — enums instead of boolean and string flags, newtypes instead of bare primitives, parsed types instead of validated ones, typestate for protocol order. Use when a struct has fields that are only valid in some combinations, when validation is re-checked at many call sites, when boolean flags multiply, or when the user asks how to model a domain in Rust.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/type-driven-design/SKILL.md',
  },
  {
    id: 'ud-rust:unsafe-rust',
    plugin: 'ud-rust',
    kind: 'skill',
    name: 'unsafe-rust',
    description:
      'Justify, document, and verify unsafe Rust — safety invariants on every unsafe block, sound safe wrappers, undefined behaviour hazards, and verification with Miri. Use when writing or reviewing unsafe code, when working across an FFI boundary, when raw pointers or transmute appear, when a safe API wraps an unsafe primitive, or when the user asks whether an unsafe block is justified.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-rust/skills/unsafe-rust/SKILL.md',
  },
  {
    id: 'ud-tools:call-cli-tool',
    plugin: 'ud-tools',
    kind: 'skill',
    name: 'call-cli-tool',
    description:
      'Use when invoking a CLI tool from the agent-plugins packages/ directory (e.g., code-review, linear-automation, multi-agent). Handles locating the agent-plugins repo, checking for stale builds, and rebuilding before execution.',
    source:
      'unstoppable-domains-plugins/claude-plugins/ud-tools/skills/call-cli-tool/SKILL.md',
  },
  {
    id: 'agent-sdk-dev:new-sdk-app',
    plugin: 'agent-sdk-dev',
    kind: 'command',
    name: 'new-sdk-app',
    description: 'Create and setup a new Claude Agent SDK application',
    source:
      'claude-plugins-official/plugins/agent-sdk-dev/commands/new-sdk-app.md',
  },
  {
    id: 'claude-code-setup:claude-automation-recommender',
    plugin: 'claude-code-setup',
    kind: 'skill',
    name: 'claude-automation-recommender',
    description:
      'Analyze a codebase and recommend Claude Code automations (hooks, subagents, skills, plugins, MCP servers). Use when user asks for automation recommendations, wants to optimize their Claude Code setup, mentions improving Claude Code workflows, asks how to first set up Claude Code for a project, or wants to know what Claude Code features they should use.',
    source:
      'claude-plugins-official/plugins/claude-code-setup/skills/claude-automation-recommender/SKILL.md',
  },
  {
    id: 'claude-md-management:claude-md-improver',
    plugin: 'claude-md-management',
    kind: 'skill',
    name: 'claude-md-improver',
    description:
      'Audit and improve CLAUDE.md files in repositories. Use when user asks to check, audit, update, improve, or fix CLAUDE.md files. Scans for all CLAUDE.md files, evaluates quality against templates, outputs quality report, then makes targeted updates. Also use when the user mentions "CLAUDE.md maintenance" or "project memory optimization".',
    source:
      'claude-plugins-official/plugins/claude-md-management/skills/claude-md-improver/SKILL.md',
  },
  {
    id: 'claude-md-management:revise-claude-md',
    plugin: 'claude-md-management',
    kind: 'command',
    name: 'revise-claude-md',
    description: 'Update CLAUDE.md with learnings from this session',
    source:
      'claude-plugins-official/plugins/claude-md-management/commands/revise-claude-md.md',
  },
  {
    id: 'claude-security:claude-security',
    plugin: 'claude-security',
    kind: 'skill',
    name: 'claude-security',
    description:
      "Claude Security: scan the codebase (the whole repository or a scoped part of it), scan changes (this branch's or a pull request's diff, or one commit), or suggest patches (findings turned into targeted patch files, each verified by a panel of agents, that you apply when you choose). Use when the user asks to scan, audit or check code with Claude Security, to scan their changes with Claude Security, or to fix or patch Claude Security findings.",
    source:
      'claude-plugins-official/plugins/claude-security/skills/claude-security/SKILL.md',
  },
  {
    id: 'code-modernization:modernize-assess',
    plugin: 'code-modernization',
    kind: 'command',
    name: 'modernize-assess',
    description:
      'What am I dealing with? Inventory, complexity, debt, security and a recommended modernization pattern',
    source:
      'claude-plugins-official/plugins/code-modernization/commands/modernize-assess.md',
  },
  {
    id: 'code-modernization:modernize-brief',
    plugin: 'code-modernization',
    kind: 'command',
    name: 'modernize-brief',
    description:
      'Write the phased Modernization Brief — the plan a steering committee approves and the build commands execute against',
    source:
      'claude-plugins-official/plugins/code-modernization/commands/modernize-brief.md',
  },
  {
    id: 'code-modernization:modernize-extract-rules',
    plugin: 'code-modernization',
    kind: 'command',
    name: 'modernize-extract-rules',
    description:
      'Mine the business rules out of the code into testable Given/When/Then rule cards with file:line citations',
    source:
      'claude-plugins-official/plugins/code-modernization/commands/modernize-extract-rules.md',
  },
  {
    id: 'code-modernization:modernize-harden',
    plugin: 'code-modernization',
    kind: 'command',
    name: 'modernize-harden',
    description:
      'Security scan of the legacy system with a reviewable remediation patch (OWASP, CWE, CVEs, secrets, injection)',
    source:
      'claude-plugins-official/plugins/code-modernization/commands/modernize-harden.md',
  },
  {
    id: 'code-modernization:modernize-map',
    plugin: 'code-modernization',
    kind: 'command',
    name: 'modernize-map',
    description:
      'Show me the structure — dependencies, data flow, entry points and business flows, as an interactive map',
    source:
      'claude-plugins-official/plugins/code-modernization/commands/modernize-map.md',
  },
  {
    id: 'code-modernization:modernize-preflight',
    plugin: 'code-modernization',
    kind: 'command',
    name: 'modernize-preflight',
    description:
      'Run this first — checks the environment, records where the code lives, and says what to fix before anything else runs',
    source:
      'claude-plugins-official/plugins/code-modernization/commands/modernize-preflight.md',
  },
  {
    id: 'code-modernization:modernize-reimagine',
    plugin: 'code-modernization',
    kind: 'command',
    name: 'modernize-reimagine',
    description:
      'Rebuild the system from its extracted intent on a new architecture, with two human checkpoints',
    source:
      'claude-plugins-official/plugins/code-modernization/commands/modernize-reimagine.md',
  },
  {
    id: 'code-modernization:modernize-review',
    plugin: 'code-modernization',
    kind: 'command',
    name: 'modernize-review',
    description:
      "Confirm or correct the business rules that need a person's judgement; the plan and the build read your answers",
    source:
      'claude-plugins-official/plugins/code-modernization/commands/modernize-review.md',
  },
  {
    id: 'code-modernization:modernize-status',
    plugin: 'code-modernization',
    kind: 'command',
    name: 'modernize-status',
    description:
      'Where am I? Progress, what is stale, and the exact next command to run — start here when unsure',
    source:
      'claude-plugins-official/plugins/code-modernization/commands/modernize-status.md',
  },
  {
    id: 'code-modernization:modernize-transform',
    plugin: 'code-modernization',
    kind: 'command',
    name: 'modernize-transform',
    description:
      'Rewrite one legacy module in the target stack, with tests that prove it behaves the same',
    source:
      'claude-plugins-official/plugins/code-modernization/commands/modernize-transform.md',
  },
  {
    id: 'code-modernization:modernize-uplift',
    plugin: 'code-modernization',
    kind: 'command',
    name: 'modernize-uplift',
    description:
      'Same-stack version uplift (e.g. .NET Framework 4.8 to .NET 8, Java 8 to 17) — keep the code, fix the version deltas, prove nothing changed',
    source:
      'claude-plugins-official/plugins/code-modernization/commands/modernize-uplift.md',
  },
  {
    id: 'code-modernization:modernize-verify',
    plugin: 'code-modernization',
    kind: 'command',
    name: 'modernize-verify',
    description:
      'Prove the modernized code behaves like the legacy, with an independent re-check and one verdict per module',
    source:
      'claude-plugins-official/plugins/code-modernization/commands/modernize-verify.md',
  },
  {
    id: 'code-review:code-review',
    plugin: 'code-review',
    kind: 'command',
    name: 'code-review',
    description: 'Code review a pull request',
    source:
      'claude-plugins-official/plugins/code-review/commands/code-review.md',
  },
  {
    id: 'commit-commands:clean_gone',
    plugin: 'commit-commands',
    kind: 'command',
    name: 'clean_gone',
    description:
      'Cleans up all git branches marked as [gone] (branches that have been deleted on the remote but still exist locally), including removing associated worktrees.',
    source:
      'claude-plugins-official/plugins/commit-commands/commands/clean_gone.md',
  },
  {
    id: 'commit-commands:commit-push-pr',
    plugin: 'commit-commands',
    kind: 'command',
    name: 'commit-push-pr',
    description: 'Commit, push, and open a PR',
    source:
      'claude-plugins-official/plugins/commit-commands/commands/commit-push-pr.md',
  },
  {
    id: 'commit-commands:commit',
    plugin: 'commit-commands',
    kind: 'command',
    name: 'commit',
    description: 'Create a git commit',
    source:
      'claude-plugins-official/plugins/commit-commands/commands/commit.md',
  },
  {
    id: 'cwc-makers:cardputer-buddy',
    plugin: 'cwc-makers',
    kind: 'skill',
    name: 'cardputer-buddy',
    description:
      'Iterate on the Cardputer-Adv MicroPython app bundle (Claude Buddy, Snake, Hello) after the device is already provisioned via m5-onboard. Use when the user wants to add a new app, push a single changed .py without re-flashing, watch device serial logs, or run a one-shot REPL command. Trigger on "add an app", "push to the cardputer", "tail the device", "run on the device", or follow-up work after /maker-setup.',
    source:
      'claude-plugins-official/plugins/cwc-makers/skills/cardputer-buddy/SKILL.md',
  },
  {
    id: 'cwc-makers:m5-onboard',
    plugin: 'cwc-makers',
    kind: 'skill',
    name: 'm5-onboard',
    description:
      'End-to-end onboarding for a freshly-plugged-in M5Stack ESP32 device (Cardputer, Cardputer-Adv, Core, CoreS3, Stick) — detect on USB, flash UIFlow 2.0 firmware, and install the Claude Buddy MicroPython app bundle. Use whenever the user plugs in or wants to flash/provision/reset an M5Stack or ESP32 board, or says "m5-onboard go".',
    source:
      'claude-plugins-official/plugins/cwc-makers/skills/m5-onboard/SKILL.md',
  },
  {
    id: 'cwc-makers:maker-setup',
    plugin: 'cwc-makers',
    kind: 'command',
    name: 'maker-setup',
    description:
      'Onboard a Code-with-Claude Makers Cardputer — fetch the build-with-claude repo, flash firmware, and install the Claude Buddy apps.',
    source:
      'claude-plugins-official/plugins/cwc-makers/commands/maker-setup.md',
  },
  {
    id: 'example-plugin:example-command',
    plugin: 'example-plugin',
    kind: 'skill',
    name: 'example-command',
    description:
      'An example user-invoked skill that demonstrates frontmatter options and the skills/<name>/SKILL.md layout',
    source:
      'claude-plugins-official/plugins/example-plugin/skills/example-command/SKILL.md',
  },
  {
    id: 'example-plugin:example-skill',
    plugin: 'example-plugin',
    kind: 'skill',
    name: 'example-skill',
    description:
      'This skill should be used when the user asks to "demonstrate skills", "show skill format", "create a skill template", or discusses skill development patterns. Provides a reference template for creating Claude Code plugin skills.',
    source:
      'claude-plugins-official/plugins/example-plugin/skills/example-skill/SKILL.md',
  },
  {
    id: 'feature-dev:feature-dev',
    plugin: 'feature-dev',
    kind: 'command',
    name: 'feature-dev',
    description:
      'Guided feature development with codebase understanding and architecture focus',
    source:
      'claude-plugins-official/plugins/feature-dev/commands/feature-dev.md',
  },
  {
    id: 'frontend-design:frontend-design',
    plugin: 'frontend-design',
    kind: 'skill',
    name: 'frontend-design',
    description:
      "Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one. Helps with aesthetic direction, typography, and making choices that don't read as templated defaults.",
    source:
      'claude-plugins-official/plugins/frontend-design/skills/frontend-design/SKILL.md',
  },
  {
    id: 'hookify:writing-hookify-rules',
    plugin: 'hookify',
    kind: 'skill',
    name: 'writing-hookify-rules',
    description:
      'This skill should be used when the user asks to "create a hookify rule", "write a hook rule", "configure hookify", "add a hookify rule", or needs guidance on hookify rule syntax and patterns.',
    source:
      'claude-plugins-official/plugins/hookify/skills/writing-rules/SKILL.md',
  },
  {
    id: 'hookify:configure',
    plugin: 'hookify',
    kind: 'command',
    name: 'configure',
    description: 'Enable or disable hookify rules interactively',
    source: 'claude-plugins-official/plugins/hookify/commands/configure.md',
  },
  {
    id: 'hookify:help',
    plugin: 'hookify',
    kind: 'command',
    name: 'help',
    description: 'Get help with the hookify plugin',
    source: 'claude-plugins-official/plugins/hookify/commands/help.md',
  },
  {
    id: 'hookify:hookify',
    plugin: 'hookify',
    kind: 'command',
    name: 'hookify',
    description:
      'Create hooks to prevent unwanted behaviors from conversation analysis or explicit instructions',
    source: 'claude-plugins-official/plugins/hookify/commands/hookify.md',
  },
  {
    id: 'hookify:list',
    plugin: 'hookify',
    kind: 'command',
    name: 'list',
    description: 'List all configured hookify rules',
    source: 'claude-plugins-official/plugins/hookify/commands/list.md',
  },
  {
    id: 'math-olympiad:math-olympiad',
    plugin: 'math-olympiad',
    kind: 'skill',
    name: 'math-olympiad',
    description:
      "Solve competition math problems (IMO, Putnam, USAMO, AIME) with adversarial verification that catches the errors self-verification misses. Activates when asked to 'solve this IMO problem', 'prove this olympiad inequality', 'verify this competition proof', 'find a counterexample', 'is this proof correct', or for any problem with 'IMO', 'Putnam', 'USAMO', 'olympiad', or 'competition math' in it. Uses pure reasoning (no tools) — then a fresh-context adversarial verifier attacks the proof using specific failure patterns, not generic 'check logic'. Outputs calibrated confidence — will say 'no confident solution' rather than bluff. If LaTeX is available, produces a clean PDF after verification passes.",
    source:
      'claude-plugins-official/plugins/math-olympiad/skills/math-olympiad/SKILL.md',
  },
  {
    id: 'math-proof:siege',
    plugin: 'math-proof',
    kind: 'skill',
    name: 'siege',
    description:
      'Work on one hard mathematics problem in rounds: each round a judge writes a few self-contained questions, independent workers answer them, and the judge keeps a ledger of what is proved, refuted and open, until the judge concludes or the rounds run out, and then a proof.md says plainly what is and is not proved. A run takes hours and dozens of worker runs. Usage: /math-proof:siege [NAME=value settings] <the problem, stated in full, or the path of a file holding it>.',
    source: 'claude-plugins-official/plugins/math-proof/skills/siege/SKILL.md',
  },
  {
    id: 'math-proof:solo',
    plugin: 'math-proof',
    kind: 'skill',
    name: 'solo',
    description:
      'Work on one hard mathematics problem in this session yourself, with no sub-agents: reason in stages, record each settled step in a notes file so that nothing written is lost if a response is cut off, and end with a self-contained proof.md. Usage: /math-proof:solo <the problem, stated in full, or the path of a file holding it>.',
    source: 'claude-plugins-official/plugins/math-proof/skills/solo/SKILL.md',
  },
  {
    id: 'mcp-server-dev:build-mcp-app',
    plugin: 'mcp-server-dev',
    kind: 'skill',
    name: 'build-mcp-app',
    description:
      'This skill should be used when the user wants to build an "MCP app", add "interactive UI" or "widgets" to an MCP server, "render components in chat", build "MCP UI resources", make a tool that shows a "form", "picker", "dashboard" or "confirmation dialog" inline in the conversation, or mentions "apps SDK" in the context of MCP. Use AFTER the build-mcp-server skill has settled the deployment model, or when the user already knows they want UI widgets.',
    source:
      'claude-plugins-official/plugins/mcp-server-dev/skills/build-mcp-app/SKILL.md',
  },
  {
    id: 'mcp-server-dev:build-mcp-server',
    plugin: 'mcp-server-dev',
    kind: 'skill',
    name: 'build-mcp-server',
    description:
      'This skill should be used when the user asks to "build an MCP server", "create an MCP", "make an MCP integration", "wrap an API for Claude", "expose tools to Claude", "make an MCP app", or discusses building something with the Model Context Protocol. It is the entry point for MCP server development — it interrogates the user about their use case, determines the right deployment model (remote HTTP, MCPB, local stdio), picks a tool-design pattern, and hands off to specialized skills.',
    source:
      'claude-plugins-official/plugins/mcp-server-dev/skills/build-mcp-server/SKILL.md',
  },
  {
    id: 'mcp-server-dev:build-mcpb',
    plugin: 'mcp-server-dev',
    kind: 'skill',
    name: 'build-mcpb',
    description:
      'This skill should be used when the user wants to "package an MCP server", "bundle an MCP", "make an MCPB", "ship a local MCP server", "distribute a local MCP", discusses ".mcpb files", mentions bundling a Node or Python runtime with their MCP server, or needs an MCP server that interacts with the local filesystem, desktop apps, or OS and must be installable without the user having Node/Python set up.',
    source:
      'claude-plugins-official/plugins/mcp-server-dev/skills/build-mcpb/SKILL.md',
  },
  {
    id: 'mcp-tunnels:create-docker-mcp-tunnel',
    plugin: 'mcp-tunnels',
    kind: 'command',
    name: 'create-docker-mcp-tunnel',
    description:
      'Stand up an Anthropic MCP tunnel locally with Docker Compose so Claude can call a private MCP server (manual-credentials quickstart).',
    source:
      'claude-plugins-official/plugins/mcp-tunnels/commands/create-docker-mcp-tunnel.md',
  },
  {
    id: 'playground:playground',
    plugin: 'playground',
    kind: 'skill',
    name: 'playground',
    description:
      'Creates interactive HTML playgrounds — self-contained single-file explorers that let users configure something visually through controls, see a live preview, and copy out a prompt. Use when the user asks to make a playground, explorer, or interactive tool for a topic.',
    source:
      'claude-plugins-official/plugins/playground/skills/playground/SKILL.md',
  },
  {
    id: 'plugin-dev:agent-development',
    plugin: 'plugin-dev',
    kind: 'skill',
    name: 'agent-development',
    description:
      'This skill should be used when the user asks to "create an agent", "add an agent", "write a subagent", "agent frontmatter", "when to use description", "agent examples", "agent tools", "agent colors", "autonomous agent", or needs guidance on agent structure, system prompts, triggering conditions, or agent development best practices for Claude Code plugins.',
    source:
      'claude-plugins-official/plugins/plugin-dev/skills/agent-development/SKILL.md',
  },
  {
    id: 'plugin-dev:command-development',
    plugin: 'plugin-dev',
    kind: 'skill',
    name: 'command-development',
    description:
      'This skill should be used when the user asks to "create a slash command", "add a command", "write a custom command", "define command arguments", "use command frontmatter", "organize commands", "create command with file references", "interactive command", "use AskUserQuestion in command", or needs guidance on slash command structure, YAML frontmatter fields, dynamic arguments, bash execution in commands, user interaction patterns, or command development best practices for Claude Code.',
    source:
      'claude-plugins-official/plugins/plugin-dev/skills/command-development/SKILL.md',
  },
  {
    id: 'plugin-dev:hook-development',
    plugin: 'plugin-dev',
    kind: 'skill',
    name: 'hook-development',
    description:
      'This skill should be used when the user asks to "create a hook", "add a PreToolUse/PostToolUse/Stop hook", "validate tool use", "implement prompt-based hooks", "use ${CLAUDE_PLUGIN_ROOT}", "set up event-driven automation", "block dangerous commands", or mentions hook events (PreToolUse, PostToolUse, Stop, SubagentStop, SessionStart, SessionEnd, UserPromptSubmit, PreCompact, Notification). Provides comprehensive guidance for creating and implementing Claude Code plugin hooks with focus on advanced prompt-based hooks API.',
    source:
      'claude-plugins-official/plugins/plugin-dev/skills/hook-development/SKILL.md',
  },
  {
    id: 'plugin-dev:mcp-integration',
    plugin: 'plugin-dev',
    kind: 'skill',
    name: 'mcp-integration',
    description:
      'This skill should be used when the user asks to "add MCP server", "integrate MCP", "configure MCP in plugin", "use .mcp.json", "set up Model Context Protocol", "connect external service", mentions "${CLAUDE_PLUGIN_ROOT} with MCP", or discusses MCP server types (SSE, stdio, HTTP, WebSocket). Provides comprehensive guidance for integrating Model Context Protocol servers into Claude Code plugins for external tool and service integration.',
    source:
      'claude-plugins-official/plugins/plugin-dev/skills/mcp-integration/SKILL.md',
  },
  {
    id: 'plugin-dev:plugin-settings',
    plugin: 'plugin-dev',
    kind: 'skill',
    name: 'plugin-settings',
    description:
      'This skill should be used when the user asks about "plugin settings", "store plugin configuration", "user-configurable plugin", ".local.md files", "plugin state files", "read YAML frontmatter", "per-project plugin settings", or wants to make plugin behavior configurable. Documents the .claude/plugin-name.local.md pattern for storing plugin-specific configuration with YAML frontmatter and markdown content.',
    source:
      'claude-plugins-official/plugins/plugin-dev/skills/plugin-settings/SKILL.md',
  },
  {
    id: 'plugin-dev:plugin-structure',
    plugin: 'plugin-dev',
    kind: 'skill',
    name: 'plugin-structure',
    description:
      'This skill should be used when the user asks to "create a plugin", "scaffold a plugin", "understand plugin structure", "organize plugin components", "set up plugin.json", "use ${CLAUDE_PLUGIN_ROOT}", "add commands/agents/skills/hooks", "configure auto-discovery", or needs guidance on plugin directory layout, manifest configuration, component organization, file naming conventions, or Claude Code plugin architecture best practices.',
    source:
      'claude-plugins-official/plugins/plugin-dev/skills/plugin-structure/SKILL.md',
  },
  {
    id: 'plugin-dev:skill-development',
    plugin: 'plugin-dev',
    kind: 'skill',
    name: 'skill-development',
    description:
      'This skill should be used when the user wants to "create a skill", "add a skill to plugin", "write a new skill", "improve skill description", "organize skill content", or needs guidance on skill structure, progressive disclosure, or skill development best practices for Claude Code plugins.',
    source:
      'claude-plugins-official/plugins/plugin-dev/skills/skill-development/SKILL.md',
  },
  {
    id: 'plugin-dev:create-plugin',
    plugin: 'plugin-dev',
    kind: 'command',
    name: 'create-plugin',
    description:
      'Guided end-to-end plugin creation workflow with component design, implementation, and validation',
    source:
      'claude-plugins-official/plugins/plugin-dev/commands/create-plugin.md',
  },
  {
    id: 'pr-review-toolkit:review-pr',
    plugin: 'pr-review-toolkit',
    kind: 'command',
    name: 'review-pr',
    description: 'Comprehensive PR review using specialized agents',
    source:
      'claude-plugins-official/plugins/pr-review-toolkit/commands/review-pr.md',
  },
  {
    id: 'ralph-loop:cancel-ralph',
    plugin: 'ralph-loop',
    kind: 'command',
    name: 'cancel-ralph',
    description: 'Cancel active Ralph Loop',
    source:
      'claude-plugins-official/plugins/ralph-loop/commands/cancel-ralph.md',
  },
  {
    id: 'ralph-loop:help',
    plugin: 'ralph-loop',
    kind: 'command',
    name: 'help',
    description: 'Explain Ralph Loop plugin and available commands',
    source: 'claude-plugins-official/plugins/ralph-loop/commands/help.md',
  },
  {
    id: 'ralph-loop:ralph-loop',
    plugin: 'ralph-loop',
    kind: 'command',
    name: 'ralph-loop',
    description: 'Start Ralph Loop in current session',
    source: 'claude-plugins-official/plugins/ralph-loop/commands/ralph-loop.md',
  },
  {
    id: 'receipts:receipts',
    plugin: 'receipts',
    kind: 'skill',
    name: 'receipts',
    description:
      'Generate a personal Claude Code usage & impact report ("receipts") from this machine\'s local session transcripts — for justifying Claude Code usage/spend to a manager, self-review, or "what have I been using this for" check-ins. Mines ~/.claude/projects locally (no extra API calls beyond one final write-up), cross-references local git history, and writes a markdown report plus a self-contained HTML receipt to your home directory. Use when the user asks for "receipts", an "impact report", "usage report", wants to "show my Claude Code activity", "prove the value of Claude Code", or runs `/receipts`.',
    source: 'claude-plugins-official/plugins/receipts/skills/receipts/SKILL.md',
  },
  {
    id: 'session-report:session-report',
    plugin: 'session-report',
    kind: 'skill',
    name: 'session-report',
    description:
      'Generate an explorable HTML report of Claude Code session usage (tokens, cache, subagents, skills, expensive prompts) from ~/.claude/projects transcripts.',
    source:
      'claude-plugins-official/plugins/session-report/skills/session-report/SKILL.md',
  },
  {
    id: 'skill-creator:skill-creator',
    plugin: 'skill-creator',
    kind: 'skill',
    name: 'skill-creator',
    description:
      "Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, or optimize a skill's description for better triggering accuracy.",
    source:
      'claude-plugins-official/plugins/skill-creator/skills/skill-creator/SKILL.md',
  },
  {
    id: 'slack:slack-messaging',
    plugin: 'slack',
    kind: 'skill',
    name: 'slack-messaging',
    description:
      'Guidance for composing well-formatted, effective Slack messages using standard markdown',
    source: 'claude-plugins-official/slack/skills/slack-messaging/SKILL.md',
  },
  {
    id: 'slack:slack-search',
    plugin: 'slack',
    kind: 'skill',
    name: 'slack-search',
    description:
      'Guidance for effectively searching Slack to find messages, files, channels, and people',
    source: 'claude-plugins-official/slack/skills/slack-search/SKILL.md',
  },
  {
    id: 'slack:channel-digest',
    plugin: 'slack',
    kind: 'command',
    name: 'channel-digest',
    description:
      'Get a digest of recent activity across multiple Slack channels',
    source: 'claude-plugins-official/slack/commands/channel-digest.md',
  },
  {
    id: 'slack:draft-announcement',
    plugin: 'slack',
    kind: 'command',
    name: 'draft-announcement',
    description:
      'Draft a well-formatted Slack announcement and save it as a draft',
    source: 'claude-plugins-official/slack/commands/draft-announcement.md',
  },
  {
    id: 'slack:find-discussions',
    plugin: 'slack',
    kind: 'command',
    name: 'find-discussions',
    description:
      'Find discussions about a specific topic across Slack channels',
    source: 'claude-plugins-official/slack/commands/find-discussions.md',
  },
  {
    id: 'slack:standup',
    plugin: 'slack',
    kind: 'command',
    name: 'standup',
    description:
      'Generate a standup update based on your recent Slack activity',
    source: 'claude-plugins-official/slack/commands/standup.md',
  },
  {
    id: 'slack:summarize-channel',
    plugin: 'slack',
    kind: 'command',
    name: 'summarize-channel',
    description: 'Summarize recent activity in a Slack channel',
    source: 'claude-plugins-official/slack/commands/summarize-channel.md',
  },
  {
    id: 'superpowers:brainstorming',
    plugin: 'superpowers',
    kind: 'skill',
    name: 'brainstorming',
    description:
      'You MUST use this before any creative work - creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements and design before implementation.',
    source: 'superpowers/skills/brainstorming/SKILL.md',
  },
  {
    id: 'superpowers:dispatching-parallel-agents',
    plugin: 'superpowers',
    kind: 'skill',
    name: 'dispatching-parallel-agents',
    description:
      'Use when facing 2+ independent tasks that can be worked on without shared state or sequential dependencies',
    source: 'superpowers/skills/dispatching-parallel-agents/SKILL.md',
  },
  {
    id: 'superpowers:executing-plans',
    plugin: 'superpowers',
    kind: 'skill',
    name: 'executing-plans',
    description:
      'Use when you have a written implementation plan to execute in a separate session with review checkpoints',
    source: 'superpowers/skills/executing-plans/SKILL.md',
  },
  {
    id: 'superpowers:finishing-a-development-branch',
    plugin: 'superpowers',
    kind: 'skill',
    name: 'finishing-a-development-branch',
    description:
      'Use when implementation is complete, all tests pass, and you need to decide how to integrate the work - guides completion of development work by presenting structured options for merge, PR, or cleanup',
    source: 'superpowers/skills/finishing-a-development-branch/SKILL.md',
  },
  {
    id: 'superpowers:receiving-code-review',
    plugin: 'superpowers',
    kind: 'skill',
    name: 'receiving-code-review',
    description:
      'Use when receiving code review feedback, before implementing suggestions, especially if feedback seems unclear or technically questionable - requires technical rigor and verification, not performative agreement or blind implementation',
    source: 'superpowers/skills/receiving-code-review/SKILL.md',
  },
  {
    id: 'superpowers:requesting-code-review',
    plugin: 'superpowers',
    kind: 'skill',
    name: 'requesting-code-review',
    description:
      'Use when completing tasks, implementing major features, or before merging to verify work meets requirements',
    source: 'superpowers/skills/requesting-code-review/SKILL.md',
  },
  {
    id: 'superpowers:subagent-driven-development',
    plugin: 'superpowers',
    kind: 'skill',
    name: 'subagent-driven-development',
    description:
      'Use when executing implementation plans with independent tasks in the current session',
    source: 'superpowers/skills/subagent-driven-development/SKILL.md',
  },
  {
    id: 'superpowers:systematic-debugging',
    plugin: 'superpowers',
    kind: 'skill',
    name: 'systematic-debugging',
    description:
      'Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes',
    source: 'superpowers/skills/systematic-debugging/SKILL.md',
  },
  {
    id: 'superpowers:test-driven-development',
    plugin: 'superpowers',
    kind: 'skill',
    name: 'test-driven-development',
    description:
      'Use when implementing any feature or bugfix, before writing implementation code',
    source: 'superpowers/skills/test-driven-development/SKILL.md',
  },
  {
    id: 'superpowers:using-git-worktrees',
    plugin: 'superpowers',
    kind: 'skill',
    name: 'using-git-worktrees',
    description:
      'Use when starting feature work that needs isolation from current workspace or before executing implementation plans - creates isolated git worktrees with smart directory selection and safety verification',
    source: 'superpowers/skills/using-git-worktrees/SKILL.md',
  },
  {
    id: 'superpowers:using-superpowers',
    plugin: 'superpowers',
    kind: 'skill',
    name: 'using-superpowers',
    description:
      'Use when starting any conversation - establishes how to find and use skills, requiring Skill tool invocation before ANY response including clarifying questions',
    source: 'superpowers/skills/using-superpowers/SKILL.md',
  },
  {
    id: 'superpowers:verification-before-completion',
    plugin: 'superpowers',
    kind: 'skill',
    name: 'verification-before-completion',
    description:
      'Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output before making any success claims; evidence before assertions always',
    source: 'superpowers/skills/verification-before-completion/SKILL.md',
  },
  {
    id: 'superpowers:writing-plans',
    plugin: 'superpowers',
    kind: 'skill',
    name: 'writing-plans',
    description:
      'Use when you have a spec or requirements for a multi-step task, before touching code',
    source: 'superpowers/skills/writing-plans/SKILL.md',
  },
  {
    id: 'superpowers:writing-skills',
    plugin: 'superpowers',
    kind: 'skill',
    name: 'writing-skills',
    description:
      'Use when creating new skills, editing existing skills, or verifying skills work before deployment',
    source: 'superpowers/skills/writing-skills/SKILL.md',
  },
  {
    id: 'superpowers:brainstorm',
    plugin: 'superpowers',
    kind: 'command',
    name: 'brainstorm',
    description: 'Deprecated - use the superpowers:brainstorming skill instead',
    source: 'superpowers/commands/brainstorm.md',
  },
  {
    id: 'superpowers:execute-plan',
    plugin: 'superpowers',
    kind: 'command',
    name: 'execute-plan',
    description:
      'Deprecated - use the superpowers:executing-plans skill instead',
    source: 'superpowers/commands/execute-plan.md',
  },
  {
    id: 'superpowers:write-plan',
    plugin: 'superpowers',
    kind: 'command',
    name: 'write-plan',
    description: 'Deprecated - use the superpowers:writing-plans skill instead',
    source: 'superpowers/commands/write-plan.md',
  },
  {
    id: 'posthog:adding-warehouse-person-properties',
    plugin: 'posthog',
    kind: 'skill',
    name: 'adding-warehouse-person-properties',
    description:
      'Sync columns from a synced data warehouse table onto PostHog person or group properties, so warehouse data becomes usable anywhere person and group properties already work: feature flag targeting, cohorts, insight filters and breakdowns, surveys, session replay filters, workflows, and the person profile. Use when the user wants to "add a person property from my warehouse", "enrich people with Stripe/Postgres/Salesforce data", "put ARR or plan tier on my persons", "target a feature flag by a warehouse column", "sync warehouse columns onto groups or organizations", or wants to inspect, backfill, disable, or debug an existing warehouse-backed person or group property.',
    source:
      'PostHog/ai-plugin/skills/adding-warehouse-person-properties/SKILL.md',
  },
  {
    id: 'posthog:analyzing-expensive-users',
    plugin: 'posthog',
    kind: 'skill',
    name: 'analyzing-expensive-users',
    description:
      'Analyze the most expensive users in AI observability and explain why they cost so much. Use when the user asks about top spenders, expensive users, per-user LLM cost, user-level cost drivers, or patterns behind high AI observability spend.',
    source: 'PostHog/ai-plugin/skills/analyzing-expensive-users/SKILL.md',
  },
  {
    id: 'posthog:analyzing-experiment-session-replays',
    plugin: 'posthog',
    kind: 'skill',
    name: 'analyzing-experiment-session-replays',
    description:
      'Analyze session replay patterns across experiment variants to understand user behavior differences. Use when the user wants to see how users interact with different experiment variants, identify usability issues, compare behavior patterns between control and test groups, or get qualitative insights to complement quantitative experiment results. Also covers pairing the observed behavior with a linked survey when the user wants qualitative feedback beyond what recordings show.',
    source:
      'PostHog/ai-plugin/skills/analyzing-experiment-session-replays/SKILL.md',
  },
  {
    id: 'posthog:analyzing-funnel-correlation',
    plugin: 'posthog',
    kind: 'skill',
    name: 'analyzing-funnel-correlation',
    description:
      'Find the events and person properties that correlate with funnel conversion or drop-off. Use when the user asks why people convert or drop off in a funnel, what converters do differently, which events or properties predict success or failure, or asks for "correlation analysis" on a funnel. Computes odds ratios with HogQL, because PostHog has no built-in funnel correlation view.',
    source: 'PostHog/ai-plugin/skills/analyzing-funnel-correlation/SKILL.md',
  },
  {
    id: 'posthog:analyzing-offline-evaluations',
    plugin: 'posthog',
    kind: 'skill',
    name: 'analyzing-offline-evaluations',
    description:
      'Inspect and compare offline AI evaluation experiments, diagnose case-level regressions, and follow scorer history across application, model, or prompt changes. Use when a user asks whether an offline run improved, why a case failed, how scores changed between runs, or how to publish externally computed offline results. Covers immutable scorer versions, comparable dataset cohorts, incomplete coverage, and selective payload reads.',
    source: 'PostHog/ai-plugin/skills/analyzing-offline-evaluations/SKILL.md',
  },
  {
    id: 'posthog:analyzing-task-runs',
    plugin: 'posthog',
    kind: 'skill',
    name: 'analyzing-task-runs',
    description:
      'Split a completed PostHog task run into activity records — what the agent tried, whether it worked, what blocked it — and record each one through the report_activity tool. Use when a task asks to analyze a run, produce a task analysis, or review a run from an attached run log. Covers the log query protocol (bounded jq queries over the raw JSONL), both log schemas, the activity schema, and evidence verification. Records facts only; it does not suggest fixes.',
    source: 'PostHog/ai-plugin/skills/analyzing-task-runs/SKILL.md',
  },
  {
    id: 'posthog:assessing-heatmaps',
    plugin: 'posthog',
    kind: 'skill',
    name: 'assessing-heatmaps',
    description:
      "Assesses what a page's heatmap is telling you and recommends concrete changes. Pulls click / rageclick / scroll-depth data for a URL, names the hot elements by cross-referencing autocapture events on the same page, and can create a saved heatmap the user opens in PostHog, then summarizes the behavior and proposes improvements.\nTRIGGER when: user asks what a heatmap shows, why people aren't clicking something, where users rage-click, how far they scroll, what to change on a page based on heatmap/click data, or to 'analyze/assess/review the heatmap' for a URL.\nDO NOT TRIGGER when: the user only wants to create a saved heatmap screenshot with no analysis (use heatmaps-saved-create directly), or is asking about session replay in general (use investigating-replay).",
    source: 'PostHog/ai-plugin/skills/assessing-heatmaps/SKILL.md',
  },
  {
    id: 'posthog:auditing-endpoints',
    plugin: 'posthog',
    kind: 'skill',
    name: 'auditing-endpoints',
    description:
      'Audit every endpoint in a PostHog project for staleness, failed materialisations, and unused materialised versions. Use when the user asks "what endpoints can I clean up?", "are any of my endpoints broken?", "which materialised versions are still being called?", or wants a one-shot cleanup pass over the Endpoints product. Produces a prioritised report grouped by issue type, with recommended actions but does not modify anything without explicit confirmation.',
    source: 'PostHog/ai-plugin/skills/auditing-endpoints/SKILL.md',
  },
  {
    id: 'posthog:auditing-experiments-flags',
    plugin: 'posthog',
    kind: 'skill',
    name: 'auditing-experiments-flags',
    description:
      'Audit PostHog experiments and feature flags for configuration issues, staleness, and best-practice violations. Read when the user asks to audit, health-check, or review experiments or feature flags, check flag hygiene, or verify experiment setup.',
    source: 'PostHog/ai-plugin/skills/auditing-experiments-flags/SKILL.md',
  },
  {
    id: 'posthog:auditing-warehouse-source-health',
    plugin: 'posthog',
    kind: 'skill',
    name: 'auditing-warehouse-source-health',
    description:
      'Audit the health of a PostHog project\'s data warehouse sources and syncs — find every broken or degraded source connection, sync schema, and webhook channel. Use when the user asks "why are my imports failing?", "what\'s broken with my sources?", "why is my warehouse data stale?", or wants a one-shot triage of source/sync health before deciding where to dig in. Produces a prioritized report grouped by severity, with recommended next steps. For materialized-view health use `auditing-warehouse-view-health`; for a single failing sync use `diagnosing-failed-warehouse-syncs`.',
    source:
      'PostHog/ai-plugin/skills/auditing-warehouse-source-health/SKILL.md',
  },
  {
    id: 'posthog:auditing-warehouse-view-health',
    plugin: 'posthog',
    kind: 'skill',
    name: 'auditing-warehouse-view-health',
    description:
      'Audit the health of a PostHog project\'s materialized views (saved queries) — find every failed materialization and flag unused or stale materialized views that cost storage and compute. Use when the user asks "which of my views are broken?", "why is this materialized view failing?", "are any of my views wasting compute?", or wants a one-shot triage of view health. For source/sync health use `auditing-warehouse-source-health`.',
    source: 'PostHog/ai-plugin/skills/auditing-warehouse-view-health/SKILL.md',
  },
  {
    id: 'posthog:authoring-data-quality-checks',
    plugin: 'posthog',
    kind: 'skill',
    name: 'authoring-data-quality-checks',
    description:
      "Adds and runs data quality checks (dbt-test style assertions) on a project's warehouse tables and saved-query views, and HogQL catalog metrics: not-null, uniqueness, accepted values, referential integrity, row-count bounds, freshness, and custom HogQL. Metrics support custom SQL checks only. Use when asked to test a model, validate a view, check for nulls or duplicates, add data quality checks, find out why a number looks wrong, or judge whether a warehouse table is trustworthy before using it in an analysis. To describe what data *means* (metrics, certifications, joins), see setting-up-data-catalog instead. Trigger terms: data quality, data test, dbt test, not null check, uniqueness check, freshness check, referential integrity, row count check, validate model, is this table trustworthy.",
    source: 'PostHog/ai-plugin/skills/authoring-data-quality-checks/SKILL.md',
  },
  {
    id: 'posthog:authoring-error-tracking-alerts',
    plugin: 'posthog',
    kind: 'skill',
    name: 'authoring-error-tracking-alerts',
    description:
      'Author error tracking alerts that fire when an issue is created, reopened, or starts spiking. Use when the user asks to set up error notifications, route exceptions to Slack/webhook/Linear, or evaluate which error events are worth alerting on. Covers trigger-event selection, integration choice, dedup against existing alerts, and shipping with the canonical message body shape.',
    source: 'PostHog/ai-plugin/skills/authoring-error-tracking-alerts/SKILL.md',
  },
  {
    id: 'posthog:authoring-log-alerts',
    plugin: 'posthog',
    kind: 'skill',
    name: 'authoring-log-alerts',
    description:
      'Author useful, low-noise log alerts on services in a PostHog project. Use when the user asks to set up alerts for their logs, suggest alerts they should add, or evaluate whether a service is worth monitoring. Covers service triage, baseline characterisation, threshold drafting, back-testing via simulate, and shipping with a notification destination.',
    source: 'PostHog/ai-plugin/skills/authoring-log-alerts/SKILL.md',
  },
  {
    id: 'posthog:authoring-scouts',
    plugin: 'posthog',
    kind: 'skill',
    name: 'authoring-scouts',
    description:
      'Write, edit, and adapt PostHog Signals scouts: scheduled agents that scan a project and report findings. Use to change a canonical scout\'s scope, thresholds, schedule, or dry-run settings; add a scout for an uncovered surface; record structured output from scheduled LLM scoring; or give feedback through notes. Covers SKILL.md structure, report requirements, follow-up report checks, structured output, duplicate detection, scratchpad memory, scout notes, per-team skills-store and canonical repository edits, and private prompt trials with saved rubrics. Trigger on "write/edit/customize a signals scout", "new scout for X", "tune my scout schedule", "make a scout that watches <event>", "score/judge/measure X with a scout", "test/compare scout prompts", "generate scout rubrics", "structured output from a scout", "scout output to Slack", "leave a note for / give feedback to a scout".',
    source: 'PostHog/ai-plugin/skills/authoring-scouts/SKILL.md',
  },
  {
    id: 'posthog:building-a-dashboard',
    plugin: 'posthog',
    kind: 'skill',
    name: 'building-a-dashboard',
    description:
      "Build a new dashboard, or update an existing one, from a set of insights — the same job the in-app assistant does with its upsert-dashboard tool, but over MCP. Use when a user asks to create a dashboard, put several metrics/charts together on one page, assemble a dashboard for a topic (product analytics, retention, revenue, activation, etc.), or add/remove/replace insights on a dashboard they already have. Covers deciding create vs update, reusing existing insights vs creating new ones, and using PostHog's vetted dashboard templates as reference for what a strong dashboard on a topic looks like.",
    source: 'PostHog/ai-plugin/skills/building-a-dashboard/SKILL.md',
  },
  {
    id: 'posthog:building-canvases',
    plugin: 'posthog',
    kind: 'skill',
    name: 'building-canvases',
    description:
      'Create or edit a PostHog freeform canvas — a sandboxed browser application (data board, document, form, small tool, graphics experiment) stored in PostHog and rendered by the desktop/web app. Use when a task asks to build, generate, update, or fix a standalone canvas app, or when a freeform canvas id is given as the publish target. For grid/home canvases, widget placements, or reusable components, use composing-grid-canvases instead. Covers resolving or creating the target canvas, choosing an implementation approach (React + Quill vs plain HTML/browser APIs), the read → edit → validate → publish → build loop, and which companion canvas skills to load for the details.',
    source: 'PostHog/ai-plugin/skills/building-canvases/SKILL.md',
  },
  {
    id: 'posthog:building-html-canvases',
    plugin: 'posthog',
    kind: 'skill',
    name: 'building-html-canvases',
    description:
      'Author a PostHog canvas with semantic HTML, CSS, and direct browser APIs — documents, articles, generative graphics, 2D canvas and WebGL experiences, and focused experiments where React components add no useful structure. Use after building-canvases has routed a canvas request to a plain-HTML/browser-API implementation. Covers the thin component wrapper the current runtime requires, styling and theming without Quill, drawing surfaces, and animation/cleanup patterns.',
    source: 'PostHog/ai-plugin/skills/building-html-canvases/SKILL.md',
  },
  {
    id: 'posthog:building-loops',
    plugin: 'posthog',
    kind: 'skill',
    name: 'building-loops',
    description:
      "Build a Loop for PostHog Desktop: a workflow that creates an AI task each time its trigger fires, optionally followed by a Slack or email notification with the task's result. Use when asked to create, set up, or change a loop, a recurring agent, a scheduled task, or an automation that runs an AI task when a GitHub, Slack, or PostHog event happens. Covers the exact graph, trigger configs, schedule presets, the notify step, structured output, and the test-run steps.",
    source: 'PostHog/ai-plugin/skills/building-loops/SKILL.md',
  },
  {
    id: 'posthog:building-react-quill-canvases',
    plugin: 'posthog',
    kind: 'skill',
    name: 'building-react-quill-canvases',
    description:
      "Author the React + Quill implementation of a PostHog canvas: the single-component contract, the allowed imports, Quill (PostHog's design system) component and composition rules, theme-aware design tokens, loading skeletons, and the in-canvas date picker. Use after building-canvases has routed a canvas request to a React implementation — dashboards, data boards, forms, tools, or any canvas that should look native to PostHog.",
    source: 'PostHog/ai-plugin/skills/building-react-quill-canvases/SKILL.md',
  },
  {
    id: 'posthog:building-workflows',
    plugin: 'posthog',
    kind: 'skill',
    name: 'building-workflows',
    description:
      'Build, edit, test, enable, and monitor PostHog workflows over MCP. Author the action/edge graph so it runs and opens cleanly in the visual editor, then change drafts surgically with patch operations. Use when asked to build, set up, automate, change, fix, or debug a workflow, campaign, broadcast, drip sequence, or event-triggered automation in the workflows product, including first-time messaging setup (email channel, sending domain, frequency cap) before the first workflow.',
    source: 'PostHog/ai-plugin/skills/building-workflows/SKILL.md',
  },
  {
    id: 'posthog:checking-deploy-timing',
    plugin: 'posthog',
    kind: 'skill',
    name: 'checking-deploy-timing',
    description:
      'Determine when a PostHog code change reached a given environment by reading the hidden GIT deploy annotations in the project and correlating them with the merge commit on GitHub. Use when PostHog staff ask "when was X deployed", "is my change live in the US/EU yet", "has my PR shipped", "did the fix roll out to prod-us", or otherwise want to know whether/when a commit, PR, or feature went out to a region. Do not answer deploy-timing questions from event/data volume alone — that only shows when data changed, not when code shipped.',
    source: 'PostHog/ai-plugin/skills/checking-deploy-timing/SKILL.md',
  },
  {
    id: 'posthog:checking-member-access',
    plugin: 'posthog',
    kind: 'skill',
    name: 'checking-member-access',
    description:
      "Explains what a member or a role can do in a PostHog project, using the access control MCP tools. Use when the user asks what someone can see or edit, who can edit dashboards or feature flags, why a member can or cannot open a dashboard, notebook or table, what a role grants, which properties are hidden from someone, or how the project's default access is set. Covers what each level means, how the stored rule, the enforced level and the inherited access relate, what the null values mean, which tool answers which question, and when the answer needs the role tools too.",
    source: 'PostHog/ai-plugin/skills/checking-member-access/SKILL.md',
  },
  {
    id: 'posthog:choosing-trend-or-slope-view',
    plugin: 'posthog',
    kind: 'skill',
    name: 'choosing-trend-or-slope-view',
    description:
      'Clarify how to visualize change over a time range before building a trend. Use whenever the user asks how much something changed, grew, dropped, improved, or regressed between two points or periods — "how much did X change from A to B", "before vs after", "start vs end", "week over week", "compare this month to last", "change over time" — or mentions a "slope chart" / "slopegraph". Two readings of "change" need different charts: the whole trend (a line, every interval) versus just the two endpoints (a slope, start vs end). Ask which they want, then render it. Not for choosing a saved insight ChartDisplayType in the insight editor.',
    source: 'PostHog/ai-plugin/skills/choosing-trend-or-slope-view/SKILL.md',
  },
  {
    id: 'posthog:cleaning-up-stale-feature-flags',
    plugin: 'posthog',
    kind: 'skill',
    name: 'cleaning-up-stale-feature-flags',
    description:
      'Identify stale feature flags in a PostHog project and clean up the code that checks them. Use when the user wants to find, audit, or remove unused, fully rolled out, or abandoned feature flags, run a feature flag hygiene review or a weekly cleanup, reduce feature flag tech debt, or asks "which flags can I remove?". When the agent can read and edit a repository it performs the code cleanup itself: tested local changes, and one draft PR per flag when the user authorizes publishing. Agents without repository access generate a tailored cleanup prompt instead. Covers staleness detection, dependency checking, retained-path rules, and the code-first ordering. This skill does not archive or otherwise change a flag in PostHog.',
    source: 'PostHog/ai-plugin/skills/cleaning-up-stale-feature-flags/SKILL.md',
  },
  {
    id: 'posthog:composing-grid-canvases',
    plugin: 'posthog',
    kind: 'skill',
    name: 'composing-grid-canvases',
    description:
      "Compose PostHog grid canvases — widget grids (including the user's home canvas) built from reusable component canvases. Use when a task asks to add, fill, move, resize, or remove a widget on a grid or home canvas, to compose a whole canvas of widgets from one ask, to build a reusable widget/component, or when a placement id or grid canvas id is the target. Covers the component store search → configure → fork → build ladder, the component placement contract (size, configSchema), the placement lifecycle (pending/generating/live/failed), the guarded layout patch loop, and reading the canvas's comment threads.",
    source: 'PostHog/ai-plugin/skills/composing-grid-canvases/SKILL.md',
  },
  {
    id: 'posthog:configuring-experiment-analytics',
    plugin: 'posthog',
    kind: 'skill',
    name: 'configuring-experiment-analytics',
    description:
      'Configures the analytics side of a PostHog experiment — exposure criteria (server-resolved default exposure event vs custom exposure events), primary and secondary metrics, the supported metric types (count, sum, ratio with `math` and `math_property`, retention with `retention_window_start` and `start_handling`), multivariate user handling ("Exclude from analysis" vs "Use first seen variant"), and how to read results once the experiment is live. Use when the user adds or edits a primary or secondary metric (e.g. "add a secondary metric tracking \'downloaded_file\' per user"), sets up a ratio metric (e.g. "revenue from purchase_completed / pageviews"), sets up a retention metric (e.g. "$pageview → uploaded_file, 7-day window"), configures custom exposure (e.g. "only count users who hit /checkout"), changes multivariate handling, or asks "who is in the analysis?", "how do I measure impact?", "is this winning?", "what\'s the confidence level?", or "should I ship?".',
    source:
      'PostHog/ai-plugin/skills/configuring-experiment-analytics/SKILL.md',
  },
  {
    id: 'posthog:configuring-experiment-rollout',
    plugin: 'posthog',
    kind: 'skill',
    name: 'configuring-experiment-rollout',
    description:
      'Configures the rollout shape of a PostHog experiment — the variant split (50/50, 80/20, A/B/C ratios), the overall rollout percentage that gates how many users enter the experiment, and the disambiguation when a percentage like "roll out to 25%" could mean either. Use when the user mentions a rollout percentage, variant split, or traffic distribution; gives a ratio like 60/40, 70/30, or 80/20; asks "who sees the test variant?"; wants to increase, decrease, or change the rollout or split on a draft or running experiment; weighs equal vs uneven splits; or proposes a mid-experiment split change (often an anti-pattern that needs reset or end-and-restart).',
    source: 'PostHog/ai-plugin/skills/configuring-experiment-rollout/SKILL.md',
  },
  {
    id: 'posthog:consuming-endpoints-from-client-code',
    plugin: 'posthog',
    kind: 'skill',
    name: 'consuming-endpoints-from-client-code',
    description:
      'Wire a PostHog endpoint into a client app or SDK. Covers fetching the OpenAPI spec, generating a typed client with openapi-generator or @hey-api/openapi-ts, sending the right auth header, shaping the variables payload (HogQL code_name vs insight breakdown property), handling rate-limit and materialised-endpoint error responses. Use when the user says "how do I call my endpoint", "generate a client for this", or "what auth header do I use".',
    source:
      'PostHog/ai-plugin/skills/consuming-endpoints-from-client-code/SKILL.md',
  },
  {
    id: 'posthog:context-layer-consolidation',
    plugin: 'posthog',
    kind: 'skill',
    name: 'context-layer-consolidation',
    description:
      'Keep the context wiki coherent using the deterministic lint report queue',
    source: 'PostHog/ai-plugin/skills/context-layer-consolidation/SKILL.md',
  },
  {
    id: 'posthog:context-layer-dreaming',
    plugin: 'posthog',
    kind: 'skill',
    name: 'context-layer-dreaming',
    description:
      'Synthesizes recent organizational activity into a durable context wiki. Use when running a nightly or incremental context-layer dream, or when updating sourced organizational context from completed work.',
    source: 'PostHog/ai-plugin/skills/context-layer-dreaming/SKILL.md',
  },
  {
    id: 'posthog:context-layer-health-check',
    plugin: 'posthog',
    kind: 'skill',
    name: 'context-layer-health-check',
    description:
      'Reviews context wiki quality after deterministic consolidation. Use when recent wiki-miss entries, contradictory or unsupported claims, stale priorities, near-duplicate subjects, or concepts without an owning page need semantic triage.',
    source: 'PostHog/ai-plugin/skills/context-layer-health-check/SKILL.md',
  },
  {
    id: 'posthog:copying-endpoints-across-projects',
    plugin: 'posthog',
    kind: 'skill',
    name: 'copying-endpoints-across-projects',
    description:
      "Copy a PostHog endpoint (a saved HogQL/insight query exposed as an API route) to another project in the same organization, or duplicate it under a new name in the same project. Use when the user wants to duplicate an endpoint, promote an endpoint from staging to production, replicate an endpoint's query/variables/freshness config in another workspace, or clone an endpoint to iterate on it. Unlike feature flags and experiments, endpoints have NO native cross-project copy tool — this skill covers the read-then-recreate flow (endpoint-get then endpoint-create), the active-project switching it requires, name-collision checks, and the safe defaults (land unmaterialised in the target, verify with endpoint-run). Does not cover editing endpoint versions (see managing-endpoint-versions) or authoring a brand-new endpoint from scratch (see creating-an-endpoint).",
    source:
      'PostHog/ai-plugin/skills/copying-endpoints-across-projects/SKILL.md',
  },
  {
    id: 'posthog:copying-flags-across-projects',
    plugin: 'posthog',
    kind: 'skill',
    name: 'copying-flags-across-projects',
    description:
      'Copy a feature flag from one PostHog project to one or more target projects in the same organization. Use when the user wants to duplicate a flag, promote a flag from staging to production, sync flags across projects, or replicate a flag configuration in a different workspace. Covers cohort remapping, scheduled-change handling, encrypted payloads, and the safe defaults (disabled in target, no scheduled changes).',
    source: 'PostHog/ai-plugin/skills/copying-flags-across-projects/SKILL.md',
  },
  {
    id: 'posthog:creating-ai-subscription',
    plugin: 'posthog',
    kind: 'skill',
    name: 'creating-ai-subscription',
    description:
      'Create a recurring AI-generated PostHog report — schedule a free-text prompt to run on a cron, with the LLM-synthesized markdown delivered to email, Slack, or Microsoft Teams on each tick. Use when the user wants a recurring AI summary of X on any cadence (daily, weekly, monthly, yearly) rather than a one-off report. (To attach an AI summary to an existing insight/dashboard subscription instead of a free-text prompt, see `managing-subscriptions` and its `summary_enabled` option.)',
    source: 'PostHog/ai-plugin/skills/creating-ai-subscription/SKILL.md',
  },
  {
    id: 'posthog:creating-an-endpoint',
    plugin: 'posthog',
    kind: 'skill',
    name: 'creating-an-endpoint',
    description:
      'Create a PostHog endpoint with the right shape on the first try — covers query kind choice, name conventions, what to expose as variables (HogQL code_name vs insight breakdown), data_freshness_seconds, and whether to materialise on day one. Use when the user says "create an endpoint", "expose this query as an API", "turn this insight into an endpoint", or asks for help structuring a new endpoint. Steers away from common mistakes: materialising a query with cohort breakdowns or an ineligible compare query, inline-only variables on a materialised endpoint, unbounded date ranges, ambiguous names.',
    source: 'PostHog/ai-plugin/skills/creating-an-endpoint/SKILL.md',
  },
  {
    id: 'posthog:creating-box-plot-insights',
    plugin: 'posthog',
    kind: 'skill',
    name: 'creating-box-plot-insights',
    description:
      'Creates product analytics or SQL-backed box plot insights in PostHog. Use when a user asks to create, build, or save a box plot, visualize a numeric distribution, compare quartiles or medians across dates or groups, or turn SQL results into a box plot. Chooses between a standard Trends box plot and a SQL insight, validates the distribution data, saves the insight, and verifies it.',
    source: 'PostHog/ai-plugin/skills/creating-box-plot-insights/SKILL.md',
  },
  {
    id: 'posthog:creating-experiments',
    plugin: 'posthog',
    kind: 'skill',
    name: 'creating-experiments',
    description:
      "Guides agents through experiment creation: reading the project's setup with experiment-setup-context, defining the hypothesis, configuring rollout and bucketing, setting up analytics and running time, and reporting which choices are guesses. Delegates rollout decisions to configuring-experiment-rollout and metric setup to configuring-experiment-analytics.\nTRIGGER when: user asks to create a new experiment or A/B test, OR when you are about to call experiment-create.\nDO NOT TRIGGER when: user is updating an existing experiment, managing lifecycle, or only browsing experiments.",
    source: 'PostHog/ai-plugin/skills/creating-experiments/SKILL.md',
  },
  {
    id: 'posthog:creating-online-evaluations',
    plugin: 'posthog',
    kind: 'skill',
    name: 'creating-online-evaluations',
    description:
      'Author continuously-running online evaluations in PostHog AI observability, grounded in real failure modes you\'ve identified. Use when the user wants evaluations that automatically score new generations or whole traces going forward — "create an eval to catch X", "continuously check that responses do Y", "turn these failures into evals". Covers letting the explored data decide how many evals to create, proposing that set for the user to pick, choosing the target and eval type (hog / llm_judge / sentiment), configuring a provider and model for an llm_judge eval (a provider key gates enabling, not creation), scoping which generations trigger it via conditions, creating disabled, verifying scope, enabling, and backfilling past data. Proposes a sentiment eval when no failure mode is worth catching. Finding and ranking the failure modes worth evaluating is its own job — use exploring-ai-failures first. To debug or manage evaluations that already exist, use exploring-llm-evaluations.',
    source: 'PostHog/ai-plugin/skills/creating-online-evaluations/SKILL.md',
  },
  {
    id: 'posthog:creating-replay-vision-scanners',
    plugin: 'posthog',
    kind: 'skill',
    name: 'creating-replay-vision-scanners',
    description:
      "Guides agents through creating and safely sizing a Replay Vision scanner: choosing the scanner type (monitor/classifier/scorer/summarizer), shaping the RecordingsQuery that selects sessions, and — crucially — estimating the credits it will spend and checking the org's remaining budget before creating, so a broad scanner doesn't exhaust the budget on its first scheduled sweep.\nTRIGGER when: user asks to create, set up, or configure a Replay Vision scanner, OR when you are about to call vision-scanners-create, OR when widening an existing scanner's query, sampling_rate, or sampling_mode (or moving it to a pricier model) via vision-scanners-update.\nDO NOT TRIGGER when: only reading scanners or observations, deleting a scanner, or running an existing scanner against sessions on demand (vision-scanners-scan-session/-scan-sessions). For a one-off question about sessions you already have, use vision-scanners-inline-scan rather than creating a scanner — the skill's first section covers when that applies.",
    source: 'PostHog/ai-plugin/skills/creating-replay-vision-scanners/SKILL.md',
  },
  {
    id: 'posthog:creating-surveys',
    plugin: 'posthog',
    kind: 'skill',
    name: 'creating-surveys',
    description:
      "Creates and launches PostHog surveys through MCP, including NPS/CSAT popovers, hosted feedback forms, and headless surveys. Guides survey type selection, audience targeting, draft review, and launch readiness. Use when asked to create a survey or form, or before calling survey-create. For investigating an existing survey's delivery or responses, use debugging-surveys instead.",
    source: 'PostHog/ai-plugin/skills/creating-surveys/SKILL.md',
  },
  {
    id: 'posthog:debugging-experiments',
    plugin: 'posthog',
    kind: 'skill',
    name: 'debugging-experiments',
    description:
      'Debug and support PostHog Experiments (A/B tests) for a customer looking at their own results. Use whenever an experiment support ticket is pasted or a customer asks a results question, most commonly "why aren\'t my exposures even?", "why is one variant getting no traffic?", "why am I missing / seeing too few exposures?", "why does the bias banner show?", or "why don\'t PostHog\'s numbers match my SQL?". Pulls the experiment\'s real data read-only, matches it to a known-cause catalog, and produces a customer-facing explanation, fix, and review of the pertinent numbers. Loads diagnosing-experiment-health as its deep diagnostic library. DO NOT TRIGGER when: creating an experiment (use creating-experiments), only configuring rollout (configuring-experiment-rollout) or metrics (configuring-experiment-analytics), asking lifecycle questions (managing-experiment-lifecycle), or the underlying feature flag is what\'s misbehaving rather than the results (use debugging-feature-flags).',
    source: 'PostHog/ai-plugin/skills/debugging-experiments/SKILL.md',
  },
  {
    id: 'posthog:debugging-failed-data-quality-checks',
    plugin: 'posthog',
    kind: 'skill',
    name: 'debugging-failed-data-quality-checks',
    description:
      'Finds out why a data quality check failed or errored, looks at the rows it matched, and recommends the fix. Also covers a materialized view refresh that the data quality gate did not publish. Use when asked why a check is red, what rows failed, why a view shows "Not published", why a view\'s data is stale after a refresh, or how to get a blocked refresh published. Trigger terms: failed check, failing rows, errored check, data quality failure, not published, blocked materialization, unpublished refresh, check keeps failing.',
    source:
      'PostHog/ai-plugin/skills/debugging-failed-data-quality-checks/SKILL.md',
  },
  {
    id: 'posthog:debugging-surveys',
    plugin: 'posthog',
    kind: 'skill',
    name: 'debugging-surveys',
    description:
      'Diagnose PostHog Surveys configuration and responses across all five SDKs (web/posthog-js, iOS, Android, Flutter, React Native). Use whenever a Surveys support ticket is pasted ("survey not showing", "fewer responses than expected", "responses disappeared", "responses are incomplete", "only the first question was answered", "the user says they didn\'t mean to submit", "survey shows on wrong platform"), or when diagnosing why a survey does or doesn\'t display. Covers the eligibility pipeline, how a response actually gets stored (partial responses, branching, optional questions, auto-submit), cross-SDK feature parity, the known-cause catalog, read-only diagnostic queries, staff access, and the customer-reply style guide.',
    source: 'PostHog/ai-plugin/skills/debugging-surveys/SKILL.md',
  },
  {
    id: 'posthog:designing-email-templates',
    plugin: 'posthog',
    kind: 'skill',
    name: 'designing-email-templates',
    description:
      'Author, save, and edit email templates in the PostHog workflows library — compose email design JSON with Liquid personalization and create and round-trip-edit templates over MCP. Use when asked to design, build, update, or fix an email template for workflows, broadcasts, or campaigns.',
    source: 'PostHog/ai-plugin/skills/designing-email-templates/SKILL.md',
  },
  {
    id: 'posthog:designing-replay-vision-scanners',
    plugin: 'posthog',
    kind: 'skill',
    name: 'designing-replay-vision-scanners',
    description:
      'Designs a Replay Vision scanner that produces trustworthy observations: one visible question per scanner, a type chosen from the answer shape, a query that selects only sessions able to answer it, a prompt that demands on-screen proof and allows no or inconclusive, a model picked by the cost of a wrong answer, and a first-batch test pass. Sizing and the create call stay in creating-replay-vision-scanners.\nTRIGGER when: user wants to design, draft, or improve a Replay Vision scanner or its prompt, asks what to scan for, asks why a scanner returns vague observations, or asks an agent to propose scanners for a product.\nDO NOT TRIGGER when: the question and prompt are settled and the job is to size and create (use creating-replay-vision-scanners), the scanner targets one experiment (use scanning-experiments-with-replay-vision), or the job is to read existing observations (use exploring-replay-vision-observations).',
    source:
      'PostHog/ai-plugin/skills/designing-replay-vision-scanners/SKILL.md',
  },
  {
    id: 'posthog:diagnosing-ci-and-merge-bottlenecks',
    plugin: 'posthog',
    kind: 'skill',
    name: 'diagnosing-ci-and-merge-bottlenecks',
    description:
      'Diagnoses CI and pull-request pipeline health for a GitHub repo using the engineering analytics MCP tools — pull-requests (PR list with CI status), workflow-health (per-workflow CI trends), and pr-lifecycle (a single PR\'s timeline). Use when asked whether CI is getting faster or slower, which GitHub Actions workflow is the slow or flaky long-pole, how long PRs take from open to merge, how an author\'s merge time compares to the cohort, which open PRs have failing or pending CI, or where a specific pull request is stuck. Triggers on "engineering analytics", "is CI getting slower", "slow workflow", "flaky CI", "time to merge", "cycle time", "PR throughput", "failing checks", "where is PR <n> stuck", "CI long pole", "what\'s holding up this PR". For a verdict on one specific CI failure (whose fault, which commit) use investigating-ci-failures; to save these numbers as insights use turning-engineering-analytics-into-insights.',
    source:
      'PostHog/ai-plugin/skills/diagnosing-ci-and-merge-bottlenecks/SKILL.md',
  },
  {
    id: 'posthog:diagnosing-endpoint-performance',
    plugin: 'posthog',
    kind: 'skill',
    name: 'diagnosing-endpoint-performance',
    description:
      'Diagnose why a PostHog endpoint is slow or expensive and propose a concrete fix — bump the cache TTL, enable materialisation, restructure variables, or rewrite the query. Use when the user says "this endpoint is slow", "my endpoint times out", "we\'re hitting the cost cap on this one", or asks "should I materialise this?". Focuses on a single named endpoint, not a project-wide audit.',
    source: 'PostHog/ai-plugin/skills/diagnosing-endpoint-performance/SKILL.md',
  },
  {
    id: 'posthog:diagnosing-experiment-health',
    plugin: 'posthog',
    kind: 'skill',
    name: 'diagnosing-experiment-health',
    description:
      "Runs diagnostics and a health check on one PostHog experiment: its setup, exposures, results and changes during the run. Covers 0 exposures, sample ratio mismatch, lost or uneven exposures, users in multiple variants, identity faults, who the experiment counts, significance traps (peeking, A/A, 'target reached', Bayesian vs Frequentist, sequential, CUPED), mid-run edits, pause and freeze, and survey follow-up.\nTRIGGER when: user asks 'is my experiment healthy / set up right / biased?' or 'why 0 exposures?', asks why it counts different people than their insight, mentions the bias or mismatch warning, an uneven split, significance that flips, numbers that disagree with their SQL, results that changed after an edit, or wants user feedback on an experiment.\nDO NOT TRIGGER when: creating an experiment (use creating-experiments), only configuring rollout (use configuring-experiment-rollout) or metrics (use configuring-experiment-analytics), or only asking lifecycle questions (use managing-experiment-lifecycle).",
    source: 'PostHog/ai-plugin/skills/diagnosing-experiment-health/SKILL.md',
  },
  {
    id: 'posthog:diagnosing-failed-warehouse-syncs',
    plugin: 'posthog',
    kind: 'skill',
    name: 'diagnosing-failed-warehouse-syncs',
    description:
      'Diagnose why a data warehouse sync is failing and recommend the right recovery action. Use when the user asks "why isn\'t my Stripe/Postgres/Hubspot sync working?", "this table has been stuck for hours", "the data in the warehouse looks wrong", or wants to troubleshoot a specific source or schema. Covers source-level vs schema-level failures, stuck Running states, credential and schema-drift errors, incremental-field misconfig, CDC prerequisite failures, and the cancel / reload / resync / delete-data recovery actions.',
    source:
      'PostHog/ai-plugin/skills/diagnosing-failed-warehouse-syncs/SKILL.md',
  },
  {
    id: 'posthog:diagnosing-missing-recordings',
    plugin: 'posthog',
    kind: 'skill',
    name: 'diagnosing-missing-recordings',
    description:
      "Diagnoses why a session recording is missing or was not captured. Use when a user asks why a session has no replay, why recordings aren't appearing, or wants to troubleshoot session replay capture issues for a specific session ID or across their project. Covers SDK diagnostic signals, project settings, sampling, triggers, ad blockers, and quota/billing scenarios.",
    source: 'PostHog/ai-plugin/skills/diagnosing-missing-recordings/SKILL.md',
  },
  {
    id: 'posthog:diagnosing-sdk-health',
    plugin: 'posthog',
    kind: 'skill',
    name: 'diagnosing-sdk-health',
    description:
      'Diagnoses the health of a project\'s PostHog SDK integrations — which SDKs are out of date and how to fix them. Use when a user asks about PostHog SDK versions, outdated SDKs, upgrade recommendations, "SDK health", "SDK doctor" (the former name), or when events or features seem off and it might be due to an old SDK.',
    source: 'PostHog/ai-plugin/skills/diagnosing-sdk-health/SKILL.md',
  },
  {
    id: 'posthog:diagnosing-stacktrace-symbolication',
    plugin: 'posthog',
    kind: 'skill',
    name: 'diagnosing-stacktrace-symbolication',
    description:
      'Help users debug PostHog Error Tracking stack-trace symbolication for any supported platform — JavaScript/TypeScript web, React Native (Hermes), Android (Proguard / R8), or iOS / macOS (dSYM). The PostHog symbol-set lookup flow is universal across platforms; build-tool and artifact details live in per-platform references (JavaScript is fleshed out, others come as we encounter them). Use when stack frames stay minified or obfuscated after symbols are uploaded, PostHog symbol sets show last_used but frames are not readable, chunk IDs or dSYM UUIDs do not match, "Token not found" appears, uploaded source maps / dSYMs / Proguard mappings look empty, or bundler / symbol-upload configuration needs troubleshooting.',
    source:
      'PostHog/ai-plugin/skills/diagnosing-stacktrace-symbolication/SKILL.md',
  },
  {
    id: 'posthog:downloading-batch-export-files',
    plugin: 'posthog',
    kind: 'skill',
    name: 'downloading-batch-export-files',
    description:
      'Export PostHog events, persons, sessions, or the results of a HogQL query on demand and download the resulting files. Use when the user asks to download/export raw PostHog data, export HogQL query results, create a one-off file export, fetch a Parquet or JSONLines export, or use the file_download_batch_exports API. Covers starting the export with MCP, polling completion, and downloading via the existing REST redirect endpoint.',
    source: 'PostHog/ai-plugin/skills/downloading-batch-export-files/SKILL.md',
  },
  {
    id: 'posthog:exploring-ai-failures',
    plugin: 'posthog',
    kind: 'skill',
    name: 'exploring-ai-failures',
    description:
      'Find where an AI/LLM application is failing in production and surface the failure patterns, working from real traces. Use when someone wants to understand what\'s going wrong with an AI feature, find and categorize failure modes, triage errors, or investigate quality issues (wrong answers, ignored instructions, hallucinations, tool misuse) — "what\'s failing in my agent", "surface error patterns", "why are the responses bad", "find the common failure modes", "what should I fix next". Covers scoping to one use case, finding failing traces by whichever signal fits the context (code errors, metric outliers, trace-type slices, manual review, existing-eval spikes, clustering), and reading them into a ranked failure taxonomy.',
    source: 'PostHog/ai-plugin/skills/exploring-ai-failures/SKILL.md',
  },
  {
    id: 'posthog:exploring-apm-traces',
    plugin: 'posthog',
    kind: 'skill',
    name: 'exploring-apm-traces',
    description:
      'Investigates distributed application performance using PostHog APM (OpenTelemetry span) data via MCP. Use when the user asks about service traces, slow HTTP/database spans, error spans, error-rate trends or spikes, latency distributions, trace IDs, or span attributes — not AI observability traces or product logs. Uses posthog:apm-service-health, posthog:query-apm-spans, posthog:apm-trace-get, posthog:apm-spans-sparkline, posthog:apm-services-list, posthog:apm-attributes-list, and posthog:apm-attribute-values-list.',
    source: 'PostHog/ai-plugin/skills/exploring-apm-traces/SKILL.md',
  },
  {
    id: 'posthog:exploring-autocapture-events',
    plugin: 'posthog',
    kind: 'skill',
    name: 'exploring-autocapture-events',
    description:
      'Guides exploration of $autocapture events captured by posthog-js to understand user interactions, find CSS selectors (especially data-attr attributes), evaluate selector uniqueness, query matching clicks ad-hoc, and create actions. Use when the user asks about autocapture data, wants to find what users are clicking, needs to build actions from click events, asks about elements_chain, wants to build a trend or funnel filtered by clicks or other autocapture interactions, asks which properties autocapture sends, or asks how to filter $autocapture events. Only applies to projects using posthog-js autocapture.',
    source: 'PostHog/ai-plugin/skills/exploring-autocapture-events/SKILL.md',
  },
  {
    id: 'posthog:exploring-endpoint-execution-logs',
    plugin: 'posthog',
    kind: 'skill',
    name: 'exploring-endpoint-execution-logs',
    description:
      'Explore and diagnose a PostHog endpoint\'s execution logs — error messages, failed runs, cache misses, slow runs, or unexpected row counts during endpoint invocations. Use when the user says "my endpoint is failing", "show me the logs for endpoint X", "what error did endpoint Y produce", "why did endpoint Z return no rows", "is this endpoint hitting cache", or "check the last N runs". Focused on a single named endpoint\'s runtime log entries, not project-wide auditing or query performance profiling.',
    source:
      'PostHog/ai-plugin/skills/exploring-endpoint-execution-logs/SKILL.md',
  },
  {
    id: 'posthog:exploring-live-traffic',
    plugin: 'posthog',
    kind: 'skill',
    name: 'exploring-live-traffic',
    description:
      'Inspects PostHog Web analytics Live tab data — current users online, last-30-minutes pageviews, top pages, referrers, devices, browsers, countries, bot traffic, and the per-minute bot/users charts. Use when the user asks "who is on my site right now?", "what is happening live?", "what bots are crawling me?", asks about the "live tab" / "live dashboard", wants live numbers (last 30 min), or wants help filtering or drilling into the live view. Also covers building product-analytics insights that mirror what the tiles show.',
    source: 'PostHog/ai-plugin/skills/exploring-live-traffic/SKILL.md',
  },
  {
    id: 'posthog:exploring-llm-clusters',
    plugin: 'posthog',
    kind: 'skill',
    name: 'exploring-llm-clusters',
    description:
      'Investigate AI observability clusters — understand usage patterns in AI/LLM traffic, compare cluster behavior, compute cost/latency metrics, and drill into individual traces within clusters.',
    source: 'PostHog/ai-plugin/skills/exploring-llm-clusters/SKILL.md',
  },
  {
    id: 'posthog:exploring-llm-costs',
    plugin: 'posthog',
    kind: 'skill',
    name: 'exploring-llm-costs',
    description:
      'Investigate LLM spend in PostHog — total cost over time, cost by model, provider, user, trace, or custom dimension, token and cache-hit economics, and cost regressions. Use when the user asks "how much are we spending on LLMs?", "which model / user / feature is most expensive?", "why did cost spike?", wants to build a cost dashboard or alert, or pastes a trace URL and asks about its cost.',
    source: 'PostHog/ai-plugin/skills/exploring-llm-costs/SKILL.md',
  },
  {
    id: 'posthog:exploring-llm-evaluations',
    plugin: 'posthog',
    kind: 'skill',
    name: 'exploring-llm-evaluations',
    description:
      'Investigate AI observability evaluations — `hog` (deterministic code-based), `llm_judge` (LLM-prompt-based), and `sentiment` (user-message sentiment). Find existing evaluations, inspect their configuration, run them against specific generations, query individual results, and set up scheduled reports on an evaluation. Use when the user asks to debug why an evaluation is failing, surface common failure modes, compare results across filters, dry-run a Hog evaluator, prototype a new LLM-judge prompt, inspect sentiment classifications, or manage the evaluation lifecycle.',
    source: 'PostHog/ai-plugin/skills/exploring-llm-evaluations/SKILL.md',
  },
  {
    id: 'posthog:exploring-llm-traces',
    plugin: 'posthog',
    kind: 'skill',
    name: 'exploring-llm-traces',
    description:
      "Debug and inspect LLM/AI agent traces using PostHog's MCP tools. Use when the user pastes a trace or session URL (e.g. /ai-observability/traces/<id> or /ai-observability/sessions/<id>), asks to debug a trace, figure out what went wrong, check if an agent used a tool correctly, verify context/files were surfaced, inspect subagent behavior, investigate LLM decisions, or analyze token usage and costs. Also use when raw SQL/HogQL against `events.properties.$ai_input` / `$ai_output_choices` returns empty — message content lives only on the dedicated `posthog.ai_events` table.",
    source: 'PostHog/ai-plugin/skills/exploring-llm-traces/SKILL.md',
  },
  {
    id: 'posthog:exploring-mcp-intent-clusters',
    plugin: 'posthog',
    kind: 'skill',
    name: 'exploring-mcp-intent-clusters',
    description:
      'Explore PostHog MCP intent clusters — agent goals grouped by semantic similarity, with each cluster\'s tool distribution and error rates, plus the tool-centric pivot (capture rate per intent, discovery rate against the advertised catalog, description fit, tool overlaps). Use when the user asks "what are agents trying to do with the MCP?", "group the intents", "which goals fail most?", "what does each cluster route to?", "when agents have this intent do they find my tool?", "which tools get mixed up?", wants to recompute the clustering, or pastes an MCP analytics intent-clustering URL.',
    source: 'PostHog/ai-plugin/skills/exploring-mcp-intent-clusters/SKILL.md',
  },
  {
    id: 'posthog:exploring-mcp-sessions',
    plugin: 'posthog',
    kind: 'skill',
    name: 'exploring-mcp-sessions',
    description:
      'Investigate individual PostHog MCP sessions — the sequence of tool calls a single agent made in one run, what it was trying to do, and where it went wrong. Use when the user asks "what did this MCP session do?", "show me the tool calls for session X", "what was the agent\'s goal?", "which sessions had errors?", "who is connecting to my MCP?", or pastes an MCP analytics sessions URL.',
    source: 'PostHog/ai-plugin/skills/exploring-mcp-sessions/SKILL.md',
  },
  {
    id: 'posthog:exploring-mcp-tool-original-user-motive',
    plugin: 'posthog',
    kind: 'skill',
    name: 'exploring-mcp-tool-original-user-motive',
    description:
      'Build a starting-point taxonomy for an MCP tool — what users were trying to accomplish before they reached the tool — and publish it as a PostHog notebook. Reconstructs each session\'s goal from its opening tool calls, then clusters those goals into named categories with size, share, and facet mix. Use when the user asks "why do people use this tool?", "what are users actually trying to do?", "what problem brings people here?", "where do these sessions start?", "segment usage of <tool> by goal", or wants a Clio-style taxonomy of MCP usage. Complements exploring-mcp-intent-clusters, which groups what agents did per call rather than why the session began. The agent running this skill writes the goal labels itself, reading the corpus query output session by session — the bundled scripts cover the mechanical facets but measurably lose the goal\'s altitude, so do not delegate that field to them.',
    source:
      'PostHog/ai-plugin/skills/exploring-mcp-tool-original-user-motive/SKILL.md',
  },
  {
    id: 'posthog:exploring-mcp-tool-quality',
    plugin: 'posthog',
    kind: 'skill',
    name: 'exploring-mcp-tool-quality',
    description:
      'Investigate the quality of PostHog MCP tool calls — error rates, latency, reach, and which tools are failing or slow. Use when the user asks "which MCP tool has the highest error rate?", "what\'s the slowest tool?", "which tools fail most often?", "how reliable is tool X?", wants a tool-quality matrix, or pastes an MCP analytics tool-quality / dashboard URL and asks what it shows.',
    source: 'PostHog/ai-plugin/skills/exploring-mcp-tool-quality/SKILL.md',
  },
  {
    id: 'posthog:exploring-mcp-tool-usage',
    plugin: 'posthog',
    kind: 'skill',
    name: 'exploring-mcp-tool-usage',
    description:
      'Starting point for exploring how a PostHog MCP server\'s tools are used — routes a broad question to the typed tool that answers it. Use when the user asks "how is my MCP doing?", "what should I look at?", "explore my tool calls", "who uses my MCP tools?", "what are agents doing with the MCP?", or pastes an MCP analytics URL without a specific question. Offers a menu of questions, each backed by a query tool, then hands off to the focused skill.',
    source: 'PostHog/ai-plugin/skills/exploring-mcp-tool-usage/SKILL.md',
  },
  {
    id: 'posthog:exploring-replay-vision-observations',
    plugin: 'posthog',
    kind: 'skill',
    name: 'exploring-replay-vision-observations',
    description:
      'Guides agents through pulling a Replay Vision scanner\'s observations, reading the findings, and acting on them — summarizing patterns across sessions, drilling into individual recordings, and turning real, corroborated issues into PostHog tasks, insights, or an investigating-replay hand-off.\nTRIGGER when: user wants to pull/read/triage Replay Vision observations, asks "what has my scanner found", wants to act on or summarize scanner findings, turn observations into tasks/work, or points at a /replay-vision/<scanner-id> URL.\nDO NOT TRIGGER when: creating or sizing a scanner (use creating-replay-vision-scanners), running a one-off scan you don\'t then analyse, or authoring a signals scout.',
    source:
      'PostHog/ai-plugin/skills/exploring-replay-vision-observations/SKILL.md',
  },
  {
    id: 'posthog:exploring-scouts',
    plugin: 'posthog',
    kind: 'skill',
    name: 'exploring-scouts',
    description:
      'How to explore and make sense of PostHog Signals scouts — the scheduled agents that scan a project and write reports into the Signals inbox. Use when a user wants to understand what scouts they have, how each one is behaving, and whether the fleet is actually working. Covers surveying the fleet and its schedules, reading recent scout runs and drilling into a single run\'s reasoning, inspecting the durable scratchpad memory the fleet has built up, tracing a run to the reports it wrote or edited, reading the follow-up checks still measuring a report, and assessing a scout\'s health and performance over time (cadence, success rate, report rate, signal-to-noise). Read-only and exploratory — to write or tune a scout, use `authoring-scouts` instead. Trigger on "what are my scouts doing", "how is my <x> scout performing", "show me recent scout runs", "why did this scout find/report nothing", "what has the fleet learned", "explore scout run <id>", "is my scout working".',
    source: 'PostHog/ai-plugin/skills/exploring-scouts/SKILL.md',
  },
  {
    id: 'posthog:feature-usage-feed',
    plugin: 'posthog',
    kind: 'skill',
    name: 'feature-usage-feed',
    description:
      "Set up an LLM-judge evaluation that extracts canonical use cases for a PostHog feature at scale and streams the results to a Slack channel as a live feed. Use when someone wants to understand how users are actually using a specific AI/LLM-powered feature in production — what they're investigating, what questions they're trying to answer, and what patterns surface — without manually reading hundreds of traces. Assumes the feature emits `$ai_generation` and `$ai_evaluation` events with `$session_id` linkage to the trigger user's recording (the standard setup post the session-summary linkage PRs).",
    source: 'PostHog/ai-plugin/skills/feature-usage-feed/SKILL.md',
  },
  {
    id: 'posthog:filtering-bot-traffic',
    plugin: 'posthog',
    kind: 'skill',
    name: 'filtering-bot-traffic',
    description:
      'Identify, measure, and exclude bot / crawler / AI-agent traffic in PostHog web and product analytics using the traffic classification surface (the isLikelyBot / getTrafficType HogQL functions and the $virt_* virtual properties). Use when the user asks to "exclude bots", "filter out crawlers", "remove bot traffic from my numbers", "how much of my traffic is bots / AI crawlers", "is GPTBot / ChatGPT / Claude hitting my site", "break down traffic by human vs bot", or wants clean human-only counts in an insight or dashboard. For the real-time Live tab bot tiles, use exploring-live-traffic instead.',
    source: 'PostHog/ai-plugin/skills/filtering-bot-traffic/SKILL.md',
  },
  {
    id: 'posthog:finding-deleted-feature-flags',
    plugin: 'posthog',
    kind: 'skill',
    name: 'finding-deleted-feature-flags',
    description:
      'Find feature flags that were soft-deleted in the active project within a recent time window. Use when the user asks "what flags were deleted in the last N days", "show me recently deleted feature flags", "who deleted flag X", "audit recent flag deletions", or anything similar. Handles the non-obvious gotcha that system.feature_flags exposes the deleted boolean but does not expose a deletion timestamp — the actual deleted-at time lives in the per-flag activity log and must be cross-referenced.',
    source: 'PostHog/ai-plugin/skills/finding-deleted-feature-flags/SKILL.md',
  },
  {
    id: 'posthog:finding-experiments',
    plugin: 'posthog',
    kind: 'skill',
    name: 'finding-experiments',
    description:
      'Resolves a PostHog experiment reference from natural language to a concrete experiment ID by browsing `experiment-list` (not feature-flag tools), with disambiguation when multiple experiments match. Use when the user names or quotes an experiment ("split test demo", "the File engagement boost experiment", "onboarding retention test", "landing page hero experiment", "pricing experiment"), describes it loosely ("the signup experiment", "my pricing test", "the one with the new checkout"), uses a relative reference ("latest", "most recent", "the one I created yesterday"), filters by status (running, draft, paused, exposure frozen, stopped, archived), or otherwise refers to an experiment by anything other than its concrete ID.',
    source: 'PostHog/ai-plugin/skills/finding-experiments/SKILL.md',
  },
  {
    id: 'posthog:finding-replay-for-issue',
    plugin: 'posthog',
    kind: 'skill',
    name: 'finding-replay-for-issue',
    description:
      'Finds the most informative session recording linked to an error tracking issue. Use when a user has an error tracking issue ID and wants to watch a replay showing what the user was doing when the error occurred. Ranks linked sessions by recency, activity score, and journey completeness, then summarizes the pre-error context. Replaces blind session picking from potentially hundreds of linked recordings.',
    source: 'PostHog/ai-plugin/skills/finding-replay-for-issue/SKILL.md',
  },
  {
    id: 'posthog:finding-sessions-to-watch',
    plugin: 'posthog',
    kind: 'skill',
    name: 'finding-sessions-to-watch',
    description:
      'Guides a user from "I want to watch recordings but don\'t know which ones" to a short, high-signal list of sessions worth watching. Use when the user asks which sessions or replays to watch, wants help finding interesting / useful recordings, says they don\'t know where to start in session replay, or wants to watch sessions about a goal (signup, pricing, onboarding, checkout, a feature, rageclicks, errors, mobile, a specific person) without naming exact filters. Turns a vague intent into a focused RecordingsQuery via `query-session-recordings-list`, then deep-links the best few and hands off to `investigating-replay`. Do NOT use when the user already has a recording/session ID (use investigating-replay) or wants the replay for a known error issue (use finding-replay-for-issue).',
    source: 'PostHog/ai-plugin/skills/finding-sessions-to-watch/SKILL.md',
  },
  {
    id: 'posthog:formatting-insight-axes',
    plugin: 'posthog',
    kind: 'skill',
    name: 'formatting-insight-axes',
    description:
      'Pick the right y-axis unit when creating or updating an insight via `posthog:insight-create` or `posthog:insight-update` — both TrendsQuery (`trendsFilter.aggregationAxisFormat`) and SQL insights (`DataVisualizationNode`, `chartSettings.yAxis[].settings.formatting`). Use when the agent is about to add a `formula` purely to convert units (e.g. dividing seconds by 60 to display minutes), when a `math_property` or SQL column is a duration, currency, ratio, or large count, or whenever the user mentions "format the y-axis", "duration", "seconds", "minutes", "hours", "milliseconds", "ms", "percentage", "%%", "currency", "decimals", "axis label", or "axis unit" in the context of a graph insight.',
    source: 'PostHog/ai-plugin/skills/formatting-insight-axes/SKILL.md',
  },
  {
    id: 'posthog:grouping-noisy-errors',
    plugin: 'posthog',
    kind: 'skill',
    name: 'grouping-noisy-errors',
    description:
      'Consolidate PostHog error tracking issues that are the same actual error reported under different fingerprints. Use when the user asks "why do I have so many TypeError issues that look the same?", "merge these duplicates", "stop splitting this error into new issues", or wants to clean up fingerprint sprawl. Decides between a one-shot merge of existing issues and a durable grouping rule that keeps future events from creating new fingerprints. Does NOT group conceptually similar bugs across different runtimes, SDKs, or call sites.',
    source: 'PostHog/ai-plugin/skills/grouping-noisy-errors/SKILL.md',
  },
  {
    id: 'posthog:implementing-api-surveys',
    plugin: 'posthog',
    kind: 'skill',
    name: 'implementing-api-surveys',
    description:
      "Implements a PostHog API (headless) survey inside the user's own codebase so it renders with their UI components and captures the exact events PostHog expects, then verifies the first response arrived. Use when asked to implement a survey, build a headless survey, build a custom survey UI, render a survey in my app, or wire up a survey of type `api` in a browser, server, or custom mobile UI. Covers the posthog-js event contract, server-side SDK capture, and post-implementation verification through MCP. To design or create the survey definition, use creating-surveys instead. For a survey that is implemented but not showing or not recording, use debugging-surveys.",
    source: 'PostHog/ai-plugin/skills/implementing-api-surveys/SKILL.md',
  },
  {
    id: 'posthog:inbox-exploration',
    plugin: 'posthog',
    kind: 'skill',
    name: 'inbox-exploration',
    description:
      'Explore PostHog\'s Inbox and act on what it surfaces — the place where signal reports cluster into actionable issues and trends. Use when the user asks "what\'s in my inbox?", "what should I look at?", "which reports are actionable?", "what\'s PostHog flagged recently?", asks about a specific report by ID or title, wants to act on / fix / implement a report (turn it into a PR), wants to resolve, dismiss, or snooze a report, or wants to see which signal sources are configured. Covers listing, filtering, drilling into, and acting on reports, plus pointers to the deeper `signals` skill when raw signals or semantic search are needed.',
    source: 'PostHog/ai-plugin/skills/inbox-exploration/SKILL.md',
  },
  {
    id: 'posthog:installing-posthog-from-chat',
    plugin: 'posthog',
    kind: 'skill',
    name: 'installing-posthog-from-chat',
    description:
      "Set up PostHog in a user's GitHub repository from a chat, without a terminal. Wizard, PostHog's setup agent, runs in the cloud, adds the SDK and first events, and opens a pull request. Use only when you can't read or edit the user's code, which is common in web chat apps such as ChatGPT on the web or Claude on the web. Typical requests: install, add, or set up PostHog in their app or repository, or open a pull request that adds PostHog. When you're working in the user's repository, use installing-posthog-in-a-codebase instead. Covers connecting GitHub, picking the repository, starting the run, polling it, and sharing the pull request.",
    source: 'PostHog/ai-plugin/skills/installing-posthog-from-chat/SKILL.md',
  },
  {
    id: 'posthog:installing-posthog-in-a-codebase',
    plugin: 'posthog',
    kind: 'skill',
    name: 'installing-posthog-in-a-codebase',
    description:
      "Install and configure a PostHog SDK in a repository you can read and edit, following PostHog's docs for the framework. Use when a user working in their codebase asks to add, install, or set up PostHog, product analytics, session replay, or a PostHog SDK. Covers finding the right docs page, installing the latest package, getting the project token and ingestion host from project-get, keeping them in the env file, server-side setup, identifying users, and verifying the change. If you can't access the user's code, as is common in ChatGPT on the web or Claude on the web, use installing-posthog-from-chat instead.",
    source:
      'PostHog/ai-plugin/skills/installing-posthog-in-a-codebase/SKILL.md',
  },
  {
    id: 'posthog:instrument-error-tracking',
    plugin: 'posthog',
    kind: 'skill',
    name: 'instrument-error-tracking',
    description:
      'Add PostHog error tracking to capture and monitor exceptions. Use after implementing features or reviewing PRs to ensure errors are tracked with stack traces and source maps. Also handles initial PostHog SDK setup if not yet installed.',
    source: 'PostHog/ai-plugin/skills/instrument-error-tracking/SKILL.md',
  },
  {
    id: 'posthog:instrument-feature-flags',
    plugin: 'posthog',
    kind: 'skill',
    name: 'instrument-feature-flags',
    description:
      'Add PostHog feature flags to gate new functionality. Use after implementing features or reviewing PRs to ensure safe rollouts with feature flag controls. Also handles initial PostHog SDK setup if not yet installed.',
    source: 'PostHog/ai-plugin/skills/instrument-feature-flags/SKILL.md',
  },
  {
    id: 'posthog:instrument-integration',
    plugin: 'posthog',
    kind: 'skill',
    name: 'instrument-integration',
    description:
      'Add PostHog SDK integration to your application. Use when setting up PostHog for the first time or reviewing PRs that need PostHog initialization. Covers SDK installation, provider setup, and basic configuration for any framework.',
    source: 'PostHog/ai-plugin/skills/instrument-integration/SKILL.md',
  },
  {
    id: 'posthog:instrument-llm-analytics',
    plugin: 'posthog',
    kind: 'skill',
    name: 'instrument-llm-analytics',
    description:
      'Add PostHog AI Observability to trace AI model usage. Use after implementing LLM features or reviewing PRs to ensure all generations are captured with token counts, latency, and costs. Also handles initial PostHog SDK setup if not yet installed.',
    source: 'PostHog/ai-plugin/skills/instrument-llm-analytics/SKILL.md',
  },
  {
    id: 'posthog:instrument-logs',
    plugin: 'posthog',
    kind: 'skill',
    name: 'instrument-logs',
    description:
      'Add PostHog log capture to track application logs. Use after implementing features or reviewing PRs to ensure meaningful log events are captured with structured properties. Also handles initial OTLP exporter setup if not yet configured.',
    source: 'PostHog/ai-plugin/skills/instrument-logs/SKILL.md',
  },
  {
    id: 'posthog:instrument-metrics',
    plugin: 'posthog',
    kind: 'skill',
    name: 'instrument-metrics',
    description:
      'Add PostHog metric capture to track counters, gauges, and histograms. Use after implementing features or reviewing PRs to ensure key operations are measured, or when asked to add metrics, counters, or track a value over time. Also handles mirroring existing Prometheus/StatsD/OpenTelemetry metrics into PostHog and initial OTLP exporter setup.',
    source: 'PostHog/ai-plugin/skills/instrument-metrics/SKILL.md',
  },
  {
    id: 'posthog:instrument-product-analytics',
    plugin: 'posthog',
    kind: 'skill',
    name: 'instrument-product-analytics',
    description:
      'Add PostHog product analytics events to track user behavior. Use after implementing new features or reviewing PRs to ensure meaningful user actions are captured. Also handles initial PostHog SDK setup if not yet installed.',
    source: 'PostHog/ai-plugin/skills/instrument-product-analytics/SKILL.md',
  },
  {
    id: 'posthog:investigate-metric',
    plugin: 'posthog',
    kind: 'skill',
    name: 'investigate-metric',
    description:
      'Diagnose why a product metric changed (dropped, spiked, or plateaued) by orchestrating breakdowns, actors, paths, lifecycle, retention, and annotations queries. Use when the user reports an anomaly, asks "why did X change?", or needs root-cause analysis for a trend, funnel, retention, stickiness, or lifecycle metric.',
    source: 'PostHog/ai-plugin/skills/investigate-metric/SKILL.md',
  },
  {
    id: 'posthog:investigating-ci-failures',
    plugin: 'posthog',
    kind: 'skill',
    name: 'investigating-ci-failures',
    description:
      'Investigates a specific CI failure to a verdict: whose fault, which commit, who wrote it, and whether it\'s fixed. Use for "who broke master", "why did this test fail in CI", "is this failure my PR\'s fault or everyone\'s", "is this test flaky or actually broken", "when did this failure start". Works from the engineering_analytics warehouse views (engineering_analytics_ci_failures, engineering_analytics_ci_job_history) plus the CI failure logs. Not for aggregate CI health, cost, or merge bottlenecks (use diagnosing-ci-and-merge-bottlenecks) and not for building saved insights (use turning-engineering-analytics-into-insights).',
    source: 'PostHog/ai-plugin/skills/investigating-ci-failures/SKILL.md',
  },
  {
    id: 'posthog:investigating-error-issue',
    plugin: 'posthog',
    kind: 'skill',
    name: 'investigating-error-issue',
    description:
      'Investigates a single PostHog error tracking issue end-to-end. Use when the user provides an issue ID or pastes an issue URL (`/error-tracking/<id>`) and wants to understand the error — who it affects, what triggers it, when it started, whether it correlates with a release, browser, OS, or feature flag, and what the next step should be. Pulls aggregated metrics, sample exception events, segment breakdowns, linked replays, and synthesizes a hypothesis-grade summary in one pass.',
    source: 'PostHog/ai-plugin/skills/investigating-error-issue/SKILL.md',
  },
  {
    id: 'posthog:investigating-logs',
    plugin: 'posthog',
    kind: 'skill',
    name: 'investigating-logs',
    description:
      'Investigate logs in a PostHog project: verify a service or deployment is healthy, explain an error spike, triage an incident, or understand what a log stream is saying. Use when the user asks to "check the logs", asks whether a service, deploy, release, or change is working or broke anything, asks why errors are up or what changed, or wants the root cause of failures visible in logs. Routes the logs MCP tools (services overview, pattern mining, before/after pattern diffing, bucketed counts, facets, raw rows) so investigations start from summaries instead of raw rows or hand-written SQL over the logs table.',
    source: 'PostHog/ai-plugin/skills/investigating-logs/SKILL.md',
  },
  {
    id: 'posthog:investigating-metric-anomalies',
    plugin: 'posthog',
    kind: 'skill',
    name: 'investigating-metric-anomalies',
    description:
      'Investigates server/infrastructure metric anomalies in PostHog Metrics — from "this metric is rising/dropping/spiking" or a fired alert to a probable cause with evidence. Use when asked why a metric looks wrong (ingestion lag rising, error rate spiking, latency degrading, queue depth growing, throughput dropping), when an alert fires on an OTel/Prometheus metric, or for any incident triage that starts from a metric symptom. Composes characterize-metric-anomaly, query-metrics, and metric-names-list with logs (query-logs) and traces (APM span tools) for cross-signal root-cause correlation.',
    source: 'PostHog/ai-plugin/skills/investigating-metric-anomalies/SKILL.md',
  },
  {
    id: 'posthog:investigating-replay',
    plugin: 'posthog',
    kind: 'skill',
    name: 'investigating-replay',
    description:
      'Investigates a session recording by gathering metadata, person profile, same-session events, and linked error tracking issues in one pass. Use when a user provides a recording or session ID and wants to understand what happened — who the user was, what they did, what errors occurred, and whether there are related error tracking issues. Replaces the manual chain of session-recording-get, persons-retrieve, execute-sql, and query-error-tracking-issues-list.',
    source: 'PostHog/ai-plugin/skills/investigating-replay/SKILL.md',
  },
  {
    id: 'posthog:linking-errors-to-traces',
    plugin: 'posthog',
    kind: 'skill',
    name: 'linking-errors-to-traces',
    description:
      "Links a PostHog error occurrence or session's errors to OpenTelemetry traces, logs with the same trace ID, and Session Replay. Use when the user asks for trace or span IDs on an error, same-trace logs, or backend traces for errors in a session. Starts from an occurrence UUID, session ID, or error tracking issue URL. For a general issue diagnosis or replay summary, use investigating-error-issue or investigating-replay.",
    source: 'PostHog/ai-plugin/skills/linking-errors-to-traces/SKILL.md',
  },
  {
    id: 'posthog:managing-endpoint-versions',
    plugin: 'posthog',
    kind: 'skill',
    name: 'managing-endpoint-versions',
    description:
      'Work safely with endpoint versions — preview a draft in the playground, roll back to an older version, update settings on one version without bumping query history, deactivate a specific version. Use when the user asks "how do I roll back my endpoint", "preview my changes before publishing", "I want to fix v5 without bumping the version", or anything involving the version history. Calls out today\'s limitations honestly: there is no pointer flip; "rollback" means forking the old query into a new top version.',
    source: 'PostHog/ai-plugin/skills/managing-endpoint-versions/SKILL.md',
  },
  {
    id: 'posthog:managing-experiment-lifecycle',
    plugin: 'posthog',
    kind: 'skill',
    name: 'managing-experiment-lifecycle',
    description:
      'Guides experiment state transitions: launching, pausing, resuming, freezing/unfreezing exposure, ending, shipping variants, archiving, resetting, duplicating, copying to another project, and migrating a legacy experiment to the new experiments engine. Covers preconditions, implications for variant assignment and analysis, and the decision framework for when to use each action.\nTRIGGER when: user asks to launch, pause, resume, end, ship, archive, reset, duplicate, or copy an experiment to another project, to freeze/unfreeze exposure (stop enrolling new users while metrics keep flowing, or reopen enrollment), or to migrate, convert, move or upgrade a legacy experiment to the new engine or the new metric format.\nDO NOT TRIGGER when: user is creating an experiment (use creating-experiments), configuring rollout (use configuring-experiment-rollout), or setting up metrics (use configuring-experiment-analytics).',
    source: 'PostHog/ai-plugin/skills/managing-experiment-lifecycle/SKILL.md',
  },
  {
    id: 'posthog:managing-path-cleaning-rules',
    plugin: 'posthog',
    kind: 'skill',
    name: 'managing-path-cleaning-rules',
    description:
      'Inspects URL paths and proposes, tests, orders, and applies project-level path cleaning rules so dynamic segments (numeric IDs, UUIDs, slugs, dates) collapse into readable aliases. Use when the user says "clean the paths", "normalize URLs", "group similar pages", "too many distinct paths", "/users/123 and /users/456 are the same page", "set up path cleaning", or asks why a Web analytics or Paths breakdown is fragmented across thousands of nearly-identical URLs. Covers regex syntax (re2), alias placeholder convention, rule ordering, the test workflow, and applying rules via the path-cleaning-rules-update MCP tool.',
    source: 'PostHog/ai-plugin/skills/managing-path-cleaning-rules/SKILL.md',
  },
  {
    id: 'posthog:managing-reminders',
    plugin: 'posthog',
    kind: 'skill',
    name: 'managing-reminders',
    description:
      'Create and manage PostHog reminders — private, human-paced nudges that fire as in-app notifications on a schedule, optionally linked to a PostHog resource. Use when the user says "remind me to…", wants a one-off or recurring nudge (daily/weekly/monthly/yearly, a cron schedule, or a specific date/time), wants to be reminded to look at a dashboard, insight, experiment, feature flag, survey, notebook, replay, or error, or wants to list, change, or cancel their reminders. Covers when to pick a reminder over an alert or subscription, the one-off vs recurring vs cron schedule field mappings, timezones, and attaching a resource.',
    source: 'PostHog/ai-plugin/skills/managing-reminders/SKILL.md',
  },
  {
    id: 'posthog:managing-streamlit-apps',
    plugin: 'posthog',
    kind: 'skill',
    name: 'managing-streamlit-apps',
    description:
      'Create, deploy, and operate Streamlit apps in PostHog via the streamlit-apps MCP tools — create an app, set its source, read and patch its code, start and stop its sandbox, poll status, list versions, delete, and share the app with humans via its PostHog URL. Use when asked to "create a streamlit app", "deploy a data app", "ship a dashboard app", "restart/stop my app", "why is my app not running", or "give me a link to the app".',
    source: 'PostHog/ai-plugin/skills/managing-streamlit-apps/SKILL.md',
  },
  {
    id: 'posthog:managing-subscriptions',
    plugin: 'posthog',
    kind: 'skill',
    name: 'managing-subscriptions',
    description:
      'Create and manage scheduled PostHog subscriptions for insight snapshots, dashboard snapshots, and AI prompt reports. Use when a user wants recurring email, Slack, or Microsoft Teams delivery; an AI summary; delivery history; schedule or recipient changes; a test delivery; pause, resume, or deletion; or help with subscription permissions, limits, billing, and failures. Use product alerts when delivery must depend on a threshold or anomaly.',
    source: 'PostHog/ai-plugin/skills/managing-subscriptions/SKILL.md',
  },
  {
    id: 'posthog:modeling-activation-metrics',
    plugin: 'posthog',
    kind: 'skill',
    name: 'modeling-activation-metrics',
    description:
      'Build reusable activation models — an activation-rate metric and a per-user/per-account activated flag — on either PostHog data-warehouse views (HogQL) or an external dbt project. Use when the user wants to define, model, or measure activation, the "aha moment", onboarding success, or which early actions predict a user sticking around. The core idea this skill enforces: activation is NOT a single assumed event — it is a retention-validated combination of early actions, chosen by balancing reach (enough users hit it) against predictive power (those who hit it retain much better). Covers finding candidate actions, validating them against retention lift, count thresholds and action combinations, per-product and B2B group-level activation, and modeling the winning definition as a durable activated-flag + activation-rate model. Read modeling-warehouse-foundations first; composes modeling-product-usage-metrics for the retention validation.',
    source: 'PostHog/ai-plugin/skills/modeling-activation-metrics/SKILL.md',
  },
  {
    id: 'posthog:modeling-conversion-metrics',
    plugin: 'posthog',
    kind: 'skill',
    name: 'modeling-conversion-metrics',
    description:
      'Build reusable conversion models — funnel/step conversion rates, drop-off, and time-to-convert — on either PostHog data-warehouse views (HogQL) or an external dbt project. Use when the user wants to model, define, or compute a conversion rate, funnel, step completion, drop-off, activation-funnel, signup-to-paid, or any "what % of users who did A went on to do B (within N days)" metric. Covers the funnel model (ordered steps, the conversion-window time-box, strict vs any-order), the person-vs-group aggregation unit, overall vs step-to-step conversion (two different numbers), breakdown attribution, and when a saved funnel insight beats a warehouse view. On PostHog, model funnels in HogQL with windowFunnel; in dbt, stage the event stream and compute an fct_conversion mart with tests. Read modeling-warehouse-foundations first for the view-vs-dbt mechanics; pairs with query-funnel for interactive analysis.',
    source: 'PostHog/ai-plugin/skills/modeling-conversion-metrics/SKILL.md',
  },
  {
    id: 'posthog:modeling-dimension-tables',
    plugin: 'posthog',
    kind: 'skill',
    name: 'modeling-dimension-tables',
    description:
      'Build reusable dimension / lookup tables for a star schema — country/region, timezone, currency, date, plan/product, and other descriptive attributes — on either PostHog data-warehouse views (HogQL) or an external dbt project. Use when the user wants to model dimension tables, lookup tables, a star schema, conformed dimensions, or wants to enrich events/revenue/usage with country, region, timezone, plan, or currency attributes without repeating JOINs. Covers sourcing the dimension data (upload, warehouse source, or derive from events), shaping it into an aliased one-row-per-entity view (optionally materialized on a slow schedule since dimensions change rarely), and attaching it to facts via a saved or person join so its columns read as native fields. Key rule: for currency use the built-in convertCurrency() instead of a hand-rolled rate table. Read modeling-warehouse-foundations first; dimensions here are reused by the revenue, conversion, activation, and product-usage modeling skills.',
    source: 'PostHog/ai-plugin/skills/modeling-dimension-tables/SKILL.md',
  },
  {
    id: 'posthog:modeling-product-usage-metrics',
    plugin: 'posthog',
    kind: 'skill',
    name: 'modeling-product-usage-metrics',
    description:
      'Build reusable product-usage and engagement models — retention, stickiness, and lifecycle — on either PostHog data-warehouse views (HogQL) or an external dbt project. Use when the user wants to model, define, or compute whether users come back (retention / churn), how frequently they engage (stickiness / power users / DAU-WAU-MAU ratio), or the composition of the active base (new / returning / resurrecting / dormant lifecycle). These three are one engagement family sharing a start-event/return-event vocabulary and an interval granularity; this skill treats them together and helps pick the right lens: retention for the return-rate cohort matrix, stickiness for the frequency distribution, lifecycle for growth quality. On PostHog, model them in HogQL (mirroring query-retention / query-stickiness / query-lifecycle); in dbt, build fct_retention / fct_stickiness / fct_lifecycle marts with tests. Read modeling-warehouse-foundations first; feeds the retention validation used by modeling-activation-metrics.',
    source: 'PostHog/ai-plugin/skills/modeling-product-usage-metrics/SKILL.md',
  },
  {
    id: 'posthog:modeling-revenue-metrics',
    plugin: 'posthog',
    kind: 'skill',
    name: 'modeling-revenue-metrics',
    description:
      'Build reusable revenue models — MRR, ARR, gross revenue, new/expansion/contraction/churn, ARPU, LTV, and per-customer/per-account revenue — on either PostHog data-warehouse views (HogQL) or an external dbt project. Use when the user wants to model, define, or compute recurring revenue, monthly/annual recurring revenue, churn or retention of revenue, lifetime value, average revenue per user, or revenue by customer, cohort, product, or currency. On PostHog, build on the managed *_revenue_view views (revenue_item, mrr, customer, subscription, charge, product) fed by Stripe or custom revenue events — not raw Stripe tables — and normalize money with convertCurrency(). In dbt, stage the payment source and compute fct_mrr / fct_revenue_item / dim_customer marts with tests. Covers picking the right source, the subscription-config gotcha that leaves MRR empty, currency handling, and linking revenue to persons/groups. Read modeling-warehouse-foundations first for the view-vs-dbt mechanics.',
    source: 'PostHog/ai-plugin/skills/modeling-revenue-metrics/SKILL.md',
  },
  {
    id: 'posthog:modeling-warehouse-foundations',
    plugin: 'posthog',
    kind: 'skill',
    name: 'modeling-warehouse-foundations',
    description:
      'Shared foundations for building reusable data models in PostHog, on either of two stacks: PostHog-native data-warehouse views / materialized views (HogQL, via the view-* MCP tools), or an external dbt project (sources.yml + staging/marts + schema tests) run against your own or PostHog\'s managed warehouse. Read before authoring any specific business model — covers the PostHog-vs-dbt decision, the view-create → view-materialize → sync_frequency workflow and the HogQL column-aliasing rule, the dbt project skeleton and the honest "no native dbt integration" picture, warehouse joins and star-schema dimensions, currency conversion with convertCurrency(), and checking/registering models in the data catalog for reuse. Companion to the domain skills modeling-revenue-metrics, modeling-conversion-metrics, modeling-activation-metrics, modeling-product-usage-metrics, and modeling-dimension-tables. Use when the user asks how to build a view, materialized view, or dbt model in PostHog, or which of the two stacks to use.',
    source: 'PostHog/ai-plugin/skills/modeling-warehouse-foundations/SKILL.md',
  },
  {
    id: 'posthog:querying-canvas-data',
    plugin: 'posthog',
    kind: 'skill',
    name: 'querying-canvas-data',
    description:
      "Get PostHog data into a canvas correctly: the host-injected `ph` SDK (loadInsight, query, capture, state, connectors, openExternal, navigate), the data hierarchy (saved insights first, typed query nodes second, inline HogQL last), verifiability (insight-backed metrics link their saved insight in PostHog; ad-hoc queries expose the exact query that ran), per-insight-type result shapes, progressive per-query loading, date-range wiring, live third-party data through the viewer's own connections (ph.connectors), and event capture from a canvas. Use whenever a canvas shows metrics, charts, tables, any PostHog data, or data from GitHub or an MCP server, or needs to send analytics events.",
    source: 'PostHog/ai-plugin/skills/querying-canvas-data/SKILL.md',
  },
  {
    id: 'posthog:querying-posthog-data',
    plugin: 'posthog',
    kind: 'skill',
    name: 'querying-posthog-data',
    description:
      'Explains how to query PostHog data, defaulting to typed runners for supported product analytics. Read it before you write HogQL/SQL. Also read it before you call execute-sql against PostHog. Use it to find or aggregate PostHog entities. These entities include insights, dashboards, cohorts, feature flags, experiments, surveys, hog flows, warehouse data, and persons. Use it for trends, funnels, retention, lifecycle, paths, stickiness, web analytics, error tracking, logs, sessions, and LLM traces. Before you calculate a governed business or telemetry measure, check system.information_schema.metrics for an approved definition. Examples include MRR, activation, billable usage, active organizations, and failure rates. Use the approved definition before you derive a measure from raw events or use a typed domain tool. It also covers HogQL differences, system table schemas, functions, query examples, and schema discovery.',
    source: 'PostHog/ai-plugin/skills/querying-posthog-data/SKILL.md',
  },
  {
    id: 'posthog:resolving-ingestion-warnings',
    plugin: 'posthog',
    kind: 'skill',
    name: 'resolving-ingestion-warnings',
    description:
      "Diagnoses and resolves PostHog ingestion warnings — problems recorded while ingesting events (dropped events, rejected person merges, oversized payloads, invalid data). Use when a user asks why events are missing, dropped, or undercounted, why identify/alias calls don't work or accounts stay duplicated, why person or group properties aren't updating or profiles look inflated, why recordings have gaps, heatmaps are empty, LLM token counts are missing, why cookieless events vanish, or whenever the `ingestion_warning` health check fires. Explains severity triage (error = dropped, warning = modified, info = intentional) and routes all warning types — size limits and enrichment, merges and distinct IDs, high-volume distinct IDs, `$process_person_profile`, timestamps, cookieless, heatmaps, transformations, session replay — to per-issue reference files with code-level causes and per-SDK fixes.",
    source: 'PostHog/ai-plugin/skills/resolving-ingestion-warnings/SKILL.md',
  },
  {
    id: 'posthog:review-hog-authoring',
    plugin: 'posthog',
    kind: 'skill',
    name: 'review-hog-authoring',
    description:
      'How to author custom PostHog Review skills: the review perspectives, blind-spot checks, validation criteria, and resolution criteria that drive PostHog Review\'s automated PR reviews. Use when a user wants a new review perspective (a specialist lens on their PRs), a custom blind-spot sweep, their own validation bar for which findings get published, or their own bar for which review comments get implemented. Trigger on "create a PostHog Review perspective", "custom review perspective", "my own blind-spot check", "custom validation criteria", "custom resolution criteria", "tune what PostHog Review publishes", "tune what PostHog Review implements".',
    source: 'PostHog/ai-plugin/skills/review-hog-authoring/SKILL.md',
  },
  {
    id: 'posthog:review-hog-blind-spots-general',
    plugin: 'posthog',
    kind: 'skill',
    name: 'review-hog-blind-spots-general',
    description:
      'Checks each chunk for issues the other reviewers missed. Uses their findings to avoid repeating them.',
    source: 'PostHog/ai-plugin/skills/review-hog-blind-spots-general/SKILL.md',
  },
  {
    id: 'posthog:review-hog-perspective-contracts-security',
    plugin: 'posthog',
    kind: 'skill',
    name: 'review-hog-perspective-contracts-security',
    description:
      'Checks security, input validation, and API compatibility. Reports security and contract issues only.',
    source:
      'PostHog/ai-plugin/skills/review-hog-perspective-contracts-security/SKILL.md',
  },
  {
    id: 'posthog:review-hog-perspective-logic-correctness',
    plugin: 'posthog',
    kind: 'skill',
    name: 'review-hog-perspective-logic-correctness',
    description:
      'Checks business logic, edge cases, data transformations, and queries. Reports correctness issues only.',
    source:
      'PostHog/ai-plugin/skills/review-hog-perspective-logic-correctness/SKILL.md',
  },
  {
    id: 'posthog:review-hog-perspective-performance-reliability',
    plugin: 'posthog',
    kind: 'skill',
    name: 'review-hog-perspective-performance-reliability',
    description:
      'Checks resource use, error recovery, and scaling. Reports performance and reliability issues only.',
    source:
      'PostHog/ai-plugin/skills/review-hog-perspective-performance-reliability/SKILL.md',
  },
  {
    id: 'posthog:review-hog-resolution-criteria',
    plugin: 'posthog',
    kind: 'skill',
    name: 'review-hog-resolution-criteria',
    description:
      'Implements safe, verifiable fixes from review comments. Explains declined requests and asks a human to handle risky changes.',
    source: 'PostHog/ai-plugin/skills/review-hog-resolution-criteria/SKILL.md',
  },
  {
    id: 'posthog:review-hog-resolution-criteria-gaps',
    plugin: 'posthog',
    kind: 'skill',
    name: 'review-hog-resolution-criteria-gaps',
    description:
      'Fixes should-fix and must-fix bugs and missing functionality. Leaves wording, documentation, and style suggestions to the author.',
    source:
      'PostHog/ai-plugin/skills/review-hog-resolution-criteria-gaps/SKILL.md',
  },
  {
    id: 'posthog:review-hog-resolution-criteria-small',
    plugin: 'posthog',
    kind: 'skill',
    name: 'review-hog-resolution-criteria-small',
    description:
      'Fixes small bugs, typos, wording, and outdated documentation. Leaves changes that need a design decision to the author.',
    source:
      'PostHog/ai-plugin/skills/review-hog-resolution-criteria-small/SKILL.md',
  },
  {
    id: 'posthog:review-hog-validation-criteria',
    plugin: 'posthog',
    kind: 'skill',
    name: 'review-hog-validation-criteria',
    description:
      'Keeps findings that affect correctness, security, data, API compatibility, or performance. Drops speculative issues and style suggestions before publishing.',
    source: 'PostHog/ai-plugin/skills/review-hog-validation-criteria/SKILL.md',
  },
  {
    id: 'posthog:reviewing-warehouse-suggestions',
    plugin: 'posthog',
    kind: 'skill',
    name: 'reviewing-warehouse-suggestions',
    description:
      "Reviews PostHog's warehouse suggestions with a person and acts on them. Explains why a view should be materialized, unmaterialized, certified or deprecated using the numbers in the suggestion, changes a materialize suggestion's refresh mode, keys or interval when the person wants something else, then accepts or dismisses it. Use when the user asks what PostHog suggests for their data warehouse, whether to materialize a view, why a view should refresh incrementally or every few hours, or wants to accept, change or dismiss a warehouse suggestion.",
    source: 'PostHog/ai-plugin/skills/reviewing-warehouse-suggestions/SKILL.md',
  },
  {
    id: 'posthog:scanning-experiments-with-replay-vision',
    plugin: 'posthog',
    kind: 'skill',
    name: 'scanning-experiments-with-replay-vision',
    description:
      "Provisions a Replay Vision `experiment` scanner, which watches one experiment's exposed sessions, records each session's variant, samples the variants evenly, and stops when the experiment ends. Covers status guards, a prompt that stays comparable across variants, sizing credit spend against the experiment's own population, creating it disabled so its prompt can be previewed on real sessions, and reading the results per variant.\nTRIGGER when: user wants Replay Vision to watch an experiment, asks to scan or analyze an experiment's recordings with AI, asks \"what are users actually doing in the test variant\", or wants a scanner scoped to an experiment's exposed sessions.\nDO NOT TRIGGER when: creating a general-purpose scanner not tied to an experiment (use creating-replay-vision-scanners), reading observations a scanner already produced (use exploring-replay-vision-observations), or manually browsing an experiment's recordings without AI analysis (use analyzing-experiment-session-replays).",
    source:
      'PostHog/ai-plugin/skills/scanning-experiments-with-replay-vision/SKILL.md',
  },
  {
    id: 'posthog:setting-up-a-custom-rest-source',
    plugin: 'posthog',
    kind: 'skill',
    name: 'setting-up-a-custom-rest-source',
    description:
      'Connect an arbitrary REST API to the PostHog data warehouse as a Custom source by authoring a JSON manifest, with no per-source code. Use when the user points at an API that has no built-in PostHog connector — "import data from this REST API", "sync my internal API", "connect this API from its docs", "build a custom data warehouse source" — and gives a docs URL or a natural-language description of the endpoints. Walks through drafting the RESTAPIConfig manifest (auth — bearer, API key, HTTP basic, or OAuth2 client credentials / refresh token — pagination, record path, incremental cursor, parent/child fan-out), validating it, test-reading live rows to verify the field mappings, and creating the source. If the API already has a native PostHog connector, use setting-up-a-data-warehouse-source instead — this skill checks the connector registry first and only handles APIs with no native connector.',
    source: 'PostHog/ai-plugin/skills/setting-up-a-custom-rest-source/SKILL.md',
  },
  {
    id: 'posthog:setting-up-a-data-warehouse-source',
    plugin: 'posthog',
    kind: 'skill',
    name: 'setting-up-a-data-warehouse-source',
    description:
      'Guide the user through connecting a new data warehouse source — Postgres, MySQL, Stripe, Hubspot, MongoDB, Salesforce, BigQuery, Snowflake, and so on. Use when the user wants to "connect Stripe", "import data from Postgres", "add a new data source", "sync my warehouse tables", or wants to pick sync methods for each table. Walks through source-type discovery, credential validation, table discovery, per-table sync_type selection, and the final create call. Also covers picking a good prefix and what to do right after creation.',
    source:
      'PostHog/ai-plugin/skills/setting-up-a-data-warehouse-source/SKILL.md',
  },
  {
    id: 'posthog:setting-up-data-catalog',
    plugin: 'posthog',
    kind: 'skill',
    name: 'setting-up-data-catalog',
    description:
      "Populates and maintains a project's data catalog (semantic layer): canonical metrics, trust marks (certifications) on warehouse tables/views, and reviewed table relationships. Use when asked to set up / seed / bootstrap the data catalog or semantic layer, to catalog a project's metrics, to certify or deprecate data sources, to propose or review table joins, or to work through the proposal review queue. To *use* an existing catalog to answer a business-number question, see querying-posthog-data instead. Trigger terms: data catalog, semantic layer, canonical metric, certify table, deprecate source, relationship proposal, metric drift, review queue.",
    source: 'PostHog/ai-plugin/skills/setting-up-data-catalog/SKILL.md',
  },
  {
    id: 'posthog:setting-up-warehouse-properties',
    plugin: 'posthog',
    kind: 'skill',
    name: 'setting-up-warehouse-properties',
    description:
      'Populate person or group properties from a data warehouse table or materialized view, so warehouse columns become properties usable in feature flags, cohorts, and insights. Use when the user wants to "sync my Postgres columns to person properties", "map a warehouse table to people", "replace our daily identify cron", "update person properties from the warehouse", or asks for reverse ETL into PostHog. Covers picking the table and the identifier column, proposing a whole-table column mapping in one call, excluding identity and reserved properties, checking collisions with properties that already exist, and running the first backfill.',
    source: 'PostHog/ai-plugin/skills/setting-up-warehouse-properties/SKILL.md',
  },
  {
    id: 'posthog:signals',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals',
    description:
      'How to query the document_embeddings table for raw signal data using HogQL. Use when you need to perform semantic search over signals, fetch every signal that contributed to a specific report, or list signal types. For browsing the curated report layer (the Inbox) — listing reports, filtering by status/source, drilling into a single report by ID — use the `inbox-exploration` skill first; drop into this skill afterwards if the user wants the underlying observations.',
    source: 'PostHog/ai-plugin/skills/signals/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-ai-observability',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-ai-observability',
    description:
      'Signals scout for PostHog AI observability. Watches LLM traces for cost, latency, error, volume, and eval-performance regressions.',
    source: 'PostHog/ai-plugin/skills/signals-scout-ai-observability/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-anomaly-detection',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-anomaly-detection',
    description:
      "Signals scout that watches the project's most-viewed dashboards and insights for anomalies — bursts, drops, flat-lines, and trend breaks — against each insight's own seasonality-matched baseline.",
    source: 'PostHog/ai-plugin/skills/signals-scout-anomaly-detection/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-apm',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-apm',
    description:
      'Signals scout for PostHog distributed tracing (APM / OpenTelemetry spans). Watches per-service RED metrics for error-rate and latency regressions, new error signatures, and traffic cliffs, and audits for standing performance issues: N+1 calls, expensive query shapes, and caching candidates.',
    source: 'PostHog/ai-plugin/skills/signals-scout-apm/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-conversations',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-conversations',
    description:
      'Signals scout for PostHog Conversations (support inbox). Watches `$conversation_*` ticket- lifecycle events for SLA breach steps, first-response latency blowouts, backlog imbalance, and channel or assignment concentration.',
    source: 'PostHog/ai-plugin/skills/signals-scout-conversations/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-csp-violations',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-csp-violations',
    description:
      'Signals scout for Content Security Policy violations. Watches `$csp_violation` events for blocked-URL clusters, per-directive bursts, post-deploy regressions, and suspicious third- party domains.',
    source: 'PostHog/ai-plugin/skills/signals-scout-csp-violations/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-customer-analytics',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-customer-analytics',
    description:
      'Signals scout for PostHog Customer analytics (Accounts). Watches per-account engagement for churn-risk shapes — engagement cliffs, dormancy, champion departure — and the expansion inverse.',
    source:
      'PostHog/ai-plugin/skills/signals-scout-customer-analytics/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-customer-analytics-billing-and-usage',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-customer-analytics-billing-and-usage',
    description:
      "Signals scout for per-account product-mix shifts. Watches each staked account's usage and forecasted MRR per product for one product dropping or spiking against its own baseline while the account total holds.",
    source:
      'PostHog/ai-plugin/skills/signals-scout-customer-analytics-billing-and-usage/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-data-pipelines',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-data-pipelines',
    description:
      "Signals scout for PostHog data pipelines — CDP destinations and transformations, batch exports, and hog flows. Watches for delivery failures, degraded functions, and stalled exports against each pipeline's baseline.",
    source: 'PostHog/ai-plugin/skills/signals-scout-data-pipelines/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-data-warehouse',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-data-warehouse',
    description:
      'Signals scout for warehouse imports. Watches external data sources, sync schemas, webhook push channels, and materialized views for failures, silent staleness, and row-volume cliffs, and suggests materialization candidates from recurring query-log hot spots.',
    source: 'PostHog/ai-plugin/skills/signals-scout-data-warehouse/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-error-tracking',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-error-tracking',
    description:
      'Signals scout for PostHog error tracking. Watches `$exception` bursts, stuck loops, multi- fingerprint clusters, and status regressions.',
    source: 'PostHog/ai-plugin/skills/signals-scout-error-tracking/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-experiments',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-experiments',
    description:
      'Signals scout for PostHog A/B experiments. Watches running experiments for validity threats — sample ratio mismatch, contamination, exposure stalls, mid-run flag mutations — and lifecycle drift.',
    source: 'PostHog/ai-plugin/skills/signals-scout-experiments/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-feature-flags',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-feature-flags',
    description:
      'Signals scout for PostHog feature flags. Watches the flag roster and the `$feature_flag_called` stream for evaluation cliffs, ghost flags, response-distribution shifts, and flag debt.',
    source: 'PostHog/ai-plugin/skills/signals-scout-feature-flags/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-first-report',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-first-report',
    description:
      "Runs once after Self-Driving activation to find one valuable, actionable finding in a project's existing product and warehouse data.",
    source: 'PostHog/ai-plugin/skills/signals-scout-first-report/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-general',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-general',
    description:
      "Cross-product Signals scout. Looks for cross-product correlations and explores the surfaces the per-product specialist scouts don't cover.",
    source: 'PostHog/ai-plugin/skills/signals-scout-general/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-health-checks',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-health-checks',
    description:
      "Signals scout over PostHog's own health checks. Bundles the project's active health issues by kind, weights them by blast radius, and surfaces the ones worth acting on.",
    source: 'PostHog/ai-plugin/skills/signals-scout-health-checks/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-inbox-validation',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-inbox-validation',
    description:
      "Follow-up Signals scout for the inbox itself. Attaches a check to each newly resolved report, spot-checks a couple of settled fixes with fresh probes, answers the checks it is dispatched for, and reports when a fix didn't hold, plus a gated escalation check on dismissed reports.",
    source: 'PostHog/ai-plugin/skills/signals-scout-inbox-validation/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-insight-alerts',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-insight-alerts',
    description:
      "Signals scout over the project's configured insight alerts. Reads each alert's recent firing history and surfaces the firings a human likely missed.",
    source: 'PostHog/ai-plugin/skills/signals-scout-insight-alerts/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-logs',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-logs',
    description:
      'Signals scout for PostHog logs. Watches for emerging and rate-shifted message patterns, volume bursts, severity-distribution shifts, service silence, and trace-correlated bursts.',
    source: 'PostHog/ai-plugin/skills/signals-scout-logs/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-mcp-tool-calls',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-mcp-tool-calls',
    description:
      'Signals scout for PostHog MCP tool calls. Watches `$mcp_tool_call` telemetry for tools that need improvement — broad-reach failure rates, retry hammering, slow or context-bloating responses — grouped by owning product category, each with a fix suggestion.',
    source: 'PostHog/ai-plugin/skills/signals-scout-mcp-tool-calls/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-observability-gaps',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-observability-gaps',
    description:
      'Signals scout for observability gaps — significant event volumes with no insight, dashboard, or alert coverage. Recommends new insights, dashboards, or alerts as the product evolves.',
    source:
      'PostHog/ai-plugin/skills/signals-scout-observability-gaps/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-pr-follow-up',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-pr-follow-up',
    description:
      "Follow-up Signals scout for recently merged pull requests. Works out whether each one has deployed, then checks the project's telemetry for whether it did what it claimed, had the impact it expected, or caused a side effect that needs a look.",
    source: 'PostHog/ai-plugin/skills/signals-scout-pr-follow-up/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-product-analytics',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-product-analytics',
    description:
      "Signals scout for core product-analytics flows — funnels, retention, lifecycle, stickiness, and paths. Watches the team's saved flows for a derived-rate regression while entrants hold.",
    source: 'PostHog/ai-plugin/skills/signals-scout-product-analytics/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-replay-vision',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-replay-vision',
    description:
      'Signals scout for PostHog Replay Vision scanners. Watches that enabled scanners keep observing (throughput and quota cliffs) and that aggregate score shifts and recurring themes get surfaced.',
    source: 'PostHog/ai-plugin/skills/signals-scout-replay-vision/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-revenue-analytics',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-revenue-analytics',
    description:
      'Signals scout for PostHog revenue analytics. Watches for upstream failures (Stripe sync stalls, capture regressions), and config drift.',
    source: 'PostHog/ai-plugin/skills/signals-scout-revenue-analytics/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-session-replay',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-session-replay',
    description:
      'Signals scout for PostHog session replay. Watches that sessions keep recording (capture cliffs) and surfaces friction inside recordings — rage/dead-click clusters, error-after- interaction cohorts.',
    source: 'PostHog/ai-plugin/skills/signals-scout-session-replay/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-skills-store',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-skills-store',
    description:
      "Skill-hygiene scout for the team's PostHog skills store. Watches recently-changed and most- used skills for authoring violations — vague descriptions, bloated bodies, dead file links, kitchen-sink scope, committed secrets.",
    source: 'PostHog/ai-plugin/skills/signals-scout-skills-store/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-surveys',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-surveys',
    description:
      'Signals scout for PostHog surveys. Watches active surveys for score regressions, response- volume drops, abandonment spikes, and targeting drift, and aggregates open-text responses into recurring themes.',
    source: 'PostHog/ai-plugin/skills/signals-scout-surveys/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-tasks',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-tasks',
    description:
      "Signals scout for PostHog Tasks. Watches delivery health — failing runs clustered by repository and error class, retry storms — and, on a slower rotation, recurring demand across human-authored tasks. Skips the scout fleet's own runs.",
    source: 'PostHog/ai-plugin/skills/signals-scout-tasks/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-unused-features',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-unused-features',
    description:
      'Signals scout for the parts of a product people barely use. Measures each clickable element and page against the reach of where it lives, gives each barely used one a likely cause, and reports the ones that are reachable and still not used.',
    source: 'PostHog/ai-plugin/skills/signals-scout-unused-features/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-web-analytics',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-web-analytics',
    description:
      "Signals scout for PostHog web traffic. Watches per-channel session volume, attribution breakage, and landing-page health (bounce and 404 steps) against the site's own baseline. Per- page web vitals belong to `signals-scout-web-vitals`.",
    source: 'PostHog/ai-plugin/skills/signals-scout-web-analytics/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-web-vitals',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-web-vitals',
    description:
      "Signals scout for Core Web Vitals (`$web_vitals`). Watches each page's p75 LCP / INP / CLS / FCP against Google's thresholds and its own history — poor-band pages, band crossings, sharp regressions — and dates each regression against deploys and flag rollouts.",
    source: 'PostHog/ai-plugin/skills/signals-scout-web-vitals/SKILL.md',
  },
  {
    id: 'posthog:signals-scout-workflows',
    plugin: 'posthog',
    kind: 'skill',
    name: 'signals-scout-workflows',
    description:
      "Signals scout for PostHog workflows. Looks at the workflows whose owner asked for suggestions, reads each email step's per-version delivery metrics, and proposes one concrete change a person can approve, filed through the workflows suggestions API. It files no report and emits no signal: the suggestion on the workflow page is the output.",
    source: 'PostHog/ai-plugin/skills/signals-scout-workflows/SKILL.md',
  },
  {
    id: 'posthog:skills-store',
    plugin: 'posthog',
    kind: 'skill',
    name: 'skills-store',
    description:
      'Discover and use shared team skills stored in PostHog. Use when the user asks to list, browse, load, or manage "shared skills", "team skills", or references the "skills store" / "skill store".',
    source: 'PostHog/ai-plugin/skills/skills-store/SKILL.md',
  },
  {
    id: 'posthog:suggesting-data-imports',
    plugin: 'posthog',
    kind: 'skill',
    name: 'suggesting-data-imports',
    description:
      'Use when the user asks about revenue, payments, subscriptions, billing, CRM deals, support tickets, ad spend, production database tables, or other data PostHog does not collect natively — or wants to join or correlate PostHog product events with that external business data. Also use when a query fails because a table does not exist or returns no results for expected external data. The data warehouse can import from SaaS tools (Stripe, Hubspot, Zendesk, etc.), ad platforms, production databases (Postgres, MySQL, BigQuery, Snowflake), and other arbitrary data sources. Covers checking existing sources, identifying the right source type, and guiding the setup.',
    source: 'PostHog/ai-plugin/skills/suggesting-data-imports/SKILL.md',
  },
  {
    id: 'posthog:suggesting-path-cleaning-rules',
    plugin: 'posthog',
    kind: 'skill',
    name: 'suggesting-path-cleaning-rules',
    description:
      'Runs and reasons about the automated AI health check that suggests path-cleaning rules for web-analytics teams. Use when asked to generate path-cleaning suggestions for a team or cohort, to run the suggestion check, to review/apply AI-suggested rules, to inspect path_cleaning_suggestions health issues, or to extend the suggestion pipeline. Covers the suggest_path_cleaning_rules management command, the path_cleaning_suggestions health check, the cohort gating (precompute teams), and how suggestions are validated against real paths before storage. For hand-authoring or applying rules directly, use managing-path-cleaning-rules instead.',
    source: 'PostHog/ai-plugin/skills/suggesting-path-cleaning-rules/SKILL.md',
  },
  {
    id: 'posthog:suppressing-noisy-errors',
    plugin: 'posthog',
    kind: 'skill',
    name: 'suppressing-noisy-errors',
    description:
      'Create PostHog error tracking suppression rules to drop high-volume, low-value errors at ingestion. Use when the user asks "stop capturing this error", "drop browser extension errors", "ignore ResizeObserver loops", "suppress bot-driven errors", or wants to reduce ingestion cost from noisy unactionable errors. Identifies suppression candidates, scopes the filter tightly, decides between full suppression and sampling, and confirms the rule before creating it. Suppressed errors are dropped permanently — this skill defaults to caution.',
    source: 'PostHog/ai-plugin/skills/suppressing-noisy-errors/SKILL.md',
  },
  {
    id: 'posthog:triaging-error-issues',
    plugin: 'posthog',
    kind: 'skill',
    name: 'triaging-error-issues',
    description:
      'Triage PostHog error tracking issues during a daily or on-call review. Use when the user asks "what\'s broken?", "what new errors do we have?", "show me top errors today", "what should I look at this morning", or wants a prioritized list of active issues to work on. Surfaces new and high-impact issues, ranks by users affected and recency, points at linked replays, and proposes next actions (investigate, assign, suppress, merge).',
    source: 'PostHog/ai-plugin/skills/triaging-error-issues/SKILL.md',
  },
  {
    id: 'posthog:triaging-visual-review-runs',
    plugin: 'posthog',
    kind: 'skill',
    name: 'triaging-visual-review-runs',
    description:
      'Inspects PostHog Visual Review (VR) runs that gate PR merges with screenshot regression checks. Use when the user mentions "visual review", "VR", "snapshot diff", "screenshot test", "storybook regression", "playwright snapshot", "quarantine", asks why a PR is blocked or what changed visually, wants to triage the VR backlog, decide whether a snapshot diff is real vs flaky, quarantine or lift a flaky story, or check whether a story has been changing across runs. Also invoke when a PR has a failing `visual-review` status check, when a PR comment mentions "Visual review", when a PR from a fork fails `Visual regression tests pass`, or when the user is on a branch with an open VR run.',
    source: 'PostHog/ai-plugin/skills/triaging-visual-review-runs/SKILL.md',
  },
  {
    id: 'posthog:tuning-incremental-sync-config',
    plugin: 'posthog',
    kind: 'skill',
    name: 'tuning-incremental-sync-config',
    description:
      'Change the sync configuration of an existing data warehouse schema — switch sync_type, pick a different incremental_field, set primary_key_columns, choose cdc_table_mode, or change sync_frequency. Use when the user asks "switch my orders table from full refresh to incremental", "this table is syncing too slowly / too frequently", "I need to pick a different incremental column", "set up CDC for this Postgres table", or when diagnosis of a failing sync pointed to an incremental-field or PK misconfiguration.',
    source: 'PostHog/ai-plugin/skills/tuning-incremental-sync-config/SKILL.md',
  },
  {
    id: 'posthog:turning-engineering-analytics-into-insights',
    plugin: 'posthog',
    kind: 'skill',
    name: 'turning-engineering-analytics-into-insights',
    description:
      'Converts engineering analytics (PR / CI) data into saved PostHog insights, dashboards, and subscriptions, and explains how to query the product data directly with SQL. Covers discovering per-team GitHub warehouse tables via engineering-analytics-sources, replicating curated column semantics in HogQL, reading exposed engineering_analytics_* warehouse views where product logic is involved (CI cost, fingerprinted failure lines, commit attribution), saving queries with insight-create, and scheduling delivery with subscriptions-create. Use when asked to "save this as an insight", "put CI health / merge times on a dashboard", "email me PR throughput weekly", "chart CI cost", "track time to first review", "subscribe to these numbers", "alert on CI success rate", or "what data/tables/views does engineering analytics read". For ad-hoc CI and merge questions use diagnosing-ci-and-merge-bottlenecks; to investigate one specific CI failure use investigating-ci-failures.',
    source:
      'PostHog/ai-plugin/skills/turning-engineering-analytics-into-insights/SKILL.md',
  },
  {
    id: 'posthog:understanding-billing-usage',
    plugin: 'posthog',
    kind: 'skill',
    name: 'understanding-billing-usage',
    description:
      "Explains PostHog billing usage and spend from the customer's visible Billing MCP tools. Use when the user asks why usage or spend is high, which product or project is driving usage, what a usage type means, how to reduce usage, what changed over time, why they got a usage change alert, or whether a spike/drop alert was real or noisy. Also use before product-specific analytics skills when the user names a billable PostHog product metric such as events, recordings, feature flag requests, exceptions, survey responses, synced rows, logs, AI events, AI credits, or Inbox credits. Starts from Billing usage/spend tools, then routes to customer-visible product MCP surfaces for deeper investigation.",
    source: 'PostHog/ai-plugin/skills/understanding-billing-usage/SKILL.md',
  },
  {
    id: 'posthog:validating-and-publishing-canvases',
    plugin: 'posthog',
    kind: 'skill',
    name: 'validating-and-publishing-canvases',
    description:
      'Validate and publish a canvas source project safely: the source-project shape, declared capabilities, reading the current version pointer, iterating on validation diagnostics, guarded publishing with expected_current_version_id, staging a draft build and promoting it, waiting out the queued build, and recovering from a 409 version_conflict or a 429 capacity limit without overwriting concurrent work. Use whenever a canvas edit is ready to save, a draft build is wanted, a canvas publish or build returns diagnostics or a conflict, or a task needs to understand canvas version history.',
    source:
      'PostHog/ai-plugin/skills/validating-and-publishing-canvases/SKILL.md',
  },
  {
    id: 'posthog:working-with-autoresearch',
    plugin: 'posthog',
    kind: 'skill',
    name: 'working-with-autoresearch',
    description:
      'Use PostHog Autoresearch, agent-driven predictive models: ask "who will do X in the next N days?", let an agent train a model, then score people daily into a person property and `autoresearch_prediction` events. Use when a user wants to predict churn, activity, return, feature adoption, conversion or any event or action per person; create or validate a model from a template; start training or score now; read model quality (holdout vs realized AUC, lift, calibration, likelihood segments, coverage); steer training with suggestions; act on predictions with cohorts, feature flags, workflows or SQL; or diagnose a model that fails to train, scores everyone the same, or stops scoring. Trigger on "autoresearch", "predictive model", "propensity score", "churn prediction", "likely to convert", "who will do X", "predicted_p_", "autoresearch_prediction", "realized AUC", "champion model".',
    source: 'PostHog/ai-plugin/skills/working-with-autoresearch/SKILL.md',
  },
  {
    id: 'posthog:working-with-scouts',
    plugin: 'posthog',
    kind: 'skill',
    name: 'working-with-scouts',
    description:
      'Work with PostHog Signals scouts: scheduled agents that monitor a project and write reports into the Signals inbox. Use to assign monitoring work, schedule quality scoring, find which scout covers a surface, act on reports, reduce noise, investigate missing findings, or improve the fleet through feedback and calibration. Also covers follow-up checks that verify whether a reported problem stays fixed. Use `authoring-scouts` for edits, `exploring-scouts` for run observability, and `inbox-exploration` for report triage. Trigger on "work with my scouts", "get more out of scouts", "have a scout watch X", "tell me if Y spikes", "score X on a schedule", "measure quality of Y", "what do I do with this scout report", "calibrate/review my scout fleet".',
    source: 'PostHog/ai-plugin/skills/working-with-scouts/SKILL.md',
  },
  {
    id: 'posthog:working-with-skills',
    plugin: 'posthog',
    kind: 'skill',
    name: 'working-with-skills',
    description:
      'Best practices for agents managing PostHog skills via the MCP `skill-*` tools — how to discover, read, create, update, and refactor skills efficiently, especially large skills with many bundled files. Use whenever you are about to call any `skill-*` tool, asked to author or edit a shared skill, or troubleshoot why a skill write was rejected. Also use when asked what skills are good for or how to shape one (project hub, runbook, catalog, handover, daily driver). Pairs with `skills-store` (which covers the raw tool surface) by adding the decision-tree, efficiency, pattern, and pitfall guidance.',
    source: 'PostHog/ai-plugin/skills/working-with-skills/SKILL.md',
  },
  {
    id: 'posthog:working-with-task-comments',
    plugin: 'posthog',
    kind: 'skill',
    name: 'working-with-task-comments',
    description:
      'Read and use comments attached to the current PostHog task, its artifacts, and any canvas through the PostHog MCP exec dispatcher. Use when the user mentions task comments, artifact or canvas comments, annotations, selected-text feedback, replies, unresolved comments, or asks an agent to inspect or act on feedback left in PostHog Desktop. Covers exec discovery and calls, target filtering, pagination, full-thread retrieval, anchor/version context, task-scoped access, and standalone canvas comments that have no task.',
    source: 'PostHog/ai-plugin/skills/working-with-task-comments/SKILL.md',
  },
  {
    id: 'posthog:writing-simplified-technical-english',
    plugin: 'posthog',
    kind: 'skill',
    name: 'writing-simplified-technical-english',
    description:
      'Write English that a reader cannot misread: one meaning per word, active voice, simple tenses, one idea per sentence, short sentences. Based on ASD-STE100 (Simplified Technical English), the controlled-language standard written for aircraft maintenance manuals. Use it for any prose an agent produces that someone else acts on. That covers reports and findings, PR descriptions and commit messages, instructions handed to another agent, tool descriptions, error messages, status summaries, and prompts. Also use it on request, with triggers like "simplify this", "make this readable", "too dense", "rewrite in STE", "simplified technical english", "ASD-STE100".',
    source:
      'PostHog/ai-plugin/skills/writing-simplified-technical-english/SKILL.md',
  },
  {
    id: 'posthog:writing-streamlit-apps',
    plugin: 'posthog',
    kind: 'skill',
    name: 'writing-streamlit-apps',
    description:
      'Write Streamlit app source code that runs well in a PostHog sandbox — the posthog_apps.query() bridge for reading PostHog data, the packages baked into the sandbox image, caching and session state across Streamlit reruns, layout and chart patterns, and the app.py entry point with any helper modules and data files bundled beside it. Use when authoring or debugging the Python source of a PostHog Streamlit app, when a query inside an app fails, or when asked to "write a streamlit app that shows PostHog data".',
    source: 'PostHog/ai-plugin/skills/writing-streamlit-apps/SKILL.md',
  },
  {
    id: 'posthog:posthog:llma-cc-ingest',
    plugin: 'posthog',
    kind: 'command',
    name: 'posthog:llma-cc-ingest',
    description:
      'Manually send a Claude Code session log to PostHog LLM Analytics',
    source: 'PostHog/ai-plugin/commands/llma-cc-ingest.md',
  },
  {
    id: 'posthog:posthog:llma-cc-setup',
    plugin: 'posthog',
    kind: 'command',
    name: 'posthog:llma-cc-setup',
    description: 'Set up PostHog LLM Analytics to capture Claude Code sessions',
    source: 'PostHog/ai-plugin/commands/llma-cc-setup.md',
  },
  {
    id: 'posthog:posthog:llma-cc-status',
    plugin: 'posthog',
    kind: 'command',
    name: 'posthog:llma-cc-status',
    description:
      'Check if Claude Code sessions are being sent to PostHog LLM Analytics',
    source: 'PostHog/ai-plugin/commands/llma-cc-status.md',
  },
  {
    id: 'builtin-gh:handle-dependabot',
    plugin: 'builtin-gh',
    kind: 'skill',
    name: 'handle-dependabot',
    description:
      '/builtin-gh:handle-dependabot only. Triage, fix CI, merge, and clean up alerts for open Dependabot PRs',
    source:
      'canopy/brand-templates/plugins/builtin-gh/skills/handle-dependabot/SKILL.md',
  },
  {
    id: 'builtin-gh:handle-merge-conflicts',
    plugin: 'builtin-gh',
    kind: 'skill',
    name: 'handle-merge-conflicts',
    description:
      '/builtin-gh:handle-merge-conflicts only. Resolve merge conflicts with the base branch',
    source:
      'canopy/brand-templates/plugins/builtin-gh/skills/handle-merge-conflicts/SKILL.md',
  },
  {
    id: 'builtin-gh:handle-pr-checks',
    plugin: 'builtin-gh',
    kind: 'skill',
    name: 'handle-pr-checks',
    description:
      '/builtin-gh:handle-pr-checks only. Examine and address failing CI checks on current PR',
    source:
      'canopy/brand-templates/plugins/builtin-gh/skills/handle-pr-checks/SKILL.md',
  },
  {
    id: 'builtin-gh:handle-pr-comments',
    plugin: 'builtin-gh',
    kind: 'skill',
    name: 'handle-pr-comments',
    description:
      '/builtin-gh:handle-pr-comments only. Review and address PR comments',
    source:
      'canopy/brand-templates/plugins/builtin-gh/skills/handle-pr-comments/SKILL.md',
  },
  {
    id: 'builtin-gh:merge-pr',
    plugin: 'builtin-gh',
    kind: 'skill',
    name: 'merge-pr',
    description:
      '/builtin-gh:merge-pr only. Merge a pull request the way its base branch requires. Without a merge queue it merges directly, or arms auto-merge while checks run. With a merge queue it enqueues the PR and watches it until it lands. When a merge-group check fails, it dequeues early once eviction is certain. On an eviction it diagnoses the failure, fixes and pushes, then re-arms auto-merge so GitHub requeues the PR. A PR queued behind one it conflicts with waits for that PR: resolve and requeue if it merged, requeue unchanged if it failed. Use when the user explicitly asks to merge, land, ship, or queue a PR, or to watch a queued PR through to merge. Never use the merge as a step of another workflow unless the user asked for it, and never bypass the queue with admin privileges.',
    source:
      'canopy/brand-templates/plugins/builtin-gh/skills/merge-pr/SKILL.md',
  },
  {
    id: 'builtin-gh:open-pr',
    plugin: 'builtin-gh',
    kind: 'skill',
    name: 'open-pr',
    description:
      '/builtin-gh:open-pr only. Create a pull request for the current branch',
    source: 'canopy/brand-templates/plugins/builtin-gh/skills/open-pr/SKILL.md',
  },
  {
    id: 'builtin-gh:push-branch',
    plugin: 'builtin-gh',
    kind: 'skill',
    name: 'push-branch',
    description:
      '/builtin-gh:push-branch only. Commit and push all changes with auto-generated message',
    source:
      'canopy/brand-templates/plugins/builtin-gh/skills/push-branch/SKILL.md',
  },
  {
    id: 'builtin-gh:sync-pr-details',
    plugin: 'builtin-gh',
    kind: 'skill',
    name: 'sync-pr-details',
    description:
      'Sync PR title and description with current branch changes. Apply when updating an existing PR, after pushing new commits to a PR branch, when PR description becomes stale or inaccurate, or when explicitly asked to update PR details.',
    source:
      'canopy/brand-templates/plugins/builtin-gh/skills/sync-pr-details/SKILL.md',
  },
  {
    id: 'builtin-git:switch-branch',
    plugin: 'builtin-git',
    kind: 'skill',
    name: 'switch-branch',
    description:
      '/builtin-git:switch-branch only. Switch to an existing branch',
    source:
      'canopy/brand-templates/plugins/builtin-git/skills/switch-branch/SKILL.md',
  },
  {
    id: 'builtin-orchestrate:review',
    plugin: 'builtin-orchestrate',
    kind: 'skill',
    name: 'review',
    description:
      "Run Canopy's bundled Code Review (Multi-Provider) pipeline from a chat — dispatch, result verification, and posting discipline. Use when a scored multi-track review of a worktree's changes is needed, before posting any AI review to GitHub, or when a handoff brief or posting-by-design workflow calls for a review round",
    source:
      'canopy/brand-templates/plugins/builtin-orchestrate/skills/review/SKILL.md',
  },
  {
    id: 'builtin-orchestrate:handoff',
    plugin: 'builtin-orchestrate',
    kind: 'command',
    name: 'handoff',
    description:
      '/builtin-orchestrate:handoff only. Hand planned work to an implementer in a code or cowork project — create an empty chat, send the brief, and watch its completion',
    source:
      'canopy/brand-templates/plugins/builtin-orchestrate/commands/handoff.md',
  },
  {
    id: 'builtin-orchestrate:kickoff',
    plugin: 'builtin-orchestrate',
    kind: 'command',
    name: 'kickoff',
    description:
      '/builtin-orchestrate:kickoff only. Create a workspace worktree (branch + checkout) for ticket work, base-branch-aware — no agent is started',
    source:
      'canopy/brand-templates/plugins/builtin-orchestrate/commands/kickoff.md',
  },
  {
    id: 'builtin-security:attack-path-analysis',
    plugin: 'builtin-security',
    kind: 'skill',
    name: 'attack-path-analysis',
    description:
      'Trace a suspected diff-security finding from attacker-controlled source through transformations and controls to a sensitive sink and consequence.',
    source:
      'canopy/brand-templates/plugins/builtin-security/skills/attack-path-analysis/SKILL.md',
  },
  {
    id: 'builtin-security:finding-discovery',
    plugin: 'builtin-security',
    kind: 'skill',
    name: 'finding-discovery',
    description:
      'Discover concrete candidate security vulnerabilities in a code diff using focused input, authorization, data, boundary, state, and deployment passes.',
    source:
      'canopy/brand-templates/plugins/builtin-security/skills/finding-discovery/SKILL.md',
  },
  {
    id: 'builtin-security:security-diff-scan',
    plugin: 'builtin-security',
    kind: 'skill',
    name: 'security-diff-scan',
    description:
      'Review a pull request, commit, branch diff, patch file, or working-tree change for high-confidence security vulnerabilities introduced or materially worsened by the diff.',
    source:
      'canopy/brand-templates/plugins/builtin-security/skills/security-diff-scan/SKILL.md',
  },
  {
    id: 'builtin-security:threat-model',
    plugin: 'builtin-security',
    kind: 'skill',
    name: 'threat-model',
    description:
      'Identify security-relevant trust-boundary, attacker-capability, asset, entry-point, control, and sink changes introduced by a code diff.',
    source:
      'canopy/brand-templates/plugins/builtin-security/skills/threat-model/SKILL.md',
  },
  {
    id: 'builtin-security:validation',
    plugin: 'builtin-security',
    kind: 'skill',
    name: 'validation',
    description:
      'Validate or reject candidate diff-security findings by tracing reachability, attacker control, security controls, sensitive sinks, and concrete impact.',
    source:
      'canopy/brand-templates/plugins/builtin-security/skills/validation/SKILL.md',
  },
  {
    id: 'builtin-visualize:visualize',
    plugin: 'builtin-visualize',
    kind: 'skill',
    name: 'visualize',
    description:
      'Design and build a visual for a Canopy chat reply with the ShowVisual and PreviewVisual tools: which display fits the data, which CDN libraries load, how to use the theme variables, and how to check the result before showing it. Use before the first ShowVisual or PreviewVisual call in a chat, and whenever the user asks for a chart, graph, plot, diagram, flowchart, timeline, table, dashboard, comparison, or mockup',
    source:
      'canopy/brand-templates/plugins/builtin-visualize/skills/visualize/SKILL.md',
  },
];
