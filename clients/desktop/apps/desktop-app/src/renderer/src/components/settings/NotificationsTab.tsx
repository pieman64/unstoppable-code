import type { JSX } from 'react';
import { brandText } from '@/lib/brand';
import { CloudDigestSettings } from './CloudDigestSettings';
import { useHostedSettingsAvailable } from './hosted/hosted-settings-availability';
import { useNotificationSettings } from './notification-settings';
import {
  CategoryRows,
  InAppNotificationRows,
  OsNotificationRows,
  PromotionalNotificationRows,
  PromotionalNotificationsLoadFailedNotice,
} from './NotificationDeviceSections';
import {
  SettingsGroup,
  SettingsPage,
  SettingsLoading,
  SettingsSection,
} from './SettingsLayout';

export function NotificationsTab(): JSX.Element {
  const settings = useNotificationSettings();
  const hostedSettingsAvailable = useHostedSettingsAvailable();

  if (!settings.loaded) {
    return (
      <SettingsPage title="Notifications">
        <SettingsLoading />
      </SettingsPage>
    );
  }

  return (
    <SettingsPage title="Notifications" dataTestId="settings-tab-notifications">
      <SettingsSection title="In-app notifications">
        <SettingsGroup>
          <InAppNotificationRows settings={settings} />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="OS notifications">
        <SettingsGroup>
          <OsNotificationRows settings={settings} />
        </SettingsGroup>
      </SettingsSection>

      {settings.activationJourneyEnabled && (
        <SettingsSection
          title="Promotional notifications"
          description={`Tips and product news from ${brandText.appName}, sent as OS notifications. Agent, approval, and failure alerts are not affected.`}
          dataTestId="notifications-promotional-section"
        >
          <PromotionalNotificationsLoadFailedNotice settings={settings} />
          <SettingsGroup>
            <PromotionalNotificationRows settings={settings} />
          </SettingsGroup>
        </SettingsSection>
      )}

      <SettingsSection
        title="Categories"
        description={
          <>
            Which events show a banner and which send an OS notification. Sounds
            set to <em>Default</em> use the default sound above.
          </>
        }
      >
        <SettingsGroup>
          <CategoryRows settings={settings} />
        </SettingsGroup>
      </SettingsSection>

      {/*
       * Cloud-account settings, unlike every local preference above, so this
       * sits last and renders nothing at all unless a connected account and
       * the digests flag both say the surface exists. It returns its own
       * page section. With hosted settings available, work digests live on
       * the hosted Notifications page instead.
       */}
      {!hostedSettingsAvailable && <CloudDigestSettings />}
    </SettingsPage>
  );
}
