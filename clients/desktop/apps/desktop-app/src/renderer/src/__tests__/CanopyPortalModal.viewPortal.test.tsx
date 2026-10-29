/**
 * @jest-environment jsdom
 */
// CAN-1272: the connected Remote Control modal must offer a "View web portal"
// button that opens `<cloud base URL>/portal` in the default browser.
// CAN-2357: the button also renders while pairing and deep-links to
// `/chat?pair=1` so the browser lands with the code-entry dialog open. These
// tests run in jsdom (unlike the SSR snapshots in CanopyPortalModal.test.tsx)
// because the portal URL is resolved in an effect.
import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyPortalState } from '@canopy/desktop-shared/types';
import { CanopyPortalModal } from '@/components/portal/CanopyPortalModal';
import { useCanopyPortalStore } from '@/stores/canopyPortalStore';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const useCurrentUiStateReporter = jest.fn();
jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (slice: string, state: object): void => {
    useCurrentUiStateReporter(slice, state);
  },
}));

jest.mock('@/components/shared/DialogModal', () => ({
  DialogModal: ({
    children,
    dataTestId,
  }: {
    children: ReactNode;
    dataTestId?: string;
  }): JSX.Element => <div data-testid={dataTestId}>{children}</div>,
}));

const loadCanopyCloudAccount = jest.fn();
const getCanopyCloudBaseUrl = jest.fn();
const openExternal = jest.fn();
const openAuthenticatedPortalPage = jest.fn();

Object.defineProperty(window, 'api', {
  configurable: true,
  value: {
    loadCanopyCloudAccount,
    getCanopyCloudBaseUrl,
    openAuthenticatedPortalPage,
    browser: { openExternal },
    canopyPortal: {
      getState: jest.fn(),
      start: jest.fn(),
      stop: jest.fn(),
      onStateChanged: (): (() => void) => () => undefined,
    },
  },
});

function buildState(overrides: Partial<CanopyPortalState>): CanopyPortalState {
  return {
    status: 'disabled',
    connectionStatus: 'inactive',
    sessionId: null,
    pairingCode: null,
    pairingCodeExpiresAt: null,
    machineName: null,
    activatedAt: null,
    lastSeenAt: null,
    lastErrorAt: null,
    error: null,
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function setPortalStatus(status: CanopyPortalState['status']): void {
  useCanopyPortalStore.setState({
    hydrated: true,
    state: buildState({ status }),
  });
}

describe('CanopyPortalModal — View Web Portal button', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      capabilities: ['portal-v1'],
      storageAvailable: true,
      account: {
        id: 'acct-1',
        name: 'Alice',
        email: 'alice@example.com',
        role: 'ADMIN',
      },
    });
    openExternal.mockResolvedValue(undefined);
    openAuthenticatedPortalPage.mockResolvedValue(true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    container.remove();
  });

  async function renderModal(): Promise<void> {
    await act(async () => {
      root.render(
        <CanopyPortalModal
          onClose={() => undefined}
          onOpenAccountSettings={() => undefined}
          onRequestSignIn={() => undefined}
        />,
      );
      await flushMicrotasks();
    });
  }

  function viewPortalButton(): HTMLButtonElement | null {
    return container.querySelector(
      '[data-testid="canopy-portal-view-web-portal"]',
    );
  }

  it('shows the button in the connected state and opens /portal authenticated', async () => {
    setPortalStatus('active');
    // A trailing slash on the configured base URL must not yield `//portal`.
    getCanopyCloudBaseUrl.mockResolvedValue('https://cloud.example.test/');

    await renderModal();

    const button = viewPortalButton();
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe('View web portal');

    await act(async () => {
      button?.click();
      await flushMicrotasks();
    });
    // Prefers the signed-in hand-off; the unauthenticated open is the fallback.
    expect(openAuthenticatedPortalPage).toHaveBeenCalledWith('/portal');
    expect(openExternal).not.toHaveBeenCalled();

    // App Advisor awareness: the reporter publishes the button visibility.
    expect(useCurrentUiStateReporter).toHaveBeenLastCalledWith(
      'canopyPortal.modal',
      expect.objectContaining({ viewPortalVisible: true }),
    );
  });

  it('falls back to the unauthenticated portal URL when the hand-off fails', async () => {
    setPortalStatus('active');
    getCanopyCloudBaseUrl.mockResolvedValue('https://cloud.example.test/');
    openAuthenticatedPortalPage.mockRejectedValue(new Error('unavailable'));

    await renderModal();

    await act(async () => {
      viewPortalButton()?.click();
      await flushMicrotasks();
    });
    expect(openExternal).toHaveBeenCalledWith({
      url: 'https://cloud.example.test/portal',
    });
  });

  it('shows the button while reconnecting', async () => {
    setPortalStatus('reconnecting');
    getCanopyCloudBaseUrl.mockResolvedValue('https://cloud.example.test');

    await renderModal();

    expect(viewPortalButton()).not.toBeNull();
  });

  it('hides the button when no cloud base URL is configured', async () => {
    setPortalStatus('active');
    getCanopyCloudBaseUrl.mockResolvedValue(null);

    await renderModal();

    expect(viewPortalButton()).toBeNull();
    expect(openExternal).not.toHaveBeenCalled();
    expect(useCurrentUiStateReporter).toHaveBeenLastCalledWith(
      'canopyPortal.modal',
      expect.objectContaining({ viewPortalVisible: false }),
    );
  });

  it('shows the button while pairing and deep-links to the code-entry dialog (CAN-2357)', async () => {
    setPortalStatus('pending_auth');
    getCanopyCloudBaseUrl.mockResolvedValue('https://cloud.example.test');

    await renderModal();

    const button = viewPortalButton();
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe('View web portal');

    await act(async () => {
      button?.click();
      await flushMicrotasks();
    });
    // `/portal` permanently redirects to `/chat` where the code form only
    // opens on click — the deep link lands with the pairing dialog open.
    expect(openAuthenticatedPortalPage).toHaveBeenCalledWith('/chat?pair=1');
    expect(openExternal).not.toHaveBeenCalled();

    expect(useCurrentUiStateReporter).toHaveBeenLastCalledWith(
      'canopyPortal.modal',
      expect.objectContaining({ viewPortalVisible: true }),
    );
  });

  it('falls back to the unauthenticated deep link when the hand-off fails while pairing', async () => {
    setPortalStatus('pending_auth');
    getCanopyCloudBaseUrl.mockResolvedValue('https://cloud.example.test/');
    openAuthenticatedPortalPage.mockRejectedValue(new Error('unavailable'));

    await renderModal();

    await act(async () => {
      viewPortalButton()?.click();
      await flushMicrotasks();
    });
    expect(openExternal).toHaveBeenCalledWith({
      url: 'https://cloud.example.test/chat?pair=1',
    });
  });

  it.each(['starting', 'stopping'] as const)(
    'hides the button in the %s state',
    async (status) => {
      setPortalStatus(status);
      getCanopyCloudBaseUrl.mockResolvedValue('https://cloud.example.test');

      await renderModal();

      expect(viewPortalButton()).toBeNull();
    },
  );
});
