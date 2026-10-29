import type { ReactElement } from 'react';
import { renderToStaticMarkup as renderMarkup } from 'react-dom/server';
import type { TelemetryExpensiveRun } from '@canopy/protocol/telemetry';
import {
  TestSettingsHost,
  createTestSettingsHost,
} from '../../../__tests__/helpers/test-settings-host';
import { MostExpensiveRuns } from '../MostExpensiveRuns';

/** Render inside a settings host, as every host mounts shared settings UI. */
function renderToStaticMarkup(
  element: ReactElement,
  privacy?: { blockClassName: string; maskClassName: string },
): string {
  const { host } = createTestSettingsHost(privacy ? { privacy } : {});
  return renderMarkup(
    <TestSettingsHost host={host}>{element}</TestSettingsHost>,
  );
}

function makeRun(
  overrides: Partial<TelemetryExpensiveRun> = {},
): TelemetryExpensiveRun {
  return {
    sessionId: 'wt-1:chat-1',
    turnCount: 3,
    label: 'Implement plan imports',
    provider: 'claude',
    model: 'claude-opus-4-8',
    totalCostUsd: 100.55,
    startedAtIso: '2026-06-20T10:00:00.000Z',
    worktreeId: 'wt-1',
    branchName: 'trish/2026-06-15-plan-imports',
    prUrl: 'https://github.com/example/repo/pull/42',
    authorName: 'trish',
    status: 'SUCCESS',
    eventType: 'WORKTREE_CHAT',
    durationMs: 750_000,
    inputTokens: 2_000_000,
    outputTokens: 400_000,
    ...overrides,
  };
}

describe('MostExpensiveRuns', () => {
  it('renders the empty state when there are no runs', () => {
    const html = renderToStaticMarkup(<MostExpensiveRuns runs={[]} />);
    expect(html).toContain('expensive-runs-empty');
    expect(html).toContain('No sessions recorded for this range.');
  });

  it('renders enriched run details', () => {
    const html = renderToStaticMarkup(<MostExpensiveRuns runs={[makeRun()]} />);
    // Status badge with friendly label + test hook.
    expect(html).toContain('expensive-run-status-wt-1:chat-1');
    expect(html).toContain('Success');
    // Label and cost.
    expect(html).toContain('Implement plan imports');
    expect(html).toContain('$100.55');
    // Meta line: author · event type · branch.
    expect(html).toContain('trish');
    expect(html).toContain('Worktree chat');
    expect(html).toContain('trish/2026-06-15-plan-imports');
    // Detail line: turn count · provider · model · tokens · duration.
    expect(html).toContain('3 turns');
    expect(html).toContain('Claude');
    expect(html).toContain('claude-opus-4-8');
    expect(html).toContain('2.4M tokens');
    expect(html).toContain('12m 30s');
    // PR link.
    expect(html).toContain('expensive-run-pr-wt-1:chat-1');
  });

  it('renders a singular turn label for a one-turn session', () => {
    const html = renderToStaticMarkup(
      <MostExpensiveRuns runs={[makeRun({ turnCount: 1 })]} />,
    );
    expect(html).toContain('1 turn');
    expect(html).not.toContain('1 turns');
  });

  it('falls back to Unknown when the author is missing', () => {
    const html = renderToStaticMarkup(
      <MostExpensiveRuns runs={[makeRun({ authorName: null })]} />,
    );
    expect(html).toContain('Unknown');
  });

  it('falls back to Unknown when the author is blank/whitespace', () => {
    const html = renderToStaticMarkup(
      <MostExpensiveRuns runs={[makeRun({ authorName: '   ' })]} />,
    );
    expect(html).toContain('Unknown');
  });

  it('omits duration when durationMs is null', () => {
    const html = renderToStaticMarkup(
      <MostExpensiveRuns runs={[makeRun({ durationMs: null })]} />,
    );
    expect(html).not.toContain('12m 30s');
    // Tokens still render.
    expect(html).toContain('2.4M tokens');
  });

  it('omits tokens and the breakdown tooltip when both input and output are zero', () => {
    const html = renderToStaticMarkup(
      <MostExpensiveRuns
        runs={[makeRun({ inputTokens: 0, outputTokens: 0 })]}
      />,
    );
    expect(html).not.toContain('tokens');
    // No "0 in · 0 out" tooltip when there are no tokens to break down.
    // The hint reads `N in · M out`; match the separator so class strings
    // such as `shrink-0 inline-flex` cannot trip the check.
    expect(html).not.toContain(' in · ');
  });

  it('omits the PR link when there is no PR url', () => {
    const html = renderToStaticMarkup(
      <MostExpensiveRuns runs={[makeRun({ prUrl: null })]} />,
    );
    expect(html).not.toContain('expensive-run-pr-wt-1:chat-1');
  });

  it('keeps run titles and author names out of session replay', () => {
    const html = renderToStaticMarkup(
      <MostExpensiveRuns runs={[makeRun()]} />,
      {
        blockClassName: 'replay-block',
        maskClassName: 'replay-mask',
      },
    );
    expect(html).toContain(
      'class="truncate text-s font-medium fg-primary replay-block"',
    );
    expect(html).toContain(
      'class="mt-0.5 truncate text-xs fg-secondary replay-block"',
    );
  });

  it('adds no stray class token when the host has no replay privacy', () => {
    const html = renderToStaticMarkup(<MostExpensiveRuns runs={[makeRun()]} />);
    expect(html).toContain('class="truncate text-s font-medium fg-primary"');
    expect(html).toContain('class="mt-0.5 truncate text-xs fg-secondary"');
  });
});
