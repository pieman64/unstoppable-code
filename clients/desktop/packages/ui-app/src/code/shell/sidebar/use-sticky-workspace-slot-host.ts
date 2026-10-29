'use client';

import { useLayoutEffect, useState } from 'react';
import { SIDEBAR_ROOT_SELECTOR } from './sidebar-surfaces';
import {
  findStickyWorkspaceSlotHost,
  STICKY_WORKSPACE_SLOT_SELECTOR,
} from './sticky-workspace-slot';

/**
 * Resolves the rail's sticky-slot seat for a workspace and keeps resolving
 * until it exists.
 *
 * The shared surface seats its slot rows only after it has located the
 * rail's slot container, which is a commit after the workspace rows mount, so
 * a one-shot lookup from a row's own mount effect can run before its seat
 * is there and leave the pinned header copy unmounted for good. When the
 * first lookup misses, the rail's sticky band is watched until the seat
 * appears.
 */
export function useStickyWorkspaceSlotHost(
  anchor: HTMLElement | null,
  workspaceId: string,
): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const found = findStickyWorkspaceSlotHost(anchor, workspaceId);
    setHost(found);
    if (found !== null || anchor === null) return undefined;
    // Only the desktop rail can ever seat this row. A host without that rail
    // (the web portal) gets no observer at all, and the rail is watched
    // through its sticky band once the band exists, never the whole document.
    const rail = anchor.closest<HTMLElement>(SIDEBAR_ROOT_SELECTOR);
    if (rail === null) return undefined;
    const scope =
      rail.querySelector<HTMLElement>(STICKY_WORKSPACE_SLOT_SELECTOR) ?? rail;
    const observer = new MutationObserver((): void => {
      const next = findStickyWorkspaceSlotHost(anchor, workspaceId);
      if (next === null) return;
      observer.disconnect();
      setHost(next);
    });
    observer.observe(scope, { childList: true, subtree: true });
    return (): void => observer.disconnect();
  }, [anchor, workspaceId]);
  return host;
}
