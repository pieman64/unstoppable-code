import { isWatchDelegatesCompatibilityName } from '@canopy/desktop-shared/node/delegation/watch-delegates-tombstone';
import {
  SHOW_CAPABILITIES_DESCRIPTION,
  showCapabilitiesJsonSchema,
} from '../canopy-tools/show-capabilities';
import {
  CanopyCloudClientError,
  resolveCanopyCloudCredentialContext,
} from '../canopy-cloud/client';
import {
  registerAccountMcpRouteStatus,
  removeAccountMcpRouteStatus,
  setAccountMcpRouteReauthRequired,
} from './account-route-status';
import { logMainProcessError } from '../lib/main-process-logging';
import {
  WATCH_COMMAND_DESCRIPTION,
  SCHEDULE_WAKEUP_DESCRIPTION,
  watchCommandJsonSchema,
  scheduleWakeupJsonSchema,
} from '../canopy-tools/local-watcher-definitions';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
  type Server,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { createCopilotCapabilitySnapshot } from '@canopy/desktop-shared/node/copilot/capability-snapshot';
import { readFile } from 'node:fs/promises';
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
  getCanonicalCanopyToolKey,
  isCodeGraphInjectedToolKey,
  isLedgerInjectedToolKey,
  type CanopyInjectedToolKey,
  type CanopyInjectedToolSurface,
} from '@canopy/desktop-shared/lib/canopy-injected-tools';
import {
  APP_ADVISOR_TOOL_ENTRIES,
  APP_ADVISOR_TOOL_REGISTRY,
  isAppAdvisorLedgerToolKey,
  type AppAdvisorToolKey,
} from '@canopy/desktop-shared/lib/app-advisor-tools';
import {
  PIPELINE_EDITOR_TOOL_ENTRIES,
  type PipelineEditorToolKey,
} from '@canopy/desktop-shared/lib/pipeline-editor-tools';
import type { JsonValue } from '@canopy/desktop-shared/node/codex-runtime/generated/serde_json/JsonValue';
import type {
  McpProxyState,
  McpProxyStatus,
  McpServerConfigData,
  McpServerDefinitionData,
  McpServerFile,
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
import { clearAuthFailureToolNameCache } from '../lib/auth-failure-event';
import { getMcpServerFilePath } from '../lib/paths';
import { getValidMcpAccessToken, handleMcpOAuthCallback } from './oauth-client';
import { writeMcpOAuthCallbackPage } from './oauth-callback-page';
import { invalidateMcpOAuthAccessToken } from './oauth-token-store';
import {
  clearPendingAuthFailures,
  recordPendingMcpAuthFailure,
} from './pending-auth-failures';
import { classifyMcpAuthFailure } from '@canopy/desktop-shared/agent-failures';
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
  SET_AUTO_ARCHIVE_DESCRIPTION,
  SET_BASE_BRANCH_DESCRIPTION,
  START_FORKED_AGENT_DESCRIPTION,
  START_BRANCHED_AGENT_DESCRIPTION,
  startSplitAgentJsonSchema,
  ASK_USER_QUESTION_DESCRIPTION,
  BUILD_OR_UPDATE_CODE_GRAPH_DESCRIPTION,
  COMPARE_CHANGE_IMPACT_DESCRIPTION,
  DETECT_CHANGED_SYMBOLS_DESCRIPTION,
  DELETE_WATCHERS_DESCRIPTION,
  DISPATCH_ACTION_DESCRIPTION,
  EXPLAIN_CODE_SYMBOL_DESCRIPTION,
  GET_CODE_GRAPH_CONTEXT_DESCRIPTION,
  GET_GIT_PREFERENCES_DESCRIPTION,
  GET_FILE_COMMENTS_DESCRIPTION,
  GET_REVIEW_COMMENTS_DESCRIPTION,
  GET_IMPACT_RADIUS_DESCRIPTION,
  GET_REVIEW_CONTEXT_DESCRIPTION,
  GET_SCRIPT_OUTPUT_DESCRIPTION,
  QUERY_CODE_GRAPH_DESCRIPTION,
  READ_PIPELINE_YAML_DESCRIPTION,
  SAVE_MEMORY_DESCRIPTION,
  SEARCH_MEMORY_DESCRIPTION,
  READ_MEMORY_DESCRIPTION,
  SHOW_FILES_DESCRIPTION,
  SHOW_VISUAL_DESCRIPTION,
  RESPOND_TO_FILE_COMMENT_DESCRIPTION,
  RESPOND_TO_REVIEW_COMMENT_DESCRIPTION,
  REPORT_STRUCTURED_RESULT_DESCRIPTION,
  SEARCH_ACTIONS_DESCRIPTION,
  SEARCH_CODE_GRAPH_DESCRIPTION,
  SEARCH_WATCHERS_DESCRIPTION,
  SETUP_WATCHERS_DESCRIPTION,
  WATCH_GITHUB_ITEMS_DESCRIPTION,
  GET_GITHUB_PULL_REQUEST_STATUS_DESCRIPTION,
  setAutoArchiveJsonSchema,
  setBaseBranchJsonSchema,
  askUserQuestionJsonSchema,
  deleteWatchersJsonSchema,
  buildOrUpdateCodeGraphJsonSchema,
  compareChangeImpactJsonSchema,
  coworkDispatchActionJsonSchema,
  detectChangedSymbolsJsonSchema,
  dispatchActionJsonSchema,
  explainCodeSymbolJsonSchema,
  getCodeGraphContextJsonSchema,
  getGitPreferencesJsonSchema,
  getFileCommentsJsonSchema,
  getImpactRadiusJsonSchema,
  getReviewContextJsonSchema,
  getReviewCommentsSchema,
  getReviewCommentsJsonSchema,
  getScriptOutputJsonSchema,
  queryCodeGraphJsonSchema,
  readPipelineYamlJsonSchema,
  saveMemoryJsonSchema,
  searchMemoryJsonSchema,
  readMemoryJsonSchema,
  showFilesJsonSchema,
  showVisualJsonSchema,
  previewVisualJsonSchema,
  PREVIEW_VISUAL_DESCRIPTION,
  respondToFileCommentJsonSchema,
  respondToCommentJsonSchema,
  respondToCommentSchema,
  searchActionsJsonSchema,
  searchCodeGraphJsonSchema,
  searchWatchersJsonSchema,
  setupWatchersJsonSchema,
  watchGitHubItemsJsonSchema,
  getGitHubPullRequestStatusJsonSchema,
  ADD_LEDGER_ENTRY_DESCRIPTION,
  SEARCH_LEDGER_ENTRIES_DESCRIPTION,
  UPDATE_LEDGER_ENTRY_DESCRIPTION,
  addLedgerEntryJsonSchema,
  searchLedgerEntriesJsonSchema,
  updateLedgerEntryJsonSchema,
} from '../canopy-tools/definitions';
import { chatVisualsEligible } from '../lib/chat-visuals-feature-flag';
import { VISUAL_PREVIEW_BUDGETS } from '../browser/visual-preview-types';
import { createShowVisualHost } from '../canopy-tools/show-visual-host';
import {
  ledgerUnavailableResult,
  type LedgerToolsRuntime,
} from '../canopy-tools/ledger-tools-runtime';
import {
  LOAD_DEFERRED_TOOLS_DESCRIPTION,
  SEARCH_DEFERRED_TOOLS_DESCRIPTION,
  loadDeferredToolsJsonSchema,
  searchDeferredToolsJsonSchema,
} from '../deferred-tools/definitions';
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
  APP_ADVISOR_START_FORKED_AGENT_DESCRIPTION,
  executeAppAdvisorTool,
  type AppAdvisorToolContext,
} from '../app-advisor/tool-executor';
import type { PipelineEditorToolRuntime } from '../pipeline-editor/runtime';
import { executePipelineEditorTool } from '../pipeline-editor/tool-executor';
import { rejectRequest } from './pending-requests';
import {
  APP_ADVISOR_ADD_LEDGER_ENTRY_DESCRIPTION,
  APP_ADVISOR_GET_SCRIPT_OUTPUT_DESCRIPTION,
  APP_ADVISOR_GET_FILE_COMMENTS_DESCRIPTION,
  APP_ADVISOR_READ_PIPELINE_YAML_DESCRIPTION,
  APP_ADVISOR_RESPOND_TO_FILE_COMMENT_DESCRIPTION,
  APP_ADVISOR_SEARCH_LEDGER_ENTRIES_DESCRIPTION,
  APP_ADVISOR_SHOW_FILES_DESCRIPTION,
  APP_ADVISOR_UPDATE_LEDGER_ENTRY_DESCRIPTION,
  DISPATCH_ACTION_DESCRIPTION as APP_ADVISOR_DISPATCH_ACTION_DESCRIPTION,
  GET_CURRENT_UI_STATE_DESCRIPTION,
  GET_PIPELINE_DEBUG_CONTEXT_DESCRIPTION,
  SEARCH_ACTIONS_DESCRIPTION as APP_ADVISOR_SEARCH_ACTIONS_DESCRIPTION,
  SEARCH_WATCHERS_DESCRIPTION as APP_ADVISOR_SEARCH_WATCHERS_DESCRIPTION,
  SETUP_WATCHERS_DESCRIPTION as APP_ADVISOR_SETUP_WATCHERS_DESCRIPTION,
  WATCH_GITHUB_ITEMS_DESCRIPTION as APP_ADVISOR_WATCH_GITHUB_ITEMS_DESCRIPTION,
  GET_GITHUB_PULL_REQUEST_STATUS_DESCRIPTION as APP_ADVISOR_GET_GITHUB_PULL_REQUEST_STATUS_DESCRIPTION,
  appAdvisorGetScriptOutputJsonSchema,
  appAdvisorGetFileCommentsJsonSchema,
  appAdvisorReadPipelineYamlJsonSchema,
  appAdvisorShowFilesJsonSchema,
  appAdvisorRespondToFileCommentJsonSchema,
  askUserQuestionJsonSchema as appAdvisorAskUserQuestionJsonSchema,
  dispatchActionJsonSchema as appAdvisorDispatchActionJsonSchema,
  getCurrentUiStateJsonSchema,
  getPipelineDebugContextJsonSchema,
  searchActionsJsonSchema as appAdvisorSearchActionsJsonSchema,
  searchWatchersJsonSchema as appAdvisorSearchWatchersJsonSchema,
  setupWatchersJsonSchema as appAdvisorSetupWatchersJsonSchema,
  watchGitHubItemsJsonSchema as appAdvisorWatchGitHubItemsJsonSchema,
} from '../app-advisor/definitions';
import {
  NAVIGATION_TO_LIST_DESCRIPTION,
  PIPELINE_CREATE_DESCRIPTION,
  PIPELINE_GET_ACTION_DEFINITION_DESCRIPTION,
  PIPELINE_GET_CURRENT_DESCRIPTION,
  PIPELINE_LIST_DESCRIPTION,
  PIPELINE_OPEN_DESCRIPTION,
  PIPELINE_SAVE_DESCRIPTION,
  PIPELINE_SET_YAML_DESCRIPTION,
  askUserQuestionJsonSchema as pipelineEditorAskUserQuestionJsonSchema,
  emptyArgsJsonSchema as pipelineEditorEmptyArgsJsonSchema,
  pipelineGetActionDefinitionJsonSchema,
  pipelineOpenJsonSchema,
  pipelineSetYamlJsonSchema,
} from '../pipeline-editor/definitions';

