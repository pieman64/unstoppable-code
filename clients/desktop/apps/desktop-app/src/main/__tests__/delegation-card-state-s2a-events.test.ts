import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import type { CardStateDraft } from '@canopy/protocol/canopy-core';
import {
  IPC_CHANNELS,
  type ChatStateChangedEvent,
  type ChatStateSnapshot,
} from '@canopy/desktop-shared/types';
import type { DelegationTranscriptSettleRequest } from '@canopy/desktop-shared/node/delegation/transcript-port';
import { createDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { registerChatStateHandlers } from '../ipc/chat-state';
import { ChatDeltaJournalWriter } from '../lib/chat-delta-journal/writer';
import {
  createRepositoryTranscriptPortFixture,
  type RepositoryTranscriptPortFixture,
} from './helpers/repository-transcript-port-fixture';
import { applyCanonicalChanges } from '../../renderer/src/stores/chat/canonical-changes';
import type { CanonicalScopeProjection } from '../../renderer/src/stores/chat/canonical-changes';
import { fromPersistedTab } from '../../renderer/src/stores/chat/persisted-tabs';
import { RevisionedChatSync } from '../../renderer/src/stores/chat/revisioned-sync';

jest.mock('../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
jest.setTimeout(120_000);

function isChatStateChangedEvent(
  value: unknown,
): value is ChatStateChangedEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    value.schemaVersion === 1 &&
    'changes' in value &&
    Array.isArray(value.changes)
  );
}

function immediate(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForEventCount(
  events: readonly ChatStateChangedEvent[],
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 16 && events.length < count; attempt += 1)
    await immediate();
}

interface EventHarness {
  readonly events: ChatStateChangedEvent[];
  readonly canonicalInputs: ChatStateChangedEvent[];
  readonly sync: RevisionedChatSync;
  close(): Promise<void>;
}

async function createEventHarness(
  current: RepositoryTranscriptPortFixture,
): Promise<EventHarness> {
  const scope = current.scope;
  const initial = await current.service.getState(scope);
  const firstTab = initial.tabsFile.tabs[0];
  if (!firstTab) throw new Error('The repository fixture has no chat tab.');

  let projection: CanonicalScopeProjection = {
    chatState: {
      tabs: initial.tabsFile.tabs.map((tab) => fromPersistedTab(tab)),
      activeTabId: initial.tabsFile.activeTabId ?? firstTab.id,
    },
    archives: [],
    runtimeByChatId: {},
    pendingQuestions: {},
  };
  const events: ChatStateChangedEvent[] = [];
  const canonicalInputs: ChatStateChangedEvent[] = [];
  const sync = new RevisionedChatSync(
    { getState: (): Promise<ChatStateSnapshot> => Promise.resolve(initial) },
    {
      installSnapshot: (): void => undefined,
      applyCommittedEvent: (event): void => {
        canonicalInputs.push(event);
        projection = applyCanonicalChanges(projection, event.changes, {
          projectId: scope.projectId,
          worktreeId: scope.worktreeId,
        });
      },
      onStatusChanged: (): void => undefined,
    },
  );
  await sync.hydrate(scope.projectId, scope.worktreeId);

  const send = jest.fn((channel: string, ...args: unknown[]): void => {
    const payload = args[0];
    if (
      channel === IPC_CHANNELS.chatStateChanged &&
      isChatStateChangedEvent(payload)
    ) {
      events.push(payload);
      sync.handleEvent(payload);
    }
  });
  const window = new BrowserWindow();
  jest.spyOn(window.webContents, 'send').mockImplementation(send);
  const dispatcher = createDesktopRuntime({
    getChatStatePort: () => current.service,
  });
  const subscribe = jest.spyOn(current.service, 'subscribe');
  const dispose = registerChatStateHandlers(current.service, () => [window], {
    dispatcher,
    resolveCaller: () => ({
      principalId: 'test-user',
      clientInstanceId: 'test-client',
      authorityId: 'local-desktop',
      interfaceKind: 'test',
      grants: ['core.chat.read'],
    }),
  });
  for (
    let attempt = 0;
    attempt < 16 && subscribe.mock.calls.length === 0;
    attempt += 1
  )
    await immediate();

  if (subscribe.mock.calls.length === 0) {
    dispose();
    await dispatcher.shutdown();
    subscribe.mockRestore();
    throw new Error('The desktop chat-event stream did not subscribe.');
  }

  return {
    events,
    canonicalInputs,
    sync,
    close: async (): Promise<void> => {
      dispose();
      try {
        await dispatcher.shutdown();
      } finally {
        subscribe.mockRestore();
      }
    },
  };
}

