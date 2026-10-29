import { dispatchLegacyChatCreation } from '../app-advisor/creation-adapters';
jest.mock('../app-advisor/creation-adapters', () => ({
  dispatchLegacyChatCreation: jest.fn(),
}));
import { dispatchAgentChatCreation } from '../agent-messaging/creation-orchestration';
import {
  CHAT_CREATION_ACTION_TYPES,
  chatCreationActionSchema,
} from '@canopy/desktop-shared/lib/chat-send-actions';
jest.mock('../agent-messaging/creation-orchestration', () => ({
  dispatchAgentChatCreation: jest.fn(),
}));
import { dispatchAgentChatSteer } from '../agent-messaging/steer-orchestration';
import { dispatchAgentChatSchedule } from '../agent-messaging/schedule-orchestration';
jest.mock('../agent-messaging/steer-orchestration', () => ({
  dispatchAgentChatSteer: jest.fn(),
}));
jest.mock('../agent-messaging/schedule-orchestration', () => ({
  dispatchAgentChatSchedule: jest.fn(),
}));
import {
  dispatchAgentChatSend,
  AgentChatSendError,
} from '../agent-messaging/send-orchestration';
jest.mock('../agent-messaging/send-orchestration', () => ({
  AgentChatSendError: class extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  isAgentChatSendError: (cause: unknown): boolean =>
    cause instanceof Error && 'code' in cause,
  dispatchAgentChatSend: jest.fn(),
}));
const mockResolveSendTarget = jest.fn();
jest.mock('../project-discovery/chat-target', () => ({
  resolveAuthorizedChat: mockResolveSendTarget,
}));
const mockResolveLegacyEntry = jest.fn();
jest.mock('../lib/cowork-work-entries', () => ({
  resolveWorkEntryForChat: mockResolveLegacyEntry,
}));
import {
  projectReadActionSchema,
  PROJECT_READ_ACTION_TYPES,
} from '@canopy/desktop-shared/lib/project-reads';
import { BOT_ACTION_TYPES } from '@canopy/desktop-shared/lib/bot-discovery';
import { dispatchProjectReadAction } from '../project-discovery/reads';
jest.mock('../project-discovery/reads', () => ({
  dispatchProjectReadAction: jest.fn().mockResolvedValue({ ok: true }),
}));
import { dispatchProjectDiscoveryAction } from '../project-discovery';
import { projectDiscoveryActionSchema } from '@canopy/desktop-shared/lib/project-discovery';
jest.mock('../project-discovery', () => ({
  dispatchProjectDiscoveryAction: jest
    .fn()
    .mockResolvedValue({ ok: true, result: { items: [] } }),
}));
import { dispatchBotAction } from '../project-discovery/bots';
jest.mock('../project-discovery/bots', () => ({
  dispatchBotAction: jest
    .fn()
    .mockResolvedValue({ ok: true, result: { botId: 'app_advisor' } }),
}));
import type {
  AgentResourceAction,
  AgentResourceActionRuntime,
} from '../canopy-tools/resource-actions';
import type { AppAdvisorActionResponse } from '@canopy/desktop-shared/types';
const mockHeadlessResourceAction = jest.fn<
  Promise<AppAdvisorActionResponse>,
  [AgentResourceAction, AgentResourceActionRuntime]
>();
jest.mock('../canopy-tools/resource-actions', () => ({
  isAgentResourceAction: (action: { type: string }): boolean =>
    [
      'automation.create',
      'automation.update',
      'automation.run_now',
      'automation.get',
      'automation.delete',
      'automation.disable',
      'automation.list',
    ].includes(action.type),
  dispatchAgentResourceAction: mockHeadlessResourceAction,
}));
const mockExperimentDispatch = jest.fn();
jest.mock('../agent-actions/desktop-surface', () => ({
  executeDesktopAgentActionTool: mockExperimentDispatch,
}));
const mockArchiveIngest = jest.fn().mockResolvedValue(true);
jest.mock('../services/chat-state-service', (): unknown => ({
  getChatStateService: (): {
    ingestProviderEvent: typeof mockArchiveIngest;
  } => ({ ingestProviderEvent: mockArchiveIngest }),
}));
import type * as ShowFilesRuntimeModule from '../canopy-tools/show-files-runtime';
import {
  dispatchScopedBrowserAction,
  dispatchWorktreeAction,
} from '../canopy-tools/worktree-actions';
const mockStartSplitAgent = jest.fn().mockResolvedValue({
  ok: true,
  chatId: 'advisor-fork',
  worktreeId: 'advisor-entry',
  delivery: 'submitted',
  independent: true,
});
jest.mock('../canopy-tools/start-split-agent-runtime', () => ({
  startSplitAgent: mockStartSplitAgent,
}));
jest.mock('../canopy-tools/worktree-actions', () => ({
  dispatchScopedBrowserAction: jest
    .fn()
    .mockResolvedValue({ requestId: '', ok: true }),
  dispatchWorktreeAction: jest.fn().mockResolvedValue({
    requestId: '',
    ok: true,
    result: { scriptKey: 'project:test', started: true },
  }),
}));
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  type AppAdvisorWatcherDestination,
  type AppAdvisorUiStateEnvelope,
  type OrgRepositoryOwnerLookup,
  type OrgRepositoryOwnerRequest,
} from '@canopy/desktop-shared/types';
import type { AppAdvisorToolRuntimeSurfaces } from '../app-advisor/runtime';
import { createAppAdvisorToolRuntime } from '../app-advisor/runtime';
import { appAdvisorActionSchema } from '../app-advisor/definitions';
import { executeCanopyInjectedTool } from '../canopy-tools/core';
import * as canopyCore from '../canopy-tools/core';
import * as graphAvailability from '../lib/code-graph-availability';
import { executeAppAdvisorTool } from '../app-advisor/tool-executor';
import { setDelegationActivity } from '../agents/delegation/activity';
import * as appAdvisorIpc from '../ipc/app-advisor';
import { setLatestAppAdvisorUiState } from '../ipc/app-advisor';
import {
  loadWorktreePipelineYaml,
  loadWorktreeScriptOutput,
  respondToFileCommentInSession,
} from '../canopy-tools/session-runtime';
import { requestShowFiles } from '../canopy-tools/show-files-runtime';
import { createApprovalSession } from '../approvals/approval-service';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { logMainProcessWarn } from '../lib/main-process-logging';

jest.mock('electron', () => ({
  ipcMain: {
    on: jest.fn(),
    removeHandler: jest.fn(),
    handle: jest.fn(),
  },
}));

jest.mock('../services/pipelines-service', () => ({
  getPipelineFailureDebugContext: jest.fn(),
}));

jest.mock('../canopy-tools/session-runtime', () => ({
  loadWorktreePipelineYaml: jest.fn(),
  loadWorktreeScriptOutput: jest.fn(),
  getFileCommentsInSession: jest.fn(),
  respondToFileCommentInSession: jest.fn(),
}));

jest.mock('../canopy-tools/show-files-runtime', () => ({
  ...jest.requireActual<typeof ShowFilesRuntimeModule>(
    '../canopy-tools/show-files-runtime',
  ),
  requestShowFiles: jest.fn(),
}));

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    pauseChatTurn: jest.fn(),
    resumeChatTurn: jest.fn(),
  })),
}));

const mockedLoadWorktreePipelineYaml = jest.mocked(loadWorktreePipelineYaml);
const mockedDispatchBotAction = jest.mocked(dispatchBotAction);
const mockedRespondToFileCommentInSession = jest.mocked(
  respondToFileCommentInSession,
);
const mockSearchWatchers = jest.fn();
const mockSetupWatchers = jest.fn();
const mockSetupCanonicalChatWatchers = jest.fn();
const mockProjectCanonicalChatWatchers = jest.fn();
const mockDeleteAgentWatchers = jest.fn();
const mockCreateLocalWatcher = jest.fn();
const mockCaptureLocalExecutionScope = jest.fn();

jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    search: mockSearchWatchers,
    setup: mockSetupWatchers,
    setupCanonicalChatWatchers: mockSetupCanonicalChatWatchers,
    projectCanonicalChatWatchers: mockProjectCanonicalChatWatchers,
    deleteAgentWatchers: mockDeleteAgentWatchers,
    createLocalWatcher: mockCreateLocalWatcher,
    captureLocalExecutionScope: mockCaptureLocalExecutionScope,
  })),
}));

jest.mock('../approvals/approval-service', () => ({
  createApprovalSession: jest.fn(),
}));

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
}));

// The factory reads the mock lazily, on each lookup, so it is initialized
// by the time the runtime's deferred import reaches this module.
const mockedFindRepositoryOwner = jest.fn<
  Promise<OrgRepositoryOwnerLookup>,
  [OrgRepositoryOwnerRequest]
>();
jest.mock('../lib/main-process-logging', (): unknown => ({
  logMainProcessWarn: jest.fn(),
}));
jest.mock('../lib/org-repository-owner', (): unknown => ({
  getOrgRepositoryOwnerLookup: (): unknown => ({
    find: (
      request: OrgRepositoryOwnerRequest,
    ): Promise<OrgRepositoryOwnerLookup> => mockedFindRepositoryOwner(request),
  }),
}));

const mockedLogMainProcessWarn = jest.mocked(logMainProcessWarn);
const mockedLoadWorktreeScriptOutput = jest.mocked(loadWorktreeScriptOutput);
const mockedRequestShowFiles = jest.mocked(requestShowFiles);
const mockedCreateApprovalSession = jest.mocked(createApprovalSession);
const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);

function state(
  selectedWorktree?: AppAdvisorUiStateEnvelope['snapshot']['selectedWorktree'],
): AppAdvisorUiStateEnvelope {
  return {
    version: 1,
    revision: 7,
    capturedAt: '2026-05-19T00:00:00.000Z',
    digest: 'digest',
    snapshot: {
      activePage: 'main',
      overlays: {
        commandPaletteOpen: false,
        fileSearchPaletteOpen: false,
        prPickerOpen: false,
        canopyPortalOpen: false,
        appAdvisorOpen: true,
      },
      ...(selectedWorktree ? { selectedWorktree } : {}),
    },
  };
}

function makeSurfaces(): AppAdvisorToolRuntimeSurfaces {
  return {
    getMainWindow: () => null,
    getAppAdvisorWindow: () => null,
    openAppAdvisorWindow: jest.fn(() =>
      Promise.resolve({ open: true, focused: true }),
    ),
    ensureAppAdvisorWindow: jest.fn(() =>
      Promise.resolve({ open: false, focused: false }),
    ),
  };
}

