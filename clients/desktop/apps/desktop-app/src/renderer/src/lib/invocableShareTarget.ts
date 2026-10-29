import type { InvocableInventoryEntry } from '@canopy/desktop-shared/types';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import {
  isCuratedPluginMarketplaceId,
  type MarketplaceInfo,
  type PluginInfo,
} from '@canopy/desktop-shared/types/plugins';
import {
  computePluginShareableRef,
  getShareablePluginRefKey,
  type ShareablePluginRef,
} from '@canopy/desktop-shared/plugin-refs';
import {
  shareTargetFromEnableRef,
  type ShareTarget,
  type SkillShareTarget,
} from '@canopy/desktop-shared/lib/skill-share-nudge';
import type { SharedPluginSummary } from '@canopy/protocol/plugins';
import type { SelectableShareAudience } from '@canopy/ui-shared/components';

/**
 * Chat-side share targets (CAN-3611).
 *
 * A standalone skill shares as itself; a plugin-owned skill or command shares
 * as its whole plugin. Every chat entry point resolves through this module so
 * the artifact card, mention details, the activity rail, the usage nudge and
 * the agent action agree on what can be shared and with whom it already is.
 *
 * `null` inventory means "not loaded yet" and resolves to `unknown`, never to
 * a permanent "cannot share": only a fully loaded inventory that lacks the
 * target makes it ineligible.
 */

/** The standalone-skill Share rule the Skills tab applies. */
export function canShareSkill(
  skill: Pick<InstalledSkillInfo, 'custom' | 'builtIn' | 'sourceId'>,
): boolean {
  return (
    (skill.custom === true && skill.sourceId === 'custom:app') ||
    (skill.builtIn === true && skill.sourceId === 'builtin:app')
  );
}

/** What the matching share dialog needs for a resolved target. */
export type ResolvedShareTarget =
  | {
      kind: 'skill';
      target: Extract<ShareTarget, { kind: 'skill' }>;
      skill: InstalledSkillInfo;
      /** Name shown in copy and accessible labels. */
      displayName: string;
    }
  | {
      kind: 'plugin';
      target: Extract<ShareTarget, { kind: 'plugin' }>;
      pluginRef: ShareablePluginRef;
      description: string | null;
      displayName: string;
    };

export type ShareTargetResolution =
  | { status: 'resolved'; resolved: ResolvedShareTarget }
  /** Inventory is still loading or failed to load. */
  | { status: 'unknown' }
  /** Inventory is loaded and the target is missing or cannot be shared. */
  | { status: 'ineligible' };

function findInstalledSkill(
  sourceId: string,
  name: string,
  installedSkills: readonly InstalledSkillInfo[],
): InstalledSkillInfo | undefined {
  return installedSkills.find(
    (skill) => skill.sourceId === sourceId && skill.name === name,
  );
}

function findPlugin(
  marketplaceId: string,
  pluginName: string,
  marketplaces: readonly MarketplaceInfo[],
): { marketplace: MarketplaceInfo; plugin: PluginInfo } | undefined {
  const marketplace = marketplaces.find((entry) => entry.id === marketplaceId);
  if (!marketplace) return undefined;
  // The complete identity is marketplace id + plugin name. Selection refs may
  // carry a lower-cased name, so an exact match wins and a case-insensitive
  // match inside the same marketplace is the fallback.
  const plugin =
    marketplace.plugins.find((entry) => entry.name === pluginName) ??
    marketplace.plugins.find(
      (entry) => entry.name.toLowerCase() === pluginName.toLowerCase(),
    );
  return plugin ? { marketplace, plugin } : undefined;
}

/** Resolves a canonical target against the installed inventory. */
export function resolveShareTarget(
  target: ShareTarget,
  installedSkills: readonly InstalledSkillInfo[] | null,
  marketplaces: readonly MarketplaceInfo[] | null,
): ShareTargetResolution {
  // Saved pipeline locators resolve asynchronously through pipelineDocument;
  // installed inventory is never authoritative for them.
  if (target.kind === 'pipeline') return { status: 'unknown' };
  if (target.kind === 'skill') {
    if (installedSkills === null) return { status: 'unknown' };
    const skill = findInstalledSkill(
      target.sourceId,
      target.name,
      installedSkills,
    );
    if (!skill || !canShareSkill(skill)) return { status: 'ineligible' };
    return {
      status: 'resolved',
      resolved: { kind: 'skill', target, skill, displayName: skill.name },
    };
  }
  if (marketplaces === null) return { status: 'unknown' };
  const match = findPlugin(
    target.marketplaceId,
    target.pluginName,
    marketplaces,
  );
  if (!match) return { status: 'ineligible' };
  const pluginRef = computePluginShareableRef(match.plugin, match.marketplace);
  if (!pluginRef) return { status: 'ineligible' };
  return {
    status: 'resolved',
    resolved: {
      kind: 'plugin',
      target,
      pluginRef,
      description: match.plugin.description?.trim() || null,
      displayName: match.plugin.displayName?.trim() || match.plugin.name,
    },
  };
}

