import { EventEmitter } from 'node:events';
import type {
  CanopyClientStreamFrame,
  CanopyClientStreamHandle,
} from '@canopy/core-client';
import {
  ExecutionAccounting,
  type CanopyHandlerContext,
  type CanopyStreamSink,
  type ExecutionAccountingLimits,
  type PlatformProcessTable,
  type PlatformProcessTableRow,
} from '@canopy/core-runtime';
import type { ResourceMetadata } from '@canopy/desktop-shared/types';
import {
  CoreExecutionStatusGetResultSchema,
  type CanopyStreamCursor,
  type CoreExecutionStatusEventsItem,
} from '@canopy/protocol/canopy-core';
import {
  accountExecutionHost,
  createDaemonExecutionAccounting,
  createDaemonExecutionModule,
  DAEMON_EXECUTION_CHANGE_SAMPLE_MIN_MS,
} from '../../../../../core-daemon/src/execution';
import { createCoreExecutionAdapter } from '../core-execution-adapter';
import {
  createDaemonExecutionStatusSource,
  type DaemonExecutionStatusSession,
  type DaemonExecutionStatusSource,
} from '../daemon-execution-status';

// CAN-5700: the daemon publishes a status sample as soon as its host
// registrations change, rate limited, so the merged desktop view shows a new
// daemon host before the daemon's next periodic sample.

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
const DAEMON_PID = 100;
/** Far beyond the test, so no periodic sample can explain what it sees. */
const SAMPLE_INTERVAL_MS = 60_000;

type Item = CoreExecutionStatusEventsItem;
type Frame = CanopyClientStreamFrame<Item, unknown>;

const row = (
  pid: number,
  ppid: number,
  command: string,
): PlatformProcessTableRow => ({
  pid,
  ppid,
  pgid: pid,
  command,
  cpuPercent: 0,
  memoryRssBytes: 32 * MIB,
});

const context = (signal: AbortSignal): CanopyHandlerContext => ({
  requestId: 'status',
  caller: {
    principalId: 'local-user',
    clientInstanceId: 'electron-main',
    authorityId: 'local',
    interfaceKind: 'desktop',
    grants: ['core.execution.read'],
  },
  metadata: {},
  signal,
});

class FakeHost extends EventEmitter {
  constructor(readonly pid: number) {
    super();
  }
  postMessage(): void {}
  kill(): boolean {
    return true;
  }
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let turn = 0; turn < 300 && !(await check()); turn += 1)
    await new Promise((settle) => setTimeout(settle, 10));
  expect(await check()).toBe(true);
}

interface Fixture {
  /** Starts a daemon host process and accounts it as the graph module does. */
  readonly spawn: (pid: number, label: string) => FakeHost;
  /** The merged desktop view's item labels, as Portal reads them. */
  readonly desktopLabels: () => Promise<string[]>;
  /** A client reading the daemon's own status. */
  readonly daemonRead: () => Promise<void>;
  /** When each daemon sample read its process table. */
  daemonSamples: number[];
}

