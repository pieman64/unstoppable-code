/**
 * Property test: checkpoint + journal replay equals the version 2 state.
 *
 * For each fixed seed, a random sequence of chat commands runs against the
 * real version 2 backend. Every storage transaction it commits is journaled,
 * with the same inputs, in a promoted copy of the starting scope, while
 * checkpoints, restarts and torn tails happen at random points. After every
 * step the replayed state (exact index bytes plus every chat's committed and
 * active rows) must equal the version 2 files; after the final checkpoint
 * every file must be byte-identical.
 *
 * Seeds and iteration counts are fixed and bounded so the suite's time stays
 * flat. Longer randomized runs are on demand only: set
 * `DELTA_JOURNAL_PROPERTY_SEEDS` to a comma-separated list of seeds.
 */
import fs, { appendFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatCoreMutation,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import {
  DELTA_JOURNAL_FILE_NAME,
  encodeDeltaJournalFrame,
} from '../lib/chat-delta-journal/format';
import { readDeltaJournal } from '../lib/chat-delta-journal/replay';
import {
  ChatDeltaJournalWriter,
  promoteToDeltaJournal,
} from '../lib/chat-delta-journal/writer';
import type { ChatStorageV2 } from '../lib/chat-storage-v2';
import {
  ChatStateV2Backend,
  type V2MutationOptions,
} from '../services/chat-state-v2-backend';
import type { CanonicalChatState } from '../services/chat-state-reducer';
import {
  TRICKY_TEXT,
  cloneScope,
  createV2Scope,
  journalOnlyFile,
  message,
  pick,
  publishArtifacts,
  readPopulatedCache,
  recordV2Commits,
  replayedScopeState,
  seededRandom,
  toolMessage,
  treeDigests,
  v2ScopeState,
} from './helpers/chat-delta-journal-harness';

const STEPS = 28;
const SEEDS = (process.env.DELTA_JOURNAL_PROPERTY_SEEDS ?? '11,23,37,41,59')
  .split(',')
  .map(Number);

interface Command {
  label: string;
  options: Omit<V2MutationOptions, 'source' | 'mutationId'>;
  build: (current: CanonicalChatState) => ChatCoreMutation[];
}

interface Model {
  random: () => number;
  ordinal: number;
  streaming: Map<string, string[]>;
  deleted: string[];
  mutationIds: string[];
}

function next(model: Model, prefix: string): string {
  model.ordinal += 1;
  return `${prefix}${model.ordinal}`;
}

function randomMessage(
  model: Model,
  id: string,
  role: PersistedChatMessage['role'],
): PersistedChatMessage {
  if (role === 'assistant' && model.random() < 0.15)
    return toolMessage(id, `output ${id} 🌲\n`.repeat(5000));
  return message(
    id,
    model.random() < 0.2 ? `${TRICKY_TEXT} ${id}` : `text ${id}`,
    role,
    model.ordinal,
  );
}

function liveTab(
  current: CanonicalChatState,
  chatId: string,
): PersistedChatTab | undefined {
  return current.tabsFile.tabs.find((tab) => tab.id === chatId);
}

/** One random command against the scope's current metadata. */
function chooseCommand(model: Model, metadata: CanonicalChatState): Command {
  const random = model.random;
  const live = metadata.tabsFile.tabs.map((tab) => tab.id);
  const archived = metadata.archivesFile.archived.map((entry) => entry.tab.id);
  const idle = live.filter((id) => !model.streaming.has(id));
  const streaming = live.filter((id) => model.streaming.has(id));
  const roll = random();
  if (roll < 0.1 || live.length === 0) {
    const id =
      model.deleted.length && random() < 0.4
        ? pick(random, model.deleted)
        : next(model, 'c');
    model.deleted = model.deleted.filter((candidate) => candidate !== id);
    const messages = Array.from({ length: Math.floor(random() * 3) }, (_, i) =>
      randomMessage(model, next(model, 'm'), i % 2 ? 'assistant' : 'user'),
    );
    return {
      label: 'create',
      options: { chatIds: [id] },
      build: (): ChatCoreMutation[] => [
        {
          type: 'tab.created',
          tab: { id, title: id, createdAt: '2026-10-01', messages },
        },
      ],
    };
  }
  if (roll < 0.22 && idle.length) {
    const chatId = pick(random, idle);
    const prompt = next(model, 'p');
    model.streaming.set(chatId, []);
    return {
      label: 'start turn',
      options: {},
      build: (): ChatCoreMutation[] => [
        {
          type: 'runtime.patched',
          chatId,
          runtime: {
            status: 'streaming',
            queuedMessageIds: [],
            activeTurn: { userMessageId: prompt, startedAt: 5 },
          },
        },
        {
          type: 'message.upserted',
          chatId,
          message: message(prompt, `prompt ${prompt}`, 'user', model.ordinal),
        },
      ],
    };
  }
  if (roll < 0.42 && streaming.length) {
    const chatId = pick(random, streaming);
    const active = model.streaming.get(chatId) ?? [];
    const id =
      active.length && random() < 0.4 ? pick(random, active) : next(model, 'a');
    if (!active.includes(id)) active.push(id);
    const body = randomMessage(model, id, 'assistant');
    return {
      label: 'stream',
      options: {},
      build: (): ChatCoreMutation[] => [
        { type: 'message.upserted', chatId, message: body },
      ],
    };
  }
  if (roll < 0.5 && streaming.length) {
    const chatId = pick(random, streaming);
    model.streaming.delete(chatId);
    return {
      label: 'end turn',
      options: {},
      build: (): ChatCoreMutation[] => [
        {
          type: 'runtime.patched',
          chatId,
          runtime: { status: 'idle', queuedMessageIds: [] },
        },
      ],
    };
  }
  if (roll < 0.58 && idle.length) {
    const chatId = pick(random, idle);
    const amend = random() < 0.4;
    const fresh = next(model, 'u');
    return {
      label: amend ? 'amend committed' : 'append idle',
      options: { chatIds: [chatId] },
      build: (current): ChatCoreMutation[] => {
        const existing = liveTab(current, chatId)?.messages ?? [];
        const target =
          amend && existing.length ? pick(random, existing) : undefined;
        return [
          {
            type: 'message.upserted',
            chatId,
            message: target
              ? message(target.id, `amended ${fresh}`, target.role, 3)
              : randomMessage(model, fresh, 'assistant'),
          },
        ];
      },
    };
  }
  if (roll < 0.64 && live.length) {
    const chatId = pick(random, live);
    return {
      label: 'remove message',
      options: { chatIds: [chatId] },
      build: (current): ChatCoreMutation[] => {
        const existing = liveTab(current, chatId)?.messages ?? [];
        if (!existing.length) return [];
        const target = pick(random, existing);
        const active = model.streaming.get(chatId);
        if (active)
          model.streaming.set(
            chatId,
            active.filter((id) => id !== target.id),
          );
        return [{ type: 'message.removed', chatId, messageId: target.id }];
      },
    };
  }
  if (roll < 0.7 && live.length) {
    const chatId = pick(random, live);
    const ordinal = next(model, 'r');
    return {
      label: 'metadata with receipt',
      options: {
        commandResult: {
          commandId: `command-${ordinal}`,
          outcome: 'applied',
          entityId: chatId,
        },
      },
      build: (): ChatCoreMutation[] => [
        {
          type: 'tab.metadata_patched',
          tabId: chatId,
          patch: { title: `title ${ordinal}`, unread: random() < 0.5 },
        },
      ],
    };
  }
  if (roll < 0.78 && live.length > 1) {
    const chatId = pick(random, live);
    const extra =
      random() < 0.3
        ? randomMessage(model, next(model, 'x'), 'assistant')
        : undefined;
    const turnCount = Math.floor(random() * 5);
    model.streaming.delete(chatId);
    return {
      label: 'archive',
      options: { chatIds: [chatId] },
      build: (current): ChatCoreMutation[] => {
        const tab = liveTab(current, chatId);
        if (!tab) return [];
        return [
          { type: 'tab.removed', tabId: chatId },
          {
            type: 'archive.upserted',
            entry: {
              tab: extra ? { ...tab, messages: [...tab.messages, extra] } : tab,
              archivedAt: '2026-10-01',
              turnCount,
            },
          },
        ];
      },
    };
  }
  if (roll < 0.84 && archived.length) {
    const chatId = pick(random, archived);
    return {
      label: 'restore',
      options: { chatIds: [chatId] },
      build: (current): ChatCoreMutation[] => {
        const entry = current.archivesFile.archived.find(
          (candidate) => candidate.tab.id === chatId,
        );
        if (!entry) return [];
        return [
          { type: 'archive.removed', archiveEntryId: chatId, chatId },
          { type: 'tab.created', tab: entry.tab },
          { type: 'tab.active_changed', activeTabId: chatId },
        ];
      },
    };
  }
  if (roll < 0.88 && live.length > 1) {
    const chatId = pick(random, idle.length ? idle : live);
    model.streaming.delete(chatId);
    model.deleted.push(chatId);
    return {
      label: 'delete',
      options: {},
      build: (): ChatCoreMutation[] => [{ type: 'tab.removed', tabId: chatId }],
    };
  }
  if (roll < 0.93 && idle.length) {
    const chatId = pick(random, idle);
    const added = randomMessage(model, next(model, 'n'), 'assistant');
    return {
      label: 'replace messages',
      options: { chatIds: [chatId], fullTranscript: true },
      build: (current): ChatCoreMutation[] => {
        const existing = liveTab(current, chatId)?.messages ?? [];
        const kept = existing.filter(() => random() < 0.7);
        const keptIds = new Set(kept.map((row) => row.id));
        return [
          {
            type: 'messages.replaced',
            chatId,
            messages: [...kept, added],
            removedMessageIds: existing
              .map((row) => row.id)
              .filter((id) => !keptIds.has(id)),
          },
        ];
      },
    };
  }
  if (roll < 0.96 && archived.length) {
    const chatId = pick(random, archived);
    return {
      label: 'archive read state',
      options: {},
      build: (): ChatCoreMutation[] => [
        {
          type: 'archive.read_state_changed',
          archiveEntryId: chatId,
          chatId,
          unread: random() < 0.5,
        },
      ],
    };
  }
  const chatId = pick(random, live);
  return {
    label: 'select chat',
    options: {},
    build: (): ChatCoreMutation[] => [
      { type: 'tab.active_changed', activeTabId: chatId },
    ],
  };
}

async function tearTail(
  random: () => number,
  store: ChatStorageV2,
): Promise<void> {
  const path = join(store.directory, DELTA_JOURNAL_FILE_NAME);
  const journal = await readDeltaJournal(store.directory, 'scope');
  const kind = random();
  if (kind < 0.4) {
    const { frame } = encodeDeltaJournalFrame({
      type: 'commit',
      v: 1,
      prev: journal.lastDigest,
      fromRevision: journal.lastRevision,
      toRevision: journal.lastRevision + 1,
      mutationIds: ['torn'],
      delta: {},
      transcripts: [],
    });
    await appendFile(
      path,
      frame.subarray(0, 1 + Math.floor(random() * (frame.length - 1))),
    );
  } else if (kind < 0.7)
    await appendFile(path, Buffer.alloc(1 + Math.floor(random() * 300)));
  else
    await appendFile(
      path,
      Buffer.from(
        Array.from({ length: 1 + Math.floor(random() * 300) }, () =>
          Math.floor(random() * 256),
        ),
      ),
    );
}

describe('delta journal replay equivalence', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-delta-journal-property-'));
    // Equivalence, not durability, is under test here (the fault-injection
    // suite owns crash behavior), so skip the full-sync syscall itself.
    const open = fs.open;
    jest.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      handle.sync = (): Promise<void> => Promise.resolve();
      return handle;
    });
    jest.useFakeTimers({
      now: new Date('2026-10-01T12:00:00.000Z'),
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
        'queueMicrotask',
        'hrtime',
        'performance',
      ],
    });
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it.each(SEEDS)(
    'checkpoint + replay equals the v2 files for seed %i',
    async (seed) => {
      const random = seededRandom(seed);
      const model: Model = {
        random,
        ordinal: 0,
        streaming: new Map(),
        deleted: [],
        mutationIds: [],
      };
      const v2 = await createV2Scope(join(root, 'v2'), 'scope', [
        {
          id: 'c0',
          messages: [
            message('m0', 'hello', 'user'),
            message('m1', TRICKY_TEXT),
          ],
        },
        { id: 'c1', messages: [message('m2', 'sibling', 'user')] },
      ]);
      const journal = await cloneScope(v2, join(root, 'journal'), 'scope');
      await promoteToDeltaJournal(journal);
      let writer = await ChatDeltaJournalWriter.open(journal);
      const backend = new ChatStateV2Backend(v2);
      await backend.load();
      const recorder = recordV2Commits(backend.storage, []);
      const log: string[] = [];
      let journaled = 0;
      try {
        for (let step = 0; step < STEPS; step += 1) {
          const command = chooseCommand(model, await backend.state());
          const retry = model.mutationIds.length > 0 && random() < 0.05;
          const mutationId = retry
            ? pick(random, model.mutationIds)
            : next(model, 'mutation-');
          if (!retry) model.mutationIds.push(mutationId);
          try {
            await backend.transact(command.build, {
              ...command.options,
              source: 'automation',
              mutationId,
            });
            log.push(command.label);
          } catch (error) {
            log.push(
              `${command.label} rejected: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          for (const commit of recorder.commits.splice(0)) {
            if (
              writer.checkpointRequiredFor(commit.writes.map((w) => w.chatId))
            )
              await writer.checkpoint();
            await publishArtifacts(v2, journal);
            expect((await writer.commit(commit)).applied).toBe(true);
            journaled += 1;
          }
          const event = random();
          if (event < 0.2) {
            await writer.checkpoint();
            log.push('checkpoint');
          } else if (event < 0.32) {
            writer = await ChatDeltaJournalWriter.open(journal);
            log.push('restart');
          } else if (event < 0.42) {
            const size = (
              await stat(join(journal.directory, DELTA_JOURNAL_FILE_NAME))
            ).size;
            await tearTail(random, journal);
            expect(await replayedScopeState(journal)).toEqual(
              await v2ScopeState(v2),
            );
            writer = await ChatDeltaJournalWriter.open(journal);
            expect(
              (await stat(join(journal.directory, DELTA_JOURNAL_FILE_NAME)))
                .size,
            ).toBe(size);
            log.push('torn tail');
          }
          const expected = await v2ScopeState(v2);
          const actual = await replayedScopeState(journal);
          if (JSON.stringify(actual) !== JSON.stringify(expected))
            throw new Error(`Seed ${seed} diverged after: ${log.join(' → ')}`);
          for (const [chatId, chat] of Object.entries(expected.chats)) {
            expect(
              (await writer.committedMessages(chatId)).map((row) =>
                JSON.stringify(row),
              ),
            ).toEqual(chat.committed);
            expect(
              (await writer.activeMessages(chatId)).map((row) =>
                JSON.stringify(row),
              ),
            ).toEqual(chat.active);
          }
        }
        await writer.checkpoint();
        expect(
          await treeDigests(
            journal.directory,
            (path) => journalOnlyFile(path) || readPopulatedCache(path),
          ),
        ).toEqual(await treeDigests(v2.directory, readPopulatedCache));
        expect(await replayedScopeState(journal)).toEqual(
          await v2ScopeState(v2),
        );
        if (process.env.DELTA_JOURNAL_PROPERTY_LOG === '1')
          process.stderr.write(`seed ${seed}: ${log.join(' | ')}\n`);
        // The sequence exercised real transactions, not only rejections.
        expect(journaled).toBeGreaterThanOrEqual(STEPS / 2);
      } finally {
        recorder.stop();
      }
    },
    240_000,
  );
});
