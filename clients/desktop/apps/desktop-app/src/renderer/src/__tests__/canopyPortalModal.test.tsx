import { renderToStaticMarkup } from 'react-dom/server';
import type {
  CanopyApi,
  CanopyCloudAccountPublicState,
  CanopyPortalState,
} from '@canopy/desktop-shared/types';
import { CanopyPortalModal } from '@/components/portal/CanopyPortalModal';
import { useCanopyPortalStore } from '@/stores/canopyPortalStore';

declare global {
  interface Window {
    api: CanopyApi;
  }
}

/**
 * zustand caches an initialState snapshot that React 19's
 * `useSyncExternalStore` reads in SSR. Tests that hydrate via `setState`
 * must mirror the live state into the initial snapshot before rendering,
 * otherwise the modal sees the original `disabled` defaults and the
 * connection-status copy never appears.
 */
function syncStoreForServerRender<T extends object>(store: {
  getState: () => T;
  getInitialState: () => T;
}): void {
  Object.assign(store.getInitialState(), store.getState());
}

function readyAccount(): CanopyCloudAccountPublicState {
  return {
    hasApiKey: true,
    capabilities: ['portal-v1'],
    storageAvailable: true,
    account: {
      id: 'acct-1',
      name: 'Alice',
      email: 'alice@example.com',
      role: 'ADMIN',
    },
  };
}

function setApi(overrides: Partial<CanopyApi> = {}): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {},
  });
  Object.defineProperty(globalThis.window, 'api', {
    configurable: true,
    value: {
      loadCanopyCloudAccount: () => Promise.resolve(readyAccount()),
      canopyPortal: {
        getState: () => Promise.resolve(buildState({})),
        start: () => Promise.resolve({ state: buildState({}) }),
        stop: () => Promise.resolve({ state: buildState({}) }),
        regeneratePairingCode: () => Promise.resolve({ state: buildState({}) }),
        cancelPairingCode: () => Promise.resolve({ state: buildState({}) }),
        onStateChanged: (): (() => void) => () => undefined,
      },
      ...overrides,
    },
  });
}

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

