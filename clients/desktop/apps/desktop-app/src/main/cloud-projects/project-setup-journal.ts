import { isAbsolute, join, normalize } from 'node:path';
import { isCanopyJsonId } from '@canopy/protocol/canopy-json';
import {
  CloudProjectEventCursorSchema,
  CloudProjectRepositorySchema,
  MemoryProjectIdSchema,
  MemoryUuidSchema,
  RepoFingerprintSchema,
} from '@canopy/protocol/memory-sync';
import { z } from 'zod';
import {
  isDestinationEntry,
  normalizeDestinationRoot,
} from './destination-root';

/*
 * The write-ahead journal of one cloud project setup on this device
 * (CAN-5192, design section 23). It follows the organization setup journal's
 * state machine (docs/org-project-materialization.md): every mutation is
 * preceded by an atomic journal replacement, and a run the app exits during
 * is resumed or retired from the phase it recorded, never from a guess about
 * what is on disk. Before `promoted` nothing outside the journal's own
 * staging directory exists, so those phases are retired; from `promoted` on
 * the run finishes without cloning again.
 */

export const PROJECT_SETUP_PHASES = [
  'claimed',
  'cloning',
  'validated',
  'promoted',
  'bound',
  'completing',
  'done',
  'failed',
  'cancelled',
] as const;
export type ProjectSetupPhase = (typeof PROJECT_SETUP_PHASES)[number];

/** Phases a run the app exited during resumes from. */
export const RESUMABLE_PHASES: readonly ProjectSetupPhase[] = [
  'promoted',
  'bound',
  'completing',
];

const RelativePathSchema = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (value): boolean =>
      !isAbsolute(value) &&
      normalize(value) === value &&
      value.split(/[\\/]/).every((part) => part !== '' && part !== '..'),
    'Not a contained relative path',
  );

const LocalRepoIdSchema = z.string().max(128).refine(isCanopyJsonId);

export const ProjectSetupRepositorySchema = z.strictObject({
  repositoryId: MemoryUuidSchema,
  fingerprint: RepoFingerprintSchema,
  directoryName: CloudProjectRepositorySchema.shape.directoryName,
  /** The local repository's id when it is nested: a canopy.json id. */
  sourceKey: z.string().max(128).refine(isCanopyJsonId).nullable(),
  /**
   * The nested repository's ID in the workspace, chosen once before the
   * claim: its `sourceKey`, else one made from its directory name. Null for
   * the root or a single repository.
   */
  localRepoId: LocalRepoIdSchema.nullable(),
  /** Its checkout under the project folder; null for the root or a single repository. */
  relativePath: RelativePathSchema.nullable(),
  cloned: z.boolean(),
});
export type ProjectSetupRepository = z.output<
  typeof ProjectSetupRepositorySchema
>;

/** One claim of a project's instance: what a binding's fence names. */
export const SetupClaimSchema = z.strictObject({
  projectId: MemoryProjectIdSchema,
  instanceId: MemoryUuidSchema,
  fencingGeneration: z.int().min(0),
});
export type SetupClaim = z.output<typeof SetupClaimSchema>;

const LocalWorkspaceIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);

export const SetupCreationSchema = z.strictObject({
  path: z.string().min(1),
  localWorkspaceId: LocalWorkspaceIdSchema,
  name: z.string().min(1).max(256),
  repositories: z
    .array(
      z.strictObject({
        id: LocalRepoIdSchema,
        name: z.string().min(1).max(256),
        repoPath: z.string().min(1),
      }),
    )
    .max(100),
  suppressedRepoIds: z.array(z.string().min(1).max(128)).max(100),
  idempotencyKey: z.string().min(1).max(256),
});
export type SetupCreation = z.output<typeof SetupCreationSchema>;

