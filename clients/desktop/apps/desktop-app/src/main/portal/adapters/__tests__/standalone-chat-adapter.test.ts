import { toOpenCodeModelId } from '@canopy/desktop-shared/lib/opencode-models';
import type {
  AgentModelConfig,
  PortalCommandEnvelope,
  PortalCommandPayloadMap,
} from '@canopy/desktop-shared/types';
import type { ExternalAgentSender } from '@canopy/protocol/portal';
import { mergeAgentModelConfig } from '@canopy/desktop-shared/lib/codex-speed';
import {
  resolveStandaloneChatPolicyModels,
  sendStandaloneChatMessage,
  setStandaloneChatModel,
  createStandaloneChatTab,
} from '../../../services/standalone-chat-service';
import { handlePortalChatMarkRead } from '../chat-read-adapter';
import {
  resolveStandaloneChatTarget,
  emitStandaloneChatSummary,
} from '../../../services/standalone-chat-service';
import type { ChatStateCommandPort } from '@canopy/desktop-shared/types';
import {
  handlePortalStandaloneChatSend,
  handlePortalStandaloneChatCreate,
  handlePortalStandaloneChatSetModel,
  handlePortalStandaloneChatSetPluginSelections,
  readPortalSendModelConfigPatch,
} from '../standalone-chat-adapter';
import type { PortalAdapterContext } from '../types';
import { createDesktopRuntime } from '../../../canopy-runtime/desktop-runtime';

