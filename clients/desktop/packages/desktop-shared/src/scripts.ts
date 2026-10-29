import { BRAND } from '@canopy/brand/current';
import { brandEnvCandidates } from './brand/env';
import {
  compareIndexedNames,
  parseWorkspaceRepoScopedValue,
  titleCaseIdentifier,
} from './lib/scoped-config-utils';

export type ProjectLifecycleScriptName = 'setup' | 'launch' | 'teardown';

export type WorkspaceRootLifecycleScriptName =
  | 'before-setup'
  | 'after-setup'
  | 'before-launch'
  | 'after-launch'
  | 'before-teardown'
  | 'after-teardown';

export type ScriptLifecyclePhase =
  | ProjectLifecycleScriptName
  | WorkspaceRootLifecycleScriptName;

export type ScriptScope = 'project' | 'workspace-repo' | 'workspace-root';

/**
 * Where a detected dev-server URL should open. `'in-app'` routes the URL to
 * the embedded in-app browser; `'external'` opens it in the user's default
 * system browser. Omitting the field is equivalent to `'in-app'`.
 */
export type ScriptDevServerOpenTarget = 'in-app' | 'external';

export type WindowsCommandShell = 'cmd' | 'powershell' | 'bash';

export type MacCommandShell = 'zsh' | 'bash';

export interface CommandShellDefinition {
  windows?: WindowsCommandShell;
  mac?: MacCommandShell;
}

export const WINDOWS_COMMAND_SHELLS: readonly WindowsCommandShell[] = [
  'cmd',
  'powershell',
  'bash',
];

export const MAC_COMMAND_SHELLS: readonly MacCommandShell[] = ['zsh', 'bash'];

/**
 * Object form of a single dev-server pattern entry. `pattern` is the regex
 * source string (no slashes, no flags) used to extract URLs from a script's
 * stdout/stderr. `label`, when present, is a short human-readable name
 * attached to detected URLs and surfaced in the renderer UI.
 *
 * `openTarget` selects where a matched URL opens (see
 * {@link ScriptDevServerOpenTarget}). It is backward-compatible: omitting it
 * (as every legacy config does) means `'in-app'`. Only `'external'` is
 * persisted on disk; the default `'in-app'` is dropped so existing files stay
 * byte-stable after a no-op edit.
 * `autoOpen` is opt-in and opens each detected URL once per live script run.
 * False and omitted values keep manual opening and are omitted on save.
 */
export interface ScriptDevServerPatternObject {
  pattern: string;
  label?: string;
  openTarget?: ScriptDevServerOpenTarget;
  /** Open each newly detected URL once per live run. Omitted/false is manual. */
  autoOpen?: boolean;
}

/**
 * A single dev-server pattern entry as persisted on a {@link ScriptDefinition}.
 * Strings are equivalent to `{ pattern: value }` with no label.
 */
export type ScriptDevServerPatternEntry = string | ScriptDevServerPatternObject;

/**
 * The full persisted shape of `devServerPattern` on a script. May be a single
 * entry (string or object form) or an array of entries. Array order is
 * priority order: for each output line, the first entry that yields at least
 * one valid `http:`/`https:` URL wins for that line.
 */
export type ScriptDevServerPattern =
  | ScriptDevServerPatternEntry
  | ScriptDevServerPatternEntry[];

/**
 * Runtime-normalized representation of a dev-server pattern. Always an object
 * form so consumers do not need to discriminate between string and object
 * entries when iterating. `openTarget` is always present and resolved (a bare
 * string or an object without `openTarget` resolves to `'in-app'`). Arrays of
 * these are produced by {@link normalizeScriptDevServerPatternsForRuntime} in
 * priority order.
 */
