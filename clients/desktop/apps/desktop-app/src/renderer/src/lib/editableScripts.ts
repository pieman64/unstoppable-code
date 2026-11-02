import type {
  CommandShellDefinition,
  ScriptDefinition,
  ScriptDevServerOpenTarget,
  ScriptDevServerPattern,
  ScriptDevServerPatternEntry,
  ScriptDevServerPatternObject,
  ScriptInputMap,
  ScriptOverrides,
  ScriptValue,
} from '@canopy/desktop-shared/scripts';
import {
  isLifecycleScriptName,
  listRunnableScripts,
  MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH,
  MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH,
  MAX_SCRIPT_DEV_SERVER_PATTERNS,
} from '@canopy/desktop-shared/scripts';

/**
 * Renderer-side editable representation of a single dev-server pattern row.
 * Persisted shapes collapse single/multi entries, but the editor always holds
 * a list so reordering and add/remove map cleanly to React keys. Canonical
 * persisted shape is produced by {@link editableDevServerPatternsToScriptValue}.
 *
 * `id` is a stable client-side identifier for React keys + validity row
 * tracking. Generated on row creation; never persisted.
 */
export interface EditableDevServerPattern {
  id: string;
  pattern: string;
  label: string;
  /**
   * Where a matched URL opens. Defaults to `'in-app'` for legacy persisted
   * rows and freshly-added blank rows; only `'external'` survives
   * canonicalization in object form.
   */
  openTarget: ScriptDevServerOpenTarget;
  /** Explicit opt-in; absent rows use manual opening. */
  autoOpen?: boolean;
}

/**
 * Renderer-side editable representation of a single script value. Mirrors the
 * canonical {@link ScriptDefinition} shape from `@canopy/desktop-shared`, but
 * always carries a `command` string so the UI can edit it directly. The
 * `timeoutSeconds` field follows the same tri-state semantics as the transport
 * layer:
 *
 *   - `undefined` (or omitted) → use the global default script timeout.
 *   - positive integer → custom timeout, in seconds.
 *   - `null` → timeout explicitly disabled.
 *
 * `devServerPatterns` is the editor-only list form of the persisted
 * `devServerPattern` field. `undefined` means "no patterns configured". An
 * empty list also serializes back to `undefined` after canonicalization, so
 * users may temporarily leave an empty list around while editing without
 * marking the entry dirty in a meaningful way.
 */
export interface EditableScript {
  command: string;
  interactive?: boolean;
  timeoutSeconds?: number | null;
  devServerPatterns?: EditableDevServerPattern[];
  shell?: CommandShellDefinition;
}

export type EditableScripts = Record<string, EditableScript>;

/** Whether a dev-server pattern compiles as a regular expression. */
export function isRegexParseable(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ids of the dev-server pattern rows that cannot be saved: too long, not a
 * regular expression, or with a label that is too long. Empty rows are not
 * listed; saving drops them.
 */
export function invalidDevServerPatternRowIds(
  patterns: readonly EditableDevServerPattern[] | undefined,
): string[] {
  const invalid: string[] = [];
  for (const row of patterns ?? []) {
    const trimmed = row.pattern.trim();
    if (trimmed.length === 0) continue;
    if (
      trimmed.length > MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH ||
      !isRegexParseable(trimmed) ||
      row.label.trim().length > MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH
    ) {
      invalid.push(row.id);
    }
  }
  return invalid;
}

/**
 * Whether any script in a draft has a dev-server pattern that cannot be
 * saved. Read from the draft itself, so it holds whether or not the script's
 * editor is open.
 */
export function hasInvalidDevServerPatterns(scripts: EditableScripts): boolean {
  return Object.values(scripts).some(
    (script) =>
      invalidDevServerPatternRowIds(script.devServerPatterns).length > 0,
  );
}

export interface EditableCustomScript {
  name: string;
  command: string;
  timeoutSeconds?: number | null;
  devServerPatterns?: EditableDevServerPattern[];
  shell?: CommandShellDefinition;
  interactive?: boolean;
}

let devServerPatternIdCounter = 0;

function nextDevServerPatternId(): string {
  devServerPatternIdCounter += 1;
  return `devsrv-${devServerPatternIdCounter}`;
}

/**
 * Expand a persisted {@link ScriptDevServerPattern} into the editor's list
 * representation. A bare string becomes `[{ pattern, label: '' }]`; an object
 * entry becomes `[{ pattern, label }]`; an array preserves the input order.
 * Labels are trimmed at save time, not here, so the user can paste freely.
 */
export function editableDevServerPatternsFromScriptValue(
  value: ScriptDevServerPattern | undefined,
): EditableDevServerPattern[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const entries: ScriptDevServerPatternEntry[] = Array.isArray(value)
    ? value
    : [value];
  if (entries.length === 0) {
    return undefined;
  }

  const editable: EditableDevServerPattern[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      editable.push({
        id: nextDevServerPatternId(),
        pattern: entry,
        label: '',
        openTarget: 'in-app',
      });
      continue;
    }
    editable.push({
      id: nextDevServerPatternId(),
      pattern: entry.pattern,
      label: entry.label ?? '',
      // Legacy/persisted object entries only carry `openTarget` when it is
      // `'external'`; everything else (omitted / invalid) restores to the
      // `'in-app'` default.
      openTarget: entry.openTarget === 'external' ? 'external' : 'in-app',
      ...(entry.autoOpen === true ? { autoOpen: true } : {}),
    });
  }
  return editable.length > 0 ? editable : undefined;
}

