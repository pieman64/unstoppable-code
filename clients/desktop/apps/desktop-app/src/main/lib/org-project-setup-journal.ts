import {
  isOrgProjectRepository,
  hasCompleteOrgProjectRepositories,
  type OrgProjectRepository,
} from '@canopy/protocol/org-projects';
import { basename, isAbsolute, join, dirname, normalize } from 'node:path';
import {
  normalizeWorkspaceOwner,
  normalizeWorkspaceOwnershipTransfer,
} from '@canopy/desktop-shared/lib/workspace-owner';
import type {
  WorkspaceOwnerBinding,
  WorkspaceOwnershipTransfer,
} from '@canopy/desktop-shared/types';

export type SetupPhase =
  | 'claimed'
  | 'cloning'
  | 'validated'
  | 'promoted'
  | 'bound'
  | 'completing'
  /**
   * The claim lapsed before completion landed (CAN-3129). The journal's
   * operation and fence are the latest claim this device holds; the next step
   * asks the server to reclaim exactly that claim, re-binds under the answer
   * and completes. Never detached: the instance is still this checkout's.
   */
  | 'reclaiming'
  | 'done'
  | 'failed'
  | 'cancelled';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface SetupJournalV1 {
  version: 1;
  /**
   * The journal's own identity: its file name and its staging directory are
   * derived from it. A reclaim replaces `operationId`, so nothing local may be
   * keyed by the server's operation. Journals written before this field read
   * with `journalId === operationId`, which is how they were named.
   */
  journalId: string;
  projectId: string;
  organizationId: string;
  instanceId: string;
  operationId: string;
  idempotencyKey: string;
  /** The per-attempt nonce the idempotency key was derived from. */
  attemptNonce: string;
  fencingGeneration: number;
  localWorkspaceId: string;
  destinationRoot: string;
  finalPath: string;
  stagingPath: string;
  phase: SetupPhase;
  errorCode?: string;
  updatedAt: string;
  /**
   * Present when this attempt converts the existing workspace
   * `localWorkspaceId` in place (CAN-3415) instead of cloning a new one. Its
   * `finalPath` is that workspace's checkout and nothing is staged. An
   * attempt that does not finish is rolled back to Personal, restoring the
   * conversion record the workspace had before.
   */
  conversion?: { previousOwnershipTransfer?: WorkspaceOwnershipTransfer };
  /** Existing checkout adoption: nothing at `finalPath` was created by setup. */
  adoption?: { createdRepo?: true };
}
export interface MultiRepoSetupRepository {
  repository: OrgProjectRepository;
  relativePath: string;
  validated: boolean;
}

/** Fresh setup only: a v2 journal cannot authorize adoption or conversion. */
export interface SetupJournalV2 extends Omit<
  SetupJournalV1,
  'version' | 'conversion' | 'adoption'
> {
  version: 2;
  accountId: string;
  deviceId: string;
  installationGeneration: number;
  definitionRevision: number;
  projectName: string;
  repositories: MultiRepoSetupRepository[];
  conversion?: never;
  adoption?: never;
}
export type SetupJournal = SetupJournalV1 | SetupJournalV2;

