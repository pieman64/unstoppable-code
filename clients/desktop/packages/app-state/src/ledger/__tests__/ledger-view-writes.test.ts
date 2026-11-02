import type { LedgerClient } from '@canopy/app-core';
import type {
  LedgerActorRef,
  LedgerEntriesSearchResult,
  LedgerErrorReason,
  LedgerEntry,
  LedgerOwnerCandidate,
  LedgerStatus,
} from '@canopy/protocol/canopy-core';
import type {
  LedgerViewAddRequest,
  LedgerViewEntry,
  LedgerViewEntryRequest,
  LedgerViewOwnerPage,
  LedgerViewOwnersRequest,
  LedgerViewReceipt,
  LedgerViewResult,
  LedgerTaskViewScope,
  LedgerViewSearchRequest,
  LedgerViewUpdateRequest,
} from '@canopy/protocol/ledger-view';
import { createLedgerViewStore } from '../create-ledger-view-store';
import {
  blankLedgerViewDraft,
  isLedgerDraftComplete,
  ledgerDraftAddParams,
  ledgerDraftMovable,
  ledgerViewHoldsDraft,
  type LedgerViewDraft,
} from '../ledger-view-writes';

const SCOPE: LedgerTaskViewScope = {
  projectId: 'project-1',
  worktreeId: 'wt-1',
};
const LEDGER_ID = '00000000-0000-4000-8000-0000000000f1';
const ENTRY_ID = '00000000-0000-4000-8000-000000000101';
const YOU: LedgerActorRef = {
  actorId: '00000000-0000-4000-8000-0000000000a1',
  kind: 'user',
  authorityId: 'authority-1',
};
const CHAT: LedgerActorRef = {
  actorId: '00000000-0000-4000-8000-0000000000a2',
  kind: 'chat',
  authorityId: 'authority-1',
};
const DETAILS = {
  harness: null,
  model: null,
  thinkingEffort: null,
  mode: null,
  pipelineExecutionId: null,
  settingsRevision: null,
  unavailableReason: 'not_applicable' as const,
};

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    schemaVersion: 1,
    entryId: ENTRY_ID,
    scope: {
      ledgerId: LEDGER_ID,
      authorityId: 'authority-1',
      container: {
        kind: 'code_worktree',
        workspaceId: SCOPE.projectId,
        worktreeId: SCOPE.worktreeId,
      },
    },
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T10:00:00.000Z',
    revision: 1,
    author: YOU,
    authorDetails: DETAILS,
    owner: YOU,
    type: 'TASK',
    title: 'Write the release notes',
    content: 'Cover the Ledger panel.',
    highlights: [],
    referenceFiles: [],
    status: 'TODO',
    origin: { kind: 'user', ledgerId: LEDGER_ID, userActorId: YOU.actorId },
    attribution: {
      kind: 'self_reported',
      effectiveActor: YOU,
      recordedBy: YOU,
      executorDetails: DETAILS,
    },
    ...overrides,
  };
}

function view(value: LedgerEntry): LedgerViewResult<LedgerViewEntry> {
  return {
    status: 'ok',
    value: {
      entry: {
        entry: value,
        sourceAvailability: 'available',
        history: { mutations: [], nextCursor: null },
        actors: [],
      },
      source: { availability: 'available', target: null },
    },
  };
}

function receipt(value: LedgerEntry): LedgerViewResult<LedgerViewReceipt> {
  return {
    status: 'ok',
    value: {
      entry: value,
      changed: true,
      mutationId: null,
      localSequence: '1',
      syncState: 'local_only',
    },
  };
}

function failure(
  reason: LedgerErrorReason | 'UNKNOWN',
): LedgerViewResult<never> {
  return { status: 'error', reason, message: `${reason} happened` };
}

const EMPTY_PAGE: LedgerViewResult<LedgerEntriesSearchResult> = {
  status: 'ok',
  value: { entries: [], nextCursor: null, hasMore: false, watermark: '1' },
};

function candidate(
  actor: LedgerActorRef,
  displayName: string,
  token: string,
): LedgerOwnerCandidate {
  return {
    actor,
    displayName,
    eligibilityToken: token,
    isSelf: actor.actorId === YOU.actorId,
  };
}

