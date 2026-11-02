import { z } from 'zod';

import {
  CanopyStreamCursorSchema,
  CanopyStreamEndSchema,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
  defineCanopyStream,
  defineCanopyStreamRegistry,
} from '../../definitions';
import { inherentOperationErrorSchema } from '../shared';

export const CORE_EXECUTION_GRANTS = {
  read: 'core.execution.read',
} as const;

export const CORE_EXECUTION_FAMILIES = [
  'pipeline',
  'script',
  'terminal',
  'codeGraph',
] as const;

export const CORE_EXECUTION_GROUP_IDS = [
  'app',
  'browser',
  'codex',
  'claude',
  'chat',
  'pipelines',
  'terminal',
  'scripts',
  'other',
] as const;

export const CORE_EXECUTION_ITEM_KINDS = [
  'electron-main',
  'electron-renderer',
  'electron-utility',
  'electron-gpu',
  'in-app-browser',
  'codex-app-server-pool',
  'pipeline-execution',
  'pipeline-step',
  'chat-provider',
  'terminal',
  'script',
  'hook',
  'other',
] as const;

/** String bounds; a host projection fits its values to them before it emits. */
export const CORE_EXECUTION_LIMITS = {
  id: 512,
  label: 4096,
  reason: 1024,
  error: 1024,
  metadataType: 64,
} as const;

const id = z.string().min(1).max(CORE_EXECUTION_LIMITS.id);
const label = z.string().max(CORE_EXECUTION_LIMITS.label);
const timestamp = z.iso.datetime({ offset: true });
const count = z.number().int().min(0);
const bytes = z.number().min(0);
const cpuPercent = z.number().min(0);
const pid = z.number().int().min(0);

export const CoreExecutionFamilyStatusSchema = z.strictObject({
  /** Work holding a lease: accepted and not yet settled. */
  active: count,
  /** Admitted starts that have not handed over to a lease yet. */
  pending: count,
  maxActive: z.number().int().min(0).nullable(),
  /** A new start would be refused now. */
  blocked: z.boolean(),
});

export const CoreExecutionFamiliesSchema = z.strictObject({
  pipeline: CoreExecutionFamilyStatusSchema,
  script: CoreExecutionFamilyStatusSchema,
  terminal: CoreExecutionFamilyStatusSchema,
  codeGraph: CoreExecutionFamilyStatusSchema,
});

/** One process or unit of work; `parentId` nests it under another item. */
export const CoreExecutionItemSchema = z.strictObject({
  id,
  parentId: id.optional(),
  kind: z.enum(CORE_EXECUTION_ITEM_KINDS),
  groupId: z.enum(CORE_EXECUTION_GROUP_IDS),
  label,
  pid: pid.optional(),
  ppid: pid.optional(),
  processGroupId: pid.optional(),
  cpuPercent,
  memoryRssBytes: bytes,
  processCount: count,
  startedAt: timestamp.optional(),
  status: z.enum(['running', 'idle', 'exited', 'unknown']),
  /** The host's metadata kind; the metadata itself stays with the host. */
  metadataType: z
    .string()
    .min(1)
    .max(CORE_EXECUTION_LIMITS.metadataType)
    .optional(),
});

export const CoreExecutionGroupSchema = z.strictObject({
  id: z.enum(CORE_EXECUTION_GROUP_IDS),
  label,
  cpuPercent,
  memoryRssBytes: bytes,
  processCount: count,
  items: z.array(CoreExecutionItemSchema),
});

export const CoreExecutionStatusSchema = z.strictObject({
  sampledAt: timestamp,
  cpuPercent,
  memoryRssBytes: bytes,
  processCount: count,
  pressure: z.strictObject({
    level: z.enum(['unknown', 'ok', 'warning', 'critical']),
    reasons: z.array(z.string().max(CORE_EXECUTION_LIMITS.reason)),
    warningMemoryBytes: bytes,
    criticalMemoryBytes: bytes,
  }),
  groups: z.array(CoreExecutionGroupSchema),
  /** Live counts per family at the read, not at the sample. */
  families: CoreExecutionFamiliesSchema,
  /** Critical memory refuses memory-guarded families now. */
  memoryGuardBlocked: z.boolean(),
  /** A sampling failure; the rest of the status stays readable. */
  error: z.string().max(CORE_EXECUTION_LIMITS.error).optional(),
});

export const CoreExecutionStatusGetParamsSchema = z.strictObject({});
export const CoreExecutionStatusGetResultSchema = z.strictObject({
  status: CoreExecutionStatusSchema,
});

/**
 * Each item carries the whole status, so a reopened stream starts from the
 * current status and nothing is replayed; a cursor only continues numbering.
 */
export const CoreExecutionStatusEventsParamsSchema = z.strictObject({
  cursor: CanopyStreamCursorSchema.nullable().optional(),
});
export const CoreExecutionStatusEventsOpenResultSchema = z.strictObject({
  subscriptionId: id,
  acceptedCursor: CanopyStreamCursorSchema.nullable(),
});
/** The status after each sample, and the current status when the stream opens. */
export const CoreExecutionStatusEventsItemSchema = z.strictObject({
  status: CoreExecutionStatusSchema,
});

export const CoreExecutionErrorSchema = inherentOperationErrorSchema([
  'core.execution.unavailable',
]);
export const CoreExecutionStatusEventsEndSchema = CanopyStreamEndSchema.extend({
  error: CoreExecutionErrorSchema.nullable(),
});

export type CoreExecutionFamily = (typeof CORE_EXECUTION_FAMILIES)[number];
export type CoreExecutionFamilyStatus = z.output<
  typeof CoreExecutionFamilyStatusSchema
>;
export type CoreExecutionItem = z.output<typeof CoreExecutionItemSchema>;
export type CoreExecutionGroup = z.output<typeof CoreExecutionGroupSchema>;
export type CoreExecutionStatus = z.output<typeof CoreExecutionStatusSchema>;
export type CoreExecutionStatusGetResult = z.output<
  typeof CoreExecutionStatusGetResultSchema
>;
export type CoreExecutionStatusEventsItem = z.output<
  typeof CoreExecutionStatusEventsItemSchema
>;

export const CORE_EXECUTION_QUERIES = defineCanopyQueryRegistry('core', {
  'core.execution.status.get': defineCanopyQuery({
    plane: 'core',
    domain: 'execution',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: [CORE_EXECUTION_GRANTS.read],
    params: CoreExecutionStatusGetParamsSchema,
    result: CoreExecutionStatusGetResultSchema,
    error: CoreExecutionErrorSchema,
  }),
});

export const CORE_EXECUTION_STREAMS = defineCanopyStreamRegistry('core', {
  'core.execution.status.events': defineCanopyStream({
    plane: 'core',
    domain: 'execution',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: [CORE_EXECUTION_GRANTS.read],
    params: CoreExecutionStatusEventsParamsSchema,
    openResult: CoreExecutionStatusEventsOpenResultSchema,
    item: CoreExecutionStatusEventsItemSchema,
    end: CoreExecutionStatusEventsEndSchema,
    error: CoreExecutionErrorSchema,
  }),
});
