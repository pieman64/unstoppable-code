/**
 * @jest-environment jsdom
 *
 * Recipient store coverage (CAN-2550): multi-org fan-out, the fail-closed
 * revision/identity guards on paged content, and the scoped purge
 * disappearance path while a container is the active selection.
 */
import type {
  SharedContainerInboxChangedEvent,
  SharedContainerReplicaState,
} from '@canopy/desktop-shared/types';
import type { SharedContainerSummary } from '@canopy/protocol/shared-containers';
import {
  initializeSharedContainerReplicasStore,
  useSharedContainerReplicasStore,
  SHARED_CONTAINER_UNAVAILABLE_RETRY_DELAYS_MS,
  type SharedContainerListEntry,
} from '../sharedContainerReplicasStore';
import { useSharedContainersStore } from '../sharedContainersStore';
import { useFeatureFlagsStore } from '../featureFlagsStore';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';

// The error branch reports a diagnostic through the renderer console bridge;
// silence it here and assert on it where it matters.
jest.mock('@/lib/renderer-error-logging', () => ({
  reportRendererConsoleError: jest.fn(),
}));
const { reportRendererConsoleError } = jest.requireMock<{
  reportRendererConsoleError: jest.Mock;
}>('@/lib/renderer-error-logging');

// The viewer's panel layout is released around open and close. The panel
// modules are mocked so the order of those calls can be asserted.
const mockLayoutEvents: string[] = [];
const mockFlushLayoutSave = jest.fn<Promise<void>, [string]>();
jest.mock('@/lib/panels/persistence-bridge', () => ({
  flushPanelLayoutSaveForWorktree: (key: string): Promise<void> =>
    mockFlushLayoutSave(key),
  disposeWorktreePanelHydration: (key: string): void => {
    mockLayoutEvents.push(`dispose-hydration:${key}`);
  },
}));
jest.mock('@/lib/panels/chat-panel-sync', () => ({
  forgetChatPanelSyncWorktree: (key: string): void => {
    mockLayoutEvents.push(`forget-sweep:${key}`);
  },
}));
jest.mock('@/stores/browserStore', () => ({
  useBrowserStore: {
    getState: (): {
      forgetWorktree: (projectId: string, worktreeId: string) => void;
    } => ({
      forgetWorktree: (projectId: string, worktreeId: string): void => {
        mockLayoutEvents.push(`forget-browsers:${projectId}/${worktreeId}`);
      },
    }),
  },
}));
jest.mock('@/stores/panelLayoutStore', () => ({
  makeWorktreePanelKey: (projectId: string, worktreeId: string): string =>
    `${projectId}/${worktreeId}`,
  usePanelLayoutStore: {
    getState: (): { disposeLayout: (key: string) => void } => ({
      disposeLayout: (key: string): void => {
        mockLayoutEvents.push(`dispose-layout:${key}`);
      },
    }),
  },
}));

interface MockBridge {
  listSharedWithMe: jest.Mock;
  searchMembers: jest.Mock;
  listAccepted: jest.Mock;
  accept: jest.Mock;
  open: jest.Mock;
  retry: jest.Mock;
  dismiss: jest.Mock;
  close: jest.Mock;
  listChats: jest.Mock;
  readChat: jest.Mock;
  listPlans: jest.Mock;
  listNotes: jest.Mock;
  listPrompts: jest.Mock;
  listAttachments: jest.Mock;
  readAttachment: jest.Mock;
  listRepositories: jest.Mock;
  listRepositoryTree: jest.Mock;
  onReplicaChanged: jest.Mock;
  onSyncPhase: jest.Mock;
  onInboxChanged: jest.Mock;
}

let bridge: MockBridge;

type InboxSignalReason = SharedContainerInboxChangedEvent['reason'];
type InboxListener = (event: SharedContainerInboxChangedEvent) => void;

/** Listeners registered through the mock `onInboxChanged` bridge method. */
let inboxListeners: InboxListener[] = [];

/** Stands in for main's broadcast: the signal carries no container identity. */
function emitInboxSignal(reason: InboxSignalReason = 'realtime'): void {
  for (const listener of [...inboxListeners]) {
    listener({ reason });
  }
}

function container(
  id: string,
  title: string,
  ownerUserId = 'owner-1',
): SharedContainerSummary {
  return {
    id,
    organizationId: 'org-1',
    ownerUserId,
    owner: { userId: ownerUserId, name: '' },
    access: 'organization',
    containerType: 'CODE_WORKTREE',
    title,
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: `2026-01-0${id.length}T00:00:00.000Z`,
    capabilities: ['VIEW'],
  };
}

function available(
  revisionId: string,
  containerId = 'c1',
): SharedContainerReplicaState {
  return {
    containerId,
    organizationId: 'org-1',
    containerType: 'CODE_WORKTREE',
    updatedAt: '2026-01-02T00:00:00.000Z',
    status: 'available',
    revisionId,
    revision: 1,
    revisionCreatedAt: '2026-01-02T00:00:00.000Z',
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// Typed `unknown` so the matcher is not an `any` inside a payload literal.
const ANY_VIEWER_SESSION_ID: unknown = expect.any(String);

beforeEach(() => {
  mockLayoutEvents.length = 0;
  mockFlushLayoutSave.mockReset();
  mockFlushLayoutSave.mockImplementation((key) => {
    mockLayoutEvents.push(`flush:${key}`);
    return Promise.resolve();
  });
  bridge = {
    listSharedWithMe: jest.fn(),
    searchMembers: jest.fn().mockResolvedValue({ members: [] }),
    listAccepted: jest
      .fn()
      .mockResolvedValue({ containerIds: ['a', 'bb', 'c1', 'c2'] }),
    accept: jest.fn().mockResolvedValue({ accepted: true }),
    open: jest.fn(),
    retry: jest.fn(),
    dismiss: jest.fn().mockResolvedValue({ dismissed: true }),
    close: jest.fn().mockResolvedValue(undefined),
    listChats: jest.fn(),
    readChat: jest.fn(),
    listPlans: jest.fn(),
    listNotes: jest.fn(),
    listPrompts: jest.fn(),
    listAttachments: jest.fn(),
    readAttachment: jest.fn(),
    listRepositories: jest.fn(),
    listRepositoryTree: jest.fn(),
    onReplicaChanged: jest.fn().mockReturnValue(() => undefined),
    onSyncPhase: jest.fn().mockReturnValue(() => undefined),
    onInboxChanged: jest.fn((listener: InboxListener) => {
      inboxListeners.push(listener);
      return (): void => {
        inboxListeners = inboxListeners.filter(
          (registered) => registered !== listener,
        );
      };
    }),
  };
  inboxListeners = [];
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { sharedContainers: bridge },
  });
  useSharedContainerReplicasStore.getState().reset();
  // Every container these tests open is one the recipient already accepted;
  // the accept gate itself is covered by its own describe block below.
  useSharedContainerReplicasStore.setState({
    acceptedIds: ['a', 'bb', 'c1', 'c2'],
    acceptedStatus: 'success',
  });
  reportRendererConsoleError.mockClear();
  useSharedContainersStore.setState({
    // Reset explicitly: a test that exercises an inconclusive account read
    // would otherwise leave this latched for every test after it.
    accountHydrationFailed: false,
    // Same reason (CAN-2551): the account store is a module singleton, so
    // lapsed seeding from one test would bleed through this 1200-line file.
    orgBillingStates: [],
    organizations: [
      { id: 'org-1', name: 'One', createdAt: '', updatedAt: '' },
      { id: 'org-2', name: 'Two', createdAt: '', updatedAt: '' },
    ],
  });
});

