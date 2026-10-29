import { clearPresentationTurn } from '../canopy-tools/presentation-state';
import type { BrowserWindow } from 'electron';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import { normalizePluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import { mcpHttpAuthTargetKey } from '@canopy/desktop-shared/lib/mcp-http-auth';
import type { AgentProvider, AgentSession, AgentSessionOptions } from './types';
import { buildChatSessionKey } from './session-key';
import { getInheritedPluginDefaultsRevision } from '../plugins/plugin-defaults-revision';
import type { CodexCompatibleInvocation } from './codex-session';
import {
  APP_ADVISOR_PROJECT_ID,
  resolveKnownModel,
  getExecutionHarnessForModel,
  getModelSource,
  type ActivityLiveBgTasksChatState,
  type AgentProviderType,
  type AssistantMode,
  type ChatActiveSessionInfo,
  type ChatContextUsageBreakdown,
  type ChatModel,
  type ChatTabPluginSelections,
  type UsageLimitedChatEntry,
} from '@canopy/desktop-shared/types';
import {
  isGatewayOnlyModel,
  resolveGatewayModelEntry,
} from '@canopy/desktop-shared/lib/gateway-model-availability';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import {
  cleanupChatSkillPluginDir,
  cleanupWorktreeChatPluginDirs,
} from '../plugins/plugin-cleanup';
import { rejectAllForSession } from '../mcp/pending-requests';
import {
  flushAndStopOutputPollingForSession,
  stopAllOutputPolling,
} from '../lib/bg-output-poller';
import { emitSessionEndedBackgroundTaskNotification } from '../lib/session-ended-background-tasks';
import { getObservabilityService } from '../observability';
import { describeChatEventData } from '../lib/chat-event-description';
import { getWakeLockService } from '../power/wake-lock-service';
import {
  activeDelegationCount,
  hasLiveDelegations,
} from './delegation/activity';
import {
  closeDelegationScope,
  hasDelegationLifecycle,
  revokeDelegationLifecycle,
} from './delegation/lifecycle';
import { getTelemetrySyncService } from '../services/telemetry-sync-service';
import {
  isAiCreditsChosenOverAccountProxy,
  resolveAiCreditsRoutingActivation,
} from './ai-credits-routing';
import {
  billedProviderFor,
  effectiveTabAiCreditsRouting,
} from './effective-ai-credits-routing';
// NOTE: `../auth/provider-auth-state` statically imports this module, so this is
// a cycle — but the same cycle already exists via `./ai-credits-routing`, and
// only function declarations are read across it (never at module-eval time).
import { peekProviderNativeAuthAvailability } from '../auth/provider-auth-state';
import { isModelBlockedByStoredPolicy } from '../lib/model-policy-state';
import { checkModelGatewayRoute } from '../lib/model-gateway-state';
import { accountProxySettingsSignature } from '../account-proxy/service';
import { previewAccountProxySessionRoute } from '../account-proxy/routing';
import {
  captureSessionWorkOwner,
  peekSessionWorkOwner,
  resolveEnforcementOwner,
  resolveSessionWorkOwner,
} from './work-owner';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { appendUserOverallPreferencesBlock } from '@canopy/desktop-shared/lib/global-instructions';
import {
  assertWorkspaceTargetRuntimeStartAllowed,
  withWorkspaceTargetRuntimeStartReservation,
} from '../lib/workspace-target-exclusion';
import { isAgentContinuationEvent } from '../lib/chat-turn-audit';
import { isE2eBuild } from '../lib/e2e-gate';

export { isAgentContinuationEvent } from '../lib/chat-turn-audit';

function sessionKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return buildChatSessionKey(projectId, worktreeId, chatId);
}

export {
  bumpGlobalPluginDefaultsRevision,
  getGlobalPluginDefaultsRevision,
  subscribePluginDefaultsRevision as subscribeGlobalPluginDefaultsRevision,
} from '../plugins/plugin-defaults-revision';

function pluginSelectionsSignature(
  opts: Pick<
    AgentSessionOptions,
    | 'pluginSelections'
    | 'applyGlobalPluginDefaults'
    | 'projectId'
    | 'worktreeId'
  >,
): string {
  const revisionSuffix = opts.applyGlobalPluginDefaults
    ? `@defaults:${String(getInheritedPluginDefaultsRevision(opts))}`
    : '';
  const selections = opts.pluginSelections;
  if (!selections) {
    return `null${revisionSuffix}`;
  }
  const normalized = normalizePluginSelections(selections);
  return JSON.stringify({
    collectionIds: [...normalized.collectionIds].sort(),
    skillRefs: [...normalized.skillRefs]
      .map((ref) => ({ sourceId: ref.sourceId, skillName: ref.skillName }))
      .sort(
        (a, b) =>
          a.sourceId.localeCompare(b.sourceId) ||
          a.skillName.localeCompare(b.skillName),
      ),
    pluginRefs: [...normalized.pluginRefs]
      .map((ref) => ({
        marketplaceId: ref.marketplaceId,
        pluginName: ref.pluginName,
      }))
      .sort(
        (a, b) =>
          a.marketplaceId.localeCompare(b.marketplaceId) ||
          a.pluginName.localeCompare(b.pluginName),
      ),
    mcpServerRefs: [...(normalized.mcpServerRefs ?? [])]
      .map((ref) => ({ serverId: ref.serverId, configId: ref.configId }))
      .sort(
        (a, b) =>
          a.serverId.localeCompare(b.serverId) ||
          a.configId.localeCompare(b.configId),
      ),
    mcpHttpAuthPreferences: [...(normalized.mcpHttpAuthPreferences ?? [])]
      .map((entry) => ({
        key: mcpHttpAuthTargetKey(entry.target),
        entry,
      }))
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(({ entry }) => entry),
  }).concat(revisionSuffix);
}

/**
 * Parse a session key back into its project / worktree / chat identifiers.
 *
 * The session map is keyed by the literal `${projectId}/${worktreeId}/${chatId}`
 * string. This is the single authoritative parser for that shape — do not
 * `.split('/')` on session keys outside of this helper. Call sites that already
 * hold the three identifiers separately should pass them directly instead of
 * re-deriving them from the key.
 */
function parseSessionKey(key: string): {
  projectId: string;
  worktreeId: string;
  chatId: string;
} {
  const parts = key.split('/');
  if (parts.length !== 3) {
    throw new Error(`Invalid session key: ${key}`);
  }

  const [projectId, worktreeId, chatId] = parts;
  if (!projectId || !worktreeId || !chatId) {
    throw new Error(`Invalid session key: ${key}`);
  }
  return { projectId, worktreeId, chatId };
}

/** Metadata Canopy retains for one live provider background task. */
interface LiveBackgroundTask {
  toolUseId?: string;
  description?: string;
}

export interface ClaudeNativeSubagentTask {
  taskId: string;
  backgrounded: boolean;
}

/**
 * Everything the live background-task reducer touches. Narrower than
 * {@link ActiveSession} on purpose: the deterministic E2E chat-event ingress
 * has no provider session to attach state to, and this lets it reduce the
 * identical event stream into its own holder instead of forking the rules.
 */
interface LiveBackgroundTaskOwner {
  liveBackgroundTasks: Map<string, LiveBackgroundTask>;
  foregroundTaskMetadata: Map<string, LiveBackgroundTask>;
  activeBackgroundTaskIds?: Set<string>;
}

interface ActiveSession {
  session: AgentSession;
  abortController: AbortController;
  onRemoved?: () => void;
  drainEventsBeforeRemoval?: () => Promise<void>;
  providerType: AgentProviderType;
  executionHarness?: AgentSessionOptions['executionHarness'];
  executionContext?: string;
  /** Immutable owner scope resolved when this provider session was created. */
  workOwnerKey: string;
  authGeneration: number;
  model?: ChatModel;
  selectedModel?: ChatModel;
  /** Provider-reported model used for display when the caller omitted one. */
  reportedModel?: ChatModel;
  systemPromptAppend?: string;
  globalInstructionsSnapshot?: string;
  pluginSelectionsSignature: string;
  deferredToolsAllowed: boolean;
  pluginSelections?: ChatTabPluginSelections;
  /** Inherited plugin-defaults revision the session was created under. */
  inheritedPluginDefaultsRevision?: number;
  /**
   * AI Credits routing signature the session was created under (CAN-838).
   * `'native'` or `routed:<model>`. When the effective routing decision changes
   * (e.g. on-quota trips, the quota window resets, or the selected model moves
   * between a natively-billable and a gateway-only one), the signature no longer
   * matches and `getOrCreateSession` recreates the session so the new decision
   * takes effect. Applies uniformly to every chat surface.
   */
  aiCreditsRoutingSignature: string;
  /**
   * The account proxy serves this session (CAN-4020). Set from the decision
   * made at creation, then replaced by the route the session actually applied.
   */
  accountProxyRouted?: boolean;
  recreateOnNextTurn: boolean;
  managedDelegationSurface?: AgentSessionOptions['managedDelegationSurface'];
  managedDelegationMode?: AgentSessionOptions['managedDelegationMode'];
  /** True while the session is actively processing a turn (between message dequeue and result/error event). */
  turnActive: boolean;
  /** User message whose provider turn is currently active, when supplied. */
  activeUserMessageId: string | undefined;
  /** Avoid dispatching duplicate cancellation requests for the same active turn. */
  activeTurnCancelRequested: boolean;
  /**
   * The root Codex turn that is currently allowed to resume after pausing for
   * user input. Binding the permission to both IDs prevents stale prior-turn or
   * subagent events from consuming it.
   */
  codexContinuationRevivalTurn?: CodexTurnIdentity;
  codexRootThreadId?: string;
  codexRootTurnId?: string;
  /** Task tool_use ids correlated to native subagent tasks on this query. */
  claudeNativeSubagentTasks: Map<string, ClaudeNativeSubagentTask>;
  /** Receiver ids correlated to this root's Codex multi-agent items. */
  codexNativeSubagentThreadIds: Set<string>;
  /** Active child turns correlated to the receiver ids above. */
  codexNativeSubagentTurns: Map<string, string>;
  createdAt: number;
  lastActivityAt: number;
  turnStartedAt?: number;
  turnElapsedBeforeCurrentSegmentMs: number;
  turnCount: number;
  pendingMessageCount: number;
  activeBackgroundTaskIds: Set<string>;
  continuationToolUseIds: Set<string>;
  /**
   * Every background task the provider has reported as live for this session's
   * current CLI process, keyed by task id.
   *
   * Deliberately separate from `activeBackgroundTaskIds`, which holds only the
   * finite background Bash continuations that drive wake-lock and turn-revival
   * semantics. This set is the complete picture the activity panel needs, so it
   * also holds persistent services and tasks Canopy never correlated to a tool
   * use. Reset whenever the session's CLI process (re)starts, because
   * `background_tasks_changed` emits nothing at startup.
   */
  liveBackgroundTasks: Map<string, LiveBackgroundTask>;
  /** Bounded correlation retained until a foreground task is promoted. */
  foregroundTaskMetadata: Map<string, LiveBackgroundTask>;
  wakeLockHeld: boolean;
  lastEventType?: string;
  assistantMode: AssistantMode;
  toolProfileHash: string;
  codeGraphToolsAdvertised: boolean;
}

interface CodexTurnIdentity {
  threadId: string;
  turnId: string;
}

export type ChatSessionActivityListener = () => void;

export interface ChatTurnConcurrencySnapshot {
  activeTurns: number;
  pendingMessages: number;
}

const sessions = new Map<string, ActiveSession>();
const providerAuthGenerations = new Map<AgentProviderType, number>();
// Session recreation can follow a passive observation without withdrawing
// the authority captured by delegates that are already doing work.
const providerSessionAuthGenerations = new Map<AgentProviderType, number>();
const chatSessionActivityListeners = new Set<ChatSessionActivityListener>();
const SLOW_SESSION_PHASE_MS = 10_000;

function notifyChatSessionActivityListeners(): void {
  for (const listener of Array.from(chatSessionActivityListeners)) {
    try {
      listener();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        '[session-manager] Chat session activity listener failed:',
        error,
      );
    }
  }
}

function resolveProviderType(
  opts: AgentSessionOptions,
  existing?: ActiveSession,
): AgentProviderType {
  if (opts.model) {
    const source = getModelSource(opts.model);
    if (source === 'ollama') return 'ollama';
    if (source === 'claude-managed') return 'claude';
    if (source === 'codex-managed') return 'codex';
    if (source === 'cursor-managed') return 'cursor';
    if (source === 'copilot-managed') return 'copilot';
    if (source === 'opencode-managed') return 'opencode';
    if (source === 'ai-gateway') {
      return (
        opts.executionHarness ??
        getExecutionHarnessForModel(opts.model) ??
        'claude'
      );
    }
  }
  if (existing) return existing.providerType;
  if (opts.providerType) return opts.providerType;
  return 'claude';
}

function resolveExecutionHarness(
  opts: AgentSessionOptions,
  existing?: ActiveSession,
): NonNullable<AgentSessionOptions['executionHarness']> {
  const wantsOpenCode =
    opts.providerType === 'opencode' || opts.executionHarness === 'opencode';
  if (
    wantsOpenCode &&
    (!opts.model || getModelSource(opts.model) !== 'opencode-managed')
  )
    throw new Error('OpenCode requires a model from its connected providers.');
  if (opts.model && getModelSource(opts.model) === 'opencode-managed')
    return 'opencode';
  const wantsCopilot =
    opts.providerType === 'copilot' || opts.executionHarness === 'copilot';
  if (
    wantsCopilot &&
    (!opts.model || getModelSource(opts.model) !== 'copilot-managed')
  )
    throw new Error(
      'Copilot requires a model from the connected Copilot account.',
    );
  if (opts.model && getModelSource(opts.model) === 'copilot-managed')
    return 'copilot';
  const wantsCursor =
    opts.providerType === 'cursor' || opts.executionHarness === 'cursor';
  if (opts.model) {
    const source = getModelSource(opts.model);
    if (wantsCursor && source !== 'cursor-managed') {
      // A Cursor tab carrying a Claude or Codex model must not quietly run on
      // that model's harness; the provider the user chose would be ignored.
      throw new Error(
        'Cursor requires its managed model. Select Cursor default and try again.',
      );
    }
    if (source === 'claude-managed') return 'claude';
    if (source === 'codex-managed') return 'codex';
    if (source === 'cursor-managed') return 'cursor';
  }
  if (!opts.model && wantsCursor) {
    // Cursor has exactly one managed model. A provider-only request must not
    // fall through to the Claude default below and silently switch providers.
    throw new Error(
      'Cursor requires its managed model. Select Cursor default and try again.',
    );
  }
  return (
    opts.executionHarness ??
    (opts.model ? getExecutionHarnessForModel(opts.model) : undefined) ??
    existing?.executionHarness ??
    (opts.providerType === 'codex' ? 'codex' : 'claude')
  );
}

export function getProviderAuthGeneration(
  providerType: AgentProviderType,
): number {
  return providerAuthGenerations.get(providerType) ?? 0;
}

function getProviderSessionAuthGeneration(
  providerType: AgentProviderType,
): number {
  return providerSessionAuthGenerations.get(providerType) ?? 0;
}

export function resetProviderAuthGenerationsForTests(): void {
  providerAuthGenerations.clear();
  providerSessionAuthGenerations.clear();
}

