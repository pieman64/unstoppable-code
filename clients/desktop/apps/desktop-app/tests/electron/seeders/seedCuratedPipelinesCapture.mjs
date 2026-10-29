import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startCuratedPipelinesCloud } from '../fixtures/curatedPipelinesCloud.mjs';

/**
 * Seed the deterministic local Cloud scenario used by curated-pipeline captures.
 * Owns the isolated profile, fixture lifecycle, launch environment, and test
 * credential so capture specs do not reproduce setup details inline.
 */
export async function seedCuratedPipelinesCapture({ reviewName }) {
  const cloud = await startCuratedPipelinesCloud({ reviewName });
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'curated-capture-'));
  const apiKey = 'csk_curated_capture';

  return {
    userDataDir,
    launchEnv: { CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl },
    async connectCloud(window) {
      await window.evaluate(
        async (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
        apiKey,
      );
    },
    async close() {
      await cloud.close();
    },
  };
}
