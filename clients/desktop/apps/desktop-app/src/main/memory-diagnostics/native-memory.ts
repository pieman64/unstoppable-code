import { readFile, rm } from 'node:fs/promises';
import { contentTracing, type ProcessMetric } from 'electron';

/**
 * One Chromium memory-infra dump, taken through `contentTracing`, summarized
 * per process. It attributes the native memory a heap snapshot cannot see:
 * malloc, PartitionAlloc partitions, Blink GC, V8, cc tiles, GPU and Skia.
 */
export interface NativeMemoryAllocator {
  readonly sizeBytes: number;
  /**
   * Size with shared ownership counted once. Perfetto traces (Electron 45+)
   * carry no effective sizes, so this is `null` for new reports.
   */
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

// Perfetto field numbers, from protos/perfetto/trace/trace.proto,
// trace_packet.proto, memory_graph.proto and ps/process_stats.proto.
const TRACE_PACKET = 1;
const PACKET_PROCESS_STATS = 9;
const PACKET_MEMORY_TRACKER_SNAPSHOT = 73;
const SNAPSHOT_PROCESS_MEMORY_DUMPS = 3;
const PROCESS_SNAPSHOT_PID = 1;
const PROCESS_SNAPSHOT_ALLOCATOR_DUMPS = 2;
const PROCESS_SNAPSHOT_MEMORY_EDGES = 3;
const MEMORY_NODE_ID = 1;
const MEMORY_NODE_ABSOLUTE_NAME = 2;
const MEMORY_NODE_WEAK = 3;
const MEMORY_NODE_SIZE_BYTES = 4;
const MEMORY_EDGE_SOURCE_ID = 1;
const MEMORY_EDGE_TARGET_ID = 2;
const PROCESS_STATS_PROCESSES = 1;
const PROCESS_PID = 1;
const PROCESS_CHROME_PRIVATE_FOOTPRINT_KB = 13;

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

/** One protobuf field: a varint or length-delimited bytes. */
interface ProtoField {
  readonly field: number;
  readonly value: bigint | Uint8Array;
}

const INVALID_TRACE = 'The memory trace is not a valid Perfetto trace.';

function readVarint(
  bytes: Uint8Array,
  start: number,
): { value: bigint; next: number } {
  let value = 0n;
  for (let offset = start, shift = 0n; offset < start + 10; shift += 7n) {
    const byte = bytes[offset];
    if (byte === undefined) break;
    offset += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: offset };
  }
  throw new Error(INVALID_TRACE);
}

function protoFields(bytes: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    offset = tag.next;
    const field = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (wireType === WIRE_VARINT) {
      const value = readVarint(bytes, offset);
      offset = value.next;
      fields.push({ field, value: value.value });
    } else if (wireType === WIRE_LENGTH_DELIMITED) {
      const length = readVarint(bytes, offset);
      const end = length.next + Number(length.value);
      if (end > bytes.length) throw new Error(INVALID_TRACE);
      fields.push({ field, value: bytes.subarray(length.next, end) });
      offset = end;
    } else if (wireType === WIRE_FIXED64 || wireType === WIRE_FIXED32) {
      offset += wireType === WIRE_FIXED64 ? 8 : 4;
    } else {
      throw new Error(INVALID_TRACE);
    }
  }
  if (offset !== bytes.length) throw new Error(INVALID_TRACE);
  return fields;
}

function messages(fields: readonly ProtoField[], field: number): Uint8Array[] {
  return fields.flatMap((entry) =>
    entry.field === field && entry.value instanceof Uint8Array
      ? [entry.value]
      : [],
  );
}

function varintField(
  fields: readonly ProtoField[],
  field: number,
): bigint | null {
  const entry = fields.find((candidate) => candidate.field === field);
  return typeof entry?.value === 'bigint' ? entry.value : null;
}

function safeNumber(value: bigint | null): number | null {
  return value !== null && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : null;
}

function text(fields: readonly ProtoField[], field: number): string | null {
  const [value] = messages(fields, field);
  return value === undefined
    ? null
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString(
        'utf8',
      );
}

function isWithin(name: string, ancestor: string): boolean {
  return name === ancestor || name.startsWith(`${ancestor}/`);
}

/**
 * Sizes one process's allocators. Perfetto lists only the nodes that dump
 * providers created, without memory-infra's computed sizes, so a parent such
 * as `v8` is implicit. As memory-infra does, a node with its own size keeps
 * it, and an implicit node sums its children, skipping a child that owns
 * another node under the same parent (`allocated_objects` owning
 * `partitions`), so nothing is counted twice. Weak nodes are dropped.
 */
