/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AccountSettingsPage } from '@canopy/protocol/settings';
import type { NotificationSettingsController } from '../../notification-settings';
import { AccountDeviceSettings } from '../AccountDeviceSettings';

// The rows are their own modules' concern (and their own tests'); stubs
// show which rows each card holds.
jest.mock('../../CanopyCloudAccountSection', () => ({
  CanopyCloudAccountSection: (): JSX.Element => (
    <div data-testid="cloud-account-row" />
  ),
}));
jest.mock('../../LinearKeyRow', () => ({
  LinearKeyRow: (): JSX.Element => <div data-testid="linear-row" />,
}));
jest.mock('@/components/auth/ProviderAuthPanel', () => ({
  ProviderAuthPanel: ({
    provider,
    layout,
  }: {
    provider: string;
    layout: string;
  }): JSX.Element => (
    <div data-testid={`provider-auth-${provider}`} data-layout={layout} />
  ),
}));
let mockCatalogVisible = true;
jest.mock('../../PersonalCatalogSettings', () => ({
  PersonalCatalogRows: ({
    placement,
    renderFrame,
  }: {
    placement: string;
    renderFrame: (parts: {
      notices: ReactNode;
      row: JSX.Element;
    }) => JSX.Element;
  }): JSX.Element | null =>
    mockCatalogVisible
      ? renderFrame({
          notices: <div data-testid="catalog-notice" />,
          row: <div data-testid="catalog-row" data-placement={placement} />,
        })
      : null,
}));
let mockSettings: NotificationSettingsController;
const useNotificationSettings = jest.fn(
  (): NotificationSettingsController => mockSettings,
);
jest.mock('../../notification-settings', () => ({
  useNotificationSettings: (): NotificationSettingsController =>
    useNotificationSettings(),
}));
interface RowsProps {
  settings: NotificationSettingsController;
}
jest.mock('../../NotificationDeviceSections', () => ({
  InAppNotificationRows: (): JSX.Element => <div data-testid="in-app-rows" />,
  OsNotificationRows: (): JSX.Element => <div data-testid="os-rows" />,
  PromotionalNotificationRows: (): JSX.Element => (
    <div data-testid="promotional-rows" />
  ),
  CategoryRows: (): JSX.Element => <div data-testid="category-rows" />,
  PromotionalNotificationsLoadFailedNotice: ({
    settings,
  }: RowsProps): JSX.Element | null =>
    settings.loadFailed ? <div data-testid="promotional-load-failed" /> : null,
}));
// Device sections read `window.api` only; the hosted settings client is the
// shared pages' concern.
const registeredHostedSettingsClient = jest.fn((): null => null);
jest.mock('@/client/hosted-settings-client-registry', () => ({
  registeredHostedSettingsClient: (): null => registeredHostedSettingsClient(),
  registerHostedSettingsCanopyClient: (): void => undefined,
}));
// Removed with hosted settings: they must never mount here.
jest.mock('../../CloudDailyCreditDripSettings', () => ({
  CloudDailyCreditDripSettings: (): JSX.Element => (
    <div data-testid="daily-credit-drip" />
  ),
}));
jest.mock('../../CloudDigestSettings', () => ({
  CloudDigestSettings: (): JSX.Element => <div data-testid="cloud-digests" />,
}));

function notificationSettings(
  overrides: Partial<NotificationSettingsController> = {},
): NotificationSettingsController {
  const base: Partial<NotificationSettingsController> = {
    loaded: true,
    loadFailed: false,
    activationJourneyEnabled: false,
  };
  // The cards read only these fields; the rows (stubbed) read the rest.
  return Object.assign(base, overrides) as NotificationSettingsController;
}

let container: HTMLDivElement;
let root: Root;

function render(page: AccountSettingsPage): void {
  act(() => root.render(<AccountDeviceSettings page={page} />));
}

