import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';

/**
 * Harness primitive — seed a workspace's persisted tool-approval rules file.
 *
 * On-disk path: `workspaces/{workspaceId}/approvals.json`
 * (`apps/desktop-app/src/main/lib/approvals-persistence.ts`
 * `getWorkspaceApprovalsFilePath` -> `getWorkspaceDir(workspaceId)/approvals.json`).
 *
 * Shape: `ApprovalsFile` from `packages/execution-engine/src/types/approvals.ts`:
 *   { version: 1, rules: ApprovalRule[], defaultMode?: ApprovalMode }
 *
 * `readWorkspaceApprovals` silently falls back to `{ version: 1, rules: [] }`
 * on a missing/corrupt file and normalizes `rules`/`defaultMode` on read, so
 * this seeder only needs to produce a superset-compatible shape — callers may
 * omit `defaultMode` entirely.
 *
 * Used to pre-seed project-scoped allow/deny rules so a launch's
 * `settings-approvals-section` project table (and the resolved approval mode)
 * reflect them immediately, without going through the (main-process-only)
 * `addWorkspaceApprovalRule` write path.
 *
 * @param {object} options
 * @param {string} options.userDataDir absolute CANOPY_DATA_DIR
 * @param {string} options.workspaceId workspace id (a.k.a. projectId)
 * @param {import('@canopy/desktop-shared/types').ApprovalRule[]} [options.rules]
 * @param {import('@canopy/desktop-shared/types').ApprovalMode} [options.defaultMode]
 * @returns {{ filePath: string, file: import('@canopy/desktop-shared/types').ApprovalsFile }}
 */
export function seedWorkspaceApprovals(options) {
  const { userDataDir, workspaceId, rules = [], defaultMode } = options ?? {};

  if (!userDataDir) {
    throw new Error('seedWorkspaceApprovals requires userDataDir');
  }
  if (!workspaceId) {
    throw new Error('seedWorkspaceApprovals requires workspaceId');
  }

  /** @type {import('@canopy/desktop-shared/types').ApprovalsFile} */
  const file = {
    version: 1,
    rules,
    ...(defaultMode ? { defaultMode } : {}),
  };

  const filePath = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'approvals.json',
  );

  writeJson(filePath, file);
  return { filePath, file };
}

/**
 * Convenience builder for a single `ApprovalRule` matching the shape
 * `packages/execution-engine/src/types/approvals.ts` expects. Defaults
 * `origin` to `'settings'` (a rule added via Settings > Approvals, as
 * opposed to `'prompt'` or the repo-managed `'canopy-json'`) and `createdAt`
 * to a fixed timestamp so seeded fixtures are deterministic.
 *
 * @param {object} options
 * @param {'allow' | 'deny'} options.behavior
 * @param {import('@canopy/desktop-shared/types').ApprovalRuleTarget} options.target
 * @param {string} [options.id]
 * @param {import('@canopy/desktop-shared/types').ApprovalRuleOrigin} [options.origin]
 * @param {string} [options.createdAt]
 * @returns {import('@canopy/desktop-shared/types').ApprovalRule}
 */
export function buildApprovalRule(options) {
  const {
    behavior,
    target,
    id = `seeded-rule-${behavior}-${target.kind}`,
    origin = 'settings',
    createdAt = '2026-04-10T12:00:00.000Z',
  } = options ?? {};

  if (behavior !== 'allow' && behavior !== 'deny') {
    throw new Error('buildApprovalRule requires behavior "allow" or "deny"');
  }
  if (!target || typeof target !== 'object') {
    throw new Error('buildApprovalRule requires a target');
  }

  return { id, behavior, target, createdAt, origin };
}
