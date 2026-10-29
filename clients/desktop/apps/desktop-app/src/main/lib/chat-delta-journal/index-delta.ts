/**
 * Order-preserving structural deltas between two versions of a scope's
 * live, archive and recovery indexes.
 *
 * A journal record carries only what changed. Applying a delta to the indexes
 * it was computed from reproduces the later indexes exactly, including object
 * key order, so a checkpoint serializes to the same bytes the version 2 write
 * path produces for the same state.
 *
 * Transcript descriptors (`transcript` on a chat entry) are never recorded:
 * they are derived from the transcript files when a checkpoint or reader
 * materializes the scope. A delta keeps each entry's `transcript` key in
 * place; a newly inserted entry carries `null` there, which
 * {@link restoreTranscriptDescriptors} replaces with the chat's previous
 * descriptor, exactly as the version 2 backend carries descriptors by id.
 *
 * Values follow JSON semantics: a key whose value is `undefined`, a function
 * or a symbol is absent; a non-finite number is `null`. Only plain data is
 * accepted.
 */
import type { TranscriptDescriptor } from '@canopy/agent-transcript/transcript-storage';
import { isRecord } from '../type-guards';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * `s`: replace the value. `c`: change these keys; with `o`, the result has
 * exactly the keys of `o` in that order, otherwise the previous keys minus
 * `d` keep their order and keys new to `c` follow. `a`: rebuild an array
 * from copied runs (`k`: start, count), new values (`v`) and patched
 * elements (`p`: previous index, patch).
 */
export type ValuePatch =
  | { s: JsonValue }
  | { c: { [key: string]: ValuePatch }; d?: string[] }
  | { o: string[]; c: { [key: string]: ValuePatch } }
  | { a: ArraySegment[] };

export type ArraySegment =
  | { k: [number, number] }
  | { v: JsonValue }
  | { p: [number, ValuePatch] };

export interface IndexDelta {
  live?: ValuePatch;
  archive?: ValuePatch;
  recovery?: ValuePatch;
}

/** Indexes as the delta sees them: chat entries carry a descriptor. */
export interface DescribedIndexes {
  live: { tabs: Array<{ id: string; transcript: TranscriptDescriptor }> };
  archive: {
    archived: Array<{ tab: { id: string; transcript: TranscriptDescriptor } }>;
  };
  recovery: object;
}

const EMPTY_DESCRIPTOR: TranscriptDescriptor = {
  format: 'complete-message-jsonl-v1',
  committedMessageCount: 0,
  committedByteLength: 0,
  transcriptRevision: 0,
  hasActiveSidecar: false,
};

/** Where in the index tree a value sits; only chat entries mask a key. */
type Shape =
  | 'any'
  | 'live'
  | 'archive'
  | 'tabs'
  | 'archived'
  | 'entry'
  | 'archived-entry';

const MAX_PATCH_DEPTH = 64;

export class IndexDeltaMismatchError extends Error {
  public override readonly name = 'IndexDeltaMismatchError';
}

function childShape(shape: Shape, key: string): Shape {
  if (shape === 'live' && key === 'tabs') return 'tabs';
  if (shape === 'archive' && key === 'archived') return 'archived';
  if (shape === 'archived-entry' && key === 'tab') return 'entry';
  return 'any';
}

function elementShape(shape: Shape): Shape {
  if (shape === 'tabs') return 'entry';
  if (shape === 'archived') return 'archived-entry';
  return 'any';
}

function masked(shape: Shape, key: string): boolean {
  return shape === 'entry' && key === 'transcript';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) return false;
  // Any realm's Object.prototype (or none): a structured clone or a parse in
  // another context is still plain data; a class instance is not.
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    prototype !== null &&
    (typeof prototype !== 'object' || Object.getPrototypeOf(prototype) !== null)
  )
    throw new Error(
      `Index value is not plain JSON data: ${Object.prototype.toString.call(value)}`,
    );
  if (typeof value.toJSON === 'function')
    throw new Error('Index value is not plain JSON data');
  return true;
}

function omitted(value: unknown): boolean {
  return (
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  );
}

