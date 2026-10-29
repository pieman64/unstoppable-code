import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

import {
  getScenario,
  getScenarioActivity,
  handleControlPlaneRequest,
  registerScenario,
  resetAll,
} from '../control-plane.mjs';
import {
  HOSTED_SETTINGS_DIGEST_ID,
  HOSTED_SETTINGS_FACT_ID,
  HOSTED_SETTINGS_ORG_IDS,
  HOSTED_SETTINGS_PAGE_DATA_ROUTES,
  HOSTED_SETTINGS_PASSWORD,
  HOSTED_SETTINGS_SUB_TEAM_ID,
  HOSTED_SETTINGS_TEAMMATES,
  HOSTED_SETTINGS_VIEWER,
  HOSTED_SETTINGS_TIME,
  defaultHostedSettingsOrganizations,
} from './hosted-settings-fixtures.mjs';
import { handleCloudRequest } from './cloud.mjs';
import {
  HOSTED_SETTINGS_MOCK_OPERATIONS,
  HOSTED_SETTINGS_SESSION_COOKIE,
  HOSTED_SETTINGS_TWO_FACTOR_COOKIE,
  handleHostedSettingsRequest,
  resetHostedSettingsSessions,
} from './hosted-settings.mjs';
import {
  HOSTED_SETTINGS_LIVE_FEED_ITEM_ID,
  HOSTED_SETTINGS_LONG_TIMELINE_ITEM_COUNT,
  HOSTED_SETTINGS_SCENARIO_NAMES,
  hostedSettingsScenario,
  readHostedSettingsRequests,
  registerHostedSettingsScenario,
} from '../../seeders/hostedSettingsCloud.mjs';

// The real wire contracts, loaded through tsx so the fixtures are validated
// against the same zod schemas the desktop bridge parses responses with.
const settings = await tsImport(
  fileURLToPath(
    new URL(
      '../../../../../../packages/protocol/src/settings/index.ts',
      import.meta.url,
    ),
  ),
  import.meta.url,
);

const KEY = 'csk_hosted_settings_test';
const NAMESPACE = 'canopy';

let server;
let base;

before(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (await handleHostedSettingsRequest(request, response, url)) return;
    if (await handleControlPlaneRequest(request, response, url)) return;
    if (
      url.pathname === '/api/v1/canopy/account' &&
      (await handleCloudRequest(request, response, url))
    )
      return;
    response.writeHead(418).end('not handled');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  resetAll();
  resetHostedSettingsSessions();
});

function register(name = 'hosted-settings-signed-in', options = {}) {
  registerScenario(KEY, hostedSettingsScenario(name, options));
}

async function mint(key = KEY, redirectPath = '/') {
  return fetch(`${base}/api/v1/${NAMESPACE}/auth-link`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ redirectPath }),
  });
}

function cookieHeader(response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

/** Mint and consume; returns the session `Cookie` header. */
async function signIn(key = KEY) {
  const minted = await mint(key);
  assert.equal(minted.status, 200);
  const { url } = await minted.json();
  const consumed = await fetch(url, { redirect: 'manual' });
  assert.equal(consumed.status, 303);
  return cookieHeader(consumed);
}

function session(cookie) {
  return async (path, { method = 'GET', body, origin, headers = {} } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(origin === undefined ? {} : { origin }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      json: text === '' ? null : JSON.parse(text),
    };
  };
}

/** Execute one table entry exactly as desktop main builds it. */
async function execute(call, name, input) {
  const validated = settings.validateSettingsOperationInput(name, input);
  assert.equal(validated.ok, true, `${name} input should validate`);
  const request = settings.settingsOperationRequest(name, validated.input);
  const operation = settings.settingsOperation(name);
  const result = await call(request.path, {
    method: request.method,
    body: request.body,
    origin:
      operation.transport === 'auth' || request.method !== 'GET'
        ? base
        : undefined,
  });
  return { ...result, request };
}

async function requestLog(key = KEY) {
  return readHostedSettingsRequests(key, { baseUrl: base });
}

/* -------------------------------------------------------------------------- */
/* Auth link                                                                   */
/* -------------------------------------------------------------------------- */

test('auth-link mint falls through for keys without a hostedSettings slice', async () => {
  registerScenario(KEY, { cloud: {} });
  const response = await mint();
  assert.equal(response.status, 418);
  assert.equal((await mint('csk_unregistered')).status, 418);
});

test('mint returns a same-origin consume URL; consume sets the session cookie once', async () => {
  register();
  const minted = await mint(KEY, '/');
  assert.equal(minted.status, 200);
  assert.equal(minted.headers.get('cache-control'), 'no-store');
  const { url } = await minted.json();
  const consumeUrl = new URL(url);
  assert.equal(consumeUrl.origin, base);
  assert.equal(consumeUrl.pathname, `/api/v1/${NAMESPACE}/auth-link/consume`);
  assert.ok(consumeUrl.searchParams.get('code'));

  const consumed = await fetch(url, { redirect: 'manual' });
  assert.equal(consumed.status, 303);
  const location = new URL(consumed.headers.get('location'));
  assert.equal(location.origin, base);
  assert.notEqual(location.pathname, '/login');
  const cookies = consumed.headers.getSetCookie();
  assert.equal(cookies.length, 1);
  assert.match(
    cookies[0],
    new RegExp(
      `^${HOSTED_SETTINGS_SESSION_COOKIE.replace('.', '\\.')}=[^;]+; Path=/; HttpOnly; SameSite=Lax$`,
    ),
  );

  // Single use: the code is gone (the cloud surface would answer next).
  const again = await fetch(url, { redirect: 'manual' });
  assert.equal(again.status, 418);
  assert.equal(getScenarioActivity(KEY)['authLinkMint:/'], 1);
  const log = await requestLog();
  assert.deepEqual(
    log.consumes.map((entry) => entry.accepted),
    [true],
  );
});

test('two-factor-pending mint answers the real route 403 shape', async () => {
  register('hosted-settings-two-factor-pending');
  const response = await mint();
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: 'Two-factor authentication required',
  });
});

test('rate-limited mint answers 429 with Retry-After', async () => {
  register('hosted-settings-rate-limited');
  const response = await mint();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.deepEqual(await response.json(), { error: 'Too many requests' });
});

