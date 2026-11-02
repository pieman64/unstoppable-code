import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type ApprovalRule,
  type ApprovalsFile,
} from '@canopy/desktop-shared/types';
import {
  isApprovalMode,
  normalizeApprovalRules,
} from '@canopy/desktop-shared/lib/approval-engine';
import { isStorageOutcomeUnknownError } from '@canopy/core-runtime/storage';
import {
  createDirectoryDurably,
  writeFileAtomically,
  type AdmittedWriterTarget,
} from './atomic-file';
import { getCanopyDataDir } from '@canopy/desktop-shared/canopy-paths';
import { getChatWorkspaceRootDir } from './paths';
import { isRecord } from './type-guards';
import {
  getWorkspaceApprovalRulesRevision,
  markWorkspaceApprovalRulesChanged,
  markWorkspaceFileWriteNarrowing,
  narrowsFileWriteRules,
  trackWorkspaceApprovalRulesSave,
} from '../approvals/rule-revisions';
import { logMainProcessError } from './main-process-logging';

const EMPTY_APPROVALS_FILE: ApprovalsFile = { version: 1, rules: [] };
const UNREADABLE_APPROVALS_FILE: ApprovalsFile = {
  version: 1,
  rules: [],
  defaultMode: 'ask',
};
const workspaceMutationTails = new Map<string, Promise<void>>();
const workspaceWritesInFlight = new Map<string, Set<Promise<boolean>>>();
/**
 * Workspaces whose installed approvals lost their folder flush, with the deny
 * rules of the last confirmed file and of every unconfirmed file since: any
 * of them may survive a crash. Their reads fail closed but keep those denies
 * until a later write is confirmed. Process-local: after a restart the file
 * on disk, which the user approved, is authoritative.
 */
const unconfirmedWorkspaceDenies = new Map<string, readonly ApprovalRule[]>();
const WORKSPACE_APPROVALS_WRITER: AdmittedWriterTarget = {
  namespace: 'workspace_approvals',
  writer: 'electron_main',
  module: 'main/lib/approvals-persistence',
};

export interface WorkspaceApprovalsReadResult {
  file: ApprovalsFile;
  status: 'ok' | 'missing' | 'unreadable';
}

async function serializeWorkspaceMutation<T>(
  workspaceId: string,
  mutate: () => Promise<T>,
): Promise<T> {
  const previous = workspaceMutationTails.get(workspaceId) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent;
  });
  workspaceMutationTails.set(workspaceId, current);
  await previous.catch(() => undefined);
  try {
    return await mutate();
  } finally {
    release();
    if (workspaceMutationTails.get(workspaceId) === current) {
      workspaceMutationTails.delete(workspaceId);
    }
  }
}

export function getWorkspaceApprovalsFilePath(workspaceId: string): string {
  return join(getChatWorkspaceRootDir(workspaceId), 'approvals.json');
}

function normalizeApprovalsFile(value: unknown): ApprovalsFile {
  if (!isRecord(value)) {
    return { version: 1, rules: [] };
  }
  const rules = normalizeApprovalRules(value.rules);
  const defaultMode = isApprovalMode(value.defaultMode)
    ? value.defaultMode
    : undefined;
  return {
    version: 1,
    rules,
    ...(defaultMode !== undefined ? { defaultMode } : {}),
  };
}

function parseApprovalsFile(value: unknown): ApprovalsFile {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error('Malformed approvals.json');
  }
  const persistedRules = value.rules;
  if (!Array.isArray(persistedRules)) {
    throw new Error('Malformed approvals.json');
  }
  const rules = normalizeApprovalRules(persistedRules);
  const everyRuleIsStrictlyValid =
    rules.length === persistedRules.length &&
    rules.every((rule, index) => {
      const persistedRule: unknown = persistedRules[index];
      return (
        isRecord(persistedRule) &&
        persistedRule.id === rule.id &&
        persistedRule.createdAt === rule.createdAt &&
        persistedRule.origin === rule.origin
      );
    });
  if (!everyRuleIsStrictlyValid) {
    throw new Error('Malformed approval rule in approvals.json');
  }
  if (
    Object.prototype.hasOwnProperty.call(value, 'defaultMode') &&
    !isApprovalMode(value.defaultMode)
  ) {
    throw new Error('Malformed defaultMode in approvals.json');
  }
  return {
    version: 1,
    rules,
    ...(isApprovalMode(value.defaultMode)
      ? { defaultMode: value.defaultMode }
      : {}),
  };
}

