import type {
  ClaudeModPluginState,
  ClaudeModsState,
  ClaudeModsUpdate,
} from '@canopy/protocol/claude-mods';
import { CLAUDE_MODS_COPY } from './claudeModsCopy';

/** What a plugin's "Allow in Claude chats" switch shows. */
export interface ClaudeModAdmissionSwitchState {
  readonly checked: boolean;
  readonly disabled: boolean;
  /** Why the plugin's Mod stays off, when the switch can't say it alone. */
  readonly statusText: string | null;
}

/** The admission switch for the plugin in `state`, while a change may be pending. */
export function claudeModAdmissionSwitchState(
  state: ClaudeModsState,
  plugin: ClaudeModPluginState,
  pending: boolean,
): ClaudeModAdmissionSwitchState {
  const statusText = state.modsDisabled
    ? CLAUDE_MODS_COPY.status.modsDisabled
    : state.authorityUnreadable
      ? CLAUDE_MODS_COPY.status.authorityUnreadable
      : plugin.status === 'changed'
        ? CLAUDE_MODS_COPY.status.changed
        : plugin.status === 'unavailable'
          ? CLAUDE_MODS_COPY.status.unavailable
          : null;
  const disabled =
    pending ||
    state.modsDisabled ||
    state.authorityUnreadable ||
    plugin.status === 'unavailable' ||
    (plugin.status !== 'allowed' && !plugin.contentDigest);
  return { checked: plugin.status === 'allowed', disabled, statusText };
}

/**
 * The update for turning the plugin's switch to `next`, or null when it can't
 * be allowed (no content digest to allow). The hook adds the chat context.
 */
export function claudeModAdmissionUpdate(
  plugin: ClaudeModPluginState,
  next: boolean,
): ClaudeModsUpdate | null {
  if (!next) return { action: 'disallow', pluginId: plugin.pluginId };
  if (!plugin.contentDigest) return null;
  return {
    action: 'allow',
    pluginId: plugin.pluginId,
    contentDigest: plugin.contentDigest,
  };
}
