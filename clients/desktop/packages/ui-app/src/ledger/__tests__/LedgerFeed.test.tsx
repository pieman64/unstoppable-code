/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as ReactModule from 'react';
import type * as SharedComponentsModule from '@canopy/ui-shared/components';
import type {
  LedgerClient,
  LedgerFeedClient,
  LedgerNavigator,
} from '@canopy/app-core';
import {
  createLedgerFeedStore,
  createLedgerViewStore,
  type LedgerFeedStore,
  type LedgerViewStore,
} from '@canopy/app-state';
import type {
  LedgerActorRef,
  LedgerEntrySearchItem,
  LedgerFileRef,
  LedgerMutation,
  LedgerOwnerCandidate,
  LedgerStatus,
} from '@canopy/protocol/canopy-core';
import type {
  LedgerFeedEntryRequest,
  LedgerFeedPage,
  LedgerFeedRequest,
  LedgerFeedRow,
  LedgerViewAddRequest,
  LedgerViewChangedEvent,
  LedgerViewEntry,
  LedgerViewReceipt,
  LedgerViewResult,
  LedgerTaskViewScope,
  LedgerViewScope,
  LedgerViewUpdateRequest,
} from '@canopy/protocol/ledger-view';
import {
  isLedgerTaskViewScope,
  ledgerViewScopeKey,
} from '@canopy/protocol/ledger-view';

/** The test's key for a scope's store: a task's project and worktree. */
function testScopeKey(scope: LedgerViewScope): string {
  return isLedgerTaskViewScope(scope)
    ? scope.projectId + '/' + scope.worktreeId
    : ledgerViewScopeKey(scope);
}
import { LEDGER_FEED_CHANGE_DELAY_MS, LedgerFeed } from '../LedgerFeed';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

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
const OTHER_SCOPE: LedgerTaskViewScope = {
  projectId: 'project-2',
  worktreeId: 'wt-2',
};
const USER: LedgerActorRef = {
  actorId: '00000000-0000-4000-8000-0000000000a1',
  kind: 'user',
  authorityId: 'authority-1',
};
const TEAMMATE_USER: LedgerActorRef = {
  actorId: '00000000-0000-4000-8000-0000000000a2',
  kind: 'user',
  authorityId: 'authority-2',
};
const FILE_REF: LedgerFileRef = {
  rootId: '00000000-0000-4000-8000-0000000000201',
  path: 'src/ledger.ts',
  startLine: 12,
};

interface ItemOptions {
  readonly owner?: LedgerActorRef;
  readonly referenceFiles?: readonly LedgerFileRef[];
  readonly status?: LedgerStatus;
  readonly supersedesEntryId?: string;
  readonly title?: string;
  readonly titlePending?: true;
  readonly type?: LedgerEntrySearchItem['type'];
}

function item(
  index: number,
  author: LedgerActorRef = USER,
  revision = 1,
  options: ItemOptions = {},
): LedgerEntrySearchItem {
  return {
    entryId: '00000000-0000-4000-8000-' + String(index).padStart(12, '0'),
    revision,
    type: options.type ?? 'DECISION',
    title: options.title ?? 'Decision ' + String(index),
    content: 'Keep one writer.',
    highlights: [],
    referenceFiles: [...(options.referenceFiles ?? [])],
    status: options.status ?? 'TODO',
    owner: options.owner ?? author,
    author,
    attributionKind: 'self_reported',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    ...(options.supersedesEntryId === undefined
      ? {}
      : { supersedesEntryId: options.supersedesEntryId }),
    ...(options.titlePending === true ? { titlePending: true } : {}),
    sourceAvailability: 'available',
  };
}

function localRow(
  index: number,
  scope: LedgerViewScope = SCOPE,
): LedgerFeedRow {
  return {
    entry: item(index),
    ledgerId:
      '00000000-0000-4000-8000-' + String(300 + index).padStart(12, '0'),
    scopeKind: 'code_worktree',
    scopeArchived: false,
    origin: { kind: 'this_device', scope },
  };
}

const LOCAL = localRow(1);
const OTHER_DEVICE: LedgerFeedRow = {
  entry: item(2),
  ledgerId: '00000000-0000-4000-8000-0000000000e2',
  scopeKind: 'cowork_entry',
  scopeArchived: false,
  origin: { kind: 'other_device', deviceLabel: 'Studio Mac' },
};
const TEAMMATE: LedgerFeedRow = {
  entry: item(3, TEAMMATE_USER),
  ledgerId: '00000000-0000-4000-8000-0000000000e3',
  scopeKind: 'code_worktree',
  scopeArchived: false,
  origin: {
    kind: 'teammate',
    teammateName: 'Ada Lovelace',
    organizationName: 'Acme',
  },
};

function page(
  rows: LedgerFeedRow[],
  options: {
    readonly hasMore?: boolean;
    readonly nextCursor?: string | null;
    readonly notice?: LedgerFeedPage['notice'];
  } = {},
): LedgerViewResult<LedgerFeedPage> {
  const nextCursor = options.nextCursor ?? null;
  return {
    status: 'ok',
    value: {
      rows,
      actors: [
        { actorId: USER.actorId, kind: 'user', displayName: 'You' },
        // A teammate's device calls its own user "You" too.
        { actorId: TEAMMATE_USER.actorId, kind: 'user', displayName: 'You' },
      ],
      nextCursor,
      hasMore: options.hasMore ?? nextCursor !== null,
      notice: options.notice ?? null,
    },
  };
}

function authorDetails(): LedgerViewEntry['entry']['entry']['authorDetails'] {
  return {
    harness: null,
    model: null,
    thinkingEffort: null,
    mode: null,
    pipelineExecutionId: null,
    settingsRevision: null,
    unavailableReason: 'not_applicable',
  };
}

function entryView(
  row: LedgerFeedRow,
  sourceAvailability: 'available' | 'not_on_this_device',
  mutations: readonly LedgerMutation[] = [],
  options: { readonly titlePending?: true } = {},
): LedgerViewResult<LedgerViewEntry> {
  const { entry } = row;
  const scope =
    row.origin.kind === 'this_device' && isLedgerTaskViewScope(row.origin.scope)
      ? row.origin.scope
      : SCOPE;
  const details = authorDetails();
  return {
    status: 'ok',
    value: {
      entry: {
        entry: {
          schemaVersion: 1,
          entryId: entry.entryId,
          scope: {
            ledgerId: row.ledgerId,
            authorityId: entry.author.authorityId,
            container: {
              kind: 'code_worktree',
              workspaceId: scope.projectId,
              worktreeId: scope.worktreeId,
            },
          },
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          revision: entry.revision,
          author: entry.author,
          authorDetails: details,
          owner: entry.owner,
          type: entry.type,
          title: entry.title,
          content: entry.content,
          highlights: [],
          referenceFiles: [...entry.referenceFiles],
          status: entry.status,
          origin: {
            kind: 'user',
            ledgerId: row.ledgerId,
            userActorId: entry.author.actorId,
          },
          attribution: {
            kind: 'self_reported',
            effectiveActor: entry.author,
            recordedBy: entry.author,
            executorDetails: details,
          },
          ...(entry.supersedesEntryId === undefined
            ? {}
            : { supersedesEntryId: entry.supersedesEntryId }),
        },
        sourceAvailability,
        history: { mutations: [...mutations], nextCursor: null },
        actors: [
          {
            actorId: entry.author.actorId,
            kind: 'user',
            displayName: 'You',
          },
        ],
        ...(options.titlePending === true ? { titlePending: true } : {}),
      },
      source: { availability: sourceAvailability, target: null },
    },
  };
}

function updateMutation(row: LedgerFeedRow): LedgerMutation {
  const details = authorDetails();
  return {
    mutationId: '00000000-0000-4000-8000-0000000000901',
    entryId: row.entry.entryId,
    kind: 'update',
    revision: 2,
    previousRevision: 1,
    occurredAt: '2026-10-02T10:00:00.000Z',
    status: { from: 'TODO', to: 'IN_PROGRESS' },
    attribution: {
      kind: 'self_reported',
      effectiveActor: row.entry.author,
      recordedBy: row.entry.author,
      executorDetails: details,
    },
    invocationOrigin: {
      kind: 'user',
      ledgerId: row.ledgerId,
      userActorId: row.entry.author.actorId,
    },
  };
}

type EntryAnswer = LedgerViewResult<LedgerViewEntry>;
type ReceiptAnswer = LedgerViewResult<LedgerViewReceipt>;
type OwnersAnswer = Awaited<ReturnType<LedgerClient['listOwners']>>;

interface Fakes {
  readonly client: LedgerClient;
  readonly feed: LedgerFeedClient;
  readonly searches: LedgerFeedRequest[];
  readonly entryReads: LedgerFeedEntryRequest[];
  readonly localReads: string[];
  readonly adds: LedgerViewAddRequest[];
  readonly updates: LedgerViewUpdateRequest[];
  readonly localEntryViews: Map<string, EntryAnswer>;
  readonly remoteEntryViews: Map<string, EntryAnswer>;
  readonly updateAnswers: ReceiptAnswer[];
  answers: Array<LedgerViewResult<LedgerFeedPage>>;
  addAnswer: ReceiptAnswer;
  updateAnswer: ReceiptAnswer;
  ownerAnswer: OwnersAnswer;
  hold: Promise<void> | null;
  holdUpdate: Promise<void> | null;
  ownerReads: number;
  emit(event: LedgerViewChangedEvent): void;
}

