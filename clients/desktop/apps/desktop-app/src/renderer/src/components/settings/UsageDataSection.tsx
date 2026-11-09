import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  UsageDataKey,
  UsageDataPolicySnapshot,
  UsageDataPreferences,
} from '@canopy/desktop-shared/types';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { TextLinkButton, ToggleSwitch } from '@canopy/ui-shared/components';
import { brandText, getBrandHostedServicesUrl } from '@/lib/brand';
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSubRow,
} from './SettingsLayout';
import { SettingsLockedLabel } from './SettingsLockedLabel';
import { resolveUsageDataLocks } from './usageDataLocks';

interface UsageDataRowCopy {
  readonly label: string;
  readonly description: string;
}

// Row hints are fragments without a closing period, like the Activity
// sharing rows below them.
const USAGE_DATA_COPY: Record<UsageDataKey, UsageDataRowCopy> = {
  productAnalytics: {
    label: 'Usage analytics',
    description: 'Which features you use and how the app performs',
  },
  sessionReplay: {
    label: 'Session recordings',
    description:
      'Replays of how you move through the app, with your content hidden',
  },
  errorReports: {
    label: 'Error reports',
    description: 'Details of crashes and errors so they can be fixed',
  },
  activeUseSignal: {
    label: 'Active use count',
    description: 'A count of the messages you send, never their content',
  },
  featureFlagIdentity: {
    label: 'Personalized feature rollouts',
    description:
      'Use your account to decide which new features you get. When off, only your app version and organizations are used',
  },
  skillSafetyCheck: {
    label: 'Skill safety check',
    description:
      'Look up installed skills with a safety service to show their risk',
  },
};

/** The rows under Usage analytics' own row, in display order. */
const TOP_LEVEL_KEYS = [
  'productAnalytics',
  'errorReports',
  'activeUseSignal',
  'featureFlagIdentity',
  'skillSafetyCheck',
] as const satisfies readonly UsageDataKey[];

/**
 * Settings → Privacy → Usage data: one switch per outbound flow the product
 * works without. Follows the load → optimistic-set → save → rollback pattern.
 *
 * The stored preference always holds the member's own choice. Main resolves
 * the effective policy for the selected workspace context (an organization's
 * prohibitions, or the fail-closed state while the account can't be read) and
 * delivers it here; a prohibited row renders locked off with a badge naming
 * why, and never saves. Leaving the organization or switching to Personal
 * restores the member's choice, because nothing here rewrites it.
 */
