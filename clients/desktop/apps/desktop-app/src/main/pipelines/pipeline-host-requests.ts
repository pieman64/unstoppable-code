import {
  WORKER_PIPELINE_HOST_PATH_OUTPUTS,
  WorkerPipelineChatSendRecordSchema,
  WorkerPipelineHostActionRequestSchema,
  WorkerPipelineHostResultSchema,
  type WorkerPipelineHostActionRequest,
  type WorkerPipelineHostRequest,
  type WorkerPipelineHostResult,
} from '@canopy/protocol/canopy-core';
import { parseWorkspaceContext } from '@canopy/protocol/workspace-context';
import type {
  PipelineHostActionCaller,
  PipelineHostActionControls,
  PipelineHostActionRequest,
  PipelineHostActionResult,
  PipelineHostActions,
} from '@canopy/desktop-shared/node/pipelines/executor/types';
import { PIPELINE_NEEDS_DESKTOP_MESSAGE } from '@canopy/desktop-shared/pipelines/host-actions';
import type { ResolvedSendAgentMessageInputs } from '@canopy/desktop-shared/pipelines/host-send-agent-message';
import type { PipelineChatSendRecord } from '@canopy/desktop-shared/types/pipeline';
import { peekDesktopCanopyRuntime } from '../canopy-runtime/desktop-runtime-access';

/*
 * Host steps cross the local worker boundary as worker-to-core requests
 * (CAN-4140, CAN-5077). The executor's port raises every host step on
 * `worker.pipeline.hostRequests` with the run's owner; core
 * settles each with `worker.pipeline.hostRequest.respond`. What doesn't
 * cross yet stays in process, keyed by request id: the full caller (core
 * applies the request's own action, inputs and owner), the step's abort
 * signal, the executor's controls (artifacts directory, timeout finalizer),
 * the desktop host that applies the policy, the host's own unexpected
 * error, `send-agent-message`'s host-path inputs and the host-path outputs
 * the boundary refuses (CAN-5086).
 */

/**
 * `send-agent-message`'s inputs that hold host paths: its contained
 * attachments, and a converted chat automation's composer payload (CAN-5479).
 */
type SendHostPaths = Pick<
  ResolvedSendAgentMessageInputs,
  | 'attachments'
  | 'attachmentPaths'
  | 'attachmentPromptContexts'
  | 'fileReferences'
>;

/** Each host-path input and the count that crosses in its place. */
const SEND_HOST_PATH_COUNTS = [
  ['attachments', 'attachmentCount'],
  ['attachmentPaths', 'attachmentPathCount'],
  ['attachmentPromptContexts', 'attachmentPromptContextCount'],
  ['fileReferences', 'fileReferenceCount'],
] as const satisfies readonly (readonly [keyof SendHostPaths, string])[];

type SendHostPathCounts = Partial<
  Record<(typeof SEND_HOST_PATH_COUNTS)[number][1], number>
>;

interface InProcessHostCall {
  readonly host: PipelineHostActions;
  readonly caller: PipelineHostActionCaller;
  readonly controls: PipelineHostActionControls | undefined;
  /** The step's own signal: the executor withdrawing the call stops the host. */
  readonly signal: AbortSignal;
  /** `send-agent-message`'s host-path inputs, as the executor passed them. */
  readonly hostPaths: SendHostPaths | undefined;
  error?: unknown;
  pathOutputs?: Record<string, string>;
  /** A send record the boundary refuses; the executor reports it as invalid. */
  invalidChatSend?: PipelineChatSendRecord;
}

const calls = new Map<string, InProcessHostCall>();

const UNPORTABLE: PipelineHostActionResult = {
  status: 'failure',
  failureReason: 'validation_failed',
  error: 'This host step has an input the pipeline host doesn’t accept.',
  outputs: {},
};

function isPathOutput(key: string): boolean {
  return WORKER_PIPELINE_HOST_PATH_OUTPUTS.some((pathKey) => pathKey === key);
}

