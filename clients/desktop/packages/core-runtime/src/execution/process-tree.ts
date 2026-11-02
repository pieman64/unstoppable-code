import type { PlatformProcessTableRow } from '../platform/platform-services';
import type {
  ExecutionPressure,
  ExecutionPressureLevel,
  ExecutionRegistration,
  ExecutionResourceGroup,
  ExecutionResourceGroupId,
  ExecutionResourceItem,
  ExecutionResourceKind,
} from './types';

export const PROCESS_TABLE_UNAVAILABLE = 'process-table sampling unavailable';

/** One read of the host: its process table and any host-reported rows. */
export interface ProcessSample<TMetadata extends { type: string }> {
  readonly rows: ReadonlyMap<number, PlatformProcessTableRow>;
  readonly hostRows: ReadonlyMap<number, ExecutionResourceItem<TMetadata>>;
  readonly childrenByParent: ReadonlyMap<number, PlatformProcessTableRow[]>;
  readonly tableAvailable: boolean;
}

export interface ProcessTreeOptions<TMetadata extends { type: string }> {
  readonly rootPid: number;
  readonly groupLabel: (id: ExecutionResourceGroupId) => string;
  /** Groups pipeline steps under the execution that ran them. */
  readonly executionIdOf: (
    metadata: ExecutionResourceItem<TMetadata>['metadata'],
  ) => string | undefined;
}

interface AggregatedProcess<TMetadata extends { type: string }> {
  cpuPercent: number;
  memoryRssBytes: number;
  processCount: number;
  children: ExecutionResourceItem<TMetadata>[];
  ppid?: number;
}

export function clampCpuPercent(percent: number): number {
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  return Math.min(100, percent);
}

export function createProcessSample<TMetadata extends { type: string }>(
  rows: ReadonlyMap<number, PlatformProcessTableRow> | null,
  hostItems: readonly ExecutionResourceItem<TMetadata>[],
): ProcessSample<TMetadata> {
  const hostRows = new Map<number, ExecutionResourceItem<TMetadata>>();
  for (const item of hostItems) {
    if (typeof item.pid === 'number') hostRows.set(item.pid, item);
  }
  const childrenByParent = new Map<number, PlatformProcessTableRow[]>();
  for (const row of rows ? Array.from(rows.values()) : []) {
    const siblings = childrenByParent.get(row.ppid) ?? [];
    siblings.push(row);
    childrenByParent.set(row.ppid, siblings);
  }
  return {
    rows: rows ?? new Map(),
    hostRows,
    childrenByParent,
    tableAvailable: rows !== null,
  };
}

function classify(row: PlatformProcessTableRow): {
  groupId: ExecutionResourceGroupId;
  kind: ExecutionResourceKind;
} {
  const command = row.command.toLowerCase().replace(/\.exe$/, '');
  if (command === 'codex') return { groupId: 'codex', kind: 'chat-provider' };
  if (command === 'claude') return { groupId: 'claude', kind: 'chat-provider' };
  return { groupId: 'other', kind: 'other' };
}

function shouldCount<TMetadata extends { type: string }>(
  item: ExecutionResourceItem<TMetadata>,
): boolean {
  return !(item.groupId === 'pipelines' && item.kind === 'pipeline-execution');
}

function shouldShow<TMetadata extends { type: string }>(
  item: ExecutionResourceItem<TMetadata>,
): boolean {
  return !(
    item.kind === 'codex-app-server-pool' && typeof item.pid !== 'number'
  );
}

class GroupBuilder<TMetadata extends { type: string }> {
  private readonly groups = new Map<
    ExecutionResourceGroupId,
    ExecutionResourceGroup<TMetadata>
  >();

  constructor(
    private readonly label: (id: ExecutionResourceGroupId) => string,
  ) {}

  private group(
    id: ExecutionResourceGroupId,
  ): ExecutionResourceGroup<TMetadata> {
    const existing = this.groups.get(id);
    if (existing) return existing;
    const created: ExecutionResourceGroup<TMetadata> = {
      id,
      label: this.label(id),
      cpuPercent: 0,
      memoryRssBytes: 0,
      processCount: 0,
      items: [],
    };
    this.groups.set(id, created);
    return created;
  }

  add(item: ExecutionResourceItem<TMetadata>): void {
    if (!shouldShow(item)) return;
    const group = this.group(item.groupId);
    group.items.push(item);
    if (shouldCount(item)) this.count(group, item);
  }

  /** Counts usage already shown inside another item's rollup. */
  countOnly(item: ExecutionResourceItem<TMetadata>): void {
    this.count(this.group(item.groupId), item);
  }

  private count(
    group: ExecutionResourceGroup<TMetadata>,
    item: ExecutionResourceItem<TMetadata>,
  ): void {
    group.cpuPercent = clampCpuPercent(group.cpuPercent + item.cpuPercent);
    group.memoryRssBytes += item.memoryRssBytes;
    group.processCount += item.processCount;
  }

