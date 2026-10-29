/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyApi,
  CanopyCloudAccountPublicState,
} from '@canopy/desktop-shared/types';
import { useMobileAppPromo } from '../useMobileAppPromo';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('@/lib/brand', () => ({
  getBrandMobileApps: (): { appStoreUrl: string } => ({
    appStoreUrl: 'https://apps.apple.com/app/id1',
  }),
}));
jest.mock('../useMobileActivation', () => ({
  useMobileActivation: (): { activated: boolean; resolved: boolean } => ({
    activated: false,
    resolved: true,
  }),
}));

const connectedAccount: CanopyCloudAccountPublicState = {
  hasApiKey: true,
  authMode: 'api_key',
  credentialSource: 'manual',
  capabilities: [],
  account: { email: 'dev@example.com' },
  storageAvailable: true,
};

describe('useMobileAppPromo', () => {
  let container: HTMLDivElement;
  let root: Root;
  const savePreferences = jest.fn().mockResolvedValue({});

  function Surface({ name }: { name: string }): JSX.Element {
    const promo = useMobileAppPromo();
    return (
      <button
        type="button"
        data-testid={name}
        data-visible={String(promo.showPromotional)}
        onClick={promo.snooze}
      >
        {name}
      </button>
    );
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadCanopyCloudAccount: jest.fn().mockResolvedValue(connectedAccount),
        loadPreferences: jest.fn().mockResolvedValue({}),
        savePreferences,
      } as Partial<CanopyApi> as CanopyApi,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, 'api');
    jest.clearAllMocks();
  });

  it('one dismissal immediately quiets both independently mounted surfaces', async () => {
    await act(async () => {
      root.render(
        <>
          <Surface name="card" />
          <Surface name="cue" />
        </>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const card = container.querySelector<HTMLButtonElement>(
      '[data-testid="card"]',
    );
    const cue = container.querySelector<HTMLButtonElement>(
      '[data-testid="cue"]',
    );
    expect(card?.getAttribute('data-visible')).toBe('true');
    expect(cue?.getAttribute('data-visible')).toBe('true');

    act(() => card?.click());

    expect(card?.getAttribute('data-visible')).toBe('false');
    expect(cue?.getAttribute('data-visible')).toBe('false');
    expect(savePreferences).toHaveBeenCalledTimes(1);
  });

  it('brings the surfaces back when the one-day snooze lapses in-session', async () => {
    // The deadline is only ever compared against `Date.now()` during a render,
    // so without a wake-up timer a snooze taken in a long-running desktop
    // session stays in effect well past its day — until some unrelated state
    // change happens to re-render. "Quiet for a day" has to mean a day.
    jest.useFakeTimers();
    try {
      await act(async () => {
        root.render(<Surface name="cue" />);
        await Promise.resolve();
        await Promise.resolve();
      });

      const cue = (): HTMLElement | null =>
        container.querySelector('[data-testid="cue"]');
      expect(cue()?.getAttribute('data-visible')).toBe('true');

      act(() => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="cue"]')
          ?.click();
      });
      expect(cue()?.getAttribute('data-visible')).toBe('false');

      // Still inside the day: nothing should have woken up yet.
      act(() => {
        jest.advanceTimersByTime(23 * 60 * 60 * 1000);
      });
      expect(cue()?.getAttribute('data-visible')).toBe('false');

      // Past the deadline, with no remount and no unrelated state change.
      act(() => {
        jest.advanceTimersByTime(61 * 60 * 1000);
      });
      expect(cue()?.getAttribute('data-visible')).toBe('true');
    } finally {
      jest.useRealTimers();
    }
  });
});
