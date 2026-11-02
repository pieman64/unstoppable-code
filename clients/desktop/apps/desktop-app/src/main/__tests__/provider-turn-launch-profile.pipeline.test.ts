/** Compare recorder C4 profiles with a real product turn's transport options. */
import { loadLifecycleProfiles } from './pipeline-harness/fixture-replay';
import {
  projectClaudeLaunch,
  projectCodexLaunch,
} from './pipeline-harness/fixture-replay-templates';
import {
  createScenarioEnvironment,
  disposeScenario,
  finishScenario,
  startRoot,
  SCENARIO_TEST_TIMEOUT_MS,
} from './pipeline-harness/scenarios';
import type { PipelineProvider } from './pipeline-harness/contracts';
import type { AgentSession } from '../agents/types';
import type { ClaudeCompatibleInvocation } from '../agents/claude-session';

async function captureOllamaClaudeCompatibleLaunch(): Promise<unknown> {
  const env = await createScenarioEnvironment('worktree', 'claude');
  let session: AgentSession | undefined;
  try {
    const { ClaudeCodeProvider } = await import('../agents/claude-session');
    const provider = new ClaudeCodeProvider({
      providerType: 'ollama',
      prepareInvocation: (): Promise<ClaudeCompatibleInvocation> =>
        Promise.resolve({
          providerType: 'ollama',
          sdkModel: 'llama3:8b',
          envOverride: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' },
        }),
    });
    session = provider.createSession(
      {
        cwd: '/tmp/ollama-launch-profile',
        projectId: 'launch-profile-project',
        worktreeId: 'launch-profile-worktree',
        chatId: 'ollama-launch-profile',
        providerType: 'ollama',
        model: 'ollama-llama3:8b',
      },
      () => undefined,
      () => null,
    );
    session.sendMessage('Ollama launch profile probe', {
      userMessageId: 'ollama-launch-profile',
    });
    const turn = await env.driver.nextTurn({ timeoutMs: 10_000 });
    const launchInput = env.driver.getLaunchInputs?.()[0];
    await turn.complete();
    return launchInput;
  } finally {
    await session?.destroy();
    await disposeScenario(env);
  }
}

for (const provider of ['claude', 'codex'] satisfies PipelineProvider[]) {
  it(
    provider === 'claude'
      ? 'claude: native chat launch equals claude-chat profile; native-agents keeps declared-key coverage'
      : 'codex: product launch projection equals every recorder profile',
    async () => {
      const env = await createScenarioEnvironment('worktree', provider);
      try {
        const turn = await startRoot(env, `${provider} profile capture`);
        await turn.complete();
        await finishScenario(
          env,
          provider === 'claude' ? [11, 17, 19] : [11, 17],
        );
        const inputs = env.driver.getLaunchInputs?.();
        expect(inputs?.length).toBeGreaterThan(0);
        const input = inputs?.[0];
        const projection =
          provider === 'claude'
            ? projectClaudeLaunch(input)
            : projectCodexLaunch(input);
        const profiles = loadLifecycleProfiles().filter(
          (profile) => profile.provider === provider,
        );
        // Before recorder profiles land, still assert the complete captured C4 shape.
        expect(Object.keys(projection).sort()).toEqual(
          provider === 'claude'
            ? [
                'disallowedToolsSet',
                'envKeysSet',
                'hookEventsSet',
                'includePartialMessages',
                'perTaskStopAffordance',
                'permissionMode',
                'promptMode',
                'sessionStateEventsEnv',
                'settingSources',
                'systemPromptKind',
              ]
            : ['approvalPolicy', 'featuresSet', 'multiAgent', 'sandbox'],
        );

        if (provider === 'claude') {
          expect(projection).toMatchObject({
            perTaskStopAffordance: true,
            sessionStateEventsEnv: '1',
          });
          const chatProfile = profiles.find(
            (profile) => profile.profile === 'claude-chat',
          );
          expect(chatProfile).toBeDefined();
          expect({
            profile: chatProfile?.profile,
            projection,
          }).toEqual({
            profile: 'claude-chat',
            projection: chatProfile?.productProjection,
          });

          const nativeAgentsProfile = profiles.find(
            (profile) => profile.profile === 'claude-native-agents',
          );
          expect(nativeAgentsProfile).toBeDefined();
          const declaredProjection = Object.fromEntries(
            Object.keys(nativeAgentsProfile?.productProjection ?? {}).map(
              (key) => [key, projection[key]],
            ),
          );
          expect({
            profile: nativeAgentsProfile?.profile,
            projection: declaredProjection,
          }).toEqual({
            profile: 'claude-native-agents',
            projection: nativeAgentsProfile?.productProjection,
          });
        } else {
          for (const profile of profiles) {
            expect({ profile: profile.profile, projection }).toEqual({
              profile: profile.profile,
              projection: profile.productProjection,
            });
          }
        }
      } finally {
        await disposeScenario(env);
      }
    },
    SCENARIO_TEST_TIMEOUT_MS,
  );
}

it('launch projection rejects absent capture rather than comparing two defaults', () => {
  expect(() => projectClaudeLaunch(undefined)).toThrow('launch object');
  expect(() => projectCodexLaunch(undefined)).toThrow('launch object');
}, 5000);

it(
  'Ollama-backed Claude-compatible launch omits native Claude chat controls',
  async () => {
    const projection = projectClaudeLaunch(
      await captureOllamaClaudeCompatibleLaunch(),
    );
    expect(projection.sessionStateEventsEnv).not.toBe('1');
    expect(projection.perTaskStopAffordance).not.toBe(true);
  },
  SCENARIO_TEST_TIMEOUT_MS,
);
