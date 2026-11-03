/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BILLING_CAPABILITIES } from '@canopy/protocol';
import type {
  EnforcedSyncScopes,
  OrganizationDetail,
} from '@canopy/protocol/settings/organization';
import { SettingsOperationError } from '@canopy/protocol/settings/errors';
import {
  createFakeSettingsClient,
  createTestSettingsHost,
  TestSettingsHost,
} from '../../__tests__/helpers/test-settings-host';
import { ORGANIZATION_LAPSED_COPY } from '../organization-known-errors';
import {
  TeamDataSharingSection,
  TeamStatisticsVisibilitySection,
} from '../team-usage-settings-section';

const canopyBrand = {
  id: 'canopy',
  displayName: 'Canopy',
  internalName: 'canopy',
};

/** Every scope the plan can set a policy on (the Enterprise capability set). */
const ALL_CAPABILITIES = [
  'data_sync_control',
  'teams',
  'enforce_sharing_transcripts',
  'enforce_sharing_plans',
  'enforce_sharing_summaries',
  'enforce_sharing_metadata',
];

const UNSET_SCOPES: EnforcedSyncScopes = {
  transcripts: null,
  plans: null,
  metadata: null,
  summaries: null,
};

function makeDetail(
  overrides: Partial<OrganizationDetail> = {},
): OrganizationDetail {
  return {
    id: 'org-123',
    name: 'Acme',
    viewerRole: 'OWNER',
    members: [],
    subTeams: [],
    usageStatsMinRole: 'ADMIN',
    canViewUsageStats: true,
    logoUrl: null,
    githubConnection: { connected: false, accountLogin: null },
    enforceMemberDataSharing: false,
    enforcedSync: { ...UNSET_SCOPES },
    allowExternalContainerSharing: false,
    ...overrides,
  };
}

interface PatchCall {
  url: string;
  body: unknown;
}

/**
 * Keyboard-driven focus. The shared tooltips follow `:focus-visible`: a Tab
 * keydown reaches the document before focus moves, so the tooltip opens. A
 * bare `.focus()` is programmatic focus and keeps it closed.
 */
function focusViaKeyboard(element: HTMLElement | null | undefined): void {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
  );
  element?.focus();
}

