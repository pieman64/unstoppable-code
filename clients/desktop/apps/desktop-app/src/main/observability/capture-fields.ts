import type {
  AgentAuditBillingBasis,
  AgentAuditCompaction,
  AgentAuditContextCategory,
  AgentAuditContextCategoryKind,
  AgentAuditContextUsage,
  AgentAuditEntry,
  AgentAuditSubagentUsage,
} from '@canopy/desktop-shared/types/observability';
import type { ChatContextUsageBreakdown } from '@canopy/desktop-shared/types';
import type { AgentProviderType } from '@canopy/desktop-shared/types';
import type { ProviderBillingAccountKind } from '../auth/provider-auth-state';

const CONTEXT_CATEGORY_LIMIT = 24;
const CONTEXT_CATEGORY_NAME_LIMIT = 80;
const COMPACTION_LIMIT = 100;
const SUBAGENT_LIMIT = 64;
const TRACKED_CLAUDE_TASK_LIMIT = 256;
const TASK_ID_LIMIT = 128;
const SUBAGENT_LABEL_LIMIT = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ClaudeContextSnapshotEvent {
  type: 'canopy_context_snapshot';
  userMessageId?: string;
  context: AgentAuditContextUsage;
}

export function billingBasisAtEntryStart(
  provider: AgentProviderType,
  accountKind: ProviderBillingAccountKind,
  aiCreditsRouted: boolean,
  modelGatewayRouted: boolean,
  accountProxyRouted = false,
): AgentAuditBillingBasis {
  if (modelGatewayRouted) return 'org_gateway';
  if (aiCreditsRouted) return 'ai_credits';
  // Served by a connected account proxy (CAN-4037), never the native account.
  if (accountProxyRouted) return 'account_proxy';
  if (provider === 'ollama') return 'local';
  if (accountKind === 'subscription') return 'subscription';
  if (accountKind === 'api_key' || accountKind === 'bedrock') return 'api_key';
  return 'unknown';
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

export function claudeContextEndTokens(usage: unknown): number | undefined {
  if (!isRecord(usage)) return undefined;
  const record = usage;
  const input = nonNegativeInteger(record.input_tokens);
  const cacheRead = nonNegativeInteger(record.cache_read_input_tokens);
  const cacheCreation = nonNegativeInteger(record.cache_creation_input_tokens);
  if (
    input === undefined &&
    cacheRead === undefined &&
    cacheCreation === undefined
  ) {
    return undefined;
  }
  const total = (input ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0);
  return Number.isSafeInteger(total) ? total : undefined;
}

function isContextCategoryKind(
  value: unknown,
): value is AgentAuditContextCategoryKind {
  return (
    value === 'used' ||
    value === 'free' ||
    value === 'buffer' ||
    value === 'deferred'
  );
}

function normalizeCategories(
  value: unknown,
): AgentAuditContextCategory[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const categories = value
    .slice(0, CONTEXT_CATEGORY_LIMIT)
    .flatMap((candidate): AgentAuditContextCategory[] => {
      if (!isRecord(candidate)) return [];
      const record = candidate;
      const name = typeof record.name === 'string' ? record.name.trim() : '';
      const tokens = nonNegativeInteger(record.tokens);
      if (
        !name ||
        tokens === undefined ||
        !isContextCategoryKind(record.kind)
      ) {
        return [];
      }
      return [
        {
          name: name.slice(0, CONTEXT_CATEGORY_NAME_LIMIT),
          tokens,
          kind: record.kind,
        },
      ];
    });
  return categories.length > 0 ? categories : undefined;
}

export function normalizeAuditContextUsage(
  value: unknown,
): AgentAuditContextUsage | undefined {
  if (!isRecord(value)) return undefined;
  const record = value;
  const endTokens = nonNegativeInteger(record.endTokens);
  const windowTokens = nonNegativeInteger(record.windowTokens);
  if (
    endTokens === undefined ||
    windowTokens === undefined ||
    windowTokens === 0
  ) {
    return undefined;
  }
  const peakTokens = nonNegativeInteger(record.peakTokens);
  const categories = normalizeCategories(record.categories);
  return {
    endTokens,
    windowTokens,
    ...(peakTokens === undefined ? {} : { peakTokens }),
    ...(categories === undefined ? {} : { categories }),
  };
}

export function mergeAuditContextUsage(
  entry: AgentAuditEntry,
  context: AgentAuditContextUsage,
): void {
  const previous = entry.context;
  const peakTokens = Math.max(
    context.endTokens,
    context.peakTokens ?? context.endTokens,
    previous?.endTokens ?? 0,
    previous?.peakTokens ?? 0,
  );
  const categories = context.categories ?? previous?.categories;
  entry.context = {
    endTokens: context.endTokens,
    windowTokens: context.windowTokens,
    ...(peakTokens > context.endTokens ? { peakTokens } : {}),
    ...(categories && categories.length > 0 ? { categories } : {}),
  };
}

export function recordAuditCompaction(
  entry: AgentAuditEntry,
  eventId: string,
  compaction: AgentAuditCompaction,
  seenIds: Set<string>,
): boolean {
  const normalizedId = eventId.trim();
  if (!normalizedId || seenIds.has(normalizedId)) return false;
  const existing = entry.compactions ?? [];
  if (
    existing.some(
      (candidate) =>
        candidate.at === compaction.at &&
        candidate.trigger === compaction.trigger &&
        candidate.preTokens === compaction.preTokens,
    )
  ) {
    seenIds.add(normalizedId);
    return false;
  }
  seenIds.add(normalizedId);
  entry.compactions = [...existing, compaction].slice(-COMPACTION_LIMIT);
  return true;
}

interface ClaudeTaskState {
  id: string;
  taskId: string;
  totalTokens: number;
  pendingTotalTokens: number;
  pendingRegistration: boolean;
  pendingLabel: boolean;
  active: boolean;
  label?: string;
}

type ClaudeTaskEvent =
  | {
      subtype: 'task_started';
      taskId: string;
      toolUseId: string;
      label?: string;
    }
  | {
      subtype: 'task_progress' | 'task_notification';
      taskId: string;
      toolUseId?: string;
      totalTokens?: number;
      label?: string;
      status?: 'completed' | 'failed' | 'stopped';
    };

function boundedClaudeTaskId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= TASK_ID_LIMIT
    ? normalized
    : undefined;
}

function safeSubagentTypeLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = Array.from(value.slice(0, 1024))
    .filter((character): boolean => {
      const code = character.charCodeAt(0);
      return code > 31 && (code < 127 || code > 159);
    })
    .join('')
    .trim();
  if (!normalized) return undefined;
  return normalized.slice(0, SUBAGENT_LABEL_LIMIT);
}

function normalizeClaudeTaskEvent(
  data: Record<string, unknown>,
): ClaudeTaskEvent | undefined {
  if (data.type !== 'system') return undefined;
  const subtype = data.subtype;
  const taskId = boundedClaudeTaskId(data.task_id);
  if (!taskId) return undefined;
  const label = safeSubagentTypeLabel(data.subagent_type);

  if (subtype === 'task_started') {
    const toolUseId = boundedClaudeTaskId(data.tool_use_id);
    if (data.task_type !== 'local_agent' || !toolUseId) {
      return undefined;
    }
    return { subtype, taskId, toolUseId, ...(label ? { label } : {}) };
  }

  if (subtype === 'task_progress' || subtype === 'task_notification') {
    const toolUseId = boundedClaudeTaskId(data.tool_use_id);
    const usage = isRecord(data.usage) ? data.usage : undefined;
    const totalTokens = usage
      ? nonNegativeInteger(usage.total_tokens)
      : undefined;
    const status =
      subtype === 'task_notification' &&
      (data.status === 'completed' ||
        data.status === 'failed' ||
        data.status === 'stopped')
        ? data.status
        : undefined;
    if (
      totalTokens === undefined &&
      label === undefined &&
      status === undefined
    ) {
      return undefined;
    }
    return {
      subtype,
      taskId,
      ...(toolUseId ? { toolUseId } : {}),
      ...(totalTokens === undefined ? {} : { totalTokens }),
      ...(label ? { label } : {}),
      ...(status ? { status } : {}),
    };
  }

  return undefined;
}

function addSafeTokenTotal(current: number, increment: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, current + increment);
}

