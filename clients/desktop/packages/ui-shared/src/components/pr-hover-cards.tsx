import { createContext, useContext, type JSX, type ReactNode } from 'react';

/**
 * Whether Pull request cards is on: the desktop Labs experiment. On, a
 * GitHub pull request or issue reference's hover card leads with its status,
 * then the title, then the author and the size of change, on the sidebar
 * worktree card's surface. Off (the default, and every host without a Labs
 * surface) keeps the classic card. Hosts choose it once at their root.
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

/** True while the Pull request cards experiment is on. */
export function usePrHoverCards(): boolean {
  return useContext(PrHoverCardsContext);
}
