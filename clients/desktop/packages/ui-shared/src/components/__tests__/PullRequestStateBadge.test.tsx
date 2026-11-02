/**
 * Server-rendered tests for {@link PullRequestStateBadge}: each PR state is
 * the shared Badge in its tone, with a leading glyph and a sentence-case
 * label.
 */
import { renderToString } from 'react-dom/server';
import {
  PullRequestStateBadge,
  type PullRequestStateBadgeState,
} from '../PullRequestStateBadge';

describe('PullRequestStateBadge', () => {
  const cases: Array<{
    state: PullRequestStateBadgeState;
    label: string;
    tone: string;
  }> = [
    {
      state: 'open',
      label: 'Open',
      tone: 'bg-success-subtle fg-success-strong',
    },
    {
      state: 'merged',
      label: 'Merged',
      tone: 'bg-special-subtle fg-special-strong',
    },
    {
      state: 'closed',
      label: 'Closed',
      tone: 'bg-destructive-subtle fg-destructive-strong',
    },
    { state: 'draft', label: 'Draft', tone: 'bg-muted fg-secondary' },
  ];

  it.each(cases)(
    'renders $state as a $label badge with its glyph',
    ({ state, label, tone }) => {
      const html = renderToString(<PullRequestStateBadge state={state} />);
      expect(html).toContain(`>${label}</span>`);
      expect(html).toContain(tone);
      expect(html).toContain('<svg');
    },
  );

  it('uses the 18px capsule with no border', () => {
    const html = renderToString(<PullRequestStateBadge state="open" />);
    expect(html).toContain('h-4.5');
    expect(html).toContain('rounded-full');
    expect(html).not.toContain('border');
  });

  it('honors the dataTestId hook', () => {
    const html = renderToString(
      <PullRequestStateBadge state="open" dataTestId="pr-state-test" />,
    );
    expect(html).toContain('data-testid="pr-state-test"');
  });
});
