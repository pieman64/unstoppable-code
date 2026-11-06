'use client';

import { createContext, useContext, type JSX, type ReactNode } from 'react';
import type { InstalledItemSnapshotState } from '@canopy/ui-shared/lib';

/** Where a Settings page hands off to: Installed filtered to Active, or MCP. */
export type CustomizeSettingsTarget = 'active' | 'mcp';

/**
 * What a host gives the shared Plugins and MCP servers sections. Customize is
 * the only place that edits status, so a host supplies a read and a hand-off:
 * desktop reads main's snapshot, web the paired desktop's through the Portal.
 *
 * The hook runs only while a section is mounted, so an account-wide provider
 * reads and polls nothing on other pages. Keep the port and the hook stable
 * for the host's lifetime.
 */
export interface CustomizeSettingsPort {
  readonly useInstalledItemSnapshotState: () => InstalledItemSnapshotState;
  readonly openCustomize: (target: CustomizeSettingsTarget) => void;
}

const CustomizeSettingsPortContext =
  createContext<CustomizeSettingsPort | null>(null);

export function CustomizeSettingsPortProvider({
  value,
  children,
}: {
  readonly value: CustomizeSettingsPort;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <CustomizeSettingsPortContext.Provider value={value}>
      {children}
    </CustomizeSettingsPortContext.Provider>
  );
}

export function useCustomizeSettingsPort(): CustomizeSettingsPort | null {
  return useContext(CustomizeSettingsPortContext);
}
