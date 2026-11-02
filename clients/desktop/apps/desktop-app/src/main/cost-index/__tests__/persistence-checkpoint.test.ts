import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as atomicFile from '../../lib/atomic-file';
import {
  carryCheckpointFields,
  migrateCheckpoint,
  migrateCheckpointWith,
  readChatFile,
  readCheckpointFile,
  readSummaryFile,
  writeChatFile,
  writeCheckpointFile,
  type CheckpointMigrations,
} from '../persistence';
import type { CostIndexCheckpoint } from '../types';

jest.mock('../../lib/atomic-file', () => {
  const actual: typeof atomicFile = jest.requireActual('../../lib/atomic-file');
  return {
    ...actual,
    writeFileAtomically: jest.fn(actual.writeFileAtomically),
  };
});

const writeFileAtomicallyMock = jest.mocked(atomicFile.writeFileAtomically);

const versionOne: CostIndexCheckpoint = {
  version: 1,
  generation: 3,
  firstBuild: { at: '2026-09-01T08:00:00.000Z', coverageStart: '2026-09-01' },
  retainedFillComplete: true,
  audit: {
    '2026-10-07.jsonl': { offset: 812, size: 812, mtimeMs: 1_000.5, ino: 41 },
    '2026-10-08.jsonl': { offset: 300, size: 344, mtimeMs: 2_000, ino: 42 },
  },
  lastRefresh: {
    trigger: 'idle',
    startedAt: '2026-10-09T12:00:00.000Z',
    completedAt: '2026-10-09T12:00:01.000Z',
    linesRead: 7,
    durationMs: 1_000,
  },
};

