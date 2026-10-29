/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  InAppNotificationPlacement,
  InAppNotificationPreferences,
} from '@canopy/desktop-shared/types';
import type { MobileAppStoreLink } from '@canopy/ui-shared/components/StoreBadgeLink';
import { MobileAppCtaBanner } from '../MobileAppCtaBanner';
import { refreshInAppNotificationPrefs } from '@/lib/osNotifications';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';

const snooze = jest.fn();
let promoState: {
  links: readonly MobileAppStoreLink[];
  showPromotional: boolean;
  snooze: () => void;
};

jest.mock('@/hooks/useMobileAppPromo', () => ({
  useMobileAppPromo: (): typeof promoState => promoState,
}));

// The encoder is exercised by useStoreQrCodes' own suite; here it only needs
// to stay out of the way of the adapter's lifecycle assertions.
jest.mock('@/hooks/useStoreQrCodes', () => ({
  useStoreQrCodes: (): Record<string, string> => ({}),
}));

jest.mock('@/lib/brand', () => ({
  brandText: { appName: 'Canopy' },
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function setPlacement(placement: InAppNotificationPlacement): void {
  const preferences: InAppNotificationPreferences = {
    enabled: true,
    placement,
    categories: {
      chat: true,
      script: true,
      hook: true,
      gitCommit: true,
      gitPush: true,
      prCreate: true,
      pipeline: true,
      terminal: true,
      runComment: true,
      activation: true,
    },
  };
  refreshInAppNotificationPrefs(preferences);
}

const LINKS: readonly MobileAppStoreLink[] = [
  {
    store: 'apple-app-store',
    url: 'https://apps.example.com/app',
    badgeSrc: 'data:image/png;base64,apple',
  },
];

describe('MobileAppCtaBanner', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    snooze.mockReset();
    promoState = { links: LINKS, showPromotional: true, snooze };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  function render(): void {
    act(() => root.render(<MobileAppCtaBanner />));
  }

  function slice(): unknown {
    return useCurrentUiStateStore.getState().slices['mobileAppCtaBanner.pill'];
  }

  function query(testId: string): HTMLElement | null {
    return document.body.querySelector<HTMLElement>(
      `[data-testid="${testId}"]`,
    );
  }

  it('reports the popover as open only while it actually is', () => {
    render();
    expect(slice()).toEqual({ open: true, popoverOpen: false });

    act(() => query('mobile-app-cta-banner-action')?.click());
    expect(slice()).toEqual({ open: true, popoverOpen: true });
  });

  // This adapter is rendered unconditionally by App.tsx, so it stays mounted
  // and keeps its state when `show` flips false — but the CtaBanner that owns
  // the real open state unmounts without ever reporting the close. Without a
  // reset, a later re-show describes a popover that is not on screen.
  it('clears the reported popover state when the banner goes away and returns', () => {
    render();
    act(() => query('mobile-app-cta-banner-action')?.click());
    expect(slice()).toEqual({ open: true, popoverOpen: true });

    // Activation detected / snoozed: the banner hides without a reload.
    act(() => {
      promoState = { ...promoState, showPromotional: false };
      root.render(<MobileAppCtaBanner />);
    });
    expect(query('mobile-app-cta-banner')).toBeNull();
    expect(slice() ?? null).toBeNull();

    // Eligibility returns in the same session (snooze cleared, account swap).
    act(() => {
      promoState = { ...promoState, showPromotional: true };
      root.render(<MobileAppCtaBanner />);
    });

    expect(query('mobile-app-cta-banner')).not.toBeNull();
    expect(query('mobile-app-cta-banner-popover')).toBeNull();
    expect(slice()).toEqual({ open: true, popoverOpen: false });
  });

  // The pill hugs its copy rather than filling the 24rem notification column,
  // so it has to be told which edge of that column to sit against — otherwise
  // a right-corner stack renders it floating off the left edge. The placement
  // preference is the only thing that knows, and it can change without a
  // reload, so the adapter subscribes rather than reading once.
  it('follows the notification placement preference to the correct edge', () => {
    setPlacement('bottom-right');
    render();
    expect(query('mobile-app-cta-banner')?.className).toContain('self-end');

    act(() => setPlacement('bottom-left'));
    expect(query('mobile-app-cta-banner')?.className).toContain('self-start');

    act(() => setPlacement('top-right'));
    expect(query('mobile-app-cta-banner')?.className).toContain('self-end');

    act(() => setPlacement('top-left'));
    expect(query('mobile-app-cta-banner')?.className).toContain('self-start');
  });
});
