'use client';

import { useEffect, useRef } from 'react';

/** Who asked to open script review; review never opens on its own. */
export type ScriptActionsReviewSource =
  | 'composer'
  | 'toast'
  | 'settings'
  | 'app-advisor';

export interface ScriptActionsReviewOpenRequest {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly source: ScriptActionsReviewSource;
}

type Listener = (request: ScriptActionsReviewOpenRequest) => void;

const listeners = new Set<Listener>();

/**
 * Ask the mounted review host to open the review dialog. Returns false when no
 * host is mounted, so callers can fall back (for example to settings).
 */
export function requestScriptActionsReview(
  request: ScriptActionsReviewOpenRequest,
): boolean {
  if (listeners.size === 0) return false;
  for (const listener of [...listeners]) listener(request);
  return true;
}

/** Register the host that opens the review dialog. Mount one per window. */
export function useScriptActionsReviewRequests(
  handler: (request: ScriptActionsReviewOpenRequest) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    const listener: Listener = (request) => handlerRef.current(request);
    listeners.add(listener);
    return (): void => {
      listeners.delete(listener);
    };
  }, []);
}