/**
 * Tracks Claude SDK task lifecycle and its cumulative usage for one chat key.
 * Events observed without a current audit entry are reduced to bounded task
 * state (at most 256 tracked tasks); no prompt, description, or raw event is
 * retained. Each audit entry stores at most 64 subagent rows.
 */
export class ClaudeTaskUsageTracker {
  private readonly tasksByToolUseId = new Map<string, ClaudeTaskState>();

  private readonly tasksByTaskId = new Map<string, ClaudeTaskState>();

  /**
   * Observes one Claude system event. Returns whether `entry` was changed;
   * when `entry` is absent the sanitized event is queued and this returns false.
   */
  observe(
    entry: AgentAuditEntry | undefined,
    data: Record<string, unknown>,
  ): boolean {
    const pendingChanges = entry ? this.applyPending(entry) : false;
    const event = normalizeClaudeTaskEvent(data);
    if (!event) return pendingChanges;

    if (event.subtype === 'task_started') {
      const existing = this.tasksByToolUseId.get(event.toolUseId);
      if (existing) {
        this.updateTaskIdMapping(existing, event.taskId);
        this.updateTaskLabel(existing, event.label);
        if (!entry) existing.pendingLabel = true;
        return entry
          ? this.updateEntryRow(entry, existing, 0, false) || pendingChanges
          : false;
      }
      const existingTaskId = this.tasksByTaskId.get(event.taskId);
      if (existingTaskId?.id === event.toolUseId) return pendingChanges;
      this.makeTaskRoom();

      const state: ClaudeTaskState = {
        id: event.toolUseId,
        taskId: event.taskId,
        totalTokens: 0,
        pendingTotalTokens: 0,
        pendingRegistration: !entry,
        pendingLabel: !entry && event.label !== undefined,
        active: true,
        ...(event.label ? { label: event.label } : {}),
      };
      this.tasksByToolUseId.set(state.id, state);
      this.tasksByTaskId.set(state.taskId, state);
      if (!entry) return false;
      state.pendingRegistration = false;
      entry.subAgentCount += 1;
      this.updateEntryRow(entry, state, 0, true);
      return true;
    }

    const state = event.toolUseId
      ? this.tasksByToolUseId.get(event.toolUseId)
      : this.tasksByTaskId.get(event.taskId);
    if (state && state.taskId !== event.taskId) return pendingChanges;
    if (!state) return pendingChanges;
    const labelChanged = this.updateTaskLabel(state, event.label);
    if (!entry && labelChanged) state.pendingLabel = true;

    let entryChanged = false;
    const totalTokens = event.totalTokens;
    if (totalTokens !== undefined && totalTokens > state.totalTokens) {
      const increase = totalTokens - state.totalTokens;
      state.totalTokens = totalTokens;
      if (!entry) {
        state.pendingTotalTokens = addSafeTokenTotal(
          state.pendingTotalTokens,
          increase,
        );
      } else {
        entryChanged = this.updateEntryRow(entry, state, increase, true);
      }
    }

    // The first terminal notification publishes usage that progress events
    // added, even when it carries none itself; repeats do not.
    let ended = false;
    if (event.subtype === 'task_notification' && event.status && state.active) {
      state.active = false;
      ended = true;
    }
    if (!entry) {
      return false;
    }
    return (
      this.updateEntryRow(entry, state, 0, false) ||
      entryChanged ||
      pendingChanges ||
      ended
    );
  }

  /** Applies task starts and usage accumulated while no audit entry was open. */
  applyPending(entry: AgentAuditEntry): boolean {
    let changed = false;
    for (const state of Array.from(this.tasksByToolUseId.values())) {
      if (state.pendingRegistration) {
        state.pendingRegistration = false;
        entry.subAgentCount += 1;
        this.updateEntryRow(entry, state, 0, true);
        changed = true;
      } else if (state.pendingLabel) {
        changed = this.updateEntryRow(entry, state, 0, false) || changed;
      }

      if (state.pendingTotalTokens > 0) {
        changed =
          this.updateEntryRow(entry, state, state.pendingTotalTokens, true) ||
          changed;
        state.pendingTotalTokens = 0;
      }
      state.pendingLabel = false;
    }
    return changed;
  }

