import type { JSX, ReactNode } from 'react';
import type { AccountSettingsPage } from '@canopy/protocol/settings';
import {
  LoadingIndicator,
  NoticeShapeProvider,
} from '@canopy/ui-shared/components';
import { SettingsCard } from '@canopy/ui-shared/components/settings/SettingsCard';
import {
  Bell2Icon,
  BulletListIcon,
  FolderIcon,
  GitHubIcon,
  LinearIcon,
  MacbookIcon,
  SparkleIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { ProviderAuthPanel } from '@/components/auth/ProviderAuthPanel';
import { brandText } from '@/lib/brand';
import { CanopyCloudAccountSection } from '../CanopyCloudAccountSection';
import { LinearKeyRow } from '../LinearKeyRow';
import {
  CategoryRows,
  InAppNotificationRows,
  OsNotificationRows,
  PromotionalNotificationRows,
  PromotionalNotificationsLoadFailedNotice,
} from '../NotificationDeviceSections';
import { useNotificationSettings } from '../notification-settings';
import { PersonalCatalogRows } from '../PersonalCatalogSettings';

/**
 * Desktop-only "On this computer" sections under a hosted account page
 * (rendered through the shared frame's `after` region). They hold what the
 * hosted page cannot: this computer's cloud sign-in, notification
 * preferences, GitHub sign-in, Linear key and personal-catalog choice.
 *
 * The sections read and write through `window.api` only, never the hosted
 * settings client or store, so they work signed out and while hosted data
 * loads or fails. Each renders as a shared `SettingsCard`, matching the
 * cards above it (a deliberate deviation from the local settings idiom on
 * these merged pages only).
 */

const CARD_ICON_SIZE = 18;

function DeviceSettingsRegion({
  page,
  children,
}: {
  page: AccountSettingsPage;
  children: ReactNode;
}): JSX.Element {
  const headingId = `account-device-settings-${page}-heading`;
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-6"
      data-testid={`account-device-settings-${page}`}
    >
      <h2 id={headingId} className="text-s fg-secondary">
        On this computer
      </h2>
      {children}
    </section>
  );
}

/** A card body: the desktop rows, divided like a settings group. */
function DeviceCardRows({
  notice,
  children,
}: {
  notice?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {notice}
      <div className="flex flex-col divide-y *:py-3">
        {/* A notice inside a row is part of that row, not a card. */}
        <NoticeShapeProvider shape="default">{children}</NoticeShapeProvider>
      </div>
    </div>
  );
}

function AccountPageDeviceSettings(): JSX.Element {
  return (
    <DeviceSettingsRegion page="account">
      <SettingsCard
        icon={<MacbookIcon size={CARD_ICON_SIZE} />}
        title="Signed in on this computer"
        testId="account-device-card-cloud-account"
      >
        <DeviceCardRows>
          <CanopyCloudAccountSection />
        </DeviceCardRows>
      </SettingsCard>
    </DeviceSettingsRegion>
  );
}

function ProfilePageDeviceSettings(): JSX.Element | null {
  // Nothing at all, not even the heading, while the catalog is hidden.
  return (
    <PersonalCatalogRows
      placement="public-profile"
      renderFrame={({ notices, row }) => (
        <DeviceSettingsRegion page="profile">
          <SettingsCard
            icon={<FolderIcon size={CARD_ICON_SIZE} />}
            title="Personal projects on the web"
            subtitle="Only you can see this list. Project names and repository details can be sensitive."
            testId="personal-catalog-settings"
          >
            <DeviceCardRows notice={notices}>{row}</DeviceCardRows>
          </SettingsCard>
        </DeviceSettingsRegion>
      )}
    />
  );
}

function NotificationsPageDeviceSettings(): JSX.Element {
  const settings = useNotificationSettings();
  return (
    <DeviceSettingsRegion page="notifications">
      {settings.loaded ? (
        <>
          <SettingsCard
            icon={<Bell2Icon size={CARD_ICON_SIZE} />}
            title="In-app notifications"
            testId="account-device-card-in-app-notifications"
          >
            <DeviceCardRows>
              <InAppNotificationRows settings={settings} />
            </DeviceCardRows>
          </SettingsCard>
          <SettingsCard
            icon={<MacbookIcon size={CARD_ICON_SIZE} />}
            title="OS notifications"
            testId="account-device-card-os-notifications"
          >
            <DeviceCardRows>
              <OsNotificationRows settings={settings} />
            </DeviceCardRows>
          </SettingsCard>
          {settings.activationJourneyEnabled ? (
            <SettingsCard
              icon={<SparkleIcon size={CARD_ICON_SIZE} />}
              title="Promotional notifications"
              subtitle={`Tips and product news from ${brandText.appName}, sent as OS notifications. Agent, approval, and failure alerts are not affected.`}
              testId="notifications-promotional-section"
            >
              <DeviceCardRows
                notice={
                  <PromotionalNotificationsLoadFailedNotice
                    settings={settings}
                  />
                }
              >
                <PromotionalNotificationRows settings={settings} />
              </DeviceCardRows>
            </SettingsCard>
          ) : null}
          <SettingsCard
            icon={<BulletListIcon size={CARD_ICON_SIZE} />}
            title="Categories"
            subtitle={
              <>
                Which events show a banner and which send an OS notification.
                Sounds set to <em>Default</em> use the default sound above.
              </>
            }
            testId="account-device-card-notification-categories"
          >
            <DeviceCardRows>
              <CategoryRows settings={settings} />
            </DeviceCardRows>
          </SettingsCard>
        </>
      ) : (
        // No toggle shows a default the user did not choose.
        <div
          className="text-s fg-secondary"
          role="status"
          data-testid="account-device-settings-loading"
        >
          <LoadingIndicator />
        </div>
      )}
    </DeviceSettingsRegion>
  );
}

function IntegrationsPageDeviceSettings(): JSX.Element {
  return (
    <DeviceSettingsRegion page="integrations">
      <SettingsCard
        icon={<GitHubIcon size={CARD_ICON_SIZE} />}
        title="GitHub on this computer"
        testId="account-device-card-github"
      >
        <DeviceCardRows>
          <ProviderAuthPanel provider="github" layout="row" />
        </DeviceCardRows>
      </SettingsCard>
      <SettingsCard
        icon={<LinearIcon size={CARD_ICON_SIZE} />}
        title="Linear"
        testId="account-device-card-linear"
      >
        <DeviceCardRows>
          <LinearKeyRow />
        </DeviceCardRows>
      </SettingsCard>
    </DeviceSettingsRegion>
  );
}

export interface AccountDeviceSettingsProps {
  /** The hosted account page the sections sit under. */
  readonly page: AccountSettingsPage;
}

/**
 * This computer's settings for a hosted account page, or `null` for pages
 * without device content (Digests, Security, Billing and their detail
 * routes, and Labs, which desktop shows in its own section).
 */
export function AccountDeviceSettings({
  page,
}: AccountDeviceSettingsProps): JSX.Element | null {
  switch (page) {
    case 'account':
      return <AccountPageDeviceSettings />;
    case 'profile':
      return <ProfilePageDeviceSettings />;
    case 'notifications':
      return <NotificationsPageDeviceSettings />;
    case 'integrations':
      return <IntegrationsPageDeviceSettings />;
    case 'digests':
    case 'security':
    case 'billing':
    case 'labs':
      return null;
  }
}
