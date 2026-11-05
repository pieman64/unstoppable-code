import type { ShortcutPlatform } from '@canopy/protocol/shortcuts';
import type { ChatModel } from '../../types';

/** Host facts preference normalization reads at call time. */
export interface PreferencesNormalizationEnvironment {
  /** Canonical id of a model this install can run now, or null. */
  resolveAvailableModel(model: unknown): ChatModel | null;
  /** Whether this build runs Ollama models (desktop: `__CANOPY_OLLAMA_ENABLED__`). */
  ollamaEnabled(): boolean;
  /** Platform the saved global focus shortcut is validated for. */
  shortcutPlatform(): ShortcutPlatform;
}

let installedEnvironment: PreferencesNormalizationEnvironment | undefined;

/** Replaces the process-wide environment. Hosts call it before normalizing. */
export function installPreferencesNormalizationEnvironment(
  environment: PreferencesNormalizationEnvironment,
): void {
  installedEnvironment = environment;
}

/**
 * The installed environment. Throws
 * `Error('Preferences normalization has no host environment; call installPreferencesNormalizationEnvironment first.')`
 * when none is installed.
 */
export function preferencesNormalizationEnvironment(): PreferencesNormalizationEnvironment {
  if (installedEnvironment === undefined) {
    throw new Error(
      'Preferences normalization has no host environment; call installPreferencesNormalizationEnvironment first.',
    );
  }
  return installedEnvironment;
}
