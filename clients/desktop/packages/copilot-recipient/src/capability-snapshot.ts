import { createHash } from 'node:crypto';
import { canonicalCopilotValue } from './tool-correlation';

export interface CopilotCapabilitySnapshot {
  version: 1;
  digest: string;
}

export function isCopilotCapabilitySnapshot(
  value: unknown,
): value is CopilotCapabilitySnapshot {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'version' in value &&
    value.version === 1 &&
    'digest' in value &&
    typeof value.digest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.digest)
  );
}

/** Persist only the digest, never capability contents, host paths or credentials. */
export function createCopilotCapabilitySnapshot(
  manifest: unknown,
): CopilotCapabilitySnapshot {
  return {
    version: 1,
    digest: createHash('sha256')
      .update(canonicalCopilotValue(manifest))
      .digest('hex'),
  };
}
