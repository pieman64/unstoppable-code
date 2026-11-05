import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type * as AtomicFileModule from '../lib/atomic-file';
import type * as LedgerModule from '../lib/migrations';

const mockDataDir = jest.fn<string, []>();
const mockWriteFailure = jest.fn<Error | undefined, [string]>();

jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  getCanopyDataDir: (): string => mockDataDir(),
}));
jest.mock('../lib/paths', () => ({
  getMigrationsFilePath: (): string => `${mockDataDir()}/migrations.json`,
}));
const mockWarn = jest.fn();
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
  logMainProcessWarn: (...args: unknown[]): void => {
    mockWarn(...args);
  },
}));
jest.mock('../lib/atomic-file', () => {
  const actual =
    jest.requireActual<typeof AtomicFileModule>('../lib/atomic-file');
  return {
    ...actual,
    writeFileAtomically: async (
      ...args: Parameters<typeof actual.writeFileAtomically>
    ): Promise<void> => {
      const failure = mockWriteFailure(basename(args[0]));
      if (failure) throw failure;
      return actual.writeFileAtomically(...args);
    },
  };
});

import {
  hasMigrationRun,
  markMigrationRun,
  MigrationLedgerUnavailableError,
} from '../lib/migrations';

type Ledger = typeof LedgerModule;

let dataDir: string;
const primary = (): string => join(dataDir, 'migrations.json');
const lastGood = (): string => join(dataDir, 'migrations.last-good.json');

const read = (path: string): Promise<string> => readFile(path, 'utf8');

async function damagedCopies(): Promise<string[]> {
  const names = (await readdir(dataDir)).filter((name) =>
    /^migrations\.damaged-.+\.json$/.test(name),
  );
  return Promise.all(names.map((name) => read(join(dataDir, name))));
}

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(
    () => true,
    () => false,
  );
}

/** A fresh module instance: what the next launch sees. */
async function restart(): Promise<Ledger> {
  let ledger: Ledger | undefined;
  await jest.isolateModulesAsync(async (): Promise<void> => {
    ledger = await import('../lib/migrations');
  });
  if (!ledger) throw new Error('ledger did not load');
  return ledger;
}

function ledgerText(state: object): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'canopy-migrations-ledger-'));
  mockDataDir.mockReturnValue(dataDir);
  mockWriteFailure.mockReturnValue(undefined);
  mockWarn.mockClear();
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('completion', () => {
  it('starts empty and writes last-good and the primary with the same content', async () => {
    await expect(hasMigrationRun('first')).resolves.toBe(false);
    await expect(exists(primary())).resolves.toBe(false);

    await markMigrationRun('first');

    const expected = ledgerText({ version: 1, first: true });
    await expect(read(primary())).resolves.toBe(expected);
    await expect(read(lastGood())).resolves.toBe(expected);
    await expect(hasMigrationRun('first')).resolves.toBe(true);
  });

  it('records nothing for a migration that throws, and retries it from the start', async () => {
    const steps: string[] = [];
    async function migrate(failAt: string | null): Promise<void> {
      if (await hasMigrationRun('owned')) return;
      for (const step of ['one', 'two']) {
        steps.push(step);
        if (step === failAt) throw new Error(`failed at ${step}`);
      }
      await markMigrationRun('owned');
    }

    await expect(migrate('two')).rejects.toThrow('failed at two');
    await expect(exists(primary())).resolves.toBe(false);

    const next = await restart();
    await expect(next.hasMigrationRun('owned')).resolves.toBe(false);
    await migrate(null);
    await migrate(null);

    expect(steps).toEqual(['one', 'two', 'one', 'two']);
    await expect(hasMigrationRun('owned')).resolves.toBe(true);
  });

  it('keeps unrelated markers, other values and unknown fields', async () => {
    await writeFile(
      primary(),
      JSON.stringify({ version: 1, other: true, note: 'kept', count: 3 }),
    );

    await markMigrationRun('mine');

    expect(JSON.parse(await read(primary()))).toEqual({
      version: 1,
      other: true,
      note: 'kept',
      count: 3,
      mine: true,
    });
    await expect(hasMigrationRun('note')).resolves.toBe(false);
  });

  it('accepts a ledger without a version and adds it on the next write', async () => {
    await writeFile(primary(), JSON.stringify({ legacy: true }));

    await expect(hasMigrationRun('legacy')).resolves.toBe(true);
    await markMigrationRun('next');

    await expect(read(primary())).resolves.toBe(
      ledgerText({ version: 1, legacy: true, next: true }),
    );
  });

  it('never treats "version" as a migration key', async () => {
    await expect(hasMigrationRun('version')).resolves.toBe(false);
    await expect(markMigrationRun('version')).rejects.toThrow(TypeError);
  });
});

