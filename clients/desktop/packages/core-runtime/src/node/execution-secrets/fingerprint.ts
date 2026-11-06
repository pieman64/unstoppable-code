import { createHash } from 'node:crypto';
import type {
  DelegationSecretFingerprint,
  ExecutionSecretBinding,
} from '@canopy/protocol/canopy-core';
import { stableStringify } from '@canopy/protocol/plans';

export function fingerprintExecutionSecretBinding(
  binding: ExecutionSecretBinding,
): string {
  return `sha256:${createHash('sha256').update('canopy.execution-secret-binding.v1\0').update(stableStringify(binding)).digest('hex')}`;
}

export function executionSecretFingerprints(
  bindings: readonly ExecutionSecretBinding[] | undefined,
): DelegationSecretFingerprint[] {
  return (
    bindings?.map((binding) => ({
      name: binding.name,
      fingerprint: fingerprintExecutionSecretBinding(binding),
    })) ?? []
  );
}