function destination(): AppAdvisorWatcherDestination {
  return {
    projectId: APP_ADVISOR_PROJECT_ID,
    worktreeId: APP_ADVISOR_WORKTREE_ID,
    chatId: 'advisor-chat',
  };
}

describe('createAppAdvisorToolRuntime', () => {
  it('routes experiment choices through the shared main action without a renderer round trip', async () => {
    mockExperimentDispatch.mockResolvedValue({
      text: '{"ok":true}',
      isError: false,
    });
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());
    const action = {
      type: 'experiments.set_enabled',
      experimentId: 'early-access',
      enabled: true,
    };
    const result = await executeAppAdvisorTool(
      'dispatch_action',
      { action },
      runtime,
      { toolUseId: 'labs-tool' },
    );
    expect(result.isError).toBe(false);
    expect(mockExperimentDispatch).toHaveBeenCalledWith(
      'dispatch_action',
      { action },
      runtime,
      { toolUseId: 'labs-tool' },
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockHeadlessResourceAction
      .mockReset()
      .mockResolvedValue({ requestId: '', ok: true });
    mockedLoadWorktreeScriptOutput.mockResolvedValue({
      found: true,
      lines: ['ok'],
    });
    mockedLoadWorktreePipelineYaml.mockResolvedValue({
      ok: true,
      text: 'Pipeline YAML: Review (review)',
    });
    mockSearchWatchers.mockResolvedValue({ catalog: [], activeWatchers: [] });
    mockSetupWatchers.mockResolvedValue({ ok: true, results: [] });
    mockSetupCanonicalChatWatchers.mockResolvedValue({ ok: true, results: [] });
    mockProjectCanonicalChatWatchers.mockResolvedValue([]);
    mockCreateLocalWatcher.mockResolvedValue({ id: 'watcher-command' });
    mockCaptureLocalExecutionScope.mockImplementation(
      (scope: { projectId: string; worktreeId: string }) =>
        Promise.resolve({
          ...scope,
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
    );
    mockedResolveWorktreeCwd.mockReturnValue('/selected/worktree');
    mockedCreateApprovalSession.mockReturnValue({
      check: jest.fn().mockResolvedValue({ decision: 'allow' }),
      setMode: jest.fn(),
      dispose: jest.fn(),
    });
    mockedRequestShowFiles.mockResolvedValue({
      opened: 1,
      failed: 0,
      files: [{ path: '/target/file.ts', ok: true }],
    });
  });

  it.each([true, false])(
    'persists auto-archive %s on the calling Advisor chat',
    async (enabled) => {
      const source = {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'advisor-entry',
        chatId: 'advisor-source',
      };
      const runtime = createAppAdvisorToolRuntime(makeSurfaces(), source);
      expect(runtime.setAutoArchiveForCurrentChat).toBeDefined();
      await runtime.setAutoArchiveForCurrentChat?.(enabled);
      expect(mockArchiveIngest).toHaveBeenCalledWith(
        expect.objectContaining({
          ...source,
          data: { type: 'canopy_set_auto_archive_requested', enabled },
        }),
      );
    },
  );

  it.each([
    { live: 1, queued: 0 },
    { live: 0, queued: 1 },
  ])(
    'reports deferred auto-archive for the calling Advisor chat with $live live and $queued queued delegates',
    async ({ live, queued }) => {
      const source = {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'advisor-entry',
        chatId: 'advisor-source',
      };
      const runtime = createAppAdvisorToolRuntime(makeSurfaces(), source);
      const sessionKey = `${source.projectId}/${source.worktreeId}/${source.chatId}`;
      const owner = 'advisor-auto-archive';
      setDelegationActivity(owner, sessionKey, live, queued);
      try {
        await expect(
          executeCanopyInjectedTool(
            'set_auto_archive',
            { enabled: true },
            runtime,
          ),
        ).resolves.toEqual({
          text: 'Auto-archive is on. This chat will be archived after its delegates finish.',
        });
        await expect(
          executeCanopyInjectedTool(
            'set_auto_archive',
            { enabled: false },
            runtime,
          ),
        ).resolves.toEqual({
          text: 'Auto-archive is disabled for this chat; it will stay open when the current agent turn completes.',
        });
        expect(mockArchiveIngest).toHaveBeenCalledTimes(2);
        expect(mockArchiveIngest).toHaveBeenLastCalledWith(
          expect.objectContaining({
            ...source,
            data: { type: 'canopy_set_auto_archive_requested', enabled: false },
          }),
        );
      } finally {
        setDelegationActivity(owner, sessionKey, 0);
      }
      // Delegates in a sibling chat must not defer this chat's archive.
      setDelegationActivity(
        owner,
        `${source.projectId}/${source.worktreeId}/sibling`,
        1,
      );
      try {
        await expect(
          executeCanopyInjectedTool(
            'set_auto_archive',
            { enabled: true },
            runtime,
          ),
        ).resolves.toEqual({
          text: 'Auto-archive is enabled for this chat when the current agent turn completes.',
        });
      } finally {
        setDelegationActivity(owner, sessionKey, 0);
      }
    },
  );

  it('omits the fork for runtimes that cannot fork (managed terminals)', () => {
    const runtime = createAppAdvisorToolRuntime(
      makeSurfaces(),
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'advisor-entry',
        chatId: 'advisor-source',
      },
      { canFork: false },
    );
    expect('startForkedAgent' in runtime).toBe(false);
  });

  it('forks from the owning Advisor entry rather than the selected worktree', async () => {
    const surfaces = makeSurfaces();
    const source = {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'advisor-entry',
      chatId: 'advisor-source',
    };
    const runtime = createAppAdvisorToolRuntime(surfaces, source);
    if (!runtime.startForkedAgent) throw new Error('Missing fork runtime');
    const signal = new AbortController().signal;
    await expect(
      runtime.startForkedAgent('Explore independently', signal),
    ).resolves.toMatchObject({
      chatId: 'advisor-fork',
      worktreeId: 'advisor-entry',
    });
    expect(mockStartSplitAgent).toHaveBeenCalledWith(
      'start_forked_agent',
      { followUpInstruction: 'Explore independently' },
      expect.objectContaining({
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'advisor-entry',
        chatId: 'advisor-source',
        appAdvisorSurfaces: surfaces,
        signal,
      }),
    );
  });

  it('preserves the App Advisor chat origin for another project', async () => {
    const surfaces = makeSurfaces();
    const runtime = createAppAdvisorToolRuntime(surfaces, destination());

    await runtime.showFiles([{ path: '/target/file.ts' }], {
      projectId: 'project-2',
      worktreeId: 'worktree-2',
    });

    expect(mockedRequestShowFiles).toHaveBeenCalledWith(
      {
        files: [{ path: '/target/file.ts' }],
        target: { projectId: 'project-2', worktreeId: 'worktree-2' },
        origin: {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: APP_ADVISOR_WORKTREE_ID,
          chatTabId: 'advisor-chat',
        },
      },
      surfaces,
    );
  });

  it('routes script review to the main window that owns the shared review host', async () => {
    const requestSpy = jest
      .spyOn(appAdvisorIpc, 'requestAppAdvisorRendererTool')
      .mockResolvedValueOnce({ requestId: 'script-review', ok: true });
    const surfaces = makeSurfaces();
    const runtime = createAppAdvisorToolRuntime(surfaces, destination());
    await runtime.dispatchRendererAction(
      {
        type: 'script_actions.open_review',
        workspaceId: 'project-1',
        inWorktreeId: 'tree-1',
      },
      undefined,
      'script-review',
    );
    expect(requestSpy.mock.calls[0]?.[1].getAppAdvisorWindow()).toBeNull();
    expect(requestSpy.mock.calls[0]?.[1].getMainWindow).toBe(
      surfaces.getMainWindow,
    );
  });

  it('routes sharing requests through the main window with truthful confirmation semantics', async () => {
    const requestSpy = jest
      .spyOn(appAdvisorIpc, 'requestAppAdvisorRendererTool')
      .mockResolvedValueOnce({ requestId: 'share-request', ok: true });
    const surfaces = makeSurfaces();
    const runtime = createAppAdvisorToolRuntime(surfaces, destination());
    const response = await runtime.dispatchRendererAction(
      { type: 'sharing.open_dialog', target: { kind: 'skill', name: 'mine' } },
      undefined,
      'share-request',
    );
    expect(requestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'dispatch_action',
        originChatTabId: 'advisor-chat',
      }),
      expect.objectContaining({
        getMainWindow: surfaces.getMainWindow,
      }),
    );
    expect(requestSpy.mock.calls[0]?.[1].getAppAdvisorWindow()).toBeNull();
    expect(response.result).toEqual({
      message: 'Share dialog requested; the user confirms in the app.',
    });
    requestSpy.mockRestore();
  });

  it('dispatches browser actions in main with the captured entry even when UI focus differs', async () => {
    const requestSpy = jest.spyOn(
      appAdvisorIpc,
      'requestAppAdvisorRendererTool',
    );
    const surfaces = makeSurfaces();
    const runtime = createAppAdvisorToolRuntime(surfaces, destination());
    const controller = new AbortController();
    await runtime.dispatchRendererAction(
      { type: 'browser.list' },
      undefined,
      'browser-request',
      controller.signal,
    );
    expect(dispatchScopedBrowserAction).toHaveBeenCalledWith(
      { action: { type: 'browser.list' } },
      expect.objectContaining({
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        chatId: 'advisor-chat',
        getWindow: surfaces.getAppAdvisorWindow,
      }),
      controller.signal,
    );
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('names its own chat for approvals when a browser action targets another task', async () => {
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());
    await runtime.dispatchRendererAction(
      {
        type: 'browser.save_download',
        projectId: 'project-2',
        worktreeId: 'worktree-2',
        expectedRuntimeGeneration: 1,
        downloadId: 'download-1',
        path: 'report.csv',
      },
      undefined,
      'save-request',
    );
    expect(dispatchScopedBrowserAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        projectId: 'project-2',
        worktreeId: 'worktree-2',
        chatId: 'advisor-chat',
        approvalChat: {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: APP_ADVISOR_WORKTREE_ID,
          chatId: 'advisor-chat',
        },
      }),
      undefined,
    );
  });

  it.each([
    {
      action: {
        type: 'worktree.run_script' as const,
        projectId: 'project-2',
        worktreeId: 'worktree-2',
        scriptId: 'test',
        waitSeconds: 30,
      },
      scoped: {
        type: 'worktree.run_script',
        scriptId: 'test',
        waitSeconds: 30,
      },
    },
    {
      action: {
        type: 'worktree.list_scripts' as const,
        projectId: 'project-2',
        worktreeId: 'worktree-2',
      },
      scoped: { type: 'worktree.list_scripts' },
    },
  ])(
    'dispatches $scoped.type in main against the requested worktree',
    async ({ action, scoped }) => {
      const requestSpy = jest.spyOn(
        appAdvisorIpc,
        'requestAppAdvisorRendererTool',
      );
      const surfaces = makeSurfaces();
      const runtime = createAppAdvisorToolRuntime(surfaces, destination());
      const controller = new AbortController();

      const response = await runtime.dispatchRendererAction(
        action,
        undefined,
        'script-request',
        controller.signal,
      );

      expect(dispatchWorktreeAction).toHaveBeenCalledWith(
        { action: scoped },
        expect.objectContaining({
          projectId: 'project-2',
          worktreeId: 'worktree-2',
          chatId: 'advisor-chat',
          executionScope: 'worktree',
          getWindow: surfaces.getMainWindow,
          signal: controller.signal,
        }),
      );
      expect(response).toMatchObject({
        requestId: 'script-request',
        ok: true,
        result: { scriptKey: 'project:test' },
      });
      expect(requestSpy).not.toHaveBeenCalled();
      expect(dispatchScopedBrowserAction).not.toHaveBeenCalled();
    },
  );

  describe('workspace.find_repository_owner (CAN-3592)', () => {
    const owner = {
      kind: 'organization',
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      organizationName: 'Acme',
      projectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      projectName: 'Payments',
      repositoryName: 'acme/payments',
    } as const;

    beforeEach(() => {
      mockedFindRepositoryOwner.mockReset();
    });

    it.each([
      { request: { path: '/repos/payments' } },
      { request: { remoteUrl: 'https://github.com/acme/payments.git' } },
    ])(
      'answers $request in main through the owner lookup, unchanged',
      async ({ request }) => {
        mockedFindRepositoryOwner.mockResolvedValue(owner);
        const requestSpy = jest.spyOn(
          appAdvisorIpc,
          'requestAppAdvisorRendererTool',
        );
        const runtime = createAppAdvisorToolRuntime(
          makeSurfaces(),
          destination(),
        );
        const response = await runtime.dispatchRendererAction(
          { type: 'workspace.find_repository_owner', ...request },
          undefined,
          'owner-request',
        );
        expect(mockedFindRepositoryOwner).toHaveBeenCalledTimes(1);
        expect(mockedFindRepositoryOwner).toHaveBeenCalledWith(request);
        expect(response).toEqual({
          requestId: 'owner-request',
          ok: true,
          result: owner,
        });
        // The guard must not echo the request back into the answer.
        expect(JSON.stringify(response)).not.toContain('/repos/payments');
        expect(requestSpy).not.toHaveBeenCalled();
        expect(dispatchScopedBrowserAction).not.toHaveBeenCalled();
        expect(dispatchWorktreeAction).not.toHaveBeenCalled();
      },
    );

    it('passes a none answer through as a successful result', async () => {
      mockedFindRepositoryOwner.mockResolvedValue({ kind: 'none' });
      const runtime = createAppAdvisorToolRuntime(
        makeSurfaces(),
        destination(),
      );
      await expect(
        runtime.dispatchRendererAction(
          { type: 'workspace.find_repository_owner', path: '/repos/other' },
          undefined,
          'none-request',
        ),
      ).resolves.toEqual({
        requestId: 'none-request',
        ok: true,
        result: { kind: 'none' },
      });
    });

    it.each([
      {
        failure: 'rejects',
        arm: (): void => {
          mockedFindRepositoryOwner.mockRejectedValue(
            new Error('catalog exploded'),
          );
        },
      },
      {
        failure: 'throws synchronously',
        arm: (): void => {
          mockedFindRepositoryOwner.mockImplementation(() => {
            throw new Error('catalog exploded');
          });
        },
      },
    ])('fails open to none when the lookup $failure', async ({ arm }) => {
      arm();
      const runtime = createAppAdvisorToolRuntime(
        makeSurfaces(),
        destination(),
      );
      const result = await executeAppAdvisorTool(
        'dispatch_action',
        {
          action: {
            type: 'workspace.find_repository_owner',
            remoteUrl: 'https://github.com/acme/payments.git',
          },
        },
        runtime,
      );
      expect(mockedFindRepositoryOwner).toHaveBeenCalledTimes(1);
      expect(result.isError).not.toBe(true);
      // dispatch_action pretty-prints its JSON (jsonText(response)).
      expect(JSON.parse(result.text)).toMatchObject({
        ok: true,
        result: { kind: 'none' },
      });
      expect(result.text).not.toContain('catalog exploded');
      // A failure that escapes the lookup (it handles its own) is logged.
      expect(mockedLogMainProcessWarn).toHaveBeenCalledTimes(1);
    });

    it('rejects a malformed payload before consulting the lookup', async () => {
      const runtime = createAppAdvisorToolRuntime(
        makeSurfaces(),
        destination(),
      );
      const result = await executeAppAdvisorTool(
        'dispatch_action',
        {
          action: {
            type: 'workspace.find_repository_owner',
            path: '/repos/payments',
            remoteUrl: 'https://github.com/acme/payments.git',
          },
        },
        runtime,
      );
      expect(result.isError).toBe(true);
      expect(mockedFindRepositoryOwner).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['get_context', 'get_code_graph_context', {}],
    ['build', 'build_or_update_code_graph', {}],
    ['query', 'query_code_graph', { mode: 'hubs' }],
    ['search', 'search_code_graph', { query: 'run', limit: 4 }],
    ['explain', 'explain_code_symbol', { qualifiedName: 'src/a.ts::run' }],
    ['impact', 'get_impact_radius', { target: 'src/a.ts::run' }],
    ['detect_changes', 'detect_changed_symbols', { baseRef: 'main' }],
    ['compare_changes', 'compare_change_impact', { maxDepth: 2 }],
    ['review', 'get_review_context', { detailLevel: 'standard' }],
  ])(
    'dispatches Code Graph %s with the explicit worktree',
    async (name, key, args) => {
      const execute = jest
        .spyOn(canopyCore, 'executeCanopyInjectedTool')
        .mockResolvedValue({ text: 'graph-result' });
      const renderer = jest.spyOn(
        appAdvisorIpc,
        'requestAppAdvisorRendererTool',
      );
      const runtime = createAppAdvisorToolRuntime(
        makeSurfaces(),
        destination(),
      );
      const result = await executeAppAdvisorTool(
        'dispatch_action',
        {
          action: {
            ...args,
            type: `code-graph.${name}`,
            projectId: 'project-2',
            worktreeId: 'worktree-2',
          },
        },
        runtime,
      );
      expect(result.isError).not.toBe(true);
      expect(execute).toHaveBeenCalledWith(
        key,
        args,
        expect.objectContaining({
          codeGraphRuntime: {
            projectId: 'project-2',
            worktreeId: 'worktree-2',
          },
        }),
      );
      expect(result.text).toContain('graph-result');
      expect(renderer).not.toHaveBeenCalled();
      execute.mockRestore();
    },
  );

  it('enforces the live Code Graph gate through the real shared executor', async () => {
    const available = jest
      .spyOn(graphAvailability, 'isCodeGraphAvailableForWorkspace')
      .mockReturnValue(false);
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());
    try {
      const result = await executeAppAdvisorTool(
        'dispatch_action',
        {
          action: {
            type: 'code-graph.build',
            projectId: 'project-2',
            worktreeId: 'worktree-2',
          },
        },
        runtime,
      );
      expect(available).toHaveBeenCalledWith('project-2');
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Code graph tools are not available');
    } finally {
      available.mockRestore();
    }
  });

  it('arms inline automation watchers before dispatching automation.run_now', async () => {
    const requestSpy = mockHeadlessResourceAction.mockResolvedValue({
      requestId: 'run-now-request',
      ok: true,
      result: { run: { id: 'run-1', status: 'success' } },
    });
    mockSetupWatchers.mockResolvedValue({
      ok: true,
      results: [
        {
          status: 'created',
          watcher: {
            id: 'watcher-1',
            trigger: 'automation_run',
            status: 'active',
            label: 'Automation run completion: auto-1',
            target: { kind: 'automation', automationId: 'auto-1' },
            destination: destination(),
            createdAt: '2026-08-18T00:00:00.000Z',
          },
        },
      ],
    });
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());

    const response = await runtime.dispatchRendererAction(
      {
        type: 'automation.run_now',
        id: 'auto-1',
        watchers: [{ followUpInstruction: 'Report the outcome.' }],
      },
      undefined,
      'run-now-request',
    );

    expect(mockSetupWatchers).toHaveBeenCalledWith(
      {
        watchers: [
          {
            trigger: 'automation_run',
            target: { kind: 'automation', automationId: 'auto-1' },
            followUpInstruction: 'Report the outcome.',
          },
        ],
      },
      destination(),
      { toolUseId: 'run-now-request' },
    );
    // Arm-before-dispatch: run_now completes the run before it returns.
    const setupOrder = mockSetupWatchers.mock.invocationCallOrder[0] ?? 0;
    const dispatchOrder = requestSpy.mock.invocationCallOrder[0] ?? 0;
    expect(setupOrder).toBeLessThan(dispatchOrder);
    // Watchers are stripped from the renderer-bound action.
    expect(requestSpy).toHaveBeenCalledWith(
      { type: 'automation.run_now', id: 'auto-1' },
      expect.anything(),
    );
    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      run: { id: 'run-1' },
      inlineWatcherSetup: { ok: true },
    });
  });

  it('does not dispatch automation.run_now when inline watcher arming fails', async () => {
    const requestSpy = jest.spyOn(
      appAdvisorIpc,
      'requestAppAdvisorRendererTool',
    );
    mockSetupWatchers.mockResolvedValue({
      ok: false,
      error: 'This chat already has the maximum number of active watchers.',
    });
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());

    const response = await runtime.dispatchRendererAction(
      { type: 'automation.run_now', id: 'auto-1', watchers: [{}] },
      undefined,
      'run-now-request',
    );

    expect(requestSpy).not.toHaveBeenCalled();
    expect(response.ok).toBe(false);
    expect(response.error?.message).toContain('the automation was not run');
    requestSpy.mockRestore();
  });

  it('removes pre-armed run_now watchers when the dispatch fails', async () => {
    mockHeadlessResourceAction.mockResolvedValue({
      requestId: 'run-now-request',
      ok: false,
      error: { code: 'not_found', message: 'Activity auto-1 was not found.' },
    });
    mockSetupWatchers.mockResolvedValue({
      ok: true,
      results: [
        {
          status: 'created',
          watcher: {
            id: 'watcher-1',
            trigger: 'automation_run',
            status: 'active',
            label: 'Automation run completion: auto-1',
            target: { kind: 'automation', automationId: 'auto-1' },
            destination: destination(),
            createdAt: '2026-08-18T00:00:00.000Z',
          },
        },
      ],
    });
    mockDeleteAgentWatchers.mockResolvedValue({
      ok: true,
      results: [{ watcherId: 'watcher-1', status: 'deleted' }],
    });
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());

    const response = await runtime.dispatchRendererAction(
      { type: 'automation.run_now', id: 'auto-1', watchers: [{}] },
      undefined,
      'run-now-request',
    );

    expect(response.ok).toBe(false);
    expect(mockDeleteAgentWatchers).toHaveBeenCalledWith(
      { watcherIds: ['watcher-1'] },
      destination(),
    );
  });

  it('creates automation disabled, arms its watcher, then enables it', async () => {
    const requestSpy = mockHeadlessResourceAction
      .mockResolvedValueOnce({
        requestId: 'create-request',
        ok: true,
        result: {
          activity: { id: 'auto-created', name: 'Created', enabled: false },
        },
      })
      .mockResolvedValueOnce({
        requestId: 'create-request-enable',
        ok: true,
        result: {
          activity: { id: 'auto-created', name: 'Created', enabled: true },
        },
      });
    mockSetupWatchers.mockResolvedValue({ ok: true, results: [] });
    mockSetupCanonicalChatWatchers.mockResolvedValue({ ok: true, results: [] });
    mockProjectCanonicalChatWatchers.mockResolvedValue([]);
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());

    const response = await runtime.dispatchRendererAction(
      {
        type: 'automation.create',
        input: {
          name: 'Nightly',
          schedule: {
            kind: 'cron',
            expression: '0 3 * * *',
            timezone: 'local',
          },
          action: {
            type: 'standalone_prompt',
            chatProjectId: 'cowork-1',
            prompt: 'Run the nightly sweep',
          },
        },
        watchers: [{}],
      },
      undefined,
      'create-request',
    );

    expect(mockSetupWatchers).toHaveBeenCalledWith(
      {
        watchers: [
          {
            trigger: 'automation_run',
            target: { kind: 'automation', automationId: 'auto-created' },
          },
        ],
      },
      destination(),
      { toolUseId: 'create-request' },
    );
    expect(requestSpy.mock.calls[0]?.[0]).toMatchObject({
      type: 'automation.create',
      input: { enabled: false },
    });
    expect(requestSpy.mock.calls[1]?.[0]).toEqual({
      type: 'automation.update',
      id: 'auto-created',
      patch: { enabled: true },
    });
    const createOrder = requestSpy.mock.invocationCallOrder[0] ?? 0;
    const setupOrder = mockSetupWatchers.mock.invocationCallOrder[0] ?? 0;
    const enableOrder = requestSpy.mock.invocationCallOrder[1] ?? 0;
    expect(createOrder).toBeLessThan(setupOrder);
    expect(setupOrder).toBeLessThan(enableOrder);
    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      activity: { id: 'auto-created', enabled: true },
      inlineWatcherSetup: { ok: true },
    });
  });

  it('resolves script output from the selected UI snapshot when ids are omitted', async () => {
    setLatestAppAdvisorUiState(
      state({ projectId: 'project-1', worktreeId: 'worktree-1' }),
    );
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());

    await runtime.loadScriptOutput({ scriptId: 'setup', maxLines: 25 });

    expect(mockedLoadWorktreeScriptOutput).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      scriptId: 'setup',
      repo: undefined,
      maxLines: 25,
    });
  });

  it('honors explicit projectId and worktreeId overrides', async () => {
    setLatestAppAdvisorUiState(
      state({ projectId: 'project-1', worktreeId: 'worktree-1' }),
    );
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());

    await runtime.loadScriptOutput({
      projectId: 'project-2',
      worktreeId: 'worktree-2',
      scriptId: 'launch',
      repo: 'api',
    });

    expect(mockedLoadWorktreeScriptOutput).toHaveBeenCalledWith({
      projectId: 'project-2',
      worktreeId: 'worktree-2',
      scriptId: 'launch',
      repo: 'api',
      maxLines: undefined,
    });
  });

  it('resolves pipeline YAML from the selected UI snapshot when ids are omitted', async () => {
    setLatestAppAdvisorUiState(
      state({ projectId: 'project-1', worktreeId: 'worktree-1' }),
    );
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());

    await runtime.loadPipelineYaml({
      pipelineId: 'review',
      startLine: 3,
      pattern: 'jobs',
    });

    expect(mockedLoadWorktreePipelineYaml).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      pipelineId: 'review',
      startLine: 3,
      pattern: 'jobs',
    });
  });

  it('returns surface_unavailable when no worktree can be resolved', async () => {
    setLatestAppAdvisorUiState(state());
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());

    const result = await runtime.loadScriptOutput({ scriptId: 'setup' });

    expect(result.found).toBe(false);
    expect(result.error).toContain('surface_unavailable');
    expect(result.error).toContain('No Canopy worktree is currently selected');
    expect(mockedLoadWorktreeScriptOutput).not.toHaveBeenCalled();
  });

  it('rejects App Advisor sentinel ids as script targets', async () => {
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());

    const result = await runtime.loadScriptOutput({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      scriptId: 'setup',
    });

    expect(result.found).toBe(false);
    expect(result.error).toContain('surface_unavailable');
    expect(result.error).toContain('sentinel ids');
    expect(mockedLoadWorktreeScriptOutput).not.toHaveBeenCalled();
  });

  it('delegates watcher searches and setup with the captured destination', async () => {
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());

    await runtime.searchWatchers({ query: 'pipeline' });
    await runtime.setupWatchers(
      {
        watchers: [
          {
            trigger: 'worktree_chat_completion',
            target: {
              kind: 'worktree_chat',
              projectId: 'project-1',
              worktreeId: 'worktree-1',
              chatId: 'chat-1',
            },
          },
        ],
      },
      { toolUseId: 'tool-1' },
    );

    expect(mockSearchWatchers).toHaveBeenCalledWith(
      { query: 'pipeline' },
      destination(),
    );
    expect(mockSetupWatchers).toHaveBeenCalledWith(
      expect.any(Object),
      destination(),
      { toolUseId: 'tool-1' },
    );
  });

  it('binds one atomic canonical and legacy batch to the Advisor recipient', async () => {
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());
    const canonical = {
      trigger: 'project_new_chat_started',
      target: { projectId: 'p' },
    } as const;
    const legacy = {
      trigger: 'worktree_pipeline_completion',
      target: { kind: 'worktree_pipeline', projectId: 'p', worktreeId: 't' },
    } as const;
    const input = { watchers: [canonical, legacy] };
    const response = {
      ok: false,
      code: 'not_found',
      error: 'Unavailable target.',
      rejectedIndex: 1,
    };
    mockSetupCanonicalChatWatchers.mockResolvedValue(response);
    const result = await executeAppAdvisorTool(
      'setup_watchers',
      input,
      runtime,
      { toolUseId: 'canonical-call' },
    );
    expect(JSON.parse(result.text)).toEqual(response);
    expect(mockSetupCanonicalChatWatchers).toHaveBeenCalledTimes(1);
    // DeleteWatchers finds watchers by the tool call that created them.
    expect(mockSetupCanonicalChatWatchers).toHaveBeenCalledWith({
      ...input,
      destination: destination(),
      recipient: { kind: 'root' },
      createdByToolUseId: 'canonical-call',
    });
    expect(mockSetupWatchers).not.toHaveBeenCalled();
  });

  it('replaces raw chat search rows with C redacted projections for the trusted Advisor', async () => {
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());
    const pipeline = {
      id: 'pipeline',
      trigger: 'worktree_pipeline_completion',
      status: 'active',
      label: 'Pipeline',
      targetKind: 'worktree_pipeline',
    };
    mockSearchWatchers.mockResolvedValue({
      catalog: [],
      activeWatchers: [
        pipeline,
        {
          id: 'legacy-chat',
          trigger: 'worktree_chat_completion',
          label: 'SECRET legacy title',
          status: 'active',
          targetKind: 'worktree_chat',
        },
        {
          id: 'canonical-chat',
          trigger: 'bot_new_chat_started',
          label: 'SECRET bot title',
          status: 'active',
          targetKind: 'bot_chat_scope',
        },
      ],
    });
    const projections = [
      {
        id: 'legacy-chat',
        trigger: 'project_task_chat_completion',
        availability: 'owner_boundary',
      },
      {
        id: 'canonical-chat',
        trigger: 'bot_new_chat_started',
        availability: 'runtime_unavailable',
      },
    ];
    mockProjectCanonicalChatWatchers.mockResolvedValue(projections);
    const result = await runtime.searchWatchers({
      query: 'pipeline',
      trigger: 'worktree_pipeline_completion',
      limit: 1,
    });
    if ('ok' in result) throw new Error(result.error);
    expect(result.activeWatchers).toEqual([pipeline, ...projections]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(mockProjectCanonicalChatWatchers).toHaveBeenCalledWith({
      destination: destination(),
      recipient: { kind: 'root' },
    });
  });

  it.each(['minimal', 'standard'] as const)(
    'pages authorized canonical IDs at %s detail independently of the catalog',
    async (detailLevel) => {
      const runtime = createAppAdvisorToolRuntime(
        makeSurfaces(),
        destination(),
      );
      const pipeline = {
        id: 'pipeline',
        trigger: 'worktree_pipeline_completion',
        status: 'active',
        targetKind: 'worktree_pipeline',
        target: { projectId: 'p', taskId: 't' },
      };
      const chat = {
        id: 'chat',
        trigger: 'project_task_chat_completion',
        status: 'active',
        targetKind: 'project_task_chat',
        target: { projectId: 'p', taskId: 't', chatId: 'c' },
      };
      const scope = {
        id: 'scope',
        trigger: 'project_new_chat_started',
        status: 'active',
        targetKind: 'project_chat_scope',
        target: { projectId: 'p' },
      };
      const bot = {
        id: 'bot',
        trigger: 'bot_new_chat_started',
        status: 'active',
        targetKind: 'bot_chat_scope',
        target: { botId: 'app_advisor' },
      };
      const redacted = {
        id: 'hidden',
        trigger: 'project_new_chat_started',
        availability: 'owner_boundary',
      };
      mockSearchWatchers.mockResolvedValue({
        catalog: [],
        activeWatchers: [pipeline],
      });
      mockProjectCanonicalChatWatchers.mockResolvedValue([
        chat,
        scope,
        bot,
        redacted,
      ]);
      const input = {
        detailLevel,
        limit: 1,
        query: 'unrelated catalog query',
        targetProjectId: 'p',
        activePageSize: 1,
      };
      const first = await runtime.searchWatchers(input);
      expect(first).toMatchObject({
        catalog: [],
        activeWatchers: [pipeline],
        activeReturned: 1,
        activeTotalMatches: 3,
      });
      if (
        !('activeNextCursor' in first) ||
        typeof first.activeNextCursor !== 'string'
      )
        throw new Error('Missing cursor');
      const second = await runtime.searchWatchers({
        ...input,
        activeCursor: first.activeNextCursor,
      });
      expect(second).toMatchObject({
        activeWatchers: [chat],
        activeReturned: 1,
        activeTotalMatches: 3,
      });
      expect(
        await runtime.searchWatchers({
          detailLevel,
          targetProjectId: 'p',
          targetTaskId: 't',
          targetChatId: 'c',
          activeQuery: 'C',
        }),
      ).toMatchObject({
        activeWatchers: [chat],
        activeReturned: 1,
        activeTotalMatches: 1,
      });
      expect(
        await runtime.searchWatchers({
          detailLevel,
          targetBotId: 'app_advisor',
        }),
      ).toMatchObject({ activeWatchers: [bot], activeTotalMatches: 1 });
      expect(
        await runtime.searchWatchers({ detailLevel, activeQuery: 'hidden' }),
      ).toMatchObject({ activeWatchers: [redacted], activeTotalMatches: 1 });
      const scopeResult = await runtime.searchWatchers({
        detailLevel,
        activeQuery: 'scope',
      });
      expect(scopeResult).toMatchObject({
        activeWatchers: [scope],
        activeReturned: 1,
      });
      if ('ok' in scopeResult) throw new Error(scopeResult.error);
      expect(scopeResult.activeWatchers[0]).not.toHaveProperty('target.taskId');
      expect(
        await runtime.searchWatchers({
          ...input,
          targetProjectId: 'other',
          activeCursor: first.activeNextCursor,
        }),
      ).toEqual({ ok: false, error: 'Invalid activeCursor.' });
    },
  );

  it('reports malformed instance cursors as invalid arguments', async () => {
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());
    expect(await runtime.searchWatchers({ activeCursor: 'malformed' })).toEqual(
      { ok: false, error: 'Invalid activeCursor.' },
    );
    const result = await executeAppAdvisorTool(
      'search_watchers',
      { activeCursor: 'malformed' },
      runtime,
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Invalid arguments for SearchWatchers.');
    expect(result.text).toContain('Invalid activeCursor.');
  });

  it('does not request instance projection for catalog-only discovery', async () => {
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());
    expect(await runtime.searchWatchers({ includeActive: false })).toEqual({
      catalog: [],
      activeWatchers: [],
      activeReturned: 0,
      activeTotalMatches: 0,
    });
    expect(mockProjectCanonicalChatWatchers).not.toHaveBeenCalled();
  });

  it('never falls back to raw chat search rows when projection fails', async () => {
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());
    mockSearchWatchers.mockResolvedValue({
      catalog: [],
      activeWatchers: [
        { id: 'chat', trigger: 'worktree_chat_completion', label: 'SECRET' },
      ],
    });
    mockProjectCanonicalChatWatchers.mockRejectedValue(
      new Error('Projection unavailable'),
    );
    await expect(runtime.searchWatchers({})).rejects.toThrow(
      'Projection unavailable',
    );
  });

  it('performs the single command approval in the selected worktree', async () => {
    const approvalCheck = jest.fn().mockResolvedValue({ decision: 'allow' });
    mockedCreateApprovalSession.mockReturnValue({
      check: approvalCheck,
      setMode: jest.fn(),
      dispose: jest.fn(),
    });
    setLatestAppAdvisorUiState(
      state({ projectId: 'project-1', worktreeId: 'worktree-1' }),
    );
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination(), {
      providerType: 'codex',
      approvalMode: 'ask',
      sessionApprovalRules: [],
    });

    await runtime.watchCommand?.(
      { command: 'printf ready', intervalSeconds: 5, maxAttempts: 2 },
      { toolUseId: 'tool-command' },
    );

    expect(mockedResolveWorktreeCwd).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
    );
    expect(mockedCreateApprovalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: APP_ADVISOR_PROJECT_ID,
        policyProjectId: 'project-1',
        provider: 'codex',
        workspaceRoot: '/selected/worktree',
      }),
    );
    expect(mockedCreateApprovalSession).toHaveBeenCalledTimes(1);
    expect(approvalCheck).toHaveBeenCalledTimes(1);
    expect(mockCreateLocalWatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'command_watch',
        command: 'printf ready',
        cwd: '/selected/worktree',
      }),
      destination(),
      'tool-command',
      undefined,
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    );
  });

  it('cancels a pending command approval with the provider turn', async () => {
    let resolveApproval: ((value: { decision: 'allow' }) => void) | undefined;
    const approvalCheck = jest.fn(
      () =>
        new Promise<{ decision: 'allow' }>((resolve) => {
          resolveApproval = resolve;
        }),
    );
    const invalidatePending = jest.fn();
    mockedCreateApprovalSession.mockReturnValue({
      check: approvalCheck,
      setMode: jest.fn(),
      invalidatePending,
      dispose: jest.fn(),
    });
    setLatestAppAdvisorUiState(
      state({ projectId: 'project-1', worktreeId: 'worktree-1' }),
    );
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());
    const controller = new AbortController();

    const pending = runtime.watchCommand?.(
      { command: 'printf ready', intervalSeconds: 5, maxAttempts: 2 },
      { toolUseId: 'tool-command-abort', signal: controller.signal },
    );
    const rejection = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    if (!resolveApproval)
      throw new Error('Expected pending approval resolver.');
    resolveApproval({ decision: 'allow' });

    await rejection;
    expect(invalidatePending).toHaveBeenCalledTimes(1);
    expect(mockCreateLocalWatcher).not.toHaveBeenCalled();
  });

  it('throws ask_user_timeout when the renderer bridge times out', async () => {
    jest
      .spyOn(appAdvisorIpc, 'requestAppAdvisorRendererTool')
      .mockResolvedValue({
        requestId: 'r',
        ok: false,
        error: { code: 'timeout', message: 'timed out', retryable: true },
      });
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());
    await expect(
      runtime.requestUserAnswers([{ question: 'Q', options: ['a'] }]),
    ).rejects.toThrow('ask_user_timeout');
  });

  it('forwards ask-user cancellation to the renderer bridge', async () => {
    const request = jest
      .spyOn(appAdvisorIpc, 'requestAppAdvisorRendererTool')
      .mockResolvedValue({
        requestId: 'r',
        ok: false,
        error: {
          code: 'execution_failed',
          message: 'ask_user_cancelled',
          retryable: false,
        },
      });
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());
    const controller = new AbortController();

    await expect(
      runtime.requestUserAnswers([{ question: 'Q', options: ['a'] }], {
        signal: controller.signal,
      }),
    ).rejects.toThrow('ask_user_cancelled');
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'ask_user_question' }),
      expect.any(Object),
      { signal: controller.signal },
    );
  });

  it('routes scoped file comment replies through the shared session resolver for an explicit workspace target', async () => {
    const surfaces = makeSurfaces();
    const runtime = createAppAdvisorToolRuntime(surfaces, destination());
    mockedRespondToFileCommentInSession.mockResolvedValue({
      ok: true,
      resolved: true,
      store: 'plan',
    });

    const result = await runtime.respondToScopedFileComment({
      threadId: 'thread-1',
      body: 'Fixed.',
      resolve: true,
      workspace: { projectId: 'project-2', worktreeId: 'worktree-2' },
    });

    expect(mockedRespondToFileCommentInSession).toHaveBeenCalledTimes(1);
    const call = mockedRespondToFileCommentInSession.mock.calls[0][0];
    expect(call).toMatchObject({
      projectId: 'project-2',
      worktreeId: 'worktree-2',
      threadId: 'thread-1',
      body: 'Fixed.',
      resolve: true,
    });
    expect(call.getWindow()).toBe(surfaces.getMainWindow());
    expect(result).toEqual({ ok: true, resolved: true, store: 'plan' });
  });

  it("routes scoped file comment replies through the shared session resolver for App Advisor's default scope", async () => {
    const surfaces = makeSurfaces();
    const runtime = createAppAdvisorToolRuntime(surfaces, destination());
    mockedRespondToFileCommentInSession.mockResolvedValue({
      ok: true,
      resolved: false,
    });

    const result = await runtime.respondToScopedFileComment({
      threadId: 'thread-2',
      body: 'Ack.',
      resolve: false,
    });

    expect(mockedRespondToFileCommentInSession).toHaveBeenCalledTimes(1);
    const call = mockedRespondToFileCommentInSession.mock.calls[0][0];
    expect(call).toMatchObject({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      threadId: 'thread-2',
      body: 'Ack.',
      resolve: false,
    });
    expect(call.getWindow()).toBe(surfaces.getMainWindow());
    expect(result).toEqual({ ok: true, resolved: false });
  });
});

