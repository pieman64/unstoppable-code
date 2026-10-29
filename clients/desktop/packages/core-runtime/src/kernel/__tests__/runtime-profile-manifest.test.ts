import {
  CANOPY_INSTRUCTION_DEFINITIONS,
  CANOPY_QUERY_DEFINITIONS,
  CANOPY_STREAM_DEFINITIONS,
  CORE_TRANSPORT_QUERY_DEFINITIONS,
} from '@canopy/protocol/canopy-core';
import {
  effectiveRuntimeOperations,
  runtimeProfileInstalls,
  type EffectiveRuntimeOperationsInput,
} from '../runtime-profile-manifest';

// Artifact equality for every profile and principal, and generated-policy
// drift, live in scripts/lib/runtime-profile-policy.test.mjs.
const definitions: EffectiveRuntimeOperationsInput['definitions'] = {
  queries: { ...CANOPY_QUERY_DEFINITIONS, ...CORE_TRANSPORT_QUERY_DEFINITIONS },
  instructions: CANOPY_INSTRUCTION_DEFINITIONS,
  streams: CANOPY_STREAM_DEFINITIONS,
};
const FILESYSTEM = [
  'worker.filesystem.directory.list',
  'worker.filesystem.roots.list',
];
const input = (
  overrides: Partial<EffectiveRuntimeOperationsInput>,
): EffectiveRuntimeOperationsInput => ({
  profile: 'core+worker',
  definitions,
  principal: 'interface',
  grants: ['core.runtime.read', 'worker.filesystem.read'],
  ...overrides,
});
const names = (overrides: Partial<EffectiveRuntimeOperationsInput>): string[] =>
  effectiveRuntimeOperations(input(overrides)).map(({ name }) => name);

describe('effectiveRuntimeOperations', () => {
  it('marks missing grants unavailable and fails closed without a principal', () => {
    expect(names({ grants: [] })).not.toContain('core.runtime.manifest.get');
    const listed = effectiveRuntimeOperations(
      input({ profile: 'core', grants: [], includeUnavailable: true }),
    );
    expect(
      listed.find(({ name }) => name === 'core.runtime.manifest.get'),
    ).toEqual({
      name: 'core.runtime.manifest.get',
      kind: 'query',
      version: 1,
      placement: 'core-only',
      requiredGrants: ['core.runtime.read'],
      available: false,
    });
    expect(names({ principal: null })).toEqual([]);
  });

  it('advertises only registered definitions in classified domains', () => {
    const fixture = CORE_TRANSPORT_QUERY_DEFINITIONS['core.runtime.health.get'];
    expect(
      names({
        profile: 'core',
        definitions: {
          queries: {
            'core.runtime.health.get': fixture,
            'core.example.read': fixture,
            'core.runtime.shadow': fixture,
          },
          instructions: {},
          streams: {},
        },
      }),
    ).toEqual(['core.runtime.health.get']);
    expect(
      runtimeProfileInstalls('core', 'core.runtime.health.get', 'query'),
    ).toBe(true);
    expect(runtimeProfileInstalls('core', 'core.example.read', 'query')).toBe(
      false,
    );
    expect(runtimeProfileInstalls('core', 'core.runtime.shadow', 'query')).toBe(
      false,
    );
    expect(
      runtimeProfileInstalls('core', 'core.runtime.health.get', 'instruction'),
    ).toBe(false);
    expect(runtimeProfileInstalls('core', FILESYSTEM[0], 'query')).toBe(false);
    expect(
      runtimeProfileInstalls('worker', 'core.runtime.health.get', 'query'),
    ).toBe(false);
    expect(runtimeProfileInstalls('core+worker', FILESYSTEM[0], 'query')).toBe(
      true,
    );
  });

  it('keeps core and authorityOnly operations from non-authority modes', async () => {
    const wide = {
      installed: ['*'],
      principals: ['interface', 'owning-core', 'delegating-primary'],
      modes: {
        authority: ['*'],
        'delegated-execution': ['*'],
        'read-only': ['*'],
      },
    };
    jest.doMock('../runtime-profile-policy.generated', () => ({
      ...jest.requireActual<object>('../runtime-profile-policy.generated'),
      RUNTIME_PROFILE_AUTHORITY_ONLY: [FILESYSTEM[0]],
      RUNTIME_PROFILE_DOMAINS: {
        core: {},
        worker: {},
        'core+worker': { 'core.runtime': wide, 'worker.filesystem': wide },
      },
    }));
    await jest.isolateModulesAsync(async () => {
      const isolated = await import('../runtime-profile-manifest');
      const reach = (
        principal: 'owning-core' | 'delegating-primary',
      ): string[] =>
        isolated
          .effectiveRuntimeOperations(input({ principal }))
          .map(({ name }) => name);
      expect(reach('delegating-primary')).toEqual([FILESYSTEM[1]]);
      expect(reach('owning-core')).toEqual(
        expect.arrayContaining(['core.runtime.manifest.get', ...FILESYSTEM]),
      );
    });
    jest.dontMock('../runtime-profile-policy.generated');
  });
});
