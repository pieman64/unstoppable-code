/** @jest-environment jsdom */
// Test-only source inspection; production ui-shared remains browser-only.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import path from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { InlineTextSkeleton } from '../InlineTextSkeleton';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('InlineTextSkeleton', () => {
  it('renders an inert, text-free inline bar sized by the caller', () => {
    act(() => {
      root.render(
        <p>
          ID
          <InlineTextSkeleton data-testid="bar" className="w-24" />
        </p>,
      );
    });
    const bar = container.querySelector('[data-testid="bar"]');
    expect(bar?.tagName).toBe('SPAN');
    expect(bar?.getAttribute('aria-hidden')).toBe('true');
    expect(bar?.textContent).toBe('');
    expect(bar?.className).toContain('canopy-inline-skeleton');
    expect(bar?.className).toContain('select-none');
    expect(bar?.className).toContain('w-24');
    expect(bar?.hasAttribute('data-active')).toBe(false);
    expect(container.textContent).toBe('ID');
  });

  it('marks the bar active only while the content is being fetched', () => {
    act(() => {
      root.render(<InlineTextSkeleton data-testid="bar" active />);
    });
    const bar = (): Element | null =>
      container.querySelector('[data-testid="bar"]');
    expect(bar()?.getAttribute('data-active')).toBe('true');
    act(() => {
      root.render(<InlineTextSkeleton data-testid="bar" active={false} />);
    });
    expect(bar()?.hasAttribute('data-active')).toBe(false);
  });

  it('animates only when active, after a delay, and never under reduced motion', () => {
    const css = readFileSync(
      path.join(
        process.cwd(),
        'packages/ui-shared/src/styles/canopy-tokens-core.css',
      ),
      'utf8',
    );
    // Every animation of the bar lives inside the no-preference media query.
    const outsideMotionQuery = css.replace(
      /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g,
      '',
    );
    expect(outsideMotionQuery).toMatch(/\.canopy-inline-skeleton\s*\{/);
    expect(outsideMotionQuery).not.toMatch(
      /\.canopy-inline-skeleton[^{]*\{[^}]*animation/,
    );
    const animated = css.match(
      /@media \(prefers-reduced-motion: no-preference\) \{[^@]*?\.canopy-inline-skeleton\[data-active='true'\]::after\s*\{([^}]*)\}/,
    );
    expect(animated?.[1]).toMatch(/animation:[^;]*\b300ms\b/);
  });
});
