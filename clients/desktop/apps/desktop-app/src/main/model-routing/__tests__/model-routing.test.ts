import {
  MODEL_ROUTING_MAX_CANDIDATES,
  parseAutoModelRoutingRequestV1,
} from '@canopy/protocol/model-routing';
import { buildDesktopAutoRoutingState } from '../context';
import { buildDesktopRoutingCandidateSet } from '../candidates';
import {
  postDesktopModelRoutingRequest,
  resolveDesktopAutoModel,
} from '../client';
import * as canopyCloudClient from '../../canopy-cloud/client';
import { CanopyCloudClientError } from '../../canopy-cloud/client';
import { AutoModelRoutingInProgressError } from '../in-progress-error';

describe('desktop Auto model routing', () => {
  it('builds a bounded text-only context without attachment paths', () => {
    const state = buildDesktopAutoRoutingState({
      request: {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        userMessageId: 'current',
        text: 'Implement the endpoint',
        attachmentPaths: ['/secret/design.pdf'],
        fileReferences: [
          { displayPath: 'secret.ts', absolutePath: '/repo/secret.ts' },
        ],
        planMode: true,
        approvalMode: 'ask',
        modelConfig: { thinkingLevel: 'high', fastMode: true },
      },
      tab: {
        id: 'c',
        title: 'Chat',
        createdAt: '2026-09-20T00:00:00.000Z',
        messages: [
          {
            id: 'old',
            role: 'assistant',
            timestamp: 1,
            blocks: [
              { type: 'text', text: 'Use the existing service.' },
              {
                type: 'tool_result',
                toolUseId: 't',
                toolName: 'tool',
                output: 'secret output',
                isError: false,
              },
            ],
          },
        ],
      },
      workspace: 'single-repo',
    });

    expect(state).toMatchObject({
      prompt: 'Implement the endpoint',
      recentMessages: [
        { role: 'assistant', text: 'Use the existing service.' },
      ],
      attachmentCounts: { files: 1, images: 0, documents: 1 },
      mode: {
        task: 'plan',
        approval: 'ask',
        thinkingLevel: 'high',
        fast: true,
        workspace: 'single-repo',
      },
    });
    expect(JSON.stringify(state)).not.toContain('/secret');
    expect(JSON.stringify(state)).not.toContain('secret output');
  });

  it('reports Fast only for the exact Fast speed and rejects Ultra fast', () => {
    const buildWith = (
      modelConfig: Parameters<
        typeof buildDesktopAutoRoutingState
      >[0]['request']['modelConfig'],
      codexFastModeEnabled?: boolean,
    ): ReturnType<typeof buildDesktopAutoRoutingState> =>
      buildDesktopAutoRoutingState({
        request: {
          projectId: 'p',
          worktreeId: 'w',
          chatId: 'c',
          userMessageId: 'current',
          text: 'Go',
          planMode: false,
          modelConfig,
          ...(codexFastModeEnabled === undefined
            ? {}
            : { codexFastModeEnabled }),
        },
        tab: {
          id: 'c',
          title: 'Chat',
          createdAt: '2026-09-20T00:00:00.000Z',
          messages: [],
        },
        workspace: 'single-repo',
      });
    expect(buildWith({ speed: 'fast', fastMode: true }).mode.fast).toBe(true);
    expect(buildWith({ speed: 'standard', fastMode: false }).mode.fast).toBe(
      false,
    );
    // An exact speed outranks a contradictory legacy alias.
    expect(buildWith({ speed: 'standard' }, true).mode.fast).toBe(false);
    expect(buildWith(undefined, true).mode.fast).toBe(true);
    // The wire contract has no Ultra fast; never collapse it to Regular.
    expect(() => buildWith({ speed: 'ultrafast', fastMode: false })).toThrow(
      /specific model/,
    );
  });

  it('keeps candidates in one captured harness and lane with deterministic fallback', () => {
    expect(
      buildDesktopRoutingCandidateSet({
        lane: 'provider_subscription',
        capturedHarness: 'claude',
        authenticatedHarnesses: new Set(['claude']),
        defaultModelByHarness: { claude: 'opus' },
        currentModelId: 'stale',
        models: [
          {
            id: 'opus',
            wireModelId: 'anthropic/opus',
            label: 'Opus',
            description: 'Deep work',
            harness: 'claude',
            native: true,
            gateway: true,
            supportsThinking: true,
            blocked: false,
          },
          {
            id: 'sonnet',
            wireModelId: 'anthropic/sonnet',
            label: 'Sonnet',
            description: 'Fast work',
            harness: 'claude',
            native: true,
            gateway: true,
            supportsThinking: true,
            blocked: false,
          },
          {
            id: 'gpt',
            wireModelId: 'openai/gpt',
            label: 'GPT',
            description: 'Codex',
            harness: 'codex',
            native: true,
            gateway: true,
            supportsThinking: true,
            blocked: false,
          },
        ],
      }),
    ).toMatchObject({
      candidates: [
        expect.objectContaining({
          modelId: 'anthropic/opus',
          isDefault: true,
        }),
        expect.objectContaining({ modelId: 'anthropic/sonnet' }),
      ],
      fallbackModelId: 'anthropic/opus',
    });
  });

  it('sends the gateway identity the server validates against', () => {
    // The server resolves desktop candidates against the AI Gateway catalog,
    // whose rows are keyed by catalog id and by the exact `gatewayId` the
    // package config declares — never by Canopy's local picker id. Sending
    // `opus[1m]` makes every snapshot stale; sending `anthropic/claude-opus-5`
    // resolves. Native-only models keep their package id, which is the only
    // identity the server's native list carries.
    const set = buildDesktopRoutingCandidateSet({
      lane: 'provider_subscription',
      capturedHarness: 'codex',
      authenticatedHarnesses: new Set(['codex']),
      defaultModelByHarness: { codex: 'gpt-5.6-sol' },
      currentModelId: 'gpt-6-astra',
      models: [
        {
          id: 'gpt-5.6-sol',
          wireModelId: 'openai/gpt-5.6-sol',
          label: 'GPT 5.6 Sol',
          description: 'Balanced',
          harness: 'codex',
          native: true,
          gateway: true,
          supportsThinking: true,
          blocked: false,
        },
        {
          id: 'gpt-6-astra',
          wireModelId: 'gpt-6-astra',
          label: 'GPT 6 Astra',
          description: 'Frontier',
          harness: 'codex',
          native: true,
          gateway: false,
          supportsThinking: true,
          blocked: false,
        },
      ],
    });

    expect(set.candidates.map((candidate) => candidate.modelId)).toEqual([
      'openai/gpt-5.6-sol',
      'gpt-6-astra',
    ]);
    expect(set.fallbackModelId).toBe('gpt-6-astra');
    // The decision comes back in wire identity and must resolve to the local
    // picker id the rest of the desktop dispatches with.
    expect(set.localModelIdByWireId.get('openai/gpt-5.6-sol')).toBe(
      'gpt-5.6-sol',
    );
    expect(set.localModelIdByWireId.get('gpt-6-astra')).toBe('gpt-6-astra');
  });

  it('keeps an over-long prompt inside the wire contract', () => {
    const state = buildDesktopAutoRoutingState({
      request: {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        userMessageId: 'current',
        text: 'x'.repeat(20_000),
      },
      tab: {
        id: 'c',
        title: 'Chat',
        createdAt: '2026-09-20T00:00:00.000Z',
        messages: [],
      },
      workspace: 'single-repo',
    });

    // The server rejects a prompt longer than 8,000 characters outright, so an
    // untruncated long paste would fail the decision instead of degrading it.
    expect(state.prompt).toHaveLength(8_000);
    expect(() =>
      parseAutoModelRoutingRequestV1({
        schemaVersion: 1,
        requestId: 'r',
        surface: 'desktop',
        fallbackModelId: 'a',
        executionLane: 'ai_credits',
        candidates: [
          {
            modelId: 'a',
            label: 'A',
            description: 'A model',
            harness: 'claude',
            executionLane: 'ai_credits',
          },
          {
            modelId: 'b',
            label: 'B',
            description: 'B model',
            harness: 'claude',
            executionLane: 'ai_credits',
          },
        ],
        state,
      }),
    ).not.toThrow();
  });

  it('keeps a cross-harness candidate set inside the wire contract', () => {
    // The desktop catalog carries more eligible models than the protocol
    // accepts, so an uncapped New Task set is rejected with HTTP 400 and Auto
    // silently degrades to its fallback on every turn.
    const models = Array.from({ length: 16 }, (_unused, index) => ({
      id: `model-${String(index)}`,
      wireModelId: `model-${String(index)}`,
      label: `Model ${String(index)}`,
      description: 'Eligible',
      harness: index % 2 === 0 ? ('claude' as const) : ('codex' as const),
      native: true,
      gateway: true,
      supportsThinking: true,
      blocked: false,
    }));
    const set = buildDesktopRoutingCandidateSet({
      models,
      lane: 'provider_subscription',
      authenticatedHarnesses: new Set(['claude', 'codex']),
      defaultModelByHarness: { claude: 'model-14', codex: 'model-15' },
      currentModelId: 'model-12',
    });

    expect(set.candidates).toHaveLength(MODEL_ROUTING_MAX_CANDIDATES);
    expect(set.fallbackModelId).toBe('model-12');
    // The deterministic fallback and both harness benchmarks must survive the
    // cap: the response is validated against this exact list.
    const ids = set.candidates.map((candidate) => candidate.modelId);
    expect(ids).toEqual(
      expect.arrayContaining(['model-12', 'model-14', 'model-15']),
    );
    expect(
      new Set(set.candidates.map((candidate) => candidate.harness)),
    ).toEqual(new Set(['claude', 'codex']));
    expect(() =>
      parseAutoModelRoutingRequestV1({
        schemaVersion: 1,
        requestId: 'r',
        surface: 'desktop',
        fallbackModelId: set.fallbackModelId,
        executionLane: 'provider_subscription',
        candidates: set.candidates,
        state: {
          prompt: 'hello',
          recentMessages: [],
          attachmentCounts: { files: 0, images: 0, documents: 0 },
          mode: { task: 'execute', fast: false, workspace: 'single-repo' },
        },
      }),
    ).not.toThrow();
  });

  it('checks both desktop rollout gates before making the request', async () => {
    const request = {
      schemaVersion: 1 as const,
      requestId: 'r',
      surface: 'desktop' as const,
      fallbackModelId: 'a',
      executionLane: 'ai_credits' as const,
      candidates: [],
      state: {} as never,
    };
    const post = jest.fn();
    await expect(
      resolveDesktopAutoModel(request, undefined, {
        isEnabled: () => true,
        credentials: () =>
          Promise.resolve({
            baseUrl: 'https://cloud.example',
            apiKey: 'secret',
            capabilities: [],
          }),
        post,
      }),
    ).resolves.toMatchObject({
      durableLoss: true,
      response: { outcome: 'fallback', fallbackReason: 'policy_blocked' },
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('does not convert an active-routing conflict into an executable fallback', async () => {
    const request = {
      schemaVersion: 1 as const,
      requestId: 'r-active',
      surface: 'desktop' as const,
      fallbackModelId: 'fallback-model',
      executionLane: 'ai_credits' as const,
      candidates: [],
      state: {} as never,
    };
    const error = new CanopyCloudClientError(
      'http-error',
      'Routing is still in progress',
      409,
      'model_routing_in_progress',
      undefined,
      true,
      1_000,
    );

    const resolution = resolveDesktopAutoModel(request, undefined, {
      isEnabled: () => false,
      credentials: () =>
        Promise.resolve({
          baseUrl: 'https://cloud.example',
          apiKey: 'secret',
          capabilities: [],
        }),
      post: () => Promise.reject(error),
    });

    await expect(resolution).rejects.toEqual(
      expect.objectContaining({
        cause: error,
        retryAfterMs: 1_000,
      }),
    );
    await expect(resolution).rejects.toBeInstanceOf(
      AutoModelRoutingInProgressError,
    );
  });

  it('bounds the active-routing retry delay', () => {
    expect(new AutoModelRoutingInProgressError(0).retryAfterMs).toBe(250);
    expect(new AutoModelRoutingInProgressError().retryAfterMs).toBe(1_000);
    expect(new AutoModelRoutingInProgressError(60_000).retryAfterMs).toBe(
      5_000,
    );
  });

  describe('work owner (CAN-3462)', () => {
    const request = {
      schemaVersion: 1 as const,
      requestId: 'r-owner',
      surface: 'desktop' as const,
      fallbackModelId: 'fallback-model',
      executionLane: 'ai_credits' as const,
      candidates: [],
      state: {} as never,
    };
    const credentials = {
      baseUrl: 'https://cloud.example',
      apiKey: 'secret',
      capabilities: ['model-routing-v1'],
    };
    const owner = {
      kind: 'organization' as const,
      organizationId: '123e4567-e89b-12d3-a456-426614174000',
    };

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('passes the session owner to the resolve request', async () => {
      const post = jest.fn().mockResolvedValue({
        schemaVersion: 1,
        requestId: request.requestId,
        outcome: 'selected',
        modelId: 'selected-model',
      });

      await resolveDesktopAutoModel(
        request,
        { workOwner: owner },
        {
          isEnabled: () => true,
          credentials: () => Promise.resolve(credentials),
          post,
        },
      );

      expect(post).toHaveBeenCalledWith(request, credentials, undefined, owner);
    });

    it('sends the owner as the work-owner header', async () => {
      const send = jest
        .spyOn(canopyCloudClient, 'requestCanopyCloudJson')
        .mockResolvedValue({});

      await postDesktopModelRoutingRequest(
        request,
        credentials,
        undefined,
        owner,
      );
      await postDesktopModelRoutingRequest(request, credentials, undefined, {
        kind: 'personal',
      });

      expect(send).toHaveBeenNthCalledWith(
        1,
        '/api/v1/model-routing/resolve',
        expect.objectContaining({
          headers: { 'x-canopy-work-owner': `org:${owner.organizationId}` },
        }),
      );
      expect(send).toHaveBeenNthCalledWith(
        2,
        '/api/v1/model-routing/resolve',
        expect.objectContaining({
          headers: { 'x-canopy-work-owner': 'personal' },
        }),
      );
    });

    it('omits the header when the owner is unknown', async () => {
      const send = jest
        .spyOn(canopyCloudClient, 'requestCanopyCloudJson')
        .mockResolvedValue({});

      await postDesktopModelRoutingRequest(request, credentials);

      expect(send.mock.calls[0]?.[1]).not.toHaveProperty('headers');
    });

    it('falls back locally when the server refuses the owner', async () => {
      const refused = new CanopyCloudClientError(
        'http-error',
        "You're no longer in this organization.",
        403,
        'work_owner_not_member',
      );

      await expect(
        resolveDesktopAutoModel(
          request,
          { workOwner: owner },
          {
            isEnabled: () => true,
            credentials: () => Promise.resolve(credentials),
            post: () => Promise.reject(refused),
          },
        ),
      ).resolves.toMatchObject({
        durableLoss: false,
        response: {
          outcome: 'fallback',
          modelId: 'fallback-model',
          fallbackReason: 'unavailable',
        },
      });
    });
  });

  it('checks server replay when desktop rollout is already disabled', async () => {
    const request = {
      schemaVersion: 1 as const,
      requestId: 'r-disabled-retry',
      surface: 'desktop' as const,
      fallbackModelId: 'fallback-model',
      executionLane: 'ai_credits' as const,
      candidates: [],
      state: {} as never,
    };
    const post = jest.fn().mockResolvedValue({
      schemaVersion: 1,
      requestId: request.requestId,
      outcome: 'selected',
      modelId: 'selected-model',
    });

    await expect(
      resolveDesktopAutoModel(request, undefined, {
        isEnabled: () => false,
        credentials: () =>
          Promise.resolve({
            baseUrl: 'https://cloud.example',
            apiKey: 'secret',
            capabilities: [],
          }),
        post,
      }),
    ).resolves.toEqual({
      durableLoss: true,
      response: {
        schemaVersion: 1,
        requestId: request.requestId,
        outcome: 'selected',
        modelId: 'selected-model',
      },
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('honors a terminal result when rollout disables during routing', async () => {
    const request = {
      schemaVersion: 1 as const,
      requestId: 'r-live-disable',
      surface: 'desktop' as const,
      fallbackModelId: 'fallback-model',
      executionLane: 'ai_credits' as const,
      candidates: [],
      state: {} as never,
    };
    let publishEnabled: ((enabled: boolean) => void) | undefined;
    let finishPost: (() => void) | undefined;
    const unsubscribe = jest.fn();
    const post = jest.fn(
      () =>
        new Promise<{
          schemaVersion: 1;
          requestId: string;
          outcome: 'selected';
          modelId: string;
        }>((resolve) => {
          finishPost = (): void =>
            resolve({
              schemaVersion: 1,
              requestId: request.requestId,
              outcome: 'selected',
              modelId: 'selected-model',
            });
        }),
    );
    const pending = resolveDesktopAutoModel(request, undefined, {
      isEnabled: () => true,
      subscribeEnabled: (listener: (enabled: boolean) => void) => {
        publishEnabled = listener;
        return unsubscribe;
      },
      credentials: () =>
        Promise.resolve({
          baseUrl: 'https://cloud.example',
          apiKey: 'secret',
          capabilities: ['model-routing-v1'],
        }),
      post,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(post).toHaveBeenCalledTimes(1);

    publishEnabled?.(false);
    finishPost?.();

    await expect(pending).resolves.toEqual({
      durableLoss: true,
      response: {
        schemaVersion: 1,
        requestId: request.requestId,
        outcome: 'selected',
        modelId: 'selected-model',
      },
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
