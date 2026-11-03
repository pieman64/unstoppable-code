/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as ReactModule from 'react';
import type * as SharedComponentsModule from '@canopy/ui-shared/components';
import type { LedgerClient, LedgerNavigator } from '@canopy/app-core';
import {
  createLedgerViewStore,
  DEFAULT_LEDGER_VIEW_FILTERS,
} from '@canopy/app-state';
import type {
  LedgerActorRef,
  LedgerEntriesSearchResult,
  LedgerEntrySearchItem,
  LedgerFileRef,
  LedgerOwnerCandidate,
  LedgerStatus,
} from '@canopy/protocol/canopy-core';
import type {
  LedgerViewAddRequest,
  LedgerViewChangedEvent,
  LedgerViewEntry,
  LedgerViewReceipt,
  LedgerViewResult,
  LedgerTaskViewScope,
  LedgerViewSearchRequest,
  LedgerViewUpdateRequest,
} from '@canopy/protocol/ledger-view';
import { LedgerPanel } from '../LedgerPanel';

let mockLedgerThreadListRenderCount = 0;
let mockLedgerCorrectionBoxRenderCount = 0;

jest.mock('@canopy/ui-shared/components', () => {
  const actual = jest.requireActual<typeof SharedComponentsModule>(
    '@canopy/ui-shared/components',
  );
  const react = jest.requireActual<typeof ReactModule>('react');
  const CountingLedgerThreadList = react.memo(
    (props: Parameters<typeof actual.LedgerThreadList>[0]) => {
      mockLedgerThreadListRenderCount += 1;
      return react.createElement(actual.LedgerThreadList, props);
    },
  );
  const CountingLedgerCorrectionBox = react.memo(
    (props: Parameters<typeof actual.LedgerCorrectionBox>[0]) => {
      mockLedgerCorrectionBoxRenderCount += 1;
      return react.createElement(actual.LedgerCorrectionBox, props);
    },
  );
  return {
    ...actual,
    LedgerThreadList: CountingLedgerThreadList,
    LedgerCorrectionBox: CountingLedgerCorrectionBox,
  };
});

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const SCOPE: LedgerTaskViewScope = {
  projectId: 'project-1',
  worktreeId: 'wt-1',
};
const CHAT: LedgerActorRef = {
  actorId: '00000000-0000-4000-8000-0000000000a1',
  kind: 'chat',
  authorityId: 'authority-1',
};
const OTHER_CHAT: LedgerActorRef = {
  actorId: '00000000-0000-4000-8000-0000000000a2',
  kind: 'chat',
  authorityId: 'authority-1',
};
const ENTRY_ID = '00000000-0000-4000-8000-000000000101';
const OTHER_ENTRY_ID = '00000000-0000-4000-8000-000000000102';
const CORRECTION_ID = '00000000-0000-4000-8000-000000000103';
const REPLY_ID = '00000000-0000-4000-8000-000000000104';
const PINNED_ENTRY_ID = '00000000-0000-4000-8000-000000000105';
const NEW_ENTRY_ID = '00000000-0000-4000-8000-000000000106';
const REPLY_CORRECTION_ID = '00000000-0000-4000-8000-000000000107';
const DEFAULT_TITLE = 'Keep one ledger writer';
const FILE_REF: LedgerFileRef = {
  rootId: '00000000-0000-4000-8000-000000000201',
  path: 'src/ledger.ts',
  startLine: 12,
};

interface EntryFixtureOptions {
  readonly supersedesEntryId?: string;
  readonly referenceFiles?: readonly LedgerFileRef[];
  readonly owner?: LedgerActorRef;
  readonly titlePending?: true;
  readonly type?: LedgerEntrySearchItem['type'];
}

function item(
  title: string,
  status: LedgerStatus = 'TODO',
  entryId = ENTRY_ID,
  options: EntryFixtureOptions = {},
): LedgerEntrySearchItem {
  return {
    entryId,
    revision: 1,
    type: options.type ?? 'DECISION',
    title,
    content: 'Keep one writer.',
    highlights: [],
    referenceFiles: [...(options.referenceFiles ?? [])],
    status,
    owner: options.owner ?? CHAT,
    author: CHAT,
    attributionKind: 'self_reported',
    createdAt: '2026-09-30T10:37:00.000Z',
    updatedAt: '2026-09-30T10:37:00.000Z',
    ...(options.supersedesEntryId === undefined
      ? {}
      : { supersedesEntryId: options.supersedesEntryId }),
    ...(options.titlePending === true ? { titlePending: true } : {}),
    sourceAvailability: 'available',
  };
}

function page(
  entries: LedgerEntrySearchItem[],
  options: {
    readonly hasMore?: boolean;
    readonly nextCursor?: string | null;
    readonly audienceChangePending?: boolean;
  } = {},
): LedgerViewResult<LedgerEntriesSearchResult> {
  return {
    status: 'ok',
    value: {
      entries,
      nextCursor: options.nextCursor ?? null,
      hasMore: options.hasMore ?? false,
      watermark: '1',
      actors: [
        {
          actorId: CHAT.actorId,
          kind: 'chat' as const,
          displayName: 'Architecture',
        },
      ],
      ...(options.audienceChangePending === true
        ? { scopeSync: { audienceChangePending: true } }
        : {}),
    },
  };
}

interface EntryViewOptions extends EntryFixtureOptions {
  readonly revision?: number;
}

function entryView(
  title: string,
  status: LedgerStatus = 'TODO',
  entryId = ENTRY_ID,
  options: EntryViewOptions = {},
): LedgerViewResult<LedgerViewEntry> {
  const authorDetails = {
    harness: 'claude',
    model: null,
    thinkingEffort: null,
    mode: null,
    pipelineExecutionId: null,
    settingsRevision: null,
    unavailableReason: null,
  };
  return {
    status: 'ok',
    value: {
      entry: {
        entry: {
          schemaVersion: 1,
          entryId,
          scope: {
            ledgerId: '00000000-0000-4000-8000-000000000001',
            authorityId: 'authority-1',
            container: {
              kind: 'code_worktree',
              workspaceId: SCOPE.projectId,
              worktreeId: SCOPE.worktreeId,
            },
          },
          createdAt: '2026-09-30T10:37:00.000Z',
          updatedAt: '2026-09-30T10:37:00.000Z',
          revision: options.revision ?? 1,
          author: CHAT,
          authorDetails,
          owner: options.owner ?? CHAT,
          type: options.type ?? 'DECISION',
          title,
          content: 'Keep one writer.',
          highlights: [],
          referenceFiles: [...(options.referenceFiles ?? [])],
          status,
          origin: {
            kind: 'chat',
            ledgerId: '00000000-0000-4000-8000-000000000001',
            chatId: 'chat-1',
          },
          attribution: {
            kind: 'self_reported',
            effectiveActor: CHAT,
            recordedBy: CHAT,
            executorDetails: authorDetails,
          },
          ...(options.supersedesEntryId === undefined
            ? {}
            : { supersedesEntryId: options.supersedesEntryId }),
        },
        sourceAvailability: 'available',
        history: { mutations: [], nextCursor: null },
        actors: [],
      },
      source: {
        availability: 'available',
        target: {
          kind: 'chat',
          projectId: SCOPE.projectId,
          worktreeId: SCOPE.worktreeId,
          chatId: 'chat-1',
          archived: false,
        },
      },
    },
  };
}