export const MCP_PROXY_HEALTH_SERVICE = 'desktop-integration-server';
const MCP_PROXY_HEALTH_VERSION = 1;
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

export interface McpProxyBroadcastHandlers {
  status: (state: McpProxyState) => void;
}

type WindowAccessor = () => BrowserWindow | null;

interface CanopyMcpRequestContext {
  onAskUserRequestCreated?: (requestId: string) => void;
  signal?: AbortSignal;
}

export interface McpProxyRoute {
  routeId: string;
  sessionId: string | null;
  serverId: string;
  configId: string;
  displayName: string;
  upstreamUrl: string;
  headers: Record<string, string>;
  oauthEnabled: boolean;
  authSupplier?: 'oauth' | 'canopy-cloud';
  reauthRequired?: boolean;
  oauthRequired?: boolean;
  oauthDefinition?: McpServerDefinitionData;
  oauthConfig?: McpServerConfigData;
  /** Delegated routes must never forward without their live parent gate. */
  requireToolCallGate?: boolean;
}

export interface McpProxyRouteRegistration extends Omit<
  McpProxyRoute,
  'routeId' | 'reauthRequired'
> {
  routeKey?: string;
}

interface InternalMcpProxyRoute extends McpProxyRoute {
  routeKey?: string;
  parsedUpstream: URL;
}

/**
 * Execution-time gate a session installs for the proxied plugin and
 * standalone MCP routes it owns. Consulted for every `tools/call` before it
 * is forwarded upstream; `false` answers the call with a denial instead.
 */
export type McpProxiedToolCallGate = (call: {
  proxyUrl: string;
  tool: string;
  args: Record<string, unknown>;
  requestId?: string;
}) => Promise<boolean>;

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

/**
 * Stable display name for the bespoke code-review reply tool (formerly shared
 * with the retired plan-chat takeover).
 */
const RESPOND_TO_COMMENT_TOOL_NAME = 'RespondToComment';
/**
 * Stable display name for the bespoke code-review read tool. Code-review
 * sessions reuse `RespondToComment` (with a review-specific description) for
 * the reply side.
 */
const GET_REVIEW_COMMENTS_TOOL_NAME = 'GetReviewComments';
export const REPORT_STRUCTURED_RESULT_TOOL_NAME = 'ReportStructuredResult';

export interface McpProxyHealthCheck {
  ok: true;
  service: typeof MCP_PROXY_HEALTH_SERVICE;
  version: typeof MCP_PROXY_HEALTH_VERSION;
  port: number | null;
  status: McpProxyStatus;
  routeCount: number;
}

const SAFE_FORWARD_HEADERS = new Set([
  'accept',
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
]);

const SAFE_RESPONSE_HEADERS = new Set([
  'transfer-encoding',
  'content-type',
  'cache-control',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
  'www-authenticate',
]);

const CLAUDE_TERMINAL_TOOL_DEFINITIONS: Readonly<
  Partial<
    Record<
      CanopyInjectedToolKey,
      {
        description: string;
        inputSchema: JsonValue;
      }
    >
  >
