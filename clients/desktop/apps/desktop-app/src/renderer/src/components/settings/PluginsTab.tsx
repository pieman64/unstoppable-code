import { type JSX, useCallback, useEffect, useState } from 'react';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import {
  DEFERRED_TOOLS_ROW_DESCRIPTORS,
  buildDeferredToolsPreferencePatch,
  type DeferredToolsPreferenceField,
} from './pluginsTabHelpers';
import { ErrorState, Notice, ToggleSwitch } from '@canopy/ui-shared/components';
import { DesktopPluginsSettingsSection } from './hosted/DesktopPluginsSettingsSection';
import { SkillSuggestionsSettingsSection } from './SkillSuggestionsSettingsSection';
import {
  SettingsGroup,
  SettingsPage,
  SettingsLoading,
  SettingsRow,
  SettingsSection,
} from './SettingsLayout';

type DeferredToolsPreferences = Pick<
  PreferencesData,
  DeferredToolsPreferenceField
>;

interface DeferredToolsSettingsProps {
  preferences: DeferredToolsPreferences;
  onToggle: (field: DeferredToolsPreferenceField, value: boolean) => void;
}

export function DeferredToolsSettings({
  preferences,
  onToggle,
}: DeferredToolsSettingsProps): JSX.Element {
  return (
    <SettingsSection
      title="Deferred plugin loading"
      description="Lets agents find and enable missing skills, plugins, and MCP servers. Each chat can change this from its plugin picker."
    >
      <SettingsGroup>
        {DEFERRED_TOOLS_ROW_DESCRIPTORS.map((row) => {
          const inputId = `${row.testId}-input`;
          return (
            <SettingsRow
              key={row.field}
              label={row.title}
              description={row.helperText}
              htmlFor={inputId}
              control={
                <ToggleSwitch
                  id={inputId}
                  checked={preferences[row.field] ?? true}
                  label={row.title}
                  onChange={(next): void => {
                    onToggle(row.field, next);
                  }}
                  dataTestId={row.testId}
                />
              }
            />
          );
        })}
      </SettingsGroup>
    </SettingsSection>
  );
}

export function PluginsTab(): JSX.Element {
  const [preferences, setPreferences] = useState<PreferencesData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState(false);

  const loadPreferences = useCallback((): void => {
    setLoadError(false);
    void window.api
      .loadPreferences()
      .then((loaded) => {
        setPreferences(loaded);
        setLoadError(false);
      })
      .catch(() => {
        setPreferences(null);
        setLoadError(true);
      });
  }, []);

  useEffect(() => {
    loadPreferences();
  }, [loadPreferences]);

  useEffect(
    () =>
      window.api.onPreferencesSynced((synced) => {
        setPreferences(synced);
        setLoadError(false);
      }),
    [],
  );

  const togglePreference = useCallback(
    (field: DeferredToolsPreferenceField, enabled: boolean): void => {
      if (!preferences) return;
      const previous = preferences;
      const optimistic = { ...preferences, [field]: enabled };
      setPreferences(optimistic);
      setSaveError(false);
      useChatStore.getState().applyDeferredToolsDefaults(optimistic);
      void window.api
        .savePreferences(buildDeferredToolsPreferencePatch(field, enabled))
        .then((saved) => {
          setPreferences(saved);
          useChatStore.getState().applyDeferredToolsDefaults(saved);
        })
        .catch(() => {
          setPreferences(previous);
          useChatStore.getState().applyDeferredToolsDefaults(previous);
          setSaveError(true);
        });
    },
    [preferences],
  );

  if (loadError) {
    return (
      <SettingsPage title="Plugins" dataTestId="settings-tab-plugins">
        <ErrorState
          message="Couldn't load plugin settings."
          onRetry={loadPreferences}
          testId="settings-plugins-load-error"
        />
      </SettingsPage>
    );
  }

  if (!preferences) {
    return (
      <SettingsPage title="Plugins">
        <SettingsLoading />
      </SettingsPage>
    );
  }

  return (
    <SettingsPage title="Plugins" dataTestId="settings-tab-plugins">
      <DesktopPluginsSettingsSection />

      <DeferredToolsSettings
        preferences={preferences}
        onToggle={togglePreference}
      />

      <SkillSuggestionsSettingsSection />

      {/* Last, so a failed save never shifts the switch the user just used. */}
      {saveError && (
        <Notice intent="destructive">Could not save plugin settings.</Notice>
      )}
    </SettingsPage>
  );
}