jest.mock('../../../services/standalone-chat-service', () => ({
  createStandaloneChatTab: jest.fn(),
  resolveStandaloneChatPolicyModels: jest.fn().mockResolvedValue({
    readable: true,
    models: [],
  }),
  sendStandaloneChatMessage: jest.fn(),
  resolveStandaloneChatTarget: jest.fn(),
  emitStandaloneChatSummary: jest.fn().mockResolvedValue(undefined),
  setStandaloneChatModel: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock('../chat-adapter', () => ({
  resolveRemoteCreateTabSeed: jest
    .fn()
    .mockResolvedValue({ model: 'opus', defaultStampModel: 'opus' }),
  handlePortalChatSend: jest.fn().mockResolvedValue(undefined),
  sanitizePortalFileReferences: jest.fn((value: unknown) => value),
}));
import {
  handlePortalChatSend,
  resolveRemoteCreateTabSeed,
} from '../chat-adapter';

describe('standalone empty chat create adapter', () => {
  const port: ChatStateCommandPort = {
    getState: jest.fn(),
    command: jest.fn(),
    subscribe: jest.fn(),
    getCommandReceipt: jest.fn(),
    getTranscriptPage: jest.fn(),
    searchTranscript: jest.fn(),
    readToolOutput: jest.fn(),
  };
  const complete = jest.fn();
  const fail = jest.fn();
  const context: PortalAdapterContext = {
    canReadAssets: () => true,
    chatStatePort: port,
    dispatchChatCommand: (request, options) => port.command(request, options),
    getWindow: () => null,
    enqueueEvent: jest.fn(),
    complete,
    fail,
  };
  const command: PortalCommandEnvelope<unknown> = {
    id: 'create',
    sequence: 1,
    type: 'portal.standalone_chat.create',
    payload: {
      projectLocalId: 'research',
      chatId: 'new-chat',
      message: 'must not send',
      approvalMode: 'full-access',
    },
    target: { standaloneChatLocalId: 'new-chat' },
    createdAt: '2026-10-01',
    expiresAt: null,
  };
  const result = {
    ok: true as const,
    chatId: 'new-chat',
    projectLocalId: 'research',
    projectId: 'research',
    worktreeId: 'new-chat',
    workEntryId: 'new-chat',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(resolveStandaloneChatTarget).mockResolvedValue({
      workspaceId: 'research',
      entryId: null,
      archivedInEntryId: null,
      isArchived: false,
    });
    jest.mocked(createStandaloneChatTab).mockResolvedValue(result);
    jest
      .mocked(resolveRemoteCreateTabSeed)
      .mockResolvedValue({ model: 'opus', defaultStampModel: 'opus' });
  });

  it('uses scoped canonical creation, strips undeclared grants, and returns canonical identities', async () => {
    await handlePortalStandaloneChatCreate(command, context);
    expect(createStandaloneChatTab).toHaveBeenCalledWith(
      { projectLocalId: 'research', chatId: 'new-chat' },
      expect.objectContaining({
        commandId: 'create',
        dispatchCommand: context.dispatchChatCommand,
        seed: { model: 'opus', defaultStampModel: 'opus' },
      }),
    );
    expect(complete).toHaveBeenCalledWith(command, result);
    expect(sendStandaloneChatMessage).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it('creates the entry in the validated sidebar group and refuses a malformed one', async () => {
    await handlePortalStandaloneChatCreate(
      {
        ...command,
        payload: {
          projectLocalId: 'research',
          chatId: 'new-chat',
          sidebarItemGroupId: 'grp-research',
        },
      },
      context,
    );
    expect(createStandaloneChatTab).toHaveBeenCalledWith(
      {
        projectLocalId: 'research',
        chatId: 'new-chat',
        sidebarItemGroupId: 'grp-research',
      },
      expect.anything(),
    );
    jest.mocked(createStandaloneChatTab).mockClear();
    const malformed = {
      ...command,
      payload: {
        projectLocalId: 'research',
        chatId: 'new-chat',
        sidebarItemGroupId: '../escape',
      },
    };
    await handlePortalStandaloneChatCreate(malformed, context);
    expect(createStandaloneChatTab).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(
      malformed,
      'invalid_payload',
      'Invalid standalone chat create payload.',
      false,
    );
  });

  it('denies missing/revoked authorization, mismatched chat targets, and absent canonical service', async () => {
    await handlePortalStandaloneChatCreate(command, {
      ...context,
      canReadAssets: undefined,
    });
    await handlePortalStandaloneChatCreate(command, {
      ...context,
      canReadAssets: () => false,
    });
    await handlePortalStandaloneChatCreate(
      { ...command, target: { standaloneChatLocalId: 'other' } },
      context,
    );
    await handlePortalStandaloneChatCreate(command, {
      ...context,
      dispatchChatCommand: undefined,
    });
    expect(createStandaloneChatTab).not.toHaveBeenCalled();
    expect(resolveStandaloneChatTarget).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not create an entry for an archived chat or unavailable default model', async () => {
    jest.mocked(resolveStandaloneChatTarget).mockResolvedValueOnce({
      workspaceId: 'research',
      entryId: null,
      archivedInEntryId: 'archive',
      isArchived: true,
    });
    await handlePortalStandaloneChatCreate(command, context);
    jest
      .mocked(resolveRemoteCreateTabSeed)
      .mockResolvedValueOnce({ noDispatchableModel: 'billing-lane' });
    await handlePortalStandaloneChatCreate(command, context);
    expect(createStandaloneChatTab).not.toHaveBeenCalled();
    expect(sendStandaloneChatMessage).not.toHaveBeenCalled();
  });
});

const mockIsCursorRuntimeAvailable = jest.fn(() => Promise.resolve(false));
jest.mock('../../../cursor/runtime-availability', () => ({
  isCursorRuntimeAvailable: (): Promise<boolean> =>
    mockIsCursorRuntimeAvailable(),
}));

const mockIsCopilotRuntimeAvailable = jest.fn(() => Promise.resolve(false));
jest.mock('../../../copilot/runtime-availability', () => ({
  isCopilotRuntimeAvailable: (): Promise<boolean> =>
    mockIsCopilotRuntimeAvailable(),
}));

const mockIsOpenCodeRuntimeAvailable = jest.fn(() => Promise.resolve(false));
jest.mock('../../../opencode/runtime-availability', () => ({
  isOpenCodeRuntimeAvailable: (): Promise<boolean> =>
    mockIsOpenCodeRuntimeAvailable(),
}));

const mockedSendStandaloneChatMessage = jest.mocked(sendStandaloneChatMessage);
const mockedSetStandaloneChatModel = jest.mocked(setStandaloneChatModel);
const mockedResolvePolicyModels = jest.mocked(
  resolveStandaloneChatPolicyModels,
);

it('passes the renderer window through standalone model changes', async () => {
  const complete = jest.fn();
  const context: PortalAdapterContext = {
    getWindow: () => null,
    enqueueEvent: jest.fn(),
    complete,
    fail: jest.fn(),
  };
  const command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.standalone_chat.set_model']
  > = {
    id: 'command-model',
    sequence: 1,
    type: 'portal.standalone_chat.set_model',
    payload: {
      projectLocalId: 'research',
      chatId: 'chat-1',
      model: 'claude-sonnet-4-6',
    },
    createdAt: '2026-09-19T00:00:00.000Z',
    expiresAt: null,
  };

  await handlePortalStandaloneChatSetModel(command, context);

  expect(mockedSetStandaloneChatModel).toHaveBeenCalledWith(command.payload, {
    getWindow: context.getWindow,
  });
  expect(complete).toHaveBeenCalledWith(command, { ok: true });
});

it('strips undeclared approval grants from standalone Portal payloads', async () => {
  mockedSendStandaloneChatMessage.mockResolvedValue({ ok: true });
  const complete = jest.fn();
  const fail = jest.fn();
  const context: PortalAdapterContext = {
    getWindow: () => null,
    enqueueEvent: jest.fn(),
    complete,
    fail,
  };
  const payload: PortalCommandPayloadMap['portal.standalone_chat.send'] & {
    approvalMode: string;
    sessionApprovalRules: unknown[];
  } = {
    projectLocalId: 'research',
    chatId: 'chat-1',
    message: 'Attempt remote escalation',
    approvalMode: 'full-access',
    sessionApprovalRules: [
      {
        behavior: 'allow',
        target: { kind: 'command', pattern: '*' },
      },
    ],
  };
  const command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.standalone_chat.send']
  > = {
    id: 'command-1',
    sequence: 1,
    type: 'portal.standalone_chat.send',
    payload,
    createdAt: '2026-07-24T00:00:00.000Z',
    expiresAt: null,
  };

  await handlePortalStandaloneChatSend(command, context);

  expect(mockedSendStandaloneChatMessage).toHaveBeenCalledWith(
    {
      projectLocalId: 'research',
      chatId: 'chat-1',
      message: 'Attempt remote escalation',
      initiationSource: 'portal',
    },
    { getWindow: context.getWindow },
  );
  expect(complete).toHaveBeenCalledWith(command, { ok: true });
  expect(fail).not.toHaveBeenCalled();
});

it('keeps group-aware creation membership alongside normalized Portal model speed', async () => {
  mockedSendStandaloneChatMessage.mockClear();
  mockedSendStandaloneChatMessage.mockResolvedValue({ ok: true });
  const fail = jest.fn();
  const context: PortalAdapterContext = {
    getWindow: () => null,
    enqueueEvent: jest.fn(),
    complete: jest.fn(),
    fail,
  };
  const command: PortalCommandEnvelope<unknown> = {
    id: 'command-group-speed',
    sequence: 1,
    type: 'portal.standalone_chat.send',
    payload: {
      projectLocalId: 'research',
      chatId: 'chat-1',
      message: 'Hello',
      sidebarItemGroupId: 'grp-release',
      modelConfig: { speed: 'ultrafast' },
    },
    createdAt: '2026-10-05T00:00:00.000Z',
    expiresAt: null,
  };
  await handlePortalStandaloneChatSend(command, context);
  expect(fail).not.toHaveBeenCalled();
  expect(mockedSendStandaloneChatMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      sidebarItemGroupId: 'grp-release',
      modelConfig: { speed: 'ultrafast', fastMode: false },
    }),
    { getWindow: context.getWindow },
  );
});

it('forwards the declared input mode on standalone Portal sends', async () => {
  mockedSendStandaloneChatMessage.mockResolvedValue({ ok: true });
  const complete = jest.fn();
  const fail = jest.fn();
  const context: PortalAdapterContext = {
    getWindow: () => null,
    enqueueEvent: jest.fn(),
    complete,
    fail,
  };
  const payload: PortalCommandPayloadMap['portal.standalone_chat.send'] & {
    inputMode: 'voice';
  } = {
    projectLocalId: 'research',
    chatId: 'chat-1',
    message: 'Dictated message',
    inputMode: 'voice',
  };
  const command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.standalone_chat.send']
  > = {
    id: 'command-voice',
    sequence: 1,
    type: 'portal.standalone_chat.send',
    payload,
    createdAt: '2026-09-10T00:00:00.000Z',
    expiresAt: null,
  };

  await handlePortalStandaloneChatSend(command, context);

  expect(mockedSendStandaloneChatMessage).toHaveBeenCalledWith(
    expect.objectContaining({ inputMode: 'voice' }),
    { getWindow: context.getWindow },
  );
  expect(fail).not.toHaveBeenCalled();
});

it('rejects an unsupported standalone Portal input mode', async () => {
  mockedSendStandaloneChatMessage.mockClear();
  const complete = jest.fn();
  const fail = jest.fn();
  const context: PortalAdapterContext = {
    getWindow: () => null,
    enqueueEvent: jest.fn(),
    complete,
    fail,
  };
  const command: PortalCommandEnvelope<unknown> = {
    id: 'command-invalid-input-mode',
    sequence: 1,
    type: 'portal.standalone_chat.send',
    payload: {
      chatId: 'chat-1',
      message: 'Message',
      inputMode: 'recording',
    },
    createdAt: '2026-09-10T00:00:00.000Z',
    expiresAt: null,
  };

  await handlePortalStandaloneChatSend(command, context);

  expect(fail).toHaveBeenCalledWith(
    command,
    'invalid_payload',
    'Invalid standalone chat send payload.',
  );
  expect(complete).not.toHaveBeenCalled();
  expect(mockedSendStandaloneChatMessage).not.toHaveBeenCalled();
});

describe('Codex speed on standalone Portal sends', () => {
  const context = (): PortalAdapterContext & {
    complete: jest.Mock;
    fail: jest.Mock;
  } => ({
    getWindow: () => null,
    enqueueEvent: jest.fn(),
    complete: jest.fn(),
    fail: jest.fn(),
  });
  // `unknown` payloads: the wire is untrusted JSON, so the specs send exactly
  // what a remote client can put on it rather than the declared contract.
  const sendCommand = (
    modelConfig: unknown,
  ): PortalCommandEnvelope<unknown> => ({
    id: 'command-speed',
    sequence: 1,
    type: 'portal.standalone_chat.send',
    payload: {
      projectLocalId: 'research',
      chatId: 'chat-1',
      message: 'Hello',
      modelConfig,
    },
    createdAt: '2026-09-30T00:00:00.000Z',
    expiresAt: null,
  });
  const forwardedModelConfig = (): unknown =>
    mockedSendStandaloneChatMessage.mock.calls[0]?.[0].modelConfig;

  beforeEach(() => {
    mockIsCursorRuntimeAvailable.mockResolvedValue(false);
    mockedResolvePolicyModels.mockResolvedValue({ readable: true, models: [] });
    mockedSendStandaloneChatMessage.mockReset();
    mockedSendStandaloneChatMessage.mockResolvedValue({
      ok: true,
      chatId: 'chat-1',
      userMessageId: 'u-1',
    });
  });

  it.each([
    [{ speed: 'ultrafast' }, { speed: 'ultrafast', fastMode: false }],
    [
      { speed: 'ultrafast', fastMode: false },
      { speed: 'ultrafast', fastMode: false },
    ],
    [
      { speed: 'fast', fastMode: true },
      { speed: 'fast', fastMode: true },
    ],
    [
      { thinkingLevel: 'high', speed: 'standard' },
      { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    ],
  ])(
    'carries an upgraded client speed %j with its derived boolean',
    async (modelConfig, expected) => {
      const ctx = context();
      await handlePortalStandaloneChatSend(sendCommand(modelConfig), ctx);

      expect(ctx.fail).not.toHaveBeenCalled();
      expect(forwardedModelConfig()).toEqual(expected);
    },
  );

  it.each([
    [true, { speed: 'fast', fastMode: true }],
    [false, { speed: 'standard', fastMode: false }],
  ])(
    'treats a legacy fastMode %s as an explicit Fast or Regular choice',
    async (fastMode, expected) => {
      const ctx = context();
      await handlePortalStandaloneChatSend(sendCommand({ fastMode }), ctx);

      expect(ctx.fail).not.toHaveBeenCalled();
      expect(forwardedModelConfig()).toEqual(expected);
    },
  );

  it('adds no speed to a thinking-only modelConfig', async () => {
    const ctx = context();
    await handlePortalStandaloneChatSend(
      sendCommand({ thinkingLevel: 'high' }),
      ctx,
    );

    expect(ctx.fail).not.toHaveBeenCalled();
    expect(forwardedModelConfig()).toEqual({ thinkingLevel: 'high' });
  });

  it.each([
    [
      { speed: 'turbo' },
      'modelConfig.speed must be standard, fast, or ultrafast.',
    ],
    [
      { speed: null },
      'modelConfig.speed must be standard, fast, or ultrafast.',
    ],
    [
      { speed: 'ultrafast', fastMode: true },
      'modelConfig.fastMode must match modelConfig.speed.',
    ],
    [
      { speed: 'fast', fastMode: false },
      'modelConfig.fastMode must match modelConfig.speed.',
    ],
  ])(
    'rejects the invalid or contradictory speed %j before the service runs',
    async (modelConfig, message) => {
      const ctx = context();
      const command = sendCommand(modelConfig);
      await handlePortalStandaloneChatSend(command, ctx);

      expect(ctx.fail).toHaveBeenCalledWith(
        command,
        'invalid_payload',
        message,
      );
      expect(ctx.complete).not.toHaveBeenCalled();
      expect(mockedSendStandaloneChatMessage).not.toHaveBeenCalled();
    },
  );
});

describe('Codex speed patch for worktree Portal sends', () => {
  const ULTRA_TAB: AgentModelConfig = {
    thinkingLevel: 'low',
    speed: 'ultrafast',
    fastMode: false,
  };
  // The declared send payload plus untrusted runtime JSON: a remote client can
  // put any value on the wire, so the specs assign fields outside the static
  // contract after construction instead of casting.
  const payload = (
    fields: Partial<PortalCommandPayloadMap['portal.chat.send']> = {},
    wire: Record<string, unknown> = {},
  ): PortalCommandPayloadMap['portal.chat.send'] => {
    const value: PortalCommandPayloadMap['portal.chat.send'] = {
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat-1',
      text: 'Hello',
      ...fields,
    };
    for (const [key, raw] of Object.entries(wire)) Reflect.set(value, key, raw);
    return value;
  };
  const mergedOver = (
    base: AgentModelConfig,
    fields: Partial<PortalCommandPayloadMap['portal.chat.send']>,
  ): AgentModelConfig => {
    const read = readPortalSendModelConfigPatch(payload(fields));
    if (!read.ok) throw new Error(read.error);
    return mergeAgentModelConfig(base, read.patch);
  };

  it('keeps Ultra fast through a thinking-only change', () => {
    expect(
      mergedOver(ULTRA_TAB, { modelConfig: { thinkingLevel: 'high' } }),
    ).toEqual({ thinkingLevel: 'high', speed: 'ultrafast', fastMode: false });
    expect(mergedOver(ULTRA_TAB, { thinkingLevel: 'medium' })).toEqual({
      thinkingLevel: 'medium',
      speed: 'ultrafast',
      fastMode: false,
    });
  });

  it('lets an explicit legacy false replace Ultra fast with Regular', () => {
    expect(mergedOver(ULTRA_TAB, { modelConfig: { fastMode: false } })).toEqual(
      { thinkingLevel: 'low', speed: 'standard', fastMode: false },
    );
    expect(mergedOver(ULTRA_TAB, { codexFastModeEnabled: false })).toEqual({
      thinkingLevel: 'low',
      speed: 'standard',
      fastMode: false,
    });
  });

  it('lets an explicit legacy true replace Ultra fast with Fast', () => {
    expect(mergedOver(ULTRA_TAB, { codexFastModeEnabled: true })).toEqual({
      thinkingLevel: 'low',
      speed: 'fast',
      fastMode: true,
    });
  });

  it("honors an upgraded client's exact speed over the persisted one", () => {
    expect(
      mergedOver(
        { speed: 'fast', fastMode: true },
        { modelConfig: { speed: 'ultrafast' } },
      ),
    ).toEqual({ speed: 'ultrafast', fastMode: false });
  });

  it('keeps the modelConfig boolean ahead of the deprecated top-level one', () => {
    expect(
      mergedOver(ULTRA_TAB, {
        modelConfig: { fastMode: false },
        codexFastModeEnabled: true,
      }),
    ).toEqual({ thinkingLevel: 'low', speed: 'standard', fastMode: false });
  });

  it('reports a payload without model settings as not explicit', () => {
    expect(readPortalSendModelConfigPatch(payload())).toEqual({
      ok: true,
      explicit: false,
      patch: {},
    });
    expect(
      readPortalSendModelConfigPatch(
        payload({ modelConfig: { speed: 'fast' } }),
      ),
    ).toMatchObject({ ok: true, explicit: true });
  });

  it.each([
    [{ modelConfig: 'fast' }, 'modelConfig must be an object.'],
    [{ modelConfig: null }, 'modelConfig must be an object.'],
    [
      { modelConfig: { speed: 'turbo' } },
      'modelConfig.speed must be standard, fast, or ultrafast.',
    ],
    [
      { modelConfig: { speed: 'ultrafast', fastMode: true } },
      'modelConfig.fastMode must match modelConfig.speed.',
    ],
    [
      { modelConfig: { fastMode: 'yes' } },
      'modelConfig.fastMode must be a boolean.',
    ],
    [{ codexFastModeEnabled: 1 }, 'codexFastModeEnabled must be a boolean.'],
    [
      { modelConfig: { speed: 'ultrafast' }, codexFastModeEnabled: true },
      'codexFastModeEnabled must match modelConfig.speed.',
    ],
  ])('refuses the invalid or contradictory wire value %j', (wire, error) => {
    expect(readPortalSendModelConfigPatch(payload({}, wire))).toEqual({
      ok: false,
      error,
    });
  });
});

describe('Cursor runtime preflight on Cowork Portal commands', () => {
  const context = (): PortalAdapterContext & {
    complete: jest.Mock;
    fail: jest.Mock;
  } => ({
    getWindow: () => null,
    enqueueEvent: jest.fn(),
    complete: jest.fn(),
    fail: jest.fn(),
  });
  const sendCommand = (
    payload: PortalCommandPayloadMap['portal.standalone_chat.send'],
  ): PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.standalone_chat.send']
  > => ({
    id: 'command-cursor',
    sequence: 1,
    type: 'portal.standalone_chat.send',
    payload,
    createdAt: '2026-09-25T00:00:00.000Z',
    expiresAt: null,
  });

  beforeEach(() => {
    mockedSendStandaloneChatMessage.mockReset();
    mockedSetStandaloneChatModel.mockReset();
    mockedSetStandaloneChatModel.mockResolvedValue({ ok: true });
    mockedResolvePolicyModels.mockResolvedValue({ readable: true, models: [] });
  });

  it('refuses a Cursor-modeled send while the runtime is disconnected and persists nothing', async () => {
    mockIsCursorRuntimeAvailable.mockResolvedValue(false);
    const ctx = context();
    const command = sendCommand({
      projectLocalId: 'research',
      chatId: 'chat-1',
      message: 'Hello',
      model: 'cursor-default',
    });
    await handlePortalStandaloneChatSend(command, ctx);
    expect(ctx.fail).toHaveBeenCalledWith(
      command,
      'invalid_payload',
      'Connect Cursor in the desktop app to use it here.',
    );
    expect(mockedSendStandaloneChatMessage).not.toHaveBeenCalled();
  });

  it('refuses a send whose tab already runs on Cursor while disconnected', async () => {
    mockIsCursorRuntimeAvailable.mockResolvedValue(false);
    mockedResolvePolicyModels.mockResolvedValue({
      readable: true,
      models: ['cursor-default'],
    });
    const ctx = context();
    const command = sendCommand({
      projectLocalId: 'research',
      chatId: 'chat-1',
      message: 'Hello',
    });
    await handlePortalStandaloneChatSend(command, ctx);
    expect(ctx.fail).toHaveBeenCalledWith(
      command,
      'invalid_payload',
      'Connect Cursor in the desktop app to use it here.',
    );
    expect(mockedSendStandaloneChatMessage).not.toHaveBeenCalled();
  });

  it('forwards a Cursor-modeled send while the runtime is connected', async () => {
    mockIsCursorRuntimeAvailable.mockResolvedValue(true);
    mockedSendStandaloneChatMessage.mockResolvedValue({
      ok: true,
      chatId: 'chat-1',
      userMessageId: 'u-1',
    });
    const ctx = context();
    const command = sendCommand({
      projectLocalId: 'research',
      chatId: 'chat-1',
      message: 'Hello',
      model: 'cursor-default',
      providerType: 'cursor',
    });
    await handlePortalStandaloneChatSend(command, ctx);
    expect(mockedSendStandaloneChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'cursor-default',
        providerType: 'cursor',
      }),
      { getWindow: ctx.getWindow },
    );
    expect(ctx.fail).not.toHaveBeenCalled();
  });

  it('refuses a Copilot-modeled send while the runtime is disconnected and persists nothing', async () => {
    mockIsCopilotRuntimeAvailable.mockResolvedValue(false);
    const ctx = context();
    const command = sendCommand({
      projectLocalId: 'research',
      chatId: 'chat-1',
      message: 'Hello',
      model: 'copilot:fixture',
    });
    await handlePortalStandaloneChatSend(command, ctx);
    expect(ctx.fail).toHaveBeenCalledWith(
      command,
      'invalid_payload',
      'Connect Copilot in the desktop app to use it here.',
    );
    expect(mockedSendStandaloneChatMessage).not.toHaveBeenCalled();
  });

  it('refuses a send whose tab already runs on Copilot while disconnected', async () => {
    mockIsCopilotRuntimeAvailable.mockResolvedValue(false);
    mockedResolvePolicyModels.mockResolvedValue({
      readable: true,
      models: ['copilot:fixture'],
    });
    const ctx = context();
    const command = sendCommand({
      projectLocalId: 'research',
      chatId: 'chat-1',
      message: 'Hello',
    });
    await handlePortalStandaloneChatSend(command, ctx);
    expect(ctx.fail).toHaveBeenCalledWith(
      command,
      'invalid_payload',
      'Connect Copilot in the desktop app to use it here.',
    );
    expect(mockedSendStandaloneChatMessage).not.toHaveBeenCalled();
  });

  it('forwards a Copilot-modeled send while the runtime is connected', async () => {
    mockIsCopilotRuntimeAvailable.mockResolvedValue(true);
    mockedSendStandaloneChatMessage.mockResolvedValue({
      ok: true,
      chatId: 'chat-1',
      userMessageId: 'u-1',
    });
    const ctx = context();
    const command = sendCommand({
      projectLocalId: 'research',
      chatId: 'chat-1',
      message: 'Hello',
      model: 'copilot:fixture',
      providerType: 'copilot',
    });
    await handlePortalStandaloneChatSend(command, ctx);
    expect(mockedSendStandaloneChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'copilot:fixture',
        providerType: 'copilot',
      }),
      { getWindow: ctx.getWindow },
    );
    expect(ctx.fail).not.toHaveBeenCalled();
  });

  it.each(['provider', 'model', 'persisted'] as const)(
    'gates %s OpenCode sends independently of Copilot',
    async (route) => {
      mockIsCopilotRuntimeAvailable.mockResolvedValue(false);
      for (const connected of [false, true]) {
        mockedSendStandaloneChatMessage.mockClear();
        mockedSendStandaloneChatMessage.mockResolvedValue({ ok: true });
        mockIsOpenCodeRuntimeAvailable.mockResolvedValue(connected);
        mockedResolvePolicyModels.mockResolvedValue({
          readable: true,
          models:
            route === 'persisted' ? [toOpenCodeModelId('fixture/model')] : [],
        });
        const ctx = context();
        const command = sendCommand({
          projectLocalId: 'research',
          chatId: 'chat-1',
          message: 'Hello',
          ...(route === 'provider' ? { providerType: 'opencode' } : {}),
          ...(route === 'model'
            ? { model: toOpenCodeModelId('fixture/model') }
            : {}),
        });
        await handlePortalStandaloneChatSend(command, ctx);
        if (connected) {
          expect(ctx.fail).not.toHaveBeenCalled();
          expect(mockedSendStandaloneChatMessage).toHaveBeenCalledTimes(1);
        } else {
          expect(ctx.fail).toHaveBeenCalledWith(
            command,
            'invalid_payload',
            'Connect OpenCode in the desktop app to use it here.',
          );
          expect(mockedSendStandaloneChatMessage).not.toHaveBeenCalled();
        }
      }
    },
  );

  it('forwards providerType on a provider-only Cursor send while connected', async () => {
    mockIsCursorRuntimeAvailable.mockResolvedValue(true);
    mockedSendStandaloneChatMessage.mockResolvedValue({
      ok: true,
      chatId: 'chat-1',
      userMessageId: 'u-1',
    });
    const ctx = context();
    const command = sendCommand({
      projectLocalId: 'research',
      chatId: 'chat-1',
      message: 'Hello',
      providerType: 'cursor',
    });
    await handlePortalStandaloneChatSend(command, ctx);
    expect(mockedSendStandaloneChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ providerType: 'cursor' }),
      { getWindow: ctx.getWindow },
    );
    expect(
      mockedSendStandaloneChatMessage.mock.calls[0]?.[0],
    ).not.toHaveProperty('model');
    expect(ctx.fail).not.toHaveBeenCalled();
  });

  it('refuses a provider-only Cursor send whose route has no model before reaching the service', async () => {
    mockIsCursorRuntimeAvailable.mockResolvedValue(true);
    mockedResolvePolicyModels.mockResolvedValue({
      readable: true,
      models: [],
      cursorModelRequired: true,
    });
    const ctx = context();
    const command = sendCommand({
      projectLocalId: 'research',
      chatId: 'chat-1',
      message: 'Hello',
      providerType: 'cursor',
    });
    await handlePortalStandaloneChatSend(command, ctx);
    expect(ctx.fail).toHaveBeenCalledWith(
      command,
      'invalid_payload',
      'Choose a Cursor model to send with Cursor, or choose another model.',
    );
    expect(mockedSendStandaloneChatMessage).not.toHaveBeenCalled();
  });

  it('refuses a provider-only Cursor send while the runtime is disconnected', async () => {
    mockIsCursorRuntimeAvailable.mockResolvedValue(false);
    const ctx = context();
    const command = sendCommand({
      projectLocalId: 'research',
      chatId: 'chat-1',
      message: 'Hello',
      providerType: 'cursor',
    });
    await handlePortalStandaloneChatSend(command, ctx);
    expect(ctx.fail).toHaveBeenCalledWith(
      command,
      'invalid_payload',
      'Connect Cursor in the desktop app to use it here.',
    );
    expect(mockedSendStandaloneChatMessage).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'set-model preflights a Cursor model (connected: %s)',
    async (connected) => {
      mockIsCursorRuntimeAvailable.mockResolvedValue(connected);
      const ctx = context();
      const command: PortalCommandEnvelope<
        PortalCommandPayloadMap['portal.standalone_chat.set_model']
      > = {
        id: 'command-model-cursor',
        sequence: 1,
        type: 'portal.standalone_chat.set_model',
        payload: {
          projectLocalId: 'research',
          chatId: 'chat-1',
          model: 'cursor-default',
        },
        createdAt: '2026-09-25T00:00:00.000Z',
        expiresAt: null,
      };
      await handlePortalStandaloneChatSetModel(command, ctx);
      if (connected) {
        expect(mockedSetStandaloneChatModel).toHaveBeenCalled();
        expect(ctx.fail).not.toHaveBeenCalled();
      } else {
        expect(ctx.fail).toHaveBeenCalledWith(
          command,
          'invalid_payload',
          'Connect Cursor in the desktop app to use it here.',
        );
        expect(mockedSetStandaloneChatModel).not.toHaveBeenCalled();
      }
    },
  );
  it.each([false, true])(
    'set-model preflights a Copilot model (connected: %s)',
    async (connected) => {
      mockIsCopilotRuntimeAvailable.mockResolvedValue(connected);
      const ctx = context();
      const command: PortalCommandEnvelope<
        PortalCommandPayloadMap['portal.standalone_chat.set_model']
      > = {
        id: 'command-model-copilot',
        sequence: 1,
        type: 'portal.standalone_chat.set_model',
        payload: {
          projectLocalId: 'research',
          chatId: 'chat-1',
          model: 'copilot:fixture',
        },
        createdAt: '2026-09-25T00:00:00.000Z',
        expiresAt: null,
      };
      await handlePortalStandaloneChatSetModel(command, ctx);
      if (connected) {
        expect(mockedSetStandaloneChatModel).toHaveBeenCalled();
        expect(ctx.fail).not.toHaveBeenCalled();
      } else {
        expect(ctx.fail).toHaveBeenCalledWith(
          command,
          'invalid_payload',
          'Connect Copilot in the desktop app to use it here.',
        );
        expect(mockedSetStandaloneChatModel).not.toHaveBeenCalled();
      }
    },
  );
  it.each([false, true])(
    'set-model preflights an OpenCode model (connected: %s)',
    async (connected) => {
      mockIsOpenCodeRuntimeAvailable.mockResolvedValue(connected);
      const ctx = context();
      const command: PortalCommandEnvelope<
        PortalCommandPayloadMap['portal.standalone_chat.set_model']
      > = {
        id: 'command-model-opencode',
        sequence: 1,
        type: 'portal.standalone_chat.set_model',
        payload: {
          projectLocalId: 'research',
          chatId: 'chat-1',
          model: toOpenCodeModelId('fixture/model'),
        },
        createdAt: '2026-09-25T00:00:00.000Z',
        expiresAt: null,
      };
      await handlePortalStandaloneChatSetModel(command, ctx);
      if (connected) {
        expect(mockedSetStandaloneChatModel).toHaveBeenCalled();
        expect(ctx.fail).not.toHaveBeenCalled();
      } else {
        expect(ctx.fail).toHaveBeenCalledWith(
          command,
          'invalid_payload',
          'Connect OpenCode in the desktop app to use it here.',
        );
        expect(mockedSetStandaloneChatModel).not.toHaveBeenCalled();
      }
    },
  );
});

