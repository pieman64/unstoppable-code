/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type * as AccountHooks from '../useCanopyCloudConnected';
import {
  useTryItAccount,
  type TryItAccountState,
} from '../useCanopyCloudConnected';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { importChatAttachments } from '@/lib/chatAttachments';
import { useDesktopFilesGuestGate } from '../useDesktopFilesGuestGate';
import type { CloudConnectGateContext } from '@/stores/cloudConnectGateStore';
import { ATTACHMENT_SIGN_IN_COPY } from '@canopy/ui-app/guest-files';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface HookHarness<P, R> {
  readonly result: { readonly current: R };
  readonly rerender: (props?: P) => void;
  readonly unmount: () => void;
}

/** Minimal hook harness over `createRoot`, matching the repo's RTL-free tests. */
function renderHook<P, R>(
  hook: (props: P) => R,
  initialProps: P,
): HookHarness<P, R> {
  const root = createRoot(document.createElement('div'));
  let latest: { readonly value: R } | null = null;
  let props = initialProps;
  function Probe({ value }: { readonly value: P }): null {
    latest = { value: hook(value) };
    return null;
  }
  act(() => root.render(<Probe value={props} />));
  return {
    result: {
      get current(): R {
        if (latest === null) throw new Error('hook has not rendered');
        return latest.value;
      },
    },
    rerender: (next?: P): void => {
      if (next !== undefined) props = next;
      act(() => root.render(<Probe value={props} />));
    },
    unmount: (): void => {
      act(() => root.unmount());
    },
  };
}

let mockAccount: TryItAccountState = { status: 'loading', accountId: null };
const mockRequestConnect = jest.fn<
  void,
  [CloudConnectGateContext, () => void]
>();
jest.mock('../useCanopyCloudConnected', () => ({
  useTryItAccount: jest.fn((): TryItAccountState => mockAccount),
}));
jest.mock('@/stores/cloudConnectGateStore', () => ({
  useCloudConnectGateStore: {
    getState: (): { requestConnect: typeof mockRequestConnect } => ({
      requestConnect: mockRequestConnect,
    }),
  },
}));

beforeEach(() => {
  mockRequestConnect.mockReset();
  jest.mocked(useTryItAccount).mockImplementation(() => mockAccount);
});

it.each(['guest'] as const)(
  'intercepts %s file gestures with canonical copy and no retained continuation',
  (status) => {
    mockAccount = { status, accountId: null };
    const { result, rerender } = renderHook(
      () => useDesktopFilesGuestGate(),
      undefined,
    );
    const intercept = result.current.interceptAttachment;
    act(() => expect(intercept()).toBe(true));
    expect(mockRequestConnect).toHaveBeenCalledWith(
      {
        title: ATTACHMENT_SIGN_IN_COPY.title,
        description: ATTACHMENT_SIGN_IN_COPY.body,
        subtitle: null,
      },
      expect.any(Function),
    );
    expect(mockRequestConnect.mock.calls[0]?.[1]()).toBeUndefined();
    rerender();
    expect(result.current.interceptAttachment).toBe(intercept);
    expect(result.current.captureAccess()()).toBe(false);
  },
);

it('blocks initial loading gestures without asking the user to sign in', () => {
  mockAccount = { status: 'loading', accountId: null };
  const { result } = renderHook(() => useDesktopFilesGuestGate(), undefined);
  expect(result.current.interceptAttachment()).toBe(true);
  expect(mockRequestConnect).not.toHaveBeenCalled();
});

it('preserves a pending import through a real same-account refresh', async () => {
  const realHook = jest.requireActual<typeof AccountHooks>(
    '../useCanopyCloudConnected',
  ).useTryItAccount;
  jest.mocked(useTryItAccount).mockImplementation(realHook);
  const account = {
    hasApiKey: true,
    credentialSource: 'oauth_desktop',
    capabilities: [],
    storageAvailable: true,
    account: { id: 'a', name: 'A', email: 'a@example.com', role: 'DEVELOPER' },
  };
  let finishRefresh: ((value: typeof account) => void) | undefined;
  const loadAccount = jest
    .fn()
    .mockResolvedValueOnce(account)
    .mockImplementationOnce(
      () =>
        new Promise<typeof account>((resolve) => {
          finishRefresh = resolve;
        }),
    );
  const attachment = { filename: 'a.txt', absolutePath: '/wt/a.txt' };
  let finishImport:
    | ((value: { attachments: (typeof attachment)[] }) => void)
    | undefined;
  const importAttachments = jest.fn(
    () =>
      new Promise<{ attachments: (typeof attachment)[] }>((resolve) => {
        finishImport = resolve;
      }),
  );
  const listAttachments = jest.fn().mockResolvedValue([attachment]);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadCanopyCloudAccount: loadAccount,
      importWorktreeAttachments: importAttachments,
      workspaceItems: { listAttachments },
    },
  });
  const { result } = renderHook(
    () => useDesktopFilesGuestGate('proj/wt'),
    undefined,
  );
  await act(async () => {
    await Promise.resolve();
  });
  const isCurrent = result.current.captureAccess();
  expect(isCurrent()).toBe(true);
  const pending = importChatAttachments(
    { projectId: 'proj', worktreeId: 'wt' },
    [],
    undefined,
    isCurrent,
  );
  act(() => {
    window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
  });
  expect(result.current.status).toBe('signed-in');
  expect(result.current.interceptAttachment()).toBe(false);
  expect(mockRequestConnect).not.toHaveBeenCalled();
  await act(async () => {
    finishRefresh?.(account);
    await Promise.resolve();
  });
  expect(isCurrent()).toBe(true);
  finishImport?.({ attachments: [attachment] });
  await expect(pending).resolves.toEqual([attachment]);
  expect(listAttachments).toHaveBeenCalledTimes(1);
});

it('permits confirmed signed-in gestures and invalidates asynchronous work across account/scope transitions and unmount', () => {
  mockAccount = { status: 'signed-in', accountId: 'account:a' };
  const { result, rerender, unmount } = renderHook(
    ({ scope }: { readonly scope: string }) => useDesktopFilesGuestGate(scope),
    { scope: 'chat:a' },
  );
  expect(result.current.interceptAttachment()).toBe(false);
  expect(mockRequestConnect).not.toHaveBeenCalled();
  const initialGate = result.current;
  rerender({ scope: 'chat:a' });
  expect(result.current).toBe(initialGate);
  const beforeSignOut = result.current.captureAccess();
  expect(beforeSignOut()).toBe(true);
  mockAccount = { status: 'guest', accountId: 'guest' };
  rerender({ scope: 'chat:a' });
  mockAccount = { status: 'signed-in', accountId: 'account:a' };
  rerender({ scope: 'chat:a' });
  expect(beforeSignOut()).toBe(false);
  const beforeScopeChange = result.current.captureAccess();
  rerender({ scope: 'chat:b' });
  expect(result.current).not.toBe(initialGate);
  rerender({ scope: 'chat:a' });
  expect(beforeScopeChange()).toBe(false);
  const beforeAccountChange = result.current.captureAccess();
  mockAccount = { status: 'signed-in', accountId: 'account:b' };
  rerender({ scope: 'chat:a' });
  expect(beforeAccountChange()).toBe(false);
  const beforeUnmount = result.current.captureAccess();
  unmount();
  expect(beforeUnmount()).toBe(false);
});
