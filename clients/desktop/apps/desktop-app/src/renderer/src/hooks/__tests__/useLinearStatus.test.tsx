/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CredentialReadFailure,
  LinearStatus,
} from '@canopy/desktop-shared/types';
import { LINEAR_CONNECTION_CHANGED_EVENT } from '@/lib/integrationConnectionEvents';
import {
  invalidateLinearStatusCache,
  useLinearAvailability,
} from '../useLinearStatus';

interface Probe {
  current: ReturnType<typeof useLinearAvailability> | null;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value: T): void => {
      if (!resolvePromise) throw new Error('Deferred promise is not ready');
      resolvePromise(value);
    },
  };
}

function HookHarness({ probe }: { probe: Probe }): JSX.Element {
  probe.current = useLinearAvailability();
  return <></>;
}

async function flushAsyncEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('useLinearAvailability', () => {
  it('distinguishes a failed token read from a known unconnected account (CAN-4007)', async () => {
    loadLinearTokenMock.mockRejectedValueOnce(
      new Error('Secure storage unavailable'),
    );
    const probe: Probe = { current: null };
    await act(async () => {
      root.render(<HookHarness probe={probe} />);
      await flushAsyncEffects();
    });
    expect(probe.current?.tokenReadFailed).toBe(true);
    expect(probe.current?.tokenLoaded).toBe(true);
    loadLinearTokenMock.mockResolvedValue('');
    await act(async () => {
      window.dispatchEvent(new Event(LINEAR_CONNECTION_CHANGED_EVENT));
      await flushAsyncEffects();
    });
    expect(probe.current?.tokenReadFailed).toBe(false);
  });
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  const loadLinearTokenMock = jest.fn<
    Promise<string | CredentialReadFailure>,
    []
  >();
  const validateLinearTokenMock = jest.fn<Promise<LinearStatus>, [string]>();

  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    loadLinearTokenMock.mockReset();
    validateLinearTokenMock.mockReset().mockResolvedValue({
      authenticated: true,
      displayName: 'Linear user',
      error: null,
    });
    invalidateLinearStatusCache();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadLinearToken: loadLinearTokenMock,
        validateLinearToken: validateLinearTokenMock,
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    invalidateLinearStatusCache();
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  it('keeps a returned credential read failure unknown until a successful reload', async () => {
    loadLinearTokenMock.mockResolvedValue({
      success: false,
      error: 'Secure storage unavailable',
    });
    const probe: Probe = { current: null };
    await act(async () => {
      root.render(<HookHarness probe={probe} />);
      await flushAsyncEffects();
    });
    expect(probe.current?.tokenLoaded).toBe(true);
    expect(probe.current?.tokenPresent).toBe(false);
    expect(probe.current?.available).toBe(false);
    expect(validateLinearTokenMock).not.toHaveBeenCalled();
    expect(probe.current?.tokenReadFailed).toBe(true);

    loadLinearTokenMock.mockResolvedValue('recovered-token');
    await act(async () => {
      window.dispatchEvent(new Event(LINEAR_CONNECTION_CHANGED_EVENT));
      await flushAsyncEffects();
    });
    expect(probe.current?.tokenReadFailed).toBe(false);
    expect(probe.current?.tokenPresent).toBe(true);
    expect(probe.current?.available).toBe(true);
    expect(validateLinearTokenMock).toHaveBeenCalledWith('recovered-token');
  });

  it('ignores an older token load that resolves after a connection-change reload', async () => {
    const olderLoad = deferred<string>();
    const newerLoad = deferred<string>();
    loadLinearTokenMock
      .mockReturnValueOnce(olderLoad.promise)
      .mockReturnValueOnce(newerLoad.promise);

    const probe: Probe = { current: null };
    await act(async () => {
      root.render(<HookHarness probe={probe} />);
      await flushAsyncEffects();
    });

    act(() => {
      window.dispatchEvent(new Event(LINEAR_CONNECTION_CHANGED_EVENT));
    });
    expect(loadLinearTokenMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      newerLoad.resolve('new-token');
      await flushAsyncEffects();
    });
    expect(validateLinearTokenMock).toHaveBeenCalledWith('new-token');
    expect(probe.current?.available).toBe(true);

    await act(async () => {
      olderLoad.resolve('old-token');
      await flushAsyncEffects();
    });
    expect(validateLinearTokenMock).not.toHaveBeenCalledWith('old-token');
    expect(probe.current?.available).toBe(true);
  });
});
