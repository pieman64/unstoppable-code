/**
 * @jest-environment jsdom
 */
// CAN-3119 (F2): the Remote Control modal shows the live pairing code.
// `DialogModal` records its card, so the code carries its own block. This pins
// that the code renders in a blocked region of the recorded card.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyPortalState } from '@canopy/desktop-shared/types';
import { CanopyPortalModal } from '@/components/portal/CanopyPortalModal';
import { useCanopyPortalStore } from '@/stores/canopyPortalStore';
import { expectBlockedInRecordedDialogCard } from '@/test-utils/replay';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));

const PAIRING_CODE = '482913';

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

describe('CanopyPortalModal session replay', () => {
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

  it('blocks the pairing code inside the recorded DialogModal card', async () => {
    useCanopyPortalStore.setState({
      hydrated: true,
      state: buildState({
        status: 'pending_auth',
        connectionStatus: 'pending',
        sessionId: 'sess-pending',
        pairingCode: PAIRING_CODE,
        pairingCodeExpiresAt: '2026-05-06T00:10:00Z',
      }),
    });

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

    const code = document.querySelector(
      '[data-testid="canopy-portal-pairing-code-value"]',
    );
    if (code === null) throw new Error('Pairing code not rendered');
    expect(code.textContent).toBe(PAIRING_CODE);
    expect(container.contains(code)).toBe(false);
    const card = expectBlockedInRecordedDialogCard(code);
    expect(card.getAttribute('data-testid')).toBe('canopy-portal-modal');
  });
});
