/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AgentProviderAuthStatus,
  CanopyCloudAccountPublicState,
  NativeAiCreditsAvailability,
} from '@canopy/desktop-shared/types';
import {
  getRendererBillingLaneAvailability,
  getRendererGuestPrincipal,
  isRendererGuestPrincipalHydrated,
  getRendererBillingLaneFactsVersion,
  getRendererCodexAccountModels,
  resetRendererBillingLaneForTests,
  subscribeRendererBillingLaneFacts,
} from '@/stores/billingLaneRuntime';
import {
  CODEX_ACCOUNT_MODELS,
  clearCodexAccountModels,
} from '@canopy/desktop-shared/types';
import type {
  CodexSpeedCatalog,
  CodexSpeedCatalogModel,
} from '@canopy/desktop-shared/types/codex-speed-capabilities';
import {
  resetCodexSpeedStoreForTests,
  useCodexSpeedStore,
} from '@/stores/codexSpeedStore';
import {
  codexAccountModelIdsFromCatalog,
  useBillingLaneRuntimeSync,
} from '../useBillingLaneRuntimeSync';
import { invalidateClaudeAuthStatusCache } from '../useClaudeAuthStatus';
import { invalidateCodexAuthStatusCache } from '../useCodexAuthStatus';
import { invalidateAiCreditsAvailabilityCache } from '../useAiCreditsAvailability';
import { invalidateSharedAiCreditsRead } from '@/lib/openBillingPage';
import { resetModelLibraryAccessForTests } from '@/lib/modelLibraryAccess';
import { resetAccountProxyStoreForTest } from '@/stores/accountProxyStore';
import type { AccountProxyStatus } from '@canopy/desktop-shared/types/account-proxy';

/** Connected, with one ready Claude account and nothing for Codex. */
const proxyWithClaudeAccount: AccountProxyStatus = {
  available: true,
  connection: { id: 'c1', kind: 'server', url: 'https://proxy.example.com' },
  state: 'connected',
  error: null,
  version: '8.0.27',
  accounts: [
    {
      authIndex: 'a1f3c2d4a1f3c2d4',
      provider: 'claude',
      label: 'Team key',
      source: 'api-key',
      fileName: null,
      planType: null,
      status: 'active',
      statusMessage: null,
      availableAt: null,
      limits: [],
    },
  ],
  routing: null,
  keepChatOnOneAccount: true,
  routeClaude: true,
  routeCodex: true,
  refreshedAt: 1,
  local: {
    phase: 'not-installed',
    version: null,
    install: null,
    port: null,
    startWithApp: true,
    message: null,
  },
  signIn: null,
};

const syncActiveEmptyTabToDefaults = jest.fn(() => Promise.resolve());

jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: (): { syncActiveEmptyTabToDefaults: () => Promise<void> } => ({
      syncActiveEmptyTabToDefaults,
    }),
  },
}));

const signedOut = (provider: string): AgentProviderAuthStatus => ({
  authenticated: false,
  accountLabel: null,
  detail: null,
  error: `${provider} is not authenticated.`,
});

const signedIn = (accountLabel: string): AgentProviderAuthStatus => ({
  authenticated: true,
  accountLabel,
  detail: null,
  error: null,
});

const probeFailed = (provider: string): AgentProviderAuthStatus => ({
  authenticated: false,
  accountLabel: null,
  detail: null,
  error: `Failed to check ${provider} status.`,
  probeFailed: true,
});

const signedOutWithEnvironmentCredential = (
  provider: string,
): AgentProviderAuthStatus => ({
  ...signedOut(provider),
  userSuppliedCredential: true,
});

const noCredits: NativeAiCreditsAvailability = {
  personalEligible: false,
  inOrg: false,
  orgCreditPoolCovered: false,
  orgSpendable: false,
  pricingUrl: 'https://cloud.example.com/pricing',
};

