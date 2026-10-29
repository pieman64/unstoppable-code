/**
 * @jest-environment jsdom
 *
 * Recipient store coverage for recoverable removal (CAN-4052): the removed
 * listing and its paging, the provisional row a removal leaves, and restore.
 */
import type { SharedContainerInboxChangedEvent } from '@canopy/desktop-shared/types';
import {
  initializeSharedContainerReplicasStore,
  useSharedContainerReplicasStore,
  SHARED_CONTAINER_REMOVED_ENTRY_CAP,
  SHARED_CONTAINER_REMOVED_PAGE_LIMIT,
  type SharedContainerListEntry,
  type SharedContainerRemovedEntry,
} from '../sharedContainerReplicasStore';
import { useSharedContainersStore } from '../sharedContainersStore';

jest.mock('@/lib/renderer-error-logging', () => ({
  reportRendererConsoleError: jest.fn(),
}));

type InboxListener = (event: SharedContainerInboxChangedEvent) => void;

interface MockBridge {
  listSharedWithMe: jest.Mock;
  searchMembers: jest.Mock;
  listAccepted: jest.Mock;
  accept: jest.Mock;
  dismiss: jest.Mock;
  listDismissed: jest.Mock;
  restore: jest.Mock;
  close: jest.Mock;
  onReplicaChanged: jest.Mock;
  onSyncPhase: jest.Mock;
  onInboxChanged: jest.Mock;
}

let bridge: MockBridge;
let inboxListeners: InboxListener[] = [];

function summary(
  id: string,
  title = id,
): SharedContainerListEntry['container'] {
  return {
    id,
    organizationId: 'org-1',
    ownerUserId: 'owner-1',
    owner: { name: 'Dana' },
    containerType: 'CODE_WORKTREE',
    title,
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    capabilities: ['VIEW'],
  };
}

function dismissed(
  id: string,
  dismissedAt: string,
): SharedContainerRemovedEntry['container'] & { dismissedAt: string } {
  return { ...summary(id), dismissedAt };
}

function removedEntry(
  id: string,
  dismissedAt = '2026-10-01T00:00:00.000Z',
): SharedContainerRemovedEntry {
  return {
    organizationId: 'org-1',
    container: summary(id),
    ownerName: 'Dana',
    dismissedAt,
  };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function store(): ReturnType<typeof useSharedContainerReplicasStore.getState> {
  return useSharedContainerReplicasStore.getState();
}

beforeEach(() => {
  inboxListeners = [];
  bridge = {
    listSharedWithMe: jest
      .fn()
      .mockResolvedValue({ containers: [], nextCursor: null }),
    searchMembers: jest.fn().mockResolvedValue({ members: [] }),
    listAccepted: jest.fn().mockResolvedValue({ containerIds: [] }),
    accept: jest.fn().mockResolvedValue({ accepted: true }),
    dismiss: jest.fn().mockResolvedValue({ dismissed: true }),
    listDismissed: jest
      .fn()
      .mockResolvedValue({ containers: [], nextCursor: null }),
    restore: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
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
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { sharedContainers: bridge },
  });
  store().reset();
  useSharedContainersStore.setState({
    accountHydrationFailed: false,
    orgBillingStates: [],
    organizations: [{ id: 'org-1', name: 'One', createdAt: '', updatedAt: '' }],
  });
});

