import { createHash } from 'node:crypto';
import {
  CORE_WORKSPACE_ITEM_INSTRUCTIONS,
  CORE_WORKSPACE_ITEM_QUERIES,
  type CanopyCallerDescriptor,
  type CoreWorkspaceItem,
  type CoreWorkspaceItemImportParams,
  type CoreWorkspaceItemListResult,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import { CanopyOperationError } from '../../../runtime/errors';
import type { CanopyHandlerContext } from '../../../runtime/types';
import { encodeWorkspaceItemId } from '../workspace-item-ids';
import {
  createCoreWorkspaceItemHandlers,
  createWorkspaceItemReplayCache,
  type CoreWorkspaceAttachmentEntry,
  type CoreWorkspaceAttachmentImportSource,
  type CoreWorkspaceAttachmentsHost,
  type CoreWorkspaceItemAdmittedScope,
  type CoreWorkspaceItemHandlerOptions,
  type CoreWorkspaceItemProvider,
  type CoreWorkspaceItemScopeHost,
} from '../workspace-items';

const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.workspace.read', 'core.workspace.write'],
};

function context(idempotencyKey?: string): CanopyHandlerContext {
  return {
    requestId: 'request-1',
    caller,
    metadata: idempotencyKey === undefined ? {} : { idempotencyKey },
    signal: new AbortController().signal,
  };
}

class InvalidId extends Error {}

const scopes: CoreWorkspaceItemScopeHost = {
  classify(scope) {
    if (!/^[a-z0-9-]+$/.test(scope.workspaceId))
      throw new InvalidId(`Invalid projectId: ${scope.workspaceId}`);
    if (scope.workspaceId === 'viewer') return 'viewer';
    return scope.workspaceId.startsWith('cowork') ? 'workEntry' : 'code';
  },
  isInvalidScope: (error) => error instanceof InvalidId,
};

const storeName = (scope: CoreWorkspaceItemAdmittedScope): string =>
  `${scope.workspaceId}/${scope.worktreeId ?? '-'}`;

/** In-memory stores; host handles name sources in `sources`. */
function fakeAttachments(): CoreWorkspaceAttachmentsHost & {
  stores: Map<string, CoreWorkspaceAttachmentEntry[]>;
  sources: Map<string, { name: string; sizeBytes: number } | Error>;
  imports: CoreWorkspaceAttachmentImportSource[];
} {
  const stores = new Map<string, CoreWorkspaceAttachmentEntry[]>();
  const sources = new Map<
    string,
    { name: string; sizeBytes: number } | Error
  >();
  const imports: CoreWorkspaceAttachmentImportSource[] = [];
  let clock = 0;
  return {
    stores,
    sources,
    imports,
    storeKey: storeName,
    list: (scope) => Promise.resolve(stores.get(storeName(scope)) ?? []),
    importSource(scope, source) {
      imports.push(source);
      let name: string;
      let sizeBytes: number;
      if (source.kind === 'host') {
        const found = sources.get(source.handle);
        if (!found) return Promise.reject(new Error('unknown handle'));
        if (found instanceof Error) return Promise.reject(found);
        ({ name, sizeBytes } = found);
      } else {
        const entry = stores
          .get(storeName(source.scope))
          ?.find((candidate) => candidate.name === source.name);
        if (!entry) return Promise.reject(new Error('gone'));
        ({ name, sizeBytes } = entry);
      }
      const store = stores.get(storeName(scope)) ?? [];
      const taken = new Set(store.map((entry) => entry.name));
      let unique = name;
      for (let counter = 2; taken.has(unique); counter += 1)
        unique = name.replace(/(\.[^.]*)?$/, `-${counter}$1`);
      clock += 1;
      const entry = {
        name: unique,
        sizeBytes,
        createdAt: new Date(Date.UTC(2026, 9, 31, 0, 0, clock)).toISOString(),
      };
      stores.set(storeName(scope), [entry, ...store]);
      return Promise.resolve(entry);
    },
    classifyFailure: (error) =>
      error instanceof Error && error.message === 'unknown handle'
        ? 'unknownHandle'
        : error instanceof Error && error.message === 'too long'
          ? 'filenameInvalid'
          : null,
  };
}

