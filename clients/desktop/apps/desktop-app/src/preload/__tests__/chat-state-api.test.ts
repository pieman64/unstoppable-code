import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  ChatCommandRequest,
  ChatStateChangedEvent,
} from '@canopy/desktop-shared/types';
import type { ChatEvent } from '@canopy/desktop-shared/types';
import { createChatStateApi } from '../api/chat-state-api';
import { createChatEventSubscription } from '../api/chat-event-api';
import {
  ChatEventOutputEncoder,
  type ChatEventMessage,
} from '@canopy/desktop-shared/lib/chat-event-output';

type Listener = (event: unknown, payload: ChatStateChangedEvent) => void;

describe('chat state preload API', () => {
  const invoke = jest.fn();
  const on = jest.fn<void, [string, Listener]>();
  const removeListener = jest.fn<void, [string, Listener]>();

  beforeEach(() => jest.clearAllMocks());

  it('invokes the typed query and command channels', async () => {
    const api = createChatStateApi({ invoke, on, removeListener });
    await api.getState({ projectId: 'project-1', worktreeId: 'worktree-1' });
    const request: ChatCommandRequest = {
      schemaVersion: 1,
      commandId: 'command-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      command: { type: 'chat.activate_tab', tabId: 'chat-1' },
    };
    await api.command(request);
    await api.cancelToolOutput({ requestId: 'output-request-1' });
    expect(invoke).toHaveBeenNthCalledWith(1, IPC_CHANNELS.chatGetState, {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      IPC_CHANNELS.chatCommand,
      request,
    );
    expect(invoke).toHaveBeenNthCalledWith(
      3,
      IPC_CHANNELS.chatCancelToolOutput,
      { requestId: 'output-request-1' },
    );
  });

  it('invokes the visual read channel with the typed request', async () => {
    const api = createChatStateApi({ invoke, on, removeListener });
    const request = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      messageId: 'message-1',
      toolUseId: 'tool-1',
      reference: {
        version: 1 as const,
        visualId: 'vis_12345678-1234-1234-1234-123456789abc',
        artifactId: `sha256-v1-${'a'.repeat(64)}`,
        byteLength: 4,
        sha256: 'a'.repeat(64),
        mediaType: 'text/html' as const,
        title: 'Chart',
        maxHeight: 400,
      },
      offset: 0,
      limit: 4,
    };
    await api.readVisual(request);
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.chatReadVisual, request);
  });

  it('removes only its own state listener and makes cleanup idempotent', () => {
    const api = createChatStateApi({ invoke, on, removeListener });
    const callback = jest.fn();
    const unsubscribe = api.onStateChanged(callback);
    const registered = on.mock.calls[0]?.[1];
    expect(registered).toBeDefined();
    const event = {
      schemaVersion: 1,
      eventId: 'event-1',
      occurredAt: '2026-08-07T00:00:00.000Z',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      baseRevision: 1,
      revision: 2,
      changes: [],
    } satisfies ChatStateChangedEvent;
    registered?.({}, event);
    expect(callback).toHaveBeenCalledWith(event);
    unsubscribe();
    unsubscribe();
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.chatStateChanged,
      registered,
    );
  });

  it('declares the window’s tracked scopes on their own channel', async () => {
    const api = createChatStateApi({ invoke, on, removeListener });
    await api.setStateScopes({
      kind: 'scopes',
      scopes: [{ projectId: 'project-1', worktreeId: 'worktree-1' }],
    });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.chatSetStateScopes, {
      kind: 'scopes',
      scopes: [{ projectId: 'project-1', worktreeId: 'worktree-1' }],
    });
  });

  it('declares the window’s chat interest on its own channel', async () => {
    const api = createChatStateApi({ invoke, on, removeListener });
    const declaration = {
      focused: [
        { projectId: 'project-1', worktreeId: 'worktree-1', chatId: 'chat-1' },
      ],
      warm: [],
    };
    await api.setInterest(declaration);
    expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.chatSetInterest,
      declaration,
    );
  });

  it('serves every state subscriber from one IPC listener', () => {
    const api = createChatStateApi({ invoke, on, removeListener });
    const first = jest.fn();
    const second = jest.fn();
    const third = jest.fn();
    const unsubscribeFirst = api.onStateChanged(first);
    const unsubscribeSecond = api.onStateChanged(second);
    const unsubscribeThird = api.onStateChanged(third);
    expect(on).toHaveBeenCalledTimes(1);
    const registered = on.mock.calls[0]?.[1];
    const event = {
      schemaVersion: 1,
      eventId: 'event-2',
      occurredAt: '2026-08-07T00:00:00.000Z',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      baseRevision: 2,
      revision: 3,
      changes: [],
    } satisfies ChatStateChangedEvent;
    unsubscribeSecond();
    registered?.({}, event);
    expect(first).toHaveBeenCalledWith(event);
    expect(second).not.toHaveBeenCalled();
    expect(third).toHaveBeenCalledWith(event);
    unsubscribeFirst();
    expect(removeListener).not.toHaveBeenCalled();
    unsubscribeThird();
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.chatStateChanged,
      registered,
    );
  });
});

