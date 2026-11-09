import type {
  PostHog,
  RemoteConfig,
} from 'posthog-js/dist/module.full.no-external';
import {
  resolvePostHogRuntimePolicy,
  type PostHogInstrumentationConfig,
} from '../config';
import type { PostHogRuntimeFlags } from '../types';
import {
  buildPostHogSessionRecordingOptions,
  type PostHogSessionRecordingOptions,
} from './posthog-replay-options';
import { POSTHOG_MAIN_ROUTE } from '../posthog-routes';
import {
  POSTHOG_AUTOCAPTURE_OPTIONS,
  POSTHOG_CLICK_EVENTS,
  POSTHOG_COPY_EVENT,
  POSTHOG_DEAD_CLICK_OPTIONS,
} from './posthog-autocapture-options';
import { POSTHOG_HEATMAP_EVENT } from './posthog-heatmaps';
import {
  APP_ERROR_POSTHOG_EVENT,
  APP_ERROR_VIEW_POSTHOG_EVENT,
} from '../app-error-telemetry';

/** Events that follow Error reports rather than Usage analytics. */
const POSTHOG_ERROR_EVENTS: ReadonlySet<string> = new Set([
  '$exception',
  APP_ERROR_POSTHOG_EVENT,
  APP_ERROR_VIEW_POSTHOG_EVENT,
]);

export function isPostHogErrorEvent(name: string): boolean {
  return POSTHOG_ERROR_EVENTS.has(name);
}