/**
 * Canonicalize the editor list back into a persisted
 * {@link ScriptDevServerPattern}:
 *
 *   - drop entries whose trimmed `pattern` is empty,
 *   - empty list → `undefined`,
 *   - single entry with empty/whitespace `label` → bare pattern string,
 *   - single entry with a non-empty label → `{ pattern, label }`,
 *   - multiple entries → array (each normalized the same way, drop empty
 *     labels).
 *
 * Patterns are trimmed at this boundary so user-pasted leading/trailing
 * whitespace never leaks into the on-disk file. Length caps and regex
 * parseability are enforced by the transport-layer normalization helpers, so
 * editor canonicalization stays minimal.
 */
export function editableDevServerPatternsToScriptValue(
  patterns: EditableDevServerPattern[] | undefined,
): ScriptDevServerPattern | undefined {
  if (!patterns || patterns.length === 0) {
    return undefined;
  }
  const cleaned: ScriptDevServerPatternEntry[] = [];
  for (const entry of patterns) {
    if (cleaned.length >= MAX_SCRIPT_DEV_SERVER_PATTERNS) {
      break;
    }
    const pattern = entry.pattern.trim();
    if (pattern.length === 0) {
      continue;
    }
    const label = entry.label.trim();
    const isExternal = entry.openTarget === 'external';
    // Collapse to a bare string only when nothing non-default needs to survive
    // (no label, default `in-app` target, auto-open off). Any metadata forces
    // the object form; default destination and auto-open values are dropped so legacy files
    // stay byte-stable.
    if (label.length === 0 && !isExternal && entry.autoOpen !== true) {
      cleaned.push(pattern);
      continue;
    }
    const object: ScriptDevServerPatternObject = { pattern };
    if (label.length > 0) {
      object.label = label;
    }
    if (isExternal) {
      object.openTarget = 'external';
    }
    if (entry.autoOpen === true) {
      object.autoOpen = true;
    }
    cleaned.push(object);
  }
  if (cleaned.length === 0) {
    return undefined;
  }
  if (cleaned.length === 1) {
    return cleaned[0];
  }
  return cleaned;
}

/**
 * Build the editable representation of a script overrides record. Reads
 * `string`, {@link ScriptDefinition}, and `null` values via
 * {@link listRunnableScripts}; null tombstones are intentionally not surfaced
 * here so the UI does not render an empty editor row for a disabled inherited
 * script. Callers that need to preserve tombstones on save (the project /
 * workspace settings modals) pass the raw overrides to {@link toScriptInputMap}.
 */
