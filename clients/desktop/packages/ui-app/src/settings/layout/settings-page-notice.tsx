'use client';

import { createContext, useContext, type JSX, type ReactNode } from 'react';

const SettingsPageNoticeContext = createContext<ReactNode>(null);

/**
 * Supplies a host notice about the current page (for example, "You no longer
 * have access to this organization" after a redirect). The page renders it
 * below its header, inside its content, so the header keeps its place
 * whether or not a notice shows.
 */
export function SettingsPageNoticeProvider({
  notice,
  children,
}: {
  readonly notice: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <SettingsPageNoticeContext.Provider value={notice}>
      {children}
    </SettingsPageNoticeContext.Provider>
  );
}

/** The host's notice for this page, or nothing. Place it below the header. */
export function SettingsPageNotice(): ReactNode {
  return useContext(SettingsPageNoticeContext);
}