  private updateTaskLabel(
    state: ClaudeTaskState,
    label: string | undefined,
  ): boolean {
    if (!label || state.label === label) return false;
    state.label = label;
    return true;
  }

  private updateTaskIdMapping(state: ClaudeTaskState, taskId: string): void {
    if (state.taskId === taskId) return;
    if (this.tasksByTaskId.get(state.taskId) === state) {
      this.tasksByTaskId.delete(state.taskId);
    }
    state.taskId = taskId;
    this.tasksByTaskId.set(taskId, state);
  }

  private makeTaskRoom(): void {
    if (this.tasksByToolUseId.size < TRACKED_CLAUDE_TASK_LIMIT) return;
    const tracked = Array.from(this.tasksByToolUseId.values());
    const oldestCompleted = tracked.find((state) => !state.active);
    const oldest = oldestCompleted ?? tracked[0];
    if (!oldest) return;
    this.tasksByToolUseId.delete(oldest.id);
    if (this.tasksByTaskId.get(oldest.taskId) === oldest) {
      this.tasksByTaskId.delete(oldest.taskId);
    }
  }

  private updateEntryRow(
    entry: AgentAuditEntry,
    state: ClaudeTaskState,
    tokenIncrease: number,
    createIfMissing: boolean,
  ): boolean {
    const previousEntries = entry.subagents ?? [];
    const index = previousEntries.findIndex(
      (candidate) => candidate.id === state.id,
    );
    const previous = index >= 0 ? previousEntries[index] : undefined;
    if (!previous && !createIfMissing) return false;
    if (!previous && previousEntries.length >= SUBAGENT_LIMIT) return false;

    const totalTokens = addSafeTokenTotal(
      previous?.totalTokens ?? 0,
      tokenIncrease,
    );
    const tokens = {
      input: 0,
      output: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
    };
    const next: AgentAuditSubagentUsage = {
      id: state.id,
      kind: 'claude_task',
      ...(state.label ? { label: state.label } : {}),
      tokens,
      totalTokens,
      inclusion: 'included',
    };

    if (
      previous &&
      previous.kind === next.kind &&
      previous.label === next.label &&
      previous.totalTokens === next.totalTokens &&
      previous.inclusion === next.inclusion &&
      previous.tokens.input === 0 &&
      previous.tokens.output === 0 &&
      previous.tokens.cacheReadInputTokens === 0 &&
      previous.tokens.cacheCreationInputTokens === 0 &&
      (previous.tokens.reasoningOutputTokens ?? 0) === 0
    ) {
      return false;
    }

    if (index >= 0) {
      const nextEntries = [...previousEntries];
      nextEntries[index] = next;
      entry.subagents = nextEntries;
    } else {
      entry.subagents = [...previousEntries, next];
    }
    return true;
  }
}

function contextCategoriesFromSummary(
  categories: ChatContextUsageBreakdown['categories'],
): AgentAuditContextCategory[] | undefined {
  return normalizeCategories(categories);
}

/**
 * Reads a summary promise already started while the Claude query is live.
 * This is intentionally fire-and-forget: a missing/rejected snapshot never
 * holds up or fails the completed provider turn.
 */
export function captureClaudeContextSnapshot(options: {
  summary: Promise<ChatContextUsageBreakdown | null>;
  includeCategories: boolean;
  endTokens?: number;
  userMessageId?: string;
  onSnapshot: (event: ClaudeContextSnapshotEvent) => void;
}): void {
  void options.summary
    .then((summary): void => {
      if (!summary) return;
      const endTokens =
        nonNegativeInteger(options.endTokens) ??
        nonNegativeInteger(summary.totalTokens);
      const windowTokens = nonNegativeInteger(summary.maxTokens);
      if (
        endTokens === undefined ||
        windowTokens === undefined ||
        windowTokens === 0
      ) {
        return;
      }
      const categories = options.includeCategories
        ? contextCategoriesFromSummary(summary.categories)
        : undefined;
      options.onSnapshot({
        type: 'canopy_context_snapshot',
        ...(options.userMessageId
          ? { userMessageId: options.userMessageId }
          : {}),
        context: {
          endTokens,
          windowTokens,
          ...(categories ? { categories } : {}),
        },
      });
    })
    .catch((): void => undefined);
}
