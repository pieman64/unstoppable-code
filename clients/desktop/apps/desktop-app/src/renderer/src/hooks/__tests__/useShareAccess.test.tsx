/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface CapturedCloudSyncProps {
  onClose: () => void;
  title?: string;
  subtitle?: string;
  description?: string;
  guestBenefits?: boolean;
}

// Capture the props passed to the (heavy) CloudSyncModal without pulling in the
// full settings/account subtree. The holder name is `mock`-prefixed so the
// hoisted jest.mock factory may reference it.
const mockCloudSync: { last: CapturedCloudSyncProps | null } = { last: null };

jest.mock('@/components/shared/CloudSyncModal', () => ({
  CloudSyncModal: (props: CapturedCloudSyncProps): null => {
    mockCloudSync.last = props;
    return null;
  },
}));

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { isCanopyCloudConnected } from '@/lib/canopy-cloud';
import { useShareAccess, type ShareAccess } from '../useShareAccess';

const CONNECTED_ACCOUNT: CanopyCloudAccountPublicState = {
  hasApiKey: true,
  authMode: 'oauth',
  credentialSource: 'oauth_desktop',
  capabilities: ['teams-v1'],
  account: {
    id: 'account-1',
    name: 'Tester',
    email: 'user@example.test',
    role: 'DEVELOPER',
  },
  storageAvailable: true,
};

const DISCONNECTED_ACCOUNT: CanopyCloudAccountPublicState = {
  hasApiKey: false,
  authMode: null,
  credentialSource: null,
  capabilities: [],
  storageAvailable: true,
};

// A device-scoped guest: a real cloud credential (api key + resolved account)
// that `isCanopyCloudConnected` treats as connected, but which cannot publish to
// the shared registry until it signs in.
const GUEST_ACCOUNT: CanopyCloudAccountPublicState = {
  hasApiKey: true,
  authMode: 'guest',
  credentialSource: 'guest',
  capabilities: [],
  account: {
    id: 'guest-1',
    name: 'Guest',
    email: 'guest+abc@guest.canopy.invalid',
    role: 'DEVELOPER',
  },
  storageAvailable: true,
};

interface HookProbe {
  current: ShareAccess | null;
}

// Render the hook AND its gate modal so the mocked CloudSyncModal records props.
function HookHarness({ probe }: { probe: HookProbe }): JSX.Element | null {
  const access = useShareAccess();
  probe.current = access;
  return access.shareGateModal;
}

let loadAccountMock: jest.Mock;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mockCloudSync.last = null;
  loadAccountMock = jest.fn().mockResolvedValue(CONNECTED_ACCOUNT);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { loadCanopyCloudAccount: loadAccountMock },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useFeatureFlagsStore.setState({ snapshot: getDefaultFeatureFlagSnapshot() });
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('isCanopyCloudConnected', () => {
  it('is true only when an API key and a resolved account are present', () => {
    expect(isCanopyCloudConnected(CONNECTED_ACCOUNT)).toBe(true);
    expect(isCanopyCloudConnected(DISCONNECTED_ACCOUNT)).toBe(false);
    expect(
      isCanopyCloudConnected({ ...CONNECTED_ACCOUNT, account: undefined }),
    ).toBe(false);
    expect(isCanopyCloudConnected(null)).toBe(false);
  });
});

