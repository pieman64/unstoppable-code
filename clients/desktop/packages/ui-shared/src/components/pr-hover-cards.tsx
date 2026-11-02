import { createContext, useContext, type JSX, type ReactNode } from 'react';

/**
 * Whether Pull request cards is on: a presentation variant. On, a
 * GitHub pull request or issue reference's hover card leads with its status,
 * then the title, then the author and the size of change, on the sidebar
 * worktree card's surface. Unconfigured component consumers keep the
 * classic card. Product hosts choose the standard presentation at their root.
 */
const PrHoverCardsContext = createContext(false);

export function PrHoverCardsProvider({
  value,
  children,
}: {
  readonly value: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <PrHoverCardsContext.Provider value={value}>
      {children}
    </PrHoverCardsContext.Provider>
  );
}

/** Whether the surrounding presentation uses PR cards. */
export function usePrHoverCards(): boolean {
  return useContext(PrHoverCardsContext);
}
