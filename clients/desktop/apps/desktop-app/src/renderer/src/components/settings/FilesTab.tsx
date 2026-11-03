import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  CanopyApi,
  FileIndexingCustomGlob,
  FileIndexingPreferences,
  FileLabelBucket,
} from '@canopy/desktop-shared/types';
import { Button, ErrorState, ToggleSwitch } from '@canopy/ui-shared/components';
import { TrashIcon } from '@canopy/ui-shared/icons/AppIcons';
import { useFileTabUiStore } from '@/stores/fileTabUiStore';
import { useFileListStore } from '@/stores/fileListStore';
import { useFileLabelsStore } from '@/stores/fileLabelsStore';
import {
  getBuiltinRows,
  getCustomRows,
  loadFilesTabState,
  validateNewCustomGlob,
  type FilesTabBuiltinRow,
  type FilesTabState,
} from './filesTabState';
import {
  FileLabelsSection,
  SectionDisclosureButton,
} from './FileLabelsSection';
import {
  SettingsGroup,
  SettingsPage,
  SettingsLoading,
  SettingsRow,
  SettingsSection,
  SettingsTextField,
} from './SettingsLayout';

/**
 * Generate a stable id for a new custom glob without depending on the
 * presence of `crypto.randomUUID()` in older Electron renderer contexts.
 */
