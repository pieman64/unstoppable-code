// Current follow-up policy; historical 16k guard arithmetic stays unchanged.
import { BROWSER_AGENT_EXPERIMENT_LIMITS } from '@canopy/protocol/delegation/browser-agent';
export const CONTEXT_CHECKPOINT_TOKENS =
  BROWSER_AGENT_EXPERIMENT_LIMITS.tokenBudgets.contextCheckpoint;
export const SYNTHETIC_OAUTH_TOKEN = 'bap0-placeholder-oauth-not-a-credential';

/** Only classify synthetic auth; never retain headers, token substrings or lengths. */
export function classifySyntheticAuth(headers) {
  const bearer = headers.authorization;
  const apiKey = headers['x-api-key'];
  return {
    bearer: typeof bearer === 'string',
    apiKey: typeof apiKey === 'string',
    syntheticOAuth: bearer === `Bearer ${SYNTHETIC_OAUTH_TOKEN}`,
    syntheticApiKey: apiKey === 'bap0-placeholder-not-a-credential',
  };
}