export function createEditableScripts(
  scripts: ScriptOverrides | undefined,
): EditableScripts {
  const editableScripts: EditableScripts = {};
  for (const runnableScript of listRunnableScripts(scripts)) {
    const entry: EditableScript = {
      command: runnableScript.command,
    };
    if (runnableScript.timeoutSeconds !== undefined) {
      entry.timeoutSeconds = runnableScript.timeoutSeconds;
    }
    if (runnableScript.devServerPattern !== undefined) {
      const editablePatterns = editableDevServerPatternsFromScriptValue(
        runnableScript.devServerPattern,
      );
      if (editablePatterns !== undefined) {
        entry.devServerPatterns = editablePatterns;
      }
    }
    if (runnableScript.shell !== undefined) {
      entry.shell = runnableScript.shell;
    }
    if (runnableScript.interactive === true) {
      entry.interactive = true;
    }
    editableScripts[runnableScript.name] = entry;
  }
  return editableScripts;
}

export function getEditableScriptValue(
  scripts: EditableScripts,
  scriptName: string,
): string {
  return scripts[scriptName]?.command ?? '';
}

/**
 * Read the configured `timeoutSeconds` for a script in the editable model.
 * Returns `undefined` when the entry has no timeout metadata (use the global
 * default), a positive integer for a custom timeout, or `null` when the
 * timeout is explicitly disabled. Missing entries also return `undefined`.
 */
export function getEditableScriptTimeoutSeconds(
  scripts: EditableScripts,
  scriptName: string,
): number | null | undefined {
  return scripts[scriptName]?.timeoutSeconds;
}

/**
 * Read the editor's dev-server pattern list for a script. Returns `undefined`
 * when the entry has no patterns configured so callers can distinguish
 * "patterns not configured" from "patterns explicitly cleared to an empty
 * list".
 */
export function getEditableScriptDevServerPatterns(
  scripts: EditableScripts,
  scriptName: string,
): EditableDevServerPattern[] | undefined {
  return scripts[scriptName]?.devServerPatterns;
}

export function getEditableCustomScripts(
  scripts: EditableScripts,
): EditableCustomScript[] {
  return Object.entries(scripts)
    .filter(([scriptName, script]) => {
      return (
        !isLifecycleScriptName(scriptName) && script.command.trim().length > 0
      );
    })
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([name, script]) => {
      const entry: EditableCustomScript = {
        name,
        command: script.command,
      };
      if (script.timeoutSeconds !== undefined) {
        entry.timeoutSeconds = script.timeoutSeconds;
      }
      if (script.devServerPatterns !== undefined) {
        entry.devServerPatterns = script.devServerPatterns;
      }
      if (script.shell !== undefined) {
        entry.shell = script.shell;
      }
      if (script.interactive === true) {
        entry.interactive = true;
      }
      return entry;
    });
}

/**
 * Update only the `command` for a script entry. The previously configured
 * `timeoutSeconds` and `devServerPatterns` (if any) are preserved so toggling
 * any sub-field independently does not silently drop the user's other choices.
 * An empty/whitespace command removes the entry entirely; the existing UI
 * relies on this to "delete" a script by clearing its textarea.
 */
export function setEditableScriptValue(
  scripts: EditableScripts,
  scriptName: string,
  command: string,
): EditableScripts {
  const nextScripts: EditableScripts = { ...scripts };

  if (command.trim().length === 0) {
    delete nextScripts[scriptName];
    return nextScripts;
  }

  const existing = nextScripts[scriptName];
  const nextEntry: EditableScript = { command };
  if (existing?.timeoutSeconds !== undefined) {
    nextEntry.timeoutSeconds = existing.timeoutSeconds;
  }
  if (existing?.devServerPatterns !== undefined) {
    nextEntry.devServerPatterns = existing.devServerPatterns;
  }
  if (existing?.shell !== undefined) {
    nextEntry.shell = existing.shell;
  }
  if (existing?.interactive === true) nextEntry.interactive = true;
  nextScripts[scriptName] = nextEntry;
  return nextScripts;
}

/**
 * Update only the `timeoutSeconds` for a script entry. Timeout-only drafts are
 * allowed so users can choose timeout behavior before typing a command; save
 * payload generation ignores entries whose command is still empty. Reverting
 * such a timeout-only draft to Default removes the entry entirely.
 */