interface VersionTwoCheckpoint {
  readonly version: 2;
  readonly generation: number;
  readonly firstBuild: CostIndexCheckpoint['firstBuild'];
  readonly retainedFillComplete?: boolean;
  readonly audit: CostIndexCheckpoint['audit'];
  readonly lastRefresh?: CostIndexCheckpoint['lastRefresh'];
  readonly shards: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isVersionTwo(value: unknown): value is VersionTwoCheckpoint {
  return (
    isRecord(value) &&
    value.version === 2 &&
    typeof value.generation === 'number' &&
    isRecord(value.firstBuild) &&
    isRecord(value.audit) &&
    Array.isArray(value.shards)
  );
}

/** A test-only table: a fake version 2 adds `shards` in one step. */
const toVersionTwo: CheckpointMigrations<VersionTwoCheckpoint> = {
  currentVersion: 2,
  steps: {
    1: (value) => ({ ...carryCheckpointFields(value, 2), shards: [] }),
  },
  isCurrent: isVersionTwo,
};

describe('cost checkpoint migration', () => {
  it('reads the current version as current', () => {
    expect(migrateCheckpoint(structuredClone(versionOne))).toEqual({
      kind: 'current',
      value: versionOne,
    });
  });

  it('carries cursors, first build, fill state, generation and last refresh verbatim through an upgrade step', () => {
    const raw = structuredClone(versionOne);
    const result = migrateCheckpointWith(raw, toVersionTwo);

    expect(result.kind).toBe('migrated');
    if (result.kind !== 'migrated') return;
    expect(result.from).toBe(1);
    expect(result.value).toEqual({
      version: 2,
      generation: versionOne.generation,
      firstBuild: versionOne.firstBuild,
      retainedFillComplete: true,
      audit: versionOne.audit,
      lastRefresh: versionOne.lastRefresh,
      shards: [],
    });
    expect(result.value.audit).toEqual(raw.audit);
  });

  it('reads a version without an upgrade step, or an upgrade that fails the guard, as corrupt', () => {
    const missingStep: CheckpointMigrations<VersionTwoCheckpoint> = {
      ...toVersionTwo,
      currentVersion: 3,
      isCurrent: (value): value is VersionTwoCheckpoint =>
        isRecord(value) && value.version === 3,
    };
    expect(migrateCheckpointWith(versionOne, missingStep)).toEqual({
      kind: 'corrupt',
    });
    const brokenStep: CheckpointMigrations<VersionTwoCheckpoint> = {
      ...toVersionTwo,
      steps: { 1: (value) => ({ ...value, version: 2 }) },
    };
    expect(migrateCheckpointWith(versionOne, brokenStep)).toEqual({
      kind: 'corrupt',
    });
  });

  it('reads a later version as newer and keeps only what still parses', () => {
    expect(
      migrateCheckpoint({
        version: 4,
        generation: 12,
        firstBuild: versionOne.firstBuild,
        retainedFillComplete: false,
        audit: { 'x.jsonl': { position: 1 } },
      }),
    ).toEqual({
      kind: 'newer',
      version: 4,
      preserved: {
        firstBuild: versionOne.firstBuild,
        retainedFillComplete: false,
      },
    });
    expect(
      migrateCheckpoint({
        version: 2,
        firstBuild: { at: 7 },
        retainedFillComplete: 'yes',
      }),
    ).toEqual({ kind: 'newer', version: 2, preserved: {} });
  });

  it('reads a missing, fractional or non-numeric version as corrupt', () => {
    for (const version of [undefined, 0, -1, 1.5, '1', null]) {
      expect(migrateCheckpoint({ ...versionOne, version })).toEqual({
        kind: 'corrupt',
      });
    }
    expect(migrateCheckpoint([versionOne])).toEqual({ kind: 'corrupt' });
    expect(migrateCheckpoint({ ...versionOne, audit: [] })).toEqual({
      kind: 'corrupt',
    });
  });
});

describe('cost checkpoint file', () => {
  let root: string;
  let checkpointPath: string;

  beforeEach(async () => {
    writeFileAtomicallyMock.mockClear();
    root = await mkdtemp(join(tmpdir(), 'cost-checkpoint-'));
    checkpointPath = join(root, 'index', 'checkpoint.json');
    await mkdir(join(root, 'index'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads a version 1 checkpoint as current without rewriting it', async () => {
    const original = `${JSON.stringify(versionOne)}\n`;
    await writeFile(checkpointPath, original, 'utf8');
    const before = await stat(checkpointPath);

    const read = await readCheckpointFile(checkpointPath);

    expect(read).toEqual({ value: versionOne, corrupt: false });
    expect(await readFile(checkpointPath, 'utf8')).toBe(original);
    expect((await stat(checkpointPath)).mtimeMs).toBe(before.mtimeMs);
    expect(await readdir(join(root, 'index'))).toEqual(['checkpoint.json']);
  });

  it('keeps one copy of a later version across reads and never marks it corrupt', async () => {
    const original = `${JSON.stringify({
      version: 2,
      generation: 9,
      firstBuild: versionOne.firstBuild,
      retainedFillComplete: true,
      audit: { '2026-10-08.jsonl': { position: 4096 } },
    })}\n`;
    await writeFile(checkpointPath, original, 'utf8');

    const first = await readCheckpointFile(checkpointPath);
    const second = await readCheckpointFile(checkpointPath);

    for (const read of [first, second]) {
      expect(read).toEqual({
        value: null,
        corrupt: false,
        newer: {
          version: 2,
          preserved: {
            firstBuild: versionOne.firstBuild,
            retainedFillComplete: true,
          },
        },
      });
    }
    const names = await readdir(join(root, 'index'));
    expect(names.filter((name) => name.includes('.corrupt-'))).toEqual([]);
    const preserved = names.filter((name) =>
      /^checkpoint\.json\.v2-\d+$/.test(name),
    );
    expect(preserved).toHaveLength(1);
    expect(
      await readFile(join(root, 'index', preserved[0] ?? ''), 'utf8'),
    ).toBe(original);
    expect(await readFile(checkpointPath, 'utf8')).toBe(original);
  });

  it('writes the checkpoint durably, creating its directory', async () => {
    const nested = join(root, 'missing', 'checkpoint.json');

    await writeCheckpointFile(nested, versionOne);

    expect(writeFileAtomicallyMock).toHaveBeenCalledWith(
      nested,
      `${JSON.stringify(versionOne)}\n`,
      expect.objectContaining({ durable: true }),
    );
    expect((await readCheckpointFile(nested)).value).toEqual(versionOne);
  });

  it('leaves per-scope files on their own atomic write', async () => {
    const directory = join(root, 'scope');

    await writeChatFile(directory, {
      version: 1,
      chatId: 'chat-1',
      records: {},
    });

    expect(writeFileAtomicallyMock).not.toHaveBeenCalled();
    expect((await readChatFile(directory, 'chat-1')).value?.chatId).toBe(
      'chat-1',
    );
  });
});

describe('corrupt cost files', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cost-corrupt-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('copies a corrupt file aside once, however often it is read', async () => {
    await writeFile(join(root, 'summary.json'), '{"version":1,', 'utf8');

    for (let read = 0; read < 3; read += 1) {
      expect(await readSummaryFile(root)).toEqual({
        value: null,
        corrupt: true,
      });
    }

    const copies = (await readdir(root)).filter((name) =>
      name.startsWith('summary.json.corrupt-'),
    );
    expect(copies).toHaveLength(1);
    expect(await readFile(join(root, copies[0] ?? ''), 'utf8')).toBe(
      '{"version":1,',
    );
  });

  it('copies a file aside again when it is corrupt in a different way', async () => {
    await writeFile(join(root, 'summary.json'), '{"version":1,', 'utf8');
    await readSummaryFile(root);
    await writeFile(join(root, 'summary.json'), '[]', 'utf8');
    await readSummaryFile(root);

    expect(
      (await readdir(root)).filter((name) =>
        name.startsWith('summary.json.corrupt-'),
      ),
    ).toHaveLength(2);
  });
});
