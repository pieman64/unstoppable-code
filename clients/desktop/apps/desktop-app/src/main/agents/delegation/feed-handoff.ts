import { createHash } from 'node:crypto';
import type {
  AgentDelegationFeedAssignment,
  AgentDelegationFeedSummary,
  AgentDelegationResult,
  AgentDelegationSpawnRequest,
} from '@canopy/protocol/delegation';
import type { LedgerEntrySearchItem } from '@canopy/protocol/canopy-core';
import type {
  LedgerDelegationFeedEntrySnapshot,
  LedgerDelegationFeedRuntime,
  LedgerDelegationFeedValidation,
} from '../../canopy-tools/ledger-tools-runtime';

const MAX_VALIDATIONS = 128;
const OPEN_STATUSES = new Set([
  'TODO',
  'IN_PROGRESS',
  'BLOCKED',
  'NEEDS_REVIEW',
]);

interface AssignmentReceipt {
  readonly value: AgentDelegationFeedAssignment;
}

/**
 * Nudges the parent to settle what its delegate left open. Host-built from
 * IDs and statuses only: titles are the delegate's own text and stay out.
 */
function openWorkNote(
  open: readonly { readonly entryId: string; readonly status: string }[],
  openTotal: number,
): string {
  const listed = open
    .map((entry) => `${entry.entryId} (${entry.status})`)
    .join(', ');
  const more =
    openTotal > open.length ? `, and ${openTotal - open.length} more` : '';
  const tasks = openTotal === 1 ? '1 Feed entry' : `${openTotal} Feed entries`;
  return `This delegate left ${tasks} open: ${listed}${more}. Review each one now and update its status so the Feed stays accurate: complete it if the work is done, mark it blocked or failed, or hand it to another owner. SearchFeedEntries with entryIds reads them; UpdateFeedEntry changes them.`;
}

function refused(message: string): AgentDelegationResult<void> {
  return {
    ok: false,
    error: { code: 'invalid_request', message, retryable: false },
  };
}

/**
 * One trusted caller's handoff effects. Reads and writes stay on its Ledger
 * runtime's dispatcher port. Nothing in this class launches a child or writes
 * a delegation record. Admission refusals therefore have no Feed effects.
 */
export class DelegationFeedHandoff {
  private readonly validations = new Map<
    string,
    LedgerDelegationFeedValidation
  >();
  private readonly receipts = new Map<string, AssignmentReceipt>();
  private readonly admitted = new Set<string>();

  constructor(
    private readonly runtime: LedgerDelegationFeedRuntime,
    private readonly diagnostic: (error: unknown) => void,
  ) {}

  async validateTaskIds(
    task: AgentDelegationSpawnRequest,
    childHarness: string,
    signal?: AbortSignal,
  ): Promise<AgentDelegationResult<void>> {
    if (task.taskIds === undefined) return { ok: true, value: undefined };
    if (childHarness !== 'claude' && childHarness !== 'codex') {
      return refused(
        'taskIds requires a child with Feed tools (Claude or Codex).',
      );
    }
    try {
      const validation = await this.runtime.validateTaskIds(
        task.taskIds,
        signal,
      );
      const invalid = new Map(
        validation.invalid.map(({ entryId, reason }) => [entryId, reason]),
      );
      const validatedIds = new Set(
        validation.listed.map((entry) => entry.entryId),
      );
      for (const entryId of task.taskIds) {
        if (!validatedIds.has(entryId) && !invalid.has(entryId))
          invalid.set(entryId, 'validation_incomplete');
      }
      if (invalid.size > 0) {
        return refused(
          `Feed handoff refused: ${Array.from(invalid)
            .map(([entryId, reason]) => `${entryId}: ${reason}`)
            .join('; ')}`,
        );
      }
      const key = this.requestKey(task);
      this.validations.delete(key);
      this.validations.set(key, validation);
      while (this.validations.size > MAX_VALIDATIONS) {
        const oldest = this.validations.keys().next().value;
        if (oldest === undefined) break;
        this.validations.delete(oldest);
      }
      return { ok: true, value: undefined };
    } catch {
      this.report('Delegation Feed validation unavailable');
      return refused(
        `The caller's Feed could not validate these taskIds: ${task.taskIds.join(', ')}.`,
      );
    }
  }

