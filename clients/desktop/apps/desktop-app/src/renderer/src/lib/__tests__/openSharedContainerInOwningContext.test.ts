/**
 * @jest-environment jsdom
 *
 * Which context an open or accept enters (CAN-3554): an accepted share opens
 * in the context its acceptance record names, not in the one the latest
 * listing round happens to classify it under.
 */
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import type { SharedContainerRef } from '@canopy/protocol/shared-containers';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import type {
  SharedContainerAccess,
  WorkspaceContextState,
} from '@canopy/desktop-shared/types';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  useSharedContainerReplicasStore,
  type SharedContainerListEntry,
} from '@/stores/sharedContainerReplicasStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { openSharedContainerInOwningContext } from '../openSharedContainerInOwningContext';

jest.mock('@/lib/dismissPageLikeViewers', () => ({
  dismissPageLikeViewers: jest.fn(),
}));

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONTAINER_ID = 'share-a';
const PERSONAL: WorkspaceContext = { kind: 'personal' };
const ACME: WorkspaceContext = { kind: 'organization', organizationId: ORG_A };

interface OpenRequest {
  containerId: string;
  organizationId?: string;
  access?: SharedContainerAccess;
}

function ref(overrides: Partial<SharedContainerRef> = {}): SharedContainerRef {
  return {
    id: CONTAINER_ID,
    organizationId: ORG_A,
    ownerUserId: 'owner-1',
    owner: { userId: 'owner-1', name: 'Dana' },
    access: 'organization',
    containerType: 'CODE_WORKTREE',
    ...overrides,
  };
}

function listed(access?: SharedContainerAccess): SharedContainerListEntry {
  return {
    organizationId: ORG_A,
    ...(access ? { access } : {}),
    container: {
      ...ref(),
      title: 'Checkout flow',
      revision: 1,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
      capabilities: ['VIEW'],
    },
  };
}

