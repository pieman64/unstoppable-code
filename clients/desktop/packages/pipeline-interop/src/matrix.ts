import type {
  JobStrategy,
  NormalizedMatrixStrategy,
  PipelineJsonValue,
  PipelineMatrixCombination,
  PipelineMatrixDefinition,
} from './document';
import { assertPipelineJsonValue } from './json-values';

export const MAX_MATRIX_VARIANTS = 256;
export const MAX_MATRIX_AXES = MAX_MATRIX_VARIANTS;
export const MAX_MATRIX_FILTER_ENTRIES = MAX_MATRIX_VARIANTS;
export const MATRIX_JOB_ID_PREFIX = '__matrix__';
export const MATRIX_AXIS_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

type ReservedMatrixKey = 'include' | 'exclude';

function isReservedMatrixKey(key: string): key is ReservedMatrixKey {
  return key === 'include' || key === 'exclude';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isCompleteExpression(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith('${{') || !trimmed.endsWith('}}')) return false;
  const body = trimmed.slice(3, -2);
  return (
    body.trim().length > 0 && !body.includes('${{') && !body.includes('}}')
  );
}

function cloneJson<T extends PipelineJsonValue>(value: T): T {
  return structuredClone(value);
}

function jsonEqual(left: PipelineJsonValue, right: PipelineJsonValue): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => jsonEqual(entry, right[index]))
    );
  }
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  ) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        jsonEqual(left[key], right[key]),
    )
  );
}

function matchesPartial(
  combination: PipelineMatrixCombination,
  filter: PipelineMatrixCombination,
): boolean {
  return Object.entries(filter).every(
    ([key, value]) =>
      Object.prototype.hasOwnProperty.call(combination, key) &&
      jsonEqual(combination[key], value),
  );
}

function normalizeCombinationList(
  jobId: string,
  field: 'include' | 'exclude',
  value: unknown,
): PipelineMatrixCombination[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `Job "${jobId}" strategy.matrix.${field} must be an array of objects`,
    );
  }
  if (value.length > MAX_MATRIX_FILTER_ENTRIES) {
    throw new Error(
      `Job "${jobId}" strategy.matrix.${field} cannot contain more than ${String(MAX_MATRIX_FILTER_ENTRIES)} entries`,
    );
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(
        `Job "${jobId}" strategy.matrix.${field}[${String(index)}] must be an object`,
      );
    }
    assertPipelineJsonValue(
      entry,
      `Job "${jobId}" strategy.matrix.${field}[${String(index)}]`,
    );
    const combination: PipelineMatrixCombination = structuredClone(entry);
    return combination;
  });
}

function validateMatrixObject(
  jobId: string,
  value: unknown,
  allowExpressions: boolean,
): {
  definition: PipelineMatrixDefinition;
  dynamic: boolean;
} {
  if (typeof value === 'string') {
    if (!allowExpressions || !isCompleteExpression(value)) {
      throw new Error(
        `Job "${jobId}" strategy.matrix must be an object or one complete expression`,
      );
    }
    return { definition: value.trim(), dynamic: true };
  }
  if (!isRecord(value)) {
    throw new Error(`Job "${jobId}" strategy.matrix must be an object`);
  }

  let dynamic = false;
  const normalized: Exclude<PipelineMatrixDefinition, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (isReservedMatrixKey(key)) {
      if (typeof raw === 'string') {
        if (!allowExpressions || !isCompleteExpression(raw)) {
          throw new Error(
            `Job "${jobId}" strategy.matrix.${key} must be an array of objects or one complete expression`,
          );
        }
        dynamic = true;
        normalized[key] = raw.trim();
      } else {
        normalized[key] = normalizeCombinationList(jobId, key, raw);
      }
      continue;
    }
    if (!MATRIX_AXIS_IDENTIFIER.test(key)) {
      throw new Error(
        `Job "${jobId}" strategy.matrix axis "${key}" must start with a letter or underscore and contain only letters, digits, and underscores`,
      );
    }
    if (key === '__proto__') {
      throw new Error(
        `Job "${jobId}" strategy.matrix axis "__proto__" is reserved`,
      );
    }
    if (typeof raw === 'string') {
      if (!allowExpressions || !isCompleteExpression(raw)) {
        throw new Error(
          `Job "${jobId}" strategy.matrix.${key} must be an array or one complete expression`,
        );
      }
      dynamic = true;
      normalized[key] = raw.trim();
      continue;
    }
    if (!Array.isArray(raw)) {
      throw new Error(`Job "${jobId}" strategy.matrix.${key} must be an array`);
    }
    assertPipelineJsonValue(raw, `Job "${jobId}" strategy.matrix.${key}`);
    normalized[key] = structuredClone(raw);
  }

  return {
    definition: normalized,
    dynamic,
  };
}

