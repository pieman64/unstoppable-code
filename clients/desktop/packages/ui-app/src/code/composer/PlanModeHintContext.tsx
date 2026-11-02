'use client';

import { createContext, useContext, type ReactNode, type JSX } from 'react';
import type { PlanModeHintStore } from '@canopy/app-state';

const Context = createContext<PlanModeHintStore | null>(null);

/** Hosts own persistence; shared composers consume the same scope's store. */
export function PlanModeHintProvider({
  store,
  children,
}: {
  store: PlanModeHintStore | null;
  children: ReactNode;
}): JSX.Element {
  return <Context.Provider value={store}>{children}</Context.Provider>;
}

export function usePlanModeHintStore(): PlanModeHintStore | null {
  return useContext(Context);
}
