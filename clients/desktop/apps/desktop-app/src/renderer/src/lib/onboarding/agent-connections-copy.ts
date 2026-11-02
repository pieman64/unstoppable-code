import { brandText } from '@/lib/brand';

/** Intro sentence on the first-run page while it offers the daily AI Credits. */
export const AGENT_CONNECTIONS_CREDITS_INTRO =
  'Use free AI Credits, or connect a subscription you already have.';

/**
 * The sentence that introduces Claude and Codex on Home's "Add your AI
 * providers" step and the first-run "Let's get started" page. By default it
 * promises no AI Credits: those are opt-in and asked for only where the user
 * can turn them on. Pass `offersCredits` only where the same section shows the
 * opt-in (the first-run account row). A function so the brand name is read
 * when rendered.
 */
export function agentConnectionsIntro({
  offersCredits = false,
}: { readonly offersCredits?: boolean } = {}): string {
  if (offersCredits) return AGENT_CONNECTIONS_CREDITS_INTRO;
  return `Bring your own subscription or use your ${brandText.appName} account.`;
}