export interface NormalizedScriptDevServerPattern {
  pattern: string;
  label?: string;
  openTarget: ScriptDevServerOpenTarget;
  /** Only the explicit opt-in survives normalization. */
  autoOpen?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Canonical object form of a script value. Scripts may also be persisted as a
 * plain command string when no timeout customization is required; see
 * {@link ScriptValue}.
 *
 * `timeoutSeconds` semantics:
 *   - `undefined` (or omitted): use the global default script timeout
 *     (`prefs.scriptTimeoutMinutes` converted to seconds).
 *   - a positive integer in `[1, MAX_SCRIPT_TIMEOUT_SECONDS]`: custom timeout
 *     in seconds.
 *   - `null`: disable the timeout entirely.
 *
 * `devServerPattern` carries optional regex(es) used by the renderer to
 * extract dev-server URLs from the script's stdout/stderr. See
 * {@link ScriptDevServerPattern} for the persisted shape.
 */
export interface ScriptDefinition {
  command: string;
  /** Run the command in a worktree terminal so it can read user input. */
  interactive?: boolean;
  timeoutSeconds?: number | null;
  devServerPattern?: ScriptDevServerPattern;
  shell?: CommandShellDefinition;
}

/**
 * A persisted script value. `string` keeps backward compatibility with legacy
 * configurations that stored bare commands; `ScriptDefinition` carries
 * additional metadata such as per-script timeouts; `null` is a tombstone used
 * by inherited overrides to disable an inherited script.
 */
export type ScriptValue = string | ScriptDefinition | null;

export type ScriptOverrides = Record<string, ScriptValue>;

export type ScriptInputMap = Record<string, ScriptValue | undefined>;

/** Default script timeout (5 minutes), expressed in seconds. */
export const DEFAULT_SCRIPT_TIMEOUT_SECONDS = 5 * 60;

/**
 * Hard upper bound on `timeoutSeconds`. Node's `setTimeout` silently clamps any
 * delay above `2 ** 31 - 1` ms (≈24.85 days) to 1 ms, which would cause the
 * script to time out almost immediately and look like a misconfiguration bug.
 * Capping at 2,000,000 s (≈23 days) keeps `seconds * 1000` comfortably below
 * the 32-bit limit while still exceeding any realistic CI/setup duration, and
 * gives strict parsers a single number to validate against.
 */
export const MAX_SCRIPT_TIMEOUT_SECONDS = 2_000_000;

/**
 * Hard upper bound on the length of a single dev-server `pattern` source
 * string. Longer patterns are dropped during normalization to keep stored
 * `canopy.json` files reasonable and to bound regex compile time.
 */
export const MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH = 1000;

/**
 * Hard upper bound on the length of a dev-server pattern `label`. Longer
 * labels are dropped during normalization (the pattern itself is kept).
 */
export const MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH = 80;

/**
 * Hard upper bound on the number of dev-server patterns that may be attached
 * to a single script. Arrays longer than this are truncated during
 * normalization, preserving the first N entries (priority order).
 */
export const MAX_SCRIPT_DEV_SERVER_PATTERNS = 8;

export interface ScriptEnvVarDefinition {
  name: string;
  description: string;
}

export interface RunnableScriptEntry {
  name: string;
  command: string;
  lifecycle: ScriptLifecyclePhase | 'custom';
  timeoutSeconds?: number | null;
  devServerPattern?: ScriptDevServerPattern;
  shell?: CommandShellDefinition;
  interactive?: boolean;
}

const SCRIPT_ENV_SUFFIX_DEFINITIONS: ScriptEnvVarDefinition[] = [
  {
    name: 'WORKSPACE_ID',
    description: 'Project id for the current script target.',
  },
  {
    name: 'WORKTREE_NAME',
    description: 'Animal-name id of the current worktree.',
  },
  {
    name: 'WORKTREE_DATA_DIR',
    description: `Path to ${BRAND.displayName} data for the current worktree.`,
  },
  {
    name: 'WORKSPACE_CHILD_REPO_ID',
    description: 'Child repo id for project child-repo scripts when available.',
  },
];

export const SCRIPT_ENV_VAR_DEFINITIONS: ScriptEnvVarDefinition[] =
  SCRIPT_ENV_SUFFIX_DEFINITIONS.flatMap((definition) =>
    brandEnvCandidates(definition.name).map((name, index) => ({
      name,
      description:
        index === 0
          ? definition.description
          : `${definition.description} Legacy compatibility alias.`,
    })),
  );

export const SCRIPT_ENV_VISIBLE_VAR_DEFINITIONS: ScriptEnvVarDefinition[] =
  SCRIPT_ENV_SUFFIX_DEFINITIONS.map((definition) => ({
    name: brandEnvCandidates(definition.name)[0] ?? definition.name,
    description: definition.description,
  }));

export const PROJECT_LIFECYCLE_SCRIPT_NAMES: ProjectLifecycleScriptName[] = [
  'setup',
  'launch',
  'teardown',
];
export function shouldRefreshDiscoveryAfterScriptLifecycle(
  lifecycle: ScriptLifecyclePhase | 'custom',
): boolean {
  return (
    lifecycle === 'before-setup' ||
    lifecycle === 'setup' ||
    lifecycle === 'after-setup'
  );
}

export function isLifecycleScriptName(
  scriptName: string,
): scriptName is ScriptLifecyclePhase {
  return getLifecycleIndex(scriptName) >= 0;
}

export function isProjectLifecycleScriptName(
  scriptName: string,
): scriptName is ProjectLifecycleScriptName {
  return (
    scriptName === 'setup' ||
    scriptName === 'launch' ||
    scriptName === 'teardown'
  );
}
export function normalizeScriptName(
  value: string | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Legacy helper that normalizes a plain string-or-null script value. Retained
 * for callers that only ever produce string commands (legacy `setupScript` /
 * `runScript` / `teardownScript` fields). New callers should prefer
 * {@link normalizeScriptDefinition}, which accepts the wider `ScriptValue`
 * shape.
 */
export function normalizeScriptValue(
  value: string | null | undefined,
): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Narrowing guard for the canonical {@link ScriptDefinition} object form.
 * Rejects `null` and primitives; only matches plain objects whose `command`
 * field is a string. Pair with explicit `null` checks when handling tombstones.
 */
export function isScriptDefinition(value: unknown): value is ScriptDefinition {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.command === 'string';
}

/**
 * Normalize an arbitrary `timeoutSeconds` value into one of the canonical
 * shapes accepted by the transport layer: `null` (disabled), a positive
 * integer in `[1, MAX_SCRIPT_TIMEOUT_SECONDS]`, or `undefined` (use the global
 * default). Out-of-range or non-integer numbers are dropped (`undefined`); the
 * strict `canopy.json` parser raises an error instead.
 */
export function normalizeScriptTimeoutSeconds(
  value: unknown,
): number | null | undefined {
  if (value === null) {
    return null;
  }
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number') {
    return undefined;
  }
  if (!Number.isInteger(value)) {
    return undefined;
  }
  if (value < 1 || value > MAX_SCRIPT_TIMEOUT_SECONDS) {
    return undefined;
  }
  return value;
}

export function isWindowsCommandShell(
  value: unknown,
): value is WindowsCommandShell {
  return (
    typeof value === 'string' &&
    WINDOWS_COMMAND_SHELLS.some((shell) => shell === value)
  );
}

export function isMacCommandShell(value: unknown): value is MacCommandShell {
  return (
    typeof value === 'string' &&
    MAC_COMMAND_SHELLS.some((shell) => shell === value)
  );
}

export function normalizeCommandShellDefinition(
  value: unknown,
): CommandShellDefinition | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const definition: CommandShellDefinition = {};
  if (isWindowsCommandShell(value.windows)) {
    definition.windows = value.windows;
  }
  if (isMacCommandShell(value.mac)) {
    definition.mac = value.mac;
  }

