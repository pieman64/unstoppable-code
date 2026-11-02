import {
  MODEL_LIBRARY_PROTOCOL_HEADER,
  MODEL_LIBRARY_PROTOCOL_VERSION,
} from '@canopy/protocol/models';
import { createServer } from 'node:http';
import type {
  GatewayModelEntry,
  WorkOwner,
} from '@canopy/protocol/llm-gateway';
import { AI_CREDITS_PROXY_ERROR_MARKER } from '@canopy/protocol';
import { classifyAgentFailure } from '@canopy/desktop-shared/agent-failures/classifier';
import { runWithTransientAgentRetry } from '@canopy/desktop-shared/agent-failures/transient-retry';
import { resolveGatewayModelEntry } from '@canopy/desktop-shared/lib/gateway-model-availability';
import { toOpenCodeModelId } from '@canopy/desktop-shared/lib/opencode-models';
import {
  getAiCreditsRoutingContext,
  resolveOrgGatewayCredential,
  markOrgGatewayCredentialRejected,
} from '../agents/ai-credits-routing';
import { checkModelGatewayRoute } from '../lib/model-gateway-state';
import {
  loadCanopyCloudAccount,
  subscribeCanopyCloudAccountChanges,
} from '../lib/canopy-cloud-account-store';
import { getCanopyCloudBaseUrl } from '../canopy-cloud/config';
import { getMockLlmOrigin } from '../lib/e2e-mock-control-plane';
import {
  getCodexGatewayProxyService,
  type CodexGatewayProxyService,
  type CodexGatewayRouteLease,
} from '../agents/codex-gateway-proxy-service';
import {
  openOpenCodeInferenceLease,
  type OpenCodeInferenceLease,
} from '../opencode/inference-host';
import type * as GatewayBroker from '../agents/codex-gateway-proxy-service';
import type * as AiCreditsRouting from '../agents/ai-credits-routing';

jest.mock('@canopy/desktop-shared/lib/gateway-model-availability', () => ({
  resolveGatewayModelEntry: jest.fn(),
  resolveOwnerScopedModelId: (id: string): string => id,
}));
jest.mock('../agents/ai-credits-routing', () => ({
  getAiCreditsRoutingContext: jest.fn(),
  resolveOrgGatewayCredential: jest.fn(),
  markOrgGatewayCredentialRejected: jest.fn(),
  attributionHeaderPairs: jest.requireActual<typeof AiCreditsRouting>(
    '../agents/ai-credits-routing',
  ).attributionHeaderPairs,
  buildProxyBaseUrl: (base: string, harness: string): string =>
    `${base}/api/v1/llm-proxy/${harness === 'claude' ? 'anthropic' : 'openai/responses'}`,
  buildOrgGatewayCodexBaseUrl: (base: string): string => `${base}/v1`,
}));
jest.mock('../lib/model-gateway-state', () => ({
  checkModelGatewayRoute: jest.fn(),
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: jest.fn(),
  subscribeCanopyCloudAccountChanges: jest.fn(() => jest.fn()),
}));
jest.mock('../canopy-cloud/config', () => ({
  getCanopyCloudBaseUrl: jest.fn((): string => 'https://cloud.example'),
}));
jest.mock('../lib/e2e-mock-control-plane', () => ({
  getMockLlmOrigin: jest.fn(),
}));
jest.mock('../agents/codex-gateway-proxy-service', () => ({
  getCodexGatewayProxyService: jest.fn(),
}));

type Registration = Parameters<CodexGatewayProxyService['registerRoute']>[0];
const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const entry: GatewayModelEntry = {
  modelId: 'gateway-model',
  gatewayId: 'vendor/model',
  family: 'gpt',
  recommendedHarness: 'codex',
  gatewayOnly: true,
  contextWindow: 128000,
  supportsPromptCaching: false,
  supportedThinkingLevels: [],
  toolSchemaProfile: 'standard',
};
const context = {
  cskToken: 'host-secret-one',
  accountIdentity: 'account-one',
  email: null,
  creditsEligible: true,
  creditsEligibilityKnown: true,
  cloudBaseUrl: 'https://cloud.example',
  guestPrincipal: false,
};

