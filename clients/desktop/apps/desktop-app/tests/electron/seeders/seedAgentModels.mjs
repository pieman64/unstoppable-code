import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';

/**
 * Seed the main-process Agent model store for an isolated Electron test data
 * directory. The shape mirrors `AgentModelStoreData`.
 *
 * @param {string} userDataDir absolute test data directory
 * @param {unknown[]} agents Agent model definitions to persist
 */
export function seedAgentModels(userDataDir, agents) {
  writeJson(path.join(userDataDir, 'agent-models.json'), {
    version: 1,
    agents,
  });
}
