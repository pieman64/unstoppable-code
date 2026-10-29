import {
  THINKING_LEVEL_LABELS,
  THINKING_UI_LEVELS,
  type ThinkingUiLevel,
} from '@canopy/protocol/thinking';

export {
  THINKING_LEVEL_LABELS,
  THINKING_LEVELS,
  THINKING_UI_LEVELS,
  advanceThinkingLevel,
  clampThinkingLevel,
  encodeThinkingSetting,
  isThinkingSetting,
  isThinkingLevel,
  normalizePersistedThinkingLevel,
  normalizeThinkingForUi,
  providerFallbackThinkingLevels,
  thinkingDotCount,
} from '@canopy/protocol/thinking';
export type {
  ThinkingLevel,
  ThinkingSetting,
  ThinkingUiLevel,
  ThinkingUpdate,
} from '@canopy/protocol/thinking';

export const THINKING_UI_OPTIONS: {
  value: ThinkingUiLevel;
  label: string;
}[] = THINKING_UI_LEVELS.map((value) => ({
  value,
  label: THINKING_LEVEL_LABELS[value],
}));
