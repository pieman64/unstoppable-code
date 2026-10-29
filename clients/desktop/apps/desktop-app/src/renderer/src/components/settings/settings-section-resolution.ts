import {
  isOllamaSupportedOnPlatform,
  isVoiceDictationPlatform,
} from '@canopy/desktop-shared/platform-capabilities';
import type {
  LegacySettingsSection,
  SettingsSection,
} from '@canopy/desktop-shared/types';

/**
 * Resolve the requested settings section to a section that is valid for the
 * current platform.
 *
 * Older deep links or persisted state may request `'dictation'` on Windows or
 * Linux. The settings overlay must downgrade those requests to the default
 * `'canopy'` section so the renderer never tries to mount the dictation tab on
 * a platform that does not support voice input.
 *
 * Older deep links may also request the legacy `'pipeline-advisor'` section
 * (renamed to `'app-advisor'`). Those requests transparently resolve to the
 * new key so external openers do not break.
 *
 * On desktop platforms where Ollama is unsupported (per the shared
 * `isOllamaSupportedOnPlatform()` predicate), a requested or persisted
 * `'ollama'` section downgrades to the default `'canopy'` section so the
 * renderer never mounts the Ollama tab. Ollama is supported on macOS and
 * Windows.
 *
 * The `'code-graph'` section downgrades to `'canopy'` while the Code Graph
 * feature flag is off, matching its hidden nav entry. `'remote-access'` does
 * the same while remote access is unavailable in this window.
 *
 * With hosted account settings available, `'notifications'` has no rail row
 * and no local page: the overlay opens hosted Notifications instead, and the
 * local section underneath resolves to `'canopy'`.
 */
export function resolveSettingsSection(
  requested: SettingsSection | LegacySettingsSection | undefined,
  platform: NodeJS.Platform,
  options: {
    claudeSettingsAvailable?: boolean;
    codeGraphEnabled?: boolean;
    remoteAccessEnabled?: boolean;
    hostedSettingsAvailable?: boolean;
  } = {},
): SettingsSection {
  const migrated = migrateLegacySettingsSection(requested);
  if (migrated === 'dictation' && !isVoiceDictationPlatform(platform)) {
    return 'canopy';
  }
  if (migrated === 'ollama' && !isOllamaSupportedOnPlatform()) {
    return 'canopy';
  }
  if (migrated === 'claude' && options.claudeSettingsAvailable === false) {
    return 'canopy';
  }
  if (migrated === 'code-graph' && options.codeGraphEnabled === false) {
    return 'canopy';
  }
  if (migrated === 'remote-access' && options.remoteAccessEnabled === false) {
    return 'canopy';
  }
  if (
    migrated === 'notifications' &&
    options.hostedSettingsAvailable === true
  ) {
    return 'canopy';
  }
  return migrated ?? 'canopy';
}

function migrateLegacySettingsSection(
  requested: SettingsSection | LegacySettingsSection | undefined,
): SettingsSection | undefined {
  if (requested === 'pipeline-advisor') {
    return 'app-advisor';
  }
  return requested;
}
