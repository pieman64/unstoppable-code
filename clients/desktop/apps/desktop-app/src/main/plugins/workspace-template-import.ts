import {
  getShareablePluginRefKey,
  type PipelinePackageSummary,
  type ShareablePluginRef,
  type SharedWorkspaceTemplateDocument,
} from '@canopy/protocol';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import { addMarketplace, installPlugin } from './plugin-service';
import {
  loadShareablePluginCatalog,
  resolveShareablePluginRefs,
  type ShareablePluginCatalog,
} from './shareable-plugin-resolution';
import { installSkills, writeRawSkill } from '../skills/skill-service';
import { CUSTOM_SOURCE_ID } from '../skills/paths';
import { installSubjectCapabilityPackage } from '../skills/skill-package-install';
import {
  getPublicBlueprintPackage,
  getPublicBlueprintPackageBlob,
} from '../canopy-cloud/workspace-template-client';
import {
  getMcpServerStatusByCatalogId,
  getMcpServerStatusByName,
} from '../mcp/connection-status';
import type { PipelinePackageEnvironmentRequirement } from '@canopy/protocol/pipelines';
import type { McpServerStatusEntry } from '@canopy/execution-engine/types/mcp-servers';

export interface WorkspaceTemplateImportDependencies {
  prepareRefs(refs: readonly ShareablePluginRef[]): Promise<void>;
  loadCatalog(): Promise<ShareablePluginCatalog>;
  writeCustomSkill(input: { skillName: string; rawSkill: string }): {
    skillName: string;
  };
}

export interface ResolvedDesktopWorkspaceTemplate {
  selections: ChatTabPluginSelections;
  unresolvedRefs: string[];
}

export async function installDesktopWorkspaceTemplateCapabilityPackages(
  input: {
    projectId: string;
    externalId: string;
    contentHash: string;
    package?: PipelinePackageSummary;
    skillPackages?: Array<{
      clientKey: string;
      package: PipelinePackageSummary;
    }>;
  },
  dependencies: {
    getPackage: typeof getPublicBlueprintPackage;
    getBlob: typeof getPublicBlueprintPackageBlob;
    installPackage: typeof installSubjectCapabilityPackage;
    getMcpByCatalogId(catalogId: string): Promise<McpServerStatusEntry | null>;
    getMcpByName(name: string): Promise<McpServerStatusEntry | null>;
  } = {
    getPackage: getPublicBlueprintPackage,
    getBlob: getPublicBlueprintPackageBlob,
    installPackage: installSubjectCapabilityPackage,
    getMcpByCatalogId: getMcpServerStatusByCatalogId,
    getMcpByName: getMcpServerStatusByName,
  },
): Promise<{
  skillRefs: Array<{ sourceId: string; skillName: string }>;
  mcpServerRefs: Array<{ serverId: string; configId: string }>;
  unmetRequirements: PipelinePackageEnvironmentRequirement[];
}> {
  const packages = [
    ...(input.package ? [{ package: input.package }] : []),
    ...(input.skillPackages ?? []),
  ];
  const installed = new Map<string, { sourceId: string; skillName: string }>();
  const mcpServerRefs = new Map<
    string,
    { serverId: string; configId: string }
  >();
  const unmetRequirements = new Map<
    string,
    PipelinePackageEnvironmentRequirement
  >();
  for (const item of packages) {
    const clientKey = 'clientKey' in item ? item.clientKey : undefined;
    const download = await dependencies.getPackage(
      input.externalId,
      item.package.digest,
      clientKey,
    );
    const result = await dependencies.installPackage({
      owner: { kind: 'blueprint', localId: input.projectId },
      originExternalId: input.externalId,
      packageRef: {
        version: item.package.version,
        digest: item.package.digest,
      },
      download,
      fetchBlob: (sha256) =>
        dependencies.getBlob(
          input.externalId,
          item.package.digest,
          sha256,
          clientKey,
        ),
      localContentHash: input.contentHash,
    });
    for (const skill of result.installedSkills) {
      installed.set(skill.localName, {
        sourceId: CUSTOM_SOURCE_ID,
        skillName: skill.localName,
      });
    }
    for (const requirement of download.manifest.environmentRequirements) {
      if (requirement.kind !== 'mcp') continue;
      const status =
        (await dependencies.getMcpByCatalogId(requirement.displayName)) ??
        (await dependencies.getMcpByName(requirement.displayName));
      const config = status?.configs[0];
      if (!status || !config) {
        unmetRequirements.set(requirement.id, requirement);
        continue;
      }
      mcpServerRefs.set(`${status.serverId}/${config.configId}`, {
        serverId: status.serverId,
        configId: config.configId,
      });
    }
  }
  return {
    skillRefs: Array.from(installed.values()),
    mcpServerRefs: Array.from(mcpServerRefs.values()),
    unmetRequirements: Array.from(unmetRequirements.values()),
  };
}