it.each(['projects.list', 'projects.list_tasks', 'projects.list_task_chats'])(
  'handles %s in main without requesting a UI snapshot or renderer action',
  async (type) => {
    const renderer = jest.spyOn(appAdvisorIpc, 'requestAppAdvisorRendererTool');
    renderer.mockClear();
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());
    const action = projectDiscoveryActionSchema.parse({
      type,
      ...(type === 'projects.list' ? {} : { projectId: 'target' }),
      ...(type === 'projects.list_task_chats' ? { taskId: 'target-task' } : {}),
    });
    expect(
      await runtime.dispatchRendererAction(
        action,
        undefined,
        'discovery-request',
      ),
    ).toMatchObject({ ok: true });
    expect(dispatchProjectDiscoveryAction).toHaveBeenLastCalledWith(action, {
      kind: 'app_advisor',
      chatId: 'advisor-chat',
    });
    expect(renderer).not.toHaveBeenCalled();
    renderer.mockRestore();
  },
);

it.each(PROJECT_READ_ACTION_TYPES)(
  'handles %s in main without requesting a UI snapshot or renderer action',
  async (type) => {
    const renderer = jest.spyOn(appAdvisorIpc, 'requestAppAdvisorRendererTool');
    renderer.mockClear();
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());
    const action = projectReadActionSchema.parse({
      type,
      projectId: 'target',
      taskId: 'target-task',
      chatId: 'target-chat',
    });
    expect(
      await runtime.dispatchRendererAction(
        action,
        undefined,
        'discovery-request',
      ),
    ).toMatchObject({ ok: true });
    expect(dispatchProjectReadAction).toHaveBeenLastCalledWith(action, {
      kind: 'app_advisor',
      chatId: 'advisor-chat',
    });
    expect(renderer).not.toHaveBeenCalled();
    renderer.mockRestore();
  },
);

