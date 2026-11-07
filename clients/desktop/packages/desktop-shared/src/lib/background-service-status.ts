import { z } from 'zod';

/**
 * Health of this computer's connection to its local background service (the
 * core daemon), owned by Electron main and pushed on
 * `background-service:status-changed` (CAN-5541). Codes only: no message,
 * path or authority id ever crosses to the renderer.
 */

/** Why the background service can't be reached. Additive. */
export const BACKGROUND_SERVICE_UNREACHABLE_REASONS = [
  'start_failed',
  'connect_timeout',
  'host_unavailable',
  'connection_lost',
  'reconnect_failed',
] as const;
export type BackgroundServiceUnreachableReason =
  (typeof BACKGROUND_SERVICE_UNREACHABLE_REASONS)[number];

/** Features that read through the background service. Additive. */
export const BACKGROUND_SERVICE_CONSUMERS = [
  'files_reads',
  // The daemon-backed W5 store's record-port lease (CAN-5542).
  'workspace_records',
  // Eligible local window terminals placed in the daemon (CAN-5088).
  'terminals',
  // Eligible local renderer code-graph builds and summary reads (CAN-5719).
  'code_graph',
  // Eligible local renderer script runs placed in the daemon (CAN-5087).
  'scripts',
] as const;
export type BackgroundServiceConsumer =
  (typeof BACKGROUND_SERVICE_CONSUMERS)[number];

export const BackgroundServiceStatusSchema = z.strictObject({
  /**
   * `unavailable`: a start, attach or reconnect failed; shown.
   * `reconnecting`: a live connection dropped and the daemon is restarting;
   * hidden until that restart fails (CAN-5541).
   */
  state: z.enum(['ok', 'reconnecting', 'unavailable']),
  /** Present only while `state` is `unavailable`. */
  reason: z.enum(BACKGROUND_SERVICE_UNREACHABLE_REASONS).optional(),
  /** The latest Try again: `failed` until the service is reached again. */
  retry: z.enum(['idle', 'running', 'failed']),
  /** Increases with every change; a lower one is stale. */
  sequence: z.number().int().nonnegative(),
});
export type BackgroundServiceStatus = z.infer<
  typeof BackgroundServiceStatusSchema
>;

export const INITIAL_BACKGROUND_SERVICE_STATUS: BackgroundServiceStatus =
  Object.freeze({ state: 'ok', retry: 'idle', sequence: 0 });

/** Preload surface: `window.api.backgroundService`. */
export interface BackgroundServiceApi {
  getStatus: () => Promise<BackgroundServiceStatus>;
  /** One bounded attach or start; resolves with the status after it. */
  retry: () => Promise<BackgroundServiceStatus>;
  /** Subscribe to status pushes. Returns an unsubscribe function. */
  onStatusChanged: (
    callback: (status: BackgroundServiceStatus) => void,
  ) => () => void;
}
