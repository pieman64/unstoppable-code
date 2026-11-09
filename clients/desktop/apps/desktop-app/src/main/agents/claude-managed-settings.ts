import type { Options as ClaudeQueryOptions } from '@anthropic-ai/claude-agent-sdk';

// Matches no command. Any non-empty policy tier keeps Claude's built-in plugin
// guard ahead of a user-installed Mod's tool.check, so a Mod cannot approve a
// call Canopy denied.
export const CLAUDE_NEVER_MATCHING_DENY_RULE =
  'Bash(canopy-never-matches-7f3a)';

/** A fresh managed-settings guard for one Claude launch. */
export function claudeManagedSettingsGuard(): NonNullable<
  ClaudeQueryOptions['managedSettings']
> {
  return { permissions: { deny: [CLAUDE_NEVER_MATCHING_DENY_RULE] } };
}
