/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BILLING_CAPABILITIES } from '@canopy/protocol';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import { SettingsOperationError } from '@canopy/protocol/settings/errors';
import {
  createFakeSettingsClient,
  createTestSettingsHost,
  TestSettingsHost,
  type FakeSettingsClient,
} from '../../__tests__/helpers/test-settings-host';
import { TeamModelPolicySection } from '../team-model-policy-section';

const MODEL_POLICY_CAPABILITY = 'enforce_model_policy';

const CATALOG = [
  {
    id: 'anthropic/claude-opus-5',
    label: 'Claude Opus 5',
    description: 'Highest-capability Claude model',
  },
  { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'gpt-5.3-codex-spark', label: 'GPT 5.3-Codex-Spark' },
];

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
    ...overrides,
  };
}

interface PatchCall {
  url: string;
  body: Record<string, unknown>;
}

function readIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id) => typeof id === 'string')
    : [];
}

/**
 * The same rule `modelPolicyTightens` applies in `lib/teams/team-service.ts`, so
 * the fake route refuses exactly what the real one refuses. Without it a test
 * can only assert what the card SENDS, and a write the server would 403 reads
 * as a success.
 */
function policyTightens(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  if (next.enforceMemberModelPolicy !== true) {
    return false;
  }
  if (current.enforceMemberModelPolicy !== true) {
    return true;
  }
  const currentBlocked = new Set(readIds(current.blockedModelIds));
  if (readIds(next.blockedModelIds).some((id) => !currentBlocked.has(id))) {
    return true;
  }
  const nextReviewed = new Set(readIds(next.reviewedModelIds));
  return readIds(current.reviewedModelIds).some((id) => !nextReviewed.has(id));
}

