import {
  CanopyStreamCursorSchema,
  type CanopyErrorKind,
  type CanopyStreamCursor,
} from '@canopy/protocol/canopy-core';

import { CanopyClientError, MAX_ERROR_MESSAGE_LENGTH } from './errors';
import type { CanopyClient, CanopyRuntimeIdentity } from './types';

/** The client surface the registry reads; any typed `CanopyClient` fits. */
export interface CanopyAuthorityConnection {
  // CAN-4163 part two restores the full identity (runtimeId, hostId, daemonEpoch) for cursor domains once the CAN-4155 web-core handshake supplies it.
  readonly identity: Pick<CanopyRuntimeIdentity, 'authorityId' | 'profile'>;
  readonly signal: CanopyClient['signal'];
}

export type CanopyCommandDestination =
  | { readonly mode: 'authority'; readonly authorityId: string }
  | {
      readonly mode: 'primary-routed';
      readonly primaryAuthorityId: string;
      /** Opaque to the registry; it may equal another registered authority. */
      readonly executionTargetId: string;
    };

export type CanopyResolvedRoute<C extends CanopyAuthorityConnection> =
  | {
      readonly mode: 'authority';
      readonly authorityId: string;
      readonly client: C;
      readonly executionTargetId: null;
    }
  | {
      readonly mode: 'primary-routed';
      readonly authorityId: string;
      readonly client: C;
      readonly executionTargetId: string;
    };

/** Stores the last cursor for one entry; it never inspects sequence or epoch order. */
export interface CanopyAuthorityCursorSlot {
  readonly authorityId: string;
  read(): Readonly<CanopyStreamCursor> | null;
  write(cursor: CanopyStreamCursor): void;
  clear(): void;
}

export interface CanopyAuthorityRegistry<C extends CanopyAuthorityConnection> {
  readonly primaryAuthorityId: string;
  authorityIds(): readonly string[];
  client(authorityId: string): C;
  cursor(authorityId: string): CanopyAuthorityCursorSlot;
  /** Registers a connected core client and returns its authority ID. */
  add(client: C): string;
  /** Forgets the entry without closing its client; the primary cannot be removed. */
  remove(authorityId: string): void;
  setPrimary(authorityId: string): void;
  /** Never fails over: a disconnected destination fails `unavailable`. */
  resolve(destination: CanopyCommandDestination): CanopyResolvedRoute<C>;
}

export interface CanopyAuthorityRegistryOptions<
  C extends CanopyAuthorityConnection,
> {
  readonly primary: C;
}

interface Entry<C> {
  readonly client: C;
  readonly slot: CanopyAuthorityCursorSlot;
}

function registryError(
  kind: CanopyErrorKind,
  message: string,
): CanopyClientError {
  return new CanopyClientError({
    kind,
    message: message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
    retry: { kind: 'never' },
  });
}

function createCursorSlot(authorityId: string): CanopyAuthorityCursorSlot {
  let stored: Readonly<CanopyStreamCursor> | null = null;
  return Object.freeze({
    authorityId,
    read: () => stored,
    write(cursor: CanopyStreamCursor): void {
      const parsed = CanopyStreamCursorSchema.safeParse(cursor);
      if (!parsed.success)
        throw registryError('invalid_argument', 'Invalid stream cursor.');
      stored = Object.freeze({ ...parsed.data });
    },
    clear(): void {
      stored = null;
    },
  });
}

function assertConnected(
  authorityId: string,
  client: CanopyAuthorityConnection,
): void {
  if (client.signal.aborted)
    throw registryError(
      'unavailable',
      `Authority ${authorityId} is disconnected.`,
    );
}

/**
 * Registry of initialized core clients keyed by authority ID. The constructor
 * registers `primary`, so a registry is never empty.
 */
export function createCanopyAuthorityRegistry<
  C extends CanopyAuthorityConnection,
>(options: CanopyAuthorityRegistryOptions<C>): CanopyAuthorityRegistry<C> {
  const entries = new Map<string, Entry<C>>();

  function entryFor(authorityId: string): Entry<C> {
    const entry = entries.get(authorityId);
    if (!entry)
      throw registryError('not_found', `Unknown authority ${authorityId}.`);
    return entry;
  }

  function add(client: C): string {
    const identity = client.identity;
    const authorityId = identity.authorityId;
    if (authorityId === null || authorityId === '')
      throw registryError(
        'invalid_argument',
        'The client has no authority ID.',
      );
    if (identity.profile === 'worker')
      throw registryError(
        'invalid_argument',
        `Authority ${authorityId} is a worker runtime, not a core.`,
      );
    assertConnected(authorityId, client);
    if (entries.has(authorityId))
      throw registryError(
        'already_exists',
        `Authority ${authorityId} is already registered.`,
      );
    entries.set(authorityId, { client, slot: createCursorSlot(authorityId) });
    return authorityId;
  }

  let primaryAuthorityId = add(options.primary);

  function liveClient(authorityId: string): C {
    const { client } = entryFor(authorityId);
    assertConnected(authorityId, client);
    return client;
  }

  return Object.freeze({
    get primaryAuthorityId(): string {
      return primaryAuthorityId;
    },
    authorityIds: () => Object.freeze(Array.from(entries.keys())),
    client: (authorityId: string) => entryFor(authorityId).client,
    cursor: (authorityId: string) => entryFor(authorityId).slot,
    add,
    remove(authorityId: string): void {
      entryFor(authorityId);
      if (authorityId === primaryAuthorityId)
        throw registryError(
          'failed_precondition',
          `Authority ${authorityId} is the primary; select another first.`,
        );
      entries.delete(authorityId);
    },
    setPrimary(authorityId: string): void {
      liveClient(authorityId);
      primaryAuthorityId = authorityId;
    },
    resolve(destination: CanopyCommandDestination): CanopyResolvedRoute<C> {
      if (destination.mode === 'authority') {
        const { authorityId } = destination;
        const client = liveClient(authorityId);
        return Object.freeze({
          mode: 'authority',
          authorityId,
          client,
          executionTargetId: null,
        });
      }
      const { primaryAuthorityId: authorityId, executionTargetId } =
        destination;
      if (executionTargetId === '')
        throw registryError(
          'invalid_argument',
          'A primary-routed destination needs an execution target.',
        );
      if (authorityId !== primaryAuthorityId)
        throw registryError(
          'failed_precondition',
          `Authority ${authorityId} is not the selected primary.`,
        );
      const client = liveClient(authorityId);
      return Object.freeze({
        mode: 'primary-routed',
        authorityId,
        client,
        executionTargetId,
      });
    },
  });
}
