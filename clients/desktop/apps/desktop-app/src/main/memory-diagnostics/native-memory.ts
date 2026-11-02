import { readFile, rm } from 'node:fs/promises';
import { contentTracing, type ProcessMetric } from 'electron';
import { isRecord } from '../lib/type-guards';

/**
 * One Chromium memory-infra dump, taken through `contentTracing`, summarized
 * per process. It attributes the native memory a heap snapshot cannot see:
 * malloc, PartitionAlloc partitions, Blink GC, V8, cc tiles, GPU and Skia.
 */
export interface NativeMemoryAllocator {
  readonly sizeBytes: number;
  /** Size with shared ownership counted once; absent for some allocators. */
  readonly effectiveSizeBytes: number | null;
}

export interface NativeMemoryProcess {
  readonly pid: number;
  /** The OS private footprint: `phys_footprint` on macOS. */
  readonly privateFootprintBytes: number | null;
  /** Keyed by allocator path, such as `partition_alloc/partitions/buffer`. */
  readonly allocators: Readonly<Record<string, NativeMemoryAllocator>>;
}

export interface NativeMemorySummary {
  readonly captured: boolean;
  readonly unavailableReason: string | null;
  readonly durationMs: number;
  readonly processes: readonly NativeMemoryProcess[];
  /** App processes with no dump in the trace, for example a slow one. */
  readonly missingProcessIds: readonly number[];
}

const MEMORY_INFRA_CATEGORY = 'disabled-by-default-memory-infra';
// The scheduler dumps once when tracing starts; the long period keeps it to one.
const DUMP_PERIOD_MS = 10 * 60 * 1000;
// shortcut: fixed wait; Electron exposes no dump-complete signal. Raise it if field reports show missingProcessIds.
export const NATIVE_DUMP_WAIT_MS = 3000;
const MAX_ALLOCATOR_DEPTH = 3;
// Code-defined names such as `v8` and `blink_gc` only. Ids, hashes and
// addresses (`tile_manager_0`, `isolate_0x…`, `ResourceProvider_0x…`,
// `allocated_objects/__…`) are dropped.
const ALLOCATOR_SEGMENT = /^[a-z][a-z0-9_]*$/;
const NUMBERED_SEGMENT = /_\d/;

function parseHexBytes(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[0-9a-f]+$/i.test(value)) {
    return null;
  }
  const parsed = Number.parseInt(value, 16);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function scalarBytes(
  attrs: Record<string, unknown>,
  name: string,
): number | null {
  const attribute = attrs[name];
  return isRecord(attribute) && attribute.units === 'bytes'
    ? parseHexBytes(attribute.value)
    : null;
}

function isKeptAllocatorName(name: string): boolean {
  const segments = name.split('/');
  return (
    // `global/…` is shared memory listed once for all processes.
    segments[0] !== 'global' &&
    segments.length <= MAX_ALLOCATOR_DEPTH &&
    segments.every(
      (segment) =>
        ALLOCATOR_SEGMENT.test(segment) && !NUMBERED_SEGMENT.test(segment),
    )
  );
}

interface ProcessAccumulator {
  dumpId: string;
  privateFootprintBytes: number | null;
  allocators: Record<string, NativeMemoryAllocator>;
}

/**
 * Reads a trace's memory dump (`ph: "v"`) events. A process's allocators and
 * totals arrive in separate events of one dump; only its first dump is kept.
 */
export function summarizeMemoryInfraTrace(
  trace: unknown,
): NativeMemoryProcess[] {
  const events = isRecord(trace) ? trace.traceEvents : trace;
  if (!Array.isArray(events)) {
    throw new Error('The memory trace has no events.');
  }
  const processes = new Map<number, ProcessAccumulator>();
  for (const event of events) {
    if (!isRecord(event) || event.ph !== 'v') continue;
    const { pid, id, args } = event;
    if (
      typeof pid !== 'number' ||
      typeof id !== 'string' ||
      !isRecord(args) ||
      !isRecord(args.dumps)
    ) {
      continue;
    }
    let accumulator = processes.get(pid);
    if (accumulator === undefined) {
      accumulator = { dumpId: id, privateFootprintBytes: null, allocators: {} };
      processes.set(pid, accumulator);
    } else if (accumulator.dumpId !== id) {
      continue;
    }
    const { process_totals: totals, allocators } = args.dumps;
    if (isRecord(totals)) {
      const footprint = parseHexBytes(totals.private_footprint_bytes);
      if (footprint !== null) accumulator.privateFootprintBytes = footprint;
    }
    if (!isRecord(allocators)) continue;
    for (const [name, dump] of Object.entries(allocators)) {
      if (
        !isKeptAllocatorName(name) ||
        !isRecord(dump) ||
        !isRecord(dump.attrs)
      ) {
        continue;
      }
      const sizeBytes = scalarBytes(dump.attrs, 'size');
      if (sizeBytes === null) continue;
      accumulator.allocators[name] = {
        sizeBytes,
        effectiveSizeBytes: scalarBytes(dump.attrs, 'effective_size'),
      };
    }
  }
  return Array.from(processes, ([pid, accumulator]) => ({
    pid,
    privateFootprintBytes: accumulator.privateFootprintBytes,
    allocators: accumulator.allocators,
  }));
}

/**
 * The raw trace is still on disk, so a report holding it must not be kept:
 * its metadata holds the command line and hardware identifiers.
 */
export class NativeMemoryTraceCleanupError extends Error {}

/**
 * Records one detailed memory-infra dump of every app process into
 * `tracePath`, summarizes it, and deletes the trace: its metadata holds the
 * command line and hardware identifiers, which the summary does not need.
 * Throws when tracing cannot start (another trace is recording) or the trace
 * cannot be read, and throws `NativeMemoryTraceCleanupError` when the trace
 * cannot be deleted.
 */
export async function captureNativeMemory(
  tracePath: string,
  appMetrics: readonly ProcessMetric[],
  waitMs: number,
): Promise<NativeMemorySummary> {
  const startedAt = Date.now();
  await contentTracing.startRecording({
    included_categories: [MEMORY_INFRA_CATEGORY],
    memory_dump_config: {
      triggers: [{ mode: 'detailed', periodic_interval_ms: DUMP_PERIOD_MS }],
    },
  });
  try {
    if (waitMs > 0) {
      await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
    }
    const writtenPath = await contentTracing.stopRecording(tracePath);
    const trace: unknown = JSON.parse(await readFile(writtenPath, 'utf8'));
    const processes = summarizeMemoryInfraTrace(trace);
    const dumped = new Set(processes.map((entry) => entry.pid));
    return {
      captured: true,
      unavailableReason: null,
      durationMs: Date.now() - startedAt,
      processes,
      missingProcessIds: appMetrics
        .map((metric) => metric.pid)
        .filter((pid) => !dumped.has(pid)),
    };
  } finally {
    try {
      await rm(tracePath, { force: true, maxRetries: 3 });
    } catch {
      // Thrown from finally on purpose: it replaces any capture result.
      // eslint-disable-next-line no-unsafe-finally
      throw new NativeMemoryTraceCleanupError(
        'The native memory trace could not be deleted.',
      );
    }
  }
}
