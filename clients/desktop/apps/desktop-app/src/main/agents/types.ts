import type { MaterializedCapabilityOverlay } from '@canopy/desktop-shared/node/delegation/agent-artifacts';
import type { ManagedDelegationMode } from '@canopy/protocol/delegation/discovery';
import type { BrowserWindow } from 'electron';
import type {
  ChatInputAdmission,
  ChatInputWithdrawal,
  ChatSteeringCapabilities,
} from '@canopy/protocol/portal';
import type {
  AgentProviderType,
  AgentModelConfig,
  AiCreditsRoutingState,
  ApprovalMode,
  ApprovalRule,
  AssistantMode,
  ChatModel,
  ThinkingLevel,
  ModelHarness,
  ChatTabPluginSelections,
  ClaudeForkToolResult,
  CodexSpeed,
} from '@canopy/desktop-shared/types';
import type { AppAdvisorToolRuntime } from '../app-advisor/runtime';
import type { PipelineEditorToolRuntime } from '../pipeline-editor/runtime';
import type { PipelinePackageCapabilityOverlay } from '@canopy/desktop-shared/types/pipeline';

export interface AgentSessionOptions {
  cwd: string;
  /** Host composition identifies the eligible parent surface. */
  managedDelegationSurface?: 'worktree-chat';
  managedDelegationMode?: ManagedDelegationMode;
  managedDelegationMaxConcurrent?: number;
  managedDelegationMaxDepth?: number;
  selectedRepoId?: string;
  projectId: string;
  worktreeId: string;
  chatId: string;
  /**
   * Trusted background-run binding (`personal` / `org:<uuid>`). Interactive
   * sessions omit it and capture the live navigation context at creation.
   */
  executionContext?: string;
  planMode?: boolean;
  approvalMode?: ApprovalMode;
  sessionApprovalRules?: ApprovalRule[];
  codexProposalMode?: 'optional' | 'required';
  thinkingLevel?: ThinkingLevel;
  model?: ChatModel;
  selectedModel?: ChatModel;
  sdkSessionId?: string;
  codexReconstructionSeedId?: string;
  /** Fork the resumed Claude session instead of continuing it in place. */
  claudeForkSession?: boolean;
  /**
   * Chain uuid the forked resume must stop at (SDK `resumeSessionAt`). Only
   * applied together with `sdkSessionId` + `claudeForkSession`.
   */
  claudeForkResumeAt?: string;
  /** Start fresh and tag the init event so fork provenance discloses it. */
  claudeForkStartsFresh?: boolean;
  /**
   * Answers for tool calls left open at `claudeForkResumeAt`, sent as
   * `tool_result` blocks ahead of the fork's first prompt text.
   */
  claudeForkToolResults?: ClaudeForkToolResult[];
  pluginSelections?: ChatTabPluginSelections;
  packageOverlay?: PipelinePackageCapabilityOverlay;
  /** Host-private snapshot of this turn's successfully materialized home content. */
  inheritedCapabilityOverlay?: MaterializedCapabilityOverlay;
  /**
   * Opts this session into the global default-plugin overlay: plugin
   * resolution unions `PreferencesData.globalPluginSelections` (minus
   * workspace/chat tombstones read from persisted state) into the session's
   * selections. Set by worktree/cowork chat surfaces; helper surfaces
   * (App Advisor, pipeline editor, one-shot helpers) leave it unset so their
   * explicit selections stay authoritative.
   */
  applyGlobalPluginDefaults?: boolean;
  deferredToolsAllowed?: boolean;
  systemPromptAppend?: string;
  /**
   * Opaque Global Instructions plus opted-in repository instructions, captured
   * only for a new provider session. Excluded from logical-session matching so
   * preference and repository edits do not replace a running conversation.
   */
  globalInstructionsBlock?: string;
  /**
   * Opaque inline instruction text and rule index captured at session creation.
   * Resumes reuse this value; files read through index entries or @file
   * references remain live rather than becoming historical file snapshots.
   */
  globalInstructionsSnapshot?: string;
  providerType?: AgentProviderType;
  executionHarness?: ModelHarness;
  codexAppServerIdleTimeoutMinutes?: number;
  codexMultiAgentEnabled?: boolean;
  codexMaxConcurrentSubagents?: number | null;
  modelConfig?: AgentModelConfig;
  /** @deprecated Use modelConfig.speed. Legacy alias read after modelConfig. */
  codexFastModeEnabled?: boolean;
  rtkEnabled?: boolean;
  assistantMode?: AssistantMode;
  toolProfileHash?: string;
  /** Code Graph tool advertisement captured for this logical chat session. */
  codeGraphToolsAdvertised?: boolean;
  appAdvisorRuntime?: AppAdvisorToolRuntime;
  pipelineEditorRuntime?: PipelineEditorToolRuntime;
  /**
   * Per-session AI Credits fallback routing decision (CAN-838). When
   * `active`, the provider session injects gateway proxy env at spawn and
   * routes through the caller's AI Credits instead of native provider auth.
   */
  aiCreditsRouting?: AiCreditsRoutingState;
  /**
   * Per-chat billing-framework override forcing the user's native
   * Claude/Codex subscription for this session, even when a global AI Credits
   * routing mode (`on` / `on-quota`) is active. Consulted by the AI Credits
   * routing resolver — it beats the global mode but not an active
   * `aiCreditsRouting`, and only applies when the user is natively
   * authenticated for the provider.
   */
  subscriptionBillingOverride?: boolean;
  /**
   * Whether the account proxy takes this session (CAN-4020), decided once by
   * the session manager when it creates the session so the registry and the
   * session agree on how it is billed. `'off'` keeps the session off the
   * proxy; absent lets the session decide for itself.
   */
  accountProxyRouting?: 'proxy' | 'off';
  /** Trusted quota continuation: refuse any other billing connection. */
  requiredAccountProxyConnectionId?: string;
}

