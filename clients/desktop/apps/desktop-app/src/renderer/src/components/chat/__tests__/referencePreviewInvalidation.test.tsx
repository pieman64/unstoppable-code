/**
 * @jest-environment jsdom
 *
 * CAN-4061: the production path from the composer's org-lapse banner to the
 * transcript preview caches. A focus or visibility return re-probes the cloud
 * account and announces the result; only an identity change (or a
 * notification that cannot prove otherwise) may purge Linear/GitHub previews.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AiCreditsScopeRequest,
  CanopyCloudAccountPublicState,
  NativeAiCreditsAvailability,
} from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { refreshAndAnnounceCanopyCloudAccount } from '@/lib/canopyCloudAccountChange';
import {
  GITHUB_CONNECTION_CHANGED_EVENT,
  LINEAR_CONNECTION_CHANGED_EVENT,
} from '@/lib/integrationConnectionEvents';
import { OrgLapsedBanner } from '../OrgLapsedBanner';
import { ensureReferencePreviewInvalidation } from '../referencePreviewDecoration';

const invalidateReferencePreviews = jest.fn();

jest.mock('@canopy/app-state', () => ({
  ...jest.requireActual<Record<string, unknown>>('@canopy/app-state'),
  invalidateReferencePreviews: (...args: unknown[]): unknown =>
    invalidateReferencePreviews(...args),
}));

function signedIn(
  id = 'acct_1',
  overrides: Partial<CanopyCloudAccountPublicState> = {},
): CanopyCloudAccountPublicState {
  return {
    read: 'ok',
    hasApiKey: true,
    authMode: 'oauth',
    credentialSource: 'oauth_desktop',
    serverApiKeyId: `key-${id}`,
    capabilities: [],
    storageAvailable: true,
    orgBillingStates: [],
    account: {
      id,
      name: 'Test User',
      email: `${id}@example.com`,
      role: 'DEVELOPER',
    },
    ...overrides,
  };
}

const SIGNED_OUT: CanopyCloudAccountPublicState = {
  read: 'ok',
  hasApiKey: false,
  authMode: null,
  credentialSource: null,
  capabilities: [],
  storageAvailable: true,
};

const NATIVE: NativeAiCreditsAvailability = {
  personalEligible: true,
  inOrg: false,
  orgCreditPoolCovered: false,
  orgSpendable: false,
  pricingUrl: 'https://cloud.example.com/pricing',
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('reference preview invalidation from account notifications (CAN-4061)', () => {
  const originalApi = Object.getOwnPropertyDescriptor(window, 'api');
  const loadCanopyCloudAccount = jest.fn<
    Promise<CanopyCloudAccountPublicState>,
    []
  >();
  const refreshCanopyCloudEnforcedSettings = jest.fn<
    Promise<CanopyCloudAccountPublicState>,
    []
  >();
  const loadNativeAiCreditsAvailability = jest.fn<
    Promise<NativeAiCreditsAvailability>,
    [AiCreditsScopeRequest?]
  >();
  // The banner throttles re-probes for 60s across every mounted instance, so
  // each case starts well past the previous one's window.
  let now = 1_800_000_000_000;
  let container: HTMLDivElement;
  let root: Root;
  const notifications: Event[] = [];
  const recordNotification = (event: Event): void => {
    notifications.push(event);
  };

  beforeAll(() => {
    ensureReferencePreviewInvalidation();
    window.addEventListener(
      CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
      recordNotification,
    );
  });

  afterAll(() => {
    window.removeEventListener(
      CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
      recordNotification,
    );
  });

  beforeEach(() => {
    now += 10 * 60_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    invalidateReferencePreviews.mockReset();
    notifications.length = 0;
    loadCanopyCloudAccount.mockReset().mockResolvedValue(signedIn());
    refreshCanopyCloudEnforcedSettings
      .mockReset()
      .mockResolvedValue(signedIn());
    loadNativeAiCreditsAvailability.mockReset().mockResolvedValue(NATIVE);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadCanopyCloudAccount,
        refreshCanopyCloudEnforcedSettings,
        loadNativeAiCreditsAvailability,
      },
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.restoreAllMocks();
    if (originalApi) Object.defineProperty(window, 'api', originalApi);
    else Reflect.deleteProperty(window, 'api');
  });

  /** Mounts banners as `ChatInput` does: present even when not visible. */
  async function mountBanners(count = 1): Promise<void> {
    await act(async () => {
      root.render(
        <>
          {Array.from({ length: count }, (_, index) => (
            <OrgLapsedBanner key={index} provider="claude" nativeAuth />
          ))}
        </>,
      );
      await settle();
    });
  }

  async function returnToApp(
    via: 'focus' | 'visibilitychange' = 'focus',
  ): Promise<void> {
    await act(async () => {
      if (via === 'focus') window.dispatchEvent(new Event('focus'));
      else document.dispatchEvent(new Event('visibilitychange'));
      await settle();
    });
  }

  it('keeps both providers when an invisible banner re-probes the same account on focus', async () => {
    await mountBanners();
    await returnToApp('focus');

    expect(refreshCanopyCloudEnforcedSettings).toHaveBeenCalledTimes(1);
    // Billing subscribers are still told the account data was refreshed.
    expect(notifications).toHaveLength(1);
    expect(invalidateReferencePreviews).not.toHaveBeenCalled();
  });

  it('keeps both providers on a visibility return for the same account', async () => {
    await mountBanners();
    await returnToApp('visibilitychange');

    expect(refreshCanopyCloudEnforcedSettings).toHaveBeenCalledTimes(1);
    expect(notifications).toHaveLength(1);
    expect(invalidateReferencePreviews).not.toHaveBeenCalled();
  });

  it('shares one probe across banners and repeated returns, without purging', async () => {
    await mountBanners(3);
    await returnToApp('focus');
    await returnToApp('visibilitychange');
    await returnToApp('focus');

    expect(refreshCanopyCloudEnforcedSettings).toHaveBeenCalledTimes(1);
    expect(notifications).toHaveLength(1);
    expect(invalidateReferencePreviews).not.toHaveBeenCalled();
  });

  it('keeps cached previews when the re-probe fails', async () => {
    refreshCanopyCloudEnforcedSettings.mockRejectedValue(new Error('offline'));
    await mountBanners();
    await returnToApp('focus');

    expect(notifications).toHaveLength(0);
    expect(invalidateReferencePreviews).not.toHaveBeenCalled();
  });

  it('purges when the re-probe fails but the stored account was replaced meanwhile', async () => {
    await mountBanners();
    const held = deferred<CanopyCloudAccountPublicState>();
    refreshCanopyCloudEnforcedSettings.mockReturnValue(held.promise);
    await returnToApp('focus');
    expect(refreshCanopyCloudEnforcedSettings).toHaveBeenCalledTimes(1);
    expect(notifications).toHaveLength(0);

    // Another window replaces the account; this window's probe then fails.
    loadCanopyCloudAccount.mockResolvedValue(signedIn('acct_2'));
    await act(async () => {
      held.reject(new Error('offline'));
      await settle();
    });

    expect(notifications).toHaveLength(1);
    expect(invalidateReferencePreviews).toHaveBeenCalledTimes(1);
    expect(invalidateReferencePreviews).toHaveBeenCalledWith();
  });

  it('keeps cached previews but still notifies when an always-announcing refresh fails on a degraded store', async () => {
    refreshCanopyCloudEnforcedSettings.mockRejectedValue(new Error('offline'));
    loadCanopyCloudAccount.mockResolvedValue({ ...SIGNED_OUT, read: 'error' });
    await act(async () => {
      await refreshAndAnnounceCanopyCloudAccount();
    });

    expect(notifications).toHaveLength(1);
    expect(invalidateReferencePreviews).not.toHaveBeenCalled();
  });

  it('purges both providers when the re-probe reports another account', async () => {
    refreshCanopyCloudEnforcedSettings.mockResolvedValue(signedIn('acct_2'));
    await mountBanners();
    await returnToApp('focus');

    expect(invalidateReferencePreviews).toHaveBeenCalledTimes(1);
    expect(invalidateReferencePreviews).toHaveBeenCalledWith();
  });

  it('purges both providers when the re-probe finds the account signed out', async () => {
    refreshCanopyCloudEnforcedSettings.mockResolvedValue(SIGNED_OUT);
    await mountBanners();
    await returnToApp('focus');

    expect(invalidateReferencePreviews).toHaveBeenCalledTimes(1);
  });

  it.each(['error', 'unavailable'] as const)(
    'preserves both providers when the re-probe result is %s without identity evidence',
    async (read) => {
      refreshCanopyCloudEnforcedSettings.mockResolvedValue({
        ...SIGNED_OUT,
        read,
      });
      await mountBanners();
      await returnToApp('focus');

      expect(invalidateReferencePreviews).not.toHaveBeenCalled();
    },
  );

  it.each(['error', 'unavailable'] as const)(
    'purges both providers when an %s initiating read is followed by a confirmed identity',
    async (read) => {
      await mountBanners();
      loadCanopyCloudAccount.mockResolvedValue({ ...SIGNED_OUT, read });
      await returnToApp('focus');

      expect(invalidateReferencePreviews).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['error', 'unavailable'] as const)(
    'preserves both providers when account reads remain %s through a fulfilled refresh',
    async (read) => {
      await mountBanners();
      loadCanopyCloudAccount.mockResolvedValue({ ...SIGNED_OUT, read });
      refreshCanopyCloudEnforcedSettings.mockResolvedValue({
        ...SIGNED_OUT,
        read,
      });
      await returnToApp('focus');

      expect(invalidateReferencePreviews).not.toHaveBeenCalled();
    },
  );

  it('does not let a refresh that straddled a sign-out claim the same account', async () => {
    await mountBanners();
    const held = deferred<CanopyCloudAccountPublicState>();
    refreshCanopyCloudEnforcedSettings.mockReturnValue(held.promise);
    await returnToApp('focus');
    expect(refreshCanopyCloudEnforcedSettings).toHaveBeenCalledTimes(1);

    // Sign-out and sign-back-in elsewhere in this window while the probe is
    // in flight: each is a legacy, reason-less notification.
    await act(async () => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      await settle();
    });
    expect(invalidateReferencePreviews).toHaveBeenCalledTimes(1);

    await act(async () => {
      held.resolve(signedIn());
      await settle();
    });

    expect(invalidateReferencePreviews).toHaveBeenCalledTimes(2);
  });

  it('still purges for a legacy notification that names no reason', async () => {
    await act(async () => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      await settle();
    });

    expect(invalidateReferencePreviews).toHaveBeenCalledTimes(1);
    expect(invalidateReferencePreviews).toHaveBeenCalledWith();
  });

  it('purges only the provider whose connection changed', () => {
    window.dispatchEvent(new Event(LINEAR_CONNECTION_CHANGED_EVENT));
    window.dispatchEvent(new Event(GITHUB_CONNECTION_CHANGED_EVENT));

    expect(invalidateReferencePreviews.mock.calls).toEqual([
      [undefined, 'linear'],
      [undefined, 'github'],
    ]);
  });
});
