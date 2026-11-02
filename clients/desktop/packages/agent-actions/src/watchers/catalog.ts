import { ORCHESTRATOR_AGENT_NAME } from '@canopy/protocol/ui-labels';

/**
 * Discriminator for the kind of event a watcher waits for. New variants must
 * extend both this union and the host's watcher target union so the catalog,
 * scheduler, and event-matching layers stay in lockstep.
 *
 * - `project_task_chat_completion` / `bot_task_chat_completion` — a canonical
 *   project or bot chat input reaches its terminal event.
 * - `project_new_chat_started` / `bot_new_chat_started` — a newly tracked chat
 *   in a canonical project or bot scope receives its first input.
 * - `worktree_chat_completion` — a worktree-scoped chat turn reaches an idle
 *   terminal state.
 * - `standalone_chat_completion` — a standalone chat turn reaches an idle
 *   terminal state.
 * - `worktree_new_chat_started` — a new tracked chat in a worktree receives
 *   its first user message.
 * - `standalone_new_chat_started` — a new tracked chat in a standalone chat
 *   project receives its first user message.
 * - `worktree_pipeline_completion` — a pipeline execution attached to a
 *   worktree pauses or reaches one of the configured terminal statuses.
 * - `worktree_hook_triggered` — a worktree hook trigger fires automatically,
 *   whether or not a hook action is configured or paused.
 * - `automation_run` — an automation (scheduled activity) run reaches its
 *   outcome. Failed and skipped runs fire immediately; successful runs fire
 *   when the dispatched work (chat turn or pipeline execution) completes, so
 *   the subscriber is never stranded waiting on a run that ended early.
 * - `github_workflow_runs_changed` — one or more of the grouped GitHub Actions
 *   workflow runs a `github_workflow_runs` watcher tracks transitions into a
 *   state selected for notification.
 * - `github_pull_requests_changed` — a pull request a `github_pull_requests`
 *   watcher tracks merged or closed without merging.
 */
export type AgentWatcherTriggerType =
  | 'project_task_chat_completion'
  | 'project_new_chat_started'
  | 'bot_task_chat_completion'
  | 'bot_new_chat_started'
  | 'worktree_chat_completion'
  | 'standalone_chat_completion'
  | 'worktree_new_chat_started'
  | 'standalone_new_chat_started'
  | 'worktree_pipeline_completion'
  | 'worktree_hook_triggered'
  | 'automation_run'
  | 'github_workflow_runs_changed'
  | 'github_pull_requests_changed'
  | 'scheduled_wakeup'
  | 'command_watch_resolved';

/**
 * The provider tool a watcher trigger is created through. GitHub workflow-run
 * watchers are created exclusively via `watch_github_items`; every other
 * trigger is created via `setup_watchers`. Carried on every catalog result so
 * discovery never implies `setup_watchers` accepts GitHub targets.
 */
export type AgentWatcherSetupTool =
  | 'schedule_wakeup'
  | 'watch_command'
  | 'setup_watchers'
  | 'watch_github_items';

/** Watcher target discriminants the catalog describes. */
export type AgentWatcherTargetKind =
  | 'project_task_chat'
  | 'project_chat_scope'
  | 'bot_task_chat'
  | 'bot_chat_scope'
  | 'scheduled_wakeup'
  | 'command_watch'
  | 'worktree_chat'
  | 'standalone_chat'
  | 'worktree_chat_scope'
  | 'standalone_chat_project'
  | 'worktree_pipeline'
  | 'worktree_hook'
  | 'automation'
  | 'github_workflow_runs'
  | 'github_pull_requests';

/** A hook trigger a host offers to `worktree_hook_triggered` watchers. */
export interface AgentWatcherHookTrigger {
  triggerName: string;
  title: string;
  keywords: readonly string[];
}

/**
 * One trigger in the watcher catalog the `setup_watchers` /
 * `search_watchers` tools expose. `usageGuidance` is sent back to the model
 * verbatim so it knows how to discover the id fields it must supply.
 */
export interface AgentWatcherCatalogEntry<
  THook extends AgentWatcherHookTrigger = AgentWatcherHookTrigger,
