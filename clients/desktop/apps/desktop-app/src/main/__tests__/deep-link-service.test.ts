import {
  extractDeepLinkUrlFromArgv,
  handleDeepLinkArgv,
  handleDeepLinkUrl,
  handleProtocolArgv,
  handleProtocolUrl,
  notifyDeepLinkStartupUnlocked,
  resetDeepLinkServiceForTests,
  setBillingReturnSender,
  setDeepLinkSender,
  setWebLinkSender,
} from '../deep-link/deep-link-service';
import {
  buildDesktopBillingDeepLink,
  type DesktopBillingDeepLink,
  type DesktopDeepLink,
} from '@canopy/protocol';

const SCHEME = 'unstoppable-code';
const ALIAS_SCHEME = 'canopy';
const SCHEMES = [SCHEME, ALIAS_SCHEME];
const UUID = '2f0c9a1e-4b3d-4f6a-8c2e-1d5b7a9e0c4f';
const SKILL_URL = `${SCHEME}://share/skills/${UUID}`;
const REMOTE_CONTROL_URL = `${SCHEME}://remote-control`;

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('extractDeepLinkUrlFromArgv', () => {
  it('finds the URL among Electron flags and dev script paths', () => {
    expect(
      extractDeepLinkUrlFromArgv(
        ['/path/to/electron', '.', '--inspect=9229', SKILL_URL],
        SCHEME,
      ),
    ).toBe(SKILL_URL);
  });

  it('returns the last URL when several are present', () => {
    const other = `${SCHEME}://share/pipelines/${UUID}`;
    expect(extractDeepLinkUrlFromArgv(['app', SKILL_URL, other], SCHEME)).toBe(
      other,
    );
  });

  it('returns null when no argument carries the scheme', () => {
    expect(
      extractDeepLinkUrlFromArgv(
        ['app', '--flag', 'https://share/skills/x', `notmyscheme://share/x`],
        SCHEME,
      ),
    ).toBeNull();
    expect(extractDeepLinkUrlFromArgv([], SCHEME)).toBeNull();
  });

  it('accepts any configured scheme and preserves argv last-wins behavior', () => {
    const aliasUrl = `${ALIAS_SCHEME}://share/skills/${UUID}`;
    expect(
      extractDeepLinkUrlFromArgv(['app', SKILL_URL, aliasUrl], SCHEMES),
    ).toBe(aliasUrl);
  });
});

