import { readFile, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import {
  initAiGatewayModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';

const mockGetBundledModelCatalog = jest.fn<Promise<unknown>, []>();

jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: (): {
    getBundledModelCatalog: typeof mockGetBundledModelCatalog;
  } => ({ getBundledModelCatalog: mockGetBundledModelCatalog }),
}));

import {
  buildGatewayCompatibleCodexCatalog,
  cleanupGatewayCompatibleCodexCatalog,
  ensureGatewayCompatibleCodexCatalog,
} from '../codex/gateway-model-catalog';

const gatewayConfig = {
  recommendedHarness: 'codex' as const,
  gatewayOnly: false,
  contextWindow: 372_000,
  supportsPromptCaching: false,
  supportedThinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'] as const,
  toolSchemaProfile: 'standard' as const,
};

function registerGatewayRoutes(
  options: { includeNative?: boolean } = {},
): void {
  const includeNative = options.includeNative !== false;
  initCodexModels(
    includeNative ? [{ id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' }] : [],
  );
  initAiGatewayModels(
    [
      {
        id: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        recommendedHarness: 'codex',
        contextWindow: gatewayConfig.contextWindow,
        supportsPromptCaching: gatewayConfig.supportsPromptCaching,
        supportedThinkingLevels: [...gatewayConfig.supportedThinkingLevels],
        toolSchemaProfile: gatewayConfig.toolSchemaProfile,
      },
    ],
    [
      ...(includeNative
        ? [
            {
              modelId: 'gpt-5.6-luna',
              gatewayId: 'openai/gpt-5.6-luna',
              ...gatewayConfig,
            },
          ]
        : []),
      {
        modelId: 'deepseek-v4-pro',
        gatewayId: 'deepseek/deepseek-v4-pro',
        ...gatewayConfig,
        gatewayOnly: true,
      },
    ],
  );
}

describe('Codex AI Gateway model catalog', () => {
  afterEach(async () => {
    initCodexModels([]);
    initAiGatewayModels([], []);
    mockGetBundledModelCatalog.mockReset();
    await cleanupGatewayCompatibleCodexCatalog();
  });

  it('clones bundled profiles under gateway IDs with Responses Lite disabled', () => {
    registerGatewayRoutes();

    const bundledLuna = {
      slug: 'gpt-5.6-luna',
      base_instructions: 'Keep Luna instructions',
      model_messages: { instructions_template: 'Keep Luna template' },
      use_responses_lite: true,
      tool_mode: 'code_mode_only',
      context_window: 372_000,
    };
    const result = buildGatewayCompatibleCodexCatalog({
      models: [bundledLuna],
      etag: 'bundled-etag',
    });

    expect(result).toMatchObject({ etag: 'bundled-etag' });
    expect(result?.models).toEqual([
      bundledLuna,
      {
        ...bundledLuna,
        slug: 'openai/gpt-5.6-luna',
        display_name: 'gpt-5.6-luna',
        use_responses_lite: false,
        tool_mode: null,
      },
      {
        ...bundledLuna,
        slug: 'deepseek/deepseek-v4-pro',
        display_name: 'deepseek-v4-pro',
        use_responses_lite: false,
        tool_mode: null,
      },
    ]);
  });

  it('returns null when no configured Codex gateway model has a bundled profile', () => {
    registerGatewayRoutes({ includeNative: false });

    expect(buildGatewayCompatibleCodexCatalog({ models: [] })).toBeNull();
  });

  it('uses GPT 6.1 Sol as the fallback profile for gateway-only models', () => {
    registerGatewayRoutes({ includeNative: false });
    const result = buildGatewayCompatibleCodexCatalog({
      models: [
        { slug: 'gpt-6-astra', base_instructions: 'Astra instructions' },
        { slug: 'gpt-5.5', base_instructions: 'Retired instructions' },
        { slug: 'gpt-6.1-sol', base_instructions: 'Sol instructions' },
      ],
    });

    expect(result?.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: 'deepseek/deepseek-v4-pro',
          base_instructions: 'Sol instructions',
        }),
      ]),
    );
  });

  it('degrades on a failed read and retries on the next request', async () => {
    registerGatewayRoutes();
    mockGetBundledModelCatalog
      .mockRejectedValueOnce(new Error('transient read failure'))
      .mockResolvedValueOnce({
        models: [
          {
            slug: 'gpt-5.6-luna',
            use_responses_lite: true,
          },
        ],
      });
    const warning = jest
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);

    await expect(
      ensureGatewayCompatibleCodexCatalog(),
    ).resolves.toBeUndefined();
    await expect(ensureGatewayCompatibleCodexCatalog()).resolves.toContain(
      'canopy-codex-gateway-models-',
    );
    expect(mockGetBundledModelCatalog).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });

  it('uses a private randomized directory and removes it during cleanup', async () => {
    registerGatewayRoutes();
    mockGetBundledModelCatalog.mockResolvedValue({
      models: [{ slug: 'gpt-5.6-luna' }],
    });

    const catalogPath = await ensureGatewayCompatibleCodexCatalog();
    if (!catalogPath) {
      throw new Error('Expected a materialized Codex catalog path');
    }
    const directoryPath = dirname(catalogPath);
    const directoryMode = (await stat(directoryPath)).mode & 0o777;

    expect(basename(catalogPath)).toBe('models.json');
    expect(basename(directoryPath)).toMatch(
      /^canopy-codex-gateway-models-[A-Za-z0-9_-]+$/,
    );
    expect(directoryMode).toBe(0o700);

    await cleanupGatewayCompatibleCodexCatalog();

    await expect(stat(directoryPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('materializes a fresh catalog when live gateway routes change', async () => {
    registerGatewayRoutes();
    mockGetBundledModelCatalog.mockResolvedValue({
      models: [{ slug: 'gpt-5.6-luna' }],
    });

    const firstPath = await ensureGatewayCompatibleCodexCatalog();
    expect(firstPath).toBeDefined();

    initAiGatewayModels(
      [],
      [
        {
          modelId: 'gpt-5.6-luna',
          gatewayId: 'openai/gpt-5.6-luna-v2',
          ...gatewayConfig,
        },
      ],
    );
    const secondPath = await ensureGatewayCompatibleCodexCatalog();

    expect(secondPath).toBeDefined();
    if (!firstPath || !secondPath) {
      throw new Error('Expected both gateway catalog revisions');
    }
    expect(secondPath).not.toBe(firstPath);
    expect(await readFile(secondPath, 'utf8')).toContain(
      'openai/gpt-5.6-luna-v2',
    );
    expect(await readFile(firstPath, 'utf8')).toContain('openai/gpt-5.6-luna');
  });
});
