/**
 * @jest-environment jsdom
 */
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { LinearProgress } from '../LinearProgress';
import { ResizeRailIndicator } from '../ResizeRailIndicator';

const TOKENS_SOURCE = readFileSync(
  join(process.cwd(), 'packages/ui-shared/src/styles/canopy-tokens-core.css'),
  'utf8',
);

/** A Tailwind transition list that names a layout property. */
const LAYOUT_TRANSITION =
  /transition-(all|\[[^\]]*(width|height|left|right|top|bottom|margin|padding|inset)[^\]]*\])/;

function render(markup: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = markup;
  const element = host.firstElementChild;
  if (!(element instanceof HTMLElement)) throw new Error('nothing rendered');
  return element;
}

describe('compositor-only motion', () => {
  it('sizes a progress bar by layout and leaves its motion to the compositor', () => {
    const track = render(
      renderToStaticMarkup(<LinearProgress percentage={30} label="Upload" />),
    );
    const bar = track.firstElementChild;
    expect(bar).toBeInstanceOf(HTMLElement);
    if (!(bar instanceof HTMLElement)) return;
    // Exact at rest: the bar keeps its width and round ends; useFlipBox draws
    // a change as a scale from the top-left corner.
    expect(bar.style.width).toBe('30%');
    expect(bar.className).toContain('rounded-full');
    expect(bar.className).toContain('origin-top-left');
    expect(bar.className).not.toMatch(LAYOUT_TRANSITION);
  });

  it('keeps an indeterminate bar a still third of the track', () => {
    const bar = render(
      renderToStaticMarkup(<LinearProgress percentage={0} indeterminate />),
    ).firstElementChild;
    expect(bar).toBeInstanceOf(HTMLElement);
    if (!(bar instanceof HTMLElement)) return;
    expect(bar.className).toContain('w-1/3');
    expect(bar.style.width).toBe('');
  });

  it('thickens a resize line by scale from the shared stylesheet', () => {
    const idle = render(
      renderToStaticMarkup(<ResizeRailIndicator active={false} />),
    );
    expect(idle.className).toContain('w-0.5');
    expect(idle.className).toContain('rounded-full');
    expect(idle.className).toContain('transition-[scale,background-color]');
    expect(idle.className).not.toMatch(LAYOUT_TRANSITION);
    expect(idle.dataset.resizeRailIndicator).toBe('vertical');
    expect(idle.dataset.active).toBeUndefined();

    const dragging = render(
      renderToStaticMarkup(<ResizeRailIndicator active line="horizontal" />),
    );
    expect(dragging.className).toContain('h-0.5');
    expect(dragging.className).toContain('bg-accent/80');
    expect(dragging.dataset.resizeRailIndicator).toBe('horizontal');
    expect(dragging.dataset.active).toBe('true');

    // Halved by scale at rest, with the corner divided across so the end
    // stays round; full while hovered or dragging.
    expect(TOKENS_SOURCE).toContain(
      "[data-resize-rail-indicator='vertical'] {\n  transform-origin: right center;\n  scale: 0.5 1;\n  border-radius: 1px / 0.5px;",
    );
    expect(TOKENS_SOURCE).toContain(
      "[data-resize-rail-indicator][data-active='true'] {\n  scale: none;",
    );
    expect(TOKENS_SOURCE).toContain(
      '.group:hover [data-resize-rail-indicator] {\n    scale: none;',
    );
    expect(TOKENS_SOURCE).toContain(
      "[data-group-rail-line][data-expanded='true'] {\n  scale: 2 1;\n  border-radius: 1px / 2px;",
    );
  });
});
