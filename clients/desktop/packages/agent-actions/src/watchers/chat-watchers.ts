import { z } from 'zod';
import type { AgentJson } from '../response';
import type { AgentJsonSchema } from '../tools/definition';

/**
 * Canonical project and bot chat watcher setup contracts: the triggers, the
 * strict entry schemas, mixed-batch parsing and their JSON schema.
 */

export const CANONICAL_CHAT_WATCHER_TRIGGERS = [
  'project_task_chat_completion',
  'project_new_chat_started',
  'bot_task_chat_completion',
  'bot_new_chat_started',
] as const;
export type CanonicalChatWatcherTrigger =
  (typeof CANONICAL_CHAT_WATCHER_TRIGGERS)[number];

/**
 * The chat triggers that address a worktree or Cowork chat directly. Where
 * canonical chat watchers are offered they are accepted compatibility
 * aliases, not advertised.
 */
export const LEGACY_CHAT_WATCHER_TRIGGERS = [
  'worktree_chat_completion',
  'standalone_chat_completion',
  'worktree_new_chat_started',
  'standalone_new_chat_started',
] as const;

export function isLegacyChatWatcherTrigger(
  value: unknown,
): value is (typeof LEGACY_CHAT_WATCHER_TRIGGERS)[number] {
  return LEGACY_CHAT_WATCHER_TRIGGERS.some((trigger) => trigger === value);
}

// Opaque public IDs, with no normalization before strict validation.
const idSchema = z.string().min(1).max(512).regex(/\S/);
const metadata = {
  label: z.string().max(160).optional(),
  followUpInstruction: z.string().max(8000).optional(),
  allowDuplicate: z.boolean().optional(),
};
export const projectChatWatcherAddressSchema = z
  .object({
    projectId: idSchema,
    taskId: idSchema,
    chatId: idSchema,
  })
  .strict();
export const projectChatWatcherScopeSchema = z
  .object({
    projectId: idSchema,
    taskId: idSchema.optional(),
  })
  .strict();
export const botChatWatcherAddressSchema = z
  .object({
    botId: idSchema,
    taskId: idSchema,
    chatId: idSchema,
  })
  .strict();
export const botChatWatcherScopeSchema = z
  .object({
    botId: idSchema,
    taskId: idSchema.optional(),
  })
  .strict();

export const projectTaskChatCompletionWatcherSchema = z
  .object({
    ...metadata,
    trigger: z.literal('project_task_chat_completion'),
    target: projectChatWatcherAddressSchema,
    armForNextCompletion: z.boolean().optional(),
  })
  .strict();
export const projectNewChatStartedWatcherSchema = z
  .object({
    ...metadata,
    trigger: z.literal('project_new_chat_started'),
    target: projectChatWatcherScopeSchema,
  })
  .strict();
export const botTaskChatCompletionWatcherSchema = z
  .object({
    ...metadata,
    trigger: z.literal('bot_task_chat_completion'),
    target: botChatWatcherAddressSchema,
    armForNextCompletion: z.boolean().optional(),
  })
  .strict();
export const botNewChatStartedWatcherSchema = z
  .object({
    ...metadata,
    trigger: z.literal('bot_new_chat_started'),
    target: botChatWatcherScopeSchema,
  })
  .strict();
export const canonicalChatWatcherEntrySchema = z.discriminatedUnion('trigger', [
  projectTaskChatCompletionWatcherSchema,
  projectNewChatStartedWatcherSchema,
  botTaskChatCompletionWatcherSchema,
  botNewChatStartedWatcherSchema,
]);
export type CanonicalChatWatcherEntry = z.infer<
  typeof canonicalChatWatcherEntrySchema
>;
export const canonicalChatWatcherEnvelopeSchema = z
  .object({
    watchers: z.array(canonicalChatWatcherEntrySchema).min(1).max(10),
  })
  .strict();

export function isCanonicalChatWatcherTrigger(
  value: unknown,
): value is CanonicalChatWatcherTrigger {
  return CANONICAL_CHAT_WATCHER_TRIGGERS.some((trigger) => trigger === value);
}
/**
 * Whether watcher tools offering `triggers` offer canonical project and bot
 * chat watchers, which also page active watchers by canonical target.
 * Without a trigger list, as desktop's static tool definitions build them,
 * they do.
 */
