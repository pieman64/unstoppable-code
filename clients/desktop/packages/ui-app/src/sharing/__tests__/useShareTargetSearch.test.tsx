/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  toShareTarget,
  useShareTargetSearch,
  type ShareTargetSearchState,
  type UseShareTargetSearchOptions,
} from '../useShareTargetSearch';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let container: HTMLDivElement;
let root: Root;
let latest: ShareTargetSearchState<string> | null = null;

function Harness(props: UseShareTargetSearchOptions<string>): JSX.Element {
  latest = useShareTargetSearch(props);
  return <div />;
}

function current(): ShareTargetSearchState<string> {
  if (!latest) throw new Error('hook not rendered');
  return latest;
}

function render(props: UseShareTargetSearchOptions<string>): void {
  act(() => {
    root.render(<Harness {...props} />);
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  latest = null;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.useRealTimers();
});

describe('useShareTargetSearch', () => {
  it('makes no call while disabled', async () => {
    const load = jest.fn(
      (): Promise<readonly string[]> => Promise.resolve(['a']),
    );
    render({ enabled: false, load });
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    await flush();
    expect(load).not.toHaveBeenCalled();
    expect(current().loading).toBe(false);
    expect(current().items).toBeNull();
  });

  it('loads without a query when enabled and exposes the items', async () => {
    const load = jest.fn(
      (): Promise<readonly string[]> => Promise.resolve(['a', 'b']),
    );
    render({ enabled: true, load });
    expect(load).toHaveBeenCalledWith(undefined);
    expect(current().loading).toBe(true);
    await flush();
    expect(current().items).toEqual(['a', 'b']);
    expect(current().loading).toBe(false);
  });

  it('debounces the trimmed query', async () => {
    const load = jest.fn((): Promise<readonly string[]> => Promise.resolve([]));
    render({ enabled: true, load });
    await flush();
    load.mockClear();

    act(() => current().setSearch('  pl'));
    act(() => current().setSearch('  plat  '));
    act(() => {
      jest.advanceTimersByTime(249);
    });
    expect(load).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('plat');
    expect(current().search).toBe('  plat  ');
  });

  it('drops a stale response that resolves after a newer one', async () => {
    const first = deferred<readonly string[]>();
    const second = deferred<readonly string[]>();
    const load = jest
      .fn<Promise<readonly string[]>, [string?]>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render({ enabled: true, load });

    act(() => current().setSearch('x'));
    act(() => {
      jest.advanceTimersByTime(250);
    });
    expect(load).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve(['fresh']);
      await second.promise;
    });
    await act(async () => {
      first.resolve(['stale']);
      await first.promise;
    });
    expect(current().items).toEqual(['fresh']);
    expect(current().loading).toBe(false);
  });

  it('ignores a response that lands after being disabled', async () => {
    const pending = deferred<readonly string[]>();
    const load = jest.fn((): Promise<readonly string[]> => pending.promise);
    const props = { enabled: true, load };
    render(props);
    render({ ...props, enabled: false });
    await act(async () => {
      pending.resolve(['late']);
      await pending.promise;
    });
    expect(current().items).toBeNull();
    expect(current().loading).toBe(false);
  });

  it('reloads when the reset key changes while staying enabled', async () => {
    const load = jest
      .fn<Promise<readonly string[]>, [string?]>()
      .mockResolvedValueOnce(['first-account'])
      .mockResolvedValueOnce(['second-account']);
    render({ enabled: true, load, resetKey: 'account-1' });
    await flush();
    expect(current().items).toEqual(['first-account']);

    render({ enabled: true, load, resetKey: 'account-2' });
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(current().items).toEqual(['second-account']);
  });

  it('ignores a response from before the reset key changed', async () => {
    const stale = deferred<readonly string[]>();
    const fresh = deferred<readonly string[]>();
    const load = jest
      .fn<Promise<readonly string[]>, [string?]>()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);
    render({ enabled: true, load, resetKey: 'account-1' });
    render({ enabled: true, load, resetKey: 'account-2' });
    await act(async () => {
      fresh.resolve(['account-2 team']);
      await fresh.promise;
    });
    await act(async () => {
      stale.resolve(['account-1 team']);
      await stale.promise;
    });
    expect(current().items).toEqual(['account-2 team']);
  });

  it('maps a rejected load through formatError and clears items', async () => {
    const load = jest.fn(
      (): Promise<readonly string[]> => Promise.reject(new Error('HTTP 403')),
    );
    render({
      enabled: true,
      load,
      formatError: (error) =>
        error instanceof Error ? `mapped: ${error.message}` : 'unknown',
    });
    await flush();
    expect(current().error).toBe('mapped: HTTP 403');
    expect(current().items).toEqual([]);
    expect(current().loading).toBe(false);
  });

  it('defaults to the error message when no formatter is given', async () => {
    const load = jest.fn(
      (): Promise<readonly string[]> => Promise.reject(new Error('Offline')),
    );
    render({ enabled: true, load });
    await flush();
    expect(current().error).toBe('Offline');
  });
});

describe('toShareTarget', () => {
  it('labels a team with its organization', () => {
    expect(
      toShareTarget({
        id: 't',
        name: 'Platform',
        organization: { id: 'o', name: 'Acme' },
      }),
    ).toEqual({
      id: 't',
      name: 'Platform',
      organizationId: 'o',
      secondaryLabel: 'Acme',
    });
  });

  it('leaves an organization without a secondary label', () => {
    expect(toShareTarget({ id: 'o', name: 'Acme' })).toEqual({
      id: 'o',
      name: 'Acme',
    });
  });
});
