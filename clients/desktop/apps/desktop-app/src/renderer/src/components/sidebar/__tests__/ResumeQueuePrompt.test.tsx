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
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { ResumeQueuePrompt } from '../ResumeQueuePrompt';
import {
  openAutomationRunDestination,
  type OpenAutomationRunDestinationResult,
} from '@/components/automations/resolveAutomationRunDestination';
import type * as OpenResumedSessionModule from '@/lib/usage-limit/open-resumed-session';

jest.mock('@/components/automations/resolveAutomationRunDestination', () => ({
  openAutomationRunDestination: jest.fn(),
}));

const openResumeQueueEntryMock = jest.fn<
  Promise<unknown>,
  [ResumeQueueEntry]
>();
jest.mock('@/lib/usage-limit/open-resumed-session', () => ({
  openResumeQueueEntry: (entry: ResumeQueueEntry): Promise<unknown> =>
    openResumeQueueEntryMock(entry),
}));

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
    openResumeQueueEntryMock.mockReset().mockResolvedValue({ ok: true });
    useResumeQueueStore.setState({
      snapshot: null,
      isOpen: false,
      connectionError: null,
      navigationError: null,
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

  it('waits while the queue modal is open', async () => {
    useResumeQueueStore.setState({
      snapshot: snapshot([entry('a', 'resumed')]),
      isOpen: true,
    });
    render();
    await advance(60_000);
    expect(controlResumeQueue).not.toHaveBeenCalled();
  });

  it('dismisses a cleanly finished queue as soon as its modal closes', async () => {
    useResumeQueueStore.setState({
      snapshot: snapshot([entry('a', 'resumed')]),
      isOpen: true,
    });
    render();

    await act(async () => {
      useResumeQueueStore.getState().close();
      await Promise.resolve();
    });
    expect(controlResumeQueue).toHaveBeenCalledTimes(1);
    expect(controlResumeQueue).toHaveBeenCalledWith('dismiss');
    expect(pill()).toBeNull();

    await advance(60_000);
    expect(controlResumeQueue).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a failed session', snapshot([entry('a', 'failed')])],
    [
      'a queue error',
      snapshot([entry('a', 'resumed')], { paused: true, error: 'Bad' }),
    ],
  ])('keeps the pill after closing over %s', async (_label, queue) => {
    useResumeQueueStore.setState({ snapshot: queue, isOpen: true });
    render();
    act(() => useResumeQueueStore.getState().close());
    await advance(60_000);
    expect(controlResumeQueue).not.toHaveBeenCalled();
    expect(pill()).not.toBeNull();
  });

  it('keeps the pill after a connection error and close', async () => {
    useResumeQueueStore.setState({
      snapshot: snapshot([entry('a', 'resumed')]),
      connectionError: 'Disconnected',
      isOpen: true,
    });
    render();
    act(() => useResumeQueueStore.getState().close());
    await advance(60_000);
    expect(controlResumeQueue).not.toHaveBeenCalled();
  });

  it('uses the normal delay for a queue that finishes after closing while running', async () => {
    useResumeQueueStore.setState({
      snapshot: snapshot([entry('a', 'resuming')]),
      isOpen: true,
    });
    render();
    act(() => useResumeQueueStore.getState().close());
    expect(controlResumeQueue).not.toHaveBeenCalled();

    act(() =>
      useResumeQueueStore
        .getState()
        .apply(snapshot([entry('a', 'resumed')], { revision: 2 })),
    );
    await advance(29_999);
    expect(controlResumeQueue).not.toHaveBeenCalled();
    await advance(1);
    expect(controlResumeQueue).toHaveBeenCalledTimes(1);
  });

  it('waits the normal delay for a finished queue that was closed at mount', async () => {
    useResumeQueueStore.setState({
      snapshot: snapshot([entry('a', 'resumed')]),
    });
    render();
    render();
    await advance(29_999);
    expect(controlResumeQueue).not.toHaveBeenCalled();
    await advance(1);
    expect(controlResumeQueue).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate Done, which dismisses and closes together', async () => {
    useResumeQueueStore.setState({
      snapshot: snapshot([entry('a', 'resumed')]),
      isOpen: true,
    });
    render();
    act(() => {
      useResumeQueueStore.getState().apply(snapshot([], { revision: 2 }));
      useResumeQueueStore.getState().close();
    });
    await advance(60_000);
    expect(controlResumeQueue).not.toHaveBeenCalled();
  });

  it('sends one dismissal while a close-triggered request is still pending', async () => {
    let settle: (value: ResumeQueueSnapshot) => void = () => undefined;
    controlResumeQueue.mockImplementation(
      () =>
        new Promise<ResumeQueueSnapshot>((resolve) => {
          settle = resolve;
        }),
    );
    useResumeQueueStore.setState({
      snapshot: snapshot([entry('a', 'resumed')]),
      isOpen: true,
    });
    render();
    act(() => useResumeQueueStore.getState().close());
    render();
    await advance(30_000);
    expect(controlResumeQueue).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle(snapshot([], { revision: 2 }));
      await Promise.resolve();
    });
    expect(pill()).toBeNull();
  });

  it('keeps the pill when the close-triggered dismissal is rejected, then retries on the timer', async () => {
    controlResumeQueue
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(snapshot([], { revision: 2 }));
    useResumeQueueStore.setState({
      snapshot: snapshot([entry('a', 'resumed')]),
      isOpen: true,
    });
    render();
    await act(async () => {
      useResumeQueueStore.getState().close();
      await Promise.resolve();
    });
    expect(controlResumeQueue).toHaveBeenCalledTimes(1);
    expect(pill()).not.toBeNull();

    await advance(30_000);
    expect(controlResumeQueue).toHaveBeenCalledTimes(2);
    expect(pill()).toBeNull();
  });

  it('does not apply an obsolete dismissal over a replacement queue', async () => {
    let settle: (value: ResumeQueueSnapshot) => void = () => undefined;
    controlResumeQueue.mockImplementation(
      () =>
        new Promise<ResumeQueueSnapshot>((resolve) => {
          settle = resolve;
        }),
    );
    useResumeQueueStore.setState({
      snapshot: snapshot([entry('a', 'resumed')]),
      isOpen: true,
    });
    render();
    act(() => useResumeQueueStore.getState().close());
    act(() =>
      useResumeQueueStore
        .getState()
        .apply(snapshot([entry('b', 'waiting')], { revision: 3 })),
    );
    await act(async () => {
      settle(snapshot([], { revision: 2 }));
      await Promise.resolve();
    });
    // A lone waiting session names itself on the chip.
    expect(pill()?.textContent).toContain('Resuming · Chat b');
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

  describe('a single-session queue', () => {
    function queueButton(): HTMLButtonElement | null {
      return container.querySelector<HTMLButtonElement>(
        '[data-testid="resume-queue-sidebar-open-queue"]',
      );
    }

    async function clickAndSettle(
      button: HTMLButtonElement | null,
    ): Promise<void> {
      await act(async () => {
        button?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    it.each<[string, ResumeQueueSnapshot, string]>([
      ['resuming', snapshot([entry('a', 'resuming')]), 'Resuming · Chat a'],
      ['waiting', snapshot([entry('a', 'waiting')]), 'Resuming · Chat a'],
      [
        'paused',
        snapshot([entry('a', 'waiting')], { paused: true }),
        'Paused · Chat a',
      ],
      ['resumed', snapshot([entry('a', 'resumed')]), 'Resumed · Chat a'],
    ])('names a %s session', (_label, queue, text) => {
      useResumeQueueStore.setState({ snapshot: queue });
      render();
      expect(pill()?.textContent).toContain(text);
      expect(
        container.querySelector('[data-testid="resume-queue-sidebar-count"]')
          ?.textContent,
      ).toMatch(/^\d\/1$/);
    });

    it('masks the title and keeps it out of attributes', () => {
      useResumeQueueStore.setState({
        snapshot: snapshot([entry('a', 'resuming')]),
      });
      render();
      expect(
        container.querySelector('[data-testid="resume-queue-sidebar-title"]')
          ?.className,
      ).toContain(POSTHOG_REPLAY_MASK_CLASS);
      expect(pill()?.getAttribute('aria-label')).toBeNull();
      expect(queueButton()?.getAttribute('aria-label')).toBe(
        'Open resume queue',
      );
    });

    it('opens the session, and the trailing action opens the queue alone', async () => {
      const session = entry('a', 'resuming');
      useResumeQueueStore.setState({ snapshot: snapshot([session]) });
      render();

      await clickAndSettle(pill());
      expect(openResumeQueueEntryMock).toHaveBeenCalledWith(session);
      expect(useResumeQueueStore.getState().isOpen).toBe(false);

      openResumeQueueEntryMock.mockClear();
      await clickAndSettle(queueButton());
      expect(openResumeQueueEntryMock).not.toHaveBeenCalled();
      expect(useResumeQueueStore.getState().isOpen).toBe(true);
    });

    it('opens the queue with an error when the session cannot open', async () => {
      openResumeQueueEntryMock.mockResolvedValue({ ok: false, error: 'Gone.' });
      useResumeQueueStore.setState({
        snapshot: snapshot([entry('a', 'resumed')]),
      });
      render();
      await clickAndSettle(pill());

      expect(useResumeQueueStore.getState()).toMatchObject({
        isOpen: true,
        navigationError: 'Gone.',
      });
    });

    it.each<[string, ResumeQueueSnapshot, string]>([
      ['stopped', snapshot([entry('a', 'stopped')]), 'Resume queue finished'],
      [
        'erroring',
        snapshot([entry('a', 'waiting')], { error: 'Could not save.' }),
        'Queue needs attention',
      ],
      [
        'multi-session',
        snapshot([entry('a', 'resumed'), entry('b', 'waiting')]),
        'Resuming sessions',
      ],
    ])('keeps queue status and routing when %s', async (_l, queue, text) => {
      useResumeQueueStore.setState({ snapshot: queue });
      render();
      expect(pill()?.textContent).toContain(text);
      expect(queueButton()).toBeNull();
      await clickAndSettle(pill());
      expect(openResumeQueueEntryMock).not.toHaveBeenCalled();
      expect(useResumeQueueStore.getState().isOpen).toBe(true);
    });

    it('keeps auto-dismissing a cleanly resumed single session', async () => {
      useResumeQueueStore.setState({
        snapshot: snapshot([entry('a', 'resumed')]),
      });
      render();
      await advance(30_000);
      expect(controlResumeQueue).toHaveBeenCalledWith('dismiss');
    });

    it('retains the retry route while single-session navigation is pending', async () => {
      let finish: (result: { ok: false; error: string }) => void = () =>
        undefined;
      openResumeQueueEntryMock.mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      useResumeQueueStore.setState({
        snapshot: snapshot([entry('a', 'resumed')]),
      });
      render();
      await advance(29_000);
      await clickAndSettle(pill());
      await advance(30_000);
      expect(controlResumeQueue).not.toHaveBeenCalled();
      await act(async () => {
        finish({ ok: false, error: 'Gone.' });
        await Promise.resolve();
      });
      expect(useResumeQueueStore.getState()).toMatchObject({
        isOpen: true,
        navigationError: 'Gone.',
      });
      expect(useResumeQueueStore.getState().snapshot?.entries).toHaveLength(1);
    });

    it('ignores an empty snapshot', () => {
      useResumeQueueStore.setState({ snapshot: snapshot([]) });
      render();
      expect(pill()).toBeNull();
      expect(openResumeQueueEntryMock).not.toHaveBeenCalled();
    });

    it('retains the queue while confirmation navigation is pending outside the chip', async () => {
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          controlResumeQueue,
          chat: {
            loadTabs: jest.fn().mockResolvedValue({
              tabs: [
                {
                  id: 'a',
                  messages: [],
                  lastAcceptedUserMessageId: 'accepted-resume',
                },
              ],
            }),
          },
        },
      });
      const actual = jest.requireActual<typeof OpenResumedSessionModule>(
        '@/lib/usage-limit/open-resumed-session',
      );
      let finish: (result: OpenAutomationRunDestinationResult) => void = () =>
        undefined;
      jest.mocked(openAutomationRunDestination).mockReturnValueOnce(
        new Promise<OpenAutomationRunDestinationResult>((resolve) => {
          finish = resolve;
        }),
      );
      const session = entry('a', 'resumed');
      useResumeQueueStore.setState({ snapshot: snapshot([session]) });
      render();
      await advance(29_000);
      let opening: Promise<OpenAutomationRunDestinationResult>;
      act(() => {
        opening = actual.openResumeQueueEntry(session);
      });
      try {
        await advance(30_000);
        expect(controlResumeQueue).not.toHaveBeenCalled();
      } finally {
        await act(async () => {
          finish({ ok: false, error: 'Gone.' });
          await opening;
        });
      }
      expect(useResumeQueueStore.getState().snapshot?.entries).toHaveLength(1);
    });
  });
});
