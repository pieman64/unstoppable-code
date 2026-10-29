import { defineCanopyInstruction } from '../../definitions';
import {
  CoreClientCapabilitiesErrorSchema,
  CoreClientCapabilitiesRegisterParamsSchema,
  CoreClientCapabilitiesRegisterResultSchema,
} from './capabilities';
import {
  CoreClientLeaseAcquireErrorSchema,
  CoreClientLeaseAcquireParamsSchema,
  CoreClientLeaseErrorSchema,
  CoreClientLeaseReleaseParamsSchema,
  CoreClientLeaseReleaseResultSchema,
  CoreClientLeaseRenewParamsSchema,
  CoreClientLeaseSchema,
} from './leases';

export const CORE_CLIENT_INSTRUCTIONS = {
  'core.client.lease.acquire': defineCanopyInstruction({
    plane: 'core',
    domain: 'client',
    version: 1,
    placement: 'core-only',
    idempotency: 'keyed',
    requiredGrants: ['core.client.manage'],
    params: CoreClientLeaseAcquireParamsSchema,
    result: CoreClientLeaseSchema,
    error: CoreClientLeaseAcquireErrorSchema,
  }),
  'core.client.lease.renew': defineCanopyInstruction({
    plane: 'core',
    domain: 'client',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: ['core.client.manage'],
    params: CoreClientLeaseRenewParamsSchema,
    result: CoreClientLeaseSchema,
    error: CoreClientLeaseErrorSchema,
  }),
  'core.client.lease.release': defineCanopyInstruction({
    plane: 'core',
    domain: 'client',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: ['core.client.manage'],
    params: CoreClientLeaseReleaseParamsSchema,
    result: CoreClientLeaseReleaseResultSchema,
    error: CoreClientLeaseErrorSchema,
  }),
  'core.client.capabilities.register': defineCanopyInstruction({
    plane: 'core',
    domain: 'client',
    version: 1,
    placement: 'core-only',
    idempotency: 'keyed',
    requiredGrants: ['core.client.manage'],
    params: CoreClientCapabilitiesRegisterParamsSchema,
    result: CoreClientCapabilitiesRegisterResultSchema,
    error: CoreClientCapabilitiesErrorSchema,
  }),
};
