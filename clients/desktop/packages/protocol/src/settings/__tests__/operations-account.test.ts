import {
  ACCOUNT_SETTINGS_OPERATIONS,
  type AccountSettingsOperationName,
} from '../operations-account';
import {
  DEFAULT_SETTINGS_MAX_INPUT_BYTES,
  settingsAcknowledgementSchema,
  type AnySettingsOperation,
  type SettingsOperationRequest,
} from '../operation-definition';

const ISO = '2026-10-01T12:00:00.000Z';

const BACKTEST = {
  id: 'bt_1',
  status: 'succeeded',
  mode: 'sample',
  rangeStartIso: ISO,
  rangeEndIso: ISO,
  progress: { replayedTurnCount: 1, plannedTurnCount: 1 },
  result: null,
};

const DIGEST_DETAIL = {
  externalId: 'dg_1',
  subjectType: 'USER',
  cadence: 'WEEKLY',
  periodStart: ISO,
  periodEnd: ISO,
  headline: 'A week',
  executiveSummaryMarkdown: null,
  bodyMarkdown: '# Body',
  metrics: {},
  variant: 'FULL',
  sharingEnabled: true,
  shareSlug: 'slug',
  sharePath: '/share/digests/slug',
};

const GITHUB_CONNECTION = {
  state: 'ACTIVE',
  githubLogin: 'octo',
  verifiedAt: ISO,
  readyForProjects: true,
  targets: [
    {
      id: 'tgt_1',
      installationId: '42',
      accountLogin: 'octo',
      accountType: 'User',
      repositorySelection: 'all',
      state: 'ACTIVE',
    },
  ],
};

const API_KEY = {
  id: 'key_1',
  name: 'Laptop',
  source: 'MANUAL',
  createdIp: null,
  createdAt: ISO,
  lastUsedAt: null,
};

const PUBLIC_PROFILE = {
  settings: {
    username: 'octo',
    enabled: true,
    bio: null,
    links: [{ platform: 'github', url: 'https://github.com/octo' }],
    showCost: false,
    showHeatmap: true,
  },
};

const DIGEST_PREFERENCES = {
  daily: false,
  weekly: true,
  monthly: false,
  weeklyAnchorDay: 1,
  monthlyAnchorDay: 1,
};

const PUBLISHABLE = {
  id: 'src_1',
  title: 'Skill',
  updatedAt: ISO,
  published: false,
  publishedAt: null,
  publishedStale: false,
};

const CREDITS_SUMMARY = {
  balanceCredits: 10,
  balanceUsd: 6,
  split: { dripCredits: '1', allotmentCredits: '2', purchasedCredits: '3' },
  allotmentTotalCredits: 100,
  dailyDripCapCredits: 5,
  dailyDrip: { enabled: true, capCredits: 5 },
  nextRefillAt: null,
  nextAllotmentAt: null,
  autoTopUp: {
    enabled: false,
    amountUsd: null,
    thresholdCredits: null,
    maxMonthlyUsd: null,
    disabledReason: null,
  },
  monthlySpentUsd: 0,
  usedThisCycleCredits: 0,
  usagePeriodStart: ISO,
  usagePeriodEnd: null,
  usagePeriodKind: 'calendar-month',
  monthlyResetAt: ISO,
  activeSource: 'canopy',
  udLinked: false,
};

interface Fixture {
  /** A valid caller input. */
  input: unknown;
  /** A realistic server response the result schema accepts. */
  result: unknown;
  /** A malformed server response the result schema rejects. */
  malformed?: unknown;
}

