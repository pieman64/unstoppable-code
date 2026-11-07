import { createHash } from 'node:crypto';
import type {
  CanopyCallerDescriptor,
  CoreWorkspaceItem,
  CoreWorkspaceItemUpsertParams,
} from '@canopy/protocol/canopy-core';
import { CoreWorkspaceItemSchema } from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../../runtime/errors';
import type { CanopyHandlerContext } from '../../../runtime/types';
import { encodeWorkspaceItemId } from '../workspace-item-ids';
import {
  createCoreWorkspaceItemHandlers,
  createWorkspaceItemReplayCache,
  type CoreWorkspaceAttachmentsHost,
  type CoreWorkspaceItemAdmittedScope,
  type CoreWorkspaceItemScopeHost,
} from '../workspace-items';
import {
  createWorkspaceTextItemProviders,
  workspaceTextItemRevision,
  type CoreWorkspaceTextItemDocument,
  type CoreWorkspaceTextItemKind,
  type CoreWorkspaceTextItemsHost,
} from '../workspace-note-items';

const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.workspace.read', 'core.workspace.write'],
};

let keys = 0;
function context(idempotencyKey = `key-${(keys += 1)}`): CanopyHandlerContext {
  return {
    requestId: 'request-1',
    caller,
    metadata: { idempotencyKey },
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

const noAttachments: CoreWorkspaceAttachmentsHost = {
  storeKey: () => 'attachments',
  list: () => Promise.resolve([]),
  importSource: () => Promise.reject(new Error('unused')),
  classifyFailure: () => null,
};

interface Stored {
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

const encoder = new TextEncoder();
const raw = (stored: Stored): Uint8Array =>
  encoder.encode(`${stored.title}\n${stored.body}`);

/** In-memory stores keyed like the desktop: one per workspace and kind. */
function fakeTexts(): CoreWorkspaceTextItemsHost & {
  stores: Map<string, Map<string, Stored>>;
  writes: string[];
  /** Resolved before each save completes, to hold writers open. */
  gate: { wait: () => Promise<void> };
} {
  const stores = new Map<string, Map<string, Stored>>();
  const writes: string[] = [];
  const gate = { wait: (): Promise<void> => Promise.resolve() };
  const key = (
    scope: CoreWorkspaceItemAdmittedScope,
    kind: CoreWorkspaceTextItemKind,
  ): string => `${kind}/${scope.workspaceId.replace(/^alias-/, '')}`;
  const store = (
    scope: CoreWorkspaceItemAdmittedScope,
    kind: CoreWorkspaceTextItemKind,
  ): Map<string, Stored> => {
    const existing = stores.get(key(scope, kind));
    if (existing) return existing;
    const created = new Map<string, Stored>();
    stores.set(key(scope, kind), created);
    return created;
  };
  const document = (
    name: string,
    stored: Stored,
  ): CoreWorkspaceTextItemDocument => ({
    name,
    title: stored.title,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    fileCreatedAt: '2026-01-01T00:00:00.000Z',
    fileUpdatedAt: '2026-01-02T00:00:00.000Z',
    origin: {},
    raw: raw(stored),
    content: stored.body,
  });
  let clock = 0;
  return {
    stores,
    writes,
    gate,
    storeKey: key,
    list: (scope, kind) =>
      Promise.resolve(
        [...store(scope, kind).entries()].map(([name, stored]) =>
          document(name, stored),
        ),
      ),
    read(scope, kind, name) {
      const stored = store(scope, kind).get(name);
      return Promise.resolve(stored ? document(name, stored) : null);
    },
    async save(scope, kind, input) {
      await gate.wait();
      const items = store(scope, kind);
      const base =
        input.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || 'item';
      let name = base;
      for (let counter = 2; items.has(name) && name !== input.name; counter++)
        name = `${base}-${counter}`;
      clock += 1;
      const now = new Date(Date.UTC(2026, 9, 31, 0, 0, clock)).toISOString();
      const previous = input.name === null ? undefined : items.get(input.name);
      if (input.name !== null && input.name !== name) items.delete(input.name);
      items.set(name, {
        title: input.title.trim(),
        body: input.content,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      });
      writes.push(`${kind}:${name}`);
      return name;
    },
    delete(scope, kind, name) {
      store(scope, kind).delete(name);
      writes.push(`delete ${kind}:${name}`);
      return Promise.resolve();
    },
  };
}

function setup(host = fakeTexts()): {
  host: ReturnType<typeof fakeTexts>;
  handlers: ReturnType<typeof createCoreWorkspaceItemHandlers>;
} {
  return {
    host,
    handlers: createCoreWorkspaceItemHandlers({
      scopes,
      attachments: noAttachments,
      providers: createWorkspaceTextItemProviders(host),
    }),
  };
}

function upsertParams(
  overrides: Partial<CoreWorkspaceItemUpsertParams> = {},
): CoreWorkspaceItemUpsertParams {
  return {
    itemId: null,
    workspaceId: 'code-ws',
    worktreeId: null,
    kind: 'note',
    title: 'Plan',
    content: '# Plan\n',
    artifactId: null,
    expectedRevision: null,
    originWorktreeId: null,
    ...overrides,
  };
}

async function failure(operation: unknown): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error instanceof CanopyOperationError
      ? {
          kind: error.payload.kind,
          code: error.payload.code,
          ...(error.payload.details !== undefined
            ? { details: error.payload.details }
            : {}),
        }
      : error;
  }
  return 'resolved';
}

describe('note and prompt items', () => {
  it('creates, reads, updates at the revision and renames an item', async () => {
    const { handlers } = setup();
    const upsert = handlers.instructions['core.workspace.item.upsert'];
    const get = handlers.queries['core.workspace.item.get'];
    const created = await upsert(upsertParams(), context());
    expect(CoreWorkspaceItemSchema.parse(created)).toEqual(created);
    expect(created).toMatchObject({
      itemId: 'note:code-ws:plan',
      worktreeId: null,
      kind: 'note',
      title: 'Plan',
      content: '# Plan\n',
      mediaType: 'text/markdown',
      sizeBytes: null,
      artifactId: null,
    });
    expect(await get({ itemId: created.itemId }, context())).toEqual(created);
    const updated = await upsert(
      upsertParams({
        itemId: created.itemId,
        expectedRevision: created.revision,
        content: '# Plan\nmore\n',
      }),
      context(),
    );
    expect(updated.itemId).toBe(created.itemId);
    expect(updated.revision).not.toBe(created.revision);
    expect(updated.createdAt).toBe(created.createdAt);
    const renamed = await upsert(
      upsertParams({
        itemId: updated.itemId,
        expectedRevision: updated.revision,
        title: 'Roadmap',
      }),
      context(),
    );
    expect(renamed.itemId).toBe('note:code-ws:roadmap');
    expect(await failure(get({ itemId: created.itemId }, context()))).toEqual({
      kind: 'not_found',
      code: 'core.workspace.item.notFound',
    });
  });

  it('keeps the revision for an unchanged rewrite and derives it from title and bytes', async () => {
    const { handlers } = setup();
    const upsert = handlers.instructions['core.workspace.item.upsert'];
    const created = await upsert(upsertParams(), context());
    const same = await upsert(
      upsertParams({
        itemId: created.itemId,
        expectedRevision: created.revision,
      }),
      context(),
    );
    expect(same.revision).toBe(created.revision);
    const bytes = encoder.encode('Plan\n# Plan\n');
    expect(created.revision).toBe(
      workspaceTextItemRevision('note', 'Plan', bytes),
    );
    expect(workspaceTextItemRevision('prompt', 'Plan', bytes)).not.toBe(
      created.revision,
    );
    expect(workspaceTextItemRevision('note', 'Plan!', bytes)).not.toBe(
      created.revision,
    );
    expect(Number.isSafeInteger(created.revision)).toBe(true);
  });

  it('refuses a stale revision with its current revision and writes nothing', async () => {
    const { handlers, host } = setup();
    const upsert = handlers.instructions['core.workspace.item.upsert'];
    const created = await upsert(upsertParams(), context());
    const updated = await upsert(
      upsertParams({
        itemId: created.itemId,
        expectedRevision: created.revision,
        content: 'two',
      }),
      context(),
    );
    host.writes.length = 0;
    expect(
      await failure(
        upsert(
          upsertParams({
            itemId: created.itemId,
            expectedRevision: created.revision,
            content: 'stale',
          }),
          context(),
        ),
      ),
    ).toEqual({
      kind: 'conflict',
      code: 'core.workspace.item.revisionConflict',
      details: { currentRevision: updated.revision },
    });
    expect(
      await failure(
        handlers.instructions['core.workspace.item.delete'](
          { itemId: created.itemId, expectedRevision: created.revision },
          context(),
        ),
      ),
    ).toMatchObject({ code: 'core.workspace.item.revisionConflict' });
    expect(host.writes).toEqual([]);
  });

  it('serializes concurrent in-process upserts of one item: one wins, one conflicts', async () => {
    const { handlers, host } = setup();
    const upsert = handlers.instructions['core.workspace.item.upsert'];
    const created = await upsert(upsertParams(), context());
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    host.gate.wait = (): Promise<void> => held;
    const first = upsert(
      upsertParams({
        itemId: created.itemId,
        expectedRevision: created.revision,
        content: 'first',
      }),
      context(),
    );
    const second = failure(
      upsert(
        upsertParams({
          itemId: created.itemId,
          expectedRevision: created.revision,
          content: 'second',
        }),
        context(),
      ),
    );
    release();
    await expect(first).resolves.toMatchObject({ content: 'first' });
    expect(await second).toMatchObject({
      code: 'core.workspace.item.revisionConflict',
    });
    expect(host.stores.get('note/code-ws')?.get('plan')?.body).toBe('first');
  });

  it('shares one lock between aliases of a store', async () => {
    const { handlers, host } = setup();
    const upsert = handlers.instructions['core.workspace.item.upsert'];
    const created = await upsert(upsertParams(), context());
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    host.gate.wait = (): Promise<void> => held;
    const viaAlias = upsert(
      upsertParams({ workspaceId: 'alias-code-ws', title: 'Other' }),
      context(),
    );
    const deleted = handlers.instructions['core.workspace.item.delete'](
      { itemId: created.itemId, expectedRevision: created.revision },
      context(),
    );
    // A full turn of the event loop: an unserialized delete would land now.
    await new Promise((resolve) => setImmediate(resolve));
    expect(host.writes).toEqual(['note:plan']);
    release();
    await viaAlias;
    await deleted;
    expect(host.writes).toEqual([
      'note:plan',
      'note:other',
      'delete note:plan',
    ]);
  });

  it('deletes at the current revision and then answers notFound', async () => {
    const { handlers } = setup();
    const created = await handlers.instructions['core.workspace.item.upsert'](
      upsertParams({ kind: 'prompt', title: 'Review' }),
      context(),
    );
    const remove = handlers.instructions['core.workspace.item.delete'];
    await expect(
      remove(
        { itemId: created.itemId, expectedRevision: created.revision },
        context(),
      ),
    ).resolves.toEqual({ deleted: true });
    expect(
      await failure(
        remove(
          { itemId: created.itemId, expectedRevision: created.revision },
          context(),
        ),
      ),
    ).toEqual({ kind: 'not_found', code: 'core.workspace.item.notFound' });
  });

  it('pins the request refusals before any write', async () => {
    const { handlers, host } = setup();
    const upsert = handlers.instructions['core.workspace.item.upsert'];
    const remove = handlers.instructions['core.workspace.item.delete'];
    const created = await upsert(upsertParams(), context());
    host.writes.length = 0;
    const refusals = {
      worktreeScope: await failure(
        upsert(upsertParams({ worktreeId: 'wt-1' }), context()),
      ),
      viewer: await failure(
        upsert(upsertParams({ workspaceId: 'viewer' }), context()),
      ),
      invalidScope: await failure(
        upsert(upsertParams({ workspaceId: 'Bad_Id' }), context()),
      ),
      attachment: await failure(
        upsert(upsertParams({ kind: 'attachment' }), context()),
      ),
      nullContent: await failure(
        upsert(upsertParams({ content: null }), context()),
      ),
      artifact: await failure(
        upsert(upsertParams({ artifactId: 'artifact-1' }), context()),
      ),
      idWithoutRevision: await failure(
        upsert(upsertParams({ itemId: created.itemId }), context()),
      ),
      revisionWithoutId: await failure(
        upsert(upsertParams({ expectedRevision: 0 }), context()),
      ),
      malformedId: await failure(
        upsert(
          upsertParams({ itemId: 'nope', expectedRevision: 0 }),
          context(),
        ),
      ),
      otherKindId: await failure(
        upsert(
          upsertParams({ itemId: 'prompt:code-ws:plan', expectedRevision: 0 }),
          context(),
        ),
      ),
      otherScopeId: await failure(
        upsert(
          upsertParams({ itemId: 'note:other-ws:plan', expectedRevision: 0 }),
          context(),
        ),
      ),
      missing: await failure(
        upsert(
          upsertParams({ itemId: 'note:code-ws:gone', expectedRevision: 0 }),
          context(),
        ),
      ),
      deleteMalformed: await failure(
        remove({ itemId: 'nope', expectedRevision: 0 }, context()),
      ),
      deleteAttachment: await failure(
        remove(
          { itemId: 'attachment:cowork-ws:a.png', expectedRevision: 0 },
          context(),
        ),
      ),
      deleteViewer: await failure(
        remove({ itemId: 'note:viewer:plan', expectedRevision: 0 }, context()),
      ),
      deleteWorktreeScope: await failure(
        remove(
          { itemId: 'note:code-ws@wt-1:plan', expectedRevision: 0 },
          context(),
        ),
      ),
    };
    expect(refusals).toEqual({
      worktreeScope: {
        kind: 'failed_precondition',
        code: 'core.workspace.item.unsupportedScope',
      },
      viewer: {
        kind: 'failed_precondition',
        code: 'core.workspace.item.readOnlyScope',
      },
      invalidScope: {
        kind: 'invalid_argument',
        code: 'core.workspace.item.invalidScope',
      },
      attachment: {
        kind: 'capability_unavailable',
        code: 'core.workspace.item.kindUnavailable',
      },
      nullContent: { kind: 'invalid_argument', code: undefined },
      artifact: { kind: 'invalid_argument', code: undefined },
      idWithoutRevision: { kind: 'invalid_argument', code: undefined },
      revisionWithoutId: { kind: 'invalid_argument', code: undefined },
      malformedId: {
        kind: 'invalid_argument',
        code: 'core.workspace.item.invalidItemId',
      },
      otherKindId: {
        kind: 'invalid_argument',
        code: 'core.workspace.item.invalidItemId',
      },
      otherScopeId: {
        kind: 'invalid_argument',
        code: 'core.workspace.item.invalidItemId',
      },
      missing: { kind: 'not_found', code: 'core.workspace.item.notFound' },
      deleteMalformed: {
        kind: 'invalid_argument',
        code: 'core.workspace.item.invalidItemId',
      },
      deleteAttachment: {
        kind: 'capability_unavailable',
        code: 'core.workspace.item.kindUnavailable',
      },
      deleteViewer: {
        kind: 'failed_precondition',
        code: 'core.workspace.item.readOnlyScope',
      },
      deleteWorktreeScope: {
        kind: 'not_found',
        code: 'core.workspace.item.notFound',
      },
    });
    expect(host.writes).toEqual([]);
  });

  it('replays a repeated key and refuses one reused with other params', async () => {
    const { handlers, host } = setup();
    const upsert = handlers.instructions['core.workspace.item.upsert'];
    const first = await upsert(upsertParams(), context('same'));
    expect(await upsert(upsertParams(), context('same'))).toBe(first);
    expect(host.writes).toEqual(['note:plan']);
    expect(
      await failure(upsert(upsertParams({ title: 'Other' }), context('same'))),
    ).toEqual({
      kind: 'conflict',
      code: 'core.workspace.item.idempotencyKeyReused',
    });
  });

  it('replays a key whose read-back failed after the save by reading again, never saving twice', async () => {
    const { handlers, host } = setup();
    const upsert = handlers.instructions['core.workspace.item.upsert'];
    const read = host.read.bind(host);
    const readFailures: Array<'throw' | 'missing'> = ['throw', 'missing'];
    let reads = 0;
    host.read = (
      scope,
      kind,
      name,
    ): Promise<CoreWorkspaceTextItemDocument | null> => {
      reads += 1;
      const next = readFailures.shift();
      if (next === 'throw') return Promise.reject(new Error('EIO'));
      if (next === 'missing') return Promise.resolve(null);
      return read(scope, kind, name);
    };
    // A failed read advises the same-key repeat; a missing item does not.
    const readFailed: unknown = await Promise.resolve(
      upsert(upsertParams(), context('flaky')),
    ).catch((error: unknown) => error);
    expect(readFailed).toBeInstanceOf(CanopyOperationError);
    if (!(readFailed instanceof CanopyOperationError)) return;
    expect(readFailed.payload).toMatchObject({
      kind: 'internal',
      retry: { kind: 'same_idempotency_key' },
    });
    expect(readFailed.runtimeCause).toEqual(new Error('EIO'));
    await expect(
      upsert(upsertParams(), context('flaky')),
    ).rejects.toMatchObject({
      payload: { kind: 'internal', retry: { kind: 'never' } },
    });
    // Concurrent repeats share one read-back.
    const [item, again] = await Promise.all([
      upsert(upsertParams(), context('flaky')),
      upsert(upsertParams(), context('flaky')),
    ]);
    expect(item).toMatchObject({ itemId: 'note:code-ws:plan', title: 'Plan' });
    expect(again).toBe(item);
    expect(await upsert(upsertParams(), context('flaky'))).toBe(item);
    expect(reads).toBe(3);
    expect(host.writes).toEqual(['note:plan']);
    expect([...(host.stores.get('note/code-ws')?.keys() ?? [])]).toEqual([
      'plan',
    ]);
    expect(
      await failure(upsert(upsertParams({ title: 'Other' }), context('flaky'))),
    ).toEqual({
      kind: 'conflict',
      code: 'core.workspace.item.idempotencyKeyReused',
    });
  });

  it('lists notes and prompts of the workspace scope in store order, without content', async () => {
    const { handlers } = setup();
    const upsert = handlers.instructions['core.workspace.item.upsert'];
    await upsert(upsertParams({ title: 'B' }), context());
    await upsert(upsertParams({ title: 'A' }), context());
    await upsert(upsertParams({ kind: 'prompt', title: 'P' }), context());
    const list = handlers.queries['core.workspace.item.list'];
    const listed = await list(
      {
        workspaceId: 'code-ws',
        worktreeId: null,
        kinds: ['prompt', 'note'],
        cursor: null,
        limit: 500,
      },
      context(),
    );
    expect(
      listed.items.map((item: CoreWorkspaceItem) => [
        item.itemId,
        item.content,
      ]),
    ).toEqual([
      ['note:code-ws:b', null],
      ['note:code-ws:a', null],
      ['prompt:code-ws:p', null],
    ]);
    expect(
      (
        await list(
          {
            workspaceId: 'code-ws',
            worktreeId: 'wt-1',
            kinds: ['note', 'prompt'],
            cursor: null,
            limit: 500,
          },
          context(),
        )
      ).items,
    ).toEqual([]);
  });

  it('cuts long titles, falls back for bad times, skips nameless files and refuses oversized content', async () => {
    const host = fakeTexts();
    const store = new Map<string, Stored>([
      [
        'long',
        {
          title: `${'t'.repeat(511)}😀tail`,
          body: 'x'.repeat(2_000_001),
          createdAt: 'not-a-date',
          updatedAt: 'yesterday',
        },
      ],
      [
        '',
        {
          title: 'Nameless',
          body: '',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      [
        'blank-title',
        {
          title: '',
          body: '',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    ]);
    host.stores.set('note/code-ws', store);
    const { handlers } = setup(host);
    const listed = await handlers.queries['core.workspace.item.list'](
      {
        workspaceId: 'code-ws',
        worktreeId: null,
        kinds: ['note'],
        cursor: null,
        limit: 500,
      },
      context(),
    );
    for (const item of listed.items) CoreWorkspaceItemSchema.parse(item);
    expect(listed.items.map((item: CoreWorkspaceItem) => item.itemId)).toEqual([
      'note:code-ws:long',
      'note:code-ws:blank-title',
    ]);
    const [long, blank] = listed.items;
    expect(long.title).toBe('t'.repeat(511));
    expect(long.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(long.updatedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(blank.title).toBe('blank title');
    expect(
      await failure(
        handlers.queries['core.workspace.item.get'](
          { itemId: 'note:code-ws:long' },
          context(),
        ),
      ),
    ).toEqual({ kind: 'resource_exhausted', code: undefined });
  });

  it('resolves a digest-form ID by listing the store', async () => {
    const host = fakeTexts();
    const name = 'n'.repeat(600);
    host.stores.set(
      'note/code-ws',
      new Map([
        [
          name,
          {
            title: 'Long name',
            body: 'body',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      ]),
    );
    const { handlers } = setup(host);
    const itemId = encodeWorkspaceItemId({
      kind: 'note',
      workspaceId: 'code-ws',
      worktreeId: null,
      name,
    });
    if (itemId === null) throw new Error('no id');
    expect(itemId).toContain('#');
    const item = await handlers.queries['core.workspace.item.get'](
      { itemId },
      context(),
    );
    expect(item).toMatchObject({ itemId, content: 'body' });
    await expect(
      handlers.instructions['core.workspace.item.delete'](
        { itemId, expectedRevision: item.revision },
        context(),
      ),
    ).resolves.toEqual({ deleted: true });
  });

  it('gives a name a key cannot carry its one digest ID and no alias', async () => {
    const host = fakeTexts();
    const stored = {
      title: 'Hand made',
      body: 'body',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    host.stores.set(
      'note/code-ws',
      new Map([
        ['a\\b', stored],
        ['plan', stored],
      ]),
    );
    const { handlers } = setup(host);
    const listed = await handlers.queries['core.workspace.item.list'](
      {
        workspaceId: 'code-ws',
        worktreeId: null,
        kinds: ['note'],
        cursor: null,
        limit: 500,
      },
      context(),
    );
    const [digested, plan] = listed.items;
    expect(digested.itemId).toMatch(/^note:code-ws:#[A-Za-z0-9_-]{43}$/);
    expect(plan.itemId).toBe('note:code-ws:plan');
    const get = handlers.queries['core.workspace.item.get'];
    await expect(
      get({ itemId: digested.itemId }, context()),
    ).resolves.toMatchObject({ itemId: digested.itemId, content: 'body' });
    const planDigest = createHash('sha256')
      .update('plan', 'utf8')
      .digest('base64url');
    const alias = `note:code-ws:#${planDigest}`;
    expect(await failure(get({ itemId: alias }, context()))).toEqual({
      kind: 'not_found',
      code: 'core.workspace.item.notFound',
    });
    expect(
      await failure(
        handlers.instructions['core.workspace.item.delete'](
          { itemId: alias, expectedRevision: plan.revision },
          context(),
        ),
      ),
    ).toEqual({ kind: 'not_found', code: 'core.workspace.item.notFound' });
    expect(host.stores.get('note/code-ws')?.has('plan')).toBe(true);
  });

  it('writes nothing for a call aborted while it waits for the store, and frees its key', async () => {
    const { handlers, host } = setup();
    const upsert = handlers.instructions['core.workspace.item.upsert'];
    const remove = handlers.instructions['core.workspace.item.delete'];
    const created = await upsert(upsertParams(), context());
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    host.gate.wait = (): Promise<void> => held;
    const holder = upsert(upsertParams({ title: 'Holder' }), context());
    const aborted = new AbortController();
    const abortedContext = (key: string): CanopyHandlerContext => ({
      ...context(key),
      signal: aborted.signal,
    });
    const queuedUpsert = failure(
      upsert(upsertParams({ title: 'Queued' }), abortedContext('queued')),
    );
    const queuedDelete = failure(
      remove(
        { itemId: created.itemId, expectedRevision: created.revision },
        abortedContext('queued-delete'),
      ),
    );
    aborted.abort('caller');
    release();
    await holder;
    expect(await queuedUpsert).toEqual({ kind: 'cancelled', code: undefined });
    expect(await queuedDelete).toEqual({ kind: 'cancelled', code: undefined });
    expect(host.writes).toEqual(['note:plan', 'note:holder']);
    // A refused call does not hold its key: repeating it runs the write.
    await expect(
      upsert(upsertParams({ title: 'Queued' }), context('queued')),
    ).resolves.toMatchObject({ itemId: 'note:code-ws:queued' });
  });

  it('frees an aborted call key at once, so a retry queued behind its store writes', async () => {
    const { handlers, host } = setup();
    const upsert = handlers.instructions['core.workspace.item.upsert'];
    const remove = handlers.instructions['core.workspace.item.delete'];
    const created = await upsert(upsertParams(), context());
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    host.gate.wait = (): Promise<void> => held;
    const holder = upsert(upsertParams({ title: 'Holder' }), context());
    const aborted = new AbortController();
    const abortedContext = (key: string): CanopyHandlerContext => ({
      ...context(key),
      signal: aborted.signal,
    });
    const deleteParams = {
      itemId: created.itemId,
      expectedRevision: created.revision,
    };
    const queuedUpsert = failure(
      upsert(upsertParams({ title: 'Queued' }), abortedContext('queued')),
    );
    const queuedDelete = failure(
      remove(deleteParams, abortedContext('queued-delete')),
    );
    // A deadline answers `same_idempotency_key`; the retry arrives while the
    // aborted calls still wait for the store.
    aborted.abort('deadline');
    expect(await queuedUpsert).toEqual({ kind: 'cancelled', code: undefined });
    expect(await queuedDelete).toEqual({ kind: 'cancelled', code: undefined });
    const retriedUpsert = upsert(
      upsertParams({ title: 'Queued' }),
      context('queued'),
    );
    const retriedDelete = remove(deleteParams, context('queued-delete'));
    release();
    await holder;
    await expect(retriedUpsert).resolves.toMatchObject({
      itemId: 'note:code-ws:queued',
    });
    await expect(retriedDelete).resolves.toEqual({ deleted: true });
    expect(host.writes).toEqual([
      'note:plan',
      'note:holder',
      'note:queued',
      'delete note:plan',
    ]);
  });

  it('completes a write already in progress when its call is aborted', async () => {
    const { handlers, host } = setup();
    const upsert = handlers.instructions['core.workspace.item.upsert'];
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    host.gate.wait = (): Promise<void> => {
      started();
      return held;
    };
    const aborted = new AbortController();
    const call = upsert(upsertParams(), {
      ...context('in-progress'),
      signal: aborted.signal,
    });
    await writing;
    aborted.abort('caller');
    release();
    const item = await call;
    expect(item).toMatchObject({ itemId: 'note:code-ws:plan' });
    expect(host.writes).toEqual(['note:plan']);
    expect(await upsert(upsertParams(), context('in-progress'))).toBe(item);
  });
});

describe('workspace item router replay after a committed write', () => {
  it('keeps a key whose call failed after commit and repeats only its finish', async () => {
    const replays = createWorkspaceItemReplayCache<string>();
    let effects = 0;
    let finishes = 0;
    let finishFails = true;
    const run = (key: string): Promise<string> =>
      replays.run(context(key), { same: true }, (commit) => {
        effects += 1;
        commit(() => {
          finishes += 1;
          return finishFails
            ? Promise.reject(new Error('still unreadable'))
            : Promise.resolve('finished');
        });
        return Promise.reject(new Error('unreadable'));
      });
    await expect(run('k')).rejects.toThrow('unreadable');
    await expect(run('k')).rejects.toThrow('still unreadable');
    finishFails = false;
    expect(await run('k')).toBe('finished');
    expect(await run('k')).toBe('finished');
    expect([effects, finishes]).toEqual([1, 2]);
    await expect(
      replays.run(context('k'), { other: true }, () => Promise.resolve('x')),
    ).rejects.toMatchObject({
      payload: { code: 'core.workspace.item.idempotencyKeyReused' },
    });
    // A failure before commit still frees the key.
    let attempts = 0;
    const uncommitted = (): Promise<string> =>
      replays.run(context('u'), 1, () =>
        (attempts += 1) === 1
          ? Promise.reject(new Error('refused'))
          : Promise.resolve('ran'),
      );
    await expect(uncommitted()).rejects.toThrow('refused');
    expect(await uncommitted()).toBe('ran');
  });
});
