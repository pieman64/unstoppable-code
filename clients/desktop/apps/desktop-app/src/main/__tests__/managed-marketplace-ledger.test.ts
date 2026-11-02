import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type * as FsModule from 'fs';
import type * as AtomicFileModule from '@canopy/desktop-shared/node/lib/atomic-file';

let mockLedgerFile = '';
jest.mock('../lib/paths', () => ({
  getBuiltInPluginMarketplacesFilePath: (): string => mockLedgerFile,
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
let mockFailCopy = false;
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof FsModule>('fs');
  return {
    ...actual,
    copyFileSync: (...args: Parameters<typeof actual.copyFileSync>): void => {
      if (mockFailCopy) throw new Error('EACCES');
      actual.copyFileSync(...args);
    },
  };
});
let mockFailAtomicWrite = false;
let mockFailAfterAtomicInstall = false;
// Runs where a process ending mid-write would stop: before the install.
let mockBeforeAtomicWrite: (() => void) | null = null;
const mockAtomicWriteOptions: unknown[] = [];
jest.mock('@canopy/desktop-shared/node/lib/atomic-file', () => {
  const actual = jest.requireActual<typeof AtomicFileModule>(
    '@canopy/desktop-shared/node/lib/atomic-file',
  );
  return {
    ...actual,
    writeFileAtomicallySync: (
      ...args: Parameters<typeof actual.writeFileAtomicallySync>
    ): void => {
      mockAtomicWriteOptions.push(args[2]);
      mockBeforeAtomicWrite?.();
      if (mockFailAtomicWrite) throw new Error('disk full');
      actual.writeFileAtomicallySync(...args);
      // The rename landed but the directory fsync after it failed.
      if (mockFailAfterAtomicInstall) throw new Error('EIO');
    },
  };
});

import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  hasManagedMarketplaceReceipt,
  readManagedMarketplaceLedger,
  reconcileManagedMarketplaceReceipts,
  recordManagedMarketplaceReceipt,
  resetManagedMarketplaceLedgerForTests,
  type ManagedMarketplaceObservation,
} from '../plugins/managed-marketplace-ledger';

// Resolved as the module records roots, so these match on Windows
// (`C:\app\...`) too.
const MANAGED_ROOT = resolve('/app/resources/plugins');
const OLD_ROOT = resolve('/old/resources/plugins');
const builtIn = {
  provider: 'claude' as const,
  marketplaceName: 'canopy-plugins',
  sourceRoot: MANAGED_ROOT,
};

