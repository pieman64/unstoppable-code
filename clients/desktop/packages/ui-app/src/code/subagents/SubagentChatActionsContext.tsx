'use client';

import { createContext, useContext } from 'react';
import type { SubagentChatTarget } from '@canopy/ui-shared';

/**
 * Host actions the shared chat transcript offers on agent cards. Hosts that
 * can open a subagent's chat panel wrap their chat in
 * `SubagentChatActionsContext.Provider`; without it, cards render exactly as
 * before.
 */
export interface SubagentChatActions {
  /** Opens (or focuses) the subagent chat panel for one subagent (D1). */
  readonly onOpenSubagentChat?: (target: SubagentChatTarget) => void;
}

const NO_SUBAGENT_CHAT_ACTIONS: SubagentChatActions = {};

export const SubagentChatActionsContext = createContext<SubagentChatActions>(
  NO_SUBAGENT_CHAT_ACTIONS,
);
SubagentChatActionsContext.displayName = 'SubagentChatActionsContext';

/** Reads the nearest host's subagent chat actions, or none. */
export function useSubagentChatActions(): SubagentChatActions {
  return useContext(SubagentChatActionsContext);
}