describe('chat event preload subscription', () => {
  it('serves every chat event subscriber from one IPC listener', () => {
    type EventListener = (event: unknown, payload: ChatEvent) => void;
    const on = jest.fn<void, [string, EventListener]>();
    const removeListener = jest.fn<void, [string, EventListener]>();
    const invoke = jest.fn<Promise<void>, [string, string]>(() =>
      Promise.resolve(),
    );
    const onChatEvent = createChatEventSubscription({
      on,
      removeListener,
      invoke,
    });
    const first = jest.fn();
    const second = jest.fn();
    const unsubscribeFirst = onChatEvent(first);
    const unsubscribeSecond = onChatEvent(second);
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]?.[0]).toBe(IPC_CHANNELS.chatEvent);
    // The new decoder asks main for full values under an id main accepts.
    expect(invoke.mock.calls).toEqual([
      [
        IPC_CHANNELS.chatEventOutputReset,
        expect.stringMatching(/^[0-9a-f]{32}$/),
      ],
    ]);
    const registered = on.mock.calls[0]?.[1];
    const event: ChatEvent = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      data: { type: 'system' },
    };
    registered?.({}, event);
    unsubscribeFirst();
    registered?.({}, event);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    unsubscribeSecond();
    expect(removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.chatEvent,
      registered,
    );
  });

  it('rebuilds Codex command output appends before any subscriber sees them, with a reset per registration', () => {
    type EventListener = (event: unknown, payload: ChatEventMessage) => void;
    const on = jest.fn<void, [string, EventListener]>();
    const removeListener = jest.fn<void, [string, EventListener]>();
    const invoke = jest.fn<Promise<void>, [string, string]>(() =>
      Promise.resolve(),
    );
    let epochs = 0;
    const onChatEvent = createChatEventSubscription(
      { on, removeListener, invoke },
      { newEpoch: (): string => `epoch-${++epochs}` },
    );
    let rev = 0;
    const encoder = new ChatEventOutputEncoder({
      nextRev: (): number => ++rev,
      heads: [],
    });
    const update = (output: string): ChatEvent => ({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      data: {
        type: 'codex',
        event: {
          type: 'item.updated',
          item: {
            type: 'command_execution',
            id: 'cmd-1',
            aggregated_output: output,
          },
        },
      },
    });
    const first = jest.fn();
    const second = jest.fn();
    const unsubscribeFirst = onChatEvent(first);
    const unsubscribeSecond = onChatEvent(second);
    expect(invoke.mock.calls).toEqual([
      [IPC_CHANNELS.chatEventOutputReset, 'epoch-1'],
    ]);
    encoder.reset('epoch-1');
    const registered = on.mock.calls[0]?.[1];
    const events = [update('one\n'), update('one\ntwo\n')];
    const messages = events.map((event) => encoder.encode(event));
    expect(JSON.stringify(messages[1])).not.toContain('one');
    for (const message of messages) registered?.({}, structuredClone(message));

    expect(first.mock.calls).toEqual(events.map((event) => [event]));
    expect(second.mock.calls).toEqual(events.map((event) => [event]));

    // The last subscriber leaving drops the decoder; the next one asks again.
    unsubscribeFirst();
    unsubscribeSecond();
    const third = jest.fn();
    onChatEvent(third);
    expect(invoke.mock.calls.map((call) => call[1])).toEqual([
      'epoch-1',
      'epoch-2',
    ]);
    const appended = encoder.encode(update('one\ntwo\nthree\n'));
    on.mock.calls[1]?.[1]({}, structuredClone(appended));
    expect(third).not.toHaveBeenCalled();
  });
});
