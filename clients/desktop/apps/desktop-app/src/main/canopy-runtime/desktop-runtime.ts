import { AsyncLocalStorage } from 'node:async_hooks';
import {
  CANOPY_QUERY_DEFINITIONS,
  CANOPY_INSTRUCTION_DEFINITIONS,
  CANOPY_STREAM_DEFINITIONS,
  type CanopyStreamCursor,
  type CanopyInstructionHandlerMap,
  type CanopyQueryHandlerMap,
  type CanopyQueryParams,
  type CanopyQueryResult,
  type CanopyStreamHandlerMap,
  type CanopyStreamItem,
  type CanopyStreamParams,
  type CanopyStreamEnd,
  type WorkerFilesystemDirectoryListParams,
  type WorkerFilesystemDirectoryListResult,
  type WorkerFilesystemRootsListParams,
  type WorkerFilesystemRootsListResult,
  type CoreChatTranscriptPageParams,
  type CoreChatTranscriptPageResult,
  type CoreChatTranscriptSearchParams,
  type CoreChatTranscriptSearchResult,
  type CoreChatToolOutputReadParams,
  type CoreChatToolOutputReadResult,
} from '@canopy/protocol/canopy-core';
import {
  CANOPY_DEFAULT_SHUTDOWN_TIMEOUT_MS,
  CanopyOperationError,
  canopyUnavailableError,
  createCanopyDispatcher,
  createCanopyRuntime,
  type CanopyDispatcher,
  type CanopyRuntimeQueries,
  type CanopyRuntimeStreams,
  type RuntimeService,
  type CanopyHandlerContext,
  type CanopyQueryOptions,
  type CanopyStreamFrame,
  type CanopyStreamHandle,
  type CanopyStreamOptions,
} from '@canopy/core-runtime';
import type {
  ChatStateCommandPort,
  ChatStateSnapshot,
  ChatStateChangedEvent,
  FileTreeDirectoryResponse,
  FileTreeRootsResponse,
  SidebarItemsFile,
  WorktreeData,
  WorkspaceConfigFile,
  ChatTranscriptSearchResult,
  ChatToolOutputResponse,
} from '@canopy/desktop-shared/types';
import { createCoreChatStateAdapter } from './core-chat-state-adapter';
import type { TranscriptPage } from '@canopy/agent-transcript/transcript-storage';
import { createCoreChatEventsAdapter } from './core-chat-events-adapter';
import {
  listFileTreeDirectory,
  listFileTreeRoots,
} from '../services/files-service';
import { getChatStateCommandPort } from '../ipc/chat-state';
import { createCoreChatCommandAdapter } from './core-chat-command-adapter';
import { getChatStateService } from '../services/chat-state-service';
import { createCoreChatMessageAdapter } from './core-chat-message-command-adapter';
import {
  createCoreWorkspaceAdapter,
  type CoreWorkspaceReadDetail,
  type CoreWorkspaceReadServices,
} from './core-workspace-adapter';
import {
  createCoreLedgerInstructionHandlers,
  createCoreLedgerQueryHandlers,
  getDesktopLedgerService,
} from '../ledger/core-ledger-adapter';
import type { LedgerService } from '../ledger/service';
import { createCoreCostAdapter } from './core-cost-adapter';
import type { CostService } from '../cost-index/service';
import {
  createWorkerFilesystemAdapter,
  WorkerFilesystemAdapterError,
  type WorkerFilesystemServices,
} from './worker-filesystem-adapter';
import {
  createCoreChatReadAdapter,
  type CoreChatReadServices,
} from './core-chat-read-adapter';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';
import type {
  DaemonFilesRoute,
  DaemonFilesRouteRequest,
} from './daemon-files-route';

export interface CreateDesktopRuntimeOptions {
  services?: WorkerFilesystemServices;
  runtimeServices?: readonly RuntimeService[];
  getChatStatePort?: () => ChatStateCommandPort | null;
  workspaceServices?: CoreWorkspaceReadServices;
  chatServices?: CoreChatReadServices;
  chatCommandPort?: ChatStateCommandPort;
  adapters?: DesktopDomainAdapter[];
  /**
   * Handler logic for `core.ledger.*`. Defaults to the app's Ledger service,
   * which touches storage only on the first Ledger operation.
   */
  ledgerService?: LedgerService;
  /** Handler logic for `core.cost.*`; tests may inject an isolated service. */
  costService?: CostService;
  shutdownTimeoutMs?: number;
  /**
   * The opt-in daemon route for file-tree IPC reads. Resolved per routable
   * request; absent keeps every read on the direct reader.
   */
  daemonFilesRoute?: () => DaemonFilesRoute;
}

