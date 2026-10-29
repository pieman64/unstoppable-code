import { renderToStaticMarkup } from 'react-dom/server';
import { AdvancedDisclosure } from '../AdvancedDisclosure';

function toggleMarkup(html: string): string {
  const start = html.indexOf('<button');
  return html.slice(start, html.indexOf('</button>', start));
}

describe('AdvancedDisclosure', () => {
  it('labels the toggle Advanced with a chevron instead of a text glyph', () => {
    const toggle = toggleMarkup(
      renderToStaticMarkup(<AdvancedDisclosure>Body</AdvancedDisclosure>),
    );
    expect(toggle).toContain('Advanced');
    expect(toggle).toContain('<svg');
    expect(toggle).not.toContain('▸');
    expect(toggle).not.toContain('rotate-90');
  });

  it('takes a custom label and turns the chevron down when open', () => {
    const toggle = toggleMarkup(
      renderToStaticMarkup(
        <AdvancedDisclosure label="More details" defaultExpanded>
          Body
        </AdvancedDisclosure>,
      ),
    );
    expect(toggle).toContain('More details');
    expect(toggle).not.toContain('Advanced');
    expect(toggle).toContain('rotate-90');
  });
});