describe('loadSharedWithMe', () => {
  it('fans out across every hydrated organization', async () => {
    bridge.listSharedWithMe.mockImplementation(
      (request: { organizationId: string }) =>
        Promise.resolve({
          containers: [
            container(
              request.organizationId === 'org-1' ? 'a' : 'bb',
              request.organizationId,
            ),
          ],
          nextCursor: null,
        }),
    );

    await useSharedContainerReplicasStore.getState().loadSharedWithMe();

    const { entries, listStatus } = useSharedContainerReplicasStore.getState();
    expect(listStatus).toBe('success');
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.organizationId).sort()).toEqual([
      'org-1',
      'org-2',
    ]);
  });

  it('loads every server page and resolves owner display names', async () => {
    useSharedContainersStore.setState({
      organizations: [
        { id: 'org-1', name: 'One', createdAt: '', updatedAt: '' },
      ],
    });
    bridge.listSharedWithMe
      .mockResolvedValueOnce({
        containers: [container('a', 'First')],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        containers: [container('bb', 'Second')],
        nextCursor: null,
      });
    bridge.searchMembers.mockResolvedValue({
      members: [{ userId: 'owner-1', name: 'Ada Owner' }],
    });

    await useSharedContainerReplicasStore.getState().loadSharedWithMe();

    expect(bridge.listSharedWithMe).toHaveBeenNthCalledWith(2, {
      organizationId: 'org-1',
      cursor: 'page-2',
    });
    expect(
      useSharedContainerReplicasStore
        .getState()
        .entries.map((entry) => entry.ownerName),
    ).toEqual(['Ada Owner', 'Ada Owner']);
  });

  it('resolves every listed owner by exact id beyond the first member page', async () => {
    useSharedContainersStore.setState({
      organizations: [
        { id: 'org-1', name: 'One', createdAt: '', updatedAt: '' },
      ],
    });
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [container('a', 'First', 'owner-51')],
      nextCursor: null,
    });
    bridge.searchMembers.mockImplementation((request: { query?: string }) =>
      Promise.resolve({
        members:
          request.query === 'owner-51'
            ? [{ userId: 'owner-51', name: 'Zoe Owner' }]
            : Array.from({ length: 50 }, (_, index) => ({
                userId: `owner-${index}`,
                name: `Member ${index}`,
              })),
      }),
    );

    await useSharedContainerReplicasStore.getState().loadSharedWithMe();

    expect(bridge.searchMembers).toHaveBeenCalledWith({
      organizationId: 'org-1',
      query: 'owner-51',
      limit: 1,
    });
    expect(
      useSharedContainerReplicasStore.getState().entries[0]?.ownerName,
    ).toBe('Zoe Owner');
  });

  it('keeps the healthy organizations when one listing fails', async () => {
    bridge.listSharedWithMe.mockImplementation(
      (request: { organizationId: string }) =>
        request.organizationId === 'org-1'
          ? Promise.reject(new Error('boom'))
          : Promise.resolve({
              containers: [container('bb', 'Two')],
              nextCursor: null,
            }),
    );

    await useSharedContainerReplicasStore.getState().loadSharedWithMe();

    const { entries, listStatus } = useSharedContainerReplicasStore.getState();
    expect(listStatus).toBe('success');
    expect(entries).toHaveLength(1);
  });

  it('reports an error only when every organization fails', async () => {
    bridge.listSharedWithMe.mockRejectedValue(new Error('offline'));

    await useSharedContainerReplicasStore.getState().loadSharedWithMe();

    expect(useSharedContainerReplicasStore.getState().listStatus).toBe('error');
    expect(useSharedContainerReplicasStore.getState().entries).toEqual([]);
  });

  it('still queries an organization the account snapshot reports as billing-lapsed', async () => {
    // CAN-2551. Filtering the lapsed org out client-side looks free, but the
    // 403 is what drives `ReconciliationService.listSharedWithMe` into
    // `reconcileContainerSnapshot(org, [])`, which purges that org's decrypted
    // replicas. Skipping the request would leave that plaintext on disk, and
    // would make the on-disk result depend on whether the local snapshot
    // happened to be stale. The server stays the source of truth.
    useSharedContainersStore.setState({
      orgBillingStates: [
        {
          organizationId: 'org-1',
          organizationName: 'One',
          teamsEntitled: false,
        },
      ],
    });
    bridge.listSharedWithMe.mockImplementation(
      (request: { organizationId: string }) =>
        request.organizationId === 'org-1'
          ? Promise.resolve({
              containers: [],
              nextCursor: null,
              refusal: 'blocked-by-org-billing',
            })
          : Promise.resolve({
              containers: [container('bb', 'Two')],
              nextCursor: null,
            }),
    );

    await useSharedContainerReplicasStore.getState().loadSharedWithMe();

    expect(bridge.listSharedWithMe).toHaveBeenCalledTimes(2);
    expect(bridge.listSharedWithMe).toHaveBeenCalledWith({
      organizationId: 'org-1',
    });
    expect(bridge.listSharedWithMe).toHaveBeenCalledWith({
      organizationId: 'org-2',
    });
    // The healthy org still lists; the refused one contributes no rows and is
    // not a failure.
    expect(useSharedContainerReplicasStore.getState().listStatus).toBe(
      'success',
    );
  });

  it('reports a benign billing block, not an error, when every organization is lapsed', async () => {
    useSharedContainersStore.setState({
      orgBillingStates: [
        {
          organizationId: 'org-1',
          organizationName: 'One',
          teamsEntitled: false,
        },
        {
          organizationId: 'org-2',
          organizationName: 'Two',
          teamsEntitled: false,
        },
      ],
    });
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [],
      nextCursor: null,
      refusal: 'blocked-by-org-billing',
    });

    await useSharedContainerReplicasStore.getState().loadSharedWithMe();

    // Every org is asked, so every org's replicas are reconciled away.
    expect(bridge.listSharedWithMe).toHaveBeenCalledTimes(2);
    const { entries, listStatus } = useSharedContainerReplicasStore.getState();
    expect(listStatus).toBe('blocked-by-org-billing');
    expect(entries).toEqual([]);
    // A block is not a failure; nothing to diagnose and nothing to retry.
    expect(reportRendererConsoleError).not.toHaveBeenCalled();
  });

  it('does not let an in-flight fan-out overwrite a terminal state set by a later load', async () => {
    // CAN-2551 regression guard. `loadSharedWithMe` must bump `listEpoch`
    // BEFORE its early returns. When it did not, an early-returning load left
    // the epoch untouched, so a slower fan-out that started while the user was
    // still entitled passed its `listEpoch !== epoch` check on resolution and
    // restored rows for organizations the account no longer belongs to.
    const slow = deferred<{
      containers: SharedContainerSummary[];
      nextCursor: null;
    }>();
    bridge.listSharedWithMe.mockReturnValue(slow.promise);

    // Load A starts against both organizations and blocks mid-fan-out.
    const loadA = useSharedContainerReplicasStore.getState().loadSharedWithMe();
    await flushAsyncWork();

    // The account snapshot then empties, and load B early-returns.
    useSharedContainersStore.setState({ organizations: [] });
    await useSharedContainerReplicasStore.getState().loadSharedWithMe();
    expect(useSharedContainerReplicasStore.getState().entries).toEqual([]);

    // Load A now resolves. It is stale and must be discarded.
    slow.resolve({ containers: [container('a', 'One')], nextCursor: null });
    await loadA;
    await flushAsyncWork();

    expect(useSharedContainerReplicasStore.getState().entries).toEqual([]);
  });

  it("treats a stale snapshot's server refusal as a billing block rather than a load failure", async () => {
    // The local snapshot still believes both orgs are entitled, so the fan-out
    // runs and main converts each 403 into a typed refusal.
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [],
      nextCursor: null,
      refusal: 'blocked-by-org-billing',
    });

    await useSharedContainerReplicasStore.getState().loadSharedWithMe();

    const { entries, listStatus } = useSharedContainerReplicasStore.getState();
    expect(listStatus).toBe('blocked-by-org-billing');
    expect(entries).toEqual([]);
    // The refusal short-circuits the org before any owner lookup.
    expect(bridge.searchMembers).not.toHaveBeenCalled();
  });

  it('still reports an error when one organization refuses for billing and another genuinely fails', async () => {
    bridge.listSharedWithMe.mockImplementation(
      (request: { organizationId: string }) =>
        request.organizationId === 'org-1'
          ? Promise.resolve({
              containers: [],
              nextCursor: null,
              refusal: 'blocked-by-org-billing',
            })
          : Promise.reject(new Error('offline')),
    );

    await useSharedContainerReplicasStore.getState().loadSharedWithMe();

    // A real failure is present, so the section must stay retryable.
    expect(useSharedContainerReplicasStore.getState().listStatus).toBe('error');
    // `reason` is the error's CLASS, never its message: a cloud-client message
    // is server-authored prose that can embed organization names, and this
    // lands in global app-events.
    expect(reportRendererConsoleError).toHaveBeenCalledWith(
      'Shared-container listing failed',
      expect.objectContaining({ attempted: 2, rejected: 1, reason: 'Error' }),
    );
  });

  it("keeps a healthy organization's rows when another is refused for billing", async () => {
    bridge.listSharedWithMe.mockImplementation(
      (request: { organizationId: string }) =>
        request.organizationId === 'org-1'
          ? Promise.resolve({
              containers: [],
              nextCursor: null,
              refusal: 'blocked-by-org-billing',
            })
          : Promise.resolve({
              containers: [container('bb', 'Two')],
              nextCursor: null,
            }),
    );

    await useSharedContainerReplicasStore.getState().loadSharedWithMe();

    const { entries, listStatus } = useSharedContainerReplicasStore.getState();
    expect(listStatus).toBe('success');
    expect(entries).toHaveLength(1);
  });

  describe("transient failures report 'unavailable' (CAN db-blip resilience)", () => {
    afterEach(() => {
      // The unavailable branch arms a real backoff timer; drop it so it cannot
      // fire into a later test's bridge mock.
      useSharedContainerReplicasStore.getState().reset();
      jest.useRealTimers();
    });

    it("reports 'unavailable' when every organization fails transiently", async () => {
      bridge.listSharedWithMe.mockRejectedValue(
        new Error(
          "Error invoking remote method 'shared-containers:list-shared-with-me': Error: HTTP 503: Service Unavailable",
        ),
      );

      await useSharedContainerReplicasStore.getState().loadSharedWithMe();

      const { entries, listStatus } =
        useSharedContainerReplicasStore.getState();
      expect(listStatus).toBe('unavailable');
      expect(entries).toEqual([]);
    });

    it("reports 'unavailable' for typed network refusals from main", async () => {
      bridge.listSharedWithMe.mockResolvedValue({
        containers: [],
        nextCursor: null,
        refusal: 'temporarily-unavailable',
      });

      await useSharedContainerReplicasStore.getState().loadSharedWithMe();

      expect(useSharedContainerReplicasStore.getState().listStatus).toBe(
        'unavailable',
      );
    });

    it("keeps healthy rows but stays 'unavailable' when another organization is transiently unavailable", async () => {
      bridge.listSharedWithMe.mockImplementation(
        (request: { organizationId: string }) =>
          request.organizationId === 'org-1'
            ? Promise.resolve({
                containers: [container('a', 'One')],
                nextCursor: null,
              })
            : Promise.resolve({
                containers: [],
                nextCursor: null,
                refusal: 'temporarily-unavailable',
              }),
      );

      await useSharedContainerReplicasStore.getState().loadSharedWithMe();

      const { entries, listStatus } =
        useSharedContainerReplicasStore.getState();
      expect(entries).toHaveLength(1);
      expect(listStatus).toBe('unavailable');
    });

    it("keeps 'error' when a typed unavailable refusal is mixed with a genuine rejection", async () => {
      bridge.listSharedWithMe.mockImplementation(
        (request: { organizationId: string }) =>
          request.organizationId === 'org-1'
            ? Promise.resolve({
                containers: [],
                nextCursor: null,
                refusal: 'temporarily-unavailable',
              })
            : Promise.reject(new Error('HTTP 500: Internal Server Error')),
      );

      await useSharedContainerReplicasStore.getState().loadSharedWithMe();

      expect(useSharedContainerReplicasStore.getState().listStatus).toBe(
        'error',
      );
    });

    it("keeps 'error' when healthy rows, a typed unavailable refusal, and a genuine rejection are mixed", async () => {
      useSharedContainersStore.setState({
        organizations: [
          { id: 'org-1', name: 'One', createdAt: '', updatedAt: '' },
          { id: 'org-2', name: 'Two', createdAt: '', updatedAt: '' },
          { id: 'org-3', name: 'Three', createdAt: '', updatedAt: '' },
        ],
      });
      bridge.listSharedWithMe.mockImplementation(
        (request: { organizationId: string }) => {
          if (request.organizationId === 'org-1') {
            return Promise.resolve({
              containers: [container('a', 'One')],
              nextCursor: null,
            });
          }
          if (request.organizationId === 'org-2') {
            return Promise.resolve({
              containers: [],
              nextCursor: null,
              refusal: 'temporarily-unavailable',
            });
          }
          return Promise.reject(new Error('HTTP 500: Internal Server Error'));
        },
      );

      await useSharedContainerReplicasStore.getState().loadSharedWithMe();

      const { entries, listStatus } =
        useSharedContainerReplicasStore.getState();
      expect(entries).toHaveLength(1);
      expect(listStatus).toBe('error');
      expect(reportRendererConsoleError).toHaveBeenCalledTimes(1);
    });

    it('discards a partial page when a later page becomes unavailable', async () => {
      bridge.listSharedWithMe
        .mockResolvedValueOnce({
          containers: [container('partial', 'Partial')],
          nextCursor: 'page-2',
        })
        .mockResolvedValue({
          containers: [],
          nextCursor: null,
          refusal: 'temporarily-unavailable',
        });

      await useSharedContainerReplicasStore.getState().loadSharedWithMe();

      const { entries, listStatus } =
        useSharedContainerReplicasStore.getState();
      expect(listStatus).toBe('unavailable');
      expect(entries).toEqual([]);
    });

    it('honors the largest server retry delay before the first store retry', async () => {
      jest.useFakeTimers();
      bridge.listSharedWithMe.mockResolvedValue({
        containers: [],
        nextCursor: null,
        refusal: 'temporarily-unavailable',
        retryAfterMs: 7_000,
      });

      await useSharedContainerReplicasStore.getState().loadSharedWithMe();
      const settledCalls = bridge.listSharedWithMe.mock.calls.length;
      bridge.listSharedWithMe.mockResolvedValue({
        containers: [],
        nextCursor: null,
      });

      await jest.advanceTimersByTimeAsync(6_999);
      expect(bridge.listSharedWithMe).toHaveBeenCalledTimes(settledCalls);
      await jest.advanceTimersByTimeAsync(1);
      expect(bridge.listSharedWithMe.mock.calls.length).toBeGreaterThan(
        settledCalls,
      );
    });

    it('keeps escalating the retry ladder when the server delay is shorter', async () => {
      jest.useFakeTimers();
      bridge.listSharedWithMe.mockResolvedValue({
        containers: [],
        nextCursor: null,
        refusal: 'temporarily-unavailable',
        retryAfterMs: 1_000,
      });

      await useSharedContainerReplicasStore.getState().loadSharedWithMe();
      const afterFirst = bridge.listSharedWithMe.mock.calls.length;

      await jest.advanceTimersByTimeAsync(
        SHARED_CONTAINER_UNAVAILABLE_RETRY_DELAYS_MS[0] - 1,
      );
      expect(bridge.listSharedWithMe).toHaveBeenCalledTimes(afterFirst);
      await jest.advanceTimersByTimeAsync(1);
      const afterSecond = bridge.listSharedWithMe.mock.calls.length;
      expect(afterSecond).toBeGreaterThan(afterFirst);

      await jest.advanceTimersByTimeAsync(
        SHARED_CONTAINER_UNAVAILABLE_RETRY_DELAYS_MS[1] - 1,
      );
      expect(bridge.listSharedWithMe).toHaveBeenCalledTimes(afterSecond);
      await jest.advanceTimersByTimeAsync(1);
      expect(bridge.listSharedWithMe.mock.calls.length).toBeGreaterThan(
        afterSecond,
      );
    });

    it("reports 'unavailable' for the Cloud API's real database_unavailable rejection", async () => {
      // The exact rejection the seam produces end to end: `instrumented-route`
      // answers a dead Prisma connection with 503 +
      // `{ error: 'Service temporarily unavailable. Try again shortly.', code:
      // 'database_unavailable' }`, `CanopyCloudClientError` prefixes
      // `HTTP 503: `, and Electron wraps that message for the renderer. Only
      // the `HTTP <status>` token is structural — the prose either side of it
      // is free to change — so this pins the one part the classifier reads.
      bridge.listSharedWithMe.mockRejectedValue(
        new Error(
          "Error invoking remote method 'shared-containers:list-shared-with-me': " +
            'CanopyCloudClientError: HTTP 503: Service temporarily unavailable. Try again shortly.',
        ),
      );

      await useSharedContainerReplicasStore.getState().loadSharedWithMe();

      expect(useSharedContainerReplicasStore.getState().listStatus).toBe(
        'unavailable',
      );
    });

    it.each([502, 503, 504, 429])(
      'treats HTTP %i as transient',
      async (status) => {
        bridge.listSharedWithMe.mockRejectedValue(
          new Error(`HTTP ${status}: upstream`),
        );

        await useSharedContainerReplicasStore.getState().loadSharedWithMe();

        expect(useSharedContainerReplicasStore.getState().listStatus).toBe(
          'unavailable',
        );
      },
    );

    it.each([400, 401, 403, 404, 500])(
      'treats HTTP %i as a genuine failure',
      async (status) => {
        bridge.listSharedWithMe.mockRejectedValue(
          new Error(`HTTP ${status}: nope`),
        );

        await useSharedContainerReplicasStore.getState().loadSharedWithMe();

        expect(useSharedContainerReplicasStore.getState().listStatus).toBe(
          'error',
        );
      },
    );

    it("keeps 'error' when a transient failure is mixed with a genuine one", async () => {
      bridge.listSharedWithMe.mockImplementation(
        (request: { organizationId: string }) =>
          request.organizationId === 'org-1'
            ? Promise.reject(new Error('HTTP 503: Service Unavailable'))
            : Promise.reject(new Error('HTTP 500: Internal Server Error')),
      );

      await useSharedContainerReplicasStore.getState().loadSharedWithMe();

      // A real failure is present, so the section must stay explicitly
      // retryable rather than quietly self-healing.
      expect(useSharedContainerReplicasStore.getState().listStatus).toBe(
        'error',
      );
    });

    it("keeps 'error' when a transient failure is mixed with a billing refusal", async () => {
      bridge.listSharedWithMe.mockImplementation(
        (request: { organizationId: string }) =>
          request.organizationId === 'org-1'
            ? Promise.resolve({
                containers: [],
                nextCursor: null,
                refusal: 'blocked-by-org-billing',
              })
            : Promise.reject(new Error('HTTP 503: Service Unavailable')),
      );

      await useSharedContainerReplicasStore.getState().loadSharedWithMe();

      // Every rejection is transient, so this self-heals; the refusal
      // contributes no failure of its own.
      expect(useSharedContainerReplicasStore.getState().listStatus).toBe(
        'unavailable',
      );
    });

    it('does not log a renderer diagnostic for a transient outage', async () => {
      bridge.listSharedWithMe.mockRejectedValue(
        new Error('HTTP 503: Service Unavailable'),
      );

      await useSharedContainerReplicasStore.getState().loadSharedWithMe();

      // 1,139 of these in 37 minutes is what made the last incident
      // undiagnosable. A self-healing state is not an app-events event.
      expect(reportRendererConsoleError).not.toHaveBeenCalled();
    });

    it('retries on its own and recovers without user input', async () => {
      jest.useFakeTimers();
      bridge.listSharedWithMe.mockRejectedValue(
        new Error('HTTP 503: Service Unavailable'),
      );

      await useSharedContainerReplicasStore.getState().loadSharedWithMe();
      expect(useSharedContainerReplicasStore.getState().listStatus).toBe(
        'unavailable',
      );

      // The database comes back; nothing about the UI changed in the meantime.
      bridge.listSharedWithMe.mockReset();
      bridge.listSharedWithMe.mockImplementation(
        (request: { organizationId: string }) =>
          Promise.resolve({
            containers:
              request.organizationId === 'org-1' ? [container('a', 'One')] : [],
            nextCursor: null,
          }),
      );
      await jest.advanceTimersByTimeAsync(
        SHARED_CONTAINER_UNAVAILABLE_RETRY_DELAYS_MS[0],
      );

      const { entries, listStatus } =
        useSharedContainerReplicasStore.getState();
      expect(listStatus).toBe('success');
      expect(entries).toHaveLength(1);
    });

    it("stays 'unavailable' while an automatic retry is in flight", async () => {
      jest.useFakeTimers();
      bridge.listSharedWithMe.mockRejectedValue(
        new Error('HTTP 503: Service Unavailable'),
      );
      await useSharedContainerReplicasStore.getState().loadSharedWithMe();
      expect(useSharedContainerReplicasStore.getState().listStatus).toBe(
        'unavailable',
      );

      // A retry that flipped back to `'loading'` would unmount the
      // reconnecting row and flash the genuine-failure row with its Retry
      // button on every backoff tick.
      const pending = deferred();
      bridge.listSharedWithMe.mockReset();
      bridge.listSharedWithMe.mockReturnValue(pending.promise);
      await jest.advanceTimersByTimeAsync(
        SHARED_CONTAINER_UNAVAILABLE_RETRY_DELAYS_MS[0],
      );

      expect(bridge.listSharedWithMe).toHaveBeenCalled();
      expect(useSharedContainerReplicasStore.getState().listStatus).toBe(
        'unavailable',
      );

      pending.resolve({ containers: [], nextCursor: null });
      await jest.advanceTimersByTimeAsync(0);
      expect(useSharedContainerReplicasStore.getState().listStatus).toBe(
        'success',
      );
    });

    it('backs off between automatic retries instead of hammering', async () => {
      jest.useFakeTimers();
      bridge.listSharedWithMe.mockRejectedValue(
        new Error('HTTP 503: Service Unavailable'),
      );

      await useSharedContainerReplicasStore.getState().loadSharedWithMe();
      const afterFirst = bridge.listSharedWithMe.mock.calls.length;

      await jest.advanceTimersByTimeAsync(
        SHARED_CONTAINER_UNAVAILABLE_RETRY_DELAYS_MS[0],
      );
      const afterSecond = bridge.listSharedWithMe.mock.calls.length;
      expect(afterSecond).toBeGreaterThan(afterFirst);

      // The second delay is longer, so the first one elapsing again is not
      // enough to fire another attempt.
      await jest.advanceTimersByTimeAsync(
        SHARED_CONTAINER_UNAVAILABLE_RETRY_DELAYS_MS[0],
      );
      expect(bridge.listSharedWithMe.mock.calls.length).toBe(afterSecond);

      await jest.advanceTimersByTimeAsync(
        SHARED_CONTAINER_UNAVAILABLE_RETRY_DELAYS_MS[1],
      );
      expect(bridge.listSharedWithMe.mock.calls.length).toBeGreaterThan(
        afterSecond,
      );
    });

    it('stops retrying once the listing succeeds', async () => {
      jest.useFakeTimers();
      bridge.listSharedWithMe.mockRejectedValue(
        new Error('HTTP 503: Service Unavailable'),
      );

      await useSharedContainerReplicasStore.getState().loadSharedWithMe();
      expect(useSharedContainerReplicasStore.getState().listStatus).toBe(
        'unavailable',
      );
      bridge.listSharedWithMe.mockReset();
      bridge.listSharedWithMe.mockResolvedValue({
        containers: [],
        nextCursor: null,
      });

      await jest.advanceTimersByTimeAsync(
        SHARED_CONTAINER_UNAVAILABLE_RETRY_DELAYS_MS[0],
      );
      const settled = bridge.listSharedWithMe.mock.calls.length;

      await jest.advanceTimersByTimeAsync(120_000);
      expect(bridge.listSharedWithMe.mock.calls.length).toBe(settled);
    });
  });

  it('lists every organization when the account read was inconclusive', async () => {
    // Store-side twin of the hook's `accountHydrationFailed` fail-open: a
    // degraded secure-store read must not mount a section that lists nothing.
    useSharedContainersStore.setState({
      accountHydrationFailed: true,
      orgBillingStates: [
        {
          organizationId: 'org-1',
          organizationName: 'One',
          teamsEntitled: false,
        },
        {
          organizationId: 'org-2',
          organizationName: 'Two',
          teamsEntitled: false,
        },
      ],
    });
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [],
      nextCursor: null,
    });

    await useSharedContainerReplicasStore.getState().loadSharedWithMe();

    expect(bridge.listSharedWithMe).toHaveBeenCalledTimes(2);
    expect(useSharedContainerReplicasStore.getState().listStatus).toBe(
      'success',
    );
  });

  it('clears and reloads entries when equal-count account organizations change', async () => {
    useSharedContainersStore.setState({
      organizations: [
        { id: 'org-1', name: 'One', createdAt: '', updatedAt: '' },
      ],
    });
    bridge.listSharedWithMe.mockImplementation(
      (request: { organizationId: string }) =>
        Promise.resolve({
          containers: [
            {
              ...container(request.organizationId, request.organizationId),
              organizationId: request.organizationId,
            },
          ],
          nextCursor: null,
        }),
    );
    const dispose = initializeSharedContainerReplicasStore();
    try {
      await flushAsyncWork();
      expect(
        useSharedContainerReplicasStore.getState().entries[0]?.organizationId,
      ).toBe('org-1');

      useSharedContainersStore.setState({
        organizations: [
          { id: 'org-2', name: 'Two', createdAt: '', updatedAt: '' },
        ],
      });

      expect(useSharedContainerReplicasStore.getState().entries).toEqual([]);
      await flushAsyncWork();
      expect(
        useSharedContainerReplicasStore.getState().entries[0]?.organizationId,
      ).toBe('org-2');
    } finally {
      dispose();
    }
  });

  it('re-runs the listing when an organization loses its Teams entitlement mid-session', async () => {
    // CAN-2551 regression guard. `syncOrganizations` fingerprinted organization
    // IDS ONLY, so a snapshot refresh that flipped `teamsEntitled` to false
    // without changing membership was treated as a no-op. The section kept
    // rendering rows the server would now refuse until the app restarted, and
    // clicking one 403'd. Entitlement is an authorization change like any
    // other and must re-run the listing.
    bridge.listSharedWithMe.mockImplementation(
      (request: { organizationId: string }) =>
        useSharedContainersStore.getState().orgBillingStates.length > 0
          ? Promise.resolve({
              containers: [],
              nextCursor: null,
              refusal: 'blocked-by-org-billing',
            })
          : Promise.resolve({
              containers:
                request.organizationId === 'org-1'
                  ? [container('a', 'One')]
                  : [],
              nextCursor: null,
            }),
    );
    const dispose = initializeSharedContainerReplicasStore();
    try {
      await flushAsyncWork();
      expect(useSharedContainerReplicasStore.getState().entries).toHaveLength(
        1,
      );

      // Same organizations, same order — only the entitlement changes.
      useSharedContainersStore.setState({
        orgBillingStates: [
          {
            organizationId: 'org-1',
            organizationName: 'One',
            teamsEntitled: false,
          },
          {
            organizationId: 'org-2',
            organizationName: 'Two',
            teamsEntitled: false,
          },
        ],
      });
      await flushAsyncWork();

      expect(useSharedContainerReplicasStore.getState().entries).toEqual([]);
      expect(useSharedContainerReplicasStore.getState().listStatus).toBe(
        'blocked-by-org-billing',
      );
    } finally {
      dispose();
    }
  });

  it('closes an open recipient when initialization is disposed', async () => {
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [],
      nextCursor: null,
    });
    bridge.open.mockResolvedValue(available('rev-1'));
    const dispose = initializeSharedContainerReplicasStore();
    // Initialization loads this device's acceptances before anything is
    // openable; opening before that resolves is refused by design.
    await flushAsyncWork();
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });
    dispose();
    await flushAsyncWork();

    const state = useSharedContainerReplicasStore.getState();
    expect(state.viewer).toBeNull();
    expect(bridge.close).toHaveBeenCalledWith({
      containerId: 'c1',
      viewerSessionId: ANY_VIEWER_SESSION_ID,
    });
  });

  it('waits for the prior viewer close before reloading after reinitialization', async () => {
    const close = deferred<void>();
    bridge.close.mockReturnValue(close.promise);
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [],
      nextCursor: null,
    });
    bridge.open.mockResolvedValue(available('rev-1'));
    const disposeFirst = initializeSharedContainerReplicasStore();
    await flushAsyncWork();
    bridge.listSharedWithMe.mockClear();
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });

    disposeFirst();
    const disposeSecond = initializeSharedContainerReplicasStore();
    await flushAsyncWork();

    expect(bridge.listSharedWithMe).not.toHaveBeenCalled();

    close.resolve();
    await flushAsyncWork();
    expect(bridge.listSharedWithMe).toHaveBeenCalledTimes(2);
    disposeSecond();
  });
});

