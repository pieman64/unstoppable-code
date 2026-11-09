import type { HookDescriptor } from '@canopy/desktop-shared/types';
import type { PersistedPrSnapshotFileV1 } from '@canopy/desktop-shared/types/github';
import { buildPrQueueHookVariables } from '@canopy/desktop-shared/lib/pr-merge-queue';
import {
  createHookKey,
  HOOK_ENV_VAR_DEFINITIONS,
  type HookScope,
} from '@canopy/desktop-shared/hooks';
import { BRAND } from '@canopy/brand/current';
import { setBrandEnv } from '@canopy/execution-engine/brand/env';
import { buildWorktreeDataEnv } from './worktree-data-env';
import type { AppAdvisorHookTriggeredEvent } from '../app-advisor/watchers';
import { getAppAdvisorWatcherService } from '../app-advisor/watchers';

const HOOK_VARIABLE_NAMES = new Set([
  ...HOOK_ENV_VAR_DEFINITIONS.map((definition) => definition.name),
  'CONDUCTOR_WORKSPACE_NAME',
]);

export function hookKeyForScope(args: {
  scope: HookScope;
  triggerName: string;
  repoId?: string;
}): string | undefined {
  try {
    return createHookKey(args.scope, args.triggerName, args.repoId);
  } catch {
    return undefined;
  }
}

function stripHookVariablePrefix(name: string): string {
  const prefixes = [...BRAND.environment.prefixes, 'CANOPY'].sort(
    (a, b) => b.length - a.length,
  );
  for (const prefix of prefixes) {
    const envPrefix = `${prefix}_`;
    if (name.startsWith(envPrefix)) {
      return name.slice(envPrefix.length);
    }
  }
  return name;
}

function supportedVariables(env: NodeJS.ProcessEnv): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const name of Array.from(HOOK_VARIABLE_NAMES)) {
    const value = env[name];
    if (typeof value === 'string') {
      const variableName = stripHookVariablePrefix(name);
      if (!(variableName in variables)) {
        variables[variableName] = value;
      }
    }
  }
  return variables;
}

export function buildHookWatcherVariables(args: {
  projectId: string;
  worktreeId: string;
  scope: HookScope;
  repoId?: string;
  /** Selects trigger-specific variables, such as the merge queue ones. */
  triggerName?: string;
  currentSnapshot?: PersistedPrSnapshotFileV1;
  currentSnapshotPath?: string;
  previousSnapshotPath?: string;
  env?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const env: NodeJS.ProcessEnv = { ...args.env };
  if (args.scope === 'workspace-repo' && args.repoId) {
    setBrandEnv(env, 'WORKSPACE_CHILD_REPO_ID', args.repoId);
  }
  if (args.currentSnapshot && args.currentSnapshotPath) {
    if (args.previousSnapshotPath) {
      setBrandEnv(env, 'PR_PREV_FILE', args.previousSnapshotPath);
    }
    setBrandEnv(env, 'PR_CURRENT_FILE', args.currentSnapshotPath);
    setBrandEnv(env, 'PR_BRANCH', args.currentSnapshot.branch.headRefName);
    setBrandEnv(env, 'PR_BASE_BRANCH', args.currentSnapshot.branch.baseRefName);
    setBrandEnv(env, 'PR_REPO_NAME', args.currentSnapshot.repository.name);
    setBrandEnv(env, 'PR_REPO_OWNER', args.currentSnapshot.repository.owner);
    setBrandEnv(env, 'PR_NUMBER', String(args.currentSnapshot.pr.number));
    setBrandEnv(env, 'PR_ID', String(args.currentSnapshot.pr.number));
    setBrandEnv(env, 'PR_URL', args.currentSnapshot.pr.htmlUrl);
    if (args.triggerName) {
      for (const [name, value] of Object.entries(
        buildPrQueueHookVariables(args.currentSnapshot, args.triggerName),
      )) {
        setBrandEnv(env, name, value);
      }
    }
  }
  return supportedVariables(
    buildWorktreeDataEnv(args.projectId, args.worktreeId, env, {
      runtime: 'canopy',
    }),
  );
}

export function fireHookTriggeredWatchers(args: {
  projectId: string;
  worktreeId: string;
  triggerName: string;
  scope: HookScope;
  repoId?: string;
  repoName?: string;
  hook?: HookDescriptor;
  configured: boolean;
  paused: boolean;
  variables: Record<string, string>;
}): void {
  const hookKey =
    args.hook?.hookKey ??
    hookKeyForScope({
      scope: args.scope,
      triggerName: args.triggerName,
      repoId: args.repoId,
    });
  const event: AppAdvisorHookTriggeredEvent = {
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    triggerName: args.triggerName,
    ...(hookKey ? { hookKey } : {}),
    scope: args.scope,
    ...(args.repoId ? { repoId: args.repoId } : {}),
    ...(args.repoName ? { repoName: args.repoName } : {}),
    ...(args.hook?.label ? { hookLabel: args.hook.label } : {}),
    configured: args.configured,
    paused: args.paused,
    variables: args.variables,
    triggeredAt: new Date().toISOString(),
  };
  void getAppAdvisorWatcherService()
    .handleHookTriggeredEvent(event)
    .catch(() => undefined);
}
