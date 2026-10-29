import type {
  DesktopShareDeepLinkAudience,
  DesktopShareDeepLinkEntity,
} from '@canopy/protocol/share-deep-link';
import type { UnifiedEntryRef } from '@canopy/protocol/unified-entry';
import type { DeepLinkShareOpenEvent } from '@canopy/desktop-shared/types';

/**
 * Builds the install-review link for a shared resource listed inside the app
 * (CAN-3710), so an in-app Install opens the same review a link from the web
 * does. A team or organization item resolves through the authenticated
 * fallback only when its audience is named; a private item resolves for
 * nobody else, so it gets no link and its row offers no Install.
 */

/** Every share scope a shared skill, collection, agent or automation carries. */
export type SharedResourceScope = 'private' | 'team' | 'organization';

export function shareScopeAudience(
  scope: SharedResourceScope | undefined,
): DesktopShareDeepLinkAudience | null {
  if (scope === 'team') return 'TEAM';
  if (scope === 'organization') return 'ORGANIZATION';
  return null;
}

export function sharedResourceInstallLink(input: {
  entity: Exclude<DesktopShareDeepLinkEntity, 'shared-container'>;
  externalId: string;
  scope: SharedResourceScope | undefined;
}): DeepLinkShareOpenEvent | null {
  const audience = shareScopeAudience(input.scope);
  if (audience === null) return null;
  return {
    entity: input.entity,
    externalId: input.externalId,
    intent: 'install',
    audience,
  };
}

const PUBLIC_SHARE_ENTITY: Readonly<
  Record<
    Extract<UnifiedEntryRef, { type: 'public-share' }>['shareKind'],
    Exclude<DesktopShareDeepLinkEntity, 'shared-container'>
  >
> = {
  skill: 'skill',
  plugin: 'plugin',
  pipeline: 'pipeline',
  agent: 'agent',
  blueprint: 'workspace',
  automation: 'automation',
  collection: 'collection',
};

/** The shared lists a Marketplace card resolves its install link against. */
export interface SharedInstallInventory {
  readonly sharedSkills: readonly {
    readonly id: string;
    readonly shareScope: SharedResourceScope;
  }[];
  readonly sharedCollections: readonly {
    readonly id: string;
    readonly shareScope: SharedResourceScope;
  }[];
  readonly sharedAgents: readonly {
    readonly id: string;
    readonly shareScope: SharedResourceScope;
  }[];
  readonly sharedPlugins: readonly {
    readonly externalId: string;
    readonly shareScope: SharedResourceScope;
  }[];
  readonly sharedBlueprints: readonly {
    readonly externalId: string;
    readonly audience: DesktopShareDeepLinkAudience;
    readonly pinnedContentHash: string;
  }[];
  readonly sharedAutomations: readonly {
    readonly id: string;
    readonly shareScope: SharedResourceScope;
  }[];
}

/**
 * The install-review link for a Marketplace shared entry: `undefined` when
 * the entry is not a shared resource this review installs, `null` when it
 * is one but has nothing to install from here (a private share, or a row the
 * inventory no longer lists).
 */
export function marketplaceEntryInstallLink(
  ref: UnifiedEntryRef,
  inventory: SharedInstallInventory,
): DeepLinkShareOpenEvent | null | undefined {
  switch (ref.type) {
    case 'shared-skill': {
      const skill = inventory.sharedSkills.find(
        (item) => item.id === ref.skillId,
      );
      return skill
        ? sharedResourceInstallLink({
            entity: 'skill',
            externalId: skill.id,
            scope: skill.shareScope,
          })
        : null;
    }
    case 'shared-collection': {
      const collection = inventory.sharedCollections.find(
        (item) => item.id === ref.collectionId,
      );
      return collection
        ? sharedResourceInstallLink({
            entity: 'collection',
            externalId: collection.id,
            scope: collection.shareScope,
          })
        : null;
    }
    case 'shared-agent': {
      const agent = inventory.sharedAgents.find(
        (item) => item.id === ref.agentId,
      );
      return agent
        ? sharedResourceInstallLink({
            entity: 'agent',
            externalId: agent.id,
            scope: agent.shareScope,
          })
        : null;
    }
    case 'shared-plugin': {
      const plugin = inventory.sharedPlugins.find(
        (item) => item.externalId === ref.pluginId,
      );
      return plugin
        ? sharedResourceInstallLink({
            entity: 'plugin',
            externalId: plugin.externalId,
            scope: plugin.shareScope,
          })
        : null;
    }
    case 'shared-blueprint': {
      const blueprint = inventory.sharedBlueprints.find(
        (item) => item.externalId === ref.blueprintId,
      );
      return blueprint ? sharedBlueprintInstallLink(blueprint) : null;
    }
    case 'shared-automation': {
      const automation = inventory.sharedAutomations.find(
        (item) => item.id === ref.automationId,
      );
      return automation
        ? sharedResourceInstallLink({
            entity: 'automation',
            externalId: automation.id,
            scope: automation.shareScope,
          })
        : null;
    }
    case 'curated-automation':
      return curatedAutomationInstallLink({ key: ref.key });
    case 'public-share':
      // A public share resolves for everyone, so it needs no audience.
      return {
        entity: PUBLIC_SHARE_ENTITY[ref.shareKind],
        externalId: ref.externalId,
        intent: 'install',
      };
    default:
      return undefined;
  }
}

/**
 * A project template resolves public-first, then for members; the pin keeps
 * the review on the version the Marketplace listed.
 */
export function sharedBlueprintInstallLink(blueprint: {
  readonly externalId: string;
  readonly audience: DesktopShareDeepLinkAudience;
  readonly pinnedContentHash: string;
}): DeepLinkShareOpenEvent {
  return {
    entity: 'workspace',
    externalId: blueprint.externalId,
    intent: 'install',
    audience: blueprint.audience,
    expectedWorkspaceTemplateContentHash: blueprint.pinnedContentHash,
  };
}

/**
 * A curated catalog automation resolves by its catalog key; the pin, when the
 * caller has the loaded detail, keeps the review on the version it showed.
 */
export function curatedAutomationInstallLink(automation: {
  readonly key: string;
  readonly contentHash?: string;
}): DeepLinkShareOpenEvent {
  return {
    entity: 'automation',
    externalId: automation.key,
    intent: 'install',
    automationSource: 'curated',
    ...(automation.contentHash !== undefined
      ? { expectedAutomationContentHash: automation.contentHash }
      : {}),
  };
}
