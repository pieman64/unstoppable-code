jest.mock('node:fs/promises');

jest.mock('../lib/atomic-file', () => ({
  writeFileAtomically: jest.fn(),
}));

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeSummaryFilePath: jest.fn(),
}));

jest.mock('../portal/portal-event-bus', () => ({
  createPortalEvent: jest.fn((type: string, payload: unknown) => ({
    type,
    payload,
  })),
  enqueuePortalEvent: jest.fn(),
  isCanopyPortalActive: jest.fn(() => true),
}));

import { mkdir, readFile } from 'node:fs/promises';
import type { WorktreeSummaryData } from '@canopy/desktop-shared/types';
import { writeFileAtomically } from '../lib/atomic-file';
import { resolveWorktreeSummaryFilePath } from '../lib/resolve-worktree';
import type {
  WorktreeSummaryFile,
  WorktreeSummaryProvenance,
  WorktreeSummarySnapshot,
} from '@canopy/desktop-shared/types';
import { MAX_TELEMETRY_SUMMARIES_PER_WORKTREE } from '@canopy/protocol';
import {
  addWorktreeSummaryChangeListener,
  clearWorktreeSummaryPortalFingerprints,
  removeWorktreeSummaryChangeListener,
  type WorktreeSummaryChangeListener,
  emitWorktreeSummaryPortalDelta,
  readWorktreeSummary,
  readWorktreeSummaryFile,
  readWorktreeSummaryWriteAbortReason,
  writeWorktreeSummary,
  writeWorktreeSummarySnapshot,
  isWorktreeSummaryData,
} from '../lib/worktree-summary-persistence';
import {
  enqueuePortalEvent,
  isCanopyPortalActive,
} from '../portal/portal-event-bus';

