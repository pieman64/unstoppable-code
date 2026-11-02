/**
 * @jest-environment jsdom
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

// eslint-disable-next-line no-restricted-imports -- jsdom needs this test-only TextEncoder polyfill.
import { TextEncoder } from 'node:util';
import {
  FileSaveConflictError,
  isFileSaveConflictError,
} from '@canopy/app-core';
import type { OrgProjectSetupProgress } from '@canopy/protocol/org-projects';
import { desktopPersonalOrganizationUpgradePort } from '@/lib/personal-organization-upgrade-port';

import {
  CLIENT_STORE_ACTIVATE,
  CLIENT_STORE_DISPOSE,
  createOrgProjectsStore,
} from '@canopy/app-state';
import type { DesktopOrgProjectCatalogSnapshot } from '@canopy/desktop-shared/types';
import type {
  AgentModelConfig,
  ChatCommandRequest,
  ChatCommandResult,
} from '@canopy/desktop-shared/types';
import type {
  ChatMessageEvent,
  ConnectionStatusEvent,
  SessionViewModel,
} from '@canopy/app-core';
import type {
  ManagedDelegationExtendLifetimeLimitResult,
  ManagedDelegationLifetimeStatus,
} from '@canopy/protocol/delegation';
import {
  createDesktopCapabilities,
  IpcCanopyClient,
  registerLocalFileRootOverride,
} from '../ipc-canopy-client';
import { registerCoworkWorkspaceIds } from '@/lib/cowork-registry';
import { useChatStore } from '@/stores/chatStore';

/**
 * Install a partial `window.api` / `window.pipelines` mock for the handlers
 * under test. Handlers read the bridges lazily at call time, so per-test
 * installs are safe.
 */
function installWindowBridges(bridges: {
  api?: Record<string, unknown>;
  pipelines?: Record<string, unknown>;
}): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: bridges.api ?? {},
  });
  Object.defineProperty(window, 'pipelines', {
    configurable: true,
    value: bridges.pipelines ?? {},
  });
}

function createClient(): IpcCanopyClient {
  return new IpcCanopyClient(createDesktopCapabilities('darwin'));
}

const FILE_ROOTS = {
  roots: [
    {
      repoId: 'repo-1',
      repoName: 'Repo One',
      absolutePath: '/tmp/worktrees/wt-1/repo-1',
      rootKind: 'git-repo',
    },
    {
      repoId: 'attachments',
      repoName: 'Attachments',
      absolutePath: '/tmp/worktrees/wt-1/attachments/',
      rootKind: 'attachments',
    },
  ],
};

describe('createDesktopCapabilities', () => {
  it('enables voice on macOS', () => {
    expect(createDesktopCapabilities('darwin').voice).toBe(true);
  });

  it('disables voice off macOS (canopy-dictate is macOS-only)', () => {
    expect(createDesktopCapabilities('win32').voice).toBe(false);
    expect(createDesktopCapabilities('linux').voice).toBe(false);
  });

  it('reports the full local-first capability set on macOS', () => {
    expect(createDesktopCapabilities('darwin')).toEqual({
      sharedMultiRepo: true,
      githubConnection: true,
      localExecution: true,
      embeddedOAuthBrowser: true,
      repoRulesImport: true,
      scriptActions: true,
      marketplaceSources: true,
      marketplaceSourceAdd: true,
      marketplaceSourcePluginInstall: true,
      terminalPty: true,
      fileSystemAccess: 'read-write',
      voice: true,
      settingsScope: 'full',
      pipelines: 'execute',
      routing: 'in-memory',
      overviewNotifications: true,
      sidebarActivityMode: true,
      chatDrafts: true,
      nativeWorktreeOpen: true,
      worktreePrAgentHelpers: true,
      marketplaceOwnedAutomationShares: true,
      marketplaceOwnedShares: true,
      marketplaceSharedCollectionEdit: true,
      customSkillEdit: true,
      automations: true,
      watchers: true,
      workflowManagement: true,
      chatWorkflows: {
        planMode: true,
        planReview: true,
        deferredCapabilities: true,
        independentFork: true,
        interruptedTurnResume: true,
      },
      panelLayoutControls: false,
      itemGrouping: false,
      workspaceRemoval: 'delete',
      // `worktree.create` / `worktree.update` run over IPC. Row identity and
      // activity sections keep the shared defaults (both left unset).
      worktreeCreation: true,
      // `worktree.create` carries `baseWorktreeId` and `forkOpenTabs`.
      worktreeBranching: true,
      worktreeMetadata: true,
      // Desktop wires `turnFeedback.rate` / `.detail` through the local
      // outbox, so turn-level ratings work signed out and offline (CAN-1521).
      turnFeedback: true,
      // Install update emails go through the settings IPC pair (CAN-2334).
      installUpdateEmails: true,
      // Tip dismissals live in the desktop preferences (CAN-4904).
      onboardingTips: true,
      // Desktop reads promoted visuals through `window.api.chat.readVisual`.
      chatVisuals: true,
      imageClipboard: true,
      // The subagent viewer's controls run through the local
      // managed-delegation and native-subagent IPC.
      delegationStop: true,
      delegationTranscriptReads: true,
      delegationBlockReads: true,
      delegationLifetimeStatusReads: true,
      delegationLifetimeLimitExtension: true,
      primaryContentReads: true,
      delegationWorktreeDetails: true,
      delegationMessaging: true,
      nativeSubagentInterrupt: true,
      // Desktop reads each scope's Agent Ledger over IPC.
      ledger: true,
      // The Feed merges this device's Ledger with the mirror.
      ledgerFeed: true,
      ledgerLocal: true,
      referencePreviews: true,
      backgroundTaskStop: true,
      lifecycleJournalQuarantine: true,
      worktreeDiscard: true,
      projectDeletionDiscard: true,
      // Desktop reads observed cost over IPC.
      costInsights: true,
      providerQuotas: true,
      // Main detects and surfaces repeat-task skill suggestions (CAN-385).
      skillSuggestions: true,
      personalOrganizationUpgrade: false,
      organizationInvites: false,
      personalProjectConversion: false,
      inlineCheckout: false,
      accountOrganizationSettings: false,
    });
  });

  it('reports hosted settings only when the settings bridge is wired', () => {
    expect(
      createDesktopCapabilities(
        'darwin',
        {},
        { accountOrganizationSettings: true },
      ).accountOrganizationSettings,
    ).toBe(true);
    expect(
      createDesktopCapabilities(
        'darwin',
        {},
        { accountOrganizationSettings: true },
      ).inlineCheckout,
    ).toBe(false);
  });

  it('reports costInsights whether or not Early access is on', () => {
    const capabilities = createDesktopCapabilities('darwin');
    expect(capabilities.githubConnection).toBe(true);
    setTestEarlyAccessFeatures({ enabled: false, hydrated: true });
    expect(capabilities.costInsights).toBe(true);
    setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
    expect(capabilities.costInsights).toBe(true);
    setTestEarlyAccessFeatures({ enabled: false, hydrated: true });
  });
});

describe('IpcCanopyClient hosted settings binding', () => {
  // jsdom has no TextEncoder; the settings table measures input with it.
  beforeAll(() => {
    Object.assign(globalThis, { TextEncoder });
  });

  it('binds settings only when the preload exposes the bridge', async () => {
    installWindowBridges({ api: {} });
    const without = new IpcCanopyClient();
    expect(without.capabilities.accountOrganizationSettings).toBe(false);
    expect(without.capabilities.inlineCheckout).toBe(false);
    expect(without.settings).toBeUndefined();

    const read = jest.fn().mockResolvedValue({
      ok: true,
      result: {
        version: 1,
        viewer: { id: 'acct-1', email: 'a@example.com', name: null },
        account: {
          billingEnabled: true,
          digestsEnabled: true,
          integrationsEnabled: true,
          freeAccess: false,
        },
        organizations: [],
        organization: null,
      },
    });
    installWindowBridges({
      api: {
        accountOrganizationSettings: { read },
        loadCanopyCloudAccount: jest.fn().mockResolvedValue({
          read: 'ok',
          hasApiKey: true,
          authMode: 'oauth',
          account: { id: 'acct-1', email: 'a@example.com' },
        }),
      },
    });
    const bound = new IpcCanopyClient();
    expect(bound.capabilities.accountOrganizationSettings).toBe(true);
    expect(bound.capabilities.inlineCheckout).toBe(false);
    const bootstrap = await bound.settings?.read('settings.bootstrap', {});
    expect(bootstrap?.viewer.id).toBe('acct-1');
    expect(read).toHaveBeenCalledWith({
      accountId: 'acct-1',
      operation: 'settings.bootstrap',
      input: {},
    });
  });
});

