/**
 * Pure identity helpers for the worktree-wide Subagents view and an opened
 * subagent chat. The instance key, not the panel id, owns family-wide
 * uniqueness.
 */
import { clampPanelTitle, type SubagentKind } from '@canopy/protocol';
import { getPanelInstanceKey } from '@/stores/panelLayoutStore';
import type { ContentPanelSeed } from './chat-panel-sync';

export const SUBAGENTS_PANEL_TITLE = 'Subagents';
export const SUBAGENT_CHAT_PANEL_FALLBACK_TITLE = 'Subagent';
export const SUBAGENTS_PANEL_ID = 'panel-subagents';

export interface SubagentChatPanelTarget {
  readonly rootChatId: string;
  readonly subagentId: string;
  readonly subagentKind: SubagentKind;
  readonly title: string;
}

export interface SubagentChatPanelIdentity {
  readonly rootChatId: string;
  readonly subagentId: string;
}

/** Seed for the worktree singleton that lists a root chat's subagents. */
export function subagentsPanelSeed(): ContentPanelSeed {
  return {
    kind: 'subagents',
    panelId: SUBAGENTS_PANEL_ID,
    title: SUBAGENTS_PANEL_TITLE,
    instance: {},
  };
}

/**
 * Deterministic panel id for a subagent tab. Identity is the pair of binding
 * values, not this display-safe id; placement retries with a generated id if
 * sanitization or another panel has already claimed it.
 */
export function subagentChatPanelIdFor(
  rootChatId: string,
  subagentId: string,
): string {
  const safeIdentity = `${rootChatId}-${subagentId}`.replace(
    /[^A-Za-z0-9_-]/g,
    '_',
  );
  return `panel-subagent-chat-${safeIdentity}`;
}

/** The tab title for a subagent chat, trimmed and clamped to the wire limit. */
export function subagentChatPanelTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length === 0
    ? SUBAGENT_CHAT_PANEL_FALLBACK_TITLE
    : clampPanelTitle(trimmed);
}

/** Seed for one subagent chat tab. */
export function subagentChatPanelSeed(
  target: SubagentChatPanelTarget,
): ContentPanelSeed {
  return {
    kind: 'subagent-chat',
    panelId: subagentChatPanelIdFor(target.rootChatId, target.subagentId),
    title: subagentChatPanelTitle(target.title),
    instance: {
      rootChatId: target.rootChatId,
      subagentId: target.subagentId,
      subagentKind: target.subagentKind,
    },
  };
}

/** The layout store's family-wide identity key for a root-chat/subagent pair. */
export function subagentChatPanelInstanceKey(
  target: SubagentChatPanelIdentity,
): string {
  return getPanelInstanceKey({
    kind: 'subagent-chat',
    instance: {
      rootChatId: target.rootChatId,
      subagentId: target.subagentId,
    },
  });
}