describe('deep-link buffering and delivery', () => {
  let delivered: DesktopDeepLink[];

  beforeEach(() => {
    resetDeepLinkServiceForTests();
    delivered = [];
  });

  function armSender(): void {
    setDeepLinkSender((link) => {
      delivered.push(link);
      return true;
    });
  }

  it('buffers a cold-start link until startup unlock, then delivers once', () => {
    armSender();
    handleDeepLinkUrl(SKILL_URL, SCHEME);
    expect(delivered).toEqual([]);

    notifyDeepLinkStartupUnlocked();
    expect(delivered).toEqual([
      { entity: 'skill', externalId: UUID, intent: 'install' },
    ]);

    // Unlock is idempotent; the buffer only flushes once.
    notifyDeepLinkStartupUnlocked();
    expect(delivered).toHaveLength(1);
  });

  it('delivers immediately when a link arrives after unlock (second instance)', () => {
    armSender();
    notifyDeepLinkStartupUnlocked();
    handleDeepLinkArgv(['exe', SKILL_URL], SCHEME);
    expect(delivered).toEqual([
      { entity: 'skill', externalId: UUID, intent: 'install' },
    ]);
  });

  it('parses an alias scheme identically to the primary scheme', () => {
    armSender();
    notifyDeepLinkStartupUnlocked();
    handleDeepLinkArgv(
      ['exe', `${ALIAS_SCHEME}://share/skills/${UUID}`],
      SCHEMES,
    );
    expect(delivered).toEqual([
      { entity: 'skill', externalId: UUID, intent: 'install' },
    ]);
  });

  it('delivers a validated Remote Control destination link', () => {
    armSender();
    notifyDeepLinkStartupUnlocked();
    handleDeepLinkUrl(REMOTE_CONTROL_URL, SCHEME);
    expect(delivered).toEqual([{ destination: 'remote-control' }]);
  });

  it('delivers a validated Privacy settings destination link', () => {
    armSender();
    notifyDeepLinkStartupUnlocked();
    handleDeepLinkUrl(`${ALIAS_SCHEME}://settings/privacy`, SCHEMES);
    expect(delivered).toEqual([
      { destination: 'settings', section: 'privacy' },
    ]);
  });

  it('buffers an Organizations settings link until startup unlock (CAN-5111)', () => {
    armSender();
    handleDeepLinkUrl(`${SCHEME}://settings/organization`, SCHEMES);
    expect(delivered).toEqual([]);
    notifyDeepLinkStartupUnlocked();
    expect(delivered).toEqual([
      { destination: 'settings', section: 'organizations' },
    ]);
    // The link never carries an invite code; one that tries is dropped.
    handleDeepLinkUrl(
      `${ALIAS_SCHEME}://settings/organization?code=abc123`,
      SCHEMES,
    );
    expect(delivered).toHaveLength(1);
  });

  it('buffers a privacy opt-in intent until startup unlock and never treats malformed consent as bare settings', () => {
    armSender();
    const org = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    handleDeepLinkUrl(
      `${SCHEME}://settings/privacy?feature=leaderboards&org=${org}`,
      SCHEME,
    );
    expect(delivered).toEqual([]);
    notifyDeepLinkStartupUnlocked();
    expect(delivered).toEqual([
      {
        destination: 'settings',
        section: 'privacy',
        optIn: { feature: 'leaderboards', organizationId: org },
      },
    ]);
    handleDeepLinkUrl(
      `${SCHEME}://settings/privacy?feature=leaderboards`,
      SCHEME,
    );
    expect(delivered).toHaveLength(1);
  });

  it('keeps only the newest undelivered link (last wins)', () => {
    armSender();
    handleDeepLinkUrl(SKILL_URL, SCHEME);
    handleDeepLinkUrl(`${SCHEME}://share/pipelines/${UUID}`, SCHEME);
    notifyDeepLinkStartupUnlocked();
    expect(delivered).toEqual([
      { entity: 'pipeline', externalId: UUID, intent: 'install' },
    ]);
  });

  it('waits for the sender when unlock precedes wiring', () => {
    handleDeepLinkUrl(SKILL_URL, SCHEME);
    notifyDeepLinkStartupUnlocked();
    expect(delivered).toEqual([]);
    armSender();
    expect(delivered).toEqual([
      { entity: 'skill', externalId: UUID, intent: 'install' },
    ]);
  });

  it('keeps the link buffered when delivery fails (windowless macOS state)', () => {
    // Sender reports failure — e.g. `open-url` arrived after
    // window-all-closed left the app running with no window.
    let windowAvailable = false;
    setDeepLinkSender((link) => {
      if (!windowAvailable) return false;
      delivered.push(link);
      return true;
    });
    notifyDeepLinkStartupUnlocked();
    handleDeepLinkUrl(SKILL_URL, SCHEME);
    expect(delivered).toEqual([]);

    // Dock-icon reopen: a fresh renderer sends startup-unlocked again.
    windowAvailable = true;
    notifyDeepLinkStartupUnlocked();
    expect(delivered).toEqual([
      { entity: 'skill', externalId: UUID, intent: 'install' },
    ]);

    // Delivered exactly once; the buffer is clear.
    notifyDeepLinkStartupUnlocked();
    expect(delivered).toHaveLength(1);
  });

  it('silently drops invalid URLs, including mobile OAuth callbacks', () => {
    armSender();
    notifyDeepLinkStartupUnlocked();
    for (const url of [
      `${SCHEME}://auth?code=secret`,
      `${SCHEME}://share/skills/not-a-uuid`,
      `${SCHEME}://elsewhere/skills/${UUID}`,
      `${REMOTE_CONTROL_URL}/extra`,
      `${REMOTE_CONTROL_URL}?code=secret`,
      'garbage',
    ]) {
      handleDeepLinkUrl(url, SCHEME);
    }
    expect(delivered).toEqual([]);
  });

  it('drops argv without any deep link', () => {
    armSender();
    notifyDeepLinkStartupUnlocked();
    handleDeepLinkArgv(['exe', '--flag', 'positional'], SCHEME);
    expect(delivered).toEqual([]);
  });
});