export function setupOwner(
  journal: Pick<
    SetupJournal,
    'organizationId' | 'projectId' | 'instanceId' | 'fencingGeneration'
  >,
): WorkspaceOwnerBinding {
  const owner = normalizeWorkspaceOwner({
    type: 'organization',
    organizationId: journal.organizationId,
    projectId: journal.projectId,
    instanceId: journal.instanceId,
    bindingGeneration: journal.fencingGeneration,
  });
  if (!owner) throw new Error('Invalid organization workspace binding');
  return owner;
}
export function isSetupPhase(value: unknown): value is SetupPhase {
  return [
    'claimed',
    'cloning',
    'validated',
    'promoted',
    'bound',
    'completing',
    'reclaiming',
    'done',
    'failed',
    'cancelled',
  ].some((phase) => phase === value);
}
/** Corrupt journals never authorize filesystem mutations. */
export function normalizeSetupJournal(value: unknown): SetupJournal | null {
  if (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    value.version === 2
  ) {
    if ('conversion' in value || 'adoption' in value) return null;
    const base = normalizeSetupJournalV1({ ...value, version: 1 });
    if (
      !base ||
      !('accountId' in value) ||
      typeof value.accountId !== 'string' ||
      !value.accountId ||
      !('deviceId' in value) ||
      typeof value.deviceId !== 'string' ||
      !UUID.test(value.deviceId) ||
      !('installationGeneration' in value) ||
      typeof value.installationGeneration !== 'number' ||
      !Number.isSafeInteger(value.installationGeneration) ||
      value.installationGeneration < 0 ||
      !('definitionRevision' in value) ||
      typeof value.definitionRevision !== 'number' ||
      !Number.isSafeInteger(value.definitionRevision) ||
      value.definitionRevision < 1 ||
      !('projectName' in value) ||
      typeof value.projectName !== 'string' ||
      !value.projectName.trim() ||
      !('repositories' in value) ||
      !Array.isArray(value.repositories) ||
      value.repositories.length < 1 ||
      value.repositories.length > 32
    )
      return null;
    const repositories: MultiRepoSetupRepository[] = [];
    const paths = new Set<string>();
    const identities = new Set<string>();
    const entries: unknown[] = value.repositories;
    for (const entry of entries) {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        !('repository' in entry) ||
        !isOrgProjectRepository(entry.repository) ||
        !('relativePath' in entry) ||
        typeof entry.relativePath !== 'string' ||
        !/^repos\/r[0-9]{2}-[a-z0-9_-]{1,64}$/.test(entry.relativePath) ||
        !('validated' in entry) ||
        typeof entry.validated !== 'boolean'
      )
        return null;
      const identity =
        `${entry.repository.host}/${entry.repository.providerRepoId ?? `${entry.repository.owner}/${entry.repository.name}`}`.toLowerCase();
      if (paths.has(entry.relativePath) || identities.has(identity))
        return null;
      paths.add(entry.relativePath);
      identities.add(identity);
      repositories.push({
        repository: entry.repository,
        relativePath: entry.relativePath,
        validated: entry.validated,
      });
    }
    if (
      !hasCompleteOrgProjectRepositories({
        repositories: repositories.map((entry) => entry.repository),
        repository: repositories[0]?.repository ?? null,
        repositoryCount: repositories.length,
        repositoriesComplete: true,
        materializationVersion: 1,
        revision: value.definitionRevision,
      })
    )
      return null;
    const { conversion, adoption, ...freshBase } = base;
    if (conversion || adoption) return null;
    return {
      ...freshBase,
      version: 2,
      accountId: value.accountId,
      deviceId: value.deviceId,
      installationGeneration: value.installationGeneration,
      definitionRevision: value.definitionRevision,
      projectName: value.projectName,
      repositories,
    };
  }
  return normalizeSetupJournalV1(value);
}