function setup(options: Partial<CoreWorkspaceItemHandlerOptions> = {}): {
  handlers: ReturnType<typeof createCoreWorkspaceItemHandlers>;
  host: ReturnType<typeof fakeAttachments>;
} {
  const host = fakeAttachments();
  return {
    host,
    handlers: createCoreWorkspaceItemHandlers({
      scopes,
      attachments: host,
      ...options,
    }),
  };
}

// Handlers may answer synchronously or with a promise.
async function failure(operation: unknown): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error instanceof CanopyOperationError
      ? { kind: error.payload.kind, code: error.payload.code }
      : error;
  }
  return 'resolved';
}

function importParams(
  overrides: Partial<CoreWorkspaceItemImportParams> = {},
): CoreWorkspaceItemImportParams {
  return {
    workspaceId: 'code-ws',
    worktreeId: 'wt-1',
    kind: 'attachment',
    sources: [{ kind: 'host', handle: `h-${'a'.repeat(32)}` }],
    ...overrides,
  };
}

const handle = (letter: string): string => `h-${letter.repeat(32)}`;

describe('core.workspace.item.import', () => {
  it('imports sources in order, returning items without host paths', async () => {
    const { handlers, host } = setup();
    host.sources.set(handle('a'), { name: 'x.txt', sizeBytes: 3 });
    host.sources.set(handle('b'), { name: 'x.txt', sizeBytes: 5 });
    const result = await handlers.instructions['core.workspace.item.import'](
      importParams({
        sources: [
          { kind: 'host', handle: handle('a') },
          { kind: 'host', handle: handle('b') },
        ],
      }),
      context('key-1'),
    );
    expect(result.outcomes).toMatchObject([
      {
        status: 'imported',
        item: {
          itemId: 'attachment:code-ws@wt-1:x.txt',
          title: 'x.txt',
          sizeBytes: 3,
          kind: 'attachment',
          revision: 0,
          content: null,
          artifactId: null,
          mediaType: null,
          origin: {},
        },
      },
      {
        status: 'imported',
        item: { itemId: 'attachment:code-ws@wt-1:x-2.txt', sizeBytes: 5 },
      },
    ]);
    const first = result.outcomes[0];
    if (first.status !== 'imported') throw new Error('expected an import');
    expect(first.item.updatedAt).toBe(first.item.createdAt);
  });

  it('stops at the first failure and reports later sources as not attempted', async () => {
    const { handlers, host } = setup();
    host.sources.set(handle('a'), { name: 'ok.txt', sizeBytes: 1 });
    host.sources.set(
      handle('b'),
      Object.assign(new Error("ENOENT: stat '/secret/path'"), {
        code: 'ENOENT',
      }),
    );
    host.sources.set(handle('c'), { name: 'later.txt', sizeBytes: 1 });
    const result = await handlers.instructions['core.workspace.item.import'](
      importParams({
        sources: ['a', 'b', 'c'].map((letter) => ({
          kind: 'host' as const,
          handle: handle(letter),
        })),
      }),
      context('key-2'),
    );
    expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
      'imported',
      'failed',
      'notAttempted',
    ]);
    expect(result.outcomes[1]).toEqual({
      status: 'failed',
      error: {
        kind: 'not_found',
        code: 'core.workspace.item.sourceNotFound',
        message: 'The import source does not exist.',
      },
    });
    expect(host.imports).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('/secret/path');
  });

  it.each([
    ['ENOENT', 'not_found', 'core.workspace.item.sourceNotFound'],
    ['ENOTDIR', 'not_found', 'core.workspace.item.sourceNotFound'],
    ['EISDIR', 'invalid_argument', 'core.workspace.item.sourceNotFile'],
    ['ENOTSUP', 'invalid_argument', 'core.workspace.item.sourceNotFile'],
    ['EACCES', 'permission_denied', 'core.workspace.item.sourceAccessDenied'],
    ['EPERM', 'permission_denied', 'core.workspace.item.sourceAccessDenied'],
    ['ENOSPC', 'internal', 'core.workspace.item.writeFailed'],
    [undefined, 'internal', 'core.workspace.item.writeFailed'],
  ])('maps a %s copy failure', async (code, kind, errorCode) => {
    const { handlers, host } = setup();
    host.sources.set(
      handle('a'),
      Object.assign(new Error('copy failed'), code ? { code } : {}),
    );
    const { outcomes } = await handlers.instructions[
      'core.workspace.item.import'
    ](importParams(), context('key'));
    expect(outcomes[0]).toMatchObject({
      status: 'failed',
      error: { kind, code: errorCode },
    });
  });

  it('maps host-classified failures: unknown handles and unstorable names', async () => {
    const { handlers, host } = setup();
    host.sources.set(handle('b'), new Error('too long'));
    const { outcomes } = await handlers.instructions[
      'core.workspace.item.import'
    ](
      importParams({
        sources: [
          { kind: 'host', handle: handle('a') },
          { kind: 'host', handle: handle('b') },
        ],
      }),
      context('key'),
    );
    expect(outcomes[0]).toMatchObject({
      error: { code: 'core.workspace.item.sourceNotFound' },
    });
    expect(outcomes[1]).toEqual({ status: 'notAttempted' });
    const second = await handlers.instructions['core.workspace.item.import'](
      importParams({ sources: [{ kind: 'host', handle: handle('b') }] }),
      context('key-other'),
    );
    expect(second.outcomes[0]).toMatchObject({
      error: {
        kind: 'invalid_argument',
        code: 'core.workspace.item.filenameInvalid',
      },
    });
  });

  it('copies an existing attachment item, refusing other kinds and bad IDs', async () => {
    const { handlers, host } = setup();
    host.stores.set('cowork-ws/-', [
      {
        name: 'shared.png',
        sizeBytes: 9,
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ]);
    const existing = encodeWorkspaceItemId({
      kind: 'attachment',
      workspaceId: 'cowork-ws',
      worktreeId: null,
      name: 'shared.png',
    });
    if (!existing) throw new Error('no id');
    const note = encodeWorkspaceItemId({
      kind: 'note',
      workspaceId: 'cowork-ws',
      worktreeId: null,
      name: 'plan',
    });
    if (!note) throw new Error('no id');
    const run = async (itemId: string): Promise<unknown> =>
      (
        await handlers.instructions['core.workspace.item.import'](
          importParams({ sources: [{ kind: 'item', itemId }] }),
          context(itemId),
        )
      ).outcomes[0];
    expect(await run(existing)).toMatchObject({
      status: 'imported',
      item: { title: 'shared.png', sizeBytes: 9, worktreeId: 'wt-1' },
    });
    expect(await run(note)).toMatchObject({
      error: {
        kind: 'capability_unavailable',
        code: 'core.workspace.item.kindUnavailable',
      },
    });
    expect(await run('attachment:cowork-ws:missing.png')).toMatchObject({
      error: { code: 'core.workspace.item.sourceNotFound' },
    });
    expect(await run('attachment:viewer@wt-1:a.png')).toMatchObject({
      error: { code: 'core.workspace.item.sourceNotFound' },
    });
    expect(await run('not-an-id')).toMatchObject({
      error: {
        kind: 'invalid_argument',
        code: 'core.workspace.item.invalidItemId',
      },
    });
  });

  it('refuses scopes before any effect', async () => {
    const { handlers, host } = setup();
    const run = (
      overrides: Partial<CoreWorkspaceItemImportParams>,
    ): Promise<unknown> =>
      failure(
        handlers.instructions['core.workspace.item.import'](
          importParams(overrides),
          context(JSON.stringify(overrides)),
        ),
      );
    expect(await run({ workspaceId: 'viewer' })).toEqual({
      kind: 'failed_precondition',
      code: 'core.workspace.item.readOnlyScope',
    });
    expect(await run({ worktreeId: null })).toEqual({
      kind: 'failed_precondition',
      code: 'core.workspace.item.unsupportedScope',
    });
    expect(await run({ workspaceId: 'Bad_Id' })).toEqual({
      kind: 'invalid_argument',
      code: 'core.workspace.item.invalidScope',
    });
    expect(
      await run({ workspaceId: 'w'.repeat(300), worktreeId: 't'.repeat(200) }),
    ).toEqual({
      kind: 'invalid_argument',
      code: 'core.workspace.item.invalidScope',
    });
    expect(host.imports).toEqual([]);
  });

  it('keeps an invalid scope error carrying the host error as its cause', async () => {
    const { handlers } = setup();
    let caught: unknown;
    try {
      await handlers.instructions['core.workspace.item.import'](
        importParams({ workspaceId: 'Bad_Id' }),
        context('k'),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CanopyOperationError);
    if (!(caught instanceof CanopyOperationError)) return;
    expect(caught.message).toBe('Invalid projectId: Bad_Id');
    expect(caught.runtimeCause).toBeInstanceOf(InvalidId);
  });

  it('replays a repeated key and refuses a key reused with other params', async () => {
    const { handlers, host } = setup();
    host.sources.set(handle('a'), { name: 'a.txt', sizeBytes: 1 });
    const params = importParams();
    const first = await handlers.instructions['core.workspace.item.import'](
      params,
      context('same'),
    );
    const again = await handlers.instructions['core.workspace.item.import'](
      params,
      context('same'),
    );
    expect(again).toBe(first);
    expect(host.imports).toHaveLength(1);
    expect(
      await failure(
        handlers.instructions['core.workspace.item.import'](
          importParams({ worktreeId: 'wt-2' }),
          context('same'),
        ),
      ),
    ).toEqual({
      kind: 'conflict',
      code: 'core.workspace.item.idempotencyKeyReused',
    });
  });

  describe('after cancellation', () => {
    /** A host whose copies wait until the test releases them, one by one. */
    function blockedCopies(): ReturnType<typeof setup> & {
      started: () => number;
      release: () => void;
      copying: () => Promise<void>;
    } {
      const setupResult = setup();
      const { host } = setupResult;
      const importSource = host.importSource.bind(host);
      const waiting: Array<() => void> = [];
      let notifyStarted: () => void = () => undefined;
      let started = 0;
      host.importSource = (
        scope,
        source,
      ): Promise<CoreWorkspaceAttachmentEntry> => {
        started += 1;
        notifyStarted();
        return new Promise<void>((resolve) => {
          waiting.push(resolve);
        }).then(() => importSource(scope, source));
      };
      for (const letter of ['a', 'b', 'c'])
        host.sources.set(handle(letter), {
          name: `${letter}.txt`,
          sizeBytes: 1,
        });
      return {
        ...setupResult,
        started: () => started,
        release: () => waiting.shift()?.(),
        copying: () =>
          new Promise<void>((resolve) => {
            notifyStarted = resolve;
          }),
      };
    }
    const threeSources = (): CoreWorkspaceItemImportParams =>
      importParams({
        sources: ['a', 'b', 'c'].map((letter) => ({
          kind: 'host' as const,
          handle: handle(letter),
        })),
      });
    // Lets every queued continuation of the handler run.
    const drain = (): Promise<void> =>
      new Promise((resolve) => setImmediate(resolve));

    it('starts no new copy, keeping the copy in flight and reporting the rest as not attempted', async () => {
      const { handlers, host, started, release, copying } = blockedCopies();
      const controller = new AbortController();
      const firstCopy = copying();
      const pending = handlers.instructions['core.workspace.item.import'](
        threeSources(),
        { ...context('cancel-1'), signal: controller.signal },
      );
      await firstCopy;
      controller.abort('caller');
      for (let copy = 0; copy < 3; copy += 1) {
        release();
        await drain();
      }
      expect(started()).toBe(1);
      const result = await pending;
      expect(result.outcomes).toMatchObject([
        { status: 'imported', item: { title: 'a.txt' } },
        { status: 'notAttempted' },
        { status: 'notAttempted' },
      ]);
      expect(
        host.stores.get('code-ws/wt-1')?.map((entry) => entry.name),
      ).toEqual(['a.txt']);
    });

    it('fails without any effect when cancelled before it starts, freeing the key', async () => {
      const { handlers, host } = setup();
      host.sources.set(handle('a'), { name: 'a.txt', sizeBytes: 1 });
      const controller = new AbortController();
      controller.abort('caller');
      expect(
        await failure(
          handlers.instructions['core.workspace.item.import'](importParams(), {
            ...context('cancel-2'),
            signal: controller.signal,
          }),
        ),
      ).toEqual({ kind: 'cancelled', code: undefined });
      expect(host.imports).toEqual([]);
      const retried = await handlers.instructions['core.workspace.item.import'](
        importParams(),
        context('cancel-2'),
      );
      expect(retried.outcomes).toMatchObject([{ status: 'imported' }]);
    });

    /** Item sources whose store read waits until the test releases it. */
    function blockedItemLookup(): ReturnType<typeof setup> & {
      itemId: string;
      release: () => void;
      looking: Promise<void>;
    } {
      const setupResult = setup();
      const { host } = setupResult;
      host.sources.set(handle('a'), { name: 'a.txt', sizeBytes: 1 });
      host.stores.set('cowork-ws/-', [
        {
          name: 'shared.png',
          sizeBytes: 9,
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      ]);
      const itemId = encodeWorkspaceItemId({
        kind: 'attachment',
        workspaceId: 'cowork-ws',
        worktreeId: null,
        name: 'shared.png',
      });
      if (!itemId) throw new Error('no id');
      const list = host.list.bind(host);
      let release: () => void = () => undefined;
      let notifyLooking: () => void = () => undefined;
      const looking = new Promise<void>((resolve) => {
        notifyLooking = resolve;
      });
      let blocked = true;
      host.list = (scope): Promise<readonly CoreWorkspaceAttachmentEntry[]> => {
        if (scope.workspaceId !== 'cowork-ws' || !blocked) return list(scope);
        blocked = false;
        notifyLooking();
        return new Promise<void>((resolve) => {
          release = resolve;
        }).then(() => list(scope));
      };
      return {
        ...setupResult,
        itemId,
        release: () => release(),
        looking,
      };
    }

    it('starts no copy for an item source whose lookup the abort interrupts', async () => {
      const { handlers, host, itemId, release, looking } = blockedItemLookup();
      const controller = new AbortController();
      const pending = handlers.instructions['core.workspace.item.import'](
        importParams({
          sources: [
            { kind: 'host', handle: handle('a') },
            { kind: 'item', itemId },
          ],
        }),
        { ...context('cancel-4'), signal: controller.signal },
      );
      await looking;
      controller.abort('caller');
      release();
      const result = await pending;
      expect(result.outcomes).toMatchObject([
        { status: 'imported', item: { title: 'a.txt' } },
        { status: 'notAttempted' },
      ]);
      expect(host.imports).toHaveLength(1);
    });

    it('fails without any effect when the abort interrupts the first lookup', async () => {
      const { handlers, host, itemId, release, looking } = blockedItemLookup();
      const controller = new AbortController();
      const params = importParams({ sources: [{ kind: 'item', itemId }] });
      const pending = failure(
        handlers.instructions['core.workspace.item.import'](params, {
          ...context('cancel-5'),
          signal: controller.signal,
        }),
      );
      await looking;
      controller.abort('caller');
      release();
      expect(await pending).toEqual({ kind: 'cancelled', code: undefined });
      expect(host.imports).toEqual([]);
      const retried = await handlers.instructions['core.workspace.item.import'](
        params,
        context('cancel-5'),
      );
      expect(retried.outcomes).toMatchObject([{ status: 'imported' }]);
    });

    it('stops behind the real dispatcher once it answers cancelled, and replays what landed', async () => {
      const { handlers, host, started, release, copying } = blockedCopies();
      const dispatcher = createCanopyDispatcher({
        profile: 'core',
        definitions: {
          queries: CORE_WORKSPACE_ITEM_QUERIES,
          instructions: CORE_WORKSPACE_ITEM_INSTRUCTIONS,
          streams: {},
        },
        handlers: { ...handlers, streams: {} },
      });
      const controller = new AbortController();
      const options = { caller, metadata: { idempotencyKey: 'cancel-3' } };
      const firstCopy = copying();
      const pending = failure(
        dispatcher.instruction('core.workspace.item.import', threeSources(), {
          ...options,
          signal: controller.signal,
        }),
      );
      await firstCopy;
      controller.abort();
      expect(await pending).toMatchObject({ kind: 'cancelled' });
      for (let copy = 0; copy < 3; copy += 1) {
        release();
        await drain();
      }
      expect(started()).toBe(1);
      expect(
        host.stores.get('code-ws/wt-1')?.map((entry) => entry.name),
      ).toEqual(['a.txt']);
      const replayed = await dispatcher.instruction(
        'core.workspace.item.import',
        threeSources(),
        options,
      );
      expect(replayed.outcomes.map((outcome) => outcome.status)).toEqual([
        'imported',
        'notAttempted',
        'notAttempted',
      ]);
      expect(started()).toBe(1);
    });
  });

  it('frees the key of a refused call so it can be retried', async () => {
    const { handlers } = setup();
    const refused = importParams({ workspaceId: 'viewer' });
    await failure(
      handlers.instructions['core.workspace.item.import'](
        refused,
        context('k'),
      ),
    );
    expect(
      await failure(
        handlers.instructions['core.workspace.item.import'](
          importParams({ workspaceId: 'cowork-ws', worktreeId: null }),
          context('k'),
        ),
      ),
    ).toBe('resolved');
  });
});

describe('createWorkspaceItemReplayCache', () => {
  it('evicts the oldest key past its limit', async () => {
    const replays = createWorkspaceItemReplayCache<number>(2);
    let runs = 0;
    const run = (key: string): Promise<number> =>
      replays.run(context(key), { same: true }, () =>
        Promise.resolve((runs += 1)),
      );
    await run('a');
    await run('b');
    await run('c');
    expect(await run('c')).toBe(3);
    expect(await run('a')).toBe(4);
  });

  it('keys by principal as well as key', async () => {
    const replays = createWorkspaceItemReplayCache<string>();
    const other = {
      ...context('k'),
      caller: { ...caller, principalId: 'remote-device:1' },
    };
    await replays.run(context('k'), 1, () => Promise.resolve('mine'));
    expect(await replays.run(other, 2, () => Promise.resolve('theirs'))).toBe(
      'theirs',
    );
  });
});

describe('core.workspace.item.get and list', () => {
  function seeded(): ReturnType<typeof setup> {
    const setupResult = setup();
    setupResult.host.stores.set('code-ws/wt-1', [
      { name: 'b.png', sizeBytes: 2, createdAt: '2026-10-02T00:00:00.000Z' },
      { name: 'a.txt', sizeBytes: 1, createdAt: '2026-10-01T00:00:00.000Z' },
      { name: 'c.md', sizeBytes: 3, createdAt: '2026-10-01T00:00:00.000Z' },
    ]);
    return setupResult;
  }
  const list = (
    handlers: ReturnType<typeof setup>['handlers'],
    overrides: Partial<{
      workspaceId: string;
      worktreeId: string | null;
      kinds: Array<'note' | 'prompt' | 'attachment'>;
      cursor: string | null;
      limit: number;
    }> = {},
  ): Promise<CoreWorkspaceItemListResult> =>
    Promise.resolve(
      handlers.queries['core.workspace.item.list'](
        {
          workspaceId: 'code-ws',
          worktreeId: 'wt-1',
          kinds: ['attachment'],
          cursor: null,
          limit: 500,
          ...overrides,
        },
        context(),
      ),
    );

  it('lists attachments in host order and pages by offset', async () => {
    const { handlers } = seeded();
    const all = await list(handlers);
    expect(all.items.map((item) => item.title)).toEqual([
      'b.png',
      'a.txt',
      'c.md',
    ]);
    expect(all.nextCursor).toBeNull();
    const first = await list(handlers, { limit: 2 });
    expect(first.items.map((item) => item.title)).toEqual(['b.png', 'a.txt']);
    const second = await list(handlers, { limit: 2, cursor: first.nextCursor });
    expect(second).toMatchObject({ nextCursor: null });
    expect(second.items.map((item) => item.title)).toEqual(['c.md']);
    expect(
      await failure(
        list(handlers, { worktreeId: 'wt-2', cursor: first.nextCursor }),
      ),
    ).toEqual({
      kind: 'invalid_argument',
      code: 'core.workspace.item.invalidCursor',
    });
    expect(await failure(list(handlers, { cursor: 'c1.nope.1' }))).toEqual({
      kind: 'invalid_argument',
      code: 'core.workspace.item.invalidCursor',
    });
  });

  it('gets an attachment by its ID and reports a missing one', async () => {
    const { handlers } = seeded();
    const [item] = (await list(handlers)).items;
    await expect(
      handlers.queries['core.workspace.item.get'](
        { itemId: item.itemId },
        context(),
      ),
    ).resolves.toEqual(item);
    expect(
      await failure(
        handlers.queries['core.workspace.item.get'](
          { itemId: 'attachment:code-ws@wt-1:gone.png' },
          context(),
        ),
      ),
    ).toEqual({ kind: 'not_found', code: 'core.workspace.item.notFound' });
    expect(
      await failure(
        handlers.queries['core.workspace.item.get'](
          { itemId: 'nope' },
          context(),
        ),
      ),
    ).toEqual({
      kind: 'invalid_argument',
      code: 'core.workspace.item.invalidItemId',
    });
  });

  it('gives every stored file one ID, digesting names a key cannot carry', async () => {
    const { handlers, host } = seeded();
    const store = host.stores.get('code-ws/wt-1') ?? [];
    host.stores.set('code-ws/wt-1', [
      { ...store[0], name: 'old.v1\\2' },
      ...store,
    ]);
    const { items } = await list(handlers);
    expect(items.map((item) => item.title)).toContain('old.v1\\2');
    const stored = items.find((item) => item.title === 'old.v1\\2');
    expect(stored?.itemId).toMatch(/^attachment:code-ws@wt-1:#/);
    await expect(
      handlers.queries['core.workspace.item.get'](
        { itemId: stored?.itemId ?? '' },
        context(),
      ),
    ).resolves.toEqual(stored);
    // A digest never aliases a name that is spelled out.
    const spelled = items.find((item) => item.title === 'a.txt');
    expect(spelled?.itemId).toBe('attachment:code-ws@wt-1:a.txt');
    expect(
      await failure(
        handlers.queries['core.workspace.item.get'](
          {
            itemId: `attachment:code-ws@wt-1:#${createHash('sha256').update('a.txt').digest('base64url')}`,
          },
          context(),
        ),
      ),
    ).toEqual({ kind: 'not_found', code: 'core.workspace.item.notFound' });
  });

  it('lists nothing for a code workspace level or for no kinds', async () => {
    const { handlers } = seeded();
    expect((await list(handlers, { worktreeId: null })).items).toEqual([]);
    expect((await list(handlers, { kinds: [] })).items).toEqual([]);
    expect(
      await failure(
        handlers.queries['core.workspace.item.get'](
          { itemId: 'attachment:code-ws:a.txt' },
          context(),
        ),
      ),
    ).toEqual({ kind: 'not_found', code: 'core.workspace.item.notFound' });
  });

  it('answers the viewer and unserved kinds as unavailable', async () => {
    const { handlers } = seeded();
    expect(await failure(list(handlers, { workspaceId: 'viewer' }))).toEqual({
      kind: 'capability_unavailable',
      code: 'core.workspace.item.scopeUnavailable',
    });
    expect(
      await failure(
        handlers.queries['core.workspace.item.get'](
          { itemId: 'attachment:viewer@wt-1:a.txt' },
          context(),
        ),
      ),
    ).toEqual({
      kind: 'capability_unavailable',
      code: 'core.workspace.item.scopeUnavailable',
    });
    for (const kind of ['note', 'prompt'] as const)
      expect(
        await failure(list(handlers, { kinds: ['attachment', kind] })),
      ).toEqual({
        kind: 'capability_unavailable',
        code: 'core.workspace.item.kindUnavailable',
      });
    expect(
      await failure(
        handlers.queries['core.workspace.item.get'](
          { itemId: 'prompt:code-ws:review' },
          context(),
        ),
      ),
    ).toEqual({
      kind: 'capability_unavailable',
      code: 'core.workspace.item.kindUnavailable',
    });
  });

  it('routes another kind to its provider in catalog kind order', async () => {
    const note: CoreWorkspaceItem = {
      itemId: 'note:code-ws:plan',
      workspaceId: 'code-ws',
      worktreeId: null,
      kind: 'note',
      title: 'Plan',
      content: null,
      artifactId: null,
      mediaType: 'text/markdown',
      sizeBytes: null,
      origin: {},
      revision: 7,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    const notes: CoreWorkspaceItemProvider = {
      storeKey: (scope) => (scope.worktreeId === null ? 'notes' : null),
      list: () => Promise.resolve([note]),
      get: (ref) =>
        Promise.resolve(
          ref.key.form === 'name' && ref.key.name === 'plan' ? note : null,
        ),
    };
    const { handlers, host } = setup({ providers: { note: notes } });
    host.stores.set('cowork-ws/-', []);
    expect(
      (
        await list(handlers, {
          worktreeId: null,
          kinds: ['attachment', 'note'],
        })
      ).items,
    ).toEqual([note]);
    expect((await list(handlers, { kinds: ['note'] })).items).toEqual([]);
    await expect(
      handlers.queries['core.workspace.item.get'](
        { itemId: 'note:code-ws:plan' },
        context(),
      ),
    ).resolves.toBe(note);
    expect(
      await failure(
        handlers.queries['core.workspace.item.get'](
          { itemId: 'note:viewer:plan' },
          context(),
        ),
      ),
    ).toEqual({
      kind: 'capability_unavailable',
      code: 'core.workspace.item.scopeUnavailable',
    });
  });
});
