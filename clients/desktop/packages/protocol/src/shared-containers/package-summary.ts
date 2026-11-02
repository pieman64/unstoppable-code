import {
  groupCapabilityPackageProviderTwins,
  listCapabilityPackageExecutablePaths,
  type CapabilityPackageManifestV1,
} from '../pipelines/package';
import type { SharedContainerRevisionPackage } from './index';

/** Plugin members are carried in the package but a copy does not install them. */
function isInstalledResourceKind(
  kind: CapabilityPackageManifestV1['resources'][number]['kind'],
): boolean {
  switch (kind) {
    case 'plugin_skill':
    case 'plugin_command':
    case 'plugin_agent':
      return false;
    case 'automation_pipeline':
    case 'file_asset':
    case 'standalone_skill':
    case 'agent_definition':
    case 'pipeline_definition':
    case 'automation_definition':
    case 'hook_definition':
    case 'child_pipeline':
    case 'pipeline_action':
      return true;
  }
}

/**
 * Summarize what making a copy installs, from finalized resources only.
 * Plugin skills, commands and agents are carried but not installed on the
 * recipient's computer, so they are neither counted nor listed as runnable
 * scripts. Child pipelines and action helpers install inside their parent
 * pipeline's package, so they are dependencies rather than extra pipelines.
 * Provider twins count once. Executable paths are named by their readable
 * tree root, so a twin's copy of a script is listed once.
 */
export function summarizeSharedContainerCapabilityPackage(
  digest: string,
  manifest: CapabilityPackageManifestV1,
): SharedContainerRevisionPackage {
  const counts = {
    skills: 0,
    pipelines: 0,
    agents: 0,
    automations: 0,
    hooks: 0,
  };
  for (const group of groupCapabilityPackageProviderTwins(manifest.resources)) {
    const resource = group[0];
    if (!resource) continue;
    switch (resource.kind) {
      case 'standalone_skill':
        counts.skills += 1;
        break;
      case 'agent_definition':
        counts.agents += 1;
        break;
      case 'automation_pipeline':
      case 'pipeline_definition':
        counts.pipelines += 1;
        break;
      case 'automation_definition':
        counts.automations += 1;
        break;
      case 'hook_definition':
        counts.hooks += 1;
        break;
      case 'file_asset':
      case 'plugin_skill':
      case 'plugin_command':
      case 'plugin_agent':
      case 'child_pipeline':
      case 'pipeline_action':
        break;
    }
  }
  const executableFiles = new Set<string>();
  for (const resource of manifest.resources) {
    if (!isInstalledResourceKind(resource.kind)) continue;
    for (const tree of resource.trees) {
      for (const path of listCapabilityPackageExecutablePaths({
        trees: [tree],
      })) {
        executableFiles.add(`${tree.rootName}/${path}`);
      }
    }
  }
  return {
    digest,
    counts,
    executableFiles: Array.from(executableFiles).sort(),
  };
}
