/**
 * @jest-environment jsdom
 *
 * CAN-1521 turn-level thumbs up/down store slice. The failure modes worth
 * pinning are all silent ones: a rejected upload quietly reverting the user's
 * click, and rehydration clobbering a rating that has not uploaded yet.
 */
import { useChatStore } from '@/stores/chatStore';
import type { ChatTab } from '../types';

const PROJECT_ID = 'proj-a';
const WORKTREE_ID = 'wt-a';
const CHAT_ID = 'chat-1';
const KEY = `${PROJECT_ID}/${WORKTREE_ID}`;
const TARGET = {
  projectId: PROJECT_ID,
  worktreeId: WORKTREE_ID,
  chatId: CHAT_ID,
};
const USER_MSG = 'msg-1-1700000000000';

function seedTab(): void {
  // Annotated as a full `ChatTab` rather than a `Partial` forced through
  // `as unknown as ...`: the repo forbids `as`, and the annotation makes the
  // compiler check the fixture against the real shape instead of silencing it.
  const tab: ChatTab = {
    id: CHAT_ID,
    kind: 'chat',
    title: 'Chat',
    messages: [],
    queuedMessages: [],
    providerType: 'claude',
    model: 'sonnet',
  };
  useChatStore.setState({
    worktreeChats: {
      [KEY]: {
        activeTabId: CHAT_ID,
        tabs: [tab],
      },
    },
  });
}

function readEntry(): ChatTab['turnFeedback'] extends undefined
  ? never
  : NonNullable<ChatTab['turnFeedback']>[string] | undefined {
  const tab = useChatStore
    .getState()
    .worktreeChats[KEY]?.tabs.find((candidate) => candidate.id === CHAT_ID);
  return tab?.turnFeedback?.[USER_MSG];
}

