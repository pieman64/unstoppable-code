import type {
  CanopyCallerDescriptor,
  CanopyStreamCursor,
  CanopyWorkspaceScope,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import type { CanopyStreamFrame } from '../../runtime/types';
import {
  createCoreEventsModule,
  type CoreEventRecord,
} from '../core-events-module';
import { createEventJournal, type EventJournal } from '../event-journal';
import {
  createRuntimeProfileGraph,
  type RuntimeModule,
  type RuntimeProfileGraph,
} from '../runtime-profile-graph';

const EPOCH = 'runtime:events-test';
const caller: CanopyCallerDescriptor = {
  principalId: 'local-user',
  clientInstanceId: 'client-a',
  authorityId: 'authority',
  interfaceKind: 'desktop',
  grants: ['core.runtime.read', 'core.events.read'],
};
const other: CanopyCallerDescriptor = {
  ...caller,
  clientInstanceId: 'client-b',
};

type Frame = CanopyStreamFrame<unknown, unknown>;

interface Harness {
  readonly journal: EventJournal<CoreEventRecord>;
  readonly graph: RuntimeProfileGraph;
  append(name?: string, scope?: CanopyWorkspaceScope): CanopyStreamCursor;
  open(
    params: Record<string, unknown>,
    as?: CanopyCallerDescriptor,
  ): Promise<{ subscriptionId: string; frames: Frame[] }>;
}

const graphs: RuntimeProfileGraph[] = [];
afterEach(async () => {
  await Promise.all(graphs.splice(0).map((graph) => graph.shutdown('test')));
});

async function harness(
  options: {
    maxPending?: number;
    wrap?: (module: RuntimeModule) => RuntimeModule;
  } = {},
): Promise<Harness> {
  const journal = createEventJournal<CoreEventRecord>({ epoch: EPOCH });
  const module = createCoreEventsModule({
    journal,
    families: ['core.workspace'],
    maxPending: options.maxPending,
  });
  const graph = createRuntimeProfileGraph({
    profile: 'core',
    daemonEpoch: EPOCH,
    modules: [options.wrap ? options.wrap(module) : module],
    identity: {
      runtimeId: 'runtime',
      hostId: 'host',
      authorityId: 'authority',
    },
    principalFor: () => 'interface',
    phaseDeadlineMs: 1000,
    shutdownTimeoutMs: 50,
  });
  graphs.push(graph);
  await graph.start();
  return {
    journal,
    graph,
    append: (name = 'core.workspace.committed', scope = {}) =>
      journal.append({
        name,
        scope,
        occurredAt: '2026-10-31T00:00:00.000Z',
        payload: { commit: 'w5:1', changes: [] },
      }).cursor,
    async open(params, as = caller) {
      const frames: Frame[] = [];
      const handle = await graph.dispatcher.openStream(
        'core.events.subscribe',
        params,
        { caller: as, onFrame: (frame) => void frames.push(frame) },
      );
      return { subscriptionId: handle.openResult.subscriptionId, frames };
    },
  };
}

const settle = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));
const items = (frames: Frame[]): number[] =>
  frames.flatMap((frame) =>
    frame.kind === 'item' ? [frame.cursor.sequence] : [],
  );
const end = (frames: Frame[]): Frame | undefined =>
  frames.find((frame) => frame.kind === 'end');
const ack = (
  h: Harness,
  subscriptionId: string,
  cursor: CanopyStreamCursor,
  as = caller,
): Promise<unknown> =>
  h.graph.dispatcher.instruction(
    'core.events.ack',
    { subscriptionId, cursor },
    { caller: as },
  );
const code = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => 'resolved',
    (error: unknown) =>
      error instanceof CanopyOperationError ? error.payload.code : error,
  );

