/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { ThinkingSpinner } from '../ThinkingSpinner';

describe('ThinkingSpinner', () => {
  it('renders the natural 10px dot grid with no inline gap by default', () => {
    const markup = renderToStaticMarkup(<ThinkingSpinner />);
    expect(markup).toContain('gap-0.5');
    expect(markup).not.toContain('style=');
  });

  it('widens the gaps to meet an explicit size', () => {
    // 12px box = three 2px columns + two 3px gaps. Inline so it beats the
    // default utility class regardless of stylesheet order.
    expect(renderToStaticMarkup(<ThinkingSpinner sizePx={12} />)).toContain(
      'gap:3px',
    );
    expect(renderToStaticMarkup(<ThinkingSpinner sizePx={14} />)).toContain(
      'gap:4px',
    );
  });

  it('ignores a size at or below the natural grid width', () => {
    // Shrinking would need smaller dots, not smaller gaps; the caller gets the
    // natural grid rather than a negative gap.
    expect(renderToStaticMarkup(<ThinkingSpinner sizePx={10} />)).not.toContain(
      'style=',
    );
    expect(renderToStaticMarkup(<ThinkingSpinner sizePx={4} />)).not.toContain(
      'style=',
    );
  });

  it('inherits the surrounding ink by default', () => {
    expect(renderToStaticMarkup(<ThinkingSpinner />)).not.toMatch(/\bfg-/);
  });

  it('renders its tone through the shared spinner inks', () => {
    expect(renderToStaticMarkup(<ThinkingSpinner tone="accent" />)).toContain(
      'fg-accent',
    );
    expect(renderToStaticMarkup(<ThinkingSpinner tone="unread" />)).toContain(
      'fg-info',
    );
  });

  it('quiets the ink when it sits beside a label', () => {
    expect(
      renderToStaticMarkup(<ThinkingSpinner tone="primary" quiet />),
    ).toMatch(/fg-primary opacity-60/);
  });

  it('keeps placement classes and the Thinking label', () => {
    const markup = renderToStaticMarkup(
      <ThinkingSpinner sizePx={12} tone="accent" className="mr-1 shrink-0" />,
    );
    expect(markup).toContain('mr-1 shrink-0');
    expect(markup).toContain('aria-label="Thinking"');
  });
});
