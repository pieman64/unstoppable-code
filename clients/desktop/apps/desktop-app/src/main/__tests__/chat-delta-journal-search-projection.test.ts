/**
 * Phase 10, step 1: chat search's incremental, journal-backed active-turn
 * projection. With default journal storage, an in-progress turn's rows
 * live in the journal writer's memory and records. Search re-extracts only
 * the rows a turn changed since its last read (`activeTurnDelta`), with no
 * preview capture and no journal replay, and its query results and
 * previews equal checkpoint-backed preview indexing of the same turn,
 * step for step.
 */
import type * as FsPromisesModule from 'node:fs/promises';

jest.mock('../observability', () => ({
  getObservabilityService: (): { recordSessionDiagnostic: jest.Mock } => ({
    recordSessionDiagnostic: jest.fn(),
  }),
}));

jest.mock('node:fs/promises', () => {
  const actual =
    jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
  return { ...actual, readFile: jest.fn(actual.readFile) };
});

jest.mock('electron', (): { BrowserWindow: { getAllWindows: () => [] } } => ({
  BrowserWindow: { getAllWindows: (): [] => [] },
}));

/** The search service reads previews and deltas through this adapter. */
const mockChatState: {
  repository?: ChatStateV2Repository;
} = {};
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): Pick<
    ChatStateV2Repository,
    'consumeTranscriptPreview' | 'activeTurnDelta'
  > => {
    const repository = mockChatState.repository;
    if (!repository) throw new Error('No repository under test');
    return {
      consumeTranscriptPreview: (...args) =>
        repository.consumeTranscriptPreview(...args),
      activeTurnDelta: (...args) => repository.activeTurnDelta(...args),
    };
  },
}));

import * as fsPromises from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import type {
  ChatCoreMutation,
  ChatTabsFile,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { ChatSearchService } from '../chat-search/service';
import { ChatSearchIndexer } from '../chat-search/indexer';
import * as indexerModule from '../chat-search/indexer';
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
  timerRow,
  toolResultRow,
  toolUseRow,
  turnEnd,
  turnStart,
} from './helpers/chat-delta-journal-turn';

const SCOPE = { projectId: 'workspace', worktreeId: 'scope' };
const mockedReadFile = jest.mocked(fsPromises.readFile);

function draft(id: string, body: string): PersistedChatMessage {
  return text(id, body);
}

/** The turn under test: every step is one provider commit. */
function steps(): ChatCoreMutation[][] {
  return [
    turnStart('chat', 'turn'),
    [upsert('chat', draft('turn-draft', 'alphaneedle begins'))],
    [upsert('chat', draft('turn-draft', 'alphaneedle begins, betaneedle'))],
    [upsert('chat', toolUseRow('turn', 0))],
    [upsert('chat', toolResultRow('turn', 0))],
    [
      upsert(
        'chat',
        timerRow('turn', { pausedAt: 5, pauseOwnerIds: ['approval-1'] }),
      ),
    ],
    [upsert('chat', draft('turn-question', 'gammaneedle awaits an answer'))],
    [
      upsert(
        'chat',
        draft('turn-draft', 'alphaneedle rewritten, deltaneedle instead'),
      ),
    ],
    // A removal is not an upsert: search reads the active rows whole.
    [{ type: 'message.removed', chatId: 'chat', messageId: 'turn-question' }],
    [upsert('chat', toolUseRow('turn', 1))],
    [upsert('chat', toolResultRow('turn', 1))],
    [upsert('chat', draft('turn-draft', 'epsilonneedle closes the draft'))],
    turnEnd('chat', 'turn'),
  ];
}

const QUERIES = [
  'alphaneedle',
  'betaneedle',
  'gammaneedle',
  'deltaneedle',
  'epsilonneedle',
  'transcript',
  'complete',
  'hello',
];

interface StepView {
  step: number;
  results: Record<string, unknown>;
}

interface Run {
  views: StepView[];
  previewReads: number[];
  journalReads: number;
  extracted: number[];
}

