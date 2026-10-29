// Unit tests for the build-gated Claude LLM seams (WP-MOCK-LLM, Doc 5 §2 /
// Doc 11). The gate branches run only under an `__CANOPY_E2E__` build; jest
// bakes `__CANOPY_E2E__ === false`, so these tests assert the production
// (gate-OFF) behavior: no mock redirect is applied even when the harness env
// vars are set. The gate-ON behavior is covered by the Phase-5 live specs.

// `claude-compatible` imports the Ollama service (Electron) transitively; stub
// it so the resolver can be imported standalone.
jest.mock('../ollama/index', () => ({
  buildClaudeCompatibleOllamaEnv: jest.fn(),
  getOllamaService: jest.fn(),
}));

import { resolveClaudeCompatibleInvocation } from '../ollama/claude-compatible';
import { buildSummaryHelperEnv } from '../agents/utils';
import {
  resolveAnthropicMockEnvOverride,
  resolveCodexMockAppServerOverride,
} from '@canopy/desktop-shared/node/e2e-mock-env';
import { getMockApiKey, getMockLlmOrigin } from '../lib/e2e-mock-control-plane';

describe('resolveClaudeCompatibleInvocation (gate-OFF / production)', () => {
  const originalMockBaseUrl = process.env.CANOPY_MOCK_LLM_BASE_URL;

  afterEach(() => {
    if (originalMockBaseUrl === undefined) {
      delete process.env.CANOPY_MOCK_LLM_BASE_URL;
    } else {
      process.env.CANOPY_MOCK_LLM_BASE_URL = originalMockBaseUrl;
    }
  });

  it('never returns a mock env override for Claude even when the env var is set', async () => {
    process.env.CANOPY_MOCK_LLM_BASE_URL = 'http://127.0.0.1:4011';

    const invocation = await resolveClaudeCompatibleInvocation(
      'claude-haiku-4-5-20251001',
    );

    expect(invocation.providerType).toBe('claude');
    expect(invocation.envOverride).toBeUndefined();
    expect(invocation.sdkModel).toBe('claude-haiku-4-5-20251001');
  });
});

describe('buildSummaryHelperEnv', () => {
  it('returns the base env unchanged without an override', () => {
    const base = { PATH: '/usr/bin', HOME: '/home/u' };
    expect(buildSummaryHelperEnv(base, undefined)).toBe(base);
  });

  it('merges the mock override onto the base env', () => {
    const merged = buildSummaryHelperEnv(
      { PATH: '/usr/bin', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
      {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:4011',
        ANTHROPIC_AUTH_TOKEN: 'mock',
        ANTHROPIC_API_KEY: 'mock',
      },
    );
    expect(merged).toEqual({
      PATH: '/usr/bin',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4011',
      ANTHROPIC_AUTH_TOKEN: 'mock',
      ANTHROPIC_API_KEY: 'mock',
    });
  });
});

describe('resolveAnthropicMockEnvOverride (gate-OFF / production)', () => {
  const originalMockBaseUrl = process.env.CANOPY_MOCK_LLM_BASE_URL;

  afterEach(() => {
    if (originalMockBaseUrl === undefined) {
      delete process.env.CANOPY_MOCK_LLM_BASE_URL;
    } else {
      process.env.CANOPY_MOCK_LLM_BASE_URL = originalMockBaseUrl;
    }
  });

  it('returns undefined even when the harness env var is set', () => {
    process.env.CANOPY_MOCK_LLM_BASE_URL = 'http://127.0.0.1:4011';
    expect(resolveAnthropicMockEnvOverride()).toBeUndefined();
  });
});

describe('mock control plane helpers (gate-OFF / production)', () => {
  const originalMockBaseUrl = process.env.CANOPY_MOCK_LLM_BASE_URL;
  const originalMockApiKey = process.env.CANOPY_MOCK_API_KEY;

  afterEach(() => {
    if (originalMockBaseUrl === undefined) {
      delete process.env.CANOPY_MOCK_LLM_BASE_URL;
    } else {
      process.env.CANOPY_MOCK_LLM_BASE_URL = originalMockBaseUrl;
    }
    if (originalMockApiKey === undefined) {
      delete process.env.CANOPY_MOCK_API_KEY;
    } else {
      process.env.CANOPY_MOCK_API_KEY = originalMockApiKey;
    }
  });

  it('getMockLlmOrigin returns null even when the env var is set', () => {
    process.env.CANOPY_MOCK_LLM_BASE_URL = 'http://127.0.0.1:4011/';
    expect(getMockLlmOrigin()).toBeNull();
  });

  it('getMockApiKey ignores the env var', () => {
    process.env.CANOPY_MOCK_API_KEY = 'custom-key';
    expect(getMockApiKey()).toBe('mock');
  });
});

describe('Codex credits routing fixture (CAN-3637)', () => {
  const gate = Object.getOwnPropertyDescriptor(globalThis, '__CANOPY_E2E__');
  const originalBase = process.env.CANOPY_MOCK_LLM_BASE_URL;
  const originalRoute = process.env.CANOPY_E2E_CODEX_REAL_ROUTING;
  afterEach(() => {
    if (gate) Object.defineProperty(globalThis, '__CANOPY_E2E__', gate);
    if (originalBase === undefined) delete process.env.CANOPY_MOCK_LLM_BASE_URL;
    else process.env.CANOPY_MOCK_LLM_BASE_URL = originalBase;
    if (originalRoute === undefined)
      delete process.env.CANOPY_E2E_CODEX_REAL_ROUTING;
    else process.env.CANOPY_E2E_CODEX_REAL_ROUTING = originalRoute;
  });
  it('can exercise the real broker while keeping auth and catalog on the loopback mock', () => {
    Object.defineProperty(globalThis, '__CANOPY_E2E__', {
      configurable: true,
      value: true,
    });
    process.env.CANOPY_MOCK_LLM_BASE_URL = 'http://127.0.0.1:4011';
    delete process.env.CANOPY_E2E_CODEX_REAL_ROUTING;
    expect(resolveCodexMockAppServerOverride()).toBeDefined();
    process.env.CANOPY_E2E_CODEX_REAL_ROUTING = '1';
    expect(resolveCodexMockAppServerOverride()).toBeUndefined();
  });
  it('cannot activate either mock configuration in production', () => {
    process.env.CANOPY_MOCK_LLM_BASE_URL = 'http://127.0.0.1:4011';
    process.env.CANOPY_E2E_CODEX_REAL_ROUTING = '1';
    expect(resolveCodexMockAppServerOverride()).toBeUndefined();
  });
});
