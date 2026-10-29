import { isDeepStrictEqual } from 'node:util';
import {
  isCanopySnapshotRequiredError,
  type CanopyCallerDescriptor,
  type CanopyErrorPayload,
  type CanopyQueryResult,
  type CanopyStreamCursor,
  type CanopyStreamEnd,
} from '@canopy/protocol/canopy-core';
import type {
  CanopyClientStreamFrame,
  CanopyEventCursorStore,
} from '@canopy/core-client';
import type { DesktopCanopyDispatcher } from '../desktop-runtime';
import { acquireW4Within, settleW4LateReleases } from './w4-acquisition';
import {
  W4_CHAT_SCOPE,
  assertW4Parity,
  createW4ParitySession,
  startW4DispatcherHost,
  type W4ChatItem,
  type W4DispatcherHost,
  type W4ChatDriver,
  type W4ParityBackend,
  type W4ParityBinding,
  type W4ParitySession,
} from './w4-parity-harness';

type ChatItem = W4ChatItem;
type ChatFrame = CanopyClientStreamFrame<
  ChatItem,
  CanopyStreamEnd<'core.chat.events'>
>;
type ChatSnapshot = CanopyQueryResult<'core.chat.snapshot.get'>;
type Session = W4ParitySession;
type OpenChatEvents = (
  cursor: CanopyStreamCursor | null,
  onFrame: (frame: ChatFrame) => void,
) => Promise<{ close(): void }>;
interface ChatTerminal {
  outcome: string;
  error: CanopyErrorPayload | null;
}
interface ChatRecovery {
  refused: CanopyStreamCursor;
  /** The refusal terminal exactly as the client received it. */
  terminal: ChatTerminal;
  // Derived from the refusal; epoch evidence arrives only with a handled item.
  reason: 'snapshot_required';
  snapshot: ChatSnapshot;
  epochChanged?: boolean;
}
interface ChatConsumer {
  received: ChatItem[];
  handled: Array<{ item: ChatItem; cursor: CanopyStreamCursor }>;
  recoveries: ChatRecovery[];
  readonly opened: number;
  ready: Promise<void>;
  idle: () => Promise<void>;
  close: () => void;
}

const AUTHORITY = 'local-desktop';
const SCOPE = W4_CHAT_SCOPE;
const SNAPSHOT_PARAMS = {
  scope: { workspaceId: SCOPE.projectId, worktreeId: SCOPE.worktreeId },
};
const KEY = JSON.stringify(['core.chat.events', SCOPE]);
const directCaller: CanopyCallerDescriptor = {
  principalId: 'w4-parity',
  clientInstanceId: 'w4-direct-anchor',
  authorityId: AUTHORITY,
  interfaceKind: 'test',
  grants: ['core.chat.read'],
};

// The adapter's refusal for a cursor outside its live window or epoch.
const SNAPSHOT_REQUIRED_TERMINAL: ChatTerminal = {
  outcome: 'error',
  error: {
    kind: 'failed_precondition',
    code: 'core.chat.snapshotRequired',
    message: 'Read a chat snapshot before reopening the event stream.',
    retry: { kind: 'after_refresh', resource: 'core.chat.snapshot.get' },
  },
};

function assertSnapshotRequiredTerminal(recovery: ChatRecovery): void {
  if (!isDeepStrictEqual(recovery.terminal, SNAPSHOT_REQUIRED_TERMINAL))
    throw new Error(
      `Unexpected refusal terminal payload: ${JSON.stringify(recovery.terminal)}.`,
    );
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 2_000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400 && !condition(); attempt += 1)
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  if (!condition()) throw new Error(`Condition not met: ${label}`);
}

function createStore(initial: CanopyStreamCursor | null = null): {
  store: CanopyEventCursorStore;
  saves: Array<CanopyStreamCursor | null>;
} {
  let saved = initial;
  const saves: Array<CanopyStreamCursor | null> = [];
  return {
    saves,
    store: {
      load: (authorityId, key) =>
        Promise.resolve(
          authorityId === AUTHORITY && key === KEY && saved
            ? { ...saved }
            : null,
        ),
      save: (_authorityId, _key, cursor): Promise<void> => {
        saved = cursor ? { ...cursor } : null;
        saves.push(saved);
        return Promise.resolve();
      },
    },
  };
}

