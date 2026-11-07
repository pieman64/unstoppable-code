import { z } from 'zod';
import {
  CanopyQueryRequestMetadataSchema,
  CanopyRequestMetadataSchema,
} from '../../common';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyKeyedRetryDirectiveSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';
import { defineCanopyQuery, defineCanopyQueryRegistry } from '../shared';

/*
 * Portable chat transfer (CAN-4113): the desktop's version 1 session export
 * and import, account-private cloud exports. The desktop dispatcher serves
 * these in process. Like CORE_ARCHIVE_COMMAND_INSTRUCTION_DEFINITIONS, the
 * instructions stay out of CORE_INSTRUCTION_DEFINITIONS, whose daemon
 * dispatcher requires a handler for every definition. No params or result
 * carries a local filesystem path.
 */

const id = z.string().min(1).max(512);
const cursor = z.string().min(1).max(4096);
const name = z.string().max(1024);
const longText = z.string().max(4096);
const warning = z.string().max(2048);
const timestamp = z.string().max(64);
const count = z.number().int().nonnegative();
const workspaceType = z.enum(['single-repo', 'multi-repo', 'cowork']);
const keyedMetadata = CanopyRequestMetadataSchema.extend({
  idempotencyKey: id,
});

export const CoreChatTransferRepoSchema = z.strictObject({
  name,
  branchName: name,
  remoteUrl: longText.optional(),
});

export const CoreChatTransferSummarySchema = z.strictObject({
  transferId: id,
  title: longText,
  workspaceName: name,
  /** The cloud record's workspace type, as stored. */
  workspaceType: z.string().max(64),
  repos: z.array(CoreChatTransferRepoSchema).max(1000),
  sizeBytes: count,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type CoreChatTransferSummary = z.output<
  typeof CoreChatTransferSummarySchema
>;

export const CoreChatTransferListParamsSchema = z.strictObject({
  query: z.string().max(1024).optional(),
  cursor: cursor.nullable().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});
export const CoreChatTransferListResultSchema = z.strictObject({
  transfers: z.array(CoreChatTransferSummarySchema).max(200),
  nextCursor: cursor.nullable(),
});

export const CoreChatTransferExportParamsSchema = z.strictObject({
  projectId: id,
  worktreeId: id,
  chatId: id,
  _meta: keyedMetadata,
});
export const CoreChatTransferExportResultSchema = z.strictObject({
  transferId: id,
  title: longText,
  sizeBytes: count,
  warnings: z.array(warning).max(1000),
});

export const CoreChatTransferDeleteParamsSchema = z.strictObject({
  transferId: id,
  _meta: keyedMetadata,
});
export const CoreChatTransferDeleteResultSchema = z.strictObject({
  deleted: z.literal(true),
});

const importRepo = z.strictObject({
  name,
  remoteUrl: longText.optional(),
  branchName: name.optional(),
});

export const CoreChatTransferImportInspectParamsSchema = z.strictObject({
  transferId: id,
  workspaceId: id,
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});
export const CoreChatTransferImportInspectResultSchema = z.strictObject({
  transferId: id,
  manifestSummary: z.strictObject({
    title: longText,
    provider: z.string().max(64).optional(),
    exportedAt: timestamp,
    workspaceType,
    repoCount: count,
    repos: z.array(importRepo).max(1000),
  }),
  workspaceSummary: z.strictObject({
    workspaceId: id,
    workspaceName: name,
    workspaceType,
    repoCount: count,
    repos: z.array(importRepo).max(1000),
  }),
  match: z.enum(['exact', 'superset', 'mismatch']),
  workspaceTypeCompatible: z.boolean(),
  missingRepos: z
    .array(z.strictObject({ name, remoteUrl: longText.optional() }))
    .max(1000),
  warnings: z.array(warning).max(1000),
  capabilityReadiness: z
    .array(
      z.strictObject({
        kind: z.enum(['plugin', 'mcp']),
        name,
        status: z.enum(['available', 'missing']),
        installable: z.boolean(),
        setupHint: longText.optional(),
      }),
    )
    .max(1000)
    .optional(),
});

export const CoreChatTransferImportParamsSchema = z.strictObject({
  transferId: id,
  workspaceId: id,
  installMissing: z.boolean().optional(),
  _meta: keyedMetadata,
});
export const CoreChatTransferImportResultSchema = z.strictObject({
  projectId: id,
  worktreeId: id,
  chatId: id,
  warnings: z.array(warning).max(1000),
  /** Whether temporary import data remains for cleanup or patch recovery. */
  stagingRetained: z.boolean(),
});

export const CoreChatTransferImportDiscardParamsSchema = z.strictObject({
  transferId: id,
  _meta: keyedMetadata,
});
export const CoreChatTransferImportDiscardResultSchema = z.strictObject({
  discarded: z.literal(true),
});

export const CoreChatTransferErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      'core.chat.transfer.failed',
      'core.chat.transfer.idempotencyKeyReused',
    ])
    .optional(),
  retry: CanopyKeyedRetryDirectiveSchema,
});
export const CoreChatTransferReadErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(['core.chat.transfer.failed']).optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

export const CORE_CHAT_TRANSFER_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.chat.transfer.export': defineCanopyInstruction({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.chat.write'],
      params: CoreChatTransferExportParamsSchema,
      result: CoreChatTransferExportResultSchema,
      error: CoreChatTransferErrorSchema,
    }),
    'core.chat.transfer.delete': defineCanopyInstruction({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.chat.write'],
      params: CoreChatTransferDeleteParamsSchema,
      result: CoreChatTransferDeleteResultSchema,
      error: CoreChatTransferErrorSchema,
    }),
    'core.chat.transfer.import.inspect': defineCanopyInstruction({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.chat.write'],
      params: CoreChatTransferImportInspectParamsSchema,
      result: CoreChatTransferImportInspectResultSchema,
      error: CoreChatTransferReadErrorSchema,
    }),
    'core.chat.transfer.import': defineCanopyInstruction({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.chat.write'],
      params: CoreChatTransferImportParamsSchema,
      result: CoreChatTransferImportResultSchema,
      error: CoreChatTransferErrorSchema,
    }),
    'core.chat.transfer.import.discard': defineCanopyInstruction({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.chat.write'],
      params: CoreChatTransferImportDiscardParamsSchema,
      result: CoreChatTransferImportDiscardResultSchema,
      error: CoreChatTransferErrorSchema,
    }),
  });

export const CORE_CHAT_TRANSFER_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'core',
  {
    'core.chat.transfer.list': defineCanopyQuery({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.chat.read'],
      params: CoreChatTransferListParamsSchema,
      result: CoreChatTransferListResultSchema,
      error: CoreChatTransferReadErrorSchema,
    }),
  },
);
