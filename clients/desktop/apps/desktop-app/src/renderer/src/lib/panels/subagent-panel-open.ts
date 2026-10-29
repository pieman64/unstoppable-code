/** Open or reveal the Subagents singleton and bound subagent-chat panels. */
import { isSubagentChatPanelInstance } from '@canopy/protocol';
import type { SubagentChatKind } from '@canopy/agent-transcript';
import {
  findPanelByInstanceKey,
  getPanelInstanceKey,
  makeWorktreePanelKey,
  type PanelInstanceLocation,
} from '@/stores/panelLayoutStore';
import {
  openContentPanel,
  type ContentPanelIntent,
  type ContentPanelOpenResult,
  type ContentPanelOrigin,
} from './chat-panel-sync';
import {
  subagentChatPanelInstanceKey,
  subagentChatPanelSeed,
  subagentsPanelSeed,
} from './subagent-panel-identity';
import type {
  SubagentChatPanelIdentity,
  SubagentChatPanelTarget,
} from './subagent-panel-identity';

export interface SubagentPanelScope {
  readonly projectId: string;
  readonly worktreeId: string;
}

/**
 * `auto` places content beside its origin chat or by the shared auto policy;
 * a group intent targets one group, including an auxiliary layout when named.
 * Existing panels are revealed where they live for either intent.
 */
export type SubagentPanelIntent =
  | 'auto'
  | { readonly groupId: string; readonly layoutKey?: string };

export interface OpenSubagentPanelOptions {
  readonly intent?: SubagentPanelIntent;
  readonly origin?: ContentPanelOrigin;
}

const FAILED: ContentPanelOpenResult = { status: 'failed' };

function worktreeKeyOf(scope: SubagentPanelScope): string {
  return makeWorktreePanelKey(scope.projectId, scope.worktreeId);
}

function toContentIntent(
  intent: SubagentPanelIntent | undefined,
): ContentPanelIntent {
  if (intent === undefined || intent === 'auto') return { kind: 'auto' };
  return intent.layoutKey === undefined
    ? { kind: 'group', groupId: intent.groupId }
    : { kind: 'group', groupId: intent.groupId, layoutKey: intent.layoutKey };
}

/** Find the worktree's Subagents singleton in its main or auxiliary layout. */
export function findSubagentsPanel(
  scope: SubagentPanelScope,
): PanelInstanceLocation | null {
  return findPanelByInstanceKey(
    worktreeKeyOf(scope),
    getPanelInstanceKey({ kind: 'subagents', instance: undefined }),
  );
}

/** Find a subagent chat by its root-chat/subagent pair anywhere in the family. */
export function findSubagentChatPanel(
  scope: SubagentPanelScope,
  target: SubagentChatPanelIdentity,
): PanelInstanceLocation | null {
  return findPanelByInstanceKey(
    worktreeKeyOf(scope),
    subagentChatPanelInstanceKey(target),
  );
}

/**
 * Open the worktree's Subagents singleton, or reveal it wherever it already
 * lives in the layout family. It is never moved to the requested group.
 */
export function openSubagentsPanel(
  scope: SubagentPanelScope,
  options: OpenSubagentPanelOptions = {},
): Promise<ContentPanelOpenResult> {
  const intent = toContentIntent(options.intent);
  return openContentPanel(
    worktreeKeyOf(scope),
    subagentsPanelSeed(),
    options.origin === undefined
      ? { intent }
      : { intent, origin: options.origin },
  );
}

/**
 * Open one bound subagent chat, or reveal the same `(rootChatId,
 * subagentId)` panel wherever it already lives in the worktree's layout
 * family. Invalid bindings fail before the layout store is consulted.
 */
export function openSubagentChatPanel(
  scope: SubagentPanelScope,
  target: {
    readonly rootChatId: string;
    readonly subagentId: string;
    readonly subagentKind: SubagentChatKind;
    readonly title: string;
  },
  options: OpenSubagentPanelOptions = {},
): Promise<ContentPanelOpenResult> {
  const instance = {
    rootChatId: target.rootChatId,
    subagentId: target.subagentId,
    subagentKind: target.subagentKind,
  };
  if (!isSubagentChatPanelInstance(instance)) return Promise.resolve(FAILED);

  const origin = options.origin ?? { chatTabId: target.rootChatId };
  const openOptions = {
    intent: toContentIntent(options.intent),
    origin,
  };
  const seed: SubagentChatPanelTarget = {
    rootChatId: instance.rootChatId,
    subagentId: instance.subagentId,
    subagentKind: instance.subagentKind,
    title: target.title,
  };
  return openContentPanel(worktreeKeyOf(scope), subagentChatPanelSeed(seed), {
    ...openOptions,
  });
}