// Test-side resume loop over the generic K4 cursor-store contract. It sees only
// stream frames and snapshot reads, never the initialize identity.
function attachChatConsumer(
  open: OpenChatEvents,
  readSnapshot: () => Promise<ChatSnapshot>,
  store: CanopyEventCursorStore,
  handle: (item: ChatItem) => Promise<void>,
): ChatConsumer {
  const received: ChatItem[] = [];
  const handled: ChatConsumer['handled'] = [];
  const recoveries: ChatRecovery[] = [];
  const streams: Array<{ close(): void }> = [];
  let closed = false;
  let tail = Promise.resolve();
  const enqueue = (work: () => Promise<void>): void => {
    tail = tail.then(() => (closed ? undefined : work()));
  };
  const openFrom = async (cursor: CanopyStreamCursor | null): Promise<void> => {
    const stream = await open(cursor, (frame) => {
      if (closed) return;
      if (frame.kind === 'end') {
        const terminal = { outcome: frame.outcome, error: frame.error };
        if (cursor && isCanopySnapshotRequiredError(frame.error))
          enqueue(() => recover(cursor, terminal));
        return;
      }
      received.push(frame.item);
      enqueue(async () => {
        await handle(frame.item);
        // Checkpoint only after the handler resolves on a still-open connection.
        if (closed) return;
        handled.push({ item: frame.item, cursor: frame.cursor });
        const pending = recoveries.find(
          (entry) => entry.epochChanged === undefined,
        );
        if (pending)
          pending.epochChanged =
            frame.cursor.daemonEpoch !== pending.refused.daemonEpoch;
        await store.save(AUTHORITY, KEY, frame.cursor);
      });
    });
    streams.push(stream);
    if (closed) stream.close();
  };
  const recover = async (
    refused: CanopyStreamCursor,
    terminal: ChatTerminal,
  ): Promise<void> => {
    await store.save(AUTHORITY, KEY, null);
    const snapshot = await readSnapshot();
    recoveries.push({
      refused,
      terminal,
      reason: 'snapshot_required',
      snapshot,
    });
    if (!closed) await openFrom(null);
  };
  const ready = store.load(AUTHORITY, KEY).then(openFrom);
  return {
    received,
    handled,
    recoveries,
    get opened(): number {
      return streams.length;
    },
    ready,
    idle: () => tail,
    close: (): void => {
      closed = true;
      streams.forEach((stream) => stream.close());
    },
  };
}

function daemonConsumer(
  session: Session,
  store: CanopyEventCursorStore,
  handle: (item: ChatItem) => Promise<void> = () => Promise.resolve(),
): ChatConsumer {
  const consumer = attachChatConsumer(
    (cursor, onFrame) =>
      session.client.openStream(
        'core.chat.events',
        { scope: SCOPE, cursor },
        { onFrame },
      ),
    () => session.client.query('core.chat.snapshot.get', SNAPSHOT_PARAMS),
    store,
    handle,
  );
  session.client.signal.addEventListener('abort', consumer.close, {
    once: true,
  });
  return consumer;
}

async function assertSnapshotParity(
  runtime: DesktopCanopyDispatcher,
  snapshot: ChatSnapshot,
): Promise<void> {
  await assertW4Parity(
    'core.chat.snapshot.get',
    () =>
      runtime.query('core.chat.snapshot.get', SNAPSHOT_PARAMS, {
        caller: directCaller,
      }),
    () => Promise.resolve(snapshot),
  );
}

interface ChatScenarioContext {
  /** Independent direct baseline: the production dispatcher on its own state. */
  direct: W4DispatcherHost;
  backend: W4ParityBackend;
  connect: () => Promise<Session>;
  track: <T extends { close(): void }>(resource: T) => T;
  /** Applies the same commit to both sides; awaits the backend's driver. */
  commit: () => Promise<void>;
  /** Restarts both sides; the backend's stream epoch must change. */
  restart: () => Promise<void>;
}
type ChatScenario = (context: ChatScenarioContext) => Promise<void>;

