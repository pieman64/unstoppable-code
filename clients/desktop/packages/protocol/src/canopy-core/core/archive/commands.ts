import { z } from 'zod';
import {
  CanopyRequestMetadataSchema,
  CanopyWorkspaceScopeSchema,
} from '../../common';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyJsonValueSchema,
  CanopyKeyedRetryDirectiveSchema,
} from '../../errors';

/*
 * The Zod of the cataloged `core.archive.container.restore` page (CAN-5524,
 * W7b-2a, #28). The desktop dispatcher composes it in process; like the
 * web-only registries it stays out of CORE_INSTRUCTION_DEFINITIONS, whose
 * daemon dispatcher requires a handler for every definition. The web core
 * does not serve it.
 */

const id = z.string().min(1).max(512);

export const CoreArchiveContainerRestoreParamsSchema = z.strictObject({
  archiveId: id,
  expectedRevision: z.number().int().nonnegative(),
  destinationScope: CanopyWorkspaceScopeSchema,
  conflictPolicy: z.enum(['fail', 'rename', 'merge']),
  _meta: CanopyRequestMetadataSchema.extend({ idempotencyKey: id }),
});
export type CoreArchiveContainerRestoreParams = z.output<
  typeof CoreArchiveContainerRestoreParamsSchema
>;

// The page's operation statuses, which predate OperationStatusSchema.
export const CoreArchiveContainerRestoreResultSchema = z
  .object({
    operation: z
      .object({
        operationId: id,
        kind: id,
        status: z.enum([
          'queued',
          'running',
          'awaiting_input',
          'completed',
          'failed',
          'cancelled',
          'interrupted',
        ]),
      })
      .catchall(CanopyJsonValueSchema),
    restoredScope: CanopyWorkspaceScopeSchema,
  })
  .catchall(CanopyJsonValueSchema);
export type CoreArchiveContainerRestoreResult = z.output<
  typeof CoreArchiveContainerRestoreResultSchema
>;

export const CoreArchiveContainerRestoreErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'core.archive.revisionConflict',
        'core.archive.destinationConflict',
        'core.archive.expired',
        'core.archive.incomplete',
        // The keyed W5 codes, additively (A7, q-14 D2(a)).
        'core.archive.idempotencyKeyReused',
        'core.archive.requestInProgress',
        'core.archive.recoveryRequired',
        'core.archive.outcomeExpired',
      ])
      .optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

export const CORE_ARCHIVE_COMMAND_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.archive.container.restore': defineCanopyInstruction({
      plane: 'core',
      domain: 'archive',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.archive.write'],
      params: CoreArchiveContainerRestoreParamsSchema,
      result: CoreArchiveContainerRestoreResultSchema,
      error: CoreArchiveContainerRestoreErrorSchema,
    }),
  });
