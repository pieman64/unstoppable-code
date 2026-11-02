/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  useCanopyCloudConnected,
  useTryItAccount,
  useCanopyCloudCredentialUsable,
} from '../useCanopyCloudConnected';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface Probe {
  current: boolean | null;
}

function Harness({ probe }: { probe: Probe }): JSX.Element {
  probe.current = useCanopyCloudConnected();
  return <></>;
}

function UsableHarness({ probe }: { probe: Probe }): JSX.Element {
  probe.current = useCanopyCloudCredentialUsable();
  return <></>;
}

function account(
  overrides: Partial<CanopyCloudAccountPublicState>,
): CanopyCloudAccountPublicState {
  return {
    hasApiKey: false,
    authMode: null,
    credentialSource: null,
    capabilities: [],
    storageAvailable: true,
    account: { id: 'a', name: 'A', email: 'a@example.com', role: 'DEVELOPER' },
    ...overrides,
  };
}

async function renderHook(
  acct: CanopyCloudAccountPublicState,
  Component: (props: { probe: Probe }) => JSX.Element = Harness,
  refreshAccounts: CanopyCloudAccountPublicState[] = [],
): Promise<{ probe: Probe; cleanup: () => void }> {
  const loadCanopyCloudAccount = jest.fn().mockResolvedValueOnce(acct);
  for (const refreshAccount of refreshAccounts) {
    loadCanopyCloudAccount.mockResolvedValueOnce(refreshAccount);
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadCanopyCloudAccount,
    },
  });
  const probe: Probe = { current: null };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<Component probe={probe} />);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
  return {
    probe,
    cleanup: (): void => {
      act(() => root.unmount());
      container.remove();
      Reflect.deleteProperty(window, 'api');
    },
  };
}

describe('useCanopyCloudConnected', () => {
  it('reports a real oauth account as connected', async () => {
    const { probe, cleanup } = await renderHook(
      account({ hasApiKey: true, credentialSource: 'oauth_desktop' }),
    );
    expect(probe.current).toBe(true);
    cleanup();
  });

  it('reports a guest as not connected', async () => {
    const { probe, cleanup } = await renderHook(
      account({
        hasApiKey: true,
        authMode: 'guest',
        credentialSource: 'guest',
      }),
    );
    expect(probe.current).toBe(false);
    cleanup();
  });

  it('reports a normalized guest (authMode-only) as not connected', async () => {
    // `authMode: 'guest'` with a normalized `credentialSource: 'manual'` must
    // not read as a manual connection (CAN-936).
    const { probe, cleanup } = await renderHook(
      account({
        hasApiKey: true,
        authMode: 'guest',
        credentialSource: 'manual',
      }),
    );
    expect(probe.current).toBe(false);
    cleanup();
  });
});

describe('useCanopyCloudCredentialUsable', () => {
  it('reports a real oauth account as usable', async () => {
    const { probe, cleanup } = await renderHook(
      account({ hasApiKey: true, credentialSource: 'oauth_desktop' }),
      UsableHarness,
    );
    expect(probe.current).toBe(true);
    cleanup();
  });

  // A guest device credential authenticates like a real account, so cloud work
  // (telemetry uploads) genuinely proceeds — the opposite verdict from
  // `useCanopyCloudConnected`, which gates real-identity surfaces.
  it('reports a guest device credential as usable', async () => {
    const { probe, cleanup } = await renderHook(
      account({
        hasApiKey: true,
        authMode: 'guest',
        credentialSource: 'guest',
      }),
      UsableHarness,
    );
    expect(probe.current).toBe(true);
    cleanup();
  });

  it('reports a degraded or absent credential as unusable', async () => {
    const { probe, cleanup } = await renderHook(
      { ...account({}), read: 'error', account: undefined },
      UsableHarness,
    );
    expect(probe.current).toBe(false);
    cleanup();
  });

  it('preserves a usable credential across an inconclusive refresh', async () => {
    const { probe, cleanup } = await renderHook(
      account({ hasApiKey: true, credentialSource: 'oauth_desktop' }),
      UsableHarness,
      [{ ...account({}), read: 'error', account: undefined }],
    );
    expect(probe.current).toBe(true);

    await act(async () => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });

    expect(probe.current).toBe(true);
    cleanup();
  });

  it('reports a conclusive sign-out after a usable credential', async () => {
    const { probe, cleanup } = await renderHook(
      account({ hasApiKey: true, credentialSource: 'oauth_desktop' }),
      UsableHarness,
      [account({ read: 'ok', account: undefined })],
    );
    expect(probe.current).toBe(true);

    await act(async () => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });

    expect(probe.current).toBe(false);
    cleanup();
  });
});

describe('Try it unresolved account', () => {
  it('keeps activation disabled when the account read is inconclusive', async () => {
    let status: string | undefined;
    function TryItProbe(): JSX.Element {
      status = useTryItAccount().status;
      return <></>;
    }
    const { cleanup } = await renderHook(
      account({ read: 'error', account: undefined }),
      TryItProbe,
    );
    expect(status).toBe('loading');
    cleanup();
  });
});
