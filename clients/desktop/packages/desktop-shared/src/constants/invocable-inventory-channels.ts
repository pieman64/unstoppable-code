/**
 * IPC channel names for the invocable inventory (Fast Slash Menu) subsystem.
 *
 * Channel strings are part of the wire contract between preload and main.
 * Renderer code must reference them via this constant rather than the literal
 * channel name to keep both ends in sync.
 */
export const INVOCABLE_INVENTORY_CHANNELS = {
  /** Read the cached inventory for a provider (validate-and-resolve excluded). */
  LOAD: 'invocable-inventory:load',
  /** Force a cache rebuild and resolve with the rebuilt response. */
  REFRESH: 'invocable-inventory:refresh',
  /** Validate-and-resolve a selected row into authoritative per-tab insert text. */
  RESOLVE: 'invocable-inventory:resolve',
  /** Pushed when the inventory changes (rebuild completes / inventory mutated). */
  CHANGED: 'invocable-inventory:changed',
} as const;

export type InvocableInventoryChannel =
  (typeof INVOCABLE_INVENTORY_CHANNELS)[keyof typeof INVOCABLE_INVENTORY_CHANNELS];
