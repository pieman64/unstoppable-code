import {
  APP_ADVISOR_PROJECT_ID,
  IPC_CHANNELS,
  initAgentModels,
  initClaudeModels,
  initCodexModels,
  initCursorModels,
  initCopilotModels,
  type PreferencesData,
  type PortalCommandEnvelope,
  type PortalCommandPayloadMap,
  type PortalCommandType,
  type WorkspaceContextState,
} from '@canopy/desktop-shared/types';
import type * as SessionManagerModule from '../../../agents/session-manager';
import { BrowserWindow } from 'electron';
import { sendToWindow } from '../../../lib/window-send';
import {
  createWorkEntry,
  listWorkEntries,
  resolveWorkEntryForChat,
} from '../../../lib/cowork-work-entries';
import { writeChatTabsFile } from '../../../lib/chat-tabs';
import { readChatTabsFile } from '../../../lib/chat-tabs-reader';
import { completeAppAdvisorAskUserRequest } from '../../../ipc/app-advisor';
import {
  cancelWorktreeChat,
  projectAppAdvisorChatSummaries,
  sendWorktreeChatMessage,
} from '../../../services/chat-service';
import { changeChatModel } from '../../../ipc/chat';
import { emitAppAdvisorSyntheticResultEvent } from '../../../app-advisor/chat-service';
import { setPortalAppAdvisorSurfaces } from '../../app-advisor-portal-surfaces';
import type { AppAdvisorToolRuntimeSurfaces } from '../../../app-advisor/runtime';
import {
  handlePortalAppAdvisorAnswerQuestion,
  handlePortalAppAdvisorCancel,
  handlePortalAppAdvisorCreateTab,
  handlePortalAppAdvisorDismissQuestion,
  handlePortalAppAdvisorSettingsGet,
  handlePortalAppAdvisorSettingsSave,
  handlePortalAppAdvisorSend,
  handlePortalAppAdvisorSetModel,
} from '../app-advisor-adapter';
import {
  readAppAdvisorClaudeMd,
  readAppAdvisorWorkspaceSettings,
  saveAppAdvisorClaudeMd,
  saveAppAdvisorWorkspaceSettings,
} from '../../../lib/app-advisor-workspace';
import {
  readPreferencesFile,
  updatePreferencesFile,
} from '../../../lib/preferences-store';
import { setAppAdvisorProjectAgentAccess } from '../../../lib/app-advisor-project-agent-access';
import { buildPluginCatalog } from '../../../services/plugin-catalog-service';
import { buildProjectedModelCatalog } from '../../model-catalog-projection';
import * as AgentDefaultModel from '../../../agents/agent-default-model';
import { peekProviderNativeAuthAvailability } from '../../../auth/provider-auth-state';
import type { PortalAdapterContext } from '../types';

const appAdvisorSyntheticFence = {
  isCurrent: jest.fn(() => true),
};
const advisorStopTarget = {
  projectId: APP_ADVISOR_PROJECT_ID,
  worktreeId: 'entry-1',
  chatId: 'chat-1',
};
const advisorStopContext = {
  target: advisorStopTarget,
  session: { owner: 'advisor-session-owner' },
  fence: {
    processOwner: Symbol('advisor-session-owner'),
    turnId: 'advisor-turn',
    userMessageId: 'advisor-user-message',
    turnEpoch: 4,
  },
};
const mockGetAllActiveSessionInfos = jest.fn(() => [advisorStopTarget]);
const mockCaptureChatTurnStop = jest.fn<unknown, [unknown]>(
  () => advisorStopContext,
);
const mockIsChatTurnStopCurrent = jest.fn<boolean, [unknown]>(() => true);
const mockCaptureAppAdvisorSyntheticResultFence = jest.fn<unknown, [unknown]>(
  () => appAdvisorSyntheticFence,
);
const mockCancelWorktreeChat = jest.fn<Promise<unknown>, [unknown, unknown?]>(
  () => Promise.resolve({ ok: true }),
);
const mockEmitSyntheticResultEvent = jest.fn<
  Promise<void>,
  [unknown, unknown, unknown?]
>(() => Promise.resolve());

jest.mock('../../../lib/window-send', () => ({
  sendToWindow: jest.fn(),
  sendToWindowDetailed: jest.fn(() => ({ delivered: true })),
}));
jest.mock('../../../agents/session-manager', () => ({
  ...jest.requireActual<typeof SessionManagerModule>(
    '../../../agents/session-manager',
  ),
  getAllActiveSessionInfos: (): unknown[] => mockGetAllActiveSessionInfos(),
}));
jest.mock('../../../lib/chat-turn-cancel', () => ({
  captureChatTurnStop: (...args: [unknown]): unknown =>
    mockCaptureChatTurnStop(...args),
  isChatTurnStopCurrent: (...args: [unknown]): boolean =>
    mockIsChatTurnStopCurrent(...args),
}));
jest.mock('../../../lib/cowork-work-entries', () => ({
  createWorkEntry: jest.fn(),
  listWorkEntries: jest.fn(),
  resolveWorkEntryForChat: jest.fn(),
}));
jest.mock('../../../lib/chat-tabs', () => ({
  writeChatTabsFile: jest.fn(),
}));
jest.mock('../../../lib/chat-tabs-reader', () => ({
  readChatTabsFile: jest.fn(),
}));
const mockWorkspaceContextGetState = jest.fn<WorkspaceContextState, []>(() => ({
  context: { kind: 'personal' },
  revision: 0,
  organizations: [],
}));
jest.mock('../../../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): {
    getState: typeof mockWorkspaceContextGetState;
  } => ({
    getState: mockWorkspaceContextGetState,
  }),
}));
jest.mock('../../../lib/app-advisor-project-agent-access', () => ({
  setAppAdvisorProjectAgentAccess: jest.fn(),
}));
jest.mock('../../../lib/chat-tab-mutation-queue', () => ({
  enqueueChatTabMutation: jest.fn(
    (_projectId: string, _worktreeId: string, mutation: () => unknown) =>
      mutation(),
  ),
}));
jest.mock('../../../ipc/app-advisor', () => ({
  completeAppAdvisorAskUserRequest: jest.fn(),
}));
jest.mock('../../../services/chat-service', () => ({
  cancelWorktreeChat: jest.fn(
    (...args: [unknown, unknown?]): Promise<unknown> =>
      mockCancelWorktreeChat(...args),
  ),
  projectAppAdvisorChatSummaries: jest.fn(),
  sendWorktreeChatMessage: jest.fn(),
}));
jest.mock('../../../ipc/chat', () => ({
  changeChatModel: jest.fn(),
}));
const mockClaudeTerminalGetState = jest.fn();
jest.mock('../../../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: jest.fn(() => ({
    getState: mockClaudeTerminalGetState,
  })),
}));
jest.mock('../../../app-advisor/chat-service', () => ({
  captureAppAdvisorSyntheticResultFence: jest.fn(
    (...args: [unknown]): unknown =>
      mockCaptureAppAdvisorSyntheticResultFence(...args),
  ),
  emitAppAdvisorSyntheticResultEvent: jest.fn(
    (...args: [unknown, unknown, unknown?]): Promise<void> =>
      mockEmitSyntheticResultEvent(...args),
  ),
}));
jest.mock('../../../lib/app-advisor-workspace', () => ({
  readAppAdvisorClaudeMd: jest.fn(),
  readAppAdvisorWorkspaceSettings: jest.fn(),
  saveAppAdvisorClaudeMd: jest.fn(),
  saveAppAdvisorWorkspaceSettings: jest.fn(),
}));
jest.mock('../../../lib/preferences-store', () => ({
  // Not degraded: approval resolution fails closed when this is non-null.
  peekPreferencesLoadError: (): null => null,
  projectPreferencesForRuntime: (
    preferences: PreferencesData,
  ): PreferencesData => preferences,
  readPreferencesFile: jest.fn(),
  updatePreferencesFile: jest.fn(),
}));
jest.mock('../../../services/plugin-catalog-service', () => ({
  buildPluginCatalog: jest.fn(),
}));
jest.mock('../../model-catalog-projection', () => ({
  buildProjectedModelCatalog: jest.fn(),
}));
jest.mock('../../../auth/provider-auth-state', () => ({
  peekProviderNativeAuthAvailability: jest.fn(),
  peekPortalProviderAvailability: jest.fn(() => ({
    codex: true,
    cursor: true,
  })),
}));
const mockIsCopilotRuntimeAvailable = jest.fn<Promise<boolean>, []>(() =>
  Promise.resolve(true),
);
jest.mock('../../../copilot/runtime-availability', () => ({
  isCopilotRuntimeAvailable: (): Promise<boolean> =>
    mockIsCopilotRuntimeAvailable(),
}));
const mockIsCursorRuntimeAvailable = jest.fn<Promise<boolean>, []>(() =>
  Promise.resolve(true),
);
jest.mock('../../../cursor/runtime-availability', () => ({
  isCursorRuntimeAvailable: (): Promise<boolean> =>
    mockIsCursorRuntimeAvailable(),
}));