const BOT_ACTION_INPUTS: Record<(typeof BOT_ACTION_TYPES)[number], unknown> = {
  'bots.list': { type: 'bots.list' },
  'bots.list_tasks': { type: 'bots.list_tasks', botId: 'app_advisor' },
  'bots.list_task_chats': {
    type: 'bots.list_task_chats',
    botId: 'app_advisor',
    taskId: 'advisor-task',
  },
  'bots.get_last_user_message': {
    type: 'bots.get_last_user_message',
    botId: 'app_advisor',
    taskId: 'advisor-task',
    chatId: 'advisor-chat',
  },
  'bots.get_last_agent_response': {
    type: 'bots.get_last_agent_response',
    botId: 'app_advisor',
    taskId: 'advisor-task',
    chatId: 'advisor-chat',
  },
  'bots.read_history': {
    type: 'bots.read_history',
    botId: 'app_advisor',
    taskId: 'advisor-task',
    chatId: 'advisor-chat',
  },
};

it.each(BOT_ACTION_TYPES)(
  'handles %s in main without requesting a UI snapshot or renderer action',
  async (type) => {
    const renderer = jest.spyOn(appAdvisorIpc, 'requestAppAdvisorRendererTool');
    renderer.mockClear();
    mockedDispatchBotAction.mockClear();
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());
    const action = appAdvisorActionSchema.parse(BOT_ACTION_INPUTS[type]);

    expect(action.type).toBe(type);
    expect(
      await runtime.dispatchRendererAction(action, undefined, 'bot-request'),
    ).toMatchObject({ ok: true, requestId: 'bot-request' });
    expect(mockedDispatchBotAction).toHaveBeenCalledTimes(1);
    expect(mockedDispatchBotAction).toHaveBeenLastCalledWith(action, {
      kind: 'app_advisor',
      chatId: 'advisor-chat',
    });
    expect(renderer).not.toHaveBeenCalled();
    renderer.mockRestore();
  },
);