> {
  trigger: AgentWatcherTriggerType;
  /** Accepted compatibility adapter, never advertised in catalog search. */
  hidden?: boolean;
  /** Human-friendly title shown in catalog responses. */
  title: string;
  /** Discriminant of the watcher target for this trigger. */
  targetKind: AgentWatcherTargetKind;
  /**
   * The provider tool this trigger is created through. Carried on every row so
   * discovery never implies `setup_watchers` accepts GitHub targets.
   */
  setupTool: AgentWatcherSetupTool;
  /** Required `target.*` field names for this trigger. */
  requiredFields: readonly string[];
  /** Optional `target.*` field names for this trigger. */
  optionalFields: readonly string[];
  /** Optional watcher-entry fields that are siblings of `target`. */
  optionalEntryFields?: readonly string[];
  /**
   * Free-form guidance the model uses to discover required ids before
   * calling `setup_watchers`. Returned verbatim in catalog responses.
   */
  usageGuidance: string;
  /** Keywords used for catalog query scoring (in addition to title/usageGuidance/trigger). */
  keywords: readonly string[];
  /** Specific hook triggerName values supported by worktree_hook targets. */
  hookTriggers?: readonly THook[];
}

export interface AgentWatcherCatalogSearchInput {
  query?: string;
  trigger?: AgentWatcherTriggerType;
  limit?: number;
  /**
   * `"minimal"` (default) returns bounded rows; `"standard"` adds usage
   * guidance and hook-trigger details.
   */
  detailLevel?: 'minimal' | 'standard';
}

export interface AgentWatcherCatalogSearchRow<
  THook extends AgentWatcherHookTrigger = AgentWatcherHookTrigger,
> {
  trigger: AgentWatcherTriggerType;
  title: string;
  targetKind: AgentWatcherTargetKind;
  setupTool: AgentWatcherSetupTool;
  requiredFields: string[];
  optionalFields: string[];
  optionalEntryFields: string[];
  usageGuidance?: string;
  hookTriggers?: THook[];
  score: number;
}

/**
 * Soft cap on the number of catalog rows {@link searchAgentWatcherCatalog}
 * returns when the caller does not specify a `limit`. The catalog itself is
 * intentionally short, so the default is generous; the cap exists to keep
 * server-side responses bounded if the catalog grows.
 */
const DEFAULT_CATALOG_LIMIT = 25;
const MAX_CATALOG_LIMIT = 100;

/** Legacy chat rows keep host-neutral discovery text; other hosts still offer them. */
const LEGACY_TARGET_DISCOVERY_GUIDANCE =
  'Discover target ids via the Orchestrator actions: `get_current_ui_state` for the active selection, `workspace.list` / `workspace.list_worktrees` for project worktree ids, `worktree-chat.list_tabs` for worktree chat tabs, `standalone-chat.list_projects` / `standalone-chat.list_chats` for cowork project and chat ids, and the `pipeline.execution_list` / `pipeline.execution_get` actions for pipeline executions. Copy chat row `id` values into `target.chatId`; copy pipeline execution row `id` values into `target.executionId`. Confirm the target is still awaiting a future transition before calling `setup_watchers`: completion watchers observe future transitions only, so setup rejects chats that are already idle unless the watcher entry sets `armForNextCompletion: true`; exact pipeline executions that are already terminal remain rejected. New-chat-started watchers watch future newly tracked chats in the supplied worktree or cowork project. Pipeline pause notifications must be armed before the pause transition. Do not invent ids, use titles/descriptions as ids, pass display metadata, pass session keys, pass destination chat ids, or reuse the Orchestrator sentinel project/worktree as a target.';

const TARGET_DISCOVERY_GUIDANCE = `Use SearchActions to discover projects.list / bots.list, then projects.list_tasks / bots.list_tasks, then projects.list_task_chats / bots.list_task_chats through DispatchAction. Copy the returned IDs, then use SearchWatchers before SetupWatchers. Project agents and delegates are limited to the root project’s saved owner; bot targets require the ${ORCHESTRATOR_AGENT_NAME} project-agent access setting to allow that owner. Orchestrator is not restricted by that setting. Completion watches require a running or pending input unless armForNextCompletion:true is explicitly set beside target. Unknown activity returns runtime_unavailable; do not implicitly arm. Exact terminal pipeline executions remain rejected. Pipeline pauses must be armed before the transition. Never invent IDs or pass kind, destination, session, owner, or display fields for canonical chat targets.`;

const COMPLETION_GUIDANCE =
  'Fires on the watched input’s terminal event, including completed, interrupted, error, and no_output. Set armForNextCompletion:true beside target only to watch the next completion, including an input already running when armed; otherwise a running or pending input is required. Unknown activity returns runtime_unavailable; retry with explicit arm intent only if appropriate. A root cannot watch itself; delegates compare against their root chat.';