  return Object.keys(definition).length > 0 ? definition : undefined;
}

/**
 * Permissively resolve a raw `openTarget` value to one of the two supported
 * {@link ScriptDevServerOpenTarget} values. Anything other than the literal
 * string `'external'` — including `undefined`, invalid strings, and non-string
 * values — normalizes to the `'in-app'` default. Strict *rejection* of invalid
 * values is the backend `canopy.json` parser's job.
 */
function normalizeScriptDevServerOpenTarget(
  value: unknown,
): ScriptDevServerOpenTarget {
  return value === 'external' ? 'external' : 'in-app';
}

/**
 * Normalize a single dev-server pattern entry into its canonical persisted
 * shape. Returns `undefined` when the entry is invalid (empty pattern, too
 * long, unparseable as a regex, or not a string/object input).
 *
 * Object entries collapse to bare strings only when no metadata needs to be
 * preserved, so JSON.stringify diffs stay stable for the common case. A
 * `label` and an `openTarget` of `'external'` both force the object form. The
 * default `openTarget` of `'in-app'` (and any invalid value, which normalizes
 * to `'in-app'`) is dropped so legacy configs round-trip byte-stable.
 */
function normalizeScriptDevServerPatternEntry(
  value: unknown,
): ScriptDevServerPatternEntry | undefined {
  if (typeof value === 'string') {
    const pattern = value.trim();
    if (pattern.length === 0) {
      return undefined;
    }
    if (pattern.length > MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH) {
      return undefined;
    }
    if (!isParseableRegexSource(pattern)) {
      return undefined;
    }
    return pattern;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.pattern !== 'string') {
    return undefined;
  }
  const pattern = value.pattern.trim();
  if (pattern.length === 0) {
    return undefined;
  }
  if (pattern.length > MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH) {
    return undefined;
  }
  if (!isParseableRegexSource(pattern)) {
    return undefined;
  }
  let label: string | undefined;
  if (typeof value.label === 'string') {
    const trimmedLabel = value.label.trim();
    if (
      trimmedLabel.length > 0 &&
      trimmedLabel.length <= MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH
    ) {
      label = trimmedLabel;
    }
  }
  const openTarget = normalizeScriptDevServerOpenTarget(value.openTarget);
  const autoOpen = value.autoOpen === true;
  // Collapse to a bare string only when no label, destination or auto-open
  // metadata needs to survive. Keys are emitted in the fixed order
  // `pattern`, `label`, `openTarget`, `autoOpen` so JSON.stringify-based dirty-state
  // comparisons stay deterministic.
  if (label === undefined && openTarget === 'in-app' && !autoOpen) {
    return pattern;
  }
  const entry: ScriptDevServerPatternObject = { pattern };
  if (label !== undefined) {
    entry.label = label;
  }
  if (openTarget === 'external') {
    entry.openTarget = openTarget;
  }
  if (autoOpen) {
    entry.autoOpen = true;
  }
  return entry;
}

