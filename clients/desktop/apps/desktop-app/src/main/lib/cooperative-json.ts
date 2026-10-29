import { open } from 'node:fs/promises';
import {
  recordChatStorageFileSync,
  recordChatStorageFileWrite,
} from '@canopy/desktop-shared/node/work-counters';

/** Explicit adapter for the desktop ES5 compilation target. It keeps sync
 * iterables lazy and closes upstream generators when consumers stop early.
 */
export async function* iterateAsync<T>(
  values: Iterable<T> | AsyncIterable<T>,
): AsyncGenerator<T> {
  const iterator =
    Symbol.asyncIterator in values
      ? values[Symbol.asyncIterator]()
      : values[Symbol.iterator]();
  let finished = false;
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        finished = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!finished) await iterator.return?.();
  }
}

const JSON_WRITE_CHUNK_CHARS = 256 * 1024;
const JSON_STRING_CHUNK_CHARS = 16 * 1024;
const JSON_YIELD_CHARS = 16 * 1024;

type JsonWriteFrame =
  | {
      kind: 'value';
      value: unknown;
      depth: number;
      arrayElement: boolean;
      key: string;
      resolved?: boolean;
    }
  | {
      kind: 'array';
      value: unknown[];
      depth: number;
      index: number;
    }
  | {
      kind: 'object';
      value: object;
      depth: number;
      keys: string[];
      index: number;
      wroteProperty: boolean;
    };

type WriteBufferChunk = (
  buffer: Buffer,
  offset: number,
  length: number,
) => Promise<number>;

export async function writeBufferFully(
  buffer: Buffer,
  writeChunk: WriteBufferChunk,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const bytesWritten = await writeChunk(
      buffer,
      offset,
      buffer.byteLength - offset,
    );
    if (bytesWritten === 0) {
      throw new Error('Unable to make progress writing chat tabs');
    }
    offset += bytesWritten;
  }
}

function resolveJsonValue(value: unknown, key: string): unknown {
  if (value !== null && typeof value === 'object') {
    const toJSON: unknown = Reflect.get(value, 'toJSON');
    if (typeof toJSON === 'function') return toJSON.call(value, key);
  }
  return value;
}

function serializeJsonPrimitive(
  value: unknown,
  arrayElement: boolean,
): string | null {
  if (
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  ) {
    return arrayElement ? 'null' : null;
  }
  if (typeof value === 'bigint') {
    throw new TypeError('Do not know how to serialize a BigInt');
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  return null;
}

/**
 * A value whose serialized form is at most about this many characters is
 * written with one native `JSON.stringify` call. Escaping can expand a string
 * up to six times, so one call stays bounded at a few hundred KB of output,
 * well under a millisecond; larger values keep the yielding walker.
 */
export const NATIVE_JSON_MAX_CHARS = 64 * 1024;
/** Deeper values take the walker, which has no recursion limit. */
const NATIVE_JSON_MAX_DEPTH = 64;
/** The longest JSON form of a number, as in `-2.2250738585072014e-308`. */
const NUMBER_JSON_CHARS = 24;

/**
 * Whether `value` is plain JSON data whose serialized form fits `maxChars`:
 * strings, numbers, booleans, `null`, `undefined` and symbols, in arrays and
 * in objects with the `Object` or `null` prototype, none with a `toJSON`.
 * Only for those does native `JSON.stringify` write exactly the bytes of the
 * walker below; for example it unwraps a boxed `Number`, which the walker
 * writes as `{}`. The walk stops as soon as the budget or the depth limit is
 * exceeded, so it costs at most about `maxChars` of work, and a cycle ends at
 * the depth limit. Enumerable getters are read here and again when
 * serializing, as they are by any two serializations.
 */
function isSmallPlainJsonValue(
  value: unknown,
  pretty: boolean,
  maxChars: number,
): boolean {
  let budget = maxChars;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const current = frame.value;
    // Pretty output adds a newline and indentation before each member.
    if (pretty) budget -= 2 * frame.depth + 1;
    if (typeof current === 'string') {
      budget -= current.length + 2;
    } else if (typeof current === 'number') {
      budget -= NUMBER_JSON_CHARS;
    } else if (
      current === null ||
      current === undefined ||
      typeof current === 'boolean' ||
      typeof current === 'symbol'
    ) {
      budget -= 5;
    } else if (typeof current !== 'object') {
      // Functions can carry `toJSON`; BigInt can inherit one.
      return false;
    } else {
      if (frame.depth >= NATIVE_JSON_MAX_DEPTH) return false;
      if (typeof Reflect.get(current, 'toJSON') === 'function') return false;
      const depth = frame.depth + 1;
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) return false;
        budget -= 2 + current.length;
        if (budget < 0) return false;
        for (let index = current.length - 1; index >= 0; index -= 1) {
          const element: unknown = current[index];
          stack.push({ value: element, depth });
        }
      } else {
        const prototype: unknown = Object.getPrototypeOf(current);
        if (prototype !== Object.prototype && prototype !== null) return false;
        budget -= 2;
        for (const key of Object.keys(current)) {
          budget -= key.length + 4;
          if (budget < 0) return false;
          stack.push({ value: Reflect.get(current, key), depth });
        }
      }
    }
    if (budget < 0) return false;
  }
  return true;
}

