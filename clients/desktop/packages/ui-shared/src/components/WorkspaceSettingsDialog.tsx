'use client';

import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import {
  DEFAULT_ARCHIVE_RETENTION_DAYS,
  MIN_ARCHIVE_RETENTION_DAYS,
  MAX_ARCHIVE_RETENTION_DAYS,
} from '@canopy/protocol/archive-retention';
import { WORKSPACE_LABEL } from '@canopy/protocol';
import { ColorSwatchPicker } from './ColorSwatchPicker';
import { DialogModal } from './DialogModal';
import { Select } from './Field';
import { SettingsDangerConfirmBlock } from './SettingsDangerConfirmBlock';
import { SettingsTabBar, type SettingsTab } from './SettingsTabBar';
import { WORKSPACE_COLOR_PALETTE } from './workspace-color-palette';

export { WORKSPACE_COLOR_PALETTE };

export const WORKSPACE_SCRIPT_PHASES = [
  { key: 'setup', label: 'Setup' },
  { key: 'launch', label: 'Launch' },
  { key: 'teardown', label: 'Teardown' },
] as const;

export type WorkspaceSettingsTab =
  | 'details'
  | 'claude-md'
  | 'scripts'
  | 'danger';

export interface WorkspaceSettingsValues {
  readonly defaultModelDefinitionId?: string | null;
  readonly deletionRetentionDays?: number;
  readonly name: string;
  readonly description?: string;
  readonly color?: string;
  readonly content: string;
  readonly scripts: Record<string, string>;
}

export interface WorkspaceSettingsExtraTab {
  readonly id: string;
  readonly label: string;
  readonly content:
    | ReactNode
    | ((values: WorkspaceSettingsValues) => ReactNode);
}

export interface WorkspaceSettingsContentCopy {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly placeholder?: string;
}

export interface WorkspaceSettingsDangerCopy {
  readonly title?: string;
  readonly description?: ReactNode;
  readonly triggerLabel?: string;
  readonly confirmLabel?: string;
  readonly confirmInProgressLabel?: string;
}

export interface WorkspaceSettingsDialogTestIds {
  readonly defaultModel?: string;
  readonly dialog?: string;
  readonly nameInput?: string;
  readonly descriptionInput?: string;
  readonly colorSwatches?: string;
  readonly claudeMdTextarea?: string;
  readonly scriptInput?: (key: string) => string;
  readonly danger?: string;
  readonly secondaryDanger?: string;
  readonly retentionInput?: string;
  readonly error?: string;
  readonly save?: string;
  readonly saved?: string;
}

export interface WorkspaceSettingsDialogProps {
  readonly modelOptions?: readonly {
    readonly id: string;
    readonly label: string;
    readonly disabled?: boolean;
  }[];
  readonly modelsLoading?: boolean;
  readonly modelsError?: string;
  readonly workspaceName: string;
  readonly initialValues: WorkspaceSettingsValues;
  readonly tabs?: readonly WorkspaceSettingsTab[];
  readonly showDescription?: boolean;
  readonly tabLabels?: Partial<Record<WorkspaceSettingsTab, string>>;
  readonly claudeMdCopy?: WorkspaceSettingsContentCopy;
  readonly extraTabs?: readonly WorkspaceSettingsExtraTab[];
  /**
   * Tab to open on. Used by entry points that route straight to one tab (the
   * sidebar's `Share template` item). Ignored when it names no visible tab.
   */
  readonly initialTab?: string;
  readonly dangerCopy?: WorkspaceSettingsDangerCopy;
  readonly dangerVariant?: 'destructive' | 'warning';
  readonly secondaryDanger?: {
    copy: WorkspaceSettingsDangerCopy;
    onConfirm: () => Promise<void>;
  };
  readonly palette?: readonly string[];
  readonly scriptPhases?: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
  }>;
  /** Host content after the lifecycle commands on the Scripts tab. */
  readonly scriptsAccessory?: ReactNode;
  readonly onSave: (values: WorkspaceSettingsValues) => Promise<void>;
  readonly onDelete?: () => Promise<void>;
  readonly onClose: () => void;
  readonly testIds?: WorkspaceSettingsDialogTestIds;
}

const DEFAULT_TABS: readonly WorkspaceSettingsTab[] = [
  'details',
  'claude-md',
  'scripts',
  'danger',
];

const TAB_LABELS: Readonly<
  Record<WorkspaceSettingsTab, SettingsTab<WorkspaceSettingsTab>>
