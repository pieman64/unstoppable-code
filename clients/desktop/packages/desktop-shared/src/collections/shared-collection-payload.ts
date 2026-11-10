// ---------------------------------------------------------------------------
// Shared Collection conversion + editable-state helpers.
//
// This module is the renderer's bridge between three Collection
// representations:
//
//   1. Local `CollectionConfig`         (window.collections.loadCollection)
//   2. Remote `SharedCollectionDetail`  (window.collections.getShared)
//   3. `EditableSharedCollection`       (UI edit state in the renderer)
//
// The Edit flow operates on `EditableSharedCollection` and not on the local
// `CollectionConfig`, because hydrating from a local config would lose every
// linked custom skill's remote `skillId` — the next PUT would silently fork
// each one into a new draft custom skill. The `EditableSharedCollection`
// preserves the remote identity for linked custom skills and exposes a
// distinct `EditableDraftCustomSkillItem` for genuinely new entries.
//
// `buildSharedCollectionPayload` is the single entrypoint that converts an
// editable (or local first-time-share) collection into the
// `SharedCollectionWriteDocument` + `customSkills` pair expected by
// `window.collections.{createShared,updateShared}`. It enforces the MCP
// blocking rule with the exact required copy.
// ---------------------------------------------------------------------------

import {
  MCP_SHARE_BLOCKED_MESSAGE,
  type SharedCollectionCustomSkillPayload,
  type SharedCollectionDetail,
  type SharedCollectionItem,
  type SharedCollectionWriteItem,
} from '@canopy/protocol/collections';
import type {
  CollectionConfig,
  CollectionSkillRef,
  CollectionPluginRef,
  CollectionMcpRef,
} from '../types/collections';
import type { InstalledSkillInfo, SharedSkillDetail } from '../types/skills';
import type { ShareablePluginSource } from '../types/plugin-refs';
import {
  BUILTIN_PLUGIN_MARKETPLACE_SOURCE_URL,
  isBuiltInPluginMarketplaceId,
  type PluginInfo,
} from '@canopy/execution-engine/types/plugins';
import { parseShareableGitHubSource } from '@canopy/execution-engine/plugin-refs';
import type { PipelinePackageEnvironmentRequirement } from '@canopy/protocol/pipelines';

export { MCP_SHARE_BLOCKED_MESSAGE };

// ---------------------------------------------------------------------------
// Editable state types.
//
// `kind` is the renderer-side discriminator. It is intentionally distinct from
// the wire shape's `type` so the conversion helper can tell a freshly added
// draft custom skill (`draft_custom_skill`) apart from a previously linked
// shared skill (`linked_custom_skill`). The latter must round-trip with its
// remote `skillId` so the server does not re-create a fork.
// ---------------------------------------------------------------------------

export interface EditableExternalSkillItem {
  kind: 'external_skill';
  source: ShareablePluginSource;
  skillName: string;
  required?: boolean;
}

export interface EditableExternalPluginItem {
  kind: 'external_plugin';
  marketplace: ShareablePluginSource;
  pluginName: string;
  required?: boolean;
}

/**
 * Previously linked custom skill. Carries the remote `skillId`, the latest
 * `contentHash` we last fetched, and the skill name as stored on the server.
 * On save this becomes a `{ type: 'custom_skill', skillId, ... }` write-side
 * item — no payload entry — preserving link identity.
 */
export interface EditableLinkedCustomSkillItem {
  kind: 'linked_custom_skill';
  skillId: string;
  skillName: string;
  contentHash: string;
  required?: boolean;
}

/**
 * Newly added custom skill (during edit, or first-time share). No remote
 * identity yet. The renderer assigns a stable `clientKey` per UI item so
 * retries do not fork the draft; the server resolves the draft into a stored
 * `CustomSkill` on persist.
 */
export interface EditableDraftCustomSkillItem {
  kind: 'draft_custom_skill';
  clientKey: string;
  /** Local custom-skill id (e.g. `custom:app/<name>`) for `readRawSkill`. */
  localSkillId: string;
  /** Local custom-skill name; used as the wire `skill_name` field. */
  skillName: string;
  required?: boolean;
}

export type EditableCollectionItem =
  | EditableExternalSkillItem
  | EditableExternalPluginItem
  | EditableLinkedCustomSkillItem
  | EditableDraftCustomSkillItem;

