import {
  createLedgerGuestRebindJournal,
  createLedgerGuestRebinder,
  type LedgerGuestRebind,
  type LedgerGuestRebinderOptions,
} from '../guest-rebind-intents';
import type { LedgerLifecycleIntentFile } from '../lifecycle-intents';

const GUEST = '00000000-0000-4000-8000-0000000000c1';
const ACCOUNT = '00000000-0000-4000-8000-0000000000c2';
const REBIND: LedgerGuestRebind = {
  fromAccountId: GUEST,
  toAccountId: ACCOUNT,
};

class MemoryFile implements LedgerLifecycleIntentFile {
  content: string | null = null;
  failWrites = false;

  read(): Promise<string | null> {
    return Promise.resolve(this.content);
  }

  replace(content: string): Promise<void> {
    if (this.failWrites) return Promise.reject(new Error('disk full'));
    this.content = content;
    return Promise.resolve();
  }

  preserveDamaged(): Promise<void> {
    return Promise.resolve();
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('createLedgerGuestRebindJournal', () => {
  it('records a rebind once, lists it, and removes it', async () => {
    const file = new MemoryFile();
    const journal = createLedgerGuestRebindJournal(
      file,
      () => new Date('2026-10-07T12:00:00.000Z'),
    );

    await journal.record(REBIND);
    await journal.record(REBIND);

    expect(await journal.pending()).toEqual([REBIND]);
    expect(JSON.parse(file.content ?? '')).toEqual({
      version: 1,
      rebinds: [{ ...REBIND, recordedAt: '2026-10-07T12:00:00.000Z' }],
    });

    await journal.remove(REBIND);

    expect(await journal.pending()).toEqual([]);
  });

  it('reads an unreadable journal as holding nothing', async () => {
    const file = new MemoryFile();
    file.content = '{not json';
    const journal = createLedgerGuestRebindJournal(file);

    expect(await journal.pending()).toEqual([]);
  });

  it('rejects a rebind it cannot write', async () => {
    const file = new MemoryFile();
    file.failWrites = true;
    const journal = createLedgerGuestRebindJournal(file);

    await expect(journal.record(REBIND)).rejects.toThrow('disk full');
  });
});

describe('createLedgerGuestRebinder', () => {
  function setup(overrides: Partial<LedgerGuestRebinderOptions> = {}): {
    readonly file: MemoryFile;
    readonly rebind: jest.Mock<Promise<void>, [LedgerGuestRebind]>;
    readonly onRebindError: jest.Mock<void, [unknown]>;
    readonly onJournalFailure: jest.Mock<void, [string]>;
    readonly options: LedgerGuestRebinderOptions;
  } {
    const file = new MemoryFile();
    const rebind = jest.fn<Promise<void>, [LedgerGuestRebind]>(() =>
      Promise.resolve(),
    );
    const onRebindError = jest.fn<void, [unknown]>();
    const onJournalFailure = jest.fn<void, [string]>();
    const options: LedgerGuestRebinderOptions = {
      journal: createLedgerGuestRebindJournal(file),
      databaseExists: () => Promise.resolve(true),
      rebind,
      onRebindError,
      onJournalFailure,
      ...overrides,
    };
    return { file, rebind, onRebindError, onJournalFailure, options };
  }

  it('records the rebind durably before it resolves, then applies and clears it', async () => {
    const { file, rebind, options } = setup();
    let finishRebind!: () => void;
    rebind.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishRebind = resolve;
      }),
    );
    const rebinder = createLedgerGuestRebinder(options);

    await rebinder.record(` ${GUEST} `, ACCOUNT);

    expect(await options.journal.pending()).toEqual([REBIND]);
    expect(rebind).toHaveBeenCalledWith(REBIND);

    finishRebind();
    await flush();

    expect(await options.journal.pending()).toEqual([]);
    expect(file.content).not.toBeNull();
  });

  it('keeps a rebind the store could not apply, and applies it on replay', async () => {
    const { rebind, onRebindError, options } = setup();
    const unavailable = new Error('worker unavailable');
    rebind.mockRejectedValueOnce(unavailable);
    await createLedgerGuestRebinder(options).record(GUEST, ACCOUNT);
    await flush();

    expect(onRebindError).toHaveBeenCalledWith(unavailable);
    expect(await options.journal.pending()).toEqual([REBIND]);

    // The next launch: a new rebinder over the same journal.
    await createLedgerGuestRebinder(options).replay();

    expect(rebind).toHaveBeenCalledTimes(2);
    expect(await options.journal.pending()).toEqual([]);
  });

  it('still applies a rebind it could not record, and says so', async () => {
    const { file, rebind, onJournalFailure, options } = setup();
    file.failWrites = true;

    await createLedgerGuestRebinder(options).record(GUEST, ACCOUNT);
    await flush();

    expect(onJournalFailure).toHaveBeenCalledWith('INTENT_NOT_RECORDED');
    expect(rebind).toHaveBeenCalledWith(REBIND);
  });

  it('records nothing without a database, or for the same or a missing account', async () => {
    const { file, rebind, options } = setup({
      databaseExists: () => Promise.resolve(false),
    });
    await createLedgerGuestRebinder(options).record(GUEST, ACCOUNT);
    const withDatabase = setup();
    const rebinder = createLedgerGuestRebinder(withDatabase.options);
    await rebinder.record(GUEST, GUEST);
    await rebinder.record('', ACCOUNT);
    await rebinder.record(GUEST, '  ');
    await flush();

    expect(file.content).toBeNull();
    expect(rebind).not.toHaveBeenCalled();
    expect(withDatabase.file.content).toBeNull();
    expect(withDatabase.rebind).not.toHaveBeenCalled();
  });

  it('replays nothing without a database', async () => {
    const { file, rebind, options } = setup({
      databaseExists: () => Promise.resolve(false),
    });
    file.content = JSON.stringify({
      version: 1,
      rebinds: [{ ...REBIND, recordedAt: '2026-10-07T12:00:00.000Z' }],
    });

    await createLedgerGuestRebinder(options).replay();

    expect(rebind).not.toHaveBeenCalled();
  });
});
