import {
  createHookKey,
  getHookTriggerDisplayName,
  type HookAction,
} from '@canopy/desktop-shared/hooks';
import { WORKSPACE_ROOT_REPO_NAME } from '@canopy/desktop-shared/types';
import type {
  HookCompleteEvent,
  HookDescriptor,
  HookOutputEvent,
  HookRunResponse,
  HookStartedEvent,
} from '@canopy/desktop-shared/types';

const MAX_HOOK_COMPLETE_FAILURE_OUTPUT_LINES = 8;
const MAX_HOOK_COMPLETE_FAILURE_OUTPUT_CHARS = 1200;

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

function lightDescriptor(hook: HookDescriptor): HookDescriptor {
  return {
    hookKey: hook.hookKey,
    triggerName: hook.triggerName,
    label: hook.label,
    actions: [],
    target: hook.target,
    repoId: hook.repoId,
    repoName: hook.repoName,
  };
}

function summarizeHookFailureOutput(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) {
    return '';
  }

  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const limitedLines = lines.slice(0, MAX_HOOK_COMPLETE_FAILURE_OUTPUT_LINES);
  const omittedLines = lines.length > limitedLines.length;
  const lineLimited = limitedLines.join('\n');

  if (lineLimited.length > MAX_HOOK_COMPLETE_FAILURE_OUTPUT_CHARS) {
    return `${lineLimited
      .slice(0, MAX_HOOK_COMPLETE_FAILURE_OUTPUT_CHARS)
      .trimEnd()}\n[output truncated]`;
  }

  if (omittedLines) {
    return `${lineLimited}\n[output truncated]`;
  }

  return lineLimited;
}

export function createHookStartedEvent(
  projectId: string,
  worktreeId: string,
  hook: HookDescriptor,
): HookStartedEvent {
  return {
    projectId,
    worktreeId,
    hook,
  };
}

export function createHookOutputEvent(
  projectId: string,
  worktreeId: string,
  hook: HookDescriptor,
  lines: string[],
  activeActionIndex?: number,
): HookOutputEvent {
  return {
    projectId,
    worktreeId,
    hook: lightDescriptor(hook),
    lines,
    activeActionIndex,
  };
}

export function createHookCompleteEvent(
  projectId: string,
  worktreeId: string,
  hook: HookDescriptor,
  result: HookRunResponse,
): HookCompleteEvent {
  return {
    projectId,
    worktreeId,
    hook,
    result: {
      success: result.success,
      stopped: result.stopped,
      exitCode: result.exitCode,
      // Completion events stay small, but failed hooks need enough context for
      // the toast and activity UI to explain the failure.
      output: result.success ? '' : summarizeHookFailureOutput(result.output),
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    },
  };
}