function query(testId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function cardTitles(): string[] {
  return Array.from(container.querySelectorAll('section section h2')).map(
    (heading) => heading.textContent ?? '',
  );
}

beforeEach(() => {
  mockCatalogVisible = true;
  mockSettings = notificationSettings();
  useNotificationSettings.mockClear();
  registeredHostedSettingsClient.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('AccountDeviceSettings', () => {
  it('puts the cloud sign-in under Account', () => {
    render('account');
    const region = query('account-device-settings-account');
    // One more section of the page, named like the others.
    expect(region?.getAttribute('aria-label')).toBe('On this computer');
    expect(cardTitles()).toEqual(['On this computer']);
    expect(
      query('account-device-card-cloud-account')?.contains(
        query('cloud-account-row'),
      ),
    ).toBe(true);
  });

  it('puts the personal catalog under Public profile with its placement copy', () => {
    render('profile');
    expect(query('account-device-settings-profile')).not.toBeNull();
    expect(cardTitles()).toEqual(['On this computer']);
    const card = query('personal-catalog-settings');
    expect(card?.contains(query('catalog-notice'))).toBe(true);
    expect(query('catalog-row')?.dataset.placement).toBe('public-profile');
  });

  it('renders nothing on Public profile while the catalog is hidden', () => {
    mockCatalogVisible = false;
    render('profile');
    expect(container.innerHTML).toBe('');
  });

  it('shows one loading indicator until notification preferences load', () => {
    mockSettings = notificationSettings({ loaded: false });
    render('notifications');
    expect(query('account-device-settings-notifications')).not.toBeNull();
    expect(cardTitles()).toEqual([]);
    expect(query('in-app-rows')).toBeNull();
    expect(container.querySelectorAll('[role="status"]').length).toBe(1);
    expect(query('account-device-settings-loading')?.textContent).toBe(
      'Loading…',
    );
  });

  it('puts the notification rows under Notifications once loaded', () => {
    render('notifications');
    // In-app and OS notifications share one "On this computer" section.
    expect(cardTitles()).toEqual(['On this computer', 'Categories']);
    expect(
      query('account-device-card-in-app-notifications')?.contains(
        query('in-app-rows'),
      ),
    ).toBe(true);
    expect(
      query('account-device-card-os-notifications')?.contains(query('os-rows')),
    ).toBe(true);
    expect(
      query('account-device-card-notification-categories')?.contains(
        query('category-rows'),
      ),
    ).toBe(true);
    expect(query('notifications-promotional-section')).toBeNull();
  });

  it('adds the Promotional card only with the activation journey on', () => {
    mockSettings = notificationSettings({ activationJourneyEnabled: true });
    render('notifications');
    expect(cardTitles()).toEqual([
      'On this computer',
      'Promotional notifications',
      'Categories',
    ]);
    expect(
      query('notifications-promotional-section')?.contains(
        query('promotional-rows'),
      ),
    ).toBe(true);
    expect(query('promotional-load-failed')).toBeNull();
  });

  it('shows the promotional load-failed notice above its rows', () => {
    mockSettings = notificationSettings({
      activationJourneyEnabled: true,
      loadFailed: true,
    });
    render('notifications');
    const card = query('notifications-promotional-section');
    const notice = query('promotional-load-failed');
    const rows = query('promotional-rows');
    expect(card?.contains(notice)).toBe(true);
    expect(
      notice !== null &&
        rows !== null &&
        Boolean(
          notice.compareDocumentPosition(rows) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
    ).toBe(true);
  });

  it('puts GitHub and Linear under Integrations', () => {
    render('integrations');
    expect(cardTitles()).toEqual(['On this computer']);
    const github = query('provider-auth-github');
    expect(github?.dataset.layout).toBe('row');
    expect(query('account-device-card-github')?.contains(github)).toBe(true);
    expect(
      query('account-device-card-linear')?.contains(query('linear-row')),
    ).toBe(true);
  });

  it.each<AccountSettingsPage>(['digests', 'security', 'billing'])(
    'renders nothing on %s',
    (page) => {
      render(page);
      expect(container.innerHTML).toBe('');
    },
  );

  it.each<AccountSettingsPage>([
    'account',
    'profile',
    'notifications',
    'integrations',
  ])('never shows the removed drip or digest panels on %s', (page) => {
    render(page);
    expect(query('daily-credit-drip')).toBeNull();
    expect(query('cloud-digests')).toBeNull();
  });

  it('never reaches for the hosted settings client', () => {
    mockSettings = notificationSettings({ activationJourneyEnabled: true });
    for (const page of [
      'account',
      'profile',
      'notifications',
      'integrations',
    ] as const)
      render(page);
    expect(registeredHostedSettingsClient).not.toHaveBeenCalled();
  });

  it('reads notification preferences only on Notifications', () => {
    render('account');
    render('integrations');
    expect(useNotificationSettings).not.toHaveBeenCalled();
    render('notifications');
    expect(useNotificationSettings).toHaveBeenCalled();
  });
});
