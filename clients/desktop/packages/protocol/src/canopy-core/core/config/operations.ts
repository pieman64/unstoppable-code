import { z } from 'zod';

import { CanopyWorkspaceScopeSchema } from '../../common';
import { CanopyJsonValueSchema } from '../../errors';
import {
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import { inherentOperationErrorSchema } from '../shared';

export const CONFIG_GRANTS = { read: 'core.config.read' } as const;

export const ConfigGetParamsSchema = z.strictObject({
  namespace: z.string().regex(/^[a-z][a-zA-Z0-9.-]{0,127}$/),
  scope: CanopyWorkspaceScopeSchema.optional(),
});

export const ConfigGetResultSchema = z
  .object({
    namespace: z.string(),
    scope: CanopyWorkspaceScopeSchema,
    /**
     * An opaque tag: an equal revision means the same document. Compare it
     * for equality only, never order by it.
     */
    revision: z.number().int().min(0),
    value: z.object({}).catchall(CanopyJsonValueSchema),
    enforcedPaths: z.array(z.string()),
  })
  .catchall(CanopyJsonValueSchema);

export const ConfigGetErrorSchema = inherentOperationErrorSchema([
  'core.config.invalidState',
  'core.config.revisionConflict',
  'core.config.notFound',
]);

/** The read-only Git preferences namespace a desktop core serves (CAN-5992). */
export const CONFIG_GIT_NAMESPACE = 'git';

/** `value` of the `git` namespace: the effective branch, PR and commit settings. */
export const ConfigGitValueSchema = z.strictObject({
  branchName: z.strictObject({
    instructions: z.string(),
    prefixMode: z.enum(['none', 'github', 'custom']),
    /** The resolved prefix with its trailing slash, or null when none applies. */
    prefix: z.string().nullable(),
  }),
  pullRequest: z.strictObject({ instructions: z.string() }),
  commitMessage: z.strictObject({ instructions: z.string() }),
});
export type ConfigGitValue = z.output<typeof ConfigGitValueSchema>;

/** Config reads; outside `CORE_QUERY_DEFINITIONS` for the same reason as the catalog's. */
export const CORE_CONFIG_QUERY_DEFINITIONS = defineCanopyQueryRegistry('core', {
  'core.config.get': defineCanopyQuery({
    plane: 'core',
    domain: 'config',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: [CONFIG_GRANTS.read],
    params: ConfigGetParamsSchema,
    result: ConfigGetResultSchema,
    error: ConfigGetErrorSchema,
  }),
});