> = {
  watch_command: {
    description: WATCH_COMMAND_DESCRIPTION,
    inputSchema: watchCommandJsonSchema,
  },
  schedule_wakeup: {
    description: SCHEDULE_WAKEUP_DESCRIPTION,
    inputSchema: scheduleWakeupJsonSchema,
  },
  ask_user_question: {
    description: ASK_USER_QUESTION_DESCRIPTION,
    inputSchema: askUserQuestionJsonSchema,
  },
  get_script_output: {
    description: GET_SCRIPT_OUTPUT_DESCRIPTION,
    inputSchema: getScriptOutputJsonSchema,
  },
  get_git_preferences: {
    description: GET_GIT_PREFERENCES_DESCRIPTION,
    inputSchema: getGitPreferencesJsonSchema,
  },
  save_memory: {
    description: SAVE_MEMORY_DESCRIPTION,
    inputSchema: saveMemoryJsonSchema,
  },
  search_memory: {
    description: SEARCH_MEMORY_DESCRIPTION,
    inputSchema: searchMemoryJsonSchema,
  },
  read_memory: {
    description: READ_MEMORY_DESCRIPTION,
    inputSchema: readMemoryJsonSchema,
  },
  read_pipeline_yaml: {
    description: READ_PIPELINE_YAML_DESCRIPTION,
    inputSchema: readPipelineYamlJsonSchema,
  },
  show_capabilities: {
    description: SHOW_CAPABILITIES_DESCRIPTION,
    inputSchema: showCapabilitiesJsonSchema,
  },
  show_files: {
    description: SHOW_FILES_DESCRIPTION,
    inputSchema: showFilesJsonSchema,
  },
  show_visual: {
    description: SHOW_VISUAL_DESCRIPTION,
    inputSchema: showVisualJsonSchema,
  },
  preview_visual: {
    description: PREVIEW_VISUAL_DESCRIPTION,
    inputSchema: previewVisualJsonSchema,
  },
  get_file_comments: {
    description: GET_FILE_COMMENTS_DESCRIPTION,
    inputSchema: getFileCommentsJsonSchema,
  },
  respond_to_file_comment: {
    description: RESPOND_TO_FILE_COMMENT_DESCRIPTION,
    inputSchema: respondToFileCommentJsonSchema,
  },
  search_actions: {
    description: SEARCH_ACTIONS_DESCRIPTION,
    inputSchema: searchActionsJsonSchema,
  },
  dispatch_action: {
    description: DISPATCH_ACTION_DESCRIPTION,
    inputSchema: dispatchActionJsonSchema,
  },
  search_watchers: {
    description: SEARCH_WATCHERS_DESCRIPTION,
    inputSchema: searchWatchersJsonSchema,
  },
  setup_watchers: {
    description: SETUP_WATCHERS_DESCRIPTION,
    inputSchema: setupWatchersJsonSchema,
  },
  watch_github_items: {
    description: WATCH_GITHUB_ITEMS_DESCRIPTION,
    inputSchema: watchGitHubItemsJsonSchema,
  },
  get_github_pull_request_status: {
    description: GET_GITHUB_PULL_REQUEST_STATUS_DESCRIPTION,
    inputSchema: getGitHubPullRequestStatusJsonSchema,
  },
  delete_watchers: {
    description: DELETE_WATCHERS_DESCRIPTION,
    inputSchema: deleteWatchersJsonSchema,
  },
  set_auto_archive: {
    description: SET_AUTO_ARCHIVE_DESCRIPTION,
    inputSchema: setAutoArchiveJsonSchema,
  },
  start_forked_agent: {
    description: START_FORKED_AGENT_DESCRIPTION,
    inputSchema: startSplitAgentJsonSchema,
  },
  start_branched_agent: {
    description: START_BRANCHED_AGENT_DESCRIPTION,
    inputSchema: startSplitAgentJsonSchema,
  },
  set_base_branch: {
    description: SET_BASE_BRANCH_DESCRIPTION,
    inputSchema: setBaseBranchJsonSchema,
  },
  get_code_graph_context: {
    description: GET_CODE_GRAPH_CONTEXT_DESCRIPTION,
    inputSchema: getCodeGraphContextJsonSchema,
  },
  build_or_update_code_graph: {
    description: BUILD_OR_UPDATE_CODE_GRAPH_DESCRIPTION,
    inputSchema: buildOrUpdateCodeGraphJsonSchema,
  },
  query_code_graph: {
    description: QUERY_CODE_GRAPH_DESCRIPTION,
    inputSchema: queryCodeGraphJsonSchema,
  },
  search_code_graph: {
    description: SEARCH_CODE_GRAPH_DESCRIPTION,
    inputSchema: searchCodeGraphJsonSchema,
  },
  explain_code_symbol: {
    description: EXPLAIN_CODE_SYMBOL_DESCRIPTION,
    inputSchema: explainCodeSymbolJsonSchema,
  },
  get_impact_radius: {
    description: GET_IMPACT_RADIUS_DESCRIPTION,
    inputSchema: getImpactRadiusJsonSchema,
  },
  detect_changed_symbols: {
    description: DETECT_CHANGED_SYMBOLS_DESCRIPTION,
    inputSchema: detectChangedSymbolsJsonSchema,
  },
  compare_change_impact: {
    description: COMPARE_CHANGE_IMPACT_DESCRIPTION,
    inputSchema: compareChangeImpactJsonSchema,
  },
  get_review_context: {
    description: GET_REVIEW_CONTEXT_DESCRIPTION,
    inputSchema: getReviewContextJsonSchema,
  },
  search_deferred_tools: {
    description: SEARCH_DEFERRED_TOOLS_DESCRIPTION,
    inputSchema: searchDeferredToolsJsonSchema,
  },
  load_deferred_tools: {
    description: LOAD_DEFERRED_TOOLS_DESCRIPTION,
    inputSchema: loadDeferredToolsJsonSchema,
  },
  add_ledger_entry: {
    description: ADD_LEDGER_ENTRY_DESCRIPTION,
    inputSchema: addLedgerEntryJsonSchema,
  },
  search_ledger_entries: {
    description: SEARCH_LEDGER_ENTRIES_DESCRIPTION,
    inputSchema: searchLedgerEntriesJsonSchema,
  },
  update_ledger_entry: {
    description: UPDATE_LEDGER_ENTRY_DESCRIPTION,
    inputSchema: updateLedgerEntryJsonSchema,
  },
};

function buildClaudeCanopyMcpTools(surface: CanopyInjectedToolSurface): Array<{
  canonicalKey: CanopyInjectedToolKey;
  name: string;
  description: string;
  inputSchema: JsonValue;
}> {
  return CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS[surface].map((key) => {
    const definition = CLAUDE_TERMINAL_TOOL_DEFINITIONS[key];
    if (!definition) {
      throw new Error(
        `Missing Claude ${BRAND.displayName} MCP definition for ${key}`,
      );
    }
    return {
      canonicalKey: key,
      name: CANOPY_INJECTED_TOOL_REGISTRY[key].displayName,
      description: definition.description,
      // Cowork chats cannot start chats in new worktrees.
      inputSchema:
        key === 'dispatch_action' && COWORK_TOOL_SURFACES.has(surface)
          ? coworkDispatchActionJsonSchema
          : definition.inputSchema,
    };
  });
}

const COWORK_TOOL_SURFACES: ReadonlySet<CanopyInjectedToolSurface> =
  new Set<CanopyInjectedToolSurface>([
    'native-sdk-standalone',
    'cursor-acp-standalone',
    'opencode-acp-standalone',
    'copilot-sdk-standalone',
  ]);

const CLAUDE_TERMINAL_MCP_TOOLS = buildClaudeCanopyMcpTools(
  'claude-code-terminal',
);
const CLAUDE_NATIVE_MCP_TOOLS = buildClaudeCanopyMcpTools('native-sdk');
const CLAUDE_NATIVE_STANDALONE_MCP_TOOLS = buildClaudeCanopyMcpTools(
  'native-sdk-standalone',
);
const CLAUDE_NATIVE_UI_MCP_TOOLS = buildClaudeCanopyMcpTools('native-sdk-ui');
const CLAUDE_WORKER_MCP_TOOLS = buildClaudeCanopyMcpTools('claude-worker');
const COPILOT_SDK_MCP_TOOLS = buildClaudeCanopyMcpTools('copilot-sdk');
const OPENCODE_ACP_MCP_TOOLS = buildClaudeCanopyMcpTools('opencode-acp');
const OPENCODE_ACP_STANDALONE_MCP_TOOLS = buildClaudeCanopyMcpTools(
  'opencode-acp-standalone',
);
const COPILOT_STANDALONE_MCP_TOOLS = buildClaudeCanopyMcpTools(
  'copilot-sdk-standalone',
);
const CURSOR_ACP_MCP_TOOLS = buildClaudeCanopyMcpTools('cursor-acp');
const CURSOR_ACP_STANDALONE_MCP_TOOLS = buildClaudeCanopyMcpTools(
  'cursor-acp-standalone',
);

