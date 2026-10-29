'use client';

import { useEffect, useRef, useState } from 'react';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import type { FeedItem } from '@canopy/protocol/feed';
import type {
  SettingsEvent,
  SettingsSubscriptionState,
} from '@canopy/protocol/settings';

/** How many recent event ids a subscription remembers for deduplication. */
const SEEN_EVENT_LIMIT = 500;

export type SettingsFeedSubscriptionError =
  | 'expired'
  | 'forbidden'
  | 'unsupported_server';

export interface SettingsFeedSubscriptionStatus {
  readonly state: SettingsSubscriptionState;
  /** Set when the stream stopped for good (session ended or access lost). */
  readonly error: SettingsFeedSubscriptionError | null;
}

export interface UseSettingsFeedSubscriptionParams {
  /** `null` disables the subscription (state `disabled`). */
  readonly client: AccountOrganizationSettingsClient | null;
  readonly orgId: string;
  readonly teamId?: string;
  /** When `false`, no connection is opened and the state is `disabled`. */
  readonly enabled?: boolean;
  readonly onItem: (item: FeedItem) => void;
  /** The stream reconnected; refetch the newest page. */
  readonly onReconnect?: () => void;
}

/**
 * The organization feed through `CanopyClient.settings.subscribe`, with the
 * same contract as the web feed hook: re-subscribes only when the org, team
 * or `enabled` change, and reads the latest callbacks through refs.
 *
 * Items are deduplicated by `sequence` and `eventId`, and a resubscribe
 * resumes after the last sequence this hook delivered.
 */
export function useSettingsFeedSubscription(
  params: UseSettingsFeedSubscriptionParams,
): SettingsFeedSubscriptionStatus {
  const { client, orgId, teamId, enabled = true, onItem, onReconnect } = params;
  const [status, setStatus] = useState<SettingsFeedSubscriptionStatus>({
    state: 'connecting',
    error: null,
  });
  const onItemRef = useRef(onItem);
  const onReconnectRef = useRef(onReconnect);
  useEffect(() => {
    onItemRef.current = onItem;
    onReconnectRef.current = onReconnect;
  }, [onItem, onReconnect]);
  const lastSequenceRef = useRef<{ key: string; sequence: number } | null>(
    null,
  );

  useEffect(() => {
    if (!enabled || client === null) {
      setStatus({ state: 'disabled', error: null });
      return;
    }
    const key = `${orgId}\u0000${teamId ?? ''}`;
    if (lastSequenceRef.current?.key !== key) lastSequenceRef.current = null;
    const seen = new Set<string>();
    const seenOrder: string[] = [];
    let active = true;
    setStatus({ state: 'connecting', error: null });

    const listener = (event: SettingsEvent): void => {
      if (!active || event.organizationId !== orgId) return;
      switch (event.type) {
        case 'feed.item': {
          const last = lastSequenceRef.current;
          if (last !== null && event.sequence <= last.sequence) return;
          if (seen.has(event.eventId)) return;
          seen.add(event.eventId);
          seenOrder.push(event.eventId);
          if (seenOrder.length > SEEN_EVENT_LIMIT) {
            const evicted = seenOrder.shift();
            if (evicted !== undefined) seen.delete(evicted);
          }
          lastSequenceRef.current = { key, sequence: event.sequence };
          onItemRef.current(event.item);
          return;
        }
        case 'reconnected':
          onReconnectRef.current?.();
          return;
        case 'state':
          setStatus({ state: event.state, error: event.error ?? null });
          if (event.state === 'disabled' && event.error !== undefined)
            active = false;
          return;
      }
    };

    const lastSequence = lastSequenceRef.current?.sequence;
    const unsubscribe = client.subscribe(
      {
        kind: 'organization-feed',
        organizationId: orgId,
        ...(teamId !== undefined ? { teamId } : {}),
        ...(lastSequence !== undefined ? { lastSequence } : {}),
      },
      listener,
    );
    return (): void => {
      active = false;
      unsubscribe();
    };
  }, [client, orgId, teamId, enabled]);

  return status;
}
