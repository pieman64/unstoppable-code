import type {
  W5ReceiptKey,
  W5ReceiptLookup,
} from '../w5/commit-log/commit-log';
import type { W5ReceiptStore } from '../w5/keyed-operation';
import { W5CommitRefusedError } from '../w5/commit-log/errors';
import {
  movedOwnedPath,
  RelocationRefusedError,
  type RelocationTransition,
} from './transition';
import { fingerprintW5Parameters } from '../w5/keyed-operation';
import {
  projectW5HostPathFingerprint,
  type W5HostPathFlavor,
} from '../w5/host-path-fingerprint';
import type { WorkspaceRepositoryAddRequest } from '../w5/workspace-metadata/repositories';

/** Produced by the operation owner from the complete old/new typed request. */
export interface RelocatedReceipt {
  readonly objectId: string;
  readonly originalPath: string;
  readonly relocatedPath: string;
  readonly key: W5ReceiptKey;
  readonly originalFingerprint: string;
  readonly relocatedFingerprint: string;
}

const identity = (key: W5ReceiptKey): string =>
  JSON.stringify([key.caller, key.operation, key.idempotencyKey]);

/**
 * Lookup-only adapter. New keys and reservations always use their real request;
 * an old projection can return evidence, never permission to repeat an effect.
 * The owner authorizes exact object/key/parameter pairs from its frozen inventory.
 */
export function createRelocatedReceiptStore(
  store: W5ReceiptStore,
  transition: RelocationTransition,
  projections: readonly RelocatedReceipt[],
  authorize: (projection: RelocatedReceipt) => boolean,
): W5ReceiptStore {
  const allowed = new Map<string, RelocatedReceipt>();
  for (const projection of projections) {
    if (
      !projection.objectId ||
      !authorize(projection) ||
      projection.originalPath === projection.relocatedPath ||
      movedOwnedPath(transition, projection.originalPath) !==
        projection.relocatedPath ||
      !/^[a-f0-9]{64}$/.test(projection.originalFingerprint) ||
      !/^[a-f0-9]{64}$/.test(projection.relocatedFingerprint) ||
      allowed.has(identity(projection.key))
    )
      throw new RelocationRefusedError('unproven-receipt-projection');
    allowed.set(identity(projection.key), {
      ...projection,
      key: { ...projection.key },
    });
  }
  return {
    reserve: (input) => store.reserve(input),
    releaseReservation: (id) => store.releaseReservation(id),
    markReservationRecoveryRequired: (id, diagnostics) =>
      store.markReservationRecoveryRequired(id, diagnostics),
    async lookupReceipt(receipt): Promise<W5ReceiptLookup> {
      const exact = await store.lookupReceipt(receipt);
      if (exact.status !== 'key-reused' && exact.status !== 'none')
        return exact;
      const projection = allowed.get(identity(receipt));
      if (
        !projection ||
        receipt.fingerprint !== projection.relocatedFingerprint
      )
        return exact;
      const original = await store.lookupReceipt({
        ...receipt,
        fingerprint: projection.originalFingerprint,
      });
      // No old evidence means no admission, even after compaction or removal.
      if (original.status === 'none')
        throw new W5CommitRefusedError(
          'recovery-required',
          'This relocated request is missing its earlier attempt record and needs recovery.',
        );
      return original;
    },
  };
}

/** Repository-add owner: change exactly repoPath, leaving every other parameter significant. */
export function relocatedRepositoryAddReceipt(
  transition: RelocationTransition,
  objectId: string,
  key: W5ReceiptKey,
  request: WorkspaceRepositoryAddRequest,
  pathIdentity: 'legacy-path' | W5HostPathFlavor,
): RelocatedReceipt {
  if (
    key.operation !== 'core.workspace.repository.add' ||
    request.source === 'organization_sync_revert'
  )
    throw new RelocationRefusedError('unsupported-receipt-projection');
  const originalPath = request.repository.repoPath;
  const relocatedPath = movedOwnedPath(transition, originalPath);
  if (originalPath === relocatedPath)
    throw new RelocationRefusedError('not-a-moved-object');
  const parameters = { ...request };
  delete parameters.expectedRevision;
  delete parameters.idempotencyKey;
  const fingerprint = (path: string): string =>
    fingerprintW5Parameters({
      ...parameters,
      repository: {
        ...request.repository,
        repoPath:
          pathIdentity === 'legacy-path'
            ? path
            : projectW5HostPathFingerprint(path, pathIdentity),
      },
    });
  return {
    objectId,
    originalPath,
    relocatedPath,
    key: { ...key },
    originalFingerprint: fingerprint(originalPath),
    relocatedFingerprint: fingerprint(relocatedPath),
  };
}
