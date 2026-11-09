import {
  isResourceOwner,
  resourceOwnerContext,
} from '@canopy/protocol/resource-owner';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLegacyPrivateOwner(owner: unknown): boolean {
  if (!isRecord(owner)) return false;
  // Conflicting shared provenance must never be relabelled Personal.
  if (owner.type !== undefined && owner.type !== 'user') return false;
  if (owner.ownerType !== undefined && owner.ownerType !== 'USER') return false;
  if (owner.shareScope !== undefined && owner.shareScope !== 'private')
    return false;
  if (owner.type === 'user') {
    return (
      owner.name === undefined && isResourceOwner({ ...owner, name: null })
    );
  }
  if (owner.ownerType === 'USER') {
    return (
      typeof owner.ownerUserId === 'number' &&
      Number.isInteger(owner.ownerUserId) &&
      owner.ownerUserId > 0
    );
  }
  return owner.shareScope === 'private';
}

/** Classification only: callers retain their existing read/write authorization. */
export function classifyResourceOwner(
  owner: unknown,
  { strict }: { strict: boolean },
): 'global' | 'personal' | { organizationId: string } | 'unknown' {
  if (isResourceOwner(owner)) return resourceOwnerContext(owner);
  if (isLegacyPrivateOwner(owner)) return 'personal';
  // Older servers supplied unscoped inventory. Strict capability opts into
  // rejecting incomplete provenance; local paths alone are never proof.
  return strict ? 'unknown' : 'personal';
}
