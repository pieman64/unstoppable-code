import {
  WorkerPipelineExecutionSchema,
  type WorkerPipelineCancelMode,
  type WorkerPipelineExecution,
  type WorkerPipelineExecutionStartParams,
  type WorkerPipelineHostLaunch,
  type WorkerPipelineHostRequest,
  type WorkerPipelineHostResult,
  type WorkerPipelineHostStepValues,
} from '@canopy/protocol/canopy-core';
import type { PipelineOwnerSettlement } from '../execution/host-requests';

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

/** How the supervisor ended one host request (CAN-5771). */
export type PipelineHostStepSettlement =
  | {
      readonly kind: 'settled';
      readonly result: Exclude<WorkerPipelineHostResult, { status: 'owner' }>;
      /** `_execution.pipelineHostStep` from the owner's respond; null when it sent none. */
      readonly values: WorkerPipelineHostStepValues | null;
    }
  /** No owner subscribed within the wait. */
  | { readonly kind: 'unavailable' };

/** How the supervisor ended one request the host raised: a host step's, or an owner request's (CAN-5095). */
export type PipelineHostSettlement =
  | PipelineHostStepSettlement
  | { readonly kind: 'owner'; readonly settlement: PipelineOwnerSettlement };

/** The daemon executable's own command; it serves the Codex MCP launcher mode (CAN-4117). */
export interface PipelineHostLauncherCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export type PipelineHostRequest =
  /** Sent once, first, by the supervisor; the host refuses every other op before it. */
  | {
      op: 'configure';
      dataRoot: string;
      /** The pipeline host's Codex MCP launcher (CAN-5095 D18). */
      codexMcpLauncher?: PipelineHostLauncherCommand;
    }
  | { op: 'start'; start: PipelineHostLaunch }
  | { op: 'get'; executionId: string }
  | { op: 'cancel'; executionId: string; mode: WorkerPipelineCancelMode }
  | { op: 'sweep'; executionIds: string[] }
  | { op: 'checkpoint' }
  /** The supervisor's answer to a host request the host raised (CAN-5771). */
  | {
      op: 'hostSettled';
      requestId: string;
      settlement: PipelineHostSettlement;
    }
  /** Pause these owner-bound executions at a checkpoint: their owner is gone (CAN-5771). */
  | { op: 'pause'; executionIds: string[] }
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
  | 'host_steps'
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
      attempt?: number;
      iteration?: number;
      stream: 'stdout' | 'stderr';
      text: string;
    }
  /** A desktop notification a step asked for (CAN-5868). */
  | {
      kind: 'notification';
      executionId: string;
      stepId: string;
      title: string;
      body: string;
    }
  | { kind: 'process'; state: 'started'; id: string; processGroupId: number }
  | { kind: 'process'; state: 'exited'; id: string }
  /** An owner-bound run's host step or owner request, for the owner to settle (CAN-5771, CAN-5095). */
  | { kind: 'hostRequest'; request: WorkerPipelineHostRequest }
  | { kind: 'hostRequestWithdrawn'; executionId: string; requestId: string };

function isOptionalCount(value: unknown, minimum: number): boolean {
  return (
    value === undefined || (Number.isInteger(value) && Number(value) >= minimum)
  );
}

const HOST_ERROR_CODES: ReadonlySet<string> = new Set<PipelineHostErrorCode>([
  'not_found',
  'model_steps',
  'start_failed',
  'drain_timed_out',
  'cancel_failed',
  'checkpoint_failed',
  'host_steps',
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
        isOptionalCount(value.attempt, 0) &&
        isOptionalCount(value.iteration, 1) &&
        (value.stream === 'stdout' || value.stream === 'stderr') &&
        typeof value.text === 'string'
      );
    case 'notification':
      return (
        typeof value.executionId === 'string' &&
        typeof value.stepId === 'string' &&
        typeof value.title === 'string' &&
        typeof value.body === 'string'
      );
    case 'process':
      return isProcess(value);
    case 'hostRequest':
      return (
        isRecord(value.request) &&
        typeof value.request.requestId === 'string' &&
        value.request.requestId.length > 0 &&
        typeof value.request.executionId === 'string' &&
        value.request.executionId.length > 0
      );
    case 'hostRequestWithdrawn':
      return (
        typeof value.executionId === 'string' &&
        value.executionId.length > 0 &&
        typeof value.requestId === 'string' &&
        value.requestId.length > 0
      );
    default:
      return false;
  }
}
