import { ipcMain, type IpcMainEvent } from 'electron';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  RENDERER_LONG_FRAME_CALLBACK_INVOKERS,
  RENDERER_LONG_FRAME_EVENT_INVOKERS,
  type RendererChatRowsBucket,
  type RendererDiagnosticsSummary,
  type RendererLongFrame,
  type RendererLongFrameInvoker,
  type RendererLongFrameScript,
} from '@canopy/desktop-shared/types/observability';
import type { DesktopExecutionObservabilityIngest } from '../observability/ingest';

const MAX_WINDOW_MS = 120_000;
const MAX_COUNT = 10_000_000;
const MAX_DURATION_MS = MAX_WINDOW_MS * 10;
const LONG_FRAME_INVOKER_TYPES = [
  'user-callback',
  'event-listener',
  'promise',
  'script',
] as const;
const LONG_FRAME_SOURCE_KINDS = [
  'none',
  'http',
  'blob',
  'data',
  'other',
] as const;

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

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isOneOfStrings<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return (
    typeof value === 'string' && values.some((candidate) => candidate === value)
  );
}

function isRendererChatRowsBucket(
  value: unknown,
): value is RendererChatRowsBucket {
  return (
    value === 0 ||
    value === 1_000 ||
    value === 5_000 ||
    value === 20_000 ||
    value === 50_000
  );
}

function validateRendererLongFrameScript(
  value: unknown,
): RendererLongFrameScript {
  const script = exactRecord(value, [
    'invokerType',
    'invoker',
    'sourceKind',
    'durationMs',
  ]);
  if (!isOneOfStrings(script.invokerType, LONG_FRAME_INVOKER_TYPES)) {
    throw new Error('Invalid renderer long-frame invoker type');
  }

  const invokerType = script.invokerType;
  let invoker: RendererLongFrameInvoker | null;
  if (script.invoker === null) {
    invoker = null;
  } else if (
    invokerType === 'user-callback' &&
    isOneOfStrings(script.invoker, RENDERER_LONG_FRAME_CALLBACK_INVOKERS)
  ) {
    invoker = script.invoker;
  } else if (
    invokerType === 'event-listener' &&
    isOneOfStrings(script.invoker, RENDERER_LONG_FRAME_EVENT_INVOKERS)
  ) {
    invoker = script.invoker;
  } else {
    throw new Error('Invalid renderer long-frame invoker');
  }
  if (!isOneOfStrings(script.sourceKind, LONG_FRAME_SOURCE_KINDS)) {
    throw new Error('Invalid renderer long-frame source kind');
  }

  return {
    invokerType,
    invoker,
    sourceKind: script.sourceKind,
    durationMs: boundedNumber(script.durationMs, MAX_WINDOW_MS),
  };
}

function validateRendererLongFrame(value: unknown): RendererLongFrame {
  const frame = exactRecord(value, [
    'durationMs',
    'blockingMs',
    'scriptMs',
    'renderMs',
    'layoutMs',
    'deliveries',
    'focusedChatRows',
    'scripts',
  ]);
  const deliveries = exactRecord(frame.deliveries, [
    'chatState',
    'chatEvent',
    'terminal',
    'deliveryMs',
  ]);
  const focusedChatRows = frame.focusedChatRows;
  if (focusedChatRows !== null && !isRendererChatRowsBucket(focusedChatRows)) {
    throw new Error('Invalid renderer long-frame focused chat rows');
  }
  if (!isUnknownArray(frame.scripts) || frame.scripts.length > 3) {
    throw new Error('Invalid renderer long-frame scripts');
  }

  const scripts: RendererLongFrameScript[] = [];
  for (const script of frame.scripts) {
    scripts.push(validateRendererLongFrameScript(script));
  }

  return {
    durationMs: boundedNumber(frame.durationMs, MAX_WINDOW_MS),
    blockingMs: boundedNumber(frame.blockingMs, MAX_WINDOW_MS),
    scriptMs: boundedNumber(frame.scriptMs, MAX_WINDOW_MS),
    renderMs: boundedNumber(frame.renderMs, MAX_WINDOW_MS),
    layoutMs: boundedNumber(frame.layoutMs, MAX_WINDOW_MS),
    deliveries: {
      chatState: boundedNumber(deliveries.chatState, MAX_COUNT, true),
      chatEvent: boundedNumber(deliveries.chatEvent, MAX_COUNT, true),
      terminal: boundedNumber(deliveries.terminal, MAX_COUNT, true),
      // Per frame, as the renderer bounds it: a freeze can land in a short
      // window, so the window's cap would drop the frame it should report.
      deliveryMs: boundedNumber(deliveries.deliveryMs, MAX_WINDOW_MS),
    },
    focusedChatRows,
    scripts,
  };
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
    'long',
  ]);
  if (!isUnknownArray(frames.long) || frames.long.length > 3) {
    throw new Error('Invalid renderer long frames');
  }
  const longFrames: RendererLongFrame[] = [];
  for (const frame of frames.long) {
    longFrames.push(validateRendererLongFrame(frame));
  }
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
      long: longFrames,
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

/**
 * Renderer diagnostics use a one-way send, not an invoke handler. They are
 * recorded through the portable observability ingest port, as other host
 * producers are, never the service class.
 */
export function registerRendererDiagnosticsHandler(
  recorder: Pick<DesktopExecutionObservabilityIngest, 'recordAppDiagnostic'>,
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
