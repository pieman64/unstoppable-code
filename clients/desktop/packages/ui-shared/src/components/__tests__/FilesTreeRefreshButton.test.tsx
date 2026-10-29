/** @jest-environment jsdom */
import type { JSX } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FilesTreeRefreshButton } from '../FilesTreeRefreshButton';
import { IconStyleProvider } from '../icon-style';

function render(element: JSX.Element): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(element);
  return host;
}

function glyph(host: HTMLElement): SVGElement {
  const svg = host.querySelector<SVGElement>(
    '[data-testid="files-tree-refresh"] svg',
  );
  if (!svg) throw new Error('Expected a refresh glyph');
  return svg;
}

describe('FilesTreeRefreshButton', () => {
  it('draws the Lucide spinner without an icon style provider', () => {
    const host = render(<FilesTreeRefreshButton onClick={jest.fn()} />);
    const button = host.querySelector('[data-testid="files-tree-refresh"]');
    expect(button?.getAttribute('aria-label')).toBe('Refresh files');
    expect(glyph(host).getAttribute('data-app-icon')).toBe('true');
    expect(glyph(host).getAttribute('width')).toBe('14px');
  });

  it('draws the app glyph when the host opts in', () => {
    const host = render(
      <IconStyleProvider value="central">
        <FilesTreeRefreshButton onClick={jest.fn()} density="compact" />
      </IconStyleProvider>,
    );
    expect(glyph(host).getAttribute('data-app-icon')).toBe('true');
    expect(glyph(host).classList.contains('h-3')).toBe(true);
  });

  it('spins and disables on request in either style', () => {
    for (const style of ['classic', 'central'] as const) {
      const host = render(
        <IconStyleProvider value={style}>
          <FilesTreeRefreshButton onClick={jest.fn()} disabled spinning />
        </IconStyleProvider>,
      );
      expect(glyph(host).classList.contains('animate-spin')).toBe(true);
      expect(
        host
          .querySelector('[data-testid="files-tree-refresh"]')
          ?.hasAttribute('disabled'),
      ).toBe(true);
    }
  });

  it('keeps the compact classic spinner at its own 14px size', () => {
    const host = render(
      <FilesTreeRefreshButton onClick={jest.fn()} density="compact" />,
    );
    expect(glyph(host).getAttribute('width')).toBe('14px');
  });

  it('omits the tooltip wrapper when asked', () => {
    const withTooltip = render(<FilesTreeRefreshButton onClick={jest.fn()} />);
    const without = render(
      <FilesTreeRefreshButton onClick={jest.fn()} showTooltip={false} />,
    );
    expect(withTooltip.firstElementChild?.tagName).not.toBe('BUTTON');
    expect(without.firstElementChild?.tagName).toBe('BUTTON');
  });
});