async function withDaemon(
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const daemonRows = new Map([[DAEMON_PID, row(DAEMON_PID, 1, 'daemon')]]);
  const daemonSamples: number[] = [];
  const daemonAccounting = createDaemonExecutionAccounting({
    supervision: {
      readProcessTable: (): Promise<PlatformProcessTable> => {
        daemonSamples.push(Date.now());
        return Promise.resolve({ kind: 'sampled', rows: new Map(daemonRows) });
      },
    },
    rootPid: DAEMON_PID,
    totalMemoryBytes: 64 * GIB,
  });
  const daemon = createDaemonExecutionModule(daemonAccounting, {
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
  });
  const service = daemon.services?.[0];
  const lifetime = new AbortController();
  await service?.start?.(lifetime.signal);

  // Electron main's connection to the daemon, carrying its status stream.
  const connection = new AbortController();
  const streams: Array<() => void> = [];
  const session: DaemonExecutionStatusSession = {
    lease: { state: 'active' },
    client: {
      signal: connection.signal,
      openStream: (
        _name,
        params,
      ): Promise<CanopyClientStreamHandle<Item, unknown>> => {
        const listeners = new Set<(frame: Frame) => void>();
        const buffered: Frame[] = [];
        let sequence = 0;
        const deliver = (item: Item): CanopyStreamCursor => {
          const cursor = { daemonEpoch: 'daemon', sequence: (sequence += 1) };
          const frame: Frame = { kind: 'item', cursor, item };
          if (listeners.size === 0) buffered.push(frame);
          for (const listener of Array.from(listeners)) listener(frame);
          return cursor;
        };
        const sink: CanopyStreamSink<Item> = {
          emit: (item) => deliver(item),
          emitAt: (cursor, item) => {
            deliver(item);
            return cursor;
          },
          end: () => undefined,
          endAt: () => undefined,
        };
        const stream = new AbortController();
        const opened = daemon.handlers.streams['core.execution.status.events'](
          params,
          context(stream.signal),
          sink,
        );
        const close = (): void => {
          stream.abort();
          void Promise.resolve(opened).then((stop) => stop?.());
        };
        streams.push(close);
        return Promise.resolve({
          requestId: 'status-events',
          openResult: { subscriptionId: 'status-events', acceptedCursor: null },
          frames: (async function* () {})(),
          onFrame: (listener) => {
            for (const frame of buffered.splice(0)) listener(frame);
            listeners.add(listener);
            return (): void => {
              listeners.delete(listener);
            };
          },
          close,
        });
      },
    },
  };
  const source: DaemonExecutionStatusSource =
    createDaemonExecutionStatusSource();
  source.observe(session);

  const electron = new ExecutionAccounting<ResourceMetadata>({
    rootPid: 1,
    readProcessTable: (): Promise<PlatformProcessTable> =>
      Promise.resolve({
        kind: 'sampled',
        rows: new Map([[1, row(1, 0, 'electron')]]),
      }),
    limits: (): ExecutionAccountingLimits => ({
      maxActive: {},
      memoryGuardEnabled: false,
      warningMemoryBytes: 2 * GIB,
      criticalMemoryBytes: 4 * GIB,
    }),
    productName: 'Desktop',
    groupLabel: (id): string => id,
    executionIdOf: (): undefined => undefined,
  });
  await electron.sample();
  const desktop = createCoreExecutionAdapter(
    () => Promise.resolve(electron),
    () => source,
  );
  const reading = new AbortController();

  try {
    await run({
      spawn: (pid, label) => {
        daemonRows.set(pid, row(pid, DAEMON_PID, `node ${label}`));
        const host = new FakeHost(pid);
        accountExecutionHost(daemonAccounting, host, {
          family: 'codeGraph',
          label,
          groupId: 'other',
          kind: 'other',
        });
        host.emit('spawn');
        return host;
      },
      desktopLabels: async () => {
        const { status } = CoreExecutionStatusGetResultSchema.parse(
          await desktop.queries['core.execution.status.get'](
            {},
            context(reading.signal),
          ),
        );
        return status.groups.flatMap((group) =>
          group.items.map((item) => item.label),
        );
      },
      daemonRead: async () => {
        await daemon.handlers.queries['core.execution.status.get'](
          {},
          context(reading.signal),
        );
      },
      daemonSamples,
    });
  } finally {
    source.close();
    for (const close of streams) close();
    connection.abort();
    await service?.stop?.[5]?.(lifetime.signal);
  }
}

describe('daemon status sample on host change (CAN-5700)', () => {
  it('shows a new daemon host in the merged desktop view before the next periodic sample', async () => {
    await withDaemon(async ({ spawn, desktopLabels, daemonSamples }) => {
      const started = Date.now();
      expect(await desktopLabels()).not.toContain('Graph host');

      const host = spawn(101, 'Graph host');
      await until(async () => (await desktopLabels()).includes('Graph host'));
      expect(Date.now() - started).toBeLessThan(SAMPLE_INTERVAL_MS);
      // Only the registration sampled: nothing read the daemon's status.
      expect(daemonSamples).toHaveLength(1);

      host.emit('exit', 0);
      await until(async () => !(await desktopLabels()).includes('Graph host'));
      expect(daemonSamples).toHaveLength(2);
    });
  });

  it('takes one sample for a burst of host changes, no sooner than the change interval', async () => {
    await withDaemon(async ({ spawn, desktopLabels, daemonSamples }) => {
      spawn(101, 'First host');
      await until(async () => (await desktopLabels()).includes('First host'));

      spawn(102, 'Second host');
      spawn(103, 'Third host');
      await until(async () => {
        const labels = await desktopLabels();
        return labels.includes('Second host') && labels.includes('Third host');
      });
      expect(daemonSamples).toHaveLength(2);
      const [first = 0, second = 0] = daemonSamples;
      // Timers may fire a millisecond early against Date.now().
      expect(second - first).toBeGreaterThanOrEqual(
        DAEMON_EXECUTION_CHANGE_SAMPLE_MIN_MS - 5,
      );
    });
  });

  it('waits the change interval after a sample a status read took while a change was pending', async () => {
    await withDaemon(
      async ({ spawn, desktopLabels, daemonRead, daemonSamples }) => {
        const pause = (ms: number): Promise<void> =>
          new Promise((settle) => setTimeout(settle, ms));
        spawn(101, 'First host');
        await until(async () => (await desktopLabels()).includes('First host'));

        // A change waits for the interval; a read inside it samples at once.
        spawn(102, 'Second host');
        await pause(100);
        await daemonRead();
        expect(daemonSamples).toHaveLength(2);
        await pause(100);
        spawn(103, 'Third host');

        await until(async () => (await desktopLabels()).includes('Third host'));
        expect(daemonSamples).toHaveLength(3);
        const [, read = 0, change = 0] = daemonSamples;
        expect(change - read).toBeGreaterThanOrEqual(
          DAEMON_EXECUTION_CHANGE_SAMPLE_MIN_MS - 5,
        );
      },
    );
  });
});
