/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import {
  useCanopyCloudAccountState,
  type CanopyCloudAccountState,
} from '../useCanopyCloudAccountState';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function account(
  name: string | null,
  overrides: Partial<CanopyCloudAccountPublicState> = {},
): CanopyCloudAccountPublicState {
  return {
    hasApiKey: name !== null,
    authMode: null,
    credentialSource: null,
    capabilities: [],
    storageAvailable: true,
    read: 'ok',
    account:
      name === null
        ? undefined
        : { id: `id-${name}`, name, email: `${name}@x.com`, role: 'DEVELOPER' },
    ...overrides,
  };
}

interface Deferred {
  readonly resolve: (value: CanopyCloudAccountPublicState) => void;
  readonly reject: (cause: Error) => void;
}

describe('useCanopyCloudAccountState', () => {
  let container: HTMLElement;
  let root: Root;
  let reads: Deferred[];
  let latest: CanopyCloudAccountState | null;

  function Probe(): JSX.Element {
    latest = useCanopyCloudAccountState();
    return <span />;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    reads = [];
    latest = null;
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadCanopyCloudAccount: jest.fn(
          () =>
            new Promise<CanopyCloudAccountPublicState>((resolve, reject) => {
              reads.push({ resolve, reject });
            }),
        ),
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, 'api');
  });

  async function settle(
    index: number,
    outcome: CanopyCloudAccountPublicState | Error,
  ): Promise<void> {
    await act(async () => {
      const read = reads[index];
      if (outcome instanceof Error) read?.reject(outcome);
      else read?.resolve(outcome);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
  }

  function mount(): void {
    act(() => root.render(<Probe />));
  }

  function changed(): void {
    act(() => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    });
  }

  it('reads on mount and rereads on every account-changed event', async () => {
    mount();
    expect(latest).toEqual({ account: null, readError: false });
    await settle(0, account('ada'));
    expect(latest?.account?.account?.name).toBe('ada');

    changed();
    expect(reads).toHaveLength(2);
    await settle(1, account('grace'));
    expect(latest?.account?.account?.name).toBe('grace');
  });

  it('lets the last issued read win when reads finish out of order', async () => {
    mount();
    await settle(0, account('ada'));
    changed();
    changed();
    // The sign-out read lands first; the slower earlier read is dropped.
    await settle(2, account(null));
    await settle(1, account('ada'));
    expect(latest?.account?.account).toBeUndefined();

    changed();
    await settle(3, account('grace'));
    changed();
    await settle(4, new Error('offline'));
    expect(latest?.account?.account?.name).toBe('grace');
  });

  it('holds the last known account through failed and non-conclusive reads, and recovers', async () => {
    mount();
    await settle(0, account('ada'));

    changed();
    await settle(1, new Error('ipc'));
    expect(latest).toMatchObject({ readError: false });
    expect(latest?.account?.account?.name).toBe('ada');

    changed();
    await settle(2, account(null, { read: 'error' }));
    expect(latest?.readError).toBe(true);
    expect(latest?.account?.account?.name).toBe('ada');

    changed();
    await settle(3, account('ada'));
    expect(latest?.readError).toBe(false);
  });

  it('replaces the account on a conclusive sign-out or account change', async () => {
    mount();
    await settle(0, account('ada'));
    changed();
    await settle(1, account('grace'));
    expect(latest?.account?.account?.id).toBe('id-grace');
    changed();
    await settle(2, account(null));
    expect(latest?.account?.account).toBeUndefined();
  });

  it('ignores a superseded error snapshot after a newer account read', async () => {
    mount();
    await settle(0, account('ada'));
    changed();
    changed();
    await settle(2, account('grace'));
    await settle(1, account(null, { read: 'error' }));
    expect(latest?.account?.account?.name).toBe('grace');
    expect(latest?.readError).toBe(false);

    changed();
    changed();
    await settle(4, account(null));
    await settle(3, new Error('late IPC failure'));
    expect(latest?.account?.account).toBeUndefined();
    expect(latest?.readError).toBe(false);
  });

  it('holds the account on unavailable reads without reporting a credential error', async () => {
    mount();
    await settle(0, account('ada'));
    changed();
    await settle(1, account(null, { read: 'unavailable' }));
    expect(latest?.account?.account?.name).toBe('ada');
    expect(latest?.readError).toBe(false);
  });

  it('issues two reads per event for the two extracted-account subscribers', async () => {
    act(() =>
      root.render(
        <>
          <Probe />
          <Probe />
        </>,
      ),
    );
    expect(reads).toHaveLength(2);
    changed();
    expect(reads).toHaveLength(4);
    await settle(2, account('ada'));
    await settle(3, account('ada'));
    await settle(0, account(null, { read: 'error' }));
    await settle(1, account(null, { read: 'error' }));
    expect(latest?.account?.account?.name).toBe('ada');
    expect(latest?.readError).toBe(false);
  });

  it('stops listening and ignores pending reads after unmount', async () => {
    mount();
    act(() => root.unmount());
    await settle(0, account('ada'));
    window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    expect(reads).toHaveLength(1);
    expect(latest?.account).toBeNull();
    root = createRoot(container);
  });
});
