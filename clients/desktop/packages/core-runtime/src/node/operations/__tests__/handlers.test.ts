import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OPERATION_INSTRUCTION_DEFINITIONS,
  OPERATION_QUERY_DEFINITIONS,
  OPERATION_STREAM_DEFINITIONS,
  type CanopyCallerDescriptor,
  type CanopyStreamCursor,
  type CoreOperationEventsItem,
} from '@canopy/protocol/canopy-core';

import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import type {
  CanopyDispatcher,
  CanopyStreamFrame,
} from '../../../runtime/types';
import {
  OperationService,
  createCoreOperationHandlers,
  type OperationDomain,
} from '..';
import { OperationLedger, type OperationAcceptRequest } from '../ledger';

let dir: string;
let dbPath: string;
let opened: number;
let services: OperationService[];

const pipelines: OperationDomain & { cancelled: string[] } = {
  domain: 'pipeline',
  kinds: ['core.pipeline.run'],
  restartClass: 'resumable',
  cancelled: [],
  cancel(operation): Promise<'cancelled'> {
    this.cancelled.push(operation.operationId);
    return Promise.resolve('cancelled');
  },
  recover: () => Promise.resolve({ status: 'running' }),
};

function client(
  clientInstanceId: string,
  grants: CanopyCallerDescriptor['grants'] = [
    'core.operation.read',
    'core.operation.cancel',
  ],
): CanopyCallerDescriptor {
  return {
    principalId: `user-${clientInstanceId}`,
    clientInstanceId,
    authorityId: 'local-desktop',
    interfaceKind: 'test',
    grants,
  };
}

function createCore(): {
  service: OperationService;
  dispatcher: OperationDispatcher;
} {
  const service = new OperationService({
    openLedger: (): OperationLedger => {
      opened += 1;
      return OperationLedger.open(dbPath);
    },
  });
  service.registerDomain(pipelines);
  services.push(service);
  return { service, dispatcher: dispatcherFor(service) };
}

type OperationDispatcher = CanopyDispatcher<
  typeof OPERATION_QUERY_DEFINITIONS,
  typeof OPERATION_INSTRUCTION_DEFINITIONS,
  typeof OPERATION_STREAM_DEFINITIONS
>;

function dispatcherFor(service: OperationService): OperationDispatcher {
  const handlers = createCoreOperationHandlers(service);
  return createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: OPERATION_QUERY_DEFINITIONS,
      instructions: OPERATION_INSTRUCTION_DEFINITIONS,
      streams: OPERATION_STREAM_DEFINITIONS,
    },
    handlers,
  });
}

function admission(
  overrides: Partial<OperationAcceptRequest> = {},
): OperationAcceptRequest {
  return {
    kind: 'core.pipeline.run',
    status: 'running',
    origin: { kind: 'client', sourceId: 'window-a' },
    owner: { kind: 'organization', id: 'org-1' },
    scope: { workspaceId: 'alpha', worktreeId: 'main', executionId: 'exec-1' },
    receipt: {
      caller: 'user-a',
      idempotencyKey: 'run-1',
      fingerprint: 'params',
    },
    ...overrides,
  };
}

type Frame = CanopyStreamFrame<CoreOperationEventsItem, object>;

function collect(handle: {
  onFrame(listener: (frame: Frame) => void): () => void;
}): Frame[] {
  const frames: Frame[] = [];
  handle.onFrame((frame) => frames.push(frame));
  return frames;
}

const items = (frames: Frame[]): string[] =>
  frames.flatMap((frame) =>
    frame.kind === 'item'
      ? [`${frame.item.event}:${frame.item.operation.status}`]
      : [],
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'operation-handlers-'));
  dbPath = join(dir, 'operation-ledger.sqlite');
  opened = 0;
  services = [];
  pipelines.cancelled.length = 0;
});

afterEach(() => {
  for (const service of services) service.close();
  rmSync(dir, { recursive: true, force: true });
});

