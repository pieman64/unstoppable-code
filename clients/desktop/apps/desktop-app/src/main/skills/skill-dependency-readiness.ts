import type { PipelinePackageReadiness } from '@canopy/desktop-shared/types/pipeline';
import type {
  SkillDependencyReadinessRequest,
  SkillDependencyRef,
} from '@canopy/desktop-shared/types/skills';
import {
  skillDependenciesToEnvironmentRequirements,
  type SkillDependency,
} from '@canopy/protocol/skills';
import { getMcpServerStatusByName } from '../mcp/connection-status';
import { loadCachedInventory } from '../plugins/invocable-inventory-service';
import {
  evaluatePipelinePackageRequirements,
  mcpRequirementAvailability,
  UNKNOWN_REQUIREMENT,
  type RequirementAvailability,
} from '../pipelines/pipeline-package-service';

/**
 * Local readiness of what a shared skill says it needs, for the recipient's
 * landing before they install it.
 *
 * A skill's requirements are the MCP servers and plugins its instructions
 * name, so they are probed as exactly that: an MCP server by the name the
 * skill uses, a plugin against the installed plugins. The pipeline probe is
 * not reused for plugins because it maps `runtime` to an executable on PATH,
 * which would call every plugin missing. Nothing is marked required, so an
 * unmet requirement warns and never makes the skill read as unusable.
 */

const MAX_DEPENDENCIES = 50;
const MAX_NAME_LENGTH = 200;

function isDependencyKind(value: unknown): value is SkillDependencyRef['kind'] {
  return value === 'mcp' || value === 'plugin';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate the renderer's request. Malformed entries are dropped rather than
 * failing the whole check, because the list comes from a share's content and
 * one odd name should not hide the others.
 */
export function normalizeSkillDependencyReadinessRequest(
  value: unknown,
): SkillDependencyReadinessRequest {
  if (
    !isRecord(value) ||
    !Array.isArray(value.dependencies) ||
    value.dependencies.length > MAX_DEPENDENCIES
  ) {
    throw new Error('Invalid skill dependency readiness request');
  }
  const dependencies = value.dependencies.flatMap(
    (entry): SkillDependencyRef[] => {
      if (!isRecord(entry) || !isDependencyKind(entry.kind)) return [];
      if (typeof entry.name !== 'string') return [];
      const name = entry.name.trim();
      if (name.length === 0 || name.length > MAX_NAME_LENGTH) return [];
      return [{ kind: entry.kind, name }];
    },
  );
  return { dependencies };
}

async function installedPluginNames(): Promise<Set<string> | null> {
  const inventory = await loadCachedInventory();
  if (!inventory) return null;
  return new Set(
    inventory.entries.flatMap((entry) =>
      entry.enableRef.kind === 'plugin'
        ? [entry.enableRef.pluginName.toLowerCase()]
        : [],
    ),
  );
}

export async function getSkillDependencyReadiness(
  request: SkillDependencyReadinessRequest,
): Promise<PipelinePackageReadiness> {
  const dependencies: SkillDependency[] = request.dependencies;
  const requirements = skillDependenciesToEnvironmentRequirements(dependencies);
  const plugins = requirements.some(
    (requirement) => requirement.kind === 'runtime',
  )
    ? await installedPluginNames().catch(() => null)
    : null;
  return evaluatePipelinePackageRequirements(
    requirements,
    async (requirement): Promise<RequirementAvailability> => {
      if (requirement.kind === 'mcp') {
        try {
          return mcpRequirementAvailability(
            await getMcpServerStatusByName(requirement.displayName),
          );
        } catch {
          return UNKNOWN_REQUIREMENT;
        }
      }
      // The only other kind a skill dependency produces is a plugin.
      if (!plugins) return UNKNOWN_REQUIREMENT;
      return plugins.has(requirement.displayName.toLowerCase())
        ? { status: 'available', detail: 'Plugin is installed.' }
        : { status: 'missing', detail: 'Plugin is not installed.' };
    },
  );
}
