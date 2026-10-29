/**
 * @jest-environment jsdom
 */
// CAN-2938: the Remote Control pairing state leads with a QR code that opens
// the web pairing page with the code in the URL fragment, names this machine,
// and keeps the 6-digit code as the manual fallback. The QR code follows the
// code through regeneration, and an expired code says so with a retry path.
import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyPortalState } from '@canopy/desktop-shared/types';
import { CanopyPortalModal } from '@/components/portal/CanopyPortalModal';
import { useCanopyPortalStore } from '@/stores/canopyPortalStore';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const toDataURL = jest.fn();
jest.mock('qrcode', () => ({
  __esModule: true,
  default: {
    toDataURL: (...args: unknown[]): unknown => toDataURL(...args),
  },
}));

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

Object.defineProperty(window, 'api', {
  configurable: true,
  value: {
    loadCanopyCloudAccount,
    getCanopyCloudBaseUrl,
    openAuthenticatedPortalPage: jest.fn(),
    browser: { openExternal: jest.fn() },
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
    machineName: 'Studio Mac',
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

describe('CanopyPortalModal — QR code pairing (CAN-2938)', () => {
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
    getCanopyCloudBaseUrl.mockResolvedValue('https://cloud.example.test/');
    toDataURL.mockImplementation((value: string) =>
      Promise.resolve(`data:image/png;base64,${btoa(value)}`),
    );
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

  async function renderWith(state: Partial<CanopyPortalState>): Promise<void> {
    useCanopyPortalStore.setState({ hydrated: true, state: buildState(state) });
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

  async function setState(state: Partial<CanopyPortalState>): Promise<void> {
    await act(async () => {
      useCanopyPortalStore.setState({
        hydrated: true,
        state: buildState(state),
      });
      await flushMicrotasks();
    });
  }

  function byTestId(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testId}"]`);
  }

  const PENDING = {
    status: 'pending_auth',
    connectionStatus: 'pending',
    sessionId: 'sess-pending',
    pairingCode: '123456',
    pairingCodeExpiresAt: '2026-10-02T00:10:00Z',
  } satisfies Partial<CanopyPortalState>;

  it('leads with a QR code for the web pairing page, naming this machine, with the code as fallback', async () => {
    await renderWith(PENDING);

    // The QR encodes the pairing page on the configured cloud origin, with
    // the code in the fragment (never the path or query).
    expect(toDataURL).toHaveBeenCalledWith(
      'https://cloud.example.test/portal/pair#code=123456',
      expect.objectContaining({ margin: 4 }),
    );
    const image = byTestId('canopy-portal-pairing-qr-image');
    expect(image?.getAttribute('src')).toBe(
      `data:image/png;base64,${btoa('https://cloud.example.test/portal/pair#code=123456')}`,
    );
    expect(image?.getAttribute('alt')).toContain('Studio Mac');
    expect(byTestId('canopy-portal-pairing-qr-instruction')?.textContent).toBe(
      "Scan with your phone's camera to connect Studio Mac.",
    );
    // The manual code stays available for when scanning is not.
    expect(byTestId('canopy-portal-pairing-code-value')?.textContent).toBe(
      '123456',
    );
    expect(
      byTestId('canopy-portal-pairing-manual-fallback')?.textContent,
    ).toContain('Or enter this code');
    // One home per fact: the QR instruction replaces the pending helper.
    expect(container.textContent).not.toContain(
      'Enter this code in Canopy Cloud.',
    );
    // App Advisor learns the QR is showing, never its URL or the code.
    expect(useCurrentUiStateReporter).toHaveBeenLastCalledWith(
      'canopyPortal.modal',
      expect.objectContaining({ pairingQrVisible: true }),
    );
    expect(JSON.stringify(useCurrentUiStateReporter.mock.calls)).not.toMatch(
      /123456|portal\/pair/,
    );
  });

  it('regenerates the QR code whenever the pairing code changes', async () => {
    await renderWith(PENDING);
    await setState({ ...PENDING, pairingCode: '987654' });

    expect(toDataURL).toHaveBeenLastCalledWith(
      'https://cloud.example.test/portal/pair#code=987654',
      expect.anything(),
    );
    expect(
      byTestId('canopy-portal-pairing-qr-image')?.getAttribute('src'),
    ).toBe(
      `data:image/png;base64,${btoa('https://cloud.example.test/portal/pair#code=987654')}`,
    );
  });

  it('never shows a QR code for a code that is no longer current', async () => {
    let resolveSecond: ((value: string) => void) | null = null;
    await renderWith(PENDING);
    toDataURL.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveSecond = resolve;
        }),
    );

    await setState({ ...PENDING, pairingCode: '987654' });

    // The previous code's QR must not linger while the new one encodes.
    expect(byTestId('canopy-portal-pairing-qr-image')).toBeNull();
    await act(async () => {
      resolveSecond?.('data:image/png;base64,new');
      await flushMicrotasks();
    });
    expect(
      byTestId('canopy-portal-pairing-qr-image')?.getAttribute('src'),
    ).toBe('data:image/png;base64,new');
  });

  it('falls back to "this computer" when the machine name is unknown', async () => {
    await renderWith({ ...PENDING, machineName: null });

    expect(byTestId('canopy-portal-pairing-qr-instruction')?.textContent).toBe(
      "Scan with your phone's camera to connect this computer.",
    );
  });

  it('keeps manual pairing when no cloud URL is configured or encoding fails', async () => {
    getCanopyCloudBaseUrl.mockResolvedValue(null);
    await renderWith(PENDING);

    expect(byTestId('canopy-portal-pairing-qr')).toBeNull();
    expect(byTestId('canopy-portal-pairing-code-value')?.textContent).toBe(
      '123456',
    );
    expect(container.textContent).toContain('Enter this code in Canopy Cloud.');
    expect(useCurrentUiStateReporter).toHaveBeenLastCalledWith(
      'canopyPortal.modal',
      expect.objectContaining({ pairingQrVisible: false }),
    );

    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    getCanopyCloudBaseUrl.mockResolvedValue('https://cloud.example.test');
    toDataURL.mockRejectedValue(new Error('encode failed'));
    await renderWith(PENDING);

    expect(byTestId('canopy-portal-pairing-qr')).toBeNull();
    expect(byTestId('canopy-portal-pairing-code-value')?.textContent).toBe(
      '123456',
    );
  });

  it('offers the QR code for another device while staying connected', async () => {
    await renderWith({
      status: 'active',
      connectionStatus: 'active',
      sessionId: 'sess-active',
      pairingCode: '654321',
      pairingCodeExpiresAt: '2026-10-02T00:10:00Z',
      activatedAt: '2026-10-02T00:00:00Z',
    });

    expect(toDataURL).toHaveBeenCalledWith(
      'https://cloud.example.test/portal/pair#code=654321',
      expect.anything(),
    );
    expect(byTestId('canopy-portal-pairing-qr-image')).not.toBeNull();
    expect(
      byTestId('canopy-portal-pair-another-device-helper')?.textContent,
    ).toBe(
      'Scan the QR code or enter the code on the other device. Devices already connected stay connected.',
    );
  });

  it('names this machine once connected', async () => {
    await renderWith({
      status: 'active',
      connectionStatus: 'active',
      sessionId: 'sess-active',
      activatedAt: '2026-10-02T00:00:00Z',
    });

    expect(byTestId('canopy-portal-status-row')?.textContent).toContain(
      'Studio Mac is connected.',
    );
    expect(byTestId('canopy-portal-pairing-qr')).toBeNull();
  });

  it('uses the sentence-start stand-in when the machine name is blank', async () => {
    await renderWith({
      status: 'active',
      connectionStatus: 'active',
      sessionId: 'sess-active',
      activatedAt: '2026-10-02T00:00:00Z',
      machineName: '   ',
    });

    const text = byTestId('canopy-portal-status-row')?.textContent ?? '';
    expect(text).toContain('This computer is connected.');
    expect(text).not.toContain('this computer is connected.');
  });

  it('says the QR code expired and keeps Enable as the way to get a new one', async () => {
    await renderWith({
      status: 'disabled',
      error: 'The QR code expired before a device connected.',
      lastErrorAt: '2026-10-02T00:10:00Z',
    });

    const notice = byTestId('canopy-portal-pairing-expired');
    expect(notice?.textContent).toContain(
      'The QR code expired before a device connected.',
    );
    expect(notice?.textContent).toContain(
      'Enable Remote Control to get a new QR code.',
    );
    expect(byTestId('canopy-portal-enable')).not.toBeNull();
  });
});
