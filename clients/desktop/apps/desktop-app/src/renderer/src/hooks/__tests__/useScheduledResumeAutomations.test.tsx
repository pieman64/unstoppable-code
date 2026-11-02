/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AutomationsListResponse } from '@canopy/desktop-shared/types';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  useScheduledResumeAutomations,
  type ScheduledResumeAutomations,
} from '../useScheduledResumeAutomations';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const EMPTY: AutomationsListResponse = { activities: [], recentRuns: [] };

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function Probe({
  active,
  onResult,
}: {
  active: boolean;
  onResult: (result: ScheduledResumeAutomations) => void;
}): JSX.Element {
  onResult(useScheduledResumeAutomations(active));
  return <></>;
}

describe('useScheduledResumeAutomations', () => {
  let root: Root;
  const results: ScheduledResumeAutomations[] = [];
  const unsubscribe = jest.fn();
  let list: jest.Mock<Promise<AutomationsListResponse>, []>;
  let onChanged: jest.Mock;

  function render(active: boolean): void {
    root.render(
      <Probe active={active} onResult={(result) => results.push(result)} />,
    );
  }

  beforeEach(() => {
    results.length = 0;
    unsubscribe.mockClear();
    useWorkspaceContextStore.setState({ hydrated: false });
    useAutomationsStore.setState({
      activities: [],
      recentRuns: [],
      hydrated: false,
      loading: false,
      error: null,
    });
    list = jest.fn(() => Promise.resolve(EMPTY));
    onChanged = jest.fn(() => unsubscribe);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { automations: { list, onChanged } },
    });
    root = createRoot(document.createElement('div'));
  });

  afterEach(() => {
    act(() => root.unmount());
    Reflect.deleteProperty(window, 'api');
  });

  it('neither subscribes nor loads while inactive, then loads on activation', async () => {
    useAutomationsStore.setState({ hydrated: true });
    act(() => render(false));
    expect(onChanged).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(results.at(-1)).toMatchObject({
      activities: [],
      settled: false,
      loading: false,
      error: null,
    });

    useAutomationsStore.setState({ hydrated: false });
    await act(async () => {
      render(true);
      await Promise.resolve();
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(results.at(-1)?.settled).toBe(true);

    act(() => render(false));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(results.at(-1)?.settled).toBe(false);
  });

  it('reports a failed load as unsettled and retries only when no load is in flight', async () => {
    const failed = deferred<AutomationsListResponse>();
    const retried = deferred<AutomationsListResponse>();
    list
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retried.promise);
    await act(async () => {
      render(true);
      await Promise.resolve();
    });
    expect(results.at(-1)).toMatchObject({ settled: false, loading: true });
    act(() => results.at(-1)?.retry());
    expect(list).toHaveBeenCalledTimes(1);

    await act(async () => {
      failed.reject(new Error('offline'));
      await Promise.resolve();
    });
    expect(results.at(-1)).toMatchObject({
      settled: false,
      loading: false,
      error: 'offline',
    });

    act(() => results.at(-1)?.retry());
    expect(list).toHaveBeenCalledTimes(2);
    await act(async () => {
      retried.resolve(EMPTY);
      await Promise.resolve();
    });
    expect(results.at(-1)).toMatchObject({ settled: true, error: null });
    act(() => results.at(-1)?.retry());
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('stays settled during a background reload of the same context', async () => {
    await act(async () => {
      render(true);
      await Promise.resolve();
    });
    const reload = deferred<AutomationsListResponse>();
    list.mockReturnValueOnce(reload.promise);
    act(() => void useAutomationsStore.getState().hydrate());
    expect(results.at(-1)).toMatchObject({ settled: true, loading: true });
    await act(async () => {
      reload.resolve(EMPTY);
      await Promise.resolve();
    });
    expect(results.at(-1)).toMatchObject({ settled: true, loading: false });
  });

  it('does not report the previous context as settled while the next loads', async () => {
    await act(async () => {
      render(true);
      await Promise.resolve();
    });
    expect(results.at(-1)?.settled).toBe(true);
    act(() =>
      useAutomationsStore.setState({ activities: [], hydrated: false }),
    );
    expect(results.at(-1)?.settled).toBe(false);
  });
});
