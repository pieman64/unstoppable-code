import { renderToString } from 'react-dom/server';
import { OverviewCard } from '../OverviewCard';

describe('OverviewCard', () => {
  it('renders the project·worktree label, title, and subtitle', () => {
    const out = renderToString(
      <OverviewCard
        label={{ workspaceName: 'My Project', worktreeName: 'main' }}
        title="Unread messages"
        subtitle={<span>running</span>}
        leadingIcon={<span data-testid="plan-icon">P</span>}
        onClick={(): void => {}}
      />,
    ).replace(/<!-- -->/g, '');
    expect(out).toContain('data-testid="overview-card"');
    expect(out).toContain('My Project · main');
    expect(out).toContain('Unread messages');
    expect(out).toContain('running');
    expect(out).toContain('data-testid="plan-icon"');
    expect(out).not.toContain('aria-disabled="true"');
  });

  it('is non-interactive when no click handler is provided', () => {
    const out = renderToString(<OverviewCard label={null} title="Static" />);
    expect(out).not.toContain('aria-disabled');
    expect(out).not.toContain('data-testid="overview-card-open"');
    expect(out).toContain('Static');
  });

  it('renders an independently labelled dismiss action', () => {
    const out = renderToString(
      <OverviewCard
        label={null}
        title="Unread"
        onClick={(): void => {}}
        onDismiss={(): void => {}}
        dismissLabel="Mark read"
      />,
    );
    expect(out).toContain('aria-label="Mark read"');
    expect(out).toContain('data-testid="overview-card-dismiss"');
    expect(out).toContain('role="group"');
    expect(out).not.toContain('role="button"');
  });
});
