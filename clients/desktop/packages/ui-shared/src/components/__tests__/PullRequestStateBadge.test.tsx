/**
 * Server-rendered tests for {@link PullRequestStateBadge}. Validates the
 * color palette for each PR state and ensures the label is the literal
 * state string (matching the desktop visual).
 */
import { renderToString } from 'react-dom/server';
import {
  PullRequestStateBadge,
  type PullRequestStateBadgeState,
} from '../PullRequestStateBadge';

describe('PullRequestStateBadge', () => {
  // Each state renders on its operational status role.
  const cases: Array<{
    state: PullRequestStateBadgeState;
    surface: string;
    edge: string;
  }> = [
    {
      state: 'open',
      surface: 'bg-success-subtle',
      edge: 'border-fg-success-strong/30',
    },
    {
      state: 'merged',
      surface: 'bg-special-subtle',
      edge: 'border-fg-special-strong/30',
    },
    {
      state: 'closed',
      surface: 'bg-destructive-subtle',
      edge: 'border-fg-destructive-strong/30',
    },
    {
      state: 'draft',
      surface: 'bg-fg-secondary/16',
      edge: 'border-fg-secondary/30',
    },
  ];

  it.each(cases)(
    'renders $state with the matching palette',
    ({ state, surface, edge }) => {
      const html = renderToString(<PullRequestStateBadge state={state} />);
      expect(html).toContain(state);
      expect(html).toContain(surface);
      expect(html).toContain(edge);
    },
  );

  it('emits the rounded-full chrome', () => {
    const html = renderToString(<PullRequestStateBadge state="open" />);
    expect(html).toContain('rounded-full');
    expect(html).toContain('border');
  });

  it('honors the dataTestId hook', () => {
    const html = renderToString(
      <PullRequestStateBadge state="open" dataTestId="pr-state-test" />,
    );
    expect(html).toContain('data-testid="pr-state-test"');
  });
});
