import type { CodexSpeedCatalog } from '@canopy/desktop-shared/types/codex-speed-capabilities';
import {
  deriveCodexSpeedAvailability,
  shouldAcceptCodexSpeedCatalog,
  type CodexSpeedRouteFacts,
} from '@canopy/desktop-shared/lib/codex-speed-availability';
import { CodexSpeedUnsupportedError } from '@canopy/desktop-shared/lib/codex-speed';

const mockRequest = jest.fn();
let accountUpdatedListener: (() => void) | undefined;
const mockUnsubscribeAccountUpdates = jest.fn();
const mockOnAccountUpdated = jest.fn((listener: () => void): (() => void) => {
  accountUpdatedListener = listener;
  return mockUnsubscribeAccountUpdates;
});
let runtimeReplacedListener: (() => void) | undefined;

jest.mock('../../codex/runtime-service', () => ({
  getCodexRuntimeService: (): unknown => ({
    admin: (): unknown => ({
      request: mockRequest,
      onAccountUpdated: mockOnAccountUpdated,
    }),
  }),
  onCodexRuntimeServiceReplaced: (listener: () => void): (() => void) => {
    runtimeReplacedListener = listener;
    return (): void => undefined;
  },
}));

const mockFetchMockControlPlaneRecord = jest.fn();
const mockGetMockLlmOrigin = jest.fn((): string | null => null);
jest.mock('../../lib/e2e-mock-control-plane', () => ({
  get fetchMockControlPlaneRecord(): typeof mockFetchMockControlPlaneRecord {
    return mockFetchMockControlPlaneRecord;
  },
  get getMockLlmOrigin(): typeof mockGetMockLlmOrigin {
    return mockGetMockLlmOrigin;
  },
}));

import {
  assertCodexSpeedAvailable,
  getCodexSpeedCatalogSnapshot,
  invalidateCodexSpeedCatalog,
  peekCodexAccountModelIds,
  readCodexAccountModelIds,
  readCodexSpeedCatalog,
  reportCodexSpeedRejection,
  resetCodexAccountModelCache,
  resetCodexSpeedCatalogForTests,
  setCodexSpeedConsumerActive,
  setCodexSpeedRouteCatalogSource,
  subscribeCodexSpeedCatalog,
  type CodexSpeedRouteCatalogFetch,
} from '../codex-account-models';

const FIVE_MINUTES = 5 * 60_000;

/** Native 0.159 `model/list` entry shape (generated `v2/Model.ts`). */
function nativeModel(
  model: string,
  serviceTiers: Array<{ id: string; name: string; description: string }>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: model,
    model,
    displayName: model,
    hidden: false,
    additionalSpeedTiers: serviceTiers.some((tier) => tier.id === 'priority')
      ? ['fast']
      : [],
    serviceTiers,
    defaultServiceTier: null,
    ...extra,
  };
}

const PRIORITY = { id: 'priority', name: 'Fast', description: '2x speed' };
const ULTRAFAST = {
  id: 'ultrafast',
  name: 'Ultra fast',
  description: 'Ultra fast',
};

function page(
  data: unknown[],
  nextCursor: string | null = null,
): Record<string, unknown> {
  return { data, nextCursor };
}

function nativeRoute(model: string): CodexSpeedRouteFacts {
  return {
    modelSelection: 'explicit',
    runtimeModel: model,
    modelSource: 'codex-managed',
    harness: 'codex',
    routeProfile: 'codex-native',
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
}

describe('readCodexAccountModelIds', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    resetCodexSpeedCatalogForTests();
  });

  it('reads every page of the account model list, hidden models included', async () => {
    mockRequest
      .mockResolvedValueOnce({
        data: [{ id: 'gpt-5.6-luna', model: 'gpt-5.6-luna' }],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        data: [{ id: 'gpt-5.5', model: 'gpt-5.5' }],
        nextCursor: null,
      });

    const ids = await readCodexAccountModelIds();

    expect(ids && [...ids].sort()).toEqual(['gpt-5.5', 'gpt-5.6-luna']);
    expect(mockRequest).toHaveBeenNthCalledWith(1, 'model/list', {
      includeHidden: true,
    });
    expect(mockRequest).toHaveBeenNthCalledWith(2, 'model/list', {
      includeHidden: true,
      cursor: 'page-2',
    });
  });

  it('caches the list and refreshes it when the account changes', async () => {
    mockRequest.mockResolvedValue({
      data: [{ id: 'gpt-5.6-luna', model: 'gpt-5.6-luna' }],
      nextCursor: null,
    });

    await readCodexAccountModelIds();
    await readCodexAccountModelIds();
    expect(mockRequest).toHaveBeenCalledTimes(1);

    accountUpdatedListener?.();
    await readCodexAccountModelIds();
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('reports an unknown list instead of throwing when the lookup fails', async () => {
    mockRequest.mockRejectedValueOnce(new Error('app-server unavailable'));

    await expect(readCodexAccountModelIds()).resolves.toBeNull();
  });

  it('treats an empty list as unknown', async () => {
    mockRequest.mockResolvedValueOnce({ data: [], nextCursor: null });

    await expect(readCodexAccountModelIds()).resolves.toBeNull();
  });

  it('asks again on the next read after a failure or an empty list', async () => {
    mockRequest
      .mockRejectedValueOnce(new Error('app-server unavailable'))
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(page([{ id: 'gpt-5.5', model: 'gpt-5.5' }]));

    await expect(readCodexAccountModelIds()).resolves.toBeNull();
    await expect(readCodexAccountModelIds()).resolves.toBeNull();
    const ids = await readCodexAccountModelIds();
    expect(ids && [...ids]).toEqual(['gpt-5.5']);
    expect(mockRequest).toHaveBeenCalledTimes(3);
  });

  it('returns the partial list when pagination is cut short', async () => {
    for (let index = 0; index < 10; index += 1) {
      mockRequest.mockResolvedValueOnce(
        page([{ id: `model-${index}`, model: `model-${index}` }], `c${index}`),
      );
    }

    const ids = await readCodexAccountModelIds();

    expect(mockRequest).toHaveBeenCalledTimes(10);
    expect(ids?.size).toBe(10);
    expect(getCodexSpeedCatalogSnapshot().truncated).toBe(true);
  });
});

