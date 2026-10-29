import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LedgerContainer } from '@canopy/protocol/canopy-core';

const mockFsyncDirectory = jest.fn<Promise<void>, [string]>();
jest.mock('../../lib/fsync-directory', () => ({
  fsyncDirectory: (directory: string): Promise<void> =>
    mockFsyncDirectory(directory),
}));

import type { LedgerContainerIncarnation } from '../lifecycle';
import {
  createLedgerLifecycleIntentFile,
  DEFAULT_MAX_INTENTS,
  LedgerLifecycleIntentJournal,
  ledgerIntentGapCovers,
  type LedgerLifecycleIntent,
  type LedgerLifecycleIntentFile,
  type LedgerLifecycleIntentRead,
} from '../lifecycle-intents';

const T0 = '2026-09-20T10:00:00.000Z';
const T1 = '2026-09-26T08:30:00.000Z';
const RECORDED_AT = '2026-09-28T09:00:00.000Z';
const DETECTED_AT = '2026-09-29T19:50:00.000Z';

function worktree(worktreeId: string, workspaceId = 'ws-1'): LedgerContainer {
  return { kind: 'code_worktree', workspaceId, worktreeId };
}

function incarnation(
  container: LedgerContainer,
  containerCreatedAt: string,
): LedgerContainerIncarnation {
  return { container, containerCreatedAt };
}

function move(from: string, to: string): LedgerLifecycleIntent {
  return {
    kind: 'move',
    from: incarnation(worktree(from), T0),
    to: incarnation(worktree(to, 'ws-2'), T0),
    recordedAt: RECORDED_AT,
  };
}

/** The journal's file in memory; a write can be made to fail once. */
class MemoryFile implements LedgerLifecycleIntentFile {
  content: string | null = null;
  readonly damaged: Array<{ content: string; detectedAt: string }> = [];
  writes = 0;
  private failure: { error: Error; landed: boolean } | undefined;
  private preserveFailure: Error | undefined;

  /**
   * Fails the next write; with `landed`, only after the new content is in
   * place, as when a rename is done but its directory cannot be synced.
   */
  failNextWrite(error: Error, options: { landed?: boolean } = {}): void {
    this.failure = { error, landed: options.landed === true };
  }

  failNextPreserve(error: Error): void {
    this.preserveFailure = error;
  }

  read(): Promise<string | null> {
    return Promise.resolve(this.content);
  }

  replace(content: string): Promise<void> {
    const failure = this.failure;
    this.failure = undefined;
    if (failure !== undefined) {
      if (failure.landed) this.content = content;
      return Promise.reject(failure.error);
    }
    this.writes += 1;
    this.content = content;
    return Promise.resolve();
  }

  preserveDamaged(content: string, detectedAt: string): Promise<void> {
    const failure = this.preserveFailure;
    this.preserveFailure = undefined;
    if (failure !== undefined) return Promise.reject(failure);
    this.damaged.push({ content, detectedAt });
    return Promise.resolve();
  }
}

async function intentsOf(
  journal: LedgerLifecycleIntentJournal,
): Promise<readonly LedgerLifecycleIntent[]> {
  const read = await journal.read();
  if (read.status !== 'ok') throw new Error('Expected a readable journal');
  return read.intents;
}

async function gapOf(
  journal: LedgerLifecycleIntentJournal,
): Promise<Extract<LedgerLifecycleIntentRead, { status: 'ok' }>['gap']> {
  const read = await journal.read();
  if (read.status !== 'ok') throw new Error('Expected a readable journal');
  return read.gap;
}

beforeEach(() => {
  mockFsyncDirectory.mockReset();
  mockFsyncDirectory.mockResolvedValue(undefined);
});

