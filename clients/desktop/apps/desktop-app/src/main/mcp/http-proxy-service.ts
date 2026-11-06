import { isWatchDelegatesCompatibilityName } from '@canopy/desktop-shared/node/delegation/watch-delegates-tombstone';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { BRAND } from '@canopy/brand/current';
import type { BrowserWindow } from 'electron';
import {
  buildCanopyHooksClaudeTerminalRoute,
  buildCanopyMcpProxyRoute,
  buildCanopyMcpWorktreeSessionRoute,
  CANOPY_HOOKS_CLAUDE_TERMINAL_WORKTREE_SESSION_PATH,
  CANOPY_MCP_PROXY_PATH,
  CANOPY_MCP_WORKTREE_SESSION_PATH,
  DESKTOP_INTEGRATION_SERVER_HOST,
  extractDesktopIntegrationToken,
  isClaudeTerminalHookCallbackBody,
  LEGACY_MCP_PROXY_PATH,
  type ClaudeTerminalHookCallbackBody,
} from '@canopy/desktop-shared/lib/desktop-integration-transport';
import {
  ASK_USER_TIMEOUT_MS,
  CANOPY_INJECTED_TOOL_REGISTRY,
  CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS,
  isCodeGraphInjectedToolKey,
  isLedgerInjectedToolKey,
  type CanopyInjectedToolKey,
  type CanopyInjectedToolSurface,
} from '@canopy/desktop-shared/lib/canopy-injected-tools';
import {
  APP_ADVISOR_TOOL_REGISTRY,
  isAppAdvisorLedgerToolKey,
  type AppAdvisorToolKey,
} from '@canopy/desktop-shared/lib/app-advisor-tools';
import type { PipelineEditorToolKey } from '@canopy/desktop-shared/lib/pipeline-editor-tools';
import type { JsonValue } from '@canopy/desktop-shared/node/codex-runtime/generated/serde_json/JsonValue';
import type {
  McpProxyState,
  McpProxyStatus,
} from '@canopy/desktop-shared/types/mcp-servers';
import {
  DEFAULT_MCP_PROXY_PORT,
  IPC_CHANNELS,
  type ChatModel,
  type ChatTabPluginSelections,
  type AgentProviderType,
  type McpQuestionAnswer,
} from '@canopy/desktop-shared/types';
import {
  isClaudeWorkerToolExposed,
  type ClaudeWorkerMemoryToolExposure,
} from '../integration/claude-worker-tool-exposure';
import {
  AgentMcpConnections,
  type McpProxiedToolCallGate,
  type McpProxyRouteRegistration,
} from './agent-mcp-connections';
import {
  getHeaderValue,
  getJsonRpcId,
  isRecord,
  jsonRpcError,
  jsonRpcInternalError,
  readRequestBody,
  RequestBodyTooLargeError,
  writeJson,
  writePayloadTooLargeJsonRpc,
} from './integration-http';
import { handleMcpOAuthCallback } from './oauth-client';
import { writeMcpOAuthCallbackPage } from './oauth-callback-page';
import {
  executeCanopyInjectedTool,
  type CanopyInjectedToolContext,
  type CanopyInjectedToolRuntime,
  type CanopyInjectedToolTextResult,
} from '../canopy-tools/core';
import {
  mainWindowOnlyToolSurfaces,
  requestShowFiles,
} from '../canopy-tools/show-files-runtime';
import { CODE_GRAPH_UNAVAILABLE_MESSAGE } from '../lib/code-graph-availability';
import {
  getReviewCommentsSchema,
  respondToCommentSchema,
} from '../canopy-tools/definitions';
import { chatVisualsEligible } from '../lib/chat-visuals-feature-flag';
import { VISUAL_PREVIEW_BUDGETS } from '../browser/visual-preview-types';
import { createShowVisualHost } from '../canopy-tools/show-visual-host';
import {
  ledgerUnavailableResult,
  type LedgerToolsRuntime,
} from '../canopy-tools/ledger-tools-runtime';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import {
  loadWorktreePipelineYaml,
  loadWorktreeScriptOutput,
  loadGitPreferences,
  saveLocalMemory,
  searchLocalMemory,
  readLocalMemory,
  getFileCommentsInSession,
  requestAnswersFromRenderer,
  respondToFileCommentInSession,
} from '../canopy-tools/session-runtime';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { sendToWindow } from '../lib/window-send';
import type { AppAdvisorToolRuntime } from '../app-advisor/runtime';
import {
  executeAppAdvisorTool,
  type AppAdvisorToolContext,
} from '../app-advisor/tool-executor';
import type { PipelineEditorToolRuntime } from '../pipeline-editor/runtime';
import { executePipelineEditorTool } from '../pipeline-editor/tool-executor';
import { rejectRequest } from './pending-requests';
import {
  getCanopyRouteTools,
  getClaudeCanopyToolKey,
  getClaudeCanopyToolSurface,
  getClaudeTerminalAppAdvisorToolKey,
  getClaudeTerminalPipelineEditorToolKey,
  getClaudeToolUseId,
  GET_REVIEW_COMMENTS_TOOL_NAME,
  listCanopyRouteTools,
  REPORT_STRUCTURED_RESULT_TOOL_NAME,
  RESPOND_TO_COMMENT_TOOL_NAME,
  toMcpToolResult,
} from './canopy-route-tools';

/**
 * The desktop integration server (CAN-4125): loopback transport and lifecycle.
 * Upstream agent connections live in agent-mcp-connections.ts; the Canopy tool
 * router and the interface port follow in CAN-4125 PR2 and PR3.
 */

export const MCP_PROXY_HEALTH_SERVICE = 'desktop-integration-server';
const MCP_PROXY_HEALTH_VERSION = 1;

export interface McpProxyBroadcastHandlers {
  status: (state: McpProxyState) => void;
}

type WindowAccessor = () => BrowserWindow | null;

interface CanopyMcpRequestContext {
  onAskUserRequestCreated?: (requestId: string) => void;
  signal?: AbortSignal;
}

export type {
  McpProxyRoute,
  McpProxyRouteRegistration,
  McpProxiedToolCallGate,
} from './agent-mcp-connections';

export type ClaudeTerminalHookHandler = (
  body: ClaudeTerminalHookCallbackBody,
) => unknown;

