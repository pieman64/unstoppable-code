/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OsNotificationOptInResponse } from '@canopy/desktop-shared/types';
import {
  __resetOsNotificationOfferForTests,
  applyOsNotificationOfferPreferences,
  noteOsNotificationOfferCompletion,
  useOsNotificationOfferStore,
} from '@/lib/osNotificationOffer';
import type { ToastMeta } from '@/stores/githubStore';
import { OsNotificationOfferBanner } from '../OsNotificationOfferBanner';

const addToastMock = jest.fn<
  void,
  [string, string, (() => void) | undefined, ToastMeta | undefined]
>();
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: jest.Mock } => ({ addToast: addToastMock }),
  },
}));

const reportMock = jest.fn();
jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (key: string, value: unknown): void => {
    reportMock(key, value);
  },
}));

const refreshMock = jest.fn();
jest.mock('@/lib/osNotifications', () => ({
  refreshOsNotificationPrefs: (value: unknown): void => {
    refreshMock(value);
  },
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const osNotifications = {
  enabled: false,
  skipWhenFocused: false,
  defaultSound: 'System',
  categories: {},
  categorySounds: {},
};

let focused = true;
let container: HTMLDivElement;
let root: Root;
let api: {
  savePreferences: jest.Mock;
  optInToOsNotifications: jest.Mock<Promise<OsNotificationOptInResponse>, []>;
  openOsNotificationSettings: jest.Mock;
  loadPreferences: jest.Mock;
};

function card(): HTMLElement | null {
  return container.querySelector('[data-testid="os-notification-offer"]');
}

function click(testId: string): void {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLButtonElement)) throw new Error(testId);
  act(() => {
    element.click();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  focused = true;
  jest.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  api = {
    savePreferences: jest.fn(() => Promise.resolve({})),
    optInToOsNotifications: jest.fn(() =>
      Promise.resolve({ enabled: true, delivered: true }),
    ),
    openOsNotificationSettings: jest.fn(() => Promise.resolve()),
    loadPreferences: jest.fn(() =>
      Promise.resolve({
        osNotifications: { ...osNotifications, enabled: true },
      }),
    ),
  };
  Object.defineProperty(window, 'api', { configurable: true, value: api });
  __resetOsNotificationOfferForTests();
  applyOsNotificationOfferPreferences({
    osNotifications: { ...osNotifications, categories: {}, categorySounds: {} },
  } as never);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  jest.restoreAllMocks();
  addToastMock.mockReset();
  reportMock.mockReset();
  refreshMock.mockReset();
});

function render(): void {
  act(() => {
    root.render(<OsNotificationOfferBanner />);
  });
}

describe('OsNotificationOfferBanner', () => {
  it('stays hidden until an offer is pending', () => {
    render();
    expect(card()).toBeNull();
    act(() => {
      noteOsNotificationOfferCompletion(false);
    });
    expect(card()).not.toBeNull();
    expect(reportMock).toHaveBeenLastCalledWith('osNotificationOffer.banner', {
      open: true,
    });
  });

  it('hides on blur without answering and returns on refocus', () => {
    focused = false;
    render();
    act(() => {
      noteOsNotificationOfferCompletion(false);
    });
    expect(card()).toBeNull();
    act(() => {
      focused = true;
      window.dispatchEvent(new Event('focus'));
    });
    expect(card()).not.toBeNull();
    act(() => {
      focused = false;
      window.dispatchEvent(new Event('blur'));
    });
    expect(card()).toBeNull();
    expect(useOsNotificationOfferStore.getState().pending).toBe(true);
    expect(api.savePreferences).not.toHaveBeenCalled();
  });

  it('clears when preferences sync an answer from elsewhere', () => {
    render();
    act(() => {
      noteOsNotificationOfferCompletion(false);
    });
    act(() => {
      applyOsNotificationOfferPreferences({
        osNotifications: { ...osNotifications, enabled: true },
      } as never);
    });
    expect(card()).toBeNull();
  });

  it('saves Not now and never opts in', async () => {
    render();
    act(() => {
      noteOsNotificationOfferCompletion(false);
    });
    click('os-notification-offer-dismiss');
    await flush();
    expect(api.savePreferences).toHaveBeenCalledTimes(1);
    expect(api.optInToOsNotifications).not.toHaveBeenCalled();
    expect(card()).toBeNull();
  });

  it('turns notifications on and refreshes the delivery cache', async () => {
    render();
    act(() => {
      noteOsNotificationOfferCompletion(false);
    });
    click('os-notification-offer-enable');
    await flush();
    expect(api.optInToOsNotifications).toHaveBeenCalledTimes(1);
    expect(refreshMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
    expect(addToastMock).not.toHaveBeenCalled();
    expect(card()).toBeNull();
  });

  it('follows an OS refusal with one settings warning that cannot re-arm', async () => {
    api.optInToOsNotifications.mockResolvedValue({
      enabled: true,
      delivered: false,
      reason: 'os-denied',
    });
    render();
    act(() => {
      noteOsNotificationOfferCompletion(false);
    });
    click('os-notification-offer-enable');
    await flush();
    expect(addToastMock).toHaveBeenCalledTimes(1);
    const meta = addToastMock.mock.calls[0][3];
    expect(meta).toMatchObject({
      forceInApp: true,
      suppressOsNotification: true,
      action: { label: 'Open settings' },
    });
    expect(meta?.agentCompletion).toBeUndefined();
    meta?.action?.onClick();
    expect(api.openOsNotificationSettings).toHaveBeenCalledTimes(1);
  });

  it('keeps the card with a retry after a failed save', async () => {
    api.savePreferences.mockRejectedValueOnce(new Error('disk full'));
    render();
    act(() => {
      noteOsNotificationOfferCompletion(false);
    });
    click('os-notification-offer-enable');
    await flush();
    expect(card()).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="os-notification-offer-save-error"]',
      ),
    ).not.toBeNull();
    expect(api.optInToOsNotifications).not.toHaveBeenCalled();
  });
});
