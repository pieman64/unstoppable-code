/**
 * Server-rendered tests for the shared {@link CheckStatusBadge}. Validates
 * that each status dispatches to the correct glyph + color combination.
 */
import { renderToString } from 'react-dom/server';
import { CheckStatusBadge } from '../CheckStatusBadge';

describe('CheckStatusBadge', () => {
  it('renders the success check', () => {
    const html = renderToString(<CheckStatusBadge status="success" />);
    expect(html).toContain('fg-success-strong');
    expect(html).toContain('✓');
  });

  it('renders the failure cross', () => {
    const html = renderToString(<CheckStatusBadge status="failure" />);
    expect(html).toContain('fg-destructive-strong');
    expect(html).toContain('✗');
  });

  it('renders the neutral dot', () => {
    const html = renderToString(<CheckStatusBadge status="neutral" />);
    expect(html).toContain('fg-secondary');
    expect(html).toContain('•');
  });

  it('renders the default pending ring when no pendingIcon is supplied', () => {
    const html = renderToString(<CheckStatusBadge status="pending" />);
    expect(html).toContain('fg-info');
    expect(html).toContain('rounded-full');
  });

  it('honors a caller-supplied pendingIcon for the pending variant', () => {
    const html = renderToString(
      <CheckStatusBadge
        status="pending"
        pendingIcon={<span data-testid="custom-spinner">spin</span>}
      />,
    );
    expect(html).toContain('fg-info');
    expect(html).toContain('data-testid="custom-spinner"');
  });

  it('honors the dataTestId hook', () => {
    const html = renderToString(
      <CheckStatusBadge status="success" dataTestId="check-test" />,
    );
    expect(html).toContain('data-testid="check-test"');
  });
});
