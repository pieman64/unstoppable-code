import {
  captureBrowserBoundary,
  observeBrowserCreate,
  observeProfileOperations,
} from '../e2e-profile-operation-diagnostics';

const id = '11111111-1111-4111-8111-111111111111';
type DiagnosticWindow = Parameters<typeof captureBrowserBoundary>[1][number];
type DiagnosticView = DiagnosticWindow['contentView']['children'][number];
type Mocks<K extends string> = Record<K, jest.Mock<unknown, unknown[]>>;
interface Fixture {
  inventory: Mocks<'start'> & {
    authority: Mocks<
      'directory' | 'assertAvailable' | 'cookies' | 'withGeneration'
    >;
    queue: Mocks<'run'>;
  };
  jobs: Mocks<'create' | 'update' | 'list'>;
  maintenance: Mocks<'preview' | 'commit' | 'validateCurrent'> & {
    adapter: Mocks<'profile' | 'authorize' | 'usage' | 'scope'>;
  };
}
function fixture(): Fixture {
  const authority = {
    directory: jest.fn<unknown, unknown[]>(),
    assertAvailable: jest.fn<unknown, unknown[]>(),
    cookies: jest.fn<unknown, unknown[]>(),
    withGeneration: jest.fn<unknown, unknown[]>(),
  };
  const queue = { run: jest.fn<unknown, unknown[]>() };
  return {
    inventory: { start: jest.fn<unknown, unknown[]>(), authority, queue },
    jobs: {
      create: jest.fn<unknown, unknown[]>(),
      update: jest.fn<unknown, unknown[]>(),
      list: jest.fn<unknown, unknown[]>(),
    },
    maintenance: {
      preview: jest.fn<unknown, unknown[]>(),
      commit: jest.fn<unknown, unknown[]>(),
      validateCurrent: jest.fn<unknown, unknown[]>(),
      adapter: {
        profile: jest.fn<unknown, unknown[]>(),
        authorize: jest.fn<unknown, unknown[]>(),
        usage: jest.fn<unknown, unknown[]>(),
        scope: jest.fn<unknown, unknown[]>(),
      },
    },
  };
}

test('captures the original inventory error before generic conversion without replacing promise or rejection', async () => {
  const data = fixture();
  const error = Object.assign(new Error('original rename failure'), {
    code: 'EPERM',
  });
  const promise = Promise.reject(error);
  data.inventory.authority.directory.mockReturnValue(promise);
  const observer = observeProfileOperations(data, id, 1, false);
  try {
    const returned = data.inventory.authority.directory(
      id,
      1,
    ) as Promise<unknown>;
    expect(returned).toBe(promise);
    await expect(returned).rejects.toBe(error);
    await returned.catch(
      () => 'Browser data could not be measured. Retry measurement.',
    );
    expect(JSON.stringify(observer.snapshot())).toContain(
      'original rename failure',
    );
    expect(JSON.stringify(observer.snapshot())).toContain('EPERM');
  } finally {
    observer.release();
  }
});

test('preserves queue handle, sync throw identity and unrelated-profile pass-through', async () => {
  const data = fixture();
  const handle = {
    result: Promise.resolve({ approximateBytes: 3 }),
    cancel: jest.fn<unknown, unknown[]>(),
  };
  const error = new Error('sync');
  data.inventory.queue.run.mockReturnValue(handle);
  data.inventory.authority.assertAvailable.mockImplementation(() => {
    throw error;
  });
  const observer = observeProfileOperations(data, id, 1, false);
  try {
    expect(data.inventory.queue.run(id, 1, 'untouched', () => {})).toBe(handle);
    expect(() => data.inventory.authority.assertAvailable(id)).toThrow(error);
    await handle.result;
    const before = JSON.stringify(observer.snapshot().events);
    data.inventory.queue.run('other', 1);
    expect(JSON.stringify(observer.snapshot().events)).toBe(before);
    expect(handle.cancel).not.toHaveBeenCalled();
  } finally {
    observer.release();
  }
});