export function normalizeMatrixStrategy(
  jobId: string,
  raw: JobStrategy | undefined,
): NormalizedMatrixStrategy | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    throw new Error(`Job "${jobId}" strategy must be an object`);
  }
  for (const key of Object.keys(raw)) {
    if (!['matrix', 'fail_fast', 'max_parallel'].includes(key)) {
      throw new Error(`Job "${jobId}" strategy has unexpected field "${key}"`);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'matrix')) {
    throw new Error(`Job "${jobId}" strategy.matrix is required`);
  }
  if (raw.fail_fast !== undefined && typeof raw.fail_fast !== 'boolean') {
    throw new Error(`Job "${jobId}" strategy.fail_fast must be a boolean`);
  }
  if (
    raw.max_parallel !== undefined &&
    (!Number.isSafeInteger(raw.max_parallel) ||
      raw.max_parallel < 1 ||
      raw.max_parallel > MAX_MATRIX_VARIANTS)
  ) {
    throw new Error(
      `Job "${jobId}" strategy.max_parallel must be an integer from 1 through ${String(MAX_MATRIX_VARIANTS)}`,
    );
  }
  const matrix = validateMatrixObject(jobId, raw.matrix, true);
  return {
    matrix: matrix.definition,
    fail_fast: raw.fail_fast ?? true,
    max_parallel: raw.max_parallel,
    dynamic: matrix.dynamic,
  };
}

export function resolveMatrixDefinition(
  jobId: string,
  value: unknown,
): PipelineMatrixDefinition {
  return validateMatrixObject(jobId, value, false).definition;
}

export function isDynamicMatrix(definition: PipelineMatrixDefinition): boolean {
  if (typeof definition === 'string') return true;
  return Object.values(definition).some(
    (value) => typeof value === 'string' && isCompleteExpression(value),
  );
}

export function expandStaticMatrix(
  jobId: string,
  strategy: Pick<NormalizedMatrixStrategy, 'matrix' | 'dynamic'>,
): PipelineMatrixCombination[] {
  if (strategy.dynamic || typeof strategy.matrix === 'string') {
    throw new Error(`Job "${jobId}" matrix is dynamic and cannot expand yet`);
  }
  const definition = strategy.matrix;
  const axisEntries = Object.entries(definition).filter(
    ([key]) => !isReservedMatrixKey(key),
  );
  if (axisEntries.length > MAX_MATRIX_AXES) {
    throw new Error(
      `Job "${jobId}" matrix defines more than ${String(MAX_MATRIX_AXES)} axes`,
    );
  }
  const axisNames = axisEntries.map(([key]) => key);

  let combinations: PipelineMatrixCombination[] =
    axisEntries.length === 0 ? [] : [{}];
  for (const [axis, rawValues] of axisEntries) {
    if (!Array.isArray(rawValues)) {
      throw new Error(
        `Job "${jobId}" strategy.matrix.${axis} must be an array`,
      );
    }
    if (
      rawValues.length > 0 &&
      combinations.length > Math.floor(MAX_MATRIX_VARIANTS / rawValues.length)
    ) {
      throw new Error(
        `Job "${jobId}" matrix generates more than ${String(MAX_MATRIX_VARIANTS)} variants`,
      );
    }
    combinations = combinations.flatMap((combination) =>
      rawValues.map((value) => ({
        ...combination,
        [axis]: cloneJson(value),
      })),
    );
    if (combinations.length > MAX_MATRIX_VARIANTS) {
      throw new Error(
        `Job "${jobId}" matrix generates more than ${String(MAX_MATRIX_VARIANTS)} variants`,
      );
    }
  }

  const exclude = definition.exclude
    ? normalizeCombinationList(jobId, 'exclude', definition.exclude)
    : [];
  combinations = combinations.filter(
    (combination) =>
      !exclude.some((filter) => matchesPartial(combination, filter)),
  );

  const include = definition.include
    ? normalizeCombinationList(jobId, 'include', definition.include)
    : [];
  if (axisEntries.length === 0) {
    if (include.length > MAX_MATRIX_VARIANTS) {
      throw new Error(
        `Job "${jobId}" matrix generates more than ${String(MAX_MATRIX_VARIANTS)} variants`,
      );
    }
    return include;
  }
  const originalAxisNames = new Set(axisNames);
  const originalCombinations = combinations.map((combination) =>
    structuredClone(combination),
  );
  const standaloneCombinations: PipelineMatrixCombination[] = [];
  for (const entry of include) {
    let applied = false;
    combinations = combinations.map((combination, index) => {
      const originalCombination = originalCombinations[index];
      const compatible = Object.entries(entry).every(
        ([key, value]) =>
          !originalAxisNames.has(key) ||
          (Object.prototype.hasOwnProperty.call(originalCombination, key) &&
            jsonEqual(originalCombination[key], value)),
      );
      if (!compatible) return combination;
      applied = true;
      return { ...combination, ...structuredClone(entry) };
    });
    if (!applied) standaloneCombinations.push(structuredClone(entry));
    if (
      combinations.length + standaloneCombinations.length >
      MAX_MATRIX_VARIANTS
    ) {
      throw new Error(
        `Job "${jobId}" matrix generates more than ${String(MAX_MATRIX_VARIANTS)} variants`,
      );
    }
  }

  return [...combinations, ...standaloneCombinations];
}

export function createMatrixPhysicalJobId(
  logicalJobId: string,
  index: number,
): string {
  return `${MATRIX_JOB_ID_PREFIX}${logicalJobId}__${String(index)}`;
}
