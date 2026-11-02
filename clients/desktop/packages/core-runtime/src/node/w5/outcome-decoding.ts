/*
 * Shared field decoders for W5 outcomes, matching the zod 4 schemas they
 * replaced: objects strip unknown keys and emit shape order, and an optional
 * key is kept, even as undefined, exactly when it is present in the input.
 */
import { isRecord } from './commit-log/is-record';

/** Names only the first invalid field, never its value. */
export class W5OutcomeDecodeError extends Error {
  constructor(readonly path: string) {
    super(
      `Invalid operation outcome at ${path === '' ? 'the top level' : path}.`,
    );
    this.name = 'W5OutcomeDecodeError';
  }
}

function fail(path: string): never {
  throw new W5OutcomeDecodeError(path);
}

export function at(path: string, key: string | number): string {
  return path === '' ? String(key) : `${path}.${String(key)}`;
}

export function object(value: unknown, path: string): Record<string, unknown> {
  return isRecord(value) ? value : fail(path);
}

export function text(value: unknown, path: string): string {
  return typeof value === 'string' ? value : fail(path);
}

export function flag(value: unknown, path: string): boolean {
  return typeof value === 'boolean' ? value : fail(path);
}

/** The replaced number schema refused NaN and infinities. */
export function finiteNumber(value: unknown, path: string): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : fail(path);
}

export function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
): T {
  const match = values.find((candidate) => candidate === value);
  return match === undefined ? fail(path) : match;
}

export function list<T>(
  value: unknown,
  path: string,
  decode: (item: unknown, path: string) => T,
): T[] {
  if (!Array.isArray(value)) return fail(path);
  const items: readonly unknown[] = value;
  const decoded: T[] = [];
  // Indexed, so a hole is read as undefined and refused like any bad item.
  for (let index = 0; index < items.length; index += 1) {
    decoded.push(decode(items[index], at(path, index)));
  }
  return decoded;
}

export function textList(value: unknown, path: string): string[] {
  return list(value, path, text);
}

/** The replaced record schema refused class instances and modified prototypes. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const constructor: unknown = value.constructor;
  if (typeof constructor !== 'function') return true;
  const prototype: unknown = Reflect.get(constructor, 'prototype');
  return (
    isRecord(prototype) &&
    Object.prototype.hasOwnProperty.call(prototype, 'isPrototypeOf')
  );
}

export function textRecord(
  value: unknown,
  path: string,
): Record<string, string> {
  if (!isPlainObject(value)) return fail(path);
  const decoded: Record<string, string> = {};
  // Own keys, including non-enumerable and symbol keys, as the replaced
  // schema read them; an own `__proto__` key is skipped.
  for (const key of Reflect.ownKeys(value)) {
    if (key === '__proto__') continue;
    if (typeof key !== 'string') return fail(path);
    decoded[key] = text(value[key], at(path, key));
  }
  return decoded;
}

/** Undefined is accepted; a present key is kept even when undefined. */
export function optional<T>(
  value: unknown,
  path: string,
  decode: (value: unknown, path: string) => T,
): T | undefined {
  return value === undefined ? undefined : decode(value, path);
}