test('mint arrays script successive attempts; the last repeats', async () => {
  register({ mint: ['ok', 'rate-limited'] });
  assert.equal((await mint()).status, 200);
  assert.equal((await mint()).status, 429);
  assert.equal((await mint()).status, 429);
  const log = await requestLog();
  assert.deepEqual(
    log.mints.map((entry) => entry.status),
    [200, 429, 429],
  );
});

test('consume-rejected redirects to /login without a cookie', async () => {
  register('hosted-settings-consume-rejected');
  const { url } = await (await mint()).json();
  const consumed = await fetch(url, { redirect: 'manual' });
  assert.equal(consumed.status, 303);
  assert.equal(new URL(consumed.headers.get('location')).pathname, '/login');
  assert.deepEqual(consumed.headers.getSetCookie(), []);
});

test('a two-factor user gets the proof cookie, and session routes require it', async () => {
  register('hosted-settings-two-factor-user');
  const { url } = await (await mint()).json();
  const consumed = await fetch(url, { redirect: 'manual' });
  const cookies = consumed.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.ok(
    cookies.some((cookie) =>
      cookie.startsWith(`${HOSTED_SETTINGS_TWO_FACTOR_COOKIE}=`),
    ),
  );
  const both = cookieHeader(consumed);
  const sessionOnly = both
    .split('; ')
    .filter((pair) => pair.startsWith(`${HOSTED_SETTINGS_SESSION_COOKIE}=`))
    .join('; ');

  assert.equal((await session(both)('/api/v1/settings/bootstrap')).status, 200);
  const withoutProof = await session(sessionOnly)('/api/v1/settings/bootstrap');
  assert.equal(withoutProof.status, 403);
});

/* -------------------------------------------------------------------------- */
/* Session authentication                                                      */
/* -------------------------------------------------------------------------- */

test('session routes reject requests without the minted cookie', async () => {
  register();
  const anonymous = await fetch(`${base}/api/v1/settings/bootstrap`);
  assert.equal(anonymous.status, 401);
  const bearerOnly = await fetch(`${base}/api/account/api-keys`, {
    headers: { authorization: `Bearer ${KEY}` },
  });
  assert.equal(bearerOnly.status, 401);
  const forged = await session(
    `${HOSTED_SETTINGS_SESSION_COOKIE}=not-a-session.sig`,
  )('/api/account/organizations');
  assert.equal(forged.status, 401);

  const unauthenticated = await (
    await fetch(`${base}/__mock/hosted-settings-unauthenticated`)
  ).json();
  assert.deepEqual(
    unauthenticated.requests.map((entry) => entry.path),
    [
      '/api/v1/settings/bootstrap',
      '/api/account/api-keys',
      '/api/account/organizations',
    ],
  );
});

test('sign-out and expiry end the session with 401', async () => {
  register();
  const call = session(await signIn());
  assert.equal((await call('/api/account/api-keys')).status, 200);

  const withoutOrigin = await call('/api/auth/sign-out', {
    method: 'POST',
    body: {},
  });
  assert.equal(withoutOrigin.status, 403);
  const signOut = await call('/api/auth/sign-out', {
    method: 'POST',
    body: {},
    origin: base,
  });
  assert.equal(signOut.status, 200);
  assert.equal((await call('/api/account/api-keys')).status, 401);

  const second = session(await signIn());
  assert.equal((await second('/api/account/api-keys')).status, 200);
  const expired = await (
    await fetch(
      `${base}/__mock/hosted-settings/${encodeURIComponent(KEY)}/sessions/expire`,
      { method: 'POST' },
    )
  ).json();
  assert.deepEqual(expired, { ok: true, expired: 1 });
  const after = await second('/api/account/api-keys');
  assert.equal(after.status, 401);

  const log = await requestLog();
  assert.equal(log.signOuts, 1);
  assert.equal(log.activeSessions, 0);
  assert.equal(log.requests.at(-1).operation, 'session.rejected');
});

test('re-registering a key drops its sessions', async () => {
  register();
  const call = session(await signIn());
  register();
  assert.equal((await call('/api/account/api-keys')).status, 401);
});

/* -------------------------------------------------------------------------- */
/* Bootstrap and page data                                                     */
/* -------------------------------------------------------------------------- */

test('bootstrap validates and reports the mock account as the viewer', async () => {
  register();
  const call = session(await signIn());
  const { status, json } = await execute(call, 'settings.bootstrap', {});
  assert.equal(status, 200);
  assert.equal(settings.settingsBootstrapSchema.safeParse(json).success, true);
  assert.equal(json.viewer.id, HOSTED_SETTINGS_VIEWER.id);
  assert.equal(json.viewer.id, 'account-e2e');
  assert.equal(json.organization, null);
  assert.deepEqual(
    json.organizations.map((org) => [org.id, org.role, org.isPersonal]),
    [
      [HOSTED_SETTINGS_ORG_IDS.personal, 'OWNER', true],
      [HOSTED_SETTINGS_ORG_IDS.owner, 'OWNER', false],
      [HOSTED_SETTINGS_ORG_IDS.member, 'MEMBER', false],
      [HOSTED_SETTINGS_ORG_IDS.lapsed, 'ADMIN', false],
    ],
  );

  const lapsed = await execute(call, 'settings.bootstrap', {
    organizationId: HOSTED_SETTINGS_ORG_IDS.lapsed,
  });
  assert.equal(
    settings.settingsBootstrapSchema.safeParse(lapsed.json).success,
    true,
  );
  assert.equal(lapsed.json.organization.billingNeedsAttention, true);
  assert.notEqual(lapsed.json.organization.lapse, null);
  assert.deepEqual(lapsed.json.organization.disabledTabs, [
    'feed',
    'statistics',
    'digests',
    'memory',
  ]);

  const member = await execute(call, 'settings.bootstrap', {
    organizationId: HOSTED_SETTINGS_ORG_IDS.member,
  });
  assert.equal(member.json.organization.visibleTabs.includes('memory'), false);
});

test('bootstrap follows a scenario account id override', async () => {
  registerScenario(KEY, {
    ...hostedSettingsScenario(),
    cloud: { account: { id: 'account-override-e2e' } },
  });
  const call = session(await signIn());
  const { json } = await execute(call, 'settings.bootstrap', {});
  assert.equal(json.viewer.id, 'account-override-e2e');
});

