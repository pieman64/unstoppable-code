/**
 * Pure JSON Schema projections for tool definitions advertised to gateway
 * models. Browser-safe and dependency-free: the desktop Codex runtime uses
 * {@link flattenToolJsonSchema} for the `flat` tool schema profile, and the
 * hosted LLM proxy uses {@link toStrictToolSchema} and
 * {@link stripStrictNulls} for models flagged `strictToolSchemas`.
 *
 * The strict pair follows a spec shared with Agentic Core, which implements
 * the same behavior and test vectors separately.
 */

import {
  CHARS_PER_WORK_UNIT,
  copyCost,
  MAX_TOOL_SCHEMA_DEPTH,
  measureJson,
  toolSchemaWorkLimit,
  type ToolSchemaWorkBudget,
} from './work-budget';

export { toGeminiToolSchema, type GeminiToolSchemaOptions } from './gemini';
export {
  MAX_TOOL_SCHEMA_DEPTH,
  MAX_TOOL_SCHEMA_WORK,
  measureJson,
  ToolSchemaWorkBudget,
} from './work-budget';

export type JsonSchemaValue =
  | number
  | string
  | boolean
  | JsonSchemaValue[]
  | { [key in string]?: JsonSchemaValue }
  | null;

type JsonSchemaObject = { [key in string]?: JsonSchemaValue };

/** Called for every schema change that loses validation meaning. */
export type StrictToolSchemaLossyReporter = (
  path: string,
  reason: string,
) => void;

export interface StrictToolSchemaOptions {
  onLossy?: StrictToolSchemaLossyReporter;
  /** Work shared by every schema converted for one request. */
  budget?: ToolSchemaWorkBudget;
}

/**
 * JSON Schema keywords whose value is a MAP of member-name -> subschema (not a
 * subschema itself). Their member keys are user-controlled property names and
 * must be preserved verbatim; only the member *values* are treated as
 * subschemas. This keeps a tool parameter named e.g. `if` or `anyOf` from
 * being mistaken for a keyword.
 */
export const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  'properties',
  'patternProperties',
  'definitions',
  '$defs',
  'dependentSchemas',
]);

/**
 * JSON Schema "applicator" keywords that combine or conditionally apply
 * subschemas. Some gateway providers (notably Moonshot's kimi-k3 "flavored
 * json schema") reject these outright, or reject a sibling `type` next to
 * `anyOf`/`oneOf`.
 */
const FLAT_COMBINATOR_KEYWORDS: ReadonlySet<string> = new Set([
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
]);

const STRICT_DROPPED_KEYWORDS: ReadonlySet<string> = new Set([
  'not',
  'if',
  'then',
  'else',
  'default',
  '$schema',
  'dependentSchemas',
  'dependentRequired',
  'unevaluatedProperties',
  'patternProperties',
]);

const NULL_SCHEMA: JsonSchemaObject = { type: 'null' };
const MAX_REF_HOPS = 32;
const MAX_STRIP_DEPTH = 256;

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function isJsonObject(value: JsonSchemaValue): value is JsonSchemaObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Assign without triggering the `__proto__` setter for user-named keys. */
function setOwn(
  target: JsonSchemaObject,
  key: string,
  value: JsonSchemaValue,
): void {
  if (key !== '__proto__') {
    target[key] = value;
    return;
  }
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function copyJson(value: JsonSchemaValue): JsonSchemaValue {
  if (Array.isArray(value)) return value.map(copyJson);
  if (!isJsonObject(value)) return value;
  const result: JsonSchemaObject = {};
  for (const [key, member] of Object.entries(value)) {
    if (member !== undefined) setOwn(result, key, copyJson(member));
  }
  return result;
}

function deepEqual(left: JsonSchemaValue, right: JsonSchemaValue): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => deepEqual(item, right[index] ?? null))
    );
  }
  if (!isJsonObject(left) || !isJsonObject(right)) return false;
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter(
    (key) => right[key] !== undefined,
  );
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => {
      const leftMember = left[key];
      const rightMember = right[key];
      return (
        leftMember !== undefined &&
        rightMember !== undefined &&
        hasOwn(right, key) &&
        deepEqual(leftMember, rightMember)
      );
    })
  );
}

