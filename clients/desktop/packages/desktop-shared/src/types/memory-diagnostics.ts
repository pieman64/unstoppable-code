/**
 * Opt-in memory diagnostics: status, reports and automatic dumps written by the
 * desktop main process. Shared with the renderer through IPC (phase 05).
 */

/** `report` is user-requested; `auto` is written near the main heap limit. */
export type MemoryReportKind = 'report' | 'auto';

export interface MemoryReportSummary {
  /** Folder name, for example `report-20261021T162619Z`; also the reveal id. */
  readonly reportId: string;
  readonly kind: MemoryReportKind;
  /** ISO timestamp. */
  readonly createdAt: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly durationMs: number;
  /** Whether the allocation-sampling profile was included. */
  readonly samplingIncluded: boolean;
}

export interface MemoryDiagnosticsStatus {
  readonly enabled: boolean;
  readonly samplingActive: boolean;
  /** Set when diagnostics are on but allocation sampling could not start. */
  readonly samplingUnavailableReason: string | null;
  readonly mainHeapUsedBytes: number;
  readonly mainHeapLimitBytes: number;
  /** App renderers a report would snapshot. */
  readonly rendererCount: number;
  /** Rough time the app may stop responding during a report, in whole seconds. */
  readonly estimatedReportSeconds: number;
  readonly reportInProgress: boolean;
  readonly lastReport: MemoryReportSummary | null;
}

export type CreateMemoryReportFailureReason =
  | 'disabled'
  | 'in-progress'
  | 'insufficient-disk'
  | 'failed';

export type CreateMemoryReportResult =
  | { readonly ok: true; readonly report: MemoryReportSummary }
  | {
      readonly ok: false;
      readonly reason: CreateMemoryReportFailureReason;
      readonly message: string;
    };
