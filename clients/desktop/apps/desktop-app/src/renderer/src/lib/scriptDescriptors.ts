import {
  WORKSPACE_ROOT_REPO_NAME,
  type ScriptDescriptor,
} from '@canopy/desktop-shared/types';
import {
  createScriptKey,
  getScriptDisplayName,
  isLifecycleScriptName,
  type CommandShellDefinition,
  type ScriptDevServerPattern,
} from '@canopy/desktop-shared/scripts';

export function createProjectScriptDescriptor(
  scriptName: string,
  command: string,
  devServerPattern?: ScriptDevServerPattern,
  shell?: CommandShellDefinition,
  interactive?: boolean,
): ScriptDescriptor {
  const descriptor: ScriptDescriptor = {
    scriptKey: createScriptKey('project', scriptName),
    scriptName,
    label: getScriptDisplayName(scriptName),
    command,
    lifecycle: isLifecycleScriptName(scriptName) ? scriptName : 'custom',
    target: 'project',
  };
  if (devServerPattern !== undefined) {
    descriptor.devServerPattern = devServerPattern;
  }
  if (shell !== undefined) {
    descriptor.shell = shell;
  }
  if (interactive === true) descriptor.interactive = true;
  return descriptor;
}

export function createWorkspaceRepoScriptDescriptor(
  repoId: string,
  repoName: string,
  scriptName: string,
  command: string,
  devServerPattern?: ScriptDevServerPattern,
  shell?: CommandShellDefinition,
  interactive?: boolean,
): ScriptDescriptor {
  const descriptor: ScriptDescriptor = {
    scriptKey: createScriptKey('workspace-repo', scriptName, repoId),
    scriptName,
    label: `${repoName} — ${getScriptDisplayName(scriptName)}`,
    command,
    lifecycle: isLifecycleScriptName(scriptName) ? scriptName : 'custom',
    target: 'workspace-repo',
    repoId,
    repoName,
  };
  if (devServerPattern !== undefined) {
    descriptor.devServerPattern = devServerPattern;
  }
  if (shell !== undefined) {
    descriptor.shell = shell;
  }
  if (interactive === true) descriptor.interactive = true;
  return descriptor;
}

export function createWorkspaceRootScriptDescriptor(
  scriptName: string,
  command: string,
  devServerPattern?: ScriptDevServerPattern,
  shell?: CommandShellDefinition,
  interactive?: boolean,
): ScriptDescriptor {
  const descriptor: ScriptDescriptor = {
    scriptKey: createScriptKey('workspace-root', scriptName),
    scriptName,
    label: `${WORKSPACE_ROOT_REPO_NAME} — ${getScriptDisplayName(scriptName)}`,
    command,
    lifecycle: isLifecycleScriptName(scriptName) ? scriptName : 'custom',
    target: 'workspace-root',
  };
  if (devServerPattern !== undefined) {
    descriptor.devServerPattern = devServerPattern;
  }
  if (shell !== undefined) {
    descriptor.shell = shell;
  }
  if (interactive === true) descriptor.interactive = true;
  return descriptor;
}
