import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type ApprovalRule,
} from '@canopy/desktop-shared/types';
import {
  getWorkspaceApprovalsFilePath,
  readWorkspaceApprovalsResult,
} from '../lib/approvals-persistence';
import { readPreferencesFileDetailed } from '../lib/preferences-store';
import { readPreferencesApprovalAuthority } from './rule-revisions';
import { readWorkspaceApprovalsManifest } from '../lib/workspace-approvals-manifest';
import { getCodeReviewTargetSync } from '../lib/code-review-registry';
import { getPlanExploreTargetSync } from '../lib/plan-explore-registry';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import {
  createPreferencesGenerationPath,
  createPreferencesLastGoodPath,
  preferencesBackupPathPattern,
} from '../lib/preferences-file-paths';
import { getMigrationsFilePath, getPreferencesFilePath } from '../lib/paths';
import {
  createMigrationsLastGoodPath,
  migrationsDamagedPathPattern,
} from '../lib/migrations-file-paths';

/**
 * Where an approval session reads its rules and roots from. Every approval
 * session and every view of a chat's effective policy reads them through
 * these functions, so the two apply the same rules.
 */

/** A persisted rule tier; `unreadable` makes a session prompt for everything. */
export interface ApprovalRuleTier {
  rules: ApprovalRule[];
  unreadable: boolean;
}

/** The workspace whose persisted approval rules govern a chat's session. */
export function approvalPolicyWorkspaceId(chat: {
  projectId: string;
  worktreeId: string;
  policyProjectId?: string;
}): string {
  if (chat.policyProjectId) return chat.policyProjectId;
  if (chat.projectId === CODE_REVIEW_CHAT_PROJECT_ID) {
    return (
      getCodeReviewTargetSync(chat.worktreeId)?.projectId ?? chat.projectId
    );
  }
  if (chat.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID) {
    return (
      getPlanExploreTargetSync(chat.worktreeId)?.projectId ?? chat.projectId
    );
  }
  if (chat.projectId === STANDALONE_CHAT_PROJECT_ID) {
    return resolveCoworkWorkspaceId(chat.worktreeId);
  }
  return chat.projectId;
}

/**
 * The workspace tier: the user's approvals file, plus only the deny rules of
 * the repository's manifest. Repository-authored policy may only reduce
 * trust: manifest allows are not user acknowledgements.
 */
export async function readWorkspaceApprovalRuleTier(
  workspaceId: string,
): Promise<ApprovalRuleTier> {
  const [fileResult, manifest] = await Promise.all([
    readWorkspaceApprovalsResult(workspaceId),
    readWorkspaceApprovalsManifest(workspaceId),
  ]);
  return {
    rules: [
      ...fileResult.file.rules,
      ...manifest.rules.filter((rule) => rule.behavior === 'deny'),
    ],
    unreadable: fileResult.status === 'unreadable',
  };
}

/**
 * The global tier, from the user's preferences. While they are unreadable,
 * the served last-good still contributes its deny rules: it is not authority
 * to allow, but a known deny must not soften into a prompt.
 */
export async function readGlobalApprovalRuleTier(): Promise<ApprovalRuleTier> {
  const { value: tier, confirmed } = await readPreferencesApprovalAuthority(
    readPersistedGlobalApprovalRuleTier,
  );
  return confirmed === undefined
    ? tier
    : withConfirmedAllows(tier, confirmed.globalApprovalRules);
}

async function readPersistedGlobalApprovalRuleTier(): Promise<ApprovalRuleTier> {
  const { preferences, authority, served } = await readPreferencesFileDetailed({
    includeServed: true,
  });
  if (authority !== 'unreadable') {
    return { rules: preferences.globalApprovalRules, unreadable: false };
  }
  return {
    rules: (served?.globalApprovalRules ?? []).filter(
      (rule) => rule.behavior === 'deny',
    ),
    unreadable: true,
  };
}

/**
 * While a preferences save is unconfirmed, either version of the rules may be
 * what survives a crash: an allow applies only when both hold it, and a deny
 * applies when either does.
 */