/**
 * The file on disk, confirmed or not. Mutations build on it, so a confirmed
 * write of it is what lifts the fail-closed projection.
 */
async function readWorkspaceApprovalsFile(
  workspaceId: string,
): Promise<WorkspaceApprovalsReadResult> {
  const filePath = getWorkspaceApprovalsFilePath(workspaceId);
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return { file: parseApprovalsFile(parsed), status: 'ok' };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { file: EMPTY_APPROVALS_FILE, status: 'missing' };
    }
    logMainProcessError(
      `Ignoring unreadable approval configuration for project ${workspaceId}`,
      error,
    );
    return { file: UNREADABLE_APPROVALS_FILE, status: 'unreadable' };
  }
}

/**
 * The approvals a decision may apply. A read overlapping a write waits for
 * its outcome, so it never applies a file whose save is still unconfirmed.
 */
export async function readWorkspaceApprovalsResult(
  workspaceId: string,
): Promise<WorkspaceApprovalsReadResult> {
  for (;;) {
    const inFlight = workspaceWritesInFlight.get(workspaceId);
    if (inFlight) {
      await Promise.all(inFlight);
      continue;
    }
    const revision = getWorkspaceApprovalRulesRevision(workspaceId);
    const result = await readWorkspaceApprovalsFile(workspaceId);
    if (
      workspaceWritesInFlight.has(workspaceId) ||
      getWorkspaceApprovalRulesRevision(workspaceId) !== revision
    ) {
      continue;
    }
    const retainedDenies = unconfirmedWorkspaceDenies.get(workspaceId);
    return retainedDenies === undefined
      ? result
      : {
          file: {
            ...UNREADABLE_APPROVALS_FILE,
            rules: unionDenies(retainedDenies, result.file.rules),
          },
          status: 'unreadable',
        };
  }
}

function unionDenies(
  ...ruleSets: ReadonlyArray<readonly ApprovalRule[]>
): ApprovalRule[] {
  const denies = new Map<string, ApprovalRule>();
  for (const rule of ruleSets.flat()) {
    if (rule.behavior === 'deny') denies.set(JSON.stringify(rule), rule);
  }
  return Array.from(denies.values());
}

export async function readWorkspaceApprovals(
  workspaceId: string,
): Promise<ApprovalsFile> {
  return (await readWorkspaceApprovalsResult(workspaceId)).file;
}

/**
 * Resolves true only once the file, its folder and any folder it created are
 * flushed. Any failure resolves false. An installed write whose folder flush
 * failed (`StorageOutcomeUnknownError`) is visible on disk, so its workspace
 * reads fail closed, keeping every deny either version holds, until a later
 * write is confirmed; CAN-4709 owns any rollback.
 */
export async function writeWorkspaceApprovals(
  workspaceId: string,
  file: unknown,
): Promise<boolean> {
  // Serialized like the mutations, so the file it replaces is still on disk.
  return serializeWorkspaceMutation(workspaceId, () =>
    writeWorkspaceApprovalsOver(workspaceId, file, undefined),
  );
}

