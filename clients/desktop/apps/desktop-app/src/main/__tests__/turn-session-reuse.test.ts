import type { ChatSendMessageRequest } from '@canopy/desktop-shared/types';
import type { SessionRecreateReason } from '../agents/session-manager';
import {
  applyLiveSessionSettings,
  decideTurnSessionReuse,
  holdsForBackgroundWork,
  settingsHeldChanges,
} from '../lib/turn-session-reuse';

const getSessionMock = jest.fn();
const getReasonsMock = jest.fn<readonly SessionRecreateReason[], []>();
const canReuseMock = jest.fn();
const canPreserveMock = jest.fn();
const changedOptionsMock = jest.fn();
const nativeWorkMock = jest.fn();
const settingsMock = jest.fn();
jest.mock('../agents/session-manager', () => ({
  getSession: (...args: unknown[]): unknown => getSessionMock(...args),
  getSessionRecreateReasons: (): readonly SessionRecreateReason[] =>
    getReasonsMock(),
  shouldRecreateSessionOnNextTurn: (): boolean => getReasonsMock().length > 0,
  canReuseSession: (...args: unknown[]): unknown => canReuseMock(...args),
  canPreserveSessionCapabilitySnapshot: (...args: unknown[]): unknown =>
    canPreserveMock(...args),
  getSessionChangedOptions: (...args: unknown[]): unknown =>
    changedOptionsMock(...args),
  chatHasNativeBackgroundWork: (...args: unknown[]): unknown =>
    nativeWorkMock(...args),
  getSessionTurnSettings: (...args: unknown[]): unknown =>
    settingsMock(...args),
}));
const buildOptionsMock = jest.fn();
const refreshConfigurationMock = jest.fn();
const prepareMock = jest.fn();
jest.mock('../lib/worktree-chat-turn', () => ({
  prepareWorktreeTurnSession: (...args: unknown[]): unknown =>
    prepareMock(...args),
}));
// The real authority's import loads ~1,700 modules (chat state, queue,
// provider sessions); on a loaded host that passes the 5 s test timeout.
const approvalAuthorityMock = jest.fn();
jest.mock('../lib/chat-turn-approval-authority', () => ({
  resolveChatTurnApprovalAuthority: (...args: unknown[]): unknown =>
    approvalAuthorityMock(...args),
}));

const request: ChatSendMessageRequest = {
  projectId: 'project',
  worktreeId: 'worktree',
  chatId: 'chat',
  userMessageId: 'message',
  text: 'hello',
};

beforeEach(() => {
  jest.clearAllMocks();
  getSessionMock.mockReturnValue({});
  getReasonsMock.mockReturnValue([]);
  canReuseMock.mockResolvedValue(true);
  canPreserveMock.mockResolvedValue(true);
  changedOptionsMock.mockResolvedValue([]);
  nativeWorkMock.mockReturnValue(true);
  settingsMock.mockReturnValue(undefined);
  buildOptionsMock.mockReturnValue({ model: 'lane-default' });
  refreshConfigurationMock.mockResolvedValue(undefined);
  prepareMock.mockResolvedValue({
    buildSessionOptions: buildOptionsMock,
    existingCodeGraphToolsAdvertised: false,
    currentCodeGraphToolsAvailable: true,
    resolveSessionConfiguration: refreshConfigurationMock,
  });
  approvalAuthorityMock.mockResolvedValue({
    approvalMode: 'auto',
    chatApprovalMode: 'auto',
    sessionApprovalRules: [],
  });
});