test('bounds event bytes, reserved original errors, job IDs and live pending calls', async () => {
  const data = fixture();
  data.inventory.authority.directory.mockImplementation(() => {
    throw Object.assign(new Error('\u0000'.repeat(50000)), {
      stack: '\u0000'.repeat(50000),
    });
  });
  data.inventory.start.mockReturnValue(new Promise(() => {}));
  data.jobs.list.mockReturnValue(
    Promise.resolve({
      jobs: Array.from({ length: 100 }, () => ({
        profileId: id,
        jobId: 'j'.repeat(128),
        message: 'm'.repeat(2048),
      })),
    }),
  );
  const observer = observeProfileOperations(data, id, 1, false);
  for (let i = 0; i < 1000; i++) {
    data.inventory.start(`job-${i}`, id, 1);
    try {
      data.inventory.authority.directory(id, 1);
    } catch {
      /* original exception */
    }
  }
  for (let i = 0; i < 100; i++) data.inventory.start('job-7', id, 1);
  await data.jobs.list({ kind: 'user' }, 0, id);
  const snapshot = observer.snapshot();
  expect((snapshot.events as unknown[]).length).toBeLessThanOrEqual(256);
  expect((snapshot.jobIds as unknown[]).length).toBe(8);
  expect((snapshot.pending as unknown[]).length).toBeLessThanOrEqual(64);
  expect((snapshot.firstErrors as unknown[]).length).toBeLessThanOrEqual(8);
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(
    256 * 1024,
  );
  expect(snapshot.dropped).toBeGreaterThan(0);
  observer.release();
});

test('restores exact descriptors, expires at 30s, and leaves replacement wrappers untouched', async () => {
  jest.useFakeTimers();
  const data = fixture();
  const original = Object.getOwnPropertyDescriptor(
    data.inventory.authority,
    'cookies',
  );
  const inherited = data.inventory.authority.directory;
  Object.setPrototypeOf(data.inventory.authority, { directory: inherited });
  Reflect.deleteProperty(data.inventory.authority, 'directory');
  let resolve!: () => void;
  data.inventory.queue.run.mockReturnValue({
    result: new Promise<void>((done) => {
      resolve = done;
    }),
  });
  const observer = observeProfileOperations(data, id, 1, false);
  data.inventory.queue.run(id, 1);
  const replacement = jest.fn<unknown, unknown[]>();
  data.inventory.authority.assertAvailable = replacement;
  jest.advanceTimersByTime(30000);
  const snapshot = observer.snapshot();
  expect(snapshot).toMatchObject({
    active: false,
    expired: true,
    restorationConflicts: ['inventory.assertAvailable'],
  });
  expect(
    Object.getOwnPropertyDescriptor(data.inventory.authority, 'cookies'),
  ).toEqual(original);
  expect(
    Object.getOwnPropertyDescriptor(data.inventory.authority, 'directory'),
  ).toBeUndefined();
  expect(data.inventory.authority.assertAvailable).toBe(replacement);
  resolve();
  await Promise.resolve();
  expect(observer.snapshot().events).toEqual(snapshot.events);
  observer.release();
  jest.useRealTimers();
});

