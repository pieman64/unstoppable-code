/**
 * Phase 10: with default journal storage, the in-progress turn lives in
 * memory and in journal records. No checkpoint during the turn rewrites the
 * whole turn's active rows, so chat-storage bytes per provider event do not
 * grow with the turn (P0 §C's first scaling row, bound 1.1×).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatCoreMutation } from '@canopy/desktop-shared/types';
import type { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import { createV2Scope } from './helpers/chat-delta-journal-harness';
import {
  drainOpenRepositories,
  manifestVersion,
  measureWork,
  repositoryAt,
  storeAt,
  text,
  upsert,
  type WorkDelta,
} from './helpers/chat-delta-journal-scope';
import {
  toolResultRow,
  toolUseRow,
  turnEnd,
  turnStart,
} from './helpers/chat-delta-journal-turn';

const SCOPE = { projectId: 'workspace', worktreeId: 'scope' };
/**
 * The idle checkpoint delay the suite runs with. Phase 10 never arms it
 * during a turn; on phase 09 it fires in each idle window below and
 * rewrites the turn's active rows.
 */
const IDLE_MS = 50;
/**
 * Provider events between idle windows, as tool calls pause a long turn.
 * Kept sparse so the 1,000-call turn runs in seconds: each window still
 * rewrites the whole turn on phase 09 (see `scaling-red.log`).
 */
const EVENTS_PER_IDLE_WINDOW = 50;
/** An idle window: the idle trigger fires and its checkpoint finishes. */
const IDLE_WINDOW_MS = IDLE_MS * 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TurnWork {
  work: WorkDelta;
  events: number;
}

let ordinal = 0;
async function commit(
  repository: ChatStateV2Repository,
  mutations: ChatCoreMutation[],
): Promise<void> {
  ordinal += 1;
  // No `chatIds`: the selection only shapes the read view a reducer would
  // build from, and these mutations are fixed. That view reads every active
  // row per event, a read cost this byte measurement does not count and
  // that would make the 1,000-call turn take minutes.
  await repository.transact(SCOPE, mutations, {
    source: 'provider',
    mutationId: `event-${ordinal}`,
  });
}

/**
 * One tool-heavy turn of `calls` tool calls, measured from its first event
 * to quiet after its last, with an idle window every
 * {@link EVENTS_PER_IDLE_WINDOW} events.
 */
async function measureTurn(root: string, calls: number): Promise<TurnWork> {
  await createV2Scope(root, 'scope', [
    { id: 'chat', messages: [text('m0', 'hello', 'user'), text('m1', 'hi')] },
  ]);
  const repository = repositoryAt(root, {
    deltaJournalIdleCheckpointMs: IDLE_MS,
  });
  await repository.getState(SCOPE);
  expect(await manifestVersion(storeAt(root, 'scope'))).toBe(3);
  let events = 0;
  const event = async (mutations: ChatCoreMutation[]): Promise<void> => {
    await commit(repository, mutations);
    events += 1;
    if (events % EVENTS_PER_IDLE_WINDOW === 0) await sleep(IDLE_WINDOW_MS);
  };
  const done = measureWork();
  await event(turnStart('chat', 'turn'));
  // One provider event per tool call, its use and its result together:
  // half the commits of separate events, each still an O(delta) record.
  for (let call = 0; call < calls; call += 1)
    await event([
      upsert('chat', toolUseRow('turn', call)),
      upsert('chat', toolResultRow('turn', call)),
    ]);
  await event(turnEnd('chat', 'turn'));
  await sleep(IDLE_WINDOW_MS);
  const work = done();
  await repository.drainAll();
  return { work, events };
}

describe('delta journal active turn (phase 10)', () => {
  let root: string;
  jest.setTimeout(600_000);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-delta-journal-active-turn-'));
    ordinal = 0;
  });

  afterEach(async () => {
    await drainOpenRepositories();

    await rm(root, { recursive: true, force: true });
  });

  it('writes no more chat-storage bytes per provider event at 1,000 tool calls than at 10 (≤1.1×)', async () => {
    const small = await measureTurn(join(root, 'small'), 10);
    const large = await measureTurn(join(root, 'large'), 1_000);
    const smallPerEvent = small.work.written / small.events;
    const largePerEvent = large.work.written / large.events;
    const ratio = largePerEvent / smallPerEvent;
    const details = {
      ratio: Number(ratio.toFixed(3)),
      smallPerEvent: Math.round(smallPerEvent),
      largePerEvent: Math.round(largePerEvent),
      smallWrittenByClass: small.work.writtenByClass,
      largeWrittenByClass: large.work.writtenByClass,
      smallEvents: small.events,
      largeEvents: large.events,
    };
    if (process.env.DELTA_JOURNAL_SCALING_LOG === '1')
      process.stderr.write(
        `active-turn scaling: ${JSON.stringify(details, null, 2)}\n`,
      );
    if (ratio > 1.1)
      throw new Error(
        `Scaling ratio above 1.1: ${JSON.stringify(details, null, 2)}`,
      );
    expect(ratio).toBeLessThanOrEqual(1.1);
  });
});
