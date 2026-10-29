import type { ProfileRoleId } from '@canopy/protocol/plugin-catalog';
import {
  DEFAULT_PLUGIN_RECOMMENDATION_ROLE,
  PROFILE_ROLE_LABELS,
  ROLE_PLUGIN_RECOMMENDATIONS,
  type ProfileRoleOption,
} from '@canopy/protocol/plugin-catalog';

/**
 * The profile roles offered as categories above the Getting started tool
 * tiles, few enough to share one row. Picking categories reorders the tool
 * suggestions, so these are the roles with the most distinct shortlists.
 */
export const ONBOARDING_CATEGORY_ROLES: readonly ProfileRoleId[] = [
  'software-engineer',
  'product-manager',
  'designer',
  'founder',
  'marketing',
];

/**
 * The category row's options: the leading roles, then any role the profile
 * already holds that is not among them, so a saved answer stays visible and
 * can be turned off.
 */
export function onboardingCategoryOptions(
  selected: readonly ProfileRoleId[],
): ProfileRoleOption[] {
  const extra = selected.filter(
    (role) => !ONBOARDING_CATEGORY_ROLES.includes(role),
  );
  return [...ONBOARDING_CATEGORY_ROLES, ...new Set(extra)].map((id) => ({
    id,
    label: PROFILE_ROLE_LABELS[id],
  }));
}

// The shortlists live in protocol so Marketplace Suggested and this
// checklist resolve the same role picks. Universal connectors always lead the
// checklist; the map only orders the following tail.

/**
 * Append each selected role's shortlist in selection order. A shared plugin is
 * emitted only once, so choosing another role expands the existing list
 * without repeating tools the user already saw.
 */
export function orderedRolePluginNames(
  selectedRoles: readonly ProfileRoleId[] | null,
  excludedNames: ReadonlySet<string>,
): string[] {
  // A skipped or not-yet-saved role should still receive the strongest
  // default technical recommendations instead of an unexplained empty tail.
  const effectiveRoles = selectedRoles?.length
    ? selectedRoles
    : [DEFAULT_PLUGIN_RECOMMENDATION_ROLE];
  const seen = new Set(excludedNames);
  const names: string[] = [];
  for (const role of effectiveRoles) {
    for (const name of ROLE_PLUGIN_RECOMMENDATIONS[role]) {
      if (seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/** Figma's generic code-implementation example is wrong for design/PM roles. */
export const ROLE_PLUGIN_PROMPT_OVERRIDES: Readonly<Record<string, string>> = {
  figma:
    'Summarize the latest changes in my Figma designs and flag what needs review',
};

/** One hardcoded universally-useful suggestion, ahead of catalog picks. */
export interface UniversalPluginSuggestionDef {
  /** Suggestion id — the queue entry persists as `plugin:universal:<id>`. */
  id: string;
  displayName: string;
  description: string;
  /** The exact try-step prompt. */
  promptText: string;
  /**
   * Lowercased curated plugin names that belong to this suggestion; Add
   * enables every catalog match.
   */
  pluginNames: readonly string[];
  /**
   * The subset of {@link pluginNames} that actually backs the try-step
   * prompt. The row only advances to its try step when one of THESE is
   * enabled — enabling Drive alone must not advance a row whose prompt
   * asks for Gmail and Calendar. Defaults to `pluginNames` when omitted.
   */
  promptPluginNames?: readonly string[];
  /** Name used for the logo join (curated MCP catalog key). */
  logoName: string;
  /** Discovery search prefill for the can't-enable fallback. */
  searchQuery: string;
}

/**
 * The universally-useful head of the plugin tail. A row appears only when
 * its plugin is locally available in the curated marketplace, and always
 * before role-targeted picks.
 */
export const UNIVERSAL_PLUGIN_SUGGESTIONS: readonly UniversalPluginSuggestionDef[] =
  [
    {
      id: 'gmail',
      displayName: 'Gmail',
      description: 'Work with email and replies',
      promptText: 'Summarize the emails waiting on my reply',
      pluginNames: ['gmail', 'gmail-gmailmcp'],
      logoName: 'gmail-gmailmcp',
      searchQuery: 'gmail',
    },
    {
      id: 'google-calendar',
      displayName: 'Google Calendar',
      description: 'Prepare for meetings and find time',
      promptText: 'Prep me for my next meeting',
      pluginNames: ['google-calendar', 'google-calendar-calendarmcp', 'gcal'],
      logoName: 'google-calendar-calendarmcp',
      searchQuery: 'google calendar',
    },
    {
      id: 'slack',
      displayName: 'Slack',
      description: 'Catch up on channels and threads',
      promptText: 'Are there any threads I need to follow up with in Slack?',
      pluginNames: ['slack'],
      logoName: 'slack',
      searchQuery: 'slack',
    },
    {
      id: 'notion',
      displayName: 'Notion',
      description: 'Work with your notes and docs',
      promptText: 'Summarize recent updates in Notion',
      pluginNames: ['notion'],
      logoName: 'notion',
      searchQuery: 'notion',
    },
    {
      id: 'google-drive',
      displayName: 'Google Drive',
      description: 'Work with documents and spreadsheets',
      promptText:
        'Analyze a spreadsheet from my Google Drive and chart the key trends',
      pluginNames: ['google-drive', 'google-drive-drivemcp'],
      logoName: 'google-drive-drivemcp',
      searchQuery: 'google drive',
    },
    {
      id: 'datadog',
      displayName: 'Datadog',
      description: 'Understand your services and alerts',
      promptText:
        'Review recent Datadog alerts and summarize which services need attention',
      pluginNames: ['datadog'],
      logoName: 'datadog',
      searchQuery: 'datadog',
    },
  ];

/**
 * Tools connected where they are first needed instead of from a Getting
 * started tile: GitHub is offered when a push or pull request needs it
 * (CAN-4006). Their connected-tool examples still appear.
 */
const CONNECTED_WHEN_NEEDED_TOOL_KEYS: ReadonlySet<string> = new Set([
  'github',
]);

/** The tools step's connection tiles: every recommendation but GitHub. */
export function checklistConnectionTiles<T extends { key: string }>(
  tools: readonly T[],
): T[] {
  return tools.filter((tool) => !CONNECTED_WHEN_NEEDED_TOOL_KEYS.has(tool.key));
}