test('captures preview identity, service outcome and filtered job page without credentials', async () => {
  const data = fixture();
  const preview = {
    profileId: id,
    storageGeneration: 1,
    token: 'token',
    metadataRevision: 2,
    operation: { kind: 'cache' },
    cookieDomains: ['secret-domain'],
    contexts: ['secret-context'],
  };
  data.maintenance.preview.mockReturnValue(Promise.resolve(preview));
  const error = new Error('stale revision');
  data.maintenance.commit.mockImplementation(() => Promise.reject(error));
  data.jobs.list.mockReturnValue(
    Promise.resolve({
      jobs: [
        {
          jobId: 'job',
          profileId: id,
          storageGeneration: 1,
          status: 'failed',
          kind: 'cache',
        },
        { profileId: 'other', message: 'unrelated' },
      ],
    }),
  );
  const observer = observeProfileOperations(data, id, 1, true);
  try {
    await data.maintenance.preview({ kind: 'user' }, id, 1, 2, {
      kind: 'cache',
    });
    const promise = data.maintenance.commit({ kind: 'user' }, 'job', 'token');
    await expect(promise).rejects.toBe(error);
    await data.jobs.list({ kind: 'user' }, 0, id);
    const snapshot = observer.snapshot();
    expect(snapshot.commitStage).toBe('entered');
    expect(snapshot.lastJobList).toMatchObject({
      jobs: [{ jobId: 'job' }],
      truncated: false,
    });
    expect(JSON.stringify(snapshot)).toContain('stale revision');
    expect(JSON.stringify(snapshot)).not.toMatch(
      /secret-domain|secret-context|unrelated/,
    );
  } finally {
    observer.release();
  }
});

test('hostile error getters cannot mask the original synchronous throw', () => {
  const data = fixture();
  const error = Object.defineProperty(new Error(), 'message', {
    get() {
      throw new Error('hostile');
    },
  });
  data.inventory.authority.directory.mockImplementation(() => {
    throw error;
  });
  const observer = observeProfileOperations(data, id, 1, false);
  try {
    try {
      data.inventory.authority.directory(id, 1);
    } catch (caught) {
      expect(caught).toBe(error);
    }
  } finally {
    observer.release();
  }
  expect((observer.snapshot().firstErrors as unknown[]).length).toBe(1);
});

test('snapshots perform no service work, keep receiver and callbacks, and distinguish pending from stage-not-entered', async () => {
  const data = fixture();
  const callback = jest.fn<unknown, unknown[]>();
  const original = data.inventory.authority.withGeneration;
  const list = data.jobs.list;
  const promise = new Promise(() => {});
  original.mockReturnValue(promise);
  const observer = observeProfileOperations(data, id, 1, true);
  expect(observer.snapshot().commitStage).toBe('stage-not-entered');
  expect(data.inventory.authority.withGeneration(id, 1, callback)).toBe(
    promise,
  );
  expect(original.mock.contexts[0]).toBe(data.inventory.authority);
  expect(original.mock.calls[0]).toEqual([id, 1, callback]);
  for (let i = 0; i < 20; i++) observer.snapshot();
  expect(list).not.toHaveBeenCalled();
  expect(callback).not.toHaveBeenCalled();
  expect((observer.snapshot().pending as unknown[]).length).toBe(1);
  observer.release();
  expect(observer.snapshot().pendingStatus).toBe('pending-at-observation-stop');
  await Promise.resolve();
});

// New observation feature coverage, not evidence of a production regression.
test('create receipt observation scopes blank user creation and preserves promise, receiver and arguments', async () => {
  const scope = { projectId: 'project', worktreeId: 'worktree' };
  const snapshot = {
    id: 'browser',
    profile: {
      resolvedProfileId: id,
      runtimeGeneration: 2,
      storageGeneration: 1,
    },
    title: 'private-title',
    url: 'private-url',
  };
  let resolve!: (value: unknown) => void;
  const promise = new Promise((done) => {
    resolve = done;
  });
  const original = jest.fn<unknown, unknown[]>().mockReturnValue(promise);
  const service = { create: original };
  expect(() =>
    observeBrowserCreate(service, { ...scope, browserId: 'invalid/browser' }),
  ).toThrow('Captured synthetic browser ID is invalid');
  const observer = observeBrowserCreate(service, scope);
  const request = { ...scope };
  try {
    expect(service.create(request)).toBe(promise);
    expect(original.mock.contexts[0]).toBe(service);
    expect(original.mock.calls[0]).toEqual([request]);
    expect(observer.snapshot()).toMatchObject({
      createStage: 'entered',
      pending: [{ stage: 'browser.create' }],
    });
    const before = observer.snapshot().events;
    for (const args of [
      [{ ...scope, url: 'https://private' }],
      [{ ...scope }, 'agent'],
      [{ ...scope, worktreeId: 'other' }],
      [{ ...scope, browserId: 'restored' }],
      [{ ...scope }, 'user', {}],
    ])
      service.create(...args);
    expect(observer.snapshot().events).toEqual(before);
    resolve(snapshot);
    await expect(promise).resolves.toBe(snapshot);
    expect(observer.snapshot()).toMatchObject({
      pending: [],
      events: [
        { outcome: 'entered' },
        {
          outcome: 'fulfilled',
          value: { browserId: 'browser', profileId: id, runtimeGeneration: 2 },
        },
      ],
    });
    expect(JSON.stringify(observer.snapshot())).not.toMatch(
      /private-title|private-url/,
    );
  } finally {
    observer.release();
  }
  expect(service.create).toBe(original);
});

