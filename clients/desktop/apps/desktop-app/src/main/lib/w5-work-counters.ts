import { basename } from 'node:path';
import type { W5CommitLogHostPort } from '@canopy/core-runtime/node/w5/commit-log-file-store';
import type { W5RecordPortTransport } from '@canopy/core-runtime/node/w5/record-port';
import { CanopyErrorPayloadSchema } from '@canopy/protocol/canopy-core';
import { recordW5Work } from '@canopy/desktop-shared/node/work-counters';

/*
 * CAN-5532: W5 store work counters, counted in every build. They compare the
 * in-process store with the daemon-backed one: reads by record class and
 * source, host captures and commits, and record-port calls, each with its
 * microsecond total. Counting never changes what the counted call does.
 */

export type W5RecordFileClass = 'index' | 'manifest' | 'worktrees' | 'other';

/** The W5 record class a store path names, by its file name. */
export function w5RecordFileClass(filePath: string): W5RecordFileClass {
  switch (basename(filePath)) {
    case 'index.json':
    case 'index.json.bak':
      return 'index';
    case 'workspace.json':
      return 'manifest';
    case 'worktrees.json':
      return 'worktrees';
    default:
      return 'other';
  }
}

function recordElapsed(key: string, startedAt: number): void {
  recordW5Work(`${key}.us`, Math.round((performance.now() - startedAt) * 1000));
}

async function timed<T>(key: string, call: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    return await call();
  } finally {
    recordElapsed(key, startedAt);
  }
}

const countedHosts = new WeakMap<W5CommitLogHostPort, W5CommitLogHostPort>();

/**
 * `host` with its captures, commits and revision reads counted. One view per
 * host, sharing the host's final-decision queue (`commitQueueKey`).
 */
export function countingW5HostPort(
  host: W5CommitLogHostPort,
): W5CommitLogHostPort {
  const existing = countedHosts.get(host);
  if (existing) return existing;
  const view: W5CommitLogHostPort = {
    get root(): string {
      return host.root;
    },
    commitQueueKey: host.commitQueueKey ?? host,
    recoveryReport: () => host.recoveryReport(),
    async commit(request) {
      recordW5Work(`host.commit.${request.operation}`);
      try {
        return await timed('host.commit', () => host.commit(request));
      } catch (error) {
        recordW5Work('host.commit.failed');
        throw error;
      }
    },
    lookupReceipt: (receipt) => host.lookupReceipt(receipt),
    reserve: (input) => host.reserve(input),
    updateReservationDiagnostics: (reservationId, diagnostics) =>
      host.updateReservationDiagnostics(reservationId, diagnostics),
    releaseReservation: (reservationId) =>
      host.releaseReservation(reservationId),
    markReservationRecoveryRequired: (reservationId, diagnostics) =>
      host.markReservationRecoveryRequired(reservationId, diagnostics),
    revision(resource) {
      recordW5Work('host.revision');
      return host.revision(resource);
    },
    async capture(request) {
      recordW5Work('host.capture');
      const result = await timed('host.capture', () => host.capture(request));
      recordW5Work('host.capture.files', result.files.length);
      // The history each capture's chain evidence aggregates (CAN-5562):
      // every retained decision of each captured path, and the log's size.
      recordW5Work(
        'host.capture.chainDecisions',
        result.log.chains.reduce((sum, chain) => sum + chain.decisions, 0),
      );
      recordW5Work('host.capture.retainedCommits', result.log.retainedCommits);
      return result;
    },
  };
  countedHosts.set(host, view);
  return view;
}

/**
 * The counter keys of one failed record-port call: its error kind, and for a
 * typed authority refusal its code and, when it names one, its reason (such
 * as `writeRefused.unlisted_writer`).
 */
export function w5PortFailureKeys(method: string, error: unknown): string[] {
  const payload =
    typeof error === 'object' && error !== null && 'payload' in error
      ? CanopyErrorPayloadSchema.safeParse(error.payload)
      : undefined;
  if (!payload?.success) return [`port.${method}.failed.untyped`];
  const { kind, code, details } = payload.data;
  const keys = [`port.${method}.failed.${kind}`];
  if (code) {
    const reason =
      typeof details === 'object' &&
      details !== null &&
      'reason' in details &&
      typeof details.reason === 'string'
        ? `.${details.reason}`
        : '';
    keys.push(
      `port.${method}.refused.${code.replace(/^core\.workspaceRecords\./, '')}${reason}`,
    );
  }
  return keys;
}

/** `transport` with every call, its failures and its time counted. */
export function countingW5RecordPortTransport(
  transport: W5RecordPortTransport,
): W5RecordPortTransport {
  const call = async <T>(method: string, run: () => Promise<T>): Promise<T> => {
    recordW5Work(`port.${method}`);
    const startedAt = performance.now();
    try {
      return await run();
    } catch (error) {
      for (const key of w5PortFailureKeys(method, error)) recordW5Work(key);
      throw error;
    } finally {
      recordElapsed(`port.${method}`, startedAt);
    }
  };
  return {
    capture: (request) => call('capture', () => transport.capture(request)),
    recovery: () => call('recovery', () => transport.recovery()),
    commit: (request) => call('commit', () => transport.commit(request)),
    lookupReceipt: (receipt) =>
      call('lookupReceipt', () => transport.lookupReceipt(receipt)),
    listReservations: () =>
      call('listReservations', () => transport.listReservations()),
    reserve: (params) => call('reserve', () => transport.reserve(params)),
    updateReservationDiagnostics: (params) =>
      call('updateReservationDiagnostics', () =>
        transport.updateReservationDiagnostics(params),
      ),
    releaseReservation: (reservationId) =>
      call('releaseReservation', () =>
        transport.releaseReservation(reservationId),
      ),
    markReservationRecoveryRequired: (params) =>
      call('markReservationRecoveryRequired', () =>
        transport.markReservationRecoveryRequired(params),
      ),
  };
}
