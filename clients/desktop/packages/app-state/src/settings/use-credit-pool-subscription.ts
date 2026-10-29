'use client';

import { useEffect, useRef, useState } from 'react';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import type {
  SettingsEvent,
  SettingsSubscriptionState,
} from '@canopy/protocol/settings';

export interface UseSettingsCreditPoolSubscriptionParams {
  /** `null` disables the subscription (state `disabled`). */
  readonly client: AccountOrganizationSettingsClient | null;
  /** Omit for the personal wallet. */
  readonly organizationId?: string;
  /** When `false`, no connection is opened and the state is `disabled`. */
  readonly enabled?: boolean;
  /** The wallet changed; read it again. Never carries a balance. */
  readonly onSignal: () => void;
  /** The stream reconnected; read the wallet again to fill the gap. */
  readonly onReconnect?: () => void;
}

/**
 * A wallet's `credit.pool` signals through `CanopyClient.settings.subscribe`,
 * with the contract of the web credit-pool hook: re-subscribes only when the
 * wallet or `enabled` change, and reads the latest callbacks through refs.
 * A signal is a reason to read the authoritative wallet, never its balance.
 */
export function useSettingsCreditPoolSubscription(
  params: UseSettingsCreditPoolSubscriptionParams,
): SettingsSubscriptionState {
  const {
    client,
    organizationId,
    enabled = true,
    onSignal,
    onReconnect,
  } = params;
  const [state, setState] = useState<SettingsSubscriptionState>('connecting');
  const onSignalRef = useRef(onSignal);
  const onReconnectRef = useRef(onReconnect);
  useEffect(() => {
    onSignalRef.current = onSignal;
    onReconnectRef.current = onReconnect;
  }, [onSignal, onReconnect]);

  useEffect(() => {
    if (!enabled || client === null) {
      setState('disabled');
      return;
    }
    let active = true;
    setState('connecting');
    const listener = (event: SettingsEvent): void => {
      if (!active || event.organizationId !== organizationId) return;
      switch (event.type) {
        case 'credit.pool':
          onSignalRef.current();
          return;
        case 'reconnected':
          onReconnectRef.current?.();
          return;
        case 'state':
          setState(event.state);
          if (event.state === 'disabled' && event.error !== undefined)
            active = false;
          return;
        case 'feed.item':
          return;
      }
    };
    const unsubscribe = client.subscribe(
      {
        kind: 'credit-pool',
        ...(organizationId === undefined ? {} : { organizationId }),
      },
      listener,
    );
    return (): void => {
      active = false;
      unsubscribe();
    };
  }, [client, organizationId, enabled]);

  return state;
}
