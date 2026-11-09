import {
  getShareablePluginRefKey,
  MAX_WORKSPACE_TEMPLATE_MCP_SERVER_REFS,
  WORKSPACE_TEMPLATE_SHARE_LABEL_LOWER,
  type ShareablePluginRef,
  type SharedWorkspaceTemplateCustomSkill,
  type SharedWorkspaceTemplateDocument,
  type WorkspaceTemplateMcpServerRef,
} from '@canopy/protocol';
import type { AccountMcpConnection } from '@canopy/execution-engine/types/mcp-servers';
import { accountMcpConnectionForRef } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { loadAccountMcpRefConnections } from '../mcp/account-catalog';
import type { PipelinePackageEnvironmentRequirement } from '@canopy/protocol/pipelines';
import type {
  ChatProjectData,
  ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import type { CollectionConfig } from '@canopy/desktop-shared/types/collections';
import { readCollectionConfig } from '../collections/collection-store';
import { readRawSkill } from '../skills/skill-service';
import { CUSTOM_SOURCE_ID } from '../skills/paths';
import {
  loadShareablePluginCatalog,
  portablePluginRef,
  portableSkillRef,
  type ShareablePluginCatalog,
} from './shareable-plugin-resolution';
import { mcpSelectionToPortableIdentity } from '../mcp/share-requirement';
import { isStartPageFeatureEnabled } from '../lib/start-page-feature-flag';

export interface WorkspaceTemplateAuthoringDependencies {
  loadCatalog(): Promise<ShareablePluginCatalog>;
  loadCollection(id: string): Promise<CollectionConfig | null>;
  readRawSkill(id: string): Promise<string>;
  loadAccountConnections(): Promise<AccountMcpConnection[] | null>;
}

export interface BuiltDesktopWorkspaceTemplateDocument {
  document: SharedWorkspaceTemplateDocument;
  omitted: { mcpServers: boolean; unresolvedRefs: string[] };
}

export interface PortablePluginSelections {
  refs: ShareablePluginRef[];
  mcpServers: Array<{ name: string; catalogId?: string }>;
  unresolved: string[];
}

export function workspaceTemplateModelRequirements(
  defaultModel: string | undefined,
): PipelinePackageEnvironmentRequirement[] {
  const model = defaultModel?.trim();
  if (!model) return [];
  return [
    {
      id: `model:${model}`,
      kind: 'model',
      displayName: model,
      required: true,
      affectedSteps: [],
      setupHint: `Configure access to ${model} before using this ${WORKSPACE_TEMPLATE_SHARE_LABEL_LOWER}.`,
    },
  ];
}

export async function mapPluginSelectionsToPortable(
  selections: ChatTabPluginSelections,
  dependencies: Pick<
    WorkspaceTemplateAuthoringDependencies,
    'loadCatalog' | 'loadCollection'
  > = defaultDependencies,
): Promise<PortablePluginSelections> {
  const collections = await Promise.all(
    selections.collectionIds.map(async (id) => ({
      id,
      collection: await dependencies.loadCollection(id),
    })),
  );
  const skills = new Map(
    selections.skillRefs.map((ref) => [
      `${ref.sourceId}/${ref.skillName}`,
      ref,
    ]),
  );
  const plugins = new Map(
    selections.pluginRefs.map((ref) => [
      `${ref.marketplaceId}/${ref.pluginName}`,
      ref,
    ]),
  );
  const mcpServers = new Map<string, { name: string; catalogId?: string }>();
  for (const ref of selections.mcpServerRefs ?? []) {
    mcpServers.set(ref.serverId, await mcpSelectionToPortableIdentity(ref));
  }
  const unresolved = new Set<string>();
  for (const { id, collection } of collections) {
    if (!collection) {
      unresolved.add(`collection:${id}`);
      continue;
    }
    for (const ref of collection.skills) {
      skills.set(`${ref.sourceId}/${ref.skillName}`, ref);
    }
    for (const ref of collection.plugins) {
      plugins.set(`${ref.marketplaceId}/${ref.pluginName}`, ref);
    }
    for (const ref of collection.mcpServers) {
      mcpServers.set(ref.serverId, await mcpSelectionToPortableIdentity(ref));
    }
  }
  const catalog = await dependencies.loadCatalog();
  const refs = new Map<string, ShareablePluginRef>();
  for (const ref of Array.from(skills.values())) {
    const portable = portableSkillRef(ref, catalog);
    if (!portable) {
      unresolved.add(`skill:${ref.sourceId}/${ref.skillName}`);
      continue;
    }
    refs.set(getShareablePluginRefKey(portable), portable);
  }
  for (const ref of Array.from(plugins.values())) {
    const portable = portablePluginRef(ref, catalog);
    if (!portable) {
      unresolved.add(`plugin:${ref.marketplaceId}/${ref.pluginName}`);
      continue;
    }
    refs.set(getShareablePluginRefKey(portable), portable);
  }
  return {
    refs: Array.from(refs.values()),
    mcpServers: Array.from(mcpServers.values()),
    unresolved: Array.from(unresolved),
  };
}

export async function buildDesktopWorkspaceTemplateDocument(
  project: ChatProjectData,
  instructions: string,
  dependencies: WorkspaceTemplateAuthoringDependencies = defaultDependencies,
): Promise<BuiltDesktopWorkspaceTemplateDocument> {
  const selections = project.defaultPluginSelections ?? {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
  };
  const collections = await Promise.all(
    selections.collectionIds.map(async (id) => ({
      id,
      collection: await dependencies.loadCollection(id),
    })),
  );
  const skillSelections = new Map(
    selections.skillRefs.map((ref) => [
      `${ref.sourceId}/${ref.skillName}`,
      ref,
    ]),
  );
  const pluginSelections = new Map(
    selections.pluginRefs.map((ref) => [
      `${ref.marketplaceId}/${ref.pluginName}`,
      ref,
    ]),
  );
  const unresolved = new Set<string>();
  const selectedMcpServers = [...(selections.mcpServerRefs ?? [])];
  for (const { id, collection } of collections) {
    if (!collection) {
      unresolved.add(`collection:${id}`);
      continue;
    }
    for (const ref of collection.skills) {
      skillSelections.set(`${ref.sourceId}/${ref.skillName}`, ref);
    }
    for (const ref of collection.plugins) {
      pluginSelections.set(`${ref.marketplaceId}/${ref.pluginName}`, ref);
    }
    selectedMcpServers.push(...collection.mcpServers);
  }
  // Account servers travel by server key; device servers stay on the device.
  const accountConnections =
    selectedMcpServers.length > 0
      ? ((await dependencies.loadAccountConnections()) ?? [])
      : [];
  const mcpServerRefs = new Map<string, WorkspaceTemplateMcpServerRef>();
  let deviceMcpServers = false;
  for (const ref of selectedMcpServers) {
    const connection = accountMcpConnectionForRef(ref, accountConnections);
    if (
      !connection ||
      (!mcpServerRefs.has(connection.id) &&
        mcpServerRefs.size >= MAX_WORKSPACE_TEMPLATE_MCP_SERVER_REFS)
    ) {
      deviceMcpServers = true;
      continue;
    }
    mcpServerRefs.set(connection.id, {
      serverId: connection.serverKey,
      configId: connection.configId,
    });
  }

  const catalog = await dependencies.loadCatalog();
  const plugins = new Map<string, ShareablePluginRef>();
  const customSkills = new Map<string, SharedWorkspaceTemplateCustomSkill>();
  for (const ref of Array.from(skillSelections.values())) {
    const localKey = `${ref.sourceId}/${ref.skillName}`;
    if (ref.sourceId === CUSTOM_SOURCE_ID) {
      try {
        customSkills.set(localKey, {
          clientKey: localKey,
          name: ref.skillName,
          rawSkill: await dependencies.readRawSkill(localKey),
        });
      } catch {
        unresolved.add(`skill:${localKey}`);
      }
      continue;
    }
    const portable = portableSkillRef(ref, catalog);
    if (!portable) {
      unresolved.add(`skill:${localKey}`);
      continue;
    }
    plugins.set(getShareablePluginRefKey(portable), portable);
  }

  for (const ref of Array.from(pluginSelections.values())) {
    const portable = portablePluginRef(ref, catalog);
    if (!portable || portable.type === 'codex_plugin') {
      unresolved.add(`plugin:${ref.marketplaceId}/${ref.pluginName}`);
      continue;
    }
    plugins.set(getShareablePluginRefKey(portable), portable);
  }

  return {
    document: {
      version: 2,
      name: project.name,
      description: project.description ?? '',
      ...(project.color === undefined ? {} : { color: project.color }),
      instructions,
      plugins: Array.from(plugins.values()),
      customSkills: Array.from(customSkills.values()),
      starterPrompts: [],
      ...(!isStartPageFeatureEnabled() || project.startPage === undefined
        ? {}
        : { startPage: project.startPage }),
      ...(mcpServerRefs.size > 0
        ? { mcpServerRefs: Array.from(mcpServerRefs.values()) }
        : {}),
    },
    omitted: {
      mcpServers: deviceMcpServers,
      unresolvedRefs: Array.from(unresolved),
    },
  };
}

const defaultDependencies: WorkspaceTemplateAuthoringDependencies = {
  loadCatalog: loadShareablePluginCatalog,
  async loadCollection(id) {
    return (await readCollectionConfig(id))?.collection ?? null;
  },
  readRawSkill,
  loadAccountConnections: () => loadAccountMcpRefConnections(),
};
