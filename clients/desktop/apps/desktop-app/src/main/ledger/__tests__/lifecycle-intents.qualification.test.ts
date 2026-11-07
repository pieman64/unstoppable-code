import type { LedgerContainer } from '@canopy/protocol/canopy-core';

jest.mock('../../lib/workspace-persistence', () => ({
  getWorkspaceWorktreeCreatedAt: jest.fn(),
}));

import type { LedgerContainerIncarnation } from '../lifecycle';
import {
  LedgerLifecycleIntentJournal,
  type LedgerLifecycleIntent,
  type LedgerLifecycleIntentFile,
  type LedgerLifecycleIntentRead,
} from '../lifecycle-intents';

const T0 = '2026-09-20T10:00:00.000Z';
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

describe('Ledger lifecycle journal qualification (CAN-4489)', () => {
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
});
