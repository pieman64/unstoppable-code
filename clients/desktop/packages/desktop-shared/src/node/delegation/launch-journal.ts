import type { AgentDelegationTerminalStatus } from '@canopy/protocol/delegation';

export interface DelegationLaunchRecord {
  readonly version: 1;
  readonly delegationId: string;
  readonly launchKey: string;
  readonly runGeneration: number;
  readonly phase:
    | 'reserved'
    | 'starting'
    | 'identified'
    | 'interrupted'
    | 'settled';
  readonly nativeSessionId?: string;
  readonly terminalStatus?: AgentDelegationTerminalStatus;
}

export type DelegationNativeReconciliation =
  | { readonly status: 'unknown' }
  | { readonly status: 'active'; readonly nativeSessionId: string }
  | {
      readonly status: 'terminal';
      readonly nativeSessionId: string;
      readonly terminalStatus: AgentDelegationTerminalStatus;
    };

export interface DelegationLaunchPersistence {
  /** Private per-run record, with a single host writer; resolve only after sync. */
  commit(record: DelegationLaunchRecord): Promise<void>;
}

/** Durable ordering seam. It never launches, resumes, or retries a provider. */
export class DelegationLaunchJournal {
  private tail: Promise<void> = Promise.resolve();
  private constructor(
    private record: DelegationLaunchRecord,
    private readonly persistence: DelegationLaunchPersistence,
  ) {}

  static async reserve(
    identity: Pick<
      DelegationLaunchRecord,
      'delegationId' | 'launchKey' | 'runGeneration'
    >,
    persistence: DelegationLaunchPersistence,
  ): Promise<DelegationLaunchJournal> {
    const record: DelegationLaunchRecord = Object.freeze({
      ...identity,
      version: 1,
      phase: 'reserved',
    });
    validateRecord(record);
    await persistence.commit(record);
    return new DelegationLaunchJournal(record, persistence);
  }

  static restore(
    record: DelegationLaunchRecord,
    persistence: DelegationLaunchPersistence,
  ): DelegationLaunchJournal {
    validateRecord(record);
    return new DelegationLaunchJournal(
      Object.freeze({ ...record }),
      persistence,
    );
  }

  snapshot(): DelegationLaunchRecord {
    return this.record;
  }

  /** Commit the paid-call boundary before touching the native runtime. */
  beforeStart(): Promise<boolean> {
    return this.serial(async () => {
      if (this.record.phase !== 'reserved') return false;
      await this.write({ ...this.record, phase: 'starting' });
      return true;
    });
  }

  /** Await this as soon as a native ID is returned or emitted. */
  identify(nativeSessionId: string): Promise<void> {
    return this.serial(async () => {
      if (
        !validId(nativeSessionId) ||
        (this.record.phase !== 'starting' &&
          this.record.phase !== 'identified') ||
        (this.record.nativeSessionId !== undefined &&
          this.record.nativeSessionId !== nativeSessionId)
      )
        throw new Error('Invalid native delegation identity');
      if (this.record.nativeSessionId === nativeSessionId) return;
      await this.write({
        ...this.record,
        phase: 'identified',
        nativeSessionId,
      });
    });
  }

  /**
   * Record that an identified run moved to a new native session mid-run (a
   * capability reload re-seeds a Codex child on a fresh thread). Only an
   * identified run can rebind; reconciliation then probes the latest identity.
   */
  rebind(nativeSessionId: string): Promise<void> {
    return this.serial(async () => {
      if (!validId(nativeSessionId) || this.record.phase !== 'identified')
        throw new Error('Invalid native delegation identity');
      if (this.record.nativeSessionId === nativeSessionId) return;
      await this.write({ ...this.record, nativeSessionId });
    });
  }

  settle(terminalStatus: AgentDelegationTerminalStatus): Promise<void> {
    return this.serial(async () => {
      if (this.record.phase === 'settled') return;
      await this.write({ ...this.record, phase: 'settled', terminalStatus });
    });
  }

  /** Active leftovers must be stopped by their owning adapter, never respawned. */
  reconcile(
    probe: (
      record: DelegationLaunchRecord,
    ) => Promise<DelegationNativeReconciliation>,
  ): Promise<
    DelegationNativeReconciliation | { readonly status: 'not_dispatched' }
  > {
    return this.serial(async () => {
      if (this.record.phase === 'reserved') return { status: 'not_dispatched' };
      if (this.record.phase === 'settled') return { status: 'unknown' };
      let native: DelegationNativeReconciliation;
      try {
        native = await probe(this.record);
      } catch {
        native = { status: 'unknown' };
      }
      if (
        native.status !== 'unknown' &&
        (!validId(native.nativeSessionId) ||
          (this.record.nativeSessionId !== undefined &&
            this.record.nativeSessionId !== native.nativeSessionId))
      )
        native = { status: 'unknown' };
      if (native.status === 'terminal')
        await this.write({
          ...this.record,
          phase: 'settled',
          nativeSessionId: native.nativeSessionId,
          terminalStatus: native.terminalStatus,
        });
      else
        await this.write({
          ...this.record,
          phase: 'interrupted',
          ...(native.status === 'active'
            ? { nativeSessionId: native.nativeSessionId }
            : {}),
        });
      return native;
    });
  }

  private async write(record: DelegationLaunchRecord): Promise<void> {
    validateRecord(record);
    const retained = Object.freeze({ ...record });
    await this.persistence.commit(retained);
    this.record = retained;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function validId(id: string): boolean {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 512 &&
    !/[\0\r\n]/.test(id)
  );
}

function validateRecord(record: DelegationLaunchRecord): void {
  if (
    record.version !== 1 ||
    !validId(record.delegationId) ||
    !validId(record.launchKey) ||
    !Number.isSafeInteger(record.runGeneration) ||
    record.runGeneration < 1 ||
    !['reserved', 'starting', 'identified', 'interrupted', 'settled'].includes(
      record.phase,
    ) ||
    (record.nativeSessionId !== undefined &&
      !validId(record.nativeSessionId)) ||
    (record.phase === 'identified' && record.nativeSessionId === undefined) ||
    (record.terminalStatus !== undefined &&
      !['completed', 'failed', 'cancelled', 'deadline_exceeded'].includes(
        record.terminalStatus,
      )) ||
    (record.phase === 'settled') !== (record.terminalStatus !== undefined)
  )
    throw new Error('Invalid delegation launch record');
}
