'use client';

import { createContext, useContext, type JSX, type ReactNode } from 'react';
import type {
  ClaudeModPluginDetailsTarget,
  ClaudeModsChatContext,
} from '@canopy/protocol/claude-mods';

/**
 * What a transcript host supplies to its skipped-Mod notices: the chat they
 * belong to and how it opens a plugin's details page. Either may be absent;
 * the notice then leaves out what needs it.
 */
export interface ClaudeModsSkippedHost {
  readonly context?: ClaudeModsChatContext;
  readonly onOpenDetails?: (details: ClaudeModPluginDetailsTarget) => void;
}

const ClaudeModsSkippedHostContext =
  createContext<ClaudeModsSkippedHost | null>(null);

export function ClaudeModsSkippedHostProvider({
  value,
  children,
}: {
  readonly value: ClaudeModsSkippedHost | null;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <ClaudeModsSkippedHostContext.Provider value={value}>
      {children}
    </ClaudeModsSkippedHostContext.Provider>
  );
}

/** The surrounding host's notice wiring, or null when none is provided. */
export function useClaudeModsSkippedHost(): ClaudeModsSkippedHost | null {
  return useContext(ClaudeModsSkippedHostContext);
}
