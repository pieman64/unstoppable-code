import {
  CORE_EXECUTION_QUERIES,
  CORE_EXECUTION_STREAMS,
  CoreExecutionStatusSchema,
  type CanopyCallerDescriptor,
  type CoreExecutionStatusEventsItem,
} from '@canopy/protocol/canopy-core';

import { createCanopyDispatcher } from '../../runtime/dispatcher';
import type { CanopyDispatcher, CanopyStreamFrame } from '../../runtime/types';
import {
  ExecutionAccounting,
  createCoreExecutionHandlers,
  type ExecutionAccountingLimits,
  type ExecutionAccountingSnapshot,
  type ExecutionResourceItem,
  type PlatformProcessTable,
} from '../../index';

type Metadata =
  | { type: 'generic' }
  | { type: 'pipeline'; pipeline: { executionId: string } };

const MIB = 1024 * 1024;
const ROOT = 100;

function table(): PlatformProcessTable {
  return {
    kind: 'sampled',
    rows: new Map(
      [
        { pid: ROOT, ppid: 1, command: 'host' },
        { pid: 200, ppid: ROOT, command: 'step' },
        { pid: 201, ppid: 200, command: 'node build.js' },
      ].map((row) => [
        row.pid,
        { ...row, pgid: row.pid, cpuPercent: 1, memoryRssBytes: 10 * MIB },
      ]),
    ),
  };
}

function accounting(): ExecutionAccounting<Metadata> {
  return new ExecutionAccounting<Metadata>({
    rootPid: ROOT,
    readProcessTable: (): Promise<PlatformProcessTable> =>
      Promise.resolve(table()),
    limits: () => ({
      maxActive: { pipeline: 2 },
      memoryGuardEnabled: true,
      warningMemoryBytes: 100 * MIB,
      criticalMemoryBytes: 200 * MIB,
    }),
    productName: 'Test',
    groupLabel: (id) => id,
    executionIdOf: (metadata) =>
      metadata?.type === 'pipeline' ? metadata.pipeline.executionId : undefined,
  });
}

function client(
  id: string,
  grants: CanopyCallerDescriptor['grants'] = ['core.execution.read'],
): CanopyCallerDescriptor {
  return {
    principalId: `user-${id}`,
    clientInstanceId: id,
    authorityId: 'local-desktop',
    interfaceKind: 'test',
    grants,
  };
}

type ExecutionDispatcher = CanopyDispatcher<
  typeof CORE_EXECUTION_QUERIES,
  Record<never, never>,
  typeof CORE_EXECUTION_STREAMS
>;

function dispatcherFor(
  source: ExecutionAccounting<Metadata>,
  observeRead?: (snapshot: ExecutionAccountingSnapshot<Metadata>) => void,
): ExecutionDispatcher {
  return createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: CORE_EXECUTION_QUERIES,
      instructions: {},
      streams: CORE_EXECUTION_STREAMS,
    },
    handlers: {
      ...createCoreExecutionHandlers(source, { observeRead }),
      instructions: {},
    },
  });
}

type Frame = CanopyStreamFrame<CoreExecutionStatusEventsItem, object>;

function processCounts(frames: Frame[]): number[] {
  return frames.flatMap((frame) =>
    frame.kind === 'item' ? [frame.item.status.processCount] : [],
  );
}

const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