export interface AgentSessionSendOptions {
  /** Explicit selection plus the canonical host-owned attachment directory. */
  attachments?: { baseDir: string; paths: readonly string[] };
  /** Explicit user-authored sends only; continuations/automation default to false. */
  countsTowardSkillUsage?: boolean;
  userMessageId?: string;
}

export interface AgentSession {
  sendMessage(text: string, options?: AgentSessionSendOptions): void;
  getSteeringCapabilities?(): ChatSteeringCapabilities;
  getSteeringWorkingDirectory?(): string;
  submitSteeringInput?(
    text: string,
    attemptId: string,
    userMessageId: string,
  ): Promise<ChatInputAdmission>;
  withdrawSteeringInput?(attemptId: string): Promise<ChatInputWithdrawal>;
  /** Settles the old result before returning; preserves the reusable query. */
  interruptWithPendingSweep?(): Promise<void>;
  hasPendingSteeringInput?(): boolean;
  /**
   * Whether the session has been torn down: destroyed, or — for providers
   * whose cancellation permanently ends the underlying provider stream —
   * canceled. `sendMessage` on a disposed session still enqueues into the
   * in-memory queue, but nothing will ever drain that queue to the provider,
   * so callers that need delivery honesty (e.g. the org-memory delivered
   * ack) must consult this after enqueueing. Absent means the implementation
   * cannot report liveness and callers should assume the session is live.
   */
  isDisposed?(): boolean;
  /**
   * Return the provider-owned persisted session/thread id once one exists.
   * This is intentionally a read-only handoff for lifecycle transitions; it
   * is not part of process or pool identity.
   */
  getProviderSessionId?(): string | undefined;
  /** True when this live session owns a proxy route for the exact MCP config. */
  usesMcpServerConfig?(
    serverId: string,
    configId: string,
  ): { displayName: string } | undefined;
  /** Queue app-server MCP refresh for this session's worker/profile. */
  reloadMcpServers?(): Promise<void>;
  /** Apply current-turn guidance when an enabled delegation policy changes. */
  setManagedDelegationMode?(mode: ManagedDelegationMode | undefined): void;
  /** Steer the currently active Codex root turn, if one is steerable. */
  steerActiveTurn?(
    text: string,
    clientUserMessageId?: string,
  ): Promise<boolean>;
  cancel(): Promise<void>;
  destroy(): Promise<void>;
  setPlanMode(enabled: boolean): Promise<void>;
  setApprovalMode(mode: ApprovalMode): Promise<void>;
  /**
   * Apply the exact requested Codex speed to the next turn. Callers go through
   * `applyAgentSessionCodexSpeed`, which prefers this setter; the boolean
   * setters below are a Regular/Fast-only fallback and Ultra fast is rejected
   * when this setter is absent.
   */
  setSpeed?(speed: CodexSpeed): Promise<void>;
  /** @deprecated Use setSpeed. Regular/Fast-only compatibility adapter. */
  setFastMode?(enabled: boolean): Promise<void>;
  /** @deprecated Use setSpeed. */
  setCodexFastMode?(enabled: boolean): Promise<void>;
  setCodexProposalMode?(mode: 'optional' | 'required'): Promise<void>;
  setCodexAppServerIdleTimeoutMinutes?(minutes: number): Promise<void>;
  setRtkEnabled?(enabled: boolean): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  setModel(model: ChatModel): Promise<void>;
}

export interface AgentProvider {
  createSession(
    opts: AgentSessionOptions,
    onEvent: (data: unknown) => void | Promise<void>,
    getWindow: () => BrowserWindow | null,
  ): AgentSession;
}