/** What the scripted client recorded, and the answers still owed. */
interface ScriptedState {
  searches: LedgerViewSearchRequest[];
  reads: LedgerViewEntryRequest[];
  adds: LedgerViewAddRequest[];
  updates: LedgerViewUpdateRequest[];
  ownerRequests: LedgerViewOwnersRequest[];
  answerAdd: Array<(result: LedgerViewResult<LedgerViewReceipt>) => void>;
  answerUpdate: Array<(result: LedgerViewResult<LedgerViewReceipt>) => void>;
  answerOwners: Array<(result: LedgerViewResult<LedgerViewOwnerPage>) => void>;
  readAnswers: Array<Promise<LedgerViewResult<LedgerViewEntry>>>;
  readAnswer: { current: LedgerViewResult<LedgerViewEntry> };
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A client whose writes and owner reads the test answers one at a time. */
function scriptedClient(): ScriptedState & { client: LedgerClient } {
  const scripted: ScriptedState = {
    searches: [],
    reads: [],
    adds: [],
    updates: [],
    ownerRequests: [],
    answerAdd: [],
    answerUpdate: [],
    answerOwners: [],
    readAnswers: [],
    readAnswer: { current: view(entry()) },
  };
  const client: LedgerClient = {
    searchEntries: (request) => {
      scripted.searches.push(request);
      return Promise.resolve(EMPTY_PAGE);
    },
    getEntry: (request) => {
      scripted.reads.push(request);
      return (
        scripted.readAnswers.shift() ??
        Promise.resolve(scripted.readAnswer.current)
      );
    },
    addEntry: (request) => {
      scripted.adds.push(request);
      return new Promise((resolve) => scripted.answerAdd.push(resolve));
    },
    updateEntry: (request) => {
      scripted.updates.push(request);
      return new Promise((resolve) => scripted.answerUpdate.push(resolve));
    },
    listOwners: (request) => {
      scripted.ownerRequests.push(request);
      return new Promise((resolve) => scripted.answerOwners.push(resolve));
    },
    subscribeChanges: () => (): void => undefined,
  };
  return { client, ...scripted };
}

function keys(): () => string {
  let next = 0;
  return (): string => {
    next += 1;
    return `key-${next}`;
  };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

/** A store showing the entry's detail, as the panel does once selected. */
async function selected(
  scripted: ReturnType<typeof scriptedClient>,
  value: LedgerEntry = entry(),
): Promise<ReturnType<typeof createLedgerViewStore>> {
  const store = createLedgerViewStore(scripted.client, SCOPE, {
    newRequestKey: keys(),
  });
  scripted.readAnswer.current = view(value);
  await store.getState().load();
  await store.getState().select(value.entryId);
  return store;
}

type ByIdChangeKind = 'status' | 'owner';

const BY_ID_CHANGE_KINDS: readonly ByIdChangeKind[] = ['status', 'owner'];

function changeById(
  store: ReturnType<typeof createLedgerViewStore>,
  kind: ByIdChangeKind,
  entryId: string,
): Promise<void> {
  return kind === 'status'
    ? store.getState().changeStatusOf(entryId, 'BLOCKED')
    : store
        .getState()
        .assignOwnerOf(entryId, candidate(CHAT, 'Parser fixes', 'token-chat'));
}

describe('Ledger view drafts', () => {
  it('keeps one request key through a failed save, and closes only after a receipt', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE, {
      newRequestKey: keys(),
    });
    await store.getState().load();

    store.getState().startEntry();
    expect(store.getState().composer).toMatchObject({
      shown: true,
      requestKey: 'key-1',
      draft: { type: 'TASK', status: 'TODO', owner: null, supersedes: null },
    });
    store.getState().updateDraft({
      title: '  Write the release notes ',
      content: 'Cover the Ledger panel.',
      highlights: ['Panel', '  '],
    });

    const first = store.getState().submitDraft();
    expect(store.getState().composer.saving).toBe(true);
    expect(scripted.adds[0]).toEqual({
      scope: SCOPE,
      requestKey: 'key-1',
      params: {
        type: 'TASK',
        title: 'Write the release notes',
        content: 'Cover the Ledger panel.',
        highlights: ['Panel'],
        status: 'TODO',
        owner: 'self',
      },
    });
    scripted.answerAdd[0]?.(failure('STORAGE_UNAVAILABLE'));
    await first;
    expect(store.getState().composer).toMatchObject({
      saving: false,
      requestKey: 'key-1',
      problem: { reason: 'STORAGE_UNAVAILABLE' },
      draft: { title: '  Write the release notes ' },
    });

    const second = store.getState().submitDraft();
    expect(scripted.adds[1]?.requestKey).toBe('key-1');
    scripted.answerAdd[1]?.(receipt(entry()));
    await second;

    expect(store.getState().composer).toMatchObject({
      draft: null,
      shown: false,
      requestKey: null,
    });
    // The list catches up, but a save never opens the new entry.
    expect(store.getState().selectedEntryId).toBeNull();
    expect(scripted.reads).toEqual([]);
    expect(scripted.searches).toHaveLength(2);
  });

  it('sends edited content under a new key after an unclear save, and the sent content under its own', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE, {
      newRequestKey: keys(),
    });
    await store.getState().load();
    store.getState().startEntry();
    store.getState().updateDraft({
      title: 'Write the release notes',
      content: 'Cover the Ledger panel.',
    });

    // The answer is lost: the Ledger may have recorded the entry.
    const first = store.getState().submitDraft();
    scripted.answerAdd[0]?.(failure('UNKNOWN'));
    await first;
    expect(scripted.adds[0]?.requestKey).toBe('key-1');

    // Edited content never goes out under the key that carried the original.
    store.getState().updateDraft({ title: 'Write the release notes today' });
    expect(store.getState().composer.requestKey).toBe('key-2');
    const second = store.getState().submitDraft();
    expect(scripted.adds[1]).toMatchObject({
      requestKey: 'key-2',
      params: { title: 'Write the release notes today' },
    });
    scripted.answerAdd[1]?.(failure('UNKNOWN'));
    await second;

    // Typing more keeps the edited content's key until it is sent again.
    store.getState().updateDraft({ title: 'Write the release notes now' });
    expect(store.getState().composer.requestKey).toBe('key-3');
    store.getState().updateDraft({ title: 'Write the release notes today' });
    expect(store.getState().composer.requestKey).toBe('key-2');

    // Back to what the first save carried: its key, so a recorded entry is
    // returned rather than recorded twice.
    store.getState().updateDraft({ title: 'Write the release notes' });
    expect(store.getState().composer.requestKey).toBe('key-1');
  });

  it('asks for content before saving; a title is optional', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE, {
      newRequestKey: keys(),
    });
    store.getState().startEntry();
    store.getState().updateDraft({ title: 'Only a title' });

    await store.getState().submitDraft();

    expect(scripted.adds).toEqual([]);
    expect(store.getState().composer.problem).toEqual({
      reason: 'INVALID_INPUT',
      message: 'Add content.',
    });
  });

  it('omits a blank title, trims a supplied title, and accepts blank titles', () => {
    const blankTitle = {
      ...blankLedgerViewDraft('TASK'),
      title: '  \t ',
      content: '  Keep this content.  ',
    };
    expect(isLedgerDraftComplete(blankTitle)).toBe(true);
    expect(ledgerDraftAddParams(blankTitle)).toMatchObject({
      content: 'Keep this content.',
    });
    expect(ledgerDraftAddParams(blankTitle)).not.toHaveProperty('title');

    const titled = { ...blankTitle, title: '  A useful title  ' };
    expect(ledgerDraftAddParams(titled).title).toBe('A useful title');
  });

  it("brings a type's default status unless the person chose one", () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE, {
      newRequestKey: keys(),
    });
    store.getState().startEntry();

    store.getState().updateDraft({ type: 'DECISION' });
    expect(store.getState().composer.draft?.status).toBe('INFO');
    store.getState().updateDraft({ status: 'BLOCKED' });
    store.getState().updateDraft({ type: 'ACTION' });
    expect(store.getState().composer.draft?.status).toBe('BLOCKED');
  });

  it('starts an independent linked correction beside the composer draft', () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE, {
      newRequestKey: keys(),
    });
    const original = entry({ status: 'COMPLETED', type: 'DECISION' });

    store.getState().startEntry();
    store.getState().updateDraft({ title: 'A new entry', content: 'New.' });
    store.getState().startCorrection(original);
    const draft = store.getState().corrections[ENTRY_ID]?.draft;
    if (draft === undefined) throw new Error('Expected a correction');
    expect(draft).toMatchObject({
      type: 'DECISION',
      title: 'Write the release notes',
      content: '',
      status: 'INFO',
      supersedes: { entryId: ENTRY_ID, title: 'Write the release notes' },
    });
    expect(
      ledgerDraftAddParams({ ...draft, content: 'Corrected.' }),
    ).toMatchObject({ supersedesEntryId: ENTRY_ID });

    store.getState().updateCorrection(ENTRY_ID, {
      content: 'Keep this.',
      supersedes: null,
    });
    const existing = store.getState().corrections[ENTRY_ID];
    expect(existing?.draft.supersedes?.entryId).toBe(ENTRY_ID);
    store.getState().startCorrection(entry());
    expect(store.getState().corrections[ENTRY_ID]?.requestKey).toBe('key-2');
    expect(store.getState().corrections[ENTRY_ID]).toEqual(existing);
    expect(store.getState().composer).toMatchObject({
      requestKey: 'key-1',
      draft: { title: 'A new entry', content: 'New.' },
    });
  });

  it('saves and cancels corrections independently beside a new-entry draft', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE, {
      newRequestKey: keys(),
    });
    await store.getState().load();

    const adopted: LedgerViewDraft = {
      ...blankLedgerViewDraft('TASK'),
      title: 'Feed draft',
      content: 'Written in the Feed.',
    };
    const earlierCorrectionId = '00000000-0000-4000-8000-000000000200';
    store.getState().startCorrection(entry({ entryId: earlierCorrectionId }));
    store.getState().adoptDraft(adopted, 'feed-draft-1');
    expect(store.getState().composer.draft?.title).toBe('Feed draft');
    store.getState().cancelCorrection(earlierCorrectionId);
    const adoptSave = store.getState().submitDraft();
    scripted.answerAdd[0]?.(receipt(entry({ entryId: 'new-adopted-entry' })));
    await adoptSave;
    const savedAdopted = store.getState().savedAdopted;
    expect(savedAdopted).toEqual({
      adoptedId: 'feed-draft-1',
      entryId: 'new-adopted-entry',
    });

    const firstId = '00000000-0000-4000-8000-000000000201';
    const secondId = '00000000-0000-4000-8000-000000000202';
    const thirdId = '00000000-0000-4000-8000-000000000203';
    store.getState().startEntry();
    store.getState().updateDraft({ title: 'A new entry', content: 'New.' });
    const composer = store.getState().composer;
    store
      .getState()
      .startCorrection(
        entry({ entryId: firstId, title: 'First entry', type: 'DECISION' }),
      );
    store
      .getState()
      .updateCorrection(firstId, { content: 'First correction.' });
    store
      .getState()
      .startCorrection(entry({ entryId: secondId, title: 'Second entry' }));
    store
      .getState()
      .updateCorrection(secondId, { content: 'Second correction.' });
    store
      .getState()
      .startCorrection(entry({ entryId: thirdId, title: 'Third entry' }));
    store
      .getState()
      .updateCorrection(thirdId, { content: 'Third correction.' });
    store
      .getState()
      .updateCorrection(firstId, { highlights: ['Keep creation order.'] });
    expect(Object.keys(store.getState().corrections)).toEqual([
      firstId,
      secondId,
      thirdId,
    ]);

    const saveFirst = store.getState().submitCorrection(firstId);
    expect(scripted.adds[1]?.params.supersedesEntryId).toBe(firstId);
    expect(store.getState().corrections[firstId]?.saving).toBe(true);
    scripted.answerAdd[1]?.(receipt(entry({ entryId: 'saved-correction-1' })));
    // It resolves to the entry it became, so a host can show it in place.
    await expect(saveFirst).resolves.toBe('saved-correction-1');
    expect(store.getState().corrections[firstId]).toBeUndefined();
    expect(Object.keys(store.getState().corrections)).toEqual([
      secondId,
      thirdId,
    ]);
    expect(store.getState().corrections[secondId]?.draft.content).toBe(
      'Second correction.',
    );
    expect(store.getState().corrections[thirdId]?.draft.content).toBe(
      'Third correction.',
    );
    expect(store.getState().composer).toEqual(composer);
    expect(store.getState().savedAdopted).toEqual(savedAdopted);
    expect(store.getState().selectedEntryId).toBeNull();

    const saveComposer = store.getState().submitDraft();
    scripted.answerAdd[2]?.(receipt(entry({ entryId: 'saved-new-entry' })));
    await saveComposer;
    const closedComposer = store.getState().composer;
    expect(closedComposer.draft).toBeNull();
    expect(store.getState().corrections[secondId]?.draft.content).toBe(
      'Second correction.',
    );
    expect(store.getState().corrections[thirdId]?.draft.content).toBe(
      'Third correction.',
    );
    expect(store.getState().selectedEntryId).toBeNull();

    const saveSecond = store.getState().submitCorrection(secondId);
    scripted.answerAdd[3]?.(receipt(entry({ entryId: 'saved-correction-2' })));
    await saveSecond;
    expect(store.getState().corrections[secondId]).toBeUndefined();
    expect(Object.keys(store.getState().corrections)).toEqual([thirdId]);
    expect(store.getState().corrections[thirdId]?.draft.content).toBe(
      'Third correction.',
    );
    expect(store.getState().composer).toEqual(closedComposer);
    expect(store.getState().selectedEntryId).toBeNull();

    store.getState().cancelCorrection(thirdId);
    expect(store.getState().corrections[thirdId]).toBeUndefined();
    expect(store.getState().composer).toEqual(closedComposer);
  });

  it('keeps each correction key for its sends and returns to an unconfirmed send key', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE, {
      newRequestKey: keys(),
    });
    const firstId = '00000000-0000-4000-8000-000000000201';
    const secondId = '00000000-0000-4000-8000-000000000202';
    store.getState().startCorrection(entry({ entryId: firstId }));
    store
      .getState()
      .updateCorrection(firstId, { content: 'First correction.' });
    store.getState().startCorrection(entry({ entryId: secondId }));
    store
      .getState()
      .updateCorrection(secondId, { content: 'Second correction.' });

    const first = store.getState().submitCorrection(firstId);
    scripted.answerAdd[0]?.(failure('UNKNOWN'));
    await expect(first).resolves.toBeNull();
    expect(store.getState().corrections[firstId]?.unconfirmed).toHaveLength(1);
    expect(store.getState().corrections[secondId]?.unconfirmed).toEqual([]);

    const firstRetry = store.getState().submitCorrection(firstId);
    expect(scripted.adds[1]?.requestKey).toBe('key-1');
    scripted.answerAdd[1]?.(failure('UNKNOWN'));
    await firstRetry;

    const second = store.getState().submitCorrection(secondId);
    expect(scripted.adds[2]?.requestKey).toBe('key-2');
    scripted.answerAdd[2]?.(failure('UNKNOWN'));
    await second;
    const secondRetry = store.getState().submitCorrection(secondId);
    expect(scripted.adds[3]?.requestKey).toBe('key-2');
    scripted.answerAdd[3]?.(failure('UNKNOWN'));
    await secondRetry;

    store
      .getState()
      .updateCorrection(firstId, { title: 'First correction edited' });
    expect(store.getState().corrections[firstId]?.requestKey).toBe('key-3');
    const edited = store.getState().submitCorrection(firstId);
    expect(scripted.adds[4]?.requestKey).toBe('key-3');
    scripted.answerAdd[4]?.(failure('UNKNOWN'));
    await edited;

    store.getState().updateCorrection(firstId, { title: 'Another version' });
    expect(store.getState().corrections[firstId]?.requestKey).toBe('key-4');
    store.getState().updateCorrection(firstId, {
      title: 'First correction edited',
    });
    expect(store.getState().corrections[firstId]?.requestKey).toBe('key-3');
    store.getState().updateCorrection(firstId, {
      title: 'Write the release notes',
    });
    expect(store.getState().corrections[firstId]?.requestKey).toBe('key-1');
    expect(
      store
        .getState()
        .corrections[firstId]?.unconfirmed.map((send) => send.requestKey),
    ).toEqual(['key-1', 'key-3']);
    expect(
      store
        .getState()
        .corrections[secondId]?.unconfirmed.map((send) => send.requestKey),
    ).toEqual(['key-2']);
  });

  it("refreshes a correction owner's eligibility token and retries once", async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE, {
      newRequestKey: keys(),
    });
    const entryId = '00000000-0000-4000-8000-000000000201';
    store.getState().startCorrection(entry({ entryId }));
    store.getState().updateCorrection(entryId, {
      content: 'Assign the correction.',
      owner: candidate(CHAT, 'Parser fixes', 'token-old'),
    });

    const saving = store.getState().submitCorrection(entryId);
    expect(scripted.adds[0]?.requestKey).toBe('key-1');
    scripted.answerAdd[0]?.(failure('OWNER_UNAVAILABLE'));
    await settle();
    scripted.answerOwners[0]?.({
      status: 'ok',
      value: {
        candidates: [
          candidate(YOU, 'You', 'token-you'),
          candidate(CHAT, 'Parser fixes', 'token-new'),
        ],
        nextCursor: null,
      },
    });
    await settle();
    expect(scripted.adds[1]).toMatchObject({
      requestKey: 'key-2',
      params: {
        owner: { actorId: CHAT.actorId, eligibilityToken: 'token-new' },
        supersedesEntryId: entryId,
      },
    });
    scripted.answerAdd[1]?.(receipt(entry({ entryId: 'saved-correction' })));
    await saving;

    expect(store.getState().corrections[entryId]).toBeUndefined();
    expect(store.getState().selectedEntryId).toBeNull();
  });

  it('keeps a failed correction and key, and ignores cancel while saving', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE, {
      newRequestKey: keys(),
    });
    const entryId = '00000000-0000-4000-8000-000000000201';
    store.getState().startCorrection(entry({ entryId }));
    store.getState().updateCorrection(entryId, { content: 'Try again.' });

    const saving = store.getState().submitCorrection(entryId);
    store.getState().cancelCorrection(entryId);
    expect(store.getState().corrections[entryId]).toMatchObject({
      saving: true,
      requestKey: 'key-1',
    });
    scripted.answerAdd[0]?.(failure('REVISION_CONFLICT'));
    await saving;
    expect(store.getState().corrections[entryId]).toMatchObject({
      saving: false,
      requestKey: 'key-1',
      problem: { reason: 'REVISION_CONFLICT' },
      unconfirmed: [{ requestKey: 'key-1' }],
    });

    store.getState().cancelCorrection(entryId);
    expect(store.getState().corrections[entryId]).toBeUndefined();
  });

  it('drops a correction save in flight when the view resets', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE, {
      newRequestKey: keys(),
    });
    const entryId = '00000000-0000-4000-8000-000000000201';
    store.getState().startCorrection(entry({ entryId }));
    store.getState().updateCorrection(entryId, { content: 'A correction.' });
    const saving = store.getState().submitCorrection(entryId);

    store.getState().reset();
    expect(store.getState().corrections).toEqual({});
    scripted.answerAdd[0]?.(receipt(entry({ entryId: 'saved-correction' })));
    await saving;

    expect(store.getState().corrections).toEqual({});
    expect(store.getState().selectedEntryId).toBeNull();
    expect(scripted.reads).toEqual([]);
  });

  it('reports whether the view holds a new-entry or correction draft', () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE, {
      newRequestKey: keys(),
    });
    expect(ledgerViewHoldsDraft(store.getState())).toBe(false);

    store.getState().startEntry();
    expect(ledgerViewHoldsDraft(store.getState())).toBe(true);
    store.getState().discardDraft();

    const entryId = '00000000-0000-4000-8000-000000000201';
    store.getState().startCorrection(entry({ entryId }));
    expect(ledgerViewHoldsDraft(store.getState())).toBe(true);
    store.getState().cancelCorrection(entryId);
    expect(ledgerViewHoldsDraft(store.getState())).toBe(false);
  });

  it('takes a draft written elsewhere, under a fresh key, unless it has its own', () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE, {
      newRequestKey: keys(),
    });
    const written: LedgerViewDraft = {
      ...blankLedgerViewDraft('DECISION'),
      title: 'Keep one writer',
      content: 'Only core commits.',
    };
    expect(written.status).toBe('INFO');

    expect(store.getState().adoptDraft(written, 'feed-draft-1')).toBe(true);
    expect(store.getState().composer).toEqual({
      draft: written,
      shown: true,
      saving: false,
      requestKey: 'key-1',
      unconfirmed: [],
      problem: null,
      adoptedId: 'feed-draft-1',
    });

    // A view keeps its own draft.
    expect(
      store.getState().adoptDraft({ ...written, title: 'Another' }, 'other'),
    ).toBe(false);
    expect(store.getState().composer.adoptedId).toBe('feed-draft-1');
    expect(store.getState().composer.draft?.title).toBe('Keep one writer');
    expect(store.getState().composer.requestKey).toBe('key-1');

    // A draft the view starts itself carries no ID.
    store.getState().discardDraft();
    store.getState().startEntry();
    expect(store.getState().composer.adoptedId).toBeNull();
  });

  it('remembers the entry a draft taken from elsewhere became, and only that', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE, {
      newRequestKey: keys(),
    });
    await store.getState().load();
    const written: LedgerViewDraft = {
      ...blankLedgerViewDraft('TASK'),
      title: 'Write the release notes',
      content: 'Cover the Ledger panel.',
    };

    // Discarded: nothing saved.
    store.getState().adoptDraft(written, 'feed-draft-1');
    store.getState().discardDraft();
    expect(store.getState().savedAdopted).toBeNull();

    // Saved: the ID it came with, and the entry it became.
    store.getState().adoptDraft(written, 'feed-draft-2');
    const save = store.getState().submitDraft();
    scripted.answerAdd[0]?.(receipt(entry()));
    await save;
    expect(store.getState().savedAdopted).toEqual({
      adoptedId: 'feed-draft-2',
      entryId: ENTRY_ID,
    });

    // A draft started here carries no ID, and its save records none.
    store.getState().startEntry();
    store.getState().updateDraft({ title: 'Its own', content: 'Here.' });
    const own = store.getState().submitDraft();
    scripted.answerAdd[1]?.(receipt(entry()));
    await own;
    expect(store.getState().savedAdopted).toBeNull();
  });

  it('lets a draft go to move it, unless the Ledger may have recorded it here', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE, {
      newRequestKey: keys(),
    });
    await store.getState().load();
    store.getState().startEntry();
    store.getState().updateDraft({
      title: 'Keep one writer',
      content: 'Only core commits.',
    });

    expect(ledgerDraftMovable(store.getState().composer)).toBe(true);
    expect(store.getState().releaseDraft()).toMatchObject({
      title: 'Keep one writer',
      content: 'Only core commits.',
    });
    expect(store.getState().composer).toMatchObject({
      draft: null,
      shown: false,
      requestKey: null,
    });

    store.getState().startEntry();
    store.getState().updateDraft({
      title: 'Keep one writer',
      content: 'Only core commits.',
    });
    const save = store.getState().submitDraft();
    // Not while it saves...
    expect(ledgerDraftMovable(store.getState().composer)).toBe(false);
    expect(store.getState().releaseDraft()).toBeNull();
    scripted.answerAdd[0]?.(failure('UNKNOWN'));
    await save;
    // ...nor once a send came back without a receipt.
    expect(ledgerDraftMovable(store.getState().composer)).toBe(false);
    expect(store.getState().releaseDraft()).toBeNull();
    expect(store.getState().composer.draft?.title).toBe('Keep one writer');
  });

  it('keeps corrections out of the movable new-entry composer', () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE, {
      newRequestKey: keys(),
    });
    store.getState().startCorrection(entry({ status: 'COMPLETED' }));

    expect(ledgerDraftMovable(store.getState().composer)).toBe(false);
    expect(store.getState().releaseDraft()).toBeNull();
    expect(store.getState().composer.draft).toBeNull();
    expect(
      store.getState().corrections[ENTRY_ID]?.draft.supersedes?.entryId,
    ).toBe(ENTRY_ID);
    store.getState().startEntry();
    expect(ledgerDraftMovable(store.getState().composer)).toBe(true);
  });

  it('assigns a chosen owner by its eligibility token', () => {
    const chat = candidate(CHAT, 'Parser fixes', 'token-chat');
    const draft = {
      type: 'TASK' as const,
      title: 'Fix the parser',
      content: 'Replay events.',
      highlights: [],
      referenceFiles: [{ rootId: 'repo-1', path: 'src/a.ts', startLine: 3 }],
      status: 'TODO' as const,
      owner: chat,
      supersedes: null,
    };

    expect(ledgerDraftAddParams(draft)).toEqual({
      type: 'TASK',
      title: 'Fix the parser',
      content: 'Replay events.',
      referenceFiles: [{ rootId: 'repo-1', path: 'src/a.ts', startLine: 3 }],
      status: 'TODO',
      owner: { actorId: CHAT.actorId, eligibilityToken: 'token-chat' },
    });
  });

  it("saves again with the same owner's fresh token when the draft's token expired", async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE, {
      newRequestKey: keys(),
    });
    await store.getState().load();
    store.getState().startEntry();
    store.getState().updateDraft({
      title: 'Fix the parser',
      content: 'Replay events.',
      owner: candidate(CHAT, 'Parser fixes', 'token-old'),
    });

    const saving = store.getState().submitDraft();
    scripted.answerAdd[0]?.(failure('OWNER_UNAVAILABLE'));
    await settle();
    // The owners are read again; the chat is still assignable.
    scripted.answerOwners[0]?.({
      status: 'ok',
      value: {
        candidates: [
          candidate(YOU, 'You', 'token-you'),
          candidate(CHAT, 'Parser fixes', 'token-new'),
        ],
        nextCursor: null,
      },
    });
    await settle();
    expect(scripted.adds[1]).toMatchObject({
      requestKey: 'key-2',
      params: {
        owner: { actorId: CHAT.actorId, eligibilityToken: 'token-new' },
      },
    });
    scripted.answerAdd[1]?.(receipt(entry({ owner: CHAT })));
    await saving;

    expect(scripted.adds).toHaveLength(2);
    expect(store.getState().composer.draft).toBeNull();
  });

  it('never saves again for another pause of the same pipeline agent', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE, {
      newRequestKey: keys(),
    });
    const agent: LedgerActorRef = { ...CHAT, kind: 'pipeline_agent' };
    const pause = {
      executionId: 'execution-1',
      jobId: 'review',
      stepId: 'agent',
      attempt: 1,
      checkpointId: 'checkpoint-1',
      pausedAt: null,
    };
    await store.getState().load();
    store.getState().startEntry();
    store.getState().updateDraft({
      title: 'Review the release',
      content: 'Check the notes.',
      owner: {
        ...candidate(agent, 'Review changes', 'token-old'),
        pipelineAgent: pause,
      },
    });

    const saving = store.getState().submitDraft();
    scripted.answerAdd[0]?.(failure('OWNER_UNAVAILABLE'));
    await settle();
    // The run resumed and paused again: the same actor, another checkpoint.
    scripted.answerOwners[0]?.({
      status: 'ok',
      value: {
        candidates: [
          {
            ...candidate(agent, 'Review changes', 'token-new'),
            pipelineAgent: { ...pause, checkpointId: 'checkpoint-2' },
          },
        ],
        nextCursor: null,
      },
    });
    await saving;

    expect(scripted.adds).toHaveLength(1);
    expect(store.getState().composer).toMatchObject({
      saving: false,
      problem: { reason: 'OWNER_UNAVAILABLE' },
      draft: { owner: { pipelineAgent: { checkpointId: 'checkpoint-1' } } },
    });
  });

  it('keeps the explanation when the chosen owner is no longer assignable', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE, {
      newRequestKey: keys(),
    });
    await store.getState().load();
    store.getState().startEntry();
    store.getState().updateDraft({
      title: 'Fix the parser',
      content: 'Replay events.',
      owner: candidate(CHAT, 'Parser fixes', 'token-old'),
    });

    const saving = store.getState().submitDraft();
    scripted.answerAdd[0]?.(failure('OWNER_UNAVAILABLE'));
    await settle();
    scripted.answerOwners[0]?.({
      status: 'ok',
      value: {
        candidates: [candidate(YOU, 'You', 'token-you')],
        nextCursor: null,
      },
    });
    await saving;

    expect(scripted.adds).toHaveLength(1);
    expect(store.getState().composer).toMatchObject({
      saving: false,
      problem: { reason: 'OWNER_UNAVAILABLE' },
      draft: { owner: { eligibilityToken: 'token-old' } },
    });
  });

  it('sets a draft aside when an entry is selected, and keeps it', async () => {
    const scripted = scriptedClient();
    const store = await selected(scripted);
    store.getState().startEntry();
    store.getState().updateDraft({ title: 'Kept' });

    await store.getState().select(ENTRY_ID);
    expect(store.getState().composer).toMatchObject({
      shown: false,
      draft: { title: 'Kept' },
    });
    store.getState().startEntry();
    expect(store.getState().composer).toMatchObject({
      shown: true,
      draft: { title: 'Kept' },
      requestKey: 'key-1',
    });
  });

  it('leaves the person on the entry they chose while a draft was saving', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE, {
      newRequestKey: keys(),
    });
    const OTHER_ID = '00000000-0000-4000-8000-000000000202';
    await store.getState().load();
    store.getState().startEntry();
    store.getState().updateDraft({ title: 'A', content: 'B' });

    const saving = store.getState().submitDraft();
    scripted.readAnswer.current = view(entry({ entryId: OTHER_ID }));
    await store.getState().select(OTHER_ID);
    scripted.answerAdd[0]?.(receipt(entry()));
    await saving;

    // Saved, and the list catches up; the selection is the person's.
    expect(store.getState().composer.draft).toBeNull();
    expect(store.getState().selectedEntryId).toBe(OTHER_ID);
    expect(scripted.searches).toHaveLength(2);
  });

  it('drops a save in flight when the view resets', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE, {
      newRequestKey: keys(),
    });
    store.getState().startEntry();
    store.getState().updateDraft({ title: 'A', content: 'B' });
    const saving = store.getState().submitDraft();

    store.getState().reset();
    scripted.answerAdd[0]?.(receipt(entry()));
    await saving;

    expect(store.getState().composer.draft).toBeNull();
    expect(store.getState().selectedEntryId).toBeNull();
    expect(scripted.reads).toEqual([]);
  });
});