describe('IpcCanopyClient', () => {
  it('reloads a broadcast snapshot once without forcing another main refresh', async () => {
    const snapshot: DesktopOrgProjectCatalogSnapshot = {
      context: 'personal',
      revision: 'r2',
      projects: [],
      fetchedAt: new Date().toISOString(),
      stale: false,
      error: null,
    };
    let onChanged: (
      value: DesktopOrgProjectCatalogSnapshot,
    ) => void = (): void => {};
    const broadcast = jest.fn((value: DesktopOrgProjectCatalogSnapshot): void =>
      onChanged(value),
    );
    const refresh = jest.fn((): Promise<DesktopOrgProjectCatalogSnapshot> => {
      // Bound the buggy feedback loop so the red test fails without hanging.
      if (refresh.mock.calls.length < 3) broadcast(snapshot);
      return Promise.resolve(snapshot);
    });
    const list = jest.fn(
      (): Promise<DesktopOrgProjectCatalogSnapshot> =>
        Promise.resolve(snapshot),
    );
    installWindowBridges({
      api: {
        workspaceContext: { onChanged: (): (() => void) => (): void => {} },
        orgProjects: {
          onSetupProgress: (): (() => void) => (): void => {},
          list,
          refresh,
          onChanged: (listener: typeof onChanged): (() => void) => {
            onChanged = listener;
            return (): void => {};
          },
        },
      },
    });
    const client = createClient();
    const store = createOrgProjectsStore(client);
    store[CLIENT_STORE_ACTIVATE]?.();
    store.getState().applySnapshot({ ...snapshot, revision: 'r1' });
    const query = jest.spyOn(client, 'query');
    await window.api.orgProjects.refresh({
      context: { kind: 'personal' },
      force: true,
    });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(store.getState().snapshots.personal).toEqual(snapshot);
    store[CLIENT_STORE_DISPOSE]?.();
    // Explicit user refreshes must still reach main after event delivery.
    await client.query('orgProjects.catalog', {
      context: { kind: 'personal' },
      refresh: true,
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    // CAN-3489: the Add project dialog's open also re-reads GitHub.
    await client.query('orgProjects.catalog', {
      context: { kind: 'personal' },
      refresh: true,
      repositories: true,
    });
    expect(refresh).toHaveBeenLastCalledWith({
      context: { kind: 'personal' },
      force: true,
      repositories: true,
    });
  });

  afterEach(() => {
    registerCoworkWorkspaceIds([]);
    jest.restoreAllMocks();
  });

  it('uses the injected capabilities', () => {
    const capabilities = createDesktopCapabilities('darwin');
    const client = new IpcCanopyClient(capabilities);
    expect(client.capabilities).toBe(capabilities);
  });

  it('queries the neutral desktop session snapshot with the requested scope', async () => {
    const snapshot: SessionViewModel = {
      workspaces: [],
      worktrees: [],
      chatProjects: [],
      standaloneChats: [],
      scriptDescriptors: [],
      scriptRuns: [],
      hookDescriptors: [],
      hookRuns: [],
      plans: [],
      pipelines: [],
      pipelineRuns: [],
      chatMessages: [],
      chatSummaries: [],
      terminalSessions: [],
      terminalBuffers: {},
      changedFiles: {},
      diffSnapshots: {},
      prStatuses: {},
      fileRoots: [],
      fileTree: {},
      filePreviews: {},
      refreshing: false,
      connectionStatus: 'active',
    };
    const getDesktopSessionSnapshot = jest.fn().mockResolvedValue(snapshot);
    installWindowBridges({ api: { getDesktopSessionSnapshot } });

    await expect(
      createClient().query('session.snapshot', {
        includeChatSummaries: true,
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'worktree-1',
      }),
    ).resolves.toBe(snapshot);
    expect(getDesktopSessionSnapshot).toHaveBeenCalledWith({
      includeChatSummaries: true,
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'worktree-1',
    });
  });

  it('subscribes to desktop snapshot invalidation and preserves unsubscribe', () => {
    let notify: (() => void) | undefined;
    const unsubscribeBridge = jest.fn();
    installWindowBridges({
      api: {
        onDesktopSessionSnapshotStale: (listener: () => void): (() => void) => {
          notify = listener;
          return unsubscribeBridge;
        },
      },
    });
    const events: Array<{ occurredAt: string }> = [];
    const unsubscribe = createClient().subscribe(
      'session.snapshot-stale',
      (event) => events.push(event),
    );

    notify?.();
    expect(events).toHaveLength(1);
    expect(Number.isNaN(new Date(events[0].occurredAt).getTime())).toBe(false);
    unsubscribe();
    expect(unsubscribeBridge).toHaveBeenCalledTimes(1);
  });

  it('stops one background task over the activity IPC and returns its outcome', async () => {
    const stopBgProcess = jest.fn().mockResolvedValue('stopped');
    installWindowBridges({ api: { activity: { stopBgProcess } } });
    const target = {
      projectId: 'p1',
      worktreeId: 'wt1',
      chatId: 'c1',
      taskId: 'task-1',
    };

    await expect(
      createClient().command('activity.stopBackgroundTask', target),
    ).resolves.toBe('stopped');
    expect(stopBgProcess).toHaveBeenCalledWith(target);
  });

  it('maps project settings queries and saves over exact IPC', async () => {
    const loadClaudeMd = jest.fn().mockResolvedValue('# Rules');
    const readWorkspaceScripts = jest
      .fn()
      .mockResolvedValue({ setup: 'npm install' });
    const saveClaudeMd = jest.fn().mockResolvedValue(undefined);
    const mergeWorkspaceScripts = jest.fn().mockResolvedValue(undefined);
    const invalidateDesktopSessionSnapshot = jest
      .fn()
      .mockResolvedValue(undefined);
    installWindowBridges({
      api: {
        loadClaudeMd,
        readWorkspaceScripts,
        saveClaudeMd,
        mergeWorkspaceScripts,
        invalidateDesktopSessionSnapshot,
      },
    });
    const client = createClient();
    await expect(
      client.query('workspace.claudeMd.get', { workspaceId: 'w1' }),
    ).resolves.toBe('# Rules');
    await expect(
      client.query('workspace.scripts.get', { workspaceId: 'w1' }),
    ).resolves.toEqual({ setup: 'npm install' });
    await client.command('workspace.claudeMd.save', {
      workspaceId: 'w1',
      content: '# New',
    });
    await client.command('workspace.scripts.save', {
      workspaceId: 'w1',
      commands: { launch: 'npm start' },
    });
    expect(loadClaudeMd).toHaveBeenCalledWith({ workspaceId: 'w1' });
    expect(readWorkspaceScripts).toHaveBeenCalledWith({ workspaceId: 'w1' });
    expect(saveClaudeMd).toHaveBeenCalledWith({
      workspaceId: 'w1',
      content: '# New',
    });
    expect(mergeWorkspaceScripts).toHaveBeenCalledWith({
      workspaceId: 'w1',
      commands: { launch: 'npm start' },
    });
    expect(invalidateDesktopSessionSnapshot).toHaveBeenCalledTimes(2);
  });

  it('maps install update email preference reads and saves over IPC', async () => {
    const loadInstallUpdateEmailPreference = jest
      .fn()
      .mockResolvedValue({ enabled: true });
    const saveInstallUpdateEmailPreference = jest
      .fn()
      .mockResolvedValue({ enabled: false });
    installWindowBridges({
      api: {
        loadInstallUpdateEmailPreference,
        saveInstallUpdateEmailPreference,
      },
    });
    const client = createClient();
    await expect(
      client.query('account.installUpdateEmails.get', {}),
    ).resolves.toEqual({ enabled: true });
    await expect(
      client.command('account.installUpdateEmails.set', { enabled: false }),
    ).resolves.toEqual({ enabled: false });
    expect(saveInstallUpdateEmailPreference).toHaveBeenCalledWith({
      enabled: false,
    });
  });

  it('keeps onboarding tip dismissals in the desktop preferences', async () => {
    const loadPreferences = jest.fn().mockResolvedValue({
      onboardingTipsDismissed: {
        'worktree-chat': '2026-10-24T08:00:00.000Z',
        retired: '2026-10-24T08:00:00.000Z',
      },
    });
    const stored = {
      dismissed: {
        'worktree-chat': '2026-10-24T08:00:00.000Z',
        workflows: '2026-10-24T09:00:00.000Z',
      },
    };
    const updateOnboardingTips = jest.fn().mockResolvedValue(stored);
    installWindowBridges({ api: { loadPreferences, updateOnboardingTips } });
    const client = createClient();
    await expect(client.query('onboardingTips.get', {})).resolves.toEqual({
      dismissed: { 'worktree-chat': '2026-10-24T08:00:00.000Z' },
    });
    // Main merges the update inside its serialized preferences write.
    await expect(
      client.command('onboardingTips.update', {
        action: 'dismiss',
        tipId: 'workflows',
      }),
    ).resolves.toEqual(stored);
    expect(updateOnboardingTips).toHaveBeenCalledWith({
      action: 'dismiss',
      tipId: 'workflows',
    });
  });

  it('shows no tips when the preferences file failed to load', async () => {
    installWindowBridges({
      api: {
        loadPreferences: jest.fn().mockResolvedValue({
          onboardingTipsDismissed: {},
          __error: { kind: 'parse', message: 'bad' },
        }),
      },
    });
    await expect(
      createClient().query('onboardingTips.get', {}),
    ).rejects.toThrow('Preferences could not be loaded.');
  });

  it('shows no tips when the host does not store tip dismissals', async () => {
    // A host built before onboarding tips sends no dismissals field and has
    // no update channel, so a dismissal there could never be saved.
    installWindowBridges({
      api: { loadPreferences: jest.fn().mockResolvedValue({}) },
    });
    await expect(
      createClient().query('onboardingTips.get', {}),
    ).rejects.toThrow('This host does not store onboarding tip dismissals.');
  });

  it('propagates a rejected install update email preference load', async () => {
    installWindowBridges({
      api: {
        loadInstallUpdateEmailPreference: jest
          .fn()
          .mockRejectedValue(new Error('UNAVAILABLE')),
      },
    });
    await expect(
      createClient().query('account.installUpdateEmails.get', {}),
    ).rejects.toThrow('UNAVAILABLE');
  });

  it('maps project create, metadata, reorder, and type-dispatched delete', async () => {
    const getDefaultCloneDirectory = jest.fn().mockResolvedValue('/repos');
    const addWorkspaceFromRemote = jest
      .fn()
      .mockResolvedValue({ id: 'created' });
    const updateWorkspaceMetadata = jest.fn().mockResolvedValue(undefined);
    const reorderWorkspaces = jest.fn().mockResolvedValue(undefined);
    const deleteProject = jest.fn().mockResolvedValue(undefined);
    const deleteWorkspace = jest.fn().mockResolvedValue(undefined);
    const loadProjects = jest
      .fn()
      .mockResolvedValueOnce({
        items: [{ id: 'single', type: 'single-repo' }],
      })
      .mockResolvedValueOnce({
        items: [{ id: 'multi', type: 'multi-repo' }],
      })
      .mockResolvedValueOnce({
        items: [{ id: 'cowork', type: 'cowork' }],
      });
    const invalidateDesktopSessionSnapshot = jest
      .fn()
      .mockResolvedValue(undefined);
    installWindowBridges({
      api: {
        getDefaultCloneDirectory,
        addWorkspaceFromRemote,
        updateWorkspaceMetadata,
        reorderWorkspaces,
        deleteProject,
        deleteWorkspace,
        loadProjects,
        invalidateDesktopSessionSnapshot,
      },
    });
    const client = createClient();
    await expect(
      client.command('workspace.create', {
        kind: 'remote-clone',
        remoteUrl: 'https://example.com/repo.git',
      }),
    ).resolves.toEqual({ status: 'completed', workspaceId: 'created' });
    await client.command('workspace.update', {
      workspaceId: 'single',
      name: 'New',
      color: '#123456',
    });
    await client.command('workspace.reorder', {
      activeWorkspaceId: 'single',
      overWorkspaceId: 'multi',
    });
    await client.command('workspace.delete', { workspaceId: 'single' });
    await client.command('workspace.delete', { workspaceId: 'multi' });
    await client.command('workspace.delete', { workspaceId: 'cowork' });
    expect(addWorkspaceFromRemote).toHaveBeenCalledWith({
      remoteUrl: 'https://example.com/repo.git',
      destinationDir: '/repos',
    });
    expect(deleteProject).toHaveBeenCalledWith({ projectId: 'single' });
    expect(deleteWorkspace).toHaveBeenCalledWith({ workspaceId: 'multi' });
    expect(deleteWorkspace).toHaveBeenCalledWith({ workspaceId: 'cowork' });
    expect(invalidateDesktopSessionSnapshot).toHaveBeenCalledTimes(6);
  });

  it('dispatches worktree create and archive by project type with base and retention ordering', async () => {
    const loadProjects = jest
      .fn()
      .mockResolvedValueOnce({
        items: [
          {
            id: 'single',
            type: 'single-repo',
            repoPath: '/repo',
            worktrees: [{ id: 'base' }],
          },
        ],
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: 'multi',
            type: 'multi-repo',
            worktrees: [{ id: 'base' }],
          },
        ],
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: 'single',
            type: 'single-repo',
            repoPath: '/repo',
            worktrees: [{ id: 't1', createdAt: 'now' }, { id: 't2' }],
          },
        ],
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: 'multi',
            type: 'multi-repo',
            worktrees: [{ id: 't1' }, { id: 't2' }],
          },
        ],
      });
    const createWorktree = jest
      .fn()
      .mockResolvedValue({ id: 's1', branchName: 'task-s1' });
    const createWorkspaceWorktree = jest
      .fn()
      .mockResolvedValue({ id: 'm1', branchName: 'task-m1' });
    const archiveWorktree = jest.fn().mockResolvedValue({ success: true });
    const archiveWorkspaceWorktree = jest
      .fn()
      .mockResolvedValue({ success: true });
    const invalidateDesktopSessionSnapshot = jest
      .fn()
      .mockResolvedValue(undefined);
    installWindowBridges({
      api: {
        loadProjects,
        createWorktree,
        createWorkspaceWorktree,
        archiveWorktree,
        archiveWorkspaceWorktree,
        invalidateDesktopSessionSnapshot,
      },
    });
    const client = createClient();
    const forkOpenTabsToWorktree = jest
      .spyOn(useChatStore.getState(), 'forkOpenTabsToWorktree')
      .mockResolvedValue(new Map());
    await client.command('worktree.create', {
      workspaceId: 'single',
      baseWorktreeId: 'base',
      forkOpenTabs: true,
    });
    await client.command('worktree.create', { workspaceId: 'multi' });
    await client.command('worktree.archive', {
      workspaceId: 'single',
      worktreeId: 't1',
    });
    await client.command('worktree.archive', {
      workspaceId: 'multi',
      worktreeId: 't1',
    });
    expect(createWorktree).toHaveBeenCalledWith({
      projectId: 'single',
      repoPath: '/repo',
      existingWorktreeIds: ['base'],
      baseWorktreeId: 'base',
    });
    expect(createWorkspaceWorktree).toHaveBeenCalledWith({
      workspaceId: 'multi',
      existingWorktreeIds: ['base'],
    });
    expect(forkOpenTabsToWorktree).toHaveBeenCalledWith({
      projectId: 'single',
      sourceWorktreeId: 'base',
      destinationWorktreeId: 's1',
    });
    expect(archiveWorktree).toHaveBeenCalledWith({
      projectId: 'single',
      worktreeId: 't1',
      repoPath: '/repo',
      expectedCreatedAt: 'now',
      remainingWorktreeOrder: ['t2'],
      expectedRemainingWorktreeOrder: ['t2'],
    });
    expect(archiveWorkspaceWorktree).toHaveBeenCalledWith({
      workspaceId: 'multi',
      worktreeId: 't1',
      remainingWorktreeOrder: ['t2'],
      expectedRemainingWorktreeOrder: ['t2'],
    });
  });

  it('sequences label before hidden and invalidates a committed partial update on failure', async () => {
    const setWorktreeLabel = jest.fn().mockResolvedValue(undefined);
    const setWorktreeHidden = jest
      .fn()
      .mockRejectedValue(new Error('hidden failed'));
    const invalidateDesktopSessionSnapshot = jest
      .fn()
      .mockResolvedValue(undefined);
    installWindowBridges({
      api: {
        setWorktreeLabel,
        setWorktreeHidden,
        invalidateDesktopSessionSnapshot,
      },
    });
    await expect(
      createClient().command('worktree.update', {
        workspaceId: 'w1',
        worktreeId: 't1',
        label: 'Task',
        hidden: true,
      }),
    ).rejects.toThrow('hidden failed');
    expect(setWorktreeLabel).toHaveBeenCalledTimes(1);
    expect(setWorktreeHidden).toHaveBeenCalledTimes(1);
    expect(invalidateDesktopSessionSnapshot).toHaveBeenCalledTimes(1);
  });

  it('preserves the worktree mutation error when snapshot invalidation also fails', async () => {
    const setWorktreeLabel = jest.fn().mockResolvedValue(undefined);
    const setWorktreeHidden = jest
      .fn()
      .mockRejectedValue(new Error('hidden failed'));
    const invalidateDesktopSessionSnapshot = jest
      .fn()
      .mockRejectedValue(new Error('invalidate failed'));
    installWindowBridges({
      api: {
        setWorktreeLabel,
        setWorktreeHidden,
        invalidateDesktopSessionSnapshot,
      },
    });

    await expect(
      createClient().command('worktree.update', {
        workspaceId: 'w1',
        worktreeId: 't1',
        label: 'Task',
        hidden: true,
      }),
    ).rejects.toThrow('hidden failed');
    expect(invalidateDesktopSessionSnapshot).toHaveBeenCalledTimes(1);
  });

  it('maps worktree reorder and invalidates only after success', async () => {
    const reorderWorktrees = jest.fn().mockResolvedValue(undefined);
    const invalidateDesktopSessionSnapshot = jest
      .fn()
      .mockResolvedValue(undefined);
    installWindowBridges({
      api: { reorderWorktrees, invalidateDesktopSessionSnapshot },
    });
    await createClient().command('worktree.reorder', {
      workspaceId: 'w1',
      activeWorktreeId: 't1',
      overWorktreeId: 't2',
    });
    expect(reorderWorktrees).toHaveBeenCalledWith({
      workspaceId: 'w1',
      activeWorktreeId: 't1',
      overWorktreeId: 't2',
    });
    expect(invalidateDesktopSessionSnapshot).toHaveBeenCalledTimes(1);
  });

  it('emits an active connection status once (ignoring filter) and returns a callable unsubscribe', () => {
    const client = createClient();
    const events: ConnectionStatusEvent[] = [];
    const unsubscribe = client.subscribe(
      'connection.status',
      (event) => {
        events.push(event);
      },
      { workspaceLocalId: 'ws-1' },
    );

    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('active');
    expect(Number.isNaN(new Date(events[0].occurredAt).getTime())).toBe(false);
    expect(() => unsubscribe()).not.toThrow();
  });

  it('projects desktop chat events into filtered canonical whole-message events', () => {
    let emit:
      | ((event: {
          projectId: string;
          worktreeId: string;
          chatId: string;
          data: unknown;
        }) => void)
      | undefined;
    const unsubscribeBridge = jest.fn();
    installWindowBridges({
      api: {
        chat: {
          onChatEvent: (listener: typeof emit): (() => void) => {
            emit = listener;
            return unsubscribeBridge;
          },
        },
      },
    });
    const client = createClient();
    const events: ChatMessageEvent[] = [];
    const unsubscribe = client.subscribe(
      'chat.message',
      (event) => events.push(event),
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatLocalId: 'chat-1',
      },
    );

    emit?.({
      projectId: 'project-other',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      data: { type: 'assistant', message: { id: 'ignored', content: [] } },
    });
    emit?.({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      data: {
        type: 'canopy_user_prompt',
        original_text: 'hello',
        canopy_turn_user_message_id: 'user-1',
      },
    });
    emit?.({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      data: {
        type: 'canopy_ai_credits_routing',
        provider: 'claude',
        active: true,
      },
    });
    emit?.({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      data: {
        type: 'assistant',
        message: {
          id: 'message-1',
          content: [{ type: 'text', text: 'hello' }],
        },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      scope: 'worktree',
      workspaceLocalId: 'project-1',
      worktreeLocalId: 'worktree-1',
      chatId: 'chat-1',
      message: {
        messageId: 'message-1',
        chatId: 'chat-1',
        role: 'assistant',
        status: 'complete',
        text: 'hello',
      },
    });
    expect(() => unsubscribe()).not.toThrow();
    expect(unsubscribeBridge).toHaveBeenCalledTimes(1);
  });

  it('projects native Work Entry events as standalone workspace-scoped messages', () => {
    let emit:
      | ((event: {
          projectId: string;
          worktreeId: string;
          chatId: string;
          data: unknown;
        }) => void)
      | undefined;
    installWindowBridges({
      api: {
        chat: {
          onChatEvent: (listener: typeof emit): (() => void) => {
            emit = listener;
            return jest.fn();
          },
        },
      },
    });
    registerCoworkWorkspaceIds(['cowork-workspace-1']);
    const events: ChatMessageEvent[] = [];
    createClient().subscribe('chat.message', (event) => events.push(event), {
      workspaceLocalId: 'cowork-workspace-1',
      worktreeLocalId: 'entry-1',
      chatLocalId: 'chat-1',
    });

    emit?.({
      projectId: 'cowork-workspace-1',
      worktreeId: 'entry-1',
      chatId: 'chat-1',
      data: {
        type: 'assistant',
        message: {
          id: 'message-1',
          content: [{ type: 'text', text: 'cowork reply' }],
        },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      scope: 'standalone',
      workspaceLocalId: 'cowork-workspace-1',
      worktreeLocalId: 'entry-1',
      chatId: 'chat-1',
      message: { messageId: 'message-1', text: 'cowork reply' },
    });
  });

  it('uses the turn user message id for id-less assistant wire events', () => {
    let emit:
      | ((event: {
          projectId: string;
          worktreeId: string;
          chatId: string;
          data: unknown;
        }) => void)
      | undefined;
    installWindowBridges({
      api: {
        chat: {
          onChatEvent: (listener: typeof emit): (() => void) => {
            emit = listener;
            return jest.fn();
          },
        },
      },
    });
    const events: ChatMessageEvent[] = [];
    createClient().subscribe('chat.message', (event) => events.push(event), {
      workspaceLocalId: 'project-1',
      chatLocalId: 'chat-1',
    });

    emit?.({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      data: {
        type: 'assistant',
        canopy_turn_user_message_id: 'user-message-1',
        message: {
          content: [{ type: 'text', text: 'id-less reply' }],
        },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0].message.messageId).toBe('user-message-1:assistant');
  });

  it('folds Cursor assistant patches into one streaming message instead of blank rows', () => {
    let emit:
      | ((event: {
          projectId: string;
          worktreeId: string;
          chatId: string;
          data: unknown;
        }) => void)
      | undefined;
    installWindowBridges({
      api: {
        chat: {
          onChatEvent: (listener: typeof emit): (() => void) => {
            emit = listener;
            return jest.fn();
          },
        },
      },
    });
    const events: ChatMessageEvent[] = [];
    createClient().subscribe('chat.message', (event) => events.push(event), {
      workspaceLocalId: 'project-1',
      chatLocalId: 'chat-1',
    });
    const patch = (
      revision: number,
      patches: Record<string, unknown>[],
    ): Record<string, unknown> => ({
      type: 'canopy_assistant_patch',
      provider: 'cursor',
      messageId: 'cursor-message-1',
      timestamp: 1_700_000_000_000,
      revision,
      patches,
      canopy_turn_user_message_id: 'user-message-1',
    });

    emit?.({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      data: patch(1, [{ index: 0, block: { type: 'text', text: 'Cursor ' } }]),
    });
    emit?.({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      data: patch(2, [{ index: 0, appendText: 'chat works.' }]),
    });

    expect(events.map((event) => event.message.text)).toEqual([
      'Cursor ',
      'Cursor chat works.',
    ]);
    expect(
      events.every((event) => event.message.messageId === 'cursor-message-1'),
    ).toBe(true);
    // Each revision is a distinct wire update of the same message.
    expect(new Set(events.map((event) => event.eventId)).size).toBe(2);
  });

  it('preserves an active chat fold across many other concurrent chats — no size-based eviction can drop or corrupt it', () => {
    // A prior version of this handler capped the tracked-projector map with
    // FIFO eviction as a backstop against orphaned (never-terminated) chats.
    // That is unsafe: an evicted chat's continuation patch does not fail
    // loudly — a full `block` patch at index 0 against an empty `folded` map
    // is ACCEPTED by `applyAssistantPatches` and silently starts a fresh,
    // truncated message. Eviction would therefore corrupt whichever chat
    // happened to be oldest, active or not — worse than the leak it
    // "fixed". This test pins the opposite invariant: chat-0 keeps folding
    // correctly no matter how many OTHER chats stream patches in between.
    let emit:
      | ((event: {
          projectId: string;
          worktreeId: string;
          chatId: string;
          data: unknown;
        }) => void)
      | undefined;
    installWindowBridges({
      api: {
        chat: {
          onChatEvent: (listener: typeof emit): (() => void) => {
            emit = listener;
            return jest.fn();
          },
        },
      },
    });
    const events: ChatMessageEvent[] = [];
    createClient().subscribe('chat.message', (event) => events.push(event), {
      workspaceLocalId: 'project-1',
    });
    const initialPatch = (chatId: string): Record<string, unknown> => ({
      type: 'canopy_assistant_patch',
      provider: 'cursor',
      messageId: `${chatId}-message`,
      timestamp: 1_700_000_000_000,
      revision: 1,
      patches: [{ index: 0, block: { type: 'text', text: 'first ' } }],
      canopy_turn_user_message_id: `${chatId}-user`,
    });
    // chat-0's turn never reaches a terminal event, matching a long-running
    // active chat (or one whose completion is still pending) — the exact
    // case size-based eviction would have targeted first as "oldest".
    emit?.({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-0',
      data: initialPatch('chat-0'),
    });
    // Stream 100 other chats through — well past the old cap of 64 — none
    // reaching a terminal event either.
    for (let index = 1; index <= 100; index += 1) {
      emit?.({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: `chat-${index}`,
        data: initialPatch(`chat-${index}`),
      });
    }
    events.length = 0;

    // chat-0's continuation must still fold onto its prior "first " block.
    emit?.({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-0',
      data: {
        type: 'canopy_assistant_patch',
        provider: 'cursor',
        messageId: 'chat-0-message',
        timestamp: 1_700_000_000_001,
        revision: 2,
        patches: [{ index: 0, appendText: 'second' }],
        canopy_turn_user_message_id: 'chat-0-user',
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0].message.text).toBe('first second');
    expect(events[0].message.messageId).toBe('chat-0-message');
  });

  it('never allocates a projector for a non-Cursor chat, but still folds a Cursor chat that streams later', () => {
    let emit:
      | ((event: {
          projectId: string;
          worktreeId: string;
          chatId: string;
          data: unknown;
        }) => void)
      | undefined;
    installWindowBridges({
      api: {
        chat: {
          onChatEvent: (listener: typeof emit): (() => void) => {
            emit = listener;
            return jest.fn();
          },
        },
      },
    });
    const events: ChatMessageEvent[] = [];
    createClient().subscribe('chat.message', (event) => events.push(event), {
      workspaceLocalId: 'project-1',
    });

    // A non-Cursor (e.g. Claude) turn on the same chat id never touches the
    // Cursor patch projector map.
    emit?.({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-0',
      data: {
        type: 'assistant',
        canopy_turn_user_message_id: 'user-message-1',
        message: { content: [{ type: 'text', text: 'claude reply' }] },
      },
    });
    emit?.({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-0',
      data: { type: 'result', canopy_session_continues: false },
    });

    // A later Cursor turn on the SAME chat id still folds correctly.
    emit?.({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-0',
      data: {
        type: 'canopy_assistant_patch',
        provider: 'cursor',
        messageId: 'chat-0-cursor-message',
        timestamp: 1_700_000_000_002,
        revision: 1,
        patches: [{ index: 0, block: { type: 'text', text: 'cursor reply' } }],
        canopy_turn_user_message_id: 'chat-0-user-2',
      },
    });

    expect(events.map((event) => event.message.text)).toEqual([
      'claude reply',
      'cursor reply',
    ]);
  });

  it('resolves session.end as a desktop no-op', async () => {
    const client = createClient();
    await expect(client.command('session.end', {})).resolves.toBeUndefined();
  });

  it('rejects diff.read until the file-viewer adopt slice lands', async () => {
    const client = createClient();
    await expect(
      client.query('diff.read', { workspaceId: 'ws-1', worktreeId: 'wt-1' }),
    ).rejects.toThrow(/not yet bridged/);
  });

  it('rejects chat.history with a real Error until lazy scrollback (TS-05) lands', async () => {
    const client = createClient();
    const rejection = client.query('chat.history', {
      scope: 'worktree',
      chatId: 'chat-1',
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      before: null,
    });
    await expect(rejection).rejects.toBeInstanceOf(Error);
    await expect(rejection).rejects.toThrow(/not yet bridged/);
  });

  describe('file.read', () => {
    it('falls back to the legacy response from a host without the canonical read', async () => {
      const getFileTreeRoots = jest.fn().mockResolvedValue(FILE_ROOTS);
      const readFileContent = jest.fn().mockResolvedValue({
        kind: 'text',
        content: 'hello world',
        filename: 'notes.md',
        sizeBytes: 11,
        truncated: false,
        modifiedAtMs: 1750000000123.4,
      });
      installWindowBridges({ api: { getFileTreeRoots, readFileContent } });

      const client = createClient();
      const preview = await client.query('file.read', {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        repoId: 'repo-1',
        relativePath: 'docs/notes.md',
      });

      expect(getFileTreeRoots).toHaveBeenCalledWith({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
      });
      expect(readFileContent).toHaveBeenCalledWith({
        absolutePath: '/tmp/worktrees/wt-1/repo-1/docs/notes.md',
        workspaceTarget: {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
        },
        file: { fileRootId: 'repo-1', relativePath: 'docs/notes.md' },
      });
      expect(preview).toEqual({
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        fileRootLocalId: 'repo-1',
        path: 'docs/notes.md',
        content: 'hello world',
        language: 'md',
        size: 11,
        version: '11:1750000000123',
        truncated: false,
        modifiedAt: new Date(1750000000123.4).toISOString(),
      });
    });

    it('shapes the preview from the canonical read without reconstructing it', async () => {
      const getFileTreeRoots = jest.fn().mockResolvedValue(FILE_ROOTS);
      const readFileContent = jest.fn().mockResolvedValue({
        kind: 'markdown',
        content: '# Notes',
        filename: 'notes.md',
        sizeBytes: 7,
        truncated: false,
        modifiedAtMs: 1750000000123.4,
        canonical: {
          fileRootId: 'repo-1',
          relativePath: 'docs/notes.md',
          name: 'notes.md',
          contentKind: 'markdown',
          sizeBytes: 7,
          returnedBytes: 7,
          truncated: false,
          modifiedAt: '2025-06-15T15:06:40.123Z',
          version: 'canonical-version',
        },
      });
      installWindowBridges({ api: { getFileTreeRoots, readFileContent } });

      const preview = await createClient().query('file.read', {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        repoId: 'repo-1',
        relativePath: './docs//notes.md',
      });

      expect(readFileContent).toHaveBeenCalledWith(
        expect.objectContaining({
          file: { fileRootId: 'repo-1', relativePath: 'docs/notes.md' },
        }),
      );
      expect(preview).toEqual({
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        fileRootLocalId: 'repo-1',
        path: './docs//notes.md',
        content: '# Notes',
        language: 'md',
        size: 7,
        version: 'canonical-version',
        truncated: false,
        modifiedAt: '2025-06-15T15:06:40.123Z',
      });
    });

    it('prefers fileRootLocalId over repoId and joins trailing-slash roots cleanly', async () => {
      const getFileTreeRoots = jest.fn().mockResolvedValue(FILE_ROOTS);
      const readFileContent = jest.fn().mockResolvedValue({
        kind: 'text',
        content: '',
        filename: 'a.txt',
        sizeBytes: 0,
        truncated: false,
        modifiedAtMs: 1,
      });
      installWindowBridges({ api: { getFileTreeRoots, readFileContent } });

      await createClient().query('file.read', {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        repoId: 'repo-1',
        fileRootLocalId: 'attachments',
        relativePath: 'a.txt',
      });

      expect(readFileContent).toHaveBeenCalledWith({
        absolutePath: '/tmp/worktrees/wt-1/attachments/a.txt',
        workspaceTarget: {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
        },
        file: { fileRootId: 'attachments', relativePath: 'a.txt' },
      });
    });

    it('reads a registered archived-attachment root without a live worktree root', async () => {
      const getFileTreeRoots = jest.fn();
      const readFileContent = jest.fn().mockResolvedValue({
        kind: 'text',
        content: 'archived',
        filename: 'notes.txt',
        sizeBytes: 8,
        truncated: false,
        modifiedAtMs: 1,
      });
      installWindowBridges({ api: { getFileTreeRoots, readFileContent } });
      const unregister = registerLocalFileRootOverride({
        repoId: 'archived-attachments:ws-1:archive-1',
        repoName: 'Archived attachments',
        absolutePath: '/archive/attachments',
        rootKind: 'attachments',
      });

      try {
        await createClient().query('file.read', {
          projectId: 'ws-1',
          worktreeId: 'archive-1',
          fileRootLocalId: 'archived-attachments:ws-1:archive-1',
          relativePath: 'notes.txt',
        });
      } finally {
        unregister();
      }

      expect(getFileTreeRoots).not.toHaveBeenCalled();
      expect(readFileContent).toHaveBeenCalledWith({
        absolutePath: '/archive/attachments/notes.txt',
        workspaceTarget: {
          projectId: 'ws-1',
          worktreeId: 'archive-1',
        },
      });
    });

    it('rejects binary and missing files with real Errors', async () => {
      const getFileTreeRoots = jest.fn().mockResolvedValue(FILE_ROOTS);
      const readFileContent = jest.fn().mockResolvedValue({
        kind: 'image',
        content: 'data:image/png;base64,xyz',
        filename: 'logo.png',
        sizeBytes: 10,
        truncated: false,
        modifiedAtMs: 1,
      });
      installWindowBridges({ api: { getFileTreeRoots, readFileContent } });

      const client = createClient();
      await expect(
        client.query('file.read', {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          repoId: 'repo-1',
          relativePath: 'logo.png',
        }),
      ).rejects.toThrow(/Binary files cannot be read/);

      readFileContent.mockResolvedValue({
        kind: 'missing',
        content: '',
        filename: 'gone.txt',
        sizeBytes: 0,
        truncated: false,
        modifiedAtMs: 0,
      });
      await expect(
        client.query('file.read', {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          repoId: 'repo-1',
          relativePath: 'gone.txt',
        }),
      ).rejects.toThrow(/File not found/);
    });

    it('rejects when neither repoId nor fileRootLocalId is set or the root is unknown', async () => {
      const getFileTreeRoots = jest.fn().mockResolvedValue(FILE_ROOTS);
      installWindowBridges({ api: { getFileTreeRoots } });

      const client = createClient();
      await expect(
        client.query('file.read', {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          relativePath: 'a.txt',
        }),
      ).rejects.toThrow(/repoId or fileRootLocalId/);
      await expect(
        client.query('file.read', {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          repoId: 'nope',
          relativePath: 'a.txt',
        }),
      ).rejects.toThrow(/Unknown file root/);
    });
  });

  describe('file.resolveLink', () => {
    it('projects a transcript resolution through file-reference:resolve', async () => {
      const resolveFileReference = jest.fn().mockResolvedValue({
        absolutePath: '/host/repo/docs/guide.md',
        filename: 'guide.md',
        kind: 'file',
        canonical: {
          fileRootId: 'repo-1',
          relativePath: 'docs/guide.md',
          name: 'guide.md',
          kind: 'file',
        },
      });
      installWindowBridges({ api: { resolveFileReference } });

      await expect(
        createClient().query('file.resolveLink', {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          href: 'docs/guide.md#L2',
        }),
      ).resolves.toEqual({
        fileRootLocalId: 'repo-1',
        relativePath: 'docs/guide.md',
      });
      expect(resolveFileReference).toHaveBeenCalledWith({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        baseFilePath: '',
        href: 'docs/guide.md#L2',
        mode: 'transcript',
      });
    });

    it('answers null for an unresolved link and for a host without transcript mode', async () => {
      const resolveFileReference = jest
        .fn()
        .mockResolvedValueOnce(null)
        // A host that predates `mode` resolves markdown, without `canonical`.
        .mockResolvedValueOnce({
          absolutePath: '/host/repo/a.md',
          filename: 'a.md',
          kind: 'file',
        });
      installWindowBridges({ api: { resolveFileReference } });
      const client = createClient();
      for (let call = 0; call < 2; call += 1)
        await expect(
          client.query('file.resolveLink', {
            projectId: 'ws-1',
            worktreeId: 'wt-1',
            href: 'a.md',
          }),
        ).resolves.toBeNull();
    });
  });

  describe('file.roots / file.directory', () => {
    it('maps file-tree roots onto PortalFileRoot rows', async () => {
      const getFileTreeRoots = jest.fn().mockResolvedValue(FILE_ROOTS);
      installWindowBridges({ api: { getFileTreeRoots } });

      const roots = await createClient().query('file.roots', {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
      });

      expect(roots).toEqual([
        {
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          fileRootLocalId: 'repo-1',
          label: 'Repo One',
          absolutePath: '/tmp/worktrees/wt-1/repo-1',
        },
        {
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          fileRootLocalId: 'attachments',
          label: 'Attachments',
          absolutePath: '/tmp/worktrees/wt-1/attachments/',
        },
      ]);
    });

    it('maps a directory listing onto PortalDirectoryListing entries', async () => {
      const getFileTreeDirectory = jest.fn().mockResolvedValue({
        entries: [
          {
            name: 'src',
            relativePath: 'src',
            absolutePath: '/tmp/worktrees/wt-1/repo-1/src',
            kind: 'directory',
            isIgnored: false,
            isIndexExcluded: false,
            isSymlink: false,
            hasChildren: true,
          },
          {
            name: 'README.md',
            relativePath: 'README.md',
            absolutePath: '/tmp/worktrees/wt-1/repo-1/README.md',
            kind: 'file',
            isIgnored: false,
            isIndexExcluded: false,
            isSymlink: false,
            hasChildren: false,
          },
        ],
      });
      installWindowBridges({ api: { getFileTreeDirectory } });

      const listing = await createClient().query('file.directory', {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        repoId: 'repo-1',
        relativeDir: '',
      });

      expect(getFileTreeDirectory).toHaveBeenCalledWith({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        repoId: 'repo-1',
        relativeDir: '',
      });
      expect(listing).toEqual({
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        fileRootLocalId: 'repo-1',
        path: '',
        entries: [
          { name: 'src', path: 'src', type: 'directory' },
          { name: 'README.md', path: 'README.md', type: 'file' },
        ],
      });
    });
  });

  describe('file.save', () => {
    it('writes through saveFileContent and returns the refreshed preview', async () => {
      const getFileTreeRoots = jest.fn().mockResolvedValue(FILE_ROOTS);
      const saveFileContent = jest.fn().mockResolvedValue({
        filename: 'notes.md',
        sizeBytes: 9,
        modifiedAtMs: 1750000009999,
      });
      installWindowBridges({ api: { getFileTreeRoots, saveFileContent } });

      const preview = await createClient().command('file.save', {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        repoId: 'repo-1',
        relativePath: 'docs/notes.md',
        content: 'new text!',
        expectedModifiedAtMs: 1750000000123,
      });

      expect(saveFileContent).toHaveBeenCalledWith({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        absolutePath: '/tmp/worktrees/wt-1/repo-1/docs/notes.md',
        content: 'new text!',
        expectedModifiedAtMs: 1750000000123,
      });
      expect(preview).toEqual({
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        fileRootLocalId: 'repo-1',
        path: 'docs/notes.md',
        content: 'new text!',
        language: 'md',
        size: 9,
        version: '9:1750000009999',
        truncated: false,
        modifiedAt: new Date(1750000009999).toISOString(),
      });
    });

    it('omits the conflict cookie when the caller has none', async () => {
      const getFileTreeRoots = jest.fn().mockResolvedValue(FILE_ROOTS);
      const saveFileContent = jest.fn().mockResolvedValue({
        filename: 'a.txt',
        sizeBytes: 1,
        modifiedAtMs: 5,
      });
      installWindowBridges({ api: { getFileTreeRoots, saveFileContent } });

      await createClient().command('file.save', {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        repoId: 'repo-1',
        relativePath: 'a.txt',
        content: 'x',
      });

      expect(saveFileContent).toHaveBeenCalledWith({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        absolutePath: '/tmp/worktrees/wt-1/repo-1/a.txt',
        content: 'x',
      });
    });

    it('surfaces a normalized conflict error from Electron IPC', async () => {
      const getFileTreeRoots = jest.fn().mockResolvedValue(FILE_ROOTS);
      const saveFileContent = jest
        .fn()
        .mockRejectedValue(
          new Error(
            "Error invoking remote method 'file:save-content': Error: File changed on disk since it was loaded.",
          ),
        );
      installWindowBridges({ api: { getFileTreeRoots, saveFileContent } });

      await expect(
        createClient().command('file.save', {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          repoId: 'repo-1',
          relativePath: 'a.txt',
          content: 'local edit',
          expectedModifiedAtMs: 1750000000123,
        }),
      ).rejects.toThrow('File changed on disk since it was loaded.');
    });

    it('restores the typed conflict from a named Electron rejection', async () => {
      const getFileTreeRoots = jest.fn().mockResolvedValue(FILE_ROOTS);
      const saveFileContent = jest
        .fn()
        .mockRejectedValue(
          new Error(
            "Error invoking remote method 'file:save-content': FileSaveConflictError: File changed on disk since it was loaded.",
          ),
        );
      installWindowBridges({ api: { getFileTreeRoots, saveFileContent } });

      const error: unknown = await createClient()
        .command('file.save', {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          repoId: 'repo-1',
          relativePath: 'a.txt',
          content: 'local edit',
          expectedModifiedAtMs: 1750000000123,
        })
        .catch((caught: unknown) => caught);

      expect(isFileSaveConflictError(error)).toBe(true);
      expect(error).toBeInstanceOf(FileSaveConflictError);
      expect((error as Error).message).toBe(
        'File changed on disk since it was loaded.',
      );
    });

    it.each([
      "Error invoking remote method 'file:save-content': Error: File changed on disk since it was loaded.",
      "Error invoking remote method 'file:save-content': Error: EACCES: permission denied",
      "Error invoking remote method 'file:save-content': ResourceGuardError: busy",
    ])('keeps unrelated failures untyped: %s', async (message) => {
      const getFileTreeRoots = jest.fn().mockResolvedValue(FILE_ROOTS);
      const saveFileContent = jest.fn().mockRejectedValue(new Error(message));
      installWindowBridges({ api: { getFileTreeRoots, saveFileContent } });

      const error: unknown = await createClient()
        .command('file.save', {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          repoId: 'repo-1',
          relativePath: 'a.txt',
          content: 'local edit',
          expectedModifiedAtMs: 1750000000123,
        })
        .catch((caught: unknown) => caught);

      expect(isFileSaveConflictError(error)).toBe(false);
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('chat.persistTabSettings', () => {
    it('maps settings to one scoped command without loading or saving a snapshot', async () => {
      const command = jest
        .fn<Promise<ChatCommandResult>, [ChatCommandRequest]>()
        .mockResolvedValue({
          commandId: 'command-1',
          revision: 2,
          outcome: 'applied',
        });
      installWindowBridges({ api: { chat: { command } } });

      await createClient().command('chat.persistTabSettings', {
        chatId: 'chat-1',
        scope: 'worktree',
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        settings: {
          planMode: true,
          proposalMode: 'required',
          thinkingLevel: 'high',
          pendingPlanExit: { toolInput: { plan: 'do the thing' } },
        },
      });

      const submitted: ChatCommandRequest | undefined =
        command.mock.calls[0]?.[0];
      expect(submitted?.commandId).toMatch(/^renderer-chat-settings-chat-1-/);
      expect(submitted).toMatchObject({
        schemaVersion: 1,
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: {
            planMode: true,
            proposalMode: 'required',
            modelConfig: {
              thinkingLevel: 'high',
            },
            pendingPlanExit: { toolInput: { plan: 'do the thing' } },
          },
        },
      });
    });

    it('commits an explicit pending-plan clear instead of caching it only', async () => {
      const command = jest
        .fn<Promise<ChatCommandResult>, [ChatCommandRequest]>()
        .mockResolvedValue({
          commandId: 'command-1',
          revision: 2,
          outcome: 'applied',
        });
      installWindowBridges({ api: { chat: { command } } });

      await createClient().command('chat.persistTabSettings', {
        chatId: 'chat-1',
        scope: 'worktree',
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        settings: {
          planMode: false,
          proposalMode: 'optional',
          thinkingLevel: 'medium',
        },
      });

      expect(command).toHaveBeenCalledTimes(1);
      const submitted: ChatCommandRequest | undefined =
        command.mock.calls[0]?.[0];
      expect(submitted?.command).toMatchObject({
        type: 'chat.patch_tab_settings',
        patch: { pendingPlanExit: null },
      });
    });

    it('routes standalone chats to the cowork home worktree id by default', async () => {
      const command = jest
        .fn<Promise<ChatCommandResult>, [ChatCommandRequest]>()
        .mockResolvedValue({
          commandId: 'command-1',
          revision: 2,
          outcome: 'already_applied',
        });
      installWindowBridges({ api: { chat: { command } } });

      await createClient().command('chat.persistTabSettings', {
        chatId: 'chat-2',
        scope: 'standalone',
        workspaceLocalId: 'cowork-1',
        settings: {
          planMode: false,
          proposalMode: 'optional',
          thinkingLevel: 'medium',
        },
      });

      const submitted: ChatCommandRequest | undefined =
        command.mock.calls[0]?.[0];
      expect(submitted).toMatchObject({
        projectId: 'cowork-1',
        worktreeId: 'home',
        command: { type: 'chat.patch_tab_settings', tabId: 'chat-2' },
      });
    });

    it('rejects missing routing and preserves a terminal service rejection', async () => {
      const command = jest
        .fn<Promise<ChatCommandResult>, [ChatCommandRequest]>()
        .mockResolvedValue({
          commandId: 'command-1',
          revision: 2,
          outcome: 'not_found',
          reason: 'Chat tab was not found.',
        });
      installWindowBridges({ api: { chat: { command } } });

      const client = createClient();
      await expect(
        client.command('chat.persistTabSettings', {
          chatId: 'chat-1',
          settings: {
            planMode: false,
            proposalMode: 'optional',
            thinkingLevel: 'off',
          },
        }),
      ).rejects.toThrow(/workspaceLocalId/);

      await expect(
        client.command('chat.persistTabSettings', {
          chatId: 'chat-404',
          scope: 'worktree',
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          settings: {
            planMode: false,
            proposalMode: 'optional',
            thinkingLevel: 'off',
          },
        }),
      ).rejects.toThrow('Chat tab was not found.');
      expect(command).toHaveBeenCalledTimes(1);
    });
  });

  describe('activity.setSectionOrder', () => {
    it('persists the filtered order onto the target project only', async () => {
      const items = [
        {
          type: 'single-repo',
          id: 'ws-1',
          name: 'One',
          repoPath: '/tmp/one',
          color: '#fff',
          worktrees: [],
          collapsed: false,
          order: 0,
        },
        {
          type: 'single-repo',
          id: 'ws-2',
          name: 'Two',
          repoPath: '/tmp/two',
          color: '#fff',
          worktrees: [],
          collapsed: false,
          order: 1,
        },
      ];
      const loadProjects = jest.fn().mockResolvedValue({ items });
      const saveProjects = jest.fn().mockResolvedValue({ items });
      installWindowBridges({ api: { loadProjects, saveProjects } });

      await createClient().command('activity.setSectionOrder', {
        workspaceLocalId: 'ws-1',
        order: ['scripts', 'terminals', 'not-a-real-section', 'summary'],
      });

      expect(saveProjects).toHaveBeenCalledWith([
        {
          ...items[0],
          activitySectionOrder: ['scripts', 'terminals', 'summary'],
        },
        items[1],
      ]);
    });
  });

  describe('scripts and hooks', () => {
    it('maps script.run onto the desktop ScriptRunRequest union', async () => {
      const runScript = jest.fn().mockResolvedValue({ success: true });
      installWindowBridges({ api: { runScript } });

      await createClient().command('script.run', {
        target: 'project',
        scriptName: 'setup',
        projectId: 'ws-1',
        worktreeId: 'wt-1',
      });

      expect(runScript).toHaveBeenCalledWith({
        target: 'project',
        scriptName: 'setup',
        projectId: 'ws-1',
        worktreeId: 'wt-1',
      });
    });

    it('rejects script.run when required routing ids are missing', async () => {
      installWindowBridges({ api: { runScript: jest.fn() } });
      await expect(
        createClient().command('script.run', {
          target: 'project',
          scriptName: 'setup',
        }),
      ).rejects.toThrow(/requires projectId and worktreeId/);
    });

    it('maps script.cancel onto stopScript', async () => {
      const stopScript = jest.fn().mockResolvedValue(null);
      installWindowBridges({ api: { stopScript } });

      await createClient().command('script.cancel', {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        scriptKey: 'project:setup',
      });

      expect(stopScript).toHaveBeenCalledWith({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        scriptKey: 'project:setup',
      });
    });

    it('maps hook.run (workspace-repo target) onto the desktop HookRunRequest union', async () => {
      const runHook = jest.fn().mockResolvedValue({ success: true });
      installWindowBridges({ api: { runHook } });

      await createClient().command('hook.run', {
        target: 'workspace-repo',
        triggerName: 'pre-commit',
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        repoId: 'repo-1',
      });

      expect(runHook).toHaveBeenCalledWith({
        target: 'workspace-repo',
        triggerName: 'pre-commit',
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        repoId: 'repo-1',
      });
    });

    it('rejects hook.run for workspace-repo targets without a repoId', async () => {
      installWindowBridges({ api: { runHook: jest.fn() } });
      await expect(
        createClient().command('hook.run', {
          target: 'workspace-repo',
          triggerName: 'pre-commit',
          workspaceId: 'ws-1',
          worktreeId: 'wt-1',
        }),
      ).rejects.toThrow(/requires repoId/);
    });

    it('maps hook.cancel onto stopHook', async () => {
      const stopHook = jest.fn().mockResolvedValue(null);
      installWindowBridges({ api: { stopHook } });

      await createClient().command('hook.cancel', {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        hookKey: 'project:pre-commit',
      });

      expect(stopHook).toHaveBeenCalledWith({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        hookKey: 'project:pre-commit',
      });
    });
  });

  describe('pipelines', () => {
    function installPipelineBridges(): {
      getWorktreePath: jest.Mock;
      discoverProject: jest.Mock;
      get: jest.Mock;
      execute: jest.Mock;
      cancelExecution: jest.Mock;
    } {
      const getWorktreePath = jest
        .fn()
        .mockResolvedValue('/tmp/worktrees/wt-1');
      const discoverProject = jest.fn().mockResolvedValue({
        success: true,
        data: [
          {
            id: 'pipe-1',
            name: 'Pipe One',
            source: 'project',
            readonly: false,
            filePath: '/tmp/worktrees/wt-1/.canopy/pipelines/pipe-1.yaml',
          },
        ],
      });
      const get = jest.fn().mockResolvedValue({
        success: true,
        data: { content: 'name: Pipe One\njobs: {}\n' },
      });
      const execute = jest.fn().mockResolvedValue({
        success: true,
        data: { id: 'exec-1' },
      });
      const cancelExecution = jest.fn().mockResolvedValue({ success: true });
      installWindowBridges({
        api: { getWorktreePath },
        pipelines: { discoverProject, get, execute, cancelExecution },
      });
      return {
        getWorktreePath,
        discoverProject,
        get,
        execute,
        cancelExecution,
      };
    }

    it('runs a discovered project pipeline through window.pipelines.execute', async () => {
      const bridges = installPipelineBridges();

      await createClient().command('pipeline.run', {
        pipelineId: 'pipe-1',
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        planId: 'plan-1',
        inputs: { key: 'value' },
        modelConfig: { thinkingLevel: 'high', fastMode: true },
      });

      expect(bridges.getWorktreePath).toHaveBeenCalledWith({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
      });
      expect(bridges.discoverProject).toHaveBeenCalledWith(
        '/tmp/worktrees/wt-1',
      );
      expect(bridges.get).toHaveBeenCalledWith({
        id: 'pipe-1',
        cwd: '/tmp/worktrees/wt-1',
        filePath: '/tmp/worktrees/wt-1/.canopy/pipelines/pipe-1.yaml',
      });
      expect(bridges.execute).toHaveBeenCalledWith(
        'name: Pipe One\njobs: {}\n',
        {
          cwd: '/tmp/worktrees/wt-1',
          pipelineId: 'pipe-1',
          pipelineFilePath: '/tmp/worktrees/wt-1/.canopy/pipelines/pipe-1.yaml',
          repoPath: '/tmp/worktrees/wt-1',
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          planId: 'plan-1',
          inputs: { key: 'value' },
          modelConfig: { thinkingLevel: 'high', fastMode: true },
        },
      );
    });

    const speedConfigs: AgentModelConfig[] = [
      { speed: 'standard', fastMode: false },
      { speed: 'fast', fastMode: true },
      { speed: 'ultrafast', fastMode: false },
    ];

    it.each(speedConfigs)(
      'preserves $speed through the pipeline transport for main admission',
      async (modelConfig) => {
        const { execute } = installPipelineBridges();
        await createClient().command('pipeline.run', {
          pipelineId: 'pipe-1',
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          modelConfig: { thinkingLevel: 'high', ...modelConfig },
        });

        expect(execute).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            modelConfig: { thinkingLevel: 'high', ...modelConfig },
          }),
        );
      },
    );

    it('keeps an exact speed ahead of the deprecated pipeline boolean alias', async () => {
      const { execute } = installPipelineBridges();
      await createClient().command('pipeline.run', {
        pipelineId: 'pipe-1',
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        modelConfig: { speed: 'fast' },
        codexFastModeEnabled: false,
      });
      expect(execute).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          modelConfig: { speed: 'fast', fastMode: true },
        }),
      );
    });

    it('rejects pipeline.run for unknown pipelines, missing scope, and explicit cwd overrides', async () => {
      const bridges = installPipelineBridges();
      const client = createClient();

      await expect(
        client.command('pipeline.run', { pipelineId: 'pipe-404' }),
      ).rejects.toThrow(/requires projectId and worktreeId/);

      await expect(
        client.command('pipeline.run', {
          pipelineId: 'pipe-1',
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          cwd: 'sub/dir',
        }),
      ).rejects.toThrow(/explicit cwd is not supported/);

      await expect(
        client.command('pipeline.run', {
          pipelineId: 'pipe-404',
          projectId: 'ws-1',
          worktreeId: 'wt-1',
        }),
      ).rejects.toThrow(/Pipeline not found/);
      expect(bridges.execute).not.toHaveBeenCalled();
    });

    it('surfaces execute failures as rejections', async () => {
      const bridges = installPipelineBridges();
      bridges.execute.mockResolvedValue({ success: false, error: 'boom' });

      await expect(
        createClient().command('pipeline.run', {
          pipelineId: 'pipe-1',
          projectId: 'ws-1',
          worktreeId: 'wt-1',
        }),
      ).rejects.toThrow('boom');
    });

    it('maps pipeline.cancel onto cancelExecution and surfaces failures', async () => {
      const bridges = installPipelineBridges();

      await createClient().command('pipeline.cancel', {
        executionId: 'exec-1',
      });
      expect(bridges.cancelExecution).toHaveBeenCalledWith('exec-1');

      bridges.cancelExecution.mockResolvedValue({
        success: false,
        error: 'nope',
      });
      await expect(
        createClient().command('pipeline.cancel', { executionId: 'exec-1' }),
      ).rejects.toThrow('nope');
    });
  });

  describe('pull requests', () => {
    it('maps pr.action commit_and_push onto commitAndPush with the message pinned per repo', async () => {
      const listWorktreeRepoEntries = jest.fn().mockResolvedValue([
        { repoId: 'repo-1', repoName: 'Repo One', repoPath: '/tmp/r1' },
        { repoId: 'repo-2', repoName: 'Repo Two', repoPath: '/tmp/r2' },
      ]);
      const commitAndPush = jest.fn().mockResolvedValue({
        repos: [],
        skippedRepos: [],
        failedRepos: [],
        agentResolutionRepos: [],
      });
      installWindowBridges({
        api: { listWorktreeRepoEntries, github: { commitAndPush } },
      });

      await createClient().command('pr.action', {
        action: 'commit_and_push',
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        commitMessage: 'feat: do the thing',
        repoIds: ['repo-2'],
      });

      expect(commitAndPush).toHaveBeenCalledWith({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        messages: [
          {
            repoId: 'repo-2',
            repoName: 'Repo Two',
            message: 'feat: do the thing',
          },
        ],
        repoIds: ['repo-2'],
      });
    });

    it('maps pr.action push and pull onto the worktree git IPC', async () => {
      const pushOnly = jest.fn().mockResolvedValue({});
      const pull = jest.fn().mockResolvedValue({});
      installWindowBridges({ api: { github: { pushOnly, pull } } });

      const client = createClient();
      await client.command('pr.action', {
        action: 'push',
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      });
      await client.command('pr.action', {
        action: 'pull',
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      });

      expect(pushOnly).toHaveBeenCalledWith({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
      });
      expect(pull).toHaveBeenCalledWith({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
      });
    });

    it('rejects repo-scoped push/pull and the unbridged create/update_base_branch actions', async () => {
      installWindowBridges({ api: { github: {} } });
      const client = createClient();

      await expect(
        client.command('pr.action', {
          action: 'push',
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          repoIds: ['repo-1'],
        }),
      ).rejects.toThrow(/repo scoping is not supported/);
      await expect(
        client.command('pr.action', {
          action: 'pull',
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          repoIds: ['repo-1'],
        }),
      ).rejects.toThrow(/repo scoping is not supported/);
      await expect(
        client.command('pr.action', {
          action: 'create',
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          title: 'T',
          body: 'B',
        }),
      ).rejects.toThrow(/not yet bridged/);
      await expect(
        client.command('pr.action', {
          action: 'update_base_branch',
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          baseBranch: 'main',
        }),
      ).rejects.toThrow(/not yet bridged/);
    });

    it('rejects pr.create until a title/body-honoring desktop IPC exists', async () => {
      installWindowBridges({ api: { github: {} } });
      await expect(
        createClient().command('pr.create', {
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          title: 'T',
          body: 'B',
        }),
      ).rejects.toThrow(/not yet bridged/);
    });

    it('maps pr.refresh onto requestPrStatusRefresh', async () => {
      const requestPrStatusRefresh = jest.fn().mockResolvedValue(undefined);
      installWindowBridges({ api: { github: { requestPrStatusRefresh } } });

      await createClient().command('pr.refresh', {
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      });

      expect(requestPrStatusRefresh).toHaveBeenCalledWith({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
      });
    });
  });
  describe('file path containment', () => {
    it('rejects traversal relativePaths on file.read before any IPC call', async () => {
      const getFileTreeRoots = jest.fn().mockResolvedValue(FILE_ROOTS);
      const readFileContent = jest.fn();
      installWindowBridges({ api: { getFileTreeRoots, readFileContent } });

      await expect(
        createClient().query('file.read', {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          repoId: 'repo-1',
          relativePath: '../../../../etc/passwd',
        }),
      ).rejects.toThrow(/escapes the file root/);
      expect(readFileContent).not.toHaveBeenCalled();
    });

    it('rejects embedded traversal segments on file.save before any IPC call', async () => {
      const getFileTreeRoots = jest.fn().mockResolvedValue(FILE_ROOTS);
      const saveFileContent = jest.fn();
      installWindowBridges({ api: { getFileTreeRoots, saveFileContent } });

      await expect(
        createClient().command('file.save', {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          repoId: 'repo-1',
          relativePath: 'docs/../../outside.txt',
          content: 'x',
        }),
      ).rejects.toThrow(/escapes the file root/);
      expect(saveFileContent).not.toHaveBeenCalled();
    });
  });

  describe('pr.action commit_and_push failure surfacing', () => {
    it('rejects when the IPC reports failed or agent-resolution repos', async () => {
      const listWorktreeRepoEntries = jest.fn().mockResolvedValue([
        { repoId: 'repo-1', repoName: 'Repo One', repoPath: '/tmp/r1' },
        { repoId: 'repo-2', repoName: 'Repo Two', repoPath: '/tmp/r2' },
      ]);
      const commitAndPush = jest.fn().mockResolvedValue({
        repos: [],
        skippedRepos: [],
        failedRepos: [
          {
            repoId: 'repo-1',
            repoName: 'Repo One',
            error: 'push rejected',
            status: 'failed',
          },
        ],
        agentResolutionRepos: [
          { repoName: 'Repo Two', chatId: 'chat-9', kind: 'rebase_conflict' },
        ],
      });
      installWindowBridges({
        api: { listWorktreeRepoEntries, github: { commitAndPush } },
      });

      await expect(
        createClient().command('pr.action', {
          action: 'commit_and_push',
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          commitMessage: 'feat: x',
        }),
      ).rejects.toThrow(
        /Repo One: push rejected[\s\S]*Repo Two \(rebase_conflict\)/,
      );
    });
  });

  describe('plans', () => {
    const PLAN = {
      id: 'plan-1',
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      source: 'claude',
      title: 'Ship the thing',
      content: '# Plan body',
      reviewStatus: 'pending',
      createdAt: '2026-07-09T00:00:00.000Z',
      updatedAt: '2026-07-10T00:00:00.000Z',
      latestRevisionNumber: 3,
      approvedAt: undefined,
      dismissedAt: undefined,
      revisions: [],
      linkedExecutionIds: [],
      hidden: false,
    };

    it('plan.get maps args and projects TrackedPlanData into PortalPlanDetail', async () => {
      const get = jest.fn().mockResolvedValue(PLAN);
      installWindowBridges({ api: { activity: { plans: { get } } } });

      const detail = await createClient().query('plan.get', {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        planId: 'plan-1',
      });

      expect(get).toHaveBeenCalledWith({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        planId: 'plan-1',
      });
      expect(detail).toEqual({
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        planId: 'plan-1',
        title: 'Ship the thing',
        status: 'pending',
        source: 'claude',
        updatedAt: '2026-07-10T00:00:00.000Z',
        content: '# Plan body',
        body: '# Plan body',
        reviewStatus: 'pending',
        approvedAt: null,
        dismissedAt: null,
        hidden: false,
        latestRevisionNumber: 3,
        revisionNumber: 3,
      });
    });

    it('plan.get rejects when the plan is missing', async () => {
      const get = jest.fn().mockResolvedValue(null);
      installWindowBridges({ api: { activity: { plans: { get } } } });

      await expect(
        createClient().query('plan.get', {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          planId: 'plan-404',
        }),
      ).rejects.toThrow('Plan not found.');
    });

    it('plan.get honors a pinned revision instead of returning the latest (CAN-5354)', async () => {
      const get = jest.fn().mockResolvedValue({
        ...PLAN,
        revisions: [
          {
            revisionNumber: 2,
            content: ' # Older plan\n',
            source: 'claude',
            reviewStatus: 'dismissed',
            createdAt: '2026-07-09T00:00:00.000Z',
            dismissedAt: '2026-07-09T01:00:00.000Z',
          },
        ],
      });
      installWindowBridges({ api: { activity: { plans: { get } } } });
      const query = (revisionNumber: number): Promise<unknown> =>
        createClient().query('plan.get', {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          planId: 'plan-1',
          revisionNumber,
        });

      await expect(query(2)).resolves.toMatchObject({
        content: ' # Older plan\n',
        body: ' # Older plan\n',
        revisionNumber: 2,
        latestRevisionNumber: 3,
        reviewStatus: 'dismissed',
        dismissedAt: '2026-07-09T01:00:00.000Z',
      });
      await expect(query(3)).resolves.toMatchObject({
        content: '# Plan body',
        revisionNumber: 3,
      });
      await expect(query(1)).rejects.toThrow('Plan not found.');
    });

    it('plan.update narrows the wire payload onto UpdateTrackedPlanRequest', async () => {
      const update = jest.fn().mockResolvedValue(PLAN);
      installWindowBridges({ api: { activity: { plans: { update } } } });

      await createClient().command('plan.update', {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        planId: 'plan-1',
        content: '# Updated',
        reviewStatus: 'approved',
        source: 'claude',
        hidden: false,
      });

      expect(update).toHaveBeenCalledWith({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        planId: 'plan-1',
        content: '# Updated',
        reviewStatus: 'approved',
        source: 'claude',
        hidden: false,
      });
    });

    it('plan.update rejects unknown source/reviewStatus values and missing plans', async () => {
      const update = jest.fn().mockResolvedValue(null);
      installWindowBridges({ api: { activity: { plans: { update } } } });
      const client = createClient();

      await expect(
        client.command('plan.update', {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          planId: 'plan-1',
          source: 'quantum-oracle',
        }),
      ).rejects.toThrow('Unknown plan source "quantum-oracle".');
      await expect(
        client.command('plan.update', {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          planId: 'plan-1',
          reviewStatus: 'vibed',
        }),
      ).rejects.toThrow('Unknown plan review status "vibed".');
      expect(update).not.toHaveBeenCalled();

      await expect(
        client.command('plan.update', {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          planId: 'plan-404',
          hidden: true,
        }),
      ).rejects.toThrow('Plan not found.');
    });
  });

  describe('repo rules', () => {
    const wrapped = (channel: string, message: string): Error =>
      new Error(`Error invoking remote method '${channel}': Error: ${message}`);

    it('surfaces scan, preview, apply, and status errors without the IPC wrapper', async () => {
      const message = 'Cursor rules changed since this review. Scan again.';
      installWindowBridges({
        api: {
          repoRules: {
            scan: jest
              .fn()
              .mockRejectedValue(wrapped('repo-rules:scan', message)),
            status: jest
              .fn()
              .mockRejectedValue(wrapped('repo-rules:status', message)),
            preview: jest
              .fn()
              .mockRejectedValue(wrapped('repo-rules:preview', message)),
            apply: jest
              .fn()
              .mockRejectedValue(wrapped('repo-rules:apply', message)),
          },
          editorSetup: {
            presence: jest
              .fn()
              .mockRejectedValue(wrapped('editor-setup:presence', message)),
          },
        },
      });
      const client = createClient();
      const scanId = '00000000-0000-4000-8000-000000000000';

      await expect(
        client.query('repoRules.scan', { workspaceId: 'ws-1' }),
      ).rejects.toHaveProperty('message', message);
      await expect(
        client.query('repoRules.status', { workspaceId: 'ws-1' }),
      ).rejects.toHaveProperty('message', message);
      await expect(
        client.query('repoRules.preview', {
          workspaceId: 'ws-1',
          scanId,
          ruleId: 'rule-1',
        }),
      ).rejects.toHaveProperty('message', message);
      await expect(
        client.query('editorSetup.presence', { workspaceId: 'ws-1' }),
      ).rejects.toHaveProperty('message', message);
      await expect(
        client.command('repoRules.apply', {
          workspaceId: 'ws-1',
          enabled: true,
          scanId,
          disabledRuleIds: [],
        }),
      ).rejects.toHaveProperty('message', message);
    });
  });

  describe('chat.getTabSettings', () => {
    it('returns null when nothing was persisted this session (documented cache semantics)', async () => {
      installWindowBridges({ api: {} });
      await expect(
        createClient().query('chat.getTabSettings', { chatId: 'chat-1' }),
      ).resolves.toBeNull();
    });

    it('serves the write-through cache after a persistTabSettings call', async () => {
      const command = jest
        .fn<Promise<ChatCommandResult>, [ChatCommandRequest]>()
        .mockResolvedValue({
          commandId: 'command-1',
          revision: 2,
          outcome: 'applied',
        });
      installWindowBridges({ api: { chat: { command } } });

      const client = createClient();
      const settings = {
        planMode: true,
        proposalMode: 'optional',
        thinkingLevel: 'medium',
      } as const;
      await client.command('chat.persistTabSettings', {
        chatId: 'chat-1',
        scope: 'worktree',
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        settings,
      });

      await expect(
        client.query('chat.getTabSettings', { chatId: 'chat-1' }),
      ).resolves.toEqual(settings);
      // A different client instance has its own session cache.
      await expect(
        createClient().query('chat.getTabSettings', { chatId: 'chat-1' }),
      ).resolves.toBeNull();
    });
  });
});

