/**
 * The interest tracker with a hand-driven frame queue: one declaration per
 * frame, none when unchanged, forced re-declares, the warm LRU (ordering,
 * bound, focus exclusion), the caps, and failed sends logged without retry.
 */
import type {
  ChatInterestChatRef,
  ChatInterestDeclaration,
} from '@canopy/desktop-shared/types';
import {
  MAX_FOCUSED_CHATS,
  PREFETCH_WARM_LIMIT,
  WARM_CHAT_LIMIT,
  createChatInterestTracker,
  type ChatInterestTracker,
} from '../tracker';

function ref(chatId: string): ChatInterestChatRef {
  return { projectId: 'proj', worktreeId: 'wt', chatId };
}

function ids(refs: readonly ChatInterestChatRef[]): string[] {
  return refs.map((item) => item.chatId);
}

interface Harness {
  tracker: ChatInterestTracker;
  send: jest.Mock<Promise<void>, [ChatInterestDeclaration]>;
  onSendFailed: jest.Mock<void, [unknown]>;
  setFocused(chatIds: readonly string[]): void;
  runFrame(): void;
  pendingFrames(): number;
}

function harness(): Harness {
  let focused: ChatInterestChatRef[] = [];
  let frames: Array<() => void> = [];
  const send = jest.fn<Promise<void>, [ChatInterestDeclaration]>(() =>
    Promise.resolve(),
  );
  const onSendFailed = jest.fn<void, [unknown]>();
  const tracker = createChatInterestTracker({
    readFocused: () => focused,
    send,
    scheduleFrame: (callback) => {
      frames.push(callback);
      return (): void => {
        frames = frames.filter((frame) => frame !== callback);
      };
    },
    onSendFailed,
  });
  return {
    tracker,
    send,
    onSendFailed,
    setFocused: (chatIds): void => {
      focused = chatIds.map(ref);
      tracker.invalidate();
    },
    runFrame: (): void => {
      const pending = frames;
      frames = [];
      pending.forEach((frame) => frame());
    },
    pendingFrames: () => frames.length,
  };
}