describe('peekCodexAccountModelIds', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    resetCodexSpeedCatalogForTests();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('never fetches, and answers null until a list is cached', async () => {
    expect(peekCodexAccountModelIds()).toBeNull();
    expect(mockRequest).not.toHaveBeenCalled();

    mockRequest.mockResolvedValueOnce(
      page([{ id: 'gpt-6-luna', model: 'gpt-6-luna' }]),
    );
    await readCodexAccountModelIds();

    const ids = peekCodexAccountModelIds();
    expect(ids && [...ids]).toEqual(['gpt-6-luna']);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('leaves hidden models out, and a hidden-only list is unknown', async () => {
    mockRequest.mockResolvedValueOnce(
      page([
        nativeModel('gpt-6-luna', []),
        nativeModel('gpt-6.1-sol', [], { hidden: true }),
      ]),
    );
    const autoIds = await readCodexAccountModelIds();
    // Auto keeps every listed model, hidden ones included.
    expect(autoIds && [...autoIds].sort()).toEqual([
      'gpt-6-luna',
      'gpt-6.1-sol',
    ]);
    const eligible = peekCodexAccountModelIds();
    expect(eligible && [...eligible]).toEqual(['gpt-6-luna']);

    resetCodexAccountModelCache();
    mockRequest.mockResolvedValueOnce(
      page([nativeModel('gpt-6.1-sol', [], { hidden: true })]),
    );
    await readCodexAccountModelIds();
    expect(peekCodexAccountModelIds()).toBeNull();
  });

  it('treats a truncated list as unknown for eligibility', async () => {
    for (let index = 0; index < 10; index += 1) {
      mockRequest.mockResolvedValueOnce(
        page([{ id: `model-${index}`, model: `model-${index}` }], `c${index}`),
      );
    }
    await readCodexAccountModelIds();

    expect(getCodexSpeedCatalogSnapshot().truncated).toBe(true);
    expect(peekCodexAccountModelIds()).toBeNull();
  });

  it('answers null once the cached list is stale', async () => {
    jest.useFakeTimers();
    mockRequest.mockResolvedValueOnce(
      page([{ id: 'gpt-6-luna', model: 'gpt-6-luna' }]),
    );
    await readCodexAccountModelIds();
    expect(peekCodexAccountModelIds()).not.toBeNull();

    jest.advanceTimersByTime(FIVE_MINUTES + 1);

    expect(peekCodexAccountModelIds()).toBeNull();
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
});

describe('readCodexSpeedCatalog', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-09-30T12:00:00Z') });
    mockRequest.mockReset();
    mockOnAccountUpdated.mockClear();
    mockUnsubscribeAccountUpdates.mockClear();
    resetCodexSpeedCatalogForTests();
  });

  afterEach(() => {
    resetCodexSpeedCatalogForTests();
    jest.useRealTimers();
  });

  it('projects native model/list tiers without account identity', async () => {
    mockRequest.mockResolvedValueOnce(
      page([
        // Bundled 0.159 catalog shape: modern Fast plus the deprecated alias.
        nativeModel('gpt-6-astra', [PRIORITY]),
        // Modern authoritative empty list beats the deprecated fallback.
        {
          id: 'empty-modern',
          model: 'empty-modern',
          serviceTiers: [],
          additionalSpeedTiers: ['fast', 'ultrafast'],
        },
        // Older catalogs: the deprecated list is used only when modern is absent.
        {
          id: 'legacy-only',
          model: 'legacy-only',
          additionalSpeedTiers: ['fast', 'mystery'],
        },
        { id: 'no-metadata', model: 'no-metadata' },
        nativeModel('future-model-x', [
          ULTRAFAST,
          { id: 'fast', name: 'Fast', description: '' },
          { id: 'flex', name: 'Flex', description: '' },
        ]),
      ]),
    );

    const catalog = await readCodexSpeedCatalog();

    expect(typeof catalog.generation).toBe('number');
    expect(catalog).toMatchObject({
      status: 'ready',
      fetchedAt: Date.now(),
      expiresAt: Date.now() + FIVE_MINUTES,
      truncated: false,
      denials: [],
    });
    expect(catalog.models).toEqual([
      {
        id: 'gpt-6-astra',
        model: 'gpt-6-astra',
        tiers: ['priority'],
        source: 'serviceTiers',
        displayName: 'gpt-6-astra',
        hidden: false,
      },
      {
        id: 'empty-modern',
        model: 'empty-modern',
        tiers: [],
        source: 'serviceTiers',
      },
      {
        id: 'legacy-only',
        model: 'legacy-only',
        tiers: ['priority'],
        source: 'additionalSpeedTiers',
      },
      {
        id: 'no-metadata',
        model: 'no-metadata',
        tiers: null,
        source: 'unknown',
      },
      {
        id: 'future-model-x',
        model: 'future-model-x',
        tiers: ['ultrafast', 'priority'],
        source: 'serviceTiers',
        displayName: 'future-model-x',
        hidden: false,
      },
    ]);
    expect(Object.keys(catalog).sort()).toEqual([
      'denials',
      'expiresAt',
      'fetchedAt',
      'generation',
      'models',
      'status',
      'truncated',
    ]);
  });

  it('shares one model/list fetch with the Auto model-id reader', async () => {
    let resolveRequest: (value: unknown) => void = () => undefined;
    mockRequest.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const catalogRead = readCodexSpeedCatalog();
    const forcedRead = readCodexSpeedCatalog({ force: true });
    const idsRead = readCodexAccountModelIds();
    resolveRequest(page([nativeModel('gpt-5.5', [PRIORITY])]));

    const [catalog, forced, ids] = await Promise.all([
      catalogRead,
      forcedRead,
      idsRead,
    ]);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(catalog.models).toHaveLength(1);
    expect(forced).toEqual(catalog);
    expect(ids && [...ids]).toEqual(['gpt-5.5']);

    await readCodexSpeedCatalog();
    expect(mockRequest).toHaveBeenCalledTimes(1);
    await readCodexSpeedCatalog({ force: true });
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('bounds a hung lookup with a timeout and reports it as unknown', async () => {
    mockRequest.mockReturnValueOnce(new Promise(() => undefined));

    const read = readCodexSpeedCatalog();
    await jest.advanceTimersByTimeAsync(5_000);
    const catalog = await read;

    expect(catalog.status).toBe('unknown');
    expect(catalog.models).toEqual([]);
    expect(catalog.error).toEqual(expect.any(String));
    expect(catalog.error).not.toMatch(/model\/list|timed out/);
  });

  it('never hands an obsolete generation to callers waiting across a reset', async () => {
    let resolveOld: (value: unknown) => void = () => undefined;
    mockRequest
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
      )
      .mockResolvedValueOnce(page([nativeModel('new-account-model', [])]));

    const waitingCatalog = readCodexSpeedCatalog();
    const waitingIds = readCodexAccountModelIds();
    const before = getCodexSpeedCatalogSnapshot().generation;

    accountUpdatedListener?.();
    resolveOld(page([nativeModel('old-account-model', [ULTRAFAST])]));

    const catalog = await waitingCatalog;
    const ids = await waitingIds;
    expect(catalog.generation).toBeGreaterThan(before);
    expect(catalog.models.map((entry) => entry.model)).toEqual([
      'new-account-model',
    ]);
    expect(ids && [...ids]).toEqual(['new-account-model']);
    expect(getCodexSpeedCatalogSnapshot().models).toEqual(catalog.models);
  });

  it('refreshes a mounted surface at expiry and publishes a same-account rollout', async () => {
    mockRequest
      .mockResolvedValueOnce(page([nativeModel('future-model-x', [PRIORITY])]))
      .mockResolvedValueOnce(
        page([nativeModel('future-model-x', [PRIORITY, ULTRAFAST])]),
      )
      .mockResolvedValueOnce(page([nativeModel('future-model-x', [PRIORITY])]));
    const broadcasts: CodexSpeedCatalog[] = [];
    const unsubscribe = subscribeCodexSpeedCatalog((catalog) => {
      broadcasts.push(catalog);
    });

    setCodexSpeedConsumerActive('1:composer', true);
    const initial = await readCodexSpeedCatalog();
    const route = nativeRoute('future-model-x');
    expect(
      deriveCodexSpeedAvailability({
        catalog: initial,
        route,
        speed: 'ultrafast',
        now: Date.now(),
      }).status,
    ).toBe('unavailable');

    // Negative results expire like positive ones; no account event is needed.
    await jest.advanceTimersByTimeAsync(FIVE_MINUTES);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    const upgraded = broadcasts[broadcasts.length - 1];
    expect(upgraded.generation).toBe(initial.generation);
    expect(upgraded.fetchedAt).toBeGreaterThan(initial.fetchedAt ?? 0);
    expect(
      deriveCodexSpeedAvailability({
        catalog: upgraded,
        route,
        speed: 'ultrafast',
        now: Date.now(),
      }).status,
    ).toBe('available');

    // Removed access is detected on the next expiry as well.
    await jest.advanceTimersByTimeAsync(FIVE_MINUTES);
    expect(mockRequest).toHaveBeenCalledTimes(3);
    const downgraded = broadcasts[broadcasts.length - 1];
    expect(
      deriveCodexSpeedAvailability({
        catalog: downgraded,
        route,
        speed: 'ultrafast',
        now: Date.now(),
      }).status,
    ).toBe('unavailable');

    for (let index = 1; index < broadcasts.length; index += 1) {
      const previous = broadcasts[index - 1];
      const next = broadcasts[index];
      expect(next.generation).toBeGreaterThanOrEqual(previous.generation);
      if (next.generation === previous.generation) {
        expect(next.fetchedAt ?? -1).toBeGreaterThanOrEqual(
          previous.fetchedAt ?? -1,
        );
      }
    }
    unsubscribe();
  });

  it('runs one shared expiry refresh for many consumers and stops when none remain', async () => {
    mockRequest.mockResolvedValue(page([nativeModel('gpt-5.5', [PRIORITY])]));

    setCodexSpeedConsumerActive('1:composer', true);
    setCodexSpeedConsumerActive('1:composer', true);
    setCodexSpeedConsumerActive('2:composer', true);
    setCodexSpeedConsumerActive('2:settings', true);
    await readCodexSpeedCatalog();
    await flush();
    expect(mockRequest).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(FIVE_MINUTES);
    expect(mockRequest).toHaveBeenCalledTimes(2);

    setCodexSpeedConsumerActive('1:composer', false);
    setCodexSpeedConsumerActive('2:composer', false);
    await jest.advanceTimersByTimeAsync(FIVE_MINUTES);
    expect(mockRequest).toHaveBeenCalledTimes(3);

    setCodexSpeedConsumerActive('2:settings', false);
    await jest.advanceTimersByTimeAsync(3 * FIVE_MINUTES);
    expect(mockRequest).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not refresh or poll without active consumers', async () => {
    mockRequest.mockResolvedValue(page([nativeModel('gpt-5.5', [PRIORITY])]));

    await jest.advanceTimersByTimeAsync(3 * FIVE_MINUTES);
    expect(mockRequest).not.toHaveBeenCalled();

    await readCodexSpeedCatalog();
    await jest.advanceTimersByTimeAsync(3 * FIVE_MINUTES);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('fetches immediately when a consumer mounts with stale or missing data', async () => {
    mockRequest.mockResolvedValue(page([nativeModel('gpt-5.5', [PRIORITY])]));

    setCodexSpeedConsumerActive('1:composer', true);
    await flush();
    expect(mockRequest).toHaveBeenCalledTimes(1);
    setCodexSpeedConsumerActive('1:composer', false);

    await jest.advanceTimersByTimeAsync(FIVE_MINUTES + 1);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    setCodexSpeedConsumerActive('1:composer', true);
    await flush();
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('retries failed discovery with bounded backoff and honors explicit refresh', async () => {
    mockRequest
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(page([nativeModel('gpt-5.5', [PRIORITY])]));
    const broadcasts: CodexSpeedCatalog[] = [];
    subscribeCodexSpeedCatalog((catalog) => broadcasts.push(catalog));

    setCodexSpeedConsumerActive('1:composer', true);
    const failed = await readCodexSpeedCatalog();
    expect(failed.status).toBe('unknown');
    expect(failed.error).toEqual(expect.any(String));
    expect(failed.error).not.toMatch(/connection reset/);

    // Stale reads during backoff do not hammer the runtime.
    await readCodexSpeedCatalog();
    expect(mockRequest).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(10_000);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(mockRequest).toHaveBeenCalledTimes(2);

    const recovered = await readCodexSpeedCatalog({ force: true });
    expect(mockRequest).toHaveBeenCalledTimes(3);
    expect(recovered.status).toBe('ready');
    expect(recovered.error).toBeUndefined();
    expect(broadcasts[broadcasts.length - 1]).toEqual(recovered);
  });

  it('records only definitive Ultra fast rejections as short-lived denials', async () => {
    mockRequest.mockResolvedValue(
      page([nativeModel('gpt-6-astra', [PRIORITY, ULTRAFAST])]),
    );
    setCodexSpeedConsumerActive('1:composer', true);
    const catalog = await readCodexSpeedCatalog();
    const route = nativeRoute('gpt-6-astra');
    const report = {
      runtimeModel: 'gpt-6-astra',
      generation: catalog.generation,
    };

    expect(
      reportCodexSpeedRejection({
        ...report,
        speed: 'ultrafast',
        kind: 'rate-limit',
      }),
    ).toBe(false);
    expect(
      reportCodexSpeedRejection({
        ...report,
        speed: 'ultrafast',
        kind: 'auth',
      }),
    ).toBe(false);
    expect(
      reportCodexSpeedRejection({ ...report, speed: 'fast', kind: 'tier' }),
    ).toBe(false);
    expect(
      reportCodexSpeedRejection({
        ...report,
        generation: catalog.generation - 1,
        speed: 'ultrafast',
        kind: 'tier',
      }),
    ).toBe(false);
    expect(getCodexSpeedCatalogSnapshot().denials).toEqual([]);

    expect(
      reportCodexSpeedRejection({
        ...report,
        speed: 'ultrafast',
        kind: 'tier',
      }),
    ).toBe(true);
    const denied = getCodexSpeedCatalogSnapshot();
    expect(denied.denials).toEqual([
      { model: 'gpt-6-astra', expiresAt: Date.now() + FIVE_MINUTES },
    ]);
    expect(
      deriveCodexSpeedAvailability({
        catalog: denied,
        route,
        speed: 'ultrafast',
        now: Date.now(),
      }).reason,
    ).toBe('denied');
    await expect(
      assertCodexSpeedAvailable({ speed: 'ultrafast', route }),
    ).rejects.toBeInstanceOf(CodexSpeedUnsupportedError);

    // The denial expires and the catalog is revalidated.
    await jest.advanceTimersByTimeAsync(FIVE_MINUTES);
    const revalidated = getCodexSpeedCatalogSnapshot();
    expect(revalidated.denials).toEqual([]);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    await expect(
      assertCodexSpeedAvailable({ speed: 'ultrafast', route }),
    ).resolves.toMatchObject({
      speed: 'ultrafast',
      generation: revalidated.generation,
    });
  });

  it('backs off a revalidation that fails at expiry instead of retrying at once', async () => {
    mockRequest
      .mockResolvedValueOnce(page([nativeModel('gpt-5.5', [PRIORITY])]))
      .mockRejectedValue(new Error('runtime restarting'));
    setCodexSpeedConsumerActive('1:composer', true);
    await readCodexSpeedCatalog();
    await jest.advanceTimersByTimeAsync(FIVE_MINUTES);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(9_999);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockRequest).toHaveBeenCalledTimes(3);
  });

  it('publishes a denial that lapses mid-TTL and keeps the expiry refresh armed', async () => {
    mockRequest.mockResolvedValue(
      page([nativeModel('gpt-6-astra', [PRIORITY, ULTRAFAST])]),
    );
    const broadcasts: CodexSpeedCatalog[] = [];
    const unsubscribe = subscribeCodexSpeedCatalog((catalog) => {
      broadcasts.push(catalog);
    });
    setCodexSpeedConsumerActive('1:composer', true);
    const catalog = await readCodexSpeedCatalog();
    // The catalog refreshes at five minutes; the denial lapses at seven.
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    expect(
      reportCodexSpeedRejection({
        speed: 'ultrafast',
        runtimeModel: 'gpt-6-astra',
        kind: 'tier',
        generation: catalog.generation,
      }),
    ).toBe(true);
    await jest.advanceTimersByTimeAsync(3 * 60_000);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(broadcasts.at(-1)?.denials).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(2 * 60_000);
    const lapsed = broadcasts.at(-1);
    expect(lapsed?.denials).toEqual([]);
    expect(
      lapsed &&
        deriveCodexSpeedAvailability({
          catalog: lapsed,
          route: nativeRoute('gpt-6-astra'),
          speed: 'ultrafast',
          now: Date.now(),
        }).status,
    ).toBe('available');
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    // The next expiry still revalidates.
    const calls = mockRequest.mock.calls.length;
    await jest.advanceTimersByTimeAsync(FIVE_MINUTES);
    expect(mockRequest.mock.calls.length).toBeGreaterThan(calls);
    unsubscribe();
  });

  it('invalidates on account, auth, and runtime changes and rebinds the account subscription', async () => {
    mockRequest.mockResolvedValue(page([nativeModel('gpt-5.5', [PRIORITY])]));
    const broadcasts: CodexSpeedCatalog[] = [];
    subscribeCodexSpeedCatalog((catalog) => broadcasts.push(catalog));

    const first = await readCodexSpeedCatalog();
    expect(mockOnAccountUpdated).toHaveBeenCalledTimes(1);

    accountUpdatedListener?.();
    expect(mockUnsubscribeAccountUpdates).toHaveBeenCalledTimes(1);
    const afterAccount = getCodexSpeedCatalogSnapshot();
    expect(afterAccount.generation).toBe(first.generation + 1);
    expect(afterAccount.status).toBe('unknown');
    expect(broadcasts[broadcasts.length - 1]).toEqual(afterAccount);

    await readCodexSpeedCatalog();
    expect(mockOnAccountUpdated).toHaveBeenCalledTimes(2);

    invalidateCodexSpeedCatalog('auth-transition');
    expect(getCodexSpeedCatalogSnapshot().generation).toBe(
      first.generation + 2,
    );

    runtimeReplacedListener?.();
    expect(getCodexSpeedCatalogSnapshot().generation).toBe(
      first.generation + 3,
    );

    resetCodexAccountModelCache();
    expect(getCodexSpeedCatalogSnapshot().generation).toBe(
      first.generation + 4,
    );
  });

  it('refetches immediately after invalidation while a surface is active', async () => {
    mockRequest.mockResolvedValue(page([nativeModel('gpt-5.5', [PRIORITY])]));
    setCodexSpeedConsumerActive('1:composer', true);
    await readCodexSpeedCatalog();
    await flush();
    expect(mockRequest).toHaveBeenCalledTimes(1);

    invalidateCodexSpeedCatalog('auth-transition');
    await flush();
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(getCodexSpeedCatalogSnapshot().status).toBe('ready');
  });
});

describe('UI-automation control-plane catalog (fixture evidence only)', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockFetchMockControlPlaneRecord.mockReset();
    mockOnAccountUpdated.mockClear();
    resetCodexSpeedCatalogForTests();
    Object.assign(globalThis, { __CANOPY_E2E__: true });
  });

  afterEach(() => {
    Object.assign(globalThis, { __CANOPY_E2E__: false });
    resetCodexSpeedCatalogForTests();
  });

  it('reads the mock route, never the shared runtime', async () => {
    mockGetMockLlmOrigin.mockReturnValue('http://mock.test');
    mockFetchMockControlPlaneRecord.mockResolvedValueOnce(
      page([
        { id: 'gpt-5.5', model: 'gpt-5.5' },
        nativeModel('fixture-ultra', [PRIORITY, ULTRAFAST]),
      ]),
    );

    const catalog = await readCodexSpeedCatalog();

    expect(mockFetchMockControlPlaneRecord).toHaveBeenCalledWith(
      'http://mock.test',
      '/__mock/codex/models',
    );
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockOnAccountUpdated).not.toHaveBeenCalled();
    expect(catalog.models).toEqual([
      { id: 'gpt-5.5', model: 'gpt-5.5', tiers: null, source: 'unknown' },
      {
        id: 'fixture-ultra',
        model: 'fixture-ultra',
        tiers: ['priority', 'ultrafast'],
        source: 'serviceTiers',
        displayName: 'fixture-ultra',
        hidden: false,
      },
    ]);
  });

  it('fails closed to unknown when the mock origin is missing', async () => {
    mockGetMockLlmOrigin.mockReturnValue(null);

    const catalog = await readCodexSpeedCatalog();

    expect(catalog.status).toBe('unknown');
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe('assertCodexSpeedAvailable', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-09-30T12:00:00Z') });
    mockRequest.mockReset();
    resetCodexSpeedCatalogForTests();
  });

  afterEach(() => {
    resetCodexSpeedCatalogForTests();
    jest.useRealTimers();
  });

  it('passes Regular and Fast on any route without reading the catalog', async () => {
    for (const speed of ['standard', 'fast'] as const) {
      await expect(
        assertCodexSpeedAvailable({
          speed,
          route: {
            modelSelection: 'auto',
            runtimeModel: null,
            modelSource: 'ai-gateway',
            harness: 'codex',
            routeProfile: 'ai-credits',
          },
        }),
      ).resolves.toMatchObject({ speed });
    }
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it.each<[string, CodexSpeedRouteFacts]>([
    [
      'AI Credits',
      {
        ...nativeRoute('gpt-6-astra'),
        routeProfile: 'ai-credits',
      },
    ],
    [
      'an organization gateway',
      { ...nativeRoute('gpt-6-astra'), routeProfile: 'org-gateway' },
    ],
    [
      'Ollama on the Codex harness',
      {
        ...nativeRoute('gpt-6-astra'),
        modelSource: 'ollama',
        routeProfile: 'ollama',
      },
    ],
    [
      'Cursor',
      {
        ...nativeRoute('gpt-6-astra'),
        modelSource: 'cursor-managed',
        harness: 'cursor',
        routeProfile: 'cursor',
      },
    ],
    [
      'a user-supplied credential',
      { ...nativeRoute('gpt-6-astra'), routeProfile: 'foreign' },
    ],
    ['Auto', { ...nativeRoute('gpt-6-astra'), modelSelection: 'auto' }],
  ])(
    'rejects Ultra fast on %s before any catalog read',
    async (_label, route) => {
      await expect(
        assertCodexSpeedAvailable({ speed: 'ultrafast', route }),
      ).rejects.toBeInstanceOf(CodexSpeedUnsupportedError);
      expect(mockRequest).not.toHaveBeenCalled();
    },
  );

  it('admits an arbitrary future model that advertises Ultra fast', async () => {
    mockRequest.mockResolvedValueOnce(
      page([nativeModel('brand-new-model-2027', [ULTRAFAST])]),
    );

    const admission = await assertCodexSpeedAvailable({
      speed: 'ultrafast',
      route: nativeRoute('brand-new-model-2027'),
    });

    expect(admission.availability).toMatchObject({
      status: 'available',
      reason: 'advertised',
    });
    expect(admission.generation).toBe(
      getCodexSpeedCatalogSnapshot().generation,
    );
  });

  it('rejects Ultra fast when the model lacks it or discovery is unknown', async () => {
    mockRequest
      .mockResolvedValueOnce(page([nativeModel('gpt-6-astra', [PRIORITY])]))
      .mockRejectedValueOnce(new Error('offline'));

    await expect(
      assertCodexSpeedAvailable({
        speed: 'ultrafast',
        route: nativeRoute('gpt-6-astra'),
      }),
    ).rejects.toThrow(/doesn't offer Ultra fast/);

    invalidateCodexSpeedCatalog('auth-transition');
    await expect(
      assertCodexSpeedAvailable({
        speed: 'ultrafast',
        route: nativeRoute('gpt-6-astra'),
      }),
    ).rejects.toThrow(/Couldn't confirm Ultra fast/);
  });

  it('revalidates a stale catalog at admission', async () => {
    mockRequest
      .mockResolvedValueOnce(page([nativeModel('gpt-6-astra', [PRIORITY])]))
      .mockResolvedValueOnce(
        page([nativeModel('gpt-6-astra', [PRIORITY, ULTRAFAST])]),
      );
    await readCodexSpeedCatalog();

    jest.setSystemTime(Date.now() + FIVE_MINUTES + 1);
    await expect(
      assertCodexSpeedAvailable({
        speed: 'ultrafast',
        route: nativeRoute('gpt-6-astra'),
      }),
    ).resolves.toMatchObject({ availability: { status: 'available' } });
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });
});

describe('account proxy route catalog', () => {
  let proxyKey = 'account-proxy:connection-1:on:keep';
  const mockProxyFetch = jest.fn<
    Promise<CodexSpeedRouteCatalogFetch | null>,
    []
  >();

  function proxyList(
    entries: Array<{ model: string; tiers: string[] | null }>,
  ): CodexSpeedRouteCatalogFetch {
    return {
      truncated: false,
      models: entries.map((entry) => ({
        id: entry.model,
        model: entry.model,
        tiers: entry.tiers,
        source: entry.tiers === null ? 'unknown' : 'serviceTiers',
      })),
    };
  }

  function proxyRoute(model: string): CodexSpeedRouteFacts {
    return { ...nativeRoute(model), routeProfile: 'account-proxy' };
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-09-30T12:00:00Z') });
    mockRequest.mockReset();
    mockProxyFetch.mockReset();
    resetCodexSpeedCatalogForTests();
    proxyKey = 'account-proxy:connection-1:on:keep';
    setCodexSpeedRouteCatalogSource('account-proxy', {
      key: () => proxyKey,
      fetch: () => mockProxyFetch(),
    });
  });

  afterEach(() => {
    resetCodexSpeedCatalogForTests();
    jest.useRealTimers();
  });

  it('carries the proxy list only once a read names the route', async () => {
    mockRequest.mockResolvedValue(
      page([nativeModel('gpt-6-astra', [PRIORITY, ULTRAFAST])]),
    );
    mockProxyFetch.mockResolvedValue(
      proxyList([{ model: 'gpt-6-astra', tiers: ['priority', 'ultrafast'] }]),
    );

    expect((await readCodexSpeedCatalog()).routes).toBeUndefined();
    expect(mockProxyFetch).not.toHaveBeenCalled();

    const catalog = await readCodexSpeedCatalog({ route: 'account-proxy' });
    expect(mockProxyFetch).toHaveBeenCalledTimes(1);
    expect(catalog.routes?.['account-proxy']).toMatchObject({
      status: 'ready',
      models: [
        expect.objectContaining({
          model: 'gpt-6-astra',
          tiers: ['priority', 'ultrafast'],
        }),
      ],
    });
    expect(getCodexSpeedCatalogSnapshot().routes).toEqual(catalog.routes);
  });

  it.each([
    {
      label: 'the proxy lacks Ultra fast the runtime offers',
      runtime: [PRIORITY, ULTRAFAST],
      proxy: ['priority'],
    },
    {
      label: 'the runtime lacks Ultra fast the proxy offers',
      runtime: [PRIORITY],
      proxy: ['priority', 'ultrafast'],
    },
  ])('refuses proxied Ultra fast when $label', async ({ runtime, proxy }) => {
    mockRequest.mockResolvedValue(page([nativeModel('gpt-6-astra', runtime)]));
    mockProxyFetch.mockResolvedValue(
      proxyList([{ model: 'gpt-6-astra', tiers: proxy }]),
    );
    await expect(
      assertCodexSpeedAvailable({
        speed: 'ultrafast',
        route: proxyRoute('gpt-6-astra'),
      }),
    ).rejects.toMatchObject({
      availability: { status: 'unavailable', reason: 'not-advertised' },
    });
  });

  it('admits proxied Ultra fast when both lists offer it, and the native route ignores the proxy list', async () => {
    mockRequest.mockResolvedValue(
      page([nativeModel('gpt-6-astra', [PRIORITY, ULTRAFAST])]),
    );
    mockProxyFetch.mockResolvedValue(
      proxyList([{ model: 'gpt-6-astra', tiers: ['priority', 'ultrafast'] }]),
    );
    await expect(
      assertCodexSpeedAvailable({
        speed: 'ultrafast',
        route: proxyRoute('gpt-6-astra'),
      }),
    ).resolves.toMatchObject({
      speed: 'ultrafast',
      routeProfile: 'account-proxy',
    });
    expect(mockProxyFetch).toHaveBeenCalledTimes(1);

    mockProxyFetch.mockClear();
    await expect(
      assertCodexSpeedAvailable({
        speed: 'ultrafast',
        route: nativeRoute('gpt-6-astra'),
      }),
    ).resolves.toMatchObject({ routeProfile: 'codex-native' });
  });

  it('fails closed for proxied Ultra fast when the proxy list cannot be read', async () => {
    mockRequest.mockResolvedValue(
      page([nativeModel('gpt-6-astra', [PRIORITY, ULTRAFAST])]),
    );
    mockProxyFetch.mockRejectedValue(new Error('proxy down: secret detail'));
    const rejection = assertCodexSpeedAvailable({
      speed: 'ultrafast',
      route: proxyRoute('gpt-6-astra'),
    });
    await expect(rejection).rejects.toBeInstanceOf(CodexSpeedUnsupportedError);
    await expect(rejection).rejects.toMatchObject({
      availability: { status: 'unknown', reason: 'catalog-unknown' },
    });
    const listed = getCodexSpeedCatalogSnapshot().routes?.['account-proxy'];
    expect(listed?.status).toBe('unknown');
    expect(listed?.error).toEqual(expect.any(String));
    expect(listed?.error).not.toMatch(/secret/);

    // Regular and Fast never read either list.
    mockProxyFetch.mockClear();
    mockRequest.mockClear();
    await expect(
      assertCodexSpeedAvailable({
        speed: 'fast',
        route: proxyRoute('gpt-6-astra'),
      }),
    ).resolves.toMatchObject({ speed: 'fast' });
    expect(mockProxyFetch).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('fails closed without a registered proxy source', async () => {
    setCodexSpeedRouteCatalogSource('account-proxy', null);
    mockRequest.mockResolvedValue(
      page([nativeModel('gpt-6-astra', [PRIORITY, ULTRAFAST])]),
    );
    await expect(
      assertCodexSpeedAvailable({
        speed: 'ultrafast',
        route: proxyRoute('gpt-6-astra'),
      }),
    ).rejects.toMatchObject({ availability: { status: 'unknown' } });
  });

  it('treats a proxy that does not take Codex work as an unknown list', async () => {
    mockRequest.mockResolvedValue(
      page([nativeModel('gpt-6-astra', [PRIORITY, ULTRAFAST])]),
    );
    mockProxyFetch.mockResolvedValue(null);
    const catalog = await readCodexSpeedCatalog({ route: 'account-proxy' });
    expect(catalog.routes?.['account-proxy']).toMatchObject({
      status: 'unknown',
      models: [],
    });
  });

  it('caches the proxy list for the TTL, keyed to the proxy connection', async () => {
    mockRequest.mockResolvedValue(page([nativeModel('gpt-6-astra', [])]));
    mockProxyFetch.mockResolvedValue(
      proxyList([{ model: 'gpt-6-astra', tiers: ['ultrafast'] }]),
    );
    await readCodexSpeedCatalog({ route: 'account-proxy' });
    await readCodexSpeedCatalog({ route: 'account-proxy' });
    expect(mockProxyFetch).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(FIVE_MINUTES + 1);
    await readCodexSpeedCatalog({ route: 'account-proxy' });
    expect(mockProxyFetch).toHaveBeenCalledTimes(2);

    // Another connection never reuses the cached list.
    proxyKey = 'account-proxy:connection-2:on:keep';
    expect(
      getCodexSpeedCatalogSnapshot().routes?.['account-proxy'],
    ).toMatchObject({ status: 'unknown', models: [] });
    await readCodexSpeedCatalog({ route: 'account-proxy' });
    expect(mockProxyFetch).toHaveBeenCalledTimes(3);

    await readCodexSpeedCatalog({ route: 'account-proxy', force: true });
    expect(mockProxyFetch).toHaveBeenCalledTimes(4);
  });

  it('backs off a failed proxy read and refreshes the list at expiry for mounted surfaces', async () => {
    mockRequest.mockResolvedValue(page([nativeModel('gpt-6-astra', [])]));
    mockProxyFetch
      .mockRejectedValueOnce(new Error('proxy restarting'))
      .mockResolvedValueOnce(
        proxyList([{ model: 'gpt-6-astra', tiers: ['priority'] }]),
      )
      .mockResolvedValueOnce(
        proxyList([{ model: 'gpt-6-astra', tiers: ['priority', 'ultrafast'] }]),
      );
    const broadcasts: CodexSpeedCatalog[] = [];
    const unsubscribe = subscribeCodexSpeedCatalog((catalog) => {
      broadcasts.push(catalog);
    });
    setCodexSpeedConsumerActive('1:composer', true);
    await readCodexSpeedCatalog({ route: 'account-proxy' });
    await readCodexSpeedCatalog({ route: 'account-proxy' });
    expect(mockProxyFetch).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(10_000);
    expect(mockProxyFetch).toHaveBeenCalledTimes(2);
    expect(
      broadcasts.at(-1)?.routes?.['account-proxy']?.models[0]?.tiers,
    ).toEqual(['priority']);

    await jest.advanceTimersByTimeAsync(FIVE_MINUTES);
    expect(mockProxyFetch).toHaveBeenCalledTimes(3);
    expect(
      broadcasts.at(-1)?.routes?.['account-proxy']?.models[0]?.tiers,
    ).toEqual(['priority', 'ultrafast']);

    setCodexSpeedConsumerActive('1:composer', false);
    await jest.advanceTimersByTimeAsync(3 * FIVE_MINUTES);
    expect(mockProxyFetch).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it('moves selectors off Ultra fast when a stale proxy revalidation fails', async () => {
    mockRequest.mockResolvedValue(
      page([nativeModel('gpt-6-astra', [PRIORITY, ULTRAFAST])]),
    );
    mockProxyFetch
      .mockResolvedValueOnce(
        proxyList([{ model: 'gpt-6-astra', tiers: ['ultrafast'] }]),
      )
      .mockRejectedValue(new Error('proxy down'));
    const broadcasts: CodexSpeedCatalog[] = [];
    const unsubscribe = subscribeCodexSpeedCatalog((catalog) => {
      broadcasts.push(catalog);
    });
    setCodexSpeedConsumerActive('1:composer', true);
    const offered = await readCodexSpeedCatalog({ route: 'account-proxy' });
    const route = proxyRoute('gpt-6-astra');
    const status = (catalog: CodexSpeedCatalog): string =>
      deriveCodexSpeedAvailability({
        catalog,
        route,
        speed: 'ultrafast',
        now: Date.now(),
      }).status;
    expect(status(offered)).toBe('available');

    // The runtime catalog refreshes too, so stop it from re-offering the
    // proxy's last answer while the proxy is down.
    await jest.advanceTimersByTimeAsync(FIVE_MINUTES + 1);
    const failed = broadcasts.at(-1);
    if (!failed) throw new Error('No catalog was broadcast.');
    expect(failed.routes?.['account-proxy']).toMatchObject({
      status: 'unknown',
      fetchedAt: null,
    });
    // A renderer mirror holding the earlier snapshot adopts the failure.
    expect(shouldAcceptCodexSpeedCatalog(offered, failed)).toBe(true);
    expect(status(failed)).toBe('unknown');
    unsubscribe();
  });

  it('keeps a proxy tier refusal on the proxy route only', async () => {
    mockRequest.mockResolvedValue(
      page([nativeModel('gpt-6-astra', [PRIORITY, ULTRAFAST])]),
    );
    mockProxyFetch.mockResolvedValue(
      proxyList([{ model: 'gpt-6-astra', tiers: ['ultrafast'] }]),
    );
    const admission = await assertCodexSpeedAvailable({
      speed: 'ultrafast',
      route: proxyRoute('gpt-6-astra'),
    });
    expect(
      reportCodexSpeedRejection({
        speed: 'ultrafast',
        runtimeModel: 'gpt-6-astra',
        kind: 'tier',
        generation: admission.generation,
        routeProfile: admission.routeProfile,
      }),
    ).toBe(true);
    await expect(
      assertCodexSpeedAvailable({
        speed: 'ultrafast',
        route: proxyRoute('gpt-6-astra'),
      }),
    ).rejects.toMatchObject({ availability: { reason: 'denied' } });
    await expect(
      assertCodexSpeedAvailable({
        speed: 'ultrafast',
        route: nativeRoute('gpt-6-astra'),
      }),
    ).resolves.toMatchObject({ speed: 'ultrafast' });
  });
});
