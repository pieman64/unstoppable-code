import { createHash } from 'node:crypto';
import type {
  DelegationRegistryCheckpoint,
  DelegationRegistryJournalEffect,
  DelegationRegistryOwner,
} from './delegation-registry-api';

export type RegistryIdentity = DelegationRegistryCheckpoint['identity'];

/** The legacy two-field identity remains the delegation wire representation. */
export function registryOwner(
  identity: RegistryIdentity,
): DelegationRegistryOwner {
  return 'kind' in identity ? identity : { kind: 'delegation', ...identity };
}

export function registryOwnerKey(identity: RegistryIdentity): string {
  return 'delegationId' in identity
    ? JSON.stringify([identity.chatId, identity.delegationId])
    : JSON.stringify(['#owner', 'chat_receipts', identity.chatId]);
}

export function registryOwnerDirectory(identity: RegistryIdentity): string {
  const hash = createHash('sha256')
    .update(registryOwnerKey(identity))
    .digest('hex');
  return 'delegationId' in identity ? hash : `receipts-${hash}`;
}

export function registryEffectIdentity(
  effect: DelegationRegistryJournalEffect,
): RegistryIdentity {
  if (effect.kind === 'delegation-receipt') return effect.owner;
  if (effect.kind === 'delegation-generation') return effect.identity;
  return {
    chatId: effect.target.chatId,
    delegationId: effect.target.delegationId,
  };
}
