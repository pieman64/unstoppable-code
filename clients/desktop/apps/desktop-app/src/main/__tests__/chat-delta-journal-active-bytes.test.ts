/**
 * Phase 10 review fix: the size trigger's active-turn byte total.
 *
 * After every journaled commit the writer asks whether a checkpoint is due
 * (`needsCheckpoint`) and, when it arms the idle timer, whether a turn is in
 * progress (`holdsActiveTurn`). Both read each overlay's `activeBytes`. That
 * total must be maintained as the active rows change, not recomputed from
 * every active row: a recount costs O(active rows) per provider event, so
 * O(n²) over a tool-heavy turn, the very cost phase 10 removes.
 *
 * The first test counts the row sizes a commit computes at turn sizes 10 and
 * 1,000. The others prove the maintained total always equals the total
 * recomputed from the rows, through upserts (new rows, and replacements
 * with larger and smaller rows), removals, full rewrites, clones, a
 * checkpoint, a turn-end append and a recovery reopen.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatCoreMutation,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import type * as ActiveTurnModule from '../lib/chat-delta-journal/active-turn';
import type { DeltaJournalTranscriptEffect } from '../lib/chat-delta-journal/format';
import {
  ChatTranscriptOverlay,
  messageDigest,
  type TranscriptOverlayBase,
} from '../lib/chat-delta-journal/transcript-overlay';
import { ChatDeltaJournalWriter } from '../lib/chat-delta-journal/writer';
import type { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import { createV2Scope } from './helpers/chat-delta-journal-harness';
import {
  drainOpenRepositories,
  manifestVersion,
  repositoryAt,
  storeAt,
  text,
  upsert,
} from './helpers/chat-delta-journal-scope';
import {
  toolResultRow,
  toolUseRow,
  turnEnd,
  turnStart,
} from './helpers/chat-delta-journal-turn';

/** Row sizes computed since the counter was last reset. */
const mockRowBytes = { calls: 0 };

jest.mock('../lib/chat-delta-journal/active-turn', () => {
  const actual = jest.requireActual<typeof ActiveTurnModule>(
    '../lib/chat-delta-journal/active-turn',
  );
  return {
    ...actual,
    activeRowBytes: (message: PersistedChatMessage): number => {
      mockRowBytes.calls += 1;
      return actual.activeRowBytes(message);
    },
  };
});

const SCOPE = { projectId: 'workspace', worktreeId: 'scope' };
/** No idle checkpoint fires while a test runs. */
const INERT = { deltaJournalIdleCheckpointMs: 3_600_000 };
/** Rows each measured commit changes: a tool call's use and its result. */
const ROWS_PER_CALL = 2;
const MEASURED_COMMITS = 5;

let ordinal = 0;
async function commit(
  repository: ChatStateV2Repository,
  mutations: ChatCoreMutation[],
): Promise<void> {
  ordinal += 1;
  await repository.transact(SCOPE, mutations, {
    source: 'provider',
    mutationId: `event-${ordinal}`,
  });
}

function callMutations(call: number): ChatCoreMutation[] {
  return [
    upsert('chat', toolUseRow('turn', call)),
    upsert('chat', toolResultRow('turn', call)),
  ];
}

function serializedBytes(rows: readonly PersistedChatMessage[]): number {
  let bytes = 0;
  for (const row of rows)
    bytes += Buffer.byteLength(JSON.stringify(row), 'utf8');
  return bytes;
}

/** What the total must be: the active projection's rows, measured afresh. */
function recomputedActiveBytes(overlay: ChatTranscriptOverlay): number {
  const projection = overlay.activeProjection();
  return projection ? serializedBytes(projection.messages) : 0;
}