function lastWrittenFile(): WorktreeSummaryFile {
  const calls = mockedWriteFileAtomically.mock.calls;
  const raw = calls[calls.length - 1][1];
  if (typeof raw !== 'string') {
    throw new Error('expected a string write payload');
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- parsing JSON this test itself produced.
  const parsed: WorktreeSummaryFile = JSON.parse(raw);
  return parsed;
}

const mockedMkdir = jest.mocked(mkdir);
const mockedReadFile = jest.mocked(readFile);
const mockedWriteFileAtomically = jest.mocked(writeFileAtomically);
const mockedResolveWorktreeSummaryFilePath = jest.mocked(
  resolveWorktreeSummaryFilePath,
);
const mockedEnqueuePortalEvent = jest.mocked(enqueuePortalEvent);
const mockedIsCanopyPortalActive = jest.mocked(isCanopyPortalActive);

function makeSummary(): WorktreeSummaryData {
  return {
    title: 'Summary title',
    description: 'Summary description',
    highlights: ['One', 'Two'],
    generatedAt: '2026-03-25T12:00:00.000Z',
    turnCountAtGeneration: 3,
    lastFullRefreshAt: '2026-03-25T12:00:00.000Z',
    lastFullRefreshTurnCount: 3,
  };
}

describe('writeWorktreeSummary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearWorktreeSummaryPortalFingerprints();
    mockedResolveWorktreeSummaryFilePath.mockReturnValue(
      '/tmp/project-a/summaries/wt-1.json',
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFileAtomically.mockResolvedValue(undefined);
    mockedIsCanopyPortalActive.mockReturnValue(true);
    // No existing file by default.
    mockedReadFile.mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
  });

  it('emits the same summary again after portal-session fingerprints reset', () => {
    const summary = makeSummary();

    emitWorktreeSummaryPortalDelta('project-a', 'wt-1', summary, false);
    emitWorktreeSummaryPortalDelta('project-a', 'wt-1', summary, false);
    expect(mockedEnqueuePortalEvent).toHaveBeenCalledTimes(1);

    clearWorktreeSummaryPortalFingerprints();
    emitWorktreeSummaryPortalDelta('project-a', 'wt-1', summary, false);

    expect(mockedEnqueuePortalEvent).toHaveBeenCalledTimes(2);
  });

  it('creates the summary directory and writes a v2 file with a first snapshot', async () => {
    const summary = makeSummary();

    const result = await writeWorktreeSummary('project-a', 'wt-1', summary);

    expect(result).toBe(true);
    expect(mockedMkdir).toHaveBeenCalledWith('/tmp/project-a/summaries', {
      recursive: true,
    });
    // Replaced atomically and durably: the file is the Ledger journal.
    expect(mockedWriteFileAtomically).toHaveBeenCalledWith(
      '/tmp/project-a/summaries/wt-1.json',
      expect.any(String),
      { encoding: 'utf8', durable: true },
    );
    const written = lastWrittenFile();
    expect(written.version).toBe(2);
    expect(written.summary).toEqual(summary);
    expect(written.history).toHaveLength(1);
    expect(written.history[0].summary).toEqual(summary);
    expect(typeof written.history[0].snapshotId).toBe('string');
    expect(written.history[0].snapshotId.length).toBeGreaterThan(0);
    const portalEvent = mockedEnqueuePortalEvent.mock.calls[0]?.[0];
    expect(portalEvent?.type).toBe('portal.state.delta');
    expect(portalEvent?.payload).toMatchObject({
      entities: [
        {
          entityType: 'worktree_summary',
          parentLocalId: 'project-a:wt-1',
          payload: {
            highlights: ['One', 'Two'],
            generating: false,
          },
        },
      ],
    });
  });

  it('fingerprints unchanged portal projections and skips duplicate emission', async () => {
    const summary = makeSummary();
    await writeWorktreeSummary('project-a', 'wt-dedupe', summary);
    mockedReadFile.mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    await writeWorktreeSummary('project-a', 'wt-dedupe', summary);

    expect(mockedWriteFileAtomically).toHaveBeenCalledTimes(2);

    expect(mockedEnqueuePortalEvent).toHaveBeenCalledTimes(1);
  });

  it('does no portal projection work without an active session', async () => {
    mockedIsCanopyPortalActive.mockReturnValue(false);

    await writeWorktreeSummary('project-a', 'wt-1', {
      ...makeSummary(),
      title: 'Offline portal title',
    });

    expect(mockedEnqueuePortalEvent).not.toHaveBeenCalled();
  });

  it('appends a new snapshot when the content meaningfully changes', async () => {
    const first = makeSummary();
    const existing: WorktreeSummaryFile = {
      version: 2,
      summary: first,
      history: [{ snapshotId: 'snap-1', summary: first }],
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(existing));

    const changed = {
      ...makeSummary(),
      description: 'A different description',
    };
    await writeWorktreeSummary('project-a', 'wt-1', changed);

    const written = lastWrittenFile();
    expect(written.history).toHaveLength(2);
    expect(written.history[0].snapshotId).toBe('snap-1');
    expect(written.history[1].summary).toEqual(changed);
    expect(written.history[1].snapshotId).not.toBe('snap-1');
    expect(written.summary).toEqual(changed);
  });

  it('does not append when only volatile bookkeeping changes (dedup by content hash)', async () => {
    const first = makeSummary();
    const existing: WorktreeSummaryFile = {
      version: 2,
      summary: first,
      history: [{ snapshotId: 'snap-1', summary: first }],
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(existing));

    // Same narrative content, only counters/timestamps moved.
    const refreshed = {
      ...makeSummary(),
      generatedAt: '2026-03-25T13:00:00.000Z',
      turnCountAtGeneration: 9,
    };
    await writeWorktreeSummary('project-a', 'wt-1', refreshed);

    const written = lastWrittenFile();
    expect(written.history).toHaveLength(1);
    expect(written.history[0].snapshotId).toBe('snap-1');
    // Latest pointer still refreshed.
    expect(written.summary).toEqual(refreshed);
  });

  it('bounds the on-disk history to the most recent MAX entries', async () => {
    // Seed a history already at the cap, each entry with distinct content so
    // every snapshot is meaningful (oldest-first).
    const seeded: WorktreeSummarySnapshot[] = Array.from(
      { length: MAX_TELEMETRY_SUMMARIES_PER_WORKTREE },
      (_unused, index) => ({
        snapshotId: `snap-${index}`,
        summary: { ...makeSummary(), description: `desc-${index}` },
      }),
    );
    const existing: WorktreeSummaryFile = {
      version: 2,
      summary: seeded[seeded.length - 1].summary,
      history: seeded,
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(existing));

    const changed = { ...makeSummary(), description: 'desc-new' };
    await writeWorktreeSummary('project-a', 'wt-1', changed);

    const written = lastWrittenFile();
    // Still capped at MAX: the new snapshot pushed out the oldest entry.
    expect(written.history).toHaveLength(MAX_TELEMETRY_SUMMARIES_PER_WORKTREE);
    expect(written.history[0].snapshotId).toBe('snap-1');
    expect(written.history[written.history.length - 1].summary).toEqual(
      changed,
    );
    expect(written.summary).toEqual(changed);
  });

  it('upgrades a legacy v1 file to v2 with a derived first snapshot', async () => {
    const summary = makeSummary();
    mockedReadFile.mockResolvedValue(JSON.stringify({ version: 1, summary }));

    // Same content as the legacy entry → no new snapshot appended.
    await writeWorktreeSummary('project-a', 'wt-1', summary);

    const written = lastWrittenFile();
    expect(written.version).toBe(2);
    expect(written.history).toHaveLength(1);
    expect(written.history[0].snapshotId).toMatch(/^legacy-/);
  });

  it('returns false when the write fails', async () => {
    mockedWriteFileAtomically.mockRejectedValue(new Error('disk full'));

    const result = await writeWorktreeSummary(
      'project-a',
      'wt-1',
      makeSummary(),
    );

    expect(result).toBe(false);
  });
});