test('viewer-mismatch bootstrap names a different viewer', async () => {
  register('hosted-settings-viewer-mismatch');
  const call = session(await signIn());
  const { status, json } = await execute(call, 'settings.bootstrap', {});
  assert.equal(status, 200);
  assert.equal(settings.settingsBootstrapSchema.safeParse(json).success, true);
  assert.notEqual(json.viewer.id, HOSTED_SETTINGS_VIEWER.id);
});

test('integrations-disabled bootstrap reports Integrations off and its page 404s', async () => {
  register('hosted-settings-integrations-disabled');
  const call = session(await signIn());
  const { status, json } = await execute(call, 'settings.bootstrap', {});
  assert.equal(status, 200);
  assert.equal(settings.settingsBootstrapSchema.safeParse(json).success, true);
  assert.equal(json.account.integrationsEnabled, false);
  assert.equal(json.account.billingEnabled, true);
  const integrations = await execute(call, 'settings.pageData', {
    route: { scope: 'account', page: 'integrations' },
  });
  assert.equal(integrations.status, 404);
  const account = await execute(call, 'settings.pageData', {
    route: { scope: 'account', page: 'account' },
  });
  assert.equal(account.status, 200);

  // The default scenario keeps Integrations on.
  register();
  const signedIn = session(await signIn());
  const enabled = await execute(signedIn, 'settings.bootstrap', {});
  assert.equal(enabled.json.account.integrationsEnabled, true);
  const page = await execute(signedIn, 'settings.pageData', {
    route: { scope: 'account', page: 'integrations' },
  });
  assert.equal(page.status, 200);
});

test('unsupported-server answers 404 for bootstrap and page data', async () => {
  register('hosted-settings-unsupported-server');
  const call = session(await signIn());
  assert.equal((await execute(call, 'settings.bootstrap', {})).status, 404);
  const pageData = await execute(call, 'settings.pageData', {
    route: { scope: 'account', page: 'account' },
  });
  assert.equal(pageData.status, 404);
});

test('page data covers every kind and validates against the protocol schemas', async () => {
  register();
  const call = session(await signIn());
  const kinds = new Set();
  for (const route of HOSTED_SETTINGS_PAGE_DATA_ROUTES) {
    assert.equal(
      settings.settingsRouteSchema.safeParse(route).success,
      true,
      `fixture route should be valid: ${JSON.stringify(route)}`,
    );
    const { status, json } = await execute(call, 'settings.pageData', {
      route,
    });
    assert.equal(status, 200, JSON.stringify({ route, json }));
    assert.equal(json.kind, settings.settingsPageDataKindForRoute(route));
    const parsed = settings.validateSettingsOperationResult(
      'settings.pageData',
      json,
    );
    assert.equal(parsed.ok, true, `invalid page data for ${json.kind}`);
    kinds.add(json.kind);
  }
  assert.deepEqual(
    [...kinds].sort(),
    [
      ...settings.ACCOUNT_PAGE_DATA_KINDS,
      ...settings.ORGANIZATION_PAGE_DATA_KINDS,
    ].sort(),
  );
});

test('page data gates by membership, role and lapse', async () => {
  register();
  const call = session(await signIn());
  const pageData = (route) => execute(call, 'settings.pageData', { route });

  const missing = await pageData({
    scope: 'organization',
    organizationId: 'a0000000-0000-4000-8000-0000000000ff',
    page: 'feed',
  });
  assert.equal(missing.status, 404);
  const memberMemory = await pageData({
    scope: 'organization',
    organizationId: HOSTED_SETTINGS_ORG_IDS.member,
    page: 'memory',
  });
  assert.equal(memberMemory.status, 403);
  const lapsedDigests = await pageData({
    scope: 'organization',
    organizationId: HOSTED_SETTINGS_ORG_IDS.lapsed,
    page: 'digests',
  });
  assert.equal(lapsedDigests.status, 200);
  assert.equal(lapsedDigests.json.data.archive, null);
  assert.notEqual(lapsedDigests.json.data.lapsed, null);
  const lapsedDigest = await pageData({
    scope: 'organization',
    organizationId: HOSTED_SETTINGS_ORG_IDS.lapsed,
    page: 'digests',
    digestId: HOSTED_SETTINGS_DIGEST_ID,
  });
  assert.equal(
    settings.validateSettingsOperationResult(
      'settings.pageData',
      lapsedDigest.json,
    ).ok,
    true,
  );
  assert.equal(lapsedDigest.json.data.report, null);
  const personalMemory = await pageData({
    scope: 'organization',
    organizationId: HOSTED_SETTINGS_ORG_IDS.personal,
    page: 'memory',
    factId: HOSTED_SETTINGS_FACT_ID,
  });
  assert.deepEqual(personalMemory.json.data, {
    enabled: false,
    team: personalMemory.json.data.team,
  });
  assert.equal(
    personalMemory.json.data.team.detail.id,
    HOSTED_SETTINGS_ORG_IDS.personal,
  );
  const invalid = await call('/api/v1/settings/page-data', {
    method: 'POST',
    body: { route: { scope: 'account', page: 'not-a-page' } },
    origin: base,
  });
  assert.equal(invalid.status, 400);
});

test('memory pages carry the team header the other organization tabs draw', async () => {
  register();
  const call = session(await signIn());
  for (const route of HOSTED_SETTINGS_PAGE_DATA_ROUTES) {
    if (route.scope !== 'organization' || route.page !== 'memory') continue;
    const { status, json } = await execute(call, 'settings.pageData', {
      route,
    });
    assert.equal(status, 200, JSON.stringify({ route, json }));
    assert.equal(json.data.team.detail.id, route.organizationId);
    assert.equal(json.data.team.viewerEmail, HOSTED_SETTINGS_VIEWER.email);
  }
});

