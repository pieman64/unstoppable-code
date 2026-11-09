import { computePressure } from '@canopy/core-runtime';
import type {
  CoreExecutionItem,
  CoreExecutionStatus,
} from '@canopy/protocol/canopy-core';
import type {
  ResourceGroupSnapshot,
  ResourceMonitorSnapshot,
  ResourceProcessSnapshot,
} from '@canopy/desktop-shared/types';

/*
 * Folds the daemon's execution status into Electron main's execution status
 * (CAN-5690): the resource monitor snapshot, and the accounting snapshot the
 * desktop dispatcher's `core.execution.status.*` serves to every client
 * (CAN-5693), so desktop pressure and processes include daemon-hosted work.
 *
 * Electron main usually launched the daemon, so its own process table already
 * holds the daemon and everything it runs as unlabeled descendants. The
 * daemon describes those processes better (its terminal and graph hosts, with
 * their processes under them), so an Electron row for a process the daemon
 * reports gives way to the daemon's row. A process the daemon has not sampled
 * yet keeps its Electron row, so each process counts once. A daemon another
 * client launched is simply added.
 *
 * The daemon samples only while its own work holds a lease, and once more
 * after, so an idle daemon's last status goes stale. A status older than a few
 * of its sample intervals, or one the daemon could not measure, is left out:
 * Electron's live rows, which hold the daemon whenever Electron launched it,
 * stand alone. Pressure is recomputed over the combined memory against the
 * desktop's thresholds, and memory admission compares the same combined
 * memory (CAN-5695).
 */

const DAEMON_ID_PREFIX = 'daemon:';

/** Three of the daemon's 5 s sample intervals. */
export const DAEMON_STATUS_MAX_AGE_MS = 15_000;

function clampCpuPercent(percent: number): number {
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  return Math.min(100, percent);
}

/** A pipeline execution's usage is counted through its rolled-up steps. */
function counts(item: ResourceProcessSnapshot): boolean {
  return !(item.groupId === 'pipelines' && item.kind === 'pipeline-execution');
}

/** An item's share of its group's CPU, as core counts it. */
function itemCpu(item: ResourceProcessSnapshot): number {
  if (counts(item)) return item.cpuPercent;
  return (item.children ?? []).reduce(
    (total, child) => total + child.cpuPercent,
    0,
  );
}

interface Metrics {
  cpuPercent: number;
  memoryRssBytes: number;
  processCount: number;
}

const NOTHING: Metrics = { cpuPercent: 0, memoryRssBytes: 0, processCount: 0 };

function metricsOf(item: ResourceProcessSnapshot): Metrics {
  return {
    cpuPercent: item.cpuPercent,
    memoryRssBytes: item.memoryRssBytes,
    processCount: item.processCount,
  };
}

function negate(metrics: Metrics): Metrics {
  return {
    cpuPercent: -metrics.cpuPercent,
    memoryRssBytes: -metrics.memoryRssBytes,
    processCount: -metrics.processCount,
  };
}

function add(into: Metrics, metrics: Metrics): void {
  into.cpuPercent += metrics.cpuPercent;
  into.memoryRssBytes += metrics.memoryRssBytes;
  into.processCount += metrics.processCount;
}

/**
 * The row without the processes the daemon reports below it, and what they
 * counted. A row's usage includes its children's, so each removal comes off
 * every row above it.
 */
function withoutReported(
  item: ResourceProcessSnapshot,
  reported: (pid: number | undefined) => boolean,
): { item: ResourceProcessSnapshot; removed: Metrics } {
  if (!item.children) return { item, removed: NOTHING };
  const removed = { ...NOTHING };
  const children: ResourceProcessSnapshot[] = [];
  for (const child of item.children) {
    if (reported(child.pid)) {
      add(removed, metricsOf(child));
      continue;
    }
    const pruned = withoutReported(child, reported);
    children.push(pruned.item);
    add(removed, pruned.removed);
  }
  if (
    children.length === item.children.length &&
    children.every((child, index) => child === item.children?.[index])
  )
    return { item, removed: NOTHING };
  const pruned: ResourceProcessSnapshot = {
    ...item,
    // A capped row loses its children's share; it cannot go below zero.
    cpuPercent: Math.max(0, item.cpuPercent - removed.cpuPercent),
    memoryRssBytes: item.memoryRssBytes - removed.memoryRssBytes,
    processCount: item.processCount - removed.processCount,
    children,
  };
  if (children.length === 0) delete pruned.children;
  return { item: pruned, removed };
}

/** Rebuilds the daemon's flat items as top-level rows with nested children. */
function daemonRows(items: readonly CoreExecutionItem[]): {
  roots: CoreExecutionItem[];
  rowOf: (item: CoreExecutionItem) => ResourceProcessSnapshot;
} {
  const ids = new Set(items.map((item) => item.id));
  const childrenOf = new Map<string, CoreExecutionItem[]>();
  const roots: CoreExecutionItem[] = [];
  for (const item of items) {
    if (item.parentId !== undefined && ids.has(item.parentId)) {
      const siblings = childrenOf.get(item.parentId) ?? [];
      siblings.push(item);
      childrenOf.set(item.parentId, siblings);
    } else {
      roots.push(item);
    }
  }
  const rowOf = (item: CoreExecutionItem): ResourceProcessSnapshot => {
    const children = (childrenOf.get(item.id) ?? []).map(rowOf);
    return {
      id: `${DAEMON_ID_PREFIX}${item.id}`,
      kind: item.kind,
      groupId: item.groupId,
      label: item.label,
      ...(item.pid !== undefined ? { pid: item.pid } : {}),
      ...(item.ppid !== undefined ? { ppid: item.ppid } : {}),
      ...(item.processGroupId !== undefined
        ? { processGroupId: item.processGroupId }
        : {}),
      cpuPercent: item.cpuPercent,
      memoryRssBytes: item.memoryRssBytes,
      processCount: item.processCount,
      ...(item.startedAt !== undefined ? { startedAt: item.startedAt } : {}),
      status: item.status,
      ...(children.length > 0 ? { children } : {}),
    };
  };
  return { roots, rowOf };
}

