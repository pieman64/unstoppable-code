import type {
  CreateSharedMultiRepoParams,
  PrepareSharedMultiRepoParams,
  PreparedSharedMultiRepo,
  SharedMultiRepoCreationStatus,
  OrgProjectCatalogSnapshot,
  OrgProjectSetupProgress,
} from '@canopy/protocol/org-projects';

/** Operations run on the selected execution host; queries never resume work. */
export interface SharedMultiRepoClient {
  /** Explicit mutation: replay only the immutable request retained on this host. */
  readonly resume?: (
    creationKey: string,
  ) => Promise<SharedMultiRepoCreationStatus>;
  readonly startSetup?: (
    organizationId: string,
    projectId: string,
  ) => Promise<OrgProjectSetupProgress>;
  readonly setupProgress?: (
    organizationId: string,
    projectId: string,
  ) => Promise<OrgProjectSetupProgress | null>;

  prepare(
    params: PrepareSharedMultiRepoParams,
  ): Promise<PreparedSharedMultiRepo>;
  create(
    params: CreateSharedMultiRepoParams,
  ): Promise<SharedMultiRepoCreationStatus>;
  getCreation(
    creationKey: string,
  ): Promise<SharedMultiRepoCreationStatus | null>;
  listCreations(this: void): Promise<readonly SharedMultiRepoCreationStatus[]>;
  catalog(organizationId: string): Promise<
    OrgProjectCatalogSnapshot & {
      readonly stale?: boolean;
      readonly error?: unknown;
    }
  >;
  cancelSetup(
    this: void,
    organizationId: string,
    projectId: string,
  ): Promise<void>;
}