const FIXTURES: Record<AccountSettingsOperationName, Fixture> = {
  'account.details.update': {
    input: { name: 'Ada' },
    result: { name: 'Ada', image: null },
  },
  'account.avatar.upload': {
    input: { mimeType: 'image/png', size: 1024 },
    result: { image: 'https://cdn.example/avatar.png' },
  },
  'account.avatar.remove': {
    input: {},
    result: { name: 'Ada', image: null },
  },
  'account.profile.read': { input: {}, result: PUBLIC_PROFILE },
  'account.profile.update': {
    input: { bio: 'Hi', links: [{ platform: 'x', url: 'https://x.com/a' }] },
    result: PUBLIC_PROFILE,
    malformed: { settings: { username: 7 } },
  },
  'account.profile.usernameAvailability': {
    input: { username: 'octo' },
    result: { available: false, reason: 'taken' },
    malformed: { available: false, reason: 'nope' },
  },
  'account.profile.artifacts.list': {
    input: {},
    result: { skills: [PUBLISHABLE], runs: [], plans: [], pipelines: [] },
  },
  'account.profile.artifacts.published': {
    input: {},
    result: {
      items: [
        {
          kind: 'skills',
          id: 'src_1',
          title: 'Skill',
          publishedAt: ISO,
          publishedStale: false,
        },
      ],
    },
  },
  'account.profile.artifacts.search': {
    input: { kind: 'runs', query: 'deploy' },
    result: { items: [PUBLISHABLE] },
  },
  'account.profile.artifacts.preview': {
    input: { kind: 'plans', sourceId: 'src/1' },
    result: { preview: { kind: 'plan', id: 'src_1', title: 'Plan' } },
  },
  'account.profile.artifacts.publish': {
    input: { kind: 'skills', sourceId: 'src_1' },
    result: { artifact: { kind: 'skill', id: 'src_1' } },
  },
  'account.profile.artifacts.unpublish': {
    input: { kind: 'pipelines', sourceId: 'src_1' },
    result: null,
    malformed: 'nope',
  },
  'account.profile.artifacts.revokeSkillShare': {
    input: { sourceId: 'src_1' },
    result: null,
    malformed: 'nope',
  },
  'account.profile.projects.read': {
    input: {},
    result: {
      projects: [
        { id: 'p1', name: 'App', kind: 'CODE', updatedAt: ISO, online: true },
      ],
    },
    malformed: { projects: [{ id: 'p1', kind: 'OTHER' }] },
  },
  'account.profile.projects.remove': {
    input: {},
    result: { catalogGeneration: 3 },
  },
  'account.profile.routingBacktest.lookup': {
    input: { startIso: ISO, endIso: ISO },
    result: {
      backtest: null,
      estimate: null,
      unavailableReason: 'no_eligible_turns',
    },
  },
  'account.profile.routingBacktest.create': {
    input: { startIso: ISO, endIso: ISO, mode: 'full' },
    result: { backtest: BACKTEST, cached: false },
  },
  'account.profile.routingBacktest.read': {
    input: { backtestId: 'bt_1' },
    result: { backtest: BACKTEST },
  },
  'account.notifications.digestPreferences.read': {
    input: {},
    result: DIGEST_PREFERENCES,
  },
  'account.notifications.digestPreferences.update': {
    input: { daily: true, weekly: true, monthly: false, weeklyAnchorDay: 5 },
    result: DIGEST_PREFERENCES,
  },
  'account.notifications.push.read': {
    input: {},
    result: { pushEnabled: true },
  },
  'account.notifications.push.update': {
    input: { pushEnabled: false },
    result: { pushEnabled: false },
  },
  'account.digests.list': {
    input: {},
    result: [
      {
        externalId: 'dg_1',
        cadence: 'WEEKLY',
        periodStart: ISO,
        periodEnd: ISO,
        headline: null,
        variant: 'FULL',
        status: 'READY',
        billedCredits: null,
        createdAt: ISO,
      },
    ],
  },
  'account.digests.read': {
    input: { digestId: 'dg_1' },
    result: DIGEST_DETAIL,
  },
  'account.digests.request': {
    input: { startDate: '2026-10-01', endDate: '2026-10-07' },
    result: { status: 'enqueued', digestExternalId: 'dg_2' },
  },
  'account.digests.share.update': {
    input: { digestId: 'dg_1', action: 'set-sharing', sharingEnabled: false },
    result: DIGEST_DETAIL,
  },
  'account.digests.profileFeature.set': {
    input: { digestId: 'dg_1', organizationId: 'org_1', featured: true },
    result: { organizationId: 'org_1', featured: true },
  },
  'account.github.connection.read': { input: {}, result: GITHUB_CONNECTION },
  'account.github.connection.verify': { input: {}, result: GITHUB_CONNECTION },
  'account.github.connection.installLink': {
    input: { returnTo: '/account/integrations', intent: 'install' },
    result: {
      connection: GITHUB_CONNECTION,
      next: 'install',
      installUrl: 'https://github.com/apps/canopy/installations/new',
    },
    malformed: {
      connection: GITHUB_CONNECTION,
      next: 'install',
      installUrl: 'https://evil.example/install',
    },
  },
  'account.github.connection.disconnect': {
    input: {},
    result: {
      ...GITHUB_CONNECTION,
      state: 'DISCONNECTED',
      readyForProjects: false,
      targets: [],
    },
  },
  'account.apiKeys.list': { input: {}, result: [API_KEY] },
  'account.apiKeys.create': {
    input: { name: 'Laptop' },
    result: { userApiKey: API_KEY, token: 'csk_secret' },
  },
  'account.apiKeys.revoke': {
    input: { apiKeyId: 'key_1' },
    result: null,
    malformed: 'nope',
  },
  'account.security.authSources': {
    input: {},
    result: {
      user: { name: 'Ada', email: 'ada@example.com', twoFactorEnabled: false },
      sources: [
        {
          providerId: 'credential',
          accountId: 'acc_1',
          label: 'Email and password',
          linkedAt: ISO,
          canUnlink: false,
        },
      ],
    },
  },
  'account.security.unlinkAuthSource': {
    input: { providerId: 'google', accountId: 'acc_2' },
    result: { ok: true },
  },
  'account.security.setPassword': {
    input: { newPassword: 'correct horse battery' },
    result: { ok: true },
  },
  'account.security.changePassword': {
    input: { currentPassword: 'old password!', newPassword: 'new password!' },
    result: { token: null, user: { id: 'u1' } },
  },
  'account.security.linkSocial': {
    input: {
      provider: 'github',
      callbackURL: '/account/security',
      errorCallbackURL: '/account/security?error=link',
    },
    result: { url: 'https://github.com/login/oauth/authorize', redirect: true },
  },
  'account.security.twoFactor.enable': {
    input: { password: 'secret password', issuer: 'Canopy' },
    result: { totpURI: 'otpauth://totp/Canopy:ada', backupCodes: ['a', 'b'] },
  },
  'account.security.twoFactor.verify': {
    input: { code: ' 123456 ' },
    result: { ok: true },
    malformed: { ok: false },
  },
  'account.security.twoFactor.clearSession': {
    input: {},
    result: null,
    malformed: 'nope',
  },
  'account.security.twoFactor.disable': {
    input: {},
    result: { status: true },
  },
  'account.security.twoFactor.backupCodes': {
    input: { password: 'secret password' },
    result: { status: true, backupCodes: ['c'] },
  },
  'account.billing.summary': {
    input: {},
    result: {
      plan: null,
      status: null,
      trial: null,
      nextBillingDate: null,
      nextBillingAmountUsd: null,
      seatCount: null,
      paymentMethod: null,
      walletBalanceUsd: 0,
      capabilities: [],
      coverageNotes: [],
    },
    malformed: { plan: null, status: 'UNKNOWN' },
  },
  'account.billing.charges': {
    input: { limit: 20, cursor: 'c1' },
    result: { charges: [], nextCursor: null },
  },
  'account.billing.invoices': {
    input: {},
    result: {
      invoices: [
        {
          id: '2026-10-01',
          number: 'INV-20261001',
          issuedAt: ISO,
          periodStart: ISO,
          periodEnd: ISO,
          currency: 'usd',
          status: 'PAID',
          isCurrent: false,
          totalUsd: 20,
          amountPaidUsd: 20,
          lineItemCount: 1,
          cardBrand: 'visa',
          cardLast4: '4242',
        },
      ],
      nextCursor: null,
    },
  },
  'account.billing.credits': {
    input: {},
    result: CREDITS_SUMMARY,
    malformed: { ...CREDITS_SUMMARY, usagePeriodKind: 'weekly' },
  },
  'account.billing.creditsLedger': {
    input: { cursor: null },
    result: {
      email: 'ada@example.com',
      entries: [{ id: 'l1', createdAt: ISO, credits: -2 }],
    },
  },
  'account.billing.dailyFreeCredits.update': {
    input: { enabled: true },
    result: {
      enabled: true,
      decidedAt: ISO,
      capCredits: 5,
      balanceCredits: null,
      granted: 5,
    },
  },
};