export const ProjectSetupJournalSchema = z
  .strictObject({
    version: z.literal(1),
    journalId: MemoryUuidSchema,
    accountId: MemoryUuidSchema,
    deviceId: MemoryUuidSchema,
    installationGeneration: z.int().min(0),
    projectId: MemoryProjectIdSchema,
    projectName: z.string().min(1).max(256),
    topology: z.enum(['single_repo', 'multi_repo']),
    repoListSource: z.enum(['canopy_json', 'cloud_manifest']),
    manifestRevision: z.int().min(1),
    instanceId: MemoryUuidSchema,
    operationId: MemoryUuidSchema,
    fencingGeneration: z.int().min(0),
    /** The feed position the claim answered with; older servers omit it. */
    eventsCursor: CloudProjectEventCursorSchema.optional(),
    /**
     * How far the setup has read its project's feed for this claim, from the
     * first event: the next run reads on from here, so a feed longer than
     * one read is never read from its start again. A claim it does not name
     * (another project, instance or generation) reads from the start.
     */
    claimFeed: z
      .strictObject({
        projectId: MemoryProjectIdSchema,
        instanceId: MemoryUuidSchema,
        fencingGeneration: z.int().min(0),
        cursor: CloudProjectEventCursorSchema,
        ended: z.boolean(),
        redirect: z
          .strictObject({
            kind: z.enum(['merged', 'moved']),
            projectId: MemoryProjectIdSchema,
          })
          .nullable(),
      })
      .optional(),
    /**
     * The claim a redirect moved this setup away from, while the workspace's
     * `cloudBinding` may still name it: set with the move (before the project
     * it led to is claimed) and cleared once the binding names that project.
     * A journal with it is never done before that rebind.
     */
    rebinding: SetupClaimSchema.optional(),
    /**
     * The claim the workspace's `cloudBinding` was last written with by this
     * setup. A reclaim journals its new claim before it moves the binding,
     * so the two differ until that write lands. Older journals omit it.
     */
    bound: SetupClaimSchema.optional(),
    /**
     * The ids this setup put in the workspace's `suppressedRepoIds` (a
     * declined repository's `sourceKey`, or its repository ID): what a later
     * write of the declined list replaces, leaving the user's own alone.
     */
    suppressed: z.array(z.string().min(1).max(128)).max(100).optional(),
    /**
     * The multi-repository workspace creation exactly as first sent, before
     * it was sent: a resume sends it again unchanged under its key, which a
     * receipt answers only for the same details. Declined repositories that
     * change later reach the workspace through the binding write. Older
     * journals omit it.
     */
    creation: SetupCreationSchema.optional(),
    attemptNonce: MemoryUuidSchema,
    idempotencyKey: z.string().regex(/^[0-9a-f]{64}$/),
    localWorkspaceId: LocalWorkspaceIdSchema,
    destinationRoot: z.string().min(1),
    finalPath: z.string().min(1),
    stagingPath: z.string().min(1),
    /**
     * `cloned`: the manifest's root repository is the project folder;
     * `generated`: a local root repository holds a remote-less project's
     * repositories; `none`: a single repository is the project folder.
     */
    root: z.enum(['none', 'cloned', 'generated']),
    repositories: z.array(ProjectSetupRepositorySchema).min(1).max(100),
    /**
     * Manifest repositories the user did not pick, declined on this device.
     * The fingerprint finds each again in the project a merge leads to.
     */
    declined: z
      .array(
        z.strictObject({
          repositoryId: MemoryUuidSchema,
          sourceKey: z.string().min(1).max(128).nullable(),
          fingerprint: RepoFingerprintSchema.optional(),
        }),
      )
      .max(100),
    phase: z.enum(PROJECT_SETUP_PHASES),
    errorCode: z.string().min(1).max(64).optional(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine((journal, context): void => {
    const root = journal.destinationRoot;
    if (!isAbsolute(root) || normalizeDestinationRoot(root) !== root)
      context.addIssue({ code: 'custom', message: 'Invalid destination' });
    if (
      journal.stagingPath !== join(root, `.canopy-setup-${journal.journalId}`)
    )
      context.addIssue({ code: 'custom', message: 'Unexpected staging path' });
    if (!isDestinationEntry(root, journal.finalPath))
      context.addIssue({ code: 'custom', message: 'Escaping final path' });
    const nested = journal.repositories.filter(
      (repository) => repository.relativePath !== null,
    );
    const expectedNested =
      journal.root === 'none'
        ? 0
        : journal.repositories.length - (journal.root === 'cloned' ? 1 : 0);
    if (
      nested.length !== expectedNested ||
      (journal.root === 'none' && journal.repositories.length !== 1)
    )
      context.addIssue({ code: 'custom', message: 'Inconsistent layout' });
    const localRepoIds = nested.map((repository) => repository.localRepoId);
    if (
      journal.repositories.some(
        (repository) =>
          (repository.relativePath === null) !==
          (repository.localRepoId === null),
      ) ||
      new Set(localRepoIds).size !== localRepoIds.length
    )
      context.addIssue({ code: 'custom', message: 'Invalid repository IDs' });
    const creation = journal.creation;
    if (
      creation !== undefined &&
      (journal.root === 'none' ||
        creation.path !== journal.finalPath ||
        creation.localWorkspaceId !== journal.localWorkspaceId ||
        !creation.repositories.every((entry) =>
          nested.some(
            (repository) =>
              repositoryPath(journal, repository, 'final') === entry.repoPath &&
              repository.localRepoId === entry.id,
          ),
        ))
    )
      context.addIssue({ code: 'custom', message: 'Unexpected creation' });
  });
export type ProjectSetupJournal = z.output<typeof ProjectSetupJournalSchema>;

/** A journal read from disk, or null when it cannot authorize anything. */
export function parseProjectSetupJournal(
  value: unknown,
): ProjectSetupJournal | null {
  const parsed = ProjectSetupJournalSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Where a repository of the journal is checked out. */
export function repositoryPath(
  journal: Pick<ProjectSetupJournal, 'finalPath' | 'stagingPath'>,
  repository: Pick<ProjectSetupRepository, 'relativePath'>,
  stage: 'staging' | 'final',
): string {
  const base = stage === 'staging' ? journal.stagingPath : journal.finalPath;
  return repository.relativePath === null
    ? base
    : join(base, repository.relativePath);
}
