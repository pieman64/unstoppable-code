import { z } from 'zod';

export {
  LIFECYCLE_JOURNAL_DIRECTORY_UNREADABLE_REFUSAL,
  LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL,
  PORTAL_CAPABILITY_LIFECYCLE_JOURNAL_QUARANTINE,
  lifecycleJournalRefusalKind,
} from './lifecycle-journal-refusal';

/** The journal scanners' recognized names: a hashed slot or an operation id. */
export const LIFECYCLE_JOURNAL_ENTRY_NAME_PATTERN =
  /^([a-f0-9]{64}|[a-f0-9-]{36})\.json$/;

const entryNameSchema = z
  .string()
  .regex(LIFECYCLE_JOURNAL_ENTRY_NAME_PATTERN, 'Unrecognized journal entry');

/** A project or worktree named only when the hashed file name matches it. */
export const LifecycleJournalEntryMatchSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('project'),
      workspaceId: z.string().min(1),
      projectName: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('worktree'),
      workspaceId: z.string().min(1),
      worktreeId: z.string().min(1),
      projectName: z.string(),
      worktreeName: z.string(),
    })
    .strict(),
]);
export type LifecycleJournalEntryMatch = z.infer<
  typeof LifecycleJournalEntryMatchSchema
>;

export const LifecycleJournalUnreadableEntrySchema = z
  .object({
    name: entryNameSchema,
    kind: z.enum(['file', 'directory', 'other']),
    /** Opaque physical identity the move re-checks. */
    identity: z.string().min(1),
    /** False when the identity can't be proven unique; the move then refuses. */
    identityVerified: z.boolean(),
    match: LifecycleJournalEntryMatchSchema.optional(),
  })
  .strict();
export type LifecycleJournalUnreadableEntry = z.infer<
  typeof LifecycleJournalUnreadableEntrySchema
>;

/**
 * `*Label` fields are display text the trusted desktop host projects for the
 * confirmation. On the Portal they are path-free, relative to the desktop's
 * data folder (`<data>/w5/…`). They are never path input: no request accepts
 * them back, and a move names only the entry and identity.
 */
const locationLabelSchema = z.string().max(4096);

export const LifecycleJournalInspectionSchema = z.discriminatedUnion('status', [
  z
    .object({ status: z.literal('clear'), locationLabel: locationLabelSchema })
    .strict(),
  z
    .object({
      status: z.literal('directory-unreadable'),
      locationLabel: locationLabelSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('unreadable-entries'),
      locationLabel: locationLabelSchema,
      quarantineLocationLabel: locationLabelSchema,
      entries: z.array(LifecycleJournalUnreadableEntrySchema).min(1).max(100),
    })
    .strict(),
]);
export type LifecycleJournalInspection = z.infer<
  typeof LifecycleJournalInspectionSchema
>;

export const LifecycleJournalQuarantineRequestSchema = z
  .object({ name: entryNameSchema, identity: z.string().min(1).max(512) })
  .strict();
export type LifecycleJournalQuarantineRequest = z.infer<
  typeof LifecycleJournalQuarantineRequestSchema
>;

export const LifecycleJournalQuarantineResultSchema = z
  .object({
    status: z.literal('quarantined'),
    name: entryNameSchema,
    quarantinedName: z.string().min(1),
    quarantineLocationLabel: locationLabelSchema,
  })
  .strict();
export type LifecycleJournalQuarantineResult = z.infer<
  typeof LifecycleJournalQuarantineResultSchema
>;
