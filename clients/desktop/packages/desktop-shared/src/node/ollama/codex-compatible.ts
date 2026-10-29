import type { CodexConfig } from '../../lib/codex-model-config';

/**
 * Codex reserves `ollama` for its built-in provider and fails config load when
 * `model_providers` redefines a built-in ID, so this must stay distinct.
 */
export const OLLAMA_CODEX_PROVIDER_ID = 'canopy_ollama';

/** Thread-scoped Codex configuration for Ollama's Responses-compatible API. */
export function buildCodexCompatibleOllamaConfig(
  port: number,
  rawModelId: string,
): CodexConfig {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Ollama port must be an integer between 1 and 65535.');
  }
  const model = rawModelId.trim();
  if (!model) throw new Error('Invalid Ollama model ID');
  return {
    model_provider: OLLAMA_CODEX_PROVIDER_ID,
    model,
    model_providers: {
      [OLLAMA_CODEX_PROVIDER_ID]: {
        name: 'Ollama',
        base_url: `http://127.0.0.1:${String(port)}/v1`,
        wire_api: 'responses',
        requires_openai_auth: false,
      },
    },
  };
}
