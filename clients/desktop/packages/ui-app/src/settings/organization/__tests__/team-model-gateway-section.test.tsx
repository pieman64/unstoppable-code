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
import { TeamModelGatewaySection } from '../team-model-gateway-section';

const MODEL_GATEWAY_CAPABILITY = 'custom_model_gateway';

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

function readModels(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (row): row is Record<string, unknown> =>
          typeof row === 'object' && row !== null && 'id' in row,
      )
    : [];
}

/**
 * Mirrors `modelGatewayRequiresCapability` in `lib/teams/team-service.ts` so the fake
 * route refuses exactly what the real one refuses. Without it a test can only
 * assert what the card SENDS, and a write the server would 403 reads as a
 * success.
 */
function gatewayRequiresCapability(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  if (next.enforceMemberModelGateway !== true) return false;
  if (current.enforceMemberModelGateway !== true) return true;
  if (next.modelGatewayBaseUrl !== current.modelGatewayBaseUrl) return true;
  if (
    next.modelGatewayPromptCachePassthrough !==
    current.modelGatewayPromptCachePassthrough
  ) {
    return true;
  }
  if (
    current.modelGatewayEnforced !== true &&
    next.modelGatewayEnforced === true
  ) {
    return true;
  }
  const currentModels = readModels(current.modelGatewayModels);
  const nextModels = readModels(next.modelGatewayModels);
  const currentById = new Map(currentModels.map((model) => [model.id, model]));
  if (
    current.modelGatewayEnforced === true &&
    nextModels.length !== currentModels.length
  ) {
    return true;
  }
  return nextModels.some((model) => {
    const currentModel = currentById.get(model.id);
    return (
      currentModel === undefined ||
      JSON.stringify(currentModel) !== JSON.stringify(model)
    );
  });
}

function baseConfig(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
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
      transcripts: null,
      plans: null,
      metadata: null,
      summaries: null,
    },
    ...overrides,
  };
}

const QWEN = {
  id: 'acme-qwen3-coder',
  gatewayId: 'vertex/qwen3-coder',
  label: 'Acme Qwen3 Coder',
  harness: 'codex',
  contextWindow: 256000,
  supportedThinkingLevels: ['medium', 'high'],
  toolSchemaProfile: 'standard',
};

