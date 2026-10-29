import {
  detectClaudeHostedNoBillingSource,
  hasClaudeProxyFailureEvidence,
} from '@canopy/desktop-shared/portal/provider-usage-limit';
import {
  isAiCreditsFailureEventShape,
  readClaudeApiErrorStatus,
} from '@canopy/agent-transcript';
import { withProxyFailureRestored } from './ai-credits-proxy-failure-restore';
import { withClaudeAiCreditsFallbackError } from './claude-ai-credits-fallback-error';
import { normalizeClaudeMaxTurns } from '@canopy/desktop-shared/constants/preferences';
import { SkillUsageTracker } from './skill-usage-tracker';
import type { UUID } from 'node:crypto';
import {
  query as claudeQuery,
  type CanUseTool,
  type HookInput,
  type HookJSONOutput,
  type PermissionResult,
  type Query,
  type Options as QueryOptions,
  type McpServerConfig,
  type SpawnOptions,
  type SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';
import { BRAND } from '@canopy/brand/current';
import {
  APP_ADVISOR_TOOL_REGISTRY,
  getAppAdvisorLedgerToolNames,
} from '@canopy/desktop-shared/lib/app-advisor-tools';
import { isClaudeChainUuid } from '@canopy/desktop-shared/lib/claude-fork-resume-point';
import { brandEnvName } from '@canopy/desktop-shared/brand/env';
import type { BrowserWindow } from 'electron';
import { managedDelegationEnabled } from './delegation/gate';
import type { ManagedDelegationSession } from './delegation/service';
import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { logMainProcessError } from '../lib/main-process-logging';
import {
  ClaudeInputDelivery,
  withDeliveryDeadline,
} from './claude-input-delivery';
import type {
  AgentProvider,
  AgentSession,
  AgentSessionOptions,
  AgentSessionSendOptions,
} from './types';
import {
  buildClaudeProxyEnv,
  buildBrokeredOrgGatewayClaudeEnv,
  resolveSessionAiCreditsAttribution,
  emitAiCreditsRoutingStatus,
  emitAiCreditsUsageLimitReached,
  emitAiCreditsNoBillingSource,
  getAiCreditsRoutingContext,
  hasUserSuppliedProviderCredential,
  isAiCreditsChosenOverAccountProxy,
  resolveAiCreditsRoutingAttempt,
  resolveGatewayModelEntry,
  resolveOrgGatewayCredential,
  markOrgGatewayCredentialRejected,
} from './ai-credits-routing';
import { captureSessionWorkOwner, resolveSessionWorkOwner } from './work-owner';
import { resolveAccountProxySessionRoute } from '../account-proxy/routing';
import { watchAccountProxySwitches } from '../account-proxy/switch-events';
import { getCodexGatewayProxyService } from './codex-gateway-proxy-service';
import { checkModelGatewayRoute } from '../lib/model-gateway-state';
import { getMockLlmOrigin } from '../lib/e2e-mock-control-plane';
import { isUnavailableModelSelection } from '@canopy/desktop-shared/lib/gateway-model-availability';
import {
  isProviderNativelyAuthenticated,
  isProviderNativelyAuthenticatedForRouting,
} from '../auth/provider-auth-state';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { isCodeGraphAvailableForWorkspace } from '../lib/code-graph-availability';
import { buildCodeGraphAvailabilityPrompt } from '../lib/code-graph-availability-prompt';
import {
  CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
  buildClaudeCodeGraphPreToolUseContext,
  isClaudeCodeGraphPostToolUse,
  isClaudeCodeGraphToolName,
  loadConfiguredClaudeCodeGraphSourceExtensions,
} from '../lib/claude-code-graph-steering';
import {
  detectClaudeQuotaReached,
  readClaudeQuotaResetsAt,
  detectAiCreditsNoBillingSource,
  markProviderQuotaReached,
} from './ai-credits-quota-state';
import { recordUsageLimitedChat } from '../lib/usage-limited-chats-registry';
import {
  buildUsageLimitedEntry,
  buildAccountProxyUsageLimitedEntry,
  classifyAccountChangeResume,
} from '../lib/usage-limited-chats-recording';
import { classifyAgentFailure } from '@canopy/desktop-shared/agent-failures';
import { buildProviderAuthFailureEvent } from './provider-auth-failure-event';
import type {
  CanopyAuthFailureEventData,
  ChatContextUsageBreakdown,
} from '@canopy/desktop-shared/types';
import { resolveWorkspaceRecordingSnapshot } from '../lib/resolve-workspace-display-name';
import {
  buildClaudeThinkingFlagSettings,
  buildClaudeThinkingOptions,
  clampThinkingLevelForModel,
  buildNoBillingSourceError,
  DEFAULT_CLAUDE_MODEL,
  NO_BILLING_SOURCE_ERROR_CODE,
  SET_AUTO_ARCHIVE_REQUESTED_EVENT_TYPE,
  IPC_CHANNELS,
  hasAnySelections,
  type ApprovalMode,
  type TrackedPlanData,
  type ChatModel,
  CODE_REVIEW_CHAT_PROJECT_ID,
  OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE,
  type ThinkingLevel,
  type PlanExitRequestEvent,
} from '@canopy/desktop-shared/types';
import {
  approvalCheckForClaudeTool,
  claudePermissionModeFor,
  CLAUDE_PLAN_MODE_BOOKKEEPING_CONTEXT,
  isClaudePlanModeBookkeepingTool,
} from './claude-approval-adapter';
import {
  createApprovalSession,
  type ApprovalSessionHandle,
} from '../approvals/approval-service';
import { resolvePlugins } from '../plugins/plugin-resolver';
import { resolveEffectiveChatPluginContext } from '../plugins/global-plugin-overlay';
import { loadCachedInventory } from '../plugins/invocable-inventory-service';
import { normalizeInvocationToken } from '../plugins/invocation-prefix-normalizer';
import { getMcpHttpProxyService } from '../mcp/http-proxy-service';
import { rejectAllForSession } from '../mcp/pending-requests';
import {
  ASK_USER_HTTP_TIMEOUT_MS,
  CANOPY_MCP_TOOL_TIMEOUT_MS,
} from '@canopy/desktop-shared/lib/canopy-injected-tools';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import {
  mayExposeLedgerTools,
  openLedgerChatTools,
  type LedgerChatSettings,
  type LedgerChatTarget,
  type LedgerChatToolsSession,
} from '../canopy-tools/ledger-tools-runtime';
import {
  getFileCommentsInSession,
  loadGitPreferences,
  loadWorktreePipelineYaml,
  loadWorktreeScriptOutput,
  saveLocalMemory,
  searchLocalMemory,
  requestAnswersFromRenderer,
  respondToFileCommentInSession,
} from '../canopy-tools/session-runtime';
import { claudeNativeMemoryOptions } from '@canopy/desktop-shared/node/lib/native-memory';
import {
  readLatestPreferencesFile,
  readLocalMemoryEnabledPreference,
} from '../lib/preferences-store';
import {
  registerSession,
  unregisterSession,
  buildSessionKey,
  markTurnActive,
  markTurnAwaitingUser,
  markTurnIdle,
  noteSessionMessageQueued,
  recordSessionEvent,
  createSessionPhaseTimer,
  isSessionAccountProxyRouted,
  recordSessionAccountProxyRoute,
  resetSessionLiveBackgroundTasks,
  SessionUnavailableForTaskStopError,
  type StopBackgroundTaskOutcome,
} from './session-manager';
import {
  getBundledClaudeBinaryPath,
  getBundledRtkBinaryPath,
  getBundledRgBinaryPath,
  getEnhancedEnv,
  getRtkManagedEnv,
} from '../pipelines/config-paths';
import { createTrackedPlan, updateTrackedPlan } from '../lib/plan-persistence';
import { buildPlanFileSystemInstruction } from '../lib/plan-system-instructions';
import { sendToWindow } from '../lib/window-send';
import { noteChatSessionEvent } from '../lib/transient-error-retry-service';
import { getAttentionTracker } from '../services/attention-tracker';
import { commitPendingPlanExit } from '../services/chat-state-plan-exit';
import { isRecord } from '../lib/type-guards';
import { getObservabilityService } from '../observability';
import {
  captureClaudeContextSnapshot,
  claudeContextEndTokens,
} from '../observability/capture-fields';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { buildRtkClaudeHooks } from '@canopy/desktop-shared/node/rtk/claude-hooks';
import { resolveAnthropicMockEnvOverride } from '@canopy/desktop-shared/node/e2e-mock-env';
import {
  spawnClaudeCodeProcessOffMain,
  withholdClaudeProcessStdoutCreditUntil,
} from './claude-process-host-runner';
import { CLAUDE_STDOUT_IN_FLIGHT_LIMIT_BYTES } from './claude-process-host-protocol';
import {
  mainWindowOnlyToolSurfaces,
  requestShowFiles,
} from '../canopy-tools/show-files-runtime';
import { createE2eClaudeQueryWithPrelude } from '../lib/e2e-claude-query-prelude';

/** Map of session keys to their active Query refs — used by stopTaskForClaudeSession. */
const queryRefs = new Map<string, Query>();
const trackedPlansBySession = new Map<
  string,
  { planId: string; revisionNumber: number }
>();

export interface ClaudeCompatibleInvocation {
  providerType: 'claude' | 'ollama';
  sdkModel?: string;
  envOverride?: Record<string, string>;
}

interface ClaudeCodeProviderOptions {
  providerType?: 'claude' | 'ollama';
  prepareInvocation?: (
    model: ChatModel | undefined,
    reason: 'session-start' | 'model-change',
  ) => Promise<ClaudeCompatibleInvocation>;
}

interface QueuedClaudeMessage {
  text: string;
  userMessageId?: string;
  submissionId?: UUID;
  steering?: boolean;
  countsTowardSkillUsage?: boolean;
}

/**
 * Resumed Claude sessions can flush a completed background-task notification
 * before they begin the foreground user turn. The SDK gives that side-channel
 * delivery its own zero-turn result, but the long-lived query remains active
 * and subsequently emits the foreground assistant response. Treating this as
 * terminal briefly marks the resumed session as expired in the renderer.
 */
function isClaudeTaskNotificationPreludeResult(
  event: Record<string, unknown>,
): boolean {
  if (
    event.type !== 'result' ||
    event.is_error === true ||
    event.num_turns !== 0 ||
    event.result !== ''
  ) {
    return false;
  }
  const origin = event.origin;
  if (typeof origin !== 'object' || origin === null) {
    return false;
  }
  const kind = 'kind' in origin ? origin.kind : undefined;
  return kind === 'task-notification' || kind === 'task_notification';
}

/**
 * Markers the Claude CLI uses to refuse a point-in-time fork resume.
 *
 * `resumeSessionAt` is validated against the source session's main chain, so
 * an anchor the CLI cannot find (a compacted or replaced session file, or a
 * sidechain uuid) is a hard failure rather than a silent full resume: the CLI
 * emits an `error_during_execution` result whose reason lands in `errors`,
 * and the SDK iterator then throws an `Error` carrying the same text.
 * `resumeDropsTurn` is not sent today; its refusal prefix is matched here so
 * adding it later cannot reintroduce an unrecoverable turn.
 */
const CLAUDE_FORK_RESUME_POINT_REJECTION_MARKERS = [
  'No message found with message.uuid of:',
  'Resume rejected by --resume-drops-turn:',
] as const;

function containsClaudeForkResumePointRejection(text: string): boolean {
  return CLAUDE_FORK_RESUME_POINT_REJECTION_MARKERS.some((marker) =>
    text.includes(marker),
  );
}

/**
 * True for the CLI's refusal of a point-in-time fork resume, in either shape:
 * the `error_during_execution` result event, or the error the SDK iterator
 * throws for it.
 */
function isClaudeForkResumePointRejection(value: unknown): boolean {
  if (value instanceof Error) {
    return containsClaudeForkResumePointRejection(value.message);
  }
  if (typeof value === 'string') {
    return containsClaudeForkResumePointRejection(value);
  }
  if (!isRecord(value) || value.type !== 'result' || value.is_error !== true) {
    return false;
  }
  const errors: unknown[] = Array.isArray(value.errors) ? value.errors : [];
  const candidates: unknown[] = [...errors, value.result];
  return candidates.some(
    (entry) =>
      typeof entry === 'string' &&
      containsClaudeForkResumePointRejection(entry),
  );
}

/**
 * Sentinel returned by the AI Credits routing resolvers when the defensive
 * backstop fires: the resolver has already emitted a clear error and the caller
 * must abort the session instead of falling back to native provider auth.
 */
const AI_CREDITS_BACKSTOP_ABORT = 'backstop-abort';

function getProviderErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

function modelGatewayCredentialRejectionStatus(
  value: unknown,
): 401 | 403 | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['api_error_status', 'status', 'statusCode'] as const) {
    const status = record[key];
    if (status === 401 || status === 403) return status;
  }
  return undefined;
}

/** Only terminal/error-bearing Claude events can interrupt account recovery. */
function isClaudeAccountChangeFailureEvent(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) return false;
  if (!('type' in event)) return false;
  return (
    (event.type === 'assistant' &&
      'error' in event &&
      typeof event.error === 'string') ||
    (event.type === 'result' && 'is_error' in event && event.is_error === true)
  );
}

/**
 * Resolve AI Credits gateway routing for a Claude session, if active. Returns
 * the proxy env override and gateway model id to apply at session spawn,
 * `'backstop-abort'` when the backstop error was emitted and the caller must
 * not spawn the session, or `null` when routing is inactive / not a
 * Claude-harness model / no cloud context is available (in which case the
 * session uses native provider auth).
 */
async function resolveClaudeAiCreditsRouting(
  opts: AgentSessionOptions,
  emit: (data: unknown) => void | Promise<void>,
  routeSessionId: string,
): Promise<
  | {
      env: Record<string, string>;
      model: string;
      organizationId?: string;
      credentialVersion?: string;
      nativeAuthFallback?: boolean;
    }
  | typeof AI_CREDITS_BACKSTOP_ABORT
  | null
