/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { LinearStatus } from '@canopy/desktop-shared/types';
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
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  const loadLinearTokenMock = jest.fn<Promise<string>, []>();
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
