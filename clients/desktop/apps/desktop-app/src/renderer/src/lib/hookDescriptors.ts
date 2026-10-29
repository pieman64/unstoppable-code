import {
  WORKSPACE_ROOT_REPO_NAME,
  type HookDescriptor,
} from '@canopy/desktop-shared/types';
import type { HookAction } from '@canopy/desktop-shared/hooks';
import {
  createHookKey,
  getHookTriggerDisplayName,
} from '@canopy/desktop-shared/hooks';

export function createProjectHookDescriptor(
  triggerName: string,
  actions: HookAction[],
): HookDescriptor {
  return {
    hookKey: createHookKey('project', triggerName),
    triggerName,
    label: getHookTriggerDisplayName(triggerName),
    actions,
    target: 'project',
  };
}

export function createWorkspaceRepoHookDescriptor(
  repoId: string,
  repoName: string,
  triggerName: string,
  actions: HookAction[],
): HookDescriptor {
  return {
    hookKey: createHookKey('workspace-repo', triggerName, repoId),
    triggerName,
    label: `${repoName} — ${getHookTriggerDisplayName(triggerName)}`,
    actions,
    target: 'workspace-repo',
    repoId,
    repoName,
  };
}

export function createWorkspaceRootHookDescriptor(
  triggerName: string,
  actions: HookAction[],
): HookDescriptor {
  return {
    hookKey: createHookKey('workspace-root', triggerName),
    triggerName,
    label: `${WORKSPACE_ROOT_REPO_NAME} — ${getHookTriggerDisplayName(triggerName)}`,
    actions,
    target: 'workspace-root',
  };
}