async function createProvider(
  harness: NonNullable<AgentSessionOptions['executionHarness']>,
  providerType: AgentProviderType,
): Promise<AgentProvider> {
  if (harness === 'opencode') {
    const { OpenCodeProvider } = await import('./opencode-session');
    return new OpenCodeProvider();
  }
  if (harness === 'copilot') {
    const { CopilotProvider } = await import('./copilot-session');
    return new CopilotProvider();
  }
  if (harness === 'cursor') {
    // Defer the ACP SDK and Cursor process/hook runtime until Cursor is used.
    // The packaged Electron main smoke exercises this lazy resolution path.
    const { CursorProvider } = await import('./cursor-session');
    return new CursorProvider();
  }
  if (harness === 'codex') {
    // Keep this local import lazy to break the session-manager ↔ codex-session
    // cycle; the packaged Electron main build exercises this resolution path.
    const { CodexProvider } = await import('./codex-session');
    if (providerType === 'ollama') {
      // Keep the Ollama adapter lazy with the Codex provider to preserve the
      // same session-manager cycle break in packaged Electron main builds.
      const { resolveCodexCompatibleOllamaInvocation } =
        await import('../ollama/codex-compatible');
      return new CodexProvider({
        providerType: 'ollama',
        prepareInvocation: async (
          model: ChatModel | undefined,
        ): Promise<CodexCompatibleInvocation> => {
          const invocation = await resolveCodexCompatibleOllamaInvocation(
            model,
            {
              ensureRunningReason: 'chat',
              assertInstalled: true,
            },
          );
          return {
            runtimeModel: invocation.runtimeModel,
            envOverride: invocation.envOverride,
            codexConfig: invocation.codexConfig,
          };
        },
      });
    }
    return new CodexProvider();
  }
  if (providerType === 'ollama') {
    const { OllamaProvider } = await import('./ollama-provider');
    return new OllamaProvider();
  }

  const { ClaudeCodeProvider } = await import('./claude-session');
  return new ClaudeCodeProvider();
}

async function ensureProviderAuthBaselineForSession(
  providerType: AgentProviderType,
): Promise<void> {
  if (providerType !== 'claude' && providerType !== 'codex') {
    return;
  }

  const authState = await import('../auth/provider-auth-state');
  await authState.ensureProviderAuthBaselineForSession(
    providerType,
    'session-create',
  );
}

function recordSessionDiagnostic(
  key: string,
  entry: ActiveSession,
  diagnostic: {
    kind:
      | 'session_registered'
      | 'session_unregistered'
      | 'session_replaced'
      | 'message_queued'
      | 'turn_active'
      | 'turn_idle'
      | 'phase_slow';
    phase?: string;
    elapsedMs?: number;
    changedOptions?: string[];
  },
): void {
  const identifiers = parseSessionKey(key);
  getObservabilityService().recordSessionDiagnostic({
    version: 1,
    timestamp: new Date().toISOString(),
    kind: diagnostic.kind,
    sessionKey: key,
    projectId: identifiers.projectId,
    worktreeId: identifiers.worktreeId,
    chatId: identifiers.chatId,
    providerType: entry.providerType,
    ...(diagnostic.kind !== 'session_replaced' && entry.executionHarness
      ? { executionHarness: entry.executionHarness }
      : {}),
    ...(diagnostic.kind !== 'session_replaced' && entry.model
      ? { model: entry.model }
      : {}),
    turnActive: entry.turnActive,
    turnCount: entry.turnCount,
    pendingMessageCount: entry.pendingMessageCount,
    ...(entry.activeBackgroundTaskIds.size > 0
      ? { activeBackgroundTaskCount: entry.activeBackgroundTaskIds.size }
      : {}),
    ...(entry.lastEventType ? { lastEventType: entry.lastEventType } : {}),
    lastActivityAt: entry.lastActivityAt,
    ...(diagnostic.phase ? { phase: diagnostic.phase } : {}),
    ...(diagnostic.changedOptions
      ? { changedOptions: diagnostic.changedOptions }
      : {}),
    ...(typeof diagnostic.elapsedMs === 'number'
      ? { elapsedMs: diagnostic.elapsedMs }
      : {}),
  });
}

function syncWakeLockForSession(key: string, entry: ActiveSession): void {
  const active =
    entry.turnActive ||
    entry.pendingMessageCount > 0 ||
    entry.activeBackgroundTaskIds.size > 0;

  if (active) {
    if (!entry.wakeLockHeld) {
      getWakeLockService().acquire(`chat:${key}`, 'agent chat turn');
      entry.wakeLockHeld = true;
    }
  } else if (entry.wakeLockHeld) {
    getWakeLockService().release(`chat:${key}`);
    entry.wakeLockHeld = false;
  }
}

function removeSessionEntry(key: string): ActiveSession | undefined {
  const entry = sessions.get(key);
  if (!entry) {
    return undefined;
  }

  getWakeLockService().release(`chat:${key}`);
  sessions.delete(key);
  releaseHandedOffTurnPreparations(key, 'all');
  try {
    entry.onRemoved?.();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      `[session-manager] Session removal callback failed for ${key}:`,
      error,
    );
  }
  recordSessionDiagnostic(key, entry, {
    kind: 'session_unregistered',
  });
  notifyChatSessionActivityListeners();

  // Drain any pending telemetry for this worktree immediately (bypassing the
  // debounce) when a chat tab closes / a session is killed (CAN-402). No-ops
  // when telemetry sync is off or for non-worktree (standalone) sessions.
  try {
    const { projectId, worktreeId } = parseSessionKey(key);
    void getTelemetrySyncService()
      .flushWorktreeNow(projectId, worktreeId)
      .catch(() => undefined);
  } catch {
    // Non-standard key shape — nothing to flush.
  }

  return entry;
}

export function subscribeChatSessionActivity(
  listener: ChatSessionActivityListener,
): () => void {
  chatSessionActivityListeners.add(listener);
  return (): void => {
    chatSessionActivityListeners.delete(listener);
  };
}

export function hasActiveChatTurns(): boolean {
  for (const entry of Array.from(sessions.values())) {
    if (entry.turnActive || entry.pendingMessageCount > 0) {
      return true;
    }
  }

  return false;
}

export function hasActiveChatWork(): boolean {
  // Queued delegated work holds no slot, but an install would cancel it.
  if (hasLiveDelegations()) return true;
  for (const entry of Array.from(sessions.values())) {
    if (
      entry.turnActive ||
      entry.pendingMessageCount > 0 ||
      entry.activeBackgroundTaskIds.size > 0
    ) {
      return true;
    }
  }

  return false;
}

export function getChatTurnConcurrencySnapshot(): ChatTurnConcurrencySnapshot {
  let activeTurns = activeDelegationCount();
  let pendingMessages = 0;
  for (const entry of Array.from(sessions.values())) {
    if (entry.turnActive) {
      activeTurns += 1;
    }
    pendingMessages += entry.pendingMessageCount;
  }
  return { activeTurns, pendingMessages };
}

export function hasActiveChatTurnsForProject(projectId: string): boolean {
  const prefix = `${projectId}/`;
  for (const [key, entry] of Array.from(sessions.entries())) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    if (entry.turnActive || entry.pendingMessageCount > 0) {
      return true;
    }
  }

  return false;
}

export function hasActiveChatTurnsForWorktree(
  projectId: string,
  worktreeId: string,
): boolean {
  const prefix = `${projectId}/${worktreeId}/`;
  for (const [key, entry] of Array.from(sessions.entries())) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    if (entry.turnActive || entry.pendingMessageCount > 0) {
      return true;
    }
  }

  return false;
}

let sessionShutdownStarted = false;
let codexAuthenticationGate: Promise<void> | null = null;
let codexAuthenticationEpoch = 0;
let authenticationRecovery: {
  attemptId: string;
  targets: Set<string>;
  suppressed: Set<string>;
} | null = null;
let pendingShutdownEntries: UsageLimitedChatEntry[] = [];

const pendingSessionCreations = new Map<symbol, AgentSessionOptions>();

async function getOrCreateSessionWithoutStartReservation(
  opts: AgentSessionOptions,
  onEvent: (data: unknown) => void | Promise<void>,
  getWindow: () => BrowserWindow | null,
  lifecycle?: {
    onRemoved?: () => void;
    drainEventsBeforeRemoval?: () => Promise<void>;
  },
): Promise<AgentSession> {
  if (sessionShutdownStarted)
    throw new Error('Application is stopping. Resume this chat after restart.');
  if (resolveExecutionHarness(opts) === 'codex' && codexAuthenticationGate)
    await codexAuthenticationGate;
  const epoch = codexAuthenticationEpoch;
  const pending = Symbol();
  pendingSessionCreations.set(pending, opts);
  try {
    const session = await getOrCreateSessionImpl(
      opts,
      onEvent,
      getWindow,
      lifecycle,
      epoch,
    );
    if (sessionShutdownStarted)
      throw new Error(
        'Application is stopping. Resume this chat after restart.',
      );
    return session;
  } finally {
    pendingSessionCreations.delete(pending);
  }
}

async function getOrCreateSessionImpl(
  opts: AgentSessionOptions,
  onEvent: (data: unknown) => void | Promise<void>,
  getWindow: () => BrowserWindow | null,
  lifecycle?: {
    onRemoved?: () => void;
    drainEventsBeforeRemoval?: () => Promise<void>;
  },
  authenticationEpoch = codexAuthenticationEpoch,
): Promise<AgentSession> {
  if (sessionShutdownStarted)
    throw new Error('Application is stopping. Resume this chat after restart.');
  const key = sessionKey(opts.projectId, opts.worktreeId, opts.chatId);
  const requestedMode = opts.assistantMode ?? 'default';
  const requestedToolProfileHash = opts.toolProfileHash ?? 'default';
  const requestedSelectedModel = opts.selectedModel ?? opts.model;
  const requestedPluginSelectionsSignature = pluginSelectionsSignature(opts);
  const existing = sessions.get(key);
  const executionHarness = resolveExecutionHarness(opts, existing);
  const providerType = resolveProviderType(
    {
      ...opts,
      executionHarness,
    },
    existing,
  );
  const sessionIdentityOpts: AgentSessionOptions = {
    ...opts,
    executionHarness,
    providerType,
  };
  const globalInstructionsSnapshot = opts.sdkSessionId
    ? (opts.globalInstructionsSnapshot ??
      existing?.globalInstructionsSnapshot ??
      '')
    : (opts.globalInstructionsBlock ?? '');
  const effectiveOpts: AgentSessionOptions = {
    ...sessionIdentityOpts,
    systemPromptAppend:
      appendUserOverallPreferencesBlock(
        opts.systemPromptAppend,
        globalInstructionsSnapshot,
      ) ?? opts.systemPromptAppend,
  };
  // Stale session routing reaches neither the account proxy choice nor the
  // spawned session (CAN-4200).
  if (
    !effectiveTabAiCreditsRouting(
      effectiveOpts.aiCreditsRouting,
      billedProviderFor(providerType, executionHarness),
    )
  ) {
    delete effectiveOpts.aiCreditsRouting;
  }
  await ensureProviderAuthBaselineForSession(providerType);
  const routingSignature = resolveSessionRoutingSignature(
    effectiveOpts,
    providerType,
  );
  const currentAuthGeneration = getProviderSessionAuthGeneration(providerType);
  const selectedModel = requestedSelectedModel ?? opts.model;
  captureSessionWorkOwner(opts);
  const workOwner = await resolveSessionWorkOwner(opts);
  const requestedWorkOwnerKey = workOwnerIdentityKey(workOwner);
  if (
    effectiveOpts.requiredAccountProxyConnectionId &&
    ((providerType !== 'claude' && providerType !== 'codex') ||
      isAiCreditsChosenOverAccountProxy(
        effectiveOpts.aiCreditsRouting,
        effectiveOpts.subscriptionBillingOverride,
      ) ||
      !(await previewAccountProxySessionRoute({
        harness: providerType,
        model: effectiveOpts.model,
        requiredConnectionId: effectiveOpts.requiredAccountProxyConnectionId,
        resolveWorkOwner: () => Promise.resolve(workOwner),
      })))
  )
    throw new Error(
      'The account proxy connection for this continuation is unavailable.',
    );
  // The policy gate runs before the session-reuse branch on purpose. A chat
  // opened while a model was still allowed keeps a live, option-matching entry
  // in `sessions` forever; checking only on the create/teardown path would let
  // that chat run on a now-blocked model indefinitely, because the background
  // policy re-probe only refreshes in-memory policy state and never inspects
  // the sessions map. Refusing here also tears the stale entry down so the next
  // turn cannot resurrect it.
  if (await isModelBlockedByStoredPolicy(selectedModel, workOwner)) {
    if (existing) {
      await destroySessionEntry(key, existing, 'getOrCreateSession');
    }
    await onEvent({
      type: 'error',
      error: 'This model is blocked by your organization policy.',
      error_code: 'model_policy_blocked',
    });
    getObservabilityService().recordSessionDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'model_policy_refused',
      sessionKey: key,
      projectId: opts.projectId,
      worktreeId: opts.worktreeId,
      chatId: opts.chatId,
      providerType,
      ...(selectedModel ? { model: selectedModel } : {}),
    });
    throw new Error('This model is blocked by your organization policy.');
  }
  if (providerType !== 'claude' && providerType !== 'codex') {
    const gatewayCheck = await checkModelGatewayRoute(selectedModel, workOwner);
    if (!gatewayCheck.ok) throw new Error(gatewayCheck.message);
  }

  if (existing) {
    if (
      sessionMatchesOptions(existing, sessionIdentityOpts, {
        providerType,
        requestedMode,
        requestedToolProfileHash,
        requestedSelectedModel,
        requestedPluginSelectionsSignature,
        currentAuthGeneration,
        routingSignature,
        requestedWorkOwnerKey,
      })
    ) {
      existing.onRemoved = lifecycle?.onRemoved;
      existing.drainEventsBeforeRemoval ??= lifecycle?.drainEventsBeforeRemoval;
      existing.session.setManagedDelegationMode?.(
        effectiveOpts.managedDelegationMode,
      );
      existing.managedDelegationSurface =
        effectiveOpts.managedDelegationSurface;
      existing.managedDelegationMode = effectiveOpts.managedDelegationMode;
      return existing.session;
    }
    // Persist field names only. Prompts, environment values, credentials and
    // routing signatures must not appear in this replacement diagnostic.
    const comparisons: [string, unknown, unknown][] = [
      ['providerType', existing.providerType, providerType],
      [
        'executionHarness',
        existing.executionHarness,
        sessionIdentityOpts.executionHarness,
      ],
      [
        'executionContext',
        existing.executionContext,
        sessionIdentityOpts.executionContext,
      ],
      ['workOwner', existing.workOwnerKey, requestedWorkOwnerKey],
      ['model', existing.model, opts.model],
      ['selectedModel', existing.selectedModel, requestedSelectedModel],
      [
        'pluginSelections',
        existing.pluginSelectionsSignature,
        requestedPluginSelectionsSignature,
      ],
      [
        'deferredToolsAllowed',
        existing.deferredToolsAllowed,
        opts.deferredToolsAllowed !== false,
      ],
      ['assistantMode', existing.assistantMode, requestedMode],
      ['toolProfile', existing.toolProfileHash, requestedToolProfileHash],
      ['authGeneration', existing.authGeneration, currentAuthGeneration],
      ['routing', existing.aiCreditsRoutingSignature, routingSignature],
      [
        'systemPromptAppend',
        existing.systemPromptAppend,
        sessionIdentityOpts.systemPromptAppend,
      ],
      [
        'codeGraphToolsAdvertised',
        existing.codeGraphToolsAdvertised,
        opts.codeGraphToolsAdvertised ?? false,
      ],
    ];
    recordSessionDiagnostic(key, existing, {
      kind: 'session_replaced',
      changedOptions: comparisons
        .filter(([, before, after]) => before !== after)
        .map(([name]) => name),
    });
    await destroySessionEntry(key, existing, 'getOrCreateSession');
  }

  // Decided once here, with the session's own owner, and handed to the
  // session, so its billing label and its route cannot disagree.
  const accountProxyRouting: 'proxy' | 'off' =
    (providerType === 'claude' || providerType === 'codex') &&
    !isAiCreditsChosenOverAccountProxy(
      effectiveOpts.aiCreditsRouting,
      effectiveOpts.subscriptionBillingOverride,
    ) &&
    (await previewAccountProxySessionRoute({
      harness: providerType,
      model: effectiveOpts.model,
      requiredConnectionId: effectiveOpts.requiredAccountProxyConnectionId,
      resolveWorkOwner: () => Promise.resolve(workOwner),
    }))
      ? 'proxy'
      : 'off';
  if (
    effectiveOpts.requiredAccountProxyConnectionId &&
    accountProxyRouting !== 'proxy'
  )
    throw new Error(
      'The account proxy connection for this continuation is unavailable.',
    );
  const provider = await createProvider(executionHarness, providerType);
  // Checked after the last await, so a stop or a Codex sign-in that began
  // while either await was pending still keeps this session from starting.
  if (sessionShutdownStarted)
    throw new Error('Application is stopping. Resume this chat after restart.');
  if (
    executionHarness === 'codex' &&
    authenticationEpoch !== codexAuthenticationEpoch
  )
    throw new Error('Chat paused for Codex sign-in.');
  const session = provider.createSession(
    { ...effectiveOpts, accountProxyRouting },
    onEvent,
    getWindow,
  );
  // The provider registers the session synchronously inside createSession;
  // stamp the routing signature it was created under so the next turn can detect
  // an effective routing change (on-quota trip / reset, mode flip) and recreate.
  const created = sessions.get(key);
  if (created) {
    created.onRemoved = lifecycle?.onRemoved;
    created.drainEventsBeforeRemoval = lifecycle?.drainEventsBeforeRemoval;
    created.aiCreditsRoutingSignature = routingSignature;
    created.accountProxyRouted = accountProxyRouting === 'proxy';
    created.model = effectiveOpts.model;
    created.selectedModel = requestedSelectedModel;
    created.systemPromptAppend = sessionIdentityOpts.systemPromptAppend;
    created.globalInstructionsSnapshot = globalInstructionsSnapshot;
    created.pluginSelectionsSignature = requestedPluginSelectionsSignature;
    created.deferredToolsAllowed = effectiveOpts.deferredToolsAllowed !== false;
    created.pluginSelections = normalizePluginSelections(
      effectiveOpts.pluginSelections,
    );
    created.inheritedPluginDefaultsRevision =
      effectiveOpts.applyGlobalPluginDefaults
        ? getInheritedPluginDefaultsRevision(effectiveOpts)
        : undefined;
    created.executionHarness = executionHarness;
    created.executionContext = effectiveOpts.executionContext;
    created.workOwnerKey = requestedWorkOwnerKey;
    created.managedDelegationSurface = effectiveOpts.managedDelegationSurface;
    created.managedDelegationMode = effectiveOpts.managedDelegationMode;
    const readSteeringCapabilities =
      session.getSteeringCapabilities?.bind(session);
    if (readSteeringCapabilities) {
      session.getSteeringCapabilities = (): ReturnType<
        typeof readSteeringCapabilities
      > => {
        const capabilities = readSteeringCapabilities();
        const current = sessions.get(key);
        // A settings/auth/routing change may require a new process on the next
        // ordinary turn. Never bypass that boundary by steering the old one.
        // Withdrawal and Interrupt remain available for its already-owned input.
        const compatible =
          current?.session === session &&
          !current.recreateOnNextTurn &&
          current.authGeneration ===
            getProviderSessionAuthGeneration(current.providerType) &&
          current.pluginSelectionsSignature ===
            pluginSelectionsSignature(effectiveOpts) &&
          current.aiCreditsRoutingSignature ===
            resolveSessionRoutingSignature(
              { ...effectiveOpts, model: current.model },
              current.providerType,
            );
        return { ...capabilities, steer: capabilities.steer && compatible };
      };
    }
  }
  return session;
}