export async function resolveDesktopWorkspaceTemplate(
  document: SharedWorkspaceTemplateDocument,
  dependencies: WorkspaceTemplateImportDependencies = defaultWorkspaceTemplateImportDependencies,
): Promise<ResolvedDesktopWorkspaceTemplate> {
  const refs = new Map(
    document.plugins.map((ref) => [getShareablePluginRefKey(ref), ref]),
  );
  const uniqueRefs = Array.from(refs.values());
  await dependencies.prepareRefs(uniqueRefs);
  const matches = resolveShareablePluginRefs(
    uniqueRefs,
    await dependencies.loadCatalog(),
  );
  const skillRefs = new Map<string, { sourceId: string; skillName: string }>();
  const pluginRefs = new Map<
    string,
    { marketplaceId: string; pluginName: string }
  >();
  const unresolvedRefs: string[] = [];
  for (const match of matches) {
    if (match.matchState === 'unmatched') {
      unresolvedRefs.push(getShareablePluginRefKey(match.ref));
    } else if (match.selection.kind === 'skill') {
      skillRefs.set(match.catalogKey, {
        sourceId: match.selection.sourceId,
        skillName: match.selection.skillName,
      });
    } else {
      pluginRefs.set(match.catalogKey, {
        marketplaceId: match.selection.marketplaceId,
        pluginName: match.selection.pluginName,
      });
    }
  }
  const customSkills = new Map<string, string>();
  for (const customSkill of document.customSkills) {
    if (customSkills.has(customSkill.clientKey)) continue;
    const written = dependencies.writeCustomSkill({
      skillName: customSkill.name,
      rawSkill: customSkill.rawSkill,
    });
    customSkills.set(customSkill.clientKey, written.skillName);
    skillRefs.set(`${CUSTOM_SOURCE_ID}/${written.skillName}`, {
      sourceId: CUSTOM_SOURCE_ID,
      skillName: written.skillName,
    });
  }
  return {
    selections: {
      collectionIds: [],
      skillRefs: Array.from(skillRefs.values()),
      pluginRefs: Array.from(pluginRefs.values()),
      mcpServerRefs: [...(document.mcpServerRefs ?? [])],
    },
    unresolvedRefs,
  };
}

interface WorkspaceTemplateRefPreparationDependencies {
  addMarketplace: typeof addMarketplace;
  installPlugin: typeof installPlugin;
  installSkills: typeof installSkills;
}

export async function prepareDesktopWorkspaceTemplateRefs(
  refs: readonly ShareablePluginRef[],
  dependencies: WorkspaceTemplateRefPreparationDependencies = {
    addMarketplace,
    installPlugin,
    installSkills,
  },
): Promise<void> {
  const repositories = new Map<
    string,
    { repo: string; refs: ShareablePluginRef[] }
  >();
  for (const ref of refs) {
    const source = ref.type === 'skill' ? ref.source : ref.marketplace;
    if (source.type !== 'github') continue;
    const key = source.repo.trim().toLowerCase();
    const group = repositories.get(key) ?? { repo: source.repo, refs: [] };
    group.refs.push(ref);
    repositories.set(key, group);
  }

  for (const { repo, refs: repositoryRefs } of Array.from(
    repositories.values(),
  )) {
    const requestedSkills = Array.from(
      new Set(
        repositoryRefs.flatMap((ref) =>
          ref.type === 'skill' ? [ref.skill_name] : [],
        ),
      ),
    );
    if (requestedSkills.length > 0) {
      const installed = await dependencies.installSkills(repo, requestedSkills);
      if (!installed.success) {
        throw new Error(
          installed.error || `Failed to install skills from ${repo}.`,
        );
      }
    }
    const added = await dependencies.addMarketplace(repo);
    if (!added.success || !added.data) continue;
    const requestedPlugins = new Set(
      repositoryRefs.flatMap((ref) =>
        ref.type === 'plugin' || ref.type === 'claude_plugin'
          ? [ref.plugin_name.trim().toLowerCase()]
          : [],
      ),
    );
    for (const plugin of added.data.marketplace.plugins) {
      if (!requestedPlugins.has(plugin.name.trim().toLowerCase())) continue;
      await dependencies.installPlugin(
        added.data.marketplace.id,
        plugin.name,
        added.data.marketplace.sourceUrl,
      );
    }
  }
}

const defaultWorkspaceTemplateImportDependencies: WorkspaceTemplateImportDependencies =
  {
    prepareRefs: prepareDesktopWorkspaceTemplateRefs,
    loadCatalog: loadShareablePluginCatalog,
    writeCustomSkill: writeRawSkill,
  };