it.each([false, true])(
  'routes standalone read through the owning Work Entry (archived=%s)',
  async (isArchived) => {
    jest.mocked(resolveStandaloneChatTarget).mockResolvedValue({
      workspaceId: 'research',
      entryId: 'entry-1',
      archivedInEntryId: null,
      isArchived,
    });
    const commit = jest
      .fn()
      .mockResolvedValue({ outcome: 'applied', revision: 4 });
    const complete = jest.fn();
    const fail = jest.fn();
    const chatStatePort: ChatStateCommandPort = {
      command: commit,
      getTranscriptPage: jest.fn(),
      readToolOutput: jest.fn(),
      getState: jest.fn().mockResolvedValue({
        schemaVersion: 1,
        projectId: 'research',
        worktreeId: 'entry-1',
        revision: 3,
        runtimeByChatId: {},
        tabsFile: {
          version: 1,
          activeTabId: 'chat-1',
          tabs: [
            {
              id: 'chat-1',
              title: 'Chat',
              createdAt: '2026-09-05T00:00:00Z',
              unread: true,
              messages: [
                {
                  id: 'reply-1',
                  role: 'assistant',
                  blocks: [{ type: 'text', text: 'Done' }],
                  timestamp: 1000,
                },
              ],
            },
          ],
        },
        archives: [],
        queue: [],
      }),
      subscribe: jest.fn(() => jest.fn()),
    };
    const runtime = createDesktopRuntime({
      getChatStatePort: () => chatStatePort,
    });
    jest.mocked(emitStandaloneChatSummary).mockClear();
    await handlePortalChatMarkRead(
      {
        id: 'read-1',
        sequence: 1,
        type: 'portal.chat.mark_read',
        createdAt: '2026-09-05T00:00:00Z',
        expiresAt: null,
        payload: {
          scope: 'standalone',
          projectLocalId: 'research',
          chatId: 'chat-1',
          lastMessageId: 'reply-1',
        },
      },
      {
        sessionId: 'test-session',
        complete,
        fail,
        enqueueEvent: jest.fn(),
        getWindow: () => null,
        chatStatePort,
      },
    );
    if (isArchived) {
      expect(commit).not.toHaveBeenCalled();
      expect(fail).toHaveBeenCalledWith(
        expect.anything(),
        'not_found',
        expect.any(String),
      );
      expect(emitStandaloneChatSummary).not.toHaveBeenCalled();
    } else {
      expect(commit).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'research',
          worktreeId: 'entry-1',
          expectedRevision: 3,
          command: { type: 'chat.mark_read', chatId: 'chat-1' },
        }),
      );
      expect(emitStandaloneChatSummary).toHaveBeenCalledWith(
        'research',
        'entry-1',
        'chat-1',
      );
      expect(fail).not.toHaveBeenCalled();
    }
    await runtime.shutdown();
  },
);

