import { randomUUID } from 'node:crypto';
import { join, relative } from 'node:path';
import {
  hasAnySelections,
  resolvePersistedChatExecutionHarness,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { isTabWithinRestoreWindow } from './chat-archives';
import { resolveClaudeCodeSessionTranscriptPath } from './claude-project-paths';
import {
  findCodexRolloutFiles,
  resolveCodexHomeForTab,
} from './codex-session-artifacts';
import { isPathInside } from './path-safety';
import { getArchivedContainerProviderSessionsDir } from './paths';
import { resolveWorktreeCwd } from './resolve-worktree';
import { validateId } from './validation';
import { runArchiveIoRequest } from '../archive/archive-io-runner';

function isFreshTab(tab: PersistedChatTab, now: number): boolean {
  return (
    isTabWithinRestoreWindow(tab, now) &&
    typeof tab.sdkSessionId === 'string' &&
    tab.sdkSessionId.length > 0
  );
}

function safeProviderFileName(value: string): string | null {
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : null;
}

export async function captureArchivedContainerProviderState(args: {
  projectId: string;
  containerId: string;
  tabs: PersistedChatTab[];
  includeClaude: boolean;
  onlyPluginCodex?: boolean;
  strictPluginCodexCopy?: boolean;
  now?: number;
  expectedCreatedAt?: string;
}): Promise<string[]> {
  const warnings: string[] = [];
  const now = args.now ?? Date.now();
  for (const tab of args.tabs) {
    if (!isFreshTab(tab, now) || !tab.sdkSessionId) continue;
    const sessionId = tab.sdkSessionId;
    if (resolvePersistedChatExecutionHarness(tab) === 'codex') {
      if (
        args.onlyPluginCodex === true &&
        (!tab.pluginSelections || !hasAnySelections(tab.pluginSelections))
      ) {
        continue;
      }
      try {
        const codexHome = await resolveCodexHomeForTab({
          tab,
          projectId: args.projectId,
          worktreeId: args.containerId,
          chatId: tab.id,
          warnings,
        });
        const sessionsRoot = join(codexHome, 'sessions');
        const files = await findCodexRolloutFiles(sessionsRoot, sessionId);
        validateId(tab.id, 'chatId');
        const archivedCodexRoot = join(
          getArchivedContainerProviderSessionsDir(
            args.projectId,
            args.containerId,
          ),
          'codex',
        );
        const entries = [];
        for (const source of files) {
          if (!isPathInside(sessionsRoot, source)) continue;
          const relativePath = relative(sessionsRoot, source);
          const destination = join(
            archivedCodexRoot,
            tab.id,
            'sessions',
            relativePath,
          );
          if (!isPathInside(archivedCodexRoot, destination)) {
            throw new Error('Invalid archived Codex provider-state path');
          }
          entries.push({
            kind: 'file' as const,
            source,
            destination,
            missingSource: 'error' as const,
          });
        }
        if (entries.length > 0) {
          await runArchiveIoRequest({
            version: 1,
            type: 'copy-payload',
            requestId: randomUUID(),
            operationId: `archive:${args.projectId}:${args.containerId}:copy-provider-codex:${tab.id}`,
            projectId: args.projectId,
            containerId: args.containerId,
            expectedCreatedAt:
              args.expectedCreatedAt ?? '1970-01-01T00:00:00.000Z',
            input: {
              sourceRoots: [sessionsRoot],
              destinationRoot: archivedCodexRoot,
              entries,
            },
          });
        }
      } catch (error) {
        if (args.strictPluginCodexCopy === true) throw error;
        warnings.push(
          `Failed to preserve Codex provider state for chat ${tab.id}.`,
        );
      }
      continue;
    }

    if (!args.includeClaude) continue;
    const safeSessionId = safeProviderFileName(sessionId);
    if (!safeSessionId) {
      warnings.push(`Skipped invalid Claude session id for chat ${tab.id}.`);
      continue;
    }
    try {
      const cwd = resolveWorktreeCwd(
        args.projectId,
        args.containerId,
        tab.selectedRepoId,
      );
      const source = await resolveClaudeCodeSessionTranscriptPath(
        sessionId,
        cwd,
      );
      if (!source) continue;
      const destination = join(
        getArchivedContainerProviderSessionsDir(
          args.projectId,
          args.containerId,
        ),
        'claude',
        `${safeSessionId}.jsonl`,
      );
      await runArchiveIoRequest({
        version: 1,
        type: 'copy-payload',
        requestId: randomUUID(),
        operationId: `archive:${args.projectId}:${args.containerId}:copy-provider-claude:${tab.id}`,
        projectId: args.projectId,
        containerId: args.containerId,
        expectedCreatedAt: args.expectedCreatedAt ?? '1970-01-01T00:00:00.000Z',
        input: {
          sourceRoots: [source],
          destinationRoot: getArchivedContainerProviderSessionsDir(
            args.projectId,
            args.containerId,
          ),
          entries: [
            {
              kind: 'file',
              source,
              destination,
              missingSource: 'error',
            },
          ],
        },
      });
    } catch {
      warnings.push(
        `Failed to preserve Claude provider state for chat ${tab.id}.`,
      );
    }
  }
  return warnings;
}
