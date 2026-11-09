import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  serializeWorkspaceContext,
  type DesktopOrgProjectCatalogSnapshot,
  type WorkspaceContext,
} from '@canopy/desktop-shared/types';
import { getFeatureFlagService } from '../feature-flags';

/**
 * The empty, unavailable catalog every organization project read answers
 * with while the feature is off; null while it is on.
 */
export function disabledOrgProjectCatalog(
  context: WorkspaceContext,
): DesktopOrgProjectCatalogSnapshot | null {
  if (
    getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
    )
  )
    return null;
  return {
    context: serializeWorkspaceContext(context),
    revision: '',
    projects: [],
    fetchedAt: new Date(0).toISOString(),
    stale: true,
    error: 'unavailable',
  };
}