describe('Advisor list UI envelopes', () => {
  const cases = [
    { type: 'projects.list', address: { projectId: 'target' } },
    {
      type: 'projects.list_tasks',
      address: { projectId: 'target', taskId: 'target-task' },
    },
    {
      type: 'projects.list_task_chats',
      address: {
        projectId: 'target',
        taskId: 'target-task',
        chatId: 'shared-chat',
      },
    },
    { type: 'bots.list', address: { botId: 'app_advisor' } },
    {
      type: 'bots.list_tasks',
      address: { botId: 'app_advisor', taskId: 'target-task' },
    },
    {
      type: 'bots.list_task_chats',
      address: {
        botId: 'app_advisor',
        taskId: 'target-task',
        chatId: 'shared-chat',
      },
    },
  ];
  function listAction(
    type: string,
  ): ReturnType<typeof appAdvisorActionSchema.parse> {
    const bot = type.startsWith('bots.');
    return appAdvisorActionSchema.parse({
      type,
      ...(!type.endsWith('.list')
        ? bot
          ? { botId: 'app_advisor' }
          : { projectId: 'target' }
        : {}),
      ...(type.endsWith('list_task_chats') ? { taskId: 'target-task' } : {}),
    });
  }
  const fallback = { revision: 0, selection: {}, items: {} };

  beforeEach(() => {
    setLatestAppAdvisorUiState({
      ...state({ projectId: 'target', worktreeId: 'target-task' }),
      snapshot: {
        ...state({ projectId: 'target', worktreeId: 'target-task' }).snapshot,
        activeChat: { chatId: 'shared-chat' },
        appAdvisor: {
          activeWorkEntryId: 'target-task',
          activeChatId: 'shared-chat',
        },
      },
    });
  });

  afterEach(() => {
    jest
      .mocked(dispatchProjectDiscoveryAction)
      .mockReset()
      .mockResolvedValue({ ok: true, result: { items: [] } });
    mockedDispatchBotAction
      .mockReset()
      .mockResolvedValue({ ok: true, result: { botId: 'app_advisor' } });
    jest.restoreAllMocks();
  });

  it.each(cases)(
    'enriches $type without changing its canonical page or requesting UI',
    async ({ type, address }) => {
      const page = {
        items: [address, { ...address, taskId: 'other-task' }],
        returned: 2,
        totalMatches: 4,
        nextCursor: 'next',
        generatedAt: '2026-10-18T00:00:00.000Z',
        revision: 'canonical-revision',
      };
      jest
        .mocked(dispatchProjectDiscoveryAction)
        .mockResolvedValueOnce({ ok: true, result: page });
      mockedDispatchBotAction.mockResolvedValueOnce({ ok: true, result: page });
      const renderer = jest.spyOn(
        appAdvisorIpc,
        'requestAppAdvisorRendererTool',
      );
      const fresh = jest.spyOn(
        appAdvisorIpc,
        'requestCurrentAppAdvisorUiState',
      );
      const runtime = createAppAdvisorToolRuntime(
        makeSurfaces(),
        destination(),
      );
      const action = listAction(type);
      const result = await runtime.dispatchRendererAction(
        action,
        undefined,
        'list-ui-request',
      );
      const selection = type.startsWith('bots.')
        ? { botId: 'app_advisor', taskId: 'target-task', chatId: 'shared-chat' }
        : { projectId: 'target', taskId: 'target-task', chatId: 'shared-chat' };
      expect(result).toEqual({
        ok: true,
        requestId: 'list-ui-request',
        result: {
          ...page,
          ui: {
            revision: 7,
            selection,
            items: { [JSON.stringify(address)]: { selected: true } },
          },
        },
      });
      expect(page).not.toHaveProperty('ui');
      expect(renderer).not.toHaveBeenCalled();
      expect(fresh).not.toHaveBeenCalled();
    },
  );

  it('maps a selected Cowork Work Entry supplied as selectedWorktree.worktreeId', async () => {
    setLatestAppAdvisorUiState(
      state({
        projectId: 'cowork',
        worktreeId: 'entry',
        workspaceType: 'cowork',
      }),
    );
    const address = { projectId: 'cowork', taskId: 'entry' };
    jest
      .mocked(dispatchProjectDiscoveryAction)
      .mockResolvedValueOnce({ ok: true, result: { items: [address] } });
    const result = await createAppAdvisorToolRuntime(
      makeSurfaces(),
      destination(),
    ).dispatchRendererAction(
      appAdvisorActionSchema.parse({
        type: 'projects.list_tasks',
        projectId: 'cowork',
      }),
    );
    expect(result.result).toEqual({
      items: [address],
      ui: {
        revision: 7,
        selection: address,
        items: { [JSON.stringify(address)]: { selected: true } },
      },
    });
  });

  it('keeps off-page selection without annotating another returned target', async () => {
    jest.mocked(dispatchProjectDiscoveryAction).mockResolvedValueOnce({
      ok: true,
      result: { items: [{ projectId: 'other' }] },
    });
    const result = await createAppAdvisorToolRuntime(
      makeSurfaces(),
      destination(),
    ).dispatchRendererAction(
      appAdvisorActionSchema.parse({ type: 'projects.list' }),
    );
    expect(result.result).toEqual(
      expect.objectContaining({
        ui: {
          revision: 7,
          selection: {
            projectId: 'target',
            taskId: 'target-task',
            chatId: 'shared-chat',
          },
          items: {},
        },
      }),
    );
  });

  it.each(cases)(
    'uses the revision-zero fallback for $type',
    async ({ type, address }) => {
      jest
        .spyOn(appAdvisorIpc, 'getCachedAppAdvisorUiStateForChat')
        .mockReturnValue({ ...state(), revision: 0 });
      jest
        .mocked(dispatchProjectDiscoveryAction)
        .mockResolvedValueOnce({ ok: true, result: { items: [address] } });
      mockedDispatchBotAction.mockResolvedValueOnce({
        ok: true,
        result: { items: [address] },
      });
      const result = await createAppAdvisorToolRuntime(
        makeSurfaces(),
        destination(),
      ).dispatchRendererAction(listAction(type));
      expect(result.result).toEqual(expect.objectContaining({ ui: fallback }));
    },
  );

  it.each(cases)('preserves errors for $type', async ({ type }) => {
    const failure = {
      ok: false,
      error: { code: 'not_found', message: 'Not found', retryable: false },
    } as const;
    jest.mocked(dispatchProjectDiscoveryAction).mockResolvedValueOnce(failure);
    mockedDispatchBotAction.mockResolvedValueOnce(failure);
    const result = await createAppAdvisorToolRuntime(
      makeSurfaces(),
      destination(),
    ).dispatchRendererAction(listAction(type), undefined, 'error-request');
    expect(result).toEqual({ ...failure, requestId: 'error-request' });
  });

  it.each([
    'bots.get_last_user_message',
    'bots.get_last_agent_response',
    'bots.read_history',
  ])('does not enrich %s', async (type) => {
    const response = { ok: true, result: { message: 'unchanged' } };
    mockedDispatchBotAction.mockResolvedValueOnce(response);
    const cache = jest.spyOn(
      appAdvisorIpc,
      'getCachedAppAdvisorUiStateForChat',
    );
    const result = await createAppAdvisorToolRuntime(
      makeSurfaces(),
      destination(),
    ).dispatchRendererAction(
      appAdvisorActionSchema.parse({
        type,
        botId: 'app_advisor',
        taskId: 'target-task',
        chatId: 'shared-chat',
      }),
      undefined,
      'read-request',
    );
    expect(result).toEqual({ ...response, requestId: 'read-request' });
    expect(cache).not.toHaveBeenCalled();
  });
});

