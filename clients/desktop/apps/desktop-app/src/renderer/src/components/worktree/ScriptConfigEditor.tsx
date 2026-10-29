import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react';
import { ToggleSwitch } from '@canopy/ui-shared';
import {
  MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH,
  MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH,
  MAX_SCRIPT_DEV_SERVER_PATTERNS,
  SCRIPT_ENV_VISIBLE_VAR_DEFINITIONS,
  isMacCommandShell,
  isScriptInteractiveSupported,
  isScriptTimeoutConfigurable,
  isWindowsCommandShell,
  type CommandShellDefinition,
} from '@canopy/desktop-shared/scripts';
import {
  createScriptEnvVarInsertion,
  insertTextAtSelection,
} from '@/lib/scriptEditor';
import {
  createEmptyEditableDevServerPattern,
  type EditableDevServerPattern,
} from '@/lib/editableScripts';
import {
  getCustomTimeoutDraft,
  parseCustomTimeoutDraft,
} from '@/lib/scriptConfigTimeout';
import { brandText } from '@/lib/brand';
import { VariableInsertDropdown } from './VariableInsertDropdown';
import {
  RuntimeModePicker,
  type CommandRuntimeMode,
} from './RuntimeModePicker';

/**
 * Tri-state for the timeout segmented control:
 *
 *   - `default`  → `timeoutSeconds === undefined` (use the global default).
 *   - `custom`   → `timeoutSeconds` is a positive integer.
 *   - `disabled` → `timeoutSeconds === null` (no timeout).
 */
export type ScriptTimeoutMode = 'default' | 'custom' | 'disabled';

export interface ScriptConfigEditorProps {
  label: string;
  scriptName: string;
  command: string;
  timeoutSeconds?: number | null;
  onCommandChange: (next: string) => void;
  onTimeoutSecondsChange: (next: number | null | undefined) => void;
  interactive?: boolean;
  onInteractiveChange?: (next: boolean) => void;
  shell?: CommandShellDefinition;
  onShellChange?: (next: CommandShellDefinition | undefined) => void;
  placeholder?: string;
  rows?: number;
  defaultTimeoutSeconds: number;
  /**
   * Editor-side dev-server pattern list for this script. `undefined` means
   * "no patterns configured" (the user has never touched the section);
   * an empty array means "an explicitly empty list" — both canonicalize back
   * to `undefined` on save.
   */
  devServerPatterns?: EditableDevServerPattern[];
  /**
   * Receive an updated dev-server pattern list. Pass `undefined` to clear the
   * list back to the un-configured state.
   */
  onDevServerPatternsChange?: (
    next: EditableDevServerPattern[] | undefined,
  ) => void;
  /**
   * Surfaces row-level validity to the parent so the parent can disable Save.
   * Empty array means "all rows are valid (or trivially empty)". Non-empty
   * array lists offending row ids. When patterns are not configured, the
   * editor reports an empty array so the parent can clear stale validity state.
   */
  onDevServerPatternsValidityChange?: (invalidRowIds: string[]) => void;
  /**
   * Stable identifier for the parent validity bucket represented by this
   * editor. When local/source settings swap in-place, this lets the editor
   * clear the old bucket before reporting rows for the new one.
   */
  devServerPatternsValidityScopeKey?: string;
}

function deriveMode(
  timeoutSeconds: number | null | undefined,
): ScriptTimeoutMode {
  if (timeoutSeconds === null) {
    return 'disabled';
  }
  if (typeof timeoutSeconds === 'number') {
    return 'custom';
  }
  return 'default';
}

function formatDefaultHelper(defaultTimeoutSeconds: number): string {
  if (defaultTimeoutSeconds <= 0) {
    return 'Uses the global script timeout.';
  }
  const minutes = defaultTimeoutSeconds / 60;
  if (Number.isInteger(minutes)) {
    return `Uses the global script timeout (${minutes} ${
      minutes === 1 ? 'minute' : 'minutes'
    }).`;
  }
  return `Uses the global script timeout (${defaultTimeoutSeconds} seconds).`;
}

