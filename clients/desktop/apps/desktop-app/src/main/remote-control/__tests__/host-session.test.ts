import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { serialize } from 'node:v8';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IPC_CHANNELS,
  type ChatStateChangedEvent,
  type UsageLimitedChatItem,
  type ListUsageLimitedIdleChatsResponse,
} from '@canopy/desktop-shared/types';
import {
  ChatStateDelivery,
  ChatStateSubscriptions,
} from '../../ipc/chat-state-delivery';
import { filterChatStateBodies } from '../../ipc/chat-state-body-filter';
import {
  getRemoteChannelDisposition,
  getRemoteChannelDispositions,
} from '@canopy/desktop-shared/remote-control/channel-dispositions';
import type { RemoteSurface } from '@canopy/desktop-shared/remote-control/surfaces';
import { RemoteHostSession } from '../host/host-session';
import { getObservabilityService } from '../../observability';
import { RemoteUploadStore } from '../host/uploads';
import {
  REMOTE_PROTOCOL_MISMATCH_CODE,
  REMOTE_EVENTS,
  UnknownRemoteMethodError,
  isUnknownRemoteMethodError,
  REMOTE_FILE_READ_CHUNK_BYTES,
  REMOTE_METHODS,
  type AccountProxySignInCallbackParams,
  type FileReadParams,
  type AppAdvisorWindowStateParams,
  type FileReadResult,
  type HelloResult,
} from '../remote-protocol';
import { RpcPeer, RpcRemoteError } from '../transport/rpc-peer';
import type { SessionCloseReason } from '../transport/session-manager';
import { FakeBridge, FakeMainWindow, TEST_VERSION } from './host-fakes';
import { flushRelay, InMemoryRelayHub } from './in-memory-relay';
import { createTestDevice, openControlSession } from './session-pair';

const TUNNEL_CHANNEL = IPC_CHANNELS.chatSendMessage;

function firstChannelWith(disposition: 'blocked' | 'local'): string {
  for (const [channel, value] of Array.from(getRemoteChannelDispositions())) {
    if (value === disposition) return channel;
  }
  throw new Error(`No ${disposition} channel.`);
}

interface Harness {
  host: RemoteHostSession;
  controller: RpcPeer;
  bridges: FakeBridge[];
  bridgeSurfaces: RemoteSurface[];
  appAdvisorWindowRequests: unknown[];
  appAdvisorWindowStates: AppAdvisorWindowStateParams[];
  mainWindow: FakeMainWindow;
  events: Array<{ name: string; payload: unknown }>;
  authorized: { value: boolean };
  closed: { reason: SessionCloseReason | null };
  uploadsDir: string;
  fileReads: FileReadParams[];
}

const dirs: string[] = [];

/**
 * A host session and its controller. The controller says hello on the same
 * version first, as a real one does, unless `sayHello` is false.
 */
