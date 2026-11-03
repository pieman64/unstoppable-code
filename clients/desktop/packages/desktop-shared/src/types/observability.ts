import type { AgentProviderType } from '../types';
import type {
  AgentAuditHistoryRequest,
  AgentAuditHistoryResponse,
  AgentAuditTranscriptRequest,
  AgentAuditTranscriptResponse,
  AgentObservabilitySnapshot,
  AgentObservabilityUpdateEvent,
  UsageMetricsRequest,
  UsageMetricsResponse,
  UsageMetricsViewRequest,
  UsageMetricsViewResponse,
  UsageTabSummaryRequest,
  UsageTabSummaryResponse,
  UsageTimeseriesRequest,
  UsageTimeseriesResponse,
} from '@canopy/protocol/observability';

// The audit and usage record contracts live in `@canopy/protocol/observability`
// (CAN-4136); this module keeps the preload API and instrumentation types.
export * from '@canopy/protocol/observability';

export interface DesktopInstrumentationInitFailureDiagnosticRequest {
  surface: 'main' | 'app-advisor';
  reason: string;
}

export interface PostHogSessionState {
  sessionId: string;
  revision: number;
}

/** How this launch relates to the install, from the host's local state. */
export interface PostHogInstallLaunch {
  /** The analytics identity was created now and no earlier install data exists. */
  isFirstLaunch: boolean;
  /** The analytics identity was created now over existing install data. */
  isReinstall: boolean;
  /** Observed desktop acceptance on this install; absent for unknown metadata. */
  isInvitedInstall?: boolean;
}

/**
 * One renderer's frame and chat delivery numbers for one diagnostic window
 * (about 30 s), sent on `observability:record-renderer-summary` and recorded
 * on this device only as the `renderer_frame_summary` app diagnostic. Every
 * field is a count, a duration in milliseconds, or a flag: no chat, path,
 * source or other content.
 */
export interface RendererDiagnosticsSummary {
  /** Length of the window the summary covers. */
  windowMs: number;
  /** The renderer shows another computer (a remote access window). */
  remoteWindow: boolean;
  /** Long animation frames (`long-animation-frame` entries). */
  frames: {
    count: number;
    p95Ms: number;
    maxMs: number;
    /** Summed `blockingDuration`. */
    blockingMs: number;
    /** Script entries by invoker type; promise and script types are combined. */
    invokers: {
      userCallback: number;
      eventListener: number;
      promise: number;
      script: number;
    };
  };
  /**
   * `chat:state-changed`: changes attributed by their chat to on screen (the
   * window's focused or warm chats) or off screen; changes without a chat are
   * scope-level. Messages and apply time are bucketed by whether all of a
   * message's chat changes were on screen, all off screen, or mixed.
   */
  chatState: {
    onScreenChanges: number;
    offScreenChanges: number;
    scopeChanges: number;
    onScreenMessages: number;
    offScreenMessages: number;
    mixedMessages: number;
    onScreenApplyMs: number;
    offScreenApplyMs: number;
    mixedApplyMs: number;
  };
  /** Raw `chat:event`, by its chat; `canopy_delegation` events apart. */
  chatEvent: {
    onScreenEvents: number;
    offScreenEvents: number;
    delegationEvents: number;
    onScreenApplyMs: number;
    offScreenApplyMs: number;
    delegationApplyMs: number;
  };
  /** Terminal output, counted once per delivery at the terminal client. */
  terminal: {
    deliveries: number;
    applyMs: number;
  };
}

/**
 * What a remote access host forwarded to one controlling computer's session
 * in one diagnostic window (about 30 s), recorded on the host only as the
 * `remote_push_summary` app diagnostic. Counts and serialized bytes only: no
 * device, session, chat or path identity. Chat channels are split by the
 * interest that session's bridge window declared; with none declared, only
 * the totals are filled in.
 */
export interface RemotePushSummary {
  /** Length of the window the summary covers. */
  windowMs: number;
  /** The session's bridge window had a declared chat interest. */
  interestDeclared: boolean;
  /** Pushes on screen, off screen, or (state only) with changes of both. */
  chatState: {
    pushes: number;
    bytes: number;
    onScreenPushes: number;
    offScreenPushes: number;
    mixedPushes: number;
    onScreenBytes: number;
    offScreenBytes: number;
    mixedBytes: number;
  };
  chatEvent: {
    pushes: number;
    bytes: number;
    onScreenPushes: number;
    offScreenPushes: number;
    onScreenBytes: number;
    offScreenBytes: number;
  };
  terminal: { pushes: number; bytes: number };
  other: { pushes: number; bytes: number };
  /** Pushes the forwarder dropped as broadcast duplicates. */
  duplicateDrops: number;
}

export interface ObservabilityApi {
  loadSnapshot(): Promise<AgentObservabilitySnapshot>;
  loadHistory(
    request: AgentAuditHistoryRequest,
  ): Promise<AgentAuditHistoryResponse>;
  loadTranscript(
    request: AgentAuditTranscriptRequest,
  ): Promise<AgentAuditTranscriptResponse>;
  loadUsageTimeseries(
    request: UsageTimeseriesRequest,
  ): Promise<UsageTimeseriesResponse>;
  loadUsageMetrics(request: UsageMetricsRequest): Promise<UsageMetricsResponse>;
  loadUsageMetricsView(
    request: UsageMetricsViewRequest,
  ): Promise<UsageMetricsViewResponse>;
  loadUsageTabSummary(
    request: UsageTabSummaryRequest,
  ): Promise<UsageTabSummaryResponse>;
  refreshUsage(provider: AgentProviderType): Promise<void>;
  recordDesktopInstrumentationInitFailure(
    request: DesktopInstrumentationInitFailureDiagnosticRequest,
  ): Promise<void>;
  /** One-way: record this renderer's diagnostic summary on this device. */
  recordRendererSummary(summary: RendererDiagnosticsSummary): void;
  getAnonymousTelemetryId(): Promise<string>;
  getPostHogAnonymousId(): Promise<string>;
  /** Normalized domain only; null for signed-out, guest, or unavailable accounts. */
  getPostHogEmailDomain(): Promise<string | null>;
  onPostHogEmailDomainUpdate(cb: (domain: string | null) => void): () => void;
  getPostHogSession(): Promise<PostHogSessionState>;
  reportPostHogSessionRotation(
    proposal: PostHogSessionState,
  ): Promise<PostHogSessionState>;
  onPostHogSessionUpdate(cb: (state: PostHogSessionState) => void): () => void;
  onUpdate(cb: (event: AgentObservabilityUpdateEvent) => void): () => void;
}
