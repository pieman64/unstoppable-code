/** @jest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { CustomizeSectionHeading } from '@canopy/ui-shared/components';
import { PageHeading } from '../PageHeading';
import { PageContent } from '../PageContent';

describe('PageHeading', () => {
  it('owns the shared top-level heading typography and rhythm', () => {
    const markup = renderToStaticMarkup(
      <PageHeading
        title="Usage"
        subtitle="Find capabilities."
        actions={<button type="button">Add</button>}
      />,
    );

    expect(markup).toContain('data-testid="page-heading"');
    expect(markup).toContain('pt-12');
    expect(markup).toContain('text-xl font-semibold fg-primary');
    expect(markup).toContain('min-w-0 space-y-2');
    expect(markup).toContain('text-s fg-secondary');
    expect(markup).toContain('<button type="button">Add</button>');
  });

  it('mounts a shared section heading in place of its title and subtitle', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <PageHeading
        heading={<CustomizeSectionHeading />}
        actions={<button type="button">Add</button>}
      />,
    );

    const headings = container.querySelectorAll('h1');
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe('Customize');
    expect(
      container.querySelector('[data-testid="page-heading"] > .shrink-0')
        ?.textContent,
    ).toBe('Add');
  });

  it('pairs with one centered page width and horizontal gutter', () => {
    const markup = renderToStaticMarkup(
      <PageContent>
        <span>Content</span>
      </PageContent>,
    );

    expect(markup).toContain('mx-auto w-full max-w-6xl px-8');
  });
});

describe('PageContent', () => {
  function classesOf(markup: string): string[] {
    const match = markup.match(/class="([^"]*)"/);
    return (match?.[1] ?? '').split(/\s+/).filter(Boolean);
  }

  it('ends a scrolling page body with the default bottom inset', () => {
    const classes = classesOf(
      renderToStaticMarkup(
        <PageContent>
          <span>Content</span>
        </PageContent>,
      ),
    );

    expect(classes).toContain('pb-8');
    expect(classes).not.toContain('space-y-6');
  });

  it.each([
    ['tight', 'pb-4'],
    ['compact', 'pb-6'],
    ['default', 'pb-8'],
    ['spacious', 'pb-16'],
  ] as const)('keeps the %s bottom inset', (bottomInset, paddingClass) => {
    const classes = classesOf(
      renderToStaticMarkup(
        <PageContent bottomInset={bottomInset}>
          <span>Content</span>
        </PageContent>,
      ),
    );

    expect(classes).toContain(paddingClass);
    expect(classes.filter((token) => token.startsWith('pb-'))).toHaveLength(1);
  });

  it('stacks page sections 24px apart and keeps placement classes', () => {
    const classes = classesOf(
      renderToStaticMarkup(
        <PageContent stack className="shrink-0">
          <span>Content</span>
        </PageContent>,
      ),
    );

    expect(classes).toEqual(expect.arrayContaining(['space-y-6', 'shrink-0']));
  });
});
