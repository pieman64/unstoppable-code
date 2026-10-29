import { chatVisualsEligible } from '../lib/chat-visuals-feature-flag';
import { createShowVisualHost } from '../canopy-tools/show-visual-host';
import { withProxyFailureRestored } from './ai-credits-proxy-failure-restore';
import { SkillUsageTracker } from './skill-usage-tracker';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import {
  codexSpeedFastMode,
  codexSpeedFromFastMode,
  type CodexSpeed,
} from '@canopy/desktop-shared/lib/codex-speed';
import {
  admitCodexSpeed,
  codexSpeedGatewayForOrigin,
  reportCodexSpeedTurnFailure,
} from '../codex/speed-policy';
import {
  APP_ADVISOR_TOOL_REGISTRY,
  getAppAdvisorLedgerToolNames,
} from '@canopy/desktop-shared/lib/app-advisor-tools';
import { watchCommandSchema } from '../canopy-tools/local-watcher-definitions';
import type { BrowserWindow } from 'electron';
import { managedDelegationEnabled } from './delegation/gate';
import type { ManagedDelegationSession } from './delegation/service';
import { randomUUID } from 'node:crypto';
import { BRAND } from '@canopy/brand/current';
import { AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG } from '@canopy/protocol';
import { isAiCreditsFailureEventShape } from '@canopy/agent-transcript';
import { ASK_USER_TIMEOUT_MS } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import type {
  AgentProvider,
  AgentSession,
  AgentSessionOptions,
  AgentSessionSendOptions,
} from './types';
import {
  buildCodexProxyConfigObject,
  buildOrgGatewayCodexBaseUrl,
  buildProxyBaseUrl,
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
import { checkModelGatewayRoute } from '../lib/model-gateway-state';
import { getMockLlmOrigin } from '../lib/e2e-mock-control-plane';
import {
  isGatewayOnlyModel,
  isUnavailableModelSelection,
  resolveCodexReasoningRouteFamily,
  resolveGatewayToolSchemaProfile,
} from '@canopy/desktop-shared/lib/gateway-model-availability';
import { getCodexGatewayProxyService } from './codex-gateway-proxy-service';
import { ensureGatewayCompatibleCodexCatalog } from '../codex/gateway-model-catalog';
import {
  isProviderNativelyAuthenticated,
  isProviderNativelyAuthenticatedForRouting,
} from '../auth/provider-auth-state';
import { isCodeGraphAvailableForWorkspace } from '../lib/code-graph-availability';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import {
  clearSessionProxyFailure,
  consumeSessionProxyFailure,
  detectCodexQuotaReached,
  detectAiCreditsNoBillingSource,
  markProviderQuotaReached,
} from './ai-credits-quota-state';
import { recordUsageLimitedChat } from '../lib/usage-limited-chats-registry';
import {
  buildUsageLimitedEntry,
  buildAccountProxyUsageLimitedEntry,
  classifyAccountChangeResumeReason,
} from '../lib/usage-limited-chats-recording';
import { classifyAgentFailure } from '@canopy/desktop-shared/agent-failures';
import { buildProviderAuthFailureEvent } from './provider-auth-failure-event';
import { resolveWorkspaceRecordingSnapshot } from '../lib/resolve-workspace-display-name';
import {
  SET_AUTO_ARCHIVE_REQUESTED_EVENT_TYPE,
  hasAnySelections,
  IPC_CHANNELS,
  CODE_REVIEW_CHAT_PROJECT_ID,
  DEFAULT_CODEX_APP_SERVER_IDLE_TIMEOUT_MINUTES,
  buildNoBillingSourceError,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CREDITS_CODEX_MODEL,
  resolveModelAlias,
  NO_BILLING_SOURCE_ERROR_CODE,
  resolveProviderModelConfig,
  type ApprovalMode,
  type CanopyAuthFailureEventData,
  type ResolvedAgentModelConfig,
  type ChatTabPluginSelections,
  type ChatModel,
  type ThinkingLevel,
  type PlanExitRequestEvent,
} from '@canopy/desktop-shared/types';
import {
  createApprovalSession,
  type ApprovalSessionHandle,
} from '../approvals/approval-service';
import {
  registerSession,
  unregisterSession,
  buildSessionKey,
  markTurnActive,
  markTurnAwaitingUser,
  markTurnIdle,
  markSessionForNextTurnRecreation,
  noteSessionMessageQueued,
  recordSessionEvent,
  createSessionPhaseTimer,
  isSessionAccountProxyRouted,
  isSessionAiCreditsRouted,
  recordSessionAccountProxyRoute,
} from './session-manager';
import { CodexAppServerClient } from '../codex/app-server-client';
import { getDesktopCodexCapabilityStore } from '../codex/capability-store';
import { getCodexRuntimeService } from '../codex/runtime-service';
import {
  loadCodexForkContinuation,
  loadPersistedCodexFallbackSeedItems,
} from '../codex/transcript-seed';
import { waitForPendingCodexFork } from '../codex/fork-thread';
import { handleCanopyDynamicToolCall } from '../codex/canopy-dynamic-tools';
import {
  mayExposeLedgerTools,
  openLedgerChatTools,
  type LedgerChatTarget,
  type LedgerChatToolsSession,
} from '../canopy-tools/ledger-tools-runtime';
import { buildLedgerPlanModeInstruction } from '../canopy-tools/prompting';
import { handleAppAdvisorDynamicToolCall } from '../app-advisor/codex-dynamic-tools';
import { handlePipelineEditorDynamicToolCall } from '../pipeline-editor/codex-dynamic-tools';
import { buildCodexSessionDynamicToolSpecs } from '../codex/session-dynamic-tools';
import { sendToWindow } from '../lib/window-send';
import { noteChatSessionEvent } from '../lib/transient-error-retry-service';
import { getAttentionTracker } from '../services/attention-tracker';
import { commitPendingPlanExit } from '../services/chat-state-plan-exit';
import {
  isCodexSubagentTerminalEvent,
  readCodexRootThreadId,
} from '../lib/chat-turn-audit';
import {
  codexAggregateSkillInvocationNamesForRefs,
  resolveEffectivePluginSelectionRefs,
  resolvePlugins,
  type ResolvedPlugins,
} from '../plugins/plugin-resolver';
import { resolveEffectiveChatPluginContext } from '../plugins/global-plugin-overlay';
import { loadCachedInventory } from '../plugins/invocable-inventory-service';
import {
  matchInvocationEntry,
  normalizeInvocationToken,
  type InvocationTokenInventoryEntry,
} from '../plugins/invocation-prefix-normalizer';
import { BUILTIN_APP_PLUGIN_NAME } from '../plugins/codex-plugin-compat';
import { resolveCodexMockAppServerOverride } from '@canopy/desktop-shared/node/e2e-mock-env';
import { getMcpHttpProxyService } from '../mcp/http-proxy-service';
import { getObservabilityService } from '../observability';
import { logMainProcessWarn } from '../lib/main-process-logging';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
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
import { codexNativeMemoryThreadConfig } from '@canopy/desktop-shared/node/lib/native-memory';
import { readLocalMemoryEnabledPreference } from '../lib/preferences-store';
import {
  mainWindowOnlyToolSurfaces,
  requestShowFiles,
} from '../canopy-tools/show-files-runtime';
import type { JsonValue } from '@canopy/desktop-shared/node/codex-runtime/generated/serde_json/JsonValue';
import type { ThreadStartParams } from '@canopy/desktop-shared/node/codex-runtime/generated/v2/ThreadStartParams';
import { CODEX_PROJECT_DOC_THREAD_CONFIG } from '@canopy/desktop-shared/node/codex-runtime/thread-config';
import { classifyCodexTransportError } from '@canopy/desktop-shared/node/codex-runtime/transport-errors';
import type { CodexConfig } from '@canopy/desktop-shared/lib/codex-model-config';
import {
  resolveCodexRuntimeEnvironmentProfile,
  type CodexRuntimeEnvironmentProfile,
} from '../lib/user-environment-runtime';

function isUnknownDynamicToolError(message: string | undefined): boolean {
  if (!message) return false;
  return /unknown\s+dynamic\s+tool|dynamic\s+tool\s+(?:unknown|not\s+found)/i.test(
    message,
  );
}

async function resolveCodexStandaloneInvocationEntries(
  selections: ChatTabPluginSelections,
): Promise<InvocationTokenInventoryEntry[]> {
  try {
    const warnings: string[] = [];
    const effectiveRefs = await resolveEffectivePluginSelectionRefs(
      selections,
      warnings,
    );
    const generatedNames = codexAggregateSkillInvocationNamesForRefs(
      effectiveRefs.skillRefs,
      warnings,
    );
    return Array.from(generatedNames.values(), (generatedName) => ({
      invocationKey: `$${BUILTIN_APP_PLUGIN_NAME}:${generatedName}`,
      kind: 'skill',
      name: generatedName,
    }));
  } catch {
    return [];
  }
}

/**
 * An ITEM-level field of a persisted history entry: `input[7].content`,
 * `input.7.encrypted_content`, `input[2].type`.
 *
 * Anchoring on the item-level field is what separates "the provider rejected a
 * history item it cannot decode" from an ordinary parameter error about the
 * request's reasoning *settings* (`invalid_value for 'input[0].reasoning.effort'`).
 * A nested path such as `input[N].reasoning.<anything>` deliberately does not
 * match: the recovery this gates is destructive (the live thread is abandoned,
 * a new sdkSessionId is persisted, and the whole history is re-injected with
 * reasoning stripped).
 */
const INCOMPATIBLE_REASONING_HISTORY_ITEM_FIELD =
  /input(?:\[\d+\]|\.\d+)\.(?:encrypted_content|content|type|internal_chat_message_metadata_passthrough)\b/i;

function isStaleProxyRouteError(message: string | undefined): boolean {
  return (
    message !== undefined && /proxy route is no longer available/i.test(message)
  );
}

const MAX_STALE_PROXY_ROUTE_RECOVERIES = 3;

function isIncompatibleReasoningHistoryError(
  message: string | undefined,
): boolean {
  if (!message) return false;
  if (!INCOMPATIBLE_REASONING_HISTORY_ITEM_FIELD.test(message)) return false;
  // Also require a shape/recognition failure. A bare `invalid` is deliberately
  // excluded so an unrelated validation error on the same item cannot reach
  // the destructive rebuild.
  return /(?:array_above_max_length|unknown|unrecognized|unsupported|extra_forbidden|invalid_type|invalid_value|not\s+(?:permitted|allowed|supported))/i.test(
    message,
  );
}

/**
 * Session-wide ceiling on incompatible-reasoning rebuilds. The budget itself is
 * per thread, but each rebuild produces a *new* thread id, so a route that
 * rejects every rebuilt thread would otherwise rebuild forever on one queued
 * message. This bounds that pathological case while leaving room for genuinely
 * independent poisoned threads in a long-lived session.
 *
 * **Known trade-off: the ceiling counts session-wide and the recorded set is
 * never pruned on success.** Three *successful* self-heals in one long-lived
 * session therefore exhaust the budget for a genuinely new poisoned thread,
 * which partially defeats the per-thread motivation. Pruning an entry once its
 * rebuild succeeds is deliberately not implemented: the entry recorded is the
 * *failed* thread id, the rebuild replaces it with a new id, and "success" here
 * is only "this turn completed" — a route that alternates completed and
 * rejected turns could then re-enter the rebuild loop indefinitely on the same
 * conversation. Bounding the pathological case is worth the rare false
 * exhaustion; revisit only with a durable per-thread attempt record.
 */
const MAX_INCOMPATIBLE_REASONING_HISTORY_REBUILDS = 3;

const CODEX_PLUGIN_RESOLUTION_RETRY_DELAYS_MS = [150, 750, 2_000, 5_000];
const SESSION_DESTROYED_ERROR_MESSAGE = 'session_destroyed';

interface QueuedCodexMessage {
  text: string;
  userMessageId?: string;
  revivesSettledTurn?: boolean;
  staleProxyRouteRetried?: boolean;
  staleProxyRouteRecoverySignal?: AbortSignal;
  countsTowardSkillUsage?: boolean;
  skillUsageTurnId?: string;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSessionDestroyedError(error: unknown): boolean {
  return (
    error instanceof Error && error.message === SESSION_DESTROYED_ERROR_MESSAGE
  );
}

function withTurnMetadata(
  data: unknown,
  turn: QueuedCodexMessage | undefined,
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
    ...(turn.revivesSettledTurn ? { canopy_turn_revival: true } : {}),
  };
}

/**
 * Whether this event is the failure the proxy's pending verdict describes.
 * Mirrors the wrapper unwrap `detectAiCreditsNoBillingSource` performs, and
 * defers the shape rule itself to `@canopy/agent-transcript` so main does not
 * grow a second copy that can drift from the renderer's.
 */
function isAiCreditsFailureEvent(data: unknown): boolean {
  if (!isRecord(data)) return false;
  if (data.type === 'codex') {
    return isAiCreditsFailureEventShape(data.event, 'codex');
  }
  return isAiCreditsFailureEventShape(data, 'claude');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a Codex thread has a capability record. Every thread started,
 * rebuilt or forked since capability records exist has one. A resumed thread
 * without one predates them and keeps the dynamic tools it started with, so
 * it can never have the Ledger tools. An unreadable record counts as absent.
 */
async function hasCodexCapabilityRecord(threadId: string): Promise<boolean> {
  try {
    return (
      (await getDesktopCodexCapabilityStore().readLease(threadId)) !== null
    );
  } catch {
    return false;
  }
}

function appendPluginMcpDiscoveryInstructions(
  developerInstructions: string | undefined,
  mcpServersConfig: ResolvedPlugins['codexMcpServers'] | undefined,
): string | undefined {
  const serverIds = Object.keys(mcpServersConfig ?? {}).sort();
  if (serverIds.length === 0) {
    return developerInstructions;
  }

  const discoveryInstructions = [
    'Selected plugin MCP servers configured for this chat:',
    ...serverIds.map((serverId) => `- ${serverId}`),
    '',
    'MCP resource and resource-template listings are not complete server inventories: tool-only plugin MCP servers do not appear in them. When asked which MCP servers or plugin capabilities are available, or when a selected plugin could help, use Codex tool search to inspect ALL_TOOLS for matching MCP tools before concluding that a server is unavailable.',
  ].join('\n');

  const baseInstructions = developerInstructions?.trim();
  return baseInstructions
    ? `${baseInstructions}\n\n${discoveryInstructions}`
    : discoveryInstructions;
}

function recordPluginResolutionRetry(
  key: string,
  reason: 'resolution_error',
  attempt: number,
  retryDelayMs: number,
  details: unknown,
): void {
  recordSessionEvent(key, {
    type: 'phase',
    phase: 'codex.resolve_plugins.retry',
    reason,
    attempt,
    retryDelayMs,
    details,
  });
}

/**
 * Sentinel returned by `resolveCodexAiCreditsRouting` when the defensive
 * backstop fires: the resolver has already emitted a clear error and the caller
 * must abort the session instead of falling back to native provider auth.
 */
const AI_CREDITS_BACKSTOP_ABORT = 'backstop-abort';

/**
 * Message on the internal error thrown to unwind `ensureClient` after the AI
 * Credits backstop fired. The catch handlers recognize it and end the session
 * cleanly without re-emitting a second error over the already-emitted backstop
 * message.
 */
const AI_CREDITS_BACKSTOP_ABORT_ERROR = 'ai_credits_backstop_abort';

export interface CodexCompatibleInvocation {
  runtimeModel?: string;
  envOverride?: Record<string, string>;
  codexConfig?: CodexConfig;
}

interface CodexProviderOptions {
  providerType?: 'codex' | 'ollama';
  prepareInvocation?: (
    model: ChatModel | undefined,
    reason: 'session-start' | 'model-change',
  ) => Promise<CodexCompatibleInvocation>;
}

function mergeCodexConfig(
  base: CodexConfig | undefined,
  overlay: CodexConfig | undefined,
): CodexConfig | undefined {
  if (!base) return overlay;
  if (!overlay) return base;
  const baseProviders =
    typeof base.model_providers === 'object' &&
    base.model_providers !== null &&
    !Array.isArray(base.model_providers)
      ? base.model_providers
      : {};
  const overlayProviders =
    typeof overlay.model_providers === 'object' &&
    overlay.model_providers !== null &&
    !Array.isArray(overlay.model_providers)
      ? overlay.model_providers
      : {};
  return {
    ...base,
    ...overlay,
    ...(base.model_providers || overlay.model_providers
      ? {
          model_providers: {
            ...baseProviders,
            ...overlayProviders,
          },
        }
      : {}),
  };
}

/**
 * Resolve AI Credits gateway routing for a Codex session, if active. Returns
 * the proxy token env plus the `-c` app-server config overrides that register
 * the gateway model provider, `'backstop-abort'` when the backstop error was
 * emitted and the caller must not spawn the session, or `null` when routing is
 * inactive / not a Codex-harness model / no cloud context is available.
 */
async function resolveCodexAiCreditsRouting(
  opts: AgentSessionOptions,
  emit: (data: unknown) => void | Promise<void>,
): Promise<
  | {
      config: NonNullable<ThreadStartParams['config']>;
      selectedModel: string;
      gatewayModel: string;
      supportedThinkingLevels: readonly ThinkingLevel[];
      modelCatalogPath?: string;
    }
  | typeof AI_CREDITS_BACKSTOP_ABORT
  | null
> {
  if (opts.providerType === 'ollama') return null;
  let nativeAuthPromise: Promise<boolean> | undefined;
  const checkNativeAuth = (): Promise<boolean> =>
    (nativeAuthPromise ??= isProviderNativelyAuthenticatedForRouting(
      'codex',
      'ai-credits-routing',
    ));
  const attempt = await resolveAiCreditsRoutingAttempt(
    opts.aiCreditsRouting,
    'codex',
    checkNativeAuth,
    opts.subscriptionBillingOverride,
  );
  const gatewayCheck = await checkModelGatewayRoute(
    opts.model,
    await resolveSessionWorkOwner(opts),
  );
  if (!gatewayCheck.ok) throw new Error(gatewayCheck.message);
  const gatewayEnforced = gatewayCheck.orgRoute;
  // See the matching guard in `claude-session.ts`: the auth probe runs without
  // the Canopy Environments injector the spawn uses, so a user who supplies
  // `OPENAI_API_KEY` through Environments reads as signed out here while having
  // a working provider at spawn time. Fall through to native rather than
  // routing (and billing) around their own credential.
  if (
    attempt?.reason === 'no-native-auth' &&
    !gatewayEnforced &&
    hasUserSuppliedProviderCredential('codex', opts.projectId)
  ) {
    return null;
  }
  // An omitted model needs a gateway default whenever credits routing is
  // requested, regardless of the activation reason.
  const selectedModel =
    attempt?.modelId ??
    opts.model ??
    (attempt ? DEFAULT_CREDITS_CODEX_MODEL : undefined);
  if (isUnavailableModelSelection(selectedModel, 'codex')) {
    await emit({
      type: 'error',
      error:
        'This model is no longer available. Pick another model to continue.',
    });
    return AI_CREDITS_BACKSTOP_ABORT;
  }
  // A gateway-only model can never be billed via a native Codex login, so it
  // must always route through the gateway — even when the attempt resolver
  // returns null (e.g. a natively-authenticated user with routing mode off who
  // selected it anyway). The picker greys such rows without credits, but the
  // session must be robust to a forced/restored selection.
  // Helpers pass the native default explicitly, including saved retired
  // aliases. Without native auth, use its credits counterpart while retaining
  // the selected model as the session's route-cache key.
  const entry =
    resolveGatewayModelEntry(selectedModel) ??
    (attempt &&
    !gatewayEnforced &&
    selectedModel !== undefined &&
    resolveModelAlias(selectedModel) === DEFAULT_CODEX_MODEL &&
    !(await checkNativeAuth())
      ? resolveGatewayModelEntry(DEFAULT_CREDITS_CODEX_MODEL)
      : undefined);
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
    // they also have no native Codex login, surface a clear error instead of
    // falling through to a raw native provider auth failure (a 401). The picker
    // (Part B) prevents this, but the global routing modes ('on'/'on-quota')
    // resolve an attempt *before* native auth is ever consulted, so a
    // reason of 'mode'/'session-override' alone does not tell us whether the
    // user can fall back to a native spawn — re-check native auth here.
    // (`gatewayOnly` is false in this branch, so `attempt` is non-null.)
    const nativelyAuthenticated =
      attempt?.reason === 'no-native-auth'
        ? false
        : await isProviderNativelyAuthenticated('codex', 'ai-credits-routing');
    if (!nativelyAuthenticated) {
      await emit({
        type: 'error',
        error:
          "This model can't be used with AI Credits and you're not signed in to Codex. Sign in to Codex or pick a model covered by AI Credits.",
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
      const modelCatalogPath = await ensureGatewayCompatibleCodexCatalog();
      const mockLlmOrigin = getMockLlmOrigin();
      const requestBaseUrl = mockLlmOrigin ?? credential.baseUrl;
      const route = await getCodexGatewayProxyService().registerRoute({
        sessionId: buildSessionKey(
          opts.projectId,
          opts.worktreeId,
          opts.chatId,
        ),
        upstreamUrl: buildOrgGatewayCodexBaseUrl(requestBaseUrl),
        allowedPaths: ['/responses'],
        resolveToken: async () => {
          const refreshed = await resolveOrgGatewayCredential(
            entry,
            attribution.workOwner,
          );
          return {
            token: refreshed.apiKey,
            credentialVersion: refreshed.credentialVersion,
          };
        },
        stripCacheControl: entry.promptCachePassthrough === false,
        onCredentialRejected: (status, credentialVersion) =>
          markOrgGatewayCredentialRejected(
            entry.organizationId ?? '',
            status,
            credentialVersion,
          ),
      });
      return {
        config: buildCodexProxyConfigObject(entry, route.baseUrl, attribution),
        selectedModel: selectedModel ?? entry.modelId,
        gatewayModel: entry.gatewayId,
        supportedThinkingLevels: [...entry.supportedThinkingLevels],
        ...(modelCatalogPath ? { modelCatalogPath } : {}),
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
      // This abort is the STEADY-STATE out-of-credits experience, not an edge
      // case: once the balance reads zero the turn never reaches the gateway at
      // all, so the mid-turn 402 (and every signal derived from it) never
      // happens again. It therefore has to raise the recovery surface itself.
      //
      // It cannot rely on the banner's derived pre-flight condition the sibling
      // `no-native-auth` branch below leans on. `derived` requires
      // `!availability.nativeAuth`, and this branch is reachable precisely
      // BECAUSE a gateway-only model was picked — which a natively signed-in
      // user can do. For them `derived` is false forever, which is the same
      // blind spot CAN-2413 added the runtime signal to bypass. Without this
      // emit, the abort renders nothing anywhere: the reducer turns a bare
      // `error` event into `state.error` with ZERO transcript messages, so the
      // user gets no response, no error, and no banner.
      await emitAiCreditsNoBillingSource(emit, 'codex');
      await emit({
        type: 'error',
        // Stamped so the reducer persists `aiCreditsNoBillingSource` on the tab
        // and the banner survives a reload, exactly like a failed routed turn.
        [AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG]: true,
        error_code: NO_BILLING_SOURCE_ERROR_CODE,
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
        error: buildNoBillingSourceError('Codex', BRAND.displayName),
      });
      return AI_CREDITS_BACKSTOP_ABORT;
    }
    return null;
  }
  const modelCatalogPath = await ensureGatewayCompatibleCodexCatalog();
  const route = await getCodexGatewayProxyService().registerRoute({
    sessionId: buildSessionKey(opts.projectId, opts.worktreeId, opts.chatId),
    upstreamUrl: buildProxyBaseUrl(context.cloudBaseUrl, 'codex'),
    allowedPaths: ['/responses'],
    resolveToken: async () => {
      const refreshed = await getAiCreditsRoutingContext({
        owner: attribution.workOwner,
        forceRefresh: true,
      });
      return refreshed?.accountIdentity === context.accountIdentity
        ? refreshed.cskToken
        : null;
    },
  });
  return {
    config: buildCodexProxyConfigObject(entry, route.baseUrl, attribution),
    selectedModel: selectedModel ?? entry.modelId,
    gatewayModel: entry.gatewayId,
    supportedThinkingLevels: [...entry.supportedThinkingLevels],
    ...(modelCatalogPath ? { modelCatalogPath } : {}),
  };
}

export class CodexProvider implements AgentProvider {
  private readonly providerType: 'codex' | 'ollama';
  private readonly prepareInvocation?: CodexProviderOptions['prepareInvocation'];

  constructor(options?: CodexProviderOptions) {
    this.providerType = options?.providerType ?? 'codex';
    this.prepareInvocation = options?.prepareInvocation;
  }

  createSession(
    opts: AgentSessionOptions,
    onEvent: (data: unknown) => void | Promise<void>,
    getWindow: () => BrowserWindow | null,
  ): AgentSession {
    const key = buildSessionKey(opts.projectId, opts.worktreeId, opts.chatId);
    const pluginRouteOwnerId = `codex-session:${key}:${randomUUID()}`;
    /** Ends the transcript's account switch lines (CAN-4021). */
    let stopAccountProxySwitches: (() => void) | undefined;
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
      providerType: this.providerType,
      executionHarness: 'codex',
      codeGraphToolsAdvertised,
      // One live list: the approval session adds grants to it, and managed
      // delegates evaluate their approvals against it.
      sessionApprovalRules: opts.sessionApprovalRules ?? [],
    };
    const sessionAbort = new AbortController();

    let accountProxyConnectionId: string | undefined;
    const messageQueue: QueuedCodexMessage[] = [];
    const skillUsage = new SkillUsageTracker(opts);
    let waitingForMessage:
      | ((msg: QueuedCodexMessage | undefined) => void)
      | null = null;
    let currentModelConfig: ResolvedAgentModelConfig =
      resolveProviderModelConfig(
        'codex',
        {
          thinkingLevel: opts.thinkingLevel,
          modelConfig: opts.modelConfig,
          codexFastModeEnabled: opts.codexFastModeEnabled,
        },
        undefined,
      );
    function setRequestedCodexSpeed(speed: CodexSpeed): void {
      currentModelConfig = {
        ...currentModelConfig,
        speed,
        fastMode: codexSpeedFastMode(speed),
      };
    }
    let currentThinkingLevel: ThinkingLevel = currentModelConfig.thinkingLevel;
    let currentModel: ChatModel | undefined = opts.model;
    let currentSelectedModel: ChatModel | undefined =
      opts.selectedModel ?? opts.model;
    const preparedInvocationState: {
      runtimeModel?: string;
      extraEnv: Record<string, string> | null;
      threadConfig?: NonNullable<ThreadStartParams['config']>;
    } = {
      extraEnv: null,
      // The client re-sends this on every start, resume, fork and recovery.
      threadConfig: { ...CODEX_PROJECT_DOC_THREAD_CONFIG },
    };
    const prepareInvocation = this.prepareInvocation;
    let currentPlanMode = opts.planMode ?? false;
    let currentProposalMode: 'optional' | 'required' =
      opts.codexProposalMode ?? 'optional';
    let currentIdleTimeoutMinutes =
      opts.codexAppServerIdleTimeoutMinutes ??
      DEFAULT_CODEX_APP_SERVER_IDLE_TIMEOUT_MINUTES;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let turnInProgress = false;
    let turnCancelling = false;
    let turnPreparationController = new AbortController();
    let releaseClientAfterTurn = false;
    let releaseClientAfterDelegation = false;
    let destroyed = false;
    let client: CodexAppServerClient | null = null;
    let activeTurn: QueuedCodexMessage | undefined;
    let managedDelegation: ManagedDelegationSession | undefined;
    let managedInitialization: Promise<void> | undefined;
    let currentApprovalMode: ApprovalMode = opts.approvalMode ?? 'ask';
    const rawApprovalSession: ApprovalSessionHandle = createApprovalSession({
      sessionKey: key,
      projectId: opts.projectId,
      worktreeId: opts.worktreeId,
      chatId: opts.chatId,
      provider: 'codex',
      workspaceRoot: opts.cwd,
      mode: currentApprovalMode,
      // The live rule list children's approvals are evaluated against.
      sessionRules: sessionOpts.sessionApprovalRules ?? [],
      getWindow,
      onAwaitingUser: () => markTurnAwaitingUser(key),
    });
    const approvalSession: ApprovalSessionHandle = {
      check: (approvalCheck, display) =>
        turnCancelling
          ? Promise.resolve({
              decision: 'deny',
              message: 'The owning turn was cancelled.',
            })
          : rawApprovalSession.check(approvalCheck, display),
      setMode: (mode) => rawApprovalSession.setMode(mode),
      // Delegated for interface completeness. The chat-wide broadcast reaches
      // `rawApprovalSession` directly through the approval-session registry,
      // which enrolled it at construction, so this wrapper is not on that path.
      reevaluatePendingApprovals: (mode, previousMode) =>
        rawApprovalSession.reevaluatePendingApprovals(mode, previousMode),
      invalidatePending: () => rawApprovalSession.invalidatePending?.(),
      dispose: () => rawApprovalSession.dispose(),
    };
    const beginTurnCancellation = (): void => {
      turnCancelling = true;
      turnPreparationController.abort(new Error('turn_cancelled'));
      approvalSession.invalidatePending?.();
    };
    // Pipeline-editor sessions intentionally start a fresh thread, but once
    // that thread exists it can still be released and resumed after idling.
    let rootThreadId =
      opts.assistantMode === 'pipeline-editor' ? undefined : opts.sdkSessionId;
    const sourceProviderType = this.providerType;

    const clearIdleTimer = (): void => {
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const releaseIdleClient = (): void => {
      const idleClient = client;
      if (destroyed || turnInProgress || !idleClient) {
        return;
      }
      if (managedDelegation?.activeCount) {
        releaseClientAfterDelegation = true;
        return;
      }
      releaseClientAfterDelegation = false;

      // Preserve the durable thread identity before disposing the owner. The
      // client disposal path sends thread/unsubscribe while a shared profile
      // worker remains alive, allowing Codex to tear down thread-scoped tool
      // subprocesses without waiting for the entire pooled app-server to go
      // idle. The next message recreates a client and resumes this thread.
      rootThreadId = idleClient.getThreadId() ?? rootThreadId;
      idleClient.dispose();
      if (client === idleClient) {
        client = null;
      }
    };

    const scheduleIdleClientRelease = (): void => {
      clearIdleTimer();
      if (destroyed || turnInProgress || !client) {
        return;
      }

      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (destroyed || turnInProgress || !client) {
          return;
        }
        releaseIdleClient();
      }, currentIdleTimeoutMinutes * 60_000);
      idleTimer.unref?.();
    };

    const markCodexTurnStarting = (): void => {
      clearIdleTimer();
      turnPreparationController = new AbortController();
      turnCancelling = false;
      turnInProgress = true;
    };

    const markCodexTurnFinished = (): void => {
      turnInProgress = false;
      turnCancelling = false;
      if (releaseClientAfterTurn) {
        releaseClientAfterTurn = false;
        releaseIdleClient();
      } else if (releaseClientAfterDelegation) {
        releaseIdleClient();
      } else if (!destroyed) {
        scheduleIdleClientRelease();
      }
    };

    const clearCodexTurnInProgress = (): void => {
      turnInProgress = false;
      turnCancelling = false;
    };

    const disposeSession = (): void => {
      if (destroyed) return;
      destroyed = true;
      stopAccountProxySwitches?.();
      stopAccountProxySwitches = undefined;
      clearIdleTimer();
      client?.dispose();
      approvalSession.dispose();
      skillUsage.dispose();
      getMcpHttpProxyService().unregisterRoutesForSession(pluginRouteOwnerId);
      // Codex registers its proxy routes under `pluginRouteOwnerId`, but
      // `worktree-chat-turn.ts` pairs MCP auth failures under the CHAT SESSION
      // KEY for every provider. Without this second call the process-global
      // `pendingByOwner` / `toolNamesByRouteOwner` maps keep `key`-keyed
      // entries with no eviction path (CAN-1814). Harmless when no route is
      // registered under `key`: teardown clears both registries first and then
      // finds no routes to unregister.
      getMcpHttpProxyService().unregisterRoutesForSession(key);
      getCodexGatewayProxyService().unregisterRoutesForSession(key);
      // A verdict recorded but never consumed (the session was torn down before
      // the failure event surfaced) must not outlive the session and arm an
      // unrelated later turn under the same key.
      clearSessionProxyFailure(key);
      void getCodexRuntimeService().revokeStdioMcpRoutes(pluginRouteOwnerId);
      unregisterSession(key);
      if (waitingForMessage) {
        waitingForMessage(undefined);
        waitingForMessage = null;
      }
    };

    sessionAbort.signal.addEventListener('abort', () => {
      disposeSession();
    });

    const shutdownController = new AbortController();
    let destroyRequested = false;
    let runPromise: Promise<void> = Promise.resolve();
    let destroyPromise: Promise<void> | undefined;
    const session: AgentSession = {
      sendMessage(text: string, sendOptions?: AgentSessionSendOptions): void {
        clearIdleTimer();
        messageQueue.push({
          text,
          countsTowardSkillUsage: sendOptions?.countsTowardSkillUsage === true,
          skillUsageTurnId: randomUUID(),
          ...(sendOptions?.userMessageId
            ? { userMessageId: sendOptions.userMessageId }
            : {}),
        });
        noteSessionMessageQueued(key, messageQueue.length);
        if (waitingForMessage) {
          const resolver = waitingForMessage;
          waitingForMessage = null;
          resolver(messageQueue.shift());
          noteSessionMessageQueued(key, messageQueue.length);
        }
      },
      getProviderSessionId(): string | undefined {
        return client?.getThreadId() ?? rootThreadId;
      },
      usesMcpServerConfig(
        serverId: string,
        configId: string,
      ): { displayName: string } | undefined {
        return getMcpHttpProxyService().getSessionMcpRoute(
          pluginRouteOwnerId,
          serverId,
          configId,
        );
      },
      async reloadMcpServers(): Promise<void> {
        await client?.reloadMcpServers();
      },
      async steerActiveTurn(
        text: string,
        clientUserMessageId?: string,
      ): Promise<boolean> {
        return (
          (await client?.steerActiveTurn(text, clientUserMessageId)) ?? false
        );
      },
      getSteeringCapabilities: () =>
        client?.getSteeringCapabilities() ?? {
          provider: 'codex',
          generation: '',
          steer: false,
          withdraw: false,
          interrupt: false,
        },
      getSteeringWorkingDirectory: () => opts.cwd,
      submitSteeringInput: (text, attemptId) =>
        client?.submitSteeringInput(text, attemptId) ??
        Promise.resolve({
          kind: 'rejected',
          attemptId,
          reason: 'The provider session is not ready',
        }),
      isDisposed(): boolean {
        // cancel() only interrupts the active turn — the message loop keeps
        // draining the queue — so only a destroyed session is dead here.
        return destroyed || destroyRequested;
      },
      async cancel(): Promise<void> {
        beginTurnCancellation();
        // Managed delegation initializes before the Codex message loop. Stop
        // can therefore arrive while the first message is still queued and no
        // client or active turn exists to interrupt. Remove only those pending
        // messages; a later send remains free to reuse this live session.
        if (!activeTurn && messageQueue.length > 0) {
          messageQueue.splice(0);
          noteSessionMessageQueued(key, 0);
        }
        // Stop ends only the parent turn. Retire that turn's delegation tool
        // bindings; the chat's delegations keep running.
        managedDelegation?.retireTurn();
        await client?.interruptTurn({
          approvalSessionAlreadyInvalidated: true,
        });
      },
      destroy(): Promise<void> {
        if (destroyPromise) return destroyPromise;
        destroyRequested = true;
        shutdownController.abort();
        beginTurnCancellation();
        if (waitingForMessage) {
          waitingForMessage(undefined);
          waitingForMessage = null;
        }
        destroyPromise = (async (): Promise<void> => {
          try {
            await client?.interruptTurn({
              approvalSessionAlreadyInvalidated: true,
            });
            // An interrupt acknowledgement does not guarantee a terminal event.
            // Retire the client after a bounded drain so teardown (including
            // account switching) cannot wait forever for turn/completed. Keep
            // the session registered until the run loop drains its final events.
            const drainTimeout = setTimeout(() => client?.dispose(), 5_000);
            drainTimeout.unref?.();
            try {
              await runPromise;
            } finally {
              clearTimeout(drainTimeout);
            }
          } finally {
            sessionAbort.abort();
            disposeSession();
          }
        })();
        return destroyPromise;
      },
      setPlanMode(enabled: boolean): Promise<void> {
        currentPlanMode = enabled;
        return Promise.resolve();
      },
      setManagedDelegationMode(mode): void {
        if (mode !== undefined) managedDelegation?.updatePolicy(mode);
      },
      async setApprovalMode(mode: ApprovalMode): Promise<void> {
        currentApprovalMode = mode;
        approvalSession.setMode(mode);
        await client?.setApprovalMode(mode);
      },
      setSpeed(speed: CodexSpeed): Promise<void> {
        setRequestedCodexSpeed(speed);
        return Promise.resolve();
      },
      setFastMode(enabled: boolean): Promise<void> {
        setRequestedCodexSpeed(codexSpeedFromFastMode(enabled));
        return Promise.resolve();
      },
      setCodexFastMode(enabled: boolean): Promise<void> {
        setRequestedCodexSpeed(codexSpeedFromFastMode(enabled));
        return Promise.resolve();
      },
      setCodexProposalMode(mode: 'optional' | 'required'): Promise<void> {
        currentProposalMode = mode;
        return Promise.resolve();
      },
      setCodexAppServerIdleTimeoutMinutes(minutes: number): Promise<void> {
        currentIdleTimeoutMinutes = minutes;
        if (!turnInProgress) {
          scheduleIdleClientRelease();
        }
        return Promise.resolve();
      },
      setThinkingLevel(level: ThinkingLevel): Promise<void> {
        currentThinkingLevel = level;
        currentModelConfig = { ...currentModelConfig, thinkingLevel: level };
        return Promise.resolve();
      },
      async setModel(model: ChatModel): Promise<void> {
        currentModel = model;
        currentSelectedModel = model;
        if (!prepareInvocation) return;
        const prepared = await prepareInvocation(model, 'model-change');
        preparedInvocationState.runtimeModel = prepared.runtimeModel;
        // A not-yet-started client will prepare the latest currentModel during
        // normal initialization. Once initialized, refresh every invocation
        // surface and rebuild the client so Ollama provider config cannot lag
        // behind the newly selected runtime model.
        if (preparedInvocationState.extraEnv !== null) {
          preparedInvocationState.extraEnv = {
            ...preparedInvocationState.extraEnv,
            ...(prepared.envOverride ?? {}),
          };
          preparedInvocationState.threadConfig = mergeCodexConfig(
            preparedInvocationState.threadConfig,
            prepared.codexConfig,
          );
          if (turnInProgress) {
            releaseClientAfterTurn = true;
          } else {
            releaseIdleClient();
          }
        }
      },
    };

    registerSession(
      key,
      session,
      sessionAbort,
      sourceProviderType,
      opts.model,
      opts.assistantMode ?? 'default',
      opts.toolProfileHash,
      codeGraphToolsAdvertised,
      opts.executionHarness,
    );

    const emitEvent = (data: unknown): void | Promise<void> => {
      managedDelegation?.observe(
        data,
        activeTurn?.userMessageId,
        client?.getThreadId(),
      );
      rootThreadId = readCodexRootThreadId(data) ?? rootThreadId;
      // Held until after `onEvent(eventData)` below. Ordering is load-bearing
      // for any terminal event the transcript reducer turns into a `system`
      // notice: that notice is written while reducing THIS same event, so
      // emitting first would find no anchor at all.
      //
      // Ordering is NOT what keeps the failure off the wrong block — but the
      // earlier claim that a Codex `unauthorized` turn failure writes no block
      // was simply wrong (CAN-1814 review round 2). Codex reports it on
      // `turn.failed` or `error`, and BOTH reducer handlers
      // (`handleCodexTurnFailed`, `handleCodexError`) call
      // `buildCodexSystemTextMessage`, writing `{ role: 'system', blocks: [{
      // type: 'text', text: 'Error: Unauthorized' }] }` — the failure does
      // attach there.
      //
      // What writes NO block is a 401 that `classifyAgentFailure` reads off
      // buffered strings/statuses on an event the reducer never turns into a
      // notice. For those, `attachAuthFailureToMessages` deliberately attaches
      // nothing rather than falling back to the newest text block — which was
      // the user's own prompt bubble (CAN-1814 review).
      let providerAuthEvent: CanopyAuthFailureEventData | null = null;
      const accountScope = isSessionAiCreditsRouted(
        opts.projectId,
        opts.worktreeId,
        opts.chatId,
      )
        ? 'ai_credits'
        : 'native';
      // Apply the local proxy's out-of-band verdict for this turn, if it left
      // one. Codex strips the marked hosted body from the error it reports, so
      // for that provider this is the ONLY signal; the string scan below still
      // covers bodies that do survive. The latch is read-and-clear, hence the
      // failure-shape gate first — consuming it on a delta or a completed turn
      // would discard the verdict the failing turn needs.
      const proxyFailure =
        accountScope === 'ai_credits' && isAiCreditsFailureEvent(data)
          ? consumeSessionProxyFailure(key)
          : undefined;
      const stampedData = proxyFailure
        ? withProxyFailureRestored(data, proxyFailure)
        : data;
      const eventData = withTurnMetadata(stampedData, activeTurn);
      // A proxy account's sign-in or limit is not the user's own, so it never
      // starts native account recovery (CAN-4020).
      const resumeReason = isSessionAccountProxyRouted(
        opts.projectId,
        opts.worktreeId,
        opts.chatId,
      )
        ? null
        : classifyAccountChangeResumeReason('codex', data, accountScope);
      // Reads the STAMPED event so the live banner and the persisted per-tab
      // flag are decided by one value, whichever signal established it.
      const sideAdmissions: Promise<void>[] = [];
      // Account-limit notices can precede a successful turn. Only the
      // settled root result can create an automatic quota continuation.
      const proxyInterruption =
        isRecord(data) &&
        data.type === 'result' &&
        data.is_error === true &&
        isSessionAccountProxyRouted(
          opts.projectId,
          opts.worktreeId,
          opts.chatId,
        )
          ? buildAccountProxyUsageLimitedEntry(
              {
                projectId: opts.projectId,
                worktreeId: opts.worktreeId,
                chatId: opts.chatId,
                provider: 'codex',
                detectedAt: Date.now(),
                accountProxyConnectionId,
              },
              data,
            )
          : null;
      if (
        proxyInterruption &&
        !isCodexSubagentTerminalEvent(data, rootThreadId)
      ) {
        sideAdmissions.push(recordUsageLimitedChat(proxyInterruption));
      }

      if (
        accountScope === 'ai_credits' &&
        detectAiCreditsNoBillingSource(eventData)
      ) {
        const admission = emitAiCreditsNoBillingSource(onEvent, 'codex');
        if (admission && typeof admission.then === 'function') {
          sideAdmissions.push(admission);
        }
      }
      // Feed the common on-quota state so any surface's next session recreates
      // through AI Credits when Codex's native quota is reached (CAN-838), and
      // surface the shared usage-limit banner on every chat surface.
      const quota = detectCodexQuotaReached(data);
      if (resumeReason === 'usage_limit' && quota.reached) {
        markProviderQuotaReached('codex', quota.resetsAt);
        const admission = emitAiCreditsUsageLimitReached(
          onEvent,
          'codex',
          quota.resetsAt,
        );
        if (admission && typeof admission.then === 'function') {
          sideAdmissions.push(admission);
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
              provider: 'codex',
              detectedAt: Date.now(),
              resumeReason,
              ...(typeof quota.resetsAt === 'number'
                ? { resetsAt: quota.resetsAt }
                : {}),
              workspaceName: workspace.name,
              ...(workspace.type ? { workspaceType: workspace.type } : {}),
              chatTitle: '',
            }),
          );
        })();
      }
      if (resumeReason === 'authentication' && accountScope === 'native') {
        const classification = classifyAgentFailure({
          provider: 'codex',
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
              provider: 'codex',
              detectedAt: Date.now(),
              resumeReason,
              workspaceName: workspace.name,
              ...(workspace.type ? { workspaceType: workspace.type } : {}),
              chatTitle: '',
            }),
          );
        })();
      }
      recordSessionEvent(key, eventData);
      if (!isCodexSubagentTerminalEvent(eventData, rootThreadId)) {
        const attentionFailure = noteChatSessionEvent(
          {
            projectId: opts.projectId,
            worktreeId: opts.worktreeId,
            chatId: opts.chatId,
          },
          'codex',
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
      }
      // `recordSessionEvent` is session bookkeeping (lastActivityAt,
      // lastEventType, wake lock) and never reaches the renderer; `onEvent` is
      // the delivery path. Deliberately NOT also recorded: stamping
      // `lastEventType: 'canopy_auth_failure'` after a terminal turn event
      // would hide the terminal event from restore.
      const authEvent = providerAuthEvent
        ? withTurnMetadata(providerAuthEvent, activeTurn)
        : null;
      const deliverRecordedEvent = (): void | Promise<void> => {
        const eventAdmission = onEvent(eventData);
        const eventReceipt =
          eventAdmission && typeof eventAdmission.then === 'function'
            ? eventAdmission
            : undefined;
        if (!authEvent) return eventReceipt;
        // Stamped like every other emitted event. Only terminal events consult
        // `canopy_turn_user_message_id` today, but an event that skipped
        // `withTurnMetadata` is a latent trap for anything that later groups by
        // turn.
        if (eventReceipt) {
          return eventReceipt.then(() => onEvent(authEvent));
        }
        return onEvent(authEvent);
      };
      // A side notice and its source event share one transport receipt. Delay
      // the latter until earlier notices have entered the canonical route.
      return sideAdmissions.length > 0
        ? Promise.all(sideAdmissions).then(deliverRecordedEvent)
        : deliverRecordedEvent();
    };

    const runSession = (): Promise<void> =>
      this._runSession(
        sessionOpts,
        messageQueue,
        (resolver) => {
          waitingForMessage = resolver;
        },
        () => currentThinkingLevel,
        () => currentModel,
        () => currentPlanMode,
        () => currentModelConfig,
        () => currentProposalMode,
        () => destroyed || destroyRequested,
        (message) => {
          activeTurn = message;
          // Clears a prior plan-review or terminal-error attention edge when the
          // human starts the next turn.
          getAttentionTracker().clear(
            opts.projectId,
            opts.worktreeId,
            opts.chatId,
          );
        },
        () => {
          activeTurn = undefined;
        },
        markCodexTurnStarting,
        markCodexTurnFinished,
        clearCodexTurnInProgress,
        beginTurnCancellation,
        emitEvent,
        skillUsage,
        key,
        pluginRouteOwnerId,
        getWindow,
        () => rootThreadId,
        () => client,
        (next) => {
          client = next;
        },
        approvalSession,
        () => currentApprovalMode,
        preparedInvocationState,
        managedDelegation,
        shutdownController.signal,
        () => turnPreparationController.signal,
        (connectionId) => {
          accountProxyConnectionId = connectionId;
          // The transcript's account switch lines, once per session while
          // the proxy serves it (CAN-4021).
          if (connectionId !== undefined) {
            stopAccountProxySwitches ??= watchAccountProxySwitches(
              key,
              emitEvent,
            );
          }
        },
      );

    if (managedDelegationEnabled(sessionOpts)) {
      managedInitialization = (async (): Promise<void> => {
        const initializationDelayMs = Number.parseInt(
          process.env.CANOPY_E2E_MANAGED_DELEGATION_INITIALIZATION_DELAY_MS ??
            '',
          10,
        );
        if (
          Number.isInteger(initializationDelayMs) &&
          initializationDelayMs > 0 &&
          initializationDelayMs <= 10_000
        )
          await new Promise<void>((resolve) =>
            setTimeout(resolve, initializationDelayMs),
          );
        // Defer the cycle-breaking delegation service load until this session
        // actually enables managed child agents.
        const { createManagedDelegationSession } =
          await import('./delegation/service');
        managedDelegation = await createManagedDelegationSession({
          harness: 'codex',
          onTranscript: (delegation): void => {
            void Promise.resolve(
              onEvent({
                type: 'canopy_delegation',
                delegation,
                canopy_turn_user_message_id: delegation.parentTurnId,
              }),
            ).catch((error: unknown) =>
              logMainProcessWarn(
                '[codex-session] Delegation transcript delivery failed',
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
            modelConfig: currentModelConfig,
            approvalMode: currentApprovalMode,
            planMode: currentPlanMode,
          }),
          currentTurn: () => activeTurn?.userMessageId,
          onActivityChange: (count): void => {
            if (count === 0 && releaseClientAfterDelegation)
              releaseIdleClient();
          },
        });
        if (destroyed || destroyRequested) {
          managedDelegation.detach();
          return;
        }
      })();
    }
    runPromise = managedInitialization
      ? managedInitialization.then(() =>
          destroyed || destroyRequested ? undefined : runSession(),
        )
      : runSession();
    void runPromise.catch((error: unknown) => {
      markTurnIdle(key);
      logMainProcessWarn('[codex-session] Managed session failed', error);
      void Promise.resolve(
        emitEvent({
          type: 'error',
          error:
            'The managed session could not start or finish its owned cleanup.',
        }),
      ).catch((deliveryError: unknown) =>
        logMainProcessWarn(
          '[codex-session] Failed to report managed session failure',
          deliveryError,
        ),
      );
      disposeSession();
    });
    return session;
  }

  private async _runSession(
    opts: AgentSessionOptions,
    messageQueue: QueuedCodexMessage[],
    setWaiter: (
      resolver: ((msg: QueuedCodexMessage | undefined) => void) | null,
    ) => void,
    getThinkingLevel: () => ThinkingLevel,
    getModel: () => ChatModel | undefined,
    getPlanMode: () => boolean,
    getModelConfig: () => ResolvedAgentModelConfig,
    getProposalMode: () => 'optional' | 'required',
    isDestroyed: () => boolean,
    setActiveTurn: (message: QueuedCodexMessage | undefined) => void,
    clearActiveTurn: () => void,
    markCodexTurnStarting: () => void,
    markCodexTurnFinished: () => void,
    clearCodexTurnInProgress: () => void,
    beginTurnCancellation: () => void,
    onEvent: (data: unknown) => void | Promise<void>,
    skillUsage: SkillUsageTracker,
    key: string,
    pluginRouteOwnerId: string,
    getWindow: () => BrowserWindow | null,
    getResumeThreadId: () => string | undefined,
    getClient: () => CodexAppServerClient | null,
    setClient: (client: CodexAppServerClient | null) => void,
    approvalSession: ApprovalSessionHandle,
    getApprovalMode: () => ApprovalMode,
    preparedInvocationState: {
      runtimeModel?: string;
      extraEnv: Record<string, string> | null;
      threadConfig?: NonNullable<ThreadStartParams['config']>;
    },
    managedDelegation: ManagedDelegationSession | undefined,
    shutdownSignal: AbortSignal,
    getTurnPreparationSignal: () => AbortSignal,
    setAccountProxyConnectionId: (connectionId: string | undefined) => void,
  ): Promise<void> {
    const codeGraphToolsAdvertised =
      opts.codeGraphToolsAdvertised ??
      isCodeGraphAvailableForWorkspace(opts.projectId);
    let resultEmitted = false;
    let terminalAdmissionFailed = false;
    const emitTerminal = async (data: unknown): Promise<void> => {
      try {
        await onEvent(data);
      } catch (error) {
        terminalAdmissionFailed = true;
        throw error;
      }
    };
    let hasRetriedUnknownDynamicTool = false;
    const ledgerTarget: LedgerChatTarget = {
      projectId: opts.projectId,
      worktreeId: opts.worktreeId,
      chatId: opts.chatId,
      assistantMode: opts.assistantMode,
    };
    // App Advisor advertises the Ledger tools under its own names, so its
    // prompt, hint and Plan mode note name those.
    const ledgerToolNames =
      opts.assistantMode === 'app-advisor'
        ? getAppAdvisorLedgerToolNames('codex')
        : undefined;
    // Decided once, with the session's first client. Dynamic tools are fixed
    // when a thread starts, so a later client never adds or drops the Ledger
    // tools; each call re-checks the flag and setting instead. A holder,
    // because the client factory assigns it and the turn loop reads it.
    const ledger: { decided: boolean; tools: LedgerChatToolsSession | null } = {
      decided: false,
      tools: null,
    };
    let codexStandaloneInvocationEntries: InvocationTokenInventoryEntry[] = [];
    // Per thread, not per session. A session outlives its threads (rebuilds,
    // capability transitions), and a session-wide latch would surface the raw
    // Responses API error for a later, independently poisoned thread with no
    // recovery short of destroying the session. Membership still bounds each
    // thread to one rebuild.
    const incompatibleReasoningRetriedThreadIds = new Set<string>();
    const staleProxyRouteRetriedThreadIds = new Set<string>();
    const recordCodexProcessDiagnostic = (diagnostic: {
      kind:
        | 'codex_process_started'
        | 'codex_process_exit'
        | 'codex_process_error'
        | 'codex_process_recovery';
      pid?: number;
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
      stderrTail?: string;
      stderrTruncated?: boolean;
      uptimeMs?: number | null;
      codexClientCount?: number;
      codexActiveTurnCount?: number;
      recoveryScheduled?: boolean;
      recoveryStatus?: 'succeeded' | 'failed';
      recoveryStrategy?:
        | 'restarted'
        | 'reconciled'
        | 'reattached'
        | 'replayed'
        | 'continued';
      error?: string;
    }): void => {
      getObservabilityService().recordSessionDiagnostic({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: diagnostic.kind,
        sessionKey: key,
        projectId: opts.projectId,
        worktreeId: opts.worktreeId,
        chatId: opts.chatId,
        providerType: 'codex',
        ...(getModel() ? { model: getModel() } : {}),
        ...(typeof diagnostic.pid === 'number' ? { pid: diagnostic.pid } : {}),
        ...(typeof diagnostic.exitCode !== 'undefined'
          ? { exitCode: diagnostic.exitCode }
          : {}),
        ...(typeof diagnostic.signal !== 'undefined'
          ? { signal: diagnostic.signal }
          : {}),
        ...(diagnostic.stderrTail ? { stderrTail: diagnostic.stderrTail } : {}),
        ...(typeof diagnostic.stderrTruncated === 'boolean'
          ? { stderrTruncated: diagnostic.stderrTruncated }
          : {}),
        ...(typeof diagnostic.uptimeMs !== 'undefined'
          ? { uptimeMs: diagnostic.uptimeMs }
          : {}),
        ...(typeof diagnostic.codexClientCount === 'number'
          ? { codexClientCount: diagnostic.codexClientCount }
          : {}),
        ...(typeof diagnostic.codexActiveTurnCount === 'number'
          ? { codexActiveTurnCount: diagnostic.codexActiveTurnCount }
          : {}),
        ...(typeof diagnostic.recoveryScheduled === 'boolean'
          ? { recoveryScheduled: diagnostic.recoveryScheduled }
          : {}),
        ...(diagnostic.recoveryStatus
          ? { recoveryStatus: diagnostic.recoveryStatus }
          : {}),
        ...(diagnostic.recoveryStrategy
          ? { recoveryStrategy: diagnostic.recoveryStrategy }
          : {}),
        ...(diagnostic.error ? { error: diagnostic.error } : {}),
      });
    };

    try {
      let workspaceEnvironmentProfile: CodexRuntimeEnvironmentProfile | null =
        null;
      let resolvedMcpServersConfig:
        | ResolvedPlugins['codexMcpServers']
        | undefined;
      let selectedCapabilityRoots: ResolvedPlugins['selectedCapabilityRoots'] =
        [];
      let codexConfigArgs: string[] | undefined;
      let aiCreditsRoutingApplied = false;
      let initialGatewaySelection: string | undefined;
      let accountProxyRoutingApplied = false;
      setAccountProxyConnectionId(undefined);
      const gatewayTurnModels = new Map<
        string,
        {
          gatewayModel: string;
          supportedThinkingLevels: readonly ThinkingLevel[];
        }
      >();
      let initialThreadId =
        opts.assistantMode === 'pipeline-editor'
          ? undefined
          : (getResumeThreadId() ?? opts.sdkSessionId);
      let forceMaterializeOnResume = false;

      /**
       * Resolve AI Credits routing for the model the next turn will actually
       * use, and fold the result into the prepared invocation state.
       *
       * Resolved against the *current* model rather than `opts.model`: the
       * session captures `opts` at creation, but `setModel` can move the
       * selection before the first turn and again between turns, and routing
       * that describes a model the turn will not send is worse than no routing
       * at all.
       *
       * Throws the backstop abort when the resolver has already told the user
       * why the model cannot run, mirroring the original inline behavior.
       */
      const applyAiCreditsRouting = async (): Promise<void> => {
        if (
          opts.requiredAccountProxyConnectionId &&
          (this.providerType === 'ollama' ||
            isAiCreditsChosenOverAccountProxy(
              opts.aiCreditsRouting,
              opts.subscriptionBillingOverride,
            ) ||
            opts.accountProxyRouting === 'off' ||
            isGatewayOnlyModel(getModel() ?? opts.model))
        )
          throw new Error(
            'The account proxy connection for this continuation is unavailable.',
          );
        // The account proxy the user turned on for this device goes first,
        // unless AI Credits were chosen for this chat or for every session
        // (CAN-4020, CAN-4090). It
        // keeps the native model and reasoning, so it is not an AI Credits
        // route for anything below.
        if (
          !accountProxyRoutingApplied &&
          this.providerType !== 'ollama' &&
          !isAiCreditsChosenOverAccountProxy(
            opts.aiCreditsRouting,
            opts.subscriptionBillingOverride,
          ) &&
          opts.accountProxyRouting !== 'off'
        ) {
          const accountProxyRoute = await resolveAccountProxySessionRoute({
            harness: 'codex',
            requiredConnectionId: opts.requiredAccountProxyConnectionId,
            signal: AbortSignal.any([
              shutdownSignal,
              getTurnPreparationSignal(),
            ]),
            model: getModel() ?? opts.model,
            sessionId: key,
            resolveWorkOwner: () => resolveSessionWorkOwner(opts),
          });
          if (accountProxyRoute?.codexConfig) {
            preparedInvocationState.threadConfig = mergeCodexConfig(
              preparedInvocationState.threadConfig,
              accountProxyRoute.codexConfig,
            );
            setAccountProxyConnectionId(
              accountProxyRoute.accountKey.slice('account-proxy:'.length),
            );
            accountProxyRoutingApplied = true;
          }
        }
        // A model only AI Credits serves still goes there; its provider block
        // replaces the proxy's below.
        const accountProxyServes =
          accountProxyRoutingApplied &&
          !isGatewayOnlyModel(getModel() ?? opts.model);
        recordSessionAccountProxyRoute(key, accountProxyServes);
        if (accountProxyServes) {
          await emitAiCreditsRoutingStatus(
            onEvent,
            this.providerType,
            false,
            true,
          );
          return;
        }
        // Always call the async resolver; it returns `null` fast on the
        // common native path (one cached auth read after warm, no cloud I/O).
        // It consults per-session override, the global mode + per-provider
        // quota state, and finally native-auth presence, so routing applies
        // to every chat surface.
        const aiCreditsRouting = await resolveCodexAiCreditsRouting(
          { ...opts, model: getModel() ?? opts.model },
          onEvent,
        );
        if (aiCreditsRouting === AI_CREDITS_BACKSTOP_ABORT) {
          // The resolver already emitted a clear error explaining why this
          // model can't run. Abort instead of spawning the native app-server,
          // which would emit a second raw auth failure over it (CAN-838).
          await emitAiCreditsRoutingStatus(onEvent, 'codex', false);
          throw new Error(AI_CREDITS_BACKSTOP_ABORT_ERROR);
        }
        if (aiCreditsRouting) {
          preparedInvocationState.threadConfig = mergeCodexConfig(
            preparedInvocationState.threadConfig,
            aiCreditsRouting.config,
          );
          aiCreditsRoutingApplied = true;
          initialGatewaySelection = aiCreditsRouting.selectedModel;
          if (aiCreditsRouting.modelCatalogPath) {
            codexConfigArgs = [
              ...(codexConfigArgs ?? []),
              '-c',
              `model_catalog_json=${JSON.stringify(
                aiCreditsRouting.modelCatalogPath,
              )}`,
            ];
          }
          gatewayTurnModels.set(aiCreditsRouting.selectedModel, {
            gatewayModel: aiCreditsRouting.gatewayModel,
            supportedThinkingLevels: aiCreditsRouting.supportedThinkingLevels,
          });
        }
        // Authoritatively tell the renderer whether this session is routing,
        // so the shared status banner is correct on every surface (CAN-838).
        await emitAiCreditsRoutingStatus(
          onEvent,
          this.providerType,
          aiCreditsRoutingApplied,
        );
      };

      const ensureClient = async (
        currentUserMessageId?: string,
      ): Promise<CodexAppServerClient> => {
        // Routing is resolved once, behind the preparation gate below, and a
        // mid-chat model switch does not re-open it. A gateway-only model has
        // no native provider that could bill it, so a client prepared for the
        // native login cannot serve one: the turn goes out as a raw model id
        // and the app-server answers "The '<model>' model is not supported when
        // using Codex with a ChatGPT account".
        //
        // `getOrCreateSession` normally replaces the whole session before this
        // is reachable (its routing signature is gateway-only aware), so this
        // is the backstop for callers that send on a live session object, and
        // for a catalog refresh that turns an already-selected model
        // gateway-only mid-chat.
        //
        // Re-resolving is purely additive and needs no unwinding: the native
        // path contributed no provider config, no catalog override, and no env
        // of its own, so the gateway config merges cleanly onto the prepared
        // state. Only the app-server client is stale, and the replacement
        // carries the new reasoning route family — which is what makes the
        // client rebuild the thread rather than replay OpenAI-private reasoning
        // through the gateway.
        if (
          preparedInvocationState.extraEnv !== null &&
          !aiCreditsRoutingApplied &&
          isGatewayOnlyModel(getModel() ?? opts.model)
        ) {
          await applyAiCreditsRouting();
          // Guarded rather than assumed: a resolver that declined to route
          // would otherwise dispose and rebuild an identical native client on
          // every turn for as long as the model stayed selected.
          if (aiCreditsRoutingApplied) {
            const staleClient = getClient();
            if (staleClient) {
              initialThreadId = staleClient.getThreadId() ?? initialThreadId;
              staleClient.dispose();
              setClient(null);
            }
          }
        }

        const existingClient = getClient();
        if (existingClient) {
          return existingClient;
        }

        let forkSeedItems: JsonValue[] | undefined;
        if (
          !initialThreadId &&
          !getResumeThreadId() &&
          opts.assistantMode !== 'pipeline-editor'
        ) {
          let nativeForkError: Error | undefined;
          try {
            initialThreadId = await waitForPendingCodexFork(
              opts,
              getTurnPreparationSignal(),
            );
          } catch (error) {
            getTurnPreparationSignal().throwIfAborted();
            if (shutdownSignal.aborted || isDestroyed()) throw error;
            nativeForkError =
              error instanceof Error ? error : new Error(String(error));
            // A failed native fork can still use the canonical copied history.
            // The projection below fails closed if that history is unavailable.
          }
          if (!initialThreadId) {
            const continuation = await loadCodexForkContinuation({
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              chatId: opts.chatId,
              excludeMessageId: currentUserMessageId,
            });
            if (!continuation && nativeForkError) throw nativeForkError;
            if (continuation && 'threadId' in continuation)
              initialThreadId = continuation.threadId;
            else if (continuation) forkSeedItems = continuation.seedItems;
          }
          getTurnPreparationSignal().throwIfAborted();
          if (isDestroyed()) throw new Error(SESSION_DESTROYED_ERROR_MESSAGE);
        }

        if (preparedInvocationState.extraEnv === null) {
          workspaceEnvironmentProfile = resolveCodexRuntimeEnvironmentProfile({
            runtime: 'agent',
            workspaceId: opts.projectId,
          });
          let nextExtraEnv = { ...workspaceEnvironmentProfile.environment };

          // One overlay pass: effective selections are computed here (with
          // all overlay IO) and passed straight into resolvePlugins.
          const pluginContext = await resolveEffectiveChatPluginContext(
            opts.pluginSelections,
            opts,
            opts.applyGlobalPluginDefaults,
          );
          const effectiveSelections = pluginContext.selections;
          if (this.providerType === 'codex') {
            codexStandaloneInvocationEntries =
              await resolveCodexStandaloneInvocationEntries(
                effectiveSelections,
              );
          }
          const hasPluginSelections =
            hasAnySelections(effectiveSelections) ||
            opts.packageOverlay !== undefined;
          const codexMockProvider = resolveCodexMockAppServerOverride();
          if (codexMockProvider) {
            nextExtraEnv = { ...nextExtraEnv, ...codexMockProvider.env };
            codexConfigArgs = codexMockProvider.configArgs;
          }
          if (!codexMockProvider && this.prepareInvocation) {
            const prepared = await this.prepareInvocation(
              getModel() ?? opts.model,
              'session-start',
            );
            preparedInvocationState.runtimeModel = prepared.runtimeModel;
            nextExtraEnv = {
              ...nextExtraEnv,
              ...(prepared.envOverride ?? {}),
            };
            preparedInvocationState.threadConfig = mergeCodexConfig(
              preparedInvocationState.threadConfig,
              prepared.codexConfig,
            );
          }
          if (hasPluginSelections) {
            let stopPluginTimer: (() => void) | null = null;
            try {
              recordSessionEvent(key, {
                type: 'phase',
                phase: 'codex.resolve_plugins',
              });
              stopPluginTimer = createSessionPhaseTimer(
                key,
                'codex.resolve_plugins',
              );
              let lastError: unknown;
              let resolved: ResolvedPlugins | null = null;
              const mcpHttpProxyService = getMcpHttpProxyService();
              for (
                let attempt = 0;
                attempt <= CODEX_PLUGIN_RESOLUTION_RETRY_DELAYS_MS.length;
                attempt += 1
              ) {
                try {
                  const candidate = await resolvePlugins(
                    effectiveSelections,
                    opts.projectId,
                    opts.worktreeId,
                    opts.chatId,
                    {
                      purpose: 'codex-session',
                      // Chat startup must never perform an unbounded network
                      // clone. External plugins are installed explicitly from
                      // the catalog and stale selections degrade to warnings.
                      installExternalPlugins: false,
                      enableHttpMcpProxy: true,
                      mcpHttpProxyService,
                      mcpStdioBroker: getCodexRuntimeService(),
                      sessionId: pluginRouteOwnerId,
                      ...(opts.packageOverlay
                        ? { packageOverlay: opts.packageOverlay }
                        : {}),
                      ...(pluginContext.preferences
                        ? { preferences: pluginContext.preferences }
                        : {}),
                    },
                  );
                  resolved = candidate;
                  break;
                } catch (error: unknown) {
                  if (isSessionDestroyedError(error)) {
                    throw error;
                  }
                  lastError = error;
                  mcpHttpProxyService.unregisterRoutesForSession(
                    pluginRouteOwnerId,
                  );
                  const retryDelay =
                    CODEX_PLUGIN_RESOLUTION_RETRY_DELAYS_MS[attempt];
                  if (retryDelay === undefined) {
                    break;
                  }
                  recordPluginResolutionRetry(
                    key,
                    'resolution_error',
                    attempt + 1,
                    retryDelay,
                    error,
                  );
                  await delay(retryDelay, shutdownSignal);
                  if (isDestroyed()) {
                    throw new Error(SESSION_DESTROYED_ERROR_MESSAGE);
                  }
                }
              }
              if (isDestroyed()) {
                throw new Error(SESSION_DESTROYED_ERROR_MESSAGE);
              }
              if (!resolved) {
                const message = `Failed to resolve Codex plugins before session start: ${formatUnknownError(lastError)}`;
                throw new Error(message);
              }
              selectedCapabilityRoots = resolved.selectedCapabilityRoots;
              resolvedMcpServersConfig =
                Object.keys(resolved.codexMcpServers).length > 0
                  ? resolved.codexMcpServers
                  : undefined;
              for (const warning of resolved.warnings) {
                // eslint-disable-next-line no-console
                console.warn('[codex-plugin-resolver]', warning);
              }
              recordSessionEvent(key, {
                type: 'phase',
                phase: 'codex.resolve_plugins.complete',
                timings: resolved.timings,
              });
            } catch (error: unknown) {
              if (!isSessionDestroyedError(error)) {
                // eslint-disable-next-line no-console
                console.error(
                  '[codex-plugin-resolver] Failed to resolve plugins:',
                  error,
                );
              }
              throw error;
            } finally {
              stopPluginTimer?.();
            }
          }
          await applyAiCreditsRouting();

          // Local memory is opt-in; only an enabled preference suppresses
          // Codex-native memories on this thread launch (CAN-1969).
          const nativeMemoryConfig = codexNativeMemoryThreadConfig(
            await readLocalMemoryEnabledPreference(),
          );
          if (Object.keys(nativeMemoryConfig).length > 0) {
            preparedInvocationState.threadConfig = {
              ...(preparedInvocationState.threadConfig ?? {}),
              ...nativeMemoryConfig,
            };
          }

          preparedInvocationState.extraEnv = nextExtraEnv;
        }

        if (!ledger.decided) {
          // A resumed thread without a capability record predates the Ledger
          // tools and never has them, so its session is not exposed: no
          // tools, prompt, Plan mode exception or hint. A thread with a record
          // is rebuilt whenever its tools differ, so it gets what it is told.
          const resumeThreadId = getResumeThreadId() ?? initialThreadId;
          ledger.tools =
            mayExposeLedgerTools(ledgerTarget) &&
            (resumeThreadId === undefined ||
              (await hasCodexCapabilityRecord(resumeThreadId)))
              ? await openLedgerChatTools({
                  target: ledgerTarget,
                  harness: 'codex',
                  ...(ledgerToolNames ? { toolNames: ledgerToolNames } : {}),
                  readSettings: () => ({
                    model: getModel() ?? opts.model ?? null,
                    thinkingEffort: getThinkingLevel(),
                    planMode: getPlanMode(),
                  }),
                  ...(opts.selectedRepoId
                    ? { selectedRepoId: opts.selectedRepoId }
                    : {}),
                })
              : null;
          ledger.decided = true;
          if (isDestroyed()) throw new Error(SESSION_DESTROYED_ERROR_MESSAGE);
        }
        const isCodeReview = opts.projectId === CODE_REVIEW_CHAT_PROJECT_ID;
        const includeChatVisuals = chatVisualsEligible({
          providerType: this.providerType,
          surface: isCoworkWorkspace(opts.projectId)
            ? 'codex-cowork'
            : 'codex-worktree',
          assistantMode: opts.assistantMode,
        });
        const canopyRuntime: CanopyInjectedToolRuntime = {
          authorizeInstalledItemUninstall: (request, context) =>
            authorizeInstalledItemUninstall(approvalSession, request, context),
          ...(includeChatVisuals
            ? {
                showVisual: createShowVisualHost({
                  projectId: opts.projectId,
                  worktreeId: opts.worktreeId,
                  chatId: opts.chatId,
                  cwd: opts.cwd,
                }),
              }
            : {}),
          deferredToolsRuntime: {
            scope: {
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              chatId: opts.chatId,
            },
            providerType: 'codex',
            interfaceMode: 'canopy',
            assistantMode: opts.assistantMode,
            pluginSelections: opts.pluginSelections,
            allowed: opts.deferredToolsAllowed !== false,
          },
          requestUserAnswers: (questions, requestOptions) =>
            requestAnswersFromRenderer({
              sessionKey: key,
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              chatId: opts.chatId,
              questions,
              getWindow,
              toolUseId: requestOptions?.toolUseId,
              providerType: 'codex',
              model: getModel() ?? opts.model,
              onAwaitingUser: (): void => markTurnAwaitingUser(key),
              askUserTimeoutMs: ASK_USER_TIMEOUT_MS,
              signal: requestOptions?.signal,
            }),
          loadScriptOutput: ({ scriptId, repo, maxLines }) =>
            loadWorktreeScriptOutput({
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              scriptId,
              repo,
              maxLines,
            }),
          // Git preferences are meaningless without a git worktree; omitting
          // the loader makes core.ts return its presence-gated error if a
          // resumed cowork thread still tries the tool.
          ...(!isCoworkWorkspace(opts.projectId) ? { loadGitPreferences } : {}),
          saveLocalMemory: (request) =>
            saveLocalMemory({
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              chatId: opts.chatId,
              sessionId: getResumeThreadId() ?? initialThreadId,
              provider: 'codex',
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
          ...(opts.assistantMode !== 'app-advisor' &&
          opts.assistantMode !== 'pipeline-editor'
            ? {
                worktreeActionRuntime: {
                  projectId: opts.projectId,
                  worktreeId: opts.worktreeId,
                  chatId: opts.chatId,
                  cwd: opts.cwd,
                  ...(opts.selectedRepoId
                    ? { repoId: opts.selectedRepoId }
                    : {}),
                  // Cowork chats dispatch directory-scoped pipeline runs at
                  // the workspace folder; worktree-only actions are
                  // filtered/rejected by the action layer.
                  ...(isCoworkWorkspace(opts.projectId)
                    ? { executionScope: 'directory' as const }
                    : {}),
                  getWindow,
                },
                worktreeWatcherRuntime: {
                  projectId: opts.projectId,
                  worktreeId: opts.worktreeId,
                  chatId: opts.chatId,
                },
                // Code graph stays worktree-only (no git repo in cowork).
                ...(!isCoworkWorkspace(opts.projectId)
                  ? {
                      codeGraphRuntime: {
                        projectId: opts.projectId,
                        worktreeId: opts.worktreeId,
                      },
                    }
                  : {}),
                setAutoArchiveForCurrentChat: (enabled) =>
                  onEvent({
                    type: SET_AUTO_ARCHIVE_REQUESTED_EVENT_TYPE,
                    enabled,
                  }),
              }
            : {}),
          ...(ledger.tools ? { ledgerRuntime: ledger.tools } : {}),
        };
        const toolSchemaProfile = resolveGatewayToolSchemaProfile(
          getModel() ?? opts.model,
          aiCreditsRoutingApplied,
        );
        const reasoningRouteFamily = resolveCodexReasoningRouteFamily(
          getModel() ?? opts.model,
          aiCreditsRoutingApplied,
          this.providerType,
        );
        const dynamicTools = buildCodexSessionDynamicToolSpecs({
          assistantMode: opts.assistantMode,
          workspaceMode: isCoworkWorkspace(opts.projectId)
            ? 'cowork'
            : 'worktree',
          includeCodeGraph: codeGraphToolsAdvertised,
          includeChatVisuals,
          includeLedger: ledger.tools !== null,
          isCodeReview,
          toolSchemaProfile,
        });
        if (managedDelegation)
          dynamicTools.push(...managedDelegation.codexTools);

        getTurnPreparationSignal().throwIfAborted();
        const createdApprovalMode = getApprovalMode();
        const nextClient = new CodexAppServerClient({
          cwd: opts.cwd,
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          sessionKey: key,
          initialThreadId: getResumeThreadId() ?? initialThreadId,
          onEvent,
          getWindow,
          extraEnv:
            preparedInvocationState.extraEnv &&
            Object.keys(preparedInvocationState.extraEnv).length > 0
              ? preparedInvocationState.extraEnv
              : undefined,
          spawnProfile: {
            ...(preparedInvocationState.extraEnv
              ? { environment: preparedInvocationState.extraEnv }
              : {}),
            ...(codexConfigArgs ? { configArgs: codexConfigArgs } : {}),
            logicalWorkspaceEnvironmentId:
              workspaceEnvironmentProfile?.logicalWorkspaceEnvironmentId ??
              `agent:${opts.projectId}`,
            ...(workspaceEnvironmentProfile?.secretVersionFingerprint
              ? {
                  secretVersionFingerprint:
                    workspaceEnvironmentProfile.secretVersionFingerprint,
                }
              : {}),
            ...(resolveCodexMockAppServerOverride()
              ? { mockProviderId: 'canopy-e2e' }
              : {}),
          },
          mcpServersConfig: resolvedMcpServersConfig,
          mcpAuthorityIds:
            getMcpHttpProxyService().getCodexCapabilityAuthorityIds(
              resolvedMcpServersConfig ?? {},
            ),
          threadConfig: managedDelegation
            ? {
                ...preparedInvocationState.threadConfig,
                'features.multi_agent': false,
                'features.multi_agent_v2': false,
              }
            : preparedInvocationState.threadConfig,
          selectedCapabilityRoots,
          capabilityStore: getDesktopCodexCapabilityStore(),
          fallbackSeedItems: forkSeedItems,
          fallbackSeedItemsLoader: (): Promise<JsonValue[]> =>
            loadPersistedCodexFallbackSeedItems({
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              chatId: opts.chatId,
              ...(currentUserMessageId
                ? { excludeMessageId: currentUserMessageId }
                : {}),
            }).catch(() => []),
          seedNewThreadFromFallback:
            Boolean(opts.codexReconstructionSeedId) ||
            forkSeedItems !== undefined,
          forceMaterializeOnResume,
          ...(codexConfigArgs && codexConfigArgs.length > 0
            ? { configArgs: codexConfigArgs }
            : {}),
          multiAgentEnabled: managedDelegation
            ? false
            : opts.codexMultiAgentEnabled,
          maxConcurrentSubagents: opts.codexMaxConcurrentSubagents,
          developerInstructions: appendPluginMcpDiscoveryInstructions(
            [
              opts.systemPromptAppend,
              managedDelegation?.systemPromptGuidance,
              ledger.tools?.systemPrompt(),
            ]
              .filter((part): part is string => Boolean(part))
              .join('\n\n') || undefined,
            resolvedMcpServersConfig,
          ),
          ...(ledger.tools
            ? {
                planModeDeveloperInstructionsAddendum:
                  buildLedgerPlanModeInstruction('codex', ledgerToolNames),
              }
            : {}),
          dynamicTools,
          toolSchemaProfile,
          reasoningRouteFamily,
          modelConfig: getModelConfig,
          approvalSession,
          approvalMode: createdApprovalMode,
          onAwaitingUser: (): void => markTurnAwaitingUser(key),
          ...(managedDelegation
            ? {
                onDynamicToolResultAccepted: (call: {
                  callId: string;
                  threadId: string;
                  turnId: string;
                }): void => {
                  managedDelegation.parent.acknowledgeTool(
                    call.callId,
                    `codex:${call.threadId}:${call.turnId}:${call.callId}`,
                    call.turnId,
                  );
                },
              }
            : {}),
          dynamicToolCallHandler: async (
            params,
            requestOptions,
          ): Promise<
            Awaited<ReturnType<typeof handleCanopyDynamicToolCall>>
          > => {
            const toolName = params.tool;
            if (
              opts.assistantMode === 'app-advisor' &&
              opts.appAdvisorRuntime &&
              toolName === APP_ADVISOR_TOOL_REGISTRY.watch_command.codexToolName
            ) {
              // The App Advisor runtime owns the selected-worktree command
              // approval. Dispatch directly so the generic provider tool gate
              // does not add a second, less specific prompt.
              return handleAppAdvisorDynamicToolCall(
                params,
                opts.appAdvisorRuntime,
                requestOptions,
              );
            }
            const watchedCommand =
              toolName ===
              CANOPY_INJECTED_TOOL_REGISTRY.watch_command.codexToolName
                ? watchCommandSchema.safeParse(params.arguments)
                : undefined;
            const commandInput = watchedCommand?.success
              ? watchedCommand.data
              : undefined;
            const outcome = await approvalSession.check(
              commandInput
                ? {
                    kind: 'command',
                    command: commandInput.command,
                    cwd: opts.cwd,
                  }
                : { kind: 'tool', toolName },
              {
                title: `Use ${toolName}?`,
                ...(commandInput
                  ? {
                      description: `Repeated command in ${opts.cwd}. Limits: ${JSON.stringify(params.arguments)}; 60-second timeout per attempt.`,
                    }
                  : {}),
                details: commandInput
                  ? {
                      kind: 'command',
                      command: commandInput.command,
                    }
                  : {
                      kind: 'tool',
                      toolName,
                      inputSummary: JSON.stringify(params.arguments),
                    },
                ...(!commandInput
                  ? { suggestedTarget: { kind: 'tool' as const, toolName } }
                  : {}),
                toolUseId: `codex-${params.callId}`,
              },
            );
            if (outcome.decision === 'deny') {
              const response = {
                contentItems: [
                  {
                    type: 'inputText' as const,
                    text:
                      outcome.message ??
                      `Dynamic tool ${toolName} was denied by the approval policy.`,
                  },
                ],
                success: false,
              };
              if (outcome.stopTurn) {
                beginTurnCancellation();
                // Let the app-server consume the denied tool result before
                // interrupting the turn, matching the response-then-interrupt
                // ordering used by the built-in Codex approval handlers.
                setImmediate(() => {
                  void nextClient.interruptTurn().catch(() => undefined);
                });
              }
              return response;
            }
            if (managedDelegation?.ownsTool(toolName)) {
              const target = nextClient.getActiveTurnInterruptTarget();
              const result = await managedDelegation.parent.invokeCodex(
                toolName,
                params.arguments,
                params,
                target?.threadId,
                target?.turnId ?? undefined,
              );
              return {
                contentItems: [
                  { type: 'inputText', text: JSON.stringify(result) },
                ],
                success: result.ok,
              };
            }
            return opts.assistantMode === 'app-advisor' &&
              opts.appAdvisorRuntime
              ? handleAppAdvisorDynamicToolCall(
                  params,
                  opts.appAdvisorRuntime,
                  // Ledger calls run on this session's own Ledger tools,
                  // bound to the Work Entry it started in.
                  {
                    ...requestOptions,
                    ...(ledger.tools ? { ledgerRuntime: ledger.tools } : {}),
                  },
                )
              : opts.assistantMode === 'pipeline-editor' &&
                  opts.pipelineEditorRuntime
                ? handlePipelineEditorDynamicToolCall(
                    params,
                    opts.pipelineEditorRuntime,
                    requestOptions,
                  )
                : handleCanopyDynamicToolCall(
                    params,
                    canopyRuntime,
                    requestOptions,
                  );
          },
          onProcessStarted: (pid): void => {
            recordCodexProcessDiagnostic({
              kind: 'codex_process_started',
              pid,
            });
          },
          onProcessExit: (details): void => {
            recordCodexProcessDiagnostic({
              kind: 'codex_process_exit',
              ...(details.pid !== null ? { pid: details.pid } : {}),
              exitCode: details.code,
              signal: details.signal,
              stderrTail: details.stderrTail,
              stderrTruncated: details.stderrTruncated,
              uptimeMs: details.uptimeMs,
              codexClientCount: details.clientCount,
              codexActiveTurnCount: details.activeTurnCount,
              recoveryScheduled: details.recoveryScheduled,
            });
          },
          onProcessError: (details): void => {
            recordCodexProcessDiagnostic({
              kind: 'codex_process_error',
              error: details.error,
              stderrTail: details.stderrTail,
            });
          },
          onProcessRecovery: (details): void => {
            recordCodexProcessDiagnostic({
              kind: 'codex_process_recovery',
              recoveryStatus: details.status,
              ...(details.strategy
                ? { recoveryStrategy: details.strategy }
                : {}),
              ...(details.error ? { error: details.error } : {}),
            });
          },
        });
        recordSessionEvent(key, {
          type: 'phase',
          phase: 'codex.client_created',
        });
        let appliedApprovalMode = createdApprovalMode;
        while (appliedApprovalMode !== getApprovalMode()) {
          const latestApprovalMode = getApprovalMode();
          await nextClient.setApprovalMode(latestApprovalMode);
          appliedApprovalMode = latestApprovalMode;
        }
        if (isDestroyed()) {
          nextClient.dispose();
          throw new Error(SESSION_DESTROYED_ERROR_MESSAGE);
        }
        // Consume the force-rebuild request: it applies to the client we just
        // constructed and must not survive into later clients. The idle timer
        // disposes the client between turns (`releaseIdleClient`), so leaving
        // this latched would make every subsequent recreation materialize a
        // brand-new thread — new sdkSessionId, full history re-injection, and
        // reasoning stripped again — instead of the cheap thread/resume that
        // release path is designed around. Resetting only after a successful
        // construction keeps a failed attempt forcing the rebuild it asked for.
        forceMaterializeOnResume = false;
        setClient(nextClient);
        return nextClient;
      };

      while (!isDestroyed()) {
        let message: QueuedCodexMessage | undefined;

        if (messageQueue.length > 0) {
          message = messageQueue.shift();
        } else {
          message = await new Promise<QueuedCodexMessage | undefined>(
            (resolve) => {
              setWaiter(resolve);
            },
          );
        }

        if (message === undefined || isDestroyed()) {
          break;
        }

        // `input` is computed below from send-time invocation normalization.
        const turnPlanMode = getPlanMode();
        setActiveTurn(message);
        const usageTurn = skillUsage.startTurn(
          message.skillUsageTurnId ?? randomUUID(),
          message.countsTowardSkillUsage === true,
        );

        try {
          message.staleProxyRouteRecoverySignal?.throwIfAborted();
          markCodexTurnStarting();
          markTurnActive(key, message.userMessageId);
          const activeClient = await ensureClient(message.userMessageId);
          recordSessionEvent(key, {
            type: 'phase',
            phase: 'codex.turn_start',
          });
          const selectedModel = getModel() ?? opts.model;
          let turnModel = preparedInvocationState.runtimeModel ?? selectedModel;
          let turnGatewayRoute:
            | {
                gatewayModel: string;
                supportedThinkingLevels: readonly ThinkingLevel[];
              }
            | undefined;
          const routingModel = selectedModel ?? initialGatewaySelection;
          if (aiCreditsRoutingApplied && routingModel) {
            const cachedGatewayRoute = gatewayTurnModels.get(routingModel);
            const gatewayEntry = cachedGatewayRoute
              ? undefined
              : resolveGatewayModelEntry(routingModel);
            const resolvedGatewayRoute =
              cachedGatewayRoute ??
              (gatewayEntry
                ? {
                    gatewayModel: gatewayEntry.gatewayId,
                    supportedThinkingLevels: [
                      ...gatewayEntry.supportedThinkingLevels,
                    ],
                  }
                : undefined);
            if (resolvedGatewayRoute) {
              gatewayTurnModels.set(routingModel, resolvedGatewayRoute);
              turnGatewayRoute = resolvedGatewayRoute;
              turnModel = resolvedGatewayRoute.gatewayModel;
            }
          }
          const inventory = await loadCachedInventory().catch(() => null);
          const providerInventoryEntries =
            inventory?.entries.filter(
              (entry) => entry.provider === this.providerType,
            ) ?? [];
          const normalizationEntries =
            this.providerType === 'codex'
              ? [
                  ...providerInventoryEntries.filter(
                    (entry) => entry.kind !== 'skill',
                  ),
                  ...codexStandaloneInvocationEntries,
                ]
              : providerInventoryEntries;
          if (this.providerType === 'codex') {
            const matched = matchInvocationEntry(
              message.text,
              normalizationEntries,
            );
            const canonical =
              matched &&
              providerInventoryEntries.find(
                (entry) => entry.invocationKey === matched.invocationKey,
              );
            if (canonical) skillUsage.observeEntry(usageTurn, canonical);
          }
          const input = normalizeInvocationToken(
            message.text,
            normalizationEntries,
          );
          // A normal turn starts with a bounded hint when entries assigned to
          // this chat changed since it last looked.
          const ledgerHint = ledger.tools
            ? await ledger.tools.assignmentHint()
            : undefined;
          const turnInput = ledgerHint ? `${ledgerHint}\n\n${input}` : input;
          getTurnPreparationSignal().throwIfAborted();
          const turnModelConfig = getModelConfig();
          // Admit the exact requested speed against the route THIS turn
          // actually uses (resolved model, AI Credits/organization gateway,
          // provider config, environment) before any thread or turn request.
          // Regular and Fast resolve immediately. A refused Ultra fast turn
          // ends visibly below; it is never downgraded or replayed.
          const speedAdmission = await admitCodexSpeed(turnModelConfig.speed, {
            selectedModel: selectedModel ?? null,
            runtimeModel: turnModel ?? null,
            harness: 'codex',
            providerType: this.providerType,
            gateway: aiCreditsRoutingApplied
              ? codexSpeedGatewayForOrigin(
                  resolveGatewayModelEntry(selectedModel)?.origin,
                )
              : null,
            codexConfig: preparedInvocationState.threadConfig ?? null,
            environment: preparedInvocationState.extraEnv,
            mockProvider: Boolean(resolveCodexMockAppServerOverride()),
          });
          getTurnPreparationSignal().throwIfAborted();
          const turnResult = await activeClient.startTurn({
            text:
              managedDelegation?.applyPolicyGuidance(turnInput) ?? turnInput,
            cwd: opts.cwd,
            // The routed process catalog maps gateway IDs to portable standard
            // Responses metadata. Vercel does not preserve Lite's custom
            // grammar tool-call semantics, so routed turns use that gateway ID;
            // native turns retain the bundled alias and native Lite profile.
            model: turnModel,
            capabilityModel: selectedModel,
            aiCreditsRouted: aiCreditsRoutingApplied,
            ...(turnGatewayRoute
              ? {
                  supportedThinkingLevels:
                    turnGatewayRoute.supportedThinkingLevels,
                }
              : {}),
            thinkingLevel: getThinkingLevel(),
            planMode: turnPlanMode,
            modelConfig: turnModelConfig,
            ultrafastAdmitted: speedAdmission.speed === 'ultrafast',
            proposalMode: getProposalMode(),
          });

          const recoverySignal = getTurnPreparationSignal();
          resultEmitted = true;
          markTurnIdle(key);
          markCodexTurnFinished();
          if (turnResult.status === 'failed') {
            // One report per failed real request; only a definitive tier,
            // model, or access rejection of an admitted Ultra fast turn
            // records a temporary denial. Nothing is retried at another speed.
            reportCodexSpeedTurnFailure(speedAdmission, turnModel, {
              codexErrorInfo: turnResult.codexErrorInfo,
              message: turnResult.error,
            });
            // No shared sentinel key. A failure before any thread id is known
            // cannot be attributed to a thread, and bucketing every such
            // failure under one placeholder would let the first one consume
            // the budget for every later unrelated thread. There is also
            // nothing to rebuild *from* without a source thread id, so skip
            // the retry entirely rather than record a fake key.
            const failedThreadKey =
              activeClient.getThreadId() ?? initialThreadId;
            const staleProxyRouteFailure = isStaleProxyRouteError(
              turnResult.error,
            );
            const stopAutomaticRecovery =
              message.staleProxyRouteRetried === true || staleProxyRouteFailure;
            if (stopAutomaticRecovery) {
              const markForRecreation = (): void =>
                markSessionForNextTurnRecreation(
                  opts.projectId,
                  opts.worktreeId,
                  opts.chatId,
                );
              if (isDestroyed() || recoverySignal.aborted) {
                throw new Error(
                  isDestroyed()
                    ? SESSION_DESTROYED_ERROR_MESSAGE
                    : 'turn_cancelled',
                );
              }
              if (
                !message.staleProxyRouteRetried &&
                staleProxyRouteFailure &&
                failedThreadKey !== undefined &&
                !staleProxyRouteRetriedThreadIds.has(failedThreadKey) &&
                staleProxyRouteRetriedThreadIds.size <
                  MAX_STALE_PROXY_ROUTE_RECOVERIES
              ) {
                staleProxyRouteRetriedThreadIds.add(failedThreadKey);
                // Reuse the prepared route: session teardown would remove it.
                initialThreadId = failedThreadKey;
                forceMaterializeOnResume = true;
                message.staleProxyRouteRetried = true;
                try {
                  activeClient.dispose();
                } finally {
                  setClient(null);
                }
                if (isDestroyed() || recoverySignal.aborted) {
                  throw new Error(
                    isDestroyed()
                      ? SESSION_DESTROYED_ERROR_MESSAGE
                      : 'turn_cancelled',
                  );
                }
                messageQueue.unshift({
                  ...message,
                  staleProxyRouteRecoverySignal: recoverySignal,
                  revivesSettledTurn: true,
                });
                clearActiveTurn();
                noteSessionMessageQueued(key, messageQueue.length);
                continue;
              }
              markForRecreation();
            }
            if (
              !stopAutomaticRecovery &&
              failedThreadKey !== undefined &&
              isIncompatibleReasoningHistoryError(turnResult.error) &&
              !incompatibleReasoningRetriedThreadIds.has(failedThreadKey) &&
              incompatibleReasoningRetriedThreadIds.size <
                MAX_INCOMPATIBLE_REASONING_HISTORY_REBUILDS
            ) {
              incompatibleReasoningRetriedThreadIds.add(failedThreadKey);
              initialThreadId = activeClient.getThreadId() ?? initialThreadId;
              forceMaterializeOnResume = true;
              activeClient.dispose();
              setClient(null);
              messageQueue.unshift({ ...message, revivesSettledTurn: true });
              clearActiveTurn();
              noteSessionMessageQueued(key, messageQueue.length);
              continue;
            }
            if (
              !stopAutomaticRecovery &&
              opts.assistantMode === 'app-advisor' &&
              isUnknownDynamicToolError(turnResult.error) &&
              !hasRetriedUnknownDynamicTool
            ) {
              hasRetriedUnknownDynamicTool = true;
              getObservabilityService().recordSessionDiagnostic({
                version: 1,
                timestamp: new Date().toISOString(),
                kind: 'phase_slow',
                sessionKey: key,
                projectId: opts.projectId,
                worktreeId: opts.worktreeId,
                chatId: opts.chatId,
                providerType: 'codex',
                phase: 'app_advisor_dynamic_tool_recreate',
                elapsedMs: 0,
              });
              initialThreadId = activeClient.getThreadId() ?? initialThreadId;
              forceMaterializeOnResume = true;
              activeClient.dispose();
              setClient(null);
              messageQueue.unshift({ ...message, revivesSettledTurn: true });
              clearActiveTurn();
              noteSessionMessageQueued(key, messageQueue.length);
              continue;
            }
            await emitTerminal({
              type: 'result',
              is_error: true,
              result: turnResult.error ?? 'Codex turn failed',
              subtype: 'codex_error',
              ...(turnResult.codexErrorInfo
                ? { codexErrorInfo: turnResult.codexErrorInfo }
                : {}),
              errors: [turnResult.error ?? 'Codex turn failed'],
            });
            clearActiveTurn();
            continue;
          }

          if (turnResult.proposedPlanText) {
            const win = getWindow();
            const planExitEvent: PlanExitRequestEvent = {
              requestId: randomUUID(),
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              chatId: opts.chatId,
              source: 'codex',
              reviewMode: 'proposal',
              toolInput: {
                plan: turnResult.proposedPlanText,
                source: 'codex',
              },
            };
            await commitPendingPlanExit(planExitEvent);
            sendToWindow(win, IPC_CHANNELS.planExitRequest, planExitEvent);
            // Mirrors the Claude plan-exit path: a plan awaiting review blocks
            // on a human and is worth a push (CAN-3195).
            getAttentionTracker().mark({
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              chatId: opts.chatId,
              state: 'needs_input',
              reason: 'plan_review',
              sourceId: 'plan-review',
            });
          }

          await emitTerminal({
            type: 'result',
            is_error: false,
            result:
              turnResult.status === 'interrupted'
                ? 'Turn cancelled'
                : 'Turn completed',
          });
          clearActiveTurn();
        } catch (error: unknown) {
          if (message.staleProxyRouteRetried) {
            markSessionForNextTurnRecreation(
              opts.projectId,
              opts.worktreeId,
              opts.chatId,
            );
          }
          markTurnIdle(key);
          markCodexTurnFinished();
          if (terminalAdmissionFailed) {
            throw error;
          }
          if (isDestroyed()) {
            break;
          }

          if (
            error instanceof Error &&
            error.message === AI_CREDITS_BACKSTOP_ABORT_ERROR
          ) {
            // The AI Credits backstop already emitted a descriptive error.
            // End the session without a second error (CAN-838).
            resultEmitted = true;
            await emitTerminal({
              type: 'result',
              is_error: false,
              result: 'Session ended',
            });
            clearActiveTurn();
            break;
          }

          if (
            error instanceof Error &&
            (error.message === 'turn_cancelled' ||
              error.message === SESSION_DESTROYED_ERROR_MESSAGE)
          ) {
            resultEmitted = true;
            await emitTerminal({
              type: 'result',
              is_error: false,
              result: 'Turn cancelled',
            });
            clearActiveTurn();
            continue;
          }

          resultEmitted = true;
          await emitTerminal({
            type: 'result',
            is_error: true,
            result: error instanceof Error ? error.message : String(error),
            subtype: 'codex_error',
            errors: [error instanceof Error ? error.message : String(error)],
            // A structured marker for app-server transport failures, so the
            // chat retry service never has to match the message text.
            ...(classifyCodexTransportError(error) ?? {}),
          });
          clearActiveTurn();
        }
      }
    } catch (error: unknown) {
      resultEmitted = true;
      markTurnIdle(key);
      clearCodexTurnInProgress();
      if (terminalAdmissionFailed) {
        throw error;
      }
      if (
        error instanceof Error &&
        (error.message === 'turn_cancelled' ||
          error.message === SESSION_DESTROYED_ERROR_MESSAGE)
      ) {
        await emitTerminal({
          type: 'result',
          is_error: false,
          result: 'Session aborted',
        });
        clearActiveTurn();
        return;
      }
      await emitTerminal({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      clearActiveTurn();
    } finally {
      try {
        if (!resultEmitted) {
          markTurnIdle(key);
          clearCodexTurnInProgress();
          await emitTerminal({
            type: 'result',
            is_error: false,
            result: 'Session ended',
          });
        }
      } finally {
        clearActiveTurn();
        ledger.tools?.dispose();
        try {
          // The session is gone; the chat's delegations outlive it.
          managedDelegation?.detach();
        } finally {
          unregisterSession(key);
        }
      }
    }
  }
}
import { authorizeInstalledItemUninstall } from '../installed-items/installed-item-approval';
