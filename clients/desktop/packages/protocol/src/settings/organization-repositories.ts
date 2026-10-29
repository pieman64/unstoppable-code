/**
 * Browser-safe organization repository and GitHub connection contracts,
 * moved from `apps/web/src/lib/tracked-workspaces/organization-repository-admin-types.ts`,
 * `apps/web/src/lib/teams/github-repository-picker-constants.ts`, and the
 * picker page type in `apps/web/src/lib/teams/github-repository-picker-service.ts`
 * (each re-exports them).
 */

import { z } from 'zod';
import type {
  OrgProjectDetail,
  OrgProjectRepositoryVisibility,
} from '../org-projects';
import { settingsDtoSchema } from './operation-definition';

/** Browser-safe bound shared by the repository picker and its API route. */
export const GITHUB_REPOSITORY_QUERY_MAX_LENGTH = 100;

/**
 * One repository the organization's GitHub App installation can access.
 * Structurally equal to `GitHubInstallationRepository` in the server-only
 * `apps/web/src/lib/github/app-client.ts`.
 */
export interface OrganizationGitHubRepository {
  /** Immutable GitHub repository id; the identity Canopy stores. */
  id: number;
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  htmlUrl: string;
  /**
   * Display metadata (CAN-3489), present only when GitHub's payload carries
   * the field: `null` when it is empty or malformed.
   */
  description?: string | null;
  visibility?: OrgProjectRepositoryVisibility;
  /** Last push (or, before any push, last update) as ISO 8601. */
  updatedAt?: string | null;
}

export type GitHubRepositoryPickerItem = OrganizationGitHubRepository;

export interface GitHubRepositoryPickerPage {
  repositories: GitHubRepositoryPickerItem[];
  repositorySelection: 'all' | 'selected' | null;
  /** Opaque cursor for the next page, or `null` on the last page. */
  nextCursor: string | null;
}

/*
 * Wire shapes for the admin Repositories list on the organization Projects tab
 * (CAN-3414): every repository the organization's GitHub App installation can
 * access, whether an administrator hid it from seeding, and the project it
 * already has.
 */

/** The live (not deleted) organization project a repository already has. */
export interface OrganizationRepositoryProject {
  /** Project external id. */
  id: string;
  name: string;
  state: 'ACTIVE' | 'ARCHIVED';
  /** Created by GitHub App seeding rather than by an administrator. */
  seeded: boolean;
}

export interface OrganizationRepository extends OrganizationGitHubRepository {
  /** An administrator hid it: seeding skips it. */
  hidden: boolean;
  project: OrganizationRepositoryProject | null;
}

export interface OrganizationRepositoryPage {
  repositories: OrganizationRepository[];
  repositorySelection: 'all' | 'selected' | null;
  /** Opaque cursor for the next page, or `null` on the last page. */
  nextCursor: string | null;
}

/** Counts from one "Refresh from GitHub" seeding pass. */
export interface OrganizationRepositoriesRefreshResult {
  /** New projects. */
  added: number;
  /** Repositories skipped because an administrator hid them. */
  skippedHidden: number;
  /** Repositories that already have a project. */
  skippedExisting: number;
  /** Repositories whose project could not be written; the next refresh retries them. */
  failed: number;
}

export interface SetOrganizationRepositoryHiddenRequest {
  hidden: boolean;
  /** Display data kept with the hidden record; the id is the identity. */
  owner?: string;
  name?: string;
}

export interface SetOrganizationRepositoryHiddenResult {
  providerRepoId: string;
  hidden: boolean;
  /** False when the repository was already in the requested state. */
  changed: boolean;
  /** The seeded project this change archived or restored, if any. */
  project: OrgProjectDetail | null;
}

/** `POST /api/account/teams/[orgId]/github/connect` body. */
export interface OrganizationGitHubConnectResponse {
  installUrl: string;
}

/* Structural checks mirroring the guards in `components/team/team-api.ts`. */

const repositorySelectionSchema = z.enum(['all', 'selected']).nullable();

export const organizationGitHubRepositoryShape = z.looseObject({
  id: z.number(),
  fullName: z.string(),
  owner: z.string(),
  name: z.string(),
  defaultBranch: z.string(),
  private: z.boolean(),
  archived: z.boolean(),
  htmlUrl: z.string(),
});

export const gitHubRepositoryPickerPageSchema =
  settingsDtoSchema<GitHubRepositoryPickerPage>(
    z.looseObject({
      repositories: z.array(organizationGitHubRepositoryShape),
      nextCursor: z.string().nullable(),
      repositorySelection: repositorySelectionSchema,
    }),
  );

export const organizationRepositoryPageSchema =
  settingsDtoSchema<OrganizationRepositoryPage>(
    z.looseObject({
      repositories: z.array(
        organizationGitHubRepositoryShape.extend({
          hidden: z.boolean(),
          project: z
            .looseObject({
              id: z.string(),
              name: z.string(),
              state: z.enum(['ACTIVE', 'ARCHIVED']),
              seeded: z.boolean(),
            })
            .nullable(),
        }),
      ),
      nextCursor: z.string().nullable(),
      repositorySelection: repositorySelectionSchema,
    }),
  );

export const organizationRepositoriesRefreshResultSchema =
  settingsDtoSchema<OrganizationRepositoriesRefreshResult>(
    z.looseObject({
      added: z.number(),
      skippedHidden: z.number(),
      skippedExisting: z.number(),
      failed: z.number(),
    }),
  );

export const organizationGitHubConnectResponseSchema =
  settingsDtoSchema<OrganizationGitHubConnectResponse>(
    z.looseObject({ installUrl: z.string() }),
  );
