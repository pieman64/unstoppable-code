const mockReadFile = jest.fn();
const mockWriteFile = jest.fn();
const mockRename = jest.fn();
const mockUnlink = jest.fn();

jest.mock('node:fs/promises', () => ({
  mkdir: (): Promise<void> => Promise.resolve(),
  readFile: (...a: unknown[]): unknown => mockReadFile(...a),
  writeFile: (...a: unknown[]): unknown => mockWriteFile(...a),
  rename: (...a: unknown[]): unknown => mockRename(...a),
  unlink: (...a: unknown[]): unknown => mockUnlink(...a),
}));

jest.mock('../lib/paths', () => ({
  getServedCampaignConfigFilePath: (): string =>
    '/mock/notification-campaigns.json',
}));

import { ACTIVATION_CAMPAIGN_IDS } from '@canopy/desktop-shared/types';
import {
  REQUIRED_CAMPAIGN_VARIANT_KEYS,
  SERVED_CAMPAIGN_ANCHORS,
  SERVED_CAMPAIGN_IDS,
  SERVED_CAMPAIGN_PAGES,
  SERVED_CAMPAIGN_SETTINGS_SECTIONS,
} from '@canopy/protocol/notification-campaigns';
import { ACTIVATION_CAMPAIGNS } from '../notifications/campaigns/campaign-config';
import {
  getActiveCampaigns,
  getCampaignVariant,
  loadCachedServedCampaigns,
  refreshServedCampaigns,
  resetServedCampaignsForTests,
} from '../notifications/campaigns/served-config-sync';
import { renderCampaignCopy } from '../notifications/campaigns/served-config-mapper';
// The real brand runtime rather than a stub: mocking it needs the whole
// BRAND shape (env prefixes and more), and asserting against the live
// display name is what the substitution actually has to produce.
import { BRAND } from '@canopy/brand/current';