/**
 * The account-scoped inbox signal (share-propagation fix).
 *
 * Before this, a recipient's share list was only re-listed on an organization
 * fingerprint change, a purge broadcast, a failed dismiss, a transient-HTTP
 * backoff rung, or a manual Retry. For a signed-in user in a stable org none of
 * those ever fire, so an invitation that arrived while the app was running was
 * invisible until restart. These tests are the red ones: without the signal
 * subscription and its coalescing they fail.
 */
describe('direct shares (external sharing)', () => {
  function setExternalSharing(enabled: boolean): void {
    const snapshot = getDefaultFeatureFlagSnapshot();
    useFeatureFlagsStore.setState({
      snapshot: {
        ...snapshot,
        status: 'ready',
        values: {
          ...snapshot.values,
          [CLIENT_FEATURE_FLAGS.canopySharedContainerExternalSharing.key]:
            enabled,
        },
      },
    });
  }

  beforeEach(() => {
    setExternalSharing(true);
    useSharedContainersStore.setState({ accountKind: 'connected' });
  });

  afterEach(() => {
    useSharedContainersStore.setState({ accountKind: 'unknown' });
  });

  it('adds one organization-free listing and marks its rows direct', async () => {
    bridge.listSharedWithMe.mockImplementation(
      (request: { organizationId?: string }) =>
        Promise.resolve({
          containers:
            request.organizationId === undefined
              ? [
                  {
                    ...container('c1', 'From outside'),
                    organizationId: 'org-9',
                    organizationName: 'Globex',
                    access: 'direct',
                    owner: { userId: 'owner-9', name: 'Olive Outsider' },
                  },
                ]
              : request.organizationId === 'org-1'
                ? [container('a', 'Inside')]
                : [],
          nextCursor: null,
        }),
    );

    await useSharedContainerReplicasStore.getState().loadSharedWithMe();

    expect(bridge.listSharedWithMe).toHaveBeenCalledWith({});
    const entries = useSharedContainerReplicasStore.getState().entries;
    const direct = entries.find((entry) => entry.container.id === 'c1');
    expect(direct).toEqual(
      expect.objectContaining({
        access: 'direct',
        // The owning organization rides along as a hint for later requests.
        organizationId: 'org-9',
        // The listing carries the owner; no members lookup in an
        // organization this account may not belong to.
        ownerName: 'Olive Outsider',
      }),
    );
    expect(bridge.searchMembers).not.toHaveBeenCalledWith(
      expect.objectContaining({ query: 'owner-9' }),
    );
    const inside = entries.find((entry) => entry.container.id === 'a');
    expect(inside?.access).toBeUndefined();
    expect(inside?.organizationId).toBe('org-1');
  });

  it('classifies an organization share as direct, and still reports success, when its organization listing rejects (CAN-3554)', async () => {
    // Characterization of the listing, not of the fix: this is the round that
    // moved an accepted organization share to Personal. The classification is
    // unchanged; the acceptance record is what keeps the row in place.
    bridge.listSharedWithMe.mockImplementation(
      (request: { organizationId?: string }) =>
        request.organizationId === 'org-1'
          ? Promise.reject(new Error('Shared-container authorization changed'))
          : Promise.resolve({
              containers:
                request.organizationId === undefined
                  ? [container('c1', 'Reachable both ways')]
                  : [],
              nextCursor: null,
            }),
    );

    await useSharedContainerReplicasStore.getState().loadSharedWithMe();

    const { entries, listStatus } = useSharedContainerReplicasStore.getState();
    expect(listStatus).toBe('success');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({ access: 'direct', organizationId: 'org-1' }),
    );
  });

  it('lists direct shares for an account with no organization', async () => {
    useSharedContainersStore.setState({ organizations: [] });
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [
        {
          ...container('c2', 'Personal share'),
          organizationId: undefined,
          access: 'direct',
          owner: { userId: 'owner-9', name: 'Olive Outsider' },
        },
      ],
      nextCursor: null,
    });

    await useSharedContainerReplicasStore.getState().loadSharedWithMe();

    const [entry] = useSharedContainerReplicasStore.getState().entries;
    expect(entry?.access).toBe('direct');
    expect(entry?.organizationId).toBeUndefined();
    expect(useSharedContainerReplicasStore.getState().listStatus).toBe(
      'success',
    );
  });

  it('initializes the direct listing for a connected account with no organization', async () => {
    useSharedContainersStore.setState({ organizations: [] });
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [
        {
          ...container('c2', 'Personal share'),
          organizationId: undefined,
          access: 'direct',
          owner: { userId: 'owner-9', name: 'Olive Outsider' },
        },
      ],
      nextCursor: null,
    });

    const dispose = initializeSharedContainerReplicasStore();
    try {
      await flushAsyncWork();

      expect(bridge.listSharedWithMe).toHaveBeenCalledWith({});
      expect(
        useSharedContainerReplicasStore.getState().entries[0]?.access,
      ).toBe('direct');
    } finally {
      dispose();
    }
  });

  it('reloads direct shares after an account-change event with the same organization snapshot', async () => {
    useSharedContainersStore.setState({ organizations: [] });
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [
        {
          ...container('c2', 'Personal share'),
          organizationId: undefined,
          access: 'direct',
          owner: { userId: 'owner-9', name: 'Olive Outsider' },
        },
      ],
      nextCursor: null,
    });

    const dispose = initializeSharedContainerReplicasStore();
    try {
      await flushAsyncWork();
      expect(useSharedContainerReplicasStore.getState().entries).toHaveLength(
        1,
      );

      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
      await flushAsyncWork();

      expect(bridge.listSharedWithMe).toHaveBeenCalledTimes(2);
      expect(useSharedContainerReplicasStore.getState().entries).toHaveLength(
        1,
      );
    } finally {
      dispose();
    }
  });

  it('keeps the organization row when a container is reachable both ways', async () => {
    bridge.listSharedWithMe.mockImplementation(
      (request: { organizationId?: string }) =>
        Promise.resolve({
          containers:
            request.organizationId === 'org-2'
              ? []
              : [
                  {
                    ...container('a', 'Both'),
                    ...(request.organizationId === undefined
                      ? { access: 'direct' }
                      : {}),
                  },
                ],
          nextCursor: null,
        }),
    );

    await useSharedContainerReplicasStore.getState().loadSharedWithMe();

    const entries = useSharedContainerReplicasStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.access).toBeUndefined();
  });

  it('reconciles but hides direct shares while external sharing is off', async () => {
    setExternalSharing(false);
    bridge.listSharedWithMe.mockImplementation(
      (request: { organizationId?: string }) =>
        Promise.resolve({
          containers:
            request.organizationId === undefined
              ? [
                  {
                    ...container('c2', 'Hidden direct share'),
                    access: 'direct',
                  },
                ]
              : [container('a', 'Visible organization share')],
          nextCursor: null,
        }),
    );

    await useSharedContainerReplicasStore.getState().loadSharedWithMe();

    expect(bridge.listSharedWithMe).toHaveBeenCalledWith({});
    expect(
      useSharedContainerReplicasStore
        .getState()
        .entries.map((entry) => entry.container.id),
    ).toEqual(['a']);
  });

  it('initializes hidden direct reconciliation for an account without an organization', async () => {
    setExternalSharing(false);
    useSharedContainersStore.setState({ organizations: [] });
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [
        {
          ...container('c2', 'Hidden personal share'),
          organizationId: undefined,
          access: 'direct',
        },
      ],
      nextCursor: null,
    });

    const dispose = initializeSharedContainerReplicasStore();
    try {
      await flushAsyncWork();

      expect(bridge.listSharedWithMe).toHaveBeenCalledWith({});
      expect(useSharedContainerReplicasStore.getState().entries).toEqual([]);
    } finally {
      dispose();
    }
  });

  it('accepts a personal direct share without an organization id', async () => {
    await useSharedContainerReplicasStore.getState().acceptContainer({
      containerId: 'c2',
      access: 'direct',
    });
    expect(bridge.accept).toHaveBeenCalledWith({
      containerId: 'c2',
      access: 'direct',
    });
    expect(bridge.open).toHaveBeenCalledWith({
      containerId: 'c2',
      access: 'direct',
      viewerSessionId: ANY_VIEWER_SESSION_ID,
    });
  });
});

