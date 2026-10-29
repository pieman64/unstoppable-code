import {
  isAllowedInAppBrowserUrl,
  isSafeExternalBrowserUrl,
  normalizeBrowserUrlInput,
  resolveAppLinkTarget,
  shouldOpenDevServerHitInApp,
} from '../browser/browser-url-policy';

describe('browser URL policy', () => {
  it('normalizes missing schemes to http', () => {
    expect(normalizeBrowserUrlInput('localhost:3000')).toBe(
      'http://localhost:3000',
    );
    expect(normalizeBrowserUrlInput('  127.0.0.1:5173/path  ')).toBe(
      'http://127.0.0.1:5173/path',
    );
  });

  it('restricts http and https URLs to loopback in-app', () => {
    expect(isAllowedInAppBrowserUrl('http://localhost:3000', true)).toBe(true);
    expect(isAllowedInAppBrowserUrl('https://127.0.0.1:3000', true)).toBe(true);
    expect(isAllowedInAppBrowserUrl('http://[::1]:3000', true)).toBe(true);
    expect(isAllowedInAppBrowserUrl('about:blank', true)).toBe(true);

    expect(isAllowedInAppBrowserUrl('https://example.com', true)).toBe(false);
    expect(isAllowedInAppBrowserUrl('', true)).toBe(false);
  });

  it('allows remote http and https URLs when local-only browsing is disabled', () => {
    expect(isAllowedInAppBrowserUrl('https://example.com', false)).toBe(true);
  });

  it('allows local file URLs in both local-only modes', () => {
    expect(isAllowedInAppBrowserUrl('file:///tmp/index.html', true)).toBe(true);
    expect(isAllowedInAppBrowserUrl('file:///tmp/index.html', false)).toBe(
      true,
    );
  });

  it('keeps local files out of the external browser surface', () => {
    expect(isSafeExternalBrowserUrl('file:///tmp/index.html')).toBe(false);
    expect(isSafeExternalBrowserUrl('/tmp/index.html')).toBe(false);
  });

  it('routes dev server hits by openTarget and loopback policy', () => {
    expect(
      shouldOpenDevServerHitInApp({
        url: 'http://localhost:3000',
        openTarget: 'in-app',
        localServersOnly: true,
      }),
    ).toBe(true);
    expect(
      shouldOpenDevServerHitInApp({
        url: 'http://localhost:3000',
        openTarget: 'external',
        localServersOnly: true,
      }),
    ).toBe(false);
    expect(
      shouldOpenDevServerHitInApp({
        url: 'https://example.com',
        openTarget: 'in-app',
        localServersOnly: true,
      }),
    ).toBe(false);
    expect(
      shouldOpenDevServerHitInApp({
        url: 'https://example.com',
        openTarget: 'in-app',
        localServersOnly: false,
      }),
    ).toBe(true);
  });

  it.each([
    {
      name: 'non-web protocols stay external',
      args: {
        url: 'mailto:hello@example.com',
        openAppLinksInBuiltInBrowser: true,
        localServersOnly: false,
        hasWorktreeContext: true,
      },
      expected: 'external',
    },
    {
      name: 'an disabled preference stays external',
      args: {
        url: 'https://example.com',
        openAppLinksInBuiltInBrowser: false,
        localServersOnly: false,
        hasWorktreeContext: true,
      },
      expected: 'external',
    },
    {
      name: 'missing worktree context stays external',
      args: {
        url: 'https://example.com',
        openAppLinksInBuiltInBrowser: true,
        localServersOnly: false,
        hasWorktreeContext: false,
      },
      expected: 'external',
    },
    {
      name: 'local-only conflicts are explicit',
      args: {
        url: 'https://example.com',
        openAppLinksInBuiltInBrowser: true,
        localServersOnly: true,
        hasWorktreeContext: true,
      },
      expected: 'external-blocked-by-local-only',
    },
    {
      name: 'loopback links route in-app under local-only',
      args: {
        url: 'http://localhost:3000',
        openAppLinksInBuiltInBrowser: true,
        localServersOnly: true,
        hasWorktreeContext: true,
      },
      expected: 'in-app',
    },
    {
      name: 'external web links route in-app when unrestricted',
      args: {
        url: 'https://example.com',
        openAppLinksInBuiltInBrowser: true,
        localServersOnly: false,
        hasWorktreeContext: true,
      },
      expected: 'in-app',
    },
  ])('$name', ({ args, expected }) => {
    expect(resolveAppLinkTarget(args)).toBe(expected);
  });
});