describe('phase 09 main-only sends', () => {
  const receipt = {
    address: { projectId: 'target', taskId: 'task', chatId: 'chat' },
    disposition: 'started',
    messageId: 'accepted',
    acceptedAt: '2026-10-17T00:00:00.000Z',
    watcherReceipts: [],
  } as const;
  afterEach(() => jest.restoreAllMocks());
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(dispatchAgentChatSend)
      .mockResolvedValue({ ...receipt, watcherReceipts: [] });
  });
  it.each(['projects.send_message', 'bots.send_message'] as const)(
    'routes %s with trusted Advisor destination and no renderer or UI dependency',
    async (type) => {
      const bridge = jest.spyOn(appAdvisorIpc, 'requestAppAdvisorRendererTool');
      bridge.mockClear();
      const source = destination();
      const surfaces = makeSurfaces();
      const runtime = createAppAdvisorToolRuntime(surfaces, source);
      const action =
        type === 'projects.send_message'
          ? {
              type,
              projectId: 'target',
              taskId: 'task',
              chatId: 'chat',
              text: 'Send',
              watchers: [{ label: 'Done' }],
            }
          : {
              type,
              botId: 'app_advisor',
              taskId: 'task',
              chatId: 'chat',
              text: 'Send',
              watchers: [{ label: 'Done' }],
            };
      expect(
        await runtime.dispatchRendererAction(action, 999, 'send-tool'),
      ).toMatchObject({ ok: true, result: receipt });
      expect(dispatchAgentChatSend).toHaveBeenLastCalledWith(action, {
        caller: { kind: 'app_advisor', source },
        watcherDestination: source,
        toolUseId: 'send-tool',
        surfaces,
      });
      expect(bridge).not.toHaveBeenCalled();
      expect(dispatchAgentChatSend).toHaveBeenCalledTimes(1);
      expect(mockSetupWatchers).not.toHaveBeenCalled();
    },
  );
  it('maps owner boundary to a generic not_found', async () => {
    jest
      .mocked(dispatchAgentChatSend)
      .mockRejectedValueOnce(
        new AgentChatSendError('owner_boundary', 'private target'),
      );
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());
    expect(
      await runtime.dispatchRendererAction({
        type: 'projects.send_message',
        projectId: 'target',
        taskId: 'task',
        chatId: 'chat',
        text: 'Send',
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'not_found', message: 'Chat was not found.' },
    });
  });
  it.each([
    'worktree-chat.send_message',
    'standalone-chat.send_message',
  ] as const)(
    'intercepts legacy %s, navigating before one trusted send',
    async (type) => {
      mockResolveSendTarget.mockResolvedValueOnce({
        address: receipt.address,
        row: { capabilities: { canSend: true } },
      });
      mockResolveLegacyEntry.mockResolvedValueOnce({ entryId: 'task' });
      const bridge = jest
        .spyOn(appAdvisorIpc, 'requestAppAdvisorRendererTool')
        .mockResolvedValueOnce({
          requestId: 'legacy',
          ok: true,
          result: { settings: { model: 'target-model' } },
        });
      const runtime = createAppAdvisorToolRuntime(
        makeSurfaces(),
        destination(),
      );
      // The public legacy parser strips unknown identity fields for compatibility.
      const action = appAdvisorActionSchema.parse({
        type,
        projectId: 'target',
        worktreeId: 'task',
        chatId: 'chat',
        text: 'Legacy',
        sender: 'spoof',
        agentSent: 'spoof',
        hiddenContext: 'spoof',
        agentSenderProvenance: 'spoof',
      });
      const response = await runtime.dispatchRendererAction(
        action,
        77,
        'legacy',
      );
      expect(dispatchAgentChatSend).toHaveBeenCalledTimes(1);
      expect(response).toEqual(
        type === 'worktree-chat.send_message'
          ? { requestId: 'legacy', ok: true }
          : {
              requestId: 'legacy',
              ok: true,
              result: { model: 'target-model' },
            },
      );
      expect(bridge).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action:
            type === 'worktree-chat.send_message'
              ? {
                  type: 'worktree-chat.open_tab',
                  projectId: 'target',
                  worktreeId: 'task',
                  chatId: 'chat',
                }
              : {
                  type: 'standalone-chat.switch_chat',
                  projectId: 'target',
                  chatId: 'chat',
                },
          expectedUiRevision: 77,
        }),
        expect.anything(),
      );
      expect(dispatchAgentChatSend).toHaveBeenLastCalledWith(
        { type: 'projects.send_message', ...receipt.address, text: 'Legacy' },
        expect.objectContaining({
          caller: { kind: 'app_advisor', source: destination() },
        }),
      );
      expect(bridge.mock.invocationCallOrder.at(-1)).toBeLessThan(
        jest.mocked(dispatchAgentChatSend).mock.invocationCallOrder.at(-1) ?? 0,
      );
    },
  );
});

