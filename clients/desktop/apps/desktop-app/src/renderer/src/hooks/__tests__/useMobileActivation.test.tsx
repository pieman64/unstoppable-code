/** @jest-environment jsdom */

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { getBrandMobileApps } from '@/lib/brand';
import { useMobileActivation } from '../useMobileActivation';

jest.mock('@/lib/brand', () => ({
  brandText: { appName: 'Canopy' },
  getBrandMobileApps: jest.fn(),
}));

const mockGetBrandMobileApps = jest.mocked(getBrandMobileApps);

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('useMobileActivation', () => {
  let container: HTMLDivElement;
  let root: Root;
  const load = jest.fn();

  function Harness({ enabled }: { enabled?: boolean } = {}): JSX.Element {
    const state = useMobileActivation(
      enabled === undefined ? undefined : { enabled },
    );
    return (
      <output
        data-testid="state"
        data-activated={String(state.activated)}
        data-resolved={String(state.resolved)}
      />
    );
  }

  beforeEach(() => {
    mockGetBrandMobileApps.mockReturnValue({
      appStoreUrl: 'https://apps.apple.com/app/id1',
      playStoreUrl: 'https://play.google.com/store/apps/details?id=x',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadCanopyCloudMobileActivation: load,
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, 'api');
    jest.clearAllMocks();
  });

  it('bypasses the TTL when the app returns to the foreground', async () => {
    load
      .mockResolvedValueOnce({
        resolved: true,
        hasMobileActivation: false,
      })
      .mockResolvedValueOnce({
        resolved: true,
        hasMobileActivation: true,
      });

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    expect(load).toHaveBeenNthCalledWith(1);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    expect(load).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(
      container
        .querySelector('[data-testid="state"]')
        ?.getAttribute('data-activated'),
    ).toBe('true');
  });

  it('never probes when the brand declares no store listings', async () => {
    // The cue mounts in the always-mounted shell, so an ungated probe would hit
    // the network on every focus/visibilitychange forever under a brand where
    // no surface can render at all.
    mockGetBrandMobileApps.mockReturnValue(null);

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    expect(load).not.toHaveBeenCalled();
    const state = container.querySelector('[data-testid="state"]');
    // Resolved, so consumers do not wait on a request that never happens.
    expect(state?.getAttribute('data-resolved')).toBe('true');
    expect(state?.getAttribute('data-activated')).toBe('false');
  });

  it('stops the ambient forced refreshes once activation is confirmed', async () => {
    load.mockResolvedValue({ resolved: true, hasMobileActivation: true });

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    // Nothing left to discover: every gated surface is already suppressed.
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('drops back to unresolved while an account change re-probes', async () => {
    // Regression: `activated` still holds the PREVIOUS account's answer during
    // the new probe, and the account load lands first. Staying resolved across
    // the transition renders the promo for an already-activated next account
    // and then vanishes it — the startup flash, re-entering via account change.
    let resolveSecond: (value: unknown) => void = () => {};
    load
      .mockResolvedValueOnce({ resolved: true, hasMobileActivation: false })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
      );

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    const state = (): HTMLElement | null =>
      container.querySelector('[data-testid="state"]');
    expect(state()?.getAttribute('data-resolved')).toBe('true');
    expect(state()?.getAttribute('data-activated')).toBe('false');

    await act(async () => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      await Promise.resolve();
    });

    // The probe is in flight: consumers must not act on the old account's
    // `activated: false` as though it described the new one.
    expect(state()?.getAttribute('data-resolved')).toBe('false');

    await act(async () => {
      resolveSecond({ resolved: true, hasMobileActivation: true });
      await Promise.resolve();
    });

    expect(state()?.getAttribute('data-resolved')).toBe('true');
    expect(state()?.getAttribute('data-activated')).toBe('true');
  });

  it('never probes for an account that cannot render a gated surface', async () => {
    // Signed-out and device-scoped guests: `showPromotional` is false whatever
    // the probe answers, and a guest holds real credentials, so an ungated
    // probe is a genuine authenticated round trip per alt-tab for nothing.
    await act(async () => {
      root.render(<Harness enabled={false} />);
      await Promise.resolve();
    });

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    expect(load).not.toHaveBeenCalled();
  });

  it('probes once an ineligible account becomes eligible', async () => {
    load.mockResolvedValue({ resolved: true, hasMobileActivation: false });

    await act(async () => {
      root.render(<Harness enabled={false} />);
      await Promise.resolve();
    });
    expect(load).not.toHaveBeenCalled();

    await act(async () => {
      root.render(<Harness enabled />);
      await Promise.resolve();
    });

    expect(load).toHaveBeenCalledTimes(1);
  });
});
