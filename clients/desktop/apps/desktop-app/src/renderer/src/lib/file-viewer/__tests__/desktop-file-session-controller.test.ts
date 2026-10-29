import type {
  CanopyCapabilities,
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import type { PortalFilePreview } from '@canopy/protocol/portal';
import {
  createFileViewerStore,
  fileViewerKey,
  type FileViewerState,
} from '@canopy/app-state';
import type { StoreApi } from 'zustand';
import {
  AUTO_SAVE_DEBOUNCE_MS,
  createDesktopFileSessionController,
  type DesktopFileSessionController,
} from '../desktop-file-session-controller';

const DESKTOP_CAPS: CanopyCapabilities = {
  localExecution: true,
  terminalPty: true,
  fileSystemAccess: 'read-write',
  voice: false,
  settingsScope: 'full',
  pipelines: 'execute',
  routing: 'in-memory',
  overviewNotifications: true,
};

type CommandResponders = {
  [K in CommandName]?: (
    args: CommandMap[K]['args'],
  ) => Promise<CommandMap[K]['result']>;
};

interface Harness {
  store: StoreApi<FileViewerState>;
  controller: DesktopFileSessionController;
  commandResponders: CommandResponders;
  saveCommands: Array<CommandMap['file.save']['args']>;
  savesCommitted: Array<{ projectId: string; worktreeId: string }>;
  detach: () => void;
}

function preview(
  overrides: Partial<PortalFilePreview> = {},
): PortalFilePreview {
  return {
    workspaceLocalId: 'p',
    worktreeLocalId: 'w',
    fileRootLocalId: 'repo-1',
    path: 'src/a.ts',
    content: 'disk',
    size: 4,
    version: 'v1',
    truncated: false,
    modifiedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

const REQUEST = {
  projectId: 'p',
  worktreeId: 'w',
  fileRootLocalId: 'repo-1',
  relativePath: 'src/a.ts',
};

function createHarness(): Harness {
  const commandResponders: CommandResponders = {};
  const saveCommands: Array<CommandMap['file.save']['args']> = [];
  const client: CanopyClient = {
    capabilities: DESKTOP_CAPS,
    query<K extends QueryName>(name: K): Promise<QueryMap[K]['result']> {
      if (name === 'file.read') {
        return Promise.resolve(preview() as QueryMap[K]['result']);
      }
      return Promise.reject(new Error(`no query responder for ${name}`));
    },
    command<K extends CommandName>(
      name: K,
      args: CommandMap[K]['args'],
    ): Promise<CommandMap[K]['result']> {
      if (name === 'file.save') {
        saveCommands.push(args as CommandMap['file.save']['args']);
      }
      const responder = commandResponders[name];
      if (!responder) {
        return Promise.reject(new Error(`no command responder for ${name}`));
      }
      return responder(args);
    },
    subscribe(): Unsubscribe {
      return (): void => {};
    },
  };
  const store = createFileViewerStore(client);
  const controller = createDesktopFileSessionController();
  const savesCommitted: Array<{ projectId: string; worktreeId: string }> = [];
  const detach = controller.attachStore(store, {
    onSaveCommitted: (request): void => {
      savesCommitted.push({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
      });
    },
  });
  return {
    store,
    controller,
    commandResponders,
    saveCommands,
    savesCommitted,
    detach,
  };
}

async function openAndEdit(
  h: Harness,
  tabId: string,
  request = REQUEST,
  content = 'edited',
): Promise<string> {
  const key = h.controller.registerTab(tabId, request);
  await h.store.getState().openFile(request);
  h.store.getState().updateContent(key, content);
  return key;
}

describe('desktopFileSessionController: registry and identity', () => {
  it('computes the canonical key and exposes session accessors', async () => {
    const h = createHarness();
    const key = await openAndEdit(h, 'tab-1');

    expect(key).toBe(fileViewerKey(REQUEST));
    expect(h.controller.getFileKey('tab-1')).toBe(key);
    expect(h.controller.matches('tab-1', key)).toBe(true);
    expect(h.controller.hasSession('tab-1')).toBe(true);
    expect(h.controller.isDirty('tab-1')).toBe(true);
    expect(h.controller.getSession('tab-1')?.content).toBe('edited');
    h.detach();
  });

  it('is idempotent for repeat registration of the same tab/request', () => {
    const h = createHarness();
    const revBefore = h.controller.getRevision();
    const k1 = h.controller.registerTab('tab-1', REQUEST);
    const k2 = h.controller.registerTab('tab-1', REQUEST);
    expect(k1).toBe(k2);
    // Two registrations, but only one reference for the key.
    h.controller.releaseTab('tab-1');
    expect(h.controller.getFileKey('tab-1')).toBeNull();
    expect(h.controller.getRevision()).toBeGreaterThan(revBefore);
    h.detach();
  });

  it('atomically replaces a changed tab registration and releases the old session', async () => {
    const h = createHarness();
    const oldKey = h.controller.registerTab('tab-1', REQUEST);
    await h.store.getState().openFile(REQUEST);
    const replacement = {
      ...REQUEST,
      fileRootLocalId: 'repo-2',
      relativePath: 'src/b.ts',
    };

    const newKey = h.controller.registerTab('tab-1', replacement);

    expect(newKey).not.toBe(oldKey);
    expect(h.controller.getFileKey('tab-1')).toBe(newKey);
    expect(h.controller.matches('tab-1', oldKey)).toBe(false);
    expect(h.store.getState().files[oldKey]).toBeUndefined();
    h.detach();
  });

  it('keeps identical relative paths under different roots on distinct keys', async () => {
    const h = createHarness();
    const keyA = await openAndEdit(
      h,
      'tab-A',
      { ...REQUEST, fileRootLocalId: 'root-A' },
      'A edit',
    );
    const keyB = await openAndEdit(
      h,
      'tab-B',
      { ...REQUEST, fileRootLocalId: 'root-B' },
      'B edit',
    );

    expect(keyA).not.toBe(keyB);
    expect(h.controller.isDirty('tab-A')).toBe(true);
    expect(h.controller.isDirty('tab-B')).toBe(true);
    // Independent sessions.
    h.store.getState().discardEdits(keyA);
    expect(h.controller.isDirty('tab-A')).toBe(false);
    expect(h.controller.isDirty('tab-B')).toBe(true);
    h.detach();
  });

  it('missing registration makes saveTab/isDirty inert and discard/release safe', async () => {
    const h = createHarness();
    await expect(h.controller.saveTab('nope')).resolves.toBe(false);
    expect(h.controller.isDirty('nope')).toBe(false);
    expect(h.controller.hasSession('nope')).toBe(false);
    expect(() => h.controller.discardTab('nope')).not.toThrow();
    expect(() => h.controller.releaseTab('nope')).not.toThrow();
    h.detach();
  });

  it('notifies subscribers on registration and session change', async () => {
    const h = createHarness();
    const listener = jest.fn();
    const unsub = h.controller.subscribe(listener);
    h.controller.registerTab('tab-1', REQUEST);
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    await h.store.getState().openFile(REQUEST);
    h.store.getState().updateContent(fileViewerKey(REQUEST), 'x');
    expect(listener).toHaveBeenCalled();
    unsub();
    h.detach();
  });
});

describe('desktopFileSessionController: saves and diff refresh', () => {
  it('routes a save through the shared transaction and fires onSaveCommitted once', async () => {
    const h = createHarness();
    h.commandResponders['file.save'] = (): Promise<PortalFilePreview> =>
      Promise.resolve(preview({ content: 'edited', version: 'v2' }));
    await openAndEdit(h, 'tab-1');

    const ok = await h.controller.saveTab('tab-1');

    expect(ok).toBe(true);
    expect(h.saveCommands).toHaveLength(1);
    expect(h.saveCommands[0]).toMatchObject({
      expectedModifiedAtMs: Date.parse('2026-07-01T00:00:00.000Z'),
    });
    expect(h.controller.isDirty('tab-1')).toBe(false);
    expect(h.savesCommitted).toEqual([{ projectId: 'p', worktreeId: 'w' }]);
    h.detach();
  });

  it('collapses concurrent saves onto one command', async () => {
    const h = createHarness();
    let resolveSave: (value: PortalFilePreview) => void = () => undefined;
    h.commandResponders['file.save'] = (): Promise<PortalFilePreview> =>
      new Promise((resolve) => {
        resolveSave = resolve;
      });
    await openAndEdit(h, 'tab-1');

    const a = h.controller.saveTab('tab-1');
    const b = h.controller.saveTab('tab-1');
    resolveSave(preview({ content: 'edited', version: 'v2' }));
    await Promise.all([a, b]);

    expect(h.saveCommands).toHaveLength(1);
    expect(h.savesCommitted).toHaveLength(1);
    h.detach();
  });

  it('keeps the tab dirty and does not loop when a save fails', async () => {
    const h = createHarness();
    h.commandResponders['file.save'] = (): Promise<PortalFilePreview> =>
      Promise.reject(new Error('File changed on disk since it was loaded.'));
    await openAndEdit(h, 'tab-1');

    const ok = await h.controller.saveTab('tab-1');

    expect(ok).toBe(false);
    expect(h.saveCommands).toHaveLength(1);
    expect(h.controller.isDirty('tab-1')).toBe(true);
    expect(h.controller.getSession('tab-1')?.error).toBe(
      'File changed on disk since it was loaded.',
    );
    expect(h.savesCommitted).toHaveLength(0);
    h.detach();
  });
});

describe('desktopFileSessionController: autosave', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('debounces a single autosave after an edit', async () => {
    const h = createHarness();
    h.commandResponders['file.save'] = (): Promise<PortalFilePreview> =>
      Promise.resolve(preview({ content: 'edited', version: 'v2' }));
    h.controller.setAutoSaveEnabled(true);
    await openAndEdit(h, 'tab-1');

    expect(h.saveCommands).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_MS);

    expect(h.saveCommands).toHaveLength(1);
    expect(h.controller.isDirty('tab-1')).toBe(false);
    h.detach();
  });

  it('cancels the queued autosave when Auto Save is disabled', async () => {
    const h = createHarness();
    h.commandResponders['file.save'] = (): Promise<PortalFilePreview> =>
      Promise.resolve(preview({ content: 'edited', version: 'v2' }));
    h.controller.setAutoSaveEnabled(true);
    await openAndEdit(h, 'tab-1');

    h.controller.setAutoSaveEnabled(false);
    await jest.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_MS * 2);

    expect(h.saveCommands).toHaveLength(0);
    expect(h.controller.isDirty('tab-1')).toBe(true);
    h.detach();
  });

  it('saves a newer edit after the active autosave completes', async () => {
    const h = createHarness();
    const resolvers: Array<(value: PortalFilePreview) => void> = [];
    h.commandResponders['file.save'] = (): Promise<PortalFilePreview> =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      });
    h.controller.setAutoSaveEnabled(true);
    const key = await openAndEdit(h, 'tab-1', REQUEST, 'first edit');

    await jest.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_MS);
    expect(h.saveCommands).toHaveLength(1);
    h.store.getState().updateContent(key, 'second edit');
    resolvers[0](preview({ content: 'first edit', version: 'v2' }));
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_MS);
    expect(h.saveCommands).toHaveLength(2);
    expect(h.saveCommands[1]?.content).toBe('second edit');
    resolvers[1](preview({ content: 'second edit', version: 'v3' }));
    await Promise.resolve();

    expect(h.controller.isDirty('tab-1')).toBe(false);
    h.detach();
  });

  it('disabling Auto Save during an active write lets it finish without a follow-up', async () => {
    const h = createHarness();
    let resolveSave: (value: PortalFilePreview) => void = () => undefined;
    h.commandResponders['file.save'] = (): Promise<PortalFilePreview> =>
      new Promise((resolve) => {
        resolveSave = resolve;
      });
    h.controller.setAutoSaveEnabled(true);
    const key = await openAndEdit(h, 'tab-1', REQUEST, 'first edit');

    await jest.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_MS);
    expect(h.saveCommands).toHaveLength(1);
    h.controller.setAutoSaveEnabled(false);
    h.store.getState().updateContent(key, 'second edit');
    resolveSave(preview({ content: 'first edit', version: 'v2' }));
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_MS * 2);

    expect(h.saveCommands).toHaveLength(1);
    expect(h.controller.isDirty('tab-1')).toBe(true);
    expect(h.controller.getSession('tab-1')?.content).toBe('second edit');
    h.detach();
  });

  it('reverting to baseline cancels the queued autosave', async () => {
    const h = createHarness();
    h.commandResponders['file.save'] = (): Promise<PortalFilePreview> =>
      Promise.resolve(preview());
    h.controller.setAutoSaveEnabled(true);
    const key = await openAndEdit(h, 'tab-1');

    h.store.getState().updateContent(key, 'disk'); // back to baseline
    await jest.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_MS * 2);

    expect(h.saveCommands).toHaveLength(0);
    h.detach();
  });

  it('a failed autosave does not schedule an infinite retry loop', async () => {
    const h = createHarness();
    h.commandResponders['file.save'] = (): Promise<PortalFilePreview> =>
      Promise.reject(new Error('nope'));
    h.controller.setAutoSaveEnabled(true);
    await openAndEdit(h, 'tab-1');

    await jest.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_MS);
    expect(h.saveCommands).toHaveLength(1);
    // No further edits/toggles → no further autosaves.
    await jest.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_MS * 5);
    expect(h.saveCommands).toHaveLength(1);
    h.detach();
  });

  it('enabling Auto Save schedules already-dirty registered sessions', async () => {
    const h = createHarness();
    h.commandResponders['file.save'] = (): Promise<PortalFilePreview> =>
      Promise.resolve(preview({ content: 'edited', version: 'v2' }));
    await openAndEdit(h, 'tab-1'); // dirty, but autosave off

    await jest.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_MS);
    expect(h.saveCommands).toHaveLength(0);

    h.controller.setAutoSaveEnabled(true);
    await jest.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_MS);
    expect(h.saveCommands).toHaveLength(1);
    h.detach();
  });
});