test('organization lists leave out the personal organization, as production does', async () => {
  register();
  const call = session(await signIn());
  const listed = await execute(call, 'organization.list', {});
  assert.equal(listed.status, 200);
  const page = await execute(call, 'settings.pageData', {
    route: { scope: 'organizations' },
  });
  assert.equal(page.status, 200);
  for (const organizations of [
    listed.json.organizations,
    page.json.data.organizations,
  ]) {
    const ids = organizations.map((org) => org.id);
    assert.equal(ids.includes(HOSTED_SETTINGS_ORG_IDS.personal), false);
    assert.equal(ids.includes(HOSTED_SETTINGS_ORG_IDS.owner), true);
  }
  // The bootstrap keeps the personal membership, as production serves it.
  const bootstrap = await execute(call, 'settings.bootstrap', {});
  assert.equal(
    bootstrap.json.organizations.some(
      (org) => org.id === HOSTED_SETTINGS_ORG_IDS.personal,
    ),
    true,
  );
});

test('statistics usage has headline cards and daily buckets for its range', async () => {
  register();
  const call = session(await signIn());
  const { status, json } = await execute(
    call,
    'organization.statistics.usage',
    {
      organizationId: HOSTED_SETTINGS_ORG_IDS.owner,
      scope: 'organization',
      granularity: 'week',
      startIso: '2026-09-01T00:00:00.000Z',
      endIso: '2026-10-01T00:00:00.000Z',
    },
  );
  assert.equal(status, 200);
  assert.equal(
    settings.validateSettingsOperationResult(
      'organization.statistics.usage',
      json,
    ).ok,
    true,
  );
  assert.deepEqual(json.range, {
    startIso: '2026-09-01T00:00:00.000Z',
    endIso: '2026-10-01T00:00:00.000Z',
    granularity: 'week',
  });
  assert.equal(json.filterUserId, null);
  assert.equal(json.headline.length, 3);
  assert.equal(json.costByProvider.length, 10);
  assert.equal(json.tokensByProvider.length, 10);
  assert.equal(
    json.costByProvider[0].bucketStartIso,
    '2026-09-01T00:00:00.000Z',
  );
});

test('hosted-settings-long-timeline serves a Timeline long enough to scroll', async () => {
  register('hosted-settings-long-timeline');
  const call = session(await signIn());
  const { status, json } = await execute(call, 'organization.feed.page', {
    organizationId: HOSTED_SETTINGS_ORG_IDS.owner,
  });
  assert.equal(status, 200);
  assert.equal(
    settings.validateSettingsOperationResult('organization.feed.page', json).ok,
    true,
  );
  assert.equal(json.items.length, HOSTED_SETTINGS_LONG_TIMELINE_ITEM_COUNT);
  const times = json.items.map((item) => Date.parse(item.occurredAt));
  assert.deepEqual(
    times,
    [...times].sort((a, b) => b - a),
    'the page lists the newest item first',
  );
});

/* -------------------------------------------------------------------------- */
/* Operations                                                                  */
/* -------------------------------------------------------------------------- */

const OWNER = HOSTED_SETTINGS_ORG_IDS.owner;

/** One sample input per served table entry, in an order that keeps state valid. */
const OPERATION_SAMPLES = [
  ['account.details.update', { name: 'Portal Renamed' }],
  ['account.avatar.remove', {}],
  ['account.profile.read', {}],
  ['account.profile.update', { bio: 'Fixture bio', showCost: true }],
  ['account.notifications.digestPreferences.read', {}],
  [
    'account.notifications.digestPreferences.update',
    { daily: true, weekly: true, monthly: false },
  ],
  ['account.notifications.push.read', {}],
  ['account.notifications.push.update', { pushEnabled: true }],
  ['account.apiKeys.list', {}],
  ['account.apiKeys.create', { name: 'Fixture key' }],
  ['account.apiKeys.revoke', { apiKeyId: 'api-key-e2e-desktop' }],
  ['account.security.authSources', {}],
  [
    'account.security.changePassword',
    { currentPassword: HOSTED_SETTINGS_PASSWORD, newPassword: 'new-horse-e2e' },
  ],
  ['account.billing.summary', {}],
  ['account.billing.credits', {}],
  ['account.billing.invoices', {}],
  ['account.billing.charges', {}],
  ['account.billing.creditsLedger', {}],
  ['account.github.connection.read', {}],
  ['organization.invitations.incoming', {}],
  [
    'organization.members.invite',
    { organizationId: OWNER, email: 'dana@example.com' },
  ],
  [
    'organization.invitations.status',
    { organizationId: OWNER, email: 'dana@example.com' },
  ],
  ['organization.invitations.list', { organizationId: OWNER }],
  ['organization.list', {}],
  ['organization.create', { name: 'Fixture Org' }],
  ['organization.detail', { organizationId: OWNER }],
  ['organization.rename', { organizationId: OWNER, name: 'Northwind Labs 2' }],
  [
    'organization.members.updateRole',
    {
      organizationId: OWNER,
      userId: HOSTED_SETTINGS_TEAMMATES.blake.id,
      role: 'ADMIN',
    },
  ],
  [
    'organization.members.remove',
    { organizationId: OWNER, userId: HOSTED_SETTINGS_TEAMMATES.blake.id },
  ],
  ['organization.teams.create', { organizationId: OWNER, name: 'Research' }],
  [
    'organization.teams.rename',
    {
      organizationId: OWNER,
      teamId: HOSTED_SETTINGS_SUB_TEAM_ID,
      name: 'Platform Core',
    },
  ],
  [
    'organization.teams.delete',
    { organizationId: OWNER, teamId: HOSTED_SETTINGS_SUB_TEAM_ID },
  ],
  ['organization.projects.list', { organizationId: OWNER }],
  ['organization.projects.memberList', { organizationId: OWNER }],
  ['organization.memory.facts', { organizationId: OWNER }],
  [
    'organization.memory.fact',
    { organizationId: OWNER, factId: HOSTED_SETTINGS_FACT_ID },
  ],
  ['organization.settings.config', { organizationId: OWNER }],
  ['organization.settings.modelCatalog', {}],
  ['organization.settings.subscriptionPricing', { organizationId: OWNER }],
  [
    'organization.settings.subscriptionPricing.update',
    { organizationId: OWNER, planKey: 'openai:pro', monthlyPriceUsd: 150 },
  ],
  [
    'organization.statistics.usage',
    {
      organizationId: OWNER,
      scope: 'organization',
      granularity: 'day',
      startIso: '2026-09-01T00:00:00.000Z',
      endIso: '2026-10-01T00:00:00.000Z',
    },
  ],
  [
    'organization.statistics.routingBacktest.lookup',
    {
      organizationId: OWNER,
      scope: 'organization',
      startIso: '2026-09-01T00:00:00.000Z',
      endIso: '2026-10-01T00:00:00.000Z',
    },
  ],
  [
    'organization.settings.policies.update',
    { organizationId: OWNER, enforceMemberModelPolicy: true },
  ],
  [
    'organization.settings.usage.update',
    { organizationId: OWNER, usageStatsMinRole: 'MEMBER' },
  ],
  ['organization.feed.page', { organizationId: OWNER }],
  ['organization.dataSharing.viewer', { organizationId: OWNER }],
  ['organization.billing.summary', { organizationId: OWNER }],
  ['organization.billing.credits', { organizationId: OWNER }],
  ['organization.billing.invoices', { organizationId: OWNER }],
  ['organization.billing.history', { organizationId: OWNER }],
  ['organization.billing.credits.ledger', { organizationId: OWNER }],
];

