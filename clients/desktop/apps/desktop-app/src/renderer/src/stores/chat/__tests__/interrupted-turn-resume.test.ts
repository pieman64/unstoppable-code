/**
 * CAN-5177 — resume a chat the app closed on, from inside the chat.
 *
 * Covers the renderer half: main's `interruptedTurns` reaching the composer,
 * which interruption qualifies, the capability gate, session-only dismissal,
 * and a single-flight resume bound to the chat and turn the user saw.
 */
import type {
  PersistedChatTab,
  ResumeUsageLimitedChatsRequest,
  ResumeUsageLimitedChatsResponse,
} from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import type * as ChatStoreModule from '../../chatStore';
import type * as AiCreditsBannerStoreModule from '../../aiCreditsBannerStore';
import type * as ResumeModule from '../interrupted-turn-resume';
import type * as PersistedTabsModule from '../persisted-tabs';
import type * as CanonicalChangesModule from '../canonical-changes';
import type * as ComposerTypesModule from '../../../components/chat/types';
import type { ChatTab } from '../types';

jest.mock('../../../lib/claude-tui-chats', () => ({
  ...jest.requireActual<object>('../../../lib/claude-tui-chats'),
  // Terminal chats are flag-gated; treat the flag as on.
  getEffectiveClaudeChatInterfaceMode: (mode: string | undefined): string =>
    mode ?? 'canopy',
}));

const resumeMock = jest.fn<
  Promise<ResumeUsageLimitedChatsResponse>,
  [ResumeUsageLimitedChatsRequest]
>();
const noop = jest.fn();

const TARGET = { projectId: 'proj', worktreeId: 'wt', chatId: 'chat' };
const OTHER = { projectId: 'proj', worktreeId: 'wt', chatId: 'other' };
const ENABLED = { chatWorkflows: { interruptedTurnResume: true } };

function load(): {
  chat: typeof ChatStoreModule;
  resume: typeof ResumeModule;
} {
  jest.resetModules();
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      location: { search: '' },
      api: {
        resumeUsageLimitedChats: resumeMock,
        chat: {
          loadTabs: jest
            .fn()
            .mockResolvedValue({ version: 1, tabs: [], activeTabId: '' }),
          saveTabs: jest.fn().mockResolvedValue(undefined),
          activeSessions: jest
            .fn()
            .mockResolvedValue({ activeChatIds: [], sessions: [] }),
        },
        getDiffStatsBatch: jest.fn().mockResolvedValue([]),
        github: {
          setForegroundWorktree: noop,
          requestFastRefresh: noop,
          requestKnownPrFastRefresh: jest.fn().mockResolvedValue(false),
        },
        savePreferences: noop,
        loadPreferences: jest.fn().mockResolvedValue({}),
      },
    },
  });
  return {
    chat: jest.requireActual<typeof ChatStoreModule>('../../chatStore'),
    resume: jest.requireActual<typeof ResumeModule>(
      '../interrupted-turn-resume',
    ),
  };
}

function makeTab(over: Partial<ChatTab> = {}): ChatTab {
  return {
    id: 'chat',
    title: 'Chat',
    messages: [
      {
        id: 'user-1',
        role: 'user',
        blocks: [{ type: 'text', text: 'do the thing' }],
        timestamp: 900,
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Working on it' }],
        timestamp: 950,
      },
    ],
    status: 'idle',
    error: null,
    createdAt: '2026-10-28T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
    providerType: 'claude',
    interruptedTurns: { 'user-1': {} },
    ...over,
  };
}

function seed(
  useChatStore: typeof ChatStoreModule.useChatStore,
  tabs: ChatTab[],
): void {
  useChatStore.setState({
    selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
    worktreeChats: { 'proj/wt': { activeTabId: tabs[0]?.id ?? '', tabs } },
  });
}

