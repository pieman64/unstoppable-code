import {
  IN_APP_BROWSER_INVALID_URL_MESSAGE,
  IN_APP_BROWSER_LOCAL_ONLY_URL_MESSAGE,
  IN_APP_BROWSER_NETWORK_PATH_URL_MESSAGE,
  browserAddressSummary,
  browserLoadingLabel,
  classifyInAppBrowserInput,
  inAppBrowserInputMessage,
  isAllowedInAppBrowserUrl,
  isFileBrowserUrl,
  isSafeExternalBrowserUrl,
  normalizeInAppBrowserInput,
} from '../browserUrl';

describe('renderer browser URL policy', () => {
  it('allows any valid HTTP(S) URL when local-only browsing is disabled', () => {
    expect(isAllowedInAppBrowserUrl('https://example.com/docs', false)).toBe(
      true,
    );
    expect(normalizeInAppBrowserInput('example.com/docs', false)).toBe(
      'http://example.com/docs',
    );
  });

  it('restricts remote URLs when local-only browsing is enabled', () => {
    expect(isAllowedInAppBrowserUrl('http://localhost:3000', true)).toBe(true);
    expect(isAllowedInAppBrowserUrl('https://example.com', true)).toBe(false);
    expect(normalizeInAppBrowserInput('https://example.com', true)).toBeNull();
  });

  it('rejects non-HTTP(S), non-file URLs in both modes', () => {
    expect(isAllowedInAppBrowserUrl('javascript:alert(1)', true)).toBe(false);
    expect(isAllowedInAppBrowserUrl('javascript:alert(1)', false)).toBe(false);
    expect(isAllowedInAppBrowserUrl('data:text/html,<b>x', false)).toBe(false);
    // `filesystem:` is the near-miss a `startsWith('file')` check would let in.
    expect(
      isAllowedInAppBrowserUrl('filesystem:http://x/temporary/a', false),
    ).toBe(false);
  });
});

describe('renderer local file policy', () => {
  it('allows local file URLs in both local-only modes', () => {
    expect(isAllowedInAppBrowserUrl('file:///tmp/index.html', false)).toBe(
      true,
    );
    expect(isAllowedInAppBrowserUrl('file:///tmp/index.html', true)).toBe(true);
  });

  it('normalizes a bare absolute path into a file URL instead of a DNS lookup', () => {
    expect(normalizeInAppBrowserInput('/Users/me/site/index.html', true)).toBe(
      'file:///Users/me/site/index.html',
    );
    expect(normalizeInAppBrowserInput('C:\\site\\index.html', false)).toBe(
      'file:///C:/site/index.html',
    );
  });

  it('encodes spaces and non-ASCII characters in a typed path', () => {
    expect(
      normalizeInAppBrowserInput('/Users/me/My Site/índex.html', false),
    ).toBe('file:///Users/me/My%20Site/%C3%ADndex.html');
  });

  it('refuses network share paths in both modes', () => {
    expect(
      normalizeInAppBrowserInput('\\\\server\\share\\page.html', false),
    ).toBeNull();
    expect(
      isAllowedInAppBrowserUrl('file://server/share/page.html', false),
    ).toBe(false);
  });

  it('refuses a file URL with no path', () => {
    expect(isAllowedInAppBrowserUrl('file:///', false)).toBe(false);
    expect(isAllowedInAppBrowserUrl('file://', false)).toBe(false);
  });

  it('reports file inputs through isFileBrowserUrl', () => {
    expect(isFileBrowserUrl('/Users/me/site/index.html')).toBe(true);
    expect(isFileBrowserUrl('file:///tmp/index.html')).toBe(true);
    expect(isFileBrowserUrl('https://example.com')).toBe(false);
  });

  it('keeps file URLs out of the system browser', () => {
    expect(isSafeExternalBrowserUrl('file:///tmp/index.html')).toBe(false);
    expect(isSafeExternalBrowserUrl('/Users/me/site/index.html')).toBe(false);
    expect(isSafeExternalBrowserUrl('https://example.com')).toBe(true);
  });
});

describe('Browser bar input messages', () => {
  it('maps each refusal verdict to its own copy', () => {
    const remote = classifyInAppBrowserInput('https://example.com', true);
    expect(remote.kind).toBe('blocked-by-local-only');
    const share = classifyInAppBrowserInput('\\\\server\\share\\x.html', false);
    expect(share.kind).toBe('network-path');
    const nonsense = classifyInAppBrowserInput('javascript:alert(1)', false);
    expect(nonsense.kind).toBe('unsupported');

    if (remote.kind === 'ok' || share.kind === 'ok' || nonsense.kind === 'ok') {
      throw new Error('Expected refusal verdicts.');
    }
    expect(inAppBrowserInputMessage(remote)).toBe(
      IN_APP_BROWSER_LOCAL_ONLY_URL_MESSAGE,
    );
    expect(inAppBrowserInputMessage(share)).toBe(
      IN_APP_BROWSER_NETWORK_PATH_URL_MESSAGE,
    );
    expect(inAppBrowserInputMessage(nonsense)).toBe(
      IN_APP_BROWSER_INVALID_URL_MESSAGE,
    );
  });

  it('no longer claims local-only browsing blocks local files', () => {
    expect(IN_APP_BROWSER_LOCAL_ONLY_URL_MESSAGE).toContain('local file');
    expect(IN_APP_BROWSER_INVALID_URL_MESSAGE).toContain('local file');
  });
});

describe('browserLoadingLabel', () => {
  it('names the host of a web page', () => {
    expect(browserLoadingLabel('http://localhost:5173/app?x=1')).toBe(
      'Loading localhost:5173…',
    );
    expect(browserLoadingLabel('https://example.com/docs')).toBe(
      'Loading example.com…',
    );
  });

  it('names the file of a local page', () => {
    expect(browserLoadingLabel('file:///Users/me/site/My%20Page.html')).toBe(
      'Loading My Page.html…',
    );
  });

  it('says the Browser is opening when there is no URL yet', () => {
    expect(browserLoadingLabel('')).toBe('Opening Browser…');
    expect(browserLoadingLabel('about:blank')).toBe('Opening Browser…');
  });

  it('falls back to the raw value for unparseable input', () => {
    expect(browserLoadingLabel('localhost:3000')).toBe(
      'Loading localhost:3000…',
    );
  });
});

describe('browserAddressSummary', () => {
  it('names the host for web pages, ports included', () => {
    expect(
      browserAddressSummary('http://localhost:3000/settings/profile'),
    ).toBe('localhost:3000');
    expect(browserAddressSummary('https://daniil.cc/?q=1#top')).toBe(
      'daniil.cc',
    );
  });

  it('names the file for local pages', () => {
    expect(browserAddressSummary('file:///Users/me/My%20Report.html')).toBe(
      'My Report.html',
    );
  });

  it('is empty for a blank tab, so the placeholder shows', () => {
    expect(browserAddressSummary('')).toBe('');
    expect(browserAddressSummary('about:blank')).toBe('');
  });

  it('keeps anything it cannot parse as typed', () => {
    expect(browserAddressSummary('not a url')).toBe('not a url');
  });
});
