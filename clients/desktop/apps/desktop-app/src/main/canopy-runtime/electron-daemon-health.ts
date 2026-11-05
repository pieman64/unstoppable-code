import {
  INITIAL_BACKGROUND_SERVICE_STATUS,
  type BackgroundServiceConsumer,
  type BackgroundServiceStatus,
  type BackgroundServiceUnreachableReason,
} from '@canopy/desktop-shared/lib/background-service-status';
import {
  logMainProcessInfo,
  logMainProcessWarn,
} from '../lib/main-process-logging';
import type { ElectronDaemonReachability } from './electron-daemon-connection';

/**
 * Main's one record of whether the local background service can be reached
 * (CAN-5541), fed by the Electron daemon connection service and shared by
 * every consumer that reads through it. An interface-host adapter: no core
 * operation reports that the core itself can't be reached.
 */
export interface ElectronDaemonHealth {
  getStatus(): BackgroundServiceStatus;
  /** Completed outage/reconnect cycles; startup maintenance can re-arm lazily. */
  getRecoverySequence(): number;
  /** Returns its unsubscribe. Listeners see each change once, in order. */
  onStatusChanged(
    listener: (status: BackgroundServiceStatus) => void,
  ): () => void;
  /** The connection service's `onReachability`. */
  observe(event: ElectronDaemonReachability): void;
  /**
   * Whether a consumer currently reads through the service. With none, the
   * status is `ok` and connection events are ignored: nothing depends on them.
   */
  setConsumerEnabled(
    consumer: BackgroundServiceConsumer,
    enabled: boolean,
  ): void;
  /**
   * One bounded Try again; concurrent calls share it. A no-op with no
   * enabled consumer or after `stop`. `attempt` resolves true only when it
   * holds a live lease: a reused session can still be reconnecting.
   */
  retry(attempt: () => Promise<boolean>): Promise<BackgroundServiceStatus>;
  /**
   * An enabled consumer served a read in-process because the service
   * couldn't be reached. Shows the warning even when no connection event
   * did, and latches like that event would. A lost connection never shows
   * on its own: only its restart failing does.
   */
  noteFallback(
    consumer: BackgroundServiceConsumer,
    reason: BackgroundServiceUnreachableReason,
  ): void;
  /**
   * Whether consumers should skip contacting the service: a start, attach,
   * host or reconnect failure since the last reach. Spares each read a
   * respawn and up to a setup timeout. Try again lifts it while it runs; a
   * failed one re-arms it unless the service was reached meanwhile.
   */
  isLatched(): boolean;
  /** Recovery handoff: one-way latch; no Try again or late reach can lift it. */
  beginRecovery(): void;
  /** Quit: ignores every later event and retry. */
  stop(): void;
}

/** Failures a new attempt would only repeat; a lost session is not one. */
const LATCHING_REASONS: ReadonlySet<BackgroundServiceUnreachableReason> =
  new Set<BackgroundServiceUnreachableReason>([
    'start_failed',
    'connect_timeout',
    'host_unavailable',
    'reconnect_failed',
  ]);

export interface ElectronDaemonHealthLog {
  /** Reason codes only, never an error message: those can name authorities. */
  warn(
    message: string,
    context: { reason: BackgroundServiceUnreachableReason },
  ): void;
  info(message: string): void;
}

