import {
  BUILT_IN_BROWSER_SEARCH_ENGINES,
  browserSearchUrlTemplateError,
  buildBrowserSearchUrl,
  normalizeCustomBrowserSearchEngines,
  resolveBrowserSearchEngine,
} from '../browser-search-engines';

describe('browser search engines', () => {
  it('replaces every %s with the encoded words', () => {
    expect(
      buildBrowserSearchUrl('https://example.com/search?q=%s&r=%s', 'a b&c'),
    ).toBe('https://example.com/search?q=a+b%26c&r=a+b%26c');
    expect(buildBrowserSearchUrl('https://example.com/s/%s?x=1', 'a b')).toBe(
      'https://example.com/s/a%20b?x=1',
    );
  });

  it('accepts only http(s) templates with %s', () => {
    expect(
      browserSearchUrlTemplateError('https://example.com/?q=%s'),
    ).toBeNull();
    expect(
      browserSearchUrlTemplateError('http://localhost:8080/search?q=%s'),
    ).toBeNull();
    expect(browserSearchUrlTemplateError('https://example.com/?q=')).toBe(
      'Include %s where the search words go.',
    );
    for (const template of [
      'javascript:%s',
      'example.com/?q=%s',
      'file:///%s',
    ]) {
      expect(browserSearchUrlTemplateError(template)).toMatch(
        /^Enter an http or https URL/,
      );
    }
  });

  it('falls back to Google for a missing or deleted engine', () => {
    const wiki = {
      id: 'custom-wiki',
      name: 'Wikipedia',
      urlTemplate: 'https://en.wikipedia.org/w/index.php?search=%s',
    };
    expect(resolveBrowserSearchEngine('custom-wiki', [wiki])).toBe(wiki);
    expect(resolveBrowserSearchEngine('bing', [])).toBe(
      BUILT_IN_BROWSER_SEARCH_ENGINES.find((engine) => engine.id === 'bing'),
    );
    expect(resolveBrowserSearchEngine('custom-gone', []).name).toBe('Google');
    expect(resolveBrowserSearchEngine(undefined, []).name).toBe('Google');
  });

  it('drops stored engines that cannot be used', () => {
    expect(
      normalizeCustomBrowserSearchEngines([
        {
          id: ' custom-a ',
          name: ' A ',
          urlTemplate: ' https://a.test/?q=%s ',
        },
        { id: 'custom-a', name: 'Dup', urlTemplate: 'https://b.test/?q=%s' },
        { id: 'google', name: 'Shadow', urlTemplate: 'https://c.test/?q=%s' },
        { id: 'custom-b', name: '', urlTemplate: 'https://d.test/?q=%s' },
        { id: 'custom-c', name: 'C', urlTemplate: 'javascript:%s' },
        { id: 'custom-d', name: 'D' },
        'nope',
      ]),
    ).toEqual([
      { id: 'custom-a', name: 'A', urlTemplate: 'https://a.test/?q=%s' },
    ]);
    expect(normalizeCustomBrowserSearchEngines(undefined)).toEqual([]);
  });
});
