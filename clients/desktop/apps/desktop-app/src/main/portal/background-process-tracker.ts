import type {
  BackgroundProcessKind,
  BackgroundProcessStatus,
} from '@canopy/desktop-shared/types';
import {
  backgroundProcessKindForTaskType,
  backgroundProcessKindForTool,
  isAsyncAgentLaunchText,
} from '@canopy/desktop-shared/lib/background-work';
import type { ActivityLiveBgTask } from '@canopy/desktop-shared/types/activity-panel';
import { claudeLaunchedAgentId } from '@canopy/agent-transcript';

export interface TrackedBackgroundProcess {
  id: string;
  chatId: string;
  toolUseId: string;
  taskId?: string;
  kind: BackgroundProcessKind;
  description: string;
  status: BackgroundProcessStatus;
  startedAt: number;
  updatedAt: number;
  summary?: string;
  lastDescription?: string;
  canStop: boolean;
}

export interface BackgroundProcessTrackerTarget {
  workspaceLocalId: string;
  worktreeLocalId: string;
}

type TrackerListener = (target: BackgroundProcessTrackerTarget) => void;

interface ToolUse {
  chatId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  timestamp: number;
  /**
   * Task id the SDK event stream correlated with this tool use. Recorded even
   * for foreground tasks, because that is the only way a later
   * `task_updated { patch: { is_backgrounded: true } }` — which carries no
   * `tool_use_id` — can find the Bash call that timed out and was moved to
   * the background. Mirrors `ToolUseMeta` in the renderer's activityStore.
   */
  taskId?: string;
}

interface WorktreeState {
  processes: TrackedBackgroundProcess[];
  toolUses: Map<string, ToolUse>;
  liveTasksByChat: Map<string, Map<string, string | undefined>>;
}

const states = new Map<string, WorktreeState>();

function createWorktreeState(): WorktreeState {
  return {
    processes: [],
    toolUses: new Map(),
    liveTasksByChat: new Map(),
  };
}

// Memory bound per worktree: terminal rows beyond this cap are evicted
// oldest-first (active rows are never evicted). Tool-use records are retained
// while a tracked process references them, plus a small recent window of
// unreferenced ones so a foreground call that is later moved to the
// background can still be correlated with its tool use.
const MAX_TRACKED_PROCESSES = 50;
const MAX_UNREFERENCED_TOOL_USES = 20;

function pruneToolUses(state: WorktreeState): void {
  const referenced = new Set(
    state.processes.map((process) => process.toolUseId),
  );
  const unreferenced = Array.from(state.toolUses.values())
    .filter((toolUse) => !referenced.has(toolUse.toolUseId))
    .sort((left, right) => right.timestamp - left.timestamp);
  for (const toolUse of unreferenced.slice(MAX_UNREFERENCED_TOOL_USES)) {
    state.toolUses.delete(toolUse.toolUseId);
  }
}

function pruneState(state: WorktreeState): void {
  if (state.processes.length > MAX_TRACKED_PROCESSES) {
    const overflow = state.processes.length - MAX_TRACKED_PROCESSES;
    let removed = 0;
    state.processes = state.processes.filter((process) => {
      if (removed >= overflow || !terminalStatus(process.status)) {
        return true;
      }
      removed += 1;
      return false;
    });
  }
  pruneToolUses(state);
}
const listeners = new Set<TrackerListener>();

