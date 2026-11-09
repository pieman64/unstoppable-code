import type { SecureStorageFailure } from '@canopy/execution-engine/types/secure-storage';
import {
  type ChangeEvent,
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  isStoredSecretValue,
  type StoredSecretValue,
  type UserEnvironmentEntryView,
  type UserEnvironmentUiMode,
} from '@canopy/desktop-shared/types';
import {
  isReservedUserEnvironmentKey,
  isValidUserEnvironmentKey,
  parseBulkEnvironment,
  serializeBulkEnvironment,
} from '@canopy/desktop-shared/lib/user-environment';
import {
  Stack,
  Button,
  Checkbox,
  FieldError,
  Notice,
  TextArea,
  TextInput,
} from '@canopy/ui-shared/components';
import { SettingsSegmentedControl } from '@/components/settings/SettingsLayout';
import { brandText } from '@/lib/brand';

interface EditorRow {
  id: string;
  key: string;
  /** Typed text. For a stored row, empty keeps the stored value. */
  value: string;
  secret: boolean;
  /** The saved secret this row keeps until the user types a replacement. */
  stored?: StoredSecretValue;
}

interface EnvironmentVariableEditorProps {
  /** Current variables; the editor stays controlled by the parent. */
  variables: ReadonlyArray<UserEnvironmentEntryView>;
  /** Persisted preference for which sub-editor to show first. */
  uiMode: UserEnvironmentUiMode;
  /**
   * Whether the parent has confirmed encryption is available. Drives the
   * banner copy that warns when values would persist in plaintext.
   */
  encryptionAvailable: boolean;
  storageFailure?: SecureStorageFailure | null;
  /**
   * `inline` (default) shows the encryption status above the editor. `host`
   * leaves it to the host, which puts it in its section description (and the
   * unavailable warning above its card), outside the settings card.
   */
  encryptionStatus?: 'inline' | 'host';
  /** Disable editing (e.g. while loading). */
  readOnly?: boolean;
  /** Test id passed through for renderer tests. */
  testId?: string;
  onVariablesChange: (entries: UserEnvironmentEntryView[]) => void;
  onUiModeChange?: (mode: UserEnvironmentUiMode) => void;
  /**
   * Reports a single inline validation message (PATH reserved, invalid key,
   * duplicate keys, bulk mode parse error) so the parent can disable save
   * when the editor is in an invalid state.
   */
  onValidationChange?: (message: string | null) => void;
}

const RESERVED_PATH_MESSAGE = `PATH is managed by ${brandText.appName} and cannot be overridden here.`;
const INVALID_KEY_MESSAGE =
  'Use letters, numbers, and underscores. Keys cannot start with a number.';
const DUPLICATE_KEY_MESSAGE = 'Duplicate keys must be removed before saving.';
const MODE_SWITCH_BLOCKED_MESSAGE = 'Fix the error below to switch.';
const BULK_MESSAGE_ID = 'environment-editor-bulk-message';
const BULK_HELPER_TEXT =
  'One KEY=VALUE per line. Blank lines and # comments are ignored. Values may be wrapped in matching quotes. Duplicate keys must be removed before saving.';
const STORED_VALUE_PLACEHOLDER = 'Saved. Type to replace';
const STORED_SECRET_LOCKED_MESSAGE =
  'Type a new value before unmarking a saved secret.';