/**
 * The share target for an inventory row: the row's standalone skill when it
 * passes the Skills tab rule, or the owning plugin when its shareable
 * reference resolves. `null` covers both "not loaded" and "cannot share".
 */
export function shareTargetForEntry(
  entry: Pick<InvocableInventoryEntry, 'enableRef'>,
  installedSkills: readonly InstalledSkillInfo[] | null,
  marketplaces: readonly MarketplaceInfo[] | null,
): SkillShareTarget | null {
  const target = shareTargetFromEnableRef(entry.enableRef);
  if (!target) return null;
  return resolveShareTarget(target, installedSkills, marketplaces).status ===
    'resolved'
    ? target
    : null;
}

/** The share target for an installed standalone skill, by installed identity. */
export function shareTargetForInstalledSkill(
  sourceId: string,
  skillName: string,
  installedSkills: readonly InstalledSkillInfo[] | null,
): SkillShareTarget | null {
  const target: SkillShareTarget = { kind: 'skill', sourceId, name: skillName };
  return resolveShareTarget(target, installedSkills, null).status === 'resolved'
    ? target
    : null;
}

/** The plugin a plugin-owned row belongs to, as shown in `From <plugin>`. */
export function pluginDisplayName(
  target: Extract<ShareTarget, { kind: 'plugin' }>,
  marketplaces: readonly MarketplaceInfo[] | null,
): string {
  const match = marketplaces
    ? findPlugin(target.marketplaceId, target.pluginName, marketplaces)
    : undefined;
  return match?.plugin.displayName?.trim() || target.pluginName;
}

export type ShareAudienceState =
  /** Shared somewhere. `audience` is absent when no label applies (curated). */
  | {
      status: 'shared';
      audience?: SelectableShareAudience;
      teamName?: string | null;
    }
  /** Confirmed unshared at every scope. */
  | { status: 'unshared' }
  /** Loading, signed out, or the audience request failed. */
  | { status: 'unknown' };

export interface ShareAudienceInputs {
  installedSkills: readonly InstalledSkillInfo[] | null;
  marketplaces: readonly MarketplaceInfo[] | null;
  /** `null` until the shared-plugin list has loaded for `accountId`. */
  sharedPlugins: readonly SharedPluginSummary[] | null;
  /** The connected cloud account; `null` when signed out or unresolved. */
  accountId: string | null;
  /** Account-specific skill metadata has finished loading for this identity. */
  skillAudienceReady?: boolean;
}

/**
 * Who a target is already shared with.
 *
 * A skill reads its author-side link (`remote.shareScope`, plus a public
 * link). A plugin matches this account's own share by reference key, exactly
 * as `SharePluginModal.loadExistingShare` does; a curated Marketplace plugin
 * counts as shared but carries no team or organization label.
 */
export function shareAudienceForTarget(
  target: ShareTarget,
  inputs: ShareAudienceInputs,
): ShareAudienceState {
  // The pipeline dialog's account-scoped preflight loads its actual audience.
  if (target.kind === 'pipeline') return { status: 'unknown' };
  if (target.kind === 'skill') {
    if (
      inputs.installedSkills === null ||
      inputs.accountId === null ||
      inputs.skillAudienceReady === false
    )
      return { status: 'unknown' };
    const skill = findInstalledSkill(
      target.sourceId,
      target.name,
      inputs.installedSkills,
    );
    if (!skill) return { status: 'unknown' };
    const remote = skill.remote;
    if (!remote) return { status: 'unshared' };
    if (remote.publicLink) return { status: 'shared', audience: 'public' };
    if (remote.shareScope === 'team') {
      return {
        status: 'shared',
        audience: 'team',
        teamName: remote.ownerName ?? null,
      };
    }
    if (remote.shareScope === 'organization') {
      return { status: 'shared', audience: 'organization' };
    }
    return { status: 'unshared' };
  }
  if (isCuratedPluginMarketplaceId(target.marketplaceId)) {
    return { status: 'shared' };
  }
  const resolution = resolveShareTarget(target, null, inputs.marketplaces);
  if (resolution.status !== 'resolved' || resolution.resolved.kind !== 'plugin')
    return { status: 'unknown' };
  if (inputs.sharedPlugins === null || inputs.accountId === null)
    return { status: 'unknown' };
  const refKey = getShareablePluginRefKey(resolution.resolved.pluginRef);
  const existing = inputs.sharedPlugins.find(
    (candidate) =>
      candidate.refKey === refKey &&
      candidate.createdBy.id === inputs.accountId,
  );
  if (!existing) return { status: 'unshared' };
  if (existing.publicShare) return { status: 'shared', audience: 'public' };
  if (existing.shareScope === 'team') {
    return {
      status: 'shared',
      audience: 'team',
      teamName: existing.owner.type === 'team' ? existing.owner.name : null,
    };
  }
  if (existing.shareScope === 'organization') {
    return { status: 'shared', audience: 'organization' };
  }
  return { status: 'unshared' };
}