describe('TeamModelGatewaySection', () => {
  let container: HTMLElement;
  let root: Root;
  let patches: PatchCall[];
  let capabilities: string[];
  let config: Record<string, unknown>;
  /** When true, the billing read fails as if the host were offline. */
  let billingFailure: boolean;
  let client: FakeSettingsClient;
  let privacy: { blockClassName: string; maskClassName: string } | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    patches = [];
    capabilities = [MODEL_GATEWAY_CAPABILITY, 'teams'];
    config = baseConfig();

    billingFailure = false;
    privacy = undefined;
    client = createFakeSettingsClient({
      'organization.billing.summary': () => {
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
      },
      'organization.settings.config': () => config,
      'organization.settings.policies.update': (input) => {
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
          gatewayRequiresCapability(config, next) &&
          !capabilities.includes(MODEL_GATEWAY_CAPABILITY)
        ) {
          throw new SettingsOperationError({
            code: 'forbidden',
            status: 403,
            message: 'Your plan does not include a model gateway',
          });
        }
        config = next;
        return config;
      },
    });
  });

  function host(): ReturnType<typeof createTestSettingsHost>['host'] {
    return createTestSettingsHost({ client, privacy }).host;
  }

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
        <TestSettingsHost host={host()}>
          <TeamModelGatewaySection detail={detail} />
        </TestSettingsHost>,
      );
      await Promise.resolve();
    });
    await flush();
  }

  function find(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testId}"]`);
  }

  function findDoc(testId: string): HTMLElement | null {
    return document.body.querySelector(`[data-testid="${testId}"]`);
  }

  function input(testId: string): HTMLInputElement {
    const el = find(testId);
    if (!(el instanceof HTMLInputElement)) {
      throw new Error(`No input for ${testId}`);
    }
    return el;
  }

  async function click(testId: string): Promise<void> {
    const el = findDoc(testId);
    if (!el) throw new Error(`No element for ${testId}`);
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await flush();
  }

  async function type(testId: string, value: string): Promise<void> {
    const el = input(testId);
    await act(async () => {
      // The prototype setter, with the element as receiver, so React's
      // value tracker sees a real change.
      Reflect.set(Object.getPrototypeOf(el), 'value', value, el);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await flush();
  }

  it('renders nothing for a member who cannot edit enforced settings', async () => {
    await render(makeDetail({ viewerRole: 'MEMBER' }));
    expect(find('team-model-gateway-section')).toBeNull();
  });

  it('shows the upsell door, and no configuration, without the capability', async () => {
    capabilities = ['teams'];
    await render();

    expect(find('model-gateway-upgrade-cta')).not.toBeNull();
    expect(find('enforce-member-model-gateway-checkbox')).toBeNull();
    expect(find('model-gateway-model-list')).toBeNull();
  });

  it('lets an entitled admin configure an inactive gateway before enabling it', async () => {
    await render();

    expect(input('enforce-member-model-gateway-checkbox').checked).toBe(false);
    expect(input('enforce-member-model-gateway-checkbox').disabled).toBe(true);
    expect(find('model-gateway-base-url-input')).not.toBeNull();
    expect(find('model-gateway-models-empty')).not.toBeNull();
    expect(patches).toHaveLength(0);
  });

  it('enables a fully configured inactive gateway in one accepted PATCH', async () => {
    config = baseConfig({
      modelGatewayBaseUrl: 'https://gw.acme.test',
      modelGatewayModels: [QWEN],
    });
    await render();

    await click('enforce-member-model-gateway-checkbox');

    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({
      enforceMemberModelGateway: true,
      modelGatewayBaseUrl: 'https://gw.acme.test',
      modelGatewayModels: [QWEN],
      modelGatewayEnforced: false,
      modelGatewayPromptCachePassthrough: true,
    });
  });

  it('trims a trailing slash off the endpoint before saving it', async () => {
    config = baseConfig({ enforceMemberModelGateway: true });
    await render();

    await type('model-gateway-base-url-input', 'https://gw.acme.test/');
    await click('model-gateway-base-url-save');

    expect(patches[0].body.modelGatewayBaseUrl).toBe('https://gw.acme.test');
  });

  it('sends the whole gateway state on every save, not just the changed field', async () => {
    config = baseConfig({
      enforceMemberModelGateway: true,
      modelGatewayBaseUrl: 'https://gw.acme.test',
      modelGatewayModels: [QWEN],
    });
    await render();

    await click('model-gateway-enforced-checkbox');

    expect(patches[0].body).toEqual({
      enforceMemberModelGateway: true,
      modelGatewayBaseUrl: 'https://gw.acme.test',
      modelGatewayModels: [QWEN],
      modelGatewayEnforced: true,
      modelGatewayPromptCachePassthrough: true,
    });
  });

  it('adds a model with an org-namespaced slug and ascending thinking levels', async () => {
    config = baseConfig({
      enforceMemberModelGateway: true,
      modelGatewayBaseUrl: 'https://gw.acme.test',
    });
    await render();

    // The authoring form is a disclosure: the panel shows the catalog first.
    expect(find('model-gateway-add-model')).toBeNull();
    await click('model-gateway-add-model-toggle');

    await type('model-gateway-add-label', 'Acme Qwen3 Coder');
    await type('model-gateway-add-gateway-id', 'vertex/qwen3-coder');
    await type('model-gateway-add-context-window', '256000');
    // Clicked out of order on purpose: desktop rejects a non-ascending set.
    await click('model-gateway-add-thinking-high');
    await click('model-gateway-add-thinking-medium');
    await click('model-gateway-add-submit');

    expect(patches[0].body.modelGatewayModels).toEqual([
      { ...QWEN, id: 'org-123-acme-qwen3-coder' },
    ]);
    expect(find('model-gateway-row-org-123-acme-qwen3-coder')).not.toBeNull();
    // The saved row replaces the form, so the panel does not stay buried
    // under an empty one.
    expect(find('model-gateway-add-model')).toBeNull();
  });

  it('refuses a duplicate name, because the composer only shows the name', async () => {
    config = baseConfig({
      enforceMemberModelGateway: true,
      modelGatewayBaseUrl: 'https://gw.acme.test',
      modelGatewayModels: [QWEN],
    });
    await render();

    await click('model-gateway-add-model-toggle');
    await type('model-gateway-add-label', 'acme qwen3 coder');
    await type('model-gateway-add-gateway-id', 'vertex/other');

    expect(find('model-gateway-add-duplicate')).not.toBeNull();
    expect(
      (find('model-gateway-add-submit') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('confirms before turning a live gateway off', async () => {
    config = baseConfig({
      enforceMemberModelGateway: true,
      modelGatewayBaseUrl: 'https://gw.acme.test',
    });
    await render();

    await click('enforce-member-model-gateway-checkbox');
    expect(patches).toHaveLength(0);
    expect(findDoc('model-gateway-disable-dialog')).not.toBeNull();
  });

  it('keeps a way out when the plan lapsed under a live gateway', async () => {
    capabilities = ['teams'];
    config = baseConfig({
      enforceMemberModelGateway: true,
      modelGatewayBaseUrl: 'https://gw.acme.test',
      modelGatewayEnforced: true,
      modelGatewayModels: [QWEN],
    });
    await render();

    expect(find('model-gateway-relax-only-note')).not.toBeNull();
    // Softening the boundary and turning it off stay live...
    expect(input('model-gateway-enforced-checkbox').disabled).toBe(false);
    expect(input('enforce-member-model-gateway-checkbox').disabled).toBe(false);
    // ...while re-pointing it or dropping a model would 403, so they are inert.
    expect(input('model-gateway-base-url-input').disabled).toBe(true);
    expect(input('model-gateway-prompt-cache-checkbox').disabled).toBe(true);
    // Authoring is locked shut: neither the form nor the way to open it.
    expect(find('model-gateway-add-model')).toBeNull();
    expect(find('model-gateway-add-model-toggle')).toBeNull();
    expect(
      (find('model-gateway-remove-acme-qwen3-coder') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('lets a lapsed additive gateway remove models but not add them', async () => {
    capabilities = ['teams'];
    config = baseConfig({
      enforceMemberModelGateway: true,
      modelGatewayBaseUrl: 'https://gw.acme.test',
      modelGatewayEnforced: false,
      modelGatewayModels: [QWEN],
    });
    await render();

    expect(find('model-gateway-add-model')).toBeNull();
    expect(
      (find('model-gateway-remove-acme-qwen3-coder') as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it('never treats an unresolved plan read as entitled', async () => {
    billingFailure = true;

    await render();

    expect(find('enforce-member-model-gateway-checkbox')).toBeNull();
    expect(find('model-gateway-upgrade-cta')).not.toBeNull();
  });

  /* ---- Free access (CAN-3926) ------------------------------------------ */

  /**
   * A billing read that fails, keeping the config read. Returns whether the
   * card attempted the billing read at all.
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
    await render();

    expect(find('model-gateway-upgrade-cta')).toBeNull();
    expect(find('model-gateway-relax-only-upgrade')).toBeNull();
    expect(find('enforce-member-model-gateway-checkbox')).not.toBeNull();
    expect(container.textContent).not.toContain('Upgrade');
  });

  it('never paints the upgrade door with free access on, even when the plan read fails', async () => {
    const billingWasRead = failBillingRead();
    await act(async () => {
      root.render(
        <TestSettingsHost host={host()}>
          <TeamModelGatewaySection detail={makeDetail()} freeAccess />
        </TestSettingsHost>,
      );
      await Promise.resolve();
    });
    await flush();

    expect(find('model-gateway-upgrade-cta')).toBeNull();
    expect(container.textContent).not.toContain('Upgrade');
    expect(find('enforce-member-model-gateway-checkbox')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(billingWasRead()).toBe(false);
  });

  it('says it is loading settings and reports a failed read plainly', async () => {
    failBillingRead();
    // A synchronous act paints the first frame before either read settles.
    act(() => {
      root.render(
        <TestSettingsHost host={host()}>
          <TeamModelGatewaySection detail={makeDetail()} />
        </TestSettingsHost>,
      );
    });
    expect(
      find('model-gateway-pending')?.querySelector(
        '[data-testid="settings-skeleton-form"]',
      ),
    ).not.toBeNull();
    expect(find('model-gateway-pending')?.textContent).toBe('Loading');
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't load this.",
    );

    // Retry clears the error and reads again; the card settles this time.
    billingFailure = false;
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Try again',
    );
    expect(retry).toBeDefined();
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });
    await flush();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(find('enforce-member-model-gateway-checkbox')).not.toBeNull();
  });

  /* ---- Replay privacy ---------------------------------------------------- */

  it('masks the gateway endpoint from session replay', async () => {
    privacy = { blockClassName: 'replay-block', maskClassName: 'replay-mask' };
    config = baseConfig({
      enforceMemberModelGateway: true,
      modelGatewayBaseUrl: 'https://gw.acme.test',
      modelGatewayModels: [QWEN],
    });
    await render();

    const input = find('model-gateway-base-url-input');
    expect(input?.classList.contains('replay-mask')).toBe(true);
  });

  it('adds no class token for the endpoint when the host records no replay', async () => {
    config = baseConfig({
      enforceMemberModelGateway: true,
      modelGatewayBaseUrl: 'https://gw.acme.test',
      modelGatewayModels: [QWEN],
    });
    await render();

    const className = find('model-gateway-base-url-input')?.className ?? '';
    expect(className).toBe(className.trim());
    expect(className).not.toContain('  ');
  });
});
