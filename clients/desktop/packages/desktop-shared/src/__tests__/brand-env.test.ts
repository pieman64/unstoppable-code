import type * as BrandEnvModule from '../brand/env';
import type * as ScriptsModule from '../scripts';
import type * as HooksModule from '../hooks';
import type * as AutomationsModule from '../lib/automations';

function loadBrandEnv(prefixes: string[]): typeof BrandEnvModule {
  jest.resetModules();
  jest.doMock('@canopy/brand/current', () => ({
    BRAND: { environment: { prefixes } },
  }));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const brandEnv = require('../brand/env') as typeof BrandEnvModule;
  return brandEnv;
}

afterEach(() => {
  jest.dontMock('@canopy/brand/current');
});

describe('brand env helpers', () => {
  it('reads the primary brand env value before legacy fallbacks', () => {
    const env = loadBrandEnv(['TESTBRAND', 'CANOPY']);

    expect(env.brandEnvName('output')).toBe('TESTBRAND_OUTPUT');
    expect(env.brandEnvCandidates('_output')).toEqual([
      'TESTBRAND_OUTPUT',
      'CANOPY_OUTPUT',
    ]);
    expect(
      env.getBrandEnv(
        { TESTBRAND_OUTPUT: 'primary', CANOPY_OUTPUT: 'fallback' },
        'output',
      ),
    ).toBe('primary');
  });

  it('mirrors writes to empty fallback names while preserving existing values', () => {
    const env = loadBrandEnv(['TESTBRAND', 'CANOPY']);
    const target = { CANOPY_OUTPUT: 'existing' };

    env.setBrandEnv(target, 'output', 'next');

    expect(target).toEqual({
      TESTBRAND_OUTPUT: 'next',
      CANOPY_OUTPUT: 'existing',
    });
  });

  it('does not create CANOPY fallbacks for brands that do not declare them', () => {
    const env = loadBrandEnv(['ACME']);
    const target: Record<string, string> = {};

    env.setBrandEnv(target, 'output', 'next');

    expect(target).toEqual({ ACME_OUTPUT: 'next' });
    expect(env.brandEnvCandidates('output')).toEqual(['ACME_OUTPUT']);
  });

  it('exposes script env definitions with branded primary names before legacy aliases', () => {
    jest.resetModules();
    jest.doMock('@canopy/brand/current', () => ({
      BRAND: {
        displayName: 'TestBrand',
        environment: { prefixes: ['TESTBRAND', 'CANOPY'] },
      },
    }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const scripts = require('../scripts') as typeof ScriptsModule;

    expect(
      scripts.SCRIPT_ENV_VAR_DEFINITIONS.map((definition) => definition.name),
    ).toEqual([
      'TESTBRAND_WORKSPACE_ID',
      'CANOPY_WORKSPACE_ID',
      'TESTBRAND_WORKTREE_NAME',
      'CANOPY_WORKTREE_NAME',
      'TESTBRAND_WORKTREE_DATA_DIR',
      'CANOPY_WORKTREE_DATA_DIR',
      'TESTBRAND_WORKSPACE_CHILD_REPO_ID',
      'CANOPY_WORKSPACE_CHILD_REPO_ID',
    ]);
    expect(
      scripts.SCRIPT_ENV_VAR_DEFINITIONS.find(
        (definition) => definition.name === 'TESTBRAND_WORKTREE_DATA_DIR',
      )?.description,
    ).toContain('TestBrand data');
    expect(
      scripts.SCRIPT_ENV_VAR_DEFINITIONS.find(
        (definition) => definition.name === 'CANOPY_WORKTREE_DATA_DIR',
      )?.description,
    ).toContain('Legacy compatibility alias');
    expect(
      scripts.SCRIPT_ENV_VISIBLE_VAR_DEFINITIONS.map(
        (definition) => definition.name,
      ),
    ).toEqual([
      'TESTBRAND_WORKSPACE_ID',
      'TESTBRAND_WORKTREE_NAME',
      'TESTBRAND_WORKTREE_DATA_DIR',
      'TESTBRAND_WORKSPACE_CHILD_REPO_ID',
    ]);
  });

  it('keeps legacy hook aliases supported but hides them from visible definitions', () => {
    jest.resetModules();
    jest.doMock('@canopy/brand/current', () => ({
      BRAND: {
        displayName: 'TestBrand',
        environment: { prefixes: ['TESTBRAND', 'CANOPY'] },
      },
    }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const hooks = require('../hooks') as typeof HooksModule;

    expect(
      hooks.HOOK_ENV_VAR_DEFINITIONS.some(
        (definition) => definition.name === 'CANOPY_PR_URL',
      ),
    ).toBe(true);
    expect(
      hooks.HOOK_ENV_VISIBLE_VAR_DEFINITIONS.map(
        (definition) => definition.name,
      ),
    ).toContain('TESTBRAND_PR_URL');
    expect(
      hooks.HOOK_ENV_VISIBLE_VAR_DEFINITIONS.some((definition) =>
        definition.name.startsWith('CANOPY_'),
      ),
    ).toBe(false);
    expect(
      hooks.interpolateHookPrompt('PR={{CANOPY_PR_URL}}', {
        CANOPY_PR_URL: 'https://example.com/pr/1',
      }),
    ).toBe('PR=https://example.com/pr/1');
  });

  it('keeps legacy automation aliases supported but hides them from visible definitions', () => {
    jest.resetModules();
    jest.doMock('@canopy/brand/current', () => ({
      BRAND: {
        displayName: 'TestBrand',
        environment: { prefixes: ['TESTBRAND', 'CANOPY'] },
      },
    }));

    const automations =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../lib/automations') as typeof AutomationsModule;

    expect(automations.AUTOMATION_IF_CMD_OUTPUT_VAR_NAMES).toEqual([
      'TESTBRAND_AUTOMATION_IF_CMD_OUTPUT',
      'CANOPY_AUTOMATION_IF_CMD_OUTPUT',
    ]);
    expect(automations.AUTOMATION_IF_CMD_IDEMPOTENCY_KEY_VAR_NAMES).toEqual([
      'TESTBRAND_IDEMPOTENCY_KEY',
      'CANOPY_IDEMPOTENCY_KEY',
      'UNSTOPPABLE_CODE_IDEMPOTENCY_KEY',
    ]);
    expect(automations.AUTOMATION_IF_CMD_IDEMPOTENCY_SCOPE_VAR_NAMES).toEqual([
      'TESTBRAND_IDEMPOTENCY_SCOPE',
      'CANOPY_IDEMPOTENCY_SCOPE',
      'UNSTOPPABLE_CODE_IDEMPOTENCY_SCOPE',
    ]);
    expect(automations.getAutomationIfCommandVariableDefinitions()).toEqual([
      {
        name: 'TESTBRAND_AUTOMATION_IF_CMD_OUTPUT',
        description: 'Standard output captured from the activity If Command.',
      },
    ]);
    expect(
      automations.interpolateAutomationIfCommandOutput(
        'value={{CANOPY_AUTOMATION_IF_CMD_OUTPUT}}',
        'ok',
      ),
    ).toBe('value=ok');
    expect(
      automations.parseAutomationIfCommandOutput(
        'CANOPY_IDEMPOTENCY_KEY=legacy\nTESTBRAND_IDEMPOTENCY_KEY=primary',
      ),
    ).toEqual({
      output: '',
      idempotencyKey: 'primary',
      idempotencyScope: 'self',
    });
  });
});
