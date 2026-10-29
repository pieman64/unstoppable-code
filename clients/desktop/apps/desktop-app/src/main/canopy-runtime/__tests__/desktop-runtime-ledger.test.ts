import type * as FeatureFlagsModule from '../../feature-flags';
import type * as StorageClientModule from '../../ledger/storage-client';

const mockGetLedgerStoreClient = jest.fn();
const mockIsFlagEnabled = jest.fn();

jest.mock('../../ledger/storage-client', () => ({
  ...jest.requireActual<typeof StorageClientModule>(
    '../../ledger/storage-client',
  ),
  getLedgerStoreClient: (): unknown => mockGetLedgerStoreClient(),
}));
jest.mock('../../feature-flags', () => ({
  ...jest.requireActual<typeof FeatureFlagsModule>('../../feature-flags'),
  getFeatureFlagService: (): { isEnabled: (key: string) => unknown } => ({
    isEnabled: (key: string): unknown => mockIsFlagEnabled(key),
  }),
}));

import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type { FileTreeRootsResponse } from '@canopy/desktop-shared/types';
import { createDesktopRuntime } from '../desktop-runtime';
import {
  createLedgerServiceHarness,
  type LedgerServiceHarness,
} from '../../ledger/__tests__/fixtures/in-process-ledger-store-client';

const ENTRY_ID = '00000000-0000-4000-8000-000000000001';

const roots: FileTreeRootsResponse = {
  roots: [
    {
      repoId: 'repo-1',
      repoName: 'Repository',
      absolutePath: '/repo',
      rootKind: 'git-repo',
    },
  ],
};

const filesystemServices = {
  listFileTreeRoots: (): Promise<FileTreeRootsResponse> =>
    Promise.resolve(roots),
  listFileTreeDirectory: (): Promise<{ entries: [] }> =>
    Promise.resolve({ entries: [] }),
};

const expectedUnavailableError = {
  payload: {
    kind: 'capability_unavailable',
    code: 'core.ledger.writerUnavailable',
    details: { reason: 'WRITER_UNAVAILABLE' },
    retry: { kind: 'after_refresh', resource: 'core.ledger' },
  },
};

function ledgerCalls(
  dispatcher: ReturnType<typeof createDesktopRuntime>,
  caller: CanopyCallerDescriptor,
): Array<{ name: string; invoke: () => Promise<unknown> }> {
  return [
    {
      name: 'core.ledger.entries.search',
      invoke: () =>
        dispatcher.query('core.ledger.entries.search', {}, { caller }),
    },
    {
      name: 'core.ledger.entry.get',
      invoke: () =>
        dispatcher.query(
          'core.ledger.entry.get',
          { entryId: ENTRY_ID },
          { caller },
        ),
    },
    {
      name: 'core.ledger.owners.list',
      invoke: () => dispatcher.query('core.ledger.owners.list', {}, { caller }),
    },
    {
      name: 'core.ledger.changes.list',
      invoke: () =>
        dispatcher.query(
          'core.ledger.changes.list',
          { afterSequence: '0' },
          { caller },
        ),
    },
    {
      name: 'core.ledger.entry.add',
      invoke: () =>
        dispatcher.instruction(
          'core.ledger.entry.add',
          {
            type: 'TASK',
            title: 'Plan the work',
            content: 'Write the plan.',
            _meta: { idempotencyKey: 'ledger-test-1' },
          },
          { caller, metadata: { idempotencyKey: 'ledger-test-1' } },
        ),
    },
    {
      name: 'core.ledger.entry.update',
      invoke: () =>
        dispatcher.instruction(
          'core.ledger.entry.update',
          {
            entryId: ENTRY_ID,
            expectedRevision: 1,
            status: 'IN_PROGRESS',
            _meta: { idempotencyKey: 'ledger-test-2' },
          },
          { caller, metadata: { idempotencyKey: 'ledger-test-2' } },
        ),
    },
    {
      name: 'core.ledger.summary.publish',
      invoke: () =>
        dispatcher.instruction(
          'core.ledger.summary.publish',
          {
            snapshotId: 'snapshot-1',
            generationId: 'generation-1',
            title: 'Summary',
            content: 'Summary text',
            sourceTruncated: false,
            _meta: { idempotencyKey: 'summary:ledger:snapshot-1' },
          },
          {
            caller,
            metadata: { idempotencyKey: 'summary:ledger:snapshot-1' },
          },
        ),
    },
  ];
}