const mockedSendToWindow = jest.mocked(sendToWindow);
const mockedCreateWorkEntry = jest.mocked(createWorkEntry);
const mockedListWorkEntries = jest.mocked(listWorkEntries);
const mockedResolveWorkEntryForChat = jest.mocked(resolveWorkEntryForChat);
const mockedReadChatTabsFile = jest.mocked(readChatTabsFile);
const mockedSetAppAdvisorProjectAgentAccess = jest.mocked(
  setAppAdvisorProjectAgentAccess,
);
const mockedWriteChatTabsFile = jest.mocked(writeChatTabsFile);
const mockedCompleteAskUser = jest.mocked(completeAppAdvisorAskUserRequest);
const mockedCancelWorktreeChat = jest.mocked(cancelWorktreeChat);
const mockedChangeChatModel = jest.mocked(changeChatModel);
const mockedProjectSummaries = jest.mocked(projectAppAdvisorChatSummaries);
const mockedSendWorktreeChatMessage = jest.mocked(sendWorktreeChatMessage);
const mockedEmitSyntheticResult = jest.mocked(
  emitAppAdvisorSyntheticResultEvent,
);
const mockedReadClaudeMd = jest.mocked(readAppAdvisorClaudeMd);
const mockedReadSettings = jest.mocked(readAppAdvisorWorkspaceSettings);
const mockedSaveClaudeMd = jest.mocked(saveAppAdvisorClaudeMd);
const mockedSaveSettings = jest.mocked(saveAppAdvisorWorkspaceSettings);
const mockedReadPreferences = jest.mocked(readPreferencesFile);
const mockedUpdatePreferences = jest.mocked(updatePreferencesFile);
const mockedBuildPluginCatalog = jest.mocked(buildPluginCatalog);
const mockedBuildModelCatalog = jest.mocked(buildProjectedModelCatalog);
const mockedProviderAvailability = jest.mocked(
  peekProviderNativeAuthAvailability,
);

const mainWindow = { marker: 'main' } as unknown as BrowserWindow;
const appAdvisorWindow = { marker: 'advisor' } as unknown as BrowserWindow;

function makeSurfaces(): AppAdvisorToolRuntimeSurfaces {
  return {
    getMainWindow: () => mainWindow,
    getAppAdvisorWindow: () => appAdvisorWindow,
    openAppAdvisorWindow: jest.fn(),
    ensureAppAdvisorWindow: jest.fn(),
  };
}

interface RecordedComplete {
  commandId: string;
  result: unknown;
}
interface RecordedFail {
  commandId: string;
  code: string;
  message: string;
  retryable: boolean | undefined;
}

