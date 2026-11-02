import { z } from 'zod';

/** Additive Portal support. Clients hide watcher controls when absent. */
export const PORTAL_CAPABILITY_CHAT_WATCHERS = 'chat_watchers' as const;

const detailSchema = z.object({ label: z.string(), value: z.string() });

/** Display projection only. Target records and host execution state stay local. */
export const PortalWatcherEntitySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  worktreeId: z.string().min(1),
  chatId: z.string().min(1),
  trigger: z.string().min(1),
  targetKind: z.string().min(1),
  status: z.enum(['active', 'delivery_failed']),
  createdAt: z.string(),
  followUpInstruction: z.string().optional(),
  deliveryError: z.string().optional(),
  display: z.object({
    title: z.string(),
    subtitle: z.string(),
    watching: z.string(),
    watchingSubtitle: z.string(),
    status: z.string(),
    details: z.array(detailSchema),
    ownerDelegate: z
      .object({ name: z.string(), detail: z.string().optional() })
      .optional(),
    github: z
      .object({
        subtitle: z.string(),
        filters: z.array(detailSchema),
        samples: z.array(z.string()).max(5),
        totalCount: z.number().int().nonnegative(),
      })
      .optional(),
  }),
});

export type PortalWatcherEntity = z.infer<typeof PortalWatcherEntitySchema>;

export function parsePortalWatcher(value: unknown): PortalWatcherEntity | null {
  const parsed = PortalWatcherEntitySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const PortalWatcherDeletePayloadSchema = z
  .object({
    watcherId: z.string().min(1),
    notifySubscriber: z.boolean(),
  })
  .strict();
export type PortalWatcherDeletePayload = z.infer<
  typeof PortalWatcherDeletePayloadSchema
>;
