import type { DesktopBlueprintCatalogEntry } from '@canopy/desktop-shared/types';
import type { ChatProjectData } from '@canopy/desktop-shared/types';
import {
  getShareablePluginRefKey,
  type ShareablePluginRef,
} from '@canopy/protocol';
import type { OnboardingChatBlueprintContext } from '@/stores/onboardingSuggestionSurfacesStore';

/**
 * The plugin refs a project template bundles, in document order and with
 * their sources intact so each resolves against the marketplace it names.
 * Only plugin refs count: a skill ref is installed at seed time and has
 * nothing for the checklist to enable or connect.
 */
export function blueprintPluginRefs(
  plugins: readonly ShareablePluginRef[],
): ShareablePluginRef[] {
  const refs: ShareablePluginRef[] = [];
  const seen = new Set<string>();
  for (const ref of plugins) {
    if (ref.type === 'skill') continue;
    let key: string;
    try {
      key = getShareablePluginRefKey(ref);
    } catch {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

/**
 * The checklist context for an empty new chat in `project` (CAN-3032): the
 * cached curated template it was seeded from, or null when the project has
 * no template or the catalog no longer carries it. Starter prompts prefer the
 * project's own copy (editable in its settings), the same precedence the
 * composer's suggestion chips use.
 */
export function buildOnboardingChatBlueprintContext(
  project: Pick<
    ChatProjectData,
    | 'id'
    | 'seededFromBlueprintExternalId'
    | 'starterPrompts'
    | 'defaultPluginSelections'
  >,
  blueprint: DesktopBlueprintCatalogEntry | undefined,
): OnboardingChatBlueprintContext | null {
  if (
    project.seededFromBlueprintExternalId === undefined ||
    blueprint === undefined ||
    blueprint.externalId !== project.seededFromBlueprintExternalId
  ) {
    return null;
  }
  return {
    projectId: project.id,
    externalId: blueprint.externalId,
    name: blueprint.document.name,
    pluginRefs: blueprintPluginRefs(blueprint.document.plugins),
    starterPrompts: project.starterPrompts ?? blueprint.document.starterPrompts,
    projectSelections: project.defaultPluginSelections ?? null,
  };
}
