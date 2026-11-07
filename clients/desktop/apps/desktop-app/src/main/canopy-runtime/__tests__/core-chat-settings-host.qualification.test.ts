import type {
  ChatCommandRequest,
  ChatCommandResult,
  ChatStateCommandPort,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { CoreChatUpdateParamsSchema } from '@canopy/protocol/canopy-core';
import { setChatStateCommandPort } from '../../ipc/chat-state';
import {
  createCoreChatSettingsHost,
  isModelChangeSuperseded,
} from '../../services/chat-settings-host';
import type { ChatSettingsHostDependencies } from '../../services/chat-settings-host';
import {
  createChatCommandDispatchOptions,
  dispatchTrustedChatCommand,
} from '../core-chat-command-adapter';
import type {
  CoreChatModelChange,
  CoreChatSettingsChange,
  CoreChatSettingsHost,
  CoreChatSettingsTarget,
} from '../core-chat-command-adapter';
import { createDesktopRuntime } from '../desktop-runtime';

const caller = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop' as const,
  grants: ['core.chat.write' as const],
};

const target: CoreChatSettingsTarget = {
  projectId: 'project',
  worktreeId: 'worktree',
  chatId: 'tab',
};

function makePort(outcome: ChatCommandResult['outcome'] = 'applied'): {
  port: ChatStateCommandPort;
  command: jest.Mock<Promise<ChatCommandResult>, [ChatCommandRequest]>;
} {
  const command = jest.fn(
    (request: ChatCommandRequest): Promise<ChatCommandResult> =>
      Promise.resolve({
        commandId: request.commandId,
        revision: 7,
        outcome,
        entityId: 'tab',
      }),
  );
  const port: ChatStateCommandPort = {
    command,
    getState: jest.fn(),
    getTranscriptPage: jest.fn(),
    readVisual: jest.fn(),
    readToolOutput: jest.fn(),
    searchTranscript: jest.fn(),
    subscribe: jest.fn(() => () => undefined),
  };
  return { port, command };
}

function makeHost(): {
  host: CoreChatSettingsHost;
  applySettings: jest.Mock<
    Promise<ChatCommandResult>,
    [CoreChatSettingsChange, ChatStateCommandPort]
  >;
  changeModel: jest.Mock<
    Promise<ChatCommandResult>,
    [CoreChatModelChange, ChatStateCommandPort]
  >;
} {
  const applySettings = jest.fn<
    Promise<ChatCommandResult>,
    [CoreChatSettingsChange, ChatStateCommandPort]
  >(
    (change): Promise<ChatCommandResult> =>
      Promise.resolve({
        commandId: change.commandId,
        revision: 8,
        outcome: 'applied',
      }),
  );
  const changeModel = jest.fn<
    Promise<ChatCommandResult>,
    [CoreChatModelChange, ChatStateCommandPort]
  >(
    (change): Promise<ChatCommandResult> =>
      Promise.resolve({
        commandId: change.commandId,
        revision: 8,
        outcome: 'applied',
      }),
  );
  return { host: { applySettings, changeModel }, applySettings, changeModel };
}

function update(
  runtime: ReturnType<typeof createDesktopRuntime>,
  commandId: string,
  action: unknown,
): Promise<unknown> {
  return runtime.instruction(
    'core.chat.update',
    CoreChatUpdateParamsSchema.parse({
      projectId: 'project',
      worktreeId: 'worktree',
      commandId,
      action,
      _meta: { idempotencyKey: commandId },
    }),
    { caller, metadata: { idempotencyKey: commandId } },
  );
}

function patch(value: Record<string, unknown>): unknown {
  return { type: 'chat.patch_tab_settings', tabId: 'tab', patch: value };
}

function tab(fields: Partial<PersistedChatTab>): PersistedChatTab {
  return {
    id: 'tab',
    title: 'Tab',
    createdAt: '2026-11-05T00:00:00.000Z',
    messages: [],
    ...fields,
  };
}

function makeSettingsHost(options: {
  outcome?: ChatCommandResult['outcome'];
  tabs?: (PersistedChatTab | undefined)[];
}): {
  host: CoreChatSettingsHost;
  port: ChatStateCommandPort;
  command: jest.Mock<Promise<ChatCommandResult>, [ChatCommandRequest]>;
  effects: {
    planMode: jest.Mock;
    thinkingLevel: jest.Mock;
    speed: jest.Mock;
  };
  events: string[];
} {
  const events: string[] = [];
  const { port, command } = makePort(options.outcome);
  command.mockImplementation((request) => {
    events.push('commit');
    return Promise.resolve({
      commandId: request.commandId,
      revision: 7,
      outcome: options.outcome ?? 'applied',
    });
  });
  const tabs = [...(options.tabs ?? [])];
  const effects = {
    planMode: jest.fn(() => {
      events.push('effect:plan');
      return Promise.resolve();
    }),
    thinkingLevel: jest.fn(() => {
      events.push('effect:thinking');
      return Promise.resolve();
    }),
    speed: jest.fn(() => {
      events.push('effect:speed');
      return Promise.resolve();
    }),
  };
  const dependencies: ChatSettingsHostDependencies = {
    withChatSettingsLock: jest.fn(async (_target, work) => {
      events.push('lock:enter');
      try {
        return await work();
      } finally {
        events.push('lock:exit');
      }
    }),
    readTab: jest.fn(() => Promise.resolve(tabs.shift())),
    effects,
    changeModel: jest.fn(),
  };
  return {
    host: createCoreChatSettingsHost(dependencies),
    port,
    command,
    effects,
    events,
  };
}

