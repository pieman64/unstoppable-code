import {
  tryItAccountMcpSelection,
  sameTryItCapability,
  TRY_IT_AUTH_INTENT_TTL_MS,
} from '@canopy/protocol/try-it/continuation';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type { AccountMcpConnectionSummary } from '@canopy/desktop-shared/types/mcp-servers';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { TryItContinueChatRequest } from './tryItChat';
import {
  readTryItContinuation,
  readTryItContinuationRaw,
  updateTryItContinuation,
  withoutTryItFailure,
  settleTryItContinuationReceipt,
  type DesktopTryItContinuation,
} from './tryItContinuation';
import type {
  TryItSendReceiptRead,
  TryItSendReceiptRequest,
} from './tryItSendReceipt';

export interface DesktopTryItRunnerPorts {
  accountKey: () => Promise<string | null>;
  selections: () => ChatTabPluginSelections | null;
  connections: () => Promise<AccountMcpConnectionSummary[]>;
  updateSelections: (
    selections: ChatTabPluginSelections,
    canContinue: () => Promise<boolean>,
  ) => Promise<void>;
  continueChat: (request: TryItContinueChatRequest) => Promise<void>;
  rebind: (record: DesktopTryItContinuation, accountKey: string) => void;
  /**
   * Main's durable receipt for this continuation's command (CAN-4404), read
   * at the same location the continuation dispatches to.
   */
  receipt: (request: TryItSendReceiptRequest) => Promise<TryItSendReceiptRead>;
}

const running = new Map<
  string,
  { promise: Promise<void>; signal: AbortSignal }
>();

/**
 * Only states whose transition proves dispatch never began. Every other
 * eligible state, including a broad `send-failed`, may have reached main.
 */
function knownNotDispatched(record: DesktopTryItContinuation): boolean {
  return (
    record.status === 'pending' ||
    (record.status === 'failed' &&
      (record.failure === 'authentication-cancelled' ||
        record.failure === 'authentication-failed'))
  );
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
  // The receipt read and any replay share exactly this scope.
  const location = {
    projectId: record.host.projectId,
    worktreeId: record.host.worktreeId,
  };
  let expectedRaw = JSON.stringify(record);
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
  const possiblyDispatched = !knownNotDispatched(record);
  // Settle only for the account this run bound, never one observed later.
  const settle = (): void => {
    settleTryItContinuationReceipt({ accountKey, chatId, requestId });
  };
  const fail = (failure: 'send-failed' | 'acceptance-uncertain'): void => {
    updateTryItContinuation(chatId, requestId, (saved) =>
      saved.status === 'completed'
        ? saved
        : { ...saved, status: 'failed', failure },
    );
  };
  const readReceipt = async (): Promise<TryItSendReceiptRead> => {
    try {
      return await ports.receipt({ location, chatId, requestId });
    } catch {
      return 'unknown';
    }
  };
  let dispatchStarted = false;
  try {
    ports.rebind(record, accountKey);
    // Durable acceptance is checked before any connection lookup or send, so
    // a lost response followed by a refresh resolves without another turn.
    const receipt = await readReceipt();
    if (!(await current())) return;
    if (receipt === 'accepted') {
      settle();
      return;
    }
    // A conflicting or non-accepting receipt cannot confirm this turn, and
    // never licenses a send under another ID.
    if (receipt === 'not-accepted') {
      fail('send-failed');
      return;
    }
    if (receipt === 'unknown' && possiblyDispatched) {
      fail('acceptance-uncertain');
      return;
    }
    // `missing` is only an observation: a replay reuses the exact scope,
    // command and request IDs, so main's in-flight join and durable dedupe
    // absorb a send that commits after the read.
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
    // Read the latest selections after the asynchronous account check above,
    // so an edit made during that check cannot be overwritten by this target.
    const selections = ports.selections();
    if (!selections) return;
    const next: ChatTabPluginSelections = {
      ...selections,
      unresolvedCapabilities: (selections.unresolvedCapabilities ?? []).filter(
        (capability) => !sameTryItCapability(capability, recordCapability),
      ),
      mcpServerRefs: [
        ...(selections.mcpServerRefs ?? []).filter(
          (entry) => entry.serverId !== ref.serverId,
        ),
        ref,
      ],
    };
    await ports.updateSelections(next, current);
    if (!(await current())) return;
    const sending = updateTryItContinuation(chatId, requestId, (saved) => ({
      ...withoutTryItFailure(saved),
      status: 'sending',
    }));
    if (!sending?.host) return;
    expectedRaw = JSON.stringify(sending);
    if (!(await current())) return;
    dispatchStarted = true;
    await ports.continueChat({
      location,
      chatId,
      requestId,
      message: sending.prompt,
      pluginSelections: next,
      ...(sending.host.model ? { model: sending.host.model } : {}),
      canContinue: current,
    });
    if (!(await current())) return;
    settleTryItContinuationReceipt({ accountKey, chatId, requestId });
  } catch {
    if (!(await current())) return;
    if (dispatchStarted) {
      // The send may have committed before its response was lost. Settle
      // only on durable evidence; anything else stays uncertain.
      const after = await readReceipt();
      if (!(await current())) return;
      if (after === 'accepted') {
        settle();
        return;
      }
    }
    updateTryItContinuation(chatId, requestId, (saved) =>
      saved.status === 'completed'
        ? saved
        : {
            ...saved,
            status: 'failed',
            failure:
              saved.status === 'sending' ||
              saved.failure === 'acceptance-uncertain'
                ? 'acceptance-uncertain'
                : 'send-failed',
          },
    );
  }
}
