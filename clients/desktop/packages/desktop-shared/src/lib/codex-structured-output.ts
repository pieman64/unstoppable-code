/**
 * Adapt provider-neutral JSON schemas to the strict structured-output dialect
 * used by Codex/OpenAI. Strict object schemas require every property name in
 * `required`, so optional properties are represented as required-but-nullable.
 * The matching normalizer removes only those synthetic nulls before the
 * provider-neutral result guard runs.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function stringSet(value: unknown): Set<string> {
  return new Set(
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : [],
  );
}

function isNullableSchema(schema: Record<string, unknown>): boolean {
  const type = schema.type;
  if (type === 'null' || (Array.isArray(type) && type.includes('null'))) {
    return true;
  }
  if (Array.isArray(schema.enum) && schema.enum.includes(null)) {
    return true;
  }
  return ['anyOf', 'oneOf'].some((keyword) => {
    const branches = schema[keyword];
    return (
      Array.isArray(branches) &&
      branches.some((branch) => isRecord(branch) && branch.type === 'null')
    );
  });
}

function makeNullable(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (isNullableSchema(schema)) {
    return schema;
  }

  const enumValues = unknownArray(schema.enum);
  if (typeof schema.type === 'string') {
    return {
      ...schema,
      type: [schema.type, 'null'],
      ...(enumValues ? { enum: [...enumValues, null] } : {}),
    };
  }

  const typeValues = unknownArray(schema.type);
  if (typeValues) {
    return {
      ...schema,
      type: [...typeValues, 'null'],
      ...(enumValues ? { enum: [...enumValues, null] } : {}),
    };
  }

  return { anyOf: [schema, { type: 'null' }] };
}

function adaptSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => adaptSchema(entry));
  }
  if (!isRecord(value)) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = adaptSchema(child);
  }

  if (!isRecord(value.properties)) {
    return result;
  }

  const originallyRequired = stringSet(value.required);
  const properties: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value.properties)) {
    const adaptedChild = adaptSchema(child);
    properties[key] =
      originallyRequired.has(key) || !isRecord(adaptedChild)
        ? adaptedChild
        : makeNullable(adaptedChild);
  }

  result.properties = properties;
  result.required = Object.keys(properties);
  result.additionalProperties = false;
  return result;
}

export function makeCodexStrictJsonSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const adapted = adaptSchema(schema);
  return isRecord(adapted) ? adapted : {};
}

function discriminatorScore(
  schema: unknown,
  value: Record<string, unknown>,
): number {
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    return 0;
  }

  let score = 0;
  for (const [key, propertySchema] of Object.entries(schema.properties)) {
    if (!isRecord(propertySchema) || !(key in value)) {
      continue;
    }
    if ('const' in propertySchema) {
      if (value[key] !== propertySchema.const) return -1;
      score += 2;
    }
    if (Array.isArray(propertySchema.enum)) {
      if (!propertySchema.enum.includes(value[key])) return -1;
      if (propertySchema.enum.length === 1) score += 1;
    }
  }
  return score;
}

function selectUnionBranch(branches: unknown[], value: unknown): unknown {
  if (!isRecord(value)) {
    return branches[0];
  }

  let selected: unknown = undefined;
  let selectedScore = -1;
  for (const branch of branches) {
    const score = discriminatorScore(branch, value);
    if (score > selectedScore) {
      selected = branch;
      selectedScore = score;
    }
  }
  return selected;
}

function normalizeValue(value: unknown, schema: unknown): unknown {
  if (!isRecord(schema) || value === null || value === undefined) {
    return value;
  }

  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches) && branches.length > 0) {
      return normalizeValue(value, selectUnionBranch(branches, value));
    }
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry, schema.items));
  }
  if (!isRecord(value) || !isRecord(schema.properties)) {
    return value;
  }

  const originallyRequired = stringSet(schema.required);
  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const propertySchema = schema.properties[key];
    if (
      child === null &&
      isRecord(propertySchema) &&
      !isNullableSchema(propertySchema) &&
      !originallyRequired.has(key)
    ) {
      continue;
    }
    normalized[key] = normalizeValue(child, propertySchema);
  }
  return normalized;
}

export function normalizeCodexStructuredOutput(
  value: unknown,
  originalSchema: Record<string, unknown>,
): unknown {
  return normalizeValue(value, originalSchema);
}
