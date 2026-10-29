import { create } from 'zustand';
import type { SharedAutomationInstallSource } from '@canopy/protocol/automations';
import { projectKindToTargetContext } from '@canopy/protocol/automations';
import type { AutomationProjectCreationRequest } from '@/components/automations/InstallSharedAutomationModal';
import { useNavigationStore } from './navigationStore';
import { useProjectsStore } from './projectsStore';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';

interface Continuation {
  request: AutomationProjectCreationRequest;
  previousProjectIds: ReadonlySet<string>;
  workspaceContext?: WorkspaceContext;
  createdProjectId?: string;
}

type ContinuationState =
  | { status: 'closed' }
  | { status: 'creating'; continuation: Continuation }
  | { status: 'loading'; continuation: Continuation }
  | { status: 'error'; continuation: Continuation; error: string }
  | {
      status: 'ready';
      continuation: Continuation;
      detail: SharedAutomationInstallSource;
      createdProjectId?: string;
    };

export const useAutomationInstallContinuationStore = create<{
  state: ContinuationState;
}>(() => ({
  state: { status: 'closed' },
}));

export function closeAutomationInstallContinuation(): void {
  useAutomationInstallContinuationStore.setState({
    state: { status: 'closed' },
  });
}

/** The existing creation flow reports success; inventory additions alone do not. */
export function recordAutomationCreatedProject(id: string): void {
  const { state } = useAutomationInstallContinuationStore.getState();
  if (state.status === 'creating' || state.status === 'loading')
    state.continuation.createdProjectId = id;
}

export async function resumeAutomationInstall(
  continuation: Continuation,
): Promise<void> {
  const current = useAutomationInstallContinuationStore.getState().state;
  if (current.status === 'closed' || current.continuation !== continuation)
    return;
  useAutomationInstallContinuationStore.setState({
    state: { status: 'loading', continuation },
  });
  try {
    await useProjectsStore
      .getState()
      .loadProjects({ silent: true, requireSuccess: true });
    // The source can open before renderer context hydration finishes. Resolve
    // the selected context through main rather than widening the resumed list.
    continuation.workspaceContext = (
      await window.api.workspaceContext.get()
    ).context;
    const { request } = continuation;
    let detail: SharedAutomationInstallSource;
    if (request.source === 'shared') {
      detail = await window.api.automations.getShared(request.detail.id);
    } else if (request.source === 'curated') {
      const curated = await window.api.automations.getCurated(
        request.detail.id,
      );
      detail = {
        id: curated.key,
        contentHash: curated.contentHash,
        automation: curated.automation,
      };
    } else {
      const response = await window.api.deepLinkResolveShare({
        entity: 'automation',
        externalId: request.detail.id,
      });
      if (!response.ok || response.snapshot.entity !== 'automation')
        throw new Error(
          'The shared automation could not be refreshed. Try again before installing.',
        );
      detail = {
        id: response.snapshot.externalId,
        contentHash: response.snapshot.contentHash,
        automation: response.snapshot.automation,
      };
    }
    const latest = useAutomationInstallContinuationStore.getState().state;
    if (latest.status === 'closed' || latest.continuation !== continuation)
      return;
    const created = useProjectsStore
      .getState()
      .projects.filter(
        (project) =>
          project.id === continuation.createdProjectId &&
          !continuation.previousProjectIds.has(project.id) &&
          projectKindToTargetContext(project.type) === request.context,
      );
    useAutomationInstallContinuationStore.setState({
      state: {
        status: 'ready',
        continuation,
        detail,
        ...(created.length === 1 ? { createdProjectId: created[0]?.id } : {}),
      },
    });
  } catch (error) {
    const latest = useAutomationInstallContinuationStore.getState().state;
    if (latest.status !== 'closed' && latest.continuation === continuation)
      useAutomationInstallContinuationStore.setState({
        state: {
          status: 'error',
          continuation,
          error:
            error instanceof Error
              ? error.message
              : 'The shared automation could not be refreshed. Try again.',
        },
      });
  }
}

/** Keep the draft at app level so creation may navigate without losing it. */
export function requestAutomationProjectCreation(
  request: AutomationProjectCreationRequest,
): void {
  if (
    useAutomationInstallContinuationStore.getState().state.status !== 'closed'
  )
    return;
  const continuation: Continuation = {
    request,
    previousProjectIds: new Set(
      useProjectsStore.getState().projects.map((project) => project.id),
    ),
  };
  useAutomationInstallContinuationStore.setState({
    state: { status: 'creating', continuation },
  });
  const unsubscribe = useNavigationStore.subscribe((next, previous) => {
    if (previous.addWorkspaceModalOpen && !next.addWorkspaceModalOpen) {
      unsubscribe();
      void resumeAutomationInstall(continuation);
    }
  });
  useNavigationStore.getState().openAddWorkspaceModal({
    initialProjectType: request.context === 'cowork' ? 'cowork' : 'single-repo',
  });
}
