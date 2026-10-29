// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const CHAT_TAB_SOURCE = readFileSync(
  join(__dirname, '..', 'ChatTab.tsx'),
  'utf8',
);

describe('ChatTab', () => {
  it('does not render Global Instructions on the Models page', () => {
    expect(CHAT_TAB_SOURCE).not.toContain('GlobalInstructionsSettings');
    expect(CHAT_TAB_SOURCE).not.toContain('prefs.globalInstructions');
  });

  it('is labeled Models and includes cron generation model preferences', () => {
    expect(CHAT_TAB_SOURCE).toContain('title="Models"');
    expect(CHAT_TAB_SOURCE).toContain('dataTestId="settings-tab-chat"');
    expect(CHAT_TAB_SOURCE).toContain('Cron generation model');
    expect(CHAT_TAB_SOURCE).toContain('cronGenerationModel');
    expect(CHAT_TAB_SOURCE).toContain('cronGenerationThinkingLevel');
    expect(CHAT_TAB_SOURCE).toContain('includeOllama={false}');
  });

  it('uses clear default model labels for chat and code', () => {
    expect(CHAT_TAB_SOURCE).toContain('title="Default code model"');
    expect(CHAT_TAB_SOURCE).toContain('title="Default chat model"');
    expect(CHAT_TAB_SOURCE).not.toContain('Standalone ${CHAT_LABEL} model');
    expect(CHAT_TAB_SOURCE).not.toContain('`${WORKTREE_LABEL} model`');
  });

  it('includes a code review model picker row', () => {
    expect(CHAT_TAB_SOURCE).toContain('Code review');
    expect(CHAT_TAB_SOURCE).toContain('Review annotations and diagrams.');
    expect(CHAT_TAB_SOURCE).toContain('codeReviewModel');
    expect(CHAT_TAB_SOURCE).toContain('codeReviewThinkingLevel');
  });

  it('marks a chat description model selection as user-authored', () => {
    expect(CHAT_TAB_SOURCE).toContain('summaryModelSetByUser: true');
  });

  it('includes the automatic transient-error retry switches', () => {
    expect(CHAT_TAB_SOURCE).toContain('Retry transient errors');
    expect(CHAT_TAB_SOURCE).toContain(
      'dataTestId="settings-auto-retry-transient-chats"',
    );
    expect(CHAT_TAB_SOURCE).toContain(
      'dataTestId="settings-auto-retry-transient-pipelines"',
    );
    expect(CHAT_TAB_SOURCE).toContain('autoRetryTransientErrorsChats');
    expect(CHAT_TAB_SOURCE).toContain('autoRetryTransientErrorsPipelines');
  });

  it('gates the Ollama provider-defaults row behind the shared platform predicate', () => {
    // The Ollama row must be hidden entirely on unsupported desktop platforms,
    // so it sits behind the shared `isOllamaSupportedOnPlatform()` predicate
    // (which renderer, preload, and main all agree on) rather than only the
    // empty-catalog `disabled` guard.
    expect(CHAT_TAB_SOURCE).toContain('isOllamaSupportedOnPlatform() && (');
    expect(CHAT_TAB_SOURCE).toContain('provider="ollama"');
  });

  it('shows the last resolved billing lane per default scope', () => {
    // One shared value let a group display a lane resolved for the OTHER scope,
    // which can legitimately prefer a different provider.
    expect(CHAT_TAB_SOURCE).toContain('chat-defaults-resolved-lane');
    expect(CHAT_TAB_SOURCE).toContain(
      'lastResolvedDefaultLaneByScope?.worktree',
    );
    expect(CHAT_TAB_SOURCE).toContain('lastResolvedDefaultLaneByScope?.chat');
  });

  it('labels the resolved lane as HISTORICAL, not live (round-2 finding 13)', () => {
    // `lastResolvedDefaultLaneByScope` is written only by a non-provisional
    // main-process resolution, and this tab does not subscribe to background
    // preference writes — so "Currently resolved" claimed a freshness the value
    // does not have, and an unwritten value sat on "Checking…" forever.
    expect(CHAT_TAB_SOURCE).toContain('`Last resolved: ');
    expect(CHAT_TAB_SOURCE).toContain("'Last resolved: not recorded yet'");
    expect(CHAT_TAB_SOURCE).not.toContain('`Currently resolved: ');
  });

  it('does not empty the AI Credits model list on a cold gateway catalog (round-2 finding 11)', () => {
    // `isGatewayRoutableModel` is false for everything until the route catalog
    // hydrates, so filtering on it unconditionally rendered a DISABLED select
    // with a blank value on an offline launch — misrepresenting a saved AI
    // Credits default with no way to correct it.
    expect(CHAT_TAB_SOURCE).toContain('hasHydratedGatewayCatalog()');
    expect(CHAT_TAB_SOURCE).toContain(
      '(!routesHydrated || isGatewayRoutableModel(model))',
    );
    // A saved default is always representable, even once its route is gone.
    expect(CHAT_TAB_SOURCE).toContain(
      'selectedModel && !options.includes(selectedModel)',
    );
  });

  it('reads AI Credits eligibility from its own hook, not the Claude auth slot', () => {
    // `availability.claude.loading` is
    // `claudeAuthLoading || claudeProbeFailed || credits.loading`, so routing
    // the credits row through it made the row report "Checking…" whenever an
    // unrelated Claude auth probe was in flight.
    expect(CHAT_TAB_SOURCE).toContain('useAiCreditsAvailability');
    expect(CHAT_TAB_SOURCE).not.toContain(
      'availability.claude.creditsEligible',
    );
    expect(CHAT_TAB_SOURCE).not.toContain('availability.claude.loading');
    expect(CHAT_TAB_SOURCE).toContain('credits.inconclusive');
  });
});
