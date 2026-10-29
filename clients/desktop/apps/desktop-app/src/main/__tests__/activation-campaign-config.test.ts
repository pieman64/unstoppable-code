import {
  ACTIVATION_CAMPAIGNS,
  resolveDueAt,
} from '../notifications/campaigns/campaign-config';
// The lookups resolve against the ACTIVE campaign table (compiled until a
// served document is applied), so they live with the sync module.
import {
  getCampaignDefinition,
  getCampaignVariant,
} from '../notifications/campaigns/served-config-sync';
import type { ActivationJourneyPersistedState } from '@canopy/desktop-shared/types';

function stateWith(
  overrides: Partial<ActivationJourneyPersistedState>,
): ActivationJourneyPersistedState {
  return {
    firstOpenAt: null,
    lastActiveAt: null,
    holdout: null,
    campaigns: {},
    signals: {},
    ...overrides,
  };
}

describe('ACTIVATION_CAMPAIGNS', () => {
  it('ships all four CAN-2438 campaigns', () => {
    expect(ACTIVATION_CAMPAIGNS.map((campaign) => campaign.id)).toEqual([
      'activation-first-task',
      'activation-role-branch',
      'activation-marketplace',
      'activation-mobile',
    ]);
  });

  it('gives every campaign a lateness bound', () => {
    for (const campaign of ACTIVATION_CAMPAIGNS) {
      expect(campaign.maxLatenessMs).toBeGreaterThan(0);
    }
  });

  it('gives every variant copy and a destination', () => {
    for (const campaign of ACTIVATION_CAMPAIGNS) {
      const variants = Object.values(campaign.variants);
      expect(variants.length).toBeGreaterThan(0);
      for (const variant of variants) {
        expect(typeof variant.title).toBe('string');
        expect(typeof variant.body).toBe('string');
        expect(typeof variant.destination.kind).toBe('string');
      }
    }
  });

  it('gives the role campaign no default branch', () => {
    // Silence beats a generic nudge: an unmapped or unset role suppresses
    // rather than falling back to neutral copy.
    const roleCampaign = getCampaignDefinition('activation-role-branch');
    expect(roleCampaign?.variants.default).toBeUndefined();
    expect(Object.keys(roleCampaign?.variants ?? {}).sort()).toEqual([
      'business',
      'developer',
    ]);
  });

  it('offers a confirmed-trial variant only on the first-task campaign', () => {
    // The offer copy must never be reachable for a campaign that has not
    // checked billing eligibility.
    const withOffer = ACTIVATION_CAMPAIGNS.filter(
      (campaign) => campaign.variants.offer !== undefined,
    ).map((campaign) => campaign.id);
    expect(withOffer).toEqual(['activation-first-task']);
  });
});

describe('getCampaignDefinition', () => {
  it('returns the definition for a shipped campaign', () => {
    expect(getCampaignDefinition('activation-marketplace')?.id).toBe(
      'activation-marketplace',
    );
  });

  it('returns undefined for an id with no definition', () => {
    // Every campaign now ships, so the guard is exercised through
    // getCampaignVariant instead.
    expect(
      getCampaignVariant('activation-marketplace', 'no-such-variant'),
    ).toBeUndefined();
  });
});

describe('resolveDueAt', () => {
  it('anchors a first-open campaign to firstOpenAt plus the offset', () => {
    const definition = getCampaignDefinition('activation-marketplace');
    expect(definition).toBeDefined();
    if (definition === undefined) return;
    const due = resolveDueAt(
      definition,
      stateWith({
        firstOpenAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:30:00.000Z',
      }),
    );
    expect(due).toBe(Date.parse('2026-01-01T08:00:00.000Z'));
  });

  it('ignores lastActiveAt for a first-open campaign', () => {
    const definition = getCampaignDefinition('activation-marketplace');
    if (definition === undefined) throw new Error('missing definition');
    const early = resolveDueAt(
      definition,
      stateWith({
        firstOpenAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-05T00:00:00.000Z',
      }),
    );
    expect(early).toBe(Date.parse('2026-01-01T08:00:00.000Z'));
  });

  it('returns null when the anchor timestamp is missing', () => {
    const definition = getCampaignDefinition('activation-marketplace');
    if (definition === undefined) throw new Error('missing definition');
    expect(resolveDueAt(definition, stateWith({}))).toBeNull();
  });

  it('returns null when the anchor timestamp is unparseable', () => {
    const definition = getCampaignDefinition('activation-marketplace');
    if (definition === undefined) throw new Error('missing definition');
    expect(
      resolveDueAt(definition, stateWith({ firstOpenAt: 'not-a-date' })),
    ).toBeNull();
  });

  it('anchors an abandonment campaign to lastActiveAt plus the offset', () => {
    const due = resolveDueAt(
      {
        id: 'activation-first-task',
        anchor: 'abandonment',
        offsetMs: 10 * 60 * 1000,
        maxLatenessMs: 60 * 60 * 1000,
        variants: {
          default: {
            title: 't',
            body: 'b',
            destination: { kind: 'page', page: 'home' },
          },
        },
      },
      stateWith({
        firstOpenAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T03:00:00.000Z',
      }),
    );
    expect(due).toBe(Date.parse('2026-01-01T03:10:00.000Z'));
  });
});