describe('turn feedback slice', () => {
  beforeEach(() => {
    seedTab();
  });

  afterEach(() => {
    useChatStore.setState({ worktreeChats: {} });
    Reflect.deleteProperty(window, 'api');
    jest.restoreAllMocks();
  });

  it('writes optimistically and settles to synced on ack', async () => {
    const rateTurnFeedback = jest
      .fn()
      .mockResolvedValue({ recorded: true, queued: false, feedbackId: 'fb-1' });
    Object.assign(window, { api: { rateTurnFeedback } });

    await useChatStore.getState().setTurnFeedback(USER_MSG, 'up', TARGET);

    expect(rateTurnFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        clientUserMessageId: USER_MSG,
        clientChatId: CHAT_ID,
        rating: 'up',
        provider: 'claude',
        model: 'sonnet',
        // Denormalized technical context: the row carries it so the warehouse
        // never has to join `transcript_turns`, which does not exist when
        // telemetry is disabled.
        eventType: 'worktree_chat',
        chatMode: 'canopy',
      }),
    );
    expect(readEntry()).toMatchObject({
      rating: 'up',
      syncState: 'synced',
      feedbackId: 'fb-1',
    });
  });

  it('names the rated work so main can attribute the rating to its owner', async () => {
    // CAN-3465: the rating belongs to whoever owns the work it was made in.
    // Main resolves that owner from the project and worktree; without them the
    // server would have to guess an organization, so the slice sends both.
    const rateTurnFeedback = jest
      .fn()
      .mockResolvedValue({ recorded: true, queued: false, feedbackId: 'fb-1' });
    Object.assign(window, { api: { rateTurnFeedback } });

    await useChatStore.getState().setTurnFeedback(USER_MSG, 'up', TARGET);

    expect(rateTurnFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        clientChatId: CHAT_ID,
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
      }),
    );
  });

  it('keeps the rating when the upload is rejected', async () => {
    // A `failed` entry MUST keep its rating: the main-process outbox retries
    // it, and silently reverting the thumb would read as a lost click.
    Object.assign(window, {
      api: {
        rateTurnFeedback: jest
          .fn()
          .mockResolvedValue({ recorded: false, queued: false }),
      },
    });

    await useChatStore.getState().setTurnFeedback(USER_MSG, 'down', TARGET);

    expect(readEntry()).toMatchObject({ rating: 'down', syncState: 'failed' });
  });

  it('treats a queued rating as recorded', async () => {
    Object.assign(window, {
      api: {
        rateTurnFeedback: jest
          .fn()
          .mockResolvedValue({ recorded: false, queued: true }),
      },
    });

    await useChatStore.getState().setTurnFeedback(USER_MSG, 'up', TARGET);

    expect(readEntry()).toMatchObject({ rating: 'up', syncState: 'synced' });
  });

  it('records the rating even with no preload bindings present', async () => {
    // The UI phase can land before the main-process phase; the optimistic
    // write must still happen so the thumb renders.
    await useChatStore.getState().setTurnFeedback(USER_MSG, 'up', TARGET);
    expect(readEntry()).toMatchObject({ rating: 'up', syncState: 'pending' });
  });

  it('retracts a cleared rating locally and on the server', async () => {
    // Clearing has to reach the server: `loadTurnFeedback` rehydrates on chat
    // open, so a local-only clear would come back on the next fetch and read
    // as the app un-doing the click.
    const rateTurnFeedback = jest
      .fn()
      .mockResolvedValue({ recorded: true, queued: false, feedbackId: 'fb-1' });
    const clearTurnFeedback = jest.fn().mockResolvedValue({ cleared: true });
    Object.assign(window, { api: { rateTurnFeedback, clearTurnFeedback } });

    await useChatStore.getState().setTurnFeedback(USER_MSG, 'up', TARGET);
    rateTurnFeedback.mockClear();
    await useChatStore.getState().setTurnFeedback(USER_MSG, null, TARGET);

    expect(readEntry()).toBeUndefined();
    expect(rateTurnFeedback).not.toHaveBeenCalled();
    expect(clearTurnFeedback).toHaveBeenCalledWith({
      clientUserMessageId: USER_MSG,
      feedbackId: 'fb-1',
    });
  });

  it('clears without a feedbackId when the rating never reached the server', async () => {
    // Queued-offline ratings have no server row; the main handler still drops
    // the outbox entry so a retracted rating never uploads on the next flush.
    const clearTurnFeedback = jest.fn().mockResolvedValue({ cleared: true });
    Object.assign(window, {
      api: {
        rateTurnFeedback: jest
          .fn()
          .mockResolvedValue({ recorded: false, queued: true }),
        clearTurnFeedback,
      },
    });

    await useChatStore.getState().setTurnFeedback(USER_MSG, 'down', TARGET);
    await useChatStore.getState().setTurnFeedback(USER_MSG, null, TARGET);

    expect(readEntry()).toBeUndefined();
    expect(clearTurnFeedback).toHaveBeenCalledWith({
      clientUserMessageId: USER_MSG,
    });
  });

  it('clears local state even with no preload bindings present', async () => {
    await useChatStore.getState().setTurnFeedback(USER_MSG, 'up', TARGET);
    await useChatStore.getState().setTurnFeedback(USER_MSG, null, TARGET);
    expect(readEntry()).toBeUndefined();
  });

  it('never lets the detail step undo the rating, and no-ops without one', async () => {
    const submitTurnFeedbackDetail = jest
      .fn()
      .mockResolvedValue({ recorded: true, queued: false });
    Object.assign(window, {
      api: {
        rateTurnFeedback: jest
          .fn()
          .mockResolvedValue({ recorded: true, queued: false }),
        submitTurnFeedbackDetail,
      },
    });

    // Detail on an unrated turn is a no-op — skip can never create a row.
    await useChatStore
      .getState()
      .submitTurnFeedbackDetail(USER_MSG, { reason: 'got-stuck' }, TARGET);
    expect(submitTurnFeedbackDetail).not.toHaveBeenCalled();

    await useChatStore.getState().setTurnFeedback(USER_MSG, 'down', TARGET);
    await useChatStore
      .getState()
      .submitTurnFeedbackDetail(
        USER_MSG,
        { reason: 'broke-something', comment: 'it deleted my config' },
        TARGET,
      );

    expect(readEntry()).toMatchObject({
      rating: 'down',
      reason: 'broke-something',
      hasComment: true,
    });
    expect(submitTurnFeedbackDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        clientUserMessageId: USER_MSG,
        reason: 'broke-something',
        comment: 'it deleted my config',
      }),
    );
  });

  it('keeps a local pending entry over a conflicting server row', async () => {
    await useChatStore.getState().setTurnFeedback(USER_MSG, 'down', TARGET);
    expect(readEntry()).toMatchObject({ syncState: 'pending' });

    useChatStore.getState().mergeServerTurnFeedback(
      [
        {
          feedbackId: 'fb-server',
          clientUserMessageId: USER_MSG,
          rating: 'up',
          hasComment: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      TARGET,
    );

    // The un-uploaded local rating is newer intent than anything the server
    // knows about, so rehydration must not overwrite it.
    expect(readEntry()).toMatchObject({ rating: 'down', syncState: 'pending' });
  });

  it('rehydrates a chat from the server exactly once per session', async () => {
    // Rehydration is what makes a rating recorded on another device appear
    // here. The mount effect in `ChatContent` fires on every remount, so the
    // fetch must be de-duped rather than repeated per tab switch.
    const listTurnFeedback = jest.fn().mockResolvedValue({
      feedback: [
        {
          feedbackId: 'fb-server',
          clientUserMessageId: USER_MSG,
          rating: 'up',
          hasComment: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    Object.assign(window, { api: { listTurnFeedback } });

    await useChatStore.getState().loadTurnFeedback(TARGET);
    await useChatStore.getState().loadTurnFeedback(TARGET);

    expect(listTurnFeedback).toHaveBeenCalledTimes(1);
    expect(listTurnFeedback).toHaveBeenCalledWith({ clientChatId: CHAT_ID });
    expect(readEntry()).toMatchObject({
      rating: 'up',
      syncState: 'synced',
      feedbackId: 'fb-server',
    });
  });

  it('adopts server rows for turns with no local entry', () => {
    useChatStore.getState().mergeServerTurnFeedback(
      [
        {
          feedbackId: 'fb-server',
          clientUserMessageId: USER_MSG,
          rating: 'up',
          reason: 'other',
          hasComment: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      TARGET,
    );

    expect(readEntry()).toMatchObject({
      rating: 'up',
      syncState: 'synced',
      reason: 'other',
      hasComment: true,
      feedbackId: 'fb-server',
    });
  });
});
