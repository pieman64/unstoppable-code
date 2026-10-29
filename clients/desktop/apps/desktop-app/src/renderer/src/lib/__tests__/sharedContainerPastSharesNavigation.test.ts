/**
 * @jest-environment jsdom
 *
 * The Past shares page shares one overlay slot with the archived overlays and
 * the share viewer (CAN-4052), so opening any of them closes the others.
 */
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useSharedContainerReplicasStore } from '@/stores/sharedContainerReplicasStore';
import { dismissPageLikeViewers } from '../dismissPageLikeViewers';
import {
  openArchivedOverviewSurface,
  openArchivedContainerSurface,
} from '../archivedContainerNavigation';
import {
  openAcceptedSharedContainer,
  openPastSharesSurface,
} from '../sharedContainerPastSharesNavigation';

const open = jest.fn().mockResolvedValue(null);
const close = jest.fn().mockResolvedValue(undefined);

/** Resolves once `open` was called, or after a bounded number of ticks. */
async function waitForOpenRequest(): Promise<void> {
  for (let tick = 0; tick < 50 && open.mock.calls.length === 0; tick += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function shared(): ReturnType<typeof useSharedContainerReplicasStore.getState> {
  return useSharedContainerReplicasStore.getState();
}

beforeEach(() => {
  open.mockClear();
  close.mockClear();
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { sharedContainers: { open, close } },
  });
  shared().reset();
});

it('closes the archived overlays and the viewer, then opens the page on main', () => {
  const archived = useArchivedContainersStore.getState();
  const closeViewer = jest.spyOn(archived, 'closeViewer');
  const closeOverview = jest.spyOn(archived, 'closeOverview');
  const navigate = jest.spyOn(useNavigationStore.getState(), 'navigate');
  useSharedContainerReplicasStore.setState({
    viewer: {
      containerId: 'c1',
      organizationId: 'org-1',
      replica: null,
      openError: null,
      loading: false,
    },
  });

  openPastSharesSurface();

  expect(closeViewer).toHaveBeenCalled();
  expect(closeOverview).toHaveBeenCalled();
  expect(navigate).toHaveBeenCalledWith('main');
  expect(shared().viewer).toBeNull();
  expect(shared().pastSharesOpen).toBe(true);
  closeViewer.mockRestore();
  closeOverview.mockRestore();
  navigate.mockRestore();
});

it('closes the page on any navigation that dismisses page-like viewers', () => {
  shared().openPastShares();
  dismissPageLikeViewers();
  expect(shared().pastSharesOpen).toBe(false);

  shared().openPastShares();
  dismissPageLikeViewers({ keepSharedContainerViewer: true });
  expect(shared().pastSharesOpen).toBe(false);
});

it('closes the page when an archived overlay opens', () => {
  shared().openPastShares();
  openArchivedOverviewSurface('workspace-1');
  expect(shared().pastSharesOpen).toBe(false);

  shared().openPastShares();
  openArchivedContainerSurface('workspace-1', 'archived-1');
  expect(shared().pastSharesOpen).toBe(false);
  useArchivedContainersStore.getState().closeViewer();
  useArchivedContainersStore.getState().closeOverview();
});

it('opens an accepted share in the viewer and closes the page', async () => {
  useSharedContainerReplicasStore.setState({
    acceptedIds: ['c1'],
    pastSharesOpen: true,
  });

  openAcceptedSharedContainer({
    organizationId: 'org-1',
    container: {
      id: 'c1',
      organizationId: 'org-1',
      ownerUserId: 'owner-1',
      containerType: 'CODE_WORKTREE',
      title: 'Plan',
      revision: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      capabilities: ['VIEW'],
    },
  });

  expect(shared().pastSharesOpen).toBe(false);
  expect(shared().viewer?.containerId).toBe('c1');
  // The open request waits for the viewer's previous layout to be released.
  await waitForOpenRequest();
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ containerId: 'c1', organizationId: 'org-1' }),
  );
});
