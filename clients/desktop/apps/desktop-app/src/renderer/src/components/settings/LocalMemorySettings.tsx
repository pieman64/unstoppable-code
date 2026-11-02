import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import {
  defaultLocalMemoryModel,
  type PreferencesData,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import { Button, ToggleSwitch } from '@canopy/ui-shared/components';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { ModelThinkingPreferenceRow } from './ModelThinkingPreferenceRow';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';

const TOGGLE_ID = 'settings-local-memory-enabled';
const TOGGLE_LABEL = 'Use local memory';

const DEFAULT_LOCAL_MEMORY_THINKING_LEVEL: ThinkingLevel = 'high';

interface LocalMemoryModelSelection {
  model: string;
  thinkingLevel: ThinkingLevel;
}

function modelSelection(
  preferences: PreferencesData,
): LocalMemoryModelSelection {
  return {
    model: preferences.localMemoryModel,
    thinkingLevel: preferences.localMemoryThinkingLevel,
  };
}

export function LocalMemorySettings(): JSX.Element {
  // Keep the toggle off until preferences load so the control never flashes
  // an assumed enabled state before the persisted opt-out is known.
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [selection, setSelection] = useState<LocalMemoryModelSelection>(() => ({
    model: defaultLocalMemoryModel(),
    thinkingLevel: DEFAULT_LOCAL_MEMORY_THINKING_LEVEL,
  }));
  // Set once a preferences-synced broadcast has delivered a value, so a
  // late-resolving initial load cannot overwrite the newer synced state.
  const syncedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void window.api
      .loadPreferences()
      .then((preferences) => {
        if (cancelled || syncedRef.current) return;
        setEnabled(preferences.localMemoryEnabled);
        setSelection(modelSelection(preferences));
        setLoaded(true);
      })
      .catch(() => {
        // Keep the conservative off-until-loaded state on load failure.
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window.api.onPreferencesSynced !== 'function') {
      return undefined;
    }
    // Keep the toggle current when the preference is persisted outside this
    // component (e.g. the App Advisor `settings.set_local_memory_enabled`
    // action); the main process broadcasts every normal preferences save.
    return window.api.onPreferencesSynced((preferences) => {
      syncedRef.current = true;
      setEnabled(preferences.localMemoryEnabled);
      setSelection(modelSelection(preferences));
      setLoaded(true);
    });
  }, []);

  useCurrentUiStateReporter('settings.localMemory', {
    loaded,
    enabled,
  });

  const handleEnabledChange = useCallback((nextEnabled: boolean): void => {
    setEnabled(nextEnabled);
    void window.api.savePreferences({
      localMemoryEnabled: nextEnabled,
      localMemoryEnabledSetByUser: true,
    });
  }, []);

  const handleModelChange = useCallback(
    (model: string, thinkingLevel: ThinkingLevel): void => {
      setSelection({ model, thinkingLevel });
      void window.api.savePreferences({
        localMemoryModel: model,
        localMemoryModelSetByUser: true,
        localMemoryThinkingLevel: thinkingLevel,
      });
    },
    [],
  );

  const handleThinkingChange = useCallback(
    (thinkingLevel: ThinkingLevel): void => {
      setSelection((current) => ({ ...current, thinkingLevel }));
      void window.api.savePreferences({
        localMemoryThinkingLevel: thinkingLevel,
      });
    },
    [],
  );

  const handleOpenMemoryFolder = useCallback((): void => {
    void window.api.openMemoryDir();
  }, []);

  return (
    <SettingsSection title="Local memory" dataTestId="local-memory-settings">
      <SettingsGroup>
        <SettingsRow
          label={TOGGLE_LABEL}
          htmlFor={TOGGLE_ID}
          description="Save knowledge on this device and reuse it across your chats."
          control={
            <ToggleSwitch
              id={TOGGLE_ID}
              checked={enabled}
              label={TOGGLE_LABEL}
              onChange={handleEnabledChange}
              dataTestId="local-memory-enabled-toggle"
            />
          }
        />
        <ModelThinkingPreferenceRow
          title="Memory model"
          description="Model used to consolidate and rebuild memories"
          model={selection.model}
          thinkingLevel={selection.thinkingLevel}
          defaultThinkingLevel={DEFAULT_LOCAL_MEMORY_THINKING_LEVEL}
          disabled={!loaded || !enabled}
          testIdPrefix="local-memory"
          onModelChange={handleModelChange}
          onThinkingChange={handleThinkingChange}
        />
        <SettingsRow
          label="Memory folder"
          description="Where your local memories are saved."
          control={
            <Button
              size="compact"
              variant="secondary"
              onClick={handleOpenMemoryFolder}
              data-testid="local-memory-open-folder"
            >
              Open folder
            </Button>
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
