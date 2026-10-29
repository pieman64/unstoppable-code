/**
 * Coverage for the shared Cursor runtime availability preflight and its
 * synchronous cache. Chat IPC model changes, the Portal chat adapter's send
 * and set-model paths, and the Portal provider-availability projection all
 * read this one helper, so it must fail closed on status errors and expose
 * the last observed value without probing.
 */
import type { CursorConnectionStatus } from '@canopy/desktop-shared/types';

const mockStatus = jest.fn<Promise<CursorConnectionStatus>, []>();
// Counts evaluations of the runtime-status module itself. Importing it
// eagerly from a widely shared module such as provider-auth-state would load
// the whole Cursor runtime graph, and resolve its pinned metadata, for every
// main-process module that only asks whether Cursor is available.
const mockStatusModuleEvaluations = jest.fn();
jest.mock(
  '../cursor/runtime-status',
  (): { cursorConnectionStatus: () => Promise<CursorConnectionStatus> } => {
    mockStatusModuleEvaluations();
    return {
      cursorConnectionStatus: (): Promise<CursorConnectionStatus> =>
        mockStatus(),
    };
  },
);
import {
  isCursorRuntimeAvailable,
  peekCursorRuntimeAvailability,
  probeCursorRuntimeStatus,
  refreshCursorRuntimeAvailability,
} from '../cursor/runtime-availability';

function status(
  overrides: Partial<CursorConnectionStatus>,
): CursorConnectionStatus {
  return {
    supported: true,
    installed: true,
    enabled: true,
    version: 'v',
    phase: 'connected',
    ...overrides,
  };
}

describe('Cursor runtime availability', () => {
  beforeEach(() => {
    mockStatus.mockReset();
  });

  it('is undefined before any refresh and fails closed on status errors', async () => {
    expect(peekCursorRuntimeAvailability()).toBeUndefined();
    mockStatus.mockRejectedValue(new Error('boom'));
    await expect(isCursorRuntimeAvailable()).resolves.toBe(false);
    expect(peekCursorRuntimeAvailability()).toBe(false);
  });

  it('caches the last observed value for the synchronous peek', async () => {
    mockStatus.mockResolvedValue(status({}));
    await expect(refreshCursorRuntimeAvailability()).resolves.toBe(true);
    expect(peekCursorRuntimeAvailability()).toBe(true);
    mockStatus.mockResolvedValue(status({ installed: false }));
    await expect(refreshCursorRuntimeAvailability()).resolves.toBe(false);
    expect(peekCursorRuntimeAvailability()).toBe(false);
  });

  it.each([
    { supported: false, installed: true, enabled: true },
    { supported: true, installed: false, enabled: true },
    { supported: true, installed: true, enabled: false },
  ])(
    'requires supported, installed, and enabled together: %j',
    async (flags) => {
      mockStatus.mockResolvedValue(status(flags));
      await expect(isCursorRuntimeAvailable()).resolves.toBe(false);
      expect(peekCursorRuntimeAvailability()).toBe(false);
    },
  );

  it('never probes for the synchronous peek', async () => {
    mockStatus.mockResolvedValue(status({}));
    await refreshCursorRuntimeAvailability();
    mockStatus.mockClear();
    expect(peekCursorRuntimeAvailability()).toBe(true);
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it('keeps the newer refresh result when an older, overlapping refresh resolves later', async () => {
    // Status IPC background refresh, Connect/Disconnect, and Portal sends can
    // all trigger overlapping refreshes. A slower EARLIER call finishing after
    // a newer one must not clobber the cache with its stale answer.
    let resolveFirst: (value: CursorConnectionStatus) => void = () => {};
    const firstStatus = new Promise<CursorConnectionStatus>((resolve) => {
      resolveFirst = resolve;
    });
    mockStatus.mockImplementationOnce(() => firstStatus);
    mockStatus.mockImplementationOnce(() => Promise.resolve(status({})));

    const firstRefresh = refreshCursorRuntimeAvailability();
    const secondRefresh = refreshCursorRuntimeAvailability();

    await expect(secondRefresh).resolves.toBe(true);
    resolveFirst(status({ installed: false }));
    await expect(firstRefresh).resolves.toBe(false);

    expect(peekCursorRuntimeAvailability()).toBe(true);
  });

  it('returns the full status from probeCursorRuntimeStatus and caches the derived availability alongside it', async () => {
    mockStatus.mockResolvedValue(status({}));
    await expect(probeCursorRuntimeStatus()).resolves.toEqual(status({}));
    expect(peekCursorRuntimeAvailability()).toBe(true);

    mockStatus.mockResolvedValue(status({ installed: false }));
    await expect(probeCursorRuntimeStatus()).resolves.toEqual(
      status({ installed: false }),
    );
    expect(peekCursorRuntimeAvailability()).toBe(false);
  });

  it('lets a newer refresh win over a slower, earlier-started probe — the status-IPC double-probe race this shared path replaced', async () => {
    // A status IPC call runs `readPreferencesFile()` plus an `lstat`/`access`
    // per required runtime file, so it can be slow. If a Disconnect refresh
    // starts and finishes WHILE that status call is still pending, the status
    // call's stale "connected" answer must not overwrite Disconnect's newer
    // "false" when it finally resolves — the exact regression an earlier
    // version of `seedCursorRuntimeAvailability` reintroduced by minting its
    // cache-write generation only after its own probe had already resolved,
    // instead of before the probe's first await like every other caller here.
    let resolveSlowStatusCall: (
      value: CursorConnectionStatus,
    ) => void = () => {};
    const slowStatusCall = new Promise<CursorConnectionStatus>((resolve) => {
      resolveSlowStatusCall = resolve;
    });
    mockStatus.mockImplementationOnce(() => slowStatusCall);
    mockStatus.mockImplementationOnce(() =>
      Promise.resolve(status({ installed: false })),
    );

    const slowProbe = probeCursorRuntimeStatus();
    const disconnectRefresh = refreshCursorRuntimeAvailability();

    await expect(disconnectRefresh).resolves.toBe(false);
    expect(peekCursorRuntimeAvailability()).toBe(false);

    resolveSlowStatusCall(status({}));
    await expect(slowProbe).resolves.toEqual(status({}));

    // The slow probe started before the disconnect refresh, so its answer —
    // even though it resolves LAST — must not clobber the cache.
    expect(peekCursorRuntimeAvailability()).toBe(false);
  });

  it('does not evaluate the runtime-status module until availability is first checked', async () => {
    // Runs last on purpose. A reset registry gives a fresh
    // runtime-availability instance: loading it alone must leave the status
    // module (and its build-constant read) untouched until the first check.
    jest.resetModules();
    mockStatusModuleEvaluations.mockClear();
    const fresh: { isCursorRuntimeAvailable: () => Promise<boolean> } =
      jest.requireActual('../cursor/runtime-availability');
    expect(mockStatusModuleEvaluations).not.toHaveBeenCalled();
    mockStatus.mockResolvedValue(status({}));
    await expect(fresh.isCursorRuntimeAvailable()).resolves.toBe(true);
    expect(mockStatusModuleEvaluations).toHaveBeenCalledTimes(1);
  });
});
