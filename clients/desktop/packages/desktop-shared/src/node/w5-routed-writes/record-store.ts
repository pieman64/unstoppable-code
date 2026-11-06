import {
  createW5CommitLogFileStore,
  type W5CommitLogFileStore,
} from '@canopy/core-runtime/node/w5/commit-log-file-store';
import {
  createW5RecordHostPort,
  type W5RecordPortTransport,
} from '@canopy/core-runtime/node/w5/record-port';
import {
  admitStorageWrite,
  createStorageAuthorityAdmission,
  routeStorageAdmissionToAuthority,
  withStorageAdmission,
} from '../lib/storage-admission';
import { W5_RECORD_NAMESPACES } from './selector';

export type { W5CommitLogFileStore, W5RecordPortTransport };

/*
 * W6h0 (CAN-5554): the W5 store a CLI or headless built-in host writes
 * through once the selector routes (C1), over an injected record-port
 * transport, so this package needs no daemon client. It is W6g's image port
 * as Electron's daemon-backed store composes it: the host reads fresh images
 * from the authority's recovered position, never the local disk, applies its
 * decisions, and the daemon checks ownership as `daemon`, the fingerprints
 * and the revisions, then commits. Nothing here writes a W5 file.
 */

export interface W5RoutedRecordStoreOptions {
  readonly transport: W5RecordPortTransport;
  /** This host's W5 root; targets project onto it. */
  readonly root: string;
  readonly warn: (message: string, context: Record<string, unknown>) => void;
}

export interface W5RoutedRecordStore {
  readonly store: W5CommitLogFileStore;
  /** Restores local admission's principal check. */
  close(): void;
}

/**
 * Opens the routed store and moves the W5 principal check from local
 * admission to the authority until `close`. Admission keeps its holds.
 */
export function openW5RoutedRecordStore(
  options: W5RoutedRecordStoreOptions,
): W5RoutedRecordStore {
  const store = createRoutedStore(options);
  const unroute = routeStorageAdmissionToAuthority(W5_RECORD_NAMESPACES);
  return { store, close: unroute };
}

function createRoutedStore(
  options: W5RoutedRecordStoreOptions,
): W5CommitLogFileStore {
  const { root, warn } = options;
  const port = createW5RecordHostPort({
    root,
    transport: options.transport,
    onUnserved: ({ operation, reason }) => {
      if (reason === 'limit-exceeded')
        warn('W5 record unserved', { operation, reason });
    },
  });
  const store = createW5CommitLogFileStore({
    getHost: () => port,
    warn,
    readFile: (path) => port.readFile(path),
    readFileForCommit: (path) => port.readFile(path, true),
    admit: (targets, operation) => withStorageAdmission(targets, operation),
    admitWrite: (target, write) => admitStorageWrite(target, write),
    // The authority checks ownership as `daemon`.
    assertWrite: () => undefined,
  });
  return store;
}

export interface ScopedW5RoutedRecordStore extends W5RoutedRecordStore {
  run<T>(operation: (store: W5CommitLogFileStore) => Promise<T>): Promise<T>;
}

/** No process-global routing. The owner must also retire its transport. */
export function createScopedW5RoutedRecordStore(
  options: W5RoutedRecordStoreOptions,
): ScopedW5RoutedRecordStore {
  const admission = createStorageAuthorityAdmission(W5_RECORD_NAMESPACES);
  const store = createRoutedStore(options);
  return {
    store,
    run: (operation) => admission.run(() => operation(store)),
    close: () => admission.close(),
  };
}