const APP_ADVISOR_TERMINAL_TOOL_DEFINITIONS: Readonly<
  Record<
    AppAdvisorToolKey,
    {
      description: string;
      inputSchema: JsonValue;
    }
  >
> = {
  watch_command: {
    description: WATCH_COMMAND_DESCRIPTION,
    inputSchema: watchCommandJsonSchema,
  },
  set_auto_archive: {
    description: SET_AUTO_ARCHIVE_DESCRIPTION,
    inputSchema: setAutoArchiveJsonSchema,
  },
  schedule_wakeup: {
    description: SCHEDULE_WAKEUP_DESCRIPTION,
    inputSchema: scheduleWakeupJsonSchema,
  },
  ask_user_question: {
    description: ASK_USER_QUESTION_DESCRIPTION,
    inputSchema: appAdvisorAskUserQuestionJsonSchema,
  },
  get_script_output: {
    description: APP_ADVISOR_GET_SCRIPT_OUTPUT_DESCRIPTION,
    inputSchema: appAdvisorGetScriptOutputJsonSchema,
  },
  show_capabilities: {
    description: SHOW_CAPABILITIES_DESCRIPTION,
    inputSchema: showCapabilitiesJsonSchema,
  },
  show_files: {
    description: APP_ADVISOR_SHOW_FILES_DESCRIPTION,
    inputSchema: appAdvisorShowFilesJsonSchema,
  },
  get_file_comments: {
    description: APP_ADVISOR_GET_FILE_COMMENTS_DESCRIPTION,
    inputSchema: appAdvisorGetFileCommentsJsonSchema,
  },
  respond_to_file_comment: {
    description: APP_ADVISOR_RESPOND_TO_FILE_COMMENT_DESCRIPTION,
    inputSchema: appAdvisorRespondToFileCommentJsonSchema,
  },
  read_pipeline_yaml: {
    description: APP_ADVISOR_READ_PIPELINE_YAML_DESCRIPTION,
    inputSchema: appAdvisorReadPipelineYamlJsonSchema,
  },
  search_actions: {
    description: APP_ADVISOR_SEARCH_ACTIONS_DESCRIPTION,
    inputSchema: appAdvisorSearchActionsJsonSchema,
  },
  get_current_ui_state: {
    description: GET_CURRENT_UI_STATE_DESCRIPTION,
    inputSchema: getCurrentUiStateJsonSchema,
  },
  dispatch_action: {
    description: APP_ADVISOR_DISPATCH_ACTION_DESCRIPTION,
    inputSchema: appAdvisorDispatchActionJsonSchema,
  },
  get_pipeline_debug_context: {
    description: GET_PIPELINE_DEBUG_CONTEXT_DESCRIPTION,
    inputSchema: getPipelineDebugContextJsonSchema,
  },
  search_watchers: {
    description: APP_ADVISOR_SEARCH_WATCHERS_DESCRIPTION,
    inputSchema: appAdvisorSearchWatchersJsonSchema,
  },
  setup_watchers: {
    description: APP_ADVISOR_SETUP_WATCHERS_DESCRIPTION,
    inputSchema: appAdvisorSetupWatchersJsonSchema,
  },
  watch_github_items: {
    description: APP_ADVISOR_WATCH_GITHUB_ITEMS_DESCRIPTION,
    inputSchema: appAdvisorWatchGitHubItemsJsonSchema,
  },
  get_github_pull_request_status: {
    description: APP_ADVISOR_GET_GITHUB_PULL_REQUEST_STATUS_DESCRIPTION,
    inputSchema: getGitHubPullRequestStatusJsonSchema,
  },
  start_forked_agent: {
    description: APP_ADVISOR_START_FORKED_AGENT_DESCRIPTION,
    inputSchema: startSplitAgentJsonSchema,
  },
  search_deferred_tools: {
    description: SEARCH_DEFERRED_TOOLS_DESCRIPTION,
    inputSchema: searchDeferredToolsJsonSchema,
  },
  load_deferred_tools: {
    description: LOAD_DEFERRED_TOOLS_DESCRIPTION,
    inputSchema: loadDeferredToolsJsonSchema,
  },
  // Listed only on a route whose session has Ledger tools.
  add_ledger_entry: {
    description: APP_ADVISOR_ADD_LEDGER_ENTRY_DESCRIPTION,
    inputSchema: addLedgerEntryJsonSchema,
  },
  search_ledger_entries: {
    description: APP_ADVISOR_SEARCH_LEDGER_ENTRIES_DESCRIPTION,
    inputSchema: searchLedgerEntriesJsonSchema,
  },
  update_ledger_entry: {
    description: APP_ADVISOR_UPDATE_LEDGER_ENTRY_DESCRIPTION,
    inputSchema: updateLedgerEntryJsonSchema,
  },
};

const APP_ADVISOR_TERMINAL_MCP_TOOLS = APP_ADVISOR_TOOL_ENTRIES.map((entry) => {
  const definition = APP_ADVISOR_TERMINAL_TOOL_DEFINITIONS[entry.canonicalKey];
  return {
    canonicalKey: entry.canonicalKey,
    name: entry.displayName,
    description: definition.description,
    inputSchema: definition.inputSchema,
  };
});
const APP_ADVISOR_MAIN_MCP_TOOLS = APP_ADVISOR_TERMINAL_MCP_TOOLS.filter(
  (tool) => tool.canonicalKey !== 'ask_user_question',
);
const APP_ADVISOR_UI_MCP_TOOLS = APP_ADVISOR_TERMINAL_MCP_TOOLS.filter(
  (tool) => tool.canonicalKey === 'ask_user_question',
);

const PIPELINE_EDITOR_TERMINAL_TOOL_DEFINITIONS: Readonly<
  Record<
    PipelineEditorToolKey,
    {
      description: string;
      inputSchema: JsonValue;
    }
  >
> = {
  ask_user_question: {
    description: ASK_USER_QUESTION_DESCRIPTION,
    inputSchema: pipelineEditorAskUserQuestionJsonSchema,
  },
  pipeline_list: {
    description: PIPELINE_LIST_DESCRIPTION,
    inputSchema: pipelineEditorEmptyArgsJsonSchema,
  },
  pipeline_open: {
    description: PIPELINE_OPEN_DESCRIPTION,
    inputSchema: pipelineOpenJsonSchema,
  },
  pipeline_create: {
    description: PIPELINE_CREATE_DESCRIPTION,
    inputSchema: pipelineEditorEmptyArgsJsonSchema,
  },
  pipeline_get_current: {
    description: PIPELINE_GET_CURRENT_DESCRIPTION,
    inputSchema: pipelineEditorEmptyArgsJsonSchema,
  },
  pipeline_set_yaml: {
    description: PIPELINE_SET_YAML_DESCRIPTION,
    inputSchema: pipelineSetYamlJsonSchema,
  },
  pipeline_save: {
    description: PIPELINE_SAVE_DESCRIPTION,
    inputSchema: pipelineEditorEmptyArgsJsonSchema,
  },
  pipeline_get_action_definition: {
    description: PIPELINE_GET_ACTION_DEFINITION_DESCRIPTION,
    inputSchema: pipelineGetActionDefinitionJsonSchema,
  },
  navigation_to_list: {
    description: NAVIGATION_TO_LIST_DESCRIPTION,
    inputSchema: pipelineEditorEmptyArgsJsonSchema,
  },
  search_deferred_tools: {
    description: SEARCH_DEFERRED_TOOLS_DESCRIPTION,
    inputSchema: searchDeferredToolsJsonSchema,
  },
  load_deferred_tools: {
    description: LOAD_DEFERRED_TOOLS_DESCRIPTION,
    inputSchema: loadDeferredToolsJsonSchema,
  },
};

