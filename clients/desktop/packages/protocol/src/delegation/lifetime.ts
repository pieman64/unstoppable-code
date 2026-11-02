import { z } from 'zod';

/** Local managed allowance observation; no host paths or execution authority. */
export const managedDelegationLifetimeStatusSchema = z.discriminatedUnion(
  'kind',
  [
    z.object({
      kind: z.literal('available'),
      occupied: z.number().int().nonnegative(),
      retained: z.number().int().nonnegative(),
      limit: z.number().int().nonnegative(),
      cap: z.number().int().positive(),
      atLimit: z.boolean(),
      canExtend: z.boolean(),
      atCap: z.boolean(),
      refusedChatIds: z.array(z.string()),
    }),
    z.object({
      kind: z.literal('unavailable'),
      reason: z.enum(['unreadable', 'uncertain']),
    }),
    z.object({
      kind: z.literal('error'),
      reason: z.enum(['invalid_request', 'scope_unavailable', 'read_failed']),
    }),
    z.object({ kind: z.literal('unsupported') }),
  ],
);

export type ManagedDelegationLifetimeStatus = z.infer<
  typeof managedDelegationLifetimeStatusSchema
>;

export type ManagedDelegationExtendLifetimeLimitResult =
  | {
      readonly ok: true;
      readonly baseline: number;
      readonly effectiveLimit: number;
      readonly retained: number;
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'at_cap'
        | 'no_increase'
        | 'unavailable'
        | 'invalid_request'
        | 'unsupported';
    };

export interface ManagedDelegationLifetimeChangedEvent {
  readonly projectId: string;
  readonly worktreeId: string;
}
