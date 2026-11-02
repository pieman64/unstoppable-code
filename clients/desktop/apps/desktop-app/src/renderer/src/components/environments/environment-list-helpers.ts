import type {
  EnvironmentConfigData,
  EnvironmentDefinition,
  EnvironmentRuntime,
} from '@canopy/desktop-shared/types';
import {
  compareEnvironmentDefinitions,
  getEnvironmentUsage,
} from '@canopy/desktop-shared/lib/user-environment';
import { brandText } from '@/lib/brand';

export const ENVIRONMENT_RUNTIMES: readonly EnvironmentRuntime[] = [
  'canopy',
  'agent',
  'pipeline',
];

export const ENVIRONMENT_RUNTIME_LABEL: Record<EnvironmentRuntime, string> = {
  canopy: `${brandText.shortName} Runtime`,
  agent: 'Agent runtime',
  pipeline: 'Workflow runtime',
};

export const ENVIRONMENT_RUNTIME_INDICATOR_TITLE: Record<
  EnvironmentRuntime,
  string
> = {
  canopy: `${brandText.shortName} Runtime usages`,
  agent: 'Agent runtime usages',
  pipeline: 'Workflow runtime usages',
};

export function makeUntitledEnvironmentId(): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return `env-${globalThis.crypto.randomUUID()}`;
  }
  return `env-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

export function sortEnvironments(
  environments: ReadonlyArray<EnvironmentDefinition>,
): EnvironmentDefinition[] {
  return [...environments].sort(compareEnvironmentDefinitions);
}

export function descendantIds(
  environments: ReadonlyArray<EnvironmentDefinition>,
  rootId: string,
): Set<string> {
  const childrenByParent = new Map<string, EnvironmentDefinition[]>();
  for (const environment of environments) {
    if (environment.parentId) {
      const list = childrenByParent.get(environment.parentId) ?? [];
      list.push(environment);
      childrenByParent.set(environment.parentId, list);
    }
  }
  const result = new Set<string>();
  const stack: string[] = [rootId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || result.has(id)) continue;
    result.add(id);
    const children = childrenByParent.get(id) ?? [];
    for (const child of children) {
      stack.push(child.id);
    }
  }
  return result;
}

export function countUsagesFor(
  config: EnvironmentConfigData,
  environmentId: string,
): number {
  let total = 0;
  for (const runtime of ENVIRONMENT_RUNTIMES) {
    if (config.globalRuntimes[runtime] === environmentId) total += 1;
  }
  for (const assignment of config.workspaceAssignments) {
    for (const runtime of ENVIRONMENT_RUNTIMES) {
      if (assignment.runtimes[runtime] === environmentId) total += 1;
    }
  }
  for (const environment of config.environments) {
    if (environment.parentId === environmentId) total += 1;
  }
  return total;
}

export interface UsageIndicators {
  runtime: Record<EnvironmentRuntime, string[]>;
  parent: string[];
}

export function buildUsageIndicators(
  config: EnvironmentConfigData,
  environmentId: string,
  workspaces: ReadonlyArray<{ id: string; name: string }>,
): UsageIndicators {
  const workspaceName = new Map<string, string>();
  for (const workspace of workspaces) {
    workspaceName.set(workspace.id, workspace.name);
  }
  const indicators: UsageIndicators = {
    runtime: { canopy: [], agent: [], pipeline: [] },
    parent: [],
  };
  const usage = getEnvironmentUsage(
    config,
    workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
    })),
  );
  for (const entry of usage) {
    if (entry.environmentId !== environmentId) continue;
    if (entry.kind === 'global-runtime' && entry.runtime) {
      indicators.runtime[entry.runtime].push('Global');
    } else if (entry.kind === 'workspace-runtime' && entry.runtime) {
      const name =
        (entry.workspaceId
          ? workspaceName.get(entry.workspaceId)
          : undefined) ??
        entry.workspaceName ??
        entry.workspaceId ??
        'Workspace';
      indicators.runtime[entry.runtime].push(name);
    } else if (entry.kind === 'parent' && entry.childEnvironmentId) {
      const child = config.environments.find(
        (environment) => environment.id === entry.childEnvironmentId,
      );
      indicators.parent.push(child?.name ?? entry.childEnvironmentId);
    }
  }
  return indicators;
}

export function isReferencedByAssignment(
  config: EnvironmentConfigData,
  environmentId: string,
): boolean {
  for (const runtime of ENVIRONMENT_RUNTIMES) {
    if (config.globalRuntimes[runtime] === environmentId) return true;
  }
  for (const assignment of config.workspaceAssignments) {
    for (const runtime of ENVIRONMENT_RUNTIMES) {
      if (assignment.runtimes[runtime] === environmentId) return true;
    }
  }
  return false;
}

export function isReferencedAsParent(
  config: EnvironmentConfigData,
  environmentId: string,
): boolean {
  return config.environments.some(
    (environment) => environment.parentId === environmentId,
  );
}