/** Split a host result into its portable form and what stays on this host. */
function toPortableResult(result: PipelineHostActionResult): {
  portable: WorkerPipelineHostResult;
  pathOutputs: Record<string, string>;
  invalidChatSend?: PipelineChatSendRecord;
} {
  const outputs: Record<string, string> = {};
  const pathOutputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(result.outputs))
    (isPathOutput(key) ? pathOutputs : outputs)[key] = value;
  const chatSend =
    result.chatSend === undefined
      ? undefined
      : WorkerPipelineChatSendRecordSchema.safeParse(result.chatSend);
  const sent = chatSend?.success ? { chatSend: chatSend.data } : {};
  const portable = WorkerPipelineHostResultSchema.parse(
    result.status === 'success'
      ? { status: 'success', outputs, ...sent }
      : {
          status: 'failure',
          failureReason: result.failureReason,
          message: result.error || 'The host step failed.',
          outputs,
          ...sent,
        },
  );
  return chatSend === undefined || chatSend.success
    ? { portable, pathOutputs }
    : { portable, pathOutputs, invalidChatSend: result.chatSend };
}

/**
 * The run's owner as it crosses, resolved as the host's owner policy
 * resolves it: a run without one is Personal, and an owner that isn't a
 * workspace context is `null`, whose project targets core refuses.
 */
function portableOwner(executionContext: string | undefined): string | null {
  const owner = executionContext ?? 'personal';
  return parseWorkspaceContext(owner) !== null ? owner : null;
}

/** A send's host-path inputs, only those it sets; an empty list stays. */
function sendHostPaths(inputs: ResolvedSendAgentMessageInputs): SendHostPaths {
  const paths: SendHostPaths = {};
  if (inputs.attachments !== undefined) paths.attachments = inputs.attachments;
  if (inputs.attachmentPaths !== undefined)
    paths.attachmentPaths = inputs.attachmentPaths;
  if (inputs.attachmentPromptContexts !== undefined)
    paths.attachmentPromptContexts = inputs.attachmentPromptContexts;
  if (inputs.fileReferences !== undefined)
    paths.fileReferences = inputs.fileReferences;
  return paths;
}

function sendHostPathCounts(paths: SendHostPaths): SendHostPathCounts {
  const counts: SendHostPathCounts = {};
  for (const [input, count] of SEND_HOST_PATH_COUNTS) {
    const length = paths[input]?.length ?? 0;
    if (length > 0) counts[count] = length;
  }
  return counts;
}

/** The request's portable inputs; host paths stay on this host. */
function portableInputs(request: PipelineHostActionRequest): object {
  if (request.action !== 'send-agent-message') return request.inputs;
  const inputs = Object.entries(request.inputs).filter(
    ([key]) => !SEND_HOST_PATH_COUNTS.some(([input]) => input === key),
  );
  return {
    ...Object.fromEntries(inputs),
    ...sendHostPathCounts(sendHostPaths(request.inputs)),
  };
}

function hostPathsOf(
  request: PipelineHostActionRequest,
): SendHostPaths | undefined {
  return request.action === 'send-agent-message'
    ? sendHostPaths(request.inputs)
    : undefined;
}

/**
 * The executor's host port on the local worker: raise the request for core
 * and return its settlement. Without a core settling requests the step fails
 * as it does without a desktop.
 */
