import { z } from 'zod';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../../definitions';
import {
  inherentOperationErrorSchema,
  keyedOperationErrorSchema,
} from '../shared';

export const IntegrationCredentialKindSchema = z.enum([
  'github.pat',
  'linear.apiToken',
]);
export const CoreIntegrationCredentialSetParamsSchema = z.strictObject({
  credentialKind: IntegrationCredentialKindSchema,
  secret: z.string().min(1).max(16384).meta({ writeOnly: true }),
  // GitHub requires the generation of the exact ciphertext the host just wrote.
  expectedLegacyGeneration: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const CoreIntegrationCredentialClearParamsSchema = z.strictObject({
  credentialKind: IntegrationCredentialKindSchema,
});
export const CoreIntegrationCredentialResultSchema = z.strictObject({
  credentialKind: IntegrationCredentialKindSchema,
  configured: z.boolean(),
});
export const CORE_INTEGRATION_CREDENTIAL_SET_ERROR_CODES = [
  'core.integration.credential.storageUnavailable',
  'core.integration.credential.writeFailed',
] as const;
export const CORE_INTEGRATION_CREDENTIAL_CLEAR_ERROR_CODES = [
  'core.integration.credential.storageUnavailable',
  'core.integration.credential.removeFailed',
] as const;
export type CoreIntegrationCredentialSetParams = z.output<
  typeof CoreIntegrationCredentialSetParamsSchema
>;
export type CoreIntegrationCredentialClearParams = z.output<
  typeof CoreIntegrationCredentialClearParamsSchema
>;
export type CoreIntegrationCredentialResult = z.output<
  typeof CoreIntegrationCredentialResultSchema
>;

export const CORE_INTEGRATION_CREDENTIAL_INSTRUCTIONS =
  defineCanopyInstructionRegistry('core', {
    'core.integration.credential.set': defineCanopyInstruction({
      plane: 'core',
      domain: 'integration',
      version: 1,
      placement: 'core-only',
      params: CoreIntegrationCredentialSetParamsSchema,
      result: CoreIntegrationCredentialResultSchema,
      error: keyedOperationErrorSchema(
        CORE_INTEGRATION_CREDENTIAL_SET_ERROR_CODES,
      ),
      idempotency: 'keyed',
      requiredGrants: ['core.integration.write'],
    }),
    'core.integration.credential.clear': defineCanopyInstruction({
      plane: 'core',
      domain: 'integration',
      version: 1,
      placement: 'core-only',
      params: CoreIntegrationCredentialClearParamsSchema,
      result: CoreIntegrationCredentialResultSchema,
      error: inherentOperationErrorSchema(
        CORE_INTEGRATION_CREDENTIAL_CLEAR_ERROR_CODES,
      ),
      idempotency: 'inherent',
      requiredGrants: ['core.integration.write'],
    }),
  });
