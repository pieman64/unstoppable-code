const mockIsEnabled = jest.fn();
const mockOpenExternalGuarded = jest.fn();
const mockRequestCanopyCloudJson = jest.fn();
const mockGetCanopyCloudBaseUrl = jest.fn();
const mockGetCanopyCloudCredentials = jest.fn();
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled: typeof mockIsEnabled } => ({
    isEnabled: mockIsEnabled,
  }),
}));
jest.mock('../lib/open-external', () => ({
  openExternalGuarded: (...args: unknown[]): unknown =>
    mockOpenExternalGuarded(...args),
}));
jest.mock('../canopy-cloud/client', () => ({
  requestCanopyCloudJson: (...args: unknown[]): unknown =>
    mockRequestCanopyCloudJson(...args),
}));
jest.mock('../canopy-cloud/config', () => ({
  getCanopyCloudBaseUrl: (): unknown => mockGetCanopyCloudBaseUrl(),
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  getCanopyCloudCredentials: (): unknown => mockGetCanopyCloudCredentials(),
}));
import { BRAND } from '@canopy/brand/current';
import {
  isPaymentHandoffAvailable,
  mintAuthenticatedPortalUrl,
  openAuthenticatedPortalPage,
  openStrictAuthenticatedPortalPage,
} from '../canopy-cloud/authenticated-portal';

const BASE = 'https://cloud.example.test';
const MINT_PATH = `/api/v1/${BRAND.web.apiNamespace}/auth-link`;
const CONSUME = `${BASE}/api/v1/${BRAND.web.apiNamespace}/auth-link/consume?code=c`;

it('the legacy handler rejects an object before minting or opening', async () => {
  await expect(
    Reflect.apply(openAuthenticatedPortalPage, undefined, [
      {
        requireAuthentication: true,
        kind: 'signed-in',
        path: '/account',
        accountId: 'acct-1',
        webOrigin: BASE,
      },
    ]),
  ).rejects.toThrow('same-origin path');
  expect(mockRequestCanopyCloudJson).not.toHaveBeenCalled();
  expect(mockOpenExternalGuarded).not.toHaveBeenCalled();
});

beforeEach((): void => {
  jest.resetAllMocks();
  mockIsEnabled.mockReturnValue(true);
  mockGetCanopyCloudBaseUrl.mockReturnValue(BASE);
  mockOpenExternalGuarded.mockResolvedValue(undefined);
  mockRequestCanopyCloudJson.mockResolvedValue({ url: CONSUME });
  mockGetCanopyCloudCredentials.mockResolvedValue({
    baseUrl: BASE,
    apiKey: 'csk_current',
    account: { id: 'acct-1' },
  });
});

it('opens the page signed in through a single-use link the cloud mints', async (): Promise<void> => {
  expect(await openAuthenticatedPortalPage('/account/billing?plan=pro')).toBe(
    true,
  );
  expect(mockRequestCanopyCloudJson).toHaveBeenCalledWith(MINT_PATH, {
    method: 'POST',
    body: JSON.stringify({ redirectPath: '/account/billing?plan=pro' }),
  });
  expect(mockOpenExternalGuarded).toHaveBeenCalledWith(CONSUME);
});

it('mints the link with a bound credential and trusts only its cloud', async (): Promise<void> => {
  const credentialContext = {
    baseUrl: 'https://bound.example.test',
    apiKey: 'csk_bound',
  };
  const boundConsume =
    'https://bound.example.test/api/v1/x/auth-link/consume?code=c';
  mockRequestCanopyCloudJson.mockResolvedValue({ url: boundConsume });
  expect(
    await openAuthenticatedPortalPage(
      '/api/mcp-connections/authorize?state=s',
      {
        credentialContext,
      },
    ),
  ).toBe(true);
  expect(mockRequestCanopyCloudJson).toHaveBeenCalledWith(MINT_PATH, {
    method: 'POST',
    body: JSON.stringify({
      redirectPath: '/api/mcp-connections/authorize?state=s',
    }),
    credentialContext,
  });
  expect(mockOpenExternalGuarded).toHaveBeenCalledWith(boundConsume);

  // A link on the default cloud is not the bound cloud's: the page opens
  // signed out on the bound cloud instead.
  mockOpenExternalGuarded.mockClear();
  mockRequestCanopyCloudJson.mockResolvedValue({ url: CONSUME });
  await openAuthenticatedPortalPage('/api/mcp-connections/authorize?state=s', {
    credentialContext,
  });
  expect(mockOpenExternalGuarded).toHaveBeenCalledWith(
    'https://bound.example.test/api/mcp-connections/authorize?state=s',
  );
});

