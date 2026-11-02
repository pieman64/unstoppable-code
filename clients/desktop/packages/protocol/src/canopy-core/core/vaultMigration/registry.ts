import { z } from 'zod';
import {
  defineCanopyInstructionRegistry,
  defineCanopyInstruction,
} from '../../definitions';
import { CanopyErrorPayloadSchema } from '../../errors';

// VA-1 validates the exact versioned frame shape before any session effect.
const FrameSchema = z.record(
  z.string().max(64),
  z.union([z.string().max(1_398_102), z.number().finite()]),
);
export const CORE_MIGRATION_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.vaultMigration.exchange': defineCanopyInstruction({
      plane: 'core',
      domain: 'vaultMigration',
      version: 1,
      placement: 'core-only',
      idempotency: 'none',
      requiredGrants: ['core.vaultMigration.import'],
      params: z.strictObject({ frame: FrameSchema }),
      result: z.strictObject({ frames: z.array(FrameSchema).max(7) }),
      error: CanopyErrorPayloadSchema.extend({
        code: z.literal('core.vaultMigration.refused').optional(),
      }),
    }),
  });