const inconclusiveCredits: NativeAiCreditsAvailability = {
  ...noCredits,
  inconclusive: true,
};

function Harness(): JSX.Element {
  useBillingLaneRuntimeSync();
  return <></>;
}

async function flushAsyncEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('useBillingLaneRuntimeSync', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  const getClaudeAuthStatusMock = jest.fn<
    Promise<AgentProviderAuthStatus>,
    []
  >();
  const getCodexAuthStatusMock = jest.fn<
    Promise<AgentProviderAuthStatus>,
    []
  >();
  const loadNativeAiCreditsAvailabilityMock = jest.fn<
    Promise<NativeAiCreditsAvailability>,
    []
  >();

  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    invalidateClaudeAuthStatusCache();
    invalidateCodexAuthStatusCache();
    invalidateAiCreditsAvailabilityCache();
    invalidateSharedAiCreditsRead();
    resetModelLibraryAccessForTests();
    resetRendererBillingLaneForTests();
    resetAccountProxyStoreForTest();

    getClaudeAuthStatusMock.mockResolvedValue(signedOut('Claude'));
    getCodexAuthStatusMock.mockResolvedValue(signedOut('Codex'));
    loadNativeAiCreditsAvailabilityMock.mockResolvedValue(noCredits);

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getClaudeAuthStatus: getClaudeAuthStatusMock,
        getCodexAuthStatus: getCodexAuthStatusMock,
        loadNativeAiCreditsAvailability: loadNativeAiCreditsAvailabilityMock,
      },
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    invalidateClaudeAuthStatusCache();
    invalidateCodexAuthStatusCache();
    invalidateAiCreditsAvailabilityCache();
    resetRendererBillingLaneForTests();
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  async function mount(): Promise<void> {
    await act(async () => {
      root.render(<Harness />);
      await flushAsyncEffects();
    });
  }

  it('keeps delayed and failed account reads unresolved until guest identity is known', async () => {
    let release: (account: CanopyCloudAccountPublicState) => void = () =>
      undefined;
    const pending = new Promise<CanopyCloudAccountPublicState>((resolve) => {
      release = resolve;
    });
    const loadAccount = jest.fn(() => pending);
    Object.assign(window.api, { loadCanopyCloudAccount: loadAccount });
    await mount();
    expect(isRendererGuestPrincipalHydrated()).toBe(false);
    await act(async () => {
      release({
        hasApiKey: true,
        authMode: null,
        credentialSource: 'guest',
        capabilities: [],
        storageAvailable: true,
      });
      await flushAsyncEffects();
    });
    expect(isRendererGuestPrincipalHydrated()).toBe(true);
    expect(getRendererGuestPrincipal()).toBe(true);
    loadAccount.mockRejectedValueOnce(new Error('account unavailable'));
    await act(async () => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
      await flushAsyncEffects();
    });
    expect(isRendererGuestPrincipalHydrated()).toBe(false);
  });

  it('keeps a confirmed native logout confirmed while the credits read is pending', async () => {
    // The bug: `useProviderAvailability` folds `credits.loading` into each
    // provider's `loading`, so a pending credits read turned a settled
    // signed-out answer back into UNKNOWN — and an UNKNOWN native lane can
    // outrank the credits lane, seeding a credits-only user with an expensive
    // native model.
    let releaseCredits: (value: NativeAiCreditsAvailability) => void = () =>
      undefined;
    loadNativeAiCreditsAvailabilityMock.mockReturnValue(
      new Promise<NativeAiCreditsAvailability>((resolve) => {
        releaseCredits = resolve;
      }),
    );

    await mount();

    expect(getRendererBillingLaneAvailability()).toEqual({
      claudeNativeAuth: false,
      codexNativeAuth: false,
      creditsEligible: undefined,
    });

    await act(async () => {
      releaseCredits({ ...noCredits, personalEligible: true });
      await flushAsyncEffects();
    });

    expect(getRendererBillingLaneAvailability()).toEqual({
      claudeNativeAuth: false,
      codexNativeAuth: false,
      creditsEligible: true,
    });
  });

  it('maps a failed native auth probe to UNKNOWN, not signed out', async () => {
    getClaudeAuthStatusMock.mockResolvedValue(probeFailed('Claude'));
    getCodexAuthStatusMock.mockResolvedValue(signedIn('codex@example.com'));

    await mount();

    expect(getRendererBillingLaneAvailability()).toMatchObject({
      claudeNativeAuth: undefined,
      codexNativeAuth: true,
    });
  });

  it('maps an inconclusive credits read to UNKNOWN rather than "cannot pay"', async () => {
    // `loadNativeAiCreditsAvailability` degrades a transient cloud failure to
    // an all-false payload; recording that as a CONFIRMED negative pinned the
    // credits lane unavailable for the whole session.
    loadNativeAiCreditsAvailabilityMock.mockResolvedValue(inconclusiveCredits);

    await mount();

    expect(
      getRendererBillingLaneAvailability().creditsEligible,
    ).toBeUndefined();
  });

  it('records a settled, conclusive credits negative as CONFIRMED', async () => {
    await mount();

    expect(getRendererBillingLaneAvailability().creditsEligible).toBe(false);
  });

  it('treats an Environments-supplied credential as a live native lane (round-3 finding 1b)', async () => {
    // The probe runs with the Environments injector disabled, so this user
    // reads as signed out here while main ORs the same fact in. Without the
    // fold the renderer showed a dead-end banner and seeded the wrong composer
    // model for a chat whose sends all succeed.
    getClaudeAuthStatusMock.mockResolvedValue(
      signedOutWithEnvironmentCredential('Claude'),
    );

    await mount();

    expect(getRendererBillingLaneAvailability().claudeNativeAuth).toBe(true);
  });

  it('treats a ready account proxy as a live native lane for its harness', async () => {
    // Main's lane resolver counts it the same way (CAN-4020), so a proxy-only
    // user is not shown a "no billing source" warning.
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getClaudeAuthStatus: getClaudeAuthStatusMock,
        getCodexAuthStatus: getCodexAuthStatusMock,
        loadNativeAiCreditsAvailability: loadNativeAiCreditsAvailabilityMock,
        accountProxy: {
          status: (): Promise<AccountProxyStatus> =>
            Promise.resolve(proxyWithClaudeAccount),
          onChanged: (): (() => void) => (): void => undefined,
        },
      },
    });

    await mount();
    await act(async () => {
      await flushAsyncEffects();
    });

    expect(getRendererBillingLaneAvailability()).toMatchObject({
      claudeNativeAuth: true,
      codexNativeAuth: false,
    });
  });

  it('still records a plain confirmed logout as CONFIRMED', async () => {
    getClaudeAuthStatusMock.mockResolvedValue(signedOut('Claude'));

    await mount();

    expect(getRendererBillingLaneAvailability().claudeNativeAuth).toBe(false);
  });

  it('does not bump the facts version for a no-op availability write', async () => {
    // The caller builds a fresh object every effect run, so an identity check
    // is useless — an unconditional bump woke every `useSyncExternalStore`
    // subscriber into a full `resolveLaneForTarget` pass for nothing.
    await mount();
    const settled = getRendererBillingLaneFactsVersion();

    await act(async () => {
      root.render(<Harness />);
      await flushAsyncEffects();
    });

    expect(getRendererBillingLaneFactsVersion()).toBe(settled);
  });

  it('notifies lane-facts subscribers when the runtime is written', async () => {
    // The runtime is written from an app-root effect, which runs after every
    // child has rendered — so components deriving from it during render need
    // this signal or they hold the pre-effect values forever.
    const notified = jest.fn();
    const unsubscribe = subscribeRendererBillingLaneFacts(notified);
    const before = getRendererBillingLaneFactsVersion();

    await mount();

    expect(notified).toHaveBeenCalled();
    expect(getRendererBillingLaneFactsVersion()).toBeGreaterThan(before);
    unsubscribe();
  });

  it('re-stamps pristine tabs once, on an actual change in the facts', async () => {
    await mount();
    const callsAfterMount = syncActiveEmptyTabToDefaults.mock.calls.length;
    expect(callsAfterMount).toBeGreaterThan(0);

    // A re-render with identical facts must not rewrite anything.
    await act(async () => {
      root.render(<Harness />);
      await flushAsyncEffects();
    });

    expect(syncActiveEmptyTabToDefaults).toHaveBeenCalledTimes(callsAfterMount);
  });

  /**
   * CAN-4028 — the AI Credits lane default is narrowed to the allowlist for a
   * signed-in account that has not purchased, exactly as it is for a guest,
   * and only where the desktop actually knows the owner's access.
   */
  describe('model library access', () => {
    const ORG = { id: '55555555-5555-4555-8555-555555555555', name: 'Acme' };

    function signIn(options: {
      access?: string;
      status?: 'reported' | 'not-reported' | 'unknown';
      guest?: boolean;
    }): void {
      Object.assign(window.api, {
        loadCanopyCloudAccount: jest.fn().mockResolvedValue({
          hasApiKey: true,
          account: { id: 'acct_1' },
          authMode: options.guest ? 'guest' : 'oauth',
          credentialSource: options.guest ? 'guest' : 'oauth',
        }),
        loadCanopyCloudEntitlements: jest.fn().mockResolvedValue({
          resolved: true,
          modelLibrary:
            options.access !== undefined
              ? { status: 'reported', access: options.access }
              : { status: options.status ?? 'unknown' },
          modelLibraryAccountKey: `${options.guest ? 'guest' : 'account'}:acct_1`,
          workModelLibrary:
            options.access !== undefined
              ? { status: 'reported', access: options.access }
              : { status: options.status ?? 'unknown' },
          modelLibraryOwnerKey: 'personal',
        }),
      });
    }

    async function mountAndSettle(): Promise<void> {
      await mount();
      await act(async () => {
        for (let i = 0; i < 12; i += 1) {
          await Promise.resolve();
        }
      });
    }

    it('narrows the default for a signed-in non-payer on Personal work', async () => {
      signIn({ access: 'needs_purchase' });
      await mountAndSettle();
      expect(getRendererGuestPrincipal()).toBe(true);
    });

    it('leaves the default alone once the account is unlocked', async () => {
      signIn({ access: 'unlocked' });
      await mountAndSettle();
      expect(getRendererGuestPrincipal()).toBe(false);
    });

    it.each(['not-reported', 'unknown'] as const)(
      'leaves a signed-in default alone when access is %s',
      async (status) => {
        // An older server, or no usable read. Today's rule for a signed-in
        // account is unlocked, and the proxy still enforces.
        signIn({ status });
        await mountAndSettle();
        expect(getRendererGuestPrincipal()).toBe(false);
      },
    );

    it('does not apply personal access to organization-owned work', async () => {
      // The person has not purchased, but this work answers to the
      // organization's access, which this scoped probe could not read.
      signIn({ access: 'needs_purchase' });
      Object.assign(window.api, {
        loadCanopyCloudEntitlements: jest.fn().mockResolvedValue({
          resolved: true,
          modelLibrary: { status: 'reported', access: 'needs_purchase' },
          modelLibraryAccountKey: 'account:acct_1',
          workModelLibrary: { status: 'unknown' },
          modelLibraryOwnerKey: `org:${ORG.id}`,
        }),
      });
      loadNativeAiCreditsAvailabilityMock.mockResolvedValue({
        ...noCredits,
        inOrg: true,
        ownerOrganization: ORG,
      });
      await mountAndSettle();
      expect(getRendererGuestPrincipal()).toBe(false);
    });

    it('does not narrow while the owner of the work is unknown', async () => {
      signIn({ access: 'needs_purchase' });
      loadNativeAiCreditsAvailabilityMock.mockResolvedValue(
        inconclusiveCredits,
      );
      await mountAndSettle();
      expect(getRendererGuestPrincipal()).toBe(false);
    });

    it('keeps a guest narrowed whatever access says', async () => {
      signIn({ access: 'unlocked', guest: true });
      await mountAndSettle();
      expect(getRendererGuestPrincipal()).toBe(true);
    });
  });

  describe('Codex account models (CAN-4716)', () => {
    function catalogModel(
      id: string,
      extra: Partial<CodexSpeedCatalogModel> = {},
    ): CodexSpeedCatalogModel {
      return { id, model: id, tiers: null, source: 'unknown', ...extra };
    }

    function readyCatalog(
      models: CodexSpeedCatalogModel[],
      generation = 1,
    ): CodexSpeedCatalog {
      return {
        generation,
        status: 'ready',
        fetchedAt: 1,
        expiresAt: Number.MAX_SAFE_INTEGER,
        truncated: false,
        models,
        denials: [],
      };
    }

    let pushCatalog: (catalog: CodexSpeedCatalog) => void = () => undefined;
    const readCapabilities = jest.fn<Promise<CodexSpeedCatalog>, []>();

    beforeEach(() => {
      resetCodexSpeedStoreForTests();
      readCapabilities.mockResolvedValue(
        readyCatalog([
          catalogModel('codex-luna'),
          catalogModel('codex-hidden', { hidden: true }),
          catalogModel('acct-only', { displayName: 'Account only' }),
        ]),
      );
      Object.assign(window.api, {
        codexSpeed: {
          readCapabilities,
          setActive: jest.fn(() => Promise.resolve()),
          onChanged: (
            listener: (catalog: CodexSpeedCatalog) => void,
          ): (() => void) => {
            pushCatalog = listener;
            return (): void => {
              pushCatalog = (): void => undefined;
            };
          },
        },
      });
    });

    afterEach(() => {
      act(() => {
        resetCodexSpeedStoreForTests();
      });
      clearCodexAccountModels();
    });

    it('builds the id set from non-hidden entries only', () => {
      expect(codexAccountModelIdsFromCatalog(null)).toBeNull();
      expect(
        codexAccountModelIdsFromCatalog(
          readyCatalog([catalogModel('only-hidden', { hidden: true })]),
        ),
      ).toBeNull();
      expect(
        codexAccountModelIdsFromCatalog({
          ...readyCatalog([catalogModel('a')]),
          status: 'unknown',
        }),
      ).toBeNull();
      expect(
        codexAccountModelIdsFromCatalog({
          ...readyCatalog([catalogModel('a')]),
          truncated: true,
        }),
      ).toBeNull();
      expect(
        codexAccountModelIdsFromCatalog(
          readyCatalog([
            { ...catalogModel('slug'), id: 'entry-id' },
            catalogModel('hidden', { hidden: true }),
          ]),
        ),
      ).toEqual(new Set(['entry-id', 'slug']));
    });

    it('never reads the account list while Codex is signed out', async () => {
      await mount();

      expect(readCapabilities).not.toHaveBeenCalled();
      expect(getRendererCodexAccountModels()).toBeNull();
    });

    it('reads once on sign-in, registers account-only models, and re-stamps', async () => {
      getCodexAuthStatusMock.mockResolvedValue(signedIn('codex@example.com'));
      await mount();
      await act(async () => {
        await flushAsyncEffects();
      });

      expect(readCapabilities).toHaveBeenCalledTimes(1);
      expect(getRendererCodexAccountModels()).toEqual(
        new Set(['codex-luna', 'acct-only']),
      );
      expect(CODEX_ACCOUNT_MODELS).toContain('acct-only');
      expect(CODEX_ACCOUNT_MODELS).not.toContain('codex-hidden');
      expect(syncActiveEmptyTabToDefaults).toHaveBeenCalled();
    });

    it('clears the list and account-only models when main reports unknown', async () => {
      getCodexAuthStatusMock.mockResolvedValue(signedIn('codex@example.com'));
      await mount();
      await act(async () => {
        await flushAsyncEffects();
      });
      expect(CODEX_ACCOUNT_MODELS).toContain('acct-only');
      syncActiveEmptyTabToDefaults.mockClear();

      await act(async () => {
        pushCatalog({
          ...readyCatalog([], 2),
          status: 'unknown',
          fetchedAt: null,
          expiresAt: null,
        });
        await flushAsyncEffects();
      });

      expect(getRendererCodexAccountModels()).toBeNull();
      expect(CODEX_ACCOUNT_MODELS).toEqual([]);
      expect(syncActiveEmptyTabToDefaults).toHaveBeenCalledTimes(1);
    });

    it('ignores a catalog mirrored before this sign-in until its own read settles', async () => {
      // A previous account's list is still mirrored (its invalidation was
      // missed while signed out).
      act(() => {
        useCodexSpeedStore
          .getState()
          .applyCatalog(readyCatalog([catalogModel('old-account-only')]));
      });
      let settle: (catalog: CodexSpeedCatalog) => void = () => undefined;
      readCapabilities.mockReturnValueOnce(
        new Promise<CodexSpeedCatalog>((resolve) => {
          settle = resolve;
        }),
      );
      getCodexAuthStatusMock.mockResolvedValue(signedIn('codex@example.com'));
      await mount();
      await act(async () => {
        await flushAsyncEffects();
      });

      expect(readCapabilities).toHaveBeenCalledTimes(1);
      expect(getRendererCodexAccountModels()).toBeNull();
      expect(CODEX_ACCOUNT_MODELS).toEqual([]);

      await act(async () => {
        settle(readyCatalog([catalogModel('acct-only')], 2));
        await flushAsyncEffects();
      });
      expect(getRendererCodexAccountModels()).toEqual(new Set(['acct-only']));
      expect(CODEX_ACCOUNT_MODELS).toEqual(['acct-only']);
    });

    it('registers no account-only models from a truncated catalog', async () => {
      readCapabilities.mockResolvedValue({
        ...readyCatalog([catalogModel('acct-only')]),
        truncated: true,
      });
      getCodexAuthStatusMock.mockResolvedValue(signedIn('codex@example.com'));
      await mount();
      await act(async () => {
        await flushAsyncEffects();
      });

      expect(getRendererCodexAccountModels()).toBeNull();
      expect(CODEX_ACCOUNT_MODELS).toEqual([]);
    });

    it('reads again once per new account generation while signed in', async () => {
      getCodexAuthStatusMock.mockResolvedValue(signedIn('codex@example.com'));
      await mount();
      await act(async () => {
        await flushAsyncEffects();
      });
      expect(readCapabilities).toHaveBeenCalledTimes(1);

      // An in-session invalidation (account updated, runtime replaced).
      readCapabilities.mockResolvedValueOnce(
        readyCatalog([catalogModel('codex-luna')], 2),
      );
      const unknownCatalog = (generation: number): CodexSpeedCatalog => ({
        ...readyCatalog([], generation),
        status: 'unknown',
        fetchedAt: null,
        expiresAt: null,
      });
      await act(async () => {
        pushCatalog(unknownCatalog(2));
        await flushAsyncEffects();
      });

      expect(readCapabilities).toHaveBeenCalledTimes(2);
      expect(getRendererCodexAccountModels()).toEqual(new Set(['codex-luna']));

      // A failed read in the same generation does not read again.
      await act(async () => {
        pushCatalog({ ...unknownCatalog(2), fetchedAt: 5 });
        await flushAsyncEffects();
      });
      expect(readCapabilities).toHaveBeenCalledTimes(2);
    });
  });
});
