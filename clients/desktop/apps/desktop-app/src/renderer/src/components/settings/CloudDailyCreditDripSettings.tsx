import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { CloudDailyCreditDripState } from '@canopy/desktop-shared/types';
import { Notice, ToggleSwitch } from '@canopy/ui-shared/components';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  onDailyCreditDripChanged,
  saveDailyCreditDripChoice,
} from '@/lib/daily-credit-drip';

const SAVE_ERROR = "Couldn't save. Try again.";

export interface CloudDailyCreditDripSettingsProps {
  /** Card surface class from the host tab, applied only when rendered. */
  className?: string;
}

/**
 * Daily free AI Credits opt-in for the connected cloud account (guest or
 * signed in). With hosted settings, the in-app Billing page carries the same
 * toggle as the web Billing tab; this section is the fallback when hosted
 * settings are off.
 *
 * Like the work digests, this is a cloud-account setting: every read and
 * write goes to the server through main and nothing is mirrored locally. The
 * section renders only when the server confirms the surface exists for this
 * credential (`available && resolved`); an older server, no credential, or a
 * transient read failure hides it rather than showing a toggle on made-up
 * data. The switch flips optimistically and rolls back, with an inline
 * notice, only when the save itself fails.
 */
export function CloudDailyCreditDripSettings({
  className = '',
}: CloudDailyCreditDripSettingsProps): JSX.Element | null {
  const [state, setState] = useState<CloudDailyCreditDripState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const readVersion = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback((): void => {
    const version = ++readVersion.current;
    void (async (): Promise<void> => {
      let next: CloudDailyCreditDripState | null;
      try {
        next = await window.api.loadCloudDailyCreditDrip();
      } catch {
        // Fail-soft by contract; only a missing IPC bridge lands here. Hide.
        next = null;
      }
      if (mounted.current && version === readVersion.current) setState(next);
    })();
  }, []);

  useEffect(() => {
    reload();
    // A sign-in, sign-out, or guest credential mid-session changes whose
    // preference this is.
    const onAccountChanged = (): void => {
      setError(null);
      reload();
    };
    window.addEventListener(
      CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
      onAccountChanged,
    );
    // A save from the Home card, model recovery, or App Advisor.
    const unsubscribe = onDailyCreditDripChanged((result) => {
      readVersion.current += 1;
      setState({
        available: true,
        resolved: true,
        preference: {
          enabled: result.enabled,
          decidedAt: result.decidedAt,
          capCredits: result.capCredits,
        },
      });
    });
    return (): void => {
      window.removeEventListener(
        CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
        onAccountChanged,
      );
      unsubscribe();
    };
  }, [reload]);

  const shown = state !== null && state.available && state.resolved;

  useCurrentUiStateReporter('settings.dailyCreditDrip', {
    loaded: state !== null,
    available: shown,
    enabled: shown ? state.preference.enabled : false,
    decided: shown ? state.preference.decidedAt !== null : false,
  });

  const handleChange = useCallback(
    (enabled: boolean): void => {
      if (!state || !shown || saving) return;
      const previous = state;
      readVersion.current += 1;
      setState({
        ...previous,
        preference: { ...previous.preference, enabled },
      });
      setSaving(true);
      setError(null);
      void saveDailyCreditDripChoice(enabled)
        .then(() => {
          // The changed event already adopted the saved preference.
        })
        .catch(() => {
          if (!mounted.current) return;
          setState(previous);
          setError(SAVE_ERROR);
        })
        .finally(() => {
          if (mounted.current) setSaving(false);
        });
    },
    [saving, shown, state],
  );

  if (!shown) return null;

  const { enabled, capCredits } = state.preference;

  return (
    <section
      className={`space-y-3 ${className}`}
      data-testid="settings-daily-credit-drip"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h2 className="text-s font-medium fg-primary">
            Daily free AI Credits
          </h2>
          <p className="text-xs fg-secondary">
            Get {capCredits} free AI Credits every day.
          </p>
        </div>
        <ToggleSwitch
          checked={enabled}
          disabled={saving}
          label="Daily free AI Credits"
          onChange={handleChange}
          dataTestId="settings-daily-credit-drip-toggle"
        />
      </div>
      {error ? (
        <Notice
          intent="destructive"
          data-testid="settings-daily-credit-drip-error"
        >
          {error}
        </Notice>
      ) : null}
    </section>
  );
}
