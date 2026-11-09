import { getRawCopilotModelId } from '@canopy/execution-engine/lib/copilot-models';
import { getCursorModelVendor } from '@canopy/execution-engine/lib/cursor-models';
import { getRawOpenCodeModelId } from '@canopy/execution-engine/lib/opencode-models';

/** Display classification from model namespaces, never labels or account names. */
export function getManagedModelVendor(model: string): string | undefined {
  const cursor = getCursorModelVendor(model);
  if (cursor) return cursor;
  const openCode = getRawOpenCodeModelId(model);
  const raw =
    getRawCopilotModelId(model) ??
    (openCode ? openCode.slice(openCode.indexOf('/') + 1) : undefined);
  if (!raw) return undefined;
  const slug = raw.replace(/^(anthropic|openai|google)\//, '');
  const namespaces: readonly [string, string][] = [
    ['claude-', 'anthropic'],
    ['gpt-', 'openai'],
    ['gemini-', 'google'],
    ['kimi-', 'moonshot'],
    ['grok-', 'xai'],
    ['deepseek-', 'deepseek'],
    ['composer-', 'cursor'],
    ['glm-', 'zai'],
    ['minimax-', 'minimax'],
  ];
  return namespaces.find(([prefix]) => slug.startsWith(prefix))?.[1];
}
