/** @jest-environment jsdom */
import {
  BROWSER_FIND_DEBOUNCE_MS,
  BROWSER_FIND_ERROR,
  createBrowserFindController,
  routeBrowserFindResult,
  type BrowserFindApi,
  type BrowserFindControllerHandle,
} from '../browserFindController';
import { useSurfaceFindStore } from '../surfaceFindStore';

interface MockBrowserFindApi extends BrowserFindApi {
  findInPage: jest.Mock<
    Promise<number>,
    Parameters<BrowserFindApi['findInPage']>
  >;
  stopFindInPage: jest.Mock<
    Promise<void>,
    Parameters<BrowserFindApi['stopFindInPage']>
  >;
}

function makeApi(): MockBrowserFindApi {
  let nextId = 1;
  return {
    findInPage: jest.fn<
      Promise<number>,
      Parameters<BrowserFindApi['findInPage']>
    >(() => Promise.resolve(nextId++)),
    stopFindInPage: jest.fn<
      Promise<void>,
      Parameters<BrowserFindApi['stopFindInPage']>
    >(() => Promise.resolve()),
  };
}

function result(
  requestId: number,
  activeMatchOrdinal: number,
  matches: number,
  finalUpdate = true,
): Parameters<typeof routeBrowserFindResult>[0] {
  return {
    type: 'find-result',
    browserId: 'b1',
    requestId,
    activeMatchOrdinal,
    matches,
    finalUpdate,
  };
}