export interface CanopyWorktreeSessionRoute {
  /** Owning native turn lifetime. Host-only and never restored from disk. */
  turnSignal?: AbortSignal;
  sessionKey: string;
  projectId: string;
  worktreeId: string;
  chatId: string;
  assistantMode?: 'default' | 'app-advisor' | 'pipeline-editor';
  toolSurface?: CanopyInjectedToolSurface;
  cwd?: string;
  repoId?: string;
  sdkSessionId: string;
  authToken: string;
  createdAt: number;
  hookHandler: ClaudeTerminalHookHandler;
  /** Immutable Code Graph advertisement decision captured at route creation. */
  codeGraphToolsAdvertised?: boolean;
  /**
   * Host-only Ledger tool runtime, present only when the session passed the
   * Ledger exposure gate when it started. Without it the route neither
   * advertises nor runs AddLedgerEntry, SearchLedgerEntries or
   * UpdateLedgerEntry. Never restored from a persisted route.
   */
  ledgerTools?: LedgerToolsRuntime;
  appAdvisorRuntime?: AppAdvisorToolRuntime;
  pipelineEditorRuntime?: PipelineEditorToolRuntime;
  model?: ChatModel;
  providerType?: AgentProviderType;
  pluginSelections?: ChatTabPluginSelections;
  deferredToolsAllowed?: boolean;
  onAwaitingUser?: () => void;
  /** Host-only receipt preparation before writing a native provider's tool result.
   * The host must acknowledge the coordinator from its native completion event. */
  nativeToolResultDelivery?: (receipt: {
    requestId: string;
    toolUseId: string;
    result: unknown;
  }) => void;
  /** Host-only native call binding. Never restored from a persisted MCP route. */
  managedDelegation?: {
    /** Child routes expose only these host-owned tools. */
    exclusive?: boolean;
    tools: readonly {
      name: string;
      description: string;
      inputSchema: JsonValue;
    }[];
    invoke: (
      name: string,
      input: unknown,
      context?: { requestId?: string },
    ) => Promise<CanopyInjectedToolTextResult>;
  };
  onSetAutoArchive?: (enabled: boolean) => Promise<void> | void;
  /**
   * Execution-time policy gate consulted before any injected tool on this
   * route runs. Claude and managed-terminal calls are gated before they reach
   * this seam; a Cursor route supplies its own gate because the ACP permission
   * request is advisory and a CLI may skip it. Returning `false` answers the
   * call with a denial error and runs nothing.
   */
  authorizeToolCall?: (
    key: CanopyInjectedToolKey | AppAdvisorToolKey | PipelineEditorToolKey,
    args: Record<string, unknown>,
    context?: { requestId?: string },
  ) => Promise<boolean>;
  /** Advertise the bespoke code-review tools only in code-review sessions. */
  isCodeReview?: boolean;
  respondToReviewComment?: CanopyInjectedToolRuntime['respondToReviewComment'];
  getReviewCommentThread?: CanopyInjectedToolRuntime['getReviewCommentThread'];
  reportStructuredResultSchema?: Record<string, unknown>;
  onReportStructuredResult?: (payload: unknown) => {
    ok: boolean;
    error?: string;
  };
  /**
   * Memory-tool exposure for `claude-worker` routes, derived from the worker's
   * launch permission via `resolveClaudeWorkerMemoryToolExposure` and captured
   * immutably at route creation. Fail-closed: when absent, a `claude-worker`
   * route advertises and dispatches no memory tools.
   */
  workerMemoryToolExposure?: ClaudeWorkerMemoryToolExposure;
}

/**
 * Interval between heartbeats while a long-running `/ui` tool call
 * (AskUserQuestion) awaits the user. Claude Code's MCP idle watchdog is 5
 * minutes by default, so emit progress comfortably before that boundary.
 */
const CANOPY_MCP_SSE_KEEPALIVE_MS = 240_000;

export { REPORT_STRUCTURED_RESULT_TOOL_NAME } from './canopy-route-tools';

export interface McpProxyHealthCheck {
  ok: true;
  service: typeof MCP_PROXY_HEALTH_SERVICE;
  version: typeof MCP_PROXY_HEALTH_VERSION;
  port: number | null;
  status: McpProxyStatus;
  routeCount: number;
}

function isMcpProxyStatus(value: unknown): value is McpProxyStatus {
  return value === 'stopped' || value === 'running' || value === 'error';
}

function getIntegrationToken(req: IncomingMessage): string | null {
  return extractDesktopIntegrationToken((name) => {
    const value = getHeaderValue(req.headers, name.toLowerCase());
    return value ?? getHeaderValue(req.headers, name);
  });
}

