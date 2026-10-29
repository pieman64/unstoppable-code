/**
 * @jest-environment jsdom
 */
// eslint-disable-next-line no-restricted-imports -- jsdom has no SubtleCrypto; long request IDs are hashed into keys.
import { webcrypto } from 'node:crypto';
// eslint-disable-next-line no-restricted-imports -- jsdom has no TextEncoder to feed the hash.
import { TextEncoder as NodeTextEncoder } from 'node:util';

Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: webcrypto,
});
Object.assign(globalThis, { TextEncoder: NodeTextEncoder });

const mockIsEnabled = jest.fn<boolean, [string]>();
const mockNavigate = jest.fn();
const mockSelectWorktree = jest.fn();
const mockOpenLedgerPanel = jest.fn<boolean, [string, string]>();
const mockSearchEntries = jest.fn();
const mockAddEntry = jest.fn();
const mockSelectEntry = jest.fn();
let mockDetail: unknown = null;
let mockSelectedWorktree: { projectId: string; worktreeId: string } | null =
  null;

jest.mock('@/stores/featureFlagsStore', () => ({
  useFeatureFlagsStore: {
    getState: (): unknown => ({
      isEnabled: (key: string): boolean => mockIsEnabled(key),
    }),
  },
}));
jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: (): unknown => ({
      selectedWorktree: mockSelectedWorktree,
      selectWorktree: mockSelectWorktree,
    }),
  },
}));
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: {
    getState: (): unknown => ({ navigate: mockNavigate }),
  },
}));
jest.mock('@/lib/cowork', () => ({
  isCoworkChatTarget: (projectId: string): boolean =>
    projectId.startsWith('cowork-'),
}));
jest.mock('@/lib/ledger/open-ledger-panel', () => ({
  openLedgerPanel: (projectId: string, worktreeId: string): boolean =>
    mockOpenLedgerPanel(projectId, worktreeId),
}));
jest.mock('@/lib/ledger/ledger-view-stores', () => ({
  desktopLedgerClient: {
    searchEntries: (request: unknown): unknown => mockSearchEntries(request),
    addEntry: (request: unknown): unknown => mockAddEntry(request),
  },
  ledgerViewStoreFor: (): unknown => ({
    getState: (): unknown => ({ select: mockSelectEntry, detail: mockDetail }),
  }),
}));

import type { LedgerActorRef } from '@canopy/protocol/canopy-core';
import {
  runLedgerAddEntryAction,
  runLedgerOpenAction,
  runLedgerSearchAction,
} from '../ledger-advisor-actions';

const CHAT: LedgerActorRef = {
  actorId: '00000000-0000-4000-8000-0000000000a1',
  kind: 'chat',
  authorityId: 'authority-1',
};
const ENTRY_ID = '00000000-0000-4000-8000-000000000101';

beforeEach(() => {
  jest.clearAllMocks();
  mockIsEnabled.mockReturnValue(true);
  mockSelectedWorktree = { projectId: 'project-1', worktreeId: 'wt-1' };
  mockOpenLedgerPanel.mockReturnValue(true);
  mockSelectEntry.mockResolvedValue(undefined);
  mockDetail = {
    status: 'ready',
    entryId: ENTRY_ID,
    view: {},
    problem: null,
    loadingMoreHistory: false,
  };
});

