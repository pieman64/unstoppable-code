import {
  tryItAccountMcpSelection,
  sameTryItCapability,
  TRY_IT_AUTH_INTENT_TTL_MS,
} from '@canopy/protocol/try-it/continuation';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type { AccountMcpConnectionSummary } from '@canopy/desktop-shared/types/mcp-servers';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  readTryItContinuation,
  readTryItContinuationRaw,
  updateTryItContinuation,
  withoutTryItFailure,
} from './tryItContinuation';
import type { DesktopTryItContinuation } from './tryItContinuation';

/**
 * Resolves a Try it capability after sign-in (CAN-4396, CAN-5218). The
 * starter prompt is already an unsent draft in the chat's composer, so a
 * continuation only replaces the unresolved capability with its account
 * connection. It never sends, and never rewrites the draft: the user's
 * explicit Send starts the turn.
 */
export interface DesktopTryItRunnerPorts {
  accountKey: () => Promise<string | null>;
  selections: () => ChatTabPluginSelections | null;
  connections: () => Promise<AccountMcpConnectionSummary[]>;
  updateSelections: (
    resolve: (selections: ChatTabPluginSelections) => ChatTabPluginSelections,
    canContinue: () => Promise<boolean>,
  ) => Promise<void>;
  rebind: (record: DesktopTryItContinuation, accountKey: string) => void;
}

const running = new Map<
  string,
  { promise: Promise<void>; signal: AbortSignal }
>();

const selectionWrites = new Map<string, Promise<unknown>>();

/** Serialize authorization and composer picker intents for one captured chat. */
export function queueDesktopTryItSelectionUpdate<Result>(
  target: { projectId: string; worktreeId: string; chatId: string },
  write: () => Promise<Result>,
): Promise<Result> {
  const key = JSON.stringify([
    target.projectId,
    target.worktreeId,
    target.chatId,
  ]);
  const previous = selectionWrites.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(write);
  selectionWrites.set(key, result);
  const clear = (): void => {
    if (selectionWrites.get(key) === result) selectionWrites.delete(key);
  };
  void result.then(clear, clear);
  return result;
}

/** All composer actions and account/mount recovery enter this one guarded routine. */
export function runDesktopTryItContinuation(
  chatId: string,
  accountKey: string,
  ports: DesktopTryItRunnerPorts,
): Promise<void> {
  const key = `${chatId}/${accountKey}`;
  const active = running.get(key);
  if (active && !active.signal.aborted) return active.promise;
  // An account notification invalidates this session even if the account has
  // switched back by the time an outstanding account/receipt read resolves.
  const controller = new AbortController();
  const invalidate = (): void => controller.abort();
  window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, invalidate);
  const promise = run(chatId, accountKey, ports, controller.signal).finally(
    () => {
      window.removeEventListener(
        CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
        invalidate,
      );
      if (running.get(key)?.promise === promise) running.delete(key);
    },
  );
  running.set(key, { promise, signal: controller.signal });
  return promise;
}

async function run(
  chatId: string,
  accountKey: string,
  ports: DesktopTryItRunnerPorts,
  signal: AbortSignal,
): Promise<void> {
  const initialRaw = readTryItContinuationRaw(chatId);
  let record = readTryItContinuation(chatId);
  if (
    !record ||
    !record.host ||
    record.status === 'completed' ||
    record.status === 'setup-required' ||
    (record.destinationAccountKey !== undefined &&
      record.destinationAccountKey !== accountKey)
  )
    return;
  // Replacement-chat auto-resume is out of scope: only the chat this record
  // was launched in is ever continued or settled here.
  if ((record.destinationChatId ?? record.sourceChatId) !== chatId) return;
  const intent = record.host.authIntentAtMs;
  if (
    !record.destinationAccountKey &&
    (intent === undefined || Date.now() - intent >= TRY_IT_AUTH_INTENT_TTL_MS)
  )
    return;
  const requestId = record.requestId;
  if (
    (await ports.accountKey()) !== accountKey ||
    signal.aborted ||
    ports.selections() === null ||
    readTryItContinuationRaw(chatId) !== initialRaw
  )
    return;
  record = updateTryItContinuation(chatId, requestId, (saved) => {
    if (
      saved.destinationAccountKey &&
      saved.destinationAccountKey !== accountKey
    )
      return saved;
    return { ...saved, destinationAccountKey: accountKey };
  });
  if (!record?.host || record.destinationAccountKey !== accountKey) return;
  const recordCapability = record.capability;
  const expectedRaw = JSON.stringify(record);
  const current = async (): Promise<boolean> => {
    if (signal.aborted || (await ports.accountKey()) !== accountKey)
      return false;
    // Read mutable state AFTER awaiting the account; a newer run may have
    // replaced/completed/cancelled the record during that IPC round trip.
    const saved = readTryItContinuation(chatId);
    return (
      !signal.aborted &&
      readTryItContinuationRaw(chatId) === expectedRaw &&
      saved?.requestId === requestId &&
      saved.destinationAccountKey === accountKey &&
      saved.status !== 'completed' &&
      saved.status !== 'setup-required' &&
      ports.selections() !== null
    );
  };
  // Settle only for the account this run bound, never one observed later.
  const settle = (): void => {
    updateTryItContinuation(chatId, requestId, (saved) => ({
      ...withoutTryItFailure(saved),
      status: 'completed',
      selectionResolution: { accountKey, chatId, requestId },
    }));
  };
  try {
    ports.rebind(record, accountKey);
    const connections = await ports.connections();
    if (!(await current())) return;
    const ref = tryItAccountMcpSelection(recordCapability, connections);
    if (!ref) {
      updateTryItContinuation(chatId, requestId, (saved) =>
        saved.status === 'completed'
          ? saved
          : { ...withoutTryItFailure(saved), status: 'setup-required' },
      );
      return;
    }
    // The host applies this resolution to its latest selections at the write
    // boundary, including edits made while an earlier write was pending.
    await ports.updateSelections(
      (selections): ChatTabPluginSelections => ({
        ...selections,
        unresolvedCapabilities: (
          selections.unresolvedCapabilities ?? []
        ).filter(
          (capability) => !sameTryItCapability(capability, recordCapability),
        ),
        mcpServerRefs: [
          ...(selections.mcpServerRefs ?? []).filter(
            (entry) => entry.serverId !== ref.serverId,
          ),
          ref,
        ],
      }),
      current,
    );
    if (!(await current())) return;
    settle();
  } catch {
    if (!(await current())) return;
    updateTryItContinuation(chatId, requestId, (saved) =>
      saved.status === 'completed'
        ? saved
        : { ...saved, status: 'failed', failure: 'send-failed' },
    );
  }
}