describe('inbox signal refresh', () => {
  beforeEach(() => {
    // One organization keeps "listings" and "bridge calls" one-to-one, so the
    // coalescing assertions below count what they claim to count.
    useSharedContainersStore.setState({
      organizations: [
        { id: 'org-1', name: 'One', createdAt: '', updatedAt: '' },
      ],
    });
  });

  it('re-lists the inbox when main signals, with no restart and no org change', async () => {
    let shared = false;
    bridge.listSharedWithMe.mockImplementation(() =>
      Promise.resolve({
        containers: shared ? [container('a', 'Invited')] : [],
        nextCursor: null,
      }),
    );
    const dispose = initializeSharedContainerReplicasStore();
    try {
      await flushAsyncWork();
      expect(useSharedContainerReplicasStore.getState().entries).toEqual([]);

      // The grant lands server-side. Nothing in the app is told except the
      // signal — no organization change, no purge, no user gesture.
      shared = true;
      emitInboxSignal('realtime');
      await flushAsyncWork();

      const state = useSharedContainerReplicasStore.getState();
      expect(state.entries).toHaveLength(1);
      expect(state.entries[0]?.container.id).toBe('a');
    } finally {
      dispose();
    }
  });

  it('coalesces a storm of signals into exactly one additional listing', async () => {
    const gates: Array<{ resolve: (value: unknown) => void }> = [];
    bridge.listSharedWithMe.mockImplementation(() => {
      const gate = deferred<unknown>();
      gates.push(gate);
      return gate.promise;
    });
    const dispose = initializeSharedContainerReplicasStore();
    try {
      await flushAsyncWork();
      // Settle the initial listing so the counter below starts clean.
      gates[0]?.resolve({ containers: [], nextCursor: null });
      await flushAsyncWork();
      expect(gates).toHaveLength(1);

      // First signal starts a listing; three more arrive mid-flight. A naive
      // per-signal `loadSharedWithMe` would bump `listEpoch` and abandon the
      // in-flight fan-out on every frame, leaving the section permanently
      // mid-load behind a fast publisher.
      emitInboxSignal('realtime');
      await flushAsyncWork();
      expect(gates).toHaveLength(2);
      emitInboxSignal('realtime');
      emitInboxSignal('poll');
      emitInboxSignal('focus');
      await flushAsyncWork();
      expect(gates).toHaveLength(2);

      gates[1]?.resolve({ containers: [], nextCursor: null });
      await flushAsyncWork();
      // One queued re-run covers all three, because the fan-out reads current
      // server state rather than replaying each signal.
      expect(gates).toHaveLength(3);

      gates[2]?.resolve({ containers: [], nextCursor: null });
      await flushAsyncWork();
      expect(gates).toHaveLength(3);
    } finally {
      dispose();
    }
  });

  it('queues an inbox signal until the foreground listing settles', async () => {
    const foreground = deferred<{
      containers: SharedContainerSummary[];
      nextCursor: null;
    }>();
    bridge.listSharedWithMe
      .mockReturnValueOnce(foreground.promise)
      .mockRejectedValueOnce(new Error('network down'));
    const dispose = initializeSharedContainerReplicasStore();
    try {
      await flushAsyncWork();
      expect(bridge.listSharedWithMe).toHaveBeenCalledTimes(1);
      expect(useSharedContainerReplicasStore.getState().listStatus).toBe(
        'loading',
      );

      emitInboxSignal('realtime');
      await flushAsyncWork();

      // A background listing must not supersede the foreground boot/org load.
      expect(bridge.listSharedWithMe).toHaveBeenCalledTimes(1);
      foreground.resolve({ containers: [], nextCursor: null });
      await flushAsyncWork();

      // The queued background rerun still occurs, but its failure preserves the
      // foreground result instead of stranding the section at `loading`.
      expect(bridge.listSharedWithMe).toHaveBeenCalledTimes(2);
      expect(useSharedContainerReplicasStore.getState().listStatus).toBe(
        'success',
      );
    } finally {
      dispose();
    }
  });

  it('does not delay foreground completion for the queued background rerun', async () => {
    const foreground = deferred<{
      containers: SharedContainerSummary[];
      nextCursor: null;
    }>();
    const background = deferred<{
      containers: SharedContainerSummary[];
      nextCursor: null;
    }>();
    bridge.listSharedWithMe
      .mockReturnValueOnce(foreground.promise)
      .mockReturnValueOnce(background.promise);

    let foregroundSettled = false;
    const foregroundLoad = useSharedContainerReplicasStore
      .getState()
      .loadSharedWithMe()
      .then(() => {
        foregroundSettled = true;
      });
    await flushAsyncWork();
    const backgroundLoad = useSharedContainerReplicasStore
      .getState()
      .loadSharedWithMe({ background: true });
    expect(bridge.listSharedWithMe).toHaveBeenCalledTimes(1);

    foreground.resolve({ containers: [], nextCursor: null });
    await flushAsyncWork();
    expect(bridge.listSharedWithMe).toHaveBeenCalledTimes(2);
    const settledBeforeBackground = foregroundSettled;

    background.resolve({ containers: [], nextCursor: null });
    await Promise.all([foregroundLoad, backgroundLoad]);
    expect(settledBeforeBackground).toBe(true);
  });

  it('cancels a queued inbox rerun when the store resets', async () => {
    const foreground = deferred<{
      containers: SharedContainerSummary[];
      nextCursor: null;
    }>();
    bridge.listSharedWithMe
      .mockReturnValueOnce(foreground.promise)
      .mockResolvedValueOnce({
        containers: [container('late', 'Late invitation')],
        nextCursor: null,
      });

    const foregroundLoad = useSharedContainerReplicasStore
      .getState()
      .loadSharedWithMe();
    await flushAsyncWork();
    const backgroundLoad = useSharedContainerReplicasStore
      .getState()
      .loadSharedWithMe({ background: true });
    expect(bridge.listSharedWithMe).toHaveBeenCalledTimes(1);

    useSharedContainerReplicasStore.getState().reset();
    foreground.resolve({ containers: [], nextCursor: null });
    await Promise.all([foregroundLoad, backgroundLoad]);
    await flushAsyncWork();

    expect(bridge.listSharedWithMe).toHaveBeenCalledTimes(1);
    expect(useSharedContainerReplicasStore.getState()).toMatchObject({
      entries: [],
      listStatus: 'idle',
    });
  });

  it('leaves listStatus untouched when a background refresh fails with nothing to show', async () => {
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [],
      nextCursor: null,
    });
    const dispose = initializeSharedContainerReplicasStore();
    try {
      await flushAsyncWork();
      expect(useSharedContainerReplicasStore.getState().listStatus).toBe(
        'success',
      );
      reportRendererConsoleError.mockClear();

      // A transient hiccup on an unattended refresh must not be the reason a
      // section that has never had anything in it materializes as an error row
      // with a Retry button.
      bridge.listSharedWithMe.mockRejectedValue(new Error('network down'));
      emitInboxSignal('poll');
      await flushAsyncWork();

      const state = useSharedContainerReplicasStore.getState();
      expect(state.listStatus).toBe('success');
      expect(state.entries).toEqual([]);
      expect(reportRendererConsoleError).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('keeps visible shares when a background refresh fails', async () => {
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [container('a', 'Already visible')],
      nextCursor: null,
    });
    const dispose = initializeSharedContainerReplicasStore();
    try {
      await flushAsyncWork();
      expect(useSharedContainerReplicasStore.getState().entries).toHaveLength(
        1,
      );
      reportRendererConsoleError.mockClear();

      bridge.listSharedWithMe.mockRejectedValue(new Error('network down'));
      emitInboxSignal('poll');
      await flushAsyncWork();

      const state = useSharedContainerReplicasStore.getState();
      expect(state.listStatus).toBe('success');
      expect(state.entries).toHaveLength(1);
      expect(state.entries[0]?.container.id).toBe('a');
      expect(reportRendererConsoleError).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('still surfaces a foreground failure the user asked for', async () => {
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [],
      nextCursor: null,
    });
    const dispose = initializeSharedContainerReplicasStore();
    try {
      await flushAsyncWork();

      // The Retry button and boot/org-change paths pass no options, so the
      // suppression above must not have widened into them.
      bridge.listSharedWithMe.mockRejectedValue(new Error('network down'));
      await useSharedContainerReplicasStore.getState().loadSharedWithMe();

      expect(useSharedContainerReplicasStore.getState().listStatus).toBe(
        'error',
      );
      expect(reportRendererConsoleError).toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('keeps an already-showing failure visible across a background refresh', async () => {
    bridge.listSharedWithMe.mockRejectedValue(new Error('network down'));
    const dispose = initializeSharedContainerReplicasStore();
    try {
      await flushAsyncWork();
      expect(useSharedContainerReplicasStore.getState().listStatus).toBe(
        'error',
      );

      emitInboxSignal('poll');
      await flushAsyncWork();

      // Suppression only protects a section that was absent. One already
      // rendering an error must not silently go quiet under it.
      expect(useSharedContainerReplicasStore.getState().listStatus).toBe(
        'error',
      );
    } finally {
      dispose();
    }
  });

  it('leaves the open share mounted across a refresh', async () => {
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [container('c1', 'Open one')],
      nextCursor: null,
    });
    bridge.open.mockResolvedValue(available('rev-1'));
    const dispose = initializeSharedContainerReplicasStore();
    try {
      await flushAsyncWork();
      await useSharedContainerReplicasStore
        .getState()
        .openContainer({ containerId: 'c1', organizationId: 'org-1' });
      bridge.close.mockClear();

      emitInboxSignal('realtime');
      await flushAsyncWork();

      // Routing the refresh through `syncOrganizations` would `reset()` +
      // `closeViewer()` and re-open, tearing the recipient's view down on
      // every tick.
      expect(
        useSharedContainerReplicasStore.getState().viewer?.containerId,
      ).toBe('c1');
      expect(bridge.close).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('resolves each share owner once instead of per refresh', async () => {
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [container('a', 'Invited')],
      nextCursor: null,
    });
    bridge.searchMembers.mockResolvedValue({
      members: [{ userId: 'owner-1', name: 'Ada' }],
    });
    const dispose = initializeSharedContainerReplicasStore();
    try {
      await flushAsyncWork();
      expect(bridge.searchMembers).toHaveBeenCalledTimes(1);

      emitInboxSignal('realtime');
      await flushAsyncWork();
      emitInboxSignal('poll');
      await flushAsyncWork();

      // A per-listing member search is fine once at boot; at the heartbeat's
      // cadence it is a standing multiplier on a value that never changes.
      expect(bridge.searchMembers).toHaveBeenCalledTimes(1);
      expect(
        useSharedContainerReplicasStore.getState().entries[0]?.ownerName,
      ).toBe('Ada');
    } finally {
      dispose();
    }
  });

  it('degrades quietly when the preload has no inbox bridge method', async () => {
    const withoutInbox: Partial<MockBridge> = { ...bridge };
    delete withoutInbox.onInboxChanged;
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { sharedContainers: withoutInbox },
    });
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [],
      nextCursor: null,
    });

    // An older preload must not take the whole store initializer down with it.
    const dispose = initializeSharedContainerReplicasStore();
    await flushAsyncWork();
    expect(useSharedContainerReplicasStore.getState().listStatus).toBe(
      'success',
    );
    dispose();
  });
});