function withConfirmedAllows(
  tier: ApprovalRuleTier,
  confirmed: readonly ApprovalRule[],
): ApprovalRuleTier {
  const ruleKey = (rule: ApprovalRule): string => JSON.stringify(rule);
  const confirmedKeys = new Set(confirmed.map(ruleKey));
  const rules = tier.rules.filter(
    (rule) => rule.behavior === 'deny' || confirmedKeys.has(ruleKey(rule)),
  );
  const keptKeys = new Set(rules.map(ruleKey));
  for (const rule of confirmed) {
    if (rule.behavior === 'deny' && !keptKeys.has(ruleKey(rule))) {
      rules.push(rule);
    }
  }
  return { rules, unreadable: tier.unreadable };
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

/**
 * The canonical path `inputPath` names, resolved against `basePath` and
 * through the deepest existing ancestor. Undefined when an ancestor cannot
 * be read or a dangling symlink sits on the way, which a write could follow
 * out of the canonical boundary.
 */
export async function resolveExistingAncestorPath(
  inputPath: string,
  basePath: string,
): Promise<string | undefined> {
  const absolutePath = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(basePath, inputPath);
  const missingSegments: string[] = [];
  let cursor = absolutePath;
  for (;;) {
    try {
      const existingPath = await realpath(cursor);
      return resolve(existingPath, ...missingSegments);
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return undefined;
      }
      try {
        await lstat(cursor);
        return undefined;
      } catch (lstatError) {
        const lstatCode = errorCode(lstatError);
        if (lstatCode !== 'ENOENT' && lstatCode !== 'ENOTDIR') {
          return undefined;
        }
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        return undefined;
      }
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * The approval policy files a governed agent must never silently modify:
 * the rule files, the preferences copies recovery restores or keeps, the
 * generation record that decides whether recovery may restore last-good, and
 * the migrations ledger and its recovery copies, whose loss re-runs
 * approval-mode migrations. Preferences backups and kept damaged ledgers are
 * file-rule globs, since recovery names each one when it creates it.
 */
export async function protectedApprovalFileWritePaths(
  workspaceId: string,
  basePath: string,
): Promise<string[]> {
  const preferencesPath = getPreferencesFilePath();
  const backupPattern = preferencesBackupPathPattern(preferencesPath);
  const migrationsPath = getMigrationsFilePath();
  const paths = await Promise.all([
    resolveExistingAncestorPath(
      getWorkspaceApprovalsFilePath(workspaceId),
      basePath,
    ),
    resolveExistingAncestorPath(preferencesPath, basePath),
    resolveExistingAncestorPath(
      createPreferencesLastGoodPath(preferencesPath),
      basePath,
    ),
    resolveExistingAncestorPath(
      createPreferencesGenerationPath(preferencesPath),
      basePath,
    ),
    resolveExistingAncestorPath(migrationsPath, basePath),
    resolveExistingAncestorPath(
      createMigrationsLastGoodPath(migrationsPath),
      basePath,
    ),
    // The folder, not the glob: a file literally named like the glob must not
    // redirect the pattern through a symlink.
    ...[backupPattern, migrationsDamagedPathPattern(migrationsPath)].map(
      (pattern) =>
        resolveExistingAncestorPath(dirname(pattern), basePath).then(
          (folder) =>
            folder === undefined ? undefined : join(folder, basename(pattern)),
        ),
    ),
  ]);
  return Array.from(
    new Set(paths.filter((path): path is string => path !== undefined)),
  );
}

function toggleFirstAlphabeticCase(value: string): string | undefined {
  const index = value.search(/[A-Za-z]/);
  if (index === -1) {
    return undefined;
  }
  const char = value[index];
  const toggled =
    char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase();
  return `${value.slice(0, index)}${toggled}${value.slice(index + 1)}`;
}

/**
 * Whether paths under a canonical root compare case-insensitively: always on
 * Windows, never on Linux, and on macOS as the volume holding the root
 * answers a probe with one letter's case toggled.
 */
export async function isPathCaseInsensitiveAt(
  canonicalRoot: string | undefined,
): Promise<boolean> {
  const platform = hostOperatingSystem();
  if (platform === 'win32') {
    return true;
  }
  if (platform !== 'darwin' || !canonicalRoot) {
    return false;
  }
  let cursor = canonicalRoot;
  while (true) {
    const parent = dirname(cursor);
    const name = basename(cursor);
    const probeName = toggleFirstAlphabeticCase(name);
    if (probeName && probeName !== name) {
      const resolvedProbe = await realpath(join(parent, probeName)).catch(
        () => undefined,
      );
      if (resolvedProbe !== undefined) {
        return resolvedProbe === cursor;
      }
    }
    if (parent === cursor) {
      return false;
    }
    cursor = parent;
  }
}
