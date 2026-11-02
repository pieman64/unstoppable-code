/**
 * Attempt journal for installing a fork's capability package (CAN-4655,
 * plan §6 "Installation", compensation paragraph).
 *
 * The package install creates objects in several independent stores (local
 * skills, Agents, user pipelines, automations and the destination's default
 * selections). No single store transaction covers them, so each attempt
 * records what it is about to create *before* creating it, and what it
 * created once it exists. A crash mid-attempt therefore leaves a journal the
 * next attempt can finish (the install ledger already names the package) or
 * compensate (remove only what this attempt created and nobody changed since).
 *
 * Journals are app metadata under the data directory, written by atomic
 * rename, one file per attempt key. They never live inside a checkout.
 *
 * Retention: a journal is only needed while it can still drive recovery or
 * names something a failed attempt left behind. A `completed` (the ledger row
 * is the record) or `rolled-back` (nothing is left) journal is deleted as soon
 * as it is final. A `rollback-incomplete` journal names residual items, so it
 * is kept for {@link FORK_CAPABILITY_INSTALL_RESIDUAL_RETENTION_MS} and then
 * pruned by recovery. A later attempt for the same key first moves it to
 * {@link forkCapabilityInstallResidualJournalKey}, so reusing the key never
 * erases that record.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import type { SharedContainerType } from '@canopy/protocol/shared-containers';
import { getSharedContainerCapabilityInstallJournalDir } from '../../lib/paths';

export const FORK_CAPABILITY_INSTALL_JOURNAL_VERSION = 1;

/** How long a journal that names residual items is kept for diagnosis. */
export const FORK_CAPABILITY_INSTALL_RESIDUAL_RETENTION_MS =
  30 * 24 * 60 * 60 * 1000;

export type ForkCapabilityInstallStatus =
  /** The attempt is (or was, before a crash) creating objects. */
  | 'installing'
  /** The ledger names the package; every created object is kept. */
  | 'completed'
  /** Every object this attempt created was removed or already gone. */
  | 'rolled-back'
  /** Compensation finished, but some objects remain; see `residual`. */
  | 'rollback-incomplete';

export interface ForkCapabilityInstallSkillSelection {
  sourceId: string;
  skillName: string;
}

/** A file the materializer writes into a skill folder. */
export interface ForkCapabilityInstallSkillFile {
  path: string;
  sha256: string;
}

export interface ForkCapabilityInstallJournal {
  version: typeof FORK_CAPABILITY_INSTALL_JOURNAL_VERSION;
  key: string;
  /**
   * The attempt that wrote this journal. Every attempt for one key reuses the
   * file, so recovery of one attempt never writes over another's journal.
   * Absent only in journals written before attempts carried an id.
   */
  attemptId?: string;
  /** `shared-container` install-ledger owner id for the destination. */
  ownerLocalId: string;
  containerId: string;
  revisionId: string;
  packageDigest: string;
  destination: {
    projectId: string;
    worktreeId: string;
    containerType: SharedContainerType;
  };
  status: ForkCapabilityInstallStatus;
  startedAt: string;
  updatedAt: string;
  /**
   * Local skill folders the materializer bound, by manifest resource, named
   * once the folder is reserved and before anything is written into it.
   * `created` is true only when this attempt made the folder; a reused folder
   * was already the user's and is never removed. `files` is the packaged tree
   * written into it, the content compensation checks before removing.
   */
  skills: Array<{
    resourceId: string;
    localName: string;
    created?: boolean;
    files?: ForkCapabilityInstallSkillFile[];
  }>;
  /** `localId` is absent between the intent write and the create. */
  agents: Array<{
    resourceId: string;
    name: string;
    localId?: string;
    contentHash?: string;
  }>;
  /** The id is chosen before the create, so it is always present. */
  pipelines: Array<{
    resourceId: string;
    localId: string;
    contentHash: string;
    name: string;
  }>;
  automations: Array<{
    resourceId: string;
    name: string;
    localId?: string;
    createdAt?: string;
  }>;
  /** Selections this attempt added to the destination's defaults. */
  selections?: {
    workspaceId: string;
    added: ForkCapabilityInstallSkillSelection[];
  };
  /** Informational requirement ids from the installed package; never enabled. */
  environmentRequirements: Array<{ id: string; kind: string }>;
  /** What compensation could not remove, named for the user. */
  residual?: string[];
}

/**
 * One attempt per destination, revision and package digest: a retry of the
 * same fork reuses the key and therefore its journal.
 */
export function forkCapabilityInstallJournalKey(
  ownerLocalId: string,
  packageDigest: string,
): string {
  return createHash('sha256')
    .update(`${ownerLocalId}\0${packageDigest}`)
    .digest('hex');
}

/**
 * Where a `rollback-incomplete` journal is kept once a new attempt reuses its
 * key: distinct per earlier attempt, and never a key an attempt writes.
 */
export function forkCapabilityInstallResidualJournalKey(
  journal: Pick<
    ForkCapabilityInstallJournal,
    'key' | 'attemptId' | 'updatedAt'
  >,
): string {
  const attempt = createHash('sha256')
    .update(`${journal.attemptId ?? ''}\0${journal.updatedAt}`)
    .digest('hex')
    .slice(0, 32);
  return `${journal.key}-residual-${attempt}`;
}