/**
 * CAN-4028 — returning from browser checkout. The link is a refresh hint for
 * the renderer and nothing more, so what matters here is that only a
 * well-formed return is delivered, and that it never competes with the
 * navigation links for the single last-wins buffer.
 */
describe('billing return links', () => {
  const REQUEST_ID = 'req_4f6a8c2e-1d5b';
  let navigation: DesktopDeepLink[];
  let returns: DesktopBillingDeepLink[];

  beforeEach(() => {
    resetDeepLinkServiceForTests();
    navigation = [];
    returns = [];
    setDeepLinkSender((link) => {
      navigation.push(link);
      return true;
    });
  });

  function armBillingSender(): void {
    setBillingReturnSender((link) => {
      returns.push(link);
      return true;
    });
  }

  it('buffers a return until startup unlock, then delivers it once', () => {
    armBillingSender();
    handleProtocolUrl(
      buildDesktopBillingDeepLink(
        { requestId: REQUEST_ID, modelId: 'some-model', chatId: 'chat-1' },
        SCHEME,
      ),
      SCHEMES,
    );
    expect(returns).toEqual([]);

    notifyDeepLinkStartupUnlocked();
    expect(returns).toEqual([
      { requestId: REQUEST_ID, modelId: 'some-model', chatId: 'chat-1' },
    ]);
    // Never routed as navigation.
    expect(navigation).toEqual([]);

    notifyDeepLinkStartupUnlocked();
    expect(returns).toHaveLength(1);
  });

  it('accepts the alias scheme and argv delivery', () => {
    armBillingSender();
    notifyDeepLinkStartupUnlocked();
    handleProtocolArgv(
      [
        'exe',
        buildDesktopBillingDeepLink({ requestId: REQUEST_ID }, ALIAS_SCHEME),
      ],
      SCHEMES,
    );
    expect(returns).toEqual([{ requestId: REQUEST_ID }]);
  });

  it('keeps the return buffered when delivery fails, then retries', () => {
    let windowAvailable = false;
    setBillingReturnSender((link) => {
      if (!windowAvailable) return false;
      returns.push(link);
      return true;
    });
    notifyDeepLinkStartupUnlocked();
    handleDeepLinkUrl(
      buildDesktopBillingDeepLink({ requestId: REQUEST_ID }, SCHEME),
      SCHEME,
    );
    expect(returns).toEqual([]);

    windowAvailable = true;
    notifyDeepLinkStartupUnlocked();
    expect(returns).toEqual([{ requestId: REQUEST_ID }]);
  });

  it('does not evict a buffered navigation link, and is not evicted by one', () => {
    armBillingSender();
    handleDeepLinkUrl(SKILL_URL, SCHEME);
    handleDeepLinkUrl(
      buildDesktopBillingDeepLink({ requestId: REQUEST_ID }, SCHEME),
      SCHEME,
    );
    handleDeepLinkUrl(REMOTE_CONTROL_URL, SCHEME);

    notifyDeepLinkStartupUnlocked();
    // Navigation stays last-wins among navigation links only.
    expect(navigation).toEqual([{ destination: 'remote-control' }]);
    expect(returns).toEqual([{ requestId: REQUEST_ID }]);
  });

  it.each([
    ['a missing request id', `${SCHEME}://billing/unlocked`],
    [
      'a malformed request id',
      `${SCHEME}://billing/unlocked?requestId=not%20valid`,
    ],
    [
      'a repeated request id',
      `${SCHEME}://billing/unlocked?requestId=a&requestId=b`,
    ],
    [
      'an unknown parameter',
      `${SCHEME}://billing/unlocked?requestId=${REQUEST_ID}&access=unlocked`,
    ],
    [
      'a malformed model id',
      `${SCHEME}://billing/unlocked?requestId=${REQUEST_ID}&modelId=%20`,
    ],
    [
      'another billing path',
      `${SCHEME}://billing/paid?requestId=${REQUEST_ID}`,
    ],
    [
      'another scheme',
      `notmyscheme://billing/unlocked?requestId=${REQUEST_ID}`,
    ],
  ])('silently drops %s', (_label, url) => {
    armBillingSender();
    notifyDeepLinkStartupUnlocked();
    handleProtocolUrl(url, SCHEMES);
    expect(returns).toEqual([]);
    expect(navigation).toEqual([]);
  });
});