// Independent dispatchers issue unrelated cursor epochs and sequences, so the
// scenarios compare item payloads and order across sides, never cursors.
const SCENARIOS = {
  'resumes from the last handled cursor and redelivers the unhandled item after reconnect':
    async ({ direct, connect, track, commit }): Promise<void> => {
      const { store, saves } = createStore();
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = await connect();
      const consumer = track(
        daemonConsumer(first, store, (item) =>
          item.revision === 2 ? held : Promise.resolve(),
        ),
      );
      await within(consumer.ready, 'first open');
      await commit();
      await commit();
      await commit();
      await until(() => consumer.received.length === 3, 'three received');
      await until(() => saves.length === 1, 'first checkpoint');
      expect(consumer.handled.map(({ item }) => item.revision)).toEqual([1]);
      const lastHandled = consumer.handled[0]?.cursor ?? null;
      await within(first.disconnect(), 'mid-stream disconnect');
      await until(() => first.client.signal.aborted, 'client aborted');
      release();
      await within(consumer.idle(), 'held handler settles');
      expect(consumer.handled).toHaveLength(1);
      expect(saves).toEqual([lastHandled]);
      await expect(store.load(AUTHORITY, KEY)).resolves.toEqual(lastHandled);

      const second = await connect();
      const resumed = track(daemonConsumer(second, store));
      await within(resumed.ready, 'resume open');
      await until(() => resumed.handled.length === 2, 'redelivery');
      await within(resumed.idle(), 'resumed handlers');
      expect(resumed.recoveries).toEqual([]);
      expect(consumer.received).toEqual(direct.items);
      expect(resumed.received).toEqual(direct.items.slice(1));
      expect(resumed.handled.map(({ item }) => item.eventId)).toEqual([
        'w4-event-2',
        'w4-event-3',
      ]);
      expect(resumed.handled[0]?.cursor.daemonEpoch).toBe(
        lastHandled?.daemonEpoch,
      );
      expect(saves.at(-1)).toEqual(resumed.handled[1]?.cursor);
    },
  're-queries the canonical snapshot via the daemon for an expired cursor, then opens live':
    (context): Promise<void> => recoverFromRefusedCursor(context, 'expired'),
  're-queries the canonical snapshot via the daemon for a foreign cursor, then opens live':
    (context): Promise<void> => recoverFromRefusedCursor(context, 'foreign'),
  'rehydrates after a restarted stream rejects the previous epoch': async ({
    direct,
    connect,
    track,
    commit,
    restart,
  }): Promise<void> => {
    const { store, saves } = createStore();
    const first = await connect();
    const consumer = track(daemonConsumer(first, store));
    await within(consumer.ready, 'first open');
    await commit();
    await until(() => consumer.handled.length === 1, 'first handled');
    const previous = consumer.handled[0]?.cursor;
    if (!previous) throw new Error('Expected a pre-restart checkpoint.');
    expect(consumer.received).toEqual(direct.items);
    await within(first.disconnect(), 'disconnect');
    await within(restart(), 'restart');

    const session = await connect();
    const restarted = track(daemonConsumer(session, store));
    await within(restarted.ready, 'reopen after restart');
    await until(() => restarted.opened === 2, 'recovered live open');
    const recovery = restarted.recoveries[0];
    if (!recovery) throw new Error('Expected a snapshot recovery.');
    expect(recovery).toMatchObject({
      refused: previous,
      reason: 'snapshot_required',
    });
    assertSnapshotRequiredTerminal(recovery);
    expect(recovery.epochChanged).toBeUndefined();
    await assertSnapshotParity(direct.runtime, recovery.snapshot);
    expect(recovery.snapshot.revision).toBe(1);

    await commit();
    await until(() => restarted.handled.length === 1, 'live item');
    await within(restarted.idle(), 'live handler');
    const next = restarted.handled[0]?.cursor;
    expect(restarted.received).toEqual(direct.items);
    expect(recovery.epochChanged).toBe(true);
    expect(next?.daemonEpoch).not.toBe(previous.daemonEpoch);
    expect(saves.slice(-2)).toEqual([null, next]);
  },
} satisfies Record<string, ChatScenario>;

async function recoverFromRefusedCursor(
  { direct, connect, track, commit }: ChatScenarioContext,
  kind: 'expired' | 'foreign',
): Promise<void> {
  const { store, saves } = createStore();
  if (kind === 'expired') {
    const first = await connect();
    const consumer = track(daemonConsumer(first, store));
    await within(consumer.ready, 'first open');
    await commit();
    await until(() => consumer.handled.length === 1, 'first handled');
    await within(first.disconnect(), 'disconnect');
    // Exceeds the adapter's 128-batch live window.
    for (let index = 0; index < 130; index += 1) await commit();
  } else {
    await store.save(AUTHORITY, KEY, {
      daemonEpoch: 'foreign-epoch',
      sequence: 1,
    });
  }
  const refused = await store.load(AUTHORITY, KEY);
  const session = await connect();
  const consumer = track(daemonConsumer(session, store));
  await within(consumer.ready, 'reopen');
  await until(() => consumer.opened === 2, 'recovered live open');
  const recovery = consumer.recoveries[0];
  if (!recovery) throw new Error('Expected a snapshot recovery.');
  expect(recovery).toMatchObject({ refused, reason: 'snapshot_required' });
  assertSnapshotRequiredTerminal(recovery);
  expect(saves.at(-1)).toBeNull();
  await assertSnapshotParity(direct.runtime, recovery.snapshot);
  expect(recovery.snapshot.revision).toBe(direct.revision());

  const directBefore = direct.items.length;
  await commit();
  await until(() => consumer.handled.length === 1, 'live item');
  await within(consumer.idle(), 'live handler');
  expect(consumer.received).toEqual(direct.items.slice(directBefore));
  expect(recovery.epochChanged).toBe(kind === 'foreign');
  expect(saves.at(-1)).toEqual(consumer.handled[0]?.cursor);
}

