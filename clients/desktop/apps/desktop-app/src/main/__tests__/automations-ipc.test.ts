jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

const service = {
  configure: jest.fn(),
  list: jest.fn(),
  listRuns: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  runNow: jest.fn(),
  approveSharedPipelineReview: jest.fn(),
  cancelRun: jest.fn(),
  setActivityRemoteMetadata: jest.fn<
    Promise<boolean>,
    [string, AutomationRemoteMetadata]
  >(),
  clearActivityRemoteMetadataByRemoteId: jest.fn<Promise<number>, [string]>(),
};

const mockScopeAutomations = jest.fn();
jest.mock('../services/background-execution-context', () => ({
  scopeAutomationsToSelectedContext: (...args: unknown[]): unknown =>
    mockScopeAutomations(...args),
}));
jest.mock('../automations/service', () => ({
  getAutomationsService: jest.fn(() => service),
}));

const mockAssertCapability = jest.fn<Promise<void>, [string]>();
jest.mock('../canopy-cloud/client', () => ({
  // Share handlers classify failures against the real error class.
  CanopyCloudClientError: class CanopyCloudClientError extends Error {},
  assertCanopyCloudCapability: (capability: string): Promise<void> =>
    mockAssertCapability(capability),
}));

const mockListSharedAutomations = jest.fn<Promise<unknown>, [unknown]>();
const mockGetSharedAutomation = jest.fn<Promise<unknown>, [string]>();
const mockCreateSharedAutomation = jest.fn<Promise<unknown>, [unknown]>();
const mockUpdateSharedAutomation = jest.fn<Promise<unknown>, [unknown]>();
const mockDeleteSharedAutomation = jest.fn<Promise<void>, [unknown]>();
const mockPublishPublicShare = jest.fn<Promise<unknown>, [string]>();
const mockRevokePublicShare = jest.fn<Promise<void>, [string]>();
jest.mock('../automations/canopy-server-client', () => ({
  publishAutomationPublicShare: (id: string): Promise<unknown> =>
    mockPublishPublicShare(id),
  revokeAutomationPublicShare: (id: string): Promise<void> =>
    mockRevokePublicShare(id),
  listSharedAutomations: (request: unknown): Promise<unknown> =>
    mockListSharedAutomations(request),
  getSharedAutomation: (automationId: string): Promise<unknown> =>
    mockGetSharedAutomation(automationId),
  createSharedAutomation: (request: unknown): Promise<unknown> =>
    mockCreateSharedAutomation(request),
  updateSharedAutomation: (request: unknown): Promise<unknown> =>
    mockUpdateSharedAutomation(request),
  deleteSharedAutomation: (request: unknown): Promise<void> =>
    mockDeleteSharedAutomation(request),
}));

const mockListCuratedAutomations = jest.fn<Promise<unknown>, [unknown]>();
const mockGetCuratedAutomation = jest.fn<Promise<unknown>, [string]>();
jest.mock('../automations/curated-automation-catalog', () => ({
  listCuratedAutomations: (request: unknown): Promise<unknown> =>
    mockListCuratedAutomations(request),
  getCuratedAutomation: (key: string): Promise<unknown> =>
    mockGetCuratedAutomation(key),
}));

const mockAnalyzeAutomationCapabilityPackage = jest.fn<
  Promise<unknown>,
  [unknown]
>();
const mockCancelPackageAnalysis = jest.fn<void, [string]>();
const mockCreatePackagedAutomationCapabilityPackage = jest.fn<
  Promise<unknown>,
  [unknown, unknown]
>();
const mockGetAutomationCapabilityPackageReadiness = jest.fn<
  Promise<unknown>,
  [unknown]
>();
const mockInstallAutomationCapabilityPackage = jest.fn<
  Promise<void>,
  [unknown]
>();
const mockRemoveAutomationCapabilityPackageInstall = jest.fn<
  Promise<void>,
  [string]
>();
const mockVerifySharedPipelineAutomationInstallPin = jest.fn<
  Promise<unknown>,
  [string, unknown]
>();
const mockGetSharedPipelineAutomationInstallPin = jest.fn<
  Promise<unknown>,
  [string]
