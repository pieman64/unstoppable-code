import type { PipelineContextResource } from '@canopy/desktop-shared/node/background-execution-context';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import type { ResourceOwner } from '@canopy/protocol/resource-owner';
import { parseWorkspaceContext } from '@canopy/protocol/workspace-context';

type ActivityProvenance = Pick<
  ScheduledActivity,
  'id' | 'installedFrom' | 'publicInstallContext'
>;

export function isContextOwnedInstall(
  installedFrom: ScheduledActivity['installedFrom'],
): boolean {
  return (
    installedFrom?.sourceKind === 'public' ||
    installedFrom?.sourceKind === 'curated'
  );
}

/**
 * Whether the activity definition came from another source. Only
 * `installedFrom` marks a foreign definition; `remote` records that this
 * device published the activity, so the author's copy is never foreign.
 */
export function isForeignAutomationDefinition(
  activity: Pick<ScheduledActivity, 'installedFrom'>,
): boolean {
  return Boolean(activity.installedFrom);
}

/**
 * Owner of a public install: the context in scope when the user installed it.
 * Installs recorded before that context was captured are Personal; an
 * unreadable context stays unverified.
 */
export function publicInstallOwner(
  activity: Pick<ScheduledActivity, 'publicInstallContext'>,
): ResourceOwner | { shareScope: 'private' } | undefined {
  if (activity.publicInstallContext === undefined)
    return { shareScope: 'private' };
  const context = parseWorkspaceContext(activity.publicInstallContext);
  if (!context) return undefined;
  return context.kind === 'organization'
    ? { type: 'organization', id: context.organizationId, name: null }
    : { shareScope: 'private' };
}

/**
 * Background-authorization resource for the activity definition itself.
 *
 * Every non-foreign activity is a locally authored, Personal definition
 * whatever audience it was shared with: the `'private'` literal is the owner
 * classifier's Personal marker, not the share audience, so never pass
 * `remote.shareScope` through. Public installs belong to their install
 * context. Team/org installs are resolved by the host from their install
 * receipt and the share's current owner.
 */
export function automationDefinitionResource(
  activity: ActivityProvenance,
): PipelineContextResource {
  if (!activity.installedFrom) return { owner: { shareScope: 'private' } };
  if (isContextOwnedInstall(activity.installedFrom))
    return { owner: publicInstallOwner(activity) };
  return {
    owner: undefined,
    requiresHostAuthorization: true,
    capabilities: { installedAutomation: { id: activity.id } },
  };
}