it('denies a caller without the grant before the ledger is opened', async () => {
  const { dispatcher } = createCore();
  await expect(
    dispatcher.query(
      'core.operation.list',
      {},
      { caller: client('a', ['core.operation.cancel']) },
    ),
  ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
  await expect(
    dispatcher.instruction(
      'core.operation.cancel',
      { operationId: 'x', reason: 'Stop' },
      { caller: client('a', ['core.operation.read']) },
    ),
  ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
  expect(opened).toBe(0);
});

it('rehydrates accepted work, with owner and receipt, in another client', async () => {
  const { service, dispatcher } = createCore();
  const { operation } = await service.admit(admission());

  const got = await dispatcher.query(
    'core.operation.get',
    { operationId: operation.operationId },
    { caller: client('b') },
  );
  expect(got.operation).toMatchObject({
    operationId: operation.operationId,
    status: 'running',
    owner: { kind: 'organization', id: 'org-1' },
    origin: { kind: 'client', sourceId: 'window-a' },
    receipt: { idempotencyKey: 'run-1', outcome: 'pending' },
    scope: { executionId: 'exec-1' },
  });

  const listed = await dispatcher.query(
    'core.operation.list',
    { scope: { workspaceId: 'alpha' }, statuses: ['running'] },
    { caller: client('b') },
  );
  expect(listed.items.map((item) => item.operationId)).toEqual([
    operation.operationId,
  ]);
  expect(listed.eventsCursor).toEqual({
    daemonEpoch: (await service.ready()).ledgerId,
    sequence: 1,
  });
  expect(
    (
      await dispatcher.query(
        'core.operation.list',
        { scope: { workspaceId: 'bravo' } },
        { caller: client('b') },
      )
    ).items,
  ).toEqual([]);
});

it('pages with an opaque cursor and rejects a forged one', async () => {
  const { service, dispatcher } = createCore();
  for (const key of ['1', '2', '3'])
    await service.admit(
      admission({
        receipt: { caller: 'user-a', idempotencyKey: key, fingerprint: 'p' },
      }),
    );
  const first = await dispatcher.query(
    'core.operation.list',
    { pageSize: 2 },
    { caller: client('b') },
  );
  expect(first.items).toHaveLength(2);
  const second = await dispatcher.query(
    'core.operation.list',
    { pageSize: 2, cursor: first.nextCursor ?? undefined },
    { caller: client('b') },
  );
  expect(second).toMatchObject({ nextCursor: null });
  expect(second.items).toHaveLength(1);
  await expect(
    dispatcher.query(
      'core.operation.list',
      { cursor: 'not-a-cursor' },
      { caller: client('b') },
    ),
  ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
  const forged = Buffer.from(
    JSON.stringify(['yesterday', 'op-1']),
    'utf8',
  ).toString('base64url');
  await expect(
    dispatcher.query(
      'core.operation.list',
      { cursor: forged },
      { caller: client('b') },
    ),
  ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
});

it('reports a missing operation with its typed code', async () => {
  const { dispatcher } = createCore();
  await expect(
    dispatcher.query(
      'core.operation.get',
      { operationId: 'missing' },
      { caller: client('b') },
    ),
  ).rejects.toMatchObject({
    payload: {
      kind: 'not_found',
      code: 'core.operation.notFound',
      details: { reason: 'NOT_FOUND' },
    },
  });
});

it('cancels from another client, and a disconnect releases only the client', async () => {
  const { service, dispatcher } = createCore();
  const { operation } = await service.admit(admission());
  const { eventsCursor } = await dispatcher.query(
    'core.operation.list',
    {},
    { caller: client('a') },
  );

  // Client A watches, then disconnects.
  const watching = await dispatcher.openStream(
    'core.operation.events',
    { operationIds: [operation.operationId], cursor: eventsCursor },
    { caller: client('a') },
  );
  const seenByA = collect(watching);
  await service.transition(operation.operationId, 'paused');
  watching.close();
  await new Promise((resolve) => setImmediate(resolve));
  expect(items(seenByA)).toEqual(['paused:paused']);
  const lastCursor = seenByA.find((frame) => frame.kind === 'item')?.cursor;
  expect(await service.get(operation.operationId)).toMatchObject({
    status: 'paused',
    cancellation: null,
  });

  // Client B rehydrates and cancels; the domain's rules apply.
  const cancelled = await dispatcher.instruction(
    'core.operation.cancel',
    {
      operationId: operation.operationId,
      reason: 'Not needed',
      expectedRevision: 2,
    },
    { caller: client('b') },
  );
  expect(cancelled).toMatchObject({
    outcome: 'cancelled',
    operation: {
      status: 'cancelled',
      cancellation: { requestedBy: 'user-b', reason: 'Not needed' },
    },
  });
  expect(pipelines.cancelled).toEqual([operation.operationId]);

  // Client A reconnects from its last cursor and misses nothing.
  const resumed = await dispatcher.openStream(
    'core.operation.events',
    { operationIds: [operation.operationId], cursor: lastCursor },
    { caller: client('a') },
  );
  const seenAfter = collect(resumed);
  await new Promise((resolve) => setImmediate(resolve));
  expect(items(seenAfter)).toEqual([
    'cancelRequested:paused',
    'cancelled:cancelled',
  ]);
  resumed.close();
});

it('refuses a stale cancel with the current revision', async () => {
  const { service, dispatcher } = createCore();
  const { operation } = await service.admit(admission());
  await expect(
    dispatcher.instruction(
      'core.operation.cancel',
      {
        operationId: operation.operationId,
        reason: 'Stop',
        expectedRevision: 9,
      },
      { caller: client('b') },
    ),
  ).rejects.toMatchObject({
    payload: {
      kind: 'conflict',
      code: 'core.operation.revisionConflict',
      details: { reason: 'REVISION_CONFLICT', currentRevision: 1 },
      retry: { kind: 'after_refresh', resource: 'core.operation.list' },
    },
  });
  expect(pipelines.cancelled).toEqual([]);
});

it('resumes events across a restart from a cursor of the previous process', async () => {
  const first = createCore();
  const { operation } = await first.service.admit(admission());
  const { eventsCursor } = await first.dispatcher.query(
    'core.operation.list',
    {},
    { caller: client('a') },
  );
  first.service.close();

  const second = createCore();
  await second.service.whenReconciled();
  const handle = await second.dispatcher.openStream(
    'core.operation.events',
    { cursor: eventsCursor },
    { caller: client('a') },
  );
  const frames = collect(handle);
  await new Promise((resolve) => setImmediate(resolve));
  expect(handle.openResult.acceptedCursor).toEqual(eventsCursor);
  expect(items(frames)).toEqual(['reconciled:paused', 'resumed:running']);
  const restart = frames.find((frame) => frame.kind === 'item');
  expect(restart?.kind === 'item' && restart.item.operation).toMatchObject({
    operationId: operation.operationId,
    restart: { class: 'resumable', disposition: 'awaiting-resume' },
  });
  handle.close();
});

it('requires a snapshot for a cursor from another ledger or ahead of it', async () => {
  const { service, dispatcher } = createCore();
  const { ledgerId } = await service.ready();
  const cursors: CanopyStreamCursor[] = [
    { daemonEpoch: 'another-ledger', sequence: 0 },
    { daemonEpoch: ledgerId, sequence: 5 },
  ];
  for (const cursor of cursors) {
    const handle = await dispatcher.openStream(
      'core.operation.events',
      { cursor },
      { caller: client('a') },
    );
    const frames: Frame[] = [];
    for await (const frame of handle.frames) frames.push(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: 'end',
      outcome: 'error',
      error: {
        kind: 'failed_precondition',
        code: 'core.operation.snapshotRequired',
      },
    });
  }
});

it('stops replaying once a slow client’s stream ends on its buffer', async () => {
  const seed = OperationLedger.open(dbPath);
  const start = seed.eventsHead();
  for (let index = 0; index < 1_800; index += 1)
    seed.accept(admission({ receipt: undefined }));
  const ledgerId = seed.ledgerId;
  seed.close();
  const { dispatcher } = createCore();
  const reads = jest.spyOn(OperationLedger.prototype, 'eventsAfter');
  try {
    const handle = await dispatcher.openStream(
      'core.operation.events',
      { cursor: { daemonEpoch: ledgerId, sequence: start } },
      { caller: client('a') },
    );
    const frames: Frame[] = [];
    for await (const frame of handle.frames) frames.push(frame);
    expect(frames.at(-1)).toMatchObject({
      kind: 'end',
      outcome: 'error',
      error: { kind: 'resource_exhausted' },
    });
    // The buffer holds 1,024 items: three pages of 500 reach it, and the
    // remaining history is never read for a stream that has ended.
    expect(reads).toHaveBeenCalledTimes(3);
  } finally {
    reads.mockRestore();
  }
});