test('every served operation is a table entry and has a sample', () => {
  const sampled = new Set([
    ...OPERATION_SAMPLES.map(([name]) => name),
    'settings.bootstrap',
    'settings.pageData',
    'organization.delete',
    'organization.leave',
    'organization.invitations.respond',
    'auth.signOut',
  ]);
  for (const name of HOSTED_SETTINGS_MOCK_OPERATIONS) {
    if (name === 'auth.signOut') continue;
    assert.equal(
      settings.isSettingsOperationName(name),
      true,
      `${name} is not a SETTINGS_OPERATIONS entry`,
    );
  }
  assert.deepEqual(
    [...new Set(HOSTED_SETTINGS_MOCK_OPERATIONS)].sort(),
    [...sampled].sort(),
  );
});

test('every served operation answers its table request with a valid result', async () => {
  register();
  const call = session(await signIn());
  for (const [name, input] of OPERATION_SAMPLES) {
    const { status, json, request } = await execute(call, name, input);
    assert.equal(
      status,
      200,
      `${name} ${request.method} ${request.path} → ${status} ${JSON.stringify(json)}`,
    );
    const validated = settings.validateSettingsOperationResult(name, json);
    assert.equal(validated.ok, true, `${name} result: ${JSON.stringify(json)}`);
  }

  const log = await requestLog();
  const served = log.requests.filter((entry) => entry.authenticated);
  assert.deepEqual(
    served.map((entry) => entry.operation),
    OPERATION_SAMPLES.map(([name]) => name),
  );
  assert.equal(
    served.every((entry) => entry.status === 200),
    true,
  );
  assert.equal(
    log.requests.some((entry) => entry.financial),
    false,
  );
  const changePassword = served.find(
    (entry) => entry.operation === 'account.security.changePassword',
  );
  assert.deepEqual(changePassword.body, { redacted: true });
  assert.equal(changePassword.origin, base);
  assert.equal(
    getScenarioActivity(KEY)['hostedSettings:organization.teams.create'],
    1,
  );

  const state = await (
    await fetch(
      `${base}/__mock/hosted-settings/${encodeURIComponent(KEY)}/state`,
    )
  ).json();
  const owner = state.organizations.find((org) => org.id === OWNER);
  assert.equal(owner.name, 'Northwind Labs 2');
  assert.deepEqual(
    owner.subTeams.map((team) => team.name),
    ['Research'],
  );
  assert.equal(
    owner.members.some(
      (entry) => entry.id === HOSTED_SETTINGS_TEAMMATES.blake.id,
    ),
    false,
  );
  assert.equal(owner.config.enforceMemberModelPolicy, true);
  assert.equal(owner.config.usageStatsMinRole, 'MEMBER');
  assert.equal(state.profile.name, 'Portal Renamed');
  assert.equal(state.publicProfile.bio, 'Fixture bio');
  assert.deepEqual(
    state.apiKeys.map((key) => key.name),
    ['Fixture key'],
  );
  assert.equal(state.organizations.length, 5);
  assert.deepEqual(
    state.invites.map((invite) => [invite.status, invite.invitedEmail]),
    [['ACTIVE', 'dana@example.com']],
  );
});

test('Better Auth routes need the trusted Origin and the current password', async () => {
  register();
  const call = session(await signIn());
  const body = {
    currentPassword: HOSTED_SETTINGS_PASSWORD,
    newPassword: 'new-horse-e2e',
  };
  const noOrigin = await call('/api/auth/change-password', {
    method: 'POST',
    body,
  });
  assert.equal(noOrigin.status, 403);
  assert.equal(noOrigin.json.code, 'INVALID_ORIGIN');
  const wrongOrigin = await call('/api/auth/change-password', {
    method: 'POST',
    body,
    origin: 'http://evil.example.com',
  });
  assert.equal(wrongOrigin.status, 403);
  const wrongPassword = await call('/api/auth/change-password', {
    method: 'POST',
    body: { ...body, currentPassword: 'not-it' },
    origin: base,
  });
  assert.equal(wrongPassword.status, 400);
  assert.equal(wrongPassword.json.code, 'INVALID_PASSWORD');
  const changed = await call('/api/auth/change-password', {
    method: 'POST',
    body,
    origin: base,
  });
  assert.equal(changed.status, 200);
});

test('role guards: members cannot manage and the last owner stays', async () => {
  register();
  const call = session(await signIn());
  const memberInvite = await execute(call, 'organization.members.invite', {
    organizationId: HOSTED_SETTINGS_ORG_IDS.member,
    email: 'erin@example.com',
  });
  assert.equal(memberInvite.status, 403);
  const demoteSelf = await execute(call, 'organization.members.updateRole', {
    organizationId: OWNER,
    userId: HOSTED_SETTINGS_VIEWER.id,
    role: 'MEMBER',
  });
  assert.equal(demoteSelf.status, 409);
  assert.equal(demoteSelf.json.code, 'last_owner');
});