const PIPELINE_EDITOR_TERMINAL_MCP_TOOLS = PIPELINE_EDITOR_TOOL_ENTRIES.map(
  (entry) => {
    const definition =
      PIPELINE_EDITOR_TERMINAL_TOOL_DEFINITIONS[entry.canonicalKey];
    return {
      canonicalKey: entry.canonicalKey,
      name: entry.displayName,
      description: definition.description,
      inputSchema: definition.inputSchema,
    };
  },
);
const PIPELINE_EDITOR_MAIN_MCP_TOOLS =
  PIPELINE_EDITOR_TERMINAL_MCP_TOOLS.filter(
    (tool) => tool.canonicalKey !== 'ask_user_question',
  );
const PIPELINE_EDITOR_UI_MCP_TOOLS = PIPELINE_EDITOR_TERMINAL_MCP_TOOLS.filter(
  (tool) => tool.canonicalKey === 'ask_user_question',
);

class RequestBodyTooLargeError extends Error {
  constructor() {
    super('Request body exceeds maximum size');
    this.name = 'RequestBodyTooLargeError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The tool_use ID the bundled Claude CLI sends in a tools/call `_meta`. */
function getClaudeToolUseId(meta: unknown): string | undefined {
  const toolUseId = isRecord(meta) ? meta['claudecode/toolUseId'] : undefined;
  return typeof toolUseId === 'string' && toolUseId.length > 0
    ? toolUseId
    : undefined;
}

function isMcpProxyStatus(value: unknown): value is McpProxyStatus {
  return value === 'stopped' || value === 'running' || value === 'error';
}

function isMcpServerFile(value: unknown): value is McpServerFile {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isRecord(value.server) &&
    isRecord(value.server.definition) &&
    Array.isArray(value.server.configs)
  );
}

function getHeaderValue(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name];
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return undefined;
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      throw new RequestBodyTooLargeError();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
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

function jsonRpcError(
  id: unknown,
  code: number,
  message: string,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message },
  };
}

// Error text can carry paths and workspace ids, so it goes to the log, never to the model.
function jsonRpcInternalError(
  id: unknown,
  error: unknown,
): Record<string, unknown> {
  logMainProcessError('Injected MCP tool call failed', error);
  return jsonRpcError(id, -32603, 'Internal error');
}

function getJsonRpcId(payload: unknown): unknown {
  return isRecord(payload) && 'id' in payload ? payload.id : null;
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

function toMcpToolResult(result: CanopyInjectedToolTextResult): {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
} {
  const imageMatch = result.imageDataUrl?.match(
    /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/,
  );
  const response = {
    content: [
      { type: 'text' as const, text: result.text },
      ...(imageMatch
        ? [
            {
              type: 'image' as const,
              mimeType: imageMatch[1],
              data: imageMatch[2],
            },
          ]
        : []),
    ],
  };
  return result.isError ? { ...response, isError: true } : response;
}

function getClaudeCanopyToolSurface(
  route: CanopyWorktreeSessionRoute,
): CanopyInjectedToolSurface {
  return route.toolSurface ?? 'claude-code-terminal';
}

function getClaudeCanopyToolsForSurface(
  surface: CanopyInjectedToolSurface,
): typeof CLAUDE_TERMINAL_MCP_TOOLS {
  switch (surface) {
    case 'native-sdk':
      return CLAUDE_NATIVE_MCP_TOOLS;
    case 'native-sdk-standalone':
      return CLAUDE_NATIVE_STANDALONE_MCP_TOOLS;
    case 'native-sdk-ui':
      return CLAUDE_NATIVE_UI_MCP_TOOLS;
    case 'copilot-sdk':
      return COPILOT_SDK_MCP_TOOLS;
    case 'opencode-acp':
      return OPENCODE_ACP_MCP_TOOLS;
    case 'opencode-acp-standalone':
      return OPENCODE_ACP_STANDALONE_MCP_TOOLS;
    case 'copilot-sdk-standalone':
      return COPILOT_STANDALONE_MCP_TOOLS;
    case 'cursor-acp':
      return CURSOR_ACP_MCP_TOOLS;
    case 'cursor-acp-standalone':
      return CURSOR_ACP_STANDALONE_MCP_TOOLS;
    default:
      return CLAUDE_TERMINAL_MCP_TOOLS;
  }
}

/** One projection for advertised MCP schemas and persisted capability snapshots. */
function getCanopyRouteTools(
  route: CanopyWorktreeSessionRoute,
  uiServer: boolean,
): readonly { name: string; description: string; inputSchema: JsonValue }[] {
  const effectiveSurface = uiServer
    ? 'native-sdk-ui'
    : getClaudeCanopyToolSurface(route);
  // Cursor and Copilot omit deferred loaders when chat policy disables them.
  // Claude and Codex retain the schemas and return guidance for disallowed calls.
  const advertiseDeferredLoaders = !(
    (route.providerType === 'cursor' || route.providerType === 'copilot') &&
    route.deferredToolsAllowed === false
  );
  const baseTools =
    route.assistantMode === 'app-advisor'
      ? uiServer
        ? APP_ADVISOR_UI_MCP_TOOLS
        : APP_ADVISOR_MAIN_MCP_TOOLS.filter((tool) => {
            const key = getClaudeTerminalAppAdvisorToolKey(tool.name);
            // The Ledger tools only for a session that passed the Ledger
            // exposure gate when it started.
            if (
              key !== null &&
              isAppAdvisorLedgerToolKey(key) &&
              route.ledgerTools === undefined
            ) {
              return false;
            }
            // Cursor cannot carry provider context into a fork, and a
            // managed terminal runtime is built without the fork.
            if (
              key === 'start_forked_agent' &&
              (route.providerType === 'cursor' ||
                !route.appAdvisorRuntime?.startForkedAgent)
            ) {
              return false;
            }
            if (advertiseDeferredLoaders) return true;
            return (
              key !== 'search_deferred_tools' && key !== 'load_deferred_tools'
            );
          })
      : route.assistantMode === 'pipeline-editor'
        ? uiServer
          ? PIPELINE_EDITOR_UI_MCP_TOOLS
          : PIPELINE_EDITOR_MAIN_MCP_TOOLS
        : getClaudeCanopyToolsForSurface(effectiveSurface);
  const codeGraphToolsAdvertised = route.codeGraphToolsAdvertised !== false;
  const ledgerToolsAdvertised = route.ledgerTools !== undefined;
  const tools: Array<{
    name: string;
    description: string;
    inputSchema: JsonValue;
  }> = baseTools
    .filter((tool) => {
      if (
        (tool.name === CANOPY_INJECTED_TOOL_REGISTRY.show_visual.displayName ||
          tool.name ===
            CANOPY_INJECTED_TOOL_REGISTRY.preview_visual.displayName) &&
        !chatVisualsEligible({
          providerType: route.providerType,
          surface: effectiveSurface,
          assistantMode: route.assistantMode,
          key:
            tool.name ===
            CANOPY_INJECTED_TOOL_REGISTRY.preview_visual.displayName
              ? 'preview_visual'
              : 'show_visual',
        })
      )
        return false;
      const canonicalKey = getCanonicalCanopyToolKey(tool.name);
      if (
        route.providerType === 'opencode' &&
        route.deferredToolsAllowed === false &&
        (canonicalKey === 'search_deferred_tools' ||
          canonicalKey === 'load_deferred_tools')
      )
        return false;
      if (canonicalKey === null) {
        return true;
      }
      if (
        !advertiseDeferredLoaders &&
        (canonicalKey === 'search_deferred_tools' ||
          canonicalKey === 'load_deferred_tools')
      ) {
        return false;
      }
      if (
        !codeGraphToolsAdvertised &&
        isCodeGraphInjectedToolKey(canonicalKey)
      ) {
        return false;
      }
      // The Ledger tools are allowlisted on the native chat surfaces but
      // advertised only to a session that passed the exposure gate.
      return ledgerToolsAdvertised || !isLedgerInjectedToolKey(canonicalKey);
    })
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  if (
    route.assistantMode !== 'app-advisor' &&
    !uiServer &&
    route.isCodeReview
  ) {
    if (route.respondToReviewComment) {
      tools.push({
        name: RESPOND_TO_COMMENT_TOOL_NAME,
        description: RESPOND_TO_REVIEW_COMMENT_DESCRIPTION,
        inputSchema: respondToCommentJsonSchema,
      });
    }
    if (route.getReviewCommentThread) {
      tools.push({
        name: GET_REVIEW_COMMENTS_TOOL_NAME,
        description: GET_REVIEW_COMMENTS_DESCRIPTION,
        inputSchema: getReviewCommentsJsonSchema,
      });
    }
  }
  if (!uiServer && route.managedDelegation)
    tools.push(...route.managedDelegation.tools);
  return route.managedDelegation?.exclusive
    ? uiServer
      ? []
      : route.managedDelegation.tools
    : tools;
}

function getClaudeCanopyToolKey(
  toolName: unknown,
  surface: CanopyInjectedToolSurface,
): CanopyInjectedToolKey | null {
  const canonicalKey =
    typeof toolName === 'string'
      ? // MCP calls use the advertised short name. Resolve it within this
        // route, not as a global transcript alias: ScheduleWakeup is also a
        // distinct provider-native tool outside this authenticated surface.
        (CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS[surface].find(
          (key) => CANOPY_INJECTED_TOOL_REGISTRY[key].displayName === toolName,
        ) ?? getCanonicalCanopyToolKey(toolName))
      : null;
  if (!canonicalKey) {
    return null;
  }
  return CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS[surface].includes(canonicalKey)
    ? canonicalKey
    : null;
}

function getClaudeTerminalAppAdvisorToolKey(
  toolName: unknown,
): AppAdvisorToolKey | null {
  if (typeof toolName !== 'string') {
    return null;
  }
  const entry = APP_ADVISOR_TOOL_ENTRIES.find(
    (candidate) =>
      candidate.displayName === toolName ||
      candidate.claudeToolName === toolName ||
      candidate.codexToolName === toolName,
  );
  return entry?.canonicalKey ?? null;
}

function getClaudeTerminalPipelineEditorToolKey(
  toolName: unknown,
): PipelineEditorToolKey | null {
  if (typeof toolName !== 'string') {
    return null;
  }
  const entry = PIPELINE_EDITOR_TOOL_ENTRIES.find(
    (candidate) =>
      candidate.displayName === toolName ||
      candidate.claudeToolName === toolName ||
      candidate.codexToolName === toolName,
  );
  return entry?.canonicalKey ?? null;
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

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
  });
  res.end(JSON.stringify(payload));
}

