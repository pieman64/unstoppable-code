/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { PageTitlebar } from '../PageTitlebar';

function classesOf(markup: string): string[] {
  const host = document.createElement('div');
  host.innerHTML = markup;
  return (host.firstElementChild?.className ?? '').split(/\s+/).filter(Boolean);
}

describe('PageTitlebar', () => {
  it('is the shared 40px top strip and the window drag region by default', () => {
    const classes = classesOf(
      renderToStaticMarkup(<PageTitlebar testId="page-titlebar" />),
    );

    expect(classes).toEqual(
      expect.arrayContaining([
        'flex',
        'shrink-0',
        'items-stretch',
        'h-10',
        'electron-drag',
      ]),
    );
    expect(classes).not.toContain('h-11.5');
    expect(classes).not.toContain('border-b');
    expect(classes).not.toContain('sticky');
  });

  it('seats a breadcrumb trail in the 46px bar or sizes to its content', () => {
    expect(
      classesOf(renderToStaticMarkup(<PageTitlebar height="breadcrumb" />)),
    ).toContain('h-11.5');

    const content = classesOf(
      renderToStaticMarkup(
        <PageTitlebar height="content">Header</PageTitlebar>,
      ),
    );
    expect(content).not.toContain('h-10');
    expect(content).not.toContain('h-11.5');
  });

  it('can stay out of the drag region', () => {
    expect(
      classesOf(renderToStaticMarkup(<PageTitlebar dragRegion={false} />)),
    ).not.toContain('electron-drag');
  });

  it('draws the hairline divider below a header row', () => {
    const classes = classesOf(
      renderToStaticMarkup(<PageTitlebar divider>Header</PageTitlebar>),
    );

    expect(classes).toEqual(expect.arrayContaining(['border-b']));
  });

  it('pins over a scrolling page with an opaque fill and a hairline that fades in once scrolled', () => {
    const rest = classesOf(renderToStaticMarkup(<PageTitlebar pinned />));
    expect(rest).toEqual(
      expect.arrayContaining([
        'sticky',
        'top-0',
        'bg-base',
        'after:absolute',
        'after:inset-x-0',
        'after:bottom-0',
        'after:h-[var(--border-hairline)]',
        'after:bg-[var(--line-base)]',
        'after:transition-opacity',
        'after:duration-150',
        "after:content-['']",
        'after:pointer-events-none',
        'after:opacity-0',
      ]),
    );
    expect(rest).not.toContain('after:opacity-100');
    expect(rest).not.toContain('border-b');

    const scrolled = classesOf(
      renderToStaticMarkup(<PageTitlebar pinned scrolled />),
    );
    expect(scrolled).toContain('after:opacity-100');
    expect(scrolled).not.toContain('after:opacity-0');
  });

  it('keeps placement classes and the test id on the outer row', () => {
    const markup = renderToStaticMarkup(
      <PageTitlebar className="z-20" testId="plugins-page-titlebar" />,
    );

    expect(classesOf(markup)).toContain('z-20');
    expect(markup).toContain('data-testid="plugins-page-titlebar"');
  });
});
