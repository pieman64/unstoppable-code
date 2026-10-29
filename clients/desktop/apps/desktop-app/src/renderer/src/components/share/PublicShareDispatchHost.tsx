import { useEffect, type JSX } from 'react';
import { useNavigationStore } from '@/stores/navigationStore';
import { useDispatchPipelineModal } from '../activity/useDispatchPipelineModal';

/**
 * Self-gating App-level host (the `ShareInstallModalHost` pattern)
 * for the share landing's pipeline "Try now" (CAN-2361 PR2b): consumes
 * `pendingPipelineDispatch` and opens the worktree dispatch modal with the
 * saved pipeline preselected. Running stays an explicit user click inside
 * the modal — this host never executes anything.
 */
export function PublicShareDispatchHost(): JSX.Element | null {
  const pending = useNavigationStore((s) => s.pendingPipelineDispatch);
  const { openDispatchPipelineModal, dispatchPipelineModal } =
    useDispatchPipelineModal();

  useEffect(() => {
    if (!pending) return;
    useNavigationStore.getState().consumePipelineDispatch();
    openDispatchPipelineModal({
      projectId: pending.projectId,
      worktreeId: pending.worktreeId,
      initialPipelineId: pending.pipelineId,
    });
  }, [pending, openDispatchPipelineModal]);

  return dispatchPipelineModal;
}