interface Recorder {
  context: PortalAdapterContext;
  completes: RecordedComplete[];
  fails: RecordedFail[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isBooleanPredicate(value: unknown): value is () => boolean {
  return typeof value === 'function';
}

function recorder(): Recorder {
  const completes: RecordedComplete[] = [];
  const fails: RecordedFail[] = [];
  const context: PortalAdapterContext = {
    getWindow: () => null,
    enqueueEvent: (): void => {},
    complete: (command, result): void => {
      completes.push({ commandId: command.id, result });
    },
    fail: (command, code, message, retryable): void => {
      fails.push({ commandId: command.id, code, message, retryable });
    },
  };
  return { context, completes, fails };
}

function command<TPayload>(
  type: PortalCommandType,
  payload: TPayload,
): PortalCommandEnvelope<TPayload> {
  return {
    id: `cmd-${type}`,
    sequence: 1,
    type,
    payload,
    createdAt: '2026-08-26T00:00:00.000Z',
    expiresAt: null,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred promise did not resolve');
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function partialPreferences(
  preferences: Partial<PreferencesData>,
): PreferencesData {
  // A partial fixture: these tests rely on unset preferences staying undefined.
  return preferences as PreferencesData;
}

function initUnavailableAgentModel(): void {
  initAgentModels([
    {
      id: 'agent_model_stale',
      name: 'Stale Agent',
      baseModel: 'removed-base-model',
      instructions: '',
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
      },
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
      available: true,
    },
  ]);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCancelWorktreeChat.mockReset().mockResolvedValue({ ok: true });
  mockCaptureAppAdvisorSyntheticResultFence.mockReturnValue(
    appAdvisorSyntheticFence,
  );
  mockGetAllActiveSessionInfos.mockReturnValue([advisorStopTarget]);
  mockCaptureChatTurnStop.mockReturnValue(advisorStopContext);
  mockIsChatTurnStopCurrent.mockReturnValue(true);
  appAdvisorSyntheticFence.isCurrent.mockReturnValue(true);
  mockEmitSyntheticResultEvent.mockReset().mockResolvedValue(undefined);
  jest
    .spyOn(BrowserWindow, 'getAllWindows')
    .mockReturnValue([mainWindow, appAdvisorWindow]);
  initClaudeModels([{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }]);
  initCodexModels([
    { id: 'gpt-5.5', label: 'GPT 5.5' },
    { id: 'gpt-5.6-sol', label: 'GPT 5.6 Sol' },
  ]);
  initAgentModels([]);
  initCursorModels([
    { id: 'cursor-default', rawModelId: 'default[]', label: 'Cursor default' },
  ]);
  mockIsCursorRuntimeAvailable.mockResolvedValue(true);
  initCopilotModels([
    {
      id: 'copilot:fixture',
      rawModelId: 'fixture',
      label: 'Copilot fixture',
      supportsVision: false,
      supportedThinkingLevels: [],
    },
  ]);
  mockIsCopilotRuntimeAvailable.mockResolvedValue(true);
  setPortalAppAdvisorSurfaces(makeSurfaces());
  mockedResolveWorkEntryForChat.mockResolvedValue({
    entryId: 'entry-1',
    archivedInEntryId: null,
  });
  mockedListWorkEntries.mockResolvedValue([
    {
      id: 'entry-1',
      title: 'Entry one',
      createdAt: '2026-08-25T00:00:00.000Z',
      chatCount: 1,
    },
  ]);
  mockedCreateWorkEntry.mockImplementation((_projectId, options) =>
    Promise.resolve({
      entry: {
        id: options?.id ?? 'entry-minted',
        title: 'New Chat',
        createdAt: '2026-08-26T00:00:00.000Z',
        chatCount: 0,
      },
      reusedExistingEmpty: false,
    }),
  );
  mockedSendWorktreeChatMessage.mockResolvedValue({
    ok: true,
    chatId: 'chat-1',
  });
  mockedCancelWorktreeChat.mockClear();
  mockCancelWorktreeChat.mockReset().mockResolvedValue({ ok: true });
  mockedEmitSyntheticResult.mockClear();
  mockEmitSyntheticResultEvent.mockReset().mockResolvedValue(undefined);
  mockedProjectSummaries.mockResolvedValue(undefined);
  mockedChangeChatModel.mockResolvedValue(true);
  mockClaudeTerminalGetState.mockReturnValue(undefined);
  mockedReadChatTabsFile.mockResolvedValue({
    version: 1,
    tabs: [],
    activeTabId: '',
  });
  mockedReadPreferences.mockResolvedValue(
    partialPreferences({
      appAdvisorModel: 'gpt-5.5',
      appAdvisorThinkingLevel: 'high',
      appAdvisorPluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
      },
      approvalsUpgradeNoticeDismissed: false,
    }),
  );
  mockWorkspaceContextGetState.mockReturnValue({
    context: { kind: 'personal' },
    revision: 0,
    organizations: [],
  });
  mockedReadClaudeMd.mockResolvedValue('# Instructions\n');
  mockedReadSettings.mockResolvedValue({
    version: 1,
    archiveRetentionDays: 7,
  });
  mockedBuildPluginCatalog.mockResolvedValue({
    collections: [],
    skills: [],
    plugins: [],
    mcpServers: [],
    entries: [],
  });
  mockedBuildModelCatalog.mockReturnValue([
    {
      id: 'gpt-5.5',
      label: 'GPT-5.5',
      provider: 'codex',
      kind: 'model',
      available: true,
    },
  ]);
  mockedProviderAvailability.mockReturnValue({ codex: true });
  mockedUpdatePreferences.mockImplementation(async (updater, onCommitted) => {
    const committed = {
      ...(await readPreferencesFile()),
      ...(await updater(await readPreferencesFile())),
    };
    onCommitted?.(committed);
    return committed;
  });
  mockedSaveClaudeMd.mockResolvedValue(undefined);
  mockedSaveSettings.mockResolvedValue({
    version: 1,
    archiveRetentionDays: 7,
  });
});

afterEach(() => {
  setPortalAppAdvisorSurfaces(null);
});

describe('portal.app_advisor.settings', () => {
  it('loads the same defaults, instructions, catalogs, and retention as desktop', async () => {
    const { context, completes, fails } = recorder();
    await handlePortalAppAdvisorSettingsGet(
      command('portal.app_advisor.settings.get', {}),
      context,
    );

    expect(fails).toEqual([]);
    expect(completes).toHaveLength(1);
    expect(completes[0]?.commandId).toBe('cmd-portal.app_advisor.settings.get');
    expect(completes[0]?.result).toMatchObject({
      model: 'gpt-5.5',
      thinkingLevel: 'high',
      instructions: '# Instructions\n',
      archiveRetentionDays: 7,
      providerAvailability: { codex: true, cursor: true },
      approvalsUpgradeNoticeDismissed: false,
      projectAgentAccess: { mode: 'enabled', selectedOwners: [] },
      projectAgentAccessOwnerOptions: [
        { owner: { kind: 'personal' }, label: 'Personal' },
      ],
    });
    expect(mockedBuildModelCatalog).toHaveBeenCalledWith('gpt-5.5', {
      cursor: true,
      owner: { kind: 'personal' },
      copilot: true,
      opencode: true,
    });
    expect(mockedBuildPluginCatalog).toHaveBeenCalledTimes(1);
  });

  it('projects the saved access preference and alphabetically ordered account owners', async () => {
    const currentPreferences = await readPreferencesFile();
    mockedReadPreferences.mockResolvedValueOnce({
      ...currentPreferences,
      appAdvisorProjectAgentAccess: {
        mode: 'selected-owners',
        selectedOwners: [
          { kind: 'organization', organizationId: 'org-z' },
          { kind: 'personal' },
        ],
      },
    });
    mockWorkspaceContextGetState.mockReturnValueOnce({
      context: { kind: 'personal' },
      revision: 0,
      organizations: [
        {
          id: 'org-z',
          name: 'zeta team',
          role: 'MEMBER',
        },
        {
          id: 'org-b',
          name: 'Beta team',
          role: 'MEMBER',
        },
        {
          id: 'org-a',
          name: 'Alpha team',
          role: 'MEMBER',
        },
      ],
    });
    const { context, completes, fails } = recorder();

    await handlePortalAppAdvisorSettingsGet(
      command('portal.app_advisor.settings.get', {}),
      context,
    );

    expect(fails).toEqual([]);
    expect(completes[0]?.result).toMatchObject({
      projectAgentAccess: {
        mode: 'selected-owners',
        selectedOwners: [
          { kind: 'organization', organizationId: 'org-z' },
          { kind: 'personal' },
        ],
      },
      projectAgentAccessOwnerOptions: [
        { owner: { kind: 'personal' }, label: 'Personal' },
        {
          owner: { kind: 'organization', organizationId: 'org-a' },
          label: 'Alpha team',
        },
        {
          owner: { kind: 'organization', organizationId: 'org-b' },
          label: 'Beta team',
        },
        {
          owner: { kind: 'organization', organizationId: 'org-z' },
          label: 'zeta team',
        },
      ],
    });
  });

  it('describes Agents on the default model by the default a new App Advisor chat starts on', async () => {
    // A Claude-only user whose App Advisor setting still holds the Codex seed
    // starts App Advisor chats on the chat-lane model, not on that seed.
    const catalogDefault = jest
      .spyOn(AgentDefaultModel, 'resolveCatalogAgentDefaultModel')
      .mockResolvedValue('claude-sonnet-4-6');
    try {
      const { context } = recorder();
      await handlePortalAppAdvisorSettingsGet(
        command('portal.app_advisor.settings.get', {}),
        context,
      );

      expect(catalogDefault).toHaveBeenCalledWith(APP_ADVISOR_PROJECT_ID);
      expect(mockedBuildModelCatalog).toHaveBeenCalledWith(
        'gpt-5.5',
        expect.objectContaining({ agentDefaultModel: 'claude-sonnet-4-6' }),
      );
    } finally {
      catalogDefault.mockRestore();
    }
  });

  it('persists a partial portal patch and refreshes both desktop windows', async () => {
    const { context, completes, fails } = recorder();
    await handlePortalAppAdvisorSettingsSave(
      command('portal.app_advisor.settings.save', {
        model: 'gpt-5.6-luna',
        thinkingLevel: 'xhigh',
        pluginSelections: {
          collectionIds: ['collection-1'],
          skillRefs: [],
          pluginRefs: [],
        },
        instructions: '# Replacement\n',
        archiveRetentionDays: 30,
        approvalsUpgradeNoticeDismissed: true,
      }),
      context,
    );

    expect(fails).toEqual([]);
    expect(completes).toEqual([
      {
        commandId: 'cmd-portal.app_advisor.settings.save',
        result: { ok: true },
      },
    ]);
    const updater = mockedUpdatePreferences.mock.calls[0]?.[0];
    const updated = await updater?.(await readPreferencesFile());
    expect(updated).toMatchObject({
      appAdvisorModel: 'gpt-5.6-luna',
      appAdvisorThinkingLevel: 'xhigh',
      approvalsUpgradeNoticeDismissed: true,
      appAdvisorPluginSelections: { collectionIds: ['collection-1'] },
    });
    expect(mockedSaveClaudeMd).toHaveBeenCalledWith('# Replacement\n');
    expect(mockedSaveSettings).toHaveBeenCalledWith({
      archiveRetentionDays: 30,
    });
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      mainWindow,
      IPC_CHANNELS.preferencesSynced,
      expect.any(Object),
    );
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      appAdvisorWindow,
      IPC_CHANNELS.preferencesSynced,
      expect.any(Object),
    );
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      mainWindow,
      IPC_CHANNELS.appAdvisorSettingsChanged,
      expect.objectContaining({ archiveRetentionDays: 7 }),
    );
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      appAdvisorWindow,
      IPC_CHANNELS.appAdvisorSettingsChanged,
      expect.objectContaining({ archiveRetentionDays: 7 }),
    );
    expect(mockedSetAppAdvisorProjectAgentAccess).not.toHaveBeenCalled();
  });

  it('normalizes and persists the complete project-agent access setting before applying it', async () => {
    const { context, completes, fails } = recorder();
    await handlePortalAppAdvisorSettingsSave(
      command('portal.app_advisor.settings.save', {
        projectAgentAccess: {
          mode: 'selected-owners',
          selectedOwners: [
            { kind: 'organization', organizationId: ' org-1 ' },
            { kind: 'personal' },
            { kind: 'organization', organizationId: 'org-1' },
            { kind: 'personal' },
          ],
        },
      }),
      context,
    );

    const normalizedAccess = {
      mode: 'selected-owners',
      selectedOwners: [
        { kind: 'organization', organizationId: 'org-1' },
        { kind: 'personal' },
      ],
    };
    expect(fails).toEqual([]);
    expect(completes).toEqual([
      {
        commandId: 'cmd-portal.app_advisor.settings.save',
        result: { ok: true },
      },
    ]);
    const updater = mockedUpdatePreferences.mock.calls[0]?.[0];
    expect(await updater?.(await readPreferencesFile())).toMatchObject({
      appAdvisorProjectAgentAccess: normalizedAccess,
    });
    expect(mockedSetAppAdvisorProjectAgentAccess).toHaveBeenCalledWith(
      normalizedAccess,
    );
    // Applied by the serialized commit observer, not after the write returns.
    const onCommitted = mockedUpdatePreferences.mock.calls[0]?.[1];
    expect(onCommitted).toEqual(expect.any(Function));
    mockedSetAppAdvisorProjectAgentAccess.mockClear();
    onCommitted?.({
      ...(await readPreferencesFile()),
      appAdvisorProjectAgentAccess: { mode: 'disabled', selectedOwners: [] },
    });
    expect(mockedSetAppAdvisorProjectAgentAccess).toHaveBeenCalledWith({
      mode: 'disabled',
      selectedOwners: [],
    });
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      mainWindow,
      IPC_CHANNELS.preferencesSynced,
      expect.any(Object),
    );
  });

  it('does not apply access or broadcast preferences when persistence fails', async () => {
    mockedUpdatePreferences.mockRejectedValueOnce(new Error('disk full'));
    const { context, completes, fails } = recorder();

    await handlePortalAppAdvisorSettingsSave(
      command('portal.app_advisor.settings.save', {
        projectAgentAccess: { mode: 'disabled', selectedOwners: [] },
      }),
      context,
    );

    expect(completes).toEqual([]);
    expect(fails).toHaveLength(1);
    expect(mockedSetAppAdvisorProjectAgentAccess).not.toHaveBeenCalled();
    expect(mockedSendToWindow).not.toHaveBeenCalledWith(
      mainWindow,
      IPC_CHANNELS.preferencesSynced,
      expect.anything(),
    );
  });

  it.each([
    null,
    {},
    { mode: 'unknown', selectedOwners: [] },
    { mode: 'enabled' },
    { mode: 'disabled', selectedOwners: {} },
    { mode: 'enabled', selectedOwners: [null] },
    {
      mode: 'enabled',
      selectedOwners: [{ kind: 'organization', organizationId: '  ' }],
    },
    {
      mode: 'enabled',
      selectedOwners: [{ kind: 'organization', organizationId: 42 }],
    },
    { mode: 'enabled', selectedOwners: [{ kind: 'workspace' }] },
  ])(
    'rejects malformed project-agent access %j before touching preferences',
    async (access) => {
      const { context, completes, fails } = recorder();

      await handlePortalAppAdvisorSettingsSave(
        command('portal.app_advisor.settings.save', {
          projectAgentAccess: access,
        } as PortalCommandPayloadMap['portal.app_advisor.settings.save']),
        context,
      );

      expect(completes).toEqual([]);
      expect(fails[0]).toMatchObject({ code: 'invalid_payload' });
      expect(mockedUpdatePreferences).not.toHaveBeenCalled();
      expect(mockedSetAppAdvisorProjectAgentAccess).not.toHaveBeenCalled();
    },
  );

  it('ignores read-only owner options in save payloads', async () => {
    const { context, completes, fails } = recorder();
    await handlePortalAppAdvisorSettingsSave(
      command('portal.app_advisor.settings.save', {
        projectAgentAccessOwnerOptions: [
          {
            owner: { kind: 'organization', organizationId: 'org-1' },
            label: 'Org',
          },
        ],
      } as PortalCommandPayloadMap['portal.app_advisor.settings.save']),
      context,
    );

    expect(fails).toEqual([]);
    expect(completes).toHaveLength(1);
    expect(mockedUpdatePreferences).not.toHaveBeenCalled();
    expect(mockedSetAppAdvisorProjectAgentAccess).not.toHaveBeenCalled();
  });

  it('re-projects Default-model Agent rows when the App Advisor model changes', async () => {
    const refresh = jest
      .spyOn(AgentDefaultModel, 'refreshCatalogAgentDefaults')
      .mockResolvedValue(undefined);
    try {
      const { context, fails } = recorder();
      await handlePortalAppAdvisorSettingsSave(
        command('portal.app_advisor.settings.save', {
          model: 'claude-sonnet-4-6',
        }),
        context,
      );

      expect(fails).toEqual([]);
      expect(refresh).toHaveBeenCalledWith(
        expect.objectContaining({ appAdvisorModel: 'claude-sonnet-4-6' }),
      );
    } finally {
      refresh.mockRestore();
    }
  });

  it('rejects invalid retention values before touching disk', async () => {
    const { context, completes, fails } = recorder();
    await handlePortalAppAdvisorSettingsSave(
      command('portal.app_advisor.settings.save', {
        archiveRetentionDays: -1,
      }),
      context,
    );

    expect(completes).toEqual([]);
    expect(fails[0]).toMatchObject({ code: 'invalid_payload' });
    expect(mockedSaveSettings).not.toHaveBeenCalled();
  });
});

