import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreDeferredToolReloads } from '@canopy/core-runtime/node/agent/deferred-tools';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import {
  DEFERRED_TOOLS_ENABLE_FAILURE_MESSAGE,
  DEFERRED_TOOLS_RELOAD_CONTINUATION_TEMPLATE,
  type AgentProviderType,
  type ChatTabPluginSelections,
  type ChatUpdatePluginsRequest,
  type ChatUpdatePluginsResponse,
  type DeferredToolsReloadEvent,
  type DeferredToolsReloadScopeKey,
  type PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { executeLoadDeferredTools } from '../executor';
import {
  deferredToolsReloadCoordinator,
  setDeferredToolReloads,
  type DeferredToolsResumeRequest,
} from '../reload-coordinator';
import {
  createDesktopDeferredToolReloadHost,
  type DesktopDeferredToolReloadPayload,
} from '../reload-host';

const addedPlugin = { marketplaceId: 'market', pluginName: 'added' };
const keptSkill = { sourceId: 'local', skillName: 'kept' };

jest.mock('../catalog', () => ({
  buildDeferredToolsCatalog: jest.fn(() => Promise.resolve({})),
  classifyLoadItems: jest.fn(() => ({
    willEnable: [{ ref: 'ref-added', kind: 'plugin', name: 'added' }],
    rejected: [],
    additions: {
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'added' }],
      mcpServerRefs: [],
    },
  })),
  searchDeferredCatalogResult: jest.fn(),
}));

jest.mock('../../services/chat-turn-ownership', () => ({
  getChatTurnOwnership: (): unknown => ({
    isBound: (): boolean => true,
    getSnapshot: (): unknown => ({
      committed: { state: { lastEnded: { userMessageId: 'msg-ended' } } },
    }),
  }),
}));

const mockTerminalTurn: { userMessageId: string | undefined } = {
  userMessageId: undefined,
};
jest.mock('../../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: (): unknown => ({
    runningTurnUserMessageId: (): string | undefined =>
      mockTerminalTurn.userMessageId,
  }),
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise(setImmediate);
}

const scope: DeferredToolsReloadScopeKey = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};

