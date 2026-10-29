import {
  applyClaudeMockPipelineEnv,
  buildAiCreditsActionEnv,
} from '../step-runner';
import { brandEnvName } from '@canopy/desktop-shared/brand/env';

const globalWithOllamaFlag = globalThis as typeof globalThis & {
  __CANOPY_OLLAMA_ENABLED__: boolean;
};
const originalOllamaEnabled = globalWithOllamaFlag.__CANOPY_OLLAMA_ENABLED__;

afterEach(() => {
  globalWithOllamaFlag.__CANOPY_OLLAMA_ENABLED__ = originalOllamaEnabled;
  jest.resetModules();
});

// The pipeline-subprocess passthrough call site in `buildSafeProcessEnv` is
// build-gated by `__CANOPY_E2E__` (false under jest), so the gate branch cannot
// run here. Test the pure builder it delegates to instead.
describe('applyClaudeMockPipelineEnv', () => {
  it('leaves the safe env unchanged when no mock base url is configured', () => {
    const safe: Record<string, string> = { PATH: '/usr/bin' };
    const result = applyClaudeMockPipelineEnv(safe, {
      ANTHROPIC_AUTH_TOKEN: 'real',
    });
    expect(result).toBe(safe);
    expect(result).toEqual({ PATH: '/usr/bin' });
  });

  it('allowlists the Claude mock redirect vars when a base url is present', () => {
    const safe: Record<string, string> = { PATH: '/usr/bin' };
    const result = applyClaudeMockPipelineEnv(safe, {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4011',
      ANTHROPIC_AUTH_TOKEN: 'mock',
      ANTHROPIC_API_KEY: 'mock',
      UNRELATED: 'ignored',
    });
    expect(result).toEqual({
      PATH: '/usr/bin',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4011',
      ANTHROPIC_AUTH_TOKEN: 'mock',
      ANTHROPIC_API_KEY: 'mock',
    });
  });

  it('only copies keys that are present in the source env', () => {
    const safe: Record<string, string> = {};
    const result = applyClaudeMockPipelineEnv(safe, {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4011',
    });
    expect(result).toEqual({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:4011' });
    expect('ANTHROPIC_AUTH_TOKEN' in result).toBe(false);
  });

  it('treats a blank base url as no redirect', () => {
    const safe: Record<string, string> = { PATH: '/usr/bin' };
    const result = applyClaudeMockPipelineEnv(safe, {
      ANTHROPIC_BASE_URL: '   ',
      ANTHROPIC_AUTH_TOKEN: 'mock',
    });
    expect(result).toEqual({ PATH: '/usr/bin' });
  });
});

describe('buildAiCreditsActionEnv', () => {
  const modelKey = brandEnvName('AI_CREDITS_MODEL');
  const codexConfigKey = brandEnvName('AI_CREDITS_CODEX_CONFIG');

  it('injects the Claude proxy env + gateway model override, no Codex config', () => {
    const { env, secretValues } = buildAiCreditsActionEnv({
      provider: 'claude',
      model: 'claude-opus-4.8',
      env: {
        ANTHROPIC_BASE_URL:
          'https://cloud.example.com/api/v1/llm-proxy/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'csk_secret_token',
        ANTHROPIC_API_KEY: '',
      },
    });
    expect(env.ANTHROPIC_BASE_URL).toBe(
      'https://cloud.example.com/api/v1/llm-proxy/anthropic',
    );
    // Token rides in as an explicit override layer so it survives the
    // `_TOKEN`-suffix sanitizer once merged after buildSafeProcessEnv().
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('csk_secret_token');
    expect(env[modelKey]).toBe('claude-opus-4.8');
    expect(env[codexConfigKey]).toBeUndefined();
    // The bearer token is redacted from step logs.
    expect(secretValues).toContain('csk_secret_token');
  });

  it('serializes the Codex provider config JSON alongside the token env', () => {
    const codexConfig = {
      model_provider: 'canopy_ai_credits',
      model: 'deepseek/deepseek-v3.2',
      model_providers: {
        canopy_ai_credits: {
          base_url:
            'https://cloud.example.com/api/v1/llm-proxy/openai/responses',
          env_key: 'CANOPY_AI_CREDITS_TOKEN',
        },
      },
    };
    const { env } = buildAiCreditsActionEnv({
      provider: 'codex',
      model: 'deepseek/deepseek-v3.2',
      env: { CANOPY_AI_CREDITS_TOKEN: 'csk_secret_token' },
      codexConfig,
    });
    expect(env.CANOPY_AI_CREDITS_TOKEN).toBe('csk_secret_token');
    expect(env[modelKey]).toBe('deepseek/deepseek-v3.2');
    const parsed: unknown = JSON.parse(env[codexConfigKey] ?? '');
    expect(parsed).toEqual(codexConfig);
  });
});

describe('buildBundledBinaryEnv', () => {
  it('omits Ollama when the build disables Ollama support', async () => {
    jest.resetModules();
    globalWithOllamaFlag.__CANOPY_OLLAMA_ENABLED__ = false;

    const { buildBundledBinaryEnv } = await import('../step-runner');
    const env = buildBundledBinaryEnv();

    expect(env.CANOPY_CLAUDE_BINARY_PATH).toBeTruthy();
    expect(env.CANOPY_OLLAMA_BINARY_PATH).toBeUndefined();
  });

  it('omits Ollama when the build enables Ollama support', async () => {
    jest.resetModules();
    globalWithOllamaFlag.__CANOPY_OLLAMA_ENABLED__ = true;

    const { buildBundledBinaryEnv } = await import('../step-runner');
    const env = buildBundledBinaryEnv();

    expect(env.CANOPY_CLAUDE_BINARY_PATH).toBeTruthy();
    expect(env.CANOPY_OLLAMA_BINARY_PATH).toBeUndefined();
  });
});