function writePayloadTooLargeJsonRpc(res: ServerResponse): void {
  writeJson(res, 413, jsonRpcError(null, -32013, 'Payload too large'));
}

function createProxyRouteId(): string {
  return randomBytes(16).toString('base64url');
}

async function loadMcpDefinitionAndConfig(route: McpProxyRoute): Promise<{
  definition: McpServerDefinitionData;
  config: McpServerConfigData;
} | null> {
  if (route.oauthDefinition && route.oauthConfig) {
    return {
      definition: route.oauthDefinition,
      config: route.oauthConfig,
    };
  }

  try {
    const parsed: unknown = JSON.parse(
      await readFile(getMcpServerFilePath(route.serverId), 'utf8'),
    );
    if (!isMcpServerFile(parsed)) {
      return null;
    }

    const config = parsed.server.configs.find(
      (entry) =>
        isRecord(entry) &&
        typeof entry.id === 'string' &&
        entry.id === route.configId,
    );
    if (!config) {
      return null;
    }

    return {
      definition: parsed.server.definition,
      config,
    };
  } catch {
    return null;
  }
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

async function buildForwardHeaders(
  req: IncomingMessage,
  route: InternalMcpProxyRoute,
  authorizationToken: string | null,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    host: route.parsedUpstream.host,
  };

  for (const headerName of Array.from(SAFE_FORWARD_HEADERS.values())) {
    const value = getHeaderValue(req.headers, headerName);
    if (value) {
      headers[headerName] = value;
    }
  }

  for (const [name, value] of Object.entries(route.headers)) {
    headers[name] = value;
  }

  if (route.authSupplier === 'canopy-cloud') {
    const credentials = await resolveCanopyCloudCredentialContext();
    if (!credentials.apiKey)
      throw new CanopyCloudClientError(
        'missing-api-key',
        'Sign in to use account MCP connections.',
      );
    const base = new URL(credentials.baseUrl);
    if (
      route.parsedUpstream.origin !== base.origin ||
      !route.parsedUpstream.pathname.startsWith(
        `${base.pathname.replace(/\/$/, '')}/api/v1/mcp-proxy/`,
      )
    ) {
      throw new Error(
        'Account MCP route no longer belongs to the configured cloud.',
      );
    }
    for (const name of Object.keys(headers))
      if (name.toLowerCase() === 'authorization') delete headers[name];
    headers.Authorization = `Bearer ${credentials.apiKey}`;
  } else if (authorizationToken) {
    headers.Authorization = `Bearer ${authorizationToken}`;
  }

  return headers;
}

function copyResponseHeaders(
  upstream: IncomingMessage,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const name of Array.from(SAFE_RESPONSE_HEADERS.values())) {
    const value = upstream.headers[name];
    if (typeof value === 'string' || Array.isArray(value)) {
      headers[name] = value;
    }
  }
  return headers;
}

