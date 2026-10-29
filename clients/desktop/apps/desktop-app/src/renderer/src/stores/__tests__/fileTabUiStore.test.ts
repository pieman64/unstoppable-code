import type * as FileTabUiModule from '../fileTabUiStore';

const loadPreferencesMock = jest.fn<Promise<Record<string, unknown>>, []>();

function loadStore(): typeof FileTabUiModule {
  jest.resetModules();
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: { api: { loadPreferences: loadPreferencesMock } },
  });
  return jest.requireActual<typeof FileTabUiModule>('../fileTabUiStore');
}

beforeEach(() => {
  loadPreferencesMock.mockReset();
});

describe('useFileTabUiStore preferences', () => {
  it('hydrates autoSaveEnabled from the persisted fileAutoSave preference', async () => {
    loadPreferencesMock.mockResolvedValue({ fileAutoSave: true });
    const { useFileTabUiStore } = loadStore();

    expect(useFileTabUiStore.getState().autoSaveEnabled).toBe(false);
    await useFileTabUiStore.getState().loadPreferences();

    expect(useFileTabUiStore.getState().autoSaveEnabled).toBe(true);
    expect(useFileTabUiStore.getState().preferencesLoaded).toBe(true);
  });

  it('hydrates preferences at most once (idempotent)', async () => {
    loadPreferencesMock.mockResolvedValue({ fileAutoSave: true });
    const { useFileTabUiStore } = loadStore();

    await useFileTabUiStore.getState().loadPreferences();
    await useFileTabUiStore.getState().loadPreferences();

    expect(loadPreferencesMock).toHaveBeenCalledTimes(1);
  });

  it('still marks preferences loaded when hydration fails', async () => {
    loadPreferencesMock.mockRejectedValue(new Error('userData unavailable'));
    const { useFileTabUiStore } = loadStore();

    await useFileTabUiStore.getState().loadPreferences();

    expect(useFileTabUiStore.getState().preferencesLoaded).toBe(true);
    expect(useFileTabUiStore.getState().autoSaveEnabled).toBe(false);
  });

  it('does not overwrite a toggle made while hydration is in flight', async () => {
    let resolveLoad: (prefs: Record<string, unknown>) => void = () => {};
    loadPreferencesMock.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const { useFileTabUiStore } = loadStore();

    const hydration = useFileTabUiStore.getState().loadPreferences();
    // User flips Auto Save on while the persisted read is still pending.
    useFileTabUiStore.getState().setAutoSaveEnabled(true);
    resolveLoad({ fileAutoSave: false });
    await hydration;

    expect(useFileTabUiStore.getState().autoSaveEnabled).toBe(true);
    expect(useFileTabUiStore.getState().preferencesLoaded).toBe(true);
  });

  it('dedupes concurrent hydration calls into one IPC read', async () => {
    let resolveLoad: (prefs: Record<string, unknown>) => void = () => {};
    loadPreferencesMock.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const { useFileTabUiStore } = loadStore();

    const first = useFileTabUiStore.getState().loadPreferences();
    const second = useFileTabUiStore.getState().loadPreferences();
    resolveLoad({ fileAutoSave: true });
    await Promise.all([first, second]);

    expect(loadPreferencesMock).toHaveBeenCalledTimes(1);
    expect(useFileTabUiStore.getState().autoSaveEnabled).toBe(true);
  });

  it('toggles autoSaveEnabled (idempotent when unchanged)', () => {
    const { useFileTabUiStore } = loadStore();
    const changes: boolean[] = [];
    const unsub = useFileTabUiStore.subscribe((s) =>
      changes.push(s.autoSaveEnabled),
    );

    useFileTabUiStore.getState().setAutoSaveEnabled(true);
    useFileTabUiStore.getState().setAutoSaveEnabled(true); // no-op
    useFileTabUiStore.getState().setAutoSaveEnabled(false);
    unsub();

    expect(useFileTabUiStore.getState().autoSaveEnabled).toBe(false);
    // The no-op call did not emit a change.
    expect(changes).toEqual([true, false]);
  });
});

describe('useFileTabUiStore pending unsaved-close modal', () => {
  it('stores and clears the pending close identity (including fileKey)', () => {
    const { useFileTabUiStore } = loadStore();
    const pending = {
      tabId: 'file-1',
      fileKey: 'p:w:repo-1:src/a.ts',
      projectId: 'p',
      worktreeId: 'w',
      title: 'a.ts',
      filePath: '/abs/src/a.ts',
    };

    useFileTabUiStore.getState().requestUnsavedClose(pending);
    expect(useFileTabUiStore.getState().pendingUnsavedClose).toEqual(pending);

    useFileTabUiStore.getState().clearPendingUnsavedClose();
    expect(useFileTabUiStore.getState().pendingUnsavedClose).toBeNull();
  });
});

