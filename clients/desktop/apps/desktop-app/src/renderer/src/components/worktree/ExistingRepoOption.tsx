import type { JSX } from 'react';
import { Tooltip } from '@canopy/ui-shared';
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
      <button
        type="button"
        disabled={outside}
        onClick={() => onAdd(repoPath, name)}
        data-testid="workspace-settings-existing-repo"
        className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
      >
        <span className="font-medium fg-primary">{name}</span>
        <span className="min-w-0 flex-1 truncate fg-secondary">{repoPath}</span>
      </button>
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
            <InfoIcon width={12} height={12} />
          </span>
        </Tooltip>
      )}
    </div>
  );
}
