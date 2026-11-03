/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  LedgerActorLabel,
  LedgerActorRef,
  LedgerEntry,
  LedgerEntrySearchItem,
  LedgerFileRef,
} from '@canopy/protocol/canopy-core';
import type { LedgerViewEntry } from '@canopy/protocol/ledger-view';
import {
  formatLedgerFullDateTime,
  type LedgerSourceAction,
} from '../../../lib/ledger-display';
import { REPLAY_BLOCK_CLASS } from '../../../lib/replay-privacy';
import {
  LedgerThreadList,
  LEDGER_THREAD_LIST_VIRTUALIZED_THRESHOLD,
  type LedgerThreadListProps,
} from '../LedgerThreadList';
import type { LedgerEntryRowDetails } from '../ledger-entry-attribution';
import type { LedgerEntrySlots, LedgerOpenEntry } from '../ledger-entry-slots';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const OPEN_CHAT: LedgerSourceAction = {
  label: 'Open chat',
  glyph: 'chat',
  tooltip: null,
};
const OPEN_RUN: LedgerSourceAction = {
  label: 'Open run',
  glyph: 'run',
  tooltip: null,
};

const CHAT: LedgerActorRef = {
  actorId: '00000000-0000-4000-8000-0000000000a1',
  kind: 'chat',
  authorityId: 'authority-1',
};
const USER: LedgerActorRef = {
  actorId: '00000000-0000-4000-8000-0000000000a2',
  kind: 'user',
  authorityId: 'authority-1',
};
const ACTORS: Readonly<Record<string, LedgerActorLabel>> = {
  [CHAT.actorId]: {
    actorId: CHAT.actorId,
    kind: 'chat',
    displayName: 'Parser fixes',
  },
  [USER.actorId]: { actorId: USER.actorId, kind: 'user', displayName: 'You' },
};
const LEDGER_ID = '00000000-0000-4000-8000-000000000001';
const ROOT_ID = '00000000-0000-4000-8000-000000000101';
const NOW = new Date('2026-09-30T12:00:00.000Z');
const ROOT_FILE: LedgerFileRef = {
  rootId: 'repo-1',
  path: 'src/parser.ts',
  startLine: 12,
};

function searchItem(
  overrides: Partial<LedgerEntrySearchItem> = {},
): LedgerEntrySearchItem {
  return {
    entryId: ROOT_ID,
    revision: 1,
    type: 'TASK',
    title: 'Update parser recovery',
    content:
      'Preserve **incomplete events** after reconnection.\n\nKeep the complete explanation visible.',
    highlights: ['Keeps partial events'],
    referenceFiles: [ROOT_FILE],
    status: 'IN_PROGRESS',
    owner: CHAT,
    author: CHAT,
    attributionKind: 'self_reported',
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T11:00:00.000Z',
    sourceAvailability: 'available',
    ...overrides,
  };
}

function fullEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  const details = {
    harness: 'claude',
    model: 'claude-sonnet',
    thinkingEffort: 'medium',
    mode: null,
    pipelineExecutionId: null,
    settingsRevision: null,
    unavailableReason: null,
  };
  return {
    schemaVersion: 1,
    entryId: ROOT_ID,
    scope: {
      ledgerId: LEDGER_ID,
      authorityId: 'authority-1',
      container: {
        kind: 'code_worktree',
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
      },
    },
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T11:00:00.000Z',
    revision: 2,
    author: CHAT,
    authorDetails: details,
    owner: USER,
    type: 'TASK',
    title: 'Update parser recovery',
    content: 'Preserve incomplete events.',
    highlights: ['Keeps partial events'],
    referenceFiles: [ROOT_FILE],
    status: 'IN_PROGRESS',
    origin: { kind: 'chat', ledgerId: LEDGER_ID, chatId: 'chat-1' },
    attribution: {
      kind: 'self_reported',
      effectiveActor: CHAT,
      recordedBy: CHAT,
      executorDetails: details,
    },
    ...overrides,
  };
}

function view(
  overrides: Partial<LedgerViewEntry> = {},
  entryOverrides: Partial<LedgerEntry> = {},
): LedgerViewEntry {
  const value = fullEntry(entryOverrides);
  return {
    entry: {
      entry: value,
      sourceAvailability: 'available',
      history: {
        mutations: [
          {
            mutationId: '00000000-0000-4000-8000-000000000201',
            entryId: value.entryId,
            kind: 'create',
            revision: 1,
            previousRevision: null,
            occurredAt: value.createdAt,
            status: { from: null, to: 'TODO' },
            attribution: value.attribution,
            invocationOrigin: value.origin,
          },
          {
            mutationId: '00000000-0000-4000-8000-000000000202',
            entryId: value.entryId,
            kind: 'update',
            revision: 2,
            previousRevision: 1,
            occurredAt: value.updatedAt,
            status: { from: 'TODO', to: 'IN_PROGRESS' },
            owner: { from: CHAT, to: USER },
            attribution: value.attribution,
            invocationOrigin: value.origin,
          },
        ],
        nextCursor: null,
      },
    },
    source: {
      availability: 'available',
      target: {
        kind: 'chat',
        projectId: 'project-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        archived: false,
      },
    },
    ...overrides,
  };
}

function openEntry(
  entryId: string,
  overrides: Partial<LedgerOpenEntry> = {},
  openView: LedgerViewEntry | null = view({}, { entryId }),
): LedgerOpenEntry {
  return { entryId, view: openView, ...overrides };
}

