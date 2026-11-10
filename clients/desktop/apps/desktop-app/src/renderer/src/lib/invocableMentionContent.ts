import type { InvocableInventoryEntry } from '@canopy/desktop-shared/types';
import type {
  PluginCommandInfo,
  PluginComponentContent,
  PluginInfo,
  PluginProviderFacet,
  PluginSkillInfo,
} from '@canopy/execution-engine/types/plugins';

export interface InvocableMentionContent {
  title: string;
  description: string;
  content: PluginComponentContent | null;
  error?: string;
}

const contentCache = new Map<string, Promise<InvocableMentionContent>>();

function findSkill(
  facet: PluginProviderFacet | undefined,
  name: string,
): PluginSkillInfo | null {
  return facet?.details?.skills.find((skill) => skill.name === name) ?? null;
}

function findCommand(
  facet: PluginProviderFacet | undefined,
  name: string,
): PluginCommandInfo | null {
  return (
    facet?.details?.commands.find((command) => command.name === name) ?? null
  );
}

function bestFacetForPluginSkill(
  entry: InvocableInventoryEntry,
  plugin: PluginInfo,
): {
  facet: PluginProviderFacet | undefined;
  skill: PluginSkillInfo | null;
} {
  if (entry.provider === 'codex') {
    const nativeSkill = findSkill(plugin.facets.codex, entry.name);
    if (nativeSkill) {
      return { facet: plugin.facets.codex, skill: nativeSkill };
    }

    const compatSkill = findSkill(plugin.facets.codexCompatibility, entry.name);
    if (compatSkill) {
      return { facet: plugin.facets.codexCompatibility, skill: compatSkill };
    }
  }

  return {
    facet: plugin.facets.claude,
    skill: findSkill(plugin.facets.claude, entry.name),
  };
}

function componentRoot(facet: PluginProviderFacet): {
  installLocation: string;
  pluginSourcePath: string;
} {
  const facetRoot = facet.cachePath || facet.installLocation;
  if (facetRoot) {
    return {
      installLocation: facetRoot,
      pluginSourcePath: '',
    };
  }

  return {
    installLocation: '',
    pluginSourcePath: facet.sourcePath || '',
  };
}

async function readPluginComponent(
  facet: PluginProviderFacet,
  componentFile: string,
): Promise<PluginComponentContent | null> {
  if (!window.plugins || !componentFile) return null;
  const root = componentRoot(facet);
  if (!root.installLocation) return null;
  const result = await window.plugins.readComponentContent(
    root.installLocation,
    root.pluginSourcePath,
    componentFile,
  );
  if (result.success && result.data) return result.data;
  throw new Error(result.error || 'Failed to load component content.');
}

async function loadStandaloneSkillContent(
  entry: InvocableInventoryEntry,
): Promise<InvocableMentionContent> {
  if (entry.enableRef.kind !== 'skill') {
    return {
      title: entry.displayName,
      description: entry.description,
      content: null,
    };
  }

  const result = await window.skills.readContent(
    entry.enableRef.sourceId,
    entry.enableRef.skillName,
  );
  if (!result.success || !result.data) {
    throw new Error(result.error || 'Failed to load skill content.');
  }
  return {
    title: entry.displayName,
    description: entry.description,
    content: result.data,
  };
}

async function loadPluginContent(
  entry: InvocableInventoryEntry,
): Promise<InvocableMentionContent> {
  if (entry.enableRef.kind !== 'plugin' || !window.plugins) {
    return {
      title: entry.displayName,
      description: entry.description,
      content: null,
    };
  }
  const pluginRef = entry.enableRef;

  const marketplaces = await window.plugins.loadMarketplaces();
  if (!marketplaces.success || !marketplaces.data) {
    throw new Error(marketplaces.error || 'Failed to load plugins.');
  }

  const marketplace = marketplaces.data.marketplaces.find(
    (item) => item.id === pluginRef.marketplaceId,
  );
  const plugin = marketplace?.plugins.find(
    (item) => item.name.toLowerCase() === pluginRef.pluginName.toLowerCase(),
  );
  if (!plugin) {
    throw new Error('Plugin is no longer installed.');
  }

  if (entry.kind === 'plugin_command') {
    const commandName = entry.sourceName ?? entry.name;
    const facet = plugin.facets.claude;
    const command = findCommand(facet, commandName);
    if (!facet || !command) {
      throw new Error('Plugin command is no longer available.');
    }
    const content = await readPluginComponent(facet, command.filePath);
    return {
      title: entry.displayName,
      description: entry.description || command.description,
      content,
    };
  }

  const { facet, skill } = bestFacetForPluginSkill(entry, plugin);
  if (!facet || !skill) {
    throw new Error('Plugin skill is no longer available.');
  }
  const content = await readPluginComponent(facet, `${skill.path}/SKILL.md`);
  return {
    title: entry.displayName,
    description: entry.description || skill.description,
    content,
  };
}

async function loadInvocableMentionContentUncached(
  entry: InvocableInventoryEntry,
): Promise<InvocableMentionContent> {
  try {
    if (entry.kind === 'skill') {
      return await loadStandaloneSkillContent(entry);
    }
    return await loadPluginContent(entry);
  } catch (error) {
    return {
      title: entry.displayName,
      description: entry.description,
      content: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function loadInvocableMentionContent(
  entry: InvocableInventoryEntry,
): Promise<InvocableMentionContent> {
  const cached = contentCache.get(entry.id);
  if (cached) return cached;
  const next = loadInvocableMentionContentUncached(entry);
  contentCache.set(entry.id, next);
  return next;
}