it.each<[string, () => void]>([
  [
    'the portal flag is off',
    (): void => {
      mockIsEnabled.mockReturnValue(false);
    },
  ],
  [
    'the mint fails',
    (): void => {
      mockRequestCanopyCloudJson.mockRejectedValue(new Error('offline'));
    },
  ],
  [
    'the link is on another origin',
    (): void => {
      mockRequestCanopyCloudJson.mockResolvedValue({
        url: 'https://evil.example/consume?code=c',
      });
    },
  ],
  [
    'the link is not http(s)',
    (): void => {
      mockRequestCanopyCloudJson.mockResolvedValue({
        url: 'javascript:alert(1)',
      });
    },
  ],
  [
    'the answer has no link',
    (): void => {
      mockRequestCanopyCloudJson.mockResolvedValue({});
    },
  ],
])(
  'opens the page signed out when %s',
  async (_name, arrange): Promise<void> => {
    arrange();
    expect(await openAuthenticatedPortalPage('/account')).toBe(true);
    expect(mockOpenExternalGuarded).toHaveBeenCalledTimes(1);
    expect(mockOpenExternalGuarded).toHaveBeenCalledWith(`${BASE}/account`);
  },
);

it('reports that nothing opened when even the signed-out page cannot open', async (): Promise<void> => {
  mockIsEnabled.mockReturnValue(false);
  mockGetCanopyCloudBaseUrl.mockImplementation((): never => {
    throw new Error('unconfigured');
  });
  expect(await openAuthenticatedPortalPage('/account')).toBe(false);
  expect(mockOpenExternalGuarded).not.toHaveBeenCalled();
});

it.each(['https://evil.example/account', '//evil.example', '/\\evil', ''])(
  'refuses a destination that is not a same-origin path: %p',
  async (path): Promise<void> => {
    await expect(openAuthenticatedPortalPage(path)).rejects.toThrow(
      'same-origin path',
    );
    expect(mockOpenExternalGuarded).not.toHaveBeenCalled();
  },
);

it('never consults the signed-in account for a legacy caller', async (): Promise<void> => {
  mockGetCanopyCloudCredentials.mockRejectedValue(new Error('signed out'));
  mockRequestCanopyCloudJson.mockRejectedValue(new Error('offline'));
  expect(await openAuthenticatedPortalPage('/account')).toBe(true);
  expect(mockOpenExternalGuarded).toHaveBeenCalledWith(`${BASE}/account`);
  expect(mockGetCanopyCloudCredentials).not.toHaveBeenCalled();
});

