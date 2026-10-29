/**
 * @jest-environment jsdom
 */
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppIconBase } from '../AppIconBase';

function renderSvg(element: ReactElement): SVGSVGElement {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(element);
  const svg = container.querySelector('svg');
  if (!svg) {
    throw new Error('AppIconBase rendered no <svg>');
  }
  return svg;
}

describe('AppIconBase', () => {
  it.each([
    [12, 14],
    [14, 14],
    [16, 14],
    [18, 20],
    [20, 20],
    [24, 20],
  ])(
    'normalizes Lucide size %i to the approved %i px tier',
    (requested, expected) => {
      const svg = renderSvg(
        <AppIconBase
          artworkFamily="lucide"
          size={requested}
          style={{ width: requested, height: requested }}
        />,
      );
      expect(svg.getAttribute('width')).toBe(`${expected}px`);
      expect(svg.getAttribute('height')).toBe(`${expected}px`);
      expect(svg.style.width).toBe(`${expected}px`);
      expect(svg.style.height).toBe(`${expected}px`);
      expect(svg.dataset.iconFamily).toBe('lucide');
    },
  );

  it('renders a hidden 24px currentColor glyph by default', () => {
    const svg = renderSvg(
      <AppIconBase>
        <path d="M1 1" />
      </AppIconBase>,
    );
    expect(svg.getAttribute('width')).toBe('24px');
    expect(svg.getAttribute('height')).toBe('24px');
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('fill')).toBe('currentColor');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('role')).toBeNull();
    expect(svg.getAttribute('aria-label')).toBeNull();
  });

  it('writes a numeric size as px and passes a string size through', () => {
    expect(renderSvg(<AppIconBase size={16} />).getAttribute('width')).toBe(
      '16px',
    );
    expect(renderSvg(<AppIconBase size="1em" />).getAttribute('height')).toBe(
      '1em',
    );
  });

  it('exposes title as an aria-label image when not hidden, without a <title>', () => {
    const svg = renderSvg(
      <AppIconBase ariaHidden={false} title="Merged">
        <path d="M1 1" />
      </AppIconBase>,
    );
    expect(svg.getAttribute('aria-hidden')).toBe('false');
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Merged');
    expect(svg.querySelector('title')).toBeNull();
  });

  it('accepts fill="none" for stroke art and keeps the viewBox, color, and other props', () => {
    const svg = renderSvg(
      <AppIconBase
        fill="none"
        viewBox="0 -960 960 960"
        color="red"
        data-testid="glyph"
        data-glyph="merge"
      />,
    );
    expect(svg.getAttribute('fill')).toBe('none');
    expect(svg.getAttribute('viewBox')).toBe('0 -960 960 960');
    expect(svg.style.color).toBe('red');
    expect(svg.getAttribute('data-testid')).toBe('glyph');
    expect(svg.getAttribute('data-glyph')).toBe('merge');
  });
});