const ENTRIES: ReadonlyArray<
  [AccountSettingsOperationName, AnySettingsOperation]
> = Object.entries(ACCOUNT_SETTINGS_OPERATIONS).flatMap(([name, operation]) =>
  isAccountName(name) ? [[name, operation]] : [],
);

function isAccountName(name: string): name is AccountSettingsOperationName {
  return Object.prototype.hasOwnProperty.call(FIXTURES, name);
}

function parsedInput(name: AccountSettingsOperationName): unknown {
  return ACCOUNT_SETTINGS_OPERATIONS[name].input.parse(FIXTURES[name].input);
}

/** Every request an entry can emit for its fixture input. */
function requestsFor(
  name: AccountSettingsOperationName,
): SettingsOperationRequest[] {
  const operation: AnySettingsOperation = ACCOUNT_SETTINGS_OPERATIONS[name];
  const input = parsedInput(name);
  const requests = [operation.request(input)];
  if (operation.upload) {
    requests.push(operation.upload.sign(input));
    requests.push(
      operation.upload.commit(input, {
        uploadUrl: 'https://storage.example/signed',
        filePath: 'avatars/u1/file.png',
      }),
    );
  }
  return requests;
}

const FINANCIAL_PATHS: readonly RegExp[] = [
  /setup-intent/,
  /payment-method/,
  /\/top-up/,
  /\/charge/,
  /auto-top-up/,
  /\/subscription\//,
  /\/subscription$/,
  /seat-quote/,
  /planKey=/,
];

