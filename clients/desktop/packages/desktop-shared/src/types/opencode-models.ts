import type { ThinkingLevel } from '@canopy/protocol/thinking';

/** Exact provider/model identities advertised by the managed OpenCode runtime. */
export interface OpenCodeModelEntry {
  id: string;
  rawModelId: string;
  label: string;
  contextWindow?: number;
  supportsVision: boolean;
  supportedThinkingLevels: ThinkingLevel[];
}
