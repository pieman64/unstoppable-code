import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import { ErrorBanner, ToggleSwitch } from '@canopy/ui-shared/components';
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/SettingsLayout';
import {
  readRepeatTaskSuggestionsEnabled,
  stopRepeatTaskSuggestions,
} from '@/lib/repeat-task-automation/settings';

const SECTION_TITLE = 'Suggestions';
const LABEL = 'Suggest automations for repeated tasks';
const HELPER =
  'When a task you send from New task is similar to an earlier one, offer to make it an automation. Turning this off stops comparing tasks and forgets the ones already recorded.';
const SAVE_ERROR_MESSAGE = "Couldn't save this setting. Try again.";
const SWITCH_ID = 'settings-repeat-task-suggestions-switch';

/**
 * Settings → General → "Suggest automations for repeated tasks" (CAN-4009).
 * Persists `PreferencesData.repeatTaskAutomationSuggestionsEnabled`; off stops
 * New task from recording prompts and clears the recorded history.
 */
export function RepeatTaskSuggestionsSection(): JSX.Element {
  return (
    <SettingsSection title={SECTION_TITLE}>
      <SettingsGroup>
        <RepeatTaskSuggestionsRow />
      </SettingsGroup>
    </SettingsSection>
  );
}

function RepeatTaskSuggestionsRow(): JSX.Element {
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const enabledRef = useRef(enabled);
  // While a save is in flight its result is authoritative: an earlier read or
  // a broadcast must not repaint the switch underneath it.
  const savingRef = useRef(false);

  // A degraded read leaves the switch where it is.
  const applyEnabled = useCallback((next: boolean | null): void => {
    if (next === null) return;
    enabledRef.current = next;
    setEnabled(next);
    if (!next) stopRepeatTaskSuggestions();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.api
      .loadPreferences()
      .then((preferences) => {
        if (cancelled || savingRef.current) return;
        applyEnabled(readRepeatTaskSuggestionsEnabled(preferences));
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return (): void => {
      cancelled = true;
    };
  }, [applyEnabled]);

  // Follows a choice saved from another window while Settings stays open.
  useEffect(
    () =>
      window.api.onPreferencesSynced((preferences) => {
        if (savingRef.current) return;
        applyEnabled(readRepeatTaskSuggestionsEnabled(preferences));
        setLoaded(true);
      }),
    [applyEnabled],
  );

  const handleToggle = useCallback(
    (next: boolean): void => {
      const previous = enabledRef.current;
      enabledRef.current = next;
      setEnabled(next);
      savingRef.current = true;
      setSaving(true);
      setSaveError(null);
      // Main merges this one field into the saved preferences.
      void window.api
        .savePreferences({ repeatTaskAutomationSuggestionsEnabled: next })
        .then((preferences) => {
          applyEnabled(
            preferences.repeatTaskAutomationSuggestionsEnabled !== false,
          );
        })
        .catch(() => {
          applyEnabled(previous);
          setSaveError(SAVE_ERROR_MESSAGE);
        })
        .finally(() => {
          savingRef.current = false;
          setSaving(false);
        });
    },
    [applyEnabled],
  );

  return (
    <SettingsRow
      label={LABEL}
      htmlFor={SWITCH_ID}
      description={HELPER}
      dataTestId="settings-repeat-task-suggestions"
      control={
        <ToggleSwitch
          id={SWITCH_ID}
          checked={enabled}
          disabled={!loaded || saving}
          label={LABEL}
          onChange={handleToggle}
          dataTestId="settings-repeat-task-suggestions-toggle"
        />
      }
    >
      <ErrorBanner className="" error={saveError} />
    </SettingsRow>
  );
}