function pointer(path: string, key: string | number): string {
  return `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

/**
 * Return a deep copy of a JSON Schema with every combinator keyword removed at
 * every level, flattening unions and conditionals into a plain, permissive
 * schema that restrictive gateway dialects accept. Assertion keywords (`type`,
 * `properties`, `items`, `enum`, `required`, `description`, bounds, …) are
 * preserved so the model keeps its field-level guidance. A schema with no
 * combinators round-trips unchanged.
 */
export function flattenToolJsonSchema(
  schema: JsonSchemaValue,
): JsonSchemaValue {
  if (Array.isArray(schema)) {
    return schema.map((item) => flattenToolJsonSchema(item));
  }
  if (!isJsonObject(schema)) {
    return schema;
  }
  const result: { [key: string]: JsonSchemaValue } = {};
  for (const [key, value] of Object.entries(schema)) {
    if (value === undefined || FLAT_COMBINATOR_KEYWORDS.has(key)) {
      continue;
    }
    if (SCHEMA_MAP_KEYWORDS.has(key) && isJsonObject(value)) {
      const members: { [key: string]: JsonSchemaValue } = {};
      for (const [memberName, memberSchema] of Object.entries(value)) {
        if (memberSchema === undefined) {
          continue;
        }
        members[memberName] = flattenToolJsonSchema(memberSchema);
      }
      result[key] = members;
      continue;
    }
    result[key] = flattenToolJsonSchema(value);
  }
  return result;
}

function objectMember(schema: JsonSchemaObject, key: string): JsonSchemaObject {
  const member = schema[key];
  return member !== undefined && isJsonObject(member) ? member : {};
}

function typeIncludes(schema: JsonSchemaObject, type: string): boolean {
  const declared = schema.type;
  return Array.isArray(declared) ? declared.includes(type) : declared === type;
}

function isObjectSchema(schema: JsonSchemaObject): boolean {
  const properties = schema.properties;
  return (
    (properties !== undefined && isJsonObject(properties)) ||
    typeIncludes(schema, 'object')
  );
}

function stringSet(value: JsonSchemaValue | undefined): Set<string> {
  return new Set(
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [],
  );
}

type SchemaResolver = (ref: string) => JsonSchemaValue | undefined;

/** `$ref` targets already expanded on the current recursion path. */
type RefPath = ReadonlySet<string>;
const NO_REFS: RefPath = new Set<string>();

function withRef(refs: RefPath, ref: string): RefPath {
  const next = new Set<string>();
  refs.forEach((existing) => next.add(existing));
  next.add(ref);
  return next;
}

const WORK_BUDGET_BASE = 10_000;
const STRIP_VISITS_PER_VALUE_NODE = 64;
const CONVERT_VISITS_PER_SCHEMA_NODE = 16;

/**
 * Caps the subschema visits one call may make. Tool schemas arrive in
 * requests, so depth limits alone cannot stop a union or `$ref` fan-out from
 * blocking the event loop.
 */
class WorkBudget {
  exhausted = false;

  constructor(
    private remaining: number,
    private readonly onExhausted: (path: string) => void,
  ) {}

  get unitsLeft(): number {
    return Math.max(0, this.remaining);
  }

  /**
   * Charge for emitting a copy of `value` under `key`: its nodes plus its
   * string and key lengths, so repeating a long string costs its length.
   */
  spendCopy(path: string, key: string, value: JsonSchemaValue): boolean {
    return this.spend(
      path,
      copyCost(value, this.unitsLeft + 1) +
        Math.ceil(key.length / CHARS_PER_WORK_UNIT),
    );
  }

  spend(path = '#', units = 1): boolean {
    if (this.remaining >= units) {
      this.remaining -= units;
      return true;
    }
    this.remaining = 0;
    if (!this.exhausted) {
      this.exhausted = true;
      this.onExhausted(path);
    }
    return false;
  }
}

class WorkBudgetExceeded extends Error {
  constructor() {
    super('work budget exceeded');
    this.name = 'WorkBudgetExceeded';
  }
}

interface AcceptsNullContext {
  budget: WorkBudget;
  /** Lets the null-stripping walk follow local `$ref`s; conversion does not. */
  resolve?: SchemaResolver;
}

/**
 * True when a schema accepts `null`: `true` and annotation-only schemas do
 * outright. Otherwise every constraint present must admit null, and at least
 * one must say so positively. `type`, `enum` or `const` without null, a union
 * with no null-accepting member, an `allOf` member that rejects null (and
 * constrains the instance type), or a resolved `$ref` whose target rejects
 * null each veto. Evidence is null in `type`, `enum` or `const`, a union
 * member that accepts null, a non-empty `allOf` that passed, or a resolved
 * `$ref` target that accepts null. A cyclic or unresolvable `$ref` neither
 * vetoes nor counts as evidence.
 */
function acceptsNull(
  schema: JsonSchemaValue | undefined,
  context: AcceptsNullContext,
  refs: RefPath = NO_REFS,
): boolean {
  if (schema === true) return true;
  if (schema === undefined || !isJsonObject(schema)) return false;
  if (!context.budget.spend()) return false;
  if (
    Object.keys(schema).every(
      (key) => schema[key] === undefined || ANNOTATION_KEYWORDS.has(key),
    )
  ) {
    return true;
  }
  let evidence = false;
  if (schema.type !== undefined) {
    if (!typeIncludes(schema, 'null')) return false;
    evidence = true;
  }
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(null)) return false;
    evidence = true;
  }
  if (hasOwn(schema, 'const') && schema.const !== undefined) {
    if (schema.const !== null) return false;
    evidence = true;
  }
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((member) => acceptsNull(member, context, refs))) {
      return false;
    }
    evidence = true;
  }
  // `oneOf` is exclusive: null passes only when exactly one member takes it.
  if (Array.isArray(schema.oneOf)) {
    const accepting = schema.oneOf.filter((member) =>
      acceptsNull(member, context, refs),
    ).length;
    if (accepting !== 1) return false;
    evidence = true;
  }
  const allOf = schema.allOf;
  if (Array.isArray(allOf)) {
    if (
      !allOf.every(
        (member) =>
          acceptsNull(member, context, refs) || !constrainsInstanceType(member),
      )
    ) {
      return false;
    }
    if (allOf.length > 0) evidence = true;
  }
  const ref = schema.$ref;
  if (context.resolve && typeof ref === 'string' && !refs.has(ref)) {
    const target = context.resolve(ref);
    if (target !== undefined) {
      if (!acceptsNull(target, context, withRef(refs, ref))) return false;
      evidence = true;
    }
  }
  return evidence;
}

/** Keywords that describe a schema without constraining its values. */
const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  'description',
  'title',
  'examples',
  '$comment',
  'deprecated',
  'readOnly',
  'writeOnly',
  'default',
]);

const INSTANCE_TYPE_KEYWORDS = [
  'type',
  'enum',
  'const',
  'anyOf',
  'oneOf',
  'allOf',
  '$ref',
  'not',
] as const;

/**
 * Whether an `allOf` member can rule out `null` at all. A member made only of
 * type-specific assertions (`maxLength`, `minimum`, `pattern`, …) or
 * annotations ignores values of other types, so it never rejects `null`.
 */
function constrainsInstanceType(member: JsonSchemaValue): boolean {
  if (!isJsonObject(member)) return member === false;
  return INSTANCE_TYPE_KEYWORDS.some(
    (keyword) => member[keyword] !== undefined,
  );
}

interface InlinedAllOf {
  schema: JsonSchemaObject;
  /** Keywords where a single member disagreed with its parent; parent kept. */
  conflicts: string[];
  /** True when a multi-member `allOf` could not be merged and was removed. */
  dropped: boolean;
}

function mergeInto(
  target: JsonSchemaObject,
  member: JsonSchemaObject,
  conflicts: string[],
): void {
  for (const [key, value] of Object.entries(member)) {
    if (value === undefined) continue;
    const existing = target[key];
    if (existing === undefined) {
      setOwn(target, key, value);
    } else if (
      key === 'required' &&
      Array.isArray(existing) &&
      Array.isArray(value)
    ) {
      const merged = [...existing];
      const seen = new Set(merged);
      for (const name of value) {
        if (seen.has(name)) continue;
        seen.add(name);
        merged.push(name);
      }
      target.required = merged;
    } else if (
      key === 'properties' &&
      isJsonObject(existing) &&
      isJsonObject(value)
    ) {
      const merged = { ...existing };
      for (const [name, property] of Object.entries(value)) {
        if (property === undefined) continue;
        const current = merged[name];
        if (current === undefined) setOwn(merged, name, property);
        else if (!deepEqual(current, property))
          conflicts.push(`properties/${name}`);
      }
      target.properties = merged;
    } else if (!deepEqual(existing, value)) {
      conflicts.push(key);
    }
  }
}

/**
 * Inline `allOf` into its parent when that is trivially safe: a single member
 * is always inlined (the parent wins any disagreement), and several members
 * are inlined only when none disagree. `required` lists union and `properties`
 * maps merge. Anything else is removed.
 */
function inlineAllOf(schema: JsonSchemaObject): InlinedAllOf {
  const members = schema.allOf;
  const rest: JsonSchemaObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key !== 'allOf' && value !== undefined) setOwn(rest, key, value);
  }
  if (!Array.isArray(members) || !members.every(isJsonObject)) {
    return { schema: rest, conflicts: [], dropped: members !== undefined };
  }
  const merged: JsonSchemaObject = { ...rest };
  const conflicts: string[] = [];
  for (const member of members) {
    if (isJsonObject(member)) mergeInto(merged, member, conflicts);
  }
  if (members.length === 1)
    return { schema: merged, conflicts, dropped: false };
  return conflicts.length === 0
    ? { schema: merged, conflicts, dropped: false }
    : { schema: rest, conflicts: [], dropped: true };
}

function withoutAllOf(
  schema: JsonSchemaObject,
  path: string,
  onLossy: StrictToolSchemaLossyReporter | undefined,
): JsonSchemaObject {
  let current = schema;
  for (let pass = 0; current.allOf !== undefined; pass += 1) {
    if (pass >= MAX_REF_HOPS) {
      const rest: JsonSchemaObject = {};
      for (const [key, value] of Object.entries(current)) {
        if (key !== 'allOf' && value !== undefined) setOwn(rest, key, value);
      }
      onLossy?.(pointer(path, 'allOf'), 'dropped nested allOf');
      return rest;
    }
    const inlined = inlineAllOf(current);
    if (inlined.dropped) {
      onLossy?.(pointer(path, 'allOf'), 'dropped allOf that cannot be merged');
    }
    for (const conflict of inlined.conflicts) {
      onLossy?.(
        pointer(path, 'allOf'),
        `allOf member disagrees on "${conflict}"; kept the parent value`,
      );
    }
    current = inlined.schema;
  }
  return current;
}

function nullableSchema(schema: JsonSchemaValue): JsonSchemaValue {
  if (!isJsonObject(schema)) {
    return { anyOf: [schema, { ...NULL_SCHEMA }] };
  }
  const type = schema.type;
  const needsWrapper =
    (typeof type !== 'string' && !Array.isArray(type)) ||
    (hasOwn(schema, 'const') && schema.const !== null) ||
    Array.isArray(schema.anyOf) ||
    typeof schema.$ref === 'string';
  if (needsWrapper) {
    const inner: JsonSchemaObject = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key !== 'description' && value !== undefined)
        setOwn(inner, key, value);
    }
    return schema.description === undefined
      ? { anyOf: [inner, { ...NULL_SCHEMA }] }
      : {
          description: schema.description,
          anyOf: [inner, { ...NULL_SCHEMA }],
        };
  }
  const result: JsonSchemaObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (value === undefined) continue;
    if (key === 'type') {
      setOwn(
        result,
        key,
        Array.isArray(value)
          ? value.includes('null')
            ? value
            : [...value, 'null']
          : [value, 'null'],
      );
    } else if (
      key === 'enum' &&
      Array.isArray(value) &&
      !value.includes(null)
    ) {
      setOwn(result, key, [...value, null]);
    } else {
      setOwn(result, key, value);
    }
  }
  return result;
}

interface ConvertContext {
  onLossy: StrictToolSchemaLossyReporter | undefined;
  budget: WorkBudget;
  /** Resolves local `$ref`s against the hoisted root, for union members. */
  resolveRef: SchemaResolver;
  /** `$ref` targets being expanded on the current conversion path. */
  expanding: Set<string>;
}

function strictMembers(
  members: JsonSchemaValue,
  path: string,
  context: ConvertContext,
): JsonSchemaValue {
  return Array.isArray(members)
    ? members.map((member, index) =>
        strictSchema(member, pointer(path, index), context),
      )
    : copyJson(members);
}

function strictSchemaMap(
  members: JsonSchemaValue,
  path: string,
  context: ConvertContext,
): JsonSchemaValue {
  if (!isJsonObject(members)) return copyJson(members);
  const result: JsonSchemaObject = {};
  for (const [name, member] of Object.entries(members)) {
    if (member === undefined) continue;
    context.budget.spend(path, Math.ceil(name.length / CHARS_PER_WORK_UNIT));
    // A root definition is its own expansion target, so a union inside it
    // never distributes a reference back to itself.
    const target = path === ROOT_DEFS_POINTER ? pointer(path, name) : undefined;
    const added = target !== undefined && !context.expanding.has(target);
    if (added) context.expanding.add(target);
    try {
      setOwn(result, name, strictSchema(member, pointer(path, name), context));
    } finally {
      if (added) context.expanding.delete(target);
    }
  }
  return result;
}

function strictProperties(
  properties: JsonSchemaObject,
  required: ReadonlySet<string>,
  path: string,
  context: ConvertContext,
): JsonSchemaObject {
  const result: JsonSchemaObject = {};
  for (const [name, property] of Object.entries(properties)) {
    if (property === undefined) continue;
    // Union distribution converts a parent's properties once per branch.
    context.budget.spend(path, Math.ceil(name.length / CHARS_PER_WORK_UNIT));
    const strict = strictSchema(property, pointer(path, name), context);
    setOwn(
      result,
      name,
      required.has(name) || acceptsNull(strict, context)
        ? strict
        : nullableSchema(strict),
    );
  }
  return result;
}

interface ObjectMemberContent {
  schema: JsonSchemaObject;
  /** The `$ref`s followed to reach the content, outermost first. */
  refs: string[];
}

/**
 * The object schema a union member stands for, following local `$ref`s. A
 * member that is not an object schema, cannot be resolved, or refers back to
 * a target already being expanded is not an object member.
 */
function objectMemberContent(
  member: JsonSchemaValue,
  context: ConvertContext,
  parentIsObject: boolean,
  memberPath?: string,
): ObjectMemberContent | undefined {
  // Lossy `allOf` inlining is reported only for a member that turns out to be
  // an object branch; any other member is converted, and reported, as is.
  const reports: [string, string][] = [];
  const collect: StrictToolSchemaLossyReporter = (path, reason) =>
    reports.push([path, reason]);
  const found = findObjectMemberContent(
    member,
    context,
    parentIsObject,
    memberPath ?? '#',
    collect,
  );
  if (found !== undefined && memberPath !== undefined) {
    for (const [path, reason] of reports) context.onLossy?.(path, reason);
  }
  return found;
}

/**
 * The object branch a union member stands for. At every hop the node's
 * `allOf` is inlined first, so `{ allOf: [{ properties… }] }` and
 * `{ allOf: [{ $ref }] }` classify and merge like a plain object member.
 */
function findObjectMemberContent(
  member: JsonSchemaValue,
  context: ConvertContext,
  parentIsObject: boolean,
  memberPath: string,
  onLossy: StrictToolSchemaLossyReporter,
): ObjectMemberContent | undefined {
  let current: JsonSchemaValue | undefined = member;
  const refs: string[] = [];
  for (let hops = 0; hops <= MAX_REF_HOPS; hops += 1) {
    if (current === undefined || !isJsonObject(current)) return undefined;
    if (current.allOf !== undefined) {
      current = withoutAllOf(current, memberPath, onLossy);
    }
    const ref = current.$ref;
    if (typeof ref !== 'string') {
      return isObjectBranch(current, parentIsObject)
        ? { schema: current, refs }
        : undefined;
    }
    if (context.expanding.has(ref) || refs.includes(ref)) return undefined;
    if (!context.budget.spend()) return undefined;
    refs.push(ref);
    current = context.resolveRef(ref);
  }
  return undefined;
}

/**
 * A member with only `required` (and optionally `description`), such as
 * `{ required: ['executionId'] }`, selects which of the parent's properties
 * must be present. Under an object parent it is an object branch.
 */
function isRequiredOnlyMember(member: JsonSchemaObject): boolean {
  return (
    Array.isArray(member.required) &&
    Object.keys(member).every(
      (key) =>
        member[key] === undefined ||
        key === 'required' ||
        key === 'description',
    )
  );
}

function isObjectBranch(
  member: JsonSchemaObject,
  parentIsObject: boolean,
): boolean {
  return (
    isObjectSchema(member) || (parentIsObject && isRequiredOnlyMember(member))
  );
}

function hasObjectMember(
  schema: JsonSchemaObject,
  context: ConvertContext,
): boolean {
  return unionMembers(schema).some(
    (member) => objectMemberContent(member, context, true) !== undefined,
  );
}

function unionMembers(schema: JsonSchemaObject): JsonSchemaValue[] {
  return [
    ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
    ...(Array.isArray(schema.oneOf) ? schema.oneOf : []),
  ];
}

function orderedStrings(...lists: (JsonSchemaValue | undefined)[]): string[] {
  const result = new Set<string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) if (typeof item === 'string') result.add(item);
  }
  return Array.from(result);
}

/**
 * Merge an object union's parent into one of its object members, typed as an
 * object first because strict providers require `type` on every subschema:
 * the member's properties overlay the parent's, `required` lists combine, and
 * the member's `additionalProperties` and `description` win. The member's own
 * `anyOf`/`oneOf` is carried over, so a nested union distributes again.
 */
function mergeUnionBranch(
  parent: JsonSchemaObject,
  member: JsonSchemaObject,
): JsonSchemaObject {
  const properties: JsonSchemaObject = {};
  for (const source of [
    objectMember(parent, 'properties'),
    objectMember(member, 'properties'),
  ]) {
    for (const [name, property] of Object.entries(source)) {
      if (property !== undefined) setOwn(properties, name, property);
    }
  }
  const branch: JsonSchemaObject = {
    type: 'object',
    properties,
    required: orderedStrings(parent.required, member.required),
  };
  if (member.description !== undefined) {
    branch.description = member.description;
  }
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const carried = member[keyword];
    if (carried !== undefined) branch[keyword] = carried;
  }
  // Last, where conversion also places it, so a second pass keeps key order.
  const additionalProperties =
    member.additionalProperties ?? parent.additionalProperties;
  if (additionalProperties !== undefined) {
    branch.additionalProperties = additionalProperties;
  }
  return branch;
}

const OBJECT_UNION_KEPT_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'anyOf',
  'oneOf',
  'title',
  'description',
  '$defs',
  'definitions',
]);

/**
 * Convert an object schema whose `anyOf`/`oneOf` has object members by
 * distributing the parent into each object branch, so every branch is a
 * complete strict object and the parent keeps no object keywords of its own.
 * A member that refers to an object definition is distributed from the
 * definition's content.
 */
function strictObjectUnion(
  schema: JsonSchemaObject,
  path: string,
  context: ConvertContext,
): JsonSchemaObject {
  if (Array.isArray(schema.anyOf) && Array.isArray(schema.oneOf)) {
    context.onLossy?.(pointer(path, 'oneOf'), 'merged "oneOf" into "anyOf"');
  }
  const nullable = typeIncludes(schema, 'null') || acceptsNull(schema, context);
  const declared = declaredTypes(schema);
  const otherTypes = declared.filter(
    (type) => type !== 'object' && type !== 'null',
  );
  const result: JsonSchemaObject = {
    type:
      otherTypes.length > 0
        ? nullable && !declared.includes('null')
          ? [...declared, 'null']
          : [...declared]
        : nullable
          ? ['object', 'null']
          : 'object',
  };
  for (const [key, value] of Object.entries(schema)) {
    if (value === undefined) continue;
    if (key === 'title' || key === 'description') {
      context.budget.spendCopy(path, key, value);
      setOwn(result, key, copyJson(value));
    } else if (key === '$defs' || key === 'definitions') {
      setOwn(result, key, strictSchemaMap(value, pointer(path, key), context));
    } else if (!OBJECT_UNION_KEPT_KEYWORDS.has(key)) {
      context.onLossy?.(
        pointer(path, key),
        `dropped "${key}" beside an object union`,
      );
    }
  }
  const members: { member: JsonSchemaValue; path: string }[] = [];
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const list = schema[keyword];
    if (!Array.isArray(list)) continue;
    list.forEach((member, index) =>
      members.push({ member, path: pointer(pointer(path, keyword), index) }),
    );
  }
  result.anyOf = members.map(({ member, path: memberPath }) => {
    if (context.budget.exhausted) return member;
    const content = objectMemberContent(member, context, true, memberPath);
    if (content === undefined) {
      return strictSchema(member, memberPath, context);
    }
    if (
      !context.budget.spend(
        memberPath,
        Object.keys(objectMember(schema, 'properties')).length +
          Object.keys(objectMember(content.schema, 'properties')).length,
      )
    ) {
      return member;
    }
    for (const ref of content.refs) context.expanding.add(ref);
    try {
      return strictSchema(
        mergeUnionBranch(schema, content.schema),
        memberPath,
        context,
      );
    } finally {
      for (const ref of content.refs) context.expanding.delete(ref);
    }
  });
  const firstNull = result.anyOf.findIndex(isBareNullSchema);
  const otherTypesMember: JsonSchemaObject = {
    type: otherTypes.length === 1 ? (otherTypes[0] ?? null) : otherTypes,
  };
  if (
    otherTypes.length > 0 &&
    !result.anyOf.some((member) => deepEqual(member, otherTypesMember))
  ) {
    // The parent's non-object types survive as their own member.
    if (firstNull === -1) result.anyOf.push(otherTypesMember);
    else result.anyOf.splice(firstNull, 0, otherTypesMember);
  }
  if (nullable && firstNull === -1) {
    result.anyOf.push({ ...NULL_SCHEMA });
  }
  return result;
}

function declaredTypes(schema: JsonSchemaObject): string[] {
  const type = schema.type;
  const list = Array.isArray(type) ? type : [type];
  return list.filter((item): item is string => typeof item === 'string');
}

function isBareNullSchema(member: JsonSchemaValue): boolean {
  return (
    isJsonObject(member) &&
    member.type === 'null' &&
    Object.keys(member).length === 1
  );
}

const REF_NODE_KEPT_KEYWORDS: ReadonlySet<string> = new Set([
  '$ref',
  'type',
  'description',
]);

/**
 * A `$ref` node is never closed itself: the referenced definition is
 * converted in place instead. Only `type` and `description` stay beside the
 * reference; root definitions on the same node are converted so the
 * reference still resolves.
 */
function strictRefNode(
  schema: JsonSchemaObject,
  path: string,
  context: ConvertContext,
): JsonSchemaObject {
  const result: JsonSchemaObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (value === undefined) continue;
    if (REF_NODE_KEPT_KEYWORDS.has(key)) {
      context.budget.spendCopy(path, key, value);
      setOwn(result, key, copyJson(value));
    } else if (key === '$defs' || key === 'definitions') {
      setOwn(result, key, strictSchemaMap(value, pointer(path, key), context));
    } else {
      context.onLossy?.(pointer(path, key), `dropped "${key}" beside "$ref"`);
    }
  }
  return result;
}

function strictSchema(
  input: JsonSchemaValue,
  path: string,
  context: ConvertContext,
): JsonSchemaValue {
  if (!isJsonObject(input)) return copyJson(input);
  // Past the budget the rest of the schema is left as it was.
  if (!context.budget.spend(path)) return input;
  if (typeof input.$ref === 'string')
    return strictRefNode(input, path, context);
  const schema = withoutAllOf(input, path, context.onLossy);
  // An `allOf` whose member was a reference leaves a reference node.
  if (typeof schema.$ref === 'string') {
    return strictRefNode(schema, path, context);
  }
  const objectSchema = isObjectSchema(schema);
  if (objectSchema && hasObjectMember(schema, context)) {
    return strictObjectUnion(schema, path, context);
  }
  const properties = objectMember(schema, 'properties');
  const propertyNames = Object.keys(properties).filter(
    (name) => properties[name] !== undefined,
  );
  const result: JsonSchemaObject = {};
  const writeObjectKeyword = (
    key: 'properties' | 'required' | 'additionalProperties',
  ): void => {
    if (key === 'properties') {
      result.properties = strictProperties(
        properties,
        stringSet(schema.required),
        pointer(path, 'properties'),
        context,
      );
    } else if (key === 'required') {
      result.required = [...propertyNames];
    } else {
      const original = schema.additionalProperties;
      const openRecord = propertyNames.length === 0 && original !== false;
      if (openRecord || (original !== undefined && original !== false)) {
        context.onLossy?.(
          pointer(path, 'additionalProperties'),
          propertyNames.length === 0
            ? 'open record closed to an empty object'
            : 'additional properties are no longer accepted',
        );
      }
      result.additionalProperties = false;
    }
  };

  for (const [key, value] of Object.entries(schema)) {
    if (value === undefined) continue;
    if (STRICT_DROPPED_KEYWORDS.has(key)) {
      context.onLossy?.(pointer(path, key), `dropped "${key}"`);
      continue;
    }
    if (
      objectSchema &&
      (key === 'properties' ||
        key === 'required' ||
        key === 'additionalProperties')
    ) {
      writeObjectKeyword(key);
      continue;
    }
    if (key === 'oneOf') {
      if (Array.isArray(schema.anyOf) && Array.isArray(value)) {
        context.onLossy?.(pointer(path, key), 'merged "oneOf" into "anyOf"');
        continue;
      }
      if (schema.anyOf !== undefined) {
        context.onLossy?.(pointer(path, key), 'dropped "oneOf" beside "anyOf"');
        continue;
      }
      result.anyOf = strictMembers(value, pointer(path, key), context);
      continue;
    }
    if (
      key === 'anyOf' &&
      Array.isArray(value) &&
      Array.isArray(schema.oneOf)
    ) {
      result.anyOf = [
        ...value.map((member, index) =>
          strictSchema(member, pointer(pointer(path, key), index), context),
        ),
        ...schema.oneOf.map((member, index) =>
          strictSchema(member, pointer(pointer(path, 'oneOf'), index), context),
        ),
      ];
      continue;
    }
    if (key === 'anyOf' || key === 'prefixItems') {
      setOwn(result, key, strictMembers(value, pointer(path, key), context));
      continue;
    }
    if (key === 'items' || key === 'additionalProperties') {
      setOwn(
        result,
        key,
        Array.isArray(value)
          ? strictMembers(value, pointer(path, key), context)
          : strictSchema(value, pointer(path, key), context),
      );
      continue;
    }
    if (SCHEMA_MAP_KEYWORDS.has(key)) {
      setOwn(result, key, strictSchemaMap(value, pointer(path, key), context));
      continue;
    }
    // Union distribution repeats a parent's keywords in every branch.
    if (!context.budget.spendCopy(path, key, value)) return input;
    setOwn(result, key, copyJson(value));
  }
  if (objectSchema) {
    if (result.properties === undefined) writeObjectKeyword('properties');
    if (result.required === undefined) writeObjectKeyword('required');
    if (result.additionalProperties === undefined) {
      writeObjectKeyword('additionalProperties');
    }
  }
  return result;
}

const ROOT_DEFS_POINTER = '#/$defs';
const DEFINITION_KEYWORDS: ReadonlySet<string> = new Set([
  '$defs',
  'definitions',
]);
const SINGLE_SUBSCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'items',
  'additionalProperties',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'propertyNames',
  'unevaluatedProperties',
  'unevaluatedItems',
  'additionalItems',
]);
const LIST_SUBSCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'anyOf',
  'oneOf',
  'allOf',
  'prefixItems',
  'items',
]);
const MAP_SUBSCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'properties',
  'patternProperties',
  'dependentSchemas',
]);

class HoistAborted extends Error {
  constructor() {
    super('definition hoisting exceeded the work budget');
    this.name = 'HoistAborted';
  }
}

interface HoistPlan {
  budget: WorkBudget;
  /** Root `$defs` name for each definition entry, keyed by its original path. */
  names: Map<string, string>;
  /** Entries moved into the root `$defs`, in the order they were found. */
  hoisted: { name: string; path: string[] }[];
  taken: Set<string>;
}

function pathKey(segments: readonly string[]): string {
  return JSON.stringify(segments);
}

function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Visit every subschema of a schema node, in key order. Definition maps are
 * handed to `onDefinitions` instead; property names and definition names are
 * data, never keywords.
 */
function forEachSubschema(
  node: JsonSchemaObject,
  segments: readonly string[],
  visit: (child: JsonSchemaValue, segments: string[]) => void,
  onDefinitions: (key: string, map: JsonSchemaObject) => void,
): void {
  for (const [key, value] of Object.entries(node)) {
    if (value === undefined) continue;
    if (DEFINITION_KEYWORDS.has(key) && isJsonObject(value)) {
      onDefinitions(key, value);
    } else if (LIST_SUBSCHEMA_KEYWORDS.has(key) && Array.isArray(value)) {
      value.forEach((item, index) =>
        visit(item, [...segments, key, String(index)]),
      );
    } else if (SINGLE_SUBSCHEMA_KEYWORDS.has(key) && isJsonObject(value)) {
      visit(value, [...segments, key]);
    } else if (MAP_SUBSCHEMA_KEYWORDS.has(key) && isJsonObject(value)) {
      for (const [name, member] of Object.entries(value)) {
        if (member !== undefined) visit(member, [...segments, key, name]);
      }
    }
  }
}

function collectDefinitions(
  node: JsonSchemaValue,
  segments: string[],
  plan: HoistPlan,
  rootDefsNames: ReadonlySet<string>,
): void {
  if (!isJsonObject(node)) return;
  if (!plan.budget.spend()) throw new HoistAborted();
  const isRoot = segments.length === 0;
  forEachSubschema(
    node,
    segments,
    (child, childSegments) =>
      collectDefinitions(child, childSegments, plan, rootDefsNames),
    (key, map) => {
      for (const [name, entry] of Object.entries(map)) {
        if (entry === undefined) continue;
        const entryPath = [...segments, key, name];
        if (isRoot && key === '$defs') {
          plan.names.set(pathKey(entryPath), name);
        } else {
          const base = !isRoot
            ? [...segments, name].join('.')
            : rootDefsNames.has(name)
              ? `definitions.${name}`
              : name;
          const hoistedName = uniqueName(base, plan.taken);
          plan.taken.add(hoistedName);
          plan.names.set(pathKey(entryPath), hoistedName);
          plan.hoisted.push({ name: hoistedName, path: entryPath });
        }
        collectDefinitions(entry, entryPath, plan, rootDefsNames);
      }
    },
  );
}

function rewriteRef(ref: string, names: ReadonlyMap<string, string>): string {
  if (!ref.startsWith('#/')) return ref;
  const segments = ref.slice(2).split('/').map(decodePointerSegment);
  for (let end = segments.length; end >= 2; end -= 1) {
    const name = names.get(pathKey(segments.slice(0, end)));
    if (name !== undefined) {
      return segments
        .slice(end)
        .reduce<string>(
          (target, segment) => pointer(target, segment),
          pointer(ROOT_DEFS_POINTER, name),
        );
    }
  }
  return ref;
}

/** Copy a schema node without definition maps, with every `$ref` mapped. */
function rebuildHoisted(
  node: JsonSchemaValue,
  mapRef: (ref: string) => string,
  budget: WorkBudget,
): JsonSchemaValue {
  if (!isJsonObject(node)) return copyJson(node);
  if (!budget.spend()) throw new HoistAborted();
  const result: JsonSchemaObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (value === undefined) continue;
    if (DEFINITION_KEYWORDS.has(key) && isJsonObject(value)) continue;
    if (key === '$ref' && typeof value === 'string') {
      setOwn(result, key, mapRef(value));
    } else if (LIST_SUBSCHEMA_KEYWORDS.has(key) && Array.isArray(value)) {
      setOwn(
        result,
        key,
        value.map((item) => rebuildHoisted(item, mapRef, budget)),
      );
    } else if (SINGLE_SUBSCHEMA_KEYWORDS.has(key) && isJsonObject(value)) {
      setOwn(result, key, rebuildHoisted(value, mapRef, budget));
    } else if (MAP_SUBSCHEMA_KEYWORDS.has(key) && isJsonObject(value)) {
      const members: JsonSchemaObject = {};
      for (const [name, member] of Object.entries(value)) {
        if (member !== undefined) {
          setOwn(members, name, rebuildHoisted(member, mapRef, budget));
        }
      }
      setOwn(result, key, members);
    } else {
      if (!budget.spendCopy('#', key, value)) throw new HoistAborted();
      setOwn(result, key, copyJson(value));
    }
  }
  return result;
}

function valueAt(
  root: JsonSchemaValue,
  segments: readonly string[],
): JsonSchemaValue | undefined {
  let current: JsonSchemaValue | undefined = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      current = /^(0|[1-9][0-9]*)$/.test(segment)
        ? current[Number(segment)]
        : undefined;
    } else if (current !== undefined && isJsonObject(current)) {
      current = hasOwn(current, segment) ? current[segment] : undefined;
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Lift every `$defs`/`definitions` map below the root, and a root
 * `definitions` map, into the root `$defs`, and point local refs at the new
 * names. Conversion moves and wraps subschemas, so a definition left in place
 * could stop resolving; at the root it always does. Names come from the
 * owning schema's pointer (`properties.filter.Value`). A schema with nothing
 * to lift is returned as is; `undefined` means the walk ran out of budget.
 */
function hoistDefinitions(
  schema: JsonSchemaValue,
  budget: WorkBudget,
  onUnresolved: (ref: string) => void = () => {},
): JsonSchemaValue | undefined {
  try {
    return hoistWithin(schema, budget, onUnresolved);
  } catch (error) {
    if (error instanceof HoistAborted) return undefined;
    throw error;
  }
}

const ROOT_COPY_NAME = '__root';

/**
 * Point every local `$ref` at a single root `$defs` entry. `#` becomes a copy
 * of the root (without its `$defs`) named `__root`, and any other pointer gets
 * a copy of its target named from its segments (`properties.a`). Copies are
 * rewritten the same way, so the result needs no further rewriting. A ref
 * that resolves to nothing is left as it was and reported.
 */
function pointRefsIntoDefinitions(
  schema: JsonSchemaValue,
  budget: WorkBudget,
  onUnresolved: (ref: string) => void,
): JsonSchemaValue {
  if (!isJsonObject(schema)) return schema;
  const resolve = localRefResolver(schema);
  const existing = objectMember(schema, '$defs');
  const existingNames = Object.keys(existing).filter(
    (name) => existing[name] !== undefined,
  );
  const taken = new Set(existingNames);
  const names = new Map<string, string>();
  const copies: { name: string; target: JsonSchemaValue }[] = [];
  const reported = new Set<string>();
  let changed = false;
  const withoutDefinitions: JsonSchemaObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key !== '$defs' && value !== undefined) {
      setOwn(withoutDefinitions, key, value);
    }
  }

  const mapRef = (ref: string): string => {
    if (ref !== '#' && !ref.startsWith('#/')) return ref;
    const segments =
      ref === '#' ? [] : ref.slice(2).split('/').map(decodePointerSegment);
    if (segments.length === 2 && segments[0] === '$defs') return ref;
    const known = names.get(ref);
    if (known !== undefined) {
      changed = true;
      return pointer(ROOT_DEFS_POINTER, known);
    }
    const target = ref === '#' ? withoutDefinitions : resolve(ref);
    if (target === undefined) {
      if (!reported.has(ref)) {
        reported.add(ref);
        onUnresolved(ref);
      }
      return ref;
    }
    const name = uniqueName(
      ref === '#' ? ROOT_COPY_NAME : segments.join('.'),
      taken,
    );
    taken.add(name);
    names.set(ref, name);
    copies.push({ name, target });
    changed = true;
    return pointer(ROOT_DEFS_POINTER, name);
  };

  const rebuiltRoot = rebuildHoisted(withoutDefinitions, mapRef, budget);
  const definitions: JsonSchemaObject = {};
  for (const name of existingNames) {
    const entry = existing[name];
    if (entry !== undefined) {
      setOwn(definitions, name, rebuildHoisted(entry, mapRef, budget));
    }
  }
  for (let index = 0; index < copies.length; index += 1) {
    const copy = copies[index];
    if (copy === undefined) continue;
    setOwn(definitions, copy.name, rebuildHoisted(copy.target, mapRef, budget));
  }
  if (!changed || !isJsonObject(rebuiltRoot)) return schema;
  const result: JsonSchemaObject = {};
  let placed = false;
  for (const key of Object.keys(schema)) {
    if (key === '$defs') {
      result.$defs = definitions;
      placed = true;
    } else if (hasOwn(rebuiltRoot, key)) {
      const value = rebuiltRoot[key];
      if (value !== undefined) setOwn(result, key, value);
    }
  }
  if (!placed) result.$defs = definitions;
  return result;
}