const START_GUIDANCE =
  'Fires on the first submitted input in a newly tracked chat, not empty-tab creation. Omit taskId for the whole project or bot, or supply taskId to restrict the scope. Never supply chatId or armForNextCompletion. The destination root chat’s own start is excluded; sibling starts still match.';

/**
 * Build the watcher catalog with the host's hook triggers. The row order is
 * the catalog's tie-break order in search results.
 */
export function buildAgentWatcherCatalog<
  THook extends AgentWatcherHookTrigger,
>(options: {
  hookTriggers: readonly THook[];
  hookTriggerNames: readonly string[];
  pullRequestQueuePhases: readonly string[];
}): readonly AgentWatcherCatalogEntry<THook>[] {
  return [
    {
      trigger: 'scheduled_wakeup',
      title: 'Scheduled wakeup',
      targetKind: 'scheduled_wakeup',
      setupTool: 'schedule_wakeup',
      requiredFields: ['delaySeconds'],
      optionalFields: ['followUpInstruction'],
      usageGuidance:
        'Use ScheduleWakeup for a one-shot wakeup after 60–3600 seconds. The destination is this chat. End the turn after registering; do not sleep or poll. Survives app restarts; overdue wakeups fire after the app reopens.',
      keywords: ['timer', 'delay', 'wake', 'wakeup', 'schedule', 'wait'],
    },
    {
      trigger: 'command_watch_resolved',
      title: 'Watch command',
      targetKind: 'command_watch',
      setupTool: 'watch_command',
      requiredFields: ['command', 'intervalSeconds', 'maxAttempts'],
      optionalFields: ['followUpInstruction'],
      usageGuidance:
        'Prefer a dedicated watcher (especially GitHub CI) or ScheduleWakeup. Otherwise use one short, repeat-safe shell probe: exit 0 means ready, 1 means retry, any other exit fails. Attempts run immediately, then 5–3600 seconds after each unfinished attempt, at most 100 times; each attempt times out after 60 seconds. Never put sleeps, polling loops, or background processes in the command. Terminal output is returned, with large output offloaded to a scope-owned file.',
      keywords: ['command', 'shell', 'probe', 'poll', 'condition'],
    },
    {
      trigger: 'project_task_chat_completion',
      title: 'Project task chat completion',
      targetKind: 'project_task_chat',
      setupTool: 'setup_watchers',
      requiredFields: ['projectId', 'taskId', 'chatId'],
      optionalFields: [],
      optionalEntryFields: ['armForNextCompletion'],
      usageGuidance: `Use SearchActions to discover projects.list, then projects.list_tasks, then projects.list_task_chats through DispatchAction. Copy the returned IDs, then use SearchWatchers before SetupWatchers. Project roots and delegates may watch only targets with the root project’s saved owner; Orchestrator may watch across owners. ${COMPLETION_GUIDANCE} Use the strict envelope: {"watchers":[{"trigger":"project_task_chat_completion","target":{"projectId":"...","taskId":"...","chatId":"..."}}]}. No caller kind, destination, session, owner, or display fields.`,
      keywords: [
        'project',
        'code',
        'cowork',
        'chat',
        'task',
        'completion',
        'completed',
        'finished',
        'idle',
        'turn',
      ],
    },
    {
      trigger: 'project_new_chat_started',
      title: 'New chat started in project',
      targetKind: 'project_chat_scope',
      setupTool: 'setup_watchers',
      requiredFields: ['projectId'],
      optionalFields: ['taskId'],
      usageGuidance: `Use SearchActions to discover projects.list, then projects.list_tasks, then projects.list_task_chats through DispatchAction. Copy the returned IDs, then use SearchWatchers before SetupWatchers. Project roots and delegates may watch only targets with the root project’s saved owner; Orchestrator may watch across owners. ${START_GUIDANCE} Use the strict envelope: {"watchers":[{"trigger":"project_new_chat_started","target":{"projectId":"...","taskId":"..."}}]}. No caller kind, destination, session, owner, or display fields.`,
      keywords: [
        'project',
        'code',
        'cowork',
        'chat',
        'task',
        'new',
        'start',
        'started',
        'created',
        'tracked',
        'message',
      ],
    },
    {
      trigger: 'bot_task_chat_completion',
      title: 'Bot task chat completion',
      targetKind: 'bot_task_chat',
      setupTool: 'setup_watchers',
      requiredFields: ['botId', 'taskId', 'chatId'],
      optionalFields: [],
      optionalEntryFields: ['armForNextCompletion'],
      usageGuidance: `Use SearchActions to discover bots.list, then bots.list_tasks, then bots.list_task_chats through DispatchAction. Copy the returned IDs, then use SearchWatchers before SetupWatchers. Only the public botId app_advisor is registered; never use the internal app-advisor ID. Bot access for project roots and delegates requires the Orchestrator project-agent access setting to allow the root project’s saved owner; Orchestrator is unrestricted by that setting. ${COMPLETION_GUIDANCE} Use the strict envelope: {"watchers":[{"trigger":"bot_task_chat_completion","target":{"botId":"app_advisor","taskId":"...","chatId":"..."}}]}. No caller kind, destination, session, owner, or display fields.`,
      keywords: [
        'bot',
        'advisor',
        'chat',
        'task',
        'completion',
        'completed',
        'finished',
        'idle',
        'turn',
      ],
    },
    {
      trigger: 'bot_new_chat_started',
      title: 'New chat started in bot',
      targetKind: 'bot_chat_scope',
      setupTool: 'setup_watchers',
      requiredFields: ['botId'],
      optionalFields: ['taskId'],
      usageGuidance: `Use SearchActions to discover bots.list, then bots.list_tasks, then bots.list_task_chats through DispatchAction. Copy the returned IDs, then use SearchWatchers before SetupWatchers. Only the public botId app_advisor is registered; never use the internal app-advisor ID. Bot access for project roots and delegates requires the Orchestrator project-agent access setting to allow the root project’s saved owner; Orchestrator is unrestricted by that setting. ${START_GUIDANCE} Use the strict envelope: {"watchers":[{"trigger":"bot_new_chat_started","target":{"botId":"app_advisor","taskId":"..."}}]}. No caller kind, destination, session, owner, or display fields.`,
      keywords: [
        'bot',
        'advisor',
        'chat',
        'task',
        'new',
        'start',
        'started',
        'created',
        'tracked',
        'message',
      ],
    },
    {
      trigger: 'worktree_chat_completion',
      title: 'Worktree chat completion',
      targetKind: 'worktree_chat',
      setupTool: 'setup_watchers',
      requiredFields: ['projectId', 'worktreeId', 'chatId'],
      optionalFields: [],
      optionalEntryFields: ['armForNextCompletion'],
      usageGuidance: `Fires when a worktree chat tab finishes its current turn and returns to an idle state. To arm an idle target, use this exact setup shape with the flag beside target: {"watchers":[{"trigger":"worktree_chat_completion","target":{"kind":"worktree_chat","projectId":"...","worktreeId":"...","chatId":"..."},"armForNextCompletion":true}]}. Omit armForNextCompletion to require a running or pending turn. ${LEGACY_TARGET_DISCOVERY_GUIDANCE}`,
      keywords: [
        'worktree',
        'chat',
        'tab',
        'completion',
        'completed',
        'finished',
        'idle',
        'turn',
      ],
    },
    {
      trigger: 'standalone_chat_completion',
      title: 'Cowork chat completion',
      targetKind: 'standalone_chat',
      setupTool: 'setup_watchers',
      requiredFields: ['projectId', 'chatId'],
      optionalFields: [],
      optionalEntryFields: ['armForNextCompletion'],
      usageGuidance: `Fires when a cowork chat finishes its current turn and returns to an idle state. To arm an idle target, use this exact setup shape with the flag beside target: {"watchers":[{"trigger":"standalone_chat_completion","target":{"kind":"standalone_chat","projectId":"...","chatId":"..."},"armForNextCompletion":true}]}. Omit armForNextCompletion to require a running or pending turn. Here projectId is the cowork project id, not the runtime standalone sentinel. ${LEGACY_TARGET_DISCOVERY_GUIDANCE}`,
      keywords: [
        'cowork',
        'standalone',
        'chat',
        'completion',
        'completed',
        'finished',
        'idle',
        'turn',
      ],
    },
    {
      trigger: 'worktree_new_chat_started',
      title: 'New chat started in worktree',
      targetKind: 'worktree_chat_scope',
      setupTool: 'setup_watchers',
      requiredFields: ['projectId', 'worktreeId'],
      optionalFields: [],
      usageGuidance: `Fires once when a user message is sent in a newly created or newly tracked worktree chat, including forked and hook-initiated chats. Use this exact setup shape: {"watchers":[{"trigger":"worktree_new_chat_started","target":{"kind":"worktree_chat_scope","projectId":"...","worktreeId":"..."}}]}. ${LEGACY_TARGET_DISCOVERY_GUIDANCE}`,
      keywords: [
        'new',
        'started',
        'start',
        'created',
        'tracked',
        'forked',
        'hook',
        'worktree',
        'workspace',
        'chat',
        'user',
        'message',
      ],
    },
    {
      trigger: 'standalone_new_chat_started',
      title: 'New chat started in cowork project',
      targetKind: 'standalone_chat_project',
      setupTool: 'setup_watchers',
      requiredFields: ['projectId'],
      optionalFields: [],
      usageGuidance: `Fires once when a user message is sent in a newly created or newly tracked cowork chat under a cowork project. Use this exact setup shape: {"watchers":[{"trigger":"standalone_new_chat_started","target":{"kind":"standalone_chat_project","projectId":"..."}}]}. Here projectId is the cowork project id, not the runtime standalone sentinel. ${LEGACY_TARGET_DISCOVERY_GUIDANCE}`,
      keywords: [
        'new',
        'started',
        'start',
        'created',
        'tracked',
        'cowork',
        'workspace',
        'standalone',
        'project',
        'chat',
        'user',
        'message',
        'automation',
      ],
    },
    {
      trigger: 'worktree_pipeline_completion',
      title: 'Worktree pipeline completion',
      targetKind: 'worktree_pipeline',
      setupTool: 'setup_watchers',
      requiredFields: ['projectId', 'worktreeId'],
      optionalFields: ['executionId', 'pipelineId', 'terminalStatuses'],
      usageGuidance: `Fires when a pipeline execution attached to a worktree pauses or reaches a terminal status. Pause notifications do not consume the watcher; matching terminal status notifications do. Use this exact setup shape: {"watchers":[{"trigger":"worktree_pipeline_completion","target":{"kind":"worktree_pipeline","projectId":"...","worktreeId":"...","executionId":"..."}}]}. Pin a non-terminal \`executionId\` for a one-shot watcher or omit \`executionId\` to watch future matching runs narrowed by \`pipelineId\` and/or terminal \`terminalStatuses\`. ${TARGET_DISCOVERY_GUIDANCE}`,
      keywords: [
        'pipeline',
        'execution',
        'run',
        'completion',
        'completed',
        'finished',
        'terminal',
        'paused',
        'success',
        'failure',
        'cancelled',
      ],
    },
    {
      trigger: 'worktree_hook_triggered',
      title: 'Worktree hook triggered',
      targetKind: 'worktree_hook',
      setupTool: 'setup_watchers',
      requiredFields: ['projectId', 'worktreeId', 'triggerName'],
      optionalFields: ['hookKey', 'scope', 'repoId'],
      usageGuidance: `Fires once when a supported worktree hook trigger fires automatically, even when the matching hook is paused or no hook action is configured. Manual hook runs do not fire this watcher. Use this exact setup shape: {"watchers":[{"trigger":"worktree_hook_triggered","target":{"kind":"worktree_hook","projectId":"...","worktreeId":"...","triggerName":"pr:update:comments"}}]}. Pick target.triggerName from the hookTriggers list in this search result; for new PR comments use pr:update:comments, and for newly submitted PR reviews with inline comments use pr:reviews:new:has-comments. To watch one configured hook entry, also supply its hookKey; otherwise the watcher matches any scope for that trigger in the target worktree. Supported triggerName values are: ${options.hookTriggerNames.join(', ')}. ${TARGET_DISCOVERY_GUIDANCE}`,
      keywords: [
        'hook',
        'hooks',
        'trigger',
        'triggered',
        'automation',
        'paused',
        'precommit',
        'pre-commit',
        'pr',
        'review',
        'reviews',
        'comment',
        'comments',
        'discussion',
        'inline',
        'checks',
        'merge',
      ],
      hookTriggers: options.hookTriggers,
    },
    {
      trigger: 'automation_run',
      title: 'Automation run completion',
      targetKind: 'automation',
      setupTool: 'setup_watchers',
      requiredFields: ['automationId'],
      optionalFields: [],
      usageGuidance:
        'Fires once per armed watcher when a run of the target automation reaches its outcome. Failed and skipped runs fire immediately with that status. A successful run fires when its dispatched chat turn ends or its dispatched pipeline reaches a terminal status; Orchestrator prompt dispatches still fire at dispatch; bot chat completion watches are separate. Use this exact setup shape: {"watchers":[{"trigger":"automation_run","target":{"kind":"automation","automationId":"..."}}]}. Automations are global to the user; discover ids with the automation.list / automation.get dispatch actions. The watcher is consumed on fire — re-arm it per run for recurring automations, or use the inline watchers field on the automation.create / automation.run_now dispatch actions to arm atomically with the automation. Unknown automation ids are rejected.',
      keywords: [
        'automation',
        'automations',
        'scheduled',
        'activity',
        'run',
        'completion',
        'completed',
        'finished',
        'dispatched',
        'skipped',
        'failure',
        'worktree_prompt',
      ],
    },
    {
      trigger: 'github_workflow_runs_changed',
      title: 'GitHub workflow runs changed',
      targetKind: 'github_workflow_runs',
      setupTool: 'watch_github_items',
      requiredFields: ['items', 'notifyOn'],
      optionalFields: [
        'repository',
        'label',
        'followUpInstruction',
        'allowDuplicate',
      ],
      usageGuidance:
        'Use WatchGitHubItems with 1–20 concrete GitHub Actions workflow runs. For each completed job use {"notifyOn":{"jobs":{"conclusions":"any"}}}; for whole-run lifecycle changes use notifyOn.run.statuses and/or notifyOn.run.conclusions. It accepts bare ids with repository context, owner/repository#run_id references, and GitHub run, attempt, job, or step URLs. A job/step URL only identifies its parent run; job notifications still require notifyOn.jobs. The watcher notifies this chat only for future observed changes. Do not poll with gh run watch, gh run view, or a shell loop, and do not keep the agent turn open while waiting.',
      keywords: [
        'github',
        'actions',
        'workflow',
        'run',
        'ci',
        'status',
        'conclusion',
        'watch',
      ],
    },
    {
      trigger: 'github_pull_requests_changed',
      title:
        'GitHub pull request merged, closed, or removed from the merge queue',
      targetKind: 'github_pull_requests',
      setupTool: 'watch_github_items',
      requiredFields: ['items'],
      optionalFields: [
        'repository',
        'notifyOn',
        'label',
        'followUpInstruction',
        'allowDuplicate',
      ],
      usageGuidance: `Use WatchGitHubItems with 1–20 GitHub.com pull requests to wake this chat when each one merges, closes without merging, or is removed from the merge queue without merging. Removal is reported by default and the watcher keeps watching. Example: {"items":[{"kind":"pull_request","target":"https://github.com/owner/repository/pull/123"}]}. Items may be {kind:"pull_request", target} with a pull request URL or owner/repository#number, or {kind:"pull_request", number} with repository context. Omit notifyOn for the default. To also wake when a pull request enters the merge queue or its queue entry reaches a phase, add {"notifyOn":{"queue":{"entered":true,"phases":["unmergeable"]}}}; phases are ${options.pullRequestQueuePhases.join(', ')}, or "any". Queue position changes never wake the chat. If merge queue history cannot be recovered, the chat is told once instead of guessing. Pull requests already merged or closed are reported per item in the result and are not watched. Do not mix pull requests and workflow runs in one watcher. Do not poll with gh pr view or a shell loop, and do not keep the agent turn open while waiting.`,
      keywords: [
        'github',
        'pull',
        'request',
        'pr',
        'merge',
        'merged',
        'closed',
        'queue',
        'removed',
        'ejected',
        'watch',
      ],
    },
  ];
}

