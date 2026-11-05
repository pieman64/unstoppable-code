import type {
  LedgerActorKind,
  LedgerActorLabel,
  LedgerActorRef,
} from '@canopy/protocol/canopy-core';
import { ledgerActorName } from '../../lib/ledger-display';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import type { WorkPathPart } from '../WorkPath';

/*
 * Where an entry row came from, for a list that spans scopes, devices and
 * people: the Feed hands each row these details; the panel needs none.
 */

/** Who recorded an entry elsewhere, for a list that spans devices and people. */
export type LedgerEntryRowAttribution =
  /** Another of the person's own devices. */
  | { readonly kind: 'device'; readonly label: string }
  /** A teammate, whose own user actor shows under their name. */
  | {
      readonly kind: 'teammate';
      readonly name: string;
      readonly organization: string;
    };

/** Where a row was recorded, for a list that spans scopes. */
export interface LedgerEntryRowDetails {
  readonly context?: string;
  readonly workPath?: readonly WorkPathPart[];
  readonly attribution?: LedgerEntryRowAttribution;
}

/** An actor's name; a teammate's own user actor is the teammate. */
export function ledgerAttributedActorName(
  actor: LedgerActorRef,
  actors: Readonly<Record<string, LedgerActorLabel>>,
  attribution: LedgerEntryRowAttribution | undefined,
): string {
  return attribution?.kind === 'teammate' && actor.kind === 'user'
    ? attribution.name
    : ledgerActorName(actor, actors);
}

/**
 * The session-replay class for an actor's shown name or avatar. A person
 * from a teammate is personal identity, so replay records a same-size box.
 * Callers pass local attribution explicitly; names are never identity signals.
 */
export function ledgerActorReplayClass(
  kind: LedgerActorKind,
  localUser: boolean,
): string {
  return kind === 'user' && !localUser ? REPLAY_BLOCK_CLASS : '';
}