function hoistWithin(
  schema: JsonSchemaValue,
  budget: WorkBudget,
  onUnresolved: (ref: string) => void,
): JsonSchemaValue {
  return pointRefsIntoDefinitions(
    liftDefinitionMaps(schema, budget),
    budget,
    onUnresolved,
  );
}

function liftDefinitionMaps(
  schema: JsonSchemaValue,
  budget: WorkBudget,
): JsonSchemaValue {
  if (!isJsonObject(schema)) return schema;
  const rootDefs = objectMember(schema, '$defs');
  const rootDefsList = Object.keys(rootDefs).filter(
    (name) => rootDefs[name] !== undefined,
  );
  const rootDefsNames = new Set(rootDefsList);
  const plan: HoistPlan = {
    budget,
    names: new Map(),
    hoisted: [],
    taken: new Set(rootDefsNames),
  };
  collectDefinitions(schema, [], plan, rootDefsNames);
  if (plan.hoisted.length === 0) return schema;
  const mapHoisted = (ref: string): string => rewriteRef(ref, plan.names);

  const definitions: JsonSchemaObject = {};
  for (const name of rootDefsList) {
    const entry = rootDefs[name];
    if (entry !== undefined) {
      setOwn(definitions, name, rebuildHoisted(entry, mapHoisted, budget));
    }
  }
  for (const { name, path } of plan.hoisted) {
    const entry = valueAt(schema, path);
    if (entry !== undefined) {
      setOwn(definitions, name, rebuildHoisted(entry, mapHoisted, budget));
    }
  }
  const rebuilt = rebuildHoisted(schema, mapHoisted, budget);
  if (!isJsonObject(rebuilt)) return rebuilt;
  const anchor = schema.$defs !== undefined ? '$defs' : 'definitions';
  const result: JsonSchemaObject = {};
  let placed = false;
  for (const key of Object.keys(schema)) {
    if (key === anchor && isJsonObject(schema[key] ?? null)) {
      result.$defs = definitions;
      placed = true;
    } else if (hasOwn(rebuilt, key)) {
      const value = rebuilt[key];
      if (value !== undefined) setOwn(result, key, value);
    }
  }
  if (!placed) result.$defs = definitions;
  return result;
}

