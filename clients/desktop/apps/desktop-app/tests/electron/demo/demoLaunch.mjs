/**
 * Launch settings shared by `*.demo-spec.ts` demo videos.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PROMPT_SCENARIO_KEY_PREFIX } from '../mock-server/routes/llm.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
} from '../seeders/registerScenario.mjs';

/**
 * Demo window size in CSS pixels. 16:10 at a size that reads well when the
 * video is embedded or played back at half size.
 */
export const DEMO_VIEWPORT = Object.freeze({ width: 1280, height: 800 });

/**
 * Seed preferences that keep host identity out of a demo: branch names must
 * not pick up the host's GitHub username as a prefix. Merges into any
 * preferences.json the spec already wrote; call before `launchCanopy`.
 *
 * @param {string} userDataDir
 */
export function seedDemoPreferences(userDataDir) {
  const preferencesPath = path.join(userDataDir, 'preferences.json');
  const persisted = existsSync(preferencesPath)
    ? JSON.parse(readFileSync(preferencesPath, 'utf8'))
    : { version: 1, preferences: {} };
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    preferencesPath,
    `${JSON.stringify(
      {
        ...persisted,
        preferences: {
          ...persisted.preferences,
          branchNamePrefixMode: 'custom',
          branchNameCustomPrefix: '',
        },
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * Script the mock provider's reply to `prompt` without a visible marker. The
 * LLM mock tries each user-message line as a `prompt:<line>` key, so the chat
 * turn and the helper requests it triggers (branch naming, chat titles) all
 * resolve to this scenario; set `helperStepsById` to script those helpers.
 * Type the prompt exactly as registered, on one line.
 *
 * @param {string} prompt
 * @param {object} llm the scenario's `llm` slice (`steps`, `helperStepsById`)
 * @param {string} [baseUrl]
 */
export function registerDemoReply(
  prompt,
  llm,
  baseUrl = DEFAULT_MOCK_BASE_URL,
) {
  if (prompt.includes('\n')) {
    throw new Error('registerDemoReply prompts must be a single line');
  }
  return registerScenario(baseUrl, `${PROMPT_SCENARIO_KEY_PREFIX}${prompt}`, {
    llm,
  });
}