test('financial and unknown routes are refused and flagged', async () => {
  register();
  const call = session(await signIn());
  const financial = [
    ['POST', '/api/account/billing/setup-intent'],
    ['DELETE', '/api/account/billing/payment-method'],
    ['POST', `/api/account/organizations/${OWNER}/billing/subscription/change`],
    ['PUT', `/api/account/organizations/${OWNER}/billing/credits/auto-top-up`],
    ['POST', `/api/account/organizations/${OWNER}/billing/credits/top-up`],
  ];
  for (const [method, path] of financial) {
    const response = await call(path, { method, body: {}, origin: base });
    assert.equal(response.status, 404, path);
  }
  const unknown = await call('/api/account/something-else');
  assert.equal(unknown.status, 404);

  const log = await requestLog();
  assert.deepEqual(
    log.requests.filter((entry) => entry.financial).map((entry) => entry.path),
    financial.map(([, path]) => path),
  );
  assert.equal(log.requests.at(-1).operation, 'unmatched');
});

test('operationErrors script a failure for one table entry', async () => {
  register('hosted-settings-signed-in', {
    overrides: {
      operationErrors: {
        'organization.members.remove': {
          status: 500,
          body: { error: 'Scripted' },
        },
      },
    },
  });
  const call = session(await signIn());
  const removed = await execute(call, 'organization.members.remove', {
    organizationId: OWNER,
    userId: HOSTED_SETTINGS_TEAMMATES.blake.id,
  });
  assert.equal(removed.status, 500);
  const detail = await execute(call, 'organization.detail', {
    organizationId: OWNER,
  });
  assert.equal(
    detail.json.members.some(
      (entry) => entry.id === HOSTED_SETTINGS_TEAMMATES.blake.id,
    ),
    true,
  );
});

/* -------------------------------------------------------------------------- */
/* Feed stream                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read SSE frames until `stop(frames)` or the stream ends. Returns the
 * `feed.item` frames and whether the server ended the stream.
 */
async function readFeed(
  response,
  { stop = () => false, timeoutMs = 3_000 } = {},
) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames = [];
  let ended = false;
  const deadline = setTimeout(() => reader.cancel(), timeoutMs);
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        ended = true;
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const fields = {};
        for (const line of raw.split('\n')) {
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          fields[line.slice(0, colon)] = line.slice(colon + 1).trimStart();
        }
        if (fields.event === 'feed.item') {
          frames.push({ id: fields.id, envelope: JSON.parse(fields.data) });
        }
      }
      if (stop(frames)) break;
    }
  } finally {
    clearTimeout(deadline);
    await reader.cancel().catch(() => undefined);
  }
  return { frames, ended };
}

function openFeed(cookie, lastEventId, organizationId = OWNER) {
  return fetch(
    `${base}${settings.settingsOrganizationFeedStreamPath(organizationId)}`,
    {
      headers: {
        accept: 'text/event-stream',
        cookie,
        ...(lastEventId === undefined
          ? {}
          : { 'last-event-id': String(lastEventId) }),
      },
    },
  );
}

test('the feed stream delivers scripted items as valid envelopes', async () => {
  register();
  const cookie = await signIn();
  const response = await openFeed(cookie);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const { frames } = await readFeed(response, {
    stop: (seen) => seen.length >= 1,
  });
  assert.equal(frames.length, 1);
  const [{ id, envelope }] = frames;
  assert.equal(id, String(envelope.sequence));
  assert.equal(
    settings.settingsFeedEnvelopeSchema.safeParse(envelope).success,
    true,
  );
  assert.equal(envelope.payload.id, HOSTED_SETTINGS_LIVE_FEED_ITEM_ID);
  assert.equal(envelope.sequence, 2);

  // The feed page lists both items, newest first.
  const page = await execute(session(cookie), 'organization.feed.page', {
    organizationId: OWNER,
  });
  assert.deepEqual(
    page.json.items.map((item) => item.id),
    [HOSTED_SETTINGS_LIVE_FEED_ITEM_ID, 'feed-e2e-1'],
  );
});

test('reconnect honors Last-Event-ID and pushed items arrive live', async () => {
  register('hosted-settings-feed-reconnect');
  const cookie = await signIn();
  const first = await readFeed(await openFeed(cookie));
  assert.equal(
    first.ended,
    true,
    'the first stream drops after scripted items',
  );
  assert.deepEqual(
    first.frames.map((frame) => frame.envelope.sequence),
    [2],
  );

  // Missed while disconnected.
  const pushed = await (
    await fetch(
      `${base}/__mock/hosted-settings/${encodeURIComponent(KEY)}/feed`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: [{ id: 'feed-e2e-missed' }] }),
      },
    )
  ).json();
  assert.deepEqual(pushed.sequences, [3]);

  const resumed = await openFeed(cookie, 1);
  assert.equal(resumed.status, 200);
  const replay = await readFeed(resumed, { stop: (seen) => seen.length >= 2 });
  assert.deepEqual(
    replay.frames.map((frame) => frame.envelope.payload.id),
    [HOSTED_SETTINGS_LIVE_FEED_ITEM_ID, 'feed-e2e-missed'],
  );

  const log = await requestLog();
  assert.deepEqual(log.feeds[OWNER].lastEventIds, [null, '1']);
  assert.equal(log.feeds[OWNER].connections, 2);
});

test('feed/close drops open streams', async () => {
  register();
  const cookie = await signIn();
  const response = await openFeed(cookie);
  const reading = readFeed(response);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const closed = await (
    await fetch(
      `${base}/__mock/hosted-settings/${encodeURIComponent(KEY)}/feed/close`,
      { method: 'POST' },
    )
  ).json();
  assert.deepEqual(closed, { ok: true, closed: 1 });
  assert.equal((await reading).ended, true);
});

for (const [name, status] of [
  ['hosted-settings-feed-reconnect-denied', 403],
  ['hosted-settings-feed-reconnect-expired', 401],
]) {
  test(`${name} answers ${status} on reconnect`, async () => {
    register(name);
    const cookie = await signIn();
    const first = await readFeed(await openFeed(cookie));
    assert.equal(first.ended, true);
    const lastSequence = first.frames.at(-1).envelope.sequence;
    const reconnect = await openFeed(cookie, lastSequence);
    assert.equal(reconnect.status, status);
    await reconnect.body?.cancel();
  });
}

test('feeds for organizations the viewer does not belong to answer 404', async () => {
  register();
  const response = await openFeed(
    await signIn(),
    undefined,
    'a0000000-0000-4000-8000-0000000000ff',
  );
  assert.equal(response.status, 404);
  await response.body?.cancel();
});

