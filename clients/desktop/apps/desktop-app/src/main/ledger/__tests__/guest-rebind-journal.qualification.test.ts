import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LedgerContainer } from '@canopy/protocol/canopy-core';
import { LedgerRepository } from '@canopy/desktop-shared/node/ledger/repository';
import {
  createLedgerGuestRebindJournal,
  createLedgerGuestRebinder,
  LedgerGuestRebindIntentError,
  type LedgerGuestRebind,
  type LedgerGuestRebinder,
} from '../guest-rebind-intents';
import {
  createLedgerLifecycleIntentFile,
  type LedgerLifecycleIntentFile,
} from '../lifecycle-intents';

// Isolate the lifecycle host's scope-binding import cycle, not file operations.
jest.mock('../scope-bindings', () => ({ ledgerContainerKey: jest.fn() }));

const timestamp = '2026-11-06T10:00:00.000Z';
const now = (): Date => new Date(timestamp);
const earlier = {
  fromAccountId: 'earlier-guest',
  toAccountId: 'earlier-account',
};
const next = { fromAccountId: 'next-guest', toAccountId: 'next-account' };
const intent = { ...earlier, recordedAt: timestamp };

interface MemoryFile {
  readonly file: {
    readonly read: jest.Mock<Promise<string | null>, []>;
    readonly replace: jest.Mock<Promise<void>, [string]>;
    readonly preserveDamaged: jest.Mock<Promise<void>, [string, string]>;
  };
  readonly copies: string[];
  readonly events: string[];
  readonly raw: () => string | null;
}

function memoryFile(initial: string | null = null): MemoryFile {
  let raw = initial;
  const copies: string[] = [];
  const events: string[] = [];
  const file = {
    read: jest.fn((): Promise<string | null> => Promise.resolve(raw)),
    replace: jest.fn((content: string): Promise<void> => {
      events.push('replace');
      raw = content;
      return Promise.resolve();
    }),
    preserveDamaged: jest.fn<Promise<void>, [string, string]>(
      (content: string): Promise<void> => {
        events.push('preserve');
        copies.push(content);
        return Promise.resolve();
      },
    ),
  } satisfies LedgerLifecycleIntentFile;
  return { file, copies, events, raw: (): string | null => raw };
}

function parseJson(raw: string | null): unknown {
  if (raw === null) throw new Error('Expected a durable journal');
  return JSON.parse(raw);
}

