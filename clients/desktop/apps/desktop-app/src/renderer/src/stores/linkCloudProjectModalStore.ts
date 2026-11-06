import { create } from 'zustand';
import type {
  LinkCloudProjectErrorCode,
  LinkCloudProjectState,
  LinkCloudProjectTarget,
} from '@canopy/ui-app';
import type { CloudProjectLinkOptions } from '@canopy/desktop-shared/types';
import { useGitHubStore } from './githubStore';
import { useProjectsStore } from './projectsStore';

/**
 * The Link to cloud project dialog (CAN-5190): its project, what main found
 * for it, and the link in flight. Main decides everything; this store only
 * carries the answers to the shared dialog.
 */

interface LinkCloudProjectModalStore {
  workspaceId: string | null;
  state: LinkCloudProjectState;
  busy: boolean;
  error: LinkCloudProjectErrorCode | null;
}

export const useLinkCloudProjectModalStore = create<LinkCloudProjectModalStore>(
  () => ({
    workspaceId: null,
    state: { kind: 'loading' },
    busy: false,
    error: null,
  }),
);

function dialogState(options: CloudProjectLinkOptions): LinkCloudProjectState {
  switch (options.status) {
    case 'linked':
      return { kind: 'linked', cloudProjectName: options.name };
    case 'choose':
      return {
        kind: 'choose',
        candidates: options.candidates,
        suggestedProjectId: options.suggestedProjectId,
      };
    case 'unavailable':
      return { kind: 'unavailable', reason: options.reason };
  }
}

/** Whether the project menus offer the link: a Personal project. */
export function canLinkCloudProject(workspaceId: string): boolean {
  const project = useProjectsStore
    .getState()
    .projects.find((candidate) => candidate.id === workspaceId);
  return project !== undefined && project.owner === undefined;
}

export async function openLinkCloudProjectModal(
  workspaceId: string,
): Promise<void> {
  if (useLinkCloudProjectModalStore.getState().busy) return;
  useLinkCloudProjectModalStore.setState({
    workspaceId,
    state: { kind: 'loading' },
    error: null,
  });
  let state: LinkCloudProjectState;
  try {
    state = dialogState(await window.api.cloudProjects.findLink(workspaceId));
  } catch {
    state = { kind: 'unavailable', reason: 'offline' };
  }
  // A dialog closed or reopened for another project meanwhile keeps its own.
  if (useLinkCloudProjectModalStore.getState().workspaceId === workspaceId)
    useLinkCloudProjectModalStore.setState({ state });
}

export function closeLinkCloudProjectModal(): void {
  if (useLinkCloudProjectModalStore.getState().busy) return;
  useLinkCloudProjectModalStore.setState({
    workspaceId: null,
    state: { kind: 'loading' },
    error: null,
  });
}

/** Links the dialog's project; a refusal keeps the dialog open with its reason. */
export async function linkCloudProject(
  target: LinkCloudProjectTarget,
): Promise<void> {
  const { workspaceId, busy } = useLinkCloudProjectModalStore.getState();
  if (busy || workspaceId === null) return;
  useLinkCloudProjectModalStore.setState({ busy: true, error: null });
  let error: LinkCloudProjectErrorCode | null;
  try {
    const result = await window.api.cloudProjects.link({
      workspaceId,
      target:
        target.kind === 'new'
          ? { kind: 'new' }
          : { kind: 'existing', projectId: target.projectId },
    });
    error = result.ok ? null : result.code;
  } catch {
    error = 'link-failed';
  }
  if (error !== null) {
    useLinkCloudProjectModalStore.setState({ busy: false, error });
    return;
  }
  const projectName =
    useProjectsStore
      .getState()
      .projects.find((candidate) => candidate.id === workspaceId)?.name ??
    workspaceId;
  useLinkCloudProjectModalStore.setState({
    workspaceId: null,
    state: { kind: 'loading' },
    busy: false,
    error: null,
  });
  useGitHubStore
    .getState()
    .addToast(`Linked ${projectName}.`, 'success', undefined, {
      blockMessageFromReplay: true,
    });
}
