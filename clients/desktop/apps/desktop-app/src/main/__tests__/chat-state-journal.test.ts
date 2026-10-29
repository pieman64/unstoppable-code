/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-unsafe-assignment */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ChatJournalRecord } from '@canopy/desktop-shared/types';
import {
  appendChatJournalRecord,
  preserveSnapshotConflict,
  readChatJournal,
  replaceChatJournal,
} from '../lib/chat-state-journal';

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof fsPromises>('node:fs/promises');
  return {
    ...actual,
    open: jest.fn(actual.open),
    readFile: jest.fn(actual.readFile),
  };
});

function record(revision: number): ChatJournalRecord {
  return {
    v: 1,
    revision,
    mutationId: `mutation-${revision}`,
    occurredAt: '2026-08-07T12:00:00.000Z',
    source: 'provider',
    mutations: [
      {
        type: 'runtime.patched',
        chatId: 'chat-1',
        runtime: { status: 'streaming', queuedMessageIds: [] },
      },
    ],
  };
}

describe('chat state journal', () => {
  let tempDir: string;
  let journalPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'canopy-chat-journal-'));
    journalPath = join(tempDir, 'chat-journals', 'worktree.jsonl');
  });

  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  it('appends complete records and fsyncs a replayable JSONL stream', async () => {
    await appendChatJournalRecord(journalPath, record(1));
    await appendChatJournalRecord(journalPath, record(2));
    await expect(readChatJournal(journalPath)).resolves.toMatchObject({
      records: [{ revision: 1 }, { revision: 2 }],
      diagnostics: [],
    });
    expect(readFileSync(journalPath, 'utf8')).toMatch(/\n$/u);
  });

  it('streams records without a whole-file read and reports record statistics', async () => {
    await appendChatJournalRecord(journalPath, record(1));
    await appendChatJournalRecord(journalPath, record(2));
    const readFileMock = jest.mocked(fsPromises.readFile);
    readFileMock.mockClear();

    const result = await readChatJournal(journalPath);

    expect(readFileMock).not.toHaveBeenCalledWith(journalPath);
    expect(result.stats).toEqual({
      recordCount: 2,
      totalRecordBytes: expect.any(Number),
      maxRecordBytes: expect.any(Number),
      meanRecordBytes: expect.any(Number),
    });
    expect(result.stats.totalRecordBytes).toBeGreaterThan(0);
    expect(result.stats.maxRecordBytes).toBeLessThan(result.byteLength);
  });

  it('recovers an oversized complete record losslessly and reports the advisory threshold', async () => {
    const serialized = `${JSON.stringify(record(1))}\n`;
    mkdirSync(dirname(journalPath), { recursive: true });
    writeFileSync(journalPath, serialized);

    const result = await readChatJournal(journalPath, { maxRecordBytes: 64 });

    expect(result.records).toEqual([record(1)]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ kind: 'advisory_threshold_exceeded' }),
    ]);
    expect(readFileSync(journalPath, 'utf8')).toBe(serialized);
  });

  it('does not synchronously reserialize recovered records for advisory accounting', async () => {
    const serialized = `${JSON.stringify(record(1))}\n`;
    mkdirSync(dirname(journalPath), { recursive: true });
    writeFileSync(journalPath, serialized);
    const stringifySpy = jest.spyOn(JSON, 'stringify');

    try {
      await readChatJournal(journalPath, { maxMutationBytes: 16 });
      expect(stringifySpy).not.toHaveBeenCalled();
    } finally {
      stringifySpy.mockRestore();
    }
  });

  it('appends and recovers records above every advisory threshold without dropping mutations', async () => {
    const oversized: ChatJournalRecord = {
      ...record(1),
      mutations: [
        ...record(1).mutations,
        {
          type: 'runtime.patched',
          chatId: 'chat-2',
          runtime: { status: 'completed', queuedMessageIds: [] },
        },
      ],
    };
    const thresholds = {
      maxRecordBytes: 64,
      maxMutationBytes: 16,
      maxMutationsPerRecord: 1,
    };

    await appendChatJournalRecord(journalPath, oversized, thresholds);
    const result = await readChatJournal(journalPath, thresholds);

    expect(result.records).toEqual([oversized]);
    expect(result.records[0]?.mutations).toHaveLength(2);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ kind: 'advisory_threshold_exceeded' }),
    ]);
  });

  it('fsyncs the containing directory when the first record creates the journal', async () => {
    const openMock = jest.mocked(fsPromises.open);
    openMock.mockClear();

    await appendChatJournalRecord(journalPath, record(1));

    expect(openMock).toHaveBeenCalledWith(dirname(journalPath), 'r');
  });

  it('ignores and truncates only an incomplete final line', async () => {
    await appendChatJournalRecord(journalPath, record(1));
    appendFileSync(journalPath, '{"v":1,"revision":2');

    const result = await readChatJournal(journalPath);
    expect(result.records).toHaveLength(1);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ kind: 'partial_tail' }),
    ]);
    expect(readFileSync(journalPath, 'utf8')).toBe(
      `${JSON.stringify(record(1))}\n`,
    );
  });

  it('quarantines a malformed complete record and the remainder', async () => {
    await appendChatJournalRecord(journalPath, record(1));
    appendFileSync(
      journalPath,
      '{"v":1,"revision":"bad"}\n' + `${JSON.stringify(record(3))}\n`,
    );

    const result = await readChatJournal(journalPath);
    expect(result.records).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      kind: 'malformed_record',
      quarantinePath: expect.any(String),
    });
    const quarantinePath = result.diagnostics[0]?.quarantinePath;
    expect(quarantinePath && existsSync(quarantinePath)).toBe(true);
    expect(readFileSync(quarantinePath!, 'utf8')).toContain('"revision":3');
    expect(readFileSync(journalPath, 'utf8')).toBe(
      `${JSON.stringify(record(1))}\n`,
    );
  });

  it('replaces a compacted journal atomically', async () => {
    await replaceChatJournal(journalPath, [record(8), record(9)]);
    const result = await readChatJournal(journalPath);
    expect(result.records.map((entry) => entry.revision)).toEqual([8, 9]);
  });

  it('creates the conflict directory before preserving a snapshot', async () => {
    const sourcePath = join(tempDir, 'source.json');
    const conflictPath = join(tempDir, 'missing', 'conflicts', 'snapshot.json');
    writeFileSync(sourcePath, '{"version":1}');

    await preserveSnapshotConflict(sourcePath, conflictPath);

    expect(readFileSync(conflictPath, 'utf8')).toBe('{"version":1}');
  });
});
