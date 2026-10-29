// ---------------------------------------------------------------------------
// Shared types for the per-row model catalog projection
// (`lib/model-catalog-projection.ts`, CAN-1218 / CAN-2540). Browser-safe:
// protocol imports only.
// ---------------------------------------------------------------------------

import type { ModelCatalogProvider } from '@canopy/protocol/models';

/** Caller-supplied context for `buildModelCatalogOption`. */
export interface BuildModelCatalogOptionInput {
  /**
   * The provider the caller's registry section resolved for this row. Used as
   * the grouping fallback when the registry has no more specific
   * source/harness answer; Agent rows resolve their base-model provider
   * themselves.
   */
  readonly provider: Exclude<ModelCatalogProvider, 'unknown'>;
  /**
   * Host default-model id to stamp `isDefault` on, for hosts (the portal
   * projection) that surface the no-override default. Presentation only.
   */
  readonly defaultModel?: string;
  /**
   * The model an Agent on the default model would pin to in this catalog's
   * destination, so its row describes that route. Absent, the row describes
   * the Agent alone.
   */
  readonly agentDefaultModel?: string;
}