function isParseableRegexSource(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize a raw `devServerPattern` value into the canonical persisted shape:
 * a single string/object entry or an array of entries. Returns `undefined`
 * when no valid entries remain.
 *
 * Rules:
 *   - Trim `pattern` strings; drop empty results.
 *   - Drop patterns longer than {@link MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH}.
 *   - Drop entries where `new RegExp(pattern)` throws.
 *   - Trim `label`; omit empty labels and labels longer than
 *     {@link MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH}.
 *   - Resolve `openTarget` permissively: only `'external'` is kept; `'in-app'`
 *     (the default) and any invalid value are dropped.
 *   - Keep `autoOpen` only when it is the boolean `true`.
 *   - Cap the resulting list at {@link MAX_SCRIPT_DEV_SERVER_PATTERNS}.
 *   - Preserve input order.
 *   - Object entries collapse to bare strings when they carry no label and no
 *     non-default `openTarget` or enabled `autoOpen`.
 *   - A single valid entry is returned bare (not wrapped in an array).
 */
export function normalizeScriptDevServerPattern(
  value: unknown,
): ScriptDevServerPattern | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const rawEntries: unknown[] = Array.isArray(value) ? value : [value];
  const normalized: ScriptDevServerPatternEntry[] = [];
  for (const rawEntry of rawEntries) {
    if (normalized.length >= MAX_SCRIPT_DEV_SERVER_PATTERNS) {
      break;
    }
    const entry = normalizeScriptDevServerPatternEntry(rawEntry);
    if (entry === undefined) {
      continue;
    }
    normalized.push(entry);
  }
  if (normalized.length === 0) {
    return undefined;
  }
  if (normalized.length === 1) {
    return normalized[0];
  }
  return normalized;
}

