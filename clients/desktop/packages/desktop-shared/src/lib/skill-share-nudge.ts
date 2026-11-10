import type { PipelineRepairShareTarget } from '@canopy/protocol/capability-package-repair';
import type { InvocableInventoryEnableRef } from '@canopy/execution-engine/types/invocable-inventory';
import type { IPCResult } from '@canopy/execution-engine/types/pipeline';

/** Installed identity, not display text. Renaming/reinstalling/recreating it can change its lifetime count. */
export type SkillShareTarget =
  | { kind: 'skill'; sourceId: string; name: string }
  | { kind: 'plugin'; marketplaceId: string; pluginName: string };

/** Canonical chat-side sharing identity, including saved pipeline locators. */
export type ShareTarget = SkillShareTarget | PipelineRepairShareTarget;

export const SKILL_SHARE_NUDGE_USE_THRESHOLD = 3;
export type ShareRequestSource =
  | 'artifact_card'
  | 'mention_detail'
  | 'activity_panel'
  | 'usage_nudge'
  | 'agent';
export type SkillShareNudgeResolution =
  | 'shown'
  | 'dismissed'
  | 'shared'
  | 'ineligible';
export interface SkillShareNudgeOrigin {
  projectId: string;
  worktreeId: string;
  chatId: string;
}
export interface PendingSkillShareNudge {
  id: string;
  target: SkillShareTarget;
  state: 'pending' | 'shown';
}
export interface ResolveSkillShareNudgeRequest extends SkillShareNudgeOrigin {
  pendingId: string;
  target: SkillShareTarget;
  resolution: SkillShareNudgeResolution;
}
export const SKILL_SHARE_NUDGE_CHANNELS = {
  getPending: 'skill-share-nudge:get-pending',
  resolve: 'skill-share-nudge:resolve',
  changed: 'skill-share-nudge:changed',
} as const;
export interface SkillShareNudgeAPI {
  getPending(
    origin: SkillShareNudgeOrigin,
  ): Promise<IPCResult<PendingSkillShareNudge | null>>;
  resolve(request: ResolveSkillShareNudgeRequest): Promise<IPCResult<boolean>>;
  onChanged(callback: (origin: SkillShareNudgeOrigin) => void): () => void;
}

/**
 * The share target behind an inventory row, or `null` for a row with nothing
 * to enable (a Cursor chat's inherited home-folder skill or command): it is
 * not a Canopy resource and cannot be shared.
 */
export function shareTargetFromEnableRef(
  ref: InvocableInventoryEnableRef,
): SkillShareTarget | null {
  if (ref.kind === 'none') return null;
  return ref.kind === 'skill'
    ? { kind: 'skill', sourceId: ref.sourceId, name: ref.skillName }
    : {
        kind: 'plugin',
        marketplaceId: ref.marketplaceId,
        pluginName: ref.pluginName,
      };
}

export function shareTargetKey(target: SkillShareTarget): string {
  return target.kind === 'skill'
    ? JSON.stringify(['skill', target.sourceId, target.name])
    : JSON.stringify(['plugin', target.marketplaceId, target.pluginName]);
}

export function isShareTarget(value: unknown): value is SkillShareTarget {
  if (!value || typeof value !== 'object') return false;
  const nonempty = (field: unknown): field is string =>
    typeof field === 'string' &&
    field.trim().length > 0 &&
    field.length <= 4096;
  return (
    'kind' in value &&
    ((value.kind === 'skill' &&
      'sourceId' in value &&
      'name' in value &&
      nonempty(value.sourceId) &&
      nonempty(value.name)) ||
      (value.kind === 'plugin' &&
        'marketplaceId' in value &&
        'pluginName' in value &&
        nonempty(value.marketplaceId) &&
        nonempty(value.pluginName)))
  );
}

export function isShareTargetKey(key: string): boolean {
  try {
    const fields: unknown = JSON.parse(key);
    if (!Array.isArray(fields) || fields.length !== 3) return false;
    const kind: unknown = fields[0];
    const source: unknown = fields[1];
    const name: unknown = fields[2];
    const target: unknown =
      kind === 'skill'
        ? { kind, sourceId: source, name }
        : { kind, marketplaceId: source, pluginName: name };
    return isShareTarget(target) && shareTargetKey(target) === key;
  } catch {
    return false;
  }
}

export function isSkillShareNudgeResolution(
  value: unknown,
): value is SkillShareNudgeResolution {
  return (
    value === 'shown' ||
    value === 'dismissed' ||
    value === 'shared' ||
    value === 'ineligible'
  );
}
