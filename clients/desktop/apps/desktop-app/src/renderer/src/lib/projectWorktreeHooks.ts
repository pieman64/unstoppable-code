import {
  normalizeHookInputMap,
  type HookOverrides,
} from '@canopy/desktop-shared/hooks';
import type { SingleRepoSidebarItem } from '@canopy/desktop-shared/types';
import { toHookInputMap, type EditableHooks } from './editableHooks';

export type AppliedProjectWorktreeHooks = Record<string, HookOverrides>;

export function createAppliedProjectWorktreeHooksKey(
  projectId: string,
  worktreeId: string,
): string {
  return `${projectId}/${worktreeId}`;
}

/**
 * Merge base effective hooks + local overrides + source hooks.
 * Mirrors applySingleRepoWorktreeSourceScripts.
 */
export function applySingleRepoWorktreeSourceHooks(
  baseEffectiveHooks: HookOverrides | undefined,
  localOverrides: HookOverrides | undefined,
  loadedSourceHooks: EditableHooks,
  sourceHooks: EditableHooks,
): HookOverrides | undefined {
  const nextHooks: HookOverrides = {
    ...(baseEffectiveHooks ?? {}),
  };

  // Remove all triggers that were in the previously loaded source
  for (const triggerName of Object.keys(loadedSourceHooks)) {
    delete nextHooks[triggerName];
  }

  // Apply the current source hooks
  for (const [triggerName, editableActions] of Object.entries(sourceHooks)) {
    if (!Array.isArray(editableActions)) {
      continue;
    }

    const actions = toHookInputMap({ [triggerName]: editableActions })[
      triggerName
    ];
    if (Array.isArray(actions) && actions.length > 0) {
      nextHooks[triggerName] = actions;
    }
  }

  // Apply local overrides on top
  const normalizedLocalOverrides = normalizeHookInputMap(localOverrides);
  if (normalizedLocalOverrides) {
    for (const [triggerName, value] of Object.entries(
      normalizedLocalOverrides,
    )) {
      nextHooks[triggerName] = value;
    }
  }

  return normalizeHookInputMap(nextHooks);
}

/**
 * Get effective hooks for a single-repo worktree (from store cache or project default).
 */
export function getSingleRepoWorktreeEffectiveHooks(
  project: SingleRepoSidebarItem,
  worktreeId: string,
  appliedWorktreeHooks: AppliedProjectWorktreeHooks,
): HookOverrides | undefined {
  const appliedHooks =
    appliedWorktreeHooks[
      createAppliedProjectWorktreeHooksKey(project.id, worktreeId)
    ];

  if (appliedHooks && Object.keys(appliedHooks).length === 0) {
    return project.effectiveHooks;
  }

  return appliedHooks ?? project.effectiveHooks;
}
