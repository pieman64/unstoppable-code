import { performance } from 'node:perf_hooks';
import { TRANSCRIPT_PAGE_SIZE } from '@canopy/agent-transcript/transcript-storage';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import { ChatTranscriptLog } from '../lib/chat-transcript-log';
import {
  setChatTranscriptRewriteDiagnosticsForTests,
  type ChatTranscriptFullRewriteDiagnostic,
} from '../services/chat-transcript-rewrite-diagnostics';
import {
  createTurnStartFixture,
  LARGE_CHAT_ID,
  LARGE_HISTORY_ROW_COUNT,
  SMALL_CHAT_ID,
  SMALL_HISTORY_ROW_COUNT,
  type TurnStartFixture,
} from './helpers/turn-start-latency/fixture';

jest.setTimeout(240_000);

/* eslint-disable @typescript-eslint/unbound-method */

interface TranscriptReads {
  committedRowsRead: number;
  fullReadRows: number;
  pageReads: number;
  maxPageRows: number;
}

interface TranscriptReadProbe {
  begin(): void;
  finish(): TranscriptReads;
}

interface TurnMeasurement extends TranscriptReads {
  elapsedMs: number;
}

function installTranscriptReadProbe(): TranscriptReadProbe {
  let measuring = false;
  let committedRowsRead = 0;
  let fullReadRows = 0;
  let pageReads = 0;
  let maxPageRows = 0;
  const originalIterate = ChatTranscriptLog.prototype.iterate;
  const originalIterateLogical = ChatTranscriptLog.prototype.iterateLogical;
  const originalPage = ChatTranscriptLog.prototype.pageWithActiveMessages;

  jest
    .spyOn(ChatTranscriptLog.prototype, 'iterate')
    .mockImplementation(async function* (
      this: ChatTranscriptLog,
      chatId: string,
    ): AsyncGenerator<PersistedChatMessage> {
      for await (const message of originalIterate.call(this, chatId)) {
        if (measuring) {
          committedRowsRead += 1;
          fullReadRows += 1;
        }
        yield message;
      }
    });
  jest
    .spyOn(ChatTranscriptLog.prototype, 'iterateLogical')
    .mockImplementation(async function* (
      this: ChatTranscriptLog,
      chatId: string,
    ): AsyncGenerator<PersistedChatMessage> {
      for await (const message of originalIterateLogical.call(this, chatId)) {
        if (measuring) {
          committedRowsRead += 1;
          fullReadRows += 1;
        }
        yield message;
      }
    });
  type PageArguments = Parameters<ChatTranscriptLog['pageWithActiveMessages']>;
  type PageResult = Awaited<
    ReturnType<ChatTranscriptLog['pageWithActiveMessages']>
  >;
  jest
    .spyOn(ChatTranscriptLog.prototype, 'pageWithActiveMessages')
    .mockImplementation(async function (
      this: ChatTranscriptLog,
      ...args: PageArguments
    ): Promise<PageResult> {
      const result = await originalPage.apply(this, args);
      if (measuring) {
        committedRowsRead += result.page.messages.length;
        pageReads += 1;
        maxPageRows = Math.max(maxPageRows, result.page.messages.length);
      }
      return result;
    });

  return {
    begin: (): void => {
      committedRowsRead = 0;
      fullReadRows = 0;
      pageReads = 0;
      maxPageRows = 0;
      measuring = true;
    },
    finish: (): TranscriptReads => {
      measuring = false;
      return { committedRowsRead, fullReadRows, pageReads, maxPageRows };
    },
  };
}

async function measureTurnStart(
  fixture: TurnStartFixture,
  probe: TranscriptReadProbe,
  chatId: string,
  turnNumber: number,
  ownTurnAsyncAnswer = false,
): Promise<TurnMeasurement> {
  probe.begin();
  const startedAt = performance.now();
  let reads: TranscriptReads = {
    committedRowsRead: 0,
    fullReadRows: 0,
    pageReads: 0,
    maxPageRows: 0,
  };
  try {
    if (ownTurnAsyncAnswer)
      await fixture.startOwnTurnAsyncAnswer(chatId, turnNumber);
    else await fixture.startTurn(chatId, turnNumber);
  } finally {
    reads = probe.finish();
  }
  const elapsedMs = performance.now() - startedAt;
  return { ...reads, elapsedMs };
}