describe('CAN-4489 guest journal preservation', () => {
  test('real Ledger file port keeps damaged bytes beside a restart-readable replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-4489-'));
    try {
      const path = join(directory, 'guest-rebind-intents.json');
      const raw = `{"version":1,"rebinds":[${JSON.stringify(intent)}`;
      await writeFile(path, raw);
      const journal = createLedgerGuestRebindJournal(
        createLedgerLifecycleIntentFile(path),
        { now },
      );
      await journal.record(next);
      const names = await readdir(directory);
      const preserved = names.filter((name) =>
        name.startsWith('guest-rebind-intents.json.corrupt-'),
      );
      expect(preserved).toHaveLength(1);
      expect(await readFile(join(directory, preserved[0]), 'utf8')).toBe(raw);
      const restarted = createLedgerGuestRebindJournal(
        createLedgerLifecycleIntentFile(path),
        { now },
      );
      expect(await restarted.pending()).toEqual([next]);
      await restarted.remove(next);
      expect(parseJson(await readFile(path, 'utf8'))).toMatchObject({
        damagedAt: timestamp,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each([
    `{"version":1,"rebinds":[${JSON.stringify(intent)}`,
    '',
    'null',
    '[]',
    '{"version":0,"rebinds":[]}',
    '{"version":1,"rebinds":{}}',
    '{"version":1,"rebinds":[],"damagedAt":12}',
    '{"version":1,"rebinds":[],"damagedAt":"invalid"}',
  ])('record preserves malformed bytes before replacing: %s', async (raw) => {
    const store = memoryFile(raw);
    const journal = createLedgerGuestRebindJournal(store.file, { now });
    await journal.record(next);
    expect(store.copies).toEqual([raw]);
    expect(store.events[0]).toBe('preserve');
    expect(await journal.pending()).toEqual([next]);
    expect(parseJson(store.raw())).toMatchObject({ damagedAt: timestamp });
    await journal.remove(next);
    expect(parseJson(store.raw())).toMatchObject({ damagedAt: timestamp });
  });

  test.each([2, 1.5])(
    'newer journal %s refuses record, remove and pending with a typed reason',
    async (version) => {
      const raw = JSON.stringify({
        version,
        rebinds: [intent],
        future: 'keep-me',
      });
      const store = memoryFile(raw);
      const journal = createLedgerGuestRebindJournal(store.file, { now });
      for (const operation of [
        (): Promise<void> => journal.record(next),
        (): Promise<void> => journal.remove(earlier),
        (): Promise<readonly LedgerGuestRebind[]> => journal.pending(),
      ]) {
        const refused = operation();
        await expect(refused).rejects.toBeInstanceOf(
          LedgerGuestRebindIntentError,
        );
        await expect(refused).rejects.toMatchObject({
          name: 'LedgerGuestRebindIntentError',
          reason: 'INTENT_JOURNAL_NEWER',
        });
      }
      expect(store.raw()).toBe(raw);
      expect(store.events).toEqual([]);
    },
  );

  test('unreadable entries survive record, remove and reconstruction', async () => {
    const unreadable = [
      null,
      false,
      12,
      'private-entry-content',
      { ...earlier, recordedAt: 4 },
      { future: { nested: ['keep'] } },
    ];
    const store = memoryFile(
      JSON.stringify({ version: 1, rebinds: [intent, ...unreadable] }),
    );
    const journal = createLedgerGuestRebindJournal(store.file, { now });
    expect(await journal.pending()).toEqual([earlier]);
    await journal.record(next);
    await journal.remove(earlier);
    const reconstructed = createLedgerGuestRebindJournal(store.file, { now });
    expect(await reconstructed.pending()).toEqual([next]);
    await reconstructed.remove(next);
    expect(parseJson(store.raw())).toEqual({ version: 1, rebinds: unreadable });
    expect(store.copies).toEqual([]);
  });

  test('failed preservation refuses replacement and a later attempt retries', async () => {
    const raw = '{broken-earlier-guest';
    const store = memoryFile(raw);
    store.file.preserveDamaged.mockRejectedValueOnce(new Error('private path'));
    const journal = createLedgerGuestRebindJournal(store.file, { now });
    await expect(journal.record(next)).rejects.toThrow();
    expect(store.raw()).toBe(raw);
    expect(store.file.replace).not.toHaveBeenCalled();
    await journal.record(next);
    expect(store.copies).toEqual([raw]);
    expect(await journal.pending()).toEqual([next]);
  });

  test('failed replacement after preservation leaves original available', async () => {
    const raw = '{broken-earlier-guest';
    const store = memoryFile(raw);
    store.file.replace.mockRejectedValueOnce(new Error('replace failed'));
    const journal = createLedgerGuestRebindJournal(store.file, { now });
    await expect(journal.record(next)).rejects.toThrow();
    expect(store.copies).toEqual([raw]);
    expect(store.raw()).toBe(raw);
    await journal.record(next);
    expect(await journal.pending()).toEqual([next]);
  });

  test('replacement that lands but rejects is reread before another record', async () => {
    const store = memoryFile(JSON.stringify({ version: 1, rebinds: [intent] }));
    const replace = store.file.replace.getMockImplementation();
    if (replace === undefined) throw new Error('Missing file implementation');
    store.file.replace.mockImplementationOnce(
      async (content): Promise<void> => {
        await replace(content);
        throw new Error('directory flush failed');
      },
    );
    const journal = createLedgerGuestRebindJournal(store.file, { now });
    await expect(journal.record(next)).rejects.toThrow();
    await journal.record(next);
    expect(await journal.pending()).toEqual([earlier, next]);
    expect(parseJson(store.raw())).toMatchObject({
      rebinds: [intent, { ...next, recordedAt: timestamp }],
    });
  });

  test('a missing journal is not quarantined and concurrent records deduplicate', async () => {
    const store = memoryFile();
    const journal = createLedgerGuestRebindJournal(store.file, { now });
    expect(await journal.pending()).toEqual([]);
    await Promise.all([
      journal.record(earlier),
      journal.record(next),
      journal.record(earlier),
    ]);
    expect(await journal.pending()).toEqual([earlier, next]);
    expect(store.copies).toEqual([]);
  });

  test('I/O read failure leaves bytes untouched', async () => {
    const store = memoryFile(JSON.stringify({ version: 1, rebinds: [intent] }));
    store.file.read.mockRejectedValue(new Error('private path'));
    const journal = createLedgerGuestRebindJournal(store.file, { now });
    await expect(journal.record(next)).rejects.toThrow();
    await expect(journal.pending()).rejects.toThrow();
    expect(store.events).toEqual([]);
  });

  test.each([
    ['{private-earlier-rebind', 'INTENT_JOURNAL_QUARANTINED'],
    [
      JSON.stringify({ version: 2, rebinds: [], private: 'account-id' }),
      'INTENT_JOURNAL_NEWER',
    ],
    [
      JSON.stringify({ version: 1, rebinds: [{ private: 'account-id' }] }),
      'INTENT_ENTRIES_UNREADABLE',
    ],
  ])('diagnostics contain only a fixed reason for %s', async (raw, reason) => {
    const store = memoryFile(raw);
    const diagnostics = jest.fn();
    const journal = createLedgerGuestRebindJournal(store.file, {
      now,
      onJournalFailure: diagnostics,
    });
    await journal.pending().catch(() => undefined);
    expect(diagnostics.mock.calls).toEqual([[reason]]);
  });

  test('replay is idempotent in SQLite after failed removal and database restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-4489-replay-'));
    const databasePath = join(directory, 'ledger.sqlite');
    let repository: LedgerRepository | undefined;
    try {
      repository = LedgerRepository.open({ databasePath, now });
      const container: LedgerContainer = {
        kind: 'code_worktree',
        workspaceId: 'workspace',
        worktreeId: 'worktree',
      };
      const identity = { container, containerCreatedAt: timestamp };
      const bound = repository.bindScope({
        ...identity,
        authorityId: repository.authorityId,
        accountId: earlier.fromAccountId,
      });
      const store = memoryFile(
        JSON.stringify({ version: 1, rebinds: [intent] }),
      );
      store.file.replace.mockRejectedValueOnce(new Error('failed removal'));
      const moved: number[] = [];
      const onJournalFailure = jest.fn();
      const onRebindError = jest.fn();
      const rebinder = (database: LedgerRepository): LedgerGuestRebinder =>
        createLedgerGuestRebinder({
          journal: createLedgerGuestRebindJournal(store.file, { now }),
          databaseExists: (): Promise<boolean> => Promise.resolve(true),
          rebind: (rebind): Promise<void> => {
            moved.push(database.rebindAccount(rebind).rebound);
            return Promise.resolve();
          },
          onRebindError,
          onJournalFailure,
        });
      await rebinder(repository).replay();
      expect(onJournalFailure).toHaveBeenCalledWith('INTENT_NOT_REMOVED');
      expect(repository.findScope(identity)).toMatchObject({
        accountId: earlier.toAccountId,
        scope: bound.scope.scope,
      });
      repository.close();
      repository = LedgerRepository.open({ databasePath, now });
      const restarted = rebinder(repository);
      await restarted.replay();
      await restarted.replay();
      expect(moved).toEqual([1, 0]);
      expect(repository.findScope(identity)).toMatchObject({
        accountId: earlier.toAccountId,
        scope: bound.scope.scope,
      });
      expect(onRebindError).not.toHaveBeenCalled();
      expect(
        await createLedgerGuestRebindJournal(store.file, { now }).pending(),
      ).toEqual([]);
    } finally {
      repository?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('failed replay application retains its intent for a later launch', async () => {
    const store = memoryFile(JSON.stringify({ version: 1, rebinds: [intent] }));
    const journal = createLedgerGuestRebindJournal(store.file, { now });
    const onRebindError = jest.fn();
    const rebind = jest.fn(
      (): Promise<void> => Promise.reject(new Error('storage unavailable')),
    );
    const options = {
      journal,
      databaseExists: (): Promise<boolean> => Promise.resolve(true),
      rebind,
      onRebindError,
      onJournalFailure: jest.fn(),
    };
    await createLedgerGuestRebinder(options).replay();
    expect(onRebindError).toHaveBeenCalledTimes(1);
    expect(await journal.pending()).toEqual([earlier]);
    expect(store.events).toEqual([]);
    rebind.mockResolvedValue(undefined);
    await createLedgerGuestRebinder(options).replay();
    expect(await journal.pending()).toEqual([]);
  });

  // settings:start-canopy-cloud-oauth-login awaits record(), not application.
  test('sign-in contract awaits durability but not a blocked application', async () => {
    let durable: () => void = (): never => {
      throw new Error('Durability barrier not initialized');
    };
    let applied: () => void = (): never => {
      throw new Error('Application barrier not initialized');
    };
    const durability = new Promise<void>((resolve) => {
      durable = resolve;
    });
    const application = new Promise<void>((resolve) => {
      applied = resolve;
    });
    const rebind = jest.fn((): Promise<void> => application);
    const record = jest.fn((): Promise<void> => durability);
    const remove = jest.fn((): Promise<void> => Promise.resolve());
    const rebinder = createLedgerGuestRebinder({
      journal: {
        record,
        remove,
        pending: (): Promise<readonly LedgerGuestRebind[]> =>
          Promise.resolve([]),
      },
      databaseExists: (): Promise<boolean> => Promise.resolve(true),
      rebind,
      onRebindError: jest.fn(),
      onJournalFailure: jest.fn(),
    });
    let returned = false;
    const signingIn = rebinder
      .record(earlier.fromAccountId, earlier.toAccountId)
      .then(() => {
        returned = true;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(record).toHaveBeenCalled();
    expect(returned).toBe(false);
    expect(rebind).not.toHaveBeenCalled();
    durable();
    await signingIn;
    expect(returned).toBe(true);
    expect(rebind).toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    applied();
    await application;
    await Promise.resolve();
    expect(remove).toHaveBeenCalledWith(earlier);
  });

  test.each([
    ['', 'account'],
    ['  ', 'account'],
    ['guest', ''],
    ['same', 'same'],
  ])('invalid rebind %s -> %s performs no I/O', async (from, to) => {
    const store = memoryFile();
    const rebind = jest.fn();
    const rebinder = createLedgerGuestRebinder({
      journal: createLedgerGuestRebindJournal(store.file, { now }),
      databaseExists: (): Promise<boolean> => Promise.resolve(true),
      rebind,
      onRebindError: jest.fn(),
      onJournalFailure: jest.fn(),
    });
    await rebinder.record(from, to);
    expect(store.file.read).not.toHaveBeenCalled();
    expect(rebind).not.toHaveBeenCalled();
  });
});