export function createElectronDaemonHealth(
  log: ElectronDaemonHealthLog,
): ElectronDaemonHealth {
  let status: BackgroundServiceStatus = INITIAL_BACKGROUND_SERVICE_STATUS;
  const listeners = new Set<(status: BackgroundServiceStatus) => void>();
  const consumers = new Set<BackgroundServiceConsumer>();
  let retrying: Promise<BackgroundServiceStatus> | undefined;
  let stopped = false;
  let latched = false;
  let reaches = 0;
  let recoveries = 0;

  const update = (
    state: BackgroundServiceStatus['state'],
    retry: BackgroundServiceStatus['retry'],
    reason?: BackgroundServiceUnreachableReason,
  ): void => {
    if (
      state === status.state &&
      reason === status.reason &&
      retry === status.retry
    )
      return;
    const previous = status;
    status = {
      state,
      ...(reason && { reason }),
      retry,
      sequence: previous.sequence + 1,
    };
    if (status.reason && status.reason !== previous.reason)
      log.warn('Background service unavailable', { reason: status.reason });
    else if (previous.state === 'unavailable' && status.state === 'ok')
      log.info('Background service reachable again');
    for (const listener of Array.from(listeners)) {
      try {
        listener(status);
      } catch {
        // A failing listener never blocks the others or the connection.
      }
    }
  };
  const reached = (): void => {
    if (status.state !== 'ok') recoveries += 1;
    reaches += 1;
    latched = false;
    update('ok', 'idle');
  };
  const unreachable = (reason: BackgroundServiceUnreachableReason): void => {
    if (LATCHING_REASONS.has(reason)) latched = true;
    update('unavailable', status.retry, reason);
  };

  return {
    getStatus: () => status,
    getRecoverySequence: () => recoveries,
    onStatusChanged(listener): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    observe(event): void {
      if (stopped || consumers.size === 0) return;
      switch (event.kind) {
        case 'reached':
          return reached();
        case 'lost':
          // Hidden while the lease restarts the daemon (a crash, an idle
          // exit): Mike, q-13 GA3-1. The lease giving up reports
          // `reconnect_failed`: at once for a failure it never retries, by
          // its 30 s delivery bound for a retried or hung one.
          if (status.state === 'ok') update('reconnecting', status.retry);
          return;
        case 'unreachable':
          return unreachable(event.reason);
      }
    },
    noteFallback(consumer, reason): void {
      if (stopped || !consumers.has(consumer)) return;
      if (LATCHING_REASONS.has(reason)) latched = true;
      // A real loss reported `lost` first, so the restart decides; from `ok`,
      // the session closed on its own or the lease already replaced it.
      if (reason === 'connection_lost') return;
      // The connection event usually came first; its reason stays.
      if (status.state !== 'unavailable')
        update('unavailable', status.retry, reason);
    },
    isLatched: () => latched,
    beginRecovery(): void {
      latched = true;
      stopped = true;
    },
    setConsumerEnabled(consumer, enabled): void {
      if (enabled) consumers.add(consumer);
      else consumers.delete(consumer);
      if (consumers.size === 0 && !stopped) reached();
    },
    retry(attempt): Promise<BackgroundServiceStatus> {
      if (stopped || consumers.size === 0) return Promise.resolve(status);
      if (retrying) return retrying;
      const wasLatched = latched;
      const reachesBefore = reaches;
      latched = false;
      update(status.state, 'running', status.reason);
      const run = (async (): Promise<BackgroundServiceStatus> => {
        let live = false;
        try {
          // Deferred, so `retrying` is set before even a synchronous throw ends it.
          live = await Promise.resolve().then(attempt);
        } catch {
          // The attempt's own unreachable event already set the reason; a
          // refusal from a reached service leaves nothing to show.
        }
        retrying = undefined;
        if (stopped || consumers.size === 0) return status;
        if (live) reached();
        else {
          if (wasLatched && reaches === reachesBefore) latched = true;
          update(
            status.state,
            status.state === 'unavailable' ? 'failed' : 'idle',
            status.reason,
          );
        }
        return status;
      })();
      retrying = run;
      return run;
    },
    stop(): void {
      stopped = true;
    },
  };
}

let health: ElectronDaemonHealth | undefined;

/** The one record every consumer of the Electron daemon connections shares. */
export function getElectronDaemonHealth(): ElectronDaemonHealth {
  health ??= createElectronDaemonHealth({
    warn: logMainProcessWarn,
    info: logMainProcessInfo,
  });
  return health;
}
