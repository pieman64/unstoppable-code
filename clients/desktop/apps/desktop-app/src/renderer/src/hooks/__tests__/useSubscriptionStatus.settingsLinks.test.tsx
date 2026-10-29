/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type { CanopyApi } from '@canopy/desktop-shared/types';
import { accountBillingPath } from '@canopy/protocol/billing';
import { useSubscriptionStatus } from '../useSubscriptionStatus';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;

  interface Window {
    api: CanopyApi;
  }
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockOpenSettingsPathOrWeb = jest.fn<'settings' | 'web', [string]>();

jest.mock('@/lib/navigation/settings-destinations', () => ({
  openSettingsPathOrWeb: (path: string): 'settings' | 'web' =>
    mockOpenSettingsPathOrWeb(path),
}));

type Result = ReturnType<typeof useSubscriptionStatus>;

function Harness({ onResult }: { onResult: (r: Result) => void }): JSX.Element {
  onResult(useSubscriptionStatus());
  return <div />;
}

describe('useSubscriptionStatus settings links', () => {
  let result: Result | null = null;

  beforeEach(() => {
    mockOpenSettingsPathOrWeb.mockReset().mockReturnValue('settings');
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadCanopyCloudAccount: jest.fn().mockResolvedValue(null),
        loadCanopyCloudEntitlements: jest.fn().mockResolvedValue(null),
        getCanopyCloudBaseUrl: jest.fn().mockResolvedValue(null),
        openAuthenticatedPortalPage: jest.fn().mockResolvedValue(true),
      },
    });
    const container = document.createElement('div');
    act(() => {
      createRoot(container).render(
        <Harness
          onResult={(r) => {
            result = r;
          }}
        />,
      );
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'api');
  });

  it('opens billing paths through the in-app-or-web helper', () => {
    result?.openBillingPath(accountBillingPath({ plan: 'pro' }));
    expect(mockOpenSettingsPathOrWeb).toHaveBeenCalledWith(
      accountBillingPath({ plan: 'pro' }),
    );
    expect(window.api.openAuthenticatedPortalPage).not.toHaveBeenCalled();
  });

  it('sends pricing through the helper, which keeps it on the web', () => {
    result?.openUpgradePage();
    expect(mockOpenSettingsPathOrWeb).toHaveBeenCalledWith('/pricing');
  });

  it('opens the billing page through the helper', () => {
    result?.openBillingPage();
    expect(mockOpenSettingsPathOrWeb).toHaveBeenCalledWith('/account');
  });
});
