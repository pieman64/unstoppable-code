import {
  formatPageUnavailableMessage,
  getPageAvailability,
} from '@/lib/navigation/page-availability';
import type { NavigationPage } from '@canopy/desktop-shared/types';
import { useLabsExperimentsStore } from '@/stores/labsExperimentsStore';

/**
 * Tells the user where a page went when navigation refuses it because its
 * Labs experiment is off (CAN-3678). Only `experiment` refusals toast:
 * feature-flag and dev-only refusals stay silent.
 *
 * Before main's first ready snapshot every experiment-owned page is refused,
 * whatever the user chose, so a refusal then says nothing about the choice
 * and must not toast. That covers a restored last page or a share landing
 * resolved during startup.
 *
 * Only an experiment Settings → Labs lists can be switched on there,
 * so a withdrawn (`hidden`) page or one gated on Early access while Early
 * access is off refuses silently.
 *
 * `openExperiments` is passed in so this module never imports the navigation
 * store, and the toast store is loaded lazily, so neither forms a cycle.
 */
export function notifyPageSwitchedOff(
  page: NavigationPage,
  openExperiments: () => void,
): void {
  const snapshot = useLabsExperimentsStore.getState().snapshot;
  if (snapshot?.ready !== true) return;
  const availability = getPageAvailability(page);
  if (availability.available || availability.reason !== 'experiment') return;
  const owner = snapshot.experiments.find((entry) =>
    entry.pages.includes(page),
  );
  if (owner?.listed !== true) return;
  const message = formatPageUnavailableMessage(availability);
  void import('@/stores/githubStore')
    .then(({ useGitHubStore }) => {
      const toasts = useGitHubStore.getState();
      // Repeated shortcut presses keep one toast instead of stacking.
      if (toasts.toasts.some((toast) => toast.message === message)) return;
      toasts.addToast(message, 'info', undefined, {
        forceInApp: true,
        suppressOsNotification: true,
        action: { label: 'Open Labs', onClick: openExperiments },
      });
    })
    // The toast is advisory; the navigation has already fallen back.
    .catch(() => undefined);
}
