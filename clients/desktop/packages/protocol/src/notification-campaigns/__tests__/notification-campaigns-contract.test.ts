import {
  NOTIFICATION_CAMPAIGN_CONFIG_VERSION,
  parseServedCampaignConfig,
} from '../index';

/**
 * This parser is the trust boundary between hub-authored content and OS
 * notifications sent once per install. Every rejection below is a way a bad
 * payload could otherwise reach users, so they are tested as behavior rather
 * than as schema trivia.
 */

function variant(overrides: Record<string, unknown> = {}): unknown {
  return {
    title: 'Ready when you are',
    body: 'Start your first task.',
    destination: { kind: 'page', page: 'home' },
    ...overrides,
  };
}

function campaign(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'activation-marketplace',
    anchor: 'first-open',
    offsetMs: 8 * 60 * 60 * 1000,
    maxLatenessMs: 48 * 60 * 60 * 1000,
    variants: { default: variant() },
    ...overrides,
  };
}

function config(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: NOTIFICATION_CAMPAIGN_CONFIG_VERSION,
    revision: 'rev-1',
    campaigns: [campaign()],
    ...overrides,
  };
}

describe('parseServedCampaignConfig', () => {
  it('accepts a well-formed payload', () => {
    const parsed = parseServedCampaignConfig(config());
    expect(parsed?.campaigns).toHaveLength(1);
    expect(parsed?.campaigns[0]?.variants.default?.destination).toEqual({
      kind: 'page',
      page: 'home',
    });
  });

  it('rejects an unrecognized version rather than guessing', () => {
    // A newer schema may carry semantics this build would misread.
    expect(parseServedCampaignConfig(config({ version: 2 }))).toBeNull();
    expect(parseServedCampaignConfig(config({ version: 0 }))).toBeNull();
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1500.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['beyond a year', 400 * 24 * 60 * 60 * 1000],
    ['a numeric string', '60000'],
  ])('rejects a %s offset', (_label, offsetMs) => {
    // A coerced 0 would fire every campaign at once, at everyone.
    expect(
      parseServedCampaignConfig(
        config({ campaigns: [campaign({ offsetMs })] }),
      ),
    ).toBeNull();
  });

  it('rejects an unknown destination kind', () => {
    // A kind this build cannot route would dead-end the click.
    const bad = campaign({
      variants: { default: variant({ destination: { kind: 'teleport' } }) },
    });
    expect(parseServedCampaignConfig(config({ campaigns: [bad] }))).toBeNull();
  });

  it('rejects a page destination with no page', () => {
    const bad = campaign({
      variants: { default: variant({ destination: { kind: 'page' } }) },
    });
    expect(parseServedCampaignConfig(config({ campaigns: [bad] }))).toBeNull();
  });

  it('accepts the payload-shaped destinations that carry no fields', () => {
    for (const kind of ['canopy-portal', 'add-workspace']) {
      const ok = campaign({
        variants: { default: variant({ destination: { kind } }) },
      });
      expect(
        parseServedCampaignConfig(config({ campaigns: [ok] })),
      ).not.toBeNull();
    }
  });

  it('rejects duplicate campaign ids', () => {
    // The send-once latch is keyed by id, so a duplicate would make the
    // winning definition depend on array order.
    expect(
      parseServedCampaignConfig(
        config({ campaigns: [campaign(), campaign()] }),
      ),
    ).toBeNull();
  });

  it('rejects a campaign with no variants', () => {
    expect(
      parseServedCampaignConfig(
        config({ campaigns: [campaign({ variants: {} })] }),
      ),
    ).toBeNull();
  });

  it('rejects one bad campaign rather than applying the rest', () => {
    // No partial application: a payload is wholly valid or wholly ignored.
    expect(
      parseServedCampaignConfig(
        config({
          campaigns: [campaign(), campaign({ id: 'other', offsetMs: 0 })],
        }),
      ),
    ).toBeNull();
  });

  it('rejects empty or over-long copy', () => {
    const long = 'x'.repeat(241);
    for (const bad of [
      { title: '' },
      { body: '' },
      { title: long },
      { body: long },
    ]) {
      expect(
        parseServedCampaignConfig(
          config({
            campaigns: [campaign({ variants: { default: variant(bad) } })],
          }),
        ),
      ).toBeNull();
    }
  });

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['an array', []],
    ['an empty object', {}],
    ['a missing revision', { version: 1, campaigns: [] }],
    ['non-array campaigns', { version: 1, revision: 'r', campaigns: {} }],
  ])('rejects %s', (_label, value) => {
    expect(parseServedCampaignConfig(value)).toBeNull();
  });

  it('rejects a campaign id no client knows', () => {
    // Eligibility, the send-once latch, and telemetry are keyed by the id
    // union. Enforced here so PUBLISH rejects it too -- previously the server
    // accepted it and every client then discarded the whole document.
    expect(
      parseServedCampaignConfig(
        config({ campaigns: [campaign({ id: 'activation-invented' })] }),
      ),
    ).toBeNull();
  });

  it('rejects a page outside the campaign allowlist', () => {
    const bad = campaign({
      variants: {
        default: variant({ destination: { kind: 'page', page: 'audit' } }),
      },
    });
    expect(parseServedCampaignConfig(config({ campaigns: [bad] }))).toBeNull();
  });

  it('rejects a settings pane outside the allowlist', () => {
    const bad = campaign({
      variants: {
        default: variant({
          destination: { kind: 'settings', section: 'privacy' },
        }),
      },
    });
    expect(parseServedCampaignConfig(config({ campaigns: [bad] }))).toBeNull();
  });

  it('requires every variant key the resolver can emit', () => {
    // role-branch resolves to `developer` or `business`; shipping only one
    // suppresses forever as `variant-unavailable`, which arms no retry.
    const missing = campaign({
      id: 'activation-role-branch',
      anchor: 'abandonment',
      variants: { developer: variant() },
    });
    expect(
      parseServedCampaignConfig(config({ campaigns: [missing] })),
    ).toBeNull();

    const complete = campaign({
      id: 'activation-role-branch',
      anchor: 'abandonment',
      variants: { developer: variant(), business: variant() },
    });
    expect(
      parseServedCampaignConfig(config({ campaigns: [complete] })),
    ).not.toBeNull();
  });

  it('rejects a __proto__ variant key', () => {
    // Object.entries yields it, and assigning it to an object literal invokes
    // the prototype setter -- the entry-count guard would pass while the
    // rebuilt record had zero own properties.
    const raw: unknown = JSON.parse(
      JSON.stringify(config()).replace('"default"', '"__proto__"'),
    );
    expect(parseServedCampaignConfig(raw)).toBeNull();
  });

  it('rejects copy carrying a token this contract does not define', () => {
    // An unknown placeholder renders verbatim into an OS notification.
    const bad = campaign({
      variants: { default: variant({ body: 'Hi {userName}' }) },
    });
    expect(parseServedCampaignConfig(config({ campaigns: [bad] }))).toBeNull();
  });

  it('accepts the {appName} token', () => {
    const ok = campaign({
      variants: { default: variant({ title: 'Welcome to {appName}' }) },
    });
    expect(
      parseServedCampaignConfig(config({ campaigns: [ok] })),
    ).not.toBeNull();
  });

  it('accepts an empty campaign list as a valid "nothing scheduled"', () => {
    // Distinct from a parse failure: the hub can legitimately publish zero
    // campaigns, and that must not silently fall back to the compiled table.
    expect(
      parseServedCampaignConfig(config({ campaigns: [] }))?.campaigns,
    ).toEqual([]);
  });
});
