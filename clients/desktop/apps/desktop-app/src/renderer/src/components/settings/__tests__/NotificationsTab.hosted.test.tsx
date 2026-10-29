/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NotificationsTab } from '../NotificationsTab';

let mockHostedSettingsAvailable = false;
jest.mock('../hosted/hosted-settings-availability', () => ({
  ...jest.requireActual<object>('../hosted/hosted-settings-availability'),
  useHostedSettingsAvailable: (): boolean => mockHostedSettingsAvailable,
}));

// Marks where the work-digest section mounts; it has dedicated coverage.
jest.mock('../CloudDigestSettings', () => ({
  CloudDigestSettings: (): JSX.Element => (
    <section data-testid="stub-cloud-digest-settings" />
  ),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences: jest.fn().mockResolvedValue({}),
      savePreferences: jest.fn().mockResolvedValue(undefined),
    },
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  container.remove();
  mockHostedSettingsAvailable = false;
});

async function renderTab(): Promise<void> {
  await act(async () => {
    root.render(<NotificationsTab />);
    await Promise.resolve();
  });
}

function sectionTitles(): string[] {
  return Array.from(container.querySelectorAll('section > div > h2')).map(
    (heading) => heading.textContent?.trim() ?? '',
  );
}

describe('NotificationsTab with hosted account settings', () => {
  it('drops the work-digest section when hosted settings are available', async () => {
    mockHostedSettingsAvailable = true;
    await renderTab();

    expect(
      container.querySelector('[data-testid="settings-tab-notifications"]'),
    ).not.toBeNull();
    // Work digests live on the hosted Notifications page instead.
    expect(
      container.querySelector('[data-testid="stub-cloud-digest-settings"]'),
    ).toBeNull();
    expect(sectionTitles()).toEqual([
      'In-app notifications',
      'OS notifications',
      'Categories',
    ]);
  });

  it('keeps the work-digest section last when hosted settings are unavailable', async () => {
    await renderTab();

    const page = container.querySelector(
      '[data-testid="settings-tab-notifications"]',
    );
    const digest = container.querySelector(
      '[data-testid="stub-cloud-digest-settings"]',
    );
    expect(digest).not.toBeNull();
    const sections = Array.from(page?.querySelectorAll('section') ?? []);
    expect(sections.at(-1)).toBe(digest);
    expect(sectionTitles()).toEqual([
      'In-app notifications',
      'OS notifications',
      'Categories',
    ]);
  });
});
