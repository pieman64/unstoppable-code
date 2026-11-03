'use client';

import { createContext, useContext, type JSX, type ReactNode } from 'react';
import type {
  LabsExperimentRowView,
  LabsExperimentsSectionLayout,
} from '@canopy/ui-shared/components';

/**
 * What a host gives the shared Labs section: the rows it lists, the save
 * error to show, how to save a choice and, optionally, its own settings
 * layout kit. Desktop fills it from main's Labs snapshot, so main stays the
 * only evaluator and writer there; web fills it from the account settings
 * operations. The section never knows which host it is in.
 */
export interface LabsSettingsPort {
  readonly rows: readonly LabsExperimentRowView[];
  readonly error: string | null;
  /** The save error's raw reason: copied by `Copy details`, never shown. */
  readonly errorDetails?: string;
  readonly onToggle: (experimentId: string, enabled: boolean) => void;
  /** The host's own section/group/row kit; the card kit when absent. */
  readonly layout?: LabsExperimentsSectionLayout;
}

const LabsSettingsPortContext = createContext<LabsSettingsPort | null>(null);

export function LabsSettingsPortProvider({
  value,
  children,
}: {
  readonly value: LabsSettingsPort;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <LabsSettingsPortContext.Provider value={value}>
      {children}
    </LabsSettingsPortContext.Provider>
  );
}

export function useLabsSettingsPort(): LabsSettingsPort | null {
  return useContext(LabsSettingsPortContext);
}
