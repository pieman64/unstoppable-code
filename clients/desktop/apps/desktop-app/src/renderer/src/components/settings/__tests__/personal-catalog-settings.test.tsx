/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  PersonalCatalogRows,
  PersonalCatalogSettings,
} from '../PersonalCatalogSettings';
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
let mockCloudConnected = false;
jest.mock('@/hooks/useCanopyCloudConnected', () => ({
  useCanopyCloudCredentialUsable: (): boolean => true,
  useCanopyCloudConnected: (): boolean => mockCloudConnected,
}));
// Every subscriber, including the early-access store the settings layout
// reads, hears the same synced snapshot.
const synced: ((preferences: unknown) => void)[] = [];
const stopSynced = jest.fn();
let enrolled = false;
it('renders a collapsed-disclosure Privacy switch row that follows synced preferences', async (): Promise<void> => {
  const snapshot = useFeatureFlagsStore.getState().snapshot;
  useFeatureFlagsStore.setState({
    snapshot: {
      ...snapshot,
      values: {
        ...snapshot.values,
        [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
      },
    },
  });
  const preferences = (): unknown => ({
    personalWorkspaceCatalogSync: enrolled ? 'private' : 'off',
    personalCatalogOfferSeen: false,
    personalCatalogNotice: null,
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences: (): Promise<unknown> => Promise.resolve(preferences()),
      onPreferencesSynced: (
        callback: (preferences: unknown) => void,
      ): (() => void) => {
        synced.push(callback);
        return stopSynced;
      },
      onPreferencesChanged: (): (() => void) => (): void => {},
    },
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act((): Promise<void> => {
      root.render(<PersonalCatalogSettings />);
      return Promise.resolve();
    });
    expect(container.querySelector('h2')?.textContent).toBe(
      'Personal projects on the web',
    );
    expect(
      container
        .querySelector('[data-testid="personal-catalog-disclosure-toggle"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('false');
    expect(
      container.querySelector('[data-testid="personal-catalog-disclosure"]')
        ?.textContent,
    ).toContain('a request to restore the list when you turn sharing on again');
    enrolled = true;
    await act((): Promise<void> => {
      for (const callback of synced) callback(preferences());
      return Promise.resolve();
    });
    expect(
      container.querySelector('[role="switch"]')?.getAttribute('aria-checked'),
    ).toBe('true');
  } finally {
    act((): void => root.unmount());
    expect(stopSynced).toHaveBeenCalled();
  }
});

it.each([
  [
    'privacy',
    false,
    'Turning this off stops updates. Remove the saved list in your web Public profile settings.',
  ],
  [
    'privacy',
    true,
    'Turning this off stops updates. Remove the saved list in your web Public profile settings.',
  ],
  [
    'public-profile',
    true,
    'Turning this off stops updates. Remove the saved list in the Public profile card above.',
  ],
  // Signed out, Public profile shows the sign-in, not the removal card.
  [
    'public-profile',
    false,
    'Turning this off stops updates. Remove the saved list in your web Public profile settings.',
  ],
] as const)(
  'points the %s row (signed in: %s) at where the saved list is removed',
  async (placement, signedIn, description): Promise<void> => {
    mockCloudConnected = signedIn;
    const snapshot = useFeatureFlagsStore.getState().snapshot;
    useFeatureFlagsStore.setState({
      snapshot: {
        ...snapshot,
        values: {
          ...snapshot.values,
          [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
        },
      },
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences: (): Promise<unknown> =>
          Promise.resolve({
            personalWorkspaceCatalogSync: 'off',
            personalCatalogOfferSeen: false,
            personalCatalogNotice: 'removed',
          }),
        onPreferencesSynced: (): (() => void) => (): void => {},
        onPreferencesChanged: (): (() => void) => (): void => {},
      },
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act((): Promise<void> => {
        root.render(
          <PersonalCatalogRows
            placement={placement}
            renderFrame={({ notices, row }) => (
              <div data-testid="frame">
                <div data-testid="frame-notices">{notices}</div>
                <div data-testid="frame-row">{row}</div>
              </div>
            )}
          />,
        );
        return Promise.resolve();
      });
      const row = container.querySelector('[data-testid="frame-row"]');
      expect(row?.textContent).toContain(description);
      expect(row?.querySelector('[role="switch"]')).not.toBeNull();
      expect(
        row?.querySelector('[data-testid="personal-catalog-disclosure"]'),
      ).not.toBeNull();
      // The frame owns layout: no Privacy section, notices passed apart.
      expect(container.querySelector('section')).toBeNull();
      const notices =
        container.querySelector('[data-testid="frame-notices"]')?.textContent ??
        '';
      if (signedIn) {
        expect(notices).not.toContain('Sign in to sync your project list.');
      } else {
        expect(notices).toContain('Sign in to sync your project list.');
      }
      expect(notices).toContain('Your web project list was removed.');
    } finally {
      act((): void => root.unmount());
      mockCloudConnected = false;
    }
  },
);