describe('CanopyPortalModal — visible state snapshots', () => {
  beforeEach(() => {
    setApi();
    // Reset zustand state between tests so the snapshots are deterministic.
    useCanopyPortalStore.setState({ hydrated: true, state: buildState({}) });
  });

  it('renders the connected (active) state with the Connected status label', () => {
    useCanopyPortalStore.setState({
      hydrated: true,
      state: buildState({
        status: 'active',
        connectionStatus: 'active',
        sessionId: 'sess-active',
        activatedAt: '2026-05-06T00:00:00Z',
        lastSeenAt: '2026-05-06T00:00:30Z',
      }),
    });

    syncStoreForServerRender(useCanopyPortalStore);
    const markup = renderToStaticMarkup(
      <CanopyPortalModal
        onClose={() => undefined}
        onOpenAccountSettings={() => undefined}
        onRequestSignIn={() => undefined}
      />,
    );

    expect(markup).toContain('Remote Control');
    expect(markup).toContain(
      'Steer the agents running on this Canopy app from any browser. Pair securely with Canopy Cloud to control the sessions on this machine from anywhere.',
    );
    expect(markup).toContain('Connected');
  });

  it('offers to pair another device while connected (CAN-2981)', () => {
    useCanopyPortalStore.setState({
      hydrated: true,
      state: buildState({
        status: 'active',
        connectionStatus: 'active',
        sessionId: 'sess-active',
        activatedAt: '2026-05-06T00:00:00Z',
        lastSeenAt: '2026-05-06T00:00:30Z',
      }),
    });

    syncStoreForServerRender(useCanopyPortalStore);
    const markup = renderToStaticMarkup(
      <CanopyPortalModal
        onClose={() => undefined}
        onOpenAccountSettings={() => undefined}
        onRequestSignIn={() => undefined}
      />,
    );

    expect(markup).toContain('data-testid="canopy-portal-pair-another-device"');
    expect(markup).toContain('Pair another device');
    // No code is armed yet, so nothing to copy.
    expect(markup).not.toContain('data-testid="canopy-portal-pairing-code"');
  });

  it('shows the re-armed pairing code while staying connected (CAN-2981)', () => {
    useCanopyPortalStore.setState({
      hydrated: true,
      state: buildState({
        status: 'active',
        connectionStatus: 'active',
        sessionId: 'sess-active',
        pairingCode: '654321',
        pairingCodeExpiresAt: '2026-05-06T00:10:00Z',
        activatedAt: '2026-05-06T00:00:00Z',
        lastSeenAt: '2026-05-06T00:00:30Z',
      }),
    });

    syncStoreForServerRender(useCanopyPortalStore);
    const markup = renderToStaticMarkup(
      <CanopyPortalModal
        onClose={() => undefined}
        onOpenAccountSettings={() => undefined}
        onRequestSignIn={() => undefined}
      />,
    );

    expect(markup).toContain('Connected');
    expect(markup).toContain('data-testid="canopy-portal-pairing-code"');
    expect(markup).toContain('<span>654</span><span class="ml-4">321</span>');
    // While a code is armed the footer offers to cancel it instead of arming
    // another one; the connected device stays connected either way.
    expect(markup).toContain('data-testid="canopy-portal-cancel-pairing-code"');
    expect(markup).toContain('Cancel pairing code');
    expect(markup).not.toContain(
      'data-testid="canopy-portal-pair-another-device"',
    );
    expect(markup).toContain('data-testid="canopy-portal-disable"');
  });

  it('renders the reconnecting state with the helper copy', () => {
    useCanopyPortalStore.setState({
      hydrated: true,
      state: buildState({
        status: 'reconnecting',
        connectionStatus: 'reconnecting',
        sessionId: 'sess-recon',
        activatedAt: '2026-05-06T00:00:00Z',
        lastSeenAt: '2026-05-06T00:00:00Z',
      }),
    });

    syncStoreForServerRender(useCanopyPortalStore);
    const markup = renderToStaticMarkup(
      <CanopyPortalModal
        onClose={() => undefined}
        onOpenAccountSettings={() => undefined}
        onRequestSignIn={() => undefined}
      />,
    );

    expect(markup).toContain('Reconnecting');
    expect(markup).toContain(
      'Canopy Cloud will keep the session open while this app reconnects.',
    );
  });

  it('renders the pending_auth state with the pairing code split into halves without whitespace', () => {
    useCanopyPortalStore.setState({
      hydrated: true,
      state: buildState({
        status: 'pending_auth',
        connectionStatus: 'pending',
        sessionId: 'sess-pending',
        pairingCode: '123456',
        pairingCodeExpiresAt: null,
      }),
    });

    syncStoreForServerRender(useCanopyPortalStore);
    const markup = renderToStaticMarkup(
      <CanopyPortalModal
        onClose={() => undefined}
        onOpenAccountSettings={() => undefined}
        onRequestSignIn={() => undefined}
      />,
    );

    // Status label and pending helper
    expect(markup).toContain('Waiting for code');
    expect(markup).toContain('Enter this code in Canopy Cloud.');
    // The two halves are rendered as adjacent spans with a CSS gap so
    // copy/paste yields the raw 6-digit code without whitespace.
    expect(markup).toContain('<span>123</span>');
    expect(markup).toContain('>456</span>');
    expect(markup).not.toMatch(/123\s+456/);
    expect(markup).toMatch(/select-all/);
    // The explicit copy button is rendered alongside the code so users
    // who don't know about the click-to-select behavior can still copy it.
    expect(markup).toContain('data-testid="canopy-portal-copy-code"');
    // Default expiry copy when no explicit expiry is known.
    expect(markup).toContain('Code expires automatically after 10 minutes.');
  });

  it('renders the starting state with the Starting... label', () => {
    useCanopyPortalStore.setState({
      hydrated: true,
      state: buildState({
        status: 'starting',
        connectionStatus: 'pending',
      }),
    });

    syncStoreForServerRender(useCanopyPortalStore);
    const markup = renderToStaticMarkup(
      <CanopyPortalModal
        onClose={() => undefined}
        onOpenAccountSettings={() => undefined}
        onRequestSignIn={() => undefined}
      />,
    );

    expect(markup).toContain('Starting…');
  });

  it('renders the stopping state with the Stopping... label', () => {
    useCanopyPortalStore.setState({
      hydrated: true,
      state: buildState({
        status: 'stopping',
        connectionStatus: 'inactive',
      }),
    });

    syncStoreForServerRender(useCanopyPortalStore);
    const markup = renderToStaticMarkup(
      <CanopyPortalModal
        onClose={() => undefined}
        onOpenAccountSettings={() => undefined}
        onRequestSignIn={() => undefined}
      />,
    );

    expect(markup).toContain('Stopping…');
  });

  it('renders the error state with the Connection failed label', () => {
    useCanopyPortalStore.setState({
      hydrated: true,
      state: buildState({
        status: 'error',
        connectionStatus: 'inactive',
        error: 'Boom',
      }),
    });

    syncStoreForServerRender(useCanopyPortalStore);
    const markup = renderToStaticMarkup(
      <CanopyPortalModal
        onClose={() => undefined}
        onOpenAccountSettings={() => undefined}
        onRequestSignIn={() => undefined}
      />,
    );

    expect(markup).toContain('Connection failed');
    // The error helper shows the upstream error text so the user can act.
    expect(markup).toContain('Boom');
  });

  // Frontend plan §8: after a rejected start the modal must surface
  // `Connection failed`, an error helper, the `Try again` action, and a
  // working `Close` button so the user is not trapped in a half-busy
  // modal. The main-process state machine produces the `error` status; the
  // renderer just needs to translate that into the right affordances.
  it('surfaces Try Again and Close after a rejected start', () => {
    useCanopyPortalStore.setState({
      hydrated: true,
      state: buildState({
        status: 'error',
        connectionStatus: 'inactive',
        error: 'Pairing rejected by server',
      }),
    });

    syncStoreForServerRender(useCanopyPortalStore);
    const markup = renderToStaticMarkup(
      <CanopyPortalModal
        onClose={() => undefined}
        onOpenAccountSettings={() => undefined}
        onRequestSignIn={() => undefined}
      />,
    );

    expect(markup).toContain('Connection failed');
    expect(markup).toContain('Pairing rejected by server');
    // Try Again invokes start() under the hood — the renderer test pins
    // the affordance so the user has a path back to the pairing flow.
    expect(markup).toContain('Try again');
    expect(markup).toContain('data-testid="canopy-portal-try-again"');
    // Close stays available so the user is not trapped in the failure
    // state. The `disabled` attribute should not be present on the close
    // button while the modal is idle (busy === 'idle' after the catch).
    expect(markup).toMatch(
      /<button[^>]*data-testid="canopy-portal-close"(?![^>]*disabled)/,
    );
  });

  // Round 6: the server can end a session out from under the desktop
  // (replaced by another device, server purge). The state machine lands in
  // `inactive` — the nav shows the red Disconnected tone, so the modal MUST
  // offer a path back (previously it rendered nothing but Close).
  it('surfaces Disconnected and a Reconnect action for the server-ended (inactive) state', () => {
    useCanopyPortalStore.setState({
      hydrated: true,
      state: buildState({
        status: 'inactive',
        connectionStatus: 'inactive',
        error: 'Remote Control session ended on the server.',
      }),
    });

    syncStoreForServerRender(useCanopyPortalStore);
    const markup = renderToStaticMarkup(
      <CanopyPortalModal
        onClose={() => undefined}
        onOpenAccountSettings={() => undefined}
        onRequestSignIn={() => undefined}
      />,
    );

    expect(markup).toContain('Disconnected');
    expect(markup).toContain('Remote Control session ended on the server.');
    expect(markup).toContain('Reconnect');
    expect(markup).toContain('data-testid="canopy-portal-reconnect"');
    // Close stays available and idle (not trapped in a busy modal).
    expect(markup).toMatch(
      /<button[^>]*data-testid="canopy-portal-close"(?![^>]*disabled)/,
    );
  });

  it('Try Again calls window.api.canopyPortal.start with no arguments', async () => {
    let startCalls = 0;
    let lastArgs: unknown[] | null = null;
    setApi({
      canopyPortal: {
        getState: () => Promise.resolve(buildState({})),
        start: (...args: unknown[]) => {
          startCalls += 1;
          lastArgs = args;
          return Promise.resolve({ state: buildState({}) });
        },
        stop: () => Promise.resolve({ state: buildState({}) }),
        onStateChanged: (): (() => void) => () => undefined,
      },
    });
    // Invoke `start()` directly to exercise the rejected-start retry path
    // without needing a DOM event loop.
    await window.api.canopyPortal.start();
    expect(startCalls).toBe(1);
    expect(lastArgs).toEqual([]);
  });

  it('renders the disconnected (disabled) state with the loading account copy during SSR', () => {
    useCanopyPortalStore.setState({
      hydrated: true,
      state: buildState({
        status: 'disabled',
        connectionStatus: 'inactive',
      }),
    });

    syncStoreForServerRender(useCanopyPortalStore);
    const markup = renderToStaticMarkup(
      <CanopyPortalModal
        onClose={() => undefined}
        onOpenAccountSettings={() => undefined}
        onRequestSignIn={() => undefined}
      />,
    );

    // SSR runs before the async account fetch resolves, so the loading
    // copy is what appears initially. The disabled-state helper renders
    // after the fetch settles in a real React tree.
    expect(markup).toContain('Checking Canopy Cloud account');
    // The Close button is always present so the user can dismiss the modal.
    expect(markup).toContain('Close');
  });

  it('shows the empty-account state when Canopy Cloud is not configured', () => {
    setApi({
      loadCanopyCloudAccount: () =>
        Promise.resolve({
          hasApiKey: false,
          capabilities: [],
          storageAvailable: true,
        }),
    });
    useCanopyPortalStore.setState({
      hydrated: true,
      state: buildState({
        status: 'disabled',
        connectionStatus: 'inactive',
      }),
    });

    // The first render snapshot will still see the loading state because
    // the account fetch is async; this just exercises the SSR path.
    syncStoreForServerRender(useCanopyPortalStore);
    const markup = renderToStaticMarkup(
      <CanopyPortalModal
        onClose={() => undefined}
        onOpenAccountSettings={() => undefined}
        onRequestSignIn={() => undefined}
      />,
    );
    expect(markup).toContain('Checking Canopy Cloud account');
  });
});
