/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  PRESENCE_REPORT_INTERVAL_MS,
  usePresenceReporter,
} from '../usePresenceReporter';
import { useChatStore } from '@/stores/chatStore';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function Harness(): JSX.Element {
  usePresenceReporter();
  return <></>;
}

describe('usePresenceReporter', () => {
  const originalSelectedWorktree = useChatStore.getState().selectedWorktree;
  let recordActivity: jest.Mock;
  let container: HTMLDivElement;
  let root: Root;

  function mount(): void {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(<Harness />);
    });
  }

  function interact(): void {
    act(() => {
      document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
  }

  beforeEach(() => {
    jest.useFakeTimers();
    recordActivity = jest.fn();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { telemetrySync: { recordActivity } },
    });
    useChatStore.setState({
      selectedWorktree: { projectId: 'project', worktreeId: 'worktree-a' },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    useChatStore.setState({ selectedWorktree: originalSelectedWorktree });
    Reflect.deleteProperty(window, 'api');
    jest.useRealTimers();
  });

  it('reports the selected worktree on real user input', () => {
    mount();
    interact();
    expect(recordActivity).toHaveBeenCalledWith('project', 'worktree-a');
  });

  it('throttles: an hour of typing is not an hour of IPC', () => {
    mount();
    interact();
    interact();
    interact();
    expect(recordActivity).toHaveBeenCalledTimes(1);

    jest.setSystemTime(Date.now() + PRESENCE_REPORT_INTERVAL_MS);
    interact();
    expect(recordActivity).toHaveBeenCalledTimes(2);
  });

  it('throttles per worktree, so switching worktrees reports immediately', () => {
    // Presence is per-worktree server-side. A shared throttle would let a
    // freshly selected worktree look idle for a full interval, suppressing a
    // push the user should not have received.
    mount();
    interact();
    act(() => {
      useChatStore.setState({
        selectedWorktree: { projectId: 'project', worktreeId: 'worktree-b' },
      });
    });
    interact();

    expect(recordActivity).toHaveBeenNthCalledWith(1, 'project', 'worktree-a');
    expect(recordActivity).toHaveBeenNthCalledWith(2, 'project', 'worktree-b');
  });

  it('reports nothing when no worktree is selected', () => {
    useChatStore.setState({ selectedWorktree: null });
    mount();
    interact();
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it('ignores scroll, which fires without a human doing anything', () => {
    // A streaming agent message scrolls the transcript on its own. Counting
    // that as presence would suppress the very push the user walked away from.
    mount();
    act(() => {
      document.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it('stops reporting after unmount', () => {
    mount();
    act(() => {
      root.unmount();
    });
    interact();
    expect(recordActivity).not.toHaveBeenCalled();
    // `afterEach` unmounts again; React tolerates a repeat unmount.
  });
});