function sessionOf(
  resume: typeof ResumeModule,
  target: typeof TARGET,
  userMessageId = 'user-1',
): ResumeModule.InterruptedTurnResumeSession | undefined {
  return resume.useInterruptedTurnResumeStore.getState().sessions[
    resume.interruptedTurnResumeKey(target, userMessageId)
  ];
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('interrupted-turn resume (CAN-5177)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('projection', () => {
    function persisted(over: Partial<PersistedChatTab> = {}): PersistedChatTab {
      return {
        id: 'chat',
        title: 'Chat',
        createdAt: '2026-10-28T00:00:00.000Z',
        messages: [
          {
            id: 'user-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'do the thing' }],
            timestamp: 900,
          },
        ],
        interruptedTurns: { 'user-1': {} },
        ...over,
      };
    }

    it('hydrates main-owned interruptions but never writes them back', () => {
      load();
      const { fromPersistedTab, toPersistedTab } =
        jest.requireActual<typeof PersistedTabsModule>('../persisted-tabs');
      const tab = fromPersistedTab(persisted());
      expect(tab.interruptedTurns).toEqual({ 'user-1': {} });
      expect(toPersistedTab(tab)).not.toHaveProperty('interruptedTurns');
    });

    it.each([
      ['resumed', { 'user-1': { resumedBy: 'resume-1' } }],
      ['abandoned', { 'user-1': { abandoned: true as const } }],
      ['removed', null],
    ])('retires the offer once main reports it %s', (_label, patch) => {
      load();
      const { fromPersistedTab } =
        jest.requireActual<typeof PersistedTabsModule>('../persisted-tabs');
      const { applyCanonicalChanges } = jest.requireActual<
        typeof CanonicalChangesModule
      >('../canonical-changes');
      const { presentableInterruptedTurnResume } = jest.requireActual<
        typeof ResumeModule
      >('../interrupted-turn-resume');
      const projection = {
        chatState: {
          tabs: [fromPersistedTab(persisted())],
          activeTabId: 'chat',
        },
        archives: [],
        runtimeByChatId: {},
        pendingQuestions: {},
      };
      const tab = projection.chatState.tabs[0];
      expect(tab && presentableInterruptedTurnResume(tab)).toEqual({
        userMessageId: 'user-1',
        promptKind: 'resend_user_message',
      });
      const next = applyCanonicalChanges(
        projection,
        [
          {
            type: 'tab.metadata_patched',
            tabId: 'chat',
            patch: { interruptedTurns: patch },
          },
        ],
        { projectId: 'proj', worktreeId: 'wt' },
      );
      const patched = next.chatState.tabs[0];
      expect(patched && presentableInterruptedTurnResume(patched)).toBe(
        undefined,
      );
    });
  });

  describe('eligibility', () => {
    it('offers only the latest turn and describes what Resume sends', () => {
      const { resume } = load();
      expect(resume.presentableInterruptedTurnResume(makeTab())).toEqual({
        userMessageId: 'user-1',
        promptKind: 'continue',
      });
      expect(
        resume.presentableInterruptedTurnResume(
          makeTab({ messages: makeTab().messages.slice(0, 1) }),
        ),
      ).toEqual({ userMessageId: 'user-1', promptKind: 'resend_user_message' });
      // An older open interruption never qualifies once a newer turn exists.
      expect(
        resume.presentableInterruptedTurnResume(
          makeTab({
            messages: [
              ...makeTab().messages,
              {
                id: 'user-2',
                role: 'user',
                blocks: [{ type: 'text', text: 'next' }],
                timestamp: 1000,
              },
            ],
            interruptedTurns: { 'user-1': {}, 'older-0': {} },
          }),
        ),
      ).toBeUndefined();
    });

    // Main keys the interruption by the root turn and resumes against the
    // latest root user turn, so the offer and its copy must anchor there too.
    it.each<[string, ChatTab['messages'][number]]>([
      [
        'a subagent prompt',
        {
          id: 'child-user',
          role: 'user',
          parentToolUseId: 'task-1',
          blocks: [{ type: 'text', text: 'subagent prompt' }],
          timestamp: 960,
        },
      ],
      [
        'a user-role tool result',
        {
          id: 'tool-result-user',
          role: 'user',
          blocks: [
            {
              type: 'tool_result',
              toolUseId: 'tool-1',
              toolName: 'Bash',
              output: 'done',
              isError: false,
            },
          ],
          timestamp: 960,
        },
      ],
    ])('anchors on the root turn when %s follows it', (_label, trailing) => {
      const { resume } = load();
      expect(
        resume.presentableInterruptedTurnResume(
          makeTab({ messages: [...makeTab().messages, trailing] }),
        ),
      ).toEqual({ userMessageId: 'user-1', promptKind: 'continue' });
      expect(
        resume.presentableInterruptedTurnResume(
          makeTab({ messages: [...makeTab().messages.slice(0, 1), trailing] }),
        ),
      ).toEqual({
        userMessageId: 'user-1',
        promptKind:
          trailing.parentToolUseId !== undefined
            ? 'resend_user_message'
            : 'continue',
      });
    });

    it.each<[string, Partial<ChatTab>]>([
      ['streaming', { status: 'streaming' }],
      ['pending turn', { pendingTurn: { userMessageId: 'user-1' } as never }],
      [
        'queued work',
        { queuedMessages: [{ text: 'later' }] as ChatTab['queuedMessages'] },
      ],
      ['editing a queued message', { editingQueuedMessageIndex: 0 }],
      ['running in a terminal', { interfaceMode: 'claude-code' }],
      ['history not loaded', { transcriptLoaded: false }],
      ['stale history', { transcriptStale: true }],
      ['file tab', { kind: 'file' }],
      ['read-only chat', { readOnly: true }],
      [
        'pending user echo',
        { pendingUserMessages: makeTab().messages.slice(0, 1) },
      ],
      [
        'incomplete interrupted turn',
        {
          transcriptWindow: {
            totalMessages: 12,
            transcriptRevision: 1,
            view: 'turns',
            turns: [
              {
                id: 'user-1',
                start: 0,
                end: 12,
                complete: true,
                before: 10,
                summary: {
                  messages: 12,
                  thinking: 0,
                  bash: 0,
                  read: 0,
                  readLines: 0,
                  writeEdit: 0,
                  plan: 0,
                  fileEdit: 0,
                  fileAdd: 0,
                  fileDelete: 0,
                  search: 0,
                  grep: 0,
                  web: 0,
                  agent: 0,
                  workflow: 0,
                  tasks: 0,
                  taskStop: 0,
                  monitor: 0,
                  skills: 0,
                  scheduleWakeup: 0,
                  askUser: 0,
                  scriptOutput: 0,
                  watcher: 0,
                  canopy: 0,
                  graph: 0,
                  appAdvisor: 0,
                  pipelineEditor: 0,
                  computerUse: 0,
                  claude: 0,
                  mcp: 0,
                  other: 0,
                },
                finalMessageIds: [],
              },
            ],
          },
        },
      ],
      [
        'already resumed',
        { interruptedTurns: { 'user-1': { resumedBy: 'r' } } },
      ],
      ['abandoned', { interruptedTurns: { 'user-1': { abandoned: true } } }],
    ])('withholds the offer while %s', (_label, over) => {
      const { resume } = load();
      expect(
        resume.presentableInterruptedTurnResume(makeTab(over)),
      ).toBeUndefined();
    });

    it.each<[string, object, boolean]>([
      ['enabled', ENABLED, true],
      ['disabled', { chatWorkflows: { interruptedTurnResume: false } }, false],
      ['missing', { chatWorkflows: {} }, false],
      ['unconfigured', {}, false],
    ])('gates the offer on the capability (%s)', (_label, caps, shown) => {
      const { resume } = load();
      expect(
        resume.shouldShowInterruptedTurnResume({
          capabilities: caps,
          target: TARGET,
          userMessageId: 'user-1',
          session: undefined,
          usageLimitBannerVisible: false,
        }),
      ).toBe(shown);
    });

    it('defers to the usage-limit banner, built-in chats, and session state', () => {
      const { resume } = load();
      const base = {
        capabilities: ENABLED,
        target: TARGET,
        userMessageId: 'user-1',
        session: undefined,
        usageLimitBannerVisible: false,
      };
      expect(
        resume.shouldShowInterruptedTurnResume({
          ...base,
          usageLimitBannerVisible: true,
        }),
      ).toBe(false);
      expect(
        resume.shouldShowInterruptedTurnResume({
          ...base,
          target: { ...TARGET, projectId: APP_ADVISOR_PROJECT_ID },
        }),
      ).toBe(false);
      expect(
        resume.shouldShowInterruptedTurnResume({
          ...base,
          session: { dismissed: true },
        }),
      ).toBe(false);
      expect(
        resume.shouldShowInterruptedTurnResume({
          ...base,
          session: { phase: 'accepted' },
        }),
      ).toBe(false);
      expect(
        resume.shouldShowInterruptedTurnResume({
          ...base,
          session: { phase: 'resuming' },
        }),
      ).toBe(true);
    });

    it('offers an unfinished turn when all of its transcript rows are loaded', () => {
      const { resume } = load();
      expect(
        resume.presentableInterruptedTurnResume(
          makeTab({
            messages: makeTab().messages.slice(0, 1),
            transcriptWindow: {
              totalMessages: 1,
              transcriptRevision: 1,
              view: 'turns',
              turns: [
                {
                  id: 'user-1',
                  start: 0,
                  end: 1,
                  complete: false,
                  summary: {
                    messages: 1,
                    thinking: 0,
                    bash: 0,
                    read: 0,
                    readLines: 0,
                    writeEdit: 0,
                    plan: 0,
                    fileEdit: 0,
                    fileAdd: 0,
                    fileDelete: 0,
                    search: 0,
                    grep: 0,
                    web: 0,
                    agent: 0,
                    workflow: 0,
                    tasks: 0,
                    taskStop: 0,
                    monitor: 0,
                    skills: 0,
                    scheduleWakeup: 0,
                    askUser: 0,
                    scriptOutput: 0,
                    watcher: 0,
                    canopy: 0,
                    graph: 0,
                    appAdvisor: 0,
                    pipelineEditor: 0,
                    computerUse: 0,
                    claude: 0,
                    mcp: 0,
                    other: 0,
                  },
                  finalMessageIds: [],
                },
              ],
            },
          }),
        ),
      ).toEqual({ userMessageId: 'user-1', promptKind: 'resend_user_message' });
    });

    it('keeps an overlapping stopped-turn action suppressed after resume acceptance', () => {
      const { resume } = load();
      expect(
        resume.shouldShowStoppedTurnResume({
          stoppedUserMessageId: 'user-1',
          interruptedUserMessageId: 'user-1',
          interruptedSession: { phase: 'accepted' },
          interruptedNoticeVisible: false,
          usageLimitBannerVisible: false,
        }),
      ).toBe(false);
      expect(
        resume.shouldShowStoppedTurnResume({
          stoppedUserMessageId: 'user-1',
          interruptedUserMessageId: undefined,
          interruptedSession: undefined,
          interruptedNoticeVisible: false,
          usageLimitBannerVisible: true,
        }),
      ).toBe(false);
      expect(
        resume.shouldShowStoppedTurnResume({
          stoppedUserMessageId: 'user-2',
          interruptedUserMessageId: 'user-1',
          interruptedSession: { phase: 'accepted' },
          interruptedNoticeVisible: false,
          usageLimitBannerVisible: false,
        }),
      ).toBe(true);
    });

    it('reaches the composer as flat fields', () => {
      load();
      const { toActiveComposerView } = jest.requireActual<
        typeof ComposerTypesModule
      >('../../../components/chat/types');
      const view = toActiveComposerView(makeTab());
      expect(view.interruptedTurnResumeUserMessageId).toBe('user-1');
      expect(view.interruptedTurnResumePromptKind).toBe('continue');
      expect(
        toActiveComposerView(makeTab({ interruptedTurns: {} }))
          .interruptedTurnResumeUserMessageId,
      ).toBeUndefined();
    });
  });

  describe('resume', () => {
    it('dispatches once for two synchronous presses and stays hidden after acceptance', async () => {
      const { chat, resume } = load();
      seed(chat.useChatStore, [makeTab()]);
      const reply = deferred<ResumeUsageLimitedChatsResponse>();
      resumeMock.mockReturnValueOnce(reply.promise);

      const first = resume.resumeInterruptedTurn(TARGET, 'user-1', ENABLED);
      const second = resume.resumeInterruptedTurn(TARGET, 'user-1', ENABLED);
      expect(resumeMock).toHaveBeenCalledTimes(1);
      expect(resumeMock).toHaveBeenCalledWith({ targets: [TARGET] });
      expect(sessionOf(resume, TARGET)).toEqual({ phase: 'resuming' });
      // Dismiss cannot race the request.
      resume.dismissInterruptedTurnResume(TARGET, 'user-1');
      expect(sessionOf(resume, TARGET)?.dismissed).toBeUndefined();

      reply.resolve({ resumedCount: 1, failedTargets: [] });
      await Promise.all([first, second]);
      expect(sessionOf(resume, TARGET)).toEqual({ phase: 'accepted' });

      // Canonical state has not resolved the turn yet; no second dispatch.
      await resume.resumeInterruptedTurn(TARGET, 'user-1', ENABLED);
      expect(resumeMock).toHaveBeenCalledTimes(1);
    });

    it.each<[string, () => void]>([
      [
        'a rejected target',
        (): void => {
          resumeMock.mockResolvedValueOnce({
            resumedCount: 0,
            failedTargets: [TARGET],
          });
        },
      ],
      [
        'a zero-resume reply',
        (): void => {
          resumeMock.mockResolvedValueOnce({
            resumedCount: 0,
            failedTargets: [],
          });
        },
      ],
      [
        'a thrown error',
        (): void => {
          resumeMock.mockRejectedValueOnce(new Error('ipc down'));
        },
      ],
    ])('shows the failure after %s and retries', async (_label, arrange) => {
      const { chat, resume } = load();
      seed(chat.useChatStore, [makeTab()]);
      arrange();

      await resume.resumeInterruptedTurn(TARGET, 'user-1', ENABLED);
      expect(sessionOf(resume, TARGET)).toEqual({
        error: resume.INTERRUPTED_TURN_RESUME_FAILED_MESSAGE,
      });

      resumeMock.mockResolvedValueOnce({ resumedCount: 1, failedTargets: [] });
      await resume.resumeInterruptedTurn(TARGET, 'user-1', ENABLED);
      expect(resumeMock).toHaveBeenCalledTimes(2);
      expect(sessionOf(resume, TARGET)).toEqual({ phase: 'accepted' });
    });

    it('rechecks a usage-limit banner that appeared after the offer rendered', async () => {
      const { chat, resume } = load();
      seed(chat.useChatStore, [makeTab()]);
      const { useAiCreditsBannerStore } = jest.requireActual<
        typeof AiCreditsBannerStoreModule
      >('../../aiCreditsBannerStore');
      useAiCreditsBannerStore
        .getState()
        .setUsageLimit(TARGET, { provider: 'claude' });
      await resume.resumeInterruptedTurn(TARGET, 'user-1', ENABLED);
      expect(resumeMock).not.toHaveBeenCalled();
    });

    it('refuses a stale press, a denied capability, and a dismissed offer', async () => {
      const { chat, resume } = load();
      seed(chat.useChatStore, [
        makeTab({ interruptedTurns: { 'user-1': { resumedBy: 'elsewhere' } } }),
      ]);
      await resume.resumeInterruptedTurn(TARGET, 'user-1', ENABLED);

      seed(chat.useChatStore, [makeTab()]);
      await resume.resumeInterruptedTurn(TARGET, 'user-1', {});
      await resume.resumeInterruptedTurn(TARGET, 'user-1', {
        chatWorkflows: { interruptedTurnResume: false },
      });

      resume.dismissInterruptedTurnResume(TARGET, 'user-1');
      await resume.resumeInterruptedTurn(TARGET, 'user-1', ENABLED);
      expect(resumeMock).not.toHaveBeenCalled();
    });

    it('keeps a late reply on the chat and turn it was for', async () => {
      const { chat, resume } = load();
      seed(chat.useChatStore, [makeTab(), makeTab({ id: 'other' })]);
      const reply = deferred<ResumeUsageLimitedChatsResponse>();
      resumeMock.mockReturnValueOnce(reply.promise);

      const pending = resume.resumeInterruptedTurn(TARGET, 'user-1', ENABLED);
      // The user switches chats and the original tab goes away.
      seed(chat.useChatStore, [makeTab({ id: 'other' })]);
      reply.resolve({ resumedCount: 0, failedTargets: [TARGET] });
      await pending;

      expect(resumeMock).toHaveBeenCalledWith({ targets: [TARGET] });
      expect(sessionOf(resume, TARGET)).toBeUndefined();
      expect(sessionOf(resume, OTHER)).toBeUndefined();
      expect(
        chat.useChatStore.getState().worktreeChats['proj/wt']?.tabs,
      ).toEqual([expect.objectContaining({ id: 'other' })]);
    });

    it.each(['resolved', 'removed', 'replaced', 'new prompt'])(
      'retires session state and ignores a late failure after the interruption is %s',
      async (change) => {
        const { chat, resume } = load();
        seed(chat.useChatStore, [makeTab()]);
        const reply = deferred<ResumeUsageLimitedChatsResponse>();
        resumeMock.mockReturnValueOnce(reply.promise);
        const pending = resume.resumeInterruptedTurn(TARGET, 'user-1', ENABLED);
        const changed =
          change === 'removed'
            ? []
            : [
                makeTab({
                  interruptedTurns:
                    change === 'resolved'
                      ? { 'user-1': { resumedBy: 'elsewhere' } }
                      : change === 'replaced'
                        ? { 'user-2': {} }
                        : { 'user-1': {} },
                  ...(change === 'new prompt'
                    ? {
                        messages: [
                          ...makeTab().messages,
                          {
                            id: 'new-user',
                            role: 'user',
                            blocks: [{ type: 'text', text: 'next' }],
                            timestamp: 2000,
                          },
                        ],
                      }
                    : {}),
                }),
              ];
        seed(chat.useChatStore, changed);
        expect(sessionOf(resume, TARGET)).toBeUndefined();
        reply.resolve({ resumedCount: 0, failedTargets: [TARGET] });
        await pending;
        expect(sessionOf(resume, TARGET)).toBeUndefined();
      },
    );

    it('keeps the chat claimed while an obsolete request is pending', async () => {
      const { chat, resume } = load();
      seed(chat.useChatStore, [makeTab()]);
      const reply = deferred<ResumeUsageLimitedChatsResponse>();
      resumeMock.mockReturnValueOnce(reply.promise);
      const pending = resume.resumeInterruptedTurn(TARGET, 'user-1', ENABLED);
      const next = makeTab({
        messages: [
          {
            id: 'user-2',
            role: 'user',
            blocks: [{ type: 'text', text: 'next' }],
            timestamp: 2000,
          },
        ],
        interruptedTurns: { 'user-2': {} },
      });
      seed(chat.useChatStore, [next]);
      await resume.resumeInterruptedTurn(TARGET, 'user-2', ENABLED);
      expect(resumeMock).toHaveBeenCalledTimes(1);
      reply.resolve({ resumedCount: 0, failedTargets: [TARGET] });
      await pending;
      resumeMock.mockResolvedValueOnce({ resumedCount: 1, failedTargets: [] });
      await resume.resumeInterruptedTurn(TARGET, 'user-2', ENABLED);
      expect(resumeMock).toHaveBeenCalledTimes(2);
      expect(sessionOf(resume, TARGET)).toBeUndefined();
      expect(sessionOf(resume, TARGET, 'user-2')).toEqual({
        phase: 'accepted',
      });
    });

    it('honors explicit target failure even when a response reports a resumed count', async () => {
      const { chat, resume } = load();
      seed(chat.useChatStore, [makeTab()]);
      resumeMock.mockResolvedValueOnce({
        resumedCount: 1,
        failedTargets: [TARGET],
      });
      await resume.resumeInterruptedTurn(TARGET, 'user-1', ENABLED);
      expect(sessionOf(resume, TARGET)).toEqual({
        error: resume.INTERRUPTED_TURN_RESUME_FAILED_MESSAGE,
      });
    });

    it('preserves dismissal across navigation and canonical refresh, then clears it on resolution', () => {
      const { chat, resume } = load();
      seed(chat.useChatStore, [makeTab()]);
      resume.dismissInterruptedTurnResume(TARGET, 'user-1');
      chat.useChatStore.setState({ selectedWorktree: null });
      seed(chat.useChatStore, [makeTab()]);
      expect(sessionOf(resume, TARGET)).toEqual({ dismissed: true });
      seed(chat.useChatStore, [makeTab({ interruptedTurns: {} })]);
      expect(sessionOf(resume, TARGET)).toBeUndefined();
      seed(chat.useChatStore, [makeTab()]);
      expect(sessionOf(resume, TARGET)).toBeUndefined();
    });

    it('dismisses one interruption for this session only', () => {
      const { chat, resume } = load();
      seed(chat.useChatStore, [makeTab(), makeTab({ id: 'other' })]);
      resume.dismissInterruptedTurnResume(TARGET, 'user-1');
      expect(sessionOf(resume, TARGET)).toEqual({ dismissed: true });
      expect(sessionOf(resume, OTHER)).toBeUndefined();
      expect(sessionOf(resume, TARGET, 'user-2')).toBeUndefined();
      expect(resumeMock).not.toHaveBeenCalled();

      // A renderer restart starts with nothing dismissed.
      const reloaded = load();
      expect(sessionOf(reloaded.resume, TARGET)).toBeUndefined();
    });
  });
});
