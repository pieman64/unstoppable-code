/** @jest-environment jsdom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useResumeQueueStore } from '@/stores/resumeQueueStore';
import { useUsageLimitResumePromptStore } from '@/stores/usageLimitResumePromptStore';
import type {
  ResumeQueueEntry,
  ResumeQueueSnapshot,
} from '@canopy/desktop-shared/types';
import { ResumeQueuePrompt } from '@/components/sidebar/ResumeQueuePrompt';
import { ResumeQueueModal } from '../ResumeQueueModal';
import type * as OpenResumedSessionModule from '@/lib/usage-limit/open-resumed-session';

const openResumeQueueEntryMock = jest.fn<
  Promise<unknown>,
  [ResumeQueueEntry]
>();
jest.mock('@/lib/usage-limit/open-resumed-session', () => ({
  ...jest.requireActual<typeof OpenResumedSessionModule>(
    '@/lib/usage-limit/open-resumed-session',
  ),
  openResumeQueueEntry: (entry: ResumeQueueEntry): Promise<unknown> =>
    openResumeQueueEntryMock(entry),
}));

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));

const reporter = jest.mocked(useCurrentUiStateReporter);

describe('ResumeQueueModal', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    reporter.mockClear();
    openResumeQueueEntryMock.mockReset().mockResolvedValue({ ok: true });
    const snapshot = {
      version: 1 as const,
      revision: 1,
      paused: false,
      entries: [
        {
          id: 'entry-1',
          target: {
            kind: 'chat' as const,
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'chat',
          },
          interruptionId: '1',
          title: 'Chat',
          workspaceName: 'Workspace',
          createdAt: 1,
          status: 'waiting' as const,
        },
      ],
    };
    useResumeQueueStore.setState({
      snapshot,
      isOpen: true,
      connectionError: null,
      navigationError: null,
    });
    useUsageLimitResumePromptStore.setState({ isOpen: false });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        onResumeQueueChanged: jest.fn(() => jest.fn()),
        getResumeQueue: jest.fn().mockResolvedValue(snapshot),
        controlResumeQueue: jest.fn().mockResolvedValue(snapshot),
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shares a pending Done dismissal with the clean ✕ transition', async () => {
    const current = useResumeQueueStore.getState().snapshot;
    if (!current) throw new Error('Expected snapshot');
    // Two resumed chats, so Done dismisses without opening one first.
    const [first] = current.entries;
    if (!first || first.target.kind !== 'chat') {
      throw new Error('Expected a chat entry');
    }
    const finished: ResumeQueueSnapshot = {
      ...current,
      entries: [
        { ...first, status: 'resumed' },
        {
          ...first,
          id: 'entry-2',
          target: { ...first.target, chatId: 'chat-2' },
          title: 'Chat 2',
          status: 'resumed',
        },
      ],
    };
    useResumeQueueStore.setState({ snapshot: finished });
    jest.mocked(window.api.getResumeQueue).mockResolvedValue(finished);
    let resolveDismiss: (snapshot: ResumeQueueSnapshot) => void = () =>
      undefined;
    jest.mocked(window.api.controlResumeQueue).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDismiss = resolve;
        }),
    );
    await act(async () => {
      root.render(
        createElement(
          Fragment,
          null,
          createElement(ResumeQueuePrompt),
          createElement(ResumeQueueModal),
        ),
      );
      await Promise.resolve();
    });
    const click = (label: string): void => {
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent === label)
        ?.click();
    };
    act(() => click('Done'));
    act(() => {
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Close"]')
        ?.click();
    });
    expect(window.api.controlResumeQueue).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveDismiss({ version: 1, revision: 2, paused: false, entries: [] });
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="resume-queue-sidebar"]'),
    ).toBeNull();
    expect(window.api.controlResumeQueue).toHaveBeenCalledTimes(1);
    expect(useResumeQueueStore.getState().isOpen).toBe(false);
  });

  it('shows providers, pipeline identity, and ten-second pacing', async () => {
    const snapshot = useResumeQueueStore.getState().snapshot;
    if (!snapshot) throw new Error('Expected queue snapshot');
    Object.assign(snapshot.entries[0], { providers: ['codex'] });
    snapshot.entries.push({
      ...snapshot.entries[0],
      id: 'pipeline',
      title: 'Build',
      target: {
        kind: 'pipeline',
        executionId: 'execution',
        statusReasonIds: ['reason'],
      },
      ...{ providers: ['claude', 'codex'] },
    });
    await act(async () => {
      root.render(createElement(ResumeQueueModal));
      await Promise.resolve();
    });
    expect(
      document.querySelector('[data-testid="resume-queue-entry-entry-1"]')
        ?.textContent,
    ).toContain('Codex');
    expect(
      document.querySelector('[data-testid="resume-queue-entry-pipeline"]')
        ?.textContent,
    ).toContain('Workspace · Workflow · Claude, Codex');
    expect(document.body.textContent).toContain(
      'One session starts every 10 seconds.',
    );
    expect(document.body.textContent).not.toContain(
      'wait while the app is busy',
    );
    // User-authored titles and workspace names stay masked in replays.
    const pipelineEntry = document.querySelector(
      '[data-testid="resume-queue-entry-pipeline"]',
    );
    expect(pipelineEntry?.tagName).toBe('LI');
    const title = Array.from(pipelineEntry?.querySelectorAll('p') ?? []).find(
      (element) => element.textContent === 'Build',
    );
    expect(title?.className.split(' ')).toContain(POSTHOG_REPLAY_MASK_CLASS);
    expect(title?.hasAttribute('title')).toBe(false);
    // Workspace and provider share one line; only the workspace is masked.
    const workspace = Array.from(
      pipelineEntry?.querySelectorAll('span') ?? [],
    ).find((element) => element.textContent === 'Workspace');
    expect(workspace?.className.split(' ')).toContain(
      POSTHOG_REPLAY_MASK_CLASS,
    );
  });

  it('reports sanitized queue state', async () => {
    await act(async () => {
      root.render(createElement(ResumeQueueModal));
      await Promise.resolve();
    });

    expect(reporter.mock.calls[0]?.[0]).toBe('usage.resumeQueueModal');
    expect(reporter.mock.calls[0]?.[1]).toEqual({
      open: true,
      paused: false,
      pending: false,
      processed: 0,
      total: 1,
      active: true,
      errorVisible: false,
    });
  });

  describe('session destinations', () => {
    const chatEntry: ResumeQueueEntry = {
      id: 'entry-1',
      target: {
        kind: 'chat',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      interruptionId: '1',
      title: 'Chat',
      workspaceName: 'Workspace',
      createdAt: 1,
      status: 'waiting',
    };
    const pipelineEntry: ResumeQueueEntry = {
      ...chatEntry,
      id: 'pipeline',
      title: 'Build',
      target: { kind: 'pipeline', executionId: 'exec', statusReasonIds: [] },
    };
    const controlMock = (): jest.Mock =>
      jest.mocked(window.api.controlResumeQueue);

    async function renderWith(entries: ResumeQueueEntry[]): Promise<void> {
      const snapshot: ResumeQueueSnapshot = {
        version: 1,
        revision: 2,
        paused: false,
        entries,
      };
      useResumeQueueStore.setState({ snapshot });
      controlMock().mockResolvedValue({
        ...snapshot,
        revision: 3,
        entries: [],
      });
      await act(async () => {
        root.render(createElement(ResumeQueueModal));
        await Promise.resolve();
      });
    }

    async function click(testId: string): Promise<void> {
      await act(async () => {
        document
          .querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
          ?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    const alertText = (): string | null | undefined =>
      document.querySelector('[role="alert"]')?.textContent;

    it('preserves closing the dialog while a Pause request is pending', async () => {
      await renderWith([chatEntry]);
      const snapshot = useResumeQueueStore.getState().snapshot;
      if (!snapshot) throw new Error('Expected queue snapshot');
      let finish: (state: ResumeQueueSnapshot) => void = () => undefined;
      controlMock().mockReturnValue(
        new Promise<ResumeQueueSnapshot>((resolve) => {
          finish = resolve;
        }),
      );
      act(() => {
        Array.from(document.querySelectorAll('button'))
          .find((button) => button.textContent === 'Pause queue')
          ?.click();
      });
      const closeButton = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Close"]',
      );
      expect(closeButton?.disabled).toBe(false);
      act(() => closeButton?.click());
      expect(useResumeQueueStore.getState().isOpen).toBe(false);
      await act(async () => {
        finish({ ...snapshot, paused: true, revision: 3 });
        await Promise.resolve();
      });
      expect(useResumeQueueStore.getState().snapshot?.paused).toBe(true);
    });

    it.each(['row', 'Done'])(
      'guards repeated %s activation before rendering pending state',
      async (action) => {
        let finish: (result: { ok: true }) => void = () => undefined;
        openResumeQueueEntryMock.mockReturnValue(
          new Promise((resolve) => {
            finish = resolve;
          }),
        );
        await renderWith([{ ...chatEntry, status: 'resumed' }]);
        const button = document.querySelector<HTMLButtonElement>(
          `[data-testid="${action === 'row' ? 'resume-queue-entry-open-entry-1' : 'resume-queue-done'}"]`,
        );
        act(() => {
          button?.click();
          button?.click();
        });
        expect(openResumeQueueEntryMock).toHaveBeenCalledTimes(1);
        expect(useResumeQueueStore.getState().isOpen).toBe(true);
        expect(button?.disabled).toBe(true);
        act(() => {
          document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
          );
          document
            .querySelector<HTMLButtonElement>('button[aria-label="Close"]')
            ?.click();
        });
        expect(useResumeQueueStore.getState().isOpen).toBe(true);
        expect(controlMock()).not.toHaveBeenCalled();
        await act(async () => {
          finish({ ok: true });
          await Promise.resolve();
        });
        expect(controlMock()).toHaveBeenCalledTimes(action === 'Done' ? 1 : 0);
      },
    );

    it.each<ResumeQueueEntry['status']>(['waiting', 'resumed', 'failed'])(
      'opens a %s pipeline row without changing the queue',
      async (status) => {
        const row = { ...pipelineEntry, status };
        await renderWith([row]);
        await click('resume-queue-entry-open-pipeline');
        expect(openResumeQueueEntryMock).toHaveBeenCalledWith(row);
        expect(controlMock()).not.toHaveBeenCalled();
        expect(useResumeQueueStore.getState().isOpen).toBe(false);
      },
    );

    it.each<ResumeQueueEntry['status']>(['waiting', 'resumed', 'failed'])(
      'opens a %s row without changing the queue',
      async (status) => {
        const row = { ...chatEntry, status };
        await renderWith([row, { ...pipelineEntry, status }]);

        expect(
          document.querySelector(
            '[data-testid="resume-queue-entry-open-entry-1"]',
          )?.textContent,
        ).toBe('Open chat');
        expect(
          document.querySelector(
            '[data-testid="resume-queue-entry-open-pipeline"]',
          )?.textContent,
        ).toBe('Open run');
        await click('resume-queue-entry-open-entry-1');

        expect(openResumeQueueEntryMock).toHaveBeenCalledWith(row);
        expect(controlMock()).not.toHaveBeenCalled();
        expect(useResumeQueueStore.getState().isOpen).toBe(false);
      },
    );

    it('keeps the queue open with an error when a row cannot open', async () => {
      openResumeQueueEntryMock.mockResolvedValue({
        ok: false,
        error: 'This chat is no longer available.',
      });
      await renderWith([chatEntry]);
      await click('resume-queue-entry-open-entry-1');

      expect(useResumeQueueStore.getState().isOpen).toBe(true);
      expect(alertText()).toBe('This chat is no longer available.');
    });

    it('Done opens the only resumed chat, then dismisses', async () => {
      const resumed = { ...chatEntry, status: 'resumed' as const };
      await renderWith([
        resumed,
        { ...pipelineEntry, status: 'failed', id: 'failed' },
      ]);
      await click('resume-queue-done');

      expect(openResumeQueueEntryMock).toHaveBeenCalledWith(resumed);
      expect(controlMock()).toHaveBeenCalledWith('dismiss');
      expect(useResumeQueueStore.getState().isOpen).toBe(false);
    });

    it('Done keeps the queue when the resumed chat cannot open', async () => {
      openResumeQueueEntryMock.mockResolvedValue({ ok: false, error: 'Gone.' });
      await renderWith([{ ...chatEntry, status: 'resumed' }]);
      await click('resume-queue-done');

      expect(controlMock()).not.toHaveBeenCalled();
      expect(useResumeQueueStore.getState().isOpen).toBe(true);
      expect(alertText()).toBe('Gone.');
      expect(
        document.querySelector<HTMLButtonElement>(
          '[data-testid="resume-queue-done"]',
        )?.disabled,
      ).toBe(false);
      openResumeQueueEntryMock.mockResolvedValue({ ok: true });
      await click('resume-queue-done');
      expect(openResumeQueueEntryMock).toHaveBeenCalledTimes(2);
      expect(controlMock()).toHaveBeenCalledTimes(1);
      expect(useResumeQueueStore.getState().isOpen).toBe(false);
    });

    it('Done keeps the queue when dismissal fails', async () => {
      await renderWith([{ ...chatEntry, status: 'resumed' }]);
      controlMock().mockRejectedValue(new Error('offline'));
      await click('resume-queue-done');

      expect(useResumeQueueStore.getState().isOpen).toBe(true);
      expect(alertText()).toBe('Could not update the queue. Try again.');
    });

    it.each<[string, ResumeQueueEntry[]]>([
      ['no resumed session', [{ ...chatEntry, status: 'stopped' }]],
      [
        'several resumed chats',
        [
          { ...chatEntry, status: 'resumed' },
          { ...chatEntry, id: 'entry-2', status: 'resumed' },
        ],
      ],
      ['a lone resumed pipeline', [{ ...pipelineEntry, status: 'resumed' }]],
    ])('Done only dismisses with %s', async (_label, entries) => {
      await renderWith(entries);
      await click('resume-queue-done');

      expect(openResumeQueueEntryMock).not.toHaveBeenCalled();
      expect(controlMock()).toHaveBeenCalledWith('dismiss');
      expect(useResumeQueueStore.getState().isOpen).toBe(false);
    });
  });

  describe('presentation', () => {
    const chat = (
      id: string,
      status: ResumeQueueEntry['status'],
    ): ResumeQueueEntry => ({
      id,
      target: {
        kind: 'chat',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: id,
      },
      interruptionId: id,
      title: `Chat ${id}`,
      workspaceName: 'Workspace',
      createdAt: 1,
      status,
    });
    const pipeline = (
      status: ResumeQueueEntry['status'],
    ): ResumeQueueEntry => ({
      ...chat('pipeline', status),
      title: 'Build',
      target: { kind: 'pipeline', executionId: 'exec', statusReasonIds: [] },
    });

    async function renderSnapshot(
      entries: ResumeQueueEntry[],
      overrides: Partial<ResumeQueueSnapshot> = {},
    ): Promise<void> {
      const snapshot: ResumeQueueSnapshot = {
        version: 1,
        revision: 2,
        paused: false,
        entries,
        ...overrides,
      };
      useResumeQueueStore.setState({ snapshot });
      jest.mocked(window.api.getResumeQueue).mockResolvedValue(snapshot);
      await act(async () => {
        root.render(createElement(ResumeQueueModal));
        await Promise.resolve();
      });
    }

    const statusRegion = (): string =>
      document.querySelector(
        '[data-testid="resume-queue-modal"] [role="status"]',
      )?.textContent ?? '';
    const statusLabel = (): string | null | undefined =>
      document.querySelector('[data-testid="resume-queue-status"]')
        ?.textContent;
    const footerButtons = (): string[] =>
      Array.from(
        document.querySelectorAll('[data-testid="resume-queue-footer"] button'),
      ).map((button) => button.textContent ?? '');
    const progressBar = (): Element | null =>
      document.querySelector('[role="progressbar"]');
    const subtitle = (): boolean =>
      document.body.textContent?.includes('You can close this') ?? false;

    it('tells a single waiting chat it is waiting, without batch presentation', async () => {
      await renderSnapshot([chat('a', 'waiting')]);
      expect(statusLabel()).toBe('In progress');
      expect(statusRegion()).toContain('Your chat is waiting to start.');
      expect(statusRegion()).not.toContain('every 10 seconds');
      expect(statusRegion()).not.toMatch(/started|\d+ waiting/);
      expect(statusRegion()).not.toContain(' of ');
      expect(progressBar()).toBeNull();
    });

    it('tells a single resuming chat it is starting, without batch presentation', async () => {
      await renderSnapshot([chat('a', 'resuming')]);
      expect(statusRegion()).toContain('Starting your chat now.');
      expect(statusRegion()).not.toContain('every 10 seconds');
      expect(statusRegion()).not.toContain(' of ');
      expect(progressBar()).toBeNull();
    });

    it.each<[string, ResumeQueueEntry, string]>([
      [
        'chat',
        chat('a', 'resumed'),
        'Your chat has started again. Open it to follow along.',
      ],
      [
        'workflow',
        pipeline('resumed'),
        'Your workflow has started again. Open it to follow along.',
      ],
    ])(
      'shows a single resumed %s as Started with one Done action',
      async (_noun, entry, sentence) => {
        await renderSnapshot([entry]);
        expect(statusLabel()).toBe('Started');
        expect(statusRegion()).toContain(sentence);
        expect(statusRegion()).not.toContain('Finished');
        expect(statusRegion()).not.toContain(' of ');
        expect(progressBar()).toBeNull();
        expect(subtitle()).toBe(false);
        expect(footerButtons()).toEqual(['Done']);
        expect(
          document.querySelector('button[aria-label="Close"]'),
        ).not.toBeNull();
      },
    );

    it('shows starts, waiting count, and pacing for an active batch', async () => {
      await renderSnapshot([chat('a', 'waiting'), chat('b', 'waiting')]);
      expect(statusLabel()).toBe('In progress');
      expect(statusRegion()).toContain('0 of 2 started');
      // The list already shows which sessions wait.
      expect(statusRegion()).not.toMatch(/\d+ waiting/);
      expect(statusRegion()).toContain('One session starts every 10 seconds.');
      expect(progressBar()).not.toBeNull();
      expect(subtitle()).toBe(false);
      // Flows reach the footer actions through the queue's test scope.
      expect(
        document.querySelector(
          '[data-testid="resume-queue-modal"] [data-testid="resume-queue-footer"]',
        )?.textContent,
      ).toContain('Saved automatically');
      // ✕ and Escape close the dialog, so the footer has no Close.
      expect(footerButtons()).toEqual(['Stop remaining', 'Pause queue']);
    });

    it('keeps pacing by batch size when one handoff remains', async () => {
      await renderSnapshot([chat('a', 'resumed'), chat('b', 'resuming')]);
      expect(statusRegion()).toContain('1 of 2 started');
      expect(statusRegion()).toContain('One session starts every 10 seconds.');
      expect(progressBar()?.getAttribute('aria-valuetext')).toBe(
        '1 of 2 handled',
      );
    });

    it.each<[string, ResumeQueueEntry[]]>([
      ['single', [chat('a', 'waiting')]],
      ['batch', [chat('a', 'waiting'), chat('b', 'waiting')]],
    ])(
      'keeps the paused helper without a starting promise for a paused %s',
      async (_label, entries) => {
        await renderSnapshot(entries, { paused: true });
        expect(statusLabel()).toBe('Paused');
        expect(statusRegion()).toContain('Waiting sessions stay paused');
        expect(statusRegion()).not.toContain('every 10 seconds');
        expect(statusRegion()).not.toContain('waiting to start');
        expect(statusRegion()).not.toContain('Starting your');
      },
    );

    it.each([false, true])(
      'shows a queue-level error as Paused without pacing (paused flag: %s)',
      async (paused) => {
        await renderSnapshot([chat('a', 'waiting'), chat('b', 'waiting')], {
          paused,
          error: 'Could not resume the queue.',
        });
        expect(statusLabel()).toBe('Paused');
        expect(statusRegion()).not.toContain('every 10 seconds');
        expect(statusRegion()).toContain('Could not resume the queue.');
        expect(statusRegion().includes('Waiting sessions stay paused')).toBe(
          paused,
        );
      },
    );

    it('shows a single errored chat without a starting promise', async () => {
      await renderSnapshot([chat('a', 'resuming')], {
        error: 'Could not resume the queue.',
      });
      expect(statusLabel()).toBe('Paused');
      expect(statusRegion()).not.toContain('Starting your');
    });

    it('disables the sole Done action for a terminal queue-level error', async () => {
      await renderSnapshot([chat('a', 'resumed')], {
        error: 'Could not resume the queue.',
      });
      expect(footerButtons()).toEqual(['Done']);
      expect(
        document.querySelector<HTMLButtonElement>(
          '[data-testid="resume-queue-done"]',
        )?.disabled,
      ).toBe(true);
    });

    it('counts starts against every entry in a mixed terminal batch', async () => {
      await renderSnapshot([
        chat('a', 'resumed'),
        chat('b', 'failed'),
        chat('c', 'stopped'),
      ]);
      expect(statusLabel()).toBe('Needs attention');
      expect(statusRegion()).toContain('1 of 3 started');
      expect(statusRegion()).not.toMatch(/\d+ waiting/);
      // A finished batch would always read full, so it has no bar.
      expect(progressBar()).toBeNull();
      expect(subtitle()).toBe(false);
      expect(footerButtons()).toEqual(['Done']);
      expect(
        document.querySelector<HTMLButtonElement>(
          '[data-testid="resume-queue-done"]',
        )?.disabled,
      ).toBe(false);
    });

    it('does not claim success or enable Done without a snapshot', async () => {
      useResumeQueueStore.setState({ snapshot: null });
      jest
        .mocked(window.api.getResumeQueue)
        .mockReturnValue(new Promise(() => undefined));
      await act(async () => {
        root.render(createElement(ResumeQueueModal));
        await Promise.resolve();
      });
      expect(statusLabel()).toBeFalsy();
      expect(statusRegion()).not.toContain('Started');
      expect(statusRegion()).not.toContain('Finished');
      expect(progressBar()).toBeNull();
      expect(
        document.querySelector<HTMLButtonElement>(
          '[data-testid="resume-queue-done"]',
        )?.disabled,
      ).toBe(true);
    });

    it.each<[string, ResumeQueueEntry[], number]>([
      ['clears a clean terminal queue', [chat('a', 'resumed')], 1],
      ['retains a queue with failed entries', [chat('a', 'failed')], 0],
      ['retains outstanding work', [chat('a', 'waiting')], 0],
    ])(
      'Escape %s through the shared close path',
      async (_label, entries, calls) => {
        const snapshot: ResumeQueueSnapshot = {
          version: 1,
          revision: 2,
          paused: false,
          entries,
        };
        useResumeQueueStore.setState({ snapshot });
        jest.mocked(window.api.getResumeQueue).mockResolvedValue(snapshot);
        jest
          .mocked(window.api.controlResumeQueue)
          .mockResolvedValue({ ...snapshot, revision: 3, entries: [] });
        await act(async () => {
          root.render(
            createElement(
              Fragment,
              null,
              createElement(ResumeQueuePrompt),
              createElement(ResumeQueueModal),
            ),
          );
          await Promise.resolve();
        });
        await act(async () => {
          document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
          );
          await Promise.resolve();
        });
        expect(useResumeQueueStore.getState().isOpen).toBe(false);
        expect(openResumeQueueEntryMock).not.toHaveBeenCalled();
        expect(window.api.controlResumeQueue).toHaveBeenCalledTimes(calls);
      },
    );

    it.each([false, true])(
      'Escape retains a terminal queue-level error (paused: %s)',
      async (paused) => {
        await renderSnapshot([chat('a', 'resumed')], {
          paused,
          error: 'Could not resume the queue.',
        });
        await act(async () => {
          root.render(
            createElement(
              Fragment,
              null,
              createElement(ResumeQueuePrompt),
              createElement(ResumeQueueModal),
            ),
          );
          document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
          );
          await Promise.resolve();
        });
        expect(useResumeQueueStore.getState().isOpen).toBe(false);
        expect(useResumeQueueStore.getState().snapshot?.entries).toHaveLength(
          1,
        );
        expect(window.api.controlResumeQueue).not.toHaveBeenCalled();
        expect(openResumeQueueEntryMock).not.toHaveBeenCalled();
      },
    );
  });
});