describe('file mutations and index', () => {
  it.each([
    [
      'file.create',
      {
        operation: 'create-file',
        target: { repoId: 'repo-1', relativePath: 'src/new.ts' },
      },
    ],
    [
      'file.mkdir',
      {
        operation: 'create-directory',
        target: { repoId: 'repo-1', relativePath: 'src/new.ts' },
      },
    ],
    [
      'file.rename',
      {
        operation: 'move',
        source: { repoId: 'repo-1', relativePath: 'src/new.ts' },
        target: { repoId: 'repo-1', relativePath: 'src/renamed.ts' },
        conflict: 'error',
      },
    ],
    [
      'file.delete',
      {
        operation: 'delete',
        target: { repoId: 'repo-1', relativePath: 'src/new.ts' },
        useTrash: true,
      },
    ],
  ] as const)(
    '%s delegates to the desktop mutation service',
    async (command, request) => {
      const mutateFileTree = jest.fn(() => Promise.resolve({}));
      installWindowBridges({
        api: {
          getFileTreeRoots: jest.fn(() => Promise.resolve(FILE_ROOTS)),
          mutateFileTree,
        },
      });
      const result = await createClient().command(command, {
        projectId: 'p',
        worktreeId: 'wt-1',
        fileRootLocalId: 'repo-1',
        relativePath: 'src/new.ts',
        toRelativePath: 'src/renamed.ts',
      });
      expect(mutateFileTree).toHaveBeenCalledWith({
        projectId: 'p',
        worktreeId: 'wt-1',
        ...request,
      });
      expect(result).toMatchObject({
        fileRootLocalId: 'repo-1',
        kind: command.slice(5),
      });
      if (command === 'file.rename')
        expect(result).toMatchObject({
          path: 'src/renamed.ts',
          fromPath: 'src/new.ts',
        });
    },
  );

  it('filters the desktop index to the root and case-insensitive query', async () => {
    const getFileIndex = jest.fn(() =>
      Promise.resolve({
        repos: [
          {
            repoId: 'repo-1',
            files: [
              { relativePath: 'src/a.ts' },
              { relativePath: 'README.md' },
            ],
            truncated: false,
          },
          { repoId: 'repo-2', files: [{ relativePath: 'src/other.ts' }] },
        ],
      }),
    );
    installWindowBridges({ api: { getFileIndex } });
    const index = await createClient().query('file.index', {
      projectId: 'p',
      worktreeId: 'wt-1',
      fileRootLocalId: 'repo-1',
      q: 'SRC',
    });
    expect(getFileIndex).toHaveBeenCalledWith({
      projectId: 'p',
      worktreeId: 'wt-1',
      purpose: 'file-explorer',
    });
    expect(index).toEqual({
      fileRootLocalId: 'repo-1',
      paths: ['src/a.ts'],
      truncated: false,
    });
  });
});

