import type {
  BackgroundProcessKind,
  BackgroundProcessStatus,
} from '@canopy/desktop-shared/types';

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
}

const states = new Map<string, WorktreeState>();

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

/**
 * Tools the CLI can move to the background after their foreground timeout
 * (reported as `task_updated { patch: { is_backgrounded: true } }`). Their
 * tool uses are recorded for correlation only; they are not activity until
 * that patch arrives.
 */
function isBackgroundableTool(toolName: string): boolean {
  return toolName === 'Bash' || toolName === 'PowerShell';
}

/** The tool use a previous task event correlated with `taskId`, if any. */
function findToolUseIdForTaskId(
  toolUses: ReadonlyMap<string, ToolUse>,
  taskId: string,
): string | undefined {
  for (const toolUse of Array.from(toolUses.values())) {
    if (toolUse.taskId === taskId) {
      return toolUse.toolUseId;
    }
  }
  return undefined;
}

function kindForTool(toolName: string): BackgroundProcessKind {
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
      return 'bash';
    case 'Task':
      return 'task';
    case 'Workflow':
      return 'workflow';
    default:
      return 'agent';
  }
}

function findProcessIndex(
  processes: readonly TrackedBackgroundProcess[],
  identifiers: { toolUseId?: string; taskId?: string },
): number {
  return processes.findIndex(
    (process) =>
      (identifiers.taskId !== undefined &&
        process.taskId === identifiers.taskId) ||
      (identifiers.toolUseId !== undefined &&
        process.toolUseId === identifiers.toolUseId),
  );
}

function createProcess(toolUse: ToolUse): TrackedBackgroundProcess {
  return {
    id: toolUse.toolUseId,
    chatId: toolUse.chatId,
    toolUseId: toolUse.toolUseId,
    kind: kindForTool(toolUse.toolName),
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
  const index = findProcessIndex(state.processes, { toolUseId });
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
  toolUseId: string,
  content: unknown,
  isError: boolean,
  timestamp: number,
): boolean {
  const toolUse = state.toolUses.get(toolUseId);
  if (!toolUse || !isBackgroundTool(toolUse.toolName, toolUse.input)) {
    return false;
  }
  const payload = parseRecord(content);
  const taskId = readString(payload, 'task_id', 'taskId');
  if (taskId !== undefined && toolUse.taskId !== taskId) {
    state.toolUses.set(toolUseId, { ...toolUse, taskId });
  }
  const index = findProcessIndex(state.processes, { toolUseId, taskId });
  const existing = index >= 0 ? state.processes[index] : createProcess(toolUse);
  if (!existing) {
    return false;
  }
  const rawStatus = readString(payload, 'status');
  // Same non-regression rule as applySystemEvent: once terminal, only a
  // terminal status may replace it — a late tool_result cannot resurrect.
  const status: BackgroundProcessStatus =
    isError || rawStatus === 'failed'
      ? 'failed'
      : terminalStatus(existing.status)
        ? existing.status
        : taskId !== undefined || rawStatus === 'async_launched'
          ? 'running'
          : existing.status;
  const next: TrackedBackgroundProcess = {
    ...existing,
    ...(taskId === undefined ? {} : { taskId }),
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
    canStop:
      !terminalStatus(status) && (taskId ?? existing.taskId) !== undefined,
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
      : findToolUseIdForTaskId(state.toolUses, taskId));

  if (taskId !== undefined && toolUseId !== undefined) {
    const correlated = state.toolUses.get(toolUseId);
    if (correlated && correlated.taskId !== taskId) {
      state.toolUses.set(toolUseId, { ...correlated, taskId });
    }
  }

  const index = findProcessIndex(state.processes, { taskId, toolUseId });
  const backgrounded = effectiveEvent.is_backgrounded === true;
  if (index < 0 && (effectiveSubtype !== 'task_started' || !backgrounded)) {
    return false;
  }

  const toolUse = (toolUseId === undefined
    ? undefined
    : state.toolUses.get(toolUseId)) ?? {
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

export function recordBackgroundProcessChatEvent(
  target: BackgroundProcessTrackerTarget & { chatId: string },
  data: unknown,
  timestamp = Date.now(),
): void {
  if (!isRecord(data)) {
    return;
  }
  const key = worktreeKey(target);
  const state = states.get(key) ?? { processes: [], toolUses: new Map() };
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