test('create receipt observation scopes an exact restored browser without recording private content', async () => {
  const scope = {
    projectId: 'project',
    worktreeId: 'worktree',
    browserId: 'browser-restored',
    url: 'https://private.example/restored',
  };
  const snapshot = {
    id: scope.browserId,
    profile: {
      resolvedProfileId: id,
      runtimeGeneration: 2,
      storageGeneration: 1,
    },
    title: 'private-title',
    url: 'https://private.example/restored',
    pageContents: 'private-page-contents',
  };
  const promise = Promise.resolve(snapshot);
  const original = jest.fn<unknown, unknown[]>().mockReturnValue(promise);
  const service = { create: original };
  const observer = observeBrowserCreate(service, scope);
  const request = { ...scope };
  try {
    expect(service.create(request)).toBe(promise);
    expect(original.mock.contexts[0]).toBe(service);
    expect(original.mock.calls[0]).toEqual([request]);
    service.create({ ...request, browserId: 'browser-other' });
    service.create({ ...request, worktreeId: 'worktree-other' });
    await expect(promise).resolves.toBe(snapshot);
    expect(observer.snapshot()).toMatchObject({
      createStage: 'entered',
      pending: [],
      events: [
        { outcome: 'entered' },
        {
          outcome: 'fulfilled',
          value: {
            browserId: scope.browserId,
            profileId: id,
            runtimeGeneration: 2,
          },
        },
      ],
    });
    expect(JSON.stringify(observer.snapshot())).not.toMatch(
      /private\.example|private-title|private-page-contents/,
    );
  } finally {
    observer.release();
  }
  expect(service.create).toBe(original);
});

test('create observation retains bounded original rejection and ignores settlements after release', async () => {
  const scope = { projectId: 'project', worktreeId: 'worktree' };
  const error = Object.assign(new Error('x'.repeat(50000)), {
    code: 'REJECTED',
  });
  const promise = Promise.reject(error);
  const original = jest.fn<unknown, unknown[]>().mockReturnValue(promise);
  const service = { create: original };
  const observer = observeBrowserCreate(service, scope);
  expect(service.create(scope)).toBe(promise);
  await expect(promise).rejects.toBe(error);
  expect(observer.snapshot()).toMatchObject({
    events: [
      { outcome: 'entered' },
      { outcome: 'rejected', error: { code: 'REJECTED', truncated: true } },
    ],
  });
  expect(
    Buffer.byteLength(JSON.stringify(observer.snapshot())),
  ).toBeLessThanOrEqual(256 * 1024);
  observer.release();
  let resolve!: () => void;
  original.mockReturnValue(
    new Promise<void>((done) => {
      resolve = done;
    }),
  );
  const late = observeBrowserCreate(service, scope);
  service.create(scope);
  late.release();
  const stopped = late.snapshot().events;
  resolve();
  await Promise.resolve();
  expect(late.snapshot().events).toEqual(stopped);
  expect(service.create).toBe(original);
});