export function createPostHogRuntimeController(
  sdk: PostHog,
  config: PostHogInstrumentationConfig,
  initialFlags: PostHogRuntimeFlags | undefined,
  pinnedOptions: PostHogSessionRecordingOptions = buildPostHogSessionRecordingOptions(
    () => POSTHOG_MAIN_ROUTE,
  ),
  onAdopted?: (listener: (sessionId: string) => void) => () => void,
): {
  update: (flags?: PostHogRuntimeFlags) => void;
  allowsEvent: (eventName: string) => boolean;
  dispose: () => void;
} {
  let policy = resolvePostHogRuntimePolicy(config, initialFlags);
  let captureEnabled = false;
  let errorCaptureEnabled = false;
  let epoch = 0;
  let draining = false;
  let sessionId = '';
  let sessionRate = policy.sessionReplaySampleRate;
  let autocaptureEnabled = false;
  const requestEpochs = new WeakMap<object, number>();

  // posthog-js 1.434.8 checks consent at capture(), but not when a queued
  // batch/retry is dispatched. These typed SDK seams cover batch flush,
  // retries (including responses arriving after opt-out), and unload beacons.
  // Keep the real-SDK Electron test when upgrading the pinned dependency.
  // Batches can't be split by category, so the transport only blocks when
  // both categories are off; `allowsEvent` filters at capture time and any
  // narrowing bumps the epoch so earlier batches are dropped.
  const allowsRequest = (request: { data?: unknown }): boolean => {
    if (draining || (!captureEnabled && !errorCaptureEnabled)) return false;
    const data = request.data;
    if (data !== null && typeof data === 'object') {
      const requestEpoch = requestEpochs.get(data);
      if (requestEpoch !== undefined && requestEpoch !== epoch) return false;
      requestEpochs.set(data, epoch);
    }
    return true;
  };
  // Preserve exact method identity so disposal can undo this SDK patch.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const send = sdk._send_request;
  const guardedSend: typeof sdk._send_request = (request): void => {
    if (allowsRequest(request)) send.call(sdk, request);
  };
  sdk._send_request = guardedSend;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const sendRetriable = sdk._send_retriable_request;
  const guardedSendRetriable: typeof sdk._send_retriable_request = (
    request,
    transport,
  ): void => {
    if (allowsRequest(request)) sendRetriable.call(sdk, request, transport);
  };
  sdk._send_retriable_request = guardedSendRetriable;
  const retryQueue = sdk._retryQueue;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const retry = retryQueue?.retriableRequest;
  const guardedRetry: typeof retry = retry
    ? (request, transport): void => {
        if (allowsRequest(request)) retry.call(retryQueue, request, transport);
      }
    : undefined;
  if (retryQueue && guardedRetry) {
    retryQueue.retriableRequest = guardedRetry;
  }

  const restoreTransports = (): void => {
    if (sdk._send_request === guardedSend) sdk._send_request = send;
    if (sdk._send_retriable_request === guardedSendRetriable) {
      sdk._send_retriable_request = sendRetriable;
    }
    if (retryQueue && retry && retryQueue.retriableRequest === guardedRetry) {
      retryQueue.retriableRequest = retry;
    }
  };

  // The SDK re-reads autocapture options on every click and starts or stops
  // dead-click observation and heatmap listeners on each set_config. Turning
  // heatmaps off discards their unsent buffer.
  const publishConfig = (): void => {
    sdk.set_config({
      session_recording: { ...pinnedOptions, sampleRate: sessionRate / 100 },
      autocapture: autocaptureEnabled ? POSTHOG_AUTOCAPTURE_OPTIONS : false,
      capture_dead_clicks: autocaptureEnabled
        ? POSTHOG_DEAD_CLICK_OPTIONS
        : false,
      capture_heatmaps: autocaptureEnabled,
    });
  };

  // Only the recorder receives this response. Other SDK products/config
  // are unaffected.
  const sendRecorderRemoteConfig = (
    sessionRecording: RemoteConfig['sessionRecording'],
  ): void => {
    sdk.sessionRecording?.onRemoteConfig({
      ok: true,
      config: {
        sessionRecording,
        supportedCompression: [],
        toolbarParams: {},
        toolbarVersion: 'toolbar',
        isAuthenticated: false,
        siteApps: [],
      },
    });
  };

  const supplyReplayConfig = (): void => {
    sendRecorderRemoteConfig({ endpoint: '/s/' });
  };

  const startReplay = (): void => {
    // The SDK persists this response, then samples the persisted local rate.
    supplyReplayConfig();
    sdk.startSessionRecording();
  };

  const keepReplayCurrent = (): void => {
    if (!captureEnabled || sessionRate === 0) return;
    if (sdk.sessionRecordingStarted()) supplyReplayConfig();
    else startReplay();
  };

  const handleNewSession = (id: string): void => {
    if (id === sessionId) return;
    sessionId = id;
    sessionRate = policy.sessionReplaySampleRate;
    publishConfig();
    keepReplayCurrent();
  };
  // Register before startReplay installs the recorder's own rotation listener.
  const unsubscribeSession = sdk.onSessionId(handleNewSession);
  const unsubscribeAdopted = onAdopted?.(handleNewSession);

  const stopReplay = (): void => {
    // Unlike stop(), this discards pending compression work.
    sendRecorderRemoteConfig(false);
    sdk.stopSessionRecording();
  };

  const update = (flags?: PostHogRuntimeFlags): void => {
    const next = resolvePostHogRuntimePolicy(config, flags);
    // Replay turning off drops the recordings already queued, like a category.
    // The drain can't split batches, so it also drops queued product and
    // error events: deliberate, and safe in the direction that matters.
    const replayNarrowed =
      captureEnabled && sessionRate > 0 && next.sessionReplaySampleRate === 0;
    // Publish lower caps immediately; the SDK retains its sampling decision
    // until the next session. Zero additionally stops an active recording.
    // Higher caps wait for the next session.
    sessionRate = Math.min(sessionRate, next.sessionReplaySampleRate);
    policy = next;
    autocaptureEnabled = next.autocaptureEnabled;
    const wasSending = captureEnabled || errorCaptureEnabled;
    const narrowed =
      replayNarrowed ||
      (captureEnabled && !next.captureEnabled) ||
      (errorCaptureEnabled && !next.errorCaptureEnabled);
    captureEnabled = next.captureEnabled;
    errorCaptureEnabled = next.errorCaptureEnabled;
    publishConfig();
    if (narrowed) {
      // Queued batches can't be split by category: drop both kinds.
      epoch++;
      if (!captureEnabled) stopReplay();
      // unload empties the queues by beaconing them synchronously, building
      // fresh batch objects the epoch check has never seen; refuse every
      // dispatch while it runs so the guards above discard them.
      draining = true;
      try {
        sdk._requestQueue?.unload();
        sdk._retryQueue?.unload();
      } finally {
        draining = false;
      }
    }
    if (!captureEnabled && !errorCaptureEnabled) {
      sdk.opt_out_capturing();
      stopReplay();
    } else if (!wasSending) {
      sdk.opt_in_capturing({ captureEventName: false });
      sdk._retryQueue?.resume();
    }
    if (captureEnabled && sessionRate === 0) {
      stopReplay();
    } else {
      keepReplayCurrent();
    }
  };
  update(initialFlags);
  let disposed = false;
  return {
    update,
    allowsEvent: (name) =>
      POSTHOG_ERROR_EVENTS.has(name)
        ? errorCaptureEnabled
        : captureEnabled &&
          name !== POSTHOG_COPY_EVENT &&
          (name !== '$snapshot' || sessionRate > 0) &&
          ((!POSTHOG_CLICK_EVENTS.has(name) &&
            name !== POSTHOG_HEATMAP_EVENT) ||
            autocaptureEnabled),
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      update();
      unsubscribeSession();
      unsubscribeAdopted?.();
      restoreTransports();
    },
  };
}