describe('LedgerLifecycleIntentJournal', () => {
  it('writes version 1 and reads back what it recorded', async () => {
    const file = new MemoryFile();
    const journal = new LedgerLifecycleIntentJournal({ file });

    await journal.add(move('wt-1', 'wt-1-2'));

    expect(JSON.parse(file.content ?? '')).toEqual({
      version: 1,
      intents: [move('wt-1', 'wt-1-2')],
    });
    // A new journal, as after a restart, reads the same intents.
    await expect(
      intentsOf(new LedgerLifecycleIntentJournal({ file })),
    ).resolves.toEqual([move('wt-1', 'wt-1-2')]);
  });

  it('replaces a matching intent, matching creation times as instants', async () => {
    const file = new MemoryFile();
    const journal = new LedgerLifecycleIntentJournal({ file });
    await journal.add(move('wt-1', 'wt-1-2'));

    await journal.add({
      ...move('wt-1', 'wt-1-2'),
      from: incarnation(worktree('wt-1'), '2026-09-20T12:00:00+02:00'),
      recordedAt: '2026-09-28T10:00:00.000Z',
    });

    const intents = await intentsOf(journal);
    expect(intents).toHaveLength(1);
    expect(intents[0]?.recordedAt).toBe('2026-09-28T10:00:00.000Z');
  });

  it('refuses an intent past the bound, never dropping a pending one', async () => {
    const file = new MemoryFile();
    const journal = new LedgerLifecycleIntentJournal({ file });
    const restore: LedgerLifecycleIntent = {
      kind: 'rebind',
      from: incarnation(worktree('wt-archived'), T0),
      to: incarnation(worktree('wt-restored'), T1),
      recordedAt: RECORDED_AT,
    };
    // A full journal, the oldest intent a restore's.
    file.content = JSON.stringify({
      version: 1,
      intents: [
        restore,
        ...Array.from({ length: DEFAULT_MAX_INTENTS - 1 }, (_, index) =>
          move(`wt-${index}`, `wt-${index}-2`),
        ),
      ],
    });
    const full = file.content;

    await expect(journal.add(move('wt-new', 'wt-new-2'))).resolves.toBe('full');

    expect(DEFAULT_MAX_INTENTS).toBe(1024);
    expect(file.writes).toBe(0);
    expect(file.content).toBe(full);
    const intents = await intentsOf(journal);
    expect(intents).toHaveLength(DEFAULT_MAX_INTENTS);
    expect(intents[0]).toEqual(restore);
    // Recording one it already holds still replaces it, full or not.
    await expect(
      journal.add({ ...restore, recordedAt: '2026-09-28T10:00:00.000Z' }),
    ).resolves.toBe('recorded');
    expect(await intentsOf(journal)).toHaveLength(DEFAULT_MAX_INTENTS);
    // Once an intent is applied and removed, there is room again.
    await journal.remove(move('wt-0', 'wt-0-2'));
    await expect(journal.add(move('wt-new', 'wt-new-2'))).resolves.toBe(
      'recorded',
    );
  });

  it('reads every intent a journal over the bound holds, and refuses more', async () => {
    const file = new MemoryFile();
    const writer = new LedgerLifecycleIntentJournal({ file, maxIntents: 5 });
    for (const id of ['wt-1', 'wt-2', 'wt-3', 'wt-4', 'wt-5']) {
      await writer.add(move(id, `${id}-2`));
    }

    const smaller = new LedgerLifecycleIntentJournal({ file, maxIntents: 2 });

    expect(await intentsOf(smaller)).toHaveLength(5);
    await expect(smaller.add(move('wt-6', 'wt-6-2'))).resolves.toBe('full');
    await expect(smaller.add(move('wt-1', 'wt-1-2'))).resolves.toBe('recorded');
    expect(await intentsOf(smaller)).toHaveLength(5);
  });

  it('removes a matching intent, and writes nothing when none matches', async () => {
    const file = new MemoryFile();
    const journal = new LedgerLifecycleIntentJournal({ file });
    await journal.add(move('wt-1', 'wt-1-2'));
    await journal.add(move('wt-2', 'wt-2-2'));

    await expect(journal.remove(move('wt-1', 'wt-1-2'))).resolves.toBe(true);
    await expect(journal.remove(move('wt-9', 'wt-9-2'))).resolves.toBe(false);

    expect(file.writes).toBe(3);
    expect(await intentsOf(journal)).toEqual([move('wt-2', 'wt-2-2')]);
  });

  it('removes a whole chain in a single write', async () => {
    const file = new MemoryFile();
    const journal = new LedgerLifecycleIntentJournal({ file });
    await journal.add(move('wt-1', 'wt-1-2'));
    await journal.add(move('wt-2', 'wt-2-2'));
    await journal.add(move('wt-3', 'wt-3-2'));

    await expect(
      journal.removeAll([
        move('wt-1', 'wt-1-2'),
        move('wt-3', 'wt-3-2'),
        move('wt-9', 'wt-9-2'),
      ]),
    ).resolves.toBe(2);
    await expect(journal.removeAll([move('wt-9', 'wt-9-2')])).resolves.toBe(0);

    expect(file.writes).toBe(4);
    expect(await intentsOf(journal)).toEqual([move('wt-2', 'wt-2-2')]);
  });

  it('leaves the journal as it was when a write fails', async () => {
    const file = new MemoryFile();
    const journal = new LedgerLifecycleIntentJournal({ file });
    await journal.add(move('wt-1', 'wt-1-2'));
    file.failNextWrite(new Error('disk full'));

    await expect(journal.add(move('wt-2', 'wt-2-2'))).rejects.toThrow(
      'disk full',
    );

    expect(await intentsOf(journal)).toEqual([move('wt-1', 'wt-1-2')]);
    await journal.add(move('wt-2', 'wt-2-2'));
    expect(await intentsOf(journal)).toHaveLength(2);
  });

  it('runs concurrent writes one after another', async () => {
    const file = new MemoryFile();
    const journal = new LedgerLifecycleIntentJournal({ file });

    await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        journal.add(move(`wt-${index}`, `wt-${index}-2`)),
      ),
    );

    expect(await intentsOf(journal)).toHaveLength(10);
    expect(file.writes).toBe(10);
  });

  it('never overwrites a journal a newer version wrote', async () => {
    const file = new MemoryFile();
    const newer = JSON.stringify({ version: 2, intents: [] });
    file.content = newer;
    const journal = new LedgerLifecycleIntentJournal({ file });

    await expect(journal.read()).resolves.toEqual({ status: 'unreadable' });
    await expect(journal.add(move('wt-1', 'wt-1-2'))).rejects.toMatchObject({
      reason: 'INTENT_JOURNAL_NEWER',
    });
    await expect(journal.remove(move('wt-1', 'wt-1-2'))).resolves.toBe(false);

    expect(file.content).toBe(newer);
    expect(file.writes).toBe(0);
  });

  it('keeps a damaged journal, then starts a fresh one that reports the gap', async () => {
    const file = new MemoryFile();
    file.content = '{ damaged';
    const onQuarantine = jest.fn();
    const journal = new LedgerLifecycleIntentJournal({
      file,
      onQuarantine,
      now: (): Date => new Date(DETECTED_AT),
    });

    await expect(intentsOf(journal)).resolves.toEqual([]);
    // Any intent recorded until now may be lost.
    await expect(gapOf(journal)).resolves.toEqual({
      kind: 'created_by',
      since: DETECTED_AT,
    });
    expect(file.damaged).toEqual([
      { content: '{ damaged', detectedAt: DETECTED_AT },
    ]);
    expect(onQuarantine).toHaveBeenCalledTimes(1);

    // New intents are recorded as usual, and the gap survives every write
    // and a restart.
    await journal.add(move('wt-1', 'wt-1-2'));
    expect(JSON.parse(file.content ?? '')).toEqual({
      version: 1,
      intents: [move('wt-1', 'wt-1-2')],
      damagedAt: DETECTED_AT,
    });
    const reread = new LedgerLifecycleIntentJournal({ file });
    expect(await intentsOf(reread)).toEqual([move('wt-1', 'wt-1-2')]);
    await expect(gapOf(reread)).resolves.toEqual({
      kind: 'created_by',
      since: DETECTED_AT,
    });
  });

  it('leaves a damaged journal in place while its content cannot be kept', async () => {
    const file = new MemoryFile();
    file.content = '{ damaged';
    file.failNextPreserve(new Error('disk full'));
    const journal = new LedgerLifecycleIntentJournal({ file });

    // Nothing can be told, and nothing is recorded, until it is kept.
    await expect(journal.read()).resolves.toEqual({ status: 'unreadable' });
    await expect(journal.add(move('wt-1', 'wt-1-2'))).resolves.toBe('recorded');

    expect(file.damaged).toHaveLength(1);
    expect(file.writes).toBe(2);
  });

  it('reads the file again after a write that may have landed', async () => {
    const file = new MemoryFile();
    const journal = new LedgerLifecycleIntentJournal({ file });
    await journal.add(move('wt-1', 'wt-1-2'));
    file.failNextWrite(new Error('directory sync failed'), { landed: true });

    await expect(journal.add(move('wt-2', 'wt-2-2'))).rejects.toThrow(
      'directory sync failed',
    );

    // The journal holds what the file holds, not what it last wrote.
    expect(await intentsOf(journal)).toEqual([
      move('wt-1', 'wt-1-2'),
      move('wt-2', 'wt-2-2'),
    ]);
  });

  it('reads past entries this version cannot use', async () => {
    const file = new MemoryFile();
    file.content = JSON.stringify({
      version: 1,
      intents: [
        move('wt-1', 'wt-1-2'),
        { ...move('wt-2', 'wt-2-2'), kind: 'teleport' },
        {
          ...move('wt-3', 'wt-3-2'),
          from: incarnation(worktree('../escape'), T0),
        },
        {
          ...move('wt-4', 'wt-4-2'),
          to: incarnation(worktree('wt-4-2'), 'not an instant'),
        },
        {
          kind: 'rebind',
          from: incarnation(
            {
              kind: 'advisor_entry',
              appWorkspaceId: 'app-advisor',
              entryId: 'e-1',
            },
            T0,
          ),
          to: incarnation(
            {
              kind: 'advisor_entry',
              appWorkspaceId: 'app-advisor',
              entryId: 'e-2',
            },
            T1,
          ),
          recordedAt: RECORDED_AT,
        },
      ],
    });
    const journal = new LedgerLifecycleIntentJournal({ file });

    expect(
      (await intentsOf(journal)).map((intent) => intent.from.container),
    ).toEqual([
      worktree('wt-1'),
      { kind: 'advisor_entry', appWorkspaceId: 'app-advisor', entryId: 'e-1' },
    ]);
    // What it cannot read may name any scope.
    await expect(gapOf(journal)).resolves.toEqual({ kind: 'any' });
  });

  it('keeps entries it cannot read across writes, counting them toward the bound', async () => {
    const file = new MemoryFile();
    const unreadable = { ...move('wt-9', 'wt-9-2'), kind: 'teleport' };
    file.content = JSON.stringify({
      version: 1,
      intents: [move('wt-1', 'wt-1-2'), unreadable],
    });
    const journal = new LedgerLifecycleIntentJournal({ file, maxIntents: 3 });

    await expect(journal.add(move('wt-2', 'wt-2-2'))).resolves.toBe('recorded');
    await expect(journal.add(move('wt-3', 'wt-3-2'))).resolves.toBe('full');
    await journal.removeAll([move('wt-1', 'wt-1-2'), move('wt-2', 'wt-2-2')]);

    expect(JSON.parse(file.content ?? '')).toEqual({
      version: 1,
      intents: [unreadable],
    });
    await expect(gapOf(journal)).resolves.toEqual({ kind: 'any' });
  });

  it('treats a journal whose damage stamp cannot be read as damaged', async () => {
    const file = new MemoryFile();
    file.content = JSON.stringify({
      version: 1,
      intents: [move('wt-1', 'wt-1-2')],
      damagedAt: 'yesterday',
    });
    const journal = new LedgerLifecycleIntentJournal({
      file,
      now: (): Date => new Date(DETECTED_AT),
    });

    await expect(gapOf(journal)).resolves.toEqual({
      kind: 'created_by',
      since: DETECTED_AT,
    });
    expect(file.damaged).toHaveLength(1);
  });
});

