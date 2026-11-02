import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createEntryFingerprint,
  ENTRY_ATTEMPT_JOURNAL_FILE,
  readEntryAttempt,
  writeEntryAttempt,
  type EntryAttemptRecord,
} from '../pipelines/host-create-entry-state';

const KEY = 'pipeline-host:exec-1:job::create:0:0';

function record(
  overrides: Partial<EntryAttemptRecord> = {},
): EntryAttemptRecord {
  return {
    version: 1,
    idempotencyKey: KEY,
    fingerprint: 'fp',
    phase: 'creating',
    taskId: 'task-1',
    ...overrides,
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'canopy-entry-state-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it('round-trips a record', async () => {
  const written = record({
    phase: 'finalized',
    chatId: 'task-1',
    group: { group_id: 'grp-1', grouped: 'true' },
    result: { status: 'success', outputs: { task_id: 'task-1' } },
  });
  await writeEntryAttempt(dir, written);
  await expect(readEntryAttempt(dir, KEY)).resolves.toEqual({
    kind: 'present',
    record: written,
  });
});

it('reads a missing journal as absent', async () => {
  await expect(readEntryAttempt(dir, KEY)).resolves.toEqual({ kind: 'absent' });
});

it("reads another attempt's record as absent", async () => {
  await writeEntryAttempt(dir, record({ idempotencyKey: 'other-attempt' }));
  await expect(readEntryAttempt(dir, KEY)).resolves.toEqual({ kind: 'absent' });
});

it.each([
  ['bad JSON', '{not json'],
  ['an unknown version', JSON.stringify({ ...record(), version: 2 })],
])('reads %s as corrupt', async (_label, text) => {
  await writeFile(path.join(dir, ENTRY_ATTEMPT_JOURNAL_FILE), text, 'utf8');
  await expect(readEntryAttempt(dir, KEY)).resolves.toEqual({
    kind: 'corrupt',
  });
});

it('serializes writes to one file in order', async () => {
  await Promise.all([
    writeEntryAttempt(dir, record({ phase: 'creating' })),
    writeEntryAttempt(dir, record({ phase: 'created', chatId: 'task-1' })),
    writeEntryAttempt(
      dir,
      record({
        phase: 'finalized',
        chatId: 'task-1',
        result: { status: 'success', outputs: {} },
      }),
    ),
  ]);
  const stored: unknown = JSON.parse(
    await readFile(path.join(dir, ENTRY_ATTEMPT_JOURNAL_FILE), 'utf8'),
  );
  expect(stored).toMatchObject({ phase: 'finalized' });
});

describe('createEntryFingerprint', () => {
  const action = 'create-project-entry';

  it('ignores key order', () => {
    expect(
      createEntryFingerprint({
        action,
        inputs: { projectId: 'p', title: 'T', group: 'G' },
      }),
    ).toBe(
      createEntryFingerprint({
        action,
        inputs: { group: 'G', title: 'T', projectId: 'p' },
      }),
    );
  });

  it('differs when the title or group differs, and never contains them', () => {
    const base = createEntryFingerprint({
      action,
      inputs: { projectId: 'p', title: 'Nightly', group: 'Reports' },
    });
    expect(
      createEntryFingerprint({
        action,
        inputs: { projectId: 'p', title: 'Weekly', group: 'Reports' },
      }),
    ).not.toBe(base);
    expect(
      createEntryFingerprint({
        action,
        inputs: { projectId: 'p', title: 'Nightly', group: 'Ops' },
      }),
    ).not.toBe(base);
    expect(base).not.toContain('Nightly');
  });
});
