import type {
  PortalCommandEnvelope,
  PortalEventEnvelope,
  PortalStateRequestPayload,
} from '@canopy/desktop-shared/types';
import {
  createPortalSnapshotLane,
  PORTAL_SNAPSHOT_BARRIER_MAX_OVERTAKES,
  type PortalSnapshotLaneDeps,
} from '../portal-snapshot-lane';

function stateRequestCommand(
  id: string,
  sequence: number,
): PortalCommandEnvelope {
  return {
    id,
    sequence,
    type: 'portal.state.request',
    status: 'pending',
    payload: {},
    createdAt: '2026-08-20T00:00:00.000Z',
    expiresAt: null,
  };
}

const overviewRequest: PortalStateRequestPayload = { scope: 'overview' };

function worktreeRequest(
  worktreeLocalId: string,
  scope: PortalStateRequestPayload['scope'] = 'scripts',
): PortalStateRequestPayload {
  return { scope, target: { workspaceLocalId: 'workspace', worktreeLocalId } };
}

function snapshotEvent(
  eventId: string,
  commandId: string,
): PortalEventEnvelope {
  return {
    type: 'portal.state.snapshot',
    commandId,
    eventId,
    occurredAt: '2026-08-20T00:00:00.000Z',
    payload: {},
  };
}

function completedEvent(
  eventId: string,
  commandId: string,
): PortalEventEnvelope {
  return {
    type: 'portal.command.completed',
    commandId,
    eventId,
    occurredAt: '2026-08-20T00:00:00.000Z',
    payload: { commandId },
  };
}

interface LaneHarness {
  deps: PortalSnapshotLaneDeps;
  outbox: PortalEventEnvelope[];
  log: string[];
}

/**
 * Simulates the manager surface the lane depends on: a live outbox array the
 * injected enqueue appends to, a flush that fully drains it, and an ordered
 * log so tests can assert cross-dependency sequencing without relying on
 * microtask counts.
 */