  /**
   * Called only after a NEW durable delegation commits, before child create,
   * including queued children. A crash after commit but before this callback
   * is deliberately not retried: spawn replay only reads the current owners.
   */
  async onAdmitted(
    task: AgentDelegationSpawnRequest,
    delegationId: string,
  ): Promise<void> {
    if (task.taskIds === undefined || this.admitted.has(delegationId)) return;
    this.admitted.add(delegationId);
    const validation = this.validations.get(this.requestKey(task));
    const listed = validation?.listed ?? [];
    const listedIds = new Set(task.taskIds);
    const subtasks = (validation?.subtasks ?? []).filter(
      (entry) => !listedIds.has(entry.entryId),
    );
    const skipped = new Map<string, string>();
    let subtasksAssigned = 0;
    let subtasksSkipped = 0;
    const assigned: string[] = [];
    try {
      const owners = await this.runtime.owners(delegationId);
      const owner = owners.candidates[0];
      if (owner === undefined || owner.actor.kind !== 'managed_delegation') {
        for (const entryId of task.taskIds)
          skipped.set(entryId, 'owner_unavailable');
        subtasksSkipped = subtasks.length;
      } else {
        const snapshots = new Map<string, LedgerDelegationFeedEntrySnapshot>(
          [...listed, ...subtasks].map((entry) => [entry.entryId, entry]),
        );
        const current = await this.readEntries(Array.from(snapshots.keys()));
        for (const entryId of task.taskIds) {
          if (!snapshots.has(entryId))
            skipped.set(entryId, 'validation_unavailable');
        }
        for (const snapshot of Array.from(snapshots.values())) {
          let reason: string | undefined;
          const entry = current.get(snapshot.entryId);
          if (
            entry === undefined ||
            entry.revision !== snapshot.revision ||
            entry.owner.actorId !== snapshot.ownerActorId ||
            !OPEN_STATUSES.has(entry.status)
          ) {
            reason = 'changed_since_validation';
          } else {
            try {
              await this.runtime.updateEntry({
                entryId: snapshot.entryId,
                expectedRevision: snapshot.revision,
                owner: {
                  actorId: owner.actor.actorId,
                  eligibilityToken: owner.eligibilityToken,
                },
                idempotencyKey: `delegation-feed:${delegationId}:${snapshot.entryId}`,
              });
            } catch {
              reason = 'update_conflict_or_unavailable';
            }
          }
          if (listedIds.has(snapshot.entryId)) {
            if (reason === undefined) assigned.push(snapshot.entryId);
            else skipped.set(snapshot.entryId, reason);
          } else if (reason === undefined) subtasksAssigned += 1;
          else subtasksSkipped += 1;
        }
      }
    } catch {
      this.report('Delegation Feed assignment unavailable');
      for (const entryId of task.taskIds)
        skipped.set(entryId, 'assignment_unavailable');
      subtasksSkipped = subtasks.length;
    }
    this.receipts.set(delegationId, {
      value: {
        assigned,
        subtasksAssigned,
        skipped: task.taskIds.flatMap((entryId) => {
          const reason = skipped.get(entryId);
          return reason === undefined ? [] : [{ entryId, reason }];
        }),
        subtasksSkipped,
      },
    });
  }

  /** No update is ever retried here, even for a retained spawn replay. */
  async readFeedAssignment(
    task: AgentDelegationSpawnRequest,
    delegationId: string,
  ): Promise<AgentDelegationFeedAssignment | undefined> {
    if (task.taskIds === undefined) return undefined;
    const receipt = this.receipts.get(delegationId);
    try {
      // Identity filtering is independent of owner eligibility: settled and
      // stopped children remain readable, including after a process restart.
      const listedParams = {
        entryIds: [...task.taskIds],
        ownerDelegationId: delegationId,
        limit: task.taskIds.length,
      };
      const entries = await this.runtime.searchEntries(listedParams);
      const priorReasons = new Map(
        receipt?.value.skipped.map((entry) => [entry.entryId, entry.reason]),
      );
      const currentIds = new Set(entries.entries.map((entry) => entry.entryId));
      const assigned = task.taskIds.filter((entryId) =>
        currentIds.has(entryId),
      );
      const assignedSet = new Set(assigned);
      // This process's receipt has the exact count. A replay without one gets
      // a bounded current-owner view instead, which also counts work the
      // delegate has since recorded for itself.
      let subtasksAssigned = receipt?.value.subtasksAssigned;
      if (subtasksAssigned === undefined) {
        const listedIds = new Set(task.taskIds);
        const currentOwnerPage = await this.runtime.searchEntries({
          ownerDelegationId: delegationId,
          limit: 100,
        });
        subtasksAssigned = currentOwnerPage.entries.filter(
          (entry) => !listedIds.has(entry.entryId),
        ).length;
      }
      return {
        assigned,
        skipped: task.taskIds.flatMap((entryId) =>
          assignedSet.has(entryId)
            ? []
            : [
                {
                  entryId,
                  reason: priorReasons.get(entryId) ?? 'not_owned_by_delegate',
                },
              ],
        ),
        subtasksAssigned,
        subtasksSkipped: receipt?.value.subtasksSkipped ?? 0,
      };
    } catch {
      this.report('Delegation Feed assignment read unavailable');
      return {
        assigned: [],
        subtasksAssigned: 0,
        subtasksSkipped: 0,
        skipped: task.taskIds.map((entryId) => ({
          entryId,
          reason: 'assignment_read_unavailable',
        })),
      };
    }
  }

  async readFeedSummary(
    delegationId: string,
  ): Promise<AgentDelegationFeedSummary | undefined> {
    try {
      const result = await this.runtime.workSummary(delegationId);
      if (
        Object.values(result.counts).every(
          (count) => count === undefined || count === 0,
        )
      )
        return undefined;
      const open = result.open
        .slice(0, 10)
        .map(({ entryId, status, owner }) => ({
          entryId,
          status,
          owner: { kind: owner.kind, actorId: owner.actorId },
        }));
      return {
        counts: result.counts,
        open,
        openTotal: result.openTotal,
        ...(result.openTotal > 0
          ? { note: openWorkNote(open, result.openTotal) }
          : {}),
      };
    } catch {
      this.report('Delegation Feed summary unavailable');
      return undefined;
    }
  }

  private async readEntries(
    entryIds: readonly string[],
  ): Promise<Map<string, LedgerEntrySearchItem>> {
    const entries = new Map<string, LedgerEntrySearchItem>();
    for (let offset = 0; offset < entryIds.length; offset += 25) {
      const batch = entryIds.slice(offset, offset + 25);
      const result = await this.runtime.searchEntries({
        entryIds: batch,
        limit: batch.length,
      });
      for (const entry of result.entries) entries.set(entry.entryId, entry);
    }
    return entries;
  }

  private requestKey(task: AgentDelegationSpawnRequest): string {
    return createHash('sha256').update(JSON.stringify(task)).digest('hex');
  }

  private report(message: string): void {
    try {
      this.diagnostic(new Error(message));
    } catch {
      /* Diagnostics never fail a tool. */
    }
  }
}
