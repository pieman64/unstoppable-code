import type {
  PairingTelemetryAttempt,
  PairingTelemetryContext,
  PairingTelemetryRecorder,
} from '@canopy/desktop-instrumentation/pairing';

/** Isolate injected callbacks as well as the production recorder. */
export function beginPairingTelemetry(
  recorder: PairingTelemetryRecorder | undefined,
  context: PairingTelemetryContext,
): PairingTelemetryAttempt | undefined {
  try {
    const attempt = recorder?.(context);
    if (!attempt) return undefined;
    let finished = false;
    return {
      end: (outcome): void => {
        if (finished) return;
        finished = true;
        try {
          attempt.end(outcome);
        } catch {
          /* Best effort. */
        }
      },
    };
  } catch {
    return undefined;
  }
}
