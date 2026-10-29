import { type JSX, useCallback, useEffect, useState } from 'react';
import { Button, ToggleSwitch } from '@canopy/ui-shared/components';
import { RefreshCw } from '@canopy/ui-shared/icons/AppIcons';
import type { DetectedApp } from '@canopy/desktop-shared/types';
import { pt } from '@/lib/platform-text';
import { uiText } from '@/lib/ui-text';
import { SettingsGroup, SettingsPage, SettingsLoading } from './SettingsLayout';
import { useSettingsButtonSize } from '@/hooks/useSettingsButtonSize';

const CATEGORY_LABELS: Record<string, string> = {
  'file-manager': 'File manager',
  editor: 'Editor',
  terminal: 'Terminal',
  'git-gui': 'Git GUI',
};

export function ApplicationsTab(): JSX.Element {
  const settingsButtonSize = useSettingsButtonSize();
  const [apps, setApps] = useState<DetectedApp[] | null>(null);
  const [disabledApps, setDisabledApps] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const loadApps = useCallback((refresh = false): void => {
    setRefreshing(refresh);
    void (refresh ? window.api.refreshDetectedApps() : window.api.detectApps())
      .then(setApps)
      .catch(() => setApps([]))
      .finally(() => setRefreshing(false));
  }, []);

  useEffect(() => {
    loadApps();
    void window.api.loadPreferences().then((prefs) => {
      setDisabledApps(prefs.disabledOpenApps);
    });
  }, [loadApps]);

  const toggleApp = (appId: string): void => {
    const isDisabled = disabledApps.includes(appId);
    const next = isDisabled
      ? disabledApps.filter((id) => id !== appId)
      : [...disabledApps, appId];
    setDisabledApps(next);
    void window.api.savePreferences({ disabledOpenApps: next });
  };

  if (!apps) {
    return (
      <SettingsPage title={uiText.applications.heading}>
        <SettingsLoading />
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title={uiText.applications.heading}
      description={uiText.applications.helper}
      dataTestId="settings-tab-applications"
      headerTrailing={
        <Button
          size={settingsButtonSize}
          variant="secondary"
          onClick={() => loadApps(true)}
          disabled={refreshing}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`}
          />
          Refresh
        </Button>
      }
    >
      <SettingsGroup>
        {apps.length === 0 ? (
          <p className="text-s fg-secondary">{pt(uiText.applications.empty)}</p>
        ) : null}
        {apps.map((appItem) => {
          const switchId = `settings-application-${appItem.id}`;
          return (
            <div key={appItem.id} className="flex min-h-7 items-center gap-3">
              {appItem.icon ? (
                <img
                  src={appItem.icon}
                  alt=""
                  className="h-6 w-6 shrink-0"
                  draggable={false}
                />
              ) : (
                <span className="h-6 w-6 shrink-0" />
              )}
              <label
                htmlFor={switchId}
                className="min-w-0 flex-1 space-y-0.5"
                data-settings-row-label=""
              >
                <span className="block truncate text-s font-medium fg-primary">
                  {appItem.name}
                </span>
                <span className="block text-xs fg-secondary">
                  {CATEGORY_LABELS[appItem.category] ?? appItem.category}
                </span>
              </label>
              <ToggleSwitch
                id={switchId}
                checked={!disabledApps.includes(appItem.id)}
                label={appItem.name}
                onChange={() => toggleApp(appItem.id)}
              />
            </div>
          );
        })}
      </SettingsGroup>
    </SettingsPage>
  );
}