export function setEditableScriptTimeoutSeconds(
  scripts: EditableScripts,
  scriptName: string,
  timeoutSeconds: number | null | undefined,
): EditableScripts {
  const nextScripts: EditableScripts = { ...scripts };
  const existing = nextScripts[scriptName];
  const command = existing?.command ?? '';
  if (
    timeoutSeconds === undefined &&
    command.trim().length === 0 &&
    (existing?.devServerPatterns === undefined ||
      existing.devServerPatterns.length === 0) &&
    existing?.shell === undefined &&
    existing?.interactive !== true
  ) {
    delete nextScripts[scriptName];
    return nextScripts;
  }
  const nextEntry: EditableScript = { command };
  if (timeoutSeconds !== undefined) {
    nextEntry.timeoutSeconds = timeoutSeconds;
  }
  if (existing?.devServerPatterns !== undefined) {
    nextEntry.devServerPatterns = existing.devServerPatterns;
  }
  if (existing?.shell !== undefined) {
    nextEntry.shell = existing.shell;
  }
  if (existing?.interactive === true) nextEntry.interactive = true;
  nextScripts[scriptName] = nextEntry;
  return nextScripts;
}

/**
 * Update only the dev-server pattern list for a script entry. Preserves
 * `timeoutSeconds` and `command`, mirroring the timeout setter's shape
 * preservation. Passing `undefined` removes the patterns sub-field entirely;
 * any other value (including an empty array) is stored verbatim so the UI can
 * temporarily hold an empty list while the user edits.
 */
export function setEditableScriptDevServerPatterns(
  scripts: EditableScripts,
  scriptName: string,
  devServerPatterns: EditableDevServerPattern[] | undefined,
): EditableScripts {
  const nextScripts: EditableScripts = { ...scripts };
  const existing = nextScripts[scriptName];
  const command = existing?.command ?? '';
  if (
    command.trim().length === 0 &&
    existing?.timeoutSeconds === undefined &&
    existing?.shell === undefined &&
    existing?.interactive !== true &&
    (devServerPatterns === undefined || devServerPatterns.length === 0)
  ) {
    delete nextScripts[scriptName];
    return nextScripts;
  }
  const nextEntry: EditableScript = { command };
  if (existing?.timeoutSeconds !== undefined) {
    nextEntry.timeoutSeconds = existing.timeoutSeconds;
  }
  if (devServerPatterns !== undefined) {
    nextEntry.devServerPatterns = devServerPatterns;
  }
  if (existing?.shell !== undefined) {
    nextEntry.shell = existing.shell;
  }
  if (existing?.interactive === true) nextEntry.interactive = true;
  nextScripts[scriptName] = nextEntry;
  return nextScripts;
}

export function getEditableScriptShell(
  scripts: EditableScripts,
  scriptName: string,
): CommandShellDefinition | undefined {
  return scripts[scriptName]?.shell;
}

export function getEditableScriptInteractive(
  scripts: EditableScripts,
  scriptName: string,
): boolean {
  return scripts[scriptName]?.interactive === true;
}

export function setEditableScriptInteractive(
  scripts: EditableScripts,
  scriptName: string,
  interactive: boolean,
): EditableScripts {
  const nextScripts: EditableScripts = { ...scripts };
  const existing = nextScripts[scriptName];
  const command = existing?.command ?? '';
  if (
    !interactive &&
    command.trim().length === 0 &&
    existing?.timeoutSeconds === undefined &&
    (existing?.devServerPatterns === undefined ||
      existing.devServerPatterns.length === 0) &&
    existing?.shell === undefined
  ) {
    delete nextScripts[scriptName];
    return nextScripts;
  }
  nextScripts[scriptName] = {
    ...existing,
    command,
    ...(interactive ? { interactive: true } : {}),
  };
  if (!interactive) delete nextScripts[scriptName]?.interactive;
  return nextScripts;
}