describe('readWorktreeSummaryWriteAbortReason', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveWorktreeSummaryFilePath.mockReturnValue('/tmp/summary.json');
  });

  it.each([
    [
      'a file it cannot read',
      (): void => {
        mockedReadFile.mockRejectedValue(
          Object.assign(new Error('EACCES'), { code: 'EACCES' }),
        );
      },
      'unreadable',
    ],
    [
      'a file a newer app wrote',
      (): void => {
        mockedReadFile.mockResolvedValue(
          JSON.stringify({ version: 3, summary: makeSummary(), history: [] }),
        );
      },
      'future_version',
    ],
    [
      'a missing file',
      (): void => {
        mockedReadFile.mockRejectedValue(
          Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
        );
      },
      null,
    ],
    [
      'a corrupt file',
      (): void => {
        mockedReadFile.mockResolvedValue('{"version": 2, "history": [');
      },
      null,
    ],
  ])(
    'reports whether a write over %s would abort',
    async (_, arrange, reason) => {
      arrange();

      await expect(
        readWorktreeSummaryWriteAbortReason('project-a', 'wt-1'),
      ).resolves.toBe(reason);
      expect(mockedWriteFileAtomically).not.toHaveBeenCalled();
    },
  );
});

describe('writeWorktreeSummarySnapshot', () => {
  const provenance: WorktreeSummaryProvenance = {
    generationId: 'generation-1',
    harness: 'claude',
    model: 'claude-sonnet',
    thinkingEffort: 'medium',
    observedTaskKey: 'helper:worktree-summary:project-a/wt-1:1',
    capturedAt: '2026-09-30T12:00:00.000Z',
    ledgerPublishable: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    clearWorktreeSummaryPortalFingerprints();
    mockedResolveWorktreeSummaryFilePath.mockReturnValue(
      '/tmp/project-a/summaries/wt-1.json',
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFileAtomically.mockResolvedValue(undefined);
    mockedReadFile.mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
  });

  it('records provenance on a new snapshot', async () => {
    const listener = jest.fn<void, Parameters<WorktreeSummaryChangeListener>>();
    addWorktreeSummaryChangeListener(listener);
    const result = await writeWorktreeSummarySnapshot(
      'project-a',
      'wt-1',
      makeSummary(),
      provenance,
    ).finally(() => removeWorktreeSummaryChangeListener(listener));
    // Telemetry hears about the change without the provenance.
    expect(Object.keys(listener.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
      'isNewSnapshot',
      'projectId',
      'snapshotId',
      'summary',
      'worktreeId',
    ]);

    expect(result).toMatchObject({
      isNewSnapshot: true,
      snapshot: { provenance },
      droppedPublishableSnapshotIds: [],
      replacedCorruptFile: false,
    });
    expect(lastWrittenFile().history[0].provenance).toEqual(provenance);
  });

  it('writes nothing while the existing file cannot be read', async () => {
    mockedReadFile.mockRejectedValue(
      Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    );

    const result = await writeWorktreeSummarySnapshot(
      'project-a',
      'wt-1',
      makeSummary(),
      provenance,
    );

    // Its unpublished snapshots stay for a later write or reconciliation.
    expect(result).toEqual({ kind: 'aborted', reason: 'unreadable' });
    expect(mockedWriteFileAtomically).not.toHaveBeenCalled();
  });

  it.each([3, 2.5])(
    'writes nothing over a version %s file a newer app wrote',
    async (version) => {
      const summary = makeSummary();
      mockedReadFile.mockResolvedValue(
        JSON.stringify({
          version,
          summary,
          history: [{ snapshotId: 'snap-1', summary, provenance }],
        }),
      );
      const listener = jest.fn<
        void,
        Parameters<WorktreeSummaryChangeListener>
      >();
      addWorktreeSummaryChangeListener(listener);

      const result = await writeWorktreeSummarySnapshot(
        'project-a',
        'wt-1',
        { ...summary, description: 'A different description' },
        provenance,
      ).finally(() => removeWorktreeSummaryChangeListener(listener));

      expect(result).toEqual({ kind: 'aborted', reason: 'future_version' });
      expect(mockedWriteFileAtomically).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    },
  );

  it('still replaces a file whose version is not a number', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ version: '3', summary: makeSummary(), history: [] }),
    );

    const result = await writeWorktreeSummarySnapshot(
      'project-a',
      'wt-1',
      makeSummary(),
      provenance,
    );

    expect(result).toMatchObject({
      kind: 'written',
      replacedCorruptFile: true,
    });
  });

  it('counts the history entries and publishable provenance it discards', async () => {
    const summary = makeSummary();
    const invalidProvenance = { ...provenance, generationId: '' };
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 2,
        summary,
        history: [
          { snapshotId: '', summary },
          { snapshotId: 'snap-broken', summary: { title: 'x' } },
          'not a snapshot',
          {
            snapshotId: 'snap-stripped',
            summary,
            provenance: invalidProvenance,
          },
          {
            snapshotId: 'snap-unpublishable',
            summary,
            provenance: { ...invalidProvenance, ledgerPublishable: false },
          },
          { snapshotId: 'snap-kept', summary, provenance },
        ],
      }),
    );

    const result = await writeWorktreeSummarySnapshot(
      'project-a',
      'wt-1',
      { ...summary, description: 'A different description' },
      provenance,
    );

    expect(result).toMatchObject({
      kind: 'written',
      droppedInvalidSnapshotCount: 3,
      strippedPublishableSnapshotIds: ['snap-stripped'],
      droppedPublishableSnapshotIds: [],
      replacedCorruptFile: false,
    });
    const history = lastWrittenFile().history;
    expect(history.map((snapshot) => snapshot.snapshotId)).toEqual([
      'snap-stripped',
      'snap-unpublishable',
      'snap-kept',
      expect.any(String),
    ]);
    expect(history[0]?.provenance).toBeUndefined();
    expect(history[2]?.provenance).toEqual(provenance);
  });

  it('discards nothing from a valid or legacy file', async () => {
    const summary = makeSummary();
    mockedReadFile.mockResolvedValue(JSON.stringify({ version: 1, summary }));

    const result = await writeWorktreeSummarySnapshot(
      'project-a',
      'wt-1',
      summary,
      provenance,
    );

    expect(result).toMatchObject({
      kind: 'written',
      isNewSnapshot: false,
      droppedInvalidSnapshotCount: 0,
      strippedPublishableSnapshotIds: [],
    });
  });

  it.each([
    ['is not JSON', '{"version": 2, "history": ['],
    ['is not a summary file', JSON.stringify({ version: 2, history: 'x' })],
  ])(
    'replaces an existing file that %s and reports it',
    async (_case, content) => {
      mockedReadFile.mockResolvedValue(content);

      const result = await writeWorktreeSummarySnapshot(
        'project-a',
        'wt-1',
        makeSummary(),
        provenance,
      );

      expect(result).toMatchObject({
        isNewSnapshot: true,
        replacedCorruptFile: true,
      });
      expect(lastWrittenFile().history).toEqual([
        result?.kind === 'written' ? result.snapshot : null,
      ]);
    },
  );

  it('keeps the matched snapshot and its provenance when nothing changed', async () => {
    const summary = makeSummary();
    const existing: WorktreeSummarySnapshot = {
      snapshotId: 'snap-1',
      summary,
      provenance: { ...provenance, generationId: 'generation-0' },
    };
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ version: 2, summary, history: [existing] }),
    );

    const result = await writeWorktreeSummarySnapshot(
      'project-a',
      'wt-1',
      { ...summary, generatedAt: '2026-09-30T13:00:00.000Z' },
      provenance,
    );

    expect(result).toMatchObject({ isNewSnapshot: false, snapshot: existing });
    expect(lastWrittenFile().history).toEqual([existing]);
  });

  it('reports the publishable snapshots the history cap drops', async () => {
    const seeded: WorktreeSummarySnapshot[] = Array.from(
      { length: MAX_TELEMETRY_SUMMARIES_PER_WORKTREE },
      (_unused, index) => ({
        snapshotId: `snap-${index}`,
        summary: { ...makeSummary(), description: `desc-${index}` },
        ...(index === 0 ? { provenance } : {}),
      }),
    );
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 2,
        summary: seeded[seeded.length - 1].summary,
        history: seeded,
      }),
    );

    const result = await writeWorktreeSummarySnapshot(
      'project-a',
      'wt-1',
      { ...makeSummary(), description: 'desc-new' },
      provenance,
    );

    expect(result).toMatchObject({ droppedPublishableSnapshotIds: ['snap-0'] });
  });
});

