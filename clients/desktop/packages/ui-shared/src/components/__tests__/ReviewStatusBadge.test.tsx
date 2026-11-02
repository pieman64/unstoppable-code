import { renderToString } from 'react-dom/server';
import { ReviewStatusBadge } from '../ReviewStatusBadge';

describe('ReviewStatusBadge', () => {
  it('renders approved in green by default', () => {
    const html = renderToString(<ReviewStatusBadge status="approved" />);

    expect(html).toContain('Approved');
    expect(html).toContain('fg-success');
  });

  it('renders approved in muted text when the PR is not ready to merge', () => {
    const html = renderToString(
      <ReviewStatusBadge status="approved" approvedTone="muted" />,
    );

    expect(html).toContain('Approved');
    expect(html).toContain('title="Has PR approval but is not ready to merge"');
    expect(html).toContain('aria-label="Approved, not ready to merge"');
    expect(html).toContain('fg-secondary');
    expect(html).not.toContain('fg-success');
  });

  it('renders each state on the shared badge capsule', () => {
    const changes = renderToString(
      <ReviewStatusBadge status="changes-requested" />,
    );
    expect(changes).toContain('Changes requested');
    expect(changes).toContain('bg-warning-subtle fg-warning-strong');
    expect(changes).toContain('h-4.5');
    expect(renderToString(<ReviewStatusBadge status="none" />)).toContain(
      'bg-muted fg-secondary',
    );
  });
});