export function createWorkerPipelineHostActions(
  host: PipelineHostActions,
): PipelineHostActions {
  return {
    async run(
      request,
      caller,
      signal,
      controls,
    ): Promise<PipelineHostActionResult> {
      const portable = WorkerPipelineHostActionRequestSchema.safeParse({
        action: request.action,
        ...portableInputs(request),
      });
      if (!portable.success) return UNPORTABLE;
      const broker = peekDesktopCanopyRuntime()?.pipelineHostRequests;
      if (!broker?.settled)
        return {
          status: 'failure',
          failureReason: 'needs_desktop',
          error: PIPELINE_NEEDS_DESKTOP_MESSAGE,
          outputs: {},
        };
      const requestId = caller.idempotencyKey;
      const call: InProcessHostCall = {
        host,
        caller,
        controls,
        signal,
        hostPaths: hostPathsOf(request),
      };
      calls.set(requestId, call);
      try {
        const result = await broker.raise(
          {
            requestId,
            executionId: caller.executionId,
            jobId: caller.jobId,
            stepId: caller.stepId,
            childExecutionId: caller.childId ?? null,
            attempt: caller.attempt,
            iteration: caller.iteration,
            owner: portableOwner(caller.executionContext),
            deadlineAt: new Date(
              controls?.deadlineAt ?? Date.now(),
            ).toISOString(),
            request: portable.data,
          },
          signal,
        );
        const outputs = { ...result.outputs, ...call.pathOutputs };
        // A record the boundary refused reaches the executor, which reports
        // it as an invalid receipt, as before.
        const chatSend = result.chatSend ?? call.invalidChatSend;
        const sent = chatSend === undefined ? {} : { chatSend };
        if (result.status === 'success')
          return { status: 'success', outputs, ...sent };
        // An unexpected host error keeps its own message in process.
        if (result.failureReason === null)
          throw call.error instanceof Error
            ? call.error
            : new Error(result.message);
        return {
          status: 'failure',
          failureReason: result.failureReason,
          error: result.message,
          outputs,
          ...sent,
        };
      } finally {
        if (calls.get(requestId) === call) calls.delete(requestId);
      }
    },
  };
}

function toHostRequest(
  request: WorkerPipelineHostActionRequest,
  call: InProcessHostCall,
): PipelineHostActionRequest | null {
  switch (request.action) {
    case 'move-to-group': {
      const { action, ...inputs } = request;
      return { action, inputs };
    }
    case 'create-worktree': {
      const { action, ...inputs } = request;
      return { action, inputs };
    }
    case 'create-project-entry': {
      const { action, ...inputs } = request;
      return { action, inputs };
    }
    case 'create-bot-entry': {
      const { action, ...inputs } = request;
      return { action, inputs };
    }
    case 'send-agent-message': {
      const {
        action,
        attachmentCount,
        attachmentPathCount,
        attachmentPromptContextCount,
        fileReferenceCount,
        ...inputs
      } = request;
      const counts: SendHostPathCounts = {
        attachmentCount,
        attachmentPathCount,
        attachmentPromptContextCount,
        fileReferenceCount,
      };
      // The paths the worker kept, for the counts the request names.
      const hostPaths = call.hostPaths ?? {};
      const kept = sendHostPathCounts(hostPaths);
      if (
        SEND_HOST_PATH_COUNTS.some(([, count]) => kept[count] !== counts[count])
      )
        return null;
      // An explicit empty list stays: the host fingerprints it.
      return { action, inputs: { ...inputs, ...hostPaths } };
    }
    case 'wait-for-agent-reply': {
      const { action, ...inputs } = request;
      return { action, inputs };
    }
  }
}

const NOT_WAITING: WorkerPipelineHostResult = {
  status: 'failure',
  failureReason: 'not_found',
  message: 'This host request is no longer waiting.',
  outputs: {},
};

/**
 * Core's settlement of one host request: the desktop host applies its
 * policy for the call this request belongs to.
 */
export async function applyPipelineHostRequest(
  request: WorkerPipelineHostRequest,
  signal: AbortSignal,
): Promise<WorkerPipelineHostResult> {
  const call = calls.get(request.requestId);
  if (
    call?.caller.executionId !== request.executionId ||
    portableOwner(call.caller.executionContext) !== request.owner
  )
    return NOT_WAITING;
  const hostRequest = toHostRequest(request.request, call);
  if (hostRequest === null) return NOT_WAITING;
  try {
    const { portable, pathOutputs, invalidChatSend } = toPortableResult(
      await call.host.run(
        hostRequest,
        call.caller,
        AbortSignal.any([signal, call.signal]),
        call.controls,
      ),
    );
    call.pathOutputs = pathOutputs;
    if (invalidChatSend !== undefined) call.invalidChatSend = invalidChatSend;
    return portable;
  } catch (error) {
    call.error = error;
    throw error;
  }
}