describe('overlapping writes', () => {
  it('keeps every marker when marks overlap', async () => {
    const keys = Array.from({ length: 12 }, (_, index) => `key_${index}`);

    await Promise.all(keys.map((key) => markMigrationRun(key)));

    const state: unknown = JSON.parse(await read(primary()));
    expect(state).toEqual(
      Object.fromEntries([['version', 1], ...keys.map((key) => [key, true])]),
    );
    await expect(read(lastGood())).resolves.toBe(await read(primary()));
  });

  it('answers a read that follows a mark with the new marker', async () => {
    const [, seen] = await Promise.all([
      markMigrationRun('earlier'),
      hasMigrationRun('earlier'),
    ]);

    expect(seen).toBe(true);
  });
});

describe('marker write failure', () => {
  it('remembers the completion for this process and reruns after a restart', async () => {
    await writeFile(primary(), ledgerText({ version: 1 }));
    mockWriteFailure.mockImplementation((name) =>
      name === 'migrations.json' ? new Error('disk full') : undefined,
    );

    await expect(markMigrationRun('done')).rejects.toThrow('disk full');
    await expect(hasMigrationRun('done')).resolves.toBe(true);

    mockWriteFailure.mockReturnValue(undefined);
    const next = await restart();
    await expect(next.hasMigrationRun('done')).resolves.toBe(false);
  });

  it('answers a read queued behind a failed mark with the completion', async () => {
    await writeFile(primary(), ledgerText({ version: 1 }));
    mockWriteFailure.mockImplementation((name) =>
      name === 'migrations.json' ? new Error('disk full') : undefined,
    );

    const [mark, seen] = await Promise.allSettled([
      markMigrationRun('done'),
      hasMigrationRun('done'),
    ]);

    expect(mark.status).toBe('rejected');
    expect(seen).toEqual({ status: 'fulfilled', value: true });
  });
});

describe('missing ledger', () => {
  it('restores last-good when the primary is missing', async () => {
    const content = ledgerText({ version: 1, kept: true });
    await writeFile(lastGood(), content);

    await expect(hasMigrationRun('kept')).resolves.toBe(true);
    await expect(read(primary())).resolves.toBe(content);
  });

  it('fails closed when the primary is missing and last-good is unusable', async () => {
    await writeFile(lastGood(), '{"version": 1, "kept"');

    await expect(hasMigrationRun('kept')).rejects.toBeInstanceOf(
      MigrationLedgerUnavailableError,
    );
    await expect(markMigrationRun('kept')).rejects.toBeInstanceOf(
      MigrationLedgerUnavailableError,
    );
    await expect(exists(primary())).resolves.toBe(false);
  });

  it('writes last-good from a readable primary that has none', async () => {
    const content = ledgerText({ version: 1, existing: true });
    await writeFile(primary(), content);

    await expect(hasMigrationRun('existing')).resolves.toBe(true);
    await expect(read(lastGood())).resolves.toBe(content);
  });
});