> {
  // Ollama sessions share the Claude-compatible SDK transport, but their
  // model registry and authentication are entirely local. Never apply Claude
  // AI Credits availability backstops to an Ollama model.
  if (opts.providerType === 'ollama') {
    return null;
  }
  const attempt = await resolveAiCreditsRoutingAttempt(
    opts.aiCreditsRouting,
    'claude',
    () =>
      isProviderNativelyAuthenticatedForRouting('claude', 'ai-credits-routing'),
    opts.subscriptionBillingOverride,
  );
  const gatewayCheck = await checkModelGatewayRoute(
    opts.model,
    await resolveSessionWorkOwner(opts),
  );
  if (!gatewayCheck.ok) throw new Error(gatewayCheck.message);
  const gatewayEnforced = gatewayCheck.orgRoute;
  // The confirmed-logout contract behind `no-native-auth` only covers what the
  // auth probe can see, and the probe deliberately runs without the Canopy
  // Environments injector that the spawn below uses. A user who supplies their
  // own `ANTHROPIC_API_KEY` (or a Bedrock/Vertex redirect) through Environments
  // therefore reads as signed out here while having a working provider at spawn
  // time — and routing them would SUPPRESS it, since the proxy env blanks
  // `ANTHROPIC_API_KEY` and is spread after the user environment. Fall through
  // to the native spawn, which is what `off` mode did before ECW-9091.
  if (
    attempt?.reason === 'no-native-auth' &&
    !gatewayEnforced &&
    hasUserSuppliedProviderCredential('claude', opts.projectId)
  ) {
    return null;
  }
  // `AgentSessionOptions.model` is optional. Before ECW-9091 a model-less spawn
  // in `off` mode resolved no attempt and went native; now the attempt is
  // non-null, so without a default the gateway lookup misses and the backstop
  // below aborts a session that should just work. Scope the default to the new
  // reason so `on` / `on-quota` behavior is untouched.
  const selectedModel =
    attempt?.modelId ??
    opts.model ??
    (attempt?.reason === 'no-native-auth' ? DEFAULT_CLAUDE_MODEL : undefined);
  if (isUnavailableModelSelection(selectedModel, 'claude')) {
    await emit({
      type: 'error',
      error:
        'This model is no longer available. Pick another model to continue.',
    });
    return AI_CREDITS_BACKSTOP_ABORT;
  }
  // A gateway-only model can never be billed via a native Claude login, so it
  // must always route through the gateway — even when the attempt resolver
  // returns null (e.g. a natively-authenticated user with routing mode off who
  // selected it anyway). The picker greys such rows without credits, but the
  // session must be robust to a forced/restored selection.
  const entry = resolveGatewayModelEntry(selectedModel);
  if (gatewayEnforced && entry?.origin !== 'org-gateway') {
    await emit({
      type: 'error',
      error:
        'Your organization requires model traffic to use its configured gateway.',
    });
    return AI_CREDITS_BACKSTOP_ABORT;
  }
  const gatewayOnly = entry?.gatewayOnly === true;
  const enforcedOrgRoute = gatewayEnforced && entry?.origin === 'org-gateway';
  if (!attempt && !gatewayOnly && !enforcedOrgRoute) {
    return null;
  }
  if (!entry) {
    // Defensive backstop: the user picked a model AI Credits can't cover. If
    // they also have no native Claude login, surface a clear error instead of
    // falling through to a raw native provider auth failure (a 401). The picker
    // (Part B) prevents this, but the global routing modes ('on'/'on-quota')
    // resolve an attempt *before* native auth is ever consulted, so a
    // reason of 'mode'/'session-override' alone does not tell us whether the
    // user can fall back to a native spawn — re-check native auth here.
    // (`gatewayOnly` is false in this branch, so `attempt` is non-null.)
    const nativelyAuthenticated =
      attempt?.reason === 'no-native-auth'
        ? false
        : await isProviderNativelyAuthenticated('claude', 'ai-credits-routing');
    if (!nativelyAuthenticated) {
      await emit({
        type: 'error',
        error:
          "This model can't be used with AI Credits and you're not signed in to Claude. Sign in to Claude or pick a model covered by AI Credits.",
      });
      // Abort rather than fall through to a native spawn — that would surface a
      // second raw provider auth failure on top of this clear message.
      return AI_CREDITS_BACKSTOP_ABORT;
    }
    return null;
  }
  if (entry.origin === 'org-gateway') {
    try {
      const attribution = await resolveSessionAiCreditsAttribution(opts);
      const credential = await resolveOrgGatewayCredential(
        entry,
        attribution.workOwner,
      );
      return {
        env: await buildBrokeredOrgGatewayClaudeEnv(
          entry,
          routeSessionId,
          getMockLlmOrigin() ?? credential.baseUrl,
          attribution,
        ),
        model: entry.gatewayId,
        organizationId: entry.organizationId,
        credentialVersion: credential.credentialVersion,
      };
    } catch (error) {
      await emit({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      return AI_CREDITS_BACKSTOP_ABORT;
    }
  }
  const attribution = await resolveSessionAiCreditsAttribution(opts);
  const context = await getAiCreditsRoutingContext({
    owner: attribution.workOwner,
  });
  // Skip routing when the account has no usable AI-credit balance — otherwise
  // the session is pointed at the gateway only to fail with a 402 instead of
  // falling back to native provider auth.
  if (!context || !context.creditsEligible) {
    // A gateway-only model has no native path to fall back to, so a missing
    // balance must surface a clear message and abort rather than spawn a
    // session that can't be billed (which would 401/402 natively).
    if (gatewayOnly) {
      await emit({
        type: 'error',
        error: `This model is only available with ${BRAND.displayName} credits. Make sure you have available credits or an active plan with spendable balance to use it.`,
      });
      return AI_CREDITS_BACKSTOP_ABORT;
    }
    // No native login (that is exactly what `no-native-auth` confirms) and no
    // spendable credits: nothing can pay for this turn. Falling through would
    // spawn natively and surface a raw `Please run /login`, which names the one
    // remedy the user may not have. Abort with a message that offers both
    // (ECW-9091). A `mode` / `session-override` attempt tells us nothing about
    // native auth, so those keep falling through to a native spawn.
    //
    // `error_code` makes the abort machine-identifiable (same precedent as
    // `OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE`). The visible remedy is
    // `NoBillingSourceBanner`, which renders from the same availability state
    // and is already on screen when this fires — the desktop transcript has no
    // error-string surface of its own.
    if (attempt?.reason === 'no-native-auth') {
      await emit({
        type: 'error',
        error_code: NO_BILLING_SOURCE_ERROR_CODE,
        error: buildNoBillingSourceError('Claude', BRAND.displayName),
      });
      return AI_CREDITS_BACKSTOP_ABORT;
    }
    return null;
  }
  return {
    env: buildClaudeProxyEnv(
      entry,
      context.cskToken,
      context.cloudBaseUrl,
      attribution,
      { guestPrincipal: context.guestPrincipal },
    ),
    model: entry.gatewayId,
    nativeAuthFallback: attempt?.reason === 'no-native-auth' && !gatewayOnly,
  };
}

function withTurnMetadata(
  data: unknown,
  turn: QueuedClaudeMessage | undefined,
): unknown {
  if (!turn?.userMessageId || typeof data !== 'object' || data === null) {
    return data;
  }
  if (Array.isArray(data)) {
    return data;
  }
  return {
    ...data,
    canopy_turn_user_message_id: turn.userMessageId,
  };
}

function extractPlanText(input: Record<string, unknown>): string {
  return typeof input.plan === 'string'
    ? input.plan
    : JSON.stringify(input, null, 2);
}

async function upsertTrackedPlan(
  sessionKey: string,
  projectId: string,
  worktreeId: string,
  chatId: string,
  source: 'claude' | 'ollama',
  input: Record<string, unknown>,
): Promise<TrackedPlanData> {
  const existing = trackedPlansBySession.get(sessionKey);
  const planText = extractPlanText(input);

  if (existing) {
    const updated = await updateTrackedPlan({
      projectId,
      worktreeId,
      planId: existing.planId,
      content: planText,
      source,
      reviewStatus: 'pending',
      approvedAt: null,
      dismissedAt: null,
      chatId,
      initiationSource: 'user',
    });
    if (updated) {
      trackedPlansBySession.set(sessionKey, {
        planId: updated.id,
        revisionNumber: updated.latestRevisionNumber,
      });
      return updated;
    }
  }

  const created = await createTrackedPlan({
    projectId,
    worktreeId,
    source,
    content: planText,
    reviewStatus: 'pending',
    chatId,
    initiationSource: 'user',
  });
  trackedPlansBySession.set(sessionKey, {
    planId: created.id,
    revisionNumber: created.latestRevisionNumber,
  });
  return created;
}

/**
 * Stop a specific task within a Claude session. Called from session-manager.
 */
export async function stopTaskForClaudeSession(
  projectId: string,
  worktreeId: string,
  chatId: string,
  taskId: string,
): Promise<StopBackgroundTaskOutcome> {
  const key = buildSessionKey(projectId, worktreeId, chatId);
  const queryRef = queryRefs.get(key);
  if (!queryRef) {
    throw new SessionUnavailableForTaskStopError();
  }

  try {
    await queryRef.stopTask(taskId);
    return 'stopped';
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // The CLI already reaped the task. Stopping it is a success, but no
    // terminal notification will ever arrive, so the caller must reconcile the
    // activity card itself.
    if (/is not running|unknown task|no such task/i.test(message)) {
      return 'already-finished';
    }
    throw error;
  }
}

export type ClaudeNativeSubagentStopOutcome =
  | 'stopped'
  | 'unsupported'
  | 'not_running'
  | 'failed';

/**
 * Stop one Claude Task subagent owned by the named root query. The caller must
 * supply the provider task id resolved from that same chat's task_started
 * notification; the UI's tool_use id is used only to ask the SDK to background
 * that exact Task call if it is still foreground.
 */
export async function stopNativeSubagentForClaudeSession(
  projectId: string,
  worktreeId: string,
  chatId: string,
  toolUseId: string,
  taskId: string,
  wasBackgrounded: boolean,
): Promise<ClaudeNativeSubagentStopOutcome> {
  const queryRef = queryRefs.get(
    buildSessionKey(projectId, worktreeId, chatId),
  );
  if (!queryRef) return 'not_running';

  try {
    const backgroundedNow = await queryRef.backgroundTasks(toolUseId);
    if (!backgroundedNow && !wasBackgrounded) return 'unsupported';
    await queryRef.stopTask(taskId);
    return 'stopped';
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (/is not running|unknown task|no such task/i.test(message)) {
      return 'not_running';
    }
    return 'failed';
  }
}

/**
 * What fills a Claude session's context window, by category, from the live
 * query (the data behind the CLI's /context). `summary` answers from the last
 * response's usage and local estimates, so opening the composer's usage
 * popover never makes extra token-counting API calls. Resolves `null` when
 * the chat has no live query (not started yet, or ended).
 */
export async function getContextUsageForClaudeSession(
  projectId: string,
  worktreeId: string,
  chatId: string,
): Promise<ChatContextUsageBreakdown | null> {
  const queryRef = queryRefs.get(
    buildSessionKey(projectId, worktreeId, chatId),
  );
  if (!queryRef) return null;
  const usage = await queryRef.getContextUsage({ detail: 'summary' });
  return {
    categories: usage.categories.map((category) => ({
      name: category.name,
      tokens: category.tokens,
      kind: category.kind,
    })),
    totalTokens: usage.totalTokens,
    maxTokens: usage.rawMaxTokens,
    percentage: usage.percentage,
  };
}

export class ClaudeCodeProvider implements AgentProvider {
  private readonly providerType: 'claude' | 'ollama';
  private readonly prepareInvocationImpl: (
    model: ChatModel | undefined,
    reason: 'session-start' | 'model-change',
  ) => Promise<ClaudeCompatibleInvocation>;

  constructor(options?: ClaudeCodeProviderOptions) {
    this.providerType = options?.providerType ?? 'claude';
    this.prepareInvocationImpl =
      options?.prepareInvocation ??
      ((model: ChatModel | undefined): Promise<ClaudeCompatibleInvocation> => {
        // Under the UI-automation/E2E build, redirect the Claude SDK to the mock
        // LLM server so live chat turns are deterministic. The gate and mock
        // literals live inside the shared helper, which production builds fold
        // to `return undefined` (Doc 11).
        const envOverride =
          this.providerType === 'claude'
            ? resolveAnthropicMockEnvOverride()
            : undefined;
        return Promise.resolve({
          providerType: this.providerType,
          ...(model ? { sdkModel: model } : {}),
          ...(envOverride ? { envOverride } : {}),
        });
      });
  }

  createSession(
    opts: AgentSessionOptions,
    onEvent: (data: unknown) => void | Promise<void>,
    getWindow: () => BrowserWindow | null,
  ): AgentSession {
    const prepareInvocation = this.prepareInvocationImpl;
    const key = buildSessionKey(opts.projectId, opts.worktreeId, opts.chatId);
    // Bind the owner of this chat's work to the context current as it starts
    // (CAN-3456); a later sidebar switch must not move it.
    captureSessionWorkOwner(opts);
    const codeGraphToolsAdvertised =
      opts.codeGraphToolsAdvertised ??
      ((opts.assistantMode ?? 'default') === 'default' &&
        !isCoworkWorkspace(opts.projectId) &&
        isCodeGraphAvailableForWorkspace(opts.projectId));
    const sessionOpts: AgentSessionOptions = {
      ...opts,
      codeGraphToolsAdvertised,
      // One live list: the approval session adds grants to it, and managed
      // delegates evaluate their approvals against it.
      sessionApprovalRules: opts.sessionApprovalRules ?? [],
    };
    const abortController = new AbortController();

    // Message queue for multi-turn communication (same pattern as Conductor)
    let accountProxyConnectionId: string | undefined;
    const messageQueue: QueuedClaudeMessage[] = [];
    const skillUsage = new SkillUsageTracker(opts);
    let waitingForMessage:
      | ((msg: QueuedClaudeMessage | undefined) => void)
      | null = null;
    let queryRef: Query | null = null;
    let approvalSessionRef: ApprovalSessionHandle | null = null;
    let rtkEnabled = opts.rtkEnabled !== false;
    let activeTurn: QueuedClaudeMessage | undefined;
    let pendingTurn: QueuedClaudeMessage | undefined;
    let lastCreditsFailureTurn: QueuedClaudeMessage | undefined;
    let destroyRequested = false;
    let queryLoopExited = false;
    let currentModel: ChatModel | undefined = opts.model;
    let currentSelectedModel: ChatModel | undefined =
      opts.selectedModel ?? opts.model;
    let currentPlanMode = opts.planMode ?? false;
    let currentThinkingLevel: ThinkingLevel = opts.thinkingLevel ?? 'high';
    let currentApprovalMode: ApprovalMode = opts.approvalMode ?? 'ask';
    let planModeEnabled = opts.planMode === true;
    let currentAiCreditsRouted = false;
    let currentHostedAiCreditsRouted = false;
    let currentNativeAuthFallback = false;
    // Weak identity keys bound deduplication to each foreground turn without
    // retaining completed turns. Routing is captured at query launch, never
    // re-read from account preferences while consuming delayed provider events.
    const creditsRecoveryTurns = new WeakSet<QueuedClaudeMessage>();
    const creditsDiagnosticTurns = new WeakSet<QueuedClaudeMessage>();
    let uncorrelatedCreditsRecovery = false;
    let uncorrelatedCreditsDiagnostic = false;
    // Reset time from this turn's latest rejected `rate_limit_event`. Claude
    // reports it separately from the 429 that ends the turn (CAN-4200).
    let lastClaudeRejectedResetsAt: number | undefined;
    let currentProviderSessionId = opts.sdkSessionId;
    const hostedProcesses = new Set<SpawnedProcess>();
    const spawnHostedProcess = (options: SpawnOptions): SpawnedProcess => {
      const process = spawnClaudeCodeProcessOffMain(options);
      hostedProcesses.add(process);
      process.on('exit', () => hostedProcesses.delete(process));
      return process;
    };
    const withholdCreditForAdmission = (
      admission: void | Promise<void>,
    ): void => {
      if (!admission || typeof admission.then !== 'function') return;
      // Chat storage group-commits, so the
      // SDK keeps receiving events during a pending admission, within a byte
      // bound, so several of this chat's commits can share one journal sync.
      const inFlightLimitBytes = CLAUDE_STDOUT_IN_FLIGHT_LIMIT_BYTES;
      for (const process of Array.from(hostedProcesses)) {
        withholdClaudeProcessStdoutCreditUntil(
          process,
          admission,
          inFlightLimitBytes,
        );
      }
    };
    let managedDelegation: ManagedDelegationSession | undefined;
    const terminalWaiters = new Set<() => void>();
    const inputDelivery = new ClaudeInputDelivery(
      randomUUID(),
      onEvent,
      (userMessageId) => {
        if (activeTurn) return false;
        activeTurn = { text: '', userMessageId };
        lastClaudeRejectedResetsAt = undefined;
        markTurnActive(key, userMessageId);
        return true;
      },
    );

    // Author details a Ledger binding records: this session's live settings.
    const readLedgerSettings = (): LedgerChatSettings => ({
      model: currentModel ?? null,
      thinkingEffort: clampThinkingLevelForModel(
        currentThinkingLevel,
        currentModel,
        'claude',
        currentAiCreditsRouted,
      ),
      planMode: planModeEnabled,
    });

    const applyCurrentThinkingFlagSettings = async (): Promise<void> => {
      if (!queryRef) return;
      await queryRef.applyFlagSettings(
        buildClaudeThinkingFlagSettings(
          clampThinkingLevelForModel(
            currentThinkingLevel,
            currentModel,
            'claude',
            currentAiCreditsRouted,
          ),
        ),
      );
    };

    const sendMessage = (
      text: string,
      sendOptions?: AgentSessionSendOptions,
    ): void => {
      const queuedMessage: QueuedClaudeMessage = {
        text,
        submissionId: randomUUID(),
        countsTowardSkillUsage: sendOptions?.countsTowardSkillUsage === true,
        ...(sendOptions?.userMessageId
          ? { userMessageId: sendOptions.userMessageId }
          : {}),
      };
      messageQueue.push(queuedMessage);
      pendingTurn ??= queuedMessage;
      noteSessionMessageQueued(key, messageQueue.length);
      if (waitingForMessage) {
        const resolver = waitingForMessage;
        waitingForMessage = null;
        resolver(messageQueue.shift());
        noteSessionMessageQueued(key, messageQueue.length);
      }
    };

    const emitEvent = (data: unknown): void | Promise<void> => {
      managedDelegation?.observe(
        data,
        (activeTurn ?? pendingTurn)?.userMessageId,
      );
      inputDelivery.observe(data);
      if (
        typeof data === 'object' &&
        data !== null &&
        'type' in data &&
        data.type === 'system' &&
        'subtype' in data &&
        data.subtype === 'init' &&
        'session_id' in data &&
        typeof data.session_id === 'string' &&
        (!('parent_tool_use_id' in data) || data.parent_tool_use_id == null)
      ) {
        currentProviderSessionId = data.session_id;
      }
      const accountScope = currentAiCreditsRouted ? 'ai_credits' : 'native';
      const hostedFailure = currentHostedAiCreditsRouted
        ? detectClaudeHostedNoBillingSource(data)
        : null;
      const restoredData = hostedFailure
        ? withProxyFailureRestored(data, hostedFailure, 'claude')
        : data;
      const normalizedData = withClaudeAiCreditsFallbackError(
        restoredData,
        currentNativeAuthFallback,
      );
      const creditsFailure =
        accountScope === 'ai_credits' &&
        detectAiCreditsNoBillingSource(normalizedData);
      const eventTurn =
        activeTurn ??
        // A terminal clears activeTurn before a repeated SDK failure arrives.
        // A queued prompt is not its owner until the SDK consumes that prompt.
        (creditsFailure ? lastCreditsFailureTurn : undefined) ??
        pendingTurn;
      if (creditsFailure && eventTurn) lastCreditsFailureTurn = eventTurn;
      if (
        typeof data === 'object' &&
        data !== null &&
        'type' in data &&
        data.type === 'result' &&
        !isAiCreditsFailureEventShape(data, 'claude')
      )
        lastCreditsFailureTurn = undefined;
      const eventData = withTurnMetadata(normalizedData, eventTurn);
      if (
        currentHostedAiCreditsRouted &&
        isAiCreditsFailureEventShape(data, 'claude') &&
        (hostedFailure !== null || readClaudeApiErrorStatus(data) === 402) &&
        !hasClaudeProxyFailureEvidence(data) &&
        !(eventTurn
          ? creditsDiagnosticTurns.has(eventTurn)
          : uncorrelatedCreditsDiagnostic)
      ) {
        if (eventTurn) creditsDiagnosticTurns.add(eventTurn);
        else uncorrelatedCreditsDiagnostic = true;
        getObservabilityService().recordSessionDiagnostic({
          version: 1,
          timestamp: new Date().toISOString(),
          kind: 'claude_ai_credits_402',
          sessionKey: key,
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          providerType: 'claude',
          claudeAiCredits402Outcome: hostedFailure
            ? 'inferred_no_billing_source'
            : 'unmatched',
          ...(eventTurn?.userMessageId
            ? { turnUserMessageId: eventTurn.userMessageId }
            : {}),
        });
      }
      // Held until after `onEvent(eventData)` below. Ordering is load-bearing
      // for the shapes that DO produce an anchor, because the reducer writes
      // that notice while reducing THIS same event — emitting first would find
      // no anchor at all. Two shapes qualify (CAN-1814 review round 2):
      //   - a `result` whose text `isClaudeAuthenticationFailureMessage`
      //     recognizes, which `handleClaudeResultEvent` turns into a `system`
      //     message carrying that text;
      //   - a `{ type: 'error' }` event, which `handleClaudeErrorEvent` turns
      //     into a `system` `Error: <message>` notice.
      //
      // Ordering is NOT what keeps the failure off the wrong block. The shapes
      // `classifyAgentFailure` accepts that write NO block are
      // `{ type: 'assistant', error: 'authentication_failed' }` — the assistant
      // handler returns state untouched when the event carries no content
      // blocks — and a `result` whose body is unrecognized but whose turn
      // buffered an HTTP 401 elsewhere. For those,
      // `attachAuthFailureToMessages` deliberately attaches nothing rather than
      // falling back to the newest text block — which was the user's own prompt
      // bubble (CAN-1814 review).
      let providerAuthEvent: CanopyAuthFailureEventData | null = null;
      const sideAdmissions: Promise<void>[] = [];
      const trackSideAdmission = (admission: void | Promise<void>): void => {
        if (admission) {
          withholdCreditForAdmission(admission);
          sideAdmissions.push(Promise.resolve(admission));
        }
      };
      const proxyInterruption =
        isRecord(data) &&
        data.type === 'result' &&
        data.is_error === true &&
        data.parent_tool_use_id == null
          ? buildAccountProxyUsageLimitedEntry(
              {
                projectId: opts.projectId,
                worktreeId: opts.worktreeId,
                chatId: opts.chatId,
                provider: 'claude',
                detectedAt: Date.now(),
                accountProxyConnectionId,
              },
              data,
            )
          : null;
      if (proxyInterruption) {
        trackSideAdmission(recordUsageLimitedChat(proxyInterruption));
      }
      // A proxy account's sign-in or limit is not the user's own, so it never
      // starts native account recovery (CAN-4020).
      const resume =
        isClaudeAccountChangeFailureEvent(data) &&
        !isSessionAccountProxyRouted(
          opts.projectId,
          opts.worktreeId,
          opts.chatId,
        )
          ? classifyAccountChangeResume('claude', data, accountScope)
          : null;
      const resumeReason = resume?.reason ?? null;
      const rejectedResetsAt = readClaudeQuotaResetsAt(data);
      if (rejectedResetsAt !== undefined) {
        lastClaudeRejectedResetsAt = rejectedResetsAt;
      }
      if (
        creditsFailure &&
        !(eventTurn
          ? creditsRecoveryTurns.has(eventTurn)
          : uncorrelatedCreditsRecovery)
      ) {
        if (eventTurn) creditsRecoveryTurns.add(eventTurn);
        else uncorrelatedCreditsRecovery = true;
        trackSideAdmission(emitAiCreditsNoBillingSource(onEvent, 'claude'));
      }
      // Feed the common on-quota state so any surface's next session recreates
      // through AI Credits when Claude's native quota is reached (CAN-838), and
      // surface the shared usage-limit banner on every chat surface.
      if (resumeReason === 'usage_limit' && detectClaudeQuotaReached(data)) {
        const resetsAt = lastClaudeRejectedResetsAt ?? resume?.resetsAt;
        markProviderQuotaReached('claude', resetsAt);
        trackSideAdmission(
          emitAiCreditsUsageLimitReached(onEvent, 'claude', resetsAt),
        );
        void (async (): Promise<void> => {
          const workspace = await resolveWorkspaceRecordingSnapshot(
            opts.projectId,
          );
          await recordUsageLimitedChat(
            buildUsageLimitedEntry({
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              chatId: opts.chatId,
              provider: 'claude',
              detectedAt: Date.now(),
              resetsAt,
              resumeReason,
              workspaceName: workspace.name,
              ...(workspace.type ? { workspaceType: workspace.type } : {}),
              chatTitle: '',
            }),
          );
        })();
      }
      // A turn's result is its last frame; its reset time never applies to a
      // later turn.
      if (isRecord(data) && data.type === 'result') {
        lastClaudeRejectedResetsAt = undefined;
      }
      if (resumeReason === 'authentication' && accountScope === 'native') {
        const classification = classifyAgentFailure({
          provider: 'claude',
          accountScope,
          events: [data],
          error: data,
        });
        if (classification) {
          providerAuthEvent = buildProviderAuthFailureEvent(classification);
        }
        void (async (): Promise<void> => {
          const workspace = await resolveWorkspaceRecordingSnapshot(
            opts.projectId,
          );
          await recordUsageLimitedChat(
            buildUsageLimitedEntry({
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              chatId: opts.chatId,
              provider: 'claude',
              detectedAt: Date.now(),
              resumeReason,
              workspaceName: workspace.name,
              ...(workspace.type ? { workspaceType: workspace.type } : {}),
              chatTitle: '',
            }),
          );
        })();
      }
      const stampedProviderAuthEvent = providerAuthEvent
        ? withTurnMetadata(providerAuthEvent, eventTurn)
        : null;
      recordSessionEvent(key, eventData);
      const attentionFailure = noteChatSessionEvent(
        {
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
        },
        'claude',
        eventData,
      );
      if (attentionFailure?.kind === 'non_retryable_failure') {
        getAttentionTracker().mark({
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          state: 'blocked',
          reason: 'error',
          sourceId: 'terminal-error',
          ...(attentionFailure.detail
            ? { detail: attentionFailure.detail }
            : {}),
        });
      }
      const deliverRecordedEvent = (): void | Promise<void> => {
        const delivery = onEvent(eventData);
        withholdCreditForAdmission(delivery);
        // `recordSessionEvent` is session bookkeeping (lastActivityAt,
        // lastEventType, wake lock) and never reaches the renderer; `onEvent`
        // is the delivery path. Deliberately NOT also recorded: stamping
        // `lastEventType: 'canopy_auth_failure'` after a terminal `result` would
        // hide the terminal event from restore.
        if (stampedProviderAuthEvent) {
          // Stamped like every other emitted event. Only terminal events
          // consult turn ids today, but skipping the stamp is a latent trap.
          if (delivery && typeof delivery.then === 'function') {
            return Promise.resolve(delivery).then(() => {
              const authDelivery = onEvent(stampedProviderAuthEvent);
              withholdCreditForAdmission(authDelivery);
              return authDelivery;
            });
          }
          const authDelivery = onEvent(stampedProviderAuthEvent);
          withholdCreditForAdmission(authDelivery);
          return authDelivery;
        }
        return delivery;
      };
      if (sideAdmissions.length > 0) {
        return Promise.all(sideAdmissions).then(deliverRecordedEvent);
      }
      return deliverRecordedEvent();
    };

    const runPromise = Promise.resolve().then(async () => {
      if (managedDelegationEnabled(sessionOpts)) {
        // Defer the cycle-breaking delegation service load until this session
        // actually enables managed child agents.
        const { createManagedDelegationSession } =
          await import('./delegation/service');
        managedDelegation = await createManagedDelegationSession({
          harness: 'claude',
          onTranscript: (delegation): void => {
            void Promise.resolve(
              onEvent({
                type: 'canopy_delegation',
                delegation,
                canopy_turn_user_message_id: delegation.parentTurnId,
              }),
            ).catch((error: unknown) =>
              logMainProcessWarn(
                '[claude-session] Delegation transcript delivery failed',
                error,
              ),
            );
          },
          sessionKey: key,
          getWindow,
          currentOptions: () => ({
            ...sessionOpts,
            model: currentModel,
            selectedModel: currentSelectedModel,
            thinkingLevel: currentThinkingLevel,
            approvalMode: currentApprovalMode,
            planMode: currentPlanMode,
          }),
          currentTurn: () => (activeTurn ?? pendingTurn)?.userMessageId,
        });
      }
      await this._runQuery(
        sessionOpts,
        abortController,
        messageQueue,
        (resolver) => {
          waitingForMessage = resolver;
        },
        (message) => {
          if (!message.steering) {
            activeTurn = message;
            lastCreditsFailureTurn = undefined;
            lastClaudeRejectedResetsAt = undefined;
            skillUsage.startTurn(
              message.submissionId ?? message.userMessageId ?? randomUUID(),
              message.countsTowardSkillUsage === true,
            );
            // A new user turn resolves any prior plan-review or terminal-error
            // attention state for this chat before the next outcome is known.
            getAttentionTracker().clear(
              opts.projectId,
              opts.worktreeId,
              opts.chatId,
            );
          }
          if (pendingTurn === message) {
            pendingTurn = messageQueue[0];
          }
        },
        (message) =>
          !message.steering ||
          (message.submissionId !== undefined &&
            inputDelivery.claimYield(message.submissionId)),
        () => {
          skillUsage.endTurn();
          activeTurn = undefined;
          terminalWaiters.forEach((settle) => settle());
          terminalWaiters.clear();
        },
        () => activeTurn !== undefined || pendingTurn !== undefined,
        () => activeTurn ?? pendingTurn,
        () =>
          !destroyRequested ||
          activeTurn !== undefined ||
          pendingTurn !== undefined,
        (q) => {
          queryRef = q;
          inputDelivery.setQuery(q);
          currentPlanMode = planModeEnabled;
          queryRefs.set(key, q);
        },
        () => rtkEnabled,
        () => currentApprovalMode,
        () => planModeEnabled,
        (routed, hostedAiCreditsRouted, nativeAuthFallback) => {
          currentAiCreditsRouted = routed;
          currentHostedAiCreditsRouted = hostedAiCreditsRouted;
          currentNativeAuthFallback = nativeAuthFallback;
        },
        emitEvent,
        skillUsage,
        spawnHostedProcess,
        key,
        getWindow,
        (a) => {
          approvalSessionRef = a;
        },
        managedDelegation,
        readLedgerSettings,
        (connectionId) => {
          accountProxyConnectionId = connectionId;
        },
      );
    });
    // _runQuery settles (it catches its own startup/runtime errors) exactly
    // when the query loop has exited and its cleanup unregistered the
    // session — after that point queued messages can never be drained, even
    // though neither destroyRequested nor the abort signal was set.
    void runPromise.then(
      () => {
        queryLoopExited = true;
        skillUsage.dispose();
        inputDelivery.dispose();
        hostedProcesses.clear();
      },
      (error: unknown) => {
        queryLoopExited = true;
        skillUsage.dispose();
        inputDelivery.dispose();
        hostedProcesses.clear();
        markTurnIdle(key);
        logMainProcessWarn('[claude-session] Managed session failed', error);
        void Promise.resolve(
          emitEvent({
            type: 'error',
            error:
              'The managed session could not start or finish its owned cleanup.',
          }),
        ).catch((deliveryError: unknown) =>
          logMainProcessWarn(
            '[claude-session] Failed to report managed session failure',
            deliveryError,
          ),
        );
        unregisterSession(key);
      },
    );

    const session: AgentSession = {
      sendMessage,
      getSteeringCapabilities: () => {
        const caps = inputDelivery.getCapabilities();
        return { ...caps, steer: caps.steer && activeTurn !== undefined };
      },
      getSteeringWorkingDirectory: () => opts.cwd,
      hasPendingSteeringInput: () => inputDelivery.hasPending(),
      submitSteeringInput(text, attemptId, userMessageId) {
        if (!activeTurn || abortController.signal.aborted)
          return Promise.resolve({
            kind: 'rejected',
            attemptId,
            reason: 'No active turn to steer',
          });
        return inputDelivery.submit(text, attemptId, userMessageId, () => {
          const message: QueuedClaudeMessage = {
            text,
            submissionId: attemptId as UUID,
            userMessageId,
            steering: true,
          };
          if (waitingForMessage) {
            const resolve = waitingForMessage;
            waitingForMessage = null;
            resolve(message);
          } else messageQueue.push(message);
        });
      },
      withdrawSteeringInput: (attemptId) => inputDelivery.withdraw(attemptId),
      async interruptWithPendingSweep() {
        approvalSessionRef?.invalidatePending?.();
        let settle = (): void => undefined;
        const terminal = new Promise<void>((resolve) => {
          settle = resolve;
        });
        if (activeTurn) terminalWaiters.add(settle);
        else settle();
        try {
          await inputDelivery.sweep();
          await withDeliveryDeadline(terminal);
        } finally {
          terminalWaiters.delete(settle);
        }
      },
      getProviderSessionId(): string | undefined {
        return currentProviderSessionId;
      },
      isDisposed(): boolean {
        // destroy() sets destroyRequested; cancel() aborts the controller,
        // which permanently ends the SDK query loop and unregisters the
        // session; and a query loop that exited on its own (caught startup
        // or runtime error) unregisters the session without setting either
        // flag. In all three cases a message queued after the fact can never
        // reach the provider.
        return (
          destroyRequested || abortController.signal.aborted || queryLoopExited
        );
      },
      async cancel() {
        approvalSessionRef?.invalidatePending?.();
        try {
          if (inputDelivery.hasPending()) await inputDelivery.sweep();
        } finally {
          skillUsage.dispose();
          inputDelivery.dispose();
          abortController.abort();
          // Stop ends this turn and its query, never the chat's delegations:
          // they keep running under the chat root until the user stops them.
          managedDelegation?.detach();
        }
      },
      destroy() {
        destroyRequested = true;
        abortController.abort();
        getMcpHttpProxyService().unregisterRoutesForSession(key);
        getCodexGatewayProxyService().unregisterRoutesForSession(key);
        getMcpHttpProxyService().unregisterCanopyWorktreeSessionRoute(key);
        unregisterSession(key);
        queryRefs.delete(key);
        rejectAllForSession(key);
        trackedPlansBySession.delete(key);
        // Unblock any waiting message promise so the generator can exit
        if (waitingForMessage) {
          waitingForMessage(undefined);
          waitingForMessage = null;
        }
        // Recreate-on-next-turn waits on destroy(); do not let a replacement
        // session register under this key while the old query is still cleaning
        // up keyed session state.
        return runPromise;
      },
      setManagedDelegationMode(mode): void {
        if (mode !== undefined) managedDelegation?.updatePolicy(mode);
      },
      async setPlanMode(enabled: boolean) {
        planModeEnabled = enabled;
        if (!enabled) {
          trackedPlansBySession.delete(key);
        }
        if (enabled === currentPlanMode) return;
        if (!queryRef) return;
        if (
          !enabled &&
          currentApprovalMode === 'full-access' &&
          (opts.approvalMode ?? 'ask') !== 'full-access'
        ) {
          // This query was launched without the SDK's dangerous-skip
          // capability. The plan-mode toggle marks the session for next-turn
          // recreation, so keep the existing query in plan mode until then.
          return;
        }
        await queryRef.setPermissionMode(
          claudePermissionModeFor(currentApprovalMode, enabled),
        );
        currentPlanMode = enabled;
      },
      async setApprovalMode(mode: ApprovalMode) {
        // A newly created query already has this mode. Besides avoiding an
        // unnecessary control request, this lets fork recovery receive its
        // first prompt even if the original query rejects its resume point.
        if (mode === currentApprovalMode) return;
        const previousMode = currentApprovalMode;
        currentApprovalMode = mode;
        approvalSessionRef?.setMode(mode);
        if (!queryRef) return;
        if (
          mode === 'full-access' &&
          (opts.approvalMode ?? 'ask') !== 'full-access'
        ) {
          // This query was not launched with the SDK's dangerous-skip
          // capability. The caller marks it for next-turn recreation; avoid
          // asking the existing query to enter an unsupported bypass mode.
          return;
        }
        try {
          await queryRef.setPermissionMode(
            claudePermissionModeFor(mode, planModeEnabled),
          );
        } catch (error) {
          currentApprovalMode = previousMode;
          approvalSessionRef?.setMode(previousMode);
          throw error;
        }
      },
      setCodexProposalMode() {
        return Promise.resolve();
      },
      setRtkEnabled(enabled: boolean) {
        rtkEnabled = enabled;
        return Promise.resolve();
      },
      async setThinkingLevel(level: ThinkingLevel) {
        currentThinkingLevel = level;
        await applyCurrentThinkingFlagSettings();
      },
      async setModel(model: ChatModel) {
        currentModel = model;
        currentSelectedModel = model;
        if (!queryRef) return;
        const invocation = await prepareInvocation(model, 'model-change');
        await queryRef.setModel(invocation.sdkModel ?? model);
        await applyCurrentThinkingFlagSettings();
      },
    };

    // Ollama shares the SDK process plumbing, but retains its existing queue
    // and cancellation behavior. Native Claude delivery controls are opt-in.
    if (this.providerType !== 'claude') {
      delete session.getSteeringCapabilities;
      delete session.getSteeringWorkingDirectory;
      delete session.hasPendingSteeringInput;
      delete session.submitSteeringInput;
      delete session.withdrawSteeringInput;
      delete session.interruptWithPendingSweep;
    }

    registerSession(
      key,
      session,
      abortController,
      this.providerType,
      opts.model,
      opts.assistantMode ?? 'default',
      opts.toolProfileHash,
      codeGraphToolsAdvertised,
      opts.executionHarness,
    );

    return session;
  }

  private async _runQuery(
    opts: AgentSessionOptions,
    abortController: AbortController,
    messageQueue: QueuedClaudeMessage[],
    setWaiter: (
      resolver: ((msg: QueuedClaudeMessage | undefined) => void) | null,
    ) => void,
    setActiveTurn: (message: QueuedClaudeMessage) => void,
    canYieldMessage: (message: QueuedClaudeMessage) => boolean,
    clearActiveTurn: () => void,
    hasForegroundTurn: () => boolean,
    getForegroundTurn: () => QueuedClaudeMessage | undefined,
    shouldEmitTerminalEvent: () => boolean,
    setQueryRef: (q: Query) => void,
    isRtkEnabled: () => boolean,
    getApprovalMode: () => ApprovalMode,
    isPlanModeEnabled: () => boolean,
    setAiCreditsRouted: (
      routed: boolean,
      hostedAiCreditsRouted: boolean,
      nativeAuthFallback: boolean,
    ) => void,
    emitEvent: (data: unknown) => void | Promise<void>,
    skillUsage: SkillUsageTracker,
    spawnHostedProcess: (options: SpawnOptions) => SpawnedProcess,
    key: string,
    getWindow: () => BrowserWindow | null,
    setApprovalSessionRef: (a: ApprovalSessionHandle) => void,
    managedDelegation?: ManagedDelegationSession,
    readLedgerSettings?: () => LedgerChatSettings,
    setAccountProxyConnectionId?: (connectionId: string | undefined) => void,
  ): Promise<void> {
    let terminalEmitted = false;
    let accountProxyConnectionId: string | undefined;
    /** Ends the transcript's account switch lines for this query (CAN-4021). */
    let stopAccountProxySwitches: (() => void) | undefined;
    // Opened below with the default Canopy route or the App Advisor route
    // when the Ledger exposure gate passes; fixed for this query's lifetime.
    // A holder, because the prompt generator reads it after the assignment
    // below.
    const ledger: { tools: LedgerChatToolsSession | null } = { tools: null };
    let terminalTurn: QueuedClaudeMessage | undefined;
    /** The turn whose plan went to review, which its result then marks. */
    let planHandoff: { turn: QueuedClaudeMessage | undefined } | undefined;
    let lastRootAssistantContext:
      | {
          turn: QueuedClaudeMessage;
          endTokens: number;
        }
      | undefined;
    let codeGraphAvailableThisTurn = Boolean(
      buildCodeGraphAvailabilityPrompt(opts.projectId, opts.worktreeId, {
        liveAvailable: opts.codeGraphToolsAdvertised === true,
        toolsAdvertised: opts.codeGraphToolsAdvertised === true,
      }),
    );
    let codeGraphOrientedThisTurn = false;
    let codeGraphOrientationBlockedThisTurn = false;
    let codeGraphCustomSourceExtensionsThisTurn: readonly string[] | undefined;
    const invocationProvider = this.providerType;
    let approvalSession: ApprovalSessionHandle | undefined;
    let orgGatewayOrganizationId: string | undefined;
    let orgGatewayCredentialVersion: string | undefined;
    try {
      recordSessionEvent(key, {
        type: 'phase',
        phase: 'claude.prepare_invocation',
      });
      const stopPrepareTimer = createSessionPhaseTimer(
        key,
        'claude.prepare_invocation',
      );
      const invocation = await this.prepareInvocationImpl(
        opts.model,
        'session-start',
      ).finally(stopPrepareTimer);
      recordSessionEvent(key, {
        type: 'phase',
        phase: 'claude.prepare_invocation.complete',
      });

      // Resolve plugin selections into SDK plugin configs
      let sdkPlugins: { type: 'local'; path: string }[] = [];
      let resolvedMcpServers: Record<string, McpServerConfig> = {};
      // One overlay pass: effective selections are computed here (with all
      // overlay IO) and passed straight into resolvePlugins.
      const pluginContext = await resolveEffectiveChatPluginContext(
        opts.pluginSelections,
        opts,
        opts.applyGlobalPluginDefaults,
      );
      const effectiveSelections = pluginContext.selections;
      const claudeMaxTurns =
        invocation.providerType === 'claude'
          ? normalizeClaudeMaxTurns(
              (pluginContext.preferences ?? (await readLatestPreferencesFile()))
                .claudeMaxTurns,
            )
          : 200;

      if (hasAnySelections(effectiveSelections) || opts.packageOverlay) {
        try {
          recordSessionEvent(key, {
            type: 'phase',
            phase: 'claude.resolve_plugins',
          });
          const stopPluginTimer = createSessionPhaseTimer(
            key,
            'claude.resolve_plugins',
          );
          const resolved = await resolvePlugins(
            effectiveSelections,
            opts.projectId,
            opts.worktreeId,
            opts.chatId,
            {
              purpose: 'claude-session',
              installExternalPlugins: true,
              enableHttpMcpProxy: true,
              mcpHttpProxyService: getMcpHttpProxyService(),
              sessionId: key,
              ...(opts.packageOverlay
                ? { packageOverlay: opts.packageOverlay }
                : {}),
              ...(pluginContext.preferences
                ? { preferences: pluginContext.preferences }
                : {}),
            },
          ).finally(stopPluginTimer);
          sdkPlugins = resolved.sdkPlugins;
          resolvedMcpServers = resolved.mcpServers as Record<
            string,
            McpServerConfig
          >;
          for (const w of resolved.warnings) {
            // eslint-disable-next-line no-console
            console.warn('[plugin-resolver]', w);
          }
          recordSessionEvent(key, {
            type: 'phase',
            phase: 'claude.resolve_plugins.complete',
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[plugin-resolver] Failed to resolve plugins:', err);
        }
      }

      // A point-in-time fork of a chat taken mid tool call resumes at an
      // assistant entry whose calls are still open; its first prompt must
      // answer them or the provider rejects the dangling tool_use.
      // Only a well-formed forked resume ends on those calls; a runtime
      // rejection strips these blocks from the replayed fresh prompt.
      let pendingForkToolResults =
        opts.sdkSessionId &&
        opts.claudeForkSession &&
        isClaudeChainUuid(opts.claudeForkResumeAt) &&
        opts.claudeForkToolResults?.length
          ? opts.claudeForkToolResults
          : undefined;
      type ClaudePromptContent =
        | string
        | Array<
            | { type: 'tool_result'; tool_use_id: string; content: string }
            | { type: 'text'; text: string }
          >;
      // Async generator for multi-turn prompts (same pattern as Conductor claudeHandler.ts:1164-1196)
      const promptInput = (async function* (): AsyncGenerator<{
        type: 'user';
        message: { role: 'user'; content: ClaudePromptContent };
        parent_tool_use_id: null;
        session_id: string;
        uuid?: UUID;
      }> {
        while (true) {
          let queuedMessage: QueuedClaudeMessage | undefined;

          if (messageQueue.length > 0) {
            queuedMessage = messageQueue.shift();
          } else {
            queuedMessage = await new Promise<QueuedClaudeMessage | undefined>(
              (resolve) => {
                setWaiter(resolve);
              },
            );
          }

          if (queuedMessage === undefined) {
            // Session destroyed
            return;
          }

          const inventory = await loadCachedInventory().catch(() => null);
          const normalizedText = inventory
            ? normalizeInvocationToken(
                queuedMessage.text,
                inventory.entries.filter(
                  (entry) => entry.provider === invocationProvider,
                ),
              )
            : queuedMessage.text;

          if (!queuedMessage.steering) {
            codeGraphAvailableThisTurn = Boolean(
              buildCodeGraphAvailabilityPrompt(
                opts.projectId,
                opts.worktreeId,
                {
                  liveAvailable: opts.codeGraphToolsAdvertised === true,
                  toolsAdvertised: opts.codeGraphToolsAdvertised === true,
                },
              ),
            );
            codeGraphOrientedThisTurn = false;
            codeGraphOrientationBlockedThisTurn = false;
            codeGraphCustomSourceExtensionsThisTurn = undefined;
          }

          if (!canYieldMessage(queuedMessage)) continue;
          setActiveTurn(queuedMessage);
          if (!queuedMessage.steering) {
            skillUsage.observeInvocation(
              skillUsage.currentTurn(),
              queuedMessage.text,
              inventory?.entries.filter(
                (entry) => entry.provider === invocationProvider,
              ) ?? [],
            );
          }
          if (!queuedMessage.steering) {
            markTurnActive(key, queuedMessage.userMessageId);
          }
          const deliveryUuid =
            managedDelegation?.parent.nativeMessageUuid(
              queuedMessage.userMessageId,
            ) ?? queuedMessage.submissionId;
          // A normal turn starts with a bounded hint when entries assigned
          // to this chat changed since it last looked.
          const ledgerHint =
            ledger.tools !== null && !queuedMessage.steering
              ? await ledger.tools.assignmentHint()
              : undefined;
          const turnText = ledgerHint
            ? `${ledgerHint}\n\n${normalizedText}`
            : normalizedText;
          const promptText =
            managedDelegation?.applyPolicyGuidance(turnText) ?? turnText;
          const forkToolResults = pendingForkToolResults;
          pendingForkToolResults = undefined;
          yield {
            type: 'user' as const,
            message: {
              role: 'user' as const,
              content: forkToolResults
                ? [
                    ...forkToolResults.map((result) => ({
                      type: 'tool_result' as const,
                      tool_use_id: result.toolUseId,
                      content: result.content,
                    })),
                    { type: 'text' as const, text: promptText },
                  ]
                : promptText,
            },
            parent_tool_use_id: null,
            session_id: key,
            ...(deliveryUuid ? { uuid: deliveryUuid } : {}),
          };
        }
      })();

      // A point-in-time fork resume can be refused by the CLI, and the only
      // safe recovery is a second fresh `query()` with no source-session
      // resume fields. `promptInput`
      // is a single live generator over the message queue, so the prompt it
      // already handed to the failed attempt would otherwise be lost: buffer
      // every yielded prompt and replay them into the retry in order. `next()` is
      // driven manually rather than with `for await` so tearing down an
      // attempt's wrapper never closes the shared generator underneath it.
      type ClaudePromptMessage =
        Awaited<
          ReturnType<(typeof promptInput)['next']>
        > extends IteratorResult<infer TValue>
          ? TValue
          : never;
      const bufferedPrompts: ClaudePromptMessage[] = [];
      let replayBufferedPrompts = false;
      let pendingPromptNext:
        | Promise<IteratorResult<ClaudePromptMessage>>
        | undefined;
      const nextSharedPrompt = (): Promise<
        IteratorResult<ClaudePromptMessage>
      > => {
        if (pendingPromptNext) return pendingPromptNext;
        const next = promptInput.next();
        const tracked = next.finally(() => {
          if (pendingPromptNext === tracked) pendingPromptNext = undefined;
        });
        pendingPromptNext = tracked;
        return tracked;
      };
      const nextPromptAttempt = (): AsyncGenerator<ClaudePromptMessage> =>
        (async function* (): AsyncGenerator<ClaudePromptMessage> {
          if (replayBufferedPrompts) {
            replayBufferedPrompts = false;
            const promptsToReplay = bufferedPrompts.splice(0);
            for (const prompt of promptsToReplay) {
              // The fresh retry has no source calls to answer.
              const content = prompt.message.content;
              yield typeof content === 'string'
                ? prompt
                : {
                    ...prompt,
                    message: {
                      ...prompt.message,
                      content: content
                        .flatMap((block) =>
                          block.type === 'text' ? [block.text] : [],
                        )
                        .join('\n\n'),
                    },
                  };
            }
          }
          for (;;) {
            // A failed SDK iterator can leave its prompt wrapper parked on an
            // eager pull. Reuse that exact pull in the retry so a later user
            // message cannot be consumed by the abandoned wrapper.
            const next = await nextSharedPrompt();
            if (next.done === true) return;
            if (
              forkResumePointRequested &&
              !forkResumePointAccepted &&
              !forkResumePointRejected
            ) {
              bufferedPrompts.push(next.value);
            }
            yield next.value;
          }
        })();
      const forkResumePointRequested = Boolean(
        opts.sdkSessionId &&
        opts.claudeForkSession &&
        isClaudeChainUuid(opts.claudeForkResumeAt),
      );
      // A supplied point-in-time anchor is part of the fork's context-safety
      // contract. If it is malformed, fail closed before the first query;
      // treating it like an absent anchor would resume the full source session
      // and expose turns the fork deliberately discarded.
      let forkResumePointRejected = Boolean(
        opts.sdkSessionId &&
        opts.claudeForkSession &&
        opts.claudeForkResumeAt !== undefined &&
        !isClaudeChainUuid(opts.claudeForkResumeAt),
      );
      let forkResumePointAccepted = false;

      const isCodeReview = opts.projectId === CODE_REVIEW_CHAT_PROJECT_ID;
      const canopyRuntime: CanopyInjectedToolRuntime = {
        authorizeInstalledItemUninstall: (request, context) =>
          authorizeInstalledItemUninstall(approvalSession, request, context),
        deferredToolsRuntime: {
          scope: {
            projectId: opts.projectId,
            worktreeId: opts.worktreeId,
            chatId: opts.chatId,
          },
          providerType: opts.providerType ?? 'claude',
          interfaceMode: 'canopy',
          assistantMode: opts.assistantMode,
          pluginSelections: opts.pluginSelections,
          allowed: opts.deferredToolsAllowed !== false,
        },
        // Claude MCP path: omit `toolUseId` so the bridge generates a random
        // `requestId` and does NOT forward a `toolUseId` on the IPC event.
        // The renderer matches the pending card to the eventual
        // `mcp__canopy__AskUserQuestion` tool_use block via the existing
        // "first un-answered PendingQuestion for this chat" heuristic
        // because the Claude Agent SDK does not expose `tool_use_id` in
        // the MCP `tool()` handler's `extra` argument.
        requestUserAnswers: (questions) =>
          requestAnswersFromRenderer({
            sessionKey: key,
            projectId: opts.projectId,
            worktreeId: opts.worktreeId,
            chatId: opts.chatId,
            questions,
            getWindow,
            providerType: 'claude',
            model: opts.model,
            onAwaitingUser: (): void => markTurnAwaitingUser(key),
          }),
        loadScriptOutput: ({ scriptId, repo, maxLines }) =>
          loadWorktreeScriptOutput({
            projectId: opts.projectId,
            worktreeId: opts.worktreeId,
            scriptId,
            repo,
            maxLines,
          }),
        loadGitPreferences,
        saveLocalMemory: (request) =>
          saveLocalMemory({
            projectId: opts.projectId,
            worktreeId: opts.worktreeId,
            chatId: opts.chatId,
            sessionId: opts.sdkSessionId,
            provider: 'claude',
            ...request,
          }),
        searchLocalMemory: (request) =>
          searchLocalMemory({
            projectId: opts.projectId,
            worktreeId: opts.worktreeId,
            ...request,
          }),
        loadPipelineYaml: (request) =>
          loadWorktreePipelineYaml({
            projectId: opts.projectId,
            worktreeId: opts.worktreeId,
            ...request,
          }),
        ...(opts.assistantMode !== 'app-advisor' &&
        opts.assistantMode !== 'pipeline-editor'
          ? {
              showFiles: (files) =>
                requestShowFiles(
                  {
                    files,
                    target: {
                      projectId: opts.projectId,
                      worktreeId: opts.worktreeId,
                    },
                    origin: {
                      projectId: opts.projectId,
                      worktreeId: opts.worktreeId,
                      chatTabId: opts.chatId,
                    },
                    cwd: opts.cwd,
                  },
                  mainWindowOnlyToolSurfaces(getWindow),
                ),
              getFileComments: ({ threadId }) =>
                getFileCommentsInSession({
                  projectId: opts.projectId,
                  worktreeId: opts.worktreeId,
                  ...(threadId !== undefined ? { threadId } : {}),
                }),
              respondToFileComment: ({ threadId, body, resolve }) =>
                respondToFileCommentInSession({
                  projectId: opts.projectId,
                  worktreeId: opts.worktreeId,
                  threadId,
                  body,
                  resolve,
                  getWindow,
                }),
            }
          : {}),
        ...(!isCoworkWorkspace(opts.projectId) &&
        opts.assistantMode !== 'app-advisor' &&
        opts.assistantMode !== 'pipeline-editor'
          ? {
              worktreeActionRuntime: {
                projectId: opts.projectId,
                worktreeId: opts.worktreeId,
                chatId: opts.chatId,
                cwd: opts.cwd,
                ...(opts.selectedRepoId ? { repoId: opts.selectedRepoId } : {}),
                getWindow,
              },
              worktreeWatcherRuntime: {
                projectId: opts.projectId,
                worktreeId: opts.worktreeId,
                chatId: opts.chatId,
              },
            }
          : {}),
        ...(opts.assistantMode !== 'app-advisor' &&
        opts.assistantMode !== 'pipeline-editor'
          ? {
              setAutoArchiveForCurrentChat: (enabled) =>
                emitEvent({
                  type: SET_AUTO_ARCHIVE_REQUESTED_EVENT_TYPE,
                  enabled,
                }),
            }
          : {}),
      };
      const useHttpCanopyMcp =
        opts.assistantMode === 'app-advisor'
          ? Boolean(opts.appAdvisorRuntime)
          : opts.assistantMode === 'pipeline-editor'
            ? Boolean(opts.pipelineEditorRuntime)
            : true;
      const canopyMcpServers: Record<string, McpServerConfig> = {};
      if (opts.assistantMode === 'app-advisor' && opts.appAdvisorRuntime) {
        // The Work Entry this session started in: the Ledger stays bound to
        // it, whatever entry the App Advisor window selects later. The gate
        // runs once per session, and each call re-checks the flag and the
        // "Agents add to the Feed" setting.
        const ledgerTarget: LedgerChatTarget = {
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          assistantMode: 'app-advisor',
        };
        ledger.tools =
          readLedgerSettings && mayExposeLedgerTools(ledgerTarget)
            ? await openLedgerChatTools({
                target: ledgerTarget,
                harness: 'claude',
                // App Advisor advertises the Ledger tools under its own names.
                toolNames: getAppAdvisorLedgerToolNames('claude'),
                readSettings: readLedgerSettings,
              })
            : null;
        const authToken = randomBytes(32).toString('base64url');
        const proxyService = getMcpHttpProxyService();
        await proxyService.registerCanopyWorktreeSessionRoute({
          sessionKey: key,
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          assistantMode: 'app-advisor',
          cwd: opts.cwd,
          ...(opts.selectedRepoId ? { repoId: opts.selectedRepoId } : {}),
          sdkSessionId: opts.sdkSessionId ?? key,
          providerType: opts.providerType ?? 'claude',
          pluginSelections: opts.pluginSelections,
          deferredToolsAllowed: opts.deferredToolsAllowed !== false,
          authToken,
          createdAt: Date.now(),
          hookHandler: () => undefined,
          appAdvisorRuntime: opts.appAdvisorRuntime,
          ...(ledger.tools ? { ledgerTools: ledger.tools } : {}),
        });
        const mainUrl = proxyService.getCanopyWorktreeMcpUrl(key);
        const uiUrl = proxyService.getCanopyWorktreeUiMcpUrl(key);
        const headers = { Authorization: `Bearer ${authToken}` };
        canopyMcpServers[`${BRAND.tools.namespace}_app_advisor`] = {
          type: 'http',
          url: mainUrl,
          headers,
          timeout: CANOPY_MCP_TOOL_TIMEOUT_MS,
          alwaysLoad: true,
        };
        canopyMcpServers[`${BRAND.tools.namespace}_ui`] = {
          type: 'http',
          url: uiUrl,
          headers,
          timeout: ASK_USER_HTTP_TIMEOUT_MS,
          alwaysLoad: true,
        };
      } else if (
        opts.assistantMode === 'pipeline-editor' &&
        opts.pipelineEditorRuntime
      ) {
        const authToken = randomBytes(32).toString('base64url');
        const proxyService = getMcpHttpProxyService();
        await proxyService.registerCanopyWorktreeSessionRoute({
          sessionKey: key,
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          assistantMode: 'pipeline-editor',
          cwd: opts.cwd,
          ...(opts.selectedRepoId ? { repoId: opts.selectedRepoId } : {}),
          sdkSessionId: opts.sdkSessionId ?? key,
          providerType: opts.providerType ?? 'claude',
          pluginSelections: opts.pluginSelections,
          deferredToolsAllowed: opts.deferredToolsAllowed !== false,
          authToken,
          createdAt: Date.now(),
          hookHandler: () => undefined,
          pipelineEditorRuntime: opts.pipelineEditorRuntime,
        });
        const mainUrl = proxyService.getCanopyWorktreeMcpUrl(key);
        const uiUrl = proxyService.getCanopyWorktreeUiMcpUrl(key);
        const headers = { Authorization: `Bearer ${authToken}` };
        canopyMcpServers[`${BRAND.tools.namespace}_pipeline_editor`] = {
          type: 'http',
          url: mainUrl,
          headers,
          timeout: CANOPY_MCP_TOOL_TIMEOUT_MS,
          alwaysLoad: true,
        };
        canopyMcpServers[`${BRAND.tools.namespace}_ui`] = {
          type: 'http',
          url: uiUrl,
          headers,
          timeout: ASK_USER_HTTP_TIMEOUT_MS,
          alwaysLoad: true,
        };
      } else if (useHttpCanopyMcp) {
        const ledgerTarget: LedgerChatTarget = {
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          assistantMode: opts.assistantMode,
        };
        // The exposure gate runs once per session: a session keeps the
        // Ledger tools it started with, and each call re-checks the flag and
        // the "Agents add to the Feed" setting.
        ledger.tools =
          readLedgerSettings && mayExposeLedgerTools(ledgerTarget)
            ? await openLedgerChatTools({
                target: ledgerTarget,
                harness: 'claude',
                readSettings: readLedgerSettings,
                ...(opts.selectedRepoId
                  ? { selectedRepoId: opts.selectedRepoId }
                  : {}),
              })
            : null;
        const authToken = randomBytes(32).toString('base64url');
        const proxyService = getMcpHttpProxyService();
        await proxyService.registerCanopyWorktreeSessionRoute({
          sessionKey: key,
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          assistantMode: 'default',
          toolSurface: isCoworkWorkspace(opts.projectId)
            ? 'native-sdk-standalone'
            : 'native-sdk',
          cwd: opts.cwd,
          ...(opts.selectedRepoId ? { repoId: opts.selectedRepoId } : {}),
          sdkSessionId: opts.sdkSessionId ?? key,
          providerType: opts.providerType ?? 'claude',
          pluginSelections: opts.pluginSelections,
          deferredToolsAllowed: opts.deferredToolsAllowed !== false,
          authToken,
          createdAt: Date.now(),
          hookHandler: () => undefined,
          codeGraphToolsAdvertised:
            opts.codeGraphToolsAdvertised ??
            isCodeGraphAvailableForWorkspace(opts.projectId),
          ...(ledger.tools ? { ledgerTools: ledger.tools } : {}),
          ...(opts.model ? { model: opts.model } : {}),
          onAwaitingUser: () => markTurnAwaitingUser(key),
          ...(managedDelegation
            ? {
                managedDelegation: {
                  tools: managedDelegation.mcpTools,
                  invoke: async (
                    name: string,
                    input: unknown,
                  ): Promise<{ text: string; isError: boolean }> => {
                    const result = await managedDelegation.parent.invokeClaude(
                      name,
                      input,
                    );
                    return {
                      text: JSON.stringify(result),
                      isError: !result.ok,
                    };
                  },
                },
              }
            : {}),
          onSetAutoArchive: (enabled) =>
            emitEvent({
              type: SET_AUTO_ARCHIVE_REQUESTED_EVENT_TYPE,
              enabled,
            }),
          ...(isCodeReview
            ? {
                isCodeReview: true,
                respondToReviewComment: canopyRuntime.respondToReviewComment,
                getReviewCommentThread: canopyRuntime.getReviewCommentThread,
              }
            : {}),
        });
        const mainUrl = proxyService.getCanopyWorktreeMcpUrl(key);
        const uiUrl = proxyService.getCanopyWorktreeUiMcpUrl(key);
        const headers = { Authorization: `Bearer ${authToken}` };
        canopyMcpServers[BRAND.tools.namespace] = {
          type: 'http',
          url: mainUrl,
          headers,
          timeout: CANOPY_MCP_TOOL_TIMEOUT_MS,
          alwaysLoad: true,
        };
        canopyMcpServers[`${BRAND.tools.namespace}_ui`] = {
          type: 'http',
          url: uiUrl,
          headers,
          timeout: ASK_USER_HTTP_TIMEOUT_MS,
          alwaysLoad: true,
        };
      }

      // Permission bypass: this desktop assistant runs in a user-selected
      // worktree where the user explicitly chose to start an agent. The agent
      // operates under the user's OS-level permissions (same as running a
      // terminal command). Restricting SDK permissions here would only add
      // friction without improving security, since Electron already runs with
      // full user privileges. Prompt-injection mitigations should be addressed
      // at the SDK/model layer, not by re-prompting the user for each tool call.
      const rtkBinaryPath = getBundledRtkBinaryPath();
      // Always call the async resolver; it returns `null` fast on the common
      // native path (one cached auth read after warm, no cloud I/O). It
      // consults per-session override, the global mode + per-provider quota
      // state, and finally native-auth presence, so routing applies to every
      // chat surface — not just ones that thread per-tab routing state.
      // The account proxy the user turned on for this device goes first. Only
      // AI Credits chosen for this chat or for every session, Ollama, an
      // organization gateway, or a model only AI Credits serves skip it
      // (CAN-4020, CAN-4090).
      if (
        opts.requiredAccountProxyConnectionId &&
        (opts.providerType === 'ollama' ||
          isAiCreditsChosenOverAccountProxy(
            opts.aiCreditsRouting,
            opts.subscriptionBillingOverride,
          ) ||
          opts.accountProxyRouting === 'off')
      )
        throw new Error(
          'The account proxy connection for this continuation is unavailable.',
        );
      const accountProxyRoute =
        opts.providerType === 'ollama' ||
        isAiCreditsChosenOverAccountProxy(
          opts.aiCreditsRouting,
          opts.subscriptionBillingOverride,
        ) ||
        opts.accountProxyRouting === 'off'
          ? null
          : await resolveAccountProxySessionRoute({
              harness: 'claude',
              requiredConnectionId: opts.requiredAccountProxyConnectionId,
              signal: abortController.signal,
              model: opts.model,
              sessionId: key,
              resolveWorkOwner: () => resolveSessionWorkOwner(opts),
            });
      accountProxyConnectionId = accountProxyRoute?.accountKey.slice(
        'account-proxy:'.length,
      );
      setAccountProxyConnectionId?.(accountProxyConnectionId);
      recordSessionAccountProxyRoute(key, accountProxyRoute !== null);
      if (accountProxyRoute) {
        stopAccountProxySwitches = watchAccountProxySwitches(key, emitEvent);
      }
      const aiCreditsRouting = accountProxyRoute
        ? null
        : await resolveClaudeAiCreditsRouting(opts, emitEvent, key);
      if (aiCreditsRouting === AI_CREDITS_BACKSTOP_ABORT) {
        // The resolver already emitted a clear error explaining why this model
        // can't run. Do not spawn the native session — it would emit a second
        // raw provider auth failure on top of the backstop message (CAN-838).
        const statusAdmission = emitAiCreditsRoutingStatus(
          emitEvent,
          'claude',
          false,
        );
        if (statusAdmission) await statusAdmission;
        return;
      }
      const aiCreditsRouted = aiCreditsRouting !== null;
      orgGatewayOrganizationId = aiCreditsRouting?.organizationId;
      orgGatewayCredentialVersion = aiCreditsRouting?.credentialVersion;
      setAiCreditsRouted(
        aiCreditsRouted,
        aiCreditsRouting !== null &&
          aiCreditsRouting.organizationId === undefined,
        aiCreditsRouting?.nativeAuthFallback === true,
      );
      // Clamp against the metadata for the route that will actually execute
      // this session. Live gateway levels can differ from the native model.
      const thinkingLevel = clampThinkingLevelForModel(
        opts.thinkingLevel ?? 'high',
        opts.model,
        'claude',
        aiCreditsRouted,
      );
      const thinkingOptions = buildClaudeThinkingOptions(thinkingLevel);
      // Local memory is opt-in; only an enabled preference suppresses
      // harness-native auto-memory on this launch (CAN-1969).
      const localMemoryEnabled = await readLocalMemoryEnabledPreference();
      // Authoritatively tell the renderer whether this session is routing, so
      // the shared status banner is correct on every surface (CAN-838).
      const statusAdmission = emitAiCreditsRoutingStatus(
        emitEvent,
        'claude',
        aiCreditsRouting !== null,
        accountProxyRoute !== null,
      );
      if (statusAdmission) await statusAdmission;
      const routedSdkModel = aiCreditsRouting?.model ?? invocation.sdkModel;
      const sdkEnv = {
        ...getEnhancedEnv({
          environment: { runtime: 'agent', workspaceId: opts.projectId },
        }),
        ...(invocation.envOverride ?? {}),
        // AI Credits gateway proxy env wins over native provider auth for this
        // session when fallback routing is active (CAN-838).
        ...(aiCreditsRouting?.env ?? {}),
        ...(accountProxyRoute?.env ?? {}),
        [brandEnvName('RTK_BINARY_PATH')]: rtkBinaryPath,
        ...getRtkManagedEnv(),
      };

      const approvalMode = getApprovalMode();
      approvalSession = createApprovalSession({
        sessionKey: key,
        projectId: opts.projectId,
        worktreeId: opts.worktreeId,
        chatId: opts.chatId,
        provider: invocation.providerType,
        workspaceRoot: opts.cwd,
        mode: approvalMode,
        sessionRules: opts.sessionApprovalRules ?? [],
        getWindow,
        onAwaitingUser: () => markTurnAwaitingUser(key),
      });
      setApprovalSessionRef(approvalSession);
      // `approvalSession` is declared with `let` outside the `try` block (so
      // the `finally` block below can dispose it), which means TypeScript
      // cannot narrow it to non-`undefined` inside the `canUseTool` closure
      // created further down. Capture it in a `const` here instead.
      const approvalSessionHandle = approvalSession;

      // Claude can enforce one invocation through both `canUseTool` and the
      // authoritative PreToolUse hook. Newer CLI builds call both seams for
      // the same tool-use id; treating them as separate checks makes an
      // "Allow once" decision prompt twice. Share the first result while
      // failing closed if the host ever reuses an id for different input.
      const approvalResultsByToolUseId = new Map<
        string,
        {
          toolName: string;
          input: Record<string, unknown>;
          result: Promise<PermissionResult>;
        }
      >();

      const authorizeClaudeTool = async (
        toolName: string,
        input: Record<string, unknown>,
        authorizationOptions: {
          title?: string;
          toolUseID?: string;
          agentID?: string;
          signal?: AbortSignal;
        },
      ): Promise<PermissionResult> => {
        // Native Plan mode may still call this fallback after the hook. Honor
        // Full Access before parsing policy requirements, as the hook does.
        if (
          getApprovalMode() === 'full-access' &&
          !authorizationOptions.signal?.aborted
        ) {
          return { behavior: 'allow' };
        }
        if (
          opts.assistantMode === 'app-advisor' &&
          opts.appAdvisorRuntime &&
          toolName === APP_ADVISOR_TOOL_REGISTRY.watch_command.claudeToolName
        ) {
          // The App Advisor runtime resolves the selected worktree and performs
          // the command approval there. A provider-level MCP approval here is
          // both less specific and would prompt a second time.
          return { behavior: 'allow' };
        }
        const approval = approvalCheckForClaudeTool(toolName, input, opts.cwd);
        if (approval.failClosedReason) {
          return {
            behavior: 'deny',
            message: approval.failClosedReason,
          };
        }
        const invalidateOnAbort = (): void => {
          approvalSessionHandle.invalidatePending?.();
        };
        const { signal } = authorizationOptions;
        if (signal?.aborted) {
          invalidateOnAbort();
          return {
            behavior: 'deny',
            message: 'Approval request cancelled; denied by default.',
          };
        }
        signal?.addEventListener('abort', invalidateOnAbort, { once: true });
        try {
          const requirements = [
            approval,
            ...(approval.additionalRequirements ?? []),
          ];
          for (const requirement of requirements) {
            const outcome = await approvalSessionHandle.check(
              requirement.check,
              {
                title: requirement.titleTool
                  ? `${invocation.providerType === 'claude' ? 'Claude' : 'Agent'} wants to use ${requirement.titleTool}`
                  : (authorizationOptions.title ??
                    `${invocation.providerType === 'claude' ? 'Claude' : 'Agent'} wants to use ${toolName}`),
                details: requirement.details,
                ...(requirement.check.kind === 'command' &&
                typeof input.maxAttempts === 'number' &&
                typeof input.intervalSeconds === 'number'
                  ? {
                      description: `Repeated command in ${opts.cwd}: up to ${input.maxAttempts} attempts, ${input.intervalSeconds} seconds between attempts, 60-second timeout each.`,
                    }
                  : {}),
                suggestedTarget: requirement.suggestedTarget,
                ...(authorizationOptions.toolUseID
                  ? { toolUseId: authorizationOptions.toolUseID }
                  : {}),
                ...(authorizationOptions.agentID
                  ? { subagentId: authorizationOptions.agentID }
                  : {}),
              },
            );
            if (signal?.aborted) {
              return {
                behavior: 'deny',
                message: 'Approval request cancelled; denied by default.',
              };
            }
            if (outcome.decision !== 'allow') {
              return {
                behavior: 'deny',
                message: outcome.message ?? 'The user denied this tool call.',
                ...(outcome.stopTurn ? { interrupt: true } : {}),
              };
            }
          }
          return { behavior: 'allow' };
        } catch {
          return {
            behavior: 'deny',
            message: 'Approval check failed; denied by default.',
          };
        } finally {
          signal?.removeEventListener('abort', invalidateOnAbort);
        }
      };

      const authorizeClaudeToolOnce = (
        toolName: string,
        input: Record<string, unknown>,
        authorizationOptions: {
          title?: string;
          toolUseID?: string;
          agentID?: string;
          signal?: AbortSignal;
        },
      ): Promise<PermissionResult> => {
        const toolUseID = authorizationOptions.toolUseID;
        if (!toolUseID) {
          return authorizeClaudeTool(toolName, input, authorizationOptions);
        }
        const existing = approvalResultsByToolUseId.get(toolUseID);
        if (existing) {
          if (
            existing.toolName !== toolName ||
            !isDeepStrictEqual(existing.input, input)
          ) {
            return Promise.resolve({
              behavior: 'deny',
              message:
                'Conflicting tool input reused an approval identity; denied by default.',
            });
          }
          return existing.result;
        }
        const result = authorizeClaudeTool(
          toolName,
          input,
          authorizationOptions,
        );
        approvalResultsByToolUseId.set(toolUseID, {
          toolName,
          input,
          result,
        });
        return result;
      };

      const canUseTool: CanUseTool = async (
        toolName,
        input,
        canUseToolOptions,
      ): Promise<PermissionResult> => {
        if (toolName !== 'ExitPlanMode') {
          return authorizeClaudeToolOnce(toolName, input, {
            title: canUseToolOptions.title,
            toolUseID: canUseToolOptions.toolUseID,
            agentID: canUseToolOptions.agentID,
            signal: canUseToolOptions.signal,
          });
        }
        let trackedPlan: TrackedPlanData | null = null;
        if (!isCoworkWorkspace(opts.projectId)) {
          try {
            trackedPlan = await upsertTrackedPlan(
              key,
              opts.projectId,
              opts.worktreeId,
              opts.chatId,
              invocation.providerType,
              input,
            );
          } catch {
            // Non-fatal: still fire plan:exit-request without planId
          }
        }
        const win = getWindow();
        const pendingInstruction = trackedPlan
          ? await buildPlanFileSystemInstruction({
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              planId: trackedPlan.id,
            }).catch(() => null)
          : null;
        const planExitEvent: PlanExitRequestEvent = {
          requestId: randomUUID(),
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          source: invocation.providerType,
          reviewMode: 'manual',
          toolInput: input,
          ...(trackedPlan
            ? {
                planId: trackedPlan.id,
                revisionNumber: trackedPlan.latestRevisionNumber,
              }
            : {}),
          ...(pendingInstruction
            ? { pendingSystemInstructions: [pendingInstruction] }
            : {}),
        };
        await commitPendingPlanExit(planExitEvent);
        if (win && !win.isDestroyed()) {
          void sendToWindow(win, IPC_CHANNELS.planExitRequest, planExitEvent);
        }
        // A plan awaiting review is blocked on a human exactly like an approval
        // prompt, and is one of the signals that previously never left the
        // desktop. Cleared when the chat's next turn starts (the user approved,
        // rejected, or kept iterating).
        getAttentionTracker().mark({
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          state: 'needs_input',
          reason: 'plan_review',
          sourceId: 'plan-review',
        });

        planHandoff = { turn: getForegroundTurn() };
        return {
          behavior: 'deny' as const,
          message:
            'Plan shared with the user for review. Stay in plan mode and await their next message.',
          interrupt: true,
        };
      };

      const approvalPreToolUseHook = async (
        input: HookInput,
        toolUseID: string | undefined,
        hookOptions: { signal: AbortSignal },
      ): Promise<HookJSONOutput> => {
        if (
          input.hook_event_name !== 'PreToolUse' ||
          input.tool_name === 'ExitPlanMode'
        ) {
          return { continue: true };
        }
        if (input.tool_name === 'Skill') {
          const turn = skillUsage.claimToolCall(
            toolUseID ?? input.tool_use_id,
            Boolean(input.agent_id),
          );
          if (
            turn &&
            isRecord(input.tool_input) &&
            typeof input.tool_input.skill === 'string'
          ) {
            const inventory = await loadCachedInventory().catch(() => null);
            const token = input.tool_input.skill;
            skillUsage.observeInvocation(
              turn,
              /^[/$]/.test(token) ? token : `/${token}`,
              inventory?.entries.filter(
                (entry) => entry.provider === invocationProvider,
              ) ?? [],
            );
          }
        }
        if (!isRecord(input.tool_input)) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason:
                'Malformed tool input; denied by default.',
            },
          };
        }
        if (
          input.tool_name === 'Read' &&
          codeGraphAvailableThisTurn &&
          codeGraphCustomSourceExtensionsThisTurn === undefined
        ) {
          codeGraphCustomSourceExtensionsThisTurn =
            await loadConfiguredClaudeCodeGraphSourceExtensions(opts.cwd);
        }
        const additionalContext = buildClaudeCodeGraphPreToolUseContext({
          toolName: input.tool_name,
          toolInput: input.tool_input,
          cwd: opts.cwd,
          graphAvailable: codeGraphAvailableThisTurn,
          graphOriented: codeGraphOrientedThisTurn,
          customSourceExtensions: codeGraphCustomSourceExtensionsThisTurn,
        });
        const advisoryContext =
          additionalContext && codeGraphOrientationBlockedThisTurn
            ? additionalContext
            : undefined;
        if (additionalContext && !advisoryContext) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: additionalContext,
              additionalContext,
            },
          };
        }
        // Plan mode's explicit bookkeeping exception: Ledger calls follow the
        // ordinary approval policy, never a Plan mode denial, and carry a
        // reminder that they grant no edits or execution.
        const bookkeepingContext =
          isPlanModeEnabled() &&
          isClaudePlanModeBookkeepingTool(input.tool_name)
            ? CLAUDE_PLAN_MODE_BOOKKEEPING_CONTEXT
            : undefined;
        if (getApprovalMode() === 'full-access') {
          if (isPlanModeEnabled()) {
            // Keep the native planning workflow without letting its permission
            // classifier override the user's Full Access policy.
            const planContext = advisoryContext ?? bookkeepingContext;
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow',
                ...(planContext ? { additionalContext: planContext } : {}),
              },
            };
          }
          if (advisoryContext) {
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                additionalContext: advisoryContext,
              },
            };
          }
          return { continue: true };
        }
        const result = await authorizeClaudeToolOnce(
          input.tool_name,
          input.tool_input,
          {
            toolUseID: toolUseID ?? input.tool_use_id,
            agentID: input.agent_id,
            signal: hookOptions.signal,
          },
        );
        const permissionDecisionReason =
          result.behavior === 'deny'
            ? result.message
            : 'Approved by the application approval policy.';
        if (
          result.behavior === 'deny' &&
          isClaudeCodeGraphToolName(input.tool_name)
        ) {
          codeGraphOrientationBlockedThisTurn = true;
        }
        const modelContext =
          advisoryContext ??
          (result.behavior === 'allow' ? bookkeepingContext : undefined);
        const hookSpecificOutput = {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: result.behavior,
          permissionDecisionReason,
          ...(modelContext ? { additionalContext: modelContext } : {}),
        };
        if (result.behavior === 'deny' && result.interrupt === true) {
          return {
            continue: false,
            stopReason:
              permissionDecisionReason ?? 'Tool call denied and turn stopped.',
            hookSpecificOutput,
          };
        }
        return { hookSpecificOutput };
      };

      const codeGraphPostToolUseHook = (
        input: HookInput,
      ): Promise<HookJSONOutput> => {
        const toolName = 'tool_name' in input ? input.tool_name : undefined;
        if (isClaudeCodeGraphPostToolUse(input.hook_event_name, toolName)) {
          codeGraphOrientedThisTurn = true;
          codeGraphOrientationBlockedThisTurn = false;
        }
        return Promise.resolve({ continue: true });
      };

      const codeGraphSubagentStartHook = (
        input: HookInput,
      ): Promise<HookJSONOutput> => {
        if (
          input.hook_event_name !== 'SubagentStart' ||
          !codeGraphAvailableThisTurn
        ) {
          return Promise.resolve({ continue: true });
        }
        return Promise.resolve({
          hookSpecificOutput: {
            hookEventName: 'SubagentStart',
            additionalContext: CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
          },
        });
      };

      const rtkHooks = buildRtkClaudeHooks({
        rtkBinaryPath,
        env: sdkEnv,
        isEnabled: isRtkEnabled,
      });

      // The Ledger block rides with this session's prompt only while its
      // Ledger tools are exposed.
      const systemPromptAppend = [
        opts.systemPromptAppend,
        managedDelegation?.systemPromptGuidance,
        ledger.tools?.systemPrompt(),
      ]
        .filter(Boolean)
        .join('\n\n');

      const buildSdkOptions = (): QueryOptions => ({
        ...(claudeMaxTurns === null ? {} : { maxTurns: claudeMaxTurns }),
        cwd: opts.cwd,
        abortController,
        pathToClaudeCodeExecutable: getBundledClaudeBinaryPath(),
        spawnClaudeCodeProcess: spawnHostedProcess,
        env: sdkEnv,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          ...(systemPromptAppend ? { append: systemPromptAppend } : {}),
        },
        // The authoritative PreToolUse hook evaluates governed tools before
        // native permission classification, so project instructions can remain
        // available without letting repository allowlists bypass Canopy policy.
        settingSources: ['user', 'project', 'local'],
        // Keep the native permission callback as an independent enforcement
        // path if repository settings disable hooks. Policy-tier `ask` rules
        // outrank repository allowlists while still letting `canUseTool` return
        // the Canopy decision without showing a second prompt.
        ...(approvalMode !== 'full-access'
          ? {
              managedSettings: {
                permissions: { ask: ['*'] },
              },
              // An administrator-managed tier may deliberately drop parent
              // managed settings. Keep the native guard in the highest-
              // priority user-controlled tier as a fallback against repository
              // allowlists; administrator policy remains authoritative.
            }
          : {}),
        ...thinkingOptions,
        // Merge approval fallback and thinking settings (Ultra sets
        // `ultracode`) before applying native-memory suppression so none
        // of the independently owned settings overwrite another.
        ...claudeNativeMemoryOptions(localMemoryEnabled, {
          ...thinkingOptions.settings,
          ...(approvalMode !== 'full-access'
            ? { permissions: { ask: ['*'] } }
            : {}),
        }),
        ...(routedSdkModel ? { model: routedSdkModel } : {}),
        ...(opts.sdkSessionId && !forkResumePointRejected
          ? { resume: opts.sdkSessionId }
          : {}),
        ...(opts.sdkSessionId &&
        opts.claudeForkSession &&
        !forkResumePointRejected
          ? { forkSession: true }
          : {}),
        // Point-in-time fork: resume only the chain entries the forked
        // transcript kept. Meaningless without `resume` + `forkSession`, and
        // the CLI hard-errors on an id it cannot find on the main chain, so
        // it is only ever sent alongside both.
        ...(opts.sdkSessionId &&
        opts.claudeForkSession &&
        isClaudeChainUuid(opts.claudeForkResumeAt) &&
        !forkResumePointRejected
          ? { resumeSessionAt: opts.claudeForkResumeAt }
          : {}),
        ...(sdkPlugins.length > 0 ? { plugins: sdkPlugins } : {}),
        permissionMode: claudePermissionModeFor(
          approvalMode,
          isPlanModeEnabled(),
        ),
        ...(approvalMode === 'full-access'
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        sandbox: {
          ripgrep: {
            command: getBundledRgBinaryPath(),
          },
        },
        hooks: {
          ...rtkHooks,
          PreToolUse: [
            ...(rtkHooks.PreToolUse ?? []),
            { matcher: '*', hooks: [approvalPreToolUseHook] },
            ...(managedDelegation
              ? [
                  {
                    matcher: '*',
                    hooks: [
                      (
                        input: HookInput,
                        toolUseId: string | undefined,
                      ): Promise<HookJSONOutput> => {
                        if (input.hook_event_name !== 'PreToolUse')
                          return Promise.resolve({ continue: true });
                        if (
                          [
                            'Agent',
                            'Task',
                            'TaskOutput',
                            'TaskStop',
                            'SendMessage',
                            'TeamCreate',
                            'TeamDelete',
                          ].includes(input.tool_name)
                        )
                          return Promise.resolve({
                            hookSpecificOutput: {
                              hookEventName: 'PreToolUse',
                              permissionDecision: 'deny',
                              permissionDecisionReason:
                                'Native delegation is unavailable in this managed parent session.',
                            },
                          });
                        if (!managedDelegation.ownsTool(input.tool_name))
                          return Promise.resolve({ continue: true });
                        const bound = managedDelegation.parent.bindClaude(
                          managedDelegation.bareClaudeName(input.tool_name),
                          input.tool_input,
                          toolUseId ?? input.tool_use_id,
                          input.agent_id,
                        );
                        const approvalIdentity = toolUseId ?? input.tool_use_id;
                        const approved =
                          approvalResultsByToolUseId.get(approvalIdentity);
                        // Only this host-minted binding may extend already checked
                        // arguments. Do not strip arbitrary correlation fields in
                        // canUseTool: changed model arguments must still fail closed.
                        if (
                          bound.ok &&
                          approved &&
                          approved.toolName === input.tool_name &&
                          isDeepStrictEqual(approved.input, input.tool_input)
                        ) {
                          const clonedBoundValue: unknown = JSON.parse(
                            JSON.stringify(bound.value),
                          );
                          if (!isRecord(clonedBoundValue))
                            return Promise.resolve({
                              hookSpecificOutput: {
                                hookEventName: 'PreToolUse',
                                permissionDecision: 'deny',
                                permissionDecisionReason:
                                  'Managed tool input could not be retained safely.',
                              },
                            });
                          approvalResultsByToolUseId.set(approvalIdentity, {
                            ...approved,
                            input: clonedBoundValue,
                          });
                        }
                        return Promise.resolve(
                          bound.ok
                            ? {
                                hookSpecificOutput: {
                                  hookEventName: 'PreToolUse',
                                  updatedInput: bound.value,
                                },
                              }
                            : {
                                hookSpecificOutput: {
                                  hookEventName: 'PreToolUse',
                                  permissionDecision: 'deny',
                                  permissionDecisionReason: bound.error.message,
                                },
                              },
                        );
                      },
                    ],
                  },
                ]
              : []),
          ],
          PostToolUse: [
            {
              matcher: '*',
              hooks: [
                codeGraphPostToolUseHook,
                ...(managedDelegation
                  ? [
                      (
                        input: HookInput,
                        toolUseId: string | undefined,
                      ): Promise<HookJSONOutput> => {
                        if (
                          input.hook_event_name === 'PostToolUse' &&
                          !input.agent_id &&
                          managedDelegation.ownsTool(input.tool_name)
                        ) {
                          const callId = toolUseId ?? input.tool_use_id;
                          managedDelegation.parent.acknowledgeTool(
                            callId,
                            `claude:${input.session_id}:${callId}`,
                          );
                        }
                        return Promise.resolve({ continue: true });
                      },
                    ]
                  : []),
              ],
            },
          ],
          SubagentStart: [
            { matcher: '*', hooks: [codeGraphSubagentStartHook] },
          ],
        },
        // Replace app-owned tools and disable native subagents for managed parents.
        disallowedTools: [
          'AskUserQuestion',
          'ScheduleWakeup',
          ...(managedDelegation
            ? [
                'Agent',
                'Task',
                'TaskOutput',
                'TaskStop',
                'SendMessage',
                'TeamCreate',
                'TeamDelete',
              ]
            : []),
        ],
        mcpServers: { ...resolvedMcpServers, ...canopyMcpServers },
        canUseTool,
      });

      // Bounded one-shot recovery for a point-in-time fork whose anchor the
      // CLI cannot find on the source chain (a compacted or replaced session
      // file). That refusal is a hard error — the CLI emits an
      // `error_during_execution` result carrying the reason in `errors` and
      // the SDK iterator then throws — so without this the whole turn fails.
      // We swallow that one result, retry once with genuinely fresh model
      // context, and record the fallback in session diagnostics. Never a
      // second retry: the refusal is deterministic.
      let forkResumeRetryPending = false;
      const canRetryWithoutForkResumePoint = (): boolean =>
        forkResumePointRequested &&
        !forkResumePointRejected &&
        !forkResumePointAccepted;
      const observabilityQueryId = `chat:${key}`;
      const createSdkQuery = (
        prompt: Parameters<typeof claudeQuery>[0]['prompt'],
      ): Query => {
        const queryOptions = buildSdkOptions();
        const resumeSessionId = queryOptions.resume;
        if (invocationProvider === 'claude') {
          getObservabilityService().beginClaudeQuery(
            observabilityQueryId,
            typeof resumeSessionId === 'string' && resumeSessionId.trim()
              ? {
                  sessionId: resumeSessionId,
                  fork: queryOptions.forkSession === true,
                }
              : undefined,
          );
        }
        try {
          return claudeQuery({ prompt, options: queryOptions });
        } catch (error) {
          if (invocationProvider === 'claude') {
            getObservabilityService().endClaudeQuery(observabilityQueryId);
          }
          throw error;
        }
      };
      const startAttempt = (): Query => {
        const prompt = nextPromptAttempt();
        const attempt = __CANOPY_E2E__
          ? createE2eClaudeQueryWithPrelude({
              scope: {
                projectId: opts.projectId,
                worktreeId: opts.worktreeId,
                chatId: opts.chatId,
              },
              prompt,
              createQuery: createSdkQuery,
            })
          : createSdkQuery(prompt);
        setQueryRef(attempt);
        // Every attempt starts a fresh CLI process, which owns no background
        // tasks yet. The SDK emits no `background_tasks_changed` at startup,
        // and `system`/`init` arrives every turn, so this process boundary is
        // the authoritative point at which to clear the prior live set.
        resetSessionLiveBackgroundTasks(key);
        recordSessionEvent(key, {
          type: 'phase',
          phase: 'claude.query_started',
        });
        return attempt;
      };

      let queryResult = startAttempt();
      for (;;) {
        try {
          for await (const message of queryResult) {
            if (message) {
              const data = structuredClone(message) as Record<string, unknown>;
              if (
                (opts.claudeForkStartsFresh || forkResumePointRejected) &&
                data.type === 'system' &&
                data.subtype === 'init'
              ) {
                data.canopy_fork_model_context = 'fresh';
              }
              if (
                canRetryWithoutForkResumePoint() &&
                isClaudeForkResumePointRejection(data)
              ) {
                // Suppress the refusal result so the renderer never sees a
                // failed turn for an anchor we are about to stop sending.
                forkResumeRetryPending = true;
                continue;
              }
              if (forkResumePointRequested && !forkResumePointRejected) {
                forkResumePointAccepted = true;
                bufferedPrompts.length = 0;
              }
              const rejectionStatus =
                modelGatewayCredentialRejectionStatus(data);
              if (orgGatewayOrganizationId && rejectionStatus) {
                await markOrgGatewayCredentialRejected(
                  orgGatewayOrganizationId,
                  rejectionStatus,
                  orgGatewayCredentialVersion,
                );
              }
              if (isClaudeTaskNotificationPreludeResult(data)) {
                // This is a resumed-session side channel, never a foreground
                // terminal. When a prompt is pending or active, preserve normal
                // turn stamping and tell downstream consumers the session remains
                // open. With no foreground owner, consume it silently rather than
                // attaching background activity to a chat turn.
                if (hasForegroundTurn()) {
                  data.canopy_session_continues = true;
                  const admission = emitEvent(data);
                  if (admission) await admission;
                }
                continue;
              }
              const foregroundTurn = getForegroundTurn();
              if (
                invocationProvider === 'claude' &&
                data.type === 'assistant' &&
                (!('parent_tool_use_id' in data) ||
                  data.parent_tool_use_id == null) &&
                foregroundTurn &&
                isRecord(data.message) &&
                isRecord(data.message.usage)
              ) {
                const endTokens = claudeContextEndTokens(data.message.usage);
                if (endTokens !== undefined) {
                  lastRootAssistantContext = {
                    turn: foregroundTurn,
                    endTokens,
                  };
                }
              }
              if (
                invocationProvider === 'claude' &&
                data.type === 'result' &&
                foregroundTurn
              ) {
                const endTokens =
                  lastRootAssistantContext?.turn === foregroundTurn
                    ? lastRootAssistantContext.endTokens
                    : undefined;
                captureClaudeContextSnapshot({
                  summary: getContextUsageForClaudeSession(
                    opts.projectId,
                    opts.worktreeId,
                    opts.chatId,
                  ),
                  includeCategories: true,
                  ...(endTokens === undefined ? {} : { endTokens }),
                  ...(foregroundTurn.userMessageId
                    ? { userMessageId: foregroundTurn.userMessageId }
                    : {}),
                  onSnapshot: (snapshot): void => {
                    getObservabilityService().observeChatEvent(
                      opts.projectId,
                      opts.worktreeId,
                      opts.chatId,
                      snapshot,
                    );
                  },
                });
                lastRootAssistantContext = undefined;
              }
              const isTerminal =
                data.type === 'error' || data.type === 'result';
              if (isTerminal) {
                // The SDK reports the interrupt that hands a plan to review
                // as an aborted tool call; mark it so it settles as done.
                if (
                  data.type === 'result' &&
                  data.terminal_reason === 'aborted_tools' &&
                  planHandoff !== undefined &&
                  planHandoff.turn === getForegroundTurn()
                ) {
                  data.canopy_plan_handoff = true;
                }
                planHandoff = undefined;
                terminalEmitted = true;
                terminalTurn = getForegroundTurn();
                markTurnIdle(key);
              }
              // Forward through emitEvent so every SDK event is recorded and
              // stamped with active turn metadata before it reaches the
              // renderer.
              const admission = emitEvent(data);
              if (admission) await admission;
              if (isTerminal) {
                clearActiveTurn();
              }
            }
          }
        } catch (error: unknown) {
          if (
            !canRetryWithoutForkResumePoint() ||
            !(forkResumeRetryPending || isClaudeForkResumePointRejection(error))
          ) {
            throw error;
          }
          forkResumeRetryPending = true;
        } finally {
          if (invocationProvider === 'claude') {
            getObservabilityService().endClaudeQuery(observabilityQueryId);
          }
        }
        // A cancelled turn is not recovered: the outer catch owns the abort
        // shape, and a retry would only race the teardown it is part of.
        if (
          !(canRetryWithoutForkResumePoint() && forkResumeRetryPending) ||
          abortController.signal.aborted
        ) {
          break;
        }
        forkResumePointRejected = true;
        forkResumeRetryPending = false;
        terminalEmitted = false;
        terminalTurn = undefined;
        recordSessionEvent(key, {
          type: 'phase',
          phase: 'claude.fork_resume_point_rejected',
        });
        getObservabilityService().recordSessionDiagnostic({
          version: 1,
          timestamp: new Date().toISOString(),
          kind: 'claude_fork_resume_point_rejected',
          sessionKey: key,
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          providerType: 'claude',
          recoveryStrategy: 'restarted',
        });
        replayBufferedPrompts = true;
        queryResult = startAttempt();
      }
    } catch (error: unknown) {
      terminalEmitted = true;
      terminalTurn = getForegroundTurn();
      markTurnIdle(key);
      // The SDK surfaces a user-initiated abort in more than one shape: a
      // DOMException-style AbortError, or a plain Error('Operation aborted')
      // thrown by the transport when a write lands after abort() (its abort
      // error class extends Error without overriding `name`, so a `name`
      // check alone misses it). Treat any error raised while our own abort
      // signal is set as a clean cancellation, emitting a result so the
      // renderer closes the turn timer, resets status, and flushes queued
      // messages instead of surfacing a spurious error.
      if (
        abortController.signal.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        // Replacing or unloading an idle session must not emit an uncorrelated
        // terminal event into the chat. The renderer may already have opened
        // the replacement turn's optimistic timer, and an idle teardown has no
        // active user-message id with which to distinguish its result from that
        // newer turn. Active-turn destroys still emit the normal correlated
        // cancellation so their timer closes.
        if (shouldEmitTerminalEvent()) {
          const terminalAdmission = emitEvent({
            type: 'result',
            is_error: false,
            result: 'Session aborted',
          });
          if (terminalAdmission) await terminalAdmission;
        }
        clearActiveTurn();
        return;
      }
      const errorCode = getProviderErrorCode(error);
      const rejectionStatus = modelGatewayCredentialRejectionStatus(error);
      if (orgGatewayOrganizationId && rejectionStatus) {
        await markOrgGatewayCredentialRejected(
          orgGatewayOrganizationId,
          rejectionStatus,
          orgGatewayCredentialVersion,
        );
      }
      // An iterator rejection is also a settled root failure. Preserve quota
      // recovery without admitting child errors or advance limit notices.
      if (terminalTurn) {
        const interruption = buildAccountProxyUsageLimitedEntry(
          {
            projectId: opts.projectId,
            worktreeId: opts.worktreeId,
            chatId: opts.chatId,
            provider: 'claude',
            detectedAt: Date.now(),
            accountProxyConnectionId,
          },
          error,
        );
        if (interruption) await recordUsageLimitedChat(interruption);
      }
      const errorAdmission = emitEvent({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
        ...(errorCode === OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE
          ? {
              error_code: OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE,
              provider: 'ollama',
            }
          : {}),
      });
      if (errorAdmission) await errorAdmission;
      clearActiveTurn();
    } finally {
      stopAccountProxySwitches?.();
      try {
        // The query loop is gone; the chat's delegations outlive it.
        managedDelegation?.detach();
      } finally {
        // Current foreground ownership is the completion authority. A terminal
        // clears that ownership immediately; if a later queued turn is still
        // pending when this reused SDK query exits, it remains owned and needs
        // its own correlated safety-net terminal regardless of what an earlier
        // turn emitted.
        const unfinishedTurn = getForegroundTurn();
        if (
          shouldEmitTerminalEvent() &&
          (!terminalEmitted ||
            (unfinishedTurn !== undefined && unfinishedTurn !== terminalTurn))
        ) {
          markTurnIdle(key);
          try {
            const terminalAdmission = emitEvent({
              type: 'result',
              is_error: false,
              result: 'Session ended',
            });
            if (terminalAdmission) await terminalAdmission;
          } catch (error) {
            logMainProcessError(
              `Failed to route Claude terminal event for ${opts.projectId}/${opts.worktreeId}/${opts.chatId}`,
              error,
            );
          }
        }
        clearActiveTurn();
        rejectAllForSession(key);
        approvalSession?.dispose();
        ledger.tools?.dispose();
        trackedPlansBySession.delete(key);
        queryRefs.delete(key);
        getMcpHttpProxyService().unregisterRoutesForSession(key);
        getCodexGatewayProxyService().unregisterRoutesForSession(key);
        getMcpHttpProxyService().unregisterCanopyWorktreeSessionRoute(key);
        unregisterSession(key);
      }
    }
  }
}
import { authorizeInstalledItemUninstall } from '../installed-items/installed-item-approval';
