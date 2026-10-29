import { z, type ZodType } from 'zod';
import { CanopyErrorPayloadSchema, type CanopyErrorPayload } from './errors';

import {
  CanopyGrantNameSchema,
  CanopyOperationNameSchema,
  getCanopyNameDomain,
  getCanopyNamePlane,
  type CanopyGrantName,
  type CanopyPlane,
  type PlaneQualifiedName,
  type ValidPlaneQualifiedName,
} from './names';

export type CanopySchema = ZodType;
export type CanopySchemaInput<Schema extends CanopySchema> = z.input<Schema>;
export type CanopySchemaOutput<Schema extends CanopySchema> = z.output<Schema>;

export function safeParseCanopySchema<Schema extends CanopySchema>(
  schema: Schema,
  value: unknown,
): z.ZodSafeParseResult<CanopySchemaOutput<Schema>> {
  return schema.safeParse(value);
}

export const CANOPY_OPERATION_PLACEMENTS = [
  'core-only',
  'worker-only',
  'target-selectable',
] as const;
export type CanopyOperationPlacement =
  (typeof CANOPY_OPERATION_PLACEMENTS)[number];

export const CANOPY_IDEMPOTENCY_KINDS = ['inherent', 'keyed', 'none'] as const;
export type CanopyIdempotency = (typeof CANOPY_IDEMPOTENCY_KINDS)[number];

export const CanopyStreamCursorSchema = z.strictObject({
  daemonEpoch: z.string().min(1).max(512),
  sequence: z.number().int().nonnegative(),
});
export type CanopyStreamCursor = z.output<typeof CanopyStreamCursorSchema>;
export const CanopyStreamEndSchema = z.strictObject({
  cursor: CanopyStreamCursorSchema,
  outcome: z.enum(['completed', 'cancelled', 'error']),
  error: CanopyErrorPayloadSchema.nullable(),
});

export interface CanopyOperationDefinition<
  Kind extends 'query' | 'instruction' = 'query' | 'instruction',
  Plane extends CanopyPlane = CanopyPlane,
  Domain extends string = string,
  Grants extends readonly CanopyGrantName[] = readonly CanopyGrantName[],
  Params extends ZodType = ZodType,
  Result extends ZodType = ZodType,
> {
  readonly kind: Kind;
  readonly plane: Plane;
  readonly domain: Domain;
  readonly version: number;
  readonly placement: CanopyOperationPlacement;
  readonly idempotency: CanopyIdempotency;
  readonly requiredGrants: Grants;
  readonly params: Params;
  readonly result: Result;
  readonly error: ZodType<CanopyErrorPayload>;
}

export type CanopyQueryDefinition<
  Plane extends CanopyPlane = CanopyPlane,
  Domain extends string = string,
  Grants extends readonly CanopyGrantName[] = readonly CanopyGrantName[],
  Params extends ZodType = ZodType,
  Result extends ZodType = ZodType,
> = CanopyOperationDefinition<'query', Plane, Domain, Grants, Params, Result>;

export type CanopyInstructionDefinition<
  Plane extends CanopyPlane = CanopyPlane,
  Domain extends string = string,
  Grants extends readonly CanopyGrantName[] = readonly CanopyGrantName[],
  Params extends ZodType = ZodType,
  Result extends ZodType = ZodType,
> = CanopyOperationDefinition<
  'instruction',
  Plane,
  Domain,
  Grants,
  Params,
  Result
>;

/** @deprecated Use CanopyInstructionDefinition. */
export type CanopyCommandDefinition<
  Plane extends CanopyPlane = CanopyPlane,
  Domain extends string = string,
  Grants extends readonly CanopyGrantName[] = readonly CanopyGrantName[],
  Params extends ZodType = ZodType,
  Result extends ZodType = ZodType,
> = CanopyInstructionDefinition<Plane, Domain, Grants, Params, Result>;

export interface CanopyStreamDefinition<
  Plane extends CanopyPlane = CanopyPlane,
  Domain extends string = string,
  Grants extends readonly CanopyGrantName[] = readonly CanopyGrantName[],
  Params extends ZodType = ZodType,
  Item extends ZodType = ZodType,
  End extends ZodType = ZodType,
> {
  readonly kind: 'stream';
  readonly plane: Plane;
  readonly domain: Domain;
  readonly version: number;
  readonly placement: CanopyOperationPlacement;
  readonly idempotency: 'inherent';
  readonly requiredGrants: Grants;
  readonly params: Params;
  readonly item: Item;
  readonly end: End;
  readonly openResult?: ZodType;
  readonly error: ZodType<CanopyErrorPayload>;
}

type CanopyOperationDefinitionInput<
  Plane extends CanopyPlane,
  Domain extends string,
  Grants extends readonly CanopyGrantName[],
  Params extends ZodType,
  Result extends ZodType,
> = Omit<
  CanopyOperationDefinition<
    'query' | 'instruction',
    Plane,
    Domain,
    Grants,
    Params,
    Result
  >,
  'kind' | 'placement'
> & {
  readonly placement: Plane extends 'core'
    ? Exclude<CanopyOperationPlacement, 'worker-only'>
    : Exclude<CanopyOperationPlacement, 'core-only'>;
};

