import {
  WorkerPipelineExecutionSchema,
  type WorkerPipelineCancelMode,
  type WorkerPipelineExecution,
  type WorkerPipelineExecutionStartParams,
  type WorkerPipelineHostLaunch,
} from '@canopy/protocol/canopy-core';

/*
 * The private protocol between a worker and the pipeline host it supervises
 * (CAN-5086). Structured-clone values on the execution host channel; nothing
 * here is a wire operation. Every path in it was verified by the worker.
 */

/** What the host runs: the start's params, its verified launch and base environment. */
export interface PipelineHostLaunch {
  readonly params: Omit<WorkerPipelineExecutionStartParams, 'secrets'>;
  readonly launch: WorkerPipelineHostLaunch;
  /** The run's base environment (`_execution.childEnvironment`). */
  readonly processEnvironment: Readonly<Record<string, string>>;
}

export type PipelineHostRequest =
  /** Sent once, first, by the supervisor; the host refuses every other op before it. */
  | { op: 'configure'; dataRoot: string }
  | { op: 'start'; start: PipelineHostLaunch }
  | { op: 'get'; executionId: string }
  | { op: 'cancel'; executionId: string; mode: WorkerPipelineCancelMode }
  | { op: 'sweep'; executionIds: string[] }
  | { op: 'checkpoint' }
  /** Close admission and exit once nothing runs. */
  | { op: 'exit' };

export interface PipelineHostRequestMessage {
  readonly id: number;
  readonly request: PipelineHostRequest;
}

export type PipelineHostErrorCode =
  | 'not_found'
  | 'model_steps'
  | 'start_failed'
  | 'drain_timed_out'
  | 'cancel_failed'
  | 'checkpoint_failed'
  | 'closed';

export type PipelineHostMessage =
  | { kind: 'response'; id: number; ok: true; value: unknown }
  | {
      kind: 'response';
      id: number;
      ok: false;
      error: { code: PipelineHostErrorCode; message: string };
    }
  | {
      kind: 'execution';
      executionId: string;
      event: string;
      execution: WorkerPipelineExecution;
    }
  | {
      kind: 'output';
      executionId: string;
      jobId: string;
      stepId: string;
      stream: 'stdout' | 'stderr';
      text: string;
    }
  | { kind: 'process'; state: 'started'; id: string; processGroupId: number }
  | { kind: 'process'; state: 'exited'; id: string };

const HOST_ERROR_CODES: ReadonlySet<string> = new Set<PipelineHostErrorCode>([
  'not_found',
  'model_steps',
  'start_failed',
  'drain_timed_out',
  'cancel_failed',
  'checkpoint_failed',
  'closed',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResponse(value: Record<string, unknown>): boolean {
  if (typeof value.id !== 'number') return false;
  if (value.ok === true) return 'value' in value;
  return (
    value.ok === false &&
    isRecord(value.error) &&
    typeof value.error.code === 'string' &&
    HOST_ERROR_CODES.has(value.error.code) &&
    typeof value.error.message === 'string'
  );
}

function isProcess(value: Record<string, unknown>): boolean {
  if (typeof value.id !== 'string') return false;
  if (value.state === 'exited') return true;
  return (
    value.state === 'started' &&
    typeof value.processGroupId === 'number' &&
    Number.isInteger(value.processGroupId)
  );
}

export function isPipelineHostMessage(
  value: unknown,
): value is PipelineHostMessage {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'response':
      return isResponse(value);
    case 'execution':
      return (
        typeof value.executionId === 'string' &&
        typeof value.event === 'string' &&
        WorkerPipelineExecutionSchema.safeParse(value.execution).success
      );
    case 'output':
      return (
        typeof value.executionId === 'string' &&
        typeof value.jobId === 'string' &&
        typeof value.stepId === 'string' &&
        (value.stream === 'stdout' || value.stream === 'stderr') &&
        typeof value.text === 'string'
      );
    case 'process':
      return isProcess(value);
    default:
      return false;
  }
}
