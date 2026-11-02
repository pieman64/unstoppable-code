import type { AttentionLanding } from './attention-landing';

/** Transient navigation intent. Identity distinguishes A → B → A entries. */
export interface WorktreeEntryIntent {
  readonly key: string;
  readonly attentionLanding: boolean;
  explicitTabId?: string;
  settled: boolean;
  landedTabId?: string;
}

let currentEntry: WorktreeEntryIntent | null = null;
let panelTarget: { readonly key: string; readonly chatId: string } | null =
  null;

export function beginWorktreeEntry(
  key: string,
  attentionLanding: boolean,
): void {
  currentEntry = { key, attentionLanding, settled: false };
  panelTarget = null;
}

export function cancelWorktreeEntry(): void {
  currentEntry = null;
  panelTarget = null;
}

export function getWorktreeEntry(key: string): WorktreeEntryIntent | null {
  return currentEntry?.key === key ? currentEntry : null;
}

export function isCurrentWorktreeEntry(
  intent: WorktreeEntryIntent | null,
): intent is WorktreeEntryIntent {
  return intent !== null && currentEntry === intent && !intent.settled;
}

export function hasPendingAttentionLanding(key: string): boolean {
  const entry = getWorktreeEntry(key);
  return (
    entry !== null &&
    !entry.settled &&
    entry.attentionLanding &&
    entry.explicitTabId === undefined
  );
}

export function recordExplicitEntryTab(key: string, tabId: string): void {
  const entry = getWorktreeEntry(key);
  if (entry) {
    entry.explicitTabId = tabId;
    entry.landedTabId = undefined;
  }
  if (panelTarget?.key === key) panelTarget = null;
}

/**
 * Settles an entry with its landing. The entry shows the landed tab, else
 * `activeTabId`. Only a landing with an attention target claims the first
 * panel sweep to reveal its chat group; a quiet worktree restores its saved
 * panel selection (a Browser group, say).
 */
export function settleWorktreeEntry(
  entry: WorktreeEntryIntent,
  activeTabId: string,
  landing: AttentionLanding,
): void {
  entry.settled = true;
  if (entry.attentionLanding && entry.explicitTabId === undefined) {
    const shownTabId = landing.tabId ?? activeTabId;
    entry.landedTabId = shownTabId;
    if (landing.attended) {
      panelTarget = { key: entry.key, chatId: shownTabId };
    }
  }
}

/** Viewing an automatically selected chat acknowledges read state only. */
export function preservesLandedAttention(key: string, chatId: string): boolean {
  return getWorktreeEntry(key)?.landedTabId === chatId;
}

/** A first panel sweep must reveal the landed chat's group as well as its tab. */
export function takeAttentionLandingPanelTarget(
  key: string,
  chatId: string,
): boolean {
  if (panelTarget?.key !== key || panelTarget.chatId !== chatId) return false;
  panelTarget = null;
  return true;
}
