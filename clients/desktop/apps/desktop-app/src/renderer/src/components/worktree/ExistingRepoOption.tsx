import type { JSX } from 'react';
import { ListRow, Tooltip } from '@canopy/ui-shared/components';
import { InfoIcon } from '@canopy/ui-shared/icons/AppIcons';
import { orgOutsideRepositoryTooltipText } from '@canopy/desktop-shared/lib/org-multi-repo-copy';
import type { OrgRepositoryEligibility } from './orgRepositoryEligibility';

interface ExistingRepoOptionProps {
  name: string;
  repoPath: string;
  eligibility: OrgRepositoryEligibility | null;
  onAdd: (repoPath: string, name: string) => void;
}

/** One Existing choice; disabled with its reason when the organization refuses it. */
export function ExistingRepoOption({
  name,
  repoPath,
  eligibility,
  onAdd,
}: ExistingRepoOptionProps): JSX.Element {
  const outside = eligibility?.repositories[repoPath] === 'outside';
  return (
    <div className="flex w-full items-center gap-2">
      <ListRow
        disabled={outside}
        onClick={() => onAdd(repoPath, name)}
        data-testid="workspace-settings-existing-repo"
        className="min-w-0 flex-1"
        description={repoPath}
      >
        {name}
      </ListRow>
      {outside && eligibility !== null && (
        // The reason sits on the icon, so the tooltip anchors to it.
        <Tooltip
          label={orgOutsideRepositoryTooltipText(
            name,
            eligibility.organizationName,
          )}
        >
          <span
            className="shrink-0 px-2 fg-secondary"
            data-testid="workspace-settings-existing-repo-reason"
            tabIndex={0}
          >
            <InfoIcon size="sm" />
          </span>
        </Tooltip>
      )}
    </div>
  );
}
