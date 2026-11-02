/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { create } from 'zustand';
import type {
  QueuedMessageAnnouncement,
  QueuedMessageSetupWait,
} from '@canopy/ui-shared/components';
import type { QueuedChatMessage } from '@/stores/chatStore';
import { emitSetupQueueDispatch } from '@/stores/chat/setup-queue-dispatch';
import { recordWorktreeSetupDuration } from '@/lib/worktreeSetupDurations';
// `jest.mock` below is hoisted, so the hook reads the fake projects store.
import {
  useSetupQueueAnnouncement,
  useWorktreeSetupWait,
  type WorktreeSetupWaitTarget,
} from '../useWorktreeSetupWait';

interface FakeProject {
  id: string;
  type: 'single-repo';
  name: string;
  worktrees: { id: string; createdAt: string; setupPhase?: string }[];
}

const mockProjectsStore = create<{ projects: FakeProject[] }>(() => ({
  projects: [],
}));

jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: <T,>(
    selector: (state: { projects: FakeProject[] }) => T,
  ): T => mockProjectsStore(selector),
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});

const TARGET: WorktreeSetupWaitTarget = {
  projectId: 'p1',
  worktreeId: 'w1',
  chatId: 'c1',
};
const NOW = 1_000_000;

function setRow(row: { createdAt: string; setupPhase?: string } | null): void {
  mockProjectsStore.setState({
    projects: [
      {
        id: 'p1',
        type: 'single-repo',
        name: 'canopy',
        worktrees: row ? [{ id: 'w1', ...row }] : [],
      },
    ],
  });
}

interface ProbeProps {
  target: WorktreeSetupWaitTarget | null;
  queuedForSetup: boolean;
  messages: readonly QueuedChatMessage[];
}

const seen: {
  wait: QueuedMessageSetupWait | undefined;
  announcement: QueuedMessageAnnouncement | null;
} = { wait: undefined, announcement: null };

function Probe({ target, queuedForSetup, messages }: ProbeProps): JSX.Element {
  const wait = useWorktreeSetupWait(target, queuedForSetup, messages);
  const announcement = useSetupQueueAnnouncement(
    target,
    wait,
    messages.length > 0,
  );
  seen.wait = wait;
  seen.announcement = announcement;
  return <></>;
}

