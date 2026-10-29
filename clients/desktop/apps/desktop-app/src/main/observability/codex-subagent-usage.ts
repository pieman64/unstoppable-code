import type {
  AgentAuditSubagentUsage,
  AgentAuditTokenTotals,
} from '@canopy/desktop-shared/types';
import { computeCodexObservedCost } from '../openai-pricing/cost-calculator';
import type { OpenAiPricingCacheState } from '../openai-pricing/pricing-client';

export const MAX_CODEX_SUBAGENTS_PER_ENTRY = 64;
export const MAX_CODEX_SUBAGENT_HISTORY_PER_CHAT = 256;

const MAX_THREAD_ID_LENGTH = 240;
const MAX_MODEL_LENGTH = 160;
const MAX_LABEL_LENGTH = 80;
const MAX_FALLBACK_TURN_IDS = MAX_CODEX_SUBAGENT_HISTORY_PER_CHAT;

type TokenField = keyof AgentAuditTokenTotals;
type CodexSubagentTokens = AgentAuditTokenTotals;

const TOKEN_FIELDS: readonly TokenField[] = [
  'input',
  'output',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'reasoningOutputTokens',
];

interface CodexSubagentRecord {
  threadId: string;
  model?: string;
  requestedModel?: string;
  nickname?: string;
  role?: string;
  baseline?: Partial<CodexSubagentTokens>;
  lastOnlyTurnIds: Set<string>;
  activeSeen: boolean;
  activeUsage?: CodexSubagentTokens;
  activeUsageObserved: boolean;
  pendingUsage?: CodexSubagentTokens;
  pendingUsageObserved: boolean;
}

export interface CodexSubagentUsageTrackerOptions {
  /** The chat keeps a bounded baseline horizon; a pipeline step is one entry. */
  historyLimit?: number;
}

export interface CodexSubagentCostOptions {
  serviceTier?: string;
  pricingState: OpenAiPricingCacheState;
  allowCost: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function isControlCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = Array.from(value)
    .filter((character) => !isControlCharacter(character))
    .join('')
    .trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.slice(0, maxLength);
}

function validThreadId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const threadId = value.trim();
  if (
    threadId.length === 0 ||
    threadId.length > MAX_THREAD_ID_LENGTH ||
    Array.from(threadId).some(isControlCharacter)
  ) {
    return undefined;
  }
  return threadId;
}

function readCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