function createHarness(
  execute: PortalSnapshotLaneDeps['execute'],
  overrides: Partial<PortalSnapshotLaneDeps> = {},
): LaneHarness {
  const outbox: PortalEventEnvelope[] = [];
  const log: string[] = [];
  const deps: PortalSnapshotLaneDeps = {
    execute: async (command, context, request): Promise<void> => {
      log.push(`execute:${command.id}`);
      await execute(command, context, request);
    },
    enqueueEvent: (event): PortalEventEnvelope => {
      log.push(`enqueue:${event.eventId}`);
      // Mimic the manager's routing stamp: the lane must collect the stamped
      // envelope (the enqueue return value), not the raw one it was given.
      const stamped: PortalEventEnvelope = {
        ...event,
        clientEventId: `stamped-${event.eventId}`,
      };
      outbox.push(stamped);
      return stamped;
    },
    flushOutbox: (): Promise<void> => {
      log.push('flush');
      outbox.length = 0;
      return Promise.resolve();
    },
    persistCompletedCommand: (input): Promise<void> => {
      log.push(`persist:${input.commandId}`);
      return Promise.resolve();
    },
    isCommandGroupQueued: (commandId): boolean =>
      outbox.some(
        (event) =>
          event.commandId === commandId &&
          event.type !== 'portal.command.completed' &&
          event.type !== 'portal.command.failed',
      ),
    droppedCommandGroup: (): undefined => undefined,
    outboxDepth: (): number => outbox.length,
    recordTiming: (input): void => {
      log.push(`timing:${input.commandId}`);
    },
    now: (): number => 0,
    buildFailureEvent: (command): PortalEventEnvelope => ({
      type: 'portal.command.failed',
      commandId: command.id,
      eventId: `failed-${command.id}`,
      occurredAt: '2026-08-20T00:00:00.000Z',
      payload: { commandId: command.id },
    }),
    onError: (_error, phase): void => {
      log.push(`error:${phase}`);
    },
    ...overrides,
  };
  return { deps, outbox, log };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('portal snapshot lane (CAN-2360)', () => {
  it('serves the selected chat while an unrelated background build is blocked', async () => {
    const gate = deferred();
    const harness = createHarness(async (command, context) => {
      if (command.id === 'background') await gate.promise;
      context.enqueueEvent(snapshotEvent(`snap-${command.id}`, command.id));
      context.enqueueEvent(completedEvent(`done-${command.id}`, command.id));
    });
    const lane = createPortalSnapshotLane(harness.deps);
    ['background', 'queued', 'foreground'].forEach((id, index) => {
      lane.enqueue({
        command: stateRequestCommand(id, index + 1),
        request: worktreeRequest(id, id === 'foreground' ? 'chat' : 'scripts'),
        receivedAtPerf: 0,
      });
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(harness.log).toContain('persist:foreground');
      expect(harness.log).not.toContain('execute:queued');
    } finally {
      gate.resolve();
      await lane.idle();
    }
  });

  it('builds the next selected read while an unrelated upload holds the outbox', async () => {
    // The manager's flush is single-flight: while one upload is in flight,
    // every later flush awaits it. A selected read waiting on that upload must
    // not keep its routing key from serving the next selected read.
    const upload = deferred();
    const posted: string[] = [];
    const harness = createHarness(
      (command, context) => {
        context.enqueueEvent(snapshotEvent(`snap-${command.id}`, command.id));
        context.enqueueEvent(completedEvent(`done-${command.id}`, command.id));
        return Promise.resolve();
      },
      {
        flushOutbox: async (): Promise<void> => {
          await upload.promise;
          posted.push(...harness.outbox.map((event) => event.eventId));
          harness.outbox.length = 0;
        },
      },
    );
    const lane = createPortalSnapshotLane(harness.deps);
    lane.enqueue({
      command: stateRequestCommand('background', 1),
      request: worktreeRequest('unrelated', 'scripts'),
      receivedAtPerf: 0,
    });
    lane.enqueue({
      command: stateRequestCommand('restore', 2),
      request: worktreeRequest('selected', 'worktree'),
      receivedAtPerf: 0,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    lane.enqueue({
      command: stateRequestCommand('selected-chat', 3),
      request: worktreeRequest('selected', 'chat'),
      receivedAtPerf: 0,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(harness.log).toContain('persist:selected-chat');
    } finally {
      upload.resolve();
      await lane.idle();
    }
    expect(harness.log.indexOf('execute:selected-chat')).toBeGreaterThan(
      harness.log.indexOf('persist:restore'),
    );
    // The early release relies on the outbox, not the lane, for same-key
    // order; idle() also waits for both released uploads.
    expect(
      posted.filter((eventId) => /-(restore|selected-chat)$/.test(eventId)),
    ).toEqual([
      'snap-restore',
      'done-restore',
      'snap-selected-chat',
      'done-selected-chat',
    ]);
    expect(harness.log).toEqual(
      expect.arrayContaining(['timing:restore', 'timing:selected-chat']),
    );
  });

  it('reports one failed shared upload once across released selected reads', async () => {
    let failUpload: (error: Error) => void = () => undefined;
    // The manager's single-flight flush hands every waiter the same rejection.
    const upload = new Promise<void>((_resolve, reject) => {
      failUpload = reject;
    });
    upload.catch(() => undefined);
    const harness = createHarness(
      (command, context) => {
        context.enqueueEvent(snapshotEvent(`snap-${command.id}`, command.id));
        return Promise.resolve();
      },
      { flushOutbox: (): Promise<void> => upload },
    );
    const lane = createPortalSnapshotLane(harness.deps);
    lane.enqueue({
      command: stateRequestCommand('restore', 1),
      request: worktreeRequest('selected', 'worktree'),
      receivedAtPerf: 0,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    lane.enqueue({
      command: stateRequestCommand('selected-chat', 2),
      request: worktreeRequest('selected', 'chat'),
      receivedAtPerf: 0,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.log).toContain('persist:selected-chat');
    failUpload(new Error('offline'));
    await lane.idle();
    expect(harness.log.filter((item) => item === 'error:flush')).toHaveLength(
      1,
    );
  });

  it('keeps a background read through upload before its next overlapping read', async () => {
    const upload = deferred();
    const harness = createHarness(
      (command, context) => {
        context.enqueueEvent(snapshotEvent(`snap-${command.id}`, command.id));
        return Promise.resolve();
      },
      {
        flushOutbox: async (): Promise<void> => {
          await upload.promise;
          harness.outbox.length = 0;
        },
      },
    );
    const lane = createPortalSnapshotLane(harness.deps);
    lane.enqueue({
      command: stateRequestCommand('first', 1),
      request: worktreeRequest('background', 'scripts'),
      receivedAtPerf: 0,
    });
    lane.enqueue({
      command: stateRequestCommand('second', 2),
      request: worktreeRequest('background', 'files'),
      receivedAtPerf: 0,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.log).toContain('persist:first');
    expect(harness.log).not.toContain('execute:second');
    upload.resolve();
    await lane.idle();
    expect(harness.log).toContain('persist:second');
  });

  it('coalesces adjacent queued background requests without losing command receipts', async () => {
    const gate = deferred();
    const harness = createHarness(async (command, context) => {
      if (command.id === 'blocker') await gate.promise;
      context.enqueueEvent(snapshotEvent(`snap-${command.id}`, command.id));
      context.enqueueEvent(completedEvent(`done-${command.id}`, command.id));
    });
    const lane = createPortalSnapshotLane(harness.deps);
    ['blocker', 'duplicate-1', 'duplicate-2'].forEach((id, index) => {
      lane.enqueue({
        command: stateRequestCommand(id, index + 1),
        request: worktreeRequest(id === 'blocker' ? id : 'duplicate'),
        receivedAtPerf: 0,
      });
    });
    gate.resolve();
    await lane.idle();
    expect(
      harness.log.filter((item) => item.startsWith('execute:')),
    ).toHaveLength(2);
    expect(harness.log).toContain('persist:duplicate-1');
    expect(harness.log).toContain('persist:duplicate-2');
  });

  it('does not coalesce changed-files requests with different cursors', async () => {
    const gate = deferred();
    const harness = createHarness(async (command) => {
      if (command.id === 'barrier') await gate.promise;
    });
    const lane = createPortalSnapshotLane(harness.deps);
    lane.enqueue({
      command: stateRequestCommand('barrier', 1),
      request: overviewRequest,
      receivedAtPerf: 0,
    });
    const target = { workspaceLocalId: 'workspace', worktreeLocalId: 'diff' };
    const enqueuePageRequest = (
      id: string,
      sequence: number,
      cursor: string,
    ): void => {
      lane.enqueue({
        command: stateRequestCommand(id, sequence),
        request: {
          scope: 'diff',
          target,
          changedFilesPage: { group: 'uncommitted', cursor },
        },
        receivedAtPerf: 0,
      });
    };
    enqueuePageRequest('page-0', 2, 'cursor-1');
    enqueuePageRequest('page-1', 3, 'cursor-2');

    gate.resolve();
    await lane.idle();

    expect(harness.log.filter((item) => item.startsWith('execute:'))).toEqual([
      'execute:barrier',
      'execute:page-0',
      'execute:page-1',
    ]);
  });

  it('keeps worktree and chat requests in FIFO through persistence', async () => {
    const gate = deferred();
    const harness = createHarness(async (command, context) => {
      context.enqueueEvent(snapshotEvent(`snap-${command.id}`, command.id));
      if (command.id === 'first') await gate.promise;
    });
    const lane = createPortalSnapshotLane(harness.deps);
    lane.enqueue({
      command: stateRequestCommand('first', 1),
      request: worktreeRequest('same', 'worktree'),
      receivedAtPerf: 0,
    });
    lane.enqueue({
      command: stateRequestCommand('second', 2),
      request: worktreeRequest('same', 'chat'),
      receivedAtPerf: 0,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.log).not.toContain('execute:second');
    gate.resolve();
    await lane.idle();
    expect(harness.log.indexOf('execute:second')).toBeGreaterThan(
      harness.log.indexOf('persist:first'),
    );
  });
  it('retains global FIFO without coalescing in serial fallback mode', async () => {
    const gate = deferred();
    const harness = createHarness(
      async (command) => {
        if (command.id === 'first') await gate.promise;
      },
      { mode: () => 'serial' },
    );
    const lane = createPortalSnapshotLane(harness.deps);
    ['first', 'second', 'third', 'foreground'].forEach((id, index) => {
      lane.enqueue({
        command: stateRequestCommand(id, index + 1),
        request: worktreeRequest(
          id === 'third' ? 'second' : id,
          id === 'foreground' ? 'chat' : 'scripts',
        ),
        receivedAtPerf: 0,
      });
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.log.filter((item) => item.startsWith('execute:'))).toEqual([
      'execute:first',
    ]);
    gate.resolve();
    await lane.idle();
    expect(harness.log.filter((item) => item.startsWith('execute:'))).toEqual([
      'execute:first',
      'execute:second',
      'execute:third',
      'execute:foreground',
    ]);
  });

  it('reprioritizes selection without overtaking earlier overlapping snapshots', async () => {
    const gate = deferred();
    const harness = createHarness(async (command) => {
      if (command.id === 'barrier') await gate.promise;
    });
    const lane = createPortalSnapshotLane(harness.deps);
    lane.enqueue({
      command: stateRequestCommand('barrier', 1),
      request: overviewRequest,
      receivedAtPerf: 0,
    });
    lane.enqueue({
      command: stateRequestCommand('old-selection', 2),
      request: worktreeRequest('old', 'chat'),
      receivedAtPerf: 0,
    });
    lane.enqueue({
      command: stateRequestCommand('new-selection', 3),
      request: worktreeRequest('new', 'chat'),
      receivedAtPerf: 0,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.log.filter((item) => item.startsWith('execute:'))).toEqual([
      'execute:barrier',
    ]);
    gate.resolve();
    await lane.idle();
    expect(harness.log.indexOf('execute:new-selection')).toBeLessThan(
      harness.log.indexOf('execute:old-selection'),
    );
  });

  it('starts a foreground worktree request ahead of a queued overview barrier', async () => {
    const gate = deferred();
    const harness = createHarness(async (command, context) => {
      if (command.id === 'background') await gate.promise;
      context.enqueueEvent(snapshotEvent(`snap-${command.id}`, command.id));
    });
    const lane = createPortalSnapshotLane(harness.deps);
    lane.enqueue({
      command: stateRequestCommand('background', 1),
      request: worktreeRequest('other', 'scripts'),
      receivedAtPerf: 0,
    });
    lane.enqueue({
      command: stateRequestCommand('overview', 2),
      request: overviewRequest,
      receivedAtPerf: 0,
    });
    lane.enqueue({
      command: stateRequestCommand('selected', 3),
      request: worktreeRequest('selected', 'worktree'),
      receivedAtPerf: 0,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(harness.log).toContain('persist:selected');
      expect(harness.log).not.toContain('execute:overview');
    } finally {
      gate.resolve();
      await lane.idle();
    }
    // The barrier still runs, and only after the jumped read is queued, so
    // its newer state is enqueued later.
    expect(harness.log.indexOf('execute:overview')).toBeGreaterThan(
      harness.log.indexOf('enqueue:snap-selected'),
    );
  });

  it('bounds how many selected reads may start ahead of one queued barrier', async () => {
    const gate = deferred();
    const harness = createHarness(async (command) => {
      if (command.id === 'background') await gate.promise;
    });
    const lane = createPortalSnapshotLane(harness.deps);
    lane.enqueue({
      command: stateRequestCommand('background', 1),
      request: worktreeRequest('other', 'scripts'),
      receivedAtPerf: 0,
    });
    lane.enqueue({
      command: stateRequestCommand('overview', 2),
      request: overviewRequest,
      receivedAtPerf: 0,
    });
    for (
      let index = 1;
      index <= PORTAL_SNAPSHOT_BARRIER_MAX_OVERTAKES + 1;
      index++
    )
      lane.enqueue({
        command: stateRequestCommand(`selected-${index}`, index + 2),
        request: worktreeRequest('selected', index % 2 ? 'worktree' : 'chat'),
        receivedAtPerf: 0,
      });
    for (let round = 0; round < 10; round++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    const starved = `execute:selected-${PORTAL_SNAPSHOT_BARRIER_MAX_OVERTAKES + 1}`;
    try {
      expect(harness.log).toContain(
        `execute:selected-${PORTAL_SNAPSHOT_BARRIER_MAX_OVERTAKES}`,
      );
      expect(harness.log).not.toContain(starved);
    } finally {
      gate.resolve();
      await lane.idle();
    }
    expect(harness.log.indexOf(starved)).toBeGreaterThan(
      harness.log.indexOf('persist:overview'),
    );
  });

  it('keeps a foreground request behind a barrier that is already running', async () => {
    const gate = deferred();
    const harness = createHarness(async (command) => {
      if (command.id === 'overview') await gate.promise;
    });
    const lane = createPortalSnapshotLane(harness.deps);
    lane.enqueue({
      command: stateRequestCommand('overview', 1),
      request: overviewRequest,
      receivedAtPerf: 0,
    });
    lane.enqueue({
      command: stateRequestCommand('selected', 2),
      request: worktreeRequest('selected', 'worktree'),
      receivedAtPerf: 0,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.log).not.toContain('execute:selected');
    gate.resolve();
    await lane.idle();
    expect(harness.log.indexOf('execute:selected')).toBeGreaterThan(
      harness.log.indexOf('persist:overview'),
    );
  });

  it('does not let a background request jump a queued barrier', async () => {
    const gate = deferred();
    const harness = createHarness(async (command) => {
      if (command.id === 'selected') await gate.promise;
    });
    const lane = createPortalSnapshotLane(harness.deps);
    lane.enqueue({
      command: stateRequestCommand('selected', 1),
      request: worktreeRequest('selected', 'worktree'),
      receivedAtPerf: 0,
    });
    lane.enqueue({
      command: stateRequestCommand('overview', 2),
      request: overviewRequest,
      receivedAtPerf: 0,
    });
    lane.enqueue({
      command: stateRequestCommand('background', 3),
      request: worktreeRequest('other', 'scripts'),
      receivedAtPerf: 0,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.log).not.toContain('execute:background');
    gate.resolve();
    await lane.idle();
    expect(harness.log.indexOf('execute:background')).toBeGreaterThan(
      harness.log.indexOf('execute:overview'),
    );
  });

  it('passes the arrival mark to the build so an overview never joins an older build', async () => {
    const arrivals: number[] = [];
    const harness = createHarness((_command, context) => {
      arrivals.push(context.receivedAtPerf);
      return Promise.resolve();
    });
    const lane = createPortalSnapshotLane(harness.deps);
    lane.enqueue({
      command: stateRequestCommand('overview', 1),
      request: overviewRequest,
      receivedAtPerf: 1234,
    });
    await lane.idle();
    expect(arrivals).toEqual([1234]);
  });

  it('never coalesces an overview into an identical overview that is already running', async () => {
    const gate = deferred();
    const harness = createHarness(async (command) => {
      if (command.id === 'running') await gate.promise;
    });
    const lane = createPortalSnapshotLane(harness.deps);
    lane.enqueue({
      command: stateRequestCommand('running', 1),
      request: overviewRequest,
      receivedAtPerf: 0,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    lane.enqueue({
      command: stateRequestCommand('arrived-later', 2),
      request: overviewRequest,
      receivedAtPerf: 1,
    });
    gate.resolve();
    await lane.idle();
    expect(harness.log.filter((item) => item.startsWith('execute:'))).toEqual([
      'execute:running',
      'execute:arrived-later',
    ]);
  });

  it('does not coalesce across an intervening request for the same routing key', async () => {
    const gate = deferred();
    const harness = createHarness(async (command) => {
      if (command.id === 'barrier') await gate.promise;
    });
    const lane = createPortalSnapshotLane(harness.deps);
    lane.enqueue({
      command: stateRequestCommand('barrier', 1),
      request: overviewRequest,
      receivedAtPerf: 0,
    });
    ['scripts', 'files', 'scripts'].forEach((scope, index) => {
      const request = worktreeRequest(
        'same',
        scope === 'files' ? 'files' : 'scripts',
      );
      lane.enqueue({
        command: stateRequestCommand(`read-${index}`, index + 2),
        request,
        receivedAtPerf: 0,
      });
    });
    gate.resolve();
    await lane.idle();
    expect(
      harness.log.filter((item) => item.startsWith('execute:')),
    ).toHaveLength(4);
  });

  it('does not coalesce complete Activity inventory with a shallow overview', async () => {
    const gate = deferred();
    const harness = createHarness(async (command) => {
      if (command.id === 'barrier') await gate.promise;
    });
    const lane = createPortalSnapshotLane(harness.deps);
    const requests: PortalStateRequestPayload[] = [
      overviewRequest,
      overviewRequest,
      { ...overviewRequest, includeChatSummaries: true },
    ];
    requests.forEach((request, index): void => {
      lane.enqueue({
        command: stateRequestCommand(
          index === 0 ? 'barrier' : `read-${index}`,
          index + 1,
        ),
        request,
        receivedAtPerf: 0,
      });
    });
    gate.resolve();
    await lane.idle();
    expect(
      harness.log.filter((item) => item.startsWith('execute:')),
    ).toHaveLength(3);
  });

  it('remaps coalesced snapshot and completion identities for durable replay', async () => {
    const gate = deferred();
    const receipts: PortalEventEnvelope[][] = [];
    const harness = createHarness(
      async (command, context) => {
        if (command.id === 'barrier') await gate.promise;
        context.enqueueEvent(
          snapshotEvent(`snapshot-${command.id}`, command.id),
        );
        context.enqueueEvent(
          completedEvent(`completed-${command.id}`, command.id),
        );
      },
      {
        persistCompletedCommand: ({ events }) => {
          receipts.push(events);
          return Promise.resolve();
        },
      },
    );
    const lane = createPortalSnapshotLane(harness.deps);
    lane.enqueue({
      command: stateRequestCommand('barrier', 1),
      request: overviewRequest,
      receivedAtPerf: 0,
    });
    for (const sequence of [2, 3])
      lane.enqueue({
        command: stateRequestCommand(`duplicate-${sequence}`, sequence),
        request: worktreeRequest('same'),
        receivedAtPerf: 0,
      });
    gate.resolve();
    await lane.idle();
    const events = receipts.flat();
    expect(new Set(events.map((event) => event.eventId)).size).toBe(
      events.length,
    );
    expect(receipts[2]).toEqual([
      expect.objectContaining({
        type: 'portal.state.snapshot',
        commandId: 'duplicate-3',
      }),
      expect.objectContaining({
        type: 'portal.command.completed',
        commandId: 'duplicate-3',
        payload: { commandId: 'duplicate-3', sequenceNumber: 3 },
      }),
    ]);
  });

  it('does not strand an entry enqueued while the pump is winding down', async () => {
    // The pump clears `running` in a .finally MICROTASK after its final
    // queue check; an enqueue landing between those two points must re-kick
    // the pump, or the entry sits until the next enqueue arrives (reachable
    // in prod because flushOutbox is a promise shared with the serial loop).
    // Sweep a range of microtask offsets so the exact wind-down hop count is
    // not baked into the test; deliberately no lane.idle() — awaiting it
    // closes the very window under test.
    for (let hops = 0; hops < 10; hops += 1) {
      const harness = createHarness((command, context): Promise<void> => {
        context.enqueueEvent(snapshotEvent(`snap-${command.id}`, command.id));
        return Promise.resolve();
      });
      const lane = createPortalSnapshotLane(harness.deps);

      lane.enqueue({
        command: stateRequestCommand(`cmd-first-${hops}`, 1),
        request: overviewRequest,
        receivedAtPerf: 0,
      });
      for (let hop = 0; hop < hops; hop += 1) {
        await Promise.resolve();
      }
      lane.enqueue({
        command: stateRequestCommand(`cmd-second-${hops}`, 2),
        request: overviewRequest,
        receivedAtPerf: 0,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(harness.log).toContain(`execute:cmd-second-${hops}`);
    }
  });

  it('runs entries one at a time: build 2 waits for build 1 to finish draining', async () => {
    const gate = deferred();
    const harness = createHarness(async (command, context) => {
      context.enqueueEvent(snapshotEvent(`snap-${command.id}`, command.id));
      if (command.id === 'cmd-1') {
        await gate.promise;
      }
    });
    const lane = createPortalSnapshotLane(harness.deps);

    lane.enqueue({
      command: stateRequestCommand('cmd-1', 1),
      request: overviewRequest,
      receivedAtPerf: 0,
    });
    lane.enqueue({
      command: stateRequestCommand('cmd-2', 2),
      request: overviewRequest,
      receivedAtPerf: 0,
    });
    await Promise.resolve();

    expect(harness.log).toContain('execute:cmd-1');
    expect(harness.log).not.toContain('execute:cmd-2');

    gate.resolve();
    await lane.idle();

    expect(harness.log).toEqual([
      'execute:cmd-1',
      'enqueue:snap-cmd-1',
      'persist:cmd-1',
      'flush',
      'timing:cmd-1',
      'execute:cmd-2',
      'enqueue:snap-cmd-2',
      'persist:cmd-2',
      'flush',
      'timing:cmd-2',
    ]);
  });

  it('persists the completed-command record with the stamped entry events before resolving', async () => {
    const persistCompletedCommand = jest.fn<
      Promise<void>,
      [
        {
          commandId: string;
          sequence: number;
          events: PortalEventEnvelope[];
        },
      ]
    >(() => Promise.resolve());
    const harness = createHarness(
      (command, context): Promise<void> => {
        context.enqueueEvent(snapshotEvent('snap-1', command.id));
        context.enqueueEvent(completedEvent('completed-1', command.id));
        return Promise.resolve();
      },
      { persistCompletedCommand },
    );
    const lane = createPortalSnapshotLane(harness.deps);

    lane.enqueue({
      command: stateRequestCommand('cmd-1', 7),
      request: overviewRequest,
      receivedAtPerf: 0,
    });
    await lane.idle();

    expect(persistCompletedCommand).toHaveBeenCalledTimes(1);
    expect(persistCompletedCommand).toHaveBeenCalledWith({
      commandId: 'cmd-1',
      sequence: 7,
      events: [
        expect.objectContaining({
          eventId: 'snap-1',
          clientEventId: 'stamped-snap-1',
        }),
        expect.objectContaining({
          eventId: 'completed-1',
          clientEventId: 'stamped-completed-1',
        }),
      ],
    });
  });

  it('records snapshot_event_posted against the original command_received mark once the snapshot leaves the outbox', async () => {
    const recordTiming = jest.fn();
    const harness = createHarness(
      (command, context): Promise<void> => {
        context.enqueueEvent(snapshotEvent('snap-1', command.id));
        return Promise.resolve();
      },
      { recordTiming, now: (): number => 350 },
    );
    const lane = createPortalSnapshotLane(harness.deps);

    lane.enqueue({
      command: stateRequestCommand('cmd-1', 1),
      request: overviewRequest,
      receivedAtPerf: 100,
    });
    await lane.idle();

    expect(recordTiming).toHaveBeenCalledTimes(1);
    expect(recordTiming).toHaveBeenCalledWith({
      commandId: 'cmd-1',
      stage: 'snapshot_event_posted',
      elapsedMs: 250,
    });
  });

  it('records a trimmed command group as dropped, never as posted', async () => {
    const recordTiming = jest.fn();
    const harness = createHarness(
      (command, context): Promise<void> => {
        context.enqueueEvent(snapshotEvent('snap-1', command.id));
        context.enqueueEvent(completedEvent('done-1', command.id));
        return Promise.resolve();
      },
      {
        recordTiming,
        droppedCommandGroup: (commandId) =>
          commandId === 'cmd-1'
            ? {
                reason: 'count',
                eventTypes: {
                  'portal.state.snapshot': 1,
                  'portal.state.delta': 2,
                },
                chunkCount: 2,
              }
            : undefined,
        now: (): number => 40,
      },
    );
    const lane = createPortalSnapshotLane(harness.deps);

    lane.enqueue({
      command: stateRequestCommand('cmd-1', 1),
      request: overviewRequest,
      receivedAtPerf: 0,
    });
    await lane.idle();

    expect(recordTiming).toHaveBeenCalledTimes(1);
    expect(recordTiming).toHaveBeenCalledWith({
      commandId: 'cmd-1',
      stage: 'snapshot_event_dropped',
      elapsedMs: 40,
      drop: {
        reason: 'count',
        eventTypes: { 'portal.state.snapshot': 1, 'portal.state.delta': 2 },
        chunkCount: 2,
      },
    });
  });

  it('records a group dropped during its own enqueue as dropped', async () => {
    const recordTiming = jest.fn();
    const drop = {
      reason: 'count' as const,
      eventTypes: { 'portal.state.snapshot': 1 },
      chunkCount: 0,
    };
    const harness = createHarness(
      (command, context): Promise<void> => {
        context.enqueueEvent(snapshotEvent('trimmed-on-enqueue', command.id));
        context.enqueueEvent(completedEvent('done', command.id));
        return Promise.resolve();
      },
      {
        recordTiming,
        droppedCommandGroup: (commandId) =>
          commandId === 'cmd-1' ? drop : undefined,
        now: (): number => 25,
      },
    );
    const enqueue = harness.deps.enqueueEvent;
    harness.deps.enqueueEvent = (event): PortalEventEnvelope | null =>
      event.type === 'portal.state.snapshot' ? null : enqueue(event);
    const lane = createPortalSnapshotLane(harness.deps);

    lane.enqueue({
      command: stateRequestCommand('cmd-1', 1),
      request: overviewRequest,
      receivedAtPerf: 0,
    });
    await lane.idle();

    expect(recordTiming).toHaveBeenCalledWith({
      commandId: 'cmd-1',
      stage: 'snapshot_event_dropped',
      elapsedMs: 25,
      drop,
    });
  });

  it('waits for every chunk of the command group before recording it as posted', async () => {
    const recordTiming = jest.fn();
    let flushes = 0;
    const harness = createHarness(
      (command, context): Promise<void> => {
        context.enqueueEvent(snapshotEvent('head', command.id));
        context.enqueueEvent({
          ...snapshotEvent('head:chunk-1', command.id),
          type: 'portal.state.delta',
        });
        return Promise.resolve();
      },
      {
        recordTiming,
        flushOutbox: (): Promise<void> => {
          flushes += 1;
          harness.outbox.shift();
          return Promise.resolve();
        },
      },
    );
    const lane = createPortalSnapshotLane(harness.deps);

    lane.enqueue({
      command: stateRequestCommand('cmd-1', 1),
      request: overviewRequest,
      receivedAtPerf: 0,
    });
    await lane.idle();

    expect(flushes).toBe(2);
    expect(recordTiming).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'snapshot_event_posted' }),
    );
  });

  it('skips the snapshot_event_posted record when the outbox makes no forward progress', async () => {
    const recordTiming = jest.fn();
    const harness = createHarness(
      (command, context): Promise<void> => {
        context.enqueueEvent(snapshotEvent('snap-1', command.id));
        return Promise.resolve();
      },
      {
        recordTiming,
        // A stalled outbox: flushes resolve but nothing ever leaves the queue
        // (e.g. every upload attempt fails and re-schedules). The drain must
        // bail out instead of spinning, and must not log a false posting time.
        flushOutbox: (): Promise<void> => Promise.resolve(),
      },
    );
    const lane = createPortalSnapshotLane(harness.deps);

    lane.enqueue({
      command: stateRequestCommand('cmd-1', 1),
      request: overviewRequest,
      receivedAtPerf: 0,
    });
    await lane.idle();

    expect(recordTiming).not.toHaveBeenCalled();
  });

  it('epoch bump discards queued entries and suppresses enqueues from the in-flight build', async () => {
    const gate = deferred();
    const persistCompletedCommand = jest.fn(
      (): Promise<void> => Promise.resolve(),
    );
    const harness = createHarness(
      async (command, context) => {
        if (command.id === 'cmd-1') {
          await gate.promise;
        }
        context.enqueueEvent(snapshotEvent(`snap-${command.id}`, command.id));
      },
      { persistCompletedCommand },
    );
    const lane = createPortalSnapshotLane(harness.deps);

    lane.enqueue({
      command: stateRequestCommand('cmd-1', 1),
      request: overviewRequest,
      receivedAtPerf: 0,
    });
    lane.enqueue({
      command: stateRequestCommand('cmd-2', 2),
      request: overviewRequest,
      receivedAtPerf: 0,
    });
    await Promise.resolve();
    expect(harness.log).toContain('execute:cmd-1');

    lane.reset();
    gate.resolve();
    await lane.idle();

    // The stale build's late enqueue is dropped, its completion is never
    // persisted, and the queued second entry never builds.
    expect(harness.log.filter((line) => line.startsWith('enqueue:'))).toEqual(
      [],
    );
    expect(persistCompletedCommand).not.toHaveBeenCalled();
    expect(harness.log).not.toContain('execute:cmd-2');

    // Entries enqueued after the reset belong to the new epoch and run
    // normally.
    lane.enqueue({
      command: stateRequestCommand('cmd-3', 3),
      request: overviewRequest,
      receivedAtPerf: 0,
    });
    await lane.idle();
    expect(harness.log).toContain('execute:cmd-3');
    expect(persistCompletedCommand).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: 'cmd-3' }),
    );
  });

  it('synthesizes portal.command.failed and keeps serving after a build rejects', async () => {
    const onError = jest.fn();
    const persistCompletedCommand = jest.fn<
      Promise<void>,
      [
        {
          commandId: string;
          sequence: number;
          events: PortalEventEnvelope[];
        },
      ]
    >(() => Promise.resolve());
    const harness = createHarness(
      (command, context): Promise<void> => {
        if (command.id === 'cmd-1') {
          return Promise.reject(new Error('build exploded'));
        }
        context.enqueueEvent(snapshotEvent(`snap-${command.id}`, command.id));
        return Promise.resolve();
      },
      { onError, persistCompletedCommand },
    );
    const lane = createPortalSnapshotLane(harness.deps);

    lane.enqueue({
      command: stateRequestCommand('cmd-1', 1),
      request: overviewRequest,
      receivedAtPerf: 0,
    });
    lane.enqueue({
      command: stateRequestCommand('cmd-2', 2),
      request: overviewRequest,
      receivedAtPerf: 0,
    });
    await lane.idle();

    // The browser must get a terminal signal for cmd-1, and the failure is
    // persisted so a redelivered command would replay it.
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'execute');
    expect(harness.log).toContain('enqueue:failed-cmd-1');
    expect(persistCompletedCommand).toHaveBeenCalledWith({
      commandId: 'cmd-1',
      sequence: 1,
      events: [expect.objectContaining({ eventId: 'failed-cmd-1' })],
    });
    expect(harness.log).toContain('execute:cmd-2');
    expect(persistCompletedCommand).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: 'cmd-2' }),
    );
  });

  it('reports a persist rejection without contradicting an already-terminal build', async () => {
    const onError = jest.fn();
    const harness = createHarness(
      (command, context): Promise<void> => {
        context.enqueueEvent(snapshotEvent(`snap-${command.id}`, command.id));
        // Production executePortalStateRequest always enqueues its own
        // completed event; the lane must not follow it with a synthesized
        // failure for the same command.
        context.enqueueEvent(completedEvent(`done-${command.id}`, command.id));
        return Promise.resolve();
      },
      {
        onError,
        persistCompletedCommand: (input): Promise<void> => {
          if (input.commandId === 'cmd-1') {
            return Promise.reject(new Error('disk full'));
          }
          return Promise.resolve();
        },
      },
    );
    const lane = createPortalSnapshotLane(harness.deps);

    lane.enqueue({
      command: stateRequestCommand('cmd-1', 1),
      request: overviewRequest,
      receivedAtPerf: 0,
    });
    lane.enqueue({
      command: stateRequestCommand('cmd-2', 2),
      request: overviewRequest,
      receivedAtPerf: 0,
    });
    await lane.idle();

    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'persist');
    // The build already produced its own terminal completed event, so no
    // synthesized failure may follow it — the browser would see a
    // contradictory completed-then-failed for a command that succeeded.
    expect(harness.log).not.toContain('enqueue:failed-cmd-1');
    expect(harness.log).toContain('flush');
    expect(harness.log).toContain('timing:cmd-1');
    expect(harness.log).toContain('execute:cmd-2');
  });

  it('routes a flush rejection to onError and keeps serving later entries', async () => {
    const onError = jest.fn();
    let flushAttempts = 0;
    const harness = createHarness(
      (command, context): Promise<void> => {
        context.enqueueEvent(snapshotEvent(`snap-${command.id}`, command.id));
        return Promise.resolve();
      },
      { onError },
    );
    harness.deps.flushOutbox = (): Promise<void> => {
      flushAttempts += 1;
      if (flushAttempts === 1) {
        return Promise.reject(new Error('offline'));
      }
      harness.outbox.length = 0;
      return Promise.resolve();
    };
    const lane = createPortalSnapshotLane(harness.deps);

    lane.enqueue({
      command: stateRequestCommand('cmd-1', 1),
      request: overviewRequest,
      receivedAtPerf: 0,
    });
    lane.enqueue({
      command: stateRequestCommand('cmd-2', 2),
      request: overviewRequest,
      receivedAtPerf: 0,
    });
    await lane.idle();

    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'flush');
    // No false posting time for cmd-1 (its flush failed); cmd-2 proceeds.
    expect(harness.log).not.toContain('timing:cmd-1');
    expect(harness.log).toContain('execute:cmd-2');
    expect(harness.log).toContain('timing:cmd-2');
  });
});