>();
jest.mock('../pipelines/pipeline-package-service', () => ({
  analyzeAutomationCapabilityPackage: (request: unknown): Promise<unknown> =>
    mockAnalyzeAutomationCapabilityPackage(request),
  cancelPackageAnalysis: (analysisId: string): void =>
    mockCancelPackageAnalysis(analysisId),
  createPackagedAutomationCapabilityPackage: (
    request: unknown,
    getWindow: unknown,
  ): Promise<unknown> =>
    mockCreatePackagedAutomationCapabilityPackage(request, getWindow),
  getAutomationCapabilityPackageReadiness: (
    request: unknown,
  ): Promise<unknown> => mockGetAutomationCapabilityPackageReadiness(request),
  getSharedPipelineAutomationInstallPin: (remoteId: string): Promise<unknown> =>
    mockGetSharedPipelineAutomationInstallPin(remoteId),
  installAutomationCapabilityPackage: (request: unknown): Promise<void> =>
    mockInstallAutomationCapabilityPackage(request),
  removeAutomationCapabilityPackageInstall: (
    localAutomationId: string,
  ): Promise<void> =>
    mockRemoveAutomationCapabilityPackageInstall(localAutomationId),
  verifySharedPipelineAutomationInstallPin: (
    remoteId: string,
    installPin: unknown,
  ): Promise<unknown> =>
    mockVerifySharedPipelineAutomationInstallPin(remoteId, installPin),
}));

const mockGenerateCronExpression = jest.fn<
  Promise<{ expression: string }>,
  [unknown]
>();
jest.mock('../automations/cron-generator', () => ({
  generateCronExpression: (input: unknown): Promise<{ expression: string }> =>
    mockGenerateCronExpression(input),
}));

const mockGenerateAutomationIfCommand = jest.fn<
  Promise<{ command: string }>,
  [unknown]
>();
jest.mock('../automations/if-command-generator', () => ({
  generateAutomationIfCommand: (input: unknown): Promise<{ command: string }> =>
    mockGenerateAutomationIfCommand(input),
}));

jest.mock('../lib/preferences-store', () => ({
  // Not degraded: approval resolution fails closed when this is non-null.
  peekPreferencesLoadError: (): null => null,
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({
      cronGenerationModel: 'gpt-5.6-luna',
      cronGenerationThinkingLevel: 'medium',
      ifCommandGenerationModel: 'gpt-5.6-luna',
      ifCommandGenerationThinkingLevel: 'low',
    }),
  ),
}));

jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));

import { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  initCodexModels,
  type AutomationCreateRequest,
  type AutomationRemoteMetadata,
} from '@canopy/desktop-shared/types';
import { registerIpcHandler } from '../ipc/register';
import { registerAutomationsHandlers } from '../ipc/automations';
import { sendToWindow } from '../lib/window-send';
import type { WindowAccessors } from '../ipc';
import { pinOrgProjectsFlagOff } from './helpers/org-projects-flag';

// This suite covers the legacy (context-free) share paths.
beforeEach(() => {
  pinOrgProjectsFlagOff();
});

const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedSendToWindow = jest.mocked(sendToWindow);
const mainWindow = new BrowserWindow();
const appAdvisorWindow = new BrowserWindow();

initCodexModels([{ id: 'gpt-5.6-luna', label: 'GPT 5.6 Luna' }]);

function accessors(): WindowAccessors {
  return {
    getMainWindow: () => mainWindow,
    getAppAdvisorWindow: () => appAdvisorWindow,
    openAppAdvisorWindow: jest.fn(),
    ensureAppAdvisorWindow: jest.fn(),
    closeAppAdvisorWindow: jest.fn(),
    toggleAppAdvisorWindow: jest.fn(),
    getAppAdvisorWindowState: jest.fn(() => ({
      open: false,
      focused: false,
    })),
    markAppAdvisorWindowRendererReady: jest.fn(() => ({
      open: false,
      focused: false,
    })),
    sendAppAdvisorWindowCommand: jest.fn(),
    sendChatWindowCommand: jest.fn(() => true),
    notifyStartupUnlocked: jest.fn(),
  };
}

function invoke(channel: string, request?: unknown): Promise<unknown> {
  const entry = mockedRegisterIpcHandler.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel,
  );
  if (!entry) throw new Error(`Missing handler for ${channel}`);
  return Promise.resolve(
    Reflect.apply(entry[1], undefined, [undefined, request]),
  );
}

