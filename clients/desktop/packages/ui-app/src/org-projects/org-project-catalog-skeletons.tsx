'use client';

import type { JSX } from 'react';
import { Button, EmptyState } from '@canopy/ui-shared';
import { Skeleton } from '@canopy/ui-shared/components';
import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import { OrgProjectRow } from './OrgProjectRow';

/**
 * Loading states for the organization catalog. Each renders the catalog's own
 * parts with plain samples inside `Skeleton`, so skullet measures them into
 * bars and blocks and the loaded catalog replaces the skeleton in place.
 */

function sampleProject(
  id: string,
  name: string,
  description: string,
): OrgProjectSummary {
  return {
    id,
    organizationId: 'org-project-skeleton',
    name,
    description: null,
    kind: 'CODE',
    purpose: 'project',
    visibility: 'organization',
    memberOwned: false,
    location: 'LOCAL',
    repository: {
      provider: 'github',
      host: 'github.com',
      owner: 'acme',
      name,
      providerRepoId: id,
      defaultBranch: 'main',
      verification: 'VERIFIED',
      visibility: 'PRIVATE',
      description,
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: true,
    preference: 'FOLLOW_DEFAULTS',
    listed: true,
    capabilities: { use: true, administer: false, manageCloud: false },
    instance: null,
  };
}

const SAMPLE_PROJECTS: readonly OrgProjectSummary[] = [
  sampleProject('org-project-skeleton-1', 'checkout', 'Payments and checkout'),
  sampleProject('org-project-skeleton-2', 'docs', 'Product documentation'),
  sampleProject('org-project-skeleton-3', 'mobile', 'The mobile app'),
];

/** The catalog's project rows, each with its Add action. */
export function OrgProjectCatalogRowsSkeleton({
  addLabel,
}: {
  readonly addLabel: string;
}): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading projects"
      testId="add-workspace-org-catalog-loading"
    >
      <section aria-label="Projects" className="flex flex-col gap-2">
        {SAMPLE_PROJECTS.map((project) => (
          <OrgProjectRow
            key={project.id}
            project={project}
            testIdPrefix="add-workspace-org-catalog"
            actions={
              <Button size="sm" variant="secondary">
                {addLabel}
              </Button>
            }
          />
        ))}
      </section>
    </Skeleton>
  );
}

/**
 * The setup empty state, while the GitHub connection is checked: either
 * outcome is a title, a line, and one action.
 */
export function OrgProjectCatalogSetupSkeleton({
  organizationLabel,
}: {
  readonly organizationLabel: string;
}): JSX.Element {
  return (
    <Skeleton
      loading
      label="Checking GitHub connection"
      testId="add-workspace-org-catalog-setup-loading"
    >
      <EmptyState
        title={`No projects in ${organizationLabel} yet`}
        subtitle="Choose which repos your team can add as projects."
        action={
          <Button size="sm" variant="primary">
            Choose projects
          </Button>
        }
      />
    </Skeleton>
  );
}
