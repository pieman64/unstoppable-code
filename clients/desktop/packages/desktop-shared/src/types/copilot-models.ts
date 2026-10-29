import type { ThinkingLevel } from '@canopy/protocol/thinking';

/** Account-scoped metadata advertised by the official Copilot runtime. */
export interface CopilotModelEntry {
  id: string;
  rawModelId: string;
  label: string;
  contextWindow?: number;
  supportsVision: boolean;
  supportedThinkingLevels: ThinkingLevel[];
}
