import { useMemo } from 'react';
import type { CodexSpeedRouteContext } from '@canopy/desktop-shared/types/codex-speed-capabilities';
import { useCodexSpeedRoute } from './useCodexSpeedRoute';
import {
  codexSpeedBlockedReason,
  codexSpeedDowngrade,
  useCodexSpeedControl,
  type CodexSpeedControl,
  type CodexSpeedRouteRequest,
} from './useCodexSpeedControl';

/** Combine the trusted host hint with the selector's local model and lane. */
export function useContextualCodexSpeedControl({
  enabled,
  context,
  route,
  revalidationKey,
}: {
  enabled: boolean;
  context: CodexSpeedRouteContext | null;
  route: Omit<CodexSpeedRouteRequest, 'routeProfile'>;
  revalidationKey?: string;
}): CodexSpeedControl {
  const host = useCodexSpeedRoute({
    enabled,
    request: context
      ? {
          context,
          model: route.model ?? null,
          modelSelection: route.auto ? 'auto' : 'explicit',
        }
      : null,
    revalidationKey,
  });
  const control = useCodexSpeedControl({
    enabled,
    route: { ...route, routeProfile: host.route?.routeProfile },
  });
  const loading = enabled && host.status === 'loading';
  const status = loading ? 'loading' : control.status;
  const states = useMemo(
    () =>
      loading
        ? {
            ...control.states,
            ultrafast: {
              selectable: false,
              shortReason: 'Checking availability',
              reason: 'Checking whether Ultra fast can run for this model.',
            },
          }
        : control.states,
    [loading, control.states],
  );
  return useMemo(
    () => ({
      states,
      status,
      refreshing: loading || control.refreshing || host.refreshing,
      // A ready negative catalog can change when access is granted. Keep the
      // full picker's explicit refresh available without a relaunch or TTL wait.
      canRefresh: enabled,
      refresh: (): void => {
        control.refresh();
        void host.refresh();
      },
      blockedReason: (speed) => codexSpeedBlockedReason(speed, states, status),
      downgrade: (speed) => codexSpeedDowngrade(speed, states, status),
    }),
    [states, status, control, host, enabled, loading],
  );
}
