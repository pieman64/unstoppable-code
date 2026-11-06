import {
  WORKER_CODE_GRAPH_READ_REPORT_CAPABILITY,
  WorkerCodeGraphReadFailureDetailsSchema,
  WorkerCodeGraphReportedReadSchema,
  type CanopyErrorPayload,
  type CanopyJsonValue,
  type WorkerCodeGraphReadReport,
  type WorkerCodeGraphReportedRead,
} from '@canopy/protocol/canopy-core';

import { CanopyOperationError } from '../../runtime/errors';
import type { CanopyControlReplyFit } from '../daemon/control-plane';

/*
 * One request's read-host reads, as their query telemetry and local read
 * diagnostics record them (CAN-5691). Electron main records its own reads
 * from its read scheduler; the core daemon collects the same observations
 * from its scheduler and returns them with its answer, and the requesting
 * interface replays them into the recorders its own scheduler feeds, so a
 * daemon read is recorded as an in-process read is, once. The structural
 * types mirror `@canopy/code-graph`'s, which this package may not import.
 */

type Read = WorkerCodeGraphReportedRead;

/** One settled read, as the read scheduler observes it. */
export interface CodeGraphReadObservationInput {
  readonly kind: string;
  readonly outcome: string;
  readonly queueDurationMs: number;
  readonly executionDurationMs: number;
  readonly readFailure?: string;
}

/** The read scheduler host's recorders, which a report replays into. */
export interface CodeGraphReadRecorders {
  recordReadDiagnostic(input: Read & { key: string }): void;
}

const MAX_REPORTED_READS = 64;
const MAX_DURATION_MS = 86_400_000;

function duration(value: number): number {
  return Number.isFinite(value)
    ? Math.max(0, Math.min(value, MAX_DURATION_MS))
    : 0;
}

/**
 * Collects one request's reads for its report. A read the wire would refuse
 * (an unknown kind, say) is left out rather than failing the request, and
 * past 64 reads the rest are left out.
 */
export class CodeGraphReadReportCollector {
  private readonly reads: Read[] = [];

  observe(input: CodeGraphReadObservationInput): void {
    if (this.reads.length >= MAX_REPORTED_READS) return;
    const read = WorkerCodeGraphReportedReadSchema.safeParse({
      kind: input.kind,
      outcome: input.outcome,
      queueDurationMs: duration(input.queueDurationMs),
      executionDurationMs: duration(input.executionDurationMs),
      ...(input.readFailure === undefined
        ? {}
        : { readFailure: input.readFailure }),
    });
    if (read.success) this.reads.push(read.data);
  }

  /** The report so far; absent when no read reached a read host. */
  report(): WorkerCodeGraphReadReport | undefined {
    return this.reads.length === 0 ? undefined : { reads: [...this.reads] };
  }
}

/** A read refusal that also carries how its reads went, if any ran. */
export function withCodeGraphReadReport(
  error: unknown,
  report: WorkerCodeGraphReadReport | undefined,
): unknown {
  if (
    report === undefined ||
    !(error instanceof CanopyOperationError) ||
    error.payload.details !== undefined
  )
    return error;
  return new CanopyOperationError(
    { ...error.payload, details: { read: report } },
    error.runtimeCause,
  );
}

/** The read report a code-graph read refusal carries, if any. */
export function codeGraphReadReportOf(
  details: unknown,
): WorkerCodeGraphReadReport | null {
  const parsed = WorkerCodeGraphReadFailureDetailsSchema.safeParse(details);
  return parsed.success ? parsed.data.read : null;
}

/**
 * Records a report's reads as the requester's read scheduler records its
 * own: each read's local read diagnostic under `key`
 * (`${workspaceId}/${worktreeId}`).
 */
export function recordCodeGraphReadReport(
  report: WorkerCodeGraphReadReport,
  key: string,
  recorders: CodeGraphReadRecorders,
): void {
  for (const read of report.reads) {
    try {
      recorders.recordReadDiagnostic({ ...read, key });
    } catch {
      // Local diagnostic storage must not fail the read, as in process.
    }
  }
}

const QUERY = 'worker.codeGraph.query';

function without(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([name]) => name !== key),
  );
}

/**
 * Leaves read reports out of `worker.codeGraph.query` replies to a client
 * that did not announce it decodes them: an older client's strict result
 * schema refuses the field.
 */
export const codeGraphReadReportFit: CanopyControlReplyFit = {
  result: (method, result, capabilities) =>
    method === QUERY &&
    !capabilities.has(WORKER_CODE_GRAPH_READ_REPORT_CAPABILITY) &&
    typeof result === 'object' &&
    result !== null &&
    'read' in result
      ? without(result, 'read')
      : result,
  error: (method, error, capabilities): CanopyErrorPayload => {
    const { details } = error;
    if (
      method !== QUERY ||
      capabilities.has(WORKER_CODE_GRAPH_READ_REPORT_CAPABILITY) ||
      typeof details !== 'object' ||
      details === null ||
      Array.isArray(details) ||
      !('read' in details)
    )
      return error;
    const rest: Record<string, CanopyJsonValue> = {};
    for (const [key, value] of Object.entries(details))
      if (key !== 'read') rest[key] = value;
    if (Object.keys(rest).length > 0) return { ...error, details: rest };
    return {
      kind: error.kind,
      message: error.message,
      ...(error.code === undefined ? {} : { code: error.code }),
      retry: error.retry,
    };
  },
};
