/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useActiveWorktreeCwd } from '../useActiveWorktreeCwd';
import { useChatStore } from '@/stores/chatStore';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

interface Probe {
  current: string | undefined;
}

interface DeferredPath {
  promise: Promise<string>;
  resolve: (value: string) => void;
}

function deferredPath(): DeferredPath {
  let resolvePath: (value: string) => void = () => undefined;
  const promise = new Promise<string>((resolve) => {
    resolvePath = resolve;
  });
  return { promise, resolve: resolvePath };
}

function Harness({ probe }: { probe: Probe }): JSX.Element {
  probe.current = useActiveWorktreeCwd();
  return <></>;
}

describe('useActiveWorktreeCwd', () => {
  const originalSelectedWorktree = useChatStore.getState().selectedWorktree;

  afterEach(() => {
    useChatStore.setState({ selectedWorktree: originalSelectedWorktree });
    Reflect.deleteProperty(window, 'api');
  });

  it('clears the previous cwd while a newly selected worktree resolves', async () => {
    const worktreeA = deferredPath();
    const worktreeB = deferredPath();
    const getWorktreePath = jest.fn(
      ({ worktreeId }: { worktreeId: string }): Promise<string> =>
        worktreeId === 'worktree-a' ? worktreeA.promise : worktreeB.promise,
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { getWorktreePath },
    });
    useChatStore.setState({
      selectedWorktree: { projectId: 'project', worktreeId: 'worktree-a' },
    });

    const probe: Probe = { current: undefined };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => {
      root.render(<Harness probe={probe} />);
    });
    await act(async () => {
      worktreeA.resolve('/worktrees/a');
      await worktreeA.promise;
    });
    expect(probe.current).toBe('/worktrees/a');

    act(() => {
      useChatStore.setState({
        selectedWorktree: { projectId: 'project', worktreeId: 'worktree-b' },
      });
    });
    expect(probe.current).toBeUndefined();

    await act(async () => {
      worktreeB.resolve('/worktrees/b');
      await worktreeB.promise;
    });
    expect(probe.current).toBe('/worktrees/b');

    act(() => root.unmount());
    container.remove();
  });
});
