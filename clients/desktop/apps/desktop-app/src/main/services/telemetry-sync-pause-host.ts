import { isE2eBuild } from '../lib/e2e-gate';
import { getObservabilityService } from '../observability';
import {
  TELEMETRY_SYNC_PAUSE_CHECK_INTERVAL_MS,
  TELEMETRY_SYNC_PAUSE_CONFIRMATION_MS,
  TelemetrySyncPauseMonitor,
} from './telemetry-sync-pause';
import { getTelemetrySyncService } from './telemetry-sync-service';

/** Production wiring for the telemetry sync pause monitor (CAN-3512). */

/**
 * E2E builds may shorten the confirmation and re-check windows so a spec can
 * observe a pause without waiting fifteen minutes. Production builds ignore
 * the variables.
 */
function e2eDuration(name: string, fallback: number): number {
  if (!isE2eBuild()) return fallback;
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), fallback);
}

let monitor: TelemetrySyncPauseMonitor | null = null;

/** Lazily creates and starts the process-wide monitor. */
export function getTelemetrySyncPauseMonitor(): TelemetrySyncPauseMonitor {
  if (monitor === null) {
    monitor = new TelemetrySyncPauseMonitor({
      service: getTelemetrySyncService(),
      recordDiagnostic: (record): void => {
        getObservabilityService().recordAppDiagnostic(record);
      },
      confirmationMs: e2eDuration(
        'CANOPY_E2E_TELEMETRY_SYNC_PAUSE_CONFIRMATION_MS',
        TELEMETRY_SYNC_PAUSE_CONFIRMATION_MS,
      ),
      checkIntervalMs: e2eDuration(
        'CANOPY_E2E_TELEMETRY_SYNC_PAUSE_CHECK_INTERVAL_MS',
        TELEMETRY_SYNC_PAUSE_CHECK_INTERVAL_MS,
      ),
    });
    monitor.start();
  }
  return monitor;
}