function makeCustomGlobId(): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }
  return `glob-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

const SAVE_ERROR_MESSAGE = 'Unable to save Do not index settings.';

export function FilesTab(): JSX.Element {
  const labelsSectionExpandRequest = useFileLabelsStore(
    (s) => s.labelsSectionExpandRequest,
  );
  const consumeLabelsSectionExpandRequest = useFileLabelsStore(
    (s) => s.consumeLabelsSectionExpandRequest,
  );
  const [labelsSectionExpandSignal, setLabelsSectionExpandSignal] =
    useState<number>(0);
  const [loadVersion, setLoadVersion] = useState<number>(0);
  const [state, setState] = useState<FilesTabState>({ status: 'loading' });
  const latestSaveRequestIdRef = useRef<number>(0);
  const latestCommittedSaveIdRef = useRef<number>(0);
  const lastSavedFileIndexingRef = useRef<FileIndexingPreferences | undefined>(
    undefined,
  );

  useEffect(() => {
    if (consumeLabelsSectionExpandRequest()) {
      setLabelsSectionExpandSignal((signal) => signal + 1);
    }
  }, [consumeLabelsSectionExpandRequest, labelsSectionExpandRequest]);

  useEffect((): (() => void) => {
    let cancelled = false;
    const api: CanopyApi = window.api;
    setState({ status: 'loading' });
    void loadFilesTabState(api).then((nextState) => {
      if (!cancelled) {
        if (nextState.status === 'ready') {
          lastSavedFileIndexingRef.current = nextState.fileIndexing;
          latestCommittedSaveIdRef.current = latestSaveRequestIdRef.current;
        }
        setState(nextState);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadVersion]);

  const handleAutoSaveToggle = useCallback((next: boolean): void => {
    setState((prev) => {
      if (prev.status !== 'ready') return prev;
      return { ...prev, autoSaveEnabled: next };
    });
    // Reflect immediately in the runtime preference so the desktop session
    // controller reacts (scheduling/cancelling autosave) before the persisted
    // preference round-trips.
    useFileTabUiStore.getState().setAutoSaveEnabled(next);
    const api: CanopyApi = window.api;
    void api.savePreferences({ fileAutoSave: next }).catch(() => {
      // Persistence may fail if userData is unavailable. The runtime store
      // already reflects the user's choice for this session.
    });
  }, []);

  /**
   * Apply a `fileIndexing` change locally + persist. On success, invalidate
   * every cached file index/tree so the new exclusions take effect on the
   * next fetch. On failure, surface a `saveStatus: 'error'` and keep the
   * UI rolled back to whatever the previous saved state was.
   */
  const persistFileIndexing = useCallback(
    async (next: FileIndexingPreferences): Promise<void> => {
      const requestId = latestSaveRequestIdRef.current + 1;
      latestSaveRequestIdRef.current = requestId;
      // Optimistic update so the UI reflects the toggle immediately.
      setState((prev) => {
        if (prev.status !== 'ready') return prev;
        return {
          ...prev,
          fileIndexing: next,
          builtinRows: getBuiltinRows(next),
          customRows: getCustomRows(next),
          saveStatus: 'saving',
        };
      });

      try {
        await window.api.savePreferences({ fileIndexing: next });
        if (requestId > latestCommittedSaveIdRef.current) {
          latestCommittedSaveIdRef.current = requestId;
          lastSavedFileIndexingRef.current = next;
        }
        if (requestId !== latestSaveRequestIdRef.current) {
          return;
        }
        setState((prev) => {
          if (prev.status !== 'ready') return prev;
          return { ...prev, saveStatus: 'idle' };
        });
        // Drop every cached file index/tree so the new exclusions are
        // applied the next time anything is fetched.
        useFileListStore.getState().invalidateAll();
      } catch {
        if (requestId !== latestSaveRequestIdRef.current) {
          return;
        }
        setState((prev) => {
          if (prev.status !== 'ready') return prev;
          const rolledBack =
            lastSavedFileIndexingRef.current ?? prev.fileIndexing;
          return {
            ...prev,
            fileIndexing: rolledBack,
            builtinRows: getBuiltinRows(rolledBack),
            customRows: getCustomRows(rolledBack),
            saveStatus: 'error',
          };
        });
      }
    },
    [],
  );

  const handleBuiltinToggle = useCallback(
    (row: FilesTabBuiltinRow, next: boolean): void => {
      if (state.status !== 'ready') return;
      const disabled = new Set(state.fileIndexing.disabledBuiltinGlobIds);
      if (next) {
        disabled.delete(row.id);
      } else {
        disabled.add(row.id);
      }
      void persistFileIndexing({
        ...state.fileIndexing,
        disabledBuiltinGlobIds: Array.from(disabled),
      });
    },
    [persistFileIndexing, state],
  );

  const handleAddCustomGlob = useCallback(
    (pattern: string): string | null => {
      if (state.status !== 'ready') return null;
      const existingPatterns = state.fileIndexing.customGlobs.map(
        (g) => g.pattern,
      );
      const validation = validateNewCustomGlob(pattern, existingPatterns);
      if (validation) return validation;

      const newGlob: FileIndexingCustomGlob = {
        id: makeCustomGlobId(),
        pattern: pattern.trim(),
        enabled: true,
      };
      void persistFileIndexing({
        ...state.fileIndexing,
        customGlobs: [...state.fileIndexing.customGlobs, newGlob],
      });
      return null;
    },
    [persistFileIndexing, state],
  );

  const handleRemoveCustomGlob = useCallback(
    (id: string): void => {
      if (state.status !== 'ready') return;
      void persistFileIndexing({
        ...state.fileIndexing,
        customGlobs: state.fileIndexing.customGlobs.filter((g) => g.id !== id),
      });
    },
    [persistFileIndexing, state],
  );

  /**
   * Persist a Labels change. The editor owns its local mirror (matching the
   * BranchDisplayMappings model), so failures surface an inline error banner
   * rather than rolling the editor back. The runtime store updates
   * immediately so the changed-file surfaces re-classify without a reload.
   */
  const persistFileLabels = useCallback(
    async (labels: FileLabelBucket[]): Promise<void> => {
      setState((prev) => {
        if (prev.status !== 'ready') return prev;
        return { ...prev, fileLabels: labels, labelsSaveStatus: 'saving' };
      });
      useFileLabelsStore.getState().setLabels(labels);
      try {
        await window.api.savePreferences({ fileLabels: labels });
        setState((prev) => {
          if (prev.status !== 'ready') return prev;
          return { ...prev, labelsSaveStatus: 'idle' };
        });
      } catch {
        setState((prev) => {
          if (prev.status !== 'ready') return prev;
          return { ...prev, labelsSaveStatus: 'error' };
        });
      }
    },
    [],
  );

  const handleSaveFileLabels = useCallback(
    (labels: FileLabelBucket[]): void => {
      void persistFileLabels(labels);
    },
    [persistFileLabels],
  );

  if (state.status === 'loading') {
    return (
      <SettingsPage title="Files">
        <SettingsLoading />
      </SettingsPage>
    );
  }

  if (state.status === 'error') {
    return (
      <SettingsPage title="Files">
        <ErrorState
          message="Couldn't load file preferences."
          onRetry={() => setLoadVersion((current) => current + 1)}
          testId="settings-files-load-error"
        />
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title="Files"
      description="Configure file tabs and editing behavior."
      dataTestId="settings-tab-files"
    >
      <SettingsSection title="Editing">
        <SettingsGroup>
          <SettingsRow
            label="Auto save"
            htmlFor="settings-files-auto-save-switch"
            description="Save edited file tabs after a short pause and before a tab closes."
            control={
              <ToggleSwitch
                id="settings-files-auto-save-switch"
                checked={state.autoSaveEnabled}
                label="Auto save"
                dataTestId="settings-files-auto-save"
                onChange={handleAutoSaveToggle}
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <DoNotIndexSection
        builtinRows={state.builtinRows}
        customRows={state.customRows}
        saveStatus={state.saveStatus}
        onBuiltinToggle={handleBuiltinToggle}
        onAddCustomGlob={handleAddCustomGlob}
        onRemoveCustomGlob={handleRemoveCustomGlob}
      />

      <FileLabelsSection
        labels={state.fileLabels}
        saveStatus={state.labelsSaveStatus}
        onSave={handleSaveFileLabels}
        expandRequest={labelsSectionExpandSignal}
      />
    </SettingsPage>
  );
}

interface DoNotIndexSectionProps {
  builtinRows: FilesTabBuiltinRow[];
  customRows: FileIndexingCustomGlob[];
  saveStatus: 'idle' | 'saving' | 'error';
  onBuiltinToggle: (row: FilesTabBuiltinRow, next: boolean) => void;
  onAddCustomGlob: (pattern: string) => string | null;
  onRemoveCustomGlob: (id: string) => void;
}

/** The Do not index section: its lists sit behind the section disclosure. */
function DoNotIndexSection(props: DoNotIndexSectionProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const enabledGlobs =
    props.builtinRows.filter((r) => r.enabled).length +
    props.customRows.filter((r) => r.enabled).length;
  return (
    <SettingsSection title="Search" dataTestId="settings-files-do-not-index">
      <SettingsGroup>
        <SettingsRow
          label="Do not index"
          description="Matching files stay in the file explorer but are hidden from Cmd+P and @ file mentions. The .git folder is always hidden."
          control={
            <SectionDisclosureButton
              expanded={expanded}
              onToggle={() => setExpanded((v) => !v)}
              collapsedLabel={`${enabledGlobs} glob${enabledGlobs === 1 ? '' : 's'} enabled`}
              expandedLabel="Hide globs"
              dataTestId="settings-files-do-not-index-toggle"
            />
          }
        />
        {expanded && <DoNotIndexLists {...props} />}
      </SettingsGroup>
    </SettingsSection>
  );
}

/**
 * The built-in globs, each with its switch, then the custom globs under the
 * field that adds one. Mounted only while the section is open.
 */
function DoNotIndexLists({
  builtinRows,
  customRows,
  saveStatus,
  onBuiltinToggle,
  onAddCustomGlob,
  onRemoveCustomGlob,
}: DoNotIndexSectionProps): JSX.Element {
  const [pendingPattern, setPendingPattern] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleAdd = useCallback((): void => {
    const error = onAddCustomGlob(pendingPattern);
    if (error) {
      setValidationError(error);
      return;
    }
    setPendingPattern('');
    setValidationError(null);
  }, [onAddCustomGlob, pendingPattern]);

  const showSaveError = saveStatus === 'error';

  const errorText = useMemo<string | null>(() => {
    if (validationError) return validationError;
    if (showSaveError) return SAVE_ERROR_MESSAGE;
    return null;
  }, [validationError, showSaveError]);

  // Rows of the Do not index group: the built-in globs, the field that adds
  // a custom glob, then the custom globs.
  return (
    <>
      {builtinRows.map((row) => (
        <SettingsRow
          key={row.id}
          label={row.label}
          htmlFor={`settings-files-builtin-switch-${row.id}`}
          description={<span className="font-mono">{row.pattern}</span>}
          dataTestId={`settings-files-builtin-${row.id}`}
          control={
            <ToggleSwitch
              id={`settings-files-builtin-switch-${row.id}`}
              checked={row.enabled}
              label={row.label}
              onChange={(next) => onBuiltinToggle(row, next)}
            />
          }
        />
      ))}
      <SettingsRow
        label="Custom globs"
        htmlFor="settings-files-custom-input-field"
        description="Leave out more files by pattern."
        control={
          <>
            <SettingsTextField
              mono
              id="settings-files-custom-input-field"
              type="text"
              width="md"
              value={pendingPattern}
              onChange={(event) => {
                setPendingPattern(event.target.value);
                if (validationError) setValidationError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  handleAdd();
                }
              }}
              placeholder="**/generated/**"
              aria-invalid={errorText !== null}
              data-testid="settings-files-custom-input"
            />
            <Button
              size="compact"
              variant="secondary"
              onClick={handleAdd}
              data-testid="settings-files-custom-add"
            >
              Add glob
            </Button>
          </>
        }
      >
        {errorText !== null && (
          <p
            className="text-xs fg-destructive"
            data-testid="settings-files-custom-error"
          >
            {errorText}
          </p>
        )}
      </SettingsRow>

      {customRows.length === 0 ? (
        <p
          className="text-s fg-secondary"
          data-testid="settings-files-custom-empty"
        >
          No custom globs.
        </p>
      ) : null}
      {customRows.map((row) => (
        <SettingsRow
          key={row.id}
          label={<code className="break-all font-mono">{row.pattern}</code>}
          dataTestId={`settings-files-custom-${row.id}`}
          control={
            <Button
              size="compact"
              variant="secondary"
              iconOnly
              onClick={() => onRemoveCustomGlob(row.id)}
              aria-label={`Remove ${row.pattern}`}
            >
              <TrashIcon size="sm" />
            </Button>
          }
        />
      ))}
    </>
  );
}