it('routes a Portal read acknowledgement through the chat command router', async () => {
  jest.mocked(resolveStandaloneChatTarget).mockResolvedValue({
    workspaceId: 'research',
    entryId: 'entry-1',
    archivedInEntryId: null,
    isArchived: false,
  });
  const commit = jest.fn();
  const dispatchChatCommand = jest.fn().mockResolvedValue({
    commandId: 'read-1',
    outcome: 'applied',
    revision: 4,
  });
  const complete = jest.fn();
  const chatStatePort: ChatStateCommandPort = {
    command: commit,
    getTranscriptPage: jest.fn(),
    readToolOutput: jest.fn(),
    getState: jest.fn().mockResolvedValue({
      schemaVersion: 1,
      projectId: 'research',
      worktreeId: 'entry-1',
      revision: 3,
      runtimeByChatId: {},
      tabsFile: {
        version: 1,
        activeTabId: 'chat-1',
        tabs: [
          {
            id: 'chat-1',
            title: 'Chat',
            createdAt: '2026-09-05T00:00:00Z',
            unread: true,
            messages: [],
          },
        ],
      },
      archives: [],
      queue: [],
    }),
    subscribe: jest.fn(() => jest.fn()),
  };
  const runtime = createDesktopRuntime({
    getChatStatePort: () => chatStatePort,
  });
  await handlePortalChatMarkRead(
    {
      id: 'read-1',
      sequence: 1,
      type: 'portal.chat.mark_read',
      createdAt: '2026-09-05T00:00:00Z',
      expiresAt: null,
      payload: {
        scope: 'standalone',
        projectLocalId: 'research',
        chatId: 'chat-1',
        lastMessageId: null,
      },
    },
    {
      sessionId: 'test-session',
      complete,
      fail: jest.fn(),
      enqueueEvent: jest.fn(),
      getWindow: () => null,
      chatStatePort,
      dispatchChatCommand,
    },
  );
  expect(dispatchChatCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      commandId: 'read-1',
      expectedRevision: 3,
      origin: 'portal',
      command: { type: 'chat.mark_read', chatId: 'chat-1' },
    }),
  );
  expect(commit).not.toHaveBeenCalled();
  expect(complete).toHaveBeenCalled();
  await runtime.shutdown();
});