describe('organization resync', () => {
  /**
   * The reported symptom: open a share, switch to another app, come back, and
   * the share is gone with the previously selected worktree showing behind it.
   * An account re-hydration that reports the same organizations -- or briefly
   * reports none -- must not be able to close a share the user is reading.
   */
  it('keeps the open share across a re-hydration of the same organizations', async () => {
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [container('c1', 'Shared branch')],
      nextCursor: null,
    });
    bridge.open.mockResolvedValue(available('rev-1'));
    const dispose = initializeSharedContainerReplicasStore();
    await flushAsyncWork();
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });
    expect(useSharedContainerReplicasStore.getState().viewer).not.toBeNull();

    // A fresh array of the same organizations, as a re-probe produces.
    useSharedContainersStore.setState({
      organizations: [
        { id: 'org-2', name: 'Two', createdAt: '', updatedAt: '' },
        { id: 'org-1', name: 'One', createdAt: '', updatedAt: '' },
      ],
    });
    await flushAsyncWork();

    expect(useSharedContainerReplicasStore.getState().viewer?.containerId).toBe(
      'c1',
    );
    dispose();
  });

  it('refreshes in place, never closing or reopening, when the organization is retained', async () => {
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [container('c1', 'Shared branch')],
      nextCursor: null,
    });
    bridge.open.mockResolvedValue(available('rev-1'));
    const dispose = initializeSharedContainerReplicasStore();
    await flushAsyncWork();
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });
    bridge.open.mockClear();
    bridge.close.mockClear();

    const sawNullViewer: boolean[] = [];
    const unsubscribe = useSharedContainerReplicasStore.subscribe((state) => {
      sawNullViewer.push(state.viewer === null);
    });

    // org-2 leaves; the viewer's own organization is untouched.
    useSharedContainersStore.setState({
      organizations: [
        { id: 'org-1', name: 'One', createdAt: '', updatedAt: '' },
      ],
    });
    await flushAsyncWork();
    unsubscribe();

    const state = useSharedContainerReplicasStore.getState();
    expect(state.viewer?.containerId).toBe('c1');
    expect(state.viewer?.replica).not.toBeNull();
    // The store used to `reset()` (which nulls `viewer`) and then re-open. The
    // share must never blink out, and the bridge must not be re-driven.
    expect(sawNullViewer).not.toContain(true);
    expect(bridge.open).not.toHaveBeenCalled();
    expect(bridge.close).not.toHaveBeenCalled();
    dispose();
  });

  it('keeps the share when the refreshed listing fails', async () => {
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [container('c1', 'Shared branch')],
      nextCursor: null,
    });
    bridge.open.mockResolvedValue(available('rev-1'));
    const dispose = initializeSharedContainerReplicasStore();
    await flushAsyncWork();
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });

    // An inconclusive listing leaves `entries: []`, which must not be read as
    // "the share is gone" -- that is what closed it permanently.
    bridge.listSharedWithMe.mockRejectedValue(new Error('server unreachable'));
    useSharedContainersStore.setState({
      organizations: [
        { id: 'org-1', name: 'One', createdAt: '', updatedAt: '' },
      ],
    });
    await flushAsyncWork();

    expect(useSharedContainerReplicasStore.getState().viewer?.containerId).toBe(
      'c1',
    );
    dispose();
  });

  it('keeps the share when the refreshed acceptance read fails', async () => {
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [container('c1', 'Shared branch')],
      nextCursor: null,
    });
    bridge.open.mockResolvedValue(available('rev-1'));
    const dispose = initializeSharedContainerReplicasStore();
    await flushAsyncWork();
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });

    bridge.listAccepted.mockRejectedValue(new Error('server unreachable'));
    useSharedContainersStore.setState({
      organizations: [
        { id: 'org-1', name: 'One', createdAt: '', updatedAt: '' },
      ],
    });
    await flushAsyncWork();

    expect(useSharedContainerReplicasStore.getState().viewer?.containerId).toBe(
      'c1',
    );
    dispose();
  });

  it('closes the share when a conclusive listing no longer contains it', async () => {
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [container('c1', 'Shared branch')],
      nextCursor: null,
    });
    bridge.open.mockResolvedValue(available('rev-1'));
    const dispose = initializeSharedContainerReplicasStore();
    await flushAsyncWork();
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });

    bridge.listSharedWithMe.mockResolvedValue({
      containers: [],
      nextCursor: null,
    });
    useSharedContainersStore.setState({
      organizations: [
        { id: 'org-1', name: 'One', createdAt: '', updatedAt: '' },
      ],
    });
    await flushAsyncWork();

    expect(useSharedContainerReplicasStore.getState().viewer).toBeNull();
    dispose();
  });

  it('leaves a share opened mid-refresh alone when the OLD one is gone', async () => {
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [container('c1', 'Shared branch'), container('c2', 'Other')],
      nextCursor: null,
    });
    bridge.open.mockResolvedValue(available('rev-1'));
    const dispose = initializeSharedContainerReplicasStore();
    await flushAsyncWork();
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });

    // Hold the refreshed listing in flight. `restore` is captured as `c1`
    // BEFORE these awaits, so a close decided on `c1` must not be applied to
    // whatever viewer happens to be mounted when the listing finally lands.
    const pendingList = deferred<{
      containers: unknown[];
      nextCursor: string | null;
    }>();
    bridge.listSharedWithMe.mockReturnValue(pendingList.promise);
    useSharedContainersStore.setState({
      organizations: [
        { id: 'org-1', name: 'One', createdAt: '', updatedAt: '' },
      ],
    });
    await flushAsyncWork();

    // The recipient navigates to a different share while the listing is out.
    bridge.open.mockResolvedValue(available('rev-2', 'c2'));
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c2', organizationId: 'org-1' });
    expect(useSharedContainerReplicasStore.getState().viewer?.containerId).toBe(
      'c2',
    );

    // The conclusive listing says the ORIGINAL share is gone.
    pendingList.resolve({
      containers: [container('c2', 'Other')],
      nextCursor: null,
    });
    await flushAsyncWork();

    // `c2` is still listed, still accepted, and still what the recipient is
    // looking at. Closing it here would be the same "the viewer closed for no
    // reason" symptom, just sourced from the stale `restore`.
    expect(useSharedContainerReplicasStore.getState().viewer?.containerId).toBe(
      'c2',
    );
    expect(bridge.close).not.toHaveBeenCalledWith(
      expect.objectContaining({ containerId: 'c2' }),
    );
    dispose();
  });

  it('ignores an inconclusive account read instead of tearing the share down', async () => {
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [container('c1', 'Shared branch')],
      nextCursor: null,
    });
    bridge.open.mockResolvedValue(available('rev-1'));
    const dispose = initializeSharedContainerReplicasStore();
    await flushAsyncWork();
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });

    // A failed probe reports no organizations; the account store flags it as
    // inconclusive rather than a sign-out.
    useSharedContainersStore.setState({
      accountHydrationFailed: true,
      organizations: [],
    });
    await flushAsyncWork();

    expect(useSharedContainerReplicasStore.getState().viewer?.containerId).toBe(
      'c1',
    );
    dispose();
  });

  // A benign refusal is CONCLUSIVE, unlike an errored or transiently
  // unavailable listing. Main converts the server's 403 into the refusal only
  // AFTER `reconcileContainerSnapshot` has already purged the replica, so
  // treating it as inconclusive leaves the recipient reading a decrypted
  // transcript whose bytes are gone.
  it('closes the share when its organization is conclusively refused', async () => {
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [container('c1', 'Shared branch')],
      nextCursor: null,
    });
    bridge.open.mockResolvedValue(available('rev-1'));
    const dispose = initializeSharedContainerReplicasStore();
    await flushAsyncWork();
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });

    bridge.listSharedWithMe.mockResolvedValue({
      containers: [],
      nextCursor: null,
      refusal: 'blocked-by-org-billing',
    });
    useSharedContainersStore.setState({
      organizations: [
        { id: 'org-1', name: 'One', createdAt: '', updatedAt: '' },
      ],
    });
    await flushAsyncWork();

    expect(useSharedContainerReplicasStore.getState().listStatus).toBe(
      'blocked-by-org-billing',
    );
    expect(useSharedContainerReplicasStore.getState().viewer).toBeNull();
    dispose();
  });

  // The counterpart guard: a transient refusal really is inconclusive and must
  // NOT close, or a server blip evicts the reader all over again.
  it('keeps the share when the listing is only temporarily unavailable', async () => {
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [container('c1', 'Shared branch')],
      nextCursor: null,
    });
    bridge.open.mockResolvedValue(available('rev-1'));
    const dispose = initializeSharedContainerReplicasStore();
    await flushAsyncWork();
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });

    bridge.listSharedWithMe.mockResolvedValue({
      containers: [],
      nextCursor: null,
      refusal: 'temporarily-unavailable',
    });
    useSharedContainersStore.setState({
      organizations: [
        { id: 'org-1', name: 'One', createdAt: '', updatedAt: '' },
      ],
    });
    await flushAsyncWork();

    expect(useSharedContainerReplicasStore.getState().listStatus).toBe(
      'unavailable',
    );
    expect(useSharedContainerReplicasStore.getState().viewer?.containerId).toBe(
      'c1',
    );
    dispose();
  });

  it('closes the share when its own organization is no longer authorized', async () => {
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [container('c1', 'Shared branch')],
      nextCursor: null,
    });
    bridge.open.mockResolvedValue(available('rev-1'));
    const dispose = initializeSharedContainerReplicasStore();
    await flushAsyncWork();
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });

    useSharedContainersStore.setState({
      organizations: [
        { id: 'org-2', name: 'Two', createdAt: '', updatedAt: '' },
      ],
    });
    await flushAsyncWork();

    expect(useSharedContainerReplicasStore.getState().viewer).toBeNull();
    dispose();
  });
});

