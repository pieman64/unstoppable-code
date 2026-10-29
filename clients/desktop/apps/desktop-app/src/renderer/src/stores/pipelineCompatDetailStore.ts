/**
 * The app-level compatibility host for pipeline runs that have no usable
 * workspace owner.
 *
 * Every live run with an owner opens in its `pipeline-execution` panel
 * (`lib/panels/open-pipeline-execution.ts`). A run without one — global-scope
 * and directory runs recorded without ids, legacy runs, Cowork pipeline
 * automations that only record a project, and App Advisor-owned runs, whose
 * layouts live in the App Advisor window — has no layout to host a panel. The
 * opener hands those to this store instead of fabricating an owner, and
 * `PipelineExecutionCompatHost` (mounted once in `App.tsx`) shows them in the
 * takeover modal.
 *
 * Archived runs keep their own host in `ArchivedContainerView`.
 */
import { create } from 'zustand';
import type { PipelineExecutionDetailTarget } from '@/components/activity/details/pipelineDetailTypes';

export interface PipelineCompatDetailRequest {
  readonly executionId: string;
  readonly target?: PipelineExecutionDetailTarget;
  /**
   * Bumps on every open, so re-opening the shown run at another job or
   * breadcrumb applies to the already-mounted detail.
   */
  readonly nonce: number;
}

export interface PipelineCompatDetailState {
  request: PipelineCompatDetailRequest | null;
}

export const usePipelineCompatDetailStore = create<PipelineCompatDetailState>(
  () => ({ request: null }),
);

let nextNonce = 0;

/** Shows an ownerless run in the compatibility host (or re-targets it). */
export function openPipelineCompatDetail(
  executionId: string,
  target?: PipelineExecutionDetailTarget,
): void {
  nextNonce += 1;
  usePipelineCompatDetailStore.setState({
    request: {
      executionId,
      ...(target !== undefined ? { target } : {}),
      nonce: nextNonce,
    },
  });
}

export function closePipelineCompatDetail(): void {
  if (usePipelineCompatDetailStore.getState().request === null) return;
  usePipelineCompatDetailStore.setState({ request: null });
}

export function resetPipelineCompatDetailStoreForTests(): void {
  nextNonce = 0;
  usePipelineCompatDetailStore.setState({ request: null });
}
