import {
  APP_ADVISOR_PROJECT_ID,
  type ChatCommandRequest,
  type ChatCommandResult,
  type ChatGetStateRequest,
  type ChatRuntimeState,
  type ChatStateChangedEvent,
  type ChatStateCommandPort,
  type ChatStateSnapshot,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type {
  CanopyCallerDescriptor,
  CanopyStreamEnd,
  CanopyStreamItem,
} from '@canopy/protocol/canopy-core';
import type { CanopyStreamFrame } from '@canopy/core-runtime';
import { setChatStateCommandPort } from '../../ipc/chat-state';
import { ChatCommandKeyFingerprints } from '../chat-command-key-fingerprints';
import type { CoreChatTurnCancelHost } from '../core-chat-turn-adapter';
import { createDesktopRuntime } from '../desktop-runtime';

type ChatFrame = CanopyStreamFrame<
  CanopyStreamItem<'core.chat.events'>,
  CanopyStreamEnd<'core.chat.events'>
>;

interface MemoryScope {
  tabs: PersistedChatTab[];
  runtime: Record<string, ChatRuntimeState>;
  revision: number;
}

const scopeKey = (projectId: string, worktreeId: string): string =>
  JSON.stringify([projectId, worktreeId]);

class MemoryChatStatePort implements ChatStateCommandPort {
  public readonly received: ChatCommandRequest[] = [];
  public readonly applied = new Map<string, number>();
  public readonly listeners = new Set<(event: ChatStateChangedEvent) => void>();
  public holdSend: Promise<void> | null = null;
  public sendFinished: Promise<void> | null = null;
  public readonly failOnce = new Set<string>();
  private readonly scopes = new Map<string, MemoryScope>();
  private readonly receipts = new Map<string, ChatCommandResult>();

  public readonly getTranscriptPage = jest.fn();
  public readonly searchTranscript = jest.fn();
  public readonly readToolOutput = jest.fn();
  public readonly readVisual = jest.fn();

  public subscribe(
    listener: (event: ChatStateChangedEvent) => void,
  ): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  public getState(request: ChatGetStateRequest): Promise<ChatStateSnapshot> {
    const scope = this.scope(request.projectId, request.worktreeId);
    return Promise.resolve({
      schemaVersion: 1,
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      revision: scope.revision,
      tabsFile: {
        version: 1,
        activeTabId: scope.tabs[0]?.id ?? null,
        tabs: structuredClone(scope.tabs),
      },
      archives: [],
      runtimeByChatId: structuredClone(scope.runtime),
      queue: [],
    });
  }

  public async command(
    request: ChatCommandRequest,
  ): Promise<ChatCommandResult> {
    this.received.push(request);
    if (this.failOnce.delete(request.commandId))
      throw new Error('The chat service failed.');
    const receiptKey = JSON.stringify([
      request.projectId,
      request.worktreeId,
      request.commandId,
    ]);
    const receipt = this.receipts.get(receiptKey);
    if (receipt) return { ...receipt, outcome: 'already_applied' };
    const scope = this.scope(request.projectId, request.worktreeId);
    const command = request.command;
    let tab: PersistedChatTab | undefined;
    if (command.type === 'chat.create_tab') {
      tab = {
        id: command.tabId,
        title: 'New chat',
        createdAt: '2026-11-05T00:00:00.000Z',
        messages: [],
      };
      scope.tabs.push(tab);
    } else if (command.type === 'chat.patch_tab_settings') {
      const index = scope.tabs.findIndex((entry) => entry.id === command.tabId);
      const current = scope.tabs[index];
      if (!current)
        return {
          commandId: request.commandId,
          revision: scope.revision,
          outcome: 'not_found',
        };
      const patched = Object.assign(structuredClone(current), command.patch);
      scope.tabs[index] = patched;
      tab = patched;
    } else if (command.type === 'chat.send_message') {
      const hold = this.holdSend;
      let finish = (): void => undefined;
      this.sendFinished = new Promise((resolve) => {
        finish = resolve;
      });
      scope.runtime[command.chatId] = {
        status: 'streaming',
        queuedMessageIds: [],
      };
      if (hold) await hold;
      tab = scope.tabs.find((entry) => entry.id === command.chatId);
      tab?.messages.push({
        id: command.userMessageId,
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: command.text }],
      });
      finish();
    } else {
      return {
        commandId: request.commandId,
        revision: scope.revision,
        outcome: 'rejected',
        reason: 'Unsupported in this port.',
      };
    }
    this.applied.set(command.type, (this.applied.get(command.type) ?? 0) + 1);
    scope.revision += 1;
    const result: ChatCommandResult = {
      commandId: request.commandId,
      revision: scope.revision,
      outcome: 'applied',
      ...(tab ? { entityId: tab.id } : {}),
    };
    this.receipts.set(receiptKey, result);
    if (tab) {
      const event: ChatStateChangedEvent = {
        schemaVersion: 1,
        eventId: `event-${request.commandId}`,
        occurredAt: '2026-11-05T00:00:00.000Z',
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        baseRevision: scope.revision - 1,
        revision: scope.revision,
        changes: [{ type: 'tab.upserted', tab: structuredClone(tab) }],
      };
      for (const listener of Array.from(this.listeners)) listener(event);
    }
    return result;
  }

  private scope(projectId: string, worktreeId: string): MemoryScope {
    const key = scopeKey(projectId, worktreeId);
    let scope = this.scopes.get(key);
    if (!scope) {
      scope = { tabs: [], runtime: {}, revision: 0 };
      this.scopes.set(key, scope);
    }
    return scope;
  }
}

