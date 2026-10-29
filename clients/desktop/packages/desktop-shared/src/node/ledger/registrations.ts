import {
  LedgerActorKindSchema,
  LedgerContainerSchema,
  LedgerDisplayNameSchema,
  LedgerOpaqueIdSchema,
  countCodePoints,
  type LedgerActorKind,
  type LedgerContainer,
} from '@canopy/protocol/canopy-core';

import { LedgerStoreError } from './errors';
import { isLedgerScopeLifecycleState } from './lifecycle';
import {
  parseLedgerInput,
  toContainerColumns,
  type LedgerContainerColumns,
} from './records';
import { canonicalizeLedgerInstant } from './time';
import type {
  LedgerActorRecord,
  LedgerBindScopeInput,
  LedgerRebindScopeInput,
  LedgerRegisterActorInput,
  LedgerScopeLifecycleState,
  LedgerSetScopeLifecycleInput,
} from './types';

/** Longest accepted actor origin key, in code points. */
export const LEDGER_ACTOR_ORIGIN_KEY_MAX_CODE_POINTS = 2_048;

/** A container incarnation: its tuple plus its canonical creation time. */
export interface LedgerScopeIdentity {
  readonly container: LedgerContainer;
  readonly columns: LedgerContainerColumns;
  readonly containerCreatedAt: string;
}

export interface LedgerScopeBinding extends LedgerScopeIdentity {
  readonly authorityId: string;
  readonly accountId: string | null;
}

export interface LedgerActorRegistration {
  readonly kind: LedgerActorKind;
  readonly authorityId: string;
  readonly originKey: string;
  readonly displayName: string;
}

export interface LedgerScopeLifecycleChange {
  readonly ledgerId: string;
  readonly state: LedgerScopeLifecycleState;
}

/** A scope and the container incarnation it is being moved to. */
export interface LedgerScopeRebinding extends LedgerScopeIdentity {
  readonly ledgerId: string;
}

/**
 * Validates a container tuple and canonicalizes its creation time, so two
 * spellings of the same instant identify the same incarnation.
 */
export function parseLedgerScopeIdentity(
  container: LedgerContainer,
  containerCreatedAt: string,
): LedgerScopeIdentity {
  const parsed = parseLedgerInput(
    LedgerContainerSchema,
    container,
    'container',
  );
  const canonical = canonicalizeLedgerInstant(containerCreatedAt);
  if (canonical === null) {
    throw new LedgerStoreError('INVALID_INPUT', {
      field: 'containerCreatedAt',
    });
  }
  return {
    container: parsed,
    columns: toContainerColumns(parsed),
    containerCreatedAt: canonical,
  };
}

/** Validates a container tuple on its own, for lookups across incarnations. */
export function parseLedgerContainerColumns(
  container: LedgerContainer,
): LedgerContainerColumns {
  return toContainerColumns(
    parseLedgerInput(LedgerContainerSchema, container, 'container'),
  );
}

export function parseLedgerScopeBinding(
  input: LedgerBindScopeInput,
): LedgerScopeBinding {
  return {
    ...parseLedgerScopeIdentity(input.container, input.containerCreatedAt),
    authorityId: parseLedgerInput(
      LedgerOpaqueIdSchema,
      input.authorityId,
      'authorityId',
    ),
    accountId:
      input.accountId === null
        ? null
        : parseLedgerInput(LedgerOpaqueIdSchema, input.accountId, 'accountId'),
  };
}

/**
 * A ledger ID addresses the scope the store minted it for. Any other string
 * simply finds no scope; a value that is not a string is invalid input.
 */
export function parseLedgerIdInput(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LedgerStoreError('INVALID_INPUT', { field: 'ledgerId' });
  }
  return value;
}

export function parseLedgerScopeLifecycleChange(
  input: LedgerSetScopeLifecycleInput,
): LedgerScopeLifecycleChange {
  const ledgerId = parseLedgerIdInput(input.ledgerId);
  const state: unknown = input.state;
  if (!isLedgerScopeLifecycleState(state)) {
    throw new LedgerStoreError('INVALID_INPUT', { field: 'state' });
  }
  return { ledgerId, state };
}

export function parseLedgerScopeRebinding(
  input: LedgerRebindScopeInput,
): LedgerScopeRebinding {
  const ledgerId = parseLedgerIdInput(input.ledgerId);
  return {
    ...parseLedgerScopeIdentity(input.container, input.containerCreatedAt),
    ledgerId,
  };
}

export function parseLedgerActorRegistration(
  input: LedgerRegisterActorInput,
): LedgerActorRegistration {
  const originKey = input.originKey;
  if (
    typeof originKey !== 'string' ||
    originKey.length === 0 ||
    countCodePoints(originKey) > LEDGER_ACTOR_ORIGIN_KEY_MAX_CODE_POINTS
  ) {
    throw new LedgerStoreError('INVALID_INPUT', {
      field: 'originKey',
      limit: LEDGER_ACTOR_ORIGIN_KEY_MAX_CODE_POINTS,
    });
  }
  return {
    kind: parseLedgerInput(LedgerActorKindSchema, input.kind, 'kind'),
    authorityId: parseLedgerInput(
      LedgerOpaqueIdSchema,
      input.authorityId,
      'authorityId',
    ),
    originKey,
    displayName: parseLedgerInput(
      LedgerDisplayNameSchema,
      input.displayName,
      'displayName',
    ),
  };
}

/**
 * A repeated registration returns the existing actor, whose display name is
 * the snapshot taken at first registration. Another kind or authority under
 * the same origin key is a host error.
 */
export function assertSameLedgerActorRegistration(
  existing: LedgerActorRecord,
  registration: LedgerActorRegistration,
): LedgerActorRecord {
  if (existing.actor.kind !== registration.kind) {
    throw new LedgerStoreError('INVALID_INPUT', { field: 'kind' });
  }
  if (existing.actor.authorityId !== registration.authorityId) {
    throw new LedgerStoreError('FORBIDDEN', { field: 'authorityId' });
  }
  return existing;
}