/** Deterministic PRNG (mulberry32) so a failure reproduces exactly. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function row(id: string, length: number): PersistedChatMessage {
  return text(id, 'x'.repeat(length), 'assistant', 10);
}

/** Files holding committed rows and an active projection, for an overlay. */
function fakeBase(
  committed: readonly PersistedChatMessage[],
  active: readonly PersistedChatMessage[],
): TranscriptOverlayBase {
  const byId = new Map(committed.map((message) => [message.id, message]));
  return {
    exists: () => Promise.resolve(true),
    committedMessageState: (
      _chatId: string,
      message: PersistedChatMessage,
    ): Promise<'absent' | 'identical' | 'different'> => {
      const existing = byId.get(message.id);
      if (!existing) return Promise.resolve('absent');
      return Promise.resolve(
        messageDigest(existing) === messageDigest(message)
          ? 'identical'
          : 'different',
      );
    },
    hasCommittedMessage: (_chatId, messageId) =>
      Promise.resolve(byId.has(messageId)),
    activeMessages: () =>
      Promise.resolve(active.map((message) => structuredClone(message))),
    iterate: async function* (): AsyncGenerator<PersistedChatMessage> {
      for (const message of committed) yield await Promise.resolve(message);
    },
    transcriptRevision: () => Promise.resolve(7),
  };
}

