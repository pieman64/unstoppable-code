/**
 * @jest-environment jsdom
 */
import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Heading } from '../Heading';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function parse(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  const heading = host.firstElementChild;
  if (!(heading instanceof HTMLElement)) throw new Error('No heading');
  return heading;
}

describe('Heading', () => {
  it('takes its element from the level and its look from the variant', () => {
    const heading = parse(
      renderToStaticMarkup(
        <Heading level={3} variant="section" id="usage">
          Usage
        </Heading>,
      ),
    );
    expect(heading.tagName).toBe('H3');
    expect(heading.id).toBe('usage');
    expect(heading.className.split(' ')).toEqual(
      expect.arrayContaining(['text-m', 'font-medium', 'fg-primary']),
    );
  });

  it.each([
    ['page', 'text-xl', 'fg-primary', 'text-balance'],
    ['section', 'text-m', 'fg-primary', 'text-pretty'],
    ['title', 'text-s', 'fg-primary', 'text-pretty'],
    ['label', 'text-xs', 'fg-secondary', 'text-pretty'],
  ] as const)(
    '%s is %s in %s at the 450 weight',
    (variant, size, ink, wrap) => {
      const classes = parse(
        renderToStaticMarkup(
          <Heading level={2} variant={variant}>
            Title
          </Heading>,
        ),
      ).className.split(' ');
      expect(classes).toEqual(
        expect.arrayContaining([size, ink, wrap, 'font-medium']),
      );
      expect(classes).not.toContain('font-semibold');
    },
  );

  it('truncates instead of wrapping and keeps placement classes', () => {
    const classes = parse(
      renderToStaticMarkup(
        <Heading level={2} variant="title" truncate className="min-w-0 flex-1">
          A long name
        </Heading>,
      ),
    ).className.split(' ');
    expect(classes).toEqual(
      expect.arrayContaining(['truncate', 'min-w-0', 'flex-1']),
    );
    expect(classes).not.toContain('text-pretty');
    expect(classes).not.toContain('outline-none');
  });

  it('forwards its ref and data attributes', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const ref = createRef<HTMLHeadingElement>();
    act(() => {
      root.render(
        <Heading
          level={1}
          variant="page"
          ref={ref}
          data-testid="gate-title"
          tabIndex={-1}
        >
          Sign in
        </Heading>,
      );
    });
    expect(ref.current?.tagName).toBe('H1');
    // A focus target shows no ring, like PageHeader's title.
    expect(ref.current?.className).toContain('outline-none');
    expect(ref.current?.dataset.testid).toBe('gate-title');
    act(() => root.unmount());
  });
});