function integrationTokenMatches(
  req: IncomingMessage,
  expected: string,
): boolean {
  const actual = getIntegrationToken(req);
  if (actual === null) {
    return false;
  }
  const actualBuffer = Buffer.from(actual, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isAllowedRequestHost(host: string | undefined, port: number): boolean {
  if (!host) {
    return false;
  }
  return (
    host === `127.0.0.1:${String(port)}` || host === `localhost:${String(port)}`
  );
}

function assertLocalhostHostOrigin(
  req: IncomingMessage,
  res: ServerResponse,
  port: number | null,
): boolean {
  if (port === null) {
    res.writeHead(503);
    res.end();
    return false;
  }
  if (!isAllowedRequestHost(getHeaderValue(req.headers, 'host'), port)) {
    res.writeHead(421);
    res.end();
    return false;
  }
  if (getHeaderValue(req.headers, 'origin')) {
    res.writeHead(403);
    res.end();
    return false;
  }
  return true;
}

function getMcpProgressToken(payload: unknown): string | number | null {
  if (!isRecord(payload) || !isRecord(payload.params)) {
    return null;
  }
  const meta = payload.params._meta;
  if (!isRecord(meta)) {
    return null;
  }
  const token = meta.progressToken;
  return typeof token === 'string' || typeof token === 'number' ? token : null;
}

function mcpProgressNotification(
  progressToken: string | number,
  progress: number,
  message: string,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: {
      progressToken,
      progress,
      message,
    },
  };
}

async function readJsonRpcIdFromRequest(
  req: IncomingMessage,
): Promise<unknown> {
  try {
    const raw = await readRequestBody(req);
    return raw.length > 0 ? getJsonRpcId(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function createClaudeCanopyToolRuntime(
  route: CanopyWorktreeSessionRoute,
  canonicalKey: CanopyInjectedToolKey,
  getWindow: WindowAccessor,
  surface: CanopyInjectedToolSurface,
  requestContext?: CanopyMcpRequestContext,
): CanopyInjectedToolRuntime {
  const askUserAllowed =
    CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS[surface].includes(
      'ask_user_question',
    );
  return {
    ...(route.cwd &&
    chatVisualsEligible({
      providerType: route.providerType,
      surface,
      assistantMode: route.assistantMode,
    })
      ? {
          showVisual: createShowVisualHost({
            projectId: route.projectId,
            worktreeId: route.worktreeId,
            chatId: route.chatId,
            cwd: route.cwd,
          }),
        }
      : {}),
    // Native Claude and managed-terminal calls are already command-gated by
    // approvalCheckForClaudeTool before they reach this MCP execution seam;
    // a route that needs a second gate (Cursor) installs `authorizeToolCall`,
    // which the dispatcher consults before this runtime is used.
    deferredToolsRuntime: {
      scope: {
        projectId: route.projectId,
        worktreeId: route.worktreeId,
        chatId: route.chatId,
      },
      providerType: route.providerType ?? 'claude',
      interfaceMode:
        surface === 'claude-code-terminal' ? 'claude-code' : 'canopy',
      assistantMode: route.assistantMode,
      pluginSelections: route.pluginSelections,
      allowed: route.deferredToolsAllowed !== false,
    },
    requestUserAnswers: (questions, options): Promise<McpQuestionAnswer[]> => {
      if (!askUserAllowed) {
        return Promise.reject(
          new Error(
            'AskUserQuestion is not available in Claude Code terminal mode.',
          ),
        );
      }
      return requestAnswersFromRenderer({
        sessionKey: route.sessionKey,
        projectId: route.projectId,
        worktreeId: route.worktreeId,
        chatId: route.chatId,
        questions,
        getWindow,
        ...(options?.toolUseId ? { toolUseId: options.toolUseId } : {}),
        providerType: 'claude',
        askUserTimeoutMs: ASK_USER_TIMEOUT_MS,
        ...(route.model ? { model: route.model } : {}),
        ...(route.onAwaitingUser
          ? { onAwaitingUser: route.onAwaitingUser }
          : {}),
        ...(requestContext?.onAskUserRequestCreated
          ? { onRequestCreated: requestContext.onAskUserRequestCreated }
          : {}),
      });
    },
    loadScriptOutput: (request) =>
      loadWorktreeScriptOutput({
        projectId: route.projectId,
        worktreeId: route.worktreeId,
        scriptId: request.scriptId,
        repo: request.repo,
        maxLines: request.maxLines,
      }),
    loadGitPreferences,
    saveLocalMemory: (request) =>
      saveLocalMemory({
        projectId: route.projectId,
        worktreeId: route.worktreeId,
        chatId: route.chatId,
        sessionId: route.sdkSessionId,
        provider: route.providerType ?? 'claude',
        ...request,
      }),
    searchLocalMemory: (request) =>
      searchLocalMemory({
        projectId: route.projectId,
        worktreeId: route.worktreeId,
        ...request,
      }),
    readLocalMemory: (request) =>
      readLocalMemory({
        projectId: route.projectId,
        worktreeId: route.worktreeId,
        ...request,
      }),
    loadPipelineYaml: (request) =>
      loadWorktreePipelineYaml({
        projectId: route.projectId,
        worktreeId: route.worktreeId,
        ...request,
      }),
    showFiles: (files) =>
      requestShowFiles(
        {
          files,
          target: {
            projectId: route.projectId,
            worktreeId: route.worktreeId,
          },
          origin: {
            projectId: route.projectId,
            worktreeId: route.worktreeId,
            chatTabId: route.chatId,
          },
          cwd:
            route.cwd ?? resolveWorktreeCwd(route.projectId, route.worktreeId),
        },
        mainWindowOnlyToolSurfaces(getWindow),
      ),
    getFileComments: ({ threadId }) =>
      getFileCommentsInSession({
        projectId: route.projectId,
        worktreeId: route.worktreeId,
        ...(threadId !== undefined ? { threadId } : {}),
      }),
    respondToFileComment: ({ threadId, body, resolve }) =>
      respondToFileCommentInSession({
        projectId: route.projectId,
        worktreeId: route.worktreeId,
        threadId,
        body,
        resolve,
        getWindow,
      }),
    ...(canonicalKey === 'dispatch_action' ||
    canonicalKey === 'search_actions' ||
    canonicalKey === 'watch_github_items' ||
    canonicalKey === 'watch_command' ||
    canonicalKey === 'set_base_branch' ||
    canonicalKey === 'start_forked_agent' ||
    canonicalKey === 'start_branched_agent'
      ? {
          worktreeActionRuntime: {
            ...(route.turnSignal && requestContext?.signal
              ? { signal: requestContext.signal }
              : {}),
            projectId: route.projectId,
            worktreeId: route.worktreeId,
            chatId: route.chatId,
            cwd:
              route.cwd ??
              resolveWorktreeCwd(route.projectId, route.worktreeId),
            ...(route.repoId ? { repoId: route.repoId } : {}),
            // Cowork chats run directory-scoped: pipeline listing/dispatch
            // targets the workspace folder and worktree-only actions
            // (tracked-plan/hook) are filtered/rejected.
            ...(isCoworkWorkspace(route.projectId)
              ? { executionScope: 'directory' as const }
              : {}),
            getWindow,
          },
        }
      : {}),
    ...(canonicalKey === 'search_watchers' ||
    canonicalKey === 'get_script_output' ||
    canonicalKey === 'watch_command' ||
    canonicalKey === 'schedule_wakeup' ||
    canonicalKey === 'setup_watchers' ||
    canonicalKey === 'delete_watchers' ||
    canonicalKey === 'watch_github_items' ||
    // dispatch_action needs the watcher destination too: pipeline.run and
    // automation.create/run_now accept inline `watchers` arrays that arm
    // watchers for the calling chat.
    canonicalKey === 'dispatch_action' ||
    // set_auto_archive reads the chat identity to say when the archive waits
    // for the chat's live delegates.
    canonicalKey === 'set_auto_archive'
      ? {
          worktreeWatcherRuntime: {
            projectId: route.projectId,
            worktreeId: route.worktreeId,
            chatId: route.chatId,
          },
        }
      : {}),
    ...(isCodeGraphInjectedToolKey(canonicalKey)
      ? {
          codeGraphRuntime: {
            projectId: route.projectId,
            worktreeId: route.worktreeId,
          },
        }
      : {}),
    ...(route.ledgerTools && isLedgerInjectedToolKey(canonicalKey)
      ? { ledgerRuntime: route.ledgerTools }
      : {}),
    ...(route.onSetAutoArchive
      ? { setAutoArchiveForCurrentChat: route.onSetAutoArchive }
      : {}),
  };
}

function buildPortInUseMessage(
  port: number,
  health: McpProxyHealthCheck | null,
): string {
  if (health) {
    return `MCP proxy port ${String(port)} is already in use by another ${BRAND.displayName} MCP proxy. Close the other ${BRAND.displayName} instance or choose another port.`;
  }
  return `MCP proxy port ${String(port)} is already in use. Choose another port.`;
}

function isValidPort(port: unknown): port is number {
  return (
    typeof port === 'number' &&
    Number.isFinite(port) &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535
  );
}

export function getDevMcpProxyPortOverride(): number | null {
  if (
    typeof __CANOPY_DEV_MCP_PROXY_PORT__ !== 'undefined' &&
    isValidPort(__CANOPY_DEV_MCP_PROXY_PORT__)
  ) {
    return __CANOPY_DEV_MCP_PROXY_PORT__;
  }

  return null;
}

export class McpHttpProxyService {
  private server: Server | null = null;
  private startPromise: Promise<void> | null = null;
  private currentPort: number | null = null;
  private sockets = new Set<Socket>();
  private readonly connections = new AgentMcpConnections({
    proxyUrl: (routeId): string => this.getProxyUrl(routeId),
    listening: (): boolean => this.currentPort !== null,
  });
  private worktreeSessionRoutes = new Map<string, CanopyWorktreeSessionRoute>();
  private localWatcherRegistrationIds = new WeakMap<
    CanopyWorktreeSessionRoute,
    string
  >();

  private localWatcherToolCallId(
    route: CanopyWorktreeSessionRoute,
    id: string | number,
  ): string {
    let registrationId = this.localWatcherRegistrationIds.get(route);
    if (!registrationId) {
      registrationId = randomUUID();
      this.localWatcherRegistrationIds.set(route, registrationId);
    }
    return `${registrationId}:${String(id)}`;
  }

  /**
   * The provider invocation behind a Ledger tool call. The bundled Claude CLI
   * (native chats and the managed terminal) sends the call's tool_use ID as
   * `_meta["claudecode/toolUseId"]`, and it resends the same ID when it
   * retries the call after MCP session recovery, so a key derived from it
   * dedupes retries. Without it the route falls back to its per-registration
   * nonce plus the JSON-RPC request ID: unique per call on this route, but a
   * transport-level retry gets a new ID and cannot dedupe. The pinned Cursor
   * CLI calls tools with only a name and arguments (its ACP tool call ID never
   * reaches the MCP request), so Cursor routes always take the fallback; each
   * Cursor turn registers a new route, so its IDs never repeat across turns.
   */
  private ledgerInvocationContext(
    route: CanopyWorktreeSessionRoute,
    id: unknown,
    meta: unknown,
  ): Pick<CanopyInjectedToolContext, 'invocationId'> {
    const toolUseId = getClaudeToolUseId(meta);
    if (toolUseId) {
      return { invocationId: `claude:${toolUseId}` };
    }
    return typeof id === 'string' || typeof id === 'number'
      ? { invocationId: `mcp:${this.localWatcherToolCallId(route, id)}` }
      : {};
  }

  /**
   * The tool-use ID an App Advisor or Pipeline Editor call hands its runtime,
   * which becomes the renderer request ID its response is cached under. The
   * Claude CLI's `_meta` tool_use ID keeps a retry after MCP session recovery
   * on the same cached response. Never the bare JSON-RPC ID: every connection
   * counts from 1, so it would replay another chat's response (CAN-3976).
   */
  private assistantToolUseId(
    route: CanopyWorktreeSessionRoute,
    id: string | number,
    meta: unknown,
  ): string {
    return getClaudeToolUseId(meta) ?? this.localWatcherToolCallId(route, id);
  }

  /**
   * The tool-use ID a tools/call hands its runtime. A `LoadDeferredTools`
   * reload is registered under it, so result delivery must mark the same ID
   * or the reload never starts. Worktree chats keep the JSON-RPC ID; their
   * reload scope is already per chat.
   */
  private routeToolUseId(
    route: CanopyWorktreeSessionRoute,
    id: string | number,
    meta: unknown,
  ): string {
    return route.assistantMode === 'app-advisor' ||
      route.assistantMode === 'pipeline-editor'
      ? this.assistantToolUseId(route, id, meta)
      : String(id);
  }
  private broadcasts: McpProxyBroadcastHandlers | null = null;
  private status: McpProxyStatus = 'stopped';
  private lastError: string | undefined;
  private lastRefreshedAt: string | undefined;
  private preferredPort: number = DEFAULT_MCP_PROXY_PORT;
  private getWindow: WindowAccessor = () => null;

  private resolvePort(port: number): number {
    return getDevMcpProxyPortOverride() ?? port;
  }

  setBroadcastHandlers(handlers: McpProxyBroadcastHandlers): void {
    this.broadcasts = handlers;
    this.broadcastStatus();
  }

  setWindowAccessor(getWindow: WindowAccessor): void {
    this.getWindow = getWindow;
  }

  getState(): McpProxyState {
    const overridePort = getDevMcpProxyPortOverride();
    const preferredPort = overridePort ?? this.preferredPort;
    const portLocked = overridePort !== null;
    return {
      port: this.currentPort ?? preferredPort,
      status: this.status,
      ...(portLocked ? { portLocked: true } : {}),
      ...(this.lastRefreshedAt ? { refreshedAt: this.lastRefreshedAt } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  setPreferredPort(port: number): void {
    this.preferredPort = this.resolvePort(port);
    if (!this.server) {
      this.broadcastStatus();
    }
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  getPort(): number | null {
    return this.currentPort;
  }

  async assertPortAvailable(port: number): Promise<void> {
    const resolvedPort = this.resolvePort(port);
    if (this.server && this.currentPort === resolvedPort) {
      return;
    }

    const canBind = await this.canBindPort(resolvedPort);
    if (canBind) {
      return;
    }

    const health = await this.probeHealth(resolvedPort);
    throw new Error(buildPortInUseMessage(resolvedPort, health));
  }

  async refreshPreferredPortStatus(port: number): Promise<void> {
    const resolvedPort = this.resolvePort(port);
    this.preferredPort = resolvedPort;
    if (this.server) {
      if (this.currentPort === resolvedPort) {
        this.markStatus('running');
      } else {
        this.broadcastStatus();
      }
      return;
    }

    try {
      await this.assertPortAvailable(resolvedPort);
      this.markStatus('stopped');
    } catch (error: unknown) {
      this.markStatus(
        'error',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async probeHealth(
    port: number,
    timeoutMs: number = 750,
  ): Promise<McpProxyHealthCheck | null> {
    const controller = new AbortController();
    const timeout = setTimeout((): void => {
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/health`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        return null;
      }
      const payload: unknown = await response.json();
      if (!isRecord(payload)) {
        return null;
      }
      if (
        payload.ok !== true ||
        payload.service !== MCP_PROXY_HEALTH_SERVICE ||
        payload.version !== MCP_PROXY_HEALTH_VERSION
      ) {
        return null;
      }
      return {
        ok: true,
        service: MCP_PROXY_HEALTH_SERVICE,
        version: MCP_PROXY_HEALTH_VERSION,
        port: typeof payload.port === 'number' ? payload.port : null,
        status: isMcpProxyStatus(payload.status) ? payload.status : 'running',
        routeCount:
          typeof payload.routeCount === 'number' &&
          Number.isFinite(payload.routeCount)
            ? payload.routeCount
            : 0,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async canBindPort(port: number): Promise<boolean> {
    const probeServer = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          probeServer.off('error', onError);
          probeServer.off('listening', onListening);
        };
        const onError = (error: Error): void => {
          cleanup();
          reject(error);
        };
        const onListening = (): void => {
          cleanup();
          probeServer.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        };
        probeServer.once('error', onError);
        probeServer.once('listening', onListening);
        probeServer.listen(port, '127.0.0.1');
      });
      return true;
    } catch {
      return false;
    }
  }

  async ensureStarted(port: number = this.preferredPort): Promise<void> {
    const resolvedPort = this.resolvePort(port);
    this.preferredPort = resolvedPort;
    if (this.server && this.currentPort === resolvedPort) {
      return;
    }
    if (this.startPromise) {
      await this.startPromise;
      if (this.server && this.currentPort === resolvedPort) {
        return;
      }
      if (this.server) {
        if (this.connections.size > 0) {
          return;
        }
        await this.updatePort(resolvedPort);
      }
      return;
    }
    if (this.server) {
      if (this.connections.size > 0) {
        return;
      }
      await this.updatePort(resolvedPort);
      return;
    }

    this.startPromise = (async (): Promise<void> => {
      try {
        await this.assertPortAvailable(resolvedPort);
        await this.listen(resolvedPort);
        this.markStatus('running');
      } catch (error: unknown) {
        this.markStatus(
          'error',
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      } finally {
        this.startPromise = null;
      }
    })();
    await this.startPromise;
  }

  /**
   * Swap the listening socket while preserving registered routes.
   * Existing provider URLs that include the old port become invalid until the
   * caller re-resolves MCP plugin configuration and obtains fresh proxy URLs.
   */
  async updatePort(port: number): Promise<void> {
    const resolvedPort = this.resolvePort(port);
    if (this.server && this.currentPort === resolvedPort) {
      return;
    }

    await this.assertPortAvailable(resolvedPort);
    if (!this.server) {
      this.preferredPort = resolvedPort;
      this.broadcastStatus();
      return;
    }

    const previousPort = this.currentPort;
    await this.closeServer();
    try {
      this.preferredPort = resolvedPort;
      await this.listen(resolvedPort);
      this.markStatus('running');
    } catch (error: unknown) {
      if (previousPort !== null) {
        try {
          this.preferredPort = previousPort;
          await this.listen(previousPort);
          this.markStatus('running');
        } catch {
          this.currentPort = null;
          this.markStatus(
            'error',
            error instanceof Error ? error.message : String(error),
          );
        }
      } else {
        this.markStatus(
          'error',
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
  }

  registerRoute(route: McpProxyRouteRegistration): Promise<string> {
    return this.connections.register(route);
  }

  getRouteStatus(routeId: string): { reauthRequired: boolean } | undefined {
    return this.connections.routeStatus(routeId);
  }

  registerMcpProxyRoute(route: McpProxyRouteRegistration): Promise<string> {
    return this.connections.register(route);
  }

  unregisterRoute(routeId: string): void {
    this.connections.unregister(routeId);
  }

  unregisterMcpProxyRoute(routeId: string): void {
    this.connections.unregister(routeId);
  }

  /** Installs (or replaces) the session's proxied tool-call gate. */
  setSessionToolCallGate(
    sessionId: string,
    gate: McpProxiedToolCallGate,
  ): void {
    this.connections.setSessionToolCallGate(sessionId, gate);
  }

  unregisterRoutesForSession(sessionId: string): void {
    this.connections.disconnectSession(sessionId);
  }

  unregisterMcpProxyRoutesForSession(sessionId: string): void {
    this.connections.disconnectSession(sessionId);
  }

  getProxyUrl(routeId: string): string {
    if (this.currentPort === null) {
      throw new Error('MCP proxy is not started.');
    }
    return `http://${DESKTOP_INTEGRATION_SERVER_HOST}:${String(
      this.currentPort,
    )}${buildCanopyMcpProxyRoute(routeId)}`;
  }

  getCodexCapabilityAuthorityIds(
    mcpServers: Record<string, unknown>,
  ): string[] {
    return this.connections.codexCapabilityAuthorityIds(mcpServers);
  }

  /** Stable config identities without persisting credentials or ephemeral proxy addresses. */
  getMcpCapabilityDigests(
    mcpServers: Record<string, unknown>,
  ): Record<string, string> {
    return this.connections.capabilityDigests(mcpServers);
  }

  getCanopyCapabilityDefinitions(sessionKey: string): {
    main: ReturnType<typeof getCanopyRouteTools>;
    ui: ReturnType<typeof getCanopyRouteTools>;
  } {
    const route = this.worktreeSessionRoutes.get(sessionKey);
    if (!route) throw new Error('The MCP session route is unavailable.');
    return {
      main: getCanopyRouteTools(route, false),
      ui: getCanopyRouteTools(route, true),
    };
  }

  getSessionMcpRoute(
    sessionId: string,
    serverId: string,
    configId: string,
  ): { displayName: string } | undefined {
    return this.connections.sessionRoute(sessionId, serverId, configId);
  }

  getMcpProxyUrl(routeId: string): string {
    return this.getProxyUrl(routeId);
  }

  async registerCanopyWorktreeSessionRoute(
    route: CanopyWorktreeSessionRoute,
  ): Promise<string> {
    await this.ensureStarted();
    this.worktreeSessionRoutes.set(route.sessionKey, route);
    return route.sessionKey;
  }

  unregisterCanopyWorktreeSessionRoute(sessionKey: string): void {
    this.worktreeSessionRoutes.delete(sessionKey);
  }

  updateCanopyWorktreeSessionDeferredToolsAllowed(
    sessionKey: string,
    allowed: boolean,
  ): boolean {
    const route = this.worktreeSessionRoutes.get(sessionKey);
    if (!route) return false;
    route.deferredToolsAllowed = allowed;
    if (route.appAdvisorRuntime?.deferredToolsRuntime) {
      route.appAdvisorRuntime.deferredToolsRuntime.allowed = allowed;
    }
    return true;
  }

  updateCanopyWorktreeSessionPluginSelections(
    sessionKey: string,
    pluginSelections: ChatTabPluginSelections,
  ): boolean {
    const route = this.worktreeSessionRoutes.get(sessionKey);
    if (!route) return false;
    route.pluginSelections = pluginSelections;
    if (route.appAdvisorRuntime?.deferredToolsRuntime) {
      route.appAdvisorRuntime.deferredToolsRuntime.pluginSelections =
        pluginSelections;
    }
    return true;
  }

  getCanopyWorktreeMcpUrl(sessionKey: string): string {
    if (this.currentPort === null) {
      throw new Error('Desktop integration server is not started.');
    }
    return `http://${DESKTOP_INTEGRATION_SERVER_HOST}:${String(
      this.currentPort,
    )}${buildCanopyMcpWorktreeSessionRoute(sessionKey)}`;
  }

  getCanopyWorktreeUiMcpUrl(sessionKey: string): string {
    return `${this.getCanopyWorktreeMcpUrl(sessionKey)}/ui`;
  }

  getClaudeTerminalHookUrl(sessionKey: string): string {
    if (this.currentPort === null) {
      throw new Error('Desktop integration server is not started.');
    }
    return `http://${DESKTOP_INTEGRATION_SERVER_HOST}:${String(
      this.currentPort,
    )}${buildCanopyHooksClaudeTerminalRoute(sessionKey)}`;
  }

  async shutdown(): Promise<void> {
    await this.closeServer();
    this.connections.clear();
    this.worktreeSessionRoutes.clear();
    this.currentPort = null;
    this.markStatus('stopped');
  }

  private markStatus(status: McpProxyStatus, error?: string): void {
    this.status = status;
    this.lastError = status === 'error' ? error : undefined;
    this.lastRefreshedAt = new Date().toISOString();
    this.broadcastStatus();
  }

  private broadcastStatus(): void {
    this.broadcasts?.status(this.getState());
  }

  private async listen(port: number): Promise<void> {
    const server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    server.on('connection', (socket: Socket): void => {
      this.sockets.add(socket);
      socket.on('close', (): void => {
        this.sockets.delete(socket);
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, DESKTOP_INTEGRATION_SERVER_HOST);
    });

    this.server = server;
    this.currentPort = port;
  }

  private async closeServer(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }

    this.server = null;
    this.currentPort = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
      for (const socket of Array.from(this.sockets.values())) {
        socket.destroy();
      }
    });
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!assertLocalhostHostOrigin(req, res, this.currentPort)) {
      return;
    }

    const requestUrl = new URL(
      req.url ?? '/',
      `http://127.0.0.1:${String(this.currentPort ?? 0)}`,
    );

    if (requestUrl.pathname === '/health') {
      writeJson(res, 200, {
        ok: true,
        service: MCP_PROXY_HEALTH_SERVICE,
        version: MCP_PROXY_HEALTH_VERSION,
        port: this.currentPort,
        status: this.status,
        routeCount: this.connections.size + this.worktreeSessionRoutes.size,
      });
      return;
    }

    if (requestUrl.pathname === '/oauth/callback') {
      const result = await handleMcpOAuthCallback(requestUrl);
      writeMcpOAuthCallbackPage(res, result.success ? 200 : 400, result);
      return;
    }

    if (requestUrl.pathname.startsWith(CANOPY_MCP_WORKTREE_SESSION_PATH)) {
      await this.handleCanopyWorktreeMcpRequest(req, res, requestUrl);
      return;
    }

    if (
      requestUrl.pathname.startsWith(
        CANOPY_HOOKS_CLAUDE_TERMINAL_WORKTREE_SESSION_PATH,
      )
    ) {
      await this.handleClaudeTerminalHookRequest(req, res, requestUrl);
      return;
    }

    const routeId = this.extractMcpProxyRouteId(requestUrl.pathname);
    if (routeId === null) {
      res.writeHead(404);
      res.end();
      return;
    }

    await this.connections.serve(req, res, routeId);
  }

  private extractMcpProxyRouteId(pathname: string): string | null {
    if (pathname.startsWith(`${CANOPY_MCP_PROXY_PATH}/`)) {
      return safeDecodeURIComponent(
        pathname.slice(CANOPY_MCP_PROXY_PATH.length + 1),
      );
    }
    if (pathname.startsWith(`${LEGACY_MCP_PROXY_PATH}/`)) {
      return safeDecodeURIComponent(
        pathname.slice(LEGACY_MCP_PROXY_PATH.length + 1),
      );
    }
    return null;
  }

  private getSessionKeyFromPath(
    pathname: string,
    prefix: string,
  ): string | null {
    if (!pathname.startsWith(`${prefix}/`)) {
      return null;
    }
    const sessionKey = safeDecodeURIComponent(
      pathname.slice(prefix.length + 1),
    );
    if (sessionKey === null) {
      return null;
    }
    return sessionKey.length > 0 ? sessionKey : null;
  }

  private getAuthorizedWorktreeRoute(
    req: IncomingMessage,
    res: ServerResponse,
    sessionKey: string | null,
  ): CanopyWorktreeSessionRoute | null {
    if (!sessionKey) {
      res.writeHead(404);
      res.end();
      return null;
    }
    const route = this.worktreeSessionRoutes.get(sessionKey);
    if (!route) {
      res.writeHead(404);
      res.end();
      return null;
    }
    if (!integrationTokenMatches(req, route.authToken)) {
      res.writeHead(401);
      res.end();
      return null;
    }
    return route;
  }

  private async handleClaudeTerminalHookRequest(
    req: IncomingMessage,
    res: ServerResponse,
    requestUrl: URL,
  ): Promise<void> {
    const sessionKey = this.getSessionKeyFromPath(
      requestUrl.pathname,
      CANOPY_HOOKS_CLAUDE_TERMINAL_WORKTREE_SESSION_PATH,
    );
    const route = this.getAuthorizedWorktreeRoute(req, res, sessionKey);
    if (!route) {
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      res.end();
      return;
    }

    try {
      const raw = await readRequestBody(req);
      const parsed: unknown = raw.length > 0 ? JSON.parse(raw) : null;
      if (!isClaudeTerminalHookCallbackBody(parsed)) {
        writeJson(res, 400, { error: 'Invalid Claude terminal hook payload' });
        return;
      }
      const result = await route.hookHandler(parsed);
      if (result === undefined) {
        res.writeHead(200);
        res.end();
      } else {
        writeJson(res, 200, isRecord(result) ? result : { result });
      }
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        writeJson(res, 413, {
          error: 'Claude terminal hook payload too large',
        });
        return;
      }
      writeJson(res, 500, {
        error: 'Claude terminal hook handler failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleCanopyWorktreeMcpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    requestUrl: URL,
  ): Promise<void> {
    let pathname = requestUrl.pathname;
    const uiServer = pathname.endsWith('/ui');
    if (uiServer) {
      pathname = pathname.slice(0, -'/ui'.length);
    }
    const sessionKey = this.getSessionKeyFromPath(
      pathname,
      CANOPY_MCP_WORKTREE_SESSION_PATH,
    );
    const route = sessionKey
      ? this.worktreeSessionRoutes.get(sessionKey)
      : undefined;
    if (!route) {
      const id = await readJsonRpcIdFromRequest(req);
      writeJson(
        res,
        404,
        jsonRpcError(
          id,
          -32004,
          `${BRAND.displayName} worktree session not found`,
        ),
      );
      return;
    }
    if (!integrationTokenMatches(req, route.authToken)) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      res.end();
      return;
    }

    let payload: unknown;
    try {
      const raw = await readRequestBody(req);
      payload = raw.length > 0 ? JSON.parse(raw) : null;
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        writePayloadTooLargeJsonRpc(res);
        return;
      }
      writeJson(res, 400, jsonRpcError(null, -32700, 'Parse error'));
      return;
    }

    const payloadRecord = isRecord(payload) ? payload : undefined;
    const isToolCall = payloadRecord?.method === 'tools/call';
    const params =
      isToolCall && isRecord(payloadRecord.params)
        ? payloadRecord.params
        : undefined;
    const appAdvisorArgs = isRecord(params?.arguments)
      ? params.arguments
      : undefined;
    const appAdvisorAction = isRecord(appAdvisorArgs?.action)
      ? appAdvisorArgs.action
      : undefined;
    const isAppAdvisorBaseBranchCall =
      !uiServer &&
      route.assistantMode === 'app-advisor' &&
      getClaudeTerminalAppAdvisorToolKey(params?.name) === 'dispatch_action' &&
      appAdvisorAction?.type === 'worktree.set_base_branch';
    const isDirectBaseBranchCall =
      !uiServer &&
      route.assistantMode !== 'app-advisor' &&
      route.assistantMode !== 'pipeline-editor' &&
      getClaudeCanopyToolKey(
        params?.name,
        getClaudeCanopyToolSurface(route),
      ) === 'set_base_branch';
    if (
      isToolCall &&
      (uiServer || isAppAdvisorBaseBranchCall || isDirectBaseBranchCall)
    ) {
      await this.streamCanopyMcpJsonRpc(req, res, route, payload, uiServer);
      return;
    }

    let response: Record<string, unknown> | null;
    try {
      response = await this.handleCanopyMcpJsonRpc(route, payload, uiServer);
    } catch (error) {
      response = jsonRpcInternalError(getJsonRpcId(payload), error);
    }
    if (response === null) {
      res.writeHead(204);
      res.end();
      return;
    }
    const toolRequestId =
      isToolCall &&
      isRecord(payload) &&
      (typeof payload.id === 'string' || typeof payload.id === 'number')
        ? payload.id
        : undefined;
    if (toolRequestId !== undefined && route.nativeToolResultDelivery) {
      const toolUseId = this.routeToolUseId(
        route,
        toolRequestId,
        params?._meta,
      );
      try {
        route.nativeToolResultDelivery({
          requestId: String(toolRequestId),
          toolUseId,
          result: response.result,
        });
      } catch {
        const reason =
          'The tool result could not be verified. Please try again.';
        deferredToolsReloadCoordinator.cancelPendingToolResult(
          {
            projectId: route.projectId,
            worktreeId: route.worktreeId,
            chatId: route.chatId,
          },
          toolUseId,
          reason,
        );
        writeJson(res, 200, jsonRpcError(toolRequestId, -32603, reason));
        return;
      }
    }
    writeJson(res, 200, response);
    // OpenCode acknowledges its ACP receipt after the HTTP response.
    // Reloading here can terminate the process before that native result.
    if (
      toolRequestId !== undefined &&
      !route.nativeToolResultDelivery &&
      route.providerType !== 'opencode'
    ) {
      await deferredToolsReloadCoordinator.markToolResultDeliveredAndWaitForResume(
        {
          projectId: route.projectId,
          worktreeId: route.worktreeId,
          chatId: route.chatId,
        },
        this.routeToolUseId(route, toolRequestId, params?._meta),
      );
    }
  }

  /**
   * Stream a long-running Canopy MCP tool call (AskUserQuestion on the `/ui`
   * server) as Server-Sent Events. The MCP StreamableHTTP client (undici) caps
   * the wait for response headers at its `headersTimeout` (default 5 minutes),
   * so a buffered response that only sends headers once the user answers is
   * killed at 5 minutes regardless of the per-server `timeout`. Sending the SSE
   * headers immediately, with periodic keepalive comments to reset the client's
   * `bodyTimeout`, keeps the connection alive until the user responds (or the
   * in-tool 59-minute timeout fires).
   */
  private async streamCanopyMcpJsonRpc(
    req: IncomingMessage,
    res: ServerResponse,
    route: CanopyWorktreeSessionRoute,
    payload: unknown,
    uiServer: boolean,
  ): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    let closed = false;
    let progress = 0;
    const abortController = new AbortController();
    const progressToken = getMcpProgressToken(payload);
    const pendingAskUserRequestIds = new Set<string>();
    const expirePendingAskUserRequest = (requestId: string): void => {
      rejectRequest(requestId, 'transport_closed');
      sendToWindow(this.getWindow(), IPC_CHANNELS.mcpExpireAskUser, {
        requestId,
      });
    };
    const keepAlive = setInterval((): void => {
      if (!closed && !res.writableEnded) {
        res.write(': keepalive\n\n');
        if (progressToken !== null) {
          progress += 1;
          res.write(
            `data: ${JSON.stringify(
              mcpProgressNotification(
                progressToken,
                progress,
                'Waiting for user response',
              ),
            )}\n\n`,
          );
        }
      }
    }, CANOPY_MCP_SSE_KEEPALIVE_MS);
    const onClose = (): void => {
      closed = true;
      clearInterval(keepAlive);
      abortController.abort();
      for (const requestId of Array.from(pendingAskUserRequestIds)) {
        expirePendingAskUserRequest(requestId);
      }
      pendingAskUserRequestIds.clear();
    };
    res.on('close', onClose);
    const cleanup = (): void => {
      clearInterval(keepAlive);
      res.removeListener('close', onClose);
      pendingAskUserRequestIds.clear();
    };
    const requestContext: CanopyMcpRequestContext = {
      signal: abortController.signal,
      onAskUserRequestCreated: (requestId): void => {
        if (closed) {
          expirePendingAskUserRequest(requestId);
          return;
        }
        pendingAskUserRequestIds.add(requestId);
      },
    };
    try {
      const response = await this.handleCanopyMcpJsonRpc(
        route,
        payload,
        uiServer,
        requestContext,
      );
      cleanup();
      if (closed || res.writableEnded) {
        return;
      }
      if (response !== null) {
        res.write(`data: ${JSON.stringify(response)}\n\n`);
      }
      res.end();
    } catch (error) {
      cleanup();
      if (closed || res.writableEnded) {
        return;
      }
      const id = getJsonRpcId(isRecord(payload) ? payload : {});
      res.write(`data: ${JSON.stringify(jsonRpcInternalError(id, error))}\n\n`);
      res.end();
    }
  }

  private async handleCanopyMcpJsonRpc(
    route: CanopyWorktreeSessionRoute,
    payload: unknown,
    uiServer = false,
    requestContext?: CanopyMcpRequestContext,
  ): Promise<Record<string, unknown> | null> {
    if (route.turnSignal) {
      requestContext = {
        ...requestContext,
        signal: requestContext?.signal
          ? AbortSignal.any([route.turnSignal, requestContext.signal])
          : route.turnSignal,
      };
    }
    if (!isRecord(payload)) {
      return jsonRpcError(null, -32600, 'Invalid request');
    }
    const method = typeof payload.method === 'string' ? payload.method : '';
    const id = getJsonRpcId(payload);
    if (!('id' in payload)) {
      return null;
    }

    const effectiveSurface: CanopyInjectedToolSurface = uiServer
      ? 'native-sdk-ui'
      : getClaudeCanopyToolSurface(route);

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: {
            name: uiServer
              ? `${BRAND.tools.namespace}_ui`
              : route.assistantMode === 'app-advisor'
                ? `${BRAND.tools.namespace}_app_advisor`
                : route.assistantMode === 'pipeline-editor'
                  ? `${BRAND.tools.namespace}_pipeline_editor`
                  : BRAND.tools.namespace,
            version: '1.0.0',
          },
        },
      };
    }
    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: listCanopyRouteTools(route, uiServer) },
      };
    }
    if (method === 'tools/call') {
      const params = isRecord(payload.params) ? payload.params : {};
      if (
        !uiServer &&
        typeof params.name === 'string' &&
        route.managedDelegation &&
        (route.managedDelegation.tools.some(
          (tool) => tool.name === params.name,
        ) ||
          (!route.managedDelegation.exclusive &&
            isWatchDelegatesCompatibilityName(params.name, 'claude')))
      ) {
        const result = await route.managedDelegation.invoke(
          params.name,
          params.arguments,
          {
            ...(typeof id === 'string' || typeof id === 'number'
              ? { requestId: String(id) }
              : {}),
          },
        );
        return { jsonrpc: '2.0', id, result: toMcpToolResult(result) };
      }
      if (route.managedDelegation?.exclusive)
        return {
          jsonrpc: '2.0',
          id,
          result: toMcpToolResult({
            text: 'This tool is not available to this delegated task.',
            isError: true,
          }),
        };
      if (
        params.name === REPORT_STRUCTURED_RESULT_TOOL_NAME &&
        route.onReportStructuredResult
      ) {
        const result = route.onReportStructuredResult(params.arguments ?? {});
        return {
          jsonrpc: '2.0',
          id,
          result: toMcpToolResult({
            text: result.ok
              ? 'Structured result recorded. Stop now.'
              : `The ReportStructuredResult arguments did not match the required schema: ${result.error ?? 'validation failed'}. Fix the arguments and call ReportStructuredResult again before stopping.`,
            isError: !result.ok,
          }),
        };
      }
      if (route.assistantMode === 'app-advisor') {
        const canonicalKey = getClaudeTerminalAppAdvisorToolKey(params.name);
        if (!canonicalKey) {
          return jsonRpcError(id, -32602, 'Unknown Orchestrator MCP tool');
        }
        const allowedOnSurface = uiServer
          ? canonicalKey === 'ask_user_question'
          : canonicalKey !== 'ask_user_question';
        if (!allowedOnSurface) {
          return jsonRpcError(id, -32602, 'Unknown Orchestrator MCP tool');
        }
        if (!route.appAdvisorRuntime) {
          return jsonRpcError(id, -32603, 'Orchestrator runtime unavailable');
        }
        // Ledger calls run only on this session's own Ledger tools, bound to
        // the Work Entry it started in. A session without them refuses the
        // call before any approval prompt, as worktree routes do.
        const isLedgerCall = isAppAdvisorLedgerToolKey(canonicalKey);
        if (isLedgerCall && route.ledgerTools === undefined) {
          return {
            jsonrpc: '2.0',
            id,
            result: toMcpToolResult(ledgerUnavailableResult('no_ledger_scope')),
          };
        }
        const args = isRecord(params.arguments) ? params.arguments : {};
        try {
          // Claude and Codex are gated before they reach this seam; a Cursor
          // route installs its own gate because the ACP permission request is
          // advisory. Same denial shape as the worktree branch. The gate runs
          // inside the try so a gate that throws (a disposed approval session)
          // still answers the request instead of leaving the CLI waiting.
          if (
            route.authorizeToolCall &&
            !(await route.authorizeToolCall(
              canonicalKey,
              args,
              typeof id === 'string' || typeof id === 'number'
                ? { requestId: String(id) }
                : undefined,
            ))
          ) {
            return {
              jsonrpc: '2.0',
              id,
              result: toMcpToolResult({
                text: `${APP_ADVISOR_TOOL_REGISTRY[canonicalKey].displayName} was denied.`,
                isError: true,
              }),
            };
          }
          const action = isRecord(args.action) ? args.action : undefined;
          const isBaseBranchDispatch =
            canonicalKey === 'dispatch_action' &&
            action?.type === 'worktree.set_base_branch';
          const toolContext: AppAdvisorToolContext = {
            ...(!isBaseBranchDispatch &&
            (typeof id === 'string' || typeof id === 'number')
              ? {
                  toolUseId:
                    canonicalKey === 'schedule_wakeup' ||
                    canonicalKey === 'watch_command'
                      ? this.localWatcherToolCallId(route, id)
                      : this.routeToolUseId(route, id, params._meta),
                }
              : {}),
            ...(requestContext?.signal
              ? { signal: requestContext.signal }
              : {}),
            ...(isLedgerCall && route.ledgerTools
              ? {
                  ...this.ledgerInvocationContext(route, id, params._meta),
                  ledgerRuntime: route.ledgerTools,
                }
              : {}),
          };
          const result = await executeAppAdvisorTool(
            canonicalKey,
            args,
            route.appAdvisorRuntime,
            Object.keys(toolContext).length > 0 ? toolContext : undefined,
          );
          return {
            jsonrpc: '2.0',
            id,
            result: toMcpToolResult(result),
          };
        } catch (error) {
          return jsonRpcInternalError(id, error);
        }
      }
      if (route.assistantMode === 'pipeline-editor') {
        const canonicalKey = getClaudeTerminalPipelineEditorToolKey(
          params.name,
        );
        if (!canonicalKey) {
          return jsonRpcError(id, -32602, 'Unknown Pipeline Editor MCP tool');
        }
        const allowedOnSurface = uiServer
          ? canonicalKey === 'ask_user_question'
          : canonicalKey !== 'ask_user_question';
        if (!allowedOnSurface) {
          return jsonRpcError(id, -32602, 'Unknown Pipeline Editor MCP tool');
        }
        if (!route.pipelineEditorRuntime) {
          return jsonRpcError(
            id,
            -32603,
            'Pipeline Editor runtime unavailable',
          );
        }
        const args = isRecord(params.arguments) ? params.arguments : {};
        if (
          (route.providerType === 'cursor' && !route.authorizeToolCall) ||
          (route.authorizeToolCall &&
            !(await route.authorizeToolCall(
              canonicalKey,
              args,
              typeof id === 'string' || typeof id === 'number'
                ? { requestId: String(id) }
                : undefined,
            )))
        )
          return {
            jsonrpc: '2.0',
            id,
            result: toMcpToolResult({
              text: 'This Pipeline Assistant tool was denied.',
              isError: true,
            }),
          };
        try {
          const result = await executePipelineEditorTool(
            canonicalKey,
            args,
            route.pipelineEditorRuntime,
            {
              ...(typeof id === 'string' || typeof id === 'number'
                ? { toolUseId: this.routeToolUseId(route, id, params._meta) }
                : {}),
              ...(requestContext?.signal
                ? { signal: requestContext.signal }
                : {}),
            },
          );
          return {
            jsonrpc: '2.0',
            id,
            result: toMcpToolResult(result),
          };
        } catch (error) {
          return jsonRpcInternalError(id, error);
        }
      }
      if (
        params.name === RESPOND_TO_COMMENT_TOOL_NAME &&
        route.isCodeReview &&
        route.respondToReviewComment
      ) {
        const respondFn = route.respondToReviewComment;
        const parsed = respondToCommentSchema.safeParse(params.arguments);
        if (!parsed.success) {
          return {
            jsonrpc: '2.0',
            id,
            result: toMcpToolResult({
              text: 'Invalid RespondToComment arguments.',
              isError: true,
            }),
          };
        }
        try {
          const result = await respondFn({
            threadId: parsed.data.threadId,
            body: parsed.data.body,
            resolve: parsed.data.resolve ?? false,
          });
          return {
            jsonrpc: '2.0',
            id,
            result: toMcpToolResult({
              text: result.ok
                ? `Reply posted to thread ${parsed.data.threadId}${result.resolved ? ' and the thread was resolved' : ''}.`
                : `Reply failed: ${result.error ?? 'unknown error'}`,
              isError: !result.ok,
            }),
          };
        } catch (error) {
          return jsonRpcInternalError(id, error);
        }
      }
      if (
        params.name === GET_REVIEW_COMMENTS_TOOL_NAME &&
        route.isCodeReview &&
        route.getReviewCommentThread
      ) {
        const getCommentsFn = route.getReviewCommentThread;
        const parsed = getReviewCommentsSchema.safeParse(params.arguments);
        if (!parsed.success) {
          return {
            jsonrpc: '2.0',
            id,
            result: toMcpToolResult({
              text: 'Invalid GetReviewComments arguments.',
              isError: true,
            }),
          };
        }
        try {
          const result = await getCommentsFn(
            parsed.data.threadId !== undefined
              ? { threadId: parsed.data.threadId }
              : {},
          );
          return {
            jsonrpc: '2.0',
            id,
            result: toMcpToolResult({
              text: result.ok
                ? result.text
                : `Failed to read comments: ${result.error ?? 'unknown error'}`,
              isError: !result.ok,
            }),
          };
        } catch (error) {
          return jsonRpcInternalError(id, error);
        }
      }
      const canonicalKey = getClaudeCanopyToolKey(
        params.name,
        effectiveSurface,
      );
      if (!canonicalKey) {
        return jsonRpcError(
          id,
          -32602,
          `Unknown ${BRAND.displayName} MCP tool`,
        );
      }
      if (
        (canonicalKey === 'show_visual' || canonicalKey === 'preview_visual') &&
        !chatVisualsEligible({
          providerType: route.providerType,
          surface: effectiveSurface,
          assistantMode: route.assistantMode,
          key: canonicalKey,
        })
      ) {
        return {
          jsonrpc: '2.0',
          id,
          result: toMcpToolResult({
            text: `${canonicalKey === 'preview_visual' ? 'PreviewVisual' : 'ShowVisual'} isn't available in this chat.`,
            isError: true,
          }),
        };
      }
      if (
        getClaudeCanopyToolSurface(route) === 'claude-worker' &&
        !isClaudeWorkerToolExposed(
          canonicalKey,
          route.workerMemoryToolExposure ?? 'none',
          route.ledgerTools !== undefined,
        )
      ) {
        // Workers run with bypassPermissions, so an unadvertised tool must
        // also be refused at dispatch or a prompted worker could still call it.
        return jsonRpcError(
          id,
          -32602,
          `Unknown ${BRAND.displayName} MCP tool`,
        );
      }
      if (
        route.codeGraphToolsAdvertised === false &&
        isCodeGraphInjectedToolKey(canonicalKey)
      ) {
        return {
          jsonrpc: '2.0',
          id,
          result: toMcpToolResult({
            text: CODE_GRAPH_UNAVAILABLE_MESSAGE,
            isError: true,
          }),
        };
      }
      if (
        route.ledgerTools === undefined &&
        isLedgerInjectedToolKey(canonicalKey)
      ) {
        return {
          jsonrpc: '2.0',
          id,
          result: toMcpToolResult(ledgerUnavailableResult('no_ledger_scope')),
        };
      }
      const args = isRecord(params.arguments) ? params.arguments : {};
      try {
        if (
          route.authorizeToolCall &&
          !(await route.authorizeToolCall(
            canonicalKey,
            args,
            typeof id === 'string' || typeof id === 'number'
              ? { requestId: String(id) }
              : undefined,
          ))
        )
          return {
            jsonrpc: '2.0',
            id,
            result: toMcpToolResult({
              text: `${CANOPY_INJECTED_TOOL_REGISTRY[canonicalKey].displayName} was denied.`,
              isError: true,
            }),
          };
        // The MCP JSON-RPC request id is transport-local and is not the
        // Claude transcript's tool_use id. Projecting it would make the
        // browser try to correlate (for example) `"2"` with
        // `toolu_...`, preventing the question-text match (which only
        // id-less records may use) from finding the question. Codex supplies its
        // real `codex-*` call id through the native dynamic-tool path rather
        // than this Claude HTTP proxy. SetBaseBranch also suppresses the
        // transport id because its renderer request id has process-wide
        // deduplication scope.
        // A pipeline run replays by tool call. The bare request id restarts
        // per connection, so it takes Claude's tool_use id, which a retry
        // resends, or this registration's id, as App Advisor's calls do.
        const pipelineRun =
          canonicalKey === 'dispatch_action' &&
          isRecord(args.action) &&
          args.action.type === 'pipeline.run';
        const toolCallOptions: CanopyInjectedToolContext = {
          ...(canonicalKey !== 'ask_user_question' &&
          canonicalKey !== 'set_base_branch' &&
          (typeof id === 'string' || typeof id === 'number')
            ? {
                toolUseId: pipelineRun
                  ? this.assistantToolUseId(route, id, params._meta)
                  : canonicalKey === 'schedule_wakeup' ||
                      canonicalKey === 'watch_command'
                    ? this.localWatcherToolCallId(route, id)
                    : this.routeToolUseId(route, id, params._meta),
              }
            : {}),
          ...(requestContext?.signal ? { signal: requestContext.signal } : {}),
          ...(canonicalKey === 'preview_visual'
            ? {
                imageBudgetBytes:
                  route.providerType === 'cursor'
                    ? VISUAL_PREVIEW_BUDGETS.cursorImageBytes
                    : VISUAL_PREVIEW_BUDGETS.claudeImageBytes,
              }
            : {}),
          ...(isLedgerInjectedToolKey(canonicalKey)
            ? this.ledgerInvocationContext(route, id, params._meta)
            : {}),
        };
        const result = await executeCanopyInjectedTool(
          canonicalKey,
          args,
          createClaudeCanopyToolRuntime(
            route,
            canonicalKey,
            this.getWindow,
            effectiveSurface,
            requestContext,
          ),
          Object.keys(toolCallOptions).length > 0 ? toolCallOptions : undefined,
        );
        return {
          jsonrpc: '2.0',
          id,
          result: toMcpToolResult(result),
        };
      } catch (error) {
        return jsonRpcInternalError(id, error);
      }
    }
    return jsonRpcError(id, -32601, 'Method not found');
  }
}

let service: McpHttpProxyService | null = null;

export function getMcpHttpProxyService(): McpHttpProxyService {
  if (!service) {
    service = new McpHttpProxyService();
  }
  return service;
}