export function getOrCreateSession(
  opts: AgentSessionOptions,
  onEvent: (data: unknown) => void | Promise<void>,
  getWindow: () => BrowserWindow | null,
  lifecycle?: {
    onRemoved?: () => void;
    drainEventsBeforeRemoval?: () => Promise<void>;
  },
): Promise<AgentSession> {
  return withWorkspaceTargetRuntimeStartReservation(
    opts.projectId,
    opts.worktreeId,
    () =>
      getOrCreateSessionWithoutStartReservation(
        opts,
        onEvent,
        getWindow,
        lifecycle,
      ),
  );
}

interface SessionMatchContext {
  providerType: AgentProviderType;
  requestedMode: AssistantMode;
  requestedToolProfileHash: string;
  requestedSelectedModel: ChatModel | undefined;
  requestedPluginSelectionsSignature: string;
  currentAuthGeneration: number;
  routingSignature: string;
  requestedWorkOwnerKey: string;
}

function workOwnerIdentityKey(owner: WorkOwner | undefined): string {
  return owner?.kind === 'organization'
    ? `organization:${owner.organizationId.toLowerCase()}`
    : (owner?.kind ?? 'unknown');
}

function sessionMatchesOptions(
  existing: ActiveSession,
  opts: AgentSessionOptions,
  context: SessionMatchContext,
): boolean {
  return (
    sessionIdentityMatchesOptions(existing, opts, context) &&
    existing.systemPromptAppend === opts.systemPromptAppend &&
    existing.codeGraphToolsAdvertised ===
      (opts.codeGraphToolsAdvertised ?? false)
  );
}

function sessionIdentityMatchesOptions(
  existing: ActiveSession,
  opts: AgentSessionOptions,
  context: SessionMatchContext,
): boolean {
  return (
    managedDelegationModesShareProviderSession(
      existing.managedDelegationMode,
      opts.managedDelegationMode,
    ) &&
    existing.providerType === context.providerType &&
    existing.executionHarness === opts.executionHarness &&
    existing.executionContext === opts.executionContext &&
    existing.workOwnerKey === context.requestedWorkOwnerKey &&
    existing.model === opts.model &&
    existing.selectedModel === context.requestedSelectedModel &&
    existing.pluginSelectionsSignature ===
      context.requestedPluginSelectionsSignature &&
    existing.deferredToolsAllowed === (opts.deferredToolsAllowed !== false) &&
    existing.assistantMode === context.requestedMode &&
    existing.toolProfileHash === context.requestedToolProfileHash &&
    existing.authGeneration === context.currentAuthGeneration &&
    existing.aiCreditsRoutingSignature === context.routingSignature
  );
}

function managedDelegationModesShareProviderSession(
  current: AgentSessionOptions['managedDelegationMode'],
  requested: AgentSessionOptions['managedDelegationMode'],
): boolean {
  if (current === requested) return true;
  return (
    (current === 'explicit-only' || current === 'proactive') &&
    (requested === 'explicit-only' || requested === 'proactive')
  );
}

/**
 * Returns whether {@link getOrCreateSession} would reuse the current logical
 * session for these exact options. Callers that snapshot immutable session
 * capabilities can use this before carrying a prior snapshot into a turn that
 * may instead replace the provider session.
 */
export async function canReuseSession(
  opts: AgentSessionOptions,
): Promise<boolean> {
  const existing = sessions.get(
    sessionKey(opts.projectId, opts.worktreeId, opts.chatId),
  );
  if (!existing) return false;
  const effectiveOpts = {
    ...opts,
    executionHarness: resolveExecutionHarness(opts, existing),
  };
  const providerType = resolveProviderType(effectiveOpts, existing);
  await ensureProviderAuthBaselineForSession(providerType);
  captureSessionWorkOwner(opts);
  const workOwner = await resolveSessionWorkOwner(opts);
  return sessionMatchesOptions(existing, effectiveOpts, {
    providerType,
    requestedMode: opts.assistantMode ?? 'default',
    requestedToolProfileHash: opts.toolProfileHash ?? 'default',
    requestedSelectedModel: opts.selectedModel ?? opts.model,
    requestedPluginSelectionsSignature: pluginSelectionsSignature(opts),
    currentAuthGeneration: getProviderSessionAuthGeneration(providerType),
    routingSignature: resolveSessionRoutingSignature(
      effectiveOpts,
      providerType,
    ),
    requestedWorkOwnerKey: workOwnerIdentityKey(workOwner),
  });
}

/**
 * Returns whether the current session still has the same logical identity when
 * only its injected prompt or immutable Code Graph capability snapshot differs.
 * This lets callers recreate a provider session for live prompt changes without
 * accidentally replacing the logical session's captured capability.
 */
export async function canPreserveSessionCapabilitySnapshot(
  opts: AgentSessionOptions,
): Promise<boolean> {
  const existing = sessions.get(
    sessionKey(opts.projectId, opts.worktreeId, opts.chatId),
  );
  if (!existing) return false;
  const effectiveOpts = {
    ...opts,
    executionHarness: resolveExecutionHarness(opts, existing),
  };
  const providerType = resolveProviderType(effectiveOpts, existing);
  await ensureProviderAuthBaselineForSession(providerType);
  captureSessionWorkOwner(opts);
  const workOwner = await resolveSessionWorkOwner(opts);
  return sessionIdentityMatchesOptions(existing, effectiveOpts, {
    providerType,
    requestedMode: opts.assistantMode ?? 'default',
    requestedToolProfileHash: opts.toolProfileHash ?? 'default',
    requestedSelectedModel: opts.selectedModel ?? opts.model,
    requestedPluginSelectionsSignature: pluginSelectionsSignature(opts),
    currentAuthGeneration: getProviderSessionAuthGeneration(providerType),
    routingSignature: resolveSessionRoutingSignature(
      effectiveOpts,
      providerType,
    ),
    requestedWorkOwnerKey: workOwnerIdentityKey(workOwner),
  });
}

/**
 * Compute the AI Credits routing signature a session should be created under, so
 * a changed effective decision (on-quota trip/reset, mode flip, per-session
 * override) forces recreation. Only Claude/Codex participate; other providers
 * are always `'native'`. Cheap: reads cached mode + in-memory quota state.
 */
export function resolveSessionRoutingSignature(
  opts: AgentSessionOptions,
  providerType: AgentProviderType,
): string {
  const base = resolveAiCreditsRoutingSignature(opts, providerType);
  if (providerType !== 'claude' && providerType !== 'codex') return base;
  // The account proxy settings join the signature, so turning the proxy or
  // keep-on-one-account on or off recreates the session (CAN-4020). Whether
  // the proxy took the session is recorded on its registry entry instead.
  const proxy = accountProxySettingsSignature(providerType);
  const signature = proxy ? `${base}|${proxy}` : base;
  return opts.requiredAccountProxyConnectionId
    ? `${signature}|required-account-proxy:${opts.requiredAccountProxyConnectionId}`
    : signature;
}

function resolveAiCreditsRoutingSignature(
  opts: AgentSessionOptions,
  providerType: AgentProviderType,
): string {
  if (providerType !== 'claude' && providerType !== 'codex') {
    return 'native';
  }
  // Stale session routing leaves the routed bucket, so the session recreates
  // on the subscription lane (CAN-4200).
  const aiCreditsRouting = effectiveTabAiCreditsRouting(
    opts.aiCreditsRouting,
    billedProviderFor(providerType),
  );
  // A per-session "just this time" activation always wins — even over an
  // explicit subscription override — mirroring the routing resolver.
  if (aiCreditsRouting?.active) {
    const model = aiCreditsRouting.modelId ?? opts.model;
    const route = resolveGatewayModelEntry(model);
    return route?.origin === 'org-gateway'
      ? `routed:org:${route.organizationId ?? ''}:${route.baseUrl ?? ''}:${model ?? ''}`
      : `routed:${model ?? ''}`;
  }
  // A gateway-only model has no native provider that could bill it, so the
  // session running it is routed by definition — `resolveCodexAiCreditsRouting`
  // forces the gateway for exactly this case regardless of mode or native auth,
  // and the renderer's `resolveChatBillingFramework` locks the picker to AI
  // Credits for the same reason. Without this branch the signature is
  // model-independent (`'native'` for a signed-in user with routing off), so
  // switching a live chat from a natively-billable model to a gateway-only one
  // matched the stale signature, reused the session, and never re-ran its
  // one-time routing preparation. The turn then reached the native app-server
  // as a raw model id and came back as "The '<model>' model is not supported
  // when using Codex with a ChatGPT account."
  //
  // Placed above the subscription override on purpose: an override cannot be
  // honored for a model no subscription can pay for, so `'native-forced'` would
  // report native while the spawn routes through the gateway anyway.
  if (isGatewayOnlyModel(opts.model)) {
    const route = resolveGatewayModelEntry(opts.model);
    return route?.origin === 'org-gateway'
      ? `routed:org:${route.organizationId ?? ''}:${route.baseUrl ?? ''}:${opts.model ?? ''}`
      : `routed:${opts.model ?? ''}`;
  }
  // An explicit per-chat subscription override forces native billing and beats
  // the global mode. Use a distinct bucket so flipping the toggle recreates the
  // live session instead of reusing a stale routed/native session; the
  // authoritative async resolution still runs at spawn.
  //
  // The override is only honorable when there is a real native login to bill:
  // `resolveAiCreditsRoutingAttempt` step 2 returns native ONLY on a confirmed
  // `checkNativeAuth()`, and otherwise falls through to `no-native-auth`
  // credits routing. Mirror that here (ECW-9091) — otherwise a chat with the
  // toggle on but no native session reports `'native-forced'` while actually
  // billing credits, mis-attributing its account scope and `aiCreditsRouted`
  // turn metadata exactly as the `!activation` branch below describes.
  if (opts.subscriptionBillingOverride) {
    if (peekProviderNativeAuthAvailability()[providerType] !== false) {
      return 'native-forced';
    }
    return `routed:${opts.model ?? ''}`;
  }
  const activation = resolveAiCreditsRoutingActivation(
    aiCreditsRouting,
    providerType,
  );
  if (!activation) {
    // No mode-driven activation, but a confirmed missing native login still
    // routes through AI Credits (ECW-9091), so the signature must say so —
    // otherwise a credits-routed session reports `'native'` and mis-attributes
    // its account scope and `aiCreditsRouted` turn metadata.
    //
    // `peekProviderNativeAuthAvailability` is the right read here: it is
    // cache-only and synchronous, honoring this function's cheapness contract,
    // and it omits the provider key when cold or probe-failed — degrading to
    // today's `'native'` rather than guessing.
    if (peekProviderNativeAuthAvailability()[providerType] === false) {
      return `routed:${opts.model ?? ''}`;
    }
    return 'native';
  }
  return `routed:${activation.modelId ?? opts.model ?? ''}`;
}