function createRequest(): AutomationCreateRequest {
  return {
    name: 'Daily',
    schedule: {
      kind: 'one_time',
      runAt: '2026-05-28T12:00:00.000Z',
      timezone: 'local',
    },
    action: { type: 'app_advisor_prompt', prompt: 'Hello' },
  };
}

describe('automations IPC', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    service.list.mockResolvedValue({ activities: [], recentRuns: [] });
    service.listRuns.mockResolvedValue({
      runs: [{ id: 'run-1', status: 'success' }],
      nextCursor: 'next',
      totalCount: 2,
    });
    service.create.mockResolvedValue({ ok: true, activity: { id: 'a1' } });
    service.update.mockResolvedValue({ ok: true, activity: { id: 'a1' } });
    service.delete.mockResolvedValue({ ok: true, activity: { id: 'a1' } });
    service.runNow.mockResolvedValue({ ok: true, run: { id: 'r1' } });
    service.approveSharedPipelineReview.mockResolvedValue({
      ok: true,
      activity: { id: 'a1' },
    });
    service.cancelRun.mockResolvedValue({
      ok: true,
      run: { id: 'r1', status: 'canceled' },
    });
    mockGenerateCronExpression.mockResolvedValue({ expression: '0 9 * * *' });
    mockGenerateAutomationIfCommand.mockResolvedValue({
      command: 'test -f package.json',
    });
    registerAutomationsHandlers(accessors());
  });

  it('scopes the list to the selected context only when asked (CAN-3448)', async () => {
    const scoped = { activities: [], recentRuns: [] };
    mockScopeAutomations.mockResolvedValue(scoped);

    await expect(
      invoke(IPC_CHANNELS.automationsList, { scope: 'selected-context' }),
    ).resolves.toBe(scoped);
    expect(mockScopeAutomations).toHaveBeenCalledWith({
      activities: [],
      recentRuns: [],
    });

    mockScopeAutomations.mockClear();
    await invoke(IPC_CHANNELS.automationsList);
    await invoke(IPC_CHANNELS.automationsList, { scope: 'all' });
    await invoke(IPC_CHANNELS.automationsList, 'selected-context');
    expect(mockScopeAutomations).not.toHaveBeenCalled();
  });

  it('registers handlers and delegates valid requests', async () => {
    const request = createRequest();

    await expect(invoke(IPC_CHANNELS.automationsList)).resolves.toEqual({
      activities: [],
      recentRuns: [],
    });
    await expect(
      invoke(IPC_CHANNELS.automationsCreate, request),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      invoke(IPC_CHANNELS.automationsUpdate, {
        id: 'a1',
        enabled: false,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      invoke(IPC_CHANNELS.automationsDelete, { id: 'a1' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      invoke(IPC_CHANNELS.automationsRunNow, { id: 'a1' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      invoke(IPC_CHANNELS.automationsListRuns, {
        activityId: 'a1',
        limit: 25,
        statuses: ['success'],
      }),
    ).resolves.toEqual({
      runs: [{ id: 'run-1', status: 'success' }],
      nextCursor: 'next',
      totalCount: 2,
    });
    await expect(
      invoke(IPC_CHANNELS.automationsCancelRun, { runId: 'r1' }),
    ).resolves.toMatchObject({ ok: true });

    // A person's write clears any agent marker.
    expect(service.create).toHaveBeenCalledWith(request, { agentAuthor: null });
    expect(service.update).toHaveBeenCalledWith(
      { id: 'a1', enabled: false },
      undefined,
      undefined,
      { agentAuthor: null },
    );
    expect(service.delete).toHaveBeenCalledWith({ id: 'a1' });
    expect(service.runNow).toHaveBeenCalledWith({ id: 'a1' });
    expect(service.listRuns).toHaveBeenCalledWith({
      activityId: 'a1',
      limit: 25,
      statuses: ['success'],
    });
    expect(service.cancelRun).toHaveBeenCalledWith({ runId: 'r1' });
  });

  it('rejects invalid run history requests', async () => {
    await expect(
      invoke(IPC_CHANNELS.automationsListRuns, {
        activityId: '../bad',
      }),
    ).rejects.toThrow('Invalid automation activity id');
    await expect(
      invoke(IPC_CHANNELS.automationsListRuns, {
        activityId: 'a1',
        limit: 201,
      }),
    ).rejects.toThrow('limit must be between 1 and 200');
    await expect(
      invoke(IPC_CHANNELS.automationsListRuns, {
        activityId: 'a1',
        statuses: ['unknown'],
      }),
    ).rejects.toThrow('statuses are invalid');
  });

  it('generates cron expressions with the configured model', async () => {
    await expect(
      invoke(IPC_CHANNELS.automationsGenerateCron, {
        description: 'Every weekday at 9am',
      }),
    ).resolves.toEqual({ ok: true, expression: '0 9 * * *' });

    expect(mockGenerateCronExpression).toHaveBeenCalledWith({
      description: 'Every weekday at 9am',
      model: 'gpt-5.6-luna',
      modelConfig: {
        speed: 'standard',
        fastMode: false,
        thinkingLevel: 'medium',
      },
      thinkingLevel: 'medium',
    });
  });

  it('passes an exact Ultra fast Codex default to the cron helper instead of downgrading it', async () => {
    jest
      .requireMock<{
        readPreferencesFile: jest.Mock;
      }>('../lib/preferences-store')
      .readPreferencesFile.mockResolvedValueOnce({
        cronGenerationModel: 'gpt-5.6-luna',
        cronGenerationThinkingLevel: 'medium',
        providerModelConfigDefaults: {
          codex: { speed: 'ultrafast', fastMode: false },
        },
      });

    await invoke(IPC_CHANNELS.automationsGenerateCron, {
      description: 'Every weekday at 9am',
    });

    const cronInput: unknown = mockGenerateCronExpression.mock.calls[0]?.[0];
    expect(cronInput).toMatchObject({
      modelConfig: { speed: 'ultrafast', fastMode: false },
    });
  });

  it('rejects an Ultra fast pipeline automation before the service runs', async () => {
    const result = (await invoke(IPC_CHANNELS.automationsCreate, {
      ...createRequest(),
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'pipeline-1',
        modelConfig: { speed: 'ultrafast' },
      },
    })) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Ultra fast');
    expect(service.create).not.toHaveBeenCalled();

    const updated = (await invoke(IPC_CHANNELS.automationsUpdate, {
      id: 'a1',
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'pipeline-1',
        modelConfig: { speed: 'ultrafast' },
      },
    })) as { ok: boolean; error: string };
    expect(updated.ok).toBe(false);
    expect(updated.error).toContain('Ultra fast');
    expect(service.update).not.toHaveBeenCalled();
  });

  it('generates if commands with the configured model', async () => {
    await expect(
      invoke(IPC_CHANNELS.automationsGenerateIfCommand, {
        description: 'Only run when package.json exists',
        currentCommand: 'test -f old-file.txt',
      }),
    ).resolves.toEqual({ ok: true, command: 'test -f package.json' });

    expect(mockGenerateAutomationIfCommand).toHaveBeenCalledWith({
      description: 'Only run when package.json exists',
      currentCommand: 'test -f old-file.txt',
      model: 'gpt-5.6-luna',
      thinkingLevel: 'low',
    });
  });

  it('returns mutation errors for invalid requests', async () => {
    const invalidCreate = (await invoke(IPC_CHANNELS.automationsCreate, {
      ...createRequest(),
      name: '',
    })) as { ok: boolean; error: string };
    expect(invalidCreate.ok).toBe(false);
    expect(invalidCreate.error).toContain('name');

    const invalidUpdate = (await invoke(IPC_CHANNELS.automationsUpdate, {
      id: 'a1',
      enabled: 'yes',
    })) as { ok: boolean; error: string };
    expect(invalidUpdate.ok).toBe(false);
    expect(invalidUpdate.error).toContain('enabled');

    const invalidDelete = (await invoke(
      IPC_CHANNELS.automationsDelete,
      {},
    )) as { ok: boolean; error: string };
    expect(invalidDelete.ok).toBe(false);
    expect(invalidDelete.error).toContain('id');

    const invalidUpdateId = (await invoke(IPC_CHANNELS.automationsUpdate, {
      id: '../bad',
      enabled: false,
    })) as { ok: boolean; error: string };
    expect(invalidUpdateId.ok).toBe(false);
    expect(invalidUpdateId.error).toContain('Invalid automation id');

    const invalidRunNowId = (await invoke(IPC_CHANNELS.automationsRunNow, {
      id: 'Bad_ID',
    })) as { ok: boolean; error: string };
    expect(invalidRunNowId.ok).toBe(false);
    expect(invalidRunNowId.error).toContain('Invalid automation id');

    const invalidDeleteId = (await invoke(IPC_CHANNELS.automationsDelete, {
      id: 'bad/id',
    })) as { ok: boolean; error: string };
    expect(invalidDeleteId.ok).toBe(false);
    expect(invalidDeleteId.error).toContain('Invalid automation id');

    const invalidCron = (await invoke(IPC_CHANNELS.automationsGenerateCron, {
      description: '',
    })) as { ok: boolean; error: string };
    expect(invalidCron.ok).toBe(false);
    expect(invalidCron.error).toContain('description');

    const longCronDescription = (await invoke(
      IPC_CHANNELS.automationsGenerateCron,
      {
        description: 'x'.repeat(1001),
      },
    )) as { ok: boolean; error: string };
    expect(longCronDescription.ok).toBe(false);
    expect(longCronDescription.error).toContain('max 1000 characters');

    const invalidIfCommand = (await invoke(
      IPC_CHANNELS.automationsGenerateIfCommand,
      {
        description: '',
      },
    )) as { ok: boolean; error: string };
    expect(invalidIfCommand.ok).toBe(false);
    expect(invalidIfCommand.error).toContain('description');

    const longIfCommandDescription = (await invoke(
      IPC_CHANNELS.automationsGenerateIfCommand,
      {
        description: 'x'.repeat(1001),
      },
    )) as { ok: boolean; error: string };
    expect(longIfCommandDescription.ok).toBe(false);
    expect(longIfCommandDescription.error).toContain('max 1000 characters');

    const invalidIfCommandCurrentValue = (await invoke(
      IPC_CHANNELS.automationsGenerateIfCommand,
      {
        description: 'Only run when ready',
        currentCommand: false,
      },
    )) as { ok: boolean; error: string };
    expect(invalidIfCommandCurrentValue.ok).toBe(false);
    expect(invalidIfCommandCurrentValue.error).toContain('ifCommand');
  });

  describe('shared-Automation cloud handlers (CAN-1581)', () => {
    const sharedDetail = {
      id: '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111',
      contentHash: 'a'.repeat(64),
      shareScope: 'team',
      createdBy: { id: 'account-a', name: 'Author' },
      updatedAt: '2026-08-19T12:00:00.000Z',
      automation: { version: 1, name: 'Nightly triage' },
    };

    beforeEach(() => {
      mockAssertCapability.mockResolvedValue(undefined);
      service.setActivityRemoteMetadata.mockResolvedValue(true);
      service.clearActivityRemoteMetadataByRemoteId.mockResolvedValue(1);
    });

    it('publishes and revokes public shares after the capability check', async (): Promise<void> => {
      const id = '11111111-1111-4111-8111-111111111111';
      const publicShare = { externalId: id };
      mockPublishPublicShare.mockImplementation((): Promise<unknown> => {
        expect(mockAssertCapability).toHaveBeenCalledWith(
          'automations-crud-v1',
        );
        return Promise.resolve(publicShare);
      });
      await expect(
        invoke('automations:public-share:publish', id),
      ).resolves.toBe(publicShare);
      expect(mockPublishPublicShare).toHaveBeenCalledWith(id);
      await expect(
        invoke('automations:public-share:revoke', id),
      ).resolves.toBeUndefined();
      expect(mockRevokePublicShare).toHaveBeenCalledWith(id);
    });

    it('validates public-share ids before calling the cloud', async (): Promise<void> => {
      for (const channel of [
        'automations:public-share:publish',
        'automations:public-share:revoke',
      ]) {
        await expect(invoke(channel, '../invalid')).rejects.toThrow(
          'Invalid shared automation id',
        );
      }
      expect(mockAssertCapability).not.toHaveBeenCalled();
      expect(mockPublishPublicShare).not.toHaveBeenCalled();
      expect(mockRevokePublicShare).not.toHaveBeenCalled();
    });

    it('blocks public-share mutations when the capability is unavailable', async (): Promise<void> => {
      mockAssertCapability.mockRejectedValue(
        new Error('Unsupported automations-crud-v1'),
      );
      for (const channel of [
        'automations:public-share:publish',
        'automations:public-share:revoke',
      ]) {
        await expect(invoke(channel, sharedDetail.id)).rejects.toThrow(
          'automations-crud-v1',
        );
      }
      expect(mockPublishPublicShare).not.toHaveBeenCalled();
      expect(mockRevokePublicShare).not.toHaveBeenCalled();
    });

    it('lists shared automations after asserting the capability', async () => {
      const response = { automations: [], nextCursor: undefined };
      mockListSharedAutomations.mockResolvedValue(response);

      await expect(
        invoke(IPC_CHANNELS.automationsSharedList, { limit: 10, query: 'tri' }),
      ).resolves.toBe(response);

      expect(mockAssertCapability).toHaveBeenCalledWith('automations-crud-v1');
      expect(mockListSharedAutomations).toHaveBeenCalledWith({
        limit: 10,
        query: 'tri',
      });
    });

    it('fetches one shared automation after validating its id', async () => {
      mockGetSharedAutomation.mockResolvedValue(sharedDetail);

      await expect(
        invoke(IPC_CHANNELS.automationsSharedGet, sharedDetail.id),
      ).resolves.toBe(sharedDetail);
      expect(mockGetSharedAutomation).toHaveBeenCalledWith(sharedDetail.id);

      await expect(
        invoke(IPC_CHANNELS.automationsSharedGet, 'Not A Valid Id'),
      ).rejects.toThrow('Invalid shared automation id');
      expect(mockGetSharedAutomation).toHaveBeenCalledTimes(1);
    });

    it('gates curated catalog list and detail handlers on their capability', async () => {
      const list = { version: 1, data: [], nextCursor: null, stale: false };
      const detail = { key: 'daily-review' };
      mockListCuratedAutomations.mockResolvedValue(list);
      mockGetCuratedAutomation.mockResolvedValue(detail);

      await expect(
        invoke(IPC_CHANNELS.automationsCuratedList, { limit: 10 }),
      ).resolves.toBe(list);
      await expect(
        invoke(IPC_CHANNELS.automationsCuratedGet, 'daily-review'),
      ).resolves.toBe(detail);
      expect(mockAssertCapability).toHaveBeenCalledWith(
        'automation-catalog-v1',
      );
      expect(mockListCuratedAutomations).toHaveBeenCalledWith({ limit: 10 });
      expect(mockGetCuratedAutomation).toHaveBeenCalledWith('daily-review');

      await expect(
        invoke(IPC_CHANNELS.automationsCuratedGet, '../invalid'),
      ).rejects.toThrow('Invalid curated automation key');
    });

    it('creates a share and writes remote metadata onto the activity', async () => {
      mockCreateSharedAutomation.mockResolvedValue(sharedDetail);

      const request = {
        activityId: 'a1',
        automation: sharedDetail.automation,
        shareScope: 'team',
        teamId: 'team-1',
      };
      await expect(
        invoke(IPC_CHANNELS.automationsSharedCreate, request),
      ).resolves.toEqual({ ok: true, value: sharedDetail });

      expect(mockAssertCapability).toHaveBeenCalledWith('automations-crud-v1');
      expect(mockCreateSharedAutomation).toHaveBeenCalledWith({
        automation: sharedDetail.automation,
        shareScope: 'team',
        teamId: 'team-1',
      });
      expect(service.setActivityRemoteMetadata).toHaveBeenCalledWith('a1', {
        accountId: 'account-a',
        remoteId: sharedDetail.id,
        contentHash: sharedDetail.contentHash,
        shareScope: 'team',
        sharedAt: sharedDetail.updatedAt,
      });
    });

    it('updates a share and rewrites remote metadata onto the activity', async () => {
      const updatedDetail = { ...sharedDetail, contentHash: 'b'.repeat(64) };
      mockUpdateSharedAutomation.mockResolvedValue(updatedDetail);

      const request = {
        activityId: 'a1',
        automationId: sharedDetail.id,
        automation: sharedDetail.automation,
        expectedContentHash: sharedDetail.contentHash,
      };
      await expect(
        invoke(IPC_CHANNELS.automationsSharedUpdate, request),
      ).resolves.toEqual({ ok: true, value: updatedDetail });

      expect(mockUpdateSharedAutomation).toHaveBeenCalledWith({
        automationId: sharedDetail.id,
        automation: sharedDetail.automation,
        expectedContentHash: sharedDetail.contentHash,
      });
      expect(service.setActivityRemoteMetadata).toHaveBeenCalledWith('a1', {
        accountId: 'account-a',
        remoteId: sharedDetail.id,
        contentHash: updatedDetail.contentHash,
        shareScope: 'team',
        sharedAt: sharedDetail.updatedAt,
      });
    });

    it('deletes a share and clears remote metadata on linked activities', async () => {
      await expect(
        invoke(IPC_CHANNELS.automationsSharedDelete, {
          automationId: sharedDetail.id,
        }),
      ).resolves.toBeUndefined();

      expect(mockDeleteSharedAutomation).toHaveBeenCalledWith({
        automationId: sharedDetail.id,
      });
      expect(
        service.clearActivityRemoteMetadataByRemoteId,
      ).toHaveBeenCalledWith(sharedDetail.id);
    });

    it('exposes automation capability package operations to the renderer', async () => {
      const analysisId = '77777777-7777-4777-8777-777777777777';
      const digest = `pp:v1:${'A'.repeat(43)}`;
      const packageRef = { version: 1 as const, digest };
      const installPin = {
        pipelineContentHash: 'a'.repeat(64),
        distributionMode: 'definition_only' as const,
      };
      const analysis = { analysisId, state: 'ready' };
      const committed = {
        capabilityPackage: packageRef,
        committedPackageUploadId: '88888888-8888-4888-8888-888888888888',
      };
      const readiness = { status: 'ready', requirements: [] };
      mockAnalyzeAutomationCapabilityPackage.mockResolvedValue(analysis);
      mockCreatePackagedAutomationCapabilityPackage.mockResolvedValue(
        committed,
      );
      mockGetAutomationCapabilityPackageReadiness.mockResolvedValue(readiness);
      mockInstallAutomationCapabilityPackage.mockResolvedValue();
      mockVerifySharedPipelineAutomationInstallPin.mockResolvedValue(
        installPin,
      );
      mockGetSharedPipelineAutomationInstallPin.mockResolvedValue(installPin);

      const analyzeRequest = {
        rawContent: '{"version":1}',
        selections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
      };
      await expect(
        invoke(
          IPC_CHANNELS.automationsCapabilityPackageAnalyze,
          analyzeRequest,
        ),
      ).resolves.toBe(analysis);
      await expect(
        invoke(IPC_CHANNELS.automationsCapabilityPackageCancel, analysisId),
      ).resolves.toBeUndefined();
      await expect(
        invoke(IPC_CHANNELS.automationsCapabilityPackageCommit, {
          analysisId,
        }),
      ).resolves.toEqual({ ok: true, value: committed });

      const packageRequest = {
        remoteId: sharedDetail.id,
        packageRef,
      };
      await expect(
        invoke(
          IPC_CHANNELS.automationsCapabilityPackageReadiness,
          packageRequest,
        ),
      ).resolves.toBe(readiness);
      await expect(
        invoke(IPC_CHANNELS.automationsCapabilityPackageInstall, {
          ...packageRequest,
          localAutomationId: sharedDetail.id,
        }),
      ).resolves.toBeUndefined();
      await expect(
        invoke(IPC_CHANNELS.automationsCapabilityPackageInstall, {
          localAutomationId: sharedDetail.id,
          remove: true,
        }),
      ).resolves.toBeUndefined();
      await expect(
        invoke(IPC_CHANNELS.automationsSharedPipelinePinVerify, {
          remoteId: sharedDetail.id,
          installPin,
        }),
      ).resolves.toBe(installPin);
      await expect(
        invoke(IPC_CHANNELS.automationsSharedPipelinePinResolve, {
          remoteId: sharedDetail.id,
        }),
      ).resolves.toBe(installPin);
      await expect(
        invoke(IPC_CHANNELS.automationsSharedPipelineReviewApprove, {
          id: sharedDetail.id,
          installPin,
          runNow: true,
        }),
      ).resolves.toMatchObject({ ok: true });

      expect(mockAnalyzeAutomationCapabilityPackage).toHaveBeenCalledWith(
        analyzeRequest,
      );
      expect(mockCancelPackageAnalysis).toHaveBeenCalledWith(analysisId);
      expect(
        mockCreatePackagedAutomationCapabilityPackage,
      ).toHaveBeenCalledWith({ analysisId }, expect.any(Function));
      expect(mockGetAutomationCapabilityPackageReadiness).toHaveBeenCalledWith(
        packageRequest,
      );
      expect(mockInstallAutomationCapabilityPackage).toHaveBeenCalledWith({
        ...packageRequest,
        localAutomationId: sharedDetail.id,
      });
      expect(mockRemoveAutomationCapabilityPackageInstall).toHaveBeenCalledWith(
        sharedDetail.id,
      );
      expect(mockVerifySharedPipelineAutomationInstallPin).toHaveBeenCalledWith(
        sharedDetail.id,
        installPin,
      );
      expect(mockGetSharedPipelineAutomationInstallPin).toHaveBeenCalledWith(
        sharedDetail.id,
      );
      expect(service.approveSharedPipelineReview).toHaveBeenCalledWith({
        id: sharedDetail.id,
        installPin,
        runNow: true,
      });
    });

    it('rejects every shared operation when the capability is missing', async () => {
      mockAssertCapability.mockRejectedValue(
        new Error('Server does not support automations-crud-v1'),
      );

      await expect(
        invoke(IPC_CHANNELS.automationsSharedList, {}),
      ).rejects.toThrow('automations-crud-v1');
      // Share creation resolves its failure as an envelope; the plain test
      // error has no Cloud classification, so it reports generically.
      await expect(
        invoke(IPC_CHANNELS.automationsSharedCreate, {
          activityId: 'a1',
          automation: sharedDetail.automation,
        }),
      ).resolves.toMatchObject({ ok: false, failure: { kind: 'unknown' } });

      expect(mockListSharedAutomations).not.toHaveBeenCalled();
      expect(mockCreateSharedAutomation).not.toHaveBeenCalled();
      expect(service.setActivityRemoteMetadata).not.toHaveBeenCalled();
    });

    it('validates ids before any cloud call', async () => {
      await expect(
        invoke(IPC_CHANNELS.automationsSharedUpdate, {
          activityId: 'a1',
          automationId: 'Bad Id',
          automation: sharedDetail.automation,
        }),
      ).rejects.toThrow('Invalid shared automation id');
      await expect(
        invoke(IPC_CHANNELS.automationsSharedDelete, {
          automationId: '../etc',
        }),
      ).rejects.toThrow('Invalid shared automation id');
      await expect(
        invoke(IPC_CHANNELS.automationsSharedCreate, {
          activityId: 'Bad Activity',
          automation: sharedDetail.automation,
        }),
      ).rejects.toThrow('Invalid automation id');

      expect(mockUpdateSharedAutomation).not.toHaveBeenCalled();
      expect(mockDeleteSharedAutomation).not.toHaveBeenCalled();
      expect(mockCreateSharedAutomation).not.toHaveBeenCalled();
    });
  });

  it('broadcasts service changes to the main and App Advisor windows', () => {
    type ConfiguredService = {
      onChange: (snapshot: {
        activities: unknown[];
        recentRuns: unknown[];
      }) => void;
    };
    const configureCalls = service.configure.mock.calls as unknown as Array<
      [ConfiguredService]
    >;
    const configured = configureCalls[0]?.[0];
    const snapshot = { activities: [], recentRuns: [] };
    if (!configured) {
      throw new Error('Service was not configured');
    }

    configured.onChange(snapshot);

    expect(mockedSendToWindow).toHaveBeenNthCalledWith(
      1,
      mainWindow,
      IPC_CHANNELS.automationsChanged,
      snapshot,
    );
    expect(mockedSendToWindow).toHaveBeenNthCalledWith(
      2,
      appAdvisorWindow,
      IPC_CHANNELS.automationsChanged,
      snapshot,
    );
  });
});
