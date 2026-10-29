import { WORKSPACE_TEMPLATE_SHARE_LABEL } from '@canopy/protocol';
import type {
  ChatTabPluginSelections,
  DesktopBlueprintCatalogEntry,
} from '@canopy/desktop-shared/types';
import { resolveBlueprintsForSeeding } from '../blueprints/blueprint-catalog';
import { getShareablePluginRefKey } from '@canopy/desktop-shared/plugin-refs';
import { getObservabilityService } from '../observability';
import { resolveDesktopWorkspaceTemplate } from '../plugins/workspace-template-import';

export interface CuratedBlueprintSeed {
  blueprint: DesktopBlueprintCatalogEntry;
  selections: ChatTabPluginSelections;
  unresolvedRefs: string[];
}

/** Verify a curated Blueprint identity and resolve its local capability seed. */
export async function resolveCuratedBlueprintSeed(source: {
  externalId: string;
  contentHash: string;
}): Promise<CuratedBlueprintSeed> {
  const resolution = await resolveBlueprintsForSeeding();
  if (resolution.status === 'unavailable') {
    throw new Error(
      `${WORKSPACE_TEMPLATE_SHARE_LABEL} catalog is unavailable. Try again.`,
    );
  }
  const blueprint = resolution.blueprints.find(
    (candidate) => candidate.externalId === source.externalId.toLowerCase(),
  );
  if (!blueprint || blueprint.contentHash !== source.contentHash) {
    throw new Error(
      `${WORKSPACE_TEMPLATE_SHARE_LABEL} changed. Refresh and try again.`,
    );
  }
  const resolved = await resolveDesktopWorkspaceTemplate(
    blueprint.document,
  ).catch((error: unknown) => {
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'blueprint_template_prep_failed',
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      selections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      unresolvedRefs: Array.from(
        new Set([
          ...blueprint.document.plugins.map((ref) =>
            getShareablePluginRefKey(ref),
          ),
          ...blueprint.document.customSkills.map(
            (skill) => `skill:${skill.clientKey}`,
          ),
        ]),
      ),
    };
  });
  return { blueprint, ...resolved };
}