describe('12a S2a durable card-state event evidence', () => {
  let root = '';
  let fixture: RepositoryTranscriptPortFixture | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'delegation-card-state-s2a-'));
    fixture = await createRepositoryTranscriptPortFixture(root)();
  });

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it('publishes a durable descriptor-only change through IPC, sync, and the canonical store input', async () => {
    const current = fixture;
    if (!current) throw new Error('Repository fixture was not created.');
    const target = current.ownedTarget('chat', 's2a-descriptor-event', 1);
    expect(await current.port.open({ target })).toMatchObject({ ok: true });
    const harness = await createEventHarness(current);

    try {
      const before = await current.service.getState(current.scope);
      const cardDraft: CardStateDraft = {
        version: 2,
        status: 'running',
        outputTruncated: false,
        prompt: 'Queued prompt from the host',
      };
      const update = await current.port.updateCardState({
        target,
        cardRevision: 1,
        cardDraft,
      });
      expect(update).toMatchObject({
        ok: true,
        value: {
          cardState: {
            version: 2,
            cardRevision: 1,
            status: 'running',
            outputTruncated: false,
            prompt: 'Queued prompt from the host',
          },
        },
      });

      await waitForEventCount(harness.events, 1);
      const after = await current.service.getState(current.scope);
      expect(after.revision).toBe(before.revision + 1);
      expect(harness.events).toHaveLength(1);
      const [event] = harness.events;
      if (!event) throw new Error('The descriptor event was not delivered.');
      expect(event).toMatchObject({
        projectId: current.scope.projectId,
        worktreeId: current.scope.worktreeId,
        baseRevision: before.revision,
        revision: after.revision,
      });
      expect(event.changes).toEqual([
        {
          type: 'delegation.card_state_updated',
          chatId: 'chat',
          delegationId: 's2a-descriptor-event',
          runGeneration: 1,
          cardRevision: 1,
          streamRevision: 1,
          cardState: {
            version: 2,
            cardRevision: 1,
            status: 'running',
            outputTruncated: false,
            prompt: 'Queued prompt from the host',
          },
        },
      ]);
      expect(harness.canonicalInputs).toEqual([event]);
      expect(
        harness.sync.getStatus(
          current.scope.projectId,
          current.scope.worktreeId,
        )?.revision,
      ).toBe(after.revision);

      const replay = await current.port.updateCardState({
        target,
        cardRevision: 1,
        cardDraft,
      });
      expect(replay).toMatchObject({ ok: true });
      expect((await current.service.getState(current.scope)).revision).toBe(
        after.revision,
      );
      await immediate();
      expect(harness.events).toEqual([event]);
      expect(harness.canonicalInputs).toEqual([event]);
    } finally {
      await harness.close();
    }
  });

  it('publishes one canonical settle event and keeps an identical settlement replay silent', async () => {
    const current = fixture;
    if (!current) throw new Error('Repository fixture was not created.');
    const target = current.ownedTarget('chat', 's2a-settle-event', 1);
    expect(await current.port.open({ target })).toMatchObject({ ok: true });
    const harness = await createEventHarness(current);

    try {
      const before = await current.service.getState(current.scope);
      const request: DelegationTranscriptSettleRequest = {
        target,
        settlementKey: 's2a-settlement-event',
        resultIndex: 1,
        outcome: { status: 'completed', finishedAt: 200 },
        finalChanges: [],
        answer: { role: 'final', text: 'Durable final answer' },
      };
      const settle = await current.port.settle(request);
      expect(settle).toMatchObject({ ok: true });

      await waitForEventCount(harness.events, 1);
      const after = await current.service.getState(current.scope);
      expect(after.revision).toBe(before.revision + 1);
      expect(harness.events).toHaveLength(1);
      const [event] = harness.events;
      if (!event) throw new Error('The settle event was not delivered.');
      expect(event).toMatchObject({
        projectId: current.scope.projectId,
        worktreeId: current.scope.worktreeId,
        baseRevision: before.revision,
        revision: after.revision,
      });
      expect(event.changes).toEqual([
        {
          type: 'delegation.card_state_updated',
          chatId: 'chat',
          delegationId: 's2a-settle-event',
          runGeneration: 1,
          cardRevision: 0,
          streamRevision: 1,
          cardState: {
            version: 2,
            cardRevision: 0,
            canonical: {
              status: 'completed',
              resultIndex: 1,
              finalText: 'Durable final answer',
              finalTextRef: {
                version: 1,
                artifactId:
                  'sha256-v1-01ae67447c36456092a8719262fbb6443789e24b73c2df2cd2f8f28a736e70cc',
                sha256:
                  '01ae67447c36456092a8719262fbb6443789e24b73c2df2cd2f8f28a736e70cc',
                byteLength: 20,
                encoding: 'utf-8',
                mediaType: 'text/plain',
              },
            },
          },
        },
      ]);
      expect(harness.canonicalInputs).toEqual([event]);
      expect(
        harness.sync.getStatus(
          current.scope.projectId,
          current.scope.worktreeId,
        )?.revision,
      ).toBe(after.revision);

      const replay = await current.port.settle(request);
      expect(replay).toMatchObject({ ok: true });
      expect((await current.service.getState(current.scope)).revision).toBe(
        after.revision,
      );
      await immediate();
      expect(harness.events).toEqual([event]);
      expect(harness.canonicalInputs).toEqual([event]);
    } finally {
      await harness.close();
    }
  });

  it('isolates a throwing service listener from a durable card write and its IPC event', async () => {
    const current = fixture;
    if (!current) throw new Error('Repository fixture was not created.');
    const target = current.ownedTarget('chat', 's2a-listener-failure', 1);
    expect(await current.port.open({ target })).toMatchObject({ ok: true });
    const harness = await createEventHarness(current);
    let failedListenerCalls = 0;
    const unsubscribe = current.service.subscribe((): void => {
      failedListenerCalls += 1;
      throw new Error('A post-commit observer failed.');
    });

    try {
      const result = await current.port.updateCardState({
        target,
        cardRevision: 1,
        cardDraft: {
          version: 2,
          status: 'running',
          outputTruncated: false,
        },
      });
      expect(result).toMatchObject({ ok: true });
      await waitForEventCount(harness.events, 1);
      expect(failedListenerCalls).toBeGreaterThan(0);
      expect(harness.events).toHaveLength(1);
      expect(harness.events[0]?.changes).toHaveLength(1);
      expect(harness.events[0]?.changes[0]?.type).toBe(
        'delegation.card_state_updated',
      );
      expect(harness.canonicalInputs).toEqual(harness.events);
    } finally {
      unsubscribe();
      await harness.close();
    }
  });

  it.each(['descriptor', 'settle'] as const)(
    'does not publish a %s event before its journal record is durable',
    async (operationKind) => {
      const current = fixture;
      if (!current) throw new Error('Repository fixture was not created.');
      await current.reopen();
      const target = current.ownedTarget(
        'chat',
        `s2a-durable-${operationKind}`,
        1,
      );

      let armed = false;
      let signalRecordWritten = (): void => undefined;
      const recordWritten = new Promise<void>((resolve) => {
        signalRecordWritten = resolve;
      });
      let releaseWrite = (): void => undefined;
      const writeReleased = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      const openSpy = jest.spyOn(ChatDeltaJournalWriter, 'open');
      const originalOpen = openSpy.getMockImplementation();
      if (!originalOpen) {
        openSpy.mockRestore();
        throw new Error('Chat delta journal writer open was not mockable.');
      }
      openSpy.mockImplementation((store, options) => {
        const writerOptions = options ?? {};
        return originalOpen(store, {
          ...writerOptions,
          onBoundary: async (boundary): Promise<void> => {
            await writerOptions.onBoundary?.(boundary);
            if (armed && boundary === 'record-written') {
              armed = false;
              signalRecordWritten();
              await writeReleased;
            }
          },
        });
      });

      let harness: EventHarness | undefined;
      let operation: Promise<unknown> | undefined;
      try {
        expect(await current.port.open({ target })).toMatchObject({ ok: true });
        harness = await createEventHarness(current);
        const beforeRevision = harness.sync.getStatus(
          current.scope.projectId,
          current.scope.worktreeId,
        )?.revision;
        if (beforeRevision === undefined || beforeRevision === null)
          throw new Error('The chat scope was not hydrated.');

        armed = true;
        if (operationKind === 'descriptor') {
          operation = current.port.updateCardState({
            target,
            cardRevision: 1,
            cardDraft: {
              version: 2,
              status: 'running',
              outputTruncated: false,
              prompt: 'Durability-gated descriptor',
            },
          });
        } else {
          const request: DelegationTranscriptSettleRequest = {
            target,
            settlementKey: 's2a-durability-gated-settle',
            resultIndex: 1,
            outcome: { status: 'completed', finishedAt: 200 },
            finalChanges: [],
            answer: { role: 'final', text: 'Durability-gated answer' },
          };
          operation = current.port.settle(request);
        }

        const pendingOperation = operation;
        if (pendingOperation === undefined)
          throw new Error('The durability-gated mutation was not started.');
        await Promise.race([
          recordWritten,
          pendingOperation.then(() => {
            throw new Error(
              'The mutation completed before reaching its journal record.',
            );
          }),
        ]);
        expect(harness.events).toEqual([]);
        expect(harness.canonicalInputs).toEqual([]);

        releaseWrite();
        await operation;
        armed = false;
        expect(harness.events).toHaveLength(1);
        expect(harness.canonicalInputs).toHaveLength(1);
        const [event] = harness.events;
        if (!event) throw new Error('The durable event was not delivered.');
        expect(event).toMatchObject({
          baseRevision: beforeRevision,
          revision: beforeRevision + 1,
        });
        expect(event.changes).toHaveLength(1);
        expect(event.changes[0]?.type).toBe('delegation.card_state_updated');
        expect(harness.canonicalInputs).toEqual([event]);
      } finally {
        armed = false;
        releaseWrite();
        try {
          await operation?.catch(() => undefined);
          await harness?.close();
        } finally {
          openSpy.mockRestore();
        }
      }
    },
  );

  it('delivers concurrently committed descriptor changes in repository revision order', async () => {
    const current = fixture;
    if (!current) throw new Error('Repository fixture was not created.');
    const firstId = 's2a-batch-first';
    const secondId = 's2a-batch-second';
    const firstTarget = current.ownedTarget('chat', firstId, 1);
    const secondTarget = current.ownedTarget('chat', secondId, 1);
    expect(await current.port.open({ target: firstTarget })).toMatchObject({
      ok: true,
    });
    expect(await current.port.open({ target: secondTarget })).toMatchObject({
      ok: true,
    });
    const harness = await createEventHarness(current);

    try {
      const before = await current.service.getState(current.scope);
      const firstUpdate = current.port.updateCardState({
        target: firstTarget,
        cardRevision: 1,
        cardDraft: {
          version: 2,
          status: 'running',
          outputTruncated: false,
          prompt: 'First card',
        },
      });
      const secondUpdate = current.port.updateCardState({
        target: secondTarget,
        cardRevision: 1,
        cardDraft: {
          version: 2,
          status: 'running',
          outputTruncated: false,
          prompt: 'Second card',
        },
      });
      const results = await Promise.all([firstUpdate, secondUpdate]);
      expect(results).toMatchObject([{ ok: true }, { ok: true }]);

      await waitForEventCount(harness.events, 2);
      const after = await current.service.getState(current.scope);
      expect(after.revision).toBe(before.revision + 2);
      expect(harness.events).toHaveLength(2);
      expect(
        harness.events.map((event) => ({
          baseRevision: event.baseRevision,
          revision: event.revision,
        })),
      ).toEqual([
        { baseRevision: before.revision, revision: before.revision + 1 },
        {
          baseRevision: before.revision + 1,
          revision: before.revision + 2,
        },
      ]);
      expect(
        harness.events.map((event) =>
          event.changes.map((change) =>
            change.type === 'delegation.card_state_updated'
              ? change.delegationId
              : change.type,
          ),
        ),
      ).toEqual([[firstId], [secondId]]);
      expect(harness.canonicalInputs).toEqual(harness.events);
      expect(
        harness.sync.getStatus(
          current.scope.projectId,
          current.scope.worktreeId,
        )?.revision,
      ).toBe(after.revision);
    } finally {
      await harness.close();
    }
  });
});
