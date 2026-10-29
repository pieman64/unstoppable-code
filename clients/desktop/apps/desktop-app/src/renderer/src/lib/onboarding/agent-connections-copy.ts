import { brandText } from '@/lib/brand';

/**
 * The sentence that introduces Claude and Codex on Home's "Add your AI
 * providers" step and the first-run "Let's get started" page. It promises no
 * AI Credits: those are opt-in and asked for only where the user can turn
 * them on. A function so the brand name is read when rendered.
 */
export function agentConnectionsIntro(): string {
  return `Bring your own subscription or use your ${brandText.appName} account.`;
}
