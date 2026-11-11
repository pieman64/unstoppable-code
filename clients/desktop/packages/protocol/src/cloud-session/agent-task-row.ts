import { z } from 'zod';
import {
  AGENT_TASK_HARNESSES,
  AGENT_TASK_KINDS,
  AGENT_TASK_STATUSES,
  AGENT_TASK_STOP_REASONS,
  type AgentTaskHarness,
  type AgentTaskKind,
  type AgentTaskNativeIds,
  type AgentTaskStatus,
  type AgentTaskStopReason,
} from './agent-task';

/** The model a task runs, as Core names it. */
export interface AgentTaskModelRef {
  readonly id: string;
  readonly label?: string;
  /** Declared context window in tokens, when the source carries one. */
  readonly contextWindow?: number;
}

/** A task's token usage; every field optional and non-negative. */
export interface AgentTaskUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly contextTokens?: number;
  readonly contextWindow?: number;
}

/**
 * One agent task (a subagent or a background shell), as Agentic Core's
 * `AgentTaskRef` (REG-3067) reads once parsed. Tolerant: an enum value this
 * build does not know is `'unknown'`. Timestamps are epoch ms.
 */
export interface AgentTaskRow {
  readonly taskId: string;
  readonly parentTaskId: string | null;
  readonly spawnTurnId: string | null;
  readonly spawnToolCallId: string | null;
  readonly kind: AgentTaskKind | 'unknown';
  readonly harness: AgentTaskHarness | 'unknown';
  readonly native: AgentTaskNativeIds;
  readonly title: string | null;
  readonly description: string | null;
  readonly prompt: string | null;
  readonly subagentType: string | null;
  readonly model: AgentTaskModelRef | null;
  readonly thinkingEffort: string | null;
  readonly status: AgentTaskStatus | 'unknown';
  readonly approvalPending: boolean;
  readonly stopReason: AgentTaskStopReason | null;
  readonly background: boolean;
  readonly usage: AgentTaskUsage | null;
  /** Exact decimal USD string, as Core sends it. */
  readonly costUsd: string | null;
  readonly summary: string | null;
  /**
   * The latest progress line of a running background agent or task
   * (REG-3081). Absent on rows from an older Core.
   */
  readonly progress?: string | null;
  readonly outputTail: string | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  /**
   * Whether Core can stop the task now (REG-3079). Absent on rows from an
   * older Core, which offers no stop.
   */
  readonly stoppable?: boolean;
  readonly createdAtMs: number | null;
  readonly startedAtMs: number | null;
  readonly updatedAtMs: number | null;
  readonly completedAtMs: number | null;
  /** Per-task monotonic decimal string; a lower value is an older upsert. */
  readonly stateVersion: string;
}

/** The most task rows a chat carries, as the cloud task fold bounds them. */
export const AGENT_TASK_ROW_LIMIT = 256;

const DECIMAL_STRING = /^\d+$/;

const NATIVE_ID_KEYS = [
  'toolUseId',
  'agentId',
  'taskId',
  'threadId',
  'callId',
  'shellId',
  'rootThreadId',
  'agentPath',
  'toolName',
] as const;

/** A task's harness-native ids, keeping only non-empty strings. */
export function readAgentTaskNativeIds(
  raw: Record<string, unknown> | null | undefined,
): AgentTaskNativeIds {
  const native: { -readonly [K in keyof AgentTaskNativeIds]?: string } = {};
  for (const key of NATIVE_ID_KEYS) {
    const value = raw?.[key];
    if (typeof value === 'string' && value.length > 0) native[key] = value;
  }
  return native;
}

function oneOf<T extends string>(
  values: readonly T[],
  value: string,
): T | undefined {
  return values.find((candidate) => candidate === value);
}

const usageSchema = z.object({
  inputTokens: z.number().finite().nonnegative().optional(),
  outputTokens: z.number().finite().nonnegative().optional(),
  totalTokens: z.number().finite().nonnegative().optional(),
  cacheReadTokens: z.number().finite().nonnegative().optional(),
  cacheWriteTokens: z.number().finite().nonnegative().optional(),
  reasoningTokens: z.number().finite().nonnegative().optional(),
  contextTokens: z.number().finite().nonnegative().optional(),
  contextWindow: z.number().finite().nonnegative().optional(),
});

const rowSchema = z.object({
  taskId: z.string().min(1),
  stateVersion: z.string().regex(DECIMAL_STRING),
  kind: z.string(),
  harness: z.string(),
  status: z.string(),
  stopReason: z.string().nullable(),
  native: z.record(z.string(), z.unknown()),
  parentTaskId: z.string().nullable(),
  spawnTurnId: z.string().nullable(),
  spawnToolCallId: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  prompt: z.string().nullable(),
  subagentType: z.string().nullable(),
  thinkingEffort: z.string().nullable(),
  costUsd: z.string().nullable(),
  summary: z.string().nullable(),
  progress: z.string().nullable().optional(),
  outputTail: z.string().nullable(),
  stoppable: z.boolean().optional(),
  model: z
    .object({ id: z.string().min(1), label: z.string().optional() })
    .nullable(),
  usage: usageSchema.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  createdAtMs: z.number().finite().nullable(),
  startedAtMs: z.number().finite().nullable(),
  updatedAtMs: z.number().finite().nullable(),
  completedAtMs: z.number().finite().nullable(),
  approvalPending: z.boolean(),
  background: z.boolean(),
});

/**
 * One task row in its parsed JSON form (what a parsed row serializes to), or
 * undefined when it is malformed or names an enum value outside the known
 * ones and `'unknown'`.
 */
export function parseAgentTaskRow(value: unknown): AgentTaskRow | undefined {
  const parsed = rowSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const raw = parsed.data;
  const kind =
    raw.kind === 'unknown' ? 'unknown' : oneOf(AGENT_TASK_KINDS, raw.kind);
  const harness =
    raw.harness === 'unknown'
      ? 'unknown'
      : oneOf(AGENT_TASK_HARNESSES, raw.harness);
  const status =
    raw.status === 'unknown'
      ? 'unknown'
      : oneOf(AGENT_TASK_STATUSES, raw.status);
  const stopReason =
    raw.stopReason === null
      ? null
      : oneOf(AGENT_TASK_STOP_REASONS, raw.stopReason);
  if (
    kind === undefined ||
    harness === undefined ||
    status === undefined ||
    stopReason === undefined
  )
    return undefined;
  const usage: { -readonly [K in keyof AgentTaskUsage]?: number } = {};
  if (raw.usage !== null) {
    for (const key of usageSchema.keyof().options) {
      const read = raw.usage[key];
      if (read !== undefined) usage[key] = read;
    }
  }
  return {
    ...raw,
    kind,
    harness,
    status,
    stopReason,
    native: readAgentTaskNativeIds(raw.native),
    model:
      raw.model === null
        ? null
        : {
            id: raw.model.id,
            ...(raw.model.label === undefined
              ? {}
              : { label: raw.model.label }),
          },
    usage: raw.usage === null ? null : usage,
  };
}

/** The well-formed rows of a task list, at most {@link AGENT_TASK_ROW_LIMIT}. */
export function parseAgentTaskRows(value: unknown): readonly AgentTaskRow[] {
  if (!Array.isArray(value)) return [];
  const rows: AgentTaskRow[] = [];
  for (const item of value) {
    const row = parseAgentTaskRow(item);
    if (row !== undefined) rows.push(row);
    if (rows.length >= AGENT_TASK_ROW_LIMIT) break;
  }
  return rows;
}
