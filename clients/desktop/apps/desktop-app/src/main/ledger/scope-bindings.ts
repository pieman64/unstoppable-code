import {
  LedgerContainerSchema,
  type LedgerContainer,
} from '@canopy/protocol/canopy-core';
import { readWorkEntriesFile } from '../lib/cowork-work-entries-file';
import { getWorkspaceWorktreeCreatedAt } from '../lib/workspace-persistence';
import type { LedgerScopeRecord } from '@canopy/desktop-shared/node/ledger';
import type { LedgerStoreClient } from './ledger-store-client';

/*
 * Scope identity follows the browser task-slot pattern (E03): a container
 * incarnation is its container tuple plus the container's own creation time,
 * and it maps to the `ledgerId` the store minted for it. A container ID reused
 * with a new creation time is a new incarnation, so it gets a new ledger. The
 * mapping lives in the Ledger database; nothing is written to `worktrees.json`
 * or `work-entries.json`.
 */

/** A container incarnation's ledger, as later Ledger calls address it. */
export interface LedgerBoundScope {
  readonly ledgerId: string;
  /** The writer authority the scope was bound under. */
  readonly authorityId: string;
  readonly container: LedgerContainer;
  /** Canonical UTC form of the container's creation time. */
  readonly containerCreatedAt: string;
  /**
   * The account the ledger was minted under, the only one it syncs to; null
   * when it was first used signed out (LD02).
   */
  readonly accountId: string | null;
}

export interface LedgerScopeBindingsOptions {
  /** The store client. Called only when a scope is first bound. */
  readonly store: () => LedgerStoreClient;
  /**
   * The signed-in account, recorded when a ledger is minted and never
   * rebound. Null when signed out.
   */
  readonly getAccountId: () => string | null | Promise<string | null>;
}

/** The parent and item IDs of a container tuple. */
function containerIds(container: LedgerContainer): [string, string] {
  switch (container.kind) {
    case 'code_worktree':
      return [container.workspaceId, container.worktreeId];
    case 'cowork_entry':
      return [container.workspaceId, container.entryId];
    case 'advisor_entry':
      return [container.appWorkspaceId, container.entryId];
  }
}

/**
 * Identity of a container tuple, without its creation time. JSON keeps it
 * unambiguous whatever characters the opaque IDs contain.
 */
export function ledgerContainerKey(container: LedgerContainer): string {
  return JSON.stringify([container.kind, ...containerIds(container)]);
}

function incarnationKey(
  container: LedgerContainer,
  containerCreatedAt: string,
): string {
  return JSON.stringify([
    container.kind,
    ...containerIds(container),
    containerCreatedAt,
  ]);
}

/** A cached incarnation: its container's identity and its pending binding. */
interface LedgerCachedIncarnation {
  readonly containerKey: string;
  readonly scope: Promise<LedgerBoundScope>;
}

/** A stored scope as the service binds it. */
function toBoundScope(scope: LedgerScopeRecord): LedgerBoundScope {
  return Object.freeze({
    ledgerId: scope.scope.ledgerId,
    authorityId: scope.scope.authorityId,
    // Rebuilt from the plain data that crossed the storage worker boundary.
    container: Object.freeze(
      LedgerContainerSchema.parse(scope.scope.container),
    ),
    containerCreatedAt: scope.containerCreatedAt,
    accountId: scope.accountId,
  });
}

/**
 * Caches container incarnations' ledgers for this process. The first use of
 * an incarnation binds it in the store, which mints the ledger; concurrent
 * first uses share that one call. Nothing touches storage until then.
 */
export class LedgerScopeBindings {
  private readonly options: LedgerScopeBindingsOptions;
  private authorityId: Promise<string> | undefined;
  private readonly byIncarnation = new Map<string, LedgerCachedIncarnation>();

  constructor(options: LedgerScopeBindingsOptions) {
    this.options = options;
  }

  /**
   * The ledger bound to a container incarnation, minting it on first use
   * under the store's writer authority and the signed-in account.
   */
  resolve(
    container: LedgerContainer,
    containerCreatedAt: string,
  ): Promise<LedgerBoundScope> {
    const key = incarnationKey(container, containerCreatedAt);
    const cached = this.byIncarnation.get(key);
    if (cached !== undefined) return cached.scope;
    const entry: LedgerCachedIncarnation = {
      containerKey: ledgerContainerKey(container),
      scope: this.bind(container, containerCreatedAt),
    };
    this.byIncarnation.set(key, entry);
    // A failed bind is not cached, so the next use tries again.
    void entry.scope.catch((): void => {
      if (this.byIncarnation.get(key) === entry) {
        this.byIncarnation.delete(key);
      }
    });
    return entry.scope;
  }