describe('desktopFileSessionController: reference counting and cleanup', () => {
  it('drops the shared session and cancels autosave only on the last release', async () => {
    jest.useFakeTimers();
    const h = createHarness();
    h.commandResponders['file.save'] = (): Promise<PortalFilePreview> =>
      Promise.resolve(preview({ content: 'edited', version: 'v2' }));
    h.controller.setAutoSaveEnabled(true);

    const key = h.controller.registerTab('tab-A', REQUEST);
    h.controller.registerTab('tab-B', REQUEST); // same canonical key
    await h.store.getState().openFile(REQUEST);
    h.store.getState().updateContent(key, 'edited'); // dirty → schedules timer

    // Release ONE of the two tabs while the shared session is still dirty: the
    // session and its autosave timer must survive because tab-B still holds it.
    h.controller.releaseTab('tab-A');
    expect(h.store.getState().files[key]).toBeDefined();

    await jest.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_MS);
    // The remaining tab's autosave still fired.
    expect(h.saveCommands).toHaveLength(1);
    expect(h.store.getState().files[key]?.dirty).toBe(false);

    // Releasing the LAST reference drops the shared session (reopen reads disk).
    h.controller.releaseTab('tab-B');
    expect(h.store.getState().files[key]).toBeUndefined();

    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    h.detach();
  });

  it('dispose cancels timers and subscriptions', async () => {
    jest.useFakeTimers();
    const h = createHarness();
    h.commandResponders['file.save'] = (): Promise<PortalFilePreview> =>
      Promise.resolve(preview({ content: 'edited', version: 'v2' }));
    h.controller.setAutoSaveEnabled(true);
    await openAndEdit(h, 'tab-1');

    h.controller.dispose();
    await jest.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_MS * 2);
    expect(h.saveCommands).toHaveLength(0);
    expect(h.controller.getFileKey('tab-1')).toBeNull();

    jest.useRealTimers();
  });
});
