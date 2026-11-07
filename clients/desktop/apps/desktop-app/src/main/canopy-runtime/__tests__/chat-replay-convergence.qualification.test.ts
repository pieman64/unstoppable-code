import { randomUUID } from 'node:crypto';
import type {
  ChatStateChange,
  ChatStateChangedEvent,
  ChatStateCommandPort,
  ChatStateSnapshot,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type {
  CanopyStreamCursor,
  CanopyStreamEnd,
  CanopyStreamItem,
} from '@canopy/protocol/canopy-core';
import type { CanopyStreamFrame } from '@canopy/core-runtime';
import type { CoreChatTurnCancelHost } from '../core-chat-turn-adapter';
import { createDesktopRuntime } from '../desktop-runtime';

type ChatFrame = CanopyStreamFrame<
  CanopyStreamItem<'core.chat.events'>,
  CanopyStreamEnd<'core.chat.events'>
>;
type Runtime = ReturnType<typeof createDesktopRuntime>;

interface ChatScope {
  projectId: string;
  worktreeId: string;
}

interface TabView {
  chatId: string;
  title: string;
  transcriptRevision: number;
  text: string;
}

interface View {
  revision: number;
  tabs: TabView[];
}

const scope: ChatScope = { projectId: 'project-1', worktreeId: 'worktree-1' };
const createdAt = '2026-11-05T00:00:00.000Z';

function descriptor(
  transcriptRevision: number,
): Extract<ChatStateChange, { type: 'transcript.updated' }>['transcript'] {
  return {
    format: 'complete-message-jsonl-v1',
    committedMessageCount: 0,
    committedByteLength: 0,
    transcriptRevision,
    hasActiveSidecar: false,
  };
}

function sortedView(
  revision: number,
  tabs: ReadonlyMap<string, Omit<TabView, 'chatId'>>,
): View {
  return {
    revision,
    tabs: Array.from(tabs, ([chatId, tab]) => ({ chatId, ...tab })).sort(
      (a, b) => a.chatId.localeCompare(b.chatId),
    ),
  };
}

class MemoryChatPort implements ChatStateCommandPort {
  private readonly listeners = new Set<
    (event: ChatStateChangedEvent) => void
  >();
  private readonly scopes = new Map<
    string,
    {
      revision: number;
      tabs: Map<
        string,
        {
          title: string;
          customTitle?: string;
          transcriptRevision: number;
          text: string;
        }
      >;
    }
  >();

  getTranscriptPage = jest.fn();
  searchTranscript = jest.fn();
  readToolOutput = jest.fn();
  readVisual = jest.fn();
  command = jest.fn();

  subscribe(listener: (event: ChatStateChangedEvent) => void): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  private stateOf(target: ChatScope): {
    revision: number;
    tabs: Map<
      string,
      {
        title: string;
        customTitle?: string;
        transcriptRevision: number;
        text: string;
      }
    >;
  } {
    const key = JSON.stringify([target.projectId, target.worktreeId]);
    let state = this.scopes.get(key);
    if (!state) {
      state = { revision: 0, tabs: new Map() };
      this.scopes.set(key, state);
    }
    return state;
  }

  commit(target: ChatScope, changes: ChatStateChange[]): ChatStateChangedEvent {
    const state = this.stateOf(target);
    state.revision += 1;
    for (const change of changes) {
      if (change.type === 'tab.upserted')
        state.tabs.set(change.tab.id, {
          title: change.tab.title,
          transcriptRevision: 0,
          text: '',
        });
      else if (change.type === 'tab.removed') state.tabs.delete(change.tabId);
      else if (change.type === 'tab.metadata_patched') {
        const tab = state.tabs.get(change.tabId);
        const customTitle = change.patch.customTitle;
        if (tab && typeof customTitle === 'string')
          tab.customTitle = customTitle;
      } else if (change.type === 'message.upserted') {
        const tab = state.tabs.get(change.chatId);
        const block = change.message.blocks[0];
        if (tab && block?.type === 'text') tab.text = block.text;
      } else if (change.type === 'transcript.updated') {
        const tab = state.tabs.get(change.chatId);
        if (tab) tab.transcriptRevision = change.transcript.transcriptRevision;
      }
    }
    const event: ChatStateChangedEvent = {
      schemaVersion: 1,
      eventId: randomUUID(),
      occurredAt: createdAt,
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      baseRevision: state.revision - 1,
      revision: state.revision,
      changes,
    };
    this.deliverAgain(event);
    return event;
  }

  deliverAgain(event: ChatStateChangedEvent): void {
    Array.from(this.listeners).forEach((listener) => listener(event));
  }

  restart(target: ChatScope): void {
    const state = this.stateOf(target);
    state.revision = 0;
    state.tabs.clear();
  }

  getState(target: ChatScope): Promise<ChatStateSnapshot> {
    const state = this.stateOf(target);
    const tabs: PersistedChatTab[] = Array.from(
      state.tabs,
      ([id, tab]): PersistedChatTab => ({
        id,
        title: tab.title,
        ...(tab.customTitle === undefined
          ? {}
          : { customTitle: tab.customTitle }),
        createdAt,
        messages: [],
        transcript: descriptor(tab.transcriptRevision),
      }),
    );
    return Promise.resolve({
      schemaVersion: 1,
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      revision: state.revision,
      tabsFile: { version: 1, activeTabId: tabs[0]?.id ?? '', tabs },
      archives: [],
      runtimeByChatId: {},
      queue: [],
    });
  }

  view(target: ChatScope): View {
    const state = this.stateOf(target);
    return sortedView(
      state.revision,
      new Map(
        Array.from(state.tabs, ([chatId, tab]) => [
          chatId,
          {
            title: tab.customTitle ?? tab.title,
            transcriptRevision: tab.transcriptRevision,
            text: tab.text,
          },
        ]),
      ),
    );
  }
}

class FollowingClient {
  snapshotReads = 0;
  resyncs = 0;
  rereadTranscripts: string[] = [];
  readonly snapshotRequiredEnds: number[] = [];
  readonly applied = new Map<number, number>();
  readonly failures: string[] = [];
  lastCursor: CanopyStreamCursor | null = null;
  private held = 0;
  private tabs = new Map<string, Omit<TabView, 'chatId'>>();
  private generation = 0;
  private handle: { close(): void } | null = null;
  private controller: AbortController | null = null;
  private work: Promise<void> = Promise.resolve();

  constructor(
    private runtime: Runtime,
    private readonly target: ChatScope,
    private readonly name: string,
  ) {}

  private get caller(): {
    principalId: string;
    clientInstanceId: string;
    authorityId: string;
    interfaceKind: 'test';
    grants: ['core.chat.read'];
  } {
    return {
      principalId: 'test-user',
      clientInstanceId: this.name,
      authorityId: 'local-desktop',
      interfaceKind: 'test',
      grants: ['core.chat.read'],
    };
  }

  async start(): Promise<void> {
    await this.readSnapshot(false);
    await this.openAt(this.lastCursor);
  }

  private async readSnapshot(resync: boolean): Promise<void> {
    const result = await this.runtime.query(
      'core.chat.snapshot.get',
      {
        scope: {
          workspaceId: this.target.projectId,
          worktreeId: this.target.worktreeId,
        },
      },
      { caller: this.caller },
    );
    this.snapshotReads += 1;
    const next = new Map<string, Omit<TabView, 'chatId'>>();
    for (const tab of result.tabs.items) {
      const previous = this.tabs.get(tab.chatId);
      const transcriptRevision = tab.transcriptRevision ?? 0;
      if (
        resync &&
        previous &&
        previous.transcriptRevision !== transcriptRevision
      )
        this.rereadTranscripts.push(tab.chatId);
      next.set(tab.chatId, {
        title: tab.title,
        transcriptRevision,
        text: previous?.text ?? '',
      });
    }
    this.tabs = next;
    this.held = result.revision;
    this.lastCursor = result.eventsCursor ?? null;
  }

  private async openAt(cursor: CanopyStreamCursor | null): Promise<void> {
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const handle = await this.runtime.openStream(
      'core.chat.events',
      cursor ? { scope: this.target, cursor } : { scope: this.target },
      {
        caller: this.caller,
        signal: controller.signal,
        onFrame: (frame) => {
          if (generation === this.generation) this.onFrame(frame);
        },
      },
    );
    if (generation === this.generation) this.handle = handle;
    else handle.close();
  }

  private onFrame(frame: ChatFrame): void {
    if (frame.kind === 'end') {
      if (frame.error?.code === 'core.chat.snapshotRequired') {
        this.snapshotRequiredEnds.push(this.generation);
        this.resync();
      }
      return;
    }
    this.lastCursor = frame.cursor;
    const item = frame.item;
    if (item.revision <= this.held) return;
    if (item.baseRevision > this.held) {
      this.resync();
      return;
    }
    for (const change of item.changes) this.apply(change);
    this.held = item.revision;
    this.applied.set(item.revision, (this.applied.get(item.revision) ?? 0) + 1);
  }

  private apply(
    change: CanopyStreamItem<'core.chat.events'>['changes'][number],
  ): void {
    if (change.type === 'tab.upserted')
      this.tabs.set(change.tab.id, {
        title: change.tab.title,
        transcriptRevision:
          this.tabs.get(change.tab.id)?.transcriptRevision ?? 0,
        text: '',
      });
    else if (change.type === 'tab.removed') this.tabs.delete(change.tabId);
    else if (change.type === 'tab.metadata_patched') {
      const tab = this.tabs.get(change.tabId);
      const customTitle = change.patch.customTitle;
      if (tab && typeof customTitle === 'string') tab.title = customTitle;
    } else if (change.type === 'message.upserted') {
      const tab = this.tabs.get(change.chatId);
      const block = change.message.blocks[0];
      if (
        tab &&
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'text' &&
        'text' in block &&
        typeof block.text === 'string'
      )
        tab.text = block.text;
    } else if (change.type === 'transcript.updated') {
      const tab = this.tabs.get(change.chatId);
      const revision = change.transcript.transcriptRevision;
      if (tab && typeof revision === 'number')
        tab.transcriptRevision = revision;
    }
  }

  private resync(): void {
    this.generation += 1;
    this.handle?.close();
    this.handle = null;
    this.work = this.work.then(async () => {
      this.resyncs += 1;
      if (this.resyncs > 3) {
        this.failures.push(`${this.name} resynced more than 3 times`);
        return;
      }
      await this.readSnapshot(true);
      await this.openAt(this.lastCursor);
    });
  }

  disconnect(mode: 'close' | 'abort' = 'close'): void {
    this.generation += 1;
    if (mode === 'abort') this.controller?.abort();
    else this.handle?.close();
    this.handle = null;
  }

  async reconnect(runtime: Runtime): Promise<void> {
    this.runtime = runtime;
    await this.openAt(this.lastCursor);
  }

  async settled(): Promise<void> {
    await new Promise(setImmediate);
    await this.work;
    await new Promise(setImmediate);
  }

  view(): View {
    return sortedView(this.held, this.tabs);
  }
}

function tabUpserted(id: string, title: string): ChatStateChange {
  return {
    type: 'tab.upserted',
    tab: { id, title, createdAt, messages: [] },
  };
}

function renamed(tabId: string, customTitle: string): ChatStateChange {
  return { type: 'tab.metadata_patched', tabId, patch: { customTitle } };
}

function chunk(chatId: string, text: string): ChatStateChange {
  return {
    type: 'message.upserted',
    chatId,
    message: {
      id: 'assistant-1',
      role: 'assistant',
      blocks: [{ type: 'text', text }],
      timestamp: 1,
    },
  };
}

function transcriptUpdated(
  chatId: string,
  transcriptRevision: number,
): ChatStateChange {
  return {
    type: 'transcript.updated',
    chatId,
    transcript: descriptor(transcriptRevision),
    reset: false,
  };
}

function runtimePatched(
  chatId: string,
  status: 'streaming' | 'completed',
): ChatStateChange {
  return {
    type: 'runtime.patched',
    chatId,
    runtime: { status, queuedMessageIds: [] },
  };
}

function makeHarness(): {
  port: MemoryChatPort;
  turnCancelHost: { [K in keyof CoreChatTurnCancelHost]: jest.Mock };
  createRuntime: () => Runtime;
  runtimes: Runtime[];
} {
  const port = new MemoryChatPort();
  const turnCancelHost = {
    scopesForChat: jest.fn(),
    getState: jest.fn(),
    stop: jest.fn(),
  };
  const runtimes: Runtime[] = [];
  const createRuntime = (): Runtime => {
    const runtime = createDesktopRuntime({
      getChatStatePort: () => port,
      chatCommandPort: port,
      turnCancelHost,
    });
    runtimes.push(runtime);
    return runtime;
  };
  return { port, turnCancelHost, createRuntime, runtimes };
}

const clients: FollowingClient[] = [];

async function startClients(
  runtime: Runtime,
): Promise<[FollowingClient, FollowingClient]> {
  const a = new FollowingClient(runtime, scope, 'client-a');
  const b = new FollowingClient(runtime, scope, 'client-b');
  clients.push(a, b);
  await a.start();
  await b.start();
  return [a, b];
}

async function settle(...clients: FollowingClient[]): Promise<void> {
  for (const client of clients) await client.settled();
  for (const client of clients) expect(client.failures).toEqual([]);
}

describe('two chat clients converge through core replay (CAN-4111)', () => {
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    harness = makeHarness();
  });

  afterEach(async () => {
    // An open stream holds runtime shutdown until its timeout.
    for (const client of clients.splice(0)) client.disconnect();
    for (const runtime of harness.runtimes)
      if (!runtime.isShuttingDown()) await runtime.shutdown();
  });

  it('two clients converge after a reconnect', async () => {
    const { port, createRuntime } = harness;
    const runtime = createRuntime();
    const [a, b] = await startClients(runtime);
    port.commit(scope, [tabUpserted('chat-1', 'First')]);
    port.commit(scope, [tabUpserted('chat-2', 'Second')]);
    await settle(a, b);
    a.disconnect();
    port.commit(scope, [renamed('chat-1', 'Renamed')]);
    port.commit(scope, [tabUpserted('chat-3', 'Third')]);
    await a.reconnect(runtime);
    await settle(a, b);
    expect(a.snapshotReads).toBe(1);
    expect(a.view()).toEqual(port.view(scope));
    expect(b.view()).toEqual(port.view(scope));
  });

  it('two clients converge after a stale cursor', async () => {
    const { port, createRuntime } = harness;
    const runtime = createRuntime();
    port.commit(scope, [tabUpserted('chat-1', 'First')]);
    const [a, b] = await startClients(runtime);
    a.disconnect();
    for (let index = 1; index <= 130; index += 1)
      port.commit(scope, [renamed('chat-1', `Rename ${index}`)]);
    await a.reconnect(runtime);
    await settle(a, b);
    expect(a.snapshotRequiredEnds).toHaveLength(1);
    expect(a.snapshotReads).toBe(2);
    expect(a.view()).toEqual(port.view(scope));
    expect(b.view()).toEqual(port.view(scope));
  });

  it('two clients converge after a duplicate event', async () => {
    const { port, createRuntime } = harness;
    const runtime = createRuntime();
    port.commit(scope, [tabUpserted('chat-1', 'First')]);
    const [a, b] = await startClients(runtime);
    const event = port.commit(scope, [renamed('chat-1', 'Renamed')]);
    port.deliverAgain(event);
    port.deliverAgain({ ...event });
    await settle(a, b);
    expect(a.applied.get(event.revision)).toBe(1);
    expect(b.applied.get(event.revision)).toBe(1);
    expect(a.view()).toEqual(port.view(scope));
    expect(b.view()).toEqual(port.view(scope));
  });

  it('two clients converge after a core restart', async () => {
    const { port, createRuntime } = harness;
    const runtime1 = createRuntime();
    port.commit(scope, [tabUpserted('chat-1', 'First')]);
    const [a, b] = await startClients(runtime1);
    a.disconnect();
    b.disconnect();
    await runtime1.shutdown();
    port.commit(scope, [renamed('chat-1', 'Renamed')]);
    const runtime2 = createRuntime();
    await a.reconnect(runtime2);
    await b.reconnect(runtime2);
    await settle(a, b);
    for (const client of [a, b]) {
      expect(client.snapshotRequiredEnds).toHaveLength(1);
      expect(client.resyncs).toBe(1);
    }
    expect(a.view()).toEqual(port.view(scope));
    expect(b.view()).toEqual(port.view(scope));
  });

  it("two clients converge after a scope's revisions restart", async () => {
    const { port, createRuntime } = harness;
    const runtime = createRuntime();
    port.commit(scope, [tabUpserted('chat-1', 'First')]);
    port.commit(scope, [renamed('chat-1', 'Renamed')]);
    const [a, b] = await startClients(runtime);
    const oldEpochs = [a.lastCursor?.daemonEpoch, b.lastCursor?.daemonEpoch];
    port.restart(scope);
    port.commit(scope, [tabUpserted('chat-9', 'After restart')]);
    await settle(a, b);
    for (const client of [a, b]) {
      expect(client.snapshotRequiredEnds).toHaveLength(1);
      expect(client.resyncs).toBe(1);
      expect(oldEpochs).not.toContain(client.lastCursor?.daemonEpoch);
    }
    expect(a.view()).toEqual(port.view(scope));
    expect(b.view()).toEqual(port.view(scope));
  });

  it('a client that disconnects mid-turn catches up on the finished turn', async () => {
    const { port, createRuntime, turnCancelHost } = harness;
    const runtime = createRuntime();
    port.commit(scope, [tabUpserted('chat-1', 'First')]);
    const [a, b] = await startClients(runtime);
    port.commit(scope, [runtimePatched('chat-1', 'streaming')]);
    port.commit(scope, [chunk('chat-1', 'Hello')]);
    port.commit(scope, [chunk('chat-1', 'Hello wor')]);
    await settle(a, b);
    a.disconnect('abort');
    await new Promise(setImmediate);
    port.commit(scope, [chunk('chat-1', 'Hello world')]);
    port.commit(scope, [runtimePatched('chat-1', 'completed')]);
    await a.reconnect(runtime);
    await settle(a, b);
    expect(a.resyncs).toBe(0);
    expect(a.view().tabs[0]?.text).toBe('Hello world');
    expect(a.view()).toEqual(b.view());
    expect(a.view()).toEqual(port.view(scope));
    expect(turnCancelHost.scopesForChat).not.toHaveBeenCalled();
    expect(turnCancelHost.getState).not.toHaveBeenCalled();
    expect(turnCancelHost.stop).not.toHaveBeenCalled();
  });

  it('rereads only the transcripts that changed during a resync', async () => {
    const { port, createRuntime } = harness;
    const runtime = createRuntime();
    port.commit(scope, [tabUpserted('chat-1', 'First')]);
    port.commit(scope, [tabUpserted('chat-2', 'Second')]);
    const [a, b] = await startClients(runtime);
    a.disconnect();
    for (let index = 1; index <= 130; index += 1)
      port.commit(scope, [transcriptUpdated('chat-2', index)]);
    await a.reconnect(runtime);
    await settle(a, b);
    expect(a.resyncs).toBe(1);
    expect(a.rereadTranscripts).toEqual(['chat-2']);
    expect(a.view()).toEqual(port.view(scope));
  });
});
