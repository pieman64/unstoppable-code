import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  seedChatsSectionFixture,
  CHATS_SECTION_CODE_WORKSPACE_ID,
} from './seedChatsSectionFixture.mjs';
import { seedWorktreeChat } from './seedWorktreeChat.mjs';

export const ENABLED_RULE = 'CAN2053_ENABLED_RULE_SENTINEL';
export const DISABLED_RULE = 'CAN2053_DISABLED_RULE_SENTINEL';
export const CHANGED_RULE = 'CAN2053_CHANGED_RULE_SENTINEL';

/** Real isolated Git repository and checkout, no live account or repository. */
export function seedRepoRulesFixture(userDataDir, providerType = 'claude') {
  const { worktreeIds } = seedChatsSectionFixture(userDataDir, {
    worktreeCount: 1,
    chatEntryCount: 0,
  });
  const workspaceId = CHATS_SECTION_CODE_WORKSPACE_ID;
  const worktreeId = worktreeIds[0];
  const root = path.join(userDataDir, 'chats-section-repo');
  const checkout = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'worktrees',
    worktreeId,
  );
  for (const repo of [root, checkout]) {
    // A valid TREE index extension must not mistake a directory for the
    // split-index `link` signature when composing the provider request.
    mkdirSync(path.join(repo, 'links'), { recursive: true });
    writeFileSync(path.join(repo, 'links/README.md'), 'fixture links\n');
    execFileSync('git', ['-C', repo, 'add', 'links'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'write-tree'], { stdio: 'pipe' });
    mkdirSync(path.join(repo, '.cursor/rules'), { recursive: true });
    writeFileSync(path.join(repo, '.cursorrules'), ENABLED_RULE);
    writeFileSync(
      path.join(repo, '.cursor/rules/disabled.mdc'),
      `---\nalwaysApply: true\n---\n${DISABLED_RULE}`,
    );
    // On case-insensitive volumes, keep the reviewed index spelling different
    // from the physical filename to exercise saved deselection in real chats.
    const upper = path.join(repo, '.cursor/rules/DISABLED.mdc');
    const lower = path.join(repo, '.cursor/rules/disabled.mdc');
    if (existsSync(upper)) {
      execFileSync('git', ['-C', repo, 'config', 'core.ignorecase', 'true']);
      renameSync(lower, upper);
      execFileSync('git', ['-C', repo, 'add', '.cursor/rules/DISABLED.mdc']);
      renameSync(upper, lower);
    }
  }
  seedWorktreeChat({
    userDataDir,
    workspaceId,
    worktreeId,
    providerType,
    tabs: ['first', 'changed', 'disabled'].map((id) => ({
      id: `rules-${id}`,
      title: `Rules ${id}`,
      messages: [],
    })),
    activeTabId: 'rules-first',
  });
  const policyPath = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'repo-rules.json',
  );
  const sourceBytes = [root, checkout].flatMap((repo) =>
    ['.cursorrules', '.cursor/rules/disabled.mdc'].map((file) => ({
      file: path.join(repo, file),
      bytes: readFileSync(path.join(repo, file)),
    })),
  );
  const indexPath = path.join(root, '.git/index');
  return {
    workspaceId,
    worktreeId,
    root,
    checkout,
    policyPath,
    sourceBytes,
    indexPath,
    indexBytes: readFileSync(indexPath),
  };
}
