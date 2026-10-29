/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { SuggestionRow } from '../SuggestionRow';

describe('SuggestionRow', () => {
  it('owns its hover chrome and reserves no trailing room by default', () => {
    const markup = renderToStaticMarkup(
      <SuggestionRow icon={null}>Import projects</SuggestionRow>,
    );
    expect(markup).toContain('hover:bg-subtle');
    expect(markup).not.toContain('group-hover:');
    expect(markup).not.toContain('pr-10');
  });

  it('shares its slot with a trailing control when asked', () => {
    // A dismiss button sits over the trailing edge: the label stops short of
    // it, and hovering it keeps the row highlighted through the group.
    const markup = renderToStaticMarkup(
      <SuggestionRow icon={null} trailingControl>
        Import projects
      </SuggestionRow>,
    );
    expect(markup).toContain('pr-10');
    expect(markup).toContain('group-hover:bg-subtle');
    expect(markup).not.toMatch(/(?<!group-)hover:bg-subtle/);
  });
});
