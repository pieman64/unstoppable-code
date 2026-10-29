'use client';

import {
  createContext,
  useContext,
  type ComponentType,
  type JSX,
  type ReactNode,
} from 'react';
import type { ExplorerTranscriptMessage } from '@canopy/protocol/settings/organization-memory';

export interface MemoryTranscriptMessageProps {
  readonly message: ExplorerTranscriptMessage;
}

/**
 * Host-supplied pieces the shared Memory pages render inline. Every slot is
 * optional: a missing slot renders the shared fallback, never a host fork.
 */
export interface MemorySettingsSlots {
  /**
   * Renders one source-transcript message. Web supplies the Portal chat
   * message renderer; without it the message text renders as Markdown.
   */
  readonly TranscriptMessage?: ComponentType<MemoryTranscriptMessageProps>;
}

const NO_SLOTS: MemorySettingsSlots = {};

const MemorySettingsSlotsContext = createContext<MemorySettingsSlots>(NO_SLOTS);

export interface MemorySettingsSlotsProviderProps {
  readonly slots: MemorySettingsSlots;
  readonly children: ReactNode;
}

export function MemorySettingsSlotsProvider({
  slots,
  children,
}: MemorySettingsSlotsProviderProps): JSX.Element {
  return (
    <MemorySettingsSlotsContext.Provider value={slots}>
      {children}
    </MemorySettingsSlotsContext.Provider>
  );
}

export function useMemorySettingsSlots(): MemorySettingsSlots {
  return useContext(MemorySettingsSlotsContext);
}