export type W4ChatScenarioName = keyof typeof SCENARIOS;
export const W4_CHAT_SCENARIO_NAMES = Object.keys(SCENARIOS).filter(
  (name): name is W4ChatScenarioName => name in SCENARIOS,
);

/**
 * Runs one scenario on a fresh direct host and a fresh selected backend. A
 * backend or session that arrives after its timeout is released, not leaked.
 */
export async function runW4ChatScenario(
  binding: W4ParityBinding,
  name: W4ChatScenarioName,
): Promise<void> {
  const cleanups: Array<() => Promise<void> | void> = [];
  let outcome: { failed: false } | { failed: true; error: unknown } = {
    failed: false,
  };
  try {
    const direct = await startW4DispatcherHost('w4-direct-anchor');
    cleanups.push(() => direct.shutdown());
    const backend = await acquireW4Within(
      binding.start(),
      (value) => value.shutdown(),
      'backend start',
    );
    cleanups.push(() => backend.shutdown());
    await SCENARIOS[name]({
      direct,
      backend,
      connect: async () => {
        const session = await acquireW4Within(
          createW4ParitySession(backend),
          (value) => value.disconnect(),
          'daemon session',
          3_000,
        );
        cleanups.push(() => session.disconnect());
        return session;
      },
      track: (resource) => {
        cleanups.push(() => resource.close());
        return resource;
      },
      commit: async () => {
        direct.commit();
        await within(backend.chat.commit(), 'backend commit');
      },
      restart: async () => {
        await backend.chat.restart();
        await direct.restart();
      },
    });
  } catch (error) {
    outcome = { failed: true, error };
  }
  const failures: unknown[] = [];
  for (const cleanup of cleanups.reverse()) {
    try {
      await within(Promise.resolve(cleanup()), 'cleanup');
    } catch (error) {
      failures.push(error);
    }
  }
  if (!failures.length) {
    if (outcome.failed) throw outcome.error;
    return;
  }
  if (!outcome.failed)
    throw new AggregateError(failures, 'W4 chat cleanup failed');
  const primary = outcome.error;
  throw new AggregateError(
    [primary, ...failures],
    `W4 chat scenario failed (${primary instanceof Error ? primary.message : String(primary)}) and cleanup failed`,
  );
}

export const W4_CHAT_RESUME_SCENARIO: W4ChatScenarioName =
  'resumes from the last handled cursor and redelivers the unhandled item after reconnect';
export const W4_CHAT_FOREIGN_SCENARIO: W4ChatScenarioName =
  're-queries the canonical snapshot via the daemon for a foreign cursor, then opens live';
export const W4_CHAT_RESTART_SCENARIO: W4ChatScenarioName =
  'rehydrates after a restarted stream rejects the previous epoch';

export type W4ChatFault = keyof W4ChatDriver;

/** Each driver fault must fail its scenario after the endpoint is ready. */
export function runW4ChatControlChecks(
  binding: W4ParityBinding,
  hooks: {
    /** Called each time the targeted fault runs, so callers can order it. */
    reached?: (fault: W4ChatFault) => void;
    assertReady?: (fault: W4ChatFault) => Promise<void> | void;
  } = {},
): void {
  const faults: ReadonlyArray<[W4ChatFault, W4ChatScenarioName, string]> = [
    ['commit', W4_CHAT_RESUME_SCENARIO, 'Condition not met: three received'],
    [
      'restart',
      W4_CHAT_RESTART_SCENARIO,
      'Condition not met: recovered live open',
    ],
  ];
  describe(`W4 chat negative controls: ${binding.name}`, () => {
    afterEach(() => settleW4LateReleases());
    it.each(faults)(
      'fails when the backend ignores %s',
      async (fault, scenario, failure) => {
        let reached = false;
        const ignore = (): Promise<void> => {
          reached = true;
          hooks.reached?.(fault);
          return Promise.resolve();
        };
        const faulty: W4ParityBinding = {
          name: `ignore ${fault}`,
          async start(): Promise<W4ParityBackend> {
            const backend = await binding.start();
            const chat = { ...backend.chat, [fault]: ignore };
            return { ...backend, chat };
          },
        };
        await expect(runW4ChatScenario(faulty, scenario)).rejects.toThrow(
          failure,
        );
        expect(reached).toBe(true);
        await hooks.assertReady?.(fault);
      },
    );
  });
}

export function runW4ChatParity(binding: W4ParityBinding): void {
  describe(`W4 core.chat.events parity: ${binding.name}`, () => {
    afterEach(() => settleW4LateReleases());
    it.each(W4_CHAT_SCENARIO_NAMES)('%s', (name) =>
      runW4ChatScenario(binding, name),
    );
  });
}
