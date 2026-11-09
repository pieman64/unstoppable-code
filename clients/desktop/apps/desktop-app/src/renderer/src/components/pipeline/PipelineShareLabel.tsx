import { useResourceContext } from '@canopy/ui-app/capability';
import type { JSX } from 'react';
import { ShareAudienceLabel } from '@canopy/ui-shared/components';
import type {
  PipelineShareOwner,
  PipelineShareScope,
} from '@canopy/execution-engine/types/pipeline';
import { normalizePipelineShareScope } from './pipeline-scope-badge-helpers';

export interface PipelineShareLabelProps {
  shareScope?: PipelineShareScope;
  owner?: PipelineShareOwner;
}

/**
 * Who a cloud pipeline is shared with, as quiet text beside its name:
 * `Team: Platform` or `Organization`, the same label every shared resource
 * uses. A row with neither audience (a personal cloud copy, or an older row
 * with no scope) reads `Shared`, in the same ink.
 */
export function PipelineShareLabel({
  shareScope,
  owner,
}: PipelineShareLabelProps): JSX.Element {
  const { personalOrganizationId } = useResourceContext();
  const scope = normalizePipelineShareScope(shareScope);
  if (scope === 'shared') {
    return (
      <span className="shrink-0 whitespace-nowrap text-xs fg-tertiary">
        Shared
      </span>
    );
  }
  return (
    <ShareAudienceLabel
      audience={scope}
      personal={
        scope === 'organization' &&
        owner?.type === 'organization' &&
        owner.id === personalOrganizationId
      }
      teamName={owner?.type === 'team' ? owner.name : null}
    />
  );
}