/** Own keys JSON serializes, in serialization order. */
function jsonKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => !omitted(value[key]));
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function define(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** The JSON form of an in-memory value, with entry descriptors masked. */
function toJson(value: unknown, shape: Shape): JsonValue {
  if (value === null || omitted(value)) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint')
    throw new Error('Index value is not plain JSON data');
  if (Array.isArray(value)) {
    const element = elementShape(shape);
    return value.map((item: unknown) => toJson(item, element));
  }
  if (!isPlainObject(value))
    throw new Error('Index value is not plain JSON data');
  const result: { [key: string]: JsonValue } = {};
  for (const key of jsonKeys(value))
    define(
      result,
      key,
      masked(shape, key) ? null : toJson(value[key], childShape(shape, key)),
    );
  return result;
}

function jsonNumberText(value: number): string {
  return Number.isFinite(value) ? JSON.stringify(value) : 'null';
}

function equalArrays(a: unknown[], b: unknown[], shape: Shape): boolean {
  if (a.length !== b.length) return false;
  const element = elementShape(shape);
  for (let index = 0; index < a.length; index += 1)
    if (!jsonEqual(a[index], b[index], element)) return false;
  return true;
}

function equalObjects(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  shape: Shape,
): boolean {
  const keys = jsonKeys(a);
  const other = jsonKeys(b);
  if (keys.length !== other.length) return false;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key !== other[index]) return false;
    if (masked(shape, key)) continue;
    if (!jsonEqual(a[key], b[key], childShape(shape, key))) return false;
  }
  return true;
}

/** Whether two values serialize identically, ignoring masked descriptors. */
function jsonEqual(a: unknown, b: unknown, shape: Shape): boolean {
  if (a === b) return true;
  const aNull = a === null || omitted(a);
  const bNull = b === null || omitted(b);
  if (aNull || bNull) {
    if (typeof a === 'number') return bNull && !Number.isFinite(a);
    if (typeof b === 'number') return aNull && !Number.isFinite(b);
    return aNull && bNull;
  }
  if (typeof a === 'number' && typeof b === 'number')
    return jsonNumberText(a) === jsonNumberText(b);
  if (Array.isArray(a)) return Array.isArray(b) && equalArrays(a, b, shape);
  if (Array.isArray(b)) return false;
  if (isPlainObject(a) && isPlainObject(b)) return equalObjects(a, b, shape);
  return false;
}

function identity(shape: Shape, value: unknown): string {
  if (shape === 'entry' && isRecord(value) && typeof value.id === 'string')
    return `i${value.id}`;
  if (
    shape === 'archived-entry' &&
    isRecord(value) &&
    isRecord(value.tab) &&
    typeof value.tab.id === 'string'
  )
    return `i${value.tab.id}`;
  if (typeof value === 'string') return `s${value}`;
  return `j${JSON.stringify(toJson(value, shape))}`;
}

function diffArray(
  previous: unknown[],
  next: unknown[],
  shape: Shape,
): ValuePatch {
  const element = elementShape(shape);
  const byIdentity = new Map<string, number[]>();
  previous.forEach((value, index) => {
    const key = identity(element, value);
    const list = byIdentity.get(key);
    if (list) list.push(index);
    else byIdentity.set(key, [index]);
  });
  const cursor = new Map<string, number>();
  const segments: ArraySegment[] = [];
  const copy = (index: number): void => {
    const last = segments[segments.length - 1];
    if (last && 'k' in last && last.k[0] + last.k[1] === index) last.k[1] += 1;
    else segments.push({ k: [index, 1] });
  };
  for (const value of next) {
    const key = identity(element, value);
    const list = byIdentity.get(key);
    const position = cursor.get(key) ?? 0;
    if (!list || position >= list.length) {
      segments.push({ v: toJson(value, element) });
      continue;
    }
    cursor.set(key, position + 1);
    const index = list[position];
    const patch = diffValue(previous[index], value, element);
    if (patch === undefined) copy(index);
    else segments.push({ p: [index, patch] });
  }
  return { a: segments };
}

function naturalKeyOrder(
  previousKeys: readonly string[],
  deleted: ReadonlySet<string>,
  changes: { [key: string]: ValuePatch },
): string[] {
  const probe = {};
  const previous = new Set(previousKeys);
  for (const key of previousKeys) if (!deleted.has(key)) define(probe, key, 0);
  for (const key of Object.keys(changes))
    if (!previous.has(key)) define(probe, key, 0);
  return Object.keys(probe);
}

