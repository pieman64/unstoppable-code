import type { ThinkingLevel } from '@canopy/protocol/thinking';

/** One account model advertised by the managed Cursor CLI over ACP. */
export interface CursorModelEntry {
  id: string;
  rawModelId: string;
  label: string;
  /**
   * Thinking levels the model's `thought_level` options can express, in
   * ascending order, projected from the runtime's per-model listing. Exact:
   * an empty list means the model exposes no thinking control. Absent when
   * the runtime did not answer the listing, which callers treat the same way.
   */
  supportedThinkingLevels?: ThinkingLevel[];
  /** Cursor's catalog name in Canopy style, for options labelled by slug. */
  catalogName?: string;
}