/**
 * Project a tool's JSON Schema into OpenAI-style strict form: every object
 * lists all of its properties in `required` and closes `additionalProperties`,
 * and each property that was optional becomes nullable instead. `oneOf`
 * becomes `anyOf`, a mergeable `allOf` is inlined, nested definitions move to
 * the root `$defs`, and keywords strict mode rejects are dropped. Each change
 * that loses meaning is reported through `onLossy` with a JSON Pointer
 * (`#/properties/x`). Pure, never mutates its input, and idempotent. A schema
 * nested deeper than `MAX_TOOL_SCHEMA_DEPTH`, or whose conversion exceeds its
 * work budget, is returned unchanged with one report at `#`.
 */
export function toStrictToolSchema(
  schema: JsonSchemaValue,
  options: StrictToolSchemaOptions = {},
): JsonSchemaValue {
  const shape = measureJson(schema);
  if (shape.depth > MAX_TOOL_SCHEMA_DEPTH) {
    options.onLossy?.('#', 'schema nested too deeply; schema left unchanged');
    return schema;
  }
  const limit = toolSchemaWorkLimit(
    WORK_BUDGET_BASE + CONVERT_VISITS_PER_SCHEMA_NODE * shape.nodes,
    options.budget,
  );
  // Reports are held back so a conversion that runs out reports only that.
  const reports: [string, string][] = [];
  const onLossy: StrictToolSchemaLossyReporter = (path, reason) =>
    reports.push([path, reason]);
  const budget = new WorkBudget(limit, () => {});
  const unchanged = (): JsonSchemaValue => {
    options.budget?.consume(limit);
    options.onLossy?.('#', 'work budget exceeded; schema left unchanged');
    return schema;
  };
  const hoisted = hoistDefinitions(schema, budget, (ref) =>
    onLossy(ref, 'unresolvable local $ref left unchanged'),
  );
  if (hoisted === undefined) return unchanged();
  const context: ConvertContext = {
    onLossy,
    budget,
    resolveRef: localRefResolver(hoisted),
    // The root and its `__root` copy are the same schema: neither is
    // expanded into a union distributed at the root.
    expanding: new Set(['#', pointer(ROOT_DEFS_POINTER, ROOT_COPY_NAME)]),
  };
  const bare = isBareObjectUnion(hoisted, context);
  const result = strictSchema(hoisted, '#', context);
  if (budget.exhausted) return unchanged();
  options.budget?.consume(limit - budget.unitsLeft);
  for (const [path, reason] of reports) options.onLossy?.(path, reason);
  return bare && isJsonObject(result) ? { type: 'object', ...result } : result;
}

