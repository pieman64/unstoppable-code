import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
} from './registerScenario.mjs';
import {
  HOSTED_SETTINGS_ORG_IDS,
  HOSTED_SETTINGS_TIME,
  defaultHostedSettingsOrganizations,
  feedItem,
  timelineFeedItems,
} from '../mock-server/routes/hosted-settings-fixtures.mjs';

/**
 * Hosted account and organization settings scenarios for the mock server's
 * `routes/hosted-settings.mjs` surface (the desktop settings bridge: auth-link
 * mint and consume, `settings.bootstrap`, `settings.pageData`, the settings
 * operation table and the organization feed stream).
 *
 * Register once per spec key, before the desktop opens Settings. Registering
 * the key again resets the mock's settings state, its sessions and its
 * request log. Read what the desktop sent with `readHostedSettingsRequests`.
 */

export {
  HOSTED_SETTINGS_DIGEST_ID,
  HOSTED_SETTINGS_FACT_ID,
  HOSTED_SETTINGS_FEED_ITEM_ID,
  HOSTED_SETTINGS_INVOICE_ID,
  HOSTED_SETTINGS_ORG_IDS,
  HOSTED_SETTINGS_PASSWORD,
  HOSTED_SETTINGS_SUB_TEAM_ID,
  HOSTED_SETTINGS_TEAMMATES,
  HOSTED_SETTINGS_VIEWER,
} from '../mock-server/routes/hosted-settings-fixtures.mjs';

/** The feed item the signed-in scenarios deliver live on the first stream. */
export const HOSTED_SETTINGS_LIVE_FEED_ITEM_ID = 'feed-e2e-live-1';

/** How many items `hosted-settings-long-timeline` seeds into the owner feed. */
export const HOSTED_SETTINGS_LONG_TIMELINE_ITEM_COUNT = 40;

function liveFeedItem() {
  return feedItem({
    id: HOSTED_SETTINGS_LIVE_FEED_ITEM_ID,
    occurredAt: HOSTED_SETTINGS_TIME,
    prNumber: 43,
    title: 'Fixture pull request delivered live',
  });
}

/**
 * Named `hostedSettings` slices. Every scenario seeds the same viewer and
 * organizations: a Personal organization, a team the viewer owns, a team
 * where the viewer is a member and a lapsed team the viewer administers.
 */
export const HOSTED_SETTINGS_SCENARIOS = Object.freeze({
  /** Mint, consume and every read and write succeed. */
  'hosted-settings-signed-in': () => ({
    feed: { scriptedItems: [liveFeedItem()] },
  }),
  /** A two-factor user: consume also sets the two-factor proof cookie. */
  'hosted-settings-two-factor-user': () => ({
    twoFactorUser: true,
    feed: { scriptedItems: [liveFeedItem()] },
  }),
  /** As signed in, with a Timeline long enough to scroll in the owner org. */
  'hosted-settings-long-timeline': () => ({
    feed: {
      items: timelineFeedItems(HOSTED_SETTINGS_LONG_TIMELINE_ITEM_COUNT),
      scriptedItems: [liveFeedItem()],
    },
  }),
  /** The mint answers 403 (terminal for the bridge; never reminted). */
  'hosted-settings-two-factor-pending': () => ({ mint: 'two-factor-pending' }),
  /** The mint answers 429 with `Retry-After`. */
  'hosted-settings-rate-limited': () => ({
    mint: 'rate-limited',
    retryAfterSeconds: 60,
  }),
  /** The consume route redirects to `/login` (the code was not accepted). */
  'hosted-settings-consume-rejected': () => ({ consume: 'login' }),
  /**
   * Signed in against a server with the Integrations (Cloud Git) page off:
   * bootstrap reports `integrationsEnabled: false` and its page data 404s.
   */
  'hosted-settings-integrations-disabled': () => ({
    integrationsEnabled: false,
    feed: { scriptedItems: [liveFeedItem()] },
  }),
  /** A server that predates hosted settings: bootstrap and page data 404. */
  'hosted-settings-unsupported-server': () => ({ bootstrap: 'unsupported' }),
  /** Bootstrap names a different viewer than the desktop account. */
  'hosted-settings-viewer-mismatch': () => ({ bootstrap: 'viewer-mismatch' }),
  /**
   * The first stream delivers the live item and drops; the reconnect resumes
   * with `Last-Event-ID` and succeeds.
   */
  'hosted-settings-feed-reconnect': () => ({
    feed: { scriptedItems: [liveFeedItem()], dropAfterScripted: true },
  }),
  /** As above, but the reconnect answers 403 (access lost). */
  'hosted-settings-feed-reconnect-denied': () => ({
    feed: {
      scriptedItems: [liveFeedItem()],
      dropAfterScripted: true,
      reconnect: 'forbidden',
    },
  }),
  /** As above, but the reconnect answers 401 (session expired). */
  'hosted-settings-feed-reconnect-expired': () => ({
    feed: {
      scriptedItems: [liveFeedItem()],
      dropAfterScripted: true,
      reconnect: 'unauthorized',
    },
  }),
});

export const HOSTED_SETTINGS_SCENARIO_NAMES = Object.freeze(
  Object.keys(HOSTED_SETTINGS_SCENARIOS),
);

