import { resolveHookComposerContext } from '@/lib/configurationComposerTargets';
import { PluginSelectionScopeHelp } from '@canopy/ui-shared/components';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { normalizeScriptName } from '@canopy/desktop-shared/scripts';
import { normalizePluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import type {
  ChatTabPluginSelections,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import {
  getShareablePluginRefKey,
  type ShareablePluginRef,
} from '@canopy/desktop-shared/plugin-refs';
import { EMPTY_SELECTIONS, normalizeSelections } from '@/lib/pluginSelections';
import {
  DEFAULT_AUTO_ARCHIVE_DAYS,
  DEFAULT_ARCHIVE_RETENTION_DAYS,
  MAX_ARCHIVE_RETENTION_DAYS,
  isArchiveRetentionDraftDirty,
  toArchiveRetentionDraft,
  toPersistedArchiveRetentionDays,
  type ArchiveRetentionDraft,
} from '@/lib/archiveRetentionSettings';
import {
  canSubmitProjectSourceDraft,
  hasProjectSourceDraft,
  hasProjectSourceHookDraft,
  shouldResetProjectSettingsModalState,
} from '@/lib/projectSettingsModalState';
import { applyHydratedSourceScripts } from '@/lib/sourceScriptsHydration';
import { applyHydratedSourceHooks } from '@/lib/sourceHooksHydration';
import {
  createEditableScripts,
  getEditableCustomScripts,
  getEditableScriptDevServerPatterns,
  getEditableScriptInteractive,
  getEditableScriptShell,
  getEditableScriptTimeoutSeconds,
  getEditableScriptValue,
  removeEditableScript,
  setEditableScriptDevServerPatterns,
  setEditableScriptInteractive,
  setEditableScriptShell,
  setEditableScriptTimeoutSeconds,
  setEditableScriptValue,
  toScriptInputMap,
  type EditableDevServerPattern,
  type EditableScript,
  type EditableScripts,
} from '@/lib/editableScripts';
import type { CommandShellDefinition } from '@canopy/desktop-shared/scripts';
import {
  createEditableHooks,
  toHookInputMap,
  serializeHooks,
  type EditableHooks,
} from '@/lib/editableHooks';
import { useProjectsStore, TeardownFailedError } from '@/stores/projectsStore';
import { useChatStore } from '@/stores/chatStore';
import { useChatSidebarStore } from '@/stores/chatSidebarStore';
import { brandText } from '@/lib/brand';
import { RepoRulesStatusCard } from '@canopy/ui-app/repo-rules';
import {
  openRepoRulesModal,
  useRepoRulesModalStore,
} from '@/stores/repoRulesModalStore';
import { HookActionEditor } from './HookActionEditor';
import { ScriptConfigEditor } from './ScriptConfigEditor';
import { ScriptActionsSettingsSection } from '../script-actions/ScriptActionsSettingsSection';
import { Button, CopyButton, DialogModal, LoadingSpinner } from '../shared';
import {
  AutoArchiveSettingsControl,
  PrivateMemoryCard,
} from '@canopy/ui-shared';
import { PluginSelector } from '../shared/PluginSelector';
import { ShareablePluginSelector } from '../shared/ShareablePluginSelector';
import { RecommendedPluginsSettingsPanel } from './RecommendedPluginsSettingsPanel';
import {
  AddToWorktreeActionControls,
  AlwaysShowWorkspaceCard,
  HOOK_SETTINGS_ICON,
  SaveLocalButton,
  SCRIPT_SETTINGS_ICON,
  SettingsDangerConfirmBlock,
  SettingsDirectoryCard,
  SettingsTabBar,
  SettingsTeardownFailureDialog,
  SourceLocalToggle,
  SourceWorktreePicker,
  WorkspaceHealthIssuesBlock,
} from './WorktreeSettingsControls';
import {
  serializeEditableScriptsForSettings,
  useDefaultScriptTimeoutSeconds,
  useWorkspaceSettingsData,
  type AddToWorktreeFeedback,
} from './worktree-settings-controls-state';
import { PluginsIcon } from '@canopy/ui-shared/icons/AppIcons';
import { WorkspaceEnvironmentTab } from './WorkspaceEnvironmentTab';
import { WorkspacePlanDetectionSection } from './WorkspacePlanDetectionSection';
import { CodeGraphSummaryPanel } from './CodeGraphSummaryPanel';
import { GraphIcon } from '@canopy/ui-shared/icons';
import { useNavigationStore } from '@/stores/navigationStore';
import { useCodeGraphExperimentEnabled } from '@/hooks/useCodeGraphExperimentEnabled';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { WorkspaceReadinessRecommendations } from './WorkspaceReadinessRecommendations';
import { resolveWorkspaceReadinessWorktreeId } from '@/lib/workspaceReadinessLauncher';
import { useCanopyDesktopStartPageEnabled } from '@/hooks/useCanopyDesktopStartPageEnabled';
import { CodeStartPageSettings } from '../settings/start-page/CodeStartPageSettings';
import type { StartPageSettingsIntent } from '@/stores/navigationStore';
import { usePrivateMemoryDraft } from '@/hooks/usePrivateMemoryDraft';

type ProjectTab =
  | 'details'
  | 'scripts'
  | 'hooks'
  | 'plan-detection'
  | 'plugins'
  | 'environment'
  | 'code-graph'
  | 'start-page'
  | 'danger';

const tabs: {
  id: ProjectTab;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
}[] = [
  { id: 'details', label: 'General' },
  { id: 'scripts', label: 'Scripts', icon: SCRIPT_SETTINGS_ICON },
  { id: 'hooks', label: 'Hooks', icon: HOOK_SETTINGS_ICON },
  { id: 'plan-detection', label: 'Plan detection' },
  { id: 'plugins', label: 'Plugins', icon: <PluginsIcon /> },
  { id: 'environment', label: 'Environment' },
  { id: 'start-page', label: 'Start page' },
  { id: 'danger', label: 'Danger', danger: true },
];

interface ProjectSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  project: SingleRepoSidebarItem;
  initialTab?: ProjectTab;
  driftWorktreeId?: string;
  startPageIntent?: StartPageSettingsIntent;
}

function serializeScripts(scripts: EditableScripts): string {
  return serializeEditableScriptsForSettings(toScriptInputMap(scripts));
}

function scheduleAfterClosePaint(callback: () => void): void {
  window.requestAnimationFrame(() => {
    window.setTimeout(callback, 0);
  });
}

/**
 * Stable serializer for `ShareablePluginRef[]` arrays. Sorts canonical keys
 * before joining so two arrays with the same refs (in any order) compare
 * equal — used to drive the source-controlled plugin dirty-flag.
 */
function serializeShareablePluginRefs(refs: ShareablePluginRef[]): string {
  const keys: string[] = [];
  for (const ref of refs) {
    try {
      keys.push(getShareablePluginRefKey(ref));
    } catch {
      // Malformed refs cannot round-trip; ignore them in the comparison.
    }
  }
  keys.sort();
  return keys.join('|');
}

export function ProjectSettingsModal({
  isOpen,
  onClose,
  project,
  initialTab,
  driftWorktreeId,
  startPageIntent,
}: ProjectSettingsModalProps): JSX.Element | null {
  const archiveWorktree = useProjectsStore((state) => state.archiveWorktree);
  const forceArchiveWorktree = useProjectsStore(
    (state) => state.forceArchiveWorktree,
  );
  const loadProjects = useProjectsStore((state) => state.loadProjects);
  const setAppliedProjectWorktreeScripts = useProjectsStore(
    (state) => state.setAppliedProjectWorktreeScripts,
  );
  const setAppliedProjectWorktreeHooks = useProjectsStore(
    (state) => state.setAppliedProjectWorktreeHooks,
  );

  const [activeTab, setActiveTab] = useState<ProjectTab>('details');
  // Reload the saved Cursor rules setting when the review closes.
  const repoRulesRefreshToken = useRepoRulesModalStore((state) =>
    state.target ? 0 : state.openCount,
  );
  useCurrentUiStateReporter(
    'workspaceSettings.modal',
    isOpen
      ? {
          open: true,
          workspaceId: project.id,
          workspaceType: 'single-repo',
          activeTab,
        }
      : null,
  );
  const codeGraphExperimentEnabled = useCodeGraphExperimentEnabled();
  const startPageEnabled = useCanopyDesktopStartPageEnabled();
  const privateMemory = usePrivateMemoryDraft(project);
  const resetPrivateMemory = privateMemory.reset;

  // Insert the flag-gated Code Graph tab before Danger without mutating the
  // shared base tab list. Filtering the tab list must not reset unrelated
  // active tabs when the flag snapshot updates — only a runtime flag-off while
  // the Code Graph tab itself is active moves the user back to General (below).
  const visibleTabs = useMemo(() => {
    const enabledTabs = startPageEnabled
      ? tabs
      : tabs.filter((tab) => tab.id !== 'start-page');
    if (!codeGraphExperimentEnabled) return enabledTabs;
    const codeGraphTab: (typeof tabs)[number] = {
      id: 'code-graph',
      label: 'Code Graph',
      icon: <GraphIcon width={14} height={14} />,
    };
    const dangerIndex = enabledTabs.findIndex((tab) => tab.id === 'danger');
    if (dangerIndex === -1) {
      return [...enabledTabs, codeGraphTab];
    }
    return [
      ...enabledTabs.slice(0, dangerIndex),
      codeGraphTab,
      ...enabledTabs.slice(dangerIndex),
    ];
  }, [codeGraphExperimentEnabled, startPageEnabled]);

  useEffect(() => {
    if (!codeGraphExperimentEnabled && activeTab === 'code-graph') {
      setActiveTab('details');
    }
  }, [codeGraphExperimentEnabled, activeTab]);

  useEffect(() => {
    if (!startPageEnabled && activeTab === 'start-page')
      setActiveTab('details');
  }, [activeTab, startPageEnabled]);

  const [pendingPlugins, setPendingPlugins] = useState<ChatTabPluginSelections>(
    normalizePluginSelections(
      project.defaultPluginSelections ?? EMPTY_SELECTIONS,
    ),
  );
  const [pendingScripts, setPendingScripts] = useState<EditableScripts>(
    createEditableScripts(project.scripts),
  );
  const [newScriptName, setNewScriptName] = useState('');
  const [newScriptCommand, setNewScriptCommand] = useState('');
  // Timeout for the new custom-script draft. `undefined` keeps the global
  // default; `null` disables the timeout entirely. New drafts default to
  // `undefined` per the plan, so the global default applies unless the user
  // actively edits the control.
  const [newScriptTimeoutSeconds, setNewScriptTimeoutSeconds] = useState<
    number | null | undefined
  >(undefined);
  const [newScriptDevServerPatterns, setNewScriptDevServerPatterns] = useState<
    EditableDevServerPattern[] | undefined
  >(undefined);
  const [newScriptShell, setNewScriptShell] = useState<
    CommandShellDefinition | undefined
  >(undefined);
  const [newScriptInteractive, setNewScriptInteractive] = useState(false);
  // Map of "validity scope id" → array of offending row ids. The aggregate
  // `hasInvalidDevServerPatterns` flag below is true whenever any scope
  // reports a non-empty list.
  const [devServerPatternsInvalidRows, setDevServerPatternsInvalidRows] =
    useState<Record<string, string[]>>({});
  const [error, setError] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  const [isLoadingRemote, setIsLoadingRemote] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [isLinking, setIsLinking] = useState(false);
  const [linkError, setLinkError] = useState('');
  const [teardownError, setTeardownError] =
    useState<TeardownFailedError | null>(null);
  const [isTeardownRetrying, setIsTeardownRetrying] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const [showConvertOptions, setShowConvertOptions] = useState(false);
  const [pendingAlwaysShow, setPendingAlwaysShow] = useState(
    project.alwaysShow !== false,
  );
  const [pendingRetention, setPendingRetention] =
    useState<ArchiveRetentionDraft>(() =>
      toArchiveRetentionDraft('single-repo', project.archiveRetentionDays),
    );
  const [pendingAutoArchiveEnabled, setPendingAutoArchiveEnabled] = useState(
    typeof project.autoArchiveDays === 'number' && project.autoArchiveDays > 0,
  );
  const [pendingAutoArchiveDays, setPendingAutoArchiveDays] = useState(
    typeof project.autoArchiveDays === 'number' && project.autoArchiveDays > 0
      ? project.autoArchiveDays
      : DEFAULT_AUTO_ARCHIVE_DAYS,
  );
  const [pendingAutoArchiveDeleteBranch, setPendingAutoArchiveDeleteBranch] =
    useState(project.autoArchiveDeleteBranch === true);
  const defaultScriptTimeoutSeconds = useDefaultScriptTimeoutSeconds(isOpen);

  // Worktree selector for source-controlled view
  const [hookComposerBlocked, setHookComposerBlocked] = useState(false);
  const [sourceInspectWorktreeId, setSourceInspectWorktreeId] = useState<
    string | undefined
  >(driftWorktreeId);

  // Resolve a cwd for project pipeline discovery in the hook editor.
  // When a worktree is being inspected we look up its path via getWorktreePath
  // so the pipeline picker reflects what is actually checked out; otherwise
  // we fall back to the project's source repo path.
  const [pipelineDiscoveryCwd, setPipelineDiscoveryCwd] = useState<
    string | undefined
  >(undefined);

  // Source/local script split state (mirrors multi-repo modal)
  const [scriptEditMode, setScriptEditMode] = useState<'source' | 'local'>(
    driftWorktreeId ? 'source' : 'local',
  );
  const [sourceScripts, setSourceScripts] = useState<EditableScripts>({});
  const [loadedSourceScripts, setLoadedSourceScripts] =
    useState<EditableScripts>({});
  const sourceScriptsRef = useRef<EditableScripts>({});
  const loadedSourceScriptsRef = useRef<EditableScripts>({});

  // Hook state (mirrors scripts)
  const [pendingHooks, setPendingHooks] = useState<EditableHooks>(
    createEditableHooks(project.hooks),
  );
  const [hookEditMode, setHookEditMode] = useState<'source' | 'local'>(
    driftWorktreeId ? 'source' : 'local',
  );
  const [sourceHooks, setSourceHooks] = useState<EditableHooks>({});
  const [loadedSourceHooks, setLoadedSourceHooks] = useState<EditableHooks>({});
  const sourceHooksRef = useRef<EditableHooks>({});
  const loadedSourceHooksRef = useRef<EditableHooks>({});
  const [pluginEditMode, setPluginEditMode] = useState<'source' | 'local'>(
    driftWorktreeId ? 'source' : 'local',
  );
  const [sourcePlugins, setSourcePlugins] = useState<ShareablePluginRef[]>([]);
  const wasOpenRef = useRef(false);
  const isOpenRef = useRef(isOpen);
  const activeProjectIdRef = useRef(project.id);
  const sourceInspectWorktreeIdRef = useRef(sourceInspectWorktreeId);
  const [isApplyingToWorktree, setIsApplyingToWorktree] = useState(false);
  const {
    healthData,
    setHealthData,
    hasLoadedWorkspaceSettingsData,
    workspaceSettingsLoadError,
  } = useWorkspaceSettingsData({
    isOpen,
    workspaceId: project.id,
    worktreeId: sourceInspectWorktreeId,
    fallbackErrorMessage: 'Failed to load source-controlled scripts.',
  });
  const [addToWorktreeFeedback, setAddToWorktreeFeedback] =
    useState<AddToWorktreeFeedback>({ phase: 'idle' });
  const [worktreeDropdownOpen, setWorktreeDropdownOpen] = useState(false);
  const [existingWorktreeDropdownOpen, setExistingWorktreeDropdownOpen] =
    useState(false);

  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  useEffect(() => {
    sourceInspectWorktreeIdRef.current = sourceInspectWorktreeId;
  }, [sourceInspectWorktreeId]);

  // Dirty-state calculations
  const localScriptsDirty =
    serializeScripts(pendingScripts) !==
    serializeScripts(createEditableScripts(project.scripts));
  const sourceScriptsDirty =
    serializeScripts(sourceScripts) !== serializeScripts(loadedSourceScripts);
  const localHooksDirty =
    serializeHooks(pendingHooks) !==
    serializeHooks(createEditableHooks(project.hooks));
  const sourceHooksDirty =
    serializeHooks(sourceHooks) !== serializeHooks(loadedSourceHooks);
  const pluginsDirty =
    normalizeSelections(pendingPlugins) !==
    normalizeSelections(project.defaultPluginSelections ?? EMPTY_SELECTIONS);
  const alwaysShowDirty = pendingAlwaysShow !== (project.alwaysShow !== false);
  const archiveRetentionDirty = isArchiveRetentionDraftDirty(
    'single-repo',
    project.archiveRetentionDays,
    pendingRetention,
  );
  const nextAutoArchiveDays = pendingAutoArchiveEnabled
    ? pendingAutoArchiveDays
    : null;
  const autoArchiveDirty =
    (project.autoArchiveDays ?? null) !== nextAutoArchiveDays ||
    (project.autoArchiveDeleteBranch === true) !==
      pendingAutoArchiveDeleteBranch;
  const sourcePluginsDirty =
    serializeShareablePluginRefs(sourcePlugins) !==
    serializeShareablePluginRefs(healthData?.manifest?.plugins ?? []);
  const isLocalDirty =
    pluginsDirty ||
    alwaysShowDirty ||
    archiveRetentionDirty ||
    autoArchiveDirty ||
    privateMemory.dirty ||
    localScriptsDirty ||
    localHooksDirty;
  const isSourceDirty =
    sourceScriptsDirty || sourceHooksDirty || sourcePluginsDirty;
  const hasSourceDraft =
    hasProjectSourceDraft(sourceScripts, healthData) ||
    hasProjectSourceHookDraft(sourceHooks, healthData);

  const setSourceScriptsWithRef = useCallback(
    (update: SetStateAction<EditableScripts>): void => {
      const next =
        typeof update === 'function'
          ? update(sourceScriptsRef.current)
          : update;
      sourceScriptsRef.current = next;
      setSourceScripts(next);
    },
    [],
  );

  // Active scripts for the current tab mode
  const activeScriptsForTab =
    scriptEditMode === 'source' ? sourceScripts : pendingScripts;
  const setActiveScriptsForTab =
    scriptEditMode === 'source' ? setSourceScriptsWithRef : setPendingScripts;

  // Active hooks for the current tab mode
  const activeHooksForTab =
    hookEditMode === 'source' ? sourceHooks : pendingHooks;
  const setActiveHooksForTab =
    hookEditMode === 'source' ? setSourceHooks : setPendingHooks;

  useEffect(() => {
    loadedSourceScriptsRef.current = loadedSourceScripts;
  }, [loadedSourceScripts]);

  useEffect(() => {
    sourceHooksRef.current = sourceHooks;
  }, [sourceHooks]);

  useEffect(() => {
    loadedSourceHooksRef.current = loadedSourceHooks;
  }, [loadedSourceHooks]);

  const hasActiveWorktrees = useChatSidebarStore((state) =>
    project.worktrees.some((wt) => {
      const wc = state.worktrees[`${project.id}/${wt.id}`];
      return wc?.tabs.some((tab) => tab.status === 'streaming') ?? false;
    }),
  );

  // Reset state on modal open
  useEffect(() => {
    const shouldReset = shouldResetProjectSettingsModalState(
      isOpen,
      wasOpenRef.current,
      activeProjectIdRef.current,
      project.id,
    );

    if (shouldReset) {
      setActiveTab(
        initialTab === 'scripts'
          ? 'scripts'
          : initialTab === 'hooks'
            ? 'hooks'
            : initialTab === 'environment'
              ? 'environment'
              : (initialTab ?? 'details'),
      );
      setPendingPlugins(
        normalizePluginSelections(
          project.defaultPluginSelections ?? EMPTY_SELECTIONS,
        ),
      );
      setPendingScripts(createEditableScripts(project.scripts));
      setNewScriptName('');
      setNewScriptCommand('');
      setNewScriptTimeoutSeconds(undefined);
      setNewScriptDevServerPatterns(undefined);
      setDevServerPatternsInvalidRows({});
      setError('');
      setConfirmingDelete(false);
      setLinkUrl('');
      setLinkError('');
      setTeardownError(null);
      setHealthData(null);
      setIsConverting(false);
      setShowConvertOptions(false);
      setPendingAlwaysShow(project.alwaysShow !== false);
      resetPrivateMemory();
      setPendingRetention(
        toArchiveRetentionDraft('single-repo', project.archiveRetentionDays),
      );
      setPendingAutoArchiveEnabled(project.autoArchiveDays != null);
      setPendingAutoArchiveDays(
        project.autoArchiveDays ?? DEFAULT_AUTO_ARCHIVE_DAYS,
      );
      setPendingAutoArchiveDeleteBranch(
        project.autoArchiveDeleteBranch === true,
      );
      setSourceInspectWorktreeId(driftWorktreeId);
      setScriptEditMode(driftWorktreeId ? 'source' : 'local');
      sourceScriptsRef.current = {};
      loadedSourceScriptsRef.current = {};
      setSourceScripts({});
      setLoadedSourceScripts({});
      setPendingHooks(createEditableHooks(project.hooks));
      setHookEditMode(driftWorktreeId ? 'source' : 'local');
      sourceHooksRef.current = {};
      loadedSourceHooksRef.current = {};
      setSourceHooks({});
      setLoadedSourceHooks({});
      setPluginEditMode(driftWorktreeId ? 'source' : 'local');
      setSourcePlugins([]);
      setIsApplyingToWorktree(false);
      // hasLoadedWorkspaceSettingsData / workspaceSettingsLoadError are owned
      // by useWorkspaceSettingsData and reset automatically when the load
      // effect re-runs on isOpen / workspaceId / worktreeId changes.
      setAddToWorktreeFeedback({ phase: 'idle' });
      setWorktreeDropdownOpen(false);
      setExistingWorktreeDropdownOpen(false);
    }

    wasOpenRef.current = isOpen;
    activeProjectIdRef.current = project.id;
  }, [
    driftWorktreeId,
    initialTab,
    isOpen,
    project.id,
    project.alwaysShow,
    project.archiveRetentionDays,
    project.autoArchiveDays,
    project.autoArchiveDeleteBranch,
    project.defaultPluginSelections,
    project.hooks,
    project.scripts,
    resetPrivateMemory,
    setHealthData,
  ]);

  // Load remote URL
  useEffect(() => {
    if (!isOpen) return;

    let canceled = false;
    setIsLoadingRemote(true);

    const load = async (): Promise<void> => {
      try {
        const result = await window.api.getRemoteUrl({
          repoPath: project.repoPath,
        });
        if (!canceled) {
          setRemoteUrl(result.remoteUrl);
        }
      } catch {
        if (!canceled) {
          setRemoteUrl(null);
        }
      } finally {
        if (!canceled) {
          setIsLoadingRemote(false);
        }
      }
    };

    void load();

    return (): void => {
      canceled = true;
    };
  }, [isOpen, project.repoPath]);

  // Resolve pipeline discovery cwd whenever the inspected worktree changes
  // so the hook-editor pipeline picker can include project pipelines.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    let cancelled = false;
    const resolveCwd = async (): Promise<void> => {
      if (sourceInspectWorktreeId) {
        try {
          const cwd = await window.api.getWorktreePath({
            projectId: project.id,
            worktreeId: sourceInspectWorktreeId,
          });
          if (!cancelled) {
            setPipelineDiscoveryCwd(cwd);
          }
        } catch {
          if (!cancelled) {
            setPipelineDiscoveryCwd(project.repoPath);
          }
        }
      } else if (!cancelled) {
        setPipelineDiscoveryCwd(project.repoPath);
      }
    };
    void resolveCwd();
    return (): void => {
      cancelled = true;
    };
  }, [isOpen, project.id, project.repoPath, sourceInspectWorktreeId]);

  // Initialize source scripts from healthData manifest
  useEffect(() => {
    if (!isOpen || !healthData) return;
    const manifestScripts = healthData.manifest?.scripts ?? {};
    const editable = createEditableScripts(manifestScripts);
    const nextState = applyHydratedSourceScripts(
      sourceScriptsRef.current,
      loadedSourceScriptsRef.current,
      editable,
    );
    sourceScriptsRef.current = nextState.sourceScripts;
    loadedSourceScriptsRef.current = nextState.loadedSourceScripts;
    setSourceScripts(nextState.sourceScripts);
    setLoadedSourceScripts(nextState.loadedSourceScripts);
  }, [healthData, isOpen]);

  // Initialize source hooks from healthData manifest
  useEffect(() => {
    if (!isOpen || !healthData) return;
    const manifestHooks = healthData.manifest?.hooks ?? {};
    const editable = createEditableHooks(manifestHooks);
    const nextState = applyHydratedSourceHooks(
      sourceHooksRef.current,
      loadedSourceHooksRef.current,
      editable,
    );
    sourceHooksRef.current = nextState.sourceHooks;
    loadedSourceHooksRef.current = nextState.loadedSourceHooks;
    setSourceHooks(nextState.sourceHooks);
    setLoadedSourceHooks(nextState.loadedSourceHooks);
  }, [healthData, isOpen]);

  // Initialize source-controlled plugin recommendations from the manifest.
  // `Add to Worktree` re-fetches `healthData`, which clears the dirty flag
  // on the next render via `sourcePluginsDirty`.
  useEffect(() => {
    if (!isOpen || !healthData) return;
    setSourcePlugins(healthData.manifest?.plugins ?? []);
  }, [healthData, isOpen]);

  const handleSaveLocal = async (): Promise<void> => {
    if (hookComposerBlocked) return;
    setIsSaving(true);
    setError('');
    try {
      if (localScriptsDirty) {
        await window.api.saveProjectScripts({
          projectId: project.id,
          scripts: toScriptInputMap(pendingScripts, project.scripts),
        });
      }
      if (localHooksDirty) {
        await window.api.saveProjectHooks({
          projectId: project.id,
          hooks: toHookInputMap(pendingHooks, project.hooks),
        });
      }
      if (pluginsDirty || alwaysShowDirty) {
        await window.api.saveProjectDefaultPlugins({
          projectId: project.id,
          defaultPluginSelections: normalizePluginSelections(pendingPlugins),
          alwaysShow: pendingAlwaysShow,
        });
      }
      if (archiveRetentionDirty || autoArchiveDirty) {
        await window.api.setWorkspaceArchiveRetention({
          workspaceId: project.id,
          archiveRetentionDays: toPersistedArchiveRetentionDays(
            'single-repo',
            pendingRetention,
          ),
          autoArchiveDays: nextAutoArchiveDays,
          autoArchiveDeleteBranch: pendingAutoArchiveDeleteBranch,
        });
      }
      // Last, so a refusal (the value became organization-managed) keeps
      // the dialog open on the reloaded value with everything else saved.
      if (!(await privateMemory.save())) return;
      await loadProjects();
      if (!isSourceDirty) {
        onClose();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to save');
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddToWorktree = async (
    target: { mode: 'new' } | { mode: 'existing'; worktreeId: string },
  ): Promise<void> => {
    if (hookComposerBlocked) return;
    if (
      !canSubmitProjectSourceDraft(hasLoadedWorkspaceSettingsData, healthData)
    ) {
      setError(
        workspaceSettingsLoadError ??
          'Source-controlled scripts are still loading. Wait for the canonical manifest, then try again.',
      );
      return;
    }

    const clientRequestId =
      window.crypto.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let appliedEventHandled = false;
    const handleApplied = (): void => {
      if (appliedEventHandled) {
        return;
      }
      appliedEventHandled = true;

      isOpenRef.current = false;
      onClose();
    };
    const unsubscribeApplied = window.api.onProjectSourceChangesApplied(
      (event) => {
        if (event.clientRequestId !== clientRequestId) {
          return;
        }
        handleApplied();
      },
    );

    setIsApplyingToWorktree(true);
    setError('');
    setExistingWorktreeDropdownOpen(false);
    setWorktreeDropdownOpen(false);
    setAddToWorktreeFeedback({
      phase: 'applying',
      targetLabel:
        target.mode === 'existing'
          ? `worktree ${target.worktreeId}`
          : 'new worktree',
    });
    try {
      const response = await window.api.applyProjectSourceChanges({
        clientRequestId,
        projectId: project.id,
        target:
          target.mode === 'existing'
            ? { mode: 'existing', worktreeId: target.worktreeId }
            : {
                mode: 'new',
                existingWorktreeIds: project.worktrees.map(
                  (worktree) => worktree.id,
                ),
              },
        scripts: toScriptInputMap(sourceScripts),
        hooks: toHookInputMap(sourceHooks, undefined, false),
        plugins: sourcePlugins,
      });

      const previousLoadedSourceScripts = loadedSourceScriptsRef.current;
      const appliedSourceScripts = { ...sourceScriptsRef.current };
      loadedSourceScriptsRef.current = appliedSourceScripts;
      setLoadedSourceScripts(appliedSourceScripts);
      setAppliedProjectWorktreeScripts(
        project.id,
        response.worktreeId,
        previousLoadedSourceScripts,
        appliedSourceScripts,
      );
      const previousLoadedSourceHooks = loadedSourceHooksRef.current;
      const appliedSourceHooks = { ...sourceHooksRef.current };
      loadedSourceHooksRef.current = appliedSourceHooks;
      setLoadedSourceHooks(appliedSourceHooks);
      setAppliedProjectWorktreeHooks(
        project.id,
        response.worktreeId,
        previousLoadedSourceHooks,
        appliedSourceHooks,
      );
      setSourceInspectWorktreeId(response.worktreeId);
      useChatStore.getState().selectWorktree(project.id, response.worktreeId);
      handleApplied();

      scheduleAfterClosePaint(() => {
        void loadProjects({ silent: true })
          .then(() => {
            useChatStore
              .getState()
              .selectWorktree(project.id, response.worktreeId);
            void useProjectsStore.getState().refreshDiffStats();
            // Surface a non-blocking install prompt for any newly authored chat
            // hook plugins that aren't installed locally yet. Fire-and-forget —
            // the dialog is rendered globally from WorktreeManager via the
            // `pendingHookChatPluginInstallPrompt` store field.
            void useProjectsStore
              .getState()
              .inspectHookChatPluginDependencies(
                project.id,
                response.worktreeId,
              );
          })
          .catch(() => undefined);

        void window.api
          .getWorkspaceSettingsData({
            workspaceId: project.id,
            worktreeId: response.worktreeId,
          })
          .then((freshHealthData) => {
            if (
              isOpenRef.current &&
              sourceInspectWorktreeIdRef.current === response.worktreeId
            ) {
              setHealthData(freshHealthData);
            }
          })
          .catch(() => undefined);
      });
    } catch (cause) {
      await loadProjects();
      setAddToWorktreeFeedback({ phase: 'idle' });
      setError(
        cause instanceof Error ? cause.message : 'Failed to apply to worktree',
      );
    } finally {
      unsubscribeApplied();
      setIsApplyingToWorktree(false);
    }
  };

  const handleLinkRemote = async (): Promise<void> => {
    setLinkError('');
    const url = linkUrl.trim();
    if (!url) {
      setLinkError('Remote URL is required');
      return;
    }

    setIsLinking(true);

    try {
      await window.api.linkRemote({
        repoPath: project.repoPath,
        remoteUrl: url,
      });
      setRemoteUrl(url);
      setLinkUrl('');
    } catch (cause) {
      setLinkError(
        cause instanceof Error ? cause.message : 'Failed to link remote',
      );
    } finally {
      setIsLinking(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    setError('');
    setIsDeleting(true);

    try {
      // Read live worktree list from store to avoid re-archiving already-removed worktrees
      const liveProject = useProjectsStore
        .getState()
        .projects.find(
          (p): p is SingleRepoSidebarItem =>
            p.id === project.id && p.type === 'single-repo',
        );
      const worktrees = liveProject?.worktrees ?? [];

      for (const wt of worktrees) {
        try {
          await archiveWorktree(project.id, wt.id);
        } catch (err) {
          if (err instanceof TeardownFailedError) {
            setTeardownError(err);
            setIsDeleting(false);
            setConfirmingDelete(false);
            return;
          }
          throw err;
        }
      }

      await window.api.deleteProject({
        projectId: project.id,
      });
      await loadProjects();
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Failed to delete project',
      );
    } finally {
      setIsDeleting(false);
      setConfirmingDelete(false);
    }
  };

  const handleConvertToMultiRepo = async (
    claudeMdMode: 'replace' | 'update' | 'unchanged',
  ): Promise<void> => {
    setError('');
    setIsConverting(true);

    try {
      await window.api.convertWorkspaceType({
        workspaceId: project.id,
        targetType: 'multi-repo',
        claudeMdMode,
      });
      await loadProjects();
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Failed to convert project',
      );
    } finally {
      setIsConverting(false);
      setShowConvertOptions(false);
    }
  };

  const hasInvalidDevServerPatterns = useMemo(() => {
    return Object.values(devServerPatternsInvalidRows).some(
      (rowIds) => rowIds.length > 0,
    );
  }, [devServerPatternsInvalidRows]);

  const makeDevServerValidityHandler = useCallback(
    (scopeId: string) =>
      (rowIds: string[]): void => {
        setDevServerPatternsInvalidRows((prev) => {
          const previousRows = prev[scopeId];
          if (
            rowIds.length === 0 &&
            (previousRows === undefined || previousRows.length === 0)
          ) {
            if (previousRows === undefined) {
              return prev;
            }
            const next = { ...prev };
            delete next[scopeId];
            return next;
          }
          if (
            previousRows &&
            previousRows.length === rowIds.length &&
            previousRows.every((id, i) => id === rowIds[i])
          ) {
            return prev;
          }
          return { ...prev, [scopeId]: rowIds };
        });
      },
    [],
  );

  if (!isOpen) return null;

  const customScripts = getEditableCustomScripts(activeScriptsForTab);
  const driftWorktree = driftWorktreeId
    ? project.worktrees.find((worktree) => worktree.id === driftWorktreeId)
    : undefined;

  const handleAddCustomScript = (): void => {
    const scriptName = normalizeScriptName(newScriptName);
    if (!scriptName || newScriptCommand.trim().length === 0) {
      return;
    }
    if (hasInvalidDevServerPatterns) {
      return;
    }
    setActiveScriptsForTab((current) => {
      const next: EditableScripts = { ...current };
      const entry: EditableScript = { command: newScriptCommand };
      if (newScriptTimeoutSeconds !== undefined) {
        entry.timeoutSeconds = newScriptTimeoutSeconds;
      }
      if (
        newScriptDevServerPatterns !== undefined &&
        newScriptDevServerPatterns.length > 0
      ) {
        entry.devServerPatterns = newScriptDevServerPatterns;
      }
      if (newScriptShell !== undefined) {
        entry.shell = newScriptShell;
      }
      if (newScriptInteractive) entry.interactive = true;
      next[scriptName] = entry;
      return next;
    });
    setNewScriptName('');
    setNewScriptCommand('');
    setNewScriptTimeoutSeconds(undefined);
    setNewScriptDevServerPatterns(undefined);
    setNewScriptShell(undefined);
    setNewScriptInteractive(false);
  };

  // Footer visibility rules
  const showFooter =
    activeTab !== 'danger' &&
    activeTab !== 'environment' &&
    activeTab !== 'code-graph';
  const showSaveLocal = isLocalDirty;
  const showAddToWorktreeAction =
    isSourceDirty || hasSourceDraft || addToWorktreeFeedback.phase !== 'idle';
  const canAddToWorktree = canSubmitProjectSourceDraft(
    hasLoadedWorkspaceSettingsData,
    healthData,
  );
  const addToWorktreeButtonLabel =
    addToWorktreeFeedback.phase === 'applying'
      ? `Adding to ${addToWorktreeFeedback.targetLabel}...`
      : workspaceSettingsLoadError
        ? 'Failed to load source scripts'
        : !canAddToWorktree
          ? 'Loading source scripts…'
          : !isSourceDirty && hasSourceDraft
            ? 'Apply to another worktree'
            : sourceInspectWorktreeId
              ? 'Add to worktree'
              : 'Add to new worktree';

  return (
    <DialogModal
      onClose={onClose}
      title={project.name}
      titleId="project-settings-title"
      maxWidth="5xl"
      minHeight="28rem"
    >
      {/* Tab bar */}
      <SettingsTabBar
        tabs={visibleTabs}
        activeTab={activeTab}
        onChange={setActiveTab}
      />

      {/* Tab panels */}
      <div
        className={`flex-1 ${activeTab === 'plugins' ? 'flex flex-col min-h-0' : 'overflow-y-auto'} p-5`}
      >
        {activeTab === 'details' && (
          <div className="space-y-4">
            <WorkspaceHealthIssuesBlock
              healthData={healthData}
              driftWorktree={driftWorktree}
            />

            <WorkspaceReadinessRecommendations
              workspaceId={project.id}
              worktreeId={resolveWorkspaceReadinessWorktreeId(
                healthData?.driftWorktreeId,
                sourceInspectWorktreeId,
              )}
              onViewConversation={onClose}
            />

            <SettingsDirectoryCard path={project.repoPath} />

            <div className="rounded-lg border p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-s font-medium fg-primary">Origin remote</h3>
                {remoteUrl && (
                  <CopyButton
                    value={remoteUrl}
                    ariaLabel="Copy origin remote URL"
                    title="Copy origin remote URL"
                  />
                )}
              </div>
              {isLoadingRemote ? (
                <p className="mt-1 text-xs fg-secondary">Checking remote…</p>
              ) : remoteUrl ? (
                <p className="mt-1 break-all font-mono text-xs fg-secondary">
                  {remoteUrl}
                </p>
              ) : (
                <>
                  <p className="mt-1 text-xs fg-secondary">
                    No remote configured. Link one to enable push and pull.
                  </p>
                  <label className="mt-3 block text-s">
                    <span className="mb-1.5 block text-xs fg-secondary">
                      Remote URL
                    </span>
                    <input
                      type="text"
                      value={linkUrl}
                      onChange={(event) => setLinkUrl(event.target.value)}
                      placeholder="https://github.com/org/repo.git or git@github.com:org/repo.git"
                      className="focus-ring w-full rounded-lg border bg-base px-3 py-2 text-s"
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          if (isLinking || !linkUrl.trim()) {
                            return;
                          }
                          void handleLinkRemote();
                        }
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void handleLinkRemote()}
                    disabled={isLinking || !linkUrl.trim()}
                    className="focus-ring mt-2 inline-flex items-center rounded-md bg-accent px-3 py-1.5 text-xs font-medium fg-emphasis disabled:opacity-60"
                  >
                    {isLinking ? 'Linking…' : 'Link remote'}
                  </button>
                  {linkError && (
                    <p className="mt-2 text-xs fg-destructive">{linkError}</p>
                  )}
                </>
              )}
            </div>

            <AlwaysShowWorkspaceCard
              checked={pendingAlwaysShow}
              onChange={setPendingAlwaysShow}
            />

            <PrivateMemoryCard
              checked={privateMemory.checked}
              onChange={privateMemory.setChecked}
              disabled={isSaving}
              managed={privateMemory.managed}
              organizationName={privateMemory.organizationName}
              error={privateMemory.error}
              dataTestId="project-settings-private-memory"
            />

            <RepoRulesStatusCard
              workspaceId={project.id}
              refreshToken={repoRulesRefreshToken}
              onReview={(): void =>
                openRepoRulesModal({
                  source: 'project-settings',
                  workspaceId: project.id,
                })
              }
            />

            <div
              className="rounded-lg border p-4"
              data-testid="project-settings-retention"
            >
              <div data-testid="project-settings-retention-card">
                <h3 className="text-sm font-medium fg-primary">
                  Deletion retention
                </h3>
                <p className="mt-1 text-xs fg-secondary">
                  {`Deleted worktrees are kept for ${pendingRetention.days} ${pendingRetention.days === 1 ? 'day' : 'days'} before they're removed. Archived worktrees are kept until you delete them.`}
                </p>
                <div className="mt-3 flex items-center gap-3">
                  <label className="flex items-center gap-2">
                    <span className="text-sm fg-primary">
                      Keep deleted worktrees for
                    </span>
                    <input
                      type="number"
                      value={pendingRetention.days}
                      onChange={(event) =>
                        setPendingRetention({
                          days: Math.max(
                            1,
                            Math.min(
                              MAX_ARCHIVE_RETENTION_DAYS,
                              parseInt(event.target.value) ||
                                DEFAULT_ARCHIVE_RETENTION_DAYS,
                            ),
                          ),
                        })
                      }
                      min={1}
                      max={MAX_ARCHIVE_RETENTION_DAYS}
                      data-testid="project-settings-retention-days"
                      className="w-20 rounded-lg border bg-secondary/30 px-3 py-2 text-sm fg-primary outline-none"
                    />
                    <span className="text-sm fg-secondary">days</span>
                  </label>
                </div>
                <AutoArchiveSettingsControl
                  enabled={pendingAutoArchiveEnabled}
                  days={pendingAutoArchiveDays}
                  maxDays={MAX_ARCHIVE_RETENTION_DAYS}
                  fallbackDays={DEFAULT_AUTO_ARCHIVE_DAYS}
                  description="Delete fully idle worktrees after a period of inactivity."
                  toggleTestId="project-settings-auto-archive-toggle"
                  daysTestId="project-settings-auto-archive-days"
                  onEnabledChange={setPendingAutoArchiveEnabled}
                  onDaysChange={setPendingAutoArchiveDays}
                >
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={pendingAutoArchiveDeleteBranch}
                      onChange={(event) =>
                        setPendingAutoArchiveDeleteBranch(event.target.checked)
                      }
                      data-testid="project-settings-auto-archive-delete-branch"
                      className="rounded"
                    />
                    <span className="text-sm fg-primary">
                      Delete the branch locally with the worktree
                    </span>
                  </label>
                </AutoArchiveSettingsControl>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'scripts' && (
          <div className="space-y-4">
            <SourceLocalToggle
              mode={scriptEditMode}
              onChange={setScriptEditMode}
            />

            <div>
              <ScriptConfigEditor
                label="Setup script"
                scriptName="setup"
                command={getEditableScriptValue(activeScriptsForTab, 'setup')}
                timeoutSeconds={getEditableScriptTimeoutSeconds(
                  activeScriptsForTab,
                  'setup',
                )}
                shell={getEditableScriptShell(activeScriptsForTab, 'setup')}
                interactive={getEditableScriptInteractive(
                  activeScriptsForTab,
                  'setup',
                )}
                onInteractiveChange={(next) =>
                  setActiveScriptsForTab((current) =>
                    setEditableScriptInteractive(current, 'setup', next),
                  )
                }
                onCommandChange={(nextValue) =>
                  setActiveScriptsForTab((current) =>
                    setEditableScriptValue(current, 'setup', nextValue),
                  )
                }
                onTimeoutSecondsChange={(nextTimeout) =>
                  setActiveScriptsForTab((current) =>
                    setEditableScriptTimeoutSeconds(
                      current,
                      'setup',
                      nextTimeout,
                    ),
                  )
                }
                onShellChange={(nextShell) =>
                  setActiveScriptsForTab((current) =>
                    setEditableScriptShell(current, 'setup', nextShell),
                  )
                }
                placeholder={'# Runs after worktree creation\nnpm install'}
                rows={4}
                defaultTimeoutSeconds={defaultScriptTimeoutSeconds}
                devServerPatterns={getEditableScriptDevServerPatterns(
                  activeScriptsForTab,
                  'setup',
                )}
                onDevServerPatternsChange={(next) =>
                  setActiveScriptsForTab((current) =>
                    setEditableScriptDevServerPatterns(current, 'setup', next),
                  )
                }
                devServerPatternsValidityScopeKey={`${scriptEditMode}:setup`}
                onDevServerPatternsValidityChange={makeDevServerValidityHandler(
                  `${scriptEditMode}:setup`,
                )}
              />
            </div>
            <div>
              <ScriptConfigEditor
                label="Teardown script"
                scriptName="teardown"
                command={getEditableScriptValue(
                  activeScriptsForTab,
                  'teardown',
                )}
                timeoutSeconds={getEditableScriptTimeoutSeconds(
                  activeScriptsForTab,
                  'teardown',
                )}
                shell={getEditableScriptShell(activeScriptsForTab, 'teardown')}
                onCommandChange={(nextValue) =>
                  setActiveScriptsForTab((current) =>
                    setEditableScriptValue(current, 'teardown', nextValue),
                  )
                }
                onTimeoutSecondsChange={(nextTimeout) =>
                  setActiveScriptsForTab((current) =>
                    setEditableScriptTimeoutSeconds(
                      current,
                      'teardown',
                      nextTimeout,
                    ),
                  )
                }
                onShellChange={(nextShell) =>
                  setActiveScriptsForTab((current) =>
                    setEditableScriptShell(current, 'teardown', nextShell),
                  )
                }
                placeholder={'# Runs before worktree archive\nnpm run clean'}
                rows={4}
                defaultTimeoutSeconds={defaultScriptTimeoutSeconds}
                devServerPatterns={getEditableScriptDevServerPatterns(
                  activeScriptsForTab,
                  'teardown',
                )}
                onDevServerPatternsChange={(next) =>
                  setActiveScriptsForTab((current) =>
                    setEditableScriptDevServerPatterns(
                      current,
                      'teardown',
                      next,
                    ),
                  )
                }
                devServerPatternsValidityScopeKey={`${scriptEditMode}:teardown`}
                onDevServerPatternsValidityChange={makeDevServerValidityHandler(
                  `${scriptEditMode}:teardown`,
                )}
              />
            </div>
            <div>
              <ScriptConfigEditor
                label="Launch script"
                scriptName="launch"
                command={getEditableScriptValue(activeScriptsForTab, 'launch')}
                timeoutSeconds={getEditableScriptTimeoutSeconds(
                  activeScriptsForTab,
                  'launch',
                )}
                shell={getEditableScriptShell(activeScriptsForTab, 'launch')}
                interactive={getEditableScriptInteractive(
                  activeScriptsForTab,
                  'launch',
                )}
                onInteractiveChange={(next) =>
                  setActiveScriptsForTab((current) =>
                    setEditableScriptInteractive(current, 'launch', next),
                  )
                }
                onCommandChange={(nextValue) =>
                  setActiveScriptsForTab((current) =>
                    setEditableScriptValue(current, 'launch', nextValue),
                  )
                }
                onTimeoutSecondsChange={(nextTimeout) =>
                  setActiveScriptsForTab((current) =>
                    setEditableScriptTimeoutSeconds(
                      current,
                      'launch',
                      nextTimeout,
                    ),
                  )
                }
                onShellChange={(nextShell) =>
                  setActiveScriptsForTab((current) =>
                    setEditableScriptShell(current, 'launch', nextShell),
                  )
                }
                placeholder={'# Triggered manually\nnpm run dev'}
                rows={4}
                defaultTimeoutSeconds={defaultScriptTimeoutSeconds}
                devServerPatterns={getEditableScriptDevServerPatterns(
                  activeScriptsForTab,
                  'launch',
                )}
                onDevServerPatternsChange={(next) =>
                  setActiveScriptsForTab((current) =>
                    setEditableScriptDevServerPatterns(current, 'launch', next),
                  )
                }
                devServerPatternsValidityScopeKey={`${scriptEditMode}:launch`}
                onDevServerPatternsValidityChange={makeDevServerValidityHandler(
                  `${scriptEditMode}:launch`,
                )}
              />
            </div>
            <div className="space-y-3 rounded-lg border p-3">
              <div>
                <p className="text-s font-medium fg-primary">Custom scripts</p>
                <p className="mt-1 text-xs fg-secondary">
                  Add ad hoc scripts that appear in the activity panel.
                </p>
              </div>

              {customScripts.map((script) => (
                <div key={script.name} className="rounded-lg border p-3">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="text-xs font-medium fg-primary">
                      {script.name}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setActiveScriptsForTab((current) =>
                          removeEditableScript(current, script.name),
                        )
                      }
                      className="focus-ring rounded-md px-2 py-1 text-2xs fg-destructive hover:bg-destructive-subtle"
                    >
                      Remove
                    </button>
                  </div>
                  <ScriptConfigEditor
                    label="Command"
                    scriptName={script.name}
                    command={script.command}
                    timeoutSeconds={script.timeoutSeconds}
                    shell={script.shell}
                    interactive={script.interactive === true}
                    onInteractiveChange={(next) =>
                      setActiveScriptsForTab((current) =>
                        setEditableScriptInteractive(
                          current,
                          script.name,
                          next,
                        ),
                      )
                    }
                    onCommandChange={(nextValue) =>
                      setActiveScriptsForTab((current) =>
                        setEditableScriptValue(current, script.name, nextValue),
                      )
                    }
                    onTimeoutSecondsChange={(nextTimeout) =>
                      setActiveScriptsForTab((current) =>
                        setEditableScriptTimeoutSeconds(
                          current,
                          script.name,
                          nextTimeout,
                        ),
                      )
                    }
                    onShellChange={(nextShell) =>
                      setActiveScriptsForTab((current) =>
                        setEditableScriptShell(current, script.name, nextShell),
                      )
                    }
                    rows={4}
                    defaultTimeoutSeconds={defaultScriptTimeoutSeconds}
                    devServerPatterns={script.devServerPatterns}
                    onDevServerPatternsChange={(next) =>
                      setActiveScriptsForTab((current) =>
                        setEditableScriptDevServerPatterns(
                          current,
                          script.name,
                          next,
                        ),
                      )
                    }
                    devServerPatternsValidityScopeKey={`${scriptEditMode}:custom:${script.name}`}
                    onDevServerPatternsValidityChange={makeDevServerValidityHandler(
                      `${scriptEditMode}:custom:${script.name}`,
                    )}
                  />
                </div>
              ))}

              <div className="rounded-lg border border-dashed p-3">
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
                  <label className="block text-s">
                    <span className="mb-1.5 block text-xs fg-secondary">
                      Script name
                    </span>
                    <input
                      value={newScriptName}
                      onChange={(event) => setNewScriptName(event.target.value)}
                      placeholder="dev-server"
                      className="focus-ring w-full rounded-lg border bg-base px-3 py-2 text-s"
                    />
                  </label>
                  <div className="flex items-end">
                    <button
                      type="button"
                      onClick={handleAddCustomScript}
                      disabled={
                        !normalizeScriptName(newScriptName) ||
                        !newScriptCommand.trim() ||
                        hasInvalidDevServerPatterns
                      }
                      className="focus-ring rounded-md bg-accent px-3 py-2 text-xs font-medium fg-emphasis disabled:opacity-60"
                    >
                      Add script
                    </button>
                  </div>
                </div>
                <div className="mt-3">
                  <ScriptConfigEditor
                    label="Command"
                    scriptName={
                      normalizeScriptName(newScriptName) ?? 'new-script'
                    }
                    command={newScriptCommand}
                    timeoutSeconds={newScriptTimeoutSeconds}
                    shell={newScriptShell}
                    interactive={newScriptInteractive}
                    onInteractiveChange={setNewScriptInteractive}
                    onCommandChange={setNewScriptCommand}
                    onTimeoutSecondsChange={setNewScriptTimeoutSeconds}
                    onShellChange={setNewScriptShell}
                    placeholder="npm run storybook"
                    rows={4}
                    defaultTimeoutSeconds={defaultScriptTimeoutSeconds}
                    devServerPatterns={newScriptDevServerPatterns}
                    onDevServerPatternsChange={setNewScriptDevServerPatterns}
                    devServerPatternsValidityScopeKey="project:new-script-draft"
                    onDevServerPatternsValidityChange={makeDevServerValidityHandler(
                      'project:new-script-draft',
                    )}
                  />
                </div>
              </div>
            </div>
            <ScriptActionsSettingsSection
              projectId={project.id}
              fallbackWorktreeId={sourceInspectWorktreeId}
            />
          </div>
        )}

        {activeTab === 'hooks' && (
          <div className="space-y-4">
            <SourceLocalToggle mode={hookEditMode} onChange={setHookEditMode} />

            <HookActionEditor
              key={hookEditMode}
              chatContext={resolveHookComposerContext({
                workspaceId: project.id,
                mode: hookEditMode,
                worktreeId: sourceInspectWorktreeId,
              })}
              onBlockedChange={setHookComposerBlocked}
              hooks={activeHooksForTab}
              onChange={(updater) => {
                setActiveHooksForTab((current) => updater(current));
              }}
              allowDisable={hookEditMode === 'local'}
              pluginSelectionMode={
                hookEditMode === 'source' ? 'portable' : 'full'
              }
              pipelineDiscoveryCwd={pipelineDiscoveryCwd}
            />
          </div>
        )}

        {activeTab === 'plan-detection' && (
          <div className="space-y-4">
            <WorkspacePlanDetectionSection workspaceId={project.id} />
          </div>
        )}

        {activeTab === 'plugins' && (
          <div className="flex flex-1 flex-col min-h-0">
            <SourceLocalToggle
              mode={pluginEditMode}
              onChange={setPluginEditMode}
              trailing={
                pluginEditMode === 'local' ? (
                  <PluginSelectionScopeHelp />
                ) : undefined
              }
            />
            {pluginEditMode === 'source' ? (
              !hasLoadedWorkspaceSettingsData && !workspaceSettingsLoadError ? (
                <div className="flex items-center justify-center py-8">
                  <LoadingSpinner tone="secondary" />
                </div>
              ) : workspaceSettingsLoadError ? (
                <div className="rounded-lg border bg-secondary/30 p-4 text-s">
                  <p className="font-medium fg-primary">
                    Source-controlled plugins are unavailable.
                  </p>
                  <p className="mt-1 fg-secondary">
                    {workspaceSettingsLoadError}
                  </p>
                  <div className="mt-3">
                    <button
                      type="button"
                      className="focus-ring rounded-md border bg-secondary px-3 py-1.5 text-s font-medium fg-primary"
                      onClick={() => setPluginEditMode('local')}
                    >
                      Use local override
                    </button>
                  </div>
                </div>
              ) : (
                <ShareablePluginSelector
                  selections={sourcePlugins}
                  onChange={setSourcePlugins}
                  helperText="These recommendations are saved to canopy.json and are offered when worktrees are created. They do not change local chat defaults until a user applies them."
                />
              )
            ) : (
              <div className="flex flex-1 flex-col min-h-0 gap-3">
                <RecommendedPluginsSettingsPanel
                  projectId={project.id}
                  worktreeId={sourceInspectWorktreeId}
                  onAppliedSelections={setPendingPlugins}
                  variant="compact"
                />
                <div className="flex flex-1 flex-col min-h-0">
                  <PluginSelector
                    selections={pendingPlugins}
                    onChange={setPendingPlugins}
                    inset={false}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'environment' && (
          <WorkspaceEnvironmentTab
            workspaceId={project.id}
            workspaceName={project.name}
            onManageEnvironments={() => {
              onClose();
              useNavigationStore.getState().openSettings('environment');
            }}
          />
        )}

        {activeTab === 'start-page' && startPageEnabled && (
          <CodeStartPageSettings
            project={project}
            initialWorktreeId={driftWorktreeId}
            initialMode={startPageIntent?.mode}
            prefill={startPageIntent?.prefill}
          />
        )}

        {activeTab === 'code-graph' && codeGraphExperimentEnabled && (
          <CodeGraphSummaryPanel
            advisorContext={{
              scope: 'workspace-shadow',
              workspaceId: project.id,
            }}
            load={(): ReturnType<
              typeof window.api.codeGraphGetWorkspaceSummary
            > =>
              window.api.codeGraphGetWorkspaceSummary({
                workspaceId: project.id,
              })
            }
            build={(): ReturnType<typeof window.api.codeGraphBuildWorkspace> =>
              window.api.codeGraphBuildWorkspace({ workspaceId: project.id })
            }
            onOpenSettings={(): void => {
              onClose();
              useNavigationStore.getState().openSettings('code-graph');
            }}
          />
        )}

        {activeTab === 'danger' && (
          <div className="space-y-4">
            <div className="rounded-lg border border-line-attention/30 p-3">
              <h3 className="text-s font-medium fg-primary">
                Convert to multi-repo project
              </h3>
              <p className="mt-1 text-xs fg-secondary">
                This updates project tracking, ensures <code>repos/</code> is
                ignored, creates a multi-repo <code>canopy.json</code>, and
                preserves existing agent instructions.
              </p>
              {project.owner?.type === 'organization' ? (
                // An organization project stays single-repo (CAN-3546).
                <p
                  className="mt-1 text-xs fg-secondary"
                  data-testid="project-settings-convert-org-note"
                >
                  Organization projects can&apos;t be converted. Create a
                  multi-repo project and add this repository instead.
                </p>
              ) : (
                <>
                  {project.worktrees.length > 0 && (
                    <p className="mt-1 text-xs fg-warning">
                      Remove all worktrees before converting this project.
                    </p>
                  )}
                  {!showConvertOptions ? (
                    <Button
                      onClick={() => setShowConvertOptions(true)}
                      disabled={project.worktrees.length > 0 || isConverting}
                      variant="warning"
                      size="sm"
                      className="mt-2"
                    >
                      Convert to multi-repo…
                    </Button>
                  ) : (
                    <div className="mt-3 space-y-2">
                      <p className="text-xs fg-secondary">
                        If project instructions already exist, choose how to
                        handle them.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            void handleConvertToMultiRepo('replace')
                          }
                          disabled={isConverting}
                          className="focus-ring rounded-md bg-accent px-3 py-1.5 text-xs font-medium fg-emphasis disabled:opacity-60"
                        >
                          Replace
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void handleConvertToMultiRepo('update')
                          }
                          disabled={isConverting}
                          className="focus-ring rounded-md border px-3 py-1.5 text-xs fg-primary hover:bg-secondary disabled:opacity-60"
                        >
                          Update
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void handleConvertToMultiRepo('unchanged')
                          }
                          disabled={isConverting}
                          className="focus-ring rounded-md border px-3 py-1.5 text-xs fg-primary hover:bg-secondary disabled:opacity-60"
                        >
                          Leave unchanged
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowConvertOptions(false)}
                          disabled={isConverting}
                          className="focus-ring rounded-md px-3 py-1.5 text-xs fg-secondary hover:fg-primary"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            <SettingsDangerConfirmBlock
              title="Delete project"
              description={
                <>
                  This will remove the project and all its worktrees from the
                  sidebar. If the repository is stored in{' '}
                  {`${brandText.appName}'s managed directory`}, it will also be
                  deleted from disk.
                </>
              }
              warning={
                hasActiveWorktrees ? (
                  <p className="mt-1 text-xs fg-destructive/80">
                    Cannot delete while worktrees have active sessions.
                  </p>
                ) : undefined
              }
              triggerDisabled={hasActiveWorktrees}
              triggerLabel="Delete project…"
              confirming={confirmingDelete}
              onConfirmStart={() => setConfirmingDelete(true)}
              onConfirmCancel={() => setConfirmingDelete(false)}
              onConfirm={() => void handleDelete()}
              isWorking={isDeleting}
              confirmLabel="Confirm delete"
              confirmInProgressLabel="Deleting…"
            />
          </div>
        )}
      </div>

      {/* Footer */}
      {showFooter && (
        <div className="flex items-center justify-between border-t px-5 py-3">
          {/* Branch picker dropdown — left side */}
          <SourceWorktreePicker
            selectedWorktreeId={sourceInspectWorktreeId}
            onChange={setSourceInspectWorktreeId}
            worktrees={project.worktrees}
            open={worktreeDropdownOpen}
            onOpenChange={setWorktreeDropdownOpen}
            helpTooltipId="project-settings-help-tooltip"
          />
          {/* Action buttons — right side */}
          <div className="flex items-center gap-2">
            <AddToWorktreeActionControls
              show={showAddToWorktreeAction}
              sourceInspectWorktreeId={sourceInspectWorktreeId}
              worktrees={project.worktrees}
              feedback={addToWorktreeFeedback}
              buttonLabel={addToWorktreeButtonLabel}
              disabled={
                hookComposerBlocked ||
                isSaving ||
                isApplyingToWorktree ||
                !canAddToWorktree ||
                hasInvalidDevServerPatterns
              }
              existingDropdownOpen={existingWorktreeDropdownOpen}
              onExistingDropdownOpenChange={setExistingWorktreeDropdownOpen}
              onAddToWorktree={(target) => void handleAddToWorktree(target)}
            />
            {showSaveLocal && (
              <SaveLocalButton
                disabled={
                  hookComposerBlocked ||
                  isSaving ||
                  isApplyingToWorktree ||
                  hasInvalidDevServerPatterns
                }
                isSaving={isSaving}
                onClick={() => void handleSaveLocal()}
              />
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="border-t px-5 py-3">
          <p className="text-s fg-destructive">{error}</p>
        </div>
      )}

      <SettingsTeardownFailureDialog
        error={teardownError}
        isRetrying={isTeardownRetrying}
        archiveWorktree={archiveWorktree}
        forceArchiveWorktree={forceArchiveWorktree}
        onRetryDelete={handleDelete}
        onRetryingChange={setIsTeardownRetrying}
        onErrorChange={setTeardownError}
      />
    </DialogModal>
  );
}
