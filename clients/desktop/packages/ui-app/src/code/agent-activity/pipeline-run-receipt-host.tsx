'use client';

import { createContext, useContext, type JSX, type ReactNode } from 'react';
import type {
  PipelineRunExecutionState,
  PipelineRunSummary,
} from '../activity/pipeline/PipelineRunRows';
import type {
  PipelineRunReceiptActions,
  PipelineRunReceiptPending,
} from './PipelineRunReceiptCard';

/**
 * The run state and actions a host gives the pipeline run cards in its
 * transcript. Hosts memoize the object: every card re-renders when it changes.
 */
export interface PipelineRunReceiptHost {
  readonly summaries: readonly PipelineRunSummary[];
  readonly statesById: Readonly<
    Record<string, PipelineRunExecutionState | undefined>
  >;
  readonly actions: PipelineRunReceiptActions;
  readonly pending?: PipelineRunReceiptPending;
}

const PipelineRunReceiptHostContext =
  createContext<PipelineRunReceiptHost | null>(null);

export function PipelineRunReceiptHostProvider({
  host,
  children,
}: {
  host: PipelineRunReceiptHost;
  children: ReactNode;
}): JSX.Element {
  return (
    <PipelineRunReceiptHostContext.Provider value={host}>
      {children}
    </PipelineRunReceiptHostContext.Provider>
  );
}

/** The mounted host, or null where run cards show only their receipt. */
export function usePipelineRunReceiptHost(): PipelineRunReceiptHost | null {
  return useContext(PipelineRunReceiptHostContext);
}
