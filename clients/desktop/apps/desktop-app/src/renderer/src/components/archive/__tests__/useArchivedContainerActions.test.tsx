/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ArchivedContainerRestoreResponse } from '@canopy/desktop-shared/types';
import {
  type ArchivedContainerActions,
  useArchivedContainerActions,
} from '../useArchivedContainerActions';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { useGitHubStore } from '@/stores/githubStore';

const mockOfferRetained = jest.fn<
  Promise<boolean>,
  [string, string, () => void]
>(() => Promise.resolve(false));
jest.mock('../offerRetainedArchiveDiscard', () => ({
  ARCHIVED_ITEM_DELETE_FAILED: "Couldn't permanently delete this item",
  offerRetainedArchiveDiscard: (
    workspaceId: string,
    containerId: string,
    retry: () => void,
  ): Promise<boolean> => mockOfferRetained(workspaceId, containerId, retry),
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface ActionCase {
  action: 'setArchived' | 'restore' | 'deletePermanently';
  storeAction: 'setLocked' | 'restore' | 'deletePermanently';
  result: ArchivedContainerRestoreResponse | boolean | null;
}

const actionCases: ActionCase[] = [
  { action: 'setArchived', storeAction: 'setLocked', result: null },
  { action: 'restore', storeAction: 'restore', result: null },
  {
    action: 'deletePermanently',
    storeAction: 'deletePermanently',
    result: false,
  },
];

interface HookProbe {
  current: ArchivedContainerActions | null;
}

function HookHarness({ probe }: { probe: HookProbe }): null {
  probe.current = useArchivedContainerActions(
    'workspace-1',
    'archive-1',
    false,
  );
  return null;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('useArchivedContainerActions', () => {
  let container: HTMLDivElement;
  let root: Root;
  let probe: HookProbe;

  beforeEach(() => {
    mockOfferRetained.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    probe = { current: null };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderHook(): ArchivedContainerActions {
    act(() => {
      root.render(<HookHarness probe={probe} />);
    });
    if (!probe.current) {
      throw new Error('Expected archived container actions hook to render');
    }
    return probe.current;
  }

  it.each(actionCases)(
    'deduplicates synchronous $action calls before React rerenders',
    async ({ action, storeAction, result }) => {
      const pending = deferred<typeof result>();
      const operation = jest.fn().mockReturnValue(pending.promise);
      useArchivedContainersStore.setState({ [storeAction]: operation });
      const actions = renderHook();

      let first!: Promise<void>;
      let second!: Promise<void>;
      act(() => {
        // The harness renders a Deleted (unlocked) item, so `setArchived(true)`
        // is a real state change rather than the no-op same-state short-cut.
        first =
          action === 'setArchived'
            ? actions.setArchived(true)
            : actions[action]();
        second =
          action === 'setArchived'
            ? actions.setArchived(true)
            : actions[action]();
      });

      expect(operation).toHaveBeenCalledTimes(1);

      pending.resolve(result);
      await act(async () => {
        await Promise.all([first, second]);
      });
    },
  );

  it.each([
    ['offers the discard instead of the toast', true],
    ['keeps the toast when nothing can be discarded', false],
  ])('CAN-5338 a failed permanent deletion %s', async (_label, offered) => {
    const operation = jest.fn().mockResolvedValue(false);
    const addToast = jest.fn();
    useArchivedContainersStore.setState({ deletePermanently: operation });
    useGitHubStore.setState({ addToast });
    mockOfferRetained.mockResolvedValueOnce(offered);
    const actions = renderHook();
    await act(async () => {
      await actions.deletePermanently();
    });
    expect(mockOfferRetained).toHaveBeenCalledWith(
      'workspace-1',
      'archive-1',
      expect.any(Function),
    );
    expect(addToast).toHaveBeenCalledTimes(offered ? 0 : 1);
    // The dialog's Retry runs the permanent deletion again.
    const retry = mockOfferRetained.mock.calls[0]?.[2];
    await act(async () => {
      retry?.();
      await Promise.resolve();
    });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('treats a same-state setArchived call as a no-op', async () => {
    const operation = jest.fn();
    useArchivedContainersStore.setState({ setLocked: operation });
    const actions = renderHook();
    await act(async () => {
      await actions.setArchived(false);
    });
    expect(operation).not.toHaveBeenCalled();
  });
});
