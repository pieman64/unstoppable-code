/**
 * Characterization tests for the single shared sidebar badge-key derivation.
 * Both sidebar hosts (`WorktreeManager` and `useSidebarWorkspaces`) feed their
 * row indicators from this function, so the rules below are the contract that
 * keeps the two surfaces from drifting apart again.
 */
import { deriveChatBadgeKeys, type ChatBadgeKeySource } from '../chatBadgeKeys';

function source(
  overrides: Partial<ChatBadgeKeySource> = {},
): ChatBadgeKeySource {
  return {
    pendingPlanExits: {},
    pendingQuestions: {},
    pendingApprovals: {},
    worktreeChats: {},
    persistedWorktreeBadges: {},
    ...overrides,
  };
}

function streamingTab(id: string): { id: string; status: 'streaming' } {
  return { id, status: 'streaming' };
}

describe('deriveChatBadgeKeys', () => {
  it('reports a streaming tab as both streaming and an active session', () => {
    const keys = deriveChatBadgeKeys(
      source({
        worktreeChats: { 'p1/w1': { tabs: [streamingTab('c1')] } },
      }),
    );

    expect(keys.streaming).toBe('p1/w1');
    expect(keys.active).toBe('p1/w1');
    expect(keys.awaiting).toBe('');
    expect(keys.question).toBe('');
  });

  it('excludes chats blocked on a plan approval from streaming', () => {
    const keys = deriveChatBadgeKeys(
      source({
        pendingPlanExits: {
          r1: {
            requestId: 'r1',
            projectId: 'p1',
            worktreeId: 'w1',
            chatId: 'c1',
            source: 'claude',
            toolInput: {},
          },
        },
        worktreeChats: { 'p1/w1': { tabs: [streamingTab('c1')] } },
      }),
    );

    // The agent is not working: it is parked waiting for the user.
    expect(keys.streaming).toBe('');
    expect(keys.awaiting).toBe('p1/w1');
  });

  it('excludes chats blocked on an unanswered question from streaming', () => {
    const keys = deriveChatBadgeKeys(
      source({
        pendingQuestions: {
          r1: {
            requestId: 'r1',
            projectId: 'p1',
            worktreeId: 'w1',
            chatId: 'c1',
            questions: [],
          },
        },
        worktreeChats: { 'p1/w1': { tabs: [streamingTab('c1')] } },
      }),
    );

    expect(keys.streaming).toBe('');
    expect(keys.question).toBe('p1/w1');
  });

  it('treats an answered question as no longer waiting', () => {
    const keys = deriveChatBadgeKeys(
      source({
        pendingQuestions: {
          r1: {
            requestId: 'r1',
            projectId: 'p1',
            worktreeId: 'w1',
            chatId: 'c1',
            questions: [],
            answeredAt: 123,
          },
        },
        worktreeChats: { 'p1/w1': { tabs: [streamingTab('c1')] } },
      }),
    );

    expect(keys.question).toBe('');
    expect(keys.streaming).toBe('p1/w1');
  });

  it('carries a persisted plan approval for a worktree that has not hydrated', () => {
    // Cold start: the worktree's chats are not in the store yet, so the
    // persisted badge summary stands in for live tab state.
    const keys = deriveChatBadgeKeys(
      source({
        persistedWorktreeBadges: {
          'p1/w1': {
            version: 1,
            unreadChats: [],
            approvalChats: [{ chatId: 'c1' }],
            needsHydration: true,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
    );

    expect(keys.awaiting).toBe('p1/w1');
  });

  it('excludes chats blocked on a tool approval from streaming', () => {
    const keys = deriveChatBadgeKeys(
      source({
        pendingApprovals: {
          r1: {
            requestId: 'r1',
            projectId: 'p1',
            worktreeId: 'w1',
            chatId: 'c1',
            provider: 'claude',
            title: 'Run tests',
            details: { kind: 'command', command: 'npm test' },
          },
        },
        worktreeChats: { 'p1/w1': { tabs: [streamingTab('c1')] } },
      }),
    );

    // The agent is parked on the prompt, so the row must not read as healthy
    // working progress; the needs-input dot carries the state instead.
    expect(keys.streaming).toBe('');
    expect(keys.toolApproval).toBe('p1/w1');
  });

  it('keeps another chat in the same worktree streaming while one waits', () => {
    const keys = deriveChatBadgeKeys(
      source({
        pendingApprovals: {
          r1: {
            requestId: 'r1',
            projectId: 'p1',
            worktreeId: 'w1',
            chatId: 'c1',
            provider: 'claude',
            title: 'Run tests',
            details: { kind: 'command', command: 'npm test' },
          },
        },
        worktreeChats: {
          'p1/w1': { tabs: [streamingTab('c1'), streamingTab('c2')] },
        },
      }),
    );

    expect(keys.streaming).toBe('p1/w1');
    expect(keys.toolApproval).toBe('p1/w1');
  });

  it('sorts and de-duplicates each key list', () => {
    const keys = deriveChatBadgeKeys(
      source({
        pendingPlanExits: {
          r1: {
            requestId: 'r1',
            projectId: 'p2',
            worktreeId: 'w2',
            chatId: 'c2',
            source: 'claude',
            toolInput: {},
          },
        },
        worktreeChats: {
          'p2/w2': {
            tabs: [{ id: 'c2', status: 'idle', pendingPlanExit: {} }],
          },
          'p1/w1': { tabs: [streamingTab('c1')] },
        },
        persistedWorktreeBadges: {
          'p2/w2': {
            version: 1,
            unreadChats: [],
            approvalChats: [{ chatId: 'c2' }],
            needsHydration: true,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          'p0/w0': {
            version: 1,
            unreadChats: [],
            approvalChats: [{ chatId: 'c0' }],
            needsHydration: true,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
    );

    // `p2/w2` is reachable through three separate producers and still appears
    // once; the list is sorted so the joined string is a stable primitive.
    expect(keys.awaiting).toBe('p0/w0,p2/w2');
  });
});

describe('deriveChatBadgeKeys with live managed delegates', () => {
  function delegates(
    entries: Array<{
      projectId: string;
      worktreeId: string;
      chatId: string;
      live?: number;
      queued?: number;
    }>,
  ): Parameters<typeof deriveChatBadgeKeys>[1] {
    return Object.fromEntries(
      entries.map((entry) => [
        `${entry.projectId}/${entry.worktreeId}/${entry.chatId}`,
        { live: 1, queued: 0, ...entry },
      ]),
    );
  }

  it('shows an idle chat with live delegates as background work, and active', () => {
    const keys = deriveChatBadgeKeys(
      source({
        worktreeChats: {
          'p1/w1': { tabs: [{ id: 'c1', status: 'idle' }] },
        },
      }),
      delegates([{ projectId: 'p1', worktreeId: 'w1', chatId: 'c1' }]),
    );

    // A running turn draws the working spinner; delegates alone draw the
    // background one (turn-state D15).
    expect(keys.streaming).toBe('');
    expect(keys.background).toBe('p1/w1=1');
    // `active` drives `hasActiveSession`, which disables Archive and Delete.
    expect(keys.active).toBe('p1/w1');
  });

  it('covers worktrees and Work Entries that have not hydrated, and queued-only delegations', () => {
    const keys = deriveChatBadgeKeys(
      source(),
      delegates([
        { projectId: 'p2', worktreeId: 'w2', chatId: 'c1', live: 0, queued: 2 },
        { projectId: 'cowork', worktreeId: 'entry-1', chatId: 'c9' },
        { projectId: 'p3', worktreeId: 'w3', chatId: 'c3', live: 0 },
      ]),
    );

    expect(keys.streaming).toBe('');
    expect(keys.background).toBe('cowork/entry-1=1,p2/w2=2');
    expect(keys.active).toBe('cowork/entry-1,p2/w2');
  });

  it('keeps the approval and question suppression for a chat with live delegates', () => {
    const keys = deriveChatBadgeKeys(
      source({
        pendingApprovals: {
          r1: {
            requestId: 'r1',
            projectId: 'p1',
            worktreeId: 'w1',
            chatId: 'c1',
            provider: 'claude',
            title: 'Run tests',
            details: { kind: 'command', command: 'npm test' },
          },
        },
        pendingQuestions: {
          q1: {
            requestId: 'q1',
            projectId: 'p2',
            worktreeId: 'w2',
            chatId: 'c2',
            questions: [],
          },
        },
        worktreeChats: {
          'p3/w3': {
            tabs: [{ id: 'c3', status: 'idle', pendingPlanExit: {} }],
          },
        },
      }),
      delegates([
        { projectId: 'p1', worktreeId: 'w1', chatId: 'c1' },
        { projectId: 'p2', worktreeId: 'w2', chatId: 'c2' },
        { projectId: 'p3', worktreeId: 'w3', chatId: 'c3' },
      ]),
    );

    // A delegate approval surfaces as the root chat's pending approval; the
    // needs-input dot shows beside the background spinner.
    expect(keys.streaming).toBe('');
    expect(keys.background).toBe('p1/w1=1,p2/w2=1,p3/w3=1');
    // The live delegates still block Archive and Delete while waiting.
    expect(keys.active).toBe('p1/w1,p2/w2,p3/w3');
    expect(keys.toolApproval).toBe('p1/w1');
    expect(keys.question).toBe('p2/w2');
    expect(keys.awaiting).toBe('p3/w3');
  });

  it('does not duplicate a worktree that is also streaming', () => {
    const keys = deriveChatBadgeKeys(
      source({
        worktreeChats: { 'p1/w1': { tabs: [streamingTab('c1')] } },
      }),
      delegates([{ projectId: 'p1', worktreeId: 'w1', chatId: 'c2' }]),
    );

    expect(keys.streaming).toBe('p1/w1');
    expect(keys.background).toBe('p1/w1=1');
    expect(keys.active).toBe('p1/w1');
  });
});

describe('deriveChatBadgeKeys with live provider background tasks', () => {
  function liveTasks(
    entries: Array<{
      projectId: string;
      worktreeId: string;
      chatId: string;
      taskTypes: Array<string | undefined>;
    }>,
  ): Parameters<typeof deriveChatBadgeKeys>[2] {
    return Object.fromEntries(
      entries.map((entry) => [
        `${entry.projectId}/${entry.worktreeId}/${entry.chatId}`,
        {
          projectId: entry.projectId,
          worktreeId: entry.worktreeId,
          chatId: entry.chatId,
          liveTasks: entry.taskTypes.map((taskType, index) => ({
            taskId: `t${index}`,
            ...(taskType === undefined ? {} : { taskType }),
          })),
        },
      ]),
    );
  }

  it('marks provider agents and workflows active and background, without a working spinner', () => {
    const keys = deriveChatBadgeKeys(
      source({
        worktreeChats: { 'p1/w1': { tabs: [{ id: 'c1', status: 'idle' }] } },
      }),
      {},
      liveTasks([
        {
          projectId: 'p1',
          worktreeId: 'w1',
          chatId: 'c1',
          taskTypes: ['local_agent'],
        },
        // Not hydrated: the mirror still blocks removal.
        {
          projectId: 'cowork',
          worktreeId: 'entry-1',
          chatId: 'c9',
          taskTypes: ['local_bash', 'local_workflow'],
        },
      ]),
    );

    // `active` drives `hasActiveSession`, which disables Archive and Delete.
    expect(keys.active).toBe('cowork/entry-1,p1/w1');
    expect(keys.streaming).toBe('');
    expect(keys.background).toBe('cowork/entry-1=2,p1/w1=1');
  });

  it('counts shells, MCP tasks and untyped tasks as background work without blocking close', () => {
    const keys = deriveChatBadgeKeys(
      source(),
      {},
      liveTasks([
        {
          projectId: 'p1',
          worktreeId: 'w1',
          chatId: 'c1',
          taskTypes: ['local_bash', 'mcp_task', undefined],
        },
      ]),
    );

    expect(keys.active).toBe('');
    expect(keys.streaming).toBe('');
    expect(keys.background).toBe('p1/w1=3');
  });

  it('keeps a worktree active while a chat waits on the user', () => {
    const keys = deriveChatBadgeKeys(
      source({
        pendingQuestions: {
          q1: {
            requestId: 'q1',
            projectId: 'p2',
            worktreeId: 'w2',
            chatId: 'c2',
            questions: [],
          },
        },
      }),
      {},
      liveTasks([
        {
          projectId: 'p2',
          worktreeId: 'w2',
          chatId: 'c2',
          taskTypes: ['remote_agent'],
        },
      ]),
    );

    expect(keys.active).toBe('p2/w2');
    expect(keys.question).toBe('p2/w2');
    expect(keys.streaming).toBe('');
  });
});
