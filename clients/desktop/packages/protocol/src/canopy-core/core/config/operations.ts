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
