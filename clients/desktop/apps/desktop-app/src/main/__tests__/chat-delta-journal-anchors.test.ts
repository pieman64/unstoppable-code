import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import { delegationTranscriptMessages } from '@canopy/agent-transcript';
import type { AgentDelegationTranscript } from '@canopy/protocol/delegation';
import {
  assertChatStorageIndexes,
  type ChatStorageV2,
} from '../lib/chat-storage-v2';
import {
  ChatDeltaJournalWriter,
  demoteFromDeltaJournal,
  promoteToDeltaJournal,
  type DeltaJournalBoundary,
  type DeltaJournalWrite,
} from '../lib/chat-delta-journal/writer';
import { readDeltaJournal } from '../lib/chat-delta-journal/replay';
import { openReplayedChatScope } from '../lib/chat-delta-journal/reader';
import { ChatTranscriptLog } from '../lib/chat-transcript-log';
import type { ActiveRowAnchor } from '../lib/chat-transcript-live-positions';
import { createV2Scope } from './helpers/chat-delta-journal-harness';
import { manifestVersion, text } from './helpers/chat-delta-journal-scope';

const CHAT_ID = 'chat';
const SCOPE_ID = 'scope';
const TRANSCRIPTS = 'transcripts';
const CHECKPOINT_WORK = 'delta-checkpoint-work';

function delegatedCard(): PersistedChatMessage {
  const event: AgentDelegationTranscript = {
    delegationId: 'delegation',
    runGeneration: 1,
    sequence: 1,
    parentHarnessId: 'parent-harness',
    parentTurnId: 'parent-turn',
    parentToolCallId: 'parent-tool-call',
    createdAt: 2,
    task: {
      description: 'A deterministic delegated task',
      prompt: 'Return a deterministic result.',
      executionMode: 'background',
    },
    snapshot: {
      delegationId: 'delegation',
      runGeneration: 1,
      requestedModelId: 'test-model',
      status: 'pending',
      outputTruncated: false,
    },
    transcript: [],
  };
  const card = delegationTranscriptMessages(event)[0];
  if (!card) throw new Error('Missing delegated-agent card');
  return card;
}

function delegatedChild(id: string, runId: string): PersistedChatMessage {
  return { ...text(id, 'delegated output'), parentBlockId: runId };
}

function activeAnchor(runId: string): ActiveRowAnchor {
  return { version: 1, runId, after: 'parent-message', tie: 0 };
}

function changedChild(child: PersistedChatMessage): PersistedChatMessage {
  return {
    ...child,
    blocks: [{ type: 'text', text: 'updated delegated output' }],
  };
}

async function anchoredWriter(
  root: string,
  options: {
    failAfterReplace?: boolean;
    onBoundary?: (boundary: DeltaJournalBoundary) => Promise<void>;
  } = {},
): Promise<{
  store: ChatStorageV2;
  log: ChatTranscriptLog;
  writer: ChatDeltaJournalWriter;
  card: PersistedChatMessage;
  child: PersistedChatMessage;
  anchor: ActiveRowAnchor;
}> {
  const card = delegatedCard();
  const child = delegatedChild('delegated-child', card.id);
  const anchor = activeAnchor(card.id);
  const store = await createV2Scope(root, SCOPE_ID, [
    {
      id: CHAT_ID,
      messages: [text('parent-message', 'parent turn', 'user'), card],
    },
  ]);
  await promoteToDeltaJournal(store);
  const log = new ChatTranscriptLog(
    join(store.directory, TRANSCRIPTS),
    undefined,
    options.failAfterReplace
      ? {
          testHooks: {
            onReplaceBoundary: (): Promise<void> =>
              Promise.reject(
                new Error('simulated crash after committed replace'),
              ),
          },
        }
      : undefined,
  );
  await log.writeActive(CHAT_ID, [child], new Map([[child.id, anchor]]));
  const writer = await ChatDeltaJournalWriter.open(store, {
    log,
    ...(options.onBoundary ? { onBoundary: options.onBoundary } : {}),
  });
  return { store, log, writer, card, child, anchor };
}

async function commit(
  writer: ChatDeltaJournalWriter,
  mutationId: string,
  write: DeltaJournalWrite,
): Promise<void> {
  const current = writer.indexes();
  const next = structuredClone(current);
  next.live.revision += 1;
  next.archive.revision += 1;
  next.recovery.mutationIds = [...next.recovery.mutationIds, mutationId];
  await writer.commit({
    expectedRevision: current.live.revision,
    next,
    writes: [write],
    mutationIds: [mutationId],
  });
}