test('native identity snapshot retains duplicate URL matches and exact cached owner without page content', () => {
  const view = (id: number, visible: boolean): DiagnosticView => ({
    webContents: {
      id,
      getURL: (): string => 'synthetic-url',
      isDestroyed: (): boolean => false,
    },
    getVisible: (): boolean => visible,
    getBounds: (): ReturnType<DiagnosticView['getBounds']> => ({
      x: 1,
      y: 2,
      width: 30,
      height: 40,
    }),
    children: [],
  });
  const first = view(10, true),
    exact = view(11, false);
  const win = {
    id: 4,
    webContents: { id: 5 },
    isDestroyed: (): boolean => false,
    contentView: { children: [first, exact] },
  };
  const state = {
    snapshot: {
      id: 'browser',
      projectId: 'project',
      worktreeId: 'worktree',
      profile: { resolvedProfileId: id, runtimeGeneration: 2 },
    },
    view: exact,
    hostWindow: win,
    visible: false,
    pendingDialog: { id: 'dialog', message: 'private-dialog' },
  };
  const result = captureBrowserBoundary(
    { sessions: new Map([['browser', state]]) },
    [win],
    {
      projectId: 'project',
      worktreeId: 'worktree',
      browserId: 'browser',
      url: 'synthetic-url',
    },
  );
  expect(result).toMatchObject({
    sessions: [
      {
        browserId: 'browser',
        webContentsId: 11,
        hostWindowId: 4,
        dialogId: 'dialog',
      },
    ],
    native: [
      {
        webContentsId: 10,
        visible: true,
        matchesUrl: true,
        matchesBrowser: false,
      },
      { webContentsId: 11, visible: false, matchesBrowser: true },
    ],
  });
  expect(JSON.stringify(result)).not.toMatch(/synthetic-url|private-dialog/);
  const unavailable = captureBrowserBoundary({}, [], {
    projectId: 'project',
    worktreeId: 'worktree',
  });
  expect(unavailable).toMatchObject({ sessionsStatus: 'unavailable' });
});

test('create observer expires, restores inherited method and reports replacement conflicts without touching replacements', () => {
  jest.useFakeTimers();
  try {
    const scope = { projectId: 'project', worktreeId: 'worktree' };
    const original = jest
      .fn<unknown, unknown[]>()
      .mockReturnValue(new Promise(() => {}));
    const service = Object.create({ create: original }) as {
      create: typeof original;
    };
    const observer = observeBrowserCreate(service, scope);
    service.create(scope);
    jest.advanceTimersByTime(30000);
    expect(observer.snapshot()).toMatchObject({
      active: false,
      expired: true,
      pendingStatus: 'pending-at-observation-stop',
    });
    expect(Object.getOwnPropertyDescriptor(service, 'create')).toBeUndefined();
    const next = observeBrowserCreate(service, scope);
    const replacement = jest.fn<unknown, unknown[]>();
    service.create = replacement;
    next.release();
    expect(service.create).toBe(replacement);
    expect(next.snapshot()).toMatchObject({
      restorationConflicts: ['browser.create'],
    });
  } finally {
    jest.useRealTimers();
  }
});

