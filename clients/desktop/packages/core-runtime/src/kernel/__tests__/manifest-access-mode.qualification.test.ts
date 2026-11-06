import {
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  WORKER_QUERY_DEFINITIONS,
} from '@canopy/protocol/canopy-core';
import {
  effectiveRuntimeOperations,
  type EffectiveRuntimeOperationsInput,
} from '../runtime-profile-manifest';

it('restricts the manifest to the principal access mode and held grants', () => {
  const input: EffectiveRuntimeOperationsInput = {
    profile: 'core+worker',
    principal: 'interface',
    grants: ['core.runtime.read', 'worker.filesystem.read'],
    definitions: {
      queries: {
        'core.runtime.health.get':
          CORE_TRANSPORT_QUERY_DEFINITIONS['core.runtime.health.get'],
        'worker.filesystem.roots.list':
          WORKER_QUERY_DEFINITIONS['worker.filesystem.roots.list'],
      },
      instructions: {},
      streams: {},
    },
  };
  const names = (
    overrides: Partial<EffectiveRuntimeOperationsInput>,
  ): string[] =>
    effectiveRuntimeOperations({ ...input, ...overrides }).map(
      ({ name }) => name,
    );

  expect(names({})).toEqual([
    'core.runtime.health.get',
    'worker.filesystem.roots.list',
  ]);
  expect(names({ principal: 'delegating-primary' })).toEqual([
    'worker.filesystem.roots.list',
  ]);
  expect(names({ grants: ['core.runtime.read'] })).toEqual([
    'core.runtime.health.get',
  ]);
  expect(names({ grants: [] })).toEqual([]);
  expect(names({ principal: null })).toEqual([]);
});