type SearchAnswer = LedgerViewResult<LedgerEntriesSearchResult>;
type EntryAnswer = LedgerViewResult<LedgerViewEntry>;
type ReceiptAnswer = LedgerViewResult<LedgerViewReceipt>;
type OwnerAnswer = Awaited<ReturnType<LedgerClient['listOwners']>>;

interface Gate {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function gate(): Gate {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

interface FakeLedger {
  readonly client: LedgerClient;
  readonly searches: LedgerViewSearchRequest[];
  readonly adds: LedgerViewAddRequest[];
  readonly updates: LedgerViewUpdateRequest[];
  readonly entryReads: string[];
  readonly handlers: Set<(event: LedgerViewChangedEvent) => void>;
  readonly entryViews: Map<string, EntryAnswer>;
  answer: SearchAnswer;
  moreAnswer: SearchAnswer;
  entry: EntryAnswer;
  addAnswer: ReceiptAnswer;
  updateAnswer: ReceiptAnswer;
  ownerAnswer: OwnerAnswer;
  holdSearch: Promise<void> | null;
  holdEntryRead: Promise<void> | null;
  holdAdd: Promise<void> | null;
  holdUpdate: Promise<void> | null;
  ownerReads: number;
  emit(event: LedgerViewChangedEvent): void;
}

function fakeLedger(): FakeLedger {
  const fake: FakeLedger = {
    searches: [],
    adds: [],
    updates: [],
    entryReads: [],
    handlers: new Set(),
    entryViews: new Map(),
    answer: page([item(DEFAULT_TITLE)]),
    moreAnswer: page([]),
    entry: entryView(DEFAULT_TITLE),
    addAnswer: {
      status: 'error',
      reason: 'UNKNOWN',
      message: 'Unset add answer',
    },
    updateAnswer: {
      status: 'error',
      reason: 'UNKNOWN',
      message: 'Unset update answer',
    },
    ownerAnswer: {
      status: 'ok',
      value: { candidates: [], nextCursor: null },
    },
    holdSearch: null,
    holdEntryRead: null,
    holdAdd: null,
    holdUpdate: null,
    ownerReads: 0,
    emit: (event): void => fake.handlers.forEach((handler) => handler(event)),
    client: {
      searchEntries: async (request) => {
        fake.searches.push(request);
        const answer =
          request.params.cursor === undefined ? fake.answer : fake.moreAnswer;
        if (fake.holdSearch !== null) await fake.holdSearch;
        return answer;
      },
      getEntry: async (request) => {
        fake.entryReads.push(request.entryId);
        const answer = fake.entryViews.get(request.entryId) ?? fake.entry;
        if (fake.holdEntryRead !== null) await fake.holdEntryRead;
        return answer;
      },
      addEntry: async (request) => {
        fake.adds.push(request);
        if (fake.holdAdd !== null) await fake.holdAdd;
        return fake.addAnswer;
      },
      updateEntry: async (request) => {
        fake.updates.push(request);
        if (fake.holdUpdate !== null) await fake.holdUpdate;
        return fake.updateAnswer;
      },
      listOwners: () => {
        fake.ownerReads += 1;
        return Promise.resolve(fake.ownerAnswer);
      },
      subscribeChanges: (handler) => {
        fake.handlers.add(handler);
        return (): void => {
          fake.handlers.delete(handler);
        };
      },
    },
  };
  return fake;
}

const openSource = jest.fn<
  ReturnType<LedgerNavigator['openSource']>,
  Parameters<LedgerNavigator['openSource']>
>(() =>
  Promise.resolve({ ok: false, message: 'That chat is no longer available.' }),
);
const openFile = jest.fn<
  ReturnType<LedgerNavigator['openFile']>,
  Parameters<LedgerNavigator['openFile']>
>(() => Promise.resolve({ ok: true }));
const navigator: LedgerNavigator = { openSource, openFile };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mockLedgerThreadListRenderCount = 0;
  mockLedgerCorrectionBoxRenderCount = 0;
  openSource.mockReset();
  openSource.mockResolvedValue({
    ok: false,
    message: 'That chat is no longer available.',
  });
  openFile.mockReset();
  openFile.mockResolvedValue({ ok: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.useRealTimers();
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  });
}

function byTestId(testId: string): HTMLElement {
  const element = document.querySelector('[data-testid="' + testId + '"]');
  if (!(element instanceof HTMLElement)) {
    throw new Error('Missing ' + testId);
  }
  return element;
}

function buttonByTestId(testId: string): HTMLButtonElement {
  const element = byTestId(testId);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(testId + ' is not a button');
  }
  return element;
}

function entryElement(testId: string, entryId: string): HTMLElement {
  const element = document.querySelector(
    '[data-testid="' + testId + '"][data-entry-id="' + entryId + '"]',
  );
  if (!(element instanceof HTMLElement)) {
    throw new Error('Missing ' + testId + ' for ' + entryId);
  }
  return element;
}

function threadElement(rootEntryId: string): HTMLElement {
  const element = document.querySelector(
    '[data-testid="ledger-entry-thread"][data-root-entry-id="' +
      rootEntryId +
      '"]',
  );
  if (!(element instanceof HTMLElement)) {
    throw new Error('Missing thread for ' + rootEntryId);
  }
  return element;
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('Missing button ' + text);
  }
  return button;
}

function click(testId: string): void {
  act(() => buttonByTestId(testId).click());
}

function clickInside(element: HTMLElement, testId: string): void {
  const target = element.querySelector('[data-testid="' + testId + '"]');
  if (!(target instanceof HTMLButtonElement)) {
    throw new Error('Missing button ' + testId);
  }
  act(() => target.click());
}

