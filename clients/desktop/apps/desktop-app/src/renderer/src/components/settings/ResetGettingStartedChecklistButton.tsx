import { useEffect, useState, type JSX } from 'react';
import { Button, ErrorBanner } from '@canopy/ui-shared/components';
import type { HomeOnboardingSuggestionsPreferences } from '@canopy/desktop-shared/types';
import {
  onOnboardingSuggestionCompleted,
  onOnboardingSuggestionsRestored,
  resetOnboardingSuggestionsDurably,
} from '@/components/home/onboarding-suggestions/completionWriter';
import { useOnboardingChecklistStore } from '@/stores/onboardingChecklistStore';
import { SettingsRow } from './SettingsLayout';
import { useSettingsButtonSize } from '@/hooks/useSettingsButtonSize';

function hasProgress(
  state: HomeOnboardingSuggestionsPreferences | undefined,
): boolean {
  return (
    state !== undefined &&
    (state.retiredAt !== undefined ||
      Object.values(state.entries).some(
        (entry) =>
          entry?.completedAt !== undefined || entry?.dismissedAt !== undefined,
      ))
  );
}

export function ResetGettingStartedChecklistButton(): JSX.Element | null {
  const settingsButtonSize = useSettingsButtonSize();
  const [canReset, setCanReset] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let version = 0;
    // Sync events are invalidations: read canonical disk state, not an older
    // cloud snapshot. A reset also invalidates any in-flight initial read.
    const refresh = (): void => {
      const current = ++version;
      void window.api
        .loadPreferences()
        .then((prefs) => {
          if (active && current === version && !prefs.__error)
            setCanReset(hasProgress(prefs.homeOnboardingSuggestions));
        })
        .catch(() => undefined);
    };
    const stopSync = window.api.onPreferencesSynced(refresh);
    const stopCompletion = onOnboardingSuggestionCompleted(refresh);
    const stopReset = onOnboardingSuggestionsRestored((state) => {
      version += 1;
      setCanReset(hasProgress(state));
    });
    refresh();
    return (): void => {
      active = false;
      stopSync();
      stopCompletion();
      stopReset();
    };
  }, []);

  const reset = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await resetOnboardingSuggestionsDurably();
      await useOnboardingChecklistStore.getState().restore();
    } catch {
      setError('Could not reset the checklist. Please try again.');
    } finally {
      setPending(false);
    }
  };
  if (!canReset && error === null) return null;
  return (
    <SettingsRow
      label="Getting started checklist"
      description="Bring back the checklist on Home."
      control={
        <Button
          size={settingsButtonSize}
          disabled={pending}
          onClick={(): void => {
            void reset();
          }}
          data-testid="settings-canopy-restore-checklist"
        >
          Reset
        </Button>
      }
    >
      {error && <ErrorBanner error={error} />}
    </SettingsRow>
  );
}
