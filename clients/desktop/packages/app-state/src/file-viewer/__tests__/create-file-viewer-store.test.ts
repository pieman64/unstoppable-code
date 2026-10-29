import type {
  CanopyCapabilities,
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import type {
  PortalDiffPayload,
  PortalFilePreview,
} from '@canopy/protocol/portal';
import {
  createFileViewerStore,
  fileViewerKey,
  diffViewerKey,
} from '../create-file-viewer-store';

type QueryResponders = {
  [K in QueryName]?: (
    args: QueryMap[K]['args'],
  ) => Promise<QueryMap[K]['result']>;
};
type CommandResponders = {
  [K in CommandName]?: (
    args: CommandMap[K]['args'],
  ) => Promise<CommandMap[K]['result']>;
};

interface RecordedCommand {
  name: CommandName;
  args: unknown;
}

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

const WEB_CAPS: CanopyCapabilities = {
  ...DESKTOP_CAPS,
  fileSystemAccess: 'read',
  routing: 'url',
};

interface MockClient {
  client: CanopyClient;
  queryResponders: QueryResponders;
  commandResponders: CommandResponders;
  commandCalls: RecordedCommand[];
}

function createMockClient(
  capabilities: CanopyCapabilities,
  capabilitiesFor?: (localId: string) => CanopyCapabilities,
): MockClient {
  const queryResponders: QueryResponders = {};
  const commandResponders: CommandResponders = {};
  const commandCalls: RecordedCommand[] = [];

  const client: CanopyClient = {
    capabilities,
    ...(capabilitiesFor === undefined ? {} : { capabilitiesFor }),
    query<K extends QueryName>(
      name: K,
      args: QueryMap[K]['args'],
    ): Promise<QueryMap[K]['result']> {
      const responder = queryResponders[name];
      if (!responder) {
        return Promise.reject(new Error(`no query responder for ${name}`));
      }
      return responder(args);
    },
    command<K extends CommandName>(
      name: K,
      args: CommandMap[K]['args'],
    ): Promise<CommandMap[K]['result']> {
      commandCalls.push({ name, args });
      const responder = commandResponders[name];
      if (!responder) {
        return Promise.reject(new Error(`no command responder for ${name}`));
      }
      return responder(args);
    },
    subscribe(): Unsubscribe {
      // No events are exercised by the file-viewer store tests.
      return (): void => {};
    },
  };

  return { client, queryResponders, commandResponders, commandCalls };
}

function preview(
  overrides: Partial<PortalFilePreview> = {},
): PortalFilePreview {
  return {
    workspaceLocalId: 'ws1',
    worktreeLocalId: 'wt1',
    path: 'src/a.ts',
    content: 'export const a = 1;\n',
    size: 20,
    version: 'v1',
    truncated: false,
    modifiedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A promise whose resolution the test controls, for in-flight-race coverage. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn: (value: T) => void = (): void => {};
  const promise = new Promise<T>((r): void => {
    resolveFn = r;
  });
  return { promise, resolve: resolveFn };
}

const READ_REQUEST = {
  projectId: 'p1',
  worktreeId: 'wt1',
  relativePath: 'src/a.ts',
};

const DIFF_REQUEST = {
  workspaceId: 'ws1',
  worktreeId: 'wt1',
  path: 'src/a.ts',
  source: 'uncommitted' as const,
};

describe('file-viewer keys', () => {
  it('composes multi-repo-safe file keys', () => {
    expect(fileViewerKey(READ_REQUEST)).toBe('p1:wt1::src/a.ts');
    expect(fileViewerKey({ ...READ_REQUEST, repoId: 'repoA' })).toBe(
      'p1:wt1:repoA:src/a.ts',
    );
  });

  it('keys a both-set request on fileRootLocalId (protocol precedence)', () => {
    expect(
      fileViewerKey({
        ...READ_REQUEST,
        repoId: 'repoA',
        fileRootLocalId: 'rootB',
      }),
    ).toBe('p1:wt1:rootB:src/a.ts');
  });

  it('composes diff keys with source fallback', () => {
    expect(diffViewerKey(DIFF_REQUEST)).toBe('ws1:wt1::src/a.ts:uncommitted');
    expect(diffViewerKey({ ...DIFF_REQUEST, repoId: 'repoA' })).toBe(
      'ws1:wt1:repoA:src/a.ts:uncommitted',
    );
    expect(diffViewerKey({ workspaceId: 'ws1', worktreeId: 'wt1' })).toBe(
      'ws1:wt1:::combined',
    );
  });
});

describe('createFileViewerStore', () => {
  it('derives canEdit from fileSystemAccess', () => {
    expect(
      createFileViewerStore(createMockClient(DESKTOP_CAPS).client).getState()
        .canEdit,
    ).toBe(true);
    expect(
      createFileViewerStore(createMockClient(WEB_CAPS).client).getState()
        .canEdit,
    ).toBe(false);
  });

  it('opens a file into an idle, non-dirty session and marks it active', async () => {
    const mock = createMockClient(DESKTOP_CAPS);
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> =>
      Promise.resolve(preview());
    const store = createFileViewerStore(mock.client);

    const key = await store.getState().openFile(READ_REQUEST);

    const session = store.getState().files[key];
    expect(session.status).toBe('idle');
    expect(session.content).toBe('export const a = 1;\n');
    expect(session.dirty).toBe(false);
    expect(session.viewMode).toBe('preview');
    expect(store.getState().activeFileKey).toBe(key);
  });

  it('stores edit capability per opened project while retaining the desktop fallback', async () => {
    let cloudCapabilities = WEB_CAPS;
    const mock = createMockClient(DESKTOP_CAPS, (projectId) =>
      projectId === 'cloud-project' ? cloudCapabilities : DESKTOP_CAPS,
    );
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> =>
      Promise.resolve(preview());
    const store = createFileViewerStore(mock.client);

    const desktopKey = await store.getState().openFile(READ_REQUEST);
    const cloudKey = await store.getState().openFile({
      ...READ_REQUEST,
      projectId: 'cloud-project',
    });

    expect(store.getState().canEdit).toBe(true);
    expect(store.getState().files[desktopKey]?.canEdit).toBe(true);
    expect(store.getState().files[cloudKey]?.canEdit).toBe(false);

    cloudCapabilities = DESKTOP_CAPS;
    await store.getState().openFile({
      ...READ_REQUEST,
      projectId: 'cloud-project',
    });
    expect(store.getState().files[cloudKey]?.canEdit).toBe(true);
  });

  it('downgrades a dirty session capability before the focus-only reopen returns', async () => {
    let capabilities = DESKTOP_CAPS;
    const mock = createMockClient(DESKTOP_CAPS, () => capabilities);
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> =>
      Promise.resolve(preview());
    const store = createFileViewerStore(mock.client);
    const key = await store.getState().openFile(READ_REQUEST);
    store.getState().updateContent(key, 'unsaved');

    capabilities = WEB_CAPS;
    await store.getState().openFile(READ_REQUEST);

    expect(store.getState().files[key]?.dirty).toBe(true);
    expect(store.getState().files[key]?.canEdit).toBe(false);
  });

  it('records an error status when the read rejects', async () => {
    const mock = createMockClient(DESKTOP_CAPS);
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> =>
      Promise.reject(new Error('boom'));
    const store = createFileViewerStore(mock.client);

    const key = await store.getState().openFile(READ_REQUEST);
    const session = store.getState().files[key];
    expect(session.status).toBe('error');
    expect(session.error).toBe('boom');
  });

  it('tracks dirty state on edits', async () => {
    const mock = createMockClient(DESKTOP_CAPS);
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> =>
      Promise.resolve(preview());
    const store = createFileViewerStore(mock.client);
    const key = await store.getState().openFile(READ_REQUEST);

    store.getState().updateContent(key, 'edited');
    expect(store.getState().files[key].dirty).toBe(true);

    // Back to the saved content → no longer dirty.
    store.getState().updateContent(key, 'export const a = 1;\n');
    expect(store.getState().files[key].dirty).toBe(false);
  });

  it('round-trips the opaque preview version while saving the buffer', async () => {
    const mock = createMockClient(DESKTOP_CAPS);
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> =>
      Promise.resolve(preview());
    mock.commandResponders['file.save'] = (): Promise<PortalFilePreview> =>
      Promise.resolve(
        preview({
          content: 'edited',
          version: 'v2',
          modifiedAt: '2026-07-01T00:01:00.000Z',
        }),
      );
    const store = createFileViewerStore(mock.client);
    const key = await store.getState().openFile(READ_REQUEST);

    store.getState().updateContent(key, 'edited');
    const ok = await store.getState().saveFile(key);

    expect(ok).toBe(true);
    const call = mock.commandCalls.find((c) => c.name === 'file.save');
    expect(call?.args).toMatchObject({
      projectId: 'p1',
      relativePath: 'src/a.ts',
      content: 'edited',
      expectedVersion: 'v1',
      expectedModifiedAtMs: Date.parse('2026-07-01T00:00:00.000Z'),
    });
    const session = store.getState().files[key];
    expect(session.dirty).toBe(false);
    expect(session.preview?.version).toBe('v2');
    expect(session.content).toBe('edited');
  });

  it('refuses to save on a read-only host without issuing a command', async () => {
    const mock = createMockClient(WEB_CAPS);
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> =>
      Promise.resolve(preview());
    const store = createFileViewerStore(mock.client);
    const key = await store.getState().openFile(READ_REQUEST);
    store.getState().updateContent(key, 'edited');

    const ok = await store.getState().saveFile(key);

    expect(ok).toBe(false);
    expect(
      mock.commandCalls.filter((c) => c.name === 'file.save'),
    ).toHaveLength(0);
    expect(store.getState().files[key].status).toBe('error');
  });

  it('discards edits back to the saved content', async () => {
    const mock = createMockClient(DESKTOP_CAPS);
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> =>
      Promise.resolve(preview());
    const store = createFileViewerStore(mock.client);
    const key = await store.getState().openFile(READ_REQUEST);

    store.getState().updateContent(key, 'edited');
    store.getState().discardEdits(key);
    const session = store.getState().files[key];
    expect(session.content).toBe('export const a = 1;\n');
    expect(session.dirty).toBe(false);
  });

  it('switches view mode and closes files', async () => {
    const mock = createMockClient(DESKTOP_CAPS);
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> =>
      Promise.resolve(preview());
    const store = createFileViewerStore(mock.client);
    const key = await store.getState().openFile(READ_REQUEST);

    // Switch away from the default ('preview') so the assertion proves the
    // setter actually changed the session rather than matching the default.
    store.getState().setViewMode(key, 'raw');
    expect(store.getState().files[key].viewMode).toBe('raw');

    store.getState().closeFile(key);
    expect(store.getState().files[key]).toBeUndefined();
    expect(store.getState().activeFileKey).toBeNull();
  });

  it('opens a diff into an idle session and closes it', async () => {
    const mock = createMockClient(DESKTOP_CAPS);
    const diff: PortalDiffPayload = {
      workspaceLocalId: 'ws1',
      worktreeLocalId: 'wt1',
      filePath: 'src/a.ts',
      files: [
        { filePath: 'src/a.ts', status: 'M', insertions: 1, deletions: 0 },
      ],
      patch: '@@ -1 +1 @@',
      rangeLabel: 'abc..WORKTREE',
    };
    mock.queryResponders['diff.read'] = (): Promise<PortalDiffPayload> =>
      Promise.resolve(diff);
    const store = createFileViewerStore(mock.client);

    const key = await store.getState().openDiff(DIFF_REQUEST);
    const session = store.getState().diffs[key];
    expect(session.status).toBe('idle');
    expect(session.diff?.patch).toBe('@@ -1 +1 @@');
    expect(store.getState().activeDiffKey).toBe(key);

    store.getState().closeDiff(key);
    expect(store.getState().diffs[key]).toBeUndefined();
    expect(store.getState().activeDiffKey).toBeNull();
  });

  it('re-opening a dirty session preserves the buffer and does not re-read', async () => {
    const mock = createMockClient(DESKTOP_CAPS);
    let reads = 0;
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> => {
      reads += 1;
      return Promise.resolve(preview());
    };
    const store = createFileViewerStore(mock.client);
    const key = await store.getState().openFile(READ_REQUEST);
    store.getState().updateContent(key, 'my edits');

    await store.getState().openFile(READ_REQUEST);

    expect(reads).toBe(1);
    const session = store.getState().files[key];
    expect(session.content).toBe('my edits');
    expect(session.dirty).toBe(true);
  });

  it('re-opening a loading session focuses it without starting another read', async () => {
    const mock = createMockClient(DESKTOP_CAPS);
    const gate = deferred<PortalFilePreview>();
    let reads = 0;
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> => {
      reads += 1;
      return gate.promise;
    };
    const store = createFileViewerStore(mock.client);

    const firstOpen = store.getState().openFile(READ_REQUEST);
    const secondOpen = store.getState().openFile(READ_REQUEST);

    expect(reads).toBe(1);
    expect(await secondOpen).toBe(fileViewerKey(READ_REQUEST));
    expect(store.getState().activeFileKey).toBe(fileViewerKey(READ_REQUEST));

    gate.resolve(preview());
    await firstOpen;
    expect(store.getState().files[fileViewerKey(READ_REQUEST)].status).toBe(
      'idle',
    );
  });

  it('keeps edits made during an in-flight save', async () => {
    const mock = createMockClient(DESKTOP_CAPS);
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> =>
      Promise.resolve(preview());
    const gate = deferred<PortalFilePreview>();
    mock.commandResponders['file.save'] = (): Promise<PortalFilePreview> =>
      gate.promise;
    const store = createFileViewerStore(mock.client);
    const key = await store.getState().openFile(READ_REQUEST);

    store.getState().updateContent(key, 'v1 edit');
    const savePromise = store.getState().saveFile(key);
    // User keeps typing while the save is in flight.
    store.getState().updateContent(key, 'v2 edit while saving');
    gate.resolve(preview({ content: 'v1 edit', version: 'v2' }));
    const ok = await savePromise;

    expect(ok).toBe(true);
    const session = store.getState().files[key];
    expect(session.content).toBe('v2 edit while saving');
    expect(session.dirty).toBe(true);
    expect(session.preview?.version).toBe('v2');
  });

  it('fails closed (no command) when the preview mtime is unparseable', async () => {
    const mock = createMockClient(DESKTOP_CAPS);
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> =>
      Promise.resolve(preview({ modifiedAt: 'not-a-date' }));
    mock.commandResponders['file.save'] = (): Promise<PortalFilePreview> =>
      Promise.resolve(preview());
    const store = createFileViewerStore(mock.client);
    const key = await store.getState().openFile(READ_REQUEST);
    store.getState().updateContent(key, 'x');

    const ok = await store.getState().saveFile(key);

    expect(ok).toBe(false);
    expect(
      mock.commandCalls.filter((c) => c.name === 'file.save'),
    ).toHaveLength(0);
    const session = store.getState().files[key];
    expect(session.status).toBe('error');
    expect(session.error).toBe(
      'Unable to save because the file version is unavailable. Reopen the file and try again.',
    );
    // The edit is retained, still dirty, so a reopen-then-save can recover it.
    expect(session.content).toBe('x');
    expect(session.dirty).toBe(true);
  });

  it('treats saving a clean session as an idempotent no-op', async () => {
    const mock = createMockClient(DESKTOP_CAPS);
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> =>
      Promise.resolve(preview());
    const store = createFileViewerStore(mock.client);
    const key = await store.getState().openFile(READ_REQUEST);

    const ok = await store.getState().saveFile(key);

    expect(ok).toBe(true);
    expect(
      mock.commandCalls.filter((c) => c.name === 'file.save'),
    ).toHaveLength(0);
    expect(store.getState().files[key].status).toBe('idle');
  });

  it('collapses concurrent saves onto a single command', async () => {
    const mock = createMockClient(DESKTOP_CAPS);
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> =>
      Promise.resolve(preview());
    const gate = deferred<PortalFilePreview>();
    mock.commandResponders['file.save'] = (): Promise<PortalFilePreview> =>
      gate.promise;
    const store = createFileViewerStore(mock.client);
    const key = await store.getState().openFile(READ_REQUEST);
    store.getState().updateContent(key, 'edited');

    const a = store.getState().saveFile(key);
    const b = store.getState().saveFile(key);
    gate.resolve(preview({ content: 'edited', version: 'v2' }));
    const [okA, okB] = await Promise.all([a, b]);

    expect(okA).toBe(true);
    expect(okB).toBe(true);
    expect(
      mock.commandCalls.filter((c) => c.name === 'file.save'),
    ).toHaveLength(1);
    expect(store.getState().files[key].dirty).toBe(false);
  });

  it('issues exactly one follow-up when a later explicit save runs during the first', async () => {
    const mock = createMockClient(DESKTOP_CAPS);
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> =>
      Promise.resolve(preview());
    const gates = [
      deferred<PortalFilePreview>(),
      deferred<PortalFilePreview>(),
    ];
    let call = 0;
    mock.commandResponders['file.save'] = (): Promise<PortalFilePreview> => {
      const gate = gates[call];
      call += 1;
      return gate.promise;
    };
    const store = createFileViewerStore(mock.client);
    const key = await store.getState().openFile(READ_REQUEST);

    store.getState().updateContent(key, 'first');
    const firstSave = store.getState().saveFile(key);
    // A newer explicit edit + save arrives while the first write is in flight.
    store.getState().updateContent(key, 'second');
    const secondSave = store.getState().saveFile(key);
    // First write lands (older content); buffer is still 'second' → follow-up.
    gates[0].resolve(preview({ content: 'first', version: 'v2' }));
    await firstSave;
    gates[1].resolve(preview({ content: 'second', version: 'v3' }));
    await secondSave;

    expect(
      mock.commandCalls.filter((c) => c.name === 'file.save'),
    ).toHaveLength(2);
    const session = store.getState().files[key];
    expect(session.content).toBe('second');
    expect(session.dirty).toBe(false);
    expect(session.preview?.version).toBe('v3');
  });

  it('retains content, preview, mtime, and dirty when a save fails', async () => {
    const mock = createMockClient(DESKTOP_CAPS);
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> =>
      Promise.resolve(preview());
    mock.commandResponders['file.save'] = (): Promise<PortalFilePreview> =>
      Promise.reject(new Error('File changed on disk since it was loaded.'));
    const store = createFileViewerStore(mock.client);
    const key = await store.getState().openFile(READ_REQUEST);
    store.getState().updateContent(key, 'edited');

    const ok = await store.getState().saveFile(key);

    expect(ok).toBe(false);
    const session = store.getState().files[key];
    expect(session.status).toBe('error');
    expect(session.error).toBe('File changed on disk since it was loaded.');
    expect(session.content).toBe('edited');
    expect(session.dirty).toBe(true);
    expect(session.preview?.version).toBe('v1');
    expect(session.preview?.modifiedAt).toBe('2026-07-01T00:00:00.000Z');

    // A retry must reuse the SAME confirmed mtime (no unversioned/advanced write).
    mock.commandResponders['file.save'] = (): Promise<PortalFilePreview> =>
      Promise.reject(new Error('File changed on disk since it was loaded.'));
    await store.getState().saveFile(key);
    const retry = mock.commandCalls.filter((c) => c.name === 'file.save');
    expect(retry).toHaveLength(2);
    expect(retry[1].args).toMatchObject({
      expectedModifiedAtMs: Date.parse('2026-07-01T00:00:00.000Z'),
    });
  });

  it('prevents a stale save completion from patching a reopened session', async () => {
    const mock = createMockClient(DESKTOP_CAPS);
    let read = 0;
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> => {
      read += 1;
      return Promise.resolve(
        preview({ content: read === 1 ? 'disk-v1' : 'disk-v2' }),
      );
    };
    const gate = deferred<PortalFilePreview>();
    mock.commandResponders['file.save'] = (): Promise<PortalFilePreview> =>
      gate.promise;
    const store = createFileViewerStore(mock.client);
    const key = await store.getState().openFile(READ_REQUEST);
    store.getState().updateContent(key, 'draft');
    const savePromise = store.getState().saveFile(key);

    // Close (discards) then reopen the same key while the save is in flight.
    store.getState().closeFile(key);
    await store.getState().openFile(READ_REQUEST);
    // The stale save now resolves — it must not touch the reopened session.
    gate.resolve(preview({ content: 'draft', version: 'v2' }));
    await savePromise;

    const session = store.getState().files[key];
    expect(session.content).toBe('disk-v2');
    expect(session.preview?.version).toBe('v1');
    expect(session.dirty).toBe(false);
  });

  it('prevents a stale read completion from patching a reopened session', async () => {
    const mock = createMockClient(DESKTOP_CAPS);
    const firstRead = deferred<PortalFilePreview>();
    const secondRead = deferred<PortalFilePreview>();
    let reads = 0;
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> => {
      reads += 1;
      return reads === 1 ? firstRead.promise : secondRead.promise;
    };
    const store = createFileViewerStore(mock.client);
    const key = fileViewerKey(READ_REQUEST);

    const staleOpen = store.getState().openFile(READ_REQUEST);
    store.getState().closeFile(key);
    const currentOpen = store.getState().openFile(READ_REQUEST);
    secondRead.resolve(preview({ content: 'current disk', version: 'v2' }));
    await currentOpen;
    firstRead.resolve(preview({ content: 'stale disk', version: 'v1' }));
    await staleOpen;

    expect(reads).toBe(2);
    expect(store.getState().files[key].content).toBe('current disk');
    expect(store.getState().files[key].preview?.version).toBe('v2');
  });

  it('does not let a re-read that started before a save overwrite the saved buffer', async () => {
    const mock = createMockClient(DESKTOP_CAPS);
    const reread = deferred<PortalFilePreview>();
    let reads = 0;
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> => {
      reads += 1;
      return reads === 1 ? Promise.resolve(preview()) : reread.promise;
    };
    mock.commandResponders['file.save'] = (args): Promise<PortalFilePreview> =>
      Promise.resolve(preview({ content: args.content, version: 'v2' }));
    const store = createFileViewerStore(mock.client);
    const key = await store.getState().openFile(READ_REQUEST);

    // Re-selecting the clean session starts a background re-read while the
    // previous content stays editable.
    const reopen = store.getState().openFile(READ_REQUEST);
    store.getState().updateContent(key, 'edited');
    expect(await store.getState().saveFile(key)).toBe(true);
    // The re-read started before the save and lands after it.
    reread.resolve(preview());
    await reopen;

    const session = store.getState().files[key];
    expect(reads).toBe(2);
    expect(session.content).toBe('edited');
    expect(session.preview?.version).toBe('v2');
    expect(session.dirty).toBe(false);
    expect(session.status).toBe('idle');
  });

  it('keeps an edit made while a re-read is in flight', async () => {
    const mock = createMockClient(DESKTOP_CAPS);
    const reread = deferred<PortalFilePreview>();
    let reads = 0;
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> => {
      reads += 1;
      return reads === 1 ? Promise.resolve(preview()) : reread.promise;
    };
    const store = createFileViewerStore(mock.client);
    const key = await store.getState().openFile(READ_REQUEST);

    const reopen = store.getState().openFile(READ_REQUEST);
    store.getState().updateContent(key, 'edited during re-read');
    reread.resolve(preview({ content: 'disk', version: 'v2' }));
    await reopen;

    const session = store.getState().files[key];
    expect(session.content).toBe('edited during re-read');
    expect(session.dirty).toBe(true);
    // The edit was made against the v1 baseline; keep it so a save still
    // detects a newer disk version instead of overwriting it.
    expect(session.preview?.version).toBe('v1');
    expect(session.status).toBe('idle');
  });

  it('keeps the saving status when a re-read lands mid-save', async () => {
    const mock = createMockClient(DESKTOP_CAPS);
    const reread = deferred<PortalFilePreview>();
    let reads = 0;
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> => {
      reads += 1;
      return reads === 1 ? Promise.resolve(preview()) : reread.promise;
    };
    const save = deferred<PortalFilePreview>();
    mock.commandResponders['file.save'] = (): Promise<PortalFilePreview> =>
      save.promise;
    const store = createFileViewerStore(mock.client);
    const key = await store.getState().openFile(READ_REQUEST);

    const reopen = store.getState().openFile(READ_REQUEST);
    store.getState().updateContent(key, 'edited');
    const saving = store.getState().saveFile(key);
    reread.resolve(preview());
    await reopen;
    expect(store.getState().files[key].status).toBe('saving');
    expect(store.getState().files[key].content).toBe('edited');

    save.resolve(preview({ content: 'edited', version: 'v2' }));
    expect(await saving).toBe(true);
    const session = store.getState().files[key];
    expect(session.content).toBe('edited');
    expect(session.preview?.version).toBe('v2');
    expect(session.dirty).toBe(false);
    expect(session.status).toBe('idle');
  });

  it('drops the error of a re-read superseded by a save', async () => {
    const mock = createMockClient(DESKTOP_CAPS);
    let rejectReread: (error: Error) => void = (): void => {};
    let reads = 0;
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> => {
      reads += 1;
      return reads === 1
        ? Promise.resolve(preview())
        : new Promise<PortalFilePreview>((_, reject): void => {
            rejectReread = reject;
          });
    };
    mock.commandResponders['file.save'] = (args): Promise<PortalFilePreview> =>
      Promise.resolve(preview({ content: args.content, version: 'v2' }));
    const store = createFileViewerStore(mock.client);
    const key = await store.getState().openFile(READ_REQUEST);

    const reopen = store.getState().openFile(READ_REQUEST);
    store.getState().updateContent(key, 'edited');
    await store.getState().saveFile(key);
    rejectReread(new Error('sandbox asleep'));
    await reopen;

    const session = store.getState().files[key];
    expect(session.status).toBe('idle');
    expect(session.error).toBeNull();
    expect(session.content).toBe('edited');
  });

  it('refreshes from a re-read when an edit made during it was discarded', async () => {
    const mock = createMockClient(DESKTOP_CAPS);
    const reread = deferred<PortalFilePreview>();
    let reads = 0;
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> => {
      reads += 1;
      return reads === 1 ? Promise.resolve(preview()) : reread.promise;
    };
    const store = createFileViewerStore(mock.client);
    const key = await store.getState().openFile(READ_REQUEST);

    const reopen = store.getState().openFile(READ_REQUEST);
    store.getState().updateContent(key, 'draft');
    store.getState().discardEdits(key);
    reread.resolve(preview({ content: 'newer on disk', version: 'v2' }));
    await reopen;

    const session = store.getState().files[key];
    expect(session.content).toBe('newer on disk');
    expect(session.preview?.version).toBe('v2');
    expect(session.dirty).toBe(false);
    expect(session.status).toBe('idle');
  });

  it('lets only the latest re-read settle the session', async () => {
    const mock = createMockClient(DESKTOP_CAPS);
    const staleRead = deferred<PortalFilePreview>();
    const latestRead = deferred<PortalFilePreview>();
    let reads = 0;
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> => {
      reads += 1;
      if (reads === 1) return Promise.resolve(preview());
      return reads === 2 ? staleRead.promise : latestRead.promise;
    };
    mock.commandResponders['file.save'] = (args): Promise<PortalFilePreview> =>
      Promise.resolve(preview({ content: args.content, version: 'v2' }));
    const store = createFileViewerStore(mock.client);
    const key = await store.getState().openFile(READ_REQUEST);

    // Re-read A is in flight when an edit and save land.
    const staleOpen = store.getState().openFile(READ_REQUEST);
    store.getState().updateContent(key, 'saved');
    await store.getState().saveFile(key);
    // Re-read B starts after the save.
    const latestOpen = store.getState().openFile(READ_REQUEST);
    staleRead.resolve(preview({ content: 'stale', version: 'v1' }));
    await staleOpen;
    // A must not release B's loading sentinel, so a reopen stays focus-only.
    expect(store.getState().files[key].status).toBe('loading');
    await store.getState().openFile(READ_REQUEST);
    expect(reads).toBe(3);

    latestRead.resolve(preview({ content: 'latest', version: 'v3' }));
    await latestOpen;
    const session = store.getState().files[key];
    expect(session.content).toBe('latest');
    expect(session.preview?.version).toBe('v3');
    expect(session.status).toBe('idle');
  });

  it('reads fresh from disk after closing and reopening', async () => {
    const mock = createMockClient(DESKTOP_CAPS);
    let read = 0;
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> => {
      read += 1;
      return Promise.resolve(
        preview({ content: read === 1 ? 'v1' : 'v2-on-disk' }),
      );
    };
    const store = createFileViewerStore(mock.client);
    const key = await store.getState().openFile(READ_REQUEST);
    store.getState().updateContent(key, 'discarded draft');

    store.getState().closeFile(key);
    expect(store.getState().files[key]).toBeUndefined();
    await store.getState().openFile(READ_REQUEST);

    expect(read).toBe(2);
    const session = store.getState().files[key];
    expect(session.content).toBe('v2-on-disk');
    expect(session.dirty).toBe(false);
  });

  it('keeps identical relative paths under different roots on distinct sessions', async () => {
    const mock = createMockClient(DESKTOP_CAPS);
    mock.queryResponders['file.read'] = (args): Promise<PortalFilePreview> =>
      Promise.resolve(preview({ content: `root:${args.fileRootLocalId}` }));
    const store = createFileViewerStore(mock.client);

    const keyA = await store
      .getState()
      .openFile({ ...READ_REQUEST, fileRootLocalId: 'rootA' });
    const keyB = await store
      .getState()
      .openFile({ ...READ_REQUEST, fileRootLocalId: 'rootB' });

    expect(keyA).not.toBe(keyB);
    expect(store.getState().files[keyA].content).toBe('root:rootA');
    expect(store.getState().files[keyB].content).toBe('root:rootB');
    store.getState().updateContent(keyA, 'edited-A');
    expect(store.getState().files[keyA].dirty).toBe(true);
    expect(store.getState().files[keyB].dirty).toBe(false);
  });

  it('clears a stale save error when the buffer changes again', async () => {
    const mock = createMockClient(DESKTOP_CAPS);
    mock.queryResponders['file.read'] = (): Promise<PortalFilePreview> =>
      Promise.resolve(preview());
    mock.commandResponders['file.save'] = (): Promise<PortalFilePreview> =>
      Promise.reject(new Error('boom'));
    const store = createFileViewerStore(mock.client);
    const key = await store.getState().openFile(READ_REQUEST);
    store.getState().updateContent(key, 'edited');
    await store.getState().saveFile(key);
    expect(store.getState().files[key].status).toBe('error');

    store.getState().updateContent(key, 'edited more');
    const session = store.getState().files[key];
    expect(session.status).toBe('idle');
    expect(session.error).toBeNull();
    expect(session.dirty).toBe(true);
  });
});