function makeRowId(): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }
  return `env-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function entriesToRows(
  entries: ReadonlyArray<UserEnvironmentEntryView>,
): EditorRow[] {
  return entries.map((entry) => ({
    id: makeRowId(),
    key: entry.key,
    secret: entry.secret === true,
    ...(isStoredSecretValue(entry.value)
      ? { value: '', stored: entry.value }
      : { value: entry.value }),
  }));
}

function keepsStoredValue(row: EditorRow): row is EditorRow & {
  stored: StoredSecretValue;
} {
  return row.stored !== undefined && row.value.length === 0;
}

/**
 * Same rules as `normalizeUserEnvironmentEntries` (trimmed valid keys, last
 * duplicate wins), keeping stored-secret values intact.
 */
function normalizeEntryViews(
  entries: ReadonlyArray<UserEnvironmentEntryView>,
): UserEnvironmentEntryView[] {
  const byKey = new Map<string, UserEnvironmentEntryView>();
  for (const entry of entries) {
    const key = entry.key.trim();
    if (!isValidUserEnvironmentKey(key) || isReservedUserEnvironmentKey(key)) {
      continue;
    }
    byKey.set(key, {
      key,
      value: entry.value,
      ...(entry.secret === true ? { secret: true } : {}),
    });
  }
  return Array.from(byKey.values());
}

function rowsToEntries(
  rows: ReadonlyArray<EditorRow>,
): UserEnvironmentEntryView[] {
  return normalizeEntryViews(
    rows.map((row) => ({
      key: row.key,
      value: keepsStoredValue(row) ? row.stored : row.value,
      // A kept value stays secret; main refuses to reveal it.
      secret: keepsStoredValue(row) || row.secret,
    })),
  );
}

/** Identity of the entries, including kept references and secret marks. */
function entriesSignature(
  entries: ReadonlyArray<UserEnvironmentEntryView>,
): string {
  return JSON.stringify(
    entries.map((entry) => [
      entry.key,
      isStoredSecretValue(entry.value) ? { ref: entry.value.ref } : entry.value,
      entry.secret === true,
    ]),
  );
}

function plaintextEntries(
  entries: ReadonlyArray<UserEnvironmentEntryView>,
): { key: string; value: string; secret?: boolean }[] {
  return entries.flatMap((entry) =>
    typeof entry.value === 'string' ? [{ ...entry, value: entry.value }] : [],
  );
}

/**
 * Bulk text holds only text values. Saved secrets stay out of it, unchanged:
 * a line may not name one (see `bulkValidationMessage`), so bulk editing can
 * neither replace nor drop them. A line for a key that was secret stays
 * secret.
 */
function entriesFromBulk(
  text: string,
  previous: ReadonlyArray<UserEnvironmentEntryView>,
): UserEnvironmentEntryView[] {
  const secretKeys = new Set(
    previous.filter((entry) => entry.secret === true).map((entry) => entry.key),
  );
  return normalizeEntryViews([
    ...previous.filter((entry) => isStoredSecretValue(entry.value)),
    ...parseBulkEnvironment(text).map((entry) =>
      secretKeys.has(entry.key) ? { ...entry, secret: true } : entry,
    ),
  ]);
}

function storedSecretKeys(
  entries: ReadonlyArray<UserEnvironmentEntryView>,
): Set<string> {
  return new Set(
    entries
      .filter((entry) => isStoredSecretValue(entry.value))
      .map((entry) => entry.key),
  );
}

function basicRowValidationMessage(row: EditorRow): string | null {
  const key = row.key.trim();
  if (key.length === 0) {
    return row.value.length > 0 || row.stored !== undefined
      ? 'Key is required.'
      : null;
  }
  if (isReservedUserEnvironmentKey(key)) {
    return RESERVED_PATH_MESSAGE;
  }
  if (!isValidUserEnvironmentKey(key)) {
    return INVALID_KEY_MESSAGE;
  }
  return null;
}

function rowValidationMessages(
  rows: ReadonlyArray<EditorRow>,
): Map<string, string> {
  const keyCounts = new Map<string, number>();
  for (const row of rows) {
    const key = row.key.trim();
    if (
      key.length > 0 &&
      isValidUserEnvironmentKey(key) &&
      !isReservedUserEnvironmentKey(key)
    ) {
      keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    }
  }

  const messages = new Map<string, string>();
  for (const row of rows) {
    const basicMessage = basicRowValidationMessage(row);
    if (basicMessage !== null) {
      messages.set(row.id, basicMessage);
      continue;
    }
    const key = row.key.trim();
    if (key.length > 0 && (keyCounts.get(key) ?? 0) > 1) {
      messages.set(row.id, DUPLICATE_KEY_MESSAGE);
    }
  }
  return messages;
}

function bulkValidationMessage(
  text: string,
  storedKeys: ReadonlySet<string>,
): string | null {
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    let line = rawLine.trimStart();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    if (line.startsWith('export ')) {
      line = line.slice('export '.length).trimStart();
    }
    const equalsIndex = line.indexOf('=');
    if (equalsIndex <= 0) {
      return 'Every non-comment bulk line must use KEY=VALUE.';
    }
    const key = line.slice(0, equalsIndex).trim();
    if (isReservedUserEnvironmentKey(key)) {
      return RESERVED_PATH_MESSAGE;
    }
    if (!isValidUserEnvironmentKey(key)) {
      return INVALID_KEY_MESSAGE;
    }
    if (storedKeys.has(key)) {
      return `${key} is a saved secret. Edit it in Key-Value.`;
    }
    if (seen.has(key)) {
      return DUPLICATE_KEY_MESSAGE;
    }
    seen.add(key);
  }
  return null;
}

export function EnvironmentVariableEditor({
  variables,
  uiMode,
  encryptionAvailable,
  storageFailure,
  encryptionStatus = 'inline',
  readOnly,
  testId,
  onVariablesChange,
  onUiModeChange,
  onValidationChange,
}: EnvironmentVariableEditorProps): JSX.Element {
  const [rows, setRows] = useState<EditorRow[]>(() => entriesToRows(variables));
  const [bulkText, setBulkText] = useState<string>(() =>
    serializeBulkEnvironment(plaintextEntries(variables)),
  );
  const lastEmittedSignature = useRef<string | null>(null);
  // The entries bulk text edits on top of: set when bulk text is (re)built,
  // never from the editor's own emissions, so a saved secret survives a line
  // that named its key and was later removed.
  const [bulkBase, setBulkBase] =
    useState<ReadonlyArray<UserEnvironmentEntryView>>(variables);
  const storedKeys = useMemo(() => storedSecretKeys(bulkBase), [bulkBase]);

  // Re-sync from parent when the variables change (e.g. a different
  // environment is selected). Compare by signature so identical content does
  // not clobber in-flight edits.
  const variablesSignature = useMemo(
    () => entriesSignature(variables),
    [variables],
  );
  useEffect(() => {
    if (lastEmittedSignature.current === variablesSignature) {
      lastEmittedSignature.current = null;
      return;
    }
    setRows(entriesToRows(variables));
    setBulkText(serializeBulkEnvironment(plaintextEntries(variables)));
    setBulkBase(variables);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variablesSignature]);

  const rowMessages = useMemo(() => rowValidationMessages(rows), [rows]);
  const bulkMessage = useMemo(
    () => bulkValidationMessage(bulkText, storedKeys),
    [bulkText, storedKeys],
  );

  const activeMessage =
    uiMode === 'key-value'
      ? rowMessages.size > 0
        ? (rowMessages.values().next().value ?? null)
        : null
      : bulkMessage;

  useEffect(() => {
    onValidationChange?.(activeMessage ?? null);
  }, [activeMessage, onValidationChange]);

  const emitEntriesFromRows = useCallback(
    (nextRows: EditorRow[]): void => {
      if (rowValidationMessages(nextRows).size === 0) {
        const entries = rowsToEntries(nextRows);
        lastEmittedSignature.current = entriesSignature(entries);
        onVariablesChange(entries);
      }
    },
    [onVariablesChange],
  );

  const emitEntriesFromBulk = useCallback(
    (nextBulk: string): void => {
      if (bulkValidationMessage(nextBulk, storedKeys) === null) {
        const entries = entriesFromBulk(nextBulk, bulkBase);
        lastEmittedSignature.current = entriesSignature(entries);
        onVariablesChange(entries);
      }
    },
    [bulkBase, onVariablesChange, storedKeys],
  );

  const handleModeChange = useCallback(
    (nextMode: UserEnvironmentUiMode): void => {
      if (nextMode === uiMode || activeMessage !== null) return;
      if (nextMode === 'bulk') {
        const entries = rowsToEntries(rows);
        setBulkText(serializeBulkEnvironment(plaintextEntries(entries)));
        setBulkBase(entries);
      } else {
        setRows(entriesToRows(entriesFromBulk(bulkText, bulkBase)));
      }
      onUiModeChange?.(nextMode);
    },
    [activeMessage, bulkBase, bulkText, onUiModeChange, rows, uiMode],
  );

  const handleRowChange = useCallback(
    (
      id: string,
      field: 'key' | 'value' | 'secret',
      next: string | boolean,
    ): void => {
      setRows((prev) => {
        const nextRows = prev.map((row) => {
          if (row.id !== id) {
            return row;
          }
          if (field === 'secret') {
            return { ...row, secret: next === true };
          }
          const text = typeof next === 'string' ? next : '';
          // Clearing a replacement goes back to keeping the saved secret.
          if (field === 'value' && row.stored !== undefined && text === '') {
            return { ...row, value: text, secret: true };
          }
          return { ...row, [field]: text };
        });
        emitEntriesFromRows(nextRows);
        return nextRows;
      });
    },
    [emitEntriesFromRows],
  );

  const handleRemoveRow = useCallback(
    (id: string): void => {
      setRows((prev) => {
        const nextRows = prev.filter((row) => row.id !== id);
        emitEntriesFromRows(nextRows);
        return nextRows;
      });
    },
    [emitEntriesFromRows],
  );

  const handleAddRow = useCallback((): void => {
    setRows((prev) => [
      ...prev,
      { id: makeRowId(), key: '', value: '', secret: false },
    ]);
  }, []);

  const handleBulkChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>): void => {
      const next = event.target.value;
      setBulkText(next);
      emitEntriesFromBulk(next);
    },
    [emitEntriesFromBulk],
  );

  return (
    <div
      className="flex flex-col gap-3"
      data-testid={testId ?? 'environment-variable-editor'}
    >
      {!storageFailure && encryptionStatus === 'inline' && (
        <EncryptionStatusBanner encryptionAvailable={encryptionAvailable} />
      )}

      {/* The Settings segmented picker, as tabs: the editor below is the
          view each one names. While the current view has an error the other
          tab stays visible but unavailable, and says why. */}
      <SettingsSegmentedControl<UserEnvironmentUiMode>
        semantics="tabs"
        label="Editor mode"
        value={uiMode}
        onChange={handleModeChange}
        disabled={readOnly === true}
        dataTestId="environment-editor-mode"
        options={(
          [
            ['key-value', 'Key-Value'],
            ['bulk', 'Bulk'],
          ] as const
        ).map(([mode, label]) => {
          const blocked = uiMode !== mode && activeMessage !== null;
          return {
            value: mode,
            label,
            dataTestId: `environment-editor-mode-${mode}`,
            unavailable: blocked,
            tooltip: blocked ? MODE_SWITCH_BLOCKED_MESSAGE : undefined,
          };
        })}
      />

      <div>
        {uiMode === 'key-value' ? (
          <Stack gap="item" data-testid="environment-editor-key-value">
            {rows.length === 0 ? (
              <p
                className="text-s fg-secondary"
                data-testid="environment-editor-empty"
              >
                {
                  'No environment variables. Click "Add variable" to define one.'
                }
              </p>
            ) : (
              <div className="grid grid-cols-[1fr_1.5fr_auto_auto] gap-x-2 gap-y-2">
                <div className="col-span-4 grid grid-cols-subgrid items-center text-xs font-medium fg-secondary">
                  <span data-testid="environment-editor-header-key">Key</span>
                  <span data-testid="environment-editor-header-value">
                    Value
                  </span>
                  <span
                    data-testid="environment-editor-header-secret"
                    className="text-center"
                  >
                    Secret
                  </span>
                  <span className="sr-only">Actions</span>
                </div>
                {rows.map((row) => (
                  <KeyValueRow
                    key={row.id}
                    row={row}
                    validationMessage={rowMessages.get(row.id) ?? null}
                    onChange={handleRowChange}
                    onRemove={handleRemoveRow}
                    disabled={readOnly === true}
                  />
                ))}
              </div>
            )}

            <Button
              className="self-start"
              size="compact"
              variant="secondary"
              onClick={handleAddRow}
              data-testid="environment-editor-add-row"
              disabled={readOnly === true}
            >
              Add variable
            </Button>
          </Stack>
        ) : (
          <Stack gap="inline" data-testid="environment-editor-bulk">
            <TextArea
              mono
              value={bulkText}
              onChange={handleBulkChange}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              rows={12}
              disabled={readOnly === true}
              placeholder={
                'FOO=bar\nBAZ="quoted value"\n# Comments are ignored'
              }
              aria-invalid={bulkMessage !== null}
              aria-describedby={
                bulkMessage !== null ? BULK_MESSAGE_ID : undefined
              }
              data-testid="environment-editor-bulk-textarea"
              className="block"
            />
            <p className="text-xs fg-secondary">{BULK_HELPER_TEXT}</p>
            {storedKeys.size > 0 && (
              <p
                className="break-all text-xs fg-secondary"
                data-testid="environment-editor-bulk-stored"
              >
                {`Saved secrets, kept as they are: ${Array.from(storedKeys).join(', ')}. Edit them in Key-Value.`}
              </p>
            )}
            {bulkMessage !== null && (
              <FieldError
                id={BULK_MESSAGE_ID}
                data-testid="environment-editor-bulk-validation"
              >
                {bulkMessage}
              </FieldError>
            )}
          </Stack>
        )}
      </div>
    </div>
  );
}

interface EncryptionStatusBannerProps {
  encryptionAvailable: boolean;
}

function EncryptionStatusBanner({
  encryptionAvailable,
}: EncryptionStatusBannerProps): JSX.Element {
  if (encryptionAvailable) {
    return (
      <p className="text-xs fg-secondary">
        <EnvironmentEncryptionStatusText />
      </p>
    );
  }
  return <EnvironmentEncryptionUnavailableNotice />;
}

/** The encryption status line, for a host's section description. */
export function EnvironmentEncryptionStatusText(): JSX.Element {
  return (
    <span data-testid="environment-editor-encryption-status">
      Values are encrypted at rest using the OS keychain.
    </span>
  );
}

/** The warning while OS encryption is unavailable. */
export function EnvironmentEncryptionUnavailableNotice({
  className,
}: {
  readonly className?: string;
}): JSX.Element {
  return (
    <Notice
      intent="attention"
      className={className}
      data-testid="environment-editor-encryption-warning"
      title="OS encryption unavailable."
    >
      Values will be saved in plaintext on disk. Avoid storing secrets here
      until a system keychain is configured.
    </Notice>
  );
}

interface KeyValueRowProps {
  row: EditorRow;
  validationMessage: string | null;
  disabled: boolean;
  onChange: (
    id: string,
    field: 'key' | 'value' | 'secret',
    next: string | boolean,
  ) => void;
  onRemove: (id: string) => void;
}

function KeyValueRow({
  row,
  validationMessage,
  disabled,
  onChange,
  onRemove,
}: KeyValueRowProps): JSX.Element {
  const hasError = validationMessage !== null;
  const keepsStored = keepsStoredValue(row);
  // Subgrid flattens the row into the parent grid, so the message is no longer
  // a DOM sibling of the input it describes. Associate them explicitly.
  const messageId = `environment-editor-message-${row.id}`;
  return (
    <>
      <div className="col-span-4 grid grid-cols-subgrid items-center">
        <TextInput
          density="settings"
          mono
          value={row.key}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="KEY"
          disabled={disabled}
          onChange={(event: ChangeEvent<HTMLInputElement>): void =>
            onChange(row.id, 'key', event.target.value)
          }
          aria-label="Key"
          aria-invalid={hasError}
          aria-describedby={hasError ? messageId : undefined}
          data-testid={`environment-editor-key-${row.id}`}
        />
        <TextInput
          density="settings"
          mono
          value={row.value}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={
            row.stored === undefined ? 'value' : STORED_VALUE_PLACEHOLDER
          }
          disabled={disabled}
          onChange={(event: ChangeEvent<HTMLInputElement>): void =>
            onChange(row.id, 'value', event.target.value)
          }
          aria-label={
            row.stored === undefined ? 'Value' : 'Replace saved value'
          }
          data-testid={`environment-editor-value-${row.id}`}
        />
        <div
          className="flex items-center justify-center"
          title={keepsStored ? STORED_SECRET_LOCKED_MESSAGE : undefined}
        >
          <Checkbox
            checked={row.secret}
            disabled={disabled || keepsStored}
            onChange={(event: ChangeEvent<HTMLInputElement>): void =>
              onChange(row.id, 'secret', event.target.checked)
            }
            aria-label={`Mark ${row.key || 'variable'} as secret`}
            data-testid={`environment-editor-secret-${row.id}`}
          />
        </div>
        <Button
          size="compact"
          variant="secondary"
          onClick={() => onRemove(row.id)}
          aria-label={`Remove ${row.key || 'variable'}`}
          data-testid={`environment-editor-remove-${row.id}`}
          disabled={disabled}
        >
          Remove
        </Button>
      </div>
      {hasError && (
        <div className="col-span-4 -mt-1">
          <FieldError
            id={messageId}
            data-testid={`environment-editor-message-${row.id}`}
          >
            {validationMessage}
          </FieldError>
        </div>
      )}
    </>
  );
}
