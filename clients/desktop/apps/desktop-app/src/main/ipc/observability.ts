import type { BrowserWindow } from 'electron';
import {
  adoptDesktopPostHogSession,
  getDesktopPostHogSession,
  getDesktopPostHogEmailDomain,
} from '@canopy/desktop-instrumentation/electron/main';
import type { PostHogSessionState } from '@canopy/desktop-shared/types/observability';
import {
  IPC_CHANNELS,
  SINGLE_REPO_USAGE_REPO_ID,
  type AgentAuditHistoryRequest,
  type AgentAuditHistoryResponse,
  type AgentObservabilitySnapshot,
  type AgentAuditTranscriptRequest,
  type AgentAuditTranscriptResponse,
  type AgentProviderType,
  type DesktopInstrumentationInitFailureDiagnosticRequest,
  type UsageMetricsRequest,
  type UsageMetricsResponse,
  type UsageMetricsViewRequest,
  type UsageMetricsViewResponse,
  type UsageTabSummaryRequest,
  type UsageTabSummaryResponse,
  type UsageTimeseriesRequest,
  type UsageTimeseriesResponse,
} from '@canopy/desktop-shared/types';
import { getObservabilityService } from '../observability';
import {
  getStableAnonymousKey,
  getStablePostHogAnonymousKey,
} from '../lib/anonymous-id';
import { isUsageInitiationSource } from '@canopy/desktop-shared/lib/turn-utils';
import { validateId, validateOptionalRepoId } from '../lib/validation';
import { sendToAllWindows, sendToWindow } from '../lib/window-send';
import { registerIpcHandler } from './register';
import { registerRendererDiagnosticsHandler } from './renderer-diagnostics';

function validateHistoryRequestIds(request: AgentAuditHistoryRequest): void {
  if (request.projectId) {
    validateId(request.projectId, 'projectId');
  }

  if (request.worktreeId) {
    validateId(request.worktreeId, 'worktreeId');
  }

  if (request.pipelineExecutionId) {
    validateId(request.pipelineExecutionId, 'pipelineExecutionId');
  }
}