export function offersCanonicalChatWatchers(
  triggers: readonly string[] | undefined,
): boolean {
  return triggers?.some(isCanonicalChatWatcherTrigger) ?? true;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Detection only: parsing aliases here never grants them acceptance. */
export function containsCanonicalChatWatcher(value: unknown): boolean {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed !== 'string' && containsCanonicalChatWatcher(parsed);
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.some(containsCanonicalChatWatcher);
  if (!isRecord(value)) return false;
  return (
    isCanonicalChatWatcherTrigger(value.trigger) ||
    (value.watchers !== undefined &&
      containsCanonicalChatWatcher(value.watchers))
  );
}

/**
 * Canonical-bearing batches have a real strict envelope. The legacy-only path
 * deliberately retains its pre-phase stripping, limits and normalization.
 * The optional normalizer is invoked only on legacy entries of mixed batches.
 */
export function chatWatcherSetupSchema<T extends z.ZodType>(
  legacyEntry: T,
  normalizeLegacyEntry: (entry: unknown) => unknown = (entry) => entry,
): z.ZodType<{ watchers: Array<z.output<T> | CanonicalChatWatcherEntry> }> {
  const legacyEnvelope = z.object({ watchers: z.array(legacyEntry).min(1) });
  const mixedEntry = z.unknown().transform((value, context) => {
    if (containsCanonicalChatWatcher(value)) {
      const parsed = canonicalChatWatcherEntrySchema.safeParse(value);
      if (parsed.success) return parsed.data;
      for (const issue of parsed.error.issues)
        context.addIssue({
          code: 'custom',
          message: issue.message,
          path: issue.path,
        });
      return z.NEVER;
    }
    const parsed = legacyEntry.safeParse(normalizeLegacyEntry(value));
    if (parsed.success) return parsed.data;
    for (const issue of parsed.error.issues)
      context.addIssue({
        code: 'custom',
        message: issue.message,
        path: issue.path,
      });
    return z.NEVER;
  });
  const mixedEnvelope = z
    .object({ watchers: z.array(mixedEntry).min(1).max(10) })
    .strict();
  const rawMixedEnvelope = z
    .object({ watchers: z.array(z.unknown()).min(1).max(10) })
    .strict();
  return z.unknown().transform((value, context) => {
    const canonicalBatch = containsCanonicalChatWatcher(value);
    if (canonicalBatch) {
      const raw = rawMixedEnvelope.safeParse(value);
      if (!raw.success) {
        for (const issue of raw.error.issues)
          context.addIssue({
            code: 'custom',
            message: issue.message,
            path: issue.path,
          });
        return z.NEVER;
      }
      // Validate every canonical entry before normalizing even the first legacy
      // entry. A malformed canonical batch must never use the alias repair path.
      let invalid = false;
      for (const [index, entry] of Array.from(raw.data.watchers.entries())) {
        if (!containsCanonicalChatWatcher(entry)) continue;
        const parsed = canonicalChatWatcherEntrySchema.safeParse(entry);
        if (parsed.success) continue;
        invalid = true;
        for (const issue of parsed.error.issues)
          context.addIssue({
            code: 'custom',
            message: issue.message,
            path: ['watchers', index, ...issue.path],
          });
      }
      if (invalid) return z.NEVER;
    }
    const parsed = (canonicalBatch ? mixedEnvelope : legacyEnvelope).safeParse(
      value,
    );
    if (parsed.success) return parsed.data;
    for (const issue of parsed.error.issues)
      context.addIssue({
        code: 'custom',
        message: issue.message,
        path: issue.path,
      });
    return z.NEVER;
  });
}

/** JSON is generated from the very same strict schemas, not a second contract. */
function schemaJson(value: unknown): AgentJson {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value;
  if (Array.isArray(value)) return value.map(schemaJson);
  if (isRecord(value)) {
    return schemaJsonObject(value);
  }
  throw new Error('Non-JSON schema value');
}
const { $schema: _schema, ...entryJsonSchema } = z.toJSONSchema(
  canonicalChatWatcherEntrySchema,
  { target: 'draft-7' },
);
void _schema;
export const canonicalChatWatcherEntryJsonSchema = schemaJson(entryJsonSchema);

/** Preserve the legacy JSON branch byte-for-byte; add only strict mixed batches. */
export function extendChatWatcherSetupJsonSchema(
  legacy: unknown,
): AgentJsonSchema {
  if (
    !isRecord(legacy) ||
    !isRecord(legacy.properties) ||
    !isRecord(legacy.properties.watchers)
  )
    throw new Error('Missing legacy watcher items');
  const legacyItems = schemaJson(legacy.properties.watchers.items);
  return {
    ...schemaJsonObject(legacy),
    properties: {
      ...schemaJsonObject(legacy.properties),
      watchers: {
        anyOf: [
          schemaJson(legacy.properties.watchers),
          {
            type: 'array',
            minItems: 1,
            maxItems: 10,
            contains: canonicalChatWatcherEntryJsonSchema,
            items: {
              anyOf: [legacyItems, canonicalChatWatcherEntryJsonSchema],
            },
          },
        ],
      },
    },
  };
}
function schemaJsonObject(value: Record<string, unknown>): AgentJsonSchema {
  const result: AgentJsonSchema = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = schemaJson(item);
  }
  return result;
}
