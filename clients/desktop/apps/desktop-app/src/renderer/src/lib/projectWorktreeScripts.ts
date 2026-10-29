import {
  normalizeScriptInputMap,
  type ScriptOverrides,
} from '@canopy/desktop-shared/scripts';
import type { SingleRepoSidebarItem } from '@canopy/desktop-shared/types';
import {
  editableScriptToScriptValue,
  type EditableScripts,
} from './editableScripts';

export type AppliedProjectWorktreeScripts = Record<string, ScriptOverrides>;

export function createAppliedProjectWorktreeScriptsKey(
  projectId: string,
  worktreeId: string,
): string {
  return `${projectId}/${worktreeId}`;
}

export function applySingleRepoWorktreeSourceScripts(
  baseEffectiveScripts: ScriptOverrides | undefined,
  localOverrides: ScriptOverrides | undefined,
  loadedSourceScripts: EditableScripts,
  sourceScripts: EditableScripts,
): ScriptOverrides | undefined {
  const nextScripts: ScriptOverrides = {
    ...(baseEffectiveScripts ?? {}),
  };

  for (const scriptName of Object.keys(loadedSourceScripts)) {
    delete nextScripts[scriptName];
  }

  for (const [scriptName, script] of Object.entries(sourceScripts)) {
    // Preserve timeout metadata as the source draft is overlaid onto the
    // worktree's effective scripts. A plain string draft round-trips as a
    // string; a draft with `timeoutSeconds` round-trips as an object.
    nextScripts[scriptName] = editableScriptToScriptValue(script);
  }

  const normalizedLocalOverrides = normalizeScriptInputMap(localOverrides);
  if (normalizedLocalOverrides) {
    for (const [scriptName, value] of Object.entries(
      normalizedLocalOverrides,
    )) {
      nextScripts[scriptName] = value;
    }
  }

  return normalizeScriptInputMap(nextScripts);
}

export function getSingleRepoWorktreeEffectiveScripts(
  project: SingleRepoSidebarItem,
  worktreeId: string,
  appliedWorktreeScripts: AppliedProjectWorktreeScripts,
): ScriptOverrides | undefined {
  const appliedScripts =
    appliedWorktreeScripts[
      createAppliedProjectWorktreeScriptsKey(project.id, worktreeId)
    ];

  if (appliedScripts && Object.keys(appliedScripts).length === 0) {
    return project.effectiveScripts;
  }

  return appliedScripts ?? project.effectiveScripts;
}
