/**
 * Renderer-wide registry of pipeline execution interest.
 *
 * Two levels of interest keep execution state alive and current independently
 * of the selected worktree's run list:
 *
 * - A **detail lease** is held by a consumer that renders one execution's
 *   detail (the execution detail modal today, the pipeline execution panel in
 *   phase 03). Leases are ref-counted per owner plus execution, so one
 *   disappearing consumer cannot release another's demand. Releasing the last
 *   lease lets the store evict the heavy detail snapshot.
 * - A **summary interest** is held by a lightweight consumer that shows one
 *   execution's live status outside the selected run list (chat run cards).
 *   It keeps the cached state across list scope changes and live under
 *   execution events, and never demands detail reads or log output.
 *
 * The registry is plain module state with no store imports, so both the store
 * and its consumers can depend on it without an import cycle. It is
 * per-renderer: auxiliary panel windows share the main renderer's context.
 */

/** The workspace that owns a detail consumer; null ids mean ownerless. */
export interface PipelineDetailOwner {
  projectId: string | null;
  worktreeId: string | null;
}

/** One acquired detail lease. Release it exactly once. */
export interface PipelineDetailLease {
  readonly executionId: string;
  readonly ownerKey: string;
}

interface LeaseRecord extends PipelineDetailLease {
  released: boolean;
}

const OWNERLESS_KEY = 'ownerless';

const leasesByExecution = new Map<string, Set<LeaseRecord>>();
const leasesByOwner = new Map<string, Set<LeaseRecord>>();
const summaryInterestCounts = new Map<string, number>();

/** Stable key for an owner; every ownerless consumer shares one key. */
export function pipelineDetailOwnerKey(
  owner: PipelineDetailOwner | null | undefined,
): string {
  if (!owner?.projectId || !owner.worktreeId) {
    return OWNERLESS_KEY;
  }
  return `${owner.projectId}/${owner.worktreeId}`;
}

function addToIndex(
  index: Map<string, Set<LeaseRecord>>,
  key: string,
  record: LeaseRecord,
): void {
  let records = index.get(key);
  if (!records) {
    records = new Set<LeaseRecord>();
    index.set(key, records);
  }
  records.add(record);
}

function removeFromIndex(
  index: Map<string, Set<LeaseRecord>>,
  key: string,
  record: LeaseRecord,
): void {
  const records = index.get(key);
  if (!records) return;
  records.delete(record);
  if (records.size === 0) {
    index.delete(key);
  }
}

function isLeaseRecord(lease: PipelineDetailLease): lease is LeaseRecord {
  return typeof Reflect.get(lease, 'released') === 'boolean';
}

/**
 * Registers detail demand for one execution. Acquire before the first
 * snapshot read so execution events observed during the read are applied to
 * the leased execution and can supersede a late snapshot.
 */
export function acquirePipelineDetailLease(
  owner: PipelineDetailOwner | null | undefined,
  executionId: string,
): PipelineDetailLease {
  const record: LeaseRecord = {
    executionId,
    ownerKey: pipelineDetailOwnerKey(owner),
    released: false,
  };
  addToIndex(leasesByExecution, executionId, record);
  addToIndex(leasesByOwner, record.ownerKey, record);
  return record;
}

/**
 * Releases one lease. Idempotent. Returns true when this released the
 * execution's last lease, so the caller can evict its heavy state.
 */
export function releasePipelineDetailLease(
  lease: PipelineDetailLease,
): boolean {
  if (!isLeaseRecord(lease) || lease.released) {
    return false;
  }
  lease.released = true;
  removeFromIndex(leasesByExecution, lease.executionId, lease);
  removeFromIndex(leasesByOwner, lease.ownerKey, lease);
  return !leasesByExecution.has(lease.executionId);
}

/**
 * Releases every lease an owner holds (owner deleted or archived). Returns
 * the executions that no longer have any lease. Later releases of those
 * leases by their consumers are no-ops.
 */
export function releasePipelineDetailLeasesForOwner(
  ownerKey: string,
): string[] {
  const records = leasesByOwner.get(ownerKey);
  if (!records) return [];
  const unleased = new Set<string>();
  for (const record of Array.from(records)) {
    if (releasePipelineDetailLease(record)) {
      unleased.add(record.executionId);
    }
  }
  return Array.from(unleased);
}

export function isPipelineExecutionLeased(executionId: string): boolean {
  return leasesByExecution.has(executionId);
}

export function getPipelineDetailLeaseCount(executionId: string): number {
  return leasesByExecution.get(executionId)?.size ?? 0;
}

/**
 * Registers a lightweight summary interest in one execution. The returned
 * release function is idempotent.
 */
export function acquirePipelineSummaryInterest(
  executionId: string,
): () => void {
  summaryInterestCounts.set(
    executionId,
    (summaryInterestCounts.get(executionId) ?? 0) + 1,
  );
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    const count = (summaryInterestCounts.get(executionId) ?? 1) - 1;
    if (count > 0) {
      summaryInterestCounts.set(executionId, count);
    } else {
      summaryInterestCounts.delete(executionId);
    }
  };
}

export function hasPipelineSummaryInterest(executionId: string): boolean {
  return summaryInterestCounts.has(executionId);
}

/** Leased or summary-interested executions survive list resets. */
export function isPipelineExecutionRetainedByInterest(
  executionId: string,
): boolean {
  return (
    leasesByExecution.has(executionId) || summaryInterestCounts.has(executionId)
  );
}

export function resetPipelineDetailLeasesForTests(): void {
  leasesByExecution.clear();
  leasesByOwner.clear();
  summaryInterestCounts.clear();
}