export function defineCanopyQuery<
  const Plane extends CanopyPlane,
  const Domain extends string,
  const Grants extends readonly PlaneQualifiedName<Plane>[],
  Params extends ZodType,
  Result extends ZodType,
>(
  definition: CanopyOperationDefinitionInput<
    Plane,
    Domain,
    Grants,
    Params,
    Result
  >,
): CanopyQueryDefinition<Plane, Domain, Grants, Params, Result> {
  return { kind: 'query', ...definition };
}

export function defineCanopyInstruction<
  const Plane extends CanopyPlane,
  const Domain extends string,
  const Grants extends readonly PlaneQualifiedName<Plane>[],
  Params extends ZodType,
  Result extends ZodType,
>(
  definition: CanopyOperationDefinitionInput<
    Plane,
    Domain,
    Grants,
    Params,
    Result
  >,
): CanopyInstructionDefinition<Plane, Domain, Grants, Params, Result> {
  return { kind: 'instruction', ...definition };
}

/** @deprecated Use defineCanopyInstruction. */
export const defineCanopyCommand = defineCanopyInstruction;

export function defineCanopyStream<
  const Plane extends CanopyPlane,
  const Domain extends string,
  const Grants extends readonly PlaneQualifiedName<Plane>[],
  Params extends ZodType,
  Item extends ZodType,
  End extends ZodType,
>(
  definition: Omit<
    CanopyStreamDefinition<Plane, Domain, Grants, Params, Item, End>,
    'kind' | 'placement'
  > & {
    readonly placement: Plane extends 'core'
      ? Exclude<CanopyOperationPlacement, 'worker-only'>
      : Exclude<CanopyOperationPlacement, 'core-only'>;
  },
): CanopyStreamDefinition<Plane, Domain, Grants, Params, Item, End> {
  return { kind: 'stream', ...definition };
}

export type CanopyQueryDefinitionMap = Readonly<
  Record<string, CanopyQueryDefinition>
>;
export type CanopyInstructionDefinitionMap = Readonly<
  Record<string, CanopyInstructionDefinition>
>;
export type CanopyStreamDefinitionMap = Readonly<
  Record<string, CanopyStreamDefinition>
>;

type RegistryDefinitionConstraint<
  Plane extends CanopyPlane,
  Definitions extends Readonly<
    Record<
      string,
      | CanopyQueryDefinition
      | CanopyInstructionDefinition
      | CanopyStreamDefinition
    >
  >,
> = {
  [Name in keyof Definitions]: Name extends string
    ? ValidPlaneQualifiedName<Name, Plane> extends never
      ? never
      : Definitions[Name]['plane'] extends Plane
        ? Definitions[Name]
        : never
    : never;
};

function assertDefinitionMatchesRegistry(
  registryPlane: CanopyPlane,
  name: string,
  definition:
    | CanopyQueryDefinition
    | CanopyInstructionDefinition
    | CanopyStreamDefinition,
  kind: 'query' | 'instruction' | 'stream',
): void {
  const parsedName = CanopyOperationNameSchema.parse(name);
  const namePlane = getCanopyNamePlane(parsedName);
  if (namePlane !== registryPlane || definition.plane !== registryPlane) {
    throw new Error(
      `${kind} ${name} plane metadata must match its ${registryPlane} registry`,
    );
  }
  if (getCanopyNameDomain(parsedName) !== definition.domain) {
    throw new Error(`${kind} ${name} domain metadata does not match its name`);
  }
  if (definition.kind !== kind) {
    throw new Error(`${kind} ${name} must declare kind ${kind}`);
  }
  if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
    throw new Error(`${kind} ${name} must declare a positive integer version`);
  }
  if (!CANOPY_OPERATION_PLACEMENTS.includes(definition.placement)) {
    throw new Error(`${kind} ${name} has an invalid placement`);
  }
  if (!CANOPY_IDEMPOTENCY_KINDS.includes(definition.idempotency)) {
    throw new Error(
      `${kind} ${name} has an invalid idempotency classification`,
    );
  }
  if (kind === 'stream' && definition.idempotency !== 'inherent') {
    throw new Error(`stream ${name} must be inherently idempotent`);
  }
  if (kind === 'query' && definition.idempotency !== 'inherent') {
    throw new Error(`query ${name} must be inherently idempotent`);
  }
  if (
    (registryPlane === 'core' && definition.placement === 'worker-only') ||
    (registryPlane === 'worker' && definition.placement === 'core-only')
  ) {
    throw new Error(`${kind} ${name} placement disagrees with its plane`);
  }
  for (const grant of definition.requiredGrants) {
    const parsedGrant = CanopyGrantNameSchema.parse(grant);
    if (getCanopyNamePlane(parsedGrant) !== registryPlane) {
      throw new Error(
        `${kind} ${name} requires a grant owned by another plane`,
      );
    }
  }
  if (!(definition.params instanceof z.ZodType)) {
    throw new Error(`${kind} ${name} must declare a params schema`);
  }
  if (!(definition.error instanceof z.ZodType)) {
    throw new Error(`${kind} ${name} must declare an error schema`);
  }
  if (kind === 'stream') {
    if (
      !('item' in definition) ||
      !(definition.item instanceof z.ZodType) ||
      !('end' in definition) ||
      !(definition.end instanceof z.ZodType)
    ) {
      throw new Error(`stream ${name} must declare item and end schemas`);
    }
    if (
      !(definition.params instanceof z.ZodObject) ||
      !('cursor' in definition.params.shape)
    ) {
      throw new Error(`stream ${name} params must include cursor`);
    }
  } else if (
    !('result' in definition) ||
    !(definition.result instanceof z.ZodType)
  ) {
    throw new Error(`${kind} ${name} must declare a result schema`);
  }
}

