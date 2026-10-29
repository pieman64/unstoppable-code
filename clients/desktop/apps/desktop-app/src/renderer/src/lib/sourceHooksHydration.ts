import { serializeHooks, type EditableHooks } from './editableHooks';

export interface HydratedSourceHooksState {
  sourceHooks: EditableHooks;
  loadedSourceHooks: EditableHooks;
}

/**
 * Merge user edits with a fresh manifest state, mirroring the source scripts
 * hydration pattern.
 *
 * - If no in-flight edits (source === loaded), replace with fresh manifest.
 * - If in-flight edits exist, preserve edited values and update unchanged ones.
 */
export function applyHydratedSourceHooks(
  currentSourceHooks: EditableHooks,
  currentLoadedSourceHooks: EditableHooks,
  nextLoadedSourceHooks: EditableHooks,
): HydratedSourceHooksState {
  const hasInFlightEdits =
    serializeHooks(currentSourceHooks) !==
    serializeHooks(currentLoadedSourceHooks);

  if (!hasInFlightEdits) {
    return {
      sourceHooks: nextLoadedSourceHooks,
      loadedSourceHooks: nextLoadedSourceHooks,
    };
  }

  const mergedSourceHooks: EditableHooks = { ...nextLoadedSourceHooks };
  const draftTriggerNames: Record<string, true> = {};
  for (const triggerName of Object.keys(currentLoadedSourceHooks)) {
    draftTriggerNames[triggerName] = true;
  }
  for (const triggerName of Object.keys(currentSourceHooks)) {
    draftTriggerNames[triggerName] = true;
  }

  for (const triggerName of Object.keys(draftTriggerNames)) {
    const currentDraftValue = currentSourceHooks[triggerName];
    const currentLoadedValue = currentLoadedSourceHooks[triggerName];

    // Compare arrays by JSON serialization
    if (
      JSON.stringify(currentDraftValue) === JSON.stringify(currentLoadedValue)
    ) {
      continue;
    }

    if (Array.isArray(currentDraftValue)) {
      mergedSourceHooks[triggerName] = currentDraftValue;
      continue;
    }

    delete mergedSourceHooks[triggerName];
  }

  return {
    sourceHooks: mergedSourceHooks,
    loadedSourceHooks: nextLoadedSourceHooks,
  };
}
