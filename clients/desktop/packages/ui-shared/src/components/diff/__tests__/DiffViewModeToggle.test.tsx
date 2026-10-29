import { renderToString } from 'react-dom/server';
import { DiffViewModeToggle } from '../DiffViewModeToggle';

describe('DiffViewModeToggle', () => {
  it('renders both modes with the selected one marked aria-pressed', () => {
    const html = renderToString(
      <DiffViewModeToggle value="unified" onChange={(): void => {}} />,
    );
    expect(html).toContain('Unified');
    expect(html).toContain('Split');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Unified/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Split/);
  });

  it('applies the primary palette to the selected mode', () => {
    const html = renderToString(
      <DiffViewModeToggle value="split" onChange={(): void => {}} />,
    );
    expect(html).toContain('bg-accent-subtle');
  });

  it('exposes a stable data-testid', () => {
    const html = renderToString(
      <DiffViewModeToggle
        value="unified"
        onChange={(): void => {}}
        dataTestId="my-toggle"
      />,
    );
    expect(html).toContain('data-testid="my-toggle"');
    expect(html).toContain('data-testid="my-toggle-unified"');
    expect(html).toContain('data-testid="my-toggle-split"');
  });
});