function p95(measurements: readonly TurnMeasurement[]): number {
  const sorted = measurements
    .map((measurement) => measurement.elapsedMs)
    .sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

function maxReadCount(
  measurements: readonly TurnMeasurement[],
  field: keyof TranscriptReads,
): number {
  return measurements.reduce(
    (maximum, measurement) => Math.max(maximum, measurement[field]),
    0,
  );
}

describe('turn-start transcript-size budget', () => {
  let fixture: TurnStartFixture | undefined;
  const rewrites: ChatTranscriptFullRewriteDiagnostic[] = [];

  beforeEach(() => {
    rewrites.length = 0;
    setChatTranscriptRewriteDiagnosticsForTests({
      sink: (record): void => {
        rewrites.push(record);
      },
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (fixture) await fixture.dispose();
    fixture = undefined;
    setChatTranscriptRewriteDiagnosticsForTests();
  });

  it('keeps prompt handoff bounded and append-only for small and large transcripts', async (): Promise<void> => {
    fixture = await createTurnStartFixture();
    const probe = installTranscriptReadProbe();
    const smallBefore = await fixture.readTurnSnapshot(SMALL_CHAT_ID);
    const largeBefore = await fixture.readTurnSnapshot(LARGE_CHAT_ID);
    const largeDescriptor = await fixture.transcript.descriptor(LARGE_CHAT_ID);
    expect(largeDescriptor.committedMessageCount).toBe(LARGE_HISTORY_ROW_COUNT);
    expect(largeDescriptor.committedByteLength).toBeGreaterThan(40_000_000);
    expect(largeDescriptor.committedByteLength).toBeLessThan(50_000_000);

    const smallMeasurements: TurnMeasurement[] = [];
    const largeMeasurements: TurnMeasurement[] = [];
    for (let turn = 0; turn < 8; turn += 1) {
      smallMeasurements.push(
        await measureTurnStart(fixture, probe, SMALL_CHAT_ID, turn),
      );
      largeMeasurements.push(
        await measureTurnStart(fixture, probe, LARGE_CHAT_ID, turn),
      );
    }
    smallMeasurements.push(
      await measureTurnStart(fixture, probe, SMALL_CHAT_ID, 8, true),
    );
    largeMeasurements.push(
      await measureTurnStart(fixture, probe, LARGE_CHAT_ID, 8, true),
    );

    const smallAfter = await fixture.readTurnSnapshot(SMALL_CHAT_ID);
    const largeAfter = await fixture.readTurnSnapshot(LARGE_CHAT_ID);
    process.stdout.write(
      `[turn-start-latency] measured p95 and max reads ${JSON.stringify({
        small: {
          p95Ms: p95(smallMeasurements),
          maxCommittedRowsRead: maxReadCount(
            smallMeasurements,
            'committedRowsRead',
          ),
          maxFullReadRows: maxReadCount(smallMeasurements, 'fullReadRows'),
          maxPageReads: maxReadCount(smallMeasurements, 'pageReads'),
        },
        large: {
          p95Ms: p95(largeMeasurements),
          maxCommittedRowsRead: maxReadCount(
            largeMeasurements,
            'committedRowsRead',
          ),
          maxFullReadRows: maxReadCount(largeMeasurements, 'fullReadRows'),
          maxPageReads: maxReadCount(largeMeasurements, 'pageReads'),
          committedBytes: largeDescriptor.committedByteLength,
        },
      })}\n`,
    );

    expect(maxReadCount(largeMeasurements, 'fullReadRows')).toBe(0);
    expect(maxReadCount(smallMeasurements, 'fullReadRows')).toBe(0);
    expect(rewrites).toEqual([]);
    // Native comparison: deep-equal on 42 MB buffers exhausts the in-band CI heap.
    expect(
      largeAfter.bytes
        .subarray(0, largeBefore.bytes.length)
        .equals(largeBefore.bytes),
    ).toBe(true);
    expect(
      smallAfter.bytes
        .subarray(0, smallBefore.bytes.length)
        .equals(smallBefore.bytes),
    ).toBe(true);
    expect(largeAfter.bytes.length).toBeGreaterThan(largeBefore.bytes.length);
    expect(smallAfter.bytes.length).toBeGreaterThan(smallBefore.bytes.length);
    expect(largeAfter.locatorOffsets).toEqual(largeBefore.locatorOffsets);
    expect(smallAfter.locatorOffsets).toEqual(smallBefore.locatorOffsets);
    // Reads do not grow with history: each bounded read returns at most one
    // page plus the current turn's frame rows (prompt, timer), and the large
    // chat makes no more of them than the small one.
    expect(maxReadCount(largeMeasurements, 'maxPageRows')).toBeLessThanOrEqual(
      TRANSCRIPT_PAGE_SIZE + 16,
    );
    expect(maxReadCount(largeMeasurements, 'pageReads')).toBeLessThanOrEqual(
      maxReadCount(smallMeasurements, 'pageReads') + 2,
    );
    // The read bounds above are the size check. Timing is not: the small
    // chat's pages are partial and the large chat's are full, and the
    // absolute target needs a quiet host.
    if (process.env.CANOPY_TURN_START_ABSOLUTE === '1') {
      expect(p95(smallMeasurements)).toBeLessThan(2_000);
      expect(p95(largeMeasurements)).toBeLessThan(2_000);
    }
    expect(fixture.historyIdsByChatId.get(SMALL_CHAT_ID)).toHaveLength(
      SMALL_HISTORY_ROW_COUNT,
    );
  });
});
