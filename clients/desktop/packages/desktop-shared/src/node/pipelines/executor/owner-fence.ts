import type { ExecutionState } from '@canopy/execution-engine/types/pipeline';

/*
 * Orphan detection for an execution's owning process (CAN-4140). A running
 * execution records its owner's PID and, when the host can prove it, the
 * owner's start identity. A live PID whose start identity differs is a reused
 * PID, so its execution is orphaned. Without a recorded identity or a host
 * inspector, detection falls back to PID liveness alone.
 */

export type PipelineOwnerInspection =
  | { state: 'running'; startIdentity: string }
  | { state: 'absent' }
  | { state: 'unverifiable' };

export type PipelineOwnerInspector = (
  pid: number,
) => Promise<PipelineOwnerInspection>;

type PipelineOwnerFields = Pick<
  ExecutionState,
  'owner_pid' | 'owner_start_identity'
>;

let inspector: PipelineOwnerInspector | null = null;
let selfIdentity: string | null = null;

/**
 * Install the host's process inspector and record this process's start
 * identity. Executions that start before it resolves record only their PID.
 */
export async function configurePipelineOwnerFence(
  inspect: PipelineOwnerInspector | null,
): Promise<void> {
  inspector = inspect;
  selfIdentity = null;
  if (!inspect) return;
  const self = await inspect(process.pid).catch(
    (): PipelineOwnerInspection => ({ state: 'unverifiable' }),
  );
  if (inspector === inspect && self.state === 'running')
    selfIdentity = self.startIdentity;
}

/** The owner fields a process writes when it takes an execution. */
export function pipelineOwnerFields(): PipelineOwnerFields {
  return {
    owner_pid: process.pid,
    ...(selfIdentity !== null && { owner_start_identity: selfIdentity }),
  };
}

/** Take ownership of a loaded execution, replacing its previous owner. */
export function claimPipelineOwner(state: PipelineOwnerFields): void {
  const fields = pipelineOwnerFields();
  state.owner_pid = fields.owner_pid;
  if (fields.owner_start_identity === undefined)
    delete state.owner_start_identity;
  else state.owner_start_identity = fields.owner_start_identity;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error))
    return undefined;
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Whether the execution's owner is provably gone: its PID is not running, or
 * a different process now holds it. An unprovable owner is not orphaned.
 */
export async function isKnownOrphanedExecution(
  state: PipelineOwnerFields,
): Promise<boolean> {
  const pid = state.owner_pid;
  if (
    pid === undefined ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    pid === process.pid
  )
    return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return errorCode(error) === 'ESRCH';
  }
  const recorded = state.owner_start_identity;
  const inspect = inspector;
  if (recorded === undefined || !inspect) return false;
  const current = await inspect(pid).catch(
    (): PipelineOwnerInspection => ({ state: 'unverifiable' }),
  );
  if (current.state === 'absent') return true;
  return current.state === 'running' && current.startIdentity !== recorded;
}