async function recordRewrite(
  writer: ChatDeltaJournalWriter,
  kind: 'replace' | 'patch',
  card: PersistedChatMessage,
  child: PersistedChatMessage,
): Promise<void> {
  const write: DeltaJournalWrite =
    kind === 'replace'
      ? {
          chatId: CHAT_ID,
          kind,
          messages: [
            text('parent-message', 'parent turn', 'user'),
            card,
            child,
          ],
          activeTailCount: 1,
        }
      : {
          chatId: CHAT_ID,
          kind,
          patches: [],
          removedMessageIds: [],
          tail: [child],
          activeTailCount: 1,
        };
  await commit(writer, `rewrite-${kind}`, write);
}

describe('delta journal active-row anchors', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-delta-journal-anchors-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('keeps anchored-only journal projections from holding the parent active turn', async () => {
    const { store, log, writer, child, anchor } = await anchoredWriter(root);
    const updated = changedChild(child);
    await commit(writer, 'active-update', {
      chatId: CHAT_ID,
      kind: 'active-upsert',
      messages: [updated],
    });

    const projection = writer.activeProjection(CHAT_ID);
    expect(projection?.messages).toEqual([updated]);
    expect(projection).toHaveProperty('anchors', new Map([[child.id, anchor]]));
    expect(writer.activeTurnBytes()).toBeGreaterThan(0);
    expect(writer.holdsActiveTurn()).toBe(false);

    const replay = await openReplayedChatScope(
      { directory: store.directory, scopeId: SCOPE_ID },
      assertChatStorageIndexes,
    );
    try {
      expect(
        replay.indexes.live.tabs.find((tab) => tab.id === CHAT_ID)?.transcript
          .hasOrdinaryActiveRows,
      ).toBe(false);
    } finally {
      await replay.dispose();
    }

    await commit(writer, 'ordinary-tail', {
      chatId: CHAT_ID,
      kind: 'active-upsert',
      messages: [text('ordinary-tail', 'parent is still streaming')],
    });
    expect(writer.holdsActiveTurn()).toBe(true);
    await writer.checkpoint();
    expect((await log.activeSnapshot(CHAT_ID)).anchors).toEqual(
      new Map([[child.id, anchor]]),
    );
    await expect(manifestVersion(store)).resolves.toBe(3);
  });

  it.each(['replace', 'patch'] as const)(
    'preserves only surviving active anchors across a pending active update and %s',
    async (kind) => {
      const { store, log, writer, child, card, anchor } =
        await anchoredWriter(root);
      const updated = changedChild(child);
      await commit(writer, 'active-before-rewrite', {
        chatId: CHAT_ID,
        kind: 'active-upsert',
        messages: [updated],
      });
      await recordRewrite(writer, kind, card, updated);

      const journal = await readDeltaJournal(store.directory, SCOPE_ID);
      expect(
        journal.records.every((record) =>
          record.transcripts.every(
            (effect) =>
              !Object.prototype.hasOwnProperty.call(effect, 'anchors'),
          ),
        ),
      ).toBe(true);

      await writer.checkpoint();
      const snapshot = await log.activeSnapshot(CHAT_ID);
      expect(snapshot.messages).toEqual([updated]);
      expect(snapshot.anchors).toEqual(new Map([[child.id, anchor]]));
    },
  );

  it('recovers a checkpoint interrupted after replace and retains anchors through demotion', async () => {
    const { store, writer, child, card, anchor } = await anchoredWriter(root, {
      failAfterReplace: true,
    });
    const updated = changedChild(child);
    await commit(writer, 'active-before-interruption', {
      chatId: CHAT_ID,
      kind: 'active-upsert',
      messages: [updated],
    });
    await recordRewrite(writer, 'replace', card, updated);

    await expect(writer.checkpoint()).rejects.toThrow(
      'simulated crash after committed replace',
    );
    const workDirectory = join(store.directory, CHECKPOINT_WORK);
    const captureName = (await readdir(workDirectory)).find((name) =>
      name.endsWith('.anchors.json'),
    );
    expect(captureName).toBeDefined();
    const captured: unknown = JSON.parse(
      await readFile(join(workDirectory, captureName ?? ''), 'utf8'),
    );
    expect(captured).toHaveProperty('anchors', [[child.id, anchor]]);

    const recoveryLog = new ChatTranscriptLog(
      join(store.directory, TRANSCRIPTS),
    );
    const recovered = await ChatDeltaJournalWriter.open(store, {
      log: recoveryLog,
    });
    await expect(
      demoteFromDeltaJournal(store, { writer: recovered }),
    ).resolves.toBe(true);
    expect(await manifestVersion(store)).toBe(2);
    expect((await recoveryLog.activeSnapshot(CHAT_ID)).anchors).toEqual(
      new Map([[child.id, anchor]]),
    );
    await expect(readdir(workDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each(['replace', 'patch'] as const)(
    'retains anchored suffix rows when demotion checkpoint fails at marker removal after %s',
    async (kind) => {
      let injected = false;
      const observed: DeltaJournalBoundary[] = [];
      const { store, writer, child, card, anchor } = await anchoredWriter(
        root,
        {
          onBoundary: (boundary): Promise<void> => {
            observed.push(boundary);
            if (!injected && boundary === 'marker-removed') {
              injected = true;
              return Promise.reject(
                new Error(
                  'injected demotion checkpoint marker removal failure',
                ),
              );
            }
            return Promise.resolve();
          },
        },
      );
      const updated = changedChild(child);
      await commit(writer, `active-before-failed-demotion-${kind}`, {
        chatId: CHAT_ID,
        kind: 'active-upsert',
        messages: [updated],
      });
      await recordRewrite(writer, kind, card, updated);

      await expect(demoteFromDeltaJournal(store, { writer })).rejects.toThrow(
        'injected demotion checkpoint marker removal failure',
      );
      expect(injected).toBe(true);
      expect(observed).toContain('marker-removed');
      await expect(manifestVersion(store)).resolves.toBe(3);
      const workDirectory = join(store.directory, CHECKPOINT_WORK);
      expect(
        (await readdir(workDirectory)).some((name) =>
          name.endsWith('.anchors.json'),
        ),
      ).toBe(true);

      const replay = await openReplayedChatScope(
        { directory: store.directory, scopeId: SCOPE_ID },
        assertChatStorageIndexes,
      );
      try {
        const snapshot = await replay
          .transcript(CHAT_ID)
          .activeSnapshot(CHAT_ID);
        expect(snapshot.messages).toEqual([updated]);
        expect(snapshot.anchors).toEqual(new Map([[child.id, anchor]]));
      } finally {
        await replay.dispose();
      }

      const recoveryLog = new ChatTranscriptLog(
        join(store.directory, TRANSCRIPTS),
      );
      const recovered = await ChatDeltaJournalWriter.open(store, {
        log: recoveryLog,
      });
      await expect(readdir(workDirectory)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(
        demoteFromDeltaJournal(store, { writer: recovered }),
      ).resolves.toBe(true);
      await expect(manifestVersion(store)).resolves.toBe(2);
      const demotedSnapshot = await recoveryLog.activeSnapshot(CHAT_ID);
      expect(demotedSnapshot.messages).toEqual([updated]);
      expect(demotedSnapshot.anchors).toEqual(new Map([[child.id, anchor]]));
    },
  );

  it('uses durable checkpoint captures during read-only replay of an interrupted replace', async () => {
    const { store, writer, child, card, anchor } = await anchoredWriter(root, {
      failAfterReplace: true,
    });
    const updated = changedChild(child);
    await commit(writer, 'active-before-read-only-replay', {
      chatId: CHAT_ID,
      kind: 'active-upsert',
      messages: [updated],
    });
    await recordRewrite(writer, 'replace', card, updated);
    await expect(writer.checkpoint()).rejects.toThrow(
      'simulated crash after committed replace',
    );

    const replay = await openReplayedChatScope(
      { directory: store.directory, scopeId: SCOPE_ID },
      assertChatStorageIndexes,
    );
    try {
      const snapshot = await replay.transcript(CHAT_ID).activeSnapshot(CHAT_ID);
      expect(snapshot.messages).toEqual([updated]);
      expect(snapshot.anchors).toEqual(new Map([[child.id, anchor]]));
    } finally {
      await replay.dispose();
    }
  });

  it('fails closed when a durable checkpoint anchor capture is malformed', async () => {
    const { store, writer, child, card } = await anchoredWriter(root, {
      failAfterReplace: true,
    });
    const updated = changedChild(child);
    await commit(writer, 'active-before-corruption', {
      chatId: CHAT_ID,
      kind: 'active-upsert',
      messages: [updated],
    });
    await recordRewrite(writer, 'replace', card, updated);
    await expect(writer.checkpoint()).rejects.toThrow(
      'simulated crash after committed replace',
    );

    const workDirectory = join(store.directory, CHECKPOINT_WORK);
    const captureName = (await readdir(workDirectory)).find((name) =>
      name.endsWith('.anchors.json'),
    );
    expect(captureName).toBeDefined();
    await writeFile(join(workDirectory, captureName ?? ''), '{malformed');

    const recoveryLog = new ChatTranscriptLog(
      join(store.directory, TRANSCRIPTS),
    );
    await expect(
      ChatDeltaJournalWriter.open(store, { log: recoveryLog }),
    ).rejects.toThrow(/checkpoint.*anchor/i);
  });
});