/** Whether the daemon measured this status recently enough to count it. */
function isCurrent(daemon: CoreExecutionStatus, now: number): boolean {
  const sampledAt = Date.parse(daemon.sampledAt);
  return (
    daemon.error === undefined &&
    daemon.pressure.level !== 'unknown' &&
    Number.isFinite(sampledAt) &&
    now - sampledAt <= DAEMON_STATUS_MAX_AGE_MS
  );
}

/** The part of an execution snapshot the daemon's status changes. */
type MergedExecutionStatus = Pick<
  ResourceMonitorSnapshot,
  'cpuPercent' | 'memoryRssBytes' | 'processCount' | 'pressure' | 'groups'
>;

export function mergeDaemonExecutionStatus<
  Snapshot extends MergedExecutionStatus,
>(
  snapshot: Snapshot,
  daemon: CoreExecutionStatus,
  options: { readonly productName: string; readonly now: number },
): Snapshot {
  const daemonItems = daemon.groups.flatMap((group) => group.items);
  if (daemonItems.length === 0 || !isCurrent(daemon, options.now))
    return snapshot;
  const daemonPids = new Set<number>();
  for (const item of daemonItems)
    if (item.pid !== undefined) daemonPids.add(item.pid);

  const reported = (pid: number | undefined): boolean =>
    pid !== undefined && daemonPids.has(pid);
  const groups = new Map<ResourceGroupSnapshot['id'], ResourceGroupSnapshot>();
  for (const group of snapshot.groups) {
    const kept: ResourceProcessSnapshot[] = [];
    const removed = { ...NOTHING };
    let changed = false;
    for (const item of group.items) {
      if (!reported(item.pid)) {
        // A kept row may hold the daemon below it (a CLI that started it).
        const pruned = withoutReported(item, reported);
        kept.push(pruned.item);
        add(removed, pruned.removed);
        changed ||= pruned.item !== item;
        continue;
      }
      changed = true;
      if (!counts(item)) continue;
      // Electron's row may hold processes started since the daemon sampled
      // (a terminal's shell with its children): those stay as rows of their own.
      add(removed, metricsOf(item));
      for (const child of item.children ?? []) {
        if (child.pid === undefined || reported(child.pid)) continue;
        const pruned = withoutReported(child, reported);
        kept.push(pruned.item);
        add(removed, negate(metricsOf(pruned.item)));
      }
    }
    if (!changed) {
      groups.set(group.id, group);
      continue;
    }
    groups.set(group.id, {
      ...group,
      // Group CPU is already capped, so it is summed again from what stays.
      cpuPercent: kept.reduce((total, item) => total + itemCpu(item), 0),
      memoryRssBytes: group.memoryRssBytes - removed.memoryRssBytes,
      processCount: group.processCount - removed.processCount,
      items: kept,
    });
  }

  const { roots, rowOf } = daemonRows(daemonItems);
  for (const group of daemon.groups) {
    const groupRoots = roots.filter((item) => item.groupId === group.id);
    const rows = groupRoots.map((item) => {
      const row = rowOf(item);
      // The daemon's own process reads as its command line; name it instead.
      return group.id === 'app' ? { ...row, label: group.label } : row;
    });
    const existing = groups.get(group.id);
    groups.set(
      group.id,
      existing
        ? {
            ...existing,
            cpuPercent: existing.cpuPercent + group.cpuPercent,
            memoryRssBytes: existing.memoryRssBytes + group.memoryRssBytes,
            processCount: existing.processCount + group.processCount,
            items: [...existing.items, ...rows],
          }
        : {
            id: group.id,
            label: group.label,
            cpuPercent: group.cpuPercent,
            memoryRssBytes: group.memoryRssBytes,
            processCount: group.processCount,
            items: rows,
          },
    );
  }

  const merged = Array.from(groups.values(), (group) => ({
    ...group,
    cpuPercent: clampCpuPercent(group.cpuPercent),
    memoryRssBytes: Math.max(0, group.memoryRssBytes),
    processCount: Math.max(0, group.processCount),
  }));
  // Totals are the groups' sums, as core computes them.
  const memoryRssBytes = merged.reduce(
    (total, group) => total + group.memoryRssBytes,
    0,
  );
  return {
    ...snapshot,
    cpuPercent: clampCpuPercent(
      merged.reduce((total, group) => total + group.cpuPercent, 0),
    ),
    memoryRssBytes,
    processCount: merged.reduce(
      (total, group) => total + group.processCount,
      0,
    ),
    // Unknown stays unknown: Electron main could not read its process table.
    pressure:
      snapshot.pressure.level === 'unknown'
        ? snapshot.pressure
        : computePressure(
            memoryRssBytes,
            true,
            snapshot.pressure,
            options.productName,
          ),
    groups: merged,
  };
}
