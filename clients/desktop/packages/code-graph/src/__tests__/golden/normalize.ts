import { realpathSync } from 'node:fs';

export interface GoldenNormalizerOptions {
  /** Absolute paths to replace with a stable token, e.g. `<fixture>`. */
  paths?: ReadonlyArray<readonly [absolutePath: string, token: string]>;
  /** Keys whose numeric (or digit-string) values are times or durations. */
  volatileNumberKeys?: ReadonlySet<string>;
  /** Keys whose whole subtree holds timings: every number below them. */
  volatileTreeKeys?: ReadonlySet<string>;
  /** Extra text substitutions, applied after path replacement. */
  text?: ReadonlyArray<readonly [pattern: RegExp, replacement: string]>;
}

function pathVariants(absolutePath: string): string[] {
  const variants = new Set([absolutePath]);
  try {
    variants.add(realpathSync(absolutePath));
  } catch {
    // A path that does not exist yet still normalizes by its given spelling.
  }
  for (const variant of Array.from(variants)) {
    variants.add(variant.replace(/\\/g, '/'));
  }
  return Array.from(variants).sort((left, right) => right.length - left.length);
}

/**
 * Replaces run-specific paths, times and durations, and nothing else: a null
 * stays null, and every other value is compared exactly.
 */
export function createGoldenNormalizer(
  options: GoldenNormalizerOptions,
): (value: unknown) => unknown {
  const replacements = (options.paths ?? []).flatMap(([absolutePath, token]) =>
    pathVariants(absolutePath).map((variant) => [variant, token] as const),
  );
  replacements.sort((left, right) => right[0].length - left[0].length);
  const volatile = options.volatileNumberKeys ?? new Set<string>();
  const volatileTrees = options.volatileTreeKeys ?? new Set<string>();
  const textRules = options.text ?? [];

  const normalizeString = (value: string): string => {
    let result = value;
    for (const [variant, token] of replacements) {
      result = result.split(variant).join(token);
    }
    for (const [pattern, replacement] of textRules) {
      result = result.replace(pattern, replacement);
    }
    return result;
  };

  const normalize = (
    value: unknown,
    key: string | undefined,
    tree: string | undefined,
  ): unknown => {
    if (
      typeof value === 'string' &&
      key !== undefined &&
      volatile.has(key) &&
      /^\d+$/.test(value)
    ) {
      return `<${key}>`;
    }
    if (typeof value === 'string') return normalizeString(value);
    if (typeof value === 'number') {
      if (tree !== undefined) return `<${tree}>`;
      return key !== undefined && volatile.has(key) ? `<${key}>` : value;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => normalize(entry, undefined, tree));
    }
    if (typeof value === 'object' && value !== null) {
      const result: Record<string, unknown> = {};
      for (const [entryKey, entry] of Object.entries(value)) {
        result[entryKey] = normalize(
          entry,
          entryKey,
          tree ?? (volatileTrees.has(entryKey) ? entryKey : undefined),
        );
      }
      return result;
    }
    return value;
  };

  return (value) => normalize(value, undefined, undefined);
}