describe('useShareAccess', () => {
  it('signals cancellation only after the auto-resume account read settles', async () => {
    loadAccountMock.mockResolvedValue(DISCONNECTED_ACCOUNT);
    const probe: HookProbe = { current: null };
    act(() => root.render(<HookHarness probe={probe} />));
    const proceed = jest.fn();
    const cancelled = jest.fn();
    act(() => probe.current?.requestShare({}, proceed, cancelled));
    await flush();
    let finishRead: (account: CanopyCloudAccountPublicState) => void = () => {};
    loadAccountMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    act(() => mockCloudSync.last?.onClose());
    await flush();
    expect(cancelled).not.toHaveBeenCalled();
    act(() => finishRead(DISCONNECTED_ACCOUNT));
    await flush();
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(proceed).not.toHaveBeenCalled();
  });

  it('calls proceed immediately when the Cloud account is connected', async () => {
    const probe: HookProbe = { current: null };
    act(() => {
      root.render(<HookHarness probe={probe} />);
    });

    const proceed = jest.fn();
    act(() => {
      probe.current?.requestShare({ title: 'Sign in' }, proceed);
    });
    await flush();

    expect(proceed).toHaveBeenCalledTimes(1);
    expect(probe.current?.shareGateModal).toBeNull();
    expect(mockCloudSync.last).toBeNull();
  });

  it('proceeds for a connected account when feature flags are at their outage defaults', async () => {
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot('error'),
    });
    const probe: HookProbe = { current: null };
    act(() => {
      root.render(<HookHarness probe={probe} />);
    });

    const proceed = jest.fn();
    act(() => {
      probe.current?.requestShare({ title: 'Sign in' }, proceed);
    });
    await flush();

    expect(loadAccountMock).toHaveBeenCalled();
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(probe.current?.shareGateModal).toBeNull();
    expect(mockCloudSync.last).toBeNull();
  });

  it('opens the CloudSyncModal with context when disconnected and does not call proceed', async () => {
    loadAccountMock.mockResolvedValue(DISCONNECTED_ACCOUNT);
    const probe: HookProbe = { current: null };
    act(() => {
      root.render(<HookHarness probe={probe} />);
    });

    const proceed = jest.fn();
    act(() => {
      probe.current?.requestShare(
        {
          title: 'Sign in to share',
          description: 'Sign in to share this plan.',
        },
        proceed,
      );
    });
    await flush();

    expect(proceed).not.toHaveBeenCalled();
    expect(probe.current?.shareGateModal).not.toBeNull();
    expect(mockCloudSync.last?.title).toBe('Sign in to share');
    expect(mockCloudSync.last?.description).toBe('Sign in to share this plan.');
  });

  it('treats a guest as not connected: opens the CloudSyncModal instead of proceeding', async () => {
    loadAccountMock.mockResolvedValue(GUEST_ACCOUNT);
    const probe: HookProbe = { current: null };
    act(() => {
      root.render(<HookHarness probe={probe} />);
    });

    const proceed = jest.fn();
    act(() => {
      probe.current?.requestShare({ title: 'Sign in to share' }, proceed);
    });
    await flush();

    expect(proceed).not.toHaveBeenCalled();
    expect(probe.current?.shareGateModal).not.toBeNull();
    expect(mockCloudSync.last?.title).toBe('Sign in to share');
    expect(mockCloudSync.last?.guestBenefits).toBe(true);
  });

  it('does not auto-resume for a guest who did not upgrade before closing', async () => {
    loadAccountMock.mockResolvedValue(DISCONNECTED_ACCOUNT);
    const probe: HookProbe = { current: null };
    act(() => {
      root.render(<HookHarness probe={probe} />);
    });

    const proceed = jest.fn();
    act(() => {
      probe.current?.requestShare({ title: 'Sign in' }, proceed);
    });
    await flush();
    expect(mockCloudSync.last).not.toBeNull();

    // The user connected only as a guest, then closed the modal: still not
    // eligible to share, so proceed must NOT auto-resume.
    loadAccountMock.mockResolvedValue(GUEST_ACCOUNT);
    act(() => {
      mockCloudSync.last?.onClose();
    });
    await flush();

    expect(proceed).not.toHaveBeenCalled();
    expect(probe.current?.shareGateModal).toBeNull();
  });

  it('opens the CloudSyncModal when account loading fails and does not call proceed', async () => {
    loadAccountMock.mockRejectedValue(new Error('load failed'));
    const probe: HookProbe = { current: null };
    act(() => {
      root.render(<HookHarness probe={probe} />);
    });

    const proceed = jest.fn();
    act(() => {
      probe.current?.requestShare(
        { title: 'Sign in after load failure' },
        proceed,
      );
    });
    await flush();

    expect(proceed).not.toHaveBeenCalled();
    expect(probe.current?.shareGateModal).not.toBeNull();
    expect(mockCloudSync.last?.title).toBe('Sign in after load failure');
  });

  it('auto-resumes proceed after the user connects and closes the modal', async () => {
    loadAccountMock.mockResolvedValue(DISCONNECTED_ACCOUNT);
    const probe: HookProbe = { current: null };
    act(() => {
      root.render(<HookHarness probe={probe} />);
    });

    const proceed = jest.fn();
    act(() => {
      probe.current?.requestShare({ title: 'Sign in' }, proceed);
    });
    await flush();
    expect(mockCloudSync.last).not.toBeNull();

    // Simulate a successful connect, then close the modal.
    loadAccountMock.mockResolvedValue(CONNECTED_ACCOUNT);
    act(() => {
      mockCloudSync.last?.onClose();
    });
    await flush();

    expect(proceed).toHaveBeenCalledTimes(1);
    expect(probe.current?.shareGateModal).toBeNull();
  });
});
