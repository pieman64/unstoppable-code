import { brandText } from '@/lib/brand';
import type { ShareGateContext } from '@/hooks/useShareAccess';

const SIGN_IN_TITLE = 'Sign in to share';

function buildContext(thing: string): ShareGateContext {
  return {
    title: SIGN_IN_TITLE,
    description: `Sign in to your ${brandText.appName} Cloud account to share this ${thing} with your team.`,
  };
}

/** Personalized Cloud sign-in prompt copy for each share-out surface. */
export const SHARE_PLAN_GATE_CONTEXT = buildContext('plan');
export const SHARE_PIPELINE_GATE_CONTEXT = buildContext('pipeline');
export const SHARE_SKILL_GATE_CONTEXT = buildContext('skill');
export const SHARE_COLLECTION_GATE_CONTEXT = buildContext('collection');

/**
 * Plugins share a public reference, so their prompt names the link rather
 * than a team.
 */
export const SHARE_PLUGIN_GATE_CONTEXT: ShareGateContext = {
  title: 'Sign in to share plugins',
  description: 'Connect your account to create a public plugin link.',
};
