import { shareAudienceLabelText } from '@canopy/ui-shared/components';
import type {
  PipelineShareOwner,
  PipelineShareScope,
} from '@canopy/execution-engine/types/pipeline';

interface ScopeMeta {
  label: string;
  badgeClass: string;
}

export type PipelineDisplayScope = 'shared' | 'team' | 'organization';

export const PIPELINE_SCOPE_META: Record<PipelineDisplayScope, ScopeMeta> = {
  shared: {
    label: 'Shared',
    badgeClass: 'bg-success-subtle fg-success',
  },
  team: {
    label: 'Team',
    badgeClass: 'bg-info-subtle fg-info',
  },
  organization: {
    label: 'Organization',
    badgeClass: 'bg-warning-subtle fg-warning',
  },
};

/**
 * Coerce a stored scope into a display scope. Private is a storage value, not
 * an audience label; older rows that omit scope use the same neutral label.
 */
export function normalizePipelineShareScope(
  shareScope: PipelineShareScope | undefined,
): PipelineDisplayScope {
  if (shareScope === 'team' || shareScope === 'organization') {
    return shareScope;
  }
  return 'shared';
}

/**
 * Resolve the visible label for a `PipelineScopeBadge`. Missing or unknown
 * scope values fall back to a neutral `Shared` label.
 */
export function getPipelineScopeBadgeLabel(
  shareScope: PipelineShareScope | undefined,
  owner?: PipelineShareOwner,
  personalOrganizationId: string | null = null,
): string {
  const scope = normalizePipelineShareScope(shareScope);
  return scope === 'shared'
    ? 'Shared'
    : shareAudienceLabelText(
        scope,
        undefined,
        owner?.type === 'organization' && owner.id === personalOrganizationId,
      );
}

/**
 * Resolve the tooltip lines for a `PipelineScopeBadge`. Returns an empty
 * array when no tooltip should be rendered (the neutral shared scope). For
 * team / organization scopes the function falls back to the scope label
 * when `owner` is missing or its `name` field is empty.
 */
export function getPipelineScopeBadgeTooltipLines(
  shareScope: PipelineShareScope | undefined,
  owner: PipelineShareOwner | undefined,
  personalOrganizationId: string | null = null,
): string[] {
  if (owner?.type === 'organization' && owner.id === personalOrganizationId)
    return ['Personal'];
  const scope = normalizePipelineShareScope(shareScope);
  if (scope === 'shared') return [];
  if (scope === 'team') {
    if (owner && owner.type === 'team' && owner.name) {
      return [owner.name, owner.organization.name];
    }
    return ['Team'];
  }
  // Organization
  if (owner && owner.type === 'organization' && owner.name) {
    return [owner.name];
  }
  return ['Organization'];
}