/* -------------------------------------------------------------------------- */
/* Seeder                                                                      */
/* -------------------------------------------------------------------------- */

test('every named scenario registers through registerScenario.mjs', async () => {
  for (const name of HOSTED_SETTINGS_SCENARIO_NAMES) {
    const key = `csk_${name}`;
    const registered = await registerHostedSettingsScenario(key, name, {
      baseUrl: base,
    });
    assert.deepEqual(registered, { ok: true, key });
    const stored = await (
      await fetch(`${base}/__mock/state/${encodeURIComponent(key)}`)
    ).json();
    assert.equal(typeof stored.scenario.hostedSettings, 'object');
    assert.equal(
      stored.scenario.cloud.personalOrganizationId,
      HOSTED_SETTINGS_ORG_IDS.personal,
    );
    assert.equal(stored.scenario.cloud.organizations.length, 3);
  }
  assert.throws(() => hostedSettingsScenario('hosted-settings-nope'));
});

const INCOMING_ORG = 'a2000000-0000-4000-8000-000000000001';
const INCOMING_INVITE = 'd2000000-0000-4000-8000-000000000001';
function incomingInvitation() {
  const organization = defaultHostedSettingsOrganizations()[2];
  return {
    id: INCOMING_INVITE,
    organization: {
      ...organization,
      id: INCOMING_ORG,
      name: 'Incoming Team',
      members: organization.members.filter(
        (member) => member.id !== HOSTED_SETTINGS_VIEWER.id,
      ),
      viewerRole: null,
    },
    role: 'MEMBER',
    invitedByName: 'Casey',
    organizationTeamName: null,
    createdAt: HOSTED_SETTINGS_TIME,
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
}
async function cloudAccount(key = KEY) {
  const response = await fetch(`${base}/api/v1/canopy/account`, {
    headers: { authorization: `Bearer ${key}` },
  });
  assert.equal(response.status, 200);
  return response.json();
}
async function fixtureState(key = KEY) {
  return (
    await fetch(
      `${base}/__mock/hosted-settings/${encodeURIComponent(key)}/state`,
    )
  ).json();
}
async function validMutation(call, name, input) {
  const result = await execute(call, name, input);
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(
    settings.validateSettingsOperationResult(name, result.json).ok,
    true,
    name,
  );
  return result.json;
}

test('membership mutations synchronize cloud probes while preserving configuration and scenario isolation', async () => {
  register();
  const otherKey = 'csk_other_settings';
  registerScenario(otherKey, hostedSettingsScenario());
  const isolated = await cloudAccount(otherKey);
  const cloud = getScenario(KEY).cloud;
  cloud.enforcedSettings = [{ organizationId: OWNER, policies: [] }];
  const unrelated = {
    id: 'a3000000-0000-4000-8000-000000000001',
    name: 'Unrelated',
    role: 'MEMBER',
    createdAt: HOSTED_SETTINGS_TIME,
    updatedAt: HOSTED_SETTINGS_TIME,
  };
  cloud.organizations.push(unrelated);
  cloud.orgBillingStates.push({
    organizationId: unrelated.id,
    organizationName: unrelated.name,
    teamsEntitled: false,
  });
  cloud.organizations[0].customField = 'retained';
  cloud.orgBillingStates[0].customBilling = 'retained';
  const call = session(await signIn());
  const created = await validMutation(call, 'organization.create', {
    name: 'Immediate Org',
  });
  let account = await cloudAccount();
  assert.equal(
    account.organizations.some((org) => org.id === created.id),
    true,
  );
  assert.equal(
    account.organizations.some(
      (org) => org.id === HOSTED_SETTINGS_ORG_IDS.personal,
    ),
    false,
  );
  assert.equal(
    cloud.organizations.find((org) => org.id === OWNER).customField,
    'retained',
  );
  assert.equal(
    cloud.orgBillingStates.find((org) => org.organizationId === OWNER)
      .customBilling,
    'retained',
  );
  assert.deepEqual(cloud.enforcedSettings, [
    { organizationId: OWNER, policies: [] },
  ]);
  assert.equal(
    cloud.orgBillingStates.find(
      (org) => org.organizationId === HOSTED_SETTINGS_ORG_IDS.lapsed,
    ).teamsEntitled,
    false,
  );
  await validMutation(call, 'organization.delete', {
    organizationId: created.id,
  });
  account = await cloudAccount();
  assert.equal(
    account.organizations.some((org) => org.id === created.id),
    false,
  );
  assert.equal(
    cloud.orgBillingStates.some((org) => org.organizationId === created.id),
    false,
  );
  assert.equal(
    (await execute(call, 'organization.detail', { organizationId: created.id }))
      .status,
    404,
  );
  await validMutation(call, 'organization.leave', {
    organizationId: HOSTED_SETTINGS_ORG_IDS.member,
  });
  account = await cloudAccount();
  assert.equal(
    account.organizations.some(
      (org) => org.id === HOSTED_SETTINGS_ORG_IDS.member,
    ),
    false,
  );
  const retained =
    getScenario(KEY).hostedSettingsState.organizations[
      HOSTED_SETTINGS_ORG_IDS.member
    ];
  assert.equal(
    retained.members.length,
    1,
    'leaving retains the organization for its other member',
  );
  assert.equal(retained.viewerRole, null);
  assert.equal(
    (
      await execute(call, 'organization.detail', {
        organizationId: retained.id,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await execute(call, 'settings.pageData', {
        route: {
          scope: 'organization',
          organizationId: retained.id,
          page: 'members',
        },
      })
    ).status,
    404,
  );
  assert.equal(
    (await openFeed(await signIn(), undefined, retained.id)).status,
    404,
  );
  assert.deepEqual(
    cloud.organizations.find((org) => org.id === unrelated.id),
    unrelated,
  );
  assert.equal(
    cloud.orgBillingStates.find(
      (entry) => entry.organizationId === unrelated.id,
    ).teamsEntitled,
    false,
  );
  assert.deepEqual(await cloudAccount(otherKey), isolated);
});

test('incoming invitations appear in page data, accept once, and are consumed on decline', async () => {
  register({ incomingInvitations: [incomingInvitation()] });
  const call = session(await signIn());
  const incoming = await execute(call, 'organization.invitations.incoming', {});
  assert.equal(
    settings.validateSettingsOperationResult(
      'organization.invitations.incoming',
      incoming.json,
    ).ok,
    true,
  );
  assert.equal(incoming.json.invitations[0]?.id, INCOMING_INVITE);
  const page = await execute(call, 'settings.pageData', {
    route: { scope: 'organizations' },
  });
  assert.equal(page.json.data.invitations[0]?.id, INCOMING_INVITE);
  await validMutation(call, 'organization.invitations.respond', {
    inviteId: INCOMING_INVITE,
    action: 'accept',
  });
  const after = await cloudAccount();
  assert.equal(
    after.organizations.filter((org) => org.id === INCOMING_ORG).length,
    1,
  );
  assert.deepEqual(
    (await execute(call, 'organization.invitations.incoming', {})).json
      .invitations,
    [],
  );
  assert.equal((await fixtureState()).incomingInvitations.length, 0);
  assert.equal(
    (
      await execute(call, 'organization.invitations.respond', {
        inviteId: INCOMING_INVITE,
        action: 'accept',
      })
    ).status,
    404,
  );
  assert.deepEqual(await cloudAccount(), after);
  assert.equal(
    (
      await execute(call, 'organization.detail', {
        organizationId: INCOMING_ORG,
      })
    ).json.members.some((member) => member.id === HOSTED_SETTINGS_VIEWER.id),
    true,
  );

  register({ incomingInvitations: [incomingInvitation()] });
  const declining = session(await signIn());
  const before = await cloudAccount();
  await validMutation(declining, 'organization.invitations.respond', {
    inviteId: INCOMING_INVITE,
    action: 'decline',
  });
  assert.deepEqual(await cloudAccount(), before);
  assert.deepEqual(
    (await execute(declining, 'organization.invitations.incoming', {})).json
      .invitations,
    [],
  );
});

test('rejected membership writes leave both state representations unchanged', async () => {
  register({ incomingInvitations: [incomingInvitation()] });
  const call = session(await signIn());
  const before = await fixtureState();
  const account = await cloudAccount();
  for (const [name, input, expected] of [
    [
      'organization.delete',
      { organizationId: HOSTED_SETTINGS_ORG_IDS.member },
      403,
    ],
    [
      'organization.delete',
      { organizationId: HOSTED_SETTINGS_ORG_IDS.lapsed },
      403,
    ],
    ['organization.leave', { organizationId: OWNER }, 409],
    [
      'organization.invitations.respond',
      { inviteId: 'missing', action: 'accept' },
      404,
    ],
  ]) {
    const result = await execute(call, name, input);
    assert.equal(result.status, expected, name);
  }
  assert.deepEqual(await fixtureState(), before);
  assert.deepEqual(await cloudAccount(), account);
});

test('first-organization fixtures keep the initial cloud probe consistent with organization overrides', async () => {
  register({ organizations: [defaultHostedSettingsOrganizations()[0]] });
  assert.deepEqual((await cloudAccount()).organizations, []);
  const call = session(await signIn());
  const created = await validMutation(call, 'organization.create', {
    name: 'First Team',
  });
  assert.deepEqual(
    (await cloudAccount()).organizations.map((org) => org.id),
    [created.id],
  );
  assert.deepEqual(
    getScenario(KEY).cloud.orgBillingStates.map(
      (entry) => entry.organizationId,
    ),
    [created.id],
  );
});

test('a co-owner can leave without deleting the other owners or feed history', async () => {
  const organizations = defaultHostedSettingsOrganizations();
  organizations[1].members[1].role = 'OWNER';
  register({ organizations });
  const call = session(await signIn());
  const before = await execute(call, 'organization.feed.page', {
    organizationId: OWNER,
  });
  assert.equal(before.json.items.length, 1);
  await validMutation(call, 'organization.leave', { organizationId: OWNER });
  const state = getScenario(KEY).hostedSettingsState;
  assert.equal(state.organizations[OWNER].members.length, 2);
  assert.equal(
    state.organizations[OWNER].members.filter(
      (member) => member.role === 'OWNER',
    ).length,
    1,
  );
  assert.equal(state.feeds[OWNER].events.length, 1);
  assert.equal(
    (await execute(call, 'organization.leave', { organizationId: OWNER }))
      .status,
    404,
  );
});

test('scripted membership failures never change membership or consume an invitation', async () => {
  for (const [name, input] of [
    ['organization.create', { name: 'Rejected Team' }],
    ['organization.delete', { organizationId: OWNER }],
    ['organization.leave', { organizationId: HOSTED_SETTINGS_ORG_IDS.member }],
    [
      'organization.invitations.respond',
      { inviteId: INCOMING_INVITE, action: 'accept' },
    ],
  ]) {
    register({
      incomingInvitations: [incomingInvitation()],
      operationErrors: { [name]: { status: 503 } },
    });
    const call = session(await signIn());
    const before = await fixtureState();
    const account = await cloudAccount();
    assert.equal((await execute(call, name, input)).status, 503);
    assert.deepEqual(await fixtureState(), before);
    assert.deepEqual(await cloudAccount(), account);
  }
});

test('accepting another invitation to an existing membership does not duplicate membership', async () => {
  const invitation = incomingInvitation();
  register({
    incomingInvitations: [
      invitation,
      { ...invitation, id: 'second-invitation' },
    ],
  });
  const call = session(await signIn());
  for (const inviteId of [INCOMING_INVITE, 'second-invitation']) {
    await validMutation(call, 'organization.invitations.respond', {
      inviteId,
      action: 'accept',
    });
  }
  assert.equal(
    (await cloudAccount()).organizations.filter(
      (org) => org.id === INCOMING_ORG,
    ).length,
    1,
  );
  const detail = await execute(call, 'organization.detail', {
    organizationId: INCOMING_ORG,
  });
  assert.equal(
    detail.json.members.filter(
      (member) => member.id === HOSTED_SETTINGS_VIEWER.id,
    ).length,
    1,
  );
  assert.deepEqual(
    (await execute(call, 'organization.invitations.incoming', {})).json
      .invitations,
    [],
  );
});
