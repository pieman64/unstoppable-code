/**
 * @jest-environment jsdom
 */
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { PageHeader } from '../PageHeader';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function parse(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  const header = host.querySelector('[data-testid="page-header"]');
  if (!(header instanceof HTMLElement)) throw new Error('No page header');
  return header;
}

function byTestId(root: ParentNode, id: string): HTMLElement {
  const element = root.querySelector(`[data-testid="${id}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`No ${id}`);
  return element;
}

describe('PageHeader', () => {
  it('renders the title at 20/28 in the 450 weight with a one-line description', () => {
    const header = parse(
      renderToStaticMarkup(
        <PageHeader title="Feed" description="Entries from your projects." />,
      ),
    );
    expect(header.tagName).toBe('HEADER');
    const title = byTestId(header, 'page-header-title');
    expect(title.tagName).toBe('H1');
    expect(title.textContent).toBe('Feed');
    // `text-xl` is 20/28; `font-medium` is the 450 weight DESIGN.md names.
    expect(title.className).toContain('text-xl');
    expect(title.className).toContain('font-medium');
    expect(title.className).toContain('text-balance');
    expect(title.className).not.toContain('font-semibold');
    const description = byTestId(header, 'page-header-description');
    expect(description.textContent).toBe('Entries from your projects.');
    expect(description.className).toContain('text-pretty');
    // A saved description of any length stops at two lines.
    expect(description.className).toContain('line-clamp-2');
    expect(description.className).toContain('fg-tertiary');
    expect(description.className).toContain('max-w-160');
    // A div, so a host can pass a link or a short block without nesting a
    // block inside a paragraph.
    expect(description.tagName).toBe('DIV');
  });

  it('puts the back link on its own line above the title, left-aligned', () => {
    const header = parse(
      renderToStaticMarkup(
        <PageHeader
          back={{ label: 'Library', onClick: (): void => {} }}
          title="Code review"
          actions={<button type="button">Run</button>}
        />,
      ),
    );
    const back = byTestId(header, 'page-header-back');
    // A direct child of the header, so it never shares the title's row.
    expect(back.parentElement).toBe(header);
    expect(header.firstElementChild).toBe(back);
    const title = byTestId(header, 'page-header-title');
    expect(title.parentElement?.contains(back)).toBe(false);
    // The shared compact ghost capsule; -ml-3 pulls back its 12px inset, so
    // the glyph's edge lines up with the title's.
    expect(back.className.split(' ')).toEqual(
      expect.arrayContaining(['-ml-3', 'px-3', 'h-7', 'mb-2', 'rounded-full']),
    );
    expect(back.querySelector('svg')).toBeInstanceOf(SVGElement);
  });

  it('keeps one top offset unless the host already insets the page', () => {
    const page = parse(renderToStaticMarkup(<PageHeader title="Usage" />));
    expect(page.className.split(' ')).toContain('pt-12');
    const settings = parse(
      renderToStaticMarkup(<PageHeader title="Memory" inset="none" />),
    );
    expect(settings.className.split(' ')).not.toContain('pt-12');
    // A host's window layout keys its own inset on this.
    expect(page.dataset.inset).toBe('page');
    expect(settings.dataset.inset).toBe('none');
  });

  it('orders back link, title row, description, then tabs', () => {
    const header = parse(
      renderToStaticMarkup(
        <PageHeader
          back={{ label: 'Library', onClick: (): void => {} }}
          title="Code review"
          badge="Read-only"
          description="Reviews a pull request."
          actions={<button type="button">Duplicate</button>}
          tabs={<div role="tablist" />}
        />,
      ),
    );
    const order = Array.from(header.children).map(
      (child) =>
        child.getAttribute('data-testid') ??
        (child.querySelector('h1') ? 'title-row' : child.tagName),
    );
    expect(order).toEqual([
      'page-header-back',
      'title-row',
      'page-header-description',
      'page-header-tabs',
    ]);
    const row = header.children[1];
    if (!(row instanceof HTMLElement)) throw new Error('No title row');
    expect(
      Array.from(row.children).map((child) =>
        child.getAttribute('data-testid'),
      ),
    ).toEqual([
      'page-header-title',
      'page-header-badge',
      'page-header-actions',
    ]);
    // Actions sit at the end of the title row.
    expect(byTestId(row, 'page-header-actions').className).toContain('ml-auto');
  });

  it('renders an h2 with the same treatment when the host owns the h1', () => {
    const header = parse(
      renderToStaticMarkup(
        <PageHeader headingLevel="h2" title="Members" description="People." />,
      ),
    );
    expect(header.querySelector('h1')).toBeNull();
    expect(byTestId(header, 'page-header-title').tagName).toBe('H2');
  });

  it('renders the actions slot only when actions are passed or reserved', () => {
    const without = parse(renderToStaticMarkup(<PageHeader title="Memory" />));
    expect(
      without.querySelector('[data-testid="page-header-actions"]'),
    ).toBeNull();
    const reserved = parse(
      renderToStaticMarkup(<PageHeader title="Feed" reserveActions />),
    );
    const slot = byTestId(reserved, 'page-header-actions');
    expect(slot.childElementCount).toBe(0);
    // A button's height, so sibling pages keep the same box.
    expect(slot.className).toContain('min-h-7');
  });

  it('omits the description, badge, back link and tabs when not given', () => {
    const header = parse(renderToStaticMarkup(<PageHeader title="Usage" />));
    for (const id of [
      'page-header-description',
      'page-header-badge',
      'page-header-back',
      'page-header-tabs',
    ]) {
      expect(header.querySelector(`[data-testid="${id}"]`)).toBeNull();
    }
  });

  describe('interaction', () => {
    let container: HTMLDivElement;
    let root: Root;
    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    });
    afterEach(() => {
      act(() => root.unmount());
      container.remove();
    });

    it('calls back on the back link and exposes a focusable title', () => {
      const onBack = jest.fn();
      const ref = createRef<HTMLHeadingElement>();
      act(() => {
        root.render(
          <PageHeader
            back={{ label: 'Library', onClick: onBack, testId: 'back' }}
            title="Code review"
            headingRef={ref}
            titleTestId="name"
          />,
        );
      });
      const back = byTestId(container, 'back');
      expect(back.textContent).toBe('Library');
      act(() => back.click());
      expect(onBack).toHaveBeenCalledTimes(1);
      expect(ref.current).toBe(byTestId(container, 'name'));
      expect(ref.current?.tabIndex).toBe(-1);
    });
  });
});