/**
 * A root with no `type` or `properties` whose union members are all objects.
 * Typing it keeps the tool's parameters an object schema, which strict
 * providers require at the root. Nested bare unions stay untyped.
 */
function isBareObjectUnion(
  schema: JsonSchemaValue,
  context: ConvertContext,
): boolean {
  if (!isJsonObject(schema)) return false;
  if (schema.type !== undefined || schema.properties !== undefined) {
    return false;
  }
  const members = unionMembers(schema);
  return (
    members.length > 0 &&
    members.every(
      (member) => objectMemberContent(member, context, false) !== undefined,
    )
  );
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Resolve `#` and local JSON Pointers (`#/a/b/0`) against the root schema. */
function localRefResolver(root: JsonSchemaValue): SchemaResolver {
  return (ref) => {
    if (ref === '#') return root;
    if (!ref.startsWith('#/')) return undefined;
    let current: JsonSchemaValue | undefined = root;
    for (const raw of ref.slice(2).split('/')) {
      const segment = decodePointerSegment(raw);
      if (Array.isArray(current)) {
        current = /^(0|[1-9][0-9]*)$/.test(segment)
          ? current[Number(segment)]
          : undefined;
      } else if (current !== undefined && isJsonObject(current)) {
        current = hasOwn(current, segment) ? current[segment] : undefined;
      } else {
        return undefined;
      }
    }
    return current;
  };
}

interface StripContext extends AcceptsNullContext {
  resolve: SchemaResolver;
  nullStringPlaceholders: boolean;
}

/** Options for {@link stripStrictNulls}. */
export interface StripStrictNullsOptions {
  /**
   * Also treat the string "null" as an omitted value on an object key the
   * stripper would delete a real `null` from, unless the key's schema names
   * "null" through `const` or `enum`. Union branches are still matched on the
   * real values. Off by default.
   */
  nullStringPlaceholders?: boolean;
}

const NULL_STRING = 'null';

/**
 * Whether a property value is the string "null" standing in for an omitted
 * value: only with the option on, and never when the property's schema names
 * "null" literally. The caller still applies the optional-key and
 * accepts-null checks it uses for a real `null`.
 */
function isNullStringPlaceholder(
  member: JsonSchemaValue,
  propertySchema: JsonSchemaValue | undefined,
  context: StripContext,
): boolean {
  return (
    member === NULL_STRING &&
    context.nullStringPlaceholders &&
    !namesNullString(propertySchema, context)
  );
}

/**
 * True when a schema names the string "null" through `const` or `enum`,
 * directly, in a union or `allOf` member, or behind a resolved local `$ref`.
 */
function namesNullString(
  schema: JsonSchemaValue | undefined,
  context: StripContext,
  refs: RefPath = NO_REFS,
): boolean {
  if (schema === undefined || !isJsonObject(schema)) return false;
  // Past the budget, keep the string rather than guess.
  if (!context.budget.spend()) return true;
  if (hasOwn(schema, 'const') && schema.const === NULL_STRING) return true;
  if (Array.isArray(schema.enum) && schema.enum.includes(NULL_STRING)) {
    return true;
  }
  for (const members of [schema.anyOf, schema.oneOf, schema.allOf]) {
    if (
      Array.isArray(members) &&
      members.some((member) => namesNullString(member, context, refs))
    ) {
      return true;
    }
  }
  const ref = schema.$ref;
  if (typeof ref !== 'string' || refs.has(ref)) return false;
  const target = context.resolve(ref);
  return (
    target !== undefined && namesNullString(target, context, withRef(refs, ref))
  );
}

interface ResolvedSchema {
  schema: JsonSchemaObject;
  refs: RefPath;
}

/**
 * Follow `$ref`s to a concrete schema. A target already expanded on the
 * current path is never expanded again, so reference cycles stay unresolved.
 */
function resolveForStrip(
  schema: JsonSchemaValue | undefined,
  context: StripContext,
  refs: RefPath,
): ResolvedSchema | undefined {
  let current = schema;
  let path = refs;
  for (let hops = 0; hops <= MAX_REF_HOPS; hops += 1) {
    context.budget.spend();
    if (current === undefined || !isJsonObject(current)) return undefined;
    if (current.allOf !== undefined) {
      current = withoutAllOf(current, '#', undefined);
    }
    const ref = current.$ref;
    if (typeof ref !== 'string') return { schema: current, refs: path };
    if (path.has(ref)) return undefined;
    path = withRef(path, ref);
    current = context.resolve(ref);
  }
  return undefined;
}

function isPlainValueObject(value: JsonSchemaValue): value is JsonSchemaObject {
  return isJsonObject(value);
}

function matchesJsonType(
  type: JsonSchemaValue,
  value: JsonSchemaValue,
): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isJsonObject(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return false;
  }
}

