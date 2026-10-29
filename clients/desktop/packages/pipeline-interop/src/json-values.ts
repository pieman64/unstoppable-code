import type { PipelineJsonValue, PipelineInputValue } from './document';

const MAX_JSON_CONTAINER_DEPTH = 256;
const MAX_JSON_CONTAINERS = 10_000;
const MAX_JSON_ENTRIES = 100_000;

interface JsonValueEnterFrame {
  kind: 'enter';
  value: unknown;
  containerDepth: number;
}

interface JsonValueExitFrame {
  kind: 'exit';
  value: object;
}

type JsonValueFrame = JsonValueEnterFrame | JsonValueExitFrame;

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype === null) {
    return true;
  }
  return (
    typeof prototype === 'object' && Object.getPrototypeOf(prototype) === null
  );
}

function snapshotJsonChildren(value: object): unknown[] | undefined {
  try {
    if (Array.isArray(value)) {
      const children: unknown[] = [];
      value.forEach((entry) => children.push(entry));
      return children;
    }
    if (!isPlainObject(value)) {
      return undefined;
    }
    const children: unknown[] = [];
    for (const key of Object.keys(value)) {
      const child: unknown = Reflect.get(value, key);
      children.push(child);
    }
    return children;
  } catch {
    return undefined;
  }
}

function isJsonPrimitive(value: unknown): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  return false;
}

function isJsonSafeValueInternal(value: unknown): value is PipelineJsonValue {
  const active = new Set<object>();
  const completed = new Set<object>();
  const stack: JsonValueFrame[] = [{ kind: 'enter', value, containerDepth: 0 }];
  let containerCount = 0;
  let entryCount = 0;

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) {
      continue;
    }
    if (frame.kind === 'exit') {
      active.delete(frame.value);
      completed.add(frame.value);
      continue;
    }
    if (isJsonPrimitive(frame.value)) {
      continue;
    }
    if (typeof frame.value !== 'object' || frame.value === null) {
      return false;
    }

    // Active-path detection must win over completed-node reuse so aliases can
    // never hide a cycle. Completed nodes are otherwise safe to skip globally.
    if (active.has(frame.value)) {
      return false;
    }
    if (completed.has(frame.value)) {
      continue;
    }

    const containerDepth = frame.containerDepth + 1;
    if (containerDepth > MAX_JSON_CONTAINER_DEPTH) {
      return false;
    }
    containerCount += 1;
    if (containerCount > MAX_JSON_CONTAINERS) {
      return false;
    }

    // Snapshot each unique container once. Besides bounding alias traversal,
    // this prevents enumerable accessors from being re-read per incoming edge.
    const children = snapshotJsonChildren(frame.value);
    if (!children) {
      return false;
    }
    entryCount += children.length;
    if (entryCount > MAX_JSON_ENTRIES) {
      return false;
    }

    active.add(frame.value);
    stack.push({ kind: 'exit', value: frame.value });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({
        kind: 'enter',
        value: children[index],
        containerDepth,
      });
    }
  }

  return true;
}

export function isPipelineJsonValue(
  value: unknown,
): value is PipelineJsonValue {
  return isJsonSafeValueInternal(value);
}

export function isPipelineInputValue(
  value: unknown,
): value is PipelineInputValue {
  return isPipelineJsonValue(value);
}

export function assertPipelineJsonValue(
  value: unknown,
  location: string,
): asserts value is PipelineJsonValue {
  if (!isPipelineJsonValue(value)) {
    throw new Error(`${location} must be a JSON-safe value`);
  }
}