describe('deferred-tool reloads driven by the desktop core (CAN-4127)', () => {
  let dir: string;
  let operations: OperationService;
  let reloads: CoreDeferredToolReloads<DesktopDeferredToolReloadPayload>;
  let updateRequests: ChatUpdatePluginsRequest[];
  let update: Deferred<ChatUpdatePluginsResponse> | null;
  let updateSessionId: string | undefined;
  let ingested: Array<{ data: Record<string, unknown>; mutationId: string }>;
  let cancelledTurns: string[];
  let revalidation: string | null;
  let revalidationGate: Deferred<string | null> | null;
  let liveTurn: string;
  let notices: Array<{ message: PersistedChatMessage; mutationId: string }>;
  let resumes: DeferredToolsResumeRequest[];
  let events: DeferredToolsReloadEvent[];
  let unregister: () => void;
  let unsubscribe: () => void;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reload-core-'));
    const path = join(dir, 'ledger.db');
    operations = new OperationService({
      openLedger: (): OperationLedger => OperationLedger.open(path),
    });
    updateRequests = [];
    update = null;
    updateSessionId = undefined;
    ingested = [];
    notices = [];
    revalidation = null;
    revalidationGate = null;
    liveTurn = 'msg-1';
    mockTerminalTurn.userMessageId = undefined;
    cancelledTurns = [];
    resumes = [];
    events = [];
    reloads = new CoreDeferredToolReloads<DesktopDeferredToolReloadPayload>({
      operations,
      host: createDesktopDeferredToolReloadHost({
        revalidateCatalog: (): Promise<string | null> =>
          revalidationGate
            ? revalidationGate.promise
            : Promise.resolve(revalidation),
        readCanonicalTab: (): Promise<{
          pluginSelections: ChatTabPluginSelections;
          sdkSessionId: string;
        }> =>
          Promise.resolve({
            pluginSelections: {
              collectionIds: [],
              skillRefs: [keptSkill],
              pluginRefs: [],
            },
            sdkSessionId: 'sess-1',
          }),
        readLiveTurnUserMessageId: (): Promise<string> =>
          Promise.resolve(liveTurn),
        applyChatPluginSelectionsUpdate: (
          req,
        ): Promise<ChatUpdatePluginsResponse> => {
          updateRequests.push(req);
          if (update) return update.promise;
          return Promise.resolve({
            pluginSelections: req.pluginSelections,
            ...(updateSessionId ? { sdkSessionId: updateSessionId } : {}),
          });
        },
        armContinuation: (): void => undefined,
        ingestChatEvent: (input): Promise<void> => {
          ingested.push({ data: input.data, mutationId: input.mutationId });
          return Promise.resolve();
        },
        appendSystemNotice: (_scope, message, mutationId): Promise<void> => {
          notices.push({ message, mutationId });
          return Promise.resolve();
        },
        onTurnCancelled: (_scope, userMessageId): void => {
          cancelledTurns.push(userMessageId);
        },
      }),
    });
    setDeferredToolReloads(reloads);
    unregister = deferredToolsReloadCoordinator.registerResumeHandler(
      scope,
      (request): Promise<void> => {
        resumes.push(request);
        return Promise.resolve();
      },
    );
    unsubscribe = (): void => undefined;
  });

  afterEach(() => {
    unsubscribe();
    unregister();
    setDeferredToolReloads(null);
    reloads.close();
    operations.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function subscribe(): void {
    unsubscribe = deferredToolsReloadCoordinator.subscribe((event) =>
      events.push(event),
    );
  }

  async function load(
    toolUseId: string,
    providerType: AgentProviderType = 'claude',
  ): Promise<{ text: string; isError?: boolean }> {
    return executeLoadDeferredTools(
      { items: [{ ref: 'ref-added' }] },
      { scope, providerType },
      { toolUseId },
    );
  }

  it('a load is admitted by the core under one request id', async () => {
    const first = await load('tool-1');
    expect(first.isError).toBeUndefined();
    expect(JSON.parse(first.text)).toMatchObject({ status: 'success' });
    expect(deferredToolsReloadCoordinator.hasActiveReload(scope)).toBe(true);
    const second = await load('tool-2');
    expect(second.isError).toBe(true);
    expect(JSON.parse(second.text)).toMatchObject({
      status: 'error',
      rejected: [{ code: 'reload_in_progress' }],
    });
  });

  it('a delivered load result reloads and resumes with no window', async () => {
    await load('tool-1');
    expect(
      deferredToolsReloadCoordinator.markToolResultDelivered(scope, 'tool-1'),
    ).toBe(true);
    await flush();
    expect(updateRequests).toHaveLength(1);
    expect(updateRequests[0]).toMatchObject({
      ...scope,
      materializeCodexThread: false,
      pluginSelections: {
        skillRefs: [keptSkill],
        pluginRefs: [addedPlugin],
      },
    });
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toMatchObject({
      userMessageId: 'msg-1',
      continuationText: DEFERRED_TOOLS_RELOAD_CONTINUATION_TEMPLATE,
      sdkSessionId: 'sess-1',
      pluginSelections: updateRequests[0]?.pluginSelections,
    });
    expect(deferredToolsReloadCoordinator.hasActiveReload(scope)).toBe(false);
    expect(ingested).toEqual([]);
  });

  it('begin and finish calls from a renderer change nothing', async () => {
    update = deferred<ChatUpdatePluginsResponse>();
    subscribe();
    await load('tool-1');
    deferredToolsReloadCoordinator.markToolResultDelivered(scope, 'tool-1');
    await flush();
    const requestId = events[0]?.requestId ?? '';
    const begin = await deferredToolsReloadCoordinator.begin({
      scope,
      requestId,
      toolCallId: 'tool-1',
      additions: {
        skillRefs: [],
        pluginRefs: [addedPlugin],
        mcpServerRefs: [],
      },
      enabledResources: [],
    });
    const finish = await deferredToolsReloadCoordinator.finish({
      scope,
      requestId,
      toolCallId: 'tool-1',
      userMessageId: 'msg-1',
      resume: {},
      continuationText: DEFERRED_TOOLS_RELOAD_CONTINUATION_TEMPLATE,
    });
    expect(begin).toEqual({
      requestId,
      accepted: true,
      lifecycle: { kind: 'state', state: 'enabling' },
    });
    expect(finish).toEqual(begin);
    update.resolve({
      pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    });
    await flush();
    expect(updateRequests).toHaveLength(1);
    expect(resumes).toHaveLength(1);
  });

  it('a headless reload settles its failure in chat state', async () => {
    update = deferred<ChatUpdatePluginsResponse>();
    subscribe();
    await load('tool-1');
    deferredToolsReloadCoordinator.markToolResultDelivered(scope, 'tool-1');
    await flush();
    const requestId = events[0]?.requestId ?? '';
    update.reject(
      new Error(
        'Wait for queued Codex messages to finish before updating tools',
      ),
    );
    await flush();
    const anyTimestamp: unknown = expect.any(Number);
    expect(notices).toEqual([
      {
        message: {
          id: `deferred-tools-reload:${requestId}:failure`,
          role: 'system',
          timestamp: anyTimestamp,
          blocks: [
            { type: 'text', text: DEFERRED_TOOLS_ENABLE_FAILURE_MESSAGE },
          ],
        },
        mutationId: `deferred-tools-reload:${requestId}:notice`,
      },
    ]);
    expect(ingested).toEqual([
      {
        data: {
          type: 'result',
          is_error: false,
          result: 'Cancelled',
          canopy_turn_user_message_id: 'msg-1',
        },
        mutationId: `deferred-tools-reload:${requestId}:terminal`,
      },
    ]);
    expect(cancelledTurns).toEqual(['msg-1']);
    expect(resumes).toEqual([]);
  });

  it('an HTTP write without a native receipt starts no reload', async () => {
    await load('tool-1', 'copilot');
    expect(
      deferredToolsReloadCoordinator.cancelPendingToolResult(
        scope,
        'tool-1',
        'The native result could not be verified.',
      ),
    ).toBe(true);
    await flush();
    expect(updateRequests).toEqual([]);
    expect(ingested).toEqual([]);
    expect(
      deferredToolsReloadCoordinator.markToolResultDelivered(scope, 'tool-1'),
    ).toBe(false);
  });

  it('Stop during enable cancels once and settles the turn once', async () => {
    update = deferred<ChatUpdatePluginsResponse>();
    subscribe();
    await load('tool-1');
    deferredToolsReloadCoordinator.markToolResultDelivered(scope, 'tool-1');
    await flush();
    expect(deferredToolsReloadCoordinator.cancelActiveReload(scope)).toBe(true);
    update.resolve({
      pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    });
    await flush();
    expect(
      events.filter(
        (event) =>
          event.lifecycle.kind === 'outcome' &&
          event.lifecycle.outcome === 'cancelled',
      ),
    ).toHaveLength(1);
    expect(ingested.map((entry) => entry.data.type)).toEqual(['result']);
    expect(resumes).toEqual([]);
  });

  it('a Codex reload passes the captured thread and resumes the committed one', async () => {
    updateSessionId = 'thread-2';
    subscribe();
    await load('tool-1', 'codex');
    deferredToolsReloadCoordinator.markToolResultDelivered(scope, 'tool-1');
    await flush();
    expect(updateRequests[0]).toMatchObject({
      materializeCodexThread: true,
      expectedCurrentThreadId: 'sess-1',
    });
    const resuming = events.find(
      (event) =>
        event.lifecycle.kind === 'state' &&
        event.lifecycle.state === 'resuming',
    );
    expect(resuming?.sdkSessionId).toBe('thread-2');
    expect(resumes[0]?.sdkSessionId).toBe('thread-2');
  });

  it('a turn the provider already ended still resumes once', async () => {
    setDeferredToolReloads(null);
    reloads.close();
    operations.close();
    const path = join(dir, 'ended.db');
    operations = new OperationService({
      openLedger: (): OperationLedger => OperationLedger.open(path),
    });
    reloads = new CoreDeferredToolReloads<DesktopDeferredToolReloadPayload>({
      operations,
      host: createDesktopDeferredToolReloadHost({
        revalidateCatalog: (): Promise<string | null> => Promise.resolve(null),
        readCanonicalTab: (): Promise<{ sdkSessionId: string }> =>
          Promise.resolve({ sdkSessionId: 'sess-1' }),
        applyChatPluginSelectionsUpdate: (
          req,
        ): Promise<ChatUpdatePluginsResponse> =>
          Promise.resolve({ pluginSelections: req.pluginSelections }),
        armContinuation: (): void => undefined,
        ingestChatEvent: (): Promise<void> => Promise.resolve(),
        onTurnCancelled: (): void => undefined,
      }),
    });
    setDeferredToolReloads(reloads);
    await load('tool-1', 'copilot');
    deferredToolsReloadCoordinator.markToolResultDelivered(scope, 'tool-1');
    await flush();
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.userMessageId).toBe('msg-ended');
  });

  it('a Copilot reload that fails before interruption settles its ended turn', async () => {
    revalidation = 'plugin added: removed';
    await load('tool-1', 'copilot');
    deferredToolsReloadCoordinator.markToolResultDelivered(scope, 'tool-1');
    await flush();
    expect(notices.map((entry) => entry.message.blocks)).toEqual([
      [{ type: 'text', text: DEFERRED_TOOLS_ENABLE_FAILURE_MESSAGE }],
    ]);
    expect(ingested.map((entry) => entry.data)).toEqual([
      {
        type: 'result',
        is_error: false,
        result: 'Cancelled',
        canopy_turn_user_message_id: 'msg-1',
      },
    ]);
    expect(cancelledTurns).toEqual(['msg-1']);
    expect(updateRequests).toEqual([]);
  });

  it('a Claude reload that fails before interruption leaves its live turn running', async () => {
    revalidation = 'plugin added: removed';
    await load('tool-1', 'claude');
    deferredToolsReloadCoordinator.markToolResultDelivered(scope, 'tool-1');
    await flush();
    expect(deferredToolsReloadCoordinator.hasActiveReload(scope)).toBe(false);
    expect(notices).toEqual([]);
    expect(ingested).toEqual([]);
    expect(cancelledTurns).toEqual([]);
  });

  it('an OpenCode reload that fails before interruption leaves its live turn running', async () => {
    revalidation = 'plugin added: removed';
    const result = await load('tool-1', 'opencode');
    const parsed: unknown = JSON.parse(result.text);
    const requestId =
      typeof parsed === 'object' &&
      parsed !== null &&
      'requestId' in parsed &&
      typeof parsed.requestId === 'string'
        ? parsed.requestId
        : '';
    expect(
      deferredToolsReloadCoordinator.markOpenCodeResultDelivered(
        scope,
        requestId,
      ),
    ).toBe(true);
    await flush();
    expect(deferredToolsReloadCoordinator.hasActiveReload(scope)).toBe(false);
    expect(notices).toEqual([]);
    expect(ingested).toEqual([]);
    expect(cancelledTurns).toEqual([]);
  });

  it('a Claude terminal chat resumes once with its running turn', async () => {
    mockTerminalTurn.userMessageId = 'msg-terminal';
    setDeferredToolReloads(null);
    reloads.close();
    operations.close();
    const path = join(dir, 'terminal.db');
    operations = new OperationService({
      openLedger: (): OperationLedger => OperationLedger.open(path),
    });
    reloads = new CoreDeferredToolReloads<DesktopDeferredToolReloadPayload>({
      operations,
      host: createDesktopDeferredToolReloadHost({
        revalidateCatalog: (): Promise<string | null> => Promise.resolve(null),
        readCanonicalTab: (): Promise<{ sdkSessionId: string }> =>
          Promise.resolve({ sdkSessionId: 'sess-1' }),
        applyChatPluginSelectionsUpdate: (
          req,
        ): Promise<ChatUpdatePluginsResponse> =>
          Promise.resolve({ pluginSelections: req.pluginSelections }),
        armContinuation: (): void => undefined,
        ingestChatEvent: (): Promise<void> => Promise.resolve(),
        onTurnCancelled: (): void => undefined,
      }),
    });
    setDeferredToolReloads(reloads);
    await load('tool-1', 'claude');
    deferredToolsReloadCoordinator.markToolResultDelivered(scope, 'tool-1');
    await flush();
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.userMessageId).toBe('msg-terminal');
  });

  it('a reload keeps the turn that made the load while the catalog is checked', async () => {
    revalidationGate = deferred<string | null>();
    await load('tool-1', 'copilot');
    deferredToolsReloadCoordinator.markToolResultDelivered(scope, 'tool-1');
    await flush();
    liveTurn = 'msg-later';
    revalidationGate.resolve(null);
    await flush();
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.userMessageId).toBe('msg-1');
  });
});