describe('openSharedContainerInOwningContext', () => {
  let setContext: jest.Mock<Promise<WorkspaceContextState>, [WorkspaceContext]>;
  let acceptContainer: jest.Mock<Promise<void>, [OpenRequest]>;
  let openContainer: jest.Mock<Promise<void>, [OpenRequest]>;
  let loadAccepted: jest.Mock<Promise<void>, []>;

  function seed(
    context: WorkspaceContext,
    replicas: {
      entries: SharedContainerListEntry[];
      acceptedIds?: string[];
      acceptedRecords?: Record<
        string,
        { organizationId?: string; access?: SharedContainerAccess }
      >;
    },
  ): void {
    useWorkspaceContextStore.setState({
      state: {
        context,
        revision: 1,
        organizations: [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }],
      },
      hydrated: true,
      setContext,
    });
    useSharedContainerReplicasStore.setState({
      entries: replicas.entries,
      listStatus: 'success',
      acceptedIds: replicas.acceptedIds ?? [],
      acceptedRecords: replicas.acceptedRecords ?? {},
      acceptedStatus: 'success',
      loadSharedWithMe: jest.fn().mockResolvedValue(undefined),
      loadAccepted,
      acceptContainer,
      openContainer,
    });
  }

  beforeEach((): void => {
    const snapshot = getDefaultFeatureFlagSnapshot();
    snapshot.values[CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key] = true;
    useFeatureFlagsStore.setState({ snapshot });
    useNavigationStore.setState({ navigate: jest.fn() });
    setContext = jest.fn((context: WorkspaceContext) => {
      const state = { ...useWorkspaceContextStore.getState().state, context };
      useWorkspaceContextStore.setState({ state });
      return Promise.resolve(state);
    });
    const mountViewer = (request: OpenRequest): Promise<void> => {
      useSharedContainerReplicasStore.setState({
        viewer: {
          containerId: request.containerId,
          organizationId: request.organizationId,
          access: request.access,
          replica: {
            containerId: request.containerId,
            organizationId: ORG_A,
            containerType: 'CODE_WORKTREE',
            updatedAt: '2026-09-02T00:00:00.000Z',
            status: 'available',
            revisionId: 'rev-1',
            revision: 1,
            revisionCreatedAt: '2026-09-02T00:00:00.000Z',
          },
          openError: null,
          loading: false,
        },
      });
      return Promise.resolve();
    };
    acceptContainer = jest.fn(mountViewer);
    openContainer = jest.fn(mountViewer);
    loadAccepted = jest.fn((): Promise<void> => Promise.resolve());
  });

  afterEach((): void => {
    useSharedContainerReplicasStore.getState().reset();
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot(),
    });
    useWorkspaceContextStore.setState({ hydrated: false });
  });

  it('enters the organization the share was accepted in when the listing classifies it as direct', async () => {
    seed(PERSONAL, {
      entries: [listed('direct')],
      acceptedIds: [CONTAINER_ID],
      acceptedRecords: { [CONTAINER_ID]: { organizationId: ORG_A } },
    });

    await openSharedContainerInOwningContext({
      resolveAccess: () => Promise.resolve(ref({ access: 'direct' })),
      mode: 'open',
    });

    expect(setContext).toHaveBeenCalledWith(ACME);
    // The access path sent to main still follows the listing.
    expect(openContainer).toHaveBeenCalledWith({
      containerId: CONTAINER_ID,
      organizationId: ORG_A,
      access: 'direct',
    });
  });

  it('enters Personal for a share accepted as direct when the listing classifies it as an organization share', async () => {
    seed(ACME, {
      entries: [listed()],
      acceptedIds: [CONTAINER_ID],
      acceptedRecords: { [CONTAINER_ID]: { access: 'direct' } },
    });

    await openSharedContainerInOwningContext({
      resolveAccess: () => Promise.resolve(ref()),
      mode: 'open',
    });

    expect(setContext).toHaveBeenCalledWith(PERSONAL);
  });

  it('follows the listing for a share with no acceptance record', async () => {
    seed(PERSONAL, { entries: [listed('direct')] });

    await openSharedContainerInOwningContext({
      resolveAccess: () => Promise.resolve(ref({ access: 'direct' })),
      mode: 'accept',
    });

    expect(setContext).not.toHaveBeenCalled();
    expect(acceptContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        containerId: CONTAINER_ID,
        organizationId: ORG_A,
        access: 'direct',
        // The listing's type is main's acceptance telemetry hint.
        containerType: 'CODE_WORKTREE',
      }),
    );
    expect(openContainer).not.toHaveBeenCalled();
  });

  it('sends an already accepted share through accept, so main re-checks run consent', async () => {
    seed(ACME, {
      entries: [listed('direct')],
      acceptedIds: [CONTAINER_ID],
      acceptedRecords: { [CONTAINER_ID]: { organizationId: ORG_A } },
    });

    await openSharedContainerInOwningContext({
      resolveAccess: () => Promise.resolve(ref({ access: 'direct' })),
      mode: 'accept',
    });

    // Main keeps the record on a repeat accept, and it is the only place that
    // drops run consent when the owner identity changed.
    expect(acceptContainer).toHaveBeenCalledTimes(1);
    expect(acceptContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        containerId: CONTAINER_ID,
        organizationId: ORG_A,
        access: 'direct',
      }),
    );
    expect(openContainer).not.toHaveBeenCalled();
    expect(setContext).not.toHaveBeenCalled();
  });

  it('enters the context of a record main holds and this store has not read', async () => {
    // A link claim records the acceptance in main. The listing round that
    // follows classifies the share as direct.
    seed(PERSONAL, { entries: [listed('direct')] });
    loadAccepted.mockImplementation((): Promise<void> => {
      useSharedContainerReplicasStore.setState({
        acceptedIds: [CONTAINER_ID],
        acceptedRecords: {
          [CONTAINER_ID]: { organizationId: ORG_A, access: 'organization' },
        },
      });
      return Promise.resolve();
    });

    await openSharedContainerInOwningContext({
      resolveAccess: () => Promise.resolve(ref()),
      mode: 'accept',
    });

    expect(loadAccepted).toHaveBeenCalledTimes(1);
    expect(setContext).toHaveBeenCalledWith(ACME);
    expect(acceptContainer).toHaveBeenCalledTimes(1);
  });

  it('fails the open when the accepted list cannot be reread', async () => {
    seed(PERSONAL, {
      entries: [listed('direct')],
      acceptedIds: [CONTAINER_ID],
      acceptedRecords: { [CONTAINER_ID]: { organizationId: ORG_A } },
    });
    // The store fails closed: a rejected read leaves no ids and no records.
    loadAccepted.mockImplementation((): Promise<void> => {
      useSharedContainerReplicasStore.setState({
        acceptedIds: [],
        acceptedRecords: {},
        acceptedStatus: 'error',
      });
      return Promise.resolve();
    });

    // Without the record the listing would choose the context, which is the
    // placement this change exists to prevent.
    await expect(
      openSharedContainerInOwningContext({
        resolveAccess: () => Promise.resolve(ref({ access: 'direct' })),
        mode: 'accept',
      }),
    ).rejects.toThrow('The accepted shared projects could not be read.');
    expect(setContext).not.toHaveBeenCalled();
    expect(acceptContainer).not.toHaveBeenCalled();
    expect(openContainer).not.toHaveBeenCalled();
  });

  it('does not reread the accepted list for a plain open', async () => {
    seed(ACME, {
      entries: [listed()],
      acceptedIds: [CONTAINER_ID],
      acceptedRecords: { [CONTAINER_ID]: { organizationId: ORG_A } },
    });

    await openSharedContainerInOwningContext({
      resolveAccess: () => Promise.resolve(ref()),
      mode: 'open',
    });

    expect(loadAccepted).not.toHaveBeenCalled();
    expect(openContainer).toHaveBeenCalledTimes(1);
  });

  it('refuses a share that no context lists', async () => {
    seed(PERSONAL, { entries: [] });

    await expect(
      openSharedContainerInOwningContext({
        resolveAccess: () =>
          Promise.resolve(ref({ organizationId: undefined })),
        mode: 'open',
      }),
    ).rejects.toThrow('The shared container has no owning organization.');
    expect(setContext).not.toHaveBeenCalled();
    expect(openContainer).not.toHaveBeenCalled();
  });
});
