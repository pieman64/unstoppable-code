/**
 * Entry points into the subagent viewer from a root chat (D1, D2): Open chat
 * on agent cards and View tree in Agent activity.
 *
 * The chat's message list provides one stable value for its open, editable
 * root chat; read-only and detached viewers provide none, so their cards
 * render without Open chat. Cards read the context and build their own
 * memoized callback, so a card re-renders only when its own identity does.
 *
 * Deliberately light: the shared viewer UI (`@canopy/ui-app/subagents`) is
 * loaded on demand, never on the transcript's import path.
 */
import { createContext, useContext, useMemo } from 'react';
import type { SubagentChatTarget } from '@canopy/ui-shared';
import {
  openSubagentChatPanel,
  openSubagentsPanel,
} from '@/lib/panels/subagent-panel-open';
import { subagentScopeKey, type SubagentHostScope } from './subagent-scope';

export interface SubagentEntryActions {
  /** The root chat whose agent cards these actions open. */
  readonly rootChatId: string;
  /** Opens (or reveals) one subagent's chat panel. */
  readonly openSubagentChat: (target: SubagentChatTarget) => void;
  /** Selects the root chat in the Subagents panel and opens it. */
  readonly viewTree: () => void;
}

export const SubagentEntryActionsContext =
  createContext<SubagentEntryActions | null>(null);
SubagentEntryActionsContext.displayName = 'SubagentEntryActionsContext';

/** The nearest root chat's entry actions, or null in read-only views. */
export function useSubagentEntryActions(): SubagentEntryActions | null {
  return useContext(SubagentEntryActionsContext);
}

/**
 * A card's stable Open chat callback, or undefined where the viewer cannot
 * open (no provider, or no identity). Depends only on the card's own target.
 */
export function useSubagentOpenChatCallback(
  kind: SubagentChatTarget['kind'],
  id: string | undefined,
  title: string,
): (() => void) | undefined {
  const actions = useSubagentEntryActions();
  return useMemo(() => {
    if (!actions || id === undefined || id.length === 0) return undefined;
    return (): void => actions.openSubagentChat({ kind, id, title });
  }, [actions, id, kind, title]);
}

/** Builds the entry actions for one open root chat. */
export function createSubagentEntryActions(
  scope: SubagentHostScope,
  rootChatId: string,
): SubagentEntryActions {
  return {
    rootChatId,
    openSubagentChat: (target: SubagentChatTarget): void => {
      void openSubagentChatPanel(scope, {
        rootChatId,
        subagentId: target.id,
        subagentKind: target.kind,
        title: target.title,
      });
    },
    viewTree: (): void => {
      void import('@canopy/ui-app/subagents')
        .then(({ useSubagentViewStateStore }): void => {
          useSubagentViewStateStore
            .getState()
            .setSelectedRoot(subagentScopeKey(scope), rootChatId);
        })
        .catch((): void => undefined)
        .finally((): void => {
          void openSubagentsPanel(scope);
        });
    },
  };
}

/**
 * The stable provider value for one root chat, or null when the chat is
 * read-only, detached or not an open tab of the scope.
 */
export function useSubagentEntryActionsValue(
  scope: SubagentHostScope | null,
  rootChatId: string,
  enabled: boolean,
): SubagentEntryActions | null {
  const projectId = scope?.projectId;
  const worktreeId = scope?.worktreeId;
  return useMemo(
    () =>
      enabled && projectId !== undefined && worktreeId !== undefined
        ? createSubagentEntryActions({ projectId, worktreeId }, rootChatId)
        : null,
    [enabled, projectId, rootChatId, worktreeId],
  );
}