export interface DesktopDomainAdapter {
  queries?: Partial<CanopyQueryHandlerMap<CanopyHandlerContext>>;
  instructions?: Partial<CanopyInstructionHandlerMap<CanopyHandlerContext>>;
  streams?: Partial<CanopyStreamHandlerMap<CanopyHandlerContext>>;
}

interface RootsProjectionContext {
  kind: 'roots';
  /** Set only by the file-tree IPC handlers; other callers stay direct. */
  route?: DaemonFilesRouteRequest;
  legacyResult?: FileTreeRootsResponse;
}

interface DirectoryProjectionContext {
  kind: 'directory';
  route?: DaemonFilesRouteRequest;
  legacyResult?: FileTreeDirectoryResponse;
}

type FileTreeProjectionContext =
  | RootsProjectionContext
  | DirectoryProjectionContext;

interface WorkspaceProjectionContext {
  sidebar?: SidebarItemsFile;
  sidebarDetail?: CoreWorkspaceReadDetail;
  config?: WorkspaceConfigFile;
  configDetail?: CoreWorkspaceReadDetail;
  worktrees?: WorktreeData[];
  worktreesDetail?: CoreWorkspaceReadDetail;
  worktree?: WorktreeData;
}

interface ChatReadProjectionContext {
  requestId?: string;
  toolOutputRead?: Promise<ChatToolOutputResponse>;
  legacyResult?:
    | TranscriptPage
    | ChatTranscriptSearchResult
    | ChatToolOutputResponse;
}

export interface DesktopCanopyDispatcher extends CanopyDispatcher<
  typeof CANOPY_QUERY_DEFINITIONS & CanopyRuntimeQueries,
  typeof CANOPY_INSTRUCTION_DEFINITIONS,
  typeof CANOPY_STREAM_DEFINITIONS & CanopyRuntimeStreams
