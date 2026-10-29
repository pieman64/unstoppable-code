import * as yaml from 'js-yaml';

const FRONTMATTER_RE = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?=\r?\n|$)/;
const UNSAFE_FRONTMATTER_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

function isFrontmatterRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

// Frontmatter is untrusted on public share surfaces, so traversal is budgeted
// in units that approximate serialized characters (strings and keys charge
// their length; other scalars and containers charge one unit). Repeated YAML
// aliases would otherwise amplify a compact document — via object fan-out or
// via re-referenced scalar collections — both here and in any later
// JSON.stringify of the result. 64K units keeps every legitimate metadata
// block intact while capping hostile output around that size.
const MAX_FRONTMATTER_BUDGET = 65_536;
const MAX_FRONTMATTER_DEPTH = 64;

function scalarCost(value: unknown): number {
  return typeof value === 'string' ? 1 + value.length : 1;
}

interface SanitizeState {
  /** Objects on the current traversal path — a hit means a true cycle. */
  inProgress: WeakSet<object>;
  /** Sanitized result plus its expanded node cost, per source object. */
  memo: WeakMap<object, { value: unknown; cost: number }>;
  /** Remaining expanded-output node budget across the whole document. */
  remaining: number;
}

function sanitizeFrontmatterValue(
  value: unknown,
  state: SanitizeState,
  depth: number,
): unknown {
  if (value === null || typeof value !== 'object') {
    if (value === undefined) return undefined;
    const cost = scalarCost(value);
    if (state.remaining < cost) return undefined;
    state.remaining -= cost;
    return value;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return undefined;
    const iso = value.toISOString();
    const cost = scalarCost(iso);
    if (state.remaining < cost) return undefined;
    state.remaining -= cost;
    return iso;
  }
  if (depth >= MAX_FRONTMATTER_DEPTH || state.remaining <= 0) return undefined;
  const memoized = state.memo.get(value);
  if (memoized) {
    // Re-referencing a sanitized subtree charges its full expanded size so
    // the total materialized output stays within the document budget.
    if (state.remaining < memoized.cost) return undefined;
    state.remaining -= memoized.cost;
    return memoized.value;
  }
  if (state.inProgress.has(value)) return undefined;
  state.inProgress.add(value);
  const remainingBefore = state.remaining;
  state.remaining -= 1;

  let result: unknown;
  if (Array.isArray(value)) {
    result = value
      .map((item) => sanitizeFrontmatterValue(item, state, depth + 1))
      .filter((item) => item !== undefined);
  } else if (!isFrontmatterRecord(value)) {
    result = undefined;
  } else {
    const sanitized: Record<string, unknown> = {};
    for (const [key, childValue] of Object.entries(value)) {
      if (UNSAFE_FRONTMATTER_KEYS.has(key)) continue;
      if (state.remaining < key.length) break;
      state.remaining -= key.length;
      const nextValue = sanitizeFrontmatterValue(childValue, state, depth + 1);
      if (nextValue !== undefined) {
        sanitized[key] = nextValue;
      }
    }
    result = sanitized;
  }
  state.inProgress.delete(value);
  state.memo.set(value, {
    value: result,
    cost: remainingBefore - state.remaining,
  });
  return result;
}

function sanitizeFrontmatterRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const state: SanitizeState = {
    inProgress: new WeakSet<object>(),
    memo: new WeakMap(),
    remaining: MAX_FRONTMATTER_BUDGET,
  };
  state.inProgress.add(value);

  const sanitized: Record<string, unknown> = {};
  for (const [key, childValue] of Object.entries(value)) {
    if (UNSAFE_FRONTMATTER_KEYS.has(key)) continue;
    if (state.remaining < key.length) break;
    state.remaining -= key.length;
    const nextValue = sanitizeFrontmatterValue(childValue, state, 1);
    if (nextValue !== undefined) {
      sanitized[key] = nextValue;
    }
  }
  return sanitized;
}

/**
 * Split a markdown string into its leading YAML frontmatter and the remaining
 * body. When no frontmatter fence is present the whole input is returned as the
 * body. When the fence is present but the YAML fails to parse, the fence is
 * still stripped and the frontmatter falls back to an empty object.
 *
 * Browser-safe mirror of `apps/desktop-app/src/main/lib/frontmatter.ts`; UI
 * surfaces cannot import main-process modules, so the logic is duplicated here.
 * Sanitization matters: parsed YAML can contain cyclic aliases (which would
 * throw in `JSON.stringify` during render) and prototype-sensitive keys.
 */
export function parseFrontmatterAndBody(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = raw.match(FRONTMATTER_RE);
  let frontmatter: Record<string, unknown> = {};
  let body = raw;

  if (match) {
    try {
      const parsed = yaml.load(match[1] ?? '');
      frontmatter = isFrontmatterRecord(parsed)
        ? sanitizeFrontmatterRecord(parsed)
        : {};
    } catch {
      // Keep the body-stripping behavior, but ignore malformed metadata.
    }
    body = raw.slice(match[0].length).replace(/^\r?\n/, '');
  }

  return { frontmatter, body };
}