it('keeps inline watcher feedback on legacy sends with watchers', async () => {
  jest.clearAllMocks();
  mockResolveSendTarget.mockResolvedValueOnce({
    address: { projectId: 'target', taskId: 'task', chatId: 'chat' },
    row: { capabilities: { canSend: true } },
  });
  jest.mocked(dispatchAgentChatSend).mockResolvedValueOnce({
    address: { projectId: 'target', taskId: 'task', chatId: 'chat' },
    disposition: 'started',
    messageId: 'accepted',
    acceptedAt: '2026-10-17T00:00:00.000Z',
    watcherReceipts: [{ watcherId: 'w1', disposition: 'created' }],
  });
  const bridge = jest
    .spyOn(appAdvisorIpc, 'requestAppAdvisorRendererTool')
    .mockResolvedValueOnce({ requestId: 'legacy-watch', ok: true });
  try {
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());
    expect(
      await runtime.dispatchRendererAction(
        {
          type: 'worktree-chat.send_message',
          projectId: 'target',
          worktreeId: 'task',
          chatId: 'chat',
          text: 'Watch this',
          watchers: [{ label: 'Reply' }],
        },
        1,
        'legacy-watch',
      ),
    ).toEqual({
      requestId: 'legacy-watch',
      ok: true,
      result: {
        inlineWatcherSetup: {
          ok: true,
          watcherReceipts: [{ watcherId: 'w1', disposition: 'created' }],
        },
      },
    });
    expect(dispatchAgentChatSend).toHaveBeenCalledWith(
      expect.objectContaining({ watchers: [{ label: 'Reply' }] }),
      expect.anything(),
    );
  } finally {
    bridge.mockRestore();
  }
});

it('does not send when legacy selection is refused', async () => {
  jest.clearAllMocks();
  mockResolveSendTarget.mockResolvedValueOnce({
    address: { projectId: 'target', taskId: 'task', chatId: 'chat' },
    row: { capabilities: { canSend: true } },
  });
  const bridge = jest
    .spyOn(appAdvisorIpc, 'requestAppAdvisorRendererTool')
    .mockResolvedValueOnce({
      requestId: 'legacy-refused',
      ok: false,
      error: {
        code: 'stale_ui_state',
        message: 'Refresh the current selection.',
      },
    });
  try {
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());
    expect(
      await runtime.dispatchRendererAction(
        {
          type: 'worktree-chat.send_message',
          projectId: 'target',
          worktreeId: 'task',
          chatId: 'chat',
          text: 'No send',
        },
        1,
      ),
    ).toMatchObject({ ok: false, error: { code: 'stale_ui_state' } });
    expect(dispatchAgentChatSend).not.toHaveBeenCalled();
  } finally {
    bridge.mockRestore();
  }
});