function normalizeSetupJournalV1(value: unknown): SetupJournalV1 | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const record: Record<string, unknown> = Object.fromEntries(
    Object.entries(value),
  );
  const {
    journalId: recordedJournalId,
    projectId,
    organizationId,
    instanceId,
    operationId,
    idempotencyKey,
    attemptNonce,
    fencingGeneration,
    localWorkspaceId,
    destinationRoot,
    finalPath,
    stagingPath,
    phase,
    updatedAt,
    errorCode,
    conversion,
    adoption,
  } = record;
  const conversionRecord: Record<string, unknown> | undefined =
    typeof conversion === 'object' &&
    conversion !== null &&
    !Array.isArray(conversion)
      ? Object.fromEntries(Object.entries(conversion))
      : undefined;
  const adoptionRecord: Record<string, unknown> | undefined =
    typeof adoption === 'object' &&
    adoption !== null &&
    !Array.isArray(adoption)
      ? Object.fromEntries(Object.entries(adoption))
      : undefined;
  const journalId =
    recordedJournalId === undefined ? operationId : recordedJournalId;
  if (
    record.version !== 1 ||
    typeof projectId !== 'string' ||
    typeof organizationId !== 'string' ||
    typeof instanceId !== 'string' ||
    typeof operationId !== 'string' ||
    !UUID.test(operationId) ||
    typeof journalId !== 'string' ||
    !UUID.test(journalId) ||
    typeof idempotencyKey !== 'string' ||
    !/^[0-9a-f]{64}$/.test(idempotencyKey) ||
    typeof attemptNonce !== 'string' ||
    !UUID.test(attemptNonce) ||
    typeof fencingGeneration !== 'number' ||
    !Number.isSafeInteger(fencingGeneration) ||
    fencingGeneration < 0 ||
    typeof localWorkspaceId !== 'string' ||
    !/^[a-zA-Z0-9_-]+$/.test(localWorkspaceId) ||
    typeof destinationRoot !== 'string' ||
    !isAbsolute(destinationRoot) ||
    typeof finalPath !== 'string' ||
    // `dirname` answers lexically, so `<root>/..` looks like a child of the
    // root while the filesystem resolves it to the root's parent. The checkout
    // has to be a real name inside the destination, not a way back out of it.
    finalPath !== normalize(finalPath) ||
    dirname(finalPath) !== destinationRoot ||
    basename(finalPath) === '.' ||
    basename(finalPath) === '..' ||
    typeof stagingPath !== 'string' ||
    stagingPath !== join(destinationRoot, `.canopy-setup-${journalId}`) ||
    finalPath === stagingPath ||
    !isSetupPhase(phase) ||
    typeof updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(updatedAt)) ||
    (errorCode !== undefined && typeof errorCode !== 'string') ||
    (conversion !== undefined && conversionRecord === undefined) ||
    (adoption !== undefined && adoptionRecord === undefined) ||
    (conversionRecord !== undefined && adoptionRecord !== undefined) ||
    (adoptionRecord?.createdRepo !== undefined &&
      adoptionRecord.createdRepo !== true)
  )
    return null;
  const previousOwnershipTransfer = normalizeWorkspaceOwnershipTransfer(
    conversionRecord?.previousOwnershipTransfer,
  );
  const journal: SetupJournalV1 = {
    version: 1,
    journalId,
    projectId,
    organizationId,
    instanceId,
    operationId,
    idempotencyKey,
    attemptNonce,
    fencingGeneration,
    localWorkspaceId,
    destinationRoot,
    finalPath,
    stagingPath,
    phase,
    updatedAt,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(conversionRecord === undefined
      ? {}
      : {
          conversion:
            previousOwnershipTransfer === undefined
              ? {}
              : { previousOwnershipTransfer },
        }),
    ...(adoptionRecord === undefined
      ? {}
      : {
          adoption:
            adoptionRecord.createdRepo === true ? { createdRepo: true } : {},
        }),
  };
  try {
    setupOwner(journal);
  } catch {
    return null;
  }
  return journal;
}

/**
 * QA lever for interrupting a setup at a known point (CAN-3129):
 *
 *   CANOPY_DEV_ORG_PROJECT_SETUP_PAUSE=completing:120 npm run dev
 *
 * holds every setup for that many seconds right after its journal records
 * that phase, before the mutation the phase announces. Packaged builds never
 * read it. Anything malformed is ignored.
 */
export function parseOrgProjectSetupPause(
  value: string | undefined,
): { phase: SetupPhase; ms: number } | null {
  const match = /^([a-z]+):(\d{1,4})$/.exec(value?.trim() ?? '');
  if (!match || !isSetupPhase(match[1])) return null;
  return { phase: match[1], ms: Number(match[2]) * 1000 };
}