beforeEach(() => {
  mockGetLedgerStoreClient.mockReset();
  mockIsFlagEnabled.mockReset();
  mockIsFlagEnabled.mockReturnValue(false);
});

describe('desktop runtime Ledger handlers', () => {
  let harness: LedgerServiceHarness;
  let dispatcher: ReturnType<typeof createDesktopRuntime>;

  beforeEach(() => {
    harness = createLedgerServiceHarness();
    harness.enabled = false;
    dispatcher = createDesktopRuntime({
      services: filesystemServices,
      ledgerService: harness.service,
    });
  });

  afterEach(async () => {
    await dispatcher.shutdown();
    harness.dispose();
  });

  it('answers every Ledger operation unavailable while the flag is off', async () => {
    const caller = harness.caller(harness.register());

    for (const { invoke } of ledgerCalls(dispatcher, caller)) {
      await expect(invoke()).rejects.toMatchObject(expectedUnavailableError);
    }
    expect(harness.storeRequests()).toBe(0);
    expect(harness.store.client.calls).toEqual([]);
  });

  it('serves the Ledger once the flag is on', async () => {
    harness.enabled = true;
    const caller = harness.caller(harness.register());

    const added = await dispatcher.instruction(
      'core.ledger.entry.add',
      {
        type: 'TASK',
        title: 'Plan the work',
        content: 'Write the plan.',
        _meta: { idempotencyKey: 'ledger-test-1' },
      },
      { caller, metadata: { idempotencyKey: 'ledger-test-1' } },
    );

    await expect(
      dispatcher.query(
        'core.ledger.entry.get',
        { entryId: added.entry.entryId },
        { caller },
      ),
    ).resolves.toMatchObject({ entry: added.entry });
  });

  it('requires instruction idempotency metadata before invoking its handler', async () => {
    harness.enabled = true;

    await expect(
      dispatcher.instruction(
        'core.ledger.entry.add',
        {
          type: 'TASK',
          title: 'Plan the work',
          content: 'Write the plan.',
          _meta: { idempotencyKey: 'ledger-test-3' },
        },
        { caller: harness.caller(harness.register()) },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(harness.storeRequests()).toBe(0);
  });

  it('keeps the existing filesystem query operational', async () => {
    const caller = harness.caller('local-desktop-user', [
      'worker.filesystem.read',
    ]);

    await expect(
      dispatcher.query(
        'worker.filesystem.roots.list',
        { scope: { workspaceId: 'workspace-1', worktreeId: 'worktree-1' } },
        { caller },
      ),
    ).resolves.toEqual({
      roots: [{ fileRootId: 'repo-1', name: 'Repository', kind: 'git-repo' }],
    });
  });
});

describe('default desktop runtime', () => {
  const caller: CanopyCallerDescriptor = {
    principalId: 'test-user',
    clientInstanceId: 'test-client',
    authorityId: 'test-authority',
    interfaceKind: 'test',
    grants: [
      'core.ledger.read',
      'core.ledger.write',
      'core.ledger.publishSummary',
    ],
  };

  it('neither opens Ledger storage at startup nor while the flag is off', async () => {
    const dispatcher = createDesktopRuntime({ services: filesystemServices });

    try {
      expect(mockGetLedgerStoreClient).not.toHaveBeenCalled();
      expect(mockIsFlagEnabled).not.toHaveBeenCalled();

      for (const { invoke } of ledgerCalls(dispatcher, caller)) {
        await expect(invoke()).rejects.toMatchObject(expectedUnavailableError);
      }
      expect(mockIsFlagEnabled).toHaveBeenCalledWith('canopy-ledger-enabled');
      expect(mockGetLedgerStoreClient).not.toHaveBeenCalled();
    } finally {
      await dispatcher.shutdown();
    }
  });

  it('refuses an unbound principal without opening storage', async () => {
    mockIsFlagEnabled.mockReturnValue(true);
    const dispatcher = createDesktopRuntime({ services: filesystemServices });

    try {
      await expect(
        dispatcher.query('core.ledger.entries.search', {}, { caller }),
      ).rejects.toMatchObject({
        payload: {
          kind: 'permission_denied',
          code: 'core.ledger.forbidden',
          details: { reason: 'FORBIDDEN' },
        },
      });
      expect(mockGetLedgerStoreClient).not.toHaveBeenCalled();
    } finally {
      await dispatcher.shutdown();
    }
  });
});
