import type {
  PlatformProcessTable,
  PlatformProcessTableRequest,
} from '../platform/platform-services';
import { wakeLockHolder, wakeLockHolderKey } from '../power/wake-lock-policy';
import {
  buildResourceGroups,
  clampCpuPercent,
  computePressure,
  createProcessSample,
  PROCESS_TABLE_UNAVAILABLE,
  type ProcessTreeOptions,
} from './process-tree';
import {
  EXECUTION_FAMILY_POLICIES,
  ExecutionAdmissionError,
  type ExecutionAccountingLimits,
  type ExecutionAccountingSnapshot,
  type ExecutionFamily,
  type ExecutionFamilyStatus,
  type ExecutionLease,
  type ExecutionRegistration,
  type ExecutionRegistrationHandle,
  type ExecutionReservation,
  type ExecutionResourceItem,
  type ExecutionWakeLock,
} from './types';

export interface ExecutionAccountingOptions<
  TMetadata extends { type: string },
> extends ProcessTreeOptions<TMetadata> {
  /** The host's `PlatformSupervisionServices.readProcessTable`. */
  readonly readProcessTable: (
    request?: PlatformProcessTableRequest,
  ) => Promise<PlatformProcessTable>;
  /** Rows a host measures itself, such as Electron's own processes. */
  readonly hostProcesses?: () => readonly ExecutionResourceItem<TMetadata>[];
  readonly limits: () => ExecutionAccountingLimits;
  readonly productName: string;
  /** Holds the computer awake for families whose policy asks for it. */
  readonly wakeLock?: ExecutionWakeLock;
  readonly now?: () => number;
}

function byFamily<T>(
  value: (family: ExecutionFamily) => T,
): Record<ExecutionFamily, T> {
  return {
    pipeline: value('pipeline'),
    script: value('script'),
    terminal: value('terminal'),
    codeGraph: value('codeGraph'),
  };
}

export type ExecutionAccountingListener<TMetadata extends { type: string }> = (
  snapshot: ExecutionAccountingSnapshot<TMetadata>,
) => void;

/**
 * Core execution accounting: admission and leases for pipeline, script,
 * terminal and code-graph work, the processes that work runs, and the
 * pressure signal from the host process table. One instance serves every
 * client of its host; a client going away unsubscribes and never releases
 * work it did not start. Leases end with their work, however it settles.
 */
export class ExecutionAccounting<TMetadata extends { type: string }> {
  private readonly options: ExecutionAccountingOptions<TMetadata>;
  private readonly now: () => number;
  private readonly registrations = new Map<
    string,
    ExecutionRegistration<TMetadata>
  >();
  private readonly leases = new Map<ExecutionFamily, Set<symbol>>();
  private readonly pending = new Map<ExecutionFamily, number>();
  private readonly listeners = new Set<
    ExecutionAccountingListener<TMetadata>
  >();
  private snapshot: ExecutionAccountingSnapshot<TMetadata>;
  private sampling: Promise<ExecutionAccountingSnapshot<TMetadata>> | null =
    null;

