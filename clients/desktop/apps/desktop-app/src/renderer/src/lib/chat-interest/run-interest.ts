/**
 * Tracks the delegate runs whose cards are mounted and expanded in this
 * renderer. Multiple cards can share one run identity, so declarations keep
 * the run until the final card releases it.
 */
import { useEffect } from 'react';
import type { ChatInterestRunRef } from '@canopy/desktop-shared/types';

export interface RunInterestRegistry {
  /** Register one card's interest and return its idempotent release. */
  readonly register: (ref: ChatInterestRunRef) => () => void;
  /** The distinct registered runs, copied and in deterministic order. */
  readonly list: () => readonly ChatInterestRunRef[];
  /** Subscribe to distinct-run set changes, not reference-count changes. */
  readonly subscribe: (listener: () => void) => () => void;
}

function runIdentity(ref: ChatInterestRunRef): string {
  return JSON.stringify([
    ref.projectId,
    ref.worktreeId,
    ref.chatId,
    ref.delegationId,
    ref.runGeneration,
  ]);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareRunRefs(
  left: ChatInterestRunRef,
  right: ChatInterestRunRef,
): number {
  return (
    compareStrings(left.projectId, right.projectId) ||
    compareStrings(left.worktreeId, right.worktreeId) ||
    compareStrings(left.chatId, right.chatId) ||
    compareStrings(left.delegationId, right.delegationId) ||
    left.runGeneration - right.runGeneration
  );
}

export function createRunInterestRegistry(): RunInterestRegistry {
  const registered = new Map<
    string,
    { readonly ref: ChatInterestRunRef; count: number }
  >();
  const listeners = new Set<() => void>();

  const notify = (): void => {
    listeners.forEach((listener) => listener());
  };

  return {
    register: (ref): (() => void) => {
      const key = runIdentity(ref);
      const current = registered.get(key);
      if (current) {
        current.count += 1;
      } else {
        registered.set(key, { ref: { ...ref }, count: 1 });
        notify();
      }

      let released = false;
      return (): void => {
        if (released) return;
        released = true;

        const entry = registered.get(key);
        if (!entry) return;
        if (entry.count > 1) {
          entry.count -= 1;
          return;
        }
        registered.delete(key);
        notify();
      };
    },
    list: (): readonly ChatInterestRunRef[] => {
      const refs: ChatInterestRunRef[] = [];
      registered.forEach(({ ref }) => refs.push({ ...ref }));
      return refs.sort(compareRunRefs);
    },
    subscribe: (listener): (() => void) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
  };
}

/** Shared by every chat interest tracker in this renderer. */
export const expandedRunRegistry: RunInterestRegistry =
  createRunInterestRegistry();

/** Register a mounted expanded card in this renderer's shared registry. */
export function registerExpandedRun(ref: ChatInterestRunRef): () => void {
  return expandedRunRegistry.register(ref);
}

/** Register the expanded run for this card, releasing it on every exit. */
export function useExpandedRunInterest(
  ref: ChatInterestRunRef | null,
  expanded: boolean,
): void {
  const projectId = ref?.projectId ?? null;
  const worktreeId = ref?.worktreeId ?? null;
  const chatId = ref?.chatId ?? null;
  const delegationId = ref?.delegationId ?? null;
  const runGeneration = ref?.runGeneration ?? null;

  useEffect((): (() => void) | undefined => {
    if (
      !expanded ||
      projectId === null ||
      worktreeId === null ||
      chatId === null ||
      delegationId === null ||
      runGeneration === null
    ) {
      return undefined;
    }

    return registerExpandedRun({
      projectId,
      worktreeId,
      chatId,
      delegationId,
      runGeneration,
    });
  }, [chatId, delegationId, expanded, projectId, runGeneration, worktreeId]);
}
