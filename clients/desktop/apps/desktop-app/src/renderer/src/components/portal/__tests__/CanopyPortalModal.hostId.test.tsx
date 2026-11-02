/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyPortalState } from '@canopy/desktop-shared/types';
import { CanopyPortalModal } from '@/components/portal/CanopyPortalModal';
import { useCanopyPortalStore } from '@/stores/canopyPortalStore';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));

const HOST_CODE = 'k3m9p2x7qa';

Object.defineProperty(window, 'api', {
  configurable: true,
  value: {
    loadCanopyCloudAccount: jest.fn().mockResolvedValue({
      hasApiKey: true,
      capabilities: ['portal-v1'],
      storageAvailable: true,
      account: {
        id: 'acct-1',
        name: 'Alice',
        email: 'alice@example.com',
        role: 'ADMIN',
      },
    }),
    getCanopyCloudBaseUrl: jest
      .fn()
      .mockResolvedValue('https://cloud.example.test'),
    openAuthenticatedPortalPage: jest.fn().mockResolvedValue(true),
    browser: { openExternal: jest.fn().mockResolvedValue(undefined) },
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
    hostCode: null,
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

describe('CanopyPortalModal host ID', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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

  async function renderModal(state: CanopyPortalState): Promise<void> {
    useCanopyPortalStore.setState({ hydrated: true, state });
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

  it('shows the host ID, helper note, and no action when connected', async () => {
    await renderModal(
      buildState({
        status: 'active',
        connectionStatus: 'active',
        sessionId: 'sess-active',
        hostCode: HOST_CODE,
      }),
    );

    const row = document.querySelector('[data-testid="portal-host-id"]');
    const value = document.querySelector(
      '[data-testid="portal-host-id-value"]',
    );

    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('Host ID for agents');
    expect(value?.textContent).toBe(HOST_CODE);
    expect(row?.textContent).toContain(
      'It stays the same unless the app is reinstalled.',
    );
    expect(value?.tagName.toLowerCase()).toBe('code');
    expect(value?.classList.contains('font-mono')).toBe(true);
    expect(value?.classList.contains('select-all')).toBe(true);
    expect(row?.querySelector('button')).toBeNull();
  });

  it('hides the host ID when no code is available', async () => {
    await renderModal(
      buildState({
        status: 'active',
        connectionStatus: 'active',
        sessionId: 'sess-active',
      }),
    );

    expect(document.querySelector('[data-testid="portal-host-id"]')).toBeNull();
  });

  it('hides the host ID when the code is empty', async () => {
    await renderModal(
      buildState({
        status: 'active',
        connectionStatus: 'active',
        sessionId: 'sess-active',
        hostCode: '',
      }),
    );

    expect(document.querySelector('[data-testid="portal-host-id"]')).toBeNull();
  });

  it.each(['pending_auth', 'reconnecting'] as const)(
    'hides the host ID while status is %s',
    async (status) => {
      await renderModal(
        buildState({
          status,
          connectionStatus: status === 'pending_auth' ? 'pending' : status,
          sessionId: `sess-${status}`,
          hostCode: HOST_CODE,
        }),
      );

      expect(
        document.querySelector('[data-testid="portal-host-id"]'),
      ).toBeNull();
    },
  );
});
