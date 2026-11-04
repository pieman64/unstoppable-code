import { pathToFileURL } from 'node:url';
import {
  classifyBrowserBarInput,
  classifyInAppBrowserInput,
  isAllowedInAppBrowserUrl,
  isFileBrowserUrl,
  isSafeExternalBrowserUrl,
  normalizeBrowserUrlInput,
  sameBrowserUrl,
} from '../browser-url-policy';

describe('shared browser URL policy', () => {
  it('normalizes POSIX and Windows absolute paths as encoded file URLs', () => {
    expect(normalizeBrowserUrlInput('/Users/me/My Site/índex.html')).toBe(
      'file:///Users/me/My%20Site/%C3%ADndex.html',
    );
    expect(normalizeBrowserUrlInput('/Users/me/My%20Site/index.html')).toBe(
      'file:///Users/me/My%2520Site/index.html',
    );
    expect(normalizeBrowserUrlInput('/tmp/report#final.html')).toBe(
      'file:///tmp/report%23final.html',
    );
    expect(normalizeBrowserUrlInput('C:\\site\\My File.html')).toBe(
      'file:///C:/site/My%20File.html',
    );
    expect(normalizeBrowserUrlInput('C:\\')).toBe('file:///C:/');
    expect(normalizeBrowserUrlInput('C:/')).toBe('file:///C:/');
    expect(normalizeBrowserUrlInput('c:/site/index.html')).toBe(
      'file:///c:/site/index.html',
    );
    expect(normalizeBrowserUrlInput('C:/site\\nested/index.html')).toBe(
      'file:///C:/site/nested/index.html',
    );
  });

  it('matches node:pathToFileURL for portable absolute paths', () => {
    const posixPaths = [
      '/tmp/index.html',
      '/tmp/My Site/index.html',
      '/tmp/índex.html',
      '/tmp/report#final.html',
      '/tmp/query?.html',
      '/tmp/100%.html',
      '/tmp/%2e%2e/report.html',
      '/tmp/site/nested/',
      '/Volumes/Shared Disk/report.html',
    ];
    const windowsPaths = [
      'C:\\site\\index.html',
      'C:/site/index.html',
      'c:\\site\\index.html',
      'C:\\My Site\\index.html',
      'C:\\índex.html',
      'C:\\report#final.html',
      'C:\\query?.html',
      'C:\\100%.html',
      'C:\\report%20final.html',
      'C:\\site\\',
      'C:/site\\nested/index.html',
    ];

    for (const path of posixPaths) {
      expect(normalizeBrowserUrlInput(path)).toBe(pathToFileURL(path).href);
    }
    for (const path of windowsPaths) {
      expect(normalizeBrowserUrlInput(path)).toBe(
        pathToFileURL(path, { windows: true }).href,
      );
    }

    expect(normalizeBrowserUrlInput('C:relative')).toBe('http://C:relative');
    expect(normalizeBrowserUrlInput('C:\\')).toBe('file:///C:/');
  });

  it('normalizes UNC paths but rejects network hosts in-app', () => {
    const networkUrl = normalizeBrowserUrlInput(
      '\\\\server\\share\\My File.html',
    );
    expect(networkUrl).toBe('file://server/share/My%20File.html');
    for (const rawNetworkPath of [
      '\\\\server\\share\\My File.html',
      '\\\\localhost\\share\\My File.html',
    ]) {
      expect(isAllowedInAppBrowserUrl(rawNetworkPath, true)).toBe(false);
      expect(isAllowedInAppBrowserUrl(rawNetworkPath, false)).toBe(false);
      expect(classifyInAppBrowserInput(rawNetworkPath, false)).toEqual({
        kind: 'network-path',
      });
    }

    for (const alternateNetworkUrl of [
      'file:////server/share/My%20File.html',
      'file://///server/share/My%20File.html',
    ]) {
      expect(isAllowedInAppBrowserUrl(alternateNetworkUrl, true)).toBe(false);
      expect(isAllowedInAppBrowserUrl(alternateNetworkUrl, false)).toBe(false);
      expect(classifyInAppBrowserInput(alternateNetworkUrl, false)).toEqual({
        kind: 'network-path',
      });
    }
  });

  it('rejects Windows device paths before URL parsing', () => {
    expect(normalizeBrowserUrlInput('\\\\?\\C:\\site\\index.html')).toBe('');
    expect(normalizeBrowserUrlInput('\\\\.\\PhysicalDrive0')).toBe('');
  });

  it('does not expand home-relative paths', () => {
    expect(normalizeBrowserUrlInput('~/site/index.html')).toBe('');
    expect(normalizeBrowserUrlInput('~\\site\\index.html')).toBe('');
  });

  it('keeps protocol-relative and host inputs on the HTTP path', () => {
    expect(normalizeBrowserUrlInput('//example.com/x')).toBe(
      'http:////example.com/x',
    );
    expect(isAllowedInAppBrowserUrl('//example.com/x', false)).toBe(true);
    expect(normalizeBrowserUrlInput('localhost:3000')).toBe(
      'http://localhost:3000',
    );
    expect(normalizeBrowserUrlInput('C:relative')).toBe('http://C:relative');
    expect(isFileBrowserUrl('C:relative')).toBe(false);
  });

  it('allows hostless local files in both local-only modes', () => {
    for (const url of [
      'file:///tmp/index.html',
      'file://localhost/tmp/index.html',
      'file:///tmp/index.html?mode=preview',
      'file:///tmp/index.html#report',
    ]) {
      expect(isAllowedInAppBrowserUrl(url, true)).toBe(true);
      expect(isAllowedInAppBrowserUrl(url, false)).toBe(true);
    }
  });

  it('encodes raw spaces and non-ASCII characters in explicit file URLs', () => {
    expect(
      normalizeBrowserUrlInput('file:///Users/me/My Site/índex.html'),
    ).toBe('file:///Users/me/My%20Site/%C3%ADndex.html');
    expect(
      normalizeBrowserUrlInput('file:///Users/me/My%20Site/index.html'),
    ).toBe('file:///Users/me/My%20Site/index.html');
  });

  it('rejects empty file roots and every non-allowlisted scheme', () => {
    for (const url of ['file:', 'file://', 'file:///']) {
      expect(isAllowedInAppBrowserUrl(url, false)).toBe(false);
    }
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,hello',
      'blob:https://example.com/id',
      'filesystem:https://example.com/temporary/x',
      'about:srcdoc',
      'chrome://settings',
      'ftp://example.com',
      'ws://example.com',
    ]) {
      expect(isAllowedInAppBrowserUrl(url, true)).toBe(false);
      expect(isAllowedInAppBrowserUrl(url, false)).toBe(false);
    }
  });

  it('never treats local files or bare paths as safe external URLs', () => {
    expect(isSafeExternalBrowserUrl('https://example.com')).toBe(true);
    expect(isSafeExternalBrowserUrl('file:///tmp/index.html')).toBe(false);
    expect(isSafeExternalBrowserUrl('/tmp/index.html')).toBe(false);
    expect(isSafeExternalBrowserUrl('C:\\site\\index.html')).toBe(false);
  });

  it('recognizes file inputs and compares equivalent encoded URLs', () => {
    expect(isFileBrowserUrl('/tmp/My Site/index.html')).toBe(true);
    expect(isFileBrowserUrl('https://example.com')).toBe(false);
    expect(
      sameBrowserUrl(
        '/tmp/My Site/index.html',
        'file:///tmp/My%20Site/index.html',
      ),
    ).toBe(true);
  });

  it('classifies local-only and unsupported inputs', () => {
    expect(classifyInAppBrowserInput('https://example.com', true)).toEqual({
      kind: 'blocked-by-local-only',
    });
    expect(classifyInAppBrowserInput('javascript:alert(1)', false)).toEqual({
      kind: 'unsupported',
    });
    expect(classifyInAppBrowserInput('/tmp/index.html', true)).toEqual({
      kind: 'ok',
      url: 'file:///tmp/index.html',
    });
  });

  const GOOGLE = 'https://www.google.com/search?q=%s';

  it('searches for keywords instead of treating them as a host', () => {
    const searches: ReadonlyArray<readonly [string, string]> = [
      ['  react hooks  ', 'https://www.google.com/search?q=react+hooks'],
      ['canopy', 'https://www.google.com/search?q=canopy'],
      ['node.js tutorial', 'https://www.google.com/search?q=node.js+tutorial'],
      ['c++ & rust?', 'https://www.google.com/search?q=c%2B%2B+%26+rust%3F'],
      ['react: hooks', 'https://www.google.com/search?q=react%3A+hooks'],
      // A leading `?` searches even what reads as an address, as in Chrome.
      ['? example.com', 'https://www.google.com/search?q=example.com'],
    ];
    for (const [input, url] of searches) {
      expect(classifyBrowserBarInput(input, false, GOOGLE)).toEqual({
        kind: 'ok',
        url,
      });
    }
  });

  it('searches with the chosen engine template', () => {
    expect(
      classifyBrowserBarInput(
        'react hooks',
        false,
        'https://duckduckgo.com/?q=%s',
      ),
    ).toEqual({ kind: 'ok', url: 'https://duckduckgo.com/?q=react+hooks' });
    expect(
      classifyBrowserBarInput(
        'react hooks',
        false,
        'https://en.wikipedia.org/wiki/Special:Search/%s',
      ),
    ).toEqual({
      kind: 'ok',
      url: 'https://en.wikipedia.org/wiki/Special:Search/react%20hooks',
    });
  });

  it('keeps addresses and paths out of search', () => {
    const urls: ReadonlyArray<readonly [string, string]> = [
      ['example.com', 'http://example.com'],
      ['example.com/a b', 'http://example.com/a b'],
      ['localhost', 'http://localhost'],
      ['LOCALHOST/admin', 'http://LOCALHOST/admin'],
      ['web:3000', 'http://web:3000'],
      ['[::1]', 'http://[::1]'],
      // Local addresses keep navigating when their path has a space.
      ['localhost:3000/a b', 'http://localhost:3000/a b'],
      ['localhost/my page', 'http://localhost/my page'],
      ['web:3000/a b', 'http://web:3000/a b'],
      ['[::1]:8080/x y', 'http://[::1]:8080/x y'],
      ['https://example.com/?q=a b', 'https://example.com/?q=a b'],
      ['/tmp/My Site/index.html', 'file:///tmp/My%20Site/index.html'],
      ['about:blank', 'about:blank'],
    ];
    for (const [input, url] of urls) {
      expect(classifyBrowserBarInput(input, false, GOOGLE)).toEqual({
        kind: 'ok',
        url,
      });
    }
    expect(
      classifyBrowserBarInput('javascript:alert(1)', false, GOOGLE),
    ).toEqual({
      kind: 'unsupported',
    });
    expect(classifyBrowserBarInput('', false, GOOGLE)).toEqual({
      kind: 'unsupported',
    });
    expect(classifyBrowserBarInput('?', false, GOOGLE)).toEqual({
      kind: 'unsupported',
    });
  });

  it('never searches for agent or start-page input', () => {
    expect(classifyInAppBrowserInput('react hooks', false)).toEqual({
      kind: 'unsupported',
    });
    expect(classifyInAppBrowserInput('canopy', false)).toEqual({
      kind: 'ok',
      url: 'http://canopy',
    });
  });

  it('refuses a remote search while local-only browsing is on', () => {
    expect(classifyBrowserBarInput('react hooks', true, GOOGLE)).toEqual({
      kind: 'blocked-by-local-only',
    });
    expect(
      classifyBrowserBarInput(
        'react hooks',
        true,
        'http://localhost:8080/search?q=%s',
      ),
    ).toEqual({
      kind: 'ok',
      url: 'http://localhost:8080/search?q=react+hooks',
    });
  });
});
