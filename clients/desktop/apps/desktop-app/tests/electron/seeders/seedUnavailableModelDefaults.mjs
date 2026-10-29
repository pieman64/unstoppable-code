import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_MOCK_BASE_URL } from './index.mjs';

export function seedModelDefaultsGatewayCatalog(userDataDir) {
  const cacheDir = path.join(userDataDir, '.cache', 'model-catalog');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    path.join(cacheDir, 'ai-gateway-v1.json'),
    JSON.stringify({
      cacheVersion: 8,
      serverOrigin:
        process.env.CANOPY_E2E_CLOUD_BASE_URL ?? DEFAULT_MOCK_BASE_URL,
      brandApiNamespace: 'desktop-app',
      fetchedAt: new Date().toISOString(),
      catalog: {
        version: 8,
        models: [
          {
            id: 'e2e-available-gateway-model',
            gatewayId: 'qa/e2e-available-gateway-model',
            label: 'Available gateway model',
            family: 'openai',
            familyLabel: 'OpenAI',
            recommendedHarness: 'codex',
            contextWindow: 128000,
            supportsPromptCaching: false,
            requiresLocalHarnessSupport: false,
            showMoreOnly: false,
            supportedThinkingLevels: ['medium', 'high'],
            toolSchemaProfile: 'standard',
          },
        ],
      },
    }),
  );
}
