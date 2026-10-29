import { WORKSPACE_ROOT_REPO_NAME } from '@canopy/desktop-shared/types';
import type {
  ScriptCompleteEvent,
  ScriptDescriptor,
  ScriptOutputEvent,
  ScriptRunResponse,
  ScriptStartedEvent,
} from '@canopy/desktop-shared/types';
import {
  createScriptKey,
  getScriptDisplayName,
  isLifecycleScriptName,
  type CommandShellDefinition,
  type ScriptDevServerPattern,
} from '@canopy/desktop-shared/scripts';

export type ScriptInvocation = ScriptStartedEvent['invocation'];

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

export function createScriptStartedEvent(
  projectId: string,
  worktreeId: string,
  script: ScriptDescriptor,
  invocation: ScriptInvocation,
  runId?: string,
): ScriptStartedEvent {
  return {
    projectId,
    worktreeId,
    script,
    invocation,
    runId,
  };
}

/**
 * Build a lightweight descriptor for streaming output events.
 * Omits the `command` field which can be large and is never
 * needed by the renderer during streaming — the full descriptor
 * was already sent in the `scriptStarted` event.
 *
 * `devServerPattern` MUST be preserved here so the renderer can
 * continue to apply it against streaming output lines (and so that
 * any optimistic-start descriptor pattern is not silently dropped
 * if the renderer rebuilds run state from the event).
 */
function lightDescriptor(script: ScriptDescriptor): ScriptDescriptor {
  const light: ScriptDescriptor = {
    scriptKey: script.scriptKey,
    scriptName: script.scriptName,
    label: script.label,
    command: '',
    lifecycle: script.lifecycle,
    target: script.target,
    repoId: script.repoId,
    repoName: script.repoName,
  };
  if (script.devServerPattern !== undefined) {
    light.devServerPattern = script.devServerPattern;
  }
  if (script.shell !== undefined) {
    light.shell = script.shell;
  }
  if (script.interactive === true) light.interactive = true;
  return light;
}

export function createScriptOutputEvent(
  projectId: string,
  worktreeId: string,
  script: ScriptDescriptor,
  invocation: ScriptInvocation,
  lines: string[],
  runId?: string,
): ScriptOutputEvent {
  return {
    projectId,
    worktreeId,
    script: lightDescriptor(script),
    invocation,
    runId,
    lines,
  };
}

/**
 * The `result.output` field is intentionally replaced with an empty
 * string.  The renderer already has all output lines from the
 * streaming `scriptOutput` events — re-sending the full accumulated
 * buffer (up to 256 KB) is pure waste that causes IPC-serialization
 * stalls on the main thread.
 */
export function createScriptCompleteEvent(
  projectId: string,
  worktreeId: string,
  script: ScriptDescriptor,
  invocation: ScriptInvocation,
  result: ScriptRunResponse,
  runId?: string,
): ScriptCompleteEvent {
  return {
    ...createScriptStartedEvent(
      projectId,
      worktreeId,
      script,
      invocation,
      runId,
    ),
    result: {
      success: result.success,
      exitCode: result.exitCode,
      output: '',
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    },
  };
}