describe('useWorktreeSetupWait', () => {
  let container: HTMLDivElement;
  let root: Root;

  function render(props: ProbeProps): void {
    act(() => root.render(<Probe {...props} />));
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    window.localStorage.clear();
    setRow(null);
    seen.wait = undefined;
    seen.announcement = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
  });

  const queued: QueuedChatMessage[] = [
    { text: 'second', enqueuedAtMs: NOW - 2_000 },
    { text: 'first', enqueuedAtMs: NOW - 5_000 },
  ];

  it('is undefined while not waiting for setup', () => {
    render({ target: TARGET, queuedForSetup: false, messages: queued });
    expect(seen.wait).toBeUndefined();
  });

  it('starts from the setting-up row and uses that project history', () => {
    recordWorktreeSetupDuration('p1', 30_000, NOW - 60_000);
    setRow({
      createdAt: new Date(NOW - 8_000).toISOString(),
      setupPhase: 'git-pending',
    });
    render({ target: TARGET, queuedForSetup: true, messages: queued });
    expect(seen.wait).toEqual({
      startedAtMs: NOW - 8_000,
      estimateMs: 30_000,
      projectName: 'canopy',
    });
  });

  it('does not use history from a different project', () => {
    recordWorktreeSetupDuration('other', 30_000, NOW - 60_000);
    setRow({
      createdAt: new Date(NOW - 8_000).toISOString(),
      setupPhase: 'git-pending',
    });
    render({ target: TARGET, queuedForSetup: true, messages: queued });
    expect(seen.wait?.estimateMs).toBeUndefined();
  });

  it('falls back to the earliest queued message, without an estimate', () => {
    recordWorktreeSetupDuration('p1', 30_000, NOW - 60_000);
    render({ target: TARGET, queuedForSetup: true, messages: queued });
    expect(seen.wait).toEqual({
      startedAtMs: NOW - 5_000,
      projectName: 'canopy',
    });
  });

  it('falls back to now without a row or queued time', () => {
    render({
      target: TARGET,
      queuedForSetup: true,
      messages: [{ text: 'no time' }],
    });
    expect(seen.wait?.startedAtMs).toBe(NOW);
  });

  it('ignores invalid or future queued origins before choosing a valid fallback', () => {
    render({
      target: TARGET,
      queuedForSetup: true,
      messages: [
        { text: 'negative', enqueuedAtMs: -1 },
        { text: 'future', enqueuedAtMs: NOW + 10_000 },
        { text: 'invalid', enqueuedAtMs: Number.NaN },
        { text: 'valid', enqueuedAtMs: NOW - 3_000 },
      ],
    });
    expect(seen.wait?.startedAtMs).toBe(NOW - 3_000);
  });

  it('uses the observation time when every queued origin is in the future', () => {
    render({
      target: TARGET,
      queuedForSetup: true,
      messages: [{ text: 'future', enqueuedAtMs: NOW + 10_000 }],
    });
    expect(seen.wait?.startedAtMs).toBe(NOW);
  });

  it('keeps its start when a row arrives late or a message is deleted', () => {
    render({ target: TARGET, queuedForSetup: true, messages: queued });
    act(() =>
      setRow({
        createdAt: new Date(NOW - 20_000).toISOString(),
        setupPhase: 'git-pending',
      }),
    );
    render({ target: TARGET, queuedForSetup: true, messages: [queued[0]] });
    expect(seen.wait?.startedAtMs).toBe(NOW - 5_000);
    expect(seen.wait?.estimateMs).toBeUndefined();
  });

  it('keeps its estimate when history changes during the wait', () => {
    recordWorktreeSetupDuration('p1', 30_000, NOW - 60_000);
    setRow({
      createdAt: new Date(NOW - 8_000).toISOString(),
      setupPhase: 'git-pending',
    });
    render({ target: TARGET, queuedForSetup: true, messages: queued });
    recordWorktreeSetupDuration('p1', 90_000, NOW);
    render({ target: TARGET, queuedForSetup: true, messages: [...queued] });
    expect(seen.wait?.estimateMs).toBe(30_000);
  });

  it('starts fresh for a new target and for a later wait on the same one', () => {
    render({ target: TARGET, queuedForSetup: true, messages: queued });
    const first = seen.wait?.startedAtMs;
    render({
      target: { ...TARGET, chatId: 'c2' },
      queuedForSetup: true,
      messages: [{ text: 'x', enqueuedAtMs: NOW - 1_000 }],
    });
    expect(seen.wait?.startedAtMs).toBe(NOW - 1_000);

    render({ target: TARGET, queuedForSetup: false, messages: [] });
    expect(seen.wait).toBeUndefined();
    jest.setSystemTime(NOW + 30_000);
    render({
      target: TARGET,
      queuedForSetup: true,
      messages: [{ text: 'again', enqueuedAtMs: NOW + 29_000 }],
    });
    expect(seen.wait?.startedAtMs).toBe(NOW + 29_000);
    expect(seen.wait?.startedAtMs).not.toBe(first);
  });

  it('returns a stable object between renders of one wait', () => {
    render({ target: TARGET, queuedForSetup: true, messages: queued });
    const first = seen.wait;
    render({ target: TARGET, queuedForSetup: true, messages: queued });
    expect(seen.wait).toBe(first);
  });
});