describe('readWorktreeSummaryFile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveWorktreeSummaryFilePath.mockReturnValue(
      '/tmp/project-a/summaries/wt-1.json',
    );
  });

  it('normalizes a v1 file to v2 with a single history entry', async () => {
    const summary = makeSummary();
    mockedReadFile.mockResolvedValue(JSON.stringify({ version: 1, summary }));

    const file = await readWorktreeSummaryFile('project-a', 'wt-1');

    expect(file?.version).toBe(2);
    expect(file?.summary).toEqual(summary);
    expect(file?.history).toHaveLength(1);
    expect(file?.history[0].summary).toEqual(summary);
  });

  it('returns the full v2 file with history', async () => {
    const summary = makeSummary();
    const existing: WorktreeSummaryFile = {
      version: 2,
      summary,
      history: [{ snapshotId: 'snap-1', summary }],
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(existing));

    const file = await readWorktreeSummaryFile('project-a', 'wt-1');

    expect(file).toEqual(existing);
  });

  it('keeps valid provenance and drops provenance that does not validate', async () => {
    const summary = makeSummary();
    const provenance: WorktreeSummaryProvenance = {
      generationId: 'generation-1',
      harness: 'codex',
      model: null,
      thinkingEffort: null,
      observedTaskKey: null,
      capturedAt: '2026-09-30T12:00:00.000Z',
      ledgerPublishable: true,
    };
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 2,
        summary,
        history: [
          { snapshotId: 'snap-1', summary, provenance },
          {
            snapshotId: 'snap-2',
            summary,
            provenance: { ...provenance, generationId: '' },
          },
        ],
      }),
    );

    const file = await readWorktreeSummaryFile('project-a', 'wt-1');

    expect(file?.history).toEqual([
      { snapshotId: 'snap-1', summary, provenance },
      // A snapshot without valid provenance is never published.
      { snapshotId: 'snap-2', summary },
    ]);
  });

  it('returns null when the file is missing', async () => {
    mockedReadFile.mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );

    const file = await readWorktreeSummaryFile('project-a', 'wt-1');

    expect(file).toBeNull();
  });
});

