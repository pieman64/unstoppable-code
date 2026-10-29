import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DataSharingOptInFeature } from '@canopy/protocol/canopy-server';
import type {
  CanopyCloudAccountPublicState,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { DataSharingOptInError } from '@canopy/ui-shared/components/DataSharingOptInCta';
import {
  dataSharingOptInDisclosureKey,
  resolveDataSharingOptIn,
  type DataSharingOptInResolution,
  type OptInLoad,
} from './dataSharingOptIn';

export type DataSharingOptInPhase =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; error: DataSharingOptInError };

/** What a submission did, for callers that close or advance on success. */
export type DataSharingOptInSubmitOutcome =
  | 'saved'
  | 'changed'
  | 'failed'
  | 'ignored';

export interface UseDataSharingOptInOptions {
  feature: DataSharingOptInFeature;
  organizationId: string | null;
  /** See {@link resolveDataSharingOptIn}; deliberate links pass `false`. */
  passive: boolean;
  /** Invoked once per successful save. */
  onEnabled?: () => void;
}

export interface UseDataSharingOptInResult {
  resolution: DataSharingOptInResolution;
  phase: DataSharingOptInPhase;
  enable: () => Promise<DataSharingOptInSubmitOutcome>;
  dismiss: () => Promise<void>;
}

type Snapshot = {
  account: OptInLoad<CanopyCloudAccountPublicState>;
  preferences: OptInLoad<PreferencesData>;
};

const LOADING: Snapshot = {
  account: { status: 'loading' },
  preferences: { status: 'loading' },
};

async function loadSnapshot(): Promise<Snapshot> {
  // Deferred so a synchronous throw is a failed read, never an unhandled one.
  const [account, preferences] = await Promise.allSettled([
    Promise.resolve().then(() => window.api.loadCanopyCloudAccount()),
    Promise.resolve().then(() => window.api.loadPreferences()),
  ]);
  return {
    account:
      account.status === 'fulfilled'
        ? { status: 'ready', value: account.value }
        : { status: 'error' },
    preferences:
      preferences.status === 'fulfilled' &&
      preferences.value.__error === undefined
        ? { status: 'ready', value: preferences.value }
        : { status: 'error' },
  };
}

function accountIdentity(snapshot: Snapshot): string {
  return snapshot.account.status === 'ready'
    ? (snapshot.account.value.account?.id ?? '')
    : '';
}

/**
 * Loads the authoritative preferences and account policy for one opt-in,
 * keeps them fresh on preference and account events, and performs the
 * narrow main-owned write. Stale loads and submissions are ignored once the
 * request identity (feature, organization, or account) changes.
 */
