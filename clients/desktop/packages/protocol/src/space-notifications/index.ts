import { z } from 'zod';

export const spaceNotificationLevelSchema = z.enum([
  'all',
  'attention',
  'mute',
]);
export type SpaceNotificationLevel = z.infer<
  typeof spaceNotificationLevelSchema
>;
export const spaceNotificationClassSchema = z.enum([
  'attention',
  'failure',
  'routine',
]);
export type SpaceNotificationClass = z.infer<
  typeof spaceNotificationClassSchema
>;

export const setSpaceNotificationPreferenceSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative().max(2_147_483_646),
    override: spaceNotificationLevelSchema.nullable(),
  })
  .strict();
export type SetSpaceNotificationPreference = z.infer<
  typeof setSpaceNotificationPreferenceSchema
>;

/** A producer namespace is stable across credentials, retries and owner replicas.
 * Capability is only a declaration; it never proves activation readiness. */
export const notificationSpaceProvenanceSchema = z
  .object({
    version: z.literal(1),
    producerId: z.string().min(1).max(128),
    workspaceId: z.string().min(1).max(128),
    spaceId: z.string().min(1).max(128),
    enforcementVersion: z.literal(1),
  })
  .strict();
export type NotificationSpaceProvenance = z.infer<
  typeof notificationSpaceProvenanceSchema
>;

/** A producer's own local spaces: a code worktree or a Cowork Work Entry,
 * keyed by its unscoped workspace id and space id. */
export const spaceNotificationSourceSchema = z
  .object({
    workspaceId: notificationSpaceProvenanceSchema.shape.workspaceId,
    spaceId: notificationSpaceProvenanceSchema.shape.spaceId,
  })
  .strict();
export type SpaceNotificationSource = z.infer<
  typeof spaceNotificationSourceSchema
>;
export const SPACE_NOTIFICATION_SYNC_MAX_SPACES = 500;
/** Transitions effective within this window accompany each synchronized
 * space, enough for a host to order recent and delayed occurrences. */
export const SPACE_NOTIFICATION_SYNC_WINDOW_MS = 24 * 60 * 60 * 1000;
export const syncProducerSpaceNotificationsSchema = z
  .object({
    spaces: z
      .array(spaceNotificationSourceSchema)
      .max(SPACE_NOTIFICATION_SYNC_MAX_SPACES),
  })
  .strict();
export type SyncProducerSpaceNotifications = z.infer<
  typeof syncProducerSpaceNotificationsSchema
>;

export interface SpaceNotificationTransition {
  revision: number;
  effectiveAt: string;
  priorOverride: SpaceNotificationLevel | null;
  nextOverride: SpaceNotificationLevel | null;
}
export interface SpaceNotificationSnapshot {
  spaceId: string;
  revision: number;
  override: SpaceNotificationLevel | null;
  effectiveLevel: SpaceNotificationLevel;
  writesEnabled: boolean;
  transitions: SpaceNotificationTransition[];
  nextRevision: number | null;
}
export interface SpaceNotificationSourcePolicy extends SpaceNotificationSource {
  /** Transitions are those effective since the response's `transitionsSince`. */
  policy: SpaceNotificationSnapshot;
}
export interface SpaceNotificationProducerSyncResult {
  /** Database time when the response was read, for host clock alignment. */
  serverTime: string;
  transitionsSince: string;
  writesEnabled: boolean;
  spaces: SpaceNotificationSourcePolicy[];
}
export type SpaceNotificationPolicyOutcome =
  | 'eligible'
  | 'suppressed'
  | 'cancelled';

export function allowsSpaceNotification(
  override: SpaceNotificationLevel | null,
  eventClass: SpaceNotificationClass,
): boolean {
  const level = override ?? 'all';
  return level === 'all' || (level === 'attention' && eventClass !== 'routine');
}

/** The override in force at `timestamp`. A full history starts from no
 * override. For a recent window (`current` supplied), the state before the
 * first retained transition is that transition's prior override, and with
 * none retained it is the current override. */
function overrideAt(
  timestamp: number,
  ordered: readonly SpaceNotificationTransition[],
  current: SpaceNotificationLevel | null | undefined,
): SpaceNotificationLevel | null {
  let state: SpaceNotificationLevel | null | undefined;
  for (const transition of ordered) {
    if (Date.parse(transition.effectiveAt) <= timestamp)
      state = transition.nextOverride;
  }
  if (state !== undefined) return state;
  if (current === undefined) return null;
  return ordered[0] ? ordered[0].priorOverride : current;
}

function evaluateAtTime(
  eventClass: SpaceNotificationClass,
  occurredAt: string,
  ordered: readonly SpaceNotificationTransition[],
  current: SpaceNotificationLevel | null | undefined,
): SpaceNotificationPolicyOutcome {
  const timestamp = Date.parse(occurredAt);
  if (!Number.isFinite(timestamp)) return 'suppressed';
  // Millisecond ties without revision evidence are ambiguous. Conservatively
  // require every equal-time policy to permit the class.
  const tiedRestriction = ordered.some(
    (t) =>
      Date.parse(t.effectiveAt) === timestamp &&
      !allowsSpaceNotification(t.nextOverride, eventClass),
  );
  if (
    tiedRestriction ||
    !allowsSpaceNotification(
      overrideAt(timestamp, ordered, current),
      eventClass,
    )
  )
    return 'suppressed';
  return ordered.some(
    (t) =>
      Date.parse(t.effectiveAt) > timestamp &&
      !allowsSpaceNotification(t.nextOverride, eventClass),
  )
    ? 'cancelled'
    : 'eligible';
}

/**
 * An occurrence is eligible only if every policy from its occurrence through
 * now allows its class: disallowed at occurrence is `suppressed`, a later
 * restriction is `cancelled`, and loosening or reset never revives either.
 *
 * Server-issued revision evidence orders an occurrence exactly. Otherwise
 * the persisted occurrence time is compared with each transition's database
 * effective time. `current` seeds the state when `transitions` is a recent
 * window that holds nothing at or before the occurrence; omit it for a full
 * history, which always starts with no override.
 */
export function evaluateSpaceNotification(
  eventClass: SpaceNotificationClass,
  occurrence: { occurredAt: string; revision?: number },
  transitions: readonly SpaceNotificationTransition[],
  current?: SpaceNotificationLevel | null,
): SpaceNotificationPolicyOutcome {
  const ordered = [...transitions].sort((a, b) => a.revision - b.revision);
  if (occurrence.revision === undefined) {
    return evaluateAtTime(eventClass, occurrence.occurredAt, ordered, current);
  }
  // Seed exactly as the time branch does: a full history starts from no
  // override; a recent window starts from its first prior override, or the
  // current one when nothing was retained.
  let atOccurrence: SpaceNotificationLevel | null =
    current === undefined
      ? null
      : ordered[0]
        ? ordered[0].priorOverride
        : current;
  for (const transition of ordered) {
    if (transition.revision <= occurrence.revision)
      atOccurrence = transition.nextOverride;
  }
  if (!allowsSpaceNotification(atOccurrence, eventClass)) return 'suppressed';
  return ordered.some(
    (t) =>
      t.revision > (occurrence.revision ?? 0) &&
      !allowsSpaceNotification(t.nextOverride, eventClass),
  )
    ? 'cancelled'
    : 'eligible';
}