const client = (clientInstanceId: string): CanopyCallerDescriptor => ({
  principalId: 'local-desktop-user',
  clientInstanceId,
  authorityId: 'local-desktop',
  interfaceKind: 'test',
  grants: ['core.chat.read', 'core.chat.write'],
});
const clientA = client('client-a');
const clientB = client('client-b');

function makeRuntime(): {
  port: MemoryChatStatePort;
  stop: jest.Mock;
  runtime: ReturnType<typeof createDesktopRuntime>;
} {
  const port = new MemoryChatStatePort();
  const stop = jest.fn(() => Promise.resolve(null));
  const turnCancelHost: CoreChatTurnCancelHost = {
    scopesForChat: () => Promise.resolve([]),
    getState: (scope) => port.getState(scope),
    stop,
  };
  // The lifecycle adapter reads the port main installs for chat IPC.
  setChatStateCommandPort(port);
  const runtime = createDesktopRuntime({
    chatCommandPort: port,
    getChatStatePort: () => port,
    turnCancelHost,
  });
  return { port, stop, runtime };
}

function createChat(
  runtime: ReturnType<typeof createDesktopRuntime>,
  caller: CanopyCallerDescriptor,
  scope: { projectId: string; worktreeId: string },
  commandId: string,
  tabId: string,
): ReturnType<ReturnType<typeof createDesktopRuntime>['instruction']> {
  return runtime.instruction(
    'core.chat.create',
    {
      ...scope,
      commandId,
      action: { type: 'chat.create_tab', tabId },
      _meta: { idempotencyKey: commandId },
    },
    { caller, metadata: { idempotencyKey: commandId } },
  );
}

async function nextFrame(frames: AsyncIterator<ChatFrame>): Promise<ChatFrame> {
  const result = await frames.next();
  if (result.done) throw new Error('Stream ended before the terminal frame.');
  return result.value;
}

const worktree = { projectId: 'workspace-1', worktreeId: 'worktree-1' };

