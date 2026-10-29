import { useMemo, type JSX } from 'react';
import {
  closePipelineCompatDetail,
  usePipelineCompatDetailStore,
} from '@/stores/pipelineCompatDetailStore';
import { PipelineExecutionDetailModal } from './PipelineExecutionDetailModal';
import type { PipelineExecutionDetailRevealTarget } from './details/pipelineDetailTypes';

/**
 * The single app-level host for pipeline runs without a usable workspace
 * owner (see `stores/pipelineCompatDetailStore.ts`). Every owned run opens in
 * its `pipeline-execution` panel instead; archived runs keep
 * `ArchivedContainerView`'s own host.
 *
 * The detail's lease is ownerless (`detailOwner={null}`), and it owns its own
 * action controller, so report and follow-up dialogs open over the modal
 * rather than closing it.
 */
export function PipelineExecutionCompatHost(): JSX.Element | null {
  const request = usePipelineCompatDetailStore((state) => state.request);
  const revealTarget = useMemo<PipelineExecutionDetailRevealTarget | undefined>(
    () =>
      request === null
        ? undefined
        : {
            nonce: request.nonce,
            ...(request.target?.viewStack !== undefined
              ? { viewStack: request.target.viewStack }
              : {}),
            ...(request.target?.jobId !== undefined
              ? { jobId: request.target.jobId }
              : {}),
            ...(request.target?.variantJobId !== undefined
              ? { variantJobId: request.target.variantJobId }
              : {}),
          },
    [request],
  );
  if (request === null) return null;
  return (
    <div data-testid="pipeline-execution-compat-host" className="contents">
      <PipelineExecutionDetailModal
        key={request.executionId}
        executionId={request.executionId}
        detailOwner={null}
        initialJobId={request.target?.jobId}
        initialViewStack={
          request.target?.viewStack ? [...request.target.viewStack] : undefined
        }
        revealTarget={revealTarget}
        onClose={closePipelineCompatDetail}
      />
    </div>
  );
}
