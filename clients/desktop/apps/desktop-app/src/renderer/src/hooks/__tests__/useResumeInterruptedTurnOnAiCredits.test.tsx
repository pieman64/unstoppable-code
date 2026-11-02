/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  useAiCreditsBannerStore,
  type ChatBannerTarget,
} from '@/stores/aiCreditsBannerStore';
import { useResumeInterruptedTurnOnAiCredits } from '../useResumeInterruptedTurnOnAiCredits';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface MockTab {
  id: string;
  messages: unknown[];
  status: string;
  readOnly?: boolean;
  queuedMessages: unknown[];
}

interface SendOptions {
  attachmentPaths?: string[];
  attachmentPromptContexts?: unknown[];
  throwOnDispatchFailure?: boolean;
  onDispatchRejected?: () => void;
  onPreDispatchRejected?: () => void;
}
type SendArgs = [string, unknown, ChatBannerTarget, string, SendOptions];

const mockSendMessage = jest.fn<Promise<void>, SendArgs>();
const mockChatState: {
  worktreeChats: Record<string, { tabs: MockTab[] }>;
  sendMessage: typeof mockSendMessage;
} = { worktreeChats: {}, sendMessage: mockSendMessage };
jest.mock('@/stores/chatStore', () => ({
  useChatStore: { getState: (): unknown => mockChatState },
}));

const mockClearResumed = jest.fn<void, [unknown]>();
jest.mock('@/stores/chat/tab-utils', () => ({
  clearResumedChatUsageLimitBanner: (target: unknown): void =>
    mockClearResumed(target),
}));

const mockCompute = jest.fn();
jest.mock('@canopy/desktop-shared/lib/usage-limit-resume-prompt', () => ({
  computeUsageLimitResumePrompt: (messages: unknown): unknown =>
    mockCompute(messages),
}));

const mockFindPending = jest.fn();
jest.mock('@/lib/scheduledUsageLimitResume', () => ({
  findPendingUsageLimitResume: (...args: unknown[]): unknown =>
    mockFindPending(...args),
}));

const mockDeleteActivity = jest.fn();
const mockUpdateActivity = jest.fn();
const mockActivities: unknown[] = [];
jest.mock('@/stores/automationsStore', () => ({
  useAutomationsStore: {
    getState: (): unknown => ({
      activities: mockActivities,
      deleteActivity: mockDeleteActivity,
      updateActivity: mockUpdateActivity,
    }),
  },
}));

const TARGET: ChatBannerTarget = {
  projectId: 'proj',
  worktreeId: 'wt',
  chatId: 'chat',
};
const LIVE_MESSAGES = [{ id: 'm1', role: 'user' }];

type HookResult = ReturnType<typeof useResumeInterruptedTurnOnAiCredits>;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function seedTab(overrides: Partial<MockTab> = {}): void {
  mockChatState.worktreeChats = {
    'proj/wt': {
      tabs: [
        {
          id: 'chat',
          messages: LIVE_MESSAGES,
          status: 'idle',
          queuedMessages: [],
          ...overrides,
        },
      ],
    },
  };
}

function seedLimit(resetsAt = 1_000): void {
  useAiCreditsBannerStore
    .getState()
    .setUsageLimit(TARGET, { provider: 'claude', resetsAt });
}

