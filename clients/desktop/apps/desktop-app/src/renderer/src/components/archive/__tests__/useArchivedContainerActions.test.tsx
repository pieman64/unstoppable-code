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