function fakes(): Fakes {
  const handlers = new Set<(event: LedgerViewChangedEvent) => void>();
  const result: Fakes = {
    searches: [],
    entryReads: [],
    localReads: [],
    adds: [],
    updates: [],
    localEntryViews: new Map(),
    remoteEntryViews: new Map(),
    updateAnswers: [],
    answers: [],
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
    hold: null,
    holdUpdate: null,
    ownerReads: 0,
    emit: (event): void => handlers.forEach((handler) => handler(event)),
    client: {
      searchEntries: () =>
        Promise.resolve({
          status: 'ok',
          value: {
            entries: [],
            nextCursor: null,
            hasMore: false,
            watermark: '0',
          },
        }),
      getEntry: (request) => {
        result.localReads.push(request.entryId);
        return Promise.resolve(
          result.localEntryViews.get(request.entryId) ??
            entryView(LOCAL, 'available'),
        );
      },
      addEntry: (request) => {
        result.adds.push(request);
        return Promise.resolve(result.addAnswer);
      },
      updateEntry: async (request) => {
        result.updates.push(request);
        const answer = result.updateAnswers.shift() ?? result.updateAnswer;
        if (result.holdUpdate !== null) await result.holdUpdate;
        return answer;
      },
      listOwners: () => {
        result.ownerReads += 1;
        return Promise.resolve(result.ownerAnswer);
      },
      subscribeChanges: (handler) => {
        handlers.add(handler);
        return (): void => {
          handlers.delete(handler);
        };
      },
    },
    feed: {
      searchFeed: async (request) => {
        result.searches.push(request);
        const answer = result.answers.shift() ?? page([]);
        if (result.hold !== null) await result.hold;
        return answer;
      },
      getFeedEntry: (request) => {
        result.entryReads.push(request);
        return Promise.resolve(
          result.remoteEntryViews.get(request.entryId) ??
            entryView(TEAMMATE, 'not_on_this_device'),
        );
      },
    },
  };
  return result;
}

const openFile = jest.fn<
  ReturnType<LedgerNavigator['openFile']>,
  Parameters<LedgerNavigator['openFile']>
>(() => Promise.resolve({ ok: true }));
const navigator: LedgerNavigator = {
  openSource: () => Promise.resolve({ ok: true }),
  openFile,
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  mockLedgerThreadListRenderCount = 0;
  mockLedgerCorrectionBoxRenderCount = 0;
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
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });
}

function byTestId(testId: string): HTMLElement {
  const element = document.querySelector('[data-testid="' + testId + '"]');
  if (!(element instanceof HTMLElement)) throw new Error('Missing ' + testId);
  return element;
}

function allByTestId(testId: string): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="' + testId + '"]'),
  );
}

function rowFor(entryId: string): HTMLElement {
  const element = document.querySelector(
    '[data-testid="ledger-entry-row"][data-entry-id="' + entryId + '"]',
  );
  if (!(element instanceof HTMLElement))
    throw new Error('Missing row ' + entryId);
  return element;
}