function emptyTokens(): CodexSubagentTokens {
  return {
    input: 0,
    output: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

function addTokens(
  total: CodexSubagentTokens,
  increment: Partial<CodexSubagentTokens>,
): CodexSubagentTokens {
  return {
    input: total.input + (increment.input ?? 0),
    output: total.output + (increment.output ?? 0),
    cacheReadInputTokens:
      total.cacheReadInputTokens + (increment.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens:
      total.cacheCreationInputTokens +
      (increment.cacheCreationInputTokens ?? 0),
    reasoningOutputTokens:
      (total.reasoningOutputTokens ?? 0) +
      (increment.reasoningOutputTokens ?? 0),
  };
}

function parseTokenBreakdown(
  value: unknown,
): Partial<CodexSubagentTokens> | undefined {
  if (!isRecord(value)) return undefined;
  const tokens: Partial<CodexSubagentTokens> = {
    input: readCount(value.input_tokens),
    cacheReadInputTokens: readCount(value.cached_input_tokens),
    cacheCreationInputTokens: readCount(value.cache_write_input_tokens),
    output: readCount(value.output_tokens),
    reasoningOutputTokens: readCount(value.reasoning_output_tokens),
  };
  return TOKEN_FIELDS.some((field) => tokens[field] !== undefined)
    ? tokens
    : undefined;
}

function hasChildSource(event: Record<string, unknown>): boolean {
  const source = event.source;
  if (typeof source === 'string') {
    return source.toLowerCase().includes('subagent');
  }
  if (!isRecord(source)) return false;
  const subagent =
    (isRecord(source.subAgent) ? source.subAgent : undefined) ??
    (isRecord(source.subagent) ? source.subagent : undefined);
  return subagent !== undefined;
}

function childSourceRecord(
  event: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!isRecord(event.source)) return undefined;
  return (
    (isRecord(event.source.subAgent) ? event.source.subAgent : undefined) ??
    (isRecord(event.source.subagent) ? event.source.subagent : undefined)
  );
}

function childSourceThreadSpawn(
  source: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!source) return undefined;
  return (
    (isRecord(source.thread_spawn) ? source.thread_spawn : undefined) ??
    (isRecord(source.threadSpawn) ? source.threadSpawn : undefined)
  );
}

export function isCodexSubagentThreadStarted(
  event: Record<string, unknown>,
): boolean {
  const source = childSourceRecord(event);
  const spawn = childSourceThreadSpawn(source);
  return Boolean(
    readString(event, 'parent_thread_id') ??
    readString(event, 'parentThreadId') ??
    (source &&
      (readString(source, 'parent_thread_id') ??
        readString(source, 'parentThreadId'))) ??
    (spawn &&
      (readString(spawn, 'parent_thread_id') ??
        readString(spawn, 'parentThreadId'))) ??
    hasChildSource(event),
  );
}

function tokenDelta(
  current: Partial<CodexSubagentTokens>,
  previous: Partial<CodexSubagentTokens> | undefined,
  last: Partial<CodexSubagentTokens> | undefined,
): Partial<CodexSubagentTokens> {
  if (!previous) {
    // `total` can include work from before this audit entry was observed. The
    // first seen snapshot therefore contributes only its response-local
    // `last`, while `total` becomes the dedupe baseline for later snapshots.
    return last ?? {};
  }

  const delta: Partial<CodexSubagentTokens> = {};
  for (const field of TOKEN_FIELDS) {
    const currentValue = current[field];
    const previousValue = previous[field];
    if (currentValue === undefined) continue;
    if (previousValue === undefined || currentValue < previousValue) {
      // A newly visible field or cumulative reset must not make a lifetime
      // total look like new work. The provider's `last` is the safe fallback.
      delta[field] = last?.[field] ?? 0;
      continue;
    }
    delta[field] = currentValue - previousValue;
  }
  return delta;
}

function readSubagentTurnId(
  event: Record<string, unknown>,
): string | undefined {
  const turnId = boundedText(
    event.turn_id ?? event.turnId,
    MAX_THREAD_ID_LENGTH,
  );
  return turnId;
}

/**
 * Bounded per-chat (or per-open-pipeline-step) Codex child metadata and token
 * baselines. It deliberately retains only IDs, bounded display metadata,
 * requested/actual model ids, and numeric token counters — never prompts.
 * Chat baselines deduplicate within the most-recent 256 child-thread history
 * and fallback-only turn ids. Evicted children start a new dedupe horizon and
 * use `last` on first sighting.
 */
export class CodexSubagentUsageTracker {
  private readonly children = new Map<string, CodexSubagentRecord>();
  private readonly historyLimit: number;
  private active = false;

  constructor(options: CodexSubagentUsageTrackerOptions = {}) {
    this.historyLimit = Math.max(
      MAX_CODEX_SUBAGENTS_PER_ENTRY,
      Math.min(
        MAX_CODEX_SUBAGENT_HISTORY_PER_CHAT,
        options.historyLimit ?? MAX_CODEX_SUBAGENT_HISTORY_PER_CHAT,
      ),
    );
  }

  /** `previous` carries a reopened entry's earlier child usage forward. */
  beginEntry(previous: readonly AgentAuditSubagentUsage[] = []): void {
    this.active = true;
    for (const child of Array.from(this.children.values())) {
      child.activeSeen = child.pendingUsageObserved;
      child.activeUsage = child.pendingUsage;
      child.activeUsageObserved = child.pendingUsageObserved;
      child.pendingUsage = undefined;
      child.pendingUsageObserved = false;
    }
    for (const usage of previous) {
      if (usage.kind !== 'codex_agent') continue;
      const child = this.getOrCreate(usage.id);
      if (!child) continue;
      child.activeSeen = true;
      child.activeUsage = addTokens(
        child.activeUsage ?? emptyTokens(),
        usage.tokens,
      );
      child.activeUsageObserved = true;
      child.model ??= usage.model;
      child.nickname ??= usage.label;
    }
  }

  endEntry(): void {
    this.active = false;
    for (const child of Array.from(this.children.values())) {
      child.activeSeen = false;
      child.activeUsage = undefined;
      child.activeUsageObserved = false;
    }
  }

  observeThreadStarted(event: Record<string, unknown>): void {
    const threadId = validThreadId(event.thread_id ?? event.threadId);
    if (!threadId || !isCodexSubagentThreadStarted(event)) return;
    const child = this.getOrCreate(threadId);
    if (!child) return;
    if (this.active) child.activeSeen = true;

    const model = boundedText(event.model, MAX_MODEL_LENGTH);
    const nickname = boundedText(
      event.agent_nickname ?? event.agentNickname,
      MAX_LABEL_LENGTH,
    );
    const role = boundedText(
      event.agent_role ?? event.agentRole,
      MAX_LABEL_LENGTH,
    );
    if (model) child.model = model;
    if (nickname) child.nickname = nickname;
    if (role) child.role = role;
  }

  observeSpawnItem(item: Record<string, unknown>): void {
    if (
      readString(item, 'type') !== 'collab_agent_tool_call' ||
      readString(item, 'tool') !== 'spawnAgent'
    ) {
      return;
    }
    const requestedModel = boundedText(
      item.model ?? item.requested_model ?? item.requestedModel,
      MAX_MODEL_LENGTH,
    );
    const receiverIds = Array.isArray(item.receiver_thread_ids)
      ? item.receiver_thread_ids
      : Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds
        : [];
    for (const receiverId of receiverIds.slice(
      0,
      MAX_CODEX_SUBAGENTS_PER_ENTRY,
    )) {
      const threadId = validThreadId(receiverId);
      if (!threadId) continue;
      const child = this.getOrCreate(threadId);
      if (!child) continue;
      if (this.active) child.activeSeen = true;
      if (requestedModel) child.requestedModel = requestedModel;
    }
  }

  observeUsageEvent(event: Record<string, unknown>): void {
    if (readString(event, 'type') !== 'thread.subagent_token_usage.updated') {
      return;
    }
    const threadId = validThreadId(event.thread_id ?? event.threadId);
    if (!threadId) return;
    const child = this.getOrCreate(threadId);
    if (!child) return;
    if (this.active) child.activeSeen = true;

    const total = parseTokenBreakdown(event.total);
    const last = parseTokenBreakdown(event.last);
    const turnId = readSubagentTurnId(event);
    let increment: Partial<CodexSubagentTokens>;

    if (total) {
      increment = tokenDelta(total, child.baseline, last);
      child.baseline = total;
    } else {
      if (!last || !turnId || child.lastOnlyTurnIds.has(turnId)) return;
      child.lastOnlyTurnIds.add(turnId);
      while (child.lastOnlyTurnIds.size > MAX_FALLBACK_TURN_IDS) {
        const oldest = child.lastOnlyTurnIds.values().next().value;
        if (oldest === undefined) break;
        child.lastOnlyTurnIds.delete(oldest);
      }
      increment = last;
    }

    if (!this.active && !total && (!last || !turnId)) return;
    const observed = TOKEN_FIELDS.some(
      (field) => increment[field] !== undefined,
    );
    if (!observed) return;
    this.addToTarget(child, increment, !this.active);
  }

  toAuditUsages(options: CodexSubagentCostOptions): AgentAuditSubagentUsage[] {
    const usages: AgentAuditSubagentUsage[] = [];
    for (const child of Array.from(this.children.values())) {
      if (!child.activeUsageObserved || !child.activeUsage) continue;
      const model = child.model ?? child.requestedModel;
      const tokens = child.activeUsage;
      const cost =
        options.allowCost && model
          ? computeCodexObservedCost(
              {
                model,
                serviceTier: options.serviceTier,
                usageObserved: true,
                tokens: {
                  input: tokens.input,
                  output: tokens.output,
                  cacheReadInputTokens: tokens.cacheReadInputTokens,
                  cacheCreationInputTokens: tokens.cacheCreationInputTokens,
                  reasoningOutputTokens: tokens.reasoningOutputTokens,
                },
              },
              options.pricingState,
            )
          : undefined;
      const label = child.nickname ?? child.role;
      usages.push({
        id: child.threadId,
        kind: 'codex_agent',
        ...(label ? { label } : {}),
        ...(model ? { model } : {}),
        tokens: {
          input: tokens.input,
          output: tokens.output,
          cacheReadInputTokens: tokens.cacheReadInputTokens,
          cacheCreationInputTokens: tokens.cacheCreationInputTokens,
          reasoningOutputTokens: tokens.reasoningOutputTokens,
        },
        ...(typeof cost?.totalUsd === 'number'
          ? { costUsd: cost.totalUsd }
          : {}),
        inclusion: 'additional',
      });
    }
    return usages;
  }

  private getOrCreate(threadId: string): CodexSubagentRecord | undefined {
    const existing = this.children.get(threadId);
    if (existing) {
      this.children.delete(threadId);
      this.children.set(threadId, existing);
      return existing;
    }
    if (this.children.size >= this.historyLimit) {
      const oldestIdleThreadId = Array.from(this.children.entries()).find(
        ([, child]) =>
          !child.activeSeen &&
          !child.activeUsageObserved &&
          !child.pendingUsageObserved,
      )?.[0];
      if (oldestIdleThreadId === undefined) return undefined;
      // Baselines dedupe while a child is resident in this bounded chat
      // history. Once evicted, the next sighting uses only `last` rather than
      // replaying `total`, so the lost history can never charge lifetime use.
      this.children.delete(oldestIdleThreadId);
    }
    const child: CodexSubagentRecord = {
      threadId,
      lastOnlyTurnIds: new Set<string>(),
      activeSeen: false,
      activeUsageObserved: false,
      pendingUsageObserved: false,
    };
    this.children.set(threadId, child);
    return child;
  }

  private addToTarget(
    child: CodexSubagentRecord,
    increment: Partial<CodexSubagentTokens>,
    pending: boolean,
  ): void {
    const alreadyObserved = pending
      ? child.pendingUsageObserved
      : child.activeUsageObserved;
    if (
      !alreadyObserved &&
      this.countObservedChildren(pending) >= MAX_CODEX_SUBAGENTS_PER_ENTRY
    ) {
      return;
    }
    if (pending) {
      child.pendingUsage = addTokens(
        child.pendingUsage ?? emptyTokens(),
        increment,
      );
      child.pendingUsageObserved = true;
      return;
    }
    child.activeUsage = addTokens(
      child.activeUsage ?? emptyTokens(),
      increment,
    );
    child.activeUsageObserved = true;
  }

  private countObservedChildren(pending: boolean): number {
    let count = 0;
    for (const child of Array.from(this.children.values())) {
      if (pending ? child.pendingUsageObserved : child.activeUsageObserved) {
        count += 1;
      }
    }
    return count;
  }
}