export function UsageDataSection(): JSX.Element {
  const [preferences, setPreferences] = useState<UsageDataPreferences | null>(
    null,
  );
  const [snapshot, setSnapshot] = useState<UsageDataPolicySnapshot | null>(
    null,
  );
  const preferencesRef = useRef<UsageDataPreferences | null>(preferences);
  const hostedServicesUrl = getBrandHostedServicesUrl();

  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  // Each loader returns a cancel function so a superseded response can't
  // overwrite newer state out of order.
  const load = useCallback((): (() => void) => {
    let cancelled = false;
    void window.api
      .loadPreferences()
      .then((prefs) => {
        if (!cancelled) {
          setPreferences(prefs.usageData);
        }
      })
      .catch((error: unknown) => {
        // The rows stay disabled until preferences load.
        reportClientAppError(error);
      });
    void window.api.observability
      .getUsageDataPolicy()
      .then((next) => {
        if (!cancelled) {
          setSnapshot(next);
        }
      })
      .catch((error: unknown) => {
        // Keep the last policy shown; the rows stay disabled until one loads.
        reportClientAppError(error);
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancel = load();
    // Main broadcasts `preferencesChanged` when an org re-probe applies, and
    // the policy channel when the selected context or prohibitions change.
    const unsubscribePreferences = window.api.onPreferencesChanged(() => {
      cancel();
      cancel = load();
    });
    const unsubscribePolicy = window.api.observability.onUsageDataPolicyChanged(
      (next) => {
        setSnapshot(next);
      },
    );
    return (): void => {
      cancel();
      unsubscribePreferences();
      unsubscribePolicy();
    };
  }, [load]);

  const locks = useMemo(() => resolveUsageDataLocks(snapshot), [snapshot]);
  const ready = preferences !== null && snapshot !== null;

  const handleToggle = useCallback(
    (key: UsageDataKey, checked: boolean): void => {
      const previous = preferencesRef.current;
      if (!previous) {
        return;
      }
      const next: UsageDataPreferences = { ...previous, [key]: checked };
      // Updated now, not after render, so a quick second toggle builds on
      // this one instead of overwriting it.
      preferencesRef.current = next;
      setPreferences(next);
      void window.api
        .savePreferences({ usageData: next })
        .catch((error: unknown) => {
          // Roll back only this key, keeping any later toggle.
          const current = preferencesRef.current;
          if (!current) return;
          const rolledBack = { ...current, [key]: previous[key] };
          preferencesRef.current = rolledBack;
          setPreferences(rolledBack);
          reportClientAppError(error);
        });
    },
    [],
  );

  function lockFor(key: UsageDataKey): string | null {
    return key === 'skillSafetyCheck' ? null : locks[key];
  }

  function renderToggle(key: UsageDataKey, dependsOnOff = false): JSX.Element {
    const lock = lockFor(key);
    const copy = USAGE_DATA_COPY[key];
    return (
      <ToggleSwitch
        id={`settings-usage-data-${key}`}
        // A locked row shows the flow as off; a row under a parent that is
        // off keeps its stored value, dimmed, so turning the parent back on
        // restores it.
        checked={lock ? false : (preferences?.[key] ?? true)}
        label={copy.label}
        disabled={!ready || lock !== null || dependsOnOff}
        dataTestId={`usage-data-toggle-${key}`}
        onChange={(checked): void => handleToggle(key, checked)}
      />
    );
  }

  const analyticsOff =
    lockFor('productAnalytics') !== null ||
    preferences?.productAnalytics === false;

  return (
    <SettingsSection
      title="Usage data"
      description={`Choose what ${brandText.appName} sends to help improve the app.`}
      dataTestId="usage-data-section"
      footer={
        hostedServicesUrl ? (
          <TextLinkButton
            data-testid="usage-data-hosted-services-link"
            onClick={(): void => {
              void window.api.browser.openExternal({ url: hostedServicesUrl });
            }}
          >
            See everything that leaves your device
          </TextLinkButton>
        ) : undefined
      }
    >
      <SettingsGroup dataTestId="usage-data-controls">
        {TOP_LEVEL_KEYS.map((key) => {
          const copy = USAGE_DATA_COPY[key];
          const lock = lockFor(key);
          const sessionReplayLock = lockFor('sessionReplay');
          return (
            // The wrapper is the group's row: it carries the lock state the
            // row itself has no attribute for.
            <div
              key={key}
              data-testid={`usage-data-row-${key}`}
              data-locked={lock ? 'true' : undefined}
            >
              <SettingsRow
                label={
                  <SettingsLockedLabel
                    label={copy.label}
                    reason={lock}
                    dataTestId={`usage-data-lock-badge-${key}`}
                  />
                }
                description={copy.description}
                htmlFor={`settings-usage-data-${key}`}
                control={renderToggle(key)}
              >
                {key === 'productAnalytics' ? (
                  <div
                    data-testid="usage-data-row-sessionReplay"
                    data-locked={sessionReplayLock ? 'true' : undefined}
                  >
                    <SettingsSubRow
                      label={
                        <SettingsLockedLabel
                          label={USAGE_DATA_COPY.sessionReplay.label}
                          reason={sessionReplayLock}
                          dataTestId="usage-data-lock-badge-sessionReplay"
                        />
                      }
                      description={USAGE_DATA_COPY.sessionReplay.description}
                      htmlFor="settings-usage-data-sessionReplay"
                      control={renderToggle('sessionReplay', analyticsOff)}
                    />
                  </div>
                ) : null}
              </SettingsRow>
            </div>
          );
        })}
      </SettingsGroup>
    </SettingsSection>
  );
}
