import { filterStoredSkillContexts } from '../skills/skill-install-context';
import * as fs from 'node:fs';
import {
  buildShareablePluginDisplay,
  getShareablePluginRefKey,
  normalizeGitHubRepoRef,
  normalizeShareableSource,
  type ShareablePluginRef,
  type ShareablePluginSource,
} from '@canopy/desktop-shared/plugin-refs';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import type { AgentProviderType } from '@canopy/desktop-shared/types';
import {
  BUILTIN_PLUGIN_MARKETPLACE_ID,
  type MarketplaceInfo,
} from '@canopy/desktop-shared/types/plugins';
import { loadSkills } from '../skills/skill-service';
import { loadMarketplaces } from './plugin-service';
import { parseGitHubSource } from '../skills/source-parser';

export interface ShareablePluginCatalog {
  skills: InstalledSkillInfo[];
  marketplaces: MarketplaceInfo[];
}

export type ShareablePluginMatch =
  | {
      matchState: 'matched';
      ref: ShareablePluginRef;
      catalogKey: string;
      selection:
        | { kind: 'skill'; sourceId: string; skillName: string }
        | { kind: 'plugin'; marketplaceId: string; pluginName: string };
    }
  | {
      matchState: 'unmatched';
      ref: ShareablePluginRef;
      displayName: string;
      displaySource: string;
    };

export interface ShareablePluginResolutionOptions {
  providerType?: AgentProviderType;
}

export async function loadShareablePluginCatalog(): Promise<ShareablePluginCatalog> {
  const skillsResult = loadSkills();
  if (skillsResult.success && skillsResult.data)
    skillsResult.data = await filterStoredSkillContexts(skillsResult.data);
  return loadMarketplaces().then((marketplacesResult) => ({
    skills: skillsResult.success && skillsResult.data ? skillsResult.data : [],
    marketplaces:
      marketplacesResult.success && marketplacesResult.data
        ? marketplacesResult.data.marketplaces
        : [],
  }));
}

function normalizeGitHubRepoFromUrl(sourceUrl: string): string | undefined {
  const parsed = parseGitHubSource(sourceUrl);
  if (!parsed) {
    return undefined;
  }

  try {
    return normalizeGitHubRepoRef(`${parsed.owner}/${parsed.repo}`);
  } catch {
    return undefined;
  }
}

function sourceKeysEqual(
  left: ShareablePluginSource | undefined,
  right: ShareablePluginSource,
): boolean {
  if (!left) {
    return false;
  }

  try {
    return (
      JSON.stringify(normalizeShareableSource(left)) ===
      JSON.stringify(normalizeShareableSource(right))
    );
  } catch {
    return false;
  }
}

function matchSkillRef(
  ref: Extract<ShareablePluginRef, { type: 'skill' }>,
  catalog: ShareablePluginCatalog,
): ShareablePluginMatch {
  const normalizedName = ref.skill_name.trim().toLowerCase();
  for (const skill of catalog.skills) {
    if (skill.name.trim().toLowerCase() !== normalizedName) {
      continue;
    }
    if (!sourceKeysEqual(skill.shareableSource, ref.source)) {
      continue;
    }

    return {
      matchState: 'matched',
      ref,
      catalogKey: `${skill.sourceId}/${skill.name}`,
      selection: {
        kind: 'skill',
        sourceId: skill.sourceId,
        skillName: skill.name,
      },
    };
  }

  const display = buildShareablePluginDisplay(ref);
  return {
    matchState: 'unmatched',
    ref,
    displayName: display.title,
    displaySource: display.subtitle,
  };
}

function hasNativeCodexFacet(plugin: {
  facets?: MarketplaceInfo['plugins'][number]['facets'];
}): boolean {
  return (
    plugin.facets?.codex?.provider === 'codex' &&
    plugin.facets.codex.mode === 'native'
  );
}

function matchClaudePluginRef(
  ref: Extract<ShareablePluginRef, { type: 'claude_plugin' }>,
  catalog: ShareablePluginCatalog,
): ShareablePluginMatch {
  if (ref.marketplace.type === 'builtin') {
    const normalizedPluginName = ref.plugin_name.trim().toLowerCase();
    for (const marketplace of catalog.marketplaces) {
      if (
        marketplace.id !== BUILTIN_PLUGIN_MARKETPLACE_ID &&
        marketplace.builtIn !== true
      ) {
        continue;
      }
      const plugin = marketplace.plugins.find(
        (entry) => entry.name.trim().toLowerCase() === normalizedPluginName,
      );
      if (!plugin) {
        continue;
      }
      return {
        matchState: 'matched',
        ref,
        catalogKey: `${BUILTIN_PLUGIN_MARKETPLACE_ID}/${plugin.name}`,
        selection: {
          kind: 'plugin',
          marketplaceId: BUILTIN_PLUGIN_MARKETPLACE_ID,
          pluginName: plugin.name,
        },
      };
    }
    const display = buildShareablePluginDisplay(ref);
    return {
      matchState: 'unmatched',
      ref,
      displayName: display.title,
      displaySource: display.subtitle,
    };
  }

  let repo: string;
  try {
    repo = normalizeGitHubRepoRef(ref.marketplace.repo);
  } catch {
    const display = buildShareablePluginDisplay(ref);
    return {
      matchState: 'unmatched',
      ref,
      displayName: display.title,
      displaySource: display.subtitle,
    };
  }

  const normalizedPluginName = ref.plugin_name.trim().toLowerCase();
  for (const marketplace of catalog.marketplaces) {
    const marketplaceRepo = normalizeGitHubRepoFromUrl(marketplace.sourceUrl);
    if (marketplaceRepo !== repo) {
      continue;
    }
    const plugin = marketplace.plugins.find(
      (entry) => entry.name.trim().toLowerCase() === normalizedPluginName,
    );
    if (!plugin) {
      continue;
    }
    if (
      plugin.externalSource &&
      (!plugin.cachePath || !fs.existsSync(plugin.cachePath)) &&
      !hasNativeCodexFacet(plugin)
    ) {
      continue;
    }

    return {
      matchState: 'matched',
      ref,
      catalogKey: `${marketplace.id}/${plugin.name}`,
      selection: {
        kind: 'plugin',
        marketplaceId: marketplace.id,
        pluginName: plugin.name,
      },
    };
  }

  const display = buildShareablePluginDisplay(ref);
  return {
    matchState: 'unmatched',
    ref,
    displayName: display.title,
    displaySource: display.subtitle,
  };
}

