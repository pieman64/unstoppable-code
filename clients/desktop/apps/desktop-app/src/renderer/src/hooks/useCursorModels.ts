import { useEffect, useSyncExternalStore } from 'react';
import type { CursorModelEntry } from '@canopy/desktop-shared/types';
import { EMPTY_CURSOR_MODELS, getCursorModelCache } from './cursor-model-cache';

const emptySnapshot = (): typeof EMPTY_CURSOR_MODELS => EMPTY_CURSOR_MODELS;
const noSubscription = (): (() => void) => (): void => {};

/** Opening an eligible picker refreshes a shared last-good catalog. */
export function useCursorModels(
  available: boolean,
  open: boolean,
): { models: CursorModelEntry[]; message: string | undefined } {
  const cache = available ? getCursorModelCache(window.api) : undefined;
  const snapshot = useSyncExternalStore(
    cache?.subscribe ?? noSubscription,
    cache?.getSnapshot ?? emptySnapshot,
  );
  useEffect(() => {
    if (open) cache?.refresh();
  }, [cache, open, snapshot.generation]);
  return { models: snapshot.models, message: snapshot.message };
}
