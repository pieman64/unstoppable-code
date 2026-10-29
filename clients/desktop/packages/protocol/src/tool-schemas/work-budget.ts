import type { JsonSchemaValue } from './index';

/**
 * The most work units one tool schema conversion may spend, whatever its
 * size. Tool schemas arrive in requests, so a converter's work must not grow
 * with how cleverly a schema repeats itself, and a single schema must not be
 * able to stall the process for long.
 */
export const MAX_TOOL_SCHEMA_WORK = 100_000;

/**
 * Work shared by every tool schema converted for one request, so a request
 * carrying many schemas is bounded as a whole. A conversion that runs out
 * returns its input unchanged; the conversions after it see what is left.
 */
export class ToolSchemaWorkBudget {
  private remaining: number;

  constructor(units: number) {
    this.remaining = Math.max(0, Math.floor(units));
  }

  get remainingUnits(): number {
    return this.remaining;
  }

  consume(units: number): void {
    this.remaining = Math.max(0, this.remaining - Math.max(0, units));
  }
}

/** The work one conversion may spend: its own allowance within the shared one. */
export function toolSchemaWorkLimit(
  allowance: number,
  shared: ToolSchemaWorkBudget | undefined,
): number {
  return Math.min(
    allowance,
    MAX_TOOL_SCHEMA_WORK,
    shared?.remainingUnits ?? Number.POSITIVE_INFINITY,
  );
}

/**
 * The deepest nesting, in JSON objects and arrays, a tool schema or a value
 * checked against one may have. Converters recurse once per level, so deeper
 * input is returned unchanged instead of risking the call stack. The desktop
 * Codex tool set nests at most 12 levels.
 */
export const MAX_TOOL_SCHEMA_DEPTH = 256;

export interface JsonShape {
  /** JSON nodes, counting a shared object or array once. */
  nodes: number;
  /** Deepest object or array nesting; a primitive is depth 0. */
  depth: number;
  /** Characters of its strings and object keys, counted the same way. */
  chars: number;
}

/** Measure a value without recursion, so any depth is safe to measure. */
export function measureJson(value: JsonSchemaValue): JsonShape {
  const seen = new Set<object>();
  const pending: [JsonSchemaValue, number][] = [[value, 0]];
  let nodes = 0;
  let depth = 0;
  let chars = 0;
  for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
    const [node, level] = entry;
    nodes += 1;
    if (typeof node === 'string') chars += node.length;
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    depth = Math.max(depth, level + 1);
    if (Array.isArray(node)) {
      for (const child of node) pending.push([child, level + 1]);
      continue;
    }
    for (const [key, child] of Object.entries(node)) {
      if (child === undefined) continue;
      chars += key.length;
      pending.push([child, level + 1]);
    }
  }
  return { nodes, depth, chars };
}

/**
 * The work units a measured value is worth: one per node plus one per
 * `CHARS_PER_WORK_UNIT` characters, the same rate `copyCost` charges.
 */
export function jsonWorkUnits(shape: JsonShape): number {
  return shape.nodes + Math.ceil(shape.chars / CHARS_PER_WORK_UNIT);
}

/** JSON nodes in a value, counting a shared object or array once. */
export function countJsonNodes(value: JsonSchemaValue): number {
  return measureJson(value).nodes;
}

/** Characters of strings and keys one work unit pays for when copying. */
export const CHARS_PER_WORK_UNIT = 64;

/**
 * The work to emit a copy of a value: one unit per node, plus one per
 * `CHARS_PER_WORK_UNIT` characters of its strings and keys, so a long string
 * repeated in the output costs in proportion to its length. Counts a shared
 * object at every place it appears, and stops counting past `limit`.
 */
export function copyCost(value: JsonSchemaValue, limit: number): number {
  const pending: JsonSchemaValue[] = [value];
  let nodes = 0;
  let chars = 0;
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    nodes += 1;
    if (typeof node === 'string') chars += node.length;
    if (nodes + Math.ceil(chars / CHARS_PER_WORK_UNIT) > limit) break;
    if (node === null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const child of node) pending.push(child);
      continue;
    }
    for (const [key, child] of Object.entries(node)) {
      if (child === undefined) continue;
      chars += key.length;
      pending.push(child);
    }
  }
  return nodes + Math.ceil(chars / CHARS_PER_WORK_UNIT);
}
