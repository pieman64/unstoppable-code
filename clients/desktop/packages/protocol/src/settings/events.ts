import { z } from 'zod';
import type { FeedItem } from '../feed';
import { settingsRouteIdSchema } from './routes';

/** Backend path of the organization feed SSE gateway. */
export function settingsOrganizationFeedStreamPath(
  organizationId: string,
  teamId?: string,
): string {
  const path = `/api/account/organizations/${encodeURIComponent(organizationId)}/stream`;
  return teamId === undefined
    ? path
    : `${path}?teamId=${encodeURIComponent(teamId)}`;
}

/**
 * Backend path of a wallet's `credit.pool` signals: the personal credit
 * stream, or the organization stream (the gateway the feed also uses).
 */
export function settingsCreditPoolStreamPath(organizationId?: string): string {
  return organizationId === undefined
    ? '/api/account/billing/credits/stream'
    : settingsOrganizationFeedStreamPath(organizationId);
}

/** An organization's feed. */
export const settingsOrganizationFeedScopeSchema = z.strictObject({
  kind: z.literal('organization-feed'),
  organizationId: settingsRouteIdSchema,
  teamId: settingsRouteIdSchema.optional(),
  /** Last sequence the subscriber saw, sent as `Last-Event-ID` on resume. */
  lastSequence: z.number().int().nonnegative().optional(),
});

/** A wallet's credit-pool signals; omit `organizationId` for the personal wallet. */
export const settingsCreditPoolScopeSchema = z.strictObject({
  kind: z.literal('credit-pool'),
  organizationId: settingsRouteIdSchema.optional(),
});

/** What a settings subscription listens to. */
export const settingsSubscriptionScopeSchema = z.discriminatedUnion('kind', [
  settingsOrganizationFeedScopeSchema,
  settingsCreditPoolScopeSchema,
]);

export type SettingsOrganizationFeedScope = z.infer<
  typeof settingsOrganizationFeedScopeSchema
>;
export type SettingsCreditPoolScope = z.infer<
  typeof settingsCreditPoolScopeSchema
>;
export type SettingsSubscriptionScope = z.infer<
  typeof settingsSubscriptionScopeSchema
>;

export const SETTINGS_SUBSCRIPTION_STATES = [
  'connecting',
  'open',
  'reconnecting',
  'disabled',
] as const;

export type SettingsSubscriptionState =
  (typeof SETTINGS_SUBSCRIPTION_STATES)[number];

/**
 * Lenient frame check for a `feed.item` envelope, mirroring the web feed
 * controller: the envelope frame and the item's discriminating base fields
 * are validated; the per-type payload is trusted from the server.
 */
export const settingsFeedEnvelopeSchema = z.looseObject({
  type: z.literal('feed.item'),
  eventId: z.string().min(1),
  occurredAt: z.string(),
  sequence: z.number(),
  payload: z.looseObject({ id: z.string(), type: z.string() }),
});

/**
 * Lenient frame check for a `credit.pool` envelope, mirroring the web
 * credit-pool controller. Only the frame is used: a signal is a reason to
 * read the wallet again, never a balance.
 */
export const settingsCreditPoolEnvelopeSchema = z.looseObject({
  type: z.literal('credit.pool'),
  eventId: z.string().min(1),
  occurredAt: z.string(),
  sequence: z.number(),
  payload: z.looseObject({ balanceCredits: z.number() }),
});

/**
 * Events a settings subscription delivers. Feed items are deduplicated by
 * `sequence` and `eventId`; `credit.pool` asks a credit-pool subscriber to
 * read the wallet again; `reconnected` asks the subscriber to refetch;
 * `state` reports the connection lifecycle, and `disabled` with an error is
 * terminal (the session expired or access was lost). `organizationId` is
 * omitted only on a personal credit-pool subscription's events.
 */
export type SettingsEvent =
  | {
      type: 'feed.item';
      organizationId: string;
      sequence: number;
      eventId: string;
      item: FeedItem;
    }
  | { type: 'credit.pool'; organizationId?: string }
  | { type: 'reconnected'; organizationId?: string }
  | {
      type: 'state';
      organizationId?: string;
      state: SettingsSubscriptionState;
      error?: 'expired' | 'forbidden' | 'unsupported_server';
    };
