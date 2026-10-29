/** @jest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { DescriptionMarkdown } from '../DescriptionMarkdown';

function render(markdown: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(
    <DescriptionMarkdown dataTestId="share-description">
      {markdown}
    </DescriptionMarkdown>,
  );
  const root = host.querySelector<HTMLElement>(
    '[data-testid="share-description"]',
  );
  if (!root) throw new Error('description root not rendered');
  return root;
}

describe('DescriptionMarkdown', () => {
  it('honors single newlines typed in the authoring textarea', () => {
    const root = render('First line\nSecond line');
    expect(root.querySelectorAll('p')).toHaveLength(1);
    expect(root.querySelector('p br')).not.toBeNull();
    expect(root.textContent).toBe('First lineSecond line');
  });

  it('renders paragraphs and a numbered list', () => {
    const root = render(
      'Triage new issues every night.\n\n1. Reads the inbox\n2. Labels each issue\n3. Posts a summary',
    );
    expect(root.querySelectorAll('p')).toHaveLength(1);
    const items = root.querySelectorAll('ol > li');
    expect(Array.from(items, (item) => item.textContent)).toEqual([
      'Reads the inbox',
      'Labels each issue',
      'Posts a summary',
    ]);
  });

  it('demotes headings so they never compete with the page heading', () => {
    const root = render('# Big title\n\nBody');
    expect(root.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
    const heading = root.querySelector('[data-description-heading]');
    expect(heading?.tagName).toBe('P');
    expect(heading?.textContent).toBe('Big title');
  });

  it('renders image alt text instead of loading the image', () => {
    const root = render('![Tracking pixel](https://example.com/p.gif)');
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toBe('Tracking pixel');
  });

  it('drops unsafe link targets and keeps safe ones', () => {
    const root = render(
      '[bad](javascript:alert(1)) and [good](https://example.com)',
    );
    const anchors = Array.from(root.querySelectorAll('a'));
    const bad = anchors.find((anchor) => anchor.textContent === 'bad');
    const good = anchors.find((anchor) => anchor.textContent === 'good');
    expect(bad?.getAttribute('href') ?? null).toBeNull();
    expect(good?.getAttribute('href')).toBe('https://example.com');
  });

  it('marks author links as user-generated so public pages pass no link equity', () => {
    const root = render('See [the docs](https://example.com/docs).');
    const anchor = root.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://example.com/docs');
    expect(anchor?.getAttribute('rel')?.split(' ').sort()).toEqual(
      ['noopener', 'noreferrer', 'nofollow', 'ugc'].sort(),
    );
  });

  it('renders raw HTML as text', () => {
    const root = render('<script>alert(1)</script><b>bold</b>');
    expect(root.querySelector('script, b')).toBeNull();
    expect(root.textContent).toContain('<b>bold</b>');
  });

  it('applies the size variant and caller placement class', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <DescriptionMarkdown size="base" className="mt-2">
        Text
      </DescriptionMarkdown>,
    );
    const root = host.firstElementChild;
    expect(root?.className).toContain('prose-base');
    expect(root?.className).toContain('mt-2');
  });
});
