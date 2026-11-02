import {
  managedDelegationLifetimeLimitChoices,
  type ManagedDelegationMode,
} from '@canopy/protocol/delegation/discovery';

export const MANAGED_DELEGATION_PREFERENCE_UPDATED_EVENT =
  'canopy:managed-delegation-preference-updated';

export interface ManagedDelegationPreferenceUpdate {
  mode: ManagedDelegationMode;
  maxConcurrent?: number;
  maxDepth?: number;
  lifetimeLimit?: number;
  revocationIncomplete: boolean;
}

export function emitManagedDelegationPreferenceUpdated(
  update: ManagedDelegationPreferenceUpdate,
): void {
  window.dispatchEvent(
    new CustomEvent<ManagedDelegationPreferenceUpdate>(
      MANAGED_DELEGATION_PREFERENCE_UPDATED_EVENT,
      { detail: update },
    ),
  );
}

export function subscribeManagedDelegationPreferenceUpdated(
  listener: (update: ManagedDelegationPreferenceUpdate) => void,
): () => void {
  const handler = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    const detail: unknown = event.detail;
    if (
      typeof detail === 'object' &&
      detail !== null &&
      'mode' in detail &&
      (detail.mode === 'off' ||
        detail.mode === 'explicit-only' ||
        detail.mode === 'proactive') &&
      'revocationIncomplete' in detail &&
      typeof detail.revocationIncomplete === 'boolean'
    ) {
      listener({
        mode: detail.mode,
        ...('lifetimeLimit' in detail &&
        typeof detail.lifetimeLimit === 'number' &&
        managedDelegationLifetimeLimitChoices().includes(detail.lifetimeLimit)
          ? { lifetimeLimit: detail.lifetimeLimit }
          : {}),
        ...('maxConcurrent' in detail &&
        typeof detail.maxConcurrent === 'number' &&
        Number.isInteger(detail.maxConcurrent) &&
        detail.maxConcurrent >= 1 &&
        detail.maxConcurrent <= 16
          ? { maxConcurrent: detail.maxConcurrent }
          : {}),
        ...('maxDepth' in detail &&
        typeof detail.maxDepth === 'number' &&
        Number.isInteger(detail.maxDepth) &&
        detail.maxDepth >= 1 &&
        detail.maxDepth <= 10
          ? { maxDepth: detail.maxDepth }
          : {}),
        revocationIncomplete: detail.revocationIncomplete,
      });
    }
  };
  window.addEventListener(MANAGED_DELEGATION_PREFERENCE_UPDATED_EVENT, handler);
  return () =>
    window.removeEventListener(
      MANAGED_DELEGATION_PREFERENCE_UPDATED_EVENT,
      handler,
    );
}
