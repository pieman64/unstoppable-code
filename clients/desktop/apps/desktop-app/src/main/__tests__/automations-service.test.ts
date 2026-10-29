import { getSharedPipeline } from '../pipelines/canopy-server-client';
jest.mock('../canopy-cloud/shared-item-subscriptions', () => ({
  recordSharedItemInstall: jest.fn(),
  recordSharedItemUninstall: jest.fn(),
}));
import {
  recordSharedItemInstall,
  recordSharedItemUninstall,
} from '../canopy-cloud/shared-item-subscriptions';
jest.mock('../pipelines/canopy-server-client', () => {
  const sharedPipeline = jest.fn();
  return {
    getSharedPipeline: sharedPipeline,
    getSharedPipelineForExecutionContext: sharedPipeline,
  };
});
import {
  backgroundExecutionDeniedMessage,
  backgroundExecutionRetryMessage,
  backgroundExecutionUnavailableMessage,
} from '@canopy/desktop-shared/node/background-execution-context';
import { resolveChildPipeline } from '@canopy/desktop-shared/node/pipelines/executor/child-pipeline-resolver';
import type { ExecutionOptions } from '@canopy/desktop-shared/node/pipelines/executor';
import type * as ResumeServiceModule from '../pipelines/pipeline-resume-service';
import * as executionRegistry from '../pipelines/pipeline-execution-registry';
jest.mock('../pipelines/execution-runtime', () => ({
  createElectronExecutionRuntime: (): { executionsDir: string } => ({
    executionsDir: join(dataDirPath, 'pipeline-executions'),
  }),
}));
import {
  createInitialState,
  normalizePipeline,
  saveExecutionState,
} from '@canopy/desktop-shared/node/pipelines/executor';
import type * as WorkspacePersistenceModule from '../lib/workspace-persistence';
import type * as WorkspaceTargetModule from '../services/workspace-target';
import type * as BackgroundExecutionRebindingModule from '../services/background-execution-rebinding';
import type { BackgroundExecutionContextRebinder } from '../services/background-execution-rebinding';
import type * as PluginServiceModule from '../plugins/plugin-service';
import type * as EffectivePluginSelectionsModule from '@canopy/desktop-shared/lib/effective-plugin-selections';
import type * as CloudClientModule from '../canopy-cloud/client';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import type { readWorkspaceConfigDetailed } from '../lib/workspace-persistence';
import { decideResourceContext } from '@canopy/desktop-shared/lib/resource-context-policy';
import type {
  InstallReceipt,
  ResourceContextDecision,
  ResourceContextInput,
} from '@canopy/desktop-shared/lib/resource-context-policy';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ResourceOwner } from '@canopy/protocol/resource-owner';
import type {
  MarketplaceInfo,
  PluginInfo,
} from '@canopy/desktop-shared/types/plugins';
import type {
  AutomationAction,
  AutomationCreateRequest,
  AppAdvisorWindowOpenRequest,
  ChatTabsFile,
  PersistedChatTab,
  ScheduledActivity,
  ScheduledActivityRun,
  SidebarItemsFile,
  WorkspaceContext,
} from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  COWORK_HOME_WORKTREE_ID,
  initClaudeModels,
  initCodexModels,
  initAgentModels,
  initModelAliases,
  initOllamaModels,
} from '@canopy/desktop-shared/types';
import { AutomationsService } from '../automations/service';
import { resolveConfiguredPrompt } from '../lib/configured-prompt-resolution';
import { sendStandaloneChatMessage } from '../services/standalone-chat-service';
import { sidebarItemGroupsService } from '../services/sidebar-item-groups-service';
import { sendWorktreeChatMessage } from '../services/chat-service';
import type * as ChatServiceModule from '../services/chat-service';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import {
  archiveMultiRepoWorktree,
  archiveSingleRepoWorktree,
  createMultiRepoWorktree,
  createSingleRepoWorktree,
} from '../lib/worktree-service';
import { readAllSidebarItems } from '../lib/sidebar-items';
import {
  discoverProjectPipelines,
  loadProjectPipelineFromDisk,
} from '../pipelines/project-pipeline-discovery';
import { startPipelineExecutionFromMain } from '../pipelines/pipeline-handlers';
import { resumePipelineExecutionFromMain } from '../pipelines/pipeline-resume-service';
import { getStoredPipelineBySource } from '../pipelines/pipeline-service';
import {
  removeAutomationCapabilityPackageInstall,
  resolveInstalledAutomationPackageOverlay,
  resolveInstalledAutomationPipelinePackage,
  SharedPipelinePinMismatchError,
  verifySharedPipelineAutomationInstallPin,
} from '../pipelines/pipeline-package-service';
import {
  getActiveSessionInfos,
  subscribeChatSessionActivity,
} from '../agents/session-manager';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import * as e2eGate from '../lib/e2e-gate';
import { runAutomationIfCommand } from '../automations/if-command-runner';
import { readPreferencesFile } from '../lib/preferences-store';
import { loadStandaloneProject } from '../lib/standalone-project-state';
import { resolveShareablePluginRefs } from '../plugins/shareable-plugin-resolution';
import { logMainProcessError } from '../lib/main-process-logging';
import {
  resetWorkspaceTargetExclusionsForTests,
  withWorkspaceTargetAutoArchiveLease,
} from '../lib/workspace-target-exclusion';

const mockResourceDecide = jest.fn<
  Promise<ResourceContextDecision>,
  [ResourceContextInput]
>();
const mockFindResourceOrigin = jest.fn();
const mockBackgroundDecide = jest.fn<
  Promise<ResourceContextDecision>,
  [ResourceContextInput]
>(() => Promise.resolve({ allow: true }));
jest.mock('../services/resource-context-policy-service', () => ({
  getResourceContextPolicyService: (): {
    decide: (input: ResourceContextInput) => Promise<ResourceContextDecision>;
  } => ({
    decide: (input): Promise<ResourceContextDecision> =>
      input.invocation.mode === 'background'
        ? mockBackgroundDecide(input)
        : mockResourceDecide(input),
  }),
}));
const mockReadBackgroundWorkspace = jest.fn<
  ReturnType<typeof readWorkspaceConfigDetailed>,
  Parameters<typeof readWorkspaceConfigDetailed>
>();
const mockRebindMovedWorkspace = jest.fn<
  ReturnType<BackgroundExecutionContextRebinder['rebindWorkspace']>,
  Parameters<BackgroundExecutionContextRebinder['rebindWorkspace']>
>();
jest.mock('../services/background-execution-rebinding', () => ({
  ...jest.requireActual<typeof BackgroundExecutionRebindingModule>(
    '../services/background-execution-rebinding',
  ),
  getBackgroundExecutionContextRebinder: (): Pick<
    BackgroundExecutionContextRebinder,
    'rebindWorkspace'
  > => ({
    rebindWorkspace: (...args) => mockRebindMovedWorkspace(...args),
  }),
}));
const mockReadProjectPluginDefaults = jest.fn<
  ReturnType<typeof WorkspacePersistenceModule.readProjectPluginDefaults>,
  Parameters<typeof WorkspacePersistenceModule.readProjectPluginDefaults>
>();
jest.mock('../lib/workspace-persistence', () => {
  const actual = jest.requireActual<typeof WorkspacePersistenceModule>(
    '../lib/workspace-persistence',
  );
  return {
    ...actual,
    readWorkspaceConfigDetailed: (
      ...args: Parameters<typeof mockReadBackgroundWorkspace>
    ): ReturnType<typeof readWorkspaceConfigDetailed> =>
      mockReadBackgroundWorkspace(...args),
    readProjectPluginDefaults: (
      ...args: Parameters<typeof mockReadProjectPluginDefaults>
    ): ReturnType<typeof mockReadProjectPluginDefaults> =>
      mockReadProjectPluginDefaults(...args),
  };
});
function backgroundWorkspace(
  organizationId?: string,
  ownershipTransferred = false,
): Awaited<ReturnType<typeof readWorkspaceConfigDetailed>> {
  return {
    authority: 'ok',
    ownerMalformed: false,
    config: {
      repos: [],
      ...(organizationId
        ? {
            owner: {
              type: 'organization',
              organizationId,
              projectId: organizationId,
              instanceId: organizationId,
              bindingGeneration: 1,
            },
          }
        : {}),
      ...(ownershipTransferred && organizationId
        ? {
            ownershipTransfer: {
              version: 1,
              previousOwner: { type: 'personal' },
              organizationId,
              projectId: organizationId,
              convertedAt: '2026-05-28T11:30:00.000Z',
            },
          }
        : {}),
    },
  };
}
let mockBackgroundContext = 'personal';
let mockOrganizations: { id: string; name: string; role: 'MEMBER' }[] = [];
let mockAccountEpoch = 1;
const mockWorkspaceContextService = {
  initialize: async (): Promise<void> => {},
  whenIdle: async (): Promise<void> => {},
  accountEpoch: (): number => mockAccountEpoch,
  getState: (): {
    context: WorkspaceContext;
    revision: number;
    organizations: { id: string; name: string; role: 'MEMBER' }[];
  } => ({
    revision: 1,
    organizations: mockOrganizations,
    context:
      mockBackgroundContext === 'personal'
        ? { kind: 'personal' }
        : {
            kind: 'organization',
            organizationId: mockBackgroundContext.slice(4),
          },
  }),
};
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): typeof mockWorkspaceContextService =>
    mockWorkspaceContextService,
}));

const mockResolveWorkspaceTarget = jest.fn<
  ReturnType<typeof WorkspaceTargetModule.resolveWorkspaceTarget>,
  Parameters<typeof WorkspaceTargetModule.resolveWorkspaceTarget>
>();
jest.mock('../services/workspace-target', () => ({
  ...jest.requireActual<typeof WorkspaceTargetModule>(
    '../services/workspace-target',
  ),
  resolveWorkspaceTarget: (
    ...args: Parameters<typeof mockResolveWorkspaceTarget>
  ): ReturnType<typeof mockResolveWorkspaceTarget> =>
    mockResolveWorkspaceTarget(...args),
}));
const mockFindInstallReceipt = jest.fn<
  Promise<InstallReceipt | undefined>,
  [string, string]
>();
const mockRecordInstallReceipt = jest.fn(() => Promise.resolve());
jest.mock('../lib/resource-install-receipts', () => ({
  createResourceInstallReceiptsStore: jest.fn(() => ({
    findLocal: mockFindResourceOrigin,
    find: (
      ...args: Parameters<typeof mockFindInstallReceipt>
    ): ReturnType<typeof mockFindInstallReceipt> =>
      mockFindInstallReceipt(...args),
    record: mockRecordInstallReceipt,
  })),
}));
const mockCloudJson = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../canopy-cloud/client', () => ({
  ...jest.requireActual<typeof CloudClientModule>('../canopy-cloud/client'),
  requestCanopyCloudJson: (...args: unknown[]): Promise<unknown> =>
    mockCloudJson(...args),
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  subscribeCanopyCloudAccountChanges: (): (() => void) => (): void => undefined,
  readCanopyCloudAccountWithStatus: jest.fn(() =>
    Promise.resolve({ status: 'ok', entry: { account: { id: 'user' } } }),
  ),
}));
const mockGetSharedAutomation = jest.fn(() =>
  Promise.resolve({
    id: 'remote-a',
    contentHash: 'hash',
    owner: { type: 'organization', id: 'org-a', name: 'A' },
  }),
);
jest.mock('../automations/canopy-server-client', () => ({
  getSharedAutomation: (
    ...args: unknown[]
  ): ReturnType<typeof mockGetSharedAutomation> =>
    mockGetSharedAutomation(...args),
}));

let automationsFilePath = '';
let chatProjectsFilePath = '';
let dataDirPath = '';
const mockFeatureFlagValues = new Map<string, boolean>();
const mockReadWorkspaceApprovals = jest.fn(() =>
  Promise.resolve({ version: 1 as const, rules: [] }),
);
const mockReadWorkspaceApprovalsManifest = jest.fn(() =>
  Promise.resolve({ rules: [] }),
);
const mockResolveCoworkWorkspaceId = jest.fn((projectId: string) => projectId);

jest.mock('../lib/configured-prompt-resolution', () => ({
  resolveConfiguredPrompt: jest.fn(),
}));
const mockedResolveConfiguredPrompt = jest.mocked(resolveConfiguredPrompt);

jest.mock('../lib/paths', () => ({
  getAutomationsFilePath: (): string => automationsFilePath,
  getDataDir: (): string => dataDirPath,
  getAgentModelsFilePath: (): string => join(dataDirPath, 'agent-models.json'),
  getAutomationRunArchiveFilePath: (activityId: string): string =>
    join(dataDirPath, 'automation-runs', `${activityId}.jsonl`),
  getChatProjectsFilePath: (): string => chatProjectsFilePath,
  getCoworkWorkspaceRootDir: (workspaceId: string): string =>
    join(dataDirPath, 'workspaces', workspaceId, 'home'),
  getWorkspaceWorktreeRootRepoDir: (
    workspaceId: string,
    worktreeId: string,
  ): string =>
    join(dataDirPath, 'workspaces', workspaceId, 'worktrees', worktreeId),
  getWorkspaceWorktreeRepoDir: (
    workspaceId: string,
    worktreeId: string,
    repoId: string,
  ): string =>
    join(
      dataDirPath,
      'workspaces',
      workspaceId,
      'worktrees',
      worktreeId,
      'repos',
      repoId,
    ),
}));

jest.mock('../feature-flags', () => ({
  getFeatureFlagService: jest.fn(() => ({
    isEnabled: jest.fn((key: string) => mockFeatureFlagValues.get(key) ?? true),
  })),
}));

jest.mock('../services/standalone-chat-service', () => ({
  sendStandaloneChatMessage: jest.fn(),
}));

jest.mock('../services/sidebar-item-groups-service', () => ({
  sidebarItemGroupsService: {
    assignItemToNamedGroup: jest.fn(),
  },
}));

let mockMintedChatCount = 0;
jest.mock('../services/chat-service', () => {
  const actual = jest.requireActual<typeof ChatServiceModule>(
    '../services/chat-service',
  );
  return {
    ...actual,
    // `buildExistingTabDispatchOptions` is intentionally left as the real
    // implementation so its behavior (throws on missing/readOnly tab,
    // reads the mocked `readChatTabsFile`) is exercised by these tests.
    // Echo the requested chat, or mint one the way the real service does when
    // a send leaves the chat choice to it.
    sendWorktreeChatMessage: jest.fn((request: { chatId?: string }) =>
      Promise.resolve({
        ok: true,
        chatId: request.chatId ?? `worktree-chat-${++mockMintedChatCount}`,
      }),
    ),
  };
});

jest.mock('../lib/chat-tabs-reader', () => {
  const readChatTabsFile = jest.fn(() =>
    Promise.resolve<ChatTabsFile>({ version: 1, tabs: [], activeTabId: '' }),
  );
  const { chatInheritsProjectDefaults } = jest.requireActual<
    typeof EffectivePluginSelectionsModule
  >('@canopy/desktop-shared/lib/effective-plugin-selections');
  return {
    readChatTabsFile,
    readPersistedChatPluginInheritance: async (
      projectId: string,
      worktreeId: string,
      chatId: string,
    ): Promise<unknown> => {
      const tab = (await readChatTabsFile(projectId, worktreeId)).tabs.find(
        (candidate) => candidate.id === chatId,
      );
      return {
        ...(tab?.disabledGlobalPluginSelections
          ? { tombstones: tab.disabledGlobalPluginSelections }
          : {}),
        inheritsProjectDefaults: chatInheritsProjectDefaults(tab),
      };
    },
  };
});

// Background authorization resolves plugins from this inventory. It stays
// unavailable, as in the unconfigured test app, unless a test supplies one.
const mockLoadMarketplaces = jest.fn<
  ReturnType<typeof PluginServiceModule.loadMarketplaces>,
  Parameters<typeof PluginServiceModule.loadMarketplaces>
>();
jest.mock('../plugins/plugin-service', () => ({
  ...jest.requireActual<typeof PluginServiceModule>(
    '../plugins/plugin-service',
  ),
  loadMarketplaces: (
    ...args: Parameters<typeof PluginServiceModule.loadMarketplaces>
  ): ReturnType<typeof PluginServiceModule.loadMarketplaces> =>
    mockLoadMarketplaces(...args),
}));

const mockHandleAutomationRunEvent = jest.fn(() => Promise.resolve());
jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: (): {
    handleAutomationRunEvent: jest.Mock;
  } => ({
    handleAutomationRunEvent: mockHandleAutomationRunEvent,
  }),
}));

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
  logMainProcessWarn: jest.fn(),
}));

jest.mock('../lib/preferences-store', () => ({
  // Not degraded: approval resolution fails closed when this is non-null.
  peekPreferencesLoadError: (): null => null,
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({
      defaultWorktreeModelByProvider: {
        claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
        codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
      },
      defaultWorktreeProvider: 'claude',
      defaultChatModelByProvider: {
        claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
        codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
      },
      defaultChatProvider: 'codex',
      approvalDefaults: {
        worktree: 'ask',
        cowork: 'ask',
        appAdvisor: 'ask',
      },
      globalApprovalRules: [],
      approvalsUpgradeNoticeDismissed: false,
      appAdvisorModel: 'gpt-5.5',
      appAdvisorThinkingLevel: 'high',
      appAdvisorPluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      providerModelConfigDefaults: { codex: { fastMode: false } },
    }),
  ),
}));
function mockLaneSelection(
  preferences: Record<string, unknown>,
  scope: 'chat' | 'worktree',
): { model: string; thinkingLevel: string } | undefined {
  const defaults = preferences[
    scope === 'chat'
      ? 'defaultChatModelByProvider'
      : 'defaultWorktreeModelByProvider'
  ] as Record<string, { model: string; thinkingLevel: string }>;
  const provider = preferences[
    scope === 'chat' ? 'defaultChatProvider' : 'defaultWorktreeProvider'
  ] as string;
  return defaults[provider] ?? defaults.claude;
}
const mockAppAdvisorDefault = jest.fn(
  (preferences: Record<string, unknown>): Promise<unknown> =>
    Promise.resolve(preferences.appAdvisorModel),
);
jest.mock('../lib/default-model-lane-resolver', () => ({
  getLastProjectedDefaultModel: (): undefined => undefined,
  resolveAppAdvisorDefaultModel: (
    preferences: Record<string, unknown>,
  ): Promise<unknown> => mockAppAdvisorDefault(preferences),
  resolveOptionalLaneAwareDefaultSelection: (
    preferences: Record<string, unknown>,
    scope: 'chat' | 'worktree',
  ): Promise<unknown> => {
    const selection = mockLaneSelection(preferences, scope);
    return Promise.resolve({ selection, requireModel: () => selection });
  },
  requireLaneAwareDefaultSelection: (
    preferences: Record<string, unknown>,
    scope: 'chat' | 'worktree',
  ): Promise<unknown> => Promise.resolve(mockLaneSelection(preferences, scope)),
}));

jest.mock('../lib/approvals-persistence', () => ({
  readWorkspaceApprovals: (...args: unknown[]): unknown =>
    mockReadWorkspaceApprovals(...args),
}));

jest.mock('../lib/workspace-approvals-manifest', () => ({
  readWorkspaceApprovalsManifest: (...args: unknown[]): unknown =>
    mockReadWorkspaceApprovalsManifest(...args),
}));

jest.mock('../lib/cowork-migration-map', () => ({
  resolveCoworkWorkspaceId: (projectId: string): string =>
    mockResolveCoworkWorkspaceId(projectId),
}));

jest.mock('../plugins/shareable-plugin-resolution', () => ({
  loadShareablePluginCatalog: jest.fn(() =>
    Promise.resolve({ skills: [], marketplaces: [] }),
  ),
  resolveShareablePluginRefs: jest.fn(() => []),
}));

jest.mock('../lib/standalone-project-state', () => ({
  loadStandaloneProject: jest.fn(),
}));

jest.mock('../lib/worktree-service', () => ({
  archiveMultiRepoWorktree: jest.fn(() =>
    Promise.resolve({ success: true, warnings: [] }),
  ),
  archiveSingleRepoWorktree: jest.fn(() =>
    Promise.resolve({ success: true, warnings: [] }),
  ),
  createSingleRepoWorktree: jest.fn(),
  createMultiRepoWorktree: jest.fn(),
}));

const mockReadWorkspaceIndexEntry = jest.fn<
  Promise<{ id: string; name: string } | null>,
  [string]
>();
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(),
  readWorkspaceIndexEntry: (
    id: string,
  ): Promise<{ id: string; name: string } | null> =>
    mockReadWorkspaceIndexEntry(id),
}));

jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));

jest.mock('../pipelines/project-pipeline-discovery', () => ({
  discoverProjectPipelines: jest.fn(),
  loadProjectPipelineFromDisk: jest.fn(() =>
    Promise.resolve({ name: 'Dispatch pipeline', on: 'dispatch', jobs: {} }),
  ),
}));

jest.mock('../pipelines/pipeline-handlers', () => ({
  startPipelineExecutionFromMain: jest.fn(() =>
    Promise.resolve({
      success: true,
      data: { id: 'execution-1' },
    }),
  ),
}));

jest.mock('../pipelines/pipeline-resume-service', () => ({
  resumePipelineExecutionFromMain: jest.fn(() =>
    Promise.resolve({
      status: 'stale-noop',
      state: { id: 'execution-resume' },
    }),
  ),
}));

const mockGetManagedCuratedPipeline = jest.fn();
jest.mock('../pipelines/curated-pipeline-catalog', () => ({
  // Lazy so the hoisted factory never reads the mock before its declaration runs.
  getManagedCuratedPipeline: (...args: unknown[]): unknown =>
    mockGetManagedCuratedPipeline(...args),
}));

jest.mock('../pipelines/pipeline-service', () => ({
  getPipeline: jest.fn(),
  getStoredPipelineBySource: jest.fn(),
}));

jest.mock('../pipelines/pipeline-package-service', () => ({
  assertSharedPipelineMatchesAutomationInstallPin: jest.fn(),
  removeAutomationCapabilityPackageInstall: jest.fn(() => Promise.resolve()),
  resolveInstalledAutomationPackageOverlay: jest.fn(() =>
    Promise.resolve(undefined),
  ),
  resolveInstalledAutomationPipelinePackage: jest.fn(() =>
    Promise.resolve(undefined),
  ),
  verifySharedPipelineAutomationInstallPin: jest.fn((_, installPin) =>
    Promise.resolve(installPin),
  ),
  SharedPipelinePinMismatchError: class SharedPipelinePinMismatchError extends Error {
    readonly remoteId: string;
    readonly pipelineName: string;

    constructor(remoteId: string, pipelineName: string) {
      super('pin mismatch');
      this.name = 'SharedPipelinePinMismatchError';
      this.remoteId = remoteId;
      this.pipelineName = pipelineName;
    }
  },
}));

jest.mock('../agents/session-manager', () => ({
  getActiveSessionInfos: jest.fn(() => []),
  subscribeChatSessionActivity: jest.fn(() => jest.fn()),
}));

jest.mock('../automations/if-command-runner', () => ({
  runAutomationIfCommand: jest.fn(() =>
    Promise.resolve({ outcome: 'run', stdout: '' }),
  ),
}));

const mockAssertOpenCodeModelAvailable = jest.fn<
  Promise<void>,
  [string | undefined]
>(() => Promise.resolve());
let mockOpenCodeGeneration = 0;
jest.mock('../opencode/connection', () => ({
  getOpenCodeConnectionGeneration: (): number => mockOpenCodeGeneration,
  assertOpenCodeConnectionGeneration: (expected: number): void => {
    if (expected !== mockOpenCodeGeneration)
      throw new Error('OpenCode connection changed. Try again.');
  },
  assertOpenCodeModelAvailable: (model: string | undefined): Promise<void> =>
    mockAssertOpenCodeModelAvailable(model),
}));

const mockReadCursorAccount = jest.fn(
  (): Promise<{ email: string } | null> => Promise.resolve({ email: '' }),
);
jest.mock('../cursor/connection', () => ({
  readCursorAccount: (): Promise<{ email: string } | null> =>
    mockReadCursorAccount(),
}));

const mockIsCursorRuntimeAvailable = jest.fn<Promise<boolean>, []>(() =>
  Promise.resolve(false),
);
// The canonical, cache-refreshing definition lives in `runtime-availability`.
// A duplicate in `runtime-status` (kept by a merge that took both branches'
// extraction of the same helper) let automations bypass that cache; the
// duplicate is gone and this mock follows the real import.
jest.mock('../cursor/runtime-availability', () => ({
  isCursorRuntimeAvailable: (): Promise<boolean> =>
    mockIsCursorRuntimeAvailable(),
}));

const mockedSendStandaloneChatMessage = jest.mocked(sendStandaloneChatMessage);
const mockAssignItemToNamedGroup = jest.mocked(
  sidebarItemGroupsService.assignItemToNamedGroup,
);
const mockedSendWorktreeChatMessage = jest.mocked(sendWorktreeChatMessage);
const mockedReadChatTabsFile = jest.mocked(readChatTabsFile);
const mockedArchiveSingleRepoWorktree = jest.mocked(archiveSingleRepoWorktree);
const mockedArchiveMultiRepoWorktree = jest.mocked(archiveMultiRepoWorktree);
const mockedCreateSingleRepoWorktree = jest.mocked(createSingleRepoWorktree);
const mockedCreateMultiRepoWorktree = jest.mocked(createMultiRepoWorktree);
const mockedReadAllSidebarItems = jest.mocked(readAllSidebarItems);
const mockedDiscoverProjectPipelines = jest.mocked(discoverProjectPipelines);
const mockedStartPipelineExecutionFromMain = jest.mocked(
  startPipelineExecutionFromMain,
);
const mockedResumePipelineExecutionFromMain = jest.mocked(
  resumePipelineExecutionFromMain,
);
const mockedGetStoredPipelineBySource = jest.mocked(getStoredPipelineBySource);
const mockedResolveInstalledAutomationPackageOverlay = jest.mocked(
  resolveInstalledAutomationPackageOverlay,
);
const mockedResolveInstalledAutomationPipelinePackage = jest.mocked(
  resolveInstalledAutomationPipelinePackage,
);
const mockedVerifySharedPipelineAutomationInstallPin = jest.mocked(
  verifySharedPipelineAutomationInstallPin,
);
const mockedRemoveAutomationCapabilityPackageInstall = jest.mocked(
  removeAutomationCapabilityPackageInstall,
);
const mockedGetActiveSessionInfos = jest.mocked(getActiveSessionInfos);
const mockedSubscribeChatSessionActivity = jest.mocked(
  subscribeChatSessionActivity,
);
const mockedRunAutomationIfCommand = jest.mocked(runAutomationIfCommand);
const mockedReadPreferencesFile = jest.mocked(readPreferencesFile);
const mockedLoadStandaloneProject = jest.mocked(loadStandaloneProject);
const mockedResolveShareablePluginRefs = jest.mocked(
  resolveShareablePluginRefs,
);
const mockedLogMainProcessError = jest.mocked(logMainProcessError);

function defaultPreferences(): Awaited<ReturnType<typeof readPreferencesFile>> {
  return {
    defaultWorktreeModelByProvider: {
      claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
      codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
    },
    defaultWorktreeProvider: 'claude',
    defaultChatModelByProvider: {
      claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
      codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
    },
    defaultChatProvider: 'codex',
    approvalDefaults: {
      worktree: 'ask',
      cowork: 'ask',
      appAdvisor: 'ask',
    },
    globalApprovalRules: [],
    approvalsUpgradeNoticeDismissed: false,
    appAdvisorModel: 'gpt-5.5',
    appAdvisorThinkingLevel: 'high',
    appAdvisorPluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
    providerModelConfigDefaults: { codex: { fastMode: false } },
  };
}

function appAdvisorAction(prompt = 'Summarize today'): AutomationAction {
  return { type: 'app_advisor_prompt', prompt };
}

function activity(
  overrides: Partial<ScheduledActivity> = {},
): ScheduledActivity {
  const now = '2026-05-28T12:00:00.000Z';
  return {
    version: 1,
    id: 'activity-1',
    name: 'Morning check',
    enabled: true,
    schedule: {
      kind: 'one_time',
      runAt: '2026-05-28T12:01:00.000Z',
      timezone: 'local',
    },
    action: appAdvisorAction(),
    createdAt: now,
    updatedAt: now,
    failureCount: 0,
    ...overrides,
  };
}

function run(
  overrides: Partial<ScheduledActivityRun> = {},
): ScheduledActivityRun {
  return {
    id: 'run-1',
    activityId: 'activity-1',
    activityName: 'Morning check',
    scheduledFor: '2026-05-28T12:00:00.000Z',
    manual: false,
    status: 'success',
    startedAt: '2026-05-28T12:00:00.000Z',
    completedAt: '2026-05-28T12:00:01.000Z',
    ...overrides,
  };
}

function chatTabsFile(tabs: PersistedChatTab[]): ChatTabsFile {
  return {
    version: 1,
    tabs,
    activeTabId: tabs[0]?.id ?? '',
  };
}

function targetChatTab(
  overrides: Partial<PersistedChatTab> = {},
): PersistedChatTab {
  return {
    id: 'chat-1',
    title: 'Release planning',
    createdAt: '2026-05-28T11:00:00.000Z',
    kind: 'chat',
    messages: [],
    ...overrides,
  };
}

function sidebarWithExistingWorktree(): SidebarItemsFile {
  return {
    version: 1,
    items: [
      {
        type: 'single-repo',
        id: 'workspace-1',
        name: 'Workspace',
        repoPath: '/repo',
        color: 'blue',
        collapsed: false,
        order: 0,
        worktrees: [
          {
            id: 'worktree-existing',
            branchName: 'feature/leg-1',
            createdAt: '2026-05-27T12:00:00.000Z',
          },
        ],
      },
    ],
    warnings: [],
  };
}

async function writeAutomationFile(value: unknown): Promise<void> {
  await mkdir(dirname(automationsFilePath), { recursive: true });
  await writeFile(automationsFilePath, JSON.stringify(value, null, 2), 'utf8');
}

async function flushAsyncWork(turns = 10): Promise<void> {
  for (let index = 0; index < turns; index++) {
    await Promise.resolve();
  }
}

async function flushAutomationWrites(
  service: AutomationsService,
): Promise<void> {
  for (let index = 0; index < 5; index++) {
    await flushAsyncWork();
    await (service as unknown as { writeQueue: Promise<unknown> }).writeQueue;
  }
  await (service as unknown as { archiveMaintenance: Promise<void> })
    .archiveMaintenance;
}

function makeService(): {
  service: AutomationsService;
  ensureAppAdvisorWindow: jest.Mock<
    Promise<{ open: boolean; focused: boolean }>,
    [AppAdvisorWindowOpenRequest]
  >;
  onChange: jest.Mock;
} {
  const service = new AutomationsService();
  const ensureAppAdvisorWindow = jest.fn<
    Promise<{ open: boolean; focused: boolean }>,
    [AppAdvisorWindowOpenRequest]
  >(() => Promise.resolve({ open: true, focused: false }));
  const onChange = jest.fn();
  service.configure({
    getMainWindow: () => null,
    getAppAdvisorWindow: () => null,
    openAppAdvisorWindow: ensureAppAdvisorWindow,
    ensureAppAdvisorWindow,
    sendAppAdvisorWindowCommand: jest.fn(),
    onChange,
  });
  return { service, ensureAppAdvisorWindow, onChange };
}

function messageContaining(message: string): unknown {
  return expect.stringContaining(message);
}

describe('AutomationsService', () => {
  beforeAll(() => {
    // Register the supported models so `resolveKnownModel` upgrades stored
    // deprecated ids (gpt-6-sol → gpt-5.5, claude-sonnet-4-6 → sonnet) exactly
    // like the app runtime, where package.json seeds these registries.
    initClaudeModels([{ id: 'sonnet', label: 'Claude Sonnet' }]);
    initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
    initOllamaModels([
      {
        id: 'ollama-qwen3-coder',
        rawModelId: 'qwen3-coder',
        label: 'qwen3-coder',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
    initModelAliases({
      'claude-sonnet-4-6': 'sonnet',
      'gpt-6-sol': 'gpt-5.5',
    });
  });

  beforeEach(async () => {
    initAgentModels([]);
    mockReadBackgroundWorkspace
      .mockReset()
      .mockResolvedValue(backgroundWorkspace());
    mockRebindMovedWorkspace.mockReset().mockResolvedValue([]);
    mockBackgroundDecide.mockReset().mockResolvedValue({ allow: true });
    mockLoadMarketplaces
      .mockReset()
      .mockResolvedValue({ success: false, error: 'Plugins unavailable' });
    mockReadProjectPluginDefaults.mockReset().mockResolvedValue({});
    mockOrganizations = [];
    mockAccountEpoch = 1;
    mockReadWorkspaceIndexEntry.mockReset().mockResolvedValue(null);
    mockResourceDecide.mockReset().mockResolvedValue({ allow: true });
    mockFindResourceOrigin.mockReset().mockResolvedValue(undefined);
    mockFindInstallReceipt.mockReset().mockResolvedValue(undefined);
    mockResolveWorkspaceTarget
      .mockReset()
      .mockImplementation(
        jest.requireActual<typeof WorkspaceTargetModule>(
          '../services/workspace-target',
        ).resolveWorkspaceTarget,
      );
    mockCloudJson
      .mockReset()
      .mockRejectedValue(new Error('Unexpected cloud request'));
    mockGetSharedAutomation.mockReset().mockResolvedValue({
      id: 'remote-a',
      contentHash: 'hash',
      owner: { type: 'organization', id: 'org-a', name: 'A' },
    });
    jest.useFakeTimers({
      now: new Date('2026-05-28T12:00:00.000Z'),
    });
    jest.clearAllMocks();
    mockAssertOpenCodeModelAvailable.mockReset().mockResolvedValue(undefined);
    mockOpenCodeGeneration = 0;
    mockFeatureFlagValues.clear();
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      false,
    );
    const dir = await mkdtemp(join(tmpdir(), 'canopy-automations-test-'));
    dataDirPath = dir;
    automationsFilePath = join(dir, 'automations.json');
    chatProjectsFilePath = join(dir, 'chat-projects.json');
    mockedReadPreferencesFile.mockResolvedValue(defaultPreferences());
    const standaloneProject: Awaited<ReturnType<typeof loadStandaloneProject>> =
      {
        projectFile: {
          version: 1,
          id: 'project-chat',
          name: 'Cowork',
          createdAt: '2026-05-28T12:00:00.000Z',
        },
        mergedProject: {
          id: 'project-chat',
          name: 'Cowork',
          createdAt: '2026-05-28T12:00:00.000Z',
        },
      };
    mockedLoadStandaloneProject.mockResolvedValue(standaloneProject);
    await writeFile(
      chatProjectsFilePath,
      JSON.stringify({
        version: 1,
        projects: [standaloneProject.mergedProject],
      }),
      'utf8',
    );
    mockedResolveShareablePluginRefs.mockReturnValue([]);
    mockedResolveConfiguredPrompt.mockImplementation(
      (args): ReturnType<typeof resolveConfiguredPrompt> =>
        Promise.resolve({ prompt: args.prompt }),
    );
    mockedResolveInstalledAutomationPackageOverlay.mockResolvedValue(undefined);
    mockedResolveInstalledAutomationPipelinePackage.mockResolvedValue(
      undefined,
    );
    mockedVerifySharedPipelineAutomationInstallPin.mockImplementation(
      (_remoteId, installPin) => Promise.resolve(installPin),
    );
    mockedRemoveAutomationCapabilityPackageInstall.mockResolvedValue();
    mockedSendStandaloneChatMessage.mockResolvedValue({
      ok: true,
      chatId: 'standalone-chat-1',
      userMessageId: 'standalone-user-message-1',
    });
    mockAssignItemToNamedGroup.mockResolvedValue({
      id: 'group-1',
      name: 'Documents',
      color: 'neutral',
      collapsed: false,
      memberIds: [],
    });
    mockReadWorkspaceApprovals.mockResolvedValue({ version: 1, rules: [] });
    mockReadWorkspaceApprovalsManifest.mockResolvedValue({ rules: [] });
    mockResolveCoworkWorkspaceId.mockImplementation(
      (projectId: string) => projectId,
    );
    mockedReadChatTabsFile.mockResolvedValue(chatTabsFile([targetChatTab()]));
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        ...['workspace-1', 'workspace-2', 'project-1'].map((id) => ({
          type: 'single-repo' as const,
          id,
          name: id,
          repoPath: '/repo',
          color: 'blue',
          collapsed: false,
          order: 0,
          worktrees: [
            {
              id: 'worktree-1',
              branchName: 'main',
              createdAt: '2026-05-28T12:00:00.000Z',
            },
          ],
        })),
        {
          type: 'cowork',
          id: 'cowork-1',
          name: 'Chats',
          color: 'green',
          collapsed: false,
          order: 1,
        },
      ],
    });
    jest.mocked(getSharedPipeline).mockResolvedValue({
      id: 'remote-1',
      name: 'Shared',
      version: '1',
      rawPipeline: 'name: Shared\non: dispatch\njobs: {}\n',
      shareScope: 'private',
      triggerTypes: ['dispatch'],
      createdBy: { id: 'user-1', name: 'User' },
      createdAt: '2026-05-28T12:00:00.000Z',
      updatedAt: '2026-05-28T12:00:00.000Z',
      canUpdate: true,
      canDelete: true,
    });
    mockedGetActiveSessionInfos.mockReturnValue([]);
    mockedSubscribeChatSessionActivity.mockReturnValue(jest.fn());
    mockedRunAutomationIfCommand.mockResolvedValue({
      outcome: 'run',
      stdout: '',
    });
    mockedCreateSingleRepoWorktree.mockImplementation((options) => {
      options.onGitReady?.({
        projectId: options.workspaceId,
        worktreeId: 'worktree-new',
        branchName: 'worktree-new',
      });
      return Promise.resolve({
        id: 'worktree-new',
        branchName: 'worktree-new',
        createdAt: new Date().toISOString(),
      });
    });
    mockedCreateMultiRepoWorktree.mockImplementation((options) => {
      options.onGitReady?.({
        projectId: options.workspaceId,
        worktreeId: 'worktree-new',
        branchName: 'worktree-new',
      });
      return Promise.resolve({
        id: 'worktree-new',
        branchName: 'worktree-new',
        createdAt: new Date().toISOString(),
      });
    });
    mockedDiscoverProjectPipelines.mockResolvedValue([
      {
        id: 'pipeline-1',
        name: 'Dispatch pipeline',
        description: '',
        icon: '',
        filename: 'dispatch.yaml',
        createdAt: '2026-05-28T12:00:00.000Z',
        updatedAt: '2026-05-28T12:00:00.000Z',
        source: 'project',
        readonly: true,
        filePath: '/repo/.canopy/pipelines/dispatch.yaml',
        triggerTypes: ['dispatch'],
      },
    ] as never);
    mockedGetStoredPipelineBySource.mockReturnValue({
      success: true,
      data: {
        info: {
          id: 'bundled-dispatch',
          name: 'Bundled dispatch',
          filename: 'bundled-dispatch.yaml',
          description: '',
          icon: '',
          createdAt: '2026-05-28T12:00:00.000Z',
          updatedAt: '2026-05-28T12:00:00.000Z',
          source: 'bundled',
          readonly: true,
        },
        content: { name: 'Bundled dispatch', on: 'dispatch', jobs: {} },
      },
    });
  });

  afterEach(async () => {
    resetWorkspaceTargetExclusionsForTests();
    jest.useRealTimers();
    if (dataDirPath) {
      await rm(dataDirPath, { recursive: true, force: true });
    }
  });

  it('rejects a disabled code prompt bound to Cowork before persisting', async () => {
    const { service } = makeService();
    const result = await service.create({
      name: 'Wrong target',
      enabled: false,
      schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
      action: {
        type: 'worktree_prompt',
        workspaceId: 'cowork-1',
        prompt: 'Check CI',
      },
    });
    expect(result).toMatchObject({ ok: false });
    expect((await service.list()).activities).toEqual([]);
  });

  it('rejects an unknown target even for a disabled automation', async () => {
    const { service } = makeService();
    expect(
      await service.create({
        name: 'Missing',
        enabled: false,
        schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
        action: {
          type: 'worktree_prompt',
          workspaceId: 'missing',
          prompt: 'Check CI',
        },
      }),
    ).toMatchObject({ ok: false });
  });

  it('persists a narrowed requirement through reload and unrelated edits, and rejects retargeting', async () => {
    const { service } = makeService();
    const created = await service.create({
      name: 'Chats pipeline',
      enabled: false,
      schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'cowork-1',
        pipelineId: 'bundled-dispatch',
        pipelineSource: 'bundled',
      },
      targetRequirement: { contexts: ['cowork'] },
    });
    if (!created.ok || !created.activity)
      throw new Error(JSON.stringify(created));
    const id = created.activity.id;
    expect(await service.update({ id, name: 'Renamed' })).toMatchObject({
      ok: true,
      activity: { targetRequirement: { contexts: ['cowork'] } },
    });
    const reloaded = makeService().service;
    expect((await reloaded.list()).activities[0]).toMatchObject({
      targetRequirement: { contexts: ['cowork'] },
    });
    expect(
      await reloaded.update({
        id,
        action: { ...created.activity.action, workspaceId: 'workspace-1' },
      }),
    ).toMatchObject({ ok: false });
    expect((await reloaded.list()).activities[0]).toMatchObject({
      action: { workspaceId: 'cowork-1' },
    });
  });

  it('persists explicit declaration clearing through reload and clears the marker when a declaration is set', async () => {
    const { service } = makeService();
    const created = await service.create({
      name: 'Narrowed pipeline',
      enabled: false,
      schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'bundled-dispatch',
        pipelineSource: 'bundled',
      },
      targetRequirement: { contexts: ['worktree'] },
    });
    if (!created.ok || !created.activity)
      throw new Error(JSON.stringify(created));
    const id = created.activity.id;
    expect(
      await service.update({
        id,
        action: { type: 'app_advisor_prompt', prompt: 'Review today.' },
        targetRequirement: null,
      }),
    ).toMatchObject({
      ok: true,
      activity: { targetRequirementCleared: true },
    });
    const reloaded = makeService().service;
    const saved = (await reloaded.list()).activities.find(
      (entry) => entry.id === id,
    );
    expect(saved).toHaveProperty('targetRequirementCleared', true);
    expect(saved).not.toHaveProperty('targetRequirement');
    const restored = await reloaded.update({
      id,
      targetRequirement: { contexts: ['app_advisor'] },
    });
    expect(restored.ok).toBe(true);
    expect(restored.activity).not.toHaveProperty('targetRequirementCleared');
    const legacy = await reloaded.create({
      name: 'Legacy unrestricted',
      enabled: false,
      schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
      action: { type: 'app_advisor_prompt', prompt: 'Review today.' },
    });
    if (!legacy.ok || !legacy.activity) throw new Error(JSON.stringify(legacy));
    const unchanged = await reloaded.update({
      id: legacy.activity.id,
      targetRequirement: null,
    });
    expect(unchanged.ok).toBe(true);
    expect(unchanged.activity).not.toHaveProperty('targetRequirementCleared');
    await flushAutomationWrites(service);
    await flushAutomationWrites(reloaded);
    service.stop();
    reloaded.stop();
  });

  it('blocks enablement and shell side effects after a target is removed, while allowing disable/delete', async () => {
    const { service } = makeService();
    const created = await service.create({
      name: 'Chats',
      enabled: false,
      ifCommand: 'touch marker',
      schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
      action: {
        type: 'standalone_prompt',
        chatProjectId: 'cowork-1',
        prompt: 'Run',
      },
      targetRequirement: { contexts: ['cowork'] },
    });
    if (!created.ok || !created.activity)
      throw new Error(JSON.stringify(created));
    const id = created.activity.id;
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items: [] });
    expect(await service.update({ id, enabled: true })).toMatchObject({
      ok: false,
    });
    expect(await service.runNow({ id })).toMatchObject({
      ok: true,
      run: { status: 'failure' },
    });
    expect(mockedRunAutomationIfCommand).not.toHaveBeenCalled();
    expect(mockedSendStandaloneChatMessage).not.toHaveBeenCalled();
    expect(await service.update({ id, enabled: false })).toMatchObject({
      ok: true,
    });
    expect(await service.delete({ id })).toMatchObject({ ok: true });
  });

  it('rejects changed final pipeline scopes before starting execution', async () => {
    const { service } = makeService();
    const created = await service.create({
      name: 'Code pipeline',
      enabled: false,
      schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'bundled-dispatch',
        pipelineSource: 'bundled',
      },
      targetRequirement: { contexts: ['worktree'] },
    });
    if (!created.ok || !created.activity)
      throw new Error(JSON.stringify(created));
    const original = getStoredPipelineBySource('bundled', 'bundled-dispatch');
    if (!original || !original.success)
      throw new Error('pipeline fixture missing');
    mockedGetStoredPipelineBySource
      .mockReturnValueOnce(original)
      .mockReturnValue({
        ...original,
        data: {
          ...original.data,
          content: {
            name: 'Changed',
            on: 'dispatch',
            scope: 'global',
            jobs: {},
          },
        },
      });
    const run = await service.runNow({ id: created.activity.id });
    expect(run).toMatchObject({ ok: true, run: { status: 'failure' } });
    expect(mockedStartPipelineExecutionFromMain).not.toHaveBeenCalled();
  });

  it('rejects unreadable and incompatible pipelines on disabled create', async () => {
    const { service } = makeService();
    const request: AutomationCreateRequest = {
      name: 'Pipeline',
      enabled: false,
      schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'cowork-1',
        pipelineId: 'bundled-dispatch',
        pipelineSource: 'bundled',
      },
    };
    mockedGetStoredPipelineBySource.mockReturnValue({
      success: false,
      error: 'unreadable',
    });
    expect(await service.create(request)).toMatchObject({ ok: false });
    mockedGetStoredPipelineBySource.mockReturnValue({
      success: true,
      data: {
        info: {
          id: 'bundled-dispatch',
          name: 'Test',
          filename: 'test.yaml',
          description: '',
          icon: '',
          createdAt: '2026-05-28T12:00:00.000Z',
          updatedAt: '2026-05-28T12:00:00.000Z',
          source: 'bundled',
          readonly: true,
        },
        content: {
          name: 'Test',
          on: 'dispatch',
          jobs: {},
          scope: ['worktree'],
        },
      },
    });
    expect(await service.create(request)).toMatchObject({ ok: false });
  });

  it('requires an explicit shared update to replace installed requirements and applies a rebind disabled', async () => {
    const { service } = makeService();
    const installedFrom = {
      remoteId: '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111',
      contentHash: 'a'.repeat(64),
      installedAt: '2026-05-28T12:00:00.000Z',
    };
    const created = await service.create({
      name: 'Installed Code prompt',
      enabled: true,
      schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
      action: {
        type: 'worktree_prompt',
        workspaceId: 'workspace-1',
        prompt: 'Run',
      },
      targetRequirement: { contexts: ['worktree'] },
      installedFrom,
    });
    if (!created.ok || !created.activity)
      throw new Error(JSON.stringify(created));
    const id = created.activity.id;
    expect(await service.update({ id, targetRequirement: null })).toMatchObject(
      { ok: false },
    );
    expect(
      await service.update({
        id,
        targetRequirement: { contexts: ['cowork'] },
        installedFrom: { ...installedFrom, contentHash: 'b'.repeat(64) },
        enabled: true,
        action: {
          type: 'standalone_prompt',
          chatProjectId: 'cowork-1',
          prompt: 'Run',
        },
      }),
    ).toMatchObject({
      ok: true,
      activity: { enabled: false, targetRequirement: { contexts: ['cowork'] } },
    });
  });

  it('does not start the scheduler or subscribe to session activity under the E2E build', async () => {
    const spy = jest.spyOn(e2eGate, 'isE2eBuild').mockReturnValue(true);
    try {
      const { service } = makeService();
      await service.start();
      expect(mockedSubscribeChatSessionActivity).not.toHaveBeenCalled();
      service.stop();
    } finally {
      spy.mockRestore();
    }
  });

  it('treats missing and malformed files as an empty snapshot', async () => {
    const { service } = makeService();
    await expect(service.list()).resolves.toEqual({
      activities: [],
      recentRuns: [],
    });

    await writeFile(automationsFilePath, '{bad json', 'utf8');
    const nextService = new AutomationsService();
    nextService.configure({
      getMainWindow: () => null,
      ensureAppAdvisorWindow: jest.fn(),
      sendAppAdvisorWindowCommand: jest.fn(),
    });

    await expect(nextService.list()).resolves.toEqual({
      activities: [],
      recentRuns: [],
    });

    await writeAutomationFile(null);
    const nullService = new AutomationsService();
    nullService.configure({
      getMainWindow: () => null,
      ensureAppAdvisorWindow: jest.fn(),
      sendAppAdvisorWindowCommand: jest.fn(),
    });

    await expect(nullService.list()).resolves.toEqual({
      activities: [],
      recentRuns: [],
    });
  });

  it('keeps list scoped to the selected sidebar and offers an explicit owner-context read', async (): Promise<void> => {
    const organizationId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const ownerContext: WorkspaceContext = {
      kind: 'organization',
      organizationId,
    };
    const receipt: InstallReceipt = {
      family: 'automations',
      remoteId: 'remote-a',
      localResourceIds: ['activity-1'],
      shareScope: 'organization',
      ownerContext,
      hash: 'hash',
      authorizedAt: '2026-05-28T12:00:00.000Z',
    };
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    mockBackgroundContext = 'personal';
    mockGetSharedAutomation.mockResolvedValue({
      id: 'remote-a',
      contentHash: 'hash',
      owner: { type: 'organization', id: organizationId, name: 'Acme' },
    });
    mockFindResourceOrigin.mockImplementation(
      (_family: string, localId: string) =>
        Promise.resolve({
          accountId: 'user',
          receipt: { ...receipt, localResourceIds: [localId] },
        }),
    );
    mockResourceDecide.mockImplementation((input) =>
      Promise.resolve(decideResourceContext(input, { strict: true })),
    );
    mockBackgroundDecide.mockImplementation((input) =>
      Promise.resolve(decideResourceContext(input, { strict: true })),
    );
    await writeAutomationFile({
      version: 1,
      activities: [
        activity({ id: 'activity-1', enabled: false }),
        activity({
          id: 'activity-public',
          enabled: false,
          installedFrom: {
            remoteId: 'public-a',
            contentHash: 'a'.repeat(64),
            installedAt: '2026-05-28T12:00:00.000Z',
            sourceKind: 'public',
          },
          publicInstallContext: `org:${organizationId}`,
        }),
      ],
      recentRuns: [run({ activityId: 'activity-1' })],
    });
    const { service } = makeService();

    const otherOrganizationId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    for (const sidebarContext of ['personal', `org:${otherOrganizationId}`]) {
      mockBackgroundContext = sidebarContext;
      await expect(service.list()).resolves.toMatchObject({ activities: [] });
      await expect(service.listForContext(ownerContext)).resolves.toMatchObject(
        {
          activities: [{ id: 'activity-1' }, { id: 'activity-public' }],
          recentRuns: [{ activityId: 'activity-1' }],
        },
      );
    }
    expect(
      mockBackgroundDecide.mock.calls.some(
        ([input]) =>
          input.invocation.mode === 'background' &&
          input.invocation.executionContext === `org:${organizationId}` &&
          input.resource.provenance?.remoteId === 'remote-a',
      ),
    ).toBe(true);
    expect(mockRecordInstallReceipt).not.toHaveBeenCalled();
  });

  it('rejects a caller-context list when the account changes while rows are still being authorized', async (): Promise<void> => {
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    await writeAutomationFile({
      version: 1,
      activities: [activity(), activity({ id: 'activity-2' })],
      recentRuns: [],
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markSecondPending: (() => void) | undefined;
    const secondPending = new Promise<void>((resolve) => {
      markSecondPending = resolve;
    });
    let decisions = 0;
    mockBackgroundDecide.mockImplementation(async () => {
      decisions += 1;
      if (decisions === 2) {
        markSecondPending?.();
        await gate;
      }
      return { allow: true };
    });
    const { service } = makeService();

    const listed = service.listForContext({ kind: 'personal' });
    await secondPending;
    mockAccountEpoch += 1;
    release?.();

    await expect(listed).rejects.toThrow('context-mismatch');
  });

  it('lets an authorized agent disable an installed activity in its owner context while another sidebar context is selected', async (): Promise<void> => {
    const organizationId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const ownerContext: WorkspaceContext = {
      kind: 'organization',
      organizationId,
    };
    const receipt: InstallReceipt = {
      family: 'automations',
      remoteId: 'remote-a',
      localResourceIds: ['activity-1'],
      shareScope: 'organization',
      ownerContext,
      hash: 'hash',
      authorizedAt: '2026-05-28T12:00:00.000Z',
    };
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    mockBackgroundContext = 'personal';
    mockGetSharedAutomation.mockResolvedValue({
      id: 'remote-a',
      contentHash: 'hash',
      owner: { type: 'organization', id: organizationId, name: 'Acme' },
    });
    mockFindResourceOrigin.mockImplementation(
      (_family: string, localId: string) =>
        Promise.resolve({
          accountId: 'user',
          receipt: { ...receipt, localResourceIds: [localId] },
        }),
    );
    mockResourceDecide.mockImplementation((input) =>
      Promise.resolve(decideResourceContext(input, { strict: true })),
    );
    mockBackgroundDecide.mockImplementation((input) =>
      Promise.resolve(decideResourceContext(input, { strict: true })),
    );
    await writeAutomationFile({
      version: 1,
      activities: [
        activity({
          enabled: true,
          executionContext: `org:${organizationId}`,
        }),
      ],
      recentRuns: [],
    });
    const { service } = makeService();
    const authorize = jest.fn((current: ScheduledActivity) =>
      Promise.resolve(current.executionContext === `org:${organizationId}`),
    );

    await expect(service.list()).resolves.toMatchObject({ activities: [] });
    const beforeUserUpdate = await readFile(automationsFilePath, 'utf8');
    const logExpectedUserDenial = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    await expect(
      service.update({ id: 'activity-1', enabled: false }),
    ).rejects.toMatchObject({ name: 'ResourceContextUnavailableError' });
    logExpectedUserDenial.mockRestore();
    expect(await readFile(automationsFilePath, 'utf8')).toBe(beforeUserUpdate);
    mockGetSharedAutomation.mockClear();
    await expect(service.listForContext(ownerContext)).resolves.toMatchObject({
      activities: [{ id: 'activity-1', enabled: true }],
    });
    await expect(
      service.listRuns({ activityId: 'activity-1' }, ownerContext),
    ).resolves.toMatchObject({ runs: [] });
    // The shared detail is authorized for the caller, not the sidebar.
    expect(mockGetSharedAutomation).toHaveBeenCalled();
    for (const call of mockGetSharedAutomation.mock.calls) {
      expect(call).toEqual(['remote-a', ownerContext]);
    }
    await expect(
      service.update(
        { id: 'activity-1', enabled: false },
        authorize,
        ownerContext,
      ),
    ).resolves.toMatchObject({ ok: true, activity: { enabled: false } });
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ executionContext: `org:${organizationId}` }),
    );
    await expect(service.list()).resolves.toMatchObject({ activities: [] });
    expect(mockRecordInstallReceipt).not.toHaveBeenCalled();
  });

  it.each(['update', 'disable', 'delete', 'runNow'] as const)(
    'rechecks an action retarget inside the mutation queue before guarded %s',
    async (operation): Promise<void> => {
      const ownerContext: WorkspaceContext = { kind: 'personal' };
      await writeAutomationFile({
        version: 1,
        activities: [
          activity({
            enabled: true,
            executionContext: 'personal',
            action: {
              type: 'worktree_prompt',
              workspaceId: 'workspace-1',
              prompt: 'Review the latest changes.',
            },
          }),
        ],
        recentRuns: [],
      });
      const { service, onChange } = makeService();
      const beforeRetarget = (await service.listForContext(ownerContext))
        .activities[0];
      if (!beforeRetarget || beforeRetarget.action.type !== 'worktree_prompt')
        throw new Error('Expected a workspace-targeted automation');
      expect(beforeRetarget.action.workspaceId).toBe('workspace-1');
      const authorize = jest.fn((current: ScheduledActivity) =>
        Promise.resolve(
          current.action.type === 'worktree_prompt' &&
            current.action.workspaceId === beforeRetarget.action.workspaceId,
        ),
      );

      const retarget = service.update(
        {
          id: 'activity-1',
          action: {
            type: 'worktree_prompt',
            workspaceId: 'workspace-2',
            prompt: 'Review the latest changes.',
          },
        },
        undefined,
        ownerContext,
      );
      const mutation =
        operation === 'update'
          ? service.update(
              { id: 'activity-1', name: 'Stale update' },
              authorize,
              ownerContext,
            )
          : operation === 'disable'
            ? service.update(
                { id: 'activity-1', enabled: false },
                authorize,
                ownerContext,
              )
            : operation === 'delete'
              ? service.delete({ id: 'activity-1' }, authorize, ownerContext)
              : service.runNow({ id: 'activity-1' }, authorize, ownerContext);

      await expect(retarget).resolves.toMatchObject({ ok: true });
      const persistedAfterRetarget = await readFile(
        automationsFilePath,
        'utf8',
      );
      expect(onChange).toHaveBeenCalledTimes(1);
      await expect(mutation).resolves.toEqual({
        ok: false,
        error: 'Activity not found.',
      });
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(authorize.mock.calls[0]?.[0].action).toMatchObject({
        type: 'worktree_prompt',
        workspaceId: 'workspace-2',
      });
      expect(await readFile(automationsFilePath, 'utf8')).toBe(
        persistedAfterRetarget,
      );
      expect(onChange).toHaveBeenCalledTimes(1);
      await expect(service.list()).resolves.toMatchObject({
        activities: [{ action: { workspaceId: 'workspace-2' } }],
        recentRuns: [],
      });
      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
    },
  );

  it.each(['update', 'delete', 'runNow'] as const)(
    'rechecks the rebound activity inside the mutation queue before %s authorization',
    async (operation): Promise<void> => {
      const organizationId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const ownerContext: WorkspaceContext = { kind: 'personal' };
      await writeAutomationFile({
        version: 1,
        activities: [
          activity({
            enabled: true,
            executionContext: 'personal',
            action: {
              type: 'worktree_prompt',
              workspaceId: 'workspace-1',
              prompt: 'Review the latest changes.',
            },
          }),
        ],
        recentRuns: [],
      });
      const { service } = makeService();
      const rebind = service.rebindWorkspaceExecutionContexts({
        workspaceId: 'workspace-1',
        previousContext: 'personal',
        nextContext: `org:${organizationId}`,
      });
      const authorize = jest.fn((current: ScheduledActivity) =>
        Promise.resolve(current.executionContext === 'personal'),
      );
      const mutation =
        operation === 'update'
          ? service.update(
              { id: 'activity-1', enabled: false },
              authorize,
              ownerContext,
            )
          : operation === 'delete'
            ? service.delete({ id: 'activity-1' }, authorize, ownerContext)
            : service.runNow({ id: 'activity-1' }, authorize, ownerContext);

      await expect(rebind).resolves.toEqual(['activity-1']);
      await expect(mutation).resolves.toEqual({
        ok: false,
        error: 'Activity not found.',
      });
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(authorize).toHaveBeenCalledWith(
        expect.objectContaining({ executionContext: `org:${organizationId}` }),
      );
      await expect(service.list()).resolves.toMatchObject({
        activities: [{ executionContext: `org:${organizationId}` }],
      });
    },
  );

  it.each(['other-org', 'unreadable'])(
    'denies a background automation destination with %s ownership before dispatch',
    async (mode): Promise<void> => {
      mockFeatureFlagValues.set(
        CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
        true,
      );
      mockReadBackgroundWorkspace.mockResolvedValue(
        mode === 'unreadable'
          ? {
              authority: 'unreadable',
              ownerMalformed: false,
              config: { repos: [] },
            }
          : backgroundWorkspace('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
      );
      await writeAutomationFile({
        version: 1,
        activities: [
          activity({
            executionContext: 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            action: {
              type: 'worktree_pipeline',
              workspaceId: 'project-1',
              pipelineId: 'test',
              pipelineSource: 'project',
            },
          }),
        ],
        recentRuns: [],
      });
      mockOrganizations = [
        {
          id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          name: 'Acme',
          role: 'MEMBER',
        },
        {
          id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          name: 'Globex',
          role: 'MEMBER',
        },
      ];
      mockReadWorkspaceIndexEntry.mockResolvedValue({
        id: 'project-1',
        name: 'Project One',
      });
      const { service } = makeService();
      const result = await service.runNow({ id: 'activity-1' });
      expect(createSingleRepoWorktree).not.toHaveBeenCalled();
      if (mode === 'other-org') {
        // A known mismatch is refused before a run exists; it stays on.
        expect(result).toEqual({
          ok: false,
          error:
            'Project One is in Globex, but this automation was turned on in Acme. Turn it off and on again to run it in Globex.',
        });
        const snapshot = await service.list();
        expect(snapshot.activities[0]).toMatchObject({ enabled: true });
        expect(snapshot.recentRuns).toEqual([]);
        return;
      }
      expect((await service.list()).activities[0]).toMatchObject({
        enabled: false,
        lastResult: {
          status: 'failure',
          message: messageContaining(
            "Couldn't confirm where something this uses came from",
          ),
        },
      });
    },
  );

  it.each([42, { kind: 'personal' }])(
    'rejects malformed persisted automation contexts: %j',
    async (executionContext): Promise<void> => {
      await writeAutomationFile({
        version: 1,
        activities: [{ ...activity(), executionContext }],
        recentRuns: [{ ...run(), executionContext }],
      });
      const { service } = makeService();
      expect(await service.list()).toMatchObject({
        activities: [],
        recentRuns: [],
      });
    },
  );

  it.each(['personal', 'other-org', 'fallback', 'missing'])(
    'authorizes recovery from the persisted execution destination: %s',
    async (mode): Promise<void> => {
      mockFeatureFlagValues.set(
        CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
        true,
      );
      mockReadBackgroundWorkspace.mockImplementation(
        (id): ReturnType<typeof mockReadBackgroundWorkspace> =>
          Promise.resolve(
            id === 'resume-project'
              ? backgroundWorkspace(
                  mode === 'other-org'
                    ? 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
                    : undefined,
                )
              : {
                  authority: 'unreadable',
                  ownerMalformed: false,
                  config: { repos: [] },
                },
          ),
      );
      if (mode === 'personal' || mode === 'other-org') {
        const state = createInitialState(
          normalizePipeline({ name: 'Resume', on: 'dispatch', jobs: {} }),
          {
            runtime: {
              executionsDir: join(dataDirPath, 'pipeline-executions'),
              tempRootDir: dataDirPath,
              bundledActionsDir: dataDirPath,
              getProjectActionsDir: (root): string => root,
              getProjectPipelinesDir: (root): string => root,
            },
            cwd: dataDirPath,
            pipelineId: 'resume',
            projectId: 'resume-project',
            worktreeId: 'resume-worktree',
          },
          'execution-resume',
        );
        await saveExecutionState(
          state,
          join(dataDirPath, 'pipeline-executions'),
        );
      }
      await writeAutomationFile({
        version: 1,
        activities: [
          activity({
            executionContext: 'personal',
            action: {
              type: 'pipeline_execution_resume',
              executionId: 'execution-resume',
              statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
              provider: 'claude',
              purpose: 'usage_limit_resume',
              pipelineName: 'Resume',
              ...(mode === 'fallback'
                ? { projectId: 'resume-project', worktreeId: 'resume-worktree' }
                : {}),
            },
          }),
        ],
        recentRuns: [],
      });
      const { service } = makeService();
      await service.runNow({ id: 'activity-1' });
      const allowed = mode === 'personal' || mode === 'fallback';
      expect(mockedResumePipelineExecutionFromMain).toHaveBeenCalledTimes(
        allowed ? 1 : 0,
      );
      expect((await service.list()).activities[0]).toMatchObject({
        lastResult: { status: allowed ? 'success' : 'failure' },
      });
      if (mode === 'personal' || mode === 'other-org')
        expect(mockReadBackgroundWorkspace).toHaveBeenCalledWith(
          'resume-project',
        );
    },
  );

  it('resumes a Personal persisted pipeline under strict authorization', async (): Promise<void> => {
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    mockBackgroundDecide.mockImplementation((input) =>
      Promise.resolve(decideResourceContext(input, { strict: true })),
    );
    const state = createInitialState(
      normalizePipeline({ name: 'Resume', on: 'dispatch', jobs: {} }),
      {
        runtime: {
          executionsDir: join(dataDirPath, 'pipeline-executions'),
          tempRootDir: dataDirPath,
          bundledActionsDir: dataDirPath,
          getProjectActionsDir: (root): string => root,
          getProjectPipelinesDir: (root): string => root,
        },
        cwd: dataDirPath,
        pipelineId: 'resume',
        projectId: 'resume-project',
        worktreeId: 'resume-worktree',
        pipelinePreferenceLocator: {
          type: 'file',
          value: join(dataDirPath, 'resume.yml'),
        },
      },
      'execution-resume',
    );
    await saveExecutionState(state, join(dataDirPath, 'pipeline-executions'));
    await writeAutomationFile({
      version: 1,
      activities: [
        activity({
          executionContext: 'personal',
          action: {
            type: 'pipeline_execution_resume',
            executionId: state.id,
            statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
            provider: 'claude',
            purpose: 'usage_limit_resume',
            pipelineName: 'Resume',
          },
        }),
      ],
      recentRuns: [],
    });
    const { service } = makeService();
    await service.runNow({ id: 'activity-1' });
    expect(mockedResumePipelineExecutionFromMain).toHaveBeenCalledTimes(1);
    expect((await service.list()).activities[0]?.lastResult?.status).toBe(
      'success',
    );
  });

  it('refuses an automation resume when child content changes after authorization', async (): Promise<void> => {
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    mockBackgroundDecide.mockResolvedValue({ allow: true });
    const state = createInitialState(
      normalizePipeline({
        name: 'Resume',
        on: 'dispatch',
        jobs: {
          child: {
            steps: [
              {
                uses: 'builtin/run-pipeline',
                with: { pipeline: './child.yml' },
              },
            ],
          },
        },
      }),
      {
        runtime: {
          executionsDir: join(dataDirPath, 'pipeline-executions'),
          tempRootDir: dataDirPath,
          bundledActionsDir: dataDirPath,
          getProjectActionsDir: (root): string => root,
          getProjectPipelinesDir: (root): string => root,
        },
        cwd: dataDirPath,
        pipelineId: 'resume',
        projectId: 'resume-project',
        worktreeId: 'resume-worktree',
        pipelinePreferenceLocator: {
          type: 'file',
          value: join(dataDirPath, 'resume.yml'),
        },
      },
      'execution-resume',
    );
    state.status = 'paused';
    state.status_reasons = [
      {
        id: '123e4567-e89b-42d3-a456-426614174000',
        kind: 'provider_usage_limit',
        code: 'usage_limit_exceeded',
        provider: 'claude',
        account_scope: 'native',
        detected_at: new Date().toISOString(),
        source: { job_id: 'child', step_id: 'child', attempt: 0, iteration: 1 },
      },
    ];
    await writeFile(
      join(dataDirPath, 'child.yml'),
      'name: Original\non: dispatch\njobs: {}\n',
    );
    const continued = jest.fn();
    const activeSpy = jest
      .spyOn(executionRegistry, 'hasActiveExecution')
      .mockReturnValue(true);
    const handleSpy = jest
      .spyOn(executionRegistry, 'getActiveExecutionHandle')
      .mockReturnValue({
        id: state.id,
        getState: () => state,
        cancel: () => Promise.resolve(state),
        waitForCompletion: () => Promise.resolve(state),
        addObservers: () => (): void => undefined,
        resumePaused: async (
          _ids,
          _responses,
          _source,
          _command,
          authorization?: Pick<
            ExecutionOptions,
            'executionContext' | 'childPipelineAuthorizations'
          >,
        ) => {
          await writeFile(
            join(dataDirPath, 'child.yml'),
            'name: Replaced\non: dispatch\njobs: {}\n',
          );
          await resolveChildPipeline({
            cwd: dataDirPath,
            pipelineFileDir: dataDirPath,
            pipelineRef: './child.yml',
            authorizations: authorization?.childPipelineAuthorizations,
          });
          continued();
          return state;
        },
      });
    mockedResumePipelineExecutionFromMain.mockImplementationOnce(
      jest.requireActual<typeof ResumeServiceModule>(
        '../pipelines/pipeline-resume-service',
      ).resumePipelineExecutionFromMain,
    );
    await saveExecutionState(state, join(dataDirPath, 'pipeline-executions'));
    await writeAutomationFile({
      version: 1,
      activities: [
        activity({
          executionContext: 'personal',
          action: {
            type: 'pipeline_execution_resume',
            executionId: state.id,
            statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
            provider: 'claude',
            purpose: 'usage_limit_resume',
            pipelineName: 'Resume',
          },
        }),
      ],
      recentRuns: [],
    });
    const { service } = makeService();
    try {
      const result = await service.runNow({ id: 'activity-1' });
      if (!result.ok) throw new Error(result.error);
      expect(result.run?.error).toContain("Couldn't confirm where this runs");
      expect(continued).not.toHaveBeenCalled();
      expect(mockedResumePipelineExecutionFromMain).toHaveBeenCalledTimes(1);
      expect((await service.list()).activities[0]?.lastResult?.status).toBe(
        'failure',
      );
    } finally {
      activeSpy.mockRestore();
      handleSpy.mockRestore();
    }
  });

  it('ignores empty preference maps under strict authorization', async (): Promise<void> => {
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    mockBackgroundDecide.mockImplementation((input) =>
      Promise.resolve(decideResourceContext(input, { strict: true })),
    );
    await writeAutomationFile({
      version: 1,
      activities: [
        activity({
          action: {
            type: 'app_advisor_prompt',
            prompt: 'Check',
            pluginCollectionPreferences: {},
            modelAliasPreferences: {},
          },
        }),
      ],
      recentRuns: [],
    });
    const { service, ensureAppAdvisorWindow } = makeService();
    await service.runNow({ id: 'activity-1' });
    expect(ensureAppAdvisorWindow).toHaveBeenCalledTimes(1);
    expect(
      mockBackgroundDecide.mock.calls.every(
        ([input]): boolean => input.resource.owner !== undefined,
      ),
    ).toBe(true);
  });

  it('fails closed for inherited default plugin dependencies under strict policy', async (): Promise<void> => {
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    mockBackgroundDecide.mockImplementation((input) =>
      Promise.resolve(
        decideResourceContext({
          ...input,
          invocation: {
            ...input.invocation,
            context: input.invocation.executionContext?.startsWith('org:')
              ? {
                  kind: 'organization',
                  organizationId: input.invocation.executionContext.slice(4),
                }
              : { kind: 'personal' },
          },
        }),
      ),
    );
    const preferences = await readPreferencesFile();
    jest.mocked(readPreferencesFile).mockResolvedValue({
      ...preferences,
      appAdvisorPluginSelections: {
        collectionIds: ['unknown-collection'],
        skillRefs: [],
        pluginRefs: [],
      },
    });
    await writeAutomationFile({
      version: 1,
      activities: [activity()],
      recentRuns: [],
    });
    const { service, ensureAppAdvisorWindow } = makeService();
    await service.runNow({ id: 'activity-1' });
    expect(ensureAppAdvisorWindow).not.toHaveBeenCalled();
    expect((await service.list()).activities[0]).toMatchObject({
      enabled: false,
      lastResult: {
        message: messageContaining(
          "Couldn't confirm where something this uses came from",
        ),
      },
    });
  });

  it.each([true, false])(
    'keeps an unbound Personal automation valid under strict=%s',
    async (strict): Promise<void> => {
      mockFeatureFlagValues.set(
        CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
        true,
      );
      mockBackgroundDecide.mockImplementation((input) =>
        Promise.resolve(decideResourceContext(input, { strict })),
      );
      await writeAutomationFile({
        version: 1,
        activities: [activity()],
        recentRuns: [],
      });
      const { service, ensureAppAdvisorWindow } = makeService();
      await service.runNow({ id: 'activity-1' });
      expect(ensureAppAdvisorWindow).toHaveBeenCalledTimes(1);
      expect((await service.list()).activities[0]?.lastResult?.status).toBe(
        'success',
      );
    },
  );

  it('rejects a stored Ultra fast pipeline automation before creating a worktree', async (): Promise<void> => {
    await writeAutomationFile({
      version: 1,
      activities: [
        activity({
          action: {
            type: 'worktree_pipeline',
            workspaceId: 'workspace-1',
            pipelineId: 'local-pipeline',
            pipelineSource: 'user',
            modelConfig: { speed: 'ultrafast', fastMode: false },
          },
        }),
      ],
      recentRuns: [],
    });
    const { service } = makeService();
    // The stored automation stays listed (never silently dropped).
    expect((await service.list()).activities).toHaveLength(1);
    await service.runNow({ id: 'activity-1' });
    expect(mockedCreateSingleRepoWorktree).not.toHaveBeenCalled();
    expect(mockedStartPipelineExecutionFromMain).not.toHaveBeenCalled();
    expect((await service.list()).activities[0]?.lastResult).toMatchObject({
      status: 'failure',
      message: messageContaining('Ultra fast'),
    });
  });

  it('runs a locally authored user automation under strict policy', async (): Promise<void> => {
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    mockBackgroundDecide.mockImplementation((input) =>
      Promise.resolve(decideResourceContext(input, { strict: true })),
    );
    mockedGetStoredPipelineBySource.mockReturnValue({
      success: true,
      data: {
        info: {
          id: 'local-pipeline',
          name: 'Local',
          filename: 'local.yml',
          description: '',
          icon: '',
          createdAt: '',
          updatedAt: '',
          source: 'user',
          readonly: false,
        },
        content: { name: 'Local', on: 'dispatch', jobs: {} },
      },
    });
    await writeAutomationFile({
      version: 1,
      activities: [
        activity({
          action: {
            type: 'worktree_pipeline',
            workspaceId: 'workspace-1',
            pipelineId: 'local-pipeline',
            pipelineSource: 'user',
          },
        }),
      ],
      recentRuns: [],
    });
    const { service } = makeService();
    await service.runNow({ id: 'activity-1' });
    expect(mockedStartPipelineExecutionFromMain).toHaveBeenCalledTimes(1);
    expect((await service.list()).activities[0]?.lastResult?.status).toBe(
      'success',
    );
  });

  it('disables an unbound organization pipeline before workspace creation', async (): Promise<void> => {
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    mockBackgroundDecide.mockImplementation((input) =>
      Promise.resolve(
        decideResourceContext({
          ...input,
          invocation: {
            ...input.invocation,
            context: input.invocation.executionContext?.startsWith('org:')
              ? {
                  kind: 'organization',
                  organizationId: input.invocation.executionContext.slice(4),
                }
              : { kind: 'personal' },
          },
        }),
      ),
    );
    jest.mocked(getStoredPipelineBySource).mockReturnValue({
      success: true,
      data: {
        info: {
          id: 'org-pipeline',
          name: 'Org',
          filename: 'org.yml',
          description: '',
          icon: '',
          createdAt: '',
          updatedAt: '',
          source: 'user',
          readonly: false,
          owner: {
            type: 'organization',
            id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            name: null,
          },
        },
        content: { name: 'Org', on: 'dispatch', jobs: {} },
      },
    });
    await writeAutomationFile({
      version: 1,
      activities: [
        activity({
          action: {
            type: 'worktree_pipeline',
            workspaceId: 'project-1',
            pipelineId: 'org-pipeline',
            pipelineSource: 'user',
          },
        }),
      ],
      recentRuns: [],
    });
    const { service } = makeService();
    await service.runNow({ id: 'activity-1' });
    expect(createSingleRepoWorktree).not.toHaveBeenCalled();
    expect((await service.list()).activities[0]).toMatchObject({
      enabled: false,
      lastResult: {
        status: 'failure',
        message: messageContaining(
          'This is in a different Personal or organization context',
        ),
      },
    });
  });

  it('authorizes the bound context and disables denied automations before dispatch', async (): Promise<void> => {
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    mockBackgroundContext = 'personal';
    const { service, ensureAppAdvisorWindow } = makeService();
    const created = await service.create({
      name: 'Bound run',
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: appAdvisorAction(),
    });
    if (!created.ok || !created.activity) throw new Error('create failed');
    mockBackgroundContext = 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await service.runNow({ id: created.activity.id });
    expect(mockBackgroundDecide.mock.calls[0]?.[0].invocation).toMatchObject({
      mode: 'background',
      executionContext: 'personal',
    });
    mockBackgroundDecide.mockResolvedValueOnce({
      allow: false,
      reason: 'unknown-provenance',
      subject: { kind: 'plugin', name: 'Mystery plugin' },
    });
    ensureAppAdvisorWindow.mockClear();
    await service.runNow({ id: created.activity.id });
    expect(ensureAppAdvisorWindow).not.toHaveBeenCalled();
    expect((await service.list()).activities[0]).toMatchObject({
      enabled: false,
      lastResult: {
        status: 'failure',
        message: messageContaining(
          "Couldn't confirm where Mystery plugin came from",
        ),
      },
    });
  });

  describe('selected context target check (CAN-3448)', () => {
    const ORG_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const OTHER_ORG_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const coworkAction = {
      type: 'standalone_prompt',
      chatProjectId: 'cowork-1',
      prompt: 'Summarize',
    } as const;
    const orgWorktreeAction = {
      type: 'worktree_pipeline',
      workspaceId: 'org-project',
      pipelineId: 'test',
      pipelineSource: 'project',
    } as const;
    const otherOrgAction = {
      type: 'worktree_prompt',
      workspaceId: 'globex-project',
      prompt: 'Summarize',
    } as const;
    const NON_MEMBER_ORG_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const nonMemberOrgAction = {
      type: 'worktree_prompt',
      workspaceId: 'initech-project',
      prompt: 'Summarize',
    } as const;

    beforeEach((): void => {
      mockedReadAllSidebarItems.mockResolvedValue({
        version: 1,
        items: [
          {
            type: 'cowork',
            id: 'cowork-1',
            name: 'Chats',
            color: 'green',
            collapsed: false,
            order: 0,
          },
          ...(
            [
              ['org-project', ORG_ID],
              ['globex-project', OTHER_ORG_ID],
              ['initech-project', NON_MEMBER_ORG_ID],
            ] as const
          ).map(([id, organizationId]) => ({
            type: 'single-repo' as const,
            id,
            name: id,
            repoPath: '/repo',
            color: 'blue',
            collapsed: false,
            order: 1,
            worktrees: [],
            owner: backgroundWorkspace(organizationId).config.owner,
          })),
        ],
      });
      mockedDiscoverProjectPipelines.mockResolvedValue([
        {
          id: 'test',
          name: 'Test',
          description: '',
          icon: '',
          filename: 'test.yaml',
          createdAt: '2026-05-28T12:00:00.000Z',
          updatedAt: '2026-05-28T12:00:00.000Z',
          source: 'project',
          readonly: true,
          filePath: '/repo/.canopy/pipelines/test.yaml',
          triggerTypes: ['dispatch'],
        },
      ]);
      mockFeatureFlagValues.set(
        CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
        true,
      );
      // Real owners and strict policy, as an org-project account sees them.
      mockResourceDecide.mockImplementation((input) =>
        Promise.resolve(decideResourceContext(input, { strict: true })),
      );
      mockBackgroundContext = `org:${ORG_ID}`;
      mockOrganizations = [
        { id: ORG_ID, name: 'Acme', role: 'MEMBER' },
        { id: OTHER_ORG_ID, name: 'Globex', role: 'MEMBER' },
      ];
      mockReadWorkspaceIndexEntry.mockImplementation((id) =>
        Promise.resolve(
          id === 'cowork-1'
            ? { id, name: 'Chats' }
            : id === 'org-project'
              ? { id, name: 'Org project' }
              : id === 'initech-project'
                ? { id, name: 'Initech project' }
                : null,
        ),
      );
      mockReadBackgroundWorkspace.mockImplementation((id) =>
        Promise.resolve(
          id === 'org-project'
            ? backgroundWorkspace(ORG_ID)
            : id === 'globex-project'
              ? backgroundWorkspace(OTHER_ORG_ID)
              : id === 'initech-project'
                ? backgroundWorkspace(NON_MEMBER_ORG_ID)
                : backgroundWorkspace(),
        ),
      );
    });

    afterEach((): void => {
      mockBackgroundContext = 'personal';
    });

    it('binds a Personal target to Personal when turned on while an organization is selected', async (): Promise<void> => {
      await writeAutomationFile({
        version: 1,
        activities: [activity({ enabled: false, action: coworkAction })],
        recentRuns: [],
      });
      const { service } = makeService();
      const result = await service.update({ id: 'activity-1', enabled: true });
      expect(result).toMatchObject({
        ok: true,
        activity: { enabled: true, executionContext: 'personal' },
      });
      const persisted: unknown = JSON.parse(
        await readFile(automationsFilePath, 'utf8'),
      );
      expect(persisted).toMatchObject({
        activities: [
          { id: 'activity-1', enabled: true, executionContext: 'personal' },
        ],
      });
    });

    it('rebinds a stale scope to the organization that owns the target when turned back on', async (): Promise<void> => {
      // CAN-3598: stamped with the selected org, then turned off by a run.
      await writeAutomationFile({
        version: 1,
        activities: [
          activity({
            enabled: false,
            executionContext: `org:${ORG_ID}`,
            action: otherOrgAction,
          }),
        ],
        recentRuns: [],
      });
      const { service } = makeService();
      const result = await service.update({ id: 'activity-1', enabled: true });
      expect(result).toMatchObject({
        ok: true,
        activity: { enabled: true, executionContext: `org:${OTHER_ORG_ID}` },
      });
    });

    it('binds to the owner of the target an update switches to while turning it on', async (): Promise<void> => {
      await writeAutomationFile({
        version: 1,
        activities: [activity({ enabled: false, action: orgWorktreeAction })],
        recentRuns: [],
      });
      const { service } = makeService();
      const result = await service.update({
        id: 'activity-1',
        enabled: true,
        action: coworkAction,
      });
      expect(result).toMatchObject({
        ok: true,
        activity: {
          enabled: true,
          action: coworkAction,
          executionContext: 'personal',
        },
      });
    });

    it('binds an automation that is on to the owner of a target it moves to outside the selected context', async (): Promise<void> => {
      await writeAutomationFile({
        version: 1,
        activities: [
          activity({
            executionContext: `org:${ORG_ID}`,
            action: orgWorktreeAction,
          }),
        ],
        recentRuns: [],
      });
      const { service } = makeService();
      const result = await service.update({
        id: 'activity-1',
        action: coworkAction,
      });
      expect(result).toMatchObject({
        ok: true,
        activity: {
          enabled: true,
          action: coworkAction,
          executionContext: 'personal',
        },
      });
    });

    it('refuses turning on a target in an organization the account is not in', async (): Promise<void> => {
      await writeAutomationFile({
        version: 1,
        activities: [activity({ enabled: false, action: nonMemberOrgAction })],
        recentRuns: [],
      });
      const { service } = makeService();
      const result = await service.update({ id: 'activity-1', enabled: true });
      expect(result).toEqual({
        ok: false,
        error:
          "Initech project is in an organization you're not a member of. Ask for access, then turn this automation on.",
      });
      const stored = (await service.list()).activities[0];
      expect(stored?.enabled).toBe(false);
      expect(stored?.executionContext).toBeUndefined();
    });

    it('logs an execution-context refusal with the installed remote id when turning an automation on', async (): Promise<void> => {
      await writeAutomationFile({
        version: 1,
        activities: [
          activity({
            enabled: false,
            action: nonMemberOrgAction,
            // Installed in the selected org, so only the target refuses it.
            installedFrom: {
              remoteId: 'remote-1',
              contentHash: 'a'.repeat(64),
              installedAt: '2026-05-28T12:00:00.000Z',
              sourceKind: 'public',
            },
            publicInstallContext: `org:${ORG_ID}`,
          }),
        ],
        recentRuns: [],
      });
      const { service } = makeService();
      mockedLogMainProcessError.mockClear();

      const refused = await service.update({ id: 'activity-1', enabled: true });
      if (refused.ok) throw new Error('expected the enable to be refused');
      expect(
        mockedLogMainProcessError.mock.calls.filter(
          ([message]) => message === 'Automation enable refused',
        ),
      ).toEqual([
        [
          'Automation enable refused',
          {
            activityId: 'activity-1',
            refusal: refused.error,
            remoteId: 'remote-1',
          },
        ],
      ]);
    });

    it('does not log an enable refusal when an automation that is on is moved', async (): Promise<void> => {
      await writeAutomationFile({
        version: 1,
        activities: [
          activity({ executionContext: 'personal', action: coworkAction }),
        ],
        recentRuns: [],
      });
      const { service } = makeService();
      mockedLogMainProcessError.mockClear();

      await expect(
        service.update({
          id: 'activity-1',
          enabled: true,
          action: nonMemberOrgAction,
        }),
      ).resolves.toMatchObject({ ok: false });
      expect(mockedLogMainProcessError).not.toHaveBeenCalledWith(
        'Automation enable refused',
        expect.anything(),
      );
    });

    it('binds an automation that is on to the selected context when it moves to a target there', async (): Promise<void> => {
      // Turned on in Personal, then moved to a project in the selected org.
      await writeAutomationFile({
        version: 1,
        activities: [
          activity({ executionContext: 'personal', action: coworkAction }),
        ],
        recentRuns: [],
      });
      const { service } = makeService();
      const result = await service.update({
        id: 'activity-1',
        action: orgWorktreeAction,
      });
      expect(result).toMatchObject({
        ok: true,
        activity: {
          enabled: true,
          action: orgWorktreeAction,
          executionContext: `org:${ORG_ID}`,
        },
      });
    });

    it('keeps the saved context when an update leaves the target in place', async (): Promise<void> => {
      await writeAutomationFile({
        version: 1,
        activities: [
          activity({
            executionContext: `org:${OTHER_ORG_ID}`,
            action: orgWorktreeAction,
          }),
        ],
        recentRuns: [],
      });
      const { service } = makeService();
      const result = await service.update({
        id: 'activity-1',
        name: 'Renamed',
        action: { ...orgWorktreeAction },
      });
      expect(result).toMatchObject({
        ok: true,
        activity: {
          name: 'Renamed',
          executionContext: `org:${OTHER_ORG_ID}`,
        },
      });
    });

    it('turns on a target in the selected organization', async (): Promise<void> => {
      await writeAutomationFile({
        version: 1,
        activities: [activity({ enabled: false, action: orgWorktreeAction })],
        recentRuns: [],
      });
      const { service } = makeService();
      const result = await service.update({ id: 'activity-1', enabled: true });
      expect(result).toMatchObject({
        ok: true,
        activity: { enabled: true, executionContext: `org:${ORG_ID}` },
      });
    });

    it('binds an enabled automation created outside the selected context to its target owner', async (): Promise<void> => {
      const { service } = makeService();
      const result = await service.create({
        name: 'Summaries',
        schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
        action: otherOrgAction,
      });
      expect(result).toMatchObject({
        ok: true,
        activity: { enabled: true, executionContext: `org:${OTHER_ORG_ID}` },
      });
    });

    it('refuses creating an enabled automation in an organization the account is not in', async (): Promise<void> => {
      const { service } = makeService();
      const result = await service.create({
        name: 'Summaries',
        schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
        action: nonMemberOrgAction,
      });
      expect(result).toEqual({
        ok: false,
        error:
          "Initech project is in an organization you're not a member of. Ask for access, then turn this automation on.",
      });
      expect((await service.list()).activities).toEqual([]);
    });

    it('still creates a turned-off automation outside the selected context', async (): Promise<void> => {
      const { service } = makeService();
      const result = await service.create({
        name: 'Summaries',
        enabled: false,
        schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
        action: coworkAction,
      });
      expect(result.ok).toBe(true);
    });

    it('runs an automation that was never turned on in the context that owns its target', async (): Promise<void> => {
      await writeAutomationFile({
        version: 1,
        activities: [activity({ enabled: false, action: coworkAction })],
        recentRuns: [],
      });
      const { service } = makeService();
      const result = await service.runNow({ id: 'activity-1' });
      expect(result.ok).toBe(true);
      const snapshot = await service.list();
      expect(snapshot.recentRuns[0]?.executionContext).toBe('personal');
      expect(snapshot.activities[0]?.executionContext).toBeUndefined();
    });

    it('refuses Run now for a target in an organization the account is not in and creates no run', async (): Promise<void> => {
      await writeAutomationFile({
        version: 1,
        activities: [activity({ enabled: false, action: nonMemberOrgAction })],
        recentRuns: [],
      });
      const { service } = makeService();
      const result = await service.runNow({ id: 'activity-1' });
      expect(result).toEqual({
        ok: false,
        error:
          "Initech project is in an organization you're not a member of. Ask for access, then run this automation again.",
      });
      expect((await service.list()).recentRuns).toEqual([]);
    });

    it('refuses Run now when the saved context no longer matches the target', async (): Promise<void> => {
      mockBackgroundContext = 'personal';
      await writeAutomationFile({
        version: 1,
        activities: [
          activity({
            executionContext: `org:${ORG_ID}`,
            action: coworkAction,
          }),
        ],
        recentRuns: [],
      });
      const { service } = makeService();
      const result = await service.runNow({ id: 'activity-1' });
      expect(result).toEqual({
        ok: false,
        error:
          'Chats is in Personal, but this automation was turned on in Acme. Turn it off and on again to run it in Personal.',
      });
      expect((await service.list()).recentRuns).toEqual([]);
    });

    it('runs an automation that is off in the selected context, not the one it last saved', async (): Promise<void> => {
      mockBackgroundContext = 'personal';
      await writeAutomationFile({
        version: 1,
        activities: [
          activity({
            enabled: false,
            executionContext: `org:${ORG_ID}`,
            action: coworkAction,
          }),
        ],
        recentRuns: [],
      });
      const { service } = makeService();
      const result = await service.runNow({ id: 'activity-1' });
      expect(result.ok).toBe(true);
      const snapshot = await service.list();
      expect(snapshot.recentRuns[0]?.executionContext).toBe('personal');
      // The run doesn't re-bind it; turning it on does.
      expect(snapshot.activities[0]?.executionContext).toBe(`org:${ORG_ID}`);
    });

    it('runs an automation that is off in its target context, not the selected one', async (): Promise<void> => {
      await writeAutomationFile({
        version: 1,
        activities: [
          activity({
            enabled: false,
            executionContext: `org:${ORG_ID}`,
            action: otherOrgAction,
          }),
        ],
        recentRuns: [],
      });
      const { service } = makeService();
      const result = await service.runNow({ id: 'activity-1' });
      expect(result.ok).toBe(true);
      const snapshot = await service.list();
      expect(snapshot.recentRuns[0]?.executionContext).toBe(
        `org:${OTHER_ORG_ID}`,
      );
      expect(snapshot.activities[0]?.executionContext).toBe(`org:${ORG_ID}`);
    });

    it('runs an automation that was never turned on in the selected context', async (): Promise<void> => {
      await writeAutomationFile({
        version: 1,
        activities: [activity({ enabled: false, action: orgWorktreeAction })],
        recentRuns: [],
      });
      const { service } = makeService();
      const result = await service.runNow({ id: 'activity-1' });
      expect(result.ok).toBe(true);
      expect(mockBackgroundDecide.mock.calls[0]?.[0].invocation).toMatchObject({
        executionContext: `org:${ORG_ID}`,
      });
      const snapshot = await service.list();
      // The fallback context belongs to the run only, never the activity.
      expect(snapshot.recentRuns[0]?.executionContext).toBe(`org:${ORG_ID}`);
      expect(snapshot.activities[0]?.executionContext).toBeUndefined();
    });

    async function saveResumeExecution(projectId: string): Promise<string> {
      const state = createInitialState(
        normalizePipeline({ name: 'Resume', on: 'dispatch', jobs: {} }),
        {
          runtime: {
            executionsDir: join(dataDirPath, 'pipeline-executions'),
            tempRootDir: dataDirPath,
            bundledActionsDir: dataDirPath,
            getProjectActionsDir: (root): string => root,
            getProjectPipelinesDir: (root): string => root,
          },
          cwd: dataDirPath,
          pipelineId: 'resume',
          projectId,
          worktreeId: 'resume-worktree',
          pipelinePreferenceLocator: {
            type: 'file',
            value: join(dataDirPath, 'resume.yml'),
          },
        },
        'execution-resume',
      );
      await saveExecutionState(state, join(dataDirPath, 'pipeline-executions'));
      return state.id;
    }

    function resumeAction(executionId: string): AutomationAction {
      // Pause-resume UI omits projectId; the execution state names the target.
      return {
        type: 'pipeline_execution_resume',
        executionId,
        statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
        provider: 'claude',
        purpose: 'usage_limit_resume',
        pipelineName: 'Resume',
      };
    }

    it('binds a resume automation to the owner of its saved execution target', async (): Promise<void> => {
      const executionId = await saveResumeExecution('globex-project');
      const { service } = makeService();
      const result = await service.create({
        name: 'Resume after reset',
        schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
        action: resumeAction(executionId),
      });
      expect(result).toMatchObject({
        ok: true,
        activity: { enabled: true, executionContext: `org:${OTHER_ORG_ID}` },
      });
    });

    it('runs a resume automation that is off in the owner of its saved execution target', async (): Promise<void> => {
      const executionId = await saveResumeExecution('globex-project');
      await writeAutomationFile({
        version: 1,
        activities: [
          activity({ enabled: false, action: resumeAction(executionId) }),
        ],
        recentRuns: [],
      });
      const { service } = makeService();
      const result = await service.runNow({ id: 'activity-1' });
      expect(result.ok).toBe(true);
      expect((await service.list()).recentRuns[0]?.executionContext).toBe(
        `org:${OTHER_ORG_ID}`,
      );
    });

    it('lets App Advisor automations turn on and run in any context', async (): Promise<void> => {
      const { service, ensureAppAdvisorWindow } = makeService();
      const created = await service.create({
        name: 'Advisor check',
        schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
        action: appAdvisorAction(),
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      expect(created.activity.executionContext).toBe(`org:${ORG_ID}`);
      const result = await service.runNow({ id: created.activity.id });
      expect(result.ok).toBe(true);
      expect(ensureAppAdvisorWindow).toHaveBeenCalled();
    });

    it('names both contexts when a scheduled run is denied for a mismatch', async (): Promise<void> => {
      await writeAutomationFile({
        version: 1,
        activities: [
          activity({
            executionContext: `org:${OTHER_ORG_ID}`,
            action: orgWorktreeAction,
          }),
        ],
        recentRuns: [],
      });
      mockBackgroundContext = `org:${OTHER_ORG_ID}`;
      const { service } = makeService();
      // Ownership changes after Run now's early check, so the run-time check
      // owns the denial and names both contexts.
      mockReadBackgroundWorkspace.mockResolvedValueOnce(
        backgroundWorkspace(OTHER_ORG_ID),
      );
      const result = await service.runNow({ id: 'activity-1' });
      expect(result.ok).toBe(true);
      expect(result.run).toMatchObject({
        status: 'failure',
        error:
          'Turned off because Org project is in Acme, but this automation was turned on in Globex. Turn it on again to run it in Acme.',
      });
      expect((await service.list()).activities[0]?.enabled).toBe(false);
    });

    it('rebinds and completes a scheduled run after its project converts', async (): Promise<void> => {
      mockBackgroundDecide.mockImplementation((input) =>
        Promise.resolve(decideResourceContext(input, { strict: true })),
      );
      mockReadBackgroundWorkspace.mockResolvedValue(
        backgroundWorkspace(ORG_ID, true),
      );
      await writeAutomationFile({
        version: 1,
        activities: [
          activity({
            executionContext: 'personal',
            action: coworkAction,
          }),
        ],
        recentRuns: [],
      });
      const { service } = makeService();
      await service.list();
      const internals = service as unknown as {
        file: { recentRuns: ScheduledActivityRun[] } | null;
        finishRun(
          activityId: string,
          runId: string,
          enabledIntentRevision: number,
        ): Promise<ScheduledActivityRun | null>;
      };
      if (!internals.file) throw new Error('automation file was not loaded');
      internals.file.recentRuns = [
        run({
          status: 'running',
          manual: false,
          trigger: 'scheduled',
          executionContext: 'personal',
          completedAt: undefined,
        }),
      ];

      const result = await internals.finishRun('activity-1', 'run-1', 0);

      expect(mockRebindMovedWorkspace).toHaveBeenCalledWith(
        {
          workspaceId: 'cowork-1',
          from: { kind: 'personal' },
          to: { kind: 'organization', organizationId: ORG_ID },
        },
        'runtime-mismatch',
      );
      expect(result).toMatchObject({ status: 'success', manual: false });
      const snapshot = await service.list();
      expect(snapshot.activities[0]).toMatchObject({
        enabled: true,
        executionContext: `org:${ORG_ID}`,
      });
    });

    it.each([
      {
        name: 'the account is not a member of the new owner',
        bound: 'personal',
        organizations: [],
        message:
          'Turned off because Chats moved to an organization, but this automation still runs in Personal. Turn it on again to run it in an organization.',
      },
      {
        name: 'it was bound to a context the project never had',
        bound: `org:${OTHER_ORG_ID}`,
        organizations: [
          { id: ORG_ID, name: 'Acme', role: 'MEMBER' as const },
          { id: OTHER_ORG_ID, name: 'Globex', role: 'MEMBER' as const },
        ],
        message:
          'Turned off because Chats moved to Acme, but this automation still runs in Globex. Turn it on again to run it in Acme.',
      },
    ])(
      'says the project moved, without following it, when $name',
      async ({ bound, organizations, message }): Promise<void> => {
        mockOrganizations = organizations;
        mockBackgroundDecide.mockImplementation((input) =>
          Promise.resolve(decideResourceContext(input, { strict: true })),
        );
        mockReadBackgroundWorkspace.mockResolvedValue(
          backgroundWorkspace(ORG_ID, true),
        );
        await writeAutomationFile({
          version: 1,
          activities: [
            activity({ executionContext: bound, action: coworkAction }),
          ],
          recentRuns: [],
        });
        const { service } = makeService();
        await service.list();
        const internals = service as unknown as {
          file: { recentRuns: ScheduledActivityRun[] } | null;
          finishRun(
            activityId: string,
            runId: string,
            enabledIntentRevision: number,
          ): Promise<ScheduledActivityRun | null>;
        };
        if (!internals.file) throw new Error('automation file was not loaded');
        internals.file.recentRuns = [
          run({
            status: 'running',
            manual: false,
            trigger: 'scheduled',
            executionContext: bound,
            completedAt: undefined,
          }),
        ];

        const result = await internals.finishRun('activity-1', 'run-1', 0);

        expect(mockRebindMovedWorkspace).not.toHaveBeenCalled();
        expect(result).toMatchObject({ status: 'failure', error: message });
        expect((await service.list()).activities[0]).toMatchObject({
          enabled: false,
          executionContext: bound,
        });
      },
    );
  });

  // A workspace owner is a local binding ({ organizationId }), not the
  // ResourceOwner wire shape ({ id }) the context policy classifies, so it
  // must never reach the policy as provenance (regressed in #4704).
  describe('target project owner under strict context policy', () => {
    const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const OTHER_ORG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const BINDING_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const orgBinding = {
      type: 'organization' as const,
      organizationId: ORG_ID,
      projectId: BINDING_ID,
      instanceId: BINDING_ID,
      bindingGeneration: 1,
    };

    function projectItem(
      id: string,
      owner?: typeof orgBinding,
    ): SidebarItemsFile['items'][number] {
      return {
        type: 'single-repo',
        id,
        name: id,
        repoPath: '/repo',
        color: 'blue',
        collapsed: false,
        order: 0,
        worktrees: [],
        ...(owner ? { owner } : {}),
      };
    }

    function createPrompt(
      service: AutomationsService,
      workspaceId: string,
      enabled = true,
    ): ReturnType<AutomationsService['create']> {
      return service.create({
        name: 'Summaries',
        enabled,
        schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
        action: { type: 'worktree_prompt', workspaceId, prompt: 'Summarize' },
      });
    }

    beforeEach((): void => {
      mockFeatureFlagValues.set(
        CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
        true,
      );
      mockResourceDecide.mockImplementation((input) =>
        Promise.resolve(decideResourceContext(input, { strict: true })),
      );
      mockOrganizations = [
        { id: ORG_ID, name: 'Acme', role: 'MEMBER' },
        { id: OTHER_ORG_ID, name: 'Globex', role: 'MEMBER' },
      ];
      mockedReadAllSidebarItems.mockResolvedValue({
        version: 1,
        items: [
          projectItem('org-project', orgBinding),
          projectItem('personal-project'),
          // Sidebar reads normalize a malformed binding away, as in production.
          projectItem('malformed-project'),
        ],
      });
      mockReadBackgroundWorkspace.mockImplementation((id) =>
        Promise.resolve(
          id === 'malformed-project'
            ? { ...backgroundWorkspace(), ownerMalformed: true }
            : backgroundWorkspace(id === 'org-project' ? ORG_ID : undefined),
        ),
      );
    });

    afterEach((): void => {
      mockBackgroundContext = 'personal';
      mockOrganizations = [];
    });

    // The selected context never gates the target: an automation binds to the
    // organization that owns its project (CAN-3598).
    it.each([`org:${ORG_ID}`, `org:${OTHER_ORG_ID}`, 'personal'])(
      'creates a prompt automation for an org project from %s, bound to its owner',
      async (context): Promise<void> => {
        mockBackgroundContext = context;
        const { service } = makeService();

        await expect(
          createPrompt(service, 'org-project'),
        ).resolves.toMatchObject({
          ok: true,
          activity: { enabled: true, executionContext: `org:${ORG_ID}` },
        });
      },
    );

    it.each([`org:${ORG_ID}`, 'personal'])(
      'creates a prompt automation for a Personal project in %s',
      async (context): Promise<void> => {
        mockBackgroundContext = context;
        const { service } = makeService();

        await expect(
          createPrompt(service, 'personal-project'),
        ).resolves.toMatchObject({ ok: true });
      },
    );

    // A turned-off automation skips the enable and run-time checks, so the
    // persisted malformed flag must refuse it at save time.
    it.each([
      [`org:${ORG_ID}`, true],
      [`org:${ORG_ID}`, false],
      ['personal', false],
    ])(
      'fails closed for a project whose owner binding is malformed (%s, enabled %s)',
      async (context, enabled): Promise<void> => {
        mockBackgroundContext = context;
        const { service } = makeService();

        const result = await createPrompt(
          service,
          'malformed-project',
          enabled,
        );

        expect(result).toEqual({
          ok: false,
          error: 'Resource unavailable (unknown-provenance)',
        });
        expect(mockReadBackgroundWorkspace).toHaveBeenCalledWith(
          'malformed-project',
        );
        expect((await service.list()).activities).toEqual([]);
      },
    );
  });

  // CAN-3598: an automation binds to the context that owns its target
  // project, so its pipeline is authorized there, not in the selected context.
  describe('stored pipeline owner in the binding context', () => {
    const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const OTHER_ORG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const BINDING_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    function storedPipeline(
      source: 'bundled' | 'user',
      owner?: ResourceOwner,
      { remoteId, uses }: { remoteId?: string; uses?: string } = {},
    ): ReturnType<typeof getStoredPipelineBySource> {
      return {
        success: true,
        data: {
          info: {
            id: 'stored-pipeline',
            name: 'Stored',
            filename: 'stored.yml',
            description: '',
            icon: '',
            createdAt: '',
            updatedAt: '',
            source,
            readonly: source === 'bundled',
            ...(owner ? { owner } : {}),
            ...(remoteId ? { remoteId } : {}),
          },
          content: {
            name: 'Stored',
            on: 'dispatch',
            jobs: uses ? { build: { steps: [{ uses, with: {} }] } } : {},
          },
        },
      };
    }

    function createPipeline(
      service: AutomationsService,
      enabled: boolean,
      pipelineSource: 'bundled' | 'user' | 'project' = 'user',
    ): ReturnType<AutomationsService['create']> {
      return service.create({
        name: 'Nightly',
        enabled,
        schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
        action: {
          type: 'worktree_pipeline',
          workspaceId: 'org-project',
          pipelineId:
            pipelineSource === 'project' ? 'pipeline-1' : 'stored-pipeline',
          pipelineSource,
        },
      });
    }

    beforeEach((): void => {
      mockFeatureFlagValues.set(
        CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
        true,
      );
      // Real owners and strict policy, as an org-project account sees them.
      mockResourceDecide.mockImplementation((input) =>
        Promise.resolve(decideResourceContext(input, { strict: true })),
      );
      mockBackgroundDecide.mockImplementation((input) =>
        Promise.resolve(decideResourceContext(input, { strict: true })),
      );
      mockOrganizations = [
        { id: ORG_ID, name: 'Acme', role: 'MEMBER' },
        { id: OTHER_ORG_ID, name: 'Globex', role: 'MEMBER' },
      ];
      mockedReadAllSidebarItems.mockResolvedValue({
        version: 1,
        items: [
          {
            type: 'single-repo',
            id: 'org-project',
            name: 'org-project',
            repoPath: '/repo',
            color: 'blue',
            collapsed: false,
            order: 0,
            worktrees: [],
            owner: {
              type: 'organization',
              organizationId: ORG_ID,
              projectId: BINDING_ID,
              instanceId: BINDING_ID,
              bindingGeneration: 1,
            },
          },
        ],
      });
      mockReadWorkspaceIndexEntry.mockImplementation((id) =>
        Promise.resolve(
          id === 'org-project' ? { id, name: 'Org project' } : null,
        ),
      );
      mockReadBackgroundWorkspace.mockResolvedValue(
        backgroundWorkspace(ORG_ID),
      );
    });

    afterEach((): void => {
      mockBackgroundContext = 'personal';
      mockOrganizations = [];
    });

    it.each([
      ['personal', true],
      ['personal', false],
      [`org:${OTHER_ORG_ID}`, true],
      [`org:${OTHER_ORG_ID}`, false],
    ])(
      "saves the target organization's pipeline from %s (enabled %s), bound to its owner",
      async (context, enabled): Promise<void> => {
        mockBackgroundContext = context;
        mockedGetStoredPipelineBySource.mockReturnValue(
          storedPipeline('user', {
            type: 'organization',
            id: ORG_ID,
            name: 'Acme',
          }),
        );
        const { service } = makeService();

        await expect(createPipeline(service, enabled)).resolves.toMatchObject({
          ok: true,
        });

        const { activities } = await service.list();
        expect(activities).toHaveLength(1);
        expect(activities[0]?.enabled).toBe(enabled);
        // Disabled automations are bound too while organization projects are on.
        expect(activities[0]?.executionContext).toBe(`org:${ORG_ID}`);
      },
    );

    // Selected org B would accept org B's pipeline, but the automation runs
    // in org A, so it could only ever be refused there.
    it.each([false, true])(
      "refuses another organization's pipeline on save (enabled %s)",
      async (enabled): Promise<void> => {
        mockBackgroundContext = `org:${OTHER_ORG_ID}`;
        mockedGetStoredPipelineBySource.mockReturnValue(
          storedPipeline('user', {
            type: 'organization',
            id: OTHER_ORG_ID,
            name: 'Globex',
          }),
        );
        const { service } = makeService();

        const result = await createPipeline(service, enabled);

        expect(result).toEqual({
          ok: false,
          error: backgroundExecutionDeniedMessage('context-mismatch'),
        });
        expect((await service.list()).activities).toEqual([]);
        expect(
          mockBackgroundDecide.mock.calls.map(([input]) => [
            input.resource.owner,
            input.invocation.executionContext,
          ]),
        ).toContainEqual([
          { type: 'organization', id: OTHER_ORG_ID, name: 'Globex' },
          `org:${ORG_ID}`,
        ]);
      },
    );

    it.each(
      ['personal', `org:${ORG_ID}`, `org:${OTHER_ORG_ID}`].flatMap((context) =>
        (
          [
            ['Personal', 'user', { type: 'user', id: 'user', name: 'Me' }],
            ['bundled', 'bundled', undefined],
            ['locally authored', 'user', undefined],
            ['project file', 'project', undefined],
          ] as const
        ).map(
          ([label, source, owner]) => [label, context, source, owner] as const,
        ),
      ),
    )(
      'saves a %s pipeline from %s',
      async (_label, context, source, owner): Promise<void> => {
        mockBackgroundContext = context;
        if (source !== 'project')
          mockedGetStoredPipelineBySource.mockReturnValue(
            storedPipeline(source, owner),
          );
        const { service } = makeService();

        await expect(
          createPipeline(service, false, source),
        ).resolves.toMatchObject({ ok: true });
        await expect(
          createPipeline(service, true, source),
        ).resolves.toMatchObject({
          ok: true,
          activity: { enabled: true, executionContext: `org:${ORG_ID}` },
        });
      },
    );

    // Install receipts are keyed by the installed copy's remote id, as the
    // turn-on check reads them.
    it('checks the install receipt of an installed copy by its remote id', async (): Promise<void> => {
      mockBackgroundContext = 'personal';
      mockedGetStoredPipelineBySource.mockReturnValue(
        storedPipeline('user', undefined, { remoteId: 'remote-pipeline' }),
      );
      mockFindInstallReceipt.mockImplementation((family, remoteId) =>
        Promise.resolve(
          family === 'pipelines' && remoteId === 'remote-pipeline'
            ? {
                family: 'pipelines',
                remoteId,
                shareScope: 'organization',
                ownerContext: {
                  kind: 'organization',
                  organizationId: OTHER_ORG_ID,
                },
                hash: 'hash',
                authorizedAt: '2026-05-28T11:00:00.000Z',
              }
            : undefined,
        ),
      );
      const { service } = makeService();

      await expect(createPipeline(service, false)).resolves.toEqual({
        ok: false,
        error: backgroundExecutionDeniedMessage('context-mismatch'),
      });
      expect(mockFindInstallReceipt).toHaveBeenCalledWith(
        'pipelines',
        'remote-pipeline',
      );
    });

    it('refuses a stored pipeline step it cannot verify on save', async (): Promise<void> => {
      mockBackgroundContext = 'personal';
      mockedGetStoredPipelineBySource.mockReturnValue(
        storedPipeline(
          'user',
          { type: 'organization', id: ORG_ID, name: 'Acme' },
          { uses: 'plugin/action' },
        ),
      );
      const { service } = makeService();

      const result = await createPipeline(service, false);

      expect(result).toEqual({
        ok: false,
        error: backgroundExecutionDeniedMessage('unknown-provenance'),
      });
      expect((await service.list()).activities).toEqual([]);
    });

    // Turning it on and each run check again.
    it('saves when the check cannot complete', async (): Promise<void> => {
      mockBackgroundContext = `org:${OTHER_ORG_ID}`;
      mockedGetStoredPipelineBySource.mockReturnValue(
        storedPipeline('user', {
          type: 'organization',
          id: OTHER_ORG_ID,
          name: 'Globex',
        }),
      );
      mockBackgroundDecide.mockResolvedValue({
        allow: false,
        reason: 'unknown-provenance',
        transient: true,
      });
      const { service } = makeService();

      await expect(createPipeline(service, false)).resolves.toMatchObject({
        ok: true,
      });
    });

    // Install receipts are read the same way when it runs.
    it('refuses a run of an installed copy another organization owns', async (): Promise<void> => {
      mockedGetStoredPipelineBySource.mockReturnValue(
        storedPipeline('user', undefined, { remoteId: 'remote-pipeline' }),
      );
      mockFindInstallReceipt.mockImplementation((family, remoteId) =>
        Promise.resolve(
          family === 'pipelines' && remoteId === 'remote-pipeline'
            ? {
                family: 'pipelines',
                remoteId,
                shareScope: 'organization',
                ownerContext: {
                  kind: 'organization',
                  organizationId: OTHER_ORG_ID,
                },
                hash: 'hash',
                authorizedAt: '2026-05-28T11:00:00.000Z',
              }
            : undefined,
        ),
      );
      await writeAutomationFile({
        version: 1,
        activities: [
          activity({
            executionContext: `org:${ORG_ID}`,
            action: {
              type: 'worktree_pipeline',
              workspaceId: 'org-project',
              pipelineId: 'stored-pipeline',
              pipelineSource: 'user',
            },
          }),
        ],
        recentRuns: [],
      });
      const { service } = makeService();

      await service.runNow({ id: 'activity-1' });

      expect(mockedStartPipelineExecutionFromMain).not.toHaveBeenCalled();
      expect(mockFindInstallReceipt).toHaveBeenCalledWith(
        'pipelines',
        'remote-pipeline',
      );
      expect((await service.list()).activities[0]).toMatchObject({
        enabled: false,
        lastResult: {
          status: 'failure',
          message: messageContaining(
            'This is in a different Personal or organization context',
          ),
        },
      });
    });

    // A Personal project linked to org A runs in either context, so one that
    // stays on keeps the binding it was turned on with.
    it.each([
      ['personal', `org:${ORG_ID}`, false],
      [`org:${ORG_ID}`, 'personal', true],
    ])(
      'checks an edit to an automation bound to %s from %s in its saved context',
      async (savedContext, selectedContext, allowed): Promise<void> => {
        mockedReadAllSidebarItems.mockResolvedValue({
          version: 1,
          items: [
            {
              type: 'single-repo',
              id: 'linked-project',
              name: 'linked-project',
              repoPath: '/repo',
              color: 'blue',
              collapsed: false,
              order: 0,
              worktrees: [],
            },
          ],
        });
        mockReadBackgroundWorkspace.mockResolvedValue(backgroundWorkspace());
        mockResolveWorkspaceTarget.mockImplementation((projectId, options) =>
          Promise.resolve({
            workspaceOwner: options?.workspaceOwner ?? { kind: 'personal' },
            linkedOrganizationIds:
              projectId === 'linked-project' &&
              options?.organizationId === ORG_ID
                ? [ORG_ID]
                : [],
          }),
        );
        mockedGetStoredPipelineBySource.mockReturnValue(storedPipeline('user'));
        await writeAutomationFile({
          version: 1,
          activities: [
            activity({
              executionContext: savedContext,
              schedule: {
                kind: 'cron',
                expression: '0 2 * * *',
                timezone: 'local',
              },
              action: {
                type: 'worktree_pipeline',
                workspaceId: 'linked-project',
                pipelineId: 'stored-pipeline',
                pipelineSource: 'user',
              },
            }),
          ],
          recentRuns: [],
        });
        mockBackgroundContext = selectedContext;
        mockedGetStoredPipelineBySource.mockReturnValue(
          storedPipeline('user', {
            type: 'organization',
            id: ORG_ID,
            name: 'Acme',
          }),
        );
        const { service } = makeService();

        const result = await service.update({
          id: 'activity-1',
          action: {
            type: 'worktree_pipeline',
            workspaceId: 'linked-project',
            pipelineId: 'stored-pipeline',
            pipelineSource: 'user',
            pipelineName: 'Acme pipeline',
          },
        });

        expect(result).toEqual(
          allowed
            ? expect.objectContaining({ ok: true })
            : {
                ok: false,
                error: backgroundExecutionDeniedMessage('context-mismatch'),
              },
        );
        expect((await service.list()).activities[0]?.executionContext).toBe(
          savedContext,
        );
      },
    );

    // The target is left to turning it on and each run (#4912).
    it("saves a turned-off automation on an organization the account isn't in", async (): Promise<void> => {
      mockBackgroundContext = 'personal';
      mockOrganizations = [
        { id: OTHER_ORG_ID, name: 'Globex', role: 'MEMBER' },
      ];
      mockedGetStoredPipelineBySource.mockReturnValue(storedPipeline('user'));
      const { service } = makeService();

      await expect(createPipeline(service, false)).resolves.toMatchObject({
        ok: true,
        activity: { enabled: false },
      });
    });
  });

  it.each(['private', 'team', 'organization'] as const)(
    'keeps a locally authored automation runnable after sharing it with %s scope',
    async (shareScope): Promise<void> => {
      mockFeatureFlagValues.set(
        CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
        true,
      );
      mockBackgroundDecide.mockImplementation((input) =>
        Promise.resolve(decideResourceContext(input, { strict: true })),
      );
      await writeAutomationFile({
        version: 1,
        activities: [
          activity({
            executionContext: 'personal',
            action: {
              type: 'worktree_session_prompt',
              workspaceId: 'cowork-1',
              worktreeId: 'entry-1',
              chatId: 'chat-1',
              prompt: 'Continue',
            },
            // Author-side link only: this device published the activity.
            remote: {
              remoteId: 'remote-authored',
              contentHash: 'a'.repeat(64),
              shareScope,
              sharedAt: '2026-05-28T11:00:00.000Z',
            },
          }),
        ],
        recentRuns: [],
      });
      const { service } = makeService();
      const result = await service.runNow({ id: 'activity-1' });
      expect(result.run).toMatchObject({ status: 'success' });
      expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
      expect(
        mockBackgroundDecide.mock.calls.map(([input]) => input.resource.owner),
      ).toContainEqual({ shareScope: 'private' });
      expect((await service.list()).activities[0]).toMatchObject({
        enabled: true,
      });
    },
  );

  // The chat inherits its project's defaults live, so a default added after
  // the chat was created is in no saved selection, yet the turn runs it.
  describe('project defaults a session-prompt chat inherits', () => {
    const inherited = {
      marketplaceId: 'market',
      pluginName: 'project-default',
    };

    async function addProjectDefaultAfterChatCreated(
      owner: ResourceOwner,
    ): Promise<AutomationsService> {
      mockFeatureFlagValues.set(
        CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
        true,
      );
      mockBackgroundDecide.mockImplementation((input) =>
        Promise.resolve(decideResourceContext(input, { strict: true })),
      );
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([targetChatTab({ inheritedPluginDefaultsVersion: 1 })]),
      );
      mockReadProjectPluginDefaults.mockResolvedValue({
        defaultPluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [inherited],
          mcpServerRefs: [],
        },
      });
      const plugin: PluginInfo = {
        owner,
        name: inherited.pluginName,
        sourcePath: '/plugins/market/project-default',
        marketplaceId: inherited.marketplaceId,
        providerSupport: { claude: 'native', codex: 'none' },
        facets: {},
      };
      const marketplace: MarketplaceInfo = {
        id: inherited.marketplaceId,
        name: 'Market',
        sourceType: 'github',
        sourceUrl: 'https://github.com/acme/market',
        installLocation: '/plugins/market',
        pluginCount: 1,
        plugins: [plugin],
        providerStatus: {
          claude: {
            provider: 'claude',
            state: 'valid',
            accepted: true,
            pluginCount: 1,
            lastCheckedAt: '2026-05-28T11:00:00.000Z',
          },
          codex: {
            provider: 'codex',
            state: 'invalid',
            accepted: false,
            pluginCount: 0,
            lastCheckedAt: '2026-05-28T11:00:00.000Z',
          },
        },
        validProviders: ['claude'],
      };
      mockLoadMarketplaces.mockResolvedValue({
        success: true,
        data: {
          version: 2,
          lastRefreshed: '2026-05-28T11:00:00.000Z',
          marketplaces: [marketplace],
        },
      });
      await writeAutomationFile({
        version: 1,
        activities: [
          activity({
            executionContext: 'personal',
            action: {
              type: 'worktree_session_prompt',
              workspaceId: 'workspace-1',
              worktreeId: 'worktree-1',
              chatId: 'chat-1',
              prompt: 'Continue',
            },
          }),
        ],
        recentRuns: [],
      });
      return makeService().service;
    }

    it('authorizes a project default added after the chat was created', async (): Promise<void> => {
      const service = await addProjectDefaultAfterChatCreated({
        type: 'system',
      });

      const result = await service.runNow({ id: 'activity-1' });

      expect(result.run).toMatchObject({ status: 'success' });
      expect(
        mockBackgroundDecide.mock.calls.map(([input]) => input.resource.owner),
      ).toContainEqual({ type: 'system' });
      expect(mockReadProjectPluginDefaults).toHaveBeenCalledWith('workspace-1');
      expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
    });

    it('fails closed when that default is not authorized in the bound context', async (): Promise<void> => {
      const service = await addProjectDefaultAfterChatCreated({
        type: 'organization',
        id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        name: 'Globex',
      });

      const result = await service.runNow({ id: 'activity-1' });

      expect(result.run).toMatchObject({ status: 'failure' });
      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
      expect((await service.list()).activities[0]?.enabled).toBe(false);
    });
  });

  it('still denies an installed automation without verifiable provenance', async (): Promise<void> => {
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    mockBackgroundDecide.mockImplementation((input) =>
      Promise.resolve(decideResourceContext(input, { strict: true })),
    );
    await writeAutomationFile({
      version: 1,
      activities: [
        activity({
          executionContext: 'personal',
          action: {
            type: 'worktree_session_prompt',
            workspaceId: 'cowork-1',
            worktreeId: 'entry-1',
            chatId: 'chat-1',
            prompt: 'Continue',
          },
          installedFrom: {
            remoteId: 'remote-installed',
            contentHash: 'b'.repeat(64),
            installedAt: '2026-05-28T11:00:00.000Z',
          },
          // A re-share of an installed copy must not launder its provenance.
          remote: {
            remoteId: 'remote-reshared',
            contentHash: 'c'.repeat(64),
            shareScope: 'private',
            sharedAt: '2026-05-28T11:30:00.000Z',
          },
        }),
      ],
      recentRuns: [],
    });
    const { service } = makeService();
    const result = await service.runNow({ id: 'activity-1' });
    // Denied until a receipt is recorded, but not disabled: the foreground
    // read that records it may not have happened yet.
    expect(result.run).toMatchObject({
      status: 'failure',
      error: backgroundExecutionUnavailableMessage(),
    });
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
    expect((await service.list()).activities[0]).toMatchObject({
      enabled: true,
    });
  });

  describe('installed automation provenance', () => {
    const orgId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const orgContext = `org:${orgId}`;
    const coworkPrompt: AutomationAction = {
      type: 'worktree_session_prompt',
      workspaceId: 'cowork-1',
      worktreeId: 'entry-1',
      chatId: 'chat-1',
      prompt: 'Continue',
    };
    const publicInstall = {
      remoteId: 'public-share-1',
      contentHash: 'b'.repeat(64),
      installedAt: '2026-05-28T11:00:00.000Z',
      sourceKind: 'public' as const,
    };

    function enableStrictPolicy({ foreground = true } = {}): void {
      mockFeatureFlagValues.set(
        CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
        true,
      );
      // Like the policy service, resolve background runs in their bound context.
      mockBackgroundDecide.mockImplementation((input) =>
        Promise.resolve(
          decideResourceContext(
            {
              ...input,
              invocation: {
                ...input.invocation,
                context: input.invocation.executionContext?.startsWith('org:')
                  ? {
                      kind: 'organization',
                      organizationId:
                        input.invocation.executionContext.slice(4),
                    }
                  : { kind: 'personal' },
              },
            },
            { strict: true },
          ),
        ),
      );
      if (foreground)
        mockResourceDecide.mockImplementation((input) =>
          Promise.resolve(decideResourceContext(input, { strict: true })),
        );
    }

    it('runs a team or organization install whose receipt and current share owner match the bound context', async (): Promise<void> => {
      // Foreground reads are covered elsewhere; this pins the background gate.
      enableStrictPolicy({ foreground: false });
      mockBackgroundContext = orgContext;
      mockReadBackgroundWorkspace.mockResolvedValue(backgroundWorkspace(orgId));
      mockFindResourceOrigin.mockResolvedValue({
        accountId: 'user',
        receipt: {
          family: 'automations',
          remoteId: 'remote-installed',
          localResourceIds: ['activity-1'],
          shareScope: 'organization',
          ownerContext: { kind: 'organization', organizationId: orgId },
          hash: 'b'.repeat(64),
          authorizedAt: '2026-05-28T11:00:00.000Z',
        },
      });
      mockCloudJson.mockResolvedValue({
        owner: { type: 'organization', id: orgId, name: 'Org' },
      });
      await writeAutomationFile({
        version: 1,
        activities: [
          activity({
            executionContext: orgContext,
            action: coworkPrompt,
            installedFrom: {
              remoteId: 'remote-installed',
              contentHash: 'b'.repeat(64),
              installedAt: '2026-05-28T11:00:00.000Z',
            },
          }),
        ],
        recentRuns: [],
      });
      const { service } = makeService();
      const result = await service.runNow({ id: 'activity-1' });
      expect(result.run).toMatchObject({ status: 'success' });
      expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
      expect(mockedSendWorktreeChatMessage.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({ executionContext: orgContext }),
      );
      expect(String(mockCloudJson.mock.calls[0]?.[0])).toMatch(
        /\/automations\/remote-installed$/,
      );
    });

    it('keeps an installed automation enabled when its access check cannot reach the cloud', async (): Promise<void> => {
      enableStrictPolicy({ foreground: false });
      mockBackgroundContext = orgContext;
      mockReadBackgroundWorkspace.mockResolvedValue(backgroundWorkspace(orgId));
      mockFindResourceOrigin.mockResolvedValue({
        accountId: 'user',
        receipt: {
          family: 'automations',
          remoteId: 'remote-installed',
          localResourceIds: ['activity-1'],
          shareScope: 'organization',
          ownerContext: { kind: 'organization', organizationId: orgId },
          hash: 'b'.repeat(64),
          authorizedAt: '2026-05-28T11:00:00.000Z',
        },
      });
      mockCloudJson.mockRejectedValue(
        new CanopyCloudClientError('network-error', 'offline'),
      );
      await writeAutomationFile({
        version: 1,
        activities: [
          activity({
            executionContext: orgContext,
            schedule: {
              kind: 'cron',
              expression: '0 * * * *',
              timezone: 'local',
            },
            action: coworkPrompt,
            installedFrom: {
              remoteId: 'remote-installed',
              contentHash: 'b'.repeat(64),
              installedAt: '2026-05-28T11:00:00.000Z',
            },
          }),
        ],
        recentRuns: [],
      });
      const { service } = makeService();
      const failed = await service.runNow({ id: 'activity-1' });
      expect(failed.run).toMatchObject({
        status: 'failure',
        error: backgroundExecutionUnavailableMessage(),
      });
      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
      const [stored] = (await service.list()).activities;
      expect(stored).toMatchObject({ enabled: true });
      expect(stored?.nextRunAt).toBeDefined();

      mockCloudJson.mockResolvedValue({
        owner: { type: 'organization', id: orgId, name: 'Org' },
      });
      const recovered = await service.runNow({ id: 'activity-1' });
      expect(recovered.run).toMatchObject({ status: 'success' });
    });

    it('records the context in scope when a public share is installed and runs in it', async (): Promise<void> => {
      enableStrictPolicy();
      mockBackgroundContext = orgContext;
      mockReadBackgroundWorkspace.mockResolvedValue(backgroundWorkspace(orgId));
      const { service } = makeService();
      const created = await service.create({
        name: 'Public install',
        enabled: false,
        schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
        action: coworkPrompt,
        installedFrom: publicInstall,
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      expect(created.activity.publicInstallContext).toBe(orgContext);
      await service.update({ id: created.activity.id, enabled: true });
      const result = await service.runNow({ id: created.activity.id });
      expect(result.run).toMatchObject({ status: 'success' });
      expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
    });

    it('refuses creating an enabled public install whose install context does not own its target', async (): Promise<void> => {
      enableStrictPolicy();
      mockBackgroundContext = orgContext;
      mockReadBackgroundWorkspace.mockResolvedValue(backgroundWorkspace());
      const { service } = makeService();
      const result = await service.create({
        name: 'Public install',
        schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
        action: coworkPrompt,
        installedFrom: publicInstall,
      });
      expect(result.ok).toBe(false);
      expect((await service.list()).activities).toEqual([]);
    });

    it('refuses turning on an automation as a public install whose install context does not own its target', async (): Promise<void> => {
      enableStrictPolicy();
      mockBackgroundContext = orgContext;
      mockReadBackgroundWorkspace.mockResolvedValue(backgroundWorkspace());
      await writeAutomationFile({
        version: 1,
        activities: [activity({ enabled: false, action: coworkPrompt })],
        recentRuns: [],
      });
      const { service } = makeService();
      const result = await service.update({
        id: 'activity-1',
        enabled: true,
        installedFrom: publicInstall,
      });
      expect(result.ok).toBe(false);
      const [stored] = (await service.list()).activities;
      expect(stored?.enabled).toBe(false);
      expect(stored?.installedFrom).toBeUndefined();
    });

    it('treats a curated install as context-owned without resolving a team share', async (): Promise<void> => {
      enableStrictPolicy();
      mockBackgroundContext = orgContext;
      mockReadBackgroundWorkspace.mockResolvedValue(backgroundWorkspace(orgId));
      const { service } = makeService();
      const created = await service.create({
        name: 'Curated install',
        enabled: false,
        schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
        action: coworkPrompt,
        installedFrom: {
          ...publicInstall,
          remoteId: 'daily-review',
          sourceKind: 'curated',
        },
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      expect(created.activity.publicInstallContext).toBe(orgContext);
      expect(mockGetSharedAutomation).not.toHaveBeenCalled();
      await service.update({ id: created.activity.id, enabled: true });
      expect(mockGetSharedAutomation).not.toHaveBeenCalled();
    });

    it('denies a public install from an organization context in a Personal-bound run', async (): Promise<void> => {
      enableStrictPolicy();
      mockBackgroundContext = orgContext;
      await writeAutomationFile({
        version: 1,
        activities: [
          activity({
            executionContext: 'personal',
            action: coworkPrompt,
            installedFrom: publicInstall,
            publicInstallContext: orgContext,
          }),
        ],
        recentRuns: [],
      });
      const { service } = makeService();
      const result = await service.runNow({ id: 'activity-1' });
      expect(result.run).toMatchObject({
        status: 'failure',
        error: backgroundExecutionDeniedMessage('context-mismatch', {
          turnedOff: true,
        }),
      });
      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
    });

    it.each([
      { label: 'a Personal install context', publicInstallContext: 'personal' },
      { label: 'no recorded install context', publicInstallContext: undefined },
    ])(
      'runs a public install with $label as Personal',
      async ({ publicInstallContext }): Promise<void> => {
        enableStrictPolicy();
        await writeAutomationFile({
          version: 1,
          activities: [
            activity({
              executionContext: 'personal',
              action: coworkPrompt,
              installedFrom: publicInstall,
              ...(publicInstallContext ? { publicInstallContext } : {}),
            }),
          ],
          recentRuns: [],
        });
        const { service } = makeService();
        const result = await service.runNow({ id: 'activity-1' });
        expect(result.run).toMatchObject({ status: 'success' });
        expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
      },
    );

    it('lists a public install only in the context it was installed in', async (): Promise<void> => {
      enableStrictPolicy();
      await writeAutomationFile({
        version: 1,
        activities: [
          activity({
            installedFrom: publicInstall,
            publicInstallContext: orgContext,
          }),
        ],
        recentRuns: [],
      });
      const { service } = makeService();
      mockBackgroundContext = 'personal';
      expect((await service.list()).activities).toHaveLength(0);
      mockBackgroundContext = orgContext;
      expect((await service.list()).activities).toHaveLength(1);
    });

    it('leaves an automation unchanged when its install context cannot be captured', async (): Promise<void> => {
      enableStrictPolicy();
      await writeAutomationFile({
        version: 1,
        activities: [
          activity({
            enabled: false,
            installedFrom: publicInstall,
            publicInstallContext: 'personal',
          }),
        ],
        recentRuns: [],
      });
      const { service } = makeService();
      await service.list();
      const initialize = mockWorkspaceContextService.initialize;
      mockWorkspaceContextService.initialize = (): Promise<void> =>
        Promise.reject(new Error('context unavailable'));
      try {
        await expect(
          service.update({
            id: 'activity-1',
            installedFrom: { ...publicInstall, remoteId: 'public-share-2' },
          }),
        ).rejects.toThrow('context unavailable');
      } finally {
        mockWorkspaceContextService.initialize = initialize;
      }
      expect((await service.list()).activities[0]).toMatchObject({
        installedFrom: { remoteId: 'public-share-1' },
        publicInstallContext: 'personal',
      });
    });

    it('keeps the install context for the same public share and recaptures it for another', async (): Promise<void> => {
      enableStrictPolicy();
      await writeAutomationFile({
        version: 1,
        activities: [
          activity({
            enabled: false,
            installedFrom: publicInstall,
            publicInstallContext: 'personal',
          }),
        ],
        recentRuns: [],
      });
      const { service } = makeService();
      mockBackgroundContext = orgContext;
      const same = await service.update({
        id: 'activity-1',
        installedFrom: { ...publicInstall, contentHash: 'c'.repeat(64) },
      });
      if (!same.ok || !same.activity) throw new Error('update failed');
      expect(same.activity.publicInstallContext).toBe('personal');
      const other = await service.update({
        id: 'activity-1',
        installedFrom: { ...publicInstall, remoteId: 'public-share-2' },
      });
      if (!other.ok || !other.activity) throw new Error('update failed');
      expect(other.activity.publicInstallContext).toBe(orgContext);
    });
  });

  describe('explicit owner and agent marker on create', () => {
    const ORG_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const OTHER_ORG_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const AUTHOR = {
      chat: { projectId: 'project-1', worktreeId: 'task-1', chatId: 'chat-1' },
      recordedAt: '2026-10-19T00:00:00.000Z',
    };
    const request: AutomationCreateRequest = {
      name: 'Owned automation',
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: appAdvisorAction(),
      enabled: false,
    };

    function setOrgProjects(enabled: boolean): void {
      mockFeatureFlagValues.set(
        CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
        enabled,
      );
    }

    beforeEach((): void => {
      setOrgProjects(true);
      mockBackgroundContext = 'personal';
      mockOrganizations = [{ id: ORG_ID, name: 'Acme', role: 'MEMBER' }];
    });

    it('binds an explicit organization the account is in', async (): Promise<void> => {
      const { service } = makeService();
      await expect(
        service.create({ ...request, executionContext: `org:${ORG_ID}` }),
      ).resolves.toMatchObject({
        ok: true,
        activity: { executionContext: `org:${ORG_ID}` },
      });
    });

    it('rebinds a disabled automation to the selected context when it is turned on', async (): Promise<void> => {
      const { service } = makeService();
      const created = await service.create({
        ...request,
        executionContext: `org:${ORG_ID}`,
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      expect(created.activity.executionContext).toBe(`org:${ORG_ID}`);

      // Plan decision 6: enable-time rebinding is unchanged, so a create-time
      // owner is provisional until the first enable.
      mockBackgroundContext = 'personal';
      await expect(
        service.update({ id: created.activity.id, enabled: true }),
      ).resolves.toMatchObject({
        ok: true,
        activity: { enabled: true, executionContext: 'personal' },
      });
    });

    it.each([
      ['an unparsable owner', 'not-a-context'],
      ['an organization the account is not in', `org:${OTHER_ORG_ID}`],
    ])('refuses %s', async (_label, executionContext): Promise<void> => {
      const { service } = makeService();
      await expect(
        service.create({ ...request, executionContext }),
      ).resolves.toMatchObject({ ok: false });
      expect((await service.list()).activities).toHaveLength(0);
    });

    it('refuses an explicit organization and ignores Personal with the flag off', async (): Promise<void> => {
      setOrgProjects(false);
      const { service } = makeService();
      await expect(
        service.create({ ...request, executionContext: `org:${ORG_ID}` }),
      ).resolves.toMatchObject({ ok: false });
      const personal = await service.create({
        ...request,
        executionContext: 'personal',
      });
      if (!personal.ok || !personal.activity) throw new Error('create failed');
      expect(personal.activity).not.toHaveProperty('executionContext');
    });

    it('records the agent marker only from the trusted argument', async (): Promise<void> => {
      const { service } = makeService();
      const fromBody = await service.create({
        ...request,
        ...{ agentAuthor: AUTHOR },
      });
      if (!fromBody.ok || !fromBody.activity) throw new Error('create failed');
      expect(fromBody.activity).not.toHaveProperty('agentAuthor');

      const created = await service.create(request, { agentAuthor: AUTHOR });
      if (!created.ok || !created.activity) throw new Error('create failed');
      expect(created.activity.agentAuthor).toEqual(AUTHOR);

      const renamed = await service.update({
        id: created.activity.id,
        name: 'Renamed by the scheduler',
      });
      expect(renamed).toMatchObject({ activity: { agentAuthor: AUTHOR } });

      const userEdit = await service.update(
        { id: created.activity.id, name: 'Renamed by a person' },
        undefined,
        undefined,
        { agentAuthor: null },
      );
      if (!userEdit.ok || !userEdit.activity) throw new Error('update failed');
      expect(userEdit.activity).not.toHaveProperty('agentAuthor');
    });

    it.each([
      [
        'a partial chat address',
        { chat: { projectId: 'p' }, recordedAt: 'now' },
      ],
      ['an empty recordedAt', { chat: AUTHOR.chat, recordedAt: '' }],
    ])(
      'drops a malformed persisted marker (%s) and keeps the automation',
      async (_label, malformed): Promise<void> => {
        const { service } = makeService();
        const created = await service.create(request, { agentAuthor: AUTHOR });
        if (!created.ok || !created.activity) throw new Error('create failed');
        const file: unknown = JSON.parse(
          await readFile(automationsFilePath, 'utf8'),
        );
        if (
          typeof file !== 'object' ||
          file === null ||
          !('activities' in file) ||
          !Array.isArray(file.activities)
        )
          throw new Error('Unexpected automations file');
        await writeFile(
          automationsFilePath,
          JSON.stringify({
            ...file,
            activities: file.activities.map((activity: unknown) => ({
              ...(typeof activity === 'object' && activity !== null
                ? activity
                : {}),
              agentAuthor: malformed,
            })),
          }),
        );

        const { service: reloaded } = makeService();
        const { activities } = await reloaded.list();
        expect(activities).toHaveLength(1);
        expect(activities[0]).not.toHaveProperty('agentAuthor');
      },
    );
  });

  it('binds a disabled automation only while organization projects are on', async (): Promise<void> => {
    const { service } = makeService();
    const request: AutomationCreateRequest = {
      name: 'Unbound automation',
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: appAdvisorAction(),
    };
    const legacy = await service.create(request);
    expect(legacy).toMatchObject({ ok: true });
    if (!legacy.ok || !legacy.activity) throw new Error('create failed');
    expect(legacy.activity).not.toHaveProperty('executionContext');
    await service.runNow({ id: legacy.activity.id });
    expect(mockBackgroundDecide).not.toHaveBeenCalled();
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    const disabled = await service.create({ ...request, enabled: false });
    if (!disabled.ok || !disabled.activity) throw new Error('create failed');
    expect(disabled.activity.executionContext).toBe(mockBackgroundContext);
  });

  it('captures execution context only when created enabled or re-enabled', async (): Promise<void> => {
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    mockBackgroundContext = 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const { service } = makeService();
    const created = await service.create({
      name: 'Bound automation',
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: appAdvisorAction(),
    });
    expect(created).toMatchObject({
      ok: true,
      activity: { executionContext: mockBackgroundContext },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');
    mockBackgroundContext = 'personal';
    await service.start();
    expect((await service.list()).activities[0]?.executionContext).toBe(
      'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    );
    expect(
      await service.update({ id: created.activity.id, name: 'Renamed' }),
    ).toMatchObject({
      activity: {
        executionContext: 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      },
    });
    await service.update({ id: created.activity.id, enabled: false });
    expect(
      await service.update({ id: created.activity.id, enabled: true }),
    ).toMatchObject({
      activity: { executionContext: 'personal' },
    });
    const persisted: unknown = JSON.parse(
      await readFile(automationsFilePath, 'utf8'),
    );
    expect(persisted).toMatchObject({
      activities: [expect.objectContaining({ executionContext: 'personal' })],
    });
  });

  it('rebinds only automations targeting the moved workspace', async (): Promise<void> => {
    await writeAutomationFile({
      version: 1,
      activities: [
        activity({
          id: 'moved-personal',
          executionContext: 'personal',
          action: {
            type: 'worktree_prompt',
            workspaceId: 'workspace-1',
            prompt: 'One',
          },
        }),
        activity({
          id: 'moved-unbound',
          executionContext: undefined,
          action: {
            type: 'worktree_pipeline',
            workspaceId: 'workspace-1',
            pipelineId: 'review',
          },
        }),
        activity({
          id: 'unrelated',
          executionContext: 'personal',
          action: {
            type: 'worktree_prompt',
            workspaceId: 'workspace-2',
            prompt: 'Two',
          },
        }),
      ],
      recentRuns: [],
    });
    const { service } = makeService();

    await expect(
      service.rebindWorkspaceExecutionContexts({
        workspaceId: 'workspace-1',
        previousContext: 'personal',
        nextContext: 'org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
    ).resolves.toEqual(['moved-personal', 'moved-unbound']);

    expect((await service.list()).activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'moved-personal',
          executionContext: 'org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        }),
        expect.objectContaining({
          id: 'moved-unbound',
          executionContext: 'org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        }),
        expect.objectContaining({
          id: 'unrelated',
          executionContext: 'personal',
        }),
      ]),
    );
  });

  it('validates background capabilities before turning an automation on', async (): Promise<void> => {
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    await writeAutomationFile({
      version: 1,
      activities: [
        activity({
          enabled: false,
          action: {
            type: 'worktree_prompt',
            workspaceId: 'workspace-1',
            prompt: 'Review',
            pluginSelections: {
              collectionIds: ['restricted'],
              skillRefs: [],
              pluginRefs: [],
            },
          },
        }),
      ],
      recentRuns: [],
    });
    mockBackgroundDecide.mockResolvedValueOnce({
      allow: false,
      reason: 'access-removed',
    });
    const { service } = makeService();

    await expect(
      service.update({ id: 'activity-1', enabled: true }),
    ).resolves.toEqual({
      ok: false,
      error: 'You no longer have access to something this uses.',
    });
    expect((await service.list()).activities[0]).toMatchObject({
      enabled: false,
    });
  });

  it('turns an automation on when its capabilities cannot be checked right now', async (): Promise<void> => {
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    await writeAutomationFile({
      version: 1,
      activities: [
        activity({
          enabled: false,
          action: {
            type: 'worktree_prompt',
            workspaceId: 'workspace-1',
            prompt: 'Review',
            pluginSelections: {
              collectionIds: ['restricted'],
              skillRefs: [],
              pluginRefs: [],
            },
          },
        }),
      ],
      recentRuns: [],
    });
    mockBackgroundDecide.mockResolvedValueOnce({
      allow: false,
      reason: 'unknown-provenance',
      transient: true,
    });
    const { service } = makeService();

    await expect(
      service.update({ id: 'activity-1', enabled: true }),
    ).resolves.toMatchObject({ ok: true });
    expect((await service.list()).activities[0]).toMatchObject({
      enabled: true,
    });
  });

  it('logs a refused enable with the activity id and reason', async (): Promise<void> => {
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    await writeAutomationFile({
      version: 1,
      activities: [
        activity({
          enabled: false,
          action: {
            type: 'worktree_prompt',
            workspaceId: 'workspace-1',
            prompt: 'Review',
            pluginSelections: {
              collectionIds: ['restricted'],
              skillRefs: [],
              pluginRefs: [],
            },
          },
        }),
      ],
      recentRuns: [],
    });
    mockBackgroundDecide.mockResolvedValueOnce({
      allow: false,
      reason: 'access-removed',
    });
    const { service } = makeService();
    mockedLogMainProcessError.mockClear();

    await expect(
      service.update({ id: 'activity-1', enabled: true }),
    ).resolves.toMatchObject({ ok: false });

    const refusalLogs = mockedLogMainProcessError.mock.calls.filter(
      ([message]) => message === 'Automation enable refused',
    );
    expect(refusalLogs).toEqual([
      [
        'Automation enable refused',
        expect.objectContaining({
          activityId: 'activity-1',
          refusal: 'You no longer have access to something this uses.',
        }),
      ],
    ]);
    expect((await service.list()).activities[0]).toMatchObject({
      enabled: false,
    });
  });

  it('does not log when an automation turns on', async (): Promise<void> => {
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    await writeAutomationFile({
      version: 1,
      activities: [
        activity({
          enabled: false,
          action: {
            type: 'worktree_prompt',
            workspaceId: 'workspace-1',
            prompt: 'Review',
            pluginSelections: {
              collectionIds: ['restricted'],
              skillRefs: [],
              pluginRefs: [],
            },
          },
        }),
      ],
      recentRuns: [],
    });
    mockBackgroundDecide.mockResolvedValueOnce({
      allow: false,
      reason: 'unknown-provenance',
      transient: true,
    });
    const { service } = makeService();
    mockedLogMainProcessError.mockClear();

    await expect(
      service.update({ id: 'activity-1', enabled: true }),
    ).resolves.toMatchObject({ ok: true });
    expect(mockedLogMainProcessError).not.toHaveBeenCalledWith(
      'Automation enable refused',
      expect.anything(),
    );
  });

  it('does not log a refusal that is not an enable request', async (): Promise<void> => {
    const { service } = makeService();
    const created = await service.create({
      name: 'Chats',
      enabled: false,
      schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
      action: {
        type: 'standalone_prompt',
        chatProjectId: 'cowork-1',
        prompt: 'Run',
      },
      targetRequirement: { contexts: ['cowork'] },
    });
    if (!created.ok || !created.activity)
      throw new Error(JSON.stringify(created));
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items: [] });
    mockedLogMainProcessError.mockClear();

    await expect(
      service.update({
        id: created.activity.id,
        targetRequirement: { contexts: ['cowork'] },
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(mockedLogMainProcessError).not.toHaveBeenCalledWith(
      'Automation enable refused',
      expect.anything(),
    );
  });

  it('logs a target refusal when turning an automation on', async (): Promise<void> => {
    const { service } = makeService();
    const created = await service.create({
      name: 'Chats',
      enabled: false,
      schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
      action: {
        type: 'standalone_prompt',
        chatProjectId: 'cowork-1',
        prompt: 'Run',
      },
      targetRequirement: { contexts: ['cowork'] },
    });
    if (!created.ok || !created.activity)
      throw new Error(JSON.stringify(created));
    const id = created.activity.id;
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items: [] });
    mockedLogMainProcessError.mockClear();

    const refused = await service.update({ id, enabled: true });
    if (refused.ok) throw new Error('expected the enable to be refused');
    expect(
      mockedLogMainProcessError.mock.calls.filter(
        ([message]) => message === 'Automation enable refused',
      ),
    ).toEqual([
      ['Automation enable refused', { activityId: id, refusal: refused.error }],
    ]);
  });

  it('hides and blocks an installed organization automation in another context', async (): Promise<void> => {
    const { service } = makeService();
    const created = await service.create({
      name: 'Organization automation',
      enabled: false,
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: appAdvisorAction(),
    });
    if (!created.ok || !created.activity) throw new Error('create failed');
    const previousRun = await service.runNow({ id: created.activity.id });
    if (!previousRun.ok || !previousRun.run) throw new Error('run failed');
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    mockResourceDecide.mockResolvedValue({
      allow: false,
      reason: 'context-mismatch',
    });
    mockFindResourceOrigin.mockResolvedValue({
      accountId: 'user',
      receipt: {
        family: 'automations',
        remoteId: 'remote-a',
        ownerContext: { kind: 'organization', organizationId: 'org-a' },
      },
    });
    expect((await service.list()).activities).toEqual([]);
    await expect(
      service.cancelRun({ runId: previousRun.run.id }),
    ).rejects.toThrow('context-mismatch');
    await expect(
      service.update({ id: created.activity.id, name: 'Edited' }),
    ).rejects.toThrow('context-mismatch');
    await expect(service.runNow({ id: created.activity.id })).rejects.toThrow(
      'context-mismatch',
    );
  });

  it('persists installedFrom provenance through create and update', async () => {
    const { service } = makeService();
    const installedFrom = {
      remoteId: '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111',
      contentHash: 'a'.repeat(64),
      installedAt: '2026-08-20T12:00:00.000Z',
    };
    const created = await service.create({
      name: 'Installed automation',
      schedule: {
        kind: 'cron',
        expression: '0 2 * * *',
        timezone: 'local',
      },
      action: appAdvisorAction(),
      enabled: false,
      installedFrom,
    });
    expect(created.ok).toBe(true);
    if (!created.ok || !created.activity) throw new Error('create failed');
    expect(created.activity.enabled).toBe(false);
    expect(created.activity.installedFrom).toEqual(installedFrom);

    const updated = await service.update({
      id: created.activity.id,
      installedFrom: { ...installedFrom, contentHash: 'b'.repeat(64) },
    });
    expect(updated).toMatchObject({
      ok: true,
      activity: {
        installedFrom: { ...installedFrom, contentHash: 'b'.repeat(64) },
      },
    });

    const fresh = new AutomationsService();
    fresh.configure({
      getMainWindow: () => null,
      ensureAppAdvisorWindow: jest.fn(),
      sendAppAdvisorWindowCommand: jest.fn(),
    });
    expect((await fresh.list()).activities[0]?.installedFrom).toEqual({
      ...installedFrom,
      contentHash: 'b'.repeat(64),
    });
  });

  describe('install subscriptions', () => {
    const mockedRecordInstall = jest.mocked(recordSharedItemInstall);
    const mockedRecordUninstall = jest.mocked(recordSharedItemUninstall);
    const schedule = {
      kind: 'cron' as const,
      expression: '0 2 * * *',
      timezone: 'local' as const,
    };
    const sharedInstall = {
      remoteId: '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111',
      contentHash: 'a'.repeat(64),
      installedAt: '2026-08-20T12:00:00.000Z',
    };

    beforeEach(() => {
      mockedRecordInstall.mockReset();
      mockedRecordUninstall.mockReset();
    });

    it.each([
      ['shared', sharedInstall, 'shared'],
      [
        'public',
        { ...sharedInstall, remoteId: 'public-share-1', sourceKind: 'public' },
        'public',
      ],
    ] as const)(
      'registers a %s install once it is persisted',
      async (_label, installedFrom, sourceKind) => {
        const { service } = makeService();
        const created = await service.create({
          name: 'Installed automation',
          schedule,
          action: appAdvisorAction(),
          enabled: false,
          installedFrom,
        });
        if (!created.ok || !created.activity) throw new Error('create failed');
        expect(mockedRecordInstall).toHaveBeenCalledTimes(1);
        expect(mockedRecordInstall).toHaveBeenCalledWith({
          kind: 'automation',
          remoteId: installedFrom.remoteId,
          sourceKind,
          contentHash: 'a'.repeat(64),
          localId: created.activity.id,
        });
      },
    );

    it('does not register curated or local automations', async () => {
      const { service } = makeService();
      await service.create({
        name: 'Curated',
        schedule,
        action: appAdvisorAction(),
        enabled: false,
        installedFrom: { ...sharedInstall, sourceKind: 'curated' },
      });
      const local = await service.create({
        name: 'Local',
        schedule,
        action: appAdvisorAction(),
        enabled: false,
      });
      if (!local.ok || !local.activity) throw new Error('create failed');
      await service.update({ id: local.activity.id, name: 'Renamed' });
      await service.delete({ id: local.activity.id });
      expect(mockedRecordInstall).not.toHaveBeenCalled();
      expect(mockedRecordUninstall).not.toHaveBeenCalled();
    });

    it('does not register an install whose create is refused', async () => {
      const { service } = makeService();
      const created = await service.create({
        name: '',
        schedule,
        action: appAdvisorAction(),
        installedFrom: sharedInstall,
      });
      expect(created.ok).toBe(false);
      expect(mockedRecordInstall).not.toHaveBeenCalled();
    });

    it('re-registers the new hash when a shared update is applied, but not on a local edit', async () => {
      const { service } = makeService();
      const created = await service.create({
        name: 'Installed automation',
        schedule,
        action: appAdvisorAction(),
        enabled: false,
        installedFrom: sharedInstall,
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      mockedRecordInstall.mockReset();

      await service.update({ id: created.activity.id, name: 'Local edit' });
      expect(mockedRecordInstall).not.toHaveBeenCalled();

      const updated = await service.update({
        id: created.activity.id,
        installedFrom: { ...sharedInstall, contentHash: 'b'.repeat(64) },
      });
      expect(updated.ok).toBe(true);
      expect(mockedRecordInstall).toHaveBeenCalledTimes(1);
      expect(mockedRecordInstall).toHaveBeenCalledWith({
        kind: 'automation',
        remoteId: sharedInstall.remoteId,
        sourceKind: 'shared',
        contentHash: 'b'.repeat(64),
        localId: created.activity.id,
      });
      expect(mockedRecordUninstall).not.toHaveBeenCalled();
    });

    it('unregisters an installed automation when it is deleted', async () => {
      const { service } = makeService();
      const created = await service.create({
        name: 'Installed automation',
        schedule,
        action: appAdvisorAction(),
        enabled: false,
        installedFrom: { ...sharedInstall, sourceKind: 'public' },
      });
      if (!created.ok || !created.activity) throw new Error('create failed');

      await expect(
        service.delete({ id: 'missing-activity' }),
      ).resolves.toMatchObject({ ok: false });
      expect(mockedRecordUninstall).not.toHaveBeenCalled();

      await expect(
        service.delete({ id: created.activity.id }),
      ).resolves.toMatchObject({ ok: true });
      expect(mockedRecordUninstall).toHaveBeenCalledWith({
        kind: 'automation',
        remoteId: sharedInstall.remoteId,
        sourceKind: 'public',
        localId: created.activity.id,
      });
    });

    it('lists every installed automation for the subscription backfill', async () => {
      const { service } = makeService();
      const created = await service.create({
        name: 'Installed automation',
        schedule,
        action: appAdvisorAction(),
        enabled: false,
        installedFrom: sharedInstall,
      });
      await service.create({
        name: 'Local',
        schedule,
        action: appAdvisorAction(),
        enabled: false,
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      const installed =
        await service.listInstalledActivitiesForSubscriptionBackfill();
      expect(installed.map((row) => row.id)).toEqual([created.activity.id]);
    });
  });

  it('writes, persists, and clears shared-Automation remote metadata', async () => {
    const { service, onChange } = makeService();
    const created = await service.create({
      name: 'Shared nightly',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:10:00.000Z',
        timezone: 'local',
      },
      action: appAdvisorAction(),
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    const remote = {
      accountId: 'account-a',
      remoteId: '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111',
      contentHash: 'a'.repeat(64),
      shareScope: 'team' as const,
      sharedAt: '2026-05-28T12:00:00.000Z',
    };
    onChange.mockClear();
    await expect(
      service.setActivityRemoteMetadata(created.activity.id, remote),
    ).resolves.toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect((await service.list()).activities[0]?.remote).toEqual(remote);
    const freshAfterWrite = new AutomationsService();
    freshAfterWrite.configure({
      getMainWindow: () => null,
      ensureAppAdvisorWindow: jest.fn(),
      sendAppAdvisorWindowCommand: jest.fn(),
    });
    expect((await freshAfterWrite.list()).activities[0]?.remote).toEqual(
      remote,
    );

    onChange.mockClear();
    await expect(
      service.setActivityRemoteMetadata('missing-activity', remote),
    ).resolves.toBe(false);
    expect(onChange).not.toHaveBeenCalled();

    onChange.mockClear();
    await expect(
      service.clearActivityRemoteMetadataByRemoteId(remote.remoteId),
    ).resolves.toBe(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    const freshAfterClear = new AutomationsService();
    freshAfterClear.configure({
      getMainWindow: () => null,
      ensureAppAdvisorWindow: jest.fn(),
      sendAppAdvisorWindowCommand: jest.fn(),
    });
    expect(
      (await freshAfterClear.list()).activities[0]?.remote,
    ).toBeUndefined();

    onChange.mockClear();
    await expect(
      service.clearActivityRemoteMetadataByRemoteId(remote.remoteId),
    ).resolves.toBe(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('creates, updates, deletes, persists, and caps recent runs', async () => {
    const { service } = makeService();
    const created = await service.create({
      name: ' Daily prompt ',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:10:00.000Z',
        timezone: 'local',
      },
      action: appAdvisorAction(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok || !created.activity) throw new Error('create failed');

    const updated = await service.update({
      id: created.activity.id,
      name: 'Updated prompt',
      enabled: false,
    });
    expect(updated).toMatchObject({
      ok: true,
      activity: { name: 'Updated prompt', enabled: false },
    });
    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({ ok: true });
    expect(
      (await service.listRuns({ activityId: created.activity.id })).totalCount,
    ).toBe(1);
    const deleted = await service.delete({ id: created.activity.id });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok || !deleted.activity) throw new Error('delete failed');
    expect(deleted.activity.id).toBe(created.activity.id);
    expect(
      (await service.listRuns({ activityId: created.activity.id })).totalCount,
    ).toBe(0);

    await writeAutomationFile({
      version: 1,
      updatedAt: '2026-05-28T12:00:00.000Z',
      activities: [],
      recentRuns: Array.from({ length: 105 }, (_, index) =>
        run({
          id: `run-${index}`,
          startedAt: new Date(Date.now() - index).toISOString(),
        }),
      ),
    });
    const fresh = new AutomationsService();
    fresh.configure({
      getMainWindow: () => null,
      ensureAppAdvisorWindow: jest.fn(),
      sendAppAdvisorWindowCommand: jest.fn(),
    });
    expect((await fresh.list()).recentRuns).toHaveLength(100);

    await writeAutomationFile({
      version: 1,
      updatedAt: '2026-05-28T12:00:00.000Z',
      activities: [],
      recentRuns: [
        run({
          id: 'old-running',
          status: 'running',
          startedAt: '2026-05-27T12:00:00.000Z',
          completedAt: undefined,
        }),
        ...Array.from({ length: 105 }, (_, index) =>
          run({
            id: `terminal-${index}`,
            status: 'success',
            startedAt: new Date(Date.now() - index).toISOString(),
          }),
        ),
      ],
    });
    const withRunning = new AutomationsService();
    withRunning.configure({
      getMainWindow: () => null,
      ensureAppAdvisorWindow: jest.fn(),
      sendAppAdvisorWindowCommand: jest.fn(),
    });
    const recentRuns = (await withRunning.list()).recentRuns;
    expect(recentRuns).toHaveLength(101);
    expect(recentRuns.some((entry) => entry.id === 'old-running')).toBe(true);
  });

  it('rejects enabling an existing target automation during Auto Delete', async () => {
    const { service } = makeService();
    const created = await service.create({
      name: 'Target prompt',
      enabled: false,
      schedule: {
        kind: 'cron',
        expression: '0 2 * * *',
        timezone: 'local',
      },
      action: {
        type: 'worktree_session_prompt',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        prompt: 'Continue',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await withWorkspaceTargetAutoArchiveLease(
      'workspace-1',
      'worktree-1',
      async () => {
        await expect(
          service.update({ id: created.activity.id, enabled: true }),
        ).rejects.toThrow('being automatically deleted');
      },
    );
    resetWorkspaceTargetExclusionsForTests();
  });

  it('holds the target reservation through a manual automation dispatch', async () => {
    let autoArchiveWasExcluded = false;
    mockedSendWorktreeChatMessage.mockImplementationOnce(async () => {
      try {
        await withWorkspaceTargetAutoArchiveLease(
          'workspace-1',
          'worktree-1',
          () => Promise.resolve(),
        );
      } catch {
        autoArchiveWasExcluded = true;
      }
      return { ok: true, chatId: 'chat-1' };
    });
    const { service } = makeService();
    const created = await service.create({
      name: 'Reserved target prompt',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_session_prompt',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        prompt: 'Continue',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await service.runNow({ id: created.activity.id });

    expect(autoArchiveWasExcluded).toBe(true);
  });

  it('holds the target reservation through a scheduled automation dispatch', async () => {
    const dueAt = '2026-05-28T11:59:00.000Z';
    let autoArchiveWasExcluded = false;
    mockedSendWorktreeChatMessage.mockImplementationOnce(async () => {
      try {
        await withWorkspaceTargetAutoArchiveLease(
          'workspace-1',
          'worktree-1',
          () => Promise.resolve(),
        );
      } catch {
        autoArchiveWasExcluded = true;
      }
      return { ok: true, chatId: 'chat-1' };
    });
    await writeAutomationFile({
      version: 1,
      updatedAt: '2026-05-28T11:58:00.000Z',
      activities: [
        activity({
          name: 'Reserved scheduled prompt',
          schedule: {
            kind: 'one_time',
            runAt: dueAt,
            timezone: 'local',
          },
          action: {
            type: 'worktree_session_prompt',
            workspaceId: 'workspace-1',
            worktreeId: 'worktree-1',
            chatId: 'chat-1',
            prompt: 'Continue',
          },
          nextRunAt: dueAt,
        }),
      ],
      recentRuns: [],
    });
    const { service } = makeService();

    await service.start();
    await flushAutomationWrites(service);
    service.stop();

    expect(autoArchiveWasExcluded).toBe(true);
  });

  it('preserves durable history when activity deletion cannot be persisted', async () => {
    const { service } = makeService();
    const created = await service.create({
      name: 'Delete rollback',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:10:00.000Z',
        timezone: 'local',
      },
      action: appAdvisorAction(),
    });
    if (!created.ok || !created.activity) throw new Error('create failed');
    await service.runNow({ id: created.activity.id });

    jest
      .spyOn(
        service as unknown as {
          writeFile(file: unknown): Promise<void>;
        },
        'writeFile',
      )
      .mockRejectedValueOnce(new Error('disk full'));
    await expect(service.delete({ id: created.activity.id })).rejects.toThrow(
      'disk full',
    );

    const fresh = new AutomationsService();
    fresh.configure({
      getMainWindow: () => null,
      ensureAppAdvisorWindow: jest.fn(),
      sendAppAdvisorWindowCommand: jest.fn(),
    });
    expect((await fresh.list()).activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: created.activity.id }),
      ]),
    );
    await expect(
      fresh.listRuns({ activityId: created.activity.id }),
    ).resolves.toMatchObject({ totalCount: 1 });
  });

  it('does not strand an archive-only running run when its hot-window write fails', async () => {
    const { service } = makeService();
    const created = await service.create({
      name: 'Initial persistence failure',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:10:00.000Z',
        timezone: 'local',
      },
      action: appAdvisorAction(),
    });
    if (!created.ok || !created.activity) throw new Error('create failed');
    jest
      .spyOn(
        service as unknown as {
          writeFile(file: unknown): Promise<void>;
        },
        'writeFile',
      )
      .mockRejectedValueOnce(new Error('disk full'));

    await expect(service.runNow({ id: created.activity.id })).rejects.toThrow(
      'disk full',
    );

    const fresh = new AutomationsService();
    fresh.configure({
      getMainWindow: () => null,
      ensureAppAdvisorWindow: jest.fn(),
      sendAppAdvisorWindowCommand: jest.fn(),
    });
    await expect(
      fresh.listRuns({ activityId: created.activity.id }),
    ).resolves.toMatchObject({ totalCount: 0, runs: [] });
  });

  it('persists a scheduled hot-window run before its initial archive append', async () => {
    await writeAutomationFile({
      version: 1,
      updatedAt: '2026-05-28T12:00:00.000Z',
      activities: [
        activity({
          schedule: {
            kind: 'one_time',
            runAt: '2026-05-28T11:59:00.000Z',
            timezone: 'local',
          },
        }),
      ],
      recentRuns: [],
    });
    const { service } = makeService();
    await service.list();
    jest
      .spyOn(
        service as unknown as {
          writeFile(file: unknown): Promise<void>;
        },
        'writeFile',
      )
      .mockRejectedValueOnce(new Error('disk full'));

    await expect(
      (
        service as unknown as {
          runDueCheck(): Promise<void>;
        }
      ).runDueCheck(),
    ).rejects.toThrow('disk full');

    const fresh = new AutomationsService();
    await expect(
      fresh.listRuns({ activityId: 'activity-1' }),
    ).resolves.toMatchObject({ totalCount: 0, runs: [] });
  });

  it('completes a manual run after its initial archive append fails', async () => {
    const { service } = makeService();
    const created = await service.create({
      name: 'Manual archive retry',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:10:00.000Z',
        timezone: 'local',
      },
      action: appAdvisorAction(),
    });
    if (!created.ok || !created.activity) throw new Error('create failed');
    const archive = (
      service as unknown as {
        archive: { appendRun(run: ScheduledActivityRun): Promise<void> };
      }
    ).archive;
    jest
      .spyOn(archive, 'appendRun')
      .mockRejectedValueOnce(new Error('initial append failed'));

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({ ok: true, run: { status: 'success' } });
    await expect(
      service.listRuns({ activityId: created.activity.id }),
    ).resolves.toMatchObject({
      totalCount: 1,
      runs: [expect.objectContaining({ status: 'success' })],
    });
  });

  it('dispatches a scheduled run after its initial archive append fails', async () => {
    await writeAutomationFile({
      version: 1,
      updatedAt: '2026-05-28T12:00:00.000Z',
      activities: [
        activity({
          schedule: {
            kind: 'one_time',
            runAt: '2026-05-28T11:59:00.000Z',
            timezone: 'local',
          },
        }),
      ],
      recentRuns: [],
    });
    const { service, ensureAppAdvisorWindow } = makeService();
    const archive = (
      service as unknown as {
        archive: { appendRun(run: ScheduledActivityRun): Promise<void> };
      }
    ).archive;
    jest
      .spyOn(archive, 'appendRun')
      .mockRejectedValueOnce(new Error('initial append failed'));

    await service.start();
    await flushAutomationWrites(service);
    service.stop();

    expect(ensureAppAdvisorWindow).toHaveBeenCalledTimes(1);
    expect((await service.list()).recentRuns[0]).toMatchObject({
      status: 'success',
    });
    await expect(
      service.listRuns({ activityId: 'activity-1' }),
    ).resolves.toMatchObject({
      totalCount: 1,
      runs: [expect.objectContaining({ status: 'success' })],
    });
  });

  it('keeps each activity archive complete after global hot-window eviction', async () => {
    const { service, onChange } = makeService();
    const first = await service.create({
      name: 'First archive',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: appAdvisorAction(),
    });
    const second = await service.create({
      name: 'Second archive',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: appAdvisorAction(),
    });
    if (!first.ok || !first.activity || !second.ok || !second.activity) {
      throw new Error('create failed');
    }

    onChange.mockClear();
    for (let index = 0; index < 150; index += 1) {
      await service.runNow({ id: first.activity.id });
      await service.runNow({ id: second.activity.id });
    }

    expect((await service.list()).recentRuns).toHaveLength(100);
    expect(
      (await service.listRuns({ activityId: first.activity.id, limit: 200 }))
        .totalCount,
    ).toBe(150);
    expect(
      (await service.listRuns({ activityId: second.activity.id, limit: 200 }))
        .totalCount,
    ).toBe(150);
    for (const [snapshot] of onChange.mock.calls as Array<
      [{ activities: unknown[]; recentRuns: unknown[] }]
    >) {
      const terminalCount = snapshot.recentRuns.filter(
        (run) =>
          typeof run === 'object' &&
          run !== null &&
          'status' in run &&
          run.status !== 'running',
      ).length;
      expect(terminalCount).toBeLessThanOrEqual(100);
      expect(Object.keys(snapshot).sort()).toEqual([
        'activities',
        'recentRuns',
      ]);
    }
  }, 120_000);

  it('normalizes prompt plugin selections when creating, updating, and loading', async () => {
    const { service } = makeService();
    const created = await service.create({
      name: 'Canonical plugins',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:10:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'app_advisor_prompt',
        prompt: 'Review',
        pluginSelections: {
          bundleIds: ['legacy-create'],
          skillRefs: [],
          pluginRefs: [],
        },
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    expect(
      JSON.parse(await readFile(automationsFilePath, 'utf8')),
    ).toMatchObject({
      activities: [
        {
          action: {
            pluginSelections: {
              collectionIds: ['legacy-create'],
              skillRefs: [],
              pluginRefs: [],
            },
          },
        },
      ],
    });
    expect(await readFile(automationsFilePath, 'utf8')).not.toContain(
      'bundleIds',
    );

    await service.update({
      id: created.activity.id,
      action: {
        type: 'app_advisor_prompt',
        prompt: 'Review again',
        pluginSelections: {
          bundleIds: ['legacy-update'],
          skillRefs: [],
          pluginRefs: [],
        },
      },
    });
    expect(
      JSON.parse(await readFile(automationsFilePath, 'utf8')),
    ).toMatchObject({
      activities: [
        {
          action: {
            pluginSelections: {
              collectionIds: ['legacy-update'],
              skillRefs: [],
              pluginRefs: [],
            },
          },
        },
      ],
    });
    expect(await readFile(automationsFilePath, 'utf8')).not.toContain(
      'bundleIds',
    );

    await writeAutomationFile({
      version: 1,
      updatedAt: '2026-05-28T12:00:00.000Z',
      activities: [
        activity({
          action: {
            type: 'app_advisor_prompt',
            prompt: 'Loaded legacy plugins',
            pluginSelections: {
              bundleIds: ['legacy-load'],
              skillRefs: [],
              pluginRefs: [],
            },
          },
        }),
      ],
      recentRuns: [],
    });
    const loadedService = makeService().service;
    await expect(loadedService.list()).resolves.toMatchObject({
      activities: [
        {
          action: {
            pluginSelections: {
              collectionIds: ['legacy-load'],
              skillRefs: [],
              pluginRefs: [],
            },
          },
        },
      ],
    });
  });

  it('drops persisted runs with unknown skip reasons', async () => {
    await writeAutomationFile({
      version: 1,
      updatedAt: '2026-05-28T12:00:00.000Z',
      activities: [],
      recentRuns: [
        run({
          id: 'known-skip',
          status: 'skipped',
          skipReason: 'idempotency',
        }),
        {
          ...run({
            id: 'unknown-skip',
            status: 'skipped',
          }),
          skipReason: 'unexpected_reason',
        },
      ],
    });

    const fresh = new AutomationsService();
    fresh.configure({
      getMainWindow: () => null,
      ensureAppAdvisorWindow: jest.fn(),
      sendAppAdvisorWindowCommand: jest.fn(),
    });

    expect((await fresh.list()).recentRuns.map((entry) => entry.id)).toEqual([
      'known-skip',
    ]);
  });

  it('recomputes nextRunAt when only the activity name changes', async () => {
    const { service } = makeService();
    const created = await service.create({
      name: 'Frequent prompt',
      schedule: {
        kind: 'cron',
        expression: '*/5 * * * *',
        timezone: 'local',
      },
      action: appAdvisorAction(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok || !created.activity) throw new Error('create failed');
    expect(created.activity.nextRunAt).toBe('2026-05-28T12:05:00.000Z');

    jest.setSystemTime(new Date('2026-05-28T12:06:00.000Z'));
    const updated = await service.update({
      id: created.activity.id,
      name: 'Renamed prompt',
    });

    expect(updated).toMatchObject({
      ok: true,
      activity: {
        name: 'Renamed prompt',
        nextRunAt: '2026-05-28T12:10:00.000Z',
      },
    });
  });

  it('runs an overdue one-time activity once and disables it', async () => {
    await writeAutomationFile({
      version: 1,
      updatedAt: '2026-05-28T12:00:00.000Z',
      activities: [
        activity({
          schedule: {
            kind: 'one_time',
            runAt: '2026-05-28T11:59:00.000Z',
            timezone: 'local',
          },
        }),
      ],
      recentRuns: [],
    });
    const { service, ensureAppAdvisorWindow } = makeService();

    await service.start();
    await flushAutomationWrites(service);
    service.stop();

    expect(ensureAppAdvisorWindow).toHaveBeenCalledTimes(1);
    const snapshot = await service.list();
    expect(snapshot.activities[0]).toMatchObject({
      enabled: false,
      lastResult: { status: 'success' },
    });
    expect(snapshot.recentRuns).toHaveLength(1);

    const restarted = makeService();
    await restarted.service.start();
    await flushAutomationWrites(restarted.service);
    restarted.service.stop();
    expect(restarted.ensureAppAdvisorWindow).not.toHaveBeenCalled();
  });

  it('runs only one missed cron occurrence after long downtime', async () => {
    const oldNextRunAt = '2026-05-27T12:00:00.000Z';
    await writeAutomationFile({
      version: 1,
      updatedAt: '2026-05-28T12:00:00.000Z',
      activities: [
        activity({
          schedule: {
            kind: 'cron',
            expression: '*/5 * * * *',
            timezone: 'local',
          },
          nextRunAt: oldNextRunAt,
        }),
      ],
      recentRuns: [],
    });
    const { service, ensureAppAdvisorWindow } = makeService();

    await service.start();
    await flushAutomationWrites(service);
    service.stop();

    const snapshot = await service.list();
    expect(ensureAppAdvisorWindow).toHaveBeenCalledTimes(1);
    expect(snapshot.recentRuns).toHaveLength(1);
    expect(snapshot.recentRuns[0]?.scheduledFor).toBe(oldNextRunAt);
    expect(snapshot.recentRuns[0]?.trigger).toBe('catch_up');
    const history = await service.listRuns({
      activityId: 'activity-1',
      limit: 200,
    });
    expect(history.totalCount).toBe(51);
    expect(history.runs.filter((run) => run.status === 'missed')).toHaveLength(
      50,
    );
    expect(snapshot.recentRuns.some((run) => run.status === 'missed')).toBe(
      false,
    );
    expect(
      history.runs.find((run) => run.omittedCount !== undefined)?.omittedCount,
    ).toBe(238);
    expect(Date.parse(snapshot.activities[0]?.nextRunAt ?? '')).toBeGreaterThan(
      Date.now(),
    );
  });

  it('does not duplicate missed cron history when scheduler persistence retries', async () => {
    const oldNextRunAt = '2026-05-27T12:00:00.000Z';
    await writeAutomationFile({
      version: 1,
      updatedAt: '2026-05-28T12:00:00.000Z',
      activities: [
        activity({
          schedule: {
            kind: 'cron',
            expression: '*/5 * * * *',
            timezone: 'local',
          },
          nextRunAt: oldNextRunAt,
        }),
      ],
      recentRuns: [],
    });
    const first = makeService();
    jest
      .spyOn(
        first.service as unknown as {
          writeFile(file: unknown): Promise<void>;
        },
        'writeFile',
      )
      .mockRejectedValueOnce(new Error('disk full'));

    await expect(first.service.start()).rejects.toThrow('disk full');
    first.service.stop();

    const restarted = makeService();
    await restarted.service.start();
    await flushAutomationWrites(restarted.service);
    restarted.service.stop();

    const history = await restarted.service.listRuns({
      activityId: 'activity-1',
      limit: 200,
    });
    const missed = history.runs.filter((run) => run.status === 'missed');
    expect(missed).toHaveLength(50);
    expect(new Set(missed.map((run) => run.scheduledFor)).size).toBe(50);
  }, 15_000);

  it('classifies an ordinary slightly late cron tick as scheduled', async () => {
    jest.setSystemTime(new Date('2026-05-28T12:00:01.000Z'));
    await writeAutomationFile({
      version: 1,
      updatedAt: '2026-05-28T12:00:00.000Z',
      activities: [
        activity({
          schedule: {
            kind: 'cron',
            expression: '*/5 * * * *',
            timezone: 'local',
          },
          nextRunAt: '2026-05-28T12:00:00.000Z',
        }),
      ],
      recentRuns: [],
    });
    const { service } = makeService();

    await service.start();
    await flushAutomationWrites(service);
    service.stop();

    expect((await service.list()).recentRuns[0]?.trigger).toBe('scheduled');
  });

  it('marks missed history incomplete when bounded enumeration stops early', async () => {
    await writeAutomationFile({
      version: 1,
      updatedAt: '2025-05-28T12:00:00.000Z',
      activities: [
        activity({
          schedule: {
            kind: 'cron',
            expression: '* * * * *',
            timezone: 'local',
          },
          nextRunAt: '2025-05-28T12:00:00.000Z',
        }),
      ],
      recentRuns: [],
    });
    const { service } = makeService();

    await service.start();
    await flushAutomationWrites(service);
    service.stop();

    const history = await service.listRuns({
      activityId: 'activity-1',
      limit: 200,
    });
    const summary = history.runs.find((run) => run.omittedCount !== undefined);
    expect(summary?.omittedCount).toBeGreaterThan(0);
    expect(
      (
        summary as ScheduledActivityRun & {
          missedOccurrencesTruncated?: boolean;
        }
      )?.missedOccurrencesTruncated,
    ).toBe(true);
  });

  it('passes chat settings to App Advisor prompt activities', async () => {
    const { service, ensureAppAdvisorWindow } = makeService();
    const created = await service.create({
      name: 'Advisor with settings',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'app_advisor_prompt',
        prompt: 'Review the app',
        model: 'gpt-6-sol',
        modelConfig: { thinkingLevel: 'xhigh', fastMode: true },
        approvalMode: 'ask',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        status: 'success',
      },
    });
    const snapshot = await service.list();
    expect(snapshot.recentRuns[0]?.result?.appAdvisorChatId).toEqual(
      expect.any(String),
    );
    expect(snapshot.recentRuns[0]?.result?.userMessageId).toEqual(
      expect.any(String),
    );
    expect(ensureAppAdvisorWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        quickPrompt: 'Review the app',
        quickPromptModel: 'gpt-5.5',
        quickPromptProviderType: 'codex',
        quickPromptModelConfig: {
          thinkingLevel: 'xhigh',
          speed: 'fast',
          fastMode: true,
        },
        quickPromptThinkingLevel: 'xhigh',
        quickPromptApprovalMode: 'ask',
        quickPromptInitiationSource: 'automation',
        quickPromptAutomationName: 'Advisor with settings',
        quickPromptUserMessageId: snapshot.recentRuns[0]?.result?.userMessageId,
      }),
    );
  });

  it('opens App Advisor and cowork new chats in an existing Work Entry', async () => {
    const { service, ensureAppAdvisorWindow } = makeService();
    async function createAndRun(
      name: string,
      action: AutomationAction,
    ): Promise<ScheduledActivityRun | undefined> {
      const created = await service.create({
        name,
        schedule: {
          kind: 'one_time',
          runAt: '2026-05-28T12:30:00.000Z',
          timezone: 'local',
        },
        action,
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      const result = await service.runNow({ id: created.activity.id });
      return result.ok ? result.run : undefined;
    }

    const advisorRun = await createAndRun('Advisor entry', {
      type: 'app_advisor_prompt',
      workEntryId: 'aa-entry-1',
      prompt: 'Review the app',
    });
    expect(advisorRun).toMatchObject({
      status: 'success',
      target: { workspaceId: 'app-advisor', worktreeId: 'aa-entry-1' },
    });
    expect(ensureAppAdvisorWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        quickPrompt: 'Review the app',
        quickPromptWorkEntryId: 'aa-entry-1',
      }),
    );

    const coworkRun = await createAndRun('Cowork entry', {
      type: 'standalone_prompt',
      chatProjectId: 'cowork-1',
      workEntryId: 'entry-1',
      prompt: 'Organize notes',
    });
    expect(coworkRun).toMatchObject({
      status: 'success',
      target: { workspaceId: 'cowork-1', worktreeId: 'entry-1' },
    });
    expect(mockedSendStandaloneChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectLocalId: 'cowork-1',
        workEntryId: 'entry-1',
        message: 'Organize notes',
      }),
      expect.anything(),
    );
  });

  it('keeps creating a Work Entry per run when no Work Entry is targeted', async () => {
    const { service, ensureAppAdvisorWindow } = makeService();
    for (const action of [
      { type: 'app_advisor_prompt', prompt: 'Review' },
      { type: 'standalone_prompt', chatProjectId: 'cowork-1', prompt: 'Sum' },
    ] satisfies AutomationAction[]) {
      const created = await service.create({
        name: action.type,
        schedule: {
          kind: 'one_time',
          runAt: '2026-05-28T12:30:00.000Z',
          timezone: 'local',
        },
        action,
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      await service.runNow({ id: created.activity.id });
    }
    expect(ensureAppAdvisorWindow.mock.calls[0]?.[0]).not.toHaveProperty(
      'quickPromptWorkEntryId',
    );
    expect(
      mockedSendStandaloneChatMessage.mock.calls[0]?.[0],
    ).not.toHaveProperty('workEntryId');
  });

  it('assigns newly created worktree and cowork prompts to named sidebar groups', async () => {
    const { service, ensureAppAdvisorWindow } = makeService();
    const standaloneResult = Object.assign(
      {
        ok: true as const,
        chatId: 'standalone-chat-1',
        userMessageId: 'standalone-user-message-1',
      },
      { workEntryId: 'actual-cowork-entry' },
    );
    mockedSendStandaloneChatMessage.mockResolvedValueOnce(standaloneResult);
    const worktree = await service.create({
      name: 'Build prompt',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_prompt',
        workspaceId: 'workspace-1',
        sidebarGroupName: 'Build',
        prompt: 'Implement',
      },
    });
    const cowork = await service.create({
      name: 'Notes prompt',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'standalone_prompt',
        chatProjectId: 'project-chat',
        sidebarGroupName: 'Notes',
        prompt: 'Organize notes',
      },
    });
    const advisor = await service.create({
      name: 'Advisor prompt',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'app_advisor_prompt',
        sidebarGroupName: 'Reviews',
        prompt: 'Review the app',
      },
    });
    if (!worktree.ok || !worktree.activity) throw new Error('create failed');
    if (!cowork.ok || !cowork.activity) throw new Error('create failed');
    if (!advisor.ok || !advisor.activity) throw new Error('create failed');

    await service.runNow({ id: worktree.activity.id });
    await service.runNow({ id: cowork.activity.id });
    await service.runNow({ id: advisor.activity.id });

    expect(mockAssignItemToNamedGroup).toHaveBeenNthCalledWith(1, {
      scope: { workspaceLocalId: 'workspace-1' },
      itemId: 'worktree-new',
      name: 'Build',
    });
    expect(mockAssignItemToNamedGroup).toHaveBeenNthCalledWith(2, {
      scope: { workspaceLocalId: 'project-chat' },
      itemId: 'actual-cowork-entry',
      name: 'Notes',
    });
    expect(mockAssignItemToNamedGroup).toHaveBeenCalledTimes(2);
    expect(ensureAppAdvisorWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        quickPrompt: 'Review the app',
        quickPromptSidebarGroupName: 'Reviews',
      }),
    );
    expect(
      mockAssignItemToNamedGroup.mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      mockedCreateSingleRepoWorktree.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('ignores blank group names and named groups on existing or stacked automation targets', async () => {
    const { service, ensureAppAdvisorWindow } = makeService();
    const actions: AutomationAction[] = [
      {
        type: 'worktree_prompt',
        workspaceId: 'workspace-1',
        sidebarGroupName: '   ',
        prompt: 'Blank group',
      },
      {
        type: 'worktree_prompt',
        workspaceId: 'workspace-1',
        existingWorktreeId: 'worktree-1',
        sidebarGroupName: 'Ignored worktree group',
        prompt: 'Existing worktree',
      },
      {
        // Branch-stack children follow their root and cannot be grouped.
        type: 'worktree_prompt',
        workspaceId: 'workspace-1',
        baseWorktreeId: 'worktree-1',
        sidebarGroupName: 'Ignored stacked group',
        prompt: 'Stacked worktree',
      },
      {
        type: 'standalone_prompt',
        chatProjectId: 'project-chat',
        workEntryId: 'existing-entry',
        sidebarGroupName: 'Ignored cowork group',
        prompt: 'Existing entry',
      },
      {
        type: 'app_advisor_prompt',
        workEntryId: 'existing-advisor-entry',
        sidebarGroupName: 'Ignored advisor group',
        prompt: 'Existing Advisor entry',
      },
    ];

    for (const action of actions) {
      const index = actions.indexOf(action);
      const created = await service.create({
        name: `Target ${index}`,
        schedule: {
          kind: 'one_time',
          runAt: '2026-05-28T12:30:00.000Z',
          timezone: 'local',
        },
        action,
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      await service.runNow({ id: created.activity.id });
    }

    expect(mockAssignItemToNamedGroup).not.toHaveBeenCalled();
    expect(ensureAppAdvisorWindow.mock.calls.at(-1)?.[0]).toMatchObject({
      quickPromptWorkEntryId: 'existing-advisor-entry',
    });
    expect(ensureAppAdvisorWindow.mock.calls.at(-1)?.[0]).not.toHaveProperty(
      'quickPromptSidebarGroupName',
    );
  });

  it('keeps automation runs successful and logs no user content when sidebar assignment fails', async () => {
    const { service } = makeService();
    mockAssignItemToNamedGroup.mockRejectedValue(
      new Error('private group name with sensitive text'),
    );
    const actions: AutomationAction[] = [
      {
        type: 'worktree_prompt',
        workspaceId: 'workspace-1',
        sidebarGroupName: 'Private group name',
        prompt: 'Implement',
      },
      {
        type: 'standalone_prompt',
        chatProjectId: 'project-chat',
        sidebarGroupName: 'Private group name',
        prompt: 'Organize notes',
      },
    ];
    mockedSendStandaloneChatMessage.mockResolvedValueOnce(
      Object.assign(
        {
          ok: true as const,
          chatId: 'standalone-chat-1',
          userMessageId: 'standalone-user-message-1',
        },
        { workEntryId: 'actual-cowork-entry' },
      ),
    );

    for (const action of actions) {
      const index = actions.indexOf(action);
      const created = await service.create({
        name: `Best effort assignment ${index}`,
        schedule: {
          kind: 'one_time',
          runAt: '2026-05-28T12:30:00.000Z',
          timezone: 'local',
        },
        action,
      });
      if (!created.ok || !created.activity) throw new Error('create failed');

      await expect(
        service.runNow({ id: created.activity.id }),
      ).resolves.toMatchObject({ ok: true, run: { status: 'success' } });
    }

    expect(mockAssignItemToNamedGroup).toHaveBeenCalledTimes(2);
    expect(mockedLogMainProcessError).toHaveBeenCalledTimes(2);
    expect(mockedLogMainProcessError).toHaveBeenCalledWith(
      'Automation sidebar group assignment failed',
      { operation: 'assign-sidebar-group' },
    );
    expect(mockedLogMainProcessError).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        error: messageContaining('sensitive text'),
      }),
    );
  });

  describe.each([true, false])(
    'dispatch plugin reauthorization (enabled=%s)',
    (enabled): void => {
      it.each<AutomationAction>([
        { type: 'app_advisor_prompt', prompt: 'Review' },
        {
          type: 'standalone_prompt',
          chatProjectId: 'project-chat',
          prompt: 'Review',
        },
        {
          type: 'worktree_prompt',
          workspaceId: 'workspace-1',
          prompt: 'Review',
        },
        {
          type: 'worktree_session_prompt',
          workspaceId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          prompt: 'Review',
        },
      ])(
        'rechecks selections changed during the if-command for $type',
        async (action): Promise<void> => {
          mockFeatureFlagValues.set(
            CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
            enabled,
          );
          mockBackgroundDecide.mockImplementation((input) =>
            Promise.resolve(decideResourceContext(input, { strict: true })),
          );
          mockedRunAutomationIfCommand.mockImplementationOnce(async () => {
            const pluginSelections = {
              collectionIds: [],
              skillRefs: [],
              mcpServerRefs: [],
              pluginRefs: [
                { marketplaceId: 'market', pluginName: 'late-plugin' },
              ],
            };
            mockedReadPreferencesFile.mockResolvedValue({
              ...defaultPreferences(),
              appAdvisorPluginSelections: pluginSelections,
            });
            const standalone = await loadStandaloneProject({
              id: 'project-chat',
              name: 'Cowork',
              createdAt: '2026-05-28T12:00:00.000Z',
            });
            if (standalone)
              mockedLoadStandaloneProject.mockResolvedValue({
                ...standalone,
                mergedProject: {
                  ...standalone.mergedProject,
                  defaultPluginSelections: pluginSelections,
                },
              });
            const sidebar = await readAllSidebarItems();
            mockedReadAllSidebarItems.mockResolvedValue({
              ...sidebar,
              items: sidebar.items.map((item) => ({
                ...item,
                defaultPluginSelections: pluginSelections,
              })),
            });
            mockedReadChatTabsFile.mockResolvedValue(
              chatTabsFile([{ ...targetChatTab(), pluginSelections }]),
            );
            return { outcome: 'run', stdout: '', stderr: '' };
          });
          await writeFile(
            chatProjectsFilePath,
            JSON.stringify({
              version: 1,
              projects: [
                {
                  id: 'project-chat',
                  name: 'Cowork',
                  createdAt: '2026-05-28T12:00:00.000Z',
                },
              ],
            }),
          );
          const { service, ensureAppAdvisorWindow } = makeService();
          const created = await service.create({
            name: 'Late plugins',
            schedule: {
              kind: 'cron',
              expression: '0 * * * *',
              timezone: 'local',
            },
            ifCommand: 'wait-for-ready',
            action,
          });
          if (!created.ok || !created.activity)
            throw new Error('create failed');
          const result = await service.runNow({ id: created.activity.id });
          expect(mockedRunAutomationIfCommand).toHaveBeenCalledTimes(1);
          if (enabled) {
            expect(result.run).toMatchObject({
              status: 'failure',
              error: backgroundExecutionDeniedMessage('unknown-provenance', {
                turnedOff: true,
              }),
            });
            expect((await service.list()).activities[0]).toMatchObject({
              enabled: false,
            });
            expect(ensureAppAdvisorWindow).not.toHaveBeenCalled();
            expect(mockedSendStandaloneChatMessage).not.toHaveBeenCalled();
            expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
          } else {
            expect(result.run).toMatchObject({ status: 'success' });
          }
        },
      );
    },
  );

  it('reauthorizes the effective App Advisor default model before dispatch', async () => {
    initAgentModels([
      {
        id: 'agent_model_review',
        name: 'Review',
        baseModel: 'sonnet',
        instructions: '',
        pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
        createdAt: '2026-05-28T12:00:00.000Z',
        updatedAt: '2026-05-28T12:00:00.000Z',
        available: true,
      },
    ]);
    await writeFile(
      join(dataDirPath, 'agent-models.json'),
      JSON.stringify({ version: 1, agents: [] }),
    );
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    mockedReadPreferencesFile.mockResolvedValue({
      ...defaultPreferences(),
      appAdvisorModel: 'agent_model_review',
    });
    const { service, ensureAppAdvisorWindow } = makeService();
    const created = await service.create({
      name: 'Default custom model',
      schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
      action: { type: 'app_advisor_prompt', prompt: 'Review' },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');
    const result = await service.runNow({ id: created.activity.id });
    expect(result.run).toMatchObject({
      status: 'failure',
      error: backgroundExecutionDeniedMessage('missing-dependency', {
        turnedOff: true,
      }),
    });
    expect(ensureAppAdvisorWindow).not.toHaveBeenCalled();
  });

  describe.each([
    { enabled: true, hasPlugins: true },
    { enabled: false, hasPlugins: true },
    { enabled: true, hasPlugins: false },
  ])(
    'resolved prompt policy (enabled=$enabled, hasPlugins=$hasPlugins)',
    ({ enabled, hasPlugins }): void => {
      it.each<AutomationAction>([
        { type: 'app_advisor_prompt', prompt: '@plugin' },
        {
          type: 'standalone_prompt',
          chatProjectId: 'project-chat',
          prompt: '@plugin',
        },
        {
          type: 'worktree_prompt',
          workspaceId: 'workspace-1',
          prompt: '@plugin',
        },
        {
          type: 'worktree_session_prompt',
          workspaceId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          prompt: '@plugin',
        },
      ])(
        'authorizes resolved prompt plugins for $type',
        async (action): Promise<void> => {
          mockFeatureFlagValues.set(
            CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
            enabled,
          );
          mockBackgroundDecide.mockImplementation((input) =>
            Promise.resolve(decideResourceContext(input, { strict: true })),
          );
          if (!('prompt' in action))
            throw new Error('Expected a prompt action');
          const promptAction = {
            ...action,
            promptReferences: [
              {
                kind: 'plugin',
                displayText: '@plugin',
                textStart: 0,
                plugin: {
                  kind: 'installed',
                  marketplaceId: 'market',
                  pluginName: 'plugin',
                },
              },
            ],
          } satisfies AutomationAction;
          mockedResolveConfiguredPrompt.mockResolvedValue({
            prompt: '@plugin',
            referencedPluginSelections: {
              collectionIds: [],
              skillRefs: [],
              mcpServerRefs: [],
              pluginRefs: hasPlugins
                ? [{ marketplaceId: 'market', pluginName: 'plugin' }]
                : [],
            },
          });
          const { service, ensureAppAdvisorWindow } = makeService();
          const created = await service.create({
            name: 'Plugin reference',
            schedule: {
              kind: 'cron',
              expression: '0 * * * *',
              timezone: 'local',
            },
            action: promptAction,
          });
          if (!created.ok || !created.activity)
            throw new Error('create failed');
          const result = await service.runNow({ id: created.activity.id });
          expect(mockedResolveConfiguredPrompt).toHaveBeenCalledTimes(1);
          if (enabled && hasPlugins) {
            expect(result.run).toMatchObject({
              status: 'failure',
              error: backgroundExecutionDeniedMessage('unknown-provenance', {
                turnedOff: true,
              }),
            });
            expect((await service.list()).activities[0]).toMatchObject({
              enabled: false,
            });
            expect(ensureAppAdvisorWindow).not.toHaveBeenCalled();
            expect(mockedSendStandaloneChatMessage).not.toHaveBeenCalled();
            expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
            expect(
              (await service.list()).activities[0]?.nextRunAt,
            ).toBeUndefined();
          } else {
            expect(result.run).toMatchObject({ status: 'success' });
            expect((await service.list()).activities[0]).toMatchObject({
              enabled: true,
            });
            if (!enabled) expect(mockBackgroundDecide).not.toHaveBeenCalled();
          }
        },
      );
    },
  );

  it('runs an App Advisor automation with an ownerless local plugin', async (): Promise<void> => {
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    mockBackgroundDecide.mockImplementation((input) =>
      Promise.resolve(decideResourceContext(input, { strict: true })),
    );
    const plugin: PluginInfo = {
      name: 'local-plugin',
      sourcePath: '/plugins/local/local-plugin',
      marketplaceId: 'local-marketplace',
      providerSupport: { claude: 'native', codex: 'none' },
      facets: {},
    };
    const marketplace: MarketplaceInfo = {
      id: 'local-marketplace',
      name: 'Local marketplace',
      sourceType: 'github',
      sourceUrl: 'https://github.com/acme/local-marketplace',
      installLocation: '/plugins/local',
      pluginCount: 1,
      plugins: [plugin],
      providerStatus: {
        claude: {
          provider: 'claude',
          state: 'valid',
          accepted: true,
          pluginCount: 1,
          lastCheckedAt: '2026-05-28T11:00:00.000Z',
        },
        codex: {
          provider: 'codex',
          state: 'invalid',
          accepted: false,
          pluginCount: 0,
          lastCheckedAt: '2026-05-28T11:00:00.000Z',
        },
      },
      validProviders: ['claude'],
    };
    mockLoadMarketplaces.mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-05-28T11:00:00.000Z',
        marketplaces: [marketplace],
      },
    });
    const selections = {
      collectionIds: [],
      skillRefs: [],
      mcpServerRefs: [],
      pluginRefs: [{ marketplaceId: marketplace.id, pluginName: plugin.name }],
    };
    mockedResolveConfiguredPrompt.mockResolvedValue({
      prompt: '@local-plugin',
      referencedPluginSelections: selections,
    });
    const { service, ensureAppAdvisorWindow } = makeService();
    const created = await service.create({
      name: 'Local plugin',
      schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
      action: {
        type: 'app_advisor_prompt',
        prompt: '@local-plugin',
        promptReferences: [
          {
            kind: 'plugin',
            displayText: '@local-plugin',
            textStart: 0,
            plugin: {
              kind: 'installed',
              marketplaceId: marketplace.id,
              pluginName: plugin.name,
            },
          },
        ],
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    const result = await service.runNow({ id: created.activity.id });

    expect(result.run).toMatchObject({ status: 'success' });
    expect((await service.list()).activities[0]).toMatchObject({
      enabled: true,
    });
    expect(ensureAppAdvisorWindow).toHaveBeenCalledTimes(1);
  });

  it('forwards resolved references through Advisor, cowork, and provisioned worktree sends', async (): Promise<void> => {
    const fileReference = {
      displayPath: 'live/a.ts',
      absolutePath: '/live/a.ts',
      textStart: 0,
    };
    mockedResolveConfiguredPrompt.mockResolvedValue({
      prompt: 'live/a.ts',
      fileReferences: [fileReference],
    });
    const { service, ensureAppAdvisorWindow } = makeService();
    const actions: AutomationAction[] = [
      {
        type: 'app_advisor_prompt',
        prompt: 'src/a.ts',
        promptReferences: [
          {
            kind: 'file',
            root: { kind: 'workspace' },
            relativePath: 'src/a.ts',
            displayText: 'src/a.ts',
            textStart: 0,
          },
        ],
        planMode: true,
      },
      {
        type: 'standalone_prompt',
        chatProjectId: 'project-chat',
        prompt: 'src/a.ts',
        promptReferences: [
          {
            kind: 'file',
            root: { kind: 'workspace' },
            relativePath: 'src/a.ts',
            displayText: 'src/a.ts',
            textStart: 0,
          },
        ],
        planMode: true,
      },
      {
        type: 'worktree_prompt',
        workspaceId: 'workspace-1',
        prompt: 'src/a.ts',
        promptReferences: [
          {
            kind: 'file',
            root: { kind: 'workspace' },
            relativePath: 'src/a.ts',
            displayText: 'src/a.ts',
            textStart: 0,
          },
        ],
      },
    ];
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      const created = await service.create({
        name: `Reference route ${index}`,
        schedule: {
          kind: 'one_time',
          runAt: '2026-05-28T12:30:00.000Z',
          timezone: 'local',
        },
        action,
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      expect(await service.runNow({ id: created.activity.id })).toMatchObject({
        ok: true,
        run: { status: 'success' },
      });
    }
    expect(ensureAppAdvisorWindow.mock.calls[0]?.[0]).toMatchObject({
      quickPrompt: 'live/a.ts',
      quickPromptFileReferences: [fileReference],
      quickPromptPlanMode: true,
    });
    expect(mockedSendStandaloneChatMessage.mock.calls[0]?.[0]).toMatchObject({
      message: 'live/a.ts',
      fileReferences: [fileReference],
      planMode: true,
    });
    expect(mockedSendWorktreeChatMessage.mock.calls[0]?.[0]).toMatchObject({
      text: 'live/a.ts',
      fileReferences: [fileReference],
    });
    expect(
      mockedResolveConfiguredPrompt.mock.calls.map(([args]) => args.projectId),
    ).toEqual([APP_ADVISOR_PROJECT_ID, 'project-chat', 'workspace-1']);
  });

  it('keeps appAdvisorThinkingLevel for an explicit-model App Advisor automation', async () => {
    // The App Advisor thinking level is a SURFACE setting, applied regardless of
    // which model the surface runs (the renderer does the same in
    // `resolveTabDefaults`). Skipping the eager lane resolution for an explicit
    // model must not also discard it and fall through to the generic chat
    // provider default.
    mockedReadPreferencesFile.mockResolvedValue({
      ...defaultPreferences(),
      appAdvisorThinkingLevel: 'low',
      // Deliberately different, so falling through to it is visible.
      defaultChatModelByProvider: {
        claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'xhigh' },
        codex: { model: 'gpt-5.5', thinkingLevel: 'xhigh' },
      },
    });
    const { service, ensureAppAdvisorWindow } = makeService();
    const created = await service.create({
      name: 'Advisor explicit model',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:35:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'app_advisor_prompt',
        prompt: 'Review the app',
        // Explicit model, NO thinking override.
        model: 'gpt-6-sol',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({ ok: true, run: { status: 'success' } });

    expect(ensureAppAdvisorWindow).toHaveBeenCalledWith(
      expect.objectContaining({ quickPromptThinkingLevel: 'low' }),
    );
  });

  it('adds activity plugins to App Advisor defaults and leaves project defaults inherited by cowork and worktree chats', async () => {
    const activityPluginRef = {
      type: 'skill' as const,
      source: { type: 'builtin' as const, id: 'app' },
      skill_name: 'activity-skill',
    };
    const appAdvisorDefaults = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'app-defaults', skillName: 'advisor-skill' }],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    const coworkDefaults = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'cowork-defaults', skillName: 'cowork-skill' }],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    const worktreeDefaults = {
      collectionIds: [],
      skillRefs: [
        { sourceId: 'workspace-defaults', skillName: 'worktree-skill' },
      ],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    const directSelections = {
      collectionIds: ['activity-collection'],
      skillRefs: [
        { sourceId: 'custom:local', skillName: 'activity-custom-skill' },
      ],
      pluginRefs: [
        { marketplaceId: 'local-marketplace', pluginName: 'activity-plugin' },
      ],
      mcpServerRefs: [{ serverId: 'linear', configId: 'work' }],
    };

    const preferences: Awaited<ReturnType<typeof readPreferencesFile>> = {
      ...defaultPreferences(),
      appAdvisorPluginSelections: appAdvisorDefaults,
    };
    mockedReadPreferencesFile.mockResolvedValue(preferences);
    const standaloneProject: Awaited<ReturnType<typeof loadStandaloneProject>> =
      {
        projectFile: {
          version: 1,
          id: 'cowork-1',
          name: 'Notes',
          createdAt: '2026-05-28T12:00:00.000Z',
        },
        mergedProject: {
          id: 'cowork-1',
          name: 'Notes',
          createdAt: '2026-05-28T12:00:00.000Z',
          defaultPluginSelections: coworkDefaults,
        },
      };
    mockedLoadStandaloneProject.mockResolvedValue(standaloneProject);
    await writeFile(
      chatProjectsFilePath,
      JSON.stringify({
        version: 1,
        projects: [standaloneProject.mergedProject],
      }),
      'utf8',
    );
    const sidebarItems: Awaited<ReturnType<typeof readAllSidebarItems>> = {
      version: 1,
      items: [
        {
          type: 'single-repo',
          id: 'workspace-1',
          name: 'Workspace',
          repoPath: '/repo',
          color: 'blue',
          collapsed: false,
          order: 0,
          worktrees: [],
          defaultPluginSelections: worktreeDefaults,
        },
      ],
      warnings: [],
    };
    mockedReadAllSidebarItems.mockResolvedValue(sidebarItems);
    mockedResolveShareablePluginRefs.mockImplementation((refs) =>
      refs.map((ref) => ({
        matchState: 'matched' as const,
        ref,
        catalogKey: 'builtin/activity-skill',
        selection: {
          kind: 'skill' as const,
          sourceId: 'activity-source',
          skillName: 'activity-skill',
        },
      })),
    );
    await writeFile(
      chatProjectsFilePath,
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: 'cowork-1',
            name: 'Notes',
            createdAt: '2026-05-28T12:00:00.000Z',
          },
        ],
      }),
      'utf8',
    );

    const { service, ensureAppAdvisorWindow } = makeService();
    async function createAndRun(
      name: string,
      action: AutomationCreateRequest['action'],
    ): Promise<void> {
      const created = await service.create({
        name,
        schedule: {
          kind: 'one_time',
          runAt: '2026-05-28T12:30:00.000Z',
          timezone: 'local',
        },
        action,
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      await service.runNow({ id: created.activity.id });
    }

    await createAndRun('Advisor additive plugins', {
      type: 'app_advisor_prompt',
      prompt: 'Advise',
      plugins: [activityPluginRef],
      pluginSelections: directSelections,
    });
    await createAndRun('Cowork additive plugins', {
      type: 'standalone_prompt',
      chatProjectId: 'cowork-1',
      prompt: 'Organize notes',
      plugins: [activityPluginRef],
      pluginSelections: directSelections,
    });
    await createAndRun('Worktree additive plugins', {
      type: 'worktree_prompt',
      workspaceId: 'workspace-1',
      prompt: 'Implement',
      plugins: [activityPluginRef],
      pluginSelections: directSelections,
    });

    expect(
      ensureAppAdvisorWindow.mock.calls[0]?.[0].quickPromptPluginSelections
        ?.skillRefs,
    ).toEqual([
      ...appAdvisorDefaults.skillRefs,
      ...directSelections.skillRefs,
      { sourceId: 'activity-source', skillName: 'activity-skill' },
    ]);
    expect(
      mockedSendStandaloneChatMessage.mock.calls[0]?.[0].pluginSelections
        ?.skillRefs,
    ).toEqual([
      ...directSelections.skillRefs,
      { sourceId: 'activity-source', skillName: 'activity-skill' },
    ]);
    expect(
      mockedSendWorktreeChatMessage.mock.calls[0]?.[0].pluginSelections
        ?.skillRefs,
    ).toEqual([
      ...directSelections.skillRefs,
      { sourceId: 'activity-source', skillName: 'activity-skill' },
    ]);
    expect(
      ensureAppAdvisorWindow.mock.calls[0]?.[0].quickPromptPluginSelections,
    ).toEqual(
      expect.objectContaining({
        collectionIds: directSelections.collectionIds,
        pluginRefs: directSelections.pluginRefs,
        mcpServerRefs: directSelections.mcpServerRefs,
      }),
    );
    expect(
      mockedSendStandaloneChatMessage.mock.calls[0]?.[0].pluginSelections,
    ).toEqual(
      expect.objectContaining({
        collectionIds: directSelections.collectionIds,
        pluginRefs: directSelections.pluginRefs,
        mcpServerRefs: directSelections.mcpServerRefs,
      }),
    );
    expect(
      mockedSendWorktreeChatMessage.mock.calls[0]?.[0].pluginSelections,
    ).toEqual(
      expect.objectContaining({
        collectionIds: directSelections.collectionIds,
        pluginRefs: directSelections.pluginRefs,
        mcpServerRefs: directSelections.mcpServerRefs,
      }),
    );
  });

  it('aborts in-flight If Command gates when the service stops', async () => {
    let observedSignal: AbortSignal | undefined;
    mockedRunAutomationIfCommand.mockImplementationOnce((args) => {
      observedSignal = args.signal;
      return new Promise((resolve) => {
        args.signal?.addEventListener(
          'abort',
          () => resolve({ outcome: 'error', message: 'If Command aborted.' }),
          { once: true },
        );
      });
    });
    const { service, ensureAppAdvisorWindow } = makeService();
    const created = await service.create({
      name: 'Advisor with gate',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      ifCommand: 'sleep 60',
      action: {
        type: 'app_advisor_prompt',
        prompt: 'Review the app',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');
    expect(created.activity.ifCommand).toBe('sleep 60');

    const runPromise = service.runNow({ id: created.activity.id });
    await flushAutomationWrites(service);
    expect(mockedRunAutomationIfCommand).toHaveBeenCalledWith({
      command: 'sleep 60',
      signal: observedSignal,
    });
    expect(observedSignal?.aborted).toBe(false);

    service.stop();

    await expect(runPromise).resolves.toMatchObject({
      ok: true,
      run: {
        status: 'failure',
        error: 'If Command failed: If Command aborted.',
      },
    });
    expect(observedSignal?.aborted).toBe(true);
    expect(ensureAppAdvisorWindow).not.toHaveBeenCalled();
  });

  it('cancels an in-flight If Command before action dispatch and archives it', async () => {
    mockedRunAutomationIfCommand.mockImplementationOnce(
      (args) =>
        new Promise((resolve): void => {
          args.signal?.addEventListener(
            'abort',
            () => resolve({ outcome: 'error', message: 'If Command aborted.' }),
            { once: true },
          );
        }),
    );
    const { service, ensureAppAdvisorWindow } = makeService();
    const created = await service.create({
      name: 'Cancelable gate',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      ifCommand: 'sleep 60',
      action: appAdvisorAction(),
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    const runPromise = service.runNow({ id: created.activity.id });
    await flushAutomationWrites(service);
    const running = (await service.list()).recentRuns[0];
    expect(running?.status).toBe('running');
    expect(running?.cancellable).toBe(true);
    if (!running) throw new Error('running record missing');

    await expect(
      service.cancelRun({ runId: running.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: { status: 'canceled', error: 'Canceled before dispatch.' },
    });
    await expect(runPromise).resolves.toMatchObject({
      ok: true,
      run: { status: 'canceled' },
    });
    expect(ensureAppAdvisorWindow).not.toHaveBeenCalled();
    expect(mockHandleAutomationRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'canceled', runId: running.id }),
    );
    await expect(
      service.listRuns({ activityId: created.activity.id }),
    ).resolves.toMatchObject({
      runs: [
        expect.objectContaining({
          id: running.id,
          status: 'canceled',
          cancellable: false,
        }),
      ],
    });
  });

  it('preserves a queued cancellation when the If Command finishes behind another mutation', async () => {
    let finishIfCommand: (() => void) | undefined;
    mockedRunAutomationIfCommand.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishIfCommand = (): void =>
            resolve({ outcome: 'run', stdout: 'ready' });
        }),
    );
    const { service, ensureAppAdvisorWindow } = makeService();
    const created = await service.create({
      name: 'Queued cancellation',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      ifCommand: 'wait-for-ready',
      action: appAdvisorAction(),
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    const runPromise = service.runNow({ id: created.activity.id });
    await flushAutomationWrites(service);
    const running = (await service.list()).recentRuns[0];
    if (!running) throw new Error('running record missing');

    const internal = service as unknown as {
      writeFile(file: unknown): Promise<void>;
    };
    const originalWriteFile = internal.writeFile.bind(service);
    let releaseMutation: (() => void) | undefined;
    let signalMutationStarted: (() => void) | undefined;
    const mutationStarted = new Promise<void>((resolve) => {
      signalMutationStarted = resolve;
    });
    jest.spyOn(internal, 'writeFile').mockImplementationOnce(async (file) => {
      signalMutationStarted?.();
      await new Promise<void>((resolve) => {
        releaseMutation = resolve;
      });
      await originalWriteFile(file);
    });

    const updatePromise = service.update({
      id: created.activity.id,
      name: 'Queued cancellation updated',
    });
    await mutationStarted;
    const cancelPromise = service.cancelRun({ runId: running.id });
    finishIfCommand?.();
    releaseMutation?.();

    await expect(updatePromise).resolves.toMatchObject({ ok: true });
    await expect(cancelPromise).resolves.toMatchObject({
      ok: true,
      run: { status: 'canceled', error: 'Canceled before dispatch.' },
    });
    await expect(runPromise).resolves.toMatchObject({
      ok: true,
      run: { status: 'canceled' },
    });
    expect(ensureAppAdvisorWindow).not.toHaveBeenCalled();
  });

  it('closes the cancel window before dispatching the action', async () => {
    let finishDispatch: (() => void) | undefined;
    const { service, ensureAppAdvisorWindow } = makeService();
    ensureAppAdvisorWindow.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDispatch = (): void => resolve({ open: true, focused: false });
        }),
    );
    const created = await service.create({
      name: 'Dispatch boundary',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      ifCommand: 'test -f package.json',
      action: appAdvisorAction(),
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    const runPromise = service.runNow({ id: created.activity.id });
    await flushAutomationWrites(service);
    const running = (await service.list()).recentRuns[0];
    expect(running).toMatchObject({ status: 'running', cancellable: false });
    if (!running) throw new Error('running record missing');
    await expect(service.cancelRun({ runId: running.id })).resolves.toEqual({
      ok: false,
      error: 'Run can no longer be canceled.',
    });

    finishDispatch?.();
    await expect(runPromise).resolves.toMatchObject({
      ok: true,
      run: { status: 'success', cancellable: false },
    });
  });

  it('archives the complete run field set and bounded If Command output', async () => {
    mockedRunAutomationIfCommand.mockResolvedValueOnce({
      outcome: 'run',
      stdout: 'o'.repeat(4_100),
      stderr: 'e'.repeat(4_100),
    });
    const { service } = makeService();
    const created = await service.create({
      name: 'Complete history fields',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      ifCommand: 'print-output',
      action: {
        type: 'standalone_prompt',
        chatProjectId: 'project-chat',
        prompt: 'Use {{CANOPY_AUTOMATION_IF_CMD_OUTPUT}}',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        status: 'success',
        trigger: 'manual',
        executionLocation: 'local',
        durationMs: 0,
        target: {
          workspaceId: 'project-chat',
          chatId: 'standalone-chat-1',
        },
        result: {
          userMessageId: 'standalone-user-message-1',
        },
      },
    });
    const history = await service.listRuns({ activityId: created.activity.id });
    expect(history.runs[0]?.ifCommandOutput).toHaveLength(4_000);
    expect(
      history.runs[0]?.ifCommandOutput?.endsWith('[output truncated]'),
    ).toBe(true);
    expect(history.runs[0]?.ifCommandError).toHaveLength(4_000);
    expect(
      history.runs[0]?.ifCommandError?.endsWith('[output truncated]'),
    ).toBe(true);
  });

  it('uses If Command idempotency keys from stdout to skip recent duplicates', async () => {
    const { service, ensureAppAdvisorWindow } = makeService();
    const created = await service.create({
      name: 'Advisor with idempotency',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      ifCommand: 'find-source',
      action: appAdvisorAction('Review {{CANOPY_AUTOMATION_IF_CMD_OUTPUT}}'),
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    mockedRunAutomationIfCommand.mockResolvedValueOnce({
      outcome: 'run',
      stdout: 'CANOPY_IDEMPOTENCY_KEY=source-1\npayload',
    });
    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        status: 'success',
        idempotencyKey: 'source-1',
        idempotencyScope: 'self',
      },
    });
    expect(ensureAppAdvisorWindow).toHaveBeenLastCalledWith(
      expect.objectContaining({
        quickPrompt: 'Review payload',
      }),
    );

    mockedRunAutomationIfCommand.mockResolvedValueOnce({
      outcome: 'run',
      stdout: 'ignored\nCANOPY_IDEMPOTENCY_KEY=source-1',
    });
    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        status: 'skipped',
        skipReason: 'idempotency',
        error:
          'If Command idempotency key "source-1" was used by a recent run; action skipped.',
      },
    });
    expect(ensureAppAdvisorWindow).toHaveBeenCalledTimes(1);

    const snapshot = await service.list();
    expect(snapshot.recentRuns[0]).toMatchObject({
      status: 'skipped',
      skipReason: 'idempotency',
    });
    expect(snapshot.recentRuns[0]?.idempotencyKey).toBeUndefined();
    expect(snapshot.recentRuns[1]).toMatchObject({
      status: 'success',
      idempotencyKey: 'source-1',
      idempotencyScope: 'self',
    });
  });

  it('allows retrying an If Command idempotency key after a failed run', async () => {
    const { service, ensureAppAdvisorWindow } = makeService();
    ensureAppAdvisorWindow.mockRejectedValueOnce(new Error('transient open'));
    const created = await service.create({
      name: 'Retryable idempotency',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      ifCommand: 'find-source',
      action: appAdvisorAction('Review {{CANOPY_AUTOMATION_IF_CMD_OUTPUT}}'),
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    mockedRunAutomationIfCommand.mockResolvedValueOnce({
      outcome: 'run',
      stdout: 'CANOPY_IDEMPOTENCY_KEY=source-1\npayload',
    });
    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        status: 'failure',
        idempotencyKey: 'source-1',
        idempotencyScope: 'self',
      },
    });

    mockedRunAutomationIfCommand.mockResolvedValueOnce({
      outcome: 'run',
      stdout: 'CANOPY_IDEMPOTENCY_KEY=source-1\npayload',
    });
    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        status: 'success',
        idempotencyKey: 'source-1',
      },
    });

    expect(ensureAppAdvisorWindow).toHaveBeenCalledTimes(2);
  });

  it('scopes If Command idempotency keys to self by default and global when requested', async () => {
    const { service, ensureAppAdvisorWindow } = makeService();
    const first = await service.create({
      name: 'First source processor',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      ifCommand: 'source-a',
      action: appAdvisorAction('First'),
    });
    const second = await service.create({
      name: 'Second source processor',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:31:00.000Z',
        timezone: 'local',
      },
      ifCommand: 'source-b',
      action: appAdvisorAction('Second'),
    });
    const third = await service.create({
      name: 'Global source processor',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:32:00.000Z',
        timezone: 'local',
      },
      ifCommand: 'source-c',
      action: appAdvisorAction('Third'),
    });
    const fourth = await service.create({
      name: 'Global source recorder',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:33:00.000Z',
        timezone: 'local',
      },
      ifCommand: 'source-d',
      action: appAdvisorAction('Fourth'),
    });
    const fifth = await service.create({
      name: 'Later self-scoped source processor',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:34:00.000Z',
        timezone: 'local',
      },
      ifCommand: 'source-e',
      action: appAdvisorAction('Fifth'),
    });
    if (!first.ok || !first.activity) throw new Error('first create failed');
    if (!second.ok || !second.activity) throw new Error('second create failed');
    if (!third.ok || !third.activity) throw new Error('third create failed');
    if (!fourth.ok || !fourth.activity) throw new Error('fourth create failed');
    if (!fifth.ok || !fifth.activity) throw new Error('fifth create failed');

    mockedRunAutomationIfCommand.mockResolvedValueOnce({
      outcome: 'run',
      stdout: 'CANOPY_IDEMPOTENCY_KEY=shared-source',
    });
    await expect(
      service.runNow({ id: first.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: { status: 'success' },
    });

    mockedRunAutomationIfCommand.mockResolvedValueOnce({
      outcome: 'run',
      stdout: 'CANOPY_IDEMPOTENCY_KEY=shared-source',
    });
    await expect(
      service.runNow({ id: second.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: { status: 'success' },
    });

    mockedRunAutomationIfCommand.mockResolvedValueOnce({
      outcome: 'run',
      stdout:
        'CANOPY_IDEMPOTENCY_KEY=shared-source\nCANOPY_IDEMPOTENCY_SCOPE=GLOBAL',
    });
    await expect(
      service.runNow({ id: third.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        status: 'skipped',
        skipReason: 'idempotency',
      },
    });

    mockedRunAutomationIfCommand.mockResolvedValueOnce({
      outcome: 'run',
      stdout:
        'CANOPY_IDEMPOTENCY_KEY=global-source\nCANOPY_IDEMPOTENCY_SCOPE=global',
    });
    await expect(
      service.runNow({ id: fourth.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        status: 'success',
        idempotencyKey: 'global-source',
        idempotencyScope: 'global',
      },
    });

    mockedRunAutomationIfCommand.mockResolvedValueOnce({
      outcome: 'run',
      stdout: 'CANOPY_IDEMPOTENCY_KEY=global-source',
    });
    await expect(
      service.runNow({ id: fifth.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        status: 'skipped',
        skipReason: 'idempotency',
      },
    });

    expect(ensureAppAdvisorWindow).toHaveBeenCalledTimes(3);
  });

  it('does not rerun a duplicate scheduledFor after restart', async () => {
    const scheduledFor = '2026-05-28T11:55:00.000Z';
    await writeAutomationFile({
      version: 1,
      updatedAt: '2026-05-28T12:00:00.000Z',
      activities: [
        activity({
          schedule: {
            kind: 'cron',
            expression: '*/5 * * * *',
            timezone: 'local',
          },
          nextRunAt: scheduledFor,
        }),
      ],
      recentRuns: [run({ scheduledFor })],
    });
    const { service, ensureAppAdvisorWindow } = makeService();

    await service.start();
    service.stop();

    expect(ensureAppAdvisorWindow).not.toHaveBeenCalled();
    expect((await service.list()).recentRuns).toHaveLength(1);
  });

  it('continues due checks while a scheduled run is still executing', async () => {
    let resolvePrompt!: () => void;
    const longPrompt = new Promise<{ open: boolean; focused: boolean }>(
      (resolve) => {
        resolvePrompt = (): void => resolve({ open: true, focused: false });
      },
    );
    await writeAutomationFile({
      version: 1,
      updatedAt: '2026-05-28T12:00:00.000Z',
      activities: [
        activity({
          schedule: {
            kind: 'cron',
            expression: '*/5 * * * *',
            timezone: 'local',
          },
          nextRunAt: '2026-05-28T11:55:00.000Z',
        }),
      ],
      recentRuns: [],
    });
    const { service, ensureAppAdvisorWindow } = makeService();
    ensureAppAdvisorWindow.mockReturnValue(longPrompt);

    await service.start();
    await flushAsyncWork();
    expect(ensureAppAdvisorWindow).toHaveBeenCalledTimes(1);
    expect((await service.list()).recentRuns[0]?.status).toBe('running');

    jest.setSystemTime(new Date('2026-05-28T12:05:00.000Z'));
    await (
      service as unknown as { runDueCheck: () => Promise<void> }
    ).runDueCheck();

    const skipped = (await service.list()).recentRuns.find(
      (entry) => entry.status === 'skipped',
    );
    expect(skipped).toMatchObject({
      scheduledFor: '2026-05-28T12:05:00.000Z',
      error: 'Previous run is still active.',
    });
    expect((await service.list()).activities[0]?.failureCount).toBe(0);

    resolvePrompt();
    await flushAutomationWrites(service);
    service.stop();
  });

  it('marks persisted running runs as failed on startup', async () => {
    await writeAutomationFile({
      version: 1,
      updatedAt: '2026-05-28T12:00:00.000Z',
      activities: [activity()],
      recentRuns: [
        run({
          id: 'stale-running',
          status: 'running',
          completedAt: undefined,
          error: undefined,
        }),
      ],
    });
    const { service } = makeService();

    const snapshot = await service.list();

    expect(snapshot.recentRuns[0]).toMatchObject({
      id: 'stale-running',
      status: 'failure',
      recovered: true,
      error: 'Run was interrupted when Canopy restarted.',
    });
    await expect(
      service.listRuns({ activityId: 'activity-1' }),
    ).resolves.toMatchObject({
      runs: [
        expect.objectContaining({
          id: 'stale-running',
          status: 'failure',
          recovered: true,
        }),
      ],
    });
    await expect(service.delete({ id: 'activity-1' })).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      service.listRuns({ activityId: 'activity-1' }),
    ).resolves.toMatchObject({ totalCount: 0, runs: [] });
  });

  it('preserves an archived terminal run after a crash before hot-window persistence', async () => {
    const staleHotRun = run({
      id: 'terminal-before-persist',
      status: 'running',
      completedAt: undefined,
      error: undefined,
      cancellable: false,
    });
    const archivedTerminalRun = run({
      ...staleHotRun,
      status: 'success',
      completedAt: '2026-05-28T12:00:05.000Z',
      durationMs: 5_000,
      result: {
        appAdvisorChatId: 'completed-chat',
        userMessageId: 'completed-message',
      },
    });
    await writeAutomationFile({
      version: 1,
      updatedAt: '2026-05-28T12:00:00.000Z',
      activities: [activity()],
      recentRuns: [staleHotRun],
    });
    const archivePath = join(
      dataDirPath,
      'automation-runs',
      'activity-1.jsonl',
    );
    await mkdir(dirname(archivePath), { recursive: true });
    await writeFile(
      archivePath,
      `${JSON.stringify(staleHotRun)}\n${JSON.stringify(archivedTerminalRun)}\n`,
      'utf8',
    );
    const { service } = makeService();

    const snapshot = await service.list();

    expect(snapshot.recentRuns[0]).toMatchObject({
      id: 'terminal-before-persist',
      status: 'success',
      result: {
        appAdvisorChatId: 'completed-chat',
        userMessageId: 'completed-message',
      },
    });
    expect(snapshot.recentRuns[0]?.recovered).toBeUndefined();
    expect(snapshot.activities[0]?.lastResult).toMatchObject({
      status: 'success',
      result: { appAdvisorChatId: 'completed-chat' },
    });
    await expect(
      service.listRuns({ activityId: 'activity-1' }),
    ).resolves.toMatchObject({
      runs: [
        expect.objectContaining({
          id: 'terminal-before-persist',
          status: 'success',
        }),
      ],
    });
    expect(mockHandleAutomationRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'terminal-before-persist',
        status: 'success',
      }),
    );
  });

  it('does not recount previously recovered interrupted runs on restart', async () => {
    await writeAutomationFile({
      version: 1,
      updatedAt: '2026-05-28T12:00:00.000Z',
      activities: [activity()],
      recentRuns: [
        run({
          id: 'stale-running',
          status: 'running',
          completedAt: undefined,
          error: undefined,
        }),
      ],
    });

    const first = makeService().service;
    await first.start();
    await flushAutomationWrites(first);
    first.stop();

    const second = makeService().service;
    await second.start();
    await flushAutomationWrites(second);
    second.stop();

    expect((await second.list()).activities[0]?.failureCount).toBe(1);
  });

  it('runs standalone and worktree prompt actions', async () => {
    const { service } = makeService();
    const standalone = await service.create({
      name: 'Standalone',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'standalone_prompt',
        chatProjectId: 'project-chat',
        prompt: 'Hello',
        model: 'gpt-6-sol',
        modelConfig: { thinkingLevel: 'xhigh', fastMode: true },
        approvalMode: 'auto',
      },
    });
    if (!standalone.ok || !standalone.activity)
      throw new Error('create failed');

    const packageOverlay = {
      packageDigest: 'a'.repeat(64),
      resources: [
        {
          virtualSourceId: `pipeline-package:${'a'.repeat(64)}/skill-1`,
          resourceId: 'skill-1',
          provider: 'codex' as const,
          rootPath: '/package/materialized/skill-1/codex/skills',
          kind: 'skill' as const,
          displayName: 'Packaged skill',
        },
      ],
    };
    mockedResolveInstalledAutomationPackageOverlay.mockResolvedValueOnce(
      packageOverlay,
    );

    await expect(
      service.runNow({ id: standalone.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        status: 'success',
        result: {
          standaloneChatId: 'standalone-chat-1',
          projectId: 'project-chat',
        },
      },
    });
    expect(mockedSendStandaloneChatMessage).toHaveBeenCalled();
    expect(mockedSendStandaloneChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Hello',
        projectLocalId: 'project-chat',
        model: 'gpt-5.5',
        providerType: 'codex',
        modelConfig: { thinkingLevel: 'xhigh', speed: 'fast', fastMode: true },
        thinkingLevel: 'xhigh',
        initiationSource: 'automation',
        automationName: 'Standalone',
        approvalMode: 'auto',
        packageOverlay,
      }),
      expect.objectContaining({ executionContext: 'personal' }),
    );

    const worktree = await service.create({
      name: 'Worktree',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_prompt',
        workspaceId: 'workspace-1',
        prompt: 'Implement',
        model: 'gpt-6-sol',
        modelConfig: { thinkingLevel: 'xhigh', fastMode: true },
        planMode: true,
        interfaceMode: 'claude-code',
        approvalMode: 'full-access',
      },
    });
    if (!worktree.ok || !worktree.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: worktree.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        status: 'success',
        result: { projectId: 'workspace-1', worktreeId: 'worktree-new' },
      },
    });
    expect(mockedCreateSingleRepoWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        deferGitSetup: true,
        existingWorktreeIds: ['worktree-1'],
      }),
    );
    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'workspace-1',
        worktreeId: 'worktree-new',
        text: 'Implement',
        model: 'gpt-5.5',
        providerType: 'codex',
        modelConfig: { thinkingLevel: 'xhigh', speed: 'fast', fastMode: true },
        thinkingLevel: 'xhigh',
        planMode: true,
        initiationSource: 'automation',
        automationName: 'Worktree',
        approvalMode: 'full-access',
      }),
      expect.objectContaining({ executionContext: 'personal' }),
    );
    // A Run now is the user's own action, so its chat comes forward: the
    // send does not ask to keep the current tab.
    expect(
      mockedSendWorktreeChatMessage.mock.calls.at(-1)?.[0],
    ).not.toHaveProperty('preserveActiveTab');
  });

  describe('an Agent that inherits the default model', () => {
    beforeEach(() => {
      initAgentModels([
        {
          id: 'agent_model_inherit',
          name: 'Inherit',
          baseModel: 'default',
          instructions: '',
          pluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
          },
          createdAt: '2026-10-12T00:00:00.000Z',
          updatedAt: '2026-10-12T00:00:00.000Z',
          available: true,
        },
      ]);
    });

    afterEach(() => {
      initAgentModels([]);
    });

    it.each([
      {
        action: {
          type: 'worktree_prompt' as const,
          workspaceId: 'workspace-1',
          prompt: 'Implement',
          model: 'agent_model_inherit',
        },
        model: 'agent_model_inherit@claude-sonnet-4-6',
        providerType: 'claude',
      },
      {
        action: {
          type: 'standalone_prompt' as const,
          chatProjectId: 'project-chat',
          prompt: 'Hello',
          model: 'agent_model_inherit',
        },
        model: 'agent_model_inherit@gpt-5.5',
        providerType: 'codex',
      },
    ])(
      'pins a $action.type chat to its destination default',
      async ({ action, model, providerType }) => {
        const { service } = makeService();
        const created = await service.create({
          name: 'Inherited default',
          schedule: {
            kind: 'one_time',
            runAt: '2026-05-28T12:30:00.000Z',
            timezone: 'local',
          },
          action,
        });
        if (!created.ok || !created.activity) throw new Error('create failed');
        await expect(
          service.runNow({ id: created.activity.id }),
        ).resolves.toMatchObject({ run: { status: 'success' } });
        const send =
          action.type === 'worktree_prompt'
            ? mockedSendWorktreeChatMessage
            : mockedSendStandaloneChatMessage;
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({ model, providerType }),
          expect.anything(),
        );
      },
    );

    it('refuses a route that would run a pinned Agent on another model', async () => {
      initAgentModels([
        {
          id: 'agent_model_pinned',
          name: 'Pinned',
          baseModel: 'claude-sonnet-4-6',
          instructions: '',
          pluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
          },
          createdAt: '2026-10-13T00:00:00.000Z',
          updatedAt: '2026-10-13T00:00:00.000Z',
          available: true,
        },
      ]);
      const { service } = makeService();
      const created = await service.create({
        name: 'Forged route',
        schedule: {
          kind: 'one_time',
          runAt: '2026-05-28T12:30:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'worktree_prompt',
          workspaceId: 'workspace-1',
          prompt: 'Implement',
          model: 'agent_model_pinned@gpt-5.5',
        },
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      await expect(
        service.runNow({ id: created.activity.id }),
      ).resolves.toMatchObject({ run: { status: 'failure' } });
      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
    });

    it('pins an existing chat prompted with the Agent to its workspace default', async () => {
      mockedReadChatTabsFile.mockResolvedValue(chatTabsFile([targetChatTab()]));
      const { service } = makeService();
      const created = await service.create({
        name: 'Session inherited default',
        schedule: {
          kind: 'one_time',
          runAt: '2026-05-28T12:30:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'worktree_session_prompt',
          workspaceId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          prompt: 'Continue',
          model: 'agent_model_inherit',
        },
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      await expect(
        service.runNow({ id: created.activity.id }),
      ).resolves.toMatchObject({ run: { status: 'success' } });
      expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'agent_model_inherit@claude-sonnet-4-6',
        }),
        expect.anything(),
      );
    });

    it('keeps the route an existing chat holds after the default changes', async () => {
      // The chat pinned the Agent to gpt-5.5; the workspace default is now
      // claude-sonnet-4-6.
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([
          targetChatTab({
            model: 'agent_model_inherit@gpt-5.5',
            providerType: 'codex',
            executionHarness: 'codex',
            sdkSessionId: 'thread-1',
          }),
        ]),
      );
      const { service } = makeService();
      const created = await service.create({
        name: 'Session kept route',
        schedule: {
          kind: 'one_time',
          runAt: '2026-05-28T12:30:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'worktree_session_prompt',
          workspaceId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          prompt: 'Continue',
          model: 'agent_model_inherit',
        },
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      await expect(
        service.runNow({ id: created.activity.id }),
      ).resolves.toMatchObject({ run: { status: 'success' } });
      expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'agent_model_inherit@gpt-5.5',
          sdkSessionId: 'thread-1',
        }),
        expect.anything(),
      );
    });

    it('pins an App Advisor chat to the App Advisor default', async () => {
      const { service, ensureAppAdvisorWindow } = makeService();
      const created = await service.create({
        name: 'Advisor inherited default',
        schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
        action: {
          type: 'app_advisor_prompt',
          prompt: 'Review',
          model: 'agent_model_inherit',
        },
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      await service.runNow({ id: created.activity.id });
      expect(ensureAppAdvisorWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          quickPromptModel: 'agent_model_inherit@gpt-5.5',
          quickPromptProviderType: 'codex',
        }),
      );
    });

    it('reads a whitespace-wrapped Agent id as the Agent it names', async () => {
      // A Claude-only account: the untouched Codex seed resolves to the chat
      // lane's Claude default.
      mockAppAdvisorDefault.mockResolvedValueOnce('claude-sonnet-4-6');
      const { service, ensureAppAdvisorWindow } = makeService();
      const created = await service.create({
        name: 'Advisor padded Agent',
        schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
        action: {
          type: 'app_advisor_prompt',
          prompt: 'Review',
          model: '  agent_model_inherit  ',
        },
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      await service.runNow({ id: created.activity.id });
      expect(ensureAppAdvisorWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          quickPromptModel: 'agent_model_inherit@claude-sonnet-4-6',
          quickPromptProviderType: 'claude',
        }),
      );
    });

    it('pins an App Advisor chat to the model a new App Advisor chat starts on', async () => {
      // A Claude-only account: the untouched Codex seed resolves to the chat
      // lane's Claude default.
      mockAppAdvisorDefault.mockResolvedValueOnce('claude-sonnet-4-6');
      const { service, ensureAppAdvisorWindow } = makeService();
      const created = await service.create({
        name: 'Advisor resolved default',
        schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
        action: {
          type: 'app_advisor_prompt',
          prompt: 'Review',
          model: 'agent_model_inherit',
        },
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      await service.runNow({ id: created.activity.id });
      expect(ensureAppAdvisorWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          quickPromptModel: 'agent_model_inherit@claude-sonnet-4-6',
          quickPromptProviderType: 'claude',
        }),
      );
    });
  });

  // A run nobody asked for stays behind: a scheduled worktree prompt asks
  // its chat to keep the current tab, where a Run now (above) does not.
  it('asks a scheduled worktree prompt chat to stay behind the current tab', async () => {
    await writeAutomationFile({
      version: 1,
      updatedAt: '2026-05-28T12:00:00.000Z',
      activities: [
        activity({
          name: 'Worktree',
          schedule: {
            kind: 'one_time',
            runAt: '2026-05-28T11:59:00.000Z',
            timezone: 'local',
          },
          action: {
            type: 'worktree_prompt',
            workspaceId: 'workspace-1',
            prompt: 'Implement',
            model: 'gpt-6-sol',
            modelConfig: { thinkingLevel: 'xhigh', fastMode: true },
            planMode: true,
            interfaceMode: 'claude-code',
            approvalMode: 'full-access',
          },
        }),
      ],
      recentRuns: [],
    });
    const { service } = makeService();
    await service.start();
    await flushAutomationWrites(service);
    service.stop();
    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        initiationSource: 'automation',
        automationName: 'Worktree',
        preserveActiveTab: true,
      }),
      expect.anything(),
    );
  });

  it.each([
    [false, 'failure'],
    [true, 'success'],
  ] as const)(
    'with Cursor connected: %s, a Cursor Cowork prompt automation gates on the live runtime',
    async (connected, status) => {
      mockIsCursorRuntimeAvailable.mockResolvedValue(connected);
      const { service } = makeService();
      const standalone = await service.create({
        name: 'Standalone Cursor',
        schedule: {
          kind: 'one_time',
          runAt: '2026-05-28T12:30:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'standalone_prompt',
          chatProjectId: 'project-chat',
          prompt: 'Hello',
          model: 'cursor-default',
          approvalMode: 'auto',
        },
      });
      if (!standalone.ok || !standalone.activity)
        throw new Error('create failed');

      const result = await service.runNow({ id: standalone.activity.id });
      if (!result.ok) throw new Error(result.error);
      expect(result.run?.status).toBe(status);
      if (!connected) {
        expect(result.run?.error).toBe(
          'Connect Cursor in Settings to use it in automations.',
        );
        expect(mockedSendStandaloneChatMessage).not.toHaveBeenCalled();
        return;
      }
      expect(mockedSendStandaloneChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'cursor-default' }),
        expect.anything(),
      );
    },
  );

  it.each([
    [false, 'failure'],
    [true, 'success'],
  ] as const)(
    'with Cursor connected: %s, a Cursor App Advisor prompt automation gates on the live runtime',
    async (connected, status) => {
      mockIsCursorRuntimeAvailable.mockResolvedValue(connected);
      const { service, ensureAppAdvisorWindow } = makeService();
      const advisor = await service.create({
        name: 'Advisor Cursor',
        schedule: {
          kind: 'one_time',
          runAt: '2026-05-28T12:30:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'app_advisor_prompt',
          prompt: 'Review the app',
          model: 'cursor-default',
          approvalMode: 'auto',
        },
      });
      if (!advisor.ok || !advisor.activity) throw new Error('create failed');
      const result = await service.runNow({ id: advisor.activity.id });
      if (!result.ok) throw new Error(result.error);
      expect(result.run?.status).toBe(status);
      if (!connected) {
        expect(result.run?.error).toBe(
          'Connect Cursor in Settings to use it in automations.',
        );
        expect(ensureAppAdvisorWindow).not.toHaveBeenCalled();
        return;
      }
      expect(ensureAppAdvisorWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          quickPromptModel: 'cursor-default',
          quickPromptProviderType: 'cursor',
        }),
      );
    },
    15_000,
  );

  it('provisions a fresh worktree for every worktree prompt run', async () => {
    const provisionedWorktreeIds = ['worktree-run-1', 'worktree-run-2'];
    mockedCreateSingleRepoWorktree.mockImplementation((options) => {
      const worktreeId = provisionedWorktreeIds.shift();
      if (!worktreeId) throw new Error('unexpected extra worktree provision');
      options.onGitReady?.({
        projectId: options.workspaceId,
        worktreeId,
        branchName: worktreeId,
      });
      return Promise.resolve({
        id: worktreeId,
        branchName: worktreeId,
        createdAt: new Date().toISOString(),
      });
    });
    const { service } = makeService();
    const created = await service.create({
      name: 'Fresh worktree each run',
      schedule: {
        kind: 'cron',
        expression: '0 9 * * *',
        timezone: 'local',
      },
      action: {
        type: 'worktree_prompt',
        workspaceId: 'workspace-1',
        prompt: 'Implement',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    const first = await service.runNow({ id: created.activity.id });
    if (!first.ok || !first.run) throw new Error('first runNow failed');
    const second = await service.runNow({ id: created.activity.id });
    if (!second.ok || !second.run) throw new Error('second runNow failed');

    expect(first.run.result?.worktreeId).toBe('worktree-run-1');
    expect(second.run.result?.worktreeId).toBe('worktree-run-2');
    expect(first.run.result?.chatId).toEqual(expect.any(String));
    expect(first.run.result?.userMessageId).toEqual(expect.any(String));
    expect(second.run.result?.chatId).toEqual(expect.any(String));
    expect(second.run.result?.userMessageId).toEqual(expect.any(String));
    expect(first.run.result?.chatId).not.toBe(second.run.result?.chatId);
    expect(first.run.result?.userMessageId).not.toBe(
      second.run.result?.userMessageId,
    );
    expect(first.run.result?.worktreeId).not.toBe(
      second.run.result?.worktreeId,
    );
    expect(mockedCreateSingleRepoWorktree).toHaveBeenCalledTimes(2);
  });

  it('resolves an inherited approval mode for automation-created chats', async () => {
    const { service } = makeService();
    mockReadWorkspaceApprovals.mockResolvedValue({
      version: 1,
      rules: [],
      defaultMode: 'auto',
    });
    const created = await service.create({
      name: 'Inherited approval mode',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'standalone_prompt',
        chatProjectId: 'project-chat',
        prompt: 'Hello',
        model: 'gpt-6-sol',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({ ok: true });
    expect(mockedSendStandaloneChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ approvalMode: 'auto' }),
      expect.any(Object),
    );
  });

  it('resolves a migrated standalone automation against the cowork project approval default', async () => {
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    mockReadBackgroundWorkspace.mockImplementation(
      (id): ReturnType<typeof mockReadBackgroundWorkspace> =>
        Promise.resolve(
          id === 'cowork-1'
            ? backgroundWorkspace()
            : {
                authority: 'unreadable',
                ownerMalformed: false,
                config: { repos: [] },
              },
        ),
    );
    mockResolveCoworkWorkspaceId.mockImplementation((projectId: string) =>
      projectId === 'legacy-project-chat' ? 'cowork-1' : projectId,
    );
    mockReadWorkspaceApprovals.mockImplementation((projectId) =>
      Promise.resolve({
        version: 1,
        rules: [],
        defaultMode: projectId === 'cowork-1' ? 'auto' : 'full-access',
      }),
    );
    const { service } = makeService();
    const created = await service.create({
      name: 'Migrated cowork approval mode',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'standalone_prompt',
        chatProjectId: 'legacy-project-chat',
        prompt: 'Hello',
        model: 'gpt-6-sol',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        result: {
          projectId: 'cowork-1',
          standaloneChatId: 'standalone-chat-1',
          userMessageId: 'standalone-user-message-1',
        },
        target: {
          workspaceId: 'cowork-1',
          chatId: 'standalone-chat-1',
        },
      },
    });
    expect(mockResolveCoworkWorkspaceId).toHaveBeenCalledWith(
      'legacy-project-chat',
    );
    expect(mockReadWorkspaceApprovals).toHaveBeenCalledWith('cowork-1');
    expect(mockedSendStandaloneChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalMode: 'auto',
        projectLocalId: 'cowork-1',
      }),
      expect.any(Object),
    );
  });

  it('records the resolved cowork workspace when a migrated send fails', async () => {
    mockResolveCoworkWorkspaceId.mockImplementation((projectId: string) =>
      projectId === 'legacy-project-chat' ? 'cowork-1' : projectId,
    );
    mockedSendStandaloneChatMessage.mockRejectedValueOnce(
      new Error('send failed'),
    );
    const { service } = makeService();
    const created = await service.create({
      name: 'Migrated cowork failure',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'standalone_prompt',
        chatProjectId: 'legacy-project-chat',
        prompt: 'Hello',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: { status: 'failure', target: { workspaceId: 'cowork-1' } },
    });
  });

  it('preserves the Ollama provider identity for scheduled prompts', async () => {
    const { service } = makeService();
    const created = await service.create({
      name: 'Local model',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'standalone_prompt',
        chatProjectId: 'project-chat',
        prompt: 'Hello locally',
        model: 'ollama-qwen3-coder',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
    });
    expect(mockedSendStandaloneChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'ollama-qwen3-coder',
        providerType: 'ollama',
        executionHarness: 'codex',
      }),
      expect.any(Object),
    );
    expect(mockedResolveConfiguredPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        providerType: 'ollama',
        executionHarness: 'codex',
      }),
    );
  });

  it('uses the Codex provider for an unhydrated GPT-family model', async () => {
    initCodexModels([]);
    try {
      const { service } = makeService();
      const created = await service.create({
        name: 'Future GPT model',
        schedule: {
          kind: 'one_time',
          runAt: '2026-05-28T12:30:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'standalone_prompt',
          chatProjectId: 'project-chat',
          prompt: 'Hello from the future',
          model: 'gpt-6-preview',
        },
      });
      if (!created.ok || !created.activity) throw new Error('create failed');

      await expect(
        service.runNow({ id: created.activity.id }),
      ).resolves.toMatchObject({
        ok: true,
      });
      expect(mockedSendStandaloneChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-6-preview',
          providerType: 'codex',
          executionHarness: 'codex',
        }),
        expect.any(Object),
      );
    } finally {
      initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
    }
  });

  it('forwards existingBranch to worktree creation for worktree_prompt', async () => {
    const { service } = makeService();
    mockedSendWorktreeChatMessage.mockResolvedValueOnce({
      ok: true,
      chatId: 'reused-starter-chat',
    });
    const created = await service.create({
      name: 'Provision from existing branch',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_prompt',
        workspaceId: 'workspace-1',
        prompt: 'Implement',
        existingBranch: 'feature/checked-out-branch',
        purpose: 'scheduled_task',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        status: 'success',
        result: {
          projectId: 'workspace-1',
          worktreeId: 'worktree-new',
          chatId: 'reused-starter-chat',
        },
      },
    });
    expect(mockedCreateSingleRepoWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        existingBranch: 'feature/checked-out-branch',
      }),
    );
    expect(
      mockedSendWorktreeChatMessage.mock.calls[0][0].chatId,
    ).toBeUndefined();
  });

  it('dispatches worktree prompts onto an existing worktree without provisioning', async () => {
    mockedReadAllSidebarItems.mockResolvedValue(sidebarWithExistingWorktree());
    const { service } = makeService();
    const created = await service.create({
      name: 'Existing worktree handoff',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_prompt',
        workspaceId: 'workspace-1',
        existingWorktreeId: 'worktree-existing',
        prompt: 'Implement leg 2 in place',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        status: 'success',
        result: {
          projectId: 'workspace-1',
          worktreeId: 'worktree-existing',
        },
      },
    });
    expect(mockedCreateSingleRepoWorktree).not.toHaveBeenCalled();
    expect(mockedCreateMultiRepoWorktree).not.toHaveBeenCalled();
    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'workspace-1',
        worktreeId: 'worktree-existing',
        text: 'Implement leg 2 in place',
        initiationSource: 'automation',
        automationName: 'Existing worktree handoff',
        chatId: expect.any(String) as unknown,
      }),
      expect.any(Object),
    );
  });

  it('rejects unknown worktrees before persisting or notifying watchers', async () => {
    const { service } = makeService();
    const created = await service.create({
      name: 'Missing worktree handoff',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_prompt',
        workspaceId: 'workspace-1',
        existingWorktreeId: 'worktree-missing',
        prompt: 'Implement leg 2 in place',
      },
    });
    expect(created).toMatchObject({ ok: false });
    expect((await service.list()).activities).toEqual([]);
    expect(mockedCreateSingleRepoWorktree).not.toHaveBeenCalled();
    expect(mockedCreateMultiRepoWorktree).not.toHaveBeenCalled();
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
    expect(mockedArchiveSingleRepoWorktree).not.toHaveBeenCalled();
    expect(mockedArchiveMultiRepoWorktree).not.toHaveBeenCalled();
    expect(mockHandleAutomationRunEvent).not.toHaveBeenCalled();
  });

  it.each([
    [false, 'refuses', 'failure'],
    [true, 'dispatches', 'success'],
  ] as const)(
    'with Cursor connected: %s, a Cursor worktree prompt %s',
    async (connected, _verb, status) => {
      mockIsCursorRuntimeAvailable.mockResolvedValue(connected);
      mockedReadAllSidebarItems.mockResolvedValue(
        sidebarWithExistingWorktree(),
      );
      const { service } = makeService();
      const created = await service.create({
        name: 'Cursor worktree prompt',
        schedule: {
          kind: 'one_time',
          runAt: '2026-05-28T12:30:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'worktree_prompt',
          workspaceId: 'workspace-1',
          existingWorktreeId: 'worktree-existing',
          prompt: 'Implement leg 2 in place',
          model: 'cursor-default',
        },
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      const result = await service.runNow({ id: created.activity.id });
      if (!result.ok) throw new Error(result.error);
      expect(result.run?.status).toBe(status);
      if (!connected) {
        expect(result.run?.error).toBe(
          'Connect Cursor in Settings to use it in automations.',
        );
        expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
        return;
      }
      // The same worktree chat dispatch every other harness uses.
      expect(mockedSendWorktreeChatMessage).toHaveBeenCalledTimes(1);
      expect(mockedSendWorktreeChatMessage.mock.calls[0]?.[0]).toMatchObject({
        projectId: 'workspace-1',
        worktreeId: 'worktree-existing',
        model: 'cursor-default',
        providerType: 'cursor',
        executionHarness: 'cursor',
      });
    },
  );

  it('rejects existing-worktree prompts targeting a cowork project', async () => {
    const { service } = makeService();
    const created = await service.create({
      name: 'Cowork existing worktree',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_prompt',
        workspaceId: 'cowork-1',
        existingWorktreeId: 'worktree-existing',
        prompt: 'Implement leg 2 in place',
      },
    });
    expect(created).toMatchObject({ ok: false });
    expect((await service.list()).activities).toEqual([]);
    expect(mockedCreateSingleRepoWorktree).not.toHaveBeenCalled();
    expect(mockedCreateMultiRepoWorktree).not.toHaveBeenCalled();
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('forwards baseBranch to new-branch worktree creation for worktree_prompt', async () => {
    const { service } = makeService();
    const created = await service.create({
      name: 'Provision from base branch',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_prompt',
        workspaceId: 'workspace-1',
        prompt: 'Implement',
        baseBranch: 'release',
        purpose: 'scheduled_task',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({ ok: true });
    expect(mockedCreateSingleRepoWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        baseBranch: 'release',
        existingBranch: undefined,
      }),
    );
  });

  it('removes automation worktrees when deferred git setup fails', async () => {
    const createdAt = '2026-05-28T12:00:00.000Z';
    mockedCreateSingleRepoWorktree.mockImplementationOnce((options) => {
      options.onGitFailed?.({
        projectId: options.workspaceId,
        worktreeId: 'worktree-failed',
        error: 'Git setup failed.',
      });
      return Promise.resolve({
        id: 'worktree-failed',
        branchName: 'worktree-failed',
        createdAt,
      });
    });
    const { service } = makeService();
    const created = await service.create({
      name: 'Failing worktree prompt',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_prompt',
        workspaceId: 'workspace-1',
        prompt: 'Implement',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        status: 'failure',
        error: 'Git setup failed.',
      },
    });
    expect(mockedArchiveSingleRepoWorktree).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-failed',
      expectedCreatedAt: createdAt,
      retainAsArchivedContainer: false,
    });
    expect(mockedArchiveMultiRepoWorktree).not.toHaveBeenCalled();
  });

  it('keeps automation worktrees after worktree prompt dispatch starts and fails', async () => {
    const createdAt = '2026-05-28T12:00:00.000Z';
    mockedCreateSingleRepoWorktree.mockImplementationOnce((options) => {
      options.onGitReady?.({
        projectId: options.workspaceId,
        worktreeId: 'worktree-send-failed',
        branchName: 'worktree-send-failed',
      });
      return Promise.resolve({
        id: 'worktree-send-failed',
        branchName: 'worktree-send-failed',
        createdAt,
      });
    });
    mockedSendWorktreeChatMessage.mockRejectedValueOnce(
      new Error('Chat dispatch failed.'),
    );
    const { service } = makeService();
    const created = await service.create({
      name: 'Failing worktree prompt dispatch',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_prompt',
        workspaceId: 'workspace-1',
        prompt: 'Implement',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        status: 'failure',
        error: 'Chat dispatch failed.',
      },
    });
    expect(mockedArchiveSingleRepoWorktree).not.toHaveBeenCalled();
    expect(mockedArchiveMultiRepoWorktree).not.toHaveBeenCalled();
  });

  it('persists Claude terminal mode for worktree prompt activities', async () => {
    const { service } = makeService();
    const created = await service.create({
      name: 'Claude terminal prompt',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_prompt',
        workspaceId: 'workspace-1',
        prompt: 'Investigate in terminal mode',
        model: 'claude-sonnet-4-6',
        modelConfig: { thinkingLevel: 'high' },
        planMode: true,
        interfaceMode: 'claude-code',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        status: 'success',
        result: { projectId: 'workspace-1', worktreeId: 'worktree-new' },
      },
    });
    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'workspace-1',
        worktreeId: 'worktree-new',
        text: 'Investigate in terminal mode',
        model: 'sonnet',
        providerType: 'claude',
        modelConfig: {
          thinkingLevel: 'high',
          speed: 'standard',
          fastMode: false,
        },
        thinkingLevel: 'high',
        planMode: true,
        interfaceMode: 'claude-code',
      }),
      expect.any(Object),
    );
  });

  it('forces worktree prompt activities to native chat mode when Claude TUI chats are disabled', async () => {
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiChats.key,
      false,
    );
    const { service } = makeService();
    const created = await service.create({
      name: 'Claude terminal prompt',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_prompt',
        workspaceId: 'workspace-1',
        prompt: 'Investigate in terminal mode',
        model: 'claude-sonnet-4-6',
        modelConfig: { thinkingLevel: 'high' },
        planMode: true,
        interfaceMode: 'claude-code',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        status: 'success',
        result: { projectId: 'workspace-1', worktreeId: 'worktree-new' },
      },
    });
    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
    );
    expect(mockedSendWorktreeChatMessage.mock.calls[0]?.[0]).not.toHaveProperty(
      'interfaceMode',
    );
  });

  it.each(['provider', 'model', 'harness'])(
    'rejects existing Cursor automation resolved by %s before dispatch when Cursor is not connected',
    async (source) => {
      mockIsCursorRuntimeAvailable.mockResolvedValue(false);
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([
          targetChatTab({
            model: source === 'model' ? 'cursor-default' : undefined,
            providerType: source === 'provider' ? 'cursor' : undefined,
            executionHarness: source === 'harness' ? 'cursor' : undefined,
          }),
        ]),
      );
      const { service } = makeService();
      const created = await service.create({
        name: 'Unattended existing Cursor chat',
        schedule: {
          kind: 'one_time',
          runAt: '2026-05-28T12:30:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'worktree_session_prompt',
          workspaceId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          prompt: 'Continue',
        },
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      const result = await service.runNow({ id: created.activity.id });
      expect(result.run).toMatchObject({
        status: 'failure',
        error:
          'Scheduled messages are not available for Cursor chats. Choose another model.',
      });
      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
    },
  );

  it.each(['workspace-1', 'cowork-1', APP_ADVISOR_PROJECT_ID])(
    'refuses an unavailable OpenCode scheduled target in %s before opening or dispatching',
    async (workspaceId) => {
      mockAssertOpenCodeModelAvailable.mockRejectedValue(
        new Error('This OpenCode model is unavailable. Choose another model.'),
      );
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([
          targetChatTab({
            executionHarness: 'opencode',
            providerType: 'opencode',
            model: 'opencode:fixture%2Fmodel',
          }),
        ]),
      );
      const { service, ensureAppAdvisorWindow } = makeService();
      const created = await service.create({
        name: 'Unavailable OpenCode schedule',
        schedule: {
          kind: 'one_time',
          runAt: '2026-05-28T12:30:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'worktree_session_prompt',
          workspaceId,
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          prompt: 'Continue',
          purpose: 'scheduled_send',
        },
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      const result = await service.runNow({ id: created.activity.id });
      expect(result.run).toMatchObject({
        status: 'failure',
        error: 'This OpenCode model is unavailable. Choose another model.',
      });
      expect(mockAssertOpenCodeModelAvailable).toHaveBeenCalledWith(
        'opencode:fixture%2Fmodel',
      );
      expect(ensureAppAdvisorWindow).not.toHaveBeenCalled();
      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
    },
  );

  it('refuses a scheduled OpenCode send revoked while preparing its prompt', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        targetChatTab({
          executionHarness: 'opencode',
          providerType: 'opencode',
          model: 'opencode:fixture%2Fmodel',
        }),
      ]),
    );
    mockedResolveConfiguredPrompt.mockImplementationOnce((args) => {
      mockOpenCodeGeneration += 1;
      return Promise.resolve({ prompt: args.prompt });
    });
    const { service } = makeService();
    const created = await service.create({
      name: 'Revoked OpenCode schedule',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_session_prompt',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        prompt: 'Continue',
        purpose: 'scheduled_send',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');
    const result = await service.runNow({ id: created.activity.id });
    expect(result.run).toMatchObject({
      status: 'failure',
      error: 'OpenCode connection changed. Try again.',
    });
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['cursor-default', 'cursor', 'cursor', true],
    ['cursor-claude-sonnet-4-5', 'cursor', 'cursor', true],
    ['cursor-default', 'cursor', 'cursor', false],
    ['sonnet', 'claude', 'claude', true],
  ] as const)(
    'refuses explicit Cursor continuation from %s with runtime %s',
    async (model, providerType, executionHarness, connected) => {
      mockIsCursorRuntimeAvailable.mockResolvedValue(connected);
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([
          targetChatTab({
            model,
            providerType,
            executionHarness,
            sdkSessionId: 'cursor-session',
          }),
        ]),
      );
      const { service } = makeService();
      const created = await service.create({
        name: 'Explicit Cursor continuation',
        schedule: {
          kind: 'one_time',
          runAt: '2026-05-28T12:30:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'worktree_session_prompt',
          workspaceId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          prompt: 'Continue',
          model: 'cursor-default',
        },
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      const result = await service.runNow({ id: created.activity.id });
      expect(result.run).toMatchObject({ status: 'failure' });
      if (!result.ok || !result.run) throw new Error('Missing automation run');
      expect(result.run?.error).toContain('Scheduled messages');
      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
    },
  );

  it('blocks unsafe Cursor continuations before asynchronous send admission can overwrite plan mode', async () => {
    mockIsCursorRuntimeAvailable.mockResolvedValue(true);
    const initial = targetChatTab({
      model: 'cursor-default',
      providerType: 'cursor',
      executionHarness: 'cursor',
      planMode: false,
    });
    mockedReadChatTabsFile.mockResolvedValue(chatTabsFile([initial]));
    mockedSendWorktreeChatMessage.mockImplementationOnce(async () => {
      await Promise.resolve();
      initial.planMode = true;
      return { ok: true, chatId: 'chat-1' };
    });
    const { service } = makeService();
    const created = await service.create({
      name: 'Concurrent settings',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_session_prompt',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        prompt: 'Continue',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');
    const result = await service.runNow({ id: created.activity.id });
    if (!result.ok || !result.run) throw new Error('Missing automation run');
    expect(result.run.status).toBe('failure');
    expect(result.run.error).toContain('Scheduled messages');
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('refuses unsupported Cursor scheduling without inspecting credentials or changing the saved tab', async () => {
    mockIsCursorRuntimeAvailable.mockResolvedValue(true);
    const tab = targetChatTab({
      model: 'sonnet',
      providerType: 'claude',
      executionHarness: 'claude',
      sdkSessionId: 'claude-session',
    });
    const before = structuredClone(tab);
    mockedReadChatTabsFile.mockResolvedValue(chatTabsFile([tab]));
    const { service } = makeService();
    const created = await service.create({
      name: 'Signed-out Cursor',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_session_prompt',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        prompt: 'Continue',
        model: 'cursor-default',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');
    const result = await service.runNow({ id: created.activity.id });
    if (!result.ok || !result.run) throw new Error('Missing automation run');
    expect(result.run.status).toBe('failure');
    expect(result.run.error).toContain('Scheduled messages');
    expect(mockReadCursorAccount).not.toHaveBeenCalled();
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
    expect(tab).toEqual(before);
  });

  it('keeps existing Cursor continuation scheduling unavailable after connecting', async () => {
    mockIsCursorRuntimeAvailable.mockResolvedValue(true);
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([targetChatTab({ executionHarness: 'cursor' })]),
    );
    const { service } = makeService();
    const created = await service.create({
      name: 'Unattended existing Cursor chat',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_session_prompt',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        prompt: 'Continue',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');
    const result = await service.runNow({ id: created.activity.id });
    if (!result.ok) throw new Error(result.error);
    expect(result.run).toMatchObject({ status: 'failure' });
    expect(result.run?.error).toContain('Scheduled messages');
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it.each([
    [false, 'failure'],
    [true, 'failure'],
  ] as const)(
    'with Cursor connected: %s, an existing Cursor App Advisor chat automation gates on the live runtime',
    async (connected, status) => {
      mockIsCursorRuntimeAvailable.mockResolvedValue(connected);
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([targetChatTab({ executionHarness: 'cursor' })]),
      );
      const { service, ensureAppAdvisorWindow } = makeService();
      const created = await service.create({
        name: 'App Advisor Cursor chat',
        schedule: {
          kind: 'one_time',
          runAt: '2026-05-28T12:30:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'worktree_session_prompt',
          workspaceId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          prompt: 'Continue',
        },
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      const result = await service.runNow({ id: created.activity.id });
      if (!result.ok) throw new Error(result.error);
      expect(result.run?.status).toBe(status);
      if (!connected) {
        expect(result.run?.error).toBe(
          'Scheduled messages are not available for Cursor chats. Choose another model.',
        );
        expect(ensureAppAdvisorWindow).not.toHaveBeenCalled();
        expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
        return;
      }
      expect(ensureAppAdvisorWindow).not.toHaveBeenCalled();
      expect(result.run?.error).toContain('Scheduled messages');
      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
    },
  );

  it.each([
    [false, 'failure'],
    [true, 'failure'],
  ] as const)(
    'with Cursor connected: %s, an existing Cursor automation targeting a Cowork workspace gates on the live runtime',
    async (connected, status) => {
      mockIsCursorRuntimeAvailable.mockResolvedValue(connected);
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([targetChatTab({ executionHarness: 'cursor' })]),
      );
      const { service, ensureAppAdvisorWindow } = makeService();
      const created = await service.create({
        name: 'Cowork Cursor chat',
        schedule: {
          kind: 'one_time',
          runAt: '2026-05-28T12:30:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'worktree_session_prompt',
          workspaceId: 'cowork-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          prompt: 'Continue',
        },
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      const result = await service.runNow({ id: created.activity.id });
      if (!result.ok) throw new Error(result.error);
      expect(result.run?.status).toBe(status);
      expect(ensureAppAdvisorWindow).not.toHaveBeenCalled();
      if (!connected) {
        expect(result.run?.error).toBe(
          'Scheduled messages are not available for Cursor chats. Choose another model.',
        );
        expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
        return;
      }
      expect(result.run?.error).toContain('Scheduled messages');
      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
    },
  );

  it('runs worktree session prompt actions against the existing chat runtime', async () => {
    const pluginSelections = {
      collectionIds: ['collection-1'],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        targetChatTab({
          model: 'gpt-6-sol',
          providerType: 'codex',
          modelConfig: { thinkingLevel: 'xhigh', fastMode: true },
          pluginSelections,
          planMode: true,
          sdkSessionId: 'thread-1',
          globalInstructionsSnapshot:
            '# User Overall Preferences\n\nPersisted session instructions.',
          selectedRepoId: 'frontend',
          proposalMode: 'required',
          interfaceMode: 'canopy',
        }),
      ]),
    );
    const { service } = makeService();
    const created = await service.create({
      name: 'Resume existing chat',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_session_prompt',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        prompt: 'Continue',
        fileReferences: [
          {
            displayPath: 'src/index.ts',
            absolutePath: '/repo/src/index.ts',
            repoName: 'canopy',
          },
        ],
        attachmentPaths: ['/tmp/context.md'],
        attachmentPromptContexts: [
          {
            attachmentPath: '/tmp/context.md',
            promptKind: 'in-app-browser-resource',
          },
        ],
        inputMode: 'voice',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    const runResult = await service.runNow({ id: created.activity.id });
    if (!runResult.ok || !runResult.run) throw new Error('runNow failed');
    expect(runResult).toMatchObject({
      ok: true,
      run: {
        status: 'success',
        result: {
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
        },
      },
    });
    const userMessageId = runResult.run.result?.userMessageId;
    expect(userMessageId).toBe(`automation-${runResult.run.id}`);

    expect(mockedCreateSingleRepoWorktree).not.toHaveBeenCalled();
    expect(mockedCreateMultiRepoWorktree).not.toHaveBeenCalled();
    expect(mockedReadChatTabsFile).toHaveBeenCalledWith(
      'workspace-1',
      'worktree-1',
    );
    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        text: 'Continue',
        fileReferences: [
          {
            displayPath: 'src/index.ts',
            absolutePath: '/repo/src/index.ts',
            repoName: 'canopy',
          },
        ],
        attachmentPaths: ['/tmp/context.md'],
        attachmentPromptContexts: [
          {
            attachmentPath: '/tmp/context.md',
            promptKind: 'in-app-browser-resource',
          },
        ],
        inputMode: 'voice',
        initiationSource: 'automation',
        automationName: 'Resume existing chat',
        model: 'gpt-6-sol',
        providerType: 'codex',
        modelConfig: { thinkingLevel: 'xhigh', fastMode: true },
        pluginSelections,
        planMode: true,
        interfaceMode: 'canopy',
        sdkSessionId: 'thread-1',
        globalInstructionsSnapshot:
          '# User Overall Preferences\n\nPersisted session instructions.',
        selectedRepoId: 'frontend',
        codexProposalMode: 'required',
        userMessageId,
      }),
      expect.any(Object),
    );
  });

  it('applies only explicit session settings at run time and inherits untouched model fields', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        targetChatTab({
          model: 'gpt-6-sol',
          providerType: 'codex',
          modelConfig: { thinkingLevel: 'xhigh', fastMode: true },
          planMode: true,
        }),
      ]),
    );
    const { service } = makeService();
    const created = await service.create({
      name: 'Explicit chat overrides',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_session_prompt',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        prompt: 'Continue',
        modelConfig: { thinkingLevel: 'low' },
        planMode: false,
        pluginSelections: {
          collectionIds: ['added'],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
    const run = await service.runNow({ id: created.activity.id });
    expect(run).toMatchObject({ ok: true, run: { status: 'success' } });
    const sent = mockedSendWorktreeChatMessage.mock.calls[0]?.[0];
    expect(sent?.model).toBe('gpt-6-sol');
    expect(sent?.modelConfig).toMatchObject({
      thinkingLevel: 'low',
      fastMode: true,
    });
    expect(sent?.planMode).toBe(false);
    expect(sent?.pluginSelections?.collectionIds).toEqual(['added']);
  });

  it.each([
    [{ thinkingLevel: 'low' as const }, 'ultrafast', false],
    [{ fastMode: false }, 'standard', false],
    [{ fastMode: true }, 'fast', true],
  ])(
    'merges continuation override %j over an Ultra fast chat as %s',
    async (override, expectedSpeed, expectedFastMode) => {
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([
          targetChatTab({
            model: 'gpt-6-sol',
            providerType: 'codex',
            modelConfig: {
              thinkingLevel: 'xhigh',
              speed: 'ultrafast',
              fastMode: false,
            },
          }),
        ]),
      );
      const { service } = makeService();
      const created = await service.create({
        name: 'Ultra continuation',
        schedule: {
          kind: 'one_time',
          runAt: '2026-05-28T12:30:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'worktree_session_prompt',
          workspaceId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          prompt: 'Continue',
          modelConfig: override,
        },
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      const run = await service.runNow({ id: created.activity.id });
      expect(run).toMatchObject({ ok: true, run: { status: 'success' } });
      const sent = mockedSendWorktreeChatMessage.mock.calls[0]?.[0];
      expect(sent?.modelConfig).toMatchObject({
        speed: expectedSpeed,
        fastMode: expectedFastMode,
      });
    },
  );

  it('rejects updating a pipeline automation to Ultra fast', async () => {
    await writeAutomationFile({
      version: 1,
      activities: [
        activity({
          action: {
            type: 'worktree_pipeline',
            workspaceId: 'workspace-1',
            pipelineId: 'local-pipeline',
            pipelineSource: 'user',
          },
        }),
      ],
      recentRuns: [],
    });
    const { service } = makeService();
    const result = await service.update({
      id: 'activity-1',
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'local-pipeline',
        pipelineSource: 'user',
        modelConfig: { speed: 'ultrafast' },
      },
    });
    expect(result).toMatchObject({
      ok: false,
      error: messageContaining('Ultra fast'),
    });
  });

  it('runs cowork session prompts through the Work Entry chat triple', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        targetChatTab({
          model: 'gpt-6-sol',
          providerType: 'codex',
        }),
      ]),
    );
    const { service } = makeService();
    const created = await service.create({
      name: 'Continue cowork chat',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_session_prompt',
        workspaceId: 'cowork-1',
        worktreeId: 'entry-1',
        chatId: 'chat-1',
        prompt: 'Continue the notes',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    const result = await service.runNow({ id: created.activity.id });
    if (!result.ok || !result.run) throw new Error('runNow failed');

    expect(mockedReadChatTabsFile).toHaveBeenCalledWith('cowork-1', 'entry-1');
    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'cowork-1',
        worktreeId: 'entry-1',
        chatId: 'chat-1',
        text: 'Continue the notes',
        userMessageId: result.run.result?.userMessageId,
      }),
      expect.any(Object),
    );
    expect(result.run).toMatchObject({
      status: 'success',
      result: {
        projectId: 'cowork-1',
        worktreeId: 'entry-1',
        chatId: 'chat-1',
      },
    });
    expect(typeof result.run.result?.userMessageId).toBe('string');
  });

  it('forks a persisted Claude session for a worktree session prompt', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        targetChatTab({
          model: 'claude-sonnet-4-6',
          providerType: 'claude',
          sdkSessionId: 'source-session',
          claudeForkSessionOnNextSend: true,
        }),
      ]),
    );
    const { service } = makeService();
    const created = await service.create({
      name: 'Fork existing chat',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_session_prompt',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        prompt: 'Continue in the fork',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: { status: 'success' },
    });

    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        sdkSessionId: 'source-session',
        claudeForkSession: true,
      }),
      expect.any(Object),
    );
  });

  it.each(['codex', 'opencode'] as const)(
    'defers due %s session prompts until idle and preserves their harness',
    async (providerType) => {
      const model =
        providerType === 'opencode' ? 'opencode:fixture%2Fmodel' : 'gpt-6-sol';
      mockedReadChatTabsFile.mockResolvedValue(
        chatTabsFile([
          targetChatTab({
            providerType,
            executionHarness: providerType,
            model,
            sdkSessionId: 'scheduled-session',
          }),
        ]),
      );
      const dueAt = '2026-05-28T11:59:00.000Z';
      let activityListener: (() => void) | undefined;
      const unsubscribe = jest.fn();
      mockedSubscribeChatSessionActivity.mockImplementation((listener) => {
        activityListener = listener;
        return unsubscribe;
      });
      mockedGetActiveSessionInfos.mockReturnValue([
        {
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          providerType,
          turnActive: true,
          pendingMessageCount: 0,
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          turnCount: 1,
        },
      ]);
      await writeAutomationFile({
        version: 1,
        updatedAt: '2026-05-28T11:58:00.000Z',
        activities: [
          activity({
            name: 'Scheduled message',
            schedule: {
              kind: 'one_time',
              runAt: dueAt,
              timezone: 'local',
            },
            action: {
              type: 'worktree_session_prompt',
              workspaceId: 'workspace-1',
              worktreeId: 'worktree-1',
              chatId: 'chat-1',
              prompt: 'Continue',
            },
            nextRunAt: dueAt,
          }),
        ],
        recentRuns: [],
      });
      const { service } = makeService();

      await service.start();
      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
      expect((await service.list()).recentRuns).toHaveLength(0);
      expect((await service.list()).activities[0]).toMatchObject({
        enabled: true,
        nextRunAt: dueAt,
      });

      mockedGetActiveSessionInfos.mockReturnValue([]);
      activityListener?.();
      await flushAutomationWrites(service);

      expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          text: 'Continue',
          providerType,
          model,
          sdkSessionId: 'scheduled-session',
        }),
        expect.any(Object),
      );
      expect((await service.list()).recentRuns[0]).toMatchObject({
        scheduledFor: dueAt,
        status: 'success',
      });
      const completedRun = (await service.list()).recentRuns[0];
      expect(completedRun?.result?.userMessageId).toBe(
        providerType === 'opencode'
          ? completedRun?.id
          : `automation-${completedRun?.id}`,
      );
      expect((await service.list()).activities[0]).toMatchObject({
        enabled: false,
        lastScheduledFor: dueAt,
      });

      service.stop();
      expect(unsubscribe).toHaveBeenCalled();
    },
  );

  it('runNow forces worktree session prompt actions even when the target chat is busy', async () => {
    mockedGetActiveSessionInfos.mockReturnValue([
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        providerType: 'codex',
        turnActive: true,
        pendingMessageCount: 0,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        turnCount: 1,
      },
    ]);
    const { service } = makeService();
    const created = await service.create({
      name: 'Force scheduled message',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_session_prompt',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        prompt: 'Continue',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        status: 'success',
      },
    });
    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        text: 'Continue',
      }),
      expect.any(Object),
    );
  });

  it('rejects session prompt writes when the target chat is missing', async () => {
    mockedReadChatTabsFile.mockResolvedValue(chatTabsFile([]));
    const { service } = makeService();
    const created = await service.create({
      name: 'Missing target',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_session_prompt',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        prompt: 'Continue',
      },
    });
    expect(created).toMatchObject({ ok: false });
    expect((await service.list()).activities).toEqual([]);
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('rejects readonly worktree session prompt targets', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([targetChatTab({ readOnly: true })]),
    );
    const { service } = makeService();
    const created = await service.create({
      name: 'Readonly target',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_session_prompt',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        prompt: 'Continue',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        status: 'failure',
        error:
          'That chat is archived and cannot receive automation messages. Edit this automation and pick another destination.',
      },
    });
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('rejects file tabs as worktree session prompt targets', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([targetChatTab({ kind: 'file' })]),
    );
    const { service } = makeService();
    const created = await service.create({
      name: 'File tab target',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_session_prompt',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        prompt: 'Continue',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        status: 'failure',
        error:
          'That chat is no longer available. Edit this automation and pick another destination.',
      },
    });
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('dispatches Claude Code terminal worktree session prompt targets through the chat service', async () => {
    // Terminal-backed tabs are routed by `sendWorktreeChatMessage` to the
    // renderer's terminal send path rather than rejected here.
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([targetChatTab({ interfaceMode: 'auto' })]),
    );
    const { service } = makeService();
    const created = await service.create({
      name: 'Terminal target',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_session_prompt',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        prompt: 'Continue',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: { status: 'success' },
    });
    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        text: 'Continue',
        initiationSource: 'automation',
        interfaceMode: 'auto',
      }),
      expect.any(Object),
    );
  });

  it('forces terminal-backed worktree session prompt targets to native chat mode when Claude TUI chats are disabled', async () => {
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiChats.key,
      false,
    );
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([
        targetChatTab({
          interfaceMode: 'auto',
          sdkSessionId: 'terminal-session',
        }),
      ]),
    );
    const { service } = makeService();
    const created = await service.create({
      name: 'Terminal target',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_session_prompt',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        prompt: 'Continue',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: { status: 'success' },
    });
    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
    );
    expect(mockedSendWorktreeChatMessage.mock.calls[0]?.[0]).not.toHaveProperty(
      'interfaceMode',
    );
    expect(mockedSendWorktreeChatMessage.mock.calls[0]?.[0]).not.toHaveProperty(
      'sdkSessionId',
    );
  });

  it('dispatches worktree session prompt actions against a cowork-shaped target (workspaceId, home, chatId)', async () => {
    // Cowork chats persist under the same (workspaceId, worktreeId, chatId)
    // shape as worktree chats, keyed with the fixed COWORK_HOME_WORKTREE_ID
    // ('home') worktree id. `readChatTabsFile`/`sendWorktreeChatMessage` are
    // both generic over that key, so a Home-composer scheduled send targeting
    // a cowork tab (Task C3) should execute through this same path with no
    // cowork-specific branching required.
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([targetChatTab({ id: 'cowork-chat-1' })]),
    );
    const { service } = makeService();
    const created = await service.create({
      name: 'Cowork scheduled message',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_session_prompt',
        workspaceId: 'cowork-1',
        worktreeId: COWORK_HOME_WORKTREE_ID,
        chatId: 'cowork-chat-1',
        prompt: 'Continue',
        purpose: 'scheduled_send',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: { status: 'success' },
    });
    expect(mockedReadChatTabsFile).toHaveBeenCalledWith(
      'cowork-1',
      COWORK_HOME_WORKTREE_ID,
    );
    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'cowork-1',
        worktreeId: COWORK_HOME_WORKTREE_ID,
        chatId: 'cowork-chat-1',
        text: 'Continue',
        initiationSource: 'automation',
      }),
      expect.any(Object),
    );
  });

  it('dispatches session prompt actions against an existing App Advisor chat', async () => {
    mockedReadChatTabsFile.mockResolvedValue(
      chatTabsFile([targetChatTab({ id: 'advisor-chat-1' })]),
    );
    const { service, ensureAppAdvisorWindow } = makeService();
    const created = await service.create({
      name: 'App Advisor scheduled message',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_session_prompt',
        workspaceId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        chatId: 'advisor-chat-1',
        prompt: 'Continue',
        purpose: 'scheduled_send',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: { status: 'success' },
    });
    expect(mockedReadChatTabsFile).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      APP_ADVISOR_WORKTREE_ID,
    );
    expect(ensureAppAdvisorWindow).toHaveBeenCalledTimes(1);
    expect(mockedSendWorktreeChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        chatId: 'advisor-chat-1',
        text: 'Continue',
        initiationSource: 'automation',
      }),
      expect.any(Object),
    );
    const dispatchOptions = mockedSendWorktreeChatMessage.mock.calls[0]?.[1];
    expect(dispatchOptions?.appAdvisorSurfaces?.getAppAdvisorWindow).toEqual(
      expect.any(Function),
    );
    expect(dispatchOptions?.appAdvisorSurfaces?.openAppAdvisorWindow).toEqual(
      expect.any(Function),
    );
  });

  it.each([false, true])(
    'resolves an undownloaded curated automation before dispatch with context enforcement=%s',
    async (enabled): Promise<void> => {
      mockFeatureFlagValues.set(
        CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
        enabled,
      );
      mockBackgroundDecide.mockImplementation((input) =>
        Promise.resolve(decideResourceContext(input, { strict: true })),
      );
      mockGetManagedCuratedPipeline.mockResolvedValue({
        info: {
          id: 'curated:review',
          source: 'curated',
          curatedContentHash: 'a'.repeat(64),
        },
        content: { name: 'Curated review', on: 'dispatch', jobs: {} },
      });
      const { service } = makeService();
      const created = await service.create({
        name: 'Curated review',
        schedule: {
          kind: 'one_time',
          runAt: '2026-05-28T12:30:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'worktree_pipeline',
          workspaceId: 'workspace-1',
          pipelineId: 'curated:review',
          pipelineSource: 'curated',
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok || !created.activity) throw new Error('create failed');
      await expect(
        service.runNow({ id: created.activity.id }),
      ).resolves.toMatchObject({
        ok: true,
        run: { status: 'success' },
      });
      expect(mockGetManagedCuratedPipeline).toHaveBeenCalledWith(
        'curated:review',
      );
      expect(mockGetManagedCuratedPipeline).toHaveBeenCalledTimes(
        enabled ? 5 : 3,
      );
      if (!enabled) expect(mockBackgroundDecide).not.toHaveBeenCalled();
      expect(mockedGetStoredPipelineBySource).not.toHaveBeenCalled();
      const startArgs = mockedStartPipelineExecutionFromMain.mock.calls[0]?.[0];
      expect(startArgs?.pipeline.name).toBe('Curated review');
      expect(startArgs?.options.pipelinePreferenceLocator).toEqual({
        type: 'stored',
        source: 'curated',
        value: 'curated:review',
        contentHash: 'a'.repeat(64),
      });
    },
  );

  it('runs bundled dispatch pipeline activities with selected inputs', async () => {
    const { service } = makeService();
    const agentAuthor = {
      chat: { projectId: 'project-1', worktreeId: 'task-1', chatId: 'chat-1' },
      recordedAt: '2026-10-19T00:00:00.000Z',
    };
    const created = await service.create(
      {
        name: 'Bundled pipeline',
        schedule: {
          kind: 'one_time',
          runAt: '2026-05-28T12:30:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'worktree_pipeline',
          workspaceId: 'workspace-1',
          pipelineId: 'bundled-dispatch',
          pipelineSource: 'bundled',
          pipelineName: 'Bundled dispatch',
          inputs: { environment: 'staging' },
          pluginCollectionPreferences: {
            'collection-1': {
              disabledDefaultKeys: ['optional-skill'],
              extraSelections: {
                collectionIds: [],
                skillRefs: [],
                pluginRefs: [],
              },
            },
          },
          modelAliasPreferences: {
            reviewer: { mode: 'reset' },
          },
        },
      },
      { agentAuthor },
    );
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        status: 'success',
        result: {
          projectId: 'workspace-1',
          worktreeId: 'worktree-new',
          pipelineExecutionId: 'execution-1',
        },
      },
    });
    // The run records the automation that started it and the agent that wrote it.
    expect(
      mockedStartPipelineExecutionFromMain.mock.calls[0]?.[0].options,
    ).toMatchObject({
      initiator: {
        kind: 'automation',
        automationId: created.activity.id,
        automationName: 'Bundled pipeline',
      },
      agentOrigin: agentAuthor.chat,
    });

    expect(mockedDiscoverProjectPipelines).not.toHaveBeenCalled();
    expect(mockedGetStoredPipelineBySource).toHaveBeenCalledWith(
      'bundled',
      'bundled-dispatch',
    );
    expect(mockedStartPipelineExecutionFromMain).toHaveBeenCalledTimes(1);
    const startArgs = mockedStartPipelineExecutionFromMain.mock.calls[0]?.[0];
    if (!startArgs) throw new Error('pipeline execution was not started');
    expect(startArgs.pipeline.name).toBe('Bundled dispatch');
    expect(startArgs.options).toMatchObject({
      projectId: 'workspace-1',
      worktreeId: 'worktree-new',
      pipelineId: 'bundled-dispatch',
      inputs: { environment: 'staging' },
      pipelinePreferenceLocator: {
        type: 'stored',
        source: 'bundled',
        value: 'bundled-dispatch',
      },
      pluginCollectionPreferences: {
        'collection-1': {
          disabledDefaultKeys: ['optional-skill'],
          extraSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
          },
        },
      },
      modelAliasPreferences: {
        reviewer: { mode: 'reset' },
      },
    });
  });

  it('passes an automation-owned bundled-pipeline package into execution', async () => {
    const capabilityPackage = {
      version: 1 as const,
      digest: `pp:v1:${'A'.repeat(43)}`,
    };
    const pipelinePackage = {
      digest: capabilityPackage.digest,
      rawPipeline: 'pipeline:\n  name: Bundled dispatch\n  jobs: {}\n',
      manifest: {
        version: 1 as const,
        pipelineContentHash: 'a'.repeat(64),
        resources: [],
        bindings: [],
        environmentRequirements: [],
        totalFiles: 0,
        totalBytes: 0,
      },
      cachedPackagePath: '/tmp/package',
    };
    mockedResolveInstalledAutomationPipelinePackage.mockResolvedValue(
      pipelinePackage,
    );
    const { service } = makeService();
    const created = await service.create({
      name: 'Installed bundled pipeline',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'installed-bundled-pipeline',
        pipelineSource: 'user',
      },
      installedFrom: {
        remoteId: 'public-share-1',
        contentHash: 'b'.repeat(64),
        installedAt: '2026-05-28T12:00:00.000Z',
        sourceKind: 'public',
        bundledPipelineLocalId: 'installed-bundled-pipeline',
        capabilityPackage,
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({ ok: true, run: { status: 'success' } });
    expect(
      mockedResolveInstalledAutomationPipelinePackage,
    ).toHaveBeenCalledWith(
      created.activity.id,
      'installed-bundled-pipeline',
      capabilityPackage,
    );
    expect(
      mockedStartPipelineExecutionFromMain.mock.calls[0]?.[0]?.options
        .automationPipelinePackage,
    ).toBe(pipelinePackage);
  });

  it('does not apply the bundled-pipeline package after rebinding the automation', async () => {
    const capabilityPackage = {
      version: 1 as const,
      digest: `pp:v1:${'A'.repeat(43)}`,
    };
    mockedResolveInstalledAutomationPipelinePackage.mockResolvedValue({
      digest: capabilityPackage.digest,
      rawPipeline: 'pipeline:\n  name: Original bundled pipeline\n  jobs: {}\n',
      manifest: {
        version: 1,
        pipelineContentHash: 'a'.repeat(64),
        resources: [],
        bindings: [],
        environmentRequirements: [],
        totalFiles: 0,
        totalBytes: 0,
      },
      cachedPackagePath: '/tmp/original-package',
    });
    const { service } = makeService();
    const created = await service.create({
      name: 'Installed bundled pipeline',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'installed-bundled-pipeline',
        pipelineSource: 'user',
      },
      installedFrom: {
        remoteId: 'public-share-1',
        contentHash: 'b'.repeat(64),
        installedAt: '2026-05-28T12:00:00.000Z',
        sourceKind: 'public',
        bundledPipelineLocalId: 'installed-bundled-pipeline',
        capabilityPackage,
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');
    await expect(
      service.update({
        id: created.activity.id,
        action: {
          type: 'worktree_pipeline',
          workspaceId: 'workspace-1',
          pipelineId: 'another-pipeline',
          pipelineSource: 'user',
        },
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({ ok: true, run: { status: 'success' } });
    expect(
      mockedResolveInstalledAutomationPipelinePackage,
    ).not.toHaveBeenCalled();
    expect(
      mockedStartPipelineExecutionFromMain.mock.calls[0]?.[0]?.options
        .automationPipelinePackage,
    ).toBeUndefined();
  });

  it.each(['workspace-1', 'cowork-1'])(
    'authorizes a fetched shared automation before dispatch in %s',
    async (workspaceId): Promise<void> => {
      mockFeatureFlagValues.set(
        CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
        true,
      );
      mockBackgroundDecide.mockImplementation((input) =>
        Promise.resolve(decideResourceContext(input, { strict: true })),
      );
      jest.mocked(getSharedPipeline).mockResolvedValue({
        id: 'remote-1',
        name: 'Shared',
        version: '1',
        rawPipeline:
          'name: Shared\non: dispatch\njobs:\n  build:\n    steps: []\n',
        shareScope: 'private',
        triggerTypes: ['dispatch'],
        createdBy: { id: 'user-1', name: 'User' },
        createdAt: '2026-05-28T12:00:00.000Z',
        updatedAt: '2026-05-28T12:00:00.000Z',
        canUpdate: true,
        canDelete: true,
      });
      const { service } = makeService();
      const created = await service.create({
        name: 'Shared strict',
        schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
        action: {
          type: 'worktree_pipeline',
          workspaceId,
          pipelineId: 'shared:canopy-cloud:remote-1',
          pipelineSource: 'shared',
          sharedPipeline: {
            serverId: 'canopy-cloud',
            remoteId: 'remote-1',
            installPin: {
              pipelineContentHash: 'a'.repeat(64),
              distributionMode: 'definition_only',
            },
          },
        },
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      const result = await service.runNow({ id: created.activity.id });
      expect(result.run).toMatchObject({ status: 'success' });
      expect(getSharedPipeline).toHaveBeenCalledWith('remote-1');
      expect(mockedStartPipelineExecutionFromMain).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps a shared-pipeline automation enabled after a transient preflight read failure', async () => {
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    const { service } = makeService();
    const created = await service.create({
      name: 'Shared retry',
      schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'shared:canopy-cloud:remote-1',
        pipelineSource: 'shared',
        sharedPipeline: {
          serverId: 'canopy-cloud',
          remoteId: 'remote-1',
          installPin: {
            pipelineContentHash: 'a'.repeat(64),
            distributionMode: 'definition_only',
          },
        },
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');
    // The definition can become unreadable after a valid create.
    jest
      .mocked(getSharedPipeline)
      .mockRejectedValue(
        new CanopyCloudClientError('network-error', 'offline'),
      );
    const failed = await service.runNow({ id: created.activity.id });
    expect(failed.run).toMatchObject({
      status: 'failure',
      error: backgroundExecutionUnavailableMessage(),
    });
    expect((await service.list()).activities[0]).toMatchObject({
      enabled: true,
    });
    expect(mockedStartPipelineExecutionFromMain).not.toHaveBeenCalled();
  });

  it.each([
    {
      failure: 'a transient dispatch read',
      dispatchError: backgroundExecutionRetryMessage('run'),
      expectedError: backgroundExecutionUnavailableMessage(),
      enabled: true,
    },
    {
      failure: 'a revoked share at dispatch',
      dispatchError: backgroundExecutionDeniedMessage('access-removed'),
      expectedError: backgroundExecutionDeniedMessage('access-removed', {
        turnedOff: true,
      }),
      enabled: false,
    },
  ])(
    'handles $failure after shared automation preflight',
    async ({ dispatchError, expectedError, enabled }) => {
      mockFeatureFlagValues.set(
        CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
        true,
      );
      jest.mocked(getSharedPipeline).mockResolvedValue({
        id: 'remote-1',
        name: 'Shared',
        version: '1',
        rawPipeline:
          'name: Shared\non: dispatch\njobs:\n  build:\n    steps: []\n',
        shareScope: 'private',
        triggerTypes: ['dispatch'],
        createdBy: { id: 'user-1', name: 'User' },
        createdAt: '2026-05-28T12:00:00.000Z',
        updatedAt: '2026-05-28T12:00:00.000Z',
        canUpdate: true,
        canDelete: true,
      });
      mockedStartPipelineExecutionFromMain.mockResolvedValueOnce({
        success: false,
        error: dispatchError,
      });
      const { service } = makeService();
      const created = await service.create({
        name: 'Shared dispatch read',
        schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
        action: {
          type: 'worktree_pipeline',
          workspaceId: 'workspace-1',
          pipelineId: 'shared:canopy-cloud:remote-1',
          pipelineSource: 'shared',
          sharedPipeline: {
            serverId: 'canopy-cloud',
            remoteId: 'remote-1',
            installPin: {
              pipelineContentHash: 'a'.repeat(64),
              distributionMode: 'definition_only',
            },
          },
        },
      });
      if (!created.ok || !created.activity) throw new Error('create failed');

      const failed = await service.runNow({ id: created.activity.id });
      expect(mockedStartPipelineExecutionFromMain).toHaveBeenCalledTimes(1);
      expect(failed.run).toMatchObject({
        status: 'failure',
        error: expectedError,
      });
      expect((await service.list()).activities[0]).toMatchObject({ enabled });
    },
  );

  it.each([
    [
      'the share is gone',
      new CanopyCloudClientError(
        'http-error',
        'gone',
        404,
        undefined,
        undefined,
        true,
      ),
    ],
    [
      'the account changed or signed out during the read',
      new Error('Pipeline unavailable (access-removed)'),
    ],
  ])(
    'turns off a shared-pipeline automation when %s',
    async (_case, error): Promise<void> => {
      mockFeatureFlagValues.set(
        CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
        true,
      );
      const { service } = makeService();
      const created = await service.create({
        name: 'Shared removed',
        schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
        action: {
          type: 'worktree_pipeline',
          workspaceId: 'workspace-1',
          pipelineId: 'shared:canopy-cloud:remote-1',
          pipelineSource: 'shared',
          sharedPipeline: {
            serverId: 'canopy-cloud',
            remoteId: 'remote-1',
            installPin: {
              pipelineContentHash: 'a'.repeat(64),
              distributionMode: 'definition_only',
            },
          },
        },
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      jest.mocked(getSharedPipeline).mockRejectedValueOnce(error);
      const failed = await service.runNow({ id: created.activity.id });
      expect(failed.run).toMatchObject({
        status: 'failure',
        error: backgroundExecutionDeniedMessage('access-removed', {
          turnedOff: true,
        }),
      });
      expect((await service.list()).activities[0]).toMatchObject({
        enabled: false,
      });
      expect(mockedStartPipelineExecutionFromMain).not.toHaveBeenCalled();
    },
  );

  it('refuses turning on a shared-pipeline automation whose share is gone', async () => {
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    jest
      .mocked(getSharedPipeline)
      .mockRejectedValueOnce(
        new CanopyCloudClientError(
          'http-error',
          'gone',
          404,
          undefined,
          undefined,
          true,
        ),
      );
    const { service } = makeService();
    await expect(
      service.create({
        name: 'Shared removed before turn-on',
        schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
        action: {
          type: 'worktree_pipeline',
          workspaceId: 'workspace-1',
          pipelineId: 'shared:canopy-cloud:remote-1',
          pipelineSource: 'shared',
          sharedPipeline: {
            serverId: 'canopy-cloud',
            remoteId: 'remote-1',
            installPin: {
              pipelineContentHash: 'a'.repeat(64),
              distributionMode: 'definition_only',
            },
          },
        },
      }),
    ).resolves.toEqual({
      ok: false,
      error: backgroundExecutionDeniedMessage('access-removed'),
    });
    expect((await service.list()).activities).toEqual([]);
  });

  it.each(['workspace-1', 'cowork-1'])(
    'validates unpinned shared-pipeline authoring and replacement in %s',
    async (workspaceId): Promise<void> => {
      const { service } = makeService();
      const action: AutomationAction = {
        type: 'worktree_pipeline',
        workspaceId,
        pipelineId: 'shared:canopy-cloud:remote-1',
        pipelineSource: 'shared',
        sharedPipeline: { serverId: 'canopy-cloud', remoteId: 'remote-1' },
      };
      const created = await service.create({
        name: 'Unpinned authored pipeline',
        enabled: false,
        schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
        action,
      });
      expect(created).toMatchObject({ ok: true });
      if (!created.ok || !created.activity) throw new Error('create failed');
      const updated = await service.update({
        id: created.activity.id,
        action: {
          ...action,
          pipelineId: 'shared:canopy-cloud:remote-2',
          sharedPipeline: { serverId: 'canopy-cloud', remoteId: 'remote-2' },
        },
        enabled: true,
      });
      expect(updated).toMatchObject({ ok: true });
      await expect(
        service.runNow({ id: created.activity.id }),
      ).resolves.toMatchObject({ ok: true, run: { status: 'success' } });
      const detail = await getSharedPipeline('remote-2');
      jest.mocked(getSharedPipeline).mockResolvedValue({
        ...detail,
        rawPipeline: 'name: Shared\non: dispatch\nscope: global\njobs: {}\n',
      });
      const refusedRun = await service.runNow({ id: created.activity.id });
      expect(refusedRun).toMatchObject({
        ok: true,
        run: { status: 'failure' },
      });
      if (!refusedRun.ok) throw new Error(refusedRun.error);
      expect(refusedRun.run?.error).toContain('compatible');
      expect(mockedStartPipelineExecutionFromMain).toHaveBeenCalledTimes(1);
    },
  );

  it('carries a shared-pipeline install pin into execution', async () => {
    const installPin = {
      pipelineContentHash: 'b'.repeat(64),
      distributionMode: 'definition_only' as const,
    };
    const { service } = makeService();
    const created = await service.create({
      name: 'Pinned shared pipeline',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'shared:canopy-cloud:remote-1',
        pipelineSource: 'shared',
        sharedPipeline: {
          serverId: 'canopy-cloud',
          remoteId: 'remote-1',
          installPin,
        },
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({ ok: true, run: { status: 'success' } });
    expect(
      mockedStartPipelineExecutionFromMain.mock.calls[0]?.[0]?.options
        .sharedPipeline,
    ).toEqual({
      serverId: 'canopy-cloud',
      remoteId: 'remote-1',
      installPin,
    });
  });

  it('blocks a pinned shared pipeline for review after a mismatch', async () => {
    const installPin = {
      pipelineContentHash: 'b'.repeat(64),
      distributionMode: 'definition_only' as const,
    };
    mockedStartPipelineExecutionFromMain.mockResolvedValueOnce({
      success: false,
      errorCode: 'shared_pipeline_changed',
      error:
        'The pinned version of "Changed pipeline" could not be verified. Refresh and try again.',
    } as never);
    const { service } = makeService();
    const created = await service.create({
      name: 'Pinned shared pipeline',
      schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'shared:canopy-cloud:remote-1',
        pipelineName: 'Changed pipeline',
        pipelineSource: 'shared',
        sharedPipeline: {
          serverId: 'canopy-cloud',
          remoteId: 'remote-1',
          installPin,
        },
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    const failed = await service.runNow({ id: created.activity.id });
    expect(failed.ok).toBe(true);
    const snapshot = await service.list();
    expect(snapshot.recentRuns[0]?.status).toBe('failure');
    expect(snapshot.recentRuns[0]?.error).toBe(
      'This pipeline was updated, so take a look before it runs again.',
    );
    const activity = snapshot.activities[0];
    if (!activity?.sharedPipelineReview) throw new Error('review not stored');
    expect(activity.enabled).toBe(true);
    expect(typeof activity.sharedPipelineReview.detectedAt).toBe('string');
    expect(activity.sharedPipelineReview).toMatchObject({
      remoteId: 'remote-1',
      pipelineName: 'Changed pipeline',
    });
    await expect(service.runNow({ id: activity.id })).resolves.toEqual({
      ok: false,
      error: 'This pipeline was updated, so take a look before it runs again.',
    });

    jest.setSystemTime(new Date('2026-05-28T13:00:00.000Z'));
    await (
      service as unknown as { runDueCheck(): Promise<void> }
    ).runDueCheck();
    const skipped = await service.list();
    expect(skipped.recentRuns).toHaveLength(1);
    expect(skipped.activities[0]?.nextRunAt).toBe('2026-05-28T14:00:00.000Z');
    expect(mockedStartPipelineExecutionFromMain).toHaveBeenCalledTimes(1);
  });

  it('keeps a one-time activity enabled when its scheduled run needs shared-pipeline review', async () => {
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      true,
    );
    jest.mocked(getSharedPipeline).mockResolvedValue({
      id: 'remote-1',
      name: 'Changed pipeline',
      version: '1',
      rawPipeline:
        'name: Changed pipeline\non: dispatch\njobs:\n  build:\n    steps: []\n',
      shareScope: 'private',
      triggerTypes: ['dispatch'],
      createdBy: { id: 'user-1', name: 'User' },
      createdAt: '2026-05-28T12:00:00.000Z',
      updatedAt: '2026-05-28T12:00:00.000Z',
      canUpdate: true,
      canDelete: true,
    });
    const installPin = {
      pipelineContentHash: 'b'.repeat(64),
      distributionMode: 'definition_only' as const,
    };
    let resolveStart!: (value: {
      success: false;
      errorCode: 'shared_pipeline_changed';
      error: string;
    }) => void;
    let markStart!: () => void;
    const startCalled = new Promise<void>((resolve) => {
      markStart = resolve;
    });
    mockedStartPipelineExecutionFromMain.mockImplementationOnce(() => {
      markStart();
      return new Promise((resolve) => {
        resolveStart = resolve;
      });
    });
    const { service } = makeService();
    const created = await service.create({
      name: 'One-time pinned shared pipeline',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:00:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'shared:canopy-cloud:remote-1',
        pipelineName: 'Changed pipeline',
        pipelineSource: 'shared',
        sharedPipeline: {
          serverId: 'canopy-cloud',
          remoteId: 'remote-1',
          installPin,
        },
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await (
      service as unknown as { runDueCheck(): Promise<void> }
    ).runDueCheck();
    await startCalled;
    expect(mockedStartPipelineExecutionFromMain).toHaveBeenCalledTimes(1);
    jest.setSystemTime(new Date('2026-05-28T12:01:00.000Z'));
    await expect(
      service.update({
        id: created.activity.id,
        name: 'Renamed while review mismatch was resolving',
      }),
    ).resolves.toMatchObject({ ok: true });
    resolveStart({
      success: false,
      errorCode: 'shared_pipeline_changed',
      error: 'changed',
    });
    await flushAutomationWrites(service);

    const activity = (await service.list()).activities[0];
    expect(activity?.sharedPipelineReview).toBeDefined();
    expect(activity?.enabled).toBe(true);
    expect(activity?.name).toBe('Renamed while review mismatch was resolving');

    const reviewedPin = {
      pipelineContentHash: 'c'.repeat(64),
      distributionMode: 'definition_only' as const,
    };
    await expect(
      service.approveSharedPipelineReview({
        id: created.activity.id,
        installPin: reviewedPin,
      }),
    ).resolves.toMatchObject({ ok: true });
    const approved = (await service.list()).activities[0];
    expect(approved?.enabled).toBe(false);
    expect(approved?.sharedPipelineReview).toBeUndefined();
  });

  it('does not restore a one-time slot consumed while shared-pipeline review is pending', async () => {
    const oldPin = {
      pipelineContentHash: 'a'.repeat(64),
      distributionMode: 'definition_only' as const,
    };
    const reviewedPin = {
      pipelineContentHash: 'b'.repeat(64),
      distributionMode: 'definition_only' as const,
    };
    mockedStartPipelineExecutionFromMain.mockResolvedValueOnce({
      success: false,
      errorCode: 'shared_pipeline_changed',
      error: 'changed',
    });
    const { service } = makeService();
    const created = await service.create({
      name: 'One-time pinned shared pipeline',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'shared:canopy-cloud:remote-1',
        pipelineSource: 'shared',
        sharedPipeline: {
          serverId: 'canopy-cloud',
          remoteId: 'remote-1',
          installPin: oldPin,
        },
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await service.runNow({ id: created.activity.id });
    jest.setSystemTime(new Date('2026-05-28T12:31:00.000Z'));
    await (
      service as unknown as { runDueCheck(): Promise<void> }
    ).runDueCheck();
    const pending = (await service.list()).activities[0];
    expect(pending?.lastScheduledFor).toBe('2026-05-28T12:30:00.000Z');
    expect(pending?.nextRunAt).toBeUndefined();
    expect(pending?.enabled).toBe(true);

    await expect(
      service.approveSharedPipelineReview({
        id: created.activity.id,
        installPin: reviewedPin,
        runNow: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      run: { status: 'success' },
    });
    const approved = (await service.list()).activities[0];
    expect(approved?.enabled).toBe(false);
    expect(approved?.nextRunAt).toBeUndefined();

    await (
      service as unknown as { runDueCheck(): Promise<void> }
    ).runDueCheck();
    await flushAutomationWrites(service);
    expect(mockedStartPipelineExecutionFromMain).toHaveBeenCalledTimes(2);
  });

  it('does not restore an overdue one-time slot when manual review is approved', async () => {
    const oldPin = {
      pipelineContentHash: 'a'.repeat(64),
      distributionMode: 'definition_only' as const,
    };
    const reviewedPin = {
      pipelineContentHash: 'b'.repeat(64),
      distributionMode: 'definition_only' as const,
    };
    mockedStartPipelineExecutionFromMain.mockResolvedValueOnce({
      success: false,
      errorCode: 'shared_pipeline_changed',
      error: 'changed',
    });
    const { service } = makeService();
    const created = await service.create({
      name: 'Overdue one-time pinned shared pipeline',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T11:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'shared:canopy-cloud:remote-1',
        pipelineSource: 'shared',
        sharedPipeline: {
          serverId: 'canopy-cloud',
          remoteId: 'remote-1',
          installPin: oldPin,
        },
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await service.runNow({ id: created.activity.id });
    await expect(
      service.approveSharedPipelineReview({
        id: created.activity.id,
        installPin: reviewedPin,
      }),
    ).resolves.toMatchObject({ ok: true });
    const approved = (await service.list()).activities[0];
    expect(approved?.enabled).toBe(false);
    expect(approved?.nextRunAt).toBeUndefined();

    await (
      service as unknown as { runDueCheck(): Promise<void> }
    ).runDueCheck();
    await flushAutomationWrites(service);
    expect(mockedStartPipelineExecutionFromMain).toHaveBeenCalledTimes(1);
  });

  it('does not apply an in-flight mismatch to a retargeted automation', async () => {
    const installPin = {
      pipelineContentHash: 'a'.repeat(64),
      distributionMode: 'definition_only' as const,
    };
    let resolveStart!: (value: {
      success: false;
      errorCode: 'shared_pipeline_changed';
      error: string;
    }) => void;
    mockedStartPipelineExecutionFromMain.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    );
    const { service } = makeService();
    const created = await service.create({
      name: 'Pinned shared pipeline',
      schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'shared:canopy-cloud:remote-1',
        pipelineSource: 'shared',
        sharedPipeline: {
          serverId: 'canopy-cloud',
          remoteId: 'remote-1',
          installPin,
        },
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    void service.runNow({ id: created.activity.id });
    const internal = service as unknown as {
      file: { activities: ScheduledActivity[] };
      writeQueue: Promise<unknown>;
    };
    await internal.writeQueue;
    await flushAsyncWork();
    expect(mockedStartPipelineExecutionFromMain).toHaveBeenCalledTimes(1);
    const current = internal.file.activities[0];
    if (!current) throw new Error('activity missing');
    // Simulate the serialized update mutation landing while execution is in
    // flight without contending on the target-start reservation held by the run.
    current.action = {
      type: 'worktree_pipeline',
      workspaceId: 'workspace-1',
      pipelineId: 'shared:canopy-cloud:remote-2',
      pipelineSource: 'shared',
      sharedPipeline: {
        serverId: 'canopy-cloud',
        remoteId: 'remote-2',
        installPin: {
          pipelineContentHash: 'b'.repeat(64),
          distributionMode: 'definition_only',
        },
      },
    };
    resolveStart({
      success: false,
      errorCode: 'shared_pipeline_changed',
      error: 'changed',
    });
    await flushAsyncWork();
    await internal.writeQueue;

    const updated = internal.file.activities[0];
    expect(internal.file.activities).toHaveLength(1);
    expect(updated?.sharedPipelineReview).toBeUndefined();
    expect(
      updated?.action.type === 'worktree_pipeline'
        ? updated.action.sharedPipeline?.remoteId
        : undefined,
    ).toBe('remote-2');
  });

  it('approves the reviewed pin, clears the block, and can run immediately', async () => {
    const oldPin = {
      pipelineContentHash: 'a'.repeat(64),
      distributionMode: 'definition_only' as const,
    };
    const reviewedPin = {
      pipelineContentHash: 'b'.repeat(64),
      distributionMode: 'definition_only' as const,
    };
    mockedStartPipelineExecutionFromMain.mockResolvedValueOnce({
      success: false,
      errorCode: 'shared_pipeline_changed',
      error: 'changed',
    });
    const { service } = makeService();
    const created = await service.create({
      name: 'Pinned shared pipeline',
      schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'shared:canopy-cloud:remote-1',
        pipelineName: 'Shared pipeline',
        pipelineSource: 'shared',
        sharedPipeline: {
          serverId: 'canopy-cloud',
          remoteId: 'remote-1',
          installPin: oldPin,
        },
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');
    await service.runNow({ id: created.activity.id });

    await expect(
      service.approveSharedPipelineReview({
        id: created.activity.id,
        installPin: reviewedPin,
        runNow: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      activity: { id: created.activity.id },
      run: { status: 'success' },
    });
    expect(mockedVerifySharedPipelineAutomationInstallPin).toHaveBeenCalledWith(
      'remote-1',
      reviewedPin,
    );
    const approved = (await service.list()).activities[0];
    expect(approved.sharedPipelineReview).toBeUndefined();
    expect(
      approved.action.type === 'worktree_pipeline'
        ? approved.action.sharedPipeline?.installPin
        : undefined,
    ).toEqual(reviewedPin);
  });

  it('preserves the previous pin and review when an approved version cannot run in the target', async () => {
    const oldPin = {
      pipelineContentHash: 'a'.repeat(64),
      distributionMode: 'definition_only' as const,
    };
    const reviewedPin = { ...oldPin, pipelineContentHash: 'b'.repeat(64) };
    mockedStartPipelineExecutionFromMain.mockResolvedValueOnce({
      success: false,
      errorCode: 'shared_pipeline_changed',
      error: 'changed',
    });
    const { service } = makeService();
    const created = await service.create({
      name: 'Cowork pinned pipeline',
      targetRequirement: { contexts: ['cowork'] },
      schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'cowork-1',
        pipelineId: 'shared:canopy-cloud:remote-1',
        pipelineSource: 'shared',
        sharedPipeline: {
          serverId: 'canopy-cloud',
          remoteId: 'remote-1',
          installPin: oldPin,
        },
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');
    await service.runNow({ id: created.activity.id });
    const before = (await service.list()).activities[0];
    expect(before.sharedPipelineReview).toBeDefined();
    const detail = await getSharedPipeline('remote-1');
    jest.mocked(getSharedPipeline).mockResolvedValue({
      ...detail,
      rawPipeline: 'name: Shared\non: dispatch\nscope: worktree\njobs: {}\n',
    });

    const approval = await service.approveSharedPipelineReview({
      id: created.activity.id,
      installPin: reviewedPin,
      runNow: true,
    });
    expect(approval.ok).toBe(false);
    expect(approval.error).toContain('compatible');
    expect((await service.list()).activities[0]).toEqual(before);
    expect(mockedStartPipelineExecutionFromMain).toHaveBeenCalledTimes(1);
  });

  it('advances a cron slot that became due before shared-pipeline approval', async () => {
    const oldPin = {
      pipelineContentHash: 'a'.repeat(64),
      distributionMode: 'definition_only' as const,
    };
    const reviewedPin = {
      pipelineContentHash: 'b'.repeat(64),
      distributionMode: 'definition_only' as const,
    };
    mockedStartPipelineExecutionFromMain.mockResolvedValueOnce({
      success: false,
      errorCode: 'shared_pipeline_changed',
      error: 'changed',
    });
    const { service } = makeService();
    const created = await service.create({
      name: 'Pinned shared pipeline',
      schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'shared:canopy-cloud:remote-1',
        pipelineSource: 'shared',
        sharedPipeline: {
          serverId: 'canopy-cloud',
          remoteId: 'remote-1',
          installPin: oldPin,
        },
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await service.runNow({ id: created.activity.id });
    expect((await service.list()).activities[0]?.nextRunAt).toBe(
      '2026-05-28T13:00:00.000Z',
    );

    jest.setSystemTime(new Date('2026-05-28T13:01:00.000Z'));
    await expect(
      service.approveSharedPipelineReview({
        id: created.activity.id,
        installPin: reviewedPin,
      }),
    ).resolves.toMatchObject({ ok: true });

    expect((await service.list()).activities[0]?.nextRunAt).toBe(
      '2026-05-28T14:00:00.000Z',
    );
    await (
      service as unknown as { runDueCheck(): Promise<void> }
    ).runDueCheck();
    await flushAutomationWrites(service);
    expect(mockedStartPipelineExecutionFromMain).toHaveBeenCalledTimes(1);
    expect((await service.list()).recentRuns).toHaveLength(1);
  });

  it('keeps approval successful when the optional immediate run cannot start', async () => {
    const oldPin = {
      pipelineContentHash: 'a'.repeat(64),
      distributionMode: 'definition_only' as const,
    };
    const reviewedPin = {
      pipelineContentHash: 'b'.repeat(64),
      distributionMode: 'definition_only' as const,
    };
    mockedStartPipelineExecutionFromMain.mockResolvedValueOnce({
      success: false,
      errorCode: 'shared_pipeline_changed',
      error: 'changed',
    } as never);
    const { service } = makeService();
    const created = await service.create({
      name: 'Pinned shared pipeline',
      schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'shared:canopy-cloud:remote-1',
        pipelineSource: 'shared',
        sharedPipeline: {
          serverId: 'canopy-cloud',
          remoteId: 'remote-1',
          installPin: oldPin,
        },
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');
    await service.runNow({ id: created.activity.id });
    jest
      .spyOn(service, 'runNow')
      .mockResolvedValueOnce({ ok: false, error: 'Target is busy.' });

    await expect(
      service.approveSharedPipelineReview({
        id: created.activity.id,
        installPin: reviewedPin,
        runNow: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      activity: { id: created.activity.id },
      runError: 'Target is busy.',
    });
    expect((await service.list()).activities[0]?.sharedPipelineReview).toBe(
      undefined,
    );
  });

  it('fails closed when the pipeline changes again during approval', async () => {
    const oldPin = {
      pipelineContentHash: 'a'.repeat(64),
      distributionMode: 'definition_only' as const,
    };
    const reviewedPin = { ...oldPin, pipelineContentHash: 'b'.repeat(64) };
    mockedStartPipelineExecutionFromMain.mockResolvedValueOnce({
      success: false,
      errorCode: 'shared_pipeline_changed',
      error: 'changed',
    });
    const { service } = makeService();
    const created = await service.create({
      name: 'Pinned shared pipeline',
      schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'shared:canopy-cloud:remote-1',
        pipelineSource: 'shared',
        sharedPipeline: {
          serverId: 'canopy-cloud',
          remoteId: 'remote-1',
          installPin: oldPin,
        },
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');
    await service.runNow({ id: created.activity.id });
    mockedVerifySharedPipelineAutomationInstallPin.mockRejectedValueOnce(
      new SharedPipelinePinMismatchError('remote-1', 'Shared pipeline'),
    );

    await expect(
      service.approveSharedPipelineReview({
        id: created.activity.id,
        installPin: reviewedPin,
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'This pipeline was updated again, so take another look.',
    });
    const activity = (await service.list()).activities[0];
    expect(activity.sharedPipelineReview).toBeDefined();
    expect(
      activity.action.type === 'worktree_pipeline'
        ? activity.action.sharedPipeline?.installPin
        : undefined,
    ).toEqual(oldPin);
  });

  it('preserves review for unrelated edits and clears it when the pin changes', async () => {
    const oldPin = {
      pipelineContentHash: 'a'.repeat(64),
      distributionMode: 'definition_only' as const,
    };
    mockedStartPipelineExecutionFromMain.mockResolvedValueOnce({
      success: false,
      errorCode: 'shared_pipeline_changed',
      error: 'changed',
    });
    const { service } = makeService();
    const created = await service.create({
      name: 'Pinned shared pipeline',
      schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'shared:canopy-cloud:remote-1',
        pipelineSource: 'shared',
        sharedPipeline: {
          serverId: 'canopy-cloud',
          remoteId: 'remote-1',
          installPin: oldPin,
        },
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');
    await service.runNow({ id: created.activity.id });

    const renamed = await service.update({
      id: created.activity.id,
      name: 'Renamed',
    });
    if (!renamed.ok || !renamed.activity) throw new Error('rename failed');
    expect(renamed.activity.sharedPipelineReview).toBeDefined();
    const createdAction = created.activity.action;
    if (createdAction.type !== 'worktree_pipeline') {
      throw new Error('unexpected action');
    }
    const repinned = await service.update({
      id: created.activity.id,
      action: {
        ...createdAction,
        sharedPipeline: {
          ...createdAction.sharedPipeline,
          installPin: { ...oldPin, pipelineContentHash: 'b'.repeat(64) },
        },
      },
    });
    if (!repinned.ok || !repinned.activity) throw new Error('repin failed');
    expect(repinned.activity.sharedPipelineReview).toBeUndefined();
  });

  it.each([
    {
      pipelineSource: 'project' as const,
      workspaceId: 'cowork-1',
      uses: 'builtin/agent-prompt',
    },
    {
      pipelineSource: undefined,
      workspaceId: 'cowork-1',
      uses: 'builtin/agent-prompt',
    },
    {
      pipelineSource: 'project' as const,
      workspaceId: 'workspace-1',
      uses: 'builtin/agent-prompt',
    },
    {
      pipelineSource: 'project' as const,
      workspaceId: 'cowork-1',
      uses: 'plugin/action',
    },
    {
      pipelineSource: 'project' as const,
      workspaceId: 'workspace-1',
      uses: 'plugin/action',
    },
  ])(
    'checks org-bound local pipeline $uses in $workspaceId (source=$pipelineSource)',
    async ({ pipelineSource, workspaceId, uses }) => {
      mockFeatureFlagValues.set(
        CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
        true,
      );
      mockBackgroundContext = 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      mockReadBackgroundWorkspace.mockResolvedValue(
        backgroundWorkspace(mockBackgroundContext.slice(4)),
      );
      mockBackgroundDecide.mockImplementation((input) =>
        Promise.resolve(
          decideResourceContext({
            ...input,
            invocation: {
              ...input.invocation,
              context: input.invocation.executionContext?.startsWith('org:')
                ? {
                    kind: 'organization',
                    organizationId: input.invocation.executionContext.slice(4),
                  }
                : { kind: 'personal' },
            },
          }),
        ),
      );
      jest.mocked(loadProjectPipelineFromDisk).mockResolvedValue({
        name: 'Local',
        on: 'dispatch',
        jobs: {
          build: { steps: [{ uses, with: {} }] },
        },
      });
      const { service } = makeService();
      const created = await service.create({
        name: 'Local org pipeline',
        schedule: {
          kind: 'one_time',
          runAt: '2026-05-28T12:30:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'worktree_pipeline',
          workspaceId,
          pipelineId: 'pipeline-1',
          pipelineSource,
          projectPipelineFilename: 'dispatch.yaml',
        },
      });
      if (!created.ok || !created.activity) throw new Error('create failed');
      if (uses === 'plugin/action') {
        await service.runNow({ id: created.activity.id });
        expect(mockedStartPipelineExecutionFromMain).not.toHaveBeenCalled();
        expect((await service.list()).activities[0]).toMatchObject({
          enabled: false,
          lastResult: {
            status: 'failure',
            message: messageContaining(
              "Couldn't confirm where something this uses came from",
            ),
          },
        });
        return;
      }
      await expect(
        service.runNow({ id: created.activity.id }),
      ).resolves.toMatchObject({ ok: true, run: { status: 'success' } });
      expect(mockedStartPipelineExecutionFromMain).toHaveBeenCalled();
    },
  );

  it.each([undefined, 'repo-1', 'missing-repo'])(
    'validates multi-repo project pipelines against the configured source or selected repo (%s)',
    async (repoId) => {
      mockedReadAllSidebarItems.mockResolvedValue({
        version: 1,
        items: [
          {
            type: 'multi-repo',
            id: 'multi-1',
            name: 'Multi',
            color: 'blue',
            collapsed: false,
            order: 0,
            sourceRepoPath: dataDirPath,
            repos: [
              {
                id: 'repo-1',
                name: 'Repo',
                repoPath: join(dataDirPath, 'repo'),
              },
            ],
            worktrees: [],
          },
        ],
      });
      const { service } = makeService();
      const result = await service.create({
        name: 'Project pipeline',
        enabled: false,
        schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
        action: {
          type: 'worktree_pipeline',
          workspaceId: 'multi-1',
          pipelineId: 'pipeline-1',
          pipelineSource: 'project',
          ...(repoId ? { repoId } : {}),
        },
      });
      if (repoId === 'missing-repo') {
        expect(result).toMatchObject({
          ok: false,
          error: messageContaining('Choose an existing repository'),
        });
        expect(mockedDiscoverProjectPipelines).not.toHaveBeenCalled();
        return;
      }
      expect(result.ok).toBe(true);
      expect(mockedDiscoverProjectPipelines).toHaveBeenCalledWith(
        repoId ? join(dataDirPath, 'repo') : dataDirPath,
      );
      expect(mockedCreateMultiRepoWorktree).not.toHaveBeenCalled();
    },
  );

  it('passes the cowork root as repoPath for project pipelines', async () => {
    const { service } = makeService();
    const created = await service.create({
      name: 'Cowork project pipeline',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'cowork-1',
        pipelineId: 'pipeline-1',
        pipelineSource: 'project',
        projectPipelineFilename: 'dispatch.yaml',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: { status: 'success' },
    });

    const startArgs = mockedStartPipelineExecutionFromMain.mock.calls[0]?.[0];
    if (!startArgs) throw new Error('pipeline execution was not started');
    expect(startArgs.options).toMatchObject({
      cwd: join(dataDirPath, 'workspaces', 'cowork-1', 'home'),
      repoPath: join(dataDirPath, 'workspaces', 'cowork-1', 'home'),
      pipelineFilePath: '/repo/.canopy/pipelines/dispatch.yaml',
    });
  });

  it('runs cowork project pipelines directory-scoped at the cowork root without creating a worktree', async () => {
    const { service } = makeService();
    const created = await service.create({
      name: 'Cowork pipeline',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'cowork-1',
        pipelineId: 'bundled-dispatch',
        pipelineSource: 'bundled',
        pipelineName: 'Bundled dispatch',
        inputs: { environment: 'staging' },
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        status: 'success',
        result: {
          projectId: 'cowork-1',
          pipelineExecutionId: 'execution-1',
        },
      },
    });

    expect(mockedCreateSingleRepoWorktree).not.toHaveBeenCalled();
    expect(mockedCreateMultiRepoWorktree).not.toHaveBeenCalled();
    expect(mockedStartPipelineExecutionFromMain).toHaveBeenCalledTimes(1);
    const startArgs = mockedStartPipelineExecutionFromMain.mock.calls[0]?.[0];
    if (!startArgs) throw new Error('pipeline execution was not started');
    expect(startArgs.options).toMatchObject({
      cwd: join(dataDirPath, 'workspaces', 'cowork-1', 'home'),
      projectId: 'cowork-1',
      pipelineId: 'bundled-dispatch',
      inputs: { environment: 'staging' },
    });
    expect(startArgs.options.worktreeId).toBeUndefined();
  });

  it('rejects cowork project pipelines that carry a base worktree', async () => {
    const { service } = makeService();
    const created = await service.create({
      name: 'Cowork pipeline',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'cowork-1',
        baseWorktreeId: 'worktree-1',
        pipelineId: 'bundled-dispatch',
        pipelineSource: 'bundled',
      },
    });
    if (!created.ok || !created.activity) throw new Error('create failed');

    await expect(
      service.runNow({ id: created.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        status: 'failure',
        error: 'Base worktree cannot be used with a cowork project pipeline.',
      },
    });
    expect(mockedStartPipelineExecutionFromMain).not.toHaveBeenCalled();
  });

  it('rejects worktree-only pipelines targeted at a cowork project', async () => {
    mockedGetStoredPipelineBySource.mockReturnValueOnce({
      success: true,
      data: {
        info: {
          id: 'bundled-dispatch',
          name: 'Bundled dispatch',
          filename: 'bundled-dispatch.yaml',
          description: '',
          icon: '',
          createdAt: '2026-05-28T12:00:00.000Z',
          updatedAt: '2026-05-28T12:00:00.000Z',
          source: 'bundled',
          readonly: true,
        },
        content: {
          name: 'Bundled dispatch',
          on: 'dispatch',
          scope: 'worktree',
          jobs: {},
        },
      },
    });
    const { service } = makeService();
    const created = await service.create({
      name: 'Cowork pipeline',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'cowork-1',
        pipelineId: 'bundled-dispatch',
        pipelineSource: 'bundled',
      },
    });
    expect(created).toMatchObject({ ok: false });
    expect((await service.list()).activities).toEqual([]);
    expect(mockedStartPipelineExecutionFromMain).not.toHaveBeenCalled();
  });

  it('deduplicates and executes one-time pipeline recovery activities', async () => {
    const { service } = makeService();
    const reasonId = '123e4567-e89b-42d3-a456-426614174000';
    const request = {
      name: 'Resume limited pipeline',
      schedule: {
        kind: 'one_time' as const,
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local' as const,
      },
      action: {
        type: 'pipeline_execution_resume' as const,
        executionId: 'execution-resume',
        statusReasonIds: [reasonId],
        provider: 'claude' as const,
        purpose: 'usage_limit_resume' as const,
        pipelineName: 'Release',
      },
    };
    const first = await service.create(request);
    const duplicate = await service.create(request);
    if (!first.ok || !first.activity || !duplicate.ok || !duplicate.activity) {
      throw new Error('create failed');
    }

    expect(duplicate.activity.id).toBe(first.activity.id);
    await expect(service.list()).resolves.toMatchObject({
      activities: [{ id: first.activity.id }],
    });
    await expect(
      service.runNow({ id: first.activity.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        status: 'success',
        result: { pipelineExecutionId: 'execution-resume' },
      },
    });
    expect(mockedResumePipelineExecutionFromMain).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: 'execution-resume',
        statusReasonIds: [reasonId],
        allowStaleNoop: true,
        initiationSource: 'automation',
        persistInitiationSource: true,
      }),
    );
  });

  it('rejects worktree pipeline actions when the pipeline lacks dispatch', async () => {
    mockedDiscoverProjectPipelines.mockResolvedValueOnce([
      {
        id: 'pipeline-1',
        name: 'Plan only',
        description: '',
        icon: '',
        filename: 'plan.yaml',
        createdAt: '2026-05-28T12:00:00.000Z',
        updatedAt: '2026-05-28T12:00:00.000Z',
        source: 'project',
        readonly: true,
        filePath: '/repo/.canopy/pipelines/plan.yaml',
        triggerTypes: ['plan_ready'],
      },
    ] as never);
    const { service } = makeService();
    const created = await service.create({
      name: 'Pipeline',
      schedule: {
        kind: 'one_time',
        runAt: '2026-05-28T12:30:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'pipeline-1',
      },
    });
    expect(created).toMatchObject({ ok: false });
    expect((await service.list()).activities).toEqual([]);
    expect(mockedStartPipelineExecutionFromMain).not.toHaveBeenCalled();
    expect(mockedCreateSingleRepoWorktree).not.toHaveBeenCalled();
    expect(mockedArchiveSingleRepoWorktree).not.toHaveBeenCalled();
  });

  describe('automation_run watcher events', () => {
    async function flushWatcherNotifications(): Promise<void> {
      for (let i = 0; i < 20; i += 1) {
        await Promise.resolve();
      }
    }

    function standalonePromptCreateRequest(): AutomationCreateRequest {
      return {
        name: 'Watcher seam',
        schedule: {
          kind: 'one_time',
          runAt: '2026-05-28T12:30:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'standalone_prompt',
          chatProjectId: 'project-chat',
          prompt: 'Do the thing',
        },
      };
    }

    it('emits a success run event with the dispatched ids', async () => {
      const { service } = makeService();
      const created = await service.create(standalonePromptCreateRequest());
      if (!created.ok || !created.activity) throw new Error('create failed');

      const result = await service.runNow({ id: created.activity.id });
      if (!result.ok || !result.run) throw new Error('runNow failed');
      await flushWatcherNotifications();

      expect(mockHandleAutomationRunEvent).toHaveBeenCalledTimes(1);
      expect(mockHandleAutomationRunEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'automation_run',
          activityId: created.activity.id,
          activityName: 'Watcher seam',
          runId: result.run.id,
          manual: true,
          status: 'success',
          dispatched: {
            standaloneChatId: 'standalone-chat-1',
            projectId: 'project-chat',
            userMessageId: 'standalone-user-message-1',
          },
        }),
      );
    });

    it('emits a success run event with dispatched ids for an existing-worktree prompt', async () => {
      // REG-2830: automation_run correlation is keyed by the dispatched chat
      // ids, not by how the worktree came to be — an existing-worktree
      // dispatch must carry the same `{ projectId, worktreeId, chatId }`
      // shape the fresh-worktree path emits.
      mockedReadAllSidebarItems.mockResolvedValue(
        sidebarWithExistingWorktree(),
      );
      const { service } = makeService();
      const created = await service.create({
        name: 'Existing worktree watcher seam',
        schedule: {
          kind: 'one_time',
          runAt: '2026-05-28T12:30:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'worktree_prompt',
          workspaceId: 'workspace-1',
          existingWorktreeId: 'worktree-existing',
          prompt: 'Implement leg 2 in place',
        },
      });
      if (!created.ok || !created.activity) throw new Error('create failed');

      const result = await service.runNow({ id: created.activity.id });
      if (!result.ok || !result.run) throw new Error('runNow failed');
      await flushWatcherNotifications();

      const dispatched = result.run.result;
      if (!dispatched) throw new Error('run result missing');
      expect(dispatched).toMatchObject({
        projectId: 'workspace-1',
        worktreeId: 'worktree-existing',
      });
      expect(dispatched.chatId).toEqual(expect.any(String));
      expect(mockHandleAutomationRunEvent).toHaveBeenCalledTimes(1);
      expect(mockHandleAutomationRunEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'automation_run',
          activityId: created.activity.id,
          runId: result.run.id,
          status: 'success',
          dispatched,
        }),
      );
    });

    it('emits a failure run event when the action throws', async () => {
      mockedSendStandaloneChatMessage.mockRejectedValueOnce(
        new Error('Chat window is unavailable.'),
      );
      const { service } = makeService();
      const created = await service.create(standalonePromptCreateRequest());
      if (!created.ok || !created.activity) throw new Error('create failed');

      const result = await service.runNow({ id: created.activity.id });
      if (!result.ok) throw new Error('runNow failed');
      await flushWatcherNotifications();

      expect(mockHandleAutomationRunEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failure',
          message: 'Chat window is unavailable.',
        }),
      );
    });

    it('persists watcher notification failures through main-process logging', async () => {
      const notificationError = new Error('Watcher service unavailable.');
      mockHandleAutomationRunEvent.mockRejectedValueOnce(notificationError);
      const { service } = makeService();
      const created = await service.create(standalonePromptCreateRequest());
      if (!created.ok || !created.activity) throw new Error('create failed');

      await service.runNow({ id: created.activity.id });
      await flushWatcherNotifications();

      expect(mockedLogMainProcessError).toHaveBeenCalledWith(
        'Automation watcher notification failed',
        notificationError,
      );
    });

    it('emits a skipped run event when the If Command gates the action off', async () => {
      mockedRunAutomationIfCommand.mockResolvedValueOnce({
        outcome: 'skip',
        exitCode: 1,
      });
      const { service } = makeService();
      const created = await service.create({
        ...standalonePromptCreateRequest(),
        ifCommand: 'exit 1',
      });
      if (!created.ok || !created.activity) throw new Error('create failed');

      const result = await service.runNow({ id: created.activity.id });
      if (!result.ok) throw new Error('runNow failed');
      await flushWatcherNotifications();

      expect(mockedSendStandaloneChatMessage).not.toHaveBeenCalled();
      expect(mockHandleAutomationRunEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'skipped',
          message: 'If Command exited 1; action skipped.',
        }),
      );
    });

    it('emits failure events for runs interrupted by a restart', async () => {
      const { service } = makeService();
      const created = await service.create(standalonePromptCreateRequest());
      if (!created.ok || !created.activity) throw new Error('create failed');
      const interruptedRun: ScheduledActivityRun = {
        id: 'run-interrupted',
        activityId: created.activity.id,
        activityName: 'Watcher seam',
        scheduledFor: '2026-05-28T11:30:00.000Z',
        manual: false,
        status: 'running',
        startedAt: '2026-05-28T11:30:00.000Z',
      };
      const persisted: {
        version: 1;
        updatedAt: string;
        activities: ScheduledActivity[];
        recentRuns: ScheduledActivityRun[];
      } = {
        version: 1,
        updatedAt: '2026-05-28T11:30:00.000Z',
        activities: [created.activity],
        recentRuns: [interruptedRun],
      };
      await writeFile(
        automationsFilePath,
        JSON.stringify(persisted, null, 2),
        'utf8',
      );

      const fresh = makeService().service;
      await fresh.start();
      await flushWatcherNotifications();
      fresh.stop();

      expect(mockHandleAutomationRunEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-interrupted',
          status: 'failure',
          message: 'Run was interrupted when Canopy restarted.',
        }),
      );
    });
  });
});
