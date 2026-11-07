import type {
  CanopyCallerDescriptor,
  CatalogEntry,
  CatalogSelectionRefs,
  CatalogSource,
} from '@canopy/protocol/canopy-core';

/*
 * The ports a host implements to serve `core.catalog.*` (CAN-4123). The host
 * owns its stores and their writers; the handlers own the contract.
 */

export type CatalogSelectionScope =
  | { kind: 'global' }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'chat'; workspaceId: string; worktreeId: string; chatId: string };

export interface CatalogSelectionRead {
  /** Equality-only tag (global, chat) or the W5 workspace revision (workspace). */
  revision: number;
  /** Global: the defaults. Workspace: its own defaults. Chat: the effective selection. */
  selections: CatalogSelectionRefs;
  /** Workspace: its rejections of global defaults. Chat: its own tombstones. Global: null. */
  tombstones: CatalogSelectionRefs | null;
}

export interface CatalogSnapshotRead {
  /** Every entry the host serves, all availabilities, timestamps included. */
  entries: CatalogEntry[];
  /** The refs of every entry above, for id resolution. */
  refs: CatalogSelectionRefs;
}

/** A source as the host lists it; its revision comes from catalogContentRevision. */
export type CatalogSourceRecord = CatalogSource;

export interface CatalogRefreshPlan {
  operationId: string;
  mode: 'scan' | 'update_then_scan';
  /** True when the request named every registered source. */
  all: boolean;
  /** Git sources to update, in request order. */
  updateSourceIds: readonly string[];
  scanOnlySourceIds: readonly string[];
}

export interface CatalogRefreshOutcome {
  refreshed: string[];
  failed: string[];
}

export interface CatalogPluginTarget {
  entryId: string;
  marketplaceId: string;
  pluginName: string;
  install: 'managed' | 'external' | 'none';
}

/** What an install did for each requested provider. */
export interface CatalogPluginInstallOutcome {
  installed: ('claude' | 'codex')[];
  failed: ('claude' | 'codex')[];
}

export interface CoreCatalogHost {
  snapshot(): Promise<CatalogSnapshotRead>;
  /** Throws CatalogSelectionNotFoundError or CatalogSelectionUnavailableError. */
  readSelection(scope: CatalogSelectionScope): Promise<CatalogSelectionRead>;
  /** Compare-and-swap inside the host's serialized writer. */
  replaceGlobalSelection(
    expectedRevision: number,
    refs: CatalogSelectionRefs,
  ): Promise<{ outcome: 'replaced' | 'conflict'; read: CatalogSelectionRead }>;
  /** Through core.workspace.plugins.update; throws CatalogHostRefusedError for its refusals. */
  replaceWorkspaceSelection(request: {
    workspaceId: string;
    expectedRevision: number;
    refs: CatalogSelectionRefs;
    idempotencyKey: string;
    caller: CanopyCallerDescriptor;
  }): Promise<CatalogSelectionRead>;
  listSources(): Promise<CatalogSourceRecord[]>;
  addGitSource(repository: string): Promise<CatalogSourceRecord>;
  /** `guard` runs inside the host's mutation slot, before any effect. */
  deleteSource(request: {
    sourceId: string;
    providers: readonly ('claude' | 'codex')[];
    guard: (
      current: CatalogSourceRecord | null,
    ) => 'proceed' | 'conflict' | 'absent' | 'builtin';
  }): Promise<{
    removedProviders: ('claude' | 'codex')[];
    alreadyAbsent: boolean;
  }>;
  refreshSources(plan: CatalogRefreshPlan): Promise<CatalogRefreshOutcome>;
  findPlugin(entryId: string): Promise<CatalogPluginTarget | null>;
  installPlugin(
    target: CatalogPluginTarget,
    providers: readonly ('claude' | 'codex')[],
  ): Promise<CatalogPluginInstallOutcome>;
}

function defineCause(error: Error, cause: unknown): void {
  if (cause !== undefined)
    Object.defineProperty(error, 'cause', {
      value: cause,
      writable: true,
      configurable: true,
    });
}

export class CatalogSelectionNotFoundError extends Error {
  readonly code = 'CATALOG_SELECTION_NOT_FOUND';
  constructor() {
    super('The selection was not found.');
    this.name = 'CatalogSelectionNotFoundError';
  }
}

export class CatalogSelectionUnavailableError extends Error {
  readonly code = 'CATALOG_SELECTION_UNAVAILABLE';
  // `declare`: only some programs' libs (via type-fest) give Error a `cause`.
  declare readonly cause?: unknown;
  constructor(cause?: unknown) {
    super('This selection cannot be read right now.');
    this.name = 'CatalogSelectionUnavailableError';
    defineCause(this, cause);
  }
}

export type CatalogHostRefusal =
  | 'source-invalid'
  | 'source-provider-rejected'
  | 'source-not-found'
  | 'source-provider-failed'
  | 'source-builtin'
  | 'source-conflict'
  | 'plugin-not-found'
  | 'plugin-not-installable'
  | 'plugin-source-rejected'
  | 'plugin-uninstall-pending'
  | 'plugin-install-failed'
  | 'workspace-revision-conflict'
  | 'workspace-not-found'
  | 'workspace-unavailable'
  | 'workspace-key-reused'
  | 'workspace-in-progress'
  | 'workspace-recovery-required'
  | 'workspace-outcome-expired';

/** A host refusal; `cause` is the host error a local projection may surface (D18). */
export class CatalogHostRefusedError extends Error {
  declare readonly cause?: unknown;
  constructor(
    readonly refusal: CatalogHostRefusal,
    cause?: unknown,
  ) {
    super('The catalog host refused this change.');
    this.name = 'CatalogHostRefusedError';
    defineCause(this, cause);
  }
}
