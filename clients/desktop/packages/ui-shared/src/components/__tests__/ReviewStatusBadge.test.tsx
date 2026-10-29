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
});