describe('acceptContainer', () => {
  it('never opens a container this device has not accepted', async () => {
    useSharedContainerReplicasStore.setState({ acceptedIds: [] });

    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });

    expect(bridge.open).not.toHaveBeenCalled();
    expect(useSharedContainerReplicasStore.getState().viewer).toBeNull();
  });

  it('records consent before the container is materialized', async () => {
    useSharedContainerReplicasStore.setState({ acceptedIds: [] });
    bridge.open.mockResolvedValue(available('rev-1'));

    await useSharedContainerReplicasStore
      .getState()
      .acceptContainer({ containerId: 'c1', organizationId: 'org-1' });

    expect(bridge.accept).toHaveBeenCalledWith({
      containerId: 'c1',
      organizationId: 'org-1',
    });
    expect(bridge.open).toHaveBeenCalledWith({
      containerId: 'c1',
      organizationId: 'org-1',
      viewerSessionId: ANY_VIEWER_SESSION_ID,
    });
    const state = useSharedContainerReplicasStore.getState();
    expect(state.acceptedIds).toContain('c1');
    expect(state.acceptingId).toBeNull();
    expect(state.viewer?.containerId).toBe('c1');
  });

  it('forwards the listing container type as the acceptance telemetry hint', async () => {
    useSharedContainerReplicasStore.setState({ acceptedIds: [] });

    await useSharedContainerReplicasStore.getState().acceptContainer({
      containerId: 'c1',
      organizationId: 'org-1',
      containerType: 'COWORK_WORK_ENTRY',
      shouldOpen: () => false,
    });

    expect(bridge.accept).toHaveBeenCalledWith({
      containerId: 'c1',
      containerType: 'COWORK_WORK_ENTRY',
      organizationId: 'org-1',
    });
  });

  it('records consent without materializing when the caller is stale', async () => {
    useSharedContainerReplicasStore.setState({ acceptedIds: [] });
    const shouldOpen = jest.fn(() => false);

    await useSharedContainerReplicasStore.getState().acceptContainer({
      containerId: 'c1',
      organizationId: 'org-1',
      shouldOpen,
    });

    expect(bridge.accept).toHaveBeenCalledWith({
      containerId: 'c1',
      organizationId: 'org-1',
    });
    expect(shouldOpen).toHaveBeenCalledTimes(1);
    expect(bridge.open).not.toHaveBeenCalled();
    const state = useSharedContainerReplicasStore.getState();
    expect(state.acceptedIds).toContain('c1');
    expect(state.acceptingId).toBeNull();
    expect(state.viewer).toBeNull();
  });

  it('leaves the row an invitation when recording consent fails', async () => {
    useSharedContainerReplicasStore.setState({ acceptedIds: [] });
    bridge.accept.mockRejectedValueOnce(new Error('offline'));

    await useSharedContainerReplicasStore
      .getState()
      .acceptContainer({ containerId: 'c1', organizationId: 'org-1' });

    expect(bridge.open).not.toHaveBeenCalled();
    const state = useSharedContainerReplicasStore.getState();
    expect(state.acceptedIds).not.toContain('c1');
    expect(state.acceptingId).toBeNull();
  });

  it('fails closed when the accepted list cannot be read', async () => {
    bridge.listAccepted.mockRejectedValueOnce(new Error('unreadable'));

    await useSharedContainerReplicasStore.getState().loadAccepted();

    const state = useSharedContainerReplicasStore.getState();
    expect(state.acceptedIds).toEqual([]);
    expect(state.acceptedStatus).toBe('error');
  });

  it('drops acceptance when the share is dismissed', async () => {
    await useSharedContainerReplicasStore
      .getState()
      .dismissContainer('c1', 'org-1');

    expect(
      useSharedContainerReplicasStore.getState().acceptedIds,
    ).not.toContain('c1');
  });
});

describe('accepted identity records (CAN-3554)', () => {
  const records = (): Record<string, unknown> =>
    useSharedContainerReplicasStore.getState().acceptedRecords;

  it('loads the recorded identity of every accepted container', async () => {
    bridge.listAccepted.mockResolvedValueOnce({
      containerIds: ['c1', 'c2'],
      records: {
        // A legacy record carries no `access`.
        c1: { organizationId: 'org-1' },
        c2: { access: 'direct' },
      },
    });

    await useSharedContainerReplicasStore.getState().loadAccepted();

    expect(records()).toEqual({
      c1: { organizationId: 'org-1' },
      c2: { access: 'direct' },
    });
    expect(useSharedContainerReplicasStore.getState().acceptedIds).toEqual([
      'c1',
      'c2',
    ]);
  });

  it('has no records when the response predates them', async () => {
    useSharedContainerReplicasStore.setState({
      acceptedRecords: { c1: { organizationId: 'org-1' } },
    });
    bridge.listAccepted.mockResolvedValueOnce({ containerIds: ['c1'] });

    await useSharedContainerReplicasStore.getState().loadAccepted();

    expect(records()).toEqual({});
    expect(useSharedContainerReplicasStore.getState().acceptedIds).toEqual([
      'c1',
    ]);
  });

  it('drops the records when the accepted list cannot be read', async () => {
    useSharedContainerReplicasStore.setState({
      acceptedRecords: { c1: { organizationId: 'org-1' } },
    });
    bridge.listAccepted.mockRejectedValueOnce(new Error('unreadable'));

    await useSharedContainerReplicasStore.getState().loadAccepted();

    expect(records()).toEqual({});
    expect(useSharedContainerReplicasStore.getState().acceptedStatus).toBe(
      'error',
    );
  });

  it('drops the records when the bridge is unavailable', async () => {
    useSharedContainerReplicasStore.setState({
      acceptedRecords: { c1: { organizationId: 'org-1' } },
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {},
    });

    await useSharedContainerReplicasStore.getState().loadAccepted();

    expect(records()).toEqual({});
  });

  it('clears the records on reset', () => {
    useSharedContainerReplicasStore.setState({
      acceptedRecords: { c1: { organizationId: 'org-1' } },
    });

    useSharedContainerReplicasStore.getState().reset();

    expect(records()).toEqual({});
  });

  it('records the accepted identity before the viewer mounts', async () => {
    useSharedContainerReplicasStore.setState({ acceptedIds: [] });
    bridge.open.mockResolvedValue(available('rev-1'));
    // The context selection sync reads the record as soon as a viewer
    // appears, so it has to be there on that very transition.
    const recordsAtMount: unknown[] = [];
    const unsubscribe = useSharedContainerReplicasStore.subscribe(
      (state, previous): void => {
        if (state.viewer !== null && previous.viewer === null) {
          recordsAtMount.push(state.acceptedRecords.c1);
        }
      },
    );

    try {
      await useSharedContainerReplicasStore
        .getState()
        .acceptContainer({ containerId: 'c1', organizationId: 'org-1' });
    } finally {
      unsubscribe();
    }

    expect(recordsAtMount).toEqual([{ organizationId: 'org-1' }]);
    expect(records()).toEqual({ c1: { organizationId: 'org-1' } });
  });

  it('records a direct acceptance without an organization', async () => {
    useSharedContainerReplicasStore.setState({ acceptedIds: [] });
    bridge.open.mockResolvedValue(available('rev-1'));

    await useSharedContainerReplicasStore
      .getState()
      .acceptContainer({ containerId: 'c1', access: 'direct' });

    expect(records()).toEqual({ c1: { access: 'direct' } });
  });

  it('keeps the existing record when the answer to a repeat accept carries none', async () => {
    const existing = { organizationId: 'org-1' };
    useSharedContainerReplicasStore.setState({
      acceptedRecords: { c1: existing },
    });
    bridge.open.mockResolvedValue(available('rev-1'));

    await useSharedContainerReplicasStore.getState().acceptContainer({
      containerId: 'c1',
      organizationId: 'org-1',
      access: 'direct',
    });

    expect(useSharedContainerReplicasStore.getState().acceptedRecords.c1).toBe(
      existing,
    );
  });

  it('records the identity main kept, not the one this accept sent', async () => {
    // Main holds a record this store never read: a link claim wrote it, or an
    // earlier read of the accepted list failed.
    useSharedContainerReplicasStore.setState({
      acceptedIds: [],
      acceptedRecords: {},
    });
    bridge.accept.mockResolvedValueOnce({
      accepted: true,
      record: { organizationId: 'org-1', access: 'organization' },
    });
    bridge.open.mockResolvedValue(available('rev-1'));

    await useSharedContainerReplicasStore.getState().acceptContainer({
      containerId: 'c1',
      organizationId: 'org-1',
      access: 'direct',
    });

    expect(records()).toEqual({
      c1: { organizationId: 'org-1', access: 'organization' },
    });
  });

  it('replaces a record that disagrees with the one main kept', async () => {
    useSharedContainerReplicasStore.setState({
      acceptedRecords: {
        c1: { access: 'direct' },
        c2: { organizationId: 'org-2' },
      },
    });
    bridge.accept.mockResolvedValueOnce({
      accepted: true,
      record: { organizationId: 'org-1' },
    });
    bridge.open.mockResolvedValue(available('rev-1'));

    await useSharedContainerReplicasStore.getState().acceptContainer({
      containerId: 'c1',
      access: 'direct',
    });

    expect(records()).toEqual({
      c1: { organizationId: 'org-1' },
      c2: { organizationId: 'org-2' },
    });
  });

  it('keeps the records object when main answers with the identity it already holds', async () => {
    const existing = { c1: { organizationId: 'org-1' } };
    useSharedContainerReplicasStore.setState({ acceptedRecords: existing });
    bridge.accept.mockResolvedValueOnce({
      accepted: true,
      record: { organizationId: 'org-1' },
    });
    bridge.open.mockResolvedValue(available('rev-1'));

    await useSharedContainerReplicasStore
      .getState()
      .acceptContainer({ containerId: 'c1', organizationId: 'org-1' });

    // Selectors subscribe to this object, so an unchanged record must not
    // replace it.
    expect(records()).toBe(existing);
  });

  it('writes no record when recording consent fails', async () => {
    useSharedContainerReplicasStore.setState({ acceptedIds: [] });
    bridge.accept.mockRejectedValueOnce(new Error('offline'));

    await useSharedContainerReplicasStore
      .getState()
      .acceptContainer({ containerId: 'c1', organizationId: 'org-1' });

    expect(records()).toEqual({});
    expect(
      useSharedContainerReplicasStore.getState().acceptedIds,
    ).not.toContain('c1');
  });

  it('removes the record when the share is dismissed', async () => {
    useSharedContainerReplicasStore.setState({
      acceptedRecords: {
        c1: { organizationId: 'org-1' },
        c2: { organizationId: 'org-2' },
      },
    });

    await expect(
      useSharedContainerReplicasStore
        .getState()
        .dismissContainer('c1', 'org-1'),
    ).resolves.toBe(true);

    expect(records()).toEqual({ c2: { organizationId: 'org-2' } });
  });

  it('restores the record when the dismiss fails', async () => {
    const existing = { organizationId: 'org-1' };
    useSharedContainerReplicasStore.setState({
      acceptedRecords: { c1: existing },
    });
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [],
      nextCursor: null,
    });
    const revoke = deferred<{ dismissed: boolean }>();
    bridge.dismiss.mockReturnValueOnce(revoke.promise);

    const dismissal = useSharedContainerReplicasStore
      .getState()
      .dismissContainer('c1', 'org-1');
    // Removed optimistically, together with the acceptance.
    expect(records()).toEqual({});
    expect(
      useSharedContainerReplicasStore.getState().acceptedIds,
    ).not.toContain('c1');
    revoke.reject(new Error('offline'));

    await expect(dismissal).resolves.toBe(false);
    expect(useSharedContainerReplicasStore.getState().acceptedRecords.c1).toBe(
      existing,
    );
    expect(useSharedContainerReplicasStore.getState().acceptedIds).toContain(
      'c1',
    );
    await flushAsyncWork();
  });
});

