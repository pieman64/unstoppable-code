import type {
  FileIndexingPreferences,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import { BUILTIN_INDEX_GLOBS } from '@canopy/desktop-shared/file-indexing';
import {
  getBuiltinRows,
  getCustomRows,
  loadFilesTabState,
  validateNewCustomGlob,
  type FilesTabPreferencesApi,
} from '../filesTabState';

function createApi(
  loadPreferences: FilesTabPreferencesApi['loadPreferences'],
  savePreferences?: FilesTabPreferencesApi['savePreferences'],
): FilesTabPreferencesApi {
  return { loadPreferences, savePreferences };
}

const EMPTY_FILE_INDEXING: FileIndexingPreferences = {
  disabledBuiltinGlobIds: [],
  customGlobs: [],
};

function createPreferences(
  overrides: Partial<PreferencesData> = {},
): Awaited<ReturnType<FilesTabPreferencesApi['loadPreferences']>> {
  return {
    fileAutoSave: false,
    fileIndexing: EMPTY_FILE_INDEXING,
    ...overrides,
  };
}

describe('loadFilesTabState', () => {
  it('returns the saved auto-save preference and default indexing rows', async () => {
    const api = createApi(() =>
      Promise.resolve(
        createPreferences({
          fileAutoSave: true,
          fileIndexing: EMPTY_FILE_INDEXING,
        }),
      ),
    );

    const state = await loadFilesTabState(api);
    if (state.status !== 'ready') throw new Error('expected ready state');

    expect(state.autoSaveEnabled).toBe(true);
    expect(state.fileIndexing).toEqual(EMPTY_FILE_INDEXING);
    expect(state.builtinRows.length).toBe(BUILTIN_INDEX_GLOBS.length);
    expect(state.builtinRows.every((row) => row.enabled)).toBe(true);
    expect(state.customRows).toEqual([]);
    expect(state.saveStatus).toBe('idle');
  });

  it('reflects disabled built-in ids in the rendered rows', async () => {
    const api = createApi(() =>
      Promise.resolve(
        createPreferences({
          fileIndexing: {
            disabledBuiltinGlobIds: ['node-modules'],
            customGlobs: [],
          },
        }),
      ),
    );

    const state = await loadFilesTabState(api);
    if (state.status !== 'ready') throw new Error('expected ready state');

    const nodeModulesRow = state.builtinRows.find(
      (row) => row.id === 'node-modules',
    );
    expect(nodeModulesRow?.enabled).toBe(false);
    // Other built-ins remain enabled.
    expect(
      state.builtinRows
        .filter((row) => row.id !== 'node-modules')
        .every((row) => row.enabled),
    ).toBe(true);
  });

  it('drops unknown built-in ids and dedupes custom globs by trimmed pattern', async () => {
    const api = createApi(() =>
      Promise.resolve(
        createPreferences({
          fileIndexing: {
            disabledBuiltinGlobIds: [
              'node-modules',
              'totally-unknown',
              'node-modules',
            ],
            customGlobs: [
              { id: 'a', pattern: '**/build/**', enabled: true },
              { id: 'b', pattern: '  **/build/**  ', enabled: true },
              { id: 'c', pattern: '   ', enabled: true },
              { id: 'd', pattern: '**/dist/**', enabled: false },
            ],
          },
        }),
      ),
    );

    const state = await loadFilesTabState(api);
    if (state.status !== 'ready') throw new Error('expected ready state');

    expect(state.fileIndexing.disabledBuiltinGlobIds).toEqual(['node-modules']);
    expect(state.customRows.map((g) => g.pattern)).toEqual([
      '**/build/**',
      '**/dist/**',
    ]);
    expect(
      state.customRows.find((g) => g.pattern === '**/dist/**')?.enabled,
    ).toBe(false);
  });

  it('returns an error state when preferences fail to load', async () => {
    const api = createApi(() =>
      Promise.reject(new Error('userData unavailable')),
    );

    await expect(loadFilesTabState(api)).resolves.toEqual({
      status: 'error',
    });
  });
});

describe('getBuiltinRows / getCustomRows', () => {
  it('builds rows from the shared BUILTIN_INDEX_GLOBS list', () => {
    const rows = getBuiltinRows(EMPTY_FILE_INDEXING);
    expect(rows.map((r) => r.id)).toEqual(BUILTIN_INDEX_GLOBS.map((g) => g.id));
    expect(rows[0].pattern).toBe(BUILTIN_INDEX_GLOBS[0].pattern);
  });

  it('clones custom rows so mutating the result does not change the source', () => {
    const source: FileIndexingPreferences = {
      disabledBuiltinGlobIds: [],
      customGlobs: [{ id: 'a', pattern: '**/x/**', enabled: true }],
    };
    const rows = getCustomRows(source);
    rows[0].pattern = 'mutated';
    expect(source.customGlobs[0].pattern).toBe('**/x/**');
  });
});

describe('validateNewCustomGlob', () => {
  it('rejects an empty pattern', () => {
    expect(validateNewCustomGlob('', [])).toBe('Enter a glob pattern.');
    expect(validateNewCustomGlob('   ', [])).toBe('Enter a glob pattern.');
  });

  it('rejects a duplicate of an existing pattern', () => {
    expect(validateNewCustomGlob('**/build/**', ['**/build/**'])).toBe(
      'This glob is already listed.',
    );
  });

  it('returns null for a valid new pattern', () => {
    expect(
      validateNewCustomGlob('**/generated/**', ['**/build/**']),
    ).toBeNull();
  });
});
