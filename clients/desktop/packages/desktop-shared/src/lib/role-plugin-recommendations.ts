import {
  type ProfileRoleId,
  DEFAULT_PLUGIN_RECOMMENDATION_ROLE,
  ROLE_PLUGIN_RECOMMENDATIONS,
} from '@canopy/protocol/plugin-catalog';
export {
  DEFAULT_PLUGIN_RECOMMENDATION_ROLE,
  ROLE_PLUGIN_RECOMMENDATIONS,
} from '@canopy/protocol/plugin-catalog';

function canonicalPluginNames(names: Iterable<string>): Set<string> {
  return new Set(
    Array.from(names, (name) => name.trim().toLowerCase()).filter(Boolean),
  );
}

function availableRecommendations(
  roles: readonly ProfileRoleId[],
  availableNames: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const recommendations: string[] = [];

  for (const role of roles) {
    for (const name of ROLE_PLUGIN_RECOMMENDATIONS[role]) {
      if (!availableNames.has(name) || seen.has(name)) continue;
      seen.add(name);
      recommendations.push(name);
    }
  }

  return recommendations;
}

/**
 * Resolve the saved roles against the active catalog, then remove installed
 * plugins from the result. If no saved-role pick exists in the catalog, use
 * the same default-role fallback as Getting Started.
 *
 * Installed names are filtered only after the role set is chosen. Installing
 * every relevant pick therefore empties Suggested instead of replacing the
 * completed role recommendations with unrelated fallback picks.
 */
export function resolveRolePluginRecommendations(
  selectedRoles: readonly ProfileRoleId[] | null | undefined,
  availablePluginNames: Iterable<string>,
  installedPluginNames: Iterable<string> = [],
): string[] {
  const availableNames = canonicalPluginNames(availablePluginNames);
  const roles = selectedRoles?.length
    ? Array.from(new Set(selectedRoles))
    : [DEFAULT_PLUGIN_RECOMMENDATION_ROLE];

  let recommendations = availableRecommendations(roles, availableNames);
  if (recommendations.length === 0) {
    recommendations = availableRecommendations(
      [DEFAULT_PLUGIN_RECOMMENDATION_ROLE],
      availableNames,
    );
  }

  const installedNames = canonicalPluginNames(installedPluginNames);
  return recommendations.filter((name) => !installedNames.has(name));
}
