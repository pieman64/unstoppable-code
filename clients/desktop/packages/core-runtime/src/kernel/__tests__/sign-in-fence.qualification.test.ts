import {
  WORKER_AGENT_HELPER_INSTRUCTION_DEFINITIONS,
  WORKER_AGENT_SIGN_IN_INSTRUCTION_DEFINITIONS,
} from '@canopy/protocol/canopy-core';
import {
  effectiveRuntimeOperations,
  type EffectiveRuntimeOperationsInput,
} from '../runtime-profile-manifest';
import {
  RUNTIME_PROFILE_AUTHORITY_ONLY,
  RUNTIME_PROFILE_DOMAINS,
} from '../runtime-profile-policy.generated';

it('fences worker.agent.signIn.run from interface and delegated principals', () => {
  const input: EffectiveRuntimeOperationsInput = {
    profile: 'core+worker',
    principal: 'interface',
    grants: ['worker.agent.auth', 'worker.agent.execute'],
    definitions: {
      queries: {},
      instructions: {
        'worker.agent.signIn.run':
          WORKER_AGENT_SIGN_IN_INSTRUCTION_DEFINITIONS[
            'worker.agent.signIn.run'
          ],
        'worker.agent.helper.run':
          WORKER_AGENT_HELPER_INSTRUCTION_DEFINITIONS[
            'worker.agent.helper.run'
          ],
      },
      streams: {},
    },
  };
  const names = (
    overrides: Partial<EffectiveRuntimeOperationsInput>,
  ): string[] =>
    effectiveRuntimeOperations({ ...input, ...overrides }).map(
      ({ name }) => name,
    );

  expect(names({})).toEqual([]);
  expect(names({ principal: 'delegating-primary' })).toEqual([]);
  expect(RUNTIME_PROFILE_AUTHORITY_ONLY).toContain('worker.agent.signIn.run');
  for (const profile of ['core+worker', 'worker'] as const) {
    const { modes } = RUNTIME_PROFILE_DOMAINS[profile]['worker.agent'];
    expect(modes.authority).toContain('!worker.agent.signIn.run');
    expect(modes['delegated-execution']).toContain('!worker.agent.signIn.run');
  }
});
