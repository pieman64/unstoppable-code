/**
 * Stored verbatim as `lastReason` when consolidation refuses an
 * organization-blocked model; the Memory panel shows it unchanged.
 */
export const LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE =
  'Memory consolidation was skipped: this model is blocked by your organization policy.';

/**
 * Stored verbatim as `lastReason` (and returned as a rebuild reason) when a
 * memory run refuses the memory model the user chose because this install
 * cannot run it right now. Memory is never sent to another model instead.
 */
export const LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE =
  "Memory consolidation was skipped: your memory model isn't available. Choose another memory model in settings, or try again once it's available.";

/**
 * A rebuild refused for a synced replica: its archived notes are already
 * consolidated in the cloud (cloud memory sync, CAN-5186).
 */
export const LOCAL_MEMORY_SYNCED_REBUILD_MESSAGE =
  "Synced memory can't be rebuilt on this device yet.";

/**
 * A synced replica's consolidation stopped before its commit: what it would
 * send holds a secret, kept from a local edit the cloud never received.
 */
export const LOCAL_MEMORY_SYNCED_SECRET_MESSAGE =
  "Synced memory wasn't consolidated because a memory file holds what looks like a secret. Remove the secret, then try again.";

/** A synced replica's consolidation commit the cloud refused as it is. */
export const LOCAL_MEMORY_SYNCED_REFUSED_MESSAGE =
  "Synced memory wasn't consolidated because the cloud didn't accept the changes.";

/** Reasons that are complete sentences, shown without a prefix. */
export const LOCAL_MEMORY_FULL_SENTENCE_REASONS: ReadonlySet<string> = new Set([
  LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE,
  LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE,
  LOCAL_MEMORY_SYNCED_REBUILD_MESSAGE,
  LOCAL_MEMORY_SYNCED_REFUSED_MESSAGE,
  LOCAL_MEMORY_SYNCED_SECRET_MESSAGE,
]);