function summarizeProcessSnapshot(
  processFields: readonly ProtoField[],
): Record<string, NativeMemoryAllocator> {
  const ownSize = new Map<string, number | null>();
  const nameById = new Map<bigint, string>();
  const weakNames: string[] = [];
  for (const node of messages(
    processFields,
    PROCESS_SNAPSHOT_ALLOCATOR_DUMPS,
  )) {
    const fields = protoFields(node);
    const name = text(fields, MEMORY_NODE_ABSOLUTE_NAME);
    if (name === null) continue;
    if (varintField(fields, MEMORY_NODE_WEAK) === 1n) weakNames.push(name);
    const id = varintField(fields, MEMORY_NODE_ID);
    if (id !== null) nameById.set(id, name);
    ownSize.set(name, safeNumber(varintField(fields, MEMORY_NODE_SIZE_BYTES)));
  }
  const children = new Map<string, string[]>();
  for (const name of Array.from(ownSize.keys())) {
    if (weakNames.some((weak) => isWithin(name, weak))) {
      ownSize.delete(name);
      continue;
    }
    // Register every implicit ancestor, as memory-infra's graph does.
    for (let child = name; child.includes('/'); ) {
      const parent = child.slice(0, child.lastIndexOf('/'));
      const siblings = children.get(parent);
      if (siblings?.includes(child)) break;
      if (siblings) siblings.push(child);
      else children.set(parent, [child]);
      if (!ownSize.has(parent)) ownSize.set(parent, null);
      child = parent;
    }
  }
  const owned = new Map<string, string[]>();
  for (const edge of messages(processFields, PROCESS_SNAPSHOT_MEMORY_EDGES)) {
    const fields = protoFields(edge);
    const sourceId = varintField(fields, MEMORY_EDGE_SOURCE_ID);
    const targetId = varintField(fields, MEMORY_EDGE_TARGET_ID);
    const source = sourceId === null ? undefined : nameById.get(sourceId);
    const target = targetId === null ? undefined : nameById.get(targetId);
    if (source === undefined || target === undefined) continue;
    owned.set(source, [...(owned.get(source) ?? []), target]);
  }
  const ownsWithin = (child: string, parent: string): boolean =>
    Array.from(owned).some(
      ([source, targets]) =>
        isWithin(source, child) &&
        targets.some(
          (target) => isWithin(target, parent) && !isWithin(target, child),
        ),
    );
  const sizes = new Map<string, number | null>();
  const sizeOf = (name: string): number | null => {
    const cached = sizes.get(name);
    if (cached !== undefined) return cached;
    let size = ownSize.get(name) ?? null;
    if (size === null) {
      for (const child of children.get(name) ?? []) {
        const childSize = ownsWithin(child, name) ? null : sizeOf(child);
        if (childSize !== null) size = (size ?? 0) + childSize;
      }
    }
    sizes.set(name, size);
    return size;
  };
  const allocators: Record<string, NativeMemoryAllocator> = {};
  for (const name of Array.from(ownSize.keys()).sort()) {
    if (!isKeptAllocatorName(name)) continue;
    const sizeBytes = sizeOf(name);
    if (sizeBytes !== null) {
      allocators[name] = { sizeBytes, effectiveSizeBytes: null };
    }
  }
  return allocators;
}

/**
 * Reads a Perfetto trace's memory-infra packets: each process's allocator
 * dumps (`memory_tracker_snapshot`) and private footprint (`process_stats`).
 * Only each process's first dump and first footprint are kept.
 */
export function summarizeMemoryInfraTrace(
  trace: Uint8Array,
): NativeMemoryProcess[] {
  const footprints = new Map<number, number>();
  const allocators = new Map<number, Record<string, NativeMemoryAllocator>>();
  for (const packet of messages(protoFields(trace), TRACE_PACKET)) {
    const packetFields = protoFields(packet);
    for (const stats of messages(packetFields, PACKET_PROCESS_STATS)) {
      for (const process of messages(
        protoFields(stats),
        PROCESS_STATS_PROCESSES,
      )) {
        const fields = protoFields(process);
        const pid = safeNumber(varintField(fields, PROCESS_PID));
        const footprintKb = safeNumber(
          varintField(fields, PROCESS_CHROME_PRIVATE_FOOTPRINT_KB),
        );
        if (pid === null || footprintKb === null || footprints.has(pid)) {
          continue;
        }
        footprints.set(pid, footprintKb * 1024);
      }
    }
    for (const snapshot of messages(
      packetFields,
      PACKET_MEMORY_TRACKER_SNAPSHOT,
    )) {
      for (const processDump of messages(
        protoFields(snapshot),
        SNAPSHOT_PROCESS_MEMORY_DUMPS,
      )) {
        const processFields = protoFields(processDump);
        const pid = safeNumber(
          varintField(processFields, PROCESS_SNAPSHOT_PID),
        );
        if (pid === null || allocators.has(pid)) continue;
        allocators.set(pid, summarizeProcessSnapshot(processFields));
      }
    }
  }
  const pids = new Set([...footprints.keys(), ...allocators.keys()]);
  return Array.from(pids, (pid) => ({
    pid,
    privateFootprintBytes: footprints.get(pid) ?? null,
    allocators: allocators.get(pid) ?? {},
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
    const trace = await readFile(writtenPath);
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
