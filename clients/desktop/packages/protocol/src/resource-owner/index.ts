/** Shared, environment-neutral resource ownership wire contract. */
export type ResourceOwner =
  | { type: 'system' }
  | { type: 'user'; id: string; name: string | null; slug?: string | null }
  | {
      type: 'team';
      id: string;
      name: string | null;
      slug?: string | null;
      organization: { id: string; name: string | null };
    }
  | {
      type: 'organization';
      id: string;
      name: string | null;
      slug?: string | null;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isName(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** Validate wire provenance; display names never determine ownership. */
export function isResourceOwner(value: unknown): value is ResourceOwner {
  if (!isRecord(value)) return false;
  if (value.type === 'system') return true;
  if (
    value.type !== 'user' &&
    value.type !== 'team' &&
    value.type !== 'organization'
  )
    return false;
  if (!isId(value.id) || !isName(value.name)) return false;
  if (value.slug !== undefined && !isName(value.slug)) return false;
  return (
    value.type !== 'team' ||
    (isRecord(value.organization) &&
      isId(value.organization.id) &&
      isName(value.organization.name))
  );
}

export function resourceOwnerContext(
  owner: ResourceOwner,
): 'global' | 'personal' | { organizationId: string } {
  switch (owner.type) {
    case 'system':
      return 'global';
    case 'user':
      return 'personal';
    case 'team':
      return { organizationId: owner.organization.id };
    case 'organization':
      return { organizationId: owner.id };
  }
}
