/**
 * In-progress answers for the composer question prompt, keyed by request id,
 * so a panel switch that unmounts the prompt does not restart the questions.
 *
 * A plain module map rather than a store: it is read only when a prompt mounts
 * or its request changes, so nothing needs to re-render when it changes. It is
 * never persisted because answers can be secret (password fields and `secret`
 * questions); a reload drops it. Entries are cleared on answer or skip, and the
 * map is capped so abandoned requests cannot accumulate for the session.
 */

import { useCallback, useSyncExternalStore } from 'react';

export interface QuestionPromptProgress {
  readonly step: number;
  readonly selections: ReadonlyMap<number, string[]>;
  readonly texts: ReadonlyMap<number, string>;
}

const MAX_ENTRIES = 32;

const progressByRequest = new Map<string, QuestionPromptProgress>();

export function readQuestionPromptProgress(
  requestId: string,
): QuestionPromptProgress | undefined {
  return progressByRequest.get(requestId);
}

export function saveQuestionPromptProgress(
  requestId: string,
  progress: QuestionPromptProgress,
): void {
  // Re-insert so the entry counts as the newest for eviction.
  progressByRequest.delete(requestId);
  progressByRequest.set(requestId, progress);
  while (progressByRequest.size > MAX_ENTRIES) {
    const oldest = progressByRequest.keys().next();
    if (oldest.done) break;
    progressByRequest.delete(oldest.value);
  }
}

export function clearQuestionPromptProgress(requestId: string): void {
  progressByRequest.delete(requestId);
  if (closedRequests.delete(requestId)) notifyClosedListeners();
}

// Requests whose prompt the person closed (x or Escape), so a composer that
// remounts keeps the question behind its chip until the chip reopens it.
const closedRequests = new Set<string>();
const closedListeners = new Set<() => void>();

function notifyClosedListeners(): void {
  closedListeners.forEach((listener) => listener());
}

function subscribeClosed(listener: () => void): () => void {
  closedListeners.add(listener);
  return (): void => {
    closedListeners.delete(listener);
  };
}

export function isQuestionPromptClosed(requestId: string): boolean {
  return closedRequests.has(requestId);
}

/** Whether the person closed this request's prompt; re-renders on change. */
export function useQuestionPromptClosed(
  requestId: string | undefined,
): boolean {
  const read = useCallback(
    (): boolean => requestId !== undefined && closedRequests.has(requestId),
    [requestId],
  );
  return useSyncExternalStore(subscribeClosed, read, read);
}

export function setQuestionPromptClosed(
  requestId: string,
  closed: boolean,
): void {
  closedRequests.delete(requestId);
  if (closed) {
    closedRequests.add(requestId);
    while (closedRequests.size > MAX_ENTRIES) {
      const oldest = closedRequests.values().next();
      if (oldest.done) break;
      closedRequests.delete(oldest.value);
    }
  }
  notifyClosedListeners();
}
