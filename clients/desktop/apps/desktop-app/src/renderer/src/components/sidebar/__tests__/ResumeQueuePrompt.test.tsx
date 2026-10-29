/** @jest-environment jsdom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ResumeQueueEntry,
  ResumeQueueSnapshot,
} from '@canopy/desktop-shared/types';
import { useResumeQueueStore } from '@/stores/resumeQueueStore';
import { ResumeQueuePrompt } from '../ResumeQueuePrompt';

function entry(
  id: string,
  status: ResumeQueueEntry['status'],
): ResumeQueueEntry {
  return {
    id,
    target: {
      kind: 'chat',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: id,
    },
    interruptionId: '1',
    title: `Chat ${id}`,
    workspaceName: 'Workspace',
    createdAt: 1,
    status,
  };
}

function snapshot(
  entries: ResumeQueueEntry[],
  overrides: Partial<ResumeQueueSnapshot> = {},
): ResumeQueueSnapshot {
  return { version: 1, revision: 1, paused: false, entries, ...overrides };
}

describe('ResumeQueuePrompt', () => {
  let container: HTMLDivElement;
  let root: Root;
  let controlResumeQueue: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    controlResumeQueue = jest
      .fn()
      .mockResolvedValue(snapshot([], { revision: 2 }));
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { controlResumeQueue },
    });
    useResumeQueueStore.setState({
      snapshot: null,
      isOpen: false,
      connectionError: null,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
  });

  function render(): void {
    act(() => root.render(createElement(ResumeQueuePrompt)));
  }

  function pill(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      '[data-testid="resume-queue-sidebar"]',
    );
  }

  async function advance(ms: number): Promise<void> {
    await act(async () => {
      jest.advanceTimersByTime(ms);
      await Promise.resolve();
    });
  }

  it('dismisses a finished queue 30 seconds after it completes', async () => {
    useResumeQueueStore.setState({
      snapshot: snapshot([entry('a', 'resumed'), entry('b', 'resuming')]),
    });
    render();
    expect(pill()?.textContent).toContain('Resuming sessions');

    act(() =>
      useResumeQueueStore.getState().apply(
        snapshot([entry('a', 'resumed'), entry('b', 'skipped')], {
          revision: 2,
        }),
      ),
    );
    expect(pill()?.textContent).toContain('Resume queue finished');

    await advance(29_999);
    expect(controlResumeQueue).not.toHaveBeenCalled();
    await advance(1);
    expect(controlResumeQueue).toHaveBeenCalledWith('dismiss');
    expect(pill()).toBeNull();
  });

  it('does not dismiss while the queue is still running', async () => {
    useResumeQueueStore.setState({
      snapshot: snapshot([entry('a', 'resumed'), entry('b', 'waiting')]),
    });
    render();
    await advance(60_000);
    expect(controlResumeQueue).not.toHaveBeenCalled();
  });

  it('keeps the pill when a session needs attention', async () => {
    useResumeQueueStore.setState({
      snapshot: snapshot([entry('a', 'resumed'), entry('b', 'failed')]),
    });
    render();
    await advance(60_000);
    expect(controlResumeQueue).not.toHaveBeenCalled();
    expect(pill()).not.toBeNull();
  });

  it('keeps the pill when the queue reports an error', async () => {
    useResumeQueueStore.setState({
      snapshot: snapshot([entry('a', 'resumed')], {
        paused: true,
        error: 'Could not save.',
      }),
    });
    render();
    await advance(60_000);
    expect(controlResumeQueue).not.toHaveBeenCalled();
  });

  it('waits while the queue modal is open and restarts after it closes', async () => {
    useResumeQueueStore.setState({
      snapshot: snapshot([entry('a', 'resumed')]),
      isOpen: true,
    });
    render();
    await advance(60_000);
    expect(controlResumeQueue).not.toHaveBeenCalled();

    act(() => useResumeQueueStore.getState().close());
    await advance(29_999);
    expect(controlResumeQueue).not.toHaveBeenCalled();
    await advance(1);
    expect(controlResumeQueue).toHaveBeenCalledWith('dismiss');
  });

  it('cancels the pending dismissal when new sessions are queued', async () => {
    useResumeQueueStore.setState({
      snapshot: snapshot([entry('a', 'resumed')]),
    });
    render();
    await advance(20_000);
    act(() =>
      useResumeQueueStore.getState().apply(
        snapshot([entry('a', 'resumed'), entry('b', 'waiting')], {
          revision: 2,
        }),
      ),
    );
    await advance(60_000);
    expect(controlResumeQueue).not.toHaveBeenCalled();
  });

  it('keeps the pill when the dismissal is rejected', async () => {
    controlResumeQueue.mockRejectedValue(
      new Error('The queue is still active.'),
    );
    useResumeQueueStore.setState({
      snapshot: snapshot([entry('a', 'stopped')], { paused: true }),
    });
    render();
    await advance(30_000);
    expect(controlResumeQueue).toHaveBeenCalledWith('dismiss');
    expect(pill()).not.toBeNull();
  });
});