describe('loadRemoved', () => {
  it('lists removed shares per organization, most recently removed first', async () => {
    bridge.listDismissed.mockResolvedValue({
      containers: [
        dismissed('old', '2026-09-01T00:00:00.000Z'),
        dismissed('new', '2026-10-01T00:00:00.000Z'),
      ],
      nextCursor: null,
    });

    await store().loadRemoved();

    expect(bridge.listDismissed).toHaveBeenCalledWith({
      organizationId: 'org-1',
      limit: SHARED_CONTAINER_REMOVED_PAGE_LIMIT,
    });
    expect(store().removedStatus).toBe('success');
    expect(store().removedEntries.map((entry) => entry.container.id)).toEqual([
      'new',
      'old',
    ]);
    expect(store().removedEntries[0]).toMatchObject({
      organizationId: 'org-1',
      ownerName: 'Dana',
      dismissedAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('drains every page so the count is complete', async () => {
    bridge.listDismissed
      .mockResolvedValueOnce({
        containers: [dismissed('a', '2026-10-03T00:00:00.000Z')],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        containers: [dismissed('b', '2026-10-02T00:00:00.000Z')],
        nextCursor: null,
      });

    await store().loadRemoved();

    expect(bridge.listDismissed).toHaveBeenNthCalledWith(2, {
      organizationId: 'org-1',
      cursor: 'page-2',
      limit: SHARED_CONTAINER_REMOVED_PAGE_LIMIT,
    });
    expect(store().removedEntries).toHaveLength(2);
  });

  it('stops paging at the entry cap', async () => {
    let page = 0;
    bridge.listDismissed.mockImplementation(() => {
      page += 1;
      const containers = Array.from(
        { length: SHARED_CONTAINER_REMOVED_PAGE_LIMIT },
        (_, index) =>
          dismissed(`p${page}-${index}`, '2026-10-01T00:00:00.000Z'),
      );
      return Promise.resolve({ containers, nextCursor: `after-${page}` });
    });

    await store().loadRemoved();

    expect(bridge.listDismissed).toHaveBeenCalledTimes(
      SHARED_CONTAINER_REMOVED_ENTRY_CAP / SHARED_CONTAINER_REMOVED_PAGE_LIMIT,
    );
    expect(store().removedEntries).toHaveLength(
      SHARED_CONTAINER_REMOVED_ENTRY_CAP,
    );
  });

  it('records an unsupported server and lists nothing', async () => {
    store().reset();
    useSharedContainerReplicasStore.setState({
      removedEntries: [removedEntry('stale')],
    });
    bridge.listDismissed.mockResolvedValue({ unsupported: true });

    await store().loadRemoved();

    expect(store().removedStatus).toBe('unsupported');
    expect(store().removedEntries).toEqual([]);
  });

  it('treats a preload without the method as unsupported', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { sharedContainers: { ...bridge, listDismissed: undefined } },
    });

    await store().loadRemoved();

    expect(store().removedStatus).toBe('unsupported');
  });

  it('keeps the listed entries when a refresh fails', async () => {
    useSharedContainerReplicasStore.setState({
      removedEntries: [removedEntry('kept')],
      removedStatus: 'success',
    });
    bridge.listDismissed.mockRejectedValue(new Error('offline'));

    await store().loadRemoved();

    expect(store().removedStatus).toBe('error');
    expect(store().removedEntries.map((entry) => entry.container.id)).toEqual([
      'kept',
    ]);
  });

  it('reloads on any inbox signal, including this device’s own change', async () => {
    const dispose = initializeSharedContainerReplicasStore();
    try {
      await flushAsyncWork();
      bridge.listDismissed.mockClear();

      for (const listener of [...inboxListeners]) {
        listener({ reason: 'local' });
      }
      await flushAsyncWork();

      expect(bridge.listDismissed).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });
});

describe('dismissContainer and the removed list', () => {
  beforeEach(() => {
    useSharedContainerReplicasStore.setState({
      entries: [{ organizationId: 'org-1', container: summary('c1', 'Plan') }],
      listStatus: 'success',
      removedStatus: 'success',
    });
  });

  it('inserts a provisional removed row, then replaces it with the listing', async () => {
    let finishListing: (value: unknown) => void = () => undefined;
    bridge.listDismissed.mockReturnValue(
      new Promise((resolve) => {
        finishListing = resolve;
      }),
    );

    await expect(store().dismissContainer('c1', 'org-1')).resolves.toBe(true);

    // Restorable before the listing answers.
    expect(store().removedEntries.map((entry) => entry.container.id)).toEqual([
      'c1',
    ]);

    finishListing({
      containers: [dismissed('c1', '2026-10-05T00:00:00.000Z')],
      nextCursor: null,
    });
    await flushAsyncWork();

    // The listing's row replaces the provisional one; it is not duplicated.
    expect(store().removedEntries).toHaveLength(1);
    expect(store().removedEntries[0]?.dismissedAt).toBe(
      '2026-10-05T00:00:00.000Z',
    );
  });

  it('adds no provisional row against an unsupported server', async () => {
    useSharedContainerReplicasStore.setState({ removedStatus: 'unsupported' });
    bridge.listDismissed.mockResolvedValue({ unsupported: true });

    await store().dismissContainer('c1', 'org-1');

    expect(store().removedEntries).toEqual([]);
  });

  it('adds no removed row when the removal fails', async () => {
    bridge.dismiss.mockRejectedValue(new Error('offline'));

    await expect(store().dismissContainer('c1', 'org-1')).resolves.toBe(false);

    expect(store().removedEntries).toEqual([]);
  });
});

describe('restoreContainer', () => {
  beforeEach(() => {
    useSharedContainerReplicasStore.setState({
      removedEntries: [removedEntry('c1')],
      removedStatus: 'success',
      dismissedIds: ['c1'],
    });
  });

  it('drops the entry, stops hiding the share, and re-lists the inbox', async () => {
    bridge.restore.mockResolvedValue({
      restored: true,
      container: summary('c1'),
    });
    bridge.listSharedWithMe.mockResolvedValue({
      containers: [summary('c1')],
      nextCursor: null,
    });

    await expect(store().restoreContainer('c1')).resolves.toBe('restored');
    await flushAsyncWork();

    expect(bridge.restore).toHaveBeenCalledWith({
      containerId: 'c1',
      organizationId: 'org-1',
    });
    expect(store().removedEntries).toEqual([]);
    expect(store().dismissedIds).toEqual([]);
    expect(store().restoringIds).toEqual([]);
    // Listed again as a pending invitation.
    expect(store().entries.map((entry) => entry.container.id)).toEqual(['c1']);
    expect(store().acceptedIds).not.toContain('c1');
  });

  it('drops a share that is no longer restorable and reloads the list', async () => {
    bridge.restore.mockResolvedValue({
      restored: false,
      reason: 'not-restorable',
    });

    await expect(store().restoreContainer('c1')).resolves.toBe(
      'not-restorable',
    );
    await flushAsyncWork();

    expect(store().removedEntries).toEqual([]);
    expect(bridge.listDismissed).toHaveBeenCalledTimes(1);
  });

  it('records an unsupported server', async () => {
    bridge.restore.mockResolvedValue({
      restored: false,
      reason: 'unsupported',
    });

    await expect(store().restoreContainer('c1')).resolves.toBe('unsupported');

    expect(store().removedStatus).toBe('unsupported');
    expect(store().removedEntries).toEqual([]);
  });

  it('keeps the entry when the request fails', async () => {
    bridge.restore.mockRejectedValue(new Error('offline'));

    await expect(store().restoreContainer('c1')).resolves.toBe('failed');

    expect(store().removedEntries).toHaveLength(1);
    expect(store().restoringIds).toEqual([]);
  });

  it('sends one request for two clicks on the same share', async () => {
    let finish: (value: unknown) => void = () => undefined;
    bridge.restore.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );

    const first = store().restoreContainer('c1');
    expect(store().restoringIds).toEqual(['c1']);
    await expect(store().restoreContainer('c1')).resolves.toBe('in-flight');
    finish({ restored: true, container: summary('c1') });
    await expect(first).resolves.toBe('restored');

    expect(bridge.restore).toHaveBeenCalledTimes(1);
  });
});

describe('accept failure and accepted time', () => {
  it('marks a failed accept and clears it on the next attempt', async () => {
    bridge.accept.mockRejectedValueOnce(new Error('offline'));

    await store().acceptContainer({
      containerId: 'c1',
      shouldOpen: () => false,
    });
    expect(store().acceptFailedId).toBe('c1');

    await store().acceptContainer({
      containerId: 'c1',
      shouldOpen: () => false,
    });
    expect(store().acceptFailedId).toBeNull();
    expect(store().acceptedIds).toContain('c1');
  });

  it('carries the accepted time from main into the record', async () => {
    bridge.accept.mockResolvedValue({
      accepted: true,
      record: {
        organizationId: 'org-1',
        acceptedAt: '2026-10-02T00:00:00.000Z',
      },
    });

    await store().acceptContainer({
      containerId: 'c1',
      organizationId: 'org-1',
      shouldOpen: () => false,
    });

    expect(store().acceptedRecords.c1?.acceptedAt).toBe(
      '2026-10-02T00:00:00.000Z',
    );
  });
});

describe('Past shares page state', () => {
  it('opens and closes', () => {
    store().openPastShares();
    expect(store().pastSharesOpen).toBe(true);
    store().closePastShares();
    expect(store().pastSharesOpen).toBe(false);
  });
});