/**
 * Catalog search for the `search_watchers` provider tool. Tokens are matched
 * case-insensitively against each entry's title, usageGuidance, trigger key,
 * and keywords.
 *
 *  - Hidden compatibility rows are never advertised, even by exact trigger.
 *  - `trigger` filters the visible catalog to that trigger only.
 *  - `limit` clamps the catalog row count; defaults to `DEFAULT_CATALOG_LIMIT`.
 *  - `detailLevel: "standard"` adds usage guidance and ranked hook triggers.
 */
export function searchAgentWatcherCatalog<
  THook extends AgentWatcherHookTrigger,
>(
  catalog: readonly AgentWatcherCatalogEntry<THook>[],
  input: AgentWatcherCatalogSearchInput = {},
): AgentWatcherCatalogSearchRow<THook>[] {
  const rawQuery = typeof input.query === 'string' ? input.query.trim() : '';
  const triggerFilter = input.trigger;
  const limit = clampLimit(input.limit);
  const detailLevel = input.detailLevel ?? 'minimal';
  const tokens = tokenize(rawQuery);

  // Hidden compatibility rows are never advertised, even by exact trigger.
  const filtered = catalog.filter(
    (entry) =>
      !entry.hidden && (!triggerFilter || entry.trigger === triggerFilter),
  );

  const scored = filtered
    .map((entry, index) => ({
      entry,
      index,
      score: scoreCatalogEntry(entry, tokens),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit);

  return scored.map(({ entry, score }) => ({
    trigger: entry.trigger,
    title: entry.title,
    targetKind: entry.targetKind,
    setupTool: entry.setupTool,
    requiredFields: [...entry.requiredFields],
    optionalFields: [...entry.optionalFields],
    optionalEntryFields: [...(entry.optionalEntryFields ?? [])],
    ...(detailLevel === 'standard'
      ? { usageGuidance: entry.usageGuidance }
      : {}),
    ...(detailLevel === 'standard' && entry.hookTriggers
      ? {
          hookTriggers: rankHookTriggersForTokens(entry.hookTriggers, tokens),
        }
      : {}),
    score,
  }));
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_CATALOG_LIMIT;
  }
  const floored = Math.floor(limit);
  if (floored <= 0) return DEFAULT_CATALOG_LIMIT;
  return Math.min(MAX_CATALOG_LIMIT, floored);
}

function scoreCatalogEntry(
  entry: AgentWatcherCatalogEntry<AgentWatcherHookTrigger>,
  tokens: string[],
): number {
  // Catalog is short, so when there is no query we surface every entry with
  // a baseline score so the caller can render the full set.
  if (tokens.length === 0) {
    return 1;
  }

  const normalizedTrigger = normalize(entry.trigger);
  const normalizedTitle = normalize(entry.title);
  const haystack = normalize(
    [
      entry.title,
      entry.usageGuidance,
      entry.trigger,
      ...entry.keywords,
      ...(entry.hookTriggers ?? []).flatMap((hookTrigger) => [
        hookTrigger.triggerName,
        hookTrigger.title,
        ...hookTrigger.keywords,
      ]),
    ].join(' '),
  );

  let score = 0;
  for (const token of tokens) {
    if (normalizedTrigger === token) {
      score += 120;
    } else if (normalizedTrigger.includes(token)) {
      score += 60;
    }

    if (normalizedTitle.includes(token)) {
      score += 40;
    }

    if (haystack.includes(token)) {
      score += 10;
    } else {
      score -= 1;
    }
  }

  return score > 0 ? score : 0;
}

export function rankAgentWatcherHookTriggers<
  THook extends AgentWatcherHookTrigger,
>(hookTriggers: readonly THook[], query: string): THook[] {
  return rankHookTriggersForTokens(hookTriggers, tokenize(query));
}

function rankHookTriggersForTokens<THook extends AgentWatcherHookTrigger>(
  hookTriggers: readonly THook[],
  tokens: string[],
): THook[] {
  if (tokens.length === 0) {
    return hookTriggers.map((entry) => ({ ...entry }));
  }

  const scored = hookTriggers
    .map((entry, index) => ({
      entry,
      index,
      score: scoreHookTrigger(entry, tokens),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  return scored.map(({ entry }) => ({ ...entry }));
}

function scoreHookTrigger(
  entry: AgentWatcherHookTrigger,
  tokens: string[],
): number {
  const normalizedTrigger = normalize(entry.triggerName);
  const normalizedTitle = normalize(entry.title);
  const haystack = normalize(
    [entry.triggerName, entry.title, ...entry.keywords].join(' '),
  );

  let score = 0;
  for (const token of tokens) {
    if (normalizedTrigger === token) {
      score += 120;
    } else if (normalizedTrigger.includes(token)) {
      score += 60;
    }

    if (normalizedTitle.includes(token)) {
      score += 40;
    }

    if (haystack.includes(token)) {
      score += 10;
    } else {
      score -= 1;
    }
  }

  return score > 0 ? score : 0;
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[_./-]+/g, ' ');
}