  constructor(options: ExecutionAccountingOptions<TMetadata>) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.snapshot = this.emptySnapshot();
  }

  getSnapshot(): ExecutionAccountingSnapshot<TMetadata> {
    return this.snapshot;
  }

  /** Live counts; the snapshot carries the counts at its sample time. */
  familyStatus(): Record<ExecutionFamily, ExecutionFamilyStatus> {
    const limits = this.options.limits();
    const memoryBlocked = this.memoryGuardBlocked(limits);
    return byFamily((family) => {
      const active = this.leases.get(family)?.size ?? 0;
      const pending = this.pending.get(family) ?? 0;
      const maxActive = limits.maxActive[family] ?? null;
      return {
        active,
        pending,
        maxActive,
        blocked:
          (maxActive !== null && active + pending >= maxActive) ||
          (EXECUTION_FAMILY_POLICIES[family].memoryGuarded && memoryBlocked),
      };
    });
  }

  /** Whether critical memory refuses memory-guarded work now. */
  isMemoryGuardBlocked(): boolean {
    return this.memoryGuardBlocked(this.options.limits());
  }

  /**
   * Admits one start or throws `ExecutionAdmissionError`. Active leases and
   * other pending starts both count against the family's limit.
   */
  admit(family: ExecutionFamily): ExecutionReservation {
    const limits = this.options.limits();
    const maxActive = limits.maxActive[family] ?? null;
    const active =
      (this.leases.get(family)?.size ?? 0) + (this.pending.get(family) ?? 0);
    if (maxActive !== null && active >= maxActive) {
      throw new ExecutionAdmissionError(family, 'limit', maxActive);
    }
    if (
      EXECUTION_FAMILY_POLICIES[family].memoryGuarded &&
      this.memoryGuardBlocked(limits)
    ) {
      throw new ExecutionAdmissionError(family, 'memory', maxActive);
    }
    this.pending.set(family, (this.pending.get(family) ?? 0) + 1);
    let released = false;
    return {
      release: (): void => {
        if (released) return;
        released = true;
        this.pending.set(
          family,
          Math.max(0, (this.pending.get(family) ?? 0) - 1),
        );
      },
    };
  }

  /** Counts accepted work until its lease is released. */
  track(family: ExecutionFamily, id: string): ExecutionLease {
    const token = Symbol(id);
    const held = this.leases.get(family) ?? new Set<symbol>();
    held.add(token);
    this.leases.set(family, held);
    const release = (): void => {
      held.delete(token);
    };
    return {
      family,
      id,
      release,
      releaseWhenSettled: (settled): void => {
        void Promise.resolve(settled).then(release, release);
      },
    };
  }

  /**
   * Holds the computer awake while the family's work runs, when its policy
   * asks for it. The returned release is idempotent.
   */
  keepAwake(family: ExecutionFamily, id: string): () => void {
    const kind = EXECUTION_FAMILY_POLICIES[family].keepAwake;
    const wakeLock = this.options.wakeLock;
    if (kind === null || !wakeLock) return (): void => undefined;
    wakeLock.acquire(...wakeLockHolder(kind, id));
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      wakeLock.release(wakeLockHolderKey(kind, id));
    };
  }

  register(
    registration: ExecutionRegistration<TMetadata>,
  ): ExecutionRegistrationHandle<TMetadata> {
    const current: ExecutionRegistration<TMetadata> = {
      ...registration,
      startedAt: registration.startedAt ?? new Date(this.now()).toISOString(),
    };
    this.registrations.set(registration.id, current);
    let active = true;
    return {
      update: (update): void => {
        const existing = this.registrations.get(registration.id);
        if (!active || !existing) return;
        this.registrations.set(registration.id, {
          ...existing,
          ...update,
          id: existing.id,
        });
      },
      unregister: (): void => {
        if (!active) return;
        active = false;
        this.registrations.delete(registration.id);
      },
    };
  }

  getRegistration(id: string): ExecutionRegistration<TMetadata> | undefined {
    return this.registrations.get(id);
  }

  subscribe(listener: ExecutionAccountingListener<TMetadata>): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  /** Samples once; a sample already running is joined, not repeated. */
  sample(): Promise<ExecutionAccountingSnapshot<TMetadata>> {
    if (this.sampling) return this.sampling;
    const run = this.sampleOnce().finally(() => {
      this.sampling = null;
    });
    this.sampling = run;
    return run;
  }

  /**
   * Drops registrations, pending starts, subscribers and the last sample at
   * host shutdown. Leases end with their own work.
   */
  dispose(): void {
    this.registrations.clear();
    this.pending.clear();
    this.listeners.clear();
    this.snapshot = this.emptySnapshot();
  }

  private memoryGuardBlocked(limits: ExecutionAccountingLimits): boolean {
    return (
      limits.memoryGuardEnabled &&
      this.snapshot.memoryRssBytes >= this.snapshot.pressure.criticalMemoryBytes
    );
  }

  private async sampleOnce(): Promise<ExecutionAccountingSnapshot<TMetadata>> {
    const hostItems = this.options.hostProcesses?.() ?? [];
    const table = await this.options.readProcessTable();
    const sample = createProcessSample(
      table.kind === 'sampled' ? table.rows : null,
      hostItems,
    );
    const groups = buildResourceGroups(
      Array.from(this.registrations.values()),
      sample,
      {
        ...this.options,
        countRootFromTable: this.options.hostProcesses === undefined,
      },
    );
    const cpuPercent = clampCpuPercent(
      groups.reduce((total, group) => total + group.cpuPercent, 0),
    );
    const memoryRssBytes = groups.reduce(
      (total, group) => total + group.memoryRssBytes,
      0,
    );
    const processCount = groups.reduce(
      (total, group) => total + group.processCount,
      0,
    );
    const limits = this.options.limits();
    const pressure = computePressure(
      memoryRssBytes,
      sample.tableAvailable,
      limits,
      this.options.productName,
    );
    const error =
      !sample.tableAvailable && sample.hostRows.size === 0
        ? PROCESS_TABLE_UNAVAILABLE
        : undefined;
    const next: ExecutionAccountingSnapshot<TMetadata> = {
      sampledAt: new Date(this.now()).toISOString(),
      rootPid: this.options.rootPid,
      cpuPercent,
      memoryRssBytes,
      processCount,
      pressure,
      groups,
      families: this.snapshot.families,
      memoryGuardBlocked: false,
      ...(error ? { error } : {}),
    };
    // Guard decisions read the newest sample, as admission will.
    this.snapshot = next;
    next.memoryGuardBlocked = this.memoryGuardBlocked(limits);
    next.families = this.familyStatus();
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(this.snapshot);
      } catch {
        // A failing client must not stop delivery to the others.
      }
    }
    return this.snapshot;
  }

  private emptySnapshot(): ExecutionAccountingSnapshot<TMetadata> {
    const limits = this.options.limits();
    const families = byFamily((family) => ({
      active: 0,
      pending: 0,
      maxActive: limits.maxActive[family] ?? null,
      blocked: false,
    }));
    return {
      sampledAt: new Date(this.now()).toISOString(),
      rootPid: this.options.rootPid,
      cpuPercent: 0,
      memoryRssBytes: 0,
      processCount: 0,
      pressure: {
        level: 'unknown',
        reasons: ['resource monitor has not sampled yet'],
        warningMemoryBytes: limits.warningMemoryBytes,
        criticalMemoryBytes: limits.criticalMemoryBytes,
      },
      groups: [],
      families,
      memoryGuardBlocked: false,
    };
  }
}