/**
 * Expand a persisted {@link ScriptDevServerPattern} into a flat, fully
 * object-shaped list in priority order, suitable for runtime evaluation
 * against script output lines.
 *
 * Every result carries a resolved `openTarget`: bare strings and object
 * entries without `openTarget` resolve to `'in-app'`; `'external'` is
 * preserved. Returns an empty array when there are no valid entries. The same
 * trimming, length, regex-parseability, and cap rules as
 * {@link normalizeScriptDevServerPattern} apply.
 */
export function normalizeScriptDevServerPatternsForRuntime(
  value: ScriptDevServerPattern | undefined,
): NormalizedScriptDevServerPattern[] {
  if (value === undefined) {
    return [];
  }
  const rawEntries: ScriptDevServerPatternEntry[] = Array.isArray(value)
    ? value
    : [value];
  const results: NormalizedScriptDevServerPattern[] = [];
  for (const rawEntry of rawEntries) {
    if (results.length >= MAX_SCRIPT_DEV_SERVER_PATTERNS) {
      break;
    }
    const entry = normalizeScriptDevServerPatternEntry(rawEntry);
    if (entry === undefined) {
      continue;
    }
    if (typeof entry === 'string') {
      results.push({ pattern: entry, openTarget: 'in-app' });
      continue;
    }
    const openTarget = entry.openTarget ?? 'in-app';
    const autoOpen = entry.autoOpen === true ? { autoOpen: true } : {};
    if (entry.label !== undefined) {
      results.push({
        pattern: entry.pattern,
        label: entry.label,
        openTarget,
        ...autoOpen,
      });
    } else {
      results.push({ pattern: entry.pattern, openTarget, ...autoOpen });
    }
  }
  return results;
}

/**
 * Normalize a {@link ScriptValue} into its canonical {@link ScriptDefinition}
 * form.
 *
 * - `string` values normalize to `{ command: trimmed }`; if the trimmed
 *   command is empty the result is `undefined`.
 * - object values trim their `command` and preserve `timeoutSeconds` only when
 *   it falls inside the supported range (see
 *   {@link normalizeScriptTimeoutSeconds}). An out-of-range timeout is dropped
 *   (treated as `undefined`).
 * - object values preserve `devServerPattern` after running it through
 *   {@link normalizeScriptDevServerPattern}; entirely invalid patterns drop
 *   off (treated as `undefined`).
 * - `null` is returned unchanged so callers can detect tombstones.
 * - `undefined` is returned unchanged so callers can skip the entry.
 */
export function normalizeScriptDefinition(
  value: ScriptValue | undefined,
): ScriptDefinition | null | undefined {
  if (value === null) {
    return null;
  }
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    return { command: trimmed };
  }
  if (!isScriptDefinition(value)) {
    return undefined;
  }
  const trimmed = value.command.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const definition: ScriptDefinition = { command: trimmed };
  if (value.interactive === true) {
    definition.interactive = true;
  }
  const timeoutSeconds = normalizeScriptTimeoutSeconds(value.timeoutSeconds);
  if (timeoutSeconds !== undefined) {
    definition.timeoutSeconds = timeoutSeconds;
  }
  if (value.devServerPattern !== undefined) {
    const devServerPattern = normalizeScriptDevServerPattern(
      value.devServerPattern,
    );
    if (devServerPattern !== undefined) {
      definition.devServerPattern = devServerPattern;
    }
  }
  const shell = normalizeCommandShellDefinition(value.shell);
  if (shell !== undefined) {
    definition.shell = shell;
  }
  return definition;
}