it('forwards setup commands and progress through the preload bridge', async (): Promise<void> => {
  const progress = {
    projectId: 'p1',
    instanceId: null,
    state: 'claiming',
    message: 'Claiming a setup slot',
    percent: null,
    updatedAt: new Date().toISOString(),
  } satisfies OrgProjectSetupProgress;
  const start = jest.fn(
    (): Promise<OrgProjectSetupProgress> => Promise.resolve(progress),
  );
  const cancel = jest.fn(async (): Promise<void> => {});
  const unsubscribe = jest.fn();
  const onProgress = jest.fn(
    (listener: (value: typeof progress) => void): (() => void) => {
      listener(progress);
      return unsubscribe;
    },
  );
  installWindowBridges({
    api: {
      orgProjects: {
        setupStart: start,
        setupCancel: cancel,
        onSetupProgress: onProgress,
      },
    },
  });
  const client = new IpcCanopyClient(createDesktopCapabilities('darwin'));
  expect(
    await client.command('orgProjects.setupStart', {
      projectId: 'p1',
      destinationRoot: '/chosen',
    }),
  ).toEqual(progress);
  await client.command('orgProjects.setupCancel', { projectId: 'p1' });
  expect(start).toHaveBeenCalledWith({
    projectId: 'p1',
    destinationRoot: '/chosen',
  });
  expect(cancel).toHaveBeenCalledWith({ projectId: 'p1' });
  const listener = jest.fn();
  const off = client.subscribe('org-projects.setup-progress', listener);
  expect(listener).toHaveBeenCalledWith({
    progress,
    occurredAt: progress.updatedAt,
  });
  off();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

it('routes additive sidebar group commands while presentation capability remains disabled', async () => {
  const group = {
    id: 'grp-a',
    name: 'Group',
    color: 'neutral',
    collapsed: false,
    memberIds: ['wt-1'],
  };
  const bridge = {
    create: jest.fn(() => Promise.resolve(group)),
    update: jest.fn(() => Promise.resolve()),
    ungroup: jest.fn(() => Promise.resolve()),
    moveItem: jest.fn(() => Promise.resolve()),
    moveGroup: jest.fn(() => Promise.resolve()),
  };
  installWindowBridges({ api: { sidebarItemGroups: bridge } });
  const client = createClient();
  expect(client.capabilities.itemGrouping).toBe(false);
  const scope = { workspaceLocalId: 'ws-1' };
  await expect(
    client.command('sidebar.itemGroups.create', { scope, itemId: 'wt-1' }),
  ).resolves.toEqual(group);
  await client.command('sidebar.itemGroups.update', {
    scope,
    groupId: 'grp-a',
    name: 'Renamed',
  });
  await client.command('sidebar.itemGroups.ungroup', {
    scope,
    groupId: 'grp-a',
  });
  await client.command('sidebar.itemGroups.moveItem', {
    scope,
    itemId: 'wt-1',
    groupId: null,
  });
  await client.command('sidebar.itemGroups.moveGroup', {
    scope,
    groupId: 'grp-a',
    before: 'wt-2',
  });
  expect(bridge.create).toHaveBeenCalledWith({ scope, itemId: 'wt-1' });
  expect(bridge.update).toHaveBeenCalledWith({
    scope,
    groupId: 'grp-a',
    name: 'Renamed',
  });
  expect(bridge.ungroup).toHaveBeenCalledWith({ scope, groupId: 'grp-a' });
  expect(bridge.moveItem).toHaveBeenCalledWith({
    scope,
    itemId: 'wt-1',
    groupId: null,
  });
  expect(bridge.moveGroup).toHaveBeenCalledWith({
    scope,
    groupId: 'grp-a',
    before: 'wt-2',
  });
});

it.each([
  ['client', 'invite_refused'],
  ['dialog', 'invite_refused'],
  ['client', 'no_saved_card'],
  ['dialog', 'no_saved_card'],
])(
  'preserves typed organization refusals across the preload bridge for %s (%s)',
  async (caller, code) => {
    const ORG = '11111111-1111-4111-8111-111111111111';
    const refusal = {
      error: 'Seat payment failed',
      code,
      status: 409,
    };
    const bridge = { inviteStatus: jest.fn(() => Promise.resolve(refusal)) };
    installWindowBridges({
      api: {
        loadCanopyCloudAccount: jest.fn(() =>
          Promise.resolve({ account: { id: 'account-1' } }),
        ),
        personalOrganizationUpgrade: bridge,
      },
    });
    const reply =
      caller === 'client'
        ? createClient().query('organization.inviteStatus', {
            organizationId: ORG,
            email: 'pat@example.com',
          })
        : desktopPersonalOrganizationUpgradePort(
            'account-1',
            true,
            true,
          ).reconcileInvite?.(ORG, 'pat@example.com');
    await expect(reply).rejects.toMatchObject({
      name: 'OrganizationOperationFailure',
      code,
      status: 409,
    });
  },
);

it('routes Personal organization upgrade operations to the preload bridge', async () => {
  const ORG = '11111111-1111-4111-8111-111111111111';
  const OP = '22222222-2222-4222-8222-222222222222';
  const bridge = {
    promote: jest.fn(() =>
      Promise.resolve({
        promotion: {
          organizationId: ORG,
          name: 'Acme',
          personalOrganizationId: OP,
          operationId: OP,
          alreadyUpgraded: false,
          warnings: [],
        },
        contextSwitched: true,
        warnings: [],
      }),
    ),
    invite: jest.fn(() => Promise.resolve({ status: 'sent', inviteId: OP })),
    listProjects: jest.fn(() => Promise.resolve({ projects: [] })),
    convert: jest.fn(() => Promise.resolve({ operationId: OP })),
    status: jest.fn(() => Promise.resolve(null)),
  };
  installWindowBridges({ api: { personalOrganizationUpgrade: bridge } });
  const client = createClient();
  await client.command('personalOrganization.upgrade', {
    organizationId: ORG,
    name: 'Acme',
    operationId: OP,
  });
  await client.command('organization.invite', {
    organizationId: ORG,
    invite: { email: 'pat@example.com' },
  });
  await client.query('personalOrganization.projects', {});
  await client.command('personalOrganization.convertProjects', {
    operationId: OP,
    organizationId: ORG,
    workspaceIds: ['ws-a'],
  });
  await client.query('personalOrganization.operationStatus', {
    operationId: OP,
  });
  expect(bridge.promote).toHaveBeenCalledWith({
    organizationId: ORG,
    name: 'Acme',
    operationId: OP,
  });
  expect(bridge.invite).toHaveBeenCalledWith({
    organizationId: ORG,
    invite: { email: 'pat@example.com' },
  });
  expect(bridge.listProjects).toHaveBeenCalledTimes(1);
  expect(bridge.convert).toHaveBeenCalledWith({
    operationId: OP,
    organizationId: ORG,
    workspaceIds: ['ws-a'],
  });
  expect(bridge.status).toHaveBeenCalledWith({ operationId: OP });
});

it('wires the local transcript read seam and opts into delegation reads', () => {
  const client = createClient();
  expect(client.capabilities.delegationTranscriptReads).toBe(true);
  expect(client.capabilities.delegationBlockReads).toBe(true);
  expect(client.capabilities.primaryContentReads).toBe(true);
  expect(typeof client.transcripts.delegationPage).toBe('function');
  expect(typeof client.transcripts.content).toBe('function');
});

it('maps managed-delegation lifetime reads, extension, and scoped change events', async () => {
  const scope = { projectId: 'project-1', worktreeId: 'worktree-1' };
  const status = {
    kind: 'available',
    occupied: 4,
    retained: 4,
    limit: 4,
    cap: 8,
    atLimit: true,
    canExtend: true,
    atCap: false,
    refusedChatIds: ['chat-1'],
  } satisfies ManagedDelegationLifetimeStatus;
  const extension = {
    ok: true,
    baseline: 4,
    effectiveLimit: 8,
    retained: 4,
  } satisfies ManagedDelegationExtendLifetimeLimitResult;
  type LifetimeScope = { projectId: string; worktreeId: string };
  let emitChanged: (event: LifetimeScope) => void = () => {};
  const unsubscribe = jest.fn();
  const getLifetimeStatus = jest.fn<Promise<typeof status>, [LifetimeScope]>(
    () => Promise.resolve(status),
  );
  const extendLifetimeLimit = jest.fn<
    Promise<typeof extension>,
    [LifetimeScope]
  >(() => Promise.resolve(extension));
  const onLifetimeChanged = jest.fn(
    (listener: (event: LifetimeScope) => void) => {
      emitChanged = listener;
      return unsubscribe;
    },
  );
  installWindowBridges({
    api: {
      managedDelegation: {
        getLifetimeStatus,
        extendLifetimeLimit,
        onLifetimeChanged,
      },
    },
  });
  const client = createClient();
  expect(client.capabilities.delegationLifetimeStatusReads).toBe(true);
  expect(client.capabilities.delegationLifetimeLimitExtension).toBe(true);
  await expect(
    client.query('delegation.lifetimeStatus', scope),
  ).resolves.toEqual(status);
  expect(getLifetimeStatus).toHaveBeenCalledWith(scope);
  await expect(
    client.command('delegation.extendLifetimeLimit', scope),
  ).resolves.toEqual(extension);
  expect(extendLifetimeLimit).toHaveBeenCalledWith(scope);

  const listener = jest.fn<void, [LifetimeScope & { occurredAt: string }]>();
  const off = client.subscribe('delegation.lifetimeChanged', listener, scope);
  expect(onLifetimeChanged).toHaveBeenCalledTimes(1);
  emitChanged({ projectId: 'other-project', worktreeId: scope.worktreeId });
  emitChanged({ projectId: scope.projectId, worktreeId: 'other-worktree' });
  expect(listener).not.toHaveBeenCalled();
  emitChanged(scope);
  const [event] = listener.mock.calls[0] ?? [];
  expect(event?.projectId).toBe(scope.projectId);
  expect(event?.worktreeId).toBe(scope.worktreeId);
  expect(typeof event?.occurredAt).toBe('string');
  off();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

it('refreshes Copilot account quotas through the existing observability authority', async () => {
  const refreshUsage = jest.fn().mockResolvedValue({});
  installWindowBridges({ api: { observability: { refreshUsage } } });
  await createClient().command('providerUsage.refresh', {
    provider: 'copilot',
  });
  expect(refreshUsage).toHaveBeenCalledWith('copilot');
});

describe('script actions', () => {
  it('forwards scoped change events and drops other worktrees', () => {
    let emit:
      | ((context: { projectId: string; worktreeId: string }) => void)
      | undefined;
    const off = jest.fn();
    installWindowBridges({
      api: {
        scriptActions: {
          onChanged: (
            listener: (context: {
              projectId: string;
              worktreeId: string;
            }) => void,
          ) => {
            emit = listener;
            return off;
          },
        },
      },
    });
    const handler = jest.fn();
    const unsubscribe = createClient().subscribe(
      'scriptActions.changed',
      handler,
      { projectId: 'p1', worktreeId: 'w1' },
    );
    emit?.({ projectId: 'p1', worktreeId: 'w2' });
    emit?.({ projectId: 'p1', worktreeId: 'w1' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1', worktreeId: 'w1' }),
    );
    unsubscribe();
    expect(off).toHaveBeenCalled();
  });

  it('passes typed bridge errors through unchanged', async () => {
    const error = Object.assign(new Error('Stale'), { code: 'stale_revision' });
    installWindowBridges({
      api: { scriptActions: { review: () => Promise.reject(error) } },
    });
    await expect(
      createClient().command('scriptActions.review', {
        projectId: 'p1',
        worktreeId: 'w1',
        entries: [{ id: 'a', revision: 'r' }],
        decision: 'approve',
      }),
    ).rejects.toBe(error);
  });
});

test('shared multi-repo client forwards immutable requests and observes without replaying creation', async () => {
  const prepare = jest.fn().mockResolvedValue({ repositories: [] });
  const create = jest.fn().mockResolvedValue({ state: 'creating' });
  const getCreation = jest.fn().mockResolvedValue(null);
  const listCreations = jest.fn().mockResolvedValue([]);
  const setupCancel = jest.fn().mockResolvedValue(undefined);
  installWindowBridges({
    api: {
      orgProjects: {
        sharedMultiRepo: { prepare, create, getCreation, listCreations },
        setupCancel,
      },
    },
  });
  const client = createClient();
  const params = {
    mode: 'convert' as const,
    selections: [{ kind: 'workspace' as const, id: 'source' }],
    request: {
      organizationId: 'org',
      creationKey: 'same-key',
      name: 'New shared project',
      sourceProjects: [{ projectId: 'definition', expectedRevision: 2 }],
    },
  };
  await client.sharedMultiRepo.prepare(params);
  await client.sharedMultiRepo.create(params);
  await client.sharedMultiRepo.getCreation('same-key');
  await client.sharedMultiRepo.listCreations();
  await client.sharedMultiRepo.cancelSetup('org', 'destination');
  expect(prepare).toHaveBeenCalledWith(params);
  expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith(params);
  expect(getCreation).toHaveBeenCalledWith('same-key');
  expect(listCreations).toHaveBeenCalledTimes(1);
  expect(setupCancel).toHaveBeenCalledWith({ projectId: 'destination' });
  await client.sharedMultiRepo.resume?.('same-key');
  expect(create).toHaveBeenLastCalledWith({ creationKey: 'same-key' });
});

test('repository URLs use the always-external desktop browser path', () => {
  const openExternal = jest.fn().mockResolvedValue(undefined);
  installWindowBridges({ api: { browser: { openExternal } } });
  createClient().openExternalUrl('https://github.com/acme/setup-repo');
  expect(openExternal).toHaveBeenCalledWith({
    url: 'https://github.com/acme/setup-repo',
  });
});
