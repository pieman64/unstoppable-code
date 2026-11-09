import { z } from 'zod';

import { CanopyWorkspaceScopeSchema } from '../../common';
import {
  CanopyErrorPayloadSchema,
  CanopyJsonValueSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';

const IdSchema = z.string().min(1).max(512);
const TimestampSchema = z.iso.datetime({ offset: true });

export const CATALOG_ENTRY_KINDS = [
  'skill',
  'plugin',
  'mcp_server',
  'agent',
  'model',
  'tool',
  'collection',
] as const;

export const CatalogEntryKindSchema = z.enum(CATALOG_ENTRY_KINDS);

/** Which agent harnesses a plugin's content supports. */
const ProviderSupportSchema = z.strictObject({
  claude: z.boolean(),
  codex: z.boolean(),
});

/**
 * The selection ref an entry id was built from, so a client can write a
 * selection without splitting the id (a ref part may hold `/`).
 */
const SkillSelectionRefSchema = z.strictObject({
  sourceId: IdSchema,
  skillName: IdSchema,
});
const PluginSelectionRefSchema = z.strictObject({
  marketplaceId: IdSchema,
  pluginName: IdSchema,
});
const McpServerSelectionRefSchema = z.strictObject({
  serverId: IdSchema,
  configId: IdSchema,
});

export const CatalogEntryContentSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('skill'),
    /** Omitted when the catalog holds no body; never an empty string. */
    instructions: z.string().max(2_000_000).optional(),
    entrypoint: z.string().max(4096).nullable(),
    selectionRef: SkillSelectionRefSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('plugin'),
    manifest: z.strictObject({
      name: z.string().max(256),
      version: z.string().max(128),
      capabilities: z.array(z.string().max(256)),
      dependencies: z.array(IdSchema),
      providerSupport: ProviderSupportSchema.optional(),
    }),
    selectionRef: PluginSelectionRefSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('mcp_server'),
    transport: z.enum(['stdio', 'http', 'sse']),
    commandRef: IdSchema.nullable(),
    /** Null when the server has no public URL. */
    url: z.string().max(8192).nullable(),
    authIntegrationId: IdSchema.nullable(),
    connectionState: z
      .enum(['connected', 'reauth_required', 'not_connected', 'desktop_only'])
      .optional(),
    /** Null enables every tool; `[]` disables them all. */
    enabledTools: z.array(z.string().max(256)).nullable().optional(),
    selectionRef: McpServerSelectionRefSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('agent'),
    providerId: IdSchema,
    modelId: IdSchema.nullable(),
    systemPrompt: z.string().max(2_000_000).nullable(),
    toolIds: z.array(IdSchema),
  }),
  z.strictObject({
    kind: z.literal('model'),
    providerId: IdSchema,
    modelName: z.string().max(512),
    contextWindow: z.number().int().min(1).nullable(),
    capabilities: z.array(z.string().max(128)),
    harness: z.enum(['claude', 'codex']).optional(),
    /** Absent or null: unknown. `[]`: the model does not think. */
    thinkingLevels: z.array(z.string().max(128)).nullable().optional(),
    fastMode: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal('tool'),
    toolName: z.string().max(256),
    inputSchema: CanopyJsonValueSchema,
    resultSchema: CanopyJsonValueSchema,
  }),
  z.strictObject({
    kind: z.literal('collection'),
    entryIds: z.array(IdSchema),
  }),
]);

export const CatalogEntrySchema = z.strictObject({
  entryId: IdSchema,
  kind: CatalogEntryKindSchema,
  name: z.string().min(1).max(512),
  description: z.string().max(4096),
  source: z.enum(['bundled', 'user', 'workspace', 'plugin', 'remote']),
  content: CatalogEntryContentSchema,
  availability: z.enum([
    'available',
    'auth_required',
    'incompatible',
    'missing',
    'disabled',
  ]),
  revision: z.number().int().min(0),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type CatalogEntry = z.output<typeof CatalogEntrySchema>;

export const CatalogSnapshotGetParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema,
  kinds: z.array(CatalogEntryKindSchema),
  includeUnavailable: z.boolean(),
});

export const CatalogSnapshotGetResultSchema = z.strictObject({
  /**
   * An opaque tag: an equal revision means the same catalog. Compare it for
   * equality only, never order by it; a content tag can repeat or move back.
   */
  revision: z.number().int().min(0),
  entries: z.array(CatalogEntrySchema),
  generatedAt: TimestampSchema,
});

/** The snapshot declares no operation-specific codes. */
export const CatalogSnapshotGetErrorSchema = CanopyErrorPayloadSchema.omit({
  code: true,
}).extend({ retry: CanopyQueryRetryDirectiveSchema });