function parseUsageTimeseriesDate(value: unknown, label: string): number {
  if (typeof value !== 'string') {
    throw new Error('startDate and endDate must be ISO 8601 strings');
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} must be a valid ISO 8601 timestamp`);
  }

  return timestamp;
}

function validateUsageMetricProvider(provider: unknown): void {
  if (
    provider === undefined ||
    provider === 'all' ||
    provider === 'claude' ||
    provider === 'codex' ||
    provider === 'ollama' ||
    provider === 'cursor' ||
    provider === 'pipeline'
  ) {
    return;
  }
  throw new Error(
    `Invalid provider: ${typeof provider === 'string' ? provider : 'unknown'}`,
  );
}

function validateUsageMetricInitiationSource(source: unknown): void {
  if (
    source === undefined ||
    source === 'all' ||
    isUsageInitiationSource(source)
  ) {
    return;
  }
  throw new Error(
    `Invalid initiationSource: ${typeof source === 'string' ? source : 'unknown'}`,
  );
}

function validateUsageTabId(tab: unknown): void {
  if (
    tab === 'tokens' ||
    tab === 'cost' ||
    tab === 'worktrees' ||
    tab === 'chats' ||
    tab === 'plans' ||
    tab === 'tools' ||
    tab === 'pipelines'
  ) {
    return;
  }
  throw new Error(`Invalid tab: ${typeof tab === 'string' ? tab : 'unknown'}`);
}

function validateDesktopInstrumentationInitFailureRequest(
  request: DesktopInstrumentationInitFailureDiagnosticRequest,
): void {
  if (request.surface !== 'main' && request.surface !== 'app-advisor') {
    throw new Error(
      `Invalid surface: ${typeof request.surface === 'string' ? request.surface : 'unknown'}`,
    );
  }
  if (typeof request.reason !== 'string' || request.reason.trim() === '') {
    throw new Error('reason must be a non-empty string');
  }
}

export function registerObservabilityHandlers(
  getWindow: () => BrowserWindow | null,
): void {
  const service = getObservabilityService();
  registerRendererDiagnosticsHandler(service);

  service.subscribe((event) => {
    sendToWindow(getWindow(), IPC_CHANNELS.observabilityEvent, event);
  });

  registerIpcHandler(
    IPC_CHANNELS.observabilityLoadSnapshot,
    (): Promise<AgentObservabilitySnapshot> =>
      Promise.resolve(service.loadSnapshot()),
  );

  registerIpcHandler(
    IPC_CHANNELS.observabilityLoadHistory,
    (
      _event,
      request: AgentAuditHistoryRequest,
    ): Promise<AgentAuditHistoryResponse> => {
      validateHistoryRequestIds(request);
      return service.loadHistory(request);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.observabilityLoadUsageTimeseries,
    (
      _event,
      request: UsageTimeseriesRequest,
    ): Promise<UsageTimeseriesResponse> => {
      const startTime = parseUsageTimeseriesDate(
        request?.startDate,
        'startDate',
      );
      const endTime = parseUsageTimeseriesDate(request?.endDate, 'endDate');
      if (startTime >= endTime) {
        return Promise.reject(new Error('startDate must be before endDate'));
      }
      if (
        request.bucket !== 'hour' &&
        request.bucket !== 'day' &&
        request.bucket !== 'week'
      ) {
        return Promise.reject(
          new Error(`Invalid bucket: ${String(request.bucket)}`),
        );
      }
      return service.loadUsageTimeseries(request);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.observabilityLoadUsageMetrics,
    (_event, request: UsageMetricsRequest): Promise<UsageMetricsResponse> => {
      const startTime = parseUsageTimeseriesDate(
        request?.startDate,
        'startDate',
      );
      const endTime = parseUsageTimeseriesDate(request?.endDate, 'endDate');
      if (startTime >= endTime) {
        return Promise.reject(new Error('startDate must be before endDate'));
      }
      if (request.workspaceId) {
        validateId(request.workspaceId, 'workspaceId');
      }
      if (request.repoId) {
        if (request.repoId !== SINGLE_REPO_USAGE_REPO_ID) {
          validateOptionalRepoId(request.repoId, 'repoId');
        }
      }
      validateUsageMetricProvider(request.provider);
      validateUsageMetricInitiationSource(request.initiationSource);
      return service.loadUsageMetrics(request);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.observabilityLoadUsageMetricsView,
    (
      _event,
      request: UsageMetricsViewRequest,
    ): Promise<UsageMetricsViewResponse> => {
      validateUsageTabId(request?.tab);
      if (typeof request.metric !== 'string') {
        return Promise.reject(new Error('metric must be a string'));
      }
      if (typeof request.groupBy !== 'string') {
        return Promise.reject(new Error('groupBy must be a string'));
      }
      const window = request.window;
      if (
        !window ||
        (window.kind !== 'last7d' &&
          window.kind !== 'prior7d' &&
          window.kind !== 'allTime' &&
          window.kind !== 'custom')
      ) {
        return Promise.reject(new Error('window has unknown kind'));
      }
      if (window.kind === 'custom') {
        parseUsageTimeseriesDate(window.start, 'window.start');
        parseUsageTimeseriesDate(window.end, 'window.end');
      }
      return service.loadUsageMetricsView(request);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.observabilityLoadUsageTabSummary,
    (
      _event,
      request: UsageTabSummaryRequest,
    ): Promise<UsageTabSummaryResponse> => {
      validateUsageTabId(request?.tab);
      return service.loadUsageTabSummary(request);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.observabilityLoadTranscript,
    (
      _event,
      request: AgentAuditTranscriptRequest,
    ): Promise<AgentAuditTranscriptResponse> => {
      const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T[\d:.Z+-]+$/;
      if (
        typeof request.startedAt !== 'string' ||
        !ISO_DATE_RE.test(request.startedAt) ||
        typeof request.id !== 'string' ||
        request.id.length === 0
      ) {
        const result: AgentAuditTranscriptResponse = { type: 'not_available' };
        return Promise.resolve(result);
      }
      return service.loadTranscript(request);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.observabilityRefreshUsage,
    (_event, provider: AgentProviderType): Promise<void> => {
      if (
        provider !== 'claude' &&
        provider !== 'codex' &&
        provider !== 'cursor' &&
        provider !== 'copilot' &&
        provider !== 'opencode'
      ) {
        return Promise.reject(
          new Error(`Invalid provider: ${String(provider)}`),
        );
      }
      return service.refreshProviderUsage(provider);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.observabilityRecordDesktopInstrumentationInitFailure,
    (
      _event,
      request: DesktopInstrumentationInitFailureDiagnosticRequest,
    ): void => {
      validateDesktopInstrumentationInitFailureRequest(request);
      service.recordAppDiagnostic({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: 'desktop_instrumentation_init_failed',
        reason: request.reason,
        rendererSurface:
          request.surface === 'app-advisor'
            ? 'app_advisor_window'
            : 'main_window',
      });
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.observabilityGetPostHogAnonymousId,
    (): Promise<string> => getStablePostHogAnonymousKey(),
  );

  registerIpcHandler(IPC_CHANNELS.observabilityGetPostHogSession, () =>
    getDesktopPostHogSession(),
  );
  registerIpcHandler(IPC_CHANNELS.observabilityGetPostHogEmailDomain, () =>
    getDesktopPostHogEmailDomain(),
  );
  registerIpcHandler(
    IPC_CHANNELS.observabilityReportPostHogSessionRotation,
    (_event, proposal: PostHogSessionState) => {
      const previous = getDesktopPostHogSession();
      const current = adoptDesktopPostHogSession(proposal);
      if (current.revision !== previous.revision) {
        sendToAllWindows(
          IPC_CHANNELS.observabilityPostHogSessionUpdate,
          current,
        );
      }
      return current;
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.observabilityGetAnonymousTelemetryId,
    (): Promise<string> => getStableAnonymousKey(),
  );
}