describe('OpenCode host-owned inference', () => {
  let registration: Registration | undefined;
  let failure:
    | {
        status?: number;
        proxyFailure?: {
          code: 'no_billing_source';
          message: string;
          correlationId: string;
          reason: 'personal_wallet_empty';
        };
      }
    | undefined;
  const unregisterRoute = jest.fn();
  const registerRoute = jest.fn(
    (options: Registration): Promise<CodexGatewayRouteLease> => {
      registration = options;
      return Promise.resolve({
        routeId: 'a'.repeat(48),
        baseUrl: `http://127.0.0.1:43123/codex-gateway/${'a'.repeat(48)}`,
        readInferenceFailure: (): typeof failure => failure,
      });
    },
  );
  const options = (): Parameters<typeof openOpenCodeInferenceLease>[0] => ({
    model: 'gateway-model',
    sessionId: 'project/worktree/chat',
    outputLimit: 4096,
    attribution: { workOwner: { kind: 'personal' as const } },
    signal: new AbortController().signal,
  });
  const requireRegistration = (): Registration => {
    if (!registration) throw new Error('No broker route was registered');
    return registration;
  };
  const requireLease = async (
    input = options(),
  ): Promise<OpenCodeInferenceLease> => {
    const lease = await openOpenCodeInferenceLease(input);
    if (!lease) throw new Error('No managed lease');
    return lease;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getMockLlmOrigin).mockReturnValue(null);
    registration = undefined;
    failure = undefined;
    jest.mocked(resolveGatewayModelEntry).mockReturnValue({ ...entry });
    jest
      .mocked(checkModelGatewayRoute)
      .mockResolvedValue({ ok: true, orgRoute: false });
    jest.mocked(getAiCreditsRoutingContext).mockResolvedValue({ ...context });
    jest.mocked(resolveOrgGatewayCredential).mockResolvedValue({
      baseUrl: 'https://gateway.example',
      apiKey: 'org-secret',
      credentialVersion: 'v1',
    });
    jest.mocked(loadCanopyCloudAccount).mockResolvedValue({
      apiKey: 'cloud-secret',
      createdAt: '2026-10-12',
      updatedAt: '2026-10-12',
      capabilities: [],
      account: {
        id: 'account-one',
        name: 'Example',
        email: 'example@example.test',
        role: 'DEVELOPER',
      },
    });
    jest.mocked(getCodexGatewayProxyService).mockReturnValue({
      registerRoute,
      unregisterRoute,
    } as unknown as CodexGatewayProxyService);
  });

  it('leaves native OpenCode selections outside app billing', async () => {
    expect(
      await openOpenCodeInferenceLease({
        ...options(),
        model: toOpenCodeModelId('native/model'),
      }),
    ).toBeNull();
    expect(getAiCreditsRoutingContext).not.toHaveBeenCalled();
    expect(registerRoute).not.toHaveBeenCalled();
  });

  it('requires a captured owner and an eligible exact catalog route before loading credentials', async () => {
    await expect(
      openOpenCodeInferenceLease({ ...options(), attribution: {} }),
    ).rejects.toThrow(/owner/i);
    jest.mocked(resolveGatewayModelEntry).mockReturnValue(undefined);
    await expect(requireLease()).rejects.toThrow(/model/i);
    jest
      .mocked(resolveGatewayModelEntry)
      .mockReturnValue({ ...entry, toolSchemaProfile: 'flat' });
    await expect(requireLease()).rejects.toThrow(/model/i);
    expect(getAiCreditsRoutingContext).not.toHaveBeenCalled();
    expect(registerRoute).not.toHaveBeenCalled();
  });

  it.each(['codex', 'claude'] as const)(
    'builds the %s dialect with host-only secrets and fixed attribution',
    async (harness) => {
      jest
        .mocked(resolveGatewayModelEntry)
        .mockReturnValue({ ...entry, recommendedHarness: harness });
      const lease = await requireLease();
      const route = requireRegistration();
      expect(lease.route.protocol).toBe(
        harness === 'claude' ? 'anthropic-messages' : 'openai-responses',
      );
      expect(route.allowedPaths).toEqual([
        harness === 'claude' ? '/v1/messages' : '/responses',
      ]);
      expect(route.inferencePolicy).toEqual({
        providerType: 'opencode',
        modelId: 'vendor/model',
        headers: {
          'x-canopy-work-owner': 'personal',
          [MODEL_LIBRARY_PROTOCOL_HEADER]: String(
            MODEL_LIBRARY_PROTOCOL_VERSION,
          ),
        },
      });
      expect(await route.resolveToken()).toEqual({ token: 'host-secret-one' });
      expect(JSON.stringify(lease.route)).not.toContain('host-secret');
      expect(lease.route.model).toEqual({
        id: 'vendor/model',
        contextWindow: 128000,
        outputLimit: 4096,
        supportsVision: false,
      });
      lease.dispose();
      lease.dispose();
      expect(unregisterRoute).toHaveBeenCalledTimes(1);
    },
  );

  function fundingKey(lease: OpenCodeInferenceLease): string {
    const selected: unknown = Reflect.get(lease.route, 'selection');
    if (
      !selected ||
      typeof selected !== 'object' ||
      !('fundingKey' in selected) ||
      typeof selected.fundingKey !== 'string'
    )
      throw new Error('Missing stable funding identity');
    return selected.fundingKey;
  }

  it('separates stable funding from exact model and protocol bindings', async () => {
    const first = await requireLease();
    expect(first.route).toMatchObject({
      selection: {
        modelId: 'gateway-model',
        fundingKey: fundingKey(first),
      },
    });
    expect(fundingKey(first)).toMatch(/^[a-f0-9]{64}$/);
    first.dispose();
    jest.mocked(resolveGatewayModelEntry).mockReturnValue({
      ...entry,
      modelId: 'second-model',
      gatewayId: 'vendor/second',
      recommendedHarness: 'claude',
    });
    const second = await requireLease({ ...options(), model: 'second-model' });
    expect(second.route).toMatchObject({
      selection: { modelId: 'second-model', fundingKey: fundingKey(first) },
    });
    expect(second.route.bindingKey).not.toBe(first.route.bindingKey);
  });

  it('binds managed model transitions to the captured work owner', async () => {
    const first = await requireLease();
    first.dispose();
    const second = await requireLease({
      ...options(),
      attribution: { workOwner: { kind: 'organization', organizationId } },
    });
    expect(fundingKey(second)).not.toBe(fundingKey(first));
  });

  it('binds managed model transitions to the organization project', async () => {
    const first = await requireLease();
    first.dispose();
    const second = await requireLease({
      ...options(),
      attribution: {
        ...options().attribution,
        organizationProjectId: 'project-two',
      },
    });
    expect(fundingKey(second)).not.toBe(fundingKey(first));
  });

  it('binds funding kind even when account, owner and gateway endpoint match', async () => {
    const input = {
      ...options(),
      attribution: {
        workOwner: { kind: 'organization' as const, organizationId },
      },
    };
    const first = await requireLease(input);
    first.dispose();
    jest
      .mocked(checkModelGatewayRoute)
      .mockResolvedValue({ ok: true, orgRoute: true });
    jest.mocked(resolveGatewayModelEntry).mockReturnValue({
      ...entry,
      origin: 'org-gateway',
      organizationId,
      baseUrl: context.cloudBaseUrl,
    });
    jest.mocked(resolveOrgGatewayCredential).mockResolvedValue({
      baseUrl: context.cloudBaseUrl,
      apiKey: 'org-secret',
      credentialVersion: 'v1',
    });
    const second = await requireLease(input);
    expect(fundingKey(second)).not.toBe(fundingKey(first));
  });

  it('captures the logical selection before awaiting funding policy', async () => {
    const input = options();
    const pending = requireLease(input);
    input.model = 'caller-mutated-selection';
    expect((await pending).route).toMatchObject({
      selection: { modelId: 'gateway-model' },
    });
  });

  it('separates account authority from token rotation', async () => {
    const first = await requireLease();
    first.dispose();
    const original = await loadCanopyCloudAccount();
    if (!original?.account) throw new Error('Missing fixture account');
    jest.mocked(loadCanopyCloudAccount).mockResolvedValue({
      ...original,
      account: { ...original.account, id: 'account-two' },
    });
    jest
      .mocked(getAiCreditsRoutingContext)
      .mockResolvedValue({ ...context, accountIdentity: 'account-two' });
    const second = await requireLease();
    expect(fundingKey(second)).not.toBe(fundingKey(first));
  });

  it('binds the stable gateway endpoint', async () => {
    const first = await requireLease();
    first.dispose();
    jest
      .mocked(getCanopyCloudBaseUrl)
      .mockReturnValue('https://cloud-other.example');
    jest.mocked(getAiCreditsRoutingContext).mockResolvedValue({
      ...context,
      cloudBaseUrl: 'https://cloud-other.example',
    });
    try {
      const second = await requireLease();
      expect(fundingKey(second)).not.toBe(fundingKey(first));
    } finally {
      jest
        .mocked(getCanopyCloudBaseUrl)
        .mockReturnValue('https://cloud.example');
    }
  });

  it('rotates same-account tokens without changing the stable binding', async () => {
    const first = await requireLease();
    jest
      .mocked(getAiCreditsRoutingContext)
      .mockResolvedValue({ ...context, cskToken: 'rotated-secret' });
    expect(await requireRegistration().resolveToken()).toEqual({
      token: 'rotated-secret',
    });
    const second = await requireLease();
    expect(second.route.bindingKey).toBe(first.route.bindingKey);
  });

  it.each([
    { accountIdentity: 'account-two' },
    { cloudBaseUrl: 'https://other.example' },
    { creditsEligible: false },
    { creditsEligibilityKnown: false },
  ])(
    'refuses a changed or unavailable funding authority: %j',
    async (change) => {
      await requireLease();
      jest
        .mocked(getAiCreditsRoutingContext)
        .mockResolvedValue({ ...context, ...change });
      expect(await requireRegistration().resolveToken()).toBeNull();
    },
  );

  it('rechecks policy and catalog after an awaited credential read', async () => {
    await requireLease();
    jest.mocked(getAiCreditsRoutingContext).mockImplementation(() => {
      jest
        .mocked(resolveGatewayModelEntry)
        .mockReturnValue({ ...entry, gatewayId: 'vendor/replacement' });
      return Promise.resolve(context);
    });
    expect(await requireRegistration().resolveToken()).toBeNull();
  });

  it('refuses withdrawn organization policy before resolving another token', async () => {
    await requireLease();
    jest
      .mocked(checkModelGatewayRoute)
      .mockResolvedValue({ ok: false, message: 'Gateway policy changed.' });
    jest.mocked(getAiCreditsRoutingContext).mockClear();
    expect(await requireRegistration().resolveToken()).toBeNull();
    expect(getAiCreditsRoutingContext).not.toHaveBeenCalled();
  });

  it('snapshots owner and model data before the first credential await', async () => {
    const selected = { ...entry };
    jest.mocked(resolveGatewayModelEntry).mockReturnValue(selected);
    const input = options();
    const pending = requireLease(input);
    selected.gatewayId = 'vendor/replacement';
    await expect(pending).rejects.toThrow(/changed|unavailable/i);
    expect(registerRoute).not.toHaveBeenCalled();
  });

  it('revokes registration that completes after cancellation', async () => {
    const abort = new AbortController();
    registerRoute.mockImplementationOnce((input) => {
      registration = input;
      abort.abort();
      return Promise.resolve({
        routeId: 'a'.repeat(48),
        baseUrl: `http://127.0.0.1:43123/codex-gateway/${'a'.repeat(48)}`,
        readInferenceFailure: (): undefined => undefined,
      });
    });
    await expect(
      requireLease({ ...options(), signal: abort.signal }),
    ).rejects.toThrow();
    expect(unregisterRoute).toHaveBeenCalledWith('a'.repeat(48));
  });

  it('uses a current organization credential and scopes its rejection version', async () => {
    jest.mocked(resolveGatewayModelEntry).mockReturnValue({
      ...entry,
      origin: 'org-gateway',
      organizationId,
      baseUrl: 'https://gateway.example',
      promptCachePassthrough: false,
    });
    jest
      .mocked(checkModelGatewayRoute)
      .mockResolvedValue({ ok: true, orgRoute: true });
    const lease = await openOpenCodeInferenceLease({
      ...options(),
      attribution: { workOwner: { kind: 'organization', organizationId } },
    });
    expect(lease?.funding).toBe('org-gateway');
    expect(getAiCreditsRoutingContext).not.toHaveBeenCalled();
    const route = requireRegistration();
    expect(route.upstreamUrl).toBe('https://gateway.example/v1');
    expect(route.stripCacheControl).toBe(true);
    expect(await route.resolveToken()).toEqual({
      token: 'org-secret',
      credentialVersion: 'v1',
    });
    await route.onCredentialRejected?.(401, 'v1');
    expect(markOrgGatewayCredentialRejected).toHaveBeenCalledWith(
      organizationId,
      401,
      'v1',
      'account-one',
    );
    jest.mocked(loadCanopyCloudAccount).mockResolvedValue(null);
    expect(await route.resolveToken()).toBeNull();
  });

  it('preserves a worker refusal when no inference request reached the broker', async () => {
    const lease = await requireLease();
    const refusal =
      'This OpenCode model does not support images. Remove the image and try again.';
    const error = lease.failureError(new Error(refusal), true);
    expect(error).toMatchObject({ message: refusal, api_error_status: 400 });
    expect(
      classifyAgentFailure({
        provider: 'opencode',
        accountScope: 'ai_credits',
        error,
        events: [{ api_error_status: 502 }],
      }),
    ).toBeNull();
    lease.dispose();
  });

  it('keeps unrecorded transport failures terminal even while preserving their diagnostic', async () => {
    const lease = await requireLease();
    const error = lease.failureError(new Error('ECONNRESET'));
    expect(error.message).toContain('ECONNRESET');
    expect(error.message).toContain(AI_CREDITS_PROXY_ERROR_MARKER);
    expect(
      classifyAgentFailure({
        provider: 'opencode',
        accountScope: 'ai_credits',
        error,
      }),
    ).toBeNull();
    lease.dispose();
  });

  it('makes ambiguous managed failures terminal for the shared app retry loop', async () => {
    const lease = await requireLease();
    failure = { status: 502 };
    const retry = jest.fn();
    const attempt = jest.fn(() => Promise.reject(lease.failureError()));
    await expect(
      runWithTransientAgentRetry({
        provider: 'opencode',
        model: 'gateway-model',
        accountScope: 'ai_credits',
        runAttempt: attempt,
        onRetry: retry,
        delaysMs: [0, 0],
      }),
    ).rejects.toThrow(AI_CREDITS_PROXY_ERROR_MARKER);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(
      classifyAgentFailure({
        provider: 'opencode',
        accountScope: 'ai_credits',
        error: lease.failureError(),
        events: [{ error: 'ECONNRESET' }],
      }),
    ).toBeNull();
  });

  it('preserves billing and authentication recovery ahead of replay suppression', async () => {
    const lease = await requireLease();
    failure = {
      status: 402,
      proxyFailure: {
        code: 'no_billing_source',
        message: 'No balance.',
        reason: 'personal_wallet_empty',
        correlationId: 'refusal-id',
      },
    };
    expect(
      classifyAgentFailure({
        provider: 'opencode',
        accountScope: 'ai_credits',
        error: lease.failureError(),
      }),
    ).toMatchObject({ kind: 'provider_usage_limit', code: 'credits_depleted' });
    failure = { status: 401 };
    expect(
      classifyAgentFailure({
        provider: 'opencode',
        accountScope: 'ai_credits',
        error: lease.failureError(),
      }),
    ).toMatchObject({ kind: 'provider_authentication_required' });
  });
  it('revokes on account replacement while allowing same-account token rotation', async () => {
    const lease = await requireLease();
    const listener = jest
      .mocked(subscribeCanopyCloudAccountChanges)
      .mock.calls.at(-1)?.[0];
    if (!listener) throw new Error('No account lifecycle observer');
    const current = await loadCanopyCloudAccount();
    if (!current) throw new Error('Missing account fixture');
    listener({ ...current, apiKey: 'rotated-cloud-key' });
    expect(lease.signal.aborted).toBe(false);
    listener(null);
    expect(lease.signal.aborted).toBe(true);
    expect(unregisterRoute).toHaveBeenCalledTimes(1);
    expect(await requireRegistration().resolveToken()).toBeNull();
  });

  it('does not report a withdrawn policy as a sign-in failure', async () => {
    const lease = await requireLease();
    jest
      .mocked(checkModelGatewayRoute)
      .mockResolvedValue({ ok: false, message: 'Policy changed' });
    expect(await requireRegistration().resolveToken()).toBeNull();
    failure = { status: 401 };
    expect(
      classifyAgentFailure({
        provider: 'opencode',
        accountScope: 'ai_credits',
        error: lease.failureError(),
      }),
    ).toBeNull();
    expect(lease.failureError().message).toContain('selected account or model');
  });

  it('binds project attribution while allowing display-name changes', async () => {
    const first = await requireLease();
    const named = await openOpenCodeInferenceLease({
      ...options(),
      attribution: { ...options().attribution, workspaceName: 'Renamed' },
    });
    const project = await openOpenCodeInferenceLease({
      ...options(),
      attribution: {
        ...options().attribution,
        organizationProjectId: 'project-one',
      },
    });
    expect(named?.route.bindingKey).toBe(first.route.bindingKey);
    expect(project?.route.bindingKey).not.toBe(first.route.bindingKey);
  });

  it.each(['codex', 'claude'] as const)(
    'does not mint a second paid lease after a real %s broker failure',
    async (harness) => {
      const { CodexGatewayProxyService: ActualBroker } = jest.requireActual<
        typeof GatewayBroker
      >('../agents/codex-gateway-proxy-service');
      const broker = new ActualBroker({ retryDelaysMs: [0] });
      jest.mocked(getCodexGatewayProxyService).mockReturnValue(broker);
      jest
        .mocked(resolveGatewayModelEntry)
        .mockReturnValue({ ...entry, recommendedHarness: harness });
      const requests: Array<{
        url: string | undefined;
        authorization: string | undefined;
        owner: string | string[] | undefined;
      }> = [];
      const upstream = createServer((request, response) => {
        request.resume();
        request.on('end', () => {
          requests.push({
            url: request.url,
            authorization: request.headers.authorization,
            owner: request.headers['x-canopy-work-owner'],
          });
          response.writeHead(502, { 'content-type': 'application/json' });
          response.end('{"error":{"message":"upstream uncertain"}}');
        });
      });
      await new Promise<void>((resolve) =>
        upstream.listen(0, '127.0.0.1', resolve),
      );
      const address = upstream.address();
      if (!address || typeof address === 'string')
        throw new Error('No upstream address');
      jest
        .mocked(getMockLlmOrigin)
        .mockReturnValue(`http://127.0.0.1:${address.port}`);
      const attempt = jest.fn(async () => {
        const lease = await requireLease();
        try {
          const response = await fetch(
            lease.route.baseUrl +
              (harness === 'claude' ? '/v1/messages' : '/responses'),
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: 'Bearer forged',
                'x-canopy-work-owner': 'org:forged',
              },
              body: JSON.stringify({
                model: 'vendor/model',
                input: 'fixture request',
              }),
            },
          );
          expect(response.status).toBe(502);
          await response.text();
          throw lease.failureError();
        } finally {
          lease.dispose();
        }
      });
      try {
        await expect(
          runWithTransientAgentRetry({
            provider: 'opencode',
            accountScope: 'ai_credits',
            runAttempt: attempt,
            delaysMs: [0],
          }),
        ).rejects.toThrow(AI_CREDITS_PROXY_ERROR_MARKER);
        expect(attempt).toHaveBeenCalledTimes(1);
        expect(requests).toEqual([
          {
            url:
              harness === 'claude'
                ? '/api/v1/llm-proxy/anthropic/v1/messages'
                : '/api/v1/llm-proxy/openai/responses/responses',
            authorization: 'Bearer host-secret-one',
            owner: 'personal',
          },
        ]);
      } finally {
        await broker.shutdown();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
      }
    },
  );
  it.each([0, -1, 128001, Number.NaN])(
    'rejects an invalid app response budget before billing lookup: %s',
    async (outputLimit) => {
      await expect(
        openOpenCodeInferenceLease({ ...options(), outputLimit }),
      ).rejects.toThrow(/model/i);
      expect(getAiCreditsRoutingContext).not.toHaveBeenCalled();
      expect(registerRoute).not.toHaveBeenCalled();
    },
  );

  it('refuses an account transition during initial authority capture and releases its observer', async () => {
    const original = await loadCanopyCloudAccount();
    jest.mocked(loadCanopyCloudAccount).mockImplementationOnce(() => {
      const listener = jest
        .mocked(subscribeCanopyCloudAccountChanges)
        .mock.calls.at(-1)?.[0];
      listener?.(null);
      return Promise.resolve(original);
    });
    await expect(requireLease()).rejects.toThrow('account changed');
    expect(registerRoute).not.toHaveBeenCalled();
    const unsubscribe: unknown = jest
      .mocked(subscribeCanopyCloudAccountChanges)
      .mock.results.at(-1)?.value;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('keeps the captured organization owner after caller mutation', async () => {
    const workOwner: WorkOwner = { kind: 'organization', organizationId };
    const pending = openOpenCodeInferenceLease({
      ...options(),
      attribution: { workOwner },
    });
    // Preserve the caller mutation this test exercises despite the readonly DTO.
    Reflect.set(
      workOwner,
      'organizationId',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    );
    const lease = await pending;
    expect(lease?.route.headers?.['x-canopy-work-owner']).toBe(
      `org:${organizationId}`,
    );
    expect(getAiCreditsRoutingContext).toHaveBeenCalledWith({
      owner: { kind: 'organization', organizationId },
      forceRefresh: true,
    });
  });
});