function listProps(
  overrides: Partial<LedgerThreadListProps> = {},
): LedgerThreadListProps {
  return {
    entries: [searchItem()],
    actors: ACTORS,
    density: 'page',
    now: NOW,
    openEntry: null,
    onToggleOpen: jest.fn(),
    onOpenFile: jest.fn(),
    hasMore: false,
    loadingMore: false,
    loadMoreError: null,
    onLoadMore: jest.fn(),
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function byTestId(testId: string): HTMLElement {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing ${testId}`);
  return element;
}

function render(props: LedgerThreadListProps): void {
  act(() => root.render(<LedgerThreadList {...props} />));
}

function threadRootIds(): string[] {
  return Array.from(
    container.querySelectorAll('[data-testid="ledger-entry-row"]'),
  ).flatMap((row) => {
    const entryId = row.getAttribute('data-entry-id');
    return entryId === null ? [] : [entryId];
  });
}

describe('LedgerThreadList rows and threads', () => {
  it('shows full Markdown, highlights, files, byline context and relative time in closed rows', () => {
    const fileClick = jest.fn();
    const contextItem = searchItem();
    const deviceItem = searchItem({
      entryId: '00000000-0000-4000-8000-000000000102',
      title: 'Recorded on another device',
    });
    const teammateItem = searchItem({
      entryId: '00000000-0000-4000-8000-000000000103',
      title: 'Recorded by a teammate',
      author: USER,
      owner: USER,
    });
    const details = (item: LedgerEntrySearchItem): LedgerEntryRowDetails => {
      if (item.entryId === deviceItem.entryId) {
        return { attribution: { kind: 'device', label: 'Studio Mac' } };
      }
      if (item.entryId === teammateItem.entryId) {
        return {
          attribution: {
            kind: 'teammate',
            name: 'Ada Lovelace',
            organization: 'Acme',
          },
        };
      }
      return { context: 'Parser fixes · TypeScript' };
    };
    render(
      listProps({
        entries: [contextItem, deviceItem, teammateItem],
        onOpenFile: fileClick,
        rowDetails: details,
      }),
    );

    const rows = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="ledger-entry-row"]',
      ),
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.dataset['entryId'])).toEqual([
      contextItem.entryId,
      deviceItem.entryId,
      teammateItem.entryId,
    ]);
    expect(rows.map((row) => row.dataset['origin'] ?? null)).toEqual([
      null,
      'device',
      'teammate',
    ]);
    expect(
      rows[0]?.querySelector('[data-testid="ledger-entry-row-content"]')
        ?.textContent,
    ).toContain('Keep the complete explanation visible.');
    expect(rows[0]?.textContent).toContain('Keeps partial events');
    expect(byTestId('ledger-entry-row-context').textContent).toBe(
      'Parser fixes · TypeScript',
    );
    expect(byTestId('ledger-entry-row-device').textContent).toBe('Studio Mac');
    expect(byTestId('ledger-entry-row-teammate').textContent).toBe('Acme');
    expect(rows[2]?.textContent).toContain('Ada Lovelace');
    expect(rows[0]?.textContent).toContain('2 h ago');
    expect(
      container.querySelector('[data-testid="ledger-entry-details"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="ledger-entry-activity"]'),
    ).toBeNull();

    const fileButton = rows[0]?.querySelector<HTMLButtonElement>(
      '[data-testid="ledger-entry-file-ref"]',
    );
    expect(fileButton).not.toBeNull();
    act(() => fileButton?.click());
    expect(fileClick).toHaveBeenCalledWith(contextItem, ROOT_FILE);
  });

  it('opens a root with details, merged oldest-first activity and replies, history and read states', () => {
    const item = searchItem();
    const reply = searchItem({
      entryId: '00000000-0000-4000-8000-000000000104',
      title: 'Correction title is not repeated',
      content: 'The original parser also keeps the final partial frame.',
      supersedesEntryId: item.entryId,
      createdAt: '2026-09-30T10:30:00.000Z',
      updatedAt: '2026-09-30T10:30:00.000Z',
      status: 'INFO',
      type: 'OBSERVATION',
    });
    const openedView = view(
      {},
      { entryId: item.entryId, updatedAt: '2026-09-30T10:15:00.000Z' },
    );
    const history = openedView.entry.history;
    const openRead = view(
      {
        entry: {
          ...openedView.entry,
          history:
            history === null ? null : { ...history, nextCursor: 'next-page' },
        },
      },
      { entryId: item.entryId, updatedAt: '2026-09-30T10:15:00.000Z' },
    );
    const onLoadMoreHistory = jest.fn();
    const onOpenSource = jest.fn();
    const slots: LedgerEntrySlots = {
      sourceAction: OPEN_RUN,
      onOpenSource,
      statusControl: (
        <button data-testid="status-control">Change status</button>
      ),
      ownerControl: <button data-testid="owner-control">Change owner</button>,
    };
    render(
      listProps({
        entries: [reply, item],
        openEntry: openEntry(item.entryId, {
          view: openRead,
          onLoadMoreHistory,
          notice: <p data-testid="open-notice">Saved.</p>,
          closedExplanation: (
            <p data-testid="closed-explanation">This is closed.</p>
          ),
          readState: <p data-testid="open-read-state">Read is ready.</p>,
          openError: 'Could not open the source.',
        }),
        entrySlots: (entryItem) =>
          entryItem.entryId === item.entryId ? slots : undefined,
      }),
    );

    const row = byTestId('ledger-entry-row');
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(byTestId('ledger-entry-details')).not.toBeNull();
    expect(byTestId('ledger-entry-detail-owner').textContent).toBe('You');
    expect(
      byTestId('ledger-entry-open-error').querySelector('[role="alert"]'),
    ).not.toBeNull();
    expect(byTestId('open-notice').textContent).toBe('Saved.');
    expect(byTestId('closed-explanation').textContent).toBe('This is closed.');
    expect(byTestId('open-read-state').textContent).toBe('Read is ready.');
    expect(byTestId('ledger-entry-history-more')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="status-control"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="owner-control"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="ledger-entry-source-open"]')
        ?.textContent,
    ).toContain('Open chat');
    expect(
      container.querySelector('[data-testid="ledger-entry-source-open"]')
        ?.textContent,
    ).not.toContain('Open run');
    expect(onOpenSource).not.toHaveBeenCalled();

    const timeline = row.querySelector('.border-l ul');
    expect(
      Array.from(timeline?.children ?? [], (child) => child.textContent),
    ).toEqual([
      expect.stringContaining('changed the status from To do to In progress'),
      expect.stringContaining(
        'The original parser also keeps the final partial frame.',
      ),
    ]);
    act(() => byTestId('ledger-entry-history-more').click());
    expect(onLoadMoreHistory).toHaveBeenCalledTimes(1);

    const onToggleOpen = jest.fn();
    render(
      listProps({
        entries: [reply, item],
        openEntry: openEntry(item.entryId, { view: openRead }),
        onToggleOpen,
      }),
    );
    act(() => byTestId('ledger-entry-row-title').click());
    expect(onToggleOpen).not.toHaveBeenCalled();
    act(() => byTestId('ledger-entry-details-toggle').click());
    expect(onToggleOpen).toHaveBeenCalledWith(null);
  });

  it('does not toggle from title, row background or file chip; details button toggles', () => {
    const onToggleOpen = jest.fn();
    render(listProps({ onToggleOpen }));
    const row = byTestId('ledger-entry-row');
    act(() => byTestId('ledger-entry-row-title').click());
    expect(onToggleOpen).not.toHaveBeenCalled();
    act(() => row.click());
    expect(onToggleOpen).not.toHaveBeenCalled();
    const file = byTestId('ledger-entry-file-ref');
    act(() => file.click());
    expect(onToggleOpen).not.toHaveBeenCalled();
    const title = byTestId('ledger-entry-row-title');
    expect(title.tagName).not.toBe('BUTTON');
    act(() => byTestId('ledger-entry-details-toggle').click());
    expect(onToggleOpen).toHaveBeenCalledWith(ROOT_ID);

    render(listProps({ onToggleOpen, openEntry: openEntry(ROOT_ID) }));
    act(() => byTestId('ledger-entry-row-title').click());
    expect(onToggleOpen).toHaveBeenCalledTimes(1);
    act(() => byTestId('ledger-entry-details-toggle').click());
    expect(onToggleOpen).toHaveBeenLastCalledWith(null);
  });

  it('shows details toggles on roots and replies with source, toggle, correction order', () => {
    const onToggleOpen = jest.fn();
    const onOpenSource = jest.fn();
    const rootSlots: LedgerEntrySlots = {
      sourceAction: OPEN_CHAT,
      onOpenSource,
      onAddCorrection: jest.fn(),
    };
    render(listProps({ entrySlots: () => rootSlots, onToggleOpen }));

    const source = byTestId('ledger-entry-source-open');
    const rootToggle = byTestId('ledger-entry-details-toggle');
    const correction = byTestId('ledger-entry-add-correction');
    expect(rootToggle.textContent).toBe('Show details');
    expect(rootToggle.getAttribute('aria-expanded')).toBe('false');
    expect(
      source.compareDocumentPosition(rootToggle) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      rootToggle.compareDocumentPosition(correction) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    act(() => rootToggle.click());
    expect(onToggleOpen).toHaveBeenLastCalledWith(ROOT_ID);

    render(
      listProps({
        entrySlots: () => rootSlots,
        onToggleOpen,
        openEntry: openEntry(ROOT_ID),
      }),
    );
    const openRootToggle = byTestId('ledger-entry-details-toggle');
    expect(openRootToggle.textContent).toBe('Hide details');
    expect(openRootToggle.getAttribute('aria-expanded')).toBe('true');
    const rootDetails = byTestId('ledger-entry-details');
    expect(
      openRootToggle.compareDocumentPosition(rootDetails) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    act(() => openRootToggle.click());
    expect(onToggleOpen).toHaveBeenLastCalledWith(null);

    const reply = searchItem({
      entryId: '00000000-0000-4000-8000-000000000109',
      supersedesEntryId: ROOT_ID,
      createdAt: '2026-09-30T10:30:00.000Z',
    });
    const replySlots: LedgerEntrySlots = {
      sourceAction: OPEN_CHAT,
      onOpenSource,
      onAddCorrection: jest.fn(),
    };
    render(
      listProps({
        entries: [reply, searchItem()],
        entrySlots: (item) =>
          item.entryId === reply.entryId ? replySlots : undefined,
        onToggleOpen,
      }),
    );
    const replyRow = container.querySelector<HTMLElement>(
      `[data-testid="ledger-entry-correction"][data-entry-id="${reply.entryId}"]`,
    );
    const replyToggle = replyRow?.querySelector<HTMLElement>(
      '[data-testid="ledger-entry-details-toggle"]',
    );
    const replySource = replyRow?.querySelector<HTMLElement>(
      '[data-testid="ledger-entry-source-open"]',
    );
    const replyCorrection = replyRow?.querySelector<HTMLElement>(
      '[data-testid="ledger-entry-add-correction"]',
    );
    expect(replyToggle?.textContent).toBe('Show details');
    expect(replyToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(replySource).not.toBeNull();
    expect(replyCorrection).not.toBeNull();
    if (
      replySource === null ||
      replySource === undefined ||
      replyToggle === null ||
      replyToggle === undefined ||
      replyCorrection === null ||
      replyCorrection === undefined
    ) {
      throw new Error('Expected reply actions');
    }
    expect(
      replySource.compareDocumentPosition(replyToggle) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      replyToggle.compareDocumentPosition(replyCorrection) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    act(() => replyToggle?.click());
    expect(onToggleOpen).toHaveBeenLastCalledWith(reply.entryId);

    render(
      listProps({
        entries: [reply, searchItem()],
        entrySlots: (item) =>
          item.entryId === reply.entryId ? replySlots : undefined,
        onToggleOpen,
        openEntry: openEntry(reply.entryId),
      }),
    );
    const openReply = container.querySelector<HTMLElement>(
      `[data-testid="ledger-entry-correction"][data-entry-id="${reply.entryId}"]`,
    );
    const openReplyToggle = openReply?.querySelector<HTMLElement>(
      '[data-testid="ledger-entry-details-toggle"]',
    );
    expect(openReplyToggle?.textContent).toBe('Hide details');
    expect(openReplyToggle?.getAttribute('aria-expanded')).toBe('true');
    const replyDetails = openReply?.querySelector(
      '[data-testid="ledger-entry-details"]',
    );
    expect(openReplyToggle).not.toBeNull();
    expect(replyDetails).not.toBeNull();
    if (
      openReplyToggle === null ||
      openReplyToggle === undefined ||
      replyDetails === null ||
      replyDetails === undefined
    ) {
      throw new Error('Expected reply details and toggle');
    }
    expect(
      openReplyToggle.compareDocumentPosition(replyDetails) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    act(() => openReplyToggle?.click());
    expect(onToggleOpen).toHaveBeenLastCalledWith(null);
  });

  it('keeps the details toggle when a row has no action slots', () => {
    render(listProps());
    expect(byTestId('ledger-entry-details-toggle').textContent).toBe(
      'Show details',
    );
  });

  it('omits the pending root title without hiding its other row content', () => {
    const item = searchItem({ titlePending: true });
    render(
      listProps({
        entries: [item],
        entrySlots: () => ({ onAddCorrection: jest.fn() }),
        rowDetails: () => ({ context: 'Parser fixes' }),
      }),
    );

    expect(
      container.querySelector('[data-testid="ledger-entry-row-title"]'),
    ).toBeNull();
    expect(byTestId('ledger-entry-row-content').textContent).toContain(
      'Preserve incomplete events',
    );
    expect(byTestId('ledger-entry-row-context').textContent).toBe(
      'Parser fixes',
    );
    expect(byTestId('ledger-entry-details-toggle').textContent).toBe(
      'Show details',
    );
    expect(byTestId('ledger-entry-add-correction')).not.toBeNull();
  });

  it('keeps read-only entries free of status and owner controls and replaces actions with the note', () => {
    const item = searchItem();
    const onAddCorrection = jest.fn();
    render(
      listProps({
        entrySlots: (): LedgerEntrySlots => ({
          statusControl: (
            <button data-testid="status-control">Change status</button>
          ),
          ownerControl: (
            <button data-testid="owner-control">Change owner</button>
          ),
          onAddCorrection,
          readOnlyNote: <span>Recorded on Studio Mac. Change it there.</span>,
        }),
      }),
    );
    expect(
      container.querySelector('[data-testid="status-control"]'),
    ).toBeNull();
    expect(container.querySelector('[data-testid="owner-control"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="ledger-entry-add-correction"]'),
    ).toBeNull();
    expect(byTestId('ledger-entry-read-only').textContent).toContain(
      'Recorded on Studio Mac. Change it there.',
    );
    expect(byTestId('ledger-entry-details-toggle').textContent).toBe(
      'Show details',
    );
    expect(
      container.querySelector('[data-testid="ledger-entry-row-status"]')
        ?.textContent,
    ).toBe('In progress');
    expect(item.title).toBe('Update parser recovery');
  });

  it('does not show an open source action when the read has no source target', () => {
    const item = searchItem();
    render(
      listProps({
        openEntry: openEntry(
          item.entryId,
          {},
          view(
            { source: { availability: 'not_on_this_device', target: null } },
            { entryId: item.entryId },
          ),
        ),
        entrySlots: (): LedgerEntrySlots => ({
          sourceAction: OPEN_RUN,
          onOpenSource: jest.fn(),
        }),
      }),
    );
    expect(
      container.querySelector('[data-testid="ledger-entry-source-open"]'),
    ).toBeNull();
  });

  it('shows history paging only when the open read has a cursor and a handler', () => {
    const item = searchItem();
    const withoutCursor = view({}, { entryId: item.entryId });
    render(
      listProps({
        openEntry: openEntry(
          item.entryId,
          { onLoadMoreHistory: jest.fn() },
          withoutCursor,
        ),
      }),
    );
    expect(
      container.querySelector('[data-testid="ledger-entry-history-more"]'),
    ).toBeNull();

    const hasCursor = view(
      {
        entry: {
          ...withoutCursor.entry,
          history:
            withoutCursor.entry.history === null
              ? null
              : { ...withoutCursor.entry.history, nextCursor: 'next-page' },
        },
      },
      { entryId: item.entryId },
    );
    render(listProps({ openEntry: openEntry(item.entryId, {}, hasCursor) }));
    expect(
      container.querySelector('[data-testid="ledger-entry-history-more"]'),
    ).toBeNull();
  });
});

describe('LedgerThreadList corrections', () => {
  it('nests corrections under their root, marks replies to replies, and shows reply status and sync', () => {
    const rootItem = searchItem();
    const correction = searchItem({
      entryId: '00000000-0000-4000-8000-000000000111',
      title: 'Not repeated in a reply',
      content: 'The correction belongs under the original.',
      supersedesEntryId: rootItem.entryId,
      status: 'COMPLETED',
      syncState: 'repair_needed',
      createdAt: '2026-09-30T10:30:00.000Z',
      updatedAt: '2026-09-30T10:30:00.000Z',
    });
    const nested = searchItem({
      entryId: '00000000-0000-4000-8000-000000000112',
      content: 'This reply corrects the correction.',
      supersedesEntryId: correction.entryId,
      status: 'INFO',
      type: 'OBSERVATION',
      createdAt: '2026-09-30T10:45:00.000Z',
      updatedAt: '2026-09-30T10:45:00.000Z',
    });
    render(listProps({ entries: [nested, correction, rootItem] }));

    expect(
      container.querySelectorAll('[data-testid="ledger-entry-row"]'),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-testid="ledger-entry-correction"]'),
    ).toHaveLength(2);
    expect(
      container.querySelectorAll(
        '[data-testid="ledger-entry-correction-target"]',
      ),
    ).toHaveLength(1);
    const nestedReply = container
      .querySelector('[data-testid="ledger-entry-correction-target"]')
      ?.closest('[data-testid="ledger-entry-correction"]');
    expect(nestedReply?.textContent).toContain('Corrects a reply');
    expect(
      nestedReply?.querySelector('[data-testid="ledger-entry-row-status"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="ledger-entry-correction"]')
        ?.textContent,
    ).not.toContain('Not repeated in a reply');
    expect(
      container.querySelector(
        '[data-testid="ledger-entry-correction"] [data-testid="ledger-entry-row-status"]',
      )?.textContent,
    ).toBe('Completed');
    expect(
      container
        .querySelector('[data-testid="ledger-entry-row-sync"]')
        ?.getAttribute('data-sync-state'),
    ).toBe('repair_needed');
    expect(
      container.querySelector('[data-testid="ledger-entry-row-sync"]')
        ?.className,
    ).toContain('fg-attention');
  });

  it("blocks a teammate's name and avatar on a root and its reply, not the rows", () => {
    const rootItem = searchItem({ author: USER, owner: USER });
    const correction = searchItem({
      entryId: '00000000-0000-4000-8000-000000000113',
      author: USER,
      owner: USER,
      supersedesEntryId: rootItem.entryId,
      createdAt: '2026-09-30T10:30:00.000Z',
      updatedAt: '2026-09-30T10:30:00.000Z',
    });
    render(
      listProps({
        entries: [correction, rootItem],
        rowDetails: (): LedgerEntryRowDetails => ({
          attribution: {
            kind: 'teammate',
            name: 'Ada Lovelace',
            organization: 'Acme',
          },
        }),
      }),
    );

    const replyRow = byTestId('ledger-entry-correction');
    const rootRow = byTestId('ledger-entry-row');
    for (const row of [rootRow, replyRow]) {
      expect(row.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
    }
    expect(
      rootRow.querySelector('[data-testid="ledger-entry-type-avatar"]'),
    ).not.toBeNull();
    expect(
      rootRow
        .querySelector('[data-testid="ledger-entry-type-avatar"]')
        ?.closest(`.${REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
    expect(
      rootRow
        .querySelector('[data-testid="ledger-entry-row-author"]')
        ?.classList.contains(REPLAY_BLOCK_CLASS),
    ).toBe(true);
    expect(
      replyRow
        .querySelector('[data-testid="ledger-actor-avatar"]')
        ?.classList.contains(REPLAY_BLOCK_CLASS),
    ).toBe(true);
    const replyName = Array.from(replyRow.querySelectorAll('span')).find(
      (span) => span.textContent === 'Ada Lovelace',
    );
    expect(replyName?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
  });

  it('shows Add correction on a root without corrections and only the newest correction otherwise', () => {
    const rootItem = searchItem();
    const onAddCorrection = jest.fn();
    render(
      listProps({
        entries: [rootItem],
        entrySlots: () => ({ onAddCorrection }),
      }),
    );
    const rootRow = container.querySelector<HTMLElement>(
      `[data-testid="ledger-entry-row"][data-entry-id="${rootItem.entryId}"]`,
    );
    expect(
      rootRow?.querySelector('[data-testid="ledger-entry-add-correction"]'),
    ).not.toBeNull();

    const older = searchItem({
      entryId: '00000000-0000-4000-8000-000000000113',
      supersedesEntryId: rootItem.entryId,
      createdAt: '2026-09-30T10:30:00.000Z',
    });
    const newest = searchItem({
      entryId: '00000000-0000-4000-8000-000000000114',
      supersedesEntryId: older.entryId,
      createdAt: '2026-09-30T10:45:00.000Z',
    });
    render(
      listProps({
        entries: [newest, older, rootItem],
        entrySlots: () => ({ onAddCorrection }),
      }),
    );

    const correctedRoot = container.querySelector<HTMLElement>(
      `[data-testid="ledger-entry-row"][data-entry-id="${rootItem.entryId}"]`,
    );
    const olderRow = container.querySelector<HTMLElement>(
      `[data-testid="ledger-entry-correction"][data-entry-id="${older.entryId}"]`,
    );
    const newestRow = container.querySelector<HTMLElement>(
      `[data-testid="ledger-entry-correction"][data-entry-id="${newest.entryId}"]`,
    );
    const rootActions = correctedRoot?.querySelector(
      '[data-testid="ledger-entry-details-toggle"]',
    )?.parentElement;
    expect(
      rootActions?.querySelector('[data-testid="ledger-entry-add-correction"]'),
    ).toBeNull();
    expect(
      olderRow?.querySelector('[data-testid="ledger-entry-add-correction"]'),
    ).toBeNull();
    expect(
      newestRow?.querySelector('[data-testid="ledger-entry-add-correction"]'),
    ).not.toBeNull();
  });

  it('opens a reply with its details and activity, without marking its loaded target as orphaned', () => {
    const rootItem = searchItem();
    const reply = searchItem({
      entryId: '00000000-0000-4000-8000-000000000121',
      supersedesEntryId: rootItem.entryId,
      content: 'Correction details are available.',
      type: 'OBSERVATION',
      status: 'INFO',
      createdAt: '2026-09-30T10:30:00.000Z',
      updatedAt: '2026-09-30T11:30:00.000Z',
    });
    const replyRead = view(
      {},
      { entryId: reply.entryId, updatedAt: '2026-09-30T11:00:00.000Z' },
    );
    render(
      listProps({
        entries: [reply, rootItem],
        openEntry: openEntry(reply.entryId, {}, replyRead),
        entrySlots: (item) =>
          item.entryId === reply.entryId
            ? {
                statusControl: (
                  <button data-testid="reply-status-control">
                    In progress
                  </button>
                ),
                ownerControl: (
                  <button data-testid="reply-owner-control">Assign</button>
                ),
              }
            : undefined,
      }),
    );
    const replyRow = container.querySelector<HTMLElement>(
      `[data-testid="ledger-entry-correction"][data-entry-id="${reply.entryId}"]`,
    );
    expect(replyRow?.getAttribute('aria-current')).toBe('true');
    expect(
      replyRow?.querySelector('[data-testid="ledger-entry-details"]'),
    ).not.toBeNull();
    expect(
      replyRow?.querySelector('[data-testid="ledger-entry-activity"]'),
    ).not.toBeNull();
    expect(
      replyRow?.querySelector('[data-testid="ledger-entry-supersedes"]'),
    ).toBeNull();
    expect(
      replyRow?.querySelector('[data-testid="ledger-entry-row-title"]'),
    ).toBeNull();
    expect(
      replyRow
        ?.querySelector('[data-testid="ledger-entry-details-toggle"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');
    expect(
      replyRow?.querySelector('[data-testid="reply-status-control"]'),
    ).not.toBeNull();
    expect(
      replyRow?.querySelector('[data-testid="reply-owner-control"]'),
    ).not.toBeNull();
    expect(
      replyRow?.querySelector('[data-testid="ledger-entry-row-status"]'),
    ).toBeNull();
  });

  it("keeps a reply's actions before its details and shows the correction meta as text", () => {
    const rootItem = searchItem();
    const reply = searchItem({
      entryId: '00000000-0000-4000-8000-000000000122',
      supersedesEntryId: rootItem.entryId,
      type: 'OBSERVATION',
      status: 'INFO',
    });
    const replyRead = view({}, { entryId: reply.entryId });
    render(
      listProps({
        entries: [reply, rootItem],
        openEntry: openEntry(reply.entryId, {}, replyRead),
        entrySlots: (item) =>
          item.entryId === reply.entryId
            ? { onAddCorrection: jest.fn() }
            : undefined,
      }),
    );
    const replyRow = container.querySelector<HTMLElement>(
      `[data-testid="ledger-entry-correction"][data-entry-id="${reply.entryId}"]`,
    );
    const actions = replyRow?.querySelector(
      '[data-testid="ledger-entry-details-toggle"]',
    );
    const details = replyRow?.querySelector(
      '[data-testid="ledger-entry-details"]',
    );
    if (actions === null || actions === undefined)
      throw new Error('No actions');
    if (details === null || details === undefined)
      throw new Error('No details');
    // Opening adds the details below the actions, as on a root row.
    expect(
      actions.compareDocumentPosition(details) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(
      replyRow?.querySelector('[data-testid="ledger-entry-correction-toggle"]'),
    ).toBeNull();
    expect(
      replyRow?.querySelector('[data-testid="ledger-entry-details-toggle"]')
        ?.textContent,
    ).toContain('Hide details');
    expect(replyRow?.textContent).toContain('Correction');
    expect(replyRow?.querySelector('time')?.dateTime).toBe(reply.createdAt);
  });

  it('shows the full local date and time in a reply timestamp tooltip', () => {
    const rootItem = searchItem();
    const reply = searchItem({
      entryId: '00000000-0000-4000-8000-000000000123',
      supersedesEntryId: rootItem.entryId,
      createdAt: '2026-09-30T10:30:00.000Z',
    });
    render(listProps({ entries: [reply, rootItem] }));

    const time = container.querySelector<HTMLElement>(
      `[data-testid="ledger-entry-correction"][data-entry-id="${reply.entryId}"] time`,
    );
    const trigger = time?.parentElement;
    if (trigger === null || trigger === undefined) {
      throw new Error('Expected the reply timestamp tooltip trigger');
    }
    act((): void => {
      trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      formatLedgerFullDateTime(reply.createdAt),
    );
  });

  it('does not open a reply from its bubble or meta line; the details toggle opens it', () => {
    const rootItem = searchItem();
    const reply = searchItem({
      entryId: '00000000-0000-4000-8000-000000000121',
      content: 'A reply that opens on its own.',
      supersedesEntryId: rootItem.entryId,
      createdAt: '2026-09-30T10:30:00.000Z',
      updatedAt: '2026-09-30T10:30:00.000Z',
    });
    const onToggleOpen = jest.fn();
    render(listProps({ entries: [reply, rootItem], onToggleOpen }));
    const replyRow = container.querySelector<HTMLElement>(
      `[data-testid="ledger-entry-correction"][data-entry-id="${reply.entryId}"]`,
    );
    const content = replyRow?.querySelector<HTMLElement>(
      '[data-testid="ledger-entry-row-content"]',
    );
    act(() => content?.click());
    act(() => replyRow?.click());
    const metaLine = Array.from(replyRow?.querySelectorAll('div') ?? []).find(
      (element) => element.textContent?.includes('Correction'),
    );
    act(() => metaLine?.click());
    expect(onToggleOpen).not.toHaveBeenCalled();
    expect(
      replyRow?.querySelector('[data-testid="ledger-entry-correction-toggle"]'),
    ).toBeNull();
    act(() =>
      replyRow
        ?.querySelector<HTMLElement>(
          '[data-testid="ledger-entry-details-toggle"]',
        )
        ?.click(),
    );
    expect(onToggleOpen).toHaveBeenCalledTimes(1);
    expect(onToggleOpen).toHaveBeenLastCalledWith(reply.entryId);
  });

  it('keeps an orphan correction as a row and offers its missing target in the open details', () => {
    const targetId = '00000000-0000-4000-8000-000000000199';
    const orphan = searchItem({
      entryId: '00000000-0000-4000-8000-000000000131',
      title: 'Correction without its original',
      supersedesEntryId: targetId,
    });
    const onShowEntry = jest.fn();
    render(
      listProps({
        entries: [orphan],
        openEntry: openEntry(
          orphan.entryId,
          {},
          view({}, { entryId: orphan.entryId, supersedesEntryId: targetId }),
        ),
        onShowEntry,
      }),
    );
    expect(
      container.querySelectorAll('[data-testid="ledger-entry-row"]'),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-testid="ledger-entry-correction"]'),
    ).toHaveLength(0);
    act(() => byTestId('ledger-entry-supersedes').click());
    expect(onShowEntry).toHaveBeenCalledWith(targetId);
  });

  it('shows a pinned entry above threads once and attaches its correction box to the right thread', () => {
    const pinned = searchItem({
      entryId: '00000000-0000-4000-8000-000000000141',
      title: 'Pinned entry',
    });
    const other = searchItem({
      entryId: '00000000-0000-4000-8000-000000000142',
      title: 'Other entry',
    });
    const correctionBox = (
      <div data-testid="correction-box-slot">Draft correction</div>
    );
    const composer = <div data-testid="composer-slot">Composer prompt</div>;
    render(
      listProps({
        entries: [other],
        pinnedEntry: pinned,
        composer,
        corrections: new Map([[pinned.entryId, correctionBox]]),
      }),
    );
    expect(byTestId('composer-slot').textContent).toBe('Composer prompt');
    expect(
      container.querySelectorAll('[data-testid="ledger-entry-row"]'),
    ).toHaveLength(2);
    const pinnedThread = container.querySelector<HTMLElement>(
      '[data-testid="ledger-entry-thread"][data-pinned="true"]',
    );
    expect(pinnedThread?.getAttribute('data-root-entry-id')).toBe(
      pinned.entryId,
    );
    expect(
      pinnedThread?.querySelector('[data-testid="correction-box-slot"]'),
    ).not.toBeNull();
    expect(
      container
        .querySelector('[data-testid="ledger-entry-list"]')
        ?.firstElementChild?.getAttribute('data-testid'),
    ).toBe('composer-slot');

    render(listProps({ entries: [pinned, other], pinnedEntry: pinned }));
    expect(
      container.querySelectorAll('[data-testid="ledger-entry-row"]'),
    ).toHaveLength(2);
    expect(
      container.querySelector(
        '[data-testid="ledger-entry-thread"][data-pinned="true"]',
      ),
    ).toBeNull();
  });

  it('shows boxes for several threads under their matching roots', () => {
    const first = searchItem();
    const second = searchItem({
      entryId: '00000000-0000-4000-8000-000000000145',
      title: 'Second thread',
    });
    const firstBox = <div data-testid="first-correction-box">First draft</div>;
    const secondBox = (
      <div data-testid="second-correction-box">Second draft</div>
    );
    render(
      listProps({
        entries: [first, second],
        corrections: new Map([
          [first.entryId, firstBox],
          [second.entryId, secondBox],
        ]),
      }),
    );

    const firstThread = container.querySelector<HTMLElement>(
      `[data-testid="ledger-entry-thread"][data-root-entry-id="${first.entryId}"]`,
    );
    const secondThread = container.querySelector<HTMLElement>(
      `[data-testid="ledger-entry-thread"][data-root-entry-id="${second.entryId}"]`,
    );
    expect(
      firstThread?.querySelector('[data-testid="first-correction-box"]'),
    ).not.toBeNull();
    expect(
      firstThread?.querySelector('[data-testid="second-correction-box"]'),
    ).toBeNull();
    expect(
      secondThread?.querySelector('[data-testid="second-correction-box"]'),
    ).not.toBeNull();
    expect(
      secondThread?.querySelector('[data-testid="first-correction-box"]'),
    ).toBeNull();
  });

  it('uses the same Add correction rule for pinned and orphan threads', () => {
    const pinned = searchItem({
      entryId: '00000000-0000-4000-8000-000000000146',
      supersedesEntryId: '00000000-0000-4000-8000-000000000199',
    });
    const orphan = searchItem({
      entryId: '00000000-0000-4000-8000-000000000147',
      supersedesEntryId: '00000000-0000-4000-8000-000000000198',
    });
    const orphanReply = searchItem({
      entryId: '00000000-0000-4000-8000-000000000148',
      supersedesEntryId: orphan.entryId,
      createdAt: '2026-09-30T10:30:00.000Z',
    });
    render(
      listProps({
        entries: [orphanReply, orphan],
        pinnedEntry: pinned,
        entrySlots: () => ({ onAddCorrection: jest.fn() }),
      }),
    );

    const pinnedThread = container.querySelector<HTMLElement>(
      '[data-testid="ledger-entry-thread"][data-pinned="true"]',
    );
    const orphanRoot = container.querySelector<HTMLElement>(
      `[data-testid="ledger-entry-row"][data-entry-id="${orphan.entryId}"]`,
    );
    const orphanReplyRow = container.querySelector<HTMLElement>(
      `[data-testid="ledger-entry-correction"][data-entry-id="${orphanReply.entryId}"]`,
    );
    const orphanRootActions = orphanRoot?.querySelector(
      '[data-testid="ledger-entry-details-toggle"]',
    )?.parentElement;
    expect(
      pinnedThread?.querySelector(
        '[data-testid="ledger-entry-add-correction"]',
      ),
    ).not.toBeNull();
    expect(
      orphanRootActions?.querySelector(
        '[data-testid="ledger-entry-add-correction"]',
      ),
    ).toBeNull();
    expect(
      orphanReplyRow?.querySelector(
        '[data-testid="ledger-entry-add-correction"]',
      ),
    ).not.toBeNull();
  });
});

describe('LedgerThreadList paging, windowing and memoization', () => {
  it('keeps an open thread in place on an in-place refresh with the same placement key', () => {
    const rootItem = searchItem();
    const sibling = searchItem({
      entryId: '00000000-0000-4000-8000-000000000102',
      title: 'A newer sibling thread',
    });
    const correction = searchItem({
      entryId: '00000000-0000-4000-8000-000000000103',
      supersedesEntryId: rootItem.entryId,
      content: 'A new correction',
    });
    const base = listProps({
      entries: [sibling, rootItem],
      placementKey: 'scope-1',
      openEntry: openEntry(rootItem.entryId, {}, null),
    });
    render(base);
    expect(threadRootIds()).toEqual([sibling.entryId, rootItem.entryId]);

    render({ ...base, entries: [correction, sibling, rootItem] });

    expect(threadRootIds()).toEqual([sibling.entryId, rootItem.entryId]);
    expect(
      container.querySelector('[data-testid="ledger-entry-correction"]')
        ?.textContent,
    ).toContain('A new correction');
  });

  it('restores natural thread order when the placement key changes', () => {
    const rootItem = searchItem();
    const sibling = searchItem({
      entryId: '00000000-0000-4000-8000-000000000102',
      title: 'A newer sibling thread',
    });
    const correction = searchItem({
      entryId: '00000000-0000-4000-8000-000000000103',
      supersedesEntryId: rootItem.entryId,
    });
    const base = listProps({
      entries: [sibling, rootItem],
      placementKey: 1,
    });
    render(base);
    render({
      ...base,
      placementKey: 2,
      entries: [correction, sibling, rootItem],
    });

    expect(threadRootIds()).toEqual([rootItem.entryId, sibling.entryId]);
  });

  it("uses today's natural order when no placement key is given", () => {
    const rootItem = searchItem();
    const sibling = searchItem({
      entryId: '00000000-0000-4000-8000-000000000102',
    });
    const correction = searchItem({
      entryId: '00000000-0000-4000-8000-000000000103',
      supersedesEntryId: rootItem.entryId,
    });
    const base = listProps({ entries: [sibling, rootItem] });
    render(base);
    render({ ...base, entries: [correction, sibling, rootItem] });

    expect(threadRootIds()).toEqual([rootItem.entryId, sibling.entryId]);
  });

  it('renders the load-more footer states', () => {
    const onLoadMore = jest.fn();
    render(listProps({ hasMore: true, onLoadMore }));
    expect(byTestId('ledger-load-more').textContent).toBe('Show more entries');
    act(() => byTestId('ledger-load-more').click());
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    render(listProps({ hasMore: true, loadingMore: true }));
    expect(container.textContent).toContain('Loading more entries…');
    expect(
      container.querySelector('[data-testid="ledger-load-more"]'),
    ).toBeNull();

    render(listProps({ loadMoreError: "Couldn't load more entries." }));
    expect(container.textContent).toContain("Couldn't load more entries.");
    expect(byTestId('ledger-load-more').textContent).toBe('Try again');
  });

  it('windows only above the thread threshold and only when a scroll element is given', () => {
    const scroller = document.createElement('div');
    Object.defineProperty(scroller, 'offsetHeight', { value: 600 });
    Object.defineProperty(scroller, 'offsetWidth', { value: 400 });
    document.body.appendChild(scroller);
    const makeEntries = (count: number): LedgerEntrySearchItem[] =>
      Array.from({ length: count }, (_, index) =>
        searchItem({
          entryId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          title: `Entry ${String(index)}`,
        }),
      );
    const entriesAtThreshold = makeEntries(
      LEDGER_THREAD_LIST_VIRTUALIZED_THRESHOLD,
    );
    const aboveThreshold = makeEntries(
      LEDGER_THREAD_LIST_VIRTUALIZED_THRESHOLD + 1,
    );
    const rootEntry = aboveThreshold[0];
    if (rootEntry === undefined) throw new Error('Expected root entry');
    const correction = searchItem({
      entryId: '00000000-0000-4000-8000-999999999999',
      supersedesEntryId: rootEntry.entryId,
    });
    const renderedRows = (): number =>
      container.querySelectorAll('[data-testid="ledger-entry-row"]').length;
    try {
      render(
        listProps({
          entries: entriesAtThreshold,
          scrollElement: () => scroller,
        }),
      );
      expect(
        byTestId('ledger-entry-list').dataset['virtualized'],
      ).toBeUndefined();
      expect(renderedRows()).toBe(LEDGER_THREAD_LIST_VIRTUALIZED_THRESHOLD);

      render(listProps({ entries: aboveThreshold }));
      expect(
        byTestId('ledger-entry-list').dataset['virtualized'],
      ).toBeUndefined();
      expect(renderedRows()).toBe(LEDGER_THREAD_LIST_VIRTUALIZED_THRESHOLD + 1);

      render(
        listProps({
          entries: [...aboveThreshold, correction],
          scrollElement: () => scroller,
        }),
      );
      const list = byTestId('ledger-entry-list');
      expect(list.dataset['virtualized']).toBe('true');
      expect(list.dataset['entryCount']).toBe(
        String(LEDGER_THREAD_LIST_VIRTUALIZED_THRESHOLD + 2),
      );
      expect(renderedRows()).toBeGreaterThan(0);
      expect(renderedRows()).toBeLessThan(
        LEDGER_THREAD_LIST_VIRTUALIZED_THRESHOLD + 1,
      );
    } finally {
      scroller.remove();
    }
  });

  it('windows threads from where the list starts, below the content above it', () => {
    const composerHeight = 3000;
    Object.defineProperty(container, 'offsetHeight', { value: 600 });
    Object.defineProperty(container, 'offsetWidth', { value: 400 });
    // Scrolled to where the threads begin, below a tall composer.
    Object.defineProperty(container, 'scrollTop', {
      value: composerHeight,
      writable: true,
    });
    const rect = jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement): DOMRect {
        const top =
          this.dataset['testid'] === 'ledger-thread-window'
            ? composerHeight - container.scrollTop
            : 0;
        return DOMRect.fromRect({ x: 0, y: top, width: 400, height: 0 });
      });
    const entries = Array.from(
      { length: LEDGER_THREAD_LIST_VIRTUALIZED_THRESHOLD + 1 },
      (_, index) =>
        searchItem({
          entryId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          title: `Entry ${String(index)}`,
        }),
    );
    try {
      render(
        listProps({
          entries,
          composer: <div style={{ height: composerHeight }} />,
          scrollElement: () => container,
        }),
      );

      const threadWindow = byTestId('ledger-thread-window');
      expect(threadRootIds()[0]).toBe(entries[0]?.entryId);
      expect(
        threadWindow.firstElementChild?.getAttribute('aria-hidden'),
      ).toBeNull();
    } finally {
      rect.mockRestore();
    }
  });

  it('does not rerender its entries when the parent renders with identical props', () => {
    const rowDetails = jest.fn(
      (): LedgerEntryRowDetails => ({
        context: 'Parser fixes',
      }),
    );
    const props = listProps({ rowDetails });
    render(props);
    expect(rowDetails).toHaveBeenCalledTimes(1);
    render(props);
    expect(rowDetails).toHaveBeenCalledTimes(1);
  });

  it('with a placement key, regroups only when its entries change', () => {
    const openItem = searchItem();
    const sibling = searchItem({
      entryId: '00000000-0000-4000-8000-000000000143',
      title: 'A thread nobody opened',
    });
    const newer = searchItem({
      entryId: '00000000-0000-4000-8000-000000000144',
      title: 'A newer thread',
    });
    const rowDetails = jest.fn((): LedgerEntryRowDetails => ({}));
    const siblingCalls = (): number =>
      rowDetails.mock.calls.filter(
        (call: unknown[]) =>
          call[0] !== null &&
          typeof call[0] === 'object' &&
          'entryId' in call[0] &&
          call[0].entryId === sibling.entryId,
      ).length;
    const base = listProps({
      entries: [openItem, sibling],
      placementKey: 1,
      rowDetails,
    });
    render({ ...base, openEntry: openEntry(openItem.entryId, {}, null) });
    // The list changes in place: a new entry joins at the top.
    const changed = { ...base, entries: [newer, openItem, sibling] };
    render({ ...changed, openEntry: openEntry(openItem.entryId, {}, null) });
    expect(threadRootIds()).toEqual([
      newer.entryId,
      openItem.entryId,
      sibling.entryId,
    ]);
    const settled = siblingCalls();

    // Later renders with the same entries keep every thread as it was.
    render({ ...changed, openEntry: openEntry(openItem.entryId) });
    render({ ...changed, openEntry: openEntry(openItem.entryId) });
    expect(siblingCalls()).toBe(settled);
  });

  it("renders only the open entry's thread again when its state changes", () => {
    const openItem = searchItem();
    const reply = searchItem({
      entryId: '00000000-0000-4000-8000-000000000141',
      supersedesEntryId: openItem.entryId,
    });
    const sibling = searchItem({
      entryId: '00000000-0000-4000-8000-000000000142',
      title: 'A thread nobody opened',
    });
    const rowDetails = jest.fn((): LedgerEntryRowDetails => ({}));
    const calls = (entryId: string): number =>
      rowDetails.mock.calls.filter(
        (call: unknown[]) =>
          call[0] !== null &&
          typeof call[0] === 'object' &&
          'entryId' in call[0] &&
          call[0].entryId === entryId,
      ).length;
    const base = listProps({
      entries: [reply, openItem, sibling],
      rowDetails,
      corrections: new Map([[openItem.entryId, <span>Box</span>]]),
    });
    render({ ...base, openEntry: openEntry(openItem.entryId, {}, null) });
    const siblingCalls = calls(sibling.entryId);
    const openCalls = calls(openItem.entryId);
    expect(siblingCalls).toBe(1);

    // The read arrives: a new open-entry object for the same entry.
    render({ ...base, openEntry: openEntry(openItem.entryId) });
    expect(calls(sibling.entryId)).toBe(siblingCalls);
    expect(calls(openItem.entryId)).toBeGreaterThan(openCalls);

    // Opening the reply renders its own thread, still not the sibling.
    render({ ...base, openEntry: openEntry(reply.entryId) });
    expect(calls(sibling.entryId)).toBe(siblingCalls);
    expect(
      container
        .querySelector(
          `[data-testid="ledger-entry-correction"][data-entry-id="${reply.entryId}"]`,
        )
        ?.getAttribute('aria-current'),
    ).toBe('true');
  });

  it('does not rerender other threads when one correction box changes', () => {
    const first = searchItem();
    const second = searchItem({
      entryId: '00000000-0000-4000-8000-000000000149',
    });
    const rowDetails = jest.fn((): LedgerEntryRowDetails => ({}));
    const firstBox = <span>First draft</span>;
    const secondBox = <span>Second draft</span>;
    const calls = (entryId: string): number =>
      rowDetails.mock.calls.filter(
        (call: unknown[]) =>
          call[0] !== null &&
          typeof call[0] === 'object' &&
          'entryId' in call[0] &&
          call[0].entryId === entryId,
      ).length;
    const base = listProps({
      entries: [first, second],
      rowDetails,
      corrections: new Map([
        [first.entryId, firstBox],
        [second.entryId, secondBox],
      ]),
    });
    render(base);
    const firstCalls = calls(first.entryId);
    const secondCalls = calls(second.entryId);
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);

    render({
      ...base,
      corrections: new Map([
        [first.entryId, <span>Updated first draft</span>],
        [second.entryId, secondBox],
      ]),
    });
    expect(calls(first.entryId)).toBeGreaterThan(firstCalls);
    expect(calls(second.entryId)).toBe(secondCalls);
  });
});
