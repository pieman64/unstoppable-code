import { useEffect } from 'react';
import { subscribeTerminalActivityFeed } from '@canopy/app-state/terminal';
// The desktop shim installs host predicates; main.tsx owns its Claude index lifetime.
import '@/stores/terminalActivityStore';

/** Global activity feed; list seeds running baselines after listeners attach. */
export function useTerminalActivitySubscription(): void {
  useEffect(subscribeTerminalActivityFeed, []);
}