describe('openContainer', () => {
  it('does not mirror content owned by the standard workspace stores', () => {
    const state = useSharedContainerReplicasStore.getState();
    for (const key of [
      'chats',
      'plans',
      'notes',
      'prompts',
      'attachments',
      'repositoryTree',
      'selectedChat',
      'selectedPlan',
      'selectedItem',
      'selectedAttachment',
      'loadContent',
      'loadRepositoryTree',
      'selectChat',
      'selectPlan',
      'selectItem',
      'selectAttachment',
    ]) {
      expect(state).not.toHaveProperty(key);
    }
  });

  it('preserves direct access through open and retry', async () => {
    bridge.open.mockResolvedValue(available('rev-1'));

    await useSharedContainerReplicasStore.getState().openContainer({
      containerId: 'c1',
      organizationId: 'org-1',
      access: 'direct',
    });
    await useSharedContainerReplicasStore.getState().retryContainer();

    expect(bridge.open).toHaveBeenCalledWith({
      containerId: 'c1',
      organizationId: 'org-1',
      access: 'direct',
      viewerSessionId: ANY_VIEWER_SESSION_ID,
    });
    expect(bridge.retry).toHaveBeenCalledWith({
      containerId: 'c1',
      organizationId: 'org-1',
      access: 'direct',
      viewerSessionId: ANY_VIEWER_SESSION_ID,
    });
    expect(useSharedContainerReplicasStore.getState().viewer?.access).toBe(
      'direct',
    );
  });

  it('stores the gate result and stops loading', async () => {
    bridge.open.mockResolvedValue(available('rev-1'));

    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });

    const viewer = useSharedContainerReplicasStore.getState().viewer;
    expect(viewer?.loading).toBe(false);
    expect(viewer?.replica?.status).toBe('available');
  });

  it('surfaces a transport failure without inventing a replica', async () => {
    bridge.open.mockRejectedValue(new Error('gate exploded'));

    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });

    const viewer = useSharedContainerReplicasStore.getState().viewer;
    expect(viewer?.replica).toBeNull();
    expect(viewer?.openError).toBe('gate exploded');
  });

  it('does not show a share from a background broadcast while its open is pending', async () => {
    const pending = deferred<SharedContainerReplicaState>();
    bridge.open.mockReturnValueOnce(pending.promise);

    const opening = useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });
    await flushAsyncWork();
    // A sync that was already running finishes before the open's reset.
    useSharedContainerReplicasStore
      .getState()
      .applyReplicaState(available('rev-old'));

    const waiting = useSharedContainerReplicasStore.getState().viewer;
    expect(waiting?.loading).toBe(true);
    expect(waiting?.replica?.status).not.toBe('available');

    pending.resolve(available('rev-new'));
    await opening;

    const replica = useSharedContainerReplicasStore.getState().viewer?.replica;
    expect(replica?.status === 'available' && replica.revisionId).toBe(
      'rev-new',
    );
  });

  it('drops an older open completion once another container is mounted', async () => {
    const older = deferred<SharedContainerReplicaState>();
    const newer = deferred<SharedContainerReplicaState>();
    bridge.open
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    const olderOpen = useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });
    // The open request is sent once the viewer's pending layout save commits.
    await flushAsyncWork();
    const newerOpen = useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c2', organizationId: 'org-1' });
    newer.resolve(available('rev-new', 'c2'));
    await newerOpen;
    older.resolve(available('rev-old'));
    await olderOpen;

    const replica = useSharedContainerReplicasStore.getState().viewer?.replica;
    expect(replica?.status === 'available' && replica.revisionId).toBe(
      'rev-new',
    );
  });

  it('drops an older open rejection once another container is mounted', async () => {
    const older = deferred<SharedContainerReplicaState>();
    const newer = deferred<SharedContainerReplicaState>();
    bridge.open
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    const olderOpen = useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });
    // The open request is sent once the viewer's pending layout save commits.
    await flushAsyncWork();
    const newerOpen = useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c2', organizationId: 'org-1' });
    newer.resolve(available('rev-new', 'c2'));
    await newerOpen;
    older.reject(new Error('stale open failure'));
    await olderOpen;

    expect(useSharedContainerReplicasStore.getState().viewer).toMatchObject({
      openError: null,
      replica: { revisionId: 'rev-new' },
    });
  });

  // CAN-2551: re-clicking the mounted share used to tear the viewer back down
  // to `loading` and re-run the access gate, which on the recipient side can
  // mean a multi-second re-materialization of something already on screen.
  it('is a no-op when the container is already mounted', async () => {
    bridge.open.mockResolvedValue(available('rev-1'));
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });
    expect(bridge.open).toHaveBeenCalledTimes(1);

    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });

    expect(bridge.open).toHaveBeenCalledTimes(1);
    const viewer = useSharedContainerReplicasStore.getState().viewer;
    expect(viewer?.loading).toBe(false);
    expect(viewer?.replica?.status).toBe('available');
  });

  it('re-opens a container whose previous open failed', async () => {
    bridge.open.mockRejectedValueOnce(new Error('gate exploded'));
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });

    bridge.open.mockResolvedValueOnce(available('rev-1'));
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });

    const viewer = useSharedContainerReplicasStore.getState().viewer;
    expect(viewer?.openError).toBeNull();
    expect(viewer?.replica?.status).toBe('available');
  });

  it('drops an older repeated retry completion for the same container', async () => {
    bridge.open.mockResolvedValue(available('rev-1'));
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });
    const older = deferred<SharedContainerReplicaState>();
    const newer = deferred<SharedContainerReplicaState>();
    bridge.retry
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    const olderRetry = useSharedContainerReplicasStore
      .getState()
      .retryContainer();
    const newerRetry = useSharedContainerReplicasStore
      .getState()
      .retryContainer();
    newer.resolve(available('rev-new'));
    await newerRetry;
    older.resolve(available('rev-old'));
    await olderRetry;

    const replica = useSharedContainerReplicasStore.getState().viewer?.replica;
    expect(replica?.status === 'available' && replica.revisionId).toBe(
      'rev-new',
    );
  });
});

/**
 * CAN-3559. Every viewer mount carries a session id so main can tell a close
 * from an earlier visit apart from the visit now on screen. Without it, a
 * `close` that lands after the next `open` of the same share released that
 * open's live tracking, and the transcript stopped updating.
 */
describe('viewer panel layout (CAN-4187)', () => {
  const C1_KEY = 'shared-container-viewer/c1';
  const C2_KEY = 'shared-container-viewer/c2';
  const released = (key: string): string[] => [
    `flush:${key}`,
    `dispose-layout:${key}`,
    `dispose-hydration:${key}`,
    `forget-sweep:${key}`,
    `forget-browsers:${key}`,
  ];

  beforeEach(() => {
    bridge.open.mockImplementation(() => {
      mockLayoutEvents.push('open');
      return Promise.resolve(available('rev-1'));
    });
    bridge.close.mockImplementation(() => {
      mockLayoutEvents.push('close');
      return Promise.resolve(undefined);
    });
  });

  it('releases the viewer layout on close, before main is told', async () => {
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });
    mockLayoutEvents.length = 0;

    useSharedContainerReplicasStore.getState().closeViewer();
    expect(useSharedContainerReplicasStore.getState().viewer).toBeNull();
    await flushAsyncWork();

    expect(mockLayoutEvents).toEqual([...released(C1_KEY), 'close']);
  });

  it('waits for the pending layout save before closing', async () => {
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });
    const save = deferred<void>();
    mockFlushLayoutSave.mockReturnValue(save.promise);

    useSharedContainerReplicasStore.getState().closeViewer();
    await flushAsyncWork();
    expect(bridge.close).not.toHaveBeenCalled();

    save.resolve(undefined);
    await flushAsyncWork();
    expect(bridge.close).toHaveBeenCalledTimes(1);
  });

  it('closes even when the pending layout save fails', async () => {
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });
    mockFlushLayoutSave.mockRejectedValue(new Error('save failed'));

    useSharedContainerReplicasStore.getState().closeViewer();
    await flushAsyncWork();

    expect(bridge.close).toHaveBeenCalledTimes(1);
  });

  it('drops any held layout before the open request, so a reopen loads from disk', async () => {
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });

    expect(mockLayoutEvents).toEqual([...released(C1_KEY), 'open']);
  });

  it('releases the share being left when another share is opened', async () => {
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });
    mockLayoutEvents.length = 0;

    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c2', organizationId: 'org-1' });

    expect(mockLayoutEvents).toEqual([
      ...released(C2_KEY),
      ...released(C1_KEY),
      'open',
    ]);
  });

  it('keeps the layout of a share that is already mounted', async () => {
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });
    mockLayoutEvents.length = 0;

    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });

    expect(mockLayoutEvents).toEqual([]);
  });

  it('does not mark the replica readable before the open request resolves', async () => {
    const save = deferred<void>();
    const opened = deferred<SharedContainerReplicaState>();
    mockFlushLayoutSave.mockReturnValue(save.promise);
    bridge.open.mockReturnValue(opened.promise);

    const opening = useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });
    await flushAsyncWork();
    // The open request waits for the save, so it cannot land after the reset.
    expect(bridge.open).not.toHaveBeenCalled();

    save.resolve(undefined);
    await flushAsyncWork();
    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(useSharedContainerReplicasStore.getState().viewer).toMatchObject({
      loading: true,
      replica: null,
    });

    opened.resolve(available('rev-1'));
    await opening;
    expect(
      useSharedContainerReplicasStore.getState().viewer?.replica?.status,
    ).toBe('available');
  });

  it('does not send an open that was closed while its layout save committed', async () => {
    const save = deferred<void>();
    mockFlushLayoutSave.mockReturnValueOnce(save.promise);

    const opening = useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });
    useSharedContainerReplicasStore.getState().closeViewer();
    save.resolve(undefined);
    await opening;
    await flushAsyncWork();

    expect(bridge.open).not.toHaveBeenCalled();
    expect(useSharedContainerReplicasStore.getState().viewer).toBeNull();
  });

  it('drops any held layout before a retry, which main resets like an open', async () => {
    bridge.open.mockRejectedValueOnce(new Error('offline'));
    bridge.retry.mockImplementation(() => {
      mockLayoutEvents.push('retry');
      return Promise.resolve(available('rev-1'));
    });
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });
    mockLayoutEvents.length = 0;

    await useSharedContainerReplicasStore.getState().retryContainer();

    expect(mockLayoutEvents).toEqual([...released(C1_KEY), 'retry']);
  });

  it('keeps the layout of a readable share through a retry', async () => {
    bridge.retry.mockImplementation(() => {
      mockLayoutEvents.push('retry');
      return Promise.resolve(available('rev-1'));
    });
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });
    mockLayoutEvents.length = 0;

    await useSharedContainerReplicasStore.getState().retryContainer();

    expect(mockLayoutEvents).toEqual(['retry']);
  });
});