describe('HTTP(S) protocol buffering and delivery', () => {
  beforeEach(() => {
    resetDeepLinkServiceForTests();
  });

  it('buffers a cold-start web URL until asynchronous delivery succeeds', async () => {
    const send = jest.fn((): Promise<boolean> => Promise.resolve(true));
    setWebLinkSender(send);

    handleProtocolUrl('https://example.com/from-os', SCHEMES);
    expect(send).not.toHaveBeenCalled();

    notifyDeepLinkStartupUnlocked();
    await flushPromises();
    expect(send).toHaveBeenCalledWith('https://example.com/from-os');
  });

  it('extracts the last supported protocol URL from argv', async () => {
    const send = jest.fn((): Promise<boolean> => Promise.resolve(true));
    setWebLinkSender(send);
    notifyDeepLinkStartupUnlocked();

    handleProtocolArgv(
      [
        'app',
        SKILL_URL,
        'http://example.com/first',
        'https://example.com/last',
      ],
      SCHEMES,
    );

    await flushPromises();
    expect(send).toHaveBeenCalledWith('https://example.com/last');
  });

  it('retains a web URL after asynchronous delivery fails and retries it', async () => {
    let available = false;
    const send = jest.fn((): Promise<boolean> => Promise.resolve(available));
    setWebLinkSender(send);
    notifyDeepLinkStartupUnlocked();

    handleProtocolUrl('https://example.com/retry', SCHEMES);
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(1);

    available = true;
    notifyDeepLinkStartupUnlocked();
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith('https://example.com/retry');

    notifyDeepLinkStartupUnlocked();
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('organization project links', () => {
  it('delivers a scoped organization project after startup unlock', () => {
    resetDeepLinkServiceForTests();
    const send = jest.fn((): boolean => true);
    setDeepLinkSender(send);
    handleDeepLinkUrl(`${SCHEME}://org-project/${UUID}?org=${UUID}`, SCHEME);
    expect(send).not.toHaveBeenCalled();
    notifyDeepLinkStartupUnlocked();
    expect(send).toHaveBeenCalledWith({
      destination: 'org-project',
      projectId: UUID,
      organizationId: UUID,
    });
  });
});

it.each([
  `${SCHEME}://org-project/${UUID}`,
  `${SCHEME}://org-project/${UUID}?org=unknown`,
  `${SCHEME}://org-project/${UUID}?org=${UUID}&org=${UUID}`,
  `${SCHEME}://org-project/${UUID}?org=${UUID}&other=x`,
  `${SCHEME}://org-project/${UUID}/extra?org=${UUID}`,
  `${SCHEME}://user@org-project/${UUID}?org=${UUID}`,
])('rejects malformed organization project URL %s', (url) => {
  resetDeepLinkServiceForTests();
  const send = jest.fn((): boolean => true);
  setDeepLinkSender(send);
  notifyDeepLinkStartupUnlocked();
  handleDeepLinkUrl(url, SCHEME);
  expect(send).not.toHaveBeenCalled();
});
