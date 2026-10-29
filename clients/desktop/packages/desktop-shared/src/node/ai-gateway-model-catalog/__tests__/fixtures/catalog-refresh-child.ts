import { AI_GATEWAY_MODEL_CATALOG_VERSION } from '@canopy/protocol/ai-gateway-models';
import { refreshAiGatewayModelCatalog } from '../../client';

const cacheFilePath = process.argv[2];
const holdLock = process.argv[3] === 'hold';
if (!cacheFilePath) throw new Error('cache file path is required');

async function main(): Promise<void> {
  const result = await refreshAiGatewayModelCatalog({
    cacheFilePath,
    serverOrigin: 'https://cloud.example.com',
    brandApiNamespace: 'canopy',
    fetchFn: async () => {
      if (holdLock) {
        await new Promise<void>((resolve) => {
          process.once('message', () => resolve());
          process.send?.('lock-held');
        });
      }
      return new Response(
        JSON.stringify({
          // Track the constant rather than a literal: the client rejects any
          // catalog whose version is not current, so a stale literal here
          // would fail as a confusing refresh error rather than a version bump.
          version: AI_GATEWAY_MODEL_CATALOG_VERSION,
          models: [
            {
              id: 'cross-process-model',
              gatewayId: 'qa/cross-process-model',
              label: 'Cross-process model',
              family: 'openai',
              familyLabel: 'OpenAI',
              recommendedHarness: 'codex',
              contextWindow: 100_000,
              supportsPromptCaching: false,
              requiresLocalHarnessSupport: false,
              showMoreOnly: false,
              supportedThinkingLevels: [],
              toolSchemaProfile: 'standard',
            },
          ],
        }),
        { status: 200 },
      );
    },
  });

  process.stdout.write(`${JSON.stringify({ status: result.status })}\n`);
  process.disconnect?.();
}

void main();