export interface EditableSharedCollection {
  /** `SharedCollectionSummary.id` — empty string when not yet persisted. */
  remoteId: string;
  name: string;
  description: string;
  items: EditableCollectionItem[];
}

// ---------------------------------------------------------------------------
// Hydration: SharedCollectionDetail -> EditableSharedCollection.
// ---------------------------------------------------------------------------

export interface HydrationWarning {
  index: number;
  message: string;
}

export interface HydratedEditableSharedCollection {
  editable: EditableSharedCollection;
  warnings: HydrationWarning[];
}

/**
 * Hydrate a remote `SharedCollectionDetail` into renderer edit state.
 *
 * Each linked custom skill becomes an `EditableLinkedCustomSkillItem` carrying
 * the remote `skillId` and `contentHash`. The matching entry in
 * `detail.customSkills` is consumed only by the read-only viewer; it is NOT
 * converted to a draft. This is the critical step that prevents the share
 * conversion from emitting duplicate drafts on save.
 *
 * Unknown item types are dropped from the editable state but surfaced as
 * warnings so the Edit UI can refuse to save until the user removes them.
 */
export function hydrateEditableSharedCollection(
  detail: SharedCollectionDetail,
): HydratedEditableSharedCollection {
  const warnings: HydrationWarning[] = [];
  const items: EditableCollectionItem[] = [];

  detail.collection.items.forEach((item, index) => {
    const required = item.required;
    switch (item.type) {
      case 'skill': {
        items.push({
          kind: 'external_skill',
          source: item.source,
          skillName: item.skill_name,
          ...(required !== undefined ? { required } : {}),
        });
        break;
      }
      case 'claude_plugin': {
        items.push({
          kind: 'external_plugin',
          marketplace: item.marketplace,
          pluginName: item.plugin_name,
          ...(required !== undefined ? { required } : {}),
        });
        break;
      }
      case 'custom_skill': {
        items.push({
          kind: 'linked_custom_skill',
          skillId: item.skillId,
          skillName: item.skill_name,
          contentHash: item.contentHash,
          ...(required !== undefined ? { required } : {}),
        });
        break;
      }
      default: {
        const unknownItem = item as { type?: unknown };
        const rawType = unknownItem.type;
        const typeLabel =
          typeof rawType === 'string' && rawType.length > 0
            ? rawType
            : '(missing)';
        warnings.push({
          index,
          message: `Item #${index} has unknown type "${typeLabel}".`,
        });
      }
    }
  });

  return {
    editable: {
      remoteId: detail.id,
      name: detail.collection.name,
      description: detail.collection.description,
      items,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Share conversion.
// ---------------------------------------------------------------------------

export interface SharedCollectionConversionInput {
  /** Display name and description forwarded into the wire document. */
  name: string;
  description: string;
  /** Editable items (preserve order; canonical JSON preserves it on the wire). */
  items: EditableCollectionItem[];
  /**
   * Catalog of locally installed custom skills used to read raw bytes for
   * `draft_custom_skill` items. The caller supplies this to keep the helper
   * pure (no `window.skills` access in this module).
   */
  customSkillReader: (localSkillId: string) => Promise<string>;
}

export interface SharedCollectionConversionResult {
  rawCollection: string;
  customSkills: SharedCollectionCustomSkillPayload[];
}

/**
 * Build the wire payload for `window.collections.{createShared,updateShared}`.
 *
 * Behavior:
 *   - draft custom skills are read through the supplied `customSkillReader`
 *     (which must call `window.skills.readRawSkill` — the exact SKILL.md bytes
 *     are what the server hashes);
 *   - previously linked custom skills are emitted as `{ type: 'custom_skill',
 *     skillId, ... }` items with no payload entry, preserving link identity;
 *   - canonical JSON preserves item order.
 *
 * Throws on:
 *   - any item type that cannot be expressed as a portable share ref;
 *   - duplicate `clientKey`s across draft items (the server pairs payloads to
 *     items by `clientKey`).
 */
export async function buildSharedCollectionPayload(
  input: SharedCollectionConversionInput,
): Promise<SharedCollectionConversionResult> {
  const writeItems: SharedCollectionWriteItem[] = [];
  const customSkills: SharedCollectionCustomSkillPayload[] = [];
  const seenClientKeys = new Set<string>();

  for (const item of input.items) {
    const required = item.required;
    switch (item.kind) {
      case 'external_skill': {
        writeItems.push({
          type: 'skill',
          source: item.source,
          skill_name: item.skillName,
          ...(required !== undefined ? { required } : {}),
        });
        break;
      }
      case 'external_plugin': {
        writeItems.push({
          type: 'claude_plugin',
          marketplace: item.marketplace,
          plugin_name: item.pluginName,
          ...(required !== undefined ? { required } : {}),
        });
        break;
      }
      case 'linked_custom_skill': {
        writeItems.push({
          type: 'custom_skill',
          skillId: item.skillId,
          skill_name: item.skillName,
          contentHash: item.contentHash,
          ...(required !== undefined ? { required } : {}),
        });
        break;
      }
      case 'draft_custom_skill': {
        if (seenClientKeys.has(item.clientKey)) {
          throw new Error(
            `Duplicate clientKey "${item.clientKey}" — every draft custom skill item must have a unique clientKey.`,
          );
        }
        seenClientKeys.add(item.clientKey);
        const rawSkill = await input.customSkillReader(item.localSkillId);
        writeItems.push({
          type: 'custom_skill',
          clientKey: item.clientKey,
          skill_name: item.skillName,
          ...(required !== undefined ? { required } : {}),
        });
        customSkills.push({
          clientKey: item.clientKey,
          name: item.skillName,
          rawSkill,
        });
        break;
      }
    }
  }

  const document = {
    version: 1,
    name: input.name,
    description: input.description,
    items: writeItems,
  };

  return {
    rawCollection: JSON.stringify(document),
    customSkills,
  };
}

// ---------------------------------------------------------------------------
// Local -> editable conversion (first-time share path).
// ---------------------------------------------------------------------------

export interface ConvertLocalCollectionInput {
  config: CollectionConfig;
  /** Local custom-skill metadata catalog (from `window.skills.loadSkills`). */
  installedSkills: InstalledSkillInfo[];
  /** Marketplace catalog used to resolve portable plugin refs. */
  marketplaces: Array<{ id: string; sourceUrl: string }>;
  /**
   * Optional plugin catalog used to look up plugin metadata when only the
   * marketplace id is recorded (current local Collections store
   * `{ marketplaceId, pluginName }`).
   */
  plugins?: PluginInfo[];
  /**
   * Generator for stable client keys. Defaults to `crypto.randomUUID` when
   * available. Pass a deterministic stub from tests.
   */
  generateClientKey?: () => string;
}

export interface ConvertLocalCollectionResult {
  editable: EditableSharedCollection;
  environmentRequirements: PipelinePackageEnvironmentRequirement[];
}

/**
 * Convert a local `CollectionConfig` into an `EditableSharedCollection` for
 * first-time sharing. The resulting editable state contains:
 *
 *   - `external_skill` items for built-in / GitHub-backed skills (resolved
 *     through the installed-skill catalog's `shareableSource`);
 *   - `draft_custom_skill` items for `custom:app/...` and local-filesystem
 *     skills (each with a fresh client key);
 *   - `external_plugin` items for built-in or GitHub-backed marketplace
 *     plugins.
 *
 * MCP server refs become named environment requirements; their configuration
 * and credentials are never embedded in the shared Collection.
 *
 * Throws on any unshareable skill / plugin ref other than a local-filesystem skill
 *     (for example, an unsupported marketplace).
 */
export function convertLocalCollectionToEditable(
  input: ConvertLocalCollectionInput,
): ConvertLocalCollectionResult {
  const generator =
    input.generateClientKey ??
    ((): string => {
      const crypto =
        typeof globalThis !== 'undefined'
          ? (globalThis as { crypto?: Crypto }).crypto
          : undefined;
      if (crypto && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
      return `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    });

  const items: EditableCollectionItem[] = [];

  for (const skillRef of input.config.skills) {
    items.push(skillRefToEditable(skillRef, input.installedSkills, generator));
  }
  for (const pluginRef of input.config.plugins) {
    items.push(pluginRefToEditable(pluginRef, input.marketplaces));
  }

  return {
    editable: {
      remoteId: '',
      name: input.config.name,
      description: input.config.description,
      items,
    },
    environmentRequirements: (input.config.mcpServers ?? []).map((server) => ({
      id: `mcp:${server.serverId}`,
      kind: 'mcp',
      displayName: server.serverId,
      required: true,
      affectedSteps: [],
      setupHint: `Connect ${server.serverId} in Settings.`,
    })),
  };
}

function skillRefToEditable(
  ref: CollectionSkillRef,
  installedSkills: InstalledSkillInfo[],
  generateClientKey: () => string,
): EditableCollectionItem {
  const skill = installedSkills.find(
    (candidate) =>
      candidate.sourceId === ref.sourceId && candidate.name === ref.skillName,
  );
  if (!skill) {
    throw new Error(
      `Cannot share Collection: skill "${ref.sourceId}/${ref.skillName}" is not installed locally.`,
    );
  }

  if (
    (skill.custom === true && skill.sourceId === 'custom:app') ||
    skill.sourceId.startsWith('local:')
  ) {
    return {
      kind: 'draft_custom_skill',
      clientKey: generateClientKey(),
      localSkillId: `${skill.sourceId}/${skill.name}`,
      skillName: skill.name,
    };
  }

  const shareableSource = skill.shareableSource;
  if (!shareableSource) {
    throw new Error(
      `Cannot share Collection: skill "${skill.name}" has no shareable source (e.g. a local-filesystem install).`,
    );
  }

  return {
    kind: 'external_skill',
    source: shareableSource,
    skillName: skill.name,
  };
}

function pluginRefToEditable(
  ref: CollectionPluginRef,
  marketplaces: Array<{ id: string; sourceUrl: string }>,
): EditableCollectionItem {
  const marketplace = marketplaces.find(
    (candidate) => candidate.id === ref.marketplaceId,
  );
  if (!marketplace) {
    throw new Error(
      `Cannot share Collection: marketplace for plugin "${ref.pluginName}" is not installed locally.`,
    );
  }
  if (
    isBuiltInPluginMarketplaceId(marketplace.id) ||
    marketplace.sourceUrl === BUILTIN_PLUGIN_MARKETPLACE_SOURCE_URL
  ) {
    return {
      kind: 'external_plugin',
      marketplace: { type: 'builtin', id: 'app' },
      pluginName: ref.pluginName,
    };
  }
  // STRICT parse, not the permissive `parseGitHubRepo`: a shared Collection is
  // uploaded to Cloud and read by recipients, so a marketplace URL carrying
  // userinfo, a query or a fragment must be REFUSED rather than normalized
  // into a public reference. The error deliberately omits `sourceUrl` — it is
  // the very thing that may hold the credential, and this message reaches the
  // browser (review on #3180).
  const repo = parseShareableGitHubSource(marketplace.sourceUrl);
  if (!repo) {
    throw new Error(
      `Cannot share Collection: plugin "${ref.pluginName}" is hosted on an unsupported marketplace.`,
    );
  }
  return {
    kind: 'external_plugin',
    marketplace: { type: 'github', repo },
    pluginName: ref.pluginName,
  };
}

// ---------------------------------------------------------------------------
// Post-save rehydration helper. Used after `updateShared` succeeds to refresh
// the editable state with the now-assigned remote skillIds for any drafts.
// ---------------------------------------------------------------------------

export function rehydrateAfterSave(
  detail: SharedCollectionDetail,
): EditableSharedCollection {
  return hydrateEditableSharedCollection(detail).editable;
}

// ---------------------------------------------------------------------------
// Import resolution data shapes.
//
// The Collection import flow (`Phase F2 Step 11`) needs to resolve every item
// before saving the local Collection. These shapes describe the per-item
// resolution state so the UI can render progress and the orchestrator can
// short-circuit on the first failure.
// ---------------------------------------------------------------------------

export type ImportItemStatus = 'pending' | 'resolved' | 'failed';

export interface ImportItemState {
  /** Wire item being imported. */
  item: SharedCollectionItem;
  status: ImportItemStatus;
  /** Populated on success. For skills this is the local `sourceId/name`. */
  resolvedRef?:
    | { kind: 'skill'; sourceId: string; skillName: string }
    | { kind: 'plugin'; marketplaceId: string; pluginName: string };
  /** Populated on failure. */
  error?: string;
}

export interface CustomSkillImportSpec {
  detail: SharedSkillDetail;
}

/**
 * Local-Collection-ref output of the import resolver. The renderer save path
 * passes this to `window.collections.saveCollection` once every item resolves.
 */
export interface ResolvedCollectionRefs {
  skills: CollectionSkillRef[];
  plugins: CollectionPluginRef[];
  mcpServers: CollectionMcpRef[];
}
