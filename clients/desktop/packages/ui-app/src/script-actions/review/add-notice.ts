'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { CanopyClient } from '@canopy/app-core';
import type {
  ScriptActionsAddReceipt,
  ScriptActionsReceiptRequest,
} from '@canopy/protocol/script-actions';

/** Bound on how long an add flow waits for its scan receipt. */
export const SCRIPT_ACTIONS_RECEIPT_DEADLINE_MS = 60_000;
const INITIAL_DELAY_MS = 1_000;
const MAX_DELAY_MS = 8_000;

/** One post-add notice per completed operation that found pending scripts. */
export function shouldNotifyScriptActionsReceipt(
  receipt: ScriptActionsAddReceipt | null,
): receipt is ScriptActionsAddReceipt {
  return (
    receipt !== null &&
    receipt.status === 'complete' &&
    receipt.pendingCount > 0
  );
}

/**
 * Remembers operation IDs that already produced a notice, so a duplicate
 * delivery (a replayed event, a second poll) never toasts twice. Bounded so a
 * long session does not grow it without limit.
 */
export function createScriptActionsNoticeDeduper(
  limit = 200,
): (operationId: string) => boolean {
  const seen = new Set<string>();
  return (operationId: string): boolean => {
    if (seen.has(operationId)) return false;
    seen.add(operationId);
    if (seen.size > limit) {
      const oldest = seen.values().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    return true;
  };
}

function abortableSleep(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done);
  });
}

export interface PollScriptActionsReceiptOptions {
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
  readonly now?: () => number;
}

/**
 * Polls `scriptActions.receipt` with exponential backoff (1s, 2s, 4s, then
 * every 8s) until the scan completes or fails, the deadline passes, or the
 * signal aborts. Resolves to the settled receipt, or null when there is
 * nothing to report. A failed request is retried until the deadline.
 */
export async function pollScriptActionsReceipt(
  client: CanopyClient,
  request: ScriptActionsReceiptRequest,
  {
    signal,
    deadlineMs = SCRIPT_ACTIONS_RECEIPT_DEADLINE_MS,
    now = Date.now,
  }: PollScriptActionsReceiptOptions = {},
): Promise<ScriptActionsAddReceipt | null> {
  const deadline = now() + deadlineMs;
  let delay = INITIAL_DELAY_MS;
  for (;;) {
    if (signal?.aborted) return null;
    let receipt: ScriptActionsAddReceipt | null = null;
    try {
      receipt = await client.query('scriptActions.receipt', request);
    } catch {
      receipt = null;
    }
    if (signal?.aborted) return null;
    if (receipt !== null && receipt.status !== 'scanning') return receipt;
    if (now() + delay > deadline) return null;
    await abortableSleep(delay, signal);
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  }
}

export interface ScriptActionsAddNoticeRequest extends ScriptActionsReceiptRequest {
  /** Repository or project name for the notice copy. */
  readonly targetName: string | null;
}

export interface ScriptActionsAddNotice {
  readonly receipt: ScriptActionsAddReceipt;
  readonly targetName: string | null;
}

export interface UseScriptActionsAddNoticesOptions {
  /** The client the add ran through; null disables tracking. */
  readonly client: CanopyClient | null;
  /** Changing it cancels every poll, for example on a target switch. */
  readonly scopeKey?: string;
  readonly onNotice: (notice: ScriptActionsAddNotice) => void;
}

/**
 * For hosts without a found event (Portal): `track` an add operation's
 * receipt and report one notice when its scan completes with pending
 * scripts. Polls stop on unmount and scope changes; timeouts and failed
 * scans report nothing.
 */
export function useScriptActionsAddNotices({
  client,
  scopeKey = '',
  onNotice,
}: UseScriptActionsAddNoticesOptions): (
  request: ScriptActionsAddNoticeRequest,
) => void {
  const onNoticeRef = useRef(onNotice);
  useEffect(() => {
    onNoticeRef.current = onNotice;
  });
  const controllers = useRef(new Set<AbortController>());
  const deduper = useRef(createScriptActionsNoticeDeduper());

  useEffect(() => {
    const active = controllers.current;
    return (): void => {
      for (const controller of active) controller.abort();
      active.clear();
    };
  }, [client, scopeKey]);

  return useCallback(
    (request: ScriptActionsAddNoticeRequest): void => {
      if (client === null || client.capabilities.scriptActions !== true) return;
      const controller = new AbortController();
      controllers.current.add(controller);
      const { targetName, ...receiptRequest } = request;
      void pollScriptActionsReceipt(client, receiptRequest, {
        signal: controller.signal,
      }).then((receipt) => {
        controllers.current.delete(controller);
        if (controller.signal.aborted) return;
        if (!shouldNotifyScriptActionsReceipt(receipt)) return;
        if (!deduper.current(receipt.operationId)) return;
        onNoticeRef.current({ receipt, targetName });
      });
    },
    [client],
  );
}
