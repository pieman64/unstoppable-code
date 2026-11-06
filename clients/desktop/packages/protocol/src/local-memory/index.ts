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
 * A consolidation or rebuild refused for a synced replica: its documents
 * change only through cloud commits (cloud memory sync, CAN-5185).
 */
export const LOCAL_MEMORY_SYNCED_CONSOLIDATION_MESSAGE =
  "Synced memory isn't consolidated on this device yet.";

/** A snapshot restore refused for a synced replica. */
export const LOCAL_MEMORY_SYNCED_RESTORE_MESSAGE =
  "Synced memory can't be restored from a snapshot on this device yet.";

/** Reasons that are complete sentences, shown without a prefix. */
export const LOCAL_MEMORY_FULL_SENTENCE_REASONS: ReadonlySet<string> = new Set([
  LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE,
  LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE,
  LOCAL_MEMORY_SYNCED_CONSOLIDATION_MESSAGE,
  LOCAL_MEMORY_SYNCED_RESTORE_MESSAGE,
]);
