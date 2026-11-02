import type {
  MarketplaceSourceType,
  PluginProvider,
  PluginProviderSupport,
} from '@canopy/protocol/plugins';
import type {
  MarketplaceSourceAddSession,
  MarketplaceSourceAddContext,
} from './marketplace-source-add';

/** Presentation permissions for this surface, never a substitute for authorization. */
export interface MarketplaceSourceActions {
  readonly update: boolean;
  readonly remove: boolean;
}

export interface MarketplaceSourceError {
  readonly label: string;
  /** Plain text; may contain private repository information. */
  readonly message: string;
  readonly provider?: PluginProvider;
}

export type MarketplaceSourceStatus = {
  readonly note?: string;
} & (
  | {
      readonly state: 'valid' | 'syncing';
      /** Retain failures from other providers even when one provider is valid. */
      readonly errors: readonly MarketplaceSourceError[];
    }
  | {
      readonly state: 'invalid';
      /** Hosts supply a safe fallback when the provider omitted error text. */
      readonly errors: readonly [
        MarketplaceSourceError,
        ...MarketplaceSourceError[],
      ];
    }
);

/** Path-free provider status; do not pass through provider facets or install roots. */
export interface MarketplaceSourceProviderStatus {
  readonly state: 'valid' | 'invalid';
  readonly accepted: boolean;
  readonly pluginCount: number;
  readonly lastCheckedAt?: string;
  readonly error?: string;
}

export interface MarketplaceSourceProviderInstallState {
  readonly available: boolean;
  readonly installed: boolean;
  readonly enabled?: boolean;
  readonly version?: string;
  readonly error?: string;
  readonly installError?: string;
}

export interface MarketplaceSourcePluginInstallState {
  /** Match pluginNeedsInstall: external source with no content on any facet. */
  readonly externalSource: boolean;
  readonly hasContent: boolean;
  readonly providers: Readonly<
    Partial<Record<PluginProvider, MarketplaceSourceProviderInstallState>>
  >;
  readonly checkedAt?: string;
  readonly codexCompatDisabled?: boolean;
}

export interface MarketplaceSourcePlugin {
  /** Stable only within its source. Use (source.id, key), never name, as identity. */
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  readonly version?: string;
  readonly categories?: readonly string[];
  readonly author?: string;
  readonly recommended?: boolean;
  readonly providerSupport?: PluginProviderSupport;
  /** Absent when installation is unsupported, including cloud sources. */
  readonly installState?: MarketplaceSourcePluginInstallState;
}

export interface MarketplaceSource {
  /** Opaque host API id. May contain slashes; never assume it is a catalog id. */
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly kind: MarketplaceSourceType;
  readonly sourceLabel: string;
  /** Hosts validate external URLs and omit unsafe schemes and local paths. */
  readonly sourceUrl?: string;
  readonly status: MarketplaceSourceStatus;
  readonly lastUpdatedAt?: string;
  readonly pluginCount: number;
  readonly actions: MarketplaceSourceActions;
  readonly plugins: readonly MarketplaceSourcePlugin[];
  readonly providerStatus?: Readonly<
    Partial<Record<PluginProvider, MarketplaceSourceProviderStatus>>
  >;
}

export interface MarketplaceSourcesSnapshot {
  readonly sources: readonly MarketplaceSource[];
  /** ISO time of the last successful authoritative read, not a GitHub sync time. */
  readonly lastRefreshedAt: string;
}

export type MarketplaceSourceRemoveResult =
  | { readonly removed: true }
  | {
      readonly removed: false;
      readonly source: MarketplaceSource;
      /** Post-operation warning; confirmation copy belongs to the host. */
      readonly warning: string;
    };

export interface MarketplaceSourcePluginInstallResult {
  readonly sourceId: string;
  readonly plugin: MarketplaceSourcePlugin;
  /** Keep partial provider failures even when another provider installed successfully. */
  readonly providerOutcomes: Readonly<
    Partial<
      Record<
        PluginProvider,
        { readonly installed: boolean; readonly error?: string }
      >
    >
  >;
}

export interface MarketplaceSourceProgress {
  /** Unscoped host events must not be attributed to an arbitrary source. */
  readonly sourceId?: string;
  readonly pluginKey?: string;
  readonly operation: 'refresh' | 'update' | 'remove' | 'install';
  readonly status: 'running' | 'complete' | 'error';
  readonly message: string;
  readonly currentStep?: number;
  readonly totalSteps?: number;
}

export type MarketplaceSourceOperation = 'update' | 'remove' | 'install';

export interface MarketplaceSourceOperationsSnapshot {
  readonly operations: Readonly<Record<string, MarketplaceSourceOperation>>;
  readonly refreshing: boolean;
}

/** Ownership outlives a view; a release belongs to the operation that acquired it. */
export function createMarketplaceSourceOperations(): {
  getSnapshot: () => MarketplaceSourceOperationsSnapshot;
  subscribe: (listener: () => void) => () => void;
  acquire: (
    sourceId: string | null,
    operation: MarketplaceSourceOperation,
  ) => (() => void) | null;
} {
  let snapshot: MarketplaceSourceOperationsSnapshot = {
    operations: {},
    refreshing: false,
  };
  const listeners = new Set<() => void>();
  const publish = (next: MarketplaceSourceOperationsSnapshot): void => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    acquire(sourceId, operation): (() => void) | null {
      if (
        snapshot.refreshing ||
        (sourceId === null
          ? Object.keys(snapshot.operations).length > 0
          : snapshot.operations[sourceId] !== undefined)
      )
        return null;
      publish(
        sourceId === null
          ? { ...snapshot, refreshing: true }
          : {
              ...snapshot,
              operations: { ...snapshot.operations, [sourceId]: operation },
            },
      );
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const operations = { ...snapshot.operations };
        if (sourceId !== null) delete operations[sourceId];
        publish({
          operations,
          refreshing: sourceId === null ? false : snapshot.refreshing,
        });
      };
    },
  };
}

export type MarketplaceSourceOperations = ReturnType<
  typeof createMarketplaceSourceOperations
>;

/**
 * Portable source-management boundary. Hosts own transport, cache reconciliation,
 * authorization and provider behavior. Failures reject with display-safe Errors.
 */
export interface MarketplaceSourcesClient {
  createAddSession?(
    context?: MarketplaceSourceAddContext,
  ): MarketplaceSourceAddSession;
  /** Optional shared ownership with retained host surfaces. */
  readonly operations?: MarketplaceSourceOperations;
  /** Initial rendering only; reconciliation always calls list(). */
  cachedSnapshot?(): MarketplaceSourcesSnapshot | null;
  list(): Promise<MarketplaceSourcesSnapshot>;
  /** Desktop forces refresh; web only re-reads the authoritative inventory. */
  refreshAll(): Promise<MarketplaceSourcesSnapshot>;
  /**
   * Return authoritative source state after update. Web hosts own preview and
   * confirmation with expectedRevision; a revision mismatch ends this attempt.
   * Any required preview decision must precede confirmation.
   */
  update(sourceId: string): Promise<MarketplaceSource>;
  remove(sourceId: string): Promise<MarketplaceSourceRemoveResult>;
  installPlugin?(
    sourceId: string,
    pluginKey: string,
  ): Promise<MarketplaceSourcePluginInstallResult>;
  /** Host cache updates, including mutations made through legacy entry points. */
  subscribeSnapshot?(
    listener: (snapshot: MarketplaceSourcesSnapshot) => void,
  ): () => void;
  subscribeProgress?(
    listener: (progress: MarketplaceSourceProgress) => void,
  ): () => void;
}