describe('portal.app_advisor.send', () => {
  it('keeps the route a chat holds when the send names its Default-model Agent', async () => {
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
        createdAt: '2026-10-14T00:00:00.000Z',
        updatedAt: '2026-10-14T00:00:00.000Z',
        available: true,
      },
    ]);
    mockedReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat-1',
      tabs: [
        {
          id: 'chat-1',
          title: 'Existing advisor',
          createdAt: '2026-08-26T00:00:00.000Z',
          messages: [],
          kind: 'chat',
          model: 'agent_model_inherit@gpt-5.5',
          providerType: 'codex',
        },
      ],
    });
    const { context, fails } = recorder();
    await handlePortalAppAdvisorSend(
      command('portal.app_advisor.send', {
        text: 'Continue',
        chatId: 'chat-1',
        model: 'agent_model_inherit',
      }),
      context,
    );

    expect(fails).toEqual([]);
    expect(mockedSendWorktreeChatMessage.mock.calls[0]?.[0]).toMatchObject({
      model: 'agent_model_inherit@gpt-5.5',
      providerType: 'codex',
    });
  });

  it.each([undefined, 'cursor'] as const)(
    'dispatches a Cursor App Advisor send when the runtime is connected (provider %s)',
    async (providerType) => {
      const { context, completes, fails } = recorder();
      await handlePortalAppAdvisorSend(
        command('portal.app_advisor.send', {
          text: 'Fresh chat',
          model: 'cursor-default',
          ...(providerType ? { providerType } : {}),
        }),
        context,
      );
      expect(fails).toEqual([]);
      expect(mockedSendWorktreeChatMessage.mock.calls[0]?.[0]).toMatchObject({
        model: 'cursor-default',
        providerType: 'cursor',
      });
      expect(completes).toHaveLength(1);
    },
  );

  it('checks the saved Cursor default before minting an entry for a send with no model', async () => {
    const base = await readPreferencesFile();
    mockedReadPreferences.mockResolvedValue({
      ...base,
      appAdvisorModel: 'cursor-default',
    });
    mockIsCursorRuntimeAvailable.mockResolvedValue(false);
    const { context, fails } = recorder();
    await handlePortalAppAdvisorSend(
      command('portal.app_advisor.send', { text: 'Fresh chat' }),
      context,
    );
    expect(fails).toEqual([
      expect.objectContaining({
        code: 'invalid_payload',
        message: 'Connect Cursor in the desktop app to use it here.',
      }),
    ]);
    expect(mockedCreateWorkEntry).not.toHaveBeenCalled();
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
    // Connected, the same send mints the entry and lets the chat service
    // resolve the default.
    mockIsCursorRuntimeAvailable.mockResolvedValue(true);
    const connected = recorder();
    await handlePortalAppAdvisorSend(
      command('portal.app_advisor.send', { text: 'Fresh chat' }),
      connected.context,
    );
    expect(connected.fails).toEqual([]);
    expect(mockedCreateWorkEntry).toHaveBeenCalled();
  });

  it('fails a Cursor App Advisor send with connect guidance while the runtime is unavailable', async () => {
    mockIsCursorRuntimeAvailable.mockResolvedValueOnce(false);
    const { context, fails } = recorder();
    await handlePortalAppAdvisorSend(
      command('portal.app_advisor.send', {
        text: 'Fresh chat',
        model: 'cursor-default',
      }),
      context,
    );
    expect(fails).toEqual([
      expect.objectContaining({
        code: 'invalid_payload',
        message: 'Connect Cursor in the desktop app to use it here.',
      }),
    ]);
    expect(mockedCreateWorkEntry).not.toHaveBeenCalled();
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
  });
  it('fails a Copilot App Advisor send with connect guidance while the runtime is unavailable', async () => {
    mockIsCopilotRuntimeAvailable.mockResolvedValueOnce(false);
    const { context, fails } = recorder();
    await handlePortalAppAdvisorSend(
      command('portal.app_advisor.send', {
        text: 'Fresh chat',
        model: 'copilot:fixture',
      }),
      context,
    );
    expect(fails).toEqual([
      expect.objectContaining({
        code: 'invalid_payload',
        message: 'Connect Copilot in the desktop app to use it here.',
      }),
    ]);
    expect(mockedCreateWorkEntry).not.toHaveBeenCalled();
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it.each([
    { model: 'copilot:fixture' },
    { model: 'removed-copilot-model', providerType: 'copilot' as const },
  ])(
    'rejects a disconnected stored Copilot follow-up before persistence: %j',
    async (provider) => {
      mockIsCopilotRuntimeAvailable.mockResolvedValue(false);
      mockedReadChatTabsFile.mockResolvedValue({
        version: 1,
        activeTabId: 'chat-1',
        tabs: [
          {
            id: 'chat-1',
            title: 'Chat',
            createdAt: '',
            messages: [],
            ...provider,
          },
        ],
      });
      const { context, fails } = recorder();
      await handlePortalAppAdvisorSend(
        command('portal.app_advisor.send', {
          chatId: 'chat-1',
          workEntryId: 'entry-1',
          text: 'Continue',
        }),
        context,
      );
      expect(fails).toEqual([
        expect.objectContaining({
          code: 'invalid_payload',
          message: 'Connect Copilot in the desktop app to use it here.',
        }),
      ]);
      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
      expect(mockedCreateWorkEntry).not.toHaveBeenCalled();
    },
  );

  it('dispatches into the resolved Work Entry with the sentinel routing', async () => {
    const { context, completes, fails } = recorder();
    await handlePortalAppAdvisorSend(
      command('portal.app_advisor.send', {
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Hello',
        model: 'gpt-5.5',
        providerType: 'codex',
        inputMode: 'typed',
      }),
      context,
    );

    expect(fails).toHaveLength(0);
    expect(mockedResolveWorkEntryForChat).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      'chat-1',
    );
    expect(mockedCreateWorkEntry).not.toHaveBeenCalled();
    const [request, options] =
      mockedSendWorktreeChatMessage.mock.calls[0] ?? [];
    expect(request).toEqual({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-1',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Hello',
      model: 'gpt-5.5',
      providerType: 'codex',
      inputMode: 'typed',
    });
    expect(options?.appAdvisorSurfaces?.getAppAdvisorWindow()).toBe(
      appAdvisorWindow,
    );
    expect(completes).toEqual([
      {
        commandId: 'cmd-portal.app_advisor.send',
        result: { ok: true, chatId: 'chat-1' },
      },
    ]);
  });

  it('mints a Work Entry keyed on the new chat id when chatId is omitted', async () => {
    const { context, fails } = recorder();
    await handlePortalAppAdvisorSend(
      command('portal.app_advisor.send', { text: 'Fresh chat' }),
      context,
    );

    expect(fails).toHaveLength(0);
    const mintedId = mockedCreateWorkEntry.mock.calls[0]?.[1]?.id;
    expect(mintedId).toEqual(expect.any(String));
    const request = mockedSendWorktreeChatMessage.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      worktreeId: mintedId,
      chatId: mintedId,
      text: 'Fresh chat',
    });
    expect(request?.userMessageId).toEqual(expect.any(String));
  });

  it('starts a first chat inside the selected Work Entry instead of minting a sibling entry', async () => {
    const { context, fails } = recorder();
    await handlePortalAppAdvisorSend(
      command('portal.app_advisor.send', {
        workEntryId: 'entry-1',
        text: 'Fresh sub-chat',
      }),
      context,
    );

    expect(fails).toHaveLength(0);
    expect(mockedCreateWorkEntry).not.toHaveBeenCalled();
    expect(mockedSendWorktreeChatMessage.mock.calls[0]?.[0]).toMatchObject({
      worktreeId: 'entry-1',
      text: 'Fresh sub-chat',
    });
  });

  it('mints a fresh entry when the chat only exists in an archive', async () => {
    mockedResolveWorkEntryForChat.mockResolvedValue({
      entryId: null,
      archivedInEntryId: 'entry-old',
    });
    const { context, fails } = recorder();
    await handlePortalAppAdvisorSend(
      command('portal.app_advisor.send', { chatId: 'chat-9', text: 'Hi' }),
      context,
    );

    expect(fails).toHaveLength(0);
    expect(mockedCreateWorkEntry).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      expect.objectContaining({ id: 'chat-9' }),
    );
  });

  it('fails retryable when no App Advisor surfaces are registered', async () => {
    setPortalAppAdvisorSurfaces(null);
    const { context, fails } = recorder();
    await handlePortalAppAdvisorSend(
      command('portal.app_advisor.send', { text: 'Hello' }),
      context,
    );

    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
    expect(fails).toEqual([
      expect.objectContaining({ code: 'execution_failed', retryable: true }),
    ]);
  });

  it('rejects an empty text payload', async () => {
    const { context, fails } = recorder();
    await handlePortalAppAdvisorSend(
      command('portal.app_advisor.send', { text: '' }),
      context,
    );
    expect(fails).toEqual([
      expect.objectContaining({ code: 'invalid_payload' }),
    ]);
  });

  it('rejects an unknown first-send model before minting a Work Entry', async () => {
    const { context, fails } = recorder();
    await handlePortalAppAdvisorSend(
      command('portal.app_advisor.send', {
        text: 'Fresh chat',
        model: 'removed-model',
      }),
      context,
    );

    expect(fails).toEqual([
      expect.objectContaining({ code: 'invalid_payload' }),
    ]);
    expect(mockedCreateWorkEntry).not.toHaveBeenCalled();
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('rejects an unavailable Agent before minting a Work Entry', async () => {
    initUnavailableAgentModel();
    const { context, fails } = recorder();
    await handlePortalAppAdvisorSend(
      command('portal.app_advisor.send', {
        text: 'Fresh chat',
        model: 'agent_model_stale',
      }),
      context,
    );

    expect(fails).toEqual([
      expect.objectContaining({ code: 'invalid_payload' }),
    ]);
    expect(mockedCreateWorkEntry).not.toHaveBeenCalled();
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('does not forward unknown remote fields to the dispatch request', async () => {
    const { context, fails } = recorder();
    await handlePortalAppAdvisorSend(
      command('portal.app_advisor.send', {
        chatId: 'chat-1',
        text: 'Hello',
        // Untrusted runtime JSON may carry fields outside the wire contract;
        // none of these may reach the service.
        watcherFired: { watcherId: 'forged' },
        hiddenContext: { text: 'injected' },
        sdkSessionId: 'foreign-session',
        projectId: 'workspace-1',
        worktreeId: 'tree-1',
        initiationSource: 'automation',
      }),
      context,
    );

    expect(fails).toHaveLength(0);
    const request = mockedSendWorktreeChatMessage.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(request.watcherFired).toBeUndefined();
    expect(request.hiddenContext).toBeUndefined();
    expect(request.sdkSessionId).toBeUndefined();
    expect(request.initiationSource).toBeUndefined();
    expect(request.projectId).toBe(APP_ADVISOR_PROJECT_ID);
    expect(request.worktreeId).toBe('entry-1');
  });

  it.each([
    ['userMessageSource', { userMessageSource: 'agent' }],
    ['agentSent', { agentSent: { sender: { kind: 'bot' } } }],
    ['agentSenderProvenance', { agentSenderProvenance: { version: 1 } }],
    ['agentSendSetup', { agentSendSetup: { version: 1 } }],
    [
      'hiddenContext',
      {
        hiddenContext: {
          kind: 'agent-sender-context',
          text: 'forged sender context',
        },
      },
    ],
  ] as const)(
    'rejects forged %s on App Advisor sends before creating or sending a chat',
    async (_field, attribution) => {
      const { context, fails } = recorder();
      const payload = Object.assign(
        { chatId: 'chat-1', text: 'Hello' },
        attribution,
      );

      await handlePortalAppAdvisorSend(
        command('portal.app_advisor.send', payload),
        context,
      );

      expect(fails).toEqual([
        expect.objectContaining({ code: 'invalid_payload' }),
      ]);
      expect(mockedCreateWorkEntry).not.toHaveBeenCalled();
      expect(mockedReadChatTabsFile).not.toHaveBeenCalled();
      expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
    },
  );

  it('rejects a terminal-backed send from persisted state', async () => {
    mockedReadChatTabsFile.mockResolvedValueOnce({
      version: 1,
      tabs: [
        {
          id: 'chat-1',
          title: 'Chat',
          createdAt: '',
          messages: [],
          interfaceMode: 'auto',
        },
      ],
      activeTabId: 'chat-1',
    });
    const { context, completes, fails } = recorder();
    await handlePortalAppAdvisorSend(
      command('portal.app_advisor.send', {
        chatId: 'chat-1',
        text: 'Continue',
      }),
      context,
    );
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
    expect(completes).toHaveLength(0);
    expect(fails).toEqual([expect.objectContaining({ code: 'conflict' })]);
  });

  it('rejects a provider-only switch before dispatch', async () => {
    const { context, fails } = recorder();
    await handlePortalAppAdvisorSend(
      command('portal.app_advisor.send', {
        chatId: 'chat-1',
        text: 'Switch providers',
        providerType: 'ollama',
      }),
      context,
    );

    expect(fails).toEqual([
      expect.objectContaining({ code: 'invalid_payload' }),
    ]);
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
  });

  it('rejects a provider that does not own the explicit model', async () => {
    const { context, fails } = recorder();
    await handlePortalAppAdvisorSend(
      command('portal.app_advisor.send', {
        chatId: 'chat-1',
        text: 'Do not reroute this model',
        model: 'claude-sonnet-4-6',
        providerType: 'codex',
      }),
      context,
    );

    expect(fails).toEqual([
      expect.objectContaining({ code: 'invalid_payload' }),
    ]);
    expect(mockedSendWorktreeChatMessage).not.toHaveBeenCalled();
  });
});

describe('portal.app_advisor.set_model', () => {
  it('applies a Cursor model change through the desktop path when the runtime is connected', async () => {
    mockedReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat-1',
      tabs: [
        {
          id: 'chat-1',
          title: 'Existing advisor',
          createdAt: '2026-08-26T00:00:00.000Z',
          messages: [],
          kind: 'chat',
        },
      ],
    });
    const { context, fails } = recorder();
    await handlePortalAppAdvisorSetModel(
      command('portal.app_advisor.set_model', {
        chatId: 'chat-1',
        model: 'cursor-default',
      }),
      context,
    );
    expect(fails).toEqual([]);
    expect(mockedChangeChatModel).toHaveBeenCalledWith({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-1',
      chatId: 'chat-1',
      model: 'cursor-default',
    });
  });
  it('applies a Copilot model change through the desktop path when the runtime is connected', async () => {
    mockedReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat-1',
      tabs: [
        {
          id: 'chat-1',
          title: 'Existing advisor',
          createdAt: '2026-08-26T00:00:00.000Z',
          messages: [],
          kind: 'chat',
        },
      ],
    });
    const { context, fails } = recorder();
    await handlePortalAppAdvisorSetModel(
      command('portal.app_advisor.set_model', {
        chatId: 'chat-1',
        model: 'copilot:fixture',
      }),
      context,
    );
    expect(fails).toEqual([]);
    expect(mockedChangeChatModel).toHaveBeenCalledWith({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-1',
      chatId: 'chat-1',
      model: 'copilot:fixture',
    });
  });

  it('fails a Cursor model change with connect guidance while the runtime is unavailable', async () => {
    mockIsCursorRuntimeAvailable.mockResolvedValueOnce(false);
    const { context, fails } = recorder();
    await handlePortalAppAdvisorSetModel(
      command('portal.app_advisor.set_model', {
        chatId: 'chat-1',
        model: 'cursor-default',
      }),
      context,
    );
    expect(fails).toEqual([
      expect.objectContaining({
        code: 'invalid_payload',
        message: 'Connect Cursor in the desktop app to use it here.',
      }),
    ]);
    expect(mockedChangeChatModel).not.toHaveBeenCalled();
  });
  it('fails a Copilot model change with connect guidance while the runtime is unavailable', async () => {
    mockIsCopilotRuntimeAvailable.mockResolvedValueOnce(false);
    const { context, fails } = recorder();
    await handlePortalAppAdvisorSetModel(
      command('portal.app_advisor.set_model', {
        chatId: 'chat-1',
        model: 'copilot:fixture',
      }),
      context,
    );
    expect(fails).toEqual([
      expect.objectContaining({
        code: 'invalid_payload',
        message: 'Connect Copilot in the desktop app to use it here.',
      }),
    ]);
    expect(mockedChangeChatModel).not.toHaveBeenCalled();
  });

  it('applies the desktop model-change path and re-projects the summary', async () => {
    mockedReadChatTabsFile.mockResolvedValueOnce({
      version: 1,
      tabs: [
        {
          id: 'chat-1',
          title: 'Storage',
          createdAt: '2026-08-26T00:00:00.000Z',
          messages: [],
          kind: 'chat',
        },
      ],
      activeTabId: 'chat-1',
    });
    const { context, completes, fails } = recorder();
    await handlePortalAppAdvisorSetModel(
      command('portal.app_advisor.set_model', {
        chatId: 'chat-1',
        model: 'gpt-5.6-sol',
      }),
      context,
    );

    expect(fails).toHaveLength(0);
    expect(mockedChangeChatModel).toHaveBeenCalledWith({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-1',
      chatId: 'chat-1',
      model: 'gpt-5.6-sol',
    });
    expect(mockedProjectSummaries).toHaveBeenCalledWith('entry-1');
    expect(completes).toEqual([
      expect.objectContaining({ result: { ok: true } }),
    ]);
  });

  it.each([0, 1])(
    'uses native message counts for the model harness lock (%i messages)',
    async (messageCount) => {
      mockedReadChatTabsFile.mockResolvedValueOnce({
        version: 1,
        activeTabId: 'chat-1',
        tabs: [
          {
            id: 'chat-1',
            title: 'Native chat',
            createdAt: '2026-08-26T00:00:00.000Z',
            kind: 'chat',
            model: 'gpt-5.6-sol',
            providerType: 'codex',
            executionHarness: 'codex',
            transcript: {
              format: 'complete-message-jsonl-v1',
              committedMessageCount: messageCount,
              committedByteLength: messageCount * 100,
              transcriptRevision: messageCount,
              hasActiveSidecar: false,
              messageCount,
            },
            get messages(): never {
              throw new Error('Transcript body is not loaded');
            },
          },
        ],
      });
      const { context, completes, fails } = recorder();
      await handlePortalAppAdvisorSetModel(
        command('portal.app_advisor.set_model', {
          chatId: 'chat-1',
          model: 'gpt-5.6-sol',
        }),
        context,
      );
      expect(fails).toEqual([]);
      expect(completes).toHaveLength(1);
      expect(mockedChangeChatModel).toHaveBeenCalledWith({
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-1',
        chatId: 'chat-1',
        model: 'gpt-5.6-sol',
        ...(messageCount ? { lockedHarness: 'codex' } : {}),
      });
    },
  );

  it('refuses a model change rejected by the desktop harness lock', async () => {
    mockedReadChatTabsFile.mockResolvedValueOnce({
      version: 1,
      tabs: [
        {
          id: 'chat-1',
          title: 'Storage',
          createdAt: '2026-08-26T00:00:00.000Z',
          messages: [{ id: 'm1', role: 'user', timestamp: 1, blocks: [] }],
          kind: 'chat',
          model: 'claude-sonnet-4-6',
          providerType: 'claude',
          executionHarness: 'claude',
        },
      ],
      activeTabId: 'chat-1',
    });
    mockedChangeChatModel.mockResolvedValueOnce(false);
    const { context, completes, fails } = recorder();
    await handlePortalAppAdvisorSetModel(
      command('portal.app_advisor.set_model', {
        chatId: 'chat-1',
        model: 'gpt-5.6-sol',
      }),
      context,
    );

    expect(completes).toHaveLength(0);
    expect(fails).toEqual([expect.objectContaining({ code: 'conflict' })]);
    expect(mockedChangeChatModel).toHaveBeenCalledWith(
      expect.objectContaining({ lockedHarness: 'claude' }),
    );
  });

  it('keeps a portal-originated Claude selection on the native interface', async () => {
    mockedReadChatTabsFile.mockResolvedValueOnce({
      version: 1,
      tabs: [
        {
          id: 'chat-1',
          title: 'Storage',
          createdAt: '2026-08-26T00:00:00.000Z',
          messages: [],
          kind: 'chat',
          providerType: 'codex',
        },
      ],
      activeTabId: 'chat-1',
    });
    const { context, fails } = recorder();

    await handlePortalAppAdvisorSetModel(
      command('portal.app_advisor.set_model', {
        chatId: 'chat-1',
        model: 'claude-sonnet-4-6',
      }),
      context,
    );

    expect(fails).toHaveLength(0);
    expect(mockedChangeChatModel).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-4-6' }),
      undefined,
      { interfaceModeOverride: 'canopy' },
    );
  });

  it('keeps a Default-model Agent on the native interface when the default is Claude', async () => {
    initAgentModels([
      {
        id: 'agent_model_follows_default',
        name: 'Follows Default',
        baseModel: 'default',
        instructions: '',
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
        },
        createdAt: '2026-08-26T00:00:00.000Z',
        updatedAt: '2026-08-26T00:00:00.000Z',
        available: true,
      },
    ]);
    mockedReadPreferences.mockResolvedValue(
      partialPreferences({ appAdvisorModel: 'claude-sonnet-4-6' }),
    );
    mockedReadChatTabsFile.mockResolvedValueOnce({
      version: 1,
      tabs: [
        {
          id: 'chat-1',
          title: 'Storage',
          createdAt: '2026-08-26T00:00:00.000Z',
          messages: [],
          kind: 'chat',
          providerType: 'codex',
        },
      ],
      activeTabId: 'chat-1',
    });
    const { context, fails } = recorder();

    await handlePortalAppAdvisorSetModel(
      command('portal.app_advisor.set_model', {
        chatId: 'chat-1',
        model: 'agent_model_follows_default',
      }),
      context,
    );

    expect(fails).toHaveLength(0);
    expect(mockedChangeChatModel).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'agent_model_follows_default@claude-sonnet-4-6',
      }),
      undefined,
      { interfaceModeOverride: 'canopy' },
    );
  });

  it('does not invent a Claude lock for a started providerless chat', async () => {
    mockedReadChatTabsFile.mockResolvedValueOnce({
      version: 1,
      tabs: [
        {
          id: 'chat-1',
          title: 'Storage',
          createdAt: '2026-08-26T00:00:00.000Z',
          messages: [{ id: 'm1', role: 'user', timestamp: 1, blocks: [] }],
          kind: 'chat',
        },
      ],
      activeTabId: 'chat-1',
    });
    const { context, fails } = recorder();

    await handlePortalAppAdvisorSetModel(
      command('portal.app_advisor.set_model', {
        chatId: 'chat-1',
        model: 'gpt-5.6-sol',
      }),
      context,
    );

    expect(fails).toHaveLength(0);
    expect(mockedChangeChatModel).toHaveBeenCalledWith({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-1',
      chatId: 'chat-1',
      model: 'gpt-5.6-sol',
    });
  });

  it('rejects a model change for a read-only chat', async () => {
    mockedReadChatTabsFile.mockResolvedValueOnce({
      version: 1,
      tabs: [
        {
          id: 'chat-1',
          title: 'Restored chat',
          createdAt: '2026-08-26T00:00:00.000Z',
          messages: [],
          kind: 'chat',
          readOnly: true,
        },
      ],
      activeTabId: 'chat-1',
    });
    const { context, completes, fails } = recorder();

    await handlePortalAppAdvisorSetModel(
      command('portal.app_advisor.set_model', {
        chatId: 'chat-1',
        model: 'gpt-5.6-sol',
      }),
      context,
    );

    expect(mockedChangeChatModel).not.toHaveBeenCalled();
    expect(completes).toHaveLength(0);
    expect(fails).toEqual([expect.objectContaining({ code: 'conflict' })]);
  });

  it('rejects a model change while a managed App Advisor terminal is active', async () => {
    mockedReadChatTabsFile.mockResolvedValueOnce({
      version: 1,
      tabs: [
        {
          id: 'chat-1',
          title: 'Storage',
          createdAt: '2026-08-26T00:00:00.000Z',
          messages: [],
          kind: 'chat',
          model: 'claude-sonnet-4-6',
          providerType: 'claude',
          interfaceMode: 'auto',
        },
      ],
      activeTabId: 'chat-1',
    });
    mockClaudeTerminalGetState.mockReturnValue({
      terminalId: 'terminal-1',
      turnState: 'idle',
    });
    const { context, completes, fails } = recorder();
    await handlePortalAppAdvisorSetModel(
      command('portal.app_advisor.set_model', {
        chatId: 'chat-1',
        model: 'gpt-5.6-sol',
      }),
      context,
    );

    expect(mockedChangeChatModel).not.toHaveBeenCalled();
    expect(completes).toHaveLength(0);
    expect(fails).toEqual([expect.objectContaining({ code: 'conflict' })]);
  });
});

