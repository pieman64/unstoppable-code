import { createHash } from 'node:crypto';

/** Approved pseudonymous joins, not anonymization. Never pass an email here. */
export function invitationReference(
  domain: 'organization' | 'teammate_share' | 'teammate_share_grant',
  serverId: string,
): string {
  if (typeof serverId !== 'string' || serverId.length === 0)
    throw new Error('Missing invitation identity.');
  return createHash('sha256')
    .update(`${domain}:${serverId}`)
    .digest('hex')
    .slice(0, 16);
}
