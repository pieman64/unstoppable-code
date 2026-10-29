import {
  isAllowedMainWindowFrameNavigation,
  type SubframeNavigationDetails,
} from '../subframe-navigation-guard';
import {
  mergeEnabledFeatures,
  pinIsolateSandboxedIframes,
} from '../chromium-feature-switches';

const allowRenderer = (url: string): boolean =>
  url.startsWith('about:') || url.startsWith('http://localhost:5173');

function details(
  url: string,
  frame: SubframeNavigationDetails['frame'],
  isMainFrame = false,
): SubframeNavigationDetails {
  return { url, isMainFrame, frame };
}

const appFrame = {
  origin: 'app-renderer://app',
  url: 'app-renderer://app/index.html',
  detached: false,
};
const opaqueFrame = { origin: 'null', url: 'about:srcdoc', detached: false };
const srcdocFrame = {
  origin: 'app-renderer://app',
  url: 'about:srcdoc',
  detached: false,
};

describe('main-window frame navigation guard', () => {
  it.each([
    ['main frame', details('https://example.com', appFrame, true), true],
    ['missing frame', details('about:srcdoc', null), false],
    [
      'detached frame',
      details('about:srcdoc', { ...appFrame, detached: true }),
      false,
    ],
    ['opaque frame loading srcdoc', details('about:srcdoc', opaqueFrame), true],
    [
      'opaque frame navigating to the dev server',
      details('http://localhost:5173/', opaqueFrame),
      false,
    ],
    ['opaque frame to about:blank', details('about:blank', opaqueFrame), false],
    [
      'opaque frame to a data URL',
      details('data:text/html,leak', opaqueFrame),
      false,
    ],
    [
      'opaque frame to a sink',
      details('http://127.0.0.1:9/?secret', opaqueFrame),
      false,
    ],
    [
      'HTML preview reloading its srcdoc',
      details('about:srcdoc', srcdocFrame),
      true,
    ],
    [
      'HTML preview link click',
      details('https://example.com/', srcdocFrame),
      false,
    ],
    ['app frame to about:blank', details('about:blank', appFrame), true],
    [
      'app frame to the dev server',
      details('http://localhost:5173/x', appFrame),
      true,
    ],
    ['app frame elsewhere', details('https://example.com/', appFrame), false],
  ])('%s', (_case, input, expected) => {
    expect(isAllowedMainWindowFrameNavigation(input, allowRenderer)).toBe(
      expected,
    );
  });
});

describe('enable-features merge', () => {
  it.each([
    ['', 'IsolateSandboxedIframes'],
    ['Foo', 'Foo,IsolateSandboxedIframes'],
    ['Foo, Bar', 'Foo,Bar,IsolateSandboxedIframes'],
    ['IsolateSandboxedIframes,Foo', 'IsolateSandboxedIframes,Foo'],
  ])('merges %j', (existing, merged) => {
    expect(mergeEnabledFeatures(existing, 'IsolateSandboxedIframes')).toBe(
      merged,
    );
  });

  it('appends the merged list over the existing switch value', () => {
    const appendSwitch = jest.fn();
    pinIsolateSandboxedIframes({
      getSwitchValue: () => 'Foo',
      appendSwitch,
    });
    expect(appendSwitch).toHaveBeenCalledWith(
      'enable-features',
      'Foo,IsolateSandboxedIframes',
    );
  });
});