describe('strict mode', (): void => {
  const credentialContext: Parameters<
    typeof openStrictAuthenticatedPortalPage
  >[1] = {
    baseUrl: BASE,
    apiKey: 'csk_captured',
    account: {
      id: 'acct-1',
      name: 'Test Account',
      email: 'owner@example.test',
      role: 'ADMIN',
    },
  };
  const openLegacyStrictPortalPage = (
    path: string,
    credentialContext:
      | Parameters<typeof openStrictAuthenticatedPortalPage>[1]
      | { baseUrl: string; apiKey: string },
  ): ReturnType<typeof openAuthenticatedPortalPage> => {
    const options: Exclude<
      Parameters<typeof openAuthenticatedPortalPage>[1],
      undefined
    > = {};
    // Preserve legacy strict inputs that the current type cannot represent.
    Reflect.set(options, 'credentialContext', credentialContext);
    Reflect.set(options, 'requireAuthentication', true);
    return openAuthenticatedPortalPage(path, options);
  };
  const PATH =
    '/account/billing?paymentModal=payment-method&paymentRequestId=r1';

  it('opens the consume URL minted with the captured credential', async (): Promise<void> => {
    expect(await openLegacyStrictPortalPage(PATH, credentialContext)).toEqual({
      ok: true,
    });
    expect(mockRequestCanopyCloudJson).toHaveBeenCalledWith(MINT_PATH, {
      method: 'POST',
      body: JSON.stringify({ redirectPath: PATH }),
      credentialContext,
    });
    expect(mockOpenExternalGuarded).toHaveBeenCalledTimes(1);
    expect(mockOpenExternalGuarded).toHaveBeenCalledWith(CONSUME);
  });

  it('is the same as the standalone strict function', async (): Promise<void> => {
    expect(
      await openStrictAuthenticatedPortalPage(PATH, credentialContext),
    ).toEqual({ ok: true });
    expect(mockOpenExternalGuarded).toHaveBeenCalledWith(CONSUME);
  });

  it.each<[string, () => void, string]>([
    [
      'the portal flag is off',
      (): void => {
        mockIsEnabled.mockReturnValue(false);
      },
      'unavailable',
    ],
    [
      'the flag service is not ready',
      (): void => {
        mockIsEnabled.mockImplementation((): never => {
          throw new Error('not ready');
        });
      },
      'unavailable',
    ],
    [
      'the mint fails',
      (): void => {
        mockRequestCanopyCloudJson.mockRejectedValue(new Error('offline'));
      },
      'failed',
    ],
    [
      'the answer has no link',
      (): void => {
        mockRequestCanopyCloudJson.mockResolvedValue({});
      },
      'failed',
    ],
    [
      'the consume URL is on another origin',
      (): void => {
        mockRequestCanopyCloudJson.mockResolvedValue({
          url: 'https://evil.example/consume?code=c',
        });
      },
      'failed',
    ],
    [
      'the consume URL is not http(s)',
      (): void => {
        mockRequestCanopyCloudJson.mockResolvedValue({
          url: 'javascript:alert(1)',
        });
      },
      'failed',
    ],
    [
      'another account is signed in',
      (): void => {
        mockGetCanopyCloudCredentials.mockResolvedValue({
          baseUrl: BASE,
          apiKey: 'csk_other',
          account: { id: 'acct-2' },
        });
      },
      'identity_changed',
    ],
    [
      'the account signed out',
      (): void => {
        mockGetCanopyCloudCredentials.mockRejectedValue(
          new Error('api key required'),
        );
      },
      'identity_changed',
    ],
    [
      'the cloud changed',
      (): void => {
        mockGetCanopyCloudCredentials.mockResolvedValue({
          baseUrl: 'https://other-cloud.example.test',
          apiKey: 'csk_captured',
          account: { id: 'acct-1' },
        });
      },
      'identity_changed',
    ],
  ])(
    'reports a typed failure and opens nothing when %s',
    async (_name, arrange, reason): Promise<void> => {
      arrange();
      expect(await openLegacyStrictPortalPage(PATH, credentialContext)).toEqual(
        {
          ok: false,
          reason,
        },
      );
      expect(mockOpenExternalGuarded).not.toHaveBeenCalled();
    },
  );

  it('does not open the link when the account changes while the mint is in flight', async (): Promise<void> => {
    mockRequestCanopyCloudJson.mockImplementation((): Promise<unknown> => {
      mockGetCanopyCloudCredentials.mockResolvedValue({
        baseUrl: BASE,
        apiKey: 'csk_other',
        account: { id: 'acct-2' },
      });
      return Promise.resolve({ url: CONSUME });
    });
    expect(await openLegacyStrictPortalPage(PATH, credentialContext)).toEqual({
      ok: false,
      reason: 'identity_changed',
    });
    expect(mockOpenExternalGuarded).not.toHaveBeenCalled();
  });

  it('reports browser_failed when the browser does not open, without a signed-out retry', async (): Promise<void> => {
    mockOpenExternalGuarded.mockRejectedValue(new Error('no browser'));
    expect(await openLegacyStrictPortalPage(PATH, credentialContext)).toEqual({
      ok: false,
      reason: 'browser_failed',
    });
    expect(mockOpenExternalGuarded).toHaveBeenCalledTimes(1);
    expect(mockOpenExternalGuarded).toHaveBeenCalledWith(CONSUME);
  });

  it('is unavailable when the captured credential names no account', async (): Promise<void> => {
    const missingAccountContext = {
      baseUrl: BASE,
      apiKey: 'csk_captured',
    };
    // Deliberately omit account info to exercise the strict path's malformed-input handling.
    expect(
      await openLegacyStrictPortalPage(PATH, missingAccountContext),
    ).toEqual({ ok: false, reason: 'unavailable' });
    expect(mockRequestCanopyCloudJson).not.toHaveBeenCalled();
    expect(mockOpenExternalGuarded).not.toHaveBeenCalled();
  });

  it('still refuses a destination that is not a same-origin path', async (): Promise<void> => {
    await expect(
      openLegacyStrictPortalPage('//evil.example', credentialContext),
    ).rejects.toThrow('same-origin path');
    expect(mockOpenExternalGuarded).not.toHaveBeenCalled();
  });
});

