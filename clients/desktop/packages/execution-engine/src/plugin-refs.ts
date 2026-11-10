import { parseShareableGitHubSource } from '@canopy/plugin-interop/github-repo';
// ---------------------------------------------------------------------------
// Shared portable plugin-ref helpers.
//
// This module re-exports the portable ref contracts from `@canopy/protocol`
// (the single source of truth for wire shapes) and adds desktop/web-friendly
// display helpers used by:
//   - pipeline `plugin_collections` defaults (shareable YAML)
//   - `canopy.json` chat hook action `plugins` arrays
//   - top-level `canopy.json.plugins` source-controlled plugin recommendations
//
// Collection refs themselves are intentionally NOT represented here. Any
// local override UI that needs Collections uses `ChatTabPluginSelections`
// separately, and shared Collections use their own document contract. The
// top-level `canopy.json.plugins` surface still accepts only
// `ShareablePluginRef` shapes — Collections, MCP servers, local-only skills,
// and local-only plugin marketplaces must be filtered out before write.
// ---------------------------------------------------------------------------

import { BRAND } from '@canopy/brand/current';
import type { MarketplaceInfo, PluginInfo } from './types/plugins';
import {
  getShareablePluginRefKey,
  isShareablePluginRef,
  isValidGitHubRepoRef,
  normalizeGitHubRepoRef,
  normalizePluginName,
  normalizeShareablePluginRef,
  normalizeShareableSource,
  normalizeSkillName,
  serializeCodexPluginSource,
  serializeShareableSource,
  type ShareablePluginRef,
} from '@canopy/protocol/plugins';

export {
  getShareablePluginRefKey,
  isShareablePluginRef,
  isValidGitHubRepoRef,
  normalizeGitHubRepoRef,
  normalizePluginName,
  normalizeShareablePluginRef,
  normalizeShareableSource,
  normalizeSkillName,
  serializeCodexPluginSource,
  serializeShareableSource,
};

export type {
  ShareableBuiltinSource,
  ShareableClaudePluginRef,
  ShareableCodexBuiltinMarketplaceSource,
  ShareableCodexPluginRef,
  ShareableCodexPluginSource,
  ShareableDynamicPluginRef,
  ShareableGitHubSource,
  ShareablePluginRef,
  ShareablePluginSource,
  ShareableSkillRef,
} from '@canopy/protocol/plugins';

// ---------------------------------------------------------------------------
// Display helpers (desktop/web specific UI labels).
// ---------------------------------------------------------------------------

/**
 * Return user-facing display strings for a `ShareablePluginRef`.
 *
 * - `title` is the primary label (skill or plugin name), case preserved.
 * - `subtitle` is a short source description (built-in label or owner/repo).
 *
 * These strings are used by both the pipeline preview rows and the hook
 * selector pills so users see a consistent label no matter which surface
 * renders the ref.
 */
/**
 * The public source a share dialog names for a reference: the serialized
 * marketplace/skill source (e.g. `github:owner/repo`, the built-in id), which
 * is exactly what the published reference pins.
 */
export function shareablePluginSourceLabel(ref: ShareablePluginRef): string {
  const source = ref.type === 'skill' ? ref.source : ref.marketplace;
  return source.type === 'codex-builtin'
    ? serializeCodexPluginSource(source)
    : serializeShareableSource(source);
}

export function buildShareablePluginDisplay(ref: ShareablePluginRef): {
  title: string;
  subtitle: string;
} {
  if (ref.type === 'skill') {
    const title = (ref.skill_name ?? '').trim();
    const subtitle =
      ref.source.type === 'builtin'
        ? `Built-in (${BRAND.displayName})`
        : normalizeGitHubRepoRef(ref.source.repo);
    return { title, subtitle };
  }

  if (ref.type === 'codex_plugin') {
    const title = (ref.plugin_name ?? '').trim();
    const subtitle = `Codex built-in (${ref.marketplace.id.trim()})`;
    return { title, subtitle };
  }

  const title = (ref.plugin_name ?? '').trim();
  const subtitle =
    ref.marketplace.type === 'builtin'
      ? `Built-in (${BRAND.displayName})`
      : normalizeGitHubRepoRef(ref.marketplace.repo);
  return { title, subtitle };
}

/**
 * Which public source a marketplace plugin can be shared under, or `undefined`
 * when it cannot be shared. Shared by the desktop renderer (the Marketplace's
 * share affordances) and the desktop main process (the portal's
 * `portal.plugins.share_plugin` command and the per-row `shareable` flag), so
 * the web portal shows exactly the Share buttons the desktop shows.
 */
export { parseShareableGitHubSource };

export function computePluginShareableRef(
  plugin: PluginInfo,
  marketplace: MarketplaceInfo,
): ShareablePluginRef | undefined {
  const trimmedName = plugin.name.trim();
  if (trimmedName.length === 0) {
    return undefined;
  }

  if (
    plugin.facets?.claude &&
    plugin.facets.codex &&
    marketplace.builtIn === true
  ) {
    return {
      type: 'plugin',
      marketplace: { type: 'builtin', id: 'app' },
      plugin_name: trimmedName,
    };
  }

  if (plugin.facets?.claude && plugin.facets.codex) {
    const repo = parseShareableGitHubSource(marketplace.sourceUrl);
    if (repo) {
      return {
        type: 'plugin',
        marketplace: { type: 'github', repo },
        plugin_name: trimmedName,
      };
    }
  }

  if (
    marketplace.sourceType === 'codex' ||
    (plugin.facets?.codex && !plugin.facets.claude)
  ) {
    return {
      type: 'codex_plugin',
      marketplace: { type: 'codex-builtin', id: marketplace.id },
      plugin_name: trimmedName,
    };
  }

  if (marketplace.builtIn === true) {
    return {
      type: 'claude_plugin',
      marketplace: { type: 'builtin', id: 'app' },
      plugin_name: trimmedName,
    };
  }

  const repo = parseShareableGitHubSource(marketplace.sourceUrl);
  if (!repo) {
    return undefined;
  }
  return {
    type: 'claude_plugin',
    marketplace: { type: 'github', repo },
    plugin_name: trimmedName,
  };
}
