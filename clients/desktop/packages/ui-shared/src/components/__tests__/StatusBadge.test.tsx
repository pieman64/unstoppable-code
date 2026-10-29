/**
 * Server-rendered tests for the shared {@link StatusBadge}. Validates that
 * each variant maps to the right color palette and that the muted overlay
 * dims the badge as expected.
 */
import { renderToString } from 'react-dom/server';
import { StatusBadge, type StatusBadgeVariant } from '../StatusBadge';

describe('StatusBadge', () => {
  const variants: StatusBadgeVariant[] = [
    'active',
    'muted',
    'warning',
    'destructive',
    'success',
  ];

  it.each(variants)('renders the %s variant', (variant) => {
    const html = renderToString(
      <StatusBadge variant={variant} label={variant} />,
    );
    expect(html).toContain(variant);
    expect(html).toContain('rounded-full');
  });

  it('applies the active palette by default', () => {
    const html = renderToString(
      <StatusBadge variant="active" label="running" />,
    );
    expect(html).toContain('bg-info-subtle');
    expect(html).toContain('fg-info');
  });

  it('applies the success palette', () => {
    const html = renderToString(
      <StatusBadge variant="success" label="success" />,
    );
    expect(html).toContain('bg-success-subtle');
    expect(html).toContain('fg-success-strong');
  });

  it('applies the destructive palette', () => {
    const html = renderToString(
      <StatusBadge variant="destructive" label="failure" />,
    );
    expect(html).toContain('bg-destructive-subtle');
    expect(html).toContain('fg-destructive-strong');
  });

  it('applies the warning palette', () => {
    const html = renderToString(
      <StatusBadge variant="warning" label="pending" />,
    );
    expect(html).toContain('bg-info-subtle');
    expect(html).toContain('fg-info');
  });

  it('falls back to neutral muted styling for the muted variant', () => {
    const html = renderToString(<StatusBadge variant="muted" label="paused" />);
    expect(html).toContain('bg-fg-secondary/16');
    expect(html).toContain('fg-secondary');
    // Shared pipeline-row status badge geometry, ring instead of border.
    expect(html).toContain('h-5');
    expect(html).toContain('ring-[length:var(--border-hairline)]');
    expect(html).toContain('ring-fg-secondary/20');
  });

  it('emits dimmer muted colors when the muted prop is set', () => {
    const html = renderToString(
      <StatusBadge variant="success" muted label="success" />,
    );
    expect(html).toContain('bg-success-subtle');
    expect(html).toContain('fg-success-strong/70');
  });

  it('renders children when no label is provided', () => {
    const html = renderToString(
      <StatusBadge variant="active">
        <span data-testid="custom-child">child</span>
      </StatusBadge>,
    );
    expect(html).toContain('data-testid="custom-child"');
  });

  it('honors the dataTestId hook', () => {
    const html = renderToString(
      <StatusBadge variant="active" label="x" dataTestId="status-test" />,
    );
    expect(html).toContain('data-testid="status-test"');
  });
});