describe('portal.app_advisor.cancel', () => {
  it('cancels the resolved chat and emits the synthetic un-stream event', async () => {
    appAdvisorSyntheticFence.isCurrent.mockReturnValue(false);
    mockCancelWorktreeChat.mockResolvedValueOnce({ ok: true });
    const { context, completes, fails } = recorder();
    await handlePortalAppAdvisorCancel(
      command('portal.app_advisor.cancel', { chatId: 'chat-1' }),
      context,
    );

    expect(fails).toHaveLength(0);
    expect(mockedCancelWorktreeChat.mock.calls[0]?.[0]).toEqual({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-1',
      chatId: 'chat-1',
    });
    expect(mockedCancelWorktreeChat.mock.calls[0]?.[1]).toBe(
      advisorStopContext,
    );
    expect(mockCaptureAppAdvisorSyntheticResultFence).toHaveBeenCalledWith(
      'chat-1',
    );
    expect(
      mockCaptureAppAdvisorSyntheticResultFence.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockedResolveWorkEntryForChat.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    expect(
      mockCaptureAppAdvisorSyntheticResultFence.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockedCancelWorktreeChat.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    expect(mockEmitSyntheticResultEvent).toHaveBeenCalledWith(
      'chat-1',
      expect.any(Object),
      expect.objectContaining({
        fence: appAdvisorSyntheticFence,
        userMessageId: 'advisor-user-message',
      }),
    );
    const emittedOptions = mockEmitSyntheticResultEvent.mock.calls[0]?.[2];
    if (!isRecord(emittedOptions)) {
      throw new Error('Expected Advisor cancellation guard options');
    }
    const isCurrent = emittedOptions['isCurrent'];
    if (!isBooleanPredicate(isCurrent)) {
      throw new Error('Expected Advisor cancellation current-turn guard');
    }
    expect(isCurrent()).toBe(true);
    const emitArgs = mockedEmitSyntheticResult.mock.calls[0];
    expect(emitArgs?.[0]).toBe('chat-1');
    expect(emitArgs?.[1]?.getAppAdvisorWindow()).toBe(appAdvisorWindow);
    expect(completes).toEqual([
      expect.objectContaining({ result: { ok: true } }),
    ]);
  });

  it('does not retarget an Advisor Stop after Work Entry resolution yields', async () => {
    const resolution = deferred<{
      entryId: string | null;
      archivedInEntryId: null;
    }>();
    mockedResolveWorkEntryForChat.mockReturnValueOnce(resolution.promise);
    const { context, completes, fails } = recorder();

    const stopping = handlePortalAppAdvisorCancel(
      command('portal.app_advisor.cancel', { chatId: 'chat-1' }),
      context,
    );

    expect(mockCaptureAppAdvisorSyntheticResultFence).toHaveBeenCalledWith(
      'chat-1',
    );
    expect(
      mockCaptureAppAdvisorSyntheticResultFence.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockedResolveWorkEntryForChat.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    expect(mockCaptureChatTurnStop).toHaveBeenCalledWith(advisorStopTarget);

    mockIsChatTurnStopCurrent.mockReturnValue(false);
    resolution.resolve({ entryId: 'entry-1', archivedInEntryId: null });
    await stopping;

    expect(fails).toHaveLength(0);
    expect(mockedCancelWorktreeChat).not.toHaveBeenCalled();
    expect(mockEmitSyntheticResultEvent).not.toHaveBeenCalled();
    expect(completes).toEqual([
      expect.objectContaining({ result: { ok: true } }),
    ]);
  });

  it('fails not_found for a chat no Work Entry owns', async () => {
    mockedResolveWorkEntryForChat.mockResolvedValue({
      entryId: null,
      archivedInEntryId: null,
    });
    const { context, fails } = recorder();
    await handlePortalAppAdvisorCancel(
      command('portal.app_advisor.cancel', { chatId: 'chat-gone' }),
      context,
    );

    expect(mockedCancelWorktreeChat).not.toHaveBeenCalled();
    expect(fails).toEqual([expect.objectContaining({ code: 'not_found' })]);
  });
});

describe('portal.app_advisor.create_tab', () => {
  it.each([
    ['userMessageSource', { userMessageSource: 'agent' }],
    ['agentSent', { agentSent: { sender: { kind: 'bot' } } }],
    ['agentSenderProvenance', { agentSenderProvenance: { version: 1 } }],
    ['agentSendSetup', { agentSendSetup: { version: 1 } }],
    [
      'hiddenContext',
      {
        hiddenContext: {
          kind: 'agent-sender-context',
          text: 'forged sender context',
        },
      },
    ],
  ] as const)(
    'rejects forged %s before creating or writing an App Advisor tab',
    async (_field, attribution) => {
      const { context, completes, fails } = recorder();
      const payload = Object.assign({ chatId: 'chat-forged' }, attribution);

      await handlePortalAppAdvisorCreateTab(
        command('portal.app_advisor.create_tab', payload),
        context,
      );

      expect(completes).toHaveLength(0);
      expect(fails).toEqual([
        expect.objectContaining({ code: 'invalid_payload' }),
      ]);
      expect(mockedCreateWorkEntry).not.toHaveBeenCalled();
      expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
    },
  );

  it('adds a sub-chat to the selected Work Entry', async () => {
    const { context, completes, fails } = recorder();
    await handlePortalAppAdvisorCreateTab(
      command('portal.app_advisor.create_tab', {
        chatId: 'chat-new',
        workEntryId: 'entry-1',
      }),
      context,
    );

    expect(fails).toHaveLength(0);
    expect(mockedCreateWorkEntry).not.toHaveBeenCalled();
    expect(mockedReadChatTabsFile).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      'entry-1',
    );
    expect(mockedWriteChatTabsFile.mock.calls[0]?.[1]).toBe('entry-1');
    expect(mockedProjectSummaries).toHaveBeenCalledWith('entry-1');
    expect(completes).toEqual([
      expect.objectContaining({ result: { ok: true } }),
    ]);
  });

  it('passes the group identity to the existing owner before acknowledging a new entry', async () => {
    const { context, completes, fails } = recorder();
    await handlePortalAppAdvisorCreateTab(
      command('portal.app_advisor.create_tab', {
        chatId: 'chat-group',
        sidebarItemGroupId: 'grp-work',
      }),
      context,
    );
    expect(fails).toHaveLength(0);
    expect(mockedCreateWorkEntry).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      expect.objectContaining({
        id: 'chat-group',
        sidebarItemGroupId: 'grp-work',
      }),
    );
    expect(completes).toHaveLength(1);
  });
  it('rejects an invalid group or a group on an existing sub-chat before writing', async () => {
    for (const payload of [
      { chatId: 'chat-group', sidebarItemGroupId: '../group' },
      {
        chatId: 'chat-group',
        workEntryId: 'entry-1',
        sidebarItemGroupId: 'grp-work',
      },
    ]) {
      const { context, completes, fails } = recorder();
      await handlePortalAppAdvisorCreateTab(
        command('portal.app_advisor.create_tab', payload),
        context,
      );
      expect(completes).toHaveLength(0);
      expect(fails).toHaveLength(1);
    }
    expect(mockedCreateWorkEntry).not.toHaveBeenCalled();
    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
  });

  it('mints the entry, seeds the tab, notifies both windows, and projects', async () => {
    const { context, completes, fails } = recorder();
    await handlePortalAppAdvisorCreateTab(
      command('portal.app_advisor.create_tab', { chatId: 'chat-new' }),
      context,
    );

    expect(fails).toHaveLength(0);
    expect(mockedCreateWorkEntry).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      expect.objectContaining({ id: 'chat-new' }),
    );
    const written = mockedWriteChatTabsFile.mock.calls[0];
    expect(written?.[0]).toBe(APP_ADVISOR_PROJECT_ID);
    expect(written?.[1]).toBe('chat-new');
    expect(written?.[2]).toMatchObject({
      activeTabId: 'chat-new',
      tabs: [expect.objectContaining({ id: 'chat-new', messages: [] })],
    });
    const tabStartedSends = mockedSendToWindow.mock.calls.filter(
      (call) => call[1] === IPC_CHANNELS.chatHookTabStarted,
    );
    expect(tabStartedSends.map((call) => call[0])).toEqual([
      mainWindow,
      appAdvisorWindow,
    ]);
    expect(tabStartedSends[0]?.[2]).toMatchObject({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'chat-new',
      chatId: 'chat-new',
      activateTab: false,
    });
    expect(mockedProjectSummaries).toHaveBeenCalledWith('chat-new');
    expect(completes).toEqual([
      expect.objectContaining({ result: { ok: true } }),
    ]);
  });

  it('is idempotent for an already-persisted tab', async () => {
    mockedReadChatTabsFile.mockResolvedValue({
      version: 1,
      tabs: [
        {
          id: 'chat-new',
          title: 'Existing',
          createdAt: '2026-08-26T00:00:00.000Z',
          messages: [],
          kind: 'chat',
        },
      ],
      activeTabId: 'chat-new',
    });
    const { context, completes } = recorder();
    await handlePortalAppAdvisorCreateTab(
      command('portal.app_advisor.create_tab', { chatId: 'chat-new' }),
      context,
    );

    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
    expect(completes).toEqual([
      expect.objectContaining({ result: { ok: true } }),
    ]);
  });
});

