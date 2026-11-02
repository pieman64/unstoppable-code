/**
 * @jest-environment jsdom
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

import * as modelPolicyRuntime from '@/stores/modelPolicyRuntime';
import { shareEnvelope } from '@/test-utils/shareOperation';
import type {
  RemoteControlContext,
  RemoteControlState,
} from '@canopy/desktop-shared/types/remote-control';
import { saveDailyCreditDripChoice } from '@/lib/daily-credit-drip';
import {
  applyLabsExperimentsSnapshot,
  resetLabsExperimentsStoreForTest,
} from '@/stores/labsExperimentsStore';
import {
  makeTestLabsSnapshot,
  pageExperimentsOn,
} from '@/test-utils/labsExperiments';
jest.mock('@/lib/daily-credit-drip', () => ({
  saveDailyCreditDripChoice: jest.fn(),
}));

const saveDailyCreditDripChoiceMock = jest.mocked(saveDailyCreditDripChoice);

import { useHomeComposerStore } from '@/stores/homeComposerStore';
import { useSidebarItemGroupsStore } from '@/stores/sidebarItemGroupsStore';
import {
  backgroundTaskStopKey,
  backgroundTaskStopStoreFor,
} from '@canopy/app-state';
import {
  initOllamaModels,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
// eslint-disable-next-line no-restricted-imports -- jsdom has no SubtleCrypto; pipeline bundle hashes need one.
import { webcrypto } from 'node:crypto';

// jsdom does not provide TextEncoder; the shared-automation document builder
// (protocol validator byte caps) requires one. ASCII-only test data makes the
// charCode approximation exact (same pattern as linearTicketStaging.test.ts).
class TestTextEncoder {
  encode(value: string): Uint8Array {
    return Uint8Array.from(
      Array.from(value, (char: string) => char.charCodeAt(0)),
    );
  }
}
Object.assign(globalThis, { TextEncoder: TestTextEncoder });
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: webcrypto,
});

import {
  CANOPY_PORTAL_DISABLED_TOAST,
  dispatchAppAction,
  __isValidAppAdvisorActionForTests,
  __resetAppActionDispatcherForTests,
  __setOrgProjectSetupOutcomeWaitForTests,
} from '@/lib/app-actions/dispatcher';
import { makeTestPreferences } from '@/test-utils/preferences';
import {
  COWORK_HOME_WORKTREE_ID,
  APP_ADVISOR_PROJECT_ID,
  DEFAULT_COWORK_WORKSPACE_ID,
  STANDALONE_CHAT_PROJECT_ID,
  initAgentModels,
  initClaudeModels,
  initCodexModels,
  initModelAliases,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  type BrowserCreateRequest,
  type BrowserNavigateRequest,
  type BrowserSessionSnapshot,
  type ChatProjectData,
  type ChatCommandRequest,
  type ChatCommandResult,
  type CreateSharedAutomationIpcRequest,
  type EnvironmentConfigData,
  type FileTreeMutationRequest,
  type FileTreeMutationResponse,
  type LoadEnvironmentConfigResponse,
  type AppAdvisorActionRequest,
  type AppAdvisorSettingsSaveRequest,
  type AppAdvisorWindowOpenRequest,
  type AppAdvisorWindowState,
  type AppAdvisorWindowUiState,
  type MultiRepoSidebarItem,
  type SaveDefaultPanelLayoutRequest,
  type SaveEnvironmentConfigResponse,
  type ScheduledActivity,
  type SidebarItem,
  type SingleRepoSidebarItem,
  type StandaloneWorkspaceSnapshotResponse,
  type TerminalWriteRequest,
  type TrackedPlanData,
  type WorkspaceContextState,
} from '@canopy/desktop-shared/types';
import { PIPELINE_EDITOR_REQUIRED_SKILL_REF } from '@canopy/desktop-shared/lib/pipeline-editor-tools';
import type {
  SharedCollectionDetail,
  UpdateSharedCollectionRequest,
} from '@canopy/desktop-shared/types/collections';
import type { ShareOperationResult } from '@canopy/protocol/sharing';
import type {
  MergePrQueueChatResult,
  MergePrRepoResult,
  WorktreePrStatus,
} from '@canopy/desktop-shared/types/github';
import type { SaveAgentModelRequest } from '@canopy/desktop-shared/types/agent-models';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import {
  MEMBER_ORG_PROJECT_LIMIT,
  ORG_PROJECT_LIMITS,
} from '@canopy/protocol/org-projects';
import { APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES } from '@canopy/desktop-shared/lib/app-advisor-actions';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useLinkedPersonalWorkspacesStore } from '@/stores/linkedPersonalWorkspacesStore';
import { createOrgProjectsStore } from '@canopy/app-state';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { setOrgProjectAddStoreForTests } from '@/lib/orgProjectCatalogAdd';
import type { OrgProjectSetupProgress } from '@canopy/protocol/org-projects';
import { useMoveToOrganizationModalStore } from '@/stores/moveToOrganizationModalStore';
import { useShareRequestStore } from '@/stores/shareRequestStore';
import { useLaunchAtLoginStore } from '@/stores/launchAtLoginStore';
import {
  __resetClaudeTerminalStoreForTests,
  useClaudeTerminalStore,
} from '@/stores/claudeTerminalStore';
import { useCodeReviewStore } from '@/stores/codeReviewStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useSpaceNotificationStore } from '@/stores/spaceNotificationStore';
import { useFileTabUiStore } from '@/stores/fileTabUiStore';
import { useRunCommentsStore } from '@/stores/runCommentsStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useSkillSuggestionStore } from '@/stores/skillSuggestionStore';
import { useActivityStore } from '@/stores/activityStore';
import {
  liveBackgroundTaskKey,
  useLiveBackgroundTaskStore,
} from '@/stores/liveBackgroundTaskStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  useProjectsStore,
  type CreateWorktreeOptions,
} from '@/stores/projectsStore';
import { useImportSessionModalStore } from '@/stores/importSessionModalStore';
import { useRepoRulesModalStore } from '@/stores/repoRulesModalStore';
import { useUsageLimitResumePromptStore } from '@/stores/usageLimitResumePromptStore';
import { useResumeQueueStore } from '@/stores/resumeQueueStore';
import { useCloneJobsStore } from '@/stores/cloneJobsStore';
import { makeCloneJob } from '@/test-utils/cloneJobs';
import { useSidebarStore } from '@/stores/sidebarStore';
import {
  __resetSplitPrPreferencesForTests,
  useSplitPrPreferencesStore,
} from '@/hooks/useSplitPrPreferences';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { useBrowserStore } from '@/stores/browserStore';
import { noteBrowserUserInteraction } from '@/lib/browserUserInteraction';
import { useBranchFromStore } from '@/stores/branchFromStore';
import { useBaseBranchAlignmentStore } from '@/stores/baseBranchAlignmentStore';
import { useSharedContainerReplicasStore } from '@/stores/sharedContainerReplicasStore';
import {
  makeWorktreePanelKey,
  setPanelLayoutFixedTopology,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '@/stores/panelLayoutStore';
import { useWorkspaceLayoutModeStore } from '@/stores/workspaceLayoutModeStore';
import {
  isSendEditorSelectionToChatDetail,
  SEND_EDITOR_SELECTION_TO_CHAT_EVENT,
} from '@/lib/editorSelectionContext';
import { OPEN_WORKTREE_ARCHIVE_CONFIRMATION_EVENT } from '@/lib/worktreeArchiveConfirmationEvents';
import { OPEN_SHARED_CONTAINER_REVOCATION_CONFIRMATION_EVENT } from '@/lib/sharedContainerRevocationConfirmationEvents';
import {
  OPEN_SHARED_CONTAINER_INVITE_EVENT,
  consumeRequestedSharedContainerInviteAudience,
} from '@/lib/sharedContainerInviteEvents';
import {
  FILE_TREE_SET_SEARCH_EVENT,
  isFileTreeSetSearchDetail,
} from '@/lib/fileTreeSearchEvents';
import { isAccountMcpActionEventDetail } from '@/lib/accountMcpEvents';
import { isFilePreviewSearchEventDetail } from '@/lib/filePreviewSearchEvents';
import { launchWorkspaceReadinessFix } from '@/lib/workspaceReadinessLauncher';
import { openTrackedPlan } from '@/lib/plans/open-tracked-plan';
import { openDesktopChatVisualsPanel } from '@/lib/panels/chat-visuals-panel-open';
import type * as PlanPanelOpenModule from '@/lib/panels/plan-panel-open';
import {
  openPlanDiagramPanel,
  openPlanPanel,
} from '@/lib/panels/plan-panel-open';
import { openSubagentsPanel } from '@/lib/panels/subagent-panel-open';
import { AGENT_PUBLIC_SHARE_CHANGED_EVENT } from '@/lib/share-links';
import { APP_ADVISOR_SETTINGS_SAVED_EVENT } from '@/lib/appAdvisorSettingsEvents';
import {
  navigateAfterRepositoryWorkspaceCreated,
  openCreatedMultiRepoWorkspaceSettings,
} from '@/lib/postWorkspaceCreateNavigation';
import { orgCreateFolderRefusalText } from '@/lib/orgCreateProject';

const mockLoadChatShareLocalData = jest.fn();
jest.mock('@/hooks/useChatShareData', () => ({
  loadChatShareLocalData: (): unknown => mockLoadChatShareLocalData(),
}));

jest.mock('@/lib/workspaceReadinessLauncher', () => ({
  launchWorkspaceReadinessFix: jest.fn(),
}));

// `org_project.create_code` and `workspace.create_multi_repo` open created
// projects this way; what opening does is covered by the Add project dialog's
// own tests.
jest.mock('@/lib/postWorkspaceCreateNavigation', () => ({
  navigateAfterRepositoryWorkspaceCreated: jest.fn(),
  openCreatedMultiRepoWorkspaceSettings: jest.fn(),
}));

const navigateAfterRepositoryWorkspaceCreatedMock = jest.mocked(
  navigateAfterRepositoryWorkspaceCreated,
);
const openCreatedMultiRepoWorkspaceSettingsMock = jest.mocked(
  openCreatedMultiRepoWorkspaceSettings,
);

const launchWorkspaceReadinessFixMock = jest.mocked(
  launchWorkspaceReadinessFix,
);

// Tracked plans open through the shared opener (Plan panel); `panel.add_tab`
// plan kinds go through the plan panel opener. Both are exercised against
// real stores in their own suites.
jest.mock('@/lib/plans/open-tracked-plan', () => ({
  openTrackedPlan: jest.fn(),
}));
jest.mock('@/lib/panels/plan-panel-open', () => ({
  ...jest.requireActual<typeof PlanPanelOpenModule>(
    '@/lib/panels/plan-panel-open',
  ),
  openPlanPanel: jest.fn(),
  openPlanDiagramPanel: jest.fn(),
}));
// The Chat visuals panel opens through its own opener, beside its chat.
jest.mock('@/lib/panels/chat-visuals-panel-open', () => ({
  openDesktopChatVisualsPanel: jest.fn(),
}));
const openDesktopChatVisualsPanelMock = jest.mocked(
  openDesktopChatVisualsPanel,
);
jest.mock('@/lib/panels/subagent-panel-open', () => ({
  openSubagentsPanel: jest.fn(),
}));
const openTrackedPlanMock = jest.mocked(openTrackedPlan);
const openPlanPanelMock = jest.mocked(openPlanPanel);
const openPlanDiagramPanelMock = jest.mocked(openPlanDiagramPanel);
const openSubagentsPanelMock = jest.mocked(openSubagentsPanel);

// The dispatcher reads dirty file-tab state and saves via the shared desktop
// file-session controller (CAN-1426). Mock it with a controllable dirty set +
// saveTab spy so list_tabs/file.save_active can be driven without a live store.
// `var` (not `let`) so the jest.mock factory — hoisted above imports — can
// assign these without hitting a temporal dead zone.
/* eslint-disable no-var */
var mockFileSessionDirty: Set<string>;
var mockControllerSaveTab: jest.Mock<Promise<boolean>, [string]>;
var mockRequestBrowserPanel: jest.Mock<Promise<boolean>, unknown[]>;
/* eslint-enable no-var */
jest.mock('@/lib/file-viewer/desktop-file-session-controller', () => {
  mockFileSessionDirty = new Set<string>();
  mockControllerSaveTab = jest.fn<Promise<boolean>, [string]>();
  return {
    desktopFileSessionController: {
      isDirty: (tabId: string): boolean => mockFileSessionDirty.has(tabId),
      saveTab: (tabId: string): Promise<boolean> =>
        mockControllerSaveTab(tabId),
    },
  };
});

jest.mock('@/lib/browserPanelActivation', () => {
  mockRequestBrowserPanel = jest
    .fn<Promise<boolean>, unknown[]>()
    .mockResolvedValue(true);
  return { requestBrowserPanel: mockRequestBrowserPanel };
});

const getWorktreePathMock = jest.fn();
const loadCanopyCloudAccountMock = jest.fn();
const loadEnvironmentConfigMock = jest.fn<
  Promise<LoadEnvironmentConfigResponse>,
  []
>();
const saveEnvironmentConfigMock = jest.fn<
  Promise<SaveEnvironmentConfigResponse>,
  [EnvironmentConfigData]
>();
const chatApiMock = {
  command: jest.fn<Promise<ChatCommandResult>, [ChatCommandRequest]>(),
  getTranscriptPage: jest.fn(),
  loadTabs: jest.fn(),
  loadArchives: jest.fn(),
  readArchive: jest.fn(),
  activeSessions: jest.fn(),
  sendMessage: jest.fn(),
  changeModel: jest.fn(),
  togglePlanMode: jest.fn(),
  toggleThinkingLevel: jest.fn(),
  toggleCodexFastMode: jest.fn(),
  updatePlugins: jest.fn(),
  flushScope: jest.fn(),
  forkOpenWorktreeTabs: jest.fn(),
  adhocMigrateTabs: jest.fn(),
  generateHandoffSummary: jest.fn(),
  forkCodexThread: jest.fn(),
  exportSession: jest.fn(),
};
const chatProjectApiMock = {
  list: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  loadClaudeMd: jest.fn(),
  saveClaudeMd: jest.fn(),
};
const standaloneChatApiMock = {
  init: jest.fn(),
  list: jest.fn(),
  readSummary: jest.fn(),
  readArchive: jest.fn(),
  resumeArchive: jest.fn(),
  loadWorkspace: jest.fn(),
  exportProject: jest.fn(),
  importProject: jest.fn(),
  onMetaUpdated: jest.fn(),
};
// Typed `unknown` so the matcher is not an `any` inside a payload literal.
const ANY_VIEWER_SESSION_ID: unknown = expect.any(String);
const sharedContainersApiMock = {
  checkEligibility: jest.fn(),
  preview: jest.fn(),
  saveFileScope: jest.fn(),
  invite: jest.fn(),
  searchMembers: jest.fn(),
  listRecipients: jest.fn(),
  revokeRecipient: jest.fn(),
  listSharedByMe: jest.fn(),
  listSharedWithMe: jest.fn(),
  listAccepted: jest.fn().mockResolvedValue({ containerIds: [] }),
  accept: jest.fn().mockResolvedValue({ accepted: true }),
  open: jest.fn(),
  getReplicaState: jest.fn(),
  dismiss: jest.fn(),
  retry: jest.fn(),
  close: jest.fn().mockResolvedValue(undefined),
  listChats: jest.fn(),
  readChat: jest.fn(),
  listPlans: jest.fn(),
  readPlan: jest.fn(),
  listNotes: jest.fn(),
  readNote: jest.fn(),
  listPrompts: jest.fn(),
  readPrompt: jest.fn(),
  listAttachments: jest.fn(),
  readAttachment: jest.fn(),
  listRepositories: jest.fn(),
  listRepositoryTree: jest.fn(),
  readOverlayDiff: jest.fn(),
  onReplicaChanged: jest.fn((): (() => void) => (): void => {}),
  onPublicationChanged: jest.fn((): (() => void) => (): void => {}),
};

const workEntriesApiMock = {
  list: jest.fn<
    Promise<{
      entries: ReturnType<
        typeof useStandaloneChatStore.getState
      >['workEntries'];
    }>,
    [{ projectId: string }]
  >(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  resolveChat: jest.fn(),
};
const sidebarItemGroupsApiMock = {
  list: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  moveItem: jest.fn(),
  moveGroup: jest.fn(),
  ungroup: jest.fn(),
};
const workspaceItemsApiMock = {
  listNotes: jest.fn(),
  readNote: jest.fn(),
  saveNote: jest.fn(),
  deleteNote: jest.fn(),
  listPrompts: jest.fn(),
  readPrompt: jest.fn(),
  readPromptByPath: jest.fn(),
  savePrompt: jest.fn(),
  deletePrompt: jest.fn(),
  listAttachments: jest.fn(),
  importAttachments: jest.fn(),
  deleteAttachment: jest.fn(),
};
const workspaceApiMock = {
  getWorkspaceSettingsData: jest.fn(),
  getWorkspaceReadiness: jest.fn(),
  loadClaudeMd: jest.fn(),
  saveProjectDefaultPlugins: jest.fn(),
  saveWorkspaceDefaultPlugins: jest.fn(),
  saveProjectScripts: jest.fn(),
  saveWorkspaceScripts: jest.fn(),
  saveProjectHooks: jest.fn(),
  saveWorkspaceHooks: jest.fn(),
  saveWorkspaceRepoScripts: jest.fn(),
  saveWorkspaceRepoHooks: jest.fn(),
  applyWorkspaceSourceChanges: jest.fn(),
  applyProjectSourceChanges: jest.fn(),
  listAdhocMultiRepoJoinOptions: jest.fn(),
  listExistingWorktreeJoinOptions: jest.fn(),
  combineWorktreeWithWorkspace: jest.fn(),
  combineWorktreeWithExistingWorktree: jest.fn(),
  promoteTemporaryWorkspace: jest.fn(),
  previewSplitTemporaryWorkspace: jest.fn(),
  setWorkspaceArchiveRetention: jest.fn(),
  setWorktreeHidden: jest.fn(),
  setWorktreePausedHooks: jest.fn(),
  setWorktreeBranchGrouping: jest.fn(),
  discoverWorktreeEnv: jest.fn(),
};
const appAdvisorOpenWindowMock = jest
  .fn<Promise<AppAdvisorWindowState>, [AppAdvisorWindowOpenRequest?]>()
  .mockResolvedValue({ open: true, focused: true });
let appAdvisorWindowUiStateListener:
  | ((state: AppAdvisorWindowUiState) => void)
  | null = null;
const pipelinesApiMock = {
  list: jest.fn(),
  discoverProject: jest.fn(),
  get: jest.fn(),
  save: jest.fn(),
  delete: jest.fn(),
  duplicate: jest.fn(),
  listShared: jest.fn(),
  getShared: jest.fn(),
  createShared: jest.fn(),
  getSharedUpdateImpact: jest.fn(),
  updateShared: jest.fn(),
  deleteShared: jest.fn(),
  execute: jest.fn(),
  listExecutions: jest.fn(),
  getExecution: jest.fn(),
  readReportFile: jest.fn(),
  cancelExecution: jest.fn(),
  retryMatrixJob: jest.fn(),
  cancelMatrixVariant: jest.fn(),
  resume: jest.fn(),
  resumeAutomation: jest.fn(),
  retryExecution: jest.fn(),
  rerunExecution: jest.fn(),
};
const skillsApiMock = {
  listMarketplace: jest.fn(),
  loadSkills: jest.fn(),
  installSkills: jest.fn(),
  readContent: jest.fn(),
  listFiles: jest.fn(),
  readFile: jest.fn(),
  readRawSkill: jest.fn(),
  saveCustomSkill: jest.fn(),
  removeSkill: jest.fn(),
  listShared: jest.fn(),
  getShared: jest.fn(),
  createShared: jest.fn(),
  updateShared: jest.fn(),
  deleteShared: jest.fn(),
};
const agentsApiMock = {
  list: jest.fn(),
  get: jest.fn(),
  save: jest.fn<Promise<unknown>, [SaveAgentModelRequest]>(),
  delete: jest.fn(),
  importShared: jest.fn(),
  listShared: jest.fn(),
  getShared: jest.fn(),
  createShared: jest.fn(),
  updateShared: jest.fn(),
  deleteShared: jest.fn(),
  publishPublicShare: jest.fn(),
  revokePublicShare: jest.fn(),
  onChanged: jest.fn(),
};
const pluginsApiMock = {
  loadMarketplaces: jest.fn(),
  refreshMarketplaces: jest.fn(),
  updateMarketplace: jest.fn(),
  removeMarketplace: jest.fn(),
};
// Automations transport surface — the dispatcher's `automation.*` cases bridge
// straight to these mocks. Default resolutions are installed in `beforeEach`;
// individual tests can `mockResolvedValueOnce(...)` per case.
const orgProjectsApiMock = {
  setPreference: jest.fn(),
  list: jest.fn(),
  refresh: jest.fn(),
  setupStart: jest.fn(),
  setupCancel: jest.fn(),
  linksList: jest.fn(),
};
// Session-prompt sharing resolves the bound project's kind (CAN-3734).
const loadProjectsApiMock = jest.fn();
const automationsApiMock = {
  list: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  runNow: jest.fn(),
  listShared: jest.fn<Promise<unknown>, [unknown]>(),
  getShared: jest.fn<Promise<unknown>, [string]>(),
  createShared: jest.fn<Promise<unknown>, [CreateSharedAutomationIpcRequest]>(),
  updateShared: jest.fn<Promise<unknown>, [unknown]>(),
  deleteShared: jest.fn<Promise<unknown>, [unknown]>(),
  resolveSharedPipelineInstallPin: jest.fn<Promise<unknown>, [unknown]>(),
  onChanged: jest.fn((): (() => void) => (): undefined => undefined),
};
const browserApiMock = {
  create: jest.fn(),
  destroy: jest.fn(),
  loadWorktreeState: jest.fn(),
  saveWorktreeState: jest.fn(),
  setBounds: jest.fn(),
  setVisible: jest.fn(),
  navigate: jest.fn(),
  back: jest.fn(),
  forward: jest.fn(),
  reload: jest.fn(),
  stop: jest.fn(),
  setTheme: jest.fn(),
  setPickMode: jest.fn(),
  startRecording: jest.fn(),
  stopRecording: jest.fn(),
  clearRecording: jest.fn(),
  getRecording: jest.fn(),
  openExternal: jest.fn(),
  getConsole: jest.fn(),
  getNetwork: jest.fn(),
  listTransfers: jest.fn(),
  transferCommand: jest.fn(),
  saveDownload: jest.fn(),
  screenshot: jest.fn(),
  inputSnapshot: jest.fn(),
  inspect: jest.fn(),
  getDialog: jest.fn(),
  getFileChooser: jest.fn(),
  getPrintRequest: jest.fn(),
  answerPrintRequest: jest.fn(),
  getAuthRequest: jest.fn(),
  answerAuthRequest: jest.fn(),
  answerFileChooser: jest.fn(),
  savePdf: jest.fn(),
  handleDialog: jest.fn(),
  automation: jest.fn(),
  onEvent: jest.fn((): (() => void) => (): undefined => undefined),
};
const panelLayoutApiMock = {
  saveDefaultLayout: jest.fn<Promise<void>, [SaveDefaultPanelLayoutRequest]>(),
  saveWorktreeMode: jest.fn<Promise<void>, [unknown]>(),
};
const loadPreferencesMock = jest.fn();
const browseForCloneDirectoryMock = jest.fn();
const savePreferencesMock = jest.fn().mockResolvedValue(undefined);
const setPipelineDisabledPreferenceMock = jest.fn();
const installOllamaActionMock = jest.fn();
const openMemoryDirMock = jest.fn<Promise<void>, []>();
const importClaudeMemoryMock = jest.fn();
const consolidateLocalMemoryMock = jest.fn();
const rebuildLocalMemoryMock = jest.fn();
const listLocalMemorySnapshotsMock = jest.fn();
const restoreLocalMemorySnapshotMock = jest.fn();
const mutateFileTreeMock = jest.fn<
  Promise<FileTreeMutationResponse>,
  [FileTreeMutationRequest]
>();

function browserSnapshot(
  overrides: Partial<BrowserSessionSnapshot> = {},
): BrowserSessionSnapshot {
  return {
    id: 'browser-1',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    createdAt: 1,
    updatedAt: 2,
    url: 'http://localhost:3000',
    title: 'Local',
    status: 'ready',
    canGoBack: false,
    canGoForward: false,
    loading: false,
    themeMode: 'light',
    pickMode: false,
    recording: false,
    ...overrides,
  };
}

/** Seeds one renderer-side browser session (flat store) and returns its id. */
let seededBrowserCounter = 0;
function seedRendererBrowser(
  projectId: string,
  worktreeId: string,
  overrides: Partial<BrowserSessionSnapshot> = {},
): string {
  seededBrowserCounter += 1;
  const id = overrides.id ?? `browser-seeded-${seededBrowserCounter}`;
  useBrowserStore
    .getState()
    .registerBrowserSnapshot(
      browserSnapshot({ ...overrides, id, projectId, worktreeId }),
    );
  return id;
}
const appAdvisorListWatchersMock = jest.fn();
const appAdvisorDeleteWatcherMock = jest.fn();
const appAdvisorSettingsSaveMock = jest.fn(
  (settings: AppAdvisorSettingsSaveRequest) =>
    Promise.resolve({ version: 1 as const, ...settings }),
);
const githubStartMergeConflictResolutionMock = jest.fn();
const githubStartPrCommentTriageMock = jest.fn();
const githubStartCiCheckFixMock = jest.fn();
// Tracked-plan share surface exposed under `window.api.activity.plans.share`.
// The dispatcher's `plan.share` case forwards directly to this mock.
const activityPlansShareMock = jest.fn();
const activityPlansImportMock = jest.fn();
const activityPlansGetMock = jest.fn();
const activityPlansListMock = jest.fn();
const activityStopBgProcessMock = jest.fn();
// User delegation stops exposed under `window.api.managedDelegation`.
const managedDelegationStopMock = jest.fn();
const managedDelegationStopAllMock = jest.fn();
const managedDelegationChangesMock = jest.fn();
// Run share/unshare surface exposed under `window.api.runs`. The dispatcher's
// `runs.share` / `runs.unshare` cases forward to these mocks.
const runsShareMock = jest.fn();
const runsUnshareMock = jest.fn();
const claudeTerminalLaunchMock = jest.fn();
const claudeTerminalCleanupMock = jest.fn();
const claudeTerminalGetStateMock = jest.fn();
const claudeTerminalSyncTranscriptMock = jest.fn(() =>
  Promise.resolve({ chatId: 'chat', importedEventCount: 0 }),
);
const terminalWriteMock = jest.fn<Promise<void>, [TerminalWriteRequest]>();
const terminalOnExitMock = jest.fn(
  (): (() => void) => (): undefined => undefined,
);
const claudeTerminalSubscribeMock = jest.fn(
  (): (() => void) => (): undefined => undefined,
);

if (typeof globalThis.structuredClone !== 'function') {
  Object.defineProperty(globalThis, 'structuredClone', {
    configurable: true,
    value: <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T,
  });
}

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  window,
  'platform',
);

function setRendererPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(window, 'platform', {
    configurable: true,
    value: platform,
  });
}

function restoreRendererPlatform(): void {
  if (originalPlatformDescriptor) {
    Object.defineProperty(window, 'platform', originalPlatformDescriptor);
  } else {
    Reflect.deleteProperty(window, 'platform');
  }
}

function setFeatureFlagForTest(
  key: (typeof CLIENT_FEATURE_FLAGS)[keyof typeof CLIENT_FEATURE_FLAGS]['key'],
  value: boolean,
): void {
  const snapshot = useFeatureFlagsStore.getState().snapshot;
  useFeatureFlagsStore.setState({
    snapshot: {
      ...snapshot,
      values: {
        ...snapshot.values,
        [key]: value,
      },
      status: 'ready',
      initialized: true,
    },
  });
}

beforeEach(() => {
  initAgentModels([]);
  resetLabsExperimentsStoreForTest();
  // The Labs page experiments are on, so their pages are reachable (CAN-3678).
  applyLabsExperimentsSnapshot(
    makeTestLabsSnapshot({ revision: 0, experiments: pageExperimentsOn() }),
  );
  initClaudeModels([{ id: 'sonnet', label: 'Sonnet' }]);
  initCodexModels([{ id: 'gpt-5.6-luna', label: 'GPT 5.6 Luna' }]);
  initModelAliases({ 'claude-sonnet-4-6': 'sonnet' });
  __resetAppActionDispatcherForTests();
  const stopStore = backgroundTaskStopStoreFor(ipcCanopyClient);
  Object.keys(stopStore.getState().pending).forEach((key) =>
    stopStore.getState().clearPending(key),
  );
  __resetClaudeTerminalStoreForTests();
  getWorktreePathMock.mockReset();
  loadCanopyCloudAccountMock.mockReset();
  loadPreferencesMock.mockReset();
  setPipelineDisabledPreferenceMock.mockReset();
  appAdvisorOpenWindowMock.mockReset();
  appAdvisorWindowUiStateListener = null;
  appAdvisorOpenWindowMock.mockImplementation((request) => {
    const requestId = request?.archivedOverview?.requestId;
    if (requestId !== undefined) {
      queueMicrotask(() => {
        appAdvisorWindowUiStateListener?.({
          activeWorkEntryId: 'entry-1',
          activeChatId: 'chat-1',
          navCollapsed: false,
          settingsModalOpen: false,
          archivedOverviewOpen: true,
          archivedOverviewWorkspaceId: APP_ADVISOR_PROJECT_ID,
          emptyTrashConfirmationOpen: true,
          emptyTrashRunning: false,
          lastArchivedOverviewRequestId: requestId,
          lastArchivedOverviewConfirmationOpened: true,
        });
      });
    }
    return Promise.resolve({ open: true, focused: true });
  });
  installOllamaActionMock.mockReset();
  openMemoryDirMock.mockReset();
  openMemoryDirMock.mockResolvedValue(undefined);
  importClaudeMemoryMock.mockReset();
  importClaudeMemoryMock.mockResolvedValue({
    disabled: false,
    staged: 1,
    skipped: 0,
    deferred: 0,
    errors: [],
  });
  mutateFileTreeMock.mockReset();
  mutateFileTreeMock.mockImplementation((request) =>
    Promise.resolve({
      operation: request.operation,
      ...('source' in request ? { source: request.source } : {}),
      target: request.target,
    }),
  );
  pipelinesApiMock.list.mockReset();
  pipelinesApiMock.discoverProject.mockReset();
  pipelinesApiMock.get.mockReset();
  pipelinesApiMock.save.mockReset();
  pipelinesApiMock.delete.mockReset();
  pipelinesApiMock.duplicate.mockReset();
  pipelinesApiMock.listShared.mockReset();
  pipelinesApiMock.getShared.mockReset();
  pipelinesApiMock.createShared.mockReset();
  pipelinesApiMock.getSharedUpdateImpact.mockReset();
  pipelinesApiMock.updateShared.mockReset();
  pipelinesApiMock.deleteShared.mockReset();
  pipelinesApiMock.getSharedUpdateImpact.mockResolvedValue({
    success: true,
    data: { automations: [] },
  });
  pipelinesApiMock.execute.mockReset();
  pipelinesApiMock.listExecutions.mockReset();
  pipelinesApiMock.getExecution.mockReset();
  pipelinesApiMock.readReportFile.mockReset();
  pipelinesApiMock.cancelExecution.mockReset();
  pipelinesApiMock.resume.mockReset();
  pipelinesApiMock.resumeAutomation.mockReset();
  pipelinesApiMock.retryExecution.mockReset();
  pipelinesApiMock.rerunExecution.mockReset();
  Object.values(chatApiMock).forEach((mock) => mock.mockReset());
  Object.values(chatProjectApiMock).forEach((mock) => mock.mockReset());
  Object.values(standaloneChatApiMock).forEach((mock) => mock.mockReset());
  Object.values(workspaceApiMock).forEach((mock) => mock.mockReset());
  Object.values(skillsApiMock).forEach((mock) => mock.mockReset());
  Object.values(agentsApiMock).forEach((mock) => mock.mockReset());
  Object.values(pluginsApiMock).forEach((mock) => mock.mockReset());
  automationsApiMock.list.mockReset();
  automationsApiMock.create.mockReset();
  automationsApiMock.update.mockReset();
  automationsApiMock.delete.mockReset();
  automationsApiMock.runNow.mockReset();
  automationsApiMock.resolveSharedPipelineInstallPin.mockReset();
  automationsApiMock.onChanged.mockClear();
  automationsApiMock.list.mockResolvedValue({ activities: [], recentRuns: [] });
  appAdvisorListWatchersMock.mockReset();
  appAdvisorDeleteWatcherMock.mockReset();
  appAdvisorSettingsSaveMock.mockReset();
  appAdvisorSettingsSaveMock.mockImplementation(
    (settings: AppAdvisorSettingsSaveRequest) =>
      Promise.resolve({ version: 1 as const, ...settings }),
  );
  githubStartMergeConflictResolutionMock.mockReset();
  githubStartMergeConflictResolutionMock.mockResolvedValue({
    chatId: 'conflict-chat-1',
  });
  githubStartPrCommentTriageMock.mockReset();
  githubStartPrCommentTriageMock.mockResolvedValue({
    chatId: 'triage-chat-1',
  });
  githubStartCiCheckFixMock.mockReset();
  githubStartCiCheckFixMock.mockResolvedValue({
    chatId: 'ci-fix-chat-1',
  });
  activityPlansShareMock.mockReset();
  activityPlansShareMock.mockResolvedValue(null);
  activityStopBgProcessMock.mockReset();
  activityStopBgProcessMock.mockResolvedValue('stopped');
  useLiveBackgroundTaskStore.setState({ byChat: {} });
  managedDelegationStopMock.mockReset();
  managedDelegationStopMock.mockResolvedValue({ ok: true });
  managedDelegationStopAllMock.mockReset();
  managedDelegationStopAllMock.mockResolvedValue({ ok: true, stopped: 0 });
  managedDelegationChangesMock.mockReset();
  runsShareMock.mockReset();
  runsShareMock.mockResolvedValue({ externalId: 'run-ext-1' });
  runsUnshareMock.mockReset();
  runsUnshareMock.mockResolvedValue({ unshared: true });
  activityPlansImportMock.mockReset();
  activityPlansImportMock.mockResolvedValue({
    plan: null,
    trackedPlanFilePath: '/canopy/worktrees/worktree-1/tracked-plans.json',
  });
  appAdvisorListWatchersMock.mockResolvedValue([]);
  appAdvisorDeleteWatcherMock.mockResolvedValue({ ok: true });
  automationsApiMock.create.mockResolvedValue({ ok: true });
  automationsApiMock.update.mockResolvedValue({ ok: true });
  automationsApiMock.delete.mockResolvedValue({ ok: true });
  automationsApiMock.runNow.mockResolvedValue({ ok: true });
  Object.values(browserApiMock).forEach((mock) => mock.mockReset());
  panelLayoutApiMock.saveDefaultLayout.mockReset();
  panelLayoutApiMock.saveDefaultLayout.mockResolvedValue(undefined);
  panelLayoutApiMock.saveWorktreeMode.mockReset();
  panelLayoutApiMock.saveWorktreeMode.mockResolvedValue(undefined);
  browserApiMock.loadWorktreeState.mockResolvedValue({
    status: 'missing',
    state: null,
  });
  browserApiMock.saveWorktreeState.mockResolvedValue(undefined);
  browserApiMock.create.mockImplementation((request: BrowserCreateRequest) =>
    Promise.resolve({
      ...browserSnapshot({
        id: request.browserId ?? 'browser-created',
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        url: request.url ?? '',
        title: '',
        status: request.url ? 'ready' : 'idle',
        themeMode: request.themeMode ?? 'light',
      }),
    }),
  );
  browserApiMock.navigate.mockImplementation(
    (request: BrowserNavigateRequest) =>
      Promise.resolve({
        ...browserSnapshot({
          id: request.browserId,
          updatedAt: 3,
          url: request.url,
        }),
      }),
  );
  browserApiMock.reload.mockImplementation((request: { browserId: string }) =>
    Promise.resolve(browserSnapshot({ id: request.browserId, updatedAt: 3 })),
  );
  browserApiMock.automation.mockImplementation(
    (request: { browserId?: string }) =>
      Promise.resolve({
        ok: true,
        browser: browserSnapshot({
          id: request.browserId ?? 'browser-1',
          updatedAt: 3,
        }),
      }),
  );
  browserApiMock.getConsole.mockResolvedValue([]);
  browserApiMock.getNetwork.mockResolvedValue([]);
  browserApiMock.screenshot.mockResolvedValue({
    attachmentPath: '/tmp/shot.png',
  });
  browserApiMock.inputSnapshot.mockResolvedValue({
    browserId: 'browser-1',
    url: 'http://localhost:3000',
    title: 'Local',
    capturedAt: '2026-07-16T00:00:00.000Z',
    filter: {},
    offset: 0,
    limit: 25,
    total: 0,
    returned: 0,
    truncated: false,
    inputs: [],
  });
  browserApiMock.inspect.mockResolvedValue({});
  browserApiMock.getDialog.mockResolvedValue(null);
  browserApiMock.handleDialog.mockResolvedValue({
    dialog: {
      id: 'dialog-1',
      browserId: 'browser-1',
      type: 'confirm',
      message: 'Continue?',
      url: 'http://localhost:3000',
      openedAt: 1,
    },
    accept: true,
  });
  browserApiMock.startRecording.mockResolvedValue(
    browserSnapshot({ updatedAt: 3, recording: true }),
  );
  browserApiMock.stopRecording.mockResolvedValue({
    browserId: 'browser-1',
    recording: false,
    steps: [],
    playwrightScript: '',
  });
  browserApiMock.openExternal.mockResolvedValue(undefined);
  claudeTerminalLaunchMock.mockReset();
  claudeTerminalCleanupMock.mockReset();
  claudeTerminalGetStateMock.mockReset();
  claudeTerminalSyncTranscriptMock.mockReset();
  claudeTerminalSyncTranscriptMock.mockResolvedValue({
    chatId: 'chat',
    importedEventCount: 0,
  });
  terminalWriteMock.mockReset();
  terminalOnExitMock.mockClear();
  claudeTerminalSubscribeMock.mockClear();
  chatApiMock.loadTabs.mockResolvedValue({
    version: 1,
    tabs: [],
    activeTabId: '',
  });
  chatApiMock.command.mockImplementation((request) =>
    Promise.resolve({
      commandId: request.commandId,
      revision: 1,
      outcome: 'applied',
    }),
  );
  chatApiMock.loadArchives.mockResolvedValue([]);
  chatApiMock.activeSessions.mockResolvedValue({ activeChatIds: [] });
  chatApiMock.changeModel.mockResolvedValue(true);
  chatApiMock.sendMessage.mockResolvedValue(undefined);
  chatApiMock.togglePlanMode.mockResolvedValue(undefined);
  chatApiMock.toggleThinkingLevel.mockResolvedValue(undefined);
  chatApiMock.updatePlugins.mockResolvedValue(undefined);
  chatApiMock.flushScope.mockResolvedValue(undefined);
  chatApiMock.forkOpenWorktreeTabs.mockResolvedValue({
    tabBindings: {},
    selectedTabApprovalMode: 'ask',
  });
  chatApiMock.adhocMigrateTabs.mockResolvedValue({ migratedTabIds: [] });
  chatApiMock.generateHandoffSummary.mockResolvedValue({
    summary: 'handoff summary',
  });
  chatApiMock.forkCodexThread.mockResolvedValue({
    forkedThreadId: 'thread-forked',
  });
  chatApiMock.exportSession.mockResolvedValue({
    exportId: 'export-default',
    title: 'Session export',
    sizeBytes: 1024,
    warnings: [],
  });
  claudeTerminalLaunchMock.mockResolvedValue({
    terminalId: 'terminal-1',
    sessionKey: 'session-key',
    sdkSessionId: 'terminal-sdk-session',
    state: {
      terminalId: 'terminal-1',
      sessionKey: 'session-key',
      sdkSessionId: 'terminal-sdk-session',
      turnState: 'idle',
    },
  });
  claudeTerminalCleanupMock.mockResolvedValue(undefined);
  claudeTerminalGetStateMock.mockResolvedValue(undefined);
  terminalWriteMock.mockResolvedValue(undefined);
  chatProjectApiMock.list.mockResolvedValue({
    projects: [
      {
        id: DEFAULT_COWORK_WORKSPACE_ID,
        name: 'Default',
        createdAt: new Date(0).toISOString(),
      },
      {
        id: 'project-a',
        name: 'Research',
        description: 'Research cowork project',
        color: '#336699',
        createdAt: new Date(0).toISOString(),
      },
    ],
  });
  chatProjectApiMock.create.mockResolvedValue({
    project: {
      id: 'new-project',
      name: 'New Project',
      createdAt: new Date(0).toISOString(),
    },
  });
  chatProjectApiMock.update.mockResolvedValue(undefined);
  chatProjectApiMock.delete.mockResolvedValue(undefined);
  chatProjectApiMock.loadClaudeMd.mockResolvedValue('# Standalone');
  chatProjectApiMock.saveClaudeMd.mockResolvedValue(undefined);
  standaloneChatApiMock.init.mockResolvedValue(undefined);
  standaloneChatApiMock.list.mockResolvedValue({
    chats: [
      {
        id: 'standalone-1',
        title: 'Research chat',
        description: 'Roadmap planning',
        createdAt: new Date(0).toISOString(),
        messageCount: 2,
        lastMessageAt: new Date(10).toISOString(),
        providerType: 'codex',
      },
      {
        id: 'archived-1',
        title: 'Archived chat',
        description: 'Old notes',
        createdAt: new Date(0).toISOString(),
        archived: true,
        archivedAt: new Date(20).toISOString(),
      },
    ],
  });
  sharedContainersApiMock.revokeRecipient.mockResolvedValue({ revoked: true });
  workEntriesApiMock.list.mockResolvedValue({
    entries: [
      {
        id: 'entry-1',
        title: 'Research chat',
        createdAt: new Date(0).toISOString(),
        lastMessageAt: new Date(10).toISOString(),
        providerType: 'codex',
        chatCount: 1,
      },
    ],
  });
  sidebarItemGroupsApiMock.list.mockReset().mockResolvedValue([]);
  workEntriesApiMock.create.mockResolvedValue({
    entry: {
      id: 'entry-new',
      title: 'New chat',
      createdAt: new Date(0).toISOString(),
      chatCount: 1,
    },
    reusedExistingEmpty: false,
  });
  workEntriesApiMock.update.mockResolvedValue(undefined);
  workEntriesApiMock.delete.mockResolvedValue(undefined);
  workEntriesApiMock.resolveChat.mockResolvedValue({
    entryId: 'entry-1',
    archivedInEntryId: null,
  });
  standaloneChatApiMock.readSummary.mockResolvedValue({ summary: '' });
  standaloneChatApiMock.readArchive.mockResolvedValue({
    snapshot: null,
    summary: '',
    legacySummaryOnly: false,
  });
  standaloneChatApiMock.resumeArchive.mockResolvedValue({
    tab: makeChatTab({ id: 'resumed-chat' }),
  });
  standaloneChatApiMock.loadWorkspace.mockResolvedValue(
    makeStandaloneWorkspaceSnapshot(),
  );
  workspaceItemsApiMock.listNotes.mockResolvedValue([
    {
      id: 'note-1',
      title: 'Note One',
      absolutePath: '/tmp/notes/note-1.md',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  ]);
  workspaceItemsApiMock.readNote.mockResolvedValue({
    meta: {
      id: 'note-1',
      title: 'Note One',
      absolutePath: '/tmp/notes/note-1.md',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    content: '# Note One',
  });
  workspaceItemsApiMock.listPrompts.mockResolvedValue([
    {
      id: 'prompt-1',
      title: 'Prompt One',
      absolutePath: '/tmp/prompts/prompt-1.md',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  ]);
  workspaceItemsApiMock.readPrompt.mockResolvedValue({
    meta: {
      id: 'prompt-1',
      title: 'Prompt One',
      absolutePath: '/tmp/prompts/prompt-1.md',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    content: 'Prompt body',
  });
  workspaceItemsApiMock.listAttachments.mockResolvedValue([
    {
      filename: 'attachment-1',
      absolutePath: '/tmp/requirements.md',
      sizeBytes: 12,
      createdAt: new Date(0).toISOString(),
    },
  ]);
  standaloneChatApiMock.exportProject.mockResolvedValue({ absolutePath: '' });
  standaloneChatApiMock.importProject.mockResolvedValue({
    project: {
      id: 'imported',
      name: 'Imported',
      createdAt: new Date(0).toISOString(),
    },
  });
  standaloneChatApiMock.onMetaUpdated.mockReturnValue(() => undefined);
  workspaceApiMock.getWorkspaceSettingsData.mockResolvedValue({
    manifest: null,
    localConfig: { version: 1, type: 'single-repo', repos: [] },
    effectiveRepos: [],
    suppressedManifestRepos: [],
    unresolvedManifestRepoIds: [],
    driftIssues: [],
    driftTargetPath: '/repo',
  });
  workspaceApiMock.getWorkspaceReadiness.mockResolvedValue({ issues: [] });
  launchWorkspaceReadinessFixMock.mockResolvedValue({
    ok: true,
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
  });
  workspaceApiMock.loadClaudeMd.mockResolvedValue('# Instructions');
  workspaceApiMock.saveProjectDefaultPlugins.mockResolvedValue(undefined);
  workspaceApiMock.saveWorkspaceDefaultPlugins.mockResolvedValue(undefined);
  workspaceApiMock.saveProjectScripts.mockResolvedValue(undefined);
  workspaceApiMock.saveWorkspaceScripts.mockResolvedValue(undefined);
  workspaceApiMock.saveProjectHooks.mockResolvedValue(undefined);
  workspaceApiMock.saveWorkspaceHooks.mockResolvedValue(undefined);
  workspaceApiMock.saveWorkspaceRepoScripts.mockResolvedValue(undefined);
  workspaceApiMock.saveWorkspaceRepoHooks.mockResolvedValue(undefined);
  workspaceApiMock.applyWorkspaceSourceChanges.mockResolvedValue({
    worktreeId: 'worktree-1',
    branchName: 'feature',
    createdWorktree: false,
    localRepoBindingsUpdated: false,
  });
  workspaceApiMock.applyProjectSourceChanges.mockResolvedValue({
    worktreeId: 'worktree-1',
    branchName: 'feature',
    createdWorktree: false,
  });
  workspaceApiMock.listAdhocMultiRepoJoinOptions.mockResolvedValue({
    options: [],
  });
  workspaceApiMock.listExistingWorktreeJoinOptions.mockResolvedValue({
    groups: [],
  });
  workspaceApiMock.combineWorktreeWithWorkspace.mockResolvedValue(undefined);
  workspaceApiMock.combineWorktreeWithExistingWorktree.mockResolvedValue(
    undefined,
  );
  workspaceApiMock.promoteTemporaryWorkspace.mockImplementation(
    ({ workspaceId, name }: { workspaceId: string; name: string }) =>
      Promise.resolve({
        type: 'multi-repo',
        id: workspaceId,
        name,
        color: '#222222',
        repos: [],
        worktrees: [],
        collapsed: false,
        order: 0,
        temporary: false,
      } as SidebarItem),
  );
  workspaceApiMock.previewSplitTemporaryWorkspace.mockResolvedValue({
    previewRevision: 'default-preview-revision',
    repos: [],
    root: {
      present: false,
      canArchive: true,
      chats: { count: 0, entries: [] },
      pipelines: { count: 0, entries: [] },
      plans: { count: 0, entries: [] },
      attachments: { count: 0, entries: [] },
    },
  });
  workspaceApiMock.setWorktreeHidden.mockResolvedValue(undefined);
  workspaceApiMock.setWorktreePausedHooks.mockResolvedValue(undefined);
  workspaceApiMock.setWorktreeBranchGrouping.mockResolvedValue(undefined);
  workspaceApiMock.discoverWorktreeEnv.mockResolvedValue(undefined);
  pipelinesApiMock.listShared.mockResolvedValue({
    success: true,
    data: { data: [], nextCursor: null },
  });
  loadProjectsApiMock.mockReset();
  loadProjectsApiMock.mockResolvedValue({
    version: 1,
    items: [{ id: 'ws-1', type: 'single-repo', worktrees: [] }],
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadProjects: loadProjectsApiMock,
      loadPreferences: loadPreferencesMock.mockResolvedValue({
        disabledPipelineIds: [],
      }),
      setPipelineDisabledPreference:
        setPipelineDisabledPreferenceMock.mockResolvedValue({
          disabledPipelineIds: [],
        }),
      loadCanopyCloudAccount: loadCanopyCloudAccountMock.mockResolvedValue({
        hasApiKey: false,
        authMode: null,
        credentialSource: null,
        capabilities: [],
        storageAvailable: true,
      }),
      loadEnvironmentConfig: loadEnvironmentConfigMock,
      saveEnvironmentConfig: saveEnvironmentConfigMock,
      startCanopyCloudOAuthLogin: jest.fn().mockResolvedValue({
        status: {
          authenticated: true,
          capabilities: ['skills-v1', 'collections-v1', 'pipelines-v1'],
          missingCapabilities: [],
          account: { id: 'account-1', email: 'user@example.test' },
          error: null,
        },
        account: {
          hasApiKey: true,
          authMode: 'oauth',
          credentialSource: 'oauth_desktop',
          capabilities: ['skills-v1', 'collections-v1', 'pipelines-v1'],
          account: { id: 'account-1', email: 'user@example.test' },
          storageAvailable: true,
        },
      }),
      cancelCanopyCloudOAuthLogin: jest.fn().mockResolvedValue(undefined),
      disconnectCanopyCloudAccount: jest.fn().mockResolvedValue({
        hasApiKey: false,
        authMode: null,
        credentialSource: null,
        capabilities: [],
        storageAvailable: true,
      }),
      validateCanopyCloudApiKey: jest.fn().mockResolvedValue({
        authenticated: true,
        capabilities: ['skills-v1', 'collections-v1', 'pipelines-v1'],
        missingCapabilities: [],
        account: { id: 'account-1', email: 'user@example.test' },
        error: null,
      }),
      saveCanopyCloudApiKey: jest.fn().mockResolvedValue({
        status: {
          authenticated: true,
          capabilities: ['skills-v1', 'collections-v1', 'pipelines-v1'],
          missingCapabilities: [],
          account: { id: 'account-1', email: 'user@example.test' },
          error: null,
        },
        account: {
          hasApiKey: true,
          capabilities: ['skills-v1', 'collections-v1', 'pipelines-v1'],
          account: { id: 'account-1', email: 'user@example.test' },
          storageAvailable: true,
        },
      }),
      clearCanopyCloudApiKey: jest.fn().mockResolvedValue({
        hasApiKey: false,
        capabilities: [],
        storageAvailable: true,
      }),
      installOllama: installOllamaActionMock,
      savePreferences: savePreferencesMock,
      browseForCloneDirectory: browseForCloneDirectoryMock,
      openMemoryDir: openMemoryDirMock,
      importClaudeMemory: importClaudeMemoryMock,
      consolidateLocalMemory: consolidateLocalMemoryMock,
      rebuildLocalMemory: rebuildLocalMemoryMock,
      listLocalMemorySnapshots: listLocalMemorySnapshotsMock,
      restoreLocalMemorySnapshot: restoreLocalMemorySnapshotMock,
      mutateFileTree: mutateFileTreeMock,
      getWorktreePath: getWorktreePathMock,
      readFileContent: jest.fn().mockResolvedValue({
        kind: 'markdown',
        content: '# Plan',
        filename: 'plan.md',
        sizeBytes: 6,
        truncated: false,
        modifiedAtMs: 1,
      }),
      chat: chatApiMock,
      claudeTerminal: {
        launch: claudeTerminalLaunchMock,
        cleanup: claudeTerminalCleanupMock,
        getState: claudeTerminalGetStateMock,
        syncTranscript: claudeTerminalSyncTranscriptMock,
        onStateChanged: claudeTerminalSubscribeMock,
        onSyncCompleted: claudeTerminalSubscribeMock,
        onError: claudeTerminalSubscribeMock,
      },
      terminal: {
        write: terminalWriteMock,
        onExit: terminalOnExitMock,
      },
      browser: browserApiMock,
      panelLayout: panelLayoutApiMock,
      chatProject: chatProjectApiMock,
      standaloneChat: standaloneChatApiMock,
      workEntries: workEntriesApiMock,
      sidebarItemGroups: sidebarItemGroupsApiMock,
      sharedContainers: sharedContainersApiMock,
      workspaceItems: workspaceItemsApiMock,
      github: {
        setForegroundWorktree: jest.fn().mockResolvedValue(undefined),
        requestFastRefresh: jest.fn().mockResolvedValue(undefined),
        startMergeConflictResolution: githubStartMergeConflictResolutionMock,
        startPrCommentTriage: githubStartPrCommentTriageMock,
        startCiCheckFix: githubStartCiCheckFixMock,
      },
      // Canopy Portal IPC is consumed by the dispatcher for the
      // `canopy_portal.*` action variants. Stub the full surface so calls
      // resolve and tests can assert which ones were (or weren't) invoked
      // when the feature flag is gated.
      canopyPortal: {
        getState: jest
          .fn()
          .mockResolvedValue({ status: 'disabled', error: null }),
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn().mockResolvedValue(undefined),
        onStateChanged: jest.fn((): (() => void) => (): undefined => undefined),
      },
      // Feature flag bridge. The dispatcher reads this via
      // `useFeatureFlagsStore`; tests override the store directly to
      // toggle the canopy-portal flag, but the bridge methods must exist
      // so any incidental access does not throw.
      featureFlags: {
        getSnapshot: jest.fn(),
        refreshContext: jest.fn(),
        onSnapshotChanged: jest.fn(
          (): (() => void) => (): undefined => undefined,
        ),
      },
      // App Advisor window-lifecycle IPC is routed through the dispatcher
      // for `app_advisor.*` actions. Provide stub implementations that
      // return a representative state envelope so the dispatcher can call
      // `syncWindowState` without throwing.
      // Automations transport surface exposed under `window.api.automations`.
      // The dispatcher's `automation.*` cases forward directly to these
      // mocks; tests override individual resolutions per case.
      // Organization project catalog and setup (CAN-2956). The dispatcher's
      // `org_project.*` cases go through this preload surface rather than the
      // renderer store, which is provider-scoped.
      orgProjects: {
        list: orgProjectsApiMock.list,
        setupStart: orgProjectsApiMock.setupStart,
        setupCancel: orgProjectsApiMock.setupCancel,
        refresh: orgProjectsApiMock.refresh,
        setPreference: orgProjectsApiMock.setPreference,
        linksList: orgProjectsApiMock.linksList,
        onSetupProgress: jest.fn(() => (): void => {}),
        onChanged: jest.fn(() => (): void => {}),
      },
      automations: {
        list: automationsApiMock.list,
        create: automationsApiMock.create,
        update: automationsApiMock.update,
        delete: automationsApiMock.delete,
        runNow: automationsApiMock.runNow,
        listShared: automationsApiMock.listShared,
        getShared: automationsApiMock.getShared,
        createShared: shareEnvelope(automationsApiMock.createShared),
        updateShared: shareEnvelope(automationsApiMock.updateShared),
        deleteShared: automationsApiMock.deleteShared,
        onChanged: automationsApiMock.onChanged,
      },
      // Tracked-plan transport surface — the dispatcher's `plan.share` case
      // forwards directly to `activity.plans.share`.
      managedDelegation: {
        stop: managedDelegationStopMock,
        stopAll: managedDelegationStopAllMock,
        changes: managedDelegationChangesMock,
      },
      activity: {
        stopBgProcess: activityStopBgProcessMock,
        stopOutputPolling: jest.fn().mockResolvedValue(undefined),
        plans: {
          import: activityPlansImportMock,
          share: shareEnvelope(activityPlansShareMock),
          get: activityPlansGetMock,
          list: activityPlansListMock,
        },
      },
      runs: {
        share: shareEnvelope(runsShareMock),
        unshare: runsUnshareMock,
      },
      appAdvisor: {
        getState: jest.fn().mockResolvedValue(undefined),
        openWindow: appAdvisorOpenWindowMock,
        ensureWindow: jest
          .fn()
          .mockResolvedValue({ open: false, focused: false }),
        closeWindow: jest
          .fn()
          .mockResolvedValue({ open: false, focused: false }),
        toggleWindow: jest
          .fn()
          .mockResolvedValue({ open: true, focused: true }),
        getWindowState: jest
          .fn()
          .mockResolvedValue({ open: false, focused: false }),
        onWindowStateChanged: jest.fn(
          (): (() => void) => (): undefined => undefined,
        ),
        onWindowUiStateChanged: jest.fn(
          (callback: (state: AppAdvisorWindowUiState) => void) => {
            appAdvisorWindowUiStateListener = callback;
            return (): void => {
              if (appAdvisorWindowUiStateListener === callback) {
                appAdvisorWindowUiStateListener = null;
              }
            };
          },
        ),
        onWindowCommand: jest.fn(
          (): (() => void) => (): undefined => undefined,
        ),
        onToolRequest: jest.fn((): (() => void) => (): undefined => undefined),
        completeToolRequest: jest.fn(),
        onStateChanged: jest.fn((): (() => void) => (): undefined => undefined),
        listWatchers: appAdvisorListWatchersMock,
        deleteWatcher: appAdvisorDeleteWatcherMock,
        acknowledgeWatcherMessageDelivery: jest
          .fn()
          .mockResolvedValue({ ok: true }),
        onWatchersChanged: jest.fn(
          (): (() => void) => (): undefined => undefined,
        ),
        settingsLoad: jest.fn().mockResolvedValue({
          version: 1,
          archiveRetentionDays: 30,
          autoArchiveDays: 14,
        }),
        settingsSave: appAdvisorSettingsSaveMock,
      },
      ...workspaceApiMock,
    },
  });
  skillsApiMock.loadSkills.mockResolvedValue({ success: true, data: [] });
  skillsApiMock.installSkills.mockResolvedValue({ success: true });
  skillsApiMock.readContent.mockResolvedValue({
    success: true,
    data: { frontmatter: {}, body: '' },
  });
  skillsApiMock.listFiles.mockResolvedValue({
    success: true,
    data: { files: ['SKILL.md'], truncated: false },
  });
  skillsApiMock.readFile.mockResolvedValue({
    success: true,
    data: { content: '', truncated: false, binary: false },
  });
  skillsApiMock.readRawSkill.mockResolvedValue(
    '---\nname: custom-skill\n---\n',
  );
  skillsApiMock.saveCustomSkill.mockResolvedValue({
    success: true,
    data: { name: 'custom-skill' },
  });
  skillsApiMock.removeSkill.mockResolvedValue({
    success: true,
    data: undefined,
  });
  skillsApiMock.listShared.mockResolvedValue({ skills: [] });
  skillsApiMock.getShared.mockResolvedValue({
    id: 'shared-skill',
    name: 'custom-skill',
    description: '',
    rawSkill: '---\nname: custom-skill\n---\n',
    contentHash: 'sha256:abc',
    shareScope: 'private',
    owner: { type: 'user', id: 'user-1', name: 'Owner' },
    createdBy: { id: 'user-1', name: 'Owner', email: 'owner@example.test' },
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
    canUpdate: true,
    canDelete: true,
  });
  const sharedSkillMutationResult = {
    id: 'shared-skill',
    name: 'custom-skill',
    description: '',
    rawSkill: '---\nname: custom-skill\n---\n',
    contentHash: 'sha256:abc',
    shareScope: 'private' as const,
    owner: { type: 'user' as const, id: 'user-1', name: 'Owner' },
    createdBy: { id: 'user-1', name: 'Owner', email: 'owner@example.test' },
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
    canUpdate: true,
    canDelete: true,
  };
  skillsApiMock.createShared.mockResolvedValue(sharedSkillMutationResult);
  skillsApiMock.updateShared.mockResolvedValue(sharedSkillMutationResult);
  skillsApiMock.deleteShared.mockResolvedValue(undefined);
  agentsApiMock.list.mockResolvedValue({ agents: [] });
  agentsApiMock.get.mockResolvedValue(null);
  agentsApiMock.save.mockImplementation((request: SaveAgentModelRequest) =>
    Promise.resolve({
      id: request.id ?? 'agent_model_code_reviewer',
      name: request.name,
      baseModel: request.baseModel,
      instructions: request.instructions,
      pluginSelections: request.pluginSelections,
      createdAt: '2026-07-03T00:00:00.000Z',
      updatedAt: '2026-07-03T00:00:00.000Z',
    }),
  );
  agentsApiMock.delete.mockResolvedValue(undefined);
  agentsApiMock.importShared.mockResolvedValue({
    agent: {
      id: 'agent_model_imported',
      name: 'Imported',
      baseModel: 'opus',
      instructions: '',
      pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      createdAt: '2026-07-03T00:00:00.000Z',
      updatedAt: '2026-07-03T00:00:00.000Z',
    },
    requestedId: 'agent_model_imported',
    finalId: 'agent_model_imported',
    idChanged: false,
  });
  agentsApiMock.listShared.mockResolvedValue({ agents: [] });
  agentsApiMock.deleteShared.mockResolvedValue(undefined);
  pluginsApiMock.loadMarketplaces.mockResolvedValue({
    success: true,
    data: { version: 2, lastRefreshed: '', marketplaces: [] },
  });
  pluginsApiMock.refreshMarketplaces.mockResolvedValue({
    success: true,
    data: { version: 2, lastRefreshed: '', marketplaces: [] },
  });
  pluginsApiMock.updateMarketplace.mockResolvedValue({
    success: true,
    data: null,
  });
  pluginsApiMock.removeMarketplace.mockResolvedValue({
    success: true,
    data: null,
  });
  Object.defineProperty(window, 'skills', {
    configurable: true,
    value: {
      ...skillsApiMock,
      createShared: shareEnvelope(skillsApiMock.createShared),
      updateShared: shareEnvelope(skillsApiMock.updateShared),
    },
  });
  Object.defineProperty(window, 'agents', {
    configurable: true,
    value: {
      ...agentsApiMock,
      createShared: shareEnvelope(agentsApiMock.createShared),
      updateShared: shareEnvelope(agentsApiMock.updateShared),
    },
  });
  Object.defineProperty(window, 'plugins', {
    configurable: true,
    value: pluginsApiMock,
  });
  Object.defineProperty(window, 'bundles', {
    configurable: true,
    value: {
      loadIndex: jest.fn().mockResolvedValue({ version: 1, bundles: [] }),
    },
  });
  Object.defineProperty(window, 'collections', {
    configurable: true,
    value: {
      loadIndex: jest.fn().mockResolvedValue([]),
      loadCollection: jest.fn().mockResolvedValue(null),
      saveCollection: jest.fn(),
      deleteCollection: jest.fn(),
      listShared: jest.fn(),
      getShared: jest.fn(),
      createShared: jest.fn(),
      updateShared: jest.fn(),
      deleteShared: jest.fn(),
    },
  });
  Object.defineProperty(window, 'mcpServers', {
    configurable: true,
    value: {
      loadIndex: jest.fn().mockResolvedValue({ version: 1, servers: [] }),
    },
  });
  Object.defineProperty(window, 'pipelines', {
    configurable: true,
    value: pipelinesApiMock,
  });
  useNavigationStore.setState({
    activePage: 'overview',
    settingsOpen: false,
    commandPaletteOpen: false,
    fileSearchPaletteOpen: false,
    prPickerOpen: false,
    canopyPortalOpen: false,
    appAdvisorOpen: false,
    pendingPluginsNavigation: undefined,
    pendingCuratedPipelinePreviewKey: undefined,
    pendingAutomationSharedPipelineReview: undefined,
    workflowEdit: undefined,
  });
  // Reset the feature flag snapshot to the protocol default (Portal
  // enabled). Individual gated tests override this snapshot to verify the
  // disabled path.
  useFeatureFlagsStore.setState({ snapshot: getDefaultFeatureFlagSnapshot() });
  useWorkspaceContextStore.setState(
    useWorkspaceContextStore.getInitialState(),
    true,
  );
  restoreRendererPlatform();
  // Clear any toasts emitted by previous tests so each spec sees a clean
  // slate. `addToast` is also spied on in the portal gating tests, but
  // this guard keeps tests that read `useGitHubStore.getState().toasts`
  // deterministic.
  useGitHubStore.setState({ toasts: [], notifications: [] });
  useChatStore.setState({
    selectedWorktree: null,
    worktreeChats: {},
  });
  useFileTabUiStore.setState({ fileTreeVisibleByTabId: {} });
  useActivityStore.setState({
    trackedPlans: {},
    bgProcesses: {},
  });
  activityPlansGetMock.mockReset();
  activityPlansGetMock.mockResolvedValue(null);
  activityPlansListMock.mockReset();
  activityPlansListMock.mockResolvedValue([]);
  openTrackedPlanMock.mockReset();
  openPlanPanelMock.mockReset();
  openPlanDiagramPanelMock.mockReset();
  openSubagentsPanelMock.mockReset();
  useImportSessionModalStore.setState({ target: null });
  useUsageLimitResumePromptStore.setState({
    isOpen: false,
    provider: null,
    origin: 'account-change',
  });
  useBrowserStore.setState({
    worktrees: {},
    consoleEntries: {},
    networkEntries: {},
    recordings: {},
    screenshots: {},
    inspectorOpen: {},
    inspectorTab: {},
    diagnosticsSeenAt: {},
  });
  mockFileSessionDirty.clear();
  mockControllerSaveTab.mockReset();
  mockControllerSaveTab.mockResolvedValue(true);
  useStandaloneChatStore.setState({
    workEntries: [],
    chatProjects: [
      {
        id: DEFAULT_COWORK_WORKSPACE_ID,
        name: 'Default',
        createdAt: new Date(0).toISOString(),
      },
      {
        id: 'project-a',
        name: 'Research',
        description: 'Research cowork project',
        color: '#336699',
        createdAt: new Date(0).toISOString(),
      },
    ],
    activeWorkEntryId: null,
    activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
    initialized: false,
    chatProjectsLoaded: true,
    activeSummary: null,
    activeArchiveData: null,
    archiveOverlayChatId: null,
    sidebarEntriesByProject: {},
    legacyArchivedByProject: {},
  });
  useProjectsStore.setState({
    projects: [],
    hasHydratedProjects: true,
    isLoading: false,
    commitsAhead: {},
    repoBranches: {},
    uncommittedChanges: {},
    hasRemoteTracking: {},
    hasOriginRemote: {},
    worktreeError: null,
    pendingWorkspaceRepair: null,
    loadProjects: jest.fn().mockResolvedValue(undefined),
    refreshWorktreeDiffStatsVerified: jest.fn().mockResolvedValue(true),
  });
  useBranchFromStore.getState().resolveConfirmation(null);
  useBaseBranchAlignmentStore.getState().resolveConfirmation(false);
  useGitHubStore.setState({
    prStatuses: {},
    creatingPr: new Set(),
    mergingPr: new Set(),
    committingAndPushing: new Set(),
    mergingLocalBranches: new Set(),
    activeBranchSyncAction: {},
    commitPushProgress: {},
    commitReviewPending: {},
  });
  useCurrentUiStateStore.setState({
    revision: 42,
    envelope: {
      version: 1,
      revision: 42,
      capturedAt: new Date(0).toISOString(),
      digest: 'fixed-digest',
      snapshot: {
        activePage: 'overview',
        archivedContainers: { count: 0, viewerOpen: false },
        overlays: {
          commandPaletteOpen: false,
          fileSearchPaletteOpen: false,
          prPickerOpen: false,
          canopyPortalOpen: false,
          appAdvisorOpen: false,
        },
      },
    },
    slices: {},
  });
});

function makeChatTab(overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    id: 'chat-1',
    title: 'Implementation chat',
    messages: [
      {
        id: 'user-1',
        role: 'user',
        timestamp: 10,
        blocks: [
          { type: 'text', text: 'Please inspect the pipeline failure.' },
        ],
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        timestamp: 20,
        blocks: [{ type: 'text', text: 'The launch script is failing.' }],
      },
      {
        id: 'user-2',
        role: 'user',
        timestamp: 30,
        blocks: [
          { type: 'text', text: 'Now check the App Advisor transcript.' },
        ],
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        timestamp: 40,
        blocks: [
          { type: 'text', text: 'The App Advisor transcript is readable.' },
        ],
      },
    ],
    status: 'idle',
    error: null,
    createdAt: new Date(0).toISOString(),
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    ...overrides,
    fastModeExplicit: overrides.fastModeExplicit ?? false,
  };
}

function makeClaudeTerminalModelDefaults(): NonNullable<
  ReturnType<typeof useChatStore.getState>['modelDefaults']
> {
  const providerDefaults = {
    claude: { model: 'opus[1m]', thinkingLevel: 'high' },
    codex: { model: 'gpt-6-sol', thinkingLevel: 'medium' },
    ollama: null,
  } as const;
  return {
    chatProvider: 'claude',
    chatModelByProvider: providerDefaults,
    worktreeProvider: 'claude',
    worktreeModelByProvider: providerDefaults,
    defaultChatInterfaceMode: 'claude-code',
    codexFastModeDefaultEnabled: false,
  };
}

function readStringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'string' ? candidate : undefined;
}

function makeFileTab(overrides: Partial<ChatTab> = {}): ChatTab {
  return makeChatTab({
    kind: 'file',
    title: 'notes.md',
    filePath: '/repo/notes.md',
    description: '/repo/notes.md',
    ...overrides,
  });
}

/** Resolves once the mock has been called, polling the microtask queue. */
async function waitForCall(mock: jest.Mock): Promise<void> {
  for (let i = 0; i < 200 && mock.mock.calls.length === 0; i += 1)
    await new Promise((resolve): void => {
      setTimeout(resolve, 0);
    });
  expect(mock).toHaveBeenCalled();
}

function makeWorkspace(
  overrides: Partial<SingleRepoSidebarItem> = {},
): SingleRepoSidebarItem {
  return {
    type: 'single-repo',
    id: 'project-1',
    name: 'Project One',
    repoPath: '/repo',
    color: '#111111',
    worktrees: [
      {
        id: 'worktree-1',
        branchName: 'feature',
        createdAt: new Date(0).toISOString(),
      },
    ],
    collapsed: false,
    order: 0,
    ...overrides,
  };
}

function makeStandaloneProject(
  overrides: Partial<ChatProjectData> = {},
): ChatProjectData {
  return {
    id: 'project-a',
    name: 'Research',
    description: 'Research cowork project',
    color: '#336699',
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function makeStandaloneWorkspaceSnapshot(
  overrides: Partial<StandaloneWorkspaceSnapshotResponse> = {},
): StandaloneWorkspaceSnapshotResponse {
  return {
    project: {
      version: 1,
      id: 'project-a',
      name: 'Research',
      description: 'Research cowork project',
      createdAt: new Date(0).toISOString(),
    },
    archives: [],
    ...overrides,
  };
}

function makeMultiRepoWorkspace(
  overrides: Partial<MultiRepoSidebarItem> = {},
): MultiRepoSidebarItem {
  return {
    type: 'multi-repo',
    id: 'workspace-1',
    name: 'Workspace One',
    color: '#222222',
    repos: [
      {
        id: 'repo-a',
        name: 'Repo A',
        repoPath: '/repo-a',
        source: 'local',
      },
      {
        id: 'repo-b',
        name: 'Repo B',
        repoPath: '/repo-b',
        source: 'local',
      },
    ],
    sourceRepoPath: '/workspace-source',
    worktrees: [
      {
        id: 'worktree-1',
        branchName: 'feature',
        createdAt: new Date(0).toISOString(),
      },
    ],
    collapsed: false,
    order: 0,
    ...overrides,
  };
}

function makePipelineInfo(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'pipe-1',
    name: 'Project pipeline',
    filename: 'project.yaml',
    description: 'Pipeline for tests',
    icon: '',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    triggerTypes: ['dispatch'],
    source: 'user',
    readonly: false,
    ...overrides,
  };
}

function makeSharedPipelineDetail(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'remote-1',
    name: 'Shared pipeline',
    description: 'Shared pipeline for tests',
    icon: '',
    version: '1',
    triggerTypes: ['dispatch'],
    createdBy: { id: 'user-1', name: 'User One' },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    canUpdate: true,
    canDelete: true,
    shareScope: 'private',
    owner: { type: 'user', id: 'user-1', name: 'User One' },
    rawPipeline:
      'pipeline:\n  name: Shared pipeline\n  description: Shared pipeline for tests\n  on: dispatch\n  jobs:\n    test:\n      steps: []\n',
    ...overrides,
  };
}

function makeExecutionState(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 8,
    id: 'execution-1',
    pipeline_id: 'pipe-1',
    pipeline_snapshot: {
      name: 'Project pipeline',
      description: 'Execution description',
      jobs: {
        test: {
          name: 'Test',
          needs: [],
          steps: [],
          timeout_minutes: 30,
          max_retries: 0,
          continue_on_error: false,
        },
      },
    },
    status: 'failure',
    jobs: {
      test: {
        status: 'failure',
        steps: {
          run: {
            status: 'failure',
            outputs: {},
            dynamic_env: {},
            error: 'failed',
          },
        },
        outputs: {},
      },
    },
    job_definitions: {
      test: {
        name: 'Test',
        needs: [],
        steps: [],
        timeout_minutes: 30,
        max_retries: 0,
        continue_on_error: false,
        physical_job_id: 'test',
        logical_job_id: 'test',
      },
    },
    job_groups: {
      test: {
        job_id: 'test',
        kind: 'single',
        expansion: 'expanded',
        variant_job_ids: ['test'],
        status: 'failure',
      },
    },
    pending_pauses: [],
    status_reasons: [],
    started_at: '2026-05-20T00:00:00.000Z',
    completed_at: '2026-05-20T00:01:00.000Z',
    cwd: '/repo',
    env: {},
    inputs: {},
    project_id: 'project-1',
    worktree_id: 'worktree-1',
    event_data: {
      plan_ready: { plan_path: '/tmp/plan.md' },
    },
    report_outputs: {
      report_file: '/tmp/report.md',
    },
    ...overrides,
  };
}

describe('dispatchAppAction', () => {
  it('validates file explorer search actions', () => {
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'file-tree.set_search',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        query: 'README',
      }),
    ).toBe(true);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'file-tree.set_search',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        query: 123,
      }),
    ).toBe(false);
  });

  it('dispatches file explorer search state to the active tree', async () => {
    const listener = jest.fn<void, [Event]>((event) => {
      if (!(event instanceof CustomEvent)) return;
      if (!isFileTreeSetSearchDetail(event.detail)) return;
      event.detail.acknowledge();
    });
    window.addEventListener(FILE_TREE_SET_SEARCH_EVENT, listener);
    try {
      const response = await dispatchAppAction({
        requestId: 'file-tree-search-1',
        source: 'assistant',
        action: {
          type: 'file-tree.set_search',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          query: 'README',
        },
      });

      expect(response).toMatchObject({
        ok: true,
        result: {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          open: true,
        },
      });
      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0]?.[0];
      expect(event).toBeInstanceOf(CustomEvent);
      if (!(event instanceof CustomEvent)) {
        throw new Error('Expected file-tree search CustomEvent');
      }
      expect(isFileTreeSetSearchDetail(event.detail)).toBe(true);
      if (!isFileTreeSetSearchDetail(event.detail)) {
        throw new Error('Expected file-tree search event detail');
      }
      expect(event.detail.projectId).toBe('project-1');
      expect(event.detail.worktreeId).toBe('worktree-1');
      expect(event.detail.query).toBe('README');
    } finally {
      window.removeEventListener(FILE_TREE_SET_SEARCH_EVENT, listener);
    }
  });

  it('returns not_found when no active explorer handles search', async () => {
    const response = await dispatchAppAction({
      requestId: 'file-tree-search-missing',
      source: 'assistant',
      action: {
        type: 'file-tree.set_search',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        query: 'README',
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('not_found');
  });

  it('validates and dispatches file explorer mutations', async () => {
    const action = {
      type: 'file-tree.copy' as const,
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      source: { repoId: 'repo-1', relativePath: 'src/file.ts' },
      target: { repoId: 'repo-1', relativePath: 'src/file.ts' },
      conflict: 'increment' as const,
    };
    expect(__isValidAppAdvisorActionForTests(action)).toBe(true);
    expect(
      __isValidAppAdvisorActionForTests({
        ...action,
        source: { repoId: '', relativePath: 'src/file.ts' },
      }),
    ).toBe(false);

    const response = await dispatchAppAction({
      requestId: 'file-tree-copy-1',
      source: 'assistant',
      action,
    });

    expect(response).toMatchObject({
      ok: true,
      result: {
        operation: 'copy',
        source: { repoId: 'repo-1', relativePath: 'src/file.ts' },
        target: { repoId: 'repo-1', relativePath: 'src/file.ts' },
      },
    });
    expect(mutateFileTreeMock).toHaveBeenCalledWith({
      operation: 'copy',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      source: { repoId: 'repo-1', relativePath: 'src/file.ts' },
      target: { repoId: 'repo-1', relativePath: 'src/file.ts' },
      conflict: 'increment',
    });
  });

  it('accepts the archived changes tab', () => {
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'archived.open',
        workspaceId: 'workspace-1',
        containerId: 'archive-1',
        tab: 'changes',
      }),
    ).toBe(true);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'archived.open',
        workspaceId: 'workspace-1',
        containerId: 'archive-1',
        tab: 'unknown',
      }),
    ).toBe(false);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'archived.open',
        workspaceId: 'workspace-1',
        containerId: 'archive-1',
        tab: 'plans',
        planId: 42,
      }),
    ).toBe(false);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'archived.open_overview',
        workspaceId: 'workspace-1',
      }),
    ).toBe(true);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'archived.open_empty_trash',
        workspaceId: 'workspace-1',
      }),
    ).toBe(true);
  });

  it('routes the App Advisor archived overview and Empty trash confirmation to the popout renderer', async () => {
    const loadForWorkspace = jest
      .spyOn(useArchivedContainersStore.getState(), 'loadForWorkspace')
      .mockResolvedValue();
    useArchivedContainersStore.setState({
      byWorkspace: {
        'workspace-1': [
          {
            version: 1,
            id: 'archive-1',
            projectId: 'workspace-1',
            kind: 'work-entry',
            name: 'Deleted entry',
            createdAt: '2026-09-01T00:00:00.000Z',
            archivedAt: '2026-09-02T00:00:00.000Z',
            retentionDays: 7,
            expiresAt: '2026-09-09T00:00:00.000Z',
            chatCount: 0,
            archivedChatCount: 0,
            executionCount: 0,
          },
        ],
      },
      overview: null,
      emptyTrashConfirmationWorkspaceId: null,
    });

    Object.assign(window.api, {
      archivedContainers: {
        list: jest.fn().mockResolvedValue([
          {
            version: 1,
            id: 'archive-1',
            projectId: APP_ADVISOR_PROJECT_ID,
            kind: 'work-entry',
            name: 'Deleted entry',
            createdAt: '2026-09-01T00:00:00.000Z',
            archivedAt: '2026-09-02T00:00:00.000Z',
            retentionDays: 7,
            expiresAt: '2026-09-09T00:00:00.000Z',
            chatCount: 0,
            archivedChatCount: 0,
            executionCount: 0,
          },
        ]),
      },
    });

    const overview = await dispatchAppAction({
      requestId: 'archived-overview-1',
      source: 'assistant',
      action: {
        type: 'archived.open_overview',
        workspaceId: APP_ADVISOR_PROJECT_ID,
      },
    });
    const emptyTrash = await dispatchAppAction({
      requestId: 'archived-empty-trash-1',
      source: 'assistant',
      action: {
        type: 'archived.open_empty_trash',
        workspaceId: APP_ADVISOR_PROJECT_ID,
      },
    });

    expect(overview).toMatchObject({ ok: true });
    expect(emptyTrash).toMatchObject({
      ok: true,
      result: { confirmationOpened: true, deletedCount: 1 },
    });
    expect(appAdvisorOpenWindowMock).toHaveBeenNthCalledWith(1, {
      focus: true,
      archivedOverview: {},
    });
    const emptyTrashWindowRequest = appAdvisorOpenWindowMock.mock.calls[1]?.[0];
    expect(emptyTrashWindowRequest?.focus).toBe(true);
    expect(
      emptyTrashWindowRequest?.archivedOverview?.openEmptyTrashConfirmation,
    ).toBe(true);
    expect(typeof emptyTrashWindowRequest?.archivedOverview?.requestId).toBe(
      'string',
    );
    expect(useArchivedContainersStore.getState()).toMatchObject({
      overview: null,
      emptyTrashConfirmationWorkspaceId: null,
    });
    expect(loadForWorkspace).not.toHaveBeenCalled();

    appAdvisorOpenWindowMock.mockImplementationOnce((request) => {
      const requestId = request?.archivedOverview?.requestId;
      queueMicrotask(() => {
        appAdvisorWindowUiStateListener?.({
          activeWorkEntryId: 'entry-1',
          activeChatId: 'chat-1',
          navCollapsed: false,
          settingsModalOpen: false,
          archivedOverviewOpen: true,
          archivedOverviewWorkspaceId: APP_ADVISOR_PROJECT_ID,
          emptyTrashConfirmationOpen: false,
          emptyTrashRunning: true,
          lastArchivedOverviewRequestId: requestId ?? null,
          lastArchivedOverviewConfirmationOpened: false,
        });
      });
      return Promise.resolve({ open: true, focused: true });
    });
    await expect(
      dispatchAppAction({
        requestId: 'archived-empty-trash-running',
        source: 'assistant',
        action: {
          type: 'archived.open_empty_trash',
          workspaceId: APP_ADVISOR_PROJECT_ID,
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'Empty trash is already running.',
      },
    });
    loadForWorkspace.mockRestore();
  });

  it('requires a strict trailing load before opening Empty trash outside App Advisor', async () => {
    const loadForWorkspace = jest
      .spyOn(useArchivedContainersStore.getState(), 'loadForWorkspace')
      .mockResolvedValue();
    useArchivedContainersStore.setState({
      byWorkspace: { 'workspace-1': [] },
    });

    const response = await dispatchAppAction({
      requestId: 'archived-empty-trash-list-failure',
      source: 'assistant',
      action: {
        type: 'archived.open_empty_trash',
        workspaceId: 'workspace-1',
      },
    });

    expect(loadForWorkspace).toHaveBeenCalledWith('workspace-1', {
      trailing: true,
      strict: true,
    });
    expect(response).toMatchObject({ ok: false, error: { code: 'not_found' } });

    loadForWorkspace.mockRestore();
  });

  it('returns the cached response when the same requestId is dispatched twice', async () => {
    const first = await dispatchAppAction({
      requestId: 'req-1',
      source: 'assistant',
      action: { type: 'navigation.go_to_page', page: 'pipelines' },
    });
    useNavigationStore.setState({ activePage: 'overview' });
    const second = await dispatchAppAction({
      requestId: 'req-1',
      source: 'assistant',
      action: { type: 'navigation.go_to_page', page: 'pipelines' },
    });
    expect(second).toBe(first);
    expect(useNavigationStore.getState().activePage).toBe('overview');
  });

  it('never replays a cached response to another origin chat (CAN-3976)', async () => {
    const first = await dispatchAppAction({
      requestId: 'req-scoped',
      source: 'assistant',
      originChatTabId: 'chat-a',
      action: { type: 'navigation.go_to_page', page: 'pipelines' },
    });
    const second = await dispatchAppAction({
      requestId: 'req-scoped',
      source: 'assistant',
      originChatTabId: 'chat-b',
      action: { type: 'navigation.go_to_page', page: 'automations' },
    });
    expect(second).not.toBe(first);
    expect(useNavigationStore.getState().activePage).toBe('workflows-library');

    useNavigationStore.setState({ activePage: 'overview' });
    const replay = await dispatchAppAction({
      requestId: 'req-scoped',
      source: 'assistant',
      originChatTabId: 'chat-a',
      action: { type: 'navigation.go_to_page', page: 'pipelines' },
    });
    expect(replay).toBe(first);
    expect(useNavigationStore.getState().activePage).toBe('overview');
  });

  it.each([
    ['workflows', 'workflows'],
    ['workflows-schedule', 'workflows-schedule'],
    ['workflows-library', 'workflows-library'],
    // Legacy ids open the tab they became (CAN-3981).
    ['automations', 'workflows-library'],
    ['pipelines', 'workflows-library'],
    ['watchers', 'workflows'],
  ] as const)(
    'opens Workflows for the %s page on %s',
    async (requested, page) => {
      const response = await dispatchAppAction({
        requestId: `req-workflows-${requested}`,
        source: 'assistant',
        action: { type: 'navigation.go_to_page', page: requested },
      });

      expect(response.ok).toBe(true);
      expect(useNavigationStore.getState().activePage).toBe(page);
    },
  );

  it.each([
    ['scheduled', 'workflows-library'],
    ['watchers', 'workflows'],
  ] as const)(
    'opens the Workflows tab a legacy %s tab became',
    async (tab, page) => {
      const response = await dispatchAppAction({
        requestId: `req-automations-${tab}`,
        source: 'assistant',
        action: { type: 'navigation.go_to_page', page: 'automations', tab },
      });

      expect(response.ok).toBe(true);
      expect(useNavigationStore.getState().activePage).toBe(page);
    },
  );

  // CAN-4261: automations live on the Workflows tab, and the retired
  // ownership filter became a focus on its Shared by me section.
  it('opens Customize → Workflows at Shared by me for the retired Shared tab', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-automations-shared',
      source: 'assistant',
      action: {
        type: 'navigation.go_to_page',
        page: 'automations',
        tab: 'shared',
      },
    });

    expect(response.ok).toBe(true);
    const state = useNavigationStore.getState();
    expect(state.activePage).toBe('plugins');
    expect(state.pendingPluginsNavigation).toEqual({
      kind: 'marketplace-browse',
      query: '',
      tab: 'workflow',
      focusSection: 'shared-by-me',
    });
  });

  it('rejects a tab for the watchers page', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-watchers-tab',
      source: 'assistant',
      action: {
        type: 'navigation.go_to_page',
        page: 'watchers',
        tab: 'shared',
      },
    });

    expect(response.ok).toBe(false);
  });

  it('returns stale_ui_state when expectedUiRevision does not match', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-2',
      source: 'assistant',
      expectedUiRevision: 99,
      action: { type: 'file.save_active' },
    });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('stale_ui_state');
  });

  it('dispatches active preview search drawer controls', async () => {
    const operations: string[] = [];
    const listener = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (!isFilePreviewSearchEventDetail(detail)) return;
      operations.push(detail.operation);
      detail.acknowledge();
    };
    window.addEventListener('canopy:file-preview-search', listener);
    try {
      const opened = await dispatchAppAction({
        requestId: 'req-preview-search-open',
        source: 'assistant',
        action: { type: 'file.preview_search_open' },
      });
      const closed = await dispatchAppAction({
        requestId: 'req-preview-search-close',
        source: 'assistant',
        action: { type: 'file.preview_search_close' },
      });

      expect(opened.ok).toBe(true);
      expect(closed.ok).toBe(true);
      expect(operations).toEqual(['open', 'close']);
    } finally {
      window.removeEventListener('canopy:file-preview-search', listener);
    }
  });

  it('returns invalid_target when no active preview handles search controls', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-preview-search-missing',
      source: 'assistant',
      action: { type: 'file.preview_search_open' },
    });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('invalid_target');
  });

  it('skips expectedUiRevision for pure navigation/open actions', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-3',
      source: 'assistant',
      expectedUiRevision: 99,
      action: { type: 'navigation.open_settings', section: 'app-advisor' },
    });
    expect(response.ok).toBe(true);
    expect(useNavigationStore.getState().settingsOpen).toBe(true);
  });

  it('installs Ollama through the guarded settings action without exposing its path', async () => {
    installOllamaActionMock.mockResolvedValue({
      port: 11434,
      status: 'stopped',
      models: [],
      mode: 'managed',
      installation: {
        platform: 'darwin',
        ready: true,
        path: '/Applications/Ollama.app/Contents/Resources/ollama',
        version: '0.15.0',
        source: 'installed',
        checkedAt: '2026-07-16T00:00:00.000Z',
        automaticInstallSupported: true,
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-ollama-install',
      source: 'assistant',
      action: { type: 'ollama.install' },
    });

    expect(response.ok).toBe(true);
    expect(installOllamaActionMock).toHaveBeenCalledTimes(1);
    expect(useNavigationStore.getState()).toMatchObject({
      settingsOpen: true,
      settingsInitialSection: 'ollama',
    });
    expect(response.result).toEqual({
      mode: 'managed',
      status: 'stopped',
      installation: {
        ready: true,
        version: '0.15.0',
        source: 'installed',
        automaticInstallSupported: true,
      },
    });
    expect(JSON.stringify(response)).not.toContain('/Applications');
  });

  it('reports an unsuccessful Ollama installation as an execution failure', async () => {
    installOllamaActionMock.mockResolvedValue({
      port: 11434,
      status: 'stopped',
      models: [],
      mode: 'managed',
      installation: {
        platform: 'darwin',
        ready: false,
        path: null,
        version: null,
        source: 'not-found',
        checkedAt: '2026-07-16T00:00:00.000Z',
        automaticInstallSupported: true,
      },
      error: 'Ollama installation could not be completed.',
    });

    const response = await dispatchAppAction({
      requestId: 'req-ollama-install-failure',
      source: 'assistant',
      action: { type: 'ollama.install' },
    });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'Ollama installation could not be completed.',
      },
    });
  });

  it('opens the privacy opt-in review without saving (CAN-3383)', async () => {
    savePreferencesMock.mockClear();
    useNavigationStore.setState({
      pendingPrivacyOptIn: undefined,
      queuedPrivacyOptIns: [],
    });
    const response = await dispatchAppAction({
      requestId: 'req-privacy-opt-in',
      source: 'assistant',
      action: {
        type: 'settings.review_privacy_opt_in',
        feature: 'leaderboards',
        organizationId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      },
    });

    expect(response).toMatchObject({ ok: true, result: { opened: true } });
    expect(useNavigationStore.getState().pendingPrivacyOptIn).toMatchObject({
      feature: 'leaderboards',
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(savePreferencesMock).not.toHaveBeenCalled();
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'settings.review_privacy_opt_in',
        feature: 'everything',
        organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
    ).toBe(false);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'settings.review_privacy_opt_in',
        feature: 'leaderboards',
        organizationId: 'not-a-uuid',
      }),
    ).toBe(false);
  });

  it('persists the local memory preference through the settings action', async () => {
    savePreferencesMock.mockClear();

    const response = await dispatchAppAction({
      requestId: 'req-local-memory-toggle',
      source: 'assistant',
      action: { type: 'settings.set_local_memory_enabled', enabled: false },
    });

    expect(response.ok).toBe(true);
    expect(savePreferencesMock).toHaveBeenCalledWith({
      localMemoryEnabled: false,
      localMemoryEnabledSetByUser: true,
    });
    expect(response.result).toEqual({ localMemoryEnabled: false });
  });

  it('opts in to the daily free AI Credits and reports the granted amount', async () => {
    saveDailyCreditDripChoiceMock.mockReset();
    saveDailyCreditDripChoiceMock.mockResolvedValue({
      result: {
        enabled: true,
        decidedAt: '2026-10-06T12:00:00.000Z',
        capCredits: 50,
        balanceCredits: 50,
        granted: 50,
      },
      refreshed: new Promise(() => undefined),
      accountChanged: false,
    });

    const response = await dispatchAppAction({
      requestId: 'req-daily-drip-on',
      source: 'assistant',
      action: { type: 'settings.set_daily_credit_drip', enabled: true },
    });

    expect(saveDailyCreditDripChoiceMock).toHaveBeenCalledWith(true);
    expect(response).toMatchObject({
      ok: true,
      result: { dailyCreditDripEnabled: true, capCredits: 50, granted: 50 },
    });
  });

  it('opts out of the daily free AI Credits without a granted amount', async () => {
    saveDailyCreditDripChoiceMock.mockReset();
    saveDailyCreditDripChoiceMock.mockResolvedValue({
      result: {
        enabled: false,
        decidedAt: '2026-10-06T12:00:00.000Z',
        capCredits: 50,
        balanceCredits: 12,
        granted: 0,
      },
      refreshed: new Promise(() => undefined),
      accountChanged: false,
    });

    const response = await dispatchAppAction({
      requestId: 'req-daily-drip-off',
      source: 'assistant',
      action: { type: 'settings.set_daily_credit_drip', enabled: false },
    });

    expect(saveDailyCreditDripChoiceMock).toHaveBeenCalledWith(false);
    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      dailyCreditDripEnabled: false,
      capCredits: 50,
    });
  });

  it('reports a failed daily free AI Credits save as an execution failure', async () => {
    saveDailyCreditDripChoiceMock.mockReset();
    saveDailyCreditDripChoiceMock.mockRejectedValue(
      new Error('Connect a cloud account to change daily free AI Credits.'),
    );

    const response = await dispatchAppAction({
      requestId: 'req-daily-drip-failure',
      source: 'assistant',
      action: { type: 'settings.set_daily_credit_drip', enabled: true },
    });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'Connect a cloud account to change daily free AI Credits.',
      },
    });
  });

  it('requires a boolean enabled field on the daily free AI Credits action', () => {
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'settings.set_daily_credit_drip',
        enabled: false,
      }),
    ).toBe(true);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'settings.set_daily_credit_drip',
      }),
    ).toBe(false);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'settings.set_daily_credit_drip',
        enabled: 'on',
      }),
    ).toBe(false);
  });

  it('persists the Agents add to the Feed preference through the settings action', async () => {
    savePreferencesMock.mockClear();
    savePreferencesMock.mockResolvedValueOnce({
      ledgerAgentRecordingEnabled: false,
    });

    const response = await dispatchAppAction({
      requestId: 'req-ledger-recording-toggle',
      source: 'assistant',
      action: {
        type: 'settings.set_ledger_agent_recording_enabled',
        enabled: false,
      },
    });

    expect(response.ok).toBe(true);
    expect(savePreferencesMock.mock.calls).toEqual([
      [{ ledgerAgentRecordingEnabled: false }],
    ]);
    expect(response.result).toEqual({ ledgerAgentRecordingEnabled: false });
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'settings.set_ledger_agent_recording_enabled',
        enabled: 'no',
      }),
    ).toBe(false);
  });

  describe('skill suggestion actions (CAN-385)', () => {
    afterEach(() => {
      Reflect.deleteProperty(window, 'skillSuggestions');
      useSkillSuggestionStore.setState({ modalOpen: false });
    });

    it('rejects the settings switch while the flag is off', async () => {
      setFeatureFlagForTest(
        CLIENT_FEATURE_FLAGS.canopyDesktopSkillSuggestions.key,
        false,
      );
      savePreferencesMock.mockClear();
      const response = await dispatchAppAction({
        requestId: 'req-skill-suggestions-off',
        source: 'assistant',
        action: {
          type: 'settings.set_skill_suggestions_enabled',
          enabled: true,
        },
      });
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'surface_unavailable' },
      });
      expect(savePreferencesMock).not.toHaveBeenCalled();
    });

    it('persists the preference while the flag is on', async () => {
      setFeatureFlagForTest(
        CLIENT_FEATURE_FLAGS.canopyDesktopSkillSuggestions.key,
        true,
      );
      savePreferencesMock.mockClear();
      savePreferencesMock.mockResolvedValueOnce({
        skillSuggestionsEnabled: false,
      });
      const response = await dispatchAppAction({
        requestId: 'req-skill-suggestions-toggle',
        source: 'assistant',
        action: {
          type: 'settings.set_skill_suggestions_enabled',
          enabled: false,
        },
      });
      expect(response.ok).toBe(true);
      expect(savePreferencesMock.mock.calls).toEqual([
        [{ skillSuggestionsEnabled: false }],
      ]);
      expect(response.result).toEqual({ skillSuggestionsEnabled: false });
    });

    it('lists suggestions without example requests and opens the modal', async () => {
      setFeatureFlagForTest(
        CLIENT_FEATURE_FLAGS.canopyDesktopSkillSuggestions.key,
        true,
      );
      Object.defineProperty(window, 'skillSuggestions', {
        configurable: true,
        value: {
          list: jest.fn().mockResolvedValue({
            success: true,
            data: [
              {
                id: 'sug-1',
                kind: 'prompt',
                title: 'Summarize review comments',
                occurrenceCount: 4,
                summary: 'Drafts replies to open review threads.',
                proposedSkillName: 'review-replies',
                proposedDescription: 'Draft replies.',
                parameters: ['pr'],
                chainSkills: [],
                examples: ['secret-ish raw prompt text'],
                owner: { kind: 'personal' },
                ownerLabel: 'Personal',
                isPrivate: false,
                lastSeenAt: 1,
                state: 'confirmed',
              },
            ],
          }),
        },
      });
      const listed = await dispatchAppAction({
        requestId: 'req-skill-suggestions-list',
        source: 'assistant',
        action: { type: 'skill_suggestions.list' },
      });
      expect(listed.ok).toBe(true);
      expect(JSON.stringify(listed.result)).not.toContain('raw prompt');
      expect(listed.result).toEqual({
        suggestions: [
          {
            id: 'sug-1',
            kind: 'prompt',
            title: 'Summarize review comments',
            summary: 'Drafts replies to open review threads.',
            proposedSkillName: 'review-replies',
            occurrenceCount: 4,
            chainSkills: [],
            ownerLabel: 'Personal',
          },
        ],
      });

      expect(listed.result).not.toHaveProperty('otherSuggestionCount');

      const opened = await dispatchAppAction({
        requestId: 'req-skill-suggestions-open',
        source: 'assistant',
        action: { type: 'skill_suggestions.open' },
      });
      expect(opened.ok).toBe(true);
      expect(useSkillSuggestionStore.getState().modalOpen).toBe(true);
    });
  });

  it('lists only the active owner suggestions to the agent', async () => {
    setFeatureFlagForTest(
      CLIENT_FEATURE_FLAGS.canopyDesktopSkillSuggestions.key,
      true,
    );
    const suggestion = (
      id: string,
      owner:
        | { kind: 'personal' }
        | { kind: 'organization'; organizationId: string },
      isPrivate = false,
    ): Record<string, unknown> => ({
      id,
      kind: 'prompt',
      title: `Title ${id}`,
      occurrenceCount: 3,
      summary: `Summary ${id}`,
      proposedSkillName: id,
      proposedDescription: 'Draft.',
      parameters: [],
      chainSkills: [],
      examples: [],
      owner,
      ownerLabel: owner.kind === 'personal' ? 'Personal' : 'Acme',
      isPrivate,
      lastSeenAt: 1,
      state: 'confirmed',
    });
    Object.defineProperty(window, 'skillSuggestions', {
      configurable: true,
      value: {
        list: jest.fn().mockResolvedValue({
          success: true,
          data: [
            suggestion('personal-1', { kind: 'personal' }),
            suggestion('private-1', { kind: 'personal' }, true),
            suggestion('org-1', { kind: 'organization', organizationId: 'o1' }),
          ],
        }),
      },
    });
    let call = 0;
    const list = async (): Promise<unknown> =>
      (
        await dispatchAppAction({
          requestId: `req-skill-suggestions-scoped-${(call += 1)}`,
          source: 'assistant',
          action: { type: 'skill_suggestions.list' },
        })
      ).result;
    const activeOwner = jest.spyOn(
      modelPolicyRuntime,
      'getRendererActiveWorkOwner',
    );
    try {
      activeOwner.mockReturnValue(undefined);
      expect(await list()).toMatchObject({
        suggestions: [{ id: 'personal-1' }],
        otherSuggestionCount: 2,
      });
      activeOwner.mockReturnValue({
        kind: 'organization',
        organizationId: 'o1',
      });
      const scoped = await list();
      expect(scoped).toMatchObject({
        suggestions: [{ id: 'org-1' }],
        otherSuggestionCount: 2,
      });
      expect(JSON.stringify(scoped)).not.toContain('Summary personal-1');
    } finally {
      activeOwner.mockRestore();
    }
  });

  it('reports a failed save of the Agents add to the Feed preference', async () => {
    savePreferencesMock.mockRejectedValueOnce(new Error('disk full'));

    const response = await dispatchAppAction({
      requestId: 'req-ledger-recording-toggle-failure',
      source: 'assistant',
      action: {
        type: 'settings.set_ledger_agent_recording_enabled',
        enabled: true,
      },
    });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'execution_failed',
        message: "Couldn't save this setting. Try again.",
      },
    });
  });

  describe('settings.set_launch_at_login (CAN-3449)', () => {
    const osStatus = {
      platform: 'darwin' as const,
      supported: true,
      enabled: false,
      pendingApproval: false,
    };

    function installLaunchAtLogin(setEnabled: jest.Mock): void {
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          ...window.api,
          launchAtLogin: {
            getStatus: jest.fn().mockResolvedValue(osStatus),
            setEnabled,
            openSystemSettings: jest.fn().mockResolvedValue(undefined),
            onStatusChanged: jest.fn().mockReturnValue(() => undefined),
          },
        },
      });
    }

    beforeEach(() => {
      useLaunchAtLoginStore.setState({
        status: null,
        hydrated: false,
        busy: false,
        error: null,
      });
    });

    it('requires a boolean enabled field', () => {
      expect(
        __isValidAppAdvisorActionForTests({
          type: 'settings.set_launch_at_login',
          enabled: false,
        }),
      ).toBe(true);
      expect(
        __isValidAppAdvisorActionForTests({
          type: 'settings.set_launch_at_login',
        }),
      ).toBe(false);
      expect(
        __isValidAppAdvisorActionForTests({
          type: 'settings.set_launch_at_login',
          enabled: 'on',
        }),
      ).toBe(false);
    });

    it('asks the OS through the shared store and reports its read-back', async () => {
      const setEnabled = jest.fn().mockResolvedValue({
        ok: true,
        status: { ...osStatus, pendingApproval: true },
      });
      installLaunchAtLogin(setEnabled);

      const response = await dispatchAppAction({
        requestId: 'req-launch-at-login-on',
        source: 'assistant',
        action: { type: 'settings.set_launch_at_login', enabled: true },
      });

      expect(setEnabled).toHaveBeenCalledWith(true);
      expect(response).toMatchObject({
        requestId: 'req-launch-at-login-on',
        ok: true,
        result: { launchAtLogin: { enabled: false, pendingApproval: true } },
      });
      // An open Settings window reads the same snapshot.
      expect(useLaunchAtLoginStore.getState().status?.pendingApproval).toBe(
        true,
      );
    });

    it('fails clearly when the OS keeps a different state', async () => {
      installLaunchAtLogin(
        jest.fn().mockResolvedValue({
          ok: false,
          reason: 'refused',
          status: { ...osStatus, platform: 'win32' },
        }),
      );

      const response = await dispatchAppAction({
        requestId: 'req-launch-at-login-refused',
        source: 'assistant',
        action: { type: 'settings.set_launch_at_login', enabled: true },
      });

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'execution_failed',
          message:
            'The system kept launch at sign-in off. It may be turned off in Startup apps.',
        },
      });
    });

    it('reports a refused turn-off that leaves a registration waiting for approval as on', async () => {
      installLaunchAtLogin(
        jest.fn().mockResolvedValue({
          ok: false,
          reason: 'refused',
          status: { ...osStatus, enabled: false, pendingApproval: true },
        }),
      );

      const response = await dispatchAppAction({
        requestId: 'req-launch-at-login-refused-off-pending',
        source: 'assistant',
        action: { type: 'settings.set_launch_at_login', enabled: false },
      });

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'execution_failed',
          message:
            'The system kept launch at sign-in on while it waits for approval in System Settings.',
        },
      });
    });

    it('points only a refused turn-on at Startup apps on Windows', async () => {
      installLaunchAtLogin(
        jest.fn().mockResolvedValue({
          ok: false,
          reason: 'refused',
          status: { ...osStatus, platform: 'win32', enabled: true },
        }),
      );

      const response = await dispatchAppAction({
        requestId: 'req-launch-at-login-refused-off-win32',
        source: 'assistant',
        action: { type: 'settings.set_launch_at_login', enabled: false },
      });

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'execution_failed',
          message: 'The system kept launch at sign-in on.',
        },
      });
    });

    it('fails clearly where the OS cannot manage it', async () => {
      installLaunchAtLogin(
        jest.fn().mockResolvedValue({
          ok: false,
          reason: 'unsupported',
          status: {
            ...osStatus,
            supported: false,
            unsupportedReason: 'development-build',
          },
        }),
      );

      const response = await dispatchAppAction({
        requestId: 'req-launch-at-login-unsupported',
        source: 'assistant',
        action: { type: 'settings.set_launch_at_login', enabled: true },
      });

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'missing_capability',
          message:
            'Launch at sign-in is only available in the installed app on macOS and Windows.',
        },
      });
    });

    it('reports a failed round trip', async () => {
      installLaunchAtLogin(jest.fn().mockRejectedValue(new Error('ipc down')));

      const response = await dispatchAppAction({
        requestId: 'req-launch-at-login-failed',
        source: 'assistant',
        action: { type: 'settings.set_launch_at_login', enabled: false },
      });

      expect(response).toMatchObject({
        ok: false,
        error: { code: 'execution_failed', message: 'ipc down' },
      });
    });
  });

  it('validates and persists managed consultation through the settings action', async () => {
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'settings.set_managed_delegation_mode',
        mode: 'proactive',
      }),
    ).toBe(true);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'settings.set_managed_delegation_mode',
        mode: 'always',
      }),
    ).toBe(false);

    savePreferencesMock.mockClear();
    savePreferencesMock.mockResolvedValueOnce({
      ...makeTestPreferences({ managedDelegationMode: 'off' }),
      __managedDelegationRevocationIncomplete: true,
    });
    const response = await dispatchAppAction({
      requestId: 'req-managed-delegation-mode',
      source: 'assistant',
      action: {
        type: 'settings.set_managed_delegation_mode',
        mode: 'off',
      },
    });

    expect(response.ok).toBe(true);
    expect(savePreferencesMock).toHaveBeenCalledWith({
      managedDelegationMode: 'off',
    });
    expect(response.result).toEqual({
      managedDelegationMode: 'off',
      revocationIncomplete: true,
    });
  });

  it('validates and persists managed delegation depth through the settings action', async () => {
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'settings.set_managed_delegation_max_depth',
        maxDepth: 7,
      }),
    ).toBe(true);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'settings.set_managed_delegation_max_depth',
        maxDepth: 11,
      }),
    ).toBe(false);

    savePreferencesMock.mockClear();
    savePreferencesMock.mockResolvedValueOnce({
      ...makeTestPreferences(),
      managedDelegationMaxDepth: 7,
    });
    const response = await dispatchAppAction({
      requestId: 'req-managed-delegation-depth',
      source: 'assistant',
      action: {
        type: 'settings.set_managed_delegation_max_depth',
        maxDepth: 7,
      },
    });

    expect(response.ok).toBe(true);
    expect(savePreferencesMock).toHaveBeenCalledWith({
      managedDelegationMaxDepth: 7,
    });
    expect(response.result).toEqual({ managedDelegationMaxDepth: 7 });
  });

  it('requires a boolean enabled field on the local memory toggle', () => {
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'settings.set_local_memory_enabled',
        enabled: true,
      }),
    ).toBe(true);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'settings.set_local_memory_enabled',
      }),
    ).toBe(false);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'settings.set_local_memory_enabled',
        enabled: 'yes',
      }),
    ).toBe(false);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'settings.open_memory_folder',
      }),
    ).toBe(true);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'memory.import_external',
      }),
    ).toBe(true);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'memory.consolidate_now',
      }),
    ).toBe(true);
  });

  it('sets Personal catalog enrollment through the same Privacy preference API', async (): Promise<void> => {
    setFeatureFlagForTest(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    const save = jest
      .spyOn(window.api, 'savePreferences')
      .mockResolvedValue(makeTestPreferences());
    for (const enabled of [true, false]) {
      const response = await dispatchAppAction({
        requestId: `personal-catalog-${enabled}`,
        source: 'assistant',
        expectedUiRevision: 42,
        action: { type: 'settings.personalCatalog.set', enabled },
      });
      expect(response.ok).toBe(true);
      expect(save).toHaveBeenLastCalledWith({
        personalWorkspaceCatalogSync: enabled ? 'private' : 'off',
        personalCatalogOfferSeen: true,
        personalCatalogNotice: null,
      });
    }
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'settings.personalCatalog.set',
        enabled: 'yes',
      }),
    ).toBe(false);
  });
  it('refuses Personal catalog enrollment without a UI revision', async (): Promise<void> => {
    setFeatureFlagForTest(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    const save = jest.spyOn(window.api, 'savePreferences');
    save.mockClear();
    const response = await dispatchAppAction({
      requestId: 'personal-catalog-missing-revision',
      source: 'assistant',
      action: { type: 'settings.personalCatalog.set', enabled: true },
    });
    expect(response.error?.code).toBe('stale_ui_state');
    expect(save).not.toHaveBeenCalled();
  });
  it('rechecks the Personal catalog UI revision immediately before saving', async (): Promise<void> => {
    setFeatureFlagForTest(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    const save = jest.spyOn(window.api, 'savePreferences');
    save.mockClear();
    const current = useCurrentUiStateStore.getState().getEnvelope();
    const getEnvelope = jest.spyOn(
      useCurrentUiStateStore.getState(),
      'getEnvelope',
    );
    getEnvelope.mockReturnValue({ ...current, revision: 43 });
    getEnvelope.mockReturnValueOnce(current);
    try {
      const response = await dispatchAppAction({
        requestId: 'personal-catalog-revision-changed-before-save',
        source: 'assistant',
        expectedUiRevision: 42,
        action: { type: 'settings.personalCatalog.set', enabled: true },
      });
      expect(response.error?.code).toBe('stale_ui_state');
      expect(save).not.toHaveBeenCalled();
    } finally {
      getEnvelope.mockRestore();
    }
  });
  it('refuses a stale assistant enable after Personal catalog was disabled', async (): Promise<void> => {
    setFeatureFlagForTest(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    const save = jest
      .spyOn(window.api, 'savePreferences')
      .mockResolvedValue(makeTestPreferences());
    const disabled = await dispatchAppAction({
      requestId: 'personal-catalog-disable-current',
      source: 'assistant',
      expectedUiRevision: 42,
      action: { type: 'settings.personalCatalog.set', enabled: false },
    });
    expect(disabled.ok).toBe(true);
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({ personalWorkspaceCatalogSync: 'off' }),
    );
    save.mockClear();
    const stale = await dispatchAppAction({
      requestId: 'personal-catalog-enable-stale',
      source: 'assistant',
      expectedUiRevision: 41,
      action: { type: 'settings.personalCatalog.set', enabled: true },
    });
    expect(stale.error?.code).toBe('stale_ui_state');
    expect(save).not.toHaveBeenCalled();
  });
  it('refuses Personal catalog actions when the flag is off', async (): Promise<void> => {
    setFeatureFlagForTest(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      false,
    );
    const save = jest.spyOn(window.api, 'savePreferences');
    save.mockClear();
    const response = await dispatchAppAction({
      requestId: 'personal-catalog-disabled',
      source: 'assistant',
      action: { type: 'settings.personalCatalog.set', enabled: true },
    });
    expect(response.error?.code).toBe('surface_unavailable');
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a workspace context switch when organization projects are disabled', async (): Promise<void> => {
    setFeatureFlagForTest(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      false,
    );
    const setContext = jest.fn().mockResolvedValue({
      context: { kind: 'personal' },
      revision: 0,
      organizations: [],
    });
    useWorkspaceContextStore.setState({ setContext });

    const response = await dispatchAppAction({
      requestId: 'req-context-switch-disabled',
      source: 'assistant',
      action: {
        type: 'workspace_context.switch',
        context: { kind: 'personal' },
      },
    });

    expect(response.error?.code).toBe('surface_unavailable');
    expect(response.ok).toBe(false);
    expect(setContext).not.toHaveBeenCalled();
  });

  it('switches the workspace context through the main-owned store (CAN-2952)', async () => {
    setFeatureFlagForTest(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'workspace_context.switch',
        context: { kind: 'organization', organizationId: ORG_A },
      }),
    ).toBe(true);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'workspace_context.switch',
        context: { kind: 'team' },
      }),
    ).toBe(false);

    const setContext = jest.fn().mockResolvedValue({
      context: { kind: 'organization', organizationId: ORG_A },
      revision: 2,
      organizations: [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }],
    });
    useWorkspaceContextStore.setState({ setContext });
    const response = await dispatchAppAction({
      requestId: 'req-context-switch',
      source: 'assistant',
      action: {
        type: 'workspace_context.switch',
        context: { kind: 'organization', organizationId: ORG_A },
      },
    });
    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      context: { kind: 'organization', organizationId: ORG_A },
      organizationCount: 1,
    });
    expect(setContext).toHaveBeenCalledWith({
      kind: 'organization',
      organizationId: ORG_A,
    });

    setContext.mockRejectedValueOnce(new Error('stale-revision'));
    const refused = await dispatchAppAction({
      requestId: 'req-context-switch-refused',
      source: 'assistant',
      action: {
        type: 'workspace_context.switch',
        context: { kind: 'personal' },
      },
    });
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe('execution_failed');
  });

  it('reports a failed switch when the account changes during workspace context IPC', async (): Promise<void> => {
    setFeatureFlagForTest(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    useWorkspaceContextStore.setState(
      useWorkspaceContextStore.getInitialState(),
    );
    const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const nextAccount: WorkspaceContextState = {
      context: { kind: 'personal' },
      revision: 0,
      organizations: [],
    };
    const set = jest.fn<Promise<WorkspaceContextState>, [unknown]>(
      (): Promise<WorkspaceContextState> => {
        useWorkspaceContextStore.getState().applyBroadcast({
          ...nextAccount,
          reason: 'account-change',
        });
        return Promise.resolve({
          context: { kind: 'organization', organizationId },
          revision: 9,
          organizations: [{ id: organizationId, name: 'Acme', role: 'MEMBER' }],
        });
      },
    );
    Object.assign(window.api, { workspaceContext: { set } });

    const response = await dispatchAppAction({
      requestId: 'req-context-switch-account-changed',
      source: 'assistant',
      action: {
        type: 'workspace_context.switch',
        context: { kind: 'organization', organizationId },
      },
    });

    expect(set).toHaveBeenCalledTimes(1);
    expect(response.ok).toBe(false);
    expect(response.error).toEqual({
      code: 'execution_failed',
      message: 'The account changed while switching the workspace context.',
    });
    expect(response.result).toBeUndefined();
    expect(useWorkspaceContextStore.getState().state).toEqual(nextAccount);
  });

  it.each([1, 9999, null])(
    'persists the Claude turn limit %s through the settings action',
    async (maxTurns) => {
      savePreferencesMock.mockClear();
      savePreferencesMock.mockResolvedValueOnce(
        makeTestPreferences({ claudeMaxTurns: maxTurns }),
      );
      const response = await dispatchAppAction({
        requestId: 'req-claude-limit',
        source: 'assistant',
        action: { type: 'settings.set_claude_max_turns', maxTurns },
      });
      expect(response.ok).toBe(true);
      expect(savePreferencesMock).toHaveBeenCalledWith({
        claudeMaxTurns: maxTurns,
      });
      expect(response.result).toEqual({ claudeMaxTurns: maxTurns });
    },
  );

  it('reads the saved Claude turn limit through the settings action', async () => {
    loadPreferencesMock.mockResolvedValueOnce(
      makeTestPreferences({ claudeMaxTurns: null }),
    );
    const response = await dispatchAppAction({
      requestId: 'req-read-claude-limit',
      source: 'assistant',
      action: { type: 'settings.get_claude_max_turns' },
    });
    expect(response.ok).toBe(true);
    expect(response.result).toEqual({ claudeMaxTurns: null });
  });

  describe('conversation handoff model', () => {
    beforeEach(() => {
      initClaudeModels([{ id: 'haiku', label: 'Haiku' }]);
    });
    it('reads the independent saved selection', async () => {
      loadPreferencesMock.mockResolvedValueOnce(
        makeTestPreferences({
          handoffSummaryModel: 'gpt-5.5',
          handoffSummaryThinkingLevel: 'high',
        }),
      );
      const response = await dispatchAppAction({
        requestId: 'handoff-read',
        source: 'assistant',
        action: { type: 'settings.get_handoff_model' },
      });
      expect(response).toMatchObject({
        ok: true,
        result: {
          handoffSummaryModel: 'gpt-5.5',
          handoffSummaryThinkingLevel: 'high',
        },
      });
    });

    it('saves only handoff preferences and returns the canonical normalized selection', async () => {
      savePreferencesMock.mockClear();
      loadPreferencesMock.mockResolvedValueOnce(
        makeTestPreferences({ handoffSummaryThinkingLevel: 'high' }),
      );
      savePreferencesMock.mockResolvedValueOnce(
        makeTestPreferences({
          handoffSummaryModel: 'haiku',
          handoffSummaryThinkingLevel: 'off',
        }),
      );
      const response = await dispatchAppAction({
        requestId: 'handoff-save',
        source: 'assistant',
        action: { type: 'settings.set_handoff_model', model: 'haiku' },
      });
      expect(savePreferencesMock).toHaveBeenCalledWith({
        handoffSummaryModel: 'haiku',
        handoffSummaryThinkingLevel: 'high',
      });
      expect(response).toMatchObject({
        ok: true,
        result: {
          handoffSummaryModel: 'haiku',
          handoffSummaryThinkingLevel: 'off',
        },
      });
    });

    it('surfaces preference-store rejection without reporting a saved selection', async () => {
      savePreferencesMock.mockRejectedValueOnce(
        new Error(
          'Choose an available conversation handoff model in Settings.',
        ),
      );
      const response = await dispatchAppAction({
        requestId: 'handoff-unavailable',
        source: 'assistant',
        action: {
          type: 'settings.set_handoff_model',
          model: 'haiku',
          thinkingLevel: 'off',
        },
      });
      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'execution_failed',
          message:
            'Choose an available conversation handoff model in Settings.',
        },
      });
      expect(response.result).toBeUndefined();
    });
    it.each(['cursor-default', 'ollama:not-installed:claude', 'retired-model'])(
      'rejects %s, which the handoff row does not offer, before saving',
      async (model) => {
        savePreferencesMock.mockClear();
        const response = await dispatchAppAction({
          requestId: 'handoff-unavailable',
          source: 'assistant',
          action: { type: 'settings.set_handoff_model', model },
        });
        expect(response).toMatchObject({
          ok: false,
          error: { code: 'invalid_payload' },
        });
        expect(savePreferencesMock).not.toHaveBeenCalled();
      },
    );
  });

  describe('local memory model', () => {
    beforeEach(() => {
      initClaudeModels([
        { id: 'sonnet', label: 'Sonnet' },
        {
          id: 'memory-light',
          label: 'Memory light',
          supportedThinkingLevels: ['off', 'low', 'medium'],
        },
      ]);
      savePreferencesMock.mockClear();
    });

    it('reads the saved model, thinking level, and whether the user chose it', async () => {
      loadPreferencesMock.mockResolvedValueOnce(
        makeTestPreferences({
          localMemoryModel: 'gpt-5.6-luna',
          localMemoryThinkingLevel: 'medium',
          localMemoryModelSetByUser: false,
        }),
      );
      const response = await dispatchAppAction({
        requestId: 'req-read-local-memory-model',
        source: 'assistant',
        action: { type: 'settings.get_local_memory_model' },
      });
      expect(response.ok).toBe(true);
      expect(response.result).toEqual({
        localMemoryModel: 'gpt-5.6-luna',
        localMemoryThinkingLevel: 'medium',
        localMemoryModelSetByUser: false,
      });
    });

    it('saves an aliased model and thinking level as the user’s choice', async () => {
      savePreferencesMock.mockResolvedValueOnce(
        makeTestPreferences({
          localMemoryModel: 'sonnet',
          localMemoryThinkingLevel: 'high',
          localMemoryModelSetByUser: true,
        }),
      );
      const response = await dispatchAppAction({
        requestId: 'req-set-local-memory-model',
        source: 'assistant',
        action: {
          type: 'settings.set_local_memory_model',
          model: 'claude-sonnet-4-6',
          thinkingLevel: 'high',
        },
      });
      expect(response.ok).toBe(true);
      expect(savePreferencesMock).toHaveBeenCalledTimes(1);
      expect(savePreferencesMock).toHaveBeenCalledWith({
        localMemoryModel: 'sonnet',
        localMemoryModelSetByUser: true,
        localMemoryThinkingLevel: 'high',
      });
      expect(response.result).toEqual({
        localMemoryModel: 'sonnet',
        localMemoryThinkingLevel: 'high',
        localMemoryModelSetByUser: true,
      });
    });

    it('keeps the saved thinking level within what the new model supports', async () => {
      loadPreferencesMock.mockResolvedValueOnce(
        makeTestPreferences({ localMemoryThinkingLevel: 'high' }),
      );
      savePreferencesMock.mockResolvedValueOnce(
        makeTestPreferences({
          localMemoryModel: 'memory-light',
          localMemoryThinkingLevel: 'medium',
          localMemoryModelSetByUser: true,
        }),
      );
      const response = await dispatchAppAction({
        requestId: 'req-set-local-memory-model-clamped',
        source: 'assistant',
        action: {
          type: 'settings.set_local_memory_model',
          model: 'memory-light',
        },
      });
      expect(response.ok).toBe(true);
      expect(savePreferencesMock).toHaveBeenCalledWith({
        localMemoryModel: 'memory-light',
        localMemoryModelSetByUser: true,
        localMemoryThinkingLevel: 'medium',
      });
    });

    it.each(['retired-model', 'cursor-default'])(
      'rejects %s, which the Memory model row does not offer, without saving',
      async (model) => {
        const response = await dispatchAppAction({
          requestId: `req-set-local-memory-model-${model}`,
          source: 'assistant',
          action: { type: 'settings.set_local_memory_model', model },
        });
        expect(response.ok).toBe(false);
        expect(response.error).toEqual({
          code: 'invalid_payload',
          message: `Couldn't change the memory model. ${model} isn't an available Claude, Codex, or Ollama model.`,
        });
        expect(savePreferencesMock).not.toHaveBeenCalled();
      },
    );

    it('rejects a thinking level the model does not support without saving', async () => {
      const response = await dispatchAppAction({
        requestId: 'req-set-local-memory-model-unsupported-thinking',
        source: 'assistant',
        action: {
          type: 'settings.set_local_memory_model',
          model: 'memory-light',
          thinkingLevel: 'max',
        },
      });
      expect(response.ok).toBe(false);
      expect(response.error).toEqual({
        code: 'invalid_payload',
        message:
          "Couldn't change the memory model. memory-light supports these thinking levels: off, low, medium.",
      });
      expect(savePreferencesMock).not.toHaveBeenCalled();
    });

    it('rejects a missing model or unknown thinking level before saving', () => {
      expect(
        __isValidAppAdvisorActionForTests({
          type: 'settings.get_local_memory_model',
        }),
      ).toBe(true);
      expect(
        __isValidAppAdvisorActionForTests({
          type: 'settings.set_local_memory_model',
          model: 'sonnet',
          thinkingLevel: 'low',
        }),
      ).toBe(true);
      for (const action of [
        { type: 'settings.set_local_memory_model' },
        { type: 'settings.set_local_memory_model', model: '' },
        {
          type: 'settings.set_local_memory_model',
          model: 'sonnet',
          thinkingLevel: 'extreme',
        },
      ]) {
        expect(__isValidAppAdvisorActionForTests(action)).toBe(false);
      }
    });
  });

  it('rejects an invalid Claude turn limit before saving', () => {
    for (const maxTurns of [0, -1, 1.5, 10000, '500', undefined]) {
      expect(
        __isValidAppAdvisorActionForTests({
          type: 'settings.set_claude_max_turns',
          maxTurns,
        }),
      ).toBe(false);
    }
  });

  it('validates and persists the navigation mode through the settings action', async () => {
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'settings.set_navigation_mode',
        mode: 'work',
      }),
    ).toBe(true);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'settings.set_navigation_mode',
        mode: 'advanced',
      }),
    ).toBe(false);

    savePreferencesMock.mockClear();
    savePreferencesMock.mockResolvedValueOnce(
      makeTestPreferences({ navigationMode: 'work' }),
    );
    const response = await dispatchAppAction({
      requestId: 'req-navigation-mode',
      source: 'assistant',
      action: { type: 'settings.set_navigation_mode', mode: 'work' },
    });
    expect(response.ok).toBe(true);
    expect(savePreferencesMock).toHaveBeenCalledWith({
      navigationMode: 'work',
    });
    expect(response.result).toEqual({ navigationMode: 'work' });
  });

  it('persists the profile role through the settings action', async () => {
    savePreferencesMock.mockClear();
    savePreferencesMock.mockResolvedValueOnce(
      makeTestPreferences({ profileRole: 'designer' }),
    );

    const response = await dispatchAppAction({
      requestId: 'req-profile-role',
      source: 'assistant',
      action: { type: 'settings.set_profile_role', role: 'designer' },
    });

    expect(response.ok).toBe(true);
    // A non-'other' role clears the detail, mirroring the settings section
    // and the onboarding wizard.
    expect(savePreferencesMock).toHaveBeenCalledWith({
      profileRole: 'designer',
      profileRoles: ['designer'],
      profileRoleDetail: '',
    });
    expect(response.result).toEqual({
      profileRole: 'designer',
      profileRoleDetail: null,
    });
  });

  it('keeps the profile role detail only for the other role', async () => {
    savePreferencesMock.mockClear();
    savePreferencesMock.mockResolvedValueOnce(
      makeTestPreferences({
        profileRole: 'other',
        profileRoleDetail: 'Technical writer',
      }),
    );

    const response = await dispatchAppAction({
      requestId: 'req-profile-role-other',
      source: 'assistant',
      action: {
        type: 'settings.set_profile_role',
        role: 'other',
        roleDetail: 'Technical writer',
      },
    });

    expect(response.ok).toBe(true);
    expect(savePreferencesMock).toHaveBeenCalledWith({
      profileRole: 'other',
      profileRoles: ['other'],
      profileRoleDetail: 'Technical writer',
    });

    savePreferencesMock.mockClear();
    savePreferencesMock.mockResolvedValueOnce(
      makeTestPreferences({ profileRole: 'student' }),
    );
    await dispatchAppAction({
      requestId: 'req-profile-role-drop-detail',
      source: 'assistant',
      action: {
        type: 'settings.set_profile_role',
        role: 'student',
        roleDetail: 'ignored',
      },
    });
    expect(savePreferencesMock).toHaveBeenCalledWith({
      profileRole: 'student',
      profileRoles: ['student'],
      profileRoleDetail: '',
    });
  });

  it('leaves an existing description alone when other is set without a detail', async () => {
    savePreferencesMock.mockClear();
    savePreferencesMock.mockResolvedValueOnce(
      makeTestPreferences({
        profileRole: 'other',
        profileRoleDetail: 'Technical writer',
      }),
    );

    await dispatchAppAction({
      requestId: 'req-profile-role-other-no-detail',
      source: 'assistant',
      action: { type: 'settings.set_profile_role', role: 'other' },
    });

    // Omitting the key preserves the stored description: "set my role to
    // other" must not silently wipe text the user wrote.
    expect(savePreferencesMock).toHaveBeenCalledWith({
      profileRole: 'other',
      profileRoles: ['other'],
    });

    savePreferencesMock.mockClear();
    savePreferencesMock.mockResolvedValueOnce(
      makeTestPreferences({ profileRole: 'other' }),
    );
    await dispatchAppAction({
      requestId: 'req-profile-role-other-clear-detail',
      source: 'assistant',
      action: {
        type: 'settings.set_profile_role',
        role: 'other',
        roleDetail: '',
      },
    });
    // An explicit empty string still clears it.
    expect(savePreferencesMock).toHaveBeenCalledWith({
      profileRole: 'other',
      profileRoles: ['other'],
      profileRoleDetail: '',
    });
  });

  it('requires a known role on the profile role action', () => {
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'settings.set_profile_role',
        role: 'software-engineer',
      }),
    ).toBe(true);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'settings.set_profile_role',
        role: 'other',
        roleDetail: 'Technical writer',
      }),
    ).toBe(true);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'settings.set_profile_role',
      }),
    ).toBe(false);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'settings.set_profile_role',
        role: 'astronaut',
      }),
    ).toBe(false);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'settings.set_profile_role',
        role: 'other',
        roleDetail: 42,
      }),
    ).toBe(false);
  });

  it('opens the local memory folder through the settings action', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-local-memory-folder',
      source: 'assistant',
      action: { type: 'settings.open_memory_folder' },
    });

    expect(response.ok).toBe(true);
    expect(openMemoryDirMock).toHaveBeenCalledTimes(1);
  });

  it('imports external memory for the currently selected project', async () => {
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
    });

    const response = await dispatchAppAction({
      requestId: 'req-local-memory-import',
      source: 'assistant',
      action: { type: 'memory.import_external' },
    });

    expect(response.ok).toBe(true);
    expect(importClaudeMemoryMock).toHaveBeenCalledWith({
      workspaceId: 'project-1',
    });
    expect(response.result).toEqual({
      disabled: false,
      staged: 1,
      skipped: 0,
      deferred: 0,
      errors: [],
    });
  });

  it('consolidates only the user scope when a chat sentinel is selected', async () => {
    consolidateLocalMemoryMock.mockClear();
    useChatStore.setState({
      selectedWorktree: {
        projectId: STANDALONE_CHAT_PROJECT_ID,
        worktreeId: 'standalone-1',
      },
    });
    const status = {
      pendingNotes: 0,
      running: false,
      lastRunAt: '2026-09-10T10:00:00.000Z',
      lastResult: 'success',
      lastReason: null,
      lastConsolidatedAt: '2026-09-10T10:00:00.000Z',
    };
    consolidateLocalMemoryMock.mockResolvedValue(status);

    const response = await dispatchAppAction({
      requestId: 'req-local-memory-consolidate-sentinel',
      source: 'assistant',
      action: { type: 'memory.consolidate_now' },
    });

    expect(response.ok).toBe(true);
    expect(consolidateLocalMemoryMock).toHaveBeenCalledTimes(1);
    expect(consolidateLocalMemoryMock).toHaveBeenCalledWith({ scope: 'user' });
    expect(response.result).toEqual({ user: status, workspace: null });
  });

  it('consolidates user and selected-project memory through the settings action', async () => {
    consolidateLocalMemoryMock.mockClear();
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
    });
    const status = {
      pendingNotes: 0,
      running: false,
      lastRunAt: '2026-09-10T10:00:00.000Z',
      lastResult: 'success',
      lastReason: null,
      lastConsolidatedAt: '2026-09-10T10:00:00.000Z',
    };
    consolidateLocalMemoryMock.mockResolvedValue(status);

    const response = await dispatchAppAction({
      requestId: 'req-local-memory-consolidate',
      source: 'assistant',
      action: { type: 'memory.consolidate_now' },
    });

    expect(response.ok).toBe(true);
    expect(consolidateLocalMemoryMock).toHaveBeenNthCalledWith(1, {
      scope: 'user',
    });
    expect(consolidateLocalMemoryMock).toHaveBeenNthCalledWith(2, {
      scope: 'workspace',
      workspaceId: 'project-1',
    });
    expect(response.result).toEqual({ user: status, workspace: status });
  });

  describe('memory.rebuild', () => {
    const rebuildResponse = {
      rebuild: {
        status: 'stopped',
        reason: 'no-progress',
        snapshotId: '2026-09-30T12-00-00-000Z-0123abcd',
        restoredInboxNotes: 12,
        restoredImports: 2,
        runs: 3,
      },
      status: {
        pendingNotes: 4,
        running: false,
        rebuilding: false,
        lastRunAt: '2026-09-30T12:05:00.000Z',
        lastResult: 'success',
        lastReason: null,
        lastConsolidatedAt: '2026-09-30T12:05:00.000Z',
      },
    };

    beforeEach(() => {
      rebuildLocalMemoryMock.mockReset();
      rebuildLocalMemoryMock.mockResolvedValue(rebuildResponse);
      useProjectsStore.setState({
        projects: [makeWorkspace()],
        hasHydratedProjects: true,
      });
    });

    it('rebuilds the named project even when another project is selected', async () => {
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-2', worktreeId: 'worktree-9' },
      });

      const response = await dispatchAppAction({
        requestId: 'req-local-memory-rebuild',
        source: 'assistant',
        expectedUiRevision: 42,
        action: {
          type: 'memory.rebuild',
          scope: 'workspace',
          workspaceId: 'project-1',
        },
      });

      expect(rebuildLocalMemoryMock).toHaveBeenCalledWith({
        scope: 'workspace',
        workspaceId: 'project-1',
      });
      expect(response).toMatchObject({
        ok: true,
        result: {
          status: 'stopped',
          reason: 'no-progress',
          snapshotId: '2026-09-30T12-00-00-000Z-0123abcd',
          restoredInboxNotes: 12,
          restoredImports: 2,
          runs: 3,
          pendingNotes: 4,
          lastResult: 'success',
          lastReason: null,
        },
      });
    });

    it.each([
      ['a stale UI revision', 41],
      ['no UI revision', undefined],
    ])('refuses %s without rebuilding', async (_label, revision) => {
      const response = await dispatchAppAction({
        requestId: `req-local-memory-rebuild-stale-${String(revision)}`,
        source: 'assistant',
        ...(revision === undefined ? {} : { expectedUiRevision: revision }),
        action: { type: 'memory.rebuild', scope: 'user' },
      });

      expect(response).toMatchObject({
        ok: false,
        error: { code: 'stale_ui_state' },
      });
      expect(rebuildLocalMemoryMock).not.toHaveBeenCalled();
    });

    it('refuses a project that no longer exists', async () => {
      const response = await dispatchAppAction({
        requestId: 'req-local-memory-rebuild-missing',
        source: 'assistant',
        expectedUiRevision: 42,
        action: {
          type: 'memory.rebuild',
          scope: 'workspace',
          workspaceId: 'project-removed',
        },
      });

      expect(response).toMatchObject({
        ok: false,
        error: { code: 'not_found' },
      });
      expect(rebuildLocalMemoryMock).not.toHaveBeenCalled();
    });

    it('requires a project id for a project rebuild, and only then', () => {
      for (const action of [
        { type: 'memory.rebuild' },
        { type: 'memory.rebuild', scope: 'organization' },
        { type: 'memory.rebuild', scope: 'workspace' },
        {
          type: 'memory.rebuild',
          scope: 'workspace',
          workspaceId: STANDALONE_CHAT_PROJECT_ID,
        },
        { type: 'memory.rebuild', scope: 'user', workspaceId: 'project-1' },
      ]) {
        expect(__isValidAppAdvisorActionForTests(action)).toBe(false);
      }
      expect(
        __isValidAppAdvisorActionForTests({
          type: 'memory.rebuild',
          scope: 'workspace',
          workspaceId: 'project-1',
        }),
      ).toBe(true);
      expect(
        __isValidAppAdvisorActionForTests({
          type: 'memory.rebuild',
          scope: 'user',
        }),
      ).toBe(true);
    });
  });

  describe('memory.list_snapshots', () => {
    const snapshots = [
      {
        id: '2026-09-30T12-00-00-000Z-0123abcd',
        createdAt: '2026-09-30T12:00:00.000Z',
        reason: 'rebuild',
        topicCount: 3,
      },
      {
        id: '2026-09-29T08-30-00-000Z-89abcdef',
        createdAt: '2026-09-29T08:30:00.000Z',
        reason: 'consolidation',
        topicCount: 2,
      },
    ];

    beforeEach(() => {
      listLocalMemorySnapshotsMock.mockReset();
      listLocalMemorySnapshotsMock.mockResolvedValue(snapshots);
      useProjectsStore.setState({
        projects: [makeWorkspace()],
        hasHydratedProjects: true,
      });
    });

    it('lists the named project snapshots without a UI revision', async () => {
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-2', worktreeId: 'worktree-9' },
      });

      const response = await dispatchAppAction({
        requestId: 'req-local-memory-list-snapshots',
        source: 'assistant',
        action: {
          type: 'memory.list_snapshots',
          scope: 'workspace',
          workspaceId: 'project-1',
        },
      });

      expect(listLocalMemorySnapshotsMock).toHaveBeenCalledWith({
        scope: 'workspace',
        workspaceId: 'project-1',
      });
      expect(response).toMatchObject({ ok: true, result: { snapshots } });
    });

    it('lists user snapshots even with a stale UI revision', async () => {
      const response = await dispatchAppAction({
        requestId: 'req-local-memory-list-snapshots-user',
        source: 'assistant',
        expectedUiRevision: 41,
        action: { type: 'memory.list_snapshots', scope: 'user' },
      });

      expect(listLocalMemorySnapshotsMock).toHaveBeenCalledWith({
        scope: 'user',
      });
      expect(response).toMatchObject({ ok: true, result: { snapshots } });
    });

    it('refuses a project that no longer exists', async () => {
      const response = await dispatchAppAction({
        requestId: 'req-local-memory-list-snapshots-missing',
        source: 'assistant',
        action: {
          type: 'memory.list_snapshots',
          scope: 'workspace',
          workspaceId: 'project-removed',
        },
      });

      expect(response).toMatchObject({
        ok: false,
        error: { code: 'not_found' },
      });
      expect(listLocalMemorySnapshotsMock).not.toHaveBeenCalled();
    });

    it('reports a failed list as an execution failure', async () => {
      listLocalMemorySnapshotsMock.mockRejectedValueOnce(
        new Error('Could not read memory snapshots.'),
      );

      const response = await dispatchAppAction({
        requestId: 'req-local-memory-list-snapshots-failure',
        source: 'assistant',
        action: { type: 'memory.list_snapshots', scope: 'user' },
      });

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'execution_failed',
          message: 'Could not read memory snapshots.',
        },
      });
    });

    it('requires a project id for a project list, and only then', () => {
      for (const action of [
        { type: 'memory.list_snapshots' },
        { type: 'memory.list_snapshots', scope: 'organization' },
        { type: 'memory.list_snapshots', scope: 'workspace' },
        {
          type: 'memory.list_snapshots',
          scope: 'workspace',
          workspaceId: STANDALONE_CHAT_PROJECT_ID,
        },
        {
          type: 'memory.list_snapshots',
          scope: 'user',
          workspaceId: 'project-1',
        },
      ]) {
        expect(__isValidAppAdvisorActionForTests(action)).toBe(false);
      }
      expect(
        __isValidAppAdvisorActionForTests({
          type: 'memory.list_snapshots',
          scope: 'workspace',
          workspaceId: 'project-1',
        }),
      ).toBe(true);
      expect(
        __isValidAppAdvisorActionForTests({
          type: 'memory.list_snapshots',
          scope: 'user',
        }),
      ).toBe(true);
    });
  });

  describe('memory.restore_snapshot', () => {
    const snapshotId = '2026-09-30T12-00-00-000Z-0123abcd';

    beforeEach(() => {
      restoreLocalMemorySnapshotMock.mockReset();
      restoreLocalMemorySnapshotMock.mockResolvedValue({
        status: 'restored',
        previousSnapshotId: '2026-10-01T09-00-00-000Z-fedcba98',
      });
      useProjectsStore.setState({
        projects: [makeWorkspace()],
        hasHydratedProjects: true,
      });
    });

    it('restores the named project even when another project is selected', async () => {
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-2', worktreeId: 'worktree-9' },
      });

      const response = await dispatchAppAction({
        requestId: 'req-local-memory-restore',
        source: 'assistant',
        expectedUiRevision: 42,
        action: {
          type: 'memory.restore_snapshot',
          scope: 'workspace',
          workspaceId: 'project-1',
          snapshotId,
        },
      });

      expect(restoreLocalMemorySnapshotMock).toHaveBeenCalledWith({
        scope: 'workspace',
        workspaceId: 'project-1',
        snapshotId,
      });
      expect(response).toMatchObject({
        ok: true,
        result: {
          status: 'restored',
          reason: null,
          previousSnapshotId: '2026-10-01T09-00-00-000Z-fedcba98',
        },
      });
    });

    it('reports a skipped restore with its reason', async () => {
      restoreLocalMemorySnapshotMock.mockResolvedValueOnce({
        status: 'skipped',
        reason: 'already-running',
        previousSnapshotId: null,
      });

      const response = await dispatchAppAction({
        requestId: 'req-local-memory-restore-skipped',
        source: 'assistant',
        expectedUiRevision: 42,
        action: { type: 'memory.restore_snapshot', scope: 'user', snapshotId },
      });

      expect(restoreLocalMemorySnapshotMock).toHaveBeenCalledWith({
        scope: 'user',
        snapshotId,
      });
      expect(response).toMatchObject({
        ok: true,
        result: {
          status: 'skipped',
          reason: 'already-running',
          previousSnapshotId: null,
        },
      });
    });

    it.each([
      ['a stale UI revision', 41],
      ['no UI revision', undefined],
    ])('refuses %s without restoring', async (_label, revision) => {
      const response = await dispatchAppAction({
        requestId: `req-local-memory-restore-stale-${String(revision)}`,
        source: 'assistant',
        ...(revision === undefined ? {} : { expectedUiRevision: revision }),
        action: { type: 'memory.restore_snapshot', scope: 'user', snapshotId },
      });

      expect(response).toMatchObject({
        ok: false,
        error: { code: 'stale_ui_state' },
      });
      expect(restoreLocalMemorySnapshotMock).not.toHaveBeenCalled();
    });

    it('refuses a project that no longer exists', async () => {
      const response = await dispatchAppAction({
        requestId: 'req-local-memory-restore-missing',
        source: 'assistant',
        expectedUiRevision: 42,
        action: {
          type: 'memory.restore_snapshot',
          scope: 'workspace',
          workspaceId: 'project-removed',
          snapshotId,
        },
      });

      expect(response).toMatchObject({
        ok: false,
        error: { code: 'not_found' },
      });
      expect(restoreLocalMemorySnapshotMock).not.toHaveBeenCalled();
    });

    it('reports a failed restore as an execution failure', async () => {
      restoreLocalMemorySnapshotMock.mockRejectedValueOnce(
        new Error('Choose a memory snapshot.'),
      );

      const response = await dispatchAppAction({
        requestId: 'req-local-memory-restore-failure',
        source: 'assistant',
        expectedUiRevision: 42,
        action: { type: 'memory.restore_snapshot', scope: 'user', snapshotId },
      });

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'execution_failed',
          message: 'Choose a memory snapshot.',
        },
      });
    });

    it('requires a snapshot id, and a project id exactly for a project restore', () => {
      for (const action of [
        { type: 'memory.restore_snapshot', snapshotId },
        { type: 'memory.restore_snapshot', scope: 'user' },
        { type: 'memory.restore_snapshot', scope: 'user', snapshotId: '' },
        { type: 'memory.restore_snapshot', scope: 'user', snapshotId: 42 },
        {
          type: 'memory.restore_snapshot',
          scope: 'organization',
          snapshotId,
        },
        { type: 'memory.restore_snapshot', scope: 'workspace', snapshotId },
        {
          type: 'memory.restore_snapshot',
          scope: 'workspace',
          workspaceId: STANDALONE_CHAT_PROJECT_ID,
          snapshotId,
        },
        {
          type: 'memory.restore_snapshot',
          scope: 'user',
          workspaceId: 'project-1',
          snapshotId,
        },
      ]) {
        expect(__isValidAppAdvisorActionForTests(action)).toBe(false);
      }
      expect(
        __isValidAppAdvisorActionForTests({
          type: 'memory.restore_snapshot',
          scope: 'workspace',
          workspaceId: 'project-1',
          snapshotId,
        }),
      ).toBe(true);
      expect(
        __isValidAppAdvisorActionForTests({
          type: 'memory.restore_snapshot',
          scope: 'user',
          snapshotId,
        }),
      ).toBe(true);
    });
  });

  it('reports a failed local memory folder open as an execution failure', async () => {
    openMemoryDirMock.mockRejectedValueOnce(
      new Error('Could not open memory folder: boom'),
    );

    const response = await dispatchAppAction({
      requestId: 'req-local-memory-folder-failure',
      source: 'assistant',
      action: { type: 'settings.open_memory_folder' },
    });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'Could not open memory folder: boom',
      },
    });
  });

  it('opens a project Code Graph detail panel through navigation', async () => {
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
    });

    const response = await dispatchAppAction({
      requestId: 'req-open-code-graph',
      source: 'assistant',
      expectedUiRevision: 99,
      action: {
        type: 'navigation.open_code_graph',
        workspaceId: 'project-1',
      },
    });

    expect(response.ok).toBe(true);
    expect(useNavigationStore.getState().pendingWorkspaceSettings).toEqual({
      workspaceId: 'project-1',
      initialTab: 'code-graph',
    });
  });

  describe('navigation.open_editor_setup (CAN-2053)', () => {
    beforeEach(() => {
      useRepoRulesModalStore.setState({ target: null, openCount: 0 });
    });

    it('opens the Cursor rules review for the requested project', async () => {
      useProjectsStore.setState({
        projects: [makeWorkspace()],
        hasHydratedProjects: true,
      });

      const response = await dispatchAppAction({
        requestId: 'req-open-editor-setup',
        source: 'assistant',
        action: {
          type: 'navigation.open_editor_setup',
          workspaceId: 'project-1',
        },
      });

      expect(response.ok).toBe(true);
      expect(useRepoRulesModalStore.getState().target).toEqual({
        source: 'app-advisor',
        workspaceId: 'project-1',
      });
    });

    it('lets the member choose the project when none is named', async () => {
      const response = await dispatchAppAction({
        requestId: 'req-open-editor-setup-unscoped',
        source: 'assistant',
        action: { type: 'navigation.open_editor_setup' },
      });

      expect(response.ok).toBe(true);
      expect(useRepoRulesModalStore.getState().target).toEqual({
        source: 'app-advisor',
      });
    });

    it.each([
      { label: 'an unknown project', workspaceId: 'missing-project' },
      { label: 'a Cowork project', workspaceId: 'cowork-1' },
    ])('rejects $label without opening the review', async ({ workspaceId }) => {
      useProjectsStore.setState({
        projects: [
          makeWorkspace(),
          {
            type: 'cowork',
            id: 'cowork-1',
            name: 'Cowork One',
            color: '#333333',
            collapsed: false,
            order: 0,
          },
        ],
        hasHydratedProjects: true,
      });

      const response = await dispatchAppAction({
        requestId: 'req-open-editor-setup-rejected',
        source: 'assistant',
        action: { type: 'navigation.open_editor_setup', workspaceId },
      });

      expect(response).toMatchObject({
        ok: false,
        error: { code: 'not_found' },
      });
      expect(useRepoRulesModalStore.getState().target).toBeNull();
    });

    it('rejects an empty project id during validation', async () => {
      const response = await dispatchAppAction({
        requestId: 'req-open-editor-setup-empty',
        source: 'assistant',
        action: { type: 'navigation.open_editor_setup', workspaceId: '' },
      });

      expect(response).toMatchObject({
        ok: false,
        error: { code: 'invalid_payload' },
      });
      expect(useRepoRulesModalStore.getState().target).toBeNull();
    });
  });

  it('opens project settings on a requested tab through navigation', async () => {
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
    });

    const response = await dispatchAppAction({
      requestId: 'req-open-workspace-settings',
      source: 'assistant',
      action: {
        type: 'navigation.open_workspace_settings',
        workspaceId: 'project-1',
        tab: 'environment',
      },
    });

    expect(response.ok).toBe(true);
    expect(useNavigationStore.getState().pendingWorkspaceSettings).toEqual({
      workspaceId: 'project-1',
      initialTab: 'environment',
    });
  });

  it('normalizes omitted project settings tabs to General', async () => {
    useProjectsStore.setState({
      projects: [makeMultiRepoWorkspace()],
      hasHydratedProjects: true,
    });

    const response = await dispatchAppAction({
      requestId: 'req-open-workspace-settings-default',
      source: 'assistant',
      action: {
        type: 'navigation.open_workspace_settings',
        workspaceId: 'workspace-1',
      },
    });

    expect(response.ok).toBe(true);
    expect(useNavigationStore.getState().pendingWorkspaceSettings).toEqual({
      workspaceId: 'workspace-1',
      initialTab: 'details',
    });
  });

  it('rejects project settings tabs unavailable for the project type', async () => {
    useNavigationStore.setState({ pendingWorkspaceSettings: undefined });
    useProjectsStore.setState({
      projects: [
        {
          type: 'cowork',
          id: 'cowork-1',
          name: 'Cowork One',
          color: '#333333',
          collapsed: false,
          order: 0,
        },
      ],
      hasHydratedProjects: true,
    });

    const response = await dispatchAppAction({
      requestId: 'req-open-cowork-repositories',
      source: 'assistant',
      action: {
        type: 'navigation.open_workspace_settings',
        workspaceId: 'cowork-1',
        tab: 'repositories',
      },
    });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_target',
        message: 'Repositories settings are not available for this project.',
      },
    });
    expect(
      useNavigationStore.getState().pendingWorkspaceSettings,
    ).toBeUndefined();
  });

  it('rejects Repositories settings for single-repo projects', async () => {
    useNavigationStore.setState({ pendingWorkspaceSettings: undefined });
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
    });

    const response = await dispatchAppAction({
      requestId: 'req-open-project-repositories',
      source: 'assistant',
      action: {
        type: 'navigation.open_workspace_settings',
        workspaceId: 'project-1',
        tab: 'repositories',
      },
    });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_target',
        message: 'Repositories settings are not available for this project.',
      },
    });
    expect(
      useNavigationStore.getState().pendingWorkspaceSettings,
    ).toBeUndefined();
  });

  it('rejects Code Graph project settings while the feature is disabled', async () => {
    useNavigationStore.setState({ pendingWorkspaceSettings: undefined });
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
    });
    setFeatureFlagForTest(
      CLIENT_FEATURE_FLAGS.canopyDesktopWorkspaceCodeGraph.key,
      false,
    );

    const response = await dispatchAppAction({
      requestId: 'req-open-workspace-code-graph-disabled',
      source: 'assistant',
      action: {
        type: 'navigation.open_workspace_settings',
        workspaceId: 'project-1',
        tab: 'code-graph',
      },
    });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'surface_unavailable',
        message: 'Code Graph is not available.',
      },
    });
    expect(
      useNavigationStore.getState().pendingWorkspaceSettings,
    ).toBeUndefined();
  });

  it('rejects Code Graph navigation while the feature is disabled', async () => {
    useNavigationStore.setState({ pendingWorkspaceSettings: undefined });
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
    });
    setFeatureFlagForTest(
      CLIENT_FEATURE_FLAGS.canopyDesktopWorkspaceCodeGraph.key,
      false,
    );

    const response = await dispatchAppAction({
      requestId: 'req-open-code-graph-disabled',
      source: 'assistant',
      action: {
        type: 'navigation.open_code_graph',
        workspaceId: 'project-1',
      },
    });

    expect(response).toMatchObject({
      requestId: 'req-open-code-graph-disabled',
      ok: false,
      error: {
        code: 'surface_unavailable',
        message: 'Code Graph is not available.',
      },
    });
    expect(
      useNavigationStore.getState().pendingWorkspaceSettings,
    ).toBeUndefined();
  });

  it('accepts navigation to the advertised Labs settings section', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-settings-experiments',
      source: 'assistant',
      action: { type: 'navigation.open_settings', section: 'experiments' },
    });

    expect(response.ok).toBe(true);
    expect(useNavigationStore.getState().settingsInitialSection).toBe(
      'experiments',
    );
  });

  it('accepts navigation to the advertised Code Graph settings section', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-settings-code-graph',
      source: 'assistant',
      action: { type: 'navigation.open_settings', section: 'code-graph' },
    });

    expect(response.ok).toBe(true);
    expect(useNavigationStore.getState().settingsInitialSection).toBe(
      'code-graph',
    );
  });

  it('accepts navigation to the advertised Approvals settings section', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-settings-approvals',
      source: 'assistant',
      action: { type: 'navigation.open_settings', section: 'approvals' },
    });

    expect(response.ok).toBe(true);
    expect(useNavigationStore.getState().settingsInitialSection).toBe(
      'approvals',
    );
  });

  it('opens the Instructions settings section', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-settings-instructions',
      source: 'assistant',
      action: { type: 'navigation.open_settings', section: 'instructions' },
    });

    expect(response.ok).toBe(true);
    expect(useNavigationStore.getState().settingsInitialSection).toBe(
      'instructions',
    );
  });

  it('opens the Harnesses settings section', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-settings-harnesses',
      source: 'assistant',
      action: { type: 'navigation.open_settings', section: 'harnesses' },
    });

    expect(response.ok).toBe(true);
    expect(useNavigationStore.getState().settingsOpen).toBe(true);
    expect(useNavigationStore.getState().settingsInitialSection).toBe(
      'harnesses',
    );
  });

  it('opens the Plugins settings section', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-settings-plugins',
      source: 'assistant',
      action: { type: 'navigation.open_settings', section: 'plugins' },
    });

    expect(response.ok).toBe(true);
    expect(useNavigationStore.getState().settingsOpen).toBe(true);
    expect(useNavigationStore.getState().settingsInitialSection).toBe(
      'plugins',
    );
  });

  it('opens the Terminal settings section', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-settings-terminal',
      source: 'assistant',
      action: { type: 'navigation.open_settings', section: 'terminal' },
    });

    expect(response.ok).toBe(true);
    expect(useNavigationStore.getState().settingsOpen).toBe(true);
    expect(useNavigationStore.getState().settingsInitialSection).toBe(
      'terminal',
    );
  });

  it('allows navigation to Claude settings on Windows when terminal features are disabled', async () => {
    setRendererPlatform('win32');
    setFeatureFlagForTest(
      CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiChats.key,
      false,
    );
    setFeatureFlagForTest(
      CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.key,
      false,
    );

    const response = await dispatchAppAction({
      requestId: 'req-settings-claude-windows-turn-limits',
      source: 'assistant',
      action: { type: 'navigation.open_settings', section: 'claude' },
    });

    expect(response.ok).toBe(true);
    expect(useNavigationStore.getState().settingsOpen).toBe(true);
    expect(useNavigationStore.getState().settingsInitialSection).toBe('claude');
  });

  it('allows navigation to Claude settings when a Claude settings section is visible', async () => {
    setRendererPlatform('darwin');
    setFeatureFlagForTest(
      CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiChats.key,
      false,
    );
    setFeatureFlagForTest(
      CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.key,
      false,
    );

    const response = await dispatchAppAction({
      requestId: 'req-settings-claude-native-caffeinate',
      source: 'assistant',
      action: { type: 'navigation.open_settings', section: 'claude' },
    });

    expect(response.ok).toBe(true);
    expect(useNavigationStore.getState().settingsOpen).toBe(true);
    expect(useNavigationStore.getState().settingsInitialSection).toBe('claude');
  });

  describe('pages that are switched off (CAN-3661)', () => {
    const DEV_PAGES = [
      'notice-states',
      'header-states',
      'worktree-states',
      'activity-states',
      'message-bubble-states',
      'change-review',
    ] as const;

    function setDevBuild(isDev: boolean): void {
      Object.defineProperty(window, 'devInfo', {
        configurable: true,
        value: { isDev },
      });
    }

    beforeEach(() => {
      setDevBuild(false);
      useNavigationStore.setState({
        activePage: 'pipelines',
        homeComposerFocusRequest: 0,
        pendingWorkerHighlight: 'worker-1',
        pendingAutomationReveal: {
          activityId: 'activity-1',
          outcome: 'installed',
        },
      });
    });

    afterEach(() => {
      Reflect.deleteProperty(window, 'devInfo');
      useNavigationStore.setState({
        pendingWorkerHighlight: undefined,
        pendingAutomationReveal: undefined,
      });
    });

    function expectNavigationUntouched(): void {
      const state = useNavigationStore.getState();
      expect(state.activePage).toBe('pipelines');
      expect(state.homeComposerFocusRequest).toBe(0);
      expect(state.pendingWorkerHighlight).toBe('worker-1');
      expect(state.pendingAutomationReveal).toEqual({
        activityId: 'activity-1',
        outcome: 'installed',
      });
    }

    it.each([
      {
        page: 'workers' as const,
        flag: CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.key,
        message: "The Claude workers page isn't available right now.",
      },
      {
        page: 'feed' as const,
        flag: CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key,
        message: "The Feed page isn't available right now.",
      },
    ])(
      'refuses navigation.go_to_page for $page with a reason and no side effects',
      async ({ page, flag, message }) => {
        setFeatureFlagForTest(flag, false);

        const response = await dispatchAppAction({
          requestId: `req-${page}-unavailable`,
          source: 'assistant',
          action: { type: 'navigation.go_to_page', page },
        });

        expect(response.ok).toBe(false);
        expect(response.error).toEqual({
          code: 'surface_unavailable',
          message,
        });
        expectNavigationUntouched();
      },
    );

    it.each(DEV_PAGES)(
      'refuses navigation.go_to_page for %s outside a development build',
      async (page) => {
        const response = await dispatchAppAction({
          requestId: `req-${page}-unavailable`,
          source: 'assistant',
          action: { type: 'navigation.go_to_page', page },
        });

        expect(response.ok).toBe(false);
        expect(response.error?.code).toBe('surface_unavailable');
        expect(response.error?.message).toMatch(
          /isn't enabled in this build or development configuration\.$/,
        );
        expectNavigationUntouched();
      },
    );

    it('refuses agents.open_manager when Agents is switched off', async () => {
      setFeatureFlagForTest(
        CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key,
        false,
      );
      useNavigationStore.setState({ pendingPluginsNavigation: undefined });

      const response = await dispatchAppAction({
        requestId: 'req-agents-manager-unavailable',
        source: 'assistant',
        action: { type: 'agents.open_manager' },
      });

      expect(response.ok).toBe(false);
      expect(response.error).toEqual({
        code: 'surface_unavailable',
        message: 'Agents are not available.',
      });
      expectNavigationUntouched();
      expect(
        useNavigationStore.getState().pendingPluginsNavigation,
      ).toBeUndefined();
    });

    it('opens the Marketplace Agents tab for agents.open_manager (CAN-4266)', async () => {
      setFeatureFlagForTest(
        CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key,
        true,
      );

      const response = await dispatchAppAction({
        requestId: 'req-agents-manager-marketplace',
        source: 'assistant',
        action: { type: 'agents.open_manager' },
      });

      expect(response.ok).toBe(true);
      const state = useNavigationStore.getState();
      expect(state.activePage).toBe('plugins');
      expect(state.pendingPluginsNavigation).toEqual({
        kind: 'marketplace-browse',
        query: '',
        tab: 'agent',
      });
    });

    it('translates the legacy agents page to the Marketplace Agents tab (CAN-4266)', async () => {
      setFeatureFlagForTest(
        CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key,
        true,
      );

      const response = await dispatchAppAction({
        requestId: 'req-legacy-agents-page',
        source: 'assistant',
        action: { type: 'navigation.go_to_page', page: 'agents' },
      });

      expect(response.ok).toBe(true);
      const state = useNavigationStore.getState();
      expect(state.activePage).toBe('plugins');
      expect(state.pendingPluginsNavigation).toEqual({
        kind: 'marketplace-browse',
        query: '',
        tab: 'agent',
      });
    });

    it('refuses the legacy agents page while Agents is switched off (CAN-4266)', async () => {
      setFeatureFlagForTest(
        CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key,
        false,
      );
      useNavigationStore.setState({ pendingPluginsNavigation: undefined });

      const response = await dispatchAppAction({
        requestId: 'req-legacy-agents-page-off',
        source: 'assistant',
        action: { type: 'navigation.go_to_page', page: 'agents' },
      });

      expect(response.ok).toBe(false);
      expect(response.error).toEqual({
        code: 'surface_unavailable',
        message: 'Agents are not available.',
      });
      expectNavigationUntouched();
      expect(
        useNavigationStore.getState().pendingPluginsNavigation,
      ).toBeUndefined();
    });

    it('refuses a request discovered before the page was switched off', async () => {
      setFeatureFlagForTest(
        CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.key,
        true,
      );
      const opened = await dispatchAppAction({
        requestId: 'req-workers-open',
        source: 'assistant',
        action: { type: 'navigation.go_to_page', page: 'workers' },
      });
      expect(opened.ok).toBe(true);
      expect(useNavigationStore.getState().activePage).toBe('workers');
      useNavigationStore.setState({ activePage: 'pipelines' });

      setFeatureFlagForTest(
        CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.key,
        false,
      );
      const refused = await dispatchAppAction({
        requestId: 'req-workers-stale',
        source: 'assistant',
        action: { type: 'navigation.go_to_page', page: 'workers' },
      });

      expect(refused.ok).toBe(false);
      expect(refused.error?.code).toBe('surface_unavailable');
      expect(useNavigationStore.getState().activePage).toBe('pipelines');
    });

    it('still opens pages that are switched on', async () => {
      setFeatureFlagForTest(
        CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.key,
        true,
      );
      setDevBuild(true);

      for (const page of ['workers', 'notice-states', 'statistics'] as const) {
        const response = await dispatchAppAction({
          requestId: `req-${page}-available`,
          source: 'assistant',
          action: { type: 'navigation.go_to_page', page },
        });
        expect(response.ok).toBe(true);
        expect(useNavigationStore.getState().activePage).toBe(page);
      }
    });

    it('keeps unknown and malformed pages as invalid_payload', async () => {
      for (const page of ['not-a-page', 42, undefined]) {
        const response = await dispatchAppAction({
          requestId: 'req-unknown-page',
          source: 'assistant',
          action: JSON.parse(
            JSON.stringify({ type: 'navigation.go_to_page', page }),
          ),
        });
        expect(response.ok).toBe(false);
        expect(response.error?.code).toBe('invalid_payload');
      }
      expectNavigationUntouched();
    });

    it('accepts a known gated page as a valid payload while it is off', async () => {
      // Validity is independent of availability: the refusal is
      // surface_unavailable, never invalid_payload.
      const response = await dispatchAppAction({
        requestId: 'req-valid-but-off',
        source: 'assistant',
        action: { type: 'navigation.go_to_page', page: 'change-review' },
      });

      expect(response.error?.code).toBe('surface_unavailable');
    });
  });

  it('skips expectedUiRevision for read-only worktree tab listing', async () => {
    useChatStore.setState({
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [makeChatTab({ id: 'chat-1' })],
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-list-tabs-stale-revision',
      source: 'assistant',
      expectedUiRevision: 99,
      action: {
        type: 'worktree-chat.list_tabs',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });

    expect(response.ok).toBe(true);
  });

  it('lists bounded background-process metadata without captured output', async () => {
    useActivityStore.setState({
      bgProcesses: {
        'project-1/worktree-1': [
          {
            id: 'process-1',
            chatId: 'chat-1',
            toolUseId: 'tool-1',
            taskId: 'provider-task-1',
            outputTaskId: 'poller-task-1',
            toolName: 'Task',
            kind: 'agent',
            description: 'SECRET_TOKEN=super-secret npm run deploy',
            prompt: 'SECRET PROMPT',
            status: 'running',
            startedAt: 1,
            updatedAt: 2,
            outputFile: '/secret/task.output',
            outputLines: ['SECRET OUTPUT'],
            canStop: true,
          },
        ],
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-list-background-processes',
      source: 'assistant',
      expectedUiRevision: 99,
      action: {
        type: 'worktree-chat.list_background_processes',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    });

    expect(response).toMatchObject({
      ok: true,
      result: {
        processes: [
          {
            id: 'process-1',
            chatId: 'chat-1',
            taskId: 'provider-task-1',
            kind: 'agent',
            description: 'Task',
            status: 'running',
            canStop: true,
          },
        ],
      },
    });
    expect(JSON.stringify(response)).not.toContain('SECRET');
    expect(JSON.stringify(response)).not.toContain('/secret/');
  });

  it('keeps a stopped background process live until its terminal update arrives', async () => {
    useActivityStore.setState({
      bgProcesses: {
        'project-1/worktree-1': [
          {
            id: 'process-1',
            chatId: 'chat-1',
            toolUseId: 'tool-1',
            taskId: 'provider-task-1',
            toolName: 'Task',
            kind: 'agent',
            description: 'Review the change',
            status: 'running',
            startedAt: 1,
            updatedAt: 2,
            outputLines: [],
            canStop: true,
          },
        ],
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-stop-background-process',
      source: 'assistant',
      action: {
        type: 'worktree-chat.stop_background_process',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        taskId: 'provider-task-1',
      },
    });

    expect(response).toMatchObject({
      ok: true,
      result: { taskId: 'provider-task-1', status: 'stopped' },
    });
    expect(activityStopBgProcessMock).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      taskId: 'provider-task-1',
    });
    expect(
      useActivityStore.getState().bgProcesses['project-1/worktree-1']?.[0],
    ).toMatchObject({ status: 'running', canStop: true });
    expect(
      backgroundTaskStopStoreFor(ipcCanopyClient).getState().pending[
        backgroundTaskStopKey({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          taskId: 'provider-task-1',
        })
      ],
    ).toBeDefined();
  });

  it('clears the shared pending stop when the host reports an already-finished task', async () => {
    activityStopBgProcessMock.mockResolvedValueOnce('already-finished');
    useActivityStore.setState({
      bgProcesses: {
        'project-1/worktree-1': [
          {
            id: 'process-1',
            chatId: 'chat-1',
            toolUseId: 'tool-1',
            taskId: 'provider-task-1',
            toolName: 'Task',
            kind: 'agent',
            description: 'Review the change',
            status: 'running',
            startedAt: 1,
            updatedAt: 2,
            outputLines: [],
            canStop: true,
          },
        ],
      },
    });

    await dispatchAppAction({
      requestId: 'req-stop-already-finished-background-process',
      source: 'assistant',
      action: {
        type: 'worktree-chat.stop_background_process',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        taskId: 'provider-task-1',
      },
    });

    expect(
      useActivityStore.getState().bgProcesses['project-1/worktree-1']?.[0],
    ).toMatchObject({ status: 'running', canStop: true });
    expect(
      backgroundTaskStopStoreFor(ipcCanopyClient).getState().pending[
        backgroundTaskStopKey({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          taskId: 'provider-task-1',
        })
      ],
    ).toBeUndefined();
  });

  describe('live provider tasks no process card shows (turn-state phase 41d)', () => {
    function liveTaskChat(executionHarness: ChatTab['executionHarness']): void {
      useChatStore.setState({
        worktreeChats: {
          'project-1/worktree-1': {
            activeTabId: 'chat-1',
            tabs: [makeChatTab({ id: 'chat-1', executionHarness })],
          },
        },
      });
      useActivityStore.setState({
        bgProcesses: {
          'project-1/worktree-1': [
            {
              id: 'process-1',
              chatId: 'chat-1',
              toolUseId: 'tool-1',
              taskId: 'provider-task-1',
              toolName: 'Bash',
              kind: 'bash',
              description: 'npm test',
              status: 'running',
              startedAt: 1,
              updatedAt: 2,
              outputLines: [],
              canStop: true,
            },
          ],
        },
      });
      useLiveBackgroundTaskStore.setState({
        byChat: {
          [liveBackgroundTaskKey('project-1', 'worktree-1', 'chat-1')]: {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            chatId: 'chat-1',
            sessionActive: true,
            liveTasks: [
              { taskId: 'provider-task-1', taskType: 'local_bash' },
              {
                taskId: 'native-agent-1',
                taskType: 'local_agent',
                description: 'SECRET agent prompt',
                status: 'running',
              },
            ],
          },
        },
      });
    }

    function stopNativeAgent(): ReturnType<typeof dispatchAppAction> {
      return dispatchAppAction({
        requestId: 'req-stop-native-agent',
        source: 'assistant',
        action: {
          type: 'worktree-chat.stop_background_process',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          taskId: 'native-agent-1',
        },
      });
    }

    it('lists them beside the process cards, without their descriptions', async () => {
      liveTaskChat('claude');

      const response = await dispatchAppAction({
        requestId: 'req-list-live-tasks',
        source: 'assistant',
        action: {
          type: 'worktree-chat.list_background_processes',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      });

      expect(response).toMatchObject({
        ok: true,
        result: {
          processes: [
            { id: 'process-1', taskId: 'provider-task-1', kind: 'bash' },
            {
              id: 'native-agent-1',
              chatId: 'chat-1',
              taskId: 'native-agent-1',
              kind: 'agent',
              status: 'running',
              canStop: true,
            },
          ],
        },
      });
      expect(JSON.stringify(response)).not.toContain('SECRET');
    });

    it('stops one through the per-row Stop path and reports the outcome', async () => {
      liveTaskChat('claude');
      activityStopBgProcessMock.mockResolvedValueOnce('already-finished');

      const response = await stopNativeAgent();

      expect(response).toMatchObject({
        ok: true,
        result: { taskId: 'native-agent-1', status: 'already-finished' },
      });
      expect(activityStopBgProcessMock).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        taskId: 'native-agent-1',
      });
    });

    it("refuses a Codex chat's task, whose row has no Stop (D10)", async () => {
      liveTaskChat('codex');

      const listed = await dispatchAppAction({
        requestId: 'req-list-codex-live-tasks',
        source: 'assistant',
        action: {
          type: 'worktree-chat.list_background_processes',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      });
      const response = await stopNativeAgent();

      expect(listed).toMatchObject({
        result: {
          processes: [
            { id: 'process-1' },
            { id: 'native-agent-1', canStop: false },
          ],
        },
      });
      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'surface_unavailable',
          message:
            "Background task native-agent-1 has no per-task Stop in this chat's provider.",
        },
      });
      expect(activityStopBgProcessMock).not.toHaveBeenCalled();
    });

    it("stops one in a chat whose transcript isn't loaded", async () => {
      liveTaskChat('claude');
      useChatStore.setState({ worktreeChats: {} });

      const response = await stopNativeAgent();

      expect(response).toMatchObject({
        ok: true,
        result: { taskId: 'native-agent-1', status: 'stopped' },
      });
      expect(activityStopBgProcessMock).toHaveBeenCalledTimes(1);
    });
  });

  it("reads an isolated delegate's changes as the card does", async () => {
    const changes = {
      files: [{ path: 'src/a.ts', change: 'modified', diff: '+new\n' }],
    };
    managedDelegationChangesMock.mockResolvedValueOnce({ ok: true, changes });
    const action = {
      type: 'delegation.read_changes' as const,
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      delegationId: 'delegation-1',
      revision: 'a'.repeat(40),
    };

    await expect(
      dispatchAppAction({
        requestId: 'req-delegation-changes',
        source: 'assistant',
        action,
      }),
    ).resolves.toMatchObject({ ok: true, result: changes });
    expect(managedDelegationChangesMock).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      delegationId: 'delegation-1',
      revision: 'a'.repeat(40),
    });

    managedDelegationChangesMock.mockResolvedValueOnce({
      ok: false,
      error: "Couldn't read the delegate's changes.",
    });
    await expect(
      dispatchAppAction({
        requestId: 'req-delegation-changes-failed',
        source: 'assistant',
        action,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'execution_failed',
        message: "Couldn't read the delegate's changes.",
      },
    });
  });

  it.each([
    {
      type: 'delegation.tree' as const,
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    },
    {
      type: 'delegation.roots' as const,
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    },
    {
      type: 'delegation.transcript' as const,
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      delegationId: 'delegation-1',
    },
    {
      type: 'delegation.worktree_summary' as const,
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      delegationId: 'delegation-1',
      revision: 'a'.repeat(40),
    },
  ])(
    'never runs the main-handled $type read in the renderer',
    async (action) => {
      const response = await dispatchAppAction({
        requestId: `req-${action.type}`,
        source: 'assistant',
        action,
      });
      expect(response.ok).toBe(false);
      expect(managedDelegationChangesMock).not.toHaveBeenCalled();
    },
  );

  it('stops one managed delegation as the user', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-delegation-stop',
      source: 'assistant',
      action: {
        type: 'delegation.stop',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        delegationId: 'delegation-1',
      },
    });

    expect(response).toMatchObject({
      ok: true,
      result: { delegationId: 'delegation-1', status: 'stopping' },
    });
    expect(managedDelegationStopMock).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      delegationId: 'delegation-1',
    });
    expect(managedDelegationStopAllMock).not.toHaveBeenCalled();
    expect(activityStopBgProcessMock).not.toHaveBeenCalled();
  });

  it('returns main’s reason when a delegation cannot be stopped', async () => {
    managedDelegationStopMock.mockResolvedValue({
      ok: false,
      error: 'That delegation is not one of your descendants.',
    });

    const response = await dispatchAppAction({
      requestId: 'req-delegation-stop-refused',
      source: 'assistant',
      action: {
        type: 'delegation.stop',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        delegationId: 'someone-else',
      },
    });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'That delegation is not one of your descendants.',
      },
    });
  });

  it('stops every managed delegation in a chat', async () => {
    managedDelegationStopAllMock.mockResolvedValue({ ok: true, stopped: 3 });

    const response = await dispatchAppAction({
      requestId: 'req-delegation-stop-all',
      source: 'assistant',
      action: {
        type: 'delegation.stop_all',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    });

    expect(response).toMatchObject({ ok: true, result: { stopped: 3 } });
    expect(managedDelegationStopAllMock).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    });
    expect(managedDelegationStopMock).not.toHaveBeenCalled();
  });

  it('reports a failed Stop all', async () => {
    managedDelegationStopAllMock.mockResolvedValue({
      ok: false,
      error: 'Could not reach the chat.',
    });

    const response = await dispatchAppAction({
      requestId: 'req-delegation-stop-all-failed',
      source: 'assistant',
      action: {
        type: 'delegation.stop_all',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'execution_failed', message: 'Could not reach the chat.' },
    });
  });

  it.each([
    [
      'delegation.stop',
      { projectId: 'project-1', worktreeId: 'worktree-1', chatId: 'chat-1' },
    ],
    [
      'delegation.stop_all',
      { projectId: 'project-1', worktreeId: 'worktree-1' },
    ],
  ])('rejects %s without its chat target', async (type, fields) => {
    const response = await dispatchAppAction({
      requestId: `req-${type}-invalid`,
      source: 'assistant',
      action: { type, ...fields },
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'invalid_payload' },
    });
    expect(managedDelegationStopMock).not.toHaveBeenCalled();
    expect(managedDelegationStopAllMock).not.toHaveBeenCalled();
  });

  it('updates worktree branch grouping overrides through worktree settings', async () => {
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
    });

    const response = await dispatchAppAction({
      requestId: 'req-worktree-branch-grouping',
      source: 'assistant',
      action: {
        type: 'worktree.update_settings',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        branchGroupingOverride: 'ungroup',
      },
    });

    expect(response).toMatchObject({
      ok: true,
      result: {
        worktree: {
          id: 'worktree-1',
          branchGroupingOverride: 'ungroup',
        },
      },
    });
    expect(workspaceApiMock.setWorktreeBranchGrouping).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      override: 'ungroup',
      worktreeOrder: ['worktree-1'],
    });
    const projectForGrouping = useProjectsStore.getState().projects[0];
    expect(
      projectForGrouping?.type !== 'cowork'
        ? projectForGrouping?.worktrees[0]?.branchGroupingOverride
        : undefined,
    ).toBe('ungroup');
  });

  it('opens Settings → Environments for the environment settings section', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-settings-environment',
      source: 'assistant',
      action: { type: 'navigation.open_settings', section: 'environment' },
    });

    expect(response).toMatchObject({ ok: true });
    expect(useNavigationStore.getState().settingsOpen).toBe(true);
    expect(useNavigationStore.getState().settingsInitialSection).toBe(
      'environment',
    );
  });

  it('opens Settings → Environments for the environments page alias', async () => {
    useNavigationStore.setState({
      activePage: 'overview',
      settingsOpen: false,
      settingsInitialSection: undefined,
    });
    const response = await dispatchAppAction({
      requestId: 'req-navigate-environments',
      source: 'assistant',
      action: { type: 'navigation.go_to_page', page: 'environments' },
    });

    expect(response).toMatchObject({ ok: true });
    expect(useNavigationStore.getState().activePage).toBe('overview');
    expect(useNavigationStore.getState().settingsOpen).toBe(true);
    expect(useNavigationStore.getState().settingsInitialSection).toBe(
      'environment',
    );
  });

  it('opens an App Advisor chat before focusing a requested turn', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-open-chat-turn',
      source: 'assistant',
      action: {
        type: 'navigation.open_chat_turn',
        projectId: APP_ADVISOR_PROJECT_ID,
        chatId: 'advisor-chat-1',
        userMessageId: 'user-message-1',
      },
    });

    expect(response).toMatchObject({ ok: true });
    expect(appAdvisorOpenWindowMock).toHaveBeenCalledWith({
      chatId: 'advisor-chat-1',
      userMessageId: 'user-message-1',
      focus: true,
    });
  });

  it('navigates to the Kanban page without hiding the sidebar', async () => {
    useSidebarStore.setState({ hidden: false, persistedHidden: false });

    const response = await dispatchAppAction({
      requestId: 'req-navigate-kanban',
      source: 'assistant',
      action: { type: 'navigation.go_to_page', page: 'kanban' },
    });

    expect(response).toMatchObject({ ok: true });
    expect(useNavigationStore.getState().activePage).toBe('kanban');
    expect(useSidebarStore.getState().hidden).toBe(false);
  });

  it('preserves an already-hidden sidebar on kanban entry without persisting a preference', async () => {
    useSidebarStore.setState({ hidden: true, persistedHidden: true });
    savePreferencesMock.mockClear();

    await dispatchAppAction({
      requestId: 'req-navigate-kanban-no-persist',
      source: 'assistant',
      action: { type: 'navigation.go_to_page', page: 'kanban' },
    });

    expect(useSidebarStore.getState().hidden).toBe(true);
    expect(useSidebarStore.getState().persistedHidden).toBe(true);
    expect(savePreferencesMock).not.toHaveBeenCalled();
  });

  it('does not hide the sidebar when navigating to a non-kanban page', async () => {
    useSidebarStore.setState({ hidden: false });

    const response = await dispatchAppAction({
      requestId: 'req-navigate-overview-no-hide',
      source: 'assistant',
      action: { type: 'navigation.go_to_page', page: 'overview' },
    });

    expect(response).toMatchObject({ ok: true });
    expect(useNavigationStore.getState().activePage).toBe('overview');
    expect(useSidebarStore.getState().hidden).toBe(false);
  });

  it.each(['unavailable', 'locked', 'secure'] as const)(
    'exposes safe credential diagnostics through the existing Advisor account action: %s',
    async (state) => {
      const secureStorageStatus = {
        version: 1,
        state,
        backend: 'gnome_libsecret',
        writeAvailable: state === 'secure',
      };
      const secureStorageFailure = {
        version: 1,
        code: 'SECURE_STORAGE_ENCRYPT_FAILED',
        operation: 'write',
        state,
        backend: 'gnome_libsecret',
        retryable: true,
      };
      loadCanopyCloudAccountMock.mockResolvedValueOnce({
        hasApiKey: false,
        storageAvailable: false,
        secureStorageStatus,
        secureStorageFailure,
      });

      const response = await dispatchAppAction({
        requestId: 'req-credential-diagnostic',
        source: 'assistant',
        action: { type: 'canopy_cloud.load_account' },
      });

      expect(response).toMatchObject({
        ok: true,
        result: { secureStorageStatus, secureStorageFailure },
      });
      expect(JSON.stringify(response.result)).not.toContain('apiKey');
    },
  );

  it('dispatches Canopy Cloud account actions without exposing the API key', async () => {
    loadCanopyCloudAccountMock.mockResolvedValueOnce({
      hasApiKey: true,
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      capabilities: ['pipelines-v1'],
      account: { id: 'account-1', email: 'user@example.test' },
      storageAvailable: true,
    });

    const loadResponse = await dispatchAppAction({
      requestId: 'req-cloud-load-account',
      source: 'assistant',
      action: { type: 'canopy_cloud.load_account' },
    });
    const validateResponse = await dispatchAppAction({
      requestId: 'req-cloud-validate-key',
      source: 'assistant',
      action: { type: 'canopy_cloud.validate_api_key', apiKey: 'csk_valid' },
    });
    const saveResponse = await dispatchAppAction({
      requestId: 'req-cloud-save-key',
      source: 'assistant',
      action: { type: 'canopy_cloud.save_api_key', apiKey: 'csk_valid' },
    });
    const clearResponse = await dispatchAppAction({
      requestId: 'req-cloud-clear-key',
      source: 'assistant',
      action: { type: 'canopy_cloud.clear_api_key' },
    });

    expect(loadResponse.ok).toBe(true);
    // The load-account result surfaces the auth mode and credential source.
    expect(loadResponse.result).toMatchObject({
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
    });
    expect(validateResponse.ok).toBe(true);
    expect(saveResponse.ok).toBe(true);
    expect(clearResponse.ok).toBe(true);
    expect(window.api.validateCanopyCloudApiKey).toHaveBeenCalledWith({
      apiKey: 'csk_valid',
    });
    expect(window.api.saveCanopyCloudApiKey).toHaveBeenCalledWith({
      apiKey: 'csk_valid',
    });
    // The saved raw key is never echoed back through the load/save state.
    expect(JSON.stringify(saveResponse.result)).not.toContain('csk_valid');
  });

  it.each([
    ['status', 'status'],
    ['models', 'listModels'],
    ['connect', 'connect'],
    ['cancel', 'cancel'],
    ['disconnect', 'disconnect'],
  ] as const)(
    'dispatches OpenCode %s through the existing owned preload API',
    async (operation, method) => {
      const connection = {
        status: jest.fn(),
        listModels: jest.fn(),
        connect: jest.fn(),
        cancel: jest.fn(),
        disconnect: jest.fn(),
      };
      connection[method].mockResolvedValue({ phase: 'connected' });
      Object.assign(window.api, { opencodeConnection: connection });
      const response = await dispatchAppAction({
        requestId: `opencode-${operation}`,
        source: 'assistant',
        action: { type: 'opencode.connection', operation },
      });
      expect(response.ok).toBe(true);
      expect(connection[method]).toHaveBeenCalledTimes(1);
      for (const [key, invoke] of Object.entries(connection)) {
        if (key !== method) expect(invoke).not.toHaveBeenCalled();
      }
      expect(response.result).toEqual({ value: { phase: 'connected' } });
    },
  );

  it('does not start OpenCode setup for an already cancelled Advisor request', async () => {
    const connect = jest.fn().mockResolvedValue({ phase: 'connected' });
    const cancel = jest.fn();
    Object.assign(window.api, { opencodeConnection: { connect, cancel } });
    const controller = new AbortController();
    controller.abort();
    const response = await dispatchAppAction({
      requestId: 'opencode-already-aborted',
      source: 'assistant',
      action: { type: 'opencode.connection', operation: 'connect' },
      signal: controller.signal,
    });
    expect(response.ok).toBe(false);
    expect(connect).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('cancels its OpenCode setup when the Advisor request expires', async () => {
    let enabled = false;
    let cancelled = false;
    let finishSetup: () => void = () => undefined;
    const connect = jest.fn<Promise<unknown>, [operationId?: string]>(
      () =>
        new Promise((resolve, reject) => {
          finishSetup = (): void => {
            if (cancelled) reject(new Error('OpenCode setup cancelled.'));
            else {
              enabled = true;
              resolve({ phase: 'connected' });
            }
          };
        }),
    );
    const cancel = jest.fn<Promise<void>, [operationId?: string]>(() => {
      cancelled = true;
      return Promise.resolve();
    });
    Object.assign(window.api, { opencodeConnection: { connect, cancel } });
    const controller = new AbortController();
    const responsePromise = dispatchAppAction({
      requestId: 'opencode-request-expired',
      source: 'assistant',
      action: { type: 'opencode.connection', operation: 'connect' },
      signal: controller.signal,
    });
    expect(connect).toHaveBeenCalledTimes(1);
    controller.abort();
    await Promise.resolve();
    finishSetup();
    const response = await responsePromise;
    expect(enabled).toBe(false);
    expect(response.ok).toBe(false);
    const operationId = connect.mock.calls[0][0];
    expect(operationId).toEqual(expect.any(String));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(operationId);
  });

  it('does not cancel completed OpenCode setup when its Advisor request later aborts', async () => {
    const connect = jest.fn().mockResolvedValue({ phase: 'connected' });
    const cancel = jest.fn();
    Object.assign(window.api, { opencodeConnection: { connect, cancel } });
    const controller = new AbortController();
    const response = await dispatchAppAction({
      requestId: 'opencode-completed-before-abort',
      source: 'assistant',
      action: { type: 'opencode.connection', operation: 'connect' },
      signal: controller.signal,
    });
    expect(response.ok).toBe(true);
    controller.abort();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('reports when the OpenCode preload API is unavailable', async () => {
    delete window.api.opencodeConnection;
    const response = await dispatchAppAction({
      requestId: 'opencode-unavailable',
      source: 'assistant',
      action: { type: 'opencode.connection', operation: 'status' },
    });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('surface_unavailable');
  });

  it('returns a JSON null receipt for a completed OpenCode cancellation', async () => {
    Object.assign(window.api, {
      opencodeConnection: { cancel: jest.fn().mockResolvedValue(undefined) },
    });
    const response = await dispatchAppAction({
      requestId: 'opencode-cancel-receipt',
      source: 'assistant',
      action: { type: 'opencode.connection', operation: 'cancel' },
    });
    expect(response.ok).toBe(true);
    expect(response.result).toEqual({ value: null });
  });

  it('rejects unsupported OpenCode operations', () => {
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'opencode.connection',
        operation: 'execute',
      }),
    ).toBe(false);
  });

  it('dispatches the desktop OAuth login/disconnect actions to the preload API', async () => {
    const startResponse = await dispatchAppAction({
      requestId: 'req-cloud-start-oauth',
      source: 'assistant',
      action: { type: 'canopy_cloud.start_oauth_login' },
    });
    const cancelResponse = await dispatchAppAction({
      requestId: 'req-cloud-cancel-oauth',
      source: 'assistant',
      action: { type: 'canopy_cloud.cancel_oauth_login' },
    });
    const disconnectResponse = await dispatchAppAction({
      requestId: 'req-cloud-disconnect',
      source: 'assistant',
      action: { type: 'canopy_cloud.disconnect' },
    });

    expect(startResponse.ok).toBe(true);
    expect(cancelResponse.ok).toBe(true);
    expect(disconnectResponse.ok).toBe(true);
    expect(window.api.startCanopyCloudOAuthLogin).toHaveBeenCalledTimes(1);
    expect(window.api.cancelCanopyCloudOAuthLogin).toHaveBeenCalledTimes(1);
    expect(window.api.disconnectCanopyCloudAccount).toHaveBeenCalledTimes(1);
    // OAuth login resolves with the connected account but never a raw token.
    expect(startResponse.result).toMatchObject({
      account: { authMode: 'oauth', credentialSource: 'oauth_desktop' },
    });
    expect(JSON.stringify(startResponse.result)).not.toContain('csk_');
  });

  it('rejects a private App Advisor runs.share action', async () => {
    runsShareMock.mockClear();
    const response = await dispatchAppAction({
      requestId: 'req-runs-share-private',
      source: 'assistant',
      action: {
        type: 'runs.share',
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        shareScope: 'private',
      },
    });

    expect(response.ok).toBe(false);
    expect(runsShareMock).not.toHaveBeenCalled();
  });

  // Private is a storage value, not an audience: every agent share names a
  // team or an organization, and neither a missing nor a private scope falls
  // back to a private-only cloud copy.
  const scopedShareActions: Array<[string, Record<string, unknown>]> = [
    ['skills.share_custom', { name: 'helper' }],
    ['collections.share', { id: 'collection-1' }],
    ['pipeline.share', { pipelineId: 'pipeline-1' }],
    [
      'plan.share',
      { projectId: 'proj-1', worktreeId: 'wt-1', planId: 'plan-1' },
    ],
    [
      'runs.share',
      { projectId: 'proj-1', worktreeId: 'wt-1', chatId: 'chat-1' },
    ],
  ];
  it.each(
    scopedShareActions.flatMap(([type, fields]) => [
      [type, 'a missing', fields],
      [type, 'a private', { ...fields, shareScope: 'private' }],
    ]),
  )(
    'rejects %s with %s shareScope as an invalid payload',
    async (type, _label, fields) => {
      const response = await dispatchAppAction({
        requestId: `req-${type}-scope`,
        source: 'assistant',
        action: { type, ...fields },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('invalid_payload');
    },
  );

  it('rejects a private automation.share scope as an invalid payload', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-automation-share-private',
      source: 'assistant',
      action: {
        type: 'automation.share',
        id: 'activity-1',
        shareScope: 'private',
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('invalid_payload');
  });

  const organizationShareActions: AppAdvisorActionRequest['action'][] = [
    {
      type: 'skills.share_custom',
      name: 'custom-skill',
      shareScope: 'organization',
    },
    {
      type: 'collections.share',
      id: 'collection-1',
      shareScope: 'organization',
    },
    {
      type: 'pipeline.share',
      pipelineId: 'custom-1',
      shareScope: 'organization',
    },
    {
      type: 'automation.share',
      id: 'activity-share',
      shareScope: 'organization',
    },
    {
      type: 'plan.share',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      planId: 'plan-1',
      shareScope: 'organization',
    },
    {
      type: 'runs.share',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      shareScope: 'organization',
    },
  ];

  it.each(organizationShareActions)(
    'refuses $type without an explicit or selected organization',
    async (action) => {
      setFeatureFlagForTest(
        CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
        true,
      );
      useWorkspaceContextStore.setState({
        hydrated: true,
        state: {
          context: { kind: 'personal' },
          revision: 1,
          organizations: [],
        },
      });

      const response = await dispatchAppAction({
        requestId: `req-${action.type}-organization-refusal`,
        source: 'assistant',
        action,
      });

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'surface_unavailable',
          message:
            'Choose an organization from the context switcher above the account in the sidebar, or pass organizationId, to share with an organization.',
        },
      });
    },
  );

  it('fills the selected organization for all six organization share actions', async () => {
    const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    setFeatureFlagForTest(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context: { kind: 'organization', organizationId },
        revision: 1,
        organizations: [{ id: organizationId, name: 'Acme', role: 'MEMBER' }],
      },
    });

    const collectionsApi = window.collections as unknown as {
      loadCollection: jest.Mock;
      createShared: jest.Mock;
    };
    collectionsApi.loadCollection.mockResolvedValue({
      id: 'collection-1',
      name: 'Collection',
      description: '',
      skills: [],
      plugins: [],
      mcpServers: [],
    });
    collectionsApi.createShared.mockResolvedValue({
      ok: true,
      value: { id: 'shared-collection' },
    });
    pipelinesApiMock.list.mockResolvedValue({
      success: true,
      data: [
        makePipelineInfo({
          id: 'custom-1',
          name: 'Custom pipeline',
          source: 'user',
        }),
      ],
    });
    pipelinesApiMock.get.mockResolvedValue({
      success: true,
      data: {
        info: makePipelineInfo({
          id: 'custom-1',
          name: 'Custom pipeline',
          source: 'user',
        }),
        content: {
          name: 'Custom pipeline',
          description: '',
          on: 'dispatch',
          jobs: { test: { steps: [] } },
        },
      },
    });
    pipelinesApiMock.createShared.mockResolvedValue({
      success: true,
      data: makeSharedPipelineDetail({ id: 'shared-pipeline' }),
    });
    automationsApiMock.list.mockResolvedValue({
      activities: [
        {
          version: 1,
          id: 'activity-share',
          name: 'Nightly triage',
          enabled: true,
          schedule: {
            kind: 'cron',
            expression: '0 2 * * *',
            timezone: 'local',
          },
          action: { type: 'app_advisor_prompt', prompt: 'Triage.' },
          createdAt: '2026-08-19T00:00:00.000Z',
          updatedAt: '2026-08-19T00:00:00.000Z',
          failureCount: 0,
        },
      ],
      recentRuns: [],
    });
    automationsApiMock.createShared.mockResolvedValue({
      id: 'shared-automation',
      contentHash: 'a'.repeat(64),
      shareScope: 'organization',
    });
    activityPlansShareMock.mockResolvedValue({ id: 'plan-1' });

    for (const action of organizationShareActions) {
      const response = await dispatchAppAction({
        requestId: `req-${action.type}-organization-default`,
        source: 'assistant',
        action,
      });
      expect(response.ok).toBe(true);
    }

    expect(skillsApiMock.createShared).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId }),
    );
    expect(collectionsApi.createShared).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId }),
    );
    expect(pipelinesApiMock.createShared).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId }),
    );
    expect(automationsApiMock.createShared).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId }),
    );
    expect(activityPlansShareMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId }),
    );
    expect(runsShareMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId }),
    );
  });

  it('clears local sharedRun state after a successful App Advisor runs.unshare', async () => {
    runsUnshareMock.mockResolvedValueOnce({ unshared: true });
    const setSharedRunSpy = jest.spyOn(useChatStore.getState(), 'setSharedRun');

    const response = await dispatchAppAction({
      requestId: 'req-runs-unshare-1',
      source: 'assistant',
      action: {
        type: 'runs.unshare',
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
      },
    });

    expect(response.ok).toBe(true);
    expect(runsUnshareMock).toHaveBeenCalledWith({
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
    });
    // Local "Shared" indicator must converge so it does not linger until reload.
    expect(setSharedRunSpy).toHaveBeenCalledWith(
      'proj-1',
      'wt-1',
      'chat-1',
      undefined,
    );

    setSharedRunSpy.mockRestore();
  });

  it('restores sharedRun when App Advisor cloud revocation fails', async () => {
    const sharedRun = {
      externalId: 'shared-run-1',
      shareScope: 'organization' as const,
      sharedAt: '2026-08-11T00:00:00.000Z',
    };
    useChatStore.setState({
      worktreeChats: {
        'proj-1/wt-1': {
          activeTabId: 'chat-1',
          tabs: [makeChatTab({ id: 'chat-1', sharedRun })],
        },
      },
    });
    runsUnshareMock.mockRejectedValueOnce(new Error('cloud unavailable'));
    const setSharedRunSpy = jest.spyOn(useChatStore.getState(), 'setSharedRun');

    const response = await dispatchAppAction({
      requestId: 'req-runs-unshare-rollback',
      source: 'assistant',
      action: {
        type: 'runs.unshare',
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
      },
    });

    expect(response.ok).toBe(false);
    expect(setSharedRunSpy).toHaveBeenNthCalledWith(
      1,
      'proj-1',
      'wt-1',
      'chat-1',
      undefined,
    );
    expect(setSharedRunSpy).toHaveBeenNthCalledWith(
      2,
      'proj-1',
      'wt-1',
      'chat-1',
      sharedRun,
    );
    setSharedRunSpy.mockRestore();
  });

  it('re-derives cowork work-entry metas after a successful App Advisor runs.unshare', async () => {
    runsUnshareMock.mockResolvedValueOnce({ unshared: false });
    // Register the workspace as a cowork target: the unshare handler guards
    // on `isCoworkChatTarget(projectId)` (entry-agnostic), which reads the
    // cowork registry synced from the projects store.
    useProjectsStore.setState({
      projects: [
        {
          type: 'cowork',
          id: DEFAULT_COWORK_WORKSPACE_ID,
          name: 'Default',
          color: '#000000',
          collapsed: false,
          order: 0,
        },
      ],
      hasHydratedProjects: true,
    });
    const refreshWorkEntriesSpy = jest.spyOn(
      useStandaloneChatStore.getState(),
      'refreshWorkEntries',
    );

    const response = await dispatchAppAction({
      requestId: 'req-runs-unshare-2',
      source: 'assistant',
      action: {
        type: 'runs.unshare',
        projectId: DEFAULT_COWORK_WORKSPACE_ID,
        worktreeId: COWORK_HOME_WORKTREE_ID,
        chatId: 'cowork-chat-1',
      },
    });

    expect(response.ok).toBe(true);
    // Even an idempotent already-absent unshare (`unshared: false`) must
    // re-derive the cowork work-entry metas so the "Shared" indicator
    // converges (meta sharedRun is derived from tab files main-side).
    expect(refreshWorkEntriesSpy).toHaveBeenCalled();

    refreshWorkEntriesSpy.mockRestore();
  });

  it('opens the skills manager on the Plugins page', async () => {
    const events: Array<{ tab?: string }> = [];
    const listener = (event: Event): void => {
      events.push((event as CustomEvent<{ tab?: string }>).detail);
    };
    window.addEventListener('canopy:plugins-open-tab', listener);

    try {
      const response = await dispatchAppAction({
        requestId: 'req-skills-open',
        source: 'assistant',
        action: { type: 'skills.open_manager' },
      });

      expect(response.ok).toBe(true);
      expect(useNavigationStore.getState().activePage).toBe('plugins');
      expect(events).toEqual([{ tab: 'skills' }]);
    } finally {
      window.removeEventListener('canopy:plugins-open-tab', listener);
    }
  });

  it('discovers publisher skills for explicit native review without installing', async () => {
    skillsApiMock.listMarketplace.mockResolvedValueOnce([
      {
        externalId: 'publisher-a',
        name: 'guide',
        description: 'Writing guide',
        publisher: 'Anthropic',
      },
      {
        externalId: 'publisher-b',
        name: 'charts',
        description: 'Data charts',
        publisher: 'OpenAI',
      },
    ]);
    const response = await dispatchAppAction({
      requestId: 'publisher-discovery',
      source: 'assistant',
      action: { type: 'skills.list_marketplace', query: 'anthropic' },
    });
    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      totalMatches: 1,
      skills: [
        {
          entryId: 'public-share:skill:publisher-a',
          name: 'guide',
          publisher: 'Anthropic',
        },
      ],
    });
    expect(skillsApiMock.installSkills).not.toHaveBeenCalled();
  });

  it('opens the interrupted-session resume modal for a native provider', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-usage-resume-open',
      source: 'assistant',
      action: { type: 'usage.open_resume_modal', provider: 'codex' },
    });

    expect(response).toMatchObject({
      ok: true,
      result: { provider: 'codex', origin: 'usage-review' },
    });
    expect(useUsageLimitResumePromptStore.getState()).toMatchObject({
      isOpen: true,
      provider: 'codex',
      origin: 'usage-review',
    });
  });

  it('opens the interrupted-session resume modal for all providers', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-usage-resume-open-all',
      source: 'assistant',
      action: { type: 'usage.open_resume_modal' },
    });

    expect(response).toMatchObject({
      ok: true,
      result: { provider: null, origin: 'home' },
    });
    expect(useUsageLimitResumePromptStore.getState()).toMatchObject({
      isOpen: true,
      provider: null,
      origin: 'home',
    });
  });

  it('opens and controls the durable resume queue', async () => {
    const snapshot = {
      version: 1 as const,
      revision: 7,
      paused: false,
      entries: [],
    };
    const getResumeQueue = jest.fn().mockResolvedValue(snapshot);
    const controlResumeQueue = jest
      .fn()
      .mockResolvedValue({ ...snapshot, revision: 8, paused: true });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ...window.api, getResumeQueue, controlResumeQueue },
    });

    await expect(
      dispatchAppAction({
        requestId: 'req-resume-queue-open',
        source: 'assistant',
        action: { type: 'usage.open_resume_queue' },
      }),
    ).resolves.toMatchObject({ ok: true, result: { revision: 7 } });
    expect(useResumeQueueStore.getState().isOpen).toBe(true);

    await expect(
      dispatchAppAction({
        requestId: 'req-resume-queue-pause',
        source: 'assistant',
        action: { type: 'usage.control_resume_queue', action: 'pause' },
      }),
    ).resolves.toMatchObject({ ok: true, result: { revision: 8 } });
    expect(controlResumeQueue).toHaveBeenCalledWith('pause');
    expect(useResumeQueueStore.getState().snapshot?.paused).toBe(true);
  });

  describe('remote control', () => {
    const host = {
      deviceId: 'device-desktop',
      name: 'Desktop',
      platform: 'darwin' as const,
      pairedAt: '2026-10-01T00:00:00.000Z',
      online: true,
      connection: 'connected' as const,
      error: 'secret detail',
      ended: false,
    };
    const baseState: RemoteControlState = {
      available: true,
      signedIn: true,
      relayStatus: 'connected',
      relayDetail: null,
      thisDevice: null,
      allowIncoming: false,
      hosts: [host],
      controllers: [],
      discoverable: [],
      outgoingPairing: null,
      incomingPairings: [
        {
          deviceId: 'device-phone',
          name: 'Phone',
          platform: 'linux',
          pairingId: 'pairing-1',
          code: '123456',
        },
      ],
    };

    function mockRemoteControl(
      state: RemoteControlState,
      context: RemoteControlContext = { mode: 'local' },
    ): {
      openMachine: jest.Mock;
      setAllowIncoming: jest.Mock;
    } {
      const openMachine = jest.fn().mockResolvedValue(undefined);
      const setAllowIncoming = jest
        .fn()
        .mockImplementation((allow: boolean) =>
          Promise.resolve({ ...state, allowIncoming: allow }),
        );
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          ...window.api,
          remoteControl: {
            getContext: () => context,
            getState: jest.fn().mockResolvedValue(state),
            openMachine,
            setAllowIncoming,
          },
        },
      });
      return { openMachine, setAllowIncoming };
    }

    it('reports paired computers without pairing codes or errors', async () => {
      mockRemoteControl(baseState);
      const response = await dispatchAppAction({
        requestId: 'req-remote-state',
        source: 'assistant',
        action: { type: 'remote_control.get_state' },
      });
      expect(response).toMatchObject({
        ok: true,
        result: {
          allowIncoming: false,
          pendingPairingRequests: 1,
          hosts: [
            {
              deviceId: 'device-desktop',
              name: 'Desktop',
              online: true,
              connection: 'connected',
            },
          ],
        },
      });
      const serialized = JSON.stringify(response.result);
      expect(serialized).not.toContain('123456');
      expect(serialized).not.toContain('secret detail');
    });

    it('opens a paired computer and refuses one that is not paired', async () => {
      const { openMachine } = mockRemoteControl(baseState);
      await expect(
        dispatchAppAction({
          requestId: 'req-remote-open',
          source: 'assistant',
          action: {
            type: 'remote_control.open_computer',
            deviceId: 'device-desktop',
          },
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(openMachine).toHaveBeenCalledWith('device-desktop');
      await expect(
        dispatchAppAction({
          requestId: 'req-remote-open-unknown',
          source: 'assistant',
          action: {
            type: 'remote_control.open_computer',
            deviceId: 'device-stranger',
          },
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_payload' },
      });
      expect(openMachine).toHaveBeenCalledTimes(1);
    });

    it('turns incoming control off', async () => {
      const { setAllowIncoming } = mockRemoteControl({
        ...baseState,
        allowIncoming: true,
      });
      await expect(
        dispatchAppAction({
          requestId: 'req-remote-allow',
          source: 'assistant',
          action: { type: 'remote_control.set_allow_incoming', enabled: false },
        }),
      ).resolves.toMatchObject({ ok: true, result: { allowIncoming: false } });
      expect(setAllowIncoming).toHaveBeenCalledWith(false);
    });

    it("leaves remote access to the other computer's own window", async () => {
      const { openMachine, setAllowIncoming } = mockRemoteControl(
        { ...baseState, allowIncoming: true },
        {
          mode: 'remote',
          deviceId: 'device-b',
          name: 'Studio',
          platform: 'darwin',
        },
      );
      for (const action of [
        { type: 'remote_control.get_state' as const },
        { type: 'remote_control.set_allow_incoming' as const, enabled: false },
      ]) {
        await expect(
          dispatchAppAction({
            requestId: `req-remote-window-${action.type}`,
            source: 'assistant',
            action,
          }),
        ).resolves.toMatchObject({
          ok: false,
          error: { code: 'surface_unavailable' },
        });
      }
      expect(setAllowIncoming).not.toHaveBeenCalled();

      // Opening a computer is a window here, so it still works.
      await expect(
        dispatchAppAction({
          requestId: 'req-remote-window-open',
          source: 'assistant',
          action: { type: 'remote_control.open_computer', deviceId: null },
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(openMachine).toHaveBeenCalledWith(null);
    });

    it('refuses every action while remote control is unavailable', async () => {
      const { openMachine, setAllowIncoming } = mockRemoteControl({
        ...baseState,
        available: false,
      });
      for (const action of [
        { type: 'remote_control.get_state' as const },
        { type: 'remote_control.open_computer' as const, deviceId: null },
        { type: 'remote_control.set_allow_incoming' as const, enabled: true },
      ]) {
        await expect(
          dispatchAppAction({
            requestId: `req-remote-off-${action.type}`,
            source: 'assistant',
            action,
          }),
        ).resolves.toMatchObject({
          ok: false,
          error: { code: 'surface_unavailable' },
        });
      }
      expect(openMachine).not.toHaveBeenCalled();
      expect(setAllowIncoming).not.toHaveBeenCalled();
    });
  });

  it('opens clone progress for background clones and reports their counts', async () => {
    useCloneJobsStore.setState({ jobs: [], received: false, isOpen: false });
    const listCloneJobs = jest
      .fn()
      .mockResolvedValue([
        makeCloneJob(),
        makeCloneJob({ id: 'job-2', status: 'failed', cancellable: false }),
        makeCloneJob({ id: 'job-3', background: false }),
      ]);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ...window.api, listCloneJobs },
    });

    await expect(
      dispatchAppAction({
        requestId: 'req-clone-progress-open',
        source: 'assistant',
        action: { type: 'workspace.open_clone_progress' },
      }),
    ).resolves.toMatchObject({ ok: true, result: { running: 1, failed: 1 } });
    expect(useCloneJobsStore.getState().isOpen).toBe(true);
  });

  it('reports when no clone is running in the background', async () => {
    useCloneJobsStore.setState({ jobs: [], received: false, isOpen: false });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ...window.api, listCloneJobs: jest.fn().mockResolvedValue([]) },
    });

    await expect(
      dispatchAppAction({
        requestId: 'req-clone-progress-empty',
        source: 'assistant',
        action: { type: 'workspace.open_clone_progress' },
      }),
    ).resolves.toMatchObject({ ok: true, result: { running: 0, failed: 0 } });
    expect(useCloneJobsStore.getState().isOpen).toBe(false);
  });

  it('opens curated MCP browse on the Plugins discovery surface', async () => {
    // The destination must survive the Plugins page's lazy mount. A transient
    // window event can fire before the page registers its listener.
    const tabs: Array<{ tab?: string }> = [];
    let browseEvents = 0;
    const tabListener = (event: Event): void => {
      if (!(event instanceof CustomEvent)) {
        throw new Error('Expected a CustomEvent for plugin tab navigation.');
      }
      const detail: unknown = event.detail;
      if (typeof detail !== 'object' || detail === null || !('tab' in detail)) {
        throw new Error('Expected plugin tab event detail.');
      }
      const tab = detail.tab;
      if (tab !== undefined && typeof tab !== 'string') {
        throw new Error('Expected plugin tab to be a string.');
      }
      tabs.push({ tab });
    };
    const browseListener = (): void => {
      browseEvents += 1;
    };
    window.addEventListener('canopy:plugins-open-tab', tabListener);
    window.addEventListener('canopy:mcp-open-browse', browseListener);

    try {
      const response = await dispatchAppAction({
        requestId: 'req-mcp-open-browse',
        source: 'assistant',
        action: { type: 'plugins.open_mcp_browse' },
      });
      expect(response.ok).toBe(true);
      expect(useNavigationStore.getState().activePage).toBe('plugins');
      expect(browseEvents).toBe(0);
      expect(tabs).toEqual([]);
      expect(
        Reflect.get(useNavigationStore.getState(), 'pendingPluginsNavigation'),
      ).toEqual({ kind: 'browse-apps' });
    } finally {
      window.removeEventListener('canopy:plugins-open-tab', tabListener);
      window.removeEventListener('canopy:mcp-open-browse', browseListener);
    }
  });

  it('routes a plugins management section to its Customize destination', async () => {
    const sections: Array<string | undefined> = [];
    let pageAtEventTime: string | null = null;
    const listener = (event: Event): void => {
      if (!(event instanceof CustomEvent)) {
        throw new Error('Expected a CustomEvent for plugins management.');
      }
      const detail: unknown = event.detail;
      if (
        typeof detail !== 'object' ||
        detail === null ||
        !('section' in detail)
      ) {
        throw new Error('Expected a plugins management event detail.');
      }
      const section = detail.section;
      if (section !== undefined && typeof section !== 'string') {
        throw new Error('Expected the management section to be a string.');
      }
      sections.push(section);
      pageAtEventTime = useNavigationStore.getState().activePage;
    };
    window.addEventListener('canopy:plugins-open-management', listener);

    try {
      const response = await dispatchAppAction({
        requestId: 'req-plugins-open-management',
        source: 'assistant',
        action: { type: 'plugins.open_management', section: 'skills' },
      });
      expect(response.ok).toBe(true);
      expect(response.result).toEqual({ section: 'skills' });
      expect(sections).toEqual([]);
      expect(pageAtEventTime).toBeNull();
      expect(
        Reflect.get(useNavigationStore.getState(), 'pendingPluginsNavigation'),
      ).toEqual({
        kind: 'marketplace-browse',
        query: '',
        tab: 'skill',
        focusSection: 'installed',
        installedExpanded: true,
      });
    } finally {
      window.removeEventListener('canopy:plugins-open-management', listener);
    }
  });

  it('defaults plugins management to the Installed destination', async () => {
    const sections: Array<string | undefined> = [];
    const listener = (event: Event): void => {
      if (!(event instanceof CustomEvent)) {
        throw new Error('Expected a CustomEvent for plugins management.');
      }
      const detail: unknown = event.detail;
      if (
        typeof detail !== 'object' ||
        detail === null ||
        !('section' in detail)
      ) {
        throw new Error('Expected a plugins management event detail.');
      }
      const section = detail.section;
      if (typeof section !== 'string') {
        throw new Error('Expected the management section to be a string.');
      }
      sections.push(section);
    };
    window.addEventListener('canopy:plugins-open-management', listener);

    try {
      const response = await dispatchAppAction({
        requestId: 'req-plugins-open-management-default',
        source: 'assistant',
        action: { type: 'plugins.open_management' },
      });
      expect(response.ok).toBe(true);
      expect(sections).toEqual([]);
      expect(
        Reflect.get(useNavigationStore.getState(), 'pendingPluginsNavigation'),
      ).toEqual({
        kind: 'marketplace-browse',
        query: '',
        tab: 'all',
        focusSection: 'installed',
        installedExpanded: true,
      });
    } finally {
      window.removeEventListener('canopy:plugins-open-management', listener);
    }
  });

  it('opens a plugin connection through the existing detail navigation', async () => {
    const response = await dispatchAppAction({
      requestId: 'plugin-connect',
      source: 'assistant',
      action: {
        type: 'plugins.open_entry_detail',
        entryId: 'mcp-catalog:linear',
        intent: 'connect',
      },
    });
    expect(response.ok).toBe(true);
    expect(useNavigationStore.getState().pendingPluginsNavigation).toEqual({
      kind: 'entry-detail',
      entryId: 'mcp-catalog:linear',
      intent: 'connect',
    });
  });

  it('denies Advisor access to private sign-in pages even with explicit scope ids', async () => {
    const response = await dispatchAppAction({
      requestId: 'private-signin',
      source: 'assistant',
      action: {
        type: 'browser.input_snapshot',
        expectedRuntimeGeneration: 1,
        projectId: 'app-oauth',
        worktreeId: 'mcp',
      },
    });
    expect(response.ok).toBe(false);
    expect(response.error?.message).toContain('Sign-in pages are private');
  });

  it('says sign-in pages are private before asking for a runtime generation', async () => {
    const response = await dispatchAppAction({
      requestId: 'private-signin-no-generation',
      source: 'assistant',
      action: {
        type: 'browser.input_snapshot',
        projectId: 'app-oauth',
        worktreeId: 'mcp',
      },
    });
    expect(response.ok).toBe(false);
    expect(response.error?.message).toContain('Sign-in pages are private');
    expect(response.error?.message).not.toContain('expectedRuntimeGeneration');
  });

  it('opens a Plugins entry detail through a durable deep link', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-plugins-open-entry-detail',
      source: 'assistant',
      action: {
        type: 'plugins.open_entry_detail',
        entryId: 'skill:builtin:app:review-checklist',
      },
    });

    expect(response.ok).toBe(true);
    expect(useNavigationStore.getState().pendingPluginsNavigation).toEqual({
      kind: 'entry-detail',
      entryId: 'skill:builtin:app:review-checklist',
    });
  });

  it('rejects an unknown plugins management section', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-plugins-open-management-invalid',
      source: 'assistant',
      // The renderer validates the section before dispatching so a bad value
      // cannot silently land on the default section.
      action: { type: 'plugins.open_management', section: 'nope' },
    });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('invalid_payload');
  });

  it('opens a supporting file in the skill viewer through a durable deep link', async () => {
    skillsApiMock.readContent.mockResolvedValueOnce({
      success: true,
      data: {
        frontmatter: {
          name: 'review-checklist',
          description: 'Review checklist',
        },
        body: '# Review Checklist',
      },
    });
    skillsApiMock.listFiles.mockResolvedValueOnce({
      success: true,
      data: {
        files: ['SKILL.md', 'references/api.md'],
        truncated: false,
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-skills-open-viewer',
      source: 'assistant',
      action: {
        type: 'skills.open_viewer',
        sourceId: 'custom:app',
        skillName: 'review-checklist',
        filePath: 'references/api.md',
      },
    });

    expect(response).toMatchObject({
      ok: true,
      result: {
        sourceId: 'custom:app',
        skillName: 'review-checklist',
        filePath: 'references/api.md',
      },
    });
    expect(useNavigationStore.getState()).toMatchObject({
      activePage: 'plugins',
      pendingSkillViewer: {
        sourceId: 'custom:app',
        skillName: 'review-checklist',
        filePath: 'references/api.md',
      },
    });
  });

  it('lists, reads, creates, updates, and deletes custom skills', async () => {
    skillsApiMock.loadSkills.mockResolvedValueOnce({
      success: true,
      data: [
        {
          name: 'review-checklist',
          sourceId: 'custom:app',
          description: 'Review checklist',
          source: 'Canopy (custom)',
          installedAt: '2026-05-21T00:00:00.000Z',
          updatedAt: '2026-05-21T00:00:00.000Z',
          updateAvailable: false,
          custom: true,
        },
      ],
    });

    const listResponse = await dispatchAppAction({
      requestId: 'req-skills-list',
      source: 'assistant',
      action: { type: 'skills.list', customOnly: true, query: 'review' },
    });
    expect(listResponse.ok).toBe(true);
    expect(listResponse.result).toMatchObject({
      totalMatches: 1,
      skills: [
        {
          key: 'custom:app/review-checklist',
          name: 'review-checklist',
          custom: true,
        },
      ],
    });

    skillsApiMock.readContent.mockResolvedValueOnce({
      success: true,
      data: {
        frontmatter: {
          name: 'review-checklist',
          description: 'Review checklist',
          owner: 'qa',
        },
        body: '# Review Checklist',
      },
    });
    const readResponse = await dispatchAppAction({
      requestId: 'req-skills-read',
      source: 'assistant',
      action: {
        type: 'skills.read',
        sourceId: 'custom:app',
        skillName: 'review-checklist',
      },
    });
    expect(readResponse.ok).toBe(true);
    expect(readResponse.result).toMatchObject({
      sourceId: 'custom:app',
      skillName: 'review-checklist',
      content: { body: '# Review Checklist' },
    });

    skillsApiMock.readFile.mockResolvedValueOnce({
      success: true,
      data: {
        content: '# API',
        truncated: false,
        binary: false,
      },
    });
    skillsApiMock.listFiles.mockResolvedValueOnce({
      success: true,
      data: {
        files: ['SKILL.md', 'references/api.md'],
        truncated: false,
      },
    });
    const readFileResponse = await dispatchAppAction({
      requestId: 'req-skills-read-file',
      source: 'assistant',
      action: {
        type: 'skills.read_file',
        sourceId: 'custom:app',
        skillName: 'review-checklist',
        filePath: 'references/api.md',
      },
    });
    expect(readFileResponse).toMatchObject({
      ok: true,
      result: {
        sourceId: 'custom:app',
        skillName: 'review-checklist',
        filePath: 'references/api.md',
        file: {
          content: '# API',
          truncated: false,
          binary: false,
        },
      },
    });

    skillsApiMock.saveCustomSkill.mockResolvedValueOnce({
      success: true,
      data: { name: 'review-checklist' },
    });
    const createResponse = await dispatchAppAction({
      requestId: 'req-skills-create',
      source: 'assistant',
      action: {
        type: 'skills.create_custom',
        name: 'review-checklist',
        description: 'Review checklist',
        body: '# Review Checklist',
        extraMetadata: { owner: 'qa' },
      },
    });
    expect(createResponse).toMatchObject({
      ok: true,
      result: {
        name: 'review-checklist',
        agentArtifacts: [
          {
            kind: 'skill',
            operation: 'skills.create_custom',
            installedName: 'review-checklist',
          },
        ],
      },
    });
    expect(skillsApiMock.saveCustomSkill).toHaveBeenCalledWith({
      name: 'review-checklist',
      description: 'Review checklist',
      body: '# Review Checklist',
      extraMetadata: { owner: 'qa' },
    });

    const staleCreateResponse = await dispatchAppAction({
      requestId: 'req-skills-create-stale-revision',
      source: 'assistant',
      expectedUiRevision: 99,
      action: {
        type: 'skills.create_custom',
        name: 'stale-safe-skill',
        description: 'Stale-safe skill',
        body: '# Stale Safe Skill',
      },
    });
    expect(staleCreateResponse.ok).toBe(true);
    expect(skillsApiMock.saveCustomSkill).toHaveBeenLastCalledWith({
      name: 'stale-safe-skill',
      description: 'Stale-safe skill',
      body: '# Stale Safe Skill',
    });

    skillsApiMock.readContent.mockResolvedValueOnce({
      success: true,
      data: {
        frontmatter: {
          name: 'review-checklist',
          description: 'Review checklist',
          owner: 'qa',
        },
        body: '# Review Checklist',
      },
    });
    const updateResponse = await dispatchAppAction({
      requestId: 'req-skills-update',
      source: 'assistant',
      action: {
        type: 'skills.update_custom',
        originalName: 'review-checklist',
        body: '# Updated',
      },
    });
    expect(updateResponse.ok).toBe(true);
    expect(skillsApiMock.saveCustomSkill).toHaveBeenLastCalledWith({
      originalName: 'review-checklist',
      name: 'review-checklist',
      description: 'Review checklist',
      body: '# Updated',
      extraMetadata: { owner: 'qa' },
    });

    const deleteResponse = await dispatchAppAction({
      requestId: 'req-skills-delete',
      source: 'assistant',
      action: { type: 'skills.delete_custom', name: 'review-checklist' },
    });
    expect(deleteResponse.ok).toBe(true);
    expect(skillsApiMock.removeSkill).toHaveBeenCalledWith(
      'custom:app',
      'review-checklist',
    );
  });

  it('rejects App Advisor reads for files absent from the exposed skill list', async () => {
    skillsApiMock.listFiles.mockResolvedValueOnce({
      success: true,
      data: {
        files: ['SKILL.md', 'references/api.md'],
        truncated: false,
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-skills-read-hidden-file',
      source: 'assistant',
      action: {
        type: 'skills.read_file',
        sourceId: 'custom:app',
        skillName: 'review-checklist',
        filePath: '.env',
      },
    });

    expect(response).toMatchObject({
      requestId: 'req-skills-read-hidden-file',
      ok: false,
      error: {
        code: 'invalid_target',
        message: 'File .env is not exposed by custom:app/review-checklist.',
      },
    });
    expect(skillsApiMock.readFile).not.toHaveBeenCalled();
  });

  it('opens, lists, refreshes, and removes plugin marketplaces for App Advisor', async () => {
    const tabEvents: Array<{ tab?: string }> = [];
    const tabListener = (event: Event): void => {
      tabEvents.push((event as CustomEvent<{ tab?: string }>).detail);
    };
    window.addEventListener('canopy:plugins-open-tab', tabListener);
    const marketplace = {
      id: 'acme/plugins',
      name: 'Acme Plugins',
      sourceType: 'github',
      sourceUrl: 'https://github.com/acme/plugins',
      installLocation: '/tmp/acme',
      pluginCount: 1,
      plugins: [],
      providerStatus: {
        claude: {
          provider: 'claude',
          state: 'valid',
          accepted: true,
          pluginCount: 1,
          lastCheckedAt: '2026-05-22T00:00:00.000Z',
        },
        codex: {
          provider: 'codex',
          state: 'invalid',
          accepted: false,
          pluginCount: 0,
          lastCheckedAt: '2026-05-22T00:00:00.000Z',
          error: 'No Codex plugins were detected.',
        },
      },
      validProviders: ['claude'],
    };
    pluginsApiMock.loadMarketplaces.mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-05-22T00:00:00.000Z',
        marketplaces: [marketplace],
      },
    });
    pluginsApiMock.updateMarketplace.mockResolvedValue({
      success: true,
      data: marketplace,
    });
    pluginsApiMock.removeMarketplace.mockResolvedValue({
      success: true,
      data: {
        marketplace: null,
        removedProviders: ['claude'],
        providerOutcomes: {
          claude: { removed: true, alreadyAbsent: false },
          codex: { removed: false, alreadyAbsent: true },
        },
      },
    });

    try {
      const openResponse = await dispatchAppAction({
        requestId: 'req-plugins-open-marketplaces',
        source: 'assistant',
        action: { type: 'plugins.open_marketplaces' },
      });
      expect(openResponse.ok).toBe(true);
      expect(useNavigationStore.getState().activePage).toBe('plugins');
      expect(tabEvents).toEqual([]);
      expect(useNavigationStore.getState().pendingPluginsNavigation).toEqual({
        kind: 'marketplace-source',
        target: 'list',
      });

      const listResponse = await dispatchAppAction({
        requestId: 'req-plugins-list-marketplaces',
        source: 'assistant',
        action: { type: 'plugins.list_marketplaces', query: 'acme' },
      });
      expect(listResponse.ok).toBe(true);
      expect(listResponse.result).toMatchObject({
        totalMatches: 1,
        marketplaces: [
          {
            id: 'acme/plugins',
            validProviders: ['claude'],
            codexError: 'No Codex plugins were detected.',
          },
        ],
      });

      const refreshResponse = await dispatchAppAction({
        requestId: 'req-plugins-refresh-marketplace',
        source: 'assistant',
        action: {
          type: 'plugins.refresh_marketplace',
          marketplaceId: 'acme/plugins',
        },
      });
      expect(refreshResponse.ok).toBe(true);
      expect(pluginsApiMock.updateMarketplace).toHaveBeenCalledWith(
        'acme/plugins',
      );

      const removeResponse = await dispatchAppAction({
        requestId: 'req-plugins-remove-marketplace',
        source: 'assistant',
        action: {
          type: 'plugins.remove_marketplace',
          marketplaceId: 'acme/plugins',
          providers: ['claude'],
        },
      });
      expect(removeResponse.ok).toBe(true);
      expect(pluginsApiMock.removeMarketplace).toHaveBeenCalledWith(
        'acme/plugins',
        { providers: ['claude'] },
      );
      expect(removeResponse.result).toMatchObject({
        marketplaceRemoved: true,
        removedProviders: ['claude'],
      });
    } finally {
      window.removeEventListener('canopy:plugins-open-tab', tabListener);
    }
  });

  it('routes app_advisor.toggle through the App Advisor window IPC and includes uiState in the response', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-4',
      source: 'ui',
      action: { type: 'app_advisor.toggle' },
    });
    expect(response.ok).toBe(true);
    expect(response.uiState).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest matcher inspection only; the method is never invoked here.
    expect(window.api.appAdvisor.toggleWindow).toHaveBeenCalledWith({
      focus: true,
    });
    expect(useNavigationStore.getState().appAdvisorOpen).toBe(true);
  });

  it('rejects stale app_advisor.toggle requests because toggle depends on current UI state', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-4-stale-toggle',
      source: 'assistant',
      expectedUiRevision: 41,
      action: { type: 'app_advisor.toggle' },
    });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('stale_ui_state');
    expect(useNavigationStore.getState().appAdvisorOpen).toBe(false);
  });

  it('routes app_advisor.open through openWindow so an already-visible window is focused/raised rather than toggled away', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-app-advisor-open',
      source: 'ui',
      action: { type: 'app_advisor.open' },
    });
    expect(response.ok).toBe(true);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest matcher inspection only; the method is never invoked here.
    expect(window.api.appAdvisor.openWindow).toHaveBeenCalledWith({
      focus: true,
      focusComposer: true,
    });
    expect(useNavigationStore.getState().appAdvisorOpen).toBe(true);
    expect(response.uiState).toBeDefined();
  });

  it('routes app_advisor.close through closeWindow and syncs visibility back into the navigation store', async () => {
    useNavigationStore.setState({ appAdvisorOpen: true });
    const response = await dispatchAppAction({
      requestId: 'req-app-advisor-close',
      source: 'ui',
      action: { type: 'app_advisor.close' },
    });
    expect(response.ok).toBe(true);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest matcher inspection only; the method is never invoked here.
    expect(window.api.appAdvisor.closeWindow).toHaveBeenCalled();
    expect(useNavigationStore.getState().appAdvisorOpen).toBe(false);
  });

  it('updates App Advisor auto-archive settings without dropping retention', async () => {
    let settingsSavedEvent: Event | undefined;
    const settingsSaved = (event: Event): void => {
      settingsSavedEvent = event;
    };
    window.addEventListener(APP_ADVISOR_SETTINGS_SAVED_EVENT, settingsSaved);
    const response = await dispatchAppAction({
      requestId: 'req-app-advisor-auto-archive',
      source: 'assistant',
      action: { type: 'app_advisor.update_settings', autoArchiveDays: 7 },
    });

    expect(response.ok).toBe(true);
    expect(appAdvisorSettingsSaveMock).toHaveBeenCalledWith({
      archiveRetentionDays: 30,
      autoArchiveDays: 7,
    });
    if (!(settingsSavedEvent instanceof CustomEvent)) {
      throw new Error('Expected App Advisor settings event');
    }
    expect(settingsSavedEvent.detail).toMatchObject({ autoArchiveDays: 7 });
    window.removeEventListener(APP_ADVISOR_SETTINGS_SAVED_EVENT, settingsSaved);
  });

  it('rejects malformed action payloads before routing', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-5',
      source: 'assistant',
      action: {
        type: 'worktree-chat.send_message',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('invalid_payload');
    expect(response.uiState?.revision).toBe(42);
  });

  it('rejects worktree-chat.open_tab when the requested tab does not exist', async () => {
    useChatStore.setState({
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [makeChatTab()],
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-open-missing-chat',
      source: 'assistant',
      action: {
        type: 'worktree-chat.open_tab',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'missing-chat',
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('not_found');
    expect(
      useChatStore.getState().worktreeChats['project-1/worktree-1'].activeTabId,
    ).toBe('chat-1');
  });

  it('opens a new Claude terminal chat tab with the initial message as the launch prompt', async () => {
    useChatStore.setState({
      selectedWorktree: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
      modelDefaults: makeClaudeTerminalModelDefaults(),
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [makeChatTab()],
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-open-new-chat-with-message',
      source: 'assistant',
      action: {
        type: 'worktree-chat.open_tab',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        initialMessage: 'Review the current diff.',
      },
    });

    expect(response.ok).toBe(true);
    const chatId = readStringField(response.result, 'chatId');
    expect(typeof chatId).toBe('string');
    expect(claudeTerminalLaunchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId,
        initialPrompt: 'Review the current diff.',
      }),
    );
    expect(chatApiMock.sendMessage).not.toHaveBeenCalled();
  });

  it('lists worktree chat and file tabs with active state, last user message, and dirty file state', async () => {
    const fileTabWithoutPath = makeFileTab({
      id: 'file-without-path',
      title: 'unsaved',
    });
    delete fileTabWithoutPath.filePath;

    useChatStore.setState({
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'file-1',
          tabs: [
            makeChatTab({
              id: 'chat-active',
              title: 'Active work',
              description: 'Inspecting app actions',
              status: 'streaming',
            }),
            makeFileTab({
              id: 'file-1',
              title: 'notes.md',
              filePath: '/repo/notes.md',
              description: '/repo/notes.md',
            }),
            fileTabWithoutPath,
          ],
        },
      },
    });
    // Mark the shared file session for 'file-1' dirty (single-owner model).
    mockFileSessionDirty.add('file-1');

    const response = await dispatchAppAction({
      requestId: 'req-list-tabs',
      source: 'assistant',
      action: {
        type: 'worktree-chat.list_tabs',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });

    expect(response.ok).toBe(true);
    expect(response.result).toEqual(
      expect.objectContaining({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        activeTabId: 'file-1',
        activeTabKind: 'file',
        chatTabs: [
          expect.objectContaining({
            id: 'chat-active',
            title: 'Active work',
            description: 'Inspecting app actions',
            state: 'active',
            status: 'streaming',
            session: {
              state: 'active',
              expired: false,
              readOnly: false,
              canHandOff: false,
              undeliveredMessagePresent: false,
              undeliveredMessageLength: 0,
              undeliveredFileReferenceCount: 0,
              undeliveredInputMode: null,
            },
            lastUserMessage: {
              id: 'user-2',
              timestamp: 30,
              text: 'Now check the App Advisor transcript.',
              truncated: false,
            },
          }),
        ],
        fileTabs: [
          expect.objectContaining({
            id: 'file-1',
            filePath: '/repo/notes.md',
            unsavedChanges: true,
          }),
          expect.objectContaining({
            id: 'file-without-path',
            filePath: null,
            unsavedChanges: false,
          }),
        ],
      }),
    );
  });

  it('switches the active worktree tab for file tabs', async () => {
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [
            makeChatTab({ id: 'chat-1' }),
            makeFileTab({ id: 'file-1', filePath: '/repo/notes.md' }),
          ],
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-switch-file-tab',
      source: 'assistant',
      action: {
        type: 'worktree-chat.switch_tab',
        tabId: 'file-1',
      },
    });

    expect(response.ok).toBe(true);
    expect(response.result).toEqual(
      expect.objectContaining({
        activeTabId: 'file-1',
        activeTabKind: 'file',
      }),
    );
    expect(
      useChatStore.getState().worktreeChats['project-1/worktree-1'].activeTabId,
    ).toBe('file-1');
  });

  it('exposes expired session state in chat history responses', async () => {
    useChatStore.setState({
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [
            makeChatTab({
              readOnly: true,
              staleSessionDetected: {
                droppedMessageText: 'Please retry this after the session died.',
                droppedInputMode: 'typed',
              },
            }),
          ],
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-expired-history',
      source: 'assistant',
      action: {
        type: 'worktree-chat.get_last_user_message',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    });

    expect(response.ok).toBe(true);
    expect(response.result).toEqual(
      expect.objectContaining({
        session: {
          state: 'expired',
          expired: true,
          readOnly: true,
          canHandOff: true,
          undeliveredMessagePresent: true,
          undeliveredMessageLength: 41,
          undeliveredFileReferenceCount: 0,
          undeliveredInputMode: 'typed',
        },
      }),
    );
  });

  it('runs the hand-off chat action for an expired worktree chat', async () => {
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [
            makeChatTab({
              id: 'chat-1',
              messages: [
                {
                  id: 'user-prev',
                  role: 'user',
                  timestamp: 1,
                  blocks: [{ type: 'text', text: 'Previous request' }],
                },
                {
                  id: 'user-dropped',
                  role: 'user',
                  timestamp: 2,
                  blocks: [{ type: 'text', text: 'Retry this change' }],
                },
              ],
              readOnly: true,
              staleSessionDetected: {
                droppedMessageText: 'Retry this change',
              },
            }),
          ],
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-chat-action-handoff',
      source: 'assistant',
      action: {
        type: 'worktree-chat.run_chat_action',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        action: 'hand_off',
      },
    });

    const wc = useChatStore.getState().worktreeChats['project-1/worktree-1'];
    expect(response.ok).toBe(true);
    expect(chatApiMock.generateHandoffSummary).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      conversationText: 'User: Previous request',
      kind: 'stale-session',
      chatId: 'chat-1',
    });
    expect(chatApiMock.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        text: `[SESSION HANDOFF]\n\nThis is a continuation of a previous chat session. Below is a summary of what was discussed. Use this context to continue seamlessly.\n\n---\nhandoff summary\n---\n\nRetry this change`,
      }),
    );
    expect(wc.tabs).toHaveLength(2);
    expect(wc.activeTabId).not.toBe('chat-1');
    expect(wc.tabs.find((tab) => tab.id === 'chat-1')).toEqual(
      expect.objectContaining({
        readOnly: true,
        staleSessionDetected: undefined,
      }),
    );
  });

  it('runs fork and branch chat actions through the worktree chat store', async () => {
    type CreateWorktree = ReturnType<
      typeof useProjectsStore.getState
    >['createWorktree'];
    const createWorktree = jest
      .fn<ReturnType<CreateWorktree>, Parameters<CreateWorktree>>()
      .mockResolvedValue({ id: 'branched-worktree' });
    useProjectsStore.setState({ createWorktree });
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [makeChatTab({ id: 'chat-1', providerType: 'claude' })],
        },
      },
    });

    const fork = await dispatchAppAction({
      requestId: 'req-chat-action-fork',
      source: 'assistant',
      action: {
        type: 'worktree-chat.run_chat_action',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        action: 'fork',
      },
    });
    const forkedActive =
      useChatStore.getState().worktreeChats['project-1/worktree-1'].activeTabId;

    const branch = await dispatchAppAction({
      requestId: 'req-chat-action-branch',
      source: 'assistant',
      action: {
        type: 'worktree-chat.run_chat_action',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        action: 'branch',
      },
    });

    expect(fork.ok).toBe(true);
    expect(forkedActive).not.toBe('chat-1');
    expect(fork.result).toEqual(
      expect.objectContaining({ activeTabId: forkedActive }),
    );
    expect(branch.ok).toBe(true);
    expect(createWorktree).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        baseWorktreeId: 'worktree-1',
        select: false,
      }),
    );
    expect(createWorktree.mock.calls[0]?.[1]?.onRegistered).toBeInstanceOf(
      Function,
    );
    expect(branch.result).toEqual(
      expect.objectContaining({
        projectId: 'project-1',
        worktreeId: 'branched-worktree',
        sourceChatId: 'chat-1',
      }),
    );
    expect(
      useChatStore.getState().worktreeChats['project-1/branched-worktree']
        .activeTabId,
    ).toBeTruthy();
  });

  it('reports a cancelled assistant chat branch without falling back to the source', async () => {
    const createWorktree = jest.fn().mockResolvedValue({
      id: 'branched-worktree',
    });
    useProjectsStore.setState({
      createWorktree,
      uncommittedChanges: { 'project-1/worktree-1': true },
      refreshWorktreeDiffStatsVerified: jest.fn().mockResolvedValue(true),
    });
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [makeChatTab({ id: 'chat-1', providerType: 'claude' })],
        },
      },
    });

    const responsePromise = dispatchAppAction({
      requestId: 'req-chat-action-branch-cancelled',
      source: 'assistant',
      action: {
        type: 'worktree-chat.run_chat_action',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        action: 'branch',
      },
    });

    for (
      let attempt = 0;
      attempt < 5 && useBranchFromStore.getState().pending === null;
      attempt += 1
    ) {
      await Promise.resolve();
    }
    useBranchFromStore.getState().resolveConfirmation(null);
    const response = await responsePromise;

    expect(response).toEqual(
      expect.objectContaining({
        ok: false,
        error: {
          code: 'execution_failed',
          message: 'Worktree creation was cancelled.',
          retryable: false,
        },
      }),
    );
    expect(createWorktree).not.toHaveBeenCalled();
    expect(useChatStore.getState().selectedWorktree).toEqual({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
  });

  it('runs a request id again after a retryable failure and replays its success', async () => {
    const createWorktree = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'worktree-new' });
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
      pendingWorkspaceRepair: null,
      createWorktree,
    });
    const create = (): ReturnType<typeof dispatchAppAction> =>
      dispatchAppAction({
        requestId: 'req-worktree-create-retried',
        source: 'assistant',
        action: { type: 'worktree.create', workspaceId: 'project-1' },
      });

    await expect(create()).resolves.toMatchObject({
      ok: false,
      error: { retryable: true },
    });
    await expect(create()).resolves.toMatchObject({
      ok: true,
      result: { worktreeId: 'worktree-new' },
    });
    await expect(create()).resolves.toMatchObject({
      ok: true,
      result: { worktreeId: 'worktree-new' },
    });
    expect(createWorktree).toHaveBeenCalledTimes(2);
  });

  it('creates assistant branches from dirty sources without opening confirmation', async () => {
    const createWorktree = jest.fn().mockResolvedValue({ id: 'worktree-new' });
    const refreshWorktreeDiffStatsVerified = jest.fn().mockResolvedValue(true);
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
      uncommittedChanges: { 'project-1/worktree-1': true },
      refreshWorktreeDiffStatsVerified,
      createWorktree,
    });

    const response = await dispatchAppAction({
      requestId: 'req-worktree-create-from-dirty-base',
      source: 'assistant',
      action: {
        type: 'worktree.create',
        workspaceId: 'project-1',
        baseWorktreeId: 'worktree-1',
      },
    });

    expect(refreshWorktreeDiffStatsVerified).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
    );
    expect(useBranchFromStore.getState().pending).toBeNull();
    expect(createWorktree).toHaveBeenCalledWith('project-1', {
      baseWorktreeId: 'worktree-1',
      suppressStartPage: true,
    });
    expect(response.ok).toBe(true);
  });

  it('returns a retryable status failure without opening confirmation', async () => {
    const createWorktree = jest.fn().mockResolvedValue({ id: 'worktree-new' });
    const refreshWorktreeDiffStatsVerified = jest.fn().mockResolvedValue(true);
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
      uncommittedChanges: { 'project-1/worktree-1': true },
      refreshWorktreeDiffStatsVerified,
      createWorktree,
    });

    refreshWorktreeDiffStatsVerified.mockResolvedValue(false);
    await expect(
      dispatchAppAction({
        requestId: 'req-worktree-create-status-unavailable',
        source: 'assistant',
        action: {
          type: 'worktree.create',
          workspaceId: 'project-1',
          baseWorktreeId: 'worktree-1',
        },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        error: {
          code: 'execution_failed',
          message: 'Fresh source worktree status could not be verified.',
          retryable: true,
        },
      }),
    );
    expect(useBranchFromStore.getState().pending).toBeNull();
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it('worktree.create_from resolves a branch source and creates the worktree', async () => {
    const createWorktree = jest.fn().mockResolvedValue({ id: 'worktree-new' });
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
      createWorktree,
    });

    const response = await dispatchAppAction({
      requestId: 'req-worktree-create-from-branch',
      source: 'assistant',
      action: {
        type: 'worktree.create_from',
        workspaceId: 'project-1',
        source: 'branch',
        reference: 'feature/foo',
      },
    });

    expect(createWorktree).toHaveBeenCalledWith('project-1', {
      existingBranch: 'feature/foo',
      suppressStartPage: true,
    });
    expect(response.ok).toBe(true);
    expect(response.result).toEqual(
      expect.objectContaining({
        workspaceId: 'project-1',
        worktreeId: 'worktree-new',
        resolved: 'branch feature/foo',
      }),
    );
  });

  it('worktree.create forwards an explicit base branch without a base-worktree preflight', async () => {
    const createWorktree = jest.fn().mockResolvedValue({ id: 'worktree-new' });
    const refreshWorktreeDiffStatsVerified = jest.fn();
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
      createWorktree,
      refreshWorktreeDiffStatsVerified,
    });

    const response = await dispatchAppAction({
      requestId: 'req-worktree-create-from-base-branch',
      source: 'assistant',
      action: {
        type: 'worktree.create',
        workspaceId: 'project-1',
        baseBranch: 'release/next',
      },
    });

    expect(createWorktree).toHaveBeenCalledWith('project-1', {
      baseBranch: 'release/next',
      suppressStartPage: true,
    });
    expect(refreshWorktreeDiffStatsVerified).not.toHaveBeenCalled();
    expect(response.ok).toBe(true);
  });

  it('validates create base sources before dispatch', () => {
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'worktree.create',
        workspaceId: 'project-1',
        baseBranch: 'release/next',
      }),
    ).toBe(true);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'worktree.create',
        workspaceId: 'project-1',
        baseWorktreeId: 'worktree-1',
        baseBranch: 'release/next',
      }),
    ).toBe(false);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'worktree.create_from',
        workspaceId: 'project-1',
        source: 'branch',
        reference: 'feature/source',
        baseBranch: '   ',
      }),
    ).toBe(false);
  });

  it('worktree.create_from keeps the resolved branch checkout authoritative and tracks an explicit base branch', async () => {
    const createWorktree = jest.fn().mockResolvedValue({ id: 'worktree-new' });
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
      createWorktree,
    });

    const response = await dispatchAppAction({
      requestId: 'req-worktree-create-from-branch-with-base',
      source: 'assistant',
      action: {
        type: 'worktree.create_from',
        workspaceId: 'project-1',
        source: 'branch',
        reference: 'feature/foo',
        baseBranch: 'develop',
      },
    });

    expect(createWorktree).toHaveBeenCalledWith('project-1', {
      existingBranch: 'feature/foo',
      baseBranch: 'develop',
      suppressStartPage: true,
    });
    expect(response.ok).toBe(true);
  });

  it('worktree.set_notification_level saves the space choice through the shared store', async () => {
    const scope = { projectId: 'project-1', worktreeId: 'worktree-1' };
    const unset = {
      accountKey: 'user-1',
      writesEnabled: true,
      serverOffsetMs: 0,
      syncedAt: null,
      spaces: {
        'project-1\u001fworktree-1': {
          notificationSpaceId: 'space-1',
          revision: 0,
          override: null,
          transitions: [],
        },
      },
    };
    const saved = {
      ...unset,
      spaces: {
        'project-1\u001fworktree-1': {
          ...unset.spaces['project-1\u001fworktree-1'],
          revision: 1,
          override: 'attention',
        },
      },
    };
    const set = jest
      .fn()
      .mockResolvedValue({ status: 'saved', snapshot: saved });
    const refresh = jest.fn().mockResolvedValue(unset);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...window.api,
        spaceNotifications: {
          getSnapshot: jest.fn(),
          refresh,
          set,
          onChanged: jest.fn((): (() => void) => (): void => {}),
        },
      },
    });
    useSpaceNotificationStore.setState({ snapshot: unset, progress: {} });
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
    });

    // A target that isn't a local worktree is rejected before the server
    // registers it, rather than saving against an orphan space.
    const unknown = await dispatchAppAction({
      requestId: 'req-worktree-notifications-unknown',
      source: 'assistant',
      action: {
        type: 'worktree.set_notification_level',
        projectId: 'project-1',
        worktreeId: 'no-such-worktree',
        level: 'mute',
      },
    });
    expect(unknown).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(refresh).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();

    const response = await dispatchAppAction({
      requestId: 'req-worktree-notifications',
      source: 'assistant',
      action: {
        type: 'worktree.set_notification_level',
        ...scope,
        level: 'attention',
      },
    });

    expect(set).toHaveBeenCalledWith({
      ...scope,
      override: 'attention',
      expectedRevision: 0,
    });
    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error(
        response.error?.message ?? 'Action failed without an error detail',
      );
    }
    expect(response.result).toMatchObject({ level: 'attention' });

    // All activity clears the override, as the row menu does, rather than
    // storing an explicit `all`.
    refresh.mockResolvedValueOnce(saved);
    set.mockResolvedValueOnce({
      status: 'saved',
      snapshot: {
        ...unset,
        spaces: {
          'project-1\u001fworktree-1': {
            ...unset.spaces['project-1\u001fworktree-1'],
            revision: 2,
          },
        },
      },
    });
    const all = await dispatchAppAction({
      requestId: 'req-worktree-notifications-all',
      source: 'assistant',
      action: {
        type: 'worktree.set_notification_level',
        ...scope,
        level: 'all',
      },
    });
    expect(set).toHaveBeenLastCalledWith({
      ...scope,
      override: null,
      expectedRevision: 1,
    });
    expect(all.ok).toBe(true);

    const invalid = await dispatchAppAction({
      requestId: 'req-worktree-notifications-invalid',
      source: 'assistant',
      action: {
        type: 'worktree.set_notification_level',
        ...scope,
        level: 'loud',
      },
    });
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: 'invalid_payload' },
    });
  });

  it('worktree.set_base_branch validates and persists an available local branch', async () => {
    const setTrackedBaseBranch = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...window.api,
        listBranches: jest.fn().mockResolvedValue({
          branches: [
            {
              name: 'develop',
              isRemote: false,
              isCurrent: false,
              isUsedByWorktree: false,
              hasLocalRef: true,
              hasRemoteRef: false,
            },
          ],
        }),
      },
    });
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
      setTrackedBaseBranch,
    });

    const response = await dispatchAppAction({
      requestId: 'req-worktree-set-base-branch',
      source: 'assistant',
      action: {
        type: 'worktree.set_base_branch',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        baseBranch: 'develop',
      },
    });

    expect(setTrackedBaseBranch).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'develop',
      undefined,
      { existsLocally: true, existsInRemote: false },
    );
    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error(
        response.error?.message ?? 'Action failed without an error detail',
      );
    }
    expect(response.result).toMatchObject({ baseBranch: 'develop' });
  });

  it('rejects a whitespace-only worktree.set_base_branch payload', async () => {
    const listBranches = jest.fn();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ...window.api, listBranches },
    });
    const response = await dispatchAppAction({
      requestId: 'req-worktree-set-base-branch-blank',
      source: 'assistant',
      action: {
        type: 'worktree.set_base_branch',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        baseBranch: '   ',
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('invalid_payload');
    expect(listBranches).not.toHaveBeenCalled();
  });

  it('resolves the visible branch-from confirmation', async () => {
    const confirmation = useBranchFromStore
      .getState()
      .requestConfirmation('project-1', 'worktree-1');
    const pending = useBranchFromStore.getState().pending;
    if (!pending) throw new Error('Expected a pending confirmation.');

    const response = await dispatchAppAction({
      requestId: 'req-resolve-branch-from-confirmation',
      source: 'assistant',
      expectedUiRevision: 42,
      action: {
        type: 'worktree.resolve_branch_from_confirmation',
        confirmationId: pending.confirmationId,
        projectId: pending.projectId,
        worktreeId: pending.worktreeId,
        choice: 'commit-first',
      },
    });

    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      choice: 'commit-first',
    });
    await expect(confirmation).resolves.toBe('commit-first');
    expect(useBranchFromStore.getState().pending).toBeNull();
  });

  it('rejects branch-from confirmation actions when no modal is open', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-resolve-missing-branch-from-confirmation',
      source: 'assistant',
      expectedUiRevision: 42,
      action: {
        type: 'worktree.resolve_branch_from_confirmation',
        confirmationId: 'missing-confirmation',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        choice: 'cancel',
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('not_found');
  });

  it('rejects a stale response for a replaced branch-from confirmation', async () => {
    const firstConfirmation = useBranchFromStore
      .getState()
      .requestConfirmation('project-1', 'worktree-1');
    const firstPending = useBranchFromStore.getState().pending;
    if (!firstPending) throw new Error('Expected the first confirmation.');

    const currentConfirmation = useBranchFromStore
      .getState()
      .requestConfirmation('project-2', 'worktree-2');

    const response = await dispatchAppAction({
      requestId: 'req-resolve-stale-branch-from-confirmation',
      source: 'assistant',
      expectedUiRevision: 42,
      action: {
        type: 'worktree.resolve_branch_from_confirmation',
        confirmationId: firstPending.confirmationId,
        projectId: firstPending.projectId,
        worktreeId: firstPending.worktreeId,
        choice: 'commit-first',
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('stale_ui_state');
    expect(useBranchFromStore.getState().pending).toMatchObject({
      projectId: 'project-2',
      worktreeId: 'worktree-2',
    });
    await expect(firstConfirmation).resolves.toBeNull();
    useBranchFromStore.getState().resolveConfirmation(null);
    await expect(currentConfirmation).resolves.toBeNull();
  });

  it('requires a UI revision for assistant branch-from confirmations', async () => {
    const confirmation = useBranchFromStore
      .getState()
      .requestConfirmation('project-1', 'worktree-1');
    const pending = useBranchFromStore.getState().pending;
    if (!pending) throw new Error('Expected a pending confirmation.');

    const response = await dispatchAppAction({
      requestId: 'req-resolve-branch-from-without-revision',
      source: 'assistant',
      action: {
        type: 'worktree.resolve_branch_from_confirmation',
        confirmationId: pending.confirmationId,
        projectId: pending.projectId,
        worktreeId: pending.worktreeId,
        choice: 'cancel',
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('invalid_payload');
    expect(useBranchFromStore.getState().pending).toBe(pending);
    useBranchFromStore.getState().resolveConfirmation(null);
    await expect(confirmation).resolves.toBeNull();
  });

  it('resolves the visible base-branch alignment confirmation', async () => {
    const confirmation = useBaseBranchAlignmentStore
      .getState()
      .requestConfirmation('project-1', 'worktree-1', [
        {
          repoId: 'repo-1',
          repoName: 'App',
          localBaseBranch: 'main',
          prBaseBranch: 'release/next',
          prNumber: 42,
        },
      ]);
    const pending = useBaseBranchAlignmentStore.getState().pending;
    if (!pending) throw new Error('Expected a pending confirmation.');

    const response = await dispatchAppAction({
      requestId: 'req-resolve-base-branch-alignment',
      source: 'assistant',
      expectedUiRevision: 42,
      action: {
        type: 'github.resolve_base_branch_alignment',
        confirmationId: pending.confirmationId,
        projectId: pending.projectId,
        worktreeId: pending.worktreeId,
        choice: 'confirm',
      },
    });

    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      choice: 'confirm',
    });
    await expect(confirmation).resolves.toBe(true);
    expect(useBaseBranchAlignmentStore.getState().pending).toBeNull();
  });

  it('refuses renderer worktree sends without dispatching a user message', async () => {
    useChatStore.setState({
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [makeChatTab()],
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-send-chat',
      source: 'assistant',
      action: {
        type: 'worktree-chat.send_message',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        text: 'Please continue.',
      },
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'unsupported_action' },
    });
    expect(chatApiMock.sendMessage).not.toHaveBeenCalled();
  });

  it('refuses worktree-chat actions that target the retired plan chat scope', async () => {
    // Plan discussion happens in the worktree's ordinary chats; a legacy
    // plan-explore chat is never selected as a worktree or sent to (it would
    // run an invisible session).
    useChatStore.setState({
      selectedWorktree: null,
      worktreeChats: {
        [`${PLAN_EXPLORE_CHAT_PROJECT_ID}/plan-1`]: {
          activeTabId: 'plan-chat-1',
          tabs: [makeChatTab({ id: 'plan-chat-1' })],
        },
      },
    });

    const send = await dispatchAppAction({
      requestId: 'req-send-retired-plan-chat',
      source: 'assistant',
      action: {
        type: 'worktree-chat.send_message',
        projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
        worktreeId: 'plan-1',
        chatId: 'plan-chat-1',
        text: 'Please continue.',
      },
    });
    const read = await dispatchAppAction({
      requestId: 'req-read-retired-plan-chat',
      source: 'assistant',
      action: {
        type: 'worktree-chat.read_history',
        projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
        worktreeId: 'plan-1',
        chatId: 'plan-chat-1',
      },
    });
    const list = await dispatchAppAction({
      requestId: 'req-list-retired-plan-chat',
      source: 'assistant',
      action: {
        type: 'worktree-chat.list_tabs',
        projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
        worktreeId: 'plan-1',
      },
    });

    for (const response of [send, read, list]) {
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('invalid_payload');
      expect(response.error?.message).toContain('projectId');
    }
    // Never selected as a worktree.
    expect(useChatStore.getState().selectedWorktree).toBeNull();
    expect(chatApiMock.sendMessage).not.toHaveBeenCalled();
  });

  it('refuses legacy steering because main owns message controls', async () => {
    const dispatchChatCommand = jest
      .fn()
      .mockResolvedValue('accepted' as const);
    useChatStore.setState({
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [makeChatTab()],
        },
      },
      dispatchChatCommand,
    });

    const response = await dispatchAppAction({
      requestId: 'req-steer-queued-chat',
      source: 'assistant',
      action: {
        type: 'worktree-chat.steer_queued_message',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        queuedMessageId: 'queued-1',
      },
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'unsupported_action' },
    });
    expect(dispatchChatCommand).not.toHaveBeenCalled();
  });

  it('hydrates a still-loading new worktree before opening its chat tab', async () => {
    const original = useChatStore.getState();
    const hydrate = jest.fn(() => {
      useChatStore.setState({
        worktreeChats: {
          'project-1/worktree-1': {
            activeTabId: 'chat-1',
            tabs: [makeChatTab()],
          },
        },
      });
      return Promise.resolve('installed' as const);
    });
    useChatStore.setState({
      worktreeChats: {},
      // A concurrent load already owns the loading key, so this returns early.
      loadTabsForTarget: jest.fn(async () => {}),
      hydrateChatScopeRevisioned: hydrate,
    });
    try {
      const response = await dispatchAppAction({
        requestId: 'req-open-new-worktree-chat',
        source: 'assistant',
        action: {
          type: 'worktree-chat.open_tab',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
        },
      });
      expect(response).toMatchObject({
        ok: true,
        result: { chatId: 'chat-1' },
      });
      expect(hydrate).toHaveBeenCalledWith('project-1', 'worktree-1');
    } finally {
      useChatStore.setState(original);
    }
  });

  it('runs only the StartBranchedAgent host send through the renderer setup queue', async () => {
    const original = useChatStore.getState();
    const hydrate = jest.fn(() => {
      useChatStore.setState({
        worktreeChats: {
          'project-1/worktree-1': {
            activeTabId: 'chat-1',
            tabs: [makeChatTab()],
          },
        },
      });
      return Promise.resolve('installed' as const);
    });
    const send = jest.fn(async () => {});
    useChatStore.setState({
      worktreeChats: {},
      loadTabsForTarget: jest.fn(async () => {}),
      selectWorktree: jest.fn(),
      hydrateChatScopeRevisioned: hydrate,
      sendMessage: send,
    });
    try {
      const response = await dispatchAppAction({
        requestId: 'req-branched-continue',
        source: 'assistant',
        hostSend: 'start_branched_agent',
        action: {
          type: 'worktree-chat.send_message',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          text: 'Continue',
          queueForSetup: true,
        },
      });
      expect(response).toMatchObject({ ok: true });
      expect(hydrate).toHaveBeenCalledWith('project-1', 'worktree-1');
      expect(send).toHaveBeenCalledWith(
        'Continue',
        undefined,
        { projectId: 'project-1', worktreeId: 'worktree-1', chatId: 'chat-1' },
        undefined,
        { throwOnDispatchFailure: true, queueForSetup: true },
      );
    } finally {
      useChatStore.setState(original);
    }
  });

  it('refuses renderer setup sends without hydration or dispatch', async () => {
    const original = useChatStore.getState();
    let finishHydration: (() => void) | undefined;
    const hydration = new Promise<void>((resolve) => {
      finishHydration = resolve;
    });
    const hydrate = jest.fn(async () => {
      await hydration;
      useChatStore.setState({
        worktreeChats: {
          'project-1/worktree-1': {
            activeTabId: 'chat-1',
            tabs: [makeChatTab()],
          },
        },
      });
      return 'installed' as const;
    });
    const send = jest.fn(async () => {});
    useChatStore.setState({
      worktreeChats: {},
      // A concurrent load already owns the loading key, so this returns early.
      loadTabsForTarget: jest.fn(async () => {}),
      selectWorktree: jest.fn(),
      hydrateChatScopeRevisioned: hydrate,
      sendMessage: send,
    });
    try {
      const pending = dispatchAppAction({
        requestId: 'req-send-new-branch',
        source: 'assistant',
        action: {
          type: 'worktree-chat.send_message',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          text: 'Start the independent task.',
          queueForSetup: true,
        },
      });
      expect(send).not.toHaveBeenCalled();
      if (!finishHydration) {
        throw new Error('Expected hydration completion callback.');
      }
      finishHydration();
      const response = await pending;
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'unsupported_action' },
      });
      expect(hydrate).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    } finally {
      useChatStore.setState(original);
    }
  });

  it('refuses renderer terminal sends without pasting or submitting', async () => {
    useChatStore.setState({
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [
            makeChatTab({
              interfaceMode: 'claude-code',
              providerType: 'claude',
            }),
          ],
        },
      },
    });
    useClaudeTerminalStore.setState({
      byChat: {
        'project-1/worktree-1/chat-1': {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          terminalId: 'terminal-1',
          sessionKey: 'session-key',
          turnState: 'running',
          launchStatus: 'ready',
        },
      },
      terminalIdIndex: { 'terminal-1': 'project-1/worktree-1/chat-1' },
      inFlightLaunch: {},
    });
    claudeTerminalGetStateMock.mockResolvedValueOnce({
      terminalId: 'terminal-1',
      sessionKey: 'session-key',
      turnState: 'running',
      readyForInput: true,
    });

    const response = await dispatchAppAction({
      requestId: 'req-send-terminal-chat',
      source: 'assistant',
      action: {
        type: 'worktree-chat.send_message',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        text: 'Queue this in Claude Code.',
      },
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'unsupported_action' },
    });
    expect(chatApiMock.sendMessage).not.toHaveBeenCalled();
    expect(terminalWriteMock).not.toHaveBeenCalled();
  });

  it('rejects worktree-chat.send_message for missing tabs before dispatching', async () => {
    useChatStore.setState({
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [makeChatTab()],
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-send-missing-chat',
      source: 'assistant',
      action: {
        type: 'worktree-chat.send_message',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'missing-chat',
        text: 'Please continue.',
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('unsupported_action');
    expect(chatApiMock.sendMessage).not.toHaveBeenCalled();
  });

  it('refuses legacy scheduling because main owns message controls', async () => {
    automationsApiMock.create.mockResolvedValueOnce({
      ok: true,
      activity: { id: 'scheduled-1' },
    });
    useChatStore.setState({
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [makeChatTab({ title: 'Current chat' })],
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-schedule-chat',
      source: 'assistant',
      action: {
        type: 'worktree-chat.schedule_message',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        text: 'Continue',
        runAt: '2099-01-01T00:00:00.000Z',
        timezone: 'local',
        name: 'Resume this chat',
        fileReferences: [
          {
            displayPath: 'src/app.ts',
            absolutePath: '/repo/src/app.ts',
          },
        ],
        attachmentPaths: ['/tmp/context.txt'],
        attachmentPromptContexts: [
          {
            attachmentPath: '/tmp/context.txt',
            promptKind: 'in-app-browser-resource',
          },
        ],
        inputMode: 'typed',
      },
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'unsupported_action' },
    });
    expect(automationsApiMock.create).not.toHaveBeenCalled();
    expect(chatApiMock.sendMessage).not.toHaveBeenCalled();
  });

  it('rejects worktree-chat.schedule_message for missing tabs before creating an automation', async () => {
    useChatStore.setState({
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [makeChatTab()],
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-schedule-missing-chat',
      source: 'assistant',
      action: {
        type: 'worktree-chat.schedule_message',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'missing-chat',
        text: 'Continue',
        runAt: '2099-01-01T00:00:00.000Z',
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('unsupported_action');
    expect(automationsApiMock.create).not.toHaveBeenCalled();
  });

  it('creates a local custom pipeline from YAML without opening the editor', async () => {
    const rawYaml =
      'pipeline:\n  name: New pipeline\n  description: Created by advisor\n  on: dispatch\n  jobs:\n    test:\n      steps:\n        - uses: builtin/agent-prompt\n          with:\n            prompt: Review the project.\n';
    pipelinesApiMock.save.mockResolvedValue({
      success: true,
      data: makePipelineInfo({
        id: 'created-1',
        name: 'New pipeline',
        description: 'Created by advisor',
      }),
    });

    const response = await dispatchAppAction({
      requestId: 'req-6',
      source: 'assistant',
      action: { type: 'pipeline.create', rawYaml },
    });
    expect(response.ok).toBe(true);
    expect(pipelinesApiMock.save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'New pipeline',
        description: 'Created by advisor',
      }),
    );
    const saveCalls = pipelinesApiMock.save.mock.calls as Array<
      [{ id?: string }]
    >;
    expect(saveCalls[0]?.[0]).not.toHaveProperty('id');
    expect(useNavigationStore.getState().workflowEdit).toBeUndefined();
  });

  it('creates and deletes resource payloads even when expectedUiRevision is stale', async () => {
    const rawYaml =
      'pipeline:\n  name: Stale-safe pipeline\n  on: dispatch\n  jobs:\n    test:\n      steps:\n        - uses: builtin/agent-prompt\n          with:\n            prompt: Review the project.\n';
    pipelinesApiMock.save.mockResolvedValue({
      success: true,
      data: makePipelineInfo({
        id: 'stale-safe-pipeline',
        name: 'Stale-safe pipeline',
      }),
    });
    pipelinesApiMock.delete.mockResolvedValue({ success: true });
    const collectionsApi = window.collections as unknown as {
      saveCollection: jest.Mock;
      deleteCollection: jest.Mock;
    };
    collectionsApi.saveCollection.mockResolvedValue({
      id: 'stale-safe-collection',
      name: 'Stale-safe Collection',
      skills: [],
      plugins: [],
      mcpServers: [],
    });
    collectionsApi.deleteCollection.mockResolvedValue(undefined);

    const pipelineResponse = await dispatchAppAction({
      requestId: 'req-pipeline-create-stale-revision',
      source: 'assistant',
      expectedUiRevision: 99,
      action: { type: 'pipeline.create', rawYaml },
    });
    const collectionResponse = await dispatchAppAction({
      requestId: 'req-collection-create-stale-revision',
      source: 'assistant',
      expectedUiRevision: 99,
      action: {
        type: 'collections.create',
        name: 'Stale-safe Collection',
      },
    });
    const pipelineDeleteResponse = await dispatchAppAction({
      requestId: 'req-pipeline-delete-stale-revision',
      source: 'assistant',
      expectedUiRevision: 99,
      action: { type: 'pipeline.delete', pipelineId: 'stale-safe-pipeline' },
    });
    const collectionDeleteResponse = await dispatchAppAction({
      requestId: 'req-collection-delete-stale-revision',
      source: 'assistant',
      expectedUiRevision: 99,
      action: {
        type: 'collections.delete',
        id: 'stale-safe-collection',
      },
    });

    expect(pipelineResponse.ok).toBe(true);
    expect(collectionResponse.ok).toBe(true);
    expect(pipelineDeleteResponse.ok).toBe(true);
    expect(collectionDeleteResponse.ok).toBe(true);
    expect(collectionsApi.saveCollection).toHaveBeenCalledWith({
      name: 'Stale-safe Collection',
      skills: [],
      plugins: [],
      mcpServers: [],
    });
    expect(pipelinesApiMock.delete).toHaveBeenCalledWith('stale-safe-pipeline');
    expect(collectionsApi.deleteCollection).toHaveBeenCalledWith(
      'stale-safe-collection',
    );
  });

  it('lists curated metadata without downloading', async () => {
    const info = makePipelineInfo({
      id: 'curated:review',
      name: 'Curated review',
      source: 'curated',
      readonly: true,
      triggerTypes: ['dispatch'],
      curatedContentHash: 'a'.repeat(64),
    });
    getWorktreePathMock.mockResolvedValue('/repo');
    pipelinesApiMock.list.mockResolvedValue({ success: true, data: [info] });
    pipelinesApiMock.discoverProject.mockResolvedValue({
      success: true,
      data: [],
    });
    const listed = await dispatchAppAction({
      requestId: 'managed-curated-list',
      source: 'assistant',
      action: { type: 'pipeline.list' },
    });
    expect(listed.ok).toBe(true);
    expect(JSON.stringify(listed.result)).toContain('curated:review');
    expect(pipelinesApiMock.get).not.toHaveBeenCalled();
  });

  it('opens shared and project pipeline editors with source-specific locators', async () => {
    const sharedResponse = await dispatchAppAction({
      requestId: 'open-shared',
      source: 'assistant',
      action: {
        type: 'pipeline.open_editor',
        pipelineId: 'shared-local',
        sharedRemoteId: 'remote-1',
      },
    });
    expect(sharedResponse.ok).toBe(true);
    expect(useNavigationStore.getState().workflowEdit).toEqual({
      kind: 'pipeline',
      pipelineId: null,
      sharedRemoteId: 'remote-1',
    });

    getWorktreePathMock.mockResolvedValue('/repo');
    pipelinesApiMock.discoverProject.mockResolvedValue({
      success: true,
      data: [
        makePipelineInfo({
          id: 'project--build.yaml',
          source: 'project',
          filePath: '/repo/.canopy/pipelines/build.yaml',
        }),
      ],
    });
    const projectResponse = await dispatchAppAction({
      requestId: 'open-project',
      source: 'assistant',
      action: {
        type: 'pipeline.open_editor',
        pipelineId: 'project--build.yaml',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        repoId: 'child-repo',
      },
    });
    expect(projectResponse.ok).toBe(true);
    expect(getWorktreePathMock).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      repoId: 'child-repo',
    });
    expect(useNavigationStore.getState().workflowEdit).toEqual({
      kind: 'pipeline',
      pipelineId: 'project--build.yaml',
      cwd: '/repo',
      filePath: '/repo/.canopy/pipelines/build.yaml',
    });

    const invalidRepoResponse = await dispatchAppAction({
      requestId: 'open-project-invalid-repo',
      source: 'assistant',
      action: {
        type: 'pipeline.open_editor',
        pipelineId: 'project--build.yaml',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        repoId: 42,
      },
    });
    expect(invalidRepoResponse).toMatchObject({
      ok: false,
      error: { code: 'invalid_payload' },
    });
  });

  it('opens a pipeline editor on the requested shell section (CAN-4072)', async () => {
    const response = await dispatchAppAction({
      requestId: 'open-section',
      source: 'assistant',
      action: {
        type: 'pipeline.open_editor',
        pipelineId: 'user-pipeline',
        section: 'runs',
      },
    });
    expect(response.ok).toBe(true);
    expect(useNavigationStore.getState()).toMatchObject({
      activePage: 'workflows-library',
      workflowEdit: {
        kind: 'pipeline',
        pipelineId: 'user-pipeline',
        section: 'runs',
      },
    });

    const invalid = await dispatchAppAction({
      requestId: 'open-invalid-section',
      source: 'assistant',
      action: {
        type: 'pipeline.open_editor',
        pipelineId: 'user-pipeline',
        section: 'history',
      },
    });
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: 'invalid_payload' },
    });
  });

  it('opens an automation editor, with or without a shell section (CAN-4072)', async () => {
    const plain = await dispatchAppAction({
      requestId: 'open-automation',
      source: 'assistant',
      action: { type: 'automation.open_editor', id: 'act-1' },
    });
    expect(plain).toMatchObject({ ok: true, result: { activityId: 'act-1' } });
    expect(useNavigationStore.getState()).toMatchObject({
      activePage: 'workflows-library',
      workflowEdit: { kind: 'automation', activityId: 'act-1' },
    });
    expect(useNavigationStore.getState().workflowEdit).not.toHaveProperty(
      'section',
    );

    const sectioned = await dispatchAppAction({
      requestId: 'open-automation-trigger',
      source: 'assistant',
      action: {
        type: 'automation.open_editor',
        id: 'act-1',
        section: 'trigger',
      },
    });
    expect(sectioned.ok).toBe(true);
    expect(useNavigationStore.getState().workflowEdit).toEqual({
      kind: 'automation',
      activityId: 'act-1',
      section: 'trigger',
    });

    const invalid = await dispatchAppAction({
      requestId: 'open-automation-invalid',
      source: 'assistant',
      action: { type: 'automation.open_editor', id: 'act-1', section: 7 },
    });
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: 'invalid_payload' },
    });
  });

  it('navigates to a curated pipeline preview', async () => {
    const response = await dispatchAppAction({
      requestId: 'open-curated-preview',
      source: 'assistant',
      action: {
        type: 'pipeline.open_curated_preview',
        key: 'review-code',
      },
    });

    expect(response.ok).toBe(true);
    expect(useNavigationStore.getState()).toMatchObject({
      activePage: 'plugins',
      pendingCuratedPipelinePreviewKey: 'review-code',
    });
  });

  it('lists and gets pipeline details with run modes and input metadata', async () => {
    const pipelineContent = {
      name: 'Plan review',
      description: 'Review plans',
      on: {
        dispatch: {
          inputs: {
            target: { description: 'Target suite', required: true },
          },
        },
        plan_ready: {
          inputs: {
            reviewer: {
              type: 'choice',
              options: ['fast', 'deep'],
              default: 'fast',
            },
          },
        },
      },
      jobs: {
        review: {
          steps: [{ run: 'echo review' }],
        },
      },
    };
    getWorktreePathMock.mockResolvedValue('/repo');
    pipelinesApiMock.list.mockResolvedValue({
      success: true,
      data: [],
    });
    pipelinesApiMock.discoverProject.mockResolvedValue({
      success: true,
      data: [
        makePipelineInfo({
          id: 'plan-review',
          name: 'Plan review',
          description: 'Review plans',
          source: 'project',
          filePath: '/repo/.canopy/pipelines/review.yaml',
          triggerTypes: ['dispatch', 'plan_ready'],
        }),
      ],
    });
    pipelinesApiMock.get.mockResolvedValue({
      success: true,
      data: {
        info: makePipelineInfo({
          id: 'plan-review',
          name: 'Plan review',
          description: 'Review plans',
          source: 'project',
          filePath: '/repo/.canopy/pipelines/review.yaml',
        }),
        content: pipelineContent,
      },
    });

    const list = await dispatchAppAction({
      requestId: 'req-pipeline-list',
      source: 'assistant',
      action: {
        type: 'pipeline.list',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        query: 'plan rev',
        runModes: ['plan_ready'],
      },
    });
    const get = await dispatchAppAction({
      requestId: 'req-pipeline-get',
      source: 'assistant',
      action: {
        type: 'pipeline.get',
        pipelineId: 'plan-review',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        includeYaml: true,
      },
    });

    expect(list.ok).toBe(true);
    expect(JSON.stringify(list.result)).toContain('"id":"plan-review"');
    expect(JSON.stringify(list.result)).toContain('"enabled":true');
    expect(JSON.stringify(list.result)).toContain('"mode":"plan_ready"');
    expect(get.ok).toBe(true);
    expect(JSON.stringify(get.result)).toContain('"name":"reviewer"');
    expect(JSON.stringify(get.result)).toContain('pipeline:');
  });

  it('can include disabled pipelines in App Advisor pipeline listings', async () => {
    loadPreferencesMock.mockResolvedValue({
      disabledPipelineIds: ['disabled-pipeline'],
    });
    getWorktreePathMock.mockResolvedValue('/repo');
    pipelinesApiMock.list.mockResolvedValue({
      success: true,
      data: [
        makePipelineInfo({
          id: 'enabled-pipeline',
          name: 'Enabled pipeline',
          source: 'user',
          triggerTypes: ['dispatch'],
        }),
        makePipelineInfo({
          id: 'disabled-pipeline',
          name: 'Disabled pipeline',
          source: 'user',
          triggerTypes: ['dispatch'],
        }),
      ],
    });
    pipelinesApiMock.discoverProject.mockResolvedValue({
      success: true,
      data: [],
    });
    pipelinesApiMock.get.mockImplementation(({ id }: { id: string }) =>
      Promise.resolve({
        success: true,
        data: {
          info: makePipelineInfo({
            id,
            name:
              id === 'disabled-pipeline'
                ? 'Disabled pipeline'
                : 'Enabled pipeline',
            source: 'user',
          }),
          content: {
            name:
              id === 'disabled-pipeline'
                ? 'Disabled pipeline'
                : 'Enabled pipeline',
            on: 'dispatch',
            jobs: { test: { steps: [] } },
          },
        },
      }),
    );

    const hiddenByDefault = await dispatchAppAction({
      requestId: 'req-pipeline-list-disabled-default',
      source: 'assistant',
      action: {
        type: 'pipeline.list',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });
    const includeDisabled = await dispatchAppAction({
      requestId: 'req-pipeline-list-disabled-included',
      source: 'assistant',
      action: {
        type: 'pipeline.list',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        includeDisabled: true,
      },
    });

    expect(hiddenByDefault.ok).toBe(true);
    expect(JSON.stringify(hiddenByDefault.result)).toContain(
      '"id":"enabled-pipeline"',
    );
    expect(JSON.stringify(hiddenByDefault.result)).not.toContain(
      '"id":"disabled-pipeline"',
    );
    expect(includeDisabled.ok).toBe(true);
    expect(JSON.stringify(includeDisabled.result)).toContain(
      '"id":"disabled-pipeline"',
    );
    expect(JSON.stringify(includeDisabled.result)).toContain('"enabled":false');
  });

  it('updates pipeline enabled state through App Advisor', async () => {
    setPipelineDisabledPreferenceMock.mockResolvedValueOnce({
      disabledPipelineIds: ['Nightly_Build'],
    });

    const response = await dispatchAppAction({
      requestId: 'req-pipeline-set-enabled',
      source: 'assistant',
      action: {
        type: 'pipeline.set_enabled',
        pipelineId: 'Nightly_Build',
        enabled: false,
      },
    });

    expect(response.ok).toBe(true);
    expect(setPipelineDisabledPreferenceMock).toHaveBeenCalledWith({
      id: 'Nightly_Build',
      disabled: true,
    });
    expect(JSON.stringify(response.result)).toContain('"enabled":false');
    expect(JSON.stringify(response.result)).toContain('Nightly_Build');
  });

  it('emits a receipt when updating a project pipeline enabled state', async () => {
    const projectPipeline = makePipelineInfo({
      id: 'project-pipeline',
      name: 'Project pipeline',
      source: 'project',
      filePath: '/repo/.canopy/pipelines/project.yml',
    });
    getWorktreePathMock.mockResolvedValue('/repo');
    pipelinesApiMock.list.mockResolvedValue({ success: true, data: [] });
    pipelinesApiMock.discoverProject.mockResolvedValue({
      success: true,
      data: [projectPipeline],
    });
    pipelinesApiMock.get.mockResolvedValue({
      success: true,
      data: {
        info: projectPipeline,
        content: {
          name: 'Project pipeline',
          on: 'dispatch',
          jobs: { test: { steps: [] } },
        },
      },
    });
    setPipelineDisabledPreferenceMock.mockResolvedValue({
      disabledPipelineIds: ['project-pipeline'],
    });

    const response = await dispatchAppAction({
      requestId: 'req-project-pipeline-set-enabled',
      source: 'assistant',
      action: {
        type: 'pipeline.set_enabled',
        pipelineId: 'project-pipeline',
        enabled: false,
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });

    expect(response).toMatchObject({
      ok: true,
      result: {
        agentArtifacts: [
          expect.objectContaining({
            kind: 'pipeline',
            localId: 'project-pipeline',
            source: 'project',
          }),
        ],
      },
    });
    expect(getWorktreePathMock).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    expect(pipelinesApiMock.discoverProject).toHaveBeenCalledWith('/repo');
  });

  it('lists pipeline details when disabled pipeline ids fail to load', async () => {
    loadPreferencesMock.mockRejectedValueOnce(
      new Error('Preferences unavailable'),
    );
    getWorktreePathMock.mockResolvedValue('/repo');
    pipelinesApiMock.list.mockResolvedValue({
      success: true,
      data: [
        makePipelineInfo({
          id: 'local-pipeline',
          name: 'Local pipeline',
          source: 'user',
          triggerTypes: ['dispatch'],
        }),
      ],
    });
    pipelinesApiMock.discoverProject.mockResolvedValue({
      success: true,
      data: [],
    });
    pipelinesApiMock.get.mockResolvedValue({
      success: true,
      data: {
        info: makePipelineInfo({
          id: 'local-pipeline',
          name: 'Local pipeline',
          source: 'user',
        }),
        content: {
          name: 'Local pipeline',
          on: 'dispatch',
          jobs: { test: { steps: [] } },
        },
      },
    });

    const list = await dispatchAppAction({
      requestId: 'req-pipeline-list-preferences-failure',
      source: 'assistant',
      action: {
        type: 'pipeline.list',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });

    expect(list.ok).toBe(true);
    expect(JSON.stringify(list.result)).toContain('"id":"local-pipeline"');
  });

  it('updates, deletes, and duplicates local custom pipelines', async () => {
    const rawYaml =
      'pipeline:\n  name: Updated pipeline\n  description: Updated by advisor\n  icon: rocket\n  on: dispatch\n  jobs:\n    test:\n      steps:\n        - uses: builtin/agent-prompt\n          with:\n            prompt: Review the project.\n';
    pipelinesApiMock.save.mockResolvedValue({
      success: true,
      data: makePipelineInfo({
        id: 'custom-1',
        name: 'Renamed pipeline',
        description: 'Updated by advisor',
        icon: 'rocket',
      }),
    });
    pipelinesApiMock.delete.mockResolvedValue({ success: true });
    pipelinesApiMock.list.mockResolvedValue({
      success: true,
      data: [
        makePipelineInfo({
          id: 'custom-1',
          name: 'Updated pipeline',
          source: 'user',
        }),
      ],
    });
    pipelinesApiMock.discoverProject.mockResolvedValue({
      success: true,
      data: [],
    });
    pipelinesApiMock.get.mockResolvedValue({
      success: true,
      data: {
        info: makePipelineInfo({
          id: 'custom-1',
          name: 'Updated pipeline',
          source: 'user',
        }),
        content: {
          name: 'Updated pipeline',
          on: 'dispatch',
          jobs: { test: { steps: [] } },
        },
      },
    });
    pipelinesApiMock.duplicate.mockResolvedValue({
      success: true,
      data: makePipelineInfo({
        id: 'custom-copy',
        name: 'Updated pipeline (Copy)',
      }),
    });

    const update = await dispatchAppAction({
      requestId: 'req-pipeline-update',
      source: 'assistant',
      action: {
        type: 'pipeline.update',
        pipelineId: 'custom-1',
        rawYaml,
        name: 'Renamed pipeline',
      },
    });
    const remove = await dispatchAppAction({
      requestId: 'req-pipeline-delete',
      source: 'assistant',
      action: { type: 'pipeline.delete', pipelineId: 'custom-1' },
    });
    const duplicate = await dispatchAppAction({
      requestId: 'req-pipeline-duplicate',
      source: 'assistant',
      action: { type: 'pipeline.duplicate', pipelineId: 'custom-1' },
    });

    expect(update.ok).toBe(true);
    expect(remove.ok).toBe(true);
    expect(duplicate.ok).toBe(true);
    expect(pipelinesApiMock.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'custom-1',
        name: 'Renamed pipeline',
        description: 'Updated by advisor',
        icon: 'rocket',
      }),
    );
    const saveCalls = pipelinesApiMock.save.mock.calls as Array<
      [{ content?: { name?: string; description?: string } }]
    >;
    const saveRequest = saveCalls[0]?.[0];
    expect(saveRequest.content).toMatchObject({
      name: 'Renamed pipeline',
      description: 'Updated by advisor',
    });
    expect(pipelinesApiMock.delete).toHaveBeenCalledWith('custom-1');
    expect(pipelinesApiMock.duplicate).toHaveBeenCalledWith({
      id: 'custom-1',
      source: 'user',
    });
  });

  it('rejects duplicating pipelines with shell run steps', async () => {
    getWorktreePathMock.mockResolvedValue('/repo');
    pipelinesApiMock.list.mockResolvedValue({ success: true, data: [] });
    pipelinesApiMock.discoverProject.mockResolvedValue({
      success: true,
      data: [
        makePipelineInfo({
          id: 'project--unsafe.yaml',
          name: 'Unsafe project pipeline',
          source: 'project',
          filePath: '/repo/.canopy/pipelines/unsafe.yaml',
        }),
      ],
    });
    pipelinesApiMock.get.mockResolvedValue({
      success: true,
      data: {
        info: makePipelineInfo({
          id: 'project--unsafe.yaml',
          name: 'Unsafe project pipeline',
          source: 'project',
          filePath: '/repo/.canopy/pipelines/unsafe.yaml',
        }),
        content: {
          name: 'Unsafe project pipeline',
          on: 'dispatch',
          jobs: { test: { steps: [{ run: 'printenv' }] } },
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-pipeline-duplicate-unsafe',
      source: 'assistant',
      action: {
        type: 'pipeline.duplicate',
        pipelineId: 'project--unsafe.yaml',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect(response.error?.message).toContain('cannot include shell run steps');
    expect(pipelinesApiMock.duplicate).not.toHaveBeenCalled();
  });

  it('updates local pipeline metadata without requiring YAML', async () => {
    pipelinesApiMock.get.mockResolvedValue({
      success: true,
      data: {
        info: makePipelineInfo({
          id: 'custom-1',
          name: 'Original pipeline',
        }),
        content: {
          name: 'Original pipeline',
          description: 'Original description',
          icon: 'original',
          on: 'dispatch',
          jobs: { test: { steps: [{ run: 'echo trusted' }] } },
        },
      },
    });
    pipelinesApiMock.save.mockResolvedValue({
      success: true,
      data: makePipelineInfo({
        id: 'custom-1',
        name: 'Renamed pipeline',
        description: 'Updated description',
        icon: 'updated',
      }),
    });

    const response = await dispatchAppAction({
      requestId: 'req-pipeline-update-metadata-only',
      source: 'assistant',
      action: {
        type: 'pipeline.update',
        pipelineId: 'custom-1',
        name: 'Renamed pipeline',
        description: 'Updated description',
        icon: 'updated',
      },
    });

    expect(response.ok).toBe(true);
    expect(pipelinesApiMock.get).toHaveBeenCalledWith({
      id: 'custom-1',
      source: 'user',
    });
    expect(pipelinesApiMock.save).toHaveBeenCalledWith({
      id: 'custom-1',
      name: 'Renamed pipeline',
      description: 'Updated description',
      icon: 'updated',
      content: {
        name: 'Renamed pipeline',
        description: 'Updated description',
        icon: 'updated',
        on: 'dispatch',
        jobs: { test: { steps: [{ run: 'echo trusted' }] } },
      },
    });
  });

  it('creates and updates pipelines from YAML file paths', async () => {
    const readFileContent = window.api.readFileContent as jest.Mock;
    readFileContent.mockResolvedValue({
      kind: 'text',
      content:
        'pipeline:\n  name: File pipeline\n  on: dispatch\n  jobs:\n    test:\n      steps:\n        - uses: builtin/agent-prompt\n          with:\n            prompt: Review the project.\n',
      filename: 'pipeline.yaml',
      sizeBytes: 99,
      truncated: false,
      modifiedAtMs: 2,
    });
    pipelinesApiMock.save
      .mockResolvedValueOnce({
        success: true,
        data: makePipelineInfo({
          id: 'created-from-file',
          name: 'File pipeline',
        }),
      })
      .mockResolvedValueOnce({
        success: true,
        data: makePipelineInfo({
          id: 'custom-1',
          name: 'File pipeline',
        }),
      });

    const create = await dispatchAppAction({
      requestId: 'req-pipeline-create-file',
      source: 'assistant',
      action: {
        type: 'pipeline.create',
        yamlFilePath: '/repo/.canopy/pipelines/pipeline.yaml',
      },
    });
    const update = await dispatchAppAction({
      requestId: 'req-pipeline-update-file',
      source: 'assistant',
      action: {
        type: 'pipeline.update',
        pipelineId: 'custom-1',
        yamlFilePath: '/repo/.canopy/pipelines/pipeline.yaml',
      },
    });

    expect(create.ok).toBe(true);
    expect(update.ok).toBe(true);
    expect(readFileContent).toHaveBeenCalledWith({
      absolutePath: '/repo/.canopy/pipelines/pipeline.yaml',
    });
    const saveCalls = pipelinesApiMock.save.mock.calls as Array<
      [{ id?: string }]
    >;
    expect(saveCalls[0]?.[0]).not.toHaveProperty('id');
    expect(saveCalls[1]?.[0]).toMatchObject({ id: 'custom-1' });
  });

  it.each(['pipeline.create', 'pipeline.update'] as const)(
    'rejects shell run steps from %s YAML',
    async (type) => {
      const response = await dispatchAppAction({
        requestId: `req-${type}-unsafe-yaml`,
        source: 'assistant',
        action:
          type === 'pipeline.create'
            ? {
                type,
                rawYaml:
                  'pipeline:\n  name: Unsafe pipeline\n  on: dispatch\n  jobs:\n    test:\n      steps:\n        - run: printenv\n',
              }
            : {
                type,
                pipelineId: 'custom-1',
                rawYaml:
                  'pipeline:\n  name: Unsafe pipeline\n  on: dispatch\n  jobs:\n    test:\n      steps:\n        - run: printenv\n',
              },
      });

      expect(response).toMatchObject({
        ok: false,
        error: { code: 'validation_failed' },
      });
      expect(response.error?.message).toContain(
        'cannot include shell run steps',
      );
      expect(pipelinesApiMock.save).not.toHaveBeenCalled();
    },
  );

  it('rejects pipeline create YAML that fails pipeline validation', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-pipeline-create-invalid-yaml',
      source: 'assistant',
      action: {
        type: 'pipeline.create',
        rawYaml:
          'pipeline:\n  name: Invalid pipeline\n  on: dispatch\n  jobs:\n    bad-name:\n      steps: []\n',
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('invalid_payload');
    expect(response.error?.message).toContain('Invalid job key');
    expect(pipelinesApiMock.save).not.toHaveBeenCalled();
  });

  it('shares local pipelines and updates or deletes shared pipelines', async () => {
    pipelinesApiMock.list.mockResolvedValue({
      success: true,
      data: [
        makePipelineInfo({
          id: 'custom-1',
          name: 'Custom pipeline',
          description: 'Local custom pipeline',
          source: 'user',
        }),
      ],
    });
    pipelinesApiMock.get.mockResolvedValue({
      success: true,
      data: {
        info: makePipelineInfo({
          id: 'custom-1',
          name: 'Custom pipeline',
          description: 'Local custom pipeline',
          source: 'user',
        }),
        content: {
          name: 'Custom pipeline',
          description: 'Local custom pipeline',
          on: 'dispatch',
          jobs: { test: { steps: [] } },
        },
      },
    });
    pipelinesApiMock.createShared.mockResolvedValue({
      success: true,
      data: makeSharedPipelineDetail({
        id: 'remote-1',
        name: 'Custom pipeline',
      }),
    });
    pipelinesApiMock.delete.mockResolvedValue({ success: true });
    pipelinesApiMock.getShared.mockResolvedValue({
      success: true,
      data: makeSharedPipelineDetail({
        id: 'remote-1',
        rawPipeline:
          'pipeline:\n  name: Shared pipeline\n  description: Original description\n  on: dispatch\n  jobs:\n    test:\n      steps: []\n',
      }),
    });
    pipelinesApiMock.updateShared.mockResolvedValue({
      success: true,
      data: makeSharedPipelineDetail({
        id: 'remote-1',
        name: 'Renamed shared pipeline',
      }),
    });
    pipelinesApiMock.deleteShared.mockResolvedValue({ success: true });

    const share = await dispatchAppAction({
      requestId: 'req-pipeline-share',
      source: 'assistant',
      action: {
        type: 'pipeline.share',
        pipelineId: 'custom-1',
        shareScope: 'team',
        teamId: 'team-1',
        deleteLocal: true,
      },
    });
    const updateShared = await dispatchAppAction({
      requestId: 'req-pipeline-update-shared',
      source: 'assistant',
      action: {
        type: 'pipeline.update_shared',
        pipelineId: 'shared:canopy-cloud:remote-1',
        name: 'Renamed shared pipeline',
      },
    });
    const deleteShared = await dispatchAppAction({
      requestId: 'req-pipeline-delete-shared',
      source: 'assistant',
      action: {
        type: 'pipeline.delete_shared',
        pipelineId: 'shared:canopy-cloud:remote-1',
      },
    });

    expect(share.ok).toBe(true);
    expect(updateShared.ok).toBe(true);
    expect(deleteShared.ok).toBe(true);
    expect(pipelinesApiMock.createShared).toHaveBeenCalledWith(
      expect.objectContaining({
        shareScope: 'team',
        teamId: 'team-1',
      }),
    );
    const createSharedCalls = pipelinesApiMock.createShared.mock.calls as Array<
      [{ rawPipeline?: string }]
    >;
    const createSharedRequest = createSharedCalls[0]?.[0];
    expect(createSharedRequest.rawPipeline).toContain('Custom pipeline');
    expect(createSharedRequest).not.toHaveProperty('serverId');
    // `deleteLocal: true` is ignored: sharing keeps the local pipeline.
    expect(pipelinesApiMock.delete).not.toHaveBeenCalled();
    expect(share).toMatchObject({
      result: { deletedLocal: false, deleteLocalError: null },
    });
    expect(pipelinesApiMock.getShared).toHaveBeenCalledWith({
      remoteId: 'remote-1',
    });
    expect(pipelinesApiMock.updateShared).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteId: 'remote-1',
      }),
    );
    const updateSharedCalls = pipelinesApiMock.updateShared.mock.calls as Array<
      [
        {
          remoteId: string;
          rawPipeline?: string;
        },
      ]
    >;
    const updateSharedRequest = updateSharedCalls[0]?.[0];
    expect(updateSharedRequest.rawPipeline).toContain(
      'Renamed shared pipeline',
    );
    expect(updateSharedRequest).not.toHaveProperty('serverId');
    expect(pipelinesApiMock.deleteShared).toHaveBeenCalledWith({
      remoteId: 'remote-1',
    });
  });

  it('rejects shell run steps from shared pipeline update YAML', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-pipeline-update-shared-unsafe-yaml',
      source: 'assistant',
      action: {
        type: 'pipeline.update_shared',
        remoteId: 'remote-1',
        rawYaml:
          'pipeline:\n  name: Unsafe shared pipeline\n  on: dispatch\n  jobs:\n    test:\n      steps:\n        - run: printenv\n',
      },
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect(response.error?.message).toContain('cannot include shell run steps');
    expect(pipelinesApiMock.updateShared).not.toHaveBeenCalled();
  });

  it('adds the approval note to non-interactive shared pipeline updates with affected automations', async () => {
    pipelinesApiMock.getSharedUpdateImpact.mockResolvedValueOnce({
      success: true,
      data: {
        automations: [
          { id: 'activity-1', name: 'Nightly review', kind: 'installed' },
        ],
      },
    });
    pipelinesApiMock.updateShared.mockResolvedValueOnce({
      success: true,
      data: makeSharedPipelineDetail({ id: 'remote-1' }),
    });

    const response = await dispatchAppAction({
      requestId: 'req-pipeline-update-shared-impact',
      source: 'assistant',
      action: {
        type: 'pipeline.update_shared',
        remoteId: 'remote-1',
        rawYaml:
          'pipeline:\n  name: Shared pipeline\n  on: dispatch\n  jobs:\n    test:\n      steps: []\n',
      },
    });

    expect(response).toMatchObject({
      ok: true,
      result: {
        message:
          'People using this pipeline in their automations will need to approve your changes before they run again.',
      },
    });
    expect(pipelinesApiMock.getSharedUpdateImpact).toHaveBeenCalledWith(
      'remote-1',
    );
  });

  it('does not expose the internal Cloud id in shared pipeline target errors', async () => {
    const updateShared = await dispatchAppAction({
      requestId: 'req-pipeline-update-shared-invalid-id',
      source: 'assistant',
      action: {
        type: 'pipeline.update_shared',
        pipelineId: 'shared:other-cloud:remote-1',
        name: 'Updated shared pipeline',
      },
    });
    const deleteShared = await dispatchAppAction({
      requestId: 'req-pipeline-delete-shared-invalid-id',
      source: 'assistant',
      action: {
        type: 'pipeline.delete_shared',
        pipelineId: 'shared:other-cloud:remote-1',
      },
    });

    expect(updateShared.ok).toBe(false);
    expect(updateShared.error?.message).toBe(
      'Provide remoteId or select a shared pipeline before retrying.',
    );
    expect(updateShared.error?.message).not.toContain('canopy-cloud');
    expect(deleteShared.ok).toBe(false);
    expect(deleteShared.error?.message).toBe(
      'Provide remoteId or select a shared pipeline before retrying.',
    );
    expect(deleteShared.error?.message).not.toContain('canopy-cloud');
  });

  it('lists, inspects, reads, and controls pipeline executions', async () => {
    const state = makeExecutionState();
    pipelinesApiMock.listExecutions.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'execution-1',
          pipeline_id: 'pipe-1',
          pipeline_name: 'Project pipeline',
          status: 'failure',
          started_at: '2026-05-20T00:00:00.000Z',
          completed_at: '2026-05-20T00:01:00.000Z',
          cwd: '/repo',
          project_id: 'project-1',
          worktree_id: 'worktree-1',
          event_name: 'plan_ready',
          has_report: true,
          has_plan: true,
          plan_modified: true,
        },
      ],
    });
    pipelinesApiMock.getExecution.mockResolvedValue({
      success: true,
      data: state,
    });
    pipelinesApiMock.readReportFile.mockResolvedValue({
      success: true,
      data: { filePath: '/tmp/report.md', content: '# Report' },
    });
    pipelinesApiMock.cancelExecution.mockResolvedValue({
      success: true,
      data: state,
    });
    pipelinesApiMock.retryMatrixJob.mockResolvedValue(state);
    pipelinesApiMock.cancelMatrixVariant.mockResolvedValue(state);
    pipelinesApiMock.resumeAutomation.mockResolvedValue({
      success: true,
      data: state,
    });
    pipelinesApiMock.retryExecution.mockResolvedValue({
      success: true,
      data: state,
    });
    pipelinesApiMock.rerunExecution.mockResolvedValue({
      success: true,
      data: { ...state, id: 'execution-2' },
    });
    getWorktreePathMock.mockResolvedValue('/repo');
    pipelinesApiMock.list.mockResolvedValue({
      success: true,
      data: [
        makePipelineInfo({
          id: 'follow-up',
          name: 'Follow up',
          triggerTypes: ['plan_ready'],
        }),
      ],
    });
    pipelinesApiMock.discoverProject.mockResolvedValue({
      success: true,
      data: [],
    });
    pipelinesApiMock.get.mockResolvedValue({
      success: true,
      data: {
        info: makePipelineInfo({
          id: 'follow-up',
          name: 'Follow up',
          triggerTypes: ['plan_ready'],
        }),
        content: {
          name: 'Follow up',
          on: 'plan_ready',
          jobs: { review: { steps: [] } },
        },
      },
    });
    pipelinesApiMock.execute.mockResolvedValue({
      success: true,
      data: { ...state, id: 'execution-3' },
    });

    const list = await dispatchAppAction({
      requestId: 'req-execution-list',
      source: 'assistant',
      action: {
        type: 'pipeline.execution_list_for_worktree',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        status: 'failure',
      },
    });
    const inspect = await dispatchAppAction({
      requestId: 'req-execution-get',
      source: 'assistant',
      action: {
        type: 'pipeline.execution_get',
        executionId: 'execution-1',
        includeReport: true,
        includePlan: true,
      },
    });
    const cancel = await dispatchAppAction({
      requestId: 'req-execution-cancel',
      source: 'assistant',
      action: {
        type: 'pipeline.execution_cancel',
        executionId: 'execution-1',
      },
    });
    const resume = await dispatchAppAction({
      requestId: 'req-execution-resume',
      source: 'assistant',
      action: {
        type: 'pipeline.execution_resume',
        executionId: 'execution-1',
        statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
      },
    });
    const retryMatrix = await dispatchAppAction({
      requestId: 'req-execution-retry-matrix',
      source: 'assistant',
      action: {
        type: 'pipeline.execution_retry_matrix_job',
        executionId: 'execution-1',
        jobId: 'review',
        mode: 'failed',
      },
    });
    const cancelMatrixVariant = await dispatchAppAction({
      requestId: 'req-execution-cancel-matrix-variant',
      source: 'assistant',
      action: {
        type: 'pipeline.execution_cancel_matrix_variant',
        executionId: 'execution-1',
        jobId: 'review',
        variantJobId: '__matrix__review__0',
      },
    });
    const retry = await dispatchAppAction({
      requestId: 'req-execution-retry',
      source: 'assistant',
      action: {
        type: 'pipeline.execution_retry',
        executionId: 'execution-1',
      },
    });
    const startOver = await dispatchAppAction({
      requestId: 'req-execution-start-over',
      source: 'assistant',
      action: {
        type: 'pipeline.execution_start_over',
        executionId: 'execution-1',
      },
    });
    const chain = await dispatchAppAction({
      requestId: 'req-execution-chain',
      source: 'assistant',
      action: {
        type: 'pipeline.execution_chain',
        executionId: 'execution-1',
        pipelineId: 'follow-up',
        inputs: { reviewer: 'fast' },
      },
    });

    expect(list.ok).toBe(true);
    expect(JSON.stringify(list.result)).toContain('Execution description');
    expect(inspect.ok).toBe(true);
    expect(JSON.stringify(inspect.result)).toContain('# Report');
    expect(JSON.stringify(inspect.result)).toContain('# Plan');
    expect(cancel.ok).toBe(true);
    expect(resume.ok).toBe(true);
    expect(resume.result).toMatchObject({
      id: 'execution-1',
      agentArtifacts: [
        expect.objectContaining({
          kind: 'pipeline_run',
          operation: 'pipeline.execution_resume',
          executionId: 'execution-1',
        }),
      ],
    });
    expect(retry).toMatchObject({
      ok: true,
      result: {
        agentArtifacts: [
          expect.objectContaining({
            kind: 'pipeline_run',
            operation: 'pipeline.execution_retry',
            executionId: 'execution-1',
          }),
        ],
      },
    });
    expect(retryMatrix.ok).toBe(true);
    expect(cancelMatrixVariant.ok).toBe(true);
    expect(startOver.ok).toBe(true);
    expect(chain.ok).toBe(true);
    expect(chain.result).toMatchObject({
      agentArtifacts: [
        expect.objectContaining({
          kind: 'pipeline_run',
          operation: 'pipeline.execution_chain',
          executionId: 'execution-3',
        }),
      ],
    });
    expect(pipelinesApiMock.cancelExecution).toHaveBeenCalledWith(
      'execution-1',
    );
    expect(pipelinesApiMock.resumeAutomation).toHaveBeenCalledWith(
      'execution-1',
      {
        statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
      },
    );
    expect(pipelinesApiMock.retryMatrixJob).toHaveBeenCalledWith({
      executionId: 'execution-1',
      jobId: 'review',
      mode: 'failed',
    });
    expect(pipelinesApiMock.cancelMatrixVariant).toHaveBeenCalledWith({
      executionId: 'execution-1',
      jobId: 'review',
      variantJobId: '__matrix__review__0',
    });
    expect(pipelinesApiMock.retryExecution).toHaveBeenCalledWith('execution-1');
    expect(pipelinesApiMock.rerunExecution).toHaveBeenCalledWith('execution-1');
    expect(pipelinesApiMock.execute).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        eventName: 'plan_ready',
        eventData: { plan_ready: { plan_path: '/tmp/plan.md' } },
        inputs: { reviewer: 'fast' },
      }),
    );
  });

  it('rejects unsafe resume execution ids before invoking the pipeline API', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-unsafe-execution-resume',
      source: 'assistant',
      action: {
        type: 'pipeline.execution_resume',
        executionId: '../outside',
        statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({
      code: 'invalid_payload',
      message: 'Action pipeline.execution_resume has invalid executionId.',
    });
    expect(pipelinesApiMock.resumeAutomation).not.toHaveBeenCalled();
  });

  it('reports pending input requests and forwards pause responses when resuming', async () => {
    const paused = makeExecutionState({
      status: 'paused',
      completed_at: undefined,
      pending_pauses: [
        {
          id: 'checkpoint-1',
          kind: 'input',
          job_id: 'review',
          logical_job_id: 'review',
          step_id: 'approval',
          attempt: 0,
          iteration: 1,
          detected_at: '2026-05-20T00:00:30.000Z',
          request: {
            title: 'Approval required',
            message: 'Choose a reviewer.',
            fields: [],
          },
        },
      ],
    });
    pipelinesApiMock.getExecution.mockResolvedValue({
      success: true,
      data: paused,
    });
    pipelinesApiMock.resumeAutomation.mockResolvedValue({
      success: true,
      data: { ...paused, status: 'running', pending_pauses: [] },
    });

    const inspected = await dispatchAppAction({
      requestId: 'req-pause-input-inspect',
      source: 'assistant',
      action: {
        type: 'pipeline.execution_get',
        executionId: 'execution-1',
      },
    });
    expect(inspected).toMatchObject({
      ok: true,
      result: {
        execution: {
          status: 'paused',
          inputRequested: true,
          inputRequests: [
            {
              checkpointId: 'checkpoint-1',
              request: { title: 'Approval required' },
            },
          ],
        },
      },
    });

    const resumed = await dispatchAppAction({
      requestId: 'req-pause-input-resume',
      source: 'assistant',
      action: {
        type: 'pipeline.execution_resume',
        executionId: 'execution-1',
        pauseResponses: [
          {
            checkpointId: 'checkpoint-1',
            jobId: 'review',
            stepId: 'approval',
            answers: { reviewer: 'Ada' },
          },
        ],
      },
    });
    expect(resumed.ok).toBe(true);
    expect(pipelinesApiMock.resumeAutomation).toHaveBeenCalledWith(
      'execution-1',
      {
        pauseResponses: [
          {
            checkpoint_id: 'checkpoint-1',
            job_id: 'review',
            step_id: 'approval',
            answers: { reviewer: 'Ada' },
          },
        ],
      },
    );

    pipelinesApiMock.resumeAutomation.mockClear();
    const unboundResume = await dispatchAppAction({
      requestId: 'req-direct-pause-resume',
      source: 'assistant',
      action: {
        type: 'pipeline.execution_resume',
        executionId: 'execution-1',
      },
    });
    expect(unboundResume.ok).toBe(false);
    expect(pipelinesApiMock.resumeAutomation).not.toHaveBeenCalled();
  });

  it('rejects pipeline execution chat follow-ups for file tabs before dispatching', async () => {
    pipelinesApiMock.getExecution.mockResolvedValue({
      success: true,
      data: makeExecutionState(),
    });
    useChatStore.setState({
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'file-1',
          tabs: [makeFileTab({ id: 'file-1' })],
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-execution-send-report-file-tab',
      source: 'assistant',
      action: {
        type: 'pipeline.execution_send_report_to_chat',
        executionId: 'execution-1',
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('invalid_target');
    expect(chatApiMock.sendMessage).not.toHaveBeenCalled();
  });

  it('reports pipeline execution chat follow-up dispatch failures', async () => {
    pipelinesApiMock.getExecution.mockResolvedValue({
      success: true,
      data: makeExecutionState(),
    });
    chatApiMock.sendMessage.mockRejectedValueOnce(new Error('IPC failed'));
    useChatStore.setState({
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [makeChatTab()],
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-execution-send-report-dispatch-failure',
      source: 'assistant',
      action: {
        type: 'pipeline.execution_send_report_to_chat',
        executionId: 'execution-1',
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('execution_failed');
    expect(response.error?.message).toBe('IPC failed');
  });

  it('omits scripts for single-repo source edits that do not change scripts', async () => {
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
      isLoading: false,
      worktreeError: null,
      pendingWorkspaceRepair: null,
      loadProjects: jest.fn().mockResolvedValue(undefined),
    });

    const response = await dispatchAppAction({
      requestId: 'req-apply-source-no-scripts',
      source: 'assistant',
      action: {
        type: 'workspace.apply_source_edits',
        workspaceId: 'project-1',
        worktreeId: 'worktree-1',
        hooks: {
          'pr:create': [{ type: 'command', command: 'npm test' }],
        },
      },
    });
    expect(response).toMatchObject({ ok: true });
    const request = (
      workspaceApiMock.applyProjectSourceChanges.mock.calls as Array<
        [Record<string, unknown>]
      >
    )[0]?.[0];
    expect(request).toBeDefined();
    expect(request).not.toHaveProperty('scripts');
    expect(request).toMatchObject({
      projectId: 'project-1',
      hooks: {
        'pr:create': [{ type: 'command', command: 'npm test' }],
      },
    });
  });

  it('lists available worktree git actions using current branch and PR state', async () => {
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
      uncommittedChanges: { 'project-1/worktree-1': true },
      hasRemoteTracking: { 'project-1/worktree-1': true },
      hasOriginRemote: { 'project-1/worktree-1': true },
    });
    useGitHubStore.setState({
      prStatuses: {
        'project-1/worktree-1': {
          repos: [
            { repoId: 'project-1', repoName: 'Project One', status: null },
          ],
          lastCheckedAt: new Date(0).toISOString(),
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-worktree-git-actions',
      source: 'assistant',
      action: {
        type: 'worktree.list_git_actions',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      totalActions: 1,
      actions: [
        {
          action: 'create-pr',
          label: 'Commit, push & create PR',
        },
      ],
    });
  });

  it('lists a scoped create PR action for changed multi-repo repos without PRs', async () => {
    useProjectsStore.setState({
      projects: [
        makeMultiRepoWorkspace({
          id: 'project-1',
          name: 'Project One',
          repos: [
            {
              id: 'repo-a',
              name: 'Repo A',
              repoPath: '/repo/a',
              source: 'local',
            },
            {
              id: 'repo-b',
              name: 'Repo B',
              repoPath: '/repo/b',
              source: 'local',
            },
          ],
        }),
      ],
      hasHydratedProjects: true,
      commitsAhead: { 'project-1/worktree-1': true },
      repoBranches: {
        'project-1/worktree-1': [
          {
            repoId: 'repo-a',
            repoName: 'Repo A',
            branch: 'feature',
            baseBranch: 'main',
            hasUncommittedChanges: false,
            hasRemoteTrackingBranch: true,
            hasUnpushedCommits: false,
            hasUnpulledCommits: false,
            hasBranchBeenPushed: true,
            baseBranchExistsLocally: true,
            baseBranchExistsInRemote: true,
            hasOriginRemote: true,
          },
          {
            repoId: 'repo-b',
            repoName: 'Repo B',
            branch: 'feature',
            baseBranch: 'main',
            hasUncommittedChanges: true,
            hasRemoteTrackingBranch: true,
            hasUnpushedCommits: false,
            hasUnpulledCommits: false,
            hasBranchBeenPushed: true,
            baseBranchExistsLocally: true,
            baseBranchExistsInRemote: true,
            hasOriginRemote: true,
          },
        ],
      },
      uncommittedChanges: { 'project-1/worktree-1': true },
      hasRemoteTracking: { 'project-1/worktree-1': true },
      hasOriginRemote: { 'project-1/worktree-1': true },
    });
    useGitHubStore.setState({
      prStatuses: {
        'project-1/worktree-1': {
          repos: [
            {
              repoId: 'repo-a',
              repoName: 'Repo A',
              status: {
                prNumber: 42,
                prUrl: 'https://github.com/example/a/pull/42',
                state: 'open',
                title: 'Repo A PR',
                checkStatus: 'none',
                checkDetails: [],
                reviewStatus: 'none',
                reviewers: [],
                hasConflicts: false,
                commentCount: 0,
                updatedAt: new Date(0).toISOString(),
              },
            },
            { repoId: 'repo-b', repoName: 'Repo B', status: null },
          ],
          lastCheckedAt: new Date(0).toISOString(),
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-worktree-git-actions-multi-repo-dirty-with-existing-pr',
      source: 'assistant',
      action: {
        type: 'worktree.list_git_actions',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      isMultiRepo: true,
      totalActions: 1,
      actions: [
        {
          action: 'create-pr',
          label: 'Commit, push & create PR',
          repoIds: ['repo-b'],
          repoNames: ['Repo B'],
        },
      ],
    });
  });

  it('matches PrStatusBar single-repo fallback before PR data is loaded', async () => {
    useProjectsStore.setState({
      projects: [
        makeMultiRepoWorkspace({
          id: 'project-1',
          name: 'Project One',
          repos: [
            {
              id: 'repo-a',
              name: 'Repo A',
              repoPath: '/repo/a',
              source: 'local',
            },
          ],
        }),
      ],
      hasHydratedProjects: true,
    });

    const response = await dispatchAppAction({
      requestId: 'req-worktree-git-actions-pr-loading',
      source: 'assistant',
      action: {
        type: 'worktree.list_git_actions',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      isMultiRepo: false,
      totalActions: 0,
    });
  });

  it('dispatches an available worktree git action through the github store', async () => {
    const createPr = jest.fn().mockResolvedValue(undefined);
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
      uncommittedChanges: { 'project-1/worktree-1': true },
      hasRemoteTracking: { 'project-1/worktree-1': true },
      hasOriginRemote: { 'project-1/worktree-1': true },
    });
    useGitHubStore.setState({
      createPr,
      prStatuses: {
        'project-1/worktree-1': {
          repos: [
            { repoId: 'project-1', repoName: 'Project One', status: null },
          ],
          lastCheckedAt: new Date(0).toISOString(),
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-run-worktree-git-action',
      source: 'assistant',
      action: {
        type: 'worktree.run_git_action',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        action: 'create-pr',
      },
    });

    expect(response.ok).toBe(true);
    expect(createPr).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      undefined,
      {
        source: 'chat',
      },
    );
    expect(useChatStore.getState().selectedWorktree).toEqual({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
  });

  it('dispatches Git action cancellation through the github store', async () => {
    const cancelGitAction = jest.fn().mockResolvedValue({
      accepted: true,
      reason: 'cancel_requested',
    });
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
    });
    useGitHubStore.setState({
      cancelGitAction,
      gitActionOperationIds: {
        'project-1/worktree-1': 'operation-1',
      },
      gitActionCancellationRequested: new Set<string>(),
    });

    const response = await dispatchAppAction({
      requestId: 'req-cancel-worktree-git-action',
      source: 'assistant',
      action: {
        type: 'worktree.cancel_git_action',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });

    expect(response).toMatchObject({
      ok: true,
      result: { dispatchedAction: 'worktree.cancel_git_action' },
    });
    expect(cancelGitAction).toHaveBeenCalledWith('project-1', 'worktree-1');
  });

  it('reports a refused Git action cancellation as unavailable', async () => {
    const cancelGitAction = jest.fn().mockResolvedValue({
      accepted: false,
      reason: 'not_active',
    });
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
    });
    useGitHubStore.setState({
      cancelGitAction,
      gitActionOperationIds: {
        'project-1/worktree-1': 'operation-1',
      },
      gitActionCancellationRequested: new Set<string>(),
    });

    const response = await dispatchAppAction({
      requestId: 'req-cancel-refused-worktree-git-action',
      source: 'assistant',
      action: {
        type: 'worktree.cancel_git_action',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({
      code: 'surface_unavailable',
      retryable: true,
    });
  });

  it('rejects Git action cancellation when no action is running', async () => {
    const cancelGitAction = jest.fn().mockResolvedValue(undefined);
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
    });
    useGitHubStore.setState({
      cancelGitAction,
      gitActionOperationIds: {},
      gitActionCancellationRequested: new Set<string>(),
    });

    const response = await dispatchAppAction({
      requestId: 'req-cancel-idle-worktree-git-action',
      source: 'assistant',
      action: {
        type: 'worktree.cancel_git_action',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('surface_unavailable');
    expect(cancelGitAction).not.toHaveBeenCalled();
  });

  describe('github.split_pr', () => {
    const splitPrStatus = (
      state: 'open' | 'merged',
      additions: number,
      deletions: number,
    ): WorktreePrStatus['repos'][number]['status'] => ({
      prNumber: 9,
      prUrl: 'https://github.com/org/repo/pull/9',
      state,
      title: 'A big PR',
      checkStatus: 'passing',
      checkDetails: [],
      reviewStatus: 'approved',
      reviewers: [],
      hasConflicts: false,
      mergeableState: 'clean',
      commentCount: 0,
      unresolvedReviewThreadCount: 0,
      updatedAt: new Date(0).toISOString(),
      additions,
      deletions,
    });

    function setupSplitPr(options?: {
      state?: 'open' | 'merged';
      additions?: number;
      deletions?: number;
      enabled?: boolean;
      threshold?: number;
    }): jest.Mock {
      useProjectsStore.setState({
        projects: [makeWorkspace()],
        hasHydratedProjects: true,
      });
      const planSplitPr = jest.fn().mockResolvedValue(null);
      useGitHubStore.setState({
        prStatuses: {
          'project-1/worktree-1': {
            repos: [
              {
                repoId: 'project-1',
                repoName: 'Project One',
                status: splitPrStatus(
                  options?.state ?? 'open',
                  options?.additions ?? 900,
                  options?.deletions ?? 300,
                ),
              },
            ],
            lastCheckedAt: new Date(0).toISOString(),
          },
        },
        planningSplitPr: new Set<string>(),
        splittingPr: new Set<string>(),
        planSplitPr,
      });
      useSplitPrPreferencesStore.setState({
        splitPrEnabled: options?.enabled ?? true,
        splitPrThresholdLines: options?.threshold ?? 500,
        hasLoaded: true,
      });
      // Clear any pre-flight target left by a previous dispatch so each test
      // observes the modal-open state produced by its own dispatch.
      useActivityStore.setState({ splitPreflight: null });
      return planSplitPr;
    }

    afterEach(() => {
      __resetSplitPrPreferencesForTests();
      useActivityStore.setState({ splitPreflight: null });
    });

    it('opens the Split PR pre-flight modal for an eligible worktree', async () => {
      // The advisor cannot acquire the split lock itself (Approve rejects
      // unless locked, and only the pre-flight modal's Start acquires it), so
      // an eligible dispatch routes through `openSplitPreflight` rather than
      // calling `planSplitPr` directly.
      const planSplitPr = setupSplitPr();

      const response = await dispatchAppAction({
        requestId: 'req-split-pr-eligible',
        source: 'assistant',
        action: {
          type: 'github.split_pr',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      });

      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({
        dispatchedAction: 'github.split_pr',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        preflightOpened: true,
      });
      // The dispatcher opens the pre-flight modal (state set) and does NOT plan
      // directly.
      expect(useActivityStore.getState().splitPreflight).toEqual({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      });
      expect(planSplitPr).not.toHaveBeenCalled();
      expect(useChatStore.getState().selectedWorktree).toMatchObject({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      });
    });

    it('rejects dispatch when the Split PR preference is disabled', async () => {
      const planSplitPr = setupSplitPr({ enabled: false });

      const response = await dispatchAppAction({
        requestId: 'req-split-pr-disabled',
        source: 'assistant',
        action: {
          type: 'github.split_pr',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('invalid_target');
      expect(response.error?.message).toContain('disabled');
      expect(planSplitPr).not.toHaveBeenCalled();
      expect(useActivityStore.getState().splitPreflight).toBeNull();
    });

    it('rejects dispatch when the desktop PR Split flag is off', async () => {
      const planSplitPr = setupSplitPr();
      useFeatureFlagsStore.setState({
        snapshot: {
          ...getDefaultFeatureFlagSnapshot(),
          values: {
            ...getDefaultFeatureFlagSnapshot().values,
            [CLIENT_FEATURE_FLAGS.canopyDesktopPrSplit.key]: false,
          },
          status: 'ready',
          initialized: true,
        },
      });

      const response = await dispatchAppAction({
        requestId: 'req-split-pr-flag-off',
        source: 'assistant',
        action: {
          type: 'github.split_pr',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('surface_unavailable');
      expect(response.error?.message).toContain('not available');
      expect(planSplitPr).not.toHaveBeenCalled();
      expect(useActivityStore.getState().splitPreflight).toBeNull();
    });

    it('rejects dispatch when the PR is below the split threshold', async () => {
      const planSplitPr = setupSplitPr({
        additions: 100,
        deletions: 50,
        threshold: 500,
      });

      const response = await dispatchAppAction({
        requestId: 'req-split-pr-below-threshold',
        source: 'assistant',
        action: {
          type: 'github.split_pr',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('invalid_target');
      expect(response.error?.message).toContain('threshold');
      expect(planSplitPr).not.toHaveBeenCalled();
      expect(useActivityStore.getState().splitPreflight).toBeNull();
    });

    it('rejects dispatch when the worktree has no open pull request', async () => {
      const planSplitPr = setupSplitPr({ state: 'merged' });

      const response = await dispatchAppAction({
        requestId: 'req-split-pr-no-open-pr',
        source: 'assistant',
        action: {
          type: 'github.split_pr',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('invalid_target');
      expect(response.error?.message).toContain('no open pull request');
      expect(planSplitPr).not.toHaveBeenCalled();
      expect(useActivityStore.getState().splitPreflight).toBeNull();
    });

    it('blocks dispatch while a split plan or execution is already running', async () => {
      const planSplitPr = setupSplitPr();
      useGitHubStore.setState({
        planningSplitPr: new Set(['project-1/worktree-1']),
      });

      const response = await dispatchAppAction({
        requestId: 'req-split-pr-busy',
        source: 'assistant',
        action: {
          type: 'github.split_pr',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('surface_unavailable');
      expect(response.error?.retryable).toBe(true);
      expect(planSplitPr).not.toHaveBeenCalled();
      expect(useActivityStore.getState().splitPreflight).toBeNull();
    });

    it('returns not_found for an unknown worktree', async () => {
      const planSplitPr = setupSplitPr();

      const response = await dispatchAppAction({
        requestId: 'req-split-pr-missing-worktree',
        source: 'assistant',
        action: {
          type: 'github.split_pr',
          projectId: 'project-1',
          worktreeId: 'worktree-missing',
        },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('not_found');
      expect(planSplitPr).not.toHaveBeenCalled();
      expect(useActivityStore.getState().splitPreflight).toBeNull();
    });
  });

  describe('code_review.open', () => {
    beforeEach(() => {
      useProjectsStore.setState({
        projects: [makeWorkspace()],
        hasHydratedProjects: true,
      });
    });

    it('opens the Change Diagram panel for a known worktree without arming generation', async () => {
      const openCodeReview = jest
        .spyOn(useCodeReviewStore.getState(), 'openCodeReview')
        .mockResolvedValue(undefined);

      const response = await dispatchAppAction({
        requestId: 'req-code-review-open',
        source: 'assistant',
        action: {
          type: 'code_review.open',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      });

      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({
        dispatchedAction: 'code_review.open',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      });
      expect(openCodeReview).toHaveBeenCalledWith(
        { projectId: 'project-1', worktreeId: 'worktree-1' },
        { arm: false },
      );

      openCodeReview.mockRestore();
    });

    it('returns not_found for an unknown worktree', async () => {
      const openCodeReview = jest
        .spyOn(useCodeReviewStore.getState(), 'openCodeReview')
        .mockResolvedValue(undefined);

      const response = await dispatchAppAction({
        requestId: 'req-code-review-missing-worktree',
        source: 'assistant',
        action: {
          type: 'code_review.open',
          projectId: 'project-1',
          worktreeId: 'worktree-missing',
        },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('not_found');
      expect(openCodeReview).not.toHaveBeenCalled();

      openCodeReview.mockRestore();
    });
  });

  describe('runs.open_comments (CAN-397)', () => {
    const SHARED_RUN = {
      externalId: 'run-ext-1',
      url: 'https://example.test/runs/run-ext-1',
      shareScope: 'team',
      sharedAt: '2026-08-11T00:00:00.000Z',
      unreadCommentCount: 3,
      commentRevision: 7,
    } as const;

    function seedTabs(sharedRun?: typeof SHARED_RUN): void {
      useChatStore.setState({
        worktreeChats: {
          'project-1/worktree-1': {
            activeTabId: 'chat-1',
            tabs: [
              makeChatTab({
                id: 'chat-1',
                title: 'Shared session',
                ...(sharedRun ? { sharedRun } : {}),
              }),
            ],
          },
        },
      });
    }

    afterEach(() => {
      useRunCommentsStore.setState({ target: null });
    });

    it('opens the comments panel for a chat shared as a run', async () => {
      seedTabs(SHARED_RUN);

      const response = await dispatchAppAction({
        requestId: 'req-run-comments-open',
        source: 'assistant',
        action: {
          type: 'runs.open_comments',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
        },
      });

      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({
        dispatchedAction: 'runs.open_comments',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        runExternalId: 'run-ext-1',
        unreadCommentCount: 3,
      });
      expect(useRunCommentsStore.getState().target).toEqual({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        title: 'Shared session',
      });
    });

    it('refuses a chat that has not been shared as a run', async () => {
      seedTabs();

      const response = await dispatchAppAction({
        requestId: 'req-run-comments-unshared',
        source: 'assistant',
        action: {
          type: 'runs.open_comments',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
        },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('invalid_target');
      expect(useRunCommentsStore.getState().target).toBeNull();
    });

    it('returns not_found for an unknown chat id', async () => {
      seedTabs(SHARED_RUN);

      const response = await dispatchAppAction({
        requestId: 'req-run-comments-missing-chat',
        source: 'assistant',
        action: {
          type: 'runs.open_comments',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-missing',
        },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('not_found');
      expect(useRunCommentsStore.getState().target).toBeNull();
    });
  });

  describe('split-lock refusals', () => {
    const LOCK_MESSAGE =
      'A Split PR is in progress for this worktree; it is locked until the split finishes.';

    afterEach(() => {
      useGitHubStore.setState({ splitLockedWorktrees: new Set<string>() });
    });

    function lockWorktree(projectId: string, worktreeId: string): void {
      useGitHubStore.setState({
        splitLockedWorktrees: new Set([`${projectId}/${worktreeId}`]),
      });
    }

    function expectLockRefusal(response: {
      ok: boolean;
      error?: { code?: string; message?: string; retryable?: boolean };
    }): void {
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('surface_unavailable');
      expect(response.error?.retryable).toBe(true);
      expect(response.error?.message).toBe(LOCK_MESSAGE);
    }

    // Minimal eligible-worktree setup, mirroring `setupSplitPr()` from the
    // `github.split_pr` describe block above (that helper is scoped to its
    // own describe and not reachable here).
    function setupEligibleSplitPrWorktree(): jest.Mock {
      useProjectsStore.setState({
        projects: [makeWorkspace()],
        hasHydratedProjects: true,
      });
      const planSplitPr = jest.fn().mockResolvedValue(null);
      useGitHubStore.setState({
        prStatuses: {
          'project-1/worktree-1': {
            repos: [
              {
                repoId: 'project-1',
                repoName: 'Project One',
                status: {
                  prNumber: 9,
                  prUrl: 'https://github.com/org/repo/pull/9',
                  state: 'open',
                  title: 'A big PR',
                  checkStatus: 'passing',
                  checkDetails: [],
                  reviewStatus: 'approved',
                  reviewers: [],
                  hasConflicts: false,
                  mergeableState: 'clean',
                  commentCount: 0,
                  unresolvedReviewThreadCount: 0,
                  updatedAt: new Date(0).toISOString(),
                  additions: 900,
                  deletions: 300,
                },
              },
            ],
            lastCheckedAt: new Date(0).toISOString(),
          },
        },
        planningSplitPr: new Set<string>(),
        splittingPr: new Set<string>(),
        planSplitPr,
      });
      useSplitPrPreferencesStore.setState({
        splitPrEnabled: true,
        splitPrThresholdLines: 500,
        hasLoaded: true,
      });
      useActivityStore.setState({ splitPreflight: null });
      return planSplitPr;
    }

    afterEach(() => {
      __resetSplitPrPreferencesForTests();
    });

    it('refuses every file-tree mutation for a split-locked worktree', async () => {
      lockWorktree('project-1', 'worktree-1');
      const actions = [
        {
          type: 'file-tree.create_file',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          target: { repoId: 'project-1', relativePath: 'new.txt' },
        },
        {
          type: 'file-tree.create_directory',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          target: { repoId: 'project-1', relativePath: 'new-dir' },
        },
        {
          type: 'file-tree.copy',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          source: { repoId: 'project-1', relativePath: 'source.txt' },
          target: { repoId: 'project-1', relativePath: 'copy.txt' },
          conflict: 'error',
        },
        {
          type: 'file-tree.move',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          source: { repoId: 'project-1', relativePath: 'source.txt' },
          target: { repoId: 'project-1', relativePath: 'moved.txt' },
        },
        {
          type: 'file-tree.delete',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          target: { repoId: 'project-1', relativePath: 'old.txt' },
        },
      ] satisfies AppAdvisorActionRequest['action'][];

      for (const [index, action] of actions.entries()) {
        const response = await dispatchAppAction({
          requestId: `req-lock-file-tree-${index}`,
          source: 'assistant',
          action,
        });
        expectLockRefusal(response);
      }
      expect(mutateFileTreeMock).not.toHaveBeenCalled();
    });

    it('refuses github.split_pr for an already-locked worktree instead of opening a second pre-flight dialog', async () => {
      const planSplitPr = setupEligibleSplitPrWorktree();
      lockWorktree('project-1', 'worktree-1');

      const response = await dispatchAppAction({
        requestId: 'req-lock-split-pr',
        source: 'assistant',
        action: {
          type: 'github.split_pr',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      });

      expectLockRefusal(response);
      expect(planSplitPr).not.toHaveBeenCalled();
      expect(useActivityStore.getState().splitPreflight).toBeNull();
    });

    it('does not refuse github.split_pr when a DIFFERENT worktree is locked', async () => {
      const planSplitPr = setupEligibleSplitPrWorktree();
      lockWorktree('project-1', 'worktree-other');

      const response = await dispatchAppAction({
        requestId: 'req-lock-split-pr-other',
        source: 'assistant',
        action: {
          type: 'github.split_pr',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      });

      expect(response.ok).toBe(true);
      expect(planSplitPr).not.toHaveBeenCalled(); // still routes through pre-flight, not a lock refusal
      expect(useActivityStore.getState().splitPreflight).toEqual({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      });
    });

    it('refuses worktree.run_git_action for a locked worktree', async () => {
      const createPr = jest.fn().mockResolvedValue(undefined);
      useProjectsStore.setState({
        projects: [makeWorkspace()],
        hasHydratedProjects: true,
        uncommittedChanges: { 'project-1/worktree-1': true },
        hasRemoteTracking: { 'project-1/worktree-1': true },
        hasOriginRemote: { 'project-1/worktree-1': true },
      });
      useGitHubStore.setState({
        createPr,
        prStatuses: {
          'project-1/worktree-1': {
            repos: [
              { repoId: 'project-1', repoName: 'Project One', status: null },
            ],
            lastCheckedAt: new Date(0).toISOString(),
          },
        },
      });
      lockWorktree('project-1', 'worktree-1');

      const response = await dispatchAppAction({
        requestId: 'req-lock-git-action',
        source: 'assistant',
        action: {
          type: 'worktree.run_git_action',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          action: 'create-pr',
        },
      });

      expectLockRefusal(response);
      expect(createPr).not.toHaveBeenCalled();
    });

    it('refuses worktree.start_merge_conflict_resolution for a locked worktree', async () => {
      useProjectsStore.setState({
        projects: [makeWorkspace()],
        hasHydratedProjects: true,
      });
      lockWorktree('project-1', 'worktree-1');

      const response = await dispatchAppAction({
        requestId: 'req-lock-merge-conflict',
        source: 'assistant',
        action: {
          type: 'worktree.start_merge_conflict_resolution',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      });

      expectLockRefusal(response);
      expect(githubStartMergeConflictResolutionMock).not.toHaveBeenCalled();
    });

    it('refuses worktree.start_pr_comment_triage for a locked worktree', async () => {
      useProjectsStore.setState({
        projects: [makeWorkspace()],
        hasHydratedProjects: true,
      });
      lockWorktree('project-1', 'worktree-1');

      const response = await dispatchAppAction({
        requestId: 'req-lock-comment-triage',
        source: 'assistant',
        action: {
          type: 'worktree.start_pr_comment_triage',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      });

      expectLockRefusal(response);
      expect(githubStartPrCommentTriageMock).not.toHaveBeenCalled();
    });

    it('refuses worktree.start_ci_check_fix for a locked worktree', async () => {
      useProjectsStore.setState({
        projects: [makeWorkspace()],
        hasHydratedProjects: true,
      });
      lockWorktree('project-1', 'worktree-1');

      const response = await dispatchAppAction({
        requestId: 'req-lock-ci-fix',
        source: 'assistant',
        action: {
          type: 'worktree.start_ci_check_fix',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      });

      expectLockRefusal(response);
      expect(githubStartCiCheckFixMock).not.toHaveBeenCalled();
    });

    it('refuses worktree-chat.send_message for a locked worktree', async () => {
      useChatStore.setState({
        worktreeChats: {
          'project-1/worktree-1': {
            activeTabId: 'chat-1',
            tabs: [makeChatTab()],
          },
        },
      });
      lockWorktree('project-1', 'worktree-1');

      const response = await dispatchAppAction({
        requestId: 'req-lock-send-message',
        source: 'assistant',
        action: {
          type: 'worktree-chat.send_message',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          text: 'Please continue.',
        },
      });

      expect(response).toMatchObject({
        ok: false,
        error: { code: 'unsupported_action' },
      });
      expect(chatApiMock.sendMessage).not.toHaveBeenCalled();
    });

    it('refuses renderer sends even when another worktree is locked', async () => {
      useChatStore.setState({
        worktreeChats: {
          'project-1/worktree-1': {
            activeTabId: 'chat-1',
            tabs: [makeChatTab()],
          },
        },
      });
      lockWorktree('project-1', 'worktree-other');

      const response = await dispatchAppAction({
        requestId: 'req-lock-send-message-other',
        source: 'assistant',
        action: {
          type: 'worktree-chat.send_message',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          text: 'Please continue.',
        },
      });

      expect(response).toMatchObject({
        ok: false,
        error: { code: 'unsupported_action' },
      });
      expect(chatApiMock.sendMessage).not.toHaveBeenCalled();
    });

    it('refuses worktree-chat.open_tab with an initialMessage for a locked worktree', async () => {
      useChatStore.setState({
        selectedWorktree: null,
        modelDefaults: makeClaudeTerminalModelDefaults(),
        worktreeChats: {
          'project-1/worktree-1': {
            activeTabId: 'chat-1',
            tabs: [makeChatTab()],
          },
        },
      });
      lockWorktree('project-1', 'worktree-1');

      const response = await dispatchAppAction({
        requestId: 'req-lock-open-tab-initial-message',
        source: 'assistant',
        action: {
          type: 'worktree-chat.open_tab',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          initialMessage: 'Review the current diff.',
        },
      });

      expectLockRefusal(response);
      expect(chatApiMock.sendMessage).not.toHaveBeenCalled();
      expect(claudeTerminalLaunchMock).not.toHaveBeenCalled();
      // A refused dispatch must not select the worktree or persist a new
      // (now-orphaned) tab as a side effect.
      expect(useChatStore.getState().selectedWorktree).toBeNull();
      expect(
        useChatStore.getState().worktreeChats['project-1/worktree-1']?.tabs,
      ).toHaveLength(1);
    });

    it('does not refuse worktree-chat.open_tab without an initialMessage for a locked worktree', async () => {
      useChatStore.setState({
        worktreeChats: {
          'project-1/worktree-1': {
            activeTabId: 'chat-1',
            tabs: [makeChatTab()],
          },
        },
      });
      lockWorktree('project-1', 'worktree-1');

      const response = await dispatchAppAction({
        requestId: 'req-lock-open-tab-no-message',
        source: 'assistant',
        action: {
          type: 'worktree-chat.open_tab',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
        },
      });

      // Opening/switching to an existing tab with no message is not a
      // mutation, so it is not gated even while the worktree is locked.
      expect(response.ok).toBe(true);
    });

    describe.each([
      { chatAction: 'hand_off' as const },
      { chatAction: 'fork' as const },
      { chatAction: 'branch' as const },
    ])('worktree-chat.run_chat_action ($chatAction)', ({ chatAction }) => {
      function setupRunChatActionState(): void {
        useProjectsStore.setState({
          projects: [makeWorkspace()],
          hasHydratedProjects: true,
          createWorktree: jest
            .fn()
            .mockResolvedValue({ id: 'branched-worktree' }),
        });
        useChatStore.setState({
          worktreeChats: {
            'project-1/worktree-1': {
              activeTabId: 'chat-1',
              tabs: [
                makeChatTab({
                  id: 'chat-1',
                  providerType: 'claude',
                  // hand_off requires a stale session; fork/branch just
                  // need a non-empty, non-streaming tab, so a single shape
                  // satisfies chatActionTargetError for all three actions.
                  readOnly: chatAction === 'hand_off',
                  staleSessionDetected:
                    chatAction === 'hand_off'
                      ? { droppedMessageText: 'Retry this change' }
                      : undefined,
                }),
              ],
            },
          },
        });
      }

      it(`refuses ${chatAction} for a locked worktree resolved via explicit projectId/worktreeId`, async () => {
        setupRunChatActionState();
        lockWorktree('project-1', 'worktree-1');

        const response = await dispatchAppAction({
          requestId: `req-lock-chat-action-${chatAction}-explicit`,
          source: 'assistant',
          action: {
            type: 'worktree-chat.run_chat_action',
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            chatId: 'chat-1',
            action: chatAction,
          },
        });

        expectLockRefusal(response);
        expect(chatApiMock.generateHandoffSummary).not.toHaveBeenCalled();
        expect(chatApiMock.sendMessage).not.toHaveBeenCalled();
        expect(
          useProjectsStore.getState().createWorktree,
        ).not.toHaveBeenCalled();
        expect(
          useChatStore.getState().worktreeChats['project-1/worktree-1'].tabs,
        ).toHaveLength(1);
      });

      it(`refuses ${chatAction} for a locked worktree resolved via the selectedWorktree fallback`, async () => {
        setupRunChatActionState();
        useChatStore.setState({
          selectedWorktree: {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
          },
        });
        lockWorktree('project-1', 'worktree-1');

        const response = await dispatchAppAction({
          requestId: `req-lock-chat-action-${chatAction}-fallback`,
          source: 'assistant',
          action: {
            type: 'worktree-chat.run_chat_action',
            action: chatAction,
          },
        });

        expectLockRefusal(response);
        expect(chatApiMock.generateHandoffSummary).not.toHaveBeenCalled();
        expect(chatApiMock.sendMessage).not.toHaveBeenCalled();
        expect(
          useProjectsStore.getState().createWorktree,
        ).not.toHaveBeenCalled();
        expect(
          useChatStore.getState().worktreeChats['project-1/worktree-1'].tabs,
        ).toHaveLength(1);
      });

      it(`does not refuse ${chatAction} when the resolved worktree is unlocked`, async () => {
        setupRunChatActionState();

        const response = await dispatchAppAction({
          requestId: `req-unlocked-chat-action-${chatAction}`,
          source: 'assistant',
          action: {
            type: 'worktree-chat.run_chat_action',
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            chatId: 'chat-1',
            action: chatAction,
          },
        });

        expect(response.ok).toBe(true);
      });
    });

    it('refuses terminal.open for a locked worktree', async () => {
      lockWorktree('project-1', 'worktree-1');

      const response = await dispatchAppAction({
        requestId: 'req-lock-terminal-open',
        source: 'assistant',
        action: {
          type: 'terminal.open',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      });

      expectLockRefusal(response);
      // A refused dispatch must not select the worktree as a side effect.
      expect(useChatStore.getState().selectedWorktree).toBeNull();
    });

    it('refuses browser.open (new browser session) for a locked worktree', async () => {
      useChatStore.setState({
        selectedWorktree: {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      });
      lockWorktree('project-1', 'worktree-1');

      const response = await dispatchAppAction({
        requestId: 'req-lock-browser-open',
        source: 'assistant',
        action: {
          type: 'browser.open',
          expectedRuntimeGeneration: 1,
          url: 'http://localhost:3000',
        },
      });

      expectLockRefusal(response);
      expect(browserApiMock.create).not.toHaveBeenCalled();
    });

    it('does not refuse browser.open when reusing an already-open browserId for a locked worktree', async () => {
      useChatStore.setState({
        selectedWorktree: {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      });
      const browserId = seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3000',
      });
      lockWorktree('project-1', 'worktree-1');

      const response = await dispatchAppAction({
        requestId: 'req-lock-browser-open-reuse',
        source: 'assistant',
        action: {
          type: 'browser.open',
          expectedRuntimeGeneration: 1,
          browserId,
          url: 'http://localhost:3001',
        },
      });

      // Reusing an already-open browser session is not gated, matching the
      // main-process `browserCreate`-only chokepoint.
      expect(response.ok).toBe(true);
    });

    it('refuses opening a new external in-app browser for a locked worktree', async () => {
      useChatStore.setState({
        selectedWorktree: {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      });
      lockWorktree('project-1', 'worktree-1');

      const response = await dispatchAppAction({
        requestId: 'req-lock-browser-open-external',
        source: 'assistant',
        action: {
          type: 'browser.open',
          expectedRuntimeGeneration: 1,
          url: 'https://example.com/docs',
        },
      });

      expect(response.ok).toBe(false);
      expect(browserApiMock.openExternal).not.toHaveBeenCalled();
      expect(browserApiMock.create).not.toHaveBeenCalled();
    });

    describe('worktree.add_existing_worktree', () => {
      function setupExistingWorktreeJoinState(): void {
        const sourceWorkspace = makeWorkspace();
        const joinWorkspace = makeWorkspace({
          id: 'join-workspace',
          name: 'Join Workspace',
          worktrees: [
            {
              id: 'join-worktree',
              branchName: 'join-feature',
              createdAt: new Date(0).toISOString(),
            },
          ],
        });
        const destinationWorkspace = makeMultiRepoWorkspace({
          id: 'dest-workspace',
          name: 'Destination Workspace',
          temporary: true,
          worktrees: [
            {
              id: 'dest-worktree',
              branchName: 'feature',
              createdAt: new Date(0).toISOString(),
            },
          ],
        });
        useProjectsStore.setState({
          projects: [sourceWorkspace, joinWorkspace, destinationWorkspace],
          hasHydratedProjects: true,
        });
        workspaceApiMock.listExistingWorktreeJoinOptions.mockResolvedValue({
          groups: [
            {
              workspaceId: 'join-workspace',
              workspaceName: 'Join Workspace',
              color: '#333333',
              isMultiRepo: false,
              repoCount: 1,
              temporary: false,
              candidates: [
                {
                  workspaceId: 'join-workspace',
                  worktreeId: 'join-worktree',
                  workspaceName: 'Join Workspace',
                  worktreeName: 'join-feature',
                  branchName: 'join-feature',
                  repoOverlaps: [],
                },
              ],
            },
          ],
        });
        workspaceApiMock.combineWorktreeWithExistingWorktree.mockResolvedValue({
          sourceWorkspaceId: 'project-1',
          sourceWorktreeId: 'worktree-1',
          destinationWorkspaceId: 'dest-workspace',
          destinationWorktreeId: 'dest-worktree',
          destinationWorkspace,
          destinationWorktree: destinationWorkspace.worktrees[0],
          repoMappings: [],
          selectedRepoIdRewrites: {},
          filePathRewrites: [],
          compatibilitySymlinks: [],
          createdTemporaryWorkspace: true,
          reusedWorkspace: false,
          removedSourceWorktree: false,
          joinedWorktree: {
            workspaceId: 'join-workspace',
            worktreeId: 'join-worktree',
            repoMappings: [],
            selectedRepoIdRewrites: {},
            filePathRewrites: [],
            compatibilitySymlinks: [],
          },
        });
      }

      it('refuses worktree.add_existing_worktree when the source worktree is locked', async () => {
        setupExistingWorktreeJoinState();
        lockWorktree('project-1', 'worktree-1');

        const response = await dispatchAppAction({
          requestId: 'req-lock-add-existing-worktree-source',
          source: 'assistant',
          action: {
            type: 'worktree.add_existing_worktree',
            sourceWorkspaceId: 'project-1',
            sourceWorktreeId: 'worktree-1',
            joinWorkspaceId: 'join-workspace',
            joinWorktreeId: 'join-worktree',
          },
        });

        expectLockRefusal(response);
        expect(
          workspaceApiMock.combineWorktreeWithExistingWorktree,
        ).not.toHaveBeenCalled();
      });

      it('refuses worktree.add_existing_worktree when the join worktree is locked', async () => {
        setupExistingWorktreeJoinState();
        lockWorktree('join-workspace', 'join-worktree');

        const response = await dispatchAppAction({
          requestId: 'req-lock-add-existing-worktree-join',
          source: 'assistant',
          action: {
            type: 'worktree.add_existing_worktree',
            sourceWorkspaceId: 'project-1',
            sourceWorktreeId: 'worktree-1',
            joinWorkspaceId: 'join-workspace',
            joinWorktreeId: 'join-worktree',
          },
        });

        expectLockRefusal(response);
        expect(
          workspaceApiMock.combineWorktreeWithExistingWorktree,
        ).not.toHaveBeenCalled();
      });

      it('does not refuse worktree.add_existing_worktree when neither worktree is locked', async () => {
        setupExistingWorktreeJoinState();

        const response = await dispatchAppAction({
          requestId: 'req-unlocked-add-existing-worktree',
          source: 'assistant',
          action: {
            type: 'worktree.add_existing_worktree',
            sourceWorkspaceId: 'project-1',
            sourceWorktreeId: 'worktree-1',
            joinWorkspaceId: 'join-workspace',
            joinWorktreeId: 'join-worktree',
          },
        });

        expect(response.ok).toBe(true);
        expect(
          workspaceApiMock.combineWorktreeWithExistingWorktree,
        ).toHaveBeenCalledWith({
          sourceWorkspaceId: 'project-1',
          sourceWorktreeId: 'worktree-1',
          joinWorkspaceId: 'join-workspace',
          joinWorktreeId: 'join-worktree',
          mode: 'temporary',
        });
      });
    });

    describe('worktree.add_workspace', () => {
      function setupAddWorkspaceState(): void {
        const destinationWorkspace = makeMultiRepoWorkspace({
          id: 'dest-workspace',
          name: 'Destination Workspace',
          temporary: true,
          worktrees: [
            {
              id: 'dest-worktree',
              branchName: 'feature',
              createdAt: new Date(0).toISOString(),
            },
          ],
        });
        useProjectsStore.setState({
          projects: [makeWorkspace(), destinationWorkspace],
          hasHydratedProjects: true,
        });
        workspaceApiMock.listAdhocMultiRepoJoinOptions.mockResolvedValue({
          options: [
            {
              id: 'join-workspace',
              name: 'Join Workspace',
              color: '#333333',
              isMultiRepo: false,
              repoCount: 1,
              temporary: false,
            },
          ],
        });
        workspaceApiMock.combineWorktreeWithWorkspace.mockResolvedValue({
          sourceWorkspaceId: 'project-1',
          sourceWorktreeId: 'worktree-1',
          destinationWorkspaceId: 'dest-workspace',
          destinationWorktreeId: 'dest-worktree',
          destinationWorkspace,
          destinationWorktree: destinationWorkspace.worktrees[0],
          repoMappings: [],
          selectedRepoIdRewrites: {},
          filePathRewrites: [],
          compatibilitySymlinks: [],
          createdTemporaryWorkspace: true,
          reusedWorkspace: false,
          removedSourceWorktree: false,
        });
      }

      it('refuses worktree.add_workspace when the source worktree is locked', async () => {
        setupAddWorkspaceState();
        lockWorktree('project-1', 'worktree-1');

        const response = await dispatchAppAction({
          requestId: 'req-lock-add-workspace',
          source: 'assistant',
          action: {
            type: 'worktree.add_workspace',
            sourceWorkspaceId: 'project-1',
            sourceWorktreeId: 'worktree-1',
            joinWorkspaceId: 'join-workspace',
          },
        });

        expectLockRefusal(response);
        expect(
          workspaceApiMock.combineWorktreeWithWorkspace,
        ).not.toHaveBeenCalled();
      });

      it('does not refuse worktree.add_workspace when a DIFFERENT worktree is locked', async () => {
        setupAddWorkspaceState();
        lockWorktree('project-1', 'other-worktree');

        const response = await dispatchAppAction({
          requestId: 'req-unlocked-add-workspace',
          source: 'assistant',
          action: {
            type: 'worktree.add_workspace',
            sourceWorkspaceId: 'project-1',
            sourceWorktreeId: 'worktree-1',
            joinWorkspaceId: 'join-workspace',
          },
        });

        expect(response.ok).toBe(true);
        expect(
          workspaceApiMock.combineWorktreeWithWorkspace,
        ).toHaveBeenCalled();
      });
    });

    describe('workspace.apply_source_edits', () => {
      function setupApplySourceEditsState(): void {
        useProjectsStore.setState({
          projects: [makeWorkspace()],
          hasHydratedProjects: true,
          isLoading: false,
          worktreeError: null,
          pendingWorkspaceRepair: null,
          loadProjects: jest.fn().mockResolvedValue(undefined),
        });
      }

      it('refuses workspace.apply_source_edits targeting an existing, locked worktree', async () => {
        setupApplySourceEditsState();
        lockWorktree('project-1', 'worktree-1');

        const response = await dispatchAppAction({
          requestId: 'req-lock-apply-source-edits',
          source: 'assistant',
          action: {
            type: 'workspace.apply_source_edits',
            workspaceId: 'project-1',
            worktreeId: 'worktree-1',
            hooks: {
              'pr:create': [{ type: 'command', command: 'npm test' }],
            },
          },
        });

        expectLockRefusal(response);
        expect(
          workspaceApiMock.applyProjectSourceChanges,
        ).not.toHaveBeenCalled();
      });

      it('does not refuse workspace.apply_source_edits when a DIFFERENT worktree is locked', async () => {
        setupApplySourceEditsState();
        lockWorktree('project-1', 'other-worktree');

        const response = await dispatchAppAction({
          requestId: 'req-unlocked-apply-source-edits',
          source: 'assistant',
          action: {
            type: 'workspace.apply_source_edits',
            workspaceId: 'project-1',
            worktreeId: 'worktree-1',
            hooks: {
              'pr:create': [{ type: 'command', command: 'npm test' }],
            },
          },
        });

        expect(response.ok).toBe(true);
        expect(workspaceApiMock.applyProjectSourceChanges).toHaveBeenCalled();
      });

      it('does not refuse workspace.apply_source_edits when creating a NEW worktree, even if an unrelated worktree is locked', async () => {
        setupApplySourceEditsState();
        lockWorktree('project-1', 'worktree-1');

        const response = await dispatchAppAction({
          requestId: 'req-unlocked-apply-source-edits-new',
          source: 'assistant',
          action: {
            type: 'workspace.apply_source_edits',
            workspaceId: 'project-1',
            createWorktree: true,
            hooks: {
              'pr:create': [{ type: 'command', command: 'npm test' }],
            },
          },
        });

        expect(response.ok).toBe(true);
        expect(workspaceApiMock.applyProjectSourceChanges).toHaveBeenCalled();
      });
    });

    describe('file.save_active', () => {
      function setupActiveFileTab(): void {
        useChatStore.setState({
          selectedWorktree: {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
          },
          worktreeChats: {
            'project-1/worktree-1': {
              activeTabId: 'file-1',
              tabs: [
                makeFileTab({
                  id: 'file-1',
                  title: 'notes.md',
                  filePath: '/repo/notes.md',
                  description: '/repo/notes.md',
                }),
              ],
            },
          },
        });
      }

      it('refuses file.save_active when the selected worktree is locked', async () => {
        setupActiveFileTab();
        lockWorktree('project-1', 'worktree-1');

        const response = await dispatchAppAction({
          requestId: 'req-lock-save-active',
          source: 'assistant',
          action: { type: 'file.save_active' },
        });

        expectLockRefusal(response);
        expect(mockControllerSaveTab).not.toHaveBeenCalled();
      });

      it('does not refuse file.save_active when a DIFFERENT worktree is locked', async () => {
        setupActiveFileTab();
        lockWorktree('project-1', 'other-worktree');

        const response = await dispatchAppAction({
          requestId: 'req-unlocked-save-active',
          source: 'assistant',
          action: { type: 'file.save_active' },
        });

        // The mocked controller saveTab resolves true (nothing to save)
        // without an error — proving the dispatcher passed the lock gate rather
        // than refusing.
        expect(response.ok).toBe(true);
      });
    });

    describe('file.send_selection_to_chat', () => {
      function setupActiveFileTab(): void {
        useChatStore.setState({
          selectedWorktree: {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
          },
          worktreeChats: {
            'project-1/worktree-1': {
              activeTabId: 'file-1',
              tabs: [
                makeFileTab({
                  id: 'file-1',
                  title: 'notes.md',
                  filePath: '/repo/notes.md',
                  description: '/repo/notes.md',
                }),
              ],
            },
          },
        });
      }

      it('routes the action to the active file editor selection', async () => {
        setupActiveFileTab();
        const handler = (event: Event): void => {
          if (!(event instanceof CustomEvent)) return;
          const detail: unknown = event.detail;
          if (!isSendEditorSelectionToChatDetail(detail)) return;
          expect(detail.tabId).toBe('file-1');
          detail.markHandled();
        };
        document.addEventListener(SEND_EDITOR_SELECTION_TO_CHAT_EVENT, handler);

        try {
          const response = await dispatchAppAction({
            requestId: 'req-send-editor-selection',
            source: 'assistant',
            action: { type: 'file.send_selection_to_chat' },
          });

          expect(response.ok).toBe(true);
        } finally {
          document.removeEventListener(
            SEND_EDITOR_SELECTION_TO_CHAT_EVENT,
            handler,
          );
        }
      });

      it('reports when the active editor has no non-empty selection', async () => {
        setupActiveFileTab();

        const response = await dispatchAppAction({
          requestId: 'req-send-empty-editor-selection',
          source: 'assistant',
          action: { type: 'file.send_selection_to_chat' },
        });

        expect(response.ok).toBe(false);
        expect(response.error?.code).toBe('invalid_target');
        expect(response.error?.message).toContain('non-empty selection');
      });
    });
  });

  describe('worktree.run_git_action merge-pr', () => {
    const mergeableStatus = (
      unresolvedReviewThreadCount: number,
    ): WorktreePrStatus['repos'][number]['status'] => ({
      prNumber: 5,
      prUrl: 'https://github.com/org/repo/pull/5',
      state: 'open',
      title: 'A PR',
      checkStatus: 'passing',
      checkDetails: [],
      reviewStatus: 'approved',
      reviewers: [],
      hasConflicts: false,
      mergeableState: 'clean',
      commentCount: 0,
      unresolvedReviewThreadCount,
      updatedAt: new Date(0).toISOString(),
    });

    function setupMergeablePr(unresolved: number): void {
      useProjectsStore.setState({
        projects: [makeWorkspace()],
        hasHydratedProjects: true,
        uncommittedChanges: { 'project-1/worktree-1': false },
        hasUnpushedCommits: { 'project-1/worktree-1': false },
        hasRemoteTracking: { 'project-1/worktree-1': true },
        hasOriginRemote: { 'project-1/worktree-1': true },
      });
      useGitHubStore.setState({
        prStatuses: {
          'project-1/worktree-1': {
            repos: [
              {
                repoId: 'project-1',
                repoName: 'Project One',
                status: mergeableStatus(unresolved),
              },
            ],
            lastCheckedAt: new Date(0).toISOString(),
          },
        },
      });
    }

    it('merges a mergeable PR with no unresolved comments', async () => {
      setupMergeablePr(0);
      const mergePr = jest.fn().mockResolvedValue({
        dryRun: false,
        verifiedRepos: [],
        mergedRepos: [
          {
            repoId: 'project-1',
            repoName: 'Project One',
            prNumber: 5,
            prUrl: 'https://github.com/org/repo/pull/5',
            mergeMethod: 'squash',
            mergeCommitSha: 'sha',
            status: 'merged',
          },
        ],
        requiresUnresolvedConfirmation: [],
        failedRepos: [],
      });
      useGitHubStore.setState({ mergePr });

      const response = await dispatchAppAction({
        requestId: 'req-merge-pr-clean',
        source: 'assistant',
        action: {
          type: 'worktree.run_git_action',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          action: 'merge-pr',
        },
      });

      expect(response.ok).toBe(true);
      expect(mergePr).toHaveBeenCalledWith('project-1', 'worktree-1', {
        repoIds: undefined,
        confirmUnresolvedComments: false,
        source: 'chat',
      });
    });

    describe('analytics attribution', () => {
      type RequestSource = 'assistant' | 'ui';
      const attributionCases: Array<{
        source: RequestSource;
        expected: 'chat' | undefined;
      }> = [
        { source: 'assistant', expected: 'chat' },
        { source: 'ui', expected: undefined },
      ];

      async function runGitAction(
        source: RequestSource,
        gitAction:
          | 'create-pr'
          | 'commit'
          | 'commit-and-push'
          | 'pull-commit-and-push'
          | 'merge-pr',
      ): Promise<void> {
        const response = await dispatchAppAction({
          requestId: `req-attribution-${source}-${gitAction}`,
          source,
          action: {
            type: 'worktree.run_git_action',
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            action: gitAction,
          },
        });
        expect(response.ok).toBe(true);
      }

      afterEach(() => {
        useProjectsStore.setState({ hasUnpulledCommits: {} });
      });

      it.each(attributionCases)(
        'forwards $expected attribution for a $source create-pr',
        async ({ source, expected }) => {
          const createPr = jest.fn().mockResolvedValue(undefined);
          useProjectsStore.setState({
            projects: [makeWorkspace()],
            hasHydratedProjects: true,
            uncommittedChanges: { 'project-1/worktree-1': true },
            hasRemoteTracking: { 'project-1/worktree-1': true },
            hasOriginRemote: { 'project-1/worktree-1': true },
          });
          useGitHubStore.setState({
            createPr,
            prStatuses: {
              'project-1/worktree-1': {
                repos: [
                  {
                    repoId: 'project-1',
                    repoName: 'Project One',
                    status: null,
                  },
                ],
                lastCheckedAt: new Date(0).toISOString(),
              },
            },
          });

          await runGitAction(source, 'create-pr');

          expect(createPr).toHaveBeenCalledWith(
            'project-1',
            'worktree-1',
            undefined,
            { source: expected },
          );
        },
      );

      it.each(attributionCases)(
        'forwards $expected attribution for a $source commit',
        async ({ source, expected }) => {
          const commitOnly = jest.fn().mockResolvedValue(undefined);
          useProjectsStore.setState({
            projects: [makeWorkspace()],
            hasHydratedProjects: true,
            uncommittedChanges: { 'project-1/worktree-1': true },
            hasOriginRemote: { 'project-1/worktree-1': false },
          });
          useGitHubStore.setState({ commitOnly });

          await runGitAction(source, 'commit');

          expect(commitOnly).toHaveBeenCalledWith(
            'project-1',
            'worktree-1',
            undefined,
            { source: expected },
          );
        },
      );

      it.each(attributionCases)(
        'forwards $expected attribution for a $source commit-and-push',
        async ({ source, expected }) => {
          setupMergeablePr(0);
          const commitAndPush = jest.fn().mockResolvedValue(undefined);
          useProjectsStore.setState({
            uncommittedChanges: { 'project-1/worktree-1': true },
          });
          useGitHubStore.setState({ commitAndPush });

          await runGitAction(source, 'commit-and-push');

          expect(commitAndPush).toHaveBeenCalledWith(
            'project-1',
            'worktree-1',
            {
              source: expected,
            },
          );
        },
      );

      it.each(attributionCases)(
        'forwards $expected attribution for a $source pull-commit-and-push',
        async ({ source, expected }) => {
          setupMergeablePr(0);
          const commitAndPush = jest.fn().mockResolvedValue(undefined);
          useProjectsStore.setState({
            uncommittedChanges: { 'project-1/worktree-1': true },
            hasUnpulledCommits: { 'project-1/worktree-1': true },
          });
          useGitHubStore.setState({ commitAndPush });

          await runGitAction(source, 'pull-commit-and-push');

          expect(commitAndPush).toHaveBeenCalledWith(
            'project-1',
            'worktree-1',
            {
              pullFirst: true,
              source: expected,
            },
          );
        },
      );

      it.each(attributionCases)(
        'forwards $expected attribution for a $source merge-pr',
        async ({ source, expected }) => {
          setupMergeablePr(0);
          const mergePr = jest.fn().mockResolvedValue({
            dryRun: false,
            verifiedRepos: [],
            mergedRepos: [
              {
                repoId: 'project-1',
                repoName: 'Project One',
                prNumber: 5,
                prUrl: 'https://github.com/org/repo/pull/5',
                mergeMethod: 'squash',
                mergeCommitSha: 'sha',
                status: 'merged',
              },
            ],
            requiresUnresolvedConfirmation: [],
            failedRepos: [],
          });
          useGitHubStore.setState({ mergePr });

          await runGitAction(source, 'merge-pr');

          expect(mergePr).toHaveBeenCalledWith(
            'project-1',
            'worktree-1',
            expect.objectContaining({ source: expected }),
          );
        },
      );
    });

    it('reports PRs added to a merge queue separately from merged PRs', async () => {
      setupMergeablePr(0);
      const repoResult = (
        repoId: string,
        prNumber: number,
        status: MergePrRepoResult['status'],
      ): MergePrRepoResult => ({
        repoId,
        repoName: repoId,
        prNumber,
        prUrl: `https://github.com/org/repo/pull/${prNumber}`,
        mergeMethod: 'merge',
        mergeCommitSha: status === 'merged' ? 'sha' : null,
        status,
        ...(status === 'enqueued' ? { queuePosition: 1 } : {}),
      });
      const mergePr = jest.fn().mockResolvedValue({
        dryRun: false,
        verifiedRepos: [],
        mergedRepos: [
          repoResult('project-1', 5, 'enqueued'),
          repoResult('project-2', 6, 'merged'),
        ],
        requiresUnresolvedConfirmation: [],
        failedRepos: [],
      });
      useGitHubStore.setState({ mergePr });

      const response = await dispatchAppAction({
        requestId: 'req-merge-pr-enqueued',
        source: 'assistant',
        action: {
          type: 'worktree.run_git_action',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          action: 'merge-pr',
        },
      });

      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({
        mergedPrNumbers: [6],
        enqueuedPrNumbers: [5],
      });
    });

    it('treats an all-enqueued merge as success', async () => {
      setupMergeablePr(0);
      const mergePr = jest.fn().mockResolvedValue({
        dryRun: false,
        verifiedRepos: [],
        mergedRepos: [
          {
            repoId: 'project-1',
            repoName: 'Project One',
            prNumber: 5,
            prUrl: 'https://github.com/org/repo/pull/5',
            mergeMethod: 'merge',
            mergeCommitSha: null,
            status: 'enqueued',
            queuePosition: null,
          },
        ],
        requiresUnresolvedConfirmation: [],
        failedRepos: [],
      });
      useGitHubStore.setState({ mergePr });

      const response = await dispatchAppAction({
        requestId: 'req-merge-pr-all-enqueued',
        source: 'assistant',
        action: {
          type: 'worktree.run_git_action',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          action: 'merge-pr',
        },
      });

      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({
        mergedPrNumbers: [],
        enqueuedPrNumbers: [5],
      });
    });

    const queueChat = (
      repoName: string,
      prNumber: number,
    ): MergePrQueueChatResult => ({
      repoId: repoName,
      repoName,
      prNumber,
      prUrl: `https://github.com/org/repo/pull/${prNumber}`,
      chatId: `merge-queue-${prNumber}`,
    });
    const runMergePr = (
      requestId: string,
    ): ReturnType<typeof dispatchAppAction> =>
      dispatchAppAction({
        requestId,
        source: 'assistant',
        action: {
          type: 'worktree.run_git_action',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          action: 'merge-pr',
        },
      });

    it('reports an opened merge queue chat as a handoff, not a merge', async () => {
      setupMergeablePr(0);
      useGitHubStore.setState({
        mergePr: jest.fn().mockResolvedValue({
          dryRun: false,
          verifiedRepos: [],
          mergedRepos: [],
          mergeQueueChats: [queueChat('Project One', 5)],
          requiresUnresolvedConfirmation: [],
          failedRepos: [],
        }),
      });

      const response = await runMergePr('req-merge-pr-queue-chat');

      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({
        mergedPrNumbers: [],
        enqueuedPrNumbers: [],
        mergeQueueChats: [
          {
            repoName: 'Project One',
            prNumber: 5,
            prUrl: 'https://github.com/org/repo/pull/5',
            chatId: 'merge-queue-5',
          },
        ],
        message:
          'Opened a chat to merge Project One (#5) through the merge queue. Not merged yet.',
      });
    });

    it('describes direct merges and merge queue chats separately', async () => {
      setupMergeablePr(0);
      useGitHubStore.setState({
        mergePr: jest.fn().mockResolvedValue({
          dryRun: false,
          verifiedRepos: [],
          mergedRepos: [
            {
              repoId: 'project-2',
              repoName: 'Project Two',
              prNumber: 6,
              prUrl: 'https://github.com/org/repo/pull/6',
              mergeMethod: 'merge',
              mergeCommitSha: 'sha',
              status: 'merged',
            },
          ],
          mergeQueueChats: [queueChat('Project One', 5)],
          requiresUnresolvedConfirmation: [],
          failedRepos: [],
        }),
      });

      const response = await runMergePr('req-merge-pr-queue-chat-mixed');

      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({
        mergedPrNumbers: [6],
        mergeQueueChats: [{ prNumber: 5 }],
        message:
          'Merged Project Two (#6). Opened a chat to merge Project One (#5) through the merge queue. Not merged yet.',
      });
    });

    it('keeps a merge-only result free of merge queue chat details', async () => {
      setupMergeablePr(0);
      useGitHubStore.setState({
        mergePr: jest.fn().mockResolvedValue({
          dryRun: false,
          verifiedRepos: [],
          mergedRepos: [
            {
              repoId: 'project-1',
              repoName: 'Project One',
              prNumber: 5,
              prUrl: 'https://github.com/org/repo/pull/5',
              mergeMethod: 'merge',
              mergeCommitSha: 'sha',
              status: 'merged',
            },
          ],
          requiresUnresolvedConfirmation: [],
          failedRepos: [],
        }),
      });

      const response = await runMergePr('req-merge-pr-no-queue-field');

      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({ mergeQueueChats: [] });
      expect(response.result).not.toHaveProperty('message');
    });

    it('reports a merge queue chat beside a failure as partial', async () => {
      setupMergeablePr(0);
      useGitHubStore.setState({
        mergePr: jest.fn().mockResolvedValue({
          dryRun: false,
          verifiedRepos: [],
          mergedRepos: [],
          mergeQueueChats: [queueChat('Project One', 5)],
          requiresUnresolvedConfirmation: [],
          failedRepos: [
            {
              repoId: 'project-2',
              repoName: 'Project Two',
              prNumber: 6,
              error: 'No window is available',
              status: 'failed',
            },
          ],
        }),
      });

      const response = await runMergePr('req-merge-pr-queue-chat-partial');

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('execution_failed');
      expect(response.error?.message).toContain(
        'The pull request merge partially completed',
      );
      expect(response.error?.message).toContain(
        'opened a merge queue chat for Project One (#5), which is not merged yet',
      );
      expect(response.error?.message).toContain(
        'failed for Project Two (No window is available)',
      );
    });

    it('reports cancellation after a merge queue handoff as partial', async () => {
      setupMergeablePr(0);
      useGitHubStore.setState({
        mergePr: jest.fn().mockResolvedValue({
          dryRun: false,
          cancelled: true,
          verifiedRepos: [],
          mergedRepos: [],
          mergeQueueChats: [queueChat('Project One', 5)],
          requiresUnresolvedConfirmation: [],
          failedRepos: [],
        }),
      });

      const response = await runMergePr('req-merge-pr-chat-cancelled');

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('execution_failed');
      expect(response.error?.message).toContain(
        'opened a merge queue chat for Project One (#5), which is not merged yet',
      );
      expect(response.error?.message).toContain(
        'cancelled before the remaining pull requests were processed',
      );
    });

    it('reports a queue handoff beside a blocked repo as partial', async () => {
      setupMergeablePr(0);
      useGitHubStore.setState({
        mergePr: jest.fn().mockResolvedValue({
          dryRun: false,
          verifiedRepos: [
            {
              repoId: 'project-2',
              repoName: 'Project Two',
              prNumber: 6,
              prUrl: 'https://github.com/org/repo/pull/6',
              mergeable: false,
              unresolvedReviewThreadCount: 0,
              blockedReason: 'has_conflicts',
            },
          ],
          mergedRepos: [],
          mergeQueueChats: [queueChat('Project One', 5)],
          requiresUnresolvedConfirmation: [],
          failedRepos: [],
        }),
      });
      const response = await runMergePr('req-merge-pr-chat-blocked');
      expect(response.ok).toBe(false);
      expect(response.error?.message).toContain(
        'opened a merge queue chat for Project One (#5)',
      );
      expect(response.error?.message).toContain('Project Two');
      expect(response.error?.message).toContain('conflicts');
    });

    it('reports a merge queue chat beside a pending confirmation as partial', async () => {
      setupMergeablePr(0);
      useGitHubStore.setState({
        mergePr: jest.fn().mockResolvedValue({
          dryRun: false,
          verifiedRepos: [],
          mergedRepos: [],
          mergeQueueChats: [queueChat('Project One', 5)],
          requiresUnresolvedConfirmation: [
            {
              repoId: 'project-2',
              repoName: 'Project Two',
              prNumber: 6,
              prUrl: 'https://github.com/org/repo/pull/6',
              unresolvedReviewThreadCount: 1,
            },
          ],
          failedRepos: [],
        }),
      });

      const response = await runMergePr('req-merge-pr-queue-chat-unresolved');

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('execution_failed');
      expect(response.error?.message).toContain(
        'opened a merge queue chat for Project One (#5)',
      );
      expect(response.error?.message).toContain(
        'requires unresolved-comment confirmation for Project Two (#6)',
      );
    });

    it('does not ask the agent to retry a PR that is already queued', async () => {
      setupMergeablePr(0);
      const mergePr = jest.fn().mockResolvedValue({
        dryRun: false,
        verifiedRepos: [
          {
            repoId: 'project-1',
            repoName: 'Project One',
            prNumber: 5,
            prUrl: 'https://github.com/org/repo/pull/5',
            mergeable: false,
            unresolvedReviewThreadCount: 0,
            blockedReason: 'in_merge_queue',
          },
        ],
        mergedRepos: [],
        requiresUnresolvedConfirmation: [],
        failedRepos: [],
      });
      useGitHubStore.setState({ mergePr });

      const response = await dispatchAppAction({
        requestId: 'req-merge-pr-already-queued',
        source: 'assistant',
        action: {
          type: 'worktree.run_git_action',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          action: 'merge-pr',
        },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.message).toContain(
        'Project One (already in the merge queue)',
      );
      expect(response.error?.retryable).toBe(false);
    });

    it('describes enqueued repos in a partial result', async () => {
      setupMergeablePr(0);
      const mergePr = jest.fn().mockResolvedValue({
        dryRun: false,
        verifiedRepos: [
          {
            repoId: 'project-2',
            repoName: 'Project Two',
            prNumber: 6,
            prUrl: 'https://github.com/org/repo/pull/6',
            mergeable: false,
            unresolvedReviewThreadCount: 0,
            blockedReason: 'in_merge_queue',
          },
        ],
        mergedRepos: [
          {
            repoId: 'project-1',
            repoName: 'Project One',
            prNumber: 5,
            prUrl: 'https://github.com/org/repo/pull/5',
            mergeMethod: 'merge',
            mergeCommitSha: null,
            status: 'enqueued',
          },
        ],
        requiresUnresolvedConfirmation: [],
        failedRepos: [],
      });
      useGitHubStore.setState({ mergePr });

      const response = await dispatchAppAction({
        requestId: 'req-merge-pr-partial-enqueued',
        source: 'assistant',
        action: {
          type: 'worktree.run_git_action',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          action: 'merge-pr',
        },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.message).toContain(
        'added Project One (#5) to the merge queue',
      );
      expect(response.error?.message).not.toContain('merged Project One');
      expect(response.error?.message).toContain(
        'blocked for Project Two #6 (already in the merge queue)',
      );
    });

    it('rejects an unresolved-comment PR without the ignore flag', async () => {
      setupMergeablePr(2);
      const mergePr = jest.fn().mockResolvedValue({
        dryRun: false,
        verifiedRepos: [],
        mergedRepos: [],
        requiresUnresolvedConfirmation: [
          {
            repoId: 'project-1',
            repoName: 'Project One',
            prNumber: 5,
            prUrl: 'https://github.com/org/repo/pull/5',
            unresolvedReviewThreadCount: 2,
          },
        ],
        failedRepos: [],
      });
      useGitHubStore.setState({ mergePr });

      const response = await dispatchAppAction({
        requestId: 'req-merge-pr-unresolved',
        source: 'assistant',
        action: {
          type: 'worktree.run_git_action',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          action: 'merge-pr',
        },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('invalid_payload');
      expect(response.error?.message).toContain(
        'ignoreUnresolvedCommentsWarning: true',
      );
      expect(mergePr).toHaveBeenCalledWith('project-1', 'worktree-1', {
        repoIds: undefined,
        confirmUnresolvedComments: false,
        source: 'chat',
      });
    });

    it('merges an unresolved-comment PR when the ignore flag is set', async () => {
      setupMergeablePr(2);
      const mergePr = jest.fn().mockResolvedValue({
        dryRun: false,
        verifiedRepos: [],
        mergedRepos: [
          {
            repoId: 'project-1',
            repoName: 'Project One',
            prNumber: 5,
            prUrl: 'https://github.com/org/repo/pull/5',
            mergeMethod: 'merge',
            mergeCommitSha: 'sha',
            status: 'merged',
          },
        ],
        requiresUnresolvedConfirmation: [],
        failedRepos: [],
      });
      useGitHubStore.setState({ mergePr });

      const response = await dispatchAppAction({
        requestId: 'req-merge-pr-confirmed',
        source: 'assistant',
        action: {
          type: 'worktree.run_git_action',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          action: 'merge-pr',
          ignoreUnresolvedCommentsWarning: true,
        },
      });

      expect(response.ok).toBe(true);
      expect(mergePr).toHaveBeenCalledWith('project-1', 'worktree-1', {
        repoIds: undefined,
        confirmUnresolvedComments: true,
        source: 'chat',
      });
    });

    it('reports partial success when a later repo requires unresolved-comment confirmation', async () => {
      setupMergeablePr(0);
      const mergePr = jest.fn().mockResolvedValue({
        dryRun: false,
        verifiedRepos: [],
        mergedRepos: [
          {
            repoId: 'project-1',
            repoName: 'Project One',
            prNumber: 5,
            prUrl: 'https://github.com/org/repo/pull/5',
            mergeMethod: 'merge',
            mergeCommitSha: 'sha',
            status: 'merged',
          },
        ],
        requiresUnresolvedConfirmation: [
          {
            repoId: 'project-2',
            repoName: 'Project Two',
            prNumber: 6,
            prUrl: 'https://github.com/org/repo/pull/6',
            unresolvedReviewThreadCount: 1,
          },
        ],
        failedRepos: [],
      });
      useGitHubStore.setState({ mergePr });

      const response = await dispatchAppAction({
        requestId: 'req-merge-pr-partial-unresolved',
        source: 'assistant',
        action: {
          type: 'worktree.run_git_action',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          action: 'merge-pr',
        },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('execution_failed');
      expect(response.error?.message).toContain(
        'The pull request merge partially completed',
      );
      expect(response.error?.message).toContain('merged Project One (#5)');
      expect(response.error?.message).toContain(
        'requires unresolved-comment confirmation for Project Two (#6)',
      );
      expect(response.error?.message).not.toContain('was not merged');
    });

    it('reports partial success when some requested repos fail or remain blocked', async () => {
      setupMergeablePr(0);
      const mergePr = jest.fn().mockResolvedValue({
        dryRun: false,
        verifiedRepos: [
          {
            repoId: 'project-3',
            repoName: 'Project Three',
            prNumber: 7,
            prUrl: 'https://github.com/org/repo/pull/7',
            mergeable: false,
            unresolvedReviewThreadCount: 0,
            blockedReason: 'has_conflicts',
          },
        ],
        mergedRepos: [
          {
            repoId: 'project-1',
            repoName: 'Project One',
            prNumber: 5,
            prUrl: 'https://github.com/org/repo/pull/5',
            mergeMethod: 'squash',
            mergeCommitSha: 'sha',
            status: 'merged',
          },
        ],
        requiresUnresolvedConfirmation: [],
        failedRepos: [
          {
            repoId: 'project-2',
            repoName: 'Project Two',
            prNumber: 6,
            error: 'branch protection rejected the merge',
            status: 'failed',
          },
        ],
      });
      useGitHubStore.setState({ mergePr });

      const response = await dispatchAppAction({
        requestId: 'req-merge-pr-partial-failed',
        source: 'assistant',
        action: {
          type: 'worktree.run_git_action',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          action: 'merge-pr',
        },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('execution_failed');
      expect(response.error?.message).toContain('merged Project One (#5)');
      expect(response.error?.message).toContain(
        'failed for Project Two (branch protection rejected the merge)',
      );
      expect(response.error?.message).toContain(
        'blocked for Project Three #7 (has conflicts)',
      );
    });

    it('reports a no-longer-mergeable PR as unavailable', async () => {
      setupMergeablePr(0);
      const mergePr = jest.fn().mockResolvedValue({
        dryRun: false,
        verifiedRepos: [
          {
            repoId: 'project-1',
            repoName: 'Project One',
            prNumber: 5,
            prUrl: 'https://github.com/org/repo/pull/5',
            mergeable: false,
            unresolvedReviewThreadCount: 0,
            blockedReason: 'not_mergeable',
          },
        ],
        mergedRepos: [],
        requiresUnresolvedConfirmation: [],
        failedRepos: [],
      });
      useGitHubStore.setState({ mergePr });

      const response = await dispatchAppAction({
        requestId: 'req-merge-pr-not-mergeable',
        source: 'assistant',
        action: {
          type: 'worktree.run_git_action',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          action: 'merge-pr',
        },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('surface_unavailable');
    });

    it('lists merge-pr as an available action for a mergeable PR', async () => {
      setupMergeablePr(0);

      const response = await dispatchAppAction({
        requestId: 'req-list-merge-pr',
        source: 'assistant',
        action: {
          type: 'worktree.list_git_actions',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      });

      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({
        actions: [{ action: 'merge-pr', label: 'Merge PR' }],
      });
    });

    it('does not list merge-pr while a PR merge is already running', async () => {
      setupMergeablePr(0);
      useGitHubStore.setState({
        mergingPr: new Set(['project-1/worktree-1']),
      });

      const response = await dispatchAppAction({
        requestId: 'req-list-merge-pr-busy',
        source: 'assistant',
        action: {
          type: 'worktree.list_git_actions',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      });

      expect(response.ok).toBe(true);
      const withoutMergePr: unknown = expect.not.arrayContaining([
        expect.objectContaining({ action: 'merge-pr' }),
      ]);
      expect(response.result).toMatchObject({
        busy: true,
        actions: withoutMergePr,
      });
    });

    it('blocks merge-pr dispatch while a PR merge is already running', async () => {
      setupMergeablePr(0);
      const mergePr = jest.fn();
      useGitHubStore.setState({
        mergePr,
        mergingPr: new Set(['project-1/worktree-1']),
      });

      const response = await dispatchAppAction({
        requestId: 'req-merge-pr-busy',
        source: 'assistant',
        action: {
          type: 'worktree.run_git_action',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          action: 'merge-pr',
        },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('surface_unavailable');
      expect(response.error?.message).toContain(
        'A git action is already running',
      );
      expect(mergePr).not.toHaveBeenCalled();
    });

    it('starts the merge-conflict resolution chat from App Advisor', async () => {
      useProjectsStore.setState({
        projects: [makeWorkspace()],
        hasHydratedProjects: true,
      });

      const response = await dispatchAppAction({
        requestId: 'req-start-conflict-resolution',
        source: 'assistant',
        action: {
          type: 'worktree.start_merge_conflict_resolution',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          repoId: 'repo-a',
          repoName: 'Repo A',
          branchName: 'feature/conflict',
        },
      });

      expect(response.ok).toBe(true);
      expect(githubStartMergeConflictResolutionMock).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        repoId: 'repo-a',
        repoName: 'Repo A',
        branchName: 'feature/conflict',
      });
      expect(response.result).toMatchObject({
        dispatchedAction: 'worktree.start_merge_conflict_resolution',
        chatId: 'conflict-chat-1',
        repoId: 'repo-a',
      });
    });

    it('starts the PR review-comment triage chat from App Advisor', async () => {
      useProjectsStore.setState({
        projects: [makeWorkspace()],
        hasHydratedProjects: true,
      });

      const response = await dispatchAppAction({
        requestId: 'req-start-comment-triage',
        source: 'assistant',
        action: {
          type: 'worktree.start_pr_comment_triage',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          repoId: 'repo-a',
          repoName: 'Repo A',
          branchName: 'feature/comments',
        },
      });

      expect(response.ok).toBe(true);
      expect(githubStartPrCommentTriageMock).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        repoId: 'repo-a',
        repoName: 'Repo A',
        branchName: 'feature/comments',
      });
      expect(response.result).toMatchObject({
        dispatchedAction: 'worktree.start_pr_comment_triage',
        chatId: 'triage-chat-1',
        repoId: 'repo-a',
      });
    });

    it('starts the CI check fix chat from App Advisor', async () => {
      useProjectsStore.setState({
        projects: [makeWorkspace()],
        hasHydratedProjects: true,
      });

      const response = await dispatchAppAction({
        requestId: 'req-start-ci-fix',
        source: 'assistant',
        action: {
          type: 'worktree.start_ci_check_fix',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          repoId: 'repo-a',
          repoName: 'Repo A',
          branchName: 'feature/ci',
        },
      });

      expect(response.ok).toBe(true);
      expect(githubStartCiCheckFixMock).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        repoId: 'repo-a',
        repoName: 'Repo A',
        branchName: 'feature/ci',
      });
      expect(response.result).toMatchObject({
        dispatchedAction: 'worktree.start_ci_check_fix',
        chatId: 'ci-fix-chat-1',
        repoId: 'repo-a',
      });
    });
  });

  it('reports worktree git actions as busy while commit review is pending', async () => {
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
      uncommittedChanges: { 'project-1/worktree-1': true },
      hasRemoteTracking: { 'project-1/worktree-1': true },
      hasOriginRemote: { 'project-1/worktree-1': true },
    });
    useGitHubStore.setState({
      commitReviewPending: {
        'project-1/worktree-1': {
          repos: [{ repoName: 'Project One', message: 'Commit message' }],
          resolve: jest.fn(),
          actionLabel: 'Commit & push',
        },
      },
      prStatuses: {
        'project-1/worktree-1': {
          repos: [
            { repoId: 'project-1', repoName: 'Project One', status: null },
          ],
          lastCheckedAt: new Date(0).toISOString(),
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-worktree-git-actions-review-pending',
      source: 'assistant',
      action: {
        type: 'worktree.list_git_actions',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      busy: true,
      totalActions: 1,
      actions: [{ action: 'create-pr' }],
    });
  });

  it('rejects worktree git actions while another git operation is running', async () => {
    const createPr = jest.fn().mockResolvedValue(undefined);
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
    });
    useGitHubStore.setState({
      createPr,
      committingAndPushing: new Set(['project-1/worktree-1']),
    });

    const response = await dispatchAppAction({
      requestId: 'req-run-worktree-git-action-busy',
      source: 'assistant',
      action: {
        type: 'worktree.run_git_action',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        action: 'create-pr',
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('surface_unavailable');
    expect(createPr).not.toHaveBeenCalled();
  });

  it('rejects worktree git actions while commit review is pending', async () => {
    const createPr = jest.fn().mockResolvedValue(undefined);
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
      uncommittedChanges: { 'project-1/worktree-1': true },
      hasRemoteTracking: { 'project-1/worktree-1': true },
      hasOriginRemote: { 'project-1/worktree-1': true },
    });
    useGitHubStore.setState({
      createPr,
      commitReviewPending: {
        'project-1/worktree-1': {
          repos: [{ repoName: 'Project One', message: 'Commit message' }],
          resolve: jest.fn(),
          actionLabel: 'Commit & push',
        },
      },
      prStatuses: {
        'project-1/worktree-1': {
          repos: [
            { repoId: 'project-1', repoName: 'Project One', status: null },
          ],
          lastCheckedAt: new Date(0).toISOString(),
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-run-worktree-git-action-review-pending',
      source: 'assistant',
      action: {
        type: 'worktree.run_git_action',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        action: 'create-pr',
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('surface_unavailable');
    expect(createPr).not.toHaveBeenCalled();
  });

  it('rejects repoIds supplied for unscoped worktree git actions', async () => {
    const createPr = jest.fn().mockResolvedValue(undefined);
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
      uncommittedChanges: { 'project-1/worktree-1': true },
      hasRemoteTracking: { 'project-1/worktree-1': true },
      hasOriginRemote: { 'project-1/worktree-1': true },
    });
    useGitHubStore.setState({
      createPr,
      prStatuses: {
        'project-1/worktree-1': {
          repos: [
            { repoId: 'project-1', repoName: 'Project One', status: null },
          ],
          lastCheckedAt: new Date(0).toISOString(),
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-run-worktree-git-action-unscoped-repos',
      source: 'assistant',
      action: {
        type: 'worktree.run_git_action',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        action: 'create-pr',
        repoIds: ['project-1'],
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('invalid_target');
    expect(createPr).not.toHaveBeenCalled();
  });

  it('rejects repoIds outside the scoped worktree git action', async () => {
    const createPr = jest.fn().mockResolvedValue(undefined);
    useProjectsStore.setState({
      projects: [
        makeMultiRepoWorkspace({
          id: 'project-1',
          name: 'Project One',
          repos: [
            {
              id: 'repo-a',
              name: 'Repo A',
              repoPath: '/repo/a',
              source: 'local',
            },
            {
              id: 'repo-b',
              name: 'Repo B',
              repoPath: '/repo/b',
              source: 'local',
            },
          ],
        }),
      ],
      hasHydratedProjects: true,
      repoBranches: {
        'project-1/worktree-1': [
          {
            repoId: 'repo-a',
            repoName: 'Repo A',
            branch: 'feature',
            hasUncommittedChanges: true,
            hasOriginRemote: true,
          },
          {
            repoId: 'repo-b',
            repoName: 'Repo B',
            branch: 'feature',
            hasOriginRemote: true,
          },
        ],
      },
    });
    useGitHubStore.setState({
      createPr,
      prStatuses: {
        'project-1/worktree-1': {
          repos: [
            { repoId: 'repo-a', repoName: 'Repo A', status: null },
            { repoId: 'repo-b', repoName: 'Repo B', status: null },
          ],
          lastCheckedAt: new Date(0).toISOString(),
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-run-worktree-git-action-out-of-scope-repos',
      source: 'assistant',
      action: {
        type: 'worktree.run_git_action',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        action: 'create-pr',
        repoIds: ['repo-b'],
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('invalid_target');
    expect(createPr).not.toHaveBeenCalled();
  });

  it('returns optimized last user and last agent chat messages', async () => {
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [makeChatTab()],
        },
      },
    });

    const lastUser = await dispatchAppAction({
      requestId: 'req-last-user',
      source: 'assistant',
      action: { type: 'worktree-chat.get_last_user_message' },
    });
    const lastAgent = await dispatchAppAction({
      requestId: 'req-last-agent',
      source: 'assistant',
      action: { type: 'worktree-chat.get_last_agent_response' },
    });

    expect(lastUser.ok).toBe(true);
    expect(JSON.stringify(lastUser.result)).toContain(
      'Now check the App Advisor transcript.',
    );
    expect(lastAgent.ok).toBe(true);
    expect(JSON.stringify(lastAgent.result)).toContain(
      'The App Advisor transcript is readable.',
    );
  });

  it('excludes hidden deliveries from optimized and archived history inspection', async () => {
    const messages = [
      ...makeChatTab().messages,
      {
        id: 'hidden-delivery',
        role: 'user' as const,
        hidden: true,
        timestamp: 50,
        blocks: [
          { type: 'text' as const, text: 'private orchestration token' },
        ],
      },
    ];
    useChatStore.setState({
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [makeChatTab({ messages })],
        },
      },
    });

    const lastUser = await dispatchAppAction({
      requestId: 'req-last-visible-user',
      source: 'assistant',
      action: {
        type: 'worktree-chat.get_last_user_message',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    });
    const history = await dispatchAppAction({
      requestId: 'req-visible-history',
      source: 'assistant',
      action: {
        type: 'worktree-chat.read_history',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        limit: 50,
      },
    });

    expect(JSON.stringify(lastUser.result)).toContain(
      'Now check the App Advisor transcript.',
    );
    expect(JSON.stringify(lastUser.result)).not.toContain(
      'private orchestration',
    );
    expect(JSON.stringify(history.result)).not.toContain(
      'private orchestration',
    );
    expect(history.result).toMatchObject({ totalMessages: 4 });
  });

  it('returns searchable bounded chat transcript history', async () => {
    useChatStore.setState({
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [makeChatTab()],
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-history',
      source: 'assistant',
      action: {
        type: 'worktree-chat.read_history',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        query: 'transcript',
        limit: 1,
      },
    });

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      mode: 'transcript',
      matchedMessages: 2,
      returnedMessages: 1,
    });
    expect(JSON.stringify(response.result)).toContain(
      'The App Advisor transcript is readable.',
    );
    expect(JSON.stringify(response.result)).not.toContain(
      'Now check the App Advisor transcript.',
    );
    expect(JSON.stringify(response.result)).toContain('agentTurn');
  });

  it('searches worktree chat history beyond the hydrated transcript page', async () => {
    const latest = {
      id: 'latest-message',
      role: 'assistant' as const,
      blocks: [{ type: 'text' as const, text: 'Newest reply' }],
      timestamp: 2,
    };
    const oldest = {
      id: 'oldest-message',
      role: 'assistant' as const,
      blocks: [{ type: 'text' as const, text: 'Needle before page boundary' }],
      timestamp: 1,
    };
    useChatStore.setState({
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [
            makeChatTab({
              messages: [],
              transcriptLoaded: false,
              transcript: {
                format: 'complete-message-jsonl-v1',
                committedMessageCount: 2,
                committedByteLength: 100,
                transcriptRevision: 7,
                hasActiveSidecar: false,
              },
            }),
          ],
        },
      },
    });
    chatApiMock.getTranscriptPage
      .mockResolvedValueOnce({
        messages: [latest],
        before: 1,
        totalMessages: 2,
        transcriptRevision: 7,
      })
      .mockResolvedValueOnce({
        messages: [oldest],
        totalMessages: 2,
        transcriptRevision: 7,
      });

    const response = await dispatchAppAction({
      requestId: 'req-history-paged',
      source: 'assistant',
      action: {
        type: 'worktree-chat.read_history',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        query: 'needle',
        limit: 1,
      },
    });

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      totalMessages: 2,
      matchedMessages: 1,
      returnedMessages: 1,
    });
    expect(JSON.stringify(response.result)).toContain(
      'Needle before page boundary',
    );
    expect(chatApiMock.getTranscriptPage).toHaveBeenCalledTimes(2);
  });

  it('bounds paused completed turn inspection duration at completion time', async () => {
    jest.setSystemTime(20_000);
    useChatStore.setState({
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [
            makeChatTab({
              messages: [
                {
                  id: 'user-1',
                  role: 'user',
                  timestamp: 1_000,
                  blocks: [{ type: 'text', text: 'Need input' }],
                },
                {
                  id: 'timer-1',
                  role: 'system',
                  timestamp: 1_000,
                  blocks: [
                    {
                      type: 'turn_timer',
                      startedAt: 1_000,
                      pausedAt: 5_000,
                      resumedAt: null,
                      completedAt: 5_000,
                    },
                  ],
                },
              ],
              status: 'idle',
            }),
          ],
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-history-paused',
      source: 'assistant',
      action: {
        type: 'worktree-chat.read_history',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    });

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      agentTurn: {
        state: 'completed',
        durationMs: 4000,
      },
    });
  });

  it('lists projects and worktrees for App Advisor', async () => {
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
    });

    const workspaces = await dispatchAppAction({
      requestId: 'req-workspace-list',
      source: 'assistant',
      action: { type: 'workspace.list' },
    });
    const worktrees = await dispatchAppAction({
      requestId: 'req-worktree-list',
      source: 'assistant',
      action: {
        type: 'workspace.list_worktrees',
        workspaceId: 'project-1',
      },
    });

    expect(workspaces.ok).toBe(true);
    expect(JSON.stringify(workspaces.result)).toContain('Project One');
    expect(worktrees.ok).toBe(true);
    expect(JSON.stringify(worktrees.result)).toContain('worktree-1');
  });

  it('lists canonical group order and complete branch stacks with group IDs', async () => {
    const workspace = makeWorkspace();
    workspace.worktrees.push({
      id: 'child-one',
      branchName: 'child',
      branchGroupingParentWorktreeId: 'worktree-1',
      createdAt: new Date(0).toISOString(),
    });
    workspace.worktrees.push({
      id: 'other',
      branchName: 'other',
      createdAt: new Date(0).toISOString(),
    });
    useProjectsStore.setState({
      projects: [workspace],
      hasHydratedProjects: true,
    });
    const group = {
      id: 'grp-one',
      name: 'Tasks',
      color: 'categorical-2',
      collapsed: false,
      memberIds: ['worktree-1'],
    };
    sidebarItemGroupsApiMock.list.mockResolvedValue([group]);
    const listed = await dispatchAppAction({
      requestId: 'groups-list-worktrees',
      source: 'assistant',
      action: { type: 'workspace.list_worktrees', workspaceId: workspace.id },
    });
    expect(listed.result).toMatchObject({
      worktrees: [
        { id: 'worktree-1', groupId: group.id },
        { id: 'child-one', groupId: group.id },
        { id: 'other' },
      ],
    });
    const scope = { workspaceLocalId: workspace.id };
    const groups = await dispatchAppAction({
      requestId: 'groups-list',
      source: 'assistant',
      action: { type: 'sidebar.item_groups.list', scope },
    });
    expect(groups.result).toMatchObject({ groups: [{ ...group, order: 0 }] });
    const members = await dispatchAppAction({
      requestId: 'groups-members',
      source: 'assistant',
      action: {
        type: 'sidebar.item_groups.list_items',
        scope,
        groupId: group.id,
      },
    });
    expect(members.result).toMatchObject({
      items: [
        { id: 'worktree-1', groupId: group.id },
        { id: 'child-one', groupId: group.id },
      ],
      returned: 2,
    });
    expect(members.result).toHaveProperty('group', group);
    const missing = await dispatchAppAction({
      requestId: 'groups-missing',
      source: 'assistant',
      action: {
        type: 'sidebar.item_groups.list_items',
        scope,
        groupId: 'grp-unknown',
      },
    });
    expect(missing).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('reports a failed sidebar group listing instead of silently dropping memberships', async () => {
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
    });
    sidebarItemGroupsApiMock.list.mockRejectedValueOnce(
      new Error('Sidebar group IPC failed'),
    );
    const response = await dispatchAppAction({
      requestId: 'groups-list-failure',
      source: 'assistant',
      action: { type: 'workspace.list_worktrees', workspaceId: 'project-1' },
    });
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'execution_failed', message: 'Sidebar group IPC failed' },
    });
  });

  it.each(['create', 'move', 'update'] as const)(
    'acknowledges a committed group %s when inventory refresh fails',
    async (operation) => {
      const workspace = makeWorkspace();
      useProjectsStore.setState({
        projects: [workspace],
        hasHydratedProjects: true,
      });
      const store = useSidebarItemGroupsStore.getState();
      const create = jest.spyOn(store, 'create').mockResolvedValue({
        id: 'grp-one',
        name: 'Tasks',
        color: 'neutral',
        collapsed: false,
        memberIds: ['worktree-1'],
      });
      const moveItem = jest.spyOn(store, 'moveItem').mockResolvedValue();
      const update = jest.spyOn(store, 'update').mockResolvedValue();
      loadPreferencesMock.mockRejectedValueOnce(
        new Error('Preferences unavailable'),
      );
      try {
        const action =
          operation === 'create'
            ? {
                type: 'sidebar.item_groups.create' as const,
                scope: { workspaceLocalId: workspace.id },
                itemId: 'worktree-1',
              }
            : operation === 'move'
              ? {
                  type: 'sidebar.item_groups.move_item' as const,
                  scope: { workspaceLocalId: workspace.id },
                  itemId: 'worktree-1',
                  groupId: 'grp-one',
                }
              : {
                  type: 'sidebar.item_groups.update' as const,
                  scope: { workspaceLocalId: workspace.id },
                  groupId: 'grp-one',
                  name: 'Renamed',
                };
        const response = await dispatchAppAction({
          requestId: `group-${operation}-refresh-failure`,
          source: 'assistant',
          action,
        });
        expect(response).toMatchObject({
          ok: true,
          result: { groupId: 'grp-one', refreshFailed: true },
        });
      } finally {
        create.mockRestore();
        moveItem.mockRestore();
        update.mockRestore();
      }
    },
  );

  it('forwards group label visibility on create and update', async () => {
    const workspace = makeWorkspace();
    useProjectsStore.setState({
      projects: [workspace],
      hasHydratedProjects: true,
    });
    const scope = { workspaceLocalId: workspace.id };
    const store = useSidebarItemGroupsStore.getState();
    const create = jest.spyOn(store, 'create').mockResolvedValue({
      id: 'grp-one',
      name: 'Tasks',
      color: 'neutral',
      collapsed: false,
      labelHidden: true,
      memberIds: ['worktree-1'],
    });
    const update = jest.spyOn(store, 'update').mockResolvedValue();
    try {
      await dispatchAppAction({
        requestId: 'group-create-label-hidden',
        source: 'assistant',
        action: {
          type: 'sidebar.item_groups.create',
          scope,
          itemId: 'worktree-1',
          name: 'Tasks',
          labelHidden: true,
        },
      });
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Tasks', labelHidden: true }),
      );
      await dispatchAppAction({
        requestId: 'group-update-label-hidden',
        source: 'assistant',
        action: {
          type: 'sidebar.item_groups.update',
          scope,
          groupId: 'grp-one',
          labelHidden: false,
        },
      });
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ groupId: 'grp-one', labelHidden: false }),
      );
    } finally {
      create.mockRestore();
      update.mockRestore();
    }
  });

  it('keeps cross-workspace execution scopes when one group sidecar cannot be read', async () => {
    useProjectsStore.setState({
      projects: [
        makeWorkspace(),
        makeWorkspace({ id: 'project-2', name: 'Two' }),
      ],
      hasHydratedProjects: true,
    });
    sidebarItemGroupsApiMock.list.mockImplementation(
      (scope: { workspaceLocalId: string }) => {
        if (scope.workspaceLocalId === 'project-1')
          return Promise.reject(new Error('Unsupported sidebar group version'));
        return Promise.resolve([
          {
            id: 'grp-two',
            name: 'Two',
            color: 'neutral',
            collapsed: false,
            memberIds: ['worktree-1'],
          },
        ]);
      },
    );
    pipelinesApiMock.listExecutions.mockResolvedValue({
      success: true,
      data: [],
    });
    const response = await dispatchAppAction({
      requestId: 'cross-workspace-groups-failure',
      source: 'assistant',
      action: { type: 'pipeline.execution_list' },
    });
    expect(response).toMatchObject({
      ok: true,
      result: {
        availableScopes: {
          workspaces: [
            { id: 'project-1', worktrees: [{ id: 'worktree-1' }] },
            {
              id: 'project-2',
              worktrees: [{ id: 'worktree-1', groupId: 'grp-two' }],
            },
          ],
        },
      },
    });
  });

  it('includes the owning entry group ID when listing Cowork chats', async () => {
    chatApiMock.loadTabs.mockResolvedValue({
      version: 1,
      activeTabId: 'chat-1',
      tabs: [makeChatTab({ id: 'chat-1', kind: 'chat' })],
    });
    useStandaloneChatStore.setState({
      chatProjects: [makeStandaloneProject()],
      chatProjectsLoaded: true,
    });
    sidebarItemGroupsApiMock.list.mockResolvedValue([
      {
        id: 'grp-cowork',
        name: 'Tasks',
        color: 'neutral',
        collapsed: false,
        memberIds: ['entry-1'],
      },
    ]);
    const listed = await dispatchAppAction({
      requestId: 'groups-cowork-chats',
      source: 'assistant',
      action: { type: 'standalone-chat.list_chats', projectId: 'project-a' },
    });
    expect(listed.ok).toBe(true);
    expect(listed.result).toMatchObject({
      chats: [
        expect.objectContaining({
          workEntryId: 'entry-1',
          groupId: 'grp-cowork',
        }),
      ],
    });
  });

  it('opens archive confirmation with the requested local-branch choice', async () => {
    const archiveWorktree = jest.fn().mockResolvedValue(undefined);
    const confirmationRequests: unknown[] = [];
    const handleConfirmationRequest = (event: Event): void => {
      if (event instanceof CustomEvent) {
        confirmationRequests.push(event.detail);
        event.preventDefault();
      }
    };
    window.addEventListener(
      OPEN_WORKTREE_ARCHIVE_CONFIRMATION_EVENT,
      handleConfirmationRequest,
    );
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
      archiveWorktree,
    });

    const response = await dispatchAppAction({
      requestId: 'req-worktree-archive',
      source: 'assistant',
      action: {
        type: 'worktree.archive',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        deleteBranch: false,
      },
    });

    window.removeEventListener(
      OPEN_WORKTREE_ARCHIVE_CONFIRMATION_EVENT,
      handleConfirmationRequest,
    );
    expect(response).toMatchObject({
      requestId: 'req-worktree-archive',
      ok: true,
      result: {
        workspaceId: 'project-1',
        worktreeId: 'worktree-1',
        confirmationOpened: true,
        requestedDeleteBranch: false,
        mode: 'delete',
      },
    });
    expect(confirmationRequests).toEqual([
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        requestedDeleteBranch: false,
      },
    ]);
    expect(archiveWorktree).not.toHaveBeenCalled();
  });

  // The dialog has no mode switch: it opens as "Delete worktree?" unless the
  // request asks for Archive, and the branch choice is its Keep the local
  // branch switch. A user who asks to archive must get the Archive dialog.
  it('opens the Archive confirmation when the request asks for Archive mode', async () => {
    const confirmationRequests: unknown[] = [];
    const handleConfirmationRequest = (event: Event): void => {
      if (event instanceof CustomEvent) {
        confirmationRequests.push(event.detail);
        event.preventDefault();
      }
    };
    window.addEventListener(
      OPEN_WORKTREE_ARCHIVE_CONFIRMATION_EVENT,
      handleConfirmationRequest,
    );
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
    });

    const response = await dispatchAppAction({
      requestId: 'req-worktree-archive-mode',
      source: 'assistant',
      action: {
        type: 'worktree.archive',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        deleteBranch: false,
        mode: 'archive',
      },
    });

    window.removeEventListener(
      OPEN_WORKTREE_ARCHIVE_CONFIRMATION_EVENT,
      handleConfirmationRequest,
    );
    expect(response).toMatchObject({
      ok: true,
      result: {
        confirmationOpened: true,
        requestedDeleteBranch: false,
        mode: 'archive',
      },
    });
    expect(JSON.stringify(response.result)).toContain(
      'starts on, so the local branch is kept',
    );
    expect(confirmationRequests).toEqual([
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        requestedDeleteBranch: false,
        lockAfterArchive: true,
      },
    ]);
  });

  it('rejects a worktree archive action with an unknown mode', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-worktree-archive-bad-mode',
      source: 'assistant',
      action: {
        type: 'worktree.archive',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        deleteBranch: false,
        mode: 'lock',
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: 'invalid_payload' });
  });

  it('rejects worktree archive confirmation while an agent session is active', async () => {
    const archiveWorktree = jest.fn().mockResolvedValue(undefined);
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
      archiveWorktree,
    });
    useChatStore.setState({
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [makeChatTab({ status: 'streaming' })],
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-worktree-archive-active',
      source: 'assistant',
      action: {
        type: 'worktree.archive',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        deleteBranch: false,
      },
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable', retryable: true },
    });
    expect(response.error?.message).toContain('active agent session');
    expect(archiveWorktree).not.toHaveBeenCalled();
  });

  it('rejects worktree archive confirmation while a plan-explore session is active', async () => {
    const archiveWorktree = jest.fn().mockResolvedValue(undefined);
    const plan: TrackedPlanData = {
      id: 'plan-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      source: 'claude',
      title: 'Explore archive safety',
      content: '# Plan',
      reviewStatus: 'pending',
      createdAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2026-08-06T00:00:00.000Z',
      latestRevisionNumber: 1,
      revisions: [
        {
          revisionNumber: 1,
          content: '# Plan',
          source: 'claude',
          reviewStatus: 'pending',
          createdAt: '2026-08-06T00:00:00.000Z',
        },
      ],
      linkedExecutionIds: [],
    };
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
      archiveWorktree,
    });
    useActivityStore.setState({
      trackedPlans: { 'project-1/worktree-1': [plan] },
    });
    useChatStore.setState({
      worktreeChats: {
        [`${PLAN_EXPLORE_CHAT_PROJECT_ID}/plan-1`]: {
          activeTabId: 'plan-chat-1',
          tabs: [makeChatTab({ id: 'plan-chat-1', status: 'streaming' })],
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-worktree-archive-plan-explore-active',
      source: 'assistant',
      action: {
        type: 'worktree.archive',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        deleteBranch: false,
      },
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable', retryable: true },
    });
    expect(response.error?.message).toContain('active agent session');
    expect(archiveWorktree).not.toHaveBeenCalled();
  });

  it('rejects a worktree archive action without a branch choice', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-worktree-archive-invalid',
      source: 'assistant',
      action: {
        type: 'worktree.archive',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: 'invalid_payload' });
  });

  it('excludes soft-deleted temporary projects from App Advisor project lists', async () => {
    useProjectsStore.setState({
      projects: [
        makeWorkspace(),
        makeMultiRepoWorkspace({
          id: 'temp-empty',
          name: 'Empty Temp',
          temporary: true,
          worktrees: [],
        }),
        makeMultiRepoWorkspace({
          id: 'temp-live',
          name: 'Live Temp',
          temporary: true,
        }),
      ],
      hasHydratedProjects: true,
    });

    const response = await dispatchAppAction({
      requestId: 'req-workspace-list-temporary',
      source: 'assistant',
      action: { type: 'workspace.list' },
    });

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      totalWorkspaces: 2,
      excludedSoftDeletedTemporaryWorkspaces: 1,
    });
    expect(JSON.stringify(response.result)).toContain('temp-live');
    expect(JSON.stringify(response.result)).not.toContain('temp-empty');
  });

  describe('retired temporary combinations', () => {
    const emptyTemporary = (
      id: string,
      overrides: Partial<MultiRepoSidebarItem> = {},
    ): MultiRepoSidebarItem =>
      makeMultiRepoWorkspace({
        id,
        name: `Combination ${id}`,
        temporary: true,
        worktrees: [],
        archivedContainerCount: 0,
        ...overrides,
      });

    async function listedWorkspaceIds(): Promise<string[]> {
      const response = await dispatchAppAction({
        requestId: 'req-workspace-list-retirement',
        source: 'assistant',
        action: { type: 'workspace.list' },
      });
      expect(response.ok).toBe(true);
      return useProjectsStore
        .getState()
        .projects.map((item) => item.id)
        .filter((id) => JSON.stringify(response.result).includes(`"${id}"`));
    }

    async function promote(
      workspaceId: string,
    ): ReturnType<typeof dispatchAppAction> {
      return dispatchAppAction({
        requestId: `req-promote-${workspaceId}`,
        source: 'assistant',
        action: {
          type: 'workspace.promote_temporary',
          workspaceId,
          name: 'Permanent Workspace',
        },
      });
    }

    it.each([
      {
        label: 'an empty combination with explicit Always show',
        workspace: emptyTemporary('temp-kept', { alwaysShow: true }),
      },
      {
        label: 'an empty combination that retains archived containers',
        workspace: emptyTemporary('temp-archived', {
          alwaysShow: false,
          archivedContainerCount: 2,
        }),
      },
    ])(
      'lists and promotes $label, matching the sidebar',
      async ({ workspace }) => {
        useProjectsStore.setState({
          projects: [workspace],
          hasHydratedProjects: true,
        });
        workspaceApiMock.promoteTemporaryWorkspace.mockResolvedValue({
          ...workspace,
          name: 'Permanent Workspace',
          temporary: false,
        });

        expect(await listedWorkspaceIds()).toEqual([workspace.id]);

        const promoted = await promote(workspace.id);

        expect(promoted.ok).toBe(true);
        expect(workspaceApiMock.promoteTemporaryWorkspace).toHaveBeenCalledWith(
          { workspaceId: workspace.id, name: 'Permanent Workspace' },
        );
        expect(JSON.stringify(promoted.result)).toContain('"temporary":false');
      },
    );

    it.each([
      {
        label: 'Always show off',
        workspace: emptyTemporary('temp-disposable', { alwaysShow: false }),
      },
      {
        label: 'Always show absent',
        workspace: emptyTemporary('temp-unset'),
      },
    ])(
      'neither lists nor promotes an empty combination with $label',
      async ({ workspace }) => {
        useProjectsStore.setState({
          projects: [workspace],
          hasHydratedProjects: true,
        });

        expect(await listedWorkspaceIds()).toEqual([]);

        const promoted = await promote(workspace.id);

        expect(promoted.ok).toBe(false);
        expect(promoted.error?.code).toBe('not_found');
        expect(
          workspaceApiMock.promoteTemporaryWorkspace,
        ).not.toHaveBeenCalled();
      },
    );

    it('counts only retired combinations as excluded', async () => {
      useProjectsStore.setState({
        projects: [
          emptyTemporary('temp-kept', { alwaysShow: true }),
          emptyTemporary('temp-archived', { archivedContainerCount: 1 }),
          emptyTemporary('temp-disposable', { alwaysShow: false }),
          emptyTemporary('temp-unset'),
        ],
        hasHydratedProjects: true,
      });

      const response = await dispatchAppAction({
        requestId: 'req-workspace-list-retirement-count',
        source: 'assistant',
        action: { type: 'workspace.list' },
      });

      expect(response.result).toMatchObject({
        totalWorkspaces: 2,
        excludedSoftDeletedTemporaryWorkspaces: 2,
      });
    });
  });

  it('lists valid project join options with allowed modes', async () => {
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
    });
    workspaceApiMock.listAdhocMultiRepoJoinOptions.mockResolvedValue({
      options: [
        {
          id: 'join-workspace',
          name: 'Join Workspace',
          color: '#333333',
          isMultiRepo: false,
          repoCount: 1,
          temporary: false,
        },
      ],
    });

    const response = await dispatchAppAction({
      requestId: 'req-workspace-join-options',
      source: 'assistant',
      action: {
        type: 'workspace.list_join_options',
        sourceWorkspaceId: 'project-1',
        sourceWorktreeId: 'worktree-1',
      },
    });

    expect(response.ok).toBe(true);
    expect(workspaceApiMock.listAdhocMultiRepoJoinOptions).toHaveBeenCalledWith(
      {
        sourceWorkspaceId: 'project-1',
      },
    );
    expect(response.result).toMatchObject({
      allowedModes: ['temporary'],
      totalOptions: 1,
    });
    expect(JSON.stringify(response.result)).toContain('join-workspace');
  });

  it('lists valid existing-worktree join options with allowed modes', async () => {
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
    });
    workspaceApiMock.listExistingWorktreeJoinOptions.mockResolvedValue({
      groups: [
        {
          workspaceId: 'join-workspace',
          workspaceName: 'Join Workspace',
          color: '#333333',
          isMultiRepo: false,
          repoCount: 1,
          temporary: false,
          candidates: [
            {
              workspaceId: 'join-workspace',
              worktreeId: 'join-worktree',
              workspaceName: 'Join Workspace',
              worktreeName: 'join-feature',
              branchName: 'join-feature',
              repoOverlaps: [],
            },
          ],
        },
      ],
    });

    const response = await dispatchAppAction({
      requestId: 'req-existing-worktree-join-options',
      source: 'assistant',
      action: {
        type: 'workspace.list_existing_worktree_join_options',
        sourceWorkspaceId: 'project-1',
        sourceWorktreeId: 'worktree-1',
      },
    });

    expect(response.ok).toBe(true);
    expect(
      workspaceApiMock.listExistingWorktreeJoinOptions,
    ).toHaveBeenCalledWith({
      sourceWorkspaceId: 'project-1',
      sourceWorktreeId: 'worktree-1',
    });
    expect(response.result).toMatchObject({
      allowedModes: ['temporary'],
      totalGroups: 1,
      totalCandidates: 1,
    });
    expect(JSON.stringify(response.result)).toContain('join-worktree');
  });

  it('loads sidebar memberships once for repeated join groups in one workspace', async () => {
    const workspace = makeWorkspace();
    useProjectsStore.setState({
      projects: [workspace],
      hasHydratedProjects: true,
    });
    sidebarItemGroupsApiMock.list.mockResolvedValue([
      {
        id: 'grp-one',
        name: 'Group',
        color: 'neutral',
        collapsed: false,
        memberIds: ['worktree-1'],
      },
    ]);
    const group = {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      color: '#333333',
      isMultiRepo: false,
      repoCount: 1,
      temporary: false,
      candidates: [
        {
          workspaceId: workspace.id,
          worktreeId: 'worktree-1',
          branchName: 'main',
          repoOverlaps: [],
        },
      ],
    };
    workspaceApiMock.listExistingWorktreeJoinOptions.mockResolvedValue({
      groups: [group, group],
    });
    loadPreferencesMock.mockClear();
    const response = await dispatchAppAction({
      requestId: 'req-repeated-join-groups',
      source: 'assistant',
      action: {
        type: 'workspace.list_existing_worktree_join_options',
        sourceWorkspaceId: workspace.id,
        sourceWorktreeId: 'worktree-1',
      },
    });
    expect(response.ok).toBe(true);
    expect(sidebarItemGroupsApiMock.list).toHaveBeenCalledTimes(1);
    expect(loadPreferencesMock).toHaveBeenCalledTimes(1);
    expect(response.result).toMatchObject({
      groups: [
        { candidates: [{ groupId: 'grp-one' }] },
        { candidates: [{ groupId: 'grp-one' }] },
      ],
    });
  });

  it('keeps join candidates when another workspace group sidecar cannot be read', async () => {
    const first = makeWorkspace();
    const second = makeWorkspace({ id: 'project-2', name: 'Two' });
    useProjectsStore.setState({
      projects: [first, second],
      hasHydratedProjects: true,
    });
    sidebarItemGroupsApiMock.list.mockImplementation(
      (scope: { workspaceLocalId: string }) => {
        if (scope.workspaceLocalId === first.id)
          return Promise.reject(new Error('Unsupported sidebar group version'));
        return Promise.resolve([
          {
            id: 'grp-two',
            name: 'Two',
            color: 'neutral',
            collapsed: false,
            memberIds: ['worktree-1'],
          },
        ]);
      },
    );
    workspaceApiMock.listExistingWorktreeJoinOptions.mockResolvedValue({
      groups: [first, second].map((workspace) => ({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        color: workspace.color,
        isMultiRepo: false,
        repoCount: 1,
        temporary: false,
        candidates: [
          {
            workspaceId: workspace.id,
            worktreeId: 'worktree-1',
            branchName: 'feature',
            repoOverlaps: [],
          },
        ],
      })),
    });
    const response = await dispatchAppAction({
      requestId: 'join-sidecar-failure',
      source: 'assistant',
      action: {
        type: 'workspace.list_existing_worktree_join_options',
        sourceWorkspaceId: first.id,
        sourceWorktreeId: 'worktree-1',
      },
    });
    expect(response).toMatchObject({
      ok: true,
      result: {
        groups: [
          { workspaceId: first.id, candidates: [{ worktreeId: 'worktree-1' }] },
          {
            workspaceId: second.id,
            candidates: [{ worktreeId: 'worktree-1', groupId: 'grp-two' }],
          },
        ],
      },
    });
  });

  it('adds a valid project to a worktree and selects the destination', async () => {
    const destinationWorkspace = makeMultiRepoWorkspace({
      id: 'dest-workspace',
      name: 'Destination Workspace',
      temporary: true,
      worktrees: [
        {
          id: 'dest-worktree',
          branchName: 'feature',
          createdAt: new Date(0).toISOString(),
        },
      ],
    });
    useProjectsStore.setState({
      projects: [makeWorkspace(), destinationWorkspace],
      hasHydratedProjects: true,
    });
    workspaceApiMock.listAdhocMultiRepoJoinOptions.mockResolvedValue({
      options: [
        {
          id: 'join-workspace',
          name: 'Join Workspace',
          color: '#333333',
          isMultiRepo: false,
          repoCount: 1,
          temporary: false,
        },
      ],
    });
    workspaceApiMock.combineWorktreeWithWorkspace.mockResolvedValue({
      sourceWorkspaceId: 'project-1',
      sourceWorktreeId: 'worktree-1',
      destinationWorkspaceId: 'dest-workspace',
      destinationWorktreeId: 'dest-worktree',
      destinationWorkspace,
      destinationWorktree: destinationWorkspace.worktrees[0],
      repoMappings: [],
      selectedRepoIdRewrites: {},
      filePathRewrites: [],
      compatibilitySymlinks: [],
      createdTemporaryWorkspace: true,
      reusedWorkspace: false,
      removedSourceWorktree: false,
    });

    const response = await dispatchAppAction({
      requestId: 'req-worktree-add-workspace',
      source: 'assistant',
      action: {
        type: 'worktree.add_workspace',
        sourceWorkspaceId: 'project-1',
        sourceWorktreeId: 'worktree-1',
        joinWorkspaceId: 'join-workspace',
      },
    });

    expect(response.ok).toBe(true);
    expect(workspaceApiMock.combineWorktreeWithWorkspace).toHaveBeenCalledWith({
      sourceWorkspaceId: 'project-1',
      sourceWorktreeId: 'worktree-1',
      joinWorkspaceIds: ['join-workspace'],
      mode: 'temporary',
    });
    expect(useChatStore.getState().selectedWorktree).toEqual({
      projectId: 'dest-workspace',
      worktreeId: 'dest-worktree',
    });
    expect(JSON.stringify(response.result)).toContain('dest-workspace');
  });

  it('joins a valid existing worktree and selects the destination', async () => {
    const sourceWorkspace = makeWorkspace();
    const joinWorkspace = makeWorkspace({
      id: 'join-workspace',
      name: 'Join Workspace',
      worktrees: [
        {
          id: 'join-worktree',
          branchName: 'join-feature',
          createdAt: new Date(0).toISOString(),
        },
      ],
    });
    const destinationWorkspace = makeMultiRepoWorkspace({
      id: 'dest-workspace',
      name: 'Destination Workspace',
      temporary: true,
      worktrees: [
        {
          id: 'dest-worktree',
          branchName: 'feature',
          createdAt: new Date(0).toISOString(),
        },
      ],
    });
    useProjectsStore.setState({
      projects: [sourceWorkspace, joinWorkspace, destinationWorkspace],
      hasHydratedProjects: true,
    });
    workspaceApiMock.listExistingWorktreeJoinOptions.mockResolvedValue({
      groups: [
        {
          workspaceId: 'join-workspace',
          workspaceName: 'Join Workspace',
          color: '#333333',
          isMultiRepo: false,
          repoCount: 1,
          temporary: false,
          candidates: [
            {
              workspaceId: 'join-workspace',
              worktreeId: 'join-worktree',
              workspaceName: 'Join Workspace',
              worktreeName: 'join-feature',
              branchName: 'join-feature',
              repoOverlaps: [],
            },
          ],
        },
      ],
    });
    workspaceApiMock.combineWorktreeWithExistingWorktree.mockResolvedValue({
      sourceWorkspaceId: 'project-1',
      sourceWorktreeId: 'worktree-1',
      destinationWorkspaceId: 'dest-workspace',
      destinationWorktreeId: 'dest-worktree',
      destinationWorkspace,
      destinationWorktree: destinationWorkspace.worktrees[0],
      repoMappings: [],
      selectedRepoIdRewrites: {},
      filePathRewrites: [],
      compatibilitySymlinks: [],
      createdTemporaryWorkspace: true,
      reusedWorkspace: false,
      removedSourceWorktree: false,
      joinedWorktree: {
        workspaceId: 'join-workspace',
        worktreeId: 'join-worktree',
        repoMappings: [],
        selectedRepoIdRewrites: {},
        filePathRewrites: [],
        compatibilitySymlinks: [],
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-worktree-add-existing',
      source: 'assistant',
      action: {
        type: 'worktree.add_existing_worktree',
        sourceWorkspaceId: 'project-1',
        sourceWorktreeId: 'worktree-1',
        joinWorkspaceId: 'join-workspace',
        joinWorktreeId: 'join-worktree',
      },
    });

    expect(response.ok).toBe(true);
    expect(
      workspaceApiMock.combineWorktreeWithExistingWorktree,
    ).toHaveBeenCalledWith({
      sourceWorkspaceId: 'project-1',
      sourceWorktreeId: 'worktree-1',
      joinWorkspaceId: 'join-workspace',
      joinWorktreeId: 'join-worktree',
      mode: 'temporary',
    });
    expect(useChatStore.getState().selectedWorktree).toEqual({
      projectId: 'dest-workspace',
      worktreeId: 'dest-worktree',
    });
    expect(JSON.stringify(response.result)).toContain('join-workspace');
  });

  it('adds multiple projects to a worktree through app actions', async () => {
    const destinationWorkspace = makeMultiRepoWorkspace({
      id: 'dest-workspace',
      name: 'Destination',
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/a',
          source: 'local',
        },
        {
          id: 'repo-b',
          name: 'Repo B',
          repoPath: '/repos/b',
          source: 'local',
        },
        {
          id: 'repo-c',
          name: 'Repo C',
          repoPath: '/repos/c',
          source: 'local',
        },
      ],
    });
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
    });
    workspaceApiMock.listAdhocMultiRepoJoinOptions.mockResolvedValue({
      options: [
        {
          id: 'join-a',
          name: 'Join A',
          color: '#222222',
          isMultiRepo: false,
          repoCount: 1,
          temporary: false,
        },
        {
          id: 'join-b',
          name: 'Join B',
          color: '#333333',
          isMultiRepo: false,
          repoCount: 1,
          temporary: false,
        },
      ],
    });
    workspaceApiMock.combineWorktreeWithWorkspace.mockResolvedValue({
      sourceWorkspaceId: 'project-1',
      sourceWorktreeId: 'worktree-1',
      destinationWorkspaceId: 'dest-workspace',
      destinationWorktreeId: 'dest-worktree',
      destinationWorkspace,
      destinationWorktree: destinationWorkspace.worktrees[0],
      repoMappings: [],
      selectedRepoIdRewrites: {},
      filePathRewrites: [],
      compatibilitySymlinks: [],
      createdTemporaryWorkspace: true,
      reusedWorkspace: false,
      removedSourceWorktree: false,
    });

    const response = await dispatchAppAction({
      requestId: 'req-worktree-add-workspaces',
      source: 'assistant',
      action: {
        type: 'worktree.add_workspace',
        sourceWorkspaceId: 'project-1',
        sourceWorktreeId: 'worktree-1',
        joinWorkspaceIds: ['join-a', 'join-b'],
      },
    });

    expect(response.ok).toBe(true);
    expect(workspaceApiMock.combineWorktreeWithWorkspace).toHaveBeenCalledWith({
      sourceWorkspaceId: 'project-1',
      sourceWorktreeId: 'worktree-1',
      joinWorkspaceIds: ['join-a', 'join-b'],
      mode: 'temporary',
    });
  });

  it('rejects invalid project add modes and join targets', async () => {
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
    });
    workspaceApiMock.listAdhocMultiRepoJoinOptions.mockResolvedValue({
      options: [],
    });

    const invalidMode = await dispatchAppAction({
      requestId: 'req-worktree-add-invalid-mode',
      source: 'assistant',
      action: {
        type: 'worktree.add_workspace',
        sourceWorkspaceId: 'project-1',
        sourceWorktreeId: 'worktree-1',
        joinWorkspaceId: 'join-workspace',
        mode: 'update-source-workspace',
      },
    });
    const invalidTarget = await dispatchAppAction({
      requestId: 'req-worktree-add-invalid-target',
      source: 'assistant',
      action: {
        type: 'worktree.add_workspace',
        sourceWorkspaceId: 'project-1',
        sourceWorktreeId: 'worktree-1',
        joinWorkspaceId: 'missing-workspace',
      },
    });

    expect(invalidMode.ok).toBe(false);
    expect(invalidMode.error?.code).toBe('invalid_target');
    expect(invalidTarget.ok).toBe(false);
    expect(invalidTarget.error?.code).toBe('invalid_target');
    expect(
      workspaceApiMock.combineWorktreeWithWorkspace,
    ).not.toHaveBeenCalled();
  });

  it('rejects malformed project add join ids before dispatching', async () => {
    const response = await dispatchAppAction({
      requestId: 'req-worktree-add-malformed-join-id',
      source: 'assistant',
      action: {
        type: 'worktree.add_workspace',
        sourceWorkspaceId: 'project-1',
        sourceWorktreeId: 'worktree-1',
        joinWorkspaceId: 42,
        joinWorkspaceIds: ['join-a'],
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('invalid_payload');
    expect(response.error?.message).toContain('invalid joinWorkspaceId');
    expect(
      workspaceApiMock.listAdhocMultiRepoJoinOptions,
    ).not.toHaveBeenCalled();
    expect(
      workspaceApiMock.combineWorktreeWithWorkspace,
    ).not.toHaveBeenCalled();
  });

  it('validates and dispatches worktree.split_temporary_workspace', async () => {
    const splitTemporaryWorkspaceWorktree = jest.fn().mockResolvedValue({
      success: true,
      results: [],
      warnings: [],
      navigationTarget: { kind: 'home' },
    });
    useProjectsStore.setState({
      projects: [
        makeMultiRepoWorkspace({
          id: 'temporary-workspace',
          temporary: true,
          worktrees: [
            {
              id: 'temporary-worktree',
              branchName: 'feature',
              createdAt: new Date(0).toISOString(),
            },
          ],
        }),
      ],
      hasHydratedProjects: true,
      splitTemporaryWorkspaceWorktree,
    });
    workspaceApiMock.previewSplitTemporaryWorkspace.mockResolvedValue({
      previewRevision: 'safe-preview-revision',
      repos: [
        {
          repoId: 'repo-b',
          repoName: 'Repo B',
          repoPath: '/repo-b',
          destinationWorkspaceName: 'Repo B',
          removalMode: 'archive',
          chats: { count: 0, entries: [] },
          pipelines: { count: 0, entries: [] },
          plans: { count: 0, entries: [] },
        },
      ],
      root: {
        present: false,
        canArchive: true,
        chats: { count: 0, entries: [] },
        pipelines: { count: 0, entries: [] },
        plans: { count: 0, entries: [] },
        attachments: { count: 0, entries: [] },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-worktree-split',
      source: 'assistant',
      action: {
        type: 'worktree.split_temporary_workspace',
        workspaceId: 'temporary-workspace',
        worktreeId: 'temporary-worktree',
        selections: { 'repo-a': 'split', 'repo-b': 'remove' },
        rootAction: 'archive',
      },
    });

    expect(response.ok).toBe(true);
    expect(splitTemporaryWorkspaceWorktree).toHaveBeenCalledWith(
      'temporary-workspace',
      'temporary-worktree',
      { 'repo-a': 'split', 'repo-b': 'remove' },
      'archive',
    );
  });

  it('requires confirmation when a removed repo resolves to hard deletion', async () => {
    const splitTemporaryWorkspaceWorktree = jest.fn().mockResolvedValue({
      success: true,
      results: [],
      warnings: [],
      navigationTarget: { kind: 'home' },
    });
    useProjectsStore.setState({
      projects: [
        makeMultiRepoWorkspace({
          id: 'temporary-workspace',
          temporary: true,
        }),
      ],
      hasHydratedProjects: true,
      splitTemporaryWorkspaceWorktree,
    });
    workspaceApiMock.previewSplitTemporaryWorkspace.mockResolvedValue({
      previewRevision: 'destructive-preview-revision',
      repos: [
        {
          repoId: 'repo-b',
          repoName: 'Repo B',
          removalMode: 'delete',
        },
      ],
      root: { present: false, canArchive: true },
    });

    const response = await dispatchAppAction({
      requestId: 'req-worktree-split-hard-delete',
      source: 'assistant',
      action: {
        type: 'worktree.split_temporary_workspace',
        workspaceId: 'temporary-workspace',
        worktreeId: 'temporary-worktree',
        selections: { 'repo-b': 'remove' },
        rootAction: 'archive',
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('invalid_payload');
    expect(response.error?.message).toBe(
      'Permanent deletion must be confirmed in the Split project dialog. Review the current preview and confirm the operation there.',
    );
    expect(
      workspaceApiMock.previewSplitTemporaryWorkspace,
    ).toHaveBeenCalledWith({
      workspaceId: 'temporary-workspace',
      worktreeId: 'temporary-worktree',
    });
    expect(splitTemporaryWorkspaceWorktree).not.toHaveBeenCalled();

    expect(response.error?.message).not.toContain('repo-b');
    expect(splitTemporaryWorkspaceWorktree).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'selection',
      action: {
        type: 'worktree.split_temporary_workspace',
        workspaceId: 'temporary-workspace',
        worktreeId: 'temporary-worktree',
        selections: { 'repo-a': 'keep' },
        rootAction: 'archive',
      },
      message: 'invalid selections',
    },
    {
      label: 'missing root action',
      action: {
        type: 'worktree.split_temporary_workspace',
        workspaceId: 'temporary-workspace',
        worktreeId: 'temporary-worktree',
      },
      message: 'invalid rootAction',
    },
    {
      label: 'root action',
      action: {
        type: 'worktree.split_temporary_workspace',
        workspaceId: 'temporary-workspace',
        worktreeId: 'temporary-worktree',
        rootAction: 'keep',
      },
      message: 'invalid rootAction',
    },
  ])(
    'rejects an invalid split $label before dispatching',
    async ({ action, message }) => {
      const splitTemporaryWorkspaceWorktree = jest.fn();
      useProjectsStore.setState({ splitTemporaryWorkspaceWorktree });

      const response = await dispatchAppAction({
        requestId: 'req-worktree-split-invalid',
        source: 'assistant',
        action,
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('invalid_payload');
      expect(response.error?.message).toContain(message);
      expect(splitTemporaryWorkspaceWorktree).not.toHaveBeenCalled();
    },
  );

  it('reads and updates project local settings', async () => {
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
    });

    const read = await dispatchAppAction({
      requestId: 'req-settings-read',
      source: 'assistant',
      action: {
        type: 'workspace.get_settings',
        workspaceId: 'project-1',
        includeClaudeMd: true,
      },
    });
    const update = await dispatchAppAction({
      requestId: 'req-settings-update',
      source: 'assistant',
      action: {
        type: 'workspace.update_local_settings',
        workspaceId: 'project-1',
        scripts: { setup: 'npm install' },
        archiveRetentionDays: 21,
        autoArchiveDays: 7,
        autoArchiveDeleteBranch: true,
      },
    });

    expect(read.ok).toBe(true);
    expect(workspaceApiMock.getWorkspaceSettingsData).toHaveBeenCalledWith({
      workspaceId: 'project-1',
    });
    expect(workspaceApiMock.loadClaudeMd).toHaveBeenCalledWith({
      workspaceId: 'project-1',
    });
    expect(update.ok).toBe(true);
    expect(workspaceApiMock.saveProjectScripts).toHaveBeenCalledWith({
      projectId: 'project-1',
      scripts: { setup: 'npm install' },
    });
    expect(workspaceApiMock.setWorkspaceArchiveRetention).toHaveBeenCalledWith({
      workspaceId: 'project-1',
      archiveRetentionDays: 21,
      autoArchiveDays: 7,
      autoArchiveDeleteBranch: true,
    });
  });

  it('preserves effective code-workspace retention when only Auto Delete changes', async () => {
    useProjectsStore.setState({
      projects: [makeWorkspace({ archiveRetentionDays: undefined })],
      hasHydratedProjects: true,
    });

    const response = await dispatchAppAction({
      requestId: 'req-settings-auto-archive-only',
      source: 'assistant',
      action: {
        type: 'workspace.update_local_settings',
        workspaceId: 'project-1',
        autoArchiveDays: 7,
      },
    });

    expect(response.ok).toBe(true);
    expect(workspaceApiMock.setWorkspaceArchiveRetention).toHaveBeenCalledWith(
      expect.objectContaining({ archiveRetentionDays: 7 }),
    );
  });

  it.each([
    {
      type: 'workspace.update_local_settings',
      workspaceId: 'project-1',
      autoArchiveDays: 0,
    },
    {
      type: 'standalone-chat.update_settings',
      projectId: 'cowork-1',
      autoArchiveDays: 0,
    },
    { type: 'app_advisor.update_settings', autoArchiveDays: 0 },
  ])('rejects zero Auto Delete days for $type', (action) => {
    expect(__isValidAppAdvisorActionForTests(action)).toBe(false);
  });

  it('reads bounded readiness metadata without exposing generated prompts', async () => {
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
    });
    workspaceApiMock.getWorkspaceReadiness.mockResolvedValueOnce({
      issues: [
        {
          code: 'configure-hooks',
          title: 'Add repository hooks',
          message: 'No effective hooks.',
          repoName: 'Project One',
          fixPrompt: 'SECRET GENERATED PROMPT',
        },
      ],
    });

    const response = await dispatchAppAction({
      requestId: 'req-readiness-read',
      source: 'assistant',
      action: {
        type: 'workspace.read_readiness',
        workspaceId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });

    expect(response.ok).toBe(true);
    expect(workspaceApiMock.getWorkspaceReadiness).toHaveBeenCalledWith({
      workspaceId: 'project-1',
      worktreeId: 'worktree-1',
    });
    expect(JSON.stringify(response.result)).not.toContain(
      'SECRET GENERATED PROMPT',
    );
  });

  it('re-reads and launches the canonical readiness issue', async () => {
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
    });
    const canonicalIssue = {
      code: 'configure-hooks' as const,
      title: 'Add repository hooks',
      message: 'No effective hooks.',
      repoName: 'Project One',
      fixPrompt: 'Canonical prompt',
    };
    workspaceApiMock.getWorkspaceReadiness.mockResolvedValueOnce({
      issues: [canonicalIssue],
    });

    const response = await dispatchAppAction({
      requestId: 'req-readiness-fix',
      source: 'assistant',
      action: {
        type: 'workspace.start_readiness_fix',
        workspaceId: 'project-1',
        worktreeId: 'worktree-1',
        issueCode: 'configure-hooks',
      },
    });

    expect(response.ok).toBe(true);
    expect(launchWorkspaceReadinessFixMock).toHaveBeenCalledWith(
      'project-1',
      canonicalIssue,
      'worktree-1',
    );
  });

  it('promotes temporary projects and blocks source-controlled edits before promotion', async () => {
    const temporaryWorkspace = makeMultiRepoWorkspace({
      id: 'temp-workspace',
      name: 'Repo A & Repo B',
      temporary: true,
    });
    const promotedWorkspace = makeMultiRepoWorkspace({
      id: 'temp-workspace',
      name: 'Permanent Workspace',
      temporary: false,
    });
    useProjectsStore.setState({
      projects: [temporaryWorkspace],
      hasHydratedProjects: true,
    });
    workspaceApiMock.promoteTemporaryWorkspace.mockResolvedValue(
      promotedWorkspace,
    );

    const blockedSourceEdit = await dispatchAppAction({
      requestId: 'req-temp-source-edit',
      source: 'assistant',
      action: {
        type: 'workspace.apply_source_edits',
        workspaceId: 'temp-workspace',
        worktreeId: 'worktree-1',
        scripts: { setup: 'npm install' },
      },
    });
    const promoted = await dispatchAppAction({
      requestId: 'req-temp-promote',
      source: 'assistant',
      action: {
        type: 'workspace.promote_temporary',
        workspaceId: 'temp-workspace',
        name: 'Permanent Workspace',
      },
    });

    expect(blockedSourceEdit.ok).toBe(false);
    expect(blockedSourceEdit.error?.code).toBe('invalid_target');
    expect(workspaceApiMock.applyWorkspaceSourceChanges).not.toHaveBeenCalled();
    expect(promoted.ok).toBe(true);
    expect(workspaceApiMock.promoteTemporaryWorkspace).toHaveBeenCalledWith({
      workspaceId: 'temp-workspace',
      name: 'Permanent Workspace',
    });
    expect(JSON.stringify(promoted.result)).toContain('"temporary":false');
  });

  describe('org_project.open_move_to_organization', () => {
    function enableOrgProjects(): void {
      useFeatureFlagsStore.setState({
        snapshot: {
          ...getDefaultFeatureFlagSnapshot(),
          values: {
            ...getDefaultFeatureFlagSnapshot().values,
            [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
          },
          status: 'ready',
          initialized: true,
        },
      });
    }

    afterEach(() => {
      useMoveToOrganizationModalStore.setState({
        target: null,
        busy: false,
        error: null,
      });
    });

    it('opens the dialog for a Personal project and never moves it', async () => {
      enableOrgProjects();
      useWorkspaceContextStore.setState({
        state: {
          context: { kind: 'personal' },
          revision: 1,
          organizations: [{ id: 'org-acme', name: 'Acme', role: 'MEMBER' }],
        },
      });
      useProjectsStore.setState({
        projects: [makeWorkspace()],
        hasHydratedProjects: true,
      });

      const response = await dispatchAppAction({
        requestId: 'req-open-move-to-organization',
        source: 'assistant',
        action: {
          type: 'org_project.open_move_to_organization',
          workspaceId: 'project-1',
        },
      });

      expect(response).toMatchObject({
        ok: true,
        result: { workspaceId: 'project-1' },
      });
      expect(useMoveToOrganizationModalStore.getState().target).toEqual({
        workspaceId: 'project-1',
      });
    });

    it('reports surface_unavailable when the project cannot move', async () => {
      enableOrgProjects();
      useWorkspaceContextStore.setState({
        state: {
          context: { kind: 'personal' },
          revision: 1,
          organizations: [],
        },
      });
      useProjectsStore.setState({
        projects: [makeWorkspace()],
        hasHydratedProjects: true,
      });

      const response = await dispatchAppAction({
        requestId: 'req-open-move-to-organization-unavailable',
        source: 'assistant',
        action: {
          type: 'org_project.open_move_to_organization',
          workspaceId: 'project-1',
        },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('surface_unavailable');
      expect(useMoveToOrganizationModalStore.getState().target).toBeNull();
    });

    it('rejects a request without a workspace id', async () => {
      const response = await dispatchAppAction({
        requestId: 'req-open-move-to-organization-invalid',
        source: 'assistant',
        action: { type: 'org_project.open_move_to_organization' },
      });
      expect(response.ok).toBe(false);
    });
  });

  it('opens session import for an explicit git-backed project', async () => {
    loadCanopyCloudAccountMock.mockResolvedValueOnce({
      hasApiKey: true,
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      capabilities: ['session-exports-v1'],
      account: { id: 'account-1', email: 'user@example.test' },
      storageAvailable: true,
    });
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
    });

    const response = await dispatchAppAction({
      requestId: 'req-chat-open-import-session',
      source: 'assistant',
      action: {
        type: 'chat.open_import_session_modal',
        workspaceId: 'project-1',
      },
    });

    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      workspaceId: 'project-1',
      modalRequested: true,
    });
    expect(useImportSessionModalStore.getState().target).toEqual({
      workspaceId: 'project-1',
    });
  });

  it.each([
    {
      label: 'signed out',
      account: {
        hasApiKey: false,
        authMode: null,
        credentialSource: null,
        capabilities: [],
        storageAvailable: true,
      },
    },
    {
      label: 'using a guest account',
      account: {
        hasApiKey: true,
        authMode: 'api-key',
        credentialSource: 'guest',
        capabilities: ['session-exports-v1'],
        account: { id: 'guest-1' },
        storageAvailable: true,
      },
    },
  ])('rejects session import when $label', async ({ account }) => {
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
    });
    loadCanopyCloudAccountMock.mockResolvedValueOnce(account);
    const openImportSessionModalSpy = jest.spyOn(
      useImportSessionModalStore.getState(),
      'open',
    );

    const response = await dispatchAppAction({
      requestId: 'req-chat-open-import-session-unauthenticated',
      source: 'assistant',
      action: {
        type: 'chat.open_import_session_modal',
        workspaceId: 'project-1',
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error).toEqual({
      code: 'surface_unavailable',
      message:
        'Sign in to a non-guest Canopy Cloud account before importing a session.',
    });
    expect(openImportSessionModalSpy).not.toHaveBeenCalled();
    expect(useImportSessionModalStore.getState().target).toBeNull();
    openImportSessionModalSpy.mockRestore();
  });

  it('opens session import for Cowork and rejects when no project is selected', async () => {
    const coworkWorkspace: SidebarItem = {
      type: 'cowork',
      id: 'cowork-1',
      name: 'Cowork One',
      color: '#333333',
      collapsed: false,
      order: 0,
    };
    useProjectsStore.setState({
      projects: [coworkWorkspace],
      hasHydratedProjects: true,
    });
    loadCanopyCloudAccountMock.mockResolvedValueOnce({
      hasApiKey: true,
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      capabilities: ['session-exports-v1'],
      account: { id: 'account-1', email: 'user@example.test' },
      storageAvailable: true,
    });

    const coworkResponse = await dispatchAppAction({
      requestId: 'req-chat-open-import-session-cowork',
      source: 'assistant',
      action: {
        type: 'chat.open_import_session_modal',
        workspaceId: 'cowork-1',
      },
    });
    const noSelectionResponse = await dispatchAppAction({
      requestId: 'req-chat-open-import-session-no-selection',
      source: 'assistant',
      action: { type: 'chat.open_import_session_modal' },
    });

    expect(coworkResponse.ok).toBe(true);
    expect(coworkResponse.result).toEqual({
      workspaceId: 'cowork-1',
      modalRequested: true,
    });
    expect(noSelectionResponse.ok).toBe(false);
    expect(noSelectionResponse.error).toEqual({
      code: 'surface_unavailable',
      message: 'Select a project before opening session import.',
    });
    expect(useImportSessionModalStore.getState().target).toEqual({
      workspaceId: 'cowork-1',
    });
  });

  it('refuses an unavailable or stale composer harness selector', async () => {
    const response = await dispatchAppAction({
      requestId: 'stale-harness',
      source: 'assistant',
      action: {
        type: 'chat.set_harness',
        pickerId: 'unmounted-composer',
        harness: 'cursor',
      },
    });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('surface_unavailable');
  });

  it('selects a Home harness only for an eligible fresh Code draft', async () => {
    initOllamaModels([
      {
        id: 'ollama-advisor-harness',
        rawModelId: 'advisor-harness',
        label: 'Advisor harness',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
    useNavigationStore.setState({ activePage: 'home' });
    useHomeComposerStore.setState({
      workspaceId: 'project-1',
      mode: 'chat',
      scheduledSendDraft: null,
      model: 'ollama-advisor-harness',
      executionHarness: undefined,
    });
    const request = {
      requestId: 'home-harness',
      source: 'assistant' as const,
      action: {
        type: 'home.set_execution_harness' as const,
        executionHarness: 'claude' as const,
      },
    };
    expect((await dispatchAppAction(request)).ok).toBe(true);
    expect(useHomeComposerStore.getState().executionHarness).toBe('claude');
    useNavigationStore.setState({ activePage: 'main' });
    expect(
      (
        await dispatchAppAction({
          ...request,
          requestId: 'hidden-home-harness',
        })
      ).ok,
    ).toBe(false);
    useHomeComposerStore.getState().reset();
  });

  it('rejects Cursor model selection from the worktree action surface', async () => {
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [makeChatTab()],
        },
      },
    });
    const result = await dispatchAppAction({
      requestId: 'cursor-worktree-model',
      source: 'assistant',
      action: { type: 'worktree-chat.set_model', model: 'cursor-default' },
    });
    expect(result.ok).toBe(false);
    expect(chatApiMock.changeModel).not.toHaveBeenCalled();
  });

  it('reports a refused per-chat harness change to App Advisor', async () => {
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [makeChatTab()],
        },
      },
    });
    chatApiMock.changeModel.mockResolvedValueOnce(false);
    const result = await dispatchAppAction({
      requestId: 'refused-harness',
      source: 'assistant',
      action: {
        type: 'worktree-chat.set_model',
        model: 'gpt-5.6-luna',
        executionHarness: 'claude',
      },
    });
    expect(result.ok).toBe(false);
  });

  it('changes chat planning, model, thinking, and plugin selections', async () => {
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [makeChatTab()],
        },
      },
    });

    const plan = await dispatchAppAction({
      requestId: 'req-chat-plan',
      source: 'assistant',
      action: { type: 'worktree-chat.set_plan_mode', enabled: true },
    });
    const model = await dispatchAppAction({
      requestId: 'req-chat-model',
      source: 'assistant',
      action: { type: 'worktree-chat.set_model', model: 'gpt-5.6-luna' },
    });
    const thinking = await dispatchAppAction({
      requestId: 'req-chat-thinking',
      source: 'assistant',
      action: { type: 'worktree-chat.set_thinking_level', level: 'xhigh' },
    });
    const plugin = await dispatchAppAction({
      requestId: 'req-chat-plugin',
      source: 'assistant',
      action: {
        type: 'worktree-chat.update_plugin_selection',
        kind: 'skill',
        key: 'builtin/app/example',
        enabled: true,
      },
    });

    expect(plan.ok).toBe(true);
    expect(chatApiMock.togglePlanMode).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      enabled: true,
    });
    expect(model.ok).toBe(true);
    expect(chatApiMock.changeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        model: 'gpt-5.6-luna',
      }),
    );
    expect(thinking.ok).toBe(true);
    expect(chatApiMock.toggleThinkingLevel).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      level: 'xhigh',
    });
    expect(plugin.ok).toBe(true);
    expect(chatApiMock.updatePlugins).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      pluginSelections: {
        collectionIds: [],
        skillRefs: [{ sourceId: 'builtin:app', skillName: 'example' }],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    });
  });

  describe('Codex speed actions', () => {
    const TARGET = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    };
    const selectCodexTab = (overrides: Partial<ChatTab> = {}): void => {
      useChatStore.setState({
        selectedWorktree: {
          projectId: TARGET.projectId,
          worktreeId: TARGET.worktreeId,
        },
        worktreeChats: {
          'project-1/worktree-1': {
            activeTabId: 'chat-1',
            tabs: [
              makeChatTab({
                providerType: 'codex',
                model: 'gpt-6-astra',
                modelConfig: {
                  thinkingLevel: 'high',
                  speed: 'ultrafast',
                  fastMode: false,
                },
                fastModeExplicit: true,
                ...overrides,
              }),
            ],
          },
        },
      });
    };

    it('validates exact speeds and keeps the legacy boolean payload', () => {
      for (const speed of ['standard', 'fast', 'ultrafast']) {
        expect(
          __isValidAppAdvisorActionForTests({
            type: 'worktree-chat.set_speed',
            speed,
          }),
        ).toBe(true);
      }
      for (const speed of ['turbo', true, undefined]) {
        expect(
          __isValidAppAdvisorActionForTests({
            type: 'worktree-chat.set_speed',
            speed,
          }),
        ).toBe(false);
      }
      expect(
        __isValidAppAdvisorActionForTests({
          type: 'worktree-chat.set_fast_mode',
          enabled: false,
        }),
      ).toBe(true);
    });

    it.each([
      ['standard', 'ultrafast'],
      ['fast', 'ultrafast'],
      ['ultrafast', 'fast'],
    ] as const)(
      'sets the exact %s speed from %s through the canonical setter',
      async (speed, from) => {
        selectCodexTab({
          modelConfig: {
            thinkingLevel: 'high',
            speed: from,
            fastMode: from === 'fast',
          },
        });

        const response = await dispatchAppAction({
          requestId: `set-speed-${speed}`,
          source: 'assistant',
          action: { type: 'worktree-chat.set_speed', ...TARGET, speed },
        });

        expect(response.ok).toBe(true);
        expect(chatApiMock.toggleCodexFastMode).toHaveBeenCalledWith({
          ...TARGET,
          enabled: speed === 'fast',
          speed,
        });
        expect(response.result).toMatchObject({
          speed,
          modelConfig: { speed, fastMode: speed === 'fast' },
        });
      },
    );

    it('lets the legacy fast-mode switch replace Ultra fast exactly', async () => {
      selectCodexTab();
      const regular = await dispatchAppAction({
        requestId: 'legacy-regular',
        source: 'assistant',
        action: {
          type: 'worktree-chat.set_fast_mode',
          ...TARGET,
          enabled: false,
        },
      });

      expect(regular.ok).toBe(true);
      expect(chatApiMock.toggleCodexFastMode).toHaveBeenLastCalledWith({
        ...TARGET,
        enabled: false,
        speed: 'standard',
      });
      expect(regular.result).toMatchObject({
        speed: 'standard',
        modelConfig: { speed: 'standard', fastMode: false },
      });

      selectCodexTab();
      const fast = await dispatchAppAction({
        requestId: 'legacy-fast',
        source: 'assistant',
        action: {
          type: 'worktree-chat.set_fast_mode',
          ...TARGET,
          enabled: true,
        },
      });

      expect(fast.ok).toBe(true);
      expect(fast.result).toMatchObject({
        speed: 'fast',
        modelConfig: { speed: 'fast', fastMode: true },
      });
    });

    it('refuses Ultra fast on an Auto chat before changing the speed', async () => {
      selectCodexTab({
        modelSelectionMode: 'auto',
        modelConfig: { thinkingLevel: 'high', speed: 'fast', fastMode: true },
      });

      const response = await dispatchAppAction({
        requestId: 'auto-ultra',
        source: 'assistant',
        action: {
          type: 'worktree-chat.set_speed',
          ...TARGET,
          speed: 'ultrafast',
        },
      });

      expect(response.ok).toBe(false);
      expect(response.error).toEqual({
        code: 'invalid_target',
        message:
          'Ultra fast needs a specific model. Choose a model that offers Ultra fast, or choose Regular or Fast.',
      });
      expect(chatApiMock.toggleCodexFastMode).not.toHaveBeenCalled();
    });

    it('refuses a speed on a chat that does not run Codex', async () => {
      selectCodexTab({ providerType: 'claude', model: 'opus[1m]' });

      const response = await dispatchAppAction({
        requestId: 'claude-speed',
        source: 'assistant',
        action: { type: 'worktree-chat.set_speed', ...TARGET, speed: 'fast' },
      });
      const thinking = await dispatchAppAction({
        requestId: 'claude-thinking',
        source: 'assistant',
        action: {
          type: 'worktree-chat.set_thinking_level',
          ...TARGET,
          level: 'xhigh',
        },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('invalid_target');
      expect(chatApiMock.toggleCodexFastMode).not.toHaveBeenCalled();
      // A non-Codex chat reports no speed at all.
      expect(thinking.ok).toBe(true);
      expect(thinking.result).not.toHaveProperty('speed');
    });

    it('reports the requested speed on unrelated chat settings results', async () => {
      selectCodexTab();

      const thinking = await dispatchAppAction({
        requestId: 'thinking-keeps-ultra',
        source: 'assistant',
        action: {
          type: 'worktree-chat.set_thinking_level',
          ...TARGET,
          level: 'xhigh',
        },
      });

      expect(thinking.ok).toBe(true);
      expect(thinking.result).toMatchObject({ speed: 'ultrafast' });
      expect(chatApiMock.toggleCodexFastMode).not.toHaveBeenCalled();
    });
  });

  it('retries and dismisses visible chat-state recovery controls', async () => {
    const retryChatStateRefresh = jest.fn();
    const dismissChatStateNotice = jest.fn();
    useChatStore.setState({
      chatStateSync: {
        'project-1/worktree-1': { phase: 'refresh_error', revision: null },
      },
      chatStateNotices: {
        'project-1/worktree-1': {
          kind: 'conflict',
          message: 'Chat changed in another window',
        },
      },
      retryChatStateRefresh,
      dismissChatStateNotice,
    });

    const retry = await dispatchAppAction({
      requestId: 'req-chat-state-retry',
      source: 'assistant',
      action: {
        type: 'worktree-chat.retry_state_refresh',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });
    const dismiss = await dispatchAppAction({
      requestId: 'req-chat-state-dismiss',
      source: 'assistant',
      action: {
        type: 'worktree-chat.dismiss_state_notice',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });

    expect(retry.ok).toBe(true);
    expect(retryChatStateRefresh).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
    );
    expect(dismiss.ok).toBe(true);
    expect(dismissChatStateNotice).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
    );
  });

  it('rejects interface switch to Canopy while live Claude terminal is running', async () => {
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [
            makeChatTab({
              providerType: 'claude',
              interfaceMode: 'claude-code',
              claudeTerminal: { turnState: 'idle' },
            }),
          ],
        },
      },
    });
    useClaudeTerminalStore.setState({
      byChat: {
        'project-1/worktree-1/chat-1': {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          turnState: 'running',
          launchStatus: 'ready',
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-chat-interface-live-running',
      source: 'assistant',
      action: { type: 'worktree-chat.set_interface_mode', mode: 'canopy' },
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({
      code: 'surface_unavailable',
      message: 'Canopy is available when the Claude Code turn is idle.',
      retryable: true,
    });
    expect(
      useChatStore.getState().worktreeChats['project-1/worktree-1']?.tabs[0]
        ?.interfaceMode,
    ).toBe('claude-code');
  });

  it('uses model-aware Claude detection for interface mode actions', async () => {
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [
            makeChatTab({
              model: 'ollama-llama3:8b',
              providerType: undefined,
              interfaceMode: 'canopy',
            }),
          ],
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-chat-interface-ollama',
      source: 'assistant',
      action: { type: 'worktree-chat.set_interface_mode', mode: 'claude-code' },
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({
      code: 'surface_unavailable',
      message:
        'Chat-interface mode toggle is only available on Claude-backed chats.',
    });
  });

  it('rejects App Advisor interface switches into terminal modes when Claude TUI chats are disabled', async () => {
    setFeatureFlagForTest(
      CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiChats.key,
      false,
    );
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [
            makeChatTab({
              providerType: 'claude',
              interfaceMode: 'canopy',
            }),
          ],
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-chat-interface-flag-disabled',
      source: 'assistant',
      action: { type: 'worktree-chat.set_interface_mode', mode: 'claude-code' },
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({
      code: 'surface_unavailable',
      message: 'Claude terminal chat mode is not available.',
    });
    expect(
      useChatStore.getState().worktreeChats['project-1/worktree-1']?.tabs[0]
        ?.interfaceMode,
    ).toBe('canopy');
  });

  it.each(['starting', 'cleaning_up'] as const)(
    'rejects interface switch to Canopy while Claude terminal is %s',
    async (turnState) => {
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
        worktreeChats: {
          'project-1/worktree-1': {
            activeTabId: 'chat-1',
            tabs: [
              makeChatTab({
                providerType: 'claude',
                interfaceMode: 'claude-code',
              }),
            ],
          },
        },
      });
      useClaudeTerminalStore.setState({
        byChat: {
          'project-1/worktree-1/chat-1': {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            chatId: 'chat-1',
            turnState,
            launchStatus: 'ready',
          },
        },
      });

      const response = await dispatchAppAction({
        requestId: `req-chat-interface-${turnState}`,
        source: 'assistant',
        action: { type: 'worktree-chat.set_interface_mode', mode: 'canopy' },
      });

      expect(response.ok).toBe(false);
      expect(response.error).toMatchObject({
        code: 'surface_unavailable',
        message: 'Canopy is available when the Claude Code turn is idle.',
        retryable: true,
      });
    },
  );

  it('rejects interface switch to Claude Code while terminal cleanup is pending', async () => {
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [
            makeChatTab({
              providerType: 'claude',
              interfaceMode: 'canopy',
              claudeTerminal: { turnState: 'cleaning_up' },
            }),
          ],
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-chat-interface-cleanup-to-terminal',
      source: 'assistant',
      action: { type: 'worktree-chat.set_interface_mode', mode: 'claude-code' },
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({
      code: 'surface_unavailable',
      message: 'Claude Code is available when its terminal is idle.',
      retryable: true,
    });
  });

  it('lists available chat plugins with selected state', async () => {
    (window.skills.loadSkills as jest.Mock).mockResolvedValue({
      success: true,
      data: [
        {
          name: 'example',
          sourceId: 'builtin/app',
          description: 'Example skill',
          source: 'builtin',
          installedAt: '',
          updatedAt: '',
          updateAvailable: false,
          builtIn: true,
        },
      ],
    });
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [
            makeChatTab({
              pluginSelections: {
                collectionIds: [],
                skillRefs: [{ sourceId: 'builtin/app', skillName: 'example' }],
                pluginRefs: [],
                mcpServerRefs: [],
              },
            }),
          ],
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-chat-list-plugins',
      source: 'assistant',
      action: { type: 'worktree-chat.list_plugins', query: 'example' },
    });

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      totalMatches: 1,
      returned: 1,
    });
    expect(JSON.stringify(response.result)).toContain('"selected":true');
  });

  it('lists marketplace chat plugin provider support for App Advisor', async () => {
    (window.plugins.loadMarketplaces as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-05-01T00:00:00.000Z',
        marketplaces: [
          {
            id: 'acme/plugins',
            name: 'Acme Plugins',
            plugins: [
              {
                name: 'reviewer',
                description: 'Reviews code',
                marketplaceId: 'acme/plugins',
                providerSupport: { claude: 'native', codex: 'compat' },
              },
            ],
          },
        ],
      },
    });
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [
            makeChatTab({
              pluginSelections: {
                collectionIds: [],
                bundleIds: [],
                skillRefs: [],
                pluginRefs: [
                  { marketplaceId: 'acme/plugins', pluginName: 'reviewer' },
                ],
                mcpServerRefs: [],
              },
            }),
          ],
        },
      },
    });

    const response = await dispatchAppAction({
      requestId: 'req-chat-list-marketplace-plugins',
      source: 'assistant',
      action: { type: 'worktree-chat.list_plugins', query: 'reviewer' },
    });

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      totalMatches: 1,
      returned: 1,
      rows: [
        {
          kind: 'plugin',
          key: 'acme/plugins/reviewer',
          providers: { claude: 'native', codex: 'compat' },
          selected: true,
        },
      ],
    });
  });

  it('rejects Cursor Pipeline Assistant model selection without changing the tab', async () => {
    useChatStore.setState({
      worktreeChats: {
        [`${PIPELINE_EDITOR_PROJECT_ID}/${PIPELINE_EDITOR_WORKTREE_ID}`]: {
          activeTabId: 'pipeline-chat-1',
          tabs: [
            makeChatTab({
              id: 'pipeline-chat-1',
              model: 'gpt-5.6-luna',
              providerType: 'codex',
            }),
          ],
        },
      },
    });
    const result = await dispatchAppAction({
      requestId: 'cursor-pipeline-model',
      source: 'assistant',
      action: {
        type: 'pipeline-assistant-chat.set_model',
        chatId: 'pipeline-chat-1',
        model: 'cursor-default',
      },
    });
    expect(result.ok).toBe(false);
    expect(chatApiMock.changeModel).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().worktreeChats[
        `${PIPELINE_EDITOR_PROJECT_ID}/${PIPELINE_EDITOR_WORKTREE_ID}`
      ]?.tabs[0]?.model,
    ).toBe('gpt-5.6-luna');
  });

  it('reads, sends, and configures Pipeline Assistant chats through the sentinel scope', async () => {
    const pipelineTab = makeChatTab({
      id: 'pipeline-chat-1',
      title: 'Pipeline draft chat',
      providerType: 'codex',
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    });
    useChatStore.setState({
      worktreeChats: {
        [`${PIPELINE_EDITOR_PROJECT_ID}/${PIPELINE_EDITOR_WORKTREE_ID}`]: {
          activeTabId: 'pipeline-chat-1',
          tabs: [pipelineTab],
        },
      },
    });
    const openListener = jest.fn();
    window.addEventListener('canopy:pipelines-open-assistant', openListener);

    const history = await dispatchAppAction({
      requestId: 'req-pipeline-assistant-history',
      source: 'assistant',
      action: {
        type: 'pipeline-assistant-chat.read_history',
        chatId: 'pipeline-chat-1',
        query: 'pipeline',
      },
    });
    const send = await dispatchAppAction({
      requestId: 'req-pipeline-assistant-send',
      source: 'assistant',
      action: {
        type: 'pipeline-assistant-chat.send_message',
        chatId: 'pipeline-chat-1',
        text: 'Revise the test pipeline.',
      },
    });
    const model = await dispatchAppAction({
      requestId: 'req-pipeline-assistant-model',
      source: 'assistant',
      action: {
        type: 'pipeline-assistant-chat.set_model',
        chatId: 'pipeline-chat-1',
        model: 'gpt-5.6-luna',
      },
    });
    const plugin = await dispatchAppAction({
      requestId: 'req-pipeline-assistant-plugin',
      source: 'assistant',
      action: {
        type: 'pipeline-assistant-chat.update_plugin_selection',
        chatId: 'pipeline-chat-1',
        kind: 'skill',
        key: 'builtin/app/example',
        enabled: true,
      },
    });

    window.removeEventListener('canopy:pipelines-open-assistant', openListener);

    expect(history.ok).toBe(true);
    expect(history.result).toMatchObject({
      projectId: PIPELINE_EDITOR_PROJECT_ID,
      worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
      chatId: 'pipeline-chat-1',
      mode: 'transcript',
      matchedMessages: 1,
    });
    expect(send.ok).toBe(true);
    expect(useNavigationStore.getState().activePage).toBe('workflows-library');
    expect(openListener).toHaveBeenCalled();
    expect(window.api.savePreferences).toHaveBeenCalledWith({
      pipelineChatPanelVisible: true,
    });
    expect(chatApiMock.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PIPELINE_EDITOR_PROJECT_ID,
        worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
        chatId: 'pipeline-chat-1',
        text: 'Revise the test pipeline.',
      }),
    );
    expect(model.ok).toBe(true);
    expect(chatApiMock.changeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PIPELINE_EDITOR_PROJECT_ID,
        worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
        chatId: 'pipeline-chat-1',
        model: 'gpt-5.6-luna',
      }),
    );
    expect(plugin.ok).toBe(true);
    expect(plugin.result).toMatchObject({
      pluginSelections: {
        skillRefs: [
          { sourceId: 'builtin/app', skillName: 'example' },
          PIPELINE_EDITOR_REQUIRED_SKILL_REF,
        ],
      },
    });
    expect(chatApiMock.updatePlugins).toHaveBeenCalledWith({
      projectId: PIPELINE_EDITOR_PROJECT_ID,
      worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
      chatId: 'pipeline-chat-1',
      pluginSelections: {
        collectionIds: [],
        skillRefs: [
          { sourceId: 'builtin/app', skillName: 'example' },
          PIPELINE_EDITOR_REQUIRED_SKILL_REF,
        ],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    });
  });

  it('lists available standalone chat plugins from project defaults without requiring an active chat', async () => {
    (window.skills.loadSkills as jest.Mock).mockResolvedValue({
      success: true,
      data: [
        {
          name: 'example',
          sourceId: 'builtin/app',
          description: 'Example skill',
          source: 'builtin',
          installedAt: '',
          updatedAt: '',
          updateAvailable: false,
          builtIn: true,
        },
      ],
    });
    useStandaloneChatStore.setState({
      chatProjects: [
        makeStandaloneProject({
          defaultPluginSelections: {
            collectionIds: [],
            skillRefs: [{ sourceId: 'builtin/app', skillName: 'example' }],
            pluginRefs: [],
            mcpServerRefs: [],
          },
        }),
      ],
      activeChatProjectId: 'project-a',
      chatProjectsLoaded: true,
    });

    const response = await dispatchAppAction({
      requestId: 'req-standalone-list-plugins',
      source: 'assistant',
      action: {
        type: 'standalone-chat.list_plugins',
        projectId: 'project-a',
        query: 'example',
      },
    });

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      target: {
        projectId: 'project-a',
        scope: 'standalone-project-defaults',
      },
      totalMatches: 1,
      returned: 1,
    });
    expect(JSON.stringify(response.result)).toContain('"selected":true');
  });

  it('lists cowork projects and selects latest chat for workspace-only navigation', async () => {
    // A cowork chat target navigates via `selectWorktree(workspaceId, home)`,
    // which is only permitted for a not-yet-hydrated project list or a
    // registered cowork workspace id (see `canNavigateToWorktreeFromSidebarItems`).
    // Reset any `hasHydratedProjects: true` state leaked from earlier tests so
    // the cowork workspace id used here isn't treated as an unknown,
    // non-navigable worktree.
    useProjectsStore.setState({ projects: [], hasHydratedProjects: false });
    chatProjectApiMock.list.mockResolvedValue({
      projects: [
        makeStandaloneProject({
          id: DEFAULT_COWORK_WORKSPACE_ID,
          name: 'Default',
          description: undefined,
        }),
        makeStandaloneProject(),
      ],
    });
    chatApiMock.loadTabs.mockResolvedValue({
      version: 1,
      activeTabId: 'standalone-1',
      tabs: [
        makeChatTab({
          id: 'standalone-1',
          title: 'Research chat',
          providerType: 'codex',
        }),
        makeChatTab({
          id: 'latest-standalone',
          title: 'Latest chat',
          providerType: 'claude',
        }),
      ],
    });
    standaloneChatApiMock.list.mockResolvedValue({
      chats: [
        {
          id: 'standalone-1',
          title: 'Research chat',
          description: 'Roadmap planning',
          createdAt: new Date(0).toISOString(),
          messageCount: 2,
          lastMessageAt: new Date(10).toISOString(),
          providerType: 'codex',
        },
        {
          id: 'latest-standalone',
          title: 'Latest chat',
          description: 'Recent workspace-only target',
          createdAt: new Date(0).toISOString(),
          messageCount: 1,
          lastMessageAt: new Date(30).toISOString(),
          providerType: 'claude',
        },
        {
          id: 'archived-1',
          title: 'Archived chat',
          description: 'Old notes',
          createdAt: new Date(0).toISOString(),
          archived: true,
          archivedAt: new Date(40).toISOString(),
        },
      ],
    });

    const projects = await dispatchAppAction({
      requestId: 'req-standalone-projects',
      source: 'assistant',
      action: { type: 'standalone-chat.list_projects', query: 'research' },
    });
    const chats = await dispatchAppAction({
      requestId: 'req-standalone-chats',
      source: 'assistant',
      action: {
        type: 'standalone-chat.list_chats',
        projectId: 'project-a',
        providerType: 'codex',
      },
    });
    chatApiMock.loadArchives.mockResolvedValue([
      {
        chatId: 'entry-archive',
        title: 'Entry archive',
        description: 'Archived inside entry-1',
        providerType: 'codex',
        turnCount: 3,
        archivedAt: new Date(50).toISOString(),
        createdAt: new Date(5).toISOString(),
        restorable: true,
        unread: false,
      },
    ]);
    const chatsWithArchives = await dispatchAppAction({
      requestId: 'req-standalone-chats-archived',
      source: 'assistant',
      action: {
        type: 'standalone-chat.list_chats',
        projectId: 'project-a',
        includeArchived: true,
      },
    });
    const switchedProject = await dispatchAppAction({
      requestId: 'req-standalone-switch-project',
      source: 'assistant',
      action: {
        type: 'standalone-chat.switch_project',
        projectId: 'project-a',
      },
    });
    const switchedChat = await dispatchAppAction({
      requestId: 'req-standalone-switch-chat',
      source: 'assistant',
      action: {
        type: 'standalone-chat.switch_chat',
        projectId: 'project-a',
        chatId: 'standalone-1',
      },
    });
    const createdChat = await dispatchAppAction({
      requestId: 'req-standalone-create-chat',
      source: 'assistant',
      action: {
        type: 'standalone-chat.create_chat',
        projectId: 'project-a',
      },
    });

    expect(projects.ok).toBe(true);
    expect(JSON.stringify(projects.result)).toContain('Research');
    expect(chats.ok).toBe(true);
    expect(chats.result).toMatchObject({ returned: 1 });
    expect(JSON.stringify(chats.result)).not.toContain('Archived chat');
    expect(chatsWithArchives.ok).toBe(true);
    expect(JSON.stringify(chatsWithArchives.result)).toContain('entry-archive');
    expect(chatsWithArchives.result).toMatchObject({ returned: 4 });
    expect(chatApiMock.loadArchives).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'entry-1',
    });
    expect(switchedProject.ok).toBe(true);
    // Work Entries: switching a project auto-selects the most recent Work
    // Entry and reports its active chat tab (from the loaded tab file).
    expect(switchedProject.result).toMatchObject({
      activeProjectId: 'project-a',
      workEntryId: 'entry-1',
      chat: { id: 'standalone-1' },
    });
    expect(switchedChat.ok).toBe(true);
    expect(useNavigationStore.getState().activePage).toBe('chat');
    expect(useStandaloneChatStore.getState().activeChatProjectId).toBe(
      'project-a',
    );
    expect(createdChat.ok).toBe(true);
    const createdChatId = (createdChat.result as { chatId?: string }).chatId;
    expect(typeof createdChatId).toBe('string');
    // create_chat creates a fresh Work Entry whose active tab IS the chat.
    const createdEntryId = useStandaloneChatStore.getState().activeWorkEntryId;
    expect(createdEntryId).toBe('entry-new');
    expect(
      useChatStore.getState().worktreeChats[`project-a/${createdEntryId}`]
        .activeTabId,
    ).toBe(createdChatId);
    expect(
      useChatStore
        .getState()
        .worktreeChats[
          `project-a/${createdEntryId}`
        ].tabs.some((tab) => tab.id === createdChatId),
    ).toBe(true);
  });

  it('selects the newest Work Entry when switching to the already-active cowork project', async () => {
    const newestTab = makeChatTab({ id: 'newest-chat', title: 'Newest chat' });
    useProjectsStore.setState({
      projects: [
        {
          type: 'cowork',
          id: 'project-a',
          name: 'Research',
          color: '#336699',
          collapsed: false,
          order: 0,
        },
      ],
      hasHydratedProjects: true,
    });
    useStandaloneChatStore.setState({
      activeChatProjectId: 'project-a',
      activeWorkEntryId: 'entry-older',
      initialized: true,
      workEntries: [
        {
          id: 'entry-newest',
          title: 'Newest entry',
          createdAt: new Date(20).toISOString(),
          chatCount: 1,
        },
        {
          id: 'entry-older',
          title: 'Older entry',
          createdAt: new Date(10).toISOString(),
          chatCount: 1,
        },
      ],
    });
    useChatStore.setState({
      selectedWorktree: {
        projectId: 'project-a',
        worktreeId: 'entry-older',
      },
      worktreeChats: {},
    });
    chatApiMock.loadTabs.mockResolvedValueOnce({
      version: 1,
      tabs: [newestTab],
      activeTabId: newestTab.id,
    });

    const response = await dispatchAppAction({
      requestId: 'req-standalone-switch-active-project',
      source: 'assistant',
      action: {
        type: 'standalone-chat.switch_project',
        projectId: 'project-a',
      },
    });

    expect(response).toMatchObject({
      ok: true,
      result: {
        activeProjectId: 'project-a',
        workEntryId: 'entry-newest',
      },
    });
    expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
      'entry-newest',
    );
    expect(standaloneChatApiMock.init).not.toHaveBeenCalled();
  });

  it('renames and deletes cowork Work Entries through App Advisor actions', async () => {
    const renamed = await dispatchAppAction({
      requestId: 'req-standalone-rename-entry',
      source: 'assistant',
      action: {
        type: 'standalone-chat.rename_work_entry',
        projectId: 'project-a',
        workEntryId: 'entry-1',
        title: 'Release research',
      },
    });
    const deleted = await dispatchAppAction({
      requestId: 'req-standalone-delete-entry',
      source: 'assistant',
      action: {
        type: 'standalone-chat.delete_work_entry',
        projectId: 'project-a',
        workEntryId: 'entry-1',
      },
    });

    expect(renamed).toMatchObject({
      ok: true,
      result: {
        projectId: 'project-a',
        workEntryId: 'entry-1',
        title: 'Release research',
      },
    });
    expect(workEntriesApiMock.update).toHaveBeenCalledWith({
      projectId: 'project-a',
      entryId: 'entry-1',
      title: 'Release research',
    });
    expect(deleted).toMatchObject({
      ok: true,
      result: {
        projectId: 'project-a',
        workEntryId: 'entry-1',
        deleted: true,
      },
    });
    expect(workEntriesApiMock.delete).toHaveBeenCalledWith({
      projectId: 'project-a',
      entryId: 'entry-1',
    });
  });

  it('sends messages and reads history for standalone chats', async () => {
    const standaloneTab = makeChatTab({
      id: 'standalone-1',
      title: 'Research chat',
      providerType: 'codex',
    });
    // Work Entries: the chat lives in entry-1 (the resolveChat mock default),
    // which occupies the worktreeId slot.
    useChatStore.setState({
      worktreeChats: {
        'project-a/entry-1': {
          activeTabId: 'standalone-1',
          tabs: [standaloneTab],
        },
      },
    });
    chatApiMock.loadTabs.mockResolvedValue({
      version: 1,
      activeTabId: 'standalone-1',
      tabs: [standaloneTab],
    });

    const lastUser = await dispatchAppAction({
      requestId: 'req-standalone-last-user',
      source: 'assistant',
      action: {
        type: 'standalone-chat.get_last_user_message',
        projectId: 'project-a',
        chatId: 'standalone-1',
      },
    });
    const history = await dispatchAppAction({
      requestId: 'req-standalone-history',
      source: 'assistant',
      action: {
        type: 'standalone-chat.read_history',
        projectId: 'project-a',
        chatId: 'standalone-1',
        query: 'transcript',
        limit: 1,
      },
    });
    const send = await dispatchAppAction({
      requestId: 'req-standalone-send',
      source: 'assistant',
      action: {
        type: 'standalone-chat.send_message',
        projectId: 'project-a',
        chatId: 'standalone-1',
        text: 'Review the cowork project.',
      },
    });

    expect(lastUser.ok).toBe(true);
    expect(JSON.stringify(lastUser.result)).toContain(
      'Now check the App Advisor transcript.',
    );
    expect(history.ok).toBe(true);
    expect(history.result).toMatchObject({
      mode: 'transcript',
      matchedMessages: 2,
      returnedMessages: 1,
    });
    expect(send).toMatchObject({
      ok: false,
      error: { code: 'unsupported_action' },
    });
    expect(chatApiMock.sendMessage).not.toHaveBeenCalled();
  });

  it('reads archived standalone chat history from the owning Work Entry archive', async () => {
    const archivedTab = makeChatTab({
      id: 'archived-chat-1',
      title: 'Archived research',
      providerType: 'codex',
    });
    workEntriesApiMock.resolveChat.mockResolvedValue({
      entryId: null,
      archivedInEntryId: 'entry-archived',
    });
    chatApiMock.readArchive.mockResolvedValue({ tab: archivedTab });

    const history = await dispatchAppAction({
      requestId: 'req-standalone-archived-history',
      source: 'assistant',
      action: {
        type: 'standalone-chat.read_history',
        projectId: 'project-a',
        chatId: 'archived-chat-1',
      },
    });

    expect(history.ok).toBe(true);
    expect(history.result).toMatchObject({
      projectId: 'project-a',
      worktreeId: 'entry-archived',
      chatId: 'archived-chat-1',
      tabTitle: 'Archived research',
    });
    expect(chatApiMock.readArchive).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'entry-archived',
      chatId: 'archived-chat-1',
      fullTranscript: true,
    });
  });

  it('reads legacy standalone archives when no Work Entry owns the chat', async () => {
    const archivedTab = makeChatTab({
      id: 'legacy-archived-chat',
      title: 'Legacy archived research',
      providerType: 'claude',
    });
    workEntriesApiMock.resolveChat.mockResolvedValue({
      entryId: null,
      archivedInEntryId: null,
    });
    standaloneChatApiMock.readArchive.mockResolvedValue({
      snapshot: {
        version: 1,
        projectId: 'project-a',
        chatId: 'legacy-archived-chat',
        archivedAt: new Date(20).toISOString(),
        tab: archivedTab,
      },
      summary: 'Legacy archived research',
      legacySummaryOnly: false,
    });

    const history = await dispatchAppAction({
      requestId: 'req-legacy-standalone-archived-history',
      source: 'assistant',
      action: {
        type: 'standalone-chat.read_history',
        projectId: 'project-a',
        chatId: 'legacy-archived-chat',
      },
    });

    expect(history.ok).toBe(true);
    expect(history.result).toMatchObject({
      projectId: 'project-a',
      worktreeId: COWORK_HOME_WORKTREE_ID,
      chatId: 'legacy-archived-chat',
      tabTitle: 'Legacy archived research',
    });
    expect(standaloneChatApiMock.readArchive).toHaveBeenCalledWith({
      projectId: 'project-a',
      chatId: 'legacy-archived-chat',
    });
  });

  it('rejects mutating App Advisor actions for archived cowork chats', async () => {
    const archivedTab = makeChatTab({
      id: 'archived-chat-1',
      title: 'Archived research',
      providerType: 'codex',
    });
    workEntriesApiMock.resolveChat.mockResolvedValue({
      entryId: null,
      archivedInEntryId: 'entry-archived',
    });
    chatApiMock.readArchive.mockResolvedValue({ tab: archivedTab });

    const send = await dispatchAppAction({
      requestId: 'req-archived-send',
      source: 'assistant',
      action: {
        type: 'standalone-chat.send_message',
        projectId: 'project-a',
        chatId: 'archived-chat-1',
        text: 'Do not send this.',
      },
    });
    const model = await dispatchAppAction({
      requestId: 'req-archived-model',
      source: 'assistant',
      action: {
        type: 'standalone-chat.set_model',
        projectId: 'project-a',
        chatId: 'archived-chat-1',
        model: 'gpt-6-luna',
      },
    });
    const thinking = await dispatchAppAction({
      requestId: 'req-archived-thinking',
      source: 'assistant',
      action: {
        type: 'standalone-chat.set_thinking_level',
        projectId: 'project-a',
        chatId: 'archived-chat-1',
        level: 'high',
      },
    });
    const updatePlugin = await dispatchAppAction({
      requestId: 'req-archived-update-plugin',
      source: 'assistant',
      action: {
        type: 'standalone-chat.update_plugin_selection',
        projectId: 'project-a',
        chatId: 'archived-chat-1',
        kind: 'skill',
        key: 'builtin/app/example',
        enabled: true,
      },
    });
    const replacePlugins = await dispatchAppAction({
      requestId: 'req-archived-replace-plugins',
      source: 'assistant',
      action: {
        type: 'standalone-chat.set_plugin_selections',
        projectId: 'project-a',
        chatId: 'archived-chat-1',
        selections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
      },
    });

    for (const response of [model, thinking, updatePlugin, replacePlugins]) {
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'invalid_target' },
      });
    }
    expect(send).toMatchObject({
      ok: false,
      error: { code: 'unsupported_action' },
    });
    expect(chatApiMock.sendMessage).not.toHaveBeenCalled();
    expect(chatApiMock.changeModel).not.toHaveBeenCalled();
    expect(chatApiMock.toggleThinkingLevel).not.toHaveBeenCalled();
  });

  it('forwards Cursor model selection from the standalone action surface to the canonical model change', async () => {
    // Cowork runs Cursor on the managed runtime; the renderer no longer
    // special-cases Cursor here and main's `changeChatModel` applies the live
    // runtime check.
    const tab = makeChatTab({
      id: 'standalone-1',
      model: 'gpt-5.6-luna',
      providerType: 'codex',
    });
    useChatStore.setState({
      worktreeChats: {
        'project-a/entry-1': { activeTabId: tab.id, tabs: [tab] },
      },
    });
    chatApiMock.loadTabs.mockResolvedValue({
      version: 1,
      activeTabId: tab.id,
      tabs: [tab],
    });
    chatApiMock.changeModel.mockResolvedValue(true);
    const result = await dispatchAppAction({
      requestId: 'cursor-standalone-model',
      source: 'assistant',
      action: {
        type: 'standalone-chat.set_model',
        projectId: 'project-a',
        chatId: tab.id,
        model: 'cursor-default',
      },
    });
    expect(result.ok).toBe(true);
    expect(chatApiMock.changeModel).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: tab.id, model: 'cursor-default' }),
    );
  });

  it('reports a Cursor model change the canonical IPC refused for a Cowork chat', async () => {
    // Main refuses when the managed runtime is disconnected. App Advisor must
    // hear that refusal, not a success for a change that never landed.
    const tab = makeChatTab({
      id: 'standalone-1',
      model: 'gpt-5.6-luna',
      providerType: 'codex',
    });
    useChatStore.setState({
      worktreeChats: {
        'project-a/entry-1': { activeTabId: tab.id, tabs: [tab] },
      },
    });
    chatApiMock.loadTabs.mockResolvedValue({
      version: 1,
      activeTabId: tab.id,
      tabs: [tab],
    });
    chatApiMock.changeModel.mockResolvedValue(false);
    const result = await dispatchAppAction({
      requestId: 'cursor-standalone-model-refused',
      source: 'assistant',
      action: {
        type: 'standalone-chat.set_model',
        projectId: 'project-a',
        chatId: tab.id,
        model: 'cursor-default',
      },
    });
    expect(result.ok).toBe(false);
    expect(chatApiMock.changeModel).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: tab.id, model: 'cursor-default' }),
    );
  });

  it('changes standalone chat model, thinking, and plugin selections', async () => {
    const standaloneTab = makeChatTab({
      id: 'standalone-1',
      title: 'Research chat',
      providerType: 'codex',
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    });
    // Work Entries: the chat lives in entry-1 (the resolveChat mock default).
    useChatStore.setState({
      worktreeChats: {
        'project-a/entry-1': {
          activeTabId: 'standalone-1',
          tabs: [standaloneTab],
        },
      },
    });
    chatApiMock.loadTabs.mockResolvedValue({
      version: 1,
      activeTabId: 'standalone-1',
      tabs: [standaloneTab],
    });

    const model = await dispatchAppAction({
      requestId: 'req-standalone-model',
      source: 'assistant',
      action: {
        type: 'standalone-chat.set_model',
        projectId: 'project-a',
        chatId: 'standalone-1',
        model: 'gpt-5.6-luna',
      },
    });
    const thinking = await dispatchAppAction({
      requestId: 'req-standalone-thinking',
      source: 'assistant',
      action: {
        type: 'standalone-chat.set_thinking_level',
        projectId: 'project-a',
        chatId: 'standalone-1',
        level: 'xhigh',
      },
    });
    const plugin = await dispatchAppAction({
      requestId: 'req-standalone-plugin',
      source: 'assistant',
      action: {
        type: 'standalone-chat.update_plugin_selection',
        projectId: 'project-a',
        chatId: 'standalone-1',
        kind: 'skill',
        key: 'builtin/app/example',
        enabled: true,
      },
    });
    const selections = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'builtin/app', skillName: 'summary' }],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    const replace = await dispatchAppAction({
      requestId: 'req-standalone-plugin-replace',
      source: 'assistant',
      action: {
        type: 'standalone-chat.set_plugin_selections',
        projectId: 'project-a',
        chatId: 'standalone-1',
        selections,
      },
    });

    expect(model.ok).toBe(true);
    expect(chatApiMock.changeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-a',
        worktreeId: 'entry-1',
        chatId: 'standalone-1',
        model: 'gpt-5.6-luna',
      }),
    );
    expect(thinking.ok).toBe(true);
    expect(chatApiMock.toggleThinkingLevel).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'entry-1',
      chatId: 'standalone-1',
      level: 'xhigh',
    });
    expect(plugin.ok).toBe(true);
    expect(chatApiMock.updatePlugins).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'entry-1',
      chatId: 'standalone-1',
      pluginSelections: {
        collectionIds: [],
        skillRefs: [{ sourceId: 'builtin:app', skillName: 'example' }],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    });
    expect(replace.ok).toBe(true);
    expect(chatApiMock.updatePlugins).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'entry-1',
      chatId: 'standalone-1',
      pluginSelections: {
        ...selections,
        skillRefs: [{ sourceId: 'builtin:app', skillName: 'summary' }],
      },
    });
  });

  it('lists and reads cowork project items', async () => {
    const prompts = await dispatchAppAction({
      requestId: 'req-standalone-prompts',
      source: 'assistant',
      action: { type: 'standalone-chat.list_prompts', projectId: 'project-a' },
    });
    const prompt = await dispatchAppAction({
      requestId: 'req-standalone-prompt',
      source: 'assistant',
      action: {
        type: 'standalone-chat.get_prompt',
        projectId: 'project-a',
        promptId: 'prompt-1',
      },
    });
    const note = await dispatchAppAction({
      requestId: 'req-standalone-note',
      source: 'assistant',
      action: {
        type: 'standalone-chat.get_note',
        projectId: 'project-a',
        noteId: 'note-1',
      },
    });
    const attachment = await dispatchAppAction({
      requestId: 'req-standalone-attachment',
      source: 'assistant',
      action: {
        type: 'standalone-chat.get_attachment',
        projectId: 'project-a',
        attachmentId: 'attachment-1',
        includeContent: true,
      },
    });
    expect(prompts.ok).toBe(true);
    expect(JSON.stringify(prompts.result)).toContain('Prompt One');
    expect(workspaceItemsApiMock.listPrompts).toHaveBeenCalledWith({
      projectId: 'project-a',
    });
    expect(prompt.ok).toBe(true);
    expect(prompt.result).toMatchObject({ content: 'Prompt body' });
    expect(workspaceItemsApiMock.readPrompt).toHaveBeenCalledWith({
      projectId: 'project-a',
      promptId: 'prompt-1',
    });
    expect(note.ok).toBe(true);
    expect(note.result).toMatchObject({ content: '# Note One' });
    expect(workspaceItemsApiMock.readNote).toHaveBeenCalledWith({
      projectId: 'project-a',
      noteId: 'note-1',
    });
    expect(attachment.ok).toBe(true);
    expect(workspaceItemsApiMock.listAttachments).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: COWORK_HOME_WORKTREE_ID,
    });
    expect(window.api.readFileContent).toHaveBeenCalledWith({
      absolutePath: '/tmp/requirements.md',
    });
  });

  it('gets and updates cowork project settings', async () => {
    standaloneChatApiMock.loadWorkspace.mockResolvedValue(
      makeStandaloneWorkspaceSnapshot({
        archives: [
          {
            chatId: 'legacy-archive',
            title: 'Legacy archive',
            createdAt: new Date(0).toISOString(),
            archivedAt: new Date(10).toISOString(),
            messageCount: 1,
            hasConversationSnapshot: true,
            legacySummaryOnly: false,
          },
        ],
      }),
    );
    chatApiMock.loadArchives.mockResolvedValue([
      {
        chatId: 'legacy-archive',
        title: 'Duplicate legacy archive',
        turnCount: 1,
        archivedAt: new Date(10).toISOString(),
        createdAt: new Date(0).toISOString(),
        restorable: true,
        unread: false,
      },
      {
        chatId: 'entry-archive',
        title: 'Work Entry archive',
        turnCount: 2,
        archivedAt: new Date(20).toISOString(),
        createdAt: new Date(0).toISOString(),
        restorable: true,
        unread: false,
      },
    ]);
    const settings = await dispatchAppAction({
      requestId: 'req-standalone-settings',
      source: 'assistant',
      action: {
        type: 'standalone-chat.get_settings',
        projectId: 'project-a',
        includeClaudeMd: true,
      },
    });
    const update = await dispatchAppAction({
      requestId: 'req-standalone-update-settings',
      source: 'assistant',
      action: {
        type: 'standalone-chat.update_settings',
        projectId: 'project-a',
        description: 'Updated description',
        defaultModel: 'gpt-6-luna',
        autoArchiveDays: 7,
        alwaysShow: false,
        claudeMd: '# Updated',
      },
    });

    expect(settings.ok).toBe(true);
    expect(settings.result).toMatchObject({
      counts: {
        archives: 2,
        notes: 1,
        prompts: 1,
        attachments: 1,
      },
      claudeMd: '# Standalone',
    });
    expect(chatApiMock.loadArchives).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'entry-1',
    });
    expect(chatApiMock.loadArchives).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: COWORK_HOME_WORKTREE_ID,
    });
    expect(update.ok).toBe(true);
    expect(chatProjectApiMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-a',
        description: 'Updated description',
        defaultModel: 'gpt-6-luna',
        autoArchiveDays: 7,
        alwaysShow: false,
      }),
    );
    expect(chatProjectApiMock.saveClaudeMd).toHaveBeenCalledWith({
      projectId: 'project-a',
      content: '# Updated',
    });
  });

  it('refuses Advisor environment changes when encrypted values cannot be read', async () => {
    useProjectsStore.setState({
      projects: [
        {
          type: 'cowork',
          id: 'cowork-1',
          name: 'Cowork One',
          color: '#333333',
          collapsed: false,
          order: 0,
        },
      ],
      hasHydratedProjects: true,
    });
    const secureStorageFailure = {
      version: 1 as const,
      code: 'SECURE_STORAGE_READ_UNAVAILABLE' as const,
      operation: 'read' as const,
      state: 'locked' as const,
      backend: 'gnome_libsecret',
      retryable: true,
    };
    loadEnvironmentConfigMock.mockResolvedValueOnce({
      ok: false,
      error: 'Saved values could not be read.',
      secureStorageFailure,
    });

    const response = await dispatchAppAction({
      requestId: 'req-environment-locked',
      source: 'assistant',
      action: {
        type: 'environment.update_workspace_assignment',
        workspaceId: 'cowork-1',
        runtimes: { agent: 'environment-1' },
      },
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'execution_failed', retryable: true },
      result: { secureStorageFailure },
    });
    expect(saveEnvironmentConfigMock).not.toHaveBeenCalled();
  });

  it('updates project environment assignments through the canonical config store', async () => {
    const currentData: EnvironmentConfigData = {
      version: 2 as const,
      environments: [
        {
          id: 'environment-1',
          name: 'Environment One',
          parentId: null,
          isDefault: false,
          uiMode: 'key-value',
          variables: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      globalRuntimes: { canopy: null, agent: null, pipeline: null },
      workspaceAssignments: [],
    };
    useProjectsStore.setState({
      projects: [
        {
          type: 'cowork',
          id: 'cowork-1',
          name: 'Cowork One',
          color: '#333333',
          collapsed: false,
          order: 0,
        },
      ],
      hasHydratedProjects: true,
    });
    loadEnvironmentConfigMock.mockResolvedValue({
      data: currentData,
      encryptionAvailable: true,
    });
    saveEnvironmentConfigMock.mockImplementation((data) =>
      Promise.resolve({ ok: true, data, encryptionAvailable: true }),
    );

    const response = await dispatchAppAction({
      requestId: 'req-environment-workspace-assignment',
      source: 'assistant',
      action: {
        type: 'environment.update_workspace_assignment',
        workspaceId: 'cowork-1',
        runtimes: { agent: 'environment-1' },
      },
    });

    expect(response.ok).toBe(true);
    expect(saveEnvironmentConfigMock).toHaveBeenCalledTimes(1);
    expect(saveEnvironmentConfigMock.mock.calls[0]?.[0]).toMatchObject({
      ...currentData,
      workspaceAssignments: [
        {
          workspaceId: 'cowork-1',
          runtimes: { agent: 'environment-1' },
        },
      ],
    });
    expect(
      saveEnvironmentConfigMock.mock.calls[0]?.[0].workspaceAssignments[0]
        ?.updatedAt,
    ).toEqual(expect.any(String));
  });

  it('identifies the real cowork default project while allowing it to be renamed', async () => {
    // Regression test: several dispatcher call sites used to compare against
    // the legacy `DEFAULT_CHAT_PROJECT_ID` ('default') instead of the actual
    // `DEFAULT_COWORK_WORKSPACE_ID` ('cowork-default'). The default cowork
    // workspace is protected from deletion only; it should still be
    // identified as default in summaries and remain renameable.
    const listed = await dispatchAppAction({
      requestId: 'req-standalone-list-exclude-default',
      source: 'assistant',
      action: {
        type: 'standalone-chat.list_projects',
        includeDefault: false,
      },
    });
    expect(listed.ok).toBe(true);
    const listedIds = (
      listed.result as { projects: Array<{ id: string }> }
    ).projects.map((entry) => entry.id);
    expect(listedIds).not.toContain(DEFAULT_COWORK_WORKSPACE_ID);
    expect(listedIds).toContain('project-a');

    const listedWithDefault = await dispatchAppAction({
      requestId: 'req-standalone-list-include-default',
      source: 'assistant',
      action: { type: 'standalone-chat.list_projects' },
    });
    const defaultSummary = (
      listedWithDefault.result as {
        projects: Array<{ id: string; isDefault: boolean }>;
      }
    ).projects.find((entry) => entry.id === DEFAULT_COWORK_WORKSPACE_ID);
    expect(defaultSummary?.isDefault).toBe(true);
    const nonDefaultSummary = (
      listedWithDefault.result as {
        projects: Array<{ id: string; isDefault: boolean }>;
      }
    ).projects.find((entry) => entry.id === 'project-a');
    expect(nonDefaultSummary?.isDefault).toBe(false);

    const renamed = await dispatchAppAction({
      requestId: 'req-standalone-rename-default',
      source: 'assistant',
      action: {
        type: 'standalone-chat.update_settings',
        projectId: DEFAULT_COWORK_WORKSPACE_ID,
        name: 'Renamed Default',
      },
    });
    expect(renamed.ok).toBe(true);
    expect(chatProjectApiMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: DEFAULT_COWORK_WORKSPACE_ID,
        name: 'Renamed Default',
      }),
    );
  });

  describe('shared-containers.* actions (CAN-2546)', () => {
    const FLAG_KEY = CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key;
    const loadSharedWithMe =
      useSharedContainerReplicasStore.getState().loadSharedWithMe;

    function setSharedContainersFlag(enabled: boolean): void {
      const base = getDefaultFeatureFlagSnapshot();
      useFeatureFlagsStore.setState({
        snapshot: {
          ...base,
          values: { ...base.values, [FLAG_KEY]: enabled },
          status: 'ready',
          initialized: true,
          updatedAt: new Date().toISOString(),
          error: null,
        },
      });
    }

    beforeEach(() => {
      setSharedContainersFlag(true);
      sharedContainersApiMock.revokeRecipient.mockClear();
      sharedContainersApiMock.open.mockClear();
      sharedContainersApiMock.retry.mockClear();
      sharedContainersApiMock.open.mockResolvedValue({
        status: 'available',
        containerId: 'container-received',
        organizationId: 'org-1',
        containerType: 'CODE_WORKTREE',
        revisionId: 'revision-1',
        revision: 1,
        revisionCreatedAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      });
      sharedContainersApiMock.retry.mockResolvedValue({
        status: 'available',
        containerId: 'container-received',
        organizationId: 'org-1',
        containerType: 'CODE_WORKTREE',
        revisionId: 'revision-1',
        revision: 1,
        revisionCreatedAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      });
      useSharedContainerReplicasStore.getState().reset();
      useSharedContainerReplicasStore.setState({
        loadSharedWithMe: jest.fn().mockResolvedValue(undefined),
        entries: [
          {
            organizationId: 'org-1',
            container: {
              id: 'container-received',
              organizationId: 'org-1',
              ownerUserId: 'owner-1',
              owner: { userId: 'owner-1', name: 'Owner' },
              access: 'organization',
              worktreeId: 'worktree-1',
              containerType: 'CODE_WORKTREE',
              title: 'Feature branch',
              revision: 1,
              capabilities: ['VIEW'],
              createdAt: '2026-09-01T00:00:00.000Z',
              updatedAt: '2026-09-01T00:00:00.000Z',
            },
          },
        ],
        listStatus: 'success',
        acceptedIds: ['container-received'],
        acceptedStatus: 'success',
      });
    });

    afterEach(() => {
      useSharedContainerReplicasStore.setState({ loadSharedWithMe });
    });

    it('refuses to open a share the user has not accepted', async () => {
      useSharedContainerReplicasStore.setState({ acceptedIds: [] });

      const opened = await dispatchAppAction({
        requestId: 'req-shared-container-open-unaccepted',
        source: 'assistant',
        action: {
          type: 'shared-containers.open_received',
          containerId: 'container-received',
          organizationId: 'org-1',
        },
      });

      expect(opened).toMatchObject({
        ok: false,
        error: { code: 'surface_unavailable' },
      });
      // Accepting is what authorizes the clone, so Advisor must not be able to
      // reach materialization on the user's behalf.
      expect(sharedContainersApiMock.open).not.toHaveBeenCalled();
      expect(sharedContainersApiMock.accept).not.toHaveBeenCalled();
    });

    it('opens and retries a received container through the recipient store', async () => {
      const opened = await dispatchAppAction({
        requestId: 'req-shared-container-open-received',
        source: 'assistant',
        action: {
          type: 'shared-containers.open_received',
          containerId: 'container-received',
          organizationId: 'org-1',
        },
      });
      const retried = await dispatchAppAction({
        requestId: 'req-shared-container-retry-received',
        source: 'assistant',
        action: {
          type: 'shared-containers.retry_received',
          containerId: 'container-received',
        },
      });

      expect(opened).toMatchObject({ ok: true });
      expect(retried).toMatchObject({ ok: true });
      expect(sharedContainersApiMock.open).toHaveBeenCalledWith({
        containerId: 'container-received',
        organizationId: 'org-1',
        access: 'organization',
        viewerSessionId: ANY_VIEWER_SESSION_ID,
      });
      expect(sharedContainersApiMock.retry).toHaveBeenCalledWith({
        containerId: 'container-received',
        organizationId: 'org-1',
        access: 'organization',
        viewerSessionId: ANY_VIEWER_SESSION_ID,
      });
    });

    it('opens a personal direct share without an organization hint', async () => {
      sharedContainersApiMock.open.mockResolvedValueOnce({
        status: 'available',
        containerId: 'container-personal',
        access: 'direct',
        containerType: 'CODE_WORKTREE',
        revisionId: 'revision-personal',
        revision: 1,
        revisionCreatedAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      });
      useSharedContainerReplicasStore.setState({
        entries: [
          {
            access: 'direct',
            container: {
              id: 'container-personal',
              ownerUserId: 'owner-1',
              owner: { userId: 'owner-1', name: 'Owner' },
              access: 'direct',
              worktreeId: 'worktree-personal',
              containerType: 'CODE_WORKTREE',
              title: 'Personal share',
              revision: 1,
              capabilities: ['VIEW'],
              createdAt: '2026-09-01T00:00:00.000Z',
              updatedAt: '2026-09-01T00:00:00.000Z',
            },
          },
        ],
        acceptedIds: ['container-personal'],
      });

      const opened = await dispatchAppAction({
        requestId: 'req-shared-container-open-personal',
        source: 'assistant',
        action: {
          type: 'shared-containers.open_received',
          containerId: 'container-personal',
        },
      });

      expect(opened).toMatchObject({ ok: true });
      expect(sharedContainersApiMock.open).toHaveBeenCalledWith({
        containerId: 'container-personal',
        access: 'direct',
        viewerSessionId: ANY_VIEWER_SESSION_ID,
      });
    });

    it('switches to the owning context before Advisor opens a received share', async () => {
      const snapshot = getDefaultFeatureFlagSnapshot();
      useFeatureFlagsStore.setState({
        snapshot: {
          ...snapshot,
          status: 'ready',
          values: {
            ...snapshot.values,
            [FLAG_KEY]: true,
            [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
          },
        },
      });
      useWorkspaceContextStore.setState({
        hydrated: true,
        state: {
          context: { kind: 'personal' },
          revision: 1,
          organizations: [],
        },
      });
      const originalWorkspaceContext = window.api.workspaceContext;
      const set = jest.fn().mockResolvedValue({
        context: { kind: 'organization', organizationId: 'org-1' },
        revision: 2,
        organizations: [],
      });
      Object.assign(window.api, { workspaceContext: { set } });

      try {
        const opened = await dispatchAppAction({
          requestId: 'req-shared-container-open-owning-context',
          source: 'assistant',
          action: {
            type: 'shared-containers.open_received',
            containerId: 'container-received',
            organizationId: 'org-1',
          },
        });

        expect(opened).toMatchObject({ ok: true });
        expect(set).toHaveBeenCalledWith({
          context: { kind: 'organization', organizationId: 'org-1' },
          expectedRevision: 1,
        });
        expect(set.mock.invocationCallOrder[0]).toBeLessThan(
          sharedContainersApiMock.open.mock.invocationCallOrder[0] ?? 0,
        );
      } finally {
        Object.assign(window.api, {
          workspaceContext: originalWorkspaceContext,
        });
      }
    });

    it('applies the recipient capability gate to Advisor open and retry actions', async () => {
      setSharedContainersFlag(false);

      const opened = await dispatchAppAction({
        requestId: 'req-shared-container-open-received-disabled',
        source: 'assistant',
        action: {
          type: 'shared-containers.open_received',
          containerId: 'container-received',
          organizationId: 'org-1',
        },
      });
      const retried = await dispatchAppAction({
        requestId: 'req-shared-container-retry-received-disabled',
        source: 'assistant',
        action: {
          type: 'shared-containers.retry_received',
          containerId: 'container-received',
        },
      });

      expect(opened).toMatchObject({
        ok: false,
        error: { code: 'surface_unavailable' },
      });
      expect(retried).toMatchObject({
        ok: false,
        error: { code: 'surface_unavailable' },
      });
    });

    it('refuses Advisor open and retry without the VIEW capability', async () => {
      sharedContainersApiMock.open.mockClear();
      sharedContainersApiMock.retry.mockClear();
      const state = useSharedContainerReplicasStore.getState();
      const entry = state.entries[0];
      if (!entry) throw new Error('Expected a recipient fixture entry');
      useSharedContainerReplicasStore.setState({
        entries: [
          {
            ...entry,
            container: { ...entry.container, capabilities: [] },
          },
        ],
        viewer: {
          containerId: 'container-received',
          organizationId: 'org-1',
          loading: false,
          openError: null,
          replica: {
            status: 'available',
            containerId: 'container-received',
            organizationId: 'org-1',
            containerType: 'CODE_WORKTREE',
            revisionId: 'revision-1',
            revision: 1,
            revisionCreatedAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-01T00:00:00.000Z',
          },
        },
      });

      const opened = await dispatchAppAction({
        requestId: 'req-shared-container-open-received-no-view',
        source: 'assistant',
        action: {
          type: 'shared-containers.open_received',
          containerId: 'container-received',
          organizationId: 'org-1',
        },
      });
      const retried = await dispatchAppAction({
        requestId: 'req-shared-container-retry-received-no-view',
        source: 'assistant',
        action: {
          type: 'shared-containers.retry_received',
          containerId: 'container-received',
        },
      });

      expect(opened).toMatchObject({
        ok: false,
        error: { code: 'surface_unavailable' },
      });
      expect(retried).toMatchObject({
        ok: false,
        error: { code: 'surface_unavailable' },
      });
      expect(sharedContainersApiMock.open).not.toHaveBeenCalled();
      expect(sharedContainersApiMock.retry).not.toHaveBeenCalled();
    });

    it('opens the invite surface for a code worktree', async () => {
      useProjectsStore.setState({
        projects: [makeWorkspace()],
        hasHydratedProjects: true,
      });

      const acknowledge = (event: Event): void => event.preventDefault();
      window.addEventListener(OPEN_SHARED_CONTAINER_INVITE_EVENT, acknowledge);
      const response = await dispatchAppAction({
        requestId: 'req-shared-container-open-1',
        source: 'assistant',
        action: {
          type: 'shared-containers.open_invite',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          containerType: 'CODE_WORKTREE',
        },
      });
      window.removeEventListener(
        OPEN_SHARED_CONTAINER_INVITE_EVENT,
        acknowledge,
      );

      expect(response.ok).toBe(true);
    });

    it('carries a requested audience to the modal for that target only', async () => {
      useProjectsStore.setState({
        projects: [makeWorkspace()],
        hasHydratedProjects: true,
      });
      let requested: unknown = null;
      const acknowledge = (event: Event): void => {
        if (event instanceof CustomEvent) requested = event.detail;
        event.preventDefault();
      };
      window.addEventListener(OPEN_SHARED_CONTAINER_INVITE_EVENT, acknowledge);
      const response = await dispatchAppAction({
        requestId: 'req-shared-container-open-public',
        source: 'assistant',
        action: {
          type: 'shared-containers.open_invite',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          containerType: 'CODE_WORKTREE',
          audience: 'public',
        },
      });
      window.removeEventListener(
        OPEN_SHARED_CONTAINER_INVITE_EVENT,
        acknowledge,
      );

      expect(response.ok).toBe(true);
      expect(requested).toMatchObject({ audience: 'public' });
      // Consumed once by the modal that mounts for this target.
      expect(
        consumeRequestedSharedContainerInviteAudience('project-1', 'other'),
      ).toBeUndefined();
      expect(
        consumeRequestedSharedContainerInviteAudience(
          'project-1',
          'worktree-1',
        ),
      ).toBe('public');
      expect(
        consumeRequestedSharedContainerInviteAudience(
          'project-1',
          'worktree-1',
        ),
      ).toBeUndefined();
    });

    it('reports surface_unavailable when no mounted row acknowledges the invite', async () => {
      useProjectsStore.setState({
        projects: [makeWorkspace()],
        hasHydratedProjects: true,
      });

      await expect(
        dispatchAppAction({
          requestId: 'req-shared-container-open-unmounted',
          source: 'assistant',
          action: {
            type: 'shared-containers.open_invite',
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            containerType: 'CODE_WORKTREE',
          },
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'surface_unavailable', retryable: true },
      });
    });

    it('expands a collapsed project so the owning row can render the modal', async () => {
      useProjectsStore.setState({
        projects: [makeWorkspace({ collapsed: true })],
        hasHydratedProjects: true,
      });

      const acknowledge = (event: Event): void => event.preventDefault();
      window.addEventListener(OPEN_SHARED_CONTAINER_INVITE_EVENT, acknowledge);
      const response = await dispatchAppAction({
        requestId: 'req-shared-container-open-collapsed',
        source: 'assistant',
        action: {
          type: 'shared-containers.open_invite',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          containerType: 'CODE_WORKTREE',
        },
      });
      window.removeEventListener(
        OPEN_SHARED_CONTAINER_INVITE_EVENT,
        acknowledge,
      );

      expect(response.ok).toBe(true);
      // A collapsed workspace only keeps its selected row mounted, so without
      // the expand the store request would have had no row to render into.
      expect(
        useProjectsStore
          .getState()
          .projects.find((project) => project.id === 'project-1')?.collapsed,
      ).toBe(false);
    });

    it('refuses an unknown worktree without opening anything', async () => {
      useProjectsStore.setState({
        projects: [makeWorkspace()],
        hasHydratedProjects: true,
      });

      const response = await dispatchAppAction({
        requestId: 'req-shared-container-open-missing',
        source: 'assistant',
        action: {
          type: 'shared-containers.open_invite',
          projectId: 'project-1',
          worktreeId: 'worktree-nope',
          containerType: 'CODE_WORKTREE',
        },
      });

      expect(response.ok).toBe(false);
    });

    it('refuses a cowork container type against a git project', async () => {
      useProjectsStore.setState({
        projects: [makeWorkspace()],
        hasHydratedProjects: true,
      });

      const response = await dispatchAppAction({
        requestId: 'req-shared-container-open-wrong-type',
        source: 'assistant',
        action: {
          type: 'shared-containers.open_invite',
          projectId: 'project-1',
          worktreeId: 'entry-1',
          containerType: 'COWORK_WORK_ENTRY',
        },
      });

      expect(response.ok).toBe(false);
    });

    it('opens recipient-revocation confirmation without mutating access', async () => {
      const acceptConfirmation = (event: Event): void => {
        event.preventDefault();
      };
      window.addEventListener(
        OPEN_SHARED_CONTAINER_REVOCATION_CONFIRMATION_EVENT,
        acceptConfirmation,
      );
      const response = await dispatchAppAction({
        requestId: 'req-shared-container-revoke',
        source: 'assistant',
        action: {
          type: 'shared-containers.revoke_recipient',
          containerId: 'container-1',
          recipientId: 'user-a',
          organizationId: 'org-1',
        },
      });
      window.removeEventListener(
        OPEN_SHARED_CONTAINER_REVOCATION_CONFIRMATION_EVENT,
        acceptConfirmation,
      );

      expect(response).toMatchObject({
        ok: true,
        result: { confirmationOpened: true },
      });
      expect(sharedContainersApiMock.revokeRecipient).not.toHaveBeenCalled();
    });

    it('opens a revoke confirmation for an email recipient of a personal container', async () => {
      let requested: unknown = null;
      const acceptConfirmation = (event: Event): void => {
        if (event instanceof CustomEvent) requested = event.detail;
        event.preventDefault();
      };
      window.addEventListener(
        OPEN_SHARED_CONTAINER_REVOCATION_CONFIRMATION_EVENT,
        acceptConfirmation,
      );
      const response = await dispatchAppAction({
        requestId: 'req-shared-container-revoke-email',
        source: 'assistant',
        action: {
          type: 'shared-containers.revoke_recipient',
          containerId: 'container-1',
          recipientId: 'grant-email',
        },
      });
      window.removeEventListener(
        OPEN_SHARED_CONTAINER_REVOCATION_CONFIRMATION_EVENT,
        acceptConfirmation,
      );

      expect(response).toMatchObject({
        ok: true,
        result: { confirmationOpened: true, organizationId: null },
      });
      expect(requested).toEqual({
        containerId: 'container-1',
        recipientId: 'grant-email',
      });
    });

    it('refuses new invites but preserves revoke confirmation when the feature flag is off', async () => {
      setSharedContainersFlag(false);
      useProjectsStore.setState({
        projects: [makeWorkspace()],
        hasHydratedProjects: true,
      });

      const open = await dispatchAppAction({
        requestId: 'req-shared-container-open-flag-off',
        source: 'assistant',
        action: {
          type: 'shared-containers.open_invite',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          containerType: 'CODE_WORKTREE',
        },
      });
      const acceptConfirmation = (event: Event): void => {
        event.preventDefault();
      };
      window.addEventListener(
        OPEN_SHARED_CONTAINER_REVOCATION_CONFIRMATION_EVENT,
        acceptConfirmation,
      );
      const revoke = await dispatchAppAction({
        requestId: 'req-shared-container-revoke-flag-off',
        source: 'assistant',
        action: {
          type: 'shared-containers.revoke_recipient',
          containerId: 'container-1',
          recipientId: 'user-a',
          organizationId: 'org-1',
        },
      });

      window.removeEventListener(
        OPEN_SHARED_CONTAINER_REVOCATION_CONFIRMATION_EVENT,
        acceptConfirmation,
      );

      expect(open.ok).toBe(false);
      expect(revoke.ok).toBe(true);
      expect(sharedContainersApiMock.revokeRecipient).not.toHaveBeenCalled();
    });
  });

  describe('canopy_portal feature flag gating', () => {
    function setPortalDisabled(): void {
      useFeatureFlagsStore.setState({
        snapshot: {
          ...getDefaultFeatureFlagSnapshot(),
          values: {
            ...getDefaultFeatureFlagSnapshot().values,
            'canopy-portal-enabled': false,
            'canopy-shared-claude-model-fable5': false,
          },
          status: 'ready',
          initialized: true,
          updatedAt: new Date().toISOString(),
          error: null,
        },
      });
    }

    /**
     * Toasts are filtered through `shouldShowInAppNotification`, which
     * inspects module-level prefs that are null in the test environment.
     * Spying on `addToast` directly gives a deterministic check that the
     * dispatcher emitted the documented copy without needing to prime
     * notification preferences.
     *
     * `jest.spyOn` returns the same spy on repeated calls for the same
     * property, so its history persists across tests. Clear it before
     * returning so each spec sees a fresh call ledger.
     */
    function spyOnAddToast(): jest.SpyInstance {
      const spy = jest.spyOn(useGitHubStore.getState(), 'addToast');
      spy.mockClear();
      return spy;
    }

    afterEach(() => {
      // Restore the original `addToast` implementation so subsequent
      // tests in the outer `describe` block do not see a sticky spy.
      jest.restoreAllMocks();
    });

    it('emits the disabled toast and skips opening the Portal modal when the flag is off', async () => {
      setPortalDisabled();
      const toastSpy = spyOnAddToast();

      const response = await dispatchAppAction({
        requestId: 'req-portal-open-disabled',
        source: 'ui',
        action: { type: 'canopy_portal.open' },
      });

      expect(response.ok).toBe(true);
      expect(response.result).toEqual({
        skipped: true,
        reason: 'canopy-portal-disabled',
      });
      // The navigation store must NOT have moved into the open state.
      expect(useNavigationStore.getState().canopyPortalOpen).toBe(false);
      expect(toastSpy).toHaveBeenCalledWith(
        CANOPY_PORTAL_DISABLED_TOAST,
        'info',
      );
    });

    it('emits the disabled toast and does not call canopyPortal.start when the flag is off', async () => {
      setPortalDisabled();
      const toastSpy = spyOnAddToast();

      const response = await dispatchAppAction({
        requestId: 'req-portal-start-disabled',
        source: 'ui',
        action: { type: 'canopy_portal.start' },
      });

      expect(response.ok).toBe(true);
      expect(response.result).toEqual({
        skipped: true,
        reason: 'canopy-portal-disabled',
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(window.api.canopyPortal.start).not.toHaveBeenCalled();
      expect(toastSpy).toHaveBeenCalledWith(
        CANOPY_PORTAL_DISABLED_TOAST,
        'info',
      );
    });

    it('emits the disabled toast and does not navigate to account settings when the flag is off', async () => {
      setPortalDisabled();
      const toastSpy = spyOnAddToast();

      const response = await dispatchAppAction({
        requestId: 'req-portal-open-account-settings-disabled',
        source: 'ui',
        action: { type: 'canopy_portal.open_account_settings' },
      });

      expect(response.ok).toBe(true);
      expect(response.result).toEqual({
        skipped: true,
        reason: 'canopy-portal-disabled',
      });
      expect(useNavigationStore.getState().settingsOpen).toBe(false);
      expect(toastSpy).toHaveBeenCalledWith(
        CANOPY_PORTAL_DISABLED_TOAST,
        'info',
      );
    });

    it('still calls canopyPortal.stop when the flag is off so users can clean up an in-flight session', async () => {
      setPortalDisabled();
      const toastSpy = spyOnAddToast();

      const response = await dispatchAppAction({
        requestId: 'req-portal-stop-disabled',
        source: 'ui',
        action: { type: 'canopy_portal.stop' },
      });

      expect(response.ok).toBe(true);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(window.api.canopyPortal.stop).toHaveBeenCalledTimes(1);
      // Stop must NOT trigger the disabled toast — the action is allowed
      // through so users can recover from a flipped-off feature flag.
      expect(toastSpy).not.toHaveBeenCalledWith(
        CANOPY_PORTAL_DISABLED_TOAST,
        expect.anything(),
      );
    });

    it('opens the Portal modal normally when the flag is on (default snapshot)', async () => {
      const toastSpy = spyOnAddToast();
      // Default snapshot from `beforeEach` has the flag enabled.
      const response = await dispatchAppAction({
        requestId: 'req-portal-open-enabled',
        source: 'ui',
        action: { type: 'canopy_portal.open' },
      });

      expect(response.ok).toBe(true);
      expect(useNavigationStore.getState().canopyPortalOpen).toBe(true);
      expect(toastSpy).not.toHaveBeenCalledWith(
        CANOPY_PORTAL_DISABLED_TOAST,
        expect.anything(),
      );
    });

    it('calls canopyPortal.start when the flag is on', async () => {
      const response = await dispatchAppAction({
        requestId: 'req-portal-start-enabled',
        source: 'ui',
        action: { type: 'canopy_portal.start' },
      });

      expect(response.ok).toBe(true);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(window.api.canopyPortal.start).toHaveBeenCalledWith();
    });
  });

  it('updates shared Collections from the requested local Collection while preserving linked custom skill identity', async () => {
    const collectionsApi = window.collections as unknown as {
      loadCollection: jest.Mock;
      getShared: jest.Mock;
      updateShared: jest.Mock<
        Promise<ShareOperationResult<SharedCollectionDetail>>,
        [UpdateSharedCollectionRequest]
      >;
    };
    const pluginsApi = window.plugins as unknown as {
      loadMarketplaces: jest.Mock;
    };
    collectionsApi.loadCollection.mockResolvedValue({
      id: 'local-collection',
      name: 'Replacement Collection',
      description: 'Replacement description',
      skills: [{ sourceId: 'custom:app', skillName: 'custom-skill' }],
      plugins: [],
      mcpServers: [],
    });
    collectionsApi.getShared.mockResolvedValue({
      id: 'shared-collection',
      name: 'Shared Collection',
      description: 'Remote',
      contentHash: 'sha256:collection',
      itemCounts: { skills: 0, plugins: 0, customSkills: 1 },
      shareScope: 'private',
      owner: { type: 'user', id: 'user-1', name: 'Owner' },
      createdBy: { id: 'user-1', name: 'Owner', email: 'owner@example.test' },
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-22T00:00:00.000Z',
      canUpdate: true,
      canDelete: true,
      rawCollection:
        '{"version":1,"name":"Shared Collection","description":"Remote","items":[]}',
      collection: {
        version: 1,
        name: 'Shared Collection',
        description: 'Remote',
        items: [
          {
            type: 'custom_skill',
            skillId: 'shared-skill-1',
            skill_name: 'custom-skill',
            contentHash: 'sha256:existing',
          },
        ],
      },
      customSkills: [],
    });
    collectionsApi.updateShared.mockImplementation(
      (request: UpdateSharedCollectionRequest) =>
        Promise.resolve({
          ok: true,
          value: {
            id: request.collectionId,
            name: 'Replacement Collection',
            description: 'Replacement description',
            contentHash: 'sha256:collection',
            itemCounts: { skills: 0, plugins: 0, customSkills: 1 },
            shareScope: 'private',
            owner: { type: 'user', id: 'user-1', name: 'Owner' },
            createdBy: {
              id: 'user-1',
              name: 'Owner',
              email: 'owner@example.test',
            },
            createdAt: '2026-05-21T00:00:00.000Z',
            updatedAt: '2026-05-22T00:00:00.000Z',
            canUpdate: true,
            canDelete: true,
            rawCollection: request.rawCollection,
            collection: JSON.parse(
              request.rawCollection,
            ) as SharedCollectionDetail['collection'],
            customSkills: [],
          },
        }),
    );
    skillsApiMock.loadSkills.mockResolvedValue({
      success: true,
      data: [
        {
          name: 'custom-skill',
          sourceId: 'custom:app',
          description: '',
          source: 'Custom',
          installedAt: '',
          updatedAt: '',
          updateAvailable: false,
          custom: true,
        },
      ],
    });
    pluginsApi.loadMarketplaces.mockResolvedValue({
      success: true,
      data: { version: 1, lastRefreshed: '', marketplaces: [] },
    });

    const response = await dispatchAppAction({
      requestId: 'req-collection-update-shared',
      source: 'assistant',
      action: {
        type: 'collections.update_shared',
        collectionId: 'shared-collection',
        id: 'local-collection',
      },
    });

    expect(response.ok).toBe(true);
    expect(collectionsApi.loadCollection).toHaveBeenCalledWith(
      'local-collection',
    );
    const request = collectionsApi.updateShared.mock.calls[0]?.[0];
    if (!request) throw new Error('updateShared was not called.');
    expect(request.customSkills).toBeUndefined();
    expect(request.expectedContentHash).toBe('sha256:collection');
    expect(skillsApiMock.readRawSkill).not.toHaveBeenCalled();
    expect(JSON.parse(request.rawCollection)).toEqual({
      version: 1,
      name: 'Replacement Collection',
      description: 'Replacement description',
      items: [
        {
          type: 'custom_skill',
          skillId: 'shared-skill-1',
          skill_name: 'custom-skill',
          contentHash: 'sha256:existing',
        },
      ],
    });
  });

  it('imports shared Collections with GitHub skill repos through canonical local source ids', async () => {
    const collectionsApi = window.collections as unknown as {
      getShared: jest.Mock;
      saveCollection: jest.Mock;
    };
    const pluginsApi = window.plugins as unknown as {
      addMarketplace: jest.Mock;
      installPlugin: jest.Mock;
      loadMarketplaces: jest.Mock;
      refreshMarketplaces: jest.Mock;
    };
    Object.assign(pluginsApi, {
      addMarketplace: jest.fn().mockResolvedValue({ success: true }),
      installPlugin: jest.fn().mockResolvedValue({ success: true }),
    });
    pluginsApi.loadMarketplaces.mockResolvedValue({
      success: true,
      data: { version: 1, lastRefreshed: '', marketplaces: [] },
    });
    pluginsApi.refreshMarketplaces.mockResolvedValue({
      success: true,
      data: {
        version: 1,
        lastRefreshed: '',
        marketplaces: [
          {
            id: 'market-1',
            name: 'Marketplace',
            description: '',
            sourceType: 'github',
            sourceUrl: 'https://github.com/owner/plugins',
            installLocation: '',
            lastUpdated: '',
            pluginCount: 1,
            plugins: [
              {
                name: 'Remote Plugin',
                description: '',
                version: '',
                homepage: '',
                sourcePath: '',
                marketplaceId: 'market-1',
                details: null,
                externalSource: {
                  url: 'https://github.com/owner/remote-plugin',
                },
                cachePath: null,
                cachedAt: null,
              },
            ],
          },
        ],
      },
    });
    collectionsApi.getShared.mockResolvedValue({
      id: 'shared-collection',
      name: 'Shared Collection',
      description: 'Remote',
      contentHash: 'sha256:collection',
      itemCounts: { skills: 1, plugins: 1, customSkills: 0 },
      shareScope: 'private',
      owner: { type: 'user', id: 'user-1', name: 'Owner' },
      createdBy: { id: 'user-1', name: 'Owner', email: 'owner@example.test' },
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-22T00:00:00.000Z',
      canUpdate: true,
      canDelete: true,
      rawCollection:
        '{"version":1,"name":"Shared Collection","description":"Remote","items":[]}',
      collection: {
        version: 1,
        name: 'Shared Collection',
        description: 'Remote',
        items: [
          {
            type: 'skill',
            source: { type: 'github', repo: 'owner/skills' },
            skill_name: 'review-helper',
          },
          {
            type: 'claude_plugin',
            marketplace: { type: 'github', repo: 'owner/plugins' },
            plugin_name: 'Remote Plugin',
          },
        ],
      },
      customSkills: [],
    });
    collectionsApi.saveCollection.mockResolvedValue({
      id: 'local-collection',
      name: 'Shared Collection',
    });

    const response = await dispatchAppAction({
      requestId: 'req-collection-import-shared',
      source: 'assistant',
      action: {
        type: 'collections.import_shared',
        collectionId: 'shared-collection',
      },
    });

    expect(response.ok).toBe(true);
    expect(skillsApiMock.installSkills).toHaveBeenCalledWith('owner/skills', [
      'review-helper',
    ]);
    expect(pluginsApi.addMarketplace).toHaveBeenCalledWith('owner/plugins');
    expect(pluginsApi.refreshMarketplaces).toHaveBeenCalled();
    expect(pluginsApi.installPlugin).toHaveBeenCalledWith(
      'market-1',
      'Remote Plugin',
      'https://github.com/owner/remote-plugin',
    );
    expect(collectionsApi.saveCollection).toHaveBeenCalledWith(
      expect.objectContaining({
        skills: [
          { sourceId: 'github:owner:skills', skillName: 'review-helper' },
        ],
        plugins: [{ marketplaceId: 'market-1', pluginName: 'Remote Plugin' }],
      }),
    );
  });

  it('dispatches shared skill App Advisor actions through preload APIs', async () => {
    skillsApiMock.listShared.mockResolvedValue({
      skills: [
        {
          id: 'shared-skill',
          name: 'custom-skill',
          description: '',
          contentHash: 'sha256:abc',
          shareScope: 'private',
          owner: { type: 'user', id: 'user-1', name: 'Owner' },
          createdBy: {
            id: 'user-1',
            name: 'Owner',
            email: 'owner@example.test',
          },
          createdAt: '2026-05-22T00:00:00.000Z',
          updatedAt: '2026-05-22T00:00:00.000Z',
          canUpdate: true,
          canDelete: true,
        },
      ],
    });

    const list = await dispatchAppAction({
      requestId: 'req-skills-list-shared',
      source: 'assistant',
      action: {
        type: 'skills.list_shared',
        query: 'custom',
        limit: 25,
        cursor: 'next-page',
        createdBy: 'me',
      },
    });
    const read = await dispatchAppAction({
      requestId: 'req-skills-read-shared',
      source: 'assistant',
      action: {
        type: 'skills.read_shared',
        skillId: 'shared-skill',
      },
    });
    const update = await dispatchAppAction({
      requestId: 'req-skills-update-shared',
      source: 'assistant',
      action: {
        type: 'skills.update_shared',
        skillId: 'shared-skill',
        name: 'custom-skill',
      },
    });

    expect(list.ok).toBe(true);
    expect(skillsApiMock.listShared).toHaveBeenCalledWith({
      query: 'custom',
      limit: 25,
      cursor: 'next-page',
      createdBy: 'me',
    });
    expect(read).toMatchObject({
      ok: true,
      result: { id: 'shared-skill', name: 'custom-skill' },
    });
    expect(skillsApiMock.getShared).toHaveBeenCalledWith('shared-skill');
    expect(update.ok).toBe(true);
    expect(update).toMatchObject({
      result: {
        agentArtifacts: [
          {
            kind: 'skill',
            owner: { type: 'user', id: 'user-1', name: 'Owner' },
            canUpdate: true,
          },
        ],
      },
    });
    expect(skillsApiMock.readRawSkill).toHaveBeenCalledWith(
      'custom:app/custom-skill',
    );
    expect(skillsApiMock.updateShared).toHaveBeenCalledWith({
      skillId: 'shared-skill',
      rawSkill: '---\nname: custom-skill\n---\n',
      expectedContentHash: 'sha256:abc',
    });
  });

  it('dispatches Agent App Advisor actions through preload APIs', async () => {
    const publicShareChanged = jest.fn();
    window.addEventListener(
      AGENT_PUBLIC_SHARE_CHANGED_EVENT,
      publicShareChanged,
    );
    agentsApiMock.list.mockResolvedValue({
      agents: [
        {
          id: 'agent_model_code_reviewer',
          name: 'Code Reviewer',
          baseModel: 'opus',
          instructions: 'Review code.',
          pluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
          },
          createdAt: '2026-07-03T00:00:00.000Z',
          updatedAt: '2026-07-03T00:00:00.000Z',
        },
      ],
    });
    agentsApiMock.get.mockResolvedValue({
      id: 'agent_model_code_reviewer',
      name: 'Code Reviewer',
      baseModel: 'opus',
      instructions: 'Review code.',
      pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      createdAt: '2026-07-03T00:00:00.000Z',
      updatedAt: '2026-07-03T00:00:00.000Z',
    });
    agentsApiMock.listShared.mockResolvedValue({
      agents: [
        {
          id: 'shared-agent',
          name: 'Shared Reviewer',
          modelId: 'agent_model_shared_reviewer',
          baseModel: 'opus',
          instructionsPreview: 'Review.',
          contentHash: 'sha256:abc',
          shareScope: 'private',
          owner: { type: 'user', id: 'user-1', name: 'Owner' },
          createdBy: {
            id: 'user-1',
            name: 'Owner',
            email: 'owner@example.test',
          },
          createdAt: '2026-07-03T00:00:00.000Z',
          updatedAt: '2026-07-03T00:00:00.000Z',
          canUpdate: true,
          canDelete: true,
        },
      ],
    });
    agentsApiMock.publishPublicShare.mockResolvedValue({
      externalId: 'public-share-1',
      pinnedContentHash: 'sha256:abc',
      upToDate: true,
      sharePath: '/share/agents/public-share-1',
      createdAt: '2026-07-03T00:00:00.000Z',
      updatedAt: '2026-07-03T00:00:00.000Z',
    });

    const list = await dispatchAppAction({
      requestId: 'req-agents-list',
      source: 'assistant',
      action: { type: 'agents.list', query: 'review' },
    });
    const create = await dispatchAppAction({
      requestId: 'req-agents-create',
      source: 'assistant',
      action: {
        type: 'agents.create',
        name: 'Code Reviewer',
        baseModel: 'opus',
        instructions: 'Review code.',
      },
    });
    const update = await dispatchAppAction({
      requestId: 'req-agents-update',
      source: 'assistant',
      action: {
        type: 'agents.update',
        id: 'agent_model_code_reviewer',
        instructions: 'Review code and tests.',
      },
    });
    const listShared = await dispatchAppAction({
      requestId: 'req-agents-list-shared',
      source: 'assistant',
      action: { type: 'agents.list_shared', query: 'review' },
    });
    const imported = await dispatchAppAction({
      requestId: 'req-agents-import-shared',
      source: 'assistant',
      action: { type: 'agents.import_shared', agentId: 'shared-agent' },
    });
    const deleteShared = await dispatchAppAction({
      requestId: 'req-agents-delete-shared',
      source: 'assistant',
      action: { type: 'agents.delete_shared', agentId: 'shared-agent' },
    });
    const publishedPublic = await dispatchAppAction({
      requestId: 'req-agents-publish-public',
      source: 'assistant',
      action: {
        type: 'agents.publish_public_share',
        agentId: 'shared-agent',
      },
    });
    const revokedPublic = await dispatchAppAction({
      requestId: 'req-agents-revoke-public',
      source: 'assistant',
      action: {
        type: 'agents.revoke_public_share',
        agentId: 'shared-agent',
      },
    });
    const deleted = await dispatchAppAction({
      requestId: 'req-agents-delete',
      source: 'assistant',
      action: { type: 'agents.delete', id: 'agent_model_code_reviewer' },
    });

    expect(list.ok).toBe(true);
    expect(create.ok).toBe(true);
    expect(update.ok).toBe(true);
    expect(listShared.ok).toBe(true);
    expect(imported.ok).toBe(true);
    expect(deleteShared.ok).toBe(true);
    expect(publishedPublic.ok).toBe(true);
    expect(revokedPublic.ok).toBe(true);
    expect(publicShareChanged).toHaveBeenCalledTimes(2);
    expect(publishedPublic).toMatchObject({
      result: {
        publicShare: {
          externalId: 'public-share-1',
          sharePath: '/share/agents/public-share-1',
        },
      },
    });
    window.removeEventListener(
      AGENT_PUBLIC_SHARE_CHANGED_EVENT,
      publicShareChanged,
    );
    expect(deleted.ok).toBe(true);
    const createRequest = agentsApiMock.save.mock.calls[0]?.[0] as
      | SaveAgentModelRequest
      | undefined;
    const updateRequest = agentsApiMock.save.mock.calls[1]?.[0] as
      | SaveAgentModelRequest
      | undefined;
    expect(createRequest).toMatchObject({
      name: 'Code Reviewer',
      baseModel: 'opus',
      instructions: 'Review code.',
    });
    expect(createRequest?.pluginSelections.collectionIds).toEqual([]);
    expect(createRequest?.pluginSelections.skillRefs).toEqual([]);
    expect(createRequest?.pluginSelections.pluginRefs).toEqual([]);
    expect(updateRequest).toMatchObject({
      id: 'agent_model_code_reviewer',
      name: 'Code Reviewer',
      baseModel: 'opus',
      instructions: 'Review code and tests.',
    });
    expect(updateRequest?.pluginSelections.collectionIds).toEqual([]);
    expect(updateRequest?.pluginSelections.skillRefs).toEqual([]);
    expect(updateRequest?.pluginSelections.pluginRefs).toEqual([]);
    expect(agentsApiMock.listShared).toHaveBeenCalledWith({ query: 'review' });
    expect(agentsApiMock.importShared).toHaveBeenCalledWith({
      agentId: 'shared-agent',
      installMissing: true,
    });
    expect(agentsApiMock.deleteShared).toHaveBeenCalledWith({
      agentId: 'shared-agent',
    });
    expect(agentsApiMock.publishPublicShare).toHaveBeenCalledWith(
      'shared-agent',
    );
    expect(agentsApiMock.revokePublicShare).toHaveBeenCalledWith(
      'shared-agent',
    );
    expect(agentsApiMock.delete).toHaveBeenCalledWith({
      id: 'agent_model_code_reviewer',
    });
  });

  it('returns Collection-aware delete-conflict copy for shared skill delete actions', async () => {
    skillsApiMock.deleteShared.mockRejectedValue(
      Object.assign(new Error('Skill is referenced by collections'), {
        code: 'http-error',
        status: 409,
      }),
    );

    const response = await dispatchAppAction({
      requestId: 'req-skills-delete-shared',
      source: 'assistant',
      action: {
        type: 'skills.delete_shared',
        skillId: 'shared-skill',
      },
    });

    expect(response.ok).toBe(false);
    expect(response.error?.message).toContain(
      'Remove it from those Collections before deleting it.',
    );
  });

  it('maps unsupported shared skill and Collection capabilities for App Advisor actions', async () => {
    skillsApiMock.listShared.mockRejectedValue(
      Object.assign(new Error('missing capability'), {
        code: 'unsupported-capability',
      }),
    );
    const collectionsApi = window.collections as unknown as {
      listShared: jest.Mock;
    };
    collectionsApi.listShared.mockRejectedValue(
      Object.assign(new Error('missing capability'), {
        code: 'unsupported-capability',
      }),
    );

    const skillResponse = await dispatchAppAction({
      requestId: 'req-skills-unsupported',
      source: 'assistant',
      action: { type: 'skills.list_shared' },
    });
    const collectionResponse = await dispatchAppAction({
      requestId: 'req-collections-unsupported',
      source: 'assistant',
      action: { type: 'collections.list_shared' },
    });

    expect(skillResponse.ok).toBe(false);
    expect(skillResponse.error?.message).toBe(
      'Canopy Cloud does not support shared skills.',
    );
    expect(collectionResponse.ok).toBe(false);
    expect(collectionResponse.error?.message).toBe(
      'Canopy Cloud does not support shared collections.',
    );
  });

  describe('automation.* actions', () => {
    it('automation.open_shared_pipeline_review navigates without approving', async () => {
      const response = await dispatchAppAction({
        requestId: 'req-open-shared-pipeline-review',
        source: 'assistant',
        action: {
          type: 'automation.open_shared_pipeline_review',
          id: 'activity-1',
        },
      });

      expect(response).toMatchObject({
        ok: true,
        result: { activityId: 'activity-1' },
      });
      expect(useNavigationStore.getState()).toMatchObject({
        activePage: 'workflows-library',
        pendingAutomationSharedPipelineReview: {
          activityId: 'activity-1',
        },
      });
      expect(automationsApiMock.update).not.toHaveBeenCalled();
      expect(automationsApiMock.runNow).not.toHaveBeenCalled();
    });

    it('automation.list returns the AutomationsListResponse snapshot including scheduled messages', async () => {
      automationsApiMock.list.mockResolvedValueOnce({
        activities: [
          {
            id: 'a',
            sharedPipelineReview: {
              detectedAt: '2026-09-26T12:00:00.000Z',
              remoteId: 'pipeline-1',
              pipelineName: 'Nightly checks',
            },
          },
          {
            id: 'scheduled-message',
            action: {
              type: 'worktree_session_prompt',
              workspaceId: 'workspace-1',
              worktreeId: 'worktree-1',
              chatId: 'chat-1',
              prompt: 'Continue later',
              purpose: 'scheduled_send',
            },
          },
        ],
        recentRuns: [{ id: 'r' }],
      });
      const response = await dispatchAppAction({
        requestId: 'req-list',
        source: 'assistant',
        action: { type: 'automation.list' },
      });
      expect(response.ok).toBe(true);
      expect(response.result).toEqual({
        activities: [
          {
            id: 'a',
            sharedPipelineReview: {
              detectedAt: '2026-09-26T12:00:00.000Z',
              remoteId: 'pipeline-1',
              pipelineName: 'Nightly checks',
            },
          },
          {
            id: 'scheduled-message',
            action: {
              type: 'worktree_session_prompt',
              workspaceId: 'workspace-1',
              worktreeId: 'worktree-1',
              chatId: 'chat-1',
              prompt: 'Continue later',
              purpose: 'scheduled_send',
            },
          },
        ],
        recentRuns: [{ id: 'r' }],
      });
    });

    it('automation.list omits run history when includeRuns is false', async () => {
      automationsApiMock.list.mockResolvedValueOnce({
        activities: [{ id: 'a' }],
        recentRuns: [{ id: 'r' }],
      });
      const response = await dispatchAppAction({
        requestId: 'req-list-no-runs',
        source: 'assistant',
        action: { type: 'automation.list', includeRuns: false },
      });
      expect(response.ok).toBe(true);
      expect(response.result).toEqual({
        activities: [{ id: 'a' }],
      });
    });

    it('automation.list asks main for the selected context only (CAN-3448)', async () => {
      const scoped = {
        activities: [
          {
            id: 'org',
            action: {
              type: 'worktree_prompt',
              workspaceId: 'org-project',
              prompt: 'Check',
            },
          },
        ],
        recentRuns: [{ id: 'r-org', activityId: 'org' }],
      };
      automationsApiMock.list.mockResolvedValue(scoped);
      const response = await dispatchAppAction({
        requestId: 'req-list-scoped',
        source: 'assistant',
        action: { type: 'automation.list' },
      });
      expect(response).toMatchObject({ ok: true, result: scoped });
      expect(automationsApiMock.list).toHaveBeenLastCalledWith({
        scope: 'selected-context',
      });
      const withoutRuns = await dispatchAppAction({
        requestId: 'req-list-scoped-no-runs',
        source: 'assistant',
        action: { type: 'automation.list', includeRuns: false },
      });
      expect(withoutRuns.ok).toBe(true);
      expect(withoutRuns.result).toEqual({ activities: scoped.activities });
    });

    it('automation.get returns one activity with matching runs, including scheduled message details', async () => {
      automationsApiMock.list.mockResolvedValueOnce({
        activities: [
          {
            id: 'a',
            action: {
              type: 'worktree_session_prompt',
              workspaceId: 'workspace-1',
              worktreeId: 'worktree-1',
              chatId: 'chat-1',
              prompt: 'Continue later',
              purpose: 'scheduled_send',
            },
          },
          { id: 'b' },
        ],
        recentRuns: [
          { id: 'r1', activityId: 'a' },
          { id: 'r2', activityId: 'b' },
        ],
      });
      const response = await dispatchAppAction({
        requestId: 'req-get-automation',
        source: 'assistant',
        action: { type: 'automation.get', id: 'a' },
      });
      expect(response.ok).toBe(true);
      expect(response.result).toEqual({
        activity: {
          id: 'a',
          action: {
            type: 'worktree_session_prompt',
            workspaceId: 'workspace-1',
            worktreeId: 'worktree-1',
            chatId: 'chat-1',
            prompt: 'Continue later',
            purpose: 'scheduled_send',
          },
        },
        recentRuns: [{ id: 'r1', activityId: 'a' }],
      });
    });

    it('automation.share builds the portable document and forwards it to createShared', async () => {
      automationsApiMock.list.mockResolvedValueOnce({
        activities: [
          {
            version: 1,
            id: 'activity-share',
            name: 'Nightly triage',
            enabled: true,
            schedule: {
              kind: 'cron',
              expression: '0 2 * * *',
              timezone: 'local',
            },
            action: { type: 'app_advisor_prompt', prompt: 'Triage.' },
            createdAt: '2026-08-19T00:00:00.000Z',
            updatedAt: '2026-08-19T00:00:00.000Z',
            failureCount: 0,
            ifCommand: 'test -f ready',
          },
        ],
        recentRuns: [],
      });
      automationsApiMock.createShared.mockResolvedValueOnce({
        id: 'shared-automation-1',
        contentHash: 'a'.repeat(64),
        shareScope: 'team',
      });

      const response = await dispatchAppAction({
        requestId: 'req-automation-share',
        source: 'assistant',
        action: {
          type: 'automation.share',
          id: 'activity-share',
          shareScope: 'team',
          teamId: 'team-1',
          description: 'Runs triage nightly.',
        },
      });

      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({
        id: 'shared-automation-1',
        shareScope: 'team',
      });
      expect(automationsApiMock.createShared).toHaveBeenCalledWith({
        activityId: 'activity-share',
        automation: expect.objectContaining({
          version: 1,
          name: 'Nightly triage',
          description: 'Runs triage nightly.',
          hasRunCondition: true,
        }) as unknown,
        shareScope: 'team',
        teamId: 'team-1',
      });
      const sentDocument = JSON.stringify(
        automationsApiMock.createShared.mock.calls[0]?.[0],
      );
      expect(sentDocument).not.toContain('test -f ready');
    });

    it.each<[string, Record<string, unknown>]>([
      [
        'stored pipeline dependencies',
        {
          action: { type: 'app_advisor_prompt', prompt: 'Triage.' },
          dependencies: {
            pipelines: [{ pipelineId: 'pipeline-1', source: 'user' }],
          },
        },
      ],
      [
        'a user pipeline action',
        {
          action: {
            type: 'worktree_pipeline',
            workspaceId: 'workspace-1',
            pipelineId: 'pipeline-1',
            pipelineSource: 'user',
            inputs: {},
          },
        },
      ],
      [
        'a project pipeline action',
        {
          action: {
            type: 'worktree_pipeline',
            workspaceId: 'workspace-1',
            pipelineId: 'pipeline-1',
            pipelineSource: 'project',
            inputs: {},
          },
        },
      ],
      [
        'a pipeline ID in the prompt',
        {
          action: {
            type: 'app_advisor_prompt',
            prompt: 'Run pipeline 3F2504E0-4F89-41D3-9A0C-0305E82C3301 daily.',
          },
        },
      ],
    ])(
      'automation.share refuses an automation with %s',
      async (_label, fields) => {
        automationsApiMock.createShared.mockClear();
        automationsApiMock.list.mockResolvedValueOnce({
          activities: [
            {
              version: 1,
              id: 'activity-pipelines',
              name: 'Journey specialist',
              enabled: true,
              schedule: {
                kind: 'cron',
                expression: '0 2 * * *',
                timezone: 'local',
              },
              createdAt: '2026-08-19T00:00:00.000Z',
              updatedAt: '2026-08-19T00:00:00.000Z',
              failureCount: 0,
              ...fields,
            },
          ],
          recentRuns: [],
        });

        const response = await dispatchAppAction({
          requestId: 'req-automation-share-pipelines',
          source: 'assistant',
          action: {
            type: 'automation.share',
            id: 'activity-pipelines',
            shareScope: 'team',
            teamId: 'team-1',
          },
        });

        expect(response.ok).toBe(false);
        expect(response.error).toMatchObject({
          code: 'execution_failed',
          retryable: false,
          message: expect.stringContaining(
            'use Share so its pipelines can be included',
          ) as unknown,
        });
        expect(automationsApiMock.createShared).not.toHaveBeenCalled();
      },
    );

    it('automation.share never invites a retry of an uncertain publication', async () => {
      automationsApiMock.list.mockResolvedValueOnce({
        activities: [
          {
            version: 1,
            id: 'activity-uncertain',
            name: 'Nightly triage',
            enabled: true,
            schedule: {
              kind: 'cron',
              expression: '0 2 * * *',
              timezone: 'local',
            },
            action: { type: 'app_advisor_prompt', prompt: 'Triage.' },
            createdAt: '2026-08-19T00:00:00.000Z',
            updatedAt: '2026-08-19T00:00:00.000Z',
            failureCount: 0,
          },
        ],
        recentRuns: [],
      });
      jest.spyOn(window.api.automations, 'createShared').mockResolvedValueOnce({
        ok: false,
        failure: {
          version: 1,
          kind: 'connection',
          stage: 'publish',
          message: "Couldn't reach the cloud.",
          commitState: 'unknown',
          retryable: false,
        },
      });

      const response = await dispatchAppAction({
        requestId: 'req-automation-share-uncertain',
        source: 'assistant',
        action: {
          type: 'automation.share',
          id: 'activity-uncertain',
          shareScope: 'team',
          teamId: 'team-1',
        },
      });

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'execution_failed',
          message:
            "Couldn't confirm whether this automation was shared. Check its current sharing status before trying again.",
          retryable: false,
        },
      });
    });

    it('automation.share shares an automation with an approval mode and reports the mode stayed behind', async () => {
      automationsApiMock.list.mockResolvedValueOnce({
        activities: [
          {
            version: 1,
            id: 'activity-approval-mode-share',
            name: 'Inbox sweep',
            enabled: true,
            schedule: {
              kind: 'cron',
              expression: '0 2 * * *',
              timezone: 'local',
            },
            action: {
              type: 'standalone_prompt',
              chatProjectId: 'cowork-1',
              prompt: 'Sweep the inbox.',
              approvalMode: 'full-access',
            },
            createdAt: '2026-08-19T00:00:00.000Z',
            updatedAt: '2026-08-19T00:00:00.000Z',
            failureCount: 0,
          },
        ],
        recentRuns: [],
      });
      automationsApiMock.createShared.mockResolvedValueOnce({
        id: 'shared-automation-approval-mode',
        contentHash: 'a'.repeat(64),
        shareScope: 'team',
      });

      const response = await dispatchAppAction({
        requestId: 'req-automation-share-approval-mode',
        source: 'assistant',
        action: {
          type: 'automation.share',
          id: 'activity-approval-mode-share',
          shareScope: 'team',
          teamId: 'team-1',
        },
      });

      expect(response.error).toBeUndefined();
      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({
        id: 'shared-automation-approval-mode',
        notices: expect.arrayContaining([
          expect.stringContaining('The approval mode stays on this machine'),
        ]) as unknown,
      });
      const sent = automationsApiMock.createShared.mock.calls.find(
        ([request]) => request.activityId === 'activity-approval-mode-share',
      )?.[0];
      expect(sent?.automation.action).toEqual({
        type: 'standalone_prompt',
        target: { kind: 'cowork' },
        prompt: 'Sweep the inbox.',
        plugins: [],
      });
      expect(JSON.stringify(sent)).not.toContain('full-access');
    });

    // The Share dialog packages a user pipeline with its children and files;
    // the agent path cannot, so it refuses before reading the pipeline.
    it('automation.share leaves a referenced user pipeline to the Share dialog', async () => {
      automationsApiMock.createShared.mockClear();
      pipelinesApiMock.list.mockClear();
      pipelinesApiMock.get.mockClear();
      automationsApiMock.list.mockResolvedValueOnce({
        activities: [
          {
            version: 1,
            id: 'activity-pipeline-share',
            name: 'Nightly pipeline',
            enabled: true,
            schedule: {
              kind: 'cron',
              expression: '0 2 * * *',
              timezone: 'local',
            },
            action: {
              type: 'worktree_pipeline',
              workspaceId: 'workspace-1',
              pipelineId: 'user-review',
              pipelineSource: 'user',
              pipelineName: 'User review',
            },
            createdAt: '2026-08-19T00:00:00.000Z',
            updatedAt: '2026-08-19T00:00:00.000Z',
            failureCount: 0,
          },
        ],
        recentRuns: [],
      });
      const response = await dispatchAppAction({
        requestId: 'req-automation-pipeline-share',
        source: 'assistant',
        action: {
          type: 'automation.share',
          id: 'activity-pipeline-share',
          shareScope: 'organization',
          organizationId: 'org-1',
        },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.message).toContain(
        'use Share so its pipelines can be included',
      );
      expect(pipelinesApiMock.list).not.toHaveBeenCalled();
      expect(pipelinesApiMock.get).not.toHaveBeenCalled();
      expect(automationsApiMock.createShared).not.toHaveBeenCalled();
    });

    it('automation.share refuses a pipeline destination the sharing server cannot carry', async () => {
      automationsApiMock.createShared.mockClear();
      automationsApiMock.list.mockResolvedValueOnce({
        activities: [
          {
            version: 1,
            id: 'activity-destination-share',
            name: 'Folder pipeline',
            enabled: true,
            schedule: {
              kind: 'cron',
              expression: '0 2 * * *',
              timezone: 'local',
            },
            action: {
              type: 'worktree_pipeline',
              workspaceId: 'workspace-1',
              target: { kind: 'project' },
              pipelineId: 'bundled-review',
              pipelineSource: 'bundled',
              pipelineName: 'Bundled review',
            },
            createdAt: '2026-08-19T00:00:00.000Z',
            updatedAt: '2026-08-19T00:00:00.000Z',
            failureCount: 0,
          },
        ],
        recentRuns: [],
      });
      const info = {
        id: 'bundled-review',
        name: 'Bundled review',
        filename: 'bundled-review.yaml',
        description: '',
        icon: '',
        createdAt: '2026-08-19T00:00:00.000Z',
        updatedAt: '2026-08-19T00:00:00.000Z',
        source: 'bundled',
        readonly: true,
      };
      pipelinesApiMock.list.mockResolvedValueOnce({
        success: true,
        data: [info],
      });
      pipelinesApiMock.get.mockResolvedValueOnce({
        success: true,
        data: {
          info,
          content: { name: 'Bundled review', on: 'dispatch', jobs: {} },
        },
      });
      loadCanopyCloudAccountMock.mockResolvedValueOnce({
        hasApiKey: true,
        capabilities: [
          'automations-crud-v1',
          'automations-target-requirements-v3',
        ],
      });

      const response = await dispatchAppAction({
        requestId: 'req-automation-destination-share',
        source: 'assistant',
        action: {
          type: 'automation.share',
          id: 'activity-destination-share',
          shareScope: 'organization',
          organizationId: 'org-1',
        },
      });

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'execution_failed',
          message:
            'Update the sharing server to share this workflow destination.',
        },
      });
      expect(automationsApiMock.createShared).not.toHaveBeenCalled();
    });

    it('automation.share downgrades a session-bound activity instead of refusing it', async () => {
      automationsApiMock.createShared.mockClear();
      automationsApiMock.list.mockResolvedValueOnce({
        activities: [
          {
            version: 1,
            id: 'activity-bound',
            name: 'Resume chat',
            enabled: true,
            schedule: {
              kind: 'one_time',
              runAt: '2027-01-01T00:00:00.000Z',
              timezone: 'local',
            },
            action: {
              type: 'worktree_session_prompt',
              workspaceId: 'ws-1',
              worktreeId: 'wt-1',
              chatId: 'chat-1',
              prompt: 'Continue.',
              attachmentPaths: ['/Users/me/secret.pdf'],
            },
            createdAt: '2026-08-19T00:00:00.000Z',
            updatedAt: '2026-08-19T00:00:00.000Z',
            failureCount: 0,
          },
        ],
        recentRuns: [],
      });
      automationsApiMock.createShared.mockResolvedValueOnce({
        id: 'shared-automation-downgraded',
        contentHash: 'b'.repeat(64),
        shareScope: 'private',
      });

      const response = await dispatchAppAction({
        requestId: 'req-automation-share-downgraded',
        source: 'assistant',
        action: {
          type: 'automation.share',
          id: 'activity-bound',
          shareScope: 'organization',
          organizationId: 'org-1',
        },
      });

      expect(response.ok).toBe(true);
      expect(automationsApiMock.createShared).toHaveBeenCalledTimes(1);
      const sent = automationsApiMock.createShared.mock.calls[0]?.[0];
      const sentDocument = JSON.stringify(sent);
      // The chat, worktree, and attachment bindings are machine-local and
      // must never reach the wire.
      expect(sentDocument).not.toContain('chat-1');
      expect(sentDocument).not.toContain('wt-1');
      expect(sentDocument).not.toContain('secret.pdf');
      expect(sentDocument).toContain('"type":"worktree_prompt"');
      // The author is told what stayed behind rather than being refused.
      expect(JSON.stringify(response.result)).toContain(
        'The original chat and its history stay on this machine',
      );
    });

    // CAN-3734: the App Advisor share path must preserve a Cowork session's
    // destination, exactly like the Automations page share modal.
    it('automation.share keeps a Cowork-bound session prompt in Cowork', async () => {
      loadProjectsApiMock.mockResolvedValue({
        version: 1,
        items: [{ id: 'cowork-1', type: 'cowork', worktrees: [] }],
      });
      automationsApiMock.createShared.mockClear();
      automationsApiMock.list.mockResolvedValueOnce({
        activities: [
          {
            version: 1,
            id: 'activity-cowork',
            name: 'Hourly CI blame',
            enabled: true,
            schedule: {
              kind: 'cron',
              expression: '0 * * * *',
              timezone: 'local',
            },
            action: {
              type: 'worktree_session_prompt',
              workspaceId: 'cowork-1',
              worktreeId: 'cowork-home',
              chatId: 'chat-1',
              prompt: 'Check #feed-canopy-ci.',
            },
            createdAt: '2026-08-19T00:00:00.000Z',
            updatedAt: '2026-08-19T00:00:00.000Z',
            failureCount: 0,
          },
        ],
        recentRuns: [],
      });
      automationsApiMock.createShared.mockResolvedValueOnce({
        id: 'shared-automation-cowork',
        contentHash: 'b'.repeat(64),
        shareScope: 'organization',
      });

      const response = await dispatchAppAction({
        requestId: 'req-automation-share-cowork',
        source: 'assistant',
        action: {
          type: 'automation.share',
          id: 'activity-cowork',
          shareScope: 'organization',
          organizationId: 'org-1',
        },
      });

      expect(response.ok).toBe(true);
      const sentDocument = JSON.stringify(
        automationsApiMock.createShared.mock.calls[0]?.[0],
      );
      expect(sentDocument).toContain('"type":"standalone_prompt"');
      expect(sentDocument).toContain('"kind":"cowork"');
      expect(sentDocument).not.toContain('worktree_prompt');
    });

    it('automation.share refuses a session prompt whose project is gone', async () => {
      loadProjectsApiMock.mockResolvedValue({ version: 1, items: [] });
      automationsApiMock.createShared.mockClear();
      automationsApiMock.list.mockResolvedValueOnce({
        activities: [
          {
            version: 1,
            id: 'activity-orphan',
            name: 'Orphaned',
            enabled: false,
            schedule: {
              kind: 'cron',
              expression: '0 * * * *',
              timezone: 'local',
            },
            action: {
              type: 'worktree_session_prompt',
              workspaceId: 'deleted',
              worktreeId: 'wt-1',
              chatId: 'chat-1',
              prompt: 'Continue.',
            },
            createdAt: '2026-08-19T00:00:00.000Z',
            updatedAt: '2026-08-19T00:00:00.000Z',
            failureCount: 0,
          },
        ],
        recentRuns: [],
      });

      const response = await dispatchAppAction({
        requestId: 'req-automation-share-orphan',
        source: 'assistant',
        action: {
          type: 'automation.share',
          id: 'activity-orphan',
          shareScope: 'organization',
          organizationId: 'org-1',
        },
      });

      expect(response.ok).toBe(false);
      expect(JSON.stringify(response.error)).toContain(
        'Choose an accessible chat before sharing this automation.',
      );
      expect(automationsApiMock.createShared).not.toHaveBeenCalled();
    });

    it('automation.share honors an explicitly cleared declaration when re-sharing an edited action', async () => {
      automationsApiMock.list.mockResolvedValueOnce({
        activities: [
          {
            version: 1,
            id: 'reset-reshare',
            name: 'Review today',
            enabled: false,
            schedule: {
              kind: 'cron',
              expression: '0 2 * * *',
              timezone: 'local',
            },
            action: { type: 'app_advisor_prompt', prompt: 'Review today.' },
            targetRequirementCleared: true,
            createdAt: '2026-10-06T00:00:00.000Z',
            updatedAt: '2026-10-06T00:00:00.000Z',
            failureCount: 0,
            remote: {
              remoteId: 'shared-reset',
              contentHash: 'b'.repeat(64),
              shareScope: 'team',
              sharedAt: '2026-10-06T00:00:00.000Z',
            },
          },
        ],
        recentRuns: [],
      });
      automationsApiMock.getShared.mockResolvedValueOnce({
        id: 'shared-reset',
        contentHash: 'd'.repeat(64),
        automation: {
          description: 'Existing description',
          targetRequirement: { contexts: ['worktree'] },
        },
      });
      automationsApiMock.updateShared.mockResolvedValueOnce({
        id: 'shared-reset',
        contentHash: 'c'.repeat(64),
        shareScope: 'team',
      });
      const response = await dispatchAppAction({
        requestId: 'reset-reshare',
        source: 'assistant',
        action: { type: 'automation.share', id: 'reset-reshare' },
      });
      expect(response.ok).toBe(true);
      const outgoing = automationsApiMock.updateShared.mock.calls[0]?.[0];
      expect(outgoing).toMatchObject({
        automation: { action: { type: 'app_advisor_prompt' } },
      });
      expect(outgoing).not.toHaveProperty('automation.targetRequirement');
      expect(outgoing).not.toHaveProperty(
        'automation.targetRequirementCleared',
      );
    });

    it('automation.share preserves the existing description when re-sharing without one', async () => {
      automationsApiMock.list.mockResolvedValueOnce({
        activities: [
          {
            version: 1,
            id: 'activity-reshare',
            name: 'Nightly triage',
            enabled: true,
            schedule: {
              kind: 'cron',
              expression: '0 2 * * *',
              timezone: 'local',
            },
            action: { type: 'app_advisor_prompt', prompt: 'Triage.' },
            createdAt: '2026-08-19T00:00:00.000Z',
            updatedAt: '2026-08-19T00:00:00.000Z',
            failureCount: 0,
            remote: {
              remoteId: 'shared-automation-1',
              contentHash: 'b'.repeat(64),
              shareScope: 'team',
              sharedAt: '2026-08-19T00:00:00.000Z',
            },
          },
        ],
        recentRuns: [],
      });
      automationsApiMock.getShared.mockResolvedValueOnce({
        id: 'shared-automation-1',
        // The server-current hash differs from the locally persisted one —
        // the update must carry this fetched hash or it would 409 forever.
        contentHash: 'd'.repeat(64),
        automation: { description: 'Existing description.' },
      });
      automationsApiMock.updateShared.mockResolvedValueOnce({
        id: 'shared-automation-1',
        contentHash: 'c'.repeat(64),
        shareScope: 'team',
      });

      const response = await dispatchAppAction({
        requestId: 'req-automation-reshare',
        source: 'assistant',
        action: { type: 'automation.share', id: 'activity-reshare' },
      });

      expect(response.ok).toBe(true);
      expect(automationsApiMock.updateShared).toHaveBeenCalledWith(
        expect.objectContaining({
          activityId: 'activity-reshare',
          automationId: 'shared-automation-1',
          expectedContentHash: 'd'.repeat(64),
          automation: expect.objectContaining({
            description: 'Existing description.',
          }) as unknown,
        }),
      );
      // Ownership is intentionally omitted when the action carries none, so
      // the server preserves the current owner instead of rejecting a bare
      // team scope without its target id.
      const reshareRequest = automationsApiMock.updateShared.mock.calls[0]?.[0];
      expect(reshareRequest).not.toHaveProperty('shareScope');
      expect(reshareRequest).not.toHaveProperty('teamId');
    });

    it('automation.share treats a legacy private-only share as a first share', async () => {
      automationsApiMock.updateShared.mockClear();
      automationsApiMock.list.mockResolvedValueOnce({
        activities: [
          {
            version: 1,
            id: 'activity-private-remote',
            name: 'Nightly triage',
            enabled: true,
            schedule: {
              kind: 'cron',
              expression: '0 2 * * *',
              timezone: 'local',
            },
            action: { type: 'app_advisor_prompt', prompt: 'Triage.' },
            createdAt: '2026-08-19T00:00:00.000Z',
            updatedAt: '2026-08-19T00:00:00.000Z',
            failureCount: 0,
            remote: {
              remoteId: 'shared-automation-private',
              contentHash: 'b'.repeat(64),
              shareScope: 'private',
              sharedAt: '2026-08-19T00:00:00.000Z',
            },
          },
        ],
        recentRuns: [],
      });
      // Private with no public link: nobody else can see it.
      automationsApiMock.getShared.mockResolvedValueOnce({
        id: 'shared-automation-private',
        contentHash: 'd'.repeat(64),
        shareScope: 'private',
        publicShare: null,
        automation: { description: '' },
      });

      const response = await dispatchAppAction({
        requestId: 'req-automation-reshare-private',
        source: 'assistant',
        action: { type: 'automation.share', id: 'activity-private-remote' },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.message).toContain('not shared with anyone yet');
      expect(automationsApiMock.updateShared).not.toHaveBeenCalled();
    });

    it('automation.share refuses to drop an installed capability package', async () => {
      automationsApiMock.createShared.mockClear();
      automationsApiMock.updateShared.mockClear();
      automationsApiMock.list.mockResolvedValueOnce({
        activities: [
          {
            version: 1,
            id: 'activity-packaged',
            name: 'Packaged review',
            enabled: false,
            schedule: {
              kind: 'cron',
              expression: '0 2 * * *',
              timezone: 'local',
            },
            action: {
              type: 'worktree_prompt',
              workspaceId: 'workspace-1',
              prompt: 'Review this.',
            },
            createdAt: '2026-08-19T00:00:00.000Z',
            updatedAt: '2026-08-19T00:00:00.000Z',
            failureCount: 0,
            installedFrom: {
              remoteId: 'source-automation',
              contentHash: 'b'.repeat(64),
              installedAt: '2026-08-19T00:00:00.000Z',
              capabilityPackage: {
                version: 1,
                digest: `pp:v1:${'A'.repeat(43)}`,
              },
            },
          },
        ],
        recentRuns: [],
      });

      const response = await dispatchAppAction({
        requestId: 'req-automation-share-packaged',
        source: 'assistant',
        action: { type: 'automation.share', id: 'activity-packaged' },
      });

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'execution_failed',
          retryable: false,
        },
      });
      expect(response.error?.message).toContain('use Share');
      expect(automationsApiMock.createShared).not.toHaveBeenCalled();
      expect(automationsApiMock.updateShared).not.toHaveBeenCalled();
    });

    it('automation.share infers team scope from a bare teamId and rejects mismatches', async () => {
      const activity = {
        version: 1,
        id: 'activity-infer',
        name: 'Nightly triage',
        enabled: true,
        schedule: {
          kind: 'cron',
          expression: '0 2 * * *',
          timezone: 'local',
        },
        action: { type: 'app_advisor_prompt', prompt: 'Triage.' },
        createdAt: '2026-08-19T00:00:00.000Z',
        updatedAt: '2026-08-19T00:00:00.000Z',
        failureCount: 0,
      };
      automationsApiMock.createShared.mockClear();
      automationsApiMock.list.mockResolvedValue({
        activities: [activity],
        recentRuns: [],
      });
      automationsApiMock.createShared.mockResolvedValueOnce({
        id: 'shared-automation-2',
        contentHash: 'e'.repeat(64),
        shareScope: 'team',
      });

      // A bare teamId infers team scope — it must never silently downgrade
      // the share to private (which would also drop the target id).
      const inferred = await dispatchAppAction({
        requestId: 'req-automation-share-infer',
        source: 'assistant',
        action: {
          type: 'automation.share',
          id: 'activity-infer',
          teamId: 'team-9',
        },
      });
      expect(inferred.ok).toBe(true);
      expect(automationsApiMock.createShared).toHaveBeenCalledWith(
        expect.objectContaining({ shareScope: 'team', teamId: 'team-9' }),
      );

      // Contradictory ownership fails loudly instead of guessing.
      const both = await dispatchAppAction({
        requestId: 'req-automation-share-both-targets',
        source: 'assistant',
        action: {
          type: 'automation.share',
          id: 'activity-infer',
          teamId: 'team-9',
          organizationId: 'org-1',
        },
      });
      expect(both.ok).toBe(false);
      expect(both.error?.message).toContain('not both');

      const mismatched = await dispatchAppAction({
        requestId: 'req-automation-share-mismatch',
        source: 'assistant',
        action: {
          type: 'automation.share',
          id: 'activity-infer',
          shareScope: 'private',
          teamId: 'team-9',
        },
      });
      expect(mismatched.ok).toBe(false);
      expect(mismatched.error?.message).toContain('invalid shareScope');
      expect(automationsApiMock.createShared).toHaveBeenCalledTimes(1);
      automationsApiMock.list.mockReset();
    });

    it('automation.list_shared rejects out-of-contract limit values', async () => {
      automationsApiMock.listShared.mockClear();
      for (const limit of [0, -1, 1.5, 101]) {
        const response = await dispatchAppAction({
          requestId: `req-automation-list-shared-limit-${limit}`,
          source: 'assistant',
          action: { type: 'automation.list_shared', limit },
        });
        expect(response.ok).toBe(false);
      }
      expect(automationsApiMock.listShared).not.toHaveBeenCalled();
    });

    it('automation.list_shared, read_shared, and unshare forward to the shared IPC', async () => {
      automationsApiMock.listShared.mockResolvedValueOnce({
        automations: [{ id: 'shared-automation-1' }],
        nextCursor: 'cursor-2',
      });
      automationsApiMock.getShared.mockResolvedValueOnce({
        id: 'shared-automation-1',
        automation: { version: 1 },
      });
      automationsApiMock.deleteShared.mockResolvedValueOnce(undefined);

      const listed = await dispatchAppAction({
        requestId: 'req-automation-list-shared',
        source: 'assistant',
        action: { type: 'automation.list_shared', query: 'triage', limit: 5 },
      });
      const read = await dispatchAppAction({
        requestId: 'req-automation-read-shared',
        source: 'assistant',
        action: {
          type: 'automation.read_shared',
          automationId: 'shared-automation-1',
        },
      });
      const unshared = await dispatchAppAction({
        requestId: 'req-automation-unshare',
        source: 'assistant',
        action: {
          type: 'automation.unshare',
          automationId: 'shared-automation-1',
        },
      });

      expect(listed.ok).toBe(true);
      expect(listed.result).toMatchObject({ nextCursor: 'cursor-2' });
      expect(automationsApiMock.listShared).toHaveBeenCalledWith({
        query: 'triage',
        limit: 5,
      });
      expect(read.ok).toBe(true);
      expect(automationsApiMock.getShared).toHaveBeenCalledWith(
        'shared-automation-1',
      );
      expect(unshared.ok).toBe(true);
      expect(automationsApiMock.deleteShared).toHaveBeenCalledWith({
        automationId: 'shared-automation-1',
      });
    });

    // CAN-4551 7c: agents' automation writes run in main, which marks them
    // agent-authored and converts them; the renderer refuses them.
    it('refuses automation.create and automation.update, which run in main', async () => {
      const create = await dispatchAppAction({
        requestId: 'req-create-main',
        source: 'assistant',
        action: {
          type: 'automation.create',
          input: {
            name: 'Daily',
            schedule: {
              kind: 'cron',
              expression: '0 9 * * *',
              timezone: 'local',
            },
            action: { type: 'app_advisor_prompt', prompt: 'hi' },
          },
        },
      });
      const update = await dispatchAppAction({
        requestId: 'req-update-main',
        source: 'assistant',
        action: {
          type: 'automation.update',
          id: 'activity-1',
          patch: { name: 'Renamed' },
        },
      });
      for (const response of [create, update]) {
        expect(response).toMatchObject({
          ok: false,
          error: { code: 'unsupported_action' },
        });
      }
      expect(automationsApiMock.create).not.toHaveBeenCalled();
      expect(automationsApiMock.update).not.toHaveBeenCalled();
    });

    it.each([
      [
        { kind: 'global' } as const,
        undefined,
        'pipeline nightly with no project',
      ],
      [
        { kind: 'task', taskId: 'wt-1' } as const,
        'project-1',
        'pipeline nightly in task wt-1 of project project-1',
      ],
      [
        { kind: 'project' } as const,
        'project-1',
        'pipeline nightly in project project-1 folder',
      ],
    ])(
      'describes a %j pipeline destination in its receipt',
      async (target, workspaceId, targetSummary) => {
        const created: ScheduledActivity = {
          version: 1,
          id: 'created-pipeline',
          name: 'Nightly',
          enabled: true,
          schedule: {
            kind: 'cron',
            expression: '0 9 * * *',
            timezone: 'local',
          },
          action: {
            type: 'worktree_pipeline',
            pipelineId: 'nightly',
            target,
            ...(workspaceId ? { workspaceId } : {}),
          },
          createdAt: '2026-08-04T00:00:00.000Z',
          updatedAt: '2026-08-04T00:00:00.000Z',
          failureCount: 0,
        };
        automationsApiMock.update.mockResolvedValueOnce({
          ok: true,
          activity: created,
        });
        automationsApiMock.list.mockResolvedValueOnce({
          activities: [created],
          recentRuns: [],
        });

        const response = await dispatchAppAction({
          requestId: 'req-disable-pipeline-receipt',
          source: 'assistant',
          action: { type: 'automation.disable', id: created.id },
        });

        expect(response).toMatchObject({
          ok: true,
          result: { agentArtifacts: [{ kind: 'automation', targetSummary }] },
        });
      },
    );

    it('automation.disable patches enabled false', async () => {
      automationsApiMock.update.mockResolvedValueOnce({
        ok: true,
        activity: { id: 'disabled', enabled: false },
      });
      const response = await dispatchAppAction({
        requestId: 'req-disable',
        source: 'assistant',
        action: { type: 'automation.disable', id: 'disabled' },
      });
      expect(automationsApiMock.update).toHaveBeenCalledWith({
        id: 'disabled',
        enabled: false,
      });
      expect(response.ok).toBe(true);
    });

    it('automation.delete forwards { id } and resolves successfully', async () => {
      const response = await dispatchAppAction({
        requestId: 'req-delete',
        source: 'assistant',
        action: { type: 'automation.delete', id: 'to-delete' },
      });
      expect(automationsApiMock.delete).toHaveBeenCalledWith({
        id: 'to-delete',
      });
      expect(response.ok).toBe(true);
    });

    it('automation.run_now forwards { id } and resolves with the new run', async () => {
      automationsApiMock.list.mockResolvedValueOnce({
        activities: [
          {
            id: 'fire-now',
            action: { type: 'app_advisor_prompt', prompt: 'Continue' },
          },
        ],
        recentRuns: [],
      });
      automationsApiMock.runNow.mockResolvedValueOnce({
        ok: true,
        run: { id: 'run-1' },
      });
      const response = await dispatchAppAction({
        requestId: 'req-run-now',
        source: 'assistant',
        action: { type: 'automation.run_now', id: 'fire-now' },
      });
      expect(automationsApiMock.runNow).toHaveBeenCalledWith({
        id: 'fire-now',
      });
      expect(response.ok).toBe(true);
      expect(response.result).toEqual({ run: { id: 'run-1' } });
    });

    it('rejects If Command immediate runs', async () => {
      automationsApiMock.list.mockResolvedValueOnce({
        activities: [{ id: 'unsafe', ifCommand: 'existing command' }],
        recentRuns: [],
      });
      const runNow = await dispatchAppAction({
        requestId: 'req-run-if-command',
        source: 'assistant',
        action: { type: 'automation.run_now', id: 'unsafe' },
      });

      expect(runNow).toMatchObject({
        ok: false,
        error: { code: 'invalid_payload' },
      });
      expect(automationsApiMock.runNow).not.toHaveBeenCalled();
    });

    it('rejects pipeline-resume automation immediate runs', async () => {
      const resumeAction = {
        type: 'pipeline_execution_resume' as const,
        executionId: 'execution-1',
        statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
        provider: 'claude' as const,
        purpose: 'usage_limit_resume' as const,
        pipelineName: 'Release',
      };
      automationsApiMock.list.mockResolvedValueOnce({
        activities: [{ id: 'resume-target', action: resumeAction }],
        recentRuns: [],
      });
      const runNow = await dispatchAppAction({
        requestId: 'req-run-resume',
        source: 'assistant',
        action: { type: 'automation.run_now', id: 'resume-target' },
      });

      expect(runNow).toMatchObject({
        ok: false,
        error: { code: 'invalid_payload' },
      });
      if (runNow.ok) throw new Error('resume policy fixture');
      expect(
        runNow.error?.message ?? 'Action failed without an error detail',
      ).toContain('Pipeline resume activities');
      expect(automationsApiMock.runNow).not.toHaveBeenCalled();
    });

    it('automation.delete maps backend { ok: false } into execution_failed', async () => {
      automationsApiMock.delete.mockResolvedValueOnce({
        ok: false,
        error: 'not found',
      });
      const response = await dispatchAppAction({
        requestId: 'req-delete-fail',
        source: 'assistant',
        action: { type: 'automation.delete', id: 'nope' },
      });
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('execution_failed');
      expect(response.error?.message).toBe('not found');
    });

    it('automation.list maps IPC throws into execution_failed', async () => {
      automationsApiMock.list.mockRejectedValueOnce(new Error('IPC down'));
      const response = await dispatchAppAction({
        requestId: 'req-list-fail',
        source: 'assistant',
        action: { type: 'automation.list' },
      });
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('execution_failed');
      expect(response.error?.message).toBe('IPC down');
    });
  });

  describe('tracked-plan.import action', () => {
    it('imports a source file for the requested worktree and returns the managed plan file path', async () => {
      activityPlansImportMock.mockResolvedValueOnce({
        plan: {
          id: 'plan-1',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          source: 'imported',
          title: 'Imported plan',
          content: '# Imported plan\n',
          reviewStatus: 'pending',
          createdAt: '2026-06-16T00:00:00.000Z',
          updatedAt: '2026-06-16T00:00:00.000Z',
          latestRevisionNumber: 1,
          revisions: [],
          linkedExecutionIds: [],
          sourceFilePath: 'plan.md',
        },
        trackedPlanFilePath: '/canopy/worktrees/worktree-1/tracked-plans.json',
      });

      const response = await dispatchAppAction({
        requestId: 'req-tracked-plan-import',
        source: 'assistant',
        action: {
          type: 'tracked-plan.import',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          filePath: 'docs/plan.md',
          repoId: '__workspace_root__',
        },
      });

      expect(activityPlansImportMock).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        filePath: 'docs/plan.md',
        repoId: '__workspace_root__',
        initiationSource: 'app_advisor',
      });
      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({
        plan: {
          id: 'plan-1',
          source: 'imported',
          title: 'Imported plan',
          sourceFilePath: 'plan.md',
        },
        trackedPlanFilePath: '/canopy/worktrees/worktree-1/tracked-plans.json',
      });
    });

    it('requires a file path', async () => {
      const response = await dispatchAppAction({
        requestId: 'req-tracked-plan-import-invalid',
        source: 'assistant',
        action: {
          type: 'tracked-plan.import',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          filePath: '',
          repoId: '__workspace_root__',
        },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('invalid_payload');
      expect(activityPlansImportMock).not.toHaveBeenCalled();
    });
  });

  describe('tracked-plan Plan panel actions (phase 06)', () => {
    const PLAN: TrackedPlanData = {
      id: 'plan-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      source: 'claude',
      title: 'Importer plan',
      content: '# Importer plan',
      reviewStatus: 'pending',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      latestRevisionNumber: 1,
      revisions: [],
      linkedExecutionIds: [],
    };
    const OPEN_ACTION = {
      type: 'tracked-plan.open_explore',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      planId: 'plan-1',
    } as const;
    const LOCATION = {
      layoutKey: 'project-1/worktree-1',
      groupId: 'group-side',
      panelId: 'panel-plan-plan-1',
    };

    function seedPlan(): void {
      useActivityStore.setState({
        trackedPlans: { 'project-1/worktree-1': [PLAN] },
      });
    }

    it('open_explore opens the Plan panel and reports where it is', async () => {
      seedPlan();
      openTrackedPlanMock.mockResolvedValueOnce({
        status: 'placed',
        location: LOCATION,
      });

      const response = await dispatchAppAction({
        requestId: 'req-open-plan-panel',
        source: 'assistant',
        action: OPEN_ACTION,
      });

      expect(openTrackedPlanMock).toHaveBeenCalledWith(
        { projectId: 'project-1', worktreeId: 'worktree-1', planId: 'plan-1' },
        { reportFailure: false },
      );
      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({
        plan: {
          id: 'plan-1',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          title: 'Importer plan',
        },
        panel: {
          panelId: 'panel-plan-plan-1',
          groupId: 'group-side',
          layoutKey: 'project-1/worktree-1',
          revealed: false,
        },
      });
      expect(Object.keys(response.result ?? {}).sort()).toEqual([
        'panel',
        'plan',
      ]);
      expect(JSON.stringify(response.result)).not.toContain('chatScope');
      expect(JSON.stringify(response.result)).not.toContain(
        PLAN_EXPLORE_CHAT_PROJECT_ID,
      );
    });

    it('open_explore reports a reveal of an already open panel', async () => {
      seedPlan();
      openTrackedPlanMock.mockResolvedValueOnce({
        status: 'revealed',
        location: LOCATION,
      });

      const response = await dispatchAppAction({
        requestId: 'req-reveal-plan-panel',
        source: 'assistant',
        action: OPEN_ACTION,
      });

      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({
        panel: { panelId: 'panel-plan-plan-1', revealed: true },
      });
    });

    it('open_explore reports an unknown plan without navigating', async () => {
      const response = await dispatchAppAction({
        requestId: 'req-open-missing-plan',
        source: 'assistant',
        action: OPEN_ACTION,
      });

      expect(activityPlansGetMock).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        planId: 'plan-1',
      });
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('not_found');
      expect(openTrackedPlanMock).not.toHaveBeenCalled();
    });

    it.each([
      ['unavailable', 'not_found'],
      ['worktree-unavailable', 'not_found'],
      ['failed', 'execution_failed'],
    ] as const)(
      'open_explore maps an opener %s result to %s',
      async (status, code) => {
        seedPlan();
        openTrackedPlanMock.mockResolvedValueOnce({ status });

        const response = await dispatchAppAction({
          requestId: `req-open-plan-${status}`,
          source: 'assistant',
          action: OPEN_ACTION,
        });

        expect(response.ok).toBe(false);
        expect(response.error?.code).toBe(code);
        expect(response.result).toBeUndefined();
      },
    );

    it('tracked-plan.list and tracked-plan.get summaries carry no plan chat scope', async () => {
      activityPlansListMock.mockResolvedValueOnce([PLAN]);
      activityPlansGetMock.mockResolvedValueOnce(PLAN);

      const list = await dispatchAppAction({
        requestId: 'req-list-plans-no-chat-scope',
        source: 'assistant',
        action: {
          type: 'tracked-plan.list',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      });
      const get = await dispatchAppAction({
        requestId: 'req-get-plan-no-chat-scope',
        source: 'assistant',
        action: {
          type: 'tracked-plan.get',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          planId: 'plan-1',
        },
      });

      expect([list.ok, get.ok]).toEqual([true, true]);
      expect(list.result).toMatchObject({ plans: [{ id: 'plan-1' }] });
      expect(get.result).toMatchObject({ plan: { id: 'plan-1' } });
      for (const response of [list, get]) {
        expect(JSON.stringify(response.result)).not.toContain('chatScope');
      }
    });

    it('keeps freeform truncation output within the requested character limit', async (): Promise<void> => {
      const planWithContent = { ...PLAN, content: 'abcdef' };
      activityPlansGetMock
        .mockResolvedValueOnce(planWithContent)
        .mockResolvedValueOnce(planWithContent);

      const oneCharacter = await dispatchAppAction({
        requestId: 'req-get-plan-content-limit-one',
        source: 'assistant',
        action: {
          type: 'tracked-plan.get',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          planId: 'plan-1',
          maxContentChars: 1,
        },
      });
      const fiveCharacters = await dispatchAppAction({
        requestId: 'req-get-plan-content-limit-five',
        source: 'assistant',
        action: {
          type: 'tracked-plan.get',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          planId: 'plan-1',
          maxContentChars: 5,
        },
      });

      expect(oneCharacter.ok).toBe(true);
      expect(oneCharacter.result).toMatchObject({
        plan: { content: 'a', contentTruncated: true },
      });
      expect(fiveCharacters.ok).toBe(true);
      expect(fiveCharacters.result).toMatchObject({
        // A limit too small for the "[truncated N chars]" marker keeps a
        // bare prefix rather than overflowing the limit.
        plan: { content: 'abcde', contentTruncated: true },
      });
    });

    it('rejects the retired plan-explore-chat actions', () => {
      for (const action of [
        { type: 'plan-explore-chat.list_tabs', planId: 'plan-1' },
        { type: 'plan-explore-chat.read_history', planId: 'plan-1' },
        {
          type: 'plan-explore-chat.send_message',
          planId: 'plan-1',
          chatId: 'chat-1',
          text: 'Hi',
        },
      ]) {
        expect(__isValidAppAdvisorActionForTests(action)).toBe(false);
      }
    });
  });

  describe('plan.share action', () => {
    it('forwards ids + scope/target and returns plan/remote id/sync status', async () => {
      activityPlansShareMock.mockResolvedValueOnce({
        id: 'plan-1',
        share: {
          serverId: 'server-1',
          remoteId: 'remote-9',
          shareScope: 'team',
          syncStatus: 'synced',
        },
      });
      const response = await dispatchAppAction({
        requestId: 'req-plan-share',
        source: 'assistant',
        action: {
          type: 'plan.share',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          planId: 'plan-1',
          shareScope: 'team',
          teamId: 'team-7',
        },
      });
      expect(activityPlansShareMock).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        planId: 'plan-1',
        shareScope: 'team',
        teamId: 'team-7',
      });
      expect(response.ok).toBe(true);
      expect(response.result).toEqual({
        planId: 'plan-1',
        remoteId: 'remote-9',
        syncStatus: 'synced',
        shareScope: 'team',
      });
    });

    it('refuses an organization share with no id or selected context', async () => {
      activityPlansShareMock.mockResolvedValueOnce({ id: 'plan-1' });
      const response = await dispatchAppAction({
        requestId: 'req-plan-share-minimal',
        source: 'assistant',
        action: {
          type: 'plan.share',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          planId: 'plan-1',
          shareScope: 'organization',
        },
      });
      expect(activityPlansShareMock).not.toHaveBeenCalled();
      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'surface_unavailable',
          message:
            'Choose an organization from the context switcher above the account in the sidebar, or pass organizationId, to share with an organization.',
        },
      });
    });

    it('maps a null bridge result into not_found', async () => {
      activityPlansShareMock.mockResolvedValueOnce(null);
      const response = await dispatchAppAction({
        requestId: 'req-plan-share-missing',
        source: 'assistant',
        action: {
          type: 'plan.share',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          planId: 'ghost',
          shareScope: 'team',
          teamId: 'team-7',
        },
      });
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('not_found');
    });

    it('maps an IPC throw into a user-safe execution_failed error', async () => {
      activityPlansShareMock.mockRejectedValueOnce(
        new Error('Cloud account lacks plans-crud-v1.'),
      );
      const response = await dispatchAppAction({
        requestId: 'req-plan-share-throw',
        source: 'assistant',
        action: {
          type: 'plan.share',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          planId: 'plan-1',
          shareScope: 'team',
          teamId: 'team-7',
        },
      });
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('execution_failed');
      expect(response.error?.message).toBe(
        'Cloud account lacks plans-crud-v1.',
      );
    });

    it('never invites a retry of an uncertain plan publication', async () => {
      jest.spyOn(window.api.activity.plans, 'share').mockResolvedValueOnce({
        ok: false,
        failure: {
          version: 1,
          kind: 'connection',
          stage: 'publish',
          message: "Couldn't reach the cloud.",
          commitState: 'unknown',
          retryable: false,
        },
      });
      const response = await dispatchAppAction({
        requestId: 'req-plan-share-uncertain',
        source: 'assistant',
        action: {
          type: 'plan.share',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          planId: 'plan-1',
          shareScope: 'team',
          teamId: 'team-7',
        },
      });
      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'execution_failed',
          message:
            "Couldn't confirm whether this plan was shared. Check its current sharing status before trying again.",
          retryable: false,
        },
      });
    });

    it('never invites a retry of a plan share that landed', async () => {
      jest.spyOn(window.api.activity.plans, 'share').mockResolvedValueOnce({
        ok: false,
        failure: {
          version: 1,
          kind: 'unknown',
          stage: 'finish',
          message: "Couldn't share. Try again.",
          commitState: 'committed',
          retryable: false,
        },
      });
      const response = await dispatchAppAction({
        requestId: 'req-plan-share-landed',
        source: 'assistant',
        action: {
          type: 'plan.share',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          planId: 'plan-1',
          shareScope: 'team',
          teamId: 'team-7',
        },
      });
      expect(response).toMatchObject({
        ok: false,
        error: {
          message: 'Plan shared, but finishing up failed.',
          retryable: false,
        },
      });
    });

    it('rejects a payload missing planId before any IPC', async () => {
      const request: AppAdvisorActionRequest = {
        requestId: 'req-plan-share-invalid',
        source: 'assistant',
        action: {
          type: 'plan.share',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          planId: 'plan-1',
          shareScope: 'organization',
        },
      };
      Reflect.deleteProperty(request.action, 'planId');

      const response = await dispatchAppAction(request);
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('invalid_payload');
      expect(activityPlansShareMock).not.toHaveBeenCalled();
    });

    it('rejects an unknown shareScope before any IPC', async () => {
      const request: AppAdvisorActionRequest = {
        requestId: 'req-plan-share-bad-scope',
        source: 'assistant',
        action: {
          type: 'plan.share',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          planId: 'plan-1',
          shareScope: 'organization',
        },
      };
      Object.defineProperty(request.action, 'shareScope', {
        configurable: true,
        value: 'public',
      });

      const response = await dispatchAppAction(request);
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('invalid_payload');
      expect(activityPlansShareMock).not.toHaveBeenCalled();
    });
  });

  describe('browser.* actions', () => {
    beforeEach(() => {
      useChatStore.setState({
        selectedWorktree: {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      });
    });

    it('browser.open creates a renderer browser and live view through BrowserApi', async () => {
      const response = await dispatchAppAction({
        requestId: 'req-browser-open',
        source: 'assistant',
        action: {
          type: 'browser.open',
          expectedRuntimeGeneration: 1,
          url: 'http://localhost:3000',
        },
      });

      expect(response.ok).toBe(true);
      expect(browserApiMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          url: 'http://localhost:3000',
        }),
      );
      expect(response.result).toMatchObject({
        browser: { url: 'http://localhost:3000' },
      });
    });

    it('browser.open refuses in a window that shows another computer', async () => {
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          ...window.api,
          remoteControl: {
            getContext: () => ({
              mode: 'remote',
              deviceId: 'device-b',
              name: 'Studio',
              platform: 'darwin',
            }),
          },
        },
      });

      const placementsBefore = mockRequestBrowserPanel.mock.calls.length;
      const createsBefore = browserApiMock.create.mock.calls.length;

      const response = await dispatchAppAction({
        requestId: 'req-browser-open-remote',
        source: 'assistant',
        action: { type: 'browser.open', url: 'http://localhost:3000' },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('surface_unavailable');
      expect(browserApiMock.create.mock.calls).toHaveLength(createsBefore);
      expect(mockRequestBrowserPanel.mock.calls).toHaveLength(placementsBefore);
    });

    it('browser.open reveals the new tab before its session exists', async () => {
      let finishCreate: (() => void) | undefined;
      let createRequest: BrowserCreateRequest | undefined;
      browserApiMock.create.mockImplementationOnce(
        (request: BrowserCreateRequest) =>
          new Promise((resolve) => {
            createRequest = request;
            finishCreate = (): void =>
              resolve(
                browserSnapshot({
                  id: request.browserId ?? 'browser-created',
                  url: request.url ?? '',
                }),
              );
          }),
      );

      const responsePromise = dispatchAppAction({
        requestId: 'req-browser-open-early',
        source: 'assistant',
        action: {
          type: 'browser.open',
          expectedRuntimeGeneration: 1,
          url: 'http://localhost:3000',
        },
      });
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      // The panel is requested while the backend is still creating.
      expect(finishCreate).toBeDefined();
      const panelCall = mockRequestBrowserPanel.mock.calls.at(-1);
      expect(createRequest?.browserId).toBeDefined();
      expect(panelCall?.[2]).toBe(createRequest?.browserId);
      expect(panelCall?.[4]).toEqual({ focus: false });

      finishCreate?.();
      const response = await responsePromise;
      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({
        browser: {
          id: createRequest?.browserId,
          url: 'http://localhost:3000',
        },
      });
    });

    it('browser.open reports the error and removes the tab when the session cannot be created', async () => {
      browserApiMock.create.mockRejectedValueOnce(new Error('Profile locked'));
      browserApiMock.setVisible.mockResolvedValueOnce(undefined);
      browserApiMock.destroy.mockResolvedValueOnce(undefined);

      const response = await dispatchAppAction({
        requestId: 'req-browser-open-create-failure',
        source: 'assistant',
        action: {
          type: 'browser.open',
          expectedRuntimeGeneration: 1,
          url: 'http://localhost:3000',
        },
      });

      expect(response.ok).toBe(false);
      if (!response.ok) {
        expect(
          response.error?.message ?? 'Action failed without an error detail',
        ).toBe('Profile locked');
      } else {
        throw new Error('Expected browser.open to fail');
      }
      expect(browserApiMock.destroy).toHaveBeenCalledTimes(1);
    });

    it('browser.open rolls back a newly created session when panel insertion fails', async () => {
      mockRequestBrowserPanel.mockResolvedValueOnce(false);
      browserApiMock.setVisible.mockResolvedValueOnce(undefined);
      browserApiMock.destroy.mockResolvedValueOnce(undefined);

      const response = await dispatchAppAction({
        requestId: 'req-browser-open-bind-failure',
        source: 'assistant',
        action: {
          type: 'browser.open',
          expectedRuntimeGeneration: 1,
          url: 'http://localhost:3000',
        },
      });

      expect(response.requestId).toBe('req-browser-open-bind-failure');
      expect(response.ok).toBe(false);
      if (!response.ok) {
        expect(response.error?.code).toBe('execution_failed');
        expect(
          response.error?.message ?? 'Action failed without an error detail',
        ).toBe('Unable to open Browser panel.');
      } else {
        throw new Error('Expected browser.open panel binding to fail');
      }
      expect(browserApiMock.destroy).toHaveBeenCalledTimes(1);
    });

    it('browser.open opens external URLs in-app when local-only mode is disabled', async () => {
      const response = await dispatchAppAction({
        requestId: 'req-browser-open-external',
        source: 'assistant',
        action: {
          type: 'browser.open',
          expectedRuntimeGeneration: 1,
          url: 'https://example.com/docs',
        },
      });

      expect(response.ok).toBe(true);
      expect(browserApiMock.openExternal).not.toHaveBeenCalled();
      expect(browserApiMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          url: 'https://example.com/docs',
        }),
      );
      expect(response.result).toMatchObject({
        browser: { url: 'https://example.com/docs' },
      });
    });

    it('browser.open explains the external fallback when local-only mode rejects the URL', async () => {
      useBrowserStore.setState({ localServersOnly: true });

      try {
        const response = await dispatchAppAction({
          requestId: 'req-browser-open-local-only-conflict',
          source: 'assistant',
          action: {
            type: 'browser.open',
            expectedRuntimeGeneration: 1,
            url: 'https://example.com/docs',
          },
        });

        expect(response.ok).toBe(true);
        expect(browserApiMock.openExternal).toHaveBeenCalledWith({
          url: 'https://example.com/docs',
        });
        expect(browserApiMock.create).not.toHaveBeenCalled();
        expect(useGitHubStore.getState().toasts.at(-1)).toMatchObject({
          type: 'warning',
          meta: {
            title: 'Opened outside the built-in browser',
            action: { label: 'Allow all sites' },
          },
        });
      } finally {
        useBrowserStore.setState({ localServersOnly: false });
      }
    });

    it('browser.open opens a local file path in-app instead of punting to the OS', async () => {
      const response = await dispatchAppAction({
        requestId: 'req-browser-open-file',
        source: 'assistant',
        action: {
          type: 'browser.open',
          expectedRuntimeGeneration: 1,
          url: '/Users/me/My Site/index.html',
        },
      });

      expect(response.ok).toBe(true);
      expect(browserApiMock.openExternal).not.toHaveBeenCalled();
      expect(browserApiMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          url: 'file:///Users/me/My%20Site/index.html',
        }),
      );
    });

    it('browser.open refuses a network share path without calling openExternal', async () => {
      const response = await dispatchAppAction({
        requestId: 'req-browser-open-unc',
        source: 'assistant',
        action: {
          type: 'browser.open',
          expectedRuntimeGeneration: 1,
          url: 'file://fileserver/share/index.html',
        },
      });

      expect(response.ok).toBe(false);
      if (!response.ok) {
        expect(response.error?.code).toBe('invalid_target');
      } else {
        throw new Error('Expected browser.open to refuse a network share.');
      }
      expect(browserApiMock.openExternal).not.toHaveBeenCalled();
      expect(browserApiMock.create).not.toHaveBeenCalled();
    });

    // A path the normalizer cannot turn into any URL (`~` has no home
    // directory in the renderer) must produce the same `invalid_target` the
    // main-process `browserOpen` returns, not a thrown `openExternal`
    // rejection surfaced as `execution_failed`.
    it('browser.open refuses an unopenable path with the same code main returns', async () => {
      const response = await dispatchAppAction({
        requestId: 'req-browser-open-tilde',
        source: 'assistant',
        action: {
          type: 'browser.open',
          expectedRuntimeGeneration: 1,
          url: '~/site/index.html',
        },
      });

      expect(response.ok).toBe(false);
      if (!response.ok) {
        expect(response.error?.code).toBe('invalid_target');
      } else {
        throw new Error('Expected browser.open to refuse a `~` path.');
      }
      expect(browserApiMock.openExternal).not.toHaveBeenCalled();
      expect(browserApiMock.create).not.toHaveBeenCalled();
    });

    it('browser.open validates provided browser ids before routing external URLs', async () => {
      const otherBrowserId = seedRendererBrowser('project-2', 'worktree-2', {
        url: 'http://localhost:3002',
      });

      const response = await dispatchAppAction({
        requestId: 'req-browser-open-invalid-external',
        source: 'assistant',
        action: {
          type: 'browser.open',
          expectedRuntimeGeneration: 1,
          browserId: otherBrowserId,
          url: 'https://example.com/docs',
        },
      });

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'not_found',
          message: 'No in-app browser is available for this worktree.',
        },
      });
      expect(browserApiMock.openExternal).not.toHaveBeenCalled();
    });

    it('browser.open rejects provided browser ids outside the selected worktree', async () => {
      seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3000',
      });
      const otherBrowserId = seedRendererBrowser('project-2', 'worktree-2', {
        url: 'http://localhost:3002',
      });

      const response = await dispatchAppAction({
        requestId: 'req-browser-open-cross-worktree',
        source: 'assistant',
        action: {
          type: 'browser.open',
          expectedRuntimeGeneration: 1,
          browserId: otherBrowserId,
          url: 'http://localhost:3001',
        },
      });

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'not_found',
          message: 'No in-app browser is available for this worktree.',
        },
      });
      expect(browserApiMock.navigate).not.toHaveBeenCalled();
    });

    it('browser.navigate sends the active browser through BrowserApi', async () => {
      const browserId = seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3000',
      });
      await useBrowserStore
        .getState()
        .ensureLiveView('project-1', 'worktree-1', browserId);
      browserApiMock.navigate.mockClear();

      const response = await dispatchAppAction({
        requestId: 'req-browser-navigate',
        source: 'assistant',
        action: {
          type: 'browser.navigate',
          expectedRuntimeGeneration: 1,
          url: 'http://localhost:3001',
        },
      });

      expect(response.ok).toBe(true);
      expect(browserApiMock.navigate).toHaveBeenCalledWith({
        browserId,
        url: 'http://localhost:3001',
      });
      expect(response.result).toMatchObject({
        browser: { id: browserId, url: 'http://localhost:3001' },
      });
    });

    it('routes omitted browser actions to the explicit active id and explicit actions to their requested id', async () => {
      const firstBrowserId = seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3000',
      });
      const secondBrowserId = seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3001',
      });
      useBrowserStore.setState((state) => {
        const key = 'project-1/worktree-1';
        return {
          worktrees: {
            ...state.worktrees,
            [key]: {
              ...state.worktrees[key],
              activeBrowserId: secondBrowserId,
            },
          },
        };
      });
      browserApiMock.navigate.mockClear();

      await dispatchAppAction({
        requestId: 'req-browser-navigate-omitted-id',
        source: 'assistant',
        action: {
          type: 'browser.navigate',
          expectedRuntimeGeneration: 1,
          url: 'http://localhost:3002',
        },
      });
      await dispatchAppAction({
        requestId: 'req-browser-navigate-explicit-id',
        source: 'assistant',
        action: {
          type: 'browser.navigate',
          expectedRuntimeGeneration: 1,
          browserId: firstBrowserId,
          url: 'http://localhost:3003',
        },
      });

      expect(browserApiMock.navigate).toHaveBeenNthCalledWith(1, {
        browserId: secondBrowserId,
        url: 'http://localhost:3002',
      });
      expect(browserApiMock.navigate).toHaveBeenNthCalledWith(2, {
        browserId: firstBrowserId,
        url: 'http://localhost:3003',
      });
    });

    it('browser.click delegates to BrowserApi automation', async () => {
      const browserId = seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3000',
      });
      await useBrowserStore
        .getState()
        .ensureLiveView('project-1', 'worktree-1', browserId);
      const controller = new AbortController();

      const response = await dispatchAppAction({
        requestId: 'req-browser-click',
        source: 'assistant',
        signal: controller.signal,
        action: {
          type: 'browser.click',
          expectedRuntimeGeneration: 41,
          frame: '  iframe.checkout  ',
          locator: 'button.primary',
          button: 'right',
          clickCount: 2,
          modifiers: ['Control', 'Shift'],
          position: { x: 4, y: 6 },
          force: false,
          actionId: 'click-primary',
          timeoutMs: 5_000,
        },
      });

      expect(response.ok).toBe(true);
      expect(browserApiMock.automation).toHaveBeenCalledWith({
        browserId,
        expectedRuntimeGeneration: 41,
        cancellationKey: 'req-browser-click',
        command: {
          kind: 'click',
          frame: '  iframe.checkout  ',
          locator: 'button.primary',
          button: 'right',
          clickCount: 2,
          modifiers: ['Control', 'Shift'],
          position: { x: 4, y: 6 },
          force: false,
          actionId: 'click-primary',
          timeoutMs: 5_000,
        },
      });
      expect(response.result).toMatchObject({
        browser: { id: browserId },
      });
    });

    it('does not dispatch browser automation when cancelled during target resolution', async () => {
      const browserId = seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3000',
      });
      const controller = new AbortController();
      let startTargetResolution: (() => void) | undefined;
      let finishTargetResolution: (() => void) | undefined;
      const targetResolutionStarted = new Promise<void>((resolve) => {
        startTargetResolution = resolve;
      });
      const targetResolution = new Promise<void>((resolve) => {
        finishTargetResolution = resolve;
      });
      const ensureLiveViewSpy = jest
        .spyOn(useBrowserStore.getState(), 'ensureLiveView')
        .mockImplementation(() => {
          startTargetResolution?.();
          return targetResolution;
        });

      try {
        const responsePromise = dispatchAppAction({
          requestId: 'req-browser-click-cancelled-before-send',
          source: 'assistant',
          signal: controller.signal,
          action: {
            type: 'browser.click',
            expectedRuntimeGeneration: 41,
            browserId,
            locator: 'button.primary',
          },
        });

        await targetResolutionStarted;
        controller.abort();
        finishTargetResolution?.();
        const response = await responsePromise;

        expect(browserApiMock.automation).not.toHaveBeenCalled();
        expect(response).toMatchObject({
          ok: false,
          error: {
            code: 'execution_failed',
            message: 'The browser action was cancelled before it was sent.',
          },
        });
      } finally {
        ensureLiveViewSpy.mockRestore();
      }
    });

    it('browser.fill and browser.press forward common automation options', async () => {
      const browserId = seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3000',
      });
      await useBrowserStore
        .getState()
        .ensureLiveView('project-1', 'worktree-1', browserId);

      const fillResponse = await dispatchAppAction({
        requestId: 'req-browser-fill-options',
        source: 'assistant',
        action: {
          type: 'browser.fill',
          expectedRuntimeGeneration: 43,
          locator: '#name',
          text: 'Ada',
          actionId: 'fill-name',
          timeoutMs: 6_000,
        },
      });
      const pressResponse = await dispatchAppAction({
        requestId: 'req-browser-press-options',
        source: 'assistant',
        action: {
          type: 'browser.press',
          expectedRuntimeGeneration: 44,
          locator: '#submit',
          key: 'Enter',
          actionId: 'submit-form',
          timeoutMs: 7_000,
        },
      });

      expect(fillResponse.ok).toBe(true);
      expect(pressResponse.ok).toBe(true);
      expect(browserApiMock.automation).toHaveBeenNthCalledWith(1, {
        browserId,
        expectedRuntimeGeneration: 43,
        cancellationKey: 'req-browser-fill-options',
        command: {
          kind: 'fill',
          locator: '#name',
          text: 'Ada',
          actionId: 'fill-name',
          timeoutMs: 6_000,
        },
      });
      expect(browserApiMock.automation).toHaveBeenNthCalledWith(2, {
        browserId,
        expectedRuntimeGeneration: 44,
        cancellationKey: 'req-browser-press-options',
        command: {
          kind: 'press',
          key: 'Enter',
          locator: '#submit',
          actionId: 'submit-form',
          timeoutMs: 7_000,
        },
      });
    });

    it('rejects invalid browser generation before invoking BrowserApi', async () => {
      const browserId = seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3000',
      });
      await useBrowserStore
        .getState()
        .ensureLiveView('project-1', 'worktree-1', browserId);

      const response = await dispatchAppAction({
        requestId: 'req-browser-click-invalid-generation',
        source: 'assistant',
        action: {
          type: 'browser.click',
          expectedRuntimeGeneration: 0,
          locator: 'button.primary',
        },
      });

      expect(response.requestId).toBe('req-browser-click-invalid-generation');
      expect(response.ok).toBe(false);
      if (!response.ok) {
        expect(response.error?.code).toBe('invalid_payload');
        expect(typeof response.error?.message).toBe('string');
      } else {
        throw new Error('Expected invalid browser generation to be rejected.');
      }
      expect(browserApiMock.automation).not.toHaveBeenCalled();
    });

    it.each([
      { type: 'browser.click', locator: '#ready' },
      { type: 'browser.fill', locator: '#ready', text: 'value' },
      { type: 'browser.press', locator: '#ready', key: 'Enter' },
      { type: 'browser.focus', locator: '#ready' },
      { type: 'browser.wait_for', locator: '#ready' },
      { type: 'browser.wait_for', text: 'Ready' },
    ])(
      'forwards frame unchanged through renderer automation for %j',
      async (payload) => {
        const browserId = seedRendererBrowser('project-1', 'worktree-1', {
          url: 'http://localhost:3000',
        });
        await useBrowserStore
          .getState()
          .ensureLiveView('project-1', 'worktree-1', browserId);
        const response = await dispatchAppAction({
          requestId: 'req-frame-scope',
          source: 'assistant',
          action: {
            ...payload,
            expectedRuntimeGeneration: 41,
            frame: '  iframe.checkout  ',
          },
        });
        expect(response.ok).toBe(true);
        const { type, ...fields } = payload;
        expect(browserApiMock.automation).toHaveBeenCalledWith({
          browserId,
          expectedRuntimeGeneration: 41,
          cancellationKey: 'req-frame-scope',
          command: {
            kind: type.slice('browser.'.length),
            ...fields,
            frame: '  iframe.checkout  ',
          },
        });
      },
    );

    it.each([
      {
        type: 'browser.hover',
        locator: '#menu',
        frame: 'f',
        actionId: 'hover',
        timeoutMs: 123,
        command: {
          kind: 'hover',
          locator: '#menu',
          frame: 'f',
          actionId: 'hover',
          timeoutMs: 123,
        },
      },
      {
        type: 'browser.scroll',
        direction: 'down',
        pixels: 200,
        ref: 'list',
        command: {
          kind: 'scroll',
          direction: 'down',
          pixels: 200,
          ref: 'list',
        },
      },
      {
        type: 'browser.drag',
        from: { ref: 'card' },
        to: { x: 0, y: 100 },
        steps: 4,
        modifiers: ['Shift'],
        command: {
          kind: 'drag',
          from: { ref: 'card' },
          to: { x: 0, y: 100 },
          steps: 4,
          modifiers: ['Shift'],
        },
      },
    ])(
      'dispatches $type through automation and preserves scroll/target receipt',
      async ({ command, ...fields }) => {
        const browserId = seedRendererBrowser('project-1', 'worktree-1', {
          url: 'http://localhost:3000',
        });
        await useBrowserStore
          .getState()
          .ensureLiveView('project-1', 'worktree-1', browserId);
        const receipt = {
          actionId: 'pointer',
          sequence: 3,
          kind: command.kind,
          status: 'executed',
          durationMs: 12,
          effects: {
            scroll: {
              container: 'page',
              axis: 'y',
              x: 0,
              y: 200,
              maxX: 0,
              maxY: 500,
              atStart: false,
              atEnd: false,
              moved: true,
              contentGrew: true,
            },
          },
          target: {
            ref: 'card',
            bounds: { x: 0, y: 100, width: 20, height: 20 },
          },
        };
        browserApiMock.automation.mockResolvedValueOnce({
          ok: true,
          runtimeGeneration: 41,
          receipt,
        });
        const response = await dispatchAppAction({
          requestId: 'pointer-request',
          source: 'assistant',
          action: { ...fields, expectedRuntimeGeneration: 41 },
        });
        expect(browserApiMock.automation).toHaveBeenCalledWith({
          browserId,
          expectedRuntimeGeneration: 41,
          cancellationKey: 'pointer-request',
          command,
        });
        expect(response).toMatchObject({ ok: true, result: { receipt } });
      },
    );

    it.each([
      {
        action: {
          type: 'browser.set_checked',
          expectedRuntimeGeneration: 43,
          frame: 'iframe.settings',
          locator: '#terms',
          checked: true,
          actionId: 'set-checked-action',
          timeoutMs: 6_123,
        },
        command: {
          kind: 'set_checked',
          frame: 'iframe.settings',
          locator: '#terms',
          checked: true,
          actionId: 'set-checked-action',
          timeoutMs: 6_123,
        },
      },
      {
        action: {
          type: 'browser.select_option',
          expectedRuntimeGeneration: 43,
          frame: 'iframe.settings',
          locator: '#country',
          values: ['ca'],
          searchText: 'Canada',
          actionId: 'select-option-action',
          timeoutMs: 7_234,
        },
        command: {
          kind: 'select_option',
          frame: 'iframe.settings',
          locator: '#country',
          values: ['ca'],
          searchText: 'Canada',
          actionId: 'select-option-action',
          timeoutMs: 7_234,
        },
      },
      {
        action: {
          type: 'browser.type',
          expectedRuntimeGeneration: 43,
          frame: 'iframe.settings',
          locator: '#search',
          text: 'query',
          delayMs: 37,
          actionId: 'type-action',
          timeoutMs: 8_345,
        },
        command: {
          kind: 'type',
          frame: 'iframe.settings',
          locator: '#search',
          text: 'query',
          delayMs: 37,
          actionId: 'type-action',
          timeoutMs: 8_345,
        },
      },
    ])(
      'dispatches $action.type through window.api.browser.automation without dropping fields',
      async ({ action, command }) => {
        const browserId = seedRendererBrowser('project-1', 'worktree-1', {
          url: 'http://localhost:3000',
        });
        await useBrowserStore
          .getState()
          .ensureLiveView('project-1', 'worktree-1', browserId);
        const receipt = {
          actionId: 'form-action',
          sequence: 6,
          kind: command.kind,
          status: 'executed',
          durationMs: 13,
          ...(action.type === 'browser.select_option'
            ? {
                target: {
                  ref: 'country',
                  options: [
                    {
                      value: 'ca',
                      label: 'Canada',
                      selected: true,
                      disabled: false,
                    },
                  ],
                },
              }
            : {}),
          readback: {
            code: 'state_unchanged',
            next: 'Review the reported value before retrying.',
          },
        };
        browserApiMock.automation.mockResolvedValueOnce({
          ok: true,
          runtimeGeneration: 43,
          receipt,
          browser: browserSnapshot({ id: browserId }),
        });

        const response = await dispatchAppAction({
          requestId: 'form-action-request',
          source: 'assistant',
          action,
        });

        expect(browserApiMock.automation).toHaveBeenCalledWith({
          browserId,
          expectedRuntimeGeneration: 43,
          cancellationKey: 'form-action-request',
          command,
        });
        expect(response).toMatchObject({
          ok: true,
          result: { receipt, browser: { id: browserId } },
        });
        expect(response).toHaveProperty('result.receipt', receipt);
      },
    );

    it.each([
      {
        outerCode: 'invalid_target',
        receiptCode: 'unsupported_control',
      },
      {
        outerCode: 'validation_failed',
        receiptCode: 'option_not_found',
      },
    ])(
      'preserves service-supplied $outerCode and full D19 receipt details through the Advisor renderer',
      async ({ outerCode, receiptCode }) => {
        const browserId = seedRendererBrowser('project-1', 'worktree-1', {
          url: 'http://localhost:3000',
        });
        await useBrowserStore
          .getState()
          .ensureLiveView('project-1', 'worktree-1', browserId);
        const receipt = {
          actionId: 'select-error-action',
          sequence: 7,
          kind: 'select_option',
          status: 'not_executed',
          durationMs: 21,
          error: {
            code: receiptCode,
            message: 'The requested choice could not be applied.',
            retryable: false,
            next: 'Inspect the available options and choose a supported value.',
            options: [
              {
                value: 'ca',
                label: 'Canada',
                selected: false,
                disabled: false,
              },
            ],
            candidatesRedacted: true,
          },
        };
        browserApiMock.automation.mockResolvedValueOnce({
          ok: false,
          receipt,
          error: {
            code: outerCode,
            message: 'The requested choice could not be applied.',
            details: receipt,
          },
        });

        const failed = await dispatchAppAction({
          requestId: 'select-error-request',
          source: 'assistant',
          action: {
            type: 'browser.select_option',
            expectedRuntimeGeneration: 43,
            locator: '#country',
            values: ['ca'],
            searchText: 'Canada',
          },
        });

        expect(browserApiMock.automation).toHaveBeenCalledWith({
          browserId,
          expectedRuntimeGeneration: 43,
          cancellationKey: 'select-error-request',
          command: {
            kind: 'select_option',
            locator: '#country',
            values: ['ca'],
            searchText: 'Canada',
          },
        });
        expect(failed).toMatchObject({
          ok: false,
          error: {
            code: outerCode,
            message: 'The requested choice could not be applied.',
            details: receipt,
          },
        });
      },
    );

    it('browser.focus uses the shared automation command and preserves its receipt', async () => {
      const browserId = seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3000',
      });
      await useBrowserStore
        .getState()
        .ensureLiveView('project-1', 'worktree-1', browserId);
      const receipt = {
        actionId: 'focus-search',
        sequence: 3,
        kind: 'focus' as const,
        status: 'executed' as const,
        durationMs: 12,
      };
      browserApiMock.automation.mockResolvedValueOnce({
        ok: true,
        runtimeGeneration: 41,
        receipt,
        browser: browserSnapshot({ id: browserId }),
      });

      const response = await dispatchAppAction({
        requestId: 'req-browser-focus',
        source: 'assistant',
        action: {
          type: 'browser.focus',
          expectedRuntimeGeneration: 41,
          frame: '  iframe.checkout  ',
          locator: '#search',
          actionId: 'focus-search',
          timeoutMs: 2_500,
        },
      });

      expect(browserApiMock.automation).toHaveBeenCalledWith({
        browserId,
        expectedRuntimeGeneration: 41,
        cancellationKey: 'req-browser-focus',
        command: {
          kind: 'focus',
          frame: '  iframe.checkout  ',
          locator: '#search',
          actionId: 'focus-search',
          timeoutMs: 2_500,
        },
      });
      expect(response).toMatchObject({
        ok: true,
        result: {
          runtimeGeneration: 41,
          receipt,
          browser: { id: browserId },
        },
      });
    });

    it('browser.wait_for forwards its command fields and preserves wait results', async () => {
      const browserId = seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3000',
      });
      await useBrowserStore
        .getState()
        .ensureLiveView('project-1', 'worktree-1', browserId);
      const receipt = {
        actionId: 'wait-for-save',
        sequence: 4,
        kind: 'wait_for' as const,
        status: 'executed' as const,
        durationMs: 25,
      };
      const waitFor = {
        satisfied: true,
        elapsedMs: 25,
        observed: { matchCount: 1, visibleCount: 1 },
      };
      browserApiMock.automation.mockResolvedValueOnce({
        ok: true,
        runtimeGeneration: 42,
        receipt,
        waitFor,
        repeated: true,
        browser: browserSnapshot({ id: browserId }),
      });

      const response = await dispatchAppAction({
        requestId: 'req-browser-wait-for',
        source: 'assistant',
        action: {
          type: 'browser.wait_for',
          expectedRuntimeGeneration: 42,
          frame: 'f-checkout-1',
          text: 'Saved',
          state: 'visible',
          actionId: 'wait-for-save',
          timeoutMs: 8_000,
        },
      });

      expect(browserApiMock.automation).toHaveBeenCalledWith({
        browserId,
        expectedRuntimeGeneration: 42,
        cancellationKey: 'req-browser-wait-for',
        command: {
          kind: 'wait_for',
          frame: 'f-checkout-1',
          text: 'Saved',
          state: 'visible',
          actionId: 'wait-for-save',
          timeoutMs: 8_000,
        },
      });
      expect(response).toMatchObject({
        ok: true,
        result: {
          runtimeGeneration: 42,
          receipt,
          waitFor,
          repeated: true,
          browser: { id: browserId },
        },
      });
    });

    it('preserves browser automation error details and lost-runtime receipts', async () => {
      const browserId = seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3000',
      });
      await useBrowserStore
        .getState()
        .ensureLiveView('project-1', 'worktree-1', browserId);
      const receipt = {
        actionId: 'readonly',
        sequence: 1,
        kind: 'fill' as const,
        status: 'not_executed' as const,
        durationMs: 10,
        error: {
          code: 'not_editable' as const,
          message: 'Readonly',
          retryable: false,
        },
      };
      browserApiMock.automation.mockResolvedValueOnce({
        ok: false,
        receipt,
        error: {
          code: 'invalid_target',
          message: 'Readonly',
          details: receipt,
        },
      });
      const action = {
        type: 'browser.fill' as const,
        expectedRuntimeGeneration: 8,
        locator: '#readonly',
        text: 'private',
      };
      const failed = await dispatchAppAction({
        requestId: 'error-receipt',
        source: 'assistant',
        action,
      });
      expect(failed).toMatchObject({
        ok: false,
        error: { code: 'invalid_target', details: receipt },
      });
      expect(JSON.stringify(failed.error)).not.toContain('private');
      const unknownReceipt = {
        actionId: 'unknown',
        sequence: 2,
        kind: 'fill' as const,
        status: 'outcome_unknown' as const,
        outcomeReason: 'runtime_lost' as const,
        durationMs: 10,
      };
      browserApiMock.automation.mockResolvedValueOnce({
        ok: true,
        completed: false,
        receipt: unknownReceipt,
      });
      const unknown = await dispatchAppAction({
        requestId: 'unknown-receipt',
        source: 'assistant',
        action,
      });
      expect(unknown).toMatchObject({
        ok: true,
        result: { ok: true, completed: false, receipt: unknownReceipt },
      });
      expect(unknown.result).not.toHaveProperty('browser');

      const timeoutDetails = {
        actionId: 'timed-out-fill',
        sequence: 3,
        kind: 'fill' as const,
        status: 'not_executed' as const,
        durationMs: 8_000,
      };
      browserApiMock.automation.mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'timeout',
          message: 'Browser automation timed out.',
          details: timeoutDetails,
        },
      });
      const timedOut = await dispatchAppAction({
        requestId: 'timeout-receipt',
        source: 'assistant',
        action,
      });
      expect(timedOut).toMatchObject({
        ok: false,
        error: {
          code: 'timeout',
          details: timeoutDetails,
        },
      });

      const invalidPayloadDetails = {
        actionId: 'invalid-fill',
        sequence: 4,
        kind: 'fill' as const,
        status: 'not_executed' as const,
        durationMs: 0,
      };
      browserApiMock.automation.mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'invalid_payload',
          message: 'Browser automation payload was invalid.',
          details: invalidPayloadDetails,
        },
      });
      const invalidPayload = await dispatchAppAction({
        requestId: 'invalid-payload-receipt',
        source: 'assistant',
        action,
      });
      expect(invalidPayload).toMatchObject({
        ok: false,
        error: {
          code: 'invalid_payload',
          details: invalidPayloadDetails,
        },
      });
    });

    it('restores the focused composer element after browser automation', async () => {
      const browserId = seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3000',
      });
      await useBrowserStore
        .getState()
        .ensureLiveView('project-1', 'worktree-1', browserId);
      const composer = document.createElement('textarea');
      const browserPanel = document.createElement('button');
      document.body.append(composer);
      document.body.append(browserPanel);
      composer.focus();
      const focusSpy = jest.spyOn(composer, 'focus');
      browserApiMock.automation.mockImplementationOnce(() => {
        browserPanel.focus();
        return Promise.resolve({
          ok: true,
          completed: true,
          browser: browserSnapshot({ id: browserId }),
        });
      });

      const response = await dispatchAppAction({
        requestId: 'req-browser-fill-preserves-composer-focus',
        source: 'assistant',
        action: {
          type: 'browser.fill',
          expectedRuntimeGeneration: 4,
          locator: '#agent-input',
          text: 'agent text',
        },
      });

      expect(response.ok).toBe(true);
      expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
      expect(document.activeElement).toBe(composer);
      composer.remove();
      browserPanel.remove();
    });

    it('respects a user focus change while browser automation is running', async () => {
      const browserId = seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3000',
      });
      await useBrowserStore
        .getState()
        .ensureLiveView('project-1', 'worktree-1', browserId);
      const composer = document.createElement('textarea');
      const otherControl = document.createElement('button');
      document.body.append(composer, otherControl);
      composer.focus();
      const focusSpy = jest.spyOn(composer, 'focus');
      browserApiMock.automation.mockImplementationOnce(() => {
        otherControl.dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true }),
        );
        otherControl.focus();
        return Promise.resolve({
          ok: true,
          completed: true,
          browser: browserSnapshot({ id: browserId }),
        });
      });

      const response = await dispatchAppAction({
        requestId: 'req-browser-fill-respects-user-focus',
        source: 'assistant',
        action: {
          type: 'browser.fill',
          expectedRuntimeGeneration: 4,
          locator: '#agent-input',
          text: 'agent text',
        },
      });

      expect(response.ok).toBe(true);
      expect(focusSpy).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(otherControl);
      composer.remove();
      otherControl.remove();
    });

    it('respects user interaction inside the native browser view', async () => {
      const browserId = seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3000',
      });
      await useBrowserStore
        .getState()
        .ensureLiveView('project-1', 'worktree-1', browserId);
      const composer = document.createElement('textarea');
      const browserPanel = document.createElement('button');
      document.body.append(composer, browserPanel);
      composer.focus();
      const focusSpy = jest.spyOn(composer, 'focus');
      browserApiMock.automation.mockImplementationOnce(() => {
        browserPanel.focus();
        noteBrowserUserInteraction();
        return Promise.resolve({
          ok: true,
          completed: true,
          browser: browserSnapshot({ id: browserId }),
        });
      });

      const response = await dispatchAppAction({
        requestId: 'req-browser-fill-respects-native-browser-input',
        source: 'assistant',
        action: {
          type: 'browser.fill',
          expectedRuntimeGeneration: 4,
          locator: '#agent-input',
          text: 'agent text',
        },
      });

      expect(response.ok).toBe(true);
      expect(focusSpy).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(browserPanel);
      composer.remove();
      browserPanel.remove();
    });

    it('browser dialog actions read and handle the active browser dialog', async () => {
      const browserId = seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3000',
      });
      await useBrowserStore
        .getState()
        .ensureLiveView('project-1', 'worktree-1', browserId);
      const dialog = {
        id: 'dialog-1',
        browserId,
        type: 'prompt' as const,
        message: 'Name',
        defaultPrompt: 'initial',
        url: 'http://localhost:3000',
        openedAt: 1,
      };
      browserApiMock.getDialog.mockResolvedValueOnce(dialog);
      browserApiMock.getFileChooser.mockResolvedValueOnce(null);
      browserApiMock.getPrintRequest.mockResolvedValueOnce(null);
      browserApiMock.getAuthRequest.mockResolvedValueOnce(null);
      browserApiMock.handleDialog.mockResolvedValueOnce({
        dialog,
        accept: true,
        promptText: 'updated',
      });

      const getResponse = await dispatchAppAction({
        requestId: 'req-browser-get-dialog',
        source: 'assistant',
        action: { type: 'browser.get_dialog', expectedRuntimeGeneration: 1 },
      });
      const handleResponse = await dispatchAppAction({
        requestId: 'req-browser-handle-dialog',
        source: 'assistant',
        action: {
          type: 'browser.handle_dialog',
          expectedRuntimeGeneration: 1,
          dialogId: dialog.id,
          accept: true,
          promptText: 'updated',
        },
      });

      expect(browserApiMock.getDialog).toHaveBeenCalledWith({ browserId });
      expect(browserApiMock.handleDialog).toHaveBeenCalledWith({
        browserId,
        dialogId: dialog.id,
        accept: true,
        promptText: 'updated',
      });
      expect(getResponse.result).toMatchObject({
        browser: { id: browserId },
        dialog: { id: dialog.id },
        fileChooser: null,
        printRequest: null,
        auth: null,
      });
      expect(handleResponse.result).toMatchObject({
        browser: { id: browserId },
        handled: {
          accept: true,
          promptText: 'updated',
          dialog: { id: dialog.id },
        },
      });
    });

    it('browser.handle_dialog dismisses a file chooser and refuses to accept one', async () => {
      const browserId = seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3000',
      });
      await useBrowserStore
        .getState()
        .ensureLiveView('project-1', 'worktree-1', browserId);
      browserApiMock.answerFileChooser.mockResolvedValueOnce({ ok: true });
      const handle = (accept: boolean): ReturnType<typeof dispatchAppAction> =>
        dispatchAppAction({
          requestId: `req-browser-chooser-${String(accept)}`,
          source: 'assistant',
          action: {
            type: 'browser.handle_dialog',
            expectedRuntimeGeneration: 1,
            dialogId: 'chooser-1',
            accept,
          },
        });

      await expect(handle(true)).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'invalid_target',
          details: { error: { code: 'unsupported_control' } },
        },
      });
      expect(browserApiMock.answerFileChooser).not.toHaveBeenCalled();
      await expect(handle(false)).resolves.toMatchObject({
        ok: true,
        result: { handled: { fileChooserId: 'chooser-1', accept: false } },
      });
      expect(browserApiMock.answerFileChooser).toHaveBeenCalledWith({
        browserId,
        chooserId: 'chooser-1',
        answer: 'dismiss',
      });
      expect(browserApiMock.handleDialog).not.toHaveBeenCalled();
    });

    it('browser.handle_dialog saves or dismisses a print request, and reports one no longer pending', async () => {
      const browserId = seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3000',
      });
      await useBrowserStore
        .getState()
        .ensureLiveView('project-1', 'worktree-1', browserId);
      browserApiMock.answerPrintRequest
        .mockResolvedValueOnce({ ok: true, transfer: { id: 'download-1' } })
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: false,
          error: { code: 'not_found', message: 'gone' },
        });
      let calls = 0;
      const handle = (accept: boolean): ReturnType<typeof dispatchAppAction> =>
        dispatchAppAction({
          requestId: `req-browser-print-${String((calls += 1))}`,
          source: 'assistant',
          action: {
            type: 'browser.handle_dialog',
            expectedRuntimeGeneration: 1,
            dialogId: 'print-1',
            accept,
          },
        });

      await expect(handle(true)).resolves.toMatchObject({
        ok: true,
        result: {
          handled: {
            printRequestId: 'print-1',
            accept: true,
            transfer: { id: 'download-1' },
          },
        },
      });
      await expect(handle(false)).resolves.toMatchObject({
        ok: true,
        result: { handled: { printRequestId: 'print-1', accept: false } },
      });
      await expect(handle(false)).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_target' },
      });
      expect(
        browserApiMock.answerPrintRequest.mock.calls.map(
          ([request]: [{ answer: string }]) => request.answer,
        ),
      ).toEqual(['save_pdf', 'dismiss', 'dismiss']);
      expect(browserApiMock.handleDialog).not.toHaveBeenCalled();
    });

    it('browser.handle_dialog cancels a sign-in and refuses to accept one for the user', async () => {
      const browserId = seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3000',
      });
      await useBrowserStore
        .getState()
        .ensureLiveView('project-1', 'worktree-1', browserId);
      browserApiMock.answerAuthRequest.mockResolvedValueOnce({ ok: true });
      let calls = 0;
      const handle = (accept: boolean): ReturnType<typeof dispatchAppAction> =>
        dispatchAppAction({
          requestId: `req-browser-auth-${String((calls += 1))}`,
          source: 'assistant',
          action: {
            type: 'browser.handle_dialog',
            expectedRuntimeGeneration: 1,
            dialogId: 'auth-1',
            accept,
          },
        });
      await expect(handle(true)).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'invalid_target',
          details: { error: { code: 'policy_denied' } },
        },
      });
      expect(browserApiMock.answerAuthRequest).not.toHaveBeenCalled();
      await expect(handle(false)).resolves.toMatchObject({
        ok: true,
        result: { handled: { authRequestId: 'auth-1', accept: false } },
      });
      expect(browserApiMock.answerAuthRequest).toHaveBeenCalledWith({
        browserId,
        authRequestId: 'auth-1',
        answer: 'cancel',
      });
      expect(browserApiMock.handleDialog).not.toHaveBeenCalled();
    });

    it('browser.save_pdf prints the active browser through main', async () => {
      const browserId = seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3000',
      });
      await useBrowserStore
        .getState()
        .ensureLiveView('project-1', 'worktree-1', browserId);
      browserApiMock.savePdf.mockResolvedValueOnce({
        ok: true,
        transfer: { id: 'download-1', fileName: 'invoice.pdf' },
      });

      const response = await dispatchAppAction({
        requestId: 'req-browser-save-pdf',
        source: 'assistant',
        action: {
          type: 'browser.save_pdf',
          expectedRuntimeGeneration: 1,
          fileName: 'invoice',
          landscape: true,
        },
      });

      expect(browserApiMock.savePdf).toHaveBeenCalledWith({
        browserId,
        expectedRuntimeGeneration: 1,
        fileName: 'invoice',
        landscape: true,
      });
      expect(response).toMatchObject({
        ok: true,
        result: { ok: true, transfer: { id: 'download-1' } },
      });
    });

    it('browser.click forwards a pre-armed dialog response and returns a pending dialog', async () => {
      const browserId = seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3000',
      });
      await useBrowserStore
        .getState()
        .ensureLiveView('project-1', 'worktree-1', browserId);
      browserApiMock.automation.mockResolvedValueOnce({
        ok: true,
        completed: false,
        browser: browserSnapshot({ id: browserId }),
        dialog: {
          id: 'dialog-1',
          browserId,
          type: 'confirm',
          message: 'Continue?',
          url: 'http://localhost:3000',
          openedAt: 1,
        },
      });

      const response = await dispatchAppAction({
        requestId: 'req-browser-click-dialog',
        source: 'assistant',
        action: {
          type: 'browser.click',
          expectedRuntimeGeneration: 1,
          locator: 'button.primary',
          dialogResponse: { accept: false },
        },
      });

      expect(browserApiMock.automation).toHaveBeenCalledWith({
        browserId,
        expectedRuntimeGeneration: 1,
        cancellationKey: 'req-browser-click-dialog',
        command: {
          kind: 'click',
          locator: 'button.primary',
          dialogResponse: { accept: false },
        },
      });
      expect(response.result).toMatchObject({
        completed: false,
        dialog: { id: 'dialog-1', type: 'confirm' },
      });

      browserApiMock.automation.mockResolvedValueOnce({
        ok: true,
        completed: true,
        browser: browserSnapshot({ id: browserId }),
        handledDialog: {
          accept: false,
          dialog: {
            id: 'dialog-2',
            browserId,
            type: 'confirm',
            message: 'Continue?',
            url: 'http://localhost:3000',
            openedAt: 2,
          },
        },
      });
      const handledResponse = await dispatchAppAction({
        requestId: 'req-browser-click-dialog-handled',
        source: 'assistant',
        action: {
          type: 'browser.click',
          expectedRuntimeGeneration: 1,
          locator: 'button.primary',
          dialogResponse: { accept: false },
        },
      });
      expect(handledResponse.result).toMatchObject({
        completed: true,
        handledDialog: {
          accept: false,
          dialog: { id: 'dialog-2', type: 'confirm' },
        },
      });
    });

    it('browser screenshot, inspect, and recording responses include the active browser', async () => {
      const browserId = seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3000',
      });
      await useBrowserStore
        .getState()
        .ensureLiveView('project-1', 'worktree-1', browserId);
      browserApiMock.screenshot.mockResolvedValueOnce({
        attachmentPath: '/tmp/shot.png',
        dataUrl: 'data:image/png;base64,large',
      });
      browserApiMock.inspect.mockResolvedValueOnce({
        browserId,
        tagName: 'button',
      });
      browserApiMock.stopRecording.mockResolvedValueOnce({
        browserId,
        recording: false,
        steps: [],
        playwrightScript: '',
      });

      const screenshotResponse = await dispatchAppAction({
        requestId: 'req-browser-screenshot',
        source: 'assistant',
        action: { type: 'browser.screenshot', expectedRuntimeGeneration: 1 },
      });
      const inspectResponse = await dispatchAppAction({
        requestId: 'req-browser-inspect',
        source: 'assistant',
        action: {
          type: 'browser.inspect',
          expectedRuntimeGeneration: 1,
          locator: 'button',
          frame: 'f-checkout-1',
        },
      });
      const recordingResponse = await dispatchAppAction({
        requestId: 'req-browser-stop-recording',
        source: 'assistant',
        action: {
          type: 'browser.stop_recording',
          expectedRuntimeGeneration: 1,
        },
      });

      expect(screenshotResponse.result).toMatchObject({
        browser: { id: browserId },
        screenshot: { attachmentPath: '/tmp/shot.png' },
      });
      const screenshotResult = screenshotResponse.result as {
        screenshot?: { dataUrl?: unknown };
      };
      expect(screenshotResult.screenshot?.dataUrl).toBeUndefined();
      expect(browserApiMock.inspect).toHaveBeenCalledWith(
        expect.objectContaining({ frame: 'f-checkout-1' }),
      );
      expect(inspectResponse.result).toMatchObject({
        browser: { id: browserId },
        element: { browserId, tagName: 'button' },
      });
      expect(recordingResponse.result).toMatchObject({
        browser: { id: browserId, recording: false },
        recording: { browserId, recording: false },
      });
    });

    it('browser.input_snapshot forwards filters and pagination', async () => {
      const browserId = seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3000',
      });
      await useBrowserStore
        .getState()
        .ensureLiveView('project-1', 'worktree-1', browserId);
      browserApiMock.inputSnapshot.mockResolvedValueOnce({
        browserId,
        url: 'http://localhost:3000',
        title: 'Local',
        viewport: { width: 800, height: 600 },
        scroll: { x: 1, y: 2, maxX: 30, maxY: 400 },
        capturedAt: '2026-07-16T00:00:00.000Z',
        filter: { frame: 'f-checkout-1', role: 'textbox', name: 'search' },
        offset: 10,
        limit: 5,
        total: 20,
        returned: 5,
        truncated: true,
        nextOffset: 15,
        inputs: [{ ref: 'input-11', tagName: 'input', disabled: false }],
      });

      const response = await dispatchAppAction({
        requestId: 'req-browser-input-snapshot',
        source: 'assistant',
        action: {
          type: 'browser.input_snapshot',
          expectedRuntimeGeneration: 1,
          frame: 'f-checkout-1',
          role: 'textbox',
          name: 'search',
          offset: 10,
          limit: 5,
        },
      });

      expect(browserApiMock.inputSnapshot).toHaveBeenCalledWith({
        browserId,
        filter: { frame: 'f-checkout-1', role: 'textbox', name: 'search' },
        offset: 10,
        limit: 5,
      });
      expect(response.result).toMatchObject({
        inputSnapshot: {
          viewport: { width: 800, height: 600 },
          scroll: { x: 1, y: 2, maxX: 30, maxY: 400 },
          truncated: true,
          nextOffset: 15,
          inputs: [{ ref: 'input-11' }],
        },
      });
    });

    it.each([
      ['browser.input_snapshot', 'frame_unavailable'],
      ['browser.inspect', 'target_ambiguous'],
      ['browser.inspect', 'invalid_locator'],
    ] as const)(
      'returns a %s read failure (%s) from the IPC rejection as an action failure (E3)',
      async (type, code) => {
        const browserId = seedRendererBrowser('project-1', 'worktree-1', {
          url: 'http://localhost:3000',
        });
        await useBrowserStore
          .getState()
          .ensureLiveView('project-1', 'worktree-1', browserId);
        const message = 'Plain message for the agent.';
        // What an IPC rejection of a read failure looks like in the renderer.
        const rejection = new Error(
          `Error invoking remote method 'browser:x': BrowserReadTargetError[${code}]: ${message}`,
        );
        browserApiMock.inputSnapshot.mockRejectedValueOnce(rejection);
        browserApiMock.inspect.mockRejectedValueOnce(rejection);
        const response = await dispatchAppAction({
          requestId: `req-${type}-${code}`,
          source: 'assistant',
          action:
            type === 'browser.input_snapshot'
              ? { type, expectedRuntimeGeneration: 1, frame: 'iframe#missing' }
              : { type, expectedRuntimeGeneration: 1, locator: 'button' },
        });
        const invalidLocator = code === 'invalid_locator';
        expect(response).toMatchObject({
          ok: false,
          error: {
            code: invalidLocator ? 'execution_failed' : 'invalid_target',
            message,
            details: {
              error: {
                code: invalidLocator ? 'execution_failed' : code,
                message,
                retryable: false,
              },
            },
          },
        });
        browserApiMock.inputSnapshot.mockReset();
        browserApiMock.inspect.mockReset();
      },
    );

    it('keeps other browser read errors as execution failures', async () => {
      const browserId = seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3000',
      });
      await useBrowserStore
        .getState()
        .ensureLiveView('project-1', 'worktree-1', browserId);
      browserApiMock.inspect.mockRejectedValueOnce(
        new Error(
          "Error invoking remote method 'browser:inspect': Error: Browser is destroyed.",
        ),
      );
      const response = await dispatchAppAction({
        requestId: 'req-inspect-other-error',
        source: 'assistant',
        action: {
          type: 'browser.inspect',
          expectedRuntimeGeneration: 1,
          locator: 'button',
        },
      });
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'execution_failed' },
      });
      expect(response.error).not.toHaveProperty('details');
    });

    it('rejects provided browser ids outside the selected worktree', async () => {
      seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3000',
      });
      const otherBrowserId = seedRendererBrowser('project-2', 'worktree-2', {
        url: 'http://localhost:3002',
      });

      const response = await dispatchAppAction({
        requestId: 'req-browser-cross-worktree',
        source: 'assistant',
        action: {
          type: 'browser.click',
          expectedRuntimeGeneration: 1,
          browserId: otherBrowserId,
          locator: 'button.primary',
        },
      });

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'not_found',
          message: 'No in-app browser is available for this worktree.',
        },
      });
      expect(browserApiMock.automation).not.toHaveBeenCalled();
    });

    it('phase07b save_download asks the chat the request came from', async () => {
      const browserId = seedRendererBrowser('project-1', 'worktree-1');
      await useBrowserStore
        .getState()
        .setActiveBrowser('project-1', 'worktree-1', browserId);
      const copy = {
        kind: 'copy',
        id: 'copy-1',
        browserId,
        sourceId: 'download-1',
        source: 'agent',
        destinationName: 'exports/report.csv',
        copiedBytes: 10,
        totalBytes: 10,
        status: 'complete',
        startedAt: 2,
        endedAt: 3,
      };
      browserApiMock.saveDownload.mockResolvedValue({
        ok: true,
        transfer: copy,
      });
      const chat = {
        projectId: 'app-advisor',
        worktreeId: 'entry-1',
        chatId: 'chat-1',
      };
      const action = {
        type: 'browser.save_download' as const,
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        expectedRuntimeGeneration: 1,
        downloadId: 'download-1',
        path: 'exports/report.csv',
        overwrite: true,
        timeoutMs: 5000,
      };
      const response = await dispatchAppAction({
        requestId: 'phase07b-save',
        source: 'assistant',
        originChat: chat,
        action,
      });

      expect(response).toMatchObject({
        ok: true,
        result: {
          browserId,
          ok: true,
          transfer: { kind: 'copy', status: 'complete' },
        },
      });
      expect(response.result).not.toHaveProperty('browser');
      expect(browserApiMock.saveDownload).toHaveBeenCalledWith({
        browserId,
        downloadId: 'download-1',
        path: 'exports/report.csv',
        overwrite: true,
        timeoutMs: 5000,
        approvalChat: chat,
      });

      await dispatchAppAction({
        requestId: 'phase07b-save-without-chat',
        source: 'assistant',
        action,
      });
      expect(browserApiMock.saveDownload).toHaveBeenLastCalledWith({
        browserId,
        downloadId: 'download-1',
        path: 'exports/report.csv',
        overwrite: true,
        timeoutMs: 5000,
      });
    });

    it.each([
      'https://example.test/page?secret=token#private-fragment',
      'file:///Users/private/local-report.csv',
    ])(
      'phase07 renderer transfer outputs omit snapshot URL %s',
      async (url) => {
        const browserId = seedRendererBrowser('project-1', 'worktree-1', {
          url,
        });
        await useBrowserStore
          .getState()
          .setActiveBrowser('project-1', 'worktree-1', browserId);
        const transfer = {
          kind: 'download',
          id: 'download-1',
          browserId,
          source: 'agent',
          origin: 'https://example.test/export',
          fileName: 'report.csv',
          receivedBytes: 10,
          totalBytes: 20,
          status: 'in_progress',
          startedAt: 1,
        };
        browserApiMock.listTransfers.mockResolvedValueOnce({
          transfers: [transfer],
          total: 1,
          offset: 2,
          limit: 50,
        });
        browserApiMock.transferCommand.mockResolvedValueOnce({
          ok: true,
          transfer: { ...transfer, status: 'cancelled' },
        });
        const list = await dispatchAppAction({
          requestId: 'phase07-list',
          source: 'assistant',
          action: {
            type: 'browser.list_transfers',
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            expectedRuntimeGeneration: 1,
            kind: 'download',
            status: 'in_progress',
            offset: 2,
            limit: 50,
          },
        });
        expect(list).toMatchObject({
          ok: true,
          result: {
            transfers: [transfer],
            total: 1,
            offset: 2,
            limit: 50,
          },
        });
        expect(browserApiMock.listTransfers).toHaveBeenCalledWith({
          browserId,
          kind: 'download',
          status: 'in_progress',
          offset: 2,
          limit: 50,
        });
        const cancel = await dispatchAppAction({
          requestId: 'phase07-cancel',
          source: 'assistant',
          action: {
            type: 'browser.cancel_transfer',
            browserId,
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            expectedRuntimeGeneration: 1,
            transferId: transfer.id,
          },
        });
        expect(cancel).toMatchObject({
          ok: true,
          result: {
            ok: true,
            transfer: { id: transfer.id, status: 'cancelled' },
          },
        });
        expect(browserApiMock.transferCommand).toHaveBeenCalledWith({
          kind: 'cancel',
          browserId,
          transferId: transfer.id,
        });
        for (const response of [list, cancel]) {
          expect(response.result).not.toHaveProperty('browser');
          expect(response.result).toHaveProperty('browserId', browserId);
          expect(JSON.stringify(response.result)).not.toMatch(
            /secret|private-fragment|file:\/\/|\/Users\/|[?#]/,
          );
          expect(JSON.stringify(response.result)).not.toMatch(
            /stagingPath|localPath|absolutePath|browser-files\//,
          );
        }
      },
    );

    it.each([{}, { downloadId: 'download-1' }])(
      'phase07 forwards wait_for download %j to automation',
      async (download) => {
        const browserId = seedRendererBrowser('project-1', 'worktree-1', {
          url: 'http://localhost:3000',
        });
        await useBrowserStore
          .getState()
          .setActiveBrowser('project-1', 'worktree-1', browserId);
        browserApiMock.automation.mockResolvedValueOnce({ ok: true });
        const response = await dispatchAppAction({
          requestId: 'phase07-wait',
          source: 'assistant',
          action: {
            type: 'browser.wait_for',
            expectedRuntimeGeneration: 1,
            download,
            actionId: 'download-wait',
            timeoutMs: 120000,
          },
        });
        expect(response.ok).toBe(true);
        expect(browserApiMock.automation).toHaveBeenCalledWith(
          expect.objectContaining({
            browserId,
            expectedRuntimeGeneration: 1,
            command: {
              kind: 'wait_for',
              download,
              actionId: 'download-wait',
              timeoutMs: 120000,
            },
          }),
        );
      },
    );

    it('browser.get_console caps rows and truncates agent-facing text and URLs', async () => {
      const browserId = seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3000',
      });
      await useBrowserStore
        .getState()
        .ensureLiveView('project-1', 'worktree-1', browserId);
      const longUrl = `http://localhost:3000/${'a'.repeat(600)}`;
      const longText = 'x'.repeat(2100);
      browserApiMock.getConsole.mockResolvedValueOnce(
        Array.from({ length: 205 }, (_, index) => ({
          id: `console-${index}`,
          browserId,
          timestamp: index,
          level: 'error',
          text: index === 0 ? longText : `message ${index}`,
          url: index === 0 ? longUrl : `http://localhost:3000/${index}`,
        })),
      );

      const response = await dispatchAppAction({
        requestId: 'req-browser-console',
        source: 'assistant',
        action: {
          type: 'browser.get_console',
          expectedRuntimeGeneration: 1,
          level: 'error',
        },
      });

      expect(response.ok).toBe(true);
      expect(browserApiMock.getConsole).toHaveBeenCalledWith({
        browserId,
        level: 'error',
        limit: 200,
      });
      const result = response.result as {
        browser: { id: string };
        entries: Array<{ text: string; url: string; truncated: boolean }>;
        returned: number;
        limit: number;
      };
      expect(result.browser.id).toBe(browserId);
      expect(result.returned).toBe(200);
      expect(result.limit).toBe(200);
      expect(result.entries).toHaveLength(200);
      expect(result.entries[0]).toMatchObject({
        text: 'x'.repeat(2000),
        url: longUrl.slice(0, 500),
        truncated: true,
      });
      expect(result.entries[1]).toMatchObject({ truncated: false });
    });

    it('browser.get_network caps rows and truncates agent-facing URLs', async () => {
      const browserId = seedRendererBrowser('project-1', 'worktree-1', {
        url: 'http://localhost:3000',
      });
      await useBrowserStore
        .getState()
        .ensureLiveView('project-1', 'worktree-1', browserId);
      const longUrl = `http://localhost:3000/${'b'.repeat(600)}`;
      browserApiMock.getNetwork.mockResolvedValueOnce(
        Array.from({ length: 205 }, (_, index) => ({
          id: `network-${index}`,
          browserId,
          requestId: `request-${index}`,
          timestamp: index,
          method: 'GET',
          url: index === 0 ? longUrl : `http://localhost:3000/${index}`,
          status: index === 0 ? 500 : 200,
          failed: index === 0,
        })),
      );

      const response = await dispatchAppAction({
        requestId: 'req-browser-network',
        source: 'assistant',
        action: {
          type: 'browser.get_network',
          expectedRuntimeGeneration: 1,
          failed: true,
          status: 500,
          urlContains: 'localhost',
        },
      });

      expect(response.ok).toBe(true);
      expect(browserApiMock.getNetwork).toHaveBeenCalledWith({
        browserId,
        failed: true,
        status: 500,
        urlContains: 'localhost',
        limit: 200,
      });
      const result = response.result as {
        browser: { id: string };
        entries: Array<{ url: string; truncated: boolean }>;
        returned: number;
        limit: number;
      };
      expect(result.browser.id).toBe(browserId);
      expect(result.returned).toBe(200);
      expect(result.limit).toBe(200);
      expect(result.entries).toHaveLength(200);
      expect(result.entries[0]).toMatchObject({
        url: longUrl.slice(0, 500),
        truncated: true,
      });
      expect(result.entries[1]).toMatchObject({ truncated: false });
    });

    it('browser.open_external opens a provided URL without requiring an active browser', async () => {
      const response = await dispatchAppAction({
        requestId: 'req-browser-open-explicit-external',
        source: 'assistant',
        action: {
          type: 'browser.open_external',
          expectedRuntimeGeneration: 1,
          url: 'http://localhost:3000',
        },
      });

      expect(response.ok).toBe(true);
      expect(browserApiMock.openExternal).toHaveBeenCalledWith({
        url: 'http://localhost:3000',
      });
      expect(response.result).toEqual({
        browser: null,
        openedUrl: 'http://localhost:3000',
      });
    });

    // The system browser stays http/https-only (see `isSafeExternalBrowserUrl`),
    // so both dispatchers must refuse a local file rather than let
    // `openExternal` reject.
    it('browser.open_external refuses an explicit local file target', async () => {
      const response = await dispatchAppAction({
        requestId: 'req-browser-open-external-file',
        source: 'assistant',
        action: {
          type: 'browser.open_external',
          expectedRuntimeGeneration: 1,
          url: '/Users/me/site/index.html',
        },
      });

      expect(response.ok).toBe(false);
      if (!response.ok) {
        expect(response.error?.code).toBe('invalid_target');
        expect(
          response.error?.message ?? 'Action failed without an error detail',
        ).toBe('Enter an http or https URL.');
      } else {
        throw new Error('Expected browser.open_external to refuse a file.');
      }
      expect(browserApiMock.openExternal).not.toHaveBeenCalled();
    });

    it.each(['javascript:alert(1)', 'ftp://example.com/file.txt', '~/site'])(
      'browser.open_external refuses unsupported target %s',
      async (url) => {
        const response = await dispatchAppAction({
          requestId: 'req-browser-open-external-unsupported',
          source: 'assistant',
          action: {
            type: 'browser.open_external',
            expectedRuntimeGeneration: 1,
            url,
          },
        });

        expect(response.ok).toBe(false);
        if (!response.ok) {
          expect(response.error?.code).toBe('invalid_target');
          expect(
            response.error?.message ?? 'Action failed without an error detail',
          ).toBe('Enter an http or https URL.');
        } else {
          throw new Error(
            'Expected browser.open_external to refuse an unsupported URL.',
          );
        }
        expect(browserApiMock.openExternal).not.toHaveBeenCalled();
      },
    );

    it('browser.open_external refuses a browser already sitting on a local file', async () => {
      const fileBrowserId = seedRendererBrowser('project-1', 'worktree-1', {
        url: 'file:///Users/me/site/index.html',
      });

      const response = await dispatchAppAction({
        requestId: 'req-browser-open-external-file-snapshot',
        source: 'assistant',
        action: {
          type: 'browser.open_external',
          expectedRuntimeGeneration: 1,
          browserId: fileBrowserId,
        },
      });

      expect(response.ok).toBe(false);
      if (!response.ok) {
        expect(response.error?.code).toBe('invalid_target');
        expect(
          response.error?.message ?? 'Action failed without an error detail',
        ).toBe('Enter an http or https URL.');
      } else {
        throw new Error('Expected browser.open_external to refuse a file.');
      }
      expect(browserApiMock.openExternal).not.toHaveBeenCalled();
    });
  });

  describe('watcher.* actions', () => {
    it('watcher.list returns all visible watchers from the global API', async () => {
      appAdvisorListWatchersMock.mockResolvedValueOnce([{ id: 'w1' }]);
      const response = await dispatchAppAction({
        requestId: 'req-watcher-list',
        source: 'assistant',
        action: { type: 'watcher.list' },
      });
      expect(response.ok).toBe(true);
      expect(response.result).toEqual({ watchers: [{ id: 'w1' }] });
    });

    it('watcher.get finds one watcher by id', async () => {
      appAdvisorListWatchersMock.mockResolvedValueOnce([
        { id: 'w1' },
        { id: 'w2' },
      ]);
      const response = await dispatchAppAction({
        requestId: 'req-watcher-get',
        source: 'assistant',
        action: { type: 'watcher.get', id: 'w2' },
      });
      expect(response.ok).toBe(true);
      expect(response.result).toEqual({ watcher: { id: 'w2' } });
    });

    it('watcher.delete can request subscriber notification', async () => {
      const response = await dispatchAppAction({
        requestId: 'req-watcher-delete',
        source: 'assistant',
        action: {
          type: 'watcher.delete',
          id: 'w1',
          notifySubscriber: true,
        },
      });
      expect(appAdvisorDeleteWatcherMock).toHaveBeenCalledWith({
        watcherId: 'w1',
        notifySubscriber: true,
      });
      expect(response.ok).toBe(true);
    });
  });

  describe('panel.* actions', () => {
    const PANEL_WORKTREE_KEY = makeWorktreePanelKey('project-1', 'worktree-1');

    const TWO_GROUP_LAYOUT: DefaultLayoutDescriptor = {
      orientation: 'horizontal',
      groups: [
        { kind: 'chat', groupId: 'group-a', panelId: 'panel-a' },
        { kind: 'terminal', groupId: 'group-b', panelId: 'panel-b' },
      ],
      containerSize: { width: 900, height: 600 },
    };

    const ONE_GROUP_LAYOUT: DefaultLayoutDescriptor = {
      orientation: 'horizontal',
      groups: [{ kind: 'chat', groupId: 'group-a', panelId: 'panel-a' }],
      containerSize: { width: 800, height: 600 },
    };

    function setupPanelLayout(
      descriptor: DefaultLayoutDescriptor = TWO_GROUP_LAYOUT,
    ): void {
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      });
      usePanelLayoutStore
        .getState()
        .initializeLayout(PANEL_WORKTREE_KEY, descriptor);
    }

    function panelLayout(): ReturnType<
      typeof usePanelLayoutStore.getState
    >['layouts'][string] {
      return usePanelLayoutStore.getState().layouts[PANEL_WORKTREE_KEY];
    }

    afterEach(() => {
      setPanelLayoutFixedTopology(PANEL_WORKTREE_KEY, false);
      useWorkspaceLayoutModeStore.setState({ entries: {} });
      const store = usePanelLayoutStore.getState();
      for (const key of Object.keys(store.layouts)) {
        store.disposeLayout(key);
      }
    });

    it('panel.split splits the active group by default and returns the new group id', async () => {
      setupPanelLayout();
      const response = await dispatchAppAction({
        requestId: 'req-panel-split-default',
        source: 'assistant',
        action: { type: 'panel.split', direction: 'right' },
      });

      expect(response.ok).toBe(true);
      const newGroupId = readStringField(response.result, 'newGroupId');
      expect(typeof newGroupId).toBe('string');
      const layout = panelLayout();
      expect(Object.keys(layout.groups)).toHaveLength(3);
      expect(layout.activeGroupId).toBe(newGroupId);
    });

    it('panel.split targets an explicit groupId', async () => {
      setupPanelLayout();
      const response = await dispatchAppAction({
        requestId: 'req-panel-split-explicit',
        source: 'assistant',
        action: { type: 'panel.split', groupId: 'group-b', direction: 'down' },
      });

      expect(response.ok).toBe(true);
      const newGroupId = readStringField(response.result, 'newGroupId');
      // Per-entity split decision: an unseeded split creates an EMPTY group
      // next to the target (cloning would duplicate an entity binding).
      const layout = panelLayout();
      const newGroup =
        newGroupId !== undefined ? layout.groups[newGroupId] : undefined;
      expect(newGroup).toBeDefined();
      expect(newGroup?.tabs).toEqual([]);
      expect(newGroup?.activePanelId).toBeNull();
      expect(layout.activeGroupId).toBe(newGroupId);
    });

    it('panel.split fails with surface_unavailable when no worktree is selected', async () => {
      const response = await dispatchAppAction({
        requestId: 'req-panel-split-no-worktree',
        source: 'assistant',
        action: { type: 'panel.split', direction: 'right' },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('surface_unavailable');
      expect(response.error?.retryable).toBe(true);
    });

    it('panel.split fails with surface_unavailable when the layout is not built yet', async () => {
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      });

      const response = await dispatchAppAction({
        requestId: 'req-panel-split-no-layout',
        source: 'assistant',
        action: { type: 'panel.split', direction: 'right' },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('surface_unavailable');
      expect(response.error?.retryable).toBe(true);
    });

    it('panel.split rejects an unknown direction as invalid_payload', async () => {
      setupPanelLayout();
      const response = await dispatchAppAction({
        requestId: 'req-panel-split-bad-direction',
        source: 'assistant',
        action: {
          type: 'panel.split',
          direction: 'sideways',
        },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('invalid_payload');
    });

    it('panel.focus activates a group and rejects unknown groups', async () => {
      setupPanelLayout();
      const focused = await dispatchAppAction({
        requestId: 'req-panel-focus',
        source: 'assistant',
        action: { type: 'panel.focus', groupId: 'group-b' },
      });
      expect(focused.ok).toBe(true);
      expect(panelLayout().activeGroupId).toBe('group-b');

      const missing = await dispatchAppAction({
        requestId: 'req-panel-focus-missing',
        source: 'assistant',
        action: { type: 'panel.focus', groupId: 'group-nope' },
      });
      expect(missing.ok).toBe(false);
      expect(missing.error?.code).toBe('not_found');
    });

    it('panel.close closes an explicit group and refuses the last group', async () => {
      setupPanelLayout();
      const closed = await dispatchAppAction({
        requestId: 'req-panel-close',
        source: 'assistant',
        action: { type: 'panel.close', groupId: 'group-b' },
      });
      expect(closed.ok).toBe(true);
      expect(Object.keys(panelLayout().groups)).toEqual(['group-a']);

      const lastGroup = await dispatchAppAction({
        requestId: 'req-panel-close-last',
        source: 'assistant',
        action: { type: 'panel.close' },
      });
      expect(lastGroup.ok).toBe(false);
      expect(lastGroup.error?.code).toBe('invalid_target');
    });

    it('panel.close reports a rejected Minimal topology mutation', async () => {
      setupPanelLayout();
      setPanelLayoutFixedTopology(PANEL_WORKTREE_KEY, true);

      const response = await dispatchAppAction({
        requestId: 'req-panel-close-minimal',
        source: 'assistant',
        action: { type: 'panel.close', groupId: 'group-b' },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('invalid_target');
      expect(Object.keys(panelLayout().groups)).toEqual(['group-a', 'group-b']);
    });

    it('panel.set_layout_mode changes the selected worktree mode', async () => {
      setupPanelLayout();
      useWorkspaceLayoutModeStore.setState({
        entries: {
          [PANEL_WORKTREE_KEY]: {
            mode: 'minimal',
            status: 'ready',
            requestId: 1,
          },
        },
      });
      setPanelLayoutFixedTopology(PANEL_WORKTREE_KEY, true);

      const response = await dispatchAppAction({
        requestId: 'req-panel-set-layout-mode',
        source: 'assistant',
        action: { type: 'panel.set_layout_mode', mode: 'advanced' },
      });

      expect(response.ok).toBe(true);
      expect(panelLayoutApiMock.saveWorktreeMode).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        mode: 'advanced',
      });
      expect(
        useWorkspaceLayoutModeStore.getState().entries[PANEL_WORKTREE_KEY]
          ?.mode,
      ).toBe('advanced');
    });

    it('panel.maximize maximizes and restores a group', async () => {
      setupPanelLayout();
      const maximized = await dispatchAppAction({
        requestId: 'req-panel-maximize',
        source: 'assistant',
        action: { type: 'panel.maximize', groupId: 'group-b', maximized: true },
      });
      expect(maximized.ok).toBe(true);
      expect(panelLayout().maximizedGroupId).toBe('group-b');

      const restored = await dispatchAppAction({
        requestId: 'req-panel-restore',
        source: 'assistant',
        action: { type: 'panel.maximize', maximized: false },
      });
      expect(restored.ok).toBe(true);
      expect(panelLayout().maximizedGroupId).toBeNull();

      // Restoring again with nothing maximized is an idempotent no-op.
      const idempotent = await dispatchAppAction({
        requestId: 'req-panel-restore-again',
        source: 'assistant',
        action: { type: 'panel.maximize', maximized: false },
      });
      expect(idempotent.ok).toBe(true);
    });

    it('panel.maximize rejects a single-group layout as invalid_target', async () => {
      setupPanelLayout(ONE_GROUP_LAYOUT);
      const response = await dispatchAppAction({
        requestId: 'req-panel-maximize-single',
        source: 'assistant',
        action: { type: 'panel.maximize', maximized: true },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('invalid_target');
    });

    it('panel.add_tab appends and activates a tab in the active group', async () => {
      setupPanelLayout();
      const response = await dispatchAppAction({
        requestId: 'req-panel-add-tab',
        source: 'assistant',
        action: { type: 'panel.add_tab', kind: 'browser' },
      });

      expect(response.ok).toBe(true);
      const panelId = readStringField(response.result, 'panelId');
      expect(typeof panelId).toBe('string');
      const group = panelLayout().groups['group-a'];
      expect(group.tabs.map((tab) => tab.kind)).toEqual(['chat', 'browser']);
      expect(group.activePanelId).toBe(panelId);
    });

    it('panel.add_tab refuses a Browser tab in a window that shows another computer', async () => {
      setupPanelLayout();
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          ...window.api,
          remoteControl: {
            getContext: () => ({
              mode: 'remote',
              deviceId: 'device-b',
              name: 'Studio',
              platform: 'darwin',
            }),
          },
        },
      });
      const before = panelLayout();

      const response = await dispatchAppAction({
        requestId: 'req-panel-add-browser-remote',
        source: 'assistant',
        action: { type: 'panel.add_tab', kind: 'browser' },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('surface_unavailable');
      expect(panelLayout()).toEqual(before);
    });

    it('panel.add_tab gates Cursor usage before mutating the layout', async () => {
      setupPanelLayout();
      setFeatureFlagForTest(
        CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key,
        false,
      );
      const before = panelLayout();
      const denied = await dispatchAppAction({
        requestId: 'cursor-usage-disabled',
        source: 'assistant',
        action: { type: 'panel.add_tab', kind: 'usage', variant: 'cursor' },
      });
      expect(denied.ok).toBe(false);
      expect(panelLayout()).toEqual(before);
      setFeatureFlagForTest(
        CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key,
        true,
      );
      const allowed = await dispatchAppAction({
        requestId: 'cursor-usage-enabled',
        source: 'assistant',
        action: { type: 'panel.add_tab', kind: 'usage', variant: 'cursor' },
      });
      expect(allowed.ok).toBe(true);
      expect(panelLayout().groups['group-a'].tabs).toContainEqual(
        expect.objectContaining({
          kind: 'usage',
          instance: { variant: 'cursor' },
        }),
      );
    });

    it('panel.add_tab adds the Ledger panel only while the Ledger is on', async () => {
      setupPanelLayout();
      setFeatureFlagForTest(
        CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key,
        false,
      );
      const before = panelLayout();
      const denied = await dispatchAppAction({
        requestId: 'ledger-disabled',
        source: 'assistant',
        action: { type: 'panel.add_tab', kind: 'ledger' },
      });
      expect(denied).toMatchObject({
        ok: false,
        error: { code: 'surface_unavailable' },
      });
      expect(panelLayout()).toEqual(before);

      setFeatureFlagForTest(CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key, true);
      const allowed = await dispatchAppAction({
        requestId: 'ledger-enabled',
        source: 'assistant',
        action: { type: 'panel.add_tab', kind: 'ledger' },
      });
      expect(allowed.ok).toBe(true);
      expect(panelLayout().groups['group-a'].tabs).toContainEqual(
        expect.objectContaining({ kind: 'ledger' }),
      );
    });

    describe('cost panels, with Early access off', () => {
      afterEach(() => {
        setTestEarlyAccessFeatures({
          enabled: false,
          hydrated: true,
        });
      });

      it('panel.add_tab adds the Cost panel once and reveals it after that', async () => {
        setupPanelLayout();
        setTestEarlyAccessFeatures({
          enabled: false,
          hydrated: true,
        });
        const first = await dispatchAppAction({
          requestId: 'cost-add-1',
          source: 'assistant',
          action: { type: 'panel.add_tab', kind: 'cost', groupId: 'group-a' },
        });
        expect(first.ok).toBe(true);
        const panelId = readStringField(first.result, 'panelId');
        const second = await dispatchAppAction({
          requestId: 'cost-add-2',
          source: 'assistant',
          action: { type: 'panel.add_tab', kind: 'cost' },
        });
        expect(second.ok).toBe(true);
        expect(readStringField(second.result, 'panelId')).toBe(panelId);
        const costTabs = Object.values(panelLayout().groups).flatMap((group) =>
          group.tabs.filter((tab) => tab.kind === 'cost'),
        );
        expect(costTabs).toHaveLength(1);
        expect(costTabs[0]?.instance).toBeUndefined();
      });

      it('panel.add_tab binds a Session breakdown to its chat, one per chat', async () => {
        setupPanelLayout();
        setTestEarlyAccessFeatures({
          enabled: false,
          hydrated: true,
        });
        for (const chatId of ['c-1', 'c-2', 'c-1']) {
          const response = await dispatchAppAction({
            requestId: `breakdown-${chatId}-${Math.random()}`,
            source: 'assistant',
            action: {
              type: 'panel.add_tab',
              kind: 'session-breakdown',
              chatId,
              groupId: 'group-a',
            },
          });
          expect(response.ok).toBe(true);
        }
        const bound = Object.values(panelLayout().groups).flatMap((group) =>
          group.tabs
            .filter((tab) => tab.kind === 'session-breakdown')
            .map((tab) => tab.instance?.chatId),
        );
        expect(bound.sort()).toEqual(['c-1', 'c-2']);
      });

      it('panel.add_tab rejects a Session breakdown without a chat', async () => {
        setupPanelLayout();
        setTestEarlyAccessFeatures({
          enabled: false,
          hydrated: true,
        });
        const response = await dispatchAppAction({
          requestId: 'breakdown-no-chat',
          source: 'assistant',
          action: JSON.parse(
            '{"type":"panel.add_tab","kind":"session-breakdown"}',
          ),
        });
        expect(response.ok).toBe(false);
      });
    });

    it('sends a failed Ledger add again for the same request, so the Ledger can return what it recorded', async () => {
      setFeatureFlagForTest(CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key, true);
      const addEntry = jest
        .fn()
        .mockRejectedValueOnce(new Error('IPC reply lost'))
        .mockResolvedValueOnce({
          status: 'ok',
          value: {
            entry: {
              entryId: 'entry-1',
              revision: 1,
              type: 'TASK',
              title: 'Write the release notes',
              status: 'TODO',
            },
          },
        });
      Object.assign(window.api, { ledger: { addEntry } });
      const request = {
        requestId: 'ledger-add-retry',
        source: 'assistant' as const,
        action: {
          type: 'ledger.add_entry',
          projectId: 'project-1',
          worktreeId: 'wt-1',
          entryType: 'TASK',
          title: 'Write the release notes',
          content: 'Cover the Ledger panel.',
        },
      };

      const lost = await dispatchAppAction(request);
      expect(lost.ok).toBe(false);
      const retried = await dispatchAppAction(request);
      expect(retried).toMatchObject({
        ok: true,
        result: { entryId: 'entry-1', revision: 1 },
      });
      // Both sends carry the request's key: the Ledger records it once.
      expect(addEntry).toHaveBeenCalledTimes(2);
      for (const call of [1, 2]) {
        expect(addEntry).toHaveBeenNthCalledWith(
          call,
          expect.objectContaining({ requestKey: 'advisor:ledger-add-retry' }),
        );
      }

      // A recorded add answers again from the dispatcher.
      expect(await dispatchAppAction(request)).toEqual(retried);
      expect(addEntry).toHaveBeenCalledTimes(2);
    });

    it('refuses a malformed Ledger action before running it', async () => {
      setFeatureFlagForTest(CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key, true);
      for (const [requestId, action] of [
        [
          'ledger-summary',
          {
            type: 'ledger.add_entry',
            entryType: 'SUMMARY',
            title: 'A',
            content: 'B',
          },
        ],
        [
          'ledger-highlights',
          {
            type: 'ledger.add_entry',
            entryType: 'TASK',
            title: 'A',
            content: 'B',
            highlights: ['1', '2', '3', '4', '5', '6'],
          },
        ],
        ['ledger-status', { type: 'ledger.search', statuses: ['DONE'] }],
        ['ledger-scope', { type: 'ledger.open', projectId: 'project-1' }],
      ] as const) {
        const response = await dispatchAppAction({
          requestId,
          source: 'assistant',
          action,
        });
        expect(response).toMatchObject({
          ok: false,
          error: { code: 'invalid_payload' },
        });
      }
    });

    it('panel.add_tab gates Copilot usage before mutating the layout', async () => {
      setupPanelLayout();
      setFeatureFlagForTest(
        CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key,
        false,
      );
      const before = panelLayout();
      const denied = await dispatchAppAction({
        requestId: 'copilot-usage-disabled',
        source: 'assistant',
        action: { type: 'panel.add_tab', kind: 'usage', variant: 'copilot' },
      });
      expect(denied.ok).toBe(false);
      expect(panelLayout()).toEqual(before);
      setFeatureFlagForTest(
        CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key,
        true,
      );
      const allowed = await dispatchAppAction({
        requestId: 'copilot-usage-enabled',
        source: 'assistant',
        action: { type: 'panel.add_tab', kind: 'usage', variant: 'copilot' },
      });
      expect(allowed.ok).toBe(true);
      expect(panelLayout().groups['group-a'].tabs).toContainEqual(
        expect.objectContaining({
          kind: 'usage',
          instance: { variant: 'copilot' },
        }),
      );
    });

    it('panel.add_tab binds Usage tabs to a required recognized variant', async () => {
      setupPanelLayout();

      const missingVariant = await dispatchAppAction({
        requestId: 'req-panel-add-usage-missing-variant',
        source: 'assistant',
        action: { type: 'panel.add_tab', kind: 'usage' },
      });
      expect(missingVariant.ok).toBe(false);
      expect(missingVariant.error?.code).toBe('invalid_payload');

      const invalidVariant = await dispatchAppAction({
        requestId: 'req-panel-add-usage-invalid-variant',
        source: 'assistant',
        action: {
          type: 'panel.add_tab',
          kind: 'usage',
          variant: 'other',
        },
      });
      expect(invalidVariant.ok).toBe(false);
      expect(invalidVariant.error?.code).toBe('invalid_payload');

      const response = await dispatchAppAction({
        requestId: 'req-panel-add-usage-codex',
        source: 'assistant',
        action: { type: 'panel.add_tab', kind: 'usage', variant: 'codex' },
      });

      expect(response.ok).toBe(true);
      const panelId = readStringField(response.result, 'panelId');
      const usageTab = panelLayout().groups['group-a'].tabs.find(
        (tab) => tab.panelId === panelId,
      );
      expect(usageTab).toMatchObject({
        kind: 'usage',
        title: 'Usage (Codex)',
        instance: { variant: 'codex' },
      });
    });

    it.each([true, false])(
      'panel.add_tab respects Cursor rollout enabled=%s without changing a rejected layout',
      async (enabled) => {
        setupPanelLayout();
        const previous = useFeatureFlagsStore.getState().snapshot;
        useFeatureFlagsStore.setState({
          snapshot: {
            ...previous,
            values: {
              ...previous.values,
              'canopy-desktop-cursor-harness': enabled,
            },
          },
        });
        const before = panelLayout();
        try {
          const response = await dispatchAppAction({
            requestId: `req-panel-add-usage-cursor-${enabled}`,
            source: 'assistant',
            action: { type: 'panel.add_tab', kind: 'usage', variant: 'cursor' },
          });
          expect(response.ok).toBe(enabled);
          if (!enabled) {
            expect(response.error?.code).toBe('surface_unavailable');
            expect(panelLayout()).toEqual(before);
            return;
          }
          const panelId = readStringField(response.result, 'panelId');
          expect(
            panelLayout().groups['group-a'].tabs.find(
              (tab) => tab.panelId === panelId,
            ),
          ).toMatchObject({
            kind: 'usage',
            title: 'Usage (Cursor)',
            instance: { variant: 'cursor' },
          });
        } finally {
          useFeatureFlagsStore.setState({ snapshot: previous });
        }
      },
    );

    it('panel.add_tab binds Automations tabs to a required recognized variant', async () => {
      setupPanelLayout();

      const missingVariant = await dispatchAppAction({
        requestId: 'req-panel-add-automations-missing-variant',
        source: 'assistant',
        action: { type: 'panel.add_tab', kind: 'automations' },
      });
      expect(missingVariant.ok).toBe(false);
      expect(missingVariant.error?.code).toBe('invalid_payload');

      const invalidVariant = await dispatchAppAction({
        requestId: 'req-panel-add-automations-invalid-variant',
        source: 'assistant',
        action: {
          type: 'panel.add_tab',
          kind: 'automations',
          variant: 'all',
        },
      });
      expect(invalidVariant.ok).toBe(false);
      expect(invalidVariant.error?.code).toBe('invalid_payload');

      const response = await dispatchAppAction({
        requestId: 'req-panel-add-automations-overview',
        source: 'assistant',
        action: {
          type: 'panel.add_tab',
          kind: 'automations',
          variant: 'overview',
        },
      });

      expect(response.ok).toBe(true);
      const panelId = readStringField(response.result, 'panelId');
      const automationsTab = panelLayout().groups['group-a'].tabs.find(
        (tab) => tab.panelId === panelId,
      );
      expect(automationsTab).toMatchObject({
        kind: 'automations',
        title: 'Automations (Overview)',
        instance: { variant: 'overview' },
      });
    });

    it('panel.add_tab opens a plan document in the requested group', async () => {
      setupPanelLayout();
      openPlanPanelMock.mockResolvedValueOnce({
        status: 'placed',
        location: {
          layoutKey: PANEL_WORKTREE_KEY,
          groupId: 'group-b',
          panelId: 'panel-plan-plan-1',
        },
      });

      const response = await dispatchAppAction({
        requestId: 'req-panel-add-plan',
        source: 'assistant',
        action: {
          type: 'panel.add_tab',
          kind: 'plan',
          planId: 'plan-1',
          groupId: 'group-b',
        },
      });

      expect(openPlanPanelMock).toHaveBeenCalledWith(
        { projectId: 'project-1', worktreeId: 'worktree-1' },
        'plan-1',
        { intent: { groupId: 'group-b', layoutKey: PANEL_WORKTREE_KEY } },
      );
      expect(openPlanDiagramPanelMock).not.toHaveBeenCalled();
      expect(response.ok).toBe(true);
      expect(response.result).toEqual({ panelId: 'panel-plan-plan-1' });
    });

    it('panel.add_tab opens a plan diagram on its own through the diagram opener', async () => {
      setupPanelLayout();
      openPlanDiagramPanelMock.mockResolvedValueOnce({
        status: 'revealed',
        location: {
          layoutKey: PANEL_WORKTREE_KEY,
          groupId: 'group-a',
          panelId: 'panel-plan-diagram-plan-1',
        },
      });

      const response = await dispatchAppAction({
        requestId: 'req-panel-add-plan-diagram',
        source: 'assistant',
        action: {
          type: 'panel.add_tab',
          kind: 'plan-diagram',
          planId: 'plan-1',
          groupId: 'group-a',
        },
      });

      expect(openPlanDiagramPanelMock).toHaveBeenCalledWith(
        { projectId: 'project-1', worktreeId: 'worktree-1' },
        'plan-1',
        { intent: { groupId: 'group-a', layoutKey: PANEL_WORKTREE_KEY } },
      );
      expect(openPlanPanelMock).not.toHaveBeenCalled();
      expect(response.ok).toBe(true);
      expect(response.result).toEqual({
        panelId: 'panel-plan-diagram-plan-1',
      });
    });

    it('panel.add_tab opens the Chat visuals panel for a chat beside it', async () => {
      setupPanelLayout();
      openDesktopChatVisualsPanelMock.mockResolvedValueOnce({
        status: 'placed',
        location: {
          layoutKey: PANEL_WORKTREE_KEY,
          groupId: 'group-b',
          panelId: 'panel-chat-visuals',
        },
      });

      const response = await dispatchAppAction({
        requestId: 'req-panel-add-chat-visuals',
        source: 'assistant',
        action: {
          type: 'panel.add_tab',
          kind: 'chat-visuals',
          chatTabId: 'chat-1',
        },
      });

      expect(openDesktopChatVisualsPanelMock).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      });
      expect(response.ok).toBe(true);
      expect(response.result).toEqual({ panelId: 'panel-chat-visuals' });
    });

    it('panel.add_tab reports a Chat visuals panel whose chat is not open', async () => {
      setupPanelLayout();
      openDesktopChatVisualsPanelMock.mockResolvedValueOnce({
        status: 'missing-chat',
      });

      const missing = await dispatchAppAction({
        requestId: 'req-panel-add-chat-visuals-missing',
        source: 'assistant',
        action: {
          type: 'panel.add_tab',
          kind: 'chat-visuals',
          chatTabId: 'chat-gone',
        },
      });
      const unbound = await dispatchAppAction({
        requestId: 'req-panel-add-chat-visuals-unbound',
        source: 'assistant',
        action: { type: 'panel.add_tab', kind: 'chat-visuals' },
      });

      expect(missing.ok).toBe(false);
      expect(missing.error?.code).toBe('not_found');
      expect(unbound.ok).toBe(false);
      expect(unbound.error?.code).toBe('invalid_payload');
    });

    it('panel.add_tab reveals an open Subagents panel instead of adding a second one', async () => {
      setupPanelLayout();
      const before = panelLayout();
      openSubagentsPanelMock.mockResolvedValueOnce({
        status: 'revealed',
        location: {
          layoutKey: `${PANEL_WORKTREE_KEY}#aux:one`,
          groupId: 'group-aux',
          panelId: 'panel-subagents',
        },
      });

      const response = await dispatchAppAction({
        requestId: 'req-panel-add-subagents-group',
        source: 'assistant',
        action: {
          type: 'panel.add_tab',
          kind: 'subagents',
          groupId: 'group-b',
        },
      });

      expect(openSubagentsPanelMock).toHaveBeenCalledWith(
        { projectId: 'project-1', worktreeId: 'worktree-1' },
        { intent: { groupId: 'group-b', layoutKey: PANEL_WORKTREE_KEY } },
      );
      expect(response.ok).toBe(true);
      expect(response.result).toEqual({ panelId: 'panel-subagents' });
      expect(panelLayout()).toBe(before);
    });

    it('panel.add_tab uses automatic placement for Subagents without groupId', async () => {
      setupPanelLayout();
      openSubagentsPanelMock.mockResolvedValueOnce({
        status: 'placed',
        location: {
          layoutKey: PANEL_WORKTREE_KEY,
          groupId: 'group-b',
          panelId: 'panel-subagents',
        },
      });

      const response = await dispatchAppAction({
        requestId: 'req-panel-add-subagents-auto',
        source: 'assistant',
        action: { type: 'panel.add_tab', kind: 'subagents' },
      });

      expect(openSubagentsPanelMock).toHaveBeenCalledWith(
        { projectId: 'project-1', worktreeId: 'worktree-1' },
        { intent: 'auto' },
      );
      expect(response.result).toEqual({ panelId: 'panel-subagents' });
    });

    it('panel.add_tab requires a planId for plan kinds and refuses it elsewhere', async () => {
      setupPanelLayout();
      const before = panelLayout();

      for (const kind of ['plan', 'plan-diagram']) {
        for (const binding of [{}, { planId: '' }]) {
          const response = await dispatchAppAction({
            requestId: `req-panel-add-${kind}-${JSON.stringify(binding)}`,
            source: 'assistant',
            action: { type: 'panel.add_tab', kind, ...binding },
          });
          expect(response.ok).toBe(false);
          expect(response.error?.code).toBe('invalid_payload');
        }
      }
      const stray = await dispatchAppAction({
        requestId: 'req-panel-add-terminal-plan-id',
        source: 'assistant',
        action: {
          type: 'panel.add_tab',
          kind: 'terminal',
          planId: 'plan-1',
        },
      });
      expect(stray.ok).toBe(false);
      expect(stray.error?.code).toBe('invalid_payload');
      expect(openPlanPanelMock).not.toHaveBeenCalled();
      expect(openPlanDiagramPanelMock).not.toHaveBeenCalled();
      expect(panelLayout()).toBe(before);
    });

    it.each([
      ['unavailable', 'not_found'],
      ['failed', 'execution_failed'],
    ] as const)(
      'panel.add_tab maps a plan opener %s result to %s without changing the layout',
      async (status, code) => {
        setupPanelLayout();
        const before = panelLayout();
        openPlanPanelMock.mockResolvedValueOnce({ status });

        const response = await dispatchAppAction({
          requestId: `req-panel-add-plan-${status}`,
          source: 'assistant',
          action: { type: 'panel.add_tab', kind: 'plan', planId: 'plan-9' },
        });

        expect(response.ok).toBe(false);
        expect(response.error?.code).toBe(code);
        expect(panelLayout()).toBe(before);
      },
    );

    it('panel.add_tab forwards entity bindings required by panel kinds', async () => {
      setupPanelLayout();

      const chat = await dispatchAppAction({
        requestId: 'req-panel-add-chat-binding',
        source: 'assistant',
        action: {
          type: 'panel.add_tab',
          kind: 'chat',
          chatTabId: 'chat-bound',
        },
      });
      const fileDiff = await dispatchAppAction({
        requestId: 'req-panel-add-file-binding',
        source: 'assistant',
        action: {
          type: 'panel.add_tab',
          kind: 'file-diff',
          fileTabId: 'file-bound',
          filePath: '/workspace/example.ts',
        },
      });
      const activityCard = await dispatchAppAction({
        requestId: 'req-panel-add-activity-binding',
        source: 'assistant',
        action: {
          type: 'panel.add_tab',
          kind: 'activity-card',
          sectionId: 'changed-files',
        },
      });

      expect([chat.ok, fileDiff.ok, activityCard.ok]).toEqual([
        true,
        true,
        true,
      ]);
      expect(panelLayout().groups['group-a'].tabs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'chat',
            instance: { chatTabId: 'chat-bound' },
          }),
          expect.objectContaining({
            kind: 'file-diff',
            instance: {
              fileTabId: 'file-bound',
              filePath: '/workspace/example.ts',
            },
          }),
          expect.objectContaining({
            kind: 'activity-card',
            instance: { sectionId: 'changed-files' },
          }),
        ]),
      );
    });

    it('panel.add_tab creates and binds an empty file tab when no file binding is supplied', async () => {
      setupPanelLayout();

      const response = await dispatchAppAction({
        requestId: 'req-panel-add-empty-file',
        source: 'assistant',
        action: { type: 'panel.add_tab', kind: 'file-diff' },
      });

      expect(response.ok).toBe(true);
      const fileTab = useChatStore
        .getState()
        .worktreeChats[
          'project-1/worktree-1'
        ]?.tabs.find((tab) => tab.kind === 'file');
      expect(fileTab).toMatchObject({ title: 'Open file', filePath: '' });
      expect(panelLayout().groups['group-a'].tabs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'file-diff',
            instance: { fileTabId: fileTab?.id, filePath: '' },
          }),
        ]),
      );
    });

    it('file.open assigns the active empty file tab and collapses its tree', async () => {
      setupPanelLayout();
      const created = await dispatchAppAction({
        requestId: 'req-panel-add-empty-file-for-open',
        source: 'assistant',
        action: { type: 'panel.add_tab', kind: 'file-diff' },
      });
      expect(created.ok).toBe(true);

      const before = useChatStore.getState().worktreeChats[PANEL_WORKTREE_KEY];
      const emptyTab = before.tabs.find((tab) => tab.kind === 'file');
      expect(emptyTab).toMatchObject({ filePath: '' });

      const opened = await dispatchAppAction({
        requestId: 'req-open-into-empty-file',
        source: 'assistant',
        action: {
          type: 'file.open',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          path: '/repo/src/index.ts',
        },
      });

      expect(opened.ok).toBe(true);
      const after = useChatStore.getState().worktreeChats[PANEL_WORKTREE_KEY];
      expect(after.tabs.filter((tab) => tab.kind === 'file')).toHaveLength(1);
      expect(after.tabs.find((tab) => tab.id === emptyTab?.id)).toMatchObject({
        filePath: '/repo/src/index.ts',
        title: 'index.ts',
      });
      expect(
        useFileTabUiStore.getState().fileTreeVisibleByTabId[emptyTab?.id ?? ''],
      ).toBe(false);
    });

    it('panel.add_tab rejects entity-bound kinds without their bindings', async () => {
      setupPanelLayout();
      const malformed: Array<{ requestId: string; action: unknown }> = [
        {
          requestId: 'req-panel-add-chat-missing-binding',
          action: { type: 'panel.add_tab', kind: 'chat' },
        },
        {
          requestId: 'req-panel-add-activity-missing-binding',
          action: { type: 'panel.add_tab', kind: 'activity-card' },
        },
      ];

      for (const request of malformed) {
        const response = await dispatchAppAction({
          ...request,
          source: 'assistant',
        });
        expect(response.ok).toBe(false);
        expect(response.error?.code).toBe('invalid_payload');
      }
    });

    it('panel.add_tab rejects unknown kinds and unknown groups', async () => {
      setupPanelLayout();
      const badKind = await dispatchAppAction({
        requestId: 'req-panel-add-tab-bad-kind',
        source: 'assistant',
        action: {
          type: 'panel.add_tab',
          kind: 'video',
        },
      });
      expect(badKind.ok).toBe(false);
      expect(badKind.error?.code).toBe('invalid_payload');

      const badGroup = await dispatchAppAction({
        requestId: 'req-panel-add-tab-bad-group',
        source: 'assistant',
        action: {
          type: 'panel.add_tab',
          groupId: 'group-nope',
          kind: 'chat',
          chatTabId: 'chat-bound',
        },
      });
      expect(badGroup.ok).toBe(false);
      expect(badGroup.error?.code).toBe('not_found');
    });

    it('panel.add_tab rejects pipeline run panels, bound or not, without touching the layout', async () => {
      setupPanelLayout();
      const before = panelLayout();
      const requests: Array<{ requestId: string; action: unknown }> = [
        {
          requestId: 'req-panel-add-pipeline-unbound',
          action: { type: 'panel.add_tab', kind: 'pipeline-execution' },
        },
        {
          requestId: 'req-panel-add-pipeline-bound',
          action: {
            type: 'panel.add_tab',
            kind: 'pipeline-execution',
            executionId: 'run-1',
          },
        },
      ];

      for (const request of requests) {
        const response = await dispatchAppAction({
          ...request,
          source: 'assistant',
        });
        expect(response.ok).toBe(false);
        expect(response.error?.code).toBe('invalid_payload');
        expect(response.error?.message).toContain('pipeline.open_run');
      }
      expect(panelLayout()).toEqual(before);
      expect(
        __isValidAppAdvisorActionForTests({
          type: 'panel.add_tab',
          kind: 'pipeline-execution',
        }),
      ).toBe(false);
    });

    it('panel.add_tab rejects subagent-chat panels, bound or not', async () => {
      setupPanelLayout();
      const before = panelLayout();
      for (const action of [
        { type: 'panel.add_tab', kind: 'subagent-chat' },
        {
          type: 'panel.add_tab',
          kind: 'subagent-chat',
          rootChatId: 'chat-1',
          subagentId: 'agent-1',
          subagentKind: 'managed',
        },
      ]) {
        const response = await dispatchAppAction({
          requestId: `req-panel-add-${JSON.stringify(action)}`,
          source: 'assistant',
          action,
        });
        expect(response.ok).toBe(false);
        expect(response.error?.code).toBe('invalid_payload');
        expect(response.error?.message).toContain(
          'A subagent chat opens from its subagent.',
        );
      }
      expect(panelLayout()).toEqual(before);
      expect(
        __isValidAppAdvisorActionForTests({
          type: 'panel.add_tab',
          kind: 'subagent-chat',
        }),
      ).toBe(false);
    });

    it('panel.move docks a panel into another group and closes the emptied source', async () => {
      setupPanelLayout();
      const response = await dispatchAppAction({
        requestId: 'req-panel-move-center',
        source: 'assistant',
        action: {
          type: 'panel.move',
          panelId: 'panel-a',
          targetGroupId: 'group-b',
          edge: 'center',
        },
      });

      expect(response.ok).toBe(true);
      const layout = panelLayout();
      expect(Object.keys(layout.groups)).toEqual(['group-b']);
      expect(layout.groups['group-b'].tabs.map((tab) => tab.panelId)).toEqual([
        'panel-b',
        'panel-a',
      ]);
      expect(layout.groups['group-b'].activePanelId).toBe('panel-a');
    });

    it('panel.move splits the target group on an edge drop', async () => {
      setupPanelLayout();
      const response = await dispatchAppAction({
        requestId: 'req-panel-move-edge',
        source: 'assistant',
        action: {
          type: 'panel.move',
          panelId: 'panel-a',
          targetGroupId: 'group-b',
          edge: 'bottom',
        },
      });

      expect(response.ok).toBe(true);
      const layout = panelLayout();
      const groupIds = Object.keys(layout.groups);
      expect(groupIds).toHaveLength(2);
      expect(groupIds).toContain('group-b');
      expect(groupIds).not.toContain('group-a');
      const newGroupId = groupIds.find((groupId) => groupId !== 'group-b');
      expect(
        newGroupId !== undefined
          ? layout.groups[newGroupId].tabs.map((tab) => tab.panelId)
          : undefined,
      ).toEqual(['panel-a']);
    });

    it('panel.move reports a rejected Minimal topology mutation', async () => {
      setupPanelLayout();
      setPanelLayoutFixedTopology(PANEL_WORKTREE_KEY, true);

      const response = await dispatchAppAction({
        requestId: 'req-panel-move-minimal',
        source: 'assistant',
        action: {
          type: 'panel.move',
          panelId: 'panel-a',
          targetGroupId: 'group-b',
          edge: 'center',
        },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('invalid_target');
      expect(Object.keys(panelLayout().groups)).toEqual(['group-a', 'group-b']);
    });

    it('panel.move rejects unknown panels and unknown target groups', async () => {
      setupPanelLayout();
      const badPanel = await dispatchAppAction({
        requestId: 'req-panel-move-bad-panel',
        source: 'assistant',
        action: {
          type: 'panel.move',
          panelId: 'panel-nope',
          targetGroupId: 'group-b',
          edge: 'center',
        },
      });
      expect(badPanel.ok).toBe(false);
      expect(badPanel.error?.code).toBe('not_found');

      const badTarget = await dispatchAppAction({
        requestId: 'req-panel-move-bad-target',
        source: 'assistant',
        action: {
          type: 'panel.move',
          panelId: 'panel-a',
          targetGroupId: 'group-nope',
          edge: 'center',
        },
      });
      expect(badTarget.ok).toBe(false);
      expect(badTarget.error?.code).toBe('not_found');
    });

    it('panel.arrange even exits maximize and rejects unknown arrangements', async () => {
      setupPanelLayout();
      usePanelLayoutStore
        .getState()
        .maximizeGroup(PANEL_WORKTREE_KEY, 'group-a', true);
      expect(panelLayout().maximizedGroupId).toBe('group-a');

      const response = await dispatchAppAction({
        requestId: 'req-panel-arrange',
        source: 'assistant',
        action: { type: 'panel.arrange', arrangement: 'even' },
      });
      expect(response.ok).toBe(true);
      expect(panelLayout().maximizedGroupId).toBeNull();

      const invalid = await dispatchAppAction({
        requestId: 'req-panel-arrange-invalid',
        source: 'assistant',
        action: {
          type: 'panel.arrange',
          arrangement: 'stacked',
        },
      });
      expect(invalid.ok).toBe(false);
      expect(invalid.error?.code).toBe('invalid_payload');
    });

    it('panel.save_default_layout saves the selected worktree layout as the global default', async () => {
      setupPanelLayout();
      const response = await dispatchAppAction({
        requestId: 'req-panel-save-default',
        source: 'assistant',
        action: { type: 'panel.save_default_layout' },
      });

      expect(response.ok).toBe(true);
      expect(response.result).toEqual({ saved: true });
      expect(panelLayoutApiMock.saveDefaultLayout).toHaveBeenCalledTimes(1);
      const request = panelLayoutApiMock.saveDefaultLayout.mock.calls[0]?.[0];
      expect(request).toBeDefined();
      if (request === undefined) {
        throw new Error('Expected saveDefaultLayout request.');
      }
      expect(request.layout.activeGroupId).toBe('group-chat');
      expect(request.layout.mostRecentActiveGroupIds).toContain('group-chat');
    });

    it('panel.save_default_layout rejects the selected Minimal layout', async () => {
      setupPanelLayout();
      useWorkspaceLayoutModeStore.setState({
        entries: {
          [PANEL_WORKTREE_KEY]: {
            mode: 'minimal',
            status: 'ready',
            requestId: 1,
          },
        },
      });

      const response = await dispatchAppAction({
        requestId: 'req-panel-save-default-minimal',
        source: 'assistant',
        action: { type: 'panel.save_default_layout' },
      });

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('execution_failed');
      expect(panelLayoutApiMock.saveDefaultLayout).not.toHaveBeenCalled();
    });
  });
});

describe('Cursor settings actions', () => {
  it.each(
    (
      [
        { type: 'cursor.connection', operation: 'connect' },
        { type: 'cursor.connection', operation: 'disconnect' },
        { type: 'cursor.connection', operation: 'cancel' },
        // Both account operations: the renderer validator is its own rejecting
        // layer, and a sign-in missing from it is as dead as one missing from the
        // dispatch schema.
        { type: 'cursor.connection', operation: 'change-account' },
        { type: 'cursor.connection', operation: 'sign-in' },
        { type: 'cursor.approval_check', operation: 'run' },
        { type: 'cursor.approval_check', operation: 'stop' },
      ] as const
    ).flatMap((action) =>
      [false, true].map((released) => ({ action, released })),
    ),
  )(
    'routes $action.type $action.operation through its panel with release=$released',
    async ({ action, released }) => {
      const flags = useFeatureFlagsStore.getState();
      const previous = flags.snapshot;
      flags.setSnapshot({
        ...previous,
        values: {
          ...previous.values,
          'canopy-desktop-cursor-harness': true,
          'canopy-desktop-cursor-harness-released': released,
        },
      });
      const { registerCursorSettingsAction } =
        await import('@/lib/cursor-settings-actions');
      const handler = jest.fn(() => true);
      const unregister = registerCursorSettingsAction(action.type, handler);
      try {
        const response = await dispatchAppAction({
          requestId: `cursor-${action.operation}`,
          source: 'assistant',
          action,
        });
        expect(response.ok).toBe(true);
        expect(handler).toHaveBeenCalledWith(action.operation);
        expect(useNavigationStore.getState()).toMatchObject({
          settingsOpen: true,
          settingsInitialSection: released ? 'account' : 'experiments',
        });
      } finally {
        unregister();
        useFeatureFlagsStore.getState().setSnapshot(previous);
      }
    },
  );

  it('rejects approval decisions and arbitrary operations', () => {
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'cursor.approval_check',
        operation: 'allow',
      }),
    ).toBe(false);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'cursor.connection',
        operation: 'update',
      }),
    ).toBe(false);
  });
});

it('rejects Cursor setup actions while rollout is off without opening Settings', async () => {
  const previous = useFeatureFlagsStore.getState().snapshot;
  useFeatureFlagsStore.setState({
    snapshot: {
      ...previous,
      values: { ...previous.values, 'canopy-desktop-cursor-harness': false },
    },
  });
  useNavigationStore.setState({ settingsOpen: false });
  try {
    const response = await dispatchAppAction({
      requestId: 'cursor-disabled',
      source: 'assistant',
      action: { type: 'cursor.connection', operation: 'connect' },
    });
    expect(response.ok).toBe(false);
    expect(response.error?.message).toBe('Cursor is disabled.');
    expect(useNavigationStore.getState().settingsOpen).toBe(false);
  } finally {
    useFeatureFlagsStore.setState({ snapshot: previous });
  }
});

describe('org_project.* actions (CAN-2956)', () => {
  const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const PROJECT = '33333333-3333-4333-8333-333333333331';
  const inOrgContext = (): void => {
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context: { kind: 'organization', organizationId: ORG },
        revision: 1,
        organizations: [{ id: ORG, name: 'Acme', role: 'MEMBER' }],
      },
    });
  };

  beforeEach(() => {
    orgProjectsApiMock.list.mockReset();
    orgProjectsApiMock.list.mockResolvedValue({
      context: `org:${ORG}`,
      projects: [],
    });
    orgProjectsApiMock.refresh.mockReset();
    orgProjectsApiMock.refresh.mockResolvedValue({
      context: `org:${ORG}`,
      projects: [],
    });
    orgProjectsApiMock.setupStart.mockReset();
    orgProjectsApiMock.setupCancel.mockReset();
  });

  it('refuses every org_project action outside an organization context', async () => {
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: { context: { kind: 'personal' }, revision: 1, organizations: [] },
    });
    for (const action of [
      { type: 'org_project.list' },
      { type: 'org_project.setup_start', projectId: PROJECT },
      { type: 'org_project.setup_cancel', projectId: PROJECT },
    ] as const) {
      const response = await dispatchAppAction({
        requestId: `org-${action.type}`,
        source: 'assistant',
        action,
      });
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('surface_unavailable');
    }
    expect(orgProjectsApiMock.list).not.toHaveBeenCalled();
    expect(orgProjectsApiMock.setupStart).not.toHaveBeenCalled();
    expect(orgProjectsApiMock.setupCancel).not.toHaveBeenCalled();
  });

  it('lists the catalog as metadata for the selected organization', async () => {
    inOrgContext();
    orgProjectsApiMock.list.mockResolvedValue({
      context: `org:${ORG}`,
      revision: '1',
      fetchedAt: '2026-09-18T00:00:00.000Z',
      stale: false,
      error: null,
      projects: [
        {
          id: PROJECT,
          organizationId: ORG,
          name: 'Payments service',
          listed: true,
          repository: {
            provider: 'github',
            host: 'github.com',
            owner: 'acme',
            name: 'payments',
            providerRepoId: '1',
            defaultBranch: 'main',
            verification: 'VERIFIED',
          },
          instance: null,
          kind: 'CODE',
        },
      ],
    });
    const response = await dispatchAppAction({
      requestId: 'org-list',
      source: 'assistant',
      action: { type: 'org_project.list' },
    });
    expect(orgProjectsApiMock.list).toHaveBeenCalledWith({
      context: { kind: 'organization', organizationId: ORG },
    });
    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      organizationId: ORG,
      totalProjects: 1,
      projects: [
        {
          projectId: PROJECT,
          name: 'Payments service',
          kind: 'CODE',
          repository: 'acme/payments',
          verification: 'VERIFIED',
          instanceState: null,
        },
      ],
    });
  });

  it('captures a picked destination before starting when no default exists', async (): Promise<void> => {
    inOrgContext();
    loadPreferencesMock.mockResolvedValue({});
    browseForCloneDirectoryMock.mockResolvedValue({
      canceled: false,
      directoryPath: '/picked',
    });
    orgProjectsApiMock.setupStart.mockResolvedValue({
      projectId: PROJECT,
      state: 'claiming',
      percent: null,
    });
    await dispatchAppAction({
      requestId: 'org-picked',
      source: 'assistant',
      action: { type: 'org_project.setup_start', projectId: PROJECT },
    });
    expect(savePreferencesMock).toHaveBeenCalledWith({
      orgProjectDefaultDestinationRoot: '/picked',
    });
    expect(orgProjectsApiMock.setupStart).toHaveBeenCalledWith({
      projectId: PROJECT,
      destinationRoot: '/picked',
    });
  });

  it('starts a Cowork project setup without asking for a destination (CAN-3453)', async (): Promise<void> => {
    inOrgContext();
    orgProjectsApiMock.refresh.mockResolvedValue({
      context: `org:${ORG}`,
      projects: [
        {
          id: PROJECT,
          organizationId: ORG,
          name: 'Launch plan',
          kind: 'COWORK',
          repository: null,
          instance: null,
        },
      ],
    });
    orgProjectsApiMock.setupStart.mockResolvedValue({
      projectId: PROJECT,
      state: 'claiming',
      message: 'Claiming a setup slot',
      percent: null,
    });
    loadPreferencesMock.mockClear();
    browseForCloneDirectoryMock.mockClear();
    const response = await dispatchAppAction({
      requestId: 'org-cowork-setup',
      source: 'assistant',
      action: { type: 'org_project.setup_start', projectId: PROJECT },
    });
    expect(response.ok).toBe(true);
    expect(loadPreferencesMock).not.toHaveBeenCalled();
    expect(browseForCloneDirectoryMock).not.toHaveBeenCalled();
    expect(orgProjectsApiMock.setupStart).toHaveBeenCalledWith({
      projectId: PROJECT,
    });
  });

  it('refreshes a stale catalog before retrying a newly created Cowork project', async (): Promise<void> => {
    inOrgContext();
    orgProjectsApiMock.refresh.mockResolvedValue({
      context: `org:${ORG}`,
      projects: [
        {
          id: PROJECT,
          organizationId: ORG,
          name: 'Launch plan',
          kind: 'COWORK',
          repository: null,
          instance: null,
        },
      ],
    });
    orgProjectsApiMock.setupStart.mockResolvedValue({
      projectId: PROJECT,
      state: 'claiming',
      message: 'Claiming a setup slot',
      percent: null,
    });
    loadPreferencesMock.mockClear();
    browseForCloneDirectoryMock.mockClear();

    const response = await dispatchAppAction({
      requestId: 'org-cowork-setup-after-create',
      source: 'assistant',
      action: { type: 'org_project.setup_start', projectId: PROJECT },
    });

    expect(response.ok).toBe(true);
    expect(orgProjectsApiMock.refresh).toHaveBeenCalledWith({
      context: { kind: 'organization', organizationId: ORG },
      force: true,
    });
    expect(loadPreferencesMock).not.toHaveBeenCalled();
    expect(browseForCloneDirectoryMock).not.toHaveBeenCalled();
    expect(orgProjectsApiMock.setupStart).toHaveBeenCalledWith({
      projectId: PROJECT,
    });
  });

  it('does not start when the destination picker is dismissed', async (): Promise<void> => {
    inOrgContext();
    loadPreferencesMock.mockResolvedValue({});
    browseForCloneDirectoryMock.mockResolvedValue({ canceled: true });
    await dispatchAppAction({
      requestId: 'org-dismiss',
      source: 'assistant',
      action: { type: 'org_project.setup_start', projectId: PROJECT },
    });
    expect(orgProjectsApiMock.setupStart).not.toHaveBeenCalled();
  });

  it('starts and cancels a setup through the preload API', async () => {
    inOrgContext();
    loadPreferencesMock.mockResolvedValue({
      orgProjectDefaultDestinationRoot: '/chosen',
    });
    orgProjectsApiMock.setupStart.mockResolvedValue({
      projectId: PROJECT,
      state: 'claiming',
      message: 'Claiming a setup slot',
      percent: null,
      updatedAt: '2026-09-18T00:00:00.000Z',
    });
    const started = await dispatchAppAction({
      requestId: 'org-start',
      source: 'assistant',
      action: { type: 'org_project.setup_start', projectId: PROJECT },
    });
    expect(orgProjectsApiMock.setupStart).toHaveBeenCalledWith({
      projectId: PROJECT,
      destinationRoot: '/chosen',
    });
    expect(started.ok).toBe(true);
    expect(started.result).toMatchObject({ state: 'claiming' });

    orgProjectsApiMock.setupCancel.mockResolvedValue(undefined);
    const cancelled = await dispatchAppAction({
      requestId: 'org-cancel',
      source: 'assistant',
      action: { type: 'org_project.setup_cancel', projectId: PROJECT },
    });
    expect(orgProjectsApiMock.setupCancel).toHaveBeenCalledWith({
      projectId: PROJECT,
    });
    expect(cancelled.ok).toBe(true);
  });

  it('rejects a setup action without a project id', () => {
    expect(
      __isValidAppAdvisorActionForTests({ type: 'org_project.setup_start' }),
    ).toBe(false);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'org_project.setup_cancel',
        projectId: '',
      }),
    ).toBe(false);
  });
});

describe('workspace.add_org_project organization scope', (): void => {
  const org = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const otherOrg = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  beforeEach((): void => {
    useFeatureFlagsStore.getState().setSnapshot({
      ...getDefaultFeatureFlagSnapshot(),
      values: {
        ...getDefaultFeatureFlagSnapshot().values,
        'canopy-shared-org-projects-enabled': true,
      },
    });
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context: { kind: 'organization', organizationId: org },
        revision: 1,
        organizations: [
          { id: org, name: 'Acme', role: 'MEMBER' },
          { id: otherOrg, name: 'Other', role: 'MEMBER' },
        ],
      },
    });
    orgProjectsApiMock.list.mockReset();
    orgProjectsApiMock.setPreference.mockReset();
    orgProjectsApiMock.setupStart.mockReset();
    orgProjectsApiMock.linksList.mockReset();
    orgProjectsApiMock.linksList.mockResolvedValue({
      status: 'resolved',
      links: [],
    });
    orgStore = createOrgProjectsStore(ipcCanopyClient);
    setOrgProjectAddStoreForTests(orgStore);
    __setOrgProjectSetupOutcomeWaitForTests(50);
    progressListener = null;
    originalOrgProjectsApi = { ...window.api.orgProjects };
    Object.assign(window.api.orgProjects, {
      onSetupProgress: (
        listener: (progress: OrgProjectSetupProgress) => void,
      ): (() => void) => {
        progressListener = listener;
        return (): void => {
          progressListener = null;
        };
      },
    });
    // The sidebar has answered this organization's links: nothing linked.
    useLinkedPersonalWorkspacesStore.getState().setProjectIds([], org);
    useProjectsStore.setState({ projects: [], hasHydratedProjects: true });
  });
  afterEach((): void => {
    Object.assign(window.api.orgProjects, originalOrgProjectsApi);
    __resetAppActionDispatcherForTests();
    setOrgProjectAddStoreForTests(null);
    useLinkedPersonalWorkspacesStore.getState().setProjectIds([], null);
  });
  let orgStore: ReturnType<typeof createOrgProjectsStore>;
  let progressListener: ((progress: OrgProjectSetupProgress) => void) | null;
  let originalOrgProjectsApi: typeof window.api.orgProjects;
  const progress = (
    state: OrgProjectSetupProgress['state'],
    message: string | null = null,
  ): OrgProjectSetupProgress => ({
    projectId: 'project-a',
    instanceId: state === 'ready' ? 'instance-a' : null,
    state,
    message,
    percent: null,
    updatedAt: '2026-10-13T11:05:30.000Z',
  });
  /** setupStart answers claiming, then setup ends as `finish` says. */
  const setupEnds = (finish: OrgProjectSetupProgress, bind: boolean): void => {
    orgProjectsApiMock.setupStart.mockImplementation(
      (): Promise<OrgProjectSetupProgress> => {
        setTimeout((): void => {
          if (bind)
            useProjectsStore.setState({
              projects: [
                makeWorkspace({
                  id: 'registrar-platform',
                  owner: {
                    type: 'organization',
                    organizationId: org,
                    projectId: 'project-a',
                    instanceId: 'instance-a',
                    bindingGeneration: 1,
                  },
                }),
              ],
            });
          progressListener?.(finish);
        }, 0);
        return Promise.resolve(progress('claiming'));
      },
    );
  };
  // A catalog project the member can add: Code, verified, not listed yet and
  // not set up on this computer.
  const addable = {
    id: 'project-a',
    organizationId: org,
    name: 'registrar-platform',
    kind: 'CODE',
    location: 'LOCAL',
    memberOwned: false,
    repository: {
      provider: 'github',
      host: 'github.com',
      owner: 'acme',
      name: 'registrar-platform',
      providerRepoId: '1',
      defaultBranch: 'main',
      verification: 'VERIFIED',
    },
    listed: false,
    state: 'ACTIVE',
    instance: null,
    capabilities: { administer: false, manageCloud: false, use: true },
  };
  const rememberFolder = (folder: string | undefined): void => {
    loadPreferencesMock.mockResolvedValue({
      disabledPipelineIds: [],
      ...(folder === undefined
        ? {}
        : { orgProjectDefaultDestinationRoot: folder }),
    });
  };

  it('refuses the mutation when the feature flag is off', async (): Promise<void> => {
    // The catalog entry's requiredFeatureFlag only governs discovery, so an
    // action type learned while the feature was on must still be refused.
    useFeatureFlagsStore.getState().setSnapshot({
      ...getDefaultFeatureFlagSnapshot(),
      values: {
        ...getDefaultFeatureFlagSnapshot().values,
        'canopy-shared-org-projects-enabled': false,
      },
    });
    const response = await dispatchAppAction({
      requestId: 'add-flag-off',
      source: 'assistant',
      action: { type: 'workspace.add_org_project', projectId: 'project-a' },
    });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('surface_unavailable');
    expect(orgProjectsApiMock.list).not.toHaveBeenCalled();
    expect(orgProjectsApiMock.setPreference).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'absent from the active catalog',
      context: `org:${org}`,
      projects: [{ id: 'project-a', organizationId: org }],
    },
    {
      name: 'owned by another organization',
      context: `org:${org}`,
      projects: [{ id: 'project-b', organizationId: otherOrg }],
    },
    {
      name: 'returned in another context snapshot',
      context: `org:${otherOrg}`,
      projects: [{ id: 'project-b', organizationId: org }],
    },
  ])(
    'rejects a project $name without writing a preference',
    async (snapshot): Promise<void> => {
      orgProjectsApiMock.list.mockResolvedValue(snapshot);
      const response = await dispatchAppAction({
        requestId: 'reject-other-org',
        source: 'assistant',
        action: { type: 'workspace.add_org_project', projectId: 'project-b' },
      });
      expect(orgProjectsApiMock.setPreference).not.toHaveBeenCalled();
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('not_found');
      expect(orgProjectsApiMock.list).toHaveBeenCalledWith({
        context: { kind: 'organization', organizationId: org },
      });
    },
  );

  it.each([
    {
      name: 'archived',
      project: {
        id: 'project-a',
        organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        listed: false,
        state: 'ARCHIVED',
        capabilities: { administer: false, manageCloud: false, use: true },
      },
    },
    {
      name: 'not usable by this member',
      project: {
        id: 'project-a',
        organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        listed: false,
        state: 'ACTIVE',
        capabilities: { administer: false, manageCloud: false, use: false },
      },
    },
  ])(
    'refuses a project that is $name instead of reporting a successful add',
    async ({ project }): Promise<void> => {
      // Such a project is excluded from the catalog, so the preference could
      // never make it listed and success would be a lie.
      orgProjectsApiMock.list.mockResolvedValue({
        context: `org:${org}`,
        projects: [project],
      });
      const response = await dispatchAppAction({
        requestId: 'add-ineligible',
        source: 'assistant',
        action: { type: 'workspace.add_org_project', projectId: 'project-a' },
      });
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('not_found');
      expect(orgProjectsApiMock.setPreference).not.toHaveBeenCalled();
    },
  );

  it('lists and sets up the project in the remembered folder, like the catalog Add (CAN-3592)', async (): Promise<void> => {
    // Listing alone left the project off the sidebar, which shows only
    // projects on this computer, while the Advisor reported success.
    rememberFolder('/Users/me/repos');
    orgProjectsApiMock.list.mockResolvedValue({
      context: `org:${org}`,
      projects: [addable],
    });
    orgProjectsApiMock.setupStart.mockResolvedValue({
      projectId: 'project-a',
      instanceId: null,
      state: 'claiming',
      message: 'Claiming',
      percent: null,
      updatedAt: '2026-10-13T11:05:30.000Z',
    });
    const response = await dispatchAppAction({
      requestId: 'add-active-org',
      source: 'assistant',
      action: { type: 'workspace.add_org_project', projectId: 'project-a' },
    });
    expect(orgProjectsApiMock.list).toHaveBeenCalledWith({
      context: { kind: 'organization', organizationId: org },
    });
    expect(orgProjectsApiMock.setPreference).toHaveBeenCalledTimes(1);
    expect(orgProjectsApiMock.setPreference).toHaveBeenCalledWith({
      context: { kind: 'organization', organizationId: org },
      projectId: 'project-a',
      preference: 'ADDED',
    });
    expect(orgProjectsApiMock.setupStart).toHaveBeenCalledWith({
      projectId: 'project-a',
      destinationRoot: '/Users/me/repos',
    });
    expect(orgStore.getState().setupRequest).toBeNull();
    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      projectId: 'project-a',
      organizationId: org,
      status: 'setting_up',
      onThisComputer: false,
    });
    // The message says it is not added yet, so the model cannot open with
    // "Added" (CAN-3592 QA).
    expect(response.result).toMatchObject({
      message: expect.stringContaining('not on this computer yet') as unknown,
    });
  });

  it('reports the project added once setup finishes and its workspace is bound', async (): Promise<void> => {
    rememberFolder('/Users/me/repos');
    orgProjectsApiMock.list.mockResolvedValue({
      context: `org:${org}`,
      projects: [addable],
    });
    setupEnds(progress('ready'), true);
    const response = await dispatchAppAction({
      requestId: 'add-finished',
      source: 'assistant',
      action: { type: 'workspace.add_org_project', projectId: 'project-a' },
    });
    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      status: 'on_this_computer',
      onThisComputer: true,
    });
  });

  it('finds a workspace that only a projects reload shows before reporting the add', async (): Promise<void> => {
    rememberFolder('/Users/me/repos');
    orgProjectsApiMock.list.mockResolvedValue({
      context: `org:${org}`,
      projects: [addable],
    });
    // The store misses the binding; a reload from main has it.
    const reload = jest.fn((): Promise<void> => {
      useProjectsStore.setState({
        projects: [
          makeWorkspace({
            id: 'registrar-platform',
            owner: {
              type: 'organization',
              organizationId: org,
              projectId: 'project-a',
              instanceId: 'instance-a',
              bindingGeneration: 1,
            },
          }),
        ],
      });
      return Promise.resolve();
    });
    const { loadProjects } = useProjectsStore.getState();
    useProjectsStore.setState({ loadProjects: reload });
    try {
      setupEnds(progress('ready'), false);
      const response = await dispatchAppAction({
        requestId: 'add-found-on-reload',
        source: 'assistant',
        action: { type: 'workspace.add_org_project', projectId: 'project-a' },
      });
      expect(reload).toHaveBeenCalledWith({ silent: true });
      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({ status: 'on_this_computer' });
    } finally {
      useProjectsStore.setState({ loadProjects });
    }
  });

  it('makes a setup that ends without a workspace visible as nothing added (CAN-3592)', async (): Promise<void> => {
    // The QA failure: an add that changed nothing must never read as success.
    rememberFolder('/Users/me/repos');
    orgProjectsApiMock.list.mockResolvedValue({
      context: `org:${org}`,
      projects: [addable],
    });
    loadProjectsApiMock.mockResolvedValue({ version: 1, items: [] });
    setupEnds(progress('ready'), false);
    const response = await dispatchAppAction({
      requestId: 'add-noop',
      source: 'assistant',
      action: { type: 'workspace.add_org_project', projectId: 'project-a' },
    });
    expect(response.ok).toBe(false);
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain('nothing was added');
  });

  it('reports a setup that fails after starting as a failure, with its reason', async (): Promise<void> => {
    rememberFolder('/Users/me/repos');
    orgProjectsApiMock.list.mockResolvedValue({
      context: `org:${org}`,
      projects: [addable],
    });
    setupEnds(
      progress('failed', 'GitHub access is needed to clone this repository'),
      false,
    );
    const response = await dispatchAppAction({
      requestId: 'add-failed-later',
      source: 'assistant',
      action: { type: 'workspace.add_org_project', projectId: 'project-a' },
    });
    expect(response.ok).toBe(false);
    expect(response.error?.message).toContain('GitHub access is needed');
    expect(response.error?.message).toContain('not on this computer');
  });

  it('reports a project bound here as added even when setup answers it is already a workspace', async (): Promise<void> => {
    rememberFolder('/Users/me/repos');
    orgProjectsApiMock.list.mockResolvedValue({
      context: `org:${org}`,
      projects: [addable],
    });
    setupEnds(progress('failed', 'This project is already a workspace'), true);
    const response = await dispatchAppAction({
      requestId: 'add-already-workspace',
      source: 'assistant',
      action: { type: 'workspace.add_org_project', projectId: 'project-a' },
    });
    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({ status: 'on_this_computer' });
  });

  it('reports a setup cancelled after it started as not added', async (): Promise<void> => {
    rememberFolder('/Users/me/repos');
    orgProjectsApiMock.list.mockResolvedValue({
      context: `org:${org}`,
      projects: [addable],
    });
    setupEnds(progress('cancelled'), false);
    const response = await dispatchAppAction({
      requestId: 'add-cancelled-later',
      source: 'assistant',
      action: { type: 'workspace.add_org_project', projectId: 'project-a' },
    });
    expect(response.ok).toBe(false);
    expect(response.error?.message).toContain('was cancelled');
    expect(response.error?.message).toContain('not on this computer');
  });

  it('stops waiting for setup when the turn is stopped and does not report an add', async (): Promise<void> => {
    __setOrgProjectSetupOutcomeWaitForTests(5_000);
    rememberFolder('/Users/me/repos');
    orgProjectsApiMock.list.mockResolvedValue({
      context: `org:${org}`,
      projects: [addable],
    });
    orgProjectsApiMock.setupStart.mockResolvedValue(progress('claiming'));
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = dispatchAppAction({
      requestId: 'add-stopped-waiting',
      source: 'assistant',
      action: { type: 'workspace.add_org_project', projectId: 'project-a' },
      signal: controller.signal,
    });
    await waitForCall(orgProjectsApiMock.setupStart);
    controller.abort();
    const response = await pending;
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(response.ok).toBe(false);
    expect(response.error?.message).toContain('not on this computer yet');
  });

  it('opens the setup dialog without a remembered folder and does not report the project as added', async (): Promise<void> => {
    rememberFolder(undefined);
    orgProjectsApiMock.list.mockResolvedValue({
      context: `org:${org}`,
      projects: [addable],
    });
    const response = await dispatchAppAction({
      requestId: 'add-no-folder',
      source: 'assistant',
      action: { type: 'workspace.add_org_project', projectId: 'project-a' },
    });
    expect(orgProjectsApiMock.setPreference).toHaveBeenCalledTimes(1);
    expect(orgProjectsApiMock.setupStart).not.toHaveBeenCalled();
    expect(orgStore.getState().setupRequest).toEqual({
      organizationId: org,
      projectId: 'project-a',
    });
    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      status: 'awaiting_setup',
      onThisComputer: false,
    });
  });

  it('starts nothing for a project already on this computer and says so', async (): Promise<void> => {
    rememberFolder('/Users/me/repos');
    useLinkedPersonalWorkspacesStore
      .getState()
      .setProjectIds(['project-a'], org);
    orgProjectsApiMock.list.mockResolvedValue({
      context: `org:${org}`,
      projects: [{ ...addable, listed: true }],
    });
    const response = await dispatchAppAction({
      requestId: 'add-linked',
      source: 'assistant',
      action: { type: 'workspace.add_org_project', projectId: 'project-a' },
    });
    expect(orgProjectsApiMock.setPreference).not.toHaveBeenCalled();
    expect(orgProjectsApiMock.setupStart).not.toHaveBeenCalled();
    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      status: 'on_this_computer',
      onThisComputer: true,
    });
  });

  it('sets up a project whose ready instance has no workspace here instead of calling it added (CAN-3592)', async (): Promise<void> => {
    // A removed workspace leaves its instance READY on the server; only a
    // workspace bound or linked here puts the project on this computer.
    rememberFolder('/Users/me/repos');
    orgProjectsApiMock.list.mockResolvedValue({
      context: `org:${org}`,
      projects: [
        {
          ...addable,
          listed: true,
          instance: { id: 'stale-instance', state: 'READY' },
        },
      ],
    });
    orgProjectsApiMock.setupStart.mockResolvedValue({
      projectId: 'project-a',
      instanceId: null,
      state: 'claiming',
      message: null,
      percent: null,
      updatedAt: '2026-10-13T11:05:30.000Z',
    });
    const response = await dispatchAppAction({
      requestId: 'add-stale-ready',
      source: 'assistant',
      action: { type: 'workspace.add_org_project', projectId: 'project-a' },
    });
    expect(orgProjectsApiMock.setupStart).toHaveBeenCalledWith({
      projectId: 'project-a',
      destinationRoot: '/Users/me/repos',
    });
    expect(response.result).toMatchObject({
      status: 'setting_up',
      onThisComputer: false,
    });
  });

  it('waits for the links a context switch is still answering before adding', async (): Promise<void> => {
    rememberFolder('/Users/me/repos');
    useLinkedPersonalWorkspacesStore.getState().setProjectIds([], null);
    orgProjectsApiMock.list.mockResolvedValue({
      context: `org:${org}`,
      projects: [addable],
    });
    orgProjectsApiMock.setupStart.mockResolvedValue({
      projectId: 'project-a',
      instanceId: null,
      state: 'claiming',
      message: null,
      percent: null,
      updatedAt: '2026-10-13T11:05:30.000Z',
    });
    const pending = dispatchAppAction({
      requestId: 'add-links-pending',
      source: 'assistant',
      action: { type: 'workspace.add_org_project', projectId: 'project-a' },
    });
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(orgProjectsApiMock.setPreference).not.toHaveBeenCalled();
    useLinkedPersonalWorkspacesStore.getState().setProjectIds([], org);
    const response = await pending;
    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({ status: 'setting_up' });
  });

  it("refuses a project that cannot run here in the member's words, not as a state name", async (): Promise<void> => {
    rememberFolder('/Users/me/repos');
    orgProjectsApiMock.list.mockResolvedValue({
      context: `org:${org}`,
      projects: [{ ...addable, location: 'CLOUD' }],
    });
    const response = await dispatchAppAction({
      requestId: 'add-not-local',
      source: 'assistant',
      action: { type: 'workspace.add_org_project', projectId: 'project-a' },
    });
    expect(response.ok).toBe(false);
    expect(response.error?.message).toContain(
      "it doesn't run on this computer",
    );
    expect(response.error?.message).not.toContain('not-local');
    expect(orgProjectsApiMock.setPreference).not.toHaveBeenCalled();
  });

  it('adds nothing when the turn is stopped while links are still loading', async (): Promise<void> => {
    rememberFolder('/Users/me/repos');
    useLinkedPersonalWorkspacesStore.getState().setProjectIds([], null);
    orgProjectsApiMock.list.mockResolvedValue({
      context: `org:${org}`,
      projects: [addable],
    });
    const controller = new AbortController();
    const pending = dispatchAppAction({
      requestId: 'add-aborted',
      source: 'assistant',
      action: { type: 'workspace.add_org_project', projectId: 'project-a' },
      signal: controller.signal,
    });
    // Stop the turn once the action is waiting for the links.
    await waitForCall(orgProjectsApiMock.list);
    controller.abort();
    const response = await pending;
    expect(response.ok).toBe(false);
    expect(response.error?.message).toContain('nothing was added');
    expect(orgProjectsApiMock.setPreference).not.toHaveBeenCalled();
    expect(orgProjectsApiMock.setupStart).not.toHaveBeenCalled();
  });

  it('starts no setup when the turn is stopped after the project was listed', async (): Promise<void> => {
    rememberFolder('/Users/me/repos');
    orgProjectsApiMock.list.mockResolvedValue({
      context: `org:${org}`,
      projects: [addable],
    });
    const controller = new AbortController();
    let answerLinks: (value: {
      status: 'resolved';
      links: [];
    }) => void = (): void => {};
    orgProjectsApiMock.linksList.mockReturnValue(
      new Promise((resolve): void => {
        answerLinks = resolve;
      }),
    );
    const pending = dispatchAppAction({
      requestId: 'add-aborted-after-listing',
      source: 'assistant',
      action: { type: 'workspace.add_org_project', projectId: 'project-a' },
      signal: controller.signal,
    });
    await waitForCall(orgProjectsApiMock.linksList);
    controller.abort();
    answerLinks({ status: 'resolved', links: [] });
    const response = await pending;
    expect(orgProjectsApiMock.setPreference).toHaveBeenCalledTimes(1);
    expect(orgProjectsApiMock.setupStart).not.toHaveBeenCalled();
    expect(orgStore.getState().setupRequest).toBeNull();
    expect(response.ok).toBe(false);
    expect(response.error?.message).toContain('it is not on this computer');
  });

  it('reads what is bound only after an in-flight project load finishes', async (): Promise<void> => {
    rememberFolder('/Users/me/repos');
    useProjectsStore.setState({ projects: [], isLoading: true });
    orgProjectsApiMock.list.mockResolvedValue({
      context: `org:${org}`,
      projects: [addable],
    });
    const pending = dispatchAppAction({
      requestId: 'add-while-loading',
      source: 'assistant',
      action: { type: 'workspace.add_org_project', projectId: 'project-a' },
    });
    await waitForCall(orgProjectsApiMock.list);
    // The load lands a workspace already bound to the project.
    useProjectsStore.setState({
      isLoading: false,
      projects: [
        makeWorkspace({
          id: 'registrar-platform',
          owner: {
            type: 'organization',
            organizationId: org,
            projectId: 'project-a',
            instanceId: 'instance-a',
            bindingGeneration: 1,
          },
        }),
      ],
    });
    const response = await pending;
    expect(response.result).toMatchObject({ status: 'on_this_computer' });
    expect(orgProjectsApiMock.setupStart).not.toHaveBeenCalled();
  });

  it('reports a refused setup as a failure, not an add', async (): Promise<void> => {
    rememberFolder('/Users/me/repos');
    orgProjectsApiMock.list.mockResolvedValue({
      context: `org:${org}`,
      projects: [addable],
    });
    orgProjectsApiMock.setupStart.mockRejectedValue(
      new Error('GitHub access is needed'),
    );
    const response = await dispatchAppAction({
      requestId: 'add-setup-refused',
      source: 'assistant',
      action: { type: 'workspace.add_org_project', projectId: 'project-a' },
    });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('execution_failed');
    expect(response.error?.message).toContain('GitHub access is needed');
  });

  it('is not refused as stale while app state settles after a context switch (CAN-3592)', async (): Promise<void> => {
    // The target is re-read from the selected organization's live catalog, so
    // a UI revision taken a moment earlier guards nothing here.
    rememberFolder(undefined);
    orgProjectsApiMock.list.mockResolvedValue({
      context: `org:${org}`,
      projects: [addable],
    });
    const current = useCurrentUiStateStore.getState().getEnvelope().revision;
    const response = await dispatchAppAction({
      requestId: 'add-after-switch',
      source: 'assistant',
      expectedUiRevision: current + 7,
      action: { type: 'workspace.add_org_project', projectId: 'project-a' },
    });
    expect(response.error?.code).not.toBe('stale_ui_state');
    expect(response.ok).toBe(true);
  });
});

it('opens account MCP settings through page navigation', async (): Promise<void> => {
  const result = await dispatchAppAction({
    requestId: 'account-mcp-nav',
    source: 'assistant',
    action: { type: 'navigation.go_to_page', page: 'mcp-account-connections' },
  });
  expect(result.ok).toBe(true);
  expect(useNavigationStore.getState()).toMatchObject({
    settingsOpen: true,
    settingsInitialSection: 'mcp',
  });
});
it.each(['connect', 'reconnect', 'disconnect', 'promote', 'edit'] as const)(
  'dispatches the account MCP %s action only when acknowledged',
  async (operation): Promise<void> => {
    const action = {
      type: `mcp.account_${operation}` as const,
      serverId: 'row-id',
    };
    const missing = await dispatchAppAction({
      requestId: `mcp-missing-${operation}`,
      source: 'assistant',
      action,
    });
    expect(missing.error?.code).toBe('invalid_target');
    const listener = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (!isAccountMcpActionEventDetail(detail)) return;
      expect(detail).toMatchObject({ operation, serverId: 'row-id' });
      detail.acknowledge();
    };
    window.addEventListener('canopy:account-mcp-action', listener);
    try {
      const result = await dispatchAppAction({
        requestId: `mcp-accepted-${operation}`,
        source: 'assistant',
        action,
      });
      expect(result.ok).toBe(true);
    } finally {
      window.removeEventListener('canopy:account-mcp-action', listener);
    }
  },
);
it('returns the reason an account MCP action was refused', async (): Promise<void> => {
  const listener = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    const detail: unknown = event.detail;
    if (!isAccountMcpActionEventDetail(detail)) return;
    detail.refuse?.('This server stays on this device.');
  };
  window.addEventListener('canopy:account-mcp-action', listener);
  try {
    const result = await dispatchAppAction({
      requestId: 'mcp-refused-promote',
      source: 'assistant',
      action: { type: 'mcp.account_promote', serverId: 'row-id' },
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_target',
        message: 'This server stays on this device.',
      },
    });
  } finally {
    window.removeEventListener('canopy:account-mcp-action', listener);
  }
});

describe('org_project.create_cowork (CAN-3453)', (): void => {
  const org = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const createOrgCoworkProject = jest.fn();
  const activateCreatedCoworkWorkspace = jest.fn();
  let original: {
    createOrgCoworkProject: ReturnType<
      typeof useStandaloneChatStore.getState
    >['createOrgCoworkProject'];
    activateCreatedCoworkWorkspace: ReturnType<
      typeof useStandaloneChatStore.getState
    >['activateCreatedCoworkWorkspace'];
  };
  const inOrganization = (): void => {
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context: { kind: 'organization', organizationId: org },
        revision: 1,
        organizations: [{ id: org, name: 'Acme', role: 'MEMBER' }],
      },
    });
  };
  const create = (requestId: string): ReturnType<typeof dispatchAppAction> =>
    dispatchAppAction({
      requestId,
      source: 'assistant',
      action: { type: 'org_project.create_cowork', name: '  Launch plan ' },
    });

  beforeEach((): void => {
    const store = useStandaloneChatStore.getState();
    original = {
      createOrgCoworkProject: store.createOrgCoworkProject,
      activateCreatedCoworkWorkspace: store.activateCreatedCoworkWorkspace,
    };
    createOrgCoworkProject.mockReset();
    activateCreatedCoworkWorkspace.mockReset();
    activateCreatedCoworkWorkspace.mockResolvedValue(true);
    useStandaloneChatStore.setState({
      createOrgCoworkProject,
      activateCreatedCoworkWorkspace,
    });
    useFeatureFlagsStore.getState().setSnapshot({
      ...getDefaultFeatureFlagSnapshot(),
      values: {
        ...getDefaultFeatureFlagSnapshot().values,
        'canopy-shared-org-projects-enabled': true,
      },
    });
    inOrganization();
  });

  afterEach((): void => {
    useStandaloneChatStore.setState(original);
  });

  it('is not revision-agnostic because it creates a project', (): void => {
    expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).not.toContain(
      'org_project.create_cowork',
    );
  });

  it('rejects a missing or blank name', (): void => {
    expect(
      __isValidAppAdvisorActionForTests({ type: 'org_project.create_cowork' }),
    ).toBe(false);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'org_project.create_cowork',
        name: '   ',
      }),
    ).toBe(false);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'org_project.create_cowork',
        name: 'x'.repeat(257),
      }),
    ).toBe(false);
  });

  it('refuses when organization projects are off', async (): Promise<void> => {
    useFeatureFlagsStore.getState().setSnapshot({
      ...getDefaultFeatureFlagSnapshot(),
      values: {
        ...getDefaultFeatureFlagSnapshot().values,
        'canopy-shared-org-projects-enabled': false,
      },
    });
    const response = await create('cowork-flag-off');
    expect(response.ok).toBe(false);
    expect(response.error).toEqual({
      code: 'surface_unavailable',
      message: 'Organization projects are not available.',
    });
    expect(createOrgCoworkProject).not.toHaveBeenCalled();
  });

  it('refuses in Personal instead of switching context', async (): Promise<void> => {
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: { context: { kind: 'personal' }, revision: 1, organizations: [] },
    });
    const response = await create('cowork-personal');
    expect(response.ok).toBe(false);
    expect(response.error).toEqual({
      code: 'surface_unavailable',
      message: 'Select an organization to create its projects.',
    });
    expect(createOrgCoworkProject).not.toHaveBeenCalled();
  });

  it('creates the project in the selected organization and opens it', async (): Promise<void> => {
    createOrgCoworkProject.mockResolvedValue({
      ok: true,
      organizationProjectId: '33333333-3333-4333-8333-333333333331',
      localWorkspaceId: 'org-cowork-1',
      attachedGitRepository: false,
    });
    const response = await create('cowork-create');
    expect(createOrgCoworkProject).toHaveBeenCalledWith({
      organizationId: org,
      name: 'Launch plan',
    });
    expect(activateCreatedCoworkWorkspace).toHaveBeenCalledWith('org-cowork-1');
    expect(useNavigationStore.getState().activePage).toBe('chat');
    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      projectId: '33333333-3333-4333-8333-333333333331',
      organizationId: org,
      workspaceId: 'org-cowork-1',
      message: 'Created Launch plan in Acme.',
    });
    expect(useWorkspaceContextStore.getState().state.context).toEqual({
      kind: 'organization',
      organizationId: org,
    });
  });

  it('preserves the creation receipt when opening the workspace fails', async (): Promise<void> => {
    createOrgCoworkProject.mockResolvedValue({
      ok: true,
      organizationProjectId: '33333333-3333-4333-8333-333333333331',
      localWorkspaceId: 'org-cowork-1',
      attachedGitRepository: false,
    });
    activateCreatedCoworkWorkspace.mockRejectedValue(new Error('load failed'));

    const response = await create('cowork-created-open-failed');

    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      projectId: '33333333-3333-4333-8333-333333333331',
      organizationId: org,
      workspaceId: 'org-cowork-1',
      state: 'created',
      opened: false,
      message:
        "Created Launch plan in Acme, but couldn't open it. Open it from the project list.",
    });
    expect(createOrgCoworkProject).toHaveBeenCalledTimes(1);
  });

  it('preserves the creation receipt when opening is superseded', async (): Promise<void> => {
    createOrgCoworkProject.mockResolvedValue({
      ok: true,
      organizationProjectId: '33333333-3333-4333-8333-333333333331',
      localWorkspaceId: 'org-cowork-1',
      attachedGitRepository: false,
    });
    activateCreatedCoworkWorkspace.mockResolvedValue(false);

    const response = await create('cowork-created-open-superseded');

    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      projectId: '33333333-3333-4333-8333-333333333331',
      organizationId: org,
      workspaceId: 'org-cowork-1',
      state: 'created',
      opened: false,
      message:
        "Created Launch plan in Acme, but couldn't open it. Open it from the project list.",
    });
    expect(useNavigationStore.getState().activePage).toBe('overview');
    expect(createOrgCoworkProject).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      code: 'limit-reached',
      message: `You've reached the limit of ${MEMBER_ORG_PROJECT_LIMIT} private projects in Acme. Delete one to make another.`,
    },
    {
      code: 'create-failed',
      message: "Couldn't create Launch plan in Acme. Try again.",
    },
    {
      code: 'unavailable',
      message: "Couldn't create Launch plan in Acme. Try again.",
    },
  ])(
    'reports $code without opening anything',
    async ({ message, ...failure }): Promise<void> => {
      createOrgCoworkProject.mockResolvedValue({
        ok: false,
        attachedGitRepository: false,
        ...failure,
      });
      const response = await create(`cowork-${failure.code}`);
      expect(response.ok).toBe(false);
      expect(response.error).toEqual({ code: 'execution_failed', message });
      expect(activateCreatedCoworkWorkspace).not.toHaveBeenCalled();
    },
  );

  it('preserves the project id and directs setup retry after cloud creation', async (): Promise<void> => {
    createOrgCoworkProject.mockResolvedValue({
      ok: false,
      code: 'setup-failed',
      organizationProjectId: '33333333-3333-4333-8333-333333333331',
      attachedGitRepository: false,
    });

    const response = await create('cowork-setup-failed');

    expect(response).toMatchObject({
      ok: true,
      result: {
        projectId: '33333333-3333-4333-8333-333333333331',
        organizationId: org,
        state: 'setup-failed',
        retryAction: {
          type: 'org_project.setup_start',
          projectId: '33333333-3333-4333-8333-333333333331',
        },
        message:
          "Launch plan was created in Acme, but couldn't be set up on this computer. Use org_project.setup_start to try again.",
      },
    });
    expect(activateCreatedCoworkWorkspace).not.toHaveBeenCalled();
  });

  it('reports a thrown create as a failure to create', async (): Promise<void> => {
    createOrgCoworkProject.mockRejectedValue(new Error('boom'));
    const response = await create('cowork-throw');
    expect(response.ok).toBe(false);
    expect(response.error?.message).toBe(
      "Couldn't create Launch plan in Acme. Try again.",
    );
  });
});

describe('org_project.create_code (CAN-3534)', (): void => {
  const org = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const projectId = '33333333-3333-4333-8333-333333333331';
  const folderPath = '/Users/me/payments';
  const createOrgMemberCodeProject = jest.fn();
  const getMemberCodeEligibility = jest.fn();
  const inspectFolder = jest.fn();
  let original: ReturnType<
    typeof useProjectsStore.getState
  >['createOrgMemberCodeProject'];
  const create = (
    requestId: string,
    folder?: string,
  ): ReturnType<typeof dispatchAppAction> =>
    dispatchAppAction({
      requestId,
      source: 'assistant',
      action: {
        type: 'org_project.create_code',
        name: '  Payments service ',
        ...(folder === undefined ? {} : { folderPath: folder }),
      },
    });

  beforeEach((): void => {
    original = useProjectsStore.getState().createOrgMemberCodeProject;
    createOrgMemberCodeProject.mockReset();
    getMemberCodeEligibility.mockReset().mockResolvedValue('eligible');
    inspectFolder.mockReset();
    navigateAfterRepositoryWorkspaceCreatedMock.mockReset();
    useProjectsStore.setState({ createOrgMemberCodeProject });
    Object.assign(window.api.orgProjects, {
      getMemberCodeEligibility,
      inspectFolder,
    });
    useFeatureFlagsStore.getState().setSnapshot({
      ...getDefaultFeatureFlagSnapshot(),
      values: {
        ...getDefaultFeatureFlagSnapshot().values,
        'canopy-shared-org-projects-enabled': true,
      },
    });
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context: { kind: 'organization', organizationId: org },
        revision: 1,
        organizations: [{ id: org, name: 'Acme', role: 'MEMBER' }],
      },
    });
  });

  afterEach((): void => {
    useProjectsStore.setState({ createOrgMemberCodeProject: original });
  });

  it('is not revision-agnostic because it creates a project', (): void => {
    expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).not.toContain(
      'org_project.create_code',
    );
  });

  it('rejects a missing or blank name and a blank folder', (): void => {
    expect(
      __isValidAppAdvisorActionForTests({ type: 'org_project.create_code' }),
    ).toBe(false);
    for (const name of ['   ', 'x'.repeat(257)])
      expect(
        __isValidAppAdvisorActionForTests({
          type: 'org_project.create_code',
          name,
        }),
      ).toBe(false);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'org_project.create_code',
        name: 'Payments service',
        folderPath: '  ',
      }),
    ).toBe(false);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'org_project.create_code',
        name: 'Payments service',
      }),
    ).toBe(true);
    expect(
      __isValidAppAdvisorActionForTests({
        type: 'org_project.create_code',
        name: 'Payments service',
        folderPath,
      }),
    ).toBe(true);
  });

  it('refuses when organization projects are off', async (): Promise<void> => {
    useFeatureFlagsStore.getState().setSnapshot({
      ...getDefaultFeatureFlagSnapshot(),
      values: {
        ...getDefaultFeatureFlagSnapshot().values,
        'canopy-shared-org-projects-enabled': false,
      },
    });
    const response = await create('code-flag-off');
    expect(response.error).toEqual({
      code: 'surface_unavailable',
      message: 'Organization projects are not available.',
    });
    expect(getMemberCodeEligibility).not.toHaveBeenCalled();
    expect(createOrgMemberCodeProject).not.toHaveBeenCalled();
  });

  it('refuses in Personal instead of switching context', async (): Promise<void> => {
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: { context: { kind: 'personal' }, revision: 1, organizations: [] },
    });
    const response = await create('code-personal');
    expect(response.error).toEqual({
      code: 'surface_unavailable',
      message: 'Select an organization to create its projects.',
    });
    expect(createOrgMemberCodeProject).not.toHaveBeenCalled();
  });

  it.each([
    ['the organization cannot take Code projects', 'ineligible'],
    ['the eligibility check cannot answer', new Error('No handler')],
  ])('refuses when %s', async (_reason, answer): Promise<void> => {
    if (answer instanceof Error)
      getMemberCodeEligibility.mockRejectedValue(answer);
    else getMemberCodeEligibility.mockResolvedValue(answer);
    const response = await create('code-ineligible', folderPath);
    expect(response.ok).toBe(false);
    expect(response.error).toEqual({
      code: 'surface_unavailable',
      message: "You can't create Code projects in Acme right now.",
    });
    expect(inspectFolder).not.toHaveBeenCalled();
    expect(createOrgMemberCodeProject).not.toHaveBeenCalled();
  });

  it('starts a new repository when no folder is given, and opens it', async (): Promise<void> => {
    createOrgMemberCodeProject.mockResolvedValue({
      ok: true,
      organizationProjectId: projectId,
      localWorkspaceId: 'workspace-1',
    });
    const response = await create('code-new-repo');
    expect(getMemberCodeEligibility).toHaveBeenCalledWith(org);
    expect(inspectFolder).not.toHaveBeenCalled();
    expect(createOrgMemberCodeProject).toHaveBeenCalledWith({
      organizationId: org,
      name: 'Payments service',
    });
    expect(navigateAfterRepositoryWorkspaceCreatedMock).toHaveBeenCalledWith(
      'workspace-1',
    );
    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      projectId,
      organizationId: org,
      workspaceId: 'workspace-1',
      message: 'Created Payments service in Acme.',
    });
    expect(useWorkspaceContextStore.getState().state.context).toEqual({
      kind: 'organization',
      organizationId: org,
    });
  });

  it('checks a folder, then creates the project in place', async (): Promise<void> => {
    inspectFolder.mockResolvedValue({
      kind: 'code',
      target: 'new',
      repository: null,
    });
    createOrgMemberCodeProject.mockResolvedValue({
      ok: true,
      organizationProjectId: projectId,
      localWorkspaceId: 'workspace-1',
    });
    const response = await create('code-folder', ` ${folderPath} `);
    expect(inspectFolder).toHaveBeenCalledWith({
      organizationId: org,
      path: folderPath,
    });
    expect(createOrgMemberCodeProject).toHaveBeenCalledWith({
      organizationId: org,
      name: 'Payments service',
      folderPath,
    });
    expect(response.result).toMatchObject({
      message: 'Created Payments service in Acme.',
    });
  });

  it("links a folder to the organization's existing project under that project's name", async (): Promise<void> => {
    inspectFolder.mockResolvedValue({
      kind: 'code',
      target: { projectId, projectName: 'Payments' },
      repository: { host: 'github.com', owner: 'acme', name: 'payments' },
    });
    createOrgMemberCodeProject.mockResolvedValue({
      ok: true,
      organizationProjectId: projectId,
      localWorkspaceId: 'workspace-1',
    });
    const response = await create('code-linked', folderPath);
    expect(createOrgMemberCodeProject).toHaveBeenCalledWith({
      organizationId: org,
      name: 'Payments',
      folderPath,
    });
    expect(response.result).toEqual({
      projectId,
      organizationId: org,
      workspaceId: 'workspace-1',
      message: 'Linked this folder to Payments in Acme.',
    });
  });

  it.each([
    [
      { kind: 'refused', reason: 'inside-repo' },
      "This folder is inside a git repository. Choose the repository's top folder.",
    ],
    // More than one match reads like no access: there is no picker.
    [
      { kind: 'refused', reason: 'ambiguous' },
      'Acme already has a project for this repository. Ask an admin for access.',
    ],
    [
      { kind: 'cowork' },
      "That folder isn't a git repository, so it can't be a Code project. Add it as a Cowork project from the Add project dialog.",
    ],
  ])(
    'creates nothing for a folder that cannot be a Code project (%j)',
    async (inspection, message): Promise<void> => {
      inspectFolder.mockResolvedValue(inspection);
      const response = await create('code-refused', folderPath);
      expect(response.ok).toBe(false);
      expect(response.error).toEqual({ code: 'execution_failed', message });
      expect(createOrgMemberCodeProject).not.toHaveBeenCalled();
    },
  );

  it('creates nothing when the folder check fails', async (): Promise<void> => {
    inspectFolder.mockRejectedValue(new Error('git failed'));
    const response = await create('code-unreadable', folderPath);
    expect(response.error).toEqual({
      code: 'execution_failed',
      message: "Couldn't check this folder. Choose it again.",
    });
    expect(createOrgMemberCodeProject).not.toHaveBeenCalled();
  });

  it.each([
    [
      { code: 'limit-reached' },
      `You've reached the limit of ${MEMBER_ORG_PROJECT_LIMIT} private projects in Acme. Delete one to make another.`,
    ],
    [
      { code: 'create-failed' },
      "Couldn't create Payments service in Acme. Try again.",
    ],
    [
      { code: 'unavailable' },
      "Couldn't create Payments service in Acme. Try again.",
    ],
    [
      { code: 'refused', reason: 'no-access' },
      'Acme already has a project for this repository. Ask an admin for access.',
    ],
  ])(
    'reports %j without opening anything',
    async (failure, message): Promise<void> => {
      createOrgMemberCodeProject.mockResolvedValue({ ok: false, ...failure });
      const response = await create('code-failed');
      expect(response.ok).toBe(false);
      expect(response.error).toEqual({ code: 'execution_failed', message });
      expect(
        navigateAfterRepositoryWorkspaceCreatedMock,
      ).not.toHaveBeenCalled();
    },
  );

  it('keeps the project id after a setup failure and offers no clone as the retry', async (): Promise<void> => {
    createOrgMemberCodeProject.mockResolvedValue({
      ok: false,
      code: 'setup-failed',
      organizationProjectId: projectId,
    });
    const response = await create('code-setup-failed');
    expect(response).toMatchObject({
      ok: true,
      result: {
        projectId,
        organizationId: org,
        state: 'setup-failed',
        message:
          "Payments service was created in Acme, but couldn't be set up on this computer. Add it from Acme in the Add project dialog to try again.",
      },
    });
    expect(response.result).not.toHaveProperty('retryAction');
    expect(navigateAfterRepositoryWorkspaceCreatedMock).not.toHaveBeenCalled();
  });

  it('does not say a linked project was created when its setup fails', async (): Promise<void> => {
    inspectFolder.mockResolvedValue({
      kind: 'code',
      target: { projectId, projectName: 'Payments' },
      repository: { host: 'github.com', owner: 'acme', name: 'payments' },
    });
    createOrgMemberCodeProject.mockResolvedValue({
      ok: false,
      code: 'setup-failed',
      organizationProjectId: projectId,
    });
    const response = await create('code-linked-setup-failed', folderPath);
    expect(response.ok).toBe(false);
    expect(response.error).toEqual({
      code: 'execution_failed',
      message: "Couldn't set up Payments on this computer. Try again.",
    });
  });

  it('preserves the creation receipt when opening the project fails', async (): Promise<void> => {
    createOrgMemberCodeProject.mockResolvedValue({
      ok: true,
      organizationProjectId: projectId,
      localWorkspaceId: 'workspace-1',
    });
    navigateAfterRepositoryWorkspaceCreatedMock.mockImplementation((): void => {
      throw new Error('navigation failed');
    });
    const response = await create('code-created-open-failed');
    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      projectId,
      organizationId: org,
      workspaceId: 'workspace-1',
      state: 'created',
      opened: false,
      message:
        "Created Payments service in Acme, but couldn't open it. Open it from the project list.",
    });
    expect(createOrgMemberCodeProject).toHaveBeenCalledTimes(1);
  });

  it('reports a thrown create as a failure to create', async (): Promise<void> => {
    createOrgMemberCodeProject.mockRejectedValue(new Error('boom'));
    const response = await create('code-throw');
    expect(response.ok).toBe(false);
    expect(response.error?.message).toBe(
      "Couldn't create Payments service in Acme. Try again.",
    );
  });
});

describe('sharing.open_dialog', () => {
  const customSkill = {
    name: 'release-notes',
    sourceId: 'custom:app',
    description: '',
    source: 'custom',
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updateAvailable: false,
    custom: true,
  };
  const marketplace = {
    id: 'acme-market',
    name: 'Acme',
    sourceType: 'github',
    sourceUrl: 'https://github.com/acme/plugins',
    plugins: [{ name: 'release-tools', facets: { claude: {} } }],
  };
  let unregisterHost: (() => void) | null = null;

  const dispatch = (target: unknown): ReturnType<typeof dispatchAppAction> =>
    dispatchAppAction({
      requestId: 'req-share-dialog',
      source: 'assistant',
      action: { type: 'sharing.open_dialog', target },
    } as unknown as Parameters<typeof dispatchAppAction>[0]);

  beforeEach(() => {
    mockLoadChatShareLocalData.mockReset().mockResolvedValue({
      installedSkills: [customSkill],
      marketplaces: [marketplace],
    });
    useShareRequestStore.setState({ hostCount: 0, request: null });
    unregisterHost = useShareRequestStore.getState().registerHost();
  });

  afterEach(() => {
    unregisterHost?.();
    unregisterHost = null;
  });

  it('validates the target shape', () => {
    const valid = (target: unknown): boolean =>
      __isValidAppAdvisorActionForTests({
        type: 'sharing.open_dialog',
        target,
      });
    expect(valid({ kind: 'skill', name: 'release-notes' })).toBe(true);
    expect(
      valid({
        kind: 'plugin',
        marketplaceId: 'acme-market',
        pluginName: 'release-tools',
      }),
    ).toBe(true);
    expect(valid({ kind: 'skill' })).toBe(false);
    expect(valid({ kind: 'plugin', pluginName: 'release-tools' })).toBe(false);
    expect(valid({ kind: 'pipeline', name: 'x' })).toBe(false);
    expect(valid(undefined)).toBe(false);
  });

  it('requests the skill dialog, defaulting the source to custom:app', async () => {
    const response = await dispatch({ kind: 'skill', name: 'release-notes' });

    expect(response.ok).toBe(true);
    // Accepted, not opened: sign-in and resolution may still be pending.
    expect(response.result).toEqual({
      message: 'Share dialog requested; the user confirms in the app.',
    });
    const request = useShareRequestStore.getState().request;
    expect(request).toMatchObject({
      target: {
        kind: 'skill',
        sourceId: 'custom:app',
        name: 'release-notes',
      },
      source: 'agent',
    });
    // Agent requests open in the main window.
    expect(request?.ownerDocument).toBeUndefined();
  });

  it('requests the plugin dialog for a shareable plugin', async () => {
    const target = {
      kind: 'plugin',
      marketplaceId: 'acme-market',
      pluginName: 'release-tools',
    };
    const response = await dispatch(target);

    expect(response.ok).toBe(true);
    expect(useShareRequestStore.getState().request).toMatchObject({
      target,
      source: 'agent',
    });
  });

  it.each([
    ['an unknown skill', { kind: 'skill', name: 'missing' }],
    [
      'a skill under an unshareable source',
      { kind: 'skill', name: 'release-notes', sourceId: 'github:acme/skills' },
    ],
    [
      'an unknown plugin',
      { kind: 'plugin', marketplaceId: 'acme-market', pluginName: 'missing' },
    ],
  ])('rejects %s as an invalid target', async (_label, target) => {
    const response = await dispatch(target);

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('invalid_target');
    expect(useShareRequestStore.getState().request).toBeNull();
  });

  it('reports an unavailable surface when no share host is mounted', async () => {
    unregisterHost?.();
    unregisterHost = null;

    const response = await dispatch({ kind: 'skill', name: 'release-notes' });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('surface_unavailable');
    expect(mockLoadChatShareLocalData).not.toHaveBeenCalled();
  });

  it('fails retryably when the installed inventory cannot be read', async () => {
    mockLoadChatShareLocalData.mockResolvedValue({
      installedSkills: null,
      marketplaces: null,
    });

    const response = await dispatch({ kind: 'skill', name: 'release-notes' });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({
      code: 'execution_failed',
      retryable: true,
    });
    expect(useShareRequestStore.getState().request).toBeNull();
  });
});

describe('CAN-3606 create-from-link dispatch', () => {
  it('queues a supplied prompt while the newly registered worktree is still preparing', async () => {
    installLinkHost();
    useProjectsStore.setState({
      createWorktree: jest
        .fn()
        .mockResolvedValue({ id: 'new-worktree', setupPhase: 'git-pending' }),
    });
    const sendMessage = jest.fn().mockResolvedValue(undefined);
    useChatStore.setState({ sendMessage });
    const response = await dispatchAppAction({
      requestId: 'link-create-queued-prompt',
      source: 'assistant',
      action: {
        type: 'worktree.create_from_link',
        url: 'https://github.com/acme/app/pull/7',
        prompt: 'Fix it',
      },
    });
    expect(response.ok).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      'Fix it',
      undefined,
      expect.objectContaining({
        projectId: 'project-1',
        worktreeId: 'new-worktree',
      }),
      undefined,
      expect.objectContaining({
        queueForSetup: true,
        throwOnDispatchFailure: true,
      }),
    );
  });
  it.each(['home', 'overview'] as const)(
    'does not infer an explicit project from a retained worktree on %s',
    async (activePage) => {
      installLinkHost();
      useNavigationStore.setState({ activePage });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      });
      useHomeComposerStore.setState({
        workspaceId: 'cowork-default',
        workspaceSelectionExplicit: false,
      });
      Object.assign(window.api, {
        searchLinearIssues: jest.fn().mockResolvedValue([
          {
            id: 'issue-1',
            identifier: 'CAN-1',
            title: 'Fix',
            description: null,
            url: 'https://linear.app/acme/issue/CAN-1',
            priority: 1,
            priorityLabel: 'Urgent',
            branchName: 'can-1-fix',
            attachments: [],
            attachmentsComplete: true,
          },
        ]),
      });
      const createWorktree = jest
        .fn()
        .mockResolvedValue({ id: 'new-worktree' });
      useProjectsStore.setState({ createWorktree });
      const response = await dispatchAppAction({
        requestId: 'implicit-link-project',
        source: 'assistant',
        action: {
          type: 'worktree.create_from_link',
          url: 'https://linear.app/acme/issue/CAN-1',
        },
      });
      expect(response.ok).toBe(false);
      expect(response.error?.message).toMatch(/choose.*project/i);
      expect(createWorktree).not.toHaveBeenCalled();
    },
  );

  it('does not select or open a registered worktree when cancelled during creation', async () => {
    installLinkHost();
    const controller = new AbortController();
    const selection = useChatStore.getState().selectedWorktree;
    const originalSelect = useChatStore.getState().selectWorktree;
    const selectWorktree = jest.fn();
    useChatStore.setState({ selectWorktree });
    useProjectsStore.setState({
      createWorktree: jest.fn(
        (projectId: string, options?: CreateWorktreeOptions) => {
          controller.abort();
          if (options?.select !== false)
            useChatStore.getState().selectWorktree(projectId, 'new-worktree');
          return Promise.resolve({ id: 'new-worktree' });
        },
      ),
    });
    const response = await dispatchAppAction({
      requestId: 'link-cancel-after-register',
      source: 'assistant',
      signal: controller.signal,
      action: {
        type: 'worktree.create_from_link',
        url: 'https://github.com/acme/app/pull/7',
      },
    });
    expect(response.ok).toBe(false);
    expect(response.result).toMatchObject({
      workspaceId: 'project-1',
      worktreeId: 'new-worktree',
    });
    expect(useChatStore.getState().selectedWorktree).toBe(selection);
    useChatStore.setState({ selectWorktree: originalSelect });
    expect(selectWorktree).not.toHaveBeenCalled();
  });

  it('uses backend suggested-branch resolution for an immediate Linear action', async () => {
    installLinkHost();
    Object.assign(window.api, {
      searchLinearIssues: jest.fn().mockResolvedValue([
        {
          id: 'issue-1',
          identifier: 'CAN-1',
          title: 'Fix',
          description: null,
          url: 'https://linear.app/acme/issue/CAN-1',
          priority: 1,
          priorityLabel: 'Urgent',
          branchName: 'can-1-fix',
          attachments: [{ url: 'https://github.com/acme/app' }],
          attachmentsComplete: true,
        },
      ]),
      homeListBranchTargets: jest
        .fn()
        .mockRejectedValue(new Error('branch listing unavailable')),
    });
    const createWorktree = jest.fn().mockResolvedValue({ id: 'new-worktree' });
    useProjectsStore.setState({ createWorktree });
    const response = await dispatchAppAction({
      requestId: 'link-linear-backend-branch',
      source: 'assistant',
      action: {
        type: 'worktree.create_from_link',
        url: 'https://linear.app/acme/issue/CAN-1',
      },
    });
    expect(response.ok).toBe(true);
    expect(createWorktree).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ suggestedBranch: 'can-1-fix' }),
    );
  });

  function installLinkHost(): void {
    Object.assign(window.api, {
      getRepoSlug: jest.fn().mockResolvedValue({ owner: 'acme', repo: 'app' }),
      resolvePullRequest: jest.fn().mockResolvedValue({
        number: 7,
        title: 'Fix',
        headRefName: 'fix/login',
        url: 'https://github.com/acme/app/pull/7',
      }),
      listUserGitHubRepos: jest.fn().mockResolvedValue([]),
    });
    useProjectsStore.setState({
      projects: [makeWorkspace()],
      hasHydratedProjects: true,
    });
    useChatStore.setState({
      selectedWorktree: null,
      modelDefaults: {
        ...makeClaudeTerminalModelDefaults(),
        defaultChatInterfaceMode: 'canopy',
      },
    });
    useHomeComposerStore.getState().setText('an unrelated Home draft');
  }

  it('uses local resolution and opens a worktree chat without changing the Home draft', async () => {
    installLinkHost();
    const createWorktree = jest.fn().mockResolvedValue({ id: 'new-worktree' });
    useProjectsStore.setState({ createWorktree });
    const home = useHomeComposerStore.getState();
    const response = await dispatchAppAction({
      requestId: 'link-create-success',
      source: 'assistant',
      action: {
        type: 'worktree.create_from_link',
        url: 'https://github.com/acme/app/pull/7',
      },
    });
    expect(createWorktree).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        existingBranch: 'fix/login',
        suppressStartPage: true,
      }),
    );
    expect(response.ok).toBe(true);
    expect(useHomeComposerStore.getState()).toBe(home);
  });

  it('returns an actionable blocker without a project mutation', async () => {
    installLinkHost();
    const createWorktree = jest.fn();
    useProjectsStore.setState({ projects: [], createWorktree });
    const response = await dispatchAppAction({
      requestId: 'link-create-blocked',
      source: 'assistant',
      action: {
        type: 'worktree.create_from_link',
        url: 'https://github.com/acme/missing',
      },
    });
    expect(response.ok).toBe(false);
    expect(response.error?.message).toMatch(/list.*confirm access/);
    expect(createWorktree).not.toHaveBeenCalled();
    expect(useHomeComposerStore.getState().text).toBe(
      'an unrelated Home draft',
    );
  });

  it('honors cancellation before creating a worktree', async () => {
    installLinkHost();
    const controller = new AbortController();
    controller.abort();
    const createWorktree = jest.fn();
    useProjectsStore.setState({ createWorktree });
    const response = await dispatchAppAction({
      requestId: 'link-create-cancelled',
      source: 'assistant',
      signal: controller.signal,
      action: {
        type: 'worktree.create_from_link',
        url: 'https://github.com/acme/app/pull/7',
      },
    });
    expect(response.ok).toBe(false);
    expect(createWorktree).not.toHaveBeenCalled();
  });
});

describe('main-owned chat creation actions', () => {
  it.each([
    { type: 'projects.create_task', projectId: 'project-a' },
    {
      type: 'projects.create_task_chat',
      projectId: 'project-a',
      taskId: 'task-a',
    },
    { type: 'bots.create_task', botId: 'app_advisor', initialMessage: 'Go' },
    {
      type: 'bots.create_task_chat',
      botId: 'app_advisor',
      taskId: 'entry-a',
      initialMessage: 'Go',
    },
  ])('refuses $type in the renderer', async (action) => {
    const response = await dispatchAppAction({
      requestId: `main-owned-${action.type}`,
      source: 'assistant',
      action,
    });
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'unsupported_action' },
    });
  });
});

describe('standalone reveal after main-owned creation', () => {
  it('refreshes brand-new entries before selection and returns the legacy chat/settings projections without creating', async () => {
    useProjectsStore.setState({ projects: [], hasHydratedProjects: false });
    const tab = makeChatTab({
      id: 'main-created-chat',
      title: '',
      description: '',
      messages: [],
    });
    workEntriesApiMock.resolveChat.mockResolvedValue({
      entryId: 'main-created-entry',
      archivedInEntryId: null,
    });
    workEntriesApiMock.list.mockResolvedValue({
      entries: [
        {
          id: 'main-created-entry',
          createdAt: new Date(0).toISOString(),
          chatCount: 1,
          title: 'New work entry',
        },
      ],
    });
    chatApiMock.loadTabs.mockResolvedValue({
      version: 1,
      activeTabId: tab.id,
      tabs: [tab],
    });
    useStandaloneChatStore.setState({
      activeChatProjectId: 'project-a',
      activeWorkEntryId: null,
      workEntries: [],
      initialized: true,
    });
    workEntriesApiMock.create.mockClear();
    const switchProject = jest
      .spyOn(useStandaloneChatStore.getState(), 'switchChatProject')
      .mockResolvedValueOnce(true);
    const refresh = jest
      .spyOn(useStandaloneChatStore.getState(), 'refreshWorkEntries')
      .mockImplementationOnce(async (projectId) => {
        if (projectId === undefined) {
          throw new Error(
            'Expected a project ID when refreshing work entries.',
          );
        }
        expect(projectId).toBe('project-a');
        const { entries } = await workEntriesApiMock.list({ projectId });
        useStandaloneChatStore.setState({ workEntries: entries });
      });
    const select = jest.spyOn(useStandaloneChatStore.getState(), 'selectChat');
    try {
      select.mockImplementationOnce((chatId) => {
        expect(
          useStandaloneChatStore
            .getState()
            .workEntries.map((entry) => entry.id),
        ).toContain('main-created-entry');
        useChatStore.setState({
          selectedWorktree: {
            projectId: 'project-a',
            worktreeId: 'main-created-entry',
          },
          worktreeChats: {
            'project-a/main-created-entry': {
              activeTabId: tab.id,
              tabs: [tab],
            },
          },
        });
        useStandaloneChatStore.setState({
          activeWorkEntryId: 'main-created-entry',
        });
        return Promise.resolve(chatId === tab.id);
      });
      const response = await dispatchAppAction({
        requestId: 'main-created-reveal',
        source: 'assistant',
        action: {
          type: 'standalone-chat.switch_chat',
          projectId: 'project-a',
          chatId: tab.id,
        },
      });
      expect(response.error).toBeUndefined();
      expect(response).toMatchObject({
        ok: true,
        result: {
          projectId: 'project-a',
          workEntryId: 'main-created-entry',
          chat: { id: tab.id, description: '', messageCount: 0 },
          settings: {
            projectId: 'project-a',
            worktreeId: 'main-created-entry',
            chatId: tab.id,
          },
        },
      });
      expect(workEntriesApiMock.create).not.toHaveBeenCalled();
    } finally {
      select.mockRestore();
      switchProject.mockRestore();
      refresh.mockRestore();
    }
  });
  it('keeps a chat the user selects while the reveal refresh is pending', async () => {
    workEntriesApiMock.resolveChat.mockResolvedValue({
      entryId: 'main-created-entry',
      archivedInEntryId: null,
    });
    useStandaloneChatStore.setState({
      activeChatProjectId: 'project-a',
      initialized: true,
    });
    const switchProject = jest
      .spyOn(useStandaloneChatStore.getState(), 'switchChatProject')
      .mockResolvedValueOnce(true);
    const select = jest.spyOn(useStandaloneChatStore.getState(), 'selectChat');
    const refresh = jest
      .spyOn(useStandaloneChatStore.getState(), 'refreshWorkEntries')
      .mockImplementationOnce(() => {
        // The user picks another task while the refresh is in flight.
        void useStandaloneChatStore.getState().selectWorkEntry('user-entry');
        return Promise.resolve();
      });
    try {
      const response = await dispatchAppAction({
        requestId: 'superseded-reveal',
        source: 'assistant',
        action: {
          type: 'standalone-chat.switch_chat',
          projectId: 'project-a',
          chatId: 'main-created-chat',
        },
      });
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'stale_ui_state' },
      });
      expect(select).not.toHaveBeenCalled();
    } finally {
      select.mockRestore();
      switchProject.mockRestore();
      refresh.mockRestore();
    }
  });
  it('does not navigate after a superseded chat selection', async () => {
    useStandaloneChatStore.setState({
      activeChatProjectId: 'project-a',
      initialized: true,
    });
    workEntriesApiMock.create.mockClear();
    const select = jest
      .spyOn(useStandaloneChatStore.getState(), 'selectChat')
      .mockResolvedValueOnce(false);
    const navigate = jest.spyOn(useNavigationStore.getState(), 'navigate');
    try {
      const response = await dispatchAppAction({
        requestId: 'superseded-created-reveal',
        source: 'assistant',
        action: {
          type: 'standalone-chat.switch_chat',
          projectId: 'project-a',
          chatId: 'main-created-chat',
        },
      });
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'stale_ui_state' },
      });
      expect(navigate).not.toHaveBeenCalled();
      expect(workEntriesApiMock.create).not.toHaveBeenCalled();
    } finally {
      select.mockRestore();
      navigate.mockRestore();
    }
  });
});

describe('capability tile handoffs from App Advisor (CAN-3322)', () => {
  it.each(['local', 'shared'] as const)(
    'opens a %s agent through the validated dispatcher',
    async (source) => {
      const snapshot = useFeatureFlagsStore.getState().snapshot;
      useFeatureFlagsStore.setState({
        snapshot: {
          ...snapshot,
          values: {
            ...snapshot.values,
            [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]: true,
          },
        },
      });
      const response = await dispatchAppAction({
        requestId: `tile-agent-${source}`,
        source: 'assistant',
        action: { type: 'agents.open_editor', source, agentId: 'agent-1' },
      });
      expect(response).toMatchObject({
        ok: true,
        result: { agentId: 'agent-1' },
      });
      expect(useNavigationStore.getState().activePage).toBe('plugins');
      if (source === 'local') {
        expect(useNavigationStore.getState().pendingPluginsNavigation).toEqual({
          kind: 'entry-detail',
          entryId: 'agent:local:agent-1',
          intent: 'edit',
        });
      } else {
        expect(useNavigationStore.getState().pendingPluginsNavigation).toEqual({
          kind: 'entry-detail',
          entryId: 'agent:shared:agent-1',
        });
      }
    },
  );

  it.each(['local', 'shared'] as const)(
    'refuses a %s agent editor while Agents is switched off (CAN-4266)',
    async (source) => {
      setFeatureFlagForTest(
        CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key,
        false,
      );
      useNavigationStore.setState({
        activePage: 'overview',
        pendingPluginsNavigation: undefined,
      });

      const response = await dispatchAppAction({
        requestId: `tile-agent-${source}-off`,
        source: 'assistant',
        action: { type: 'agents.open_editor', source, agentId: 'agent-1' },
      });

      expect(response).toEqual(
        expect.objectContaining({
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: 'Agents are not available.',
          },
        }),
      );
      expect(useNavigationStore.getState().activePage).toBe('overview');
      expect(
        useNavigationStore.getState().pendingPluginsNavigation,
      ).toBeUndefined();
    },
  );

  it('opens a capability entry through the validated dispatcher', async () => {
    const response = await dispatchAppAction({
      requestId: 'tile-capability',
      source: 'assistant',
      action: {
        type: 'capabilities.open_entry',
        entry: { type: 'shared-skill', skillId: 'skill-1' },
      },
    });
    expect(response).toMatchObject({
      ok: true,
      result: { entryId: 'skill:shared:skill-1' },
    });
    expect(useNavigationStore.getState().pendingPluginsNavigation).toEqual({
      kind: 'entry-detail',
      entryId: 'skill:shared:skill-1',
    });
  });

  it.each([
    { type: 'agents.open_editor', agentId: 'agent-1', source: 'unknown' },
    { type: 'agents.open_editor', agentId: '', source: 'local' },
    { type: 'capabilities.open_entry', entry: { type: 'shared-skill' } },
    {
      type: 'capabilities.open_entry',
      entry: { type: 'arbitrary-route', path: '/settings' },
    },
  ])('rejects a malformed tile handoff: %j', async (action) => {
    const response = await dispatchAppAction({
      requestId: 'tile-invalid',
      source: 'assistant',
      action,
    });
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'invalid_payload' },
    });
  });
});

describe('workspace.create_multi_repo (CAN-3573)', (): void => {
  const org = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const projectId = '33333333-3333-4333-8333-333333333331';
  const createWorkspace = jest.fn();
  const createOrgMemberMultiRepoProject = jest.fn();
  const getMemberCodeEligibility = jest.fn();
  let originals: Pick<
    ReturnType<typeof useProjectsStore.getState>,
    'createWorkspace' | 'createOrgMemberMultiRepoProject'
  >;
  const create = (requestId: string): ReturnType<typeof dispatchAppAction> =>
    dispatchAppAction({
      requestId,
      source: 'assistant',
      action: { type: 'workspace.create_multi_repo', name: '  Payments ' },
    });
  const selectPersonal = (): void => {
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: { context: { kind: 'personal' }, revision: 1, organizations: [] },
    });
  };
  const selectOrganization = (): void => {
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context: { kind: 'organization', organizationId: org },
        revision: 1,
        organizations: [{ id: org, name: 'Acme', role: 'MEMBER' }],
      },
    });
  };
  const setOrgProjectsEnabled = (enabled: boolean): void => {
    useFeatureFlagsStore.getState().setSnapshot({
      ...getDefaultFeatureFlagSnapshot(),
      values: {
        ...getDefaultFeatureFlagSnapshot().values,
        'canopy-shared-org-projects-enabled': enabled,
      },
    });
  };

  beforeEach((): void => {
    const projects = useProjectsStore.getState();
    originals = {
      createWorkspace: projects.createWorkspace,
      createOrgMemberMultiRepoProject: projects.createOrgMemberMultiRepoProject,
    };
    createWorkspace.mockReset().mockResolvedValue('workspace-new');
    createOrgMemberMultiRepoProject.mockReset();
    getMemberCodeEligibility.mockReset().mockResolvedValue('eligible');
    openCreatedMultiRepoWorkspaceSettingsMock.mockReset();
    useProjectsStore.setState({
      createWorkspace,
      createOrgMemberMultiRepoProject,
    });
    Object.assign(window.api.orgProjects, { getMemberCodeEligibility });
    setOrgProjectsEnabled(true);
    selectPersonal();
  });

  afterEach((): void => {
    useProjectsStore.setState(originals);
  });

  it('is not revision-agnostic for any multi-repo project mutation', (): void => {
    for (const type of [
      'workspace.create_multi_repo',
      'workspace.add_repo',
      'workspace.remove_repo',
    ])
      expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).not.toContain(type);
  });

  it('requires a name within the organization project name limit', (): void => {
    const valid = (action: Record<string, unknown>): boolean =>
      __isValidAppAdvisorActionForTests({
        type: 'workspace.create_multi_repo',
        ...action,
      });
    expect(valid({})).toBe(false);
    expect(valid({ name: '   ' })).toBe(false);
    expect(valid({ name: 42 })).toBe(false);
    expect(valid({ name: 'x'.repeat(ORG_PROJECT_LIMITS.nameLength + 1) })).toBe(
      false,
    );
    expect(
      valid({ name: ` ${'x'.repeat(ORG_PROJECT_LIMITS.nameLength)} ` }),
    ).toBe(true);
  });

  it('rejects an invalid name without creating anything', async (): Promise<void> => {
    const response = await dispatchAppAction({
      requestId: 'multi-blank',
      source: 'assistant',
      action: { type: 'workspace.create_multi_repo', name: '  ' },
    });
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'invalid_payload' },
    });
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(createOrgMemberMultiRepoProject).not.toHaveBeenCalled();
  });

  it('creates a Personal project by trimmed name and opens its repository settings', async (): Promise<void> => {
    setOrgProjectsEnabled(false);
    const response = await create('multi-personal');
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(createWorkspace).toHaveBeenCalledWith('Payments');
    expect(createOrgMemberMultiRepoProject).not.toHaveBeenCalled();
    expect(getMemberCodeEligibility).not.toHaveBeenCalled();
    expect(openCreatedMultiRepoWorkspaceSettingsMock).toHaveBeenCalledWith(
      'workspace-new',
    );
    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      workspaceId: 'workspace-new',
      state: 'created',
      settingsOpened: true,
      message: 'Created Payments. Add its repositories in project settings.',
    });
  });

  it('creates nothing when the selected context cannot be loaded', async (): Promise<void> => {
    const hydrate = jest.fn().mockResolvedValue(undefined);
    useWorkspaceContextStore.setState({ hydrated: false, hydrate });
    const response = await create('multi-unhydrated');
    expect(hydrate).toHaveBeenCalled();
    expect(response.error).toEqual({
      code: 'surface_unavailable',
      message: "The selected context isn't loaded yet. Try again.",
    });
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(createOrgMemberMultiRepoProject).not.toHaveBeenCalled();
  });

  it('creates nothing when projects cannot be loaded', async (): Promise<void> => {
    useProjectsStore.setState({
      hasHydratedProjects: false,
      loadProjects: jest.fn().mockRejectedValue(new Error('disk')),
    });
    const response = await create('multi-projects-failed');
    expect(response.error).toEqual({
      code: 'surface_unavailable',
      message: "Projects aren't loaded yet. Try again.",
    });
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('converts a rejected context hydration into an error without Personal fallback', async (): Promise<void> => {
    useWorkspaceContextStore.setState({
      hydrated: false,
      hydrate: jest.fn().mockRejectedValue(new Error('context unavailable')),
    });
    const response = await create('multi-context-hydration-rejected');
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'execution_failed', message: 'context unavailable' },
    });
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(createOrgMemberMultiRepoProject).not.toHaveBeenCalled();
  });

  it('reports a Personal creation failure without retrying', async (): Promise<void> => {
    createWorkspace.mockRejectedValue(new Error('disk full'));
    const response = await create('multi-personal-failed');
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(response.error).toEqual({
      code: 'execution_failed',
      message:
        "Couldn't create Payments. Check the project list before trying again.",
    });
    expect(openCreatedMultiRepoWorkspaceSettingsMock).not.toHaveBeenCalled();
  });

  it('requires successful project hydration rather than swallowing the load failure', async (): Promise<void> => {
    const loadProjects = jest.fn(
      (options?: { requireSuccess?: boolean }): Promise<void> => {
        // Ordinary store hydration resolves even when IPC fails.
        return options?.requireSuccess
          ? Promise.reject(new Error('disk'))
          : Promise.resolve();
      },
    );
    useProjectsStore.setState({ hasHydratedProjects: false, loadProjects });
    const response = await create('multi-hydration-required');
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable' },
    });
    expect(loadProjects).toHaveBeenCalledWith({
      silent: true,
      requireSuccess: true,
    });
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(createOrgMemberMultiRepoProject).not.toHaveBeenCalled();
  });

  it('awaits required hydration when the initial project load is already pending', async (): Promise<void> => {
    const hydration = Promise.withResolvers<void>();
    const loadProjects = jest.fn((): Promise<void> => hydration.promise);
    useProjectsStore.setState({
      hasHydratedProjects: false,
      isLoading: true,
      loadProjects,
    });
    const pending = create('multi-hydration-pending');
    await Promise.resolve();
    const callsBeforeHydration = createWorkspace.mock.calls.length;
    hydration.resolve();
    const response = await pending;
    expect(callsBeforeHydration).toBe(0);
    expect(loadProjects).toHaveBeenCalledWith({
      silent: true,
      requireSuccess: true,
    });
    expect(response.ok).toBe(true);
    expect(createWorkspace).toHaveBeenCalledTimes(1);
  });

  it.each(['personal', 'organization'])(
    'refuses a context switch from %s while project hydration is pending',
    async (initialContext): Promise<void> => {
      createOrgMemberMultiRepoProject.mockResolvedValue({
        ok: true,
        organizationProjectId: projectId,
        localWorkspaceId: 'workspace-org',
      });
      if (initialContext === 'organization') selectOrganization();
      const hydration = Promise.withResolvers<void>();
      const loadProjects = jest.fn((): Promise<void> => hydration.promise);
      useProjectsStore.setState({
        hasHydratedProjects: false,
        isLoading: true,
        loadProjects,
      });
      const pending = create(`multi-hydration-switch-${initialContext}`);
      await Promise.resolve();
      expect(loadProjects).toHaveBeenCalled();
      if (initialContext === 'organization') selectPersonal();
      else selectOrganization();
      hydration.resolve();
      const response = await pending;
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'stale_ui_state' },
      });
      expect(createWorkspace).not.toHaveBeenCalled();
      expect(createOrgMemberMultiRepoProject).not.toHaveBeenCalled();
      expect(getMemberCodeEligibility).not.toHaveBeenCalled();
      expect(openCreatedMultiRepoWorkspaceSettingsMock).not.toHaveBeenCalled();
    },
  );

  it('keeps a created project when its settings cannot open', async (): Promise<void> => {
    openCreatedMultiRepoWorkspaceSettingsMock.mockImplementation((): void => {
      throw new Error('navigation');
    });
    const response = await create('multi-settings-failed');
    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      workspaceId: 'workspace-new',
      state: 'created',
      settingsOpened: false,
      message:
        "Created Payments, but couldn't open its settings. Open project settings to add repositories.",
    });
  });

  it('creates exactly the name in the selected organization', async (): Promise<void> => {
    selectOrganization();
    createOrgMemberMultiRepoProject.mockResolvedValue({
      ok: true,
      organizationProjectId: projectId,
      localWorkspaceId: 'workspace-org',
    });
    const response = await create('multi-org');
    expect(getMemberCodeEligibility).toHaveBeenCalledWith(org);
    expect(createOrgMemberMultiRepoProject).toHaveBeenCalledTimes(1);
    expect(createOrgMemberMultiRepoProject).toHaveBeenCalledWith({
      organizationId: org,
      name: 'Payments',
    });
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(openCreatedMultiRepoWorkspaceSettingsMock).toHaveBeenCalledWith(
      'workspace-org',
    );
    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      workspaceId: 'workspace-org',
      organizationId: org,
      projectId,
      state: 'created',
      settingsOpened: true,
      message:
        'Created Payments in Acme. Add its repositories in project settings.',
    });
  });

  it('refuses in an organization when organization projects are off', async (): Promise<void> => {
    selectOrganization();
    setOrgProjectsEnabled(false);
    const response = await create('multi-org-flag-off');
    expect(response.error).toEqual({
      code: 'surface_unavailable',
      message: 'Organization projects are not available.',
    });
    expect(getMemberCodeEligibility).not.toHaveBeenCalled();
    expect(createOrgMemberMultiRepoProject).not.toHaveBeenCalled();
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    ['the member cannot create projects there', 'ineligible'],
    ['the eligibility check cannot answer', new Error('No handler')],
  ])('refuses when %s', async (_reason, answer): Promise<void> => {
    selectOrganization();
    if (answer instanceof Error)
      getMemberCodeEligibility.mockRejectedValue(answer);
    else getMemberCodeEligibility.mockResolvedValue(answer);
    const response = await create('multi-org-ineligible');
    expect(response.error).toEqual({
      code: 'surface_unavailable',
      message: "You can't create projects in Acme right now.",
    });
    expect(createOrgMemberMultiRepoProject).not.toHaveBeenCalled();
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('creates nothing when the context changes during the eligibility check', async (): Promise<void> => {
    selectOrganization();
    getMemberCodeEligibility.mockImplementation((): Promise<string> => {
      selectPersonal();
      return Promise.resolve('eligible');
    });
    const response = await create('multi-org-stale');
    expect(response.error).toEqual({
      code: 'stale_ui_state',
      message: 'The selected context changed. Nothing was created.',
    });
    expect(createOrgMemberMultiRepoProject).not.toHaveBeenCalled();
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('keeps the captured organization when the context changes after creation starts', async (): Promise<void> => {
    selectOrganization();
    createOrgMemberMultiRepoProject.mockImplementation((): Promise<unknown> => {
      selectPersonal();
      return Promise.resolve({
        ok: true,
        organizationProjectId: projectId,
        localWorkspaceId: 'workspace-org',
      });
    });
    const response = await create('multi-org-late-switch');
    expect(createOrgMemberMultiRepoProject).toHaveBeenCalledTimes(1);
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(response.result).toMatchObject({
      workspaceId: 'workspace-org',
      organizationId: org,
      state: 'created',
    });
    expect(useWorkspaceContextStore.getState().state.context).toEqual({
      kind: 'personal',
    });
  });

  it('refuses a context round-trip during eligibility even when the selected organization matches again', async (): Promise<void> => {
    selectOrganization();
    getMemberCodeEligibility.mockImplementation((): Promise<string> => {
      selectPersonal();
      selectOrganization();
      useWorkspaceContextStore.setState((current) => ({
        state: { ...current.state, revision: current.state.revision + 2 },
      }));
      return Promise.resolve('eligible');
    });
    const response = await create('multi-org-context-round-trip');
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'stale_ui_state' },
    });
    expect(createOrgMemberMultiRepoProject).not.toHaveBeenCalled();
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('preserves every organization receipt ID if opening settings fails', async (): Promise<void> => {
    selectOrganization();
    createOrgMemberMultiRepoProject.mockResolvedValue({
      ok: true,
      organizationProjectId: projectId,
      localWorkspaceId: 'workspace-org',
    });
    openCreatedMultiRepoWorkspaceSettingsMock.mockImplementation((): void => {
      throw new Error('navigation');
    });
    const response = await create('multi-org-navigation-failed');
    expect(response).toMatchObject({
      ok: true,
      result: {
        workspaceId: 'workspace-org',
        organizationId: org,
        projectId,
        state: 'created',
        settingsOpened: false,
      },
    });
    expect(createOrgMemberMultiRepoProject).toHaveBeenCalledTimes(1);
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('ignores unsupported create inputs on direct renderer dispatch', async (): Promise<void> => {
    await dispatchAppAction({
      requestId: 'multi-direct-unsupported',
      source: 'assistant',
      action: {
        type: 'workspace.create_multi_repo',
        name: ' Payments ',
        folderPath: '/do-not-import',
        localWorkspaceId: 'do-not-retry',
      },
    });
    expect(createWorkspace).toHaveBeenCalledWith('Payments');
    expect(createWorkspace).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      { code: 'limit-reached' },
      'execution_failed',
      `You've reached the limit of ${MEMBER_ORG_PROJECT_LIMIT} private projects in Acme. Delete one to make another.`,
    ],
    [
      {
        code: 'refused',
        reason: 'no-access',
        repositories: ['acme/payments'],
      },
      'execution_failed',
      orgCreateFolderRefusalText('no-access', 'Acme', ['acme/payments']),
    ],
    [
      { code: 'unavailable' },
      'surface_unavailable',
      "Projects in Acme aren't available right now.",
    ],
    [
      { code: 'create-failed' },
      'execution_failed',
      "Couldn't create Payments in Acme. Try again.",
    ],
  ])(
    'reports %j without creating again or opening settings',
    async (failure, code, message): Promise<void> => {
      selectOrganization();
      createOrgMemberMultiRepoProject.mockResolvedValue({
        ok: false,
        ...failure,
      });
      const response = await create('multi-org-failed');
      expect(response.ok).toBe(false);
      expect(response.error).toEqual({ code, message });
      expect(createOrgMemberMultiRepoProject).toHaveBeenCalledTimes(1);
      expect(createWorkspace).not.toHaveBeenCalled();
      expect(openCreatedMultiRepoWorkspaceSettingsMock).not.toHaveBeenCalled();
    },
  );

  it('reports a thrown organization creation without retrying', async (): Promise<void> => {
    selectOrganization();
    createOrgMemberMultiRepoProject.mockRejectedValue(new Error('offline'));
    const response = await create('multi-org-threw');
    expect(response.error).toEqual({
      code: 'execution_failed',
      message:
        "Couldn't create Payments in Acme. Check the project list before trying again.",
    });
    expect(createOrgMemberMultiRepoProject).toHaveBeenCalledTimes(1);
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('reports a partial setup as created without normal navigation or a setup retry', async (): Promise<void> => {
    selectOrganization();
    createOrgMemberMultiRepoProject.mockResolvedValue({
      ok: false,
      code: 'setup-failed',
      localWorkspaceId: 'workspace-org',
    });
    const response = await create('multi-org-setup-failed');
    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      workspaceId: 'workspace-org',
      organizationId: org,
      state: 'setup-failed',
      message:
        "Payments was created in Acme, but couldn't be set up on this computer. Use Try again in the Add project dialog.",
    });
    expect(openCreatedMultiRepoWorkspaceSettingsMock).not.toHaveBeenCalled();
  });
});

describe('workspace.add_repo and workspace.remove_repo (CAN-3573)', (): void => {
  const addRepoToWorkspace = jest.fn();
  const removeRepoFromWorkspace = jest.fn();
  let originals: Pick<
    ReturnType<typeof useProjectsStore.getState>,
    'addRepoToWorkspace' | 'removeRepoFromWorkspace'
  >;
  let requestCount = 0;
  const dispatch = (
    action: Record<string, unknown>,
  ): ReturnType<typeof dispatchAppAction> =>
    dispatchAppAction({
      requestId: `repo-action-${(requestCount += 1)}`,
      source: 'assistant',
      action,
    });
  const replaceRepos = (repos: MultiRepoSidebarItem['repos']): void => {
    useProjectsStore.setState({
      projects: useProjectsStore
        .getState()
        .projects.map((item) =>
          item.id === 'workspace-1' && item.type === 'multi-repo'
            ? { ...item, repos }
            : item,
        ),
    });
  };

  beforeEach((): void => {
    const projects = useProjectsStore.getState();
    originals = {
      addRepoToWorkspace: projects.addRepoToWorkspace,
      removeRepoFromWorkspace: projects.removeRepoFromWorkspace,
    };
    addRepoToWorkspace.mockReset();
    removeRepoFromWorkspace.mockReset();
    useProjectsStore.setState({
      projects: [makeMultiRepoWorkspace(), makeWorkspace()],
      addRepoToWorkspace,
      removeRepoFromWorkspace,
    });
  });

  afterEach((): void => {
    useProjectsStore.setState(originals);
  });

  it('requires a nonblank project id and an absolute local path to add', (): void => {
    const valid = (action: Record<string, unknown>): boolean =>
      __isValidAppAdvisorActionForTests({
        type: 'workspace.add_repo',
        ...action,
      });
    expect(valid({ repoPath: '/repo-c' })).toBe(false);
    expect(valid({ workspaceId: '  ', repoPath: '/repo-c' })).toBe(false);
    expect(valid({ workspaceId: 'workspace-1' })).toBe(false);
    for (const repoPath of [
      '  ',
      'repo-c',
      './repo-c',
      'https://github.com/acme/repo-c',
      'file:///repo-c',
      42,
    ])
      expect(valid({ workspaceId: 'workspace-1', repoPath })).toBe(false);
    for (const repoPath of [
      '/Users/me/My Repos/repo c ',
      'C:\\Users\\me\\repo-c',
      'C:/Users/me/repo-c',
      '\\repos\\repo-c',
      '\\\\server\\share\\repo-c',
    ])
      expect(valid({ workspaceId: 'workspace-1', repoPath })).toBe(true);
  });

  it('requires nonblank project and repository ids to remove', (): void => {
    const valid = (action: Record<string, unknown>): boolean =>
      __isValidAppAdvisorActionForTests({
        type: 'workspace.remove_repo',
        ...action,
      });
    expect(valid({ repoId: 'repo-a' })).toBe(false);
    expect(valid({ workspaceId: 'workspace-1' })).toBe(false);
    expect(valid({ workspaceId: 'workspace-1', repoId: '  ' })).toBe(false);
    expect(valid({ workspaceId: 'workspace-1', repoId: 7 })).toBe(false);
    expect(valid({ workspaceId: 'workspace-1', repoId: 'repo-a' })).toBe(true);
  });

  it.each([
    { type: 'workspace.create_multi_repo', name: 'Payments' },
    {
      type: 'workspace.add_repo',
      workspaceId: 'workspace-1',
      repoPath: '/repo-c',
    },
    {
      type: 'workspace.remove_repo',
      workspaceId: 'workspace-1',
      repoId: 'repo-a',
    },
  ])(
    '$type refuses a stale revision without mutation',
    async (action): Promise<void> => {
      const createWorkspace = jest.fn();
      const createOrgMemberMultiRepoProject = jest.fn();
      const state = useProjectsStore.getState();
      const spyPersonal = jest
        .spyOn(state, 'createWorkspace')
        .mockImplementation(createWorkspace);
      const spyOrganization = jest
        .spyOn(state, 'createOrgMemberMultiRepoProject')
        .mockImplementation(createOrgMemberMultiRepoProject);
      try {
        const response = await dispatchAppAction({
          requestId: `multi-stale-${action.type}`,
          source: 'assistant',
          expectedUiRevision:
            useCurrentUiStateStore.getState().getEnvelope().revision + 1,
          action,
        });
        expect(response).toMatchObject({
          ok: false,
          error: { code: 'stale_ui_state' },
        });
        expect(createWorkspace).not.toHaveBeenCalled();
        expect(createOrgMemberMultiRepoProject).not.toHaveBeenCalled();
        expect(addRepoToWorkspace).not.toHaveBeenCalled();
        expect(removeRepoFromWorkspace).not.toHaveBeenCalled();
      } finally {
        spyPersonal.mockRestore();
        spyOrganization.mockRestore();
      }
    },
  );

  it.each([
    { type: 'workspace.add_repo', workspaceId: ' ', repoPath: '/repo-c' },
    { type: 'workspace.add_repo', workspaceId: 42, repoPath: '/repo-c' },
    {
      type: 'workspace.add_repo',
      workspaceId: 'workspace-1',
      repoPath: 'relative',
    },
    { type: 'workspace.remove_repo', workspaceId: 'workspace-1', repoId: ' ' },
    { type: 'workspace.remove_repo', workspaceId: 42, repoId: 'repo-a' },
  ])(
    'rejects invalid direct dispatch $type before mutation',
    async (action): Promise<void> => {
      const response = await dispatch(action);
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'invalid_payload' },
      });
      expect(addRepoToWorkspace).not.toHaveBeenCalled();
      expect(removeRepoFromWorkspace).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      type: 'workspace.add_repo',
      workspaceId: 'workspace-1',
      repoPath: '/repo-c',
    },
    {
      type: 'workspace.remove_repo',
      workspaceId: 'workspace-1',
      repoId: 'repo-a',
    },
  ])(
    '$type requires successful hydration before resolving the target',
    async (action): Promise<void> => {
      useProjectsStore.setState({
        hasHydratedProjects: false,
        loadProjects: jest.fn(
          (options?: { requireSuccess?: boolean }): Promise<void> =>
            options?.requireSuccess
              ? Promise.reject(new Error('disk'))
              : Promise.resolve(),
        ),
      });
      const response = await dispatch(action);
      expect(response.ok).toBe(false);
      expect(addRepoToWorkspace).not.toHaveBeenCalled();
      expect(removeRepoFromWorkspace).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['workspace.add_repo', { repoPath: '/repo-c' }],
    ['workspace.remove_repo', { repoId: 'repo-a' }],
  ])(
    '%s rejects a missing or single-repo project before mutating',
    async (type, fields): Promise<void> => {
      const missing = await dispatch({ type, workspaceId: 'nope', ...fields });
      expect(missing.error).toEqual({
        code: 'not_found',
        message: 'Project nope was not found.',
      });
      const single = await dispatch({
        type,
        workspaceId: 'project-1',
        ...fields,
      });
      expect(single.error).toEqual({
        code: 'invalid_target',
        message: "Project project-1 isn't a multi-repo project.",
      });
      expect(addRepoToWorkspace).not.toHaveBeenCalled();
      expect(removeRepoFromWorkspace).not.toHaveBeenCalled();
    },
  );

  it('refuses a repository path the project already has', async (): Promise<void> => {
    const response = await dispatch({
      type: 'workspace.add_repo',
      workspaceId: 'workspace-1',
      repoPath: '/repo-a',
    });
    expect(response.error).toEqual({
      code: 'invalid_target',
      message: 'Workspace One already has the repository at /repo-a.',
    });
    expect(addRepoToWorkspace).not.toHaveBeenCalled();
  });

  it('adds the unchanged local path through the settings path and returns the new repository', async (): Promise<void> => {
    const repoPath = '/Users/me/My Repos/repo c ';
    addRepoToWorkspace.mockImplementation((): Promise<void> => {
      replaceRepos([
        ...makeMultiRepoWorkspace().repos,
        { id: 'repo-c', name: 'repo c', repoPath, source: 'local' },
      ]);
      return Promise.resolve();
    });
    const response = await dispatch({
      type: 'workspace.add_repo',
      workspaceId: 'workspace-1',
      repoPath,
    });
    expect(addRepoToWorkspace).toHaveBeenCalledTimes(1);
    expect(addRepoToWorkspace).toHaveBeenCalledWith(
      'workspace-1',
      repoPath,
      false,
    );
    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      workspaceId: 'workspace-1',
      repo: { id: 'repo-c', name: 'repo c', repoPath, source: 'local' },
      message: 'Added repo c to Workspace One.',
    });
  });

  it('adds to an organization-owned project regardless of the selected context', async (): Promise<void> => {
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: { context: { kind: 'personal' }, revision: 1, organizations: [] },
    });
    useProjectsStore.setState({
      projects: [
        makeMultiRepoWorkspace({
          owner: {
            type: 'organization',
            organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            projectId: '33333333-3333-4333-8333-333333333331',
            instanceId: '44444444-4444-4444-8444-444444444441',
            bindingGeneration: 1,
          },
        }),
      ],
    });
    addRepoToWorkspace.mockResolvedValue(undefined);
    await dispatch({
      type: 'workspace.add_repo',
      workspaceId: 'workspace-1',
      repoPath: '/repo-c',
    });
    expect(addRepoToWorkspace).toHaveBeenCalledWith(
      'workspace-1',
      '/repo-c',
      false,
    );
  });

  it('keeps the existing refusal message when the add fails', async (): Promise<void> => {
    addRepoToWorkspace.mockRejectedValue(
      new Error(
        "Error invoking remote method 'workspace:add-repo': Error: That repository belongs to another organization.",
      ),
    );
    const response = await dispatch({
      type: 'workspace.add_repo',
      workspaceId: 'workspace-1',
      repoPath: '/repo-c',
    });
    expect(response.error).toEqual({
      code: 'execution_failed',
      message: 'That repository belongs to another organization.',
    });
    expect(addRepoToWorkspace).toHaveBeenCalledTimes(1);
  });

  it('preserves opaque project and repository IDs on direct dispatch', async (): Promise<void> => {
    const workspaceId = ' workspace-1 ';
    const repoId = ' repo-a ';
    useProjectsStore.setState({
      projects: [
        makeMultiRepoWorkspace({
          id: workspaceId,
          repos: [{ id: repoId, name: 'Repo A', repoPath: '/repo-a' }],
        }),
      ],
    });
    addRepoToWorkspace.mockResolvedValue(undefined);
    removeRepoFromWorkspace.mockResolvedValue(undefined);
    await dispatch({
      type: 'workspace.add_repo',
      workspaceId,
      repoPath: '/repo-c',
    });
    await dispatch({ type: 'workspace.remove_repo', workspaceId, repoId });
    expect(addRepoToWorkspace).toHaveBeenCalledWith(
      workspaceId,
      '/repo-c',
      false,
    );
    expect(removeRepoFromWorkspace).toHaveBeenCalledWith(workspaceId, repoId);
  });

  it('removes from an organization-owned target while a different organization is selected and the flag is off', async (): Promise<void> => {
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context: {
          kind: 'organization',
          organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
        revision: 1,
        organizations: [],
      },
    });
    useFeatureFlagsStore.getState().setSnapshot({
      ...getDefaultFeatureFlagSnapshot(),
      values: {
        ...getDefaultFeatureFlagSnapshot().values,
        'canopy-shared-org-projects-enabled': false,
      },
    });
    useProjectsStore.setState({
      projects: [
        makeMultiRepoWorkspace({
          owner: {
            type: 'organization',
            organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            projectId: '33333333-3333-4333-8333-333333333331',
            instanceId: '44444444-4444-4444-8444-444444444441',
            bindingGeneration: 1,
          },
        }),
      ],
    });
    removeRepoFromWorkspace.mockImplementation((): Promise<void> => {
      replaceRepos([]);
      return Promise.resolve();
    });
    const response = await dispatch({
      type: 'workspace.remove_repo',
      workspaceId: 'workspace-1',
      repoId: 'repo-a',
    });
    expect(response.ok).toBe(true);
    expect(removeRepoFromWorkspace).toHaveBeenCalledTimes(1);
    expect(removeRepoFromWorkspace).toHaveBeenCalledWith(
      'workspace-1',
      'repo-a',
    );
  });

  it('reports a successful add without a repository it cannot read back', async (): Promise<void> => {
    addRepoToWorkspace.mockResolvedValue(undefined);
    const response = await dispatch({
      type: 'workspace.add_repo',
      workspaceId: 'workspace-1',
      repoPath: '/repo-c',
    });
    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      workspaceId: 'workspace-1',
      message:
        'Added the repository to Workspace One. Use workspace.list to find its ID.',
    });
  });

  it.each([
    ['another project', 'repo-elsewhere', 'not_found'],
    ['the project root', WORKSPACE_ROOT_REPO_ID, 'invalid_target'],
  ])('refuses to remove %s', async (_label, repoId, code): Promise<void> => {
    const response = await dispatch({
      type: 'workspace.remove_repo',
      workspaceId: 'workspace-1',
      repoId,
    });
    expect(response).toMatchObject({ ok: false, error: { code } });
    expect(removeRepoFromWorkspace).not.toHaveBeenCalled();
  });

  it('removes by id and reports the refreshed repository count', async (): Promise<void> => {
    removeRepoFromWorkspace.mockImplementation((): Promise<void> => {
      replaceRepos([
        { id: 'repo-b', name: 'Repo B', repoPath: '/repo-b', source: 'local' },
        { id: WORKSPACE_ROOT_REPO_ID, name: 'Root', repoPath: '/root' },
      ]);
      return Promise.resolve();
    });
    const response = await dispatch({
      type: 'workspace.remove_repo',
      workspaceId: 'workspace-1',
      repoId: 'repo-a',
    });
    expect(removeRepoFromWorkspace).toHaveBeenCalledTimes(1);
    expect(removeRepoFromWorkspace).toHaveBeenCalledWith(
      'workspace-1',
      'repo-a',
    );
    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      workspaceId: 'workspace-1',
      removedRepoId: 'repo-a',
      removedRepoName: 'Repo A',
      remainingRepoCount: 1,
      message:
        'Removed Repo A from Workspace One. Its worktree checkouts stay on disk.',
    });
  });

  it('removes the last ordinary repository', async (): Promise<void> => {
    useProjectsStore.setState({
      projects: [
        makeMultiRepoWorkspace({
          repos: [
            {
              id: 'repo-a',
              name: 'Repo A',
              repoPath: '/repo-a',
              source: 'local',
            },
          ],
        }),
      ],
    });
    removeRepoFromWorkspace.mockImplementation((): Promise<void> => {
      replaceRepos([]);
      return Promise.resolve();
    });
    const response = await dispatch({
      type: 'workspace.remove_repo',
      workspaceId: 'workspace-1',
      repoId: 'repo-a',
    });
    expect(response.result).toMatchObject({ remainingRepoCount: 0 });
  });

  it('keeps the existing message when the removal fails', async (): Promise<void> => {
    removeRepoFromWorkspace.mockRejectedValue(
      new Error("Couldn't update the project in Acme. Nothing was changed."),
    );
    const response = await dispatch({
      type: 'workspace.remove_repo',
      workspaceId: 'workspace-1',
      repoId: 'repo-a',
    });
    expect(response.error).toEqual({
      code: 'execution_failed',
      message: "Couldn't update the project in Acme. Nothing was changed.",
    });
  });

  it('reports a successful removal without a count it cannot refresh', async (): Promise<void> => {
    removeRepoFromWorkspace.mockImplementation((): Promise<void> => {
      useProjectsStore.setState({ projects: [] });
      return Promise.resolve();
    });
    const response = await dispatch({
      type: 'workspace.remove_repo',
      workspaceId: 'workspace-1',
      repoId: 'repo-a',
    });
    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      workspaceId: 'workspace-1',
      removedRepoId: 'repo-a',
      removedRepoName: 'Repo A',
      message:
        'Removed Repo A from Workspace One. Its worktree checkouts stay on disk. Use workspace.list to see its remaining repositories.',
    });
  });
});