describe('chat settings behind core.chat.update (CAN-4110)', () => {
  describe('adapter routing', () => {
    let runtime: ReturnType<typeof createDesktopRuntime>;
    let fixture: ReturnType<typeof makePort>;
    let hostFixture: ReturnType<typeof makeHost>;

    beforeEach(() => {
      fixture = makePort();
      hostFixture = makeHost();
      setChatStateCommandPort(fixture.port);
      runtime = createDesktopRuntime({
        chatCommandPort: fixture.port,
        chatSettingsHost: hostFixture.host,
      });
    });

    afterEach(async () => {
      await runtime.shutdown();
      setChatStateCommandPort(null);
    });

    it("routes a client's plan, thinking and speed change to the settings host", async () => {
      await update(runtime, 'plan-1', patch({ planMode: true }));
      await update(
        runtime,
        'thinking-1',
        patch({ modelConfig: { thinkingLevel: 'high', speed: 'fast' } }),
      );
      await update(
        runtime,
        'fast-1',
        patch({ modelConfig: { fastMode: true } }),
      );
      expect(hostFixture.applySettings.mock.calls.map(([c]) => c)).toEqual([
        { commandId: 'plan-1', target, planMode: true },
        {
          commandId: 'thinking-1',
          target,
          thinkingLevel: 'high',
          speed: 'fast',
        },
        { commandId: 'fast-1', target, speed: 'fast' },
      ]);
      expect(fixture.command).not.toHaveBeenCalled();
    });

    it("routes a client's model change to the host and refuses main-only fields", async () => {
      const action = {
        type: 'chat.set_model',
        tabId: 'tab',
        model: 'claude-sonnet-4-5',
        providerType: 'claude',
      };
      await update(runtime, 'model-1', action);
      expect(hostFixture.changeModel).toHaveBeenCalledTimes(1);
      expect(hostFixture.changeModel.mock.calls[0]?.[0]).toEqual({
        commandId: 'model-1',
        target,
        model: 'claude-sonnet-4-5',
      });
      await expect(
        update(runtime, 'model-2', {
          ...action,
          preserveModelSelectionMode: true,
        }),
      ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
      expect(hostFixture.changeModel).toHaveBeenCalledTimes(1);
      expect(fixture.command).not.toHaveBeenCalled();
    });

    it('refuses mixed and contradictory settings patches', async () => {
      const refused = [
        { planMode: true, customTitle: 'x' },
        { modelConfig: { speed: 'ultrafast', fastMode: true } },
        { thinkingLevel: 'high', modelConfig: { thinkingLevel: 'low' } },
        { modelConfig: {} },
      ];
      for (const [index, value] of refused.entries())
        await expect(
          update(runtime, `refused-${String(index)}`, patch(value)),
        ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
      expect(fixture.command).not.toHaveBeenCalled();
      expect(hostFixture.applySettings).not.toHaveBeenCalled();
      expect(hostFixture.changeModel).not.toHaveBeenCalled();
    });

    it('keeps captured desktop commands and other patches on the port', async () => {
      const request: ChatCommandRequest = {
        schemaVersion: 1,
        commandId: 'captured-plan',
        projectId: 'project',
        worktreeId: 'worktree',
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'tab',
          patch: { planMode: true },
        },
      };
      await expect(
        dispatchTrustedChatCommand(
          request,
          createChatCommandDispatchOptions(fixture.port, runtime, caller),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });
      expect(fixture.command).toHaveBeenCalledTimes(1);
      expect(fixture.command).toHaveBeenCalledWith(request);
      await update(runtime, 'rename-1', patch({ customTitle: 'Renamed' }));
      expect(fixture.command).toHaveBeenCalledTimes(2);
      expect(hostFixture.applySettings).not.toHaveBeenCalled();
    });

    it('validates chat ids before routing to the host', async () => {
      await expect(
        update(runtime, 'bad-tab', {
          type: 'chat.patch_tab_settings',
          tabId: '../tab',
          patch: { planMode: true },
        }),
      ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
      expect(hostFixture.applySettings).not.toHaveBeenCalled();
    });

    it('never routes approval mode to the host', async () => {
      await expect(
        update(runtime, 'approval-1', {
          type: 'chat.set_approval_mode',
          tabId: 'tab',
          approvalMode: 'auto',
        }),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
      expect(hostFixture.applySettings).not.toHaveBeenCalled();
      expect(hostFixture.changeModel).not.toHaveBeenCalled();
    });
  });

  it('fails closed without a settings host', async () => {
    const { port, command } = makePort();
    setChatStateCommandPort(port);
    const runtime = createDesktopRuntime({
      chatCommandPort: port,
      chatSettingsHost: null,
    });
    try {
      await expect(
        update(runtime, 'plan-1', patch({ planMode: true })),
      ).rejects.toMatchObject({
        payload: {
          kind: 'unavailable',
          retry: { kind: 'same_idempotency_key' },
        },
      });
      expect(command).not.toHaveBeenCalled();
    } finally {
      await runtime.shutdown();
      setChatStateCommandPort(null);
    }
  });

  describe('settings host', () => {
    it("commits under the chat lock with the caller's command id, then runs the plan effect", async () => {
      const fixture = makeSettingsHost({ tabs: [tab({ planMode: true })] });
      const result = await fixture.host.applySettings(
        { commandId: 'plan-1', target, planMode: true },
        fixture.port,
      );
      expect(result.outcome).toBe('applied');
      expect(fixture.command).toHaveBeenCalledWith({
        schemaVersion: 1,
        commandId: 'plan-1',
        projectId: 'project',
        worktreeId: 'worktree',
        command: {
          type: 'chat.patch_tab_settings',
          tabId: 'tab',
          patch: { planMode: true },
        },
      });
      expect(fixture.effects.planMode).toHaveBeenCalledWith(target, true);
      expect(fixture.events).toEqual([
        'lock:enter',
        'commit',
        'effect:plan',
        'lock:exit',
      ]);
    });

    it('merges thinking and speed into the committed model config', async () => {
      const current = {
        modelConfig: {
          thinkingLevel: 'low' as const,
          speed: 'standard' as const,
          fastMode: false,
        },
      };
      const thinking = makeSettingsHost({ tabs: [tab(current)] });
      await thinking.host.applySettings(
        { commandId: 'thinking-1', target, thinkingLevel: 'high' },
        thinking.port,
      );
      expect(thinking.command.mock.calls[0]?.[0].command).toEqual({
        type: 'chat.patch_tab_settings',
        tabId: 'tab',
        patch: {
          modelConfig: {
            thinkingLevel: 'high',
            speed: 'standard',
            fastMode: false,
          },
        },
      });
      const speed = makeSettingsHost({ tabs: [tab(current)] });
      await speed.host.applySettings(
        { commandId: 'speed-1', target, speed: 'fast' },
        speed.port,
      );
      expect(speed.command.mock.calls[0]?.[0].command).toEqual({
        type: 'chat.patch_tab_settings',
        tabId: 'tab',
        patch: {
          modelConfig: { thinkingLevel: 'low', speed: 'fast', fastMode: true },
        },
      });
    });

    it('changes no session when a newer change already replaced the value', async () => {
      const fixture = makeSettingsHost({
        outcome: 'already_applied',
        tabs: [tab({ planMode: false })],
      });
      const result = await fixture.host.applySettings(
        { commandId: 'plan-1', target, planMode: true },
        fixture.port,
      );
      expect(result.outcome).toBe('already_applied');
      expect(fixture.effects.planMode).not.toHaveBeenCalled();
    });

    it('applies a queued hook chat change for a chat without a tab', async () => {
      const fixture = makeSettingsHost({ outcome: 'not_found' });
      await fixture.host.applySettings(
        { commandId: 'plan-1', target, planMode: true },
        fixture.port,
      );
      expect(fixture.effects.planMode).toHaveBeenCalledWith(target, true);
    });

    it('keeps a replayed model change for a chat without a tab', () => {
      expect(isModelChangeSuperseded(undefined, 'model-a')).toBe(false);
      expect(
        isModelChangeSuperseded(tab({ model: 'model-a' }), 'model-a'),
      ).toBe(false);
      expect(
        isModelChangeSuperseded(tab({ model: 'model-b' }), 'model-a'),
      ).toBe(true);
    });

    it('runs no effect after a conflict', async () => {
      const fixture = makeSettingsHost({
        outcome: 'conflict',
        tabs: [tab({ planMode: true })],
      });
      const result = await fixture.host.applySettings(
        { commandId: 'plan-1', target, planMode: true },
        fixture.port,
      );
      expect(result).toMatchObject({
        commandId: 'plan-1',
        outcome: 'conflict',
      });
      expect(fixture.effects.planMode).not.toHaveBeenCalled();
    });
  });
});