describe('App Advisor Ledger actions', () => {
  it('does nothing while the Ledger is off', async () => {
    mockIsEnabled.mockReturnValue(false);

    for (const outcome of [
      await runLedgerOpenAction({ type: 'ledger.open' }),
      await runLedgerSearchAction({ type: 'ledger.search' }),
      await runLedgerAddEntryAction(
        {
          type: 'ledger.add_entry',
          entryType: 'TASK',
          title: 'A',
          content: 'B',
        },
        'request-1',
      ),
    ]) {
      expect(outcome).toEqual({
        ok: false,
        error: {
          code: 'surface_unavailable',
          message: 'The Feed is not available.',
          retryable: false,
        },
      });
    }
    expect(mockSearchEntries).not.toHaveBeenCalled();
    expect(mockAddEntry).not.toHaveBeenCalled();
  });

  it('searches the selected work and names who wrote and owns each entry', async () => {
    mockSearchEntries.mockResolvedValue({
      status: 'ok',
      value: {
        entries: [
          {
            entryId: ENTRY_ID,
            revision: 1,
            type: 'TASK',
            title: 'Update parser recovery',
            content: 'Preserve incomplete events after reconnection.',
            highlights: [],
            referenceFiles: [],
            status: 'BLOCKED',
            owner: CHAT,
            author: CHAT,
            attributionKind: 'self_reported',
            createdAt: '2026-09-30T10:00:00.000Z',
            updatedAt: '2026-09-30T10:05:00.000Z',
            sourceAvailability: 'available',
          },
        ],
        nextCursor: null,
        hasMore: false,
        watermark: '3',
        actors: [
          { actorId: CHAT.actorId, kind: 'chat', displayName: 'Parser fixes' },
        ],
      },
    });

    const outcome = await runLedgerSearchAction({
      type: 'ledger.search',
      query: 'parser',
      statuses: ['BLOCKED'],
    });

    expect(mockSearchEntries).toHaveBeenCalledWith({
      scope: { projectId: 'project-1', worktreeId: 'wt-1' },
      params: {
        query: 'parser',
        statuses: ['BLOCKED'],
        sort: 'created_desc',
        limit: 20,
      },
    });
    expect(outcome).toEqual({
      ok: true,
      result: {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        hasMore: false,
        entries: [
          {
            entryId: ENTRY_ID,
            type: 'TASK',
            title: 'Update parser recovery',
            status: 'BLOCKED',
            author: 'Parser fixes',
            owner: 'Parser fixes',
            createdAt: '2026-09-30T10:00:00.000Z',
            updatedAt: '2026-09-30T10:05:00.000Z',
            excerpt: 'Preserve incomplete events after reconnection.',
          },
        ],
      },
    });
  });

  it('adds an entry the person owns, keyed by the advisor request', async () => {
    mockAddEntry.mockResolvedValue({
      status: 'ok',
      value: {
        entry: {
          entryId: ENTRY_ID,
          revision: 1,
          type: 'DECISION',
          title: 'Keep one writer',
          status: 'INFO',
        },
        changed: true,
        mutationId: null,
        localSequence: '1',
        syncState: 'local_only',
      },
    });

    const outcome = await runLedgerAddEntryAction(
      {
        type: 'ledger.add_entry',
        projectId: 'project-2',
        worktreeId: 'wt-2',
        entryType: 'DECISION',
        title: 'Keep one writer',
        content: 'Only the local core commits entries.',
        highlights: ['Single writer'],
      },
      'request-7',
    );

    expect(mockAddEntry).toHaveBeenCalledWith({
      scope: { projectId: 'project-2', worktreeId: 'wt-2' },
      requestKey: 'advisor:request-7',
      params: {
        type: 'DECISION',
        title: 'Keep one writer',
        content: 'Only the local core commits entries.',
        highlights: ['Single writer'],
        owner: 'self',
      },
    });
    expect(outcome).toMatchObject({
      ok: true,
      result: { entryId: ENTRY_ID, status: 'INFO', revision: 1 },
    });
  });

  it("reports the Ledger's refusal as the advisor's error", async () => {
    mockAddEntry.mockResolvedValue({
      status: 'error',
      reason: 'INVALID_INPUT',
      message: 'Title must be at most 100 characters.',
    });

    await expect(
      runLedgerAddEntryAction(
        {
          type: 'ledger.add_entry',
          entryType: 'TASK',
          title: 'x'.repeat(200),
          content: 'B',
        },
        'request-8',
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_payload',
        message: 'Title must be at most 100 characters.',
        retryable: false,
      },
    });
  });

  it('opens the selected work and selects an entry', async () => {
    const outcome = await runLedgerOpenAction({
      type: 'ledger.open',
      entryId: ENTRY_ID,
    });

    expect(mockNavigate).toHaveBeenCalledWith('main');
    expect(mockSelectWorktree).not.toHaveBeenCalled();
    expect(mockOpenLedgerPanel).toHaveBeenCalledWith('project-1', 'wt-1');
    expect(mockSelectEntry).toHaveBeenCalledWith(ENTRY_ID);
    expect(outcome).toEqual({
      ok: true,
      result: { projectId: 'project-1', worktreeId: 'wt-1', entryId: ENTRY_ID },
    });
  });

  it('reports an entry that is missing, or could not be read, instead of opening it', async () => {
    mockDetail = {
      status: 'problem',
      entryId: ENTRY_ID,
      view: null,
      problem: { kind: 'error', reason: 'NOT_FOUND', message: 'No entry.' },
      loadingMoreHistory: false,
    };
    await expect(
      runLedgerOpenAction({ type: 'ledger.open', entryId: ENTRY_ID }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'not_found',
        message: 'This work has no entry with that ID.',
        retryable: false,
      },
    });

    mockDetail = {
      status: 'problem',
      entryId: ENTRY_ID,
      view: null,
      problem: {
        kind: 'error',
        reason: 'STORAGE_UNAVAILABLE',
        message: 'Storage is busy.',
      },
      loadingMoreHistory: false,
    };
    await expect(
      runLedgerOpenAction({ type: 'ledger.open', entryId: ENTRY_ID }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'execution_failed',
        message: "The entry couldn't be read. Try again.",
        retryable: true,
      },
    });
  });

  it('scopes the request key by the originating chat (CAN-3976)', async () => {
    mockAddEntry.mockResolvedValue({
      status: 'error',
      reason: 'UNKNOWN',
      message: 'The reply was lost.',
    });
    const action = {
      type: 'ledger.add_entry',
      entryType: 'TASK',
      title: 'A',
      content: 'B',
    } as const;

    await runLedgerAddEntryAction(action, '1', 'chat-a');
    await runLedgerAddEntryAction(action, '1', 'chat-a');
    await runLedgerAddEntryAction(action, '1', 'chat-b');

    const keys = mockAddEntry.mock.calls.map(
      ([request]: [{ requestKey: string }]) => request.requestKey,
    );
    expect(keys[0]).toMatch(/^advisor:/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('keys every attempt of a long advisor request the same way', async () => {
    mockAddEntry.mockResolvedValue({
      status: 'error',
      reason: 'UNKNOWN',
      message: 'The reply was lost.',
    });
    const action = {
      type: 'ledger.add_entry',
      entryType: 'TASK',
      title: 'A',
      content: 'B',
    } as const;
    const longId = `toolu_${'7'.repeat(200)}`;

    await runLedgerAddEntryAction(action, longId);
    await runLedgerAddEntryAction(action, longId);
    await runLedgerAddEntryAction(action, `toolu_${'8'.repeat(200)}`);

    const keys = mockAddEntry.mock.calls.map(
      ([request]: [{ requestKey: string }]) => request.requestKey,
    );
    expect(keys[0]).toMatch(/^advisor-sha256:[0-9a-f]{64}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('selects another worktree first, but asks for a Cowork entry to be selected', async () => {
    await runLedgerOpenAction({
      type: 'ledger.open',
      projectId: 'project-2',
      worktreeId: 'wt-2',
    });
    expect(mockSelectWorktree).toHaveBeenCalledWith('project-2', 'wt-2');

    mockOpenLedgerPanel.mockClear();
    const cowork = await runLedgerOpenAction({
      type: 'ledger.open',
      projectId: 'cowork-1',
      worktreeId: 'entry-1',
    });
    expect(cowork).toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable', retryable: true },
    });
    expect(mockOpenLedgerPanel).not.toHaveBeenCalled();
  });
});
