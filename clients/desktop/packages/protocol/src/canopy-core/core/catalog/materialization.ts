import { z } from 'zod';

import { stableStringify } from '../../../lib/stable-stringify';
import type { CanopyWorkspaceScope } from '../../common';
import {
  EXECUTION_SECRET_BINDINGS_MAX,
  STORED_SECRET_REF_PATTERN,
  type ExecutionSecretBinding,
} from '../../worker/execution-secrets';

/*
 * Catalog materialization identity (CAN-4123): content-addressed and
 * immutable. The hashing lives with the core runtime; these are the pure
 * inputs both sides hash.
 */
export const CATALOG_SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const CATALOG_MATERIALIZATION_ID_PREFIX = 'catalog-materialization:v1:';
export const CATALOG_MATERIALIZATION_ID_PATTERN =
  /^catalog-materialization:v1:[0-9a-f]{64}$/;
export const CATALOG_MATERIALIZATION_LIMITS = {
  items: 1024,
  diagnostics: 2048,
} as const;

/** One plugin to materialize; providers sorted claude, codex. */
export const CatalogMaterializationPluginDescriptorSchema = z.strictObject({
  kind: z.literal('plugin'),
  entryId: z.string().min(1).max(512),
  marketplaceId: z.string().min(1).max(512),
  pluginName: z.string().min(1).max(512),
  providers: z
    .array(z.enum(['claude', 'codex']))
    .min(1)
    .max(2),
  pluginRevision: z.string().regex(CATALOG_SHA256_PATTERN),
});

/** Prefix of the binding names a materialization's MCP secrets are redeemed under. */
export const CATALOG_MCP_SECRET_BINDING_PREFIX = 'CANOPY_MCP_SECRET_';

/** One selected MCP server configuration to materialize (CAN-4125). */
export const CatalogMaterializationMcpServerDescriptorSchema = z.strictObject({
  kind: z.literal('mcp_server'),
  entryId: z.string().min(1).max(512),
  serverId: z.string().min(1).max(512),
  configId: z.string().min(1).max(512),
  transport: z.enum(['stdio', 'http']),
  /** `device`: this device's configuration; `account`: the account connection, reached through the existing cloud MCP route. */
  binding: z.enum(['device', 'account']),
  /** SHA-256 of the secret-free projected configuration and its index entry. */
  configRevision: z.string().regex(CATALOG_SHA256_PATTERN),
  /** Sorted, unique CAN-4411 references (family `mcp.server`, record `serverId`) of the secrets the server needs. Never values. */
  secretRefs: z
    .array(z.string().regex(STORED_SECRET_REF_PATTERN))
    .max(EXECUTION_SECRET_BINDINGS_MAX),
});
export type CatalogMaterializationMcpServerDescriptor = z.output<
  typeof CatalogMaterializationMcpServerDescriptorSchema
>;

/** One skill to materialize (CAN-4124 D13). */
export const CatalogMaterializationSkillDescriptorSchema = z.strictObject({
  kind: z.literal('skill'),
  entryId: z.string().min(1).max(512),
  sourceId: z.string().min(1).max(512),
  skillName: z.string().min(1).max(512),
  skillRevision: z.string().regex(CATALOG_SHA256_PATTERN),
});

/** Closed union of plugins (CAN-4123), skills (CAN-4124) and MCP servers (CAN-4125). */
export const CatalogMaterializationItemDescriptorSchema = z.discriminatedUnion(
  'kind',
  [
    CatalogMaterializationPluginDescriptorSchema,
    CatalogMaterializationSkillDescriptorSchema,
    CatalogMaterializationMcpServerDescriptorSchema,
  ],
);
export type CatalogMaterializationItemDescriptor = z.output<
  typeof CatalogMaterializationItemDescriptorSchema
>;

const byEntryId = (
  a: CatalogMaterializationItemDescriptor,
  b: CatalogMaterializationItemDescriptor,
): number => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0);

/** The text whose SHA-256 is a materialization's fingerprint. Items are sorted by entryId. */
export function catalogMaterializationFingerprintInput(
  items: readonly CatalogMaterializationItemDescriptor[],
): string {
  return stableStringify({ version: 1, items: [...items].sort(byEntryId) });
}

/** The text whose SHA-256 (hex) follows CATALOG_MATERIALIZATION_ID_PREFIX. */
export function catalogMaterializationIdInput(
  fingerprint: string,
  scope: CanopyWorkspaceScope,
): string {
  return stableStringify({ fingerprint, scope });
}

/** Total MCP secret references across items. */
export function catalogMaterializationSecretCount(
  items: readonly CatalogMaterializationItemDescriptor[],
): number {
  let count = 0;
  for (const item of items)
    if (item.kind === 'mcp_server') count += item.secretRefs.length;
  return count;
}

/**
 * The execution secret bindings a materialization's MCP items name: items
 * in entry-id order, each item's references in order, named
 * `CANOPY_MCP_SECRET_<n>` from 0. Account items and plugins name none.
 * Both the stager and the worker derive the same list from the descriptors.
 */
export function catalogMaterializationSecretBindings(
  items: readonly CatalogMaterializationItemDescriptor[],
): ExecutionSecretBinding[] {
  const bindings: ExecutionSecretBinding[] = [];
  for (const item of [...items].sort(byEntryId)) {
    if (item.kind !== 'mcp_server') continue;
    for (const ref of item.secretRefs)
      bindings.push({
        name: `${CATALOG_MCP_SECRET_BINDING_PREFIX}${String(bindings.length)}`,
        source: {
          kind: 'stored-secret',
          family: 'mcp.server',
          record: item.serverId,
          ref,
        },
      });
  }
  return bindings;
}

/** Item-list rules zod cannot express per item; used by the materialize params. */
export function checkCatalogMaterializationItems(
  items: readonly CatalogMaterializationItemDescriptor[],
  ctx: z.RefinementCtx,
): void {
  for (const item of items) {
    if (item.kind !== 'mcp_server') continue;
    if (item.binding === 'account' && item.transport !== 'http')
      ctx.addIssue({
        code: 'custom',
        message: 'An account MCP server is reached over HTTP.',
      });
    if (item.binding === 'account' && item.secretRefs.length > 0)
      ctx.addIssue({
        code: 'custom',
        message: 'An account MCP server takes no local secrets.',
      });
    if (
      !item.secretRefs.every((ref, index, refs): boolean => {
        const previous = refs[index - 1];
        return previous === undefined || previous < ref;
      })
    )
      ctx.addIssue({
        code: 'custom',
        message: 'MCP secret references are sorted and unique.',
      });
  }
  if (catalogMaterializationSecretCount(items) > EXECUTION_SECRET_BINDINGS_MAX)
    ctx.addIssue({
      code: 'custom',
      message: 'A materialization receives at most 64 secrets.',
    });
}
