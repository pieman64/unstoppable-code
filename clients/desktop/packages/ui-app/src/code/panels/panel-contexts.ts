'use client';

import { createContext, useContext } from 'react';

export type WorktreeViewMode = 'list' | 'kanban';

export interface PanelHostState {
  readonly viewMode: WorktreeViewMode;
  readonly viewModeReady: boolean;
  /**
   * Whether the page-level host containing this grid is currently visible.
   * Panel visibility alone is insufficient for native window-bound content:
   * the main worktree grid deliberately stays mounted while app navigation,
   * settings, and page-like overlays hide it.
   */
  readonly visible?: boolean;
  /** Opens the workspace settings modal on a given tab (page-shell owned). */
  readonly onOpenSettingsTab?: (tab: 'scripts' | 'hooks') => void;
}

export const DEFAULT_PANEL_HOST_STATE: PanelHostState = {
  viewMode: 'list',
  viewModeReady: true,
};

export const PanelHostContext = createContext<PanelHostState>(
  DEFAULT_PANEL_HOST_STATE,
);

export function usePanelHostState(): PanelHostState {
  return useContext(PanelHostContext);
}

const auxHostStates = new WeakMap<PanelHostState, PanelHostState>();

/**
 * The host state an auxiliary (popped-out) window's layout presents to its
 * panels. An auxiliary window is its own page: it shows its grid for as long
 * as it is open, so it must not inherit the main page's `visible` (the main
 * window leaving its worktree view, or a page-like overlay covering it, says
 * nothing about another window). Window minimization is document visibility,
 * which content observes on its own owner document.
 *
 * Every other field is shared with the main host. The derived object is
 * cached per input, so context consumers see a stable identity.
 */
export function auxPanelHostState(hostState: PanelHostState): PanelHostState {
  if (hostState.visible !== false) return hostState;
  const cached = auxHostStates.get(hostState);
  if (cached !== undefined) return cached;
  const derived: PanelHostState = { ...hostState, visible: true };
  auxHostStates.set(hostState, derived);
  return derived;
}

/**
 * Whether the panel tab containing this content is the shown tab of its
 * group. The grid keeps every tab's content mounted, so a surface that must
 * not act while hidden (a find-bar registration) reads this rather than
 * assuming an unmount. `PanelContentRoot` provides it per tab; content
 * rendered outside a grid counts as shown.
 */
export const PanelVisibilityContext = createContext<boolean>(true);

export function usePanelVisible(): boolean {
  return useContext(PanelVisibilityContext);
}

export interface PanelWorktreeSelection {
  readonly projectId: string;
  readonly worktreeId: string;
}

export const PanelWorktreeContext = createContext<
  PanelWorktreeSelection | null | undefined
>(undefined);

export function usePanelWorktreeSelection():
  | PanelWorktreeSelection
  | null
  | undefined {
  return useContext(PanelWorktreeContext);
}

export function worktreeSelectionFromPanelOwnerKey(
  ownerKey: string,
): PanelWorktreeSelection | null {
  const separator = ownerKey.indexOf('/');
  if (separator <= 0 || separator === ownerKey.length - 1) return null;
  return {
    projectId: ownerKey.slice(0, separator),
    worktreeId: ownerKey.slice(separator + 1),
  };
}

export interface PanelPlacement {
  readonly layoutKey: string;
  readonly groupId: string;
}

export const PanelPlacementContext = createContext<PanelPlacement | null>(null);

export function usePanelPlacement(): PanelPlacement | null {
  return useContext(PanelPlacementContext);
}
