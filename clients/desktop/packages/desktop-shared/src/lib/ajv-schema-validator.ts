import Ajv, { type ErrorObject, type Options } from 'ajv';

export interface SchemaValidationResult {
  ok: boolean;
  error?: string;
}

export function normalizeAjvDataPath(dataPath: string | undefined): string {
  if (!dataPath) return '/';
  if (dataPath.startsWith('/')) return dataPath;
  return dataPath
    .replace(/^\./, '/')
    .replace(/\[['"]([^'"]+)['"]\]/g, '/$1')
    .replace(/\./g, '/')
    .replace(/\[(\d+)\]/g, '/$1');
}

/** Decodes one JSON Pointer segment (`~1` is `/`, `~0` is `~`). */
function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Own-property lookup: inherited `Object.prototype` names are never declared. */
function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

/**
 * Resolves a local `$ref` (`#`, `#/definitions/x`, `#/$defs/x`, any `#/...`
 * JSON Pointer into the root schema). Remote references are not followed; a
 * node that cannot be resolved simply contributes no declarations.
 */
function resolveLocalRef(root: Record<string, unknown>, ref: string): unknown {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    if (!isRecord(node)) return undefined;
    node = ownValue(node, decodePointerSegment(raw));
  }
  return node;
}

/**
 * Every schema node that governs the current position: the node itself, what
 * its `$ref` points at, and each `allOf`/`anyOf`/`oneOf` branch — recursively,
 * with a visited set so a self-referential schema terminates.
 */
function expandSchemaNodes(
  root: Record<string, unknown>,
  nodes: readonly unknown[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isRecord(node) || seen.has(node)) continue;
    seen.add(node);
    out.push(node);
    const ref = ownValue(node, '$ref');
    if (typeof ref === 'string') stack.push(resolveLocalRef(root, ref));
    for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
      const branches = ownValue(node, keyword);
      if (!Array.isArray(branches)) continue;
      for (const branch of branches) {
        const next: unknown = branch;
        stack.push(next);
      }
    }
  }
  return out;
}

/**
 * Describes WHERE validation failed without echoing anything the data chose.
 *
 * `instancePath` names the failing property, and for `additionalProperties`,
 * `patternProperties` or `propertyNames` that name comes from the agent's
 * response — not from the pipeline. This message becomes the outbound
 * structured-output retry prompt and the persisted failure, so a configured
 * value used as a property name would travel back to the vendor. JSON Pointer
 * escaping makes that worse rather than better: it rewrites `/` as `~1`, and a
 * later exact-value pass cannot recognise a value it has transformed.
 *
 * So the pointer is walked against the SCHEMA and the DATA together:
 *
 * - a segment is kept as a name only when it is an OWN key of a `properties`
 *   object in some schema node governing that position — through `$ref` and
 *   `allOf`/`anyOf`/`oneOf` — so a name the pipeline author wrote stays useful
 *   and `constructor`/`toString`/`__proto__` are never mistaken for one;
 * - a segment is kept as a position only when the DATA at that point really is
 *   an array. JSON object keys can be any string, digits included, so a numeric
 *   segment alone proves nothing;
 * - anything else becomes `<property>`.
 */
function describeInstanceLocation(
  schema: Record<string, unknown>,
  payload: unknown,
  instancePath: string,
): string {
  const pointer = normalizeAjvDataPath(instancePath);
  if (pointer === '/') return '/';
  const segments = pointer.slice(1).split('/').map(decodePointerSegment);
  const described: string[] = [];
  let nodes: unknown[] = [schema];
  let data: unknown = payload;
  for (const segment of segments) {
    const governing = expandSchemaNodes(schema, nodes);
    const next: unknown[] = [];
    if (Array.isArray(data) && /^(0|[1-9][0-9]*)$/.test(segment)) {
      const index = Number(segment);
      described.push(segment);
      for (const node of governing) {
        const prefix = ownValue(node, 'prefixItems');
        const items = ownValue(node, 'items');
        if (Array.isArray(prefix) && index < prefix.length)
          next.push(prefix[index]);
        else if (Array.isArray(items))
          next.push(
            index < items.length
              ? items[index]
              : ownValue(node, 'additionalItems'),
          );
        else if (items !== undefined) next.push(items);
      }
      data = data[index];
      nodes = next;
      continue;
    }
    let declared = false;
    for (const node of governing) {
      const properties = ownValue(node, 'properties');
      if (isRecord(properties)) {
        const property = ownValue(properties, segment);
        if (property !== undefined) {
          declared = true;
          next.push(property);
        }
      }
    }
    if (!declared) {
      for (const node of governing) {
        const additional = ownValue(node, 'additionalProperties');
        if (additional !== undefined) next.push(additional);
        const pattern = ownValue(node, 'patternProperties');
        if (isRecord(pattern)) next.push(...Object.values(pattern));
      }
    }
    described.push(declared ? segment : '<property>');
    data = isRecord(data) ? ownValue(data, segment) : undefined;
    nodes = next;
  }
  return `/${described.join('/')}`;
}

function formatAjvErrors(
  schema: Record<string, unknown>,
  payload: unknown,
  errors: ErrorObject[] | null | undefined,
): string {
  if (!errors || errors.length === 0) {
    return 'validation failed';
  }
  return errors
    .map((error) => {
      const path = describeInstanceLocation(
        schema,
        payload,
        error.instancePath,
      );
      return `${path} ${error.message ?? 'is invalid'}`;
    })
    .join('; ');
}

/**
 * Validate an arbitrary value against a caller-authored JSON schema. Shared
 * by App Advisor structured tool results (`report-structured-result.ts`) and
 * Cursor pipeline structured output (`cursor-prompt-runner.ts`) so both
 * enforce the requested schema the same way instead of trusting a bare
 * `JSON.parse`.
 */
export function validateAgainstSchema(
  schema: Record<string, unknown>,
  payload: unknown,
): SchemaValidationResult {
  try {
    const ajvOptions: Options = { allErrors: true, strictSchema: false };
    const ajv = new Ajv(ajvOptions);
    const validate = ajv.compile(schema);
    if (validate(payload)) {
      return { ok: true };
    }
    return {
      ok: false,
      error: formatAjvErrors(schema, payload, validate.errors),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