export class McpHttpProxyService {
  private server: Server | null = null;
  private startPromise: Promise<void> | null = null;
  private currentPort: number | null = null;
  private sockets = new Set<Socket>();
  private routes = new Map<string, InternalMcpProxyRoute>();
  private routesBySession = new Map<string, Set<string>>();
  private readonly sessionToolCallGates = new Map<
    string,
    McpProxiedToolCallGate
  >();
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
        if (this.routes.size > 0) {
          return;
        }
        await this.updatePort(resolvedPort);
      }
      return;
    }
    if (this.server) {
      if (this.routes.size > 0) {
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
    if (route.requireToolCallGate && route.sessionId === null) {
      return Promise.reject(new Error('A gated MCP route requires a session.'));
    }
    const parsedUpstream = new URL(route.upstreamUrl);
    if (
      parsedUpstream.protocol !== 'http:' &&
      parsedUpstream.protocol !== 'https:'
    ) {
      return Promise.reject(
        new Error('MCP proxy only supports HTTP and HTTPS upstream URLs.'),
      );
    }

    const routeId = createProxyRouteId();
    const previousRoute = this.routes.get(routeId);
    if (previousRoute) {
      this.removeRouteFromSessionIndex(routeId, previousRoute.sessionId);
    }
    const fullRoute: InternalMcpProxyRoute = {
      routeId,
      sessionId: route.sessionId,
      serverId: route.serverId,
      configId: route.configId,
      displayName: route.displayName,
      upstreamUrl: route.upstreamUrl,
      headers: route.headers,
      oauthEnabled:
        route.authSupplier === 'canopy-cloud' ? false : route.oauthEnabled,
      authSupplier: route.authSupplier ?? 'oauth',
      reauthRequired: false,
      oauthRequired: route.oauthRequired,
      oauthDefinition: route.oauthDefinition,
      oauthConfig: route.oauthConfig,
      ...(route.requireToolCallGate ? { requireToolCallGate: true } : {}),
      ...(route.routeKey ? { routeKey: route.routeKey } : {}),
      parsedUpstream,
    };
    this.routes.set(routeId, fullRoute);
    if (fullRoute.authSupplier === 'canopy-cloud')
      registerAccountMcpRouteStatus(
        routeId,
        route.serverId,
        route.configId,
        parsedUpstream.pathname.split('/').pop() ?? '',
      );

    if (route.sessionId !== null) {
      const existing = this.routesBySession.get(route.sessionId) ?? new Set();
      existing.add(routeId);
      this.routesBySession.set(route.sessionId, existing);
    }

    return Promise.resolve(routeId);
  }

  getRouteStatus(routeId: string): { reauthRequired: boolean } | undefined {
    const route = this.routes.get(routeId);
    return route
      ? { reauthRequired: route.reauthRequired === true }
      : undefined;
  }

  registerMcpProxyRoute(route: McpProxyRouteRegistration): Promise<string> {
    return this.registerRoute(route);
  }

  private removeRouteFromSessionIndex(
    routeId: string,
    sessionId: string | null,
  ): void {
    if (sessionId === null) {
      return;
    }

    const sessionRoutes = this.routesBySession.get(sessionId);
    if (!sessionRoutes) {
      return;
    }

    sessionRoutes.delete(routeId);
    if (sessionRoutes.size === 0) {
      this.routesBySession.delete(sessionId);
    }
  }

  unregisterRoute(routeId: string): void {
    const route = this.routes.get(routeId);
    if (!route) {
      return;
    }

    this.routes.delete(routeId);
    removeAccountMcpRouteStatus(routeId);
    this.removeRouteFromSessionIndex(routeId, route.sessionId);
  }

  unregisterMcpProxyRoute(routeId: string): void {
    this.unregisterRoute(routeId);
  }

  /** Installs (or replaces) the session's proxied tool-call gate. */
  setSessionToolCallGate(
    sessionId: string,
    gate: McpProxiedToolCallGate,
  ): void {
    this.sessionToolCallGates.set(sessionId, gate);
  }

  unregisterRoutesForSession(sessionId: string): void {
    // Drop any auth failure this owner published but never claimed, and
    // its tool-name correlation cache (CAN-1814), unconditionally — a
    // session can end without routes still registered (e.g. already
    // unregistered individually) while either process-global registry
    // still holds an entry with no other eviction path.
    clearPendingAuthFailures(sessionId);
    clearAuthFailureToolNameCache(sessionId);
    this.sessionToolCallGates.delete(sessionId);

    const routeIds = this.routesBySession.get(sessionId);
    if (!routeIds) {
      return;
    }

    for (const routeId of Array.from(routeIds.values())) {
      this.unregisterRoute(routeId);
    }
  }

  unregisterMcpProxyRoutesForSession(sessionId: string): void {
    this.unregisterRoutesForSession(sessionId);
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
    if (this.currentPort === null) {
      return [];
    }
    const authorityIds: string[] = [];
    for (const [serverName, value] of Object.entries(mcpServers)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        continue;
      }
      const url: unknown = Reflect.get(value, 'url');
      if (typeof url !== 'string') {
        continue;
      }
      for (const [routeId, route] of Array.from(this.routes.entries())) {
        if (route.routeKey && this.getProxyUrl(routeId) === url) {
          authorityIds.push(`${serverName}:${route.routeKey}`);
          break;
        }
      }
    }
    return authorityIds.sort();
  }

  /** Stable config identities without persisting credentials or ephemeral proxy addresses. */
  getMcpCapabilityDigests(
    mcpServers: Record<string, unknown>,
  ): Record<string, string> {
    return Object.fromEntries(
      Object.entries(mcpServers).map(([name, value]) => {
        const config = isRecord(value) ? value : {};
        const route =
          this.currentPort !== null && typeof config.url === 'string'
            ? Array.from(this.routes.entries()).find(
                ([id]) => this.getProxyUrl(id) === config.url,
              )?.[1]
            : undefined;
        // These fields are an allowlist, not a recursive hash of configuration.
        // Arbitrary headers/env/args, OAuth records and URL path/query/userinfo
        // can contain credentials. Even their hashes must never be persisted.
        const endpoint = route?.upstreamUrl ?? config.url;
        let origin: string | undefined;
        if (typeof endpoint === 'string') {
          try {
            origin = new URL(endpoint).origin;
          } catch {
            /* Invalid URLs have no public origin. */
          }
        }
        const headers = route?.headers ?? config.headers;
        const manifest = {
          type: typeof config.type === 'string' ? config.type : undefined,
          command:
            typeof config.command === 'string' ? config.command : undefined,
          origin,
          tools: Array.isArray(config.tools)
            ? config.tools
                .filter((tool): tool is string => typeof tool === 'string')
                .sort()
            : undefined,
          headerNames: isRecord(headers)
            ? Object.keys(headers)
                .map((key) => key.toLowerCase())
                .sort()
            : [],
          environmentNames: isRecord(config.env)
            ? Object.keys(config.env).sort()
            : [],
          authority: route
            ? {
                serverId: route.serverId,
                configId: route.configId,
                oauthEnabled: route.oauthEnabled,
                oauthRequired: route.oauthRequired,
                authSupplier: route.authSupplier,
              }
            : undefined,
        };
        return [name, createCopilotCapabilitySnapshot(manifest).digest];
      }),
    );
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
    const routeIds = this.routesBySession.get(sessionId);
    if (!routeIds) return undefined;
    for (const routeId of Array.from(routeIds)) {
      const route = this.routes.get(routeId);
      if (route?.serverId === serverId && route.configId === configId) {
        return { displayName: route.displayName };
      }
    }
    return undefined;
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
    for (const routeId of Array.from(this.routes.keys()))
      removeAccountMcpRouteStatus(routeId);
    this.routes.clear();
    this.routesBySession.clear();
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
        routeCount: this.routes.size + this.worktreeSessionRoutes.size,
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

    const route = this.routes.get(routeId);
    if (!route) {
      res.writeHead(404);
      res.end();
      return;
    }

    if (
      req.method !== 'GET' &&
      req.method !== 'POST' &&
      req.method !== 'DELETE'
    ) {
      res.writeHead(405, { Allow: 'GET, POST, DELETE' });
      res.end();
      return;
    }

    await this.forwardRequest(req, res, route);
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
      if (
        route.assistantMode !== 'app-advisor' &&
        getClaudeCanopyToolSurface(route) === 'claude-worker'
      ) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: [
              ...(route.reportStructuredResultSchema
                ? [
                    {
                      name: REPORT_STRUCTURED_RESULT_TOOL_NAME,
                      description: REPORT_STRUCTURED_RESULT_DESCRIPTION,
                      inputSchema:
                        route.reportStructuredResultSchema as JsonValue,
                    },
                  ]
                : []),
              ...CLAUDE_WORKER_MCP_TOOLS.filter((tool) =>
                isClaudeWorkerToolExposed(
                  tool.canonicalKey,
                  route.workerMemoryToolExposure ?? 'none',
                  route.ledgerTools !== undefined,
                ),
              ).map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
              })),
            ],
          },
        };
      }
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: getCanopyRouteTools(route, uiServer) },
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

  /**
   * Answers a proxied `tools/call` the session's gate refuses; batches that
   * include a tool call are refused outright rather than partially forwarded.
   * Returns `'forward'` when the request should continue upstream unchanged.
   */
  private async answerGatedToolCall(
    gate: McpProxiedToolCallGate,
    route: InternalMcpProxyRoute,
    body: string,
    res: ServerResponse,
  ): Promise<'answered' | 'forward'> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return 'forward';
    }
    const isToolCall = (value: unknown): value is Record<string, unknown> =>
      isRecord(value) && value.method === 'tools/call';
    if (Array.isArray(parsed)) {
      if (!parsed.some(isToolCall)) return 'forward';
      writeJson(res, 200, {
        jsonrpc: '2.0',
        error: {
          code: -32600,
          message: 'Batched tool calls are not accepted on this route.',
        },
        id: null,
      });
      return 'answered';
    }
    if (!isToolCall(parsed)) return 'forward';
    const id =
      typeof parsed.id === 'string' || typeof parsed.id === 'number'
        ? parsed.id
        : null;
    const params = isRecord(parsed.params) ? parsed.params : {};
    const tool = typeof params.name === 'string' ? params.name : null;
    const args = isRecord(params.arguments) ? params.arguments : {};
    let allowed = false;
    if (tool !== null) {
      try {
        allowed = await gate({
          proxyUrl: this.getProxyUrl(route.routeId),
          tool,
          args,
          ...(id !== null ? { requestId: String(id) } : {}),
        });
      } catch (error) {
        logMainProcessError('MCP proxied tool-call gate failed', error);
      }
    }
    if (allowed) return 'forward';
    writeJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: `${tool ?? 'Tool'} was denied.` }],
        isError: true,
      },
    });
    return 'answered';
  }

  private async forwardRequest(
    req: IncomingMessage,
    res: ServerResponse,
    route: InternalMcpProxyRoute,
  ): Promise<void> {
    const selectedRouteActive = (gate?: McpProxiedToolCallGate): boolean =>
      !route.requireToolCallGate ||
      (this.routes.get(route.routeId) === route &&
        route.sessionId !== null &&
        (gate
          ? this.sessionToolCallGates.get(route.sessionId) === gate
          : this.sessionToolCallGates.has(route.sessionId)));
    const selectedRouteUnavailable = (): void => {
      writeJson(res, 200, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Selected MCP route is unavailable.' },
      });
    };
    if (!selectedRouteActive()) {
      selectedRouteUnavailable();
      return;
    }
    let authorizationToken: string | null = null;
    let loadedOAuth: {
      definition: McpServerDefinitionData;
      config: McpServerConfigData;
    } | null = null;
    if (route.authSupplier !== 'canopy-cloud' && route.oauthEnabled) {
      loadedOAuth = await loadMcpDefinitionAndConfig(route);
      if (loadedOAuth) {
        try {
          authorizationToken = await getValidMcpAccessToken(
            loadedOAuth.definition,
            loadedOAuth.config,
          );
        } catch {
          res.setHeader('Retry-After', '30');
          writeJson(res, 503, {
            jsonrpc: '2.0',
            error: {
              code: -32002,
              message:
                'MCP authorization is temporarily unavailable. Try again shortly.',
            },
            id: null,
          });
          return;
        }
      }

      if (!authorizationToken && route.oauthRequired !== false) {
        writeJson(res, 401, {
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message: 'MCP server authorization required',
          },
          id: null,
        });
        return;
      }
    }

    // A session that owns this route may gate tool calls at execution time;
    // its POST bodies are read here so the JSON-RPC method can be inspected.
    const gate =
      route.sessionId !== null
        ? this.sessionToolCallGates.get(route.sessionId)
        : undefined;
    if (!selectedRouteActive(gate)) {
      selectedRouteUnavailable();
      return;
    }
    let bufferedBody: string | null = null;
    if (gate && req.method === 'POST') {
      try {
        bufferedBody = await readRequestBody(req);
      } catch (error) {
        writeJson(res, error instanceof RequestBodyTooLargeError ? 413 : 400, {
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Request body could not be read.' },
          id: null,
        });
        return;
      }
      if (
        (await this.answerGatedToolCall(gate, route, bufferedBody, res)) ===
        'answered'
      )
        return;
    }

    if (!selectedRouteActive(gate)) {
      selectedRouteUnavailable();
      return;
    }

    let forwardHeaders: Record<string, string>;
    try {
      forwardHeaders = await buildForwardHeaders(
        req,
        route,
        authorizationToken,
      );
    } catch (error: unknown) {
      const signedOut =
        error instanceof CanopyCloudClientError &&
        error.code === 'missing-api-key';
      if (signedOut) {
        route.reauthRequired = true;
        setAccountMcpRouteReauthRequired(route.routeId, true);
      }
      writeJson(res, signedOut ? 401 : 502, {
        error: signedOut ? 'mcp_reauth_required' : 'account_route_unavailable',
      });
      return;
    }
    if (!selectedRouteActive(gate)) {
      selectedRouteUnavailable();
      return;
    }

    const upstreamPath = `${route.parsedUpstream.pathname}${route.parsedUpstream.search}`;
    const options: RequestOptions = {
      protocol: route.parsedUpstream.protocol,
      hostname: route.parsedUpstream.hostname,
      port: route.parsedUpstream.port,
      method: req.method,
      path: upstreamPath,
      headers: forwardHeaders,
    };
    const requestFn =
      route.parsedUpstream.protocol === 'https:' ? httpsRequest : httpRequest;

    const upstreamReq = requestFn(options, (upstreamRes) => {
      const upstreamStatusCode = upstreamRes.statusCode;
      if (route.authSupplier === 'canopy-cloud') {
        if (upstreamStatusCode === 401) {
          // Observe a bounded copy while piping the original bytes and headers.
          const chunks: Buffer[] = [];
          let size = 0;
          upstreamRes.on('data', (chunk: Buffer): void => {
            size += chunk.length;
            if (size <= MAX_REQUEST_BODY_BYTES) chunks.push(chunk);
          });
          upstreamRes.on('end', (): void => {
            if (size > MAX_REQUEST_BODY_BYTES) return;
            try {
              const body: unknown = JSON.parse(
                Buffer.concat(chunks).toString('utf8'),
              );
              if (isRecord(body) && body.error === 'mcp_reauth_required') {
                route.reauthRequired = true;
                setAccountMcpRouteReauthRequired(route.routeId, true);
              }
            } catch {
              /* Non-JSON 401 responses are forwarded too. */
            }
          });
        } else if (
          upstreamStatusCode &&
          upstreamStatusCode >= 200 &&
          upstreamStatusCode < 300
        ) {
          route.reauthRequired = false;
          setAccountMcpRouteReauthRequired(route.routeId, false);
        }
      }
      let invalidation: Promise<void> | undefined;
      if (
        authorizationToken &&
        loadedOAuth &&
        (upstreamStatusCode === 401 || upstreamStatusCode === 403)
      ) {
        const diagnostic = `OAuth token was rejected by the upstream MCP server (HTTP ${String(
          upstreamStatusCode,
        )}).`;
        if (upstreamStatusCode === 401) {
          invalidation = invalidateMcpOAuthAccessToken(
            loadedOAuth.definition.id,
            loadedOAuth.config.id,
            authorizationToken,
            route.upstreamUrl,
          ).catch((error: unknown) =>
            logMainProcessError('MCP token invalidation failed', error),
          );
        }
        // Publish for transcript attachment. A route with no owning session
        // (for example a settings-surface health check) has no turn to
        // attach to, so it is intentionally skipped here while still
        // recording the error above.
        if (route.sessionId) {
          const failure = classifyMcpAuthFailure({
            serverId: loadedOAuth.definition.id,
            configId: loadedOAuth.config.id,
            displayName: route.displayName,
            statusCode: upstreamStatusCode,
            diagnostic,
          });
          if (failure) {
            recordPendingMcpAuthFailure(route.sessionId, failure);
          }
        }
      }
      const forwardResponse = (): void => {
        if (res.destroyed) {
          upstreamRes.destroy();
          return;
        }
        res.writeHead(
          upstreamRes.statusCode ?? 502,
          upstreamRes.statusMessage,
          copyResponseHeaders(upstreamRes),
        );
        upstreamRes.pipe(res);
      };
      // Persist the rejection before the caller can retry the failed request.
      if (invalidation) void invalidation.then(forwardResponse);
      else forwardResponse();
    });

    upstreamReq.on('error', (error: Error) => {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      writeJson(res, 502, {
        error: 'MCP proxy upstream request failed',
        message: error.message,
      });
    });

    if (bufferedBody !== null) upstreamReq.end(bufferedBody);
    else req.pipe(upstreamReq);
  }
}

let service: McpHttpProxyService | null = null;

export function getMcpHttpProxyService(): McpHttpProxyService {
  if (!service) {
    service = new McpHttpProxyService();
  }
  return service;
}