describe('portal.standalone_chat.set_plugin_selections', () => {
  function selectionsState(): ChatStateCommandPort {
    return {
      command: jest.fn(),
      getTranscriptPage: jest.fn(),
      readToolOutput: jest.fn(),
      getState: jest.fn().mockResolvedValue({
        schemaVersion: 1,
        projectId: 'research',
        worktreeId: 'entry-1',
        revision: 5,
        runtimeByChatId: {},
        tabsFile: {
          version: 1,
          activeTabId: 'chat-1',
          tabs: [
            {
              id: 'chat-1',
              title: 'Chat',
              createdAt: '2026-10-08T00:00:00Z',
              messages: [],
            },
          ],
        },
        archives: [],
        queue: [],
      }),
      subscribe: jest.fn(() => jest.fn()),
    };
  }

  function setCommand(
    payload: unknown,
  ): PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.standalone_chat.set_plugin_selections']
  > {
    return {
      id: 'select-1',
      sequence: 1,
      type: 'portal.standalone_chat.set_plugin_selections',
      payload:
        payload as PortalCommandPayloadMap['portal.standalone_chat.set_plugin_selections'],
      createdAt: '2026-10-08T00:00:00Z',
      expiresAt: null,
    };
  }

  beforeEach(() => {
    jest.mocked(resolveStandaloneChatTarget).mockResolvedValue({
      workspaceId: 'research',
      entryId: 'entry-1',
      archivedInEntryId: null,
      isArchived: false,
    });
    jest.mocked(emitStandaloneChatSummary).mockClear();
  });

  it.each([true, false])(
    'commits standalone policy %s atomically with selections',
    async (deferredToolsAllowed) => {
      const chatStatePort = selectionsState();
      const runtime = createDesktopRuntime({
        getChatStatePort: () => chatStatePort,
      });
      const dispatchChatCommand = jest.fn().mockResolvedValue({
        commandId: 'select-1',
        outcome: 'applied',
        revision: 6,
      });
      const complete = jest.fn();
      const fail = jest.fn<void, Parameters<PortalAdapterContext['fail']>>();
      try {
        await handlePortalStandaloneChatSetPluginSelections(
          setCommand({
            projectLocalId: 'research',
            chatId: 'chat-1',
            selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
            deferredToolsAllowed,
          }),
          {
            sessionId: 'test-session',
            enqueueEvent: jest.fn(),
            getWindow: () => null,
            chatStatePort,
            dispatchChatCommand,
            complete,
            fail,
          },
        );
        expect(dispatchChatCommand).toHaveBeenCalledTimes(1);
        expect(dispatchChatCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            command: {
              type: 'chat.patch_tab_settings',
              tabId: 'chat-1',
              patch: {
                pluginSelections: {
                  collectionIds: [],
                  skillRefs: [],
                  pluginRefs: [],
                },
                deferredToolsAllowed,
              },
            },
          }),
        );
        expect(fail).not.toHaveBeenCalled();
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it('persists normalized selections through the chat command router and projects the summary', async () => {
    const chatStatePort = selectionsState();
    const runtime = createDesktopRuntime({
      getChatStatePort: () => chatStatePort,
    });
    const dispatchChatCommand = jest.fn().mockResolvedValue({
      commandId: 'select-1',
      outcome: 'applied',
      revision: 6,
    });
    const complete = jest.fn();
    const fail = jest.fn<void, Parameters<PortalAdapterContext['fail']>>();
    await handlePortalStandaloneChatSetPluginSelections(
      setCommand({
        projectLocalId: 'research',
        chatId: 'chat-1',
        selections: {
          collectionIds: ['collection-a'],
          bundleIds: ['legacy-collection'],
          skillRefs: [{ sourceId: 'local', skillName: 'review' }],
          pluginRefs: [{ marketplaceId: 'market', pluginName: 'helper' }],
          mcpServerRefs: [{ serverId: 'server', configId: 'config' }],
          mcpHttpAuthPreferences: [
            {
              target: { kind: 'standalone', serverId: 'server', configId: 'c' },
              handler: 'provider',
            },
          ],
        },
      }),
      {
        sessionId: 'test-session',
        complete,
        fail,
        enqueueEvent: jest.fn(),
        getWindow: () => null,
        chatStatePort,
        dispatchChatCommand,
      },
    );

    expect(fail).not.toHaveBeenCalled();
    expect(dispatchChatCommand).toHaveBeenCalledWith({
      schemaVersion: 1,
      commandId: 'select-1',
      projectId: 'research',
      worktreeId: 'entry-1',
      origin: 'portal',
      command: {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: {
          pluginSelections: {
            collectionIds: ['collection-a', 'legacy-collection'],
            skillRefs: [{ sourceId: 'local', skillName: 'review' }],
            pluginRefs: [{ marketplaceId: 'market', pluginName: 'helper' }],
            mcpServerRefs: [{ serverId: 'server', configId: 'config' }],
            mcpHttpAuthPreferences: [
              {
                target: {
                  kind: 'standalone',
                  serverId: 'server',
                  configId: 'c',
                },
                handler: 'provider',
              },
            ],
          },
        },
      },
    });
    expect(emitStandaloneChatSummary).toHaveBeenCalledWith(
      'research',
      'entry-1',
      'chat-1',
    );
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'select-1' }),
      expect.objectContaining({ outcome: 'applied' }),
    );
    await runtime.shutdown();
  });

  it.each([
    ['an archived chat', { isArchived: true }],
    ['a chat without a Work Entry', { entryId: null }],
  ])('refuses %s without writing', async (_label, resolution) => {
    jest.mocked(resolveStandaloneChatTarget).mockResolvedValue({
      workspaceId: 'research',
      entryId: 'entry-1',
      archivedInEntryId: null,
      isArchived: false,
      ...resolution,
    });
    const chatStatePort = selectionsState();
    const dispatchChatCommand = jest.fn();
    const fail = jest.fn<void, Parameters<PortalAdapterContext['fail']>>();
    await handlePortalStandaloneChatSetPluginSelections(
      setCommand({
        chatId: 'chat-1',
        selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      }),
      {
        sessionId: 'test-session',
        complete: jest.fn(),
        fail,
        enqueueEvent: jest.fn(),
        getWindow: () => null,
        chatStatePort,
        dispatchChatCommand,
      },
    );

    expect(fail.mock.calls[0]?.[1]).toBe('not_found');
    expect(dispatchChatCommand).not.toHaveBeenCalled();
    expect(emitStandaloneChatSummary).not.toHaveBeenCalled();
  });

  it('reports a conflict outcome as retryable without completing', async () => {
    const chatStatePort = selectionsState();
    const runtime = createDesktopRuntime({
      getChatStatePort: () => chatStatePort,
    });
    const complete = jest.fn();
    const fail = jest.fn<void, Parameters<PortalAdapterContext['fail']>>();
    await handlePortalStandaloneChatSetPluginSelections(
      setCommand({
        projectLocalId: 'research',
        chatId: 'chat-1',
        selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      }),
      {
        sessionId: 'test-session',
        complete,
        fail,
        enqueueEvent: jest.fn(),
        getWindow: () => null,
        chatStatePort,
        dispatchChatCommand: jest.fn().mockResolvedValue({
          commandId: 'select-1',
          outcome: 'conflict',
          reason: 'stale revision',
        }),
      },
    );

    expect(fail.mock.calls[0]?.[1]).toBe('conflict');
    expect(fail.mock.calls[0]?.[3]).toBe(true);
    expect(complete).not.toHaveBeenCalled();
    expect(emitStandaloneChatSummary).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  it.each([
    ['missing selections', { chatId: 'chat-1' }],
    ['a non-object selection set', { chatId: 'chat-1', selections: [] }],
    ['an invalid chat id', { chatId: '../chat', selections: {} }],
  ])('rejects %s', async (_label, payload) => {
    const fail = jest.fn<void, Parameters<PortalAdapterContext['fail']>>();
    const dispatchChatCommand = jest.fn();
    await handlePortalStandaloneChatSetPluginSelections(setCommand(payload), {
      sessionId: 'test-session',
      complete: jest.fn(),
      fail,
      enqueueEvent: jest.fn(),
      getWindow: () => null,
      chatStatePort: selectionsState(),
      dispatchChatCommand,
    });

    expect(fail.mock.calls[0]?.[1]).toBe('invalid_payload');
    expect(dispatchChatCommand).not.toHaveBeenCalled();
  });
});

