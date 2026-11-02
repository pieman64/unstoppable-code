'use client';

import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

/** Highest priority first. Extend this list to introduce another tip kind. */
export const COMPOSER_TIP_PRIORITY = ['plan-mode'] as const;
export type ComposerTipKind = (typeof COMPOSER_TIP_PRIORITY)[number];

interface ComposerTipArbiter {
  subscribe: (listener: () => void) => () => void;
  claim: (id: string, kind: ComposerTipKind) => () => void;
  mayShow: (id: string, kind: ComposerTipKind) => boolean;
}

function createArbiter(): ComposerTipArbiter {
  const claims = new Map<string, ComposerTipKind>();
  const listeners = new Set<() => void>();
  const notify = (): void => listeners.forEach((listener) => listener());
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    claim(id: string, kind: ComposerTipKind): () => void {
      claims.set(id, kind);
      notify();
      return () => {
        claims.delete(id);
        notify();
      };
    },
    mayShow(id: string, kind: ComposerTipKind): boolean {
      // Wait for registration so sibling claims settle before presentation.
      return (
        claims.has(id) &&
        !Array.from(claims.values()).some(
          (claim) =>
            COMPOSER_TIP_PRIORITY.indexOf(claim) <
            COMPOSER_TIP_PRIORITY.indexOf(kind),
        )
      );
    },
  };
}

const ComposerTipContext = createContext<ComposerTipArbiter | null>(null);

/** Mount once around all tip claimants belonging to one composer. */
export function ComposerTipArbiterProvider({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  const [arbiter] = useState(createArbiter);
  return (
    <ComposerTipContext.Provider value={arbiter}>
      {children}
    </ComposerTipContext.Provider>
  );
}

const subscribeWithoutProvider = (): (() => void) => () => undefined;

/** The live check also guards presentation side effects in the commit claims change. */
export function useComposerTipClaim(
  kind: ComposerTipKind,
  wantsToShow: boolean,
): { visible: boolean; isVisible: () => boolean } {
  const arbiter = useContext(ComposerTipContext);
  const id = useId();
  useLayoutEffect(() => {
    if (wantsToShow) return arbiter?.claim(id, kind);
    return undefined;
  }, [arbiter, id, kind, wantsToShow]);
  const isVisible = useCallback(
    (): boolean =>
      wantsToShow && (arbiter === null || arbiter.mayShow(id, kind)),
    [arbiter, id, kind, wantsToShow],
  );
  const visible = useSyncExternalStore(
    arbiter?.subscribe ?? subscribeWithoutProvider,
    isVisible,
    () => wantsToShow && arbiter === null,
  );
  return { visible, isVisible };
}