describe('useSetupQueueAnnouncement', () => {
  let container: HTMLDivElement;
  let root: Root;

  function render(props: ProbeProps): void {
    act(() => root.render(<Probe {...props} />));
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    window.localStorage.clear();
    setRow(null);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
  });

  const queued: QueuedChatMessage[] = [{ text: 'hi', enqueuedAtMs: NOW }];

  it('announces the queued reason once per wait', () => {
    render({ target: TARGET, queuedForSetup: true, messages: queued });
    const first = seen.announcement;
    expect(first?.text).toBe(
      "Queued. Setting up this chat's copy of canopy. Your message will send automatically when it's ready.",
    );
    // Ticks and rerenders announce nothing new.
    act(() => jest.advanceTimersByTime(5_000));
    render({ target: TARGET, queuedForSetup: true, messages: [...queued] });
    expect(seen.announcement).toBe(first);
  });

  it('announces sending only for an actual dispatch of this chat', () => {
    render({ target: TARGET, queuedForSetup: true, messages: queued });
    const queuedAnnouncement = seen.announcement;

    // Another chat's dispatch is not this chat's news.
    act(() => emitSetupQueueDispatch({ ...TARGET, chatId: 'other', count: 1 }));
    expect(seen.announcement).toBe(queuedAnnouncement);

    // Setup finishing without a dispatch (another blocker, or the queue was
    // emptied) says nothing.
    render({ target: TARGET, queuedForSetup: false, messages: [] });
    expect(seen.announcement).toBeNull();

    act(() => emitSetupQueueDispatch({ ...TARGET, count: 1 }));
    expect(seen.announcement?.text).toBe('Sending your message.');
    const firstSend = seen.announcement?.id;
    act(() => emitSetupQueueDispatch({ ...TARGET, count: 2 }));
    expect(seen.announcement?.text).toBe('Sending your messages.');
    expect(seen.announcement?.id).not.toBe(firstSend);
  });

  it('clears and stops listening when the chat changes', () => {
    render({ target: TARGET, queuedForSetup: true, messages: queued });
    render({
      target: { ...TARGET, chatId: 'c2' },
      queuedForSetup: false,
      messages: [],
    });
    expect(seen.announcement).toBeNull();
    act(() => emitSetupQueueDispatch({ ...TARGET, count: 1 }));
    expect(seen.announcement).toBeNull();
  });

  it('does not announce a wait with nothing queued', () => {
    render({ target: TARGET, queuedForSetup: true, messages: [] });
    expect(seen.announcement).toBeNull();
  });

  it('announces a later wait even when it has the same worktree origin', () => {
    render({ target: TARGET, queuedForSetup: true, messages: queued });
    const firstId = seen.announcement?.id;
    render({ target: TARGET, queuedForSetup: false, messages: [] });
    render({ target: TARGET, queuedForSetup: true, messages: queued });
    expect(seen.announcement?.text).toContain('Queued.');
    expect(seen.announcement?.id).not.toBe(firstId);
  });

  it('announces a different chat even when its wait has the same origin', () => {
    render({ target: TARGET, queuedForSetup: true, messages: queued });
    render({
      target: { ...TARGET, chatId: 'c2' },
      queuedForSetup: true,
      messages: queued,
    });
    expect(seen.announcement?.text).toContain('Queued.');
  });

  it('ignores a dispatch without an observed setup-queued input', () => {
    render({ target: TARGET, queuedForSetup: false, messages: [] });
    act(() => emitSetupQueueDispatch({ ...TARGET, count: 1 }));
    expect(seen.announcement).toBeNull();
  });

  it('withdraws the queued announcement when setup or its last input is cancelled', () => {
    render({ target: TARGET, queuedForSetup: true, messages: queued });
    render({ target: TARGET, queuedForSetup: false, messages: [] });
    expect(seen.announcement).toBeNull();
  });

  it('coalesces actual dispatch signals from one batch', () => {
    render({ target: TARGET, queuedForSetup: true, messages: queued });
    act(() => {
      emitSetupQueueDispatch({ ...TARGET, count: 1 });
      emitSetupQueueDispatch({ ...TARGET, count: 1 });
    });
    expect(seen.announcement?.text).toBe('Sending your messages.');
  });
});