describe('phase 10 main-only message controls and legacy adapters', () => {
  const address = { projectId: 'target', taskId: 'task', chatId: 'chat' };
  const steer = {
    type: 'projects.steer_queued_message',
    ...address,
    queuedMessageId: 'queued',
  };
  const schedule = {
    type: 'projects.schedule_message',
    ...address,
    text: 'Continue',
    runAt: '2099-01-01T00:00:00Z',
  };
  const steered = {
    address,
    queuedMessageId: 'queued',
    disposition: 'steered',
    steeredAt: '2026-10-17T00:00:00.000Z',
  } as const;
  const scheduled = {
    address,
    automationId: 'automation',
    name: 'Scheduled message',
    runAt: '2099-01-01T00:00:00.000Z',
    timezone: 'local',
    createdAt: '2026-10-17T00:00:00.000Z',
  } as const;
  const activity: Awaited<
    ReturnType<typeof dispatchAgentChatSchedule>
  >['activity'] = {
    version: 1,
    failureCount: 0,
    id: 'automation',
    name: 'Scheduled message',
    enabled: true,
    schedule: { kind: 'one_time', runAt: scheduled.runAt, timezone: 'local' },
    action: {
      type: 'worktree_session_prompt',
      workspaceId: 'target',
      worktreeId: 'task',
      chatId: 'chat',
      prompt: 'Continue',
      purpose: 'scheduled_send',
    },
    createdAt: scheduled.createdAt,
    updatedAt: scheduled.createdAt,
  };
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(dispatchAgentChatSteer).mockReset().mockResolvedValue(steered);
    jest
      .mocked(dispatchAgentChatSchedule)
      .mockReset()
      .mockResolvedValue({ receipt: scheduled, activity });
    mockResolveSendTarget.mockReset().mockResolvedValue({ address });
  });
  afterEach(() => jest.restoreAllMocks());
  it.each([steer, schedule])(
    'dispatches $type in main without renderer navigation',
    async (raw) => {
      const bridge = jest.spyOn(appAdvisorIpc, 'requestAppAdvisorRendererTool');
      const runtime = createAppAdvisorToolRuntime(
        makeSurfaces(),
        destination(),
      );
      expect(
        await runtime.dispatchRendererAction(
          appAdvisorActionSchema.parse(raw),
          999,
          'control',
        ),
      ).toEqual({
        requestId: 'control',
        ok: true,
        result: raw.type === steer.type ? steered : scheduled,
      });
      expect(
        raw.type === steer.type
          ? dispatchAgentChatSteer
          : dispatchAgentChatSchedule,
      ).toHaveBeenLastCalledWith(raw, {
        caller: { kind: 'app_advisor', source: destination() },
      });
      expect(bridge).not.toHaveBeenCalled();
    },
  );
  it.each([
    {
      type: 'worktree-chat.steer_queued_message',
      projectId: 'old-project',
      worktreeId: 'old-task',
      chatId: 'old-chat',
      queuedMessageId: 'queued',
    },
    {
      type: 'worktree-chat.schedule_message',
      projectId: 'old-project',
      worktreeId: 'old-task',
      chatId: 'old-chat',
      text: 'Later',
      runAt: '2030-01-01T00:00:00.000Z',
    },
  ])('refuses legacy $type on a stale UI revision', async (raw) => {
    const envelope: AppAdvisorUiStateEnvelope = {
      version: 1,
      revision: 7,
      capturedAt: new Date(0).toISOString(),
      digest: 'digest',
      snapshot: {
        activePage: 'overview',
        overlays: {
          commandPaletteOpen: false,
          fileSearchPaletteOpen: false,
          prPickerOpen: false,
          canopyPortalOpen: false,
          appAdvisorOpen: true,
        },
      },
    };
    const bridge = jest
      .spyOn(appAdvisorIpc, 'requestAppAdvisorRendererTool')
      .mockResolvedValue({ requestId: 'stale', ok: true, uiState: envelope });
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());
    expect(
      await runtime.dispatchRendererAction(
        appAdvisorActionSchema.parse(raw),
        5,
        'stale',
      ),
    ).toMatchObject({
      requestId: 'stale',
      ok: false,
      error: { code: 'stale_ui_state' },
    });
    expect(bridge).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'get_current_ui_state' }),
      expect.anything(),
    );
    expect(dispatchAgentChatSteer).not.toHaveBeenCalled();
    expect(dispatchAgentChatSchedule).not.toHaveBeenCalled();
  });
  it('keeps the legacy steer result shape', async () => {
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());
    expect(
      await runtime.dispatchRendererAction(
        appAdvisorActionSchema.parse({
          type: 'worktree-chat.steer_queued_message',
          projectId: 'old-project',
          worktreeId: 'old-task',
          chatId: 'old-chat',
          queuedMessageId: 'queued',
        }),
        undefined,
        'legacy',
      ),
    ).toEqual({
      requestId: 'legacy',
      ok: true,
      result: {
        projectId: 'target',
        worktreeId: 'task',
        chatId: 'chat',
        queuedMessageId: 'queued',
      },
    });
    expect(mockResolveSendTarget).toHaveBeenCalledWith(
      { projectId: 'old-project', taskId: 'old-task', chatId: 'old-chat' },
      { kind: 'app_advisor', chatId: destination().chatId },
    );
    expect(dispatchAgentChatSteer).toHaveBeenCalledWith(steer, {
      caller: { kind: 'app_advisor', source: destination() },
    });
  });
  it.each(['missing_capability', 'target_not_ready'] as const)(
    'keeps legacy steer %s failure shape',
    async (code) => {
      jest
        .mocked(dispatchAgentChatSteer)
        .mockRejectedValueOnce(
          new AgentChatSendError(code, 'Different new message'),
        );
      const runtime = createAppAdvisorToolRuntime(
        makeSurfaces(),
        destination(),
      );
      expect(
        await runtime.dispatchRendererAction(
          appAdvisorActionSchema.parse({
            type: 'worktree-chat.steer_queued_message',
            projectId: 'target',
            worktreeId: 'task',
            chatId: 'chat',
            queuedMessageId: 'queued',
          }),
        ),
      ).toMatchObject({
        ok: false,
        error: {
          code: 'execution_failed',
          message:
            'The queued message could not be steered. It remains in the queue.',
        },
      });
    },
  );
  it('keeps legacy schedule activity wrapper and normalizes dates and typed attachments', async () => {
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());
    const file = {
      displayPath: 'src/file',
      absolutePath: '/repo/src/file',
      repoName: 'repo',
    };
    const contexts = [
      {
        attachmentPath: '/attachments/file',
        promptKind: 'in-app-browser-resource',
      },
    ];
    expect(
      await runtime.dispatchRendererAction(
        appAdvisorActionSchema.parse({
          type: 'worktree-chat.schedule_message',
          projectId: 'target',
          worktreeId: 'task',
          chatId: 'chat',
          text: 'Continue',
          runAt: '2099-01-01T02:00:00+02:00',
          timezone: 'local',
          name: ' Resume ',
          fileReferences: [{ ...file, ignoredLegacyField: true }],
          attachmentPaths: ['/attachments/file'],
          attachmentPromptContexts: contexts,
          inputMode: 'voice',
        }),
        undefined,
        'legacy',
      ),
    ).toEqual({ requestId: 'legacy', ok: true, result: { activity } });
    expect(dispatchAgentChatSchedule).toHaveBeenLastCalledWith(
      {
        ...schedule,
        runAt: scheduled.runAt,
        timezone: 'local',
        name: 'Resume',
        inputMode: 'voice',
        attachments: {
          fileReferences: [file],
          attachmentPaths: ['/attachments/file'],
          attachmentPromptContexts: contexts,
        },
      },
      { caller: { kind: 'app_advisor', source: destination() } },
    );
  });
  it('refuses an invalid legacy date before scheduling', async () => {
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());
    expect(
      await runtime.dispatchRendererAction(
        appAdvisorActionSchema.parse({
          type: 'worktree-chat.schedule_message',
          projectId: 'target',
          worktreeId: 'task',
          chatId: 'chat',
          text: 'Continue',
          runAt: 'not a date',
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
    expect(dispatchAgentChatSchedule).not.toHaveBeenCalled();
  });
});

describe('phase 11 Advisor creation routing', () => {
  const receipt = {
    address: { projectId: 'target', taskId: 'task', chatId: 'new-chat' },
    taskCreated: true,
    chatCreated: true,
  };
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(dispatchAgentChatCreation)
      .mockReset()
      .mockResolvedValue(receipt);
    jest
      .mocked(dispatchLegacyChatCreation)
      .mockReset()
      .mockResolvedValue({
        requestId: 'legacy-tool',
        ok: true,
        result: { chatId: 'legacy-chat' },
      });
  });
  afterEach(() => jest.restoreAllMocks());
  it.each(CHAT_CREATION_ACTION_TYPES)(
    'dispatches %s without navigation or UI revision dependence',
    async (type) => {
      const bridge = jest.spyOn(appAdvisorIpc, 'requestAppAdvisorRendererTool');
      const source = destination();
      const surfaces = makeSurfaces();
      const runtime = createAppAdvisorToolRuntime(surfaces, source);
      const action = chatCreationActionSchema.parse({
        type,
        ...(type.startsWith('projects.')
          ? { projectId: 'target' }
          : { botId: 'app_advisor' }),
        ...(type.endsWith('_chat') ? { taskId: 'task' } : {}),
        initialMessage: 'Create',
      });
      expect(
        await runtime.dispatchRendererAction(action, 999, 'create-tool'),
      ).toEqual({ requestId: 'create-tool', ok: true, result: receipt });
      expect(dispatchAgentChatCreation).toHaveBeenCalledWith(action, {
        caller: { kind: 'app_advisor', source },
        watcherDestination: source,
        toolUseId: 'create-tool',
        surfaces,
      });
      expect(bridge).not.toHaveBeenCalled();
      expect(dispatchLegacyChatCreation).not.toHaveBeenCalled();
    },
  );
  it.each([
    'owner_boundary',
    'target_not_ready',
    'advisor_access_disabled',
  ] as const)('maps %s creation refusals', async (code) => {
    jest
      .mocked(dispatchAgentChatCreation)
      .mockRejectedValueOnce(new AgentChatSendError(code, 'Refused'));
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());
    expect(
      await runtime.dispatchRendererAction({
        type: 'projects.create_task',
        projectId: 'target',
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code:
          code === 'owner_boundary'
            ? 'not_found'
            : code === 'target_not_ready'
              ? 'invalid_target'
              : code,
        message: code === 'owner_boundary' ? 'Chat was not found.' : 'Refused',
      },
    });
  });
  it.each([
    { type: 'standalone-chat.create_chat', projectId: 'target' },
    {
      type: 'worktree-chat.open_tab',
      projectId: 'target',
      worktreeId: 'task',
      initialMessage: 'Legacy',
    },
  ] as const)(
    'routes legacy $type creation through the compatibility helper',
    async (action) => {
      const bridge = jest.spyOn(appAdvisorIpc, 'requestAppAdvisorRendererTool');
      const source = destination();
      const surfaces = makeSurfaces();
      const runtime = createAppAdvisorToolRuntime(surfaces, source);
      const signal = new AbortController().signal;
      expect(
        await runtime.dispatchRendererAction(action, 8, 'legacy-tool', signal),
      ).toEqual({
        requestId: 'legacy-tool',
        ok: true,
        result: { chatId: 'legacy-chat' },
      });
      expect(dispatchLegacyChatCreation).toHaveBeenCalledWith(action, {
        destination: source,
        surfaces,
        requestId: 'legacy-tool',
        expectedUiRevision: 8,
        signal,
      });
      expect(dispatchAgentChatCreation).not.toHaveBeenCalled();
      expect(bridge).not.toHaveBeenCalled();
    },
  );
  it('keeps existing worktree-tab reveal on its renderer path', async () => {
    const bridge = jest
      .spyOn(appAdvisorIpc, 'requestAppAdvisorRendererTool')
      .mockResolvedValue({
        requestId: 'reveal',
        ok: true,
        result: { chatId: 'existing' },
      });
    const runtime = createAppAdvisorToolRuntime(makeSurfaces(), destination());
    await runtime.dispatchRendererAction(
      {
        type: 'worktree-chat.open_tab',
        projectId: 'target',
        worktreeId: 'task',
        chatId: 'existing',
      },
      4,
      'reveal',
    );
    const expectedAction: unknown = expect.objectContaining({
      chatId: 'existing',
    });
    expect(bridge).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expectedAction,
        expectedUiRevision: 4,
      }),
      expect.anything(),
    );
    expect(dispatchLegacyChatCreation).not.toHaveBeenCalled();
    expect(dispatchAgentChatCreation).not.toHaveBeenCalled();
  });
});

it.each([
  { type: 'advisor-chat.create_entry', title: 'Task', text: 'Create' },
  { type: 'advisor-chat.create_chat', workEntryId: 'entry', text: 'Create' },
] as const)('retains the existing $type handler', async (action) => {
  const advisorChatActions =
    await import('../app-advisor/advisor-chat-actions');
  const legacy = jest
    .spyOn(advisorChatActions, 'dispatchAdvisorChatAction')
    .mockResolvedValue({
      requestId: 'advisor-create',
      ok: true,
      result: { workEntryId: 'entry', chatId: 'chat' },
    });
  jest.mocked(dispatchLegacyChatCreation).mockClear();
  const source = destination();
  const surfaces = makeSurfaces();
  const runtime = createAppAdvisorToolRuntime(surfaces, source);
  expect(
    await runtime.dispatchRendererAction(action, undefined, 'advisor-create'),
  ).toMatchObject({
    ok: true,
    result: { workEntryId: 'entry', chatId: 'chat' },
  });
  expect(legacy).toHaveBeenCalledWith(
    action,
    source,
    surfaces,
    'advisor-create',
  );
  expect(dispatchLegacyChatCreation).not.toHaveBeenCalled();
  legacy.mockRestore();
});