export function defineCanopyQueryRegistry<
  const Plane extends CanopyPlane,
  const Definitions extends CanopyQueryDefinitionMap,
>(
  plane: Plane,
  definitions: Definitions & RegistryDefinitionConstraint<Plane, Definitions>,
): Definitions {
  for (const [name, definition] of Object.entries(definitions)) {
    assertDefinitionMatchesRegistry(plane, name, definition, 'query');
  }
  return definitions;
}

type UnionToIntersection<Union> = (
  Union extends unknown ? (value: Union) => void : never
) extends (value: infer Intersection) => void
  ? Intersection
  : never;

export function composeCanopyQueryRegistries<
  const Registries extends readonly CanopyQueryDefinitionMap[],
>(...registries: Registries): UnionToIntersection<Registries[number]>;
export function composeCanopyQueryRegistries(
  ...registries: readonly CanopyQueryDefinitionMap[]
): CanopyQueryDefinitionMap {
  const composed: Record<string, CanopyQueryDefinition> = {};
  for (const registry of registries) {
    for (const [name, definition] of Object.entries(registry)) {
      if (Object.prototype.hasOwnProperty.call(composed, name)) {
        throw new Error(`Duplicate Canopy query definition: ${name}`);
      }
      const namePlane = getCanopyNamePlane(
        CanopyOperationNameSchema.parse(name),
      );
      assertDefinitionMatchesRegistry(namePlane, name, definition, 'query');
      composed[name] = definition;
    }
  }
  return composed;
}

export function defineCanopyInstructionRegistry<
  const Plane extends CanopyPlane,
  const Definitions extends CanopyInstructionDefinitionMap,
>(
  plane: Plane,
  definitions: Definitions & RegistryDefinitionConstraint<Plane, Definitions>,
): Definitions {
  for (const [name, definition] of Object.entries(definitions))
    assertDefinitionMatchesRegistry(plane, name, definition, 'instruction');
  return definitions;
}

export function defineCanopyStreamRegistry<
  const Plane extends CanopyPlane,
  const Definitions extends CanopyStreamDefinitionMap,
>(
  plane: Plane,
  definitions: Definitions & RegistryDefinitionConstraint<Plane, Definitions>,
): Definitions {
  for (const [name, definition] of Object.entries(definitions))
    assertDefinitionMatchesRegistry(plane, name, definition, 'stream');
  return definitions;
}

export function composeCanopyInstructionRegistries<
  const Registries extends readonly CanopyInstructionDefinitionMap[],
>(...registries: Registries): UnionToIntersection<Registries[number]>;
export function composeCanopyInstructionRegistries(
  ...registries: readonly CanopyInstructionDefinitionMap[]
): CanopyInstructionDefinitionMap {
  const composed: Record<string, CanopyInstructionDefinition> = {};
  for (const registry of registries)
    for (const [name, definition] of Object.entries(registry)) {
      if (Object.prototype.hasOwnProperty.call(composed, name))
        throw new Error(`Duplicate Canopy instruction definition: ${name}`);
      assertDefinitionMatchesRegistry(
        getCanopyNamePlane(CanopyOperationNameSchema.parse(name)),
        name,
        definition,
        'instruction',
      );
      composed[name] = definition;
    }
  return composed;
}

export function composeCanopyStreamRegistries<
  const Registries extends readonly CanopyStreamDefinitionMap[],
>(...registries: Registries): UnionToIntersection<Registries[number]>;
export function composeCanopyStreamRegistries(
  ...registries: readonly CanopyStreamDefinitionMap[]
): CanopyStreamDefinitionMap {
  const composed: Record<string, CanopyStreamDefinition> = {};
  for (const registry of registries)
    for (const [name, definition] of Object.entries(registry)) {
      if (Object.prototype.hasOwnProperty.call(composed, name))
        throw new Error(`Duplicate Canopy stream definition: ${name}`);
      assertDefinitionMatchesRegistry(
        getCanopyNamePlane(CanopyOperationNameSchema.parse(name)),
        name,
        definition,
        'stream',
      );
      composed[name] = definition;
    }
  return composed;
}

/** Compile-only helper for consumers that define their own closed registries. */
export type CanopyRegistryName<
  Name extends string,
  Plane extends CanopyPlane,
> = ValidPlaneQualifiedName<Name, Plane>;

export type CanopyDefinitionName = PlaneQualifiedName;