it('refuses a caller without the read grant', async () => {
  const dispatcher = dispatcherFor(accounting());
  await expect(
    dispatcher.query(
      'core.execution.status.get',
      {},
      { caller: client('a', []) },
    ),
  ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
});

it('reads the last sample with live family counts and nested items', async () => {
  const source = accounting();
  source.register({
    id: 'pipeline-execution:exec-1',
    groupId: 'pipelines',
    kind: 'pipeline-execution',
    label: 'Release',
    metadata: { type: 'pipeline', pipeline: { executionId: 'exec-1' } },
  });
  source.register({
    id: 'pipeline-step:exec-1:build',
    groupId: 'pipelines',
    kind: 'pipeline-step',
    label: 'build',
    pid: 200,
    metadata: { type: 'pipeline', pipeline: { executionId: 'exec-1' } },
  });
  await source.sample();
  const lease = source.track('pipeline', 'exec-1');
  const reservation = source.admit('pipeline');
  const observed: ExecutionAccountingSnapshot<Metadata>[] = [];
  const dispatcher = dispatcherFor(source, (snapshot) =>
    observed.push(snapshot),
  );

  const { status } = await dispatcher.query(
    'core.execution.status.get',
    {},
    { caller: client('a') },
  );

  expect(CoreExecutionStatusSchema.parse(status)).toEqual(status);
  expect(observed).toEqual([source.getSnapshot()]);
  expect(status.families.pipeline).toEqual({
    active: 1,
    pending: 1,
    maxActive: 2,
    blocked: true,
  });
  expect(source.getSnapshot().families.pipeline.active).toBe(0);
  const pipelines = status.groups.find((group) => group.id === 'pipelines');
  expect(
    pipelines?.items.map((item) => [item.id, item.parentId ?? null]),
  ).toEqual([
    ['pipeline-execution:exec-1', null],
    ['pipeline-step:exec-1:build', 'pipeline-execution:exec-1'],
    ['process:201', 'pipeline-step:exec-1:build'],
  ]);
  expect(pipelines?.items[0]).toMatchObject({ metadataType: 'pipeline' });
  reservation.release();
  lease.release();
});

it('sends every attached client the current status and each later sample', async () => {
  const source = accounting();
  const dispatcher = dispatcherFor(source);
  const seenByA: Frame[] = [];
  const seenByB: Frame[] = [];
  const a = await dispatcher.openStream(
    'core.execution.status.events',
    {},
    { caller: client('a'), onFrame: (frame) => seenByA.push(frame) },
  );
  const b = await dispatcher.openStream(
    'core.execution.status.events',
    {},
    { caller: client('b'), onFrame: (frame) => seenByB.push(frame) },
  );
  await flush();
  expect(processCounts(seenByA)).toEqual([0]);
  expect(processCounts(seenByB)).toEqual([0]);

  // A sample taken by anyone reaches both clients.
  await source.sample();
  await flush();
  expect(processCounts(seenByA)).toEqual([0, 3]);
  expect(processCounts(seenByB)).toEqual([0, 3]);

  // One client leaving does not stop delivery to the other.
  a.close();
  await flush();
  await source.sample();
  await flush();
  expect(processCounts(seenByA)).toEqual([0, 3]);
  expect(processCounts(seenByB)).toEqual([0, 3, 3]);
  b.close();
});

it('bounds host labels so one long label never breaks the shared status', async () => {
  const source = accounting();
  source.register({
    id: 'script:long',
    groupId: 'scripts',
    kind: 'script',
    label: 'x'.repeat(5_000),
  });
  await source.sample();
  const dispatcher = dispatcherFor(source);
  const frames: Frame[] = [];
  const stream = await dispatcher.openStream(
    'core.execution.status.events',
    {},
    { caller: client('a'), onFrame: (frame) => frames.push(frame) },
  );

  const { status } = await dispatcher.query(
    'core.execution.status.get',
    {},
    { caller: client('a') },
  );
  await source.sample();
  await flush();

  const item = status.groups
    .flatMap((group) => group.items)
    .find((entry) => entry.id === 'script:long');
  expect(item?.label).toHaveLength(4_096);
  expect(frames.map((frame) => frame.kind)).toEqual(['item', 'item']);
  stream.close();
});

it('bounds long composite IDs and keeps parent links between them', async () => {
  const source = accounting();
  const executionId = `exec-${'e'.repeat(600)}`;
  source.register({
    id: `pipeline-execution:${executionId}`,
    groupId: 'pipelines',
    kind: 'pipeline-execution',
    label: 'Release',
    metadata: { type: 'pipeline', pipeline: { executionId } },
  });
  for (const step of ['a', 'b'])
    source.register({
      id: `pipeline-step:${executionId}:${step}`,
      groupId: 'pipelines',
      kind: 'pipeline-step',
      label: step,
      pid: 200,
      startedAt: 'not a timestamp',
      metadata: { type: 'pipeline', pipeline: { executionId } },
    });
  await source.sample();

  const { status } = await dispatcherFor(source).query(
    'core.execution.status.get',
    {},
    { caller: client('a') },
  );

  const items = status.groups.flatMap((group) => group.items);
  const [execution, ...children] = items.filter((item) =>
    item.id.startsWith('pipeline-'),
  );
  expect(execution?.id).toHaveLength(512);
  expect(new Set(children.map((item) => item.id)).size).toBe(2);
  expect(children.every((item) => item.parentId === execution?.id)).toBe(true);
  expect(children.every((item) => item.startedAt === undefined)).toBe(true);
});

it('keeps the status valid for a zero limit and unmeasured metrics', async () => {
  const source = new ExecutionAccounting<Metadata>({
    rootPid: ROOT,
    readProcessTable: (): Promise<PlatformProcessTable> =>
      Promise.resolve({ kind: 'unavailable', reason: 'none' }),
    hostProcesses: (): ExecutionResourceItem<Metadata>[] => [
      {
        id: `host:${ROOT}`,
        kind: 'electron-main',
        groupId: 'app',
        label: 'Host main',
        pid: ROOT,
        cpuPercent: Number.NaN,
        memoryRssBytes: Number.NaN,
        processCount: 1,
        status: 'running',
      },
    ],
    limits: (): ExecutionAccountingLimits => ({
      maxActive: { pipeline: 0 },
      memoryGuardEnabled: false,
      warningMemoryBytes: 100 * MIB,
      criticalMemoryBytes: 200 * MIB,
    }),
    productName: 'Test',
    groupLabel: (id): string => id,
    executionIdOf: (): string | undefined => undefined,
  });
  await source.sample();

  const { status } = await dispatcherFor(source).query(
    'core.execution.status.get',
    {},
    { caller: client('a') },
  );

  expect(status.families.pipeline).toMatchObject({ maxActive: 0 });
  expect(status.groups[0]?.items[0]).toMatchObject({
    cpuPercent: 0,
    memoryRssBytes: 0,
  });
});