describe('decideTurnSessionReuse', () => {
  it('returns absent without a live session', async () => {
    getSessionMock.mockReturnValue(undefined);
    await expect(decideTurnSessionReuse(request)).resolves.toEqual({
      kind: 'absent',
    });
  });

  it('prepares exactly the dispatch defaults, preserving the request', async () => {
    await expect(decideTurnSessionReuse(request)).resolves.toEqual({
      kind: 'reuse',
    });
    expect(prepareMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ...request,
        planMode: false,
        initiationSource: 'user',
      }),
      undefined,
      { checkModelAvailability: false },
    );
    expect(canReuseMock).toHaveBeenCalledWith({ model: 'lane-default' });
    expect(approvalAuthorityMock).toHaveBeenCalledWith(request, {
      checkAdmission: false,
    });
    expect(canReuseMock).toHaveBeenLastCalledWith({
      model: 'lane-default',
      approvalMode: 'auto',
      sessionApprovalRules: [],
    });
    expect(request.model).toBeUndefined();
  });

  it('preserves explicit plan mode and initiation source', async () => {
    await decideTurnSessionReuse({
      ...request,
      planMode: true,
      initiationSource: 'portal',
    });
    expect(prepareMock).toHaveBeenCalledWith(
      expect.objectContaining({ planMode: true, initiationSource: 'portal' }),
      undefined,
      { checkModelAvailability: false },
    );
  });

  it.each([
    'model',
    'providerType',
    'executionHarness',
    'pluginSelections',
    'globalPluginDefaultsRevision',
    'systemPromptAppend',
    'authGeneration',
    'workOwner',
    'routing',
    'codeGraphToolsAdvertised',
    'selectedModel',
  ])('returns only changed option names for %s', async (name) => {
    canReuseMock.mockResolvedValue(false);
    changedOptionsMock.mockResolvedValue([name]);
    await expect(decideTurnSessionReuse(request)).resolves.toEqual({
      kind: 'recycle',
      changedOptions: [name],
      recreateReasons: [],
    });
  });

  it('refreshes Code Graph advertisement only when logical identity cannot be preserved', async () => {
    canReuseMock.mockResolvedValue(false);
    canPreserveMock.mockResolvedValue(false);
    await decideTurnSessionReuse(request);
    expect(refreshConfigurationMock).toHaveBeenCalledWith(true);
  });

  it('keeps the immutable Code Graph snapshot for matching identity', async () => {
    await decideTurnSessionReuse(request);
    expect(refreshConfigurationMock).not.toHaveBeenCalled();
  });

  it('defers an approval-only marker while native work lives', async () => {
    getReasonsMock.mockReturnValue(['approval']);
    await expect(decideTurnSessionReuse(request)).resolves.toEqual({
      kind: 'reuse',
    });
  });

  it('recycles an approval-only marker without native work', async () => {
    getReasonsMock.mockReturnValue(['approval']);
    nativeWorkMock.mockReturnValue(false);
    await expect(decideTurnSessionReuse(request)).resolves.toEqual({
      kind: 'recycle',
      changedOptions: [],
      recreateReasons: ['approval'],
    });
  });

  it('defers every marker but stop for a send on the live settings', async () => {
    getReasonsMock.mockReturnValue(['plugins', 'plan', 'account']);
    await expect(
      decideTurnSessionReuse(request, { deferRecreateMarkers: true }),
    ).resolves.toEqual({ kind: 'reuse' });
    getReasonsMock.mockReturnValue(['plugins', 'stop']);
    await expect(
      decideTurnSessionReuse(request, { deferRecreateMarkers: true }),
    ).resolves.toEqual({
      kind: 'recycle',
      changedOptions: [],
      recreateReasons: ['plugins', 'stop'],
    });
  });

  it('recycles deferred markers for a live-settings send without native work', async () => {
    getReasonsMock.mockReturnValue(['plugins']);
    nativeWorkMock.mockReturnValue(false);
    await expect(
      decideTurnSessionReuse(request, { deferRecreateMarkers: true }),
    ).resolves.toEqual({
      kind: 'recycle',
      changedOptions: [],
      recreateReasons: ['plugins'],
    });
  });

  it('does not defer mixed approval and settings markers', async () => {
    getReasonsMock.mockReturnValue(['approval', 'plugins']);
    await expect(decideTurnSessionReuse(request)).resolves.toEqual({
      kind: 'recycle',
      changedOptions: [],
      recreateReasons: ['approval', 'plugins'],
    });
  });

  it('does not let an approval marker hide changed options', async () => {
    getReasonsMock.mockReturnValue(['approval']);
    canReuseMock.mockResolvedValue(false);
    changedOptionsMock.mockResolvedValue(['model']);
    await expect(decideTurnSessionReuse(request)).resolves.toEqual({
      kind: 'recycle',
      changedOptions: ['model'],
      recreateReasons: ['approval'],
    });
  });

  it.each<SessionRecreateReason>([
    'plugins',
    'plan',
    'managed_delegation',
    'codex_preferences',
    'account',
    'organization',
    'unspecified',
    'stop',
  ])('recycles a %s marker even with matching options', async (reason) => {
    getReasonsMock.mockReturnValue([reason]);
    await expect(decideTurnSessionReuse(request)).resolves.toEqual({
      kind: 'recycle',
      changedOptions: [],
      recreateReasons: [reason],
    });
  });

  it('propagates preparation errors without starting a session', async () => {
    prepareMock.mockRejectedValue(new Error('host routing mismatch'));
    await expect(decideTurnSessionReuse(request)).rejects.toThrow(
      'host routing mismatch',
    );
  });
});

