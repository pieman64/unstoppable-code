import { recordAutomationCreatedProject } from '@/stores/automationInstallContinuationStore';
import {
  useHomeComposerStore,
  type HomeWorkspaceSelectionReason,
} from '@/stores/homeComposerStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';

export function navigateAfterRepositoryWorkspaceCreated(
  workspaceId: string,
  reason?: HomeWorkspaceSelectionReason,
): void {
  const homeComposer = useHomeComposerStore.getState();
  if (reason) {
    homeComposer.selectWorkspace(workspaceId, { reason });
  } else {
    homeComposer.selectWorkspace(workspaceId);
  }
  if (homeComposer.pendingCreateFromReference) {
    return;
  }
  const workspace = useProjectsStore
    .getState()
    .projects.find((project) => project.id === workspaceId);
  if (
    !workspace ||
    workspace.type === 'cowork' ||
    workspace.worktrees.length > 0
  ) {
    return;
  }
  // Land in the New Task composer, already aimed at the new workspace by the
  // `selectWorkspace` above. A brand-new workspace has no chats, approvals,
  // or pipeline runs — the composer is the one surface where the next step is
  // the action itself: describe a task and a worktree is created for it.
  // `navigate('home')` also bumps `homeComposerFocusRequest`, so the
  // page-variant composer autofocuses. The shared Getting started queue adds
  // this workspace's readiness fixes to its technical advanced stage; the
  // Overview retains the cross-workspace view.
  useNavigationStore.getState().navigate('home');
}

/**
 * Post-create navigation for an empty multi-repo project: no repos to branch
 * from yet, so route to the workspace settings Repositories tab. Shared by the
 * Add project dialog and the App Advisor `workspace.create_multi_repo` action.
 */
export function openCreatedMultiRepoWorkspaceSettings(
  workspaceId: string,
): void {
  recordAutomationCreatedProject(workspaceId);
  // A pending create-from resume cannot complete against a repo-less draft,
  // so drop the stash here.
  useHomeComposerStore.getState().setPendingCreateFromReference(null);
  useNavigationStore.getState().openWorkspaceSettings({
    workspaceId,
    initialTab: 'repositories',
  });
}