export function getSession(
  projectId: string,
  worktreeId: string,
  chatId: string,
): AgentSession | undefined {
  return sessions.get(sessionKey(projectId, worktreeId, chatId))?.session;
}

/** The selections materialized into the current provider session. */
export function getSessionPluginSelections(
  projectId: string,
  worktreeId: string,
  chatId: string,
): ChatTabPluginSelections | undefined {
  return sessions.get(sessionKey(projectId, worktreeId, chatId))
    ?.pluginSelections;
}

/**
 * Inherited plugin-defaults revision (global plus the chat's workspace, see
 * `getInheritedPluginDefaultsRevision`) the current session was created
 * under, or `undefined` for surfaces that do not inherit defaults.
 */
export function getSessionGlobalPluginDefaultsRevision(
  projectId: string,
  worktreeId: string,
  chatId: string,
): number | undefined {
  return sessions.get(sessionKey(projectId, worktreeId, chatId))
    ?.inheritedPluginDefaultsRevision;
}

/** Drain the existing event owner without disposing a reusable provider query. */
export async function drainChatSessionEvents(
  projectId: string,
  worktreeId: string,
  chatId: string,
): Promise<void> {
  await sessions
    .get(sessionKey(projectId, worktreeId, chatId))
    ?.drainEventsBeforeRemoval?.();
}

export function getSessionProviderType(
  projectId: string,
  worktreeId: string,
  chatId: string,
): AgentProviderType | undefined {
  return sessions.get(sessionKey(projectId, worktreeId, chatId))?.providerType;
}

export function getSessionExecutionHarness(
  projectId: string,
  worktreeId: string,
  chatId: string,
): AgentSessionOptions['executionHarness'] {
  return sessions.get(sessionKey(projectId, worktreeId, chatId))
    ?.executionHarness;
}

/**
 * True iff the live session for a chat is routing its LLM traffic through the
 * AI Credits gateway proxy rather than the native provider subscription. Read
 * from the session's routing signature (`routed:<model>`); `'native'` and
 * `'native-forced'` (explicit subscription override) both return `false`.
 * Returns `false` when there is no live session.
 */