> {
  openChatEventsForLegacyIpc(
    params: CanopyStreamParams<'core.chat.events'>,
    options: CanopyStreamOptions<
      CanopyStreamFrame<
        CanopyStreamItem<'core.chat.events'>,
        CanopyStreamEnd<'core.chat.events'>
      >
    >,
  ): Promise<{
    handle: CanopyStreamHandle<
      CanopyStreamItem<'core.chat.events'>,
      CanopyStreamEnd<'core.chat.events'>
    >;
    takeLegacyEvent: (cursor: CanopyStreamCursor) => ChatStateChangedEvent;
  }>;
  /** Resolves the original event for a legacy-push frame, including from `onFrame`. */
  takeChatEventForLegacyIpc(cursor: CanopyStreamCursor): ChatStateChangedEvent;
  closeChatEventsForLegacyIpc(): void;
  queryChatStateForLegacyIpc(
    params: CanopyQueryParams<'core.chat.snapshot.get'>,
    options: CanopyQueryOptions,
  ): Promise<{
    canonicalResult: CanopyQueryResult<'core.chat.snapshot.get'>;
    legacyResult: ChatStateSnapshot;
  }>;
  isShuttingDown(): boolean;
  queryWorkspaceListForLegacyIpc(
    params: CanopyQueryParams<'core.workspace.list'>,
    options: CanopyQueryOptions,
  ): Promise<{
    canonicalResult: CanopyQueryResult<'core.workspace.list'> | null;
    legacyResult: SidebarItemsFile;
    /** Authority of the read that produced `legacyResult`, when known. */
    legacyAuthority?: CoreWorkspaceReadDetail;
  }>;
  queryWorkspaceGetForLegacyIpc(
    params: CanopyQueryParams<'core.workspace.get'>,
    options: CanopyQueryOptions,
  ): Promise<{
    canonicalResult: CanopyQueryResult<'core.workspace.get'> | null;
    legacyResult: WorkspaceConfigFile;
    /** Authority of the read that produced `legacyResult`, when known. */
    legacyAuthority?: CoreWorkspaceReadDetail;
  }>;
  queryWorktreeListForLegacyIpc(
    params: CanopyQueryParams<'core.worktree.list'>,
    options: CanopyQueryOptions,
  ): Promise<{
    canonicalResult: CanopyQueryResult<'core.worktree.list'> | null;
    legacyResult: SidebarItemsFile | WorktreeData[];
    /** Authority of the read that produced `legacyResult`, when known. */
    legacyAuthority?: CoreWorkspaceReadDetail;
  }>;
  queryWorktreeGetForLegacyIpc(
    params: CanopyQueryParams<'core.worktree.get'>,
    options: CanopyQueryOptions,
  ): Promise<{
    canonicalResult: CanopyQueryResult<'core.worktree.get'> | null;
    legacyResult: WorktreeData;
  }>;
  queryFileTreeRootsForLegacyIpc(
    params: WorkerFilesystemRootsListParams,
    options: CanopyQueryOptions,
    route?: DaemonFilesRouteRequest,
  ): Promise<{
    canonicalResult: WorkerFilesystemRootsListResult;
    legacyResult: FileTreeRootsResponse;
  }>;
  queryFileTreeDirectoryForLegacyIpc(
    params: WorkerFilesystemDirectoryListParams,
    options: CanopyQueryOptions,
    route?: DaemonFilesRouteRequest,
  ): Promise<{
    canonicalResult: WorkerFilesystemDirectoryListResult;
    legacyResult: FileTreeDirectoryResponse;
  }>;
  queryChatTranscriptPageForLegacyIpc(
    params: CoreChatTranscriptPageParams,
    options: CanopyQueryOptions,
  ): Promise<{
    canonicalResult: CoreChatTranscriptPageResult;
    legacyResult: TranscriptPage;
  }>;
  queryChatTranscriptSearchForLegacyIpc(
    params: CoreChatTranscriptSearchParams,
    options: CanopyQueryOptions,
    requestId?: string,
  ): Promise<{
    canonicalResult: CoreChatTranscriptSearchResult;
    legacyResult: ChatTranscriptSearchResult;
  }>;
  queryChatToolOutputForLegacyIpc(
    params: CoreChatToolOutputReadParams,
    options: CanopyQueryOptions,
    requestId?: string,
  ): Promise<{
    canonicalResult: CoreChatToolOutputReadResult;
    legacyResult: ChatToolOutputResponse;
  }>;
}

let activeDesktopRuntime: DesktopCanopyDispatcher | null = null;

export function getActiveDesktopRuntime(): DesktopCanopyDispatcher {
  if (activeDesktopRuntime?.state !== 'accepting')
    throw new Error('Desktop Canopy runtime is unavailable.');
  return activeDesktopRuntime;
}

export function getActiveDesktopRuntimeIfAccepting(): DesktopCanopyDispatcher | null {
  return activeDesktopRuntime?.state === 'accepting'
    ? activeDesktopRuntime
    : null;
}

/**
 * Once the legacy read was captured, a canonical projection or validation
 * failure must not replace it: legacy callers get `canonicalResult: null`.
 */
function recoverLegacyWorkspaceRead(error: unknown, captured: unknown): null {
  if (
    captured !== undefined &&
    error instanceof CanopyOperationError &&
    (error.payload.kind === 'invalid_argument' ||
      error.payload.kind === 'internal')
  ) {
    return null;
  }
  throw error;
}

