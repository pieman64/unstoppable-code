'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ViewerDataSharingStatus } from '@canopy/protocol';
import { useSettingsClient } from '../host';
import { fetchViewerDataSharing } from './team-api';

/**
 * Load state for the viewer's own data-sharing evidence in one organization
 * (CAN-3383). `idle` means the host has not asked for it (for example, a
 * profile that is not the viewer's own); `loading` and `error` both render no
 * hint, so neither can be mistaken for an absence of sharing.
 */
export type ViewerDataSharingLoadState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; status: ViewerDataSharingStatus };

type LoadIdentity = { orgId: string; viewerIdentity: string };
type SettledLoad =
  | { identity: LoadIdentity; state: 'error' }
  | { identity: LoadIdentity; state: 'ready'; status: ViewerDataSharingStatus };

/**
 * Fetch the viewer's data-sharing status once per organization mount. Pass
 * `null` to skip the request. There is no polling: the evidence covers a
 * 30-day window and a hint does not need to react within a page view.
 *
 * Settled results are tagged with the organization they answer, and the
 * returned state is derived from that tag during render. Switching
 * organizations therefore reads as `loading` immediately (no previous
 * organization's status survives the switch), and a response for an
 * organization the host has since left is discarded by the effect cleanup.
 */
export function useViewerDataSharing(
  orgId: string | null,
  viewerIdentity = '',
): ViewerDataSharingLoadState {
  const client = useSettingsClient();
  const [settled, setSettled] = useState<SettledLoad | null>(null);

  // A new identity object also distinguishes A → B → A, even if B's response
  // has not arrived. Previous evidence never reappears during a fresh load.
  const identity = useMemo(
    (): LoadIdentity | null =>
      orgId === null ? null : { orgId, viewerIdentity },
    [orgId, viewerIdentity],
  );
  useEffect(() => {
    if (identity === null) {
      return;
    }
    let current = true;
    const load = async (): Promise<void> => {
      try {
        const status = await fetchViewerDataSharing(client, identity.orgId);
        if (current) {
          setSettled({ identity, state: 'ready', status });
        }
      } catch {
        if (current) {
          setSettled({ identity, state: 'error' });
        }
      }
    };
    void load();
    return (): void => {
      current = false;
    };
  }, [client, identity]);

  if (orgId === null) {
    return { state: 'idle' };
  }
  if (settled === null || settled.identity !== identity) {
    return { state: 'loading' };
  }
  if (settled.state === 'error') {
    return { state: 'error' };
  }
  return { state: 'ready', status: settled.status };
}