describe('holdsForBackgroundWork', () => {
  it('holds only native work that a recycle would stop', () => {
    expect(holdsForBackgroundWork(request, { kind: 'reuse' })).toBe(false);
    expect(holdsForBackgroundWork(request, { kind: 'absent' })).toBe(false);
    expect(
      holdsForBackgroundWork(request, {
        kind: 'recycle',
        changedOptions: ['model'],
        recreateReasons: [],
      }),
    ).toBe(true);
    expect(
      holdsForBackgroundWork(request, {
        kind: 'recycle',
        changedOptions: [],
        recreateReasons: ['stop'],
      }),
    ).toBe(false);
  });
  it('does not hold without native work, including managed-delegation-only work', () => {
    nativeWorkMock.mockReturnValue(false);
    expect(
      holdsForBackgroundWork(request, {
        kind: 'recycle',
        changedOptions: ['model'],
        recreateReasons: [],
      }),
    ).toBe(false);
  });
});

describe('settingsHeldChanges', () => {
  it('names each changed setting once, in display order, and skips internal causes', () => {
    expect(
      settingsHeldChanges({
        kind: 'recycle',
        changedOptions: [
          'routing',
          'pluginSelections',
          'selectedModel',
          'model',
        ],
        recreateReasons: ['plugins', 'approval', 'stop', 'unspecified'],
      }),
    ).toEqual(['model', 'plugins', 'account']);
    expect(settingsHeldChanges({ kind: 'reuse' })).toEqual([]);
  });
});

describe('applyLiveSessionSettings', () => {
  it('never overlays approval, which follows the live registry', () => {
    settingsMock.mockReturnValue({
      model: 'gpt-5.5',
      approvalMode: 'full-access',
      sessionApprovalRules: [{ tool: 'Bash', decision: 'allow' }],
    });
    const requestWithDefaultApproval = { ...request };
    // Keep the legacy value even though the current request type excludes it.
    Reflect.set(requestWithDefaultApproval, 'approvalMode', 'default');
    const result = applyLiveSessionSettings(requestWithDefaultApproval);
    expect(result.model).toBe('gpt-5.5');
    expect(result.approvalMode).toBe('default');
    expect(result).not.toHaveProperty('sessionApprovalRules');
  });

  it('is identity without a snapshot or live session', () => {
    expect(applyLiveSessionSettings(request)).toBe(request);
    getSessionMock.mockReturnValue(undefined);
    expect(applyLiveSessionSettings(request)).toBe(request);
  });

  it('overlays only settings, never request content, resume or account/routing identity', () => {
    const settings = {
      model: 'gpt-5.5',
      modelSelectionMode: undefined,
      providerType: 'codex',
      executionHarness: 'codex',
      pluginSelections: {
        collectionIds: ['live'],
        skillRefs: [],
        pluginRefs: [],
      },
      planMode: false,
      modelConfig: { thinkingLevel: 'high' },
      thinkingLevel: undefined,
      approvalMode: undefined,
      sessionApprovalRules: undefined,
      codexProposalMode: undefined,
      codexFastModeEnabled: undefined,
      deferredToolsAllowed: true,
      selectedRepoId: undefined,
    };
    settingsMock.mockReturnValue(settings);
    const edited: ChatSendMessageRequest & { executionContext: string } = {
      ...request,
      model: 'claude-sonnet-4-6',
      planMode: true,
      thinkingLevel: 'low',
      attachmentPaths: ['attachment'],
      sdkSessionId: 'resume',
      executionContext: 'owner',
      aiCreditsRouting: { active: true, scope: 'session', activatedAt: 123 },
      subscriptionBillingOverride: true,
      initiationSource: 'portal',
      selectedRepoId: 'new-repo',
    };
    const result = applyLiveSessionSettings(edited);
    expect(result).toEqual({ ...edited, ...settings });
    expect(result).not.toBe(edited);
    expect(edited.model).toBe('claude-sonnet-4-6');
  });
});
