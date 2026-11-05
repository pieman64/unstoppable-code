import { z } from 'zod';

export const AppErrorKindSchema = z.enum(['input', 'external', 'defect']);
export const AppErrorRecoverySchema = z.enum([
  'try_again',
  'start_over',
  'fix_first',
  'wait',
]);
export const AppErrorSurfaceSchema = z.enum([
  'inline',
  'toast',
  'banner',
  'panel',
  'window',
]);
export const AppErrorTimestampSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const AppErrorIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)
  .refine((value) => value === value.trim());
export const AppErrorCopySchema = z
  .object({
    title: z.string().min(1).max(256),
    description: z.string().min(1).max(1024).optional(),
  })
  .strict();
export const AppErrorDetailSchema = z
  .object({
    name: z.string().max(128).optional(),
    message: z.string().max(4096),
    stack: z.string().max(32768).optional(),
    status: z
      .union([z.string().min(1).max(128), z.number().finite()])
      .optional(),
    operationCode: AppErrorIdentifierSchema.optional(),
  })
  .strict();
export type AppErrorKind = z.infer<typeof AppErrorKindSchema>;
export type AppErrorRecovery = z.infer<typeof AppErrorRecoverySchema>;
export type AppErrorSurface = z.infer<typeof AppErrorSurfaceSchema>;
export type AppErrorCopy = z.infer<typeof AppErrorCopySchema>;
export type AppErrorDetail = z.infer<typeof AppErrorDetailSchema>;