describe('delta journal active-turn byte total (phase 10)', () => {
  let root: string;
  jest.setTimeout(600_000);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-delta-journal-active-bytes-'));
    ordinal = 0;
    mockRowBytes.calls = 0;
  });

  afterEach(async () => {
    await drainOpenRepositories();

    await rm(root, { recursive: true, force: true });
  });

  /**
   * Row sizes computed per commit once a turn holds `calls` tool calls,
   * averaged over {@link MEASURED_COMMITS} further calls.
   */
  async function rowSizesPerCommit(
    scopeRoot: string,
    calls: number,
  ): Promise<number> {
    await createV2Scope(scopeRoot, 'scope', [
      { id: 'chat', messages: [text('m0', 'hello', 'user'), text('m1', 'hi')] },
    ]);
    const repository = repositoryAt(scopeRoot, INERT);
    await repository.getState(SCOPE);
    expect(await manifestVersion(storeAt(scopeRoot, 'scope'))).toBe(3);
    await commit(repository, turnStart('chat', 'turn'));
    for (let call = 0; call < calls; call += 1)
      await commit(repository, callMutations(call));
    mockRowBytes.calls = 0;
    for (let call = calls; call < calls + MEASURED_COMMITS; call += 1)
      await commit(repository, callMutations(call));
    const perCommit = mockRowBytes.calls / MEASURED_COMMITS;
    await commit(repository, turnEnd('chat', 'turn'));
    await repository.drainAll();
    return perCommit;
  }

  it('computes only the changed rows’ sizes per commit, at 10 and at 1,000 tool calls', async () => {
    const small = await rowSizesPerCommit(join(root, 'small'), 10);
    const large = await rowSizesPerCommit(join(root, 'large'), 1_000);
    const details = { small, large, rowsChangedPerCommit: ROWS_PER_CALL };
    process.stderr.write(
      `active-bytes per commit: ${JSON.stringify(details)}\n`,
    );
    // Each changed row is measured once; nothing else is.
    expect(small).toBeLessThanOrEqual(ROWS_PER_CALL);
    expect(large).toBeLessThanOrEqual(ROWS_PER_CALL);
  });

  it('keeps an overlay’s total equal to its rows through upserts, removals, rewrites and clones', async () => {
    const random = seededRandom(0x5eed_10);
    const committed = [row('c0', 40), row('c1', 80)];
    const initialActive = [row('a0', 120), row('a1', 30), row('a2', 600)];
    let overlay = await ChatTranscriptOverlay.open(
      'chat',
      fakeBase(committed, initialActive),
      false,
    );
    // No effect has written the active projection: nothing is journaled.
    expect(overlay.activeBytes).toBe(0);
    let active = (await overlay.activeMessages()).map((message) => message.id);
    let next = 0;
    let revision = 0;
    const apply = async (
      effect: DeltaJournalTranscriptEffect,
    ): Promise<void> => {
      revision += 1;
      await overlay.apply(effect, revision);
      active = (await overlay.activeMessages()).map((message) => message.id);
      expect(overlay.activeBytes).toBe(recomputedActiveBytes(overlay));
      expect(overlay.activeBytes).toBe(
        serializedBytes(await overlay.activeMessages()),
      );
    };
    const pick = (): string => active[Math.floor(random() * active.length)];
    const length = (): number => 1 + Math.floor(random() * 2_000);
    for (let step = 0; step < 400; step += 1) {
      const choice = random();
      if (choice < 0.35 || active.length === 0) {
        next += 1;
        await apply({
          chatId: 'chat',
          kind: 'active-upsert',
          create: false,
          messages: [row(`n${next}`, length())],
        });
      } else if (choice < 0.65) {
        // Replace a row with a larger or smaller one.
        await apply({
          chatId: 'chat',
          kind: 'active-upsert',
          create: false,
          messages: [row(pick(), length())],
        });
      } else if (choice < 0.8) {
        const removedId = pick();
        const rows = await overlay.activeMessages();
        await apply({
          chatId: 'chat',
          kind: 'active-replace',
          create: false,
          messages: rows.filter((message) => message.id !== removedId),
        });
      } else if (choice < 0.9) {
        const rows = await overlay.activeMessages();
        await apply({
          chatId: 'chat',
          kind: 'active',
          create: false,
          messages: rows.map((message) =>
            random() < 0.3 ? row(message.id, length()) : message,
          ),
        });
      } else {
        overlay = overlay.clone();
        expect(overlay.activeBytes).toBe(recomputedActiveBytes(overlay));
      }
    }
    expect(overlay.activeBytes).toBeGreaterThan(0);
    // The turn ends: its rows are finalized, and the committed change
    // leaves no active projection for a checkpoint to write.
    const rows = await overlay.activeMessages();
    revision += 1;
    await overlay.apply(
      {
        chatId: 'chat',
        kind: 'append',
        create: false,
        messages: rows.slice(0, Math.max(1, Math.floor(rows.length / 2))),
      },
      revision,
    );
    expect(overlay.changesCommittedRows).toBe(true);
    expect(overlay.activeBytes).toBe(0);
    expect(recomputedActiveBytes(overlay)).toBe(0);
  });

  it('keeps the writer’s total equal to its rows across a checkpoint, a recovery reopen and the turn end', async () => {
    const random = seededRandom(0x5eed_11);
    await createV2Scope(root, 'scope', [
      { id: 'chat', messages: [text('m0', 'hello', 'user'), text('m1', 'hi')] },
    ]);
    const store = storeAt(root, 'scope');
    const expectWriterTotal = (writer: ChatDeltaJournalWriter): number => {
      const projection = writer.activeProjection('chat');
      const expected = projection ? serializedBytes(projection.messages) : 0;
      expect(writer.activeTurnBytes()).toBe(expected);
      expect(writer.holdsActiveTurn()).toBe(expected > 0);
      return expected;
    };
    /** Tool calls with replacements of earlier rows, larger and smaller. */
    const events = async (
      repository: ChatStateV2Repository,
      from: number,
      count: number,
    ): Promise<void> => {
      for (let call = from; call < from + count; call += 1) {
        await commit(repository, callMutations(call));
        if (call > 0 && random() < 0.5) {
          const earlier = Math.floor(random() * call);
          const resized: PersistedChatMessage = {
            ...toolResultRow('turn', earlier),
            blocks: [
              {
                type: 'tool_result',
                toolUseId: `turn-tool-${earlier}`,
                toolName: 'mcp__canopy__GetScriptOutput',
                output: 'y'.repeat(1 + Math.floor(random() * 3_000)),
                isError: false,
              },
            ],
          };
          await commit(repository, [upsert('chat', resized)]);
        }
      }
    };

    const first = repositoryAt(root, INERT);
    await first.getState(SCOPE);
    expect(await manifestVersion(store)).toBe(3);
    await commit(first, turnStart('chat', 'turn'));
    await events(first, 0, 40);
    // The process stops; recovery rebuilds the turn by replaying records.
    const recovered = await ChatDeltaJournalWriter.open(store);
    expect(expectWriterTotal(recovered)).toBeGreaterThan(0);
    // A checkpoint writes the rows; the journal holds none afterwards.
    await recovered.checkpoint();
    expect(expectWriterTotal(recovered)).toBe(0);

    const second = repositoryAt(root, INERT);
    await second.getState(SCOPE);
    await events(second, 40, 40);
    const reopened = await ChatDeltaJournalWriter.open(store);
    expect(expectWriterTotal(reopened)).toBeGreaterThan(0);

    const third = repositoryAt(root, INERT);
    await third.getState(SCOPE);
    await events(third, 80, 10);
    await commit(third, turnEnd('chat', 'turn'));
    await third.drainAll();
    const ended = await ChatDeltaJournalWriter.open(store);
    expect(expectWriterTotal(ended)).toBe(0);
  });
});
