import { type JSX, useEffect, useState } from 'react';
import type {
  CanopyApi,
  GlobalInstructionsConfig,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import { GlobalInstructionsSettings } from './GlobalInstructionsSettings';
import { SettingsLoading, SettingsPage } from './SettingsLayout';

/** Running sessions keep the instructions they started with. */
const INSTRUCTIONS_PAGE_DESCRIPTION =
  'Custom system-prompt instructions, only added when a new agent session starts.';

export function InstructionsTab(): JSX.Element {
  const [globalInstructions, setGlobalInstructions] =
    useState<GlobalInstructionsConfig | null>(null);

  useEffect(() => {
    const api: CanopyApi = window.api;
    void api
      .loadPreferences()
      .then((preferences: PreferencesData) =>
        setGlobalInstructions(preferences.globalInstructions),
      )
      .catch(() => setGlobalInstructions(null));
  }, []);

  function save(next: GlobalInstructionsConfig): void {
    setGlobalInstructions(next);
    const api: CanopyApi = window.api;
    void api.savePreferences({ globalInstructions: next }).catch(() => {
      // Swallow — preference save can fail if userData is unavailable.
    });
  }

  if (!globalInstructions) {
    return (
      <SettingsPage
        title="Instructions"
        description={INSTRUCTIONS_PAGE_DESCRIPTION}
      >
        <SettingsLoading />
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title="Instructions"
      description={INSTRUCTIONS_PAGE_DESCRIPTION}
      dataTestId="settings-tab-instructions"
    >
      <GlobalInstructionsSettings config={globalInstructions} onChange={save} />
    </SettingsPage>
  );
}