export function createDesktopRuntime(
  options: CreateDesktopRuntimeOptions = {},
): DesktopCanopyDispatcher {
  const projectionContext = new AsyncLocalStorage<FileTreeProjectionContext>();
  const chatProjectionContext = new AsyncLocalStorage<{
    legacyResult?: ChatStateSnapshot;
  }>();
  const chatStateAdapter = createCoreChatStateAdapter(
    options.getChatStatePort ?? ((): ChatStateCommandPort | null => null),
    {
      captureState: (result): void => {
        const context = chatProjectionContext.getStore();
        if (context) context.legacyResult = result;
      },
    },
  );
  const workspaceProjectionContext =
    new AsyncLocalStorage<WorkspaceProjectionContext>();
  const workspaceAdapter = createCoreWorkspaceAdapter(
    options.workspaceServices,
    {
      captureSidebar: (result, detail): void => {
        const context = workspaceProjectionContext.getStore();
        if (!context) return;
        context.sidebar = result;
        context.sidebarDetail = detail;
      },
      captureConfig: (result, detail): void => {
        const context = workspaceProjectionContext.getStore();
        if (!context) return;
        context.config = result;
        context.configDetail = detail;
      },
      captureWorktrees: (result, detail): void => {
        const context = workspaceProjectionContext.getStore();
        if (!context) return;
        context.worktrees = result;
        context.worktreesDetail = detail;
      },
      captureWorktree: (result): void => {
        const context = workspaceProjectionContext.getStore();
        if (context) context.worktree = result;
      },
    },
  );
  const chatReadProjectionContext =
    new AsyncLocalStorage<ChatReadProjectionContext>();
  const chatAdapter = createCoreChatReadAdapter(options.chatServices, {
    requestId: (): string | undefined =>
      chatReadProjectionContext.getStore()?.requestId,
    page: (result): void => {
      const context = chatReadProjectionContext.getStore();
      if (context) context.legacyResult = result;
    },
    search: (result): void => {
      const context = chatReadProjectionContext.getStore();
      if (context) context.legacyResult = result;
    },
    toolOutput: (result): void => {
      const context = chatReadProjectionContext.getStore();
      if (context) context.legacyResult = result;
    },
    toolOutputPending: (read): void => {
      const context = chatReadProjectionContext.getStore();
      if (context) context.toolOutputRead = read;
    },
  });
  // Frames reach the legacy consumer in emit order, so captures form a FIFO.
  const legacyEvents: Array<{
    event: ChatStateChangedEvent;
    cursor?: CanopyStreamCursor;
  }> = [];
  const chatEventsAdapter = createCoreChatEventsAdapter(
    options.getChatStatePort ?? ((): ChatStateCommandPort | null => null),
    (event, context) => {
      if (context.caller.clientInstanceId !== 'electron-main-chat-push') return;
      const entry: (typeof legacyEvents)[number] = { event };
      legacyEvents.push(entry);
      return (cursor): void => {
        if (cursor) entry.cursor = cursor;
        else {
          const index = legacyEvents.indexOf(entry);
          if (index >= 0) legacyEvents.splice(index, 1);
        }
      };
    },
  );
  const adapter = createWorkerFilesystemAdapter(
    options.services ?? { listFileTreeRoots, listFileTreeDirectory },
    {
      captureRoots: (result): void => {
        const context = projectionContext.getStore();
        if (context?.kind === 'roots') context.legacyResult = result;
      },
      captureDirectory: (result): void => {
        const context = projectionContext.getStore();
        if (context?.kind === 'directory') context.legacyResult = result;
      },
    },
  );
  const translateAdapterCall = async <Result>(
    call: () => Result | Promise<Result>,
  ): Promise<Result> => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof WorkerFilesystemAdapterError) {
        throw new CanopyOperationError(error.payload, error.runtimeCause);
      }
      throw error;
    }
  };
  const builtInHandlers: Partial<CanopyQueryHandlerMap<CanopyHandlerContext>> =
    {
      ...chatStateAdapter,
      'core.chat.send.receipt': chatAdapter['core.chat.send.receipt'],
      'core.chat.transcript.page': chatAdapter['core.chat.transcript.page'],
      'core.chat.transcript.search': chatAdapter['core.chat.transcript.search'],
      'core.chat.toolOutput.read': chatAdapter['core.chat.toolOutput.read'],
      'core.chat.visual.read': chatAdapter['core.chat.visual.read'],
      'worker.filesystem.roots.list': (params, context) => {
        const direct = (): Promise<WorkerFilesystemRootsListResult> =>
          translateAdapterCall(() =>
            adapter['worker.filesystem.roots.list'](params, context),
          );
        const store = projectionContext.getStore();
        if (
          store?.kind !== 'roots' ||
          !store.route ||
          !options.daemonFilesRoute
        )
          return direct();
        return options.daemonFilesRoute().roots(params, context, store.route, {
          direct,
          capture: (legacy): void => {
            store.legacyResult = legacy;
          },
        });
      },
      'worker.filesystem.directory.list': (params, context) => {
        const direct = (): Promise<WorkerFilesystemDirectoryListResult> =>
          translateAdapterCall(() =>
            adapter['worker.filesystem.directory.list'](params, context),
          );
        const store = projectionContext.getStore();
        if (
          store?.kind !== 'directory' ||
          !store.route ||
          !options.daemonFilesRoute
        )
          return direct();
        return options
          .daemonFilesRoute()
          .directory(params, context, store.route, {
            direct,
            capture: (legacy): void => {
              store.legacyResult = legacy;
            },
          });
      },
    };

  const ledgerService = options.ledgerService ?? getDesktopLedgerService();
  const commandAdapter = createCoreChatCommandAdapter(getChatStateCommandPort);
  const messageAdapter = createCoreChatMessageAdapter(
    () => options.chatCommandPort ?? getChatStateService(),
  );
  const ledgerAdapter: DesktopDomainAdapter = {
    queries: createCoreLedgerQueryHandlers(ledgerService),
    instructions: createCoreLedgerInstructionHandlers(ledgerService),
  };
  const costAdapter = createCoreCostAdapter(
    options.costService ??
      (async (): Promise<CostService> => {
        const serviceModule = await import('../cost-index/service');
        return serviceModule.getDesktopCostService();
      }),
  );
  const adapters: DesktopDomainAdapter[] = [
    commandAdapter,
    messageAdapter,
    ledgerAdapter,
    costAdapter,
    ...(options.adapters ?? []),
  ];
  const queries: Partial<CanopyQueryHandlerMap<CanopyHandlerContext>> = {
    ...builtInHandlers,
    ...workspaceAdapter,
  };
  const instructions: Partial<
    CanopyInstructionHandlerMap<CanopyHandlerContext>
  > = {};
  const streams: Partial<CanopyStreamHandlerMap<CanopyHandlerContext>> = {
    ...chatEventsAdapter.handlers,
  };
  for (const entry of adapters) {
    for (const name of Object.keys(entry.queries ?? {}))
      if (Object.prototype.hasOwnProperty.call(queries, name))
        throw new Error(`Duplicate Canopy query handler: ${name}`);
    for (const name of Object.keys(entry.instructions ?? {}))
      if (Object.prototype.hasOwnProperty.call(instructions, name))
        throw new Error(`Duplicate Canopy instruction handler: ${name}`);
    for (const name of Object.keys(entry.streams ?? {}))
      if (Object.prototype.hasOwnProperty.call(streams, name))
        throw new Error(`Duplicate Canopy stream handler: ${name}`);
    Object.assign(queries, entry.queries);
    Object.assign(instructions, entry.instructions);
    Object.assign(streams, entry.streams);
  }

  const owned = (
    name: string,
    ...maps: Array<object | undefined>
  ): { name: string; operations: string[] } => ({
    name,
    operations: maps.flatMap((map) => Object.keys(map ?? {})),
  });
  const ownedAdapter = (
    name: string,
    entry: DesktopDomainAdapter,
  ): { name: string; operations: string[] } =>
    owned(name, entry.queries, entry.instructions, entry.streams);
  const shutdownTimeoutMs =
    options.shutdownTimeoutMs ?? CANOPY_DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const runtime = createCanopyRuntime({
    profile: 'core+worker',
    // Trusted-host placeholders until the daemon descriptor lands (C5).
    identity: {
      runtimeId: LOCAL_DESKTOP_AUTHORITY_ID,
      hostId: LOCAL_DESKTOP_AUTHORITY_ID,
      authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    },
    definitions: {
      queries: CANOPY_QUERY_DEFINITIONS,
      instructions: CANOPY_INSTRUCTION_DEFINITIONS,
      streams: CANOPY_STREAM_DEFINITIONS,
    },
    owners: [
      owned('core.chat.state', chatStateAdapter),
      {
        name: 'core.chat.read',
        operations: [
          'core.chat.send.receipt',
          'core.chat.transcript.page',
          'core.chat.transcript.search',
          'core.chat.toolOutput.read',
          'core.chat.visual.read',
        ],
      },
      owned('worker.filesystem', adapter),
      owned('core.workspace', workspaceAdapter),
      owned('core.chat.events', chatEventsAdapter.handlers),
      ownedAdapter('core.chat.commands', commandAdapter),
      ownedAdapter('core.chat.messages', messageAdapter),
      ownedAdapter('core.ledger', ledgerAdapter),
      ownedAdapter('core.cost', costAdapter),
      ...(options.adapters ?? []).map((entry, index) =>
        ownedAdapter(`desktop.adapter.${index}`, entry),
      ),
    ],
    // Writer ownership stays with the existing desktop services for now.
    services: options.runtimeServices ?? [],
    // Phase 3 outlasts the dispatcher's own drain-then-abort window.
    phaseDeadlineMs: shutdownTimeoutMs + 250,
    createDispatcher: (input) =>
      createCanopyDispatcher({
        profile: input.profile,
        definitions: input.definitions,
        handlers: {
          queries: { ...queries, ...input.runtimeHandlers.queries },
          instructions,
          streams: { ...streams, ...input.runtimeHandlers.streams },
        },
        shutdownTimeoutMs,
      }),
  });
  // Startup failure is reported through runtime health.
  void runtime.start().catch(() => undefined);
  const dispatcher = runtime.dispatcher;
  const takeChatEventForLegacyIpc = (
    cursor: CanopyStreamCursor,
  ): ChatStateChangedEvent => {
    const entry = legacyEvents[0];
    // An entry without a cursor is the emit in progress (synchronous delivery).
    if (
      !entry ||
      (entry.cursor &&
        (entry.cursor.daemonEpoch !== cursor.daemonEpoch ||
          entry.cursor.sequence !== cursor.sequence))
    )
      throw new Error('Chat event projection was not captured.');
    legacyEvents.shift();
    return entry.event;
  };
  const openChatEventsForLegacyIpc: DesktopCanopyDispatcher['openChatEventsForLegacyIpc'] =
    async (params, streamOptions) => ({
      handle: await dispatcher.openStream(
        'core.chat.events',
        params,
        streamOptions,
      ),
      takeLegacyEvent: takeChatEventForLegacyIpc,
    });
  const queryChatStateForLegacyIpc = async (
    params: CanopyQueryParams<'core.chat.snapshot.get'>,
    queryOptions: CanopyQueryOptions,
  ): Promise<{
    canonicalResult: CanopyQueryResult<'core.chat.snapshot.get'>;
    legacyResult: ChatStateSnapshot;
  }> => {
    const context: { legacyResult?: ChatStateSnapshot } = {};
    const canonicalResult = await chatProjectionContext.run(context, () =>
      dispatcher.query('core.chat.snapshot.get', params, queryOptions),
    );
    if (!context.legacyResult)
      throw new Error('Chat state projection was not captured.');
    return { canonicalResult, legacyResult: context.legacyResult };
  };
  const queryFileTreeRootsForLegacyIpc = async (
    params: WorkerFilesystemRootsListParams,
    queryOptions: CanopyQueryOptions,
    route?: DaemonFilesRouteRequest,
  ): Promise<{
    canonicalResult: WorkerFilesystemRootsListResult;
    legacyResult: FileTreeRootsResponse;
  }> => {
    const context: RootsProjectionContext = {
      kind: 'roots',
      ...(route && { route }),
    };
    const canonicalResult = await projectionContext.run(context, () =>
      dispatcher.query('worker.filesystem.roots.list', params, queryOptions),
    );
    if (context.legacyResult === undefined) {
      throw new Error('Filesystem roots projection was not captured.');
    }
    return { canonicalResult, legacyResult: context.legacyResult };
  };
  const queryFileTreeDirectoryForLegacyIpc = async (
    params: WorkerFilesystemDirectoryListParams,
    queryOptions: CanopyQueryOptions,
    route?: DaemonFilesRouteRequest,
  ): Promise<{
    canonicalResult: WorkerFilesystemDirectoryListResult;
    legacyResult: FileTreeDirectoryResponse;
  }> => {
    const context: DirectoryProjectionContext = {
      kind: 'directory',
      ...(route && { route }),
    };
    const canonicalResult = await projectionContext.run(context, () =>
      dispatcher.query(
        'worker.filesystem.directory.list',
        params,
        queryOptions,
      ),
    );
    if (context.legacyResult === undefined) {
      throw new Error('Filesystem directory projection was not captured.');
    }
    return { canonicalResult, legacyResult: context.legacyResult };
  };
  const queryWorkspaceListForLegacyIpc = async (
    params: CanopyQueryParams<'core.workspace.list'>,
    queryOptions: CanopyQueryOptions,
  ): Promise<{
    canonicalResult: CanopyQueryResult<'core.workspace.list'> | null;
    legacyResult: SidebarItemsFile;
    legacyAuthority?: CoreWorkspaceReadDetail;
  }> => {
    const context: WorkspaceProjectionContext = {};
    const canonicalResult = await workspaceProjectionContext
      .run(context, () =>
        dispatcher.query('core.workspace.list', params, queryOptions),
      )
      .catch((error: unknown) =>
        recoverLegacyWorkspaceRead(error, context.sidebar),
      );
    if (!context.sidebar)
      throw new Error('Workspace list projection was not captured.');
    return {
      canonicalResult,
      legacyResult: context.sidebar,
      ...(context.sidebarDetail
        ? { legacyAuthority: context.sidebarDetail }
        : {}),
    };
  };
  const queryWorkspaceGetForLegacyIpc = async (
    params: CanopyQueryParams<'core.workspace.get'>,
    queryOptions: CanopyQueryOptions,
  ): Promise<{
    canonicalResult: CanopyQueryResult<'core.workspace.get'> | null;
    legacyResult: WorkspaceConfigFile;
    legacyAuthority?: CoreWorkspaceReadDetail;
  }> => {
    const context: WorkspaceProjectionContext = {};
    const canonicalResult = await workspaceProjectionContext
      .run(context, () =>
        dispatcher.query('core.workspace.get', params, queryOptions),
      )
      .catch((error: unknown) =>
        recoverLegacyWorkspaceRead(error, context.config),
      );
    if (!context.config)
      throw new Error('Workspace projection was not captured.');
    return {
      canonicalResult,
      legacyResult: context.config,
      ...(context.configDetail
        ? { legacyAuthority: context.configDetail }
        : {}),
    };
  };
  const queryWorktreeListForLegacyIpc = async (
    params: CanopyQueryParams<'core.worktree.list'>,
    queryOptions: CanopyQueryOptions,
  ): Promise<{
    canonicalResult: CanopyQueryResult<'core.worktree.list'> | null;
    legacyResult: SidebarItemsFile | WorktreeData[];
    legacyAuthority?: CoreWorkspaceReadDetail;
  }> => {
    const context: WorkspaceProjectionContext = {};
    const canonicalResult = await workspaceProjectionContext
      .run(context, () =>
        dispatcher.query('core.worktree.list', params, queryOptions),
      )
      .catch((error: unknown) =>
        recoverLegacyWorkspaceRead(error, context.worktrees ?? context.sidebar),
      );
    const legacyResult = context.worktrees ?? context.sidebar;
    if (!legacyResult)
      throw new Error('Worktree list projection was not captured.');
    const legacyAuthority = context.worktrees
      ? context.worktreesDetail
      : context.sidebarDetail;
    return {
      canonicalResult,
      legacyResult,
      ...(legacyAuthority ? { legacyAuthority } : {}),
    };
  };
  const queryWorktreeGetForLegacyIpc = async (
    params: CanopyQueryParams<'core.worktree.get'>,
    queryOptions: CanopyQueryOptions,
  ): Promise<{
    canonicalResult: CanopyQueryResult<'core.worktree.get'> | null;
    legacyResult: WorktreeData;
  }> => {
    const context: WorkspaceProjectionContext = {};
    const canonicalResult = await workspaceProjectionContext
      .run(context, () =>
        dispatcher.query('core.worktree.get', params, queryOptions),
      )
      .catch((error: unknown) =>
        recoverLegacyWorkspaceRead(error, context.worktree),
      );
    if (!context.worktree)
      throw new Error('Worktree projection was not captured.');
    return { canonicalResult, legacyResult: context.worktree };
  };
  let shuttingDown = false;
  // The kernel admits queries until its final phase; legacy IPC stops at shutdown.
  const refuseOnceShuttingDown =
    <Args extends unknown[], Result>(
      read: (...args: Args) => Promise<Result>,
    ): ((...args: Args) => Promise<Result>) =>
    (...args) =>
      shuttingDown ? Promise.reject(canopyUnavailableError()) : read(...args);
  const desktopDispatcher: DesktopCanopyDispatcher = Object.assign(dispatcher, {
    isShuttingDown: (): boolean => shuttingDown,
    queryWorkspaceListForLegacyIpc: refuseOnceShuttingDown(
      queryWorkspaceListForLegacyIpc,
    ),
    queryWorkspaceGetForLegacyIpc: refuseOnceShuttingDown(
      queryWorkspaceGetForLegacyIpc,
    ),
    shutdown: async (): Promise<void> => {
      shuttingDown = true;
      if (activeDesktopRuntime === desktopDispatcher)
        activeDesktopRuntime = null;
      chatEventsAdapter.closeLegacy();
      legacyEvents.length = 0;
      await runtime.shutdown('desktop');
    },
    queryChatStateForLegacyIpc: refuseOnceShuttingDown(
      queryChatStateForLegacyIpc,
    ),
    queryWorktreeListForLegacyIpc: refuseOnceShuttingDown(
      queryWorktreeListForLegacyIpc,
    ),
    queryWorktreeGetForLegacyIpc: refuseOnceShuttingDown(
      queryWorktreeGetForLegacyIpc,
    ),
    openChatEventsForLegacyIpc: refuseOnceShuttingDown(
      openChatEventsForLegacyIpc,
    ),
    takeChatEventForLegacyIpc,
    closeChatEventsForLegacyIpc: (): void => {
      chatEventsAdapter.closeLegacy();
      legacyEvents.length = 0;
    },
    queryFileTreeRootsForLegacyIpc: refuseOnceShuttingDown(
      queryFileTreeRootsForLegacyIpc,
    ),
    queryFileTreeDirectoryForLegacyIpc: refuseOnceShuttingDown(
      queryFileTreeDirectoryForLegacyIpc,
    ),
    queryChatTranscriptPageForLegacyIpc: refuseOnceShuttingDown(
      async (
        params: CoreChatTranscriptPageParams,
        queryOptions: CanopyQueryOptions,
      ): Promise<{
        canonicalResult: CoreChatTranscriptPageResult;
        legacyResult: TranscriptPage;
      }> => {
        const context: ChatReadProjectionContext = {};
        const canonicalResult = await chatReadProjectionContext.run(
          context,
          () =>
            dispatcher.query('core.chat.transcript.page', params, queryOptions),
        );
        const legacyResult = context.legacyResult;
        if (!legacyResult || !('messages' in legacyResult))
          throw new Error('Chat transcript page projection was not captured.');
        return { canonicalResult, legacyResult };
      },
    ),
    queryChatTranscriptSearchForLegacyIpc: refuseOnceShuttingDown(
      async (
        params: CoreChatTranscriptSearchParams,
        queryOptions: CanopyQueryOptions,
        requestId?: string,
      ): Promise<{
        canonicalResult: CoreChatTranscriptSearchResult;
        legacyResult: ChatTranscriptSearchResult;
      }> => {
        const context: ChatReadProjectionContext = { requestId };
        const canonicalResult = await chatReadProjectionContext.run(
          context,
          () =>
            dispatcher.query(
              'core.chat.transcript.search',
              params,
              queryOptions,
            ),
        );
        const legacyResult = context.legacyResult;
        if (!legacyResult || !('matches' in legacyResult))
          throw new Error(
            'Chat transcript search projection was not captured.',
          );
        return { canonicalResult, legacyResult };
      },
    ),
    queryChatToolOutputForLegacyIpc: refuseOnceShuttingDown(
      async (
        params: CoreChatToolOutputReadParams,
        queryOptions: CanopyQueryOptions,
        requestId?: string,
      ): Promise<{
        canonicalResult: CoreChatToolOutputReadResult;
        legacyResult: ChatToolOutputResponse;
      }> => {
        const context: ChatReadProjectionContext = { requestId };
        let canonicalResult: CoreChatToolOutputReadResult;
        try {
          canonicalResult = await chatReadProjectionContext.run(context, () =>
            dispatcher.query('core.chat.toolOutput.read', params, queryOptions),
          );
        } catch (error) {
          if (context.toolOutputRead) {
            const legacyResult = await context.toolOutputRead;
            return { canonicalResult: legacyResult, legacyResult };
          }
          throw error;
        }
        const legacyResult = context.legacyResult;
        if (!legacyResult || !('text' in legacyResult))
          throw new Error('Chat tool output projection was not captured.');
        return { canonicalResult, legacyResult };
      },
    ),
  });
  activeDesktopRuntime = desktopDispatcher;
  return desktopDispatcher;
}