  /**
   * Forgets every cached incarnation of a container, settled or still
   * binding, so the next use asks the store again. Scope lifecycle changes
   * call it once a scope was purged or moved to another container. Callers
   * already holding a binding keep it.
   */
  forgetContainer(container: LedgerContainer): void {
    const containerKey = ledgerContainerKey(container);
    this.byIncarnation.forEach((entry, key): void => {
      if (entry.containerKey === containerKey) this.byIncarnation.delete(key);
    });
  }

  /**
   * Forgets every cached incarnation, as after the scopes of a merged guest
   * account moved to the account it became.
   */
  forgetAll(): void {
    this.byIncarnation.clear();
  }

  /**
   * A container incarnation's existing scope, looked up without writing:
   * for reads of a database this build may only read. Null when there is
   * none. Nothing is cached, so a later `resolve` still binds as usual.
   */
  async find(
    container: LedgerContainer,
    containerCreatedAt: string,
  ): Promise<LedgerBoundScope | null> {
    const scope = await this.options
      .store()
      .findScope({ container, containerCreatedAt });
    return scope === null ? null : toBoundScope(scope);
  }

  private async bind(
    container: LedgerContainer,
    containerCreatedAt: string,
  ): Promise<LedgerBoundScope> {
    const store = this.options.store();
    const authorityId = await this.getAuthorityId(store);
    const accountId = await this.options.getAccountId();
    const { scope } = await store.bindScope({
      authorityId,
      container,
      containerCreatedAt,
      accountId,
    });
    return toBoundScope(scope);
  }

  /** The durable writer identity minted with the database, read once. */
  private getAuthorityId(store: LedgerStoreClient): Promise<string> {
    if (this.authorityId !== undefined) return this.authorityId;
    const pending = store.getAuthorityId();
    this.authorityId = pending;
    void pending.catch((): void => {
      if (this.authorityId === pending) this.authorityId = undefined;
    });
    return pending;
  }
}

/** Reads a container's creation time from the persistence that owns it. */
export interface LedgerContainerCreatedAtReaders {
  readonly worktreeCreatedAt: (
    workspaceId: string,
    worktreeId: string,
  ) => Promise<string | null>;
  /** Cowork Work Entries, and Advisor Work Entries under `app-advisor`. */
  readonly workEntryCreatedAt: (
    workspaceId: string,
    entryId: string,
  ) => Promise<string | null>;
}

/** Mirrors `validateId`: persisted workspace, worktree and entry IDs. */
const SAFE_CONTAINER_ID = /^[a-z0-9][a-z0-9-]*$/;

async function readWorkEntryCreatedAt(
  workspaceId: string,
  entryId: string,
): Promise<string | null> {
  const file = await readWorkEntriesFile(workspaceId);
  return file.entries.find((entry) => entry.id === entryId)?.createdAt ?? null;
}

/**
 * Worktree `createdAt` from `worktrees.json`; Cowork and Advisor Work Entry
 * `createdAt` from `work-entries.json` (the Advisor's under
 * `app-workspaces/app-advisor/`).
 */
export const DESKTOP_LEDGER_CONTAINER_CREATED_AT_READERS: LedgerContainerCreatedAtReaders =
  {
    worktreeCreatedAt: getWorkspaceWorktreeCreatedAt,
    workEntryCreatedAt: readWorkEntryCreatedAt,
  };

/**
 * The creation time that, with the container tuple, identifies a container
 * incarnation for `LedgerScopeBindings.resolve`. Null when the container does
 * not exist (or its IDs are not persisted IDs), so no binding can be made.
 */
export async function resolveLedgerContainerCreatedAt(
  container: LedgerContainer,
  readers: LedgerContainerCreatedAtReaders = DESKTOP_LEDGER_CONTAINER_CREATED_AT_READERS,
): Promise<string | null> {
  const [parentId, itemId] = containerIds(container);
  if (!SAFE_CONTAINER_ID.test(parentId) || !SAFE_CONTAINER_ID.test(itemId)) {
    return null;
  }
  const createdAt =
    container.kind === 'code_worktree'
      ? await readers.worktreeCreatedAt(parentId, itemId)
      : await readers.workEntryCreatedAt(parentId, itemId);
  return typeof createdAt === 'string' && createdAt.length > 0
    ? createdAt
    : null;
}

/**
 * The creation time of a container's archived scope, so archived work stays
 * readable once its container is gone from the registry. Null when the
 * Ledger holds no archived scope for the container, or more than one (its ID
 * was reused), so a read never guesses between them.
 */
export async function resolveArchivedLedgerContainerCreatedAt(
  container: LedgerContainer,
  store: Pick<LedgerStoreClient, 'findContainerScopes'>,
): Promise<string | null> {
  const archived = (await store.findContainerScopes(container)).filter(
    (scope) => scope.lifecycleState === 'archived',
  );
  const [only] = archived;
  return archived.length === 1 && only !== undefined
    ? only.containerCreatedAt
    : null;
}
