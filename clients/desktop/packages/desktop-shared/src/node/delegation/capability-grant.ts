import { createHash } from 'node:crypto';
import {
  DELEGATION_CAPABILITY_ID_PATTERN,
  DELEGATION_CAPABILITY_LIMITS,
  type DelegationCapabilityKind,
  type DelegationCapabilitySkipReason,
  type DelegationCapabilitySource,
  type DelegationCapabilitySummary,
} from '@canopy/protocol/delegation';
import type {
  ResolvedAgentRouteSnapshot,
  ResolvedCapabilityOverlaySnapshot,
} from './types';

/**
 * A delegation's retained capability grant. References only: the plugin,
 * skill and MCP content lives in the private capability overlay artifact
 * named by `overlayHash`. Written only when a delegation has one.
 */
export interface DelegationCapabilityGrant {
  /** False when the spawn set inheritCapabilities: false. */
  readonly inherit: boolean;
  /** Explicitly assigned catalog IDs (deferred-tools catalog refs, `deferred:v1:<base64url>`), in request order. */
  readonly explicit: readonly string[];
  /** Spawn-time discovery grant; the live root setting is still checked per call. */
  readonly discovery: boolean;
  /** Catalog IDs appended by in-run loads, in load order. */
  readonly loaded: readonly string[];
  /** Items left out of the child's set, by catalog ID. */
  readonly skipped: readonly {
    readonly id: string;
    readonly reason: DelegationCapabilitySkipReason;
  }[];
  /** `capabilityProjectionHash` of the current overlay, or the empty hash. */
  readonly overlayHash: string;
  /** Portal-safe projection source for `AgentDelegationSnapshot.capabilities`. */
  readonly summary: DelegationCapabilitySummary;
}

export const DELEGATION_CAPABILITY_GRANT_LIMITS = Object.freeze({
  explicit: DELEGATION_CAPABILITY_LIMITS.explicit,
  loaded: 256,
  skipped: 256,
});

/** In-run capability extensions allowed per run generation. */
export const MAX_CAPABILITY_EXTENSIONS_PER_RUN = 3;

/** `overlayHash` of a grant whose child has no capability overlay. */
export const EMPTY_CAPABILITY_OVERLAY_HASH = createHash('sha256')
  .update('canopy-delegation-empty-capability-overlay-v3')
  .digest('hex');

export function isDelegationCapabilityId(value: unknown): value is string {
  return (
    typeof value === 'string' && DELEGATION_CAPABILITY_ID_PATTERN.test(value)
  );
}

/** A display name safe for the public summary: one line, at most 200 characters. */
export function delegationCapabilityDisplayName(value: string): string {
  const cleaned = value.replace(/[\0\r\n]+/g, ' ').trim() || 'Unnamed';
  const limit = DELEGATION_CAPABILITY_LIMITS.nameCharacters;
  return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, limit - 1)}…`;
}

export interface DelegationCapabilitySummaryInput {
  readonly inherit: boolean;
  readonly discovery: boolean;
  readonly items: readonly {
    readonly kind: DelegationCapabilityKind;
    readonly name: string;
    readonly source: DelegationCapabilitySource;
  }[];
  readonly skipped: readonly {
    readonly kind: DelegationCapabilityKind;
    readonly name: string;
    readonly reason: DelegationCapabilitySkipReason;
  }[];
}

/** Bounded, names-only summary. Order is preserved; overflow is counted. */
export function summarizeDelegationCapabilities(
  input: DelegationCapabilitySummaryInput,
): DelegationCapabilitySummary {
  const itemLimit = DELEGATION_CAPABILITY_LIMITS.summaryItems;
  const skippedLimit = DELEGATION_CAPABILITY_LIMITS.summarySkipped;
  const items = input.items.slice(0, itemLimit).map((item) =>
    Object.freeze({
      kind: item.kind,
      name: delegationCapabilityDisplayName(item.name),
      source: item.source,
    }),
  );
  const skipped = input.skipped.slice(0, skippedLimit).map((item) =>
    Object.freeze({
      kind: item.kind,
      name: delegationCapabilityDisplayName(item.name),
      reason: item.reason,
    }),
  );
  const omittedItems = input.items.length - items.length;
  const omittedSkipped = input.skipped.length - skipped.length;
  return Object.freeze({
    inherit: input.inherit,
    discovery: input.discovery,
    items: Object.freeze(items),
    skipped: Object.freeze(skipped),
    ...(omittedItems > 0 ? { omittedItems } : {}),
    ...(omittedSkipped > 0 ? { omittedSkipped } : {}),
  });
}

/**
 * Spawn-time discovery grant (decision A-1). A top-level child is bounded by
 * the root chat's deferred-tools setting; a nested child never exceeds its
 * direct parent delegate's grant, and a parent without a grant has none.
 */
export function resolveDelegationCapabilityDiscovery(input: {
  /** 0 for a root chat caller; otherwise the caller is a delegate. */
  readonly callerDepth: number;
  readonly rootDeferredToolsAllowed: boolean | undefined;
  readonly parentGrant:
    | Pick<DelegationCapabilityGrant, 'discovery'>
    | undefined;
  readonly requested: boolean | undefined;
}): boolean {
  if (input.callerDepth === 0)
    return input.rootDeferredToolsAllowed === true && (input.requested ?? true);
  const ceiling = input.parentGrant?.discovery === true;
  return ceiling && (input.requested ?? ceiling);
}

/** Atomic mid-run grant extension (capabilities 03, swarm cleanup 01 §2.4). */
export interface DelegationCapabilityExtensionRequest {
  readonly delegationId: string;
  /** The caller's run generation; must be the delegation's current running one. */
  readonly runGeneration: number;
  /** Catalog IDs to append to `loaded`; duplicates of existing entries are ignored. */
  readonly loaded: readonly string[];
  /** Replaces the route's capability overlay; undefined removes it. */
  readonly capabilityOverlay: ResolvedCapabilityOverlaySnapshot | undefined;
  /** Must equal `capabilityOverlay.capabilityProjectionHash`, or the empty hash. */
  readonly overlayHash: string;
  /** Replaces the grant's public summary. */
  readonly summary: DelegationCapabilitySummary;
}

export type DelegationCapabilityExtensionRefusal =
  | 'unknown_delegation'
  | 'no_grant'
  | 'not_running'
  | 'generation_mismatch'
  | 'reload_limit'
  | 'invalid_request'
  | 'write_failed';

export type DelegationCapabilityExtensionResult =
  | {
      readonly ok: true;
      readonly grant: DelegationCapabilityGrant;
      readonly route: ResolvedAgentRouteSnapshot;
      /** Extensions recorded in this run generation, including this one. */
      readonly extensions: number;
    }
  | {
      readonly ok: false;
      readonly reason: DelegationCapabilityExtensionRefusal;
    };

/** Host-only view of a delegation's capabilities, for nested inheritance. */
export interface DelegationCapabilityContext {
  readonly delegationId: string;
  readonly runGeneration: number;
  readonly grant?: DelegationCapabilityGrant;
  readonly route?: ResolvedAgentRouteSnapshot;
}
