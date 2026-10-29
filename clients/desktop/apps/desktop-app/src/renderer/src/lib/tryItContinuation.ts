import {
  isTryItContinuation,
  type TryItContinuation,
  type TryItContinuationReceipt,
} from '@canopy/protocol/try-it/continuation';
import { isThinkingLevel, type ThinkingLevel } from '@canopy/protocol/thinking';

/**
 * Guest Try it continuations on desktop (CAN-4396): one record per standalone
 * Try it chat, written before the connect gate opens and updated only while
 * it still carries the same continuation request id.
 *
 * The record is recovery metadata, never an authorization grant: only the
 * connect-gate request this renderer opened may bind a destination account.
 */

export interface DesktopTryItContinuationHost {
  projectId: string;
  worktreeId: string;
  model?: { model: string; thinkingLevel: ThinkingLevel };
  /** Set only when this guest explicitly activates sign-in. */
  authIntentAtMs?: number;
}

export type DesktopTryItContinuation =
  TryItContinuation<DesktopTryItContinuationHost>;

const STORAGE_PREFIX = 'canopy:try-it-continuation:';
const CHANGE_EVENT = 'canopy:try-it-continuation-change';

export function tryItContinuationStorageKey(chatId: string): string {
  return `${STORAGE_PREFIX}${chatId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDesktopHost(value: unknown): value is DesktopTryItContinuationHost {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      ['projectId', 'worktreeId', 'model', 'authIntentAtMs'].includes(key),
    ) &&
    typeof value.projectId === 'string' &&
    /^[a-z0-9][a-z0-9-]*$/.test(value.projectId) &&
    typeof value.worktreeId === 'string' &&
    /^[a-z0-9][a-z0-9-]*$/.test(value.worktreeId) &&
    (value.model === undefined ||
      (isRecord(value.model) &&
        Object.keys(value.model).every(
          (key) => key === 'model' || key === 'thinkingLevel',
        ) &&
        typeof value.model.model === 'string' &&
        value.model.model.trim().length > 0 &&
        isThinkingLevel(value.model.thinkingLevel))) &&
    (value.authIntentAtMs === undefined ||
      (typeof value.authIntentAtMs === 'number' &&
        Number.isFinite(value.authIntentAtMs) &&
        value.authIntentAtMs >= 0 &&
        value.authIntentAtMs <= Date.now()))
  );
}

function isDesktopContinuation(
  value: unknown,
  nowMs: number,
): value is DesktopTryItContinuation {
  return (
    isTryItContinuation<DesktopTryItContinuationHost>(value, {
      nowMs,
      isHost: isDesktopHost,
    }) && value.host !== undefined
  );
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function publish(chatId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { chatId } }));
}

/** The stored text for this chat's record, for `useSyncExternalStore`. */
export function readTryItContinuationRaw(chatId: string): string | null {
  try {
    return storage()?.getItem(tryItContinuationStorageKey(chatId)) ?? null;
  } catch {
    return null;
  }
}

/** Validates stored text for `chatId`; `null` when missing, malformed, or expired. */
export function parseTryItContinuation(
  raw: string | null,
  chatId: string,
  nowMs = Date.now(),
): DesktopTryItContinuation | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return isDesktopContinuation(value, nowMs) && value.sourceChatId === chatId
    ? value
    : null;
}

/** The live record for this chat, or `null` (missing, malformed, expired). */
export function readTryItContinuation(
  chatId: string,
  nowMs = Date.now(),
): DesktopTryItContinuation | null {
  return parseTryItContinuation(
    readTryItContinuationRaw(chatId),
    chatId,
    nowMs,
  );
}

/** Writes the record under its chat; `false` when storage refused it. */
export function writeTryItContinuation(
  record: DesktopTryItContinuation,
): boolean {
  const target = storage();
  if (!target || !isDesktopContinuation(record, Date.now())) return false;
  try {
    target.setItem(
      tryItContinuationStorageKey(record.sourceChatId),
      JSON.stringify(record),
    );
  } catch {
    return false;
  }
  publish(record.sourceChatId);
  return true;
}

/**
 * Applies `change` only while the record still carries `requestId`. Returns
 * the stored result, or `null` when it was replaced, invalid, or refused.
 */
export function updateTryItContinuation(
  chatId: string,
  requestId: string,
  change: (record: DesktopTryItContinuation) => DesktopTryItContinuation,
): DesktopTryItContinuation | null {
  const current = readTryItContinuation(chatId);
  if (!current || current.requestId !== requestId) return null;
  const next = change(current);
  if (next === current) return current;
  if (
    next.requestId !== requestId ||
    next.sourceChatId !== chatId ||
    !writeTryItContinuation(next)
  )
    return null;
  return next;
}

export function listTryItContinuations(): DesktopTryItContinuation[] {
  const target = storage();
  if (!target) return [];
  const records: DesktopTryItContinuation[] = [];
  try {
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index);
      if (!key?.startsWith(STORAGE_PREFIX)) continue;
      const chatId = key.slice(STORAGE_PREFIX.length);
      const record = parseTryItContinuation(target.getItem(key), chatId);
      if (record) records.push(record);
    }
  } catch {
    return [];
  }
  return records;
}

export function clearTryItContinuation(
  chatId: string,
  requestId: string,
): void {
  if (readTryItContinuation(chatId)?.requestId !== requestId) return;
  try {
    storage()?.removeItem(tryItContinuationStorageKey(chatId));
  } catch {
    return;
  }
  publish(chatId);
}

export function settleTryItContinuationReceipt(
  receipt: TryItContinuationReceipt,
): void {
  for (const record of listTryItContinuations()) {
    if (
      record.status === 'completed' ||
      record.requestId !== receipt.requestId ||
      record.destinationAccountKey !== receipt.accountKey ||
      (record.destinationChatId ?? record.sourceChatId) !== receipt.chatId
    )
      continue;
    updateTryItContinuation(
      record.sourceChatId,
      record.requestId,
      (current) => ({
        ...withoutTryItFailure(current),
        status: 'completed',
        receipt,
      }),
    );
  }
}

/** The record without a failure cause, for a transition out of `failed`. */
export function withoutTryItFailure(
  record: DesktopTryItContinuation,
): DesktopTryItContinuation {
  const next = { ...record };
  delete next.failure;
  return next;
}

/** Calls `listener` after a write to `chatId`'s record here or in another window. */
export function subscribeTryItContinuation(
  chatId: string,
  listener: () => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const key = tryItContinuationStorageKey(chatId);
  const onLocal = (event: Event): void => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : null;
    if (isRecord(detail) && detail.chatId === chatId) listener();
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === key) listener();
  };
  window.addEventListener(CHANGE_EVENT, onLocal);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onLocal);
    window.removeEventListener('storage', onStorage);
  };
}