function diffObject(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  shape: Shape,
): ValuePatch | undefined {
  const previousKeys = jsonKeys(previous);
  const nextKeys = jsonKeys(next);
  const previousSet = new Set(previousKeys);
  const nextSet = new Set(nextKeys);
  const changes: { [key: string]: ValuePatch } = {};
  for (const key of nextKeys) {
    if (!previousSet.has(key)) {
      define(changes, key, {
        s: masked(shape, key)
          ? null
          : toJson(next[key], childShape(shape, key)),
      });
      continue;
    }
    if (masked(shape, key)) continue;
    const patch = diffValue(previous[key], next[key], childShape(shape, key));
    if (patch !== undefined) define(changes, key, patch);
  }
  const deleted = previousKeys.filter((key) => !nextSet.has(key));
  const natural = naturalKeyOrder(previousKeys, new Set(deleted), changes);
  if (
    natural.length === nextKeys.length &&
    natural.every((key, index) => key === nextKeys[index])
  ) {
    if (Object.keys(changes).length === 0 && deleted.length === 0)
      return undefined;
    return deleted.length ? { c: changes, d: deleted } : { c: changes };
  }
  return { o: nextKeys, c: changes };
}

function diffValue(
  previous: unknown,
  next: unknown,
  shape: Shape,
): ValuePatch | undefined {
  if (jsonEqual(previous, next, shape)) return undefined;
  if (Array.isArray(previous) && Array.isArray(next))
    return diffArray(previous, next, shape);
  if (
    !Array.isArray(previous) &&
    !Array.isArray(next) &&
    isPlainObject(previous) &&
    isPlainObject(next)
  )
    return diffObject(previous, next, shape);
  return { s: toJson(next, shape) };
}

/** The change from `previous` to `next`; descriptors are never recorded. */
export function diffChatIndexes(
  previous: DescribedIndexes,
  next: DescribedIndexes,
): IndexDelta {
  const delta: IndexDelta = {};
  const live = diffValue(previous.live, next.live, 'live');
  const archive = diffValue(previous.archive, next.archive, 'archive');
  const recovery = diffValue(previous.recovery, next.recovery, 'any');
  if (live) delta.live = live;
  if (archive) delta.archive = archive;
  if (recovery) delta.recovery = recovery;
  return delta;
}

function mismatch(): never {
  throw new IndexDeltaMismatchError(
    'Delta journal record does not apply to the indexes it follows',
  );
}

function applyArray(previous: unknown, segments: ArraySegment[]): unknown[] {
  if (!Array.isArray(previous)) return mismatch();
  const result: unknown[] = [];
  for (const segment of segments) {
    if ('v' in segment) result.push(segment.v);
    else if ('k' in segment) {
      const [start, count] = segment.k;
      if (start < 0 || count < 1 || start + count > previous.length) mismatch();
      for (let index = start; index < start + count; index += 1)
        result.push(previous[index]);
    } else {
      const [index, patch] = segment.p;
      if (index < 0 || index >= previous.length) mismatch();
      result.push(applyValue(previous[index], patch));
    }
  }
  return result;
}

function applyObject(
  previous: unknown,
  changes: { [key: string]: ValuePatch },
  order: string[] | undefined,
  deleted: readonly string[],
): Record<string, unknown> {
  if (!isRecord(previous) || Array.isArray(previous)) return mismatch();
  const result: Record<string, unknown> = {};
  const previousKeys = jsonKeys(previous);
  const present = new Set(previousKeys);
  const value = (key: string): unknown =>
    hasOwn(changes, key)
      ? applyValue(present.has(key) ? previous[key] : undefined, changes[key])
      : present.has(key)
        ? previous[key]
        : mismatch();
  if (order) {
    for (const key of order) define(result, key, value(key));
    return result;
  }
  const removed = new Set(deleted);
  for (const key of previousKeys)
    if (!removed.has(key)) define(result, key, value(key));
  for (const key of Object.keys(changes))
    if (!present.has(key)) define(result, key, value(key));
  return result;
}

function applyValue(previous: unknown, patch: ValuePatch): unknown {
  if ('s' in patch) return patch.s;
  if ('a' in patch) return applyArray(previous, patch.a);
  if ('o' in patch) return applyObject(previous, patch.c, patch.o, []);
  return applyObject(previous, patch.c, undefined, patch.d ?? []);
}

