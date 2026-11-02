/** Serializable identity shared by desktop and cloud capability catalogs. */
export type UnifiedEntryKind =
  | 'plugin'
  | 'app'
  | 'skill'
  | 'pipeline'
  | 'collection'
  /**
   * A first-class Marketplace kind on desktop and the web portal (local,
   * team-shared, and curated automations), and also a public share kind.
   */
  | 'automation'
  /** Public share catalog kinds surfaced by the web Marketplace; desktop never produces them. */
  | 'blueprint'
  | 'agent';

/**
 * Broad provenance class used for display grouping. Concrete source ids remain
 * open strings on catalog entries so adding a marketplace never expands this
 * union.
 */
export type UnifiedEntryOrigin =
  | 'curated'
  | 'marketplace'
  | 'installed-standalone'
  | 'custom'
  | 'built-in'
  | 'project'
  | 'shared';

export type UnifiedEntryState = 'installed' | 'available' | 'needs-auth';

/**
 * Portable local-agent inventory input. Hosts map their canonical definitions
 * and model availability onto this shape; no host services or paths cross it.
 */
export interface UnifiedLocalAgentInput {
  id: string;
  /** Authored display name, preserving casing. */
  name: string;
  /** Instructions summary, falling back to the base-model description. */
  description: string;
  baseModelLabel: string;
  pluginCount: number;
  updatedAt: string;
  /** Unavailable agents remain in inventory so they can still be managed. */
  available: boolean;
  /** Exact shared-resource identity in the active account/context, if any. */
  sharedRemoteId?: string;
}

/** Local and shared copies never collide, even when their source ids match. */
export function localAgentEntryId(agentId: string): string {
  return `agent:local:${agentId}`;
}

/** Portable selection identity carried by a unified catalog row. */
export type UnifiedEntryRef =
  | {
      type: 'public-share';
      shareKind:
        | 'skill'
        | 'plugin'
        | 'pipeline'
        | 'agent'
        | 'blueprint'
        | 'automation'
        | 'collection';
      externalId: string;
      sharePath: string;
    }
  | { type: 'curated-plugin'; key: string }
  | { type: 'curated-pipeline'; key: string }
  | { type: 'marketplace-plugin'; marketplaceId: string; pluginName: string }
  /**
   * A skill an installed marketplace plugin bundles; it has no status of its
   * own and follows the plugin (CAN-4844).
   */
  | {
      type: 'plugin-skill';
      marketplaceId: string;
      pluginName: string;
      skillName: string;
    }
  | { type: 'curated-mcp'; key: string }
  | {
      type: 'local-mcp';
      serverId: string;
      /**
       * The configuration this row names. Account rows for one key share
       * the server id, so the configuration is what tells a Personal row
       * from a Work row (REG-3033). Absent on device rows.
       */
      configId?: string;
      /**
       * Catalog key the server was installed under, when it has one, so the
       * row can resolve a bundled brand mark even while the curated catalog
       * is empty or no longer lists that key.
       */
      curatedKey?: string;
    }
  | { type: 'mcp-server'; serverId: string; configId: string }
  | { type: 'skill'; sourceId: string; skillName: string }
  | { type: 'shared-skill'; skillId: string }
  | {
      type: 'pipeline';
      pipelineId: string;
      source: 'bundled' | 'user' | 'project' | 'shared';
      filePath?: string;
      remoteId?: string;
    }
  | { type: 'local-collection'; collectionId: string }
  | { type: 'shared-collection'; collectionId: string }
  | { type: 'local-agent'; agentId: string }
  | { type: 'shared-agent'; agentId: string }
  | { type: 'shared-plugin'; pluginId: string }
  | { type: 'shared-blueprint'; blueprintId: string }
  /** A local automation, by its scheduled-activity id. */
  | { type: 'automation'; activityId: string }
  /** A team-shared automation, by its server-side shared resource id. */
  | { type: 'shared-automation'; automationId: string }
  /** A curated catalog automation, by its catalog key. */
  | { type: 'curated-automation'; key: string }
  | {
      type: 'provider-connector';
      displayName: string;
      /** Catalog key, so the row can resolve a bundled brand mark. */
      curatedKey?: string;
    };