export function useDataSharingOptIn({
  feature,
  organizationId,
  passive,
  onEnabled,
}: UseDataSharingOptInOptions): UseDataSharingOptInResult {
  const [snapshot, setSnapshot] = useState<Snapshot>(LOADING);
  const [phase, setPhase] = useState<DataSharingOptInPhase>({ kind: 'idle' });
  const loadGeneration = useRef(0);
  const savingRef = useRef(false);
  const submissionGeneration = useRef(0);
  const applicationRetryIdentity = useRef<string | null>(null);
  const onEnabledRef = useRef(onEnabled);
  onEnabledRef.current = onEnabled;

  const requestKey = `${feature}|${organizationId ?? ''}`;
  const identity = `${requestKey}|${accountIdentity(snapshot)}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;

  const reload = useCallback(async (): Promise<Snapshot | null> => {
    const generation = ++loadGeneration.current;
    const next = await loadSnapshot();
    if (generation !== loadGeneration.current) return null;
    setSnapshot(next);
    return next;
  }, []);

  // A new request identity starts from loading with no stale acknowledgment.
  useEffect(() => {
    setSnapshot(LOADING);
    setPhase({ kind: 'idle' });
    savingRef.current = false;
    applicationRetryIdentity.current = null;
    void reload();
    const unsubscribe = window.api.onPreferencesChanged(() => {
      void reload();
    });
    const onAccountChanged = (): void => {
      void reload();
    };
    window.addEventListener(
      CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
      onAccountChanged,
    );
    return (): void => {
      // Drop any in-flight load for the old identity.
      loadGeneration.current += 1;
      submissionGeneration.current += 1;
      applicationRetryIdentity.current = null;
      unsubscribe();
      window.removeEventListener(
        CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
        onAccountChanged,
      );
    };
  }, [requestKey, reload]);

  // An account switch under the same request also clears the transient state.
  const accountId = accountIdentity(snapshot);
  const lastAccountId = useRef(accountId);
  useEffect(() => {
    if (lastAccountId.current === accountId) return;
    lastAccountId.current = accountId;
    applicationRetryIdentity.current = null;
    submissionGeneration.current += 1;
    savingRef.current = false;
    setPhase({ kind: 'idle' });
  }, [accountId]);

  const reviewShared = applicationRetryIdentity.current === identity;
  const resolution = useMemo(
    () =>
      resolveDataSharingOptIn({
        feature,
        organizationId,
        passive,
        reviewShared,
        account: snapshot.account,
        preferences: snapshot.preferences,
      }),
    [feature, organizationId, passive, snapshot, reviewShared],
  );
  const resolutionRef = useRef(resolution);
  resolutionRef.current = resolution;

  const enable =
    useCallback(async (): Promise<DataSharingOptInSubmitOutcome> => {
      const shown = resolutionRef.current;
      if (savingRef.current || shown.kind !== 'needs-opt-in') return 'ignored';
      savingRef.current = true;
      const startedFor = identityRef.current;
      const generation = ++submissionGeneration.current;
      const retryingApplication =
        applicationRetryIdentity.current === startedFor;
      const isCurrent = (): boolean =>
        identityRef.current === startedFor &&
        submissionGeneration.current === generation;
      setPhase({ kind: 'saving' });
      const finish = (next: DataSharingOptInPhase): void => {
        if (!isCurrent()) return;
        savingRef.current = false;
        setPhase(next);
      };
      try {
        // Consent covers what was shown. If policy or the sharing effects moved
        // underneath it, show the new disclosure instead of saving.
        const fresh = await reload();
        if (!isCurrent()) return 'ignored';
        if (!fresh) {
          // An event or identity change superseded this read. Never save from
          // the old disclosure; the next click performs a fresh review.
          finish({ kind: 'idle' });
          return 'changed';
        }
        // Compare the returned account directly: React may not have rendered
        // the new identity by the time this continuation resumes.
        if (accountIdentity(fresh) !== accountIdentity(snapshot)) {
          applicationRetryIdentity.current = null;
          finish({ kind: 'idle' });
          return 'changed';
        }
        const current = resolveDataSharingOptIn({
          feature,
          organizationId,
          passive: false,
          reviewShared: retryingApplication,
          account: fresh.account,
          preferences: fresh.preferences,
        });
        if (
          dataSharingOptInDisclosureKey(current) !==
          dataSharingOptInDisclosureKey(shown)
        ) {
          applicationRetryIdentity.current = null;
          finish({ kind: 'idle' });
          return 'changed';
        }
        const result = await window.api.enableDataSharingForFeature({
          feature,
          organizationId: shown.organizationId,
        });
        if (!isCurrent()) return 'ignored';
        if (result.status !== 'refused') {
          if (result.status === 'saved-application-failed') {
            applicationRetryIdentity.current = startedFor;
            finish({ kind: 'error', error: 'application-failed' });
            void reload();
            return 'failed';
          }
          applicationRetryIdentity.current = null;
          finish({ kind: 'saved' });
          onEnabledRef.current?.();
          return 'saved';
        }
        if (result.reason === 'organization-prohibited') {
          // Policy changed: the reload resolves to the managed explanation.
          finish({ kind: 'idle' });
          void reload();
          return 'changed';
        }
        finish({
          kind: 'error',
          error:
            result.reason === 'save-failed' ||
            result.reason === 'invalid-request'
              ? 'save-failed'
              : 'unavailable',
        });
        return 'failed';
      } catch {
        finish({ kind: 'error', error: 'save-failed' });
        return 'failed';
      }
    }, [feature, organizationId, reload, snapshot]);

  const dismiss = useCallback(async (): Promise<void> => {
    try {
      const result = await window.api.dismissDataSharingOptInHint({ feature });
      if (result.status === 'saved') void reload();
    } catch {
      // A failed dismissal is not durable; the hint stays.
    }
  }, [feature, reload]);

  return { resolution, phase, enable, dismiss };
}
