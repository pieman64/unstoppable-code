import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ApprovalRequestEvent } from '@canopy/desktop-shared/types';
import type { ChatState } from '../../state';
import { createApprovalsSlice } from '../approvals';

jest.mock('../../surface', () => ({
  canReceiveWorktreeChatActivity: (): boolean => true,
  isSyntheticChatTarget: (): boolean => false,
}));
jest.mock('../../hydration', () => ({
  ensureHydratedAndReplayPendingEvents: jest.fn(),
  hydratedKeys: new Set<string>(),
  recordWorktreeChatTouch: jest.fn(),
  pendingEagerChatCreation: new Map<string, unknown>(),
}));
jest.mock('../../utils', () => ({
  worktreeKey: (projectId: string, worktreeId: string): string =>
    `${projectId}/${worktreeId}`,
}));
jest.mock('../../event-transforms', () => ({
  pauseOpenTurnTimer: (messages: unknown): unknown => messages,
  resumePausedTurnTimer: (messages: unknown): unknown => messages,
}));
jest.mock('../../approval-defaults', () => ({
  approvalDefaultCacheKey: (): string => 'key',
  getApprovalDefaultsGeneration: (): number => 0,
}));
jest.mock('../../pending-tab-creation', () => ({
  pendingTabCreation: new Map<string, unknown>(),
}));
jest.mock('@canopy/desktop-instrumentation/client', () => ({
  reportClientAppError: jest.fn(),
}));

const CARD: ApprovalRequestEvent = {
  requestId: 'req-1',
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
  provider: 'claude',
  title: 'Run ls',
  details: { kind: 'tool', toolName: 'Bash' },
  policyRevision: 3,
};

const mockApprovals = {
  respond: jest.fn<Promise<boolean>, [unknown]>(),
  dismiss: jest.fn<Promise<boolean>, [unknown]>(),
  pendingRequests: jest.fn<Promise<ApprovalRequestEvent[]>, []>(),
};

function store(): StoreApi<ChatState> {
  const created = createStore<ChatState>()((set, get, api) => ({
    ...({ worktreeChats: {} } as unknown as ChatState),
    ...createApprovalsSlice(set, get, api),
  }));
  created.setState({ pendingApprovals: { [CARD.requestId]: CARD } });
  return created;
}

beforeAll(() => {
  Object.assign(globalThis, { window: { api: { approvals: mockApprovals } } });
});

beforeEach(() => {
  mockApprovals.respond.mockReset();
  mockApprovals.dismiss.mockReset();
  mockApprovals.pendingRequests.mockReset();
});

describe('approval answers refused by the broker', () => {
  it('a refused answer keeps a live card with its new revision', async () => {
    const chat = store();
    mockApprovals.respond.mockResolvedValue(false);
    mockApprovals.pendingRequests.mockResolvedValue([
      { ...CARD, policyRevision: 4 },
    ]);

    await chat
      .getState()
      .respondToApproval(CARD.requestId, { behavior: 'allow', scope: 'once' });

    expect(mockApprovals.respond).toHaveBeenCalledWith(
      expect.objectContaining({ policyRevision: 3 }),
    );
    expect(chat.getState().pendingApprovals[CARD.requestId]).toEqual({
      ...CARD,
      policyRevision: 4,
    });
  });

  it('a card cancelled while its refresh is in flight stays removed', async () => {
    const chat = store();
    mockApprovals.respond.mockResolvedValue(false);
    let release: (events: ApprovalRequestEvent[]) => void = () => undefined;
    mockApprovals.pendingRequests.mockReturnValue(
      new Promise<ApprovalRequestEvent[]>((resolve) => {
        release = resolve;
      }),
    );

    const responding = chat
      .getState()
      .respondToApproval(CARD.requestId, { behavior: 'allow', scope: 'once' });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    chat.getState().handleApprovalCancelled(CARD.requestId);
    release([{ ...CARD, policyRevision: 4 }]);
    await responding;

    expect(chat.getState().pendingApprovals[CARD.requestId]).toBeUndefined();
  });

  it('a refused answer for a settled request removes the card', async () => {
    const chat = store();
    mockApprovals.dismiss.mockResolvedValue(false);
    mockApprovals.pendingRequests.mockResolvedValue([]);

    await chat.getState().dismissApproval(CARD.requestId);

    expect(chat.getState().pendingApprovals[CARD.requestId]).toBeUndefined();
  });
});
