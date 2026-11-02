import { join, resolve } from 'node:path';
import type * as CanopyPathsModule from '../../../canopy-paths';
import type * as AdmittedStoragePathsModule from '../admitted-storage-paths';
import type * as RegistrationModule from '../canopy-data-root-registration';

type AdmittedStoragePaths = typeof AdmittedStoragePathsModule;
type Registration = typeof RegistrationModule;
type CanopyPaths = typeof CanopyPathsModule;

const REGISTERED_ROOT = resolve('/registered/canopy');
const mockImportedRoot = resolve('/imported/canopy');

/** How the next `import()` of canopy-paths behaves. */
let mockImportOutcome: 'loads' | 'not-found' | 'fails' = 'loads';

jest.mock('../../../canopy-paths', () => {
  if (mockImportOutcome === 'loads')
    return { getCanopyDataDir: (): string => mockImportedRoot };
  if (mockImportOutcome === 'fails') throw new Error('boom');
  // What a tsx/cjs process gets: its `import()` cannot load TypeScript.
  throw Object.assign(new Error('Cannot find module'), {
    code: 'ERR_MODULE_NOT_FOUND',
  });
});

// Fresh module state and mock per test, after `jest.resetModules()`.
const loadPaths = (): AdmittedStoragePaths =>
  jest.requireActual<AdmittedStoragePaths>('../admitted-storage-paths');
const register = (root: string): void =>
  jest
    .requireActual<Registration>('../canopy-data-root-registration')
    .registerCanopyDataRootResolver(() => root);

const preferencesUnder = (root: string): string =>
  join(root, 'preferences.json');

beforeEach(() => {
  jest.resetModules();
  mockImportOutcome = 'loads';
});

it('prefers the imported data root to a registered one', async () => {
  const paths = loadPaths();
  register(REGISTERED_ROOT);
  await expect(
    paths.admittedStorageRowForWrite(preferencesUnder(REGISTERED_ROOT)),
  ).resolves.toBeUndefined();
  await expect(
    paths.admittedStorageRowForWrite(preferencesUnder(mockImportedRoot)),
  ).resolves.toBe('preferences');
});

it('uses the registered data root when canopy-paths cannot be imported', async () => {
  mockImportOutcome = 'not-found';
  const paths = loadPaths();
  register(REGISTERED_ROOT);
  await expect(
    paths.admittedStorageRowForWrite(preferencesUnder(REGISTERED_ROOT)),
  ).resolves.toBe('preferences');
});

it('refuses to classify without a data root, then retries once one registers', async () => {
  mockImportOutcome = 'not-found';
  const paths = loadPaths();
  await expect(
    paths.admittedStorageRowForWrite(preferencesUnder(REGISTERED_ROOT)),
  ).rejects.toMatchObject({ code: 'ERR_MODULE_NOT_FOUND' });
  register(REGISTERED_ROOT);
  await expect(
    paths.admittedStorageRowForWrite(preferencesUnder(REGISTERED_ROOT)),
  ).resolves.toBe('preferences');
});

it('does not hide other import failures behind a registered root', async () => {
  mockImportOutcome = 'fails';
  const paths = loadPaths();
  register(REGISTERED_ROOT);
  await expect(
    paths.admittedStorageRowForWrite(preferencesUnder(REGISTERED_ROOT)),
  ).rejects.toThrow('boom');
});

it('falls back to the resolver canopy-paths registers when it loads', async () => {
  mockImportOutcome = 'not-found';
  const paths = loadPaths();
  const actual = jest.requireActual<CanopyPaths>('../../../canopy-paths');
  await expect(
    paths.admittedStorageRowForWrite(
      preferencesUnder(actual.getCanopyDataDir()),
    ),
  ).resolves.toBe('preferences');
});