function threadFor(rootEntryId: string): HTMLElement {
  const element = document.querySelector(
    '[data-testid="ledger-entry-thread"][data-root-entry-id="' +
      rootEntryId +
      '"]',
  );
  if (!(element instanceof HTMLElement)) {
    throw new Error('Missing thread ' + rootEntryId);
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

function click(element: HTMLElement): void {
  act(() => element.click());
}

function clickInside(element: HTMLElement, testId: string): void {
  const target = element.querySelector('[data-testid="' + testId + '"]');
  if (!(target instanceof HTMLButtonElement)) {
    throw new Error('Missing button ' + testId);
  }
  click(target);
}

function statusControl(element: HTMLElement): HTMLElement {
  const control = element.querySelector(
    '[data-testid="ledger-status-control"]',
  );
  if (!(control instanceof HTMLElement)) {
    throw new Error('Missing Ledger status control');
  }
  return control;
}

function buttonByTestId(testId: string): HTMLButtonElement {
  const element = byTestId(testId);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(testId + ' is not a button');
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

/** Types into a React-controlled input or text area. */
function typeInto(element: HTMLElement, value: string): void {
  if (element instanceof HTMLTextAreaElement) {
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set?.bind(element);
    if (setValue === undefined) {
      throw new Error('Textarea has no value setter');
    }
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
    if (setValue === undefined) {
      throw new Error('Input has no value setter');
    }
    act(() => {
      setValue(value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return;
  }
  throw new Error('Expected an input or textarea');
}

function inputValue(element: HTMLElement): string {
  if (
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLInputElement
  ) {
    return element.value;
  }
  throw new Error('Expected a text input');
}

/** Opens a target picker and chooses the row with that text. */
function choose(picker: string, label: string): void {
  click(buttonByTestId(picker));
  const option = allByTestId(picker + '-option').find(
    (candidate) => candidate.textContent === label,
  );
  if (option === undefined) throw new Error('Missing option ' + label);
  click(option);
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

interface RenderFeedOptions {
  readonly onSignIn?: () => void;
  /** A host that only reads the mirror: no Ledger of its own. */
  readonly mirrorOnly?: boolean;
}

function renderFeed(
  fake: Fakes,
  options: RenderFeedOptions = {},
): {
  readonly scopeStores: Map<string, LedgerViewStore>;
  readonly scopeStore: (scope: LedgerViewScope) => LedgerViewStore;
  readonly store: LedgerFeedStore;
  readonly render: (visible?: boolean) => void;
} {
  const store = createLedgerFeedStore(fake.feed);
  const scopeStores = new Map<string, LedgerViewStore>();
  const scopeStore = (scope: LedgerViewScope): LedgerViewStore => {
    const key = testScopeKey(scope);
    let existing = scopeStores.get(key);
    if (existing === undefined) {
      existing = createLedgerViewStore(fake.client, scope);
      scopeStores.set(key, existing);
    }
    return existing;
  };
  const render = (visible = true): void => {
    act(() =>
      root.render(
        <LedgerFeed
          store={store}
          {...(options.mirrorOnly === true
            ? { audiences: ['mine', 'teammates'] as const }
            : {
                local: {
                  client: fake.client,
                  navigator,
                  scopeStore,
                  scopeHasDraft: (scope: LedgerViewScope): boolean => {
                    const scopeState = scopeStores
                      .get(testScopeKey(scope))
                      ?.getState();
                    return (
                      scopeState !== undefined &&
                      (scopeState.composer.draft !== null ||
                        Object.keys(scopeState.corrections).length > 0)
                    );
                  },
                  describeScope: (scope: LedgerViewScope): string | null =>
                    isLedgerTaskViewScope(scope) &&
                    scope.worktreeId === SCOPE.worktreeId
                      ? 'Canopy · fix-parser'
                      : null,
                  addableScopes: [
                    { scope: SCOPE, label: 'fix-parser', project: 'Canopy' },
                    {
                      scope: OTHER_SCOPE,
                      label: 'launch-notes',
                      project: 'Docs',
                    },
                  ],
                },
              })}
          visible={visible}
          {...(options.onSignIn === undefined
            ? {}
            : { onSignIn: options.onSignIn })}
        />,
      ),
    );
  };
  render();
  return { scopeStores, scopeStore, store, render };
}

function chooseStatus(status: LedgerStatus): void {
  click(buttonByTestId('ledger-status-control'));
  click(buttonByTestId('ledger-status-option-' + status.toLowerCase()));
}

const OWNER_CANDIDATE: LedgerOwnerCandidate = {
  actor: TEAMMATE_USER,
  displayName: 'Build session',
  eligibilityToken: 'eligible-1',
  isSelf: false,
};

describe('LedgerFeed list and search', () => {
  it('refreshes retained results on re-entry without losing the search, selection or draft', async () => {
    const fake = fakes();
    fake.answers.push(page([LOCAL]));
    const { store, render, scopeStore } = renderFeed(fake);
    await flush();
    const initialSearches = fake.searches.length;
    act(() => store.getState().startEntry(scopeStore));
    act(() => store.getState().updateDraft({ content: 'Keep this draft' }));
    await act(() => store.getState().select(LOCAL.entry.entryId));
    act(() => store.getState().setQueryText('parser'));
    act(() =>
      store.setState({
        filters: { ...store.getState().filters, period: 'day' },
      }),
    );
    const before = store.getState();
    act(() => root.render(null));
    fake.answers.push(page([OTHER_DEVICE, LOCAL]));
    render();
    await flush();

    expect(rowFor(OTHER_DEVICE.entry.entryId)).toBeDefined();
    expect(store.getState().newActivity).toBe(false);
    expect(fake.searches).toHaveLength(initialSearches + 1);
    expect(fake.searches.at(-1)).toMatchObject({
      query: 'parser',
      refresh: true,
      filters: before.filters,
    });
    expect(fake.searches.at(-1)?.peek).toBeUndefined();
    expect(store.getState().selectedEntryId).toBe(before.selectedEntryId);
    expect(store.getState().composer).toEqual(before.composer);
  });

  it('keeps new activity waiting when the document becomes visible while still on Feed', async () => {
    const fake = fakes();
    fake.answers.push(page([LOCAL]));
    const { store, render } = renderFeed(fake);
    await flush();
    render(false);
    await flush();
    const searchesBefore = fake.searches.length;
    fake.answers.push(page([OTHER_DEVICE, LOCAL]));
    render(true);
    await flush();
    expect(store.getState().newActivity).toBe(true);
    expect(store.getState().list.rows).toEqual([LOCAL]);
    expect(fake.searches).toHaveLength(searchesBefore + 1);
    render(true);
    await flush();
    expect(fake.searches).toHaveLength(searchesBefore + 1);

    fake.answers.push(page([OTHER_DEVICE, LOCAL]));
    await act(() => store.getState().checkForNewActivity());
    expect(store.getState().newActivity).toBe(true);
    expect(
      document.querySelector(`[data-entry-id="${OTHER_DEVICE.entry.entryId}"]`),
    ).toBeNull();
    expect(buttonByTestId('ledger-feed-new-activity')).toBeDefined();
  });

  it('attributes each entry with its context, device, or teammate', async () => {
    const fake = fakes();
    fake.answers.push(page([LOCAL, OTHER_DEVICE, TEAMMATE]));
    renderFeed(fake);
    await flush();

    expect(fake.searches[0]?.audience).toBe('mine');
    expect(rowFor(LOCAL.entry.entryId).dataset['origin']).toBeUndefined();
    expect(
      rowFor(LOCAL.entry.entryId).querySelector(
        '[data-testid="ledger-entry-row-context"]',
      )?.textContent,
    ).toBe('Canopy · fix-parser');
    expect(rowFor(OTHER_DEVICE.entry.entryId).dataset['origin']).toBe('device');
    expect(
      rowFor(OTHER_DEVICE.entry.entryId).querySelector(
        '[data-testid="ledger-entry-row-device"]',
      )?.textContent,
    ).toBe('Studio Mac');
    const teammate = rowFor(TEAMMATE.entry.entryId);
    expect(teammate.dataset['origin']).toBe('teammate');
    expect(
      teammate.querySelector('[data-testid="ledger-entry-row-teammate"]')
        ?.textContent,
    ).toBe('Acme');
    expect(teammate.textContent).toContain('Ada Lovelace');
    expect(teammate.textContent).toContain('Acme');
    expect(teammate.textContent).not.toContain('You');
  });

  it('labels workflow rows by their owner, beside any teammate or device', async () => {
    const ORG_ID = '7f0c1d2e-3b4a-4c5d-8e6f-901234567890';
    const globalLocal: LedgerFeedRow = {
      entry: item(4),
      ledgerId: '00000000-0000-4000-8000-0000000000e4',
      scopeKind: 'global',
      scopeArchived: false,
      origin: {
        kind: 'this_device',
        scope: {
          kind: 'global',
          owner: { kind: 'personal' },
          ledgerId: '00000000-0000-4000-8000-0000000000e4',
        },
      },
    };
    const globalTeammate: LedgerFeedRow = {
      entry: item(5, TEAMMATE_USER),
      ledgerId: '00000000-0000-4000-8000-0000000000e5',
      scopeKind: 'global',
      scopeArchived: false,
      origin: {
        kind: 'teammate',
        teammateName: 'Ada Lovelace',
        organizationName: 'Acme',
      },
      global: {
        owner: { kind: 'organization', organizationId: ORG_ID },
        organizationName: 'Acme',
      },
    };
    const globalUnnamed: LedgerFeedRow = {
      entry: item(6),
      ledgerId: '00000000-0000-4000-8000-0000000000e6',
      scopeKind: 'global',
      scopeArchived: false,
      origin: { kind: 'other_device', deviceLabel: 'Studio Mac' },
      global: { owner: { kind: 'organization', organizationId: ORG_ID } },
    };
    const fake = fakes();
    fake.answers.push(page([globalLocal, globalTeammate, globalUnnamed]));
    renderFeed(fake);
    await flush();

    const contextOf = (entryId: string): Element | null =>
      rowFor(entryId).querySelector('[data-testid="ledger-entry-row-context"]');
    // This device has no name for its own workflow scope here, so the row
    // falls back to its owner.
    expect(contextOf(globalLocal.entry.entryId)?.textContent).toBe(
      'Workflows · Personal',
    );
    const teammateContext = contextOf(globalTeammate.entry.entryId);
    expect(teammateContext?.textContent).toBe('Workflows · Acme');
    expect(teammateContext?.getAttribute('title')).toBe('Workflows · Acme');
    expect(
      rowFor(globalTeammate.entry.entryId).querySelector(
        '[data-testid="ledger-entry-row-teammate"]',
      )?.textContent,
    ).toBe('Acme');
    // Without a name the reader may see, the row reads as Workflows alone.
    expect(contextOf(globalUnnamed.entry.entryId)?.textContent).toBe(
      'Workflows',
    );
    expect(
      rowFor(globalUnnamed.entry.entryId).querySelector(
        '[data-testid="ledger-entry-row-device"]',
      )?.textContent,
    ).toBe('Studio Mac');
  });

  it('switches audiences', async () => {
    const fake = fakes();
    renderFeed(fake);
    await flush();

    fake.answers.push(page([TEAMMATE]));
    click(buttonByTestId('ledger-feed-audience-teammates'));
    await flush();
    fake.answers.push(page([LOCAL]));
    click(buttonByTestId('ledger-feed-audience-this_device'));
    await flush();

    expect(fake.searches.map((search) => search.audience)).toEqual([
      'mine',
      'teammates',
      'this_device',
    ]);
    expect(
      byTestId('ledger-feed-audience-this_device').getAttribute(
        'aria-selected',
      ),
    ).toBe('true');
  });

  it("blocks only the teammate's name in the read-only note", async () => {
    const fake = fakes();
    fake.answers.push(page([TEAMMATE]));
    fake.remoteEntryViews.set(
      TEAMMATE.entry.entryId,
      entryView(TEAMMATE, 'not_on_this_device'),
    );
    renderFeed(fake);
    await flush();

    clickInside(rowFor(TEAMMATE.entry.entryId), 'ledger-entry-details-toggle');
    await flush();

    const note = byTestId('ledger-feed-read-only');
    expect(note.textContent).toBe(
      'Ada Lovelace recorded this entry. Only they can change it.',
    );
    expect(note.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
    expect(
      Array.from(
        note.querySelectorAll(`.${REPLAY_BLOCK_CLASS}`),
        (block) => block.textContent,
      ),
    ).toEqual(['Ada Lovelace']);
  });

  it('opens a teammate entry read only under their name in the Feed detail', async () => {
    const fake = fakes();
    fake.answers.push(page([TEAMMATE]));
    fake.remoteEntryViews.set(
      TEAMMATE.entry.entryId,
      entryView(TEAMMATE, 'not_on_this_device'),
    );
    const { store } = renderFeed(fake);
    await flush();

    clickInside(rowFor(TEAMMATE.entry.entryId), 'ledger-entry-details-toggle');
    await flush();

    expect(fake.entryReads).toEqual([{ entryId: TEAMMATE.entry.entryId }]);
    expect(store.getState().remoteDetail.entryId).toBe(TEAMMATE.entry.entryId);
    expect(rowFor(TEAMMATE.entry.entryId).getAttribute('aria-current')).toBe(
      'true',
    );
    expect(byTestId('ledger-feed-read-only').textContent).toBe(
      'Ada Lovelace recorded this entry. Only they can change it.',
    );
    const detailFields = Array.from(
      byTestId('ledger-entry-details').querySelectorAll('dt, dd'),
      (field) => field.textContent,
    );
    expect(detailFields.slice(0, 2)).toEqual(['Added by', 'Ada Lovelace']);
    expect(byTestId('ledger-entry-details').textContent).not.toMatch(
      /\byou\b/i,
    );
  });

  it("reads a teammate correction's target that has no loaded row", async () => {
    const fake = fakes();
    const target: LedgerFeedRow = {
      ...TEAMMATE,
      entry: item(8, TEAMMATE_USER),
    };
    const correction: LedgerFeedRow = {
      ...TEAMMATE,
      entry: item(9, TEAMMATE_USER, 1, {
        supersedesEntryId: target.entry.entryId,
      }),
    };
    fake.answers.push(page([correction]));
    fake.remoteEntryViews.set(
      correction.entry.entryId,
      entryView(correction, 'not_on_this_device'),
    );
    fake.remoteEntryViews.set(
      target.entry.entryId,
      entryView(target, 'not_on_this_device'),
    );
    const { store } = renderFeed(fake);
    await flush();
    clickInside(
      rowFor(correction.entry.entryId),
      'ledger-entry-details-toggle',
    );
    await flush();

    click(buttonByTestId('ledger-entry-supersedes'));
    await flush();

    expect(fake.entryReads).toEqual([
      { entryId: correction.entry.entryId },
      { entryId: target.entry.entryId },
    ]);
    const { remoteDetail, selectedEntryId } = store.getState();
    expect(selectedEntryId).toBe(target.entry.entryId);
    expect(remoteDetail.status).toBe('ready');
    expect(remoteDetail.entryId).toBe(target.entry.entryId);
    expect(remoteDetail.origin).toEqual(TEAMMATE.origin);
    expect(threadFor(target.entry.entryId).dataset['pinned']).toBe('true');
  });

  it('keeps a teammate entry under their name after a search drops its row', async () => {
    const fake = fakes();
    fake.answers.push(page([TEAMMATE]));
    fake.remoteEntryViews.set(
      TEAMMATE.entry.entryId,
      entryView(TEAMMATE, 'not_on_this_device'),
    );
    const { store } = renderFeed(fake);
    await flush();
    clickInside(rowFor(TEAMMATE.entry.entryId), 'ledger-entry-details-toggle');
    await flush();

    fake.answers.push(page([LOCAL]));
    act(() => store.getState().setQueryText('parser'));
    await act(() => store.getState().load());
    await flush();

    expect(threadFor(TEAMMATE.entry.entryId).dataset['pinned']).toBe('true');
    expect(rowFor(TEAMMATE.entry.entryId).textContent).toContain(
      'Ada Lovelace',
    );
    expect(rowFor(TEAMMATE.entry.entryId).textContent).toContain('Acme');
    expect(byTestId('ledger-feed-read-only').textContent).toBe(
      'Ada Lovelace recorded this entry. Only they can change it.',
    );
    const detailFields = Array.from(
      byTestId('ledger-entry-details').querySelectorAll('dt, dd'),
      (field) => field.textContent,
    );
    expect(detailFields.slice(0, 2)).toEqual(['Added by', 'Ada Lovelace']);
    expect(byTestId('ledger-entry-details').textContent).not.toMatch(
      /\byou\b/i,
    );
  });

  it('opens and closes a local row in place with its activity and details', async () => {
    const fake = fakes();
    fake.answers.push(page([LOCAL]));
    fake.localEntryViews.set(
      LOCAL.entry.entryId,
      entryView(LOCAL, 'available', [updateMutation(LOCAL)]),
    );
    const { scopeStores } = renderFeed(fake);
    await flush();

    clickInside(rowFor(LOCAL.entry.entryId), 'ledger-entry-details-toggle');
    await flush();

    const row = rowFor(LOCAL.entry.entryId);
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(
      row.querySelector('[data-testid="ledger-entry-activity"]'),
    ).toBeTruthy();
    expect(
      row.querySelector('[data-testid="ledger-entry-details"]'),
    ).toBeTruthy();
    expect(scopeStores.get('project-1/wt-1')?.getState().selectedEntryId).toBe(
      LOCAL.entry.entryId,
    );
    expect(fake.entryReads).toEqual([]);
    expect(fake.localReads).toEqual([LOCAL.entry.entryId]);

    clickInside(rowFor(LOCAL.entry.entryId), 'ledger-entry-details-toggle');
    await flush();
    expect(rowFor(LOCAL.entry.entryId).getAttribute('aria-current')).toBeNull();
    expect(
      scopeStores.get('project-1/wt-1')?.getState().selectedEntryId,
    ).toBeNull();
  });

  it('shows when the cloud cannot be reached and tries again', async () => {
    const fake = fakes();
    fake.answers.push(page([LOCAL], { notice: 'remote_unavailable' }));
    renderFeed(fake);
    await flush();

    const notice = byTestId('ledger-feed-notice');
    expect(notice.textContent).toContain(
      "Can't reach the cloud. Showing this device's entries.",
    );
    fake.answers.push(page([LOCAL]));
    click(buttonWithText('Try again'));
    await flush();

    expect(fake.searches[1]).toEqual(
      expect.objectContaining({ refresh: true }),
    );
  });

  it('offers Sign in on the signed-out notice when a handler is provided', async () => {
    const fake = fakes();
    const onSignIn = jest.fn();
    fake.answers.push(page([], { notice: 'signed_out' }));
    renderFeed(fake, { onSignIn });
    await flush();

    expect(byTestId('ledger-feed-notice').dataset['notice']).toBe('signed_out');
    click(buttonWithText('Sign in'));
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it('keeps the failed Feed with its Try again spinning, not an empty Feed, while retrying', async () => {
    const fake = fakes();
    fake.answers.push({
      status: 'error',
      reason: 'STORAGE_UNAVAILABLE',
      message: 'Unavailable',
    });
    renderFeed(fake);
    await flush();
    expect(byTestId('ledger-feed-problem').textContent).toContain(
      "Couldn't load entries.",
    );

    let release: () => void = () => undefined;
    fake.hold = new Promise((resolve) => {
      release = resolve;
    });
    fake.answers.push(page([LOCAL]));
    click(buttonWithText('Try again'));
    await flush();

    expect(
      document.querySelector('[data-testid="ledger-feed-empty"]'),
    ).toBeNull();
    expect(byTestId('ledger-feed-problem')).toBeInstanceOf(HTMLElement);
    const retry = byTestId('ledger-feed-retry');
    expect(retry.textContent).toBe('Trying again…');
    expect(retry.getAttribute('aria-busy')).toBe('true');
    release();
    await flush();
    expect(rowFor(LOCAL.entry.entryId)).toBeDefined();
    expect(
      document.querySelector('[data-testid="ledger-feed-problem"]'),
    ).toBeNull();
  });

  it('leaves newer activity behind Show new activity until asked for', async () => {
    jest.useFakeTimers();
    const fake = fakes();
    fake.answers.push(page([LOCAL]));
    renderFeed(fake);
    await flush();

    const newerLocal: LedgerFeedRow = {
      ...LOCAL,
      entry: item(1, USER, 2),
    };
    fake.answers.push(page([newerLocal, OTHER_DEVICE]));
    act(() => fake.emit({ changes: [] }));
    act(() => {
      jest.advanceTimersByTime(LEDGER_FEED_CHANGE_DELAY_MS);
    });
    await flush();

    expect(
      document.querySelectorAll('[data-testid="ledger-entry-row"]'),
    ).toHaveLength(1);
    fake.answers.push(page([newerLocal, OTHER_DEVICE]));
    click(buttonByTestId('ledger-feed-new-activity'));
    await flush();

    expect(
      document.querySelectorAll('[data-testid="ledger-entry-row"]'),
    ).toHaveLength(2);
    expect(
      document.querySelector('[data-testid="ledger-feed-new-activity"]'),
    ).toBeNull();
  });

  it('starts fresh results at the top but preserves its place during a new-activity check', async () => {
    const fake = fakes();
    fake.answers.push(page([LOCAL, OTHER_DEVICE]));
    const { store } = renderFeed(fake);
    await flush();
    const listPane = byTestId('ledger-feed-list-pane');
    let position = 0;
    Object.defineProperty(listPane, 'scrollTop', {
      configurable: true,
      get: () => position,
      set: (value: number) => {
        position = value;
      },
    });
    const scrollTo = (top: number): void => {
      position = top;
      void act(() => {
        listPane.dispatchEvent(new Event('scroll'));
      });
    };

    scrollTo(240);
    fake.answers.push(page([LOCAL, OTHER_DEVICE]));
    await act(() => store.getState().checkForNewActivity());
    expect(position).toBe(240);

    fake.answers.push(page([LOCAL]));
    await act(() =>
      store
        .getState()
        .setFilters({ ...store.getState().filters, period: 'day' }),
    );
    await flush();
    expect(position).toBe(0);
  });

  it('keeps the last result on screen while the next search runs', async () => {
    jest.useFakeTimers();
    const fake = fakes();
    fake.answers.push(page([LOCAL]));
    renderFeed(fake);
    await flush();
    const input = byTestId('ledger-feed-search');
    if (!(input instanceof HTMLInputElement))
      throw new Error('Not a search input');
    const settleSearch = async (): Promise<void> => {
      await act(async () => {
        jest.advanceTimersByTime(250);
        await Promise.resolve();
      });
      await flush();
    };

    fake.answers.push(page([OTHER_DEVICE]));
    typeInto(input, 'say h');
    await settleSearch();
    expect(rowFor(OTHER_DEVICE.entry.entryId)).toBeDefined();

    let release = (): void => undefined;
    fake.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.answers.push(page([LOCAL]));
    typeInto(input, 'say he');
    await settleSearch();
    expect(container.textContent).not.toContain('Loading entries');
    expect(rowFor(OTHER_DEVICE.entry.entryId)).toBeDefined();

    release();
    fake.hold = null;
    await flush();
  });

  it('offers more entries when an empty page says more are coming', async () => {
    const fake = fakes();
    fake.answers.push(
      page([], { hasMore: true, nextCursor: 'feed:session-1:2' }),
    );
    renderFeed(fake);
    await flush();

    expect(
      document.querySelector('[data-testid="ledger-feed-empty"]'),
    ).toBeNull();
    fake.answers.push(page([OTHER_DEVICE]));
    click(buttonByTestId('ledger-load-more'));
    await flush();

    expect(
      document.querySelectorAll('[data-testid="ledger-entry-row"]'),
    ).toHaveLength(1);
  });

  it('keeps the audience tabs on their own row, then search, Filter, and composer', async () => {
    const fake = fakes();
    fake.answers.push(page([LOCAL]));
    renderFeed(fake);
    await flush();

    const controls = byTestId('ledger-feed-controls');
    const [tabs, searchRow] = Array.from(controls.children);
    expect(tabs?.getAttribute('role')).toBe('tablist');
    // The page search row: the 32px search, then the Filter dropdown after
    // it, with no hairline under the row.
    expect(searchRow?.hasAttribute('data-page-search-row')).toBe(true);
    expect(controls.className).not.toContain('border-b');
    expect(
      Array.from(
        searchRow?.querySelectorAll(
          '[data-testid="ledger-filter-trigger"], [data-testid="ledger-feed-search"]',
        ) ?? [],
        (control) => control.getAttribute('data-testid'),
      ),
    ).toEqual(['ledger-feed-search', 'ledger-filter-trigger']);
    expect(byTestId('ledger-filter-trigger').textContent).toBe('Filter');
    const composer = byTestId('ledger-feed-add-entry');
    const row = rowFor(LOCAL.entry.entryId);
    expect(
      controls.compareDocumentPosition(composer) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      composer.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe('LedgerFeed composer and scope rows', () => {
  it('opens the entry form at once with project, task, and owner first', async () => {
    const fake = fakes();
    fake.answers.push(page([LOCAL]));
    renderFeed(fake);
    await flush();

    click(buttonByTestId('ledger-feed-add-entry'));

    const target = byTestId('ledger-feed-target');
    expect(
      Array.from(
        target.querySelectorAll('label'),
        (label) => label.textContent,
      ),
    ).toEqual(['Project', 'Task', 'Owner']);
    expect(
      target.compareDocumentPosition(byTestId('ledger-entry-form-type')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(byTestId('ledger-feed-target-project').textContent).toBe(
      'Choose a project',
    );
    expect(byTestId('ledger-feed-target-task')).toHaveProperty(
      'disabled',
      true,
    );
    expect(byTestId('ledger-owner-picker')).toHaveProperty('disabled', true);
    expect(byTestId('ledger-entry-form-save')).toHaveProperty('disabled', true);
    expect(byTestId('ledger-entry-form-save-blocked').textContent).toBe(
      'Choose a task first.',
    );
    expect(byTestId('ledger-entry-list')).toBeDefined();
    expect(rowFor(LOCAL.entry.entryId)).toBeDefined();
  });

  it('keeps written text while moving project and task, then saves to the chosen task', async () => {
    const fake = fakes();
    fake.answers.push(page([LOCAL]));
    const { scopeStores, scopeStore, store } = renderFeed(fake);
    await flush();
    click(buttonByTestId('ledger-feed-add-entry'));
    typeInto(byTestId('ledger-entry-form-title'), 'Ship the notes');
    typeInto(byTestId('ledger-entry-form-content'), 'Today.');

    click(buttonByTestId('ledger-feed-target-project'));
    expect(
      allByTestId('ledger-feed-target-project-option').map(
        (option) => option.textContent,
      ),
    ).toEqual(['Canopy', 'Docs']);
    click(buttonByTestId('ledger-feed-target-project'));
    choose('ledger-feed-target-project', 'Canopy');
    click(buttonByTestId('ledger-feed-target-task'));
    expect(
      allByTestId('ledger-feed-target-task-option').map(
        (option) => option.textContent,
      ),
    ).toEqual(['fix-parser']);
    click(buttonByTestId('ledger-feed-target-task'));
    choose('ledger-feed-target-task', 'fix-parser');
    expect(
      scopeStores.get('project-1/wt-1')?.getState().composer.draft,
    ).toEqual(
      expect.objectContaining({ title: 'Ship the notes', content: 'Today.' }),
    );
    expect(buttonByTestId('ledger-entry-form-save').disabled).toBe(false);

    choose('ledger-feed-target-project', 'Docs');
    expect(
      scopeStores.get('project-1/wt-1')?.getState().composer.draft,
    ).toBeNull();
    expect(byTestId('ledger-entry-form-title')).toHaveProperty(
      'value',
      'Ship the notes',
    );
    expect(byTestId('ledger-feed-target-task').textContent).toBe(
      'Choose a task',
    );
    choose('ledger-feed-target-task', 'launch-notes');

    const addedRow: LedgerFeedRow = {
      ...localRow(10, OTHER_SCOPE),
      entry: {
        ...item(10),
        title: 'Ship the notes',
        content: 'Today.',
      },
    };
    const addedView = entryView(addedRow, 'available');
    fake.localEntryViews.set(addedRow.entry.entryId, addedView);
    fake.answers.push(page([addedRow, LOCAL]));
    fake.addAnswer = receiptFor(addedView);
    click(buttonByTestId('ledger-entry-form-save'));
    await flush();

    expect(fake.adds).toHaveLength(1);
    expect(fake.adds[0]?.scope).toEqual(OTHER_SCOPE);
    expect(fake.adds[0]?.params).toMatchObject({
      title: 'Ship the notes',
      content: 'Today.',
      owner: 'self',
    });
    expect(store.getState().selectedScope).toBeNull();
    expect(store.getState().selectedEntryId).toBeNull();
    expect(scopeStore(OTHER_SCOPE).getState().composer.draft).toBeNull();
    expect(fake.localEntryViews.has(addedRow.entry.entryId)).toBe(true);
    expect(
      Array.from(
        document.querySelectorAll('[data-testid="ledger-entry-row"]'),
        (row) => row.getAttribute('data-entry-id'),
      ),
    ).toEqual([addedRow.entry.entryId, LOCAL.entry.entryId]);
    expect(rowFor(addedRow.entry.entryId).getAttribute('aria-current')).toBe(
      null,
    );
    expect(
      rowFor(addedRow.entry.entryId).querySelector(
        '[data-testid="ledger-entry-details"]',
      ),
    ).toBeNull();
  });

  it('asks to save or cancel an unconfirmed draft before moving it', async () => {
    const fake = fakes();
    const { scopeStore } = renderFeed(fake);
    await flush();
    click(buttonByTestId('ledger-feed-add-entry'));
    choose('ledger-feed-target-project', 'Canopy');
    choose('ledger-feed-target-task', 'fix-parser');
    typeInto(byTestId('ledger-entry-form-content'), 'Keep the first send.');
    fake.addAnswer = {
      status: 'error',
      reason: 'UNKNOWN',
      message: 'Private storage details.',
    };

    click(buttonByTestId('ledger-entry-form-save'));
    await flush();

    expect(scopeStore(SCOPE).getState().composer.unconfirmed).toHaveLength(1);
    expect(
      buttonByTestId('ledger-feed-target-task').getAttribute('title'),
    ).toBe('Save or cancel this draft before moving it.');
  });

  it('marks a task draft as unavailable and sets aside only the Feed draft', async () => {
    const fake = fakes();
    fake.answers.push(page([LOCAL]));
    const { scopeStore, store } = renderFeed(fake);
    await flush();
    act(() => {
      scopeStore(SCOPE).getState().startEntry();
      scopeStore(SCOPE).getState().updateDraft({ title: 'Task draft' });
    });

    click(buttonByTestId('ledger-feed-add-entry'));
    choose('ledger-feed-target-project', 'Canopy');
    click(buttonByTestId('ledger-feed-target-task'));
    const taskOption = allByTestId('ledger-feed-target-task-option')[0];
    expect(taskOption?.textContent).toBe('fix-parserHas a draft');
    expect(taskOption).toHaveProperty('disabled', true);
    click(buttonByTestId('ledger-feed-target-task'));

    act(() => store.getState().hideEntry());
    expect(
      document.querySelector('[data-testid="ledger-entry-form"]'),
    ).toBeNull();
    expect(byTestId('ledger-feed-add-entry').textContent).toBe(
      'Continue draft',
    );
    click(buttonByTestId('ledger-feed-add-entry'));
    expect(byTestId('ledger-feed-target-project').textContent).toBe('Canopy');
    expect(byTestId('ledger-entry-form-title')).toHaveProperty('value', '');
    expect(scopeStore(SCOPE).getState().composer.draft?.title).toBe(
      'Task draft',
    );
  });

  it('does not mark a correction as a new-entry draft in the task picker', async () => {
    const fake = fakes();
    fake.answers.push(page([LOCAL]));
    renderFeed(fake);
    await flush();

    clickInside(rowFor(LOCAL.entry.entryId), 'ledger-entry-add-correction');
    click(buttonByTestId('ledger-feed-add-entry'));
    choose('ledger-feed-target-project', 'Canopy');
    click(buttonByTestId('ledger-feed-target-task'));

    const taskOption = allByTestId('ledger-feed-target-task-option')[0];
    expect(taskOption?.textContent).toBe('fix-parser');
    expect(taskOption).toHaveProperty('disabled', false);
  });

  it('offers to continue only the Feed draft, never a draft the task started', async () => {
    const fake = fakes();
    const { scopeStore, store } = renderFeed(fake);
    await flush();
    click(buttonByTestId('ledger-feed-add-entry'));
    typeInto(byTestId('ledger-entry-form-title'), 'Ship the notes');
    choose('ledger-feed-target-project', 'Canopy');
    choose('ledger-feed-target-task', 'fix-parser');
    act(() => store.getState().hideEntry());
    expect(byTestId('ledger-feed-add-entry').textContent).toBe(
      'Continue draft',
    );

    act(() => {
      scopeStore(SCOPE).getState().discardDraft();
      scopeStore(SCOPE).getState().startEntry();
      scopeStore(SCOPE).getState().updateDraft({ title: 'Its own' });
    });
    expect(byTestId('ledger-feed-add-entry').textContent).not.toBe(
      'Continue draft',
    );

    click(buttonByTestId('ledger-feed-add-entry'));
    expect(byTestId('ledger-entry-form-title')).toHaveProperty('value', '');
    expect(byTestId('ledger-feed-target-project').textContent).toBe('Canopy');
    expect(scopeStore(SCOPE).getState().composer.draft?.title).toBe('Its own');
  });

  it('closes the form when the task replaces the Feed draft', async () => {
    const fake = fakes();
    const { scopeStore, store } = renderFeed(fake);
    await flush();
    click(buttonByTestId('ledger-feed-add-entry'));
    choose('ledger-feed-target-project', 'Canopy');
    choose('ledger-feed-target-task', 'fix-parser');

    act(() => {
      scopeStore(SCOPE).getState().discardDraft();
      scopeStore(SCOPE).getState().startEntry();
    });
    await flush();

    expect(
      document.querySelector('[data-testid="ledger-entry-form"]'),
    ).toBeNull();
    expect(store.getState().selectedScope).toBeNull();
    expect(byTestId('ledger-feed-add-entry').textContent).not.toBe(
      'Continue draft',
    );
  });

  it('returns to its list when the task panel discards its draft', async () => {
    const fake = fakes();
    fake.answers.push(page([LOCAL]));
    const { scopeStore, store } = renderFeed(fake);
    await flush();
    await act(async () => {
      await scopeStore(SCOPE).getState().select(LOCAL.entry.entryId);
    });
    click(buttonByTestId('ledger-feed-add-entry'));
    choose('ledger-feed-target-project', 'Canopy');
    choose('ledger-feed-target-task', 'fix-parser');

    act(() => scopeStore(SCOPE).getState().discardDraft());
    await flush();

    expect(store.getState().selectedScope).toBeNull();
    expect(rowFor(LOCAL.entry.entryId)).toBeDefined();
    expect(rowFor(LOCAL.entry.entryId).getAttribute('aria-current')).toBeNull();
    expect(
      document.querySelector('[data-testid="ledger-entry-form"]'),
    ).toBeNull();
  });

  it('changes status and owner in the open row through its scope view store', async () => {
    const fake = fakes();
    fake.answers.push(page([LOCAL]));
    fake.ownerAnswer = {
      status: 'ok',
      value: { candidates: [OWNER_CANDIDATE], nextCursor: null },
    };
    const { scopeStores } = renderFeed(fake);
    await flush();
    clickInside(rowFor(LOCAL.entry.entryId), 'ledger-entry-details-toggle');
    await flush();

    const inProgress: LedgerFeedRow = {
      ...LOCAL,
      entry: {
        ...LOCAL.entry,
        status: 'IN_PROGRESS',
        revision: 2,
      },
    };
    const inProgressView = entryView(inProgress, 'available');
    fake.localEntryViews.set(LOCAL.entry.entryId, inProgressView);
    fake.updateAnswers.push(receiptFor(inProgressView));
    chooseStatus('IN_PROGRESS');
    await flush();

    const view = scopeStores.get('project-1/wt-1');
    expect(fake.updates[0]?.scope).toEqual(SCOPE);
    expect(fake.updates[0]?.params).toMatchObject({
      entryId: LOCAL.entry.entryId,
      status: 'IN_PROGRESS',
    });
    expect(view?.getState().selectedEntryId).toBe(LOCAL.entry.entryId);
    expect(view?.getState().detail.view?.entry.entry.status).toBe(
      'IN_PROGRESS',
    );

    click(buttonByTestId('ledger-owner-picker'));
    await flush();
    expect(fake.ownerReads).toBe(1);
    expect(byTestId('ledger-owner-option').textContent).toContain(
      'Build session',
    );
    const reassigned: LedgerFeedRow = {
      ...inProgress,
      entry: {
        ...inProgress.entry,
        owner: TEAMMATE_USER,
        revision: 3,
      },
    };
    const reassignedView = entryView(reassigned, 'available');
    fake.localEntryViews.set(LOCAL.entry.entryId, reassignedView);
    fake.updateAnswers.push(receiptFor(reassignedView));
    click(buttonByTestId('ledger-owner-option'));
    await flush();

    expect(fake.updates[1]?.scope).toEqual(SCOPE);
    expect(fake.updates[1]?.params).toMatchObject({
      entryId: LOCAL.entry.entryId,
      owner: {
        actorId: TEAMMATE_USER.actorId,
        eligibilityToken: 'eligible-1',
      },
    });
    expect(view?.getState().detail.view?.entry.entry.owner.actorId).toBe(
      TEAMMATE_USER.actorId,
    );
  });

  it('shows a saved reply status before the delayed activity look', async () => {
    jest.useFakeTimers();
    const fake = fakes();
    const rootEntry = LOCAL;
    const reply: LedgerFeedRow = {
      ...LOCAL,
      entry: item(8, USER, 1, {
        title: LOCAL.entry.title,
        supersedesEntryId: rootEntry.entry.entryId,
        type: 'TASK',
      }),
    };
    fake.answers.push(page([reply, rootEntry]), page([reply, rootEntry]));
    const { scopeStores } = renderFeed(fake);
    await flush();

    clickInside(rowFor(rootEntry.entry.entryId), 'ledger-entry-details-toggle');
    await flush();
    clickInside(
      entryElement('ledger-entry-correction', reply.entry.entryId),
      'ledger-entry-details-toggle',
    );
    await flush();

    const inProgress: LedgerFeedRow = {
      ...reply,
      entry: {
        ...reply.entry,
        status: 'IN_PROGRESS',
        revision: 2,
        updatedAt: '2026-10-02T10:01:00.000Z',
      },
    };
    const inProgressView = entryView(inProgress, 'available');
    fake.localEntryViews.set(reply.entry.entryId, inProgressView);
    fake.updateAnswers.push(receiptFor(inProgressView));
    clickInside(
      entryElement('ledger-entry-correction', reply.entry.entryId),
      'ledger-status-control',
    );
    click(buttonByTestId('ledger-status-option-in_progress'));
    await flush();

    expect(
      statusControl(
        entryElement('ledger-entry-correction', reply.entry.entryId),
      ).getAttribute('data-status'),
    ).toBe('IN_PROGRESS');

    fake.answers.push(page([inProgress, rootEntry]));
    act(() => fake.emit({ changes: [] }));
    act(() => {
      jest.advanceTimersByTime(LEDGER_FEED_CHANGE_DELAY_MS);
    });
    await flush();

    expect(
      statusControl(
        entryElement('ledger-entry-correction', reply.entry.entryId),
      ).getAttribute('data-status'),
    ).toBe('IN_PROGRESS');
    expect(
      document.querySelector('[data-testid="ledger-feed-new-activity"]'),
    ).toBeNull();
    expect(
      scopeStores.get('project-1/wt-1')?.getState().detail.view?.entry.entry
        .revision,
    ).toBe(2);
  });

  it('keeps a resolved row title when the open read still has a pending title', async () => {
    const fake = fakes();
    const resolvedRow: LedgerFeedRow = {
      ...LOCAL,
      entry: { ...LOCAL.entry, title: 'Resolved title', revision: 1 },
    };
    const olderPendingRead: LedgerFeedRow = {
      ...resolvedRow,
      entry: {
        ...resolvedRow.entry,
        title: 'Provisional title',
        revision: 2,
      },
    };
    fake.answers.push(page([resolvedRow]));
    fake.localEntryViews.set(
      resolvedRow.entry.entryId,
      entryView(olderPendingRead, 'available', [], { titlePending: true }),
    );
    renderFeed(fake);
    await flush();

    clickInside(
      rowFor(resolvedRow.entry.entryId),
      'ledger-entry-details-toggle',
    );
    await flush();

    expect(
      rowFor(resolvedRow.entry.entryId).querySelector(
        '[data-testid="ledger-entry-row-title"]',
      )?.textContent,
    ).toBe('Resolved title');
  });

  it('shows change notices from the open scope store without exposing write details', async () => {
    const fake = fakes();
    fake.answers.push(page([LOCAL]));
    fake.ownerAnswer = {
      status: 'ok',
      value: { candidates: [OWNER_CANDIDATE], nextCursor: null },
    };
    fake.updateAnswers.push({
      status: 'error',
      reason: 'UNKNOWN',
      message: 'Private storage detail',
    });
    fake.updateAnswers.push({
      status: 'error',
      reason: 'OWNER_UNAVAILABLE',
      message: 'Private eligibility detail',
    });
    renderFeed(fake);
    await flush();
    clickInside(rowFor(LOCAL.entry.entryId), 'ledger-entry-details-toggle');
    await flush();
    chooseStatus('BLOCKED');
    await flush();

    expect(byTestId('ledger-entry-change-notice').dataset['notice']).toBe(
      'failed',
    );
    expect(byTestId('ledger-entry-change-notice').textContent).toContain(
      "Couldn't save the change.",
    );
    expect(byTestId('ledger-entry-change-notice').textContent).not.toContain(
      'Private storage detail',
    );
    expect(buttonWithText('Try again')).toBeDefined();

    click(buttonByTestId('ledger-owner-picker'));
    await flush();
    click(buttonByTestId('ledger-owner-option'));
    await flush();
    expect(byTestId('ledger-entry-change-notice').dataset['notice']).toBe(
      'owner_unavailable',
    );
    expect(byTestId('ledger-entry-change-notice').textContent).not.toContain(
      'Private eligibility detail',
    );
  });

  it("shows a correction restarted after its scope's idle view was replaced", async () => {
    const fake = fakes();
    fake.answers.push(page([LOCAL]));
    const { scopeStores } = renderFeed(fake);
    await flush();

    clickInside(rowFor(LOCAL.entry.entryId), 'ledger-entry-add-correction');
    click(buttonByTestId('ledger-correction-discard'));
    expect(
      threadFor(LOCAL.entry.entryId).querySelector(
        '[data-testid="ledger-correction-box"]',
      ),
    ).toBeNull();

    // The host lets go of the idle view and makes a new one on next use.
    const evicted = scopeStores.get('project-1/wt-1');
    scopeStores.delete('project-1/wt-1');
    clickInside(rowFor(LOCAL.entry.entryId), 'ledger-entry-add-correction');
    await flush();

    const replacement = scopeStores.get('project-1/wt-1');
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(evicted);
    expect(
      replacement?.getState().corrections[LOCAL.entry.entryId],
    ).toBeDefined();
    expect(
      threadFor(LOCAL.entry.entryId).querySelector(
        '[data-testid="ledger-correction-box"]',
      ),
    ).toBeTruthy();
  });

  it('saves a correction from its box without opening an entry', async () => {
    const fake = fakes();
    fake.answers.push(page([LOCAL]));
    const { scopeStores } = renderFeed(fake);
    await flush();

    clickInside(rowFor(LOCAL.entry.entryId), 'ledger-entry-add-correction');
    expect(byTestId('ledger-correction-box').textContent).toContain('Cancel');
    expect(byTestId('ledger-correction-box').textContent).toContain(
      'Add correction',
    );
    expect(
      scopeStores.get('project-1/wt-1')?.getState().selectedEntryId,
    ).toBeNull();
    expect(rowFor(LOCAL.entry.entryId).getAttribute('aria-current')).toBeNull();
    expect(
      threadFor(LOCAL.entry.entryId).querySelector(
        '[data-testid="ledger-correction-box"]',
      ),
    ).toBeTruthy();
    typeInto(byTestId('ledger-correction-input'), 'The lock is per scope.');

    const correction: LedgerFeedRow = {
      ...LOCAL,
      entry: item(4, USER, 1, {
        title: LOCAL.entry.title,
        supersedesEntryId: LOCAL.entry.entryId,
      }),
    };
    const correctionView = entryView(correction, 'available');
    fake.localEntryViews.set(correction.entry.entryId, correctionView);
    fake.addAnswer = receiptFor(correctionView);
    click(buttonByTestId('ledger-correction-save'));
    await flush();

    expect(fake.adds).toHaveLength(1);
    expect(fake.adds[0]?.params).toMatchObject({
      title: LOCAL.entry.title,
      content: 'The lock is per scope.',
      supersedesEntryId: LOCAL.entry.entryId,
    });
    expect(
      scopeStores.get('project-1/wt-1')?.getState().selectedEntryId,
    ).toBeNull();
    expect(rowFor(LOCAL.entry.entryId).getAttribute('aria-current')).toBeNull();
    expect(
      rowFor(LOCAL.entry.entryId).querySelector(
        '[data-testid="ledger-entry-details"]',
      ),
    ).toBeNull();
    expect(
      threadFor(LOCAL.entry.entryId).querySelector(
        '[data-testid="ledger-correction-box"]',
      ),
    ).toBeNull();
  });

  it('shows a correction saved from its box in its thread at once, without Show new activity', async () => {
    const fake = fakes();
    fake.answers.push(page([LOCAL]));
    const { store } = renderFeed(fake);
    await flush();
    const generation = store.getState().list.generation;

    clickInside(rowFor(LOCAL.entry.entryId), 'ledger-entry-add-correction');
    typeInto(byTestId('ledger-correction-input'), 'The lock is per scope.');
    const correction: LedgerFeedRow = {
      ...LOCAL,
      entry: item(4, USER, 1, {
        title: LOCAL.entry.title,
        supersedesEntryId: LOCAL.entry.entryId,
      }),
    };
    const correctionView = entryView(correction, 'available');
    fake.localEntryViews.set(correction.entry.entryId, correctionView);
    fake.addAnswer = receiptFor(correctionView);
    // The newest first page now has the correction above its entry.
    fake.answers.push(page([correction, LOCAL]));
    click(buttonByTestId('ledger-correction-save'));
    await flush();

    const thread = threadFor(LOCAL.entry.entryId);
    expect(
      thread.querySelector(
        '[data-testid="ledger-entry-correction"][data-entry-id="' +
          correction.entry.entryId +
          '"]',
      ),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="ledger-feed-new-activity"]'),
    ).toBeNull();
    expect(store.getState().newActivity).toBe(false);
    expect(store.getState().list.generation).toBe(generation);
    // The newest correction now offers Add correction, not the root (its
    // replies render inside the root's row, so count within the thread).
    const addCorrections = thread.querySelectorAll(
      '[data-testid="ledger-entry-add-correction"]',
    );
    expect(addCorrections).toHaveLength(1);
    expect(
      entryElement(
        'ledger-entry-correction',
        correction.entry.entryId,
      ).contains(addCorrections[0] ?? null),
    ).toBe(true);
    expect(
      document.querySelectorAll('[data-testid="ledger-entry-details-toggle"]'),
    ).toHaveLength(2);
  });

  it('expands a correction of a reply in its root thread and saves that draft', async () => {
    const fake = fakes();
    const firstReply: LedgerFeedRow = {
      ...LOCAL,
      entry: item(5, USER, 1, {
        supersedesEntryId: LOCAL.entry.entryId,
      }),
    };
    fake.answers.push(page([LOCAL, firstReply]));
    fake.localEntryViews.set(
      firstReply.entry.entryId,
      entryView(firstReply, 'available'),
    );
    const { scopeStores } = renderFeed(fake);
    await flush();

    clickInside(
      entryElement('ledger-entry-correction', firstReply.entry.entryId),
      'ledger-entry-add-correction',
    );
    typeInto(byTestId('ledger-correction-input'), 'Correct that reply.');
    const replyCorrection: LedgerFeedRow = {
      ...LOCAL,
      entry: item(6, USER, 1, {
        supersedesEntryId: firstReply.entry.entryId,
      }),
    };
    const replyCorrectionView = entryView(replyCorrection, 'available');
    fake.localEntryViews.set(
      replyCorrection.entry.entryId,
      replyCorrectionView,
    );
    fake.addAnswer = receiptFor(replyCorrectionView);
    const rootThread = threadFor(LOCAL.entry.entryId);
    expect(
      rootThread.querySelector('[data-testid="ledger-correction-box"]'),
    ).not.toBeNull();
    click(buttonByTestId('ledger-correction-more'));
    expect(byTestId('ledger-entry-form-author').textContent).toContain(
      'Corrects "Decision 5"',
    );
    typeInto(byTestId('ledger-entry-form-content'), 'Correct that reply.');
    fake.answers.push(page([replyCorrection, LOCAL, firstReply]));
    click(buttonByTestId('ledger-entry-form-save'));
    await flush();

    expect(fake.adds).toHaveLength(1);
    expect(fake.adds[0]?.params).toMatchObject({
      content: 'Correct that reply.',
      supersedesEntryId: firstReply.entry.entryId,
    });
    // Saved from the full form, it also joins the root thread in place.
    expect(
      threadFor(LOCAL.entry.entryId).querySelector(
        '[data-testid="ledger-entry-correction"][data-entry-id="' +
          replyCorrection.entry.entryId +
          '"]',
      ),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="ledger-feed-new-activity"]'),
    ).toBeNull();
    expect(
      scopeStores.get('project-1/wt-1')?.getState().selectedEntryId,
    ).toBeNull();
    expect(rowFor(LOCAL.entry.entryId).getAttribute('aria-current')).toBeNull();
  });

  it('keeps correction drafts across scopes, stacks a thread in creation order, and allows a new entry', async () => {
    const fake = fakes();
    const firstReply: LedgerFeedRow = {
      ...LOCAL,
      entry: item(9, USER, 1, {
        supersedesEntryId: LOCAL.entry.entryId,
      }),
    };
    const otherRoot = localRow(11, OTHER_SCOPE);
    fake.answers.push(page([LOCAL, firstReply, otherRoot]));
    const { scopeStore } = renderFeed(fake);
    await flush();

    clickInside(
      entryElement('ledger-entry-correction', firstReply.entry.entryId),
      'ledger-entry-add-correction',
    );
    typeInto(byTestId('ledger-correction-input'), 'First in this thread.');
    act(() => {
      scopeStore(SCOPE).getState().startCorrection(LOCAL.entry);
      scopeStore(SCOPE).getState().updateCorrection(LOCAL.entry.entryId, {
        content: 'Second in this thread.',
      });
    });
    clickInside(rowFor(otherRoot.entry.entryId), 'ledger-entry-add-correction');
    const otherBox = threadFor(otherRoot.entry.entryId).querySelector(
      '[data-testid="ledger-correction-input"]',
    );
    if (!(otherBox instanceof HTMLTextAreaElement)) {
      throw new Error('Other scope correction has no text field');
    }
    typeInto(otherBox, 'A different thread.');
    click(buttonByTestId('ledger-feed-add-entry'));

    const firstThreadBoxes = threadFor(LOCAL.entry.entryId).querySelectorAll(
      '[data-testid="ledger-correction-box"]',
    );
    const firstThreadValues = Array.from(firstThreadBoxes, (box) => {
      const input = box.querySelector(
        '[data-testid="ledger-correction-input"]',
      );
      if (!(input instanceof HTMLElement)) {
        throw new Error('Thread correction has no text field');
      }
      return inputValue(input);
    });
    expect(firstThreadValues).toEqual([
      'First in this thread.',
      'Second in this thread.',
    ]);
    expect(
      threadFor(otherRoot.entry.entryId).querySelector(
        '[data-testid="ledger-correction-box"]',
      ),
    ).not.toBeNull();
    expect(byTestId('ledger-entry-form')).toBeDefined();
    expect(
      firstThreadBoxes[0]?.querySelector(
        '[data-testid="ledger-correction-discard"]',
      )?.textContent,
    ).toBe('Cancel');

    const cancelFirst = firstThreadBoxes[0]?.querySelector(
      '[data-testid="ledger-correction-discard"]',
    );
    if (!(cancelFirst instanceof HTMLButtonElement)) {
      throw new Error('First correction has no Cancel button');
    }
    act(() => cancelFirst.click());
    expect(
      threadFor(LOCAL.entry.entryId).querySelectorAll(
        '[data-testid="ledger-correction-box"]',
      ),
    ).toHaveLength(1);
    expect(
      threadFor(otherRoot.entry.entryId).querySelector(
        '[data-testid="ledger-correction-box"]',
      ),
    ).not.toBeNull();
    expect(byTestId('ledger-entry-form')).toBeDefined();
  });

  it('shows an unlisted correction in the composer area when search hides its entry', async () => {
    const fake = fakes();
    fake.answers.push(page([LOCAL]));
    const { store } = renderFeed(fake);
    await flush();
    clickInside(rowFor(LOCAL.entry.entryId), 'ledger-entry-add-correction');

    fake.answers.push(page([]));
    act(() => store.getState().setQueryText('hidden entry'));
    await act(() => store.getState().load());

    expect(byTestId('ledger-entry-form').textContent).toContain(
      `Corrects "${LOCAL.entry.title}"`,
    );
    expect(
      document.querySelector('[data-testid="ledger-correction-box"]'),
    ).toBeNull();
  });

  it('shows a resolved title on a row loaded from a later page, in place', async () => {
    const rowOrder = (): string[] =>
      Array.from(
        document.querySelectorAll('[data-testid="ledger-entry-row"]'),
        (row) => row.getAttribute('data-entry-id') ?? '',
      );
    const fake = fakes();
    const pending = localRow(5);
    const pendingRow: LedgerFeedRow = {
      ...pending,
      entry: {
        ...pending.entry,
        title: 'Keep one writer.',
        titlePending: true,
      },
    };
    fake.answers.push(
      page([OTHER_DEVICE], { hasMore: true, nextCursor: 'feed:session-1:2' }),
    );
    renderFeed(fake);
    await flush();
    fake.answers.push(page([pendingRow]));
    click(buttonByTestId('ledger-load-more'));
    await flush();
    expect(rowOrder()).toEqual([
      OTHER_DEVICE.entry.entryId,
      pending.entry.entryId,
    ]);

    const resolved: LedgerFeedRow = {
      ...pending,
      entry: { ...pending.entry, title: 'Use a single writer' },
    };
    fake.localEntryViews.set(
      pending.entry.entryId,
      entryView(resolved, 'available'),
    );
    act(() =>
      fake.emit({
        changes: [
          {
            scope: SCOPE,
            entryId: pending.entry.entryId,
            revision: 1,
            titleResolved: true,
          },
        ],
      }),
    );
    await flush();

    expect(rowOrder()).toEqual([
      OTHER_DEVICE.entry.entryId,
      pending.entry.entryId,
    ]);
    expect(rowFor(pending.entry.entryId).textContent).toContain(
      'Use a single writer',
    );
    const addCorrection = rowFor(pending.entry.entryId).querySelector(
      '[data-testid="ledger-entry-add-correction"]',
    );
    expect(addCorrection).toHaveProperty('disabled', false);
  });

  it('disables Add correction while a Feed row title is still being written', async () => {
    const fake = fakes();
    const pendingRow: LedgerFeedRow = {
      ...LOCAL,
      entry: { ...LOCAL.entry, titlePending: true },
    };
    fake.answers.push(page([pendingRow]));
    renderFeed(fake);
    await flush();

    const addCorrection = rowFor(LOCAL.entry.entryId).querySelector(
      '[data-testid="ledger-entry-add-correction"]',
    );
    if (!(addCorrection instanceof HTMLButtonElement)) {
      throw new Error('Pending row has no Add correction action');
    }
    expect(addCorrection.disabled).toBe(true);
    expect(addCorrection.getAttribute('aria-description')).toBe(
      'Its title is still being written.',
    );
  });

  it('typing in one correction box does not re-render the Feed thread list or other boxes', async () => {
    const fake = fakes();
    const otherRoot = localRow(11, OTHER_SCOPE);
    fake.answers.push(page([LOCAL, otherRoot]));
    renderFeed(fake);
    await flush();
    clickInside(rowFor(LOCAL.entry.entryId), 'ledger-entry-add-correction');
    clickInside(rowFor(otherRoot.entry.entryId), 'ledger-entry-add-correction');

    const beforeList = mockLedgerThreadListRenderCount;
    const beforeBoxes = mockLedgerCorrectionBoxRenderCount;
    typeInto(byTestId('ledger-correction-input'), 'Only this box changes.');

    expect(mockLedgerThreadListRenderCount).toBe(beforeList);
    expect(mockLedgerCorrectionBoxRenderCount).toBe(beforeBoxes + 1);
  });

  it('keeps remote device and teammate rows read only, and explains a remote file click', async () => {
    const fake = fakes();
    const deviceWithFile: LedgerFeedRow = {
      ...OTHER_DEVICE,
      entry: item(2, USER, 1, { referenceFiles: [FILE_REF] }),
    };
    fake.answers.push(page([TEAMMATE, deviceWithFile]));
    fake.remoteEntryViews.set(
      TEAMMATE.entry.entryId,
      entryView(TEAMMATE, 'not_on_this_device'),
    );
    fake.remoteEntryViews.set(
      deviceWithFile.entry.entryId,
      entryView(deviceWithFile, 'not_on_this_device'),
    );
    const { store } = renderFeed(fake);
    await flush();

    clickInside(rowFor(TEAMMATE.entry.entryId), 'ledger-entry-details-toggle');
    await flush();
    expect(store.getState().remoteDetail.entryId).toBe(TEAMMATE.entry.entryId);
    expect(byTestId('ledger-feed-read-only').textContent).toContain(
      'Ada Lovelace recorded this entry.',
    );
    clickInside(
      rowFor(deviceWithFile.entry.entryId),
      'ledger-entry-details-toggle',
    );
    await flush();
    expect(store.getState().remoteDetail.entryId).toBe(
      deviceWithFile.entry.entryId,
    );
    expect(
      rowFor(deviceWithFile.entry.entryId).querySelector(
        '[data-testid="ledger-entry-read-only"]',
      )?.textContent,
    ).toBe('Recorded on Studio Mac. Change it there.');

    for (const remoteEntryId of [
      TEAMMATE.entry.entryId,
      deviceWithFile.entry.entryId,
    ]) {
      const remoteRow = rowFor(remoteEntryId);
      for (const testId of [
        'ledger-status-control',
        'ledger-owner-picker',
        'ledger-entry-add-correction',
      ]) {
        expect(
          remoteRow.querySelector('[data-testid="' + testId + '"]'),
        ).toBeNull();
      }
    }
    click(buttonByTestId('ledger-entry-file-ref'));
    await flush();
    expect(
      rowFor(deviceWithFile.entry.entryId).querySelector(
        '[data-testid="ledger-entry-open-error"]',
      )?.textContent,
    ).toBe('This file is on another device.');
    expect(openFile).not.toHaveBeenCalled();
    expect(fake.entryReads).toEqual([
      { entryId: TEAMMATE.entry.entryId },
      { entryId: deviceWithFile.entry.entryId },
    ]);
  });

  it('reads only, with no composer or This device tab, on a mirror-only host', async () => {
    const fake = fakes();
    fake.answers.push(page([TEAMMATE, OTHER_DEVICE]));
    fake.remoteEntryViews.set(
      TEAMMATE.entry.entryId,
      entryView(TEAMMATE, 'not_on_this_device'),
    );
    const { store } = renderFeed(fake, { mirrorOnly: true });
    await flush();

    expect(
      container.querySelector('[data-testid="ledger-feed-add-entry"]'),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="ledger-feed-audience-this_device"]',
      ),
    ).toBeNull();
    expect(byTestId('ledger-feed-audience-teammates')).toBeDefined();

    clickInside(rowFor(TEAMMATE.entry.entryId), 'ledger-entry-details-toggle');
    await flush();
    expect(store.getState().remoteDetail.entryId).toBe(TEAMMATE.entry.entryId);
    for (const testId of [
      'ledger-status-control',
      'ledger-owner-picker',
      'ledger-entry-add-correction',
    ]) {
      expect(
        rowFor(TEAMMATE.entry.entryId).querySelector(
          '[data-testid="' + testId + '"]',
        ),
      ).toBeNull();
    }
    // Nothing of this device's Ledger is read or changed.
    expect(fake.localReads).toEqual([]);
    expect(fake.updates).toEqual([]);
  });

  it('pins an open entry above the loaded rows when a search drops it', async () => {
    const fake = fakes();
    fake.answers.push(page([LOCAL, OTHER_DEVICE]));
    const { store } = renderFeed(fake);
    await flush();
    clickInside(rowFor(LOCAL.entry.entryId), 'ledger-entry-details-toggle');
    await flush();

    fake.answers.push(page([OTHER_DEVICE]));
    act(() => store.getState().setQueryText('studio'));
    await act(() => store.getState().load());
    await flush();

    expect(threadFor(LOCAL.entry.entryId).dataset['pinned']).toBe('true');
    expect(rowFor(LOCAL.entry.entryId).getAttribute('aria-current')).toBe(
      'true',
    );
    expect(
      threadFor(LOCAL.entry.entryId).compareDocumentPosition(
        threadFor(OTHER_DEVICE.entry.entryId),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('does not re-render the thread list while search text is typed', async () => {
    jest.useFakeTimers();
    const fake = fakes();
    fake.answers.push(page([LOCAL]));
    renderFeed(fake);
    await flush();

    const renders = mockLedgerThreadListRenderCount;
    expect(renders).toBeGreaterThan(0);
    typeInto(byTestId('ledger-feed-search'), 'new query');

    expect(inputValue(byTestId('ledger-feed-search'))).toBe('new query');
    expect(mockLedgerThreadListRenderCount).toBe(renders);
  });
});