/**
 * The native serialization of a small plain value, exactly as the cooperative
 * walker would write it, or `undefined` when the value must take the walker.
 * A top-level value JSON cannot represent writes nothing, as in the walker.
 */
export function nativeJsonText(
  value: unknown,
  pretty: boolean,
  maxChars = NATIVE_JSON_MAX_CHARS,
): string | undefined {
  if (maxChars <= 0 || !isSmallPlainJsonValue(value, pretty, maxChars))
    return undefined;
  if (value === undefined || typeof value === 'symbol') return '';
  return JSON.stringify(value, null, pretty ? 2 : undefined);
}

export interface CooperativeJsonWriteOptions {
  pretty: boolean;
  separator?: string;
  trailingSeparator?: boolean;
  append?: boolean;
  shouldAbort?: () => boolean;
  /**
   * Overrides {@link NATIVE_JSON_MAX_CHARS}. `0` writes every value with the
   * walker; tests use it to compare both paths.
   */
  nativeMaxChars?: number;
}

export class CooperativeJsonWriteAbortedError extends Error {
  public override readonly name = 'CooperativeJsonWriteAbortedError';
}

export function isCooperativeJsonWriteAbortedError(
  error: unknown,
): error is CooperativeJsonWriteAbortedError {
  return (
    error instanceof CooperativeJsonWriteAbortedError ||
    (error instanceof Error &&
      error.name === 'CooperativeJsonWriteAbortedError')
  );
}

/**
 * Serialize one or more JSON values without letting a large transcript keep
 * Electron main on one synchronous `JSON.stringify()` call. Compact mode is
 * suitable for JSONL because each value remains on exactly one logical line.
 */
