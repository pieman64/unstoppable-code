import { z } from 'zod';
import {
  APP_ERROR_CODES,
  getAppErrorDefinition,
  isAppErrorCode,
} from './catalog';
import {
  AppErrorCopySchema,
  AppErrorDetailSchema,
  AppErrorIdentifierSchema,
  AppErrorRecoverySchema,
  AppErrorTimestampSchema,
} from './primitives';

const fields = {
  code: z.enum(APP_ERROR_CODES),
  referenceId: z
    .string()
    .length(12)
    .regex(/^ERR-[0-9A-HJKMNP-TV-Z]{8}$/),
  copy: AppErrorCopySchema,
  occurredAt: AppErrorTimestampSchema,
  detail: AppErrorDetailSchema,
  source: AppErrorIdentifierSchema.optional(),
  recordedBy: AppErrorIdentifierSchema.optional(),
};

export const AppErrorSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...fields,
        kind: z.literal('defect'),
        recovery: z.never().optional(),
        retryAt: z.never().optional(),
      })
      .strict(),
    z
      .object({
        ...fields,
        kind: z.literal('input'),
        recovery: AppErrorRecoverySchema,
        retryAt: z.never().optional(),
      })
      .strict(),
    z
      .object({
        ...fields,
        kind: z.literal('external'),
        recovery: AppErrorRecoverySchema,
        retryAt: AppErrorTimestampSchema.optional(),
      })
      .strict(),
  ])
  .superRefine((error, ctx) => {
    if (!isAppErrorCode(error.code)) return;
    const definition = getAppErrorDefinition(error.code);
    if (
      error.kind !== definition.kind ||
      error.recovery !== definition.recovery
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Code, kind and recovery must match the catalog',
      });
    }
    if (
      error.retryAt !== undefined &&
      (error.kind !== 'external' || error.recovery !== 'wait')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['retryAt'],
        message: 'Only external wait errors have retryAt',
      });
    }
  });

export type AppError = z.infer<typeof AppErrorSchema>;