describe('readWorktreeSummary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveWorktreeSummaryFilePath.mockReturnValue(
      '/tmp/project-a/summaries/wt-1.json',
    );
  });

  it('returns summary data from a valid file', async () => {
    const summary = makeSummary();
    const fileContent = JSON.stringify({ version: 1, summary });
    mockedReadFile.mockResolvedValue(fileContent);

    const result = await readWorktreeSummary('project-a', 'wt-1');

    expect(result).toEqual(summary);
    expect(mockedReadFile).toHaveBeenCalledWith(
      '/tmp/project-a/summaries/wt-1.json',
      'utf8',
    );
  });

  it('returns null when file does not exist', async () => {
    mockedReadFile.mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );

    const result = await readWorktreeSummary('project-a', 'wt-1');

    expect(result).toBeNull();
  });

  it('returns null when file contains invalid JSON', async () => {
    mockedReadFile.mockResolvedValue('not json{{{');

    const result = await readWorktreeSummary('project-a', 'wt-1');

    expect(result).toBeNull();
  });

  it('returns null when file has wrong version', async () => {
    const summary = makeSummary();
    const fileContent = JSON.stringify({ version: 99, summary });
    mockedReadFile.mockResolvedValue(fileContent);

    const result = await readWorktreeSummary('project-a', 'wt-1');

    expect(result).toBeNull();
  });

  it('returns null when summary data is malformed', async () => {
    const fileContent = JSON.stringify({
      version: 1,
      summary: { title: 'ok' },
    });
    mockedReadFile.mockResolvedValue(fileContent);

    const result = await readWorktreeSummary('project-a', 'wt-1');

    expect(result).toBeNull();
  });

  it('returns summary with repos when present', async () => {
    const summary: WorktreeSummaryData = {
      ...makeSummary(),
      repos: [{ name: 'backend', description: 'API changes' }],
    };
    const fileContent = JSON.stringify({ version: 1, summary });
    mockedReadFile.mockResolvedValue(fileContent);

    const result = await readWorktreeSummary('project-a', 'wt-1');

    expect(result).toEqual(summary);
    expect(result?.repos).toHaveLength(1);
  });
});