function served(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    revision: 'rev-9',
    campaigns: [
      {
        id: 'activation-marketplace',
        anchor: 'first-open',
        offsetMs: 60_000,
        maxLatenessMs: 3_600_000,
        variants: {
          default: {
            title: 'Served title',
            body: 'Served body',
            destination: { kind: 'page', page: 'plugins' },
          },
        },
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetServedCampaignsForTests();
  mockReadFile.mockRejectedValue(new Error('ENOENT'));
  mockWriteFile.mockResolvedValue(undefined);
  mockRename.mockResolvedValue(undefined);
  mockUnlink.mockResolvedValue(undefined);
});

describe('falling back to the compiled table', () => {
  it('uses compiled campaigns before anything is served', () => {
    expect(getActiveCampaigns()).toBe(ACTIVATION_CAMPAIGNS);
  });

  it('keeps compiled campaigns when the fetch fails', async () => {
    await expect(
      refreshServedCampaigns(() => Promise.reject(new Error('offline'))),
    ).resolves.toBe(false);
    expect(getActiveCampaigns()).toBe(ACTIVATION_CAMPAIGNS);
  });

  it('keeps compiled campaigns for a malformed document', async () => {
    const bad = served({ campaigns: [{ id: 'activation-marketplace' }] });
    await expect(
      refreshServedCampaigns(() => Promise.resolve(bad)),
    ).resolves.toBe(false);
    expect(getActiveCampaigns()).toBe(ACTIVATION_CAMPAIGNS);
    // Nothing invalid may reach the cache, or it comes back next launch.
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('does not revert to compiled once a document is applied', async () => {
    await refreshServedCampaigns(() => Promise.resolve(served()));
    await refreshServedCampaigns(() => Promise.reject(new Error('offline')));
    // A later failure must leave the last good document in place, not undo a
    // copy change that already shipped.
    expect(getActiveCampaigns()[0]?.variants.default?.title).toBe(
      'Served title',
    );
  });
});

describe('an empty campaign list', () => {
  // The critical regression: `getActiveCampaigns()` returns
  // `activeCampaigns ?? ACTIVATION_CAMPAIGNS`, and `??` does not fall back on
  // an empty array. The route used to emit `campaigns: []` whenever the flag
  // was off or nobody had authored yet, so day one would have durably wiped
  // every campaign on every install -- and cached it.
  it('is a deliberate kill switch when genuinely published', async () => {
    await expect(
      refreshServedCampaigns(() =>
        Promise.resolve({ version: 1, revision: 'off', campaigns: [] }),
      ),
    ).resolves.toBe(true);
    expect(getActiveCampaigns()).toEqual([]);
  });

  it('is NOT what a failed fetch produces', async () => {
    // The route now 404s for flag-off and not-yet-published, so the fetch
    // throws and the compiled table survives. This pins the desktop half of
    // that contract: no reachable failure path may yield an empty table.
    await refreshServedCampaigns(() => Promise.reject(new Error('404')));
    expect(getActiveCampaigns()).toBe(ACTIVATION_CAMPAIGNS);
    expect(getActiveCampaigns()).toHaveLength(4);
  });
});

describe('applying a served document', () => {
  it('replaces the compiled table', async () => {
    await expect(
      refreshServedCampaigns(() => Promise.resolve(served())),
    ).resolves.toBe(true);
    const active = getActiveCampaigns();
    expect(active).toHaveLength(1);
    expect(active[0]?.offsetMs).toBe(60_000);
  });

  it('caches only the validated document, atomically', async () => {
    await refreshServedCampaigns(() => Promise.resolve(served()));
    expect(mockWriteFile).toHaveBeenCalled();
    expect(mockRename).toHaveBeenCalled();
  });

  it('applies a cached document on launch', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(served()));
    await expect(loadCachedServedCampaigns()).resolves.toBe(true);
    expect(getActiveCampaigns()[0]?.variants.default?.body).toBe('Served body');
  });

  it('ignores an unreadable cache without deleting it', async () => {
    // A rolled-back build may not understand a document a newer build cached;
    // deleting it would lose config the newer build can still use.
    mockReadFile.mockResolvedValue('{ not json');
    await expect(loadCachedServedCampaigns()).resolves.toBe(false);
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it('routes clicks through the served destination, not the compiled one', async () => {
    await refreshServedCampaigns(() => Promise.resolve(served()));
    expect(getCampaignVariant('activation-marketplace', 'default')?.title).toBe(
      'Served title',
    );
  });
});

describe('what the hub is not allowed to do', () => {
  it('rejects a campaign missing a variant key its resolver emits', async () => {
    // Publishing role-branch with only `default` used to succeed and then
    // suppress forever as `variant-unavailable`, a terminal reason that arms
    // no retry -- reconfiguring the campaign into permanent silence.
    const bad = served({
      campaigns: [
        {
          id: 'activation-role-branch',
          anchor: 'abandonment',
          offsetMs: 60_000,
          maxLatenessMs: 3_600_000,
          variants: {
            default: {
              title: 't',
              body: 'b',
              destination: { kind: 'page', page: 'home' },
            },
          },
        },
      ],
    });
    await expect(
      refreshServedCampaigns(() => Promise.resolve(bad)),
    ).resolves.toBe(false);
  });

  it('rejects a __proto__ variant key', async () => {
    // `Object.entries` yields it, and assigning it to an object literal hits
    // the prototype setter -- the entry-count guard would see one variant
    // that then does not exist as an own property.
    const bad: unknown = JSON.parse(
      JSON.stringify(served()).replace('"default"', '"__proto__"'),
    );
    await expect(
      refreshServedCampaigns(() => Promise.resolve(bad)),
    ).resolves.toBe(false);
  });

  it('rejects copy carrying an unknown token', async () => {
    // An unknown placeholder renders verbatim into an OS notification.
    const bad = served({
      campaigns: [
        {
          ...(served() as { campaigns: Record<string, unknown>[] })
            .campaigns[0],
          variants: {
            default: {
              title: 'Hello {userName}',
              body: 'b',
              destination: { kind: 'page', page: 'plugins' },
            },
          },
        },
      ],
    });
    await expect(
      refreshServedCampaigns(() => Promise.resolve(bad)),
    ).resolves.toBe(false);
  });

  it('rejects a campaign id this build does not know', async () => {
    // Eligibility, the send-once latch, and telemetry are all keyed by the id
    // union, so an unknown id would be a campaign with no gating.
    const bad = served({
      campaigns: [
        {
          id: 'activation-invented',
          anchor: 'first-open',
          offsetMs: 60_000,
          maxLatenessMs: 3_600_000,
          variants: {
            default: {
              title: 't',
              body: 'b',
              destination: { kind: 'page', page: 'plugins' },
            },
          },
        },
      ],
    });
    await expect(
      refreshServedCampaigns(() => Promise.resolve(bad)),
    ).resolves.toBe(false);
  });

  it('rejects a page outside the campaign allowlist', async () => {
    // A campaign must not become a general-purpose deep link into pages that
    // assume state the user has not reached.
    const bad = served({
      campaigns: [
        {
          ...(served() as { campaigns: Record<string, unknown>[] })
            .campaigns[0],
          variants: {
            default: {
              title: 't',
              body: 'b',
              destination: { kind: 'page', page: 'audit' },
            },
          },
        },
      ],
    });
    await expect(
      refreshServedCampaigns(() => Promise.resolve(bad)),
    ).resolves.toBe(false);
  });

  it('rejects the whole document when one campaign is unmappable', async () => {
    const oneBad = served({
      campaigns: [
        (served() as { campaigns: unknown[] }).campaigns[0],
        {
          id: 'activation-mobile',
          anchor: 'first-open',
          offsetMs: 60_000,
          maxLatenessMs: 3_600_000,
          variants: {
            default: {
              title: 't',
              body: 'b',
              destination: { kind: 'settings', section: 'privacy' },
            },
          },
        },
      ],
    });
    await expect(
      refreshServedCampaigns(() => Promise.resolve(oneBad)),
    ).resolves.toBe(false);
    expect(getActiveCampaigns()).toBe(ACTIVATION_CAMPAIGNS);
  });
});

describe('protocol vocabulary must not drift from desktop', () => {
  // Protocol hand-copies three desktop tables because it cannot import
  // desktop-shared. Nothing links them, so these assertions are the link.
  // Drift is silent and nasty in both directions: an id protocol does not
  // know can never be hub-configured, and an id desktop does not know
  // publishes fine then makes every client discard the whole document.
  it('serves exactly the campaign ids desktop knows', () => {
    expect([...SERVED_CAMPAIGN_IDS].sort()).toEqual(
      [...ACTIVATION_CAMPAIGN_IDS].sort(),
    );
  });

  it('requires exactly the variant keys each compiled campaign ships', () => {
    // If a campaign gains a variant (say an `enterprise` role branch), publish
    // must start requiring it — otherwise a document omitting it is accepted
    // and then suppresses forever as the terminal `variant-unavailable`.
    for (const campaign of ACTIVATION_CAMPAIGNS) {
      expect([...REQUIRED_CAMPAIGN_VARIANT_KEYS[campaign.id]].sort()).toEqual(
        Object.keys(campaign.variants).sort(),
      );
    }
  });

  it('serves every anchor the compiled campaigns use', () => {
    // Protocol ADDING an anchor is caught at compile time (it assigns into
    // CampaignAnchor); protocol DROPPING one is not, and would 422 a
    // legitimate document at publish.
    for (const campaign of ACTIVATION_CAMPAIGNS) {
      expect(SERVED_CAMPAIGN_ANCHORS).toContain(campaign.anchor);
    }
  });

  it('only allows destinations the compiled campaigns already use', () => {
    // Narrower than it looks, and worth being precise: that every allowlisted
    // page is a real NavigationPage is proved by the `Set<NavigationPage>`
    // construction in the mapper, not here. This proves the other direction
    // -- the compiled table never uses a destination the hub cannot author,
    // so republishing an equivalent document is always possible.
    for (const campaign of ACTIVATION_CAMPAIGNS) {
      for (const variant of Object.values(campaign.variants)) {
        if (variant.destination.kind === 'page') {
          expect(SERVED_CAMPAIGN_PAGES).toContain(variant.destination.page);
        }
        if (variant.destination.kind === 'settings') {
          expect(SERVED_CAMPAIGN_SETTINGS_SECTIONS).toContain(
            variant.destination.section,
          );
        }
      }
    }
  });
});

describe('brand tokens', () => {
  it('substitutes the product name from the brand runtime', () => {
    // Served literals would ship the wrong product name on a white-label build.
    expect(renderCampaignCopy('Welcome to {appName} today')).toBe(
      `Welcome to ${BRAND.displayName} today`,
    );
  });

  it('substitutes every occurrence', () => {
    expect(renderCampaignCopy('{appName} and {appName}')).toBe(
      `${BRAND.displayName} and ${BRAND.displayName}`,
    );
  });

  it('leaves copy without tokens untouched', () => {
    expect(renderCampaignCopy('No tokens here')).toBe('No tokens here');
  });
});