describe('useResumeInterruptedTurnOnAiCredits', () => {
  let container: HTMLDivElement;
  let root: Root;
  const results: Record<string, HookResult> = {};

  function Probe({
    name,
    target,
  }: {
    name: string;
    target: ChatBannerTarget | null;
  }): JSX.Element | null {
    results[name] = useResumeInterruptedTurnOnAiCredits(target);
    return null;
  }

  function render(element: JSX.Element): void {
    act(() => root.render(element));
  }

  async function flush(): Promise<void> {
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
  }

  async function resume(name = 'a'): Promise<void> {
    await act(async () => {
      await results[name]?.resume();
    });
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockSendMessage.mockReset().mockResolvedValue(undefined);
    mockClearResumed.mockReset();
    mockCompute.mockReset().mockReturnValue({
      text: 'Original prompt',
      resendsUserMessage: true,
    });
    mockFindPending.mockReset().mockReturnValue(undefined);
    mockDeleteActivity.mockReset().mockResolvedValue({ ok: true });
    mockUpdateActivity.mockReset().mockResolvedValue({ ok: true });
    useAiCreditsBannerStore.getState().clearForChat(TARGET);
    seedTab();
    seedLimit();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useAiCreditsBannerStore.getState().clearForChat(TARGET);
  });

  it('sends the prompt computed from the live transcript', async () => {
    const fileReferences = [{ path: 'src/a.ts' }];
    const attachmentPromptContexts = [{ path: '/tmp/b.png' }];
    mockCompute.mockReturnValue({
      text: 'Original prompt',
      fileReferences,
      attachmentPaths: ['/tmp/b.png'],
      attachmentPromptContexts,
      inputMode: 'voice',
      resendsUserMessage: true,
    });
    render(<Probe name="a" target={TARGET} />);
    expect(results.a?.pending).toBe(true);

    await resume();

    expect(mockCompute).toHaveBeenCalledWith(LIVE_MESSAGES);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const [text, refs, target, mode, options] = mockSendMessage.mock.calls[0];
    expect([text, refs, target, mode]).toEqual([
      'Original prompt',
      fileReferences,
      TARGET,
      'voice',
    ]);
    expect(options).toMatchObject({
      attachmentPaths: ['/tmp/b.png'],
      attachmentPromptContexts,
      throwOnDispatchFailure: true,
    });
    // The composer draft and its attachments are not this send's.
    expect(options).not.toHaveProperty('composerAttachmentsReserved');
  });

  it('omits empty attachments and defaults to typed input', async () => {
    mockCompute.mockReturnValue({
      text: 'Continue',
      attachmentPaths: [],
      attachmentPromptContexts: [],
      resendsUserMessage: false,
    });
    render(<Probe name="a" target={TARGET} />);
    await resume();

    const [text, , , mode, options] = mockSendMessage.mock.calls[0];
    expect(text).toBe('Continue');
    expect(mode).toBe('typed');
    expect(options).not.toHaveProperty('attachmentPaths');
    expect(options).not.toHaveProperty('attachmentPromptContexts');
  });

  it.each([
    ['the turn is streaming', { status: 'streaming' }],
    ['a send is queued', { queuedMessages: [{ id: 'q' }] }],
    ['the tab is read-only', { readOnly: true }],
  ] satisfies Array<[string, Partial<MockTab>]>)(
    'does not send while %s',
    async (_label, overrides) => {
      seedTab(overrides);
      render(<Probe name="a" target={TARGET} />);
      await resume();
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(results.a?.error).toBeNull();
    },
  );

  it('does not send once the interruption is answered', async () => {
    useAiCreditsBannerStore.getState().clearUsageLimitForChat(TARGET);
    render(<Probe name="a" target={TARGET} />);
    expect(results.a?.pending).toBe(false);
    await resume();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('treats a limit restored by switching back as no interrupted turn', async () => {
    useAiCreditsBannerStore.getState().clearUsageLimitForChat(TARGET);
    useAiCreditsBannerStore
      .getState()
      .restoreUsageLimit(TARGET, { provider: 'claude', resetsAt: 1_000 });
    render(<Probe name="a" target={TARGET} />);
    expect(results.a?.pending).toBe(false);
    await resume();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('does nothing without a target', async () => {
    render(<Probe name="a" target={null} />);
    expect(results.a?.pending).toBe(false);
    await resume();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('sends once across instances for the same chat, and both report busy', async () => {
    const send = deferred<void>();
    mockSendMessage.mockReturnValue(send.promise);
    render(
      <>
        <Probe name="a" target={TARGET} />
        <Probe name="b" target={{ ...TARGET }} />
      </>,
    );

    act(() => {
      void results.a?.resume();
      void results.b?.resume();
    });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(results.a?.busy).toBe(true);
    expect(results.b?.busy).toBe(true);

    await act(async () => {
      send.resolve();
      await send.promise;
    });
    await flush();
    expect(results.a?.busy).toBe(false);
    expect(results.b?.busy).toBe(false);
  });

  it('clears the answered record after an accepted send', async () => {
    render(<Probe name="a" target={TARGET} />);
    await resume();
    expect(mockClearResumed).toHaveBeenCalledWith(TARGET);
    expect(results.a?.error).toBeNull();
  });

  it('leaves a newer limit the resent turn hit', async () => {
    mockSendMessage.mockImplementation(() => {
      seedLimit(2_000);
      return Promise.resolve();
    });
    render(<Probe name="a" target={TARGET} />);
    await resume();
    expect(mockClearResumed).not.toHaveBeenCalled();
  });

  describe('scheduled resume', () => {
    const PENDING = { id: 'resume-1' };

    beforeEach(() => {
      mockFindPending.mockReturnValue(PENDING);
    });

    it('deletes it after an accepted send', async () => {
      render(<Probe name="a" target={TARGET} />);
      await resume();
      expect(mockFindPending).toHaveBeenCalledWith(
        mockActivities,
        { workspaceId: 'proj', worktreeId: 'wt', chatId: 'chat' },
        expect.any(Number),
      );
      expect(mockDeleteActivity).toHaveBeenCalledWith('resume-1');
      expect(mockUpdateActivity).not.toHaveBeenCalled();
    });

    it('disables it when the delete is refused', async () => {
      mockDeleteActivity.mockResolvedValue({ ok: false, error: 'nope' });
      render(<Probe name="a" target={TARGET} />);
      await resume();
      expect(mockUpdateActivity).toHaveBeenCalledWith({
        id: 'resume-1',
        enabled: false,
      });
    });

    it('swallows a failure to retire it', async () => {
      mockDeleteActivity.mockRejectedValue(new Error('ipc down'));
      render(<Probe name="a" target={TARGET} />);
      await expect(resume()).resolves.toBeUndefined();
      expect(results.a?.error).toBeNull();
    });

    it('keeps it, and reports the failure, when the send throws', async () => {
      mockSendMessage.mockRejectedValue(new Error('dispatch failed'));
      render(<Probe name="a" target={TARGET} />);
      await resume();
      expect(mockDeleteActivity).not.toHaveBeenCalled();
      expect(mockClearResumed).not.toHaveBeenCalled();
      expect(results.a?.error).toBe('Could not continue this chat. Try again.');
      expect(results.a?.busy).toBe(false);
      expect(results.a?.pending).toBe(true);
    });

    it('keeps it when only a rejection callback reports the failure', async () => {
      mockSendMessage.mockImplementation(
        (_text, _refs, _target, _mode, options) => {
          options.onDispatchRejected?.();
          return Promise.resolve();
        },
      );
      render(<Probe name="a" target={TARGET} />);
      await resume();
      expect(mockDeleteActivity).not.toHaveBeenCalled();
      expect(results.a?.error).toBe('Could not continue this chat. Try again.');
    });
  });

  it('drops the failure once the interruption is answered', async () => {
    mockSendMessage.mockRejectedValue(new Error('dispatch failed'));
    render(<Probe name="a" target={TARGET} />);
    await resume();
    expect(results.a?.error).not.toBeNull();

    act(() => {
      useAiCreditsBannerStore.getState().clearUsageLimitForChat(TARGET);
    });
    expect(results.a?.pending).toBe(false);
    expect(results.a?.error).toBeNull();
  });

  it('releases the lock without updating an unmounted composer', async () => {
    const send = deferred<void>();
    mockSendMessage.mockReturnValueOnce(send.promise);
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    render(<Probe name="a" target={TARGET} />);
    let pendingResume: Promise<void> | undefined;
    act(() => {
      pendingResume = results.a?.resume();
    });
    act(() => root.unmount());

    send.reject(new Error('dispatch failed'));
    await pendingResume;
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();

    // The lock was released: a new composer can continue the chat.
    root = createRoot(container);
    render(<Probe name="b" target={TARGET} />);
    expect(results.b?.busy).toBe(false);
    await resume('b');
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });
});
