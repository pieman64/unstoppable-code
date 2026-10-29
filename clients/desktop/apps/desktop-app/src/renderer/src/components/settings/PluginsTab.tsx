import { type JSX, useCallback, useEffect, useMemo, useState } from 'react';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { countActiveInstalledItems } from '@canopy/protocol/installed-items';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useDesktopInstalledItemStatuses } from '@/hooks/useDesktopInstalledItemStatuses';
import {
  DEFERRED_TOOLS_ROW_DESCRIPTORS,
  buildDeferredToolsPreferencePatch,
  type DeferredToolsPreferenceField,
} from './pluginsTabHelpers';
import {
  ActiveItemsSummary,
  type ActiveItemsSummaryState,
  Notice,
  NoticeButton,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
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

/**
 * What loads into every new chat (CAN-4255). Replaces the Default plugins
 * picker: status is managed per item in Customize, which this opens filtered
 * to Active items.
 */
export function ActiveItemsSettings(): JSX.Element {
  const { state } = useDesktopInstalledItemStatuses();
  const summary = useMemo((): ActiveItemsSummaryState => {
    if (state.kind === 'ready')
      return {
        kind: 'ready',
        counts: countActiveInstalledItems(state.snapshot),
      };
    if (state.kind === 'loading') return { kind: 'loading' };
    return {
      kind: 'error',
      message: state.kind === 'error' ? state.message : state.reason,
    };
  }, [state]);
  const openActive = useCallback((): void => {
    const navigation = useNavigationStore.getState();
    navigation.closeSettings();
    navigation.openPluginsNavigation({
      kind: 'management',
      section: 'installed',
      statusFilter: 'active',
    });
  }, []);
  return (
    <SettingsSection title="Active items" dataTestId="settings-plugins-active">
      <SettingsGroup>
        <ActiveItemsSummary state={summary} onManage={openActive} />
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
        <Notice
          intent="destructive"
          actions={<NoticeButton onClick={loadPreferences}>Retry</NoticeButton>}
        >
          Could not load plugin settings.
        </Notice>
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
      <ActiveItemsSettings />

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
