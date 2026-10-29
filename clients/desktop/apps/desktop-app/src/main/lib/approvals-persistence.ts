import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type ApprovalRule,
  type ApprovalsFile,
} from '@canopy/desktop-shared/types';
import {
  isApprovalMode,
  normalizeApprovalRules,
} from '@canopy/desktop-shared/lib/approval-engine';
import { getChatWorkspaceRootDir } from './paths';
import { isRecord } from './type-guards';
import { markWorkspaceApprovalRulesChanged } from '../approvals/rule-revisions';
import { logMainProcessError } from './main-process-logging';

const EMPTY_APPROVALS_FILE: ApprovalsFile = { version: 1, rules: [] };
const UNREADABLE_APPROVALS_FILE: ApprovalsFile = {
  version: 1,
  rules: [],
  defaultMode: 'ask',
};
const workspaceMutationTails = new Map<string, Promise<void>>();

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

export async function readWorkspaceApprovalsResult(
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

export async function readWorkspaceApprovals(
  workspaceId: string,
): Promise<ApprovalsFile> {
  return (await readWorkspaceApprovalsResult(workspaceId)).file;
}

export async function writeWorkspaceApprovals(
  workspaceId: string,
  file: unknown,
): Promise<boolean> {
  let tempPath: string | undefined;
  try {
    const filePath = getWorkspaceApprovalsFilePath(workspaceId);
    await mkdir(dirname(filePath), { recursive: true });
    const payload = normalizeApprovalsFile(file);
    tempPath = join(
      dirname(filePath),
      `.approvals-${process.pid}-${randomUUID()}.tmp`,
    );
    await writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8');
    await rename(tempPath, filePath);
    tempPath = undefined;
    markWorkspaceApprovalRulesChanged(workspaceId);
    return true;
  } catch {
    return false;
  } finally {
    if (tempPath) {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

export async function addWorkspaceApprovalRule(
  workspaceId: string,
  rule: ApprovalRule,
): Promise<ApprovalsFile> {
  return serializeWorkspaceMutation(workspaceId, async () => {
    const existingResult = await readWorkspaceApprovalsResult(workspaceId);
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
    if (!(await writeWorkspaceApprovals(workspaceId, updated))) {
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
    const existingResult = await readWorkspaceApprovalsResult(workspaceId);
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
    if (!(await writeWorkspaceApprovals(workspaceId, updated))) {
      throw new Error('Failed to persist project approval rule removal');
    }
    return updated;
  });
}