export function isSessionAiCreditsRouted(
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean {
  return getSessionAiCreditsRoutedState(projectId, worktreeId, chatId) === true;
}

/**
 * Tri-state form of {@link isSessionAiCreditsRouted}: `true`/`false` when a
 * live session reports its routing decision, `undefined` when no session is
 * registered.
 *
 * The distinction matters wherever "not routed" is acted on rather than merely
 * recorded. A chat is routinely idle with no session — restart the app, then
 * edit plugin or tool selections before sending anything — and collapsing that
 * absence into `false` makes an AI Credits chat look native, which downgrades
 * its persisted Codex reasoning route family and strips cached reasoning from
 * the rebuilt thread.
 */
export function getSessionAiCreditsRoutedState(
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean | undefined {
  const active = sessions.get(sessionKey(projectId, worktreeId, chatId));
  if (!active) return undefined;
  // A session the account proxy took is billed to a proxy account.
  if (active.accountProxyRouted) return false;
  return active.aiCreditsRoutingSignature.startsWith('routed:');
}

/**
 * Record the route a session actually applied. Accounts can stop being ready
 * between creation and spawn, and a model only AI Credits serves skips the
 * proxy, so the creation-time decision is only a starting point.
 */
export function recordSessionAccountProxyRoute(
  key: string,
  routed: boolean,
): void {
  const entry = sessions.get(key);
  if (entry) entry.accountProxyRouted = routed;
  // The open turn's audit entry was started from the creation-time decision.
  getObservabilityService().setChatTurnAccountProxyRouted(key, routed);
}

/**
 * True when the account proxy serves this chat's live session. Its failures
 * belong to a proxy account, so they must never be treated as the user's own
 * provider sign-in or quota running out.
 */
export function isSessionAccountProxyRouted(
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean {
  return (
    sessions.get(sessionKey(projectId, worktreeId, chatId))
      ?.accountProxyRouted === true
  );
}

/**
 * Return chat IDs for sessions that are actively processing a foreground turn.
 * Sessions that are registered but idle between turns are excluded so
 * that a renderer reload does not incorrectly restore 'streaming' status.
 * A queued-but-not-yet-dequeued message is included because the renderer
 * has already accepted the user's message and should keep the turn visible
 * while provider startup work completes.
 * Background-only work is intentionally excluded here: `hasActiveChatWork()`
 * and `activeBackgroundTaskCount` still protect unloads and diagnostics, but a
 * terminal foreground result should not restore a chat tab as streaming.
 */
export function getActiveChatIds(
  projectId: string,
  worktreeId: string,
): string[] {
  const prefix = `${projectId}/${worktreeId}/`;
  const chatIds: string[] = [];
  for (const [key, entry] of Array.from(sessions.entries())) {
    if (
      key.startsWith(prefix) &&
      (entry.turnActive || entry.pendingMessageCount > 0)
    ) {
      chatIds.push(key.slice(prefix.length));
    }
  }
  return chatIds;
}

/**
 * True while a Codex root turn is paused for user input and may resume when
 * the provider emits its continuation event.
 */
export function hasPendingCodexContinuation(
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean {
  return (
    sessions.get(sessionKey(projectId, worktreeId, chatId))
      ?.codexContinuationRevivalTurn !== undefined
  );
}

/**
 * Return a `ChatActiveSessionInfo` entry for every live session registered
 * with the session manager under the given project/worktree, regardless of
 * whether the session is actively processing a turn. Idle (between-turn)
 * sessions are included with `turnActive: false` so the renderer can
 * distinguish "no live session" from "live but idle session" during
 * post-crash restore.
 *
 * Each entry's `projectId`, `worktreeId`, and `chatId` are parsed from the
 * session key via `parseSessionKey(...)` — not stored separately on
 * `ActiveSession`. `providerType` always reflects the true provider for the
 * session (never a hardcoded default).
 */
function toChatActiveSessionInfo(
  key: string,
  entry: ActiveSession,
): ChatActiveSessionInfo {
  const parsed = parseSessionKey(key);

  return {
    chatId: parsed.chatId,
    projectId: parsed.projectId,
    worktreeId: parsed.worktreeId,
    providerType: entry.providerType,
    ...(entry.executionHarness
      ? { executionHarness: entry.executionHarness }
      : {}),
    turnActive: entry.turnActive,
    createdAt: entry.createdAt,
    lastActivityAt: entry.lastActivityAt,
    turnCount: entry.turnCount,
    pendingMessageCount: entry.pendingMessageCount,
    ...(entry.activeBackgroundTaskIds.size > 0
      ? { activeBackgroundTaskCount: entry.activeBackgroundTaskIds.size }
      : {}),
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.turnStartedAt !== undefined
      ? {
          turnStartedAt: entry.turnStartedAt,
          turnElapsedMs:
            entry.turnElapsedBeforeCurrentSegmentMs +
            Math.max(0, Date.now() - entry.turnStartedAt),
        }
      : {}),
    ...(entry.lastEventType ? { lastEventType: entry.lastEventType } : {}),
  };
}

export function getActiveSessionInfos(
  projectId: string,
  worktreeId: string,
): ChatActiveSessionInfo[] {
  const prefix = `${projectId}/${worktreeId}/`;
  const infos: ChatActiveSessionInfo[] = [];

  for (const [key, entry] of Array.from(sessions.entries())) {
    if (!key.startsWith(prefix)) {
      continue;
    }

    infos.push(toChatActiveSessionInfo(key, entry));
  }

  return infos;
}

export function getActiveSessionCapabilityProfile(
  projectId: string,
  worktreeId: string,
  chatId: string,
):
  | Pick<ActiveSession, 'assistantMode' | 'codeGraphToolsAdvertised'>
  | undefined {
  const session = sessions.get(buildSessionKey(projectId, worktreeId, chatId));
  if (!session) return undefined;
  return {
    assistantMode: session.assistantMode,
    codeGraphToolsAdvertised: session.codeGraphToolsAdvertised,
  };
}

/**
 * Return a `ChatActiveSessionInfo` entry for every live session registered
 * with the session manager, across all projects/worktrees. Unlike
 * `getActiveSessionInfos`, this is not scoped to a single project/worktree —
 * it is used by cross-workspace surfaces (e.g. the usage-limited-chats list
 * IPC backing the account-change resume modal) that need to know about live
 * sessions anywhere in the app, not just within one worktree.
 */
export function getAllActiveSessionInfos(): ChatActiveSessionInfo[] {
  const infos: ChatActiveSessionInfo[] = [];

  for (const [key, entry] of Array.from(sessions.entries())) {
    infos.push(toChatActiveSessionInfo(key, entry));
  }

  return infos;
}

/**
 * Queue an MCP reload on every live Codex session that owns the just-authorized
 * proxy route. Active turns are then steered so the agent can opt into the
 * Codex-only immediate restart when the current request needs that server.
 */
export async function refreshCodexSessionsAfterMcpOAuth(input: {
  serverId: string;
  configId: string;
}): Promise<void> {
  const matching: ActiveSession[] = [];
  for (const entry of Array.from(sessions.values())) {
    if (entry.executionHarness !== 'codex' || !entry.session.reloadMcpServers) {
      continue;
    }
    const route = entry.session.usesMcpServerConfig?.(
      input.serverId,
      input.configId,
    );
    if (route) matching.push(entry);
  }

  await Promise.all(
    matching.map(async (entry) => {
      try {
        await entry.session.reloadMcpServers?.();
        if (!entry.turnActive || !entry.session.steerActiveTurn) return;
        await entry.session.steerActiveTurn(
          '<system_instruction>An MCP server is now connected and its refresh is queued for the next Codex turn. If the current request actually needs the newly connected MCP, end this turn by calling ImmediateTurnRestart. Otherwise continue normally and do not call the restart tool.</system_instruction>',
        );
      } catch (error) {
        // A session can finish or its worker can exit between OAuth callback
        // and refresh. Other matching sessions must still be refreshed.
        logMainProcessWarn(
          `[session-manager] Failed to refresh MCP ${input.serverId}/${input.configId} for a Codex session`,
          error,
        );
      }
    }),
  );
}

export async function destroySession(
  projectId: string,
  worktreeId: string,
  chatId: string,
  options?: {
    suppressObservabilityInterrupt?: boolean;
    /**
     * A recycle (model, provider, approval-mode or plugin change, or a
     * recreate-on-next-turn) replaces only the provider session. The chat's
     * managed delegations belong to the chat, so the old session detaches from
     * them and the next session attaches. Without it, destroying the session
     * also closes the chat's delegation scope, as closing a chat does.
     */
    retainDelegations?: boolean;
  },
): Promise<void> {
  if (options?.retainDelegations !== true && hasDelegationLifecycle())
    await closeDelegationScope({ projectId, worktreeId, chatId });
  suppressCodexAuthenticationRecovery({ projectId, worktreeId, chatId });
  const key = sessionKey(projectId, worktreeId, chatId);
  const entry = sessions.get(key);
  if (!entry) return Promise.resolve();
  const finishRemoval = detachSessionForTeardown(key, entry);
  rejectAllForSession(key);
  return (
    entry.session
      .destroy()
      // After the provider exits, so the tail its tasks wrote on the way out
      // still reaches the renderer before the pollers are discarded.
      .finally(() => flushAndStopOutputPollingForSession(key))
      .finally(() => notifySessionEndedBackgroundTasks(key, entry))
      .finally(() => {
        if (options?.suppressObservabilityInterrupt !== true) {
          getObservabilityService().interruptMatchingEntries(`chat:${key}`);
        }
      })
      .finally(finishRemoval)
      .finally(() => {
        cleanupChatSkillPluginDir(projectId, worktreeId, chatId);
      })
  );
}

/** Destroy all sessions for a given worktree (called before worktree deletion). */
export async function destroyWorktreeSessions(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  if (hasDelegationLifecycle())
    await closeDelegationScope({ projectId, worktreeId });
  const prefix = `${projectId}/${worktreeId}/`;
  const toDestroy: { key: string; entry: ActiveSession }[] = [];

  for (const [key, entry] of Array.from(sessions.entries())) {
    if (key.startsWith(prefix)) {
      toDestroy.push({ key, entry });
    }
  }

  for (const { key, entry } of toDestroy) {
    const onRemoved = entry.onRemoved;
    const drainEventsBeforeRemoval = entry.drainEventsBeforeRemoval;
    // Remove the session from the active map immediately, but keep its event
    // router installed while provider teardown emits and durably commits any
    // terminal events.
    entry.onRemoved = undefined;
    removeSessionEntry(key);
    rejectAllForSession(key);
    try {
      await entry.session.destroy();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[destroyWorktreeSessions] Failed to destroy session ${key}:`,
        err,
      );
    }
    await flushAndStopOutputPollingForSession(key);
    notifySessionEndedBackgroundTasks(key, entry);
    getObservabilityService().interruptMatchingEntries(`chat:${key}`);
    try {
      await drainEventsBeforeRemoval?.();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[destroyWorktreeSessions] Failed to drain session events for ${key}:`,
        err,
      );
    } finally {
      try {
        onRemoved?.();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[session-manager] Session removal callback failed for ${key}:`,
          err,
        );
      }
    }
  }

  // Clean up synthesized skill-plugin directories for this worktree
  cleanupWorktreeChatPluginDirs(projectId, worktreeId);
}

/** Stop providers, drain their terminal events, then record interrupted work. */
export async function destroyAllSessions(
  options: { recordInterrupted?: boolean } = {},
): Promise<void> {
  if (options.recordInterrupted) sessionShutdownStarted = true;
  const entries = Array.from(sessions.entries());
  if (options.recordInterrupted) {
    await Promise.all(
      entries.map(async ([key, entry]) => {
        const drainEventsBeforeRemoval = entry.drainEventsBeforeRemoval;
        entry.drainEventsBeforeRemoval = undefined;
        try {
          await drainEventsBeforeRemoval?.();
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error(
            `[SessionManager] Failed to drain provider events before shutdown for ${key}:`,
            error,
          );
        }
      }),
    );
  }
  const interrupted = entries
    .filter(
      ([, entry]) =>
        entry.turnActive ||
        entry.pendingMessageCount > 0 ||
        entry.activeBackgroundTaskIds.size > 0 ||
        Boolean(entry.codexContinuationRevivalTurn),
    )
    .map(([key, entry]) => ({
      entry,
      interruptedChat: {
        ...parseSessionKey(key),
        provider: entry.providerType,
        detectedAt: Date.now(),
        resumeReason: 'app_shutdown' as const,
        workspaceName: '',
        chatTitle: '',
      },
    }));
  const pendingCreations = Array.from(pendingSessionCreations.values()).map(
    (opts) => ({
      projectId: opts.projectId,
      worktreeId: opts.worktreeId,
      chatId: opts.chatId,
      provider: resolveProviderType(opts),
      detectedAt: Date.now(),
      resumeReason: 'app_shutdown' as const,
      workspaceName: '',
      chatTitle: '',
    }),
  );
  const stopped = await Promise.allSettled(
    entries.map(async ([key, entry]) => {
      const finishRemoval = detachSessionForTeardown(key, entry, {
        deferRemoval: options.recordInterrupted,
      });
      rejectAllForSession(key);
      try {
        await entry.session.destroy();
      } finally {
        entry.abortController.abort();
        await flushAndStopOutputPollingForSession(key);
        notifySessionEndedBackgroundTasks(key, entry);
        getObservabilityService().interruptMatchingEntries(`chat:${key}`);
        await finishRemoval();
      }
    }),
  );
  // Catch pollers whose sessions were already removed before shutdown began.
  stopAllOutputPolling();
  if (options.recordInterrupted)
    pendingShutdownEntries.push(
      ...interrupted.map(({ interruptedChat }) => interruptedChat),
      ...pendingCreations,
    );
  if (options.recordInterrupted && pendingShutdownEntries.length > 0) {
    // Keep these imports deferred to avoid pulling registry and target
    // resolution modules into the session-manager initialization cycle.
    const { recordInterruptedChats } =
      await import('../lib/usage-limited-chats-registry');
    const { isRealWorkspaceTarget } = await import('../lib/chat-targets');
    await recordInterruptedChats(
      pendingShutdownEntries.filter(isRealWorkspaceTarget),
    );
    pendingShutdownEntries = [];
  }
  const failures = stopped.filter((result) => result.status === 'rejected');
  if (failures.length) {
    // Provider transports may already be gone during app shutdown. Interrupted
    // work has been recorded above, so disposal remains best-effort.
    // eslint-disable-next-line no-console
    console.error(
      'Failed to stop one or more chat sessions:',
      failures.map((result) => String(result.reason)),
    );
  }
}

/** A manual Stop wins over an in-flight sign-in checkpoint write. */
export function suppressCodexAuthenticationRecovery(target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): void {
  const recovery = authenticationRecovery;
  const key = sessionKey(target.projectId, target.worktreeId, target.chatId);
  let activeAttemptId: string | undefined;
  if (recovery?.targets.has(key)) {
    recovery.suppressed.add(key);
    activeAttemptId = recovery.attemptId;
  }
  // Keep both imports lazy to avoid extending the session-manager ↔ registry ↔
  // queue-service initialization cycle; packaged Electron main exercises this
  // same deferred resolution path.
  void Promise.all([
    import('../lib/usage-limited-chats-registry'),
    import('../services/chat-queue-service'),
  ])
    .then(
      async ([
        { clearAuthenticationInterruptedChat },
        { getChatQueueService },
      ]) => {
        const queue = getChatQueueService();
        const attemptId =
          activeAttemptId ?? queue.releaseAuthenticationPauseForStop(target);
        if (!attemptId) return;
        if (activeAttemptId)
          queue.releaseAuthenticationPause(target, activeAttemptId);
        await clearAuthenticationInterruptedChat(target, attemptId);
      },
    )
    .catch((error: unknown) =>
      logMainProcessWarn('Could not clear sign-in recovery after Stop.', error),
    );
}

export function getCodexAuthenticationActiveWorkCount(): number {
  return (
    Array.from(sessions.values()).filter(
      (entry) =>
        entry.executionHarness === 'codex' &&
        (entry.turnActive ||
          entry.pendingMessageCount > 0 ||
          entry.activeBackgroundTaskIds.size > 0 ||
          entry.codexContinuationRevivalTurn),
    ).length +
    Array.from(pendingSessionCreations.values()).filter(
      (opts) => resolveExecutionHarness(opts) === 'codex',
    ).length
  );
}

/** Close session admission synchronously; retain interrupted work before login. */
export function pauseCodexSessionsForAuthentication(attemptId: string): {
  paused: Promise<number>;
  release: () => void;
} {
  if (codexAuthenticationGate)
    throw new Error('Codex sign-in is already active.');
  let release = (): void => {};
  codexAuthenticationGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  codexAuthenticationEpoch += 1;
  const entries = Array.from(sessions.entries()).filter(
    ([, entry]) => entry.executionHarness === 'codex',
  );
  const pending = Array.from(pendingSessionCreations.values()).filter(
    (opts) => resolveExecutionHarness(opts) === 'codex',
  );
  const recovery = {
    attemptId,
    targets: new Set([
      ...entries
        .filter(
          ([, entry]) =>
            entry.turnActive ||
            entry.pendingMessageCount > 0 ||
            entry.activeBackgroundTaskIds.size > 0 ||
            entry.codexContinuationRevivalTurn,
        )
        .map(([key]) => key),
      ...pending.map((opts) =>
        sessionKey(opts.projectId, opts.worktreeId, opts.chatId),
      ),
    ]),
    suppressed: new Set<string>(),
  };
  authenticationRecovery = recovery;
  const paused = (async (): Promise<number> => {
    // Keep these imports lazy to avoid extending the session-manager ↔ registry
    // and queue-service initialization cycles; packaged Electron main exercises
    // this same deferred resolution path.
    const { recordInterruptedChats, clearAuthenticationInterruptedChat } =
      await import('../lib/usage-limited-chats-registry');
    const { isRealWorkspaceTarget } = await import('../lib/chat-targets');
    const { getChatQueueService } =
      await import('../services/chat-queue-service');
    const interrupted: UsageLimitedChatEntry[] = pending.map((opts) => ({
      projectId: opts.projectId,
      worktreeId: opts.worktreeId,
      chatId: opts.chatId,
      provider: resolveProviderType(opts),
      detectedAt: Date.now(),
      resumeReason: 'provider_sign_in',
      authenticationAttemptId: attemptId,
      workspaceName: '',
      chatTitle: '',
    }));
    for (const [key, entry] of entries) {
      // Let already delivered terminal events settle before selecting work.
      await entry.drainEventsBeforeRemoval?.();
      if (sessions.get(key) !== entry) continue;
      if (
        entry.turnActive ||
        entry.pendingMessageCount > 0 ||
        entry.activeBackgroundTaskIds.size > 0 ||
        entry.codexContinuationRevivalTurn
      ) {
        const target = parseSessionKey(key);
        interrupted.push({
          ...target,
          provider: entry.providerType,
          detectedAt: Date.now(),
          resumeReason: 'provider_sign_in',
          authenticationAttemptId: attemptId,
          workspaceName: '',
          chatTitle: '',
        });
      }
    }
    await Promise.all(
      interrupted.map((target) =>
        getChatQueueService().pauseForAuthentication(target, attemptId),
      ),
    );
    const recorded = interrupted.filter(
      (target) =>
        isRealWorkspaceTarget(target) &&
        !recovery.suppressed.has(
          sessionKey(target.projectId, target.worktreeId, target.chatId),
        ),
    );
    const recordedKeys = new Set(
      recorded.map((target) =>
        sessionKey(target.projectId, target.worktreeId, target.chatId),
      ),
    );
    // Record before stopping: a crash during teardown still leaves recovery.
    try {
      await recordInterruptedChats(recorded);
    } catch (error) {
      for (const target of interrupted)
        getChatQueueService().releaseAuthenticationPause(target, attemptId);
      throw error;
    }
    for (const target of interrupted) {
      const key = sessionKey(
        target.projectId,
        target.worktreeId,
        target.chatId,
      );
      if (!recordedKeys.has(key))
        getChatQueueService().releaseAuthenticationPause(target, attemptId);
    }
    const results = await Promise.allSettled(
      entries.map(async ([key, entry]) => {
        if (sessions.get(key) !== entry) return;
        // A terminal callback may have completed while the durable record was
        // being written. Retire the idle worker without offering a new turn.
        if (
          !entry.turnActive &&
          entry.pendingMessageCount === 0 &&
          entry.activeBackgroundTaskIds.size === 0 &&
          !entry.codexContinuationRevivalTurn
        ) {
          const target = parseSessionKey(key);
          await clearAuthenticationInterruptedChat(target, attemptId);
          getChatQueueService().releaseAuthenticationPause(target, attemptId);
        }
        rejectAllForSession(key);
        await entry.session.destroy();
        entry.abortController.abort();
        await flushAndStopOutputPollingForSession(key);
        notifySessionEndedBackgroundTasks(key, entry);
        getObservabilityService().interruptMatchingEntries(`chat:${key}`);
        await entry.drainEventsBeforeRemoval?.();
        await detachSessionForTeardown(key, entry)();
      }),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected')
      throw failure.reason instanceof Error
        ? failure.reason
        : new Error(String(failure.reason));
    return recorded.length;
  })();
  return {
    paused,
    release: (): void => {
      codexAuthenticationGate = null;
      if (authenticationRecovery === recovery) authenticationRecovery = null;
      release();
    },
  };
}

export async function destroySessionsByProvider(
  providerType: AgentProviderType,
): Promise<void> {
  return destroyMatchingSessions(
    (entry) => entry.providerType === providerType,
  );
}

export async function destroySessionsByModel(model: ChatModel): Promise<void> {
  return destroyMatchingSessions((entry) => entry.model === model);
}

async function destroyMatchingSessions(
  predicate: (entry: ActiveSession) => boolean,
): Promise<void> {
  const toDestroy: { key: string; entry: ActiveSession }[] = [];

  for (const [key, entry] of Array.from(sessions.entries())) {
    if (predicate(entry)) {
      toDestroy.push({ key, entry });
    }
  }

  for (const { key, entry } of toDestroy) {
    await destroySessionEntry(key, entry, 'destroySessionsByProvider');
  }
}

/** Detach from lookup immediately, but retain delivery until teardown writes drain. */
function detachSessionForTeardown(
  key: string,
  entry: ActiveSession,
  options: { deferRemoval?: boolean } = {},
): () => Promise<void> {
  clearPresentationTurn(key);
  const { onRemoved, drainEventsBeforeRemoval } = entry;
  entry.onRemoved = undefined;
  if (!options.deferRemoval) removeSessionEntry(key);
  return async (): Promise<void> => {
    try {
      await drainEventsBeforeRemoval?.();
    } catch (error) {
      logMainProcessWarn(
        `[session-manager] Failed to drain session events for ${key}`,
        error,
      );
    } finally {
      if (options.deferRemoval) removeSessionEntry(key);
      try {
        onRemoved?.();
      } catch (error) {
        logMainProcessWarn(
          `[session-manager] Session removal callback failed for ${key}`,
          error,
        );
      }
    }
  };
}

async function destroySessionEntry(
  key: string,
  entry: ActiveSession,
  logPrefix: string,
): Promise<void> {
  const finishRemoval = detachSessionForTeardown(key, entry);
  rejectAllForSession(key);
  try {
    await entry.session.destroy();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[${logPrefix}] Failed to destroy session ${key}:`, err);
  } finally {
    await flushAndStopOutputPollingForSession(key);
    notifySessionEndedBackgroundTasks(key, entry);
    getObservabilityService().interruptMatchingEntries(`chat:${key}`);
    await finishRemoval();
  }
}

/**
 * Turns between session acquisition and the provider accepting their prompt.
 * The session is neither turn-active nor queued yet, but its prompt is
 * committed to it; an invalidation that destroyed it would silently drop the
 * turn. Only invalidations that opt in preserve these sessions.
 */
const preparingTurnCounts = new Map<string, number>();

/** Hold the session through turn preparation; the release is idempotent. */
export function beginSessionTurnPreparation(key: string): () => void {
  preparingTurnCounts.set(key, (preparingTurnCounts.get(key) ?? 0) + 1);
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    const remaining = (preparingTurnCounts.get(key) ?? 1) - 1;
    if (remaining > 0) preparingTurnCounts.set(key, remaining);
    else preparingTurnCounts.delete(key);
  };
}

/**
 * Preparations whose prompt was handed to the provider but whose turn is not
 * active yet. A provider may still await work (Claude reads its inventory)
 * between dequeuing the prompt and marking the turn active.
 */
const handedOffTurnPreparations = new Map<string, Array<() => void>>();

/** Keep a preparation hold until the session's next turn activation. */
export function releaseSessionTurnPreparationOnActivation(
  key: string,
  release: () => void,
): void {
  if (!sessions.has(key)) {
    release();
    return;
  }
  const pending = handedOffTurnPreparations.get(key) ?? [];
  pending.push(release);
  handedOffTurnPreparations.set(key, pending);
}

function releaseHandedOffTurnPreparations(
  key: string,
  scope: 'next' | 'all',
): void {
  const pending = handedOffTurnPreparations.get(key);
  if (!pending) return;
  const released = scope === 'all' ? pending.splice(0) : pending.splice(0, 1);
  if (pending.length === 0) handedOffTurnPreparations.delete(key);
  for (const release of released) release();
}

export async function invalidateProviderAuthSessions(
  providerType: Extract<AgentProviderType, 'claude' | 'codex'>,
  reason: string,
  options: {
    /**
     * Passive status probes preserve in-flight/queued work and mark those
     * sessions for recreation at the next turn boundary. Explicit user auth
     * actions may interrupt immediately.
     */
    activeTurnPolicy?: 'interrupt' | 'preserve';
    /**
     * Also preserve sessions whose turn is still being prepared. Only for a
     * passive account-identity confirmation: a routing or policy change must
     * not let a not-yet-sent prompt leave on the retired route.
     */
    preservePreparingTurns?: boolean;
  } = {},
): Promise<void> {
  providerSessionAuthGenerations.set(
    providerType,
    getProviderSessionAuthGeneration(providerType) + 1,
  );
  if (options.activeTurnPolicy !== 'preserve')
    providerAuthGenerations.set(
      providerType,
      getProviderAuthGeneration(providerType) + 1,
    );
  if (options.activeTurnPolicy !== 'preserve' && hasDelegationLifecycle()) {
    try {
      await revokeDelegationLifecycle(providerType);
    } catch (error) {
      logMainProcessWarn(
        `[invalidateProviderAuthSessions:${providerType}:${reason}] Delegation revocation failed; continuing provider session invalidation`,
        error,
      );
    }
  }

  const toDestroy: { key: string; entry: ActiveSession }[] = [];
  for (const [key, entry] of Array.from(sessions.entries())) {
    if (entry.providerType !== providerType) {
      continue;
    }
    const hasActiveWork =
      entry.turnActive ||
      entry.pendingMessageCount > 0 ||
      entry.activeBackgroundTaskIds.size > 0 ||
      (options.preservePreparingTurns === true && preparingTurnCounts.has(key));
    if (options.activeTurnPolicy === 'preserve' && hasActiveWork) {
      entry.recreateOnNextTurn = true;
      continue;
    }
    toDestroy.push({ key, entry });
  }

  for (const { key, entry } of toDestroy) {
    await destroySessionEntry(
      key,
      entry,
      `invalidateProviderAuthSessions:${providerType}:${reason}`,
    );
  }
}

export async function invalidateSessionsForOrganizations(
  organizationIds: readonly string[] | 'all-org-owned',
  reason: string,
  options: { activeTurnPolicy?: 'interrupt' | 'preserve' } = {},
): Promise<void> {
  const normalizedOrganizationIds =
    organizationIds === 'all-org-owned'
      ? organizationIds
      : new Set(organizationIds.map((id) => id.toLowerCase()));
  const toDestroy: { key: string; entry: ActiveSession }[] = [];

  for (const [key, entry] of Array.from(sessions.entries())) {
    const [projectId, worktreeId, chatId] = key.split('/');
    // Map through the enforcement owner, as the gates do: with org projects
    // off every session reads as Personal but is governed by the union, so
    // it must be retired like an unknown owner.
    const owner = resolveEnforcementOwner(
      projectId && worktreeId && chatId
        ? await peekSessionWorkOwner({ projectId, worktreeId, chatId })
        : undefined,
    );
    const affected =
      owner === undefined ||
      (owner.kind === 'organization' &&
        (normalizedOrganizationIds === 'all-org-owned' ||
          normalizedOrganizationIds.has(owner.organizationId.toLowerCase())));
    if (!affected) continue;

    const hasActiveWork =
      entry.turnActive ||
      entry.pendingMessageCount > 0 ||
      entry.activeBackgroundTaskIds.size > 0;
    if (options.activeTurnPolicy === 'preserve' && hasActiveWork) {
      entry.recreateOnNextTurn = true;
      continue;
    }
    toDestroy.push({ key, entry });
  }

  for (const { key, entry } of toDestroy) {
    await destroySessionEntry(
      key,
      entry,
      `invalidateSessionsForOrganizations:${reason}`,
    );
  }
}

/**
 * Raised when a stop request names a chat whose provider session (or whose
 * provider query) is already gone. Callers treat this as "the task is already
 * dead" and reconcile the activity card rather than surfacing a failure.
 */
export class SessionUnavailableForTaskStopError extends Error {
  constructor(message = 'No active session is available to stop that task') {
    super(message);
    this.name = 'SessionUnavailableForTaskStopError';
  }
}

export function isSessionUnavailableForTaskStopError(error: unknown): boolean {
  return (
    error instanceof SessionUnavailableForTaskStopError ||
    (error instanceof Error &&
      error.name === 'SessionUnavailableForTaskStopError')
  );
}

/**
 * `'already-finished'` means the provider accepted the request but reported the
 * task was not running, so no terminal notification will ever arrive for it.
 */
export type StopBackgroundTaskOutcome = 'stopped' | 'already-finished';

/**
 * The context-window breakdown for a live chat. Only Claude sessions report
 * categories; other harnesses and chats without a live session resolve
 * `null`, and the composer falls back to the plain meter.
 */
export async function getContextUsageForSession(
  projectId: string,
  worktreeId: string,
  chatId: string,
): Promise<ChatContextUsageBreakdown | null> {
  const entry = sessions.get(sessionKey(projectId, worktreeId, chatId));
  if (
    !entry ||
    entry.executionHarness === 'codex' ||
    entry.executionHarness === 'cursor'
  ) {
    return null;
  }
  const { getContextUsageForClaudeSession } = await import('./claude-session');
  return getContextUsageForClaudeSession(projectId, worktreeId, chatId);
}

export async function stopTaskForSession(
  projectId: string,
  worktreeId: string,
  chatId: string,
  taskId: string,
): Promise<StopBackgroundTaskOutcome> {
  const entry = sessions.get(sessionKey(projectId, worktreeId, chatId));
  if (!entry) {
    throw new SessionUnavailableForTaskStopError();
  }

  if (entry.executionHarness === 'codex') {
    throw new Error(
      'Stopping individual tasks is not supported for Codex sessions',
    );
  }

  const { stopTaskForClaudeSession } = await import('./claude-session');
  const outcome = await stopTaskForClaudeSession(
    projectId,
    worktreeId,
    chatId,
    taskId,
  );
  if (outcome === 'already-finished') {
    entry.liveBackgroundTasks.delete(taskId);
  }
  return outcome;
}

/**
 * Register an active session. Called by providers when creating a session.
 */
export function registerSession(
  key: string,
  session: AgentSession,
  abortController: AbortController,
  providerType: AgentProviderType,
  model?: ChatModel,
  assistantMode: AssistantMode = 'default',
  toolProfileHash = 'default',
  codeGraphToolsAdvertised = false,
  executionHarness?: AgentSessionOptions['executionHarness'],
): void {
  // If we're overwriting an active entry that holds a wake lock, release it
  // first so we don't strand the holder when the new entry initializes
  // `wakeLockHeld: false`.
  const previous = sessions.get(key);
  if (previous?.wakeLockHeld) {
    getWakeLockService().release(`chat:${key}`);
  }
  const now = Date.now();
  sessions.set(key, {
    session,
    abortController,
    providerType,
    executionHarness:
      executionHarness ??
      (model ? getExecutionHarnessForModel(model) : undefined) ??
      (providerType === 'codex' ? 'codex' : 'claude'),
    workOwnerKey: 'unknown',
    authGeneration: getProviderSessionAuthGeneration(providerType),
    ...(model ? { model } : {}),
    selectedModel: model,
    pluginSelectionsSignature: 'null',
    deferredToolsAllowed: true,
    // Defaults to native; getOrCreateSession stamps the resolved signature
    // right after the provider registers the session.
    aiCreditsRoutingSignature: 'native',
    recreateOnNextTurn: false,
    turnActive: false,
    activeUserMessageId: undefined,
    activeTurnCancelRequested: false,
    createdAt: now,
    lastActivityAt: now,
    turnElapsedBeforeCurrentSegmentMs: 0,
    turnCount: 0,
    pendingMessageCount: 0,
    activeBackgroundTaskIds: new Set<string>(),
    continuationToolUseIds: new Set<string>(),
    liveBackgroundTasks: new Map<string, LiveBackgroundTask>(),
    foregroundTaskMetadata: new Map<string, LiveBackgroundTask>(),
    claudeNativeSubagentTasks: new Map<string, ClaudeNativeSubagentTask>(),
    codexNativeSubagentThreadIds: new Set<string>(),
    codexNativeSubagentTurns: new Map<string, string>(),
    wakeLockHeld: false,
    assistantMode,
    toolProfileHash,
    codeGraphToolsAdvertised,
  });
  const entry = sessions.get(key);
  if (entry) {
    recordSessionDiagnostic(key, entry, {
      kind: 'session_registered',
    });
  }
  notifyChatSessionActivityListeners();
}

export function getSessionCodeGraphToolsAdvertised(
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean | undefined {
  return sessions.get(sessionKey(projectId, worktreeId, chatId))
    ?.codeGraphToolsAdvertised;
}

export function getSessionGlobalInstructionsSnapshot(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string | undefined {
  return sessions.get(sessionKey(projectId, worktreeId, chatId))
    ?.globalInstructionsSnapshot;
}

export function updateSessionModel(key: string, model: ChatModel): void {
  const entry = sessions.get(key);
  if (!entry) {
    return;
  }

  sessions.set(key, {
    ...entry,
    model,
    selectedModel: model,
  });
}

export function getSessionSelectedModel(
  projectId: string,
  worktreeId: string,
  chatId: string,
): ChatModel | undefined {
  const entry = sessions.get(sessionKey(projectId, worktreeId, chatId));
  return entry?.selectedModel ?? entry?.reportedModel;
}

export function markSessionForNextTurnRecreation(
  projectId: string,
  worktreeId: string,
  chatId: string,
): void {
  const key = sessionKey(projectId, worktreeId, chatId);
  const entry = sessions.get(key);
  if (!entry) {
    return;
  }

  sessions.set(key, {
    ...entry,
    recreateOnNextTurn: true,
  });
}

/** Refresh both parent harnesses at the next turn boundary, without interrupting root work. */
export function markManagedDelegationSessionsForNextTurnRecreation(
  nextMode: AgentSessionOptions['managedDelegationMode'],
): void {
  for (const [key, entry] of Array.from(sessions.entries())) {
    if (
      entry.managedDelegationSurface === 'worktree-chat' &&
      !managedDelegationModesShareProviderSession(
        entry.managedDelegationMode,
        nextMode,
      )
    )
      sessions.set(key, { ...entry, recreateOnNextTurn: true });
  }
}

export type CodexChatScope = 'worktree' | 'standalone' | 'app-advisor' | 'all';

export function markCodexSessionsForNextTurnRecreation(
  scope: CodexChatScope,
): void {
  for (const [key, entry] of Array.from(sessions.entries())) {
    if (entry.executionHarness !== 'codex') {
      continue;
    }

    const { projectId } = parseSessionKey(key);
    const sessionScope =
      projectId === APP_ADVISOR_PROJECT_ID
        ? 'app-advisor'
        : isCoworkWorkspace(projectId)
          ? 'standalone'
          : 'worktree';
    if (scope !== 'all' && scope !== sessionScope) continue;

    sessions.set(key, {
      ...entry,
      recreateOnNextTurn: true,
    });
  }
}

export function shouldRecreateSessionOnNextTurn(
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean {
  return Boolean(
    sessions.get(sessionKey(projectId, worktreeId, chatId))?.recreateOnNextTurn,
  );
}

function warnCodexIdleTimeoutPropagationFailure(
  detail: string,
  error: unknown,
): void {
  const warning = error instanceof Error ? error : String(error);
  process.emitWarning(warning, {
    type: 'CanopyWarning',
    code: 'CANOPY_CODEX_IDLE_TIMEOUT_PROPAGATION_FAILED',
    detail,
  });
}

export function updateCodexSessionIdleTimeoutMinutes(minutes: number): void {
  for (const entry of Array.from(sessions.values())) {
    if (entry.executionHarness !== 'codex') {
      continue;
    }

    try {
      const updatePromise =
        entry.session.setCodexAppServerIdleTimeoutMinutes?.(minutes);
      if (updatePromise) {
        void updatePromise.catch((error: unknown) => {
          warnCodexIdleTimeoutPropagationFailure(
            'Codex idle-timeout propagation rejected asynchronously.',
            error,
          );
        });
      }
    } catch (error: unknown) {
      // Keep updating remaining Codex sessions if one session rejects
      // synchronously.
      warnCodexIdleTimeoutPropagationFailure(
        'Codex idle-timeout propagation threw synchronously.',
        error,
      );
    }
  }
}

/** Mark a session as actively processing a turn (called when a message is dequeued). */
export function markTurnActive(key: string, userMessageId?: string): void {
  const entry = sessions.get(key);
  if (!entry) {
    return;
  }
  const [projectId, worktreeId] = key.split('/', 2);
  if (projectId && worktreeId) {
    assertWorkspaceTargetRuntimeStartAllowed(projectId, worktreeId);
  }

  const now = Date.now();
  const wasTurnActive = entry.turnActive;
  if (!entry.turnActive) {
    entry.turnElapsedBeforeCurrentSegmentMs = 0;
    entry.turnStartedAt = now;
    entry.turnCount += 1;
  }
  entry.turnActive = true;
  if (entry.activeUserMessageId !== userMessageId) {
    entry.activeTurnCancelRequested = false;
  }
  entry.activeUserMessageId = userMessageId;
  if (
    userMessageId !== undefined &&
    pendingTurnCancels.get(key)?.delete(userMessageId)
  ) {
    // An exact-turn stop arrived before this turn started; apply it once the
    // provider's start returns, still by the same message identity.
    void Promise.resolve()
      .then(() => cancelActiveChatTurn(key, userMessageId))
      .catch(() => undefined);
  }
  entry.codexContinuationRevivalTurn = undefined;
  entry.lastActivityAt = now;
  entry.pendingMessageCount = Math.max(0, entry.pendingMessageCount - 1);
  releaseHandedOffTurnPreparations(key, 'next');
  if (!wasTurnActive) {
    recordSessionDiagnostic(key, entry, {
      kind: 'turn_active',
    });
    notifyChatSessionActivityListeners();
  }
  syncWakeLockForSession(key, entry);
}

function markTurnIdleState(
  key: string,
  continuationRevivalAllowed: boolean,
): void {
  const entry = sessions.get(key);
  if (!entry) {
    return;
  }

  const wasTurnActive = entry.turnActive;
  const hadPendingMessages = entry.pendingMessageCount > 0;
  entry.turnActive = false;
  // Awaiting user input is a temporary idle segment of the same message, so
  // preserve its identity until a provider continuation or terminal idle.
  if (!continuationRevivalAllowed) {
    entry.activeUserMessageId = undefined;
    entry.activeTurnCancelRequested = false;
  }
  entry.codexContinuationRevivalTurn =
    continuationRevivalAllowed &&
    entry.executionHarness === 'codex' &&
    entry.codexRootThreadId &&
    entry.codexRootTurnId
      ? {
          threadId: entry.codexRootThreadId,
          turnId: entry.codexRootTurnId,
        }
      : undefined;
  const now = Date.now();
  if (wasTurnActive && entry.turnStartedAt !== undefined) {
    entry.turnElapsedBeforeCurrentSegmentMs += Math.max(
      0,
      now - entry.turnStartedAt,
    );
  }
  entry.lastActivityAt = now;
  entry.turnStartedAt = undefined;
  entry.pendingMessageCount = 0;
  if (wasTurnActive) {
    recordSessionDiagnostic(key, entry, {
      kind: 'turn_idle',
    });
  }
  if (wasTurnActive || hadPendingMessages) {
    notifyChatSessionActivityListeners();
  }
  syncWakeLockForSession(key, entry);
}

/**
 * Request cancellation only when the requested user message owns the
 * provider turn, including while that turn is paused for user input (its
 * identity is kept until terminal idle). The provider is notified
 * synchronously; completion remains owned by its normal terminal-event path.
 */
export function cancelActiveChatTurn(
  key: string,
  userMessageId: string,
): boolean {
  const entry = sessions.get(key);
  if (!entry || entry.activeUserMessageId !== userMessageId) {
    return false;
  }
  pendingTurnCancels.get(key)?.delete(userMessageId);
  if (entry.activeTurnCancelRequested) {
    return true;
  }

  entry.activeTurnCancelRequested = true;
  // Claude-compatible providers stop by aborting the session-wide query, as
  // the chat Stop does; the next turn must start a fresh session.
  if (entry.providerType === 'claude' || entry.providerType === 'ollama') {
    entry.recreateOnNextTurn = true;
  }
  try {
    const cancellation = entry.session.cancel();
    void cancellation.catch(() => {
      if (
        sessions.get(key) === entry &&
        entry.activeUserMessageId === userMessageId
      ) {
        entry.activeTurnCancelRequested = false;
      }
    });
  } catch (error: unknown) {
    entry.activeTurnCancelRequested = false;
    throw error;
  }
  return true;
}

/**
 * Exact-turn stops requested before the provider marked their turn active,
 * by session key. Each applies only to its own user message.
 */
const pendingTurnCancels = new Map<string, Set<string>>();

/**
 * Stop the named turn now if it owns the provider turn, or as soon as the
 * provider marks it active. It never stops any other turn.
 */
export function requestChatTurnCancel(
  key: string,
  userMessageId: string,
): void {
  if (cancelActiveChatTurn(key, userMessageId)) return;
  const pending = pendingTurnCancels.get(key) ?? new Set<string>();
  pending.add(userMessageId);
  pendingTurnCancels.set(key, pending);
}

/** Mark a session as idle between turns (called when a result/error event is emitted). */
export function markTurnIdle(key: string): void {
  markTurnIdleState(key, false);
}

/**
 * Mark a turn as temporarily idle while it awaits user input. A subsequent
 * provider continuation event may revive this same turn.
 */
export function markTurnAwaitingUser(key: string): void {
  markTurnIdleState(key, true);
}

export function markChatSessionIdle(
  projectId: string,
  worktreeId: string,
  chatId: string,
): void {
  markTurnIdle(sessionKey(projectId, worktreeId, chatId));
}

export function noteSessionMessageQueued(
  key: string,
  pendingMessageCount: number,
): void {
  const entry = sessions.get(key);
  if (!entry) {
    return;
  }

  const previousPendingMessageCount = entry.pendingMessageCount;
  if (pendingMessageCount > previousPendingMessageCount) {
    const [projectId, worktreeId] = key.split('/', 2);
    if (projectId && worktreeId) {
      assertWorkspaceTargetRuntimeStartAllowed(projectId, worktreeId);
    }
  }
  entry.pendingMessageCount = pendingMessageCount;
  entry.lastActivityAt = Date.now();
  if (pendingMessageCount > previousPendingMessageCount) {
    recordSessionDiagnostic(key, entry, {
      kind: 'message_queued',
    });
    notifyChatSessionActivityListeners();
  }
  syncWakeLockForSession(key, entry);
}

export function recordSessionEvent(key: string, data: unknown): void {
  const entry = sessions.get(key);
  if (!entry) {
    return;
  }

  entry.lastActivityAt = Date.now();
  entry.lastEventType = describeChatEventData(data, {
    includePhaseEvents: true,
  });
  if (
    entry.providerType === 'claude' &&
    entry.model === undefined &&
    entry.reportedModel === undefined
  ) {
    const event = isPlainRecord(data) ? data : undefined;
    const message =
      event && isPlainRecord(event.message) ? event.message : undefined;
    const reportedModel = message
      ? resolveKnownModel(readRecordString(message, 'model') ?? '')
      : undefined;
    if (reportedModel) {
      entry.reportedModel = reportedModel;
    }
  }
  updateCodexRootTurnIdentity(entry, data);
  updateNativeSubagentCorrelation(entry, data);
  const backgroundTaskActivityChanged = updateBackgroundTaskState(entry, data);
  updateLiveBackgroundTaskState(entry, data);
  const turnRevived = reviveTurnForAgentContinuation(key, entry, data);
  if (turnRevived || backgroundTaskActivityChanged) {
    notifyChatSessionActivityListeners();
  }
  syncWakeLockForSession(key, entry);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRecordString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function isTerminalTaskStatus(status: string | undefined): boolean {
  return (
    status === undefined ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'stopped' ||
    status === 'killed' ||
    status === 'cancelled' ||
    status === 'canceled'
  );
}

function reviveTurnForAgentContinuation(
  key: string,
  entry: ActiveSession,
  data: unknown,
): boolean {
  if (entry.turnActive || !isAgentContinuationEvent(data)) {
    return false;
  }
  // A backgrounded Claude subagent keeps streaming child frames after the
  // root result. The transcript never reopens a settled turn for them, so the
  // session must not report it live either (Portal `turnActive`).
  if (isPlainRecord(data) && typeof data.parent_tool_use_id === 'string') {
    return false;
  }
  if (entry.executionHarness === 'codex' && !canReviveCodexTurn(entry, data)) {
    return false;
  }

  // Keep the same message identity while a provider resumes a turn that was
  // temporarily idle for user input; only its terminal idle clears the ID.
  entry.turnActive = true;
  entry.codexContinuationRevivalTurn = undefined;
  entry.turnStartedAt = Date.now();
  entry.lastActivityAt = entry.turnStartedAt;
  recordSessionDiagnostic(key, entry, {
    kind: 'turn_active',
  });
  return true;
}

function readCodexEventIdentity(data: unknown): CodexTurnIdentity | undefined {
  if (!isPlainRecord(data) || data.type !== 'codex') {
    return undefined;
  }
  const event = isPlainRecord(data.event) ? data.event : undefined;
  if (!event) {
    return undefined;
  }
  const threadId = readRecordString(event, 'thread_id');
  const turnId = readRecordString(event, 'turn_id');
  return threadId && turnId ? { threadId, turnId } : undefined;
}

function updateCodexRootTurnIdentity(
  entry: ActiveSession,
  data: unknown,
): void {
  if (entry.executionHarness !== 'codex' || !isPlainRecord(data)) {
    return;
  }

  if (
    data.type === 'system' &&
    data.subtype === 'init' &&
    typeof data.session_id === 'string'
  ) {
    if (entry.codexRootThreadId !== data.session_id) {
      entry.codexNativeSubagentThreadIds.clear();
      entry.codexNativeSubagentTurns.clear();
    }
    entry.codexRootThreadId = data.session_id;
    entry.codexRootTurnId = undefined;
    entry.codexContinuationRevivalTurn = undefined;
    return;
  }

  if (!isPlainRecord(data.event) || data.event.type !== 'turn.started') {
    return;
  }
  const identity = readCodexEventIdentity(data);
  if (identity && identity.threadId === entry.codexRootThreadId) {
    if (
      entry.codexRootTurnId !== undefined &&
      entry.codexRootTurnId !== identity.turnId
    ) {
      // Receiver ids belong to the root turn that announced them. Retire them
      // before accepting events from a later turn so stale UI ids cannot be
      // mistaken for a current child.
      entry.codexNativeSubagentThreadIds.clear();
      entry.codexNativeSubagentTurns.clear();
    }
    entry.codexRootTurnId = identity.turnId;
  }
}

function updateNativeSubagentCorrelation(
  entry: ActiveSession,
  data: unknown,
): void {
  if (entry.executionHarness === 'claude') {
    updateClaudeNativeSubagentTasks(entry, data);
    return;
  }
  if (entry.executionHarness === 'codex') {
    updateCodexNativeSubagentTurns(entry, data);
  }
}

const MAX_CLAUDE_NATIVE_SUBAGENT_TASKS = 256;

function updateClaudeNativeSubagentTasks(
  entry: ActiveSession,
  data: unknown,
): void {
  if (!isPlainRecord(data) || data.type !== 'system') return;
  const subtype = readRecordString(data, 'subtype');
  const taskId = readRecordString(data, 'task_id');
  if (!subtype || !taskId) return;

  if (subtype === 'task_started') {
    const toolUseId = readRecordString(data, 'tool_use_id');
    const taskType = readRecordString(data, 'task_type');
    const subagentType = readRecordString(data, 'subagent_type');
    // `task_type` is the provider's stable discriminant. Older SDKs may omit
    // it while still publishing `subagent_type`, which is specific to Task
    // tool subagents. Do not index Bash or other background tasks.
    if (
      !toolUseId ||
      (taskType !== 'local_agent' && subagentType === undefined)
    ) {
      return;
    }
    entry.claudeNativeSubagentTasks.delete(toolUseId);
    entry.claudeNativeSubagentTasks.set(toolUseId, {
      taskId,
      backgrounded: data.is_backgrounded === true,
    });
    while (
      entry.claudeNativeSubagentTasks.size > MAX_CLAUDE_NATIVE_SUBAGENT_TASKS
    ) {
      const oldestToolUseId = entry.claudeNativeSubagentTasks
        .keys()
        .next().value;
      if (typeof oldestToolUseId !== 'string') break;
      entry.claudeNativeSubagentTasks.delete(oldestToolUseId);
    }
    return;
  }

  if (subtype === 'task_notification') {
    if (isTerminalTaskStatus(readRecordString(data, 'status'))) {
      deleteClaudeNativeSubagentTaskByTaskId(entry, taskId);
    }
    return;
  }

  if (subtype !== 'task_updated' || !isPlainRecord(data.patch)) return;
  if (isTerminalTaskUpdatePatchStatus(readRecordString(data.patch, 'status'))) {
    deleteClaudeNativeSubagentTaskByTaskId(entry, taskId);
    return;
  }
  if (data.patch.is_backgrounded !== true) return;
  for (const task of Array.from(entry.claudeNativeSubagentTasks.values())) {
    if (task.taskId === taskId) task.backgrounded = true;
  }
}

function deleteClaudeNativeSubagentTaskByTaskId(
  entry: ActiveSession,
  taskId: string,
): void {
  for (const [toolUseId, task] of Array.from(entry.claudeNativeSubagentTasks)) {
    if (task.taskId === taskId) {
      entry.claudeNativeSubagentTasks.delete(toolUseId);
    }
  }
}

const MAX_CODEX_NATIVE_SUBAGENT_THREADS = 256;

function updateCodexNativeSubagentTurns(
  entry: ActiveSession,
  data: unknown,
): void {
  if (
    !isPlainRecord(data) ||
    data.type !== 'codex' ||
    !isPlainRecord(data.event)
  ) {
    return;
  }
  const event = data.event;
  const eventType = readRecordString(event, 'type');
  const threadId = readRecordString(event, 'thread_id');
  if (!eventType || !threadId) return;

  if (
    eventType === 'item.started' ||
    eventType === 'item.updated' ||
    eventType === 'item.completed'
  ) {
    if (
      threadId !== entry.codexRootThreadId ||
      readRecordString(event, 'turn_id') !== entry.codexRootTurnId ||
      !isPlainRecord(event.item)
    ) {
      return;
    }
    const item = event.item;
    const itemType = readRecordString(item, 'type');
    if (
      itemType === 'collab_agent_tool_call' ||
      itemType === 'collabAgentToolCall'
    ) {
      const receiverIds = readRecordStringArray(
        item.receiver_thread_ids ?? item.receiverThreadIds,
      );
      for (const receiverId of receiverIds) {
        if (eventType === 'item.completed') {
          retireCodexNativeSubagentThread(entry, receiverId);
        } else {
          rememberCodexNativeSubagentThread(entry, receiverId);
        }
      }
    } else if (
      itemType === 'sub_agent_activity' ||
      itemType === 'subAgentActivity'
    ) {
      const childId =
        readRecordString(item, 'agent_thread_id') ??
        readRecordString(item, 'agentThreadId');
      if (childId) {
        if (eventType === 'item.completed') {
          retireCodexNativeSubagentThread(entry, childId);
        } else {
          rememberCodexNativeSubagentThread(entry, childId);
        }
      }
    }
    return;
  }

  if (eventType === 'turn.started') {
    const turnId = readRecordString(event, 'turn_id');
    if (
      turnId &&
      threadId !== entry.codexRootThreadId &&
      entry.codexNativeSubagentThreadIds.has(threadId)
    ) {
      entry.codexNativeSubagentTurns.set(threadId, turnId);
    }
    return;
  }

  if (
    eventType === 'turn.completed' ||
    eventType === 'turn.failed' ||
    eventType === 'error'
  ) {
    const activeTurnId = entry.codexNativeSubagentTurns.get(threadId);
    const reportedTurnId = readRecordString(event, 'turn_id');
    if (
      entry.codexNativeSubagentThreadIds.has(threadId) &&
      (activeTurnId === undefined ||
        reportedTurnId === undefined ||
        reportedTurnId === activeTurnId)
    ) {
      retireCodexNativeSubagentThread(entry, threadId);
    }
    if (
      threadId === entry.codexRootThreadId &&
      (!reportedTurnId || reportedTurnId === entry.codexRootTurnId)
    ) {
      entry.codexNativeSubagentThreadIds.clear();
      entry.codexNativeSubagentTurns.clear();
    }
  }
}

function readRecordStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (candidate): candidate is string =>
      typeof candidate === 'string' && candidate.length > 0,
  );
}

function rememberCodexNativeSubagentThread(
  entry: ActiveSession,
  threadId: string,
): void {
  if (!threadId || threadId === entry.codexRootThreadId) return;
  entry.codexNativeSubagentThreadIds.delete(threadId);
  entry.codexNativeSubagentThreadIds.add(threadId);
  while (
    entry.codexNativeSubagentThreadIds.size > MAX_CODEX_NATIVE_SUBAGENT_THREADS
  ) {
    const oldestThreadId = entry.codexNativeSubagentThreadIds
      .values()
      .next().value;
    if (typeof oldestThreadId !== 'string') break;
    entry.codexNativeSubagentThreadIds.delete(oldestThreadId);
    entry.codexNativeSubagentTurns.delete(oldestThreadId);
  }
}

function retireCodexNativeSubagentThread(
  entry: ActiveSession,
  threadId: string,
): void {
  entry.codexNativeSubagentThreadIds.delete(threadId);
  entry.codexNativeSubagentTurns.delete(threadId);
}

export type CodexNativeSubagentInterruptState =
  | 'not_found'
  | 'not_running'
  | 'running';

/** Resolve a Codex receiver only from its owning root's correlated events. */
export function getCodexNativeSubagentInterruptState(
  projectId: string,
  worktreeId: string,
  chatId: string,
  subagentThreadId: string,
): CodexNativeSubagentInterruptState {
  const entry = sessions.get(sessionKey(projectId, worktreeId, chatId));
  if (
    !entry ||
    entry.executionHarness !== 'codex' ||
    subagentThreadId === entry.codexRootThreadId ||
    !entry.codexNativeSubagentThreadIds.has(subagentThreadId)
  ) {
    return 'not_found';
  }
  return entry.codexNativeSubagentTurns.has(subagentThreadId)
    ? 'running'
    : 'not_running';
}

export function getClaudeNativeSubagentTaskForSession(
  projectId: string,
  worktreeId: string,
  chatId: string,
  toolUseId: string,
): ClaudeNativeSubagentTask | undefined {
  const entry = sessions.get(sessionKey(projectId, worktreeId, chatId));
  if (!entry || entry.executionHarness !== 'claude') return undefined;
  const task = entry.claudeNativeSubagentTasks.get(toolUseId);
  return task ? { ...task } : undefined;
}

function canReviveCodexTurn(entry: ActiveSession, data: unknown): boolean {
  const identity = readCodexEventIdentity(data);
  if (!identity || identity.threadId !== entry.codexRootThreadId) {
    return false;
  }

  const event = isPlainRecord(data) ? data.event : undefined;
  if (isPlainRecord(event) && event.type === 'turn.started') {
    return identity.turnId === entry.codexRootTurnId;
  }

  return (
    identity.threadId === entry.codexContinuationRevivalTurn?.threadId &&
    identity.turnId === entry.codexContinuationRevivalTurn.turnId
  );
}

/** A `task_updated` patch only reports a terminal state when it names one. */
function isTerminalTaskUpdatePatchStatus(status: string | undefined): boolean {
  return status !== undefined && isTerminalTaskStatus(status);
}

/**
 * Maintain the session's complete live background-task set.
 *
 * The SDK describes background tasks with a level signal
 * (`background_tasks_changed`, REPLACE semantics over the full live set) plus
 * an edge stream (`task_started`, `task_updated`, `task_notification`). Neither
 * is sufficient alone: nothing is emitted at CLI startup, so a resumed process
 * must start empty and repopulate, while a task that is backgrounded mid-turn
 * only shows up as an edge until the next level signal.
 *
 * `ambient` tasks are excluded: they are provider housekeeping and must never
 * appear as agent activity.
 */
function updateLiveBackgroundTaskState(
  entry: LiveBackgroundTaskOwner,
  data: unknown,
): void {
  if (!isPlainRecord(data) || data.type !== 'system') {
    return;
  }

  const subtype = readRecordString(data, 'subtype');

  // `system`/`init` is NOT a process boundary: the CLI emits a top-level init at
  // the start of every turn inside one long-lived process. Process lifecycle is
  // signalled by `resetSessionLiveBackgroundTasks` at query start and by
  // teardown, both of which main owns directly.
  if (data.ambient === true) {
    return;
  }

  if (subtype === 'background_tasks_changed') {
    if (!Array.isArray(data.tasks)) {
      return;
    }
    const replacement = new Map<string, LiveBackgroundTask>();
    for (const task of data.tasks) {
      if (!isPlainRecord(task) || task.ambient === true) continue;
      const taskId = readRecordString(task, 'task_id');
      if (!taskId) continue;
      const previous = entry.liveBackgroundTasks.get(taskId);
      const toolUseId =
        readRecordString(task, 'tool_use_id') ?? previous?.toolUseId;
      const description =
        readRecordString(task, 'description') ?? previous?.description;
      replacement.set(taskId, {
        ...(toolUseId ? { toolUseId } : {}),
        ...(description ? { description } : {}),
      });
    }
    entry.liveBackgroundTasks = replacement;
    return;
  }

  const taskId = readRecordString(data, 'task_id');
  if (!taskId) {
    return;
  }

  const eventToolUseId = readRecordString(data, 'tool_use_id');

  if (subtype === 'task_started') {
    const startedDescription = readRecordString(data, 'description');
    const hasBackgroundCorrelation =
      data.is_backgrounded === undefined &&
      entry.activeBackgroundTaskIds?.has(taskId) === true;
    if (data.is_backgrounded !== true && !hasBackgroundCorrelation) {
      rememberForegroundTaskMetadata(entry, taskId, {
        ...(eventToolUseId ? { toolUseId: eventToolUseId } : {}),
        ...(startedDescription ? { description: startedDescription } : {}),
      });
      return;
    }
    entry.foregroundTaskMetadata.delete(taskId);
    rememberLiveBackgroundTask(entry, taskId, {
      ...(eventToolUseId ? { toolUseId: eventToolUseId } : {}),
      ...(startedDescription ? { description: startedDescription } : {}),
    });
    return;
  }

  if (subtype === 'task_updated') {
    const patch = isPlainRecord(data.patch) ? data.patch : undefined;
    if (!patch) return;
    if (isTerminalTaskUpdatePatchStatus(readRecordString(patch, 'status'))) {
      entry.liveBackgroundTasks.delete(taskId);
      entry.foregroundTaskMetadata.delete(taskId);
      return;
    }
    // A foreground task that outran its timeout is moved to the background.
    if (patch.is_backgrounded === true) {
      const patchDescription = readRecordString(patch, 'description');
      const foreground = entry.foregroundTaskMetadata.get(taskId);
      entry.foregroundTaskMetadata.delete(taskId);
      const toolUseId = eventToolUseId ?? foreground?.toolUseId;
      const description = patchDescription ?? foreground?.description;
      rememberLiveBackgroundTask(entry, taskId, {
        ...(toolUseId ? { toolUseId } : {}),
        ...(description ? { description } : {}),
      });
    }
    return;
  }

  if (
    subtype === 'task_notification' &&
    isTerminalTaskStatus(readRecordString(data, 'status'))
  ) {
    entry.liveBackgroundTasks.delete(taskId);
    entry.foregroundTaskMetadata.delete(taskId);
  }
}

const MAX_FOREGROUND_TASK_METADATA = 256;

function rememberForegroundTaskMetadata(
  entry: LiveBackgroundTaskOwner,
  taskId: string,
  task: LiveBackgroundTask,
): void {
  entry.foregroundTaskMetadata.delete(taskId);
  entry.foregroundTaskMetadata.set(taskId, task);
  while (entry.foregroundTaskMetadata.size > MAX_FOREGROUND_TASK_METADATA) {
    const oldestTaskId = entry.foregroundTaskMetadata.keys().next().value;
    if (typeof oldestTaskId !== 'string') break;
    entry.foregroundTaskMetadata.delete(oldestTaskId);
  }
}

function rememberLiveBackgroundTask(
  entry: LiveBackgroundTaskOwner,
  taskId: string,
  task: LiveBackgroundTask,
): void {
  const previous = entry.liveBackgroundTasks.get(taskId);
  const toolUseId = task.toolUseId ?? previous?.toolUseId;
  const description = task.description ?? previous?.description;
  entry.liveBackgroundTasks.set(taskId, {
    ...(toolUseId ? { toolUseId } : {}),
    ...(description ? { description } : {}),
  });
}

/**
 * Tell every still-live background task's consumers that the provider session
 * that owned them is gone. The CLI process dies with the session and
 * takes its background tasks with it, but the SDK emits no terminal bookend for
 * them, so without this the renderer, the transcript sidecar, and the portal
 * tracker keep showing them as running forever.
 */
function notifySessionEndedBackgroundTasks(
  key: string,
  entry: ActiveSession,
): void {
  if (entry.liveBackgroundTasks.size === 0) {
    return;
  }
  const tasks = Array.from(entry.liveBackgroundTasks.entries());
  // Cleared before delivery so a second teardown pass over the same entry
  // cannot emit a duplicate notification.
  entry.liveBackgroundTasks = new Map<string, LiveBackgroundTask>();

  let target: { projectId: string; worktreeId: string; chatId: string };
  try {
    target = parseSessionKey(key);
  } catch {
    return;
  }

  for (const [taskId, task] of tasks) {
    emitSessionEndedBackgroundTaskNotification(target, {
      taskId,
      ...(task.toolUseId ? { toolUseId: task.toolUseId } : {}),
      ...(task.description ? { description: task.description } : {}),
    });
  }
}

/**
 * A fresh provider CLI process is starting for this session. Any task
 * the previous process reported is gone with it, so flush whatever is left —
 * nothing is left once teardown has already notified — and start empty.
 *
 * Called by the provider at query start because that, not any event, is the real
 * process boundary: the Claude CLI emits a top-level `system`/`init` at the
 * start of every turn within one long-lived process.
 */
export function resetSessionLiveBackgroundTasks(key: string): void {
  const entry = sessions.get(key);
  if (!entry) {
    return;
  }
  notifySessionEndedBackgroundTasks(key, entry);
  entry.foregroundTaskMetadata.clear();
  entry.claudeNativeSubagentTasks.clear();
}

/**
 * Task ids the provider currently reports as live background work for one chat.
 * `undefined` means the chat has no live provider session at all, which the
 * renderer must distinguish from a live session with no background tasks.
 */
export function getSessionLiveBackgroundTaskIds(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string[] | undefined {
  const entry = sessions.get(sessionKey(projectId, worktreeId, chatId));
  if (!entry) return undefined;
  return Array.from(entry.liveBackgroundTasks.keys());
}

/**
 * Live background-task state for every chat with a provider session under the
 * given project/worktree. Chats without a session are absent from the result.
 */
export function getLiveBackgroundTaskSnapshot(
  projectId: string,
  worktreeId: string,
): Record<string, ActivityLiveBgTasksChatState> {
  const prefix = `${projectId}/${worktreeId}/`;
  const chats: Record<string, ActivityLiveBgTasksChatState> = {};

  for (const [key, entry] of Array.from(sessions.entries())) {
    if (!key.startsWith(prefix)) continue;
    const chatId = key.slice(prefix.length);
    // A session key is exactly three segments, so anything else is not a chat
    // under this worktree and must not answer for one.
    if (!chatId || chatId.includes('/')) continue;
    chats[chatId] = {
      sessionActive: true,
      liveTasks: Array.from(entry.liveBackgroundTasks, ([taskId, task]) => ({
        taskId,
        ...(task.toolUseId ? { toolUseId: task.toolUseId } : {}),
        ...(task.description ? { description: task.description } : {}),
      })),
    };
  }

  if (isE2eBuild()) {
    for (const [key, entry] of Array.from(
      e2eIngestedLiveBackgroundTasks.entries(),
    )) {
      if (!key.startsWith(prefix)) continue;
      const chatId = key.slice(prefix.length);
      if (!chatId || chatId.includes('/')) continue;
      // A real session always wins: it is the authority whenever one exists.
      if (chats[chatId]) continue;
      chats[chatId] = {
        sessionActive: true,
        liveTasks: Array.from(entry.liveBackgroundTasks, ([taskId, task]) => ({
          taskId,
          ...(task.toolUseId ? { toolUseId: task.toolUseId } : {}),
          ...(task.description ? { description: task.description } : {}),
        })),
      };
    }
  }

  return chats;
}

/**
 * Live background-task state for chats driven by the deterministic E2E
 * chat-event ingress rather than a real provider CLI process.
 *
 * UI automation has no provider session, so `sessions` is empty and every chat
 * it injects events into would read as "no live session" — which the renderer
 * correctly treats as proof that a rebuilt `running` card is stale. That makes
 * the *positive* branch of the liveness pass (a background process the session
 * still reports live must survive its turn completing) unreachable from a
 * spec. Injected `system` events are reduced here through the very same
 * {@link updateLiveBackgroundTaskState} rules main applies to provider events,
 * so a spec proves the real reducer rather than a test double.
 */
const e2eIngestedLiveBackgroundTasks = new Map<
  string,
  LiveBackgroundTaskOwner
>();

/**
 * Record one injected provider event against the E2E live background-task
 * replica. Build-time gated, so production builds drop it entirely.
 */
export function applyE2eIngestedLiveBackgroundTaskEvent(
  projectId: string,
  worktreeId: string,
  chatId: string,
  data: unknown,
): void {
  if (!isE2eBuild()) return;
  if (!isPlainRecord(data) || data.type !== 'system') return;

  const key = sessionKey(projectId, worktreeId, chatId);
  let owner = e2eIngestedLiveBackgroundTasks.get(key);
  if (!owner) {
    owner = {
      liveBackgroundTasks: new Map<string, LiveBackgroundTask>(),
      foregroundTaskMetadata: new Map<string, LiveBackgroundTask>(),
    };
    e2eIngestedLiveBackgroundTasks.set(key, owner);
  }
  updateLiveBackgroundTaskState(owner, data);
}

function updateBackgroundTaskState(
  entry: ActiveSession,
  data: unknown,
): boolean {
  if (!isPlainRecord(data)) {
    return false;
  }

  if (data.type === 'assistant') {
    rememberToolUseNames(entry, data);
    return false;
  }

  if (data.type !== 'system') {
    return false;
  }

  const subtype = readRecordString(data, 'subtype');
  if (subtype === 'background_tasks_changed') {
    if (!Array.isArray(data.tasks)) {
      return false;
    }
    const liveTaskIds = new Set<string>();
    for (const task of data.tasks) {
      if (!isPlainRecord(task)) return false;
      const liveTaskId = readRecordString(task, 'task_id');
      if (!liveTaskId) return false;
      liveTaskIds.add(liveTaskId);
    }

    // This session state intentionally tracks only finite background Bash
    // continuations selected by task_started/tool_use correlation. The level
    // signal includes persistent services too, so use it to remove missing
    // tracked tasks without adding unrelated task ids.
    let changed = false;
    for (const activeTaskId of Array.from(entry.activeBackgroundTaskIds)) {
      if (liveTaskIds.has(activeTaskId)) continue;
      entry.activeBackgroundTaskIds.delete(activeTaskId);
      changed = true;
    }
    return changed;
  }

  const taskId = readRecordString(data, 'task_id');
  if (!taskId) {
    return false;
  }

  if (subtype === 'task_started') {
    const toolUseId = readRecordString(data, 'tool_use_id');
    if (toolUseId && entry.continuationToolUseIds.has(toolUseId)) {
      const previousSize = entry.activeBackgroundTaskIds.size;
      entry.activeBackgroundTaskIds.add(taskId);
      return entry.activeBackgroundTaskIds.size !== previousSize;
    }
    return false;
  }

  if (
    subtype === 'task_notification' &&
    isTerminalTaskStatus(readRecordString(data, 'status'))
  ) {
    return entry.activeBackgroundTaskIds.delete(taskId);
  }

  return false;
}

function rememberToolUseNames(
  entry: ActiveSession,
  data: Record<string, unknown>,
): void {
  const message = isPlainRecord(data.message) ? data.message : null;
  const content = Array.isArray(message?.content) ? message.content : [];
  for (const block of content) {
    if (!isPlainRecord(block) || block.type !== 'tool_use') {
      continue;
    }

    const id = readRecordString(block, 'id');
    const name = readRecordString(block, 'name');
    if (id && name) {
      const input = isPlainRecord(block.input) ? block.input : undefined;
      if (isContinuationToolUse(name, input)) {
        entry.continuationToolUseIds.add(id);
      }
    }
  }
}

function isContinuationToolUse(
  name: string,
  input: Record<string, unknown> | undefined,
): boolean {
  if (name === 'Workflow') {
    return true;
  }
  // Windows Claude sessions expose `PowerShell` in place of `Bash`.
  return (
    (name === 'Bash' || name === 'PowerShell') && isFiniteBackgroundBash(input)
  );
}

function isFiniteBackgroundBash(
  input: Record<string, unknown> | undefined,
): boolean {
  if (!input || input.run_in_background !== true) {
    return false;
  }

  const command = readRecordString(input, 'command') ?? '';
  if (!command.trim()) {
    return false;
  }

  const description = readRecordString(input, 'description') ?? '';
  return !isPersistentBackgroundService(command, description);
}

function isPersistentBackgroundService(
  command: string,
  description: string,
): boolean {
  const lowerCommand = command.toLowerCase();
  const lowerDescription = description.toLowerCase();

  return (
    /\bdev server\b/.test(lowerDescription) ||
    /\bstart(?:ing)?\b[\s\S]{0,80}\b(server|service|gateway|app)\b/.test(
      lowerDescription,
    ) ||
    /\bnpm\s+(?:(?:run\s+)?start(?::dev)?|run\s+(?:dev|serve))\b/.test(
      lowerCommand,
    ) ||
    /\b(?:pnpm|yarn)\s+(?:run\s+)?(dev|serve|start)\b/.test(lowerCommand) ||
    /\b(?:next|vite|webpack-dev-server|electron-vite)\s+dev\b/.test(
      lowerCommand,
    )
  );
}

export function createSessionPhaseTimer(
  key: string,
  phase: string,
): () => void {
  const phaseStartedAt = Date.now();
  const timeoutId = setTimeout(() => {
    const entry = sessions.get(key);
    if (!entry) {
      return;
    }

    // eslint-disable-next-line no-console
    console.warn('[agent-session] Session startup phase still pending', {
      sessionKey: key,
      phase,
      providerType: entry.providerType,
      model: entry.model,
      turnActive: entry.turnActive,
      pendingMessageCount: entry.pendingMessageCount,
      lastEventType: entry.lastEventType,
      elapsedMs: Date.now() - phaseStartedAt,
    });
    recordSessionDiagnostic(key, entry, {
      kind: 'phase_slow',
      phase,
      elapsedMs: Date.now() - phaseStartedAt,
    });
  }, SLOW_SESSION_PHASE_MS);

  return (): void => {
    clearTimeout(timeoutId);
  };
}

/**
 * Remove a session from the active map. Called by providers when a session ends.
 */
export function unregisterSession(key: string): void {
  clearPresentationTurn(key);
  const entry = removeSessionEntry(key);
  if (!entry) return;
  void flushAndStopOutputPollingForSession(key).finally(() => {
    notifySessionEndedBackgroundTasks(key, entry);
  });
}

/**
 * Build a session key from components (exposed for providers).
 */
export function buildSessionKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return sessionKey(projectId, worktreeId, chatId);
}

/**
 * Check if a model change crosses provider boundaries.
 */
export function isProviderChangeAllowed(
  projectId: string,
  worktreeId: string,
  chatId: string,
  newModel: ChatModel,
  lockedHarness?: AgentSessionOptions['executionHarness'],
  requestedHarness?: AgentSessionOptions['executionHarness'],
): boolean {
  const newHarness = requestedHarness ?? getExecutionHarnessForModel(newModel);
  if (!newHarness) return false;

  // Reject if explicitly locked to a different execution harness.
  if (lockedHarness && lockedHarness !== newHarness) return false;

  // Active sessions can be recreated when the model source changes, but an
  // execution-harness change would invalidate provider conversation state.
  const entry = sessions.get(sessionKey(projectId, worktreeId, chatId));
  const activeHarness = entry?.executionHarness;
  if (activeHarness && activeHarness !== newHarness) return false;

  return true;
}
