/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeGraphBuildStatusChangedEvent } from '@canopy/desktop-shared/types';
import { useCodeGraphBuildEventSubscriptions } from '../useCodeGraphBuildEventSubscriptions';
import { useCodeGraphBuildStore } from '@/stores/codeGraphBuildStore';

function HookHarness(): null {
  useCodeGraphBuildEventSubscriptions();
  return null;
}

describe('useCodeGraphBuildEventSubscriptions', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalApi: Window['api'] | undefined;
  let handler: ((event: CodeGraphBuildStatusChangedEvent) => void) | null;
  let unsubscribeMock: jest.Mock;

  beforeEach(() => {
    useCodeGraphBuildStore.setState({ building: {} });
    originalApi = window.api;
    handler = null;
    unsubscribeMock = jest.fn();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        onCodeGraphBuildStatusChanged: jest.fn(
          (cb: (event: CodeGraphBuildStatusChangedEvent) => void) => {
            handler = cb;
            return unsubscribeMock;
          },
        ),
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
    if (originalApi === undefined) {
      Reflect.deleteProperty(window, 'api');
    } else {
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: originalApi,
      });
    }
  });

  it('subscribes on mount and routes a building event into the store', async () => {
    await act(async () => {
      root.render(createElement(HookHarness));
      await Promise.resolve();
    });

    expect(window.api.onCodeGraphBuildStatusChanged).toHaveBeenCalledTimes(1);
    expect(handler).not.toBeNull();

    act(() => {
      handler?.({
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        status: 'building',
      });
    });

    expect(useCodeGraphBuildStore.getState().building).toEqual({
      'proj-1/wt-1': true,
    });
  });

  it('routes an idle event to clear the key', async () => {
    useCodeGraphBuildStore.getState().setBuilding('proj-1', 'wt-1', true);

    await act(async () => {
      root.render(createElement(HookHarness));
      await Promise.resolve();
    });

    act(() => {
      handler?.({ projectId: 'proj-1', worktreeId: 'wt-1', status: 'idle' });
    });

    expect(useCodeGraphBuildStore.getState().building).toEqual({});
  });

  it('unsubscribes on unmount', async () => {
    await act(async () => {
      root.render(createElement(HookHarness));
      await Promise.resolve();
    });

    act(() => {
      root.unmount();
    });

    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });
});
