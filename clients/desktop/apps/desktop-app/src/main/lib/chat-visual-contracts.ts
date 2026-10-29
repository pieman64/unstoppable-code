import type { PersistedVisualReference } from '@canopy/agent-transcript/types';

/** Tool key a staged visual must have been produced by. */
export const SHOW_VISUAL_TOOL_KEY = 'show_visual';

/** Staged entries older than this are removed by the sweep. */
export const VISUAL_STAGING_RETENTION_MS = 24 * 60 * 60 * 1000;

/** How often the staging sweep runs after its first pass. */
export const VISUAL_STAGING_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Trusted identity a document is staged for: never taken from tool arguments. */
export interface VisualStagingTarget {
  chatId: string;
}

/** A prepared document handed to the staging port. */
export interface StageVisualDocument {
  /** `vis_` followed by a lowercase UUID; see `isVisualId`. */
  visualId: string;
  /** Prepared HTML, well-formed UTF-8, at most `VISUAL_PREPARED_MAX_BYTES`. */
  html: string;
  title: string;
  maxHeight: number;
  heights?: ReadonlyArray<readonly [number, number]>;
  /** Native Codex call id, when the tool ran in a Codex session. */
  codexCallId?: string;
}

/** Immutable metadata written next to a staged document. */
export interface VisualStagingSidecar {
  version: 1;
  visualId: string;
  chatId: string;
  toolKey: typeof SHOW_VISUAL_TOOL_KEY;
  /** Milliseconds since the epoch. */
  createdAt: number;
  sha256: string;
  byteLength: number;
  title: string;
  maxHeight: number;
  heights?: ReadonlyArray<readonly [number, number]>;
  codexCallId?: string;
}

/** A staged document read back for promotion. */
export interface StagedVisual {
  sidecar: VisualStagingSidecar;
  /** Exactly the staged bytes, already checked against the sidecar digest. */
  html: string;
}

/**
 * Fence recording which block first claimed a visual. It carries no
 * reference: the owning row does, and the fence only has to outlive the
 * staging entry that could otherwise be claimed twice.
 */
export interface VisualOwnerFence {
  messageId: string;
  toolUseId: string;
  codexCallId?: string;
  /** Milliseconds since the epoch. */
  claimedAt: number;
}

/** The linked tool call of a `tool_result`, as seen at promotion time. */
export interface LinkedToolCall {
  toolUseId: string;
  /** Provider-accurate tool name of the linked `tool_use`, when known. */
  toolName?: string;
  /** Native Codex call id of the linked call, when known. */
  codexCallId?: string;
}

/**
 * Positively identifies the staging tool. Returns the tool key only for a
 * call it can prove came from that tool; anything unknown or ambiguous
 * returns undefined, so promotion fails closed.
 */
export type VisualToolIdentityResolver = (
  call: LinkedToolCall,
) => typeof SHOW_VISUAL_TOOL_KEY | undefined;

/**
 * Capabilities `externalize` receives on the trusted provider path only.
 * Every other caller passes nothing and verifies existing references.
 */
export interface ExternalizeVisualContext {
  kind: 'provider';
  /** The chat being externalized; must equal the chat argument. */
  chatId: string;
  /** Cheap check: false means skip the token scan entirely. */
  hasStagedEntries(): boolean;
  /** Linked tool call for a result's `toolUseId`, when one is known. */
  linkedToolCall(toolUseId: string): LinkedToolCall | undefined;
  resolveToolKey: VisualToolIdentityResolver;
  /** Current owner of a visual id, including claims earlier in this transaction. */
  ownerOf(visualId: string): VisualOwnerFence | undefined;
  /**
   * Reserves a visual for a block in this transaction. Returns false when a
   * different block already owns it.
   */
  reserve(visualId: string, owner: VisualOwnerFence): boolean;
  /** Non-destructive read of a staged document for this chat. */
  readStaged(visualId: string): Promise<StagedVisual | undefined>;
  /** Milliseconds since the epoch, for `claimedAt`. */
  now(): number;
}

/** Result of promoting one block, reported back to the repository. */
export interface PromotedVisual {
  chatId: string;
  visualId: string;
  reference: PersistedVisualReference;
}

/**
 * Per-scope staging store. One instance per loaded scope, owned by the
 * repository and used under the scope lease.
 */
export interface VisualStagingStore {
  /** Enumerates the staging directory once; must run before `hasEntries`. */
  initialize(now: number): Promise<void>;
  hasEntries(): boolean;
  /** Ids currently staged, for fence pruning. */
  stagedIds(): ReadonlySet<string>;
  /** Atomically writes the document and its sidecar; idempotent for identical bytes. */
  stage(
    target: VisualStagingTarget,
    document: StageVisualDocument,
    now: number,
  ): Promise<VisualStagingSidecar>;
  readCandidate(
    chatId: string,
    visualId: string,
  ): Promise<StagedVisual | undefined>;
  /** Removes one entry; missing entries are not an error. */
  remove(visualId: string): Promise<void>;
  /** Removes every entry staged for a chat. */
  removeChat(chatId: string): Promise<void>;
  /** Removes entries and orphans older than the retention window. */
  sweep(now: number): Promise<{ removed: number; remaining: number }>;
}

/**
 * What the repository hands the backend for one trusted provider
 * transaction. Its presence is the only thing that enables fresh claims.
 */
export interface ProviderVisualAdmission {
  staging: VisualStagingStore;
  resolveToolKey: VisualToolIdentityResolver;
  now(): number;
}

/** Repository methods the chat state service uses for visuals. */
export interface VisualRepositoryPort<Scope, Build, Options, Commit> {
  /** Writes a staged document for a chat in the scope, under the scope lease. */
  stageVisual(
    scope: Scope,
    target: VisualStagingTarget,
    document: StageVisualDocument,
  ): Promise<VisualStagingSidecar>;
  /**
   * Same as `transactWith`, for a native provider result, with fresh visual
   * claims enabled through `resolveToolKey`.
   */
  transactProviderEventWith(
    scope: Scope,
    build: Build,
    options: Options,
    admission: { resolveToolKey: VisualToolIdentityResolver },
  ): Promise<Commit>;
}
