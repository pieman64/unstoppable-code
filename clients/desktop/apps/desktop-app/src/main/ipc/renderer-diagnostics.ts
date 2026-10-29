import { ipcMain, type IpcMainEvent } from 'electron';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { RendererDiagnosticsSummary } from '@canopy/desktop-shared/types/observability';
import type { ObservabilityService } from '../observability/service';

const MAX_WINDOW_MS = 120_000;
const MAX_COUNT = 10_000_000;
const MAX_DURATION_MS = MAX_WINDOW_MS * 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('Invalid renderer diagnostics summary');
  }
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  ) {
    throw new Error('Invalid renderer diagnostics summary fields');
  }
  return value;
}

function boundedNumber(value: unknown, max: number, integer = false): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    throw new Error('Invalid renderer diagnostics summary number');
  }
  return value;
}

/** Validate every property before an untrusted one-way IPC payload reaches disk. */
export function validateRendererDiagnosticsSummary(
  value: unknown,
): RendererDiagnosticsSummary {
  const summary = exactRecord(value, [
    'windowMs',
    'remoteWindow',
    'frames',
    'chatState',
    'chatEvent',
    'terminal',
  ]);
  const windowMs = boundedNumber(summary.windowMs, MAX_WINDOW_MS);
  if (windowMs === 0 || typeof summary.remoteWindow !== 'boolean') {
    throw new Error('Invalid renderer diagnostics summary window');
  }
  const durationCap = Math.min(MAX_DURATION_MS, windowMs * 10);
  const frames = exactRecord(summary.frames, [
    'count',
    'p95Ms',
    'maxMs',
    'blockingMs',
    'invokers',
  ]);
  const invokers = exactRecord(frames.invokers, [
    'userCallback',
    'eventListener',
    'promise',
    'script',
  ]);
  const chatState = exactRecord(summary.chatState, [
    'onScreenChanges',
    'offScreenChanges',
    'scopeChanges',
    'onScreenMessages',
    'offScreenMessages',
    'mixedMessages',
    'onScreenApplyMs',
    'offScreenApplyMs',
    'mixedApplyMs',
  ]);
  const chatEvent = exactRecord(summary.chatEvent, [
    'onScreenEvents',
    'offScreenEvents',
    'delegationEvents',
    'onScreenApplyMs',
    'offScreenApplyMs',
    'delegationApplyMs',
  ]);
  const terminal = exactRecord(summary.terminal, ['deliveries', 'applyMs']);

  return {
    windowMs,
    remoteWindow: summary.remoteWindow,
    frames: {
      count: boundedNumber(frames.count, MAX_COUNT, true),
      p95Ms: boundedNumber(frames.p95Ms, MAX_WINDOW_MS),
      maxMs: boundedNumber(frames.maxMs, MAX_WINDOW_MS),
      blockingMs: boundedNumber(frames.blockingMs, durationCap),
      invokers: {
        userCallback: boundedNumber(invokers.userCallback, MAX_COUNT, true),
        eventListener: boundedNumber(invokers.eventListener, MAX_COUNT, true),
        promise: boundedNumber(invokers.promise, MAX_COUNT, true),
        script: boundedNumber(invokers.script, MAX_COUNT, true),
      },
    },
    chatState: {
      onScreenChanges: boundedNumber(
        chatState.onScreenChanges,
        MAX_COUNT,
        true,
      ),
      offScreenChanges: boundedNumber(
        chatState.offScreenChanges,
        MAX_COUNT,
        true,
      ),
      scopeChanges: boundedNumber(chatState.scopeChanges, MAX_COUNT, true),
      onScreenMessages: boundedNumber(
        chatState.onScreenMessages,
        MAX_COUNT,
        true,
      ),
      offScreenMessages: boundedNumber(
        chatState.offScreenMessages,
        MAX_COUNT,
        true,
      ),
      mixedMessages: boundedNumber(chatState.mixedMessages, MAX_COUNT, true),
      onScreenApplyMs: boundedNumber(chatState.onScreenApplyMs, durationCap),
      offScreenApplyMs: boundedNumber(chatState.offScreenApplyMs, durationCap),
      mixedApplyMs: boundedNumber(chatState.mixedApplyMs, durationCap),
    },
    chatEvent: {
      onScreenEvents: boundedNumber(chatEvent.onScreenEvents, MAX_COUNT, true),
      offScreenEvents: boundedNumber(
        chatEvent.offScreenEvents,
        MAX_COUNT,
        true,
      ),
      delegationEvents: boundedNumber(
        chatEvent.delegationEvents,
        MAX_COUNT,
        true,
      ),
      onScreenApplyMs: boundedNumber(chatEvent.onScreenApplyMs, durationCap),
      offScreenApplyMs: boundedNumber(chatEvent.offScreenApplyMs, durationCap),
      delegationApplyMs: boundedNumber(
        chatEvent.delegationApplyMs,
        durationCap,
      ),
    },
    terminal: {
      deliveries: boundedNumber(terminal.deliveries, MAX_COUNT, true),
      applyMs: boundedNumber(terminal.applyMs, durationCap),
    },
  };
}

/** Renderer diagnostics use a one-way send, not an invoke handler. */
export function registerRendererDiagnosticsHandler(
  recorder: Pick<ObservabilityService, 'recordAppDiagnostic'>,
): () => void {
  const listener = (_event: IpcMainEvent, value: unknown): void => {
    let rendererSummary: RendererDiagnosticsSummary;
    try {
      rendererSummary = validateRendererDiagnosticsSummary(value);
    } catch {
      // Invalid/untrusted payloads are dropped silently to avoid log loops.
      return;
    }
    recorder.recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'renderer_frame_summary',
      rendererSummary,
    });
  };
  ipcMain.on(IPC_CHANNELS.observabilityRecordRendererSummary, listener);
  return (): void => {
    ipcMain.removeListener(
      IPC_CHANNELS.observabilityRecordRendererSummary,
      listener,
    );
  };
}
