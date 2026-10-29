/**
 * @jest-environment jsdom
 *
 * CAN-2551 seam regression: `dismissPageLikeViewers` is called by navigation
 * paths that *leave* a viewer, and also by the two paths whose destination is
 * the shared-container viewer itself (the sidebar row and the App Advisor
 * `open shared container` action).
 *
 * On the second kind of call site the shared viewer must stay mounted.
 * `closeViewer()` clears the viewer, which is the state `openContainer`'s
 * already-mounted guard reads, so the `open` that follows it in the same click
 * handler would tear a share that is already on screen back down to `loading`
 * and re-run the access gate.
 *
 * Keeping the viewer is no longer what protects live updates. A close names
 * the viewer session it belongs to (CAN-3559), so main ignores one that lands
 * after a newer open of the same share instead of releasing that open's
 * subscription and fallback pull.
 */
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { useSharedContainerReplicasStore } from '@/stores/sharedContainerReplicasStore';
import { dismissPageLikeViewers } from '../dismissPageLikeViewers';

const close = jest.fn().mockResolvedValue(undefined);

beforeEach(() => {
  close.mockClear();
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { sharedContainers: { close } },
  });
  useSharedContainerReplicasStore.getState().reset();
  useSharedContainerReplicasStore.setState({
    viewer: {
      containerId: 'c1',
      organizationId: 'org-1',
      replica: null,
      openError: null,
      loading: false,
    },
  });
});

it('closes both page-like viewers when navigating away', async () => {
  const archivedCloseViewer = jest.spyOn(
    useArchivedContainersStore.getState(),
    'closeViewer',
  );

  dismissPageLikeViewers();

  expect(archivedCloseViewer).toHaveBeenCalled();
  expect(useSharedContainerReplicasStore.getState().viewer).toBeNull();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(close).toHaveBeenCalledWith({ containerId: 'c1' });
  archivedCloseViewer.mockRestore();
});

it('keeps the shared-container viewer when it is the destination', async () => {
  const archivedCloseViewer = jest.spyOn(
    useArchivedContainersStore.getState(),
    'closeViewer',
  );

  dismissPageLikeViewers({ keepSharedContainerViewer: true });

  // The archived viewer still has to go: it occupies the same overlay slot.
  expect(archivedCloseViewer).toHaveBeenCalled();
  expect(useSharedContainerReplicasStore.getState().viewer?.containerId).toBe(
    'c1',
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(close).not.toHaveBeenCalled();
  archivedCloseViewer.mockRestore();
});
