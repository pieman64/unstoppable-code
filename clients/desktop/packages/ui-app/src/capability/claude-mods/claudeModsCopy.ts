import type { ClaudeModsUpdateErrorCode } from '@canopy/protocol/claude-mods';

export const CLAUDE_MODS_COPY = {
  admissionLabel: 'Allow in Claude chats',
  admissionDescription:
    'Changes apply to Claude chats from their next message.',
  killSwitchTitle: 'Mods',
  killSwitchLabel: 'Turn off every Mod',
  killSwitchDescription:
    'Turns off every Mod in Claude chats this app starts. Hooks in your own Claude settings keep running. If Claude offers to turn on a Mod in a terminal chat, that choice is yours there.',
  status: {
    changed:
      'This plugin changed after you allowed its Mod. The Mod stays off until you allow it again.',
    unavailable: "This app can't read this plugin's Mod, so it stays off.",
    modsDisabled: 'Every Mod is turned off in Claude settings.',
    authorityUnreadable:
      "Your Mod preferences can't be read, so every Mod stays off and changes are paused.",
  },
} as const;

export const CLAUDE_MODS_UPDATE_ERROR_COPY: Record<
  ClaudeModsUpdateErrorCode | 'request-failed',
  string
> = {
  'flag-off': "Mod controls aren't available right now.",
  'invalid-input': "Couldn't apply this change. Try again.",
  'plugin-not-found': "Couldn't find this plugin. It may have been removed.",
  'plugin-ambiguous':
    "More than one installed plugin has this name, so its Mod can't be changed here.",
  'not-a-mod': 'This plugin no longer has a Mod.',
  'plugin-unreadable': "Couldn't read this plugin's Mod. Try again.",
  'digest-changed':
    'This plugin changed since you opened it. Review it, then allow it again.',
  'authority-unreadable':
    "Your Mod preferences can't be read. Try again when they're available.",
  'save-failed': "Couldn't save the change. Try again.",
  'save-outcome-unknown':
    "Couldn't confirm the change was saved. Check the switch and try again.",
  'request-failed': "Couldn't send the change. Try again.",
};
