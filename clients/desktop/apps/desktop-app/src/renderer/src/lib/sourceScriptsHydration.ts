import {
  editableScriptToScriptValue,
  type EditableScript,
  type EditableScripts,
} from './editableScripts';

/**
 * Canonical serializer for a single {@link EditableScript} entry. Produces a
 * string suitable for structural equality checks; `undefined` is encoded
 * distinctly from `{ command: '' }` so missing-vs-empty cases stay separable.
 */
function serializeScript(script: EditableScript | undefined): string {
  if (script === undefined) {
    return 'undefined';
  }
  return JSON.stringify(editableScriptToScriptValue(script));
}

function serializeScripts(scripts: EditableScripts): string {
  const entries = Object.entries(scripts).sort((left, right) =>
    left[0].localeCompare(right[0]),
  );
  return JSON.stringify(
    entries.map(([name, script]) => [
      name,
      editableScriptToScriptValue(script),
    ]),
  );
}

export interface HydratedSourceScriptsState {
  sourceScripts: EditableScripts;
  loadedSourceScripts: EditableScripts;
}

export function applyHydratedSourceScripts(
  currentSourceScripts: EditableScripts,
  currentLoadedSourceScripts: EditableScripts,
  nextLoadedSourceScripts: EditableScripts,
): HydratedSourceScriptsState {
  const hasInFlightEdits =
    serializeScripts(currentSourceScripts) !==
    serializeScripts(currentLoadedSourceScripts);

  if (!hasInFlightEdits) {
    return {
      sourceScripts: nextLoadedSourceScripts,
      loadedSourceScripts: nextLoadedSourceScripts,
    };
  }

  const mergedSourceScripts: EditableScripts = { ...nextLoadedSourceScripts };
  const draftScriptNames: Record<string, true> = {};
  for (const scriptName of Object.keys(currentLoadedSourceScripts)) {
    draftScriptNames[scriptName] = true;
  }
  for (const scriptName of Object.keys(currentSourceScripts)) {
    draftScriptNames[scriptName] = true;
  }

  for (const scriptName of Object.keys(draftScriptNames)) {
    const currentDraftValue = currentSourceScripts[scriptName];
    const currentLoadedValue = currentLoadedSourceScripts[scriptName];
    // Structural comparison: the editable model now holds objects, so
    // reference equality is no longer sufficient to detect "no draft edit."
    if (
      serializeScript(currentDraftValue) === serializeScript(currentLoadedValue)
    ) {
      continue;
    }

    if (currentDraftValue !== undefined) {
      mergedSourceScripts[scriptName] = currentDraftValue;
      continue;
    }

    delete mergedSourceScripts[scriptName];
  }

  return {
    sourceScripts: mergedSourceScripts,
    loadedSourceScripts: nextLoadedSourceScripts,
  };
}