describe('core.events module', () => {
  it('replays only the latest entry for a null cursor, then delivers live', async () => {
    const h = await harness();
    h.append();
    const latest = h.append();
    const { frames } = await h.open({
      families: ['core.workspace'],
      cursor: null,
    });
    await settle();
    expect(items(frames)).toEqual([latest.sequence]);
    const live = h.append();
    await settle();
    expect(items(frames)).toEqual([latest.sequence, live.sequence]);
    const [first] = frames;
    expect(first).toMatchObject({
      kind: 'item',
      item: {
        cursor: latest,
        eventId: `${EPOCH}#${latest.sequence}`,
        name: 'core.workspace.committed',
      },
    });
  });

  it('resumes after a retained cursor and requires a snapshot for any other', async () => {
    const h = await harness();
    const [one, two, three] = [h.append(), h.append(), h.append()];
    const resumed = await h.open({ families: ['core.workspace'], cursor: one });
    await settle();
    expect(items(resumed.frames)).toEqual([two.sequence, three.sequence]);
    for (const cursor of [
      { daemonEpoch: 'runtime:other', sequence: 1 },
      { daemonEpoch: EPOCH, sequence: three.sequence + 1 },
    ]) {
      const { frames } = await h.open({ families: ['core.workspace'], cursor });
      await settle();
      expect(end(frames)).toMatchObject({
        outcome: 'error',
        error: {
          kind: 'failed_precondition',
          code: 'core.events.snapshotRequired',
        },
      });
    }
  });

  it('matches families by dot boundary and scopes field by field', async () => {
    const h = await harness();
    const committed = await h.open({
      families: ['core.workspace.committed'],
      cursor: null,
    });
    const scoped = await h.open({
      families: ['core.workspace'],
      scope: { workspaceId: 'a' },
      cursor: null,
    });
    const a = h.append('core.workspace.committed', { workspaceId: 'a' });
    h.append('core.workspace.committed', { workspaceId: 'b' });
    const spanning = h.append('core.workspace.committed', {});
    const invalidated = h.append('core.workspace.invalidated', {
      workspaceId: 'a',
    });
    await settle();
    expect(items(committed.frames)).toEqual([
      a.sequence,
      a.sequence + 1,
      spanning.sequence,
    ]);
    expect(items(scoped.frames)).toEqual([a.sequence, invalidated.sequence]);
  });

  it('refuses an unserved family as capability_unavailable', async () => {
    const h = await harness();
    for (const family of ['core.chat', 'core.workspaceRecords']) {
      const { frames } = await h.open({ families: [family], cursor: null });
      await settle();
      expect(end(frames)).toMatchObject({
        outcome: 'error',
        error: {
          kind: 'capability_unavailable',
          details: { unsupported: [family] },
        },
      });
    }
  });

  it('holds items past maxInFlight until they are acknowledged', async () => {
    const h = await harness();
    const { subscriptionId, frames } = await h.open({
      families: ['core.workspace'],
      cursor: null,
      maxInFlight: 2,
    });
    const cursors = [h.append(), h.append(), h.append(), h.append()];
    await settle();
    expect(items(frames)).toEqual([cursors[0].sequence, cursors[1].sequence]);
    await expect(ack(h, subscriptionId, cursors[0])).resolves.toEqual({
      acknowledgedCursor: cursors[0],
    });
    await settle();
    expect(items(frames)).toHaveLength(3);
  });

  it('answers acks with the held cursor and refuses others as notFound', async () => {
    const h = await harness();
    const { subscriptionId } = await h.open({
      families: ['core.workspace'],
      cursor: null,
    });
    const [one, two] = [h.append(), h.append()];
    await settle();
    await expect(ack(h, subscriptionId, two)).resolves.toEqual({
      acknowledgedCursor: two,
    });
    // Never backwards, never past delivery.
    await expect(ack(h, subscriptionId, one)).resolves.toEqual({
      acknowledgedCursor: two,
    });
    await expect(
      ack(h, subscriptionId, { daemonEpoch: EPOCH, sequence: 99 }),
    ).resolves.toEqual({ acknowledgedCursor: two });
    for (const refused of [
      ack(h, 'unknown', two),
      ack(h, subscriptionId, two, other),
      ack(h, subscriptionId, { daemonEpoch: 'runtime:other', sequence: 2 }),
    ])
      expect(await code(refused)).toBe('core.events.notFound');
  });

  it('ends a subscriber that falls too far behind', async () => {
    const h = await harness({ maxPending: 3 });
    const { frames } = await h.open({
      families: ['core.workspace'],
      cursor: null,
      maxInFlight: 1,
    });
    for (let index = 0; index < 5; index += 1) h.append();
    await settle();
    expect(items(frames)).toHaveLength(1);
    expect(end(frames)).toMatchObject({
      outcome: 'error',
      error: { kind: 'resource_exhausted' },
    });
  });

  it('denies a caller without core.events.read before the handler runs', async () => {
    const entered = jest.fn();
    const h = await harness({
      wrap: (module) => ({
        ...module,
        handlers: {
          ...module.handlers,
          streams: {
            'core.events.subscribe': (
              ...args: Parameters<RuntimeModule['handlers']['streams'][string]>
            ): ReturnType<RuntimeModule['handlers']['streams'][string]> => {
              entered();
              return module.handlers.streams['core.events.subscribe'](...args);
            },
          },
        },
      }),
    });
    const denied = { ...caller, grants: ['core.runtime.read' as const] };
    const outcome = await h.graph.dispatcher
      .openStream(
        'core.events.subscribe',
        { families: ['core.workspace'] },
        { caller: denied },
      )
      .then(
        () => 'opened',
        (error: unknown) =>
          error instanceof CanopyOperationError ? error.payload.kind : error,
      );
    expect(outcome).toBe('permission_denied');
    expect(
      await h.graph.dispatcher
        .instruction(
          'core.events.ack',
          { subscriptionId: 'x', cursor: { daemonEpoch: EPOCH, sequence: 1 } },
          { caller: denied },
        )
        .then(
          () => 'acked',
          (error: unknown) =>
            error instanceof CanopyOperationError ? error.payload.kind : error,
        ),
    ).toBe('permission_denied');
    expect(entered).not.toHaveBeenCalled();
  });

  it('issues cursors in the runtime descriptor epoch', async () => {
    const h = await harness();
    const health = await h.graph.dispatcher.query(
      'core.runtime.health.get',
      {},
      { caller },
    );
    expect(health).toMatchObject({ runtime: { daemonEpoch: EPOCH } });
    const { frames } = await h.open({ families: ['core.workspace'] });
    h.append();
    await settle();
    const [frame] = frames;
    expect(frame?.cursor.daemonEpoch).toBe(EPOCH);
  });
});
