import {
  CANOPY_STREAM_DEFINITIONS,
  composeCanopyOperationEnvelopes,
  WorkerFilesystemWatchEndSchema,
  WorkerFilesystemWatchItemSchema,
  WorkerFilesystemWatchParamsSchema,
} from '../index';

const definition = CANOPY_STREAM_DEFINITIONS['worker.filesystem.watch'];
const envelopes = composeCanopyOperationEnvelopes(
  'worker.filesystem.watch',
  definition,
);
const cursor = { daemonEpoch: 'epoch-1', sequence: 4 };
const item = {
  changeId: 'epoch-1:5',
  kind: 'modified',
  relativePath: 'src/index.ts',
  previousRelativePath: null,
  version: null,
  occurredAt: '2026-10-23T12:00:00.000Z',
};

describe('worker.filesystem.watch protocol fixtures', () => {
  it('declares a target-selectable worker stream behind the read grant', () => {
    expect(definition).toMatchObject({
      kind: 'stream',
      plane: 'worker',
      domain: 'filesystem',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'inherent',
      requiredGrants: ['worker.filesystem.read'],
    });
  });

  it('accepts open requests for both subjects and a resume cursor', () => {
    for (const params of [
      { scope: { workspaceId: 'w', worktreeId: 't' }, fileRootId: 'repo' },
      {
        scope: { workspaceId: 'w', worktreeId: 't' },
        fileRootId: 'repo',
        subject: 'gitHead',
        cursor: null,
      },
      {
        scope: { workspaceId: 'w' },
        fileRootId: 'attachments',
        subject: 'tree',
        relativePaths: ['docs'],
        cursor,
      },
    ])
      expect(
        envelopes.request.safeParse({
          jsonrpc: '2.0',
          id: 1,
          method: 'worker.filesystem.watch',
          params,
        }).success,
      ).toBe(true);
  });

  it.each([
    { subject: 'index' },
    { hostPath: '/repo' },
    { cursor: { daemonEpoch: 'e', sequence: -1 } },
    { fileRootId: '' },
  ])('rejects malformed open params: %j', (fields) => {
    expect(
      WorkerFilesystemWatchParamsSchema.safeParse({
        scope: { workspaceId: 'w', worktreeId: 't' },
        fileRootId: 'repo',
        ...fields,
      }).success,
    ).toBe(false);
  });

  it('opens with an accepted cursor and additive result fields', () => {
    expect(
      envelopes.response.safeParse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          subscriptionId: 'canopy-request-1',
          acceptedCursor: cursor,
          future: true,
        },
      }).success,
    ).toBe(true);
  });

  it('carries additive item fields, including eventCount', () => {
    expect(
      WorkerFilesystemWatchItemSchema.parse({
        ...item,
        eventCount: 3,
        future: 'kept',
      }),
    ).toEqual({ ...item, eventCount: 3, future: 'kept' });
    expect(WorkerFilesystemWatchItemSchema.parse(item)).toEqual(item);
    expect(
      WorkerFilesystemWatchItemSchema.safeParse({ ...item, eventCount: 0 })
        .success,
    ).toBe(false);
  });

  it('refuses host paths in items', () => {
    for (const field of ['absolutePath', 'hostPath'])
      expect(
        WorkerFilesystemWatchItemSchema.safeParse({ ...item, [field]: '/x' })
          .success,
      ).toBe(false);
  });

  it('wraps items and terminal frames in stream notifications', () => {
    expect(
      envelopes.notification?.safeParse({
        jsonrpc: '2.0',
        method: 'worker.filesystem.watch.item',
        params: {
          subscriptionId: 's',
          cursor: { daemonEpoch: 'epoch-1', sequence: 5 },
          itemId: 'epoch-1:5',
          occurredAt: item.occurredAt,
          item: { ...item, kind: 'overflow', relativePath: '', eventCount: 9 },
        },
      }).success,
    ).toBe(true);
    expect(
      envelopes.notification?.safeParse({
        jsonrpc: '2.0',
        method: 'worker.filesystem.watch.end',
        params: {
          subscriptionId: 's',
          cursor,
          outcome: 'cancelled',
          error: null,
        },
      }).success,
    ).toBe(true);
  });

  it('ends a replay that cannot resume with snapshotRequired', () => {
    expect(
      WorkerFilesystemWatchEndSchema.safeParse({
        cursor,
        outcome: 'error',
        error: {
          kind: 'failed_precondition',
          code: 'worker.filesystem.watch.snapshotRequired',
          message: 'Rescan.',
          retry: { kind: 'after_refresh', resource: 'filesystem-watch' },
        },
      }).success,
    ).toBe(true);
  });

  it('uses operation-scoped error codes and query retries only', () => {
    for (const code of [
      'worker.filesystem.watch.invalidState',
      'worker.filesystem.watch.notFound',
      'worker.filesystem.watch.snapshotRequired',
    ])
      expect(
        definition.error.safeParse({
          kind: 'not_found',
          code,
          message: 'x',
          retry: { kind: 'never' },
        }).success,
      ).toBe(true);
    expect(
      definition.error.safeParse({
        kind: 'not_found',
        code: 'worker.filesystem.notFound',
        message: 'x',
        retry: { kind: 'never' },
      }).success,
    ).toBe(false);
    expect(
      definition.error.safeParse({
        kind: 'unavailable',
        message: 'x',
        retry: { kind: 'same_idempotency_key' },
      }).success,
    ).toBe(false);
  });
});