describe('ledgerIntentGapCovers', () => {
  it('covers scopes by the gap a journal reports', () => {
    const gap = { kind: 'created_by', since: DETECTED_AT } as const;

    expect(ledgerIntentGapCovers({ kind: 'none' }, T0)).toBe(false);
    expect(ledgerIntentGapCovers({ kind: 'any' }, T0)).toBe(true);
    expect(ledgerIntentGapCovers(gap, '2026-09-29T19:49:59.999Z')).toBe(true);
    expect(ledgerIntentGapCovers(gap, DETECTED_AT)).toBe(true);
    expect(ledgerIntentGapCovers(gap, '2026-09-29T21:50:00+02:00')).toBe(true);
    expect(ledgerIntentGapCovers(gap, '2026-09-29T19:50:00.001Z')).toBe(false);
    expect(ledgerIntentGapCovers(gap, 'not a time')).toBe(true);
  });
});

describe('createLedgerLifecycleIntentFile', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ledger-intents-'));
  });

  afterEach(() => {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  });

  it('replaces the journal atomically, leaving no temporary file', async () => {
    const path = join(directory, 'lifecycle-intents.json');
    const file = createLedgerLifecycleIntentFile(path);

    await expect(file.read()).resolves.toBeNull();
    await file.replace('{"version":1,"intents":[]}\n');
    await file.replace('{"version":1,"intents":[1]}\n');

    await expect(file.read()).resolves.toBe('{"version":1,"intents":[1]}\n');
    expect(readdirSync(directory)).toEqual(['lifecycle-intents.json']);
  });

  it('keeps the previous journal whole when a replacement cannot be written', async () => {
    const path = join(directory, 'lifecycle-intents.json');
    const file = createLedgerLifecycleIntentFile(path);
    await file.replace('previous');
    chmodSync(directory, 0o500);

    await expect(file.replace('next')).rejects.toMatchObject({
      code: 'EACCES',
    });

    chmodSync(directory, 0o700);
    expect(readFileSync(path, 'utf8')).toBe('previous');
    expect(readdirSync(directory)).toEqual(['lifecycle-intents.json']);
  });

  it('creates its directory before writing, like every persisted file', async () => {
    const path = join(directory, 'ledger', 'lifecycle-intents.json');
    const file = createLedgerLifecycleIntentFile(path);

    await file.replace('{}');

    expect(readFileSync(path, 'utf8')).toBe('{}');
  });

  it('marks an intent conflicted, adding it when the journal lacks it, and keeps it across writes', async () => {
    const file = new MemoryFile();
    const journal = new LedgerLifecycleIntentJournal({ file, maxIntents: 2 });
    const restore: LedgerLifecycleIntent = {
      kind: 'rebind',
      from: incarnation(worktree('wt-archived'), T0),
      to: incarnation(worktree('wt-restored'), T1),
      recordedAt: RECORDED_AT,
    };
    await journal.add(restore);

    await expect(journal.markConflicted(restore, RECORDED_AT)).resolves.toBe(
      'recorded',
    );
    await expect(
      journal.markConflicted(move('wt-1', 'wt-1-2'), RECORDED_AT),
    ).resolves.toBe('recorded');
    // Full: a new conflicted entry is refused, an existing one stays marked.
    await expect(
      journal.markConflicted(move('wt-2', 'wt-2-2'), RECORDED_AT),
    ).resolves.toBe('full');
    await expect(journal.markConflicted(restore, RECORDED_AT)).resolves.toBe(
      'recorded',
    );

    const reread = new LedgerLifecycleIntentJournal({ file });
    expect(await intentsOf(reread)).toEqual([
      { ...restore, conflicted: true },
      { ...move('wt-1', 'wt-1-2'), recordedAt: RECORDED_AT, conflicted: true },
    ]);
  });

  it('keeps a damaged journal beside it, leaving the journal in place', async () => {
    mkdirSync(join(directory, 'ledger'));
    const path = join(directory, 'ledger', 'lifecycle-intents.json');
    writeFileSync(path, '{ damaged');
    const file = createLedgerLifecycleIntentFile(path);

    await file.preserveDamaged('{ damaged', DETECTED_AT);

    expect(readFileSync(path, 'utf8')).toBe('{ damaged');
    expect(
      readFileSync(`${path}.corrupt-2026-09-29T19-50-00-000Z`, 'utf8'),
    ).toBe('{ damaged');
  });

  it('fails a replacement whose directory cannot be synced', async () => {
    const path = join(directory, 'lifecycle-intents.json');
    const file = createLedgerLifecycleIntentFile(path);
    await file.replace('previous');
    mockFsyncDirectory.mockRejectedValueOnce(
      Object.assign(new Error('I/O error'), { code: 'EIO' }),
    );

    // The rename may not survive a crash, so the write is not durable.
    await expect(file.replace('next')).rejects.toMatchObject({ code: 'EIO' });
    expect(mockFsyncDirectory).toHaveBeenLastCalledWith(directory);
  });
});
