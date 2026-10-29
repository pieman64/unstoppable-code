/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodexLoginState } from '@canopy/desktop-shared/types';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { CodexLoginModal } from '../CodexLoginModal';

const mockInitialize = jest.fn(() => Promise.resolve());

jest.mock('@/stores/observabilityStore', () => ({
  useObservabilityStore: (selector: (state: unknown) => unknown): unknown =>
    selector({
      usage: { providers: [], accountSnapshots: [] },
      initialize: mockInitialize,
    }),
}));
jest.mock('@/components/pages/usage/OtherAccountSnapshots', () => ({
  computeRelevantAccountSnapshots: jest.fn(() => []),
  OtherAccountSnapshotsPanel: jest.fn(() => null),
}));
jest.mock('@/hooks/useCodexAuthStatus', () => ({
  invalidateCodexAuthStatusCache: jest.fn(),
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve = (value: T): void => {
    void value;
    throw new Error('Deferred promise was not initialized.');
  };
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('CodexLoginModal', () => {
  let container: HTMLElement;
  let root: Root;
  let originalApiDescriptor: PropertyDescriptor | undefined;
  let start: jest.Mock;
  let cancel: jest.Mock;
  let onClose: jest.Mock;

  beforeEach(() => {
    originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
    start = jest.fn();
    cancel = jest.fn().mockResolvedValue({
      attemptId: 'attempt-1',
      phase: 'complete',
      activeWorkCount: 0,
      outcome: 'cancelled',
    });
    onClose = jest.fn();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        codexLogin: {
          start,
          cancel,
          retryVerification: jest.fn(),
          openBrowser: jest.fn().mockResolvedValue(undefined),
          onState: jest.fn(() => jest.fn()),
        },
      },
    });
    useCurrentUiStateStore.setState({ revision: 0, slices: {} });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) act(() => root.unmount());
    container.remove();
    if (originalApiDescriptor)
      Object.defineProperty(window, 'api', originalApiDescriptor);
    else Reflect.deleteProperty(window, 'api');
  });

  it('cancels after an in-flight start resolves when dismissed immediately', async () => {
    const pending = deferred<CodexLoginState>();
    start.mockReturnValue(pending.promise);
    await act(async () => {
      root = createRoot(container);
      root.render(<CodexLoginModal onClose={onClose} />);
      await Promise.resolve();
    });

    act(() =>
      document
        .querySelector<HTMLButtonElement>('[data-testid="auth-login-cancel"]')
        ?.click(),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve({
        attemptId: 'attempt-1',
        phase: 'pausing',
        activeWorkCount: 0,
        method: 'chatgpt',
      });
      await pending.promise;
      await Promise.resolve();
    });

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('reports the managed Codex sign-in modal to App Advisor', async () => {
    start.mockResolvedValue({
      attemptId: 'attempt-1',
      phase: 'waiting',
      activeWorkCount: 0,
      method: 'chatgpt',
    });
    await act(async () => {
      root = createRoot(container);
      root.render(<CodexLoginModal onClose={onClose} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.appAdvisor
        ?.authLoginModal,
    ).toMatchObject({ open: true, provider: 'codex' });
  });
});
