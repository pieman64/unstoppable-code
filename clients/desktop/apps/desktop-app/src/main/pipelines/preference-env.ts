import {
  getGitExecutablePlatformStatus,
  getResolvedGitExecutableForSpawn,
} from '../lib/git-executable';
import { brandEnvName } from '@canopy/desktop-shared/brand/env';
import type { PreferencesData } from '@canopy/desktop-shared/types';

export async function buildPipelinePreferenceEnv(
  preferences: PreferencesData,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {
    [brandEnvName('PREF_RTK_ENABLED')]: preferences.rtkEnabled
      ? 'true'
      : 'false',
    [brandEnvName('PREF_CODEX_MULTI_AGENT_PIPELINES_ENABLED')]:
      preferences.codexMultiAgentPipelinesEnabled ? 'true' : 'false',
    [brandEnvName('PREF_CODEX_MAX_CONCURRENT_SUBAGENTS')]:
      preferences.codexMaxConcurrentSubagents == null
        ? 'default'
        : String(preferences.codexMaxConcurrentSubagents),
    // Always project the resolved desktop preference. CLI-native executions
    // do not pass this variable and deliberately retain the fail-off boundary.
    [brandEnvName('PREF_LOCAL_MEMORY_ENABLED')]: preferences.localMemoryEnabled
      ? '1'
      : '0',
    [brandEnvName('PREF_PR_GENERATION_MODEL')]: preferences.prGenerationModel,
    [brandEnvName('PREF_PR_GENERATION_THINKING_LEVEL')]:
      preferences.prGenerationThinkingLevel,
    [brandEnvName('PREF_PR_INSTRUCTIONS')]: preferences.prInstructions,
    [brandEnvName('PREF_PR_INSTRUCTION_MODE')]: preferences.prInstructionMode,
    [brandEnvName('PREF_COMMIT_GENERATION_MODEL')]:
      preferences.commitGenerationModel,
    [brandEnvName('PREF_COMMIT_GENERATION_THINKING_LEVEL')]:
      preferences.commitGenerationThinkingLevel,
    [brandEnvName('PREF_COMMIT_INSTRUCTIONS')]: preferences.commitInstructions,
    [brandEnvName('PREF_COMMIT_INSTRUCTION_MODE')]:
      preferences.commitInstructionMode,
  };

  // Global Instructions (Instructions settings), pipelines section. Serialized so
  // builtin agent actions running as plain Node subprocesses (and the Codex
  // host runners reading the step environment) can resolve the
  // "User Overall Preferences" block per agent context.
  const pipelinesGlobalInstructions = preferences.globalInstructions?.pipelines;
  if (
    pipelinesGlobalInstructions &&
    (pipelinesGlobalInstructions.overall.trim().length > 0 ||
      pipelinesGlobalInstructions.scoped.length > 0)
  ) {
    env[brandEnvName('PREF_GLOBAL_INSTRUCTIONS_PIPELINES')] = JSON.stringify(
      pipelinesGlobalInstructions,
    );
  }

  // Preferences may have been read before another operation repaired Git.
  // Windows subprocesses must inherit the current validated installation.
  const gitExecutablePath = getGitExecutablePlatformStatus().required
    ? await getResolvedGitExecutableForSpawn()
    : preferences.gitExecutablePath.trim();
  if (gitExecutablePath) {
    env.CANOPY_GIT_EXECUTABLE = gitExecutablePath;
  }

  return env;
}
