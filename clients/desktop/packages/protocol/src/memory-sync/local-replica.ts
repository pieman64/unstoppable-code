import { z } from 'zod';
import { MEMORY_SYNC_LIMITS } from './constants';
import { MemoryChangeCursorSchema } from './cursor';
import {
  MemoryAccountIdSchema,
  MemoryCommitIdSchema,
  MemoryDeviceIdSchema,
  MemoryDocumentPathSchema,
  MemoryNoteIdSchema,
  MemoryOrganizationIdSchema,
  MemoryProjectIdSchema,
  MemoryRevisionSchema,
  MemoryScopeIdSchema,
  MemorySha256Schema,
  MemoryTimestampSchema,
  MemoryUuidSchema,
} from './identifiers';
import { MemoryScopeKindSchema, type MemoryScopeRef } from './records';
import { MemoryCommitKindSchema, MemoryNoteOpSchema } from './requests';

/*
 * Files a desktop keeps beside a scope's Markdown. Writers keep fields they do
 * not know (loose objects), so an older build that rewrites one of these files
 * cannot drop what a newer build added.
 */

export const MEMORY_REPLICA_ROOT_DIRNAME = 'memory-replicas';
export const MEMORY_REPLICA_USER_DIRNAME = 'user';
export const MEMORY_REPLICA_PROJECTS_DIRNAME = 'projects';
export const MEMORY_REPLICA_ACCOUNT_FILENAME = 'account.json';
export const MEMORY_MANIFEST_FILENAME = 'manifest.json';
export const MEMORY_SYNC_STATE_FILENAME = 'sync-state.json';
export const MEMORY_SYNC_OUTBOX_FILENAME = 'sync-outbox.json';
export const MEMORY_SYNC_PRIVATE_DIRNAME = '.sync';
export const MEMORY_LOCK_DIRNAME = '.lock';
export const MEMORY_LOCK_OWNER_FILENAME = 'owner.json';

export function memoryReplicaPathSegments(
  accountId: string,
  scope: MemoryScopeRef,
): string[] {
  const root = [MEMORY_REPLICA_ROOT_DIRNAME, accountId];
  return scope.kind === 'user'
    ? [...root, MEMORY_REPLICA_USER_DIRNAME]
    : [...root, MEMORY_REPLICA_PROJECTS_DIRNAME, scope.projectId];
}

/** A scope whose `minWriterFormat` is above this is read-only to this build. */
export const MEMORY_LOCAL_FORMAT_VERSION = 2;

export const MemoryManifestV1FileSchema = z.looseObject({
  version: z.literal(1),
});

export const MemoryReplicaBindingSchema = z.looseObject({
  accountId: MemoryAccountIdSchema,
  scopeId: MemoryScopeIdSchema,
  kind: MemoryScopeKindSchema,
  projectId: MemoryProjectIdSchema.nullable(),
});

export const MemoryManifestFileSchema = z.looseObject({
  version: z.literal(2),
  /**
   * Minted when the manifest is created or backfilled. A build that predates
   * version 2 rewrites the manifest to version 1; the next backfill mints a
   * new incarnation, so a revision read before that can never match again.
   */
  incarnation: MemoryUuidSchema,
  revision: MemoryRevisionSchema,
  minWriterFormat: z.int().min(MEMORY_LOCAL_FORMAT_VERSION),
  createdAt: MemoryTimestampSchema,
  backfilledAt: MemoryTimestampSchema.nullable(),
  binding: MemoryReplicaBindingSchema.nullable(),
  migratedTo: z
    .array(
      z.looseObject({
        accountId: MemoryAccountIdSchema,
        scopeId: MemoryScopeIdSchema,
        at: MemoryTimestampSchema,
      }),
    )
    .max(50),
});
export type MemoryManifestFile = z.output<typeof MemoryManifestFileSchema>;

export const MemoryReplicaAccountFileSchema = z.looseObject({
  version: z.literal(1),
  accountId: MemoryAccountIdSchema,
  deviceId: MemoryDeviceIdSchema,
  createdAt: MemoryTimestampSchema,
  settingsRevision: z.int().min(0),
});