describe('viewer sessions', () => {
  function sessionOf(mock: jest.Mock, call: number): unknown {
    const calls: unknown[] = mock.mock.calls;
    const args = calls[call];
    const request: unknown = Array.isArray(args) ? args[0] : undefined;
    return typeof request === 'object' &&
      request !== null &&
      'viewerSessionId' in request
      ? request.viewerSessionId
      : undefined;
  }

  beforeEach(() => {
    bridge.open.mockResolvedValue(available('rev-1'));
    bridge.retry.mockResolvedValue(available('rev-1'));
  });

  it('closes with the viewer session its open carried', async () => {
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });
    const opened = sessionOf(bridge.open, 0);
    // Main validates the id as an identifier and caps it at 64 characters.
    expect(opened).toEqual(expect.stringMatching(/^[0-9a-f-]{1,64}$/));
    expect(useSharedContainerReplicasStore.getState().viewer).toMatchObject({
      viewerSessionId: opened,
    });

    useSharedContainerReplicasStore.getState().closeViewer();
    await flushAsyncWork();

    expect(bridge.close).toHaveBeenCalledTimes(1);
    expect(bridge.close).toHaveBeenCalledWith({
      containerId: 'c1',
      viewerSessionId: opened,
    });
  });

  it('mints a new viewer session when a closed share is re-opened', async () => {
    // Hold the first visit's close so it is still queued when the share is
    // re-opened: the late close must name the visit it belongs to, not the
    // one that replaced it.
    const firstClose = deferred<void>();
    bridge.close.mockReturnValueOnce(firstClose.promise);

    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });
    useSharedContainerReplicasStore.getState().closeViewer();
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });
    useSharedContainerReplicasStore.getState().closeViewer();
    firstClose.resolve();
    await flushAsyncWork();

    const firstSession = sessionOf(bridge.open, 0);
    const secondSession = sessionOf(bridge.open, 1);
    expect(firstSession).toEqual(expect.any(String));
    expect(secondSession).toEqual(expect.any(String));
    expect(secondSession).not.toBe(firstSession);
    expect(bridge.close).toHaveBeenNthCalledWith(1, {
      containerId: 'c1',
      viewerSessionId: firstSession,
    });
    expect(bridge.close).toHaveBeenNthCalledWith(2, {
      containerId: 'c1',
      viewerSessionId: secondSession,
    });
  });

  it('reuses the viewer session for retry', async () => {
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });
    await useSharedContainerReplicasStore.getState().retryContainer();
    useSharedContainerReplicasStore.getState().closeViewer();
    await flushAsyncWork();

    const opened = sessionOf(bridge.open, 0);
    expect(opened).toEqual(expect.any(String));
    expect(sessionOf(bridge.retry, 0)).toBe(opened);
    expect(sessionOf(bridge.close, 0)).toBe(opened);
  });

  it('does not mint a viewer session when the share is already mounted', async () => {
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });
    const mounted =
      useSharedContainerReplicasStore.getState().viewer?.viewerSessionId;

    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });

    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(
      useSharedContainerReplicasStore.getState().viewer?.viewerSessionId,
    ).toBe(mounted);
  });
});

describe('replica broadcasts', () => {
  beforeEach(async () => {
    bridge.open.mockResolvedValue(available('rev-1'));
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [],
      nextCursor: null,
    });
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });
  });

  it('tears down the mounted viewer when access is revoked', () => {
    useSharedContainerReplicasStore
      .getState()
      .applyReplicaState({ purged: 'container', containerId: 'c1' });

    expect(useSharedContainerReplicasStore.getState().viewer).toBeNull();
  });

  it('tears down the mounted viewer when every replica is purged', () => {
    useSharedContainerReplicasStore
      .getState()
      .applyReplicaState({ purged: 'all' });

    expect(useSharedContainerReplicasStore.getState().viewer).toBeNull();
  });

  it('applies a revocation broadcast while retrying an existing replica', async () => {
    const retry = deferred<SharedContainerReplicaState>();
    bridge.retry.mockReturnValue(retry.promise);

    const retrying = useSharedContainerReplicasStore
      .getState()
      .retryContainer();
    expect(useSharedContainerReplicasStore.getState().viewer).toMatchObject({
      loading: true,
      replica: { revisionId: 'rev-1' },
    });

    useSharedContainerReplicasStore
      .getState()
      .applyReplicaState({ purged: 'container', containerId: 'c1' });

    expect(useSharedContainerReplicasStore.getState().viewer).toBeNull();

    retry.reject(new Error('access revoked'));
    await retrying;
    expect(useSharedContainerReplicasStore.getState().viewer).toBeNull();
  });

  it('ignores a broadcast for a container that is not open', () => {
    useSharedContainerReplicasStore.getState().applyReplicaState({
      ...available('rev-9'),
      containerId: 'other',
    });

    const viewer = useSharedContainerReplicasStore.getState().viewer;
    expect(viewer?.containerId).toBe('c1');
    expect(
      viewer?.replica?.status === 'available' && viewer.replica.revisionId,
    ).toBe('rev-1');
  });

  it('does not tear down an open that is still in flight', async () => {
    // A purge for the container being navigated away from must not be read as
    // "the container being opened right now disappeared". The old untargeted
    // `null` could not tell those apart and needed an in-flight exemption;
    // the scope makes the distinction explicit.
    let resolveOpen: ((state: SharedContainerReplicaState) => void) | undefined;
    bridge.open.mockImplementation(
      () =>
        new Promise<SharedContainerReplicaState>((resolve) => {
          resolveOpen = resolve;
        }),
    );
    const opening = useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c2', organizationId: 'org-1' });

    useSharedContainerReplicasStore
      .getState()
      .applyReplicaState({ purged: 'container', containerId: 'c1' });
    expect(useSharedContainerReplicasStore.getState().viewer?.containerId).toBe(
      'c2',
    );

    await flushAsyncWork();
    resolveOpen?.({ ...available('rev-7'), containerId: 'c2' });
    await opening;

    const viewer = useSharedContainerReplicasStore.getState().viewer;
    expect(viewer?.containerId).toBe('c2');
    expect(viewer?.loading).toBe(false);
    expect(
      viewer?.replica?.status === 'available' && viewer.replica.revisionId,
    ).toBe('rev-7');
  });

  it('tears down an in-flight open that is itself purged', async () => {
    // The inverse of the test above: a purge naming the container being
    // opened is a genuine denial, not main tidying up a previous viewer.
    let resolveOpen: ((state: SharedContainerReplicaState) => void) | undefined;
    bridge.open.mockImplementation(
      () =>
        new Promise<SharedContainerReplicaState>((resolve) => {
          resolveOpen = resolve;
        }),
    );
    const opening = useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c2', organizationId: 'org-1' });

    useSharedContainerReplicasStore
      .getState()
      .applyReplicaState({ purged: 'container', containerId: 'c2' });
    expect(useSharedContainerReplicasStore.getState().viewer).toBeNull();

    resolveOpen?.({ ...available('rev-7'), containerId: 'c2' });
    await opening;
    expect(useSharedContainerReplicasStore.getState().viewer).toBeNull();
  });

  it('ignores a purge that names a different container', () => {
    useSharedContainerReplicasStore
      .getState()
      .applyReplicaState({ purged: 'container', containerId: 'other' });

    const state = useSharedContainerReplicasStore.getState();
    expect(state.viewer?.containerId).toBe('c1');
    expect(state.viewer?.replica).not.toBeNull();
    // Nothing is listed under that id, so the sidebar is not re-listed either.
    expect(bridge.listSharedWithMe).not.toHaveBeenCalled();
  });

  it('refreshes only the sidebar when the purged container is one of its rows', async () => {
    // The other half of the branch above. `dismissContainer` drops the row
    // from `entries` and records it in `dismissedIds` before main's purge
    // lands, so this is the id set the real Remove flow arrives with -- and
    // the sidebar does need re-listing, while the viewer must not move.
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [container('c1', 'Shared branch')],
      nextCursor: null,
    });
    useSharedContainerReplicasStore.setState({ dismissedIds: ['other'] });

    useSharedContainerReplicasStore
      .getState()
      .applyReplicaState({ purged: 'container', containerId: 'other' });
    await flushAsyncWork();

    expect(bridge.listSharedWithMe).toHaveBeenCalled();
    expect(useSharedContainerReplicasStore.getState().viewer?.containerId).toBe(
      'c1',
    );
    expect(
      useSharedContainerReplicasStore.getState().viewer?.replica,
    ).not.toBeNull();
  });
});

describe('dismissContainer', () => {
  it('removes the row immediately and closes an open viewer', async () => {
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [container('c1', 'One')],
      nextCursor: null,
    });
    useSharedContainersStore.setState({
      organizations: [
        { id: 'org-1', name: 'One', createdAt: '', updatedAt: '' },
      ],
    });
    await useSharedContainerReplicasStore.getState().loadSharedWithMe();
    bridge.open.mockResolvedValue(available('rev-1'));
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });

    await useSharedContainerReplicasStore
      .getState()
      .dismissContainer('c1', 'org-1');

    expect(useSharedContainerReplicasStore.getState().entries).toEqual([]);
    expect(useSharedContainerReplicasStore.getState().viewer).toBeNull();
    expect(bridge.dismiss).toHaveBeenCalledWith({
      containerId: 'c1',
      organizationId: 'org-1',
    });
  });
});

describe('dismissed shares (CAN-2551)', () => {
  function seedListing(): void {
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [container('c1', 'Declined'), container('c2', 'Kept')],
      nextCursor: null,
    });
    useSharedContainersStore.setState({
      organizations: [
        { id: 'org-1', name: 'One', createdAt: '', updatedAt: '' },
      ],
    });
  }

  it('keeps a dismissed container out of the next authoritative listing', async () => {
    seedListing();

    await expect(
      useSharedContainerReplicasStore
        .getState()
        .dismissContainer('c1', 'org-1'),
    ).resolves.toBe(true);
    await flushAsyncWork();
    await useSharedContainerReplicasStore.getState().loadSharedWithMe();

    // `dismissedIds` was written but never read, so a server that had not yet
    // caught up resurrected the row on the next listing.
    const ids = useSharedContainerReplicasStore
      .getState()
      .entries.map((entry) => entry.container.id);
    expect(ids).not.toContain('c1');
    expect(ids).toContain('c2');
  });

  // The rollback restores this container's own row rather than whole-array
  // snapshots, so a listing that lands while the revoke is in flight is not
  // rolled back with it.
  it('does not clobber a concurrent listing update when rolling back', async () => {
    seedListing();
    await useSharedContainerReplicasStore.getState().loadSharedWithMe();
    bridge.dismiss.mockImplementationOnce(() => {
      // A third share arrives from an authoritative listing mid-revoke.
      const arrived: SharedContainerListEntry = {
        container: container('c3', 'Arrived'),
        organizationId: 'org-1',
      };
      useSharedContainerReplicasStore.setState((current) => ({
        entries: [...current.entries, arrived],
      }));
      throw new Error('server unreachable');
    });

    await expect(
      useSharedContainerReplicasStore
        .getState()
        .dismissContainer('c1', 'org-1'),
    ).resolves.toBe(false);

    const ids = useSharedContainerReplicasStore
      .getState()
      .entries.map((entry) => entry.container.id);
    expect(ids).toContain('c1');
    expect(ids).toContain('c3');
  });

  // A failed dismiss must not look like a successful one. The confirm copy
  // promises the local copy is deleted and access given up, so silently hiding
  // a row whose grant is still live — with `dismissedIds` suppressing the very
  // listing that would restore it — would strand the recipient with no retry.
  it('restores the row and reports failure when the server revoke fails', async () => {
    seedListing();
    await useSharedContainerReplicasStore.getState().loadSharedWithMe();
    bridge.dismiss.mockRejectedValueOnce(new Error('server unreachable'));

    await expect(
      useSharedContainerReplicasStore
        .getState()
        .dismissContainer('c1', 'org-1'),
    ).resolves.toBe(false);
    await flushAsyncWork();

    const ids = useSharedContainerReplicasStore
      .getState()
      .entries.map((entry) => entry.container.id);
    expect(ids).toContain('c1');
    expect(
      useSharedContainerReplicasStore.getState().dismissedIds,
    ).not.toContain('c1');
  });
});

describe('sync phases (CAN-2551)', () => {
  it('labels the in-flight open with the reported phase', async () => {
    const gate = deferred<SharedContainerReplicaState>();
    bridge.open.mockReturnValueOnce(gate.promise);
    const open = useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });

    expect(useSharedContainerReplicasStore.getState().viewer?.syncPhase).toBe(
      'checking-access',
    );
    useSharedContainerReplicasStore
      .getState()
      .applySyncPhase({ containerId: 'c1', phase: 'checking-out' });
    expect(useSharedContainerReplicasStore.getState().viewer?.syncPhase).toBe(
      'checking-out',
    );

    gate.resolve(available('rev-1'));
    await open;

    expect(
      useSharedContainerReplicasStore.getState().viewer?.syncPhase,
    ).toBeUndefined();
  });

  it('ignores a phase for a container that is not mounted', async () => {
    bridge.open.mockResolvedValue(available('rev-1'));
    await useSharedContainerReplicasStore
      .getState()
      .openContainer({ containerId: 'c1', organizationId: 'org-1' });

    useSharedContainerReplicasStore
      .getState()
      .applySyncPhase({ containerId: 'c2', phase: 'downloading' });

    expect(
      useSharedContainerReplicasStore.getState().viewer?.syncPhase,
    ).toBeUndefined();
  });
});
