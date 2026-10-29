import {
  startClientOperation,
  succeedClientOperation,
} from '@canopy/desktop-instrumentation/client';
import type { SuggestedPrompt } from './mcpPromptIndex';

export type SuggestedPromptSurface = 'home' | 'chat' | 'cowork';

const OPERATION_NAME = 'canopy.suggested_prompt';

/**
 * Context is intentionally bounded/low-cardinality: curated catalog keys and
 * stable prompt ids only. Prompt text must never be recorded.
 */
function emit(
  context: Record<string, string | number | boolean | null | undefined>,
): void {
  startClientOperation(OPERATION_NAME, { context });
  succeedClientOperation(OPERATION_NAME, { context });
}

/** Records one impression for a freshly displayed suggestion set. */
export function trackSuggestedPromptImpression(
  surface: SuggestedPromptSurface,
  prompts: readonly SuggestedPrompt[],
): void {
  if (prompts.length === 0) return;
  emit({
    surface,
    action: 'impression',
    suggestion_count: prompts.length,
    suggestion_ids: prompts.map((prompt) => prompt.id).join(','),
    mcp_keys: prompts.map((prompt) => prompt.curatedKey ?? 'generic').join(','),
  });
}

/** Records a chip click. */
export function trackSuggestedPromptSelection(
  surface: SuggestedPromptSurface,
  prompt: SuggestedPrompt,
  index: number,
): void {
  emit({
    surface,
    action: 'selection',
    mcp_key: prompt.curatedKey ?? 'generic',
    suggestion_id: prompt.id,
    suggestion_index: index,
  });
}
