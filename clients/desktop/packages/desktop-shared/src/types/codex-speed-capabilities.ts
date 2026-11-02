/**
 * Browser-safe Codex speed capability projection (`window.api.codexSpeed`).
 *
 * Portable DTO only: it never carries account identifiers, auth material,
 * host paths, or other secrets. The host scopes discovery to the active
 * runtime/account/route and publishes this sanitized projection. Advertised
 * tiers are an availability hint, not an entitlement guarantee; normal turn
 * execution remains the final server-side check.
 */

import type { CodexSpeedRouteFacts } from '../lib/codex-speed-availability';

/** Where a model's advertised tier IDs came from. */
export type CodexSpeedTierSource =
  | 'serviceTiers'
  | 'additionalSpeedTiers'
  | 'unknown';

export interface CodexSpeedCatalogModel {
  /** Catalog entry id as reported by the runtime. */
  id: string;
  /** Model slug the entry applies to. */
  model: string;
  /**
   * Advertised service-tier IDs (for example `priority`, `ultrafast`).
   * `null` means the runtime did not report tiers for this model (unknown),
   * which is distinct from an empty authoritative list.
   */
  tiers: string[] | null;
  source: CodexSpeedTierSource;
  /** The runtime's display name for the model, when it reported one. */
  displayName?: string;
  /**
   * The runtime lists the model only for `includeHidden` reads. Hidden models
   * are never registered or chosen as a default (CAN-4716).
   */
  hidden?: boolean;
  /** The runtime marks this model as the account's own default. */
  isDefault?: boolean;
  /** Reasoning efforts the model supports, in the runtime's own ids. */
  reasoningEfforts?: string[];
}

/** A temporary, expiring denial learned from a definitive tier rejection. */
export interface CodexSpeedCatalogDenial {
  model: string;
  /** Epoch milliseconds after which the denial no longer applies. */
  expiresAt: number;
  /** Set when an account proxy account refused the tier; absent for native. */
  route?: 'account-proxy';
}

/**
 * The model list of one non-native route the runtime catalog cannot speak
 * for, such as the account proxy's own Codex catalog. Same freshness and
 * tier semantics as {@link CodexSpeedCatalog}; denials stay on the parent.
 */
export interface CodexSpeedRouteCatalog {
  /**
   * Bumped by every change to the list, including a failed revalidation that
   * clears it, so mirrors can order snapshots even when `fetchedAt` goes back
   * to null.
   */
  revision: number;
  status: 'ready' | 'unknown';
  fetchedAt: number | null;
  expiresAt: number | null;
  truncated: boolean;
  models: CodexSpeedCatalogModel[];
  error?: string;
}

/** Routes with their own model list next to the runtime catalog. */
export type CodexSpeedCatalogRoute = 'account-proxy';

export interface CodexSpeedCatalog {
  /** Monotonic account/runtime generation; stale generations are discarded. */
  generation: number;
  status: 'ready' | 'unknown';
  /** Epoch milliseconds of the last successful fetch, or null. */
  fetchedAt: number | null;
  /** Epoch milliseconds when the projection should be revalidated, or null. */
  expiresAt: number | null;
  /** True when pagination was cut short and the model list is incomplete. */
  truncated: boolean;
  models: CodexSpeedCatalogModel[];
  denials: CodexSpeedCatalogDenial[];
  /** Sanitized, user-safe failure summary. Never raw provider output. */
  error?: string;
  /**
   * Route catalogs a surface or admission asked for. Absent means the route's
   * list was never read, which leaves Ultra fast unconfirmed on that route.
   */
  routes?: Partial<Record<CodexSpeedCatalogRoute, CodexSpeedRouteCatalog>>;
}

export interface CodexSpeedReadCapabilitiesOptions {
  /** Bypass a fresh cache and revalidate now (still deduplicated). */
  force?: boolean;
  /** Also read this route's own model list. */
  route?: CodexSpeedCatalogRoute;
}

export interface CodexSpeedSetActiveRequest {
  /** Stable id of a mounted speed-selection surface. */
  consumerId: string;
  /** Whether that surface currently needs cache-expiry refreshes. */
  active: boolean;
}

/** Portable context whose execution route is resolved by the host. */
export type CodexSpeedRouteContext =
  | { kind: 'chat'; projectId: string; worktreeId: string; chatId: string }
  | {
      kind: 'home';
      projectId?: string;
      /** Prospective draft selection, resolved against host policy. */
      billingFramework?: 'subscription' | 'ai-credits';
      executionHarness?: 'claude' | 'codex' | 'cursor';
    }
  | { kind: 'defaults' };

export interface ReadCodexSpeedRouteRequest {
  context: CodexSpeedRouteContext;
  /** Candidate local model; omitted chat models use canonical tab state. */
  model?: string | null;
  modelSelection?: 'explicit' | 'auto';
}

/** Preload surface: `window.api.codexSpeed`. */
export interface CodexSpeedApi {
  /** Resolve a sanitized route hint for this context without running a turn. */
  readRoute: (
    request: ReadCodexSpeedRouteRequest,
  ) => Promise<CodexSpeedRouteFacts>;
  readCapabilities: (
    options?: CodexSpeedReadCapabilitiesOptions,
  ) => Promise<CodexSpeedCatalog>;
  setActive: (request: CodexSpeedSetActiveRequest) => Promise<void>;
  /** Subscribe to catalog changes. Returns a disposer. */
  onChanged: (callback: (catalog: CodexSpeedCatalog) => void) => () => void;
}