async function createHarness(
  options: {
    sayHello?: boolean;
    disposition?: typeof getRemoteChannelDisposition;
    completeAccountProxySignIn?: (
      controllerDeviceId: string,
      callback: AccountProxySignInCallbackParams,
    ) => Promise<void>;
    controllerRequests?: (method: string, params: unknown) => Promise<unknown>;
  } = {},
): Promise<Harness> {
  const hub = new InMemoryRelayHub();
  const laptop = createTestDevice(hub, 'laptop');
  const desktop = createTestDevice(hub, 'desktop');
  const { initiator, responder } = await openControlSession(laptop, desktop);
  const uploadsDir = mkdtempSync(join(tmpdir(), 'host-session-'));
  dirs.push(uploadsDir);
  const bridges: FakeBridge[] = [];
  const bridgeSurfaces: RemoteSurface[] = [];
  const appAdvisorWindowRequests: unknown[] = [];
  const appAdvisorWindowStates: AppAdvisorWindowStateParams[] = [];
  const mainWindow = new FakeMainWindow();
  const authorized = { value: true };
  const closed: { reason: SessionCloseReason | null } = { reason: null };
  const fileReads: FileReadParams[] = [];
  const host = new RemoteHostSession({
    session: responder,
    createBridge: (surface: RemoteSurface): Promise<FakeBridge> => {
      const bridge = new FakeBridge();
      bridges.push(bridge);
      bridgeSurfaces.push(surface);
      return Promise.resolve(bridge);
    },
    onAppAdvisorWindowState: (state: AppAdvisorWindowStateParams): void => {
      appAdvisorWindowStates.push(state);
    },
    mainWindowPushes: mainWindow,
    uploads: new RemoteUploadStore(uploadsDir),
    readFile: (params: FileReadParams): Promise<FileReadResult> => {
      fileReads.push(params);
      return Promise.resolve({
        fileName: 'report.pdf',
        sizeBytes: 3,
        modifiedAtMs: 1,
        bytes: new Uint8Array([1, 2, 3]),
      });
    },
    disposition: options.disposition ?? getRemoteChannelDisposition,
    isAuthorized: (): boolean => authorized.value,
    version: TEST_VERSION,
    hello: (): Pick<HelloResult, 'name' | 'platform'> => ({
      name: 'desktop',
      platform: 'linux',
    }),
    onClose: (reason: SessionCloseReason): void => {
      closed.reason = reason;
    },
    ...(options.completeAccountProxySignIn
      ? { completeAccountProxySignIn: options.completeAccountProxySignIn }
      : {}),
  });
  const events: Array<{ name: string; payload: unknown }> = [];
  const controller = new RpcPeer(initiator, {
    onRequest:
      options.controllerRequests ??
      ((method: string, params: unknown): Promise<unknown> => {
        if (method !== REMOTE_METHODS.appAdvisorWindow) {
          return Promise.reject(new Error('unused'));
        }
        appAdvisorWindowRequests.push(params);
        return Promise.resolve({ open: true, focused: true });
      }),
    onEvent: (name: string, payload: unknown): void => {
      events.push({ name, payload });
    },
  });
  if (options.sayHello !== false) {
    await controller.request(REMOTE_METHODS.hello, { version: TEST_VERSION });
  }
  return {
    host,
    controller,
    bridges,
    bridgeSurfaces,
    appAdvisorWindowRequests,
    appAdvisorWindowStates,
    mainWindow,
    events,
    authorized,
    closed,
    uploadsDir,
    fileReads,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('RemoteHostSession', () => {
  it('forwards X bodies and Y omission markers to a declared bridge, and full bodies to an undeclared bridge', async () => {
    const declared = await createHarness();
    const undeclared = await createHarness();
    await Promise.all([declared.host.start(), undeclared.host.start()]);
    const bridge = declared.bridges[0];
    const legacyBridge = undeclared.bridges[0];
    if (!bridge || !legacyBridge) throw new Error('Missing bridge');
    const subscriptions = new ChatStateSubscriptions<FakeBridge>();
    const interest = {
      focused: [{ projectId: 'project', worktreeId: 'tree', chatId: 'x' }],
      warm: [],
      acceptsMessagesOmitted: true as const,
    };
    subscriptions.declareInterest(bridge, interest);
    bridge.chatInterest = interest;
    const delivery = new ChatStateDelivery<FakeBridge>({
      deliver: (target, event): void =>
        target.push(IPC_CHANNELS.chatStateChanged, [event]),
      transform: (target, event): ChatStateChangedEvent =>
        filterChatStateBodies(subscriptions.interestOf(target), event),
      now: (): number => 1000,
      setTimer: (): (() => void) => {
        throw new Error('The leading event must not wait.');
      },
    });
    const committed: ChatStateChangedEvent = {
      schemaVersion: 1,
      eventId: 'commit',
      occurredAt: '2026-10-13T00:00:00.000Z',
      projectId: 'project',
      worktreeId: 'tree',
      baseRevision: 0,
      revision: 1,
      changes: ['x', 'y'].map((chatId) => ({
        type: 'message.upserted',
        chatId,
        message: {
          id: chatId,
          role: 'assistant',
          blocks: [{ type: 'text', text: chatId }],
          timestamp: 1,
        },
      })),
    };
    try {
      delivery.publish(committed, [bridge, legacyBridge]);
      await flushRelay();
      expect(
        declared.events.filter((entry) => entry.name === REMOTE_EVENTS.push),
      ).toEqual([
        {
          name: REMOTE_EVENTS.push,
          payload: {
            channel: IPC_CHANNELS.chatStateChanged,
            surface: 'main',
            args: [
              {
                ...committed,
                changes: [
                  committed.changes[0],
                  { type: 'messages.omitted', chatId: 'y' },
                ],
              },
            ],
          },
        },
      ]);
      expect(
        undeclared.events.filter((entry) => entry.name === REMOTE_EVENTS.push),
      ).toEqual([
        {
          name: REMOTE_EVENTS.push,
          payload: {
            channel: IPC_CHANNELS.chatStateChanged,
            surface: 'main',
            args: [committed],
          },
        },
      ]);
    } finally {
      delivery.dispose();
      declared.host.close('closed');
      undeclared.host.close('closed');
    }
  });

  it('filters each declared session independently, while undeclared and terminal pushes pass', async () => {
    const sessions = await Promise.all([
      createHarness(),
      createHarness(),
      createHarness(),
    ]);
    await Promise.all(sessions.map((harness) => harness.host.start()));
    const x = { projectId: 'project', worktreeId: 'tree', chatId: 'x' };
    const y = { ...x, chatId: 'y' };
    const first = sessions[0];
    const second = sessions[1];
    const undeclared = sessions[2];
    if (!first || !second || !undeclared) throw new Error('Missing session');
    const firstBridge = first.bridges[0];
    const secondBridge = second.bridges[0];
    if (!firstBridge || !secondBridge) throw new Error('Missing bridge');
    firstBridge.chatInterest = { focused: [x], warm: [] };
    secondBridge.chatInterest = { focused: [y], warm: [] };
    const pushes = [
      { ...x, data: { type: 'codex', event: { type: 'item.updated' } } },
      { ...y, data: { type: 'codex', event: { type: 'item.updated' } } },
      { ...y, data: { type: 'codex', event: { type: 'turn.completed' } } },
      { ...y, data: { type: 'result' } },
      { ...y, data: { type: 'error' } },
      { ...y, data: { type: 'system' } },
      { ...y, data: { type: 'tool_use' } },
      { ...y, data: { type: 'tool_result' } },
      { ...y, data: { type: 'turn_diff' } },
      { ...y, data: { type: 'canopy_user_prompt_accepted' } },
    ];
    for (const harness of sessions) {
      for (const push of pushes)
        harness.mainWindow.publish(IPC_CHANNELS.chatEvent, [push]);
    }
    await flushRelay();
    const received = (harness: Harness): unknown[] =>
      harness.events
        .filter((entry) => entry.name === REMOTE_EVENTS.push)
        .map((entry) => entry.payload);
    expect(received(first)).toHaveLength(pushes.length - 1);
    expect(received(second)).toHaveLength(pushes.length - 1);
    expect(received(undeclared)).toHaveLength(pushes.length);
    expect(received(first)).not.toContainEqual({
      channel: IPC_CHANNELS.chatEvent,
      args: [pushes[1]],
    });
    expect(received(second)).not.toContainEqual({
      channel: IPC_CHANNELS.chatEvent,
      args: [pushes[0]],
    });
  });
  it('identifies the computer and replays tunneled calls through a bridge', async () => {
    const harness = await createHarness();
    await expect(
      harness.controller.request(REMOTE_METHODS.hello, {
        version: TEST_VERSION,
      }),
    ).resolves.toEqual({
      name: 'desktop',
      platform: 'linux',
      appVersion: '1.0.0',
      version: TEST_VERSION,
    });
    await expect(
      harness.controller.request(REMOTE_METHODS.invoke, {
        channel: TUNNEL_CHANNEL,
        args: [{ text: 'hi' }],
      }),
    ).resolves.toEqual({ echoed: TUNNEL_CHANNEL, args: [{ text: 'hi' }] });
    expect(harness.bridges).toHaveLength(1);
  });

  it.each([true, false, undefined])(
    'forwards optional last-step completion %s and legacy DTOs without stripping fields',
    async (finished) => {
      const harness = await createHarness();
      const chat: UsageLimitedChatItem = {
        projectId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat',
        provider: 'claude',
        chatTitle: 'Chat',
        worktreeName: 'main',
        detectedAt: 1,
        lastStep: {
          toolName: 'Edit',
          ...(finished === undefined ? {} : { finished }),
        },
      };
      const response: ListUsageLimitedIdleChatsResponse = [
        {
          workspaceId: 'workspace',
          workspaceName: 'Workspace',
          workspaceType: 'single-repo',
          chats: [chat],
        },
      ];
      await harness.host.start();
      harness.bridges[0].handler = (): Promise<unknown> =>
        Promise.resolve(response);
      await expect(
        harness.controller.request(REMOTE_METHODS.invoke, {
          channel: IPC_CHANNELS.listUsageLimitedIdleChats,
          args: [{ provider: 'claude', includeResumePreview: true }],
        }),
      ).resolves.toEqual(response);
    },
  );

  it('refuses channels that are not tunneled, before any bridge runs them', async () => {
    const harness = await createHarness();
    for (const channel of [
      firstChannelWith('local'),
      firstChannelWith('blocked'),
    ]) {
      await expect(
        harness.controller.request(REMOTE_METHODS.invoke, {
          channel,
          args: [],
        }),
      ).rejects.toThrow();
    }
    expect(harness.bridges.flatMap((bridge) => bridge.invocations)).toEqual([]);
  });

  it('reports PR search unavailable on an older host and keeps the session usable', async () => {
    const harness = await createHarness({
      disposition: (channel) =>
        channel === IPC_CHANNELS.githubSearchPullRequests
          ? 'blocked'
          : getRemoteChannelDisposition(channel),
    });
    await expect(
      harness.controller.request(REMOTE_METHODS.invoke, {
        channel: IPC_CHANNELS.githubSearchPullRequests,
        args: [{ repoPath: '/repo', query: 'older title' }],
      }),
    ).rejects.toMatchObject({ code: 'remote_channel_unavailable' });
    expect(harness.bridges.flatMap((bridge) => bridge.invocations)).toEqual([]);
    await expect(
      harness.controller.request(REMOTE_METHODS.invoke, {
        channel: IPC_CHANNELS.githubListPullRequests,
        args: [{ repoPath: '/repo' }],
      }),
    ).resolves.toEqual({
      echoed: IPC_CHANNELS.githubListPullRequests,
      args: [{ repoPath: '/repo' }],
    });
  });

  it('stores uploads and answers with their path on this computer', async () => {
    const harness = await createHarness();
    const result = await harness.controller.request(REMOTE_METHODS.uploadPut, {
      fileName: 'notes.md',
      bytes: new TextEncoder().encode('hello'),
    });
    if (
      typeof result !== 'object' ||
      result === null ||
      !('path' in result) ||
      typeof result.path !== 'string'
    ) {
      throw new Error('Expected an upload path.');
    }
    expect(result.path.startsWith(harness.uploadsDir)).toBe(true);
    expect(readFileSync(result.path, 'utf8')).toBe('hello');
  });

  it('serves file reads and refuses parts larger than one read', async () => {
    const harness = await createHarness();
    const target = { absolutePath: '/Users/host/report.pdf' };
    await expect(
      harness.controller.request(REMOTE_METHODS.fileRead, {
        ...target,
        offset: 0,
        length: REMOTE_FILE_READ_CHUNK_BYTES,
      }),
    ).resolves.toEqual({
      fileName: 'report.pdf',
      sizeBytes: 3,
      modifiedAtMs: 1,
      bytes: new Uint8Array([1, 2, 3]),
    });
    await expect(
      harness.controller.request(REMOTE_METHODS.fileRead, {
        ...target,
        offset: 0,
        length: REMOTE_FILE_READ_CHUNK_BYTES + 1,
      }),
    ).rejects.toThrow();
    expect(harness.fileReads).toEqual([
      { ...target, offset: 0, length: REMOTE_FILE_READ_CHUNK_BYTES },
    ]);
  });

  it('names the methods it does not serve', async () => {
    const harness = await createHarness();
    await expect(
      harness.controller.request('file.unknown', null),
    ).rejects.toMatchObject({
      message: 'Unknown remote method file.unknown.',
      code: 'remote_unknown_method',
    });
  });

  it('forwards only tunneled pushes, without duplicates', async () => {
    const harness = await createHarness();
    await harness.host.start();
    const local = firstChannelWith('local');
    harness.mainWindow.publish(TUNNEL_CHANNEL, [1]);
    // The same push seen by both the main window and the bridge goes once.
    harness.bridges[0]?.push(TUNNEL_CHANNEL, [1]);
    harness.mainWindow.publish(local, [2]);
    await flushRelay();
    expect(
      harness.events.filter((event) => event.name === REMOTE_EVENTS.push),
    ).toEqual([
      {
        name: REMOTE_EVENTS.push,
        payload: { channel: TUNNEL_CHANNEL, args: [1] },
      },
    ]);
  });

  it('records only serialized forwarded pushes and duplicate drops on close', async () => {
    const diagnostics = jest
      .spyOn(getObservabilityService(), 'recordAppDiagnostic')
      .mockImplementation(() => undefined);
    try {
      const harness = await createHarness();
      await harness.host.start();
      const bridge = harness.bridges[0];
      if (!bridge) throw new Error('Expected bridge.');
      bridge.chatInterest = {
        focused: [
          { projectId: 'project', worktreeId: 'tree', chatId: 'visible' },
        ],
        warm: [],
      };
      const args = [
        {
          projectId: 'project',
          worktreeId: 'tree',
          chatId: 'visible',
          data: {},
        },
      ];
      harness.mainWindow.publish(IPC_CHANNELS.chatEvent, args);
      bridge.push(IPC_CHANNELS.chatEvent, args);
      harness.host.close('closed');
      const expectedBytes = serialize({
        kind: 'event',
        name: REMOTE_EVENTS.push,
        payload: { channel: IPC_CHANNELS.chatEvent, args },
      }).byteLength;
      expect(diagnostics).toHaveBeenCalledTimes(1);
      const record = diagnostics.mock.calls[0]?.[0];
      expect(record?.kind).toBe('remote_push_summary');
      expect(record?.remotePushSummary).toMatchObject({
        interestDeclared: true,
        duplicateDrops: 1,
        chatEvent: {
          pushes: 1,
          bytes: expectedBytes,
          onScreenPushes: 1,
          onScreenBytes: expectedBytes,
        },
      });
    } finally {
      diagnostics.mockRestore();
    }
  });

  it('ends the session at the next request once the controller is no longer allowed', async () => {
    const harness = await createHarness();
    await harness.controller.request(REMOTE_METHODS.invoke, {
      channel: TUNNEL_CHANNEL,
      args: [],
    });
    harness.authorized.value = false;
    await expect(
      harness.controller.request(REMOTE_METHODS.invoke, {
        channel: TUNNEL_CHANNEL,
        args: [],
      }),
    ).rejects.toThrow();
    await flushRelay();
    expect(harness.closed.reason).toBe('revoked');
    expect(harness.bridges[0]?.invocations).toHaveLength(1);
    expect(harness.events).toContainEqual({
      name: REMOTE_EVENTS.ended,
      payload: { reason: 'revoked' },
    });
  });

  it('tells the controller why it ended the session', async () => {
    const harness = await createHarness();
    harness.host.end('disconnected');
    await flushRelay();
    expect(harness.events).toContainEqual({
      name: REMOTE_EVENTS.ended,
      payload: { reason: 'disconnected' },
    });
    expect(harness.controller.isClosed).toBe(true);
  });

  it('ends the session when its bridge goes away', async () => {
    const harness = await createHarness();
    await harness.host.start();
    harness.bridges[0]?.destroy();
    await flushRelay();
    expect(harness.closed.reason).not.toBeNull();
    expect(harness.controller.isClosed).toBe(true);
  });

  it('destroys its bridge when the session closes', async () => {
    const harness = await createHarness();
    await harness.host.start();
    harness.controller.close('closed');
    await flushRelay();
    expect(harness.bridges[0]?.destroyed).toBe(true);
  });

  it('warms its bridge only once the controller shows the same protocol', async () => {
    const harness = await createHarness({ sayHello: false });
    await flushRelay();
    expect(harness.bridges).toHaveLength(0);
    await harness.controller.request(REMOTE_METHODS.hello, {
      version: TEST_VERSION,
    });
    await flushRelay();
    expect(harness.bridges).toHaveLength(1);
  });

  it('serves nothing to a controller on another protocol, but tells it which version this is', async () => {
    const harness = await createHarness({ sayHello: false });
    await expect(
      harness.controller.request(REMOTE_METHODS.hello, {
        version: {
          protocolVersion: TEST_VERSION.protocolVersion + 1,
          appVersion: '1.0.0',
        },
      }),
    ).resolves.toMatchObject({ version: TEST_VERSION });
    const refused = harness.controller.request(REMOTE_METHODS.invoke, {
      channel: TUNNEL_CHANNEL,
      args: [],
    });
    await expect(refused).rejects.toBeInstanceOf(RpcRemoteError);
    await expect(refused).rejects.toMatchObject({
      code: REMOTE_PROTOCOL_MISMATCH_CODE,
    });
    await expect(
      harness.controller.request(REMOTE_METHODS.uploadPut, {
        fileName: 'notes.md',
        bytes: new TextEncoder().encode('x'),
      }),
    ).rejects.toMatchObject({ code: REMOTE_PROTOCOL_MISMATCH_CODE });
    await expect(
      harness.controller.request(REMOTE_METHODS.fileRead, {
        absolutePath: '/Users/host/report.pdf',
        offset: 0,
        length: REMOTE_FILE_READ_CHUNK_BYTES,
      }),
    ).rejects.toMatchObject({ code: REMOTE_PROTOCOL_MISMATCH_CODE });
    expect(harness.fileReads).toEqual([]);
    harness.controller.notify(REMOTE_EVENTS.ipcSend, {
      channel: TUNNEL_CHANNEL,
      args: [],
    });
    harness.mainWindow.publish(TUNNEL_CHANNEL, [1]);
    await flushRelay();
    expect(harness.bridges).toHaveLength(0);
    expect(
      harness.events.filter((event) => event.name === REMOTE_EVENTS.push),
    ).toEqual([]);
    await expect(harness.host.start()).rejects.toMatchObject({
      code: REMOTE_PROTOCOL_MISMATCH_CODE,
    });
  });

  it('serves a controller on another app version that shares the protocol', async () => {
    const harness = await createHarness({ sayHello: false });
    await harness.controller.request(REMOTE_METHODS.hello, {
      version: { ...TEST_VERSION, appVersion: '0.9.0' },
    });
    await expect(
      harness.controller.request(REMOTE_METHODS.invoke, {
        channel: TUNNEL_CHANNEL,
        args: [1],
      }),
    ).resolves.toEqual({ echoed: TUNNEL_CHANNEL, args: [1] });
  });

  it('refuses a controller that predates the version check, in words it can show', async () => {
    const harness = await createHarness({ sayHello: false });
    await expect(
      harness.controller.request(REMOTE_METHODS.hello, null),
    ).rejects.toMatchObject({
      code: REMOTE_PROTOCOL_MISMATCH_CODE,
      message:
        "desktop runs version 1.0.0, which this computer can't control. Update this computer to connect.",
    });
    await expect(
      harness.controller.request(REMOTE_METHODS.invoke, {
        channel: TUNNEL_CHANNEL,
        args: [],
      }),
    ).rejects.toMatchObject({ code: REMOTE_PROTOCOL_MISMATCH_CODE });
    await flushRelay();
    expect(harness.bridges).toHaveLength(0);
  });
  it('replays each window of the controller through its own bridge', async () => {
    const harness = await createHarness();
    await harness.controller.request(REMOTE_METHODS.invoke, {
      channel: TUNNEL_CHANNEL,
      args: ['from main'],
    });
    await harness.controller.request(REMOTE_METHODS.invoke, {
      channel: TUNNEL_CHANNEL,
      args: ['from App Advisor'],
      surface: 'app-advisor',
    });
    harness.controller.notify(REMOTE_EVENTS.ipcSend, {
      channel: TUNNEL_CHANNEL,
      args: ['sent'],
      surface: 'app-advisor',
    });
    await flushRelay();
    expect(harness.bridgeSurfaces).toEqual(['main', 'app-advisor']);
    expect(harness.bridges[0]?.invocations).toEqual([
      { channel: TUNNEL_CHANNEL, args: ['from main'] },
    ]);
    expect(harness.bridges[1]?.invocations).toEqual([
      { channel: TUNNEL_CHANNEL, args: ['from App Advisor'] },
    ]);
    expect(harness.bridges[1]?.posts).toEqual([
      { channel: TUNNEL_CHANNEL, args: ['sent'] },
    ]);
  });

  it('sends bridge pushes to their own window and broadcasts to every window once', async () => {
    const harness = await createHarness();
    const main = await harness.host.bridgeFor('main');
    const appAdvisor = await harness.host.bridgeFor('app-advisor');
    expect(main).toBe(harness.bridges[0]);
    expect(appAdvisor).toBe(harness.bridges[1]);
    harness.bridges[1]?.push(TUNNEL_CHANNEL, ['reply']);
    // A broadcast reaches both bridges and the app window in one tick.
    const broadcast = { id: 1 };
    harness.bridges[1]?.push(TUNNEL_CHANNEL, [broadcast]);
    harness.mainWindow.publish(TUNNEL_CHANNEL, [broadcast]);
    harness.bridges[0]?.push(TUNNEL_CHANNEL, [broadcast]);
    await flushRelay();
    expect(
      harness.events
        .filter((event) => event.name === REMOTE_EVENTS.push)
        .map((event) => event.payload),
    ).toEqual([
      { channel: TUNNEL_CHANNEL, args: ['reply'], surface: 'app-advisor' },
      { channel: TUNNEL_CHANNEL, args: [broadcast], surface: 'app-advisor' },
      { channel: TUNNEL_CHANNEL, args: [broadcast], surface: 'main' },
    ]);
  });

  it('filters a broadcast for each controller window without losing bridge deduplication', async () => {
    const harness = await createHarness();
    await harness.host.bridgeFor('main');
    await harness.host.bridgeFor('app-advisor');
    const main = harness.bridges[0];
    const advisor = harness.bridges[1];
    if (!main || !advisor) throw new Error('Expected both bridges.');
    const x = { projectId: 'project', worktreeId: 'tree', chatId: 'x' };
    const y = { ...x, chatId: 'y' };
    main.chatInterest = { focused: [x], warm: [] };
    advisor.chatInterest = { focused: [y], warm: [] };
    const xEvent = {
      ...x,
      data: { type: 'codex', event: { type: 'item.updated' } },
    };
    const yEvent = {
      ...y,
      data: { type: 'codex', event: { type: 'item.updated' } },
    };
    // Exercise both broadcast orders: app window first and bridge first.
    harness.mainWindow.publish(IPC_CHANNELS.chatEvent, [xEvent]);
    main.push(IPC_CHANNELS.chatEvent, [xEvent]);
    advisor.push(IPC_CHANNELS.chatEvent, [xEvent]);
    advisor.push(IPC_CHANNELS.chatEvent, [yEvent]);
    harness.mainWindow.publish(IPC_CHANNELS.chatEvent, [yEvent]);
    main.push(IPC_CHANNELS.chatEvent, [yEvent]);
    await flushRelay();
    expect(
      harness.events
        .filter((event) => event.name === REMOTE_EVENTS.push)
        .map((event) => event.payload),
    ).toEqual([
      { channel: IPC_CHANNELS.chatEvent, args: [xEvent], surface: 'main' },
      {
        channel: IPC_CHANNELS.chatEvent,
        args: [yEvent],
        surface: 'app-advisor',
      },
    ]);
    harness.host.close('closed');
  });

  it('asks the controller to show its App Advisor window and hears its state', async () => {
    const harness = await createHarness();
    await expect(
      harness.host.requestAppAdvisorWindow({ action: 'open', focus: true }),
    ).resolves.toEqual({ open: true, focused: true });
    expect(harness.appAdvisorWindowRequests).toEqual([
      { action: 'open', focus: true },
    ]);
    harness.controller.notify(REMOTE_EVENTS.appAdvisorWindowState, {
      open: false,
      focused: false,
    });
    harness.controller.notify(REMOTE_EVENTS.appAdvisorWindowState, {
      open: 'yes',
    });
    await flushRelay();
    expect(harness.appAdvisorWindowStates).toEqual([
      { open: false, focused: false },
    ]);
  });

  describe('account proxy sign-in', () => {
    const STATE = 'state0123456789abcdef';

    it("hands the controller's redirect to the proxy service with its device", async () => {
      const complete = jest.fn(() => Promise.resolve());
      const harness = await createHarness({
        completeAccountProxySignIn: complete,
      });
      await expect(
        harness.controller.request(REMOTE_METHODS.accountProxySignInCallback, {
          state: STATE,
          code: 'the-code',
          error: null,
        }),
      ).resolves.toEqual({ accepted: true });
      expect(complete).toHaveBeenCalledWith(harness.host.controllerDeviceId, {
        state: STATE,
        code: 'the-code',
        error: null,
      });
    });

    it('refuses a malformed redirect before the service sees it', async () => {
      const complete = jest.fn(() => Promise.resolve());
      const harness = await createHarness({
        completeAccountProxySignIn: complete,
      });
      for (const params of [
        { state: 'short', code: 'c', error: null },
        { state: STATE, code: null, error: null },
        { state: STATE, code: 'x'.repeat(4097), error: null },
      ]) {
        await expect(
          harness.controller.request(
            REMOTE_METHODS.accountProxySignInCallback,
            params,
          ),
        ).rejects.toThrow();
      }
      expect(complete).not.toHaveBeenCalled();
    });

    it("passes on the service's refusal", async () => {
      const harness = await createHarness({
        completeAccountProxySignIn: () =>
          Promise.reject(new Error('This sign-in is no longer waiting.')),
      });
      await expect(
        harness.controller.request(REMOTE_METHODS.accountProxySignInCallback, {
          state: STATE,
          code: 'c',
          error: null,
        }),
      ).rejects.toThrow('no longer waiting');
    });

    it('answers that it does not serve redirects without the service', async () => {
      const harness = await createHarness();
      const failure = await harness.controller
        .request(REMOTE_METHODS.accountProxySignInCallback, {
          state: STATE,
          code: 'c',
          error: null,
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(
        isUnknownRemoteMethodError(
          failure,
          REMOTE_METHODS.accountProxySignInCallback,
        ),
      ).toBe(true);
    });

    it('takes no redirect from a controller on another protocol', async () => {
      const complete = jest.fn(() => Promise.resolve());
      const harness = await createHarness({
        sayHello: false,
        completeAccountProxySignIn: complete,
      });
      await expect(
        harness.controller.request(REMOTE_METHODS.accountProxySignInCallback, {
          state: STATE,
          code: 'c',
          error: null,
        }),
      ).rejects.toThrow();
      expect(complete).not.toHaveBeenCalled();
    });

    it('asks the controller to open the page, and to stop listening', async () => {
      const opened: unknown[] = [];
      const harness = await createHarness({
        controllerRequests: (method, params) => {
          if (method !== REMOTE_METHODS.accountProxySignInOpen) {
            return Promise.reject(new UnknownRemoteMethodError(method));
          }
          opened.push(params);
          return Promise.resolve({ opened: true });
        },
      });
      const page = {
        provider: 'claude' as const,
        url: `https://claude.ai/oauth/authorize?state=${STATE}`,
        state: STATE,
      };
      await harness.host.openAccountProxySignIn(page);
      expect(opened).toEqual([page]);
      harness.host.endAccountProxySignIn(STATE);
      await flushRelay(4);
      expect(harness.events).toContainEqual({
        name: REMOTE_EVENTS.accountProxySignInEnded,
        payload: { state: STATE },
      });
    });

    it('tells the sign-in when the session closes', async () => {
      const harness = await createHarness();
      const closed = jest.fn();
      harness.host.onClosed(closed);
      harness.host.close('closed');
      await flushRelay(4);
      expect(closed).toHaveBeenCalledTimes(1);
      const late = jest.fn();
      harness.host.onClosed(late);
      expect(late).toHaveBeenCalledTimes(1);
    });
  });
});
