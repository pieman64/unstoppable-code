/**
 * Phase 10, readers: with default journal storage, an in-progress turn
 * stays in the journal for the whole turn, not only until the next idle
 * checkpoint, so its active sidecar on disk is stale throughout. Every
 * reader of `*.active.json` goes through `ChatTranscriptLog`: the backend's
 * log takes the active rows from the writer's projection (pages, previews,
 * search), and lease-free readers replay the journal. This suite checks the
 * readers whose behavior the longer window changes:
 *
 * - lease-free replay readers (`ChatStorageV2.indexes()` behind catalogs,
 *   history listings and discovery; `openReplayedChatScope`) see the turn's
 *   rows after idle windows, exactly as the backend serves them;
 * - artifact maintenance, which needs every reference in the files, now
 *   waits for the turn to end in every chat of the scope.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatCoreMutation } from '@canopy/desktop-shared/types';
import { assertChatStorageIndexes } from '../lib/chat-storage-v2';
import { openReplayedChatScope } from '../lib/chat-delta-journal/reader';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { createV2Scope } from './helpers/chat-delta-journal-harness';
import {
  drainOpenRepositories,
  idle,
  repositoryAt,
  storeAt,
  text,
  toolResult,
  upsert,
} from './helpers/chat-delta-journal-scope';
import {
  toolResultRow,
  toolUseRow,
  turnEnd,
  turnStart,
} from './helpers/chat-delta-journal-turn';

const SCOPE = { projectId: 'workspace', worktreeId: 'scope' };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('delta journal readers during an in-progress turn (phase 10)', () => {
  let root: string;
  jest.setTimeout(120_000);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-delta-journal-turn-readers-'));
  });

  afterEach(async () => {
    await drainOpenRepositories();

    await rm(root, { recursive: true, force: true });
  });

  it('lease-free replay readers see the turn the journal holds after idle windows', async () => {
    await createV2Scope(root, 'scope', [
      { id: 'chat', messages: [text('m0', 'hello', 'user'), text('m1', 'hi')] },
    ]);
    const repository = repositoryAt(root, { deltaJournalIdleCheckpointMs: 10 });
    await repository.getState(SCOPE);
    let id = 0;
    const commit = async (mutations: ChatCoreMutation[]): Promise<void> => {
      id += 1;
      await repository.transact(SCOPE, mutations, {
        source: 'provider',
        mutationId: `reader-${id}`,
        chatIds: ['chat'],
      });
    };
    await commit(turnStart('chat', 'turn'));
    const store = storeAt(root, 'scope');
    const sidecar = join(store.directory, 'transcripts', 'chat.active.json');
    const sidecarAtTurnStart = await readFile(sidecar, 'utf8');
    for (let call = 0; call < 5; call += 1) {
      await commit([upsert('chat', toolUseRow('turn', call))]);
      await commit([upsert('chat', toolResultRow('turn', call))]);
      await sleep(60);
    }
    // No idle checkpoint rewrote the turn: the sidecar is the turn start's.
    expect(await readFile(sidecar, 'utf8')).toBe(sidecarAtTurnStart);
    const served = await repository.getState(SCOPE, {
      chatIds: ['chat'],
      fullTranscript: true,
    });
    const servedTab = served.tabsFile.tabs[0];
    // Catalogs, history listings and discovery read `indexes()`.
    const indexes = await store.indexes();
    expect(indexes.live.tabs[0].transcript).toEqual(servedTab.transcript);
    expect(indexes.live.revision).toBe(served.tabsFile.revision);
    const view = await openReplayedChatScope(
      { directory: store.directory, scopeId: 'scope' },
      assertChatStorageIndexes,
    );
    try {
      const log = view.transcript('chat');
      const rows = [];
      for await (const row of log.iterate('chat')) rows.push(row);
      rows.push(...(await log.activeMessages('chat')));
      expect(rows).toEqual(servedTab.messages);
      expect(rows.map((row) => row.id)).toContain('turn-result-4');
    } finally {
      await view.dispose();
    }
    await repository.drainAll();
  });

  it('artifact maintenance waits for the in-progress turn to end in every chat of the scope', async () => {
    await createV2Scope(root, 'scope', [
      { id: 'chat', messages: [text('m0', 'hello', 'user'), text('m1', 'hi')] },
      { id: 'other', messages: [text('o0', 'other', 'user')] },
    ]);
    const store = storeAt(root, 'scope');
    const backend = new ChatStateV2Backend(store, { deltaJournal: {} });
    await backend.load();
    await backend.promoteToDeltaJournal();
    let id = 0;
    const transact = async (
      mutations: ChatCoreMutation[],
      chatIds: string[],
    ): Promise<void> => {
      id += 1;
      await backend.transact(() => mutations, {
        source: 'provider',
        mutationId: `maintenance-${id}`,
        chatIds,
      });
    };
    // The other chat leaves a superseded tool output behind.
    await transact(
      [
        {
          type: 'runtime.patched',
          chatId: 'other',
          runtime: {
            status: 'streaming',
            queuedMessageIds: [],
            activeTurn: { userMessageId: 'o0', startedAt: 1 },
          },
        },
        upsert('other', text('o-a', 'running')),
      ],
      ['other'],
    );
    await transact(
      [upsert('other', toolResult('o-t', 'first 🌲\n'.repeat(9000)))],
      ['other'],
    );
    await transact(
      [upsert('other', toolResult('o-t', 'second 🌲\n'.repeat(9000)))],
      ['other'],
    );
    await transact([idle('other')], ['other']);
    expect(backend.pendingJournalRecords()).toBe(0);
    expect(await backend.pendingArtifactMaintenanceChats()).toContain('other');
    // A turn starts in the first chat and streams: its records stay
    // journaled, and nothing may scan the files until it ends.
    await transact(turnStart('chat', 'turn'), ['chat']);
    await transact([upsert('chat', toolUseRow('turn', 0))], ['chat']);
    expect(backend.journalIdleCheckpointWanted()).toBe(false);
    expect(await backend.checkpointPendingJournal('timer')).toBe(false);
    expect(await backend.pendingArtifactMaintenanceChats()).toEqual([]);
    // The turn ends: its record is checkpointed and maintenance resumes.
    await transact(turnEnd('chat', 'turn'), ['chat']);
    expect(backend.pendingJournalRecords()).toBe(0);
    expect(await backend.pendingArtifactMaintenanceChats()).toContain('other');
    await backend.disposeArtifactMaintenance();
  });
});
