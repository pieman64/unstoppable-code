/** @jest-environment jsdom */
import { act, useRef, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  useTranscriptSearch,
  type TranscriptSearchPageSource,
} from '../useTranscriptSearch';
import type {
  ChatTranscriptSearchResult,
  ChatTranscriptSearchRequest,
} from '@canopy/desktop-shared/types';
import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';
import type * as DomSearchHighlight from '@/lib/dom-search-highlight';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const mockPage = jest.fn<Promise<void>, unknown[]>();
const mockState = jest.fn<unknown, []>();
jest.mock('@/stores/chatStore', () => {
  const useChatStore = (selector: (state: unknown) => unknown): unknown =>
    selector(mockState());
  useChatStore.getState = (): unknown => mockState();
  return {
    useChatStore,
    ...jest
      .requireActual<
        typeof ChatRenderStoresTestUtils
      >('@/test-utils/chatRenderStores')
      .mockChatRenderHooks(() => mockState()),
  };
});
jest.mock('@/stores/chat/transcript-pages', () => ({
  loadChatTranscriptPage: (...args: unknown[]): Promise<void> =>
    mockPage(...args),
}));
const mockScrollToMatch = jest.fn<void, [number]>();
const mockActiveMatch = jest.fn<void, [HTMLElement | null, number]>();
jest.mock('@/lib/dom-search-highlight', () => ({
  createDomSearchExecutor: (
    getContainer: () => HTMLElement | null,
  ): {
    clearHighlights: jest.Mock<void, []>;
    findMatches: (query: string) => number;
    setActiveMatch: jest.Mock<void, [number]>;
    scrollToMatch: (index: number) => void;
  } => {
    const actual = jest
      .requireActual<typeof DomSearchHighlight>('@/lib/dom-search-highlight')
      .createDomSearchExecutor(getContainer);
    return {
      clearHighlights: jest.fn(actual.clearHighlights),
      findMatches: actual.findMatches,
      setActiveMatch: jest.fn((index: number) => {
        mockActiveMatch(getContainer(), index);
        actual.setActiveMatch(index);
      }),
      scrollToMatch: (index: number): void => mockScrollToMatch(index),
    };
  },
}));
let result: ReturnType<typeof useTranscriptSearch>;
function Harness({
  chatId = 'chat',
  revision = 1,
  pageSource,
  withTranscript = false,
  pieces,
}: {
  chatId?: string;
  revision?: number;
  pageSource?: TranscriptSearchPageSource;
  withTranscript?: boolean;
  pieces?: string[];
}): ReactElement | null {
  const container = useRef<HTMLDivElement>(null);
  result = useTranscriptSearch(
    { projectId: 'p', worktreeId: 'w', chatId },
    revision,
    container,
    pageSource,
  );
  return withTranscript ? (
    <div ref={container} data-testid="transcript">
      {(pieces ?? ['needle']).map((text, index) => (
        <div key={index} data-chat-message-id="old" data-piece={index}>
          {text}
        </div>
      ))}
    </div>
  ) : null;
}
const descriptor = (
  committedMessageCount: number,
  transcriptRevision: number,
  committedDigest = 'a'.repeat(64),
): {
  format: 'complete-message-jsonl-v1';
  committedMessageCount: number;
  committedByteLength: number;
  transcriptRevision: number;
  hasActiveSidecar: boolean;
  committedDigest: string;
} => ({
  format: 'complete-message-jsonl-v1',
  committedMessageCount,
  committedByteLength: committedMessageCount * 40,
  transcriptRevision,
  hasActiveSidecar: false,
  committedDigest,
});