/**
 * Apply a delta. The result shares unchanged values with `previous`, which is
 * never modified. Entries the delta inserted carry a `null` descriptor until
 * {@link restoreTranscriptDescriptors} runs.
 */
export function applyChatIndexDelta(
  previous: DescribedIndexes,
  delta: IndexDelta,
): { live: unknown; archive: unknown; recovery: unknown } {
  return {
    live: delta.live ? applyValue(previous.live, delta.live) : previous.live,
    archive: delta.archive
      ? applyValue(previous.archive, delta.archive)
      : previous.archive,
    recovery: delta.recovery
      ? applyValue(previous.recovery, delta.recovery)
      : previous.recovery,
  };
}

function withDescriptor(
  entry: unknown,
  descriptors: ReadonlyMap<string, TranscriptDescriptor>,
): unknown {
  if (!isRecord(entry) || entry.transcript !== null) return entry;
  const id = typeof entry.id === 'string' ? entry.id : '';
  return {
    ...entry,
    transcript: descriptors.get(id) ?? { ...EMPTY_DESCRIPTOR },
  };
}

/**
 * Give every inserted entry (descriptor `null`) the descriptor its chat had
 * in `previous`, or an empty one for a new chat, keeping key positions.
 */
export function restoreTranscriptDescriptors(
  applied: { live: unknown; archive: unknown; recovery: unknown },
  previous: DescribedIndexes,
): { live: unknown; archive: unknown; recovery: unknown } {
  const descriptors = new Map<string, TranscriptDescriptor>();
  for (const tab of previous.live.tabs) descriptors.set(tab.id, tab.transcript);
  for (const entry of previous.archive.archived)
    descriptors.set(entry.tab.id, entry.tab.transcript);
  const live = applied.live;
  const archive = applied.archive;
  return {
    live:
      isRecord(live) && Array.isArray(live.tabs)
        ? {
            ...live,
            tabs: live.tabs.map((tab: unknown) =>
              withDescriptor(tab, descriptors),
            ),
          }
        : live,
    archive:
      isRecord(archive) && Array.isArray(archive.archived)
        ? {
            ...archive,
            archived: archive.archived.map((entry: unknown) =>
              isRecord(entry)
                ? { ...entry, tab: withDescriptor(entry.tab, descriptors) }
                : entry,
            ),
          }
        : archive,
    recovery: applied.recovery,
  };
}

function isArraySegment(value: unknown, depth: number): boolean {
  if (!isRecord(value)) return false;
  if ('v' in value) return Object.keys(value).length === 1;
  if ('k' in value)
    return (
      Array.isArray(value.k) &&
      value.k.length === 2 &&
      value.k.every((item: unknown) => Number.isSafeInteger(item))
    );
  return (
    Array.isArray(value.p) &&
    value.p.length === 2 &&
    Number.isSafeInteger(value.p[0]) &&
    isValuePatch(value.p[1], depth + 1)
  );
}

function isPatchMap(value: unknown, depth: number): boolean {
  return (
    isRecord(value) &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => isValuePatch(value[key], depth + 1))
  );
}

function isValuePatch(value: unknown, depth: number): value is ValuePatch {
  if (depth > MAX_PATCH_DEPTH || !isRecord(value) || Array.isArray(value))
    return false;
  if ('s' in value) return Object.keys(value).length === 1;
  if ('a' in value)
    return (
      Array.isArray(value.a) &&
      value.a.every((segment: unknown) => isArraySegment(segment, depth))
    );
  if ('o' in value)
    return (
      Array.isArray(value.o) &&
      value.o.every((key: unknown) => typeof key === 'string') &&
      isPatchMap(value.c, depth)
    );
  return (
    isPatchMap(value.c, depth) &&
    (value.d === undefined ||
      (Array.isArray(value.d) &&
        value.d.every((key: unknown) => typeof key === 'string')))
  );
}

export function isIndexDelta(value: unknown): value is IndexDelta {
  return (
    isRecord(value) &&
    !Array.isArray(value) &&
    Object.keys(value).every(
      (key) =>
        (key === 'live' || key === 'archive' || key === 'recovery') &&
        isValuePatch(value[key], 0),
    )
  );
}