describe('portal.app_advisor.answer_question / dismiss_question', () => {
  it('settles an awaiting question with the first mapped answer', () => {
    mockedCompleteAskUser.mockReturnValue(true);
    const { context, completes, fails } = recorder();
    handlePortalAppAdvisorAnswerQuestion(
      command('portal.app_advisor.answer_question', {
        chatId: 'chat-1',
        requestId: 'request-1',
        answers: [
          {
            question: 'Deploy?',
            selectedOptions: ['Yes'],
            freeformText: 'ship it',
          },
        ],
      }),
      context,
    );

    expect(fails).toHaveLength(0);
    // The chat binding is forwarded so the settlement API can refuse a
    // cross-chat spoof (the binding itself is enforced there).
    expect(mockedCompleteAskUser).toHaveBeenCalledWith('request-1', 'chat-1', {
      question: 'Deploy?',
      selectedOptions: ['Yes'],
      freeformText: 'ship it',
    });
    // The desktop's own question card is dismissed after remote settlement.
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      appAdvisorWindow,
      IPC_CHANNELS.appAdvisorToolRequestCancelled,
      { requestId: 'request-1' },
    );
    expect(completes).toEqual([
      expect.objectContaining({ result: { ok: true } }),
    ]);
  });

  it('fails not_found when the request is no longer pending', () => {
    mockedCompleteAskUser.mockReturnValue(false);
    const { context, completes, fails } = recorder();
    handlePortalAppAdvisorAnswerQuestion(
      command('portal.app_advisor.answer_question', {
        chatId: 'chat-1',
        requestId: 'request-gone',
        answers: [{ question: 'Deploy?', selectedOptions: ['Yes'] }],
      }),
      context,
    );

    expect(completes).toHaveLength(0);
    expect(fails).toEqual([expect.objectContaining({ code: 'not_found' })]);
  });

  it('rejects a malformed answers array', () => {
    const { context, fails } = recorder();
    const answers: unknown = [{ question: 42, selectedOptions: 'Yes' }];
    handlePortalAppAdvisorAnswerQuestion(
      command('portal.app_advisor.answer_question', {
        chatId: 'chat-1',
        requestId: 'request-1',
        answers,
      } as PortalCommandPayloadMap['portal.app_advisor.answer_question']),
      context,
    );

    expect(mockedCompleteAskUser).not.toHaveBeenCalled();
    expect(fails).toEqual([
      expect.objectContaining({ code: 'invalid_payload' }),
    ]);
  });

  it('settles a dismissal with a null answer', () => {
    mockedCompleteAskUser.mockReturnValue(true);
    const { context, completes } = recorder();
    handlePortalAppAdvisorDismissQuestion(
      command('portal.app_advisor.dismiss_question', {
        chatId: 'chat-1',
        requestId: 'request-1',
      }),
      context,
    );

    expect(mockedCompleteAskUser).toHaveBeenCalledWith(
      'request-1',
      'chat-1',
      null,
    );
    expect(completes).toEqual([
      expect.objectContaining({ result: { ok: true } }),
    ]);
  });
});
