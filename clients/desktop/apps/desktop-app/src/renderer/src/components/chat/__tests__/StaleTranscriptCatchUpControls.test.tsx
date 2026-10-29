/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TranscriptPage } from '@canopy/agent-transcript/transcript-storage';
import { useChatStore } from '@/stores/chatStore';
import { fromPersistedTab } from '@/stores/chat/persisted-tabs';
import { catchUpStaleChat } from '@/stores/chat/stale-catch-up';
import { StaleTranscriptCatchUpControls } from '../StaleTranscriptCatchUpControls';

jest.mock('@/lib/chat-interest', () => ({
  flushChatInterest: (): Promise<void> => Promise.resolve(),
}));

const target = { projectId: 'p', worktreeId: 'w', chatId: 'chat' };
const row = {
  id: 'answer',
  role: 'assistant' as const,
  timestamp: 1,
  blocks: [{ type: 'text' as const, text: 'cached' }],
};
const page: TranscriptPage = {
  view: 'turns',
  messages: [row],
  turns: [],
  messageOrdinals: { answer: 0 },
  transcriptRevision: 1,
  totalMessages: 1,
};
let container: HTMLDivElement;
let root: Root;
let original: ReturnType<typeof useChatStore.getState>;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  jest.useFakeTimers();
  original = useChatStore.getState();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useChatStore.setState(original, true);
  jest.useRealTimers();
});

function render(cached = true): void {
  useChatStore.setState({
    worktreeChats: {
      'p/w': {
        activeTabId: 'chat',
        tabs: [
          {
            ...fromPersistedTab({
              id: 'chat',
              title: 'Chat',
              createdAt: 'now',
              messages: cached ? [row] : [],
              transcriptLoaded: true,
            }),
            transcriptStale: true,
          },
        ],
      },
    },
    chatStateSync: { 'p/w': { phase: 'live', revision: 1 } },
  });
  act(() =>
    root.render(
      <StaleTranscriptCatchUpControls target={target}>
        <div data-testid="ordinary-paging" />
      </StaleTranscriptCatchUpControls>,
    ),
  );
}

it('keeps cached rows free of a spinner for 300 ms, then reuses paging loading and restores normal paging', async () => {
  render();
  let resolve: (page: TranscriptPage) => void = () => undefined;
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      chat: {
        getTranscriptPage: () =>
          new Promise<TranscriptPage>((done) => {
            resolve = done;
          }),
      },
    },
  });
  let pending: Promise<void> = Promise.resolve();
  await act(async () => {
    pending = catchUpStaleChat(target, () => Promise.resolve());
    await Promise.resolve();
  });
  expect(container.querySelector('[role="status"]')).toBeNull();
  act(() => jest.advanceTimersByTime(299));
  expect(container.querySelector('[role="status"]')).toBeNull();
  act(() => jest.advanceTimersByTime(1));
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    'Loading messages',
  );
  await act(async () => {
    resolve(page);
    await pending;
  });
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(
    container.querySelector('[data-testid="ordinary-paging"]'),
  ).not.toBeNull();
});

it('uses the existing immediate indicator for an empty cache', () => {
  render(false);
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    'Loading messages',
  );
});

it('reuses the existing load error and retry without clearing stale after failure', async () => {
  render();
  const read = jest
    .fn<Promise<TranscriptPage>, []>()
    .mockRejectedValueOnce(new Error('failed'))
    .mockResolvedValue(page);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { chat: { getTranscriptPage: read } },
  });
  await act(async () => {
    await catchUpStaleChat(target, () => Promise.resolve()).catch(
      () => undefined,
    );
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Couldn't load messages.",
  );
  expect(
    useChatStore.getState().worktreeChats['p/w'].tabs[0].transcriptStale,
  ).toBe(true);
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[data-testid="chat-transcript-retry"]')
      ?.click();
    await Promise.resolve();
  });
  expect(read).toHaveBeenCalledTimes(2);
  expect(
    container.querySelector('[data-testid="ordinary-paging"]'),
  ).not.toBeNull();
});