  build(): ExecutionResourceGroup<TMetadata>[] {
    return Array.from(this.groups.values(), (group) => ({
      ...group,
      cpuPercent: clampCpuPercent(group.cpuPercent),
    }));
  }
}

function aggregatePid<TMetadata extends { type: string }>(
  pid: number,
  sample: ProcessSample<TMetadata>,
  processGroupId: number | undefined,
): AggregatedProcess<TMetadata> {
  const rootHostRow = sample.hostRows.get(pid);
  const rootRow = sample.rows.get(pid);
  let cpuPercent = rootHostRow?.cpuPercent ?? rootRow?.cpuPercent ?? 0;
  let memoryRssBytes =
    rootHostRow?.memoryRssBytes ?? rootRow?.memoryRssBytes ?? 0;
  let processCount = rootHostRow || rootRow ? 1 : 0;
  const children: ExecutionResourceItem<TMetadata>[] = [];
  const visited = new Set<number>([pid]);

  const addRow = (row: PlatformProcessTableRow): void => {
    if (visited.has(row.pid)) return;
    visited.add(row.pid);
    const hostRow = sample.hostRows.get(row.pid);
    const childCpu = hostRow?.cpuPercent ?? row.cpuPercent;
    const childMemory = hostRow?.memoryRssBytes ?? row.memoryRssBytes;
    const { groupId, kind } = classify(row);
    cpuPercent += childCpu;
    memoryRssBytes += childMemory;
    processCount += 1;
    children.push({
      id: `process:${row.pid}`,
      kind,
      groupId,
      label: hostRow?.label ?? row.command,
      pid: row.pid,
      ppid: row.ppid,
      processGroupId: row.pgid,
      cpuPercent: childCpu,
      memoryRssBytes: childMemory,
      processCount: 1,
      status: 'running',
      metadata: { type: 'generic' },
    });
    walk(row.pid);
  };
  const walk = (parentPid: number): void => {
    for (const row of sample.childrenByParent.get(parentPid) ?? []) addRow(row);
  };
  walk(pid);
  if (typeof processGroupId === 'number') {
    for (const row of Array.from(sample.rows.values())) {
      if (row.pgid === processGroupId && row.pid !== pid) addRow(row);
    }
  }
  return {
    cpuPercent: clampCpuPercent(cpuPercent),
    memoryRssBytes,
    processCount,
    children,
    ...(rootRow ? { ppid: rootRow.ppid } : {}),
  };
}

function registrationItem<TMetadata extends { type: string }>(
  registration: ExecutionRegistration<TMetadata>,
  sample: ProcessSample<TMetadata>,
): ExecutionResourceItem<TMetadata> {
  if (typeof registration.pid !== 'number') {
    return {
      id: registration.id,
      kind: registration.kind,
      groupId: registration.groupId,
      label: registration.label,
      cpuPercent: 0,
      memoryRssBytes: 0,
      processCount: 0,
      startedAt: registration.startedAt,
      status: 'idle',
      metadata: registration.metadata,
    };
  }
  const aggregated = aggregatePid(
    registration.pid,
    sample,
    registration.processGroupId,
  );
  return {
    id: registration.id,
    kind: registration.kind,
    groupId: registration.groupId,
    label: registration.label,
    pid: registration.pid,
    processGroupId: registration.processGroupId,
    ppid: aggregated.ppid,
    cpuPercent: aggregated.cpuPercent,
    memoryRssBytes: aggregated.memoryRssBytes,
    processCount: aggregated.processCount,
    startedAt: registration.startedAt,
    status: aggregated.processCount > 0 ? 'running' : 'unknown',
    metadata: registration.metadata,
    ...(aggregated.children.length > 0
      ? { children: aggregated.children }
      : {}),
  };
}

function rollUpExecutions<TMetadata extends { type: string }>(
  executions: ExecutionResourceItem<TMetadata>[],
  steps: ExecutionResourceItem<TMetadata>[],
  executionIdOf: ProcessTreeOptions<TMetadata>['executionIdOf'],
): ExecutionResourceItem<TMetadata>[] {
  return executions.map((execution) => {
    const executionId = executionIdOf(execution.metadata);
    const children = steps.filter(
      (step) =>
        executionIdOf(step.metadata) !== undefined &&
        executionIdOf(step.metadata) === executionId,
    );
    if (children.length === 0) {
      return {
        ...execution,
        cpuPercent: 0,
        memoryRssBytes: 0,
        processCount: 0,
        status: 'idle',
      };
    }
    return {
      ...execution,
      cpuPercent: clampCpuPercent(
        children.reduce((total, item) => total + item.cpuPercent, 0),
      ),
      memoryRssBytes: children.reduce(
        (total, item) => total + item.memoryRssBytes,
        0,
      ),
      processCount: children.reduce(
        (total, item) => total + item.processCount,
        0,
      ),
      status: 'running',
      children,
    };
  });
}

