import {
  recordCodeGraphQueryTelemetry,
  recordCodeGraphReadDiagnostic,
} from '../lib/code-graph-telemetry';

/**
 * Where this process records each code-graph read: its read scheduler's own
 * reads, and the reads a daemon reports with its answer (CAN-5691).
 */
export const codeGraphReadRecorders = {
  recordQueryTelemetry: (
    input: Parameters<typeof recordCodeGraphQueryTelemetry>[0],
  ): void => recordCodeGraphQueryTelemetry(input),
  recordReadDiagnostic: (
    input: Parameters<typeof recordCodeGraphReadDiagnostic>[0],
  ): void => recordCodeGraphReadDiagnostic(input),
};
