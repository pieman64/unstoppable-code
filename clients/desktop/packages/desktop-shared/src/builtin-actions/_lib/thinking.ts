import {
  isThinkingLevel,
  THINKING_LEVELS,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';

const THINKING_LEVEL_INPUT_VALUES = THINKING_LEVELS.join(', ');

interface ParseThinkingLevelInputOptions {
  field: string;
  fallback?: ThinkingLevel;
}

export function parseThinkingLevelInput(
  raw: string | undefined,
  options: ParseThinkingLevelInputOptions,
): ThinkingLevel | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return options.fallback;
  }

  if (!isThinkingLevel(trimmed)) {
    throw new Error(
      `${options.field} must be one of: ${THINKING_LEVEL_INPUT_VALUES}`,
    );
  }

  return trimmed;
}