describe('ACCOUNT_SETTINGS_OPERATIONS', () => {
  it('has a fixture for every entry and only dotted lowercase account names', () => {
    expect(ENTRIES).toHaveLength(Object.keys(FIXTURES).length);
    for (const [name] of ENTRIES)
      expect(name).toMatch(/^account(\.[a-z][A-Za-z]*)+$/);
  });

  it.each(ENTRIES)('%s builds a host-free /api path', (name) => {
    for (const request of requestsFor(name)) {
      expect(request.path.startsWith('/api/')).toBe(true);
      expect(request.path).not.toMatch(/^\/\//);
      expect(request.path).not.toMatch(/https?:/);
      expect(request.path).not.toMatch(/\s/);
    }
  });

  it.each(ENTRIES)('%s is not a financial route', (name) => {
    for (const request of requestsFor(name))
      for (const pattern of FINANCIAL_PATHS)
        expect(request.path).not.toMatch(pattern);
  });

  it.each(ENTRIES)('%s rejects unknown input keys', (name) => {
    const operation: AnySettingsOperation = ACCOUNT_SETTINGS_OPERATIONS[name];
    const input = FIXTURES[name].input;
    const base = typeof input === 'object' && input !== null ? input : {};
    expect(operation.input.safeParse({ ...base, unexpected: 1 }).success).toBe(
      false,
    );
  });

  it.each(ENTRIES)('%s accepts a realistic response', (name) => {
    const operation: AnySettingsOperation = ACCOUNT_SETTINGS_OPERATIONS[name];
    expect(operation.result.safeParse(FIXTURES[name].result).success).toBe(
      true,
    );
  });

  it.each(ENTRIES)('%s rejects a malformed response', (name) => {
    const operation: AnySettingsOperation = ACCOUNT_SETTINGS_OPERATIONS[name];
    const fixture = FIXTURES[name];
    const malformed =
      fixture.malformed ??
      (operation.result === settingsAcknowledgementSchema ? 'nope' : 42);
    expect(operation.result.safeParse(malformed).success).toBe(false);
    if (operation.result !== settingsAcknowledgementSchema)
      expect(operation.result.safeParse({}).success).toBe(false);
  });

  it('refuses dot-segment ids, which encoding leaves as path navigation', () => {
    const revoke = ACCOUNT_SETTINGS_OPERATIONS['account.apiKeys.revoke'];
    for (const apiKeyId of ['.', '..'])
      expect(revoke.input.safeParse({ apiKeyId }).success).toBe(false);
    expect(revoke.input.safeParse({ apiKeyId: '..x' }).success).toBe(true);
  });

  it('encodes every path segment taken from input', () => {
    const preview = ACCOUNT_SETTINGS_OPERATIONS[
      'account.profile.artifacts.preview'
    ].request({ kind: 'plans', sourceId: 'a/b?c' });
    expect(preview.path).toBe(
      '/api/account/public-profile/artifacts/plans/a%2Fb%3Fc',
    );
    const feature = ACCOUNT_SETTINGS_OPERATIONS[
      'account.digests.profileFeature.set'
    ].request({ digestId: '../x', organizationId: 'o/1', featured: false });
    expect(feature).toEqual({
      method: 'DELETE',
      path: '/api/account/digests/..%2Fx/profile-features/o%2F1',
    });
    const unlink = ACCOUNT_SETTINGS_OPERATIONS[
      'account.security.unlinkAuthSource'
    ].request({ providerId: 'a/b', accountId: 'acc' });
    expect(unlink.path).toBe('/api/account/auth-sources/a%2Fb');
    const revoke = ACCOUNT_SETTINGS_OPERATIONS[
      'account.apiKeys.revoke'
    ].request({ apiKeyId: '1#2' });
    expect(revoke.path).toBe('/api/account/api-keys/1%232');
  });

  it('mirrors the existing web calls exactly', () => {
    expect(
      ACCOUNT_SETTINGS_OPERATIONS['account.billing.charges'].request({
        limit: 20,
        cursor: 'c 1',
      }),
    ).toEqual({
      method: 'GET',
      path: '/api/account/billing/history?limit=20&cursor=c+1',
    });
    expect(
      ACCOUNT_SETTINGS_OPERATIONS['account.profile.artifacts.search'].request({
        kind: 'runs',
        query: 'a&b',
      }),
    ).toEqual({
      method: 'GET',
      path: '/api/account/public-profile/artifacts?kind=runs&q=a%26b',
    });
    expect(
      ACCOUNT_SETTINGS_OPERATIONS[
        'account.profile.artifacts.revokeSkillShare'
      ].request({ sourceId: 's1' }),
    ).toEqual({
      method: 'DELETE',
      path: '/api/account/public-profile/artifacts/skills/s1?share=revoke',
    });
    expect(
      ACCOUNT_SETTINGS_OPERATIONS['account.security.twoFactor.verify'].request({
        code: ' 123456 ',
      }),
    ).toEqual({
      method: 'POST',
      path: '/api/account/two-factor/session',
      body: { code: '123456', purpose: 'setup' },
    });
    expect(
      ACCOUNT_SETTINGS_OPERATIONS['account.avatar.remove'].request({}),
    ).toEqual({
      method: 'PATCH',
      path: '/api/account/profile',
      body: { image: null },
    });
  });

  it('sends Better Auth bodies exactly as authClient does', () => {
    const operations = ACCOUNT_SETTINGS_OPERATIONS;
    expect(
      operations['account.security.twoFactor.enable'].request({
        issuer: 'Canopy',
      }),
    ).toEqual({
      method: 'POST',
      path: '/api/auth/two-factor/enable',
      body: { issuer: 'Canopy' },
    });
    expect(
      operations['account.security.twoFactor.disable'].request({}),
    ).toEqual({
      method: 'POST',
      path: '/api/auth/two-factor/disable',
      body: {},
    });
    expect(
      operations['account.security.twoFactor.backupCodes'].request({
        password: 'pw',
      }),
    ).toEqual({
      method: 'POST',
      path: '/api/auth/two-factor/generate-backup-codes',
      body: { password: 'pw' },
    });
    expect(
      operations['account.security.changePassword'].request({
        currentPassword: 'a',
        newPassword: 'b',
      }),
    ).toEqual({
      method: 'POST',
      path: '/api/auth/change-password',
      body: { currentPassword: 'a', newPassword: 'b' },
    });
    for (const [, operation] of ENTRIES)
      if (operation.transport === 'auth') {
        // Every auth entry is a Better Auth endpoint and nothing else is.
        expect(operation.kind).toBe('write');
      }
  });

  it('keeps auth-transport entries under /api/auth and backend entries off it', () => {
    for (const [name, operation] of ENTRIES) {
      const [request] = requestsFor(name);
      expect(request.path.startsWith('/api/auth/')).toBe(
        operation.transport === 'auth',
      );
    }
  });

  it('refuses absolute and protocol-relative OAuth callbacks', () => {
    const input =
      ACCOUNT_SETTINGS_OPERATIONS['account.security.linkSocial'].input;
    for (const callbackURL of [
      'https://evil.example/',
      '//evil.example/',
      '/\\evil.example',
      'account',
    ])
      expect(
        input.safeParse({
          provider: 'google',
          callbackURL,
          errorCallbackURL: '/account',
        }).success,
      ).toBe(false);
  });

  it('describes the avatar signed-upload flow', () => {
    const upload = ACCOUNT_SETTINGS_OPERATIONS['account.avatar.upload'];
    const signed = upload.upload;
    if (signed === undefined) throw new Error('avatar upload is not signed');
    expect(upload.transport).toBe('upload');
    expect(signed.maxBytes).toBe(5 * 1024 * 1024);
    expect(signed.contentTypes).toEqual([
      'image/png',
      'image/jpeg',
      'image/gif',
    ]);
    const input = { mimeType: 'image/jpeg' as const, size: 2048 };
    expect(signed.sign(input)).toEqual({
      method: 'POST',
      path: '/api/account/profile/avatar/upload-url',
      body: { mimeType: 'image/jpeg', size: 2048 },
    });
    expect(
      signed.commit(input, {
        uploadUrl: 'https://storage.example/signed',
        filePath: 'avatars/u1/a.jpg',
      }),
    ).toEqual({
      method: 'POST',
      path: '/api/account/profile/avatar/commit',
      body: { filePath: 'avatars/u1/a.jpg' },
    });
    expect(
      upload.input.safeParse({ mimeType: 'image/webp', size: 10 }).success,
    ).toBe(false);
    expect(
      upload.input.safeParse({
        mimeType: 'image/png',
        size: 5 * 1024 * 1024 + 1,
      }).success,
    ).toBe(false);
    expect(
      upload.input.safeParse({ mimeType: 'image/png', size: 0 }).success,
    ).toBe(false);
  });

  it('bounds large text inputs', () => {
    const update = ACCOUNT_SETTINGS_OPERATIONS['account.profile.update'];
    expect(update.maxInputBytes).toBeLessThan(DEFAULT_SETTINGS_MAX_INPUT_BYTES);
    expect(update.input.safeParse({ bio: 'x'.repeat(513) }).success).toBe(
      false,
    );
    expect(
      update.input.safeParse({
        links: Array.from({ length: 6 }, () => ({
          platform: 'x',
          url: 'https://x.com/a',
        })),
      }).success,
    ).toBe(false);
  });
});
