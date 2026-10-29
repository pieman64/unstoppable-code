import { getBrandEnv } from '../../brand/env';

/**
 * Harness-native memory gating (CAN-1969, default restored by CAN-2657).
 *
 * Canopy Local Memory is enabled by default with a persisted opt-out. While
 * the resolved preference is ON, harness-native auto-memory is suppressed on
 * every Claude launch path (interactive SDK sessions, the Claude terminal and
 * claude-worker settings file, builtin pipeline actions, structured helper
 * queries, one-shot helper summaries, discovery sessions, and advisor turns)
 * and on every direct Codex thread launch (interactive sessions, helper
 * summaries, structured helper dispatch, pipeline advisor turns, and the
 * desktop/CLI pipeline runtimes) so the two memory systems never run at once.
 * While the preference is OFF, no suppression key is emitted anywhere and the
 * provider/harness defaults apply untouched.
 *
 * Every helper takes the resolved preference explicitly so this module stays
 * the single decision point. Electron-main callers read the preferences file;
 * subprocess contexts (builtin pipeline actions, the desktop/CLI pipeline
 * runtimes) receive the decision through the branded
 * `*_PREF_LOCAL_MEMORY_ENABLED` environment variable via
 * {@link localMemoryEnabledFromEnv}.
 *
 * The branded `*_HARNESS_NATIVE_MEMORY` env var (`1`/`true`) is a debug
 * escape hatch that force-allows harness-native memory even while local
 * memory is enabled.
 */
export function harnessNativeMemoryAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = getBrandEnv(env, 'HARNESS_NATIVE_MEMORY');
  return value === '1' || value === 'true';
}

/**
 * Resolve the `localMemoryEnabled` preference from a subprocess environment.
 *
 * The desktop app projects the preference into pipeline/step environments as
 * the branded `PREF_LOCAL_MEMORY_ENABLED` variable (see
 * `buildPipelinePreferenceEnv`). The variable is absent for CLI-native
 * executions that were not launched by the desktop app. Local memory is then
 * deliberately treated as OFF at this CLI boundary, so provider-native memory
 * keeps its harness defaults even though the desktop application defaults on.
 */
export function localMemoryEnabledFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const value = getBrandEnv(env, 'PREF_LOCAL_MEMORY_ENABLED');
  return value === '1' || value === 'true';
}

function nativeMemorySuppressed(
  localMemoryEnabled: boolean,
  env: NodeJS.ProcessEnv,
): boolean {
  return localMemoryEnabled && !harnessNativeMemoryAllowed(env);
}

/**
 * Session flag settings carried on a Claude launch: thinking-derived flags
 * (currently Ultra's `ultracode`) plus the native-memory suppression flag.
 */
export interface ClaudeNativeMemorySettings {
  ultracode?: boolean;
  autoMemoryEnabled?: boolean;
  // Match the SDK `Settings` index signature so this fragment stays
  // assignable to `Options['settings']` without casts.
  [k: string]: unknown;
}

/**
 * Flat settings fragment for Claude settings files (Claude terminal and
 * claude-worker `--settings` JSON). Spread beside `permissions`/`hooks`;
 * empty (harness default) unless local memory is enabled and the escape
 * hatch does not force-allow native memory.
 */
export function nativeMemorySettingsOverride(
  localMemoryEnabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Pick<ClaudeNativeMemorySettings, 'autoMemoryEnabled'> {
  return nativeMemorySuppressed(localMemoryEnabled, env)
    ? { autoMemoryEnabled: false }
    : {};
}

/**
 * Claude SDK `Options` fragment applying the native-memory suppression.
 * Merges with the caller's thinking-derived flag settings (Ultra sets
 * `ultracode`) so a later spread cannot drop the suppression flag, and omits
 * the `settings` key entirely when there is nothing to set. Spread this into
 * every direct `query()` call's options.
 */
export function claudeNativeMemoryOptions(
  localMemoryEnabled: boolean,
  baseSettings?: ClaudeNativeMemorySettings,
  env: NodeJS.ProcessEnv = process.env,
): { settings?: ClaudeNativeMemorySettings } {
  if (!nativeMemorySuppressed(localMemoryEnabled, env)) {
    return baseSettings ? { settings: baseSettings } : {};
  }
  return { settings: { ...baseSettings, autoMemoryEnabled: false } };
}

/**
 * Pre-flattened Codex thread-config fragment applying the native-memory
 * suppression. Spread it into `params.config` (or the pipeline base config)
 * on every direct Codex `thread/start` / `thread/resume` / ephemeral-turn
 * launch; empty (canonical Codex config authoritative) unless local memory is
 * enabled and the escape hatch does not force-allow native memory. The dotted
 * `features.memories` key matters: assigning a nested `features` object would
 * clobber the whole canonical `features` table when the runtime flattens the
 * thread config.
 */
export function codexNativeMemoryThreadConfig(
  localMemoryEnabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): { 'features.memories'?: false } {
  return nativeMemorySuppressed(localMemoryEnabled, env)
    ? { 'features.memories': false }
    : {};
}