export function normalizeScriptInputMap(
  scripts: ScriptInputMap | ScriptOverrides | undefined,
): ScriptOverrides | undefined {
  if (!scripts) {
    return undefined;
  }

  const normalizedEntries: Array<[string, ScriptValue]> = [];
  for (const [rawName, rawValue] of Object.entries(scripts)) {
    const scriptName = normalizeScriptName(rawName);
    if (!scriptName) {
      continue;
    }
    const normalized = normalizeScriptDefinition(rawValue);
    if (normalized === undefined) {
      continue;
    }
    normalizedEntries.push([scriptName, toPersistedScriptValue(normalized)]);
  }

  normalizedEntries.sort((left, right) => {
    return compareScriptNames(left[0], right[0]);
  });

  if (normalizedEntries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(normalizedEntries);
}

/**
 * Resolve the canonical script definition (command + optional timeout) for the
 * given script name. Returns `undefined` for missing entries and null
 * tombstones.
 */
export function getScriptDefinition(
  scripts: ScriptOverrides | undefined,
  scriptName: string,
): ScriptDefinition | undefined {
  const value = scripts?.[scriptName];
  if (typeof value === 'string') {
    return { command: value };
  }
  if (isScriptDefinition(value)) {
    return value;
  }
  return undefined;
}

export function getScriptCommand(
  scripts: ScriptOverrides | undefined,
  scriptName: string,
): string | undefined {
  const value = scripts?.[scriptName];
  if (typeof value === 'string') {
    return value;
  }
  if (isScriptDefinition(value)) {
    return value.command;
  }
  return undefined;
}

/**
 * Return the configured `timeoutSeconds` for a script as stored on the
 * overrides record. Plain string overrides return `undefined` (use the global
 * default); object overrides return whatever the user persisted (a positive
 * integer or `null` for "disabled"). Missing entries and null tombstones
 * return `undefined`.
 */
export function getScriptTimeoutSeconds(
  scripts: ScriptOverrides | undefined,
  scriptName: string,
): number | null | undefined {
  const value = scripts?.[scriptName];
  if (isScriptDefinition(value)) {
    return value.timeoutSeconds;
  }
  return undefined;
}

/**
 * Return the configured `devServerPattern` for a script as stored on the
 * overrides record. Plain string overrides have no pattern attached and
 * return `undefined`; object overrides return whatever the user persisted.
 * Missing entries and null tombstones return `undefined`.
 *
 * The renderer and main process both call this helper against the same
 * effective scripts map so optimistic-start descriptors agree with the
 * descriptor the main process emits over IPC.
 */
export function getScriptDevServerPattern(
  scripts: ScriptOverrides | undefined,
  scriptName: string,
): ScriptDevServerPattern | undefined {
  const value = scripts?.[scriptName];
  if (isScriptDefinition(value)) {
    return value.devServerPattern;
  }
  return undefined;
}

export function getScriptShellDefinition(
  scripts: ScriptOverrides | undefined,
  scriptName: string,
): CommandShellDefinition | undefined {
  const value = scripts?.[scriptName];
  if (isScriptDefinition(value)) {
    return value.shell;
  }
  return undefined;
}

export function getScriptInteractive(
  scripts: ScriptOverrides | undefined,
  scriptName: string,
): boolean {
  const value = scripts?.[scriptName];
  return isScriptDefinition(value) && value.interactive === true;
}

/**
 * Whether the supplied script supports user-configurable timeouts. The
 * `launch` script is a long-running persistent process and must never time
 * out; its timeout control is always disabled in the settings UI.
 */
export function isScriptTimeoutConfigurable(scriptName: string): boolean {
  return scriptName !== 'launch';
}

/**
 * Whether the supplied script can run in an interactive terminal. Teardown
 * phases cannot: the worktree row is being archived/removed while they run, so
 * a PTY opened for them would be unreachable. The runner forces these back to
 * background regardless of any configured `interactive: true`, and the
 * settings UI locks the runtime picker to Background to match.
 */
export function isScriptInteractiveSupported(scriptName: string): boolean {
  return (
    scriptName !== 'teardown' &&
    scriptName !== 'before-teardown' &&
    scriptName !== 'after-teardown'
  );
}

/**
 * Single source of truth for how a configured `interactive` flag collapses into
 * the effective runner mode.
 */
export function resolveEffectiveScriptInteractive(args: {
  scriptName: string;
  configuredInteractive: boolean | undefined;
}): boolean {
  return (
    args.configuredInteractive === true &&
    isScriptInteractiveSupported(args.scriptName)
  );
}

/**
 * Single source of truth for how `timeoutSeconds` collapses into the effective
 * runner timeout. `launch` always resolves to `null` (no timeout) regardless
 * of any configured metadata.
 */
export function resolveEffectiveScriptTimeoutSeconds(args: {
  scriptName: string;
  configuredTimeoutSeconds?: number | null;
  defaultTimeoutSeconds: number;
}): number | null {
  if (!isScriptTimeoutConfigurable(args.scriptName)) {
    return null;
  }
  if (args.configuredTimeoutSeconds === null) {
    return null;
  }
  if (args.configuredTimeoutSeconds === undefined) {
    return args.defaultTimeoutSeconds;
  }
  return args.configuredTimeoutSeconds;
}

export function listRunnableScripts(
  scripts: ScriptOverrides | undefined,
): RunnableScriptEntry[] {
  if (!scripts) {
    return [];
  }

  const runnableEntries: RunnableScriptEntry[] = [];
  for (const [scriptName, scriptValue] of Object.entries(scripts)) {
    let command: string | undefined;
    let timeoutSeconds: number | null | undefined;
    let devServerPattern: ScriptDevServerPattern | undefined;
    let shell: CommandShellDefinition | undefined;
    let interactive: boolean | undefined;
    if (typeof scriptValue === 'string') {
      command = scriptValue;
    } else if (isScriptDefinition(scriptValue)) {
      command = scriptValue.command;
      timeoutSeconds = scriptValue.timeoutSeconds;
      devServerPattern = scriptValue.devServerPattern;
      shell = scriptValue.shell;
      interactive = scriptValue.interactive;
    } else {
      continue;
    }
    if (!command) {
      continue;
    }
    const entry: RunnableScriptEntry = {
      name: scriptName,
      command,
      lifecycle: isLifecycleScriptName(scriptName) ? scriptName : 'custom',
    };
    if (timeoutSeconds !== undefined) {
      entry.timeoutSeconds = timeoutSeconds;
    }
    if (devServerPattern !== undefined) {
      entry.devServerPattern = devServerPattern;
    }
    if (shell !== undefined) {
      entry.shell = shell;
    }
    if (interactive === true) {
      entry.interactive = true;
    }
    runnableEntries.push(entry);
  }

  runnableEntries.sort((left, right) =>
    compareScriptNames(left.name, right.name),
  );
  return runnableEntries;
}

export function getScriptDisplayName(scriptName: string): string {
  if (scriptName === 'setup') {
    return 'Setup';
  }
  if (scriptName === 'launch') {
    return 'Launch';
  }
  if (scriptName === 'teardown') {
    return 'Teardown';
  }

  return titleCaseIdentifier(scriptName);
}

export function createScriptEnvVarToken(name: string): string {
  return `$${name}`;
}

export function createScriptKey(
  scope: ScriptScope,
  scriptName: string,
  repoId?: string,
): string {
  if (scope === 'workspace-root') {
    return `workspace-root:${scriptName}`;
  }

  if (scope === 'workspace-repo') {
    if (!repoId) {
      throw new Error('repoId is required for workspace-repo script keys');
    }
    return `workspace-repo:${repoId}:${scriptName}`;
  }

  return `project:${scriptName}`;
}

export function parseScriptKey(
  scriptKey: string,
): { scope: ScriptScope; scriptName: string; repoId?: string } | null {
  if (scriptKey.startsWith('project:')) {
    const scriptName = scriptKey.slice('project:'.length);
    if (scriptName.length === 0) {
      return null;
    }
    return {
      scope: 'project',
      scriptName,
    };
  }

  if (scriptKey.startsWith('workspace-root:')) {
    const scriptName = scriptKey.slice('workspace-root:'.length);
    if (scriptName.length === 0) {
      return null;
    }
    return {
      scope: 'workspace-root',
      scriptName,
    };
  }

  if (scriptKey.startsWith('workspace-repo:')) {
    const parsed = parseWorkspaceRepoScopedValue(scriptKey, 'workspace-repo:');
    if (!parsed) {
      return null;
    }
    return {
      scope: 'workspace-repo',
      repoId: parsed.repoId,
      scriptName: parsed.scopedValue,
    };
  }

  return null;
}

/**
 * Compact a canonical {@link ScriptDefinition} (or tombstone) into the form
 * actually written to disk. Definitions without any optional metadata
 * (`timeoutSeconds`, `devServerPattern`, `shell`) round-trip as bare command strings
 * so existing files stay readable by older versions of the app and unchanged
 * on disk after a no-op edit.
 *
 * Keys are emitted in the fixed order `command`, `interactive`,
 * `timeoutSeconds`, `devServerPattern`, `shell` so `JSON.stringify`-based
 * dirty-state comparisons stay deterministic (consistent with the existing
 * `editableScriptToScriptValue`
 * contract). The `devServerPattern` value is already canonicalized by
 * {@link normalizeScriptDevServerPattern} before it reaches here — including
 * `openTarget` resolution (only `'external'` survives) — so it is persisted
 * verbatim and round-trips deterministically.
 */
function toPersistedScriptValue(value: ScriptDefinition | null): ScriptValue {
  if (value === null) {
    return null;
  }
  if (
    value.interactive !== true &&
    value.timeoutSeconds === undefined &&
    value.devServerPattern === undefined &&
    value.shell === undefined
  ) {
    return value.command;
  }
  const persisted: ScriptDefinition = { command: value.command };
  if (value.interactive === true) {
    persisted.interactive = true;
  }
  if (value.timeoutSeconds !== undefined) {
    persisted.timeoutSeconds = value.timeoutSeconds;
  }
  if (value.devServerPattern !== undefined) {
    persisted.devServerPattern = value.devServerPattern;
  }
  if (value.shell !== undefined) {
    persisted.shell = value.shell;
  }
  return persisted;
}

function compareScriptNames(left: string, right: string): number {
  return compareIndexedNames(left, right, getLifecycleIndex);
}

function getLifecycleIndex(scriptName: string): number {
  if (scriptName === 'before-setup') {
    return 0;
  }
  if (scriptName === 'setup') {
    return 1;
  }
  if (scriptName === 'after-setup') {
    return 2;
  }
  if (scriptName === 'before-launch') {
    return 3;
  }
  if (scriptName === 'launch') {
    return 4;
  }
  if (scriptName === 'after-launch') {
    return 5;
  }
  if (scriptName === 'before-teardown') {
    return 6;
  }
  if (scriptName === 'teardown') {
    return 7;
  }
  if (scriptName === 'after-teardown') {
    return 8;
  }
  return -1;
}