interface TimeoutSegmentedControlProps {
  mode: ScriptTimeoutMode;
  onChange: (next: ScriptTimeoutMode) => void;
  disabled: boolean;
  describedById?: string;
}

function TimeoutSegmentedControl({
  mode,
  onChange,
  disabled,
  describedById,
}: TimeoutSegmentedControlProps): JSX.Element {
  const renderOption = (
    value: ScriptTimeoutMode,
    label: string,
  ): JSX.Element => {
    const isActive = mode === value;
    return (
      <button
        key={value}
        type="button"
        role="radio"
        aria-checked={isActive}
        disabled={disabled}
        onClick={() => {
          if (disabled || mode === value) {
            return;
          }
          onChange(value);
        }}
        className={`focus-ring rounded-md px-2 py-1 text-2xs font-medium transition-colors ${
          isActive ? 'bg-card fg-primary' : 'fg-secondary hover:fg-primary'
        } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
      >
        {label}
      </button>
    );
  };

  return (
    <div
      role="radiogroup"
      aria-describedby={describedById}
      className={`inline-flex rounded-lg border bg-secondary p-0.5 ${
        disabled ? 'opacity-80' : ''
      }`}
    >
      {renderOption('default', 'Default')}
      {renderOption('custom', 'Custom')}
      {renderOption('disabled', 'Disabled')}
    </div>
  );
}

export function ScriptConfigEditor({
  label,
  scriptName,
  command,
  timeoutSeconds,
  onCommandChange,
  onTimeoutSecondsChange,
  interactive = false,
  onInteractiveChange,
  shell,
  onShellChange,
  placeholder,
  rows = 3,
  defaultTimeoutSeconds,
  devServerPatterns,
  onDevServerPatternsChange,
  onDevServerPatternsValidityChange,
  devServerPatternsValidityScopeKey,
}: ScriptConfigEditorProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const selectionRef = useRef({
    start: 0,
    end: 0,
  });
  const helperId = useId();

  const isTimeoutConfigurable = isScriptTimeoutConfigurable(scriptName);
  const isTimeoutControlDisabled = !isTimeoutConfigurable;
  const mode: ScriptTimeoutMode = isTimeoutControlDisabled
    ? 'disabled'
    : deriveMode(timeoutSeconds);

  // Track a local draft of the Custom number input so users can type
  // freely (including clearing the field to retype) without churning the
  // upstream model on every keystroke. Synced to props when the configured
  // timeoutSeconds changes externally.
  const [customDraft, setCustomDraft] = useState<string>(() =>
    getCustomTimeoutDraft(timeoutSeconds),
  );

  useEffect(() => {
    setCustomDraft(getCustomTimeoutDraft(timeoutSeconds));
  }, [timeoutSeconds]);

  const rememberSelection = (): void => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    selectionRef.current = {
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
    };
  };

  const insertVariable = (variableName: string): void => {
    const insertedText = createScriptEnvVarInsertion(variableName);
    const nextSelection =
      textareaRef.current && document.activeElement === textareaRef.current
        ? {
            start: textareaRef.current.selectionStart,
            end: textareaRef.current.selectionEnd,
          }
        : selectionRef.current;
    const insertion = insertTextAtSelection({
      value: command,
      insertedText,
      selectionStart: nextSelection.start,
      selectionEnd: nextSelection.end,
    });

    onCommandChange(insertion.value);

    requestAnimationFrame((): void => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }

      textarea.focus();
      textarea.selectionStart = insertion.cursorPosition;
      textarea.selectionEnd = insertion.cursorPosition;
      selectionRef.current = {
        start: insertion.cursorPosition,
        end: insertion.cursorPosition,
      };
    });
  };

  const handleModeChange = (next: ScriptTimeoutMode): void => {
    if (next === mode) {
      return;
    }
    if (next === 'default') {
      onTimeoutSecondsChange(undefined);
      return;
    }
    if (next === 'disabled') {
      onTimeoutSecondsChange(null);
      return;
    }
    // Switching to Custom commits whatever the user previously typed,
    // falling back to the global default so the saved value is meaningful
    // even before the user touches the input.
    const parsed = parseCustomTimeoutDraft(customDraft);
    if (parsed !== undefined) {
      onTimeoutSecondsChange(parsed);
      return;
    }
    onTimeoutSecondsChange(defaultTimeoutSeconds);
  };

  const handleCustomInputChange = (raw: string): void => {
    const parsed = parseCustomTimeoutDraft(raw);
    if (raw.length > 0 && parsed === undefined) {
      return;
    }
    setCustomDraft(raw);
    if (raw.length === 0) {
      // Allow temporary blank state while editing; do not collapse the mode.
      return;
    }
    onTimeoutSecondsChange(parsed);
  };

  // Teardown lifecycles always use the background runner because archival
  // makes their worktree terminal inaccessible. Lock the picker to Background
  // and keep their real timeout visible even if older configuration persisted
  // `interactive: true`.
  const interactiveSupported = isScriptInteractiveSupported(scriptName);
  const runtimeMode: CommandRuntimeMode =
    interactive && interactiveSupported ? 'interactive' : 'background';
  const showTimeoutControl = runtimeMode === 'background';
  // Teardown editors are rendered without an `onInteractiveChange` handler
  // because there is nothing to change; the locked picker still renders so the
  // forced runtime is visible rather than silently missing.
  const showRuntimePicker =
    Boolean(onInteractiveChange) || !interactiveSupported;

  const helperText = !isTimeoutConfigurable
    ? 'Launch scripts are persistent and do not time out.'
    : mode === 'disabled'
      ? 'This script will keep running until it exits or is stopped.'
      : mode === 'custom'
        ? undefined
        : formatDefaultHelper(defaultTimeoutSeconds);

  return (
    <div className="space-y-2">
      <label className="block text-s">
        <span className="mb-1.5 block text-xs fg-secondary">{label}</span>
        <textarea
          ref={textareaRef}
          value={command}
          onChange={(event) => onCommandChange(event.target.value)}
          onSelect={rememberSelection}
          onClick={rememberSelection}
          onKeyUp={rememberSelection}
          placeholder={placeholder}
          rows={rows}
          className="focus-ring w-full resize-y rounded-lg border bg-base px-3 py-2 font-mono text-xs"
        />
      </label>

      <VariableInsertDropdown
        variables={SCRIPT_ENV_VISIBLE_VAR_DEFINITIONS}
        onInsert={insertVariable}
      />

      {showRuntimePicker && (
        <RuntimeModePicker
          mode={runtimeMode}
          onChange={(next) => onInteractiveChange?.(next === 'interactive')}
          interactiveDescription="Run this script in the project terminal so it can accept input."
          disabled={!interactiveSupported}
          disabledReason="Teardown scripts can only be run as background commands."
          testId="script-runtime-mode"
          ariaLabel={`${label} runtime`}
        />
      )}

      {showTimeoutControl && (
        <div className="space-y-1.5 pt-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-2xs font-medium fg-secondary">Timeout</span>
            <TimeoutSegmentedControl
              mode={mode}
              onChange={handleModeChange}
              disabled={isTimeoutControlDisabled}
              describedById={helperText ? helperId : undefined}
            />
            {!isTimeoutControlDisabled && mode === 'custom' && (
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  value={customDraft}
                  placeholder="300"
                  aria-label={`${label} timeout in seconds`}
                  onChange={(event) =>
                    handleCustomInputChange(event.target.value)
                  }
                  onBlur={() => {
                    if (customDraft.trim().length === 0) {
                      // Snap back to the last committed numeric value (or the
                      // global default if we never had one) so the input is
                      // never left visually empty in Custom mode.
                      const fallback =
                        typeof timeoutSeconds === 'number'
                          ? timeoutSeconds
                          : defaultTimeoutSeconds;
                      setCustomDraft(String(fallback));
                      if (typeof timeoutSeconds !== 'number') {
                        onTimeoutSecondsChange(defaultTimeoutSeconds);
                      }
                    }
                  }}
                  className="focus-ring w-24 rounded-lg border bg-base px-2 py-1 text-xs"
                />
                <span className="text-2xs fg-secondary">seconds</span>
              </div>
            )}
          </div>
          {helperText && (
            <p id={helperId} className="text-2xs fg-secondary">
              {helperText}
            </p>
          )}
        </div>
      )}

      {onShellChange && (
        <ShellSelectionSection
          label={label}
          shell={shell}
          onChange={onShellChange}
        />
      )}

      {onDevServerPatternsChange && (
        <DevServerPatternsSection
          patterns={devServerPatterns}
          onChange={onDevServerPatternsChange}
          onValidityChange={onDevServerPatternsValidityChange}
          validityScopeKey={devServerPatternsValidityScopeKey}
        />
      )}
    </div>
  );
}

function updateShellPlatform(
  shell: CommandShellDefinition | undefined,
  platform: 'windows' | 'mac',
  value: string,
): CommandShellDefinition | undefined {
  const next: CommandShellDefinition = { ...(shell ?? {}) };
  if (platform === 'windows') {
    if (isWindowsCommandShell(value)) {
      next.windows = value;
    } else {
      delete next.windows;
    }
  } else if (isMacCommandShell(value)) {
    next.mac = value;
  } else {
    delete next.mac;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function ShellSelectionSection({
  label,
  shell,
  onChange,
}: {
  label: string;
  shell: CommandShellDefinition | undefined;
  onChange: (next: CommandShellDefinition | undefined) => void;
}): JSX.Element {
  const shellRef = useRef(shell);
  useEffect(() => {
    shellRef.current = shell;
  }, [shell]);

  const updatePlatform = (platform: 'windows' | 'mac', value: string): void => {
    const next = updateShellPlatform(shellRef.current, platform, value);
    // React may batch the two platform selects before the parent rerenders.
    // Retain the eagerly emitted value so the second change merges with the
    // first instead of rebuilding from a stale prop snapshot.
    shellRef.current = next;
    onChange(next);
  };

  return (
    <div className="space-y-1.5 pt-1">
      <span className="text-2xs font-medium fg-secondary">Shell</span>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-s">
          <span className="mb-1 block text-2xs fg-secondary">Windows</span>
          <select
            aria-label={`${label} Windows shell`}
            value={shell?.windows ?? ''}
            onChange={(event) => updatePlatform('windows', event.target.value)}
            className="focus-ring h-8 w-full rounded-lg border bg-base px-2 text-xs"
          >
            <option value="">Default</option>
            <option value="cmd">Command Prompt</option>
            <option value="powershell">PowerShell</option>
            <option value="bash">Git Bash</option>
          </select>
        </label>
        <label className="block text-s">
          <span className="mb-1 block text-2xs fg-secondary">Mac</span>
          <select
            aria-label={`${label} Mac shell`}
            value={shell?.mac ?? ''}
            onChange={(event) => updatePlatform('mac', event.target.value)}
            className="focus-ring h-8 w-full rounded-lg border bg-base px-2 text-xs"
          >
            <option value="">Default</option>
            <option value="zsh">zsh</option>
            <option value="bash">bash</option>
          </select>
        </label>
      </div>
    </div>
  );
}

interface DevServerPatternsSectionProps {
  patterns: EditableDevServerPattern[] | undefined;
  onChange: (next: EditableDevServerPattern[] | undefined) => void;
  onValidityChange?: (invalidRowIds: string[]) => void;
  validityScopeKey?: string;
}

function isRegexParseable(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

function DevServerPatternsSection({
  patterns,
  onChange,
  onValidityChange,
  validityScopeKey,
}: DevServerPatternsSectionProps): JSX.Element {
  const list = useMemo(() => patterns ?? [], [patterns]);
  const atCap = list.length >= MAX_SCRIPT_DEV_SERVER_PATTERNS;

  const invalidRowIds = useMemo<string[]>(() => {
    const invalid: string[] = [];
    for (const row of list) {
      const trimmed = row.pattern.trim();
      if (trimmed.length === 0) {
        // Empty rows are dropped silently by save canonicalization; do not
        // mark them invalid (mirrors the existing command-textarea contract).
        continue;
      }
      if (trimmed.length > MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH) {
        invalid.push(row.id);
        continue;
      }
      if (!isRegexParseable(trimmed)) {
        invalid.push(row.id);
        continue;
      }
      if (row.label.trim().length > MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH) {
        invalid.push(row.id);
      }
    }
    return invalid;
  }, [list]);
  const onValidityChangeRef = useRef(onValidityChange);
  const validityScopeKeyRef = useRef(validityScopeKey);

  useEffect(() => {
    const previousScopeKey = validityScopeKeyRef.current;
    const previousValidityChange = onValidityChangeRef.current;
    if (previousScopeKey !== validityScopeKey) {
      previousValidityChange?.([]);
      validityScopeKeyRef.current = validityScopeKey;
    }
    onValidityChangeRef.current = onValidityChange;
  }, [onValidityChange, validityScopeKey]);

  useEffect(() => {
    onValidityChange?.(invalidRowIds);
  }, [invalidRowIds, onValidityChange]);

  useEffect(() => {
    return (): void => {
      onValidityChangeRef.current?.([]);
    };
  }, []);

  const updateRow = (
    index: number,
    next: Partial<
      Pick<
        EditableDevServerPattern,
        'pattern' | 'label' | 'openTarget' | 'autoOpen'
      >
    >,
  ): void => {
    const nextList = list.map((row, i) =>
      i === index ? { ...row, ...next } : row,
    );
    onChange(nextList);
  };

  const removeRow = (index: number): void => {
    const nextList = list.filter((_, i) => i !== index);
    onChange(nextList.length === 0 ? undefined : nextList);
  };

  const moveRow = (index: number, direction: -1 | 1): void => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= list.length) {
      return;
    }
    const nextList = [...list];
    const [moved] = nextList.splice(index, 1);
    nextList.splice(targetIndex, 0, moved);
    onChange(nextList);
  };

  const addRow = (): void => {
    if (atCap) {
      return;
    }
    const nextList = [...list, createEmptyEditableDevServerPattern()];
    onChange(nextList);
  };

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div>
        <p className="text-xs font-medium fg-primary">Dev server patterns</p>
        <p className="mt-1 text-2xs fg-secondary">
          Optional regex patterns. The first capture group, or the full match,
          must be an http(s) URL. Patterns are checked in order, and the first
          match labels the detected URL.
        </p>
        <p className="mt-1 text-2xs fg-secondary">
          In {brandText.shortName} opens links in the Browser tab. URLs blocked
          by the Browser settings open externally.
        </p>
        <p className="mt-1 text-2xs fg-secondary">
          Auto open opens each detected URL once per script run.
        </p>
      </div>
      {list.length === 0 ? (
        <p className="text-2xs fg-secondary">No dev server patterns</p>
      ) : (
        <ul className="space-y-2">
          {list.map((row, index) => {
            const trimmed = row.pattern.trim();
            const regexInvalid =
              trimmed.length > 0 && !isRegexParseable(trimmed);
            const patternTooLong =
              trimmed.length > MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH;
            const labelTooLong =
              row.label.trim().length > MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH;
            const inputInvalid = regexInvalid || patternTooLong || labelTooLong;
            const isFirst = index === 0;
            const isLast = index === list.length - 1;
            return (
              <li key={row.id} className="space-y-1.5 rounded border p-2">
                <div className="grid gap-2 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto]">
                  <label className="block text-xs">
                    <span className="mb-1 block text-2xs fg-secondary">
                      Pattern
                    </span>
                    <input
                      type="text"
                      value={row.pattern}
                      onChange={(event) =>
                        updateRow(index, { pattern: event.target.value })
                      }
                      placeholder={'https?://localhost:\\d+\\S*'}
                      maxLength={MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH}
                      aria-invalid={inputInvalid || undefined}
                      className="focus-ring w-full rounded-lg border bg-base px-2 py-1 font-mono text-2xs"
                    />
                  </label>
                  <label className="block text-xs">
                    <span className="mb-1 block text-2xs fg-secondary">
                      Label
                    </span>
                    <input
                      type="text"
                      value={row.label}
                      onChange={(event) =>
                        updateRow(index, { label: event.target.value })
                      }
                      placeholder="Web app"
                      maxLength={MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH}
                      aria-invalid={labelTooLong || undefined}
                      className="focus-ring w-full rounded-lg border bg-base px-2 py-1 text-2xs"
                    />
                  </label>
                  <div className="flex items-end gap-1">
                    <button
                      type="button"
                      onClick={(): void => moveRow(index, -1)}
                      disabled={isFirst}
                      aria-label="Move dev server pattern up"
                      className="focus-ring rounded-md border bg-base px-1.5 py-1 text-2xs fg-primary disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={(): void => moveRow(index, 1)}
                      disabled={isLast}
                      aria-label="Move dev server pattern down"
                      className="focus-ring rounded-md border bg-base px-1.5 py-1 text-2xs fg-primary disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={(): void => removeRow(index)}
                      className="focus-ring rounded-md border bg-base px-2 py-1 text-2xs fg-destructive hover:bg-destructive-subtle"
                    >
                      Remove
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-2xs fg-secondary">Open</span>
                  <div
                    role="group"
                    aria-label="Open target"
                    className="inline-flex overflow-hidden rounded-md border"
                  >
                    {(
                      [
                        { value: 'in-app', label: `In ${brandText.shortName}` },
                        { value: 'external', label: 'External' },
                      ] as const
                    ).map((option) => {
                      const selected = row.openTarget === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          aria-pressed={selected}
                          onClick={(): void =>
                            updateRow(index, { openTarget: option.value })
                          }
                          className={`focus-ring px-2 py-1 text-2xs font-medium transition ${
                            selected
                              ? 'bg-accent fg-emphasis'
                              : 'bg-base fg-primary hover:bg-fg-primary/[0.05]'
                          }`}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <span className="text-2xs fg-secondary">Auto open</span>
                    <ToggleSwitch
                      label="Auto open detected URL"
                      checked={row.autoOpen === true}
                      onChange={(autoOpen): void =>
                        updateRow(index, { autoOpen })
                      }
                      dataTestId="dev-server-pattern-auto-open"
                    />
                  </div>
                </div>
                {regexInvalid && (
                  <p className="text-2xs fg-destructive">Invalid regex</p>
                )}
                {patternTooLong && (
                  <p className="text-2xs fg-destructive">
                    Pattern is too long (max{' '}
                    {MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH} characters)
                  </p>
                )}
                {labelTooLong && (
                  <p className="text-2xs fg-destructive">
                    Label is too long (max {MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH}{' '}
                    characters)
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={addRow}
          disabled={atCap}
          aria-disabled={atCap || undefined}
          className="focus-ring rounded-md border bg-base px-2 py-1 text-2xs font-medium fg-primary hover:bg-fg-primary/[0.05] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Add pattern
        </button>
        {atCap && (
          <span className="text-2xs fg-secondary">
            Maximum {MAX_SCRIPT_DEV_SERVER_PATTERNS} patterns
          </span>
        )}
      </div>
    </div>
  );
}
