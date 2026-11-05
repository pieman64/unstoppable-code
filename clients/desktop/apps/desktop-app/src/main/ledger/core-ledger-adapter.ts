import type {
  CanopyInstructionHandler,
  CanopyQueryHandler,
  LedgerContainer,
  LedgerGlobalOwner,
} from '@canopy/protocol/canopy-core';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type { CanopyHandlerContext } from '@canopy/core-runtime';
import { getFeatureFlagService } from '../feature-flags';
import { readCanopyCloudAccountWithStatus } from '../lib/canopy-cloud-account-store';
import { readLedgerContainerLiveChats } from './actor-directory';
import { notifyLedgerEntryChanged, onLedgerSyncChanged } from './change-events';
import { readLedgerContainerLiveDelegates } from './delegate-owners';
import { getLedgerPipelineAgentOwners } from './pipeline-agent-owners';
import type { LedgerStoreClient } from './ledger-store-client';
import type { LedgerBoundScope } from './scope-bindings';
import { registerLedgerLifecycleCaches } from './lifecycle';
import {
  createLedgerService,
  type LedgerCoreService,
  type LedgerService,
} from './service';
import type {
  LedgerCommandOperation,
  LedgerQueryOperation,
} from './service-errors';
import { resolveDesktopLedgerSourceAvailability } from './source-resolver';
import { getLedgerStoreClient } from './storage-client';
import { desktopLedgerSyncStatus } from './sync-host';

/*
 * Registers the `core.ledger.*` operations on the desktop dispatcher. The
 * handlers are thin: the dispatcher has already validated params, metadata
 * and grants, and the service does the rest.
 */

export type CoreLedgerQueryHandlers = {
  [Name in LedgerQueryOperation]: CanopyQueryHandler<
    Name,
    CanopyHandlerContext
  >;
};

export type CoreLedgerInstructionHandlers = {
  [Name in LedgerCommandOperation]: CanopyInstructionHandler<
    Name,
    CanopyHandlerContext
  >;
};

export function createCoreLedgerQueryHandlers(
  service: LedgerService,
): CoreLedgerQueryHandlers {
  return {
    'core.ledger.entries.search': (params, context) =>
      service.searchEntries(params, context),
    'core.ledger.entry.get': (params, context) =>
      service.getEntry(params, context),
    'core.ledger.owners.list': (params, context) =>
      service.listOwners(params, context),
    'core.ledger.workSummary.get': (params, context) =>
      service.getWorkSummary(params, context),
    'core.ledger.changes.list': (params, context) =>
      service.listChanges(params, context),
    'core.ledger.rollups.list': (params, context) =>
      service.listRollups(params, context),
  };
}

export function createCoreLedgerInstructionHandlers(
  service: LedgerService,
): CoreLedgerInstructionHandlers {
  return {
    'core.ledger.entry.add': (params, context) =>
      service.addEntry(params, context),
    'core.ledger.entry.update': (params, context) =>
      service.updateEntry(params, context),
    'core.ledger.summary.publish': (params, context) =>
      service.publishSummary(params, context),
  };
}

function isLedgerFlagEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key,
  );
}

/** The signed-in account's server ID, or null when signed out or unreadable. */
export async function readSignedInLedgerAccountId(): Promise<string | null> {
  const result = await readCanopyCloudAccountWithStatus();
  const accountId =
    result.status === 'ok' ? result.entry?.account?.id.trim() : undefined;
  return accountId !== undefined && accountId.length > 0 ? accountId : null;
}

/**
 * The account a global (workflow) Ledger belongs to: the signed-in account's
 * server ID, or null when signed out. Throws when the account cannot be read,
 * so a failed read never selects the signed-out Ledger.
 */
export async function readLedgerGlobalAccountId(): Promise<string | null> {
  const result = await readCanopyCloudAccountWithStatus();
  if (result.status !== 'ok') {
    throw new Error('The signed-in account could not be read');
  }
  const accountId = result.entry?.account?.id.trim();
  return accountId !== undefined && accountId.length > 0 ? accountId : null;
}

/**
 * The desktop Ledger service: the storage worker's store client, the
 * `canopy-ledger-enabled` flag, the signed-in account, canonical chat state,
 * the retained delegates managed delegation registers once it loads and the
 * pipeline agents paused on a resumable checkpoint. Entry reads resolve their
 * source on this device and report how they sync, and committed changes
 * reach the Ledger views and sync. Creating it opens no database and starts
 * no worker; the store client is created on the first operation that reaches
 * storage.
 */
export function createDesktopLedgerService(): LedgerCoreService {
  return createLedgerService({
    store: (): LedgerStoreClient => getLedgerStoreClient(),
    isEnabled: isLedgerFlagEnabled,
    getAccountId: readSignedInLedgerAccountId,
    getGlobalAccountId: readLedgerGlobalAccountId,
    liveChats: readLedgerContainerLiveChats,
    liveDelegates: readLedgerContainerLiveDelegates,
    pipelineAgents: getLedgerPipelineAgentOwners(),
    resolveSourceAvailability: resolveDesktopLedgerSourceAvailability,
    syncStatus: desktopLedgerSyncStatus,
    onEntryChanged: notifyLedgerEntryChanged,
  });
}

let desktopLedgerService: LedgerCoreService | undefined;

/**
 * The app's Ledger service, created on first use. Scope lifecycle changes
 * (a purge, or a rebind on restore) evict the scopes and actors it caches.
 */
export function getDesktopLedgerService(): LedgerService {
  return getDesktopLedgerCoreService();
}

function getDesktopLedgerCoreService(): LedgerCoreService {
  if (desktopLedgerService === undefined) {
    const service = createDesktopLedgerService();
    desktopLedgerService = service;
    registerLedgerLifecycleCaches({
      forgetContainer: (container): void =>
        service.scopes.forgetContainer(container),
      forgetLedger: (ledgerId): void => service.actors.forgetLedger(ledgerId),
    });
    // A merged guest's scopes now carry the account it became.
    onLedgerSyncChanged((change): void => {
      if (change.kind === 'accounts_rebound') service.scopes.forgetAll();
    });
  }
  return desktopLedgerService;
}

/**
 * The ledger of a container incarnation, minting it on first use, through
 * the same cache the handlers use. For host bookkeeping that needs the ledger
 * ID before a command, such as a Summary publication's idempotency key; check
 * `canopy-ledger-enabled` first.
 */
export function resolveDesktopLedgerScope(
  container: LedgerContainer,
  containerCreatedAt: string,
): Promise<LedgerBoundScope> {
  return getDesktopLedgerCoreService().scopes.resolve(
    container,
    containerCreatedAt,
  );
}

/**
 * An owner's global (workflow) Ledger for the signed-in account, minting it
 * on first use, through the same cache the handlers use. Only the pipeline
 * host binds one, once its exposure gate passed.
 */
export function resolveDesktopGlobalLedgerScope(
  owner: LedgerGlobalOwner,
): Promise<LedgerBoundScope> {
  return getDesktopLedgerCoreService().scopes.resolveGlobal(owner);
}

/**
 * An owner's global (workflow) Ledger for the signed-in account, looked up
 * without minting one: null when that account never recorded there.
 */
export async function findDesktopGlobalLedgerScope(
  owner: LedgerGlobalOwner,
): Promise<LedgerBoundScope | null> {
  const { scopes } = getDesktopLedgerCoreService();
  return scopes.findGlobal(owner, await scopes.readGlobalAccountId());
}