/** True when a schema declares no `type`, or the value has one of its types. */
function matchesDeclaredType(
  type: JsonSchemaValue | undefined,
  value: JsonSchemaValue,
): boolean {
  if (type === undefined) return true;
  return Array.isArray(type)
    ? type.some((member) => matchesJsonType(member, value))
    : matchesJsonType(type, value);
}

function matchesConstAndEnum(
  schema: JsonSchemaObject,
  value: JsonSchemaValue,
): boolean {
  const constant = schema.const;
  if (
    hasOwn(schema, 'const') &&
    constant !== undefined &&
    !deepEqual(constant, value)
  ) {
    return false;
  }
  const allowed = schema.enum;
  return (
    !Array.isArray(allowed) ||
    allowed.some((option) => deepEqual(option, value))
  );
}

/**
 * A merged union branch viewed as layers instead of a copied object: the
 * innermost member first, then each enclosing parent. Properties and
 * `additionalProperties` come from the innermost layer that declares them and
 * `required` lists combine, exactly as {@link mergeUnionBranch} merges them,
 * without copying a growing property map at every level.
 */
interface BranchLayer {
  schema: JsonSchemaObject;
  parent?: BranchLayer;
}

function layerProperty(
  layer: BranchLayer,
  key: string,
): { schema: JsonSchemaValue } | undefined {
  for (let current: BranchLayer | undefined = layer; current; ) {
    const properties = objectMember(current.schema, 'properties');
    const schema = hasOwn(properties, key) ? properties[key] : undefined;
    if (schema !== undefined) return { schema };
    current = current.parent;
  }
  return undefined;
}

