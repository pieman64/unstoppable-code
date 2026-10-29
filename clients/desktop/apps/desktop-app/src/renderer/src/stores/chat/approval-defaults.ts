// Shared helper for stamping a freshly created chat tab with its resolved
// approval-mode default. Kept out of tab-lifecycle.ts/messaging.ts so both
// can call it without a circular import.
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type ApprovalMode,
  type WorktreeSelection,
} from '@canopy/desktop-shared/types';
import { worktreeKey } from './utils';
import type { ChatState } from './state';

type ChatSet = (
  partial:
    | ChatState
    | Partial<ChatState>
    | ((state: ChatState) => ChatState | Partial<ChatState>),
) => void;
type ChatGet = () => ChatState;

let approvalDefaultsGeneration = 0;
const approvalDefaultsGenerationListeners = new Set<() => void>();

export function getApprovalDefaultsGeneration(): number {
  return approvalDefaultsGeneration;
}

export function subscribeApprovalDefaultsGeneration(
  listener: () => void,
): () => void {
  approvalDefaultsGenerationListeners.add(listener);
  return (): void => {
    approvalDefaultsGenerationListeners.delete(listener);
  };
}

export function invalidateApprovalDefaults(): void {
  approvalDefaultsGeneration += 1;
  approvalDefaultsGenerationListeners.forEach((listener) => listener());
}

export function approvalDefaultCacheKey(
  projectId: string,
  worktreeId?: string,
): string {
  if (
    worktreeId &&
    (projectId === CODE_REVIEW_CHAT_PROJECT_ID ||
      projectId === PLAN_EXPLORE_CHAT_PROJECT_ID ||
      projectId === STANDALONE_CHAT_PROJECT_ID)
  ) {
    return `${projectId}/${worktreeId}`;
  }
  return projectId;
}

/**
 * Resolves the default (`ChatApprovalsSlice.fetchApprovalDefault`) for a
 * just-created tab and stamps `approvalMode` onto
 * that tab — but only if nothing else (the user via the picker, or a
 * faster-resolving concurrent lookup) has set an explicit mode in the
 * meantime. The returned mode is the tab's latest explicit value, so callers
 * that commit canonical tab creation can persist the resolved default (or a
 * user choice that won the race) atomically with the new tab.
 *
 * Explicit tab creation stays synchronous and can use a cached value while a
 * fresh lookup is pending. Initial starter-tab creation resolves this helper's
 * source before exposing the tab, so its first rendered mode is authoritative.
 */
export async function applyResolvedApprovalModeForNewTab(
  sel: WorktreeSelection,
  chatId: string,
  set: ChatSet,
  get: ChatGet,
): Promise<ApprovalMode | undefined> {
  const key = worktreeKey(sel);
  const existingTab = get().worktreeChats[key]?.tabs.find(
    (entry) => entry.id === chatId,
  );
  if (existingTab?.kind !== 'file' && existingTab?.approvalMode !== undefined) {
    return existingTab.approvalMode;
  }

  // Tab creation is a durability boundary, so confirm the current main-owned
  // default instead of trusting a cache that may have been warmed while a
  // Settings preference update was still in flight. A forced request also
  // supersedes any older in-flight lookup for this scope, preventing that
  // older response from replacing the creation-time result.
  const mode = await get().fetchApprovalDefault(sel.projectId, sel.worktreeId, {
    forceFresh: true,
  });
  set((state) => {
    const wc = state.worktreeChats[key];
    if (!wc) return state;
    const tab = wc.tabs.find((t) => t.id === chatId);
    if (!tab || tab.kind === 'file' || tab.approvalMode !== undefined) {
      return state;
    }
    const updatedTabs = wc.tabs.map((t) =>
      t.id === chatId ? { ...t, approvalMode: mode } : t,
    );
    const updated = { ...wc, tabs: updatedTabs };
    return { worktreeChats: { ...state.worktreeChats, [key]: updated } };
  });
  const tab = get().worktreeChats[key]?.tabs.find(
    (entry) => entry.id === chatId,
  );
  return tab?.kind === 'file' ? undefined : tab?.approvalMode;
}