function counts():
  | { currentIndex: number; totalCount: number; error: string | null }
  | undefined {
  return useSurfaceFindStore.getState().controllerStates['browser:b1'];
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('browserFindController', () => {
  let api: MockBrowserFindApi;
  let handle: BrowserFindControllerHandle;

  beforeEach(() => {
    useSurfaceFindStore.setState({ controllerStates: {} });
    jest.useFakeTimers();
    api = makeApi();
    handle = createBrowserFindController({
      browserId: 'b1',
      anchor: document.body,
      api: () => api,
    });
  });

  afterEach(() => {
    handle.dispose();
    jest.useRealTimers();
  });

  it('carries the given title on its controller', () => {
    const titled = createBrowserFindController({
      browserId: 'b2',
      anchor: document.body,
      title: 'Docs',
      api: () => api,
    });
    expect(titled.controller.title).toBe('Docs');
    titled.dispose();
  });

  it('trims and debounces the query before searching', async () => {
    handle.controller.setQuery('  nee');
    handle.controller.setQuery('  needle ');
    expect(api.findInPage).not.toHaveBeenCalled();

    jest.advanceTimersByTime(BROWSER_FIND_DEBOUNCE_MS);
    await flush();
    expect(api.findInPage).toHaveBeenCalledTimes(1);
    expect(api.findInPage).toHaveBeenCalledWith({
      browserId: 'b1',
      text: 'needle',
      findNext: false,
      forward: true,
    });
  });

  it('stops an active native find for an empty query', async () => {
    // Opening the bar applies the empty query; nothing to stop yet.
    handle.controller.setQuery('');
    expect(api.stopFindInPage).not.toHaveBeenCalled();
    expect(counts()).toEqual({ currentIndex: 0, totalCount: 0, error: null });

    handle.controller.setQuery('needle');
    jest.advanceTimersByTime(BROWSER_FIND_DEBOUNCE_MS);
    await flush();
    handle.controller.setQuery('   ');
    expect(api.findInPage).toHaveBeenCalledTimes(1);
    expect(api.stopFindInPage).toHaveBeenCalledWith({
      browserId: 'b1',
      action: 'clearSelection',
    });
    expect(counts()).toEqual({ currentIndex: 0, totalCount: 0, error: null });
  });

  it('ignores a late result for the previous query', async () => {
    handle.controller.setQuery('foo');
    jest.advanceTimersByTime(BROWSER_FIND_DEBOUNCE_MS);
    await flush();
    routeBrowserFindResult(result(1, 1, 2));

    // `bar` is issued; a late update for `foo` arrives before it resolves.
    handle.controller.setQuery('bar');
    jest.advanceTimersByTime(BROWSER_FIND_DEBOUNCE_MS);
    routeBrowserFindResult(result(1, 1, 9));
    expect(counts()?.totalCount).not.toBe(9);

    await flush();
    routeBrowserFindResult(result(2, 1, 3));
    expect(counts()).toEqual({ currentIndex: 0, totalCount: 3, error: null });
  });

  it('needs two characters, like the chat and file searches', async () => {
    handle.controller.setQuery(' n ');
    jest.advanceTimersByTime(BROWSER_FIND_DEBOUNCE_MS);
    await flush();
    expect(api.findInPage).not.toHaveBeenCalled();
    expect(counts()).toEqual({ currentIndex: 0, totalCount: 0, error: null });

    handle.controller.setQuery('ne');
    jest.advanceTimersByTime(BROWSER_FIND_DEBOUNCE_MS);
    await flush();
    expect(api.findInPage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'ne' }),
    );
  });

  it('keeps the active match when the trimmed query is unchanged', async () => {
    handle.controller.setQuery('needle');
    jest.advanceTimersByTime(BROWSER_FIND_DEBOUNCE_MS);
    await flush();

    handle.controller.setQuery('needle ');
    jest.advanceTimersByTime(BROWSER_FIND_DEBOUNCE_MS);
    await flush();
    expect(api.findInPage).toHaveBeenCalledTimes(1);
  });

  it('flushes a pending search on next instead of skipping a match', async () => {
    handle.controller.setQuery('needle');
    handle.controller.next();
    await flush();
    expect(api.findInPage).toHaveBeenCalledTimes(1);
    expect(api.findInPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ findNext: false }),
    );

    handle.controller.next();
    handle.controller.previous();
    expect(api.findInPage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ findNext: true, forward: true }),
    );
    expect(api.findInPage).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ findNext: true, forward: false }),
    );
  });

  it('reports the latest request and drops stale results', async () => {
    handle.controller.setQuery('needle');
    jest.advanceTimersByTime(BROWSER_FIND_DEBOUNCE_MS);
    await flush();
    handle.controller.next();
    await flush();

    routeBrowserFindResult(result(1, 1, 4));
    expect(counts()).toBeUndefined();

    routeBrowserFindResult(result(2, 2, 4, false));
    expect(counts()).toEqual({ currentIndex: 1, totalCount: 4, error: null });
    routeBrowserFindResult(result(2, 2, 5));
    expect(counts()).toEqual({ currentIndex: 1, totalCount: 5, error: null });
  });

  it('applies a result that arrives before its request id resolves', async () => {
    handle.controller.setQuery('needle');
    jest.advanceTimersByTime(BROWSER_FIND_DEBOUNCE_MS);
    routeBrowserFindResult(result(1, 1, 2));
    expect(counts()).toBeUndefined();

    await flush();
    expect(counts()).toEqual({ currentIndex: 0, totalCount: 2, error: null });
  });

  it('reports 0 of 0 when nothing matches', async () => {
    handle.controller.setQuery('missing');
    jest.advanceTimersByTime(BROWSER_FIND_DEBOUNCE_MS);
    await flush();
    routeBrowserFindResult(result(1, 0, 0));
    expect(counts()).toEqual({ currentIndex: 0, totalCount: 0, error: null });
  });

  it('reports an IPC rejection and retries the current query', async () => {
    api.findInPage.mockRejectedValueOnce(new Error('browser gone'));
    handle.controller.setQuery('needle');
    jest.advanceTimersByTime(BROWSER_FIND_DEBOUNCE_MS);
    await flush();
    expect(counts()?.error).toBe(BROWSER_FIND_ERROR);

    handle.controller.retry?.();
    expect(counts()?.error).toBeNull();
    expect(api.findInPage).toHaveBeenCalledTimes(2);
  });

  it('re-runs the query after the page navigates', async () => {
    handle.controller.setQuery('needle');
    jest.advanceTimersByTime(BROWSER_FIND_DEBOUNCE_MS);
    await flush();
    routeBrowserFindResult(result(1, 1, 3));

    handle.handlePageLoad();
    expect(counts()).toEqual({ currentIndex: 0, totalCount: 0, error: null });
    expect(api.findInPage).toHaveBeenCalledTimes(2);
  });

  it('stops the find on close and on dispose', async () => {
    handle.controller.setQuery('needle');
    jest.advanceTimersByTime(BROWSER_FIND_DEBOUNCE_MS);
    await flush();

    handle.controller.close();
    expect(api.stopFindInPage).toHaveBeenCalledTimes(1);

    handle.controller.setQuery('again');
    handle.dispose();
    jest.advanceTimersByTime(BROWSER_FIND_DEBOUNCE_MS);
    expect(api.findInPage).toHaveBeenCalledTimes(1);
    expect(api.stopFindInPage).toHaveBeenCalledTimes(2);

    routeBrowserFindResult(result(5, 1, 1));
    expect(counts()).toEqual({ currentIndex: 0, totalCount: 0, error: null });
  });
});