describe('TeamModelPolicySection', () => {
  let container: HTMLElement;
  let root: Root;
  let patches: PatchCall[];
  let capabilities: string[];
  let config: Record<string, unknown>;
  let catalog: typeof CATALOG;
  /** When set, the billing read waits on it so a test can observe the card
   *  while entitlement is still unresolved. */
  let billingGate: Promise<void> | null;
  let releaseBillingGate: (() => void) | null;
  /** When true, the billing read fails as if the host were offline. */
  let billingFailure: boolean;
  /** Fails the next policy saves with a sentinel server body. */
  let policyUpdateFailure = false;
  let client: FakeSettingsClient;

  function holdBilling(): void {
    billingGate = new Promise<void>((resolve) => {
      releaseBillingGate = resolve;
    });
  }

  async function releaseBilling(): Promise<void> {
    releaseBillingGate?.();
    billingGate = null;
    releaseBillingGate = null;
    await flush();
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    patches = [];
    capabilities = [MODEL_POLICY_CAPABILITY, 'teams'];
    catalog = [...CATALOG];
    billingGate = null;
    releaseBillingGate = null;
    config = {
      usageStatsMinRole: 'ADMIN',
      enforceMemberDataSharing: false,
      enforceMemberModelPolicy: true,
      blockedModelIds: [],
      reviewedModelIds: CATALOG.map((model) => model.id),
      enforceMemberModelGateway: false,
      modelGatewayBaseUrl: null,
      modelGatewayModels: [],
      modelGatewayEnforced: false,
      modelGatewayPromptCachePassthrough: true,
      enforcedSync: {
        transcripts: null,
        plans: null,
        metadata: null,
        summaries: null,
      },
    };

    billingFailure = false;
    policyUpdateFailure = false;
    const respondBilling = (): unknown => {
      if (billingFailure) throw new Error('offline');
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
      'organization.settings.modelCatalog': () => ({ models: catalog }),
      'organization.billing.summary': () =>
        billingGate ? billingGate.then(respondBilling) : respondBilling(),
      'organization.settings.config': () => config,
      'organization.settings.policies.update': (input) => {
        if (policyUpdateFailure)
          throw new SettingsOperationError({
            code: 'failed',
            status: 500,
            message: 'SENTINEL-SERVER-BODY',
          });
        // The client sends `organizationId` beside the PATCH fields; the
        // recorded body is the fields the config route received.
        const { organizationId, ...body }: Record<string, unknown> =
          typeof input === 'object' && input !== null ? { ...input } : {};
        patches.push({
          url: `/api/account/organizations/${String(organizationId)}/config`,
          body,
        });
        const next = { ...config, ...body };
        if (
          policyTightens(config, next) &&
          !capabilities.includes(MODEL_POLICY_CAPABILITY)
        ) {
          throw new SettingsOperationError({
            code: 'forbidden',
            status: 403,
            message: 'Your plan does not include model policy enforcement',
          });
        }
        // Echo the request onto the stored config the way the service does.
        config = next;
        return config;
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

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
        <TestSettingsHost host={createTestSettingsHost({ client }).host}>
          <TeamModelPolicySection detail={detail} />
        </TestSettingsHost>,
      );
      await Promise.resolve();
    });
    await flush();
  }

  function find(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testId}"]`);
  }

  /** The same lookup as {@link find}, narrowed to a real `<input>`. */
  function findInput(testId: string): HTMLInputElement {
    const el = find(testId);
    if (!(el instanceof HTMLInputElement)) {
      throw new Error(`Missing input: ${testId}`);
    }
    return el;
  }

  /** Query the whole document: `ConfirmDialog` portals its surface out of `container`. */
  function findDoc(testId: string): HTMLElement | null {
    return document.querySelector(`[data-testid="${testId}"]`);
  }

  async function clickEl(el: HTMLElement | null, label: string): Promise<void> {
    if (!el) {
      throw new Error(`Missing element: ${label}`);
    }
    await act(async () => {
      el.click();
      await Promise.resolve();
    });
    await flush();
  }

  async function click(testId: string): Promise<void> {
    await clickEl(find(testId), testId);
  }

  /** A catalog big enough to paginate (PAGE_SIZE is 15). */
  function bigCatalog(size: number): typeof CATALOG {
    return Array.from({ length: size }, (_unused, index) => ({
      id: `model-${String(index).padStart(2, '0')}`,
      label: `Model ${index}`,
    }));
  }

  it('renders nothing for a member who cannot edit org-enforced settings', async () => {
    await render(makeDetail({ viewerRole: 'MEMBER' }));
    expect(find('team-model-policy-section')).toBeNull();
  });

  it('lists the catalog and marks every reviewed model allowed', async () => {
    await render();

    expect(find('team-model-policy-section')).not.toBeNull();
    expect(find('model-policy-list')).not.toBeNull();
    for (const model of CATALOG) {
      const toggle = find(`model-policy-toggle-${model.id}`);
      expect(toggle?.getAttribute('aria-checked')).toBe('true');
    }
    // No pending review when the stored snapshot covers the whole catalog.
    expect(find('model-policy-pending-review-count')).toBeNull();
  });

  it('records review for the toggled model and leaves the rest of the snapshot alone', async () => {
    // The stored snapshot predates the third model, so a save that touches only
    // the first must not quietly clear the third's "new" state.
    config = {
      ...config,
      reviewedModelIds: [CATALOG[0].id, CATALOG[1].id],
      enforceMemberModelGateway: false,
      modelGatewayBaseUrl: null,
      modelGatewayModels: [],
      modelGatewayEnforced: false,
      modelGatewayPromptCachePassthrough: true,
    };
    await render();
    await click(`model-policy-toggle-${CATALOG[0].id}`);

    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({
      blockedModelIds: ['anthropic/claude-opus-5'],
      reviewedModelIds: [CATALOG[0].id, CATALOG[1].id],
    });
    expect(
      find(`model-policy-toggle-${CATALOG[0].id}`)?.getAttribute(
        'aria-checked',
      ),
    ).toBe('false');
    // The untouched model is still new, still blocked.
    expect(find(`model-policy-new-badge-${CATALOG[2].id}`)).not.toBeNull();
  });

  it('reviews a new model when the admin switches it on', async () => {
    config = {
      ...config,
      reviewedModelIds: [CATALOG[0].id, CATALOG[1].id],
      enforceMemberModelGateway: false,
      modelGatewayBaseUrl: null,
      modelGatewayModels: [],
      modelGatewayEnforced: false,
      modelGatewayPromptCachePassthrough: true,
    };
    await render();
    await click(`model-policy-toggle-${CATALOG[2].id}`);

    expect(patches[0].body.reviewedModelIds).toEqual([
      CATALOG[0].id,
      CATALOG[1].id,
      CATALOG[2].id,
    ]);
    expect(patches[0].body.blockedModelIds).toEqual([]);
    expect(find('model-policy-pending-review-count')).toBeNull();
    expect(
      find(`model-policy-toggle-${CATALOG[2].id}`)?.getAttribute(
        'aria-checked',
      ),
    ).toBe('true');
  });

  it('never reviews models on pages the admin has not opened', async () => {
    // The regression this guards: one toggle on page 1 writing the WHOLE
    // catalog back as reviewed, which unblocks models nobody has looked at.
    const models = bigCatalog(20);
    catalog = models;
    config = { ...config, reviewedModelIds: [], blockedModelIds: [] };
    await render();

    expect(find('model-policy-pending-review-count')?.textContent).toContain(
      '20 new',
    );
    // Page 2 is not even rendered yet.
    expect(find(`model-policy-row-${models[19].id}`)).toBeNull();

    await click(`model-policy-toggle-${models[0].id}`);

    expect(patches).toHaveLength(1);
    expect(patches[0].body.reviewedModelIds).toEqual([models[0].id]);
    expect(find('model-policy-pending-review-count')?.textContent).toContain(
      '19 new',
    );

    await click('model-policy-pager-next');
    expect(find(`model-policy-new-badge-${models[19].id}`)).not.toBeNull();
    expect(
      find(`model-policy-toggle-${models[19].id}`)?.getAttribute(
        'aria-checked',
      ),
    ).toBe('false');
  });

  it('clears the whole backlog only through the confirmed mark-all action', async () => {
    const models = bigCatalog(20);
    catalog = models;
    config = { ...config, reviewedModelIds: [], blockedModelIds: [] };
    await render();

    await click('model-policy-mark-all-reviewed');
    // Opening the confirmation is not itself a review.
    expect(patches).toHaveLength(0);
    expect(findDoc('model-policy-review-all-dialog')).not.toBeNull();
    expect(
      findDoc('model-policy-review-all-dialog')?.textContent ?? '',
    ).toContain('20 models');

    await clickEl(findDoc('confirm-dialog-confirm'), 'confirm-dialog-confirm');

    expect(patches).toHaveLength(1);
    expect(patches[0].body.reviewedModelIds).toEqual(
      models.map((model) => model.id),
    );
    expect(patches[0].body.blockedModelIds).toEqual([]);
    expect(find('model-policy-pending-review-count')).toBeNull();
    expect(find('model-policy-mark-all-reviewed')).toBeNull();
    expect(findDoc('model-policy-review-all-dialog')).toBeNull();
  });

  it('surfaces a model the org has never reviewed as new and blocked', async () => {
    // The stored snapshot predates the third model — exactly what a Canopy
    // release that adds a model does to an enforcing org.
    config = {
      ...config,
      reviewedModelIds: [CATALOG[0].id, CATALOG[1].id],
      enforceMemberModelGateway: false,
      modelGatewayBaseUrl: null,
      modelGatewayModels: [],
      modelGatewayEnforced: false,
      modelGatewayPromptCachePassthrough: true,
    };
    await render();

    expect(find('model-policy-pending-review-count')?.textContent).toContain(
      '1 new',
    );
    expect(find('model-policy-pending-review-note')).not.toBeNull();
    expect(find(`model-policy-new-badge-${CATALOG[2].id}`)).not.toBeNull();
    // Unreviewed means blocked RIGHT NOW, so the switch must read off.
    expect(
      find(`model-policy-toggle-${CATALOG[2].id}`)?.getAttribute(
        'aria-checked',
      ),
    ).toBe('false');
  });

  it('baselines the catalog the first time enforcement is turned on', async () => {
    // Nothing was blocked a moment ago, so an org enabling the policy for the
    // first time gets the current catalog as its starting point rather than a
    // blackout for every member.
    config = {
      ...config,
      enforceMemberModelPolicy: false,
      reviewedModelIds: [],
      enforceMemberModelGateway: false,
      modelGatewayBaseUrl: null,
      modelGatewayModels: [],
      modelGatewayEnforced: false,
      modelGatewayPromptCachePassthrough: true,
    };
    await render();

    expect(find('model-policy-list')).toBeNull();
    await click('enforce-member-model-policy-checkbox');

    expect(patches.map((patch) => patch.body)).toEqual([
      {
        enforceMemberModelPolicy: true,
        reviewedModelIds: CATALOG.map((model) => model.id),
      },
    ]);
    expect(find('model-policy-list')).not.toBeNull();
  });

  it('does not launder unreviewed models into the snapshot on an off/on cycle', async () => {
    // An org that already has a snapshot keeps it verbatim: re-enabling must
    // not become a back door around reviewing the models it has not cleared.
    config = {
      ...config,
      enforceMemberModelPolicy: false,
      reviewedModelIds: [CATALOG[0].id],
      enforceMemberModelGateway: false,
      modelGatewayBaseUrl: null,
      modelGatewayModels: [],
      modelGatewayEnforced: false,
      modelGatewayPromptCachePassthrough: true,
    };
    await render();
    await click('enforce-member-model-policy-checkbox');

    expect(patches[0].body).toEqual({
      enforceMemberModelPolicy: true,
      reviewedModelIds: [CATALOG[0].id],
    });
    expect(find('model-policy-pending-review-count')?.textContent).toContain(
      '2 new',
    );
  });

  it('paints a locked door with an upgrade CTA below the entitled tier', async () => {
    capabilities = ['teams'];
    config = { ...config, enforceMemberModelPolicy: false };
    await render();

    expect(find('model-policy-upgrade-cta')).not.toBeNull();
    expect(find('enforce-member-model-policy-checkbox')).toBeNull();
    // The list never renders for an org with no live policy: an uneditable
    // model list would read as a policy this org has, and it has none.
    expect(find('model-policy-list')).toBeNull();
    expect(find('model-policy-relax-only-note')).toBeNull();
  });

  it('lets a downgraded org that is still enforcing switch the policy all the way off', async () => {
    // The lock-in this closes: enforcement survives a downgrade on purpose, so
    // a door painted over it would leave a live policy with no way out.
    capabilities = ['teams'];
    await render();

    expect(find('model-policy-relax-only-note')).not.toBeNull();
    expect(
      find('model-policy-relax-only-upgrade')?.getAttribute('href'),
    ).toEqual('/organization/org-123/settings?tab=billing');
    const master = findInput('enforce-member-model-policy-checkbox');
    expect(master.disabled).toBe(false);
    expect(master.checked).toBe(true);
    // The list is real here, unlike the painted door.
    expect(find('model-policy-list')).not.toBeNull();
    expect(find('model-policy-upgrade-cta')).toBeNull();

    await click('enforce-member-model-policy-checkbox');

    expect(patches).toHaveLength(1);
    expect(patches[0].body.enforceMemberModelPolicy).toBe(false);
    // Fully off, and now the upsell-only door is the honest state.
    expect(find('model-policy-list')).toBeNull();
    expect(find('model-policy-relax-only-note')).toBeNull();
    expect(find('model-policy-upgrade-cta')).not.toBeNull();
  });

  it('locks the tightening controls for a downgraded org but keeps the relaxing ones', async () => {
    capabilities = ['teams'];
    config = { ...config, blockedModelIds: [CATALOG[1].id] };
    await render();

    // Allowed row: switching it off would add a blocked id, so it is inert.
    const allowedToggle = find(`model-policy-toggle-${CATALOG[0].id}`);
    expect(allowedToggle?.getAttribute('aria-disabled')).toBe('true');
    await click(`model-policy-toggle-${CATALOG[0].id}`);
    expect(patches).toHaveLength(0);
    expect(
      find(`model-policy-toggle-${CATALOG[0].id}`)?.getAttribute(
        'aria-checked',
      ),
    ).toBe('true');

    // Blocked row: switching it on is a relaxation, so it still works.
    const blockedToggle = find(`model-policy-toggle-${CATALOG[1].id}`);
    expect(blockedToggle?.getAttribute('aria-disabled')).toBeNull();
    await click(`model-policy-toggle-${CATALOG[1].id}`);

    expect(patches).toHaveLength(1);
    expect(patches[0].body.blockedModelIds).toEqual([]);
    expect(
      find(`model-policy-toggle-${CATALOG[1].id}`)?.getAttribute(
        'aria-checked',
      ),
    ).toBe('true');
    // And now that it is allowed, it locks like every other allowed row.
    expect(
      find(`model-policy-toggle-${CATALOG[1].id}`)?.getAttribute(
        'aria-disabled',
      ),
    ).toBe('true');
  });

  it('still lets a downgraded org clear its review backlog', async () => {
    // Reviewing is a relaxation, and it is the only way an org that lost the
    // capability can reach models shipped after its last save.
    capabilities = ['teams'];
    config = { ...config, reviewedModelIds: [CATALOG[0].id] };
    await render();

    expect(find('model-policy-pending-review-count')?.textContent).toContain(
      '2 new',
    );
    // A new model is not allowed yet, so its row relaxes rather than locks.
    expect(
      find(`model-policy-toggle-${CATALOG[2].id}`)?.getAttribute(
        'aria-disabled',
      ),
    ).toBeNull();

    await click('model-policy-mark-all-reviewed');
    await clickEl(findDoc('confirm-dialog-confirm'), 'confirm-dialog-confirm');

    expect(patches).toHaveLength(1);
    expect(patches[0].body.reviewedModelIds).toEqual(
      CATALOG.map((model) => model.id),
    );
    expect(find('model-policy-pending-review-count')).toBeNull();
  });

  it('never lets a downgraded org walk into a write its plan will refuse', async () => {
    // The dead end this closes: a new model is blocked by absence from the
    // reviewed snapshot, not by an entry in `blockedModelIds`. Allowing it is a
    // relaxation, so the row is live -- but the moment it IS allowed, switching
    // it back off would add a brand new blocked id, which the server refuses
    // without the capability. The admin would be putting the model back exactly
    // where it started and getting an error for it.
    capabilities = ['teams'];
    config = { ...config, reviewedModelIds: [CATALOG[0].id, CATALOG[1].id] };
    await render();

    const newModel = CATALOG[2];
    expect(find(`model-policy-new-badge-${newModel.id}`)).not.toBeNull();
    expect(
      find(`model-policy-toggle-${newModel.id}`)?.getAttribute('aria-disabled'),
    ).toBeNull();

    await click(`model-policy-toggle-${newModel.id}`);

    expect(patches).toHaveLength(1);
    expect(patches[0].body.reviewedModelIds).toEqual(
      CATALOG.map((model) => model.id),
    );
    expect(
      find(`model-policy-toggle-${newModel.id}`)?.getAttribute('aria-checked'),
    ).toBe('true');

    // Second toggle: the admin changes their mind. It must be inert, not a
    // doomed save -- the row locks like every other allowed row now.
    expect(
      find(`model-policy-toggle-${newModel.id}`)?.getAttribute('aria-disabled'),
    ).toBe('true');
    await click(`model-policy-toggle-${newModel.id}`);

    expect(patches).toHaveLength(1);
    expect(find('team-model-policy-section')?.textContent ?? '').not.toContain(
      'Unable to update the model policy',
    );
    expect(find('team-model-policy-section')?.textContent ?? '').not.toContain(
      'does not include model policy enforcement',
    );
    expect(
      find(`model-policy-toggle-${newModel.id}`)?.getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('states no position while the plan read is still unresolved', async () => {
    // Nothing that makes a CLAIM may render before entitlement resolves:
    // painting the switch optimistically would tell an unentitled org it has a
    // policy, and painting the upgrade door would tell an Enterprise org it
    // does not.
    holdBilling();

    await render();
    expect(find('model-policy-pending')).not.toBeNull();
    expect(find('enforce-member-model-policy-checkbox')).toBeNull();
    expect(find('model-policy-upgrade-cta')).toBeNull();

    await releaseBilling();
    expect(find('enforce-member-model-policy-checkbox')).not.toBeNull();
  });

  /* ---- Free access (CAN-3926) ------------------------------------------ */

  async function renderFree(): Promise<void> {
    await act(async () => {
      root.render(
        <TestSettingsHost host={createTestSettingsHost({ client }).host}>
          <TeamModelPolicySection detail={makeDetail()} freeAccess />
        </TestSettingsHost>,
      );
      await Promise.resolve();
    });
    await flush();
  }

  /**
   * A billing read that fails, keeping the config and catalog reads. Returns
   * whether the card attempted the billing read at all.
   */
  function failBillingRead(): () => boolean {
    billingFailure = true;
    return () =>
      client.calls.some(
        (call) => call.operation === 'organization.billing.summary',
      );
  }

  it('shows no upgrade door for the capabilities free access grants', async () => {
    capabilities = [...BILLING_CAPABILITIES];
    config = { ...config, enforceMemberModelPolicy: false };
    await render();

    expect(find('model-policy-upgrade-cta')).toBeNull();
    expect(find('model-policy-relax-only-upgrade')).toBeNull();
    expect(find('enforce-member-model-policy-checkbox')).not.toBeNull();
    expect(container.textContent).not.toContain('Upgrade');
  });

  it('never paints the upgrade door with free access on, even when the plan read fails', async () => {
    config = { ...config, enforceMemberModelPolicy: false };
    const billingWasRead = failBillingRead();
    await renderFree();

    expect(find('model-policy-upgrade-cta')).toBeNull();
    expect(container.textContent).not.toContain('Upgrade');
    expect(find('enforce-member-model-policy-checkbox')).not.toBeNull();
    // There is no plan to read, so no plan-read error can appear either.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(billingWasRead()).toBe(false);
  });

  it('shows a settings skeleton, not a plan check, while loading', async () => {
    holdBilling();
    await render();

    const pending = find('model-policy-pending');
    expect(
      pending?.querySelector('[data-testid="settings-skeleton-form"]'),
    ).not.toBeNull();
    // Only the skeleton's screen-reader status; no visible loading copy.
    expect(pending?.textContent).toBe('Loading');
    await releaseBilling();
  });

  it('reports a failed read as unloaded settings, then Retry reloads it', async () => {
    failBillingRead();
    await render();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn't load this.");
    expect(alert?.textContent).not.toContain('offline');
    // The card is still waiting on the plan, so it shows no position yet.
    expect(find('enforce-member-model-policy-checkbox')).toBeNull();

    billingFailure = false;
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Try again',
    );
    await clickEl(retry ?? null, 'Try again');

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(find('enforce-member-model-policy-checkbox')).not.toBeNull();
  });

  it('never renders the server text when a save is refused', async () => {
    policyUpdateFailure = true;
    await render();
    await click('enforce-member-model-policy-checkbox');

    expect(container.textContent).toContain(
      "Couldn't update the model policy. Try again.",
    );
    expect(container.textContent).not.toContain('SENTINEL-SERVER-BODY');
  });
});
