import { z } from 'zod';

import { CanopyRequestMetadataSchema } from '../../common';
import { CanopyJsonValueSchema } from '../../errors';
import { keyedOperationErrorSchema } from '../shared';

const json = CanopyJsonValueSchema;
const jsonObject = z.object({}).catchall(json);

export const CoreClientCapabilitySchema = z
  .object({
    name: z.string().regex(/^core\./),
    version: z.number().int().min(1),
    inputSchema: jsonObject,
    outputSchema: jsonObject,
  })
  .catchall(json);
export type CoreClientCapability = z.output<typeof CoreClientCapabilitySchema>;

// The binding resolves the lease from the authenticated caller, never params.
export const CoreClientCapabilitiesRegisterParamsSchema = z.strictObject({
  capabilities: z.array(CoreClientCapabilitySchema).max(256),
  _meta: CanopyRequestMetadataSchema.extend({
    idempotencyKey: z.string().min(1).max(512),
  }),
});

export const CoreClientCapabilitiesRegisterResultSchema = z
  .object({
    registrationRevision: z.number().int().nonnegative(),
    effectiveCapabilities: z.array(z.string()),
  })
  .catchall(json);
export type CoreClientCapabilitiesRegisterResult = z.output<
  typeof CoreClientCapabilitiesRegisterResultSchema
>;

export const CoreClientCapabilitiesErrorSchema = keyedOperationErrorSchema([
  'core.client.capabilities.invalidState',
  'core.client.capabilities.revisionConflict',
  'core.client.capabilities.notFound',
]);