describe('TeamDataSharingSection data sharing card', () => {
  let container: HTMLElement;
  let root: Root;
  let onDetailChange: jest.Mock;
  let patches: PatchCall[];
  let capabilities: string[];
  /** Config payload the next PATCH resolves with; `null` fails the request. */
  let nextConfig: Record<string, unknown> | null;
  let configFailure: {
    status: number;
    error: string;
    code?: string;
  } | null;
  /**
   * When set, every `/config` response waits on this gate, so a test can hold a
   * save in flight and assert what the card does while it is pending.
   */
  let configGate: Promise<void> | null;
  let releaseConfigGate: (() => void) | null;
  /** When true, the billing-capability read 500s, so coverage stays unknown. */
  let billingFailure: boolean;
  /**
   * When set, the billing read waits on this gate, so a test can observe the
   * card while plan coverage is still unresolved.
   */
  let billingGate: Promise<void> | null;
  let releaseBillingGate: (() => void) | null;
  let client: ReturnType<typeof createFakeSettingsClient>;

  /** Hold every subsequent `/config` response until {@link releaseConfig}. */
  function holdConfig(): void {
    configGate = new Promise<void>((resolve) => {
      releaseConfigGate = resolve;
    });
  }

  async function releaseConfig(): Promise<void> {
    releaseConfigGate?.();
    configGate = null;
    releaseConfigGate = null;
    await flush();
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onDetailChange = jest.fn();
    patches = [];
    capabilities = [...ALL_CAPABILITIES];
    nextConfig = null;
    configFailure = null;
    configGate = null;
    releaseConfigGate = null;
    billingFailure = false;
    billingGate = null;
    releaseBillingGate = null;

    /**
     * The settings client sends `organizationId` with the patch fields; the
     * recorded body is the fields alone, as the config route received them.
     */
    const recordPatch = (input: unknown): void => {
      const { organizationId, ...body } =
        typeof input === 'object' && input !== null
          ? { organizationId: '', ...input }
          : { organizationId: '' };
      patches.push({
        url: `/api/account/organizations/${String(organizationId)}/config`,
        body,
      });
    };
    const respondConfig = (input: unknown): Promise<unknown> => {
      recordPatch(input);
      // Resolved lazily so a test can swap `nextConfig` while the response is
      // still held by `configGate`.
      const respond = (): unknown => {
        if (configFailure)
          throw new SettingsOperationError({
            code: 'failed',
            status: configFailure.status,
            message: configFailure.error,
            ...(configFailure.code !== undefined
              ? { serverCode: configFailure.code }
              : {}),
          });
        return (
          nextConfig ?? {
            usageStatsMinRole: 'ADMIN',
            enforceMemberDataSharing: true,
            enforceMemberModelPolicy: false,
            blockedModelIds: [],
            reviewedModelIds: [],
            enforceMemberModelGateway: false,
            modelGatewayBaseUrl: null,
            modelGatewayModels: [],
            modelGatewayEnforced: false,
            modelGatewayPromptCachePassthrough: true,
            enforcedSync: { ...UNSET_SCOPES },
          }
        );
      };
      return configGate
        ? configGate.then(respond)
        : Promise.resolve().then(respond);
    };
    const respondBilling = (): unknown => {
      if (billingFailure)
        throw new SettingsOperationError({
          code: 'failed',
          status: 500,
          message: 'boom',
        });
      return {
        plan: null,
        status: null,
        trial: null,
        nextBillingDate: null,
        nextBillingAmountUsd: null,
        seatCount: null,
        paymentMethod: null,
        walletBalanceUsd: 0,
        capabilities,
        coverageNotes: [],
      };
    };
    client = createFakeSettingsClient({
      'organization.billing.summary': () =>
        billingGate ? billingGate.then(respondBilling) : respondBilling(),
      'organization.settings.policies.update': respondConfig,
      'organization.settings.usage.update': respondConfig,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  /** Drain the pending fetch/state chain and let React commit the result. */
  async function flush(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function render(
    detail: OrganizationDetail = makeDetail(),
  ): Promise<void> {
    await act(async () => {
      root.render(
        <TestSettingsHost
          host={createTestSettingsHost({ client, brand: canopyBrand }).host}
        >
          <TeamDataSharingSection
            detail={detail}
            onDetailChange={onDetailChange}
          />
        </TestSettingsHost>,
      );
      await Promise.resolve();
    });
    // Let the billing-capability read settle so plan coverage is resolved.
    await flush();
  }

  function find<T extends Element>(testId: string): T | null {
    return document.body.querySelector<T>(`[data-testid="${testId}"]`);
  }

  function require_<T extends Element>(testId: string): T {
    const el = find<T>(testId);
    if (el === null) {
      throw new Error(`Missing [data-testid="${testId}"]`);
    }
    return el;
  }

  async function clickAsync(testId: string): Promise<void> {
    const el = require_<HTMLElement>(testId);
    act(() => {
      el.click();
    });
    await flush();
  }

  it('shows only the enforcement checkbox until it is checked', async () => {
    await render();

    expect(find('enforce-member-data-sharing-checkbox')).not.toBeNull();
    expect(find('enforced-sync-toggle-metadata')).toBeNull();
    expect(find('enforced-sync-toggle-transcripts')).toBeNull();
    expect(find('enforced-sync-pills-metadata')).toBeNull();
  });

  it('expands the scope list when enforcement is on, in least-invasive-first order', async () => {
    await render(
      makeDetail({
        enforceMemberDataSharing: true,
        enforcedSync: {
          metadata: true,
          plans: true,
          summaries: null,
          transcripts: false,
        },
      }),
    );

    for (const scope of ['metadata', 'plans', 'summaries', 'transcripts']) {
      expect(find(`enforced-sync-toggle-${scope}`)).not.toBeNull();
    }
    const rows = Array.from(
      container.querySelectorAll('[data-testid^="enforced-sync-row-"]'),
    ).map((row) => row.getAttribute('data-testid'));
    expect(rows).toEqual([
      'enforced-sync-row-metadata',
      'enforced-sync-row-plans',
      'enforced-sync-row-summaries',
      'enforced-sync-row-transcripts',
    ]);
  });

  it('drops the redundant Activity sharing heading', async () => {
    await render(makeDetail({ enforceMemberDataSharing: true }));

    expect(container.textContent).toContain('Data sharing');
    expect(container.textContent).not.toContain('Activity sharing');
    expect(container.textContent).not.toContain('Required member settings');
  });

  it('names the brand rather than hard-coding the product name', async () => {
    await render();

    expect(container.textContent).toContain(
      `may share with ${canopyBrand.displayName}`,
    );
  });

  // CAN-3561: turning a category off stops it being shared, but basic usage
  // counts (chat turns sent) are collected regardless, so the card must not
  // claim the data never leaves the machine.
  it('says blocked categories are not shared and basic usage is still counted', async () => {
    await render();

    expect(container.textContent).toContain(
      'Anything turned off here is not shared. Basic usage counts are still collected.',
    );
    expect(container.textContent).not.toContain('never leaves their machine');
  });

  it('PATCHes only the master switch, leaving the stored scopes untouched', async () => {
    await render(
      makeDetail({
        enforceMemberDataSharing: true,
        enforcedSync: {
          metadata: true,
          plans: false,
          summaries: false,
          transcripts: false,
        },
      }),
    );
    nextConfig = {
      usageStatsMinRole: 'ADMIN',
      enforceMemberDataSharing: false,
      enforceMemberModelPolicy: false,
      blockedModelIds: [],
      reviewedModelIds: [],
      enforceMemberModelGateway: false,
      modelGatewayBaseUrl: null,
      modelGatewayModels: [],
      modelGatewayEnforced: false,
      modelGatewayPromptCachePassthrough: true,
      enforcedSync: {
        metadata: true,
        plans: false,
        summaries: false,
        transcripts: false,
      },
    };

    await clickAsync('enforce-member-data-sharing-checkbox');

    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({ enforceMemberDataSharing: false });
    expect(onDetailChange).toHaveBeenCalledWith(
      expect.objectContaining({
        enforceMemberDataSharing: false,
        enforcedSync: {
          metadata: true,
          plans: false,
          summaries: false,
          transcripts: false,
        },
      }),
    );
  });

  it('confirms before enforcement is turned on, then PATCHes the master switch', async () => {
    await render();

    await clickAsync('enforce-member-data-sharing-checkbox');
    expect(patches).toHaveLength(0);
    expect(find('enforce-member-data-sharing-confirm-dialog')).not.toBeNull();

    await clickAsync('enforce-member-data-sharing-confirm');

    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({ enforceMemberDataSharing: true });
    expect(find('enforce-member-data-sharing-confirm-dialog')).toBeNull();
  });

  it('PATCHes the full three-state scope map when a scope is toggled', async () => {
    await render(
      makeDetail({
        enforceMemberDataSharing: true,
        enforcedSync: {
          metadata: true,
          plans: null,
          summaries: false,
          transcripts: false,
        },
      }),
    );

    await clickAsync('enforced-sync-toggle-plans');

    expect(patches).toHaveLength(1);
    // The master switch rides along as the route's new-client marker, which is
    // what tells the server this body's `false` means PROHIBITED.
    expect(patches[0].body).toEqual({
      enforceMemberDataSharing: true,
      enforcedSync: {
        metadata: true,
        plans: true,
        summaries: false,
        transcripts: false,
      },
    });
  });

  it('shows an error, never the server text, when a scope save is refused', async () => {
    await render(makeDetail({ enforceMemberDataSharing: true }));
    configFailure = {
      status: 403,
      error: 'Your plan does not include data sharing enforcement for plans',
    };

    await clickAsync('enforced-sync-toggle-plans');

    expect(container.textContent).toContain(
      "Couldn't update data sharing. Try again.",
    );
    expect(container.textContent).not.toContain(
      'Your plan does not include data sharing enforcement for plans',
    );
  });

  it('says the organization has no active plan when the save is refused as lapsed', async () => {
    await render(makeDetail({ enforceMemberDataSharing: true }));
    configFailure = {
      status: 403,
      error: 'SENTINEL-SERVER-BODY',
      code: 'org_teams_lapsed',
    };

    await clickAsync('enforced-sync-toggle-plans');

    expect(container.textContent).toContain(ORGANIZATION_LAPSED_COPY);
    expect(container.textContent).not.toContain('SENTINEL-SERVER-BODY');
  });

  it('flips the pill caption from Powers to Enables with the stored value', async () => {
    await render(
      makeDetail({
        enforceMemberDataSharing: true,
        enforcedSync: {
          metadata: true,
          plans: false,
          summaries: null,
          transcripts: null,
        },
      }),
    );

    expect(require_('enforced-sync-pills-metadata').textContent).toContain(
      'Powers',
    );
    expect(require_('enforced-sync-pills-plans').textContent).toContain(
      'Enables',
    );
    // Unset is not "required": while enforcement is on it saves as prohibited,
    // so it reads as what sharing would enable, not as a share.
    expect(require_('enforced-sync-pills-summaries').textContent).toContain(
      'Enables',
    );
  });

  it('flags a dependent scope that is on while usage metadata is blocked', async () => {
    await render(
      makeDetail({
        enforceMemberDataSharing: true,
        enforcedSync: {
          metadata: false,
          plans: true,
          summaries: null,
          transcripts: null,
        },
      }),
    );

    expect(require_('enforced-sync-dependency-plans').textContent).toContain(
      'Usage metadata',
    );
    // Unset is not on, so there is no silent failure to warn about.
    expect(find('enforced-sync-dependency-summaries')).toBeNull();
    expect(find('enforced-sync-dependency-metadata')).toBeNull();
  });

  it('does not flag dependents while usage metadata is merely unset', async () => {
    await render(
      makeDetail({
        enforceMemberDataSharing: true,
        enforcedSync: {
          metadata: null,
          plans: true,
          summaries: null,
          transcripts: null,
        },
      }),
    );

    expect(find('enforced-sync-dependency-plans')).toBeNull();
  });

  it('confirms before usage metadata is blocked', async () => {
    await render(
      makeDetail({
        enforceMemberDataSharing: true,
        enforcedSync: { ...UNSET_SCOPES, metadata: true },
      }),
    );

    await clickAsync('enforced-sync-toggle-metadata');
    expect(patches).toHaveLength(0);
    expect(find('prohibit-metadata-confirm-dialog')).not.toBeNull();

    await clickAsync('prohibit-metadata-confirm');

    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({
      enforceMemberDataSharing: true,
      enforcedSync: { ...UNSET_SCOPES, metadata: false },
    });
    expect(find('prohibit-metadata-confirm-dialog')).toBeNull();
  });

  it('does not confirm before transcripts, plans, or summaries are blocked', async () => {
    await render(
      makeDetail({
        enforceMemberDataSharing: true,
        enforcedSync: {
          metadata: true,
          plans: true,
          summaries: true,
          transcripts: true,
        },
      }),
    );

    await clickAsync('enforced-sync-toggle-transcripts');

    expect(find('prohibit-metadata-confirm-dialog')).toBeNull();
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({
      enforceMemberDataSharing: true,
      enforcedSync: {
        metadata: true,
        plans: true,
        summaries: true,
        transcripts: false,
      },
    });
  });

  it('renders an uncovered scope force-enabled with an upgrade affordance', async () => {
    capabilities = [
      'enforce_sharing_transcripts',
      'enforce_sharing_plans',
      'enforce_sharing_summaries',
    ];
    await render(
      makeDetail({
        enforceMemberDataSharing: true,
        enforcedSync: { ...UNSET_SCOPES, metadata: true },
      }),
    );

    // The locked row keeps a switch in the same column as every other row, so
    // the control axis stays aligned; only its state says "you can't set this".
    const locked = require_<HTMLButtonElement>('enforced-sync-toggle-metadata');
    expect(locked.getAttribute('role')).toBe('switch');
    expect(locked.getAttribute('aria-disabled')).toBe('true');
    // Natively disabled would drop it out of the tab order and kill the hover
    // events the tooltip depends on.
    expect(locked.disabled).toBe(false);
    // The locked state is folded into the accessible name, so the switch does
    // not merely announce "on" - which would read as a policy the admin set.
    // What the plan withholds is the ability to turn the scope OFF, so the name
    // has to say the sharing is fixed rather than chosen.
    expect(locked.getAttribute('aria-label')).toBe(
      'Share Usage metadata (always on for your plan)',
    );
    // A covered scope stays a plain interactive switch.
    const covered = require_<HTMLButtonElement>(
      'enforced-sync-toggle-transcripts',
    );
    expect(covered.hasAttribute('aria-disabled')).toBe(false);

    // Nothing renders under the description but the row's own pills. The
    // locked state is carried entirely by the lock glyph, the dimmed switch,
    // and the tooltip - no note, and no in-row upgrade link.
    expect(find('enforced-sync-locked-metadata')).toBeNull();
    expect(find('enforced-sync-upgrade-metadata')).toBeNull();
    expect(require_('enforced-sync-row-metadata').textContent).not.toContain(
      'Not included in your plan',
    );

    // The tooltip is the only upgrade path.
    await act(async () => {
      focusViaKeyboard(locked);
      await Promise.resolve();
    });
    const tooltip = document.body.querySelector('[role="tooltip"]');
    expect(tooltip).not.toBeNull();
    expect(tooltip?.textContent).toContain(
      "Your plan doesn't support turning off usage metadata sharing.",
    );
    // The tooltip's explanation must actually be associated with the switch.
    // `attachTooltipDescription` clones `aria-describedby` onto the component
    // boundary, so `ScopeSwitch` has to forward it onto the real `<button>` -
    // otherwise it is dropped with no type error and no React warning.
    expect(locked.getAttribute('aria-describedby')).toBe(tooltip?.id);
    expect(tooltip?.id).toBeTruthy();
    const upgrade = tooltip?.querySelector('a');
    expect(upgrade?.getAttribute('href')).toBe(
      '/organization/org-123/settings?tab=billing',
    );
    // The CTA names the tier that actually grants `enforce_sharing_metadata`,
    // derived from the catalog rather than hardcoded, so it keeps pointing at
    // the cheapest plan that unlocks the control if the capability moves down.
    expect(upgrade?.textContent).toBe('Upgrade to Enterprise');
    // An in-app billing route must navigate in the same tab.
    expect(upgrade?.hasAttribute('target')).toBe(false);

    // Force-enabled means live pills, not struck-through ones.
    expect(require_('enforced-sync-pills-metadata').textContent).toContain(
      'Powers',
    );
  });

  it('never leaks a locked row’s forced-on position into the PATCH body', async () => {
    // The metadata row renders `on` for a Business org, but that position is
    // projected, not stored. The body is rebased on `latestConfigRef`, so
    // metadata must go out as the stored `null` - sending `true` would be the
    // card writing a requirement the admin never set, and on an uncovered
    // scope `updateOrganizationConfig` would 403 it.
    capabilities = [
      'enforce_sharing_transcripts',
      'enforce_sharing_plans',
      'enforce_sharing_summaries',
    ];
    await render(
      makeDetail({
        enforceMemberDataSharing: true,
        enforcedSync: { ...UNSET_SCOPES },
      }),
    );

    expect(
      require_('enforced-sync-toggle-metadata').getAttribute('aria-checked'),
    ).toBe('true');

    await clickAsync('enforced-sync-toggle-transcripts');

    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({
      enforceMemberDataSharing: true,
      enforcedSync: {
        transcripts: true,
        plans: null,
        summaries: null,
        metadata: null,
      },
    });
  });

  it('does not force-enable anything for a plan that grants no enforcement', async () => {
    // The paywall must not invert. A zero-capability org enforces nothing in
    // either direction, so its rows read as the member's own choice - claiming
    // "always on" here would be the same over-claim this card was rewritten to
    // remove, just in a different tier.
    capabilities = [];
    await render(
      makeDetail({
        enforceMemberDataSharing: true,
        enforcedSync: { ...UNSET_SCOPES },
      }),
    );

    const locked = require_<HTMLButtonElement>('enforced-sync-toggle-metadata');
    expect(locked.getAttribute('aria-checked')).toBe('false');
    expect(locked.getAttribute('aria-label')).toBe(
      'Share Usage metadata (not included in your plan; each member chooses)',
    );
    await act(async () => {
      focusViaKeyboard(locked);
      await Promise.resolve();
    });
    expect(
      document.body.querySelector(`#${locked.getAttribute('aria-describedby')}`)
        ?.textContent,
    ).toContain(
      "Your plan doesn't include a data sharing policy, so each member chooses usage metadata for themselves.",
    );
  });

  it('discloses which scopes enforcement will force on before enabling it', async () => {
    // The one dialog gating the escalation. An admin turning enforcement on to
    // BLOCK transcripts would otherwise force-share usage metadata without ever
    // being told.
    capabilities = [
      'enforce_sharing_transcripts',
      'enforce_sharing_plans',
      'enforce_sharing_summaries',
    ];
    await render(makeDetail({ enforceMemberDataSharing: false }));

    await clickAsync('enforce-member-data-sharing-checkbox');

    expect(
      require_('enforce-member-data-sharing-confirm-dialog').textContent,
    ).toContain(
      "Your plan can't turn off usage metadata, so it stays on for everyone.",
    );
  });

  it('paints no switch position until the plan read resolves', async () => {
    // Rendering the optimistic full-coverage fallback while the request is
    // still running would flash a Business org's metadata row as an
    // interactive OFF switch - "your org is not sharing usage metadata" - which
    // is the exact claim this card was rewritten to stop making.
    capabilities = [
      'enforce_sharing_transcripts',
      'enforce_sharing_plans',
      'enforce_sharing_summaries',
    ];

    // Held open, so the billing read is genuinely still in flight when these
    // assertions run rather than having resolved inside `act`.
    billingGate = new Promise<void>((resolve) => {
      releaseBillingGate = resolve;
    });
    await act(async () => {
      root.render(
        <TestSettingsHost
          host={createTestSettingsHost({ client, brand: canopyBrand }).host}
        >
          <TeamDataSharingSection
            detail={makeDetail({
              enforceMemberDataSharing: true,
              enforcedSync: { ...UNSET_SCOPES },
            })}
            onDetailChange={onDetailChange}
          />
        </TestSettingsHost>,
      );
      await Promise.resolve();
    });

    expect(find('enforced-sync-coverage-pending')).not.toBeNull();
    expect(find('enforced-sync-toggle-metadata')).toBeNull();
    // ...and the master switch cannot open a dialog that has nothing to say.
    expect(
      require_<HTMLInputElement>('enforce-member-data-sharing-checkbox')
        .disabled,
    ).toBe(true);

    releaseBillingGate?.();
    billingGate = null;
    await flush();

    expect(find('enforced-sync-coverage-pending')).toBeNull();
    expect(
      require_('enforced-sync-toggle-metadata').getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('locks no row and offers no upgrade for the capabilities free access grants (CAN-3926)', async () => {
    capabilities = [...BILLING_CAPABILITIES];
    await render(
      makeDetail({
        enforceMemberDataSharing: true,
        enforcedSync: { ...UNSET_SCOPES, metadata: true, plans: false },
      }),
    );

    for (const scope of ['transcripts', 'plans', 'metadata', 'summaries']) {
      expect(
        require_(`enforced-sync-toggle-${scope}`).hasAttribute('aria-disabled'),
      ).toBe(false);
    }
    expect(document.body.textContent).not.toContain('Upgrade');
    expect(document.body.textContent).not.toContain('your plan');
  });

  it('says it is loading settings while the read is in flight', async () => {
    billingGate = new Promise<void>((resolve) => {
      releaseBillingGate = resolve;
    });
    await act(async () => {
      root.render(
        <TestSettingsHost
          host={createTestSettingsHost({ client, brand: canopyBrand }).host}
        >
          <TeamDataSharingSection
            detail={makeDetail({ enforceMemberDataSharing: true })}
            onDetailChange={onDetailChange}
          />
        </TestSettingsHost>,
      );
      await Promise.resolve();
    });

    const pending = require_('enforced-sync-coverage-pending');
    expect(
      pending.querySelector('[data-testid="settings-skeleton-form"]'),
    ).not.toBeNull();
    // Only the skeleton's screen-reader status; no visible loading copy.
    expect(pending.textContent).toBe('Loading');

    releaseBillingGate?.();
    billingGate = null;
    await flush();
  });

  it('says the plan is unknown rather than nothing when the billing read fails', async () => {
    // The disclosure must not disappear in the one case where the admin has the
    // least idea what they are agreeing to. An unread plan yields an EMPTY
    // forced-scope list, so without its own branch the dialog would silently
    // drop the sentence while the server still force-enables on save.
    billingFailure = true;
    await render(makeDetail({ enforceMemberDataSharing: false }));

    expect(
      document.body.querySelector('[role="alert"]')?.textContent,
    ).toContain("Couldn't load this.");

    await clickAsync('enforce-member-data-sharing-checkbox');
    expect(
      require_('enforce-member-data-sharing-confirm-dialog').textContent,
    ).toContain(
      "We couldn't load these settings, so some categories may be turned on for everyone.",
    );
  });

  it('keeps the plan-read warning through a save that did not resolve it', async () => {
    // Both save paths clear the save-error slot on entry. Sharing one slot with
    // the coverage warning meant the first toggle silently erased a condition
    // nothing had fixed, leaving every row rendered as covered and editable.
    billingFailure = true;
    await render(
      makeDetail({
        enforceMemberDataSharing: true,
        enforcedSync: { ...UNSET_SCOPES },
      }),
    );

    await clickAsync('enforced-sync-toggle-transcripts');

    const alerts = Array.from(document.body.querySelectorAll('[role="alert"]'));
    expect(alerts.map((node) => node.textContent).join(' ')).toContain(
      "Couldn't load this.",
    );
  });

  it('reads the plan again on Retry after a failed read', async () => {
    billingFailure = true;
    await render(makeDetail({ enforceMemberDataSharing: false }));
    expect(
      document.body.querySelector('[role="alert"]')?.textContent,
    ).toContain("Couldn't load this.");

    billingFailure = false;
    const retry = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Try again',
    );
    expect(retry).toBeDefined();
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });
    await flush();

    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  });

  it('omits the force-on disclosure when the plan covers every scope', async () => {
    await render(makeDetail({ enforceMemberDataSharing: false }));

    await clickAsync('enforce-member-data-sharing-checkbox');

    const dialog = require_('enforce-member-data-sharing-confirm-dialog');
    expect(dialog.textContent).toContain('They can see the policy but not');
    expect(dialog.textContent).not.toContain('stay on for everyone');
  });

  it('names each locked row its own cheapest unlocking tier', async () => {
    // A plan with no enforcement capabilities at all: every row is locked, and
    // the two rows do NOT resolve to the same upgrade. Transcripts is unlocked
    // by Business, metadata only by Enterprise, so a single hardcoded tier in
    // the CTA would send one of these admins to a plan that does not help.
    capabilities = [];
    await render(
      makeDetail({
        enforceMemberDataSharing: true,
        enforcedSync: { ...UNSET_SCOPES },
      }),
    );

    const ctaFor = async (scope: string): Promise<string | undefined> => {
      const toggle = require_<HTMLButtonElement>(
        `enforced-sync-toggle-${scope}`,
      );
      await act(async () => {
        focusViaKeyboard(toggle);
        await Promise.resolve();
      });
      // Resolved through the switch's own `aria-describedby` rather than a bare
      // `[role="tooltip"]` body query: the latter passes only as long as the
      // previous row's tooltip has already unmounted on blur, which makes the
      // assertion depend on call order rather than on the row under test.
      return (
        document.body
          .querySelector(`#${toggle.getAttribute('aria-describedby')}`)
          ?.querySelector('a')?.textContent ?? undefined
      );
    };

    expect(await ctaFor('transcripts')).toBe('Upgrade to Business');
    expect(await ctaFor('metadata')).toBe('Upgrade to Enterprise');
  });

  it('reflects the stored value on a locked switch and never saves from it', async () => {
    capabilities = [
      'enforce_sharing_transcripts',
      'enforce_sharing_plans',
      'enforce_sharing_summaries',
    ];
    await render(
      makeDetail({
        enforceMemberDataSharing: true,
        enforcedSync: { ...UNSET_SCOPES, metadata: true },
      }),
    );

    expect(
      require_('enforced-sync-toggle-metadata').getAttribute('aria-checked'),
    ).toBe('true');

    // Clicking a locked switch is inert: no PATCH, no optimistic flip.
    await clickAsync('enforced-sync-toggle-metadata');
    expect(patches).toHaveLength(0);
    expect(
      require_('enforced-sync-toggle-metadata').getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('renders an unset locked scope force-enabled, not off', async () => {
    capabilities = [
      'enforce_sharing_transcripts',
      'enforce_sharing_plans',
      'enforce_sharing_summaries',
    ];
    await render(
      makeDetail({
        enforceMemberDataSharing: true,
        enforcedSync: { ...UNSET_SCOPES },
      }),
    );

    // An off-looking locked switch would tell the admin their org is not
    // sharing usage metadata, when in fact they have no way to stop it. On,
    // locked, with the live pills that come with it.
    expect(
      require_('enforced-sync-toggle-metadata').getAttribute('aria-checked'),
    ).toBe('true');
    expect(require_('enforced-sync-pills-metadata').textContent).toContain(
      'Powers',
    );
  });

  it('renders an uncovered row identically to a covered one apart from the lock', async () => {
    capabilities = [
      'enforce_sharing_transcripts',
      'enforce_sharing_plans',
      'enforce_sharing_summaries',
    ];
    await render(
      makeDetail({
        enforceMemberDataSharing: true,
        enforcedSync: { ...UNSET_SCOPES, transcripts: false },
      }),
    );

    // Title, description, pills - the same three parts, in the same order, as
    // every covered row. Coverage changes the switch and nothing else, so the
    // four rows stay scannable as one list.
    const locked = require_('enforced-sync-row-metadata');
    const covered = require_('enforced-sync-row-transcripts');
    // Direct children only. Descending further would compare individual pill
    // labels, which legitimately differ per scope.
    const shape = (row: Element): string[] =>
      Array.from(row.children).map((node) => {
        const testId = node.getAttribute('data-testid');
        return testId === null
          ? node.tagName
          : `${node.tagName}:${testId.replace(/-(metadata|transcripts)$/, '')}`;
      });
    expect(shape(locked)).toEqual(shape(covered));

    expect(locked.textContent).toContain(
      'Token counts, cost, timing, tool usage, branch/repo/PR names, billed provider account.',
    );
    // No note, no inline CTA - the two things that used to make this row taller
    // and differently shaped than its neighbours.
    expect(locked.textContent).not.toContain('Not included in your plan');
    expect(locked.textContent).not.toContain('Each member chooses');
    expect(locked.querySelector('a')).toBeNull();
    expect(find('enforced-sync-upgrade-metadata')).toBeNull();
    // Pills follow each row's own position, which is where coverage does show
    // through: the uncovered row is force-enabled (live pills), the covered row
    // carries a real prohibition (muted Enables pills).
    expect(require_('enforced-sync-pills-metadata').textContent).toContain(
      'Powers',
    );
    expect(require_('enforced-sync-pills-transcripts').textContent).toContain(
      'Enables',
    );

    // The one real difference: the switch is locked, and its tooltip says why.
    await act(async () => {
      focusViaKeyboard(
        require_<HTMLButtonElement>('enforced-sync-toggle-metadata'),
      );
      await Promise.resolve();
    });
    const tooltip = document.body.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toContain(
      "Your plan doesn't support turning off usage metadata sharing.",
    );
    expect(tooltip?.textContent).not.toContain('Each member chooses');
    expect(tooltip?.textContent).not.toContain('chooses for themselves');
  });

  it('keeps a stored policy on an uncovered scope legible', async () => {
    capabilities = [
      'enforce_sharing_transcripts',
      'enforce_sharing_plans',
      'enforce_sharing_summaries',
    ];
    await render(
      makeDetail({
        enforceMemberDataSharing: true,
        enforcedSync: { ...UNSET_SCOPES, metadata: false },
      }),
    );

    // Prohibitions survive a downgrade, so an uncovered `false` is real and
    // still reads as blocked.
    expect(require_('enforced-sync-pills-metadata').textContent).toContain(
      'Enables',
    );

    // The row still says nothing beyond its description and its pills - the
    // "this is still enforced" fact lives in the switch's accessible name and
    // its tooltip, not in prose under the description.
    expect(find('enforced-sync-locked-metadata')).toBeNull();
    expect(find('enforced-sync-upgrade-metadata')).toBeNull();
    expect(require_('enforced-sync-row-metadata').textContent).not.toContain(
      'Not included in your plan',
    );
    // A surviving prohibition is the ONE locked row that is not force-enabled.
    // `buildOrgEnforcedSettings` keeps an uncovered prohibition
    // (`prohibitedScopes.x = column === false`) while dropping an uncovered
    // requirement, so flipping this row on would claim the org resumed
    // uploading data it never resumed uploading.
    const locked = require_<HTMLButtonElement>('enforced-sync-toggle-metadata');
    expect(locked.getAttribute('aria-checked')).toBe('false');
    expect(locked.getAttribute('aria-label')).toBe(
      "Share Usage metadata (blocked; your plan can't change it)",
    );

    // ...and the tooltip must NOT claim members get to choose.
    await act(async () => {
      locked.focus();
      await Promise.resolve();
    });
    const tooltip = document.body.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toContain(
      'Your plan no longer includes this policy, but usage metadata stays blocked for every member.',
    );
    expect(tooltip?.querySelector('a')?.textContent).toBe(
      'Upgrade to Enterprise',
    );
    expect(tooltip?.textContent).not.toContain('Each member chooses');
  });

  it('keeps the locked copy grammatical for the plural scope labels', async () => {
    // Three of the four labels are plural ("Plans", "Transcripts", "Session
    // summaries"), so any locked string that makes the label its sentence
    // subject reads "Plans is blocked". Metadata is the only label that hides
    // that bug, and it was the only one under test.
    capabilities = [];
    await render(
      makeDetail({
        enforceMemberDataSharing: true,
        enforcedSync: { ...UNSET_SCOPES, plans: false, transcripts: false },
      }),
    );

    for (const scope of ['plans', 'transcripts', 'summaries', 'metadata']) {
      const toggle = require_<HTMLButtonElement>(
        `enforced-sync-toggle-${scope}`,
      );
      await act(async () => {
        toggle.focus();
        await Promise.resolve();
      });
      // Scoped through `aria-describedby` rather than a bare body query, so a
      // stale tooltip from the previous iteration cannot satisfy the assertion.
      const tooltip = document.body.querySelector(
        `#${toggle.getAttribute('aria-describedby')}`,
      );
      // Case-insensitive: every tooltip interpolates `label.toLowerCase()`,
      // so a capitalised alternation would leave two of the three labels
      // matching nothing and a `${lower} is` regression sailing through.
      expect(tooltip?.textContent).not.toMatch(
        /\b(plans|transcripts|summaries) is\b/i,
      );
    }
  });

  it('freezes every scope row and the master switch while a save is in flight', async () => {
    await render(
      makeDetail({
        enforceMemberDataSharing: true,
        enforcedSync: {
          metadata: true,
          plans: null,
          summaries: null,
          transcripts: null,
        },
      }),
    );
    holdConfig();

    await clickAsync('enforced-sync-toggle-plans');

    expect(patches).toHaveLength(1);
    expect(
      require_<HTMLButtonElement>('enforced-sync-toggle-summaries').disabled,
    ).toBe(true);
    expect(
      require_<HTMLInputElement>('enforce-member-data-sharing-checkbox')
        .disabled,
    ).toBe(true);

    // A second toggle mid-flight would send the first scope's PRE-toggle value
    // back and revert it, so it must not be reachable at all.
    await clickAsync('enforced-sync-toggle-summaries');
    expect(patches).toHaveLength(1);

    await releaseConfig();
    expect(
      require_<HTMLButtonElement>('enforced-sync-toggle-summaries').disabled,
    ).toBe(false);
  });

  it('rebases the next scope PATCH on the last server config, not the render-time props', async () => {
    // `onDetailChange` is a jest.fn here, so props never move — the same
    // situation as a response landing before the parent re-renders.
    await render(
      makeDetail({
        enforceMemberDataSharing: true,
        enforcedSync: { ...UNSET_SCOPES, metadata: true },
      }),
    );
    nextConfig = {
      usageStatsMinRole: 'ADMIN',
      enforceMemberDataSharing: true,
      enforceMemberModelPolicy: false,
      blockedModelIds: [],
      reviewedModelIds: [],
      enforceMemberModelGateway: false,
      modelGatewayBaseUrl: null,
      modelGatewayModels: [],
      modelGatewayEnforced: false,
      modelGatewayPromptCachePassthrough: true,
      enforcedSync: {
        metadata: true,
        plans: true,
        summaries: false,
        transcripts: false,
      },
    };

    await clickAsync('enforced-sync-toggle-plans');
    await clickAsync('enforced-sync-toggle-transcripts');

    expect(patches).toHaveLength(2);
    expect(patches[1].body).toEqual({
      enforceMemberDataSharing: true,
      enforcedSync: {
        metadata: true,
        // Carried forward from the server's response, not reverted to the
        // render-time `null`.
        plans: true,
        summaries: false,
        transcripts: true,
      },
    });
  });

  describe('sharing outside the organization', () => {
    function configResponse(
      allowExternalContainerSharing: boolean,
    ): Record<string, unknown> {
      return {
        usageStatsMinRole: 'ADMIN',
        allowExternalContainerSharing,
        enforceMemberDataSharing: false,
        enforceMemberModelPolicy: false,
        blockedModelIds: [],
        reviewedModelIds: [],
        enforceMemberModelGateway: false,
        modelGatewayBaseUrl: null,
        modelGatewayModels: [],
        modelGatewayEnforced: false,
        modelGatewayPromptCachePassthrough: true,
        enforcedSync: { ...UNSET_SCOPES },
      };
    }

    it('renders the toggle off by default with its label and helper text', async () => {
      await render();

      const toggle = require_<HTMLButtonElement>(
        'allow-external-container-sharing-checkbox',
      );
      expect(toggle.getAttribute('aria-checked')).toBe('false');
      expect(toggle.disabled).toBe(false);
      expect(container.textContent).toContain(
        'Allow sharing outside the organization',
      );
      expect(container.textContent).toContain(
        'Members can share worktrees and Cowork work by email with people outside this organization.',
      );
    });

    it('renders the toggle on when the organization allows it', async () => {
      await render(makeDetail({ allowExternalContainerSharing: true }));

      expect(
        require_<HTMLButtonElement>(
          'allow-external-container-sharing-checkbox',
        ).getAttribute('aria-checked'),
      ).toBe('true');
    });

    it('stays visible whether or not the data sharing policy is enforced', async () => {
      await render(makeDetail({ enforceMemberDataSharing: true }));

      expect(find('allow-external-container-sharing-checkbox')).not.toBeNull();
    });

    it('is not shown to members who cannot edit organization policies', async () => {
      await render(makeDetail({ viewerRole: 'MEMBER' }));

      expect(find('allow-external-container-sharing-checkbox')).toBeNull();
      expect(find('team-enforced-settings-section')).toBeNull();
    });

    it('PATCHes only the external sharing setting when turned on, without confirming', async () => {
      await render();
      nextConfig = configResponse(true);

      await clickAsync('allow-external-container-sharing-checkbox');

      expect(find('enforce-member-data-sharing-confirm-dialog')).toBeNull();
      expect(patches).toHaveLength(1);
      expect(patches[0].url).toContain('/organizations/org-123/config');
      expect(patches[0].body).toEqual({ allowExternalContainerSharing: true });
      expect(onDetailChange).toHaveBeenCalledWith(
        expect.objectContaining({
          allowExternalContainerSharing: true,
          // The data sharing policy on the same config row is left alone.
          enforceMemberDataSharing: false,
          enforcedSync: { ...UNSET_SCOPES },
        }),
      );
    });

    it('PATCHes the external sharing setting off when turned off', async () => {
      await render(makeDetail({ allowExternalContainerSharing: true }));
      nextConfig = configResponse(false);

      await clickAsync('allow-external-container-sharing-checkbox');

      expect(patches).toHaveLength(1);
      expect(patches[0].body).toEqual({ allowExternalContainerSharing: false });
      expect(onDetailChange).toHaveBeenCalledWith(
        expect.objectContaining({ allowExternalContainerSharing: false }),
      );
    });

    it('shows an error, never the server text, and keeps the stored value when the save fails', async () => {
      await render();
      configFailure = {
        status: 403,
        error: 'You do not have permission to edit data sharing settings',
      };

      await clickAsync('allow-external-container-sharing-checkbox');

      expect(container.textContent).toContain(
        "Couldn't update sharing outside the organization. Try again.",
      );
      expect(container.textContent).not.toContain(
        'You do not have permission to edit data sharing settings',
      );
      expect(onDetailChange).not.toHaveBeenCalled();
      expect(
        require_<HTMLButtonElement>(
          'allow-external-container-sharing-checkbox',
        ).getAttribute('aria-checked'),
      ).toBe('false');
    });

    it('freezes the card while the external sharing save is in flight', async () => {
      await render(makeDetail({ enforceMemberDataSharing: true }));
      nextConfig = { ...configResponse(true), enforceMemberDataSharing: true };
      holdConfig();

      await clickAsync('allow-external-container-sharing-checkbox');

      expect(patches).toHaveLength(1);
      expect(
        require_<HTMLInputElement>('allow-external-container-sharing-checkbox')
          .disabled,
      ).toBe(true);
      expect(
        require_<HTMLInputElement>('enforce-member-data-sharing-checkbox')
          .disabled,
      ).toBe(true);
      expect(
        require_<HTMLButtonElement>('enforced-sync-toggle-plans').disabled,
      ).toBe(true);

      await releaseConfig();
      expect(
        require_<HTMLInputElement>('allow-external-container-sharing-checkbox')
          .disabled,
      ).toBe(false);
    });
  });
});

it('Statistics role picker renders one shared disclosure indicator', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() => {
      root.render(
        <TestSettingsHost
          host={
            createTestSettingsHost({
              client: createFakeSettingsClient({}),
              brand: canopyBrand,
            }).host
          }
        >
          <TeamStatisticsVisibilitySection
            detail={makeDetail()}
            onDetailChange={jest.fn()}
          />
        </TestSettingsHost>,
      );
    });
    const field = container.querySelector(
      '[data-testid="usage-min-role-field"]',
    );
    expect(field?.textContent).toContain('Who can view usage stats');
    expect(field?.querySelectorAll('svg')).toHaveLength(1);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
