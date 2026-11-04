import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import { Button, Heading } from '@canopy/ui-shared/components';
import { offerLifecycleJournalQuarantine } from '@canopy/app-state';
import {
  isDefaultCoworkWorkspaceId,
  type ChatProjectData,
  type ChatProjectTemplateDraft,
  type ChatTabPluginSelections,
  type UpdateChatProjectRequest,
} from '@canopy/desktop-shared/types';
import { EMPTY_SELECTIONS, normalizeSelections } from '@/lib/pluginSelections';
import {
  DEFAULT_ARCHIVE_RETENTION_DAYS,
  DEFAULT_AUTO_ARCHIVE_DAYS,
  MAX_ARCHIVE_RETENTION_DAYS,
  shouldPersistArchiveRetention,
  toArchiveRetentionDraft,
  toPersistedArchiveRetentionDays,
} from '@/lib/archiveRetentionSettings';
import { brandText } from '@/lib/brand';
import { DialogModal } from '../shared';
import {
  FormField,
  PluginSelectionScopeHelp,
  SettingsTabBar,
  ErrorBanner,
  TextArea,
  TextInput,
} from '@canopy/ui-shared/components';
import { PluginSelector } from '../shared/PluginSelector';
import { ClaudeLogo } from '../ClaudeLogo';
import { PluginsIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  AutoArchiveSettingsControl,
  PrivateMemoryCard,
} from '@canopy/ui-shared';
import { usePrivateMemoryDraft } from '@/hooks/usePrivateMemoryDraft';
import { AlwaysShowWorkspaceCard } from '../worktree/WorktreeSettingsControls';
import { WorkspaceEnvironmentTab } from '../worktree/WorkspaceEnvironmentTab';
import { useNavigationStore } from '@/stores/navigationStore';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { WorkspaceTemplateShareTab } from './WorkspaceTemplateShareTab';
import { useCanopyDesktopStartPageEnabled } from '@/hooks/useCanopyDesktopStartPageEnabled';
import {
  StartPageSettingControl,
  type StartPageSettingValue,
} from '../settings/start-page/StartPageSettingControl';
import { startPagesEqual } from '@/lib/start-page/project-start-page';
import { useStartPageStore } from '@/stores/startPageStore';
import {
  getSidebarProjectEntries,
  useStandaloneChatStore,
} from '@/stores/standaloneChatStore';
import { recheckWorkspaceRemovalBlockedReason } from '@/stores/chat/close-guard';

type ChatProjectSettingsTab =
  | 'general'
  | 'instructions'
  | 'plugins'
  | 'environment'
  | 'share'
  | 'danger';

interface DangerTabCopy {
  title: string;
  description: string;
  deletePermanentlyLabel: string;
  deletePermanentlyDescription: string;
  triggerButtonLabel: string;
  confirmButtonLabel: string;
}

/**
 * Danger-tab copy branches on whether the cowork workspace is external
 * (`externalPath` set): removal there is a detach that never touches the
 * user's folder, so the wording must not read like a delete. Extracted from
 * the component body to keep its cyclomatic/cognitive complexity down.
 *
 * There is exactly one delete behavior now: the backend has no merge-into-
 * default disposition, so this copy must never promise that chats can be
 * preserved by moving them elsewhere.
 */
function getDangerTabCopy(
  isExternalWorkspace: boolean,
  isDeleting: boolean,
): DangerTabCopy {
  if (!isExternalWorkspace) {
    return {
      title: 'Delete project',
      description:
        'Deletes the project and all of its chat data permanently. This cannot be undone.',
      deletePermanentlyLabel: 'Delete permanently',
      deletePermanentlyDescription:
        'Removes the project folder and all chat data stored in it.',
      triggerButtonLabel: 'Delete project…',
      confirmButtonLabel: isDeleting ? 'Deleting…' : 'Confirm delete',
    };
  }

  return {
    title: 'Detach project',
    description: `Detaching removes this project from ${brandText.appName} — your folder and its files are never touched.`,
    deletePermanentlyLabel: 'Detach permanently',
    deletePermanentlyDescription: `Removes chat data ${brandText.appName} stored for this project. Your folder itself, and anything inside it, is left exactly as it is.`,
    triggerButtonLabel: 'Detach project…',
    confirmButtonLabel: isDeleting ? 'Detaching…' : 'Confirm detach',
  };
}