describe('chat lifecycle in the desktop core (CAN-4110)', () => {
  afterEach(() => {
    setChatStateCommandPort(null);
  });

  it('two clients see one chat and its settings', async () => {
    const { runtime } = makeRuntime();
    await expect(
      createChat(runtime, clientA, worktree, 'create-1', 'chat-1'),
    ).resolves.toMatchObject({ outcome: 'applied' });
    const events = await runtime.openStream(
      'core.chat.events',
      { scope: worktree },
      { caller: clientB },
    );
    try {
      await new Promise(setImmediate);
      const frames = events.frames[Symbol.asyncIterator]();
      const before = await runtime.query(
        'core.chat.snapshot.get',
        {
          scope: {
            workspaceId: worktree.projectId,
            worktreeId: worktree.worktreeId,
          },
        },
        { caller: clientB },
      );
      expect(before.tabs.items.map((tab) => tab.chatId)).toEqual(['chat-1']);
      await expect(
        runtime.instruction(
          'core.chat.update',
          {
            ...worktree,
            commandId: 'rename-1',
            action: {
              type: 'chat.patch_tab_settings',
              tabId: 'chat-1',
              patch: { customTitle: 'Renamed' },
            },
            _meta: { idempotencyKey: 'rename-1' },
          },
          { caller: clientA, metadata: { idempotencyKey: 'rename-1' } },
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });
      const frame = await nextFrame(frames);
      if (frame.kind !== 'item') throw new Error('Expected a chat event.');
      expect(frame.item.changes).toMatchObject([
        {
          type: 'tab.upserted',
          tab: { id: 'chat-1', customTitle: 'Renamed' },
        },
      ]);
      const after = await runtime.query(
        'core.chat.snapshot.get',
        {
          scope: {
            workspaceId: worktree.projectId,
            worktreeId: worktree.worktreeId,
          },
        },
        { caller: clientB },
      );
      expect(after.tabs.items[0]).toMatchObject({
        chatId: 'chat-1',
        title: 'Renamed',
        settings: { customTitle: 'Renamed' },
      });
    } finally {
      events.close();
      await runtime.shutdown();
    }
  });

  it('replays an acknowledged command and refuses a reused key with other params', async () => {
    const { port, runtime } = makeRuntime();
    try {
      await expect(
        createChat(runtime, clientA, worktree, 'k1', 'chat-1'),
      ).resolves.toMatchObject({ outcome: 'applied' });
      await expect(
        createChat(runtime, clientA, worktree, 'k1', 'chat-1'),
      ).resolves.toMatchObject({ outcome: 'already_applied' });
      expect(port.applied.get('chat.create_tab')).toBe(1);
      const received = port.received.length;
      await expect(
        createChat(runtime, clientB, worktree, 'k1', 'chat-2'),
      ).rejects.toMatchObject({
        payload: { kind: 'conflict', retry: { kind: 'never' } },
      });
      expect(port.received).toHaveLength(received);
      expect(port.applied.get('chat.create_tab')).toBe(1);
    } finally {
      await runtime.shutdown();
    }
  });

  it('releases a key whose attempt failed', async () => {
    const { port, runtime } = makeRuntime();
    try {
      port.failOnce.add('k2');
      await expect(
        createChat(runtime, clientA, worktree, 'k2', 'chat-1'),
      ).rejects.toThrow();
      await expect(
        createChat(runtime, clientA, worktree, 'k2', 'chat-2'),
      ).resolves.toMatchObject({ outcome: 'applied', entityId: 'chat-2' });
    } finally {
      await runtime.shutdown();
    }
  });

  it("keeps each chat identity's scope", async () => {
    const { port, runtime } = makeRuntime();
    const scopes = [
      { projectId: 'workspace-1', worktreeId: 'worktree-1' },
      { projectId: 'cowork-ws', worktreeId: 'entry-1' },
      { projectId: APP_ADVISOR_PROJECT_ID, worktreeId: 'advisor-entry' },
    ];
    try {
      for (const [index, scope] of scopes.entries())
        await expect(
          createChat(
            runtime,
            clientA,
            scope,
            `create-${index}`,
            `chat-${index}`,
          ),
        ).resolves.toMatchObject({ outcome: 'applied' });
      expect(
        port.received.map(({ projectId, worktreeId }) => ({
          projectId,
          worktreeId,
        })),
      ).toEqual(scopes);
      for (const [index, scope] of scopes.entries()) {
        const list = await runtime.query(
          'core.chat.list',
          {
            scope: {
              workspaceId: scope.projectId,
              worktreeId: scope.worktreeId,
            },
          },
          { caller: clientB },
        );
        expect(list.items.map((item) => item.chatId)).toEqual([
          `chat-${index}`,
        ]);
      }
    } finally {
      await runtime.shutdown();
    }
  });

  it('a disconnected client never cancels the turn', async () => {
    const { port, stop, runtime } = makeRuntime();
    try {
      await createChat(runtime, clientA, worktree, 'create-1', 'chat-1');
      const streamController = new AbortController();
      const events = await runtime.openStream(
        'core.chat.events',
        { scope: worktree },
        { caller: clientB, signal: streamController.signal },
      );
      let release = (): void => undefined;
      port.holdSend = new Promise((resolve) => {
        release = resolve;
      });
      const sendParams = {
        scope: {
          workspaceId: worktree.projectId,
          worktreeId: worktree.worktreeId,
        },
        commandId: 'send-1',
        chatId: 'chat-1',
        messageId: 'message-1',
        text: 'Keep going',
        _meta: { idempotencyKey: 'send-1' },
      };
      const requestController = new AbortController();
      const sent = runtime
        .instruction('core.chat.message.send', sendParams, {
          caller: clientA,
          metadata: { idempotencyKey: 'send-1' },
          signal: requestController.signal,
        })
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
      while (!port.sendFinished) await new Promise(setImmediate);
      requestController.abort();
      release();
      await port.sendFinished;
      const settled = await sent;
      if ('error' in settled)
        expect(settled.error).toMatchObject({
          payload: { kind: 'cancelled' },
        });
      streamController.abort();
      const frames = events.frames[Symbol.asyncIterator]();
      let terminal: ChatFrame;
      do {
        terminal = await nextFrame(frames);
      } while (terminal.kind === 'item');
      expect(terminal).toMatchObject({ kind: 'end', outcome: 'cancelled' });
      expect(stop).not.toHaveBeenCalled();
      expect(
        new Set(port.received.map((request) => request.command.type)),
      ).toEqual(new Set(['chat.create_tab', 'chat.send_message']));
      expect(port.applied.get('chat.send_message')).toBe(1);
      await expect(
        runtime.instruction('core.chat.message.send', sendParams, {
          caller: clientA,
          metadata: { idempotencyKey: 'send-1' },
        }),
      ).resolves.toMatchObject({ outcome: 'already_applied' });
      expect(stop).not.toHaveBeenCalled();
    } finally {
      await runtime.shutdown();
    }
  });

  it('refuses a key reused by another queue operation with the same params', async () => {
    const { port, runtime } = makeRuntime();
    const params = {
      scope: {
        workspaceId: worktree.projectId,
        worktreeId: worktree.worktreeId,
      },
      commandId: 'q1',
      chatId: 'chat-1',
      entryId: 'entry-1',
      _meta: { idempotencyKey: 'q1' },
    };
    const options = { caller: clientA, metadata: { idempotencyKey: 'q1' } };
    try {
      await runtime.instruction(
        'core.chat.queue.entry.cancel',
        params,
        options,
      );
      const received = port.received.length;
      await expect(
        runtime.instruction('core.chat.queue.entry.force', params, options),
      ).rejects.toMatchObject({ payload: { kind: 'conflict' } });
      expect(port.received).toHaveLength(received);
    } finally {
      await runtime.shutdown();
    }
  });

  it('keeps a key bound while another attempt holding it has not failed', () => {
    const keys = new ChatCommandKeyFingerprints();
    const scope = { projectId: 'workspace-1', worktreeId: 'worktree-1' };
    const first = keys.claim(scope, 'k3', 'core.chat.create', { tabId: 'a' });
    const duplicate = keys.claim(scope, 'k3', 'core.chat.create', {
      tabId: 'a',
    });
    first();
    let refused: unknown;
    try {
      keys.claim(scope, 'k3', 'core.chat.create', { tabId: 'b' });
    } catch (error) {
      refused = error;
    }
    expect(refused).toMatchObject({ payload: { kind: 'conflict' } });
    duplicate();
    expect(() =>
      keys.claim(scope, 'k3', 'core.chat.create', { tabId: 'b' }),
    ).not.toThrow();
  });
});
