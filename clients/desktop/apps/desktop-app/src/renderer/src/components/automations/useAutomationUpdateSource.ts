import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import type { SharedAutomationInstallSource } from '@canopy/protocol/automations';
import { toCuratedAutomationInstallSource } from '@canopy/protocol/automation-catalog';
import type { AutomationInstallSourceKind } from '@/lib/automationShareRelationship';
import { resolveSharedResourceErrorMessage } from '@/lib/sharedResourceErrors';

/** Sources a Marketplace install or update can read from. */
export type MarketplaceAutomationSourceKind = Exclude<
  AutomationInstallSourceKind,
  'public'
>;

/** The Marketplace source a local copy can be updated from, if it has one. */
export function automationUpdateSourceOf(
  activity: ScheduledActivity,
): { sourceKind: MarketplaceAutomationSourceKind; remoteId: string } | null {
  if (!activity.installedFrom) return null;
  const sourceKind = activity.installedFrom.sourceKind ?? 'shared';
  if (sourceKind === 'public') return null;
  return { sourceKind, remoteId: activity.installedFrom.remoteId };
}

export interface PendingAutomationUpdate {
  readonly activity: ScheduledActivity;
  readonly sourceKind: MarketplaceAutomationSourceKind;
  readonly detail: SharedAutomationInstallSource;
}

export interface AutomationUpdateSource {
  /**
   * Loads the source an installed copy came from, for the install wizard to
   * apply. Rejects when it cannot load; `error` then holds the message.
   */
  readonly openUpdate: (activity: ScheduledActivity) => Promise<void>;
  /** The loaded update, ready for `InstallSharedAutomationModal`. */
  readonly pending: PendingAutomationUpdate | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly clear: () => void;
}

/**
 * Loads the update for an installed automation copy, shared by the
 * Marketplace detail and the Customize Workflows row (CAN-4845). Only the
 * newest request may settle; unmounting abandons it.
 */
export function useAutomationUpdateSource(): AutomationUpdateSource {
  const [pending, setPending] = useState<PendingAutomationUpdate | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  useEffect(
    () => (): void => {
      requestRef.current += 1;
    },
    [],
  );

  const openUpdate = useCallback(
    async (activity: ScheduledActivity): Promise<void> => {
      const source = automationUpdateSourceOf(activity);
      if (source === null) return;
      const request = ++requestRef.current;
      setLoading(true);
      setError(null);
      try {
        const detail =
          source.sourceKind === 'curated'
            ? toCuratedAutomationInstallSource(
                await window.api.automations.getCurated(source.remoteId),
              )
            : await window.api.automations.getShared(source.remoteId);
        if (requestRef.current !== request) return;
        setPending({ activity, sourceKind: source.sourceKind, detail });
      } catch (cause: unknown) {
        if (requestRef.current !== request) return;
        const message = resolveSharedResourceErrorMessage(cause, {
          unsupportedResource: 'automations',
        });
        setError(message);
        throw new Error(message);
      } finally {
        if (requestRef.current === request) setLoading(false);
      }
    },
    [],
  );

  const clear = useCallback((): void => setPending(null), []);

  return { openUpdate, pending, loading, error, clear };
}