describe('managed marketplace ledger', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'managed-marketplace-ledger-'));
    file = join(dir, 'built-in-plugin-marketplaces.json');
    mockLedgerFile = file;
    mockFailCopy = false;
    mockFailAtomicWrite = false;
    mockFailAfterAtomicInstall = false;
    mockBeforeAtomicWrite = null;
    mockAtomicWriteOptions.length = 0;
    jest.mocked(logMainProcessWarn).mockClear();
    resetManagedMarketplaceLedgerForTests();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeLedger(value: unknown): string {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    writeFileSync(file, text, 'utf8');
    return text;
  }

  function asideFiles(): string[] {
    return readdirSync(dir).filter((name) =>
      /^built-in-plugin-marketplaces\.json\.damaged-\d+$/.test(name),
    );
  }

  function observe(
    overrides: Partial<ManagedMarketplaceObservation>,
  ): ManagedMarketplaceObservation {
    return {
      provider: 'claude',
      marketplaceName: 'canopy-plugins',
      managedRoot: MANAGED_ROOT,
      registeredRoot: MANAGED_ROOT,
      ...overrides,
    };
  }

  it('reads a missing file as no receipts', () => {
    expect(readManagedMarketplaceLedger()).toEqual({
      status: 'missing',
      receipts: [],
    });
    expect(hasManagedMarketplaceReceipt(builtIn)).toBe(false);
  });

  it('records a receipt once and leaves the file alone when it is already there', () => {
    expect(recordManagedMarketplaceReceipt(builtIn)).toEqual({
      status: 'recorded',
      added: 1,
    });
    const written = readFileSync(file, 'utf8');
    const read = readManagedMarketplaceLedger();
    expect(read.status).toBe('ok');
    expect(read.receipts).toHaveLength(1);
    expect(read.receipts[0]).toMatchObject(builtIn);
    expect(typeof read.receipts[0]?.brandId).toBe('string');
    expect(typeof read.receipts[0]?.recordedAt).toBe('string');
    expect(
      recordManagedMarketplaceReceipt({
        ...builtIn,
        marketplaceName: 'CANOPY-PLUGINS',
      }),
    ).toEqual({ status: 'unchanged' });
    expect(readFileSync(file, 'utf8')).toBe(written);
    expect(
      hasManagedMarketplaceReceipt({
        ...builtIn,
        sourceRoot: `${MANAGED_ROOT}${sep}..${sep}plugins`,
      }),
    ).toBe(true);
    expect(
      hasManagedMarketplaceReceipt({ ...builtIn, provider: 'codex' }),
    ).toBe(false);
  });

  it('keeps the valid receipts of a file with null or invalid entries', () => {
    writeLedger({
      version: 1,
      entries: [
        null,
        'text',
        { ...builtIn, provider: 'cursor' },
        { ...builtIn, sourceRoot: 'relative/root' },
        builtIn,
      ],
    });
    expect(readManagedMarketplaceLedger()).toEqual({
      status: 'damaged',
      receipts: [builtIn],
    });
    expect(hasManagedMarketplaceReceipt(builtIn)).toBe(true);
    // Reads never copy the file aside.
    expect(asideFiles()).toEqual([]);
  });

  it.each([
    // What power loss after an unsynced reconciliation write can leave.
    ['is empty', ''],
    ['does not parse', '{"version": 1, "entries": ['],
    ['is not an object', '[]'],
    ['has no version', '{"entries": []}'],
    ['has an older version', '{"version": 0, "entries": []}'],
    ['has no entry list', '{"version": 1, "entries": {}}'],
  ])('copies a file that %s aside before the next write', (_case, original) => {
    writeLedger(original);
    expect(readManagedMarketplaceLedger().status).toBe('damaged');

    expect(recordManagedMarketplaceReceipt(builtIn).status).toBe('recorded');

    const aside = asideFiles();
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0] ?? ''), 'utf8')).toBe(original);
    expect(readManagedMarketplaceLedger()).toEqual({
      status: 'ok',
      receipts: [expect.objectContaining(builtIn)],
    });
    expect(logMainProcessWarn).toHaveBeenCalledWith(
      expect.stringContaining('copied a damaged receipt file aside'),
    );
  });

  it('carries the valid receipts of a damaged file into the rewrite', () => {
    const older = { ...builtIn, sourceRoot: OLD_ROOT };
    writeLedger({ version: 1, entries: [null, older] });

    recordManagedMarketplaceReceipt(builtIn);

    expect(readManagedMarketplaceLedger().receipts).toEqual([
      older,
      expect.objectContaining(builtIn),
    ]);
  });

  it('keeps a damaged file readable while its evidence copy is taken', () => {
    const original = writeLedger({ version: 1, entries: [null, builtIn] });
    // What a process ending after the copy but before the install leaves.
    let onDisk: {
      text: string | null;
      read: unknown;
      aside: string[];
    } | null = null;
    mockBeforeAtomicWrite = (): void => {
      onDisk = {
        text: existsSync(file) ? readFileSync(file, 'utf8') : null,
        read: readManagedMarketplaceLedger(),
        aside: asideFiles(),
      };
    };

    recordManagedMarketplaceReceipt({ ...builtIn, provider: 'codex' });

    expect(onDisk).toEqual({
      text: original,
      read: { status: 'damaged', receipts: [builtIn] },
      aside: [expect.stringMatching(/\.damaged-\d+$/)],
    });
  });

  it('leaves a damaged file in place when the rewrite fails', () => {
    const original = writeLedger({ version: 1, entries: [null, builtIn] });
    mockFailAtomicWrite = true;

    expect(
      recordManagedMarketplaceReceipt({ ...builtIn, provider: 'codex' }),
    ).toEqual({ status: 'failed', error: 'disk full' });

    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(readManagedMarketplaceLedger()).toEqual({
      status: 'damaged',
      receipts: [builtIn],
    });
    const aside = asideFiles();
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0] ?? ''), 'utf8')).toBe(original);
  });

  it('does not rewrite a damaged file it could not copy aside', () => {
    const original = writeLedger({ version: 1, entries: [null, builtIn] });
    mockFailCopy = true;

    expect(
      recordManagedMarketplaceReceipt({ ...builtIn, provider: 'codex' }),
    ).toEqual({ status: 'failed', error: 'EACCES' });

    expect(mockAtomicWriteOptions).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(asideFiles()).toEqual([]);
  });

  it('keeps an installed rewrite when the write fails after the rename', () => {
    const original = writeLedger({ version: 1, entries: [null, builtIn] });
    mockFailAfterAtomicInstall = true;
    const codex = { ...builtIn, provider: 'codex' as const };

    expect(recordManagedMarketplaceReceipt(codex)).toEqual({
      status: 'failed',
      error: 'EIO',
    });

    expect(readManagedMarketplaceLedger()).toEqual({
      status: 'ok',
      receipts: [
        expect.objectContaining(builtIn),
        expect.objectContaining(codex),
      ],
    });
    const aside = asideFiles();
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0] ?? ''), 'utf8')).toBe(original);
  });

  it.each([
    [
      'from a newer version',
      (): void => {
        writeLedger({ version: 2, entries: [builtIn] });
      },
      'newer',
    ],
    [
      'unreadable',
      (): void => {
        mkdirSync(file);
      },
      'unreadable',
    ],
  ] as const)(
    'never writes over a file %s and warns once',
    (_case, arrange, reason) => {
      arrange();
      const before = readdirSync(dir);

      expect(readManagedMarketplaceLedger()).toEqual({
        status: reason,
        receipts: [],
      });
      expect(hasManagedMarketplaceReceipt(builtIn)).toBe(false);
      expect(recordManagedMarketplaceReceipt(builtIn)).toEqual({
        status: 'refused',
        reason,
      });
      expect(reconcileManagedMarketplaceReceipts([observe({})])).toEqual({
        status: 'refused',
        reason,
      });

      expect(readdirSync(dir)).toEqual(before);
      expect(logMainProcessWarn).toHaveBeenCalledTimes(1);
    },
  );

  it('returns a failed write instead of throwing', () => {
    mockFailAtomicWrite = true;

    expect(recordManagedMarketplaceReceipt(builtIn)).toEqual({
      status: 'failed',
      error: 'disk full',
    });
    expect(reconcileManagedMarketplaceReceipts([observe({})])).toEqual({
      status: 'failed',
      error: 'disk full',
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('makes an install-time receipt durable and a reconciled one atomic only', () => {
    recordManagedMarketplaceReceipt(builtIn);
    reconcileManagedMarketplaceReceipts([observe({ provider: 'codex' })]);

    expect(mockAtomicWriteOptions).toEqual([
      expect.objectContaining({ durable: true }),
      expect.objectContaining({ durable: false }),
    ]);
    expect(readManagedMarketplaceLedger()).toEqual({
      status: 'ok',
      receipts: [
        expect.objectContaining(builtIn),
        expect.objectContaining({ ...builtIn, provider: 'codex' }),
      ],
    });
  });

  it('ignores a relative root', () => {
    expect(
      recordManagedMarketplaceReceipt({ ...builtIn, sourceRoot: 'plugins' }),
    ).toEqual({ status: 'unchanged' });
    expect(readdirSync(dir)).toEqual([]);
  });

  describe('reconciliation', () => {
    it('records every proven receipt in one write and keeps the rest', () => {
      const historical = { ...builtIn, sourceRoot: OLD_ROOT };
      writeLedger({ version: 1, entries: [historical] });

      expect(
        reconcileManagedMarketplaceReceipts([
          observe({}),
          observe({ provider: 'codex' }),
          // The same fact twice is still one receipt.
          observe({ provider: 'codex' }),
          observe({
            marketplaceName: 'canopy-curated',
            managedRoot: '/data/curated',
            registeredRoot: '/data/curated',
          }),
        ]),
      ).toEqual({ status: 'recorded', added: 3 });

      expect(readManagedMarketplaceLedger()).toEqual({
        status: 'ok',
        receipts: [
          historical,
          expect.objectContaining(builtIn),
          expect.objectContaining({ ...builtIn, provider: 'codex' }),
          expect.objectContaining({
            provider: 'claude',
            marketplaceName: 'canopy-curated',
            sourceRoot: resolve('/data/curated'),
          }),
        ],
      });
    });

    it.each([
      ['no registration', observe({ registeredRoot: null })],
      ['a different root', observe({ registeredRoot: '/elsewhere/plugins' })],
      ['a relative root', observe({ registeredRoot: 'plugins' })],
    ])('proves nothing from %s', (_case, observation) => {
      expect(reconcileManagedMarketplaceReceipts([observation])).toEqual({
        status: 'unchanged',
      });
      expect(readdirSync(dir)).toEqual([]);
    });

    it('keeps a damaged file in place until a rewrite installs over it', () => {
      const original = writeLedger('{"version": 1, "entries": [');
      let now = 1000;
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        mockFailAtomicWrite = true;
        expect(reconcileManagedMarketplaceReceipts([observe({})])).toEqual({
          status: 'failed',
          error: 'disk full',
        });
        expect(readFileSync(file, 'utf8')).toBe(original);
        expect(asideFiles()).toEqual([
          'built-in-plugin-marketplaces.json.damaged-1000',
        ]);

        mockFailAtomicWrite = false;
        now = 2000;
        expect(reconcileManagedMarketplaceReceipts([observe({})])).toEqual({
          status: 'recorded',
          added: 1,
        });
      } finally {
        clock.mockRestore();
      }
      // Each attempt on the damaged file keeps its own copy.
      const aside = asideFiles().sort();
      expect(aside).toEqual([
        'built-in-plugin-marketplaces.json.damaged-1000',
        'built-in-plugin-marketplaces.json.damaged-2000',
      ]);
      for (const name of aside) {
        expect(readFileSync(join(dir, name), 'utf8')).toBe(original);
      }
      expect(readManagedMarketplaceLedger()).toEqual({
        status: 'ok',
        receipts: [expect.objectContaining(builtIn)],
      });
    });

    it('does not rewrite a file that already has the receipt', () => {
      const original = writeLedger({ version: 1, entries: [builtIn] });

      expect(reconcileManagedMarketplaceReceipts([observe({})])).toEqual({
        status: 'unchanged',
      });
      expect(readFileSync(file, 'utf8')).toBe(original);
    });
  });
});