describe('damaged ledger', () => {
  const damaged: Array<[string, string]> = [
    ['malformed', '{"version": 1, "kept": tr'],
    ['empty', ''],
    ['an array', '[]'],
    ['null', 'null'],
    ['a number', '42'],
    ['an unknown non-numeric version', '{"version": "2", "kept": true}'],
  ];

  it('keeps only the newest damaged copies, removing the oldest first', async () => {
    const copyName = (day: number): string =>
      `migrations.damaged-2026-01-0${day}T00-00-00-000Z-0a1b2c3d.json`;
    for (const day of [1, 2, 3, 4, 5, 6])
      await writeFile(join(dataDir, copyName(day)), `old ${day}`);
    await writeFile(lastGood(), ledgerText({ version: 1, kept: true }));
    await writeFile(primary(), '{"version": 1, "kept": tr');

    await expect(hasMigrationRun('kept')).resolves.toBe(true);

    const kept = (await readdir(dataDir))
      .filter((name) => /^migrations\.damaged-.+\.json$/.test(name))
      .sort();
    expect(kept.slice(0, 4)).toEqual([3, 4, 5, 6].map(copyName));
    expect(kept).toHaveLength(5);
    await expect(read(join(dataDir, kept[4] ?? ''))).resolves.toBe(
      '{"version": 1, "kept": tr',
    );
  });

  it.each(damaged)(
    'keeps a %s primary and restores last-good',
    async (_name, bytes) => {
      const content = ledgerText({ version: 1, kept: true });
      await writeFile(lastGood(), content);
      await writeFile(primary(), bytes);

      await expect(hasMigrationRun('kept')).resolves.toBe(true);

      await expect(read(primary())).resolves.toBe(content);
      await expect(damagedCopies()).resolves.toEqual([bytes]);
    },
  );

  it.each(damaged)(
    'fails closed on a %s primary without last-good, and leaves it in place',
    async (_name, bytes) => {
      await writeFile(primary(), bytes);

      await expect(hasMigrationRun('kept')).rejects.toMatchObject({
        name: 'MigrationLedgerUnavailableError',
        reason: 'damaged',
      });
      await expect(markMigrationRun('new')).rejects.toBeInstanceOf(
        MigrationLedgerUnavailableError,
      );
      await expect(hasMigrationRun('other')).rejects.toBeInstanceOf(
        MigrationLedgerUnavailableError,
      );

      await expect(read(primary())).resolves.toBe(bytes);
      await expect(exists(lastGood())).resolves.toBe(false);
      await expect(damagedCopies()).resolves.toEqual([bytes]);
      expect(mockWarn).toHaveBeenCalledTimes(1);
    },
  );

  it('fails closed when both copies are damaged', async () => {
    await writeFile(primary(), '{');
    await writeFile(lastGood(), '[');

    await expect(hasMigrationRun('kept')).rejects.toBeInstanceOf(
      MigrationLedgerUnavailableError,
    );
    await expect(read(primary())).resolves.toBe('{');
    await expect(read(lastGood())).resolves.toBe('[');
  });

  it('keeps failing closed after a restart without last-good', async () => {
    await writeFile(primary(), '{');
    await expect(hasMigrationRun('kept')).rejects.toBeInstanceOf(
      MigrationLedgerUnavailableError,
    );

    const next = await restart();
    await expect(next.hasMigrationRun('kept')).rejects.toBeInstanceOf(
      next.MigrationLedgerUnavailableError,
    );
    await expect(read(primary())).resolves.toBe('{');
    await expect(damagedCopies()).resolves.toEqual(['{']);
  });

  it('never leaves the primary missing when the restore is interrupted', async () => {
    const content = ledgerText({ version: 1, kept: true });
    await writeFile(lastGood(), content);
    await writeFile(primary(), '{');
    mockWriteFailure.mockImplementation((name) =>
      name === 'migrations.json' ? new Error('crashed') : undefined,
    );

    await expect(hasMigrationRun('kept')).rejects.toThrow('crashed');
    await expect(read(primary())).resolves.toBe('{');
    await expect(damagedCopies()).resolves.toEqual(['{']);

    mockWriteFailure.mockReturnValue(undefined);
    const next = await restart();
    await expect(next.hasMigrationRun('kept')).resolves.toBe(true);
    await expect(read(primary())).resolves.toBe(content);
    await expect(damagedCopies()).resolves.toEqual(['{']);
  });
});

describe('newer ledger', () => {
  it('leaves a newer version untouched and never restores over it', async () => {
    const newer = JSON.stringify({ version: 2, future: { kept: true } });
    await writeFile(primary(), newer);
    await writeFile(lastGood(), ledgerText({ version: 1, kept: true }));

    await expect(hasMigrationRun('kept')).rejects.toMatchObject({
      name: 'MigrationLedgerUnavailableError',
      reason: 'newer_version',
    });
    await expect(markMigrationRun('new')).rejects.toBeInstanceOf(
      MigrationLedgerUnavailableError,
    );

    await expect(read(primary())).resolves.toBe(newer);
    await expect(damagedCopies()).resolves.toEqual([]);
  });
});