/** `previous` is the file the write replaces; undefined reads it first. */
async function writeWorkspaceApprovalsOver(
  workspaceId: string,
  file: unknown,
  previous: ApprovalsFile | undefined,
): Promise<boolean> {
  const write = trackWorkspaceApprovalRulesSave(
    workspaceId,
    installWorkspaceApprovals(workspaceId, file, previous),
  );
  const inFlight = workspaceWritesInFlight.get(workspaceId) ?? new Set();
  inFlight.add(write);
  workspaceWritesInFlight.set(workspaceId, inFlight);
  try {
    return await write;
  } finally {
    inFlight.delete(write);
    if (inFlight.size === 0) workspaceWritesInFlight.delete(workspaceId);
  }
}

async function installWorkspaceApprovals(
  workspaceId: string,
  file: unknown,
  previous: ApprovalsFile | undefined,
): Promise<boolean> {
  let possibleRules: ApprovalRule[] = [];
  let releaseNarrowing: (() => void) | undefined;
  try {
    const payload = normalizeApprovalsFile(file);
    // While confirmed, the replaced file is the last confirmed one; an
    // unreadable one contributes no denies.
    const replaced = unconfirmedWorkspaceDenies.has(workspaceId)
      ? undefined
      : (previous ?? (await readWorkspaceApprovalsFile(workspaceId)).file);
    possibleRules = [...(replaced?.rules ?? []), ...payload.rules];
    if (narrowsFileWriteRules(replaced?.rules, payload.rules))
      releaseNarrowing = markWorkspaceFileWriteNarrowing(workspaceId);
    const filePath = getWorkspaceApprovalsFilePath(workspaceId);
    await createDirectoryDurably(dirname(filePath), {
      dataRoot: getCanopyDataDir(),
    });
    await writeFileAtomically(filePath, JSON.stringify(payload, null, 2), {
      encoding: 'utf8',
      durable: true,
      admittedWriter: WORKSPACE_APPROVALS_WRITER,
    });
    unconfirmedWorkspaceDenies.delete(workspaceId);
    markWorkspaceApprovalRulesChanged(workspaceId);
    return true;
  } catch (error) {
    if (isStorageOutcomeUnknownError(error)) {
      unconfirmedWorkspaceDenies.set(
        workspaceId,
        unionDenies(
          unconfirmedWorkspaceDenies.get(workspaceId) ?? [],
          possibleRules,
        ),
      );
      markWorkspaceApprovalRulesChanged(workspaceId);
      logMainProcessError(
        `Asking for every action in project ${workspaceId} until its approvals save is confirmed`,
        error,
      );
    }
    return false;
  } finally {
    releaseNarrowing?.();
  }
}

export async function addWorkspaceApprovalRule(
  workspaceId: string,
  rule: ApprovalRule,
): Promise<ApprovalsFile> {
  return serializeWorkspaceMutation(workspaceId, async () => {
    const existingResult = await readWorkspaceApprovalsFile(workspaceId);
    if (existingResult.status === 'unreadable') {
      throw new Error(
        `Refusing to overwrite unreadable approvals.json for project ${workspaceId}`,
      );
    }
    const existing = existingResult.file;
    const updated: ApprovalsFile = {
      ...existing,
      rules: [...existing.rules, rule],
    };
    if (!(await writeWorkspaceApprovalsOver(workspaceId, updated, existing))) {
      throw new Error('Failed to persist project approval rule');
    }
    return updated;
  });
}

export async function removeWorkspaceApprovalRule(
  workspaceId: string,
  ruleId: string,
): Promise<ApprovalsFile> {
  return serializeWorkspaceMutation(workspaceId, async () => {
    const existingResult = await readWorkspaceApprovalsFile(workspaceId);
    if (existingResult.status === 'unreadable') {
      throw new Error(
        `Refusing to overwrite unreadable approvals.json for project ${workspaceId}`,
      );
    }
    const existing = existingResult.file;
    const updated: ApprovalsFile = {
      ...existing,
      rules: existing.rules.filter((rule) => rule.id !== ruleId),
    };
    if (!(await writeWorkspaceApprovalsOver(workspaceId, updated, existing))) {
      throw new Error('Failed to persist project approval rule removal');
    }
    return updated;
  });
}