> = {
  details: { id: 'details', label: 'Details' },
  'claude-md': { id: 'claude-md', label: 'CLAUDE.md' },
  scripts: { id: 'scripts', label: 'Scripts' },
  danger: { id: 'danger', label: 'Danger', danger: true },
};

function isBuiltInTabId(id: string): id is WorkspaceSettingsTab {
  return Object.prototype.hasOwnProperty.call(TAB_LABELS, id);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

export function WorkspaceSettingsDialog({
  workspaceName,
  modelOptions,
  modelsLoading = false,
  modelsError,
  initialValues,
  tabs = DEFAULT_TABS,
  showDescription = false,
  tabLabels,
  claudeMdCopy,
  extraTabs = [],
  initialTab,
  dangerCopy,
  dangerVariant,
  secondaryDanger,
  palette = WORKSPACE_COLOR_PALETTE,
  scriptPhases = WORKSPACE_SCRIPT_PHASES,
  scriptsAccessory,
  onSave,
  onDelete,
  onClose,
  testIds,
}: WorkspaceSettingsDialogProps): JSX.Element {
  const validExtraTabs = extraTabs.filter((tab) => !isBuiltInTabId(tab.id));
  const builtInTabs = tabs
    .filter((tab) => tab !== 'danger' || onDelete !== undefined)
    .map((tab) => ({
      ...TAB_LABELS[tab],
      label: tabLabels?.[tab] ?? TAB_LABELS[tab].label,
    }));
  const visibleTabs: ReadonlyArray<SettingsTab<string>> = [
    ...builtInTabs.filter((tab) => tab.id !== 'danger'),
    ...validExtraTabs.map(({ id, label }) => ({ id, label })),
    ...builtInTabs.filter((tab) => tab.id === 'danger'),
  ];
  const [activeTab, setActiveTab] = useState<string>(
    (initialTab !== undefined &&
    visibleTabs.some((tab) => tab.id === initialTab)
      ? initialTab
      : visibleTabs[0]?.id) ?? 'details',
  );
  const [defaultModelDefinitionId, setDefaultModelDefinitionId] = useState(
    initialValues.defaultModelDefinitionId ?? null,
  );
  const [name, setName] = useState(initialValues.name);
  const metadataBaselineRef = useRef({
    name: initialValues.name,
    color: initialValues.color,
  });
  const nameValueRef = useRef(initialValues.name);
  const colorValueRef = useRef(initialValues.color);
  const nameDirtyRef = useRef(false);
  const colorDirtyRef = useRef(false);
  const nameEditVersionRef = useRef(0);
  const colorEditVersionRef = useRef(0);
  const nameSavingVersionRef = useRef<number | null>(null);
  const colorSavingVersionRef = useRef<number | null>(null);
  const includeDescription =
    showDescription || initialValues.description !== undefined;
  const [description, setDescription] = useState(
    initialValues.description ?? '',
  );
  const [deletionRetentionDays, setDeletionRetentionDays] = useState(
    initialValues.deletionRetentionDays ?? DEFAULT_ARCHIVE_RETENTION_DAYS,
  );
  const [secondaryConfirming, setSecondaryConfirming] = useState(false);
  const [secondaryWorking, setSecondaryWorking] = useState(false);
  const [color, setColor] = useState(initialValues.color);
  const [content, setContent] = useState(initialValues.content);
  const [scripts, setScripts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      scriptPhases.map(({ key }) => [key, initialValues.scripts[key] ?? '']),
    ),
  );
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    metadataBaselineRef.current = {
      name: initialValues.name,
      color: initialValues.color,
    };
    if (
      !nameDirtyRef.current ||
      nameValueRef.current.trim() === initialValues.name
    ) {
      nameDirtyRef.current = false;
      nameValueRef.current = initialValues.name;
      setName(initialValues.name);
    }
    if (
      !colorDirtyRef.current ||
      colorValueRef.current === initialValues.color
    ) {
      colorDirtyRef.current = false;
      colorValueRef.current = initialValues.color;
      setColor(initialValues.color);
    }
  }, [initialValues.color, initialValues.name]);

  const working = saving || deleting || secondaryWorking;
  const trimmedName = name.trim();
  const displayedRetentionDays = Number.isFinite(deletionRetentionDays)
    ? deletionRetentionDays
    : DEFAULT_ARCHIVE_RETENTION_DAYS;
  const currentValues: WorkspaceSettingsValues = {
    ...(modelOptions === undefined ? {} : { defaultModelDefinitionId }),
    name: trimmedName,
    ...(includeDescription ? { description } : {}),
    color,
    content,
    scripts,
    ...(initialValues.deletionRetentionDays !== undefined
      ? { deletionRetentionDays: displayedRetentionDays }
      : {}),
  };
  const activeExtraTab = validExtraTabs.find((tab) => tab.id === activeTab);

  // Saving deliberately does NOT close the dialog. These settings span several
  // tabs and switching tabs does not persist anything, so closing on Save made
  // every multi-tab edit a reopen-and-save-again loop. The dialog stays put and
  // confirms in place; Done is the only thing that dismisses it.
  const save = async (): Promise<void> => {
    if (working || !trimmedName) return;
    setSaving(true);
    setError(null);
    setJustSaved(false);
    const nameEditVersion = nameEditVersionRef.current;
    const colorEditVersion = colorEditVersionRef.current;
    nameSavingVersionRef.current = nameEditVersion;
    colorSavingVersionRef.current = colorEditVersion;
    const metadataBaseline = metadataBaselineRef.current;
    try {
      if (
        initialValues.deletionRetentionDays !== undefined &&
        (!Number.isInteger(deletionRetentionDays) ||
          deletionRetentionDays < MIN_ARCHIVE_RETENTION_DAYS ||
          deletionRetentionDays > MAX_ARCHIVE_RETENTION_DAYS)
      )
        throw new Error(
          `Enter a whole number from ${MIN_ARCHIVE_RETENTION_DAYS} to ${MAX_ARCHIVE_RETENTION_DAYS}.`,
        );
      await onSave({
        ...(modelOptions === undefined ? {} : { defaultModelDefinitionId }),
        name: trimmedName,
        ...(includeDescription ? { description } : {}),
        color,
        content,
        scripts,
        ...(initialValues.deletionRetentionDays !== undefined
          ? { deletionRetentionDays }
          : {}),
      });
      if (nameEditVersionRef.current === nameEditVersion) {
        nameDirtyRef.current = false;
        if (metadataBaselineRef.current.name !== metadataBaseline.name) {
          nameValueRef.current = metadataBaselineRef.current.name;
          setName(metadataBaselineRef.current.name);
        }
      }
      if (colorEditVersionRef.current === colorEditVersion) {
        colorDirtyRef.current = false;
        if (metadataBaselineRef.current.color !== metadataBaseline.color) {
          colorValueRef.current = metadataBaselineRef.current.color;
          setColor(metadataBaselineRef.current.color);
        }
      }
      setJustSaved(true);
    } catch (saveError: unknown) {
      setError(errorMessage(saveError, "Couldn't save settings."));
    } finally {
      nameSavingVersionRef.current = null;
      colorSavingVersionRef.current = null;
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!onDelete || working) return;
    setDeleting(true);
    setError(null);
    try {
      await onDelete();
      onClose();
    } catch (deleteError: unknown) {
      setError(
        errorMessage(
          deleteError,
          `Couldn't delete ${WORKSPACE_LABEL.toLowerCase()}.`,
        ),
      );
      setDeleting(false);
      setConfirming(false);
    }
  };

  return (
    <DialogModal
      onClose={working ? (): void => undefined : onClose}
      closeOnBackdrop={!working}
      closeOnEscape={!working}
      title={`${WORKSPACE_LABEL} settings`}
      subtitle={workspaceName}
      maxWidth="2xl"
      dataTestId={testIds?.dialog}
    >
      <SettingsTabBar
        tabs={visibleTabs}
        activeTab={activeTab}
        onChange={(tab): void => {
          setActiveTab(tab);
          if (tab !== 'danger') setConfirming(false);
        }}
      />
      <div className="flex flex-col gap-5 px-5 pb-5 pt-4">
        {activeTab === 'details' && (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5 text-s">
              <span className="font-medium fg-primary">{`${WORKSPACE_LABEL} name`}</span>
              <input
                type="text"
                value={name}
                onChange={(event) => {
                  const nextName = event.target.value;
                  setJustSaved(false);
                  nameEditVersionRef.current += 1;
                  nameValueRef.current = nextName;
                  nameDirtyRef.current =
                    nextName.trim() !== metadataBaselineRef.current.name ||
                    (nameSavingVersionRef.current !== null &&
                      nameEditVersionRef.current !==
                        nameSavingVersionRef.current);
                  setName(nextName);
                }}
                data-testid={testIds?.nameInput}
                className="rounded-md border bg-base px-3 py-2 text-s fg-primary outline-none focus:border-line-focus focus:ring-1 focus:ring-line-focus"
              />
            </label>
            {modelOptions !== undefined && (
              <label className="flex flex-col gap-1.5 text-s">
                <span className="font-medium fg-primary">Default model</span>
                <span className="text-xs fg-secondary">
                  Used for new chats. You can choose a different model in each
                  chat.
                </span>
                <Select
                  aria-label="Default model"
                  value={defaultModelDefinitionId ?? ''}
                  disabled={working || modelsLoading}
                  onValueChange={(value): void => {
                    setDefaultModelDefinitionId(value || null);
                    setJustSaved(false);
                  }}
                  data-testid={testIds?.defaultModel}
                  options={[
                    {
                      value: '',
                      label: modelsLoading
                        ? 'Loading models…'
                        : 'Use account default',
                    },
                    ...(defaultModelDefinitionId !== null &&
                    !modelOptions.some(
                      (option) => option.id === defaultModelDefinitionId,
                    )
                      ? [
                          {
                            value: defaultModelDefinitionId,
                            label: 'Saved model unavailable',
                            disabled: true,
                          },
                        ]
                      : []),
                    ...modelOptions.map((option) => ({
                      value: option.id,
                      label: option.label,
                      disabled: option.disabled,
                    })),
                  ]}
                />
                {modelsError && (
                  <span role="alert" className="text-xs fg-destructive">
                    {modelsError}
                  </span>
                )}
              </label>
            )}
            {initialValues.deletionRetentionDays !== undefined && (
              <label className="flex flex-col gap-1.5 text-s">
                <span>Keep deleted chats for</span>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    aria-label="Keep deleted chats for"
                    min={MIN_ARCHIVE_RETENTION_DAYS}
                    max={MAX_ARCHIVE_RETENTION_DAYS}
                    value={
                      Number.isNaN(deletionRetentionDays)
                        ? ''
                        : deletionRetentionDays
                    }
                    onChange={(event) => {
                      setJustSaved(false);
                      setDeletionRetentionDays(event.target.valueAsNumber);
                    }}
                    data-testid={testIds?.retentionInput}
                    className="w-24 rounded-md border inset-ring-[length:var(--border-hairline)] inset-ring-line-base bg-base px-3 py-2 text-s fg-primary"
                  />
                  <span>days</span>
                </div>
                <span className="text-xs fg-secondary">
                  Deleted chats are kept for {displayedRetentionDays} days, then
                  removed. Archived chats are kept until you delete them.
                </span>
              </label>
            )}
            {includeDescription && (
              <label className="flex flex-col gap-1.5 text-s">
                <span className="font-medium fg-primary">Description</span>
                <textarea
                  value={description}
                  onChange={(event) => {
                    setJustSaved(false);
                    setDescription(event.target.value);
                  }}
                  data-testid={testIds?.descriptionInput}
                  className="h-20 w-full resize-y rounded-md border bg-base px-3 py-2 text-s fg-primary outline-none focus:border-line-focus focus:ring-1 focus:ring-line-focus"
                />
              </label>
            )}
            <div className="flex flex-col gap-1.5 text-s">
              <span className="font-medium fg-primary">Color</span>
              <ColorSwatchPicker
                value={color}
                palette={palette}
                testId={testIds?.colorSwatches}
                onChange={(swatch) => {
                  setJustSaved(false);
                  colorEditVersionRef.current += 1;
                  colorValueRef.current = swatch;
                  colorDirtyRef.current =
                    swatch !== metadataBaselineRef.current.color ||
                    (colorSavingVersionRef.current !== null &&
                      colorEditVersionRef.current !==
                        colorSavingVersionRef.current);
                  setColor(swatch);
                }}
              />
            </div>
          </div>
        )}
        {activeTab === 'claude-md' && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-s font-medium fg-primary">
                {claudeMdCopy?.title ?? 'CLAUDE.md'}
              </span>
              <span className="text-xs fg-secondary">
                {claudeMdCopy?.description ??
                  `${WORKSPACE_LABEL} instructions shared with agents in this ${WORKSPACE_LABEL.toLowerCase()}.`}
              </span>
            </div>
            <textarea
              value={content}
              onChange={(event) => {
                setJustSaved(false);
                setContent(event.target.value);
              }}
              spellCheck={false}
              data-testid={testIds?.claudeMdTextarea}
              className="h-56 w-full resize-y rounded-md border bg-base px-3 py-2 font-mono text-xs fg-primary outline-none focus:border-line-focus focus:ring-1 focus:ring-line-focus"
              placeholder={
                claudeMdCopy?.placeholder ??
                `# ${WORKSPACE_LABEL} instructions\n\nGuidance for agents working in this ${WORKSPACE_LABEL.toLowerCase()}…`
              }
            />
          </div>
        )}
        {activeTab === 'scripts' && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-s font-medium fg-primary">Scripts</span>
              <span className="text-xs fg-secondary">
                {`Lifecycle commands run on the desktop for this ${WORKSPACE_LABEL.toLowerCase()}. Leave blank to clear.`}
              </span>
            </div>
            {scriptPhases.map(({ key, label }) => (
              <label key={key} className="flex items-center gap-2 text-s">
                <span className="w-20 shrink-0 fg-secondary">{label}</span>
                <input
                  type="text"
                  value={scripts[key] ?? ''}
                  onChange={(event) => {
                    setJustSaved(false);
                    setScripts((previous) => ({
                      ...previous,
                      [key]: event.target.value,
                    }));
                  }}
                  spellCheck={false}
                  data-testid={testIds?.scriptInput?.(key)}
                  placeholder={`${label} command…`}
                  className="min-w-0 flex-1 rounded-md border bg-base px-3 py-2 font-mono text-xs fg-primary outline-none focus:border-line-focus focus:ring-1 focus:ring-line-focus"
                />
              </label>
            ))}
            {scriptsAccessory}
          </div>
        )}
        {activeExtraTab &&
          (typeof activeExtraTab.content === 'function'
            ? activeExtraTab.content(currentValues)
            : activeExtraTab.content)}
        {activeTab === 'danger' && onDelete && (
          <div className="space-y-4" data-testid={testIds?.danger}>
            <SettingsDangerConfirmBlock
              title={
                dangerCopy?.title ?? `Delete ${WORKSPACE_LABEL.toLowerCase()}`
              }
              description={
                dangerCopy?.description ??
                `Deleting removes this ${WORKSPACE_LABEL.toLowerCase()} and every worktree, chat, and summary it owns on the desktop and can't be undone.`
              }
              triggerLabel={
                dangerCopy?.triggerLabel ??
                `Delete ${WORKSPACE_LABEL.toLowerCase()}…`
              }
              confirmLabel={dangerCopy?.confirmLabel ?? 'Confirm delete'}
              confirmInProgressLabel={
                dangerCopy?.confirmInProgressLabel ?? 'Deleting…'
              }
              variant={dangerVariant}
              triggerDisabled={working}
              confirming={confirming}
              onConfirmStart={() => setConfirming(true)}
              onConfirmCancel={() => setConfirming(false)}
              onConfirm={() => void remove()}
              isWorking={deleting}
            />
            {secondaryDanger && (
              <div data-testid={testIds?.secondaryDanger}>
                <SettingsDangerConfirmBlock
                  title={secondaryDanger.copy.title ?? 'Delete workspace'}
                  description={secondaryDanger.copy.description}
                  triggerLabel={
                    secondaryDanger.copy.triggerLabel ?? 'Delete workspace…'
                  }
                  confirmLabel={secondaryDanger.copy.confirmLabel ?? 'Delete'}
                  confirmInProgressLabel={
                    secondaryDanger.copy.confirmInProgressLabel ?? 'Deleting…'
                  }
                  triggerDisabled={working}
                  confirming={secondaryConfirming}
                  onConfirmStart={() => setSecondaryConfirming(true)}
                  onConfirmCancel={() => setSecondaryConfirming(false)}
                  isWorking={secondaryWorking}
                  onConfirm={() => {
                    if (working) return;
                    setSecondaryWorking(true);
                    setError(null);
                    void secondaryDanger
                      .onConfirm()
                      .then(onClose)
                      .catch((error: unknown) => {
                        setError(
                          errorMessage(error, "Couldn't delete workspace."),
                        );
                        setSecondaryConfirming(false);
                      })
                      .finally(() => setSecondaryWorking(false));
                  }}
                />
              </div>
            )}
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="text-xs fg-destructive"
            data-testid={testIds?.error}
          >
            {error}
          </div>
        )}
        {activeTab !== 'danger' && (
          <div className="flex items-center justify-end gap-2">
            {justSaved && !saving && (
              <span
                role="status"
                className="mr-auto text-xs fg-secondary"
                data-testid={testIds?.saved}
              >
                Saved
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              disabled={working}
              className="rounded-md border px-3 py-2 text-s font-medium fg-primary transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
            >
              Done
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={working || !trimmedName}
              data-testid={testIds?.save}
              className="rounded-md bg-accent px-3 py-2 text-s font-medium fg-emphasis transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>
    </DialogModal>
  );
}