function layerIsClosed(layer: BranchLayer): boolean {
  for (let current: BranchLayer | undefined = layer; current; ) {
    const additional = current.schema.additionalProperties;
    if (additional !== undefined) return additional === false;
    current = current.parent;
  }
  return false;
}

function layerRequired(layer: BranchLayer): string[] {
  const lists: JsonSchemaValue[] = [];
  for (let current: BranchLayer | undefined = layer; current; ) {
    if (current.schema.required !== undefined) {
      lists.push(current.schema.required);
    }
    current = current.parent;
  }
  return orderedStrings(...lists);
}

function objectUnionMembers(
  schema: JsonSchemaObject,
  context: StripContext,
  refs: RefPath,
): ResolvedSchema[] {
  const members: ResolvedSchema[] = [];
  const parentIsObject = isObjectSchema(schema);
  for (const member of unionMembers(schema)) {
    const resolved = resolveForStrip(member, context, refs);
    if (
      resolved !== undefined &&
      isObjectBranch(resolved.schema, parentIsObject)
    ) {
      members.push(resolved);
    }
  }
  return members;
}

function hasDirectItems(schema: JsonSchemaObject): boolean {
  return schema.items !== undefined || schema.prefixItems !== undefined;
}

function elementSchema(
  schema: JsonSchemaObject,
  index: number,
): JsonSchemaValue | undefined {
  const prefix = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : Array.isArray(schema.items)
      ? schema.items
      : [];
  if (index < prefix.length) return prefix[index];
  return schema.items !== undefined && !Array.isArray(schema.items)
    ? schema.items
    : undefined;
}