function matchCodexPluginRef(
  ref: Extract<ShareablePluginRef, { type: 'codex_plugin' }>,
  catalog: ShareablePluginCatalog,
): ShareablePluginMatch {
  const normalizedMarketplaceId = ref.marketplace.id.trim().toLowerCase();
  const normalizedPluginName = ref.plugin_name.trim().toLowerCase();
  for (const marketplace of catalog.marketplaces) {
    if (marketplace.id.trim().toLowerCase() !== normalizedMarketplaceId) {
      continue;
    }
    const plugin = marketplace.plugins.find(
      (entry) => entry.name.trim().toLowerCase() === normalizedPluginName,
    );
    if (!plugin) {
      continue;
    }
    return {
      matchState: 'matched',
      ref,
      catalogKey: `${marketplace.id}/${plugin.name}`,
      selection: {
        kind: 'plugin',
        marketplaceId: marketplace.id,
        pluginName: plugin.name,
      },
    };
  }

  const display = buildShareablePluginDisplay(ref);
  return {
    matchState: 'unmatched',
    ref,
    displayName: display.title,
    displaySource: display.subtitle,
  };
}

function findMarketplaceForDynamicPluginRef(
  ref: Extract<ShareablePluginRef, { type: 'plugin' }>,
  catalog: ShareablePluginCatalog,
): MarketplaceInfo | undefined {
  if (ref.marketplace.type === 'builtin') {
    return catalog.marketplaces.find(
      (marketplace) =>
        marketplace.id === BUILTIN_PLUGIN_MARKETPLACE_ID ||
        marketplace.builtIn === true,
    );
  }

  let repo: string;
  try {
    repo = normalizeGitHubRepoRef(ref.marketplace.repo);
  } catch {
    return undefined;
  }

  return catalog.marketplaces.find(
    (marketplace) => normalizeGitHubRepoFromUrl(marketplace.sourceUrl) === repo,
  );
}

function matchDynamicPluginRefAsCodex(
  ref: Extract<ShareablePluginRef, { type: 'plugin' }>,
  catalog: ShareablePluginCatalog,
): ShareablePluginMatch {
  const marketplace = findMarketplaceForDynamicPluginRef(ref, catalog);
  const normalizedPluginName = ref.plugin_name.trim().toLowerCase();
  const plugin = marketplace?.plugins.find(
    (entry) => entry.name.trim().toLowerCase() === normalizedPluginName,
  );

  if (!marketplace || !plugin?.facets.codex) {
    const display = buildShareablePluginDisplay(ref);
    return {
      matchState: 'unmatched',
      ref,
      displayName: display.title,
      displaySource: display.subtitle,
    };
  }

  return {
    matchState: 'matched',
    ref,
    catalogKey: `${marketplace.id}/${plugin.name}`,
    selection: {
      kind: 'plugin',
      marketplaceId: marketplace.id,
      pluginName: plugin.name,
    },
  };
}

function toClaudePluginRef(
  ref: Extract<ShareablePluginRef, { type: 'plugin' }>,
): Extract<ShareablePluginRef, { type: 'claude_plugin' }> {
  return {
    type: 'claude_plugin',
    marketplace: ref.marketplace,
    plugin_name: ref.plugin_name,
  };
}

export function matchShareablePluginRef(
  ref: ShareablePluginRef,
  catalog: ShareablePluginCatalog,
  options?: ShareablePluginResolutionOptions,
): ShareablePluginMatch {
  if (ref.type === 'skill') {
    return matchSkillRef(ref, catalog);
  }
  if (ref.type === 'plugin') {
    if (options?.providerType === 'codex') {
      const codexMatch = matchDynamicPluginRefAsCodex(ref, catalog);
      if (codexMatch.matchState === 'matched') {
        return codexMatch;
      }
    }
    const claudeMatch = matchClaudePluginRef(toClaudePluginRef(ref), catalog);
    return claudeMatch.matchState === 'matched'
      ? { ...claudeMatch, ref }
      : {
          ...claudeMatch,
          ref,
          displayName: buildShareablePluginDisplay(ref).title,
          displaySource: buildShareablePluginDisplay(ref).subtitle,
        };
  }
  if (ref.type === 'codex_plugin') {
    return matchCodexPluginRef(ref, catalog);
  }
  return matchClaudePluginRef(ref, catalog);
}

export function resolveShareablePluginRefs(
  refs: readonly ShareablePluginRef[],
  catalog: ShareablePluginCatalog,
  options?: ShareablePluginResolutionOptions,
): ShareablePluginMatch[] {
  const seen = new Set<string>();
  const result: ShareablePluginMatch[] = [];
  for (const ref of refs) {
    let key: string;
    try {
      key = getShareablePluginRefKey(ref);
    } catch {
      continue;
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(matchShareablePluginRef(ref, catalog, options));
  }
  return result;
}
