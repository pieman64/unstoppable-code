import { mkdtempSync, readFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  seedUsageLimitedChats,
  seedWorktreeChat,
  seedPipelineExecution,
} from './seeders/index.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';

export function seedInterruptedSessionScopes() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-resume-scopes-'),
  );
  const workspaceId = 'demo-ts-pnpm-vite';
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const indexPath = path.join(userDataDir, 'workspaces', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.workspaces.push({
    id: 'cowork-scopes',
    name: 'Cowork scopes',
    type: 'cowork',
    color: 'purple',
    collapsed: true,
    order: 1,
  });
  writeJson(indexPath, index);
  writeJson(
    path.join(userDataDir, 'workspaces', 'cowork-scopes', 'workspace.json'),
    {
      version: 1,
      type: 'cowork',
      repos: [],
      cowork: { createdAt: '2026-01-01T00:00:00.000Z' },
    },
  );
  writeJson(
    path.join(userDataDir, 'workspaces', 'cowork-scopes', 'work-entries.json'),
    {
      version: 1,
      entries: ['live-entry', 'legacy-owner'].map((id) => ({
        id,
        createdAt: '2026-01-01T00:00:00.000Z',
      })),
    },
  );
  const scopes = [
    {
      projectId: 'standalone-chat',
      worktreeId: 'cowork-scopes',
      storageWorktreeId: 'legacy-owner',
      chatId: 'migrated-legacy-chat',
      chatTitle: 'Migrated standalone chat',
      live: true,
    },
    {
      projectId: workspaceId,
      worktreeId: 'demo-main',
      chatId: 'live-chat',
      chatTitle: 'Live worktree chat',
      live: true,
    },
    {
      projectId: workspaceId,
      worktreeId: 'archived-worktree',
      chatId: 'archived-chat',
      chatTitle: 'Archived worktree chat',
    },
    {
      projectId: workspaceId,
      worktreeId: 'deleted-worktree',
      chatId: 'deleted-chat',
      chatTitle: 'Deleted worktree chat',
    },
    {
      projectId: 'deleted-workspace',
      worktreeId: 'old-main',
      chatId: 'deleted-workspace-chat',
      chatTitle: 'Deleted workspace chat',
    },
    {
      projectId: 'cowork-scopes',
      worktreeId: 'live-entry',
      chatId: 'live-entry-chat',
      chatTitle: 'Live work entry chat',
      live: true,
    },
    {
      projectId: 'cowork-scopes',
      worktreeId: 'archived-entry',
      chatId: 'archived-entry-chat',
      chatTitle: 'Archived work entry chat',
    },
    {
      projectId: 'cowork-scopes',
      worktreeId: 'deleted-entry',
      chatId: 'deleted-entry-chat',
      chatTitle: 'Deleted work entry chat',
    },
  ];
  for (const scope of scopes) {
    seedWorktreeChat({
      userDataDir,
      workspaceId: scope.storageWorktreeId ? 'cowork-scopes' : scope.projectId,
      worktreeId: scope.storageWorktreeId ?? scope.worktreeId,
      providerType: 'claude',
      tabs: [{ id: scope.chatId, title: scope.chatTitle }],
    });
  }
  const archivedDir = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'archived-containers',
    'archived-worktree',
  );
  mkdirSync(archivedDir, { recursive: true });
  seedUsageLimitedChats({
    userDataDir,
    entries: scopes.map((scope) => ({
      ...scope,
      provider: 'claude',
      detectedAt: Date.parse('2026-09-08T12:00:00Z'),
      workspaceName: scope.projectId,
      resumeReason: 'app_shutdown',
    })),
  });
  for (const [id, targetWorkspace, worktreeId] of [
    ['live-pipeline', workspaceId, 'demo-main'],
    ['archived-pipeline', workspaceId, 'archived-worktree'],
    ['deleted-entry-pipeline', 'cowork-scopes', 'deleted-entry'],
    ['deleted-workspace-pipeline', 'deleted-workspace', 'old-main'],
    ['local-pipeline', undefined, undefined],
    ['legacy-standalone-pipeline', 'standalone-chat', 'cowork-scopes'],
  ]) {
    seedPipelineExecution({
      userDataDir,
      workspaceId: targetWorkspace,
      worktreeId,
      execution: {
        id,
        pipelineName: id,
        status: 'paused',
        stateOverrides: {
          version: 6,
          shutdown_checkpoint: {
            id: '123e4567-e89b-42d3-a456-426614174000',
            detected_at: '2026-09-08T12:00:00Z',
          },
        },
      },
    });
  }
  return { userDataDir, scopes };
}
