import { createHash } from 'node:crypto';
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import * as overlayModule from '@canopy/agent-transcript/lib/delegation-transcript';
import {
  IPC_CHANNELS,
  type ChatStateChangedEvent,
  type ChatStateSnapshot,
  type DelegatedAgentCallBlock,
  type PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import type {
  DelegationTranscriptContentRange,
  DelegationTranscriptPortResult,
} from '@canopy/desktop-shared/node/delegation/transcript-port';
import {
  C38_MANIFEST,
  c38Backing,
  c38ProbeIndices,
  c38Target,
  type C38Backing,
  type C38Card,
} from './helpers/delegation-c38-harness';
import { createDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { registerChatStateHandlers } from '../ipc/chat-state';
import {
  applyCanonicalChanges,
  type CanonicalScopeProjection,
} from '../../renderer/src/stores/chat/canonical-changes';
import { fromPersistedTab } from '../../renderer/src/stores/chat/persisted-tabs';
import { RevisionedChatSync } from '../../renderer/src/stores/chat/revisioned-sync';

jest.mock('../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
jest.mock('../services/background-execution-context', () => ({
  ...jest.requireActual<object>('../services/background-execution-context'),
  backgroundExecutionContextEnabled: (): boolean => false,
}));
let mockRoot = '';
const evidenceDirectory = process.env.CANOPY_C38_EVIDENCE_DIR ?? tmpdir();
jest.mock('../lib/paths', () => ({
  ...jest.requireActual<object>('../lib/paths'),
  getWorktreeDataDir: (projectId: string, worktreeId: string): string =>
    join(mockRoot, projectId, worktreeId),
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: (): Promise<null> => Promise.resolve(null),
  subscribeCanopyCloudAccountChanges: (): (() => void) => () => undefined,
}));
jest.mock('../agents/delegation/route-runtime', () => ({
  DelegationRouteRuntime: jest.fn(() => ({ dispose: (): void => undefined })),
}));
jest.mock('../power/wake-lock-service', () => ({
  getWakeLockService: (): { acquire(): void; release(): void } => ({
    acquire: (): void => undefined,
    release: (): void => undefined,
  }),
}));
// The full fixture's beforeAll creates 500 genuine cards: more than an hour
// at load average 22 to 26.
jest.setTimeout(process.env.CANOPY_C38_SCALE === '1' ? 110 * 60_000 : 180_000);

// C38 covers the K9 subset. Portal live progress, portable full consume and
// observability ingress remain phase 15 and 16 limitations. No goldens change.
const size = process.env.CANOPY_C38_SCALE === '1' ? 'full' : 'small';
let backing: C38Backing | undefined;
let continuation: C38Card | undefined;
let previousDataDir: string | undefined;
let creationRows: readonly (PersistedChatMessage | undefined)[] = [];
let referenceRow: PersistedChatMessage | undefined;
let repaired = false;

function current(): C38Backing {
  if (!backing) throw new Error('Missing C38 backing');
  return backing;
}
function liveCard(): C38Card {
  if (!continuation) throw new Error('Missing continuation');
  return continuation;
}
function value<T>(result: DelegationTranscriptPortResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
function cardBlocks(
  rows: readonly PersistedChatMessage[],
): DelegatedAgentCallBlock[] {
  return rows.flatMap((row) =>
    row.blocks.flatMap((block) =>
      block.type === 'delegated_agent_call' ? [block] : [],
    ),
  );
}
function probe(index: number): C38Card {
  const card = current().cards.find((candidate) => candidate.index === index);
  if (!card) throw new Error(`Missing scripted card ${index}`);
  return card;
}
function prompt(card: C38Card): string {
  if (card.index === C38_MANIFEST[size].cards - 1)
    return `${'f'.repeat(256)}\n\n${'q'.repeat(2048)}`;
  return (card.runGeneration === 2 ? 'f' : 'p').repeat(256);
}
function status(card: C38Card): string {
  const indices = c38ProbeIndices(size);
  if (card === continuation) return repaired ? 'interrupted' : 'running';
  if (
    [
      indices['old-apply'],
      indices['old-discard'],
      indices['middle-apply'],
      indices['middle-discard'],
    ].includes(card.index)
  )
    return 'completed';
  if (card.index === indices['tail-fail']) return 'failed';
  if (card.index === indices['tail-stop']) return 'cancelled';
  return ['completed', 'failed', 'cancelled'][card.index % 3] ?? 'invalid';
}
function expected(card: C38Card): object {
  const indices = c38ProbeIndices(size);
  const common = {
    status: status(card),
    nativeSessionId: `c38-native-${card.delegationId}`,
  };
  if (card === continuation) return common;
  if (
    card.index === indices['old-apply'] ||
    card.index === indices['middle-apply']
  )
    return { ...common, control: { operation: 'apply', status: 'completed' } };
  if (
    card.index === indices['old-discard'] ||
    card.index === indices['middle-discard']
  )
    return {
      ...common,
      workspaceDiscarded: true,
      control: { operation: 'discard', status: 'completed' },
    };
  if (status(card) === 'failed')
    return {
      ...common,
      error: {
        code: 'runtime_error',
        message: 'e'.repeat(128),
        retryable: false,
      },
    };
  if (status(card) === 'completed')
    return { ...common, finalText: 'a'.repeat(256) };
  if (card.index === indices['tail-stop'])
    return { ...common, stopReason: 'user_cancelled', cancelledByUser: true };
  return common;
}
function assertCards(blocks: readonly DelegatedAgentCallBlock[]): void {
  expect(blocks).toHaveLength(C38_MANIFEST[size].afterContinuation);
  for (const card of current().cards) {
    const displayed = blocks.find(
      (block) => block.agentBlockId === card.messageId,
    );
    expect(displayed).toMatchObject({
      ...expected(card),
      prompt: prompt(card),
      description: 'd'.repeat(64),
      selectedModelId: 'logical-review-model',
      runtimeModelId: 'native-model',
      targetHarnessId: 'third-harness',
    });
  }
}
async function assertRaw(): Promise<void> {
  const f = current();
  expect(await Promise.all(f.cards.map((card) => f.rawCard(card)))).toEqual(
    creationRows,
  );
  const stored = await f.service.readStoredParentMessage(
    f.scope,
    f.chatId,
    'seed-reference',
  );
  expect(stored).toEqual(referenceRow);
  const reference = stored?.blocks.find(
    (block) => block.type === 'tool_result',
  );
  if (!reference || reference.type !== 'tool_result')
    throw new Error('Missing tool reference row');
  expect(reference.fullOutputRef).toBeDefined();
}
async function storedImage(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const image: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      image.push(
        ...(await storedImage(path)).map((line) => `${entry.name}/${line}`),
      );
    else if (entry.isFile())
      image.push(
        `${entry.name}:${createHash('sha256')
          .update(await readFile(path))
          .digest('hex')}`,
      );
  }
  return image;
}

async function readerMatrix(
  state = 'idle',
  throwOnFailure = true,
): Promise<readonly string[]> {
  const failures: string[] = [];
  const surfaces = new Map<string, boolean>();
  const check = (surface: string, action: () => void): void => {
    if (surfaces.get(surface) === false) return;
    try {
      action();
      surfaces.set(surface, true);
    } catch (error) {
      surfaces.set(surface, false);
      failures.push(
        `${surface}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const f = current();
  const scopeRevision = await f.repository.getRevision(f.scope);
  let initialRevision: number | undefined;
  const snapshot = await f.repository.getState(f.scope, {
    chatIds: [f.chatId],
    fullTranscript: true,
  });
  check('snapshot', () =>
    assertCards(
      cardBlocks(snapshot.tabsFile.tabs.flatMap((tab) => tab.messages)),
    ),
  );
  const messages: PersistedChatMessage[] = [];
  let before: number | undefined;
  let pages = 0;
  do {
    const page = await f.repository.page(
      f.scope,
      f.chatId,
      before,
      initialRevision,
    );
    initialRevision ??= page.transcriptRevision;
    expect(page.transcriptRevision).toBe(initialRevision);
    messages.push(...page.messages);
    expect(
      page.before === undefined || before === undefined || page.before < before,
    ).toBe(true);
    before = page.before;
    pages++;
    expect(pages).toBeLessThan(1000);
  } while (before !== undefined);
  expect(pages).toBeGreaterThan(1);
  expect(new Set(messages.map((row) => row.id)).size).toBe(messages.length);
  check('pages', () => assertCards(cardBlocks(messages)));

  // Enumerate every card's block pages, not only the default tail/cohorts.
  const blocks: DelegatedAgentCallBlock[] = [];
  for (const card of f.cards) {
    let ordinal: number | undefined;
    do {
      const page = await f.repository.blocks({
        ...f.scope,
        chatId: f.chatId,
        messageId: card.messageId,
        limit: 1,
        firstBlockOrdinal: ordinal,
      });
      expect(page.transcriptRevision).toBe(initialRevision);
      blocks.push(
        ...page.blocks.flatMap((block) =>
          block.type === 'delegated_agent_call' ? [block] : [],
        ),
      );
      expect(
        page.nextBlockOrdinal === undefined ||
          page.nextBlockOrdinal > (ordinal ?? 0),
      ).toBe(true);
      ordinal = page.nextBlockOrdinal;
    } while (ordinal !== undefined);
  }
  check('blocks', () => assertCards(blocks));
  const managed = await import('../agents/delegation/service');
  const advisor = await import('../app-advisor/delegation-read-actions');
  const roots = await managed.readManagedDelegationRootsForUser(f.scope);
  expect(roots).toMatchObject([
    {
      chatId: f.chatId,
      total: C38_MANIFEST[size].distinctDelegations,
      live: 0,
    },
  ]);
  expect(roots[0]?.lastActivityAt).toBeGreaterThan(0);
  surfaces.set('roots', true);
  const tree = await managed.readManagedDelegationTreeForUser({
    ...f.scope,
    chatId: f.chatId,
  });
  expect(tree).toHaveLength(C38_MANIFEST[size].afterContinuation);
  const advisorTree = await advisor.dispatchDelegationReadAction({
    type: 'delegation.tree',
    ...f.scope,
    chatId: f.chatId,
  });
  expect(advisorTree).toMatchObject({ ok: true, result: tree });
  check('Advisor tree durable task', () => {
    const at = tree.findIndex(
      (row) =>
        row.snapshot.delegationId === probe(0).delegationId &&
        row.runGeneration === probe(0).runGeneration,
    );
    expect(at).toBeGreaterThanOrEqual(0);
    expect(advisorTree).toMatchObject({
      ok: true,
      result: tree.map((_row, index) =>
        index === at
          ? {
              prompt: 'p'.repeat(256),
              description: 'd'.repeat(64),
              snapshot: expected(probe(0)),
            }
          : {},
      ),
    });
  });
  for (const card of f.cards) {
    const entry = tree.find(
      (row) =>
        row.snapshot.delegationId === card.delegationId &&
        row.runGeneration === card.runGeneration,
    );
    check('record tree task/snapshot', () =>
      expect(entry).toMatchObject({
        prompt: prompt(card),
        description: 'd'.repeat(64),
        snapshot: expected(card),
      }),
    );
  }
  // Old, middle and tail probes plus both continuation ancestors/generations.
  const selected = f.cards.filter(
    (card) =>
      Object.values(c38ProbeIndices(size)).includes(card.index) ||
      card.index === 3 ||
      card.index === 6,
  );
  for (const card of selected) {
    const request = {
      ...f.scope,
      chatId: f.chatId,
      delegationId: card.delegationId,
      runGeneration: card.runGeneration,
      limit: 1,
    };
    const header =
      await managed.readManagedDelegationTranscriptForUser(request);
    check('transcript header task/snapshot', () =>
      expect(header).toMatchObject({
        ok: true,
        task: { prompt: prompt(card), description: 'd'.repeat(64) },
        snapshot: expected(card),
      }),
    );
    const advisorHeader = await advisor.dispatchDelegationReadAction({
      type: 'delegation.transcript',
      ...request,
    });
    check('Advisor transcript task/snapshot', () =>
      expect(advisorHeader).toMatchObject({
        ok: true,
        result: { snapshot: expected(card), task: { prompt: prompt(card) } },
      }),
    );
  }
  const { getWorktreeChatTranscriptSeed } =
    await import('../services/chat-service');
  const seed = await getWorktreeChatTranscriptSeed({
    workspaceId: f.scope.projectId,
    worktreeId: f.scope.worktreeId,
    chatId: f.chatId,
  });
  const agents = seed.messages
    .flatMap((message) => message.parts)
    .flatMap((part) => (part?.kind === 'agent' ? [part.data] : []));
  check('Portal seed', () => {
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.length).toBeLessThanOrEqual(
      C38_MANIFEST[size].afterContinuation,
    );
    const emitted = new Set<string>();
    for (const data of agents) {
      if (
        typeof data !== 'object' ||
        data === null ||
        !('delegation' in data) ||
        typeof data.delegation !== 'object' ||
        data.delegation === null ||
        !('delegationId' in data.delegation) ||
        !('runGeneration' in data.delegation)
      )
        throw new Error('Malformed Portal agent data');
      const delegation = data.delegation;
      emitted.add(
        `${String(delegation.delegationId)}:${String(delegation.runGeneration)}`,
      );
      const card = f.cards.find(
        (candidate) =>
          candidate.delegationId === delegation.delegationId &&
          candidate.runGeneration === delegation.runGeneration,
      );
      if (!card) throw new Error('Portal returned an unowned generation');
      expect(delegation).toMatchObject({
        ...expected(card),
        prompt:
          card.index === C38_MANIFEST[size].cards - 1
            ? `${'f'.repeat(256)}\n\n${'q'.repeat(1719)}\n\n[truncated 306 chars]`
            : prompt(card),
      });
    }
    // Portal seed is intentionally a bounded tail, not a full 500-card reader.
    for (const card of [liveCard(), probe(C38_MANIFEST[size].cards - 1)])
      expect(emitted.has(`${card.delegationId}:${card.runGeneration}`)).toBe(
        true,
      );
    expect(seed.truncated).toBe(true);
  });

  const overlay = jest.spyOn(
    overlayModule,
    'overlayStreamBackedDelegationCard',
  );
  try {
    for (const query of ['a'.repeat(256), 'e'.repeat(128), 'answer 🌲漢字']) {
      expect(
        await f.repository.search({
          ...f.scope,
          chatId: f.chatId,
          requestId: `c38-search-${query.length}`,
          query,
        }),
      ).toEqual({ matches: [], totalCount: 0 });
    }
    expect(overlay).toHaveBeenCalled();
    surfaces.set('search overlay observed', true);
    expect(
      await f.repository.search({
        ...f.scope,
        chatId: f.chatId,
        requestId: 'ordinary',
        query: 'c38 ordinary searchable sentinel',
      }),
    ).toEqual({
      matches: [
        { messageId: 'c38-searchable', turnId: 'c38-searchable', count: 1 },
      ],
      totalCount: 1,
    });
  } finally {
    overlay.mockRestore();
  }
  await assertRaw();
  surfaces.set('raw rows/references', true);
  expect(await f.repository.getRevision(f.scope)).toBe(scopeRevision);
  await writeFile(
    join(evidenceDirectory, `c38-readers-${size}-${state}.json`),
    JSON.stringify(
      {
        size,
        state,
        pages,
        cards: f.cards.length,
        surfaces: Object.fromEntries(surfaces),
        failures,
      },
      null,
      2,
    ),
  );
  if (throwOnFailure && failures.length) throw new Error(failures.join('\n'));
  return failures;
}

beforeAll(async () => {
  mockRoot = await mkdtemp(join(tmpdir(), 'c38-readers-'));
  previousDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(mockRoot, 'data');
  (
    await import('@canopy/desktop-shared/canopy-paths')
  ).resetResolvedCanopyDataDirForTests();
  backing = await c38Backing(mockRoot, { size });
  const f = backing;
  await f.createCards();
  creationRows = await Promise.all(f.cards.map((card) => f.rawCard(card)));
  referenceRow = await f.service.readStoredParentMessage(
    f.scope,
    f.chatId,
    'seed-reference',
  );
  let window = 'idle';
  for (const operation of C38_MANIFEST.operations) {
    if (operation.window !== window) {
      if (operation.window === 'active') await f.beginParentTurn();
      else await f.endParentTurn();
      window = operation.window;
    }
    await f.runOperation(operation);
  }
  continuation = await f.followUp(probe(6));
  creationRows = [...creationRows, await f.rawCard(continuation)];
  await f.progress(continuation);
  await f.repository.transact(
    f.scope,
    [
      {
        type: 'message.upserted',
        chatId: f.chatId,
        message: {
          id: 'c38-searchable',
          role: 'user',
          timestamp: 2_000_000,
          blocks: [{ type: 'text', text: 'c38 ordinary searchable sentinel' }],
        },
      },
    ],
    { source: 'provider', mutationId: 'c38-searchable' },
  );
  await f.drain();
  await assertRaw();
  for (let index = 0; index < creationRows.length; index++) {
    const row = creationRows[index];
    expect(cardBlocks(row ? [row] : [])).toMatchObject([
      { status: 'pending', transcriptStore: 'chat-stream-v2' },
    ]);
    expect(cardBlocks(row ? [row] : [])[0]?.finalText).toBeUndefined();
    expect(row?.id).toBe(f.cards[index]?.messageId);
  }
  (
    await import('../services/chat-state-service')
  ).resetChatStateServiceForTests(f.service);
});

afterAll(async () => {
  try {
    await (
      await import('../agents/delegation/service')
    ).shutdownManagedDelegations();
    await backing?.dispose();
    const singleton = await import('../services/chat-state-service');
    await singleton.getChatStateService().drain();
    singleton.resetChatStateServiceForTests();
    const { getAppAdvisorWatcherService } =
      await import('../app-advisor/watchers');
    getAppAdvisorWatcherService().shutdown();
    await getAppAdvisorWatcherService().drain();
  } finally {
    jest.restoreAllMocks();
    if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = previousDataDir;
    (
      await import('@canopy/desktop-shared/canopy-paths')
    ).resetResolvedCanopyDataDirForTests();
    await rm(mockRoot, { recursive: true, force: true });
  }
});

it('idle readers enumerate the same broker-produced lifecycle generations', async () => {
  const fault =
    process.env.CANOPY_C38_READER_FAULT === 'overlay'
      ? jest
          .spyOn(overlayModule, 'overlayStreamBackedDelegationCard')
          .mockImplementation((card) => card)
      : undefined;
  try {
    await readerMatrix();
  } finally {
    fault?.mockRestore();
  }
});
it('the same reader matrix remains current while another parent turn is active', async () => {
  await current().beginParentTurn();
  try {
    await readerMatrix('active');
  } finally {
    await current().endParentTurn();
  }
});

function isChanged(value: unknown): value is ChatStateChangedEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    value.schemaVersion === 1 &&
    'changes' in value &&
    Array.isArray(value.changes)
  );
}
function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
function projectionFor(snapshot: ChatStateSnapshot): CanonicalScopeProjection {
  return {
    chatState: {
      tabs: snapshot.tabsFile.tabs.map((tab) => fromPersistedTab(tab)),
      activeTabId: current().chatId,
    },
    archives: [],
    runtimeByChatId: {},
    pendingQuestions: {},
  };
}
async function fullSnapshot(): Promise<ChatStateSnapshot> {
  const f = current();
  const base = await f.service.getState(f.scope);
  const full = await f.repository.getState(f.scope, {
    chatIds: [f.chatId],
    fullTranscript: true,
  });
  return {
    ...base,
    revision: full.tabsFile.revision ?? 0,
    tabsFile: full.tabsFile,
  };
}
it('actual durable IPC events merge loaded cards and a dropped revision reloads a fresh snapshot', async () => {
  const f = current();
  const card = probe(0);
  let projection = projectionFor(await fullSnapshot());
  const delivered: ChatStateChangedEvent[] = [];
  const applied: number[] = [];
  const reloadRevisions: number[] = [];
  let dropNext = false;
  let dropped: ChatStateChangedEvent | undefined;
  let resolveReload: () => void = (): void => undefined;
  const reloaded = new Promise<void>((resolve) => {
    resolveReload = resolve;
  });
  const sync = new RevisionedChatSync(
    {
      getState: async (): Promise<ChatStateSnapshot> => {
        const fresh = await fullSnapshot();
        reloadRevisions.push(fresh.revision);
        return fresh;
      },
    },
    {
      installSnapshot: (snapshot): void => {
        projection = projectionFor(snapshot);
        if (reloadRevisions.length > 1) resolveReload();
      },
      applyCommittedEvent: (event): void => {
        applied.push(event.revision);
        projection = applyCanonicalChanges(projection, event.changes, f.scope);
      },
      onStatusChanged: (): void => undefined,
    },
  );
  await sync.hydrate(f.scope.projectId, f.scope.worktreeId);
  const window = new BrowserWindow();
  const send = jest
    .spyOn(window.webContents, 'send')
    .mockImplementation((channel: string, ...args: unknown[]): void => {
      const payload = args[0];
      if (channel !== IPC_CHANNELS.chatStateChanged || !isChanged(payload))
        return;
      delivered.push(payload);
      if (
        dropNext &&
        payload.changes.some(
          (change) => change.type === 'delegation.card_state_updated',
        )
      ) {
        dropNext = false;
        dropped = payload;
      } else sync.handleEvent(payload);
    });
  const dispatcher = createDesktopRuntime({
    getChatStatePort: () => f.service,
  });
  const subscribe = jest.spyOn(f.service, 'subscribe');
  const dispose = registerChatStateHandlers(f.service, () => [window], {
    dispatcher,
    resolveCaller: () => ({
      principalId: 'test-user',
      clientInstanceId: 'test-client',
      authorityId: 'local-desktop',
      interfaceKind: 'test',
      grants: ['core.chat.read'],
    }),
  });
  const { materializeCardDraft } =
    await import('@canopy/desktop-shared/node/delegation/card-publication');
  const record = await f.record(card);
  const publication = record.cardPublication;
  const draft = materializeCardDraft(record);
  if (!publication || !draft)
    throw new Error('Missing broker-produced publication');
  // Like C12, publish durable descriptor changes through the real repository
  // port. Progress previews themselves are live-only (phase 15), not a durable
  // card-state event oracle. Do not fabricate a broker progress event here.
  const publish = async (step: number, discarded: boolean): Promise<void> => {
    value(
      await f.port.updateCardState({
        target: c38Target(card),
        cardRevision: publication.cardRevision + step,
        cardDraft: { ...draft, workspaceDiscarded: discarded },
      }),
    );
    await f.drain();
  };
  try {
    for (
      let attempt = 0;
      attempt < 32 && subscribe.mock.calls.length === 0;
      attempt++
    )
      await immediate();
    expect(subscribe).toHaveBeenCalled();
    const start = await f.repository.getRevision(f.scope);
    await publish(1, true);
    for (let attempt = 0; attempt < 64 && applied.length === 0; attempt++)
      await immediate();
    expect(applied.length).toBeGreaterThan(0);
    expect(applied[0]).toBeGreaterThan(start);
    const rendererCard = (): unknown =>
      cardBlocks(projection.chatState.tabs.flatMap((tab) => tab.messages)).find(
        (candidate) => candidate.agentBlockId === card.messageId,
      );
    expect(rendererCard()).toMatchObject({
      status: 'completed',
      workspaceDiscarded: true,
      control: { operation: 'apply', status: 'completed' },
    });
    const count = applied.length;
    const last = delivered[delivered.length - 1];
    if (!last) throw new Error('Missing durable IPC event');
    sync.handleEvent(last);
    expect(applied).toHaveLength(count);
    dropNext = true;
    await publish(2, false);
    for (let attempt = 0; attempt < 64 && !dropped; attempt++)
      await immediate();
    expect(dropped).toBeDefined();
    expect(applied).toHaveLength(count);
    await publish(3, true);
    await reloaded;
    expect(reloadRevisions).toHaveLength(2);
    expect(reloadRevisions[1]).toBe(await f.repository.getRevision(f.scope));
    expect(reloadRevisions[1]).toBeGreaterThan(reloadRevisions[0] ?? -1);
    expect(rendererCard()).toMatchObject({
      status: 'completed',
      workspaceDiscarded: true,
    });
    expect(applied).toEqual([...new Set(applied)].sort((a, b) => a - b));
    const revision = await f.repository.getRevision(f.scope);
    const countBeforeReplay = delivered.length;
    await publish(3, true);
    await immediate();
    expect(await f.repository.getRevision(f.scope)).toBe(revision);
    expect(delivered).toHaveLength(countBeforeReplay);
    await writeFile(
      join(evidenceDirectory, `c38-readers-${size}-event.json`),
      JSON.stringify(
        {
          size,
          loadedCards: cardBlocks(
            projection.chatState.tabs.flatMap((tab) => tab.messages),
          ).length,
          initialRevision: start,
          deliveredRevisions: delivered.map((event) => event.revision),
          appliedRevisions: applied,
          snapshotRevisions: reloadRevisions,
          droppedRevision: dropped?.revision,
          equalPublicationRevision: revision,
        },
        null,
        2,
      ),
    );
  } finally {
    // Restore descriptor fields, never its monotone revision. This settled
    // broker record has no further runner writes.
    try {
      await publish(4, draft.workspaceDiscarded ?? false);
    } finally {
      dispose();
      await dispatcher.shutdown();
      subscribe.mockRestore();
      send.mockRestore();
      sync.release(f.scope.projectId, f.scope.worktreeId);
    }
  }
});

it('canonical answer/reference pairs retain Unicode bodies, absence and empty answers independently of raw creation rows', async () => {
  const f = current();
  const indices = c38ProbeIndices(size);
  const large = 'answer 🌲漢字\n'.repeat(12288);
  for (const index of [indices['old-apply'], indices['old-discard']]) {
    const card = probe(index);
    const result = value(
      await f.port.resultByGeneration({
        chatId: f.chatId,
        delegationId: card.delegationId,
        runGeneration: card.runGeneration,
      }),
    );
    expect(result.outcome.status).toBe('completed');
    expect(result.answer).toMatchObject({
      kind: 'body',
      role: 'final',
      encoding: 'utf8',
      byteLength: Buffer.byteLength(large),
      sha256: createHash('sha256').update(large).digest('hex'),
    });
    if (result.answer.kind !== 'body')
      throw new Error('Missing canonical answer reference');
    const descriptor = value(await f.port.open({ target: c38Target(card) }));
    expect(descriptor.cardState).toMatchObject({
      canonical: { finalTextRef: result.answer.ref },
    });
    const pieces: string[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const range: DelegationTranscriptContentRange = value(
        await f.port.resultAnswerRange({
          chatId: f.chatId,
          delegationId: card.delegationId,
          resultIndex: result.resultIndex,
          offset,
          limit: 65536,
        }),
      );
      pieces.push(range.text);
      expect(range.byteLength).toBe(Buffer.byteLength(large));
      if (range.nextOffset !== undefined)
        expect(range.nextOffset).toBeGreaterThan(offset);
      offset = range.nextOffset;
    }
    expect(pieces.join('')).toBe(large);
    const raw = cardBlocks(
      [creationRows[f.cards.indexOf(card)]].flatMap((row) =>
        row ? [row] : [],
      ),
    )[0];
    expect(raw?.finalTextRef).toBeUndefined();
  }
  for (const [index, kind] of [
    [indices['middle-apply'], 'none'],
    [indices['middle-discard'], 'empty'],
  ] as const) {
    const card = probe(index);
    const result = value(
      await f.port.resultByGeneration({
        chatId: f.chatId,
        delegationId: card.delegationId,
        runGeneration: card.runGeneration,
      }),
    );
    expect(result.answer).toEqual(
      kind === 'none' ? { kind: 'none' } : { kind: 'empty', role: 'final' },
    );
  }
  await assertRaw();
});

it('cold reopened readers preserve bytes and running state without an actor or broker initialization', async () => {
  const f = current();
  await f.drain();
  // Same test-only process-image technique as C12: preserve real pre-shutdown
  // bytes, gracefully release handles, restore the image; no fabricated record.
  const image = join(mockRoot, 'process-image');
  await cp(f.directory, image, { recursive: true });
  await f.broker.close();
  // A closed queue has no pending publication. The frozen helper's drain
  // also flushes its broker, so suppress ONLY that already-closed actor's
  // impossible flush while retaining real ingress/repository drain barriers.
  jest.spyOn(f.broker, 'flushCardPublication').mockResolvedValue(undefined);
  await f.drain();
  await f.service.drain();
  await rm(f.directory, { recursive: true, force: true });
  await cp(image, f.directory, { recursive: true });
  await rm(image, { recursive: true, force: true });
  await f.reopenRepository();
  await f.drain();
  (
    await import('../services/chat-state-service')
  ).resetChatStateServiceForTests(f.service);
  const { AgentDelegationBroker } =
    await import('@canopy/desktop-shared/node/delegation/broker');
  const initialize = jest.spyOn(AgentDelegationBroker.prototype, 'initialize');
  const sessions = await import('../agents/session-manager');
  const actor = jest
    .spyOn(sessions, 'getOrCreateSession')
    .mockImplementation(() => {
      throw new Error('Cold reader created session');
    });
  initialize.mockImplementation(() => {
    throw new Error('Cold reader initialized broker');
  });
  try {
    const before = await storedImage(f.directory);
    const descriptor = value(
      await f.port.open({ target: c38Target(liveCard()) }),
    );
    expect(descriptor.cardState).toMatchObject({
      status: 'running',
    });
    if (process.env.CANOPY_C38_READER_FAULT === 'actor') {
      // Let the injected eager initialization return so the SAME not-called
      // assertion below, rather than a thrown stub, supplies the causal red.
      initialize.mockResolvedValue(undefined);
      await f.broker.initialize();
    }
    const failures = await readerMatrix('actorless', false);
    expect(initialize).not.toHaveBeenCalled();
    expect(actor).not.toHaveBeenCalled();
    expect(value(await f.port.open({ target: c38Target(liveCard()) }))).toEqual(
      descriptor,
    );
    const after = await storedImage(f.directory);
    // Finding: the first cold read derives the registry index on disk. It is
    // excluded by exact name; every canonical byte must stay unchanged.
    const derivedIndex = (entry: string): boolean =>
      entry.split(':')[0].endsWith('/v2/registry.index.json');
    expect(before.filter(derivedIndex)).toEqual([]);
    expect(after.filter(derivedIndex)).toHaveLength(1);
    expect(after.filter((entry) => !derivedIndex(entry))).toEqual(before);
    await writeFile(
      join(evidenceDirectory, `c38-readers-${size}-cold-bytes.json`),
      JSON.stringify(
        {
          before,
          after,
          added: after.filter((entry) => !before.includes(entry)),
          removed: before.filter((entry) => !after.includes(entry)),
          canonicalUnchanged: true,
          brokerInitializations: initialize.mock.calls.length,
          sessionCreations: actor.mock.calls.length,
        },
        null,
        2,
      ),
    );
    if (failures.length) throw new Error(failures.join('\n'));
  } finally {
    initialize.mockRestore();
    actor.mockRestore();
  }
});

it('only explicit host actor start repairs the retained running continuation', async () => {
  const f = current();
  const brokerModule =
    await import('@canopy/desktop-shared/node/delegation/broker');
  const { AgentDelegationBroker } = brokerModule;
  const initialize = jest.spyOn(AgentDelegationBroker.prototype, 'initialize');
  const { AgentRunnerRegistry } =
    await import('@canopy/desktop-shared/node/delegation/runner-registry');
  const { FakeRunner } =
    await import('@canopy/desktop-shared/node/delegation/__tests__/fixtures');
  const registry = new AgentRunnerRegistry();
  const runner = new FakeRunner('local-sdk');
  registry.register({
    apiVersion: 1,
    registrationId: 'third-local',
    adapter: runner,
  });
  const constructed: InstanceType<typeof AgentDelegationBroker>[] = [];
  const construction = jest
    .spyOn(brokerModule, 'AgentDelegationBroker')
    .mockImplementation((options) => {
      const broker = new AgentDelegationBroker({
        ...options,
        registry,
        testOnlyStreamGeneration: true,
        reconcileNative: (): Promise<{ status: 'unknown' }> =>
          Promise.resolve({ status: 'unknown' }),
      });
      constructed.push(broker);
      return broker;
    });
  try {
    const managed = await import('../agents/delegation/service');
    await managed.createManagedDelegationSession({
      harness: 'claude',
      sessionKey: `${f.scope.projectId}/${f.scope.worktreeId}/${f.chatId}`,
      currentOptions: () => ({ ...f.scope, chatId: f.chatId, cwd: mockRoot }),
      currentTurn: () => 'explicit-repair-turn',
      getWindow: () => null,
    });
    expect(initialize).toHaveBeenCalledTimes(1);
    const broker = constructed[0];
    if (!broker) throw new Error('Explicit actor did not construct broker');
    await broker.flushCardPublication(c38Target(liveCard()));
    await f.drain();
    repaired = true;
    expect((await f.record(liveCard())).latestResult).toMatchObject({
      runGeneration: 2,
      status: 'interrupted',
    });
    expect(runner.starts).toHaveLength(0);
    await readerMatrix('repaired');
    expect(initialize).toHaveBeenCalledTimes(1);
  } finally {
    construction.mockRestore();
    initialize.mockRestore();
  }
});