describe('canonical transcript search lifecycle', () => {
  let root: Root;
  let host: HTMLDivElement;
  let search: jest.Mock<
    Promise<ChatTranscriptSearchResult>,
    [ChatTranscriptSearchRequest]
  >;
  let cancel: jest.Mock<Promise<void>, [string]>;
  beforeEach(() => {
    jest.useFakeTimers();
    search = jest.fn<
      Promise<ChatTranscriptSearchResult>,
      [ChatTranscriptSearchRequest]
    >();
    cancel = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        chat: { searchTranscript: search, cancelTranscriptSearch: cancel },
      },
    });
    mockPage.mockReset();
    mockState.mockReturnValue({ worktreeChats: {} });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<Harness />));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    jest.useRealTimers();
  });
  async function query(text: string): Promise<void> {
    act(() => result.setQuery(text));
    await act(async () => {
      jest.advanceTimersByTime(150);
      await Promise.resolve();
    });
  }
  async function settle(ms = 0): Promise<void> {
    await act(async () => {
      if (ms) jest.advanceTimersByTime(ms);
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
  }
  it('ignores a late superseded response and cancels the main-process scan', async () => {
    let resolveOld: (value: ChatTranscriptSearchResult) => void = () => {
      throw new Error('Search resolver was not initialized');
    };
    search.mockReturnValueOnce(
      new Promise<ChatTranscriptSearchResult>((resolve) => {
        resolveOld = resolve;
      }),
    );
    search.mockResolvedValueOnce({ matches: [], totalCount: 0 });
    await query('old');
    const oldId = search.mock.calls[0][0].requestId;
    await query('new');
    await act(() =>
      Promise.resolve(
        resolveOld({
          matches: [{ messageId: 'old', turnId: 'turn', count: 5 }],
          totalCount: 5,
        }),
      ),
    );
    expect(cancel).toHaveBeenCalledWith(oldId);
    expect(result.query).toBe('new');
    expect(result.totalCount).toBe(0);
    expect(mockPage).not.toHaveBeenCalled();
  });
  it('loads only the selected match turn and retains counts through navigation', async () => {
    let tab = {
      id: 'chat',
      messages: [{ id: 'recent' }],
      transcriptWindow: {
        turns: [
          { id: 'old-turn', before: 500 },
          { id: 'other-turn', before: 1000 },
        ],
      },
    };
    mockState.mockImplementation(() => ({
      worktreeChats: { 'p/w': { tabs: [tab] } },
    }));
    mockPage.mockImplementation(() => {
      tab = { ...tab, messages: [...tab.messages, { id: 'old' }] };
      return Promise.resolve();
    });
    search.mockResolvedValue({
      matches: [{ messageId: 'old', turnId: 'old-turn', count: 2 }],
      totalCount: 2,
    });
    await query('needle');
    expect(mockPage).toHaveBeenCalledTimes(1);
    expect(mockPage).toHaveBeenCalledWith(
      { projectId: 'p', worktreeId: 'w', chatId: 'chat' },
      true,
      'old-turn',
    );
    expect(result.totalCount).toBe(2);
    await act(() => Promise.resolve(result.goToNext()));
    expect(result.currentIndex).toBe(1);
    expect(mockPage).toHaveBeenCalledTimes(1);
    await act(() => Promise.resolve(result.close()));
    expect(result.selection).toBeNull();
    expect(result.totalCount).toBe(0);
  });
  it('loads a selected match through a local transcript page source', async () => {
    let tab = {
      messages: [{ id: 'recent' }],
      transcriptWindow: {
        turns: [{ id: 'old-turn', before: 500 }],
      },
    };
    const pageSource: TranscriptSearchPageSource = {
      currentTab: () => tab,
      loadPage: jest.fn(() => {
        tab = { ...tab, messages: [...tab.messages, { id: 'old' }] };
        return Promise.resolve();
      }),
    };
    search.mockResolvedValue({
      matches: [{ messageId: 'old', turnId: 'old-turn', count: 1 }],
      totalCount: 1,
    });
    act(() => root.render(<Harness pageSource={pageSource} />));
    await query('needle');
    await settle();
    expect(pageSource.loadPage).toHaveBeenCalledWith(true, 'old-turn');
    expect(result.selection).toMatchObject({
      messageId: 'old',
      turnId: 'old-turn',
    });
    expect(mockPage).not.toHaveBeenCalled();
  });
  it('accumulates occurrences per rendered element across folded tool results', async () => {
    const tab = {
      id: 'chat',
      messages: [{ id: 'assistant' }, { id: 'result' }],
      transcriptWindow: { turns: [] },
    };
    mockState.mockImplementation(() => ({
      worktreeChats: { 'p/w': { tabs: [tab] } },
    }));
    // "Reading the file" in the assistant row plus a Read result containing
    // "file" twice, folded into the same rendered element.
    search.mockResolvedValue({
      matches: [
        { messageId: 'assistant', turnId: 'turn', count: 1 },
        {
          messageId: 'result',
          turnId: 'turn',
          renderMessageId: 'assistant',
          count: 2,
        },
      ],
      totalCount: 3,
    });
    await query('file');
    await settle();
    expect(result.selection).toMatchObject({
      messageId: 'assistant',
      occurrence: 0,
    });
    act(() => result.goToNext());
    await settle();
    expect(result.selection).toMatchObject({
      messageId: 'result',
      renderMessageId: 'assistant',
      occurrence: 1,
    });
    act(() => result.goToNext());
    await settle();
    expect(result.selection).toMatchObject({
      messageId: 'result',
      renderMessageId: 'assistant',
      occurrence: 2,
    });
    expect(mockPage).not.toHaveBeenCalled();
  });
  it('keeps the selection and does not rescan when only the revision advances', async () => {
    const tab = {
      id: 'chat',
      messages: [{ id: 'old' }],
      transcript: descriptor(2, 2),
      transcriptWindow: { turns: [] },
    };
    mockState.mockImplementation(() => ({
      worktreeChats: { 'p/w': { tabs: [tab] } },
    }));
    search.mockResolvedValue({
      matches: [{ messageId: 'old', turnId: 'turn', count: 2 }],
      totalCount: 2,
    });
    await query('needle');
    await settle();
    act(() => result.goToNext());
    await settle();
    expect(result.currentIndex).toBe(1);
    expect(result.selection).toMatchObject({ messageId: 'old', occurrence: 1 });
    // Streaming commits bump the revision every debounce window without
    // changing the committed prefix.
    tab.transcript = descriptor(2, 3);
    act(() => root.render(<Harness revision={3} />));
    await settle(150);
    tab.transcript = descriptor(2, 4);
    act(() => root.render(<Harness revision={4} />));
    await settle(5_000);
    expect(search).toHaveBeenCalledTimes(1);
    expect(result.currentIndex).toBe(1);
    expect(result.selection).toMatchObject({ messageId: 'old', occurrence: 1 });
  });
  it('rescans when committed counts change and preserves the selected match', async () => {
    const tab = {
      id: 'chat',
      messages: [{ id: 'old' }, { id: 'new' }],
      transcript: descriptor(2, 2),
      transcriptWindow: { turns: [] },
    };
    mockState.mockImplementation(() => ({
      worktreeChats: { 'p/w': { tabs: [tab] } },
    }));
    search.mockResolvedValueOnce({
      matches: [{ messageId: 'old', turnId: 'turn', count: 2 }],
      totalCount: 2,
    });
    await query('needle');
    await settle();
    act(() => result.goToNext());
    await settle();
    expect(result.currentIndex).toBe(1);
    search.mockResolvedValueOnce({
      matches: [
        { messageId: 'old', turnId: 'turn', count: 2 },
        { messageId: 'new', turnId: 'turn', count: 1 },
      ],
      totalCount: 3,
    });
    tab.transcript = descriptor(3, 5);
    act(() => root.render(<Harness revision={5} />));
    await settle(150);
    expect(search).toHaveBeenCalledTimes(1);
    await settle(2_000);
    expect(search).toHaveBeenCalledTimes(2);
    expect(result.totalCount).toBe(3);
    expect(result.currentIndex).toBe(1);
    expect(result.selection).toMatchObject({ messageId: 'old', occurrence: 1 });
    expect(mockPage).not.toHaveBeenCalled();
  });
  it.each([
    { pieces: ['Thinking', 'needle'], occurrence: 0, piece: '1', local: 0 },
    {
      pieces: ['needle', 'needle needle'],
      occurrence: 2,
      piece: '1',
      local: 1,
    },
  ])(
    'reveals occurrence $occurrence across split rows: $pieces',
    async ({ pieces, occurrence, piece, local }) => {
      mockActiveMatch.mockClear();
      mockState.mockReturnValue({
        worktreeChats: {
          'p/w': {
            tabs: [
              {
                id: 'chat',
                messages: [{ id: 'old' }],
                transcriptWindow: { turns: [] },
              },
            ],
          },
        },
      });
      const count = pieces.join(' ').match(/needle/g)?.length ?? 0;
      search.mockResolvedValue({
        matches: [{ messageId: 'old', turnId: 'turn', count }],
        totalCount: count,
      });
      act(() => root.render(<Harness withTranscript pieces={pieces} />));
      await query('needle');
      await settle();
      for (let index = 0; index < occurrence; index++) {
        act(() => result.goToNext());
        await settle();
      }
      await settle(16);
      expect(mockActiveMatch).toHaveBeenLastCalledWith(
        host.querySelector(`[data-piece="${piece}"]`),
        local,
      );
    },
  );
  it('stops following the active match once the user presses a key in the transcript', async () => {
    mockScrollToMatch.mockReset();
    const tab = {
      id: 'chat',
      messages: [{ id: 'old' }],
      transcriptWindow: { turns: [] },
    };
    mockState.mockImplementation(() => ({
      worktreeChats: { 'p/w': { tabs: [tab] } },
    }));
    search.mockResolvedValue({
      matches: [{ messageId: 'old', turnId: 'turn', count: 1 }],
      totalCount: 1,
    });
    act(() => root.render(<Harness withTranscript />));
    await query('needle');
    await settle();
    expect(result.selection).toMatchObject({ messageId: 'old' });
    await settle(16);
    expect(mockScrollToMatch).toHaveBeenCalledTimes(1);
    const transcript = host.querySelector('[data-testid="transcript"]');
    if (!transcript) throw new Error('Expected the transcript container');
    act(() => {
      transcript.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }),
      );
    });
    await settle(1_000);
    expect(mockScrollToMatch).toHaveBeenCalledTimes(1);
  });
  it('rescans an equal-size transcript replacement when its digest changes', async () => {
    const tab = {
      id: 'chat',
      messages: [{ id: 'old' }],
      transcript: descriptor(2, 2, 'a'.repeat(64)),
      transcriptWindow: { turns: [] },
    };
    mockState.mockImplementation(() => ({
      worktreeChats: { 'p/w': { tabs: [tab] } },
    }));
    search.mockResolvedValueOnce({
      matches: [{ messageId: 'old', turnId: 'turn', count: 1 }],
      totalCount: 1,
    });
    await query('needle');
    await settle();
    search.mockResolvedValueOnce({
      matches: [{ messageId: 'replacement', turnId: 'turn', count: 2 }],
      totalCount: 2,
    });
    tab.messages = [{ id: 'replacement' }];
    tab.transcript = descriptor(2, 3, 'b'.repeat(64));
    act(() => root.render(<Harness revision={3} />));
    await settle(2_150);
    expect(search).toHaveBeenCalledTimes(2);
    expect(result.totalCount).toBe(2);
    expect(result.selection).toMatchObject({ messageId: 'replacement' });
  });
});