function lastDeclaration(send: Harness['send']): {
  focused: string[];
  warm: string[];
} {
  const declaration = send.mock.calls.at(-1)?.[0];
  return {
    focused: ids(declaration?.focused ?? []),
    warm: ids(declaration?.warm ?? []),
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createChatInterestTracker', () => {
  it('declares once per frame however many changes arrive', () => {
    const h = harness();
    h.setFocused(['a']);
    h.setFocused(['a', 'b']);
    h.tracker.redeclare();
    expect(h.pendingFrames()).toBe(1);
    expect(h.send).not.toHaveBeenCalled();

    h.runFrame();

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(lastDeclaration(h.send)).toEqual({ focused: ['a', 'b'], warm: [] });
    expect(h.send.mock.calls[0]?.[0]).not.toHaveProperty('focusedRuns');
    // This renderer handles `messages.omitted`, so it says so.
    expect(h.send.mock.calls[0]?.[0]).toHaveProperty(
      'acceptsMessagesOmitted',
      true,
    );
  });

  it('does not send an unchanged interest, but does on redeclare', () => {
    const h = harness();
    h.setFocused(['a']);
    h.runFrame();
    h.setFocused(['a']);
    h.runFrame();
    expect(h.send).toHaveBeenCalledTimes(1);

    h.tracker.redeclare();
    h.runFrame();
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(lastDeclaration(h.send)).toEqual({ focused: ['a'], warm: [] });
  });

  it('keeps recently focused chats warm, most recent first, bounded', () => {
    const h = harness();
    for (const chatId of ['a', 'b', 'c', 'd', 'e', 'f']) {
      h.setFocused([chatId]);
      h.runFrame();
    }
    expect(lastDeclaration(h.send)).toEqual({
      focused: ['f'],
      warm: ['e', 'd', 'c', 'b'],
    });
    expect(WARM_CHAT_LIMIT).toBe(4);

    // Refocusing a warm chat removes it from warm; leaving it again puts it
    // back in front.
    h.setFocused(['c']);
    h.runFrame();
    expect(lastDeclaration(h.send)).toEqual({
      focused: ['c'],
      warm: ['f', 'e', 'd', 'b'],
    });
    h.setFocused([]);
    h.runFrame();
    expect(lastDeclaration(h.send)).toEqual({
      focused: [],
      warm: ['c', 'f', 'e', 'd'],
    });
  });

  it('caps focused chats and removes duplicates', () => {
    const h = harness();
    const many = Array.from({ length: 40 }, (_, index) => `chat-${index}`);
    h.setFocused(['chat-0', ...many]);
    h.runFrame();
    const declared = lastDeclaration(h.send).focused;
    expect(declared).toHaveLength(MAX_FOCUSED_CHATS);
    expect(declared.slice(0, 2)).toEqual(['chat-0', 'chat-1']);
  });

  it('logs a failed send once and does not retry it', async () => {
    const h = harness();
    const error = new Error('rejected');
    h.send.mockRejectedValueOnce(error);
    h.setFocused(['a']);
    h.runFrame();
    await flushMicrotasks();

    expect(h.onSendFailed).toHaveBeenCalledTimes(1);
    expect(h.onSendFailed).toHaveBeenCalledWith(error);
    expect(h.pendingFrames()).toBe(0);

    // An unrelated source change does not resend the failed interest.
    h.setFocused(['a']);
    h.runFrame();
    expect(h.send).toHaveBeenCalledTimes(1);

    // The next real change declares again.
    h.setFocused(['b']);
    h.runFrame();
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it('reads the current interest and notifies subscribers of changes', () => {
    const h = harness();
    const listener = jest.fn();
    h.tracker.subscribe(listener);
    h.setFocused(['a']);

    expect(ids(h.tracker.current().focused)).toEqual(['a']);
    expect(listener).toHaveBeenCalledTimes(1);
    h.runFrame();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('stops scheduling after dispose', () => {
    const h = harness();
    h.setFocused(['a']);
    h.tracker.dispose();
    expect(h.pendingFrames()).toBe(0);
    h.setFocused(['b']);
    h.runFrame();
    expect(h.send).not.toHaveBeenCalled();
  });
});

it('flushes focus before a page read and waits for the setInterest acknowledgement', async () => {
  const h = harness();
  let acknowledge = (): void => undefined;
  h.send.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
  );
  h.setFocused(['focused']);
  const read = jest.fn();
  const page = h.tracker.flushNow().then(read);
  expect(lastDeclaration(h.send).focused).toEqual(['focused']);
  expect(h.pendingFrames()).toBe(0);
  await flushMicrotasks();
  expect(read).not.toHaveBeenCalled();
  const joined = h.tracker.flushNow();
  expect(h.send).toHaveBeenCalledTimes(1);
  acknowledge();
  await Promise.all([page, joined]);
  expect(read).toHaveBeenCalledTimes(1);
});

describe('warmUp', () => {
  it('warms a prefetched chat after the recent ones and declares it at once', async () => {
    const h = harness();
    h.setFocused(['a']);
    h.runFrame();
    h.setFocused(['b']);
    h.runFrame();
    expect(lastDeclaration(h.send)).toEqual({ focused: ['b'], warm: ['a'] });

    await h.tracker.warmUp(ref('p'));
    // No frame needed: a prefetch declares before its page read.
    expect(h.pendingFrames()).toBe(0);
    expect(lastDeclaration(h.send)).toEqual({
      focused: ['b'],
      warm: ['a', 'p'],
    });

    // A prefetched chat that becomes focused leaves warm, and the recent list
    // keeps its own order when focus moves on.
    h.setFocused(['p']);
    h.runFrame();
    expect(lastDeclaration(h.send)).toEqual({
      focused: ['p'],
      warm: ['b', 'a'],
    });
  });

  it('never lets prefetches evict recently focused chats', async () => {
    const h = harness();
    for (const chatId of ['r1', 'r2', 'r3', 'r4', 'now']) {
      h.setFocused([chatId]);
      h.runFrame();
    }
    for (let index = 0; index < PREFETCH_WARM_LIMIT + 2; index += 1)
      await h.tracker.warmUp(ref(`p${index}`));
    const { warm } = lastDeclaration(h.send);
    expect(warm.slice(0, WARM_CHAT_LIMIT)).toEqual(['r4', 'r3', 'r2', 'r1']);
    // Only the most recent prefetches are kept.
    expect(warm.slice(WARM_CHAT_LIMIT)).toEqual(['p5', 'p4', 'p3', 'p2']);
  });
});
