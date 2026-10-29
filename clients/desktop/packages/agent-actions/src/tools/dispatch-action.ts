import { z } from 'zod';
import type { AgentActionBrand } from '../brand';
import type { AgentJson } from '../response';
import { agentActionCodexToolName } from '../tool-keys';
import type { AgentJsonSchema } from './definition';

/**
 * UI-state fields a generic agent action never accepts: the trusted runtime,
 * not the model, decides what the user is looking at.
 */
export const GENERIC_UI_ONLY_ACTION_FIELDS: ReadonlySet<string> = new Set([
  'route',
  'page',
  'tab',
  'panel',
  'panelId',
  'focus',
  'focused',
  'selection',
  'selectedId',
  'currentUiState',
  'uiState',
  'navigationTarget',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The first generic UI-only field of `value`, prefixed with `path`, or null.
 * `isExempt` lets a family accept a field that is not UI state for one of
 * its actions.
 */
export function findUiOnlyActionField(
  value: Record<string, unknown>,
  path = '',
  isExempt: (field: string) => boolean = () => false,
): string | null {
  const key = Object.keys(value).find(
    (entry) => GENERIC_UI_ONLY_ACTION_FIELDS.has(entry) && !isExempt(entry),
  );
  return key ? `${path}${key}` : null;
}

export function uiOnlyActionFieldMessage(field: string): string {
  return `UI-only field "${field}" is not accepted by generic actions.`;
}

/**
 * Remove the scope ids a caller may echo back. They are the only fields that
 * are dropped rather than rejected: the runtime applies its trusted scope.
 * `keep` names the ones the action's family takes as explicit targets.
 */
export function stripAgentActionScopeFields(
  value: unknown,
  keep: readonly string[] = [],
): unknown {
  if (!isRecord(value)) return value;
  const { projectId, worktreeId, ...action } = value;
  return {
    ...action,
    ...(projectId !== undefined && keep.includes('projectId')
      ? { projectId }
      : {}),
    ...(worktreeId !== undefined && keep.includes('worktreeId')
      ? { worktreeId }
      : {}),
  };
}

/**
 * The DispatchAction input envelope: `{ action }`, with the caller's scope
 * ids stripped and, when `findUiOnlyField` is given, UI-only fields rejected
 * before `actionSchema` runs.
 */
export function createDispatchActionInputSchema<TAction>(
  actionSchema: z.ZodType<TAction>,
  options: {
    findUiOnlyField?: (value: unknown) => string | null;
    /** The scope fields this action keeps as explicit targets. */
    keepScopeFields?: (value: unknown) => readonly string[];
  } = {},
): z.ZodType<{ action: TAction }> {
  const keepScopeFields = options.keepScopeFields;
  const findUiOnlyField = options.findUiOnlyField;
  const uiFreeActionSchema = findUiOnlyField
    ? z.unknown().superRefine((value, context) => {
        const field = findUiOnlyField(value);
        if (field) {
          context.addIssue({
            code: 'custom',
            message: uiOnlyActionFieldMessage(field),
          });
        }
      })
    : z.unknown();
  return z.object({
    action: z.preprocess(
      (value) =>
        stripAgentActionScopeFields(value, keepScopeFields?.(value) ?? []),
      uiFreeActionSchema.pipe(actionSchema),
    ),
  });
}

export interface DispatchActionJsonSchemaOptions {
  /** Advertised action types, in enum order. */
  actionTypes: readonly string[];
  /** Action payload properties beside `type`. */
  properties?: AgentJsonSchema;
  /** Per-type conditional requirements. */
  allOf?: readonly AgentJson[];
  /** Scope-named fields some advertised actions take as explicit targets. */
  targetFields?: readonly string[];
}

/** One family's share of the advertised DispatchAction payload. */
export interface DispatchActionJsonSchemaPart {
  /** Advertised action types, in enum order. */
  actionTypes: readonly string[];
  properties?: AgentJsonSchema;
  allOf?: readonly AgentJson[];
  targetFields?: readonly string[];
}

function canonicalJson(value: AgentJson): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function withoutDescription(schema: AgentJsonSchema): AgentJsonSchema {
  const { description: _description, ...rest } = schema;
  void _description;
  return rest;
}

function isJsonSchemaObject(value: AgentJson): value is AgentJsonSchema {
  return isRecord(value);
}

/**
 * Reconcile two families' schemas for one payload property, in family order:
 * identical schemas are kept, schemas that differ only in their description
 * keep one schema with both descriptions, and any other pair is advertised as
 * `anyOf` so neither family's constraint is lost.
 */
export function mergeDispatchActionProperty(
  existing: AgentJson,
  next: AgentJson,
): AgentJson {
  if (canonicalJson(existing) === canonicalJson(next)) return existing;
  if (!isJsonSchemaObject(existing) || !isJsonSchemaObject(next)) {
    return { anyOf: [existing, next] };
  }
  if (
    canonicalJson(withoutDescription(existing)) ===
    canonicalJson(withoutDescription(next))
  ) {
    const descriptions = [existing.description, next.description].filter(
      (description): description is string =>
        typeof description === 'string' && description.length > 0,
    );
    return {
      ...withoutDescription(existing),
      ...(descriptions.length > 0
        ? { description: Array.from(new Set(descriptions)).join(' ') }
        : {}),
    };
  }
  const branches = Array.isArray(existing.anyOf) ? existing.anyOf : [existing];
  if (branches.some((branch) => canonicalJson(branch) === canonicalJson(next)))
    return existing;
  return { anyOf: [...branches, next] };
}

/**
 * The DispatchAction input schema of several families: their action types in
 * family order, their properties reconciled by
 * {@link mergeDispatchActionProperty}, and their conditionals concatenated.
 * A shared property is listed where the last family declares it, so adding a
 * family in front leaves the later families' layout unchanged.
 */
export function composeDispatchActionJsonSchema(
  brand: AgentActionBrand,
  parts: readonly DispatchActionJsonSchemaPart[],
): AgentJsonSchema {
  const properties = new Map<string, AgentJson>();
  for (const part of parts) {
    for (const [name, schema] of Object.entries(part.properties ?? {})) {
      const existing = properties.get(name);
      properties.delete(name);
      properties.set(
        name,
        existing === undefined
          ? schema
          : mergeDispatchActionProperty(existing, schema),
      );
    }
  }
  const targetFields = Array.from(
    new Set(
      parts.flatMap((part) =>
        part.actionTypes.length > 0 ? (part.targetFields ?? []) : [],
      ),
    ),
  );
  return buildDispatchActionJsonSchema(brand, {
    actionTypes: parts.flatMap((part) => part.actionTypes),
    properties: Object.fromEntries(properties),
    allOf: parts.flatMap((part) => part.allOf ?? []),
    ...(targetFields.length > 0 ? { targetFields } : {}),
  });
}

export function buildDispatchActionJsonSchema(
  brand: AgentActionBrand,
  options: DispatchActionJsonSchemaOptions,
): AgentJsonSchema {
  const allOf = options.allOf ?? [];
  const targetFields = options.targetFields ?? [];
  const scopeRule =
    targetFields.length > 0
      ? `Do not include projectId or worktreeId, except ${targetFields.join(' or ')} where an action takes it as an explicit target.`
      : 'Do not include projectId or worktreeId.';
  return {
    type: 'object',
    properties: {
      action: {
        type: 'object',
        description: `One chat-scoped ${brand.displayName} action payload. Use SearchActions / ${agentActionCodexToolName(brand, 'search_actions')} to discover the exact type and required fields. ${scopeRule}`,
        required: ['type'],
        properties: {
          type: { type: 'string', enum: [...options.actionTypes] },
          ...options.properties,
        },
        ...(allOf.length > 0 ? { allOf: [...allOf] } : {}),
        additionalProperties: true,
      },
    },
    required: ['action'],
    additionalProperties: false,
  };
}
