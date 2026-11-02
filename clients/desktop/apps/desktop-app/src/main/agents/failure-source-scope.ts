import {
  AI_CREDITS_NO_BILLING_SOURCE_EVENT_TYPE,
  AI_CREDITS_USAGE_LIMIT_EVENT_TYPE,
} from '@canopy/desktop-shared/types';
import { CANOPY_AUTH_FAILURE_EVENT_TYPE } from '@canopy/protocol/auth-recovery';

/**
 * Notices a session derives from a provider failure and emits alongside it.
 * Each must carry the source's {@link FailureSourceScope}, or chat turn
 * telemetry reads a sub-agent's failure as the root turn's (CAN-4629).
 */
export const DERIVED_FAILURE_NOTICE_TYPES: readonly string[] = [
  AI_CREDITS_NO_BILLING_SOURCE_EVENT_TYPE,
  AI_CREDITS_USAGE_LIMIT_EVENT_TYPE,
  CANOPY_AUTH_FAILURE_EVENT_TYPE,
];

/**
 * Which agent a provider event came from: a Claude child tool use, or a Codex
 * thread. Empty for events that name neither.
 */
export interface FailureSourceScope {
  readonly parent_tool_use_id?: string;
  readonly thread_id?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readNonEmptyString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Read the scope from a Claude frame, a `{type: 'codex', event}` envelope, or
 * a notice that already carries one.
 */
export function readFailureSourceScope(source: unknown): FailureSourceScope {
  if (!isRecord(source)) return {};
  const parentToolUseId = readNonEmptyString(source, 'parent_tool_use_id');
  if (parentToolUseId) return { parent_tool_use_id: parentToolUseId };
  const event =
    source.type === 'codex' && isRecord(source.event) ? source.event : source;
  const threadId =
    readNonEmptyString(event, 'thread_id') ??
    readNonEmptyString(event, 'threadId');
  return threadId ? { thread_id: threadId } : {};
}

/** Copy the scope of the provider event a notice was derived from onto it. */
export function withFailureSourceScope<T>(notice: T, source: unknown): T {
  return isRecord(notice)
    ? { ...notice, ...readFailureSourceScope(source) }
    : notice;
}

/**
 * Wrap an emitter so every derived notice it sends carries the scope of the
 * provider event it was derived from. The scope is read only when a notice is
 * sent, so wrapping every stream event costs nothing.
 */
export function scopeDerivedNotices<R>(
  emit: (event: unknown) => R,
  source: unknown,
): (event: unknown) => R {
  return (event) => emit(withFailureSourceScope(event, source));
}
