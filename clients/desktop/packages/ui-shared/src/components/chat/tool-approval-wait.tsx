import { createContext, useContext, type JSX, type ReactNode } from 'react';

/** What a step or file chip says while its call waits for the person's approval. */
export const TOOL_APPROVAL_WAITING_LABEL = 'Waiting for approval';

/** The identity of one transcript tool call, as a host can describe it. */
export interface ToolApprovalCall {
  readonly toolUseId?: string;
  readonly toolName: string;
  readonly input?: string;
}

/**
 * Which unresolved calls of a running turn are held for approval. Hosts
 * derive it from their own approval signal and scope it to one turn;
 * without a provider nothing waits. Rows apply it only to a call still
 * pending after its status and its turn's settlement are resolved.
 */
export interface ToolApprovalWait {
  readonly isCallWaiting: (call: ToolApprovalCall) => boolean;
  /** Whether a pending file contribution at `path` awaits approval. */
  readonly isFileWaiting: (path: string) => boolean;
}

export const NO_TOOL_APPROVAL_WAIT: ToolApprovalWait = {
  isCallWaiting: () => false,
  isFileWaiting: () => false,
};

const ToolApprovalWaitContext = createContext<ToolApprovalWait>(
  NO_TOOL_APPROVAL_WAIT,
);

/** Hosts pass a memoized value so rows re-render only when approvals change. */
export function ToolApprovalWaitProvider({
  value,
  children,
}: {
  readonly value: ToolApprovalWait;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <ToolApprovalWaitContext.Provider value={value}>
      {children}
    </ToolApprovalWaitContext.Provider>
  );
}

export function useToolApprovalWait(): ToolApprovalWait {
  return useContext(ToolApprovalWaitContext);
}