test('native snapshots bound exact-scope sessions and children and explicitly retain unavailable native fields', () => {
  const scope = {
    projectId: 'project',
    worktreeId: 'worktree',
    browserId: 'browser-0',
    url: 'synthetic-url',
  };
  const view = {
    webContents: {
      id: 1,
      getURL: (): string => 'synthetic-url',
      isDestroyed: (): boolean => true,
    },
    getVisible: (): boolean => {
      throw new Error('native unavailable');
    },
    getBounds: (): ReturnType<DiagnosticView['getBounds']> => ({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    }),
    children: [],
  };
  const win = {
    id: 1,
    webContents: { id: 2 },
    isDestroyed: (): boolean => false,
    contentView: { children: [view] },
  };
  const states = new Map(
    Array.from({ length: 100 }, (_, index) => [
      `browser-${index}`,
      {
        snapshot: {
          id: `browser-${index}`,
          ...scope,
          url: 'private-url',
          profile: { resolvedProfileId: id },
        },
        view,
        hostWindow: win,
      },
    ]),
  );
  const result = captureBrowserBoundary(
    { sessions: states },
    Array.from({ length: 20 }, () => win),
    scope,
  );
  expect(result.truncated).toBe(true);
  expect((result.native as unknown[])[0]).toMatchObject({
    destroyed: true,
    matchesBrowser: true,
  });
  expect((result.errors as unknown[])[0]).toMatchObject({
    message: 'native unavailable',
  });
  expect((result.sessions as unknown[]).length).toBe(8);
  expect((result.native as unknown[]).length).toBeLessThanOrEqual(8);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
    256 * 1024,
  );
  expect(JSON.stringify(result)).not.toMatch(/private-url|synthetic-url/);
});

test('loaded Task observer spans slow create, scoped awaited phases and restoration without replacing promises', async () => {
  jest.useFakeTimers();
  const { observeLoadedTaskReset } =
    await import('../e2e-profile-operation-diagnostics');
  const owner = { projectId: 'project', worktreeId: 'worktree' };
  const rows: Record<string, unknown>[] = [];
  let writeFails = false;
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const data = fixture();
  const originalCreate = function (request: unknown): Promise<{ id: string }> {
    return service.createSerialized(request);
  };
  const service = {
    profileData: { ...data, ensureReady: (): Promise<unknown> => pending },
    create: originalCreate,
    createSerialized: async (request: unknown): Promise<{ id: string }> => {
      void request;
      await service.profileData.ensureReady();
      return { id: 'tab' };
    },
    recoverProfileSwitches: (): undefined => undefined,
    attachDebugger: (): undefined => undefined,
    navigate: (): undefined => undefined,
    persistLiveSnapshot: (): undefined => undefined,
    resumeProfileViews: async (
      tabs: { snapshot: typeof owner }[],
    ): Promise<void> => {
      await service.create(tabs[0].snapshot);
    },
  };
  const authority = {
    resolve: (): { profile: { profileId: string } } => ({
      profile: { profileId: id },
    }),
    acquireSession: (): undefined => undefined,
    commitBinding: (): undefined => undefined,
    assertActive: (): undefined => undefined,
  };
  const observer = observeLoadedTaskReset(
    service,
    authority,
    [owner],
    (row) => {
      if (writeFails) throw new Error('sink failed');
      rows.push(row);
    },
  );
  try {
    const result = service.create(owner);
    jest.advanceTimersByTime(38050);
    expect(observer.snapshot().active).toBe(true);
    expect(observer.snapshot().pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'browser.create' }),
        expect.objectContaining({ stage: 'create.ensureReady' }),
      ]),
    );
    finish({});
    await result;
    await service.resumeProfileViews([{ snapshot: owner }]);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'browser.resumeProfileViews',
          outcome: 'started',
        }),
        expect.objectContaining({
          stage: 'browser.create',
          outcome: 'completed',
        }),
      ]),
    );
    expect(rows.every((row) => typeof row.monotonicNs === 'string')).toBe(true);
    const before = rows.length;
    await service.create({ ...owner, worktreeId: 'other' });
    expect(rows.length).toBe(before);
    writeFails = true;
    await expect(service.create(owner)).resolves.toEqual({ id: 'tab' });
    expect(observer.snapshot().dropped).toBeGreaterThan(0);
    jest.advanceTimersByTime(180000);
    expect(observer.snapshot()).toMatchObject({ active: false, expired: true });
    expect(service.create).toBe(originalCreate);
  } finally {
    observer.release();
    jest.useRealTimers();
  }
});