interface ChatProjectSettingsModalProps {
  isOpen: boolean;
  project: ChatProjectData | null;
  /**
   * Set when the cowork workspace is attached to an external folder rather
   * than a Canopy-managed one. Drives the danger-tab copy: removal of an
   * external workspace is a detach (the folder and its `.{brand}/` managed
   * subfolder are left untouched), not a delete.
   */
  externalPath?: string;
  initialTab?: 'general' | 'environment' | 'share';
  onClose: () => void;
  onSave: (req: UpdateChatProjectRequest) => Promise<void>;
  onDelete: (projectId: string) => Promise<void>;
}

export function ChatProjectSettingsModal({
  isOpen,
  project,
  externalPath,
  initialTab = 'general',
  onClose,
  onSave,
  onDelete,
}: ChatProjectSettingsModalProps): JSX.Element | null {
  const [activeTab, setActiveTab] = useState<ChatProjectSettingsTab>('general');
  useCurrentUiStateReporter(
    'workspaceSettings.modal',
    isOpen && project
      ? {
          open: true,
          workspaceId: project.id,
          workspaceType: 'cowork',
          activeTab,
        }
      : null,
  );
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState('');
  const [claudeMd, setClaudeMd] = useState('');
  const [loadedClaudeMd, setLoadedClaudeMd] = useState('');
  const [claudeMdLoading, setClaudeMdLoading] = useState(false);
  const [plugins, setPlugins] =
    useState<ChatTabPluginSelections>(EMPTY_SELECTIONS);
  const [retentionDays, setRetentionDays] = useState(
    DEFAULT_ARCHIVE_RETENTION_DAYS,
  );
  const [autoArchiveEnabled, setAutoArchiveEnabled] = useState(false);
  const [autoArchiveDays, setAutoArchiveDays] = useState(
    DEFAULT_AUTO_ARCHIVE_DAYS,
  );
  const [alwaysShow, setAlwaysShow] = useState(true);
  const [startPage, setStartPage] = useState<StartPageSettingValue>(undefined);
  const [startPageValid, setStartPageValid] = useState(true);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState('');
  // The failure's own text: copied by Copy details, never shown.
  const [errorDetails, setErrorDetails] = useState('');
  const startPageEnabled = useCanopyDesktopStartPageEnabled();
  const privateMemory = usePrivateMemoryDraft(project);
  const resetPrivateMemory = privateMemory.reset;
  // Only opening the dialog drops the draft. The effect below also re-runs
  // when a save reloads `project`, which must not clear a refusal's reason.
  useEffect(() => {
    if (isOpen) resetPrivateMemory();
  }, [isOpen, resetPrivateMemory]);
  const templateDraft = useMemo<ChatProjectTemplateDraft>(
    () => ({
      name: name.trim(),
      description,
      ...(color === '' ? {} : { color }),
      instructions: claudeMd,
      defaultPluginSelections: plugins,
    }),
    [claudeMd, color, description, name, plugins],
  );

  useEffect(() => {
    if (!isOpen || !project) return;

    let canceled = false;

    setActiveTab(initialTab);
    setName(project.name);
    setDescription(project.description ?? '');
    setColor(project.color ?? '');
    setClaudeMd('');
    setLoadedClaudeMd('');
    setClaudeMdLoading(true);
    setPlugins(project.defaultPluginSelections ?? EMPTY_SELECTIONS);
    // Shared retention semantics: never-set, legacy `null`, and legacy `0`
    // all render as the 7-day default (deletion retention is always on).
    setRetentionDays(
      toArchiveRetentionDraft('cowork', project.archiveRetentionDays).days,
    );
    setAutoArchiveEnabled(
      typeof project.autoArchiveDays === 'number' &&
        project.autoArchiveDays > 0,
    );
    setAutoArchiveDays(
      typeof project.autoArchiveDays === 'number' && project.autoArchiveDays > 0
        ? project.autoArchiveDays
        : DEFAULT_AUTO_ARCHIVE_DAYS,
    );
    setAlwaysShow(project.alwaysShow !== false);
    setStartPage(project.startPage);
    setStartPageValid(true);
    setConfirmingDelete(false);
    setError('');
    setErrorDetails('');

    const loadClaudeMd = async (): Promise<void> => {
      try {
        const content = await window.api.chatProject.loadClaudeMd({
          projectId: project.id,
        });
        if (canceled) {
          return;
        }
        setClaudeMd((current) => (current === '' ? content : current));
        setLoadedClaudeMd(content);
      } catch (cause) {
        if (canceled) {
          return;
        }
        setClaudeMd('');
        setLoadedClaudeMd('');
        setError("Couldn't load CLAUDE.md. Try again.");
        setErrorDetails(cause instanceof Error ? cause.message : '');
      } finally {
        if (!canceled) {
          setClaudeMdLoading(false);
        }
      }
    };

    void loadClaudeMd();

    return (): void => {
      canceled = true;
    };
  }, [initialTab, isOpen, project]);

  if (!isOpen || !project) return null;
  const currentProject = project;

  const isDefaultProject = isDefaultCoworkWorkspaceId(currentProject.id);
  const isExternalWorkspace = externalPath !== undefined;
  const dangerTabCopy = getDangerTabCopy(isExternalWorkspace, isDeleting);
  const nameDirty = name.trim() !== currentProject.name;
  const descriptionDirty = description !== (currentProject.description ?? '');
  const colorDirty = color !== (currentProject.color ?? '');
  const claudeMdDirty = claudeMd !== loadedClaudeMd;
  const pluginsDirty =
    normalizeSelections(plugins) !==
    normalizeSelections(
      currentProject.defaultPluginSelections ?? EMPTY_SELECTIONS,
    );
  // Persist-on-save compares EFFECTIVE retention (resolved days) AND forces a
  // write while the persisted value is still a legacy `null`/absent/`0`, so
  // the first Save arms the per-chat archive sweep to match the 7-day default
  // this modal displays.
  const retentionDraft = { days: retentionDays };
  const retentionDirty = shouldPersistArchiveRetention(
    'cowork',
    currentProject.archiveRetentionDays,
    retentionDraft,
  );
  const newRetentionDays = toPersistedArchiveRetentionDays(
    'cowork',
    retentionDraft,
  );
  const newAutoArchiveDays = autoArchiveEnabled ? autoArchiveDays : null;
  const autoArchiveDirty =
    (currentProject.autoArchiveDays ?? null) !== newAutoArchiveDays;
  const alwaysShowDirty = alwaysShow !== (currentProject.alwaysShow !== false);
  const startPageDirty = !startPagesEqual(startPage, currentProject.startPage);
  const isDirty =
    nameDirty ||
    descriptionDirty ||
    colorDirty ||
    claudeMdDirty ||
    pluginsDirty ||
    retentionDirty ||
    autoArchiveDirty ||
    alwaysShowDirty ||
    startPageDirty ||
    privateMemory.dirty;

  async function handleSave(): Promise<void> {
    if (!startPageValid) return;
    setIsSaving(true);
    setError('');
    setErrorDetails('');
    try {
      if (
        nameDirty ||
        descriptionDirty ||
        colorDirty ||
        pluginsDirty ||
        retentionDirty ||
        autoArchiveDirty ||
        alwaysShowDirty ||
        startPageDirty
      ) {
        await onSave({
          projectId: currentProject.id,
          ...(nameDirty ? { name: name.trim() } : {}),
          ...(descriptionDirty ? { description } : {}),
          ...(colorDirty ? { color } : {}),
          ...(pluginsDirty ? { defaultPluginSelections: plugins } : {}),
          ...(retentionDirty ? { archiveRetentionDays: newRetentionDays } : {}),
          ...(autoArchiveDirty ? { autoArchiveDays: newAutoArchiveDays } : {}),
          ...(alwaysShowDirty ? { alwaysShow } : {}),
          ...(startPageDirty ? { startPage: startPage ?? null } : {}),
        });
        if (startPageDirty) {
          await useStartPageStore.getState().refreshProject(currentProject.id);
        }
      }
      if (claudeMdDirty) {
        await window.api.chatProject.saveClaudeMd({
          projectId: currentProject.id,
          content: claudeMd,
        });
        setLoadedClaudeMd(claudeMd);
      }
      // Last, so a refusal (the value became organization-managed) keeps
      // the dialog open on the reloaded value with everything else saved.
      if (!(await privateMemory.save())) return;
      onClose();
    } catch (cause) {
      setError("Couldn't save these settings. Try again.");
      setErrorDetails(cause instanceof Error ? cause.message : '');
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete(): Promise<void> {
    setIsDeleting(true);
    setError('');
    setErrorDetails('');
    try {
      const standaloneState = useStandaloneChatStore.getState();
      let worktreeIds = getSidebarProjectEntries(
        standaloneState,
        currentProject.id,
      ).map((entry) => entry.id);
      if (
        worktreeIds.length === 0 &&
        standaloneState.activeChatProjectId !== currentProject.id
      ) {
        await useStandaloneChatStore
          .getState()
          .loadSidebarProjectEntries(currentProject.id);
        worktreeIds = getSidebarProjectEntries(
          useStandaloneChatStore.getState(),
          currentProject.id,
        ).map((entry) => entry.id);
      }
      const removalReason = await recheckWorkspaceRemovalBlockedReason(
        currentProject.id,
        worktreeIds,
      );
      if (removalReason !== undefined) {
        setError(removalReason);
        return;
      }
      await onDelete(currentProject.id);
      onClose();
    } catch (cause) {
      offerLifecycleJournalQuarantine(cause);
      setError("Couldn't delete this project. Try again.");
      setErrorDetails(cause instanceof Error ? cause.message : '');
    } finally {
      setIsDeleting(false);
      setConfirmingDelete(false);
    }
  }

  const tabs: Array<{
    id: ChatProjectSettingsTab;
    label: string;
    icon?: ReactNode;
    danger?: boolean;
  }> = isDefaultProject
    ? [
        { id: 'general', label: 'General' },
        {
          id: 'instructions',
          label: 'Instructions',
          icon: <ClaudeLogo width={14} height={14} />,
        },
        { id: 'plugins', label: 'Plugins', icon: <PluginsIcon /> },
        { id: 'environment', label: 'Environment' },
        { id: 'share', label: 'Share' },
      ]
    : [
        { id: 'general', label: 'General' },
        {
          id: 'instructions',
          label: 'Instructions',
          icon: <ClaudeLogo width={14} height={14} />,
        },
        { id: 'plugins', label: 'Plugins', icon: <PluginsIcon /> },
        { id: 'environment', label: 'Environment' },
        { id: 'share', label: 'Share' },
        { id: 'danger', label: 'Danger', danger: true },
      ];

  return (
    <DialogModal
      inset="flush"
      onClose={onClose}
      title={currentProject.name}
      titleId="chat-project-settings-title"
      maxWidth="5xl"
      minHeight="28rem"
    >
      <SettingsTabBar
        tabs={tabs}
        activeTab={activeTab}
        onChange={setActiveTab}
      />

      <div
        data-testid="chat-project-settings-body"
        className={`flex-1 p-6 ${
          activeTab === 'plugins' ||
          activeTab === 'instructions' ||
          activeTab === 'environment'
            ? 'flex min-h-0 flex-col'
            : 'overflow-y-auto'
        }`}
      >
        {activeTab === 'general' && (
          <div className="space-y-4">
            <FormField id="chat-project-name" label="Name">
              {(control) => (
                <TextInput
                  {...control}
                  density="settings"
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              )}
            </FormField>

            <FormField id="chat-project-description" label="Description">
              {(control) => (
                <TextArea
                  {...control}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  placeholder="Optional project description"
                />
              )}
            </FormField>

            <FormField id="chat-project-color" label="Color">
              {(control) => (
                <div className="w-40">
                  <TextInput
                    {...control}
                    density="settings"
                    type="text"
                    leading={
                      <span
                        aria-hidden="true"
                        className="size-3.5 rounded-full border"
                        style={{
                          backgroundColor: color || 'var(--bg-tertiary)',
                        }}
                      />
                    }
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    placeholder="#hex"
                  />
                </div>
              )}
            </FormField>

            <div className="rounded-lg border bg-secondary/20 px-3 py-3">
              <div className="text-xs font-medium fg-secondary">Created</div>
              <div className="mt-1 text-s fg-primary">
                {new Date(currentProject.createdAt).toLocaleString()}
              </div>
            </div>

            <AlwaysShowWorkspaceCard
              checked={alwaysShow}
              onChange={setAlwaysShow}
              workspaceKind="cowork"
            />

            <PrivateMemoryCard
              checked={privateMemory.checked}
              onChange={privateMemory.setChecked}
              disabled={isSaving}
              managed={privateMemory.managed}
              organizationName={privateMemory.organizationName}
              error={privateMemory.error}
              dataTestId="chat-project-settings-private-memory"
            />

            {startPageEnabled && (
              <StartPageSettingControl
                workspaceId={currentProject.id}
                target={{ kind: 'cowork' }}
                projectType="cowork"
                value={startPage}
                onChange={setStartPage}
                onValidityChange={setStartPageValid}
              />
            )}

            <div
              className="rounded-lg border p-4"
              data-testid="chat-project-settings-retention"
            >
              <div data-testid="chat-project-settings-retention-card">
                <Heading level={3} variant="title">
                  Deletion retention
                </Heading>
                <p className="mt-1 text-xs fg-secondary">
                  {`Deleted chats and legacy archived chats are kept for ${retentionDays} ${retentionDays === 1 ? 'day' : 'days'} before they're removed. Archived work entries are kept until you delete them.`}
                </p>
                <div className="mt-3 flex items-center gap-3">
                  <span
                    id="chat-project-settings-retention-days-label"
                    className="text-s fg-primary"
                  >
                    Keep deleted chats for
                  </span>
                  <div className="w-28">
                    <TextInput
                      density="settings"
                      trailing="days"
                      aria-labelledby="chat-project-settings-retention-days-label"
                      type="number"
                      value={retentionDays}
                      onChange={(e) =>
                        setRetentionDays(
                          Math.max(
                            1,
                            Math.min(
                              MAX_ARCHIVE_RETENTION_DAYS,
                              parseInt(e.target.value) ||
                                DEFAULT_ARCHIVE_RETENTION_DAYS,
                            ),
                          ),
                        )
                      }
                      min={1}
                      max={MAX_ARCHIVE_RETENTION_DAYS}
                      data-testid="chat-project-settings-retention-days"
                    />
                  </div>
                </div>
                <AutoArchiveSettingsControl
                  enabled={autoArchiveEnabled}
                  days={autoArchiveDays}
                  maxDays={MAX_ARCHIVE_RETENTION_DAYS}
                  fallbackDays={DEFAULT_AUTO_ARCHIVE_DAYS}
                  description="Delete fully idle work entries after a period of inactivity."
                  toggleTestId="chat-project-settings-auto-archive-toggle"
                  daysTestId="chat-project-settings-auto-archive-days"
                  onEnabledChange={setAutoArchiveEnabled}
                  onDaysChange={setAutoArchiveDays}
                  daysLabel="days"
                  textSize="s"
                />
              </div>
            </div>
          </div>
        )}

        {activeTab === 'plugins' && (
          <div className="flex flex-1 flex-col min-h-0 gap-3">
            <PluginSelectionScopeHelp />
            <div className="flex flex-1 flex-col min-h-0">
              <PluginSelector
                selections={plugins}
                onChange={setPlugins}
                inset={false}
              />
            </div>
          </div>
        )}

        {activeTab === 'instructions' && (
          <div className="flex min-h-0 flex-1 flex-col">
            <Heading level={3} variant="title" id="claude-md-label">
              CLAUDE.md
            </Heading>
            <p id="claude-md-description" className="mt-1 text-xs fg-secondary">
              Instructions for every chat in this project.
            </p>
            <TextArea
              mono
              value={claudeMd}
              onChange={(event) => setClaudeMd(event.target.value)}
              disabled={claudeMdLoading}
              aria-labelledby="claude-md-label"
              aria-describedby="claude-md-description"
              className="mt-2 min-h-0 flex-1"
              placeholder="# Project instructions&#10;&#10;Add project-specific CLAUDE.md content here…"
            />
          </div>
        )}

        {activeTab === 'environment' && (
          <WorkspaceEnvironmentTab
            workspaceId={currentProject.id}
            workspaceName={currentProject.name}
            workspaceKind="cowork"
            onManageEnvironments={() => {
              onClose();
              useNavigationStore.getState().openSettings('environment');
            }}
          />
        )}

        {activeTab === 'share' &&
          (claudeMdLoading ? (
            <p className="text-xs fg-secondary">Loading sharing details…</p>
          ) : (
            <WorkspaceTemplateShareTab
              projectId={currentProject.id}
              draft={templateDraft}
            />
          ))}

        {activeTab === 'danger' && !isDefaultProject && (
          <div className="rounded-lg border border-line-destructive/30 p-4">
            <h3 className="text-s font-medium fg-destructive">
              {dangerTabCopy.title}
            </h3>
            <p className="mt-1 text-xs fg-secondary">
              {dangerTabCopy.description}
            </p>

            <div className="mt-4 rounded-lg border border-line-destructive/20 px-3 py-2">
              <div className="text-s fg-primary">
                {dangerTabCopy.deletePermanentlyLabel}
              </div>
              <div className="text-xs fg-secondary">
                {dangerTabCopy.deletePermanentlyDescription}
              </div>
            </div>

            {!confirmingDelete ? (
              <Button
                variant="ghost-destructive"
                size="compact"
                onClick={() => setConfirmingDelete(true)}
                className="mt-4"
              >
                {dangerTabCopy.triggerButtonLabel}
              </Button>
            ) : (
              <div className="mt-4 flex items-center gap-2">
                <Button
                  variant="destructive"
                  size="compact"
                  onClick={() => void handleDelete()}
                  disabled={isDeleting}
                >
                  {dangerTabCopy.confirmButtonLabel}
                </Button>
                <Button
                  variant="secondary"
                  size="compact"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={isDeleting}
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {activeTab !== 'danger' &&
        activeTab !== 'environment' &&
        activeTab !== 'share' &&
        isDirty && (
          <div className="flex justify-end border-t px-6 py-3">
            <Button
              variant="primary"
              size="compact"
              onClick={() => void handleSave()}
              disabled={isSaving || !startPageValid}
            >
              {isSaving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        )}

      <ErrorBanner
        error={error}
        className="mx-6 mb-4"
        {...(errorDetails ? { details: errorDetails } : {})}
      />
    </DialogModal>
  );
}