export const MemoryReplicaModeSchema = z.enum([
  'syncing',
  'paused',
  'device_only',
  'repair_needed',
  'deleted_in_cloud',
]);

export const MemorySyncStateFileSchema = z.looseObject({
  version: z.literal(1),
  binding: MemoryReplicaBindingSchema,
  deviceId: MemoryDeviceIdSchema,
  mode: MemoryReplicaModeSchema,
  cursor: MemoryChangeCursorSchema.nullable(),
  baseRevision: MemoryRevisionSchema,
  baseDocuments: z.record(
    MemoryDocumentPathSchema,
    z.looseObject({
      contentHash: MemorySha256Schema,
      changedInRevision: MemoryRevisionSchema.min(1),
    }),
  ),
  localOnlyNoteIds: z.array(MemoryNoteIdSchema),
  pendingCommit: z
    .looseObject({
      commitId: MemoryCommitIdSchema,
      kind: MemoryCommitKindSchema,
      baseRevision: MemoryRevisionSchema,
      startedAt: MemoryTimestampSchema,
    })
    .nullable(),
  conflicts: z.array(
    z.looseObject({
      path: MemoryDocumentPathSchema,
      detectedAt: MemoryTimestampSchema,
      theirsRevision: MemoryRevisionSchema,
      oursFile: z.string().min(1).max(256),
    }),
  ),
  firstEnable: z
    .looseObject({
      state: z.enum(['uploading', 'merging', 'reviewing', 'done']),
      startedAt: MemoryTimestampSchema,
      preMergeRevision: MemoryRevisionSchema.nullable(),
    })
    .nullable(),
  lastPulledAt: MemoryTimestampSchema.nullable(),
  lastPushedAt: MemoryTimestampSchema.nullable(),
  lastError: z
    .looseObject({
      code: z.string().min(1).max(64),
      at: MemoryTimestampSchema,
    })
    .nullable(),
});
export type MemorySyncStateFile = z.output<typeof MemorySyncStateFileSchema>;

export const MemorySyncOutboxFileSchema = z.looseObject({
  version: z.literal(1),
  binding: MemoryReplicaBindingSchema,
  ops: z
    .array(
      z.looseObject({
        queuedAt: MemoryTimestampSchema,
        attempts: z.int().min(0),
        op: MemoryNoteOpSchema,
      }),
    )
    .max(MEMORY_SYNC_LIMITS.pendingNotesPerScopeMax),
  usage: z.record(
    z.string().min(1).max(256),
    z.looseObject({
      uses: z.int().min(1),
      lastUsedAt: MemoryTimestampSchema,
    }),
  ),
});
export type MemorySyncOutboxFile = z.output<typeof MemorySyncOutboxFileSchema>;

/** A note without `device` was saved on this device before it registered. */
export const MemoryNoteFrontmatterIdentitySchema = z.looseObject({
  id: MemoryNoteIdSchema,
  device: MemoryDeviceIdSchema.optional(),
  deviceLabel: z
    .string()
    .min(1)
    .max(MEMORY_SYNC_LIMITS.deviceLabelMaxChars)
    .optional(),
  origin: z
    .looseObject({
      projectId: MemoryProjectIdSchema.optional(),
      organizationId: MemoryOrganizationIdSchema.optional(),
    })
    .optional(),
  supersedes: MemoryNoteIdSchema.optional(),
});
export type MemoryNoteFrontmatterIdentity = z.output<
  typeof MemoryNoteFrontmatterIdentitySchema
>;

export const MemoryLocalLockOwnerFileSchema = z.looseObject({
  version: z.literal(1),
  token: MemoryUuidSchema,
  pid: z.int().min(1),
  hostname: z.string().min(1).max(255),
  processKind: z.enum(['app', 'cli', 'daemon', 'test']),
  acquiredAt: MemoryTimestampSchema,
  heartbeatAt: MemoryTimestampSchema,
});
export type MemoryLocalLockOwnerFile = z.output<
  typeof MemoryLocalLockOwnerFileSchema
>;
