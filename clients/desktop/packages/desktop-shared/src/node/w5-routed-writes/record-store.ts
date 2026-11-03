import { W5CommitRefusedError } from '@canopy/core-runtime/node/w5/commit-log/errors';
import {
  createW5CommitLogFileStore,
  type W5CommitLogFileStore,
} from '@canopy/core-runtime/node/w5/commit-log-file-store';
import {
  W5RecordUnservedError,
  type W5FileRead,
} from '@canopy/core-runtime/node/w5/file-store';
import {
  createW5RecordHostPort,
  w5RecordTargetFor,
  w5UnnameableRecordFor,
  type W5RecordPortTransport,
} from '@canopy/core-runtime/node/w5/record-port';
import {
  admitStorageWrite,
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

const CAPTURE_OPERATION = 'core.workspaceRecords.capture';

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
  const { root, warn } = options;
  const port = createW5RecordHostPort({ root, transport: options.transport });
  // The two capture classes the port cannot serve stay unreadable, so their
  // writers refuse before any decision (CAN-5498 debt).
  const readFile = async (filePath: string): Promise<W5FileRead> => {
    const target = w5RecordTargetFor(root, filePath);
    if (!target) {
      const unnameable = w5UnnameableRecordFor(root, filePath);
      if (unnameable)
        return {
          state: 'unreadable',
          error: new W5RecordUnservedError('unsupported-id', unnameable.kind),
        };
      return {
        state: 'unreadable',
        error: new Error(
          'This file is not a W5 record under the trusted root.',
        ),
      };
    }
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
      if (
        error instanceof W5CommitRefusedError &&
        error.reason === 'invalid-state' &&
        error.details.capture === 'limit-exceeded'
      ) {
        warn('W5 record unserved', {
          operation: CAPTURE_OPERATION,
          reason: 'limit-exceeded',
        });
        return {
          state: 'unreadable',
          error: new W5RecordUnservedError(
            'limit-exceeded',
            target.kind,
            error,
          ),
        };
      }
      return {
        state: 'unreadable',
        ...(error instanceof Error ? { error } : {}),
      };
    }
  };
  const store = createW5CommitLogFileStore({
    getHost: () => port,
    warn,
    readFile,
    admit: (targets, operation) => withStorageAdmission(targets, operation),
    admitWrite: (target, write) => admitStorageWrite(target, write),
    // The authority checks ownership as `daemon`.
    assertWrite: () => undefined,
  });
  const unroute = routeStorageAdmissionToAuthority(W5_RECORD_NAMESPACES);
  return { store, close: unroute };
}
