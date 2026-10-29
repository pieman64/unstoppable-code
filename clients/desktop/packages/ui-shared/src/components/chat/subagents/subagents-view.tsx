import { createContext, useContext, type JSX, type ReactNode } from 'react';

/**
 * Whether the Subagents view is on: the desktop "Subagents view" Labs
 * experiment. On, the Subagents panel uses one toolbar row (segmented
 * filters, icon Tree/List, Stop all), list rows carry the shared spinner
 * without a column header, and the details card is simplified. Off (the
 * default, and every host without a Labs surface) keeps the classic panel.
 * Hosts choose it once at their root; parts read it with `useSubagentsView`.
 */
const SubagentsViewContext = createContext(false);

export function SubagentsViewProvider({
  value,
  children,
}: {
  readonly value: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <SubagentsViewContext.Provider value={value}>
      {children}
    </SubagentsViewContext.Provider>
  );
}

/** True while the Subagents view experiment is on. */
export function useSubagentsView(): boolean {
  return useContext(SubagentsViewContext);
}
