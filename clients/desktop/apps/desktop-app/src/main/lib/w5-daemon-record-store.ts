import type { CanopyClient } from '@canopy/core-client';
import {
  createW5CommitLogFileStore,
  type W5CommitLogFileStore,
} from '@canopy/core-runtime/node/w5/commit-log-file-store';
import {
  createW5RecordHostPort,
  w5RecordTargetFor,
  type W5RecordPortTransport,
} from '@canopy/core-runtime/node/w5/record-port';
import type {
  CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
} from '@canopy/protocol/canopy-core';
import {
  admitStorageWrite,
  routeStorageAdmissionToAuthority,
} from '@canopy/desktop-shared/node/lib/storage-admission';
import { logMainProcessWarn } from './main-process-logging';
import { getWorkspacesRootDir } from './paths';
import { __setDesktopW5FileStoreForTests } from './w5-commit-log-file-store';
import type { W5FileRead } from './w5-file-store';
import {
  recordW5PortConflict,
  setW5PreEffectAttempts,
} from './w5-pre-effect-retry';
import { admitW5Storage } from './w5-storage';

/*
 * TRANSITIONAL (CAN-5498, W6g): Electron main's W5 store over a daemon that
 * hosts the commit log, through the trusted `core.workspaceRecords.*` port.
 * Tombstones, the sidebar group reconciler, publication and the destructive
 * journals stay here; the daemon decides, and holds receipts and reservations
 * (CAN-5506), whose diagnostics this store builds and alone reads back
 * (DQ-7 reading (i)). The daemon opens the log exclusively and a scope cannot
 * span stores, so once it hosts the log every W5 write must take this store.
 * There is no production selector (D1(a)):
 * only test and qualification compositions install it. Remove at W15.
 */

export type W5RecordPortClient = CanopyClient<
  typeof CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
  typeof CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
  Record<never, never>
>;

/** A18′ bound: each outermost pre-effect unit gets three attempts. */
const DAEMON_PRE_EFFECT_ATTEMPTS = 3;

export function w5RecordPortTransport(
  client: W5RecordPortClient,
): W5RecordPortTransport {
  return {
    capture: (request) =>
      client.query('core.workspaceRecords.capture', {
        files: request.files.map((file) => ({ ...file })),
        discoverWorkspaces: request.discoverWorkspaces,
      }),
    recovery: () => client.query('core.workspaceRecords.recovery.get', {}),
    commit: (request) =>
      client.instruction('core.workspaceRecords.commit', request),
    lookupReceipt: (receipt) =>
      client.query('core.workspaceRecords.receipt.lookup', { receipt }),
    listReservations: () =>
      client.query('core.workspaceRecords.reservation.list', {}),
    reserve: async (params) => {
      await client.instruction(
        'core.workspaceRecords.reservation.reserve',
        params,
      );
    },
    updateReservationDiagnostics: async (params) => {
      await client.instruction(
        'core.workspaceRecords.reservation.updateDiagnostics',
        params,
      );
    },
    releaseReservation: async (reservationId) => {
      await client.instruction('core.workspaceRecords.reservation.release', {
        reservationId,
      });
    },
    markReservationRecoveryRequired: async (params) => {
      await client.instruction(
        'core.workspaceRecords.reservation.markRecoveryRequired',
        params,
      );
    },
  };
}

/** The core store with the record port as its host, Electron's root and reads. */
export function createW5DaemonRecordStore(options: {
  readonly transport: W5RecordPortTransport;
  /** Electron's W5 root; defaults to the data root's `workspaces`. */
  readonly root?: string;
}): W5CommitLogFileStore {
  const root = options.root ?? getWorkspacesRootDir();
  const port = createW5RecordHostPort({
    root,
    transport: options.transport,
    onConflict: ({ operation, kind }) => recordW5PortConflict(operation, kind),
  });
  // Fresh reads come from the authority's recovered position, never the local
  // disk, which can show a half-applied multi-file commit.
  const readFile = async (filePath: string): Promise<W5FileRead> => {
    const target = w5RecordTargetFor(root, filePath);
    if (!target)
      return {
        state: 'unreadable',
        error: new Error(
          'This file is not a W5 record under the trusted root.',
        ),
      };
    try {
      const { files } = await port.capture({
        files: [target],
        discoverWorkspaces: false,
      });
      const [image] = files;
      if (image?.state === 'present')
        return {
          state: 'present',
          raw: Buffer.from(image.base64, 'base64').toString('utf8'),
        };
      if (image?.state === 'absent') return { state: 'absent' };
      return { state: 'unreadable' };
    } catch (error) {
      return {
        state: 'unreadable',
        ...(error instanceof Error ? { error } : {}),
      };
    }
  };
  return createW5CommitLogFileStore({
    getHost: () => port,
    warn: (message, context) => logMainProcessWarn(message, context),
    readFile,
    admit: (targets, operation) => admitW5Storage(targets, operation),
    admitWrite: (target, write) => admitStorageWrite(target, write),
    // The authority checks ownership as `daemon`.
    assertWrite: () => undefined,
  });
}

/**
 * Installs `store` as desktop main's W5 store, routes the three W5
 * namespaces to the authority and enables the bounded retry. Returns the
 * restore of routing and retry; the caller resets the store.
 */
export function installW5DaemonRecordStoreForTests(
  store: W5CommitLogFileStore,
): () => void {
  __setDesktopW5FileStoreForTests(store);
  const unroute = routeStorageAdmissionToAuthority([
    'workspace_index',
    'workspace_manifest',
    'worktree_list',
  ]);
  const unretry = setW5PreEffectAttempts(DAEMON_PRE_EFFECT_ATTEMPTS);
  return (): void => {
    unretry();
    unroute();
  };
}