/**
 * Whether an object value conforms to a merged union branch: a nested union
 * through any sub-branch; otherwise every key is listed (unless the branch
 * stays open), every non-null value conforms to its property, a `null` is
 * either accepted by the property or for an optional key, and every required
 * key is present and non-null unless its property accepts null.
 */
function objectConforms(
  value: JsonSchemaObject,
  layer: BranchLayer,
  context: StripContext,
  refs: RefPath,
  depth: number,
): boolean {
  if (depth > MAX_STRIP_DEPTH) return false;
  context.budget.spend();
  const subBranches = objectUnionMembers(layer.schema, context, refs);
  if (subBranches.length > 0) {
    return subBranches.some((member) =>
      objectConforms(
        value,
        { schema: member.schema, parent: layer },
        context,
        member.refs,
        depth + 1,
      ),
    );
  }
  const required = layerRequired(layer);
  const requiredNames = new Set(required);
  const closed = layerIsClosed(layer);
  for (const [key, member] of Object.entries(value)) {
    if (member === undefined) continue;
    const declared = layerProperty(layer, key);
    if (declared === undefined) {
      if (closed) return false;
      continue;
    }
    if (member === null) {
      if (requiredNames.has(key) && !acceptsNull(declared.schema, context)) {
        return false;
      }
      continue;
    }
    if (!conforms(member, declared.schema, context, NO_REFS, depth + 1)) {
      return false;
    }
  }
  for (const name of required) {
    const present = hasOwn(value, name) ? value[name] : undefined;
    if (
      present === undefined &&
      !acceptsNull(layerProperty(layer, name)?.schema, context)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Whether a value conforms to a schema, recursively: declared types, `const`
 * and `enum`, union members, object properties and array items, following
 * local `$ref`s. Other assertions are not checked.
 */
function conforms(
  value: JsonSchemaValue,
  schema: JsonSchemaValue | undefined,
  context: StripContext,
  refs: RefPath,
  depth: number,
): boolean {
  if (depth > MAX_STRIP_DEPTH) return false;
  context.budget.spend();
  if (schema === undefined || schema === true) return true;
  if (schema === false) return false;
  const found = resolveForStrip(schema, context, refs);
  if (found === undefined) return true;
  const resolved = found.schema;
  if (value === null) return acceptsNull(resolved, context, found.refs);
  if (!matchesDeclaredType(resolved.type, value)) return false;
  if (!matchesConstAndEnum(resolved, value)) return false;
  if (isPlainValueObject(value)) {
    const branches = objectUnionMembers(resolved, context, found.refs);
    if (branches.length > 0) {
      return branches.some((member) =>
        objectConforms(
          value,
          { schema: member.schema, parent: { schema: resolved } },
          context,
          member.refs,
          depth + 1,
        ),
      );
    }
  }
  const members = unionMembers(resolved);
  // An object union's branches only describe its objects; any other value
  // has already matched one of the parent's declared types.
  if (
    !isPlainValueObject(value) &&
    resolved.type !== undefined &&
    isObjectSchema(resolved) &&
    objectUnionMembers(resolved, context, found.refs).length > 0
  ) {
    return true;
  }
  if (
    members.length > 0 &&
    !members.some((member) =>
      conforms(value, member, context, found.refs, depth + 1),
    )
  ) {
    return false;
  }
  if (isPlainValueObject(value) && isObjectSchema(resolved)) {
    return objectConforms(
      value,
      { schema: resolved },
      context,
      found.refs,
      depth + 1,
    );
  }
  if (Array.isArray(value) && hasDirectItems(resolved)) {
    return value.every((item, index) =>
      conforms(
        item,
        elementSchema(resolved, index),
        context,
        NO_REFS,
        depth + 1,
      ),
    );
  }
  return true;
}

function stripValue(
  value: JsonSchemaValue,
  schema: JsonSchemaValue | undefined,
  context: StripContext,
  refs: RefPath,
  depth: number,
): JsonSchemaValue {
  if (depth > MAX_STRIP_DEPTH) return value;
  context.budget.spend();
  const found = resolveForStrip(schema, context, refs);
  if (found === undefined) return value;
  const resolved = found.schema;

  if (isPlainValueObject(value)) {
    const members = objectUnionMembers(resolved, context, found.refs);
    if (members.length > 0) {
      for (const member of members) {
        const layer = { schema: member.schema, parent: { schema: resolved } };
        if (objectConforms(value, layer, context, member.refs, 0)) {
          return stripValue(
            value,
            mergeUnionBranch(resolved, member.schema),
            context,
            member.refs,
            depth + 1,
          );
        }
      }
      return value;
    }
    if (!isObjectSchema(resolved)) return value;
    const properties = objectMember(resolved, 'properties');
    const required = stringSet(resolved.required);
    const result: JsonSchemaObject = {};
    for (const [key, member] of Object.entries(value)) {
      if (member === undefined) continue;
      if (!hasOwn(properties, key)) {
        setOwn(result, key, member);
        continue;
      }
      const propertySchema = properties[key];
      if (
        (member === null ||
          isNullStringPlaceholder(member, propertySchema, context)) &&
        !required.has(key) &&
        !acceptsNull(propertySchema, context)
      ) {
        continue;
      }
      setOwn(
        result,
        key,
        stripValue(member, propertySchema, context, NO_REFS, depth + 1),
      );
    }
    return result;
  }

  if (Array.isArray(value)) {
    if (!hasDirectItems(resolved)) {
      // Items that exist only in union branches: pick the first branch the
      // whole array conforms to, then strip through it.
      for (const member of unionMembers(resolved)) {
        if (conforms(value, member, context, found.refs, 0)) {
          return stripValue(value, member, context, found.refs, depth + 1);
        }
      }
      return value;
    }
    return value.map((item, index) =>
      stripValue(
        item,
        elementSchema(resolved, index),
        context,
        NO_REFS,
        depth + 1,
      ),
    );
  }
  return value;
}

/**
 * Undo the nullability {@link toStrictToolSchema} introduced: walk a tool
 * call's arguments alongside the tool's ORIGINAL schema (with its definitions
 * hoisted the same way) and delete each key whose value is `null` when that
 * key was optional and its schema never accepted null. Required keys and
 * nullable properties keep their `null`; keys the schema does not list are
 * untouched. With `nullStringPlaceholders`, the string "null" is deleted on
 * the same terms unless the key's schema names "null" through `const` or
 * `enum`. Returns a new value, or the original value unchanged when the walk
 * exceeds its work budget or the value or schema is nested deeper than
 * `MAX_TOOL_SCHEMA_DEPTH`.
 */
export function stripStrictNulls(
  value: JsonSchemaValue,
  originalSchema: JsonSchemaValue,
  options: StripStrictNullsOptions = {},
): JsonSchemaValue {
  const valueShape = measureJson(value);
  if (
    valueShape.depth > MAX_TOOL_SCHEMA_DEPTH ||
    measureJson(originalSchema).depth > MAX_TOOL_SCHEMA_DEPTH
  ) {
    return value;
  }
  const budget = new WorkBudget(
    WORK_BUDGET_BASE + STRIP_VISITS_PER_VALUE_NODE * valueShape.nodes,
    () => {
      throw new WorkBudgetExceeded();
    },
  );
  try {
    const hoisted = hoistDefinitions(originalSchema, budget);
    if (hoisted === undefined) return value;
    const context: StripContext = {
      resolve: localRefResolver(hoisted),
      budget,
      nullStringPlaceholders: options.nullStringPlaceholders === true,
    };
    return stripValue(value, hoisted, context, withRef(NO_REFS, '#'), 0);
  } catch (error) {
    if (error instanceof WorkBudgetExceeded) return value;
    throw error;
  }
}
