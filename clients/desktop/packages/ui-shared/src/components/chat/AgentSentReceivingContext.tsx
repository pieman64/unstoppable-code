'use client';

import { createContext, useContext, type JSX, type ReactNode } from 'react';
import type { AgentSentReceivingContext } from './AgentSentTitle';

// Missing receiving identity must not suppress a sender label or marker.
const UNKNOWN_CONTEXT: AgentSentReceivingContext = {
  kind: 'project',
  projectId: '',
};
const ReceivingContext =
  createContext<AgentSentReceivingContext>(UNKNOWN_CONTEXT);

export function AgentSentReceivingContextProvider({
  receivingContext,
  children,
}: {
  receivingContext?: AgentSentReceivingContext;
  children: ReactNode;
}): JSX.Element {
  const inherited = useContext(ReceivingContext);
  return (
    <ReceivingContext.Provider value={receivingContext ?? inherited}>
      {children}
    </ReceivingContext.Provider>
  );
}

export function useAgentSentReceivingContext(
  explicit?: AgentSentReceivingContext,
): AgentSentReceivingContext {
  const inherited = useContext(ReceivingContext);
  return explicit ?? inherited;
}