describe('Ledger view status and owner changes', () => {
  it.each(BY_ID_CHANGE_KINDS)(
    'selects and reads a different entry before changing its %s',
    async (kind) => {
      const scripted = scriptedClient();
      const store = await selected(scripted);
      const targetId = '00000000-0000-4000-8000-000000000202';
      const readsBefore = scripted.reads.length;
      scripted.readAnswer.current = view(entry({ entryId: targetId }));

      const changing = changeById(store, kind, targetId);
      await settle();
      expect(scripted.reads).toHaveLength(readsBefore + 1);
      expect(scripted.reads.at(-1)?.entryId).toBe(targetId);
      expect(scripted.updates[0]?.params.entryId).toBe(targetId);
      expect(store.getState().selectedEntryId).toBe(targetId);

      const changed =
        kind === 'status'
          ? entry({ entryId: targetId, revision: 2, status: 'BLOCKED' })
          : entry({ entryId: targetId, revision: 2, owner: CHAT });
      scripted.readAnswer.current = view(changed);
      scripted.answerUpdate[0]?.(receipt(changed));
      await changing;
    },
  );

  it.each(BY_ID_CHANGE_KINDS)(
    'changes the already selected and ready entry without an extra detail read (%s)',
    async (kind) => {
      const scripted = scriptedClient();
      const store = await selected(scripted);
      const readsBefore = scripted.reads.length;

      const changing = changeById(store, kind, ENTRY_ID);
      await settle();
      expect(scripted.reads).toHaveLength(readsBefore);
      expect(scripted.updates[0]?.params.entryId).toBe(ENTRY_ID);
      scripted.answerUpdate[0]?.(failure('UNKNOWN'));
      await changing;
    },
  );

  it.each(BY_ID_CHANGE_KINDS)(
    'does not change a closed entry (%s)',
    async (kind) => {
      const scripted = scriptedClient();
      const store = await selected(scripted, entry({ status: 'COMPLETED' }));

      await changeById(store, kind, ENTRY_ID);

      expect(scripted.updates).toEqual([]);
    },
  );

  it.each(BY_ID_CHANGE_KINDS)(
    'does not change an entry whose detail read failed (%s)',
    async (kind) => {
      const scripted = scriptedClient();
      const store = await selected(scripted);
      const targetId = '00000000-0000-4000-8000-000000000202';
      scripted.readAnswer.current = failure('STORAGE_UNAVAILABLE');

      await changeById(store, kind, targetId);

      expect(store.getState().selectedEntryId).toBe(targetId);
      expect(store.getState().detail.status).toBe('problem');
      expect(scripted.updates).toEqual([]);
    },
  );

  it.each(BY_ID_CHANGE_KINDS)(
    'does not apply a change after its superseded entry read resolves (%s)',
    async (kind) => {
      const scripted = scriptedClient();
      const store = await selected(scripted);
      const entryA = '00000000-0000-4000-8000-000000000202';
      const entryB = '00000000-0000-4000-8000-000000000203';
      const readA = deferred<LedgerViewResult<LedgerViewEntry>>();
      const readB = deferred<LedgerViewResult<LedgerViewEntry>>();
      scripted.readAnswers.push(readA.promise, readB.promise);

      const changingA = changeById(store, kind, entryA);
      await settle();
      const selectingB = store.getState().select(entryB);
      readB.resolve(view(entry({ entryId: entryB })));
      await selectingB;
      readA.resolve(view(entry({ entryId: entryA })));
      await changingA;

      expect(store.getState().selectedEntryId).toBe(entryB);
      expect(store.getState().detail.view?.entry.entry.entryId).toBe(entryB);
      expect(scripted.updates).toEqual([]);
    },
  );

  it.each(BY_ID_CHANGE_KINDS)(
    'does not apply a change after the view resets during its read (%s)',
    async (kind) => {
      const scripted = scriptedClient();
      const store = await selected(scripted);
      const targetId = '00000000-0000-4000-8000-000000000202';
      const read = deferred<LedgerViewResult<LedgerViewEntry>>();
      scripted.readAnswers.push(read.promise);

      const changing = changeById(store, kind, targetId);
      await settle();
      store.getState().reset();
      read.resolve(view(entry({ entryId: targetId })));
      await changing;

      expect(store.getState().selectedEntryId).toBeNull();
      expect(scripted.updates).toEqual([]);
    },
  );

  it('changes status from the revision shown, then reads the entry again', async () => {
    const scripted = scriptedClient();
    const store = await selected(scripted);
    const readsBefore = scripted.reads.length;

    const changing = store.getState().changeStatus('IN_PROGRESS');
    expect(store.getState().change.saving).toBe(true);
    expect(scripted.updates[0]).toEqual({
      scope: SCOPE,
      requestKey: 'key-1',
      params: { entryId: ENTRY_ID, expectedRevision: 1, status: 'IN_PROGRESS' },
    });
    scripted.readAnswer.current = view(
      entry({ revision: 2, status: 'IN_PROGRESS' }),
    );
    scripted.answerUpdate[0]?.(
      receipt(entry({ revision: 2, status: 'IN_PROGRESS' })),
    );
    await changing;

    expect(store.getState().change).toMatchObject({
      saving: false,
      notice: null,
      request: null,
    });
    expect(scripted.reads.length).toBe(readsBefore + 1);
    expect(store.getState().detail.view?.entry.entry.revision).toBe(2);
  });

  it('shows a problem, not the old entry, when the read after a saved change fails', async () => {
    const scripted = scriptedClient();
    const store = await selected(scripted);

    const changing = store.getState().changeStatus('BLOCKED');
    scripted.readAnswer.current = failure('STORAGE_UNAVAILABLE');
    scripted.answerUpdate[0]?.(
      receipt(entry({ revision: 2, status: 'BLOCKED' })),
    );
    await changing;

    expect(store.getState().change).toEqual({
      saving: false,
      request: null,
      notice: null,
      message: null,
    });
    expect(store.getState().detail).toMatchObject({
      status: 'problem',
      view: null,
      problem: { kind: 'error', reason: 'STORAGE_UNAVAILABLE' },
    });
  });

  it('shows a problem when the read after a newer revision was announced fails', async () => {
    const scripted = scriptedClient();
    const store = await selected(scripted);

    scripted.readAnswer.current = failure('STORAGE_UNAVAILABLE');
    store.getState().applyChanges({
      changes: [{ scope: SCOPE, entryId: ENTRY_ID, revision: 2 }],
    });
    await settle();

    expect(store.getState().detail).toMatchObject({
      status: 'problem',
      view: null,
    });
  });

  it('reads the entry again after a conflict instead of replaying the change', async () => {
    const scripted = scriptedClient();
    const store = await selected(scripted);
    const chat = candidate(CHAT, 'Parser fixes', 'token-chat');

    const assigning = store.getState().assignOwner(chat);
    expect(scripted.updates[0]?.params).toEqual({
      entryId: ENTRY_ID,
      expectedRevision: 1,
      owner: { actorId: CHAT.actorId, eligibilityToken: 'token-chat' },
    });
    scripted.readAnswer.current = view(entry({ revision: 2 }));
    scripted.answerUpdate[0]?.(failure('REVISION_CONFLICT'));
    await assigning;

    expect(store.getState().change).toMatchObject({
      notice: 'conflict',
      request: null,
    });
    expect(store.getState().detail.view?.entry.entry.revision).toBe(2);
    expect(scripted.updates).toHaveLength(1);
  });

  it('reads the owners again when the chosen owner is no longer available', async () => {
    const scripted = scriptedClient();
    const store = await selected(scripted);
    const chat = candidate(CHAT, 'Parser fixes', 'token-stale');

    const assigning = store.getState().assignOwner(chat);
    scripted.answerUpdate[0]?.(failure('OWNER_UNAVAILABLE'));
    await settle();
    expect(store.getState().change.notice).toBe('owner_unavailable');
    expect(scripted.ownerRequests).toEqual([{ scope: SCOPE }]);
    scripted.answerOwners[0]?.({
      status: 'ok',
      value: {
        candidates: [candidate(YOU, 'You', 'token-you')],
        nextCursor: null,
      },
    });
    await assigning;

    expect(store.getState().owners).toMatchObject({
      status: 'ready',
      candidates: [{ displayName: 'You' }],
    });
  });

  it('tries a failed change again with the same request key', async () => {
    const scripted = scriptedClient();
    const store = await selected(scripted);

    const first = store.getState().changeStatus('BLOCKED');
    scripted.answerUpdate[0]?.(failure('UNKNOWN'));
    await first;
    expect(store.getState().change).toMatchObject({
      notice: 'failed',
      message: 'UNKNOWN happened',
      request: { requestKey: 'key-1', status: 'BLOCKED' },
    });

    const retry = store.getState().retryChange();
    expect(scripted.updates[1]?.requestKey).toBe('key-1');
    scripted.answerUpdate[1]?.(receipt(entry({ revision: 2 })));
    await retry;
    expect(store.getState().change.notice).toBeNull();
  });

  it.each<[string, LedgerStatus]>([
    ['completed', 'COMPLETED'],
    ['failed', 'FAILED'],
    ['informational', 'INFO'],
  ])('changes nothing on a %s entry', async (_case, status) => {
    const scripted = scriptedClient();
    const store = await selected(scripted, entry({ status }));

    await store.getState().changeStatus('IN_PROGRESS');
    await store.getState().assignOwner(null);

    expect(scripted.updates).toEqual([]);
  });

  it('reads every page of owners', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE, {
      newRequestKey: keys(),
    });

    const loading = store.getState().loadOwners();
    expect(store.getState().owners.status).toBe('loading');
    scripted.answerOwners[0]?.({
      status: 'ok',
      value: {
        candidates: [candidate(YOU, 'You', 'token-you')],
        nextCursor: 'owners-1',
      },
    });
    await settle();
    expect(scripted.ownerRequests[1]).toEqual({
      scope: SCOPE,
      cursor: 'owners-1',
    });
    scripted.answerOwners[1]?.({
      status: 'ok',
      value: {
        candidates: [candidate(CHAT, 'Parser fixes', 'token-chat')],
        nextCursor: null,
      },
    });
    await loading;

    expect(
      store.getState().owners.candidates.map((owner) => owner.displayName),
    ).toEqual(['You', 'Parser fixes']);
  });

  it('reads owners past any number of pages, and never drops a cursor', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE, {
      newRequestKey: keys(),
    });
    const pages = 7;

    const loading = store.getState().loadOwners();
    for (let page = 0; page < pages; page += 1) {
      await settle();
      expect(scripted.ownerRequests[page]).toEqual({
        scope: SCOPE,
        ...(page === 0 ? {} : { cursor: `owners-${page}` }),
      });
      scripted.answerOwners[page]?.({
        status: 'ok',
        value: {
          candidates: [
            candidate(
              { ...CHAT, actorId: `${CHAT.actorId.slice(0, -2)}${10 + page}` },
              `Chat ${page + 1}`,
              `token-${page}`,
            ),
          ],
          nextCursor: page === pages - 1 ? null : `owners-${page + 1}`,
        },
      });
    }
    await loading;

    expect(store.getState().owners.status).toBe('ready');
    expect(store.getState().owners.candidates).toHaveLength(pages);
    expect(scripted.ownerRequests).toHaveLength(pages);
  });

  it('reports a problem instead of looping when the Ledger repeats a cursor', async () => {
    const scripted = scriptedClient();
    const store = createLedgerViewStore(scripted.client, SCOPE, {
      newRequestKey: keys(),
    });

    const loading = store.getState().loadOwners();
    scripted.answerOwners[0]?.({
      status: 'ok',
      value: {
        candidates: [candidate(YOU, 'You', 'token-you')],
        nextCursor: 'owners-1',
      },
    });
    await settle();
    scripted.answerOwners[1]?.({
      status: 'ok',
      value: { candidates: [], nextCursor: 'owners-1' },
    });
    await loading;

    expect(scripted.ownerRequests).toHaveLength(2);
    expect(store.getState().owners).toMatchObject({
      status: 'problem',
      candidates: [],
      problem: { reason: 'UNKNOWN' },
    });
  });

  it('clears the last notice when another entry is selected', async () => {
    const scripted = scriptedClient();
    const store = await selected(scripted);
    const changing = store.getState().changeStatus('BLOCKED');
    scripted.answerUpdate[0]?.(failure('UNKNOWN'));
    await changing;

    await store.getState().select('00000000-0000-4000-8000-000000000202');

    expect(store.getState().change.notice).toBeNull();
  });

  it('keeps an entry saving when the person comes back to it mid-change', async () => {
    const scripted = scriptedClient();
    const store = await selected(scripted);
    const OTHER_ID = '00000000-0000-4000-8000-000000000202';

    const changing = store.getState().changeStatus('BLOCKED');
    scripted.readAnswer.current = view(entry({ entryId: OTHER_ID }));
    await store.getState().select(OTHER_ID);
    expect(store.getState().change.saving).toBe(false);
    scripted.readAnswer.current = view(entry());
    await store.getState().select(ENTRY_ID);

    // Still saving: a second change cannot go out beside the first.
    expect(store.getState().change).toMatchObject({
      saving: true,
      request: { entryId: ENTRY_ID, status: 'BLOCKED' },
    });
    await store.getState().changeStatus('IN_PROGRESS');
    expect(scripted.updates).toHaveLength(1);

    scripted.readAnswer.current = view(
      entry({ revision: 2, status: 'BLOCKED' }),
    );
    scripted.answerUpdate[0]?.(
      receipt(entry({ revision: 2, status: 'BLOCKED' })),
    );
    await changing;
    expect(store.getState().change.saving).toBe(false);
    expect(store.getState().detail.view?.entry.entry.status).toBe('BLOCKED');
  });

  it("keeps a change's outcome off another entry selected while it was saving", async () => {
    const scripted = scriptedClient();
    const store = await selected(scripted);
    const otherId = '00000000-0000-4000-8000-000000000202';

    const changing = store.getState().changeStatus('BLOCKED');
    scripted.readAnswer.current = view(entry({ entryId: otherId }));
    await store.getState().select(otherId);
    scripted.answerUpdate[0]?.(failure('UNKNOWN'));
    await changing;

    // The other entry shows nothing of it, and "Try again" sends nothing.
    expect(store.getState().change).toEqual({
      saving: false,
      request: null,
      notice: null,
      message: null,
    });
    await store.getState().retryChange();
    expect(scripted.updates).toHaveLength(1);
    expect(store.getState().detail.view?.entry.entry.entryId).toBe(otherId);

    // Back on its own entry, the failed change is there to try again.
    scripted.readAnswer.current = view(entry());
    await store.getState().select(ENTRY_ID);
    expect(store.getState().change).toMatchObject({
      saving: false,
      notice: 'failed',
      request: { entryId: ENTRY_ID, status: 'BLOCKED', requestKey: 'key-1' },
    });
    const retrying = store.getState().retryChange();
    expect(scripted.updates[1]).toMatchObject({
      requestKey: 'key-1',
      params: { entryId: ENTRY_ID, status: 'BLOCKED' },
    });
    scripted.answerUpdate[1]?.(
      receipt(entry({ revision: 2, status: 'BLOCKED' })),
    );
    await retrying;
    expect(store.getState().change.notice).toBeNull();
  });

  it('tells the person, back on an entry, that their change met a newer version', async () => {
    const scripted = scriptedClient();
    const store = await selected(scripted);
    const otherId = '00000000-0000-4000-8000-000000000202';

    const changing = store.getState().changeStatus('BLOCKED');
    scripted.readAnswer.current = view(entry({ entryId: otherId }));
    await store.getState().select(otherId);
    scripted.answerUpdate[0]?.(failure('REVISION_CONFLICT'));
    await changing;
    expect(store.getState().change.notice).toBeNull();

    scripted.readAnswer.current = view(
      entry({ revision: 2, status: 'IN_PROGRESS' }),
    );
    await store.getState().select(ENTRY_ID);
    expect(store.getState().change).toMatchObject({
      saving: false,
      notice: 'conflict',
      request: null,
    });
    // Shown once: leaving and returning starts clean.
    await store.getState().select(null);
    await store.getState().select(ENTRY_ID);
    expect(store.getState().change.notice).toBeNull();
  });

  it('reads the entry again with a loading state after a conflict, so a failed read is never shown as the latest', async () => {
    const scripted = scriptedClient();
    const store = await selected(scripted);

    const changing = store.getState().changeStatus('BLOCKED');
    scripted.readAnswer.current = failure('STORAGE_UNAVAILABLE');
    scripted.answerUpdate[0]?.(failure('REVISION_CONFLICT'));
    await changing;

    expect(store.getState().change.notice).toBe('conflict');
    expect(store.getState().detail).toMatchObject({
      status: 'problem',
      view: null,
      problem: { kind: 'error', reason: 'STORAGE_UNAVAILABLE' },
    });
  });
});
