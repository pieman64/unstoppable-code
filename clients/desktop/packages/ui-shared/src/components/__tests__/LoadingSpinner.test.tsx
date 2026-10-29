/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { LoadingSpinner } from '../LoadingSpinner';
import type { SpinnerTone } from '../spinner-tone';

describe('LoadingSpinner', () => {
  it('inherits the surrounding ink and renders the natural grid by default', () => {
    const markup = renderToStaticMarkup(<LoadingSpinner />);
    expect(markup).not.toMatch(/\bfg-/);
    expect(markup).toContain('gap-0.5');
    expect(markup).not.toContain('style=');
    expect(markup).toContain('aria-label="Loading"');
  });

  it.each<[SpinnerTone, string]>([
    ['primary', 'fg-primary'],
    ['secondary', 'fg-secondary'],
    ['tertiary', 'fg-tertiary'],
    ['accent', 'fg-accent'],
    ['emphasis', 'fg-emphasis'],
    ['warning', 'fg-warning'],
    ['destructive', 'fg-destructive'],
    ['active', 'fg-info'],
    ['unread', 'fg-info'],
  ])('renders the %s tone as %s', (tone, className) => {
    expect(renderToStaticMarkup(<LoadingSpinner tone={tone} />)).toContain(
      className,
    );
  });

  it('quiets the ink when it sits beside a label', () => {
    expect(renderToStaticMarkup(<LoadingSpinner />)).not.toContain(
      'opacity-60',
    );
    expect(
      renderToStaticMarkup(<LoadingSpinner tone="accent" quiet />),
    ).toContain('opacity-60');
  });

  it('widens the gaps to fill an icon slot', () => {
    expect(renderToStaticMarkup(<LoadingSpinner sizePx={12} />)).toContain(
      'gap:3px',
    );
    expect(renderToStaticMarkup(<LoadingSpinner sizePx={20} />)).toContain(
      'gap:7px',
    );
  });

  it('ignores a size at or below the natural grid width', () => {
    expect(renderToStaticMarkup(<LoadingSpinner sizePx={10} />)).not.toContain(
      'style=',
    );
  });

  it('keeps placement classes, the test hook, and decorative mode', () => {
    const markup = renderToStaticMarkup(
      <LoadingSpinner
        tone="accent"
        className="mr-2 shrink-0"
        dataTestId="busy"
        decorative
      />,
    );
    expect(markup).toContain('mr-2 shrink-0');
    expect(markup).toContain('data-testid="busy"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('aria-label');
  });

  it('stops the march under reduced motion, leaving the ring visible', () => {
    // The global reduced-motion rule runs an animation once for 0.01ms and
    // the march's last frame hides its dot, so each marching dot opts out of
    // the animation and keeps its own (visible) opacity instead.
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(<LoadingSpinner />);
    const dots = Array.from(container.querySelectorAll('span > span'));
    const marching = dots.filter((dot) =>
      dot.classList.contains('animate-loading-dot'),
    );
    expect(dots).toHaveLength(9);
    expect(marching).toHaveLength(8);
    for (const dot of marching) {
      expect(dot.classList.contains('motion-reduce:animate-none')).toBe(true);
      expect(dot.className).not.toMatch(/\bopacity-0\b/);
    }
  });
});