function unregisteredDescendants<TMetadata extends { type: string }>(
  rootPid: number,
  sample: ProcessSample<TMetadata>,
  claimed: ReadonlySet<number>,
): PlatformProcessTableRow[] {
  const rows: PlatformProcessTableRow[] = [];
  const visited = new Set<number>([rootPid]);
  const walk = (parentPid: number): void => {
    for (const row of sample.childrenByParent.get(parentPid) ?? []) {
      if (visited.has(row.pid)) continue;
      visited.add(row.pid);
      if (!claimed.has(row.pid)) rows.push(row);
      walk(row.pid);
    }
  };
  walk(rootPid);
  return rows;
}

/**
 * Groups the root's process tree: host rows, registered work with its
 * descendants and process group, pipeline steps rolled up under their
 * execution, and unregistered descendants classified by command.
 */
export function buildResourceGroups<TMetadata extends { type: string }>(
  registrations: readonly ExecutionRegistration<TMetadata>[],
  sample: ProcessSample<TMetadata>,
  options: ProcessTreeOptions<TMetadata> & {
    readonly countRootFromTable: boolean;
  },
): ExecutionResourceGroup<TMetadata>[] {
  const groups = new GroupBuilder<TMetadata>(options.groupLabel);
  const claimed = new Set<number>();
  const steps: ExecutionResourceItem<TMetadata>[] = [];
  const executions: ExecutionResourceItem<TMetadata>[] = [];
  const registeredPids = new Set<number>();
  for (const registration of registrations) {
    if (typeof registration.pid === 'number')
      registeredPids.add(registration.pid);
  }

  for (const hostRow of Array.from(sample.hostRows.values())) {
    if (typeof hostRow.pid === 'number') {
      claimed.add(hostRow.pid);
      if (registeredPids.has(hostRow.pid)) continue;
    }
    groups.add(hostRow);
  }

  for (const registration of registrations) {
    const item = registrationItem(registration, sample);
    if (typeof registration.pid === 'number') {
      claimed.add(registration.pid);
      for (const child of item.children ?? []) {
        if (typeof child.pid === 'number') claimed.add(child.pid);
      }
    }
    if (item.kind === 'pipeline-step') steps.push(item);
    else if (item.kind === 'pipeline-execution') executions.push(item);
    else groups.add(item);
  }

  const rolledUp = new Set<string>();
  for (const execution of rollUpExecutions(
    executions,
    steps,
    options.executionIdOf,
  )) {
    for (const child of execution.children ?? []) rolledUp.add(child.id);
    groups.add(execution);
  }
  for (const step of steps) {
    if (rolledUp.has(step.id)) {
      groups.countOnly({ ...step, groupId: 'pipelines' });
    } else {
      groups.add(step);
    }
  }

  // A host that reports no rows of its own (the daemon) is measured from the
  // table; Electron reports its main process itself.
  const rootRow = sample.rows.get(options.rootPid);
  if (options.countRootFromTable && rootRow && !claimed.has(rootRow.pid)) {
    groups.add({
      id: `host:${rootRow.pid}`,
      kind: 'other',
      groupId: 'app',
      label: rootRow.command,
      pid: rootRow.pid,
      ppid: rootRow.ppid,
      processGroupId: rootRow.pgid,
      cpuPercent: rootRow.cpuPercent,
      memoryRssBytes: rootRow.memoryRssBytes,
      processCount: 1,
      status: 'running',
      metadata: { type: 'generic' },
    });
  }

  if (sample.tableAvailable) {
    for (const row of unregisteredDescendants(
      options.rootPid,
      sample,
      claimed,
    )) {
      const { groupId, kind } = classify(row);
      groups.add({
        id: `${groupId}:${row.pid}`,
        kind,
        groupId,
        label: row.command,
        pid: row.pid,
        ppid: row.ppid,
        processGroupId: row.pgid,
        cpuPercent: row.cpuPercent,
        memoryRssBytes: row.memoryRssBytes,
        processCount: 1,
        status: 'running',
        metadata: { type: 'generic' },
      });
    }
  }
  return groups.build();
}

/** Pressure from the root tree's resident memory against the host thresholds. */
export function computePressure(
  memoryRssBytes: number,
  tableAvailable: boolean,
  thresholds: { warningMemoryBytes: number; criticalMemoryBytes: number },
  productName: string,
): ExecutionPressure {
  const base = {
    warningMemoryBytes: thresholds.warningMemoryBytes,
    criticalMemoryBytes: thresholds.criticalMemoryBytes,
  };
  if (!tableAvailable) {
    return { level: 'unknown', reasons: [PROCESS_TABLE_UNAVAILABLE], ...base };
  }
  let level: ExecutionPressureLevel = 'ok';
  const reasons: string[] = [];
  if (memoryRssBytes >= thresholds.criticalMemoryBytes) {
    level = 'critical';
    reasons.push(`${productName} memory usage critical`);
  } else if (memoryRssBytes >= thresholds.warningMemoryBytes) {
    level = 'warning';
    reasons.push(`${productName} memory usage elevated`);
  }
  return { level, reasons, ...base };
}