export function setEditableScriptShell(
  scripts: EditableScripts,
  scriptName: string,
  shell: CommandShellDefinition | undefined,
): EditableScripts {
  const nextScripts: EditableScripts = { ...scripts };
  const existing = nextScripts[scriptName];
  const command = existing?.command ?? '';
  if (
    command.trim().length === 0 &&
    existing?.timeoutSeconds === undefined &&
    (existing?.devServerPatterns === undefined ||
      existing.devServerPatterns.length === 0) &&
    shell === undefined &&
    existing?.interactive !== true
  ) {
    delete nextScripts[scriptName];
    return nextScripts;
  }
  const nextEntry: EditableScript = { command };
  if (existing?.timeoutSeconds !== undefined) {
    nextEntry.timeoutSeconds = existing.timeoutSeconds;
  }
  if (existing?.devServerPatterns !== undefined) {
    nextEntry.devServerPatterns = existing.devServerPatterns;
  }
  if (shell !== undefined) {
    nextEntry.shell = shell;
  }
  if (existing?.interactive === true) nextEntry.interactive = true;
  nextScripts[scriptName] = nextEntry;
  return nextScripts;
}

export function removeEditableScript(
  scripts: EditableScripts,
  scriptName: string,
): EditableScripts {
  const nextScripts: EditableScripts = { ...scripts };
  delete nextScripts[scriptName];
  return nextScripts;
}

/**
 * Convert an editable script entry into its canonical persisted form. Produces
 * a bare command string when `timeoutSeconds`, `devServerPattern`, `shell`, and `interactive`
 * canonicalize to `undefined`, so legacy `canopy.json` files remain visually
 * stable on disk after a no-op save. Object form always emits keys in the
 * fixed order `command`, `timeoutSeconds`, `devServerPattern` so
 * JSON.stringify-based dirty-state comparisons are deterministic.
 */
export function editableScriptToScriptValue(
  script: EditableScript,
): ScriptValue {
  const devServerPattern = editableDevServerPatternsToScriptValue(
    script.devServerPatterns,
  );
  if (
    script.timeoutSeconds === undefined &&
    devServerPattern === undefined &&
    script.shell === undefined &&
    script.interactive !== true
  ) {
    return script.command;
  }
  const next: ScriptDefinition = {
    command: script.command,
  };
  if (script.interactive === true) next.interactive = true;
  if (script.timeoutSeconds !== undefined) {
    next.timeoutSeconds = script.timeoutSeconds;
  }
  if (devServerPattern !== undefined) {
    next.devServerPattern = devServerPattern;
  }
  if (script.shell !== undefined) {
    next.shell = script.shell;
  }
  return next;
}

/**
 * Build the IPC payload from the editable model. Preserves any raw `null`
 * tombstones from `rawOverrides` so that disabled inherited scripts are not
 * silently re-enabled when saving unrelated edits.
 *
 * Each emitted value is canonicalized via {@link editableScriptToScriptValue}:
 * strings round-trip as strings, custom/disabled timeouts round-trip as
 * `{ command, timeoutSeconds }` objects in a fixed key order. This is required
 * so {@link serializeEditableScriptsForSettings} (which uses `JSON.stringify`,
 * preserving insertion order) produces stable output for equivalent states.
 */
export function toScriptInputMap(
  scripts: EditableScripts,
  rawOverrides?: ScriptOverrides,
): ScriptInputMap {
  const payload: ScriptInputMap = {};

  // Preserve null tombstones from raw overrides so that disabled inherited
  // scripts are not silently re-enabled when saving unrelated edits.
  if (rawOverrides) {
    for (const [scriptName, value] of Object.entries(rawOverrides)) {
      if (value === null) {
        payload[scriptName] = null;
      }
    }
  }

  // Apply editable entries (overrides any tombstone if the user re-enabled).
  for (const [scriptName, script] of Object.entries(scripts)) {
    if (script.command.trim().length === 0) {
      continue;
    }
    const serializableScript =
      scriptName === 'teardown' ||
      scriptName === 'before-teardown' ||
      scriptName === 'after-teardown'
        ? { ...script, interactive: undefined }
        : script;
    payload[scriptName] = editableScriptToScriptValue(serializableScript);
  }

  return payload;
}

/**
 * Create a fresh, blank editable dev-server pattern row. Exposed so settings
 * UI components can append rows without leaking the id-generation detail.
 */
export function createEmptyEditableDevServerPattern(): EditableDevServerPattern {
  return {
    id: nextDevServerPatternId(),
    pattern: '',
    label: '',
    openTarget: 'in-app',
  };
}
