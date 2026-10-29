import { z } from 'zod';

const TextSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value);
const PositiveIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
// u64 device and inode numbers exceed Number precision.
const DecimalSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/)
  // Same-length digit strings compare numerically.
  .refine((value) => value.length < 20 || value <= '18446744073709551615');

/**
 * Host-local discovery record under dataRoot/runtime for trusted local launchers;
 * excluded from portable renderer/remote DTOs. tokenRef never contains the secret.
 */
export const CanopyRuntimeDescriptorSchema = z.object({
  /** Format version; readers reject a missing or unknown version as invalid. */
  version: z.literal(1),
  pid: PositiveIntegerSchema,
  startIdentity: TextSchema,
  endpoint: z.object({ kind: z.enum(['socket', 'pipe']), path: TextSchema }),
  protocolRange: z
    .object({ min: PositiveIntegerSchema, max: PositiveIntegerSchema })
    .refine(({ min, max }) => min <= max),
  buildVersion: TextSchema,
  tokenRef: TextSchema,
  /** POSIX socket the owner bound; stale-path recovery fails closed without a match. */
  socketIdentity: z
    .object({ device: DecimalSchema, inode: DecimalSchema })
    .optional(),
});

export type CanopyRuntimeDescriptor = z.output<
  typeof CanopyRuntimeDescriptorSchema
>;