function typeInto(element: HTMLElement, value: string): void {
  if (element instanceof HTMLTextAreaElement) {
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set?.bind(element);
    if (setValue === undefined) throw new Error('Textarea has no value setter');
    act(() => {
      setValue(value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return;
  }
  if (element instanceof HTMLInputElement) {
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.bind(element);
    if (setValue === undefined) throw new Error('Input has no value setter');
    act(() => {
      setValue(value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return;
  }
  throw new Error('Expected an input or textarea');
}

function inputByTestId(testId: string): HTMLInputElement {
  const element = byTestId(testId);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(testId + ' is not an input');
  }
  return element;
}

function receiptFor(view: EntryAnswer): ReceiptAnswer {
  if (view.status !== 'ok') throw new Error('Expected an entry view');
  return {
    status: 'ok',
    value: {
      entry: view.value.entry.entry,
      changed: true,
      mutationId: null,
      localSequence: '2',
      syncState: 'local_only',
    },
  };
}

function readAs(fake: FakeLedger, entryId: string, view: EntryAnswer): void {
  fake.entryViews.set(entryId, view);
}

function renderPanel(
  fake: FakeLedger,
): ReturnType<typeof createLedgerViewStore> {
  let nextRequest = 0;
  const store = createLedgerViewStore(fake.client, SCOPE, {
    newRequestKey: () => {
      nextRequest += 1;
      return 'request-' + nextRequest;
    },
  });
  act(() =>
    root.render(
      <LedgerPanel store={store} client={fake.client} navigator={navigator} />,
    ),
  );
  return store;
}

function chooseStatus(status: LedgerStatus): void {
  click('ledger-status-control');
  click('ledger-status-option-' + status.toLowerCase());
}

const OWNER_CANDIDATE: LedgerOwnerCandidate = {
  actor: OTHER_CHAT,
  displayName: 'Build session',
  eligibilityToken: 'eligible-1',
  isSelf: false,
};

describe('LedgerPanel list and search', () => {
  it('shows loading until its first page is read', async () => {
    const fake = fakeLedger();
    const waiting = gate();
    fake.holdSearch = waiting.promise;
    renderPanel(fake);

    // Rows shaped like the entries, inside the delayed placeholder, with the
    // note for a slow read.
    const skeleton = container.querySelector(
      '[data-testid="delayed-loading-placeholder"] [data-testid="ledger-thread-list-skeleton"][data-density="panel"]',
    );
    expect(skeleton).toBeInstanceOf(HTMLElement);
    expect(
      container.querySelector('[data-testid="slow-load-note"]'),
    ).toBeInstanceOf(HTMLElement);
    expect(container.querySelector('[data-testid="ledger-empty"]')).toBeNull();
    waiting.resolve();
    fake.holdSearch = null;
    await flush();

    expect(fake.searches).toHaveLength(1);
    expect(entryElement('ledger-entry-row', ENTRY_ID).textContent).toContain(
      DEFAULT_TITLE,
    );
  });

  it('shows a list problem and retries when Try again is selected', async () => {
    const fake = fakeLedger();
    fake.answer = {
      status: 'error',
      reason: 'STORAGE_UNAVAILABLE',
      message: 'Unavailable',
    };
    renderPanel(fake);
    await flush();

    const problem = byTestId('ledger-list-problem');
    expect(problem.textContent).toContain("Couldn't load entries.");
    expect(problem.textContent).not.toContain('entries. Try again.');
    const retry = problem.querySelector('button');
    if (!(retry instanceof HTMLButtonElement)) {
      throw new Error('List problem has no retry button');
    }
    expect(retry.textContent).toBe('Try again');

    fake.answer = page([item('Recovered list')]);
    act(() => retry.click());
    // The failed state stays while the read runs, its capsule spinning.
    expect(byTestId('ledger-list-problem')).toBe(problem);
    expect(retry.textContent).toBe('Trying again…');
    expect(retry.getAttribute('aria-busy')).toBe('true');
    await flush();

    expect(fake.searches).toHaveLength(2);
    expect(container.textContent).toContain('Recovered list');
    expect(
      container.querySelector('[data-testid="ledger-list-problem"]'),
    ).toBeNull();
  });

  it('drops a kept failure as soon as a newer read succeeds, while Try again is still pending', async () => {
    const fake = fakeLedger();
    fake.answer = {
      status: 'error',
      reason: 'STORAGE_UNAVAILABLE',
      message: 'Unavailable',
    };
    renderPanel(fake);
    await flush();

    const retry = byTestId('ledger-list-problem').querySelector('button');
    if (!(retry instanceof HTMLButtonElement)) {
      throw new Error('List problem has no retry button');
    }
    // The retried read hangs; a filter change then reads again and succeeds.
    const hung = gate();
    fake.holdSearch = hung.promise;
    act(() => retry.click());
    expect(retry.textContent).toBe('Trying again…');
    fake.holdSearch = null;
    fake.answer = page([item('Fresh list')]);
    click('ledger-filter-trigger');
    click('ledger-filter-status-blocked');
    await flush();

    expect(container.textContent).toContain('Fresh list');
    expect(
      container.querySelector('[data-testid="ledger-list-problem"]'),
    ).toBeNull();

    hung.resolve();
    await flush();
    expect(container.textContent).toContain('Fresh list');
  });

  it('shows an audience change waiting to sync and clears it after a sync refresh', async () => {
    const fake = fakeLedger();
    fake.answer = page([item(DEFAULT_TITLE)], { audienceChangePending: true });
    renderPanel(fake);
    await flush();

    expect(byTestId('ledger-audience-change-pending').textContent).toContain(
      'Sharing change waiting to sync',
    );
    fake.answer = page([item(DEFAULT_TITLE)]);
    act(() =>
      fake.emit({
        changes: [],
        syncChanged: [SCOPE],
      }),
    );
    await flush();

    expect(fake.searches).toHaveLength(2);
    expect(
      container.querySelector('[data-testid="ledger-audience-change-pending"]'),
    ).toBeNull();
  });

  it('shows both empty states and clears search and filters from the filtered state', async () => {
    const fake = fakeLedger();
    fake.answer = page([]);
    const store = renderPanel(fake);
    await flush();

    expect(byTestId('ledger-empty').textContent).toContain('No entries yet');

    act(() => store.getState().setQueryText('missing'));
    await act(async () => {
      await store.getState().setFilters({
        types: [],
        statuses: ['TODO'],
        owner: 'anyone',
      });
    });
    await flush();

    expect(byTestId('ledger-empty-filtered').textContent).toContain(
      'No matching entries',
    );
    act(() => buttonWithText('Clear search and filters').click());
    await flush();

    expect(store.getState().queryText).toBe('');
    expect(store.getState().filters).toEqual(DEFAULT_LEDGER_VIEW_FILTERS);
    expect(byTestId('ledger-empty').textContent).toContain('No entries yet');
    const lastSearch = fake.searches[fake.searches.length - 1];
    expect(lastSearch?.params.query).toBeUndefined();
    expect(lastSearch?.params.statuses).toBeUndefined();
  });

  it('debounces search for 250 ms and Escape clears it', async () => {
    jest.useFakeTimers();
    const fake = fakeLedger();
    const store = renderPanel(fake);
    await flush();

    const input = inputByTestId('ledger-search');
    typeInto(input, 'writer');
    expect(fake.searches).toHaveLength(1);
    await act(async () => {
      jest.advanceTimersByTime(249);
      await Promise.resolve();
    });
    expect(fake.searches).toHaveLength(1);
    await act(async () => {
      jest.advanceTimersByTime(1);
      await Promise.resolve();
    });
    await flush();

    expect(fake.searches).toHaveLength(2);
    expect(fake.searches[1]?.params.query).toBe('writer');

    void act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(input.value).toBe('');
    await act(async () => {
      jest.advanceTimersByTime(250);
      await Promise.resolve();
    });
    await flush();

    expect(fake.searches).toHaveLength(3);
    expect(fake.searches[2]?.params.query).toBeUndefined();
    expect(store.getState().queryText).toBe('');
  });

  it('reloads the first page when a filter changes', async () => {
    const fake = fakeLedger();
    const store = renderPanel(fake);
    await flush();

    click('ledger-filter-trigger');
    click('ledger-filter-status-blocked');
    await flush();

    expect(fake.searches).toHaveLength(2);
    expect(fake.searches[1]?.params.statuses).toEqual(['BLOCKED']);
    expect(store.getState().filters.statuses).toEqual(['BLOCKED']);
  });

  it('loads another page and retries a failed load more', async () => {
    const fake = fakeLedger();
    fake.answer = page([item(DEFAULT_TITLE)], {
      hasMore: true,
      nextCursor: 'cursor-one',
    });
    fake.moreAnswer = page([item('Second entry', 'TODO', OTHER_ENTRY_ID)], {
      hasMore: true,
      nextCursor: 'cursor-two',
    });
    renderPanel(fake);
    await flush();

    click('ledger-load-more');
    await flush();
    expect(fake.searches[1]?.params.cursor).toBe('cursor-one');
    expect(container.textContent).toContain('Second entry');

    fake.moreAnswer = {
      status: 'error',
      reason: 'STORAGE_UNAVAILABLE',
      message: 'Unavailable',
    };
    click('ledger-load-more');
    await flush();

    expect(container.textContent).toContain("Couldn't load more entries.");
    expect(buttonByTestId('ledger-load-more').textContent).toBe('Try again');
    fake.moreAnswer = page([item('Third entry', 'TODO', PINNED_ENTRY_ID)]);
    click('ledger-load-more');
    await flush();

    expect(fake.searches[3]?.params.cursor).toBe('cursor-two');
    expect(container.textContent).toContain('Third entry');
    expect(container.textContent).not.toContain("Couldn't load more entries.");
  });

  it('shows a selected entry loading in place before its read completes', async () => {
    const fake = fakeLedger();
    const store = renderPanel(fake);
    await flush();
    const waiting = gate();
    fake.holdEntryRead = waiting.promise;

    click('ledger-entry-details-toggle');
    expect(
      container.querySelector('[data-testid="centered-loading-spinner"]'),
    ).not.toBeNull();
    waiting.resolve();
    fake.holdEntryRead = null;
    await flush();

    expect(byTestId('ledger-entry-details')).toBeDefined();
    expect(store.getState().selectedEntryId).toBe(ENTRY_ID);
  });
});

describe('LedgerPanel threads and selection', () => {
  it('opens and closes a root row from its details toggle', async () => {
    const fake = fakeLedger();
    const store = renderPanel(fake);
    await flush();

    clickInside(
      entryElement('ledger-entry-row', ENTRY_ID),
      'ledger-entry-details-toggle',
    );
    await flush();
    expect(
      entryElement('ledger-entry-row', ENTRY_ID).getAttribute('aria-current'),
    ).toBe('true');
    expect(
      entryElement('ledger-entry-row', ENTRY_ID).querySelector(
        '[data-testid="ledger-entry-details"]',
      ),
    ).not.toBeNull();
    expect(fake.entryReads).toEqual([ENTRY_ID]);

    click('ledger-entry-details-toggle');
    await flush();
    expect(
      entryElement('ledger-entry-row', ENTRY_ID).getAttribute('aria-current'),
    ).toBeNull();
    expect(store.getState().selectedEntryId).toBeNull();
    expect(fake.entryReads).toEqual([ENTRY_ID]);
  });

  it('opens and closes a correction reply in its thread', async () => {
    const fake = fakeLedger();
    fake.answer = page([
      item(DEFAULT_TITLE),
      item('A correction', 'TODO', CORRECTION_ID, {
        supersedesEntryId: ENTRY_ID,
      }),
    ]);
    readAs(
      fake,
      CORRECTION_ID,
      entryView('A correction', 'TODO', CORRECTION_ID, {
        supersedesEntryId: ENTRY_ID,
      }),
    );
    const store = renderPanel(fake);
    await flush();

    const reply = entryElement('ledger-entry-correction', CORRECTION_ID);
    clickInside(reply, 'ledger-entry-details-toggle');
    await flush();

    expect(
      entryElement('ledger-entry-correction', CORRECTION_ID).getAttribute(
        'aria-current',
      ),
    ).toBe('true');
    expect(
      entryElement('ledger-entry-correction', CORRECTION_ID).querySelector(
        '[data-testid="ledger-entry-details"]',
      ),
    ).not.toBeNull();
    expect(fake.entryReads).toEqual([CORRECTION_ID]);

    clickInside(
      entryElement('ledger-entry-correction', CORRECTION_ID),
      'ledger-entry-details-toggle',
    );
    await flush();
    expect(
      entryElement('ledger-entry-correction', CORRECTION_ID).getAttribute(
        'aria-current',
      ),
    ).toBeNull();
    expect(store.getState().selectedEntryId).toBeNull();
  });

  it('pins an opened entry that is outside the loaded page', async () => {
    const fake = fakeLedger();
    readAs(
      fake,
      PINNED_ENTRY_ID,
      entryView('Pinned entry', 'TODO', PINNED_ENTRY_ID),
    );
    const store = renderPanel(fake);
    await flush();

    await act(async () => {
      await store.getState().select(PINNED_ENTRY_ID);
    });
    await flush();

    expect(threadElement(PINNED_ENTRY_ID).getAttribute('data-pinned')).toBe(
      'true',
    );
    expect(
      entryElement('ledger-entry-row', PINNED_ENTRY_ID).getAttribute(
        'aria-current',
      ),
    ).toBe('true');
    expect(fake.entryReads).toEqual([PINNED_ENTRY_ID]);
  });
});

describe('LedgerPanel status and owner changes', () => {
  it('changes an open-status row in place, disables it while saving, then refreshes the list', async () => {
    const fake = fakeLedger();
    const store = renderPanel(fake);
    await flush();
    const waiting = gate();
    fake.holdUpdate = waiting.promise;

    chooseStatus('IN_PROGRESS');
    await flush();

    expect(fake.entryReads).toEqual([ENTRY_ID]);
    expect(fake.updates).toHaveLength(1);
    expect(buttonByTestId('ledger-status-control').disabled).toBe(true);

    const changedEntry = entryView(DEFAULT_TITLE, 'IN_PROGRESS', ENTRY_ID, {
      revision: 2,
    });
    readAs(fake, ENTRY_ID, changedEntry);
    fake.answer = page([item(DEFAULT_TITLE, 'IN_PROGRESS')]);
    fake.updateAnswer = receiptFor(changedEntry);
    waiting.resolve();
    fake.holdUpdate = null;
    await flush();

    expect(fake.searches).toHaveLength(2);
    expect(buttonByTestId('ledger-status-control').disabled).toBe(false);
    expect(
      buttonByTestId('ledger-status-control').getAttribute('data-status'),
    ).toBe('IN_PROGRESS');
    expect(store.getState().selectedEntryId).toBe(ENTRY_ID);
  });

  it('loads owners when opened and assigns the chosen owner in place', async () => {
    const fake = fakeLedger();
    const waiting = gate();
    fake.holdUpdate = waiting.promise;
    fake.ownerAnswer = {
      status: 'ok',
      value: { candidates: [OWNER_CANDIDATE], nextCursor: null },
    };
    renderPanel(fake);
    await flush();

    click('ledger-owner-picker');
    await flush();
    expect(fake.ownerReads).toBe(1);
    expect(byTestId('ledger-owner-option').textContent).toContain(
      'Build session',
    );
    click('ledger-owner-option');
    await flush();

    expect(fake.entryReads).toEqual([ENTRY_ID]);
    expect(fake.updates).toHaveLength(1);
    const reassigned = entryView(DEFAULT_TITLE, 'TODO', ENTRY_ID, {
      owner: OTHER_CHAT,
      revision: 2,
    });
    readAs(fake, ENTRY_ID, reassigned);
    fake.answer = page([
      item(DEFAULT_TITLE, 'TODO', ENTRY_ID, { owner: OTHER_CHAT }),
    ]);
    fake.updateAnswer = receiptFor(reassigned);
    waiting.resolve();
    fake.holdUpdate = null;
    await flush();

    expect(fake.updates).toEqual([
      {
        scope: SCOPE,
        requestKey: 'request-1',
        params: {
          entryId: ENTRY_ID,
          expectedRevision: 1,
          owner: {
            actorId: OTHER_CHAT.actorId,
            eligibilityToken: 'eligible-1',
          },
        },
      },
    ]);
  });

  it('shows a conflict notice and the latest entry version', async () => {
    const fake = fakeLedger();
    const waiting = gate();
    fake.holdUpdate = waiting.promise;
    renderPanel(fake);
    await flush();

    chooseStatus('IN_PROGRESS');
    await flush();
    const latest = entryView(DEFAULT_TITLE, 'BLOCKED', ENTRY_ID, {
      revision: 2,
    });
    readAs(fake, ENTRY_ID, latest);
    fake.answer = page([item(DEFAULT_TITLE, 'BLOCKED')]);
    fake.updateAnswer = {
      status: 'error',
      reason: 'REVISION_CONFLICT',
      message: 'The entry changed.',
    };
    waiting.resolve();
    fake.holdUpdate = null;
    await flush();

    const notice = byTestId('ledger-entry-change-notice');
    expect(notice.getAttribute('data-notice')).toBe('conflict');
    expect(notice.textContent).toContain(
      'This entry changed. Review the latest version.',
    );
    expect(buttonWithText('Dismiss')).toBeDefined();
    expect(buttonByTestId('ledger-status-control').textContent).toContain(
      'Blocked',
    );
  });

  it('shows a closed notice for a terminal-entry refusal', async () => {
    const fake = fakeLedger();
    const waiting = gate();
    fake.holdUpdate = waiting.promise;
    renderPanel(fake);
    await flush();

    chooseStatus('IN_PROGRESS');
    await flush();
    const closed = entryView(DEFAULT_TITLE, 'COMPLETED', ENTRY_ID, {
      revision: 2,
    });
    readAs(fake, ENTRY_ID, closed);
    fake.answer = page([item(DEFAULT_TITLE, 'COMPLETED')]);
    fake.updateAnswer = {
      status: 'error',
      reason: 'TERMINAL_ENTRY',
      message: 'Terminal.',
    };
    waiting.resolve();
    fake.holdUpdate = null;
    await flush();

    const notice = byTestId('ledger-entry-change-notice');
    expect(notice.getAttribute('data-notice')).toBe('closed');
    expect(notice.textContent).toContain(
      "This entry was closed. It can't change now.",
    );
    expect(buttonWithText('Dismiss')).toBeDefined();
  });

  it('shows an owner-unavailable notice when an assignment is refused', async () => {
    const fake = fakeLedger();
    fake.ownerAnswer = {
      status: 'ok',
      value: { candidates: [OWNER_CANDIDATE], nextCursor: null },
    };
    fake.updateAnswer = {
      status: 'error',
      reason: 'OWNER_UNAVAILABLE',
      message: 'The owner is no longer available.',
    };
    renderPanel(fake);
    await flush();

    click('ledger-owner-picker');
    await flush();
    click('ledger-owner-option');
    await flush();

    const notice = byTestId('ledger-entry-change-notice');
    expect(notice.getAttribute('data-notice')).toBe('owner_unavailable');
    expect(notice.textContent).toContain(
      "That owner can't be assigned anymore. Choose another.",
    );
    expect(buttonWithText('Dismiss')).toBeDefined();
  });

  it('retries a failed change with the same request key', async () => {
    const fake = fakeLedger();
    fake.updateAnswer = {
      status: 'error',
      reason: 'UNKNOWN',
      message: 'Storage details are private.',
    };
    renderPanel(fake);
    await flush();

    chooseStatus('BLOCKED');
    await flush();
    const notice = byTestId('ledger-entry-change-notice');
    expect(notice.getAttribute('data-notice')).toBe('failed');
    expect(notice.textContent).toContain("Couldn't save the change.");
    expect(notice.textContent).not.toContain('Storage details are private.');
    expect(buttonWithText('Try again')).toBeDefined();

    const changedEntry = entryView(DEFAULT_TITLE, 'BLOCKED', ENTRY_ID, {
      revision: 2,
    });
    readAs(fake, ENTRY_ID, changedEntry);
    fake.answer = page([item(DEFAULT_TITLE, 'BLOCKED')]);
    fake.updateAnswer = receiptFor(changedEntry);
    act(() => buttonWithText('Try again').click());
    await flush();

    expect(fake.updates).toHaveLength(2);
    expect(fake.updates[1]).toEqual(fake.updates[0]);
    expect(fake.updates[1]?.requestKey).toBe(fake.updates[0]?.requestKey);
    expect(
      container.querySelector('[data-testid="ledger-entry-change-notice"]'),
    ).toBeNull();
  });

  it('explains a closed entry and has no status or owner controls on it', async () => {
    const fake = fakeLedger();
    fake.answer = page([item('An info entry', 'INFO')]);
    fake.entry = entryView('An info entry', 'INFO');
    renderPanel(fake);
    await flush();

    clickInside(
      entryElement('ledger-entry-row', ENTRY_ID),
      'ledger-entry-details-toggle',
    );
    await flush();

    expect(byTestId('ledger-entry-closed').textContent).toBe(
      "Info entries can't change. Add a correction to record something new.",
    );
    expect(
      entryElement('ledger-entry-row', ENTRY_ID).querySelector(
        '[data-testid="ledger-status-control"]',
      ),
    ).toBeNull();
    expect(
      entryElement('ledger-entry-row', ENTRY_ID).querySelector(
        '[data-testid="ledger-owner-picker"]',
      ),
    ).toBeNull();
  });
});

describe('LedgerPanel source and file actions', () => {
  it('opens a source using the target from its read', async () => {
    const fake = fakeLedger();
    openSource.mockResolvedValue({ ok: true });
    renderPanel(fake);
    await flush();

    click('ledger-entry-source-open');
    await flush();

    expect(fake.entryReads).toEqual([ENTRY_ID]);
    expect(openSource).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({
        kind: 'chat',
        projectId: SCOPE.projectId,
        worktreeId: SCOPE.worktreeId,
        chatId: 'chat-1',
      }),
    );
    expect(
      container.querySelector('[data-testid="ledger-entry-open-error"]'),
    ).toBeNull();
  });

  it('opens the entry and shows an error when its source cannot open', async () => {
    const fake = fakeLedger();
    renderPanel(fake);
    await flush();

    click('ledger-entry-source-open');
    await flush();

    expect(fake.entryReads).toEqual([ENTRY_ID, ENTRY_ID]);
    expect(
      entryElement('ledger-entry-row', ENTRY_ID).getAttribute('aria-current'),
    ).toBe('true');
    expect(
      entryElement('ledger-entry-row', ENTRY_ID).querySelector(
        '[data-testid="ledger-entry-open-error"]',
      )?.textContent,
    ).toBe('That chat is no longer available.');
  });

  it('opens a referenced file through the navigator', async () => {
    const fake = fakeLedger();
    fake.answer = page([
      item(DEFAULT_TITLE, 'TODO', ENTRY_ID, { referenceFiles: [FILE_REF] }),
    ]);
    readAs(
      fake,
      ENTRY_ID,
      entryView(DEFAULT_TITLE, 'TODO', ENTRY_ID, {
        referenceFiles: [FILE_REF],
      }),
    );
    renderPanel(fake);
    await flush();

    click('ledger-entry-file-ref');
    await flush();

    expect(openFile).toHaveBeenCalledWith(SCOPE, FILE_REF);
    expect(
      container.querySelector('[data-testid="ledger-entry-open-error"]'),
    ).toBeNull();
  });

  it('opens the entry and shows a file-open error on that row', async () => {
    const fake = fakeLedger();
    fake.answer = page([
      item(DEFAULT_TITLE, 'TODO', ENTRY_ID, { referenceFiles: [FILE_REF] }),
    ]);
    readAs(
      fake,
      ENTRY_ID,
      entryView(DEFAULT_TITLE, 'TODO', ENTRY_ID, {
        referenceFiles: [FILE_REF],
      }),
    );
    openFile.mockResolvedValue({
      ok: false,
      message: 'The file is unavailable.',
    });
    renderPanel(fake);
    await flush();

    click('ledger-entry-file-ref');
    await flush();

    expect(openFile).toHaveBeenCalledWith(SCOPE, FILE_REF);
    expect(
      entryElement('ledger-entry-row', ENTRY_ID).getAttribute('aria-current'),
    ).toBe('true');
    expect(
      entryElement('ledger-entry-row', ENTRY_ID).querySelector(
        '[data-testid="ledger-entry-open-error"]',
      )?.textContent,
    ).toBe('The file is unavailable.');
  });
});

describe('LedgerPanel composer and corrections', () => {
  it('keeps the new-entry composer available while a correction is open', async () => {
    const fake = fakeLedger();
    const store = renderPanel(fake);
    await flush();

    click('ledger-entry-add-correction');

    expect(byTestId('ledger-correction-box').textContent).toContain('Cancel');
    expect(byTestId('ledger-correction-box').textContent).toContain(
      'Add correction',
    );
    expect(store.getState().selectedEntryId).toBeNull();
    expect(
      entryElement('ledger-entry-row', ENTRY_ID).getAttribute('aria-current'),
    ).toBeNull();

    const addEntry = buttonByTestId('ledger-add-entry');
    expect(addEntry.disabled).toBe(false);
    click('ledger-add-entry');

    expect(byTestId('ledger-entry-form')).toBeDefined();
    expect(byTestId('ledger-correction-box')).toBeDefined();
  });

  it('saves a new entry, closes its form, and leaves the entry unopened', async () => {
    const fake = fakeLedger();
    const store = renderPanel(fake);
    await flush();

    expect(byTestId('ledger-add-entry').textContent).toBe(
      'Add a task, decision or finding',
    );
    click('ledger-add-entry');
    expect(byTestId('ledger-entry-form')).toBeDefined();
    typeInto(byTestId('ledger-entry-form-title'), 'Write release notes');
    typeInto(byTestId('ledger-entry-form-content'), 'Cover the panel.');

    const created = entryView('Write release notes', 'TODO', NEW_ENTRY_ID, {
      type: 'TASK',
    });
    readAs(fake, NEW_ENTRY_ID, created);
    fake.answer = page([
      item('Write release notes', 'TODO', NEW_ENTRY_ID, { type: 'TASK' }),
      item(DEFAULT_TITLE),
    ]);
    fake.addAnswer = receiptFor(created);
    click('ledger-entry-form-save');
    await flush();

    expect(fake.adds).toEqual([
      {
        scope: SCOPE,
        requestKey: 'request-1',
        params: {
          type: 'TASK',
          title: 'Write release notes',
          content: 'Cover the panel.',
          status: 'TODO',
          owner: 'self',
        },
      },
    ]);
    expect(
      container.querySelector('[data-testid="ledger-entry-form"]'),
    ).toBeNull();
    expect(store.getState().selectedEntryId).toBeNull();
    expect(
      entryElement('ledger-entry-row', NEW_ENTRY_ID).getAttribute(
        'aria-current',
      ),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="ledger-entry-details"]'),
    ).toBeNull();
  });

  it('saves a correction from the box without opening the new reply', async () => {
    const fake = fakeLedger();
    const store = renderPanel(fake);
    await flush();

    click('ledger-entry-add-correction');
    typeInto(byTestId('ledger-correction-input'), 'The lock is per scope.');
    const correction = entryView(
      'Keep one ledger writer',
      'TODO',
      CORRECTION_ID,
      {
        supersedesEntryId: ENTRY_ID,
      },
    );
    readAs(fake, CORRECTION_ID, correction);
    fake.answer = page([
      item(DEFAULT_TITLE),
      item('Keep one ledger writer', 'TODO', CORRECTION_ID, {
        supersedesEntryId: ENTRY_ID,
      }),
    ]);
    fake.addAnswer = receiptFor(correction);
    click('ledger-correction-save');
    await flush();

    expect(fake.adds).toHaveLength(1);
    expect(fake.adds[0]?.params).toMatchObject({
      title: DEFAULT_TITLE,
      content: 'The lock is per scope.',
      supersedesEntryId: ENTRY_ID,
    });
    expect(store.getState().selectedEntryId).toBeNull();
    expect(
      entryElement('ledger-entry-correction', CORRECTION_ID).getAttribute(
        'aria-current',
      ),
    ).toBeNull();
  });

  it('keeps a corrected thread in place when the correction makes it newest', async () => {
    const fake = fakeLedger();
    fake.answer = page([
      item('A newer entry', 'TODO', OTHER_ENTRY_ID),
      item(DEFAULT_TITLE),
    ]);
    const store = renderPanel(fake);
    await flush();
    expect(
      Array.from(
        document.querySelectorAll('[data-testid="ledger-entry-thread"]'),
      ).map((thread) => thread.getAttribute('data-root-entry-id')),
    ).toEqual([OTHER_ENTRY_ID, ENTRY_ID]);

    clickInside(threadElement(ENTRY_ID), 'ledger-entry-add-correction');
    typeInto(
      byTestId('ledger-correction-input'),
      'Keep the original in place.',
    );
    const correction = entryView(DEFAULT_TITLE, 'TODO', CORRECTION_ID, {
      supersedesEntryId: ENTRY_ID,
    });
    readAs(fake, CORRECTION_ID, correction);
    fake.answer = page([
      item(DEFAULT_TITLE, 'TODO', CORRECTION_ID, {
        supersedesEntryId: ENTRY_ID,
      }),
      item('A newer entry', 'TODO', OTHER_ENTRY_ID),
      item(DEFAULT_TITLE),
    ]);
    fake.addAnswer = receiptFor(correction);
    click('ledger-correction-save');
    await flush();

    expect(
      Array.from(
        document.querySelectorAll('[data-testid="ledger-entry-thread"]'),
      ).map((thread) => thread.getAttribute('data-root-entry-id')),
    ).toEqual([OTHER_ENTRY_ID, ENTRY_ID]);
    expect(
      threadElement(ENTRY_ID).querySelector(
        '[data-testid="ledger-entry-correction"][data-entry-id="' +
          CORRECTION_ID +
          '"]',
      )?.textContent,
    ).toBeTruthy();
    expect(store.getState().selectedEntryId).toBeNull();
  });

  it('uses More options to save a correction through the full form in its thread', async () => {
    const fake = fakeLedger();
    fake.answer = page([
      item(DEFAULT_TITLE),
      item('Another row', 'TODO', OTHER_ENTRY_ID),
    ]);
    const store = renderPanel(fake);
    await flush();

    click('ledger-entry-add-correction');
    typeInto(byTestId('ledger-correction-input'), 'Use an explicit lock.');
    act(() =>
      store
        .getState()
        .startCorrection(item('Another row', 'TODO', OTHER_ENTRY_ID)),
    );
    click('ledger-correction-more');

    const form = entryElement('ledger-entry-row', ENTRY_ID).querySelector(
      '[data-testid="ledger-entry-form"]',
    );
    if (!(form instanceof HTMLFormElement)) {
      throw new Error('Correction form was not expanded in its thread');
    }
    expect(form.textContent).toContain('Correction');
    expect(
      threadElement(OTHER_ENTRY_ID).querySelector(
        '[data-testid="ledger-correction-box"]',
      ),
    ).not.toBeNull();
    typeInto(byTestId('ledger-entry-form-content'), 'Use an explicit lock.');
    const correction = entryView(
      'Keep one ledger writer',
      'TODO',
      CORRECTION_ID,
      {
        supersedesEntryId: ENTRY_ID,
      },
    );
    readAs(fake, CORRECTION_ID, correction);
    fake.answer = page([
      item(DEFAULT_TITLE),
      item(DEFAULT_TITLE, 'TODO', CORRECTION_ID, {
        supersedesEntryId: ENTRY_ID,
      }),
      item('Another row', 'TODO', OTHER_ENTRY_ID),
    ]);
    fake.addAnswer = receiptFor(correction);
    click('ledger-entry-form-save');
    await flush();

    expect(fake.adds[0]?.params).toMatchObject({
      supersedesEntryId: ENTRY_ID,
      content: 'Use an explicit lock.',
    });
    expect(
      entryElement('ledger-entry-correction', CORRECTION_ID).getAttribute(
        'aria-current',
      ),
    ).toBeNull();
    expect(
      threadElement(OTHER_ENTRY_ID).querySelector(
        '[data-testid="ledger-correction-box"]',
      ),
    ).not.toBeNull();
  });

  it('keeps correction drafts visible without opening or selecting their entries', async () => {
    const fake = fakeLedger();
    fake.answer = page([
      item(DEFAULT_TITLE),
      item('Another row', 'TODO', OTHER_ENTRY_ID),
    ]);
    readAs(
      fake,
      OTHER_ENTRY_ID,
      entryView('Another row', 'TODO', OTHER_ENTRY_ID),
    );
    const store = renderPanel(fake);
    await flush();

    click('ledger-entry-add-correction');
    typeInto(byTestId('ledger-correction-input'), 'Retain this draft.');
    expect(byTestId('ledger-correction-box')).toBeDefined();
    expect(inputValue(byTestId('ledger-correction-input'))).toBe(
      'Retain this draft.',
    );
    expect(store.getState().selectedEntryId).toBeNull();
    expect(
      entryElement('ledger-entry-row', ENTRY_ID).getAttribute('aria-current'),
    ).toBeNull();
  });

  it('cancels a correction draft from its box', async () => {
    const fake = fakeLedger();
    renderPanel(fake);
    await flush();

    click('ledger-entry-add-correction');
    typeInto(byTestId('ledger-correction-input'), 'Cancel this.');
    click('ledger-correction-discard');

    expect(
      container.querySelector('[data-testid="ledger-correction-box"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="ledger-entry-add-correction"]'),
    ).not.toBeNull();
  });

  it('puts a correction of a reply in the root thread and labels what it corrects', async () => {
    const fake = fakeLedger();
    fake.answer = page([
      item(DEFAULT_TITLE),
      item('First correction', 'TODO', REPLY_ID, {
        supersedesEntryId: ENTRY_ID,
      }),
    ]);
    readAs(
      fake,
      REPLY_ID,
      entryView('First correction', 'TODO', REPLY_ID, {
        supersedesEntryId: ENTRY_ID,
      }),
    );
    renderPanel(fake);
    await flush();

    clickInside(
      entryElement('ledger-entry-correction', REPLY_ID),
      'ledger-entry-add-correction',
    );
    typeInto(byTestId('ledger-correction-input'), 'Correct that reply.');
    const correction = entryView(
      'First correction',
      'TODO',
      REPLY_CORRECTION_ID,
      {
        supersedesEntryId: REPLY_ID,
      },
    );
    readAs(fake, REPLY_CORRECTION_ID, correction);
    fake.answer = page([
      item(DEFAULT_TITLE),
      item('First correction', 'TODO', REPLY_ID, {
        supersedesEntryId: ENTRY_ID,
      }),
      item('First correction', 'TODO', REPLY_CORRECTION_ID, {
        supersedesEntryId: REPLY_ID,
      }),
    ]);
    fake.addAnswer = receiptFor(correction);
    click('ledger-correction-save');
    await flush();

    const savedReply = entryElement(
      'ledger-entry-correction',
      REPLY_CORRECTION_ID,
    );
    expect(savedReply.textContent).toContain('Corrects a reply');
    expect(savedReply.getAttribute('aria-current')).toBeNull();
    expect(
      threadElement(ENTRY_ID).querySelector(
        '[data-testid="ledger-correction-box"]',
      ),
    ).toBeNull();
  });

  it('keeps multiple correction drafts and a new-entry draft at once', async () => {
    const fake = fakeLedger();
    fake.answer = page([
      item(DEFAULT_TITLE),
      item('A reply', 'TODO', REPLY_ID, { supersedesEntryId: ENTRY_ID }),
      item('Another row', 'TODO', OTHER_ENTRY_ID),
    ]);
    const store = renderPanel(fake);
    await flush();

    act(() => {
      store.getState().startCorrection(item(DEFAULT_TITLE));
      store.getState().updateCorrection(ENTRY_ID, {
        content: 'First in this thread.',
      });
      store
        .getState()
        .startCorrection(
          item('A reply', 'TODO', REPLY_ID, { supersedesEntryId: ENTRY_ID }),
        );
      store.getState().updateCorrection(REPLY_ID, {
        content: 'Second in this thread.',
      });
      store
        .getState()
        .startCorrection(item('Another row', 'TODO', OTHER_ENTRY_ID));
      store.getState().updateCorrection(OTHER_ENTRY_ID, {
        content: 'A different thread.',
      });
    });
    click('ledger-add-entry');
    typeInto(byTestId('ledger-entry-form-content'), 'A new task.');

    const sameThreadBoxes = threadElement(ENTRY_ID).querySelectorAll(
      '[data-testid="ledger-correction-box"]',
    );
    expect(
      Array.from(sameThreadBoxes, (box) =>
        inputValue(
          box.querySelector('[data-testid="ledger-correction-input"]'),
        ),
      ),
    ).toEqual(['First in this thread.', 'Second in this thread.']);
    expect(
      threadElement(OTHER_ENTRY_ID).querySelector(
        '[data-testid="ledger-correction-box"]',
      ),
    ).not.toBeNull();
    expect(byTestId('ledger-entry-form')).toBeDefined();

    const cancelFirst = sameThreadBoxes[0]?.querySelector(
      '[data-testid="ledger-correction-discard"]',
    );
    if (!(cancelFirst instanceof HTMLButtonElement)) {
      throw new Error('First correction has no Cancel button');
    }
    act(() => cancelFirst.click());
    expect(
      threadElement(ENTRY_ID).querySelectorAll(
        '[data-testid="ledger-correction-box"]',
      ),
    ).toHaveLength(1);
    expect(byTestId('ledger-entry-form')).toBeDefined();
  });

  it('allows a correction while a new-entry draft is set aside', async () => {
    const fake = fakeLedger();
    const store = renderPanel(fake);
    await flush();

    click('ledger-add-entry');
    await act(async () => {
      await store.getState().select(ENTRY_ID);
    });
    await flush();

    expect(byTestId('ledger-add-entry').textContent).toBe('Continue draft');
    const addCorrection = entryElement(
      'ledger-entry-row',
      ENTRY_ID,
    ).querySelector('[data-testid="ledger-entry-add-correction"]');
    if (!(addCorrection instanceof HTMLButtonElement)) {
      throw new Error('Entry row has no correction action');
    }
    expect(addCorrection.disabled).toBe(false);
    act(() => addCorrection.click());
    expect(byTestId('ledger-correction-box')).toBeDefined();
    expect(byTestId('ledger-add-entry').textContent).toBe('Continue draft');
  });

  it('shows an unlisted correction form above the entries with its target title', async () => {
    const fake = fakeLedger();
    const store = renderPanel(fake);
    await flush();
    act(() => store.getState().startCorrection(item(DEFAULT_TITLE)));
    fake.answer = page([]);
    act(() => store.getState().setQueryText('hidden target'));
    await act(() => store.getState().load());

    const form = byTestId('ledger-entry-form');
    expect(form.textContent).toContain(`Corrects "${DEFAULT_TITLE}"`);
    expect(
      container.querySelector('[data-testid="ledger-correction-box"]'),
    ).toBeNull();
  });

  it('disables Add correction while the row title is still being written', async () => {
    const fake = fakeLedger();
    fake.answer = page([
      item(DEFAULT_TITLE, 'TODO', ENTRY_ID, { titlePending: true }),
    ]);
    renderPanel(fake);
    await flush();

    const addCorrection = buttonByTestId('ledger-entry-add-correction');
    expect(addCorrection.disabled).toBe(true);
    expect(addCorrection.getAttribute('aria-description')).toBe(
      'Its title is still being written.',
    );
  });

  it('typing in one correction box does not re-render the thread list or the other box', async () => {
    const fake = fakeLedger();
    fake.answer = page([
      item(DEFAULT_TITLE),
      item('Another row', 'TODO', OTHER_ENTRY_ID),
    ]);
    const store = renderPanel(fake);
    await flush();
    act(() => {
      store.getState().startCorrection(item(DEFAULT_TITLE));
      store
        .getState()
        .startCorrection(item('Another row', 'TODO', OTHER_ENTRY_ID));
    });

    const beforeList = mockLedgerThreadListRenderCount;
    const beforeBoxes = mockLedgerCorrectionBoxRenderCount;
    typeInto(byTestId('ledger-correction-input'), 'Only this box changes.');

    expect(mockLedgerThreadListRenderCount).toBe(beforeList);
    expect(mockLedgerCorrectionBoxRenderCount).toBe(beforeBoxes + 1);
    expect(inputValue(byTestId('ledger-correction-input'))).toBe(
      'Only this box changes.',
    );
  });
});

describe('LedgerPanel scroll and render isolation', () => {
  it('restores scroll position on mount and saves subsequent scrolls', async () => {
    const fake = fakeLedger();
    const store = createLedgerViewStore(fake.client, SCOPE);
    await act(async () => {
      await store.getState().load();
    });
    act(() => store.getState().setScrollTop(164));
    act(() =>
      root.render(
        <LedgerPanel
          store={store}
          client={fake.client}
          navigator={navigator}
        />,
      ),
    );
    await flush();

    const pane = byTestId('ledger-list-pane');
    expect(pane.scrollTop).toBe(164);
    pane.scrollTop = 72;
    void act(() => {
      pane.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(store.getState().scrollTop).toBe(72);
  });

  it('does not re-render the thread list while search text is being typed', async () => {
    jest.useFakeTimers();
    const fake = fakeLedger();
    renderPanel(fake);
    await flush();

    const renders = mockLedgerThreadListRenderCount;
    expect(renders).toBeGreaterThan(0);
    typeInto(inputByTestId('ledger-search'), 'new query');

    expect(inputValue(inputByTestId('ledger-search'))).toBe('new query');
    expect(mockLedgerThreadListRenderCount).toBe(renders);
  });
});

function inputValue(element: HTMLElement | null): string {
  if (
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLInputElement
  ) {
    return element.value;
  }
  throw new Error('Expected a text input');
}
