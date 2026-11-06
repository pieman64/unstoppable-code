import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import { CanopyQueryRetryDirectiveSchema } from '../../errors';
import {
  vaultKeyedOperationErrorSchema,
  vaultOperationErrorSchema,
  vaultUncodedErrorSchema,
} from './errors';
import {
  VaultEntryDeleteParamsSchema,
  VaultEntryDeleteResultSchema,
  VaultEntryGetParamsSchema,
  VaultEntryListParamsSchema,
  VaultEntryListResultSchema,
  VaultEntryMetadataSchema,
  VaultEntryPutParamsSchema,
  VaultStatusGetParamsSchema,
  VaultStatusGetResultSchema,
} from './schemas';

export const VAULT_GRANTS = {
  read: 'core.vault.read',
  write: 'core.vault.write',
} as const;

/** Status and list carry no operation codes; only the generic kinds apply. */
const VaultUncodedQueryErrorSchema = vaultUncodedErrorSchema(
  CanopyQueryRetryDirectiveSchema,
);

export const VaultEntryGetErrorSchema = vaultOperationErrorSchema(
  ['core.vault.entry.notFound'],
  CanopyQueryRetryDirectiveSchema,
);

export const VaultEntryPutErrorSchema = vaultKeyedOperationErrorSchema([
  'core.vault.entry.notFound',
  'core.vault.entry.revisionConflict',
  'core.vault.entry.corrupt',
  'core.vault.entry.keyMissing',
  'core.vault.entry.outcomeUnknown',
  'core.vault.entry.unavailable',
  'core.vault.entry.closureUnrecorded',
  'core.vault.entry.writerRefused',
  'core.vault.entry.idempotencyKeyReused',
  'core.vault.protection.locked',
  'core.vault.protection.denied',
  'core.vault.protection.unavailable',
]);

export const VaultEntryDeleteErrorSchema = vaultKeyedOperationErrorSchema([
  'core.vault.entry.notFound',
  'core.vault.entry.revisionConflict',
  'core.vault.entry.outcomeUnknown',
  'core.vault.entry.unavailable',
  'core.vault.entry.closureUnrecorded',
  'core.vault.entry.writerRefused',
  'core.vault.entry.idempotencyKeyReused',
]);

// Daemon-only contracts: never composed into CORE_*, CANOPY_* or transport
// defaults (Electron must not open the exclusive vault). V6-a registers both
// registries; instructions require a grant AND a designated family writer.
// Every field stays a literal so the census reads it without evaluation.
export const CORE_VAULT_QUERY_DEFINITIONS = defineCanopyQueryRegistry('core', {
  'core.vault.status.get': defineCanopyQuery({
    plane: 'core',
    domain: 'vault',
    version: 1,
    placement: 'core-only',
    params: VaultStatusGetParamsSchema,
    result: VaultStatusGetResultSchema,
    error: VaultUncodedQueryErrorSchema,
    idempotency: 'inherent',
    requiredGrants: ['core.vault.read'],
  }),
  'core.vault.entry.list': defineCanopyQuery({
    plane: 'core',
    domain: 'vault',
    version: 1,
    placement: 'core-only',
    params: VaultEntryListParamsSchema,
    result: VaultEntryListResultSchema,
    error: VaultUncodedQueryErrorSchema,
    idempotency: 'inherent',
    requiredGrants: ['core.vault.read'],
  }),
  'core.vault.entry.get': defineCanopyQuery({
    plane: 'core',
    domain: 'vault',
    version: 1,
    placement: 'core-only',
    params: VaultEntryGetParamsSchema,
    result: VaultEntryMetadataSchema,
    error: VaultEntryGetErrorSchema,
    idempotency: 'inherent',
    requiredGrants: ['core.vault.read'],
  }),
});

export const CORE_VAULT_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.vault.entry.put': defineCanopyInstruction({
      plane: 'core',
      domain: 'vault',
      version: 1,
      placement: 'core-only',
      params: VaultEntryPutParamsSchema,
      result: VaultEntryMetadataSchema,
      error: VaultEntryPutErrorSchema,
      idempotency: 'keyed',
      requiredGrants: ['core.vault.write'],
    }),
    'core.vault.entry.delete': defineCanopyInstruction({
      plane: 'core',
      domain: 'vault',
      version: 1,
      placement: 'core-only',
      params: VaultEntryDeleteParamsSchema,
      result: VaultEntryDeleteResultSchema,
      error: VaultEntryDeleteErrorSchema,
      idempotency: 'keyed',
      requiredGrants: ['core.vault.write'],
    }),
  });