describe('embedded file-tree visibility', () => {
  it('defaults hidden for file-bearing tabs (any external open) and expanded for empty tabs', () => {
    const { resolveFileTreeVisible } = loadStore();

    // A tab opened directly with a file (explorer, Cmd+P, show_files,
    // markdown links, restored tabs) has no override → tree hidden.
    expect(resolveFileTreeVisible({}, 'file-1', false)).toBe(false);
    // A newly created empty file tab defaults to the expanded tree.
    expect(resolveFileTreeVisible({}, 'file-2', true)).toBe(true);
    // Explicit user toggles win in both directions.
    expect(resolveFileTreeVisible({ 'file-1': true }, 'file-1', false)).toBe(
      true,
    );
    expect(resolveFileTreeVisible({ 'file-2': false }, 'file-2', true)).toBe(
      false,
    );
  });

  it('stores per-tab overrides idempotently', () => {
    const { useFileTabUiStore } = loadStore();

    useFileTabUiStore.getState().setFileTreeVisible('file-1', true);
    expect(useFileTabUiStore.getState().fileTreeVisibleByTabId).toEqual({
      'file-1': true,
    });

    const before = useFileTabUiStore.getState().fileTreeVisibleByTabId;
    useFileTabUiStore.getState().setFileTreeVisible('file-1', true);
    expect(useFileTabUiStore.getState().fileTreeVisibleByTabId).toBe(before);

    useFileTabUiStore.getState().setFileTreeVisible('file-1', false);
    expect(useFileTabUiStore.getState().fileTreeVisibleByTabId).toEqual({
      'file-1': false,
    });
  });

  it('records the file path whose initial tree reveal has run idempotently', () => {
    const { useFileTabUiStore } = loadStore();

    useFileTabUiStore
      .getState()
      .markFileTreeRevealed('file-1', '/repo/src/index.ts');
    expect(useFileTabUiStore.getState().fileTreeRevealedPathByTabId).toEqual({
      'file-1': '/repo/src/index.ts',
    });

    const before = useFileTabUiStore.getState().fileTreeRevealedPathByTabId;
    useFileTabUiStore
      .getState()
      .markFileTreeRevealed('file-1', '/repo/src/index.ts');
    expect(useFileTabUiStore.getState().fileTreeRevealedPathByTabId).toBe(
      before,
    );

    useFileTabUiStore
      .getState()
      .markFileTreeRevealed('file-1', '/repo/tests/index.ts');
    expect(useFileTabUiStore.getState().fileTreeRevealedPathByTabId).toEqual({
      'file-1': '/repo/tests/index.ts',
    });
  });

  it('opens an empty tab tree with a directory queued for reveal', () => {
    const { useFileTabUiStore } = loadStore();

    useFileTabUiStore
      .getState()
      .openDirectoryInFileTree('file-1', '/repo/evaluations');

    expect(useFileTabUiStore.getState().fileTreeVisibleByTabId).toEqual({
      'file-1': true,
    });
    expect(useFileTabUiStore.getState().fileTreeDirectoryPathByTabId).toEqual({
      'file-1': '/repo/evaluations',
    });
  });
});

it('initializes each tree once from its opening mode and preserves an independent user choice', () => {
  const { useFileTabUiStore, resolveFileTreeVisible } = loadStore();
  useFileTabUiStore.getState().initializeFileTreeMode('diff-file', 'diff');
  useFileTabUiStore.getState().initializeFileTreeMode('normal-file', 'file');
  useFileTabUiStore.getState().initializeFileTreeMode('normal-file', 'diff');
  expect(useFileTabUiStore.getState().fileTreeModeByTabId).toEqual({
    'diff-file': 'diff',
    'normal-file': 'file',
  });
  useFileTabUiStore.getState().setFileTreeMode('diff-file', 'file');
  useFileTabUiStore.getState().initializeFileTreeMode('diff-file', 'diff');
  expect(useFileTabUiStore.getState().fileTreeModeByTabId['diff-file']).toBe(
    'file',
  );
  expect(resolveFileTreeVisible({}, 'diff-file', false)).toBe(false);
});
