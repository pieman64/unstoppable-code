// GB12 (CAN-5543): the compiled-ownership gate, flipped with synthetic rows
// as the #7200 tests do.
import type * as Storage from '@canopy/core-runtime/storage';
jest.mock('@canopy/core-runtime/storage', () => {
  const actual = jest.requireActual<typeof Storage>(
    '@canopy/core-runtime/storage',
  );
  const rows: Storage.StorageOwnershipRow[] = [...actual.STORAGE_OWNERSHIP];
  return {
    ...actual,
    STORAGE_OWNERSHIP: rows,
    setDaemonOwnedForTest: (ids: readonly string[]): void => {
      actual.STORAGE_OWNERSHIP.forEach((row, index) => {
        rows[index] = ids.includes(row.id)
          ? { ...row, transitionOwner: 'daemon', currentWriters: [] }
          : row;
      });
    },
  };
});
const { setDaemonOwnedForTest } = jest.requireMock<{
  setDaemonOwnedForTest: (ids: readonly string[]) => void;
}>('@canopy/core-runtime/storage');

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { STORAGE_OWNERSHIP } from '@canopy/core-runtime/storage';
import { isW5DaemonFlipCompiled, W5_FLIP_NAMESPACES } from '../w5-flip-gate';

afterEach(() => setDaemonOwnedForTest([]));

it('stays off with the compiled legacy rows', () => {
  expect(isW5DaemonFlipCompiled()).toBe(false);
});

it('turns on only when all three W5 rows admit the daemon', () => {
  setDaemonOwnedForTest([...W5_FLIP_NAMESPACES]);
  expect(isW5DaemonFlipCompiled()).toBe(true);
});

it.each(W5_FLIP_NAMESPACES.map((namespace) => [namespace]))(
  'fails closed on a mixed set without %s',
  (missing) => {
    setDaemonOwnedForTest(W5_FLIP_NAMESPACES.filter((n) => n !== missing));
    expect(isW5DaemonFlipCompiled()).toBe(false);
  },
);

// The generated rows mirror storage-ownership.yaml; census:ownership-manifests
// --check fails on drift.
it('reads the three W5 rows from the compiled manifest, which flips them together', () => {
  const owners = W5_FLIP_NAMESPACES.map(
    (id) => STORAGE_OWNERSHIP.find((row) => row.id === id)?.transitionOwner,
  );
  expect(owners).not.toContain(undefined);
  expect(new Set(owners).size).toBe(1);
});

it('lets only the backup and the in-process store reach the in-process commit log host', () => {
  const main = join(__dirname, '../..');
  const sources = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory())
        return entry.name === '__tests__' ? [] : sources(path);
      return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)
        ? [path]
        : [];
    });
  const callers = sources(main)
    .filter((path) => /\bgetW5CommitLogHost\(/.test(readFileSync(path, 'utf8')))
    .map((path) => relative(main, path).split(sep).join('/'))
    .sort();
  expect(callers).toEqual([
    'lib/w5-backup.ts',
    'lib/w5-commit-log-file-store.ts',
    'w5-commit-log/commit-log-host.ts',
  ]);
});