describe('chat search active-turn projection (phase 10)', () => {
  let root: string;
  let originalDataDir: string | undefined;
  jest.setTimeout(120_000);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-delta-journal-search-'));
    originalDataDir = process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_DATA_DIR = join(root, 'data');
    resetResolvedCanopyDataDirForTests();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await drainOpenRepositories();
    mockChatState.repository = undefined;
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    resetResolvedCanopyDataDirForTests();
    await rm(root, { recursive: true, force: true });
  });

  async function run(incremental: boolean): Promise<Run> {
    const scopeRoot = join(root, incremental ? 'incremental' : 'checkpoint');
    await createV2Scope(scopeRoot, 'scope', [
      {
        id: 'chat',
        messages: [
          text('m0', 'hello transcript', 'user'),
          text('m1', 'hello answer'),
        ],
      },
    ]);

    // The optimized run keeps the turn journaled. The reference checkpoints
    // each step and uses preview reads, bypassing incremental active deltas.
    const repository = repositoryAt(scopeRoot, {
      deltaJournalIdleCheckpointMs: 3_600_000,
    });
    mockChatState.repository = repository;
    await repository.getState(SCOPE);
    expect(await manifestVersion(storeAt(scopeRoot, 'scope'))).toBe(3);
    const activeDelta = jest.spyOn(repository, 'activeTurnDelta');
    if (!incremental) activeDelta.mockResolvedValue(undefined);
    const search = new ChatSearchService({
      dbPath: join(scopeRoot, 'search.sqlite'),
      indexerFactory: (db): ChatSearchIndexer => new ChatSearchIndexer(db),
      debounceMs: 60_000,
      broadcastDebounceMs: 10,
      broadcastUpdated: (): void => undefined,
    });
    const previews = jest.spyOn(repository, 'consumeTranscriptPreview');
    const extract = jest.spyOn(indexerModule, 'extractChatSearchBody');
    const result: Run = {
      views: [],
      previewReads: [],
      journalReads: 0,
      extracted: [],
    };
    try {
      let index = 0;
      for (const mutations of steps()) {
        index += 1;
        await repository.transact(SCOPE, mutations, {
          source: 'provider',
          mutationId: `step-${index}`,
          chatIds: ['chat'],
        });
        if (!incremental) await repository.flushScope(SCOPE);
        const state = await repository.getState(SCOPE);
        const tabs: ChatTabsFile = state.tabsFile;
        previews.mockClear();
        extract.mockClear();
        mockedReadFile.mockClear();
        search.indexLiveTabChanges(
          SCOPE.projectId,
          SCOPE.worktreeId,
          tabs,
          ['chat'],
          [],
        );
        await search.flushPendingUpdates();
        result.previewReads.push(previews.mock.calls.length);
        result.extracted.push(extract.mock.calls.length);
        result.journalReads += mockedReadFile.mock.calls.filter(
          ([path]) =>
            typeof path === 'string' && path.endsWith('delta-journal.log'),
        ).length;
        const results: Record<string, unknown> = {};
        for (const query of QUERIES) results[query] = search.query({ query });
        result.views.push({ step: index, results });
      }
    } finally {
      await search.close();
      activeDelta.mockRestore();
      await repository.drainAll();
    }
    return result;
  }

  it('matches the sidecar-backed query results and previews at every step', async () => {
    const off = await run(false);
    const on = await run(true);
    expect(on.views).toHaveLength(off.views.length);
    for (let step = 0; step < off.views.length; step += 1)
      expect(on.views[step]).toEqual(off.views[step]);
    // In-flight text is visible while the turn runs, and replaced text is not.
    const midTurn = on.views[7].results;
    expect(midTurn.deltaneedle).toHaveLength(1);
    expect(midTurn.betaneedle).toEqual([]);
  });

  it('updates in-flight text from the changed rows only, without a preview read or journal replay', async () => {
    const on = await run(true);
    // Step 1 starts the turn (a committed prompt) and step 2 is the first
    // journal-projected read, which seeds the cache. Every later in-turn
    // update reads only the delta, except step 9, whose removal is not an
    // upsert and is read whole.
    const inTurn = (values: number[]): number[] => values.slice(2, 12);
    expect(inTurn(on.previewReads)).toEqual([0, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
    // One extraction per changed row: steps 3-8 and 10-12 change one row.
    expect(inTurn(on.extracted).filter((_, at) => at !== 6)).toEqual([
      1, 1, 1, 1, 1, 1, 1, 1, 1,
    ]);
    expect(on.journalReads).toBe(0);
  });
});