/**
 * The cloud account slice that keeps `/api/v1/<ns>/account` consistent with
 * the hosted organizations: the team memberships, the Personal organization
 * and the lapsed team's billing state.
 */
export function hostedSettingsCloudAccount(
  organizations = defaultHostedSettingsOrganizations(),
) {
  return {
    personalOrganizationId: HOSTED_SETTINGS_ORG_IDS.personal,
    organizations: organizations
      .filter((org) => !org.isPersonal)
      .map((org) => ({
        id: org.id,
        name: org.name,
        role: org.viewerRole,
        createdAt: HOSTED_SETTINGS_TIME,
        updatedAt: HOSTED_SETTINGS_TIME,
      })),
    teams: [],
    orgBillingStates: organizations
      .filter((org) => !org.isPersonal)
      .map((org) => ({
        organizationId: org.id,
        organizationName: org.name,
        teamsEntitled: org.lapsed === null,
      })),
  };
}

/**
 * The scenario object for a named scenario (or a raw `hostedSettings`
 * slice), merged with `overrides`.
 *
 * @param {string | object} [nameOrSlice] a key of
 *   {@link HOSTED_SETTINGS_SCENARIOS}, or a `hostedSettings` slice
 * @param {{
 *   overrides?: object,
 *   syncCloudAccount?: boolean,
 *   scenario?: object,
 * }} [options] `overrides` merge over the slice; `syncCloudAccount: false`
 *   leaves the account payload's organizations alone; `scenario` adds other
 *   slices for the same key
 */
export function hostedSettingsScenario(
  nameOrSlice = 'hosted-settings-signed-in',
  { overrides = {}, syncCloudAccount = true, scenario = {} } = {},
) {
  let slice;
  if (typeof nameOrSlice === 'string') {
    const build = HOSTED_SETTINGS_SCENARIOS[nameOrSlice];
    if (build === undefined) {
      throw new Error(`Unknown hosted settings scenario: ${nameOrSlice}`);
    }
    slice = build();
  } else {
    slice = nameOrSlice;
  }
  const hostedSettings = { ...slice, ...overrides };
  return {
    ...scenario,
    cloud: {
      ...(syncCloudAccount
        ? hostedSettingsCloudAccount(hostedSettings.organizations)
        : {}),
      ...(scenario.cloud ?? {}),
    },
    hostedSettings,
  };
}

/**
 * Register a hosted settings scenario for the `csk_` key a spec signs in with.
 *
 * @param {string} apiKey
 * @param {string | object} [nameOrSlice]
 * @param {Parameters<typeof hostedSettingsScenario>[1] & { baseUrl?: string }} [options]
 */
export function registerHostedSettingsScenario(
  apiKey,
  nameOrSlice = 'hosted-settings-signed-in',
  { baseUrl = DEFAULT_MOCK_BASE_URL, ...options } = {},
) {
  return registerScenario(
    baseUrl,
    apiKey,
    hostedSettingsScenario(nameOrSlice, options),
  );
}

function controlUrl(baseUrl, apiKey, suffix) {
  const origin = (baseUrl ?? DEFAULT_MOCK_BASE_URL).replace(/\/+$/, '');
  return `${origin}/__mock/hosted-settings/${encodeURIComponent(apiKey)}${suffix}`;
}

async function controlRequest(url, body) {
  const response = await fetch(
    url,
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  if (!response.ok) {
    throw new Error(
      `Hosted settings mock control ${url} responded ${response.status}: ${await response.text()}`,
    );
  }
  return response.json();
}

/**
 * What the desktop sent: `{ requests, mints, consumes, signOuts,
 * activeSessions, feeds }`. Each request carries `method`, `path`,
 * `operation`, `authenticated`, `origin`, `lastEventId`, `financial`,
 * `status` and its JSON `body` (passwords redacted).
 */
export function readHostedSettingsRequests(apiKey, { baseUrl } = {}) {
  return controlRequest(controlUrl(baseUrl, apiKey, '/requests'));
}

/** The mock's current settings data after the desktop's writes. */
export function readHostedSettingsState(apiKey, { baseUrl } = {}) {
  return controlRequest(controlUrl(baseUrl, apiKey, '/state'));
}

/** End every minted session: later session requests answer 401. */
export function expireHostedSettingsSessions(apiKey, { baseUrl } = {}) {
  return controlRequest(controlUrl(baseUrl, apiKey, '/sessions/expire'), {});
}

/** Append feed items (partial `FeedItem`s) to an organization's stream. */
export function pushHostedSettingsFeedItems(
  apiKey,
  items,
  { organizationId, baseUrl } = {},
) {
  return controlRequest(controlUrl(baseUrl, apiKey, '/feed'), {
    items,
    ...(organizationId === undefined ? {} : { organizationId }),
  });
}

/** Drop an organization's open feed streams, like a lost connection. */
export function closeHostedSettingsFeedStreams(
  apiKey,
  { organizationId, baseUrl } = {},
) {
  return controlRequest(controlUrl(baseUrl, apiKey, '/feed/close'), {
    ...(organizationId === undefined ? {} : { organizationId }),
  });
}