describe('mixed-version standalone text sends', () => {
  const dispatchChatCommand = jest.fn();
  const context = (): PortalAdapterContext & {
    complete: jest.Mock;
    fail: jest.Mock;
  } => ({
    canReadAssets: () => true,
    dispatchChatCommand,
    getWindow: () => null,
    enqueueEvent: jest.fn(),
    complete: jest.fn(),
    fail: jest.fn(),
  });
  // The exact shape a released mobile build sends: it always mints a
  // `userMessageId`, targets the standalone chat, and never calls
  // `portal.standalone_chat.create`.
  const legacyMobileSend = (
    extra: Record<string, unknown> = {},
  ): PortalCommandEnvelope<unknown> => ({
    id: 'command-legacy-mobile',
    sequence: 1,
    type: 'portal.standalone_chat.send',
    target: { standaloneChatLocalId: 'cc-first-chat' },
    payload: {
      projectLocalId: 'research',
      chatId: 'cc-first-chat',
      userMessageId: 'cc-message-1',
      message: 'Hello from an older phone',
      ...extra,
    },
    createdAt: '2026-10-08T00:00:00.000Z',
    expiresAt: null,
  });

  beforeEach(() => {
    mockIsCursorRuntimeAvailable.mockResolvedValue(false);
    mockedResolvePolicyModels.mockResolvedValue({ readable: true, models: [] });
    mockedSendStandaloneChatMessage.mockReset();
    mockedSendStandaloneChatMessage.mockResolvedValue({
      ok: true,
      chatId: 'cc-first-chat',
      userMessageId: 'desktop-minted',
    });
    jest.mocked(handlePortalChatSend).mockClear();
    jest.mocked(resolveStandaloneChatTarget).mockReset();
  });

  it('creates the chat on a first text send that skipped the create handshake', async () => {
    jest.mocked(resolveStandaloneChatTarget).mockResolvedValue({
      workspaceId: 'research',
      entryId: null,
      archivedInEntryId: null,
      isArchived: false,
    });
    const ctx = context();
    const command = legacyMobileSend();
    await handlePortalStandaloneChatSend(command, ctx);

    expect(ctx.fail).not.toHaveBeenCalled();
    expect(handlePortalChatSend).not.toHaveBeenCalled();
    expect(mockedSendStandaloneChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectLocalId: 'research',
        chatId: 'cc-first-chat',
        message: 'Hello from an older phone',
      }),
      expect.anything(),
    );
    expect(ctx.complete).toHaveBeenCalledWith(command, {
      ok: true,
      chatId: 'cc-first-chat',
      userMessageId: 'desktop-minted',
    });
  });

  it('forwards trusted context origin to a legacy standalone text send', async () => {
    jest.mocked(resolveStandaloneChatTarget).mockResolvedValue({
      workspaceId: 'research',
      entryId: null,
      archivedInEntryId: null,
      isArchived: false,
    });
    const ctx = context();
    const sender: ExternalAgentSender = {
      kind: 'external_agent',
      connectionId: '11111111-1111-4111-8111-111111111111',
      clientName: 'Research client',
      verified: true,
      userId: '22222222-2222-4222-8222-222222222222',
    };
    Reflect.set(ctx, 'origin', sender);
    const command = legacyMobileSend({
      agentSent: { kind: 'external_agent', clientName: 'Spoofed payload' },
    });

    await handlePortalStandaloneChatSend(command, ctx);

    expect(mockedSendStandaloneChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ agentSent: sender }),
      expect.anything(),
    );
  });

  it('keeps the client message id when the chat already exists', async () => {
    jest.mocked(resolveStandaloneChatTarget).mockResolvedValue({
      workspaceId: 'research',
      entryId: 'entry-1',
      archivedInEntryId: null,
      isArchived: false,
    });
    const ctx = context();
    await handlePortalStandaloneChatSend(legacyMobileSend(), ctx);

    expect(ctx.fail).not.toHaveBeenCalled();
    expect(mockedSendStandaloneChatMessage).not.toHaveBeenCalled();
    const [forwarded] = jest.mocked(handlePortalChatSend).mock.calls[0] ?? [];
    expect(forwarded?.type).toBe('portal.chat.send');
    expect(forwarded?.payload).toEqual(
      expect.objectContaining({
        projectId: 'research',
        worktreeId: 'entry-1',
        chatId: 'cc-first-chat',
        userMessageId: 'cc-message-1',
        text: 'Hello from an older phone',
      }),
    );
  });

  it('refuses attachments for a chat the handshake never created', async () => {
    jest.mocked(resolveStandaloneChatTarget).mockResolvedValue({
      workspaceId: 'research',
      entryId: null,
      archivedInEntryId: null,
      isArchived: false,
    });
    const ctx = context();
    const command = legacyMobileSend({ cloudAttachments: [] });
    await handlePortalStandaloneChatSend(command, ctx);

    expect(ctx.fail).toHaveBeenCalledWith(
      command,
      'invalid_target',
      'Create or restore this chat before sending a message.',
      false,
    );
    expect(mockedSendStandaloneChatMessage).not.toHaveBeenCalled();
    expect(handlePortalChatSend).not.toHaveBeenCalled();
  });
});