function journalPath(key: string): string {
  return path.join(
    getSharedContainerCapabilityInstallJournalDir(),
    `${key}.json`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isStatus(value: unknown): value is ForkCapabilityInstallStatus {
  return (
    value === 'installing' ||
    value === 'completed' ||
    value === 'rolled-back' ||
    value === 'rollback-incomplete'
  );
}

function isContainerType(value: unknown): value is SharedContainerType {
  return value === 'CODE_WORKTREE' || value === 'COWORK_WORK_ENTRY';
}

function recordsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Strict enough to drive compensation; anything else is disposable. */
export function parseForkCapabilityInstallJournal(
  value: unknown,
): ForkCapabilityInstallJournal | null {
  if (
    !isRecord(value) ||
    value.version !== FORK_CAPABILITY_INSTALL_JOURNAL_VERSION ||
    !isString(value.key) ||
    !isString(value.ownerLocalId) ||
    !isString(value.containerId) ||
    !isString(value.revisionId) ||
    !isString(value.packageDigest) ||
    !isRecord(value.destination) ||
    !isString(value.destination.projectId) ||
    !isString(value.destination.worktreeId) ||
    !isContainerType(value.destination.containerType) ||
    !isStatus(value.status) ||
    !isString(value.startedAt) ||
    !isString(value.updatedAt)
  ) {
    return null;
  }
  const selections = isRecord(value.selections) ? value.selections : undefined;
  return {
    version: FORK_CAPABILITY_INSTALL_JOURNAL_VERSION,
    key: value.key,
    ...(isString(value.attemptId) ? { attemptId: value.attemptId } : {}),
    ownerLocalId: value.ownerLocalId,
    containerId: value.containerId,
    revisionId: value.revisionId,
    packageDigest: value.packageDigest,
    destination: {
      projectId: value.destination.projectId,
      worktreeId: value.destination.worktreeId,
      containerType: value.destination.containerType,
    },
    status: value.status,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    skills: recordsOf(value.skills).flatMap((skill) =>
      isString(skill.resourceId) && isString(skill.localName)
        ? [
            {
              resourceId: skill.resourceId,
              localName: skill.localName,
              // Anything but an explicit `true` keeps the folder.
              ...(skill.created === true || skill.created === false
                ? { created: skill.created }
                : {}),
              ...(Array.isArray(skill.files)
                ? {
                    files: recordsOf(skill.files).flatMap((file) =>
                      isString(file.path) && isString(file.sha256)
                        ? [{ path: file.path, sha256: file.sha256 }]
                        : [],
                    ),
                  }
                : {}),
            },
          ]
        : [],
    ),
    agents: recordsOf(value.agents).flatMap((agent) =>
      isString(agent.resourceId) && isString(agent.name)
        ? [
            {
              resourceId: agent.resourceId,
              name: agent.name,
              ...(isString(agent.localId) ? { localId: agent.localId } : {}),
              ...(isString(agent.contentHash)
                ? { contentHash: agent.contentHash }
                : {}),
            },
          ]
        : [],
    ),
    pipelines: recordsOf(value.pipelines).flatMap((pipeline) =>
      isString(pipeline.resourceId) &&
      isString(pipeline.localId) &&
      isString(pipeline.contentHash) &&
      isString(pipeline.name)
        ? [
            {
              resourceId: pipeline.resourceId,
              localId: pipeline.localId,
              contentHash: pipeline.contentHash,
              name: pipeline.name,
            },
          ]
        : [],
    ),
    automations: recordsOf(value.automations).flatMap((automation) =>
      isString(automation.resourceId) && isString(automation.name)
        ? [
            {
              resourceId: automation.resourceId,
              name: automation.name,
              ...(isString(automation.localId)
                ? { localId: automation.localId }
                : {}),
              ...(isString(automation.createdAt)
                ? { createdAt: automation.createdAt }
                : {}),
            },
          ]
        : [],
    ),
    ...(selections && isString(selections.workspaceId)
      ? {
          selections: {
            workspaceId: selections.workspaceId,
            added: recordsOf(selections.added).flatMap((selection) =>
              isString(selection.sourceId) && isString(selection.skillName)
                ? [
                    {
                      sourceId: selection.sourceId,
                      skillName: selection.skillName,
                    },
                  ]
                : [],
            ),
          },
        }
      : {}),
    environmentRequirements: recordsOf(value.environmentRequirements).flatMap(
      (requirement) =>
        isString(requirement.id) && isString(requirement.kind)
          ? [{ id: requirement.id, kind: requirement.kind }]
          : [],
    ),
    ...(Array.isArray(value.residual)
      ? { residual: value.residual.filter(isString) }
      : {}),
  };
}

export async function readForkCapabilityInstallJournal(
  key: string,
): Promise<ForkCapabilityInstallJournal | null> {
  let raw: string;
  try {
    raw = await readFile(journalPath(key), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parseForkCapabilityInstallJournal(parsed);
  } catch {
    return null;
  }
}

/** Atomic replace: a reader sees the previous or the next journal, never half. */
export async function writeForkCapabilityInstallJournal(
  journal: ForkCapabilityInstallJournal,
): Promise<void> {
  const target = journalPath(journal.key);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(journal)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Remove a final journal. A journal that is already gone is not an error. */
export async function deleteForkCapabilityInstallJournal(
  key: string,
): Promise<void> {
  await rm(journalPath(key), { force: true });
}

/** Every readable journal; unreadable files are skipped, never trusted. */
export async function listForkCapabilityInstallJournals(): Promise<
  ForkCapabilityInstallJournal[]
> {
  let names: string[];
  try {
    names = await readdir(getSharedContainerCapabilityInstallJournalDir());
  } catch {
    return [];
  }
  const journals: ForkCapabilityInstallJournal[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const journal = await readForkCapabilityInstallJournal(
      name.slice(0, -'.json'.length),
    );
    if (journal) journals.push(journal);
  }
  return journals;
}