function worktreeKey(target: BackgroundProcessTrackerTarget): string {
  return `${target.workspaceLocalId}\u0000${target.worktreeLocalId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function extractToolResultText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const textBlocks = value
    .filter(
      (block): block is Record<string, unknown> =>
        isRecord(block) &&
        block.type === 'text' &&
        typeof block.text === 'string',
    )
    .map((block) => block.text);
  return textBlocks.length > 0 ? textBlocks.join('\n') : undefined;
}

function isBackgroundTool(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (toolName === 'Workflow') {
    return true;
  }
  return (
    input.run_in_background === true &&
    (toolName === 'Agent' ||
      toolName === 'Task' ||
      toolName === 'Bash' ||
      // Windows Claude sessions expose `PowerShell` in place of `Bash`.
      toolName === 'PowerShell')
  );
}

/** Foreground Bash can later background; unflagged Agents/Tasks use async acks. */
function isBackgroundableTool(toolName: string): boolean {
  return (
    toolName === 'Bash' ||
    toolName === 'PowerShell' ||
    toolName === 'Agent' ||
    toolName === 'Task'
  );
}

/** The tool use a previous task event correlated with `taskId`, if any. */
function findToolUseIdForTaskId(
  toolUses: ReadonlyMap<string, ToolUse>,
  taskId: string,
  chatId?: string,
): string | undefined {
  for (const toolUse of Array.from(toolUses.values())) {
    if (
      toolUse.taskId === taskId &&
      (chatId === undefined || toolUse.chatId === chatId)
    ) {
      return toolUse.toolUseId;
    }
  }
  return undefined;
}

function findProcessIndex(
  processes: readonly TrackedBackgroundProcess[],
  identifiers: { toolUseId?: string; taskId?: string },
  chatId?: string,
): number {
  return processes.findIndex(
    (process) =>
      (chatId === undefined || process.chatId === chatId) &&
      ((identifiers.taskId !== undefined &&
        process.taskId === identifiers.taskId) ||
        (identifiers.toolUseId !== undefined &&
          process.toolUseId === identifiers.toolUseId)),
  );
}

/**
 * A row first seen from an ID-only live task holds its task id as a
 * placeholder tool-use id; adopt the real one (and the recorded tool use's
 * kind, description and start time) once the provider names it. The row `id`
 * (the Portal entity's local id) stays stable.
 */
function adoptToolUseIdentity(
  state: WorktreeState,
  chatId: string,
  processIndex: number,
  toolUseId: string,
): boolean {
  const process = state.processes[processIndex];
  if (!process || process.toolUseId !== process.taskId) {
    return false;
  }
  const toolUse = state.toolUses.get(toolUseId);
  const fromToolUse =
    toolUse?.chatId === chatId ? createProcess(toolUse) : undefined;
  state.processes[processIndex] = {
    ...process,
    toolUseId,
    ...(fromToolUse === undefined
      ? {}
      : {
          kind: fromToolUse.kind,
          description: fromToolUse.description,
          startedAt: Math.min(process.startedAt, fromToolUse.startedAt),
        }),
  };
  return true;
}

function mergeDuplicateProcesses(
  state: WorktreeState,
  chatId: string,
  identifiers: { toolUseId?: string; taskId?: string },
): boolean {
  if (identifiers.taskId === undefined || identifiers.toolUseId === undefined) {
    return false;
  }
  const taskIndex = findProcessIndex(
    state.processes,
    { taskId: identifiers.taskId },
    chatId,
  );
  const toolUseIndex = findProcessIndex(
    state.processes,
    { toolUseId: identifiers.toolUseId },
    chatId,
  );
  if (taskIndex >= 0 && toolUseIndex < 0) {
    return adoptToolUseIdentity(
      state,
      chatId,
      taskIndex,
      identifiers.toolUseId,
    );
  }
  if (taskIndex < 0 || toolUseIndex < 0 || taskIndex === toolUseIndex) {
    return false;
  }

  const taskProcess = state.processes[taskIndex];
  const toolUseProcess = state.processes[toolUseIndex];
  if (!taskProcess || !toolUseProcess) {
    return false;
  }
  const terminalProcess = terminalStatus(toolUseProcess.status)
    ? toolUseProcess
    : terminalStatus(taskProcess.status)
      ? taskProcess
      : undefined;
  const adoptedTaskId =
    toolUseProcess.taskId ?? taskProcess.taskId ?? identifiers.taskId;
  const merged: TrackedBackgroundProcess = {
    ...toolUseProcess,
    ...(adoptedTaskId === undefined ? {} : { taskId: adoptedTaskId }),
    ...(terminalProcess === undefined
      ? {
          status:
            toolUseProcess.status === 'running' ||
            taskProcess.status === 'running'
              ? 'running'
              : toolUseProcess.status,
          canStop: adoptedTaskId !== undefined,
        }
      : {
          status: terminalProcess.status,
          summary: terminalProcess.summary,
          updatedAt: Math.max(toolUseProcess.updatedAt, taskProcess.updatedAt),
          canStop: false,
        }),
  };
  state.processes = state.processes.filter((_, index) => index !== taskIndex);
  const mergedIndex = findProcessIndex(
    state.processes,
    { toolUseId: identifiers.toolUseId },
    chatId,
  );
  if (mergedIndex >= 0) {
    state.processes[mergedIndex] = merged;
  }
  return true;
}

function createProcess(toolUse: ToolUse): TrackedBackgroundProcess {
  return {
    id: toolUse.toolUseId,
    chatId: toolUse.chatId,
    toolUseId: toolUse.toolUseId,
    kind: backgroundProcessKindForTool(toolUse.toolName),
    // Never fall back to the raw command: shell commands carry paths,
    // arguments, and sometimes secrets, all of which must stay local.
    description: readString(toolUse.input, 'description') ?? toolUse.toolName,
    status: 'queued',
    startedAt: toolUse.timestamp,
    updatedAt: toolUse.timestamp,
    // Mirrors the renderer normalization (activityStore: canStop is
    // Boolean(taskId)); a queued row has no taskId yet and cannot be stopped.
    canStop: false,
  };
}

function terminalStatus(status: BackgroundProcessStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped';
}

// Mirrors the renderer's terminal normalization (activityStore
// normalizeTerminalStatus): unknown/missing statuses read as 'completed'.
// Keep the two in lockstep if either changes.
function normalizedTerminalStatus(
  value: string | undefined,
): BackgroundProcessStatus {
  switch (value) {
    case 'failed':
      return 'failed';
    case 'stopped':
    case 'killed':
    case 'cancelled':
    case 'canceled':
      return 'stopped';
    default:
      return 'completed';
  }
}

function notify(target: BackgroundProcessTrackerTarget): void {
  for (const listener of Array.from(listeners)) {
    listener(target);
  }
}

function applyToolUse(
  state: WorktreeState,
  chatId: string,
  toolUseId: string,
  toolName: string,
  input: unknown,
  timestamp: number,
): boolean {
  const toolUse: ToolUse = {
    chatId,
    toolUseId,
    toolName,
    input: parseRecord(input),
    timestamp,
  };
  const background = isBackgroundTool(toolName, toolUse.input);
  if (!background && !isBackgroundableTool(toolName)) {
    return false;
  }
  state.toolUses.set(toolUseId, toolUse);
  if (!background) {
    // Recorded so a later backgrounding patch can find this call. A
    // foreground tool is not background activity until the CLI says so, so
    // nothing changed for listeners — bound the records here instead of
    // waiting for the next tracked-process change to prune them.
    pruneToolUses(state);
    return false;
  }
  const index = findProcessIndex(state.processes, { toolUseId }, chatId);
  if (index >= 0) {
    const existing = state.processes[index];
    if (existing) {
      state.processes[index] = { ...existing, updatedAt: timestamp };
    }
  } else {
    state.processes.push(createProcess(toolUse));
  }
  return true;
}

function applyToolResult(
  state: WorktreeState,
  chatId: string,
  toolUseId: string,
  content: unknown,
  isError: boolean,
  timestamp: number,
): boolean {
  const toolUse = state.toolUses.get(toolUseId);
  if (!toolUse || toolUse.chatId !== chatId) {
    return false;
  }
  const payload = parseRecord(content);
  const resultText = extractToolResultText(content) ?? '';
  const asyncAgentLaunch =
    (toolUse.toolName === 'Agent' || toolUse.toolName === 'Task') &&
    isAsyncAgentLaunchText(resultText);
  // The text acknowledgement names the task only as `agentId`; without it the
  // launch row never joins the live-set row for the same task.
  const taskId =
    readString(payload, 'task_id', 'taskId') ??
    (asyncAgentLaunch ? claudeLaunchedAgentId(resultText) : undefined);
  if (taskId !== undefined && toolUse.taskId !== taskId) {
    state.toolUses.set(toolUseId, {
      ...toolUse,
      taskId: toolUse.taskId ?? taskId,
    });
  }
  const changed = mergeDuplicateProcesses(state, chatId, { toolUseId, taskId });
  let index = findProcessIndex(state.processes, { toolUseId }, chatId);
  if (index < 0 && taskId !== undefined) {
    index = findProcessIndex(state.processes, { taskId }, chatId);
  }
  const existingForToolUse = findProcessIndex(
    state.processes,
    { toolUseId },
    chatId,
  );
  const isBackground = isBackgroundTool(toolUse.toolName, toolUse.input);
  if (!isBackground && existingForToolUse < 0 && !asyncAgentLaunch) {
    return changed;
  }
  const existing = index >= 0 ? state.processes[index] : createProcess(toolUse);
  if (!existing) {
    return changed;
  }
  const rawStatus = readString(payload, 'status');
  // Same non-regression rule as applySystemEvent: once terminal, only a
  // terminal status may replace it — a late tool_result cannot resurrect.
  const status: BackgroundProcessStatus =
    isError || rawStatus === 'failed'
      ? 'failed'
      : terminalStatus(existing.status)
        ? existing.status
        : taskId !== undefined ||
            rawStatus === 'async_launched' ||
            asyncAgentLaunch
          ? 'running'
          : existing.status;
  const nextTaskId = existing.taskId ?? taskId;
  const next: TrackedBackgroundProcess = {
    ...existing,
    ...(nextTaskId === undefined ? {} : { taskId: nextTaskId }),
    status,
    updatedAt: timestamp,
    ...(readString(payload, 'description') === undefined
      ? {}
      : {
          description:
            readString(payload, 'description') ?? existing.description,
        }),
    ...(readString(payload, 'summary') === undefined
      ? {}
      : { summary: readString(payload, 'summary') }),
    canStop: !terminalStatus(status) && nextTaskId !== undefined,
  };
  if (index >= 0) {
    state.processes[index] = next;
  } else {
    state.processes.push(next);
  }
  return true;
}

/**
 * A terminal `task_updated` patch is the same edge as a `task_notification`;
 * reduce it as one so a finished task cannot be left running.
 */
function normalizeTerminalTaskUpdatedEvent(
  event: Record<string, unknown>,
): Record<string, unknown> | null {
  const patch = event.patch;
  if (!isRecord(patch)) {
    return null;
  }
  const status = readString(patch, 'status');
  if (
    status !== 'completed' &&
    status !== 'failed' &&
    status !== 'stopped' &&
    status !== 'killed' &&
    status !== 'cancelled' &&
    status !== 'canceled'
  ) {
    return null;
  }
  const taskId = readString(event, 'task_id', 'taskId');
  if (taskId === undefined) {
    return null;
  }
  return { ...event, subtype: 'task_notification', task_id: taskId, status };
}

/**
 * A foreground Bash that outlives its timeout is moved to the background, and
 * the SDK reports that move as `task_updated { patch: { is_backgrounded: true
 * } }` rather than a second `task_started`. Normalize it into the backgrounded
 * `task_started` shape so it becomes (or revives) a tracked process.
 */
function normalizeBackgroundedTaskUpdatedEvent(
  event: Record<string, unknown>,
): Record<string, unknown> | null {
  const patch = event.patch;
  if (!isRecord(patch) || patch.is_backgrounded !== true) {
    return null;
  }
  const taskId = readString(event, 'task_id', 'taskId');
  if (taskId === undefined) {
    return null;
  }
  const description = readString(patch, 'description');
  return {
    ...event,
    subtype: 'task_started',
    task_id: taskId,
    is_backgrounded: true,
    ...(description === undefined ? {} : { description }),
  };
}

/** Terminal patches win; a backgrounding patch is the remaining case. */
function normalizeTaskUpdatedEvent(
  event: Record<string, unknown>,
): Record<string, unknown> | null {
  return (
    normalizeTerminalTaskUpdatedEvent(event) ??
    normalizeBackgroundedTaskUpdatedEvent(event)
  );
}

/**
 * Apply one SDK task event to the tracked process list.
 *
 * Background-only by construction. The SDK emits `task_started` /
 * `task_progress` for FOREGROUND tasks too (`is_backgrounded: false`), and
 * those tasks are deliberately absent from the `background_tasks_changed`
 * level set, so tracking them produced Portal rows for work that is not
 * background activity at all. A process is therefore created here only when
 * the event says the task is backgrounded; otherwise the event may only
 * update a process that a `run_in_background` (or `Workflow`) tool use
 * already created. `ambient` tasks are not activity and are dropped outright.
 *
 * A chat's CLI process going away is NOT read from `system/init`: the CLI
 * emits a top-level init at the start of every turn within the same process,
 * so resetting live rows there would stop real background work on the next
 * user message. Teardown arrives as the synthetic
 * `task_notification { status: 'stopped', reason: 'session_ended' }` the main
 * session manager emits, which this reducer settles like any other terminal
 * notification.
 */
function applySystemEvent(
  state: WorktreeState,
  chatId: string,
  event: Record<string, unknown>,
  timestamp: number,
): boolean {
  const subtype = readString(event, 'subtype');
  if (
    subtype !== 'task_started' &&
    subtype !== 'task_progress' &&
    subtype !== 'task_notification' &&
    subtype !== 'task_updated'
  ) {
    return false;
  }
  // "True for tasks that are not activity (every skip_transcript task, plus
  // every live-update watcher): hosts should exclude them from activity
  // indicators."
  if (event.ambient === true) {
    return false;
  }

  const effectiveEvent =
    subtype === 'task_updated' ? normalizeTaskUpdatedEvent(event) : event;
  if (!effectiveEvent) {
    return false;
  }
  const effectiveSubtype = readString(effectiveEvent, 'subtype');
  const taskId = readString(effectiveEvent, 'task_id', 'taskId');
  // Deliberately NOT `parent_tool_use_id`: a nested subagent's events carry
  // the OUTER agent's tool-use id there, so matching on it let an inner
  // task's id and terminal status overwrite the outer tracked process.
  const toolUseId =
    readString(effectiveEvent, 'tool_use_id') ??
    (taskId === undefined
      ? undefined
      : findToolUseIdForTaskId(state.toolUses, taskId, chatId));

  if (taskId !== undefined && toolUseId !== undefined) {
    const correlated = state.toolUses.get(toolUseId);
    if (correlated && correlated.taskId !== taskId) {
      state.toolUses.set(toolUseId, { ...correlated, taskId });
    }
  }

  const merged = mergeDuplicateProcesses(state, chatId, { taskId, toolUseId });
  const index = findProcessIndex(
    state.processes,
    { taskId, toolUseId },
    chatId,
  );
  const backgrounded = effectiveEvent.is_backgrounded === true;
  if (index < 0 && (effectiveSubtype !== 'task_started' || !backgrounded)) {
    return merged;
  }

  const correlatedToolUse =
    toolUseId === undefined ? undefined : state.toolUses.get(toolUseId);
  const toolUse = (correlatedToolUse?.chatId === chatId
    ? correlatedToolUse
    : undefined) ?? {
    chatId,
    toolUseId: toolUseId ?? taskId ?? `${chatId}-${timestamp}`,
    toolName: 'Task',
    input: {},
    timestamp,
  };
  const existing = index >= 0 ? state.processes[index] : createProcess(toolUse);
  if (!existing) {
    return false;
  }

  let status = existing.status;
  if (
    effectiveSubtype === 'task_started' ||
    effectiveSubtype === 'task_progress'
  ) {
    // Only an explicit background (re-)registration revives a finished row:
    // a resumed subagent is always re-registered in the background, so a task
    // that a session-ended notification stopped can legitimately come back. A
    // late or replayed non-terminal edge must not unwedge a terminal row.
    if (!terminalStatus(existing.status) || backgrounded) {
      status = 'running';
    }
  }
  if (effectiveSubtype === 'task_notification') {
    status = normalizedTerminalStatus(readString(effectiveEvent, 'status'));
  }

  // Keep the first task id learned for a process: the tool result and the
  // event stream can name the same work differently, and re-pointing it
  // orphans the output poller that is already keyed to the old id.
  const nextTaskId =
    taskId !== undefined &&
    (existing.taskId === undefined || existing.taskId === taskId)
      ? taskId
      : existing.taskId;

  const next: TrackedBackgroundProcess = {
    ...existing,
    chatId,
    // `toolUseId` is the row's identity (`id` is minted from it), so an event
    // matched by task id never re-points it.
    ...(nextTaskId === undefined ? {} : { taskId: nextTaskId }),
    status,
    updatedAt: timestamp,
    ...(readString(effectiveEvent, 'description') === undefined
      ? {}
      : { lastDescription: readString(effectiveEvent, 'description') }),
    ...(readString(effectiveEvent, 'summary') === undefined
      ? {}
      : { summary: readString(effectiveEvent, 'summary') }),
    canStop: !terminalStatus(status) && nextTaskId !== undefined,
  };
  if (index >= 0) {
    state.processes[index] = next;
  } else {
    state.processes.push(next);
  }
  return true;
}

function applyBackgroundTasksChanged(
  state: WorktreeState,
  chatId: string,
  event: Record<string, unknown>,
  timestamp: number,
): boolean {
  if (!Array.isArray(event.tasks)) {
    return false;
  }

  const activeTaskIds = new Set<string>();
  for (const task of event.tasks) {
    if (!isRecord(task)) {
      return false;
    }
    const taskId = readString(task, 'task_id', 'taskId');
    if (!taskId) {
      return false;
    }
    if (task.ambient !== true) {
      activeTaskIds.add(taskId);
    }
  }

  let changed = false;
  state.processes = state.processes.map((process) => {
    if (
      process.chatId !== chatId ||
      process.taskId === undefined ||
      terminalStatus(process.status) ||
      activeTaskIds.has(process.taskId)
    ) {
      return process;
    }
    changed = true;
    return {
      ...process,
      status: 'completed',
      updatedAt: timestamp,
      summary: 'Background process completed',
      canStop: false,
    };
  });
  return changed;
}

export function reconcileBackgroundProcessLiveSet(
  target: BackgroundProcessTrackerTarget & { chatId: string },
  liveTasks: readonly ActivityLiveBgTask[] | undefined,
  timestamp = Date.now(),
): void {
  const tasks = (liveTasks ?? []).filter(
    (task) =>
      typeof task === 'object' &&
      task !== null &&
      typeof task.taskId === 'string' &&
      task.taskId.length > 0,
  );
  const key = worktreeKey(target);
  const existingState = states.get(key);
  if (!existingState && tasks.length === 0) {
    return;
  }
  const state = existingState ?? createWorktreeState();
  if (!existingState) {
    states.set(key, state);
  }
  const previous =
    state.liveTasksByChat.get(target.chatId) ??
    new Map<string, string | undefined>();
  const current = new Map<string, string | undefined>();
  const currentToolUseIds = new Set<string>();
  let changed = false;

  for (const task of tasks) {
    current.set(task.taskId, task.toolUseId);
    if (task.toolUseId !== undefined) {
      currentToolUseIds.add(task.toolUseId);
    }
    if (task.toolUseId !== undefined) {
      const recordedToolUse = state.toolUses.get(task.toolUseId);
      if (
        recordedToolUse?.chatId === target.chatId &&
        recordedToolUse.taskId === undefined
      ) {
        state.toolUses.set(task.toolUseId, {
          ...recordedToolUse,
          taskId: task.taskId,
        });
      }
    }

    changed =
      mergeDuplicateProcesses(state, target.chatId, {
        taskId: task.taskId,
        toolUseId: task.toolUseId,
      }) || changed;
    let processIndex =
      task.toolUseId === undefined
        ? -1
        : findProcessIndex(
            state.processes,
            { toolUseId: task.toolUseId },
            target.chatId,
          );
    if (processIndex < 0) {
      processIndex = findProcessIndex(
        state.processes,
        { taskId: task.taskId },
        target.chatId,
      );
    }

    if (processIndex < 0) {
      const recordedToolUse =
        task.toolUseId === undefined
          ? undefined
          : state.toolUses.get(task.toolUseId);
      const matchingToolUse =
        recordedToolUse?.chatId === target.chatId ? recordedToolUse : undefined;
      const baseProcess: TrackedBackgroundProcess = matchingToolUse
        ? createProcess(matchingToolUse)
        : {
            id: task.toolUseId ?? task.taskId,
            chatId: target.chatId,
            toolUseId: task.toolUseId ?? task.taskId,
            kind: backgroundProcessKindForTaskType(task.taskType) ?? 'task',
            description:
              task.description ?? task.workflowName ?? 'Background task',
            status: 'queued',
            startedAt: timestamp,
            updatedAt: timestamp,
            canStop: false,
          };
      state.processes.push({
        ...baseProcess,
        taskId: task.taskId,
        status: 'running',
        updatedAt: timestamp,
        ...(task.description === undefined
          ? {}
          : { lastDescription: task.description }),
        canStop: true,
      });
      changed = true;
      continue;
    }

    const existing = state.processes[processIndex];
    // A task back in the live set after leaving it runs again, as a resumed
    // Codex child does under its thread's task id. A task still listed keeps
    // the ending a notification gave it.
    if (
      !existing ||
      (terminalStatus(existing.status) && previous.has(task.taskId))
    ) {
      continue;
    }
    const taskId = existing.taskId ?? task.taskId;
    const lastDescription = task.description ?? existing.lastDescription;
    // Progress-only notifications repeat the same membership; leaving the row
    // untouched keeps them from emitting a Portal delta each time.
    if (
      existing.taskId === taskId &&
      existing.status === 'running' &&
      existing.lastDescription === lastDescription &&
      existing.canStop
    ) {
      continue;
    }
    state.processes[processIndex] = {
      ...existing,
      taskId,
      status: 'running',
      updatedAt: timestamp,
      ...(lastDescription === undefined ? {} : { lastDescription }),
      canStop: true,
    };
    changed = true;
  }

  for (const [taskId, toolUseId] of Array.from(previous.entries())) {
    if (
      current.has(taskId) ||
      (toolUseId !== undefined && currentToolUseIds.has(toolUseId))
    ) {
      continue;
    }
    state.processes = state.processes.map((process) => {
      if (
        process.chatId !== target.chatId ||
        process.taskId === undefined ||
        terminalStatus(process.status) ||
        (process.taskId !== taskId &&
          (toolUseId === undefined || process.toolUseId !== toolUseId))
      ) {
        return process;
      }
      changed = true;
      return {
        ...process,
        status: 'completed',
        updatedAt: timestamp,
        summary: 'Background process completed',
        canStop: false,
      };
    });
  }

  if (current.size === 0) {
    state.liveTasksByChat.delete(target.chatId);
  } else {
    state.liveTasksByChat.set(target.chatId, current);
  }
  if (changed) {
    pruneState(state);
    notify(target);
  }
}

export function recordBackgroundProcessChatEvent(
  target: BackgroundProcessTrackerTarget & { chatId: string },
  data: unknown,
  timestamp = Date.now(),
): void {
  if (!isRecord(data)) {
    return;
  }
  const key = worktreeKey(target);
  const state = states.get(key) ?? createWorktreeState();
  states.set(key, state);
  let changed = false;
  if (data.type === 'assistant' && isRecord(data.message)) {
    const content = Array.isArray(data.message.content)
      ? data.message.content
      : [];
    for (const block of content) {
      if (
        isRecord(block) &&
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string'
      ) {
        changed =
          applyToolUse(
            state,
            target.chatId,
            block.id,
            block.name,
            block.input,
            timestamp,
          ) || changed;
      }
    }
  } else if (data.type === 'user' && isRecord(data.message)) {
    const content = Array.isArray(data.message.content)
      ? data.message.content
      : [];
    for (const block of content) {
      if (
        isRecord(block) &&
        block.type === 'tool_result' &&
        typeof block.tool_use_id === 'string'
      ) {
        changed =
          applyToolResult(
            state,
            target.chatId,
            block.tool_use_id,
            block.content,
            block.is_error === true,
            timestamp,
          ) || changed;
      }
    }
  } else if (data.type === 'system') {
    changed =
      readString(data, 'subtype') === 'background_tasks_changed'
        ? applyBackgroundTasksChanged(state, target.chatId, data, timestamp)
        : applySystemEvent(state, target.chatId, data, timestamp);
  }
  if (changed) {
    pruneState(state);
    notify(target);
  }
}

export function listTrackedBackgroundProcesses(
  target: BackgroundProcessTrackerTarget,
): TrackedBackgroundProcess[] {
  return [...(states.get(worktreeKey(target))?.processes ?? [])];
}

export function subscribeBackgroundProcessTracker(
  listener: TrackerListener,
): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

export function clearBackgroundProcessTracker(): void {
  states.clear();
}
