import type { CrashDumpClassification } from '@canopy/desktop-instrumentation/electron/main';
import type { AppDiagnosticRecord } from './service';

/**
 * Records a foreign crash-dump filter classification as a
 * `crash_dump_filter_verdict` diagnostic, but only when either rule would
 * discard the dump. The startup sweep re-classifies every kept dump on each
 * launch; Canopy's own dumps (`process` under both rules) would repeat the
 * same record every startup, while a `discard` verdict is recorded once
 * because the sweep deletes that dump. The sweep's own diagnostic counts the
 * rest.
 */
export function createCrashDumpClassificationRecorder(
  recordDiagnostic: (diagnostic: AppDiagnosticRecord) => void,
): (classification: CrashDumpClassification) => void {
  return (classification): void => {
    if (
      classification.verdict !== 'discard' &&
      classification.locationVerdict !== 'discard'
    ) {
      return;
    }
    recordDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'crash_dump_filter_verdict',
      crashDumpVerdict: classification.verdict,
      crashDumpVerdictReason: classification.reason,
      crashDumpLocationVerdict: classification.locationVerdict,
      ...(classification.executableName === undefined
        ? {}
        : { crashDumpExecutableName: classification.executableName }),
    });
  };
}
