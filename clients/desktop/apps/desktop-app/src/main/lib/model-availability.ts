import {
  isOllamaModel,
  resolveKnownModel,
  type ChatModel,
} from '@canopy/desktop-shared/types';

/**
 * The canonical id of a model this install can run right now: registered in
 * the current model catalog, and not an Ollama model in a build without
 * Ollama. Null for anything else, including a model whose provider is not
 * running yet.
 */
export function resolveAvailableModel(model: unknown): ChatModel | null {
  if (typeof model !== 'string') return null;
  const resolved = resolveKnownModel(model);
  if (!resolved) return null;
  if (isOllamaModel(resolved) && !__CANOPY_OLLAMA_ENABLED__) return null;
  return resolved;
}