describe('isWorktreeSummaryData', () => {
  it('returns true for valid summary data', () => {
    expect(isWorktreeSummaryData(makeSummary())).toBe(true);
  });

  it('returns true for summary data with repos', () => {
    const summary = {
      ...makeSummary(),
      repos: [{ name: 'repo-a', description: 'Changes in repo-a' }],
    };
    expect(isWorktreeSummaryData(summary)).toBe(true);
  });

  it('returns false for null', () => {
    expect(isWorktreeSummaryData(null)).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(isWorktreeSummaryData('string')).toBe(false);
  });

  it('returns false when title is missing', () => {
    const summary = makeSummary();
    const partial = { ...summary, title: '' };
    expect(isWorktreeSummaryData(partial)).toBe(false);
  });

  it('returns false when highlights contains non-string', () => {
    const summary = makeSummary();
    const broken = { ...summary, highlights: ['ok', 42] };
    expect(isWorktreeSummaryData(broken)).toBe(false);
  });

  it('returns false when turnCountAtGeneration is not finite', () => {
    const summary = makeSummary();
    const broken = { ...summary, turnCountAtGeneration: NaN };
    expect(isWorktreeSummaryData(broken)).toBe(false);
  });

  it('returns false when repos contain invalid entries', () => {
    const summary = {
      ...makeSummary(),
      repos: [{ name: '', description: 'missing name' }],
    };
    expect(isWorktreeSummaryData(summary)).toBe(false);
  });
});