export async function writeJsonValuesCooperatively(
  filePath: string,
  values: Iterable<unknown> | AsyncIterable<unknown>,
  options: CooperativeJsonWriteOptions,
): Promise<number> {
  const handle = await open(filePath, options.append ? 'a' : 'w');
  let buffer = '';
  let bytesWritten = 0;
  let charsSinceYield = 0;

  const throwIfAborted = (): void => {
    if (options.shouldAbort?.()) {
      throw new CooperativeJsonWriteAbortedError(
        'Cooperative JSON write was preempted',
      );
    }
  };
  const append = (text: string): void => {
    buffer += text;
    charsSinceYield += text.length;
  };
  const yieldIfNeeded = async (): Promise<void> => {
    if (charsSinceYield < JSON_YIELD_CHARS) return;
    throwIfAborted();
    await new Promise<void>((resolve) => setImmediate(resolve));
    throwIfAborted();
    charsSinceYield = 0;
  };
  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    throwIfAborted();
    const pending = Buffer.from(buffer);
    buffer = '';
    await writeBufferFully(
      pending,
      async (chunk, offset, length): Promise<number> => {
        const { bytesWritten } = await handle.write(chunk, offset, length);
        return bytesWritten;
      },
    );
    bytesWritten += pending.byteLength;
  };
  const appendLargeJsonString = async (text: string): Promise<void> => {
    append('"');
    let offset = 0;
    while (offset < text.length) {
      let end = Math.min(offset + JSON_STRING_CHUNK_CHARS, text.length);
      const finalCodeUnit = text.charCodeAt(end - 1);
      const nextCodeUnit = text.charCodeAt(end);
      if (
        end < text.length &&
        finalCodeUnit >= 0xd800 &&
        finalCodeUnit <= 0xdbff &&
        nextCodeUnit >= 0xdc00 &&
        nextCodeUnit <= 0xdfff
      ) {
        end += 1;
      }
      const serializedChunk = JSON.stringify(text.slice(offset, end));
      append(serializedChunk.slice(1, -1));
      offset = end;
      if (buffer.length >= JSON_WRITE_CHUNK_CHARS) {
        await flush();
        charsSinceYield = 0;
      } else {
        await yieldIfNeeded();
      }
    }
    append('"');
  };

  try {
    throwIfAborted();
    let valueIndex = 0;
    for await (const value of iterateAsync(values)) {
      if (valueIndex > 0) append(options.separator ?? '');
      const native = nativeJsonText(
        value,
        options.pretty,
        options.nativeMaxChars ?? NATIVE_JSON_MAX_CHARS,
      );
      if (native !== undefined) {
        // Same buffering, yielding and abort checks as the walker's frames.
        append(native);
        if (buffer.length >= JSON_WRITE_CHUNK_CHARS) {
          await flush();
          charsSinceYield = 0;
        } else {
          await yieldIfNeeded();
        }
        valueIndex += 1;
        continue;
      }
      const stack: JsonWriteFrame[] = [
        {
          kind: 'value',
          value,
          depth: 0,
          arrayElement: false,
          key: '',
        },
      ];
      const ancestors = new Set<object>();

      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (frame.kind === 'value') {
          stack.pop();
          const resolved = frame.resolved
            ? frame.value
            : resolveJsonValue(frame.value, frame.key);
          if (typeof resolved === 'string') {
            if (resolved.length <= JSON_STRING_CHUNK_CHARS) {
              append(JSON.stringify(resolved));
            } else {
              await appendLargeJsonString(resolved);
            }
          } else {
            const primitive = serializeJsonPrimitive(
              resolved,
              frame.arrayElement,
            );
            if (primitive !== null) {
              append(primitive);
            } else if (Array.isArray(resolved)) {
              if (ancestors.has(resolved)) {
                throw new TypeError('Converting circular structure to JSON');
              }
              ancestors.add(resolved);
              append('[');
              stack.push({
                kind: 'array',
                value: resolved,
                depth: frame.depth,
                index: 0,
              });
            } else if (resolved !== null && typeof resolved === 'object') {
              if (ancestors.has(resolved)) {
                throw new TypeError('Converting circular structure to JSON');
              }
              ancestors.add(resolved);
              append('{');
              stack.push({
                kind: 'object',
                value: resolved,
                depth: frame.depth,
                keys: Object.keys(resolved),
                index: 0,
                wroteProperty: false,
              });
            }
          }
        } else if (frame.kind === 'array') {
          if (frame.index >= frame.value.length) {
            if (options.pretty && frame.value.length > 0) {
              append(`\n${'  '.repeat(frame.depth)}`);
            }
            append(']');
            ancestors.delete(frame.value);
            stack.pop();
          } else {
            const index = frame.index++;
            append(
              options.pretty
                ? index === 0
                  ? '\n'
                  : ',\n'
                : index === 0
                  ? ''
                  : ',',
            );
            if (options.pretty) append('  '.repeat(frame.depth + 1));
            stack.push({
              kind: 'value',
              value: resolveJsonValue(frame.value[index], String(index)),
              depth: frame.depth + 1,
              arrayElement: true,
              key: String(index),
              resolved: true,
            });
          }
        } else {
          let key: string | undefined;
          let child: unknown;
          while (frame.index < frame.keys.length) {
            const candidate = frame.keys[frame.index++];
            const candidateValue: unknown = Reflect.get(frame.value, candidate);
            const resolved = resolveJsonValue(candidateValue, candidate);
            if (
              resolved !== undefined &&
              typeof resolved !== 'function' &&
              typeof resolved !== 'symbol'
            ) {
              key = candidate;
              child = resolved;
              break;
            }
          }
          if (key === undefined) {
            if (options.pretty && frame.wroteProperty) {
              append(`\n${'  '.repeat(frame.depth)}`);
            }
            append('}');
            ancestors.delete(frame.value);
            stack.pop();
          } else {
            append(
              options.pretty
                ? frame.wroteProperty
                  ? ',\n'
                  : '\n'
                : frame.wroteProperty
                  ? ','
                  : '',
            );
            frame.wroteProperty = true;
            if (options.pretty) append('  '.repeat(frame.depth + 1));
            if (key.length <= JSON_STRING_CHUNK_CHARS) {
              append(JSON.stringify(key));
            } else {
              await appendLargeJsonString(key);
            }
            append(options.pretty ? ': ' : ':');
            stack.push({
              kind: 'value',
              value: child,
              depth: frame.depth + 1,
              arrayElement: false,
              key,
              resolved: true,
            });
          }
        }

        if (buffer.length >= JSON_WRITE_CHUNK_CHARS) {
          await flush();
          charsSinceYield = 0;
        } else {
          await yieldIfNeeded();
        }
      }
      valueIndex += 1;
    }
    if (options.trailingSeparator && valueIndex > 0) {
      append(options.separator ?? '');
    }
    await flush();
    await handle.sync();
    // Work counters: a no-op unless the file belongs to chat storage.
    recordChatStorageFileWrite(filePath, bytesWritten, true);
    recordChatStorageFileSync(filePath);
  } finally {
    await handle.close();
  }
  return bytesWritten;
}