describe('isPaymentHandoffAvailable', (): void => {
  it('is available when the flag is on and the account is signed in', async (): Promise<void> => {
    expect(await isPaymentHandoffAvailable('acct-1')).toBe(true);
  });

  it('is unavailable when the flag is off', async (): Promise<void> => {
    mockIsEnabled.mockReturnValue(false);
    expect(await isPaymentHandoffAvailable('acct-1')).toBe(false);
  });

  it('is unavailable for another account', async (): Promise<void> => {
    expect(await isPaymentHandoffAvailable('acct-2')).toBe(false);
  });

  it('is unavailable without captured credentials', async (): Promise<void> => {
    mockGetCanopyCloudCredentials.mockRejectedValue(
      new Error('api key required'),
    );
    expect(await isPaymentHandoffAvailable('acct-1')).toBe(false);
  });
});

describe('mintAuthenticatedPortalUrl', () => {
  it('returns a trusted one-shot URL without opening a browser', async () => {
    expect(await mintAuthenticatedPortalUrl('/account')).toBe(CONSUME);
    expect(mockOpenExternalGuarded).not.toHaveBeenCalled();
  });
  it.each([
    'disabled',
    'missing credential',
    'offline',
    'foreign',
    'scheme',
    'userinfo',
  ])('returns null for %s without opening', async (failure) => {
    if (failure === 'disabled') mockIsEnabled.mockReturnValue(false);
    if (failure === 'missing credential' || failure === 'offline')
      mockRequestCanopyCloudJson.mockRejectedValue(new Error(failure));
    if (failure === 'foreign')
      mockRequestCanopyCloudJson.mockResolvedValue({
        url: 'https://evil.test/consume',
      });
    if (failure === 'scheme')
      mockRequestCanopyCloudJson.mockResolvedValue({
        url: 'javascript:alert(1)',
      });
    if (failure === 'userinfo')
      mockRequestCanopyCloudJson.mockResolvedValue({
        url: 'https://user:secret@cloud.example.test/consume',
      });
    expect(await mintAuthenticatedPortalUrl('/account')).toBeNull();
    expect(mockOpenExternalGuarded).not.toHaveBeenCalled();
  });
  it('uses the captured cloud and credential', async () => {
    const context = { baseUrl: 'https://bound.test', apiKey: 'csk_bound' };
    mockRequestCanopyCloudJson.mockResolvedValue({
      url: 'https://bound.test/consume?code=one',
    });
    expect(await mintAuthenticatedPortalUrl('/account', context)).toBe(
      'https://bound.test/consume?code=one',
    );
    expect(mockRequestCanopyCloudJson).toHaveBeenCalledWith(MINT_PATH, {
      method: 'POST',
      body: JSON.stringify({ redirectPath: '/account' }),
      credentialContext: context,
    });
  });
  it('rejects unsafe destinations before requesting a link', async () => {
    await expect(mintAuthenticatedPortalUrl('//evil.test')).rejects.toThrow();
    expect(mockRequestCanopyCloudJson).not.toHaveBeenCalled();
  });
});
