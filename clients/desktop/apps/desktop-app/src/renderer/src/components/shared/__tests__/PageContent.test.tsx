import { renderToStaticMarkup } from 'react-dom/server';
import { PageContent } from '../PageContent';

describe('PageContent', () => {
  it('pairs with one centered page width and horizontal gutter', () => {
    const markup = renderToStaticMarkup(
      <PageContent>
        <span>Content</span>
      </PageContent>,
    );

    expect(markup).toContain('mx-auto w-full max-w-6xl px-8');
  });

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
